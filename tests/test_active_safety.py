"""Runtime geometry/command contracts. No vehicle physics are simulated."""
from dataclasses import replace
import unittest
from unittest.mock import patch
import numpy as np
from backend.core.active_safety import ActiveSafetySupervisor, RuntimeSafetyConfig, assess_forward_space
from backend.core.contracts import CommandSource, SensorKind
from backend.core.control import CommandArbiter, ControlMode, ControlSafetyLayer
from tests.test_safety_teacher import case


def scene(observation, *, clear=False, obstacle=False):
    # Explicit sensor-local point geometry, solely to check projection units.
    points = [[x, y, -1.9, .5] for x in (8., 20., 35.) for y in (-.8, .8)] if clear else []
    if obstacle: points += [[10., 0., -1.4, .5]]
    data = np.asarray(points, '<f4').reshape(-1, 4).tobytes()
    channels = []
    for s in observation.channels:
        if s.kind in (SensorKind.LIDAR, SensorKind.DEPTH):
            p = [0., 0., 1.9] if s.kind == SensorKind.LIDAR else [1.5, 0., 1.6]
            # A rear camera cannot certify forward free space. LiDAR stays fixed.
            calibration = {'mount_transform': {'position_m': p,
                'rotation_deg': {'roll': 0., 'pitch': 0., 'yaw': 0. if s.kind == SensorKind.LIDAR else 180.}}}
            s = replace(s, calibration=calibration)
        channels.append(s)
    return replace(observation, channels=tuple(channels)), lambda _: data


class ActiveSafetyTests(unittest.TestCase):
    def test_sensor_geometry_distinguishes_measured_road_from_unknown(self):
        o, _ = case(distance=None)
        empty, reader = scene(o)
        self.assertEqual(assess_forward_space(empty, reader, RuntimeSafetyConfig.load())['observed_road_range_m'], 0.)
        road, reader = scene(o, clear=True)
        s = assess_forward_space(road, reader, RuntimeSafetyConfig.load())
        self.assertEqual(s['observed_road_range_m'], 32.5)
        self.assertIsNone(s['target_range_m']); self.assertFalse(s['depth_observed'])
        target, reader = scene(o, clear=True, obstacle=True)
        s = assess_forward_space(target, reader, RuntimeSafetyConfig.load())
        self.assertEqual(s['target_range_m'], 7.5); self.assertEqual(s['target_source'], 'LIDAR')
        self.assertIsNone(s['closing_speed_mps'])

    def test_empty_road_preserves_manual_and_basicagent_controls(self):
        for source in (CommandSource.MANUAL, CommandSource.NAVIGATION):
            o, b = case(distance=None); o, reader = scene(o, clear=True)
            s = ActiveSafetySupervisor()
            self.assertIsNone(s.evaluate(o, replace(b, source=source), reader, as_of_timestamp_s=o.timestamp_s))
            self.assertEqual(s.snapshot()['risk'], 'FORWARD_CLEAR_SIDE_REAR_UNVERIFIED'); self.assertEqual(s.interventions, 0)

    def test_missing_returns_remain_unknown_and_brake_through_admission(self):
        o, b = case(distance=None); o, reader = scene(o)
        s = ActiveSafetySupervisor(); c = s.evaluate(o, b, reader, as_of_timestamp_s=o.timestamp_s)
        self.assertEqual(c.source, CommandSource.SAFETY); self.assertEqual(c.brake, 1.)
        self.assertEqual(c.throttle, 0.); self.assertEqual(c.steering, b.steering)
        self.assertEqual(s.snapshot()['risk'], 'UNKNOWN_SPACE')

    def test_radar_hazard_and_smooth_release_without_steering(self):
        s = ActiveSafetySupervisor(); o, b = case(distance=8., velocity=-8.); o, reader = scene(o)
        c = s.evaluate(o, b, reader, as_of_timestamp_s=o.timestamp_s)
        self.assertEqual(c.brake, 1.); self.assertEqual(c.steering, b.steering)
        self.assertAlmostEqual(s.snapshot()['stopping_envelope_m'], 12.2)
        brakes = []
        for frame in range(2, 13):
            o, b = case(frame, distance=None); o, reader = scene(o, clear=True)
            c = s.evaluate(o, b, reader, as_of_timestamp_s=o.timestamp_s)
            brakes.append(c.brake if c else 0.)
        self.assertEqual(brakes, sorted(brakes, reverse=True)); self.assertEqual(brakes[-1], 0.)
        self.assertEqual(s.interventions, 1)

    def test_stale_future_duplicate_and_unaligned_commands_rejected(self):
        o, b = case(distance=None); o, reader = scene(o, clear=True)
        for now in (o.timestamp_s-.001, o.timestamp_s+.11, float('nan')):
            with self.assertRaises(ValueError): ActiveSafetySupervisor().evaluate(o, b, reader, as_of_timestamp_s=now)
        with self.assertRaises(ValueError): ActiveSafetySupervisor().evaluate(o, replace(b, frame_id=2), reader, as_of_timestamp_s=o.timestamp_s)
        s=ActiveSafetySupervisor(); s.evaluate(o,b,reader,as_of_timestamp_s=o.timestamp_s)
        with self.assertRaises(ValueError): s.evaluate(o,b,reader,as_of_timestamp_s=o.timestamp_s)

    def test_reverse_is_explicitly_unsupported_and_invalid_configuration_rejected(self):
        o, b = case(); s = ActiveSafetySupervisor()
        self.assertIsNone(s.evaluate(o, replace(b, reverse=True, gear=-1), None, as_of_timestamp_s=o.timestamp_s))
        self.assertEqual(s.snapshot()['status'], 'FORWARD_ONLY')
        with self.assertRaises(ValueError): replace(RuntimeSafetyConfig.load(), maximum_safety_steering_delta=.1)
        with self.assertRaises(ValueError): replace(RuntimeSafetyConfig.load(), ttc_trigger_s=float('nan'))

    def test_supervisor_has_no_world_or_actor_interface(self):
        import inspect
        from backend.core import active_safety
        source = inspect.getsource(active_safety)
        for forbidden in ('get_actors(', 'get_transform(', '.ground_truth', '.world.', 'future_trajectory'):
            self.assertNotIn(forbidden, source)

    def test_axial_depth_plane_does_not_become_false_nearby_obstacle(self):
        import io
        o,b=case(distance=None);o,lidar_reader=scene(o)
        depth=next(s for s in o.channels if s.kind==SensorKind.DEPTH)
        cal={'width':80,'height':45,'fov_deg':90.,'mount_transform':{'position_m':[1.5,0.,1.6],
            'rotation_deg':{'roll':0.,'pitch':0.,'yaw':0.}}}
        depth=replace(depth,calibration=cal)
        o=replace(o,channels=tuple(depth if s.kind==SensorKind.DEPTH else s for s in o.channels))
        a=np.full((45,80),1000.,np.float32)
        for v in range(23,45): a[v,:]=1.6*40/(v-22.)
        encoded=io.BytesIO();np.save(encoded,a,allow_pickle=False)
        reader=lambda asset:encoded.getvalue() if asset==depth.asset else lidar_reader(asset)
        assessed=assess_forward_space(o,reader,RuntimeSafetyConfig.load())
        self.assertIsNone(assessed['target_range_m']);self.assertGreater(assessed['observed_road_range_m'],10.)

    def test_fresh_safety_commands_cannot_resurrect_expired_driver_commands(self):
        now=[0.];a=CommandArbiter(ControlSafetyLayer(now=lambda:now[0]))
        a.machine.transition(ControlMode.MANUAL,connected=True,explicit=True)
        _,b=case();b=replace(b,source=CommandSource.MANUAL)
        a.submit(b,frame_id=b.frame_id,timestamp_s=b.timestamp_s,connected=True)
        now[0]=.36
        safe=replace(b,source=CommandSource.SAFETY,brake=1.,throttle=0.)
        a.submit(safe,frame_id=b.frame_id,timestamp_s=b.timestamp_s,connected=True)
        chosen=a.choose(frame_id=b.frame_id,timestamp_s=b.timestamp_s,connected=True,exclude_sources=(CommandSource.SAFETY,))
        self.assertEqual(a.machine.mode,ControlMode.PAUSED);self.assertEqual(chosen.brake,1.)
        self.assertEqual(a.reason,'command_timeout')

    def test_rl_tick_owner_suspends_active_runtime_supervisor(self):
        from backend.core.service import SimulationService
        from unittest.mock import Mock
        p=Mock(sensor_suite=False);s=SimulationService(p);s.active_safety=ActiveSafetySupervisor()
        s.arbiter.machine.mode=ControlMode.TRAINING;s._active_safety_step()
        self.assertEqual(s.active_safety.snapshot()['status'],'SUSPENDED_RL')
        self.assertIsNone(s.safety_command);p.apply_control.assert_not_called()

    def test_invalid_imu_cannot_be_admitted_as_valid_hazard_evidence(self):
        o,b=case(distance=8.,velocity=-8.);o,reader=scene(o)
        imu=next(s for s in o.channels if s.kind==SensorKind.IMU)
        with self.assertRaises(ValueError):
            replace(imu,data={**imu.data,'gyroscope_radps':[float('nan'),0.,0.]})
        imu=replace(imu,data={**imu.data,'gyroscope_radps':[0.,0.]})
        o=replace(o,channels=tuple(imu if s.kind==SensorKind.IMU else s for s in o.channels))
        with self.assertRaisesRegex(ValueError,'feasibility rejected'):
            ActiveSafetySupervisor().evaluate(o,b,reader,as_of_timestamp_s=o.timestamp_s)

    def test_runtime_refresh_keeps_the_existing_command_rate_guard(self):
        from backend.core.service import SimulationService
        from tests.test_rl import policy_fixture
        from unittest.mock import Mock
        now=[0.];o,b=case(distance=8.,velocity=-8.);o,reader=scene(o)
        p=Mock(sensor_suite=False);p.get_sensor_asset=reader
        s=SimulationService(p,now=lambda:now[0]);s.active_safety=ActiveSafetySupervisor()
        s.observation=policy_fixture();s.clock.observe(s.observation.world);s.policy_history.frames.append(o)
        s.arbiter.machine.mode=ControlMode.MANUAL
        s.arbiter.submit(replace(b,source=CommandSource.MANUAL),frame_id=o.frame_id,timestamp_s=o.timestamp_s,connected=True)
        with patch.object(s,'_live',return_value=True):
            s._active_safety_step();self.assertIsNotNone(s.safety_command)
            now[0]=.01;s._active_safety_step()
        self.assertEqual(s.arbiter.machine.mode,ControlMode.PAUSED)
        self.assertIn('rate limit',s.active_safety.last_fault)


if __name__ == '__main__': unittest.main()
