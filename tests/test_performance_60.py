"""Clock/pipeline contracts only; fixtures are never native acceptance evidence."""
from dataclasses import replace
import io
import json
from pathlib import Path
import struct
import tempfile
import threading
from types import SimpleNamespace as NS
import unittest
from unittest.mock import Mock, patch

import numpy as np

from backend.carla.provider import CarlaProvider
from backend.carla.sensors import CarlaSensorManager
from backend.carla.dashboard_tools import validate_settings
from backend.core.control import ControlMode
from backend.core.contracts import CommandSource, to_dict
from backend.core.performance import rates
from backend.core.service import SimulationService
from backend.signals.image_encoding import LatestImageEncoder
from tests.core_packets import packet, sensor, command


class RateProvider:
    name = 'test-fixture'
    run_profile = 'PERFORMANCE_60'
    fixed_delta = 1/60
    decision_delta = .05
    sensor_suite = False
    allow_navigation = True
    required_sensors = ('imu',)
    scenario_outcomes_enabled = False

    def __init__(self, now, *, delay=0):
        self.frame = 0
        self.now = now
        self.delay = delay
        self.scheduled = [(0, sensor(frame_id=0, timestamp_s=0.))]
        self.applied = []
        self.last_ground_truth = None
        self.sensor_manager = None

    def get_simulation_frame(self):
        return packet(self.frame, self.frame/60)

    def drain_sensor_frames(self):
        ready = tuple(s for frame,s in self.scheduled if frame <= self.frame)
        self.scheduled = [(f,s) for f,s in self.scheduled if f > self.frame]
        return ready

    def step(self):
        self.frame += 1
        self.now[0] += 1/60
        if self.frame % 3 == 0:
            self.scheduled.append((self.frame+self.delay, sensor(frame_id=self.frame, timestamp_s=self.frame/60)))

    def apply_control(self, selected):
        self.applied.append((self.frame, selected))

    apply_control_confirmed = apply_control

    def get_sensor_rates(self):
        return {'imu':20}

    def stop_navigation(self):
        pass


class PerformanceClockTests(unittest.TestCase):
    def service(self, *, delay=0):
        now = [10.]
        provider = RateProvider(now, delay=delay)
        service = SimulationService(provider, required_sensors=provider.required_sensors, now=lambda:now[0])
        self.addCleanup(service.close)
        service._navigation_step = Mock()
        service._active_safety_step = Mock()
        service.start(threaded=False)
        return service, provider, now

    def test_sixty_native_steps_publish_twenty_exact_sensor_decisions(self):
        service, provider, _ = self.service()
        published = []
        original = service._publish
        service._publish = lambda frame:(published.append(frame), original(frame))[-1]
        for _ in range(60):
            service.step_once()
        self.assertEqual(provider.frame, 60)
        self.assertEqual(service.clock.frame_id, 60)
        self.assertEqual([f.frame_id for f in published], list(range(3,61,3)))
        self.assertEqual(service._navigation_step.call_count, 20)
        self.assertEqual(len(provider.applied), 60)
        self.assertEqual(service.synchronization_missing_frames, 0)
        self.assertEqual(service.synchronization_issues.get('MISSING',0), 0)
        self.assertTrue(all(f.complete and all(s.frame_id==f.frame_id for s in f.sensors) for f in published))
        self.assertAlmostEqual(service._performance_details()['simulationRealTimeFactor'], 1.)

    def test_gpu_sensor_delay_uses_its_original_anchor_without_waiting_or_mixing(self):
        service, provider, _ = self.service(delay=2)
        for _ in range(7):
            service.step_once()
        self.assertEqual(provider.frame, 7)
        self.assertEqual(service.observation.frame_id, 3)
        self.assertEqual(service.observation.sensors[0].frame_id, 3)
        self.assertAlmostEqual(service.observation.timestamp_s, .05)
        self.assertEqual(service._navigation_step.call_count, 2)
        self.assertEqual(service.synchronization_missing_frames, 0)
        self.assertEqual(service.clock.frame_id, 7)

    def test_command_lease_is_not_refreshed_on_intermediate_physics_steps(self):
        service, provider, _ = self.service()
        service.set_controls(throttle=.7)
        for _ in range(30):
            service.step_once()
        self.assertEqual(provider.applied[0][1].throttle, .7)
        self.assertEqual(provider.applied[-1][1].brake, 1.)
        self.assertEqual(provider.applied[-1][1].throttle, 0.)
        moving = [c for _,c in provider.applied if c.throttle]
        self.assertTrue(all(c.frame_id==0 and c.timestamp_s==0. for c in moving))
        self.assertEqual(service.arbiter.machine.mode, ControlMode.PAUSED)

    def test_emergency_is_immediate_and_rechecked_before_the_next_intermediate_tick(self):
        service, provider, _ = self.service()
        service.set_controls(throttle=.7)
        service.step_once()
        decisions = service._navigation_step.call_count
        with tempfile.TemporaryDirectory() as directory:
            service.presentation.directory = Path(directory)
            service.emergency_stop()
            self.assertEqual(provider.applied[-1][1].brake, 1.)
            service.step_once()
        self.assertEqual(service._navigation_step.call_count, decisions)
        self.assertEqual(provider.applied[-1][1].throttle, 0.)
        self.assertEqual(provider.applied[-1][1].brake, 1.)
        self.assertTrue(service.physics_guard['emergency'])

    def test_split_guard_checks_the_entire_next_physics_interval_without_relaxing_age(self):
        service, provider, now = self.service()
        provider.sensor_suite = True
        service.arbiter.machine.transition(ControlMode.AUTOMATIC, connected=True, explicit=True)
        service.control_scene = NS(session_id=service.session_id, observation=NS(frame_id=0,timestamp_s=0.),
            received_wall_s=now[0], usable=lambda stamp,wall:0<=stamp<=.1 and wall-now[0]<=.25)
        base = command(CommandSource.NAVIGATION,0,0.)
        service.clock.observe(packet(4,4/60).world)
        self.assertEqual(service._application_guard(base), base)
        service.clock.observe(packet(6,6/60).world)
        held = service._application_guard(base)
        self.assertEqual(held.brake, 1.)
        self.assertEqual(held.throttle, 0.)
        self.assertGreater(service.application_timing['simulation_age_s'], .1)

    def test_transport_loss_is_checked_between_sensor_cycles(self):
        service, provider, now = self.service()
        service.step_once()
        service.journey.update(status='RUNNING', driving_mode='NORMAL')
        service.arbiter.machine.transition(ControlMode.AUTOMATIC, connected=True, explicit=True)
        service.navigation_heartbeat_at = service.navigation_transport_at = now[0]-2.
        with tempfile.TemporaryDirectory() as directory:
            service.presentation.directory=Path(directory)
            service.step_once()
        self.assertEqual(service.journey['reason'], 'dashboard_heartbeat_timeout')
        self.assertEqual(provider.applied[-1][1].brake, 1.)

    def test_rebuilding_sensors_retires_old_anchors_and_cadence(self):
        service, _, _ = self.service()
        service.step_once()
        service._reset_sensor_timing()
        self.assertFalse(service.physics_anchors)
        self.assertFalse(service.sensor_anchors)
        self.assertIsNone(service.last_decision_frame)
        self.assertEqual(service.synchronizer.sensor_frame_strides, {'imu':3})

    def test_off_phase_sparse_arrival_never_reports_an_inverted_missing_range(self):
        from backend.signals.timing import FrameTracker
        tracker=FrameTracker(expected_stride=3)
        tracker.observe('radar',0,0.)
        result=tracker.observe('radar',4,4/60)
        self.assertEqual(result.missing_range,(3,3))

    def test_shutdown_does_not_advance_an_additional_physics_step(self):
        service, provider, _ = self.service()
        service.stop_event.set()
        service.step_once()
        self.assertEqual(provider.frame,0)
        self.assertEqual(provider.applied[-1][1].brake,1.)


class PerformanceConfigurationTests(unittest.TestCase):
    def test_live_profile_change_requires_native_rate_readback_before_recreating_sensors(self):
        from backend.carla.dashboard_tools import NativeDashboardTools
        provider=CarlaProvider()
        manager=Mock(cleanup_errors=[])
        provider.sensor_manager=manager
        provider.last_vehicle={'speedMagnitudeMps':0.}
        provider.world=NS(world=Mock())
        provider.world.world.get_settings.side_effect=[
            NS(synchronous_mode=True,fixed_delta_seconds=.05),
            NS(synchronous_mode=True,fixed_delta_seconds=.05)]
        tools=NativeDashboardTools.__new__(NativeDashboardTools)
        tools.provider=provider
        with self.assertRaisesRegex(RuntimeError,'did not apply'):
            tools.apply({'run_profile':'PERFORMANCE_60'})
        manager.close.assert_called_once()
        self.assertIsNone(provider.sensor_manager)

    def test_profile_is_explicit_and_legacy_rate_is_unchanged(self):
        legacy = CarlaProvider(fixed_delta=.1)
        self.assertEqual(legacy.run_profile, 'LEGACY')
        self.assertEqual(legacy.decision_delta, .1)
        selected = CarlaProvider(run_profile='PERFORMANCE_60')
        self.assertAlmostEqual(selected.fixed_delta, 1/60)
        self.assertEqual(selected.decision_delta, .05)
        self.assertEqual(selected.camera_settings['camera_resolution'],'1280x720')
        self.assertEqual(rates('PERFORMANCE_60')['physicsStepsPerDecision'],3)
        with self.assertRaises(ValueError):
            validate_settings({'simulation_hz':60})
        self.assertEqual(validate_settings({'run_profile':'PERFORMANCE_60','simulation_hz':60})['simulation_hz'],60)
        for settings in ({'run_profile':'PERFORMANCE_60','simulation_hz':20},
                         {'run_profile':'PERFORMANCE_60','camera_resolution':'800x450'},
                         {'run_profile':'unknown'}, {'run_profile':[]}):
            with self.subTest(settings=settings),self.assertRaises(ValueError):
                validate_settings(settings)

    def test_comparison_rig_keeps_native_720p60_and_safety_sensors_at_twenty_hz(self):
        def location(**kw):return NS(x=kw.get('x',0),y=kw.get('y',0),z=kw.get('z',0))
        def rotation(**kw):return NS(pitch=kw.get('pitch',0),yaw=kw.get('yaw',0),roll=kw.get('roll',0))
        api = NS(Location=location,Rotation=rotation,
            Transform=lambda p=None,r=None:NS(location=p or location(),rotation=r or rotation()))
        for profile, width, height, period in (('LEGACY',800,450,.05),('PERFORMANCE_60',1280,720,1/60)):
            manager=CarlaSensorManager(None,None)
            plans={}
            manager.spawn=lambda name,bp,mount,attrs,decode:plans.update({name:dict(attrs)})
            manager.enable_collision=Mock()
            options={'camera_view':'front','camera_resolution':'640x360','camera_fov':90,
                '_comparison_rig':True,'_run_profile':profile}
            manager.enable_suite(api,period,options)
            self.assertEqual((plans['drivingCamera']['image_size_x'],plans['drivingCamera']['image_size_y']),(width,height))
            self.assertAlmostEqual(plans['drivingCamera']['sensor_tick'],period)
            for name in ('frontCamera','depth','lidar','radar','imu','gnss'):
                self.assertEqual(plans[name]['sensor_tick'],.05)
            self.assertEqual(plans['lidar']['rotation_frequency'],60 if profile=='PERFORMANCE_60' else 20)
            self.assertEqual(plans['lidar']['points_per_second'],384000 if profile=='PERFORMANCE_60' else 128000)
            self.assertEqual(plans['radar']['points_per_second'],4500 if profile=='PERFORMANCE_60' else 1500)

    def test_comparison_rejects_mixed_run_profiles_and_retains_old_manifests(self):
        from backend.core.journey_comparison import matching_setup
        base={'map':'test','blueprint':'vehicle.test','destination':{},'speed_kmh':30,'population':{},
            'weather':{},'actual_population':{},'origin':{'location':[0,0,0],'rotation':[0,0,0]}}
        self.assertTrue(matching_setup(base,base))
        new={**base,'runtime_rates':rates('PERFORMANCE_60')}
        self.assertTrue(matching_setup(new,new))
        self.assertFalse(matching_setup(base,new))


class EncodingPipelineTests(unittest.TestCase):
    def test_cached_geometry_templates_are_exact_readonly_and_shape_specific(self):
        import math
        from backend.core.recovery_depth import _depth_rays
        from backend.core.maneuver import _body_cells, _body_samples, _ray_steps
        for w,h,fov in ((640,360,90.),(320,180,170.),(240,135,120.)):
            vv,uu,rays=_depth_rays(w,h,fov)
            y,x=np.mgrid[0:h:2,0:w:2]
            focal=w/(2*math.tan(math.radians(fov)/2))
            expected=np.stack((np.ones(x.shape),(x-(w-1)/2)/focal,-(y-(h-1)/2)/focal),axis=-1)
            np.testing.assert_array_equal(rays,expected)
            self.assertIs(_depth_rays(w,h,fov)[2],rays)
            self.assertFalse(rays.flags.writeable)
            np.testing.assert_array_equal(vv,y);np.testing.assert_array_equal(uu,x)
        mask=_body_cells(201,.5,50.,2.3,2.4,1.01)
        self.assertFalse(mask.flags.writeable)
        self.assertIs(mask,_body_cells(201,.5,50.,2.3,2.4,1.01))
        self.assertIsNot(mask,_body_cells(201,.5,50.,2.4,2.4,1.01))
        self.assertFalse(_body_samples(2.3,2.4,1.01,.5).flags.writeable)
        np.testing.assert_array_equal(_ray_steps(31),np.linspace(0.,.999,31)[None,:])

    def test_encoder_latest_slot_is_bounded_and_drops_are_measured(self):
        began=threading.Event();release=threading.Event();done=threading.Event();seen=[]
        def encode(image,received,unix):
            if image==1:
                began.set()
                if not release.wait(2):raise RuntimeError('Test release timed out')
            seen.append(image)
            if image==3:done.set()
        encoder=LatestImageEncoder(encode,name='test-image-encoder')
        try:
            encoder.submit(1,0,0);self.assertTrue(began.wait(2))
            encoder.submit(2,0,0);encoder.submit(3,0,0)
            self.assertEqual(encoder.snapshot()['pending'],1)
            release.set();self.assertTrue(done.wait(2))
        finally:
            release.set();encoder.close()
        self.assertEqual(seen,[1,3])
        self.assertEqual(encoder.snapshot()['droppedBeforeEncoding'],1)
        self.assertLessEqual(encoder.snapshot()['maximumPending'],1)

    def test_native_bgrx_conversion_is_byte_equivalent_to_the_old_numpy_rgb_copy(self):
        from PIL import Image
        from backend.signals.decoders import decode_sensor
        from backend.core.contracts import SensorKind
        data=np.random.default_rng(715).integers(0,256,(18,32,4),dtype=np.uint8)
        native=NS(raw_data=data.tobytes(),width=32,height=18,fov=90,frame=1,timestamp=.05,
            transform=NS(location=NS(x=0.,y=0.,z=0.),rotation=NS(pitch=0.,yaw=0.,roll=0.)))
        manager=CarlaSensorManager(None,None);manager.actors['frontCamera']=NS(id=42)
        decoded=decode_sensor(manager,'frontCamera',SensorKind.RGB,native,native.transform,{'sensor_tick':.05})
        expected=io.BytesIO();Image.fromarray(data[:,:,[2,1,0]]).save(expected,format='JPEG',quality=95)
        self.assertEqual(manager.asset_bytes(decoded.asset),expected.getvalue())
        self.assertEqual(manager.diagnostic_rgb[1][-1],Image.fromarray(data[:,:,[2,1,0]]).tobytes())

    def test_asset_cache_is_byte_bounded_and_pending_video_keeps_capture_period(self):
        manager=CarlaSensorManager(None,None);manager.maximum_asset_bytes=4
        first=manager.cache_asset('rgb','1.jpg',b'aa','image/jpeg')
        manager.cache_asset('rgb','2.jpg',b'bb','image/jpeg')
        manager.cache_asset('rgb','3.jpg',b'cc','image/jpeg')
        self.assertEqual(manager.asset_bytes_used,4)
        with self.assertRaises(KeyError):manager.asset_bytes(first)
        from backend.core.driving_video import camera_period_s, _encode_video
        self.assertEqual(camera_period_s({}),.05)
        self.assertAlmostEqual(camera_period_s({'calibration':{'sensor_tick_s':1/60}}),1/60)
        for bad in (0,-1,None,float('nan'),True):
            with self.assertRaises(ValueError):camera_period_s({'calibration':{'sensor_tick_s':bad}})
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            def run(args,**kwargs):
                Path(args[-1]).write_bytes(b'fixture-only')
                return NS(returncode=0)
            frames=[{'timestamp_s':v,'asset':{'path':str(i)+'.jpg'},'calibration':{'sensor_tick_s':1/60}}
                for i,v in enumerate((0.,1/60,4/60))]
            with patch('backend.core.driving_video.subprocess.run',side_effect=run):
                _encode_video(root,frames,'not-a-native-encoder','test.mp4')
            durations=[float(line.split()[1]) for line in (root/'test.mp4.ffconcat').read_text().splitlines() if line.startswith('duration ')]
            np.testing.assert_allclose(durations,[1/60,3/60,1/60],atol=1e-9)


class SparseNativeSensorTests(unittest.TestCase):
    @staticmethod
    def transform(x=0.,y=0.,z=0.,yaw=0.):
        co,si=np.cos(yaw),np.sin(yaw)
        inverse=np.eye(4)
        inverse[:3,:3]=[[co,si,0],[-si,co,0],[0,0,1]]
        return NS(location=NS(x=x,y=y,z=z),get_inverse_matrix=lambda:inverse.tolist())

    def test_sparse_radar_corrects_only_own_motion_not_target_velocity(self):
        from backend.signals.multirate import SparseSensorTiming
        timing=SparseSensorTiming(1/60)
        timing.seed_radar('radar',NS(frame=0,timestamp=NS(elapsed_seconds=0.)),self.transform())
        raw=[{'depth_m':20.,'azimuth_rad':0.,'altitude_rad':0.,'velocity_mps':-30.}]
        native=NS(frame=3,timestamp=.05,transform=self.transform(x=.5))
        data,meta=timing.radar('radar',native,raw)
        self.assertAlmostEqual(data[0]['velocity_mps'],-10.)
        self.assertEqual(raw[0]['velocity_mps'],-30.)
        self.assertEqual(meta['native_doppler_mps'],[-30.])
        self.assertAlmostEqual(meta['ego_doppler_correction_mps'][0],20.)

    def test_radar_first_world_tick_and_rotated_sensor_use_actual_sample_times(self):
        from backend.signals.multirate import SparseSensorTiming
        timing=SparseSensorTiming(1/60)
        timing.seed_radar('first',NS(frame=0,timestamp=NS(elapsed_seconds=0.)),self.transform())
        raw=[{'depth_m':20.,'azimuth_rad':0.,'altitude_rad':0.,'velocity_mps':-10.}]
        data,_=timing.radar('first',NS(frame=1,timestamp=1/60,transform=self.transform(x=10/60)),raw)
        self.assertAlmostEqual(data[0]['velocity_mps'],-10.)
        timing.seed_radar('side',NS(frame=0,timestamp=NS(elapsed_seconds=0.)),self.transform(yaw=np.pi/2))
        raw=[{**raw[0],'azimuth_rad':-np.pi/2,'velocity_mps':-30.}]
        data,_=timing.radar('side',NS(frame=3,timestamp=.05,transform=self.transform(x=.5,yaw=np.pi/2)),raw)
        self.assertAlmostEqual(data[0]['velocity_mps'],-10.)

    def test_imu_uses_three_real_sample_intervals_and_retains_native_raw_acceleration(self):
        from backend.signals.multirate import SparseSensorTiming,SensorWarmup
        timing=SparseSensorTiming(1/60)
        for i in range(3):
            stamp=i*.05
            native=NS(frame=i*3,timestamp=stamp,transform=self.transform(x=100+2*stamp+1.5*stamp**2),
                accelerometer=NS(x=27.,y=0.,z=9.81))
            if i<2:
                with self.assertRaises(SensorWarmup):timing.imu('imu',native)
            else:
                acceleration,meta=timing.imu('imu',native)
                np.testing.assert_allclose(acceleration,[3.,0.,9.81],atol=1e-8)
                self.assertEqual(meta['native_accelerometer_mps2'],[27.,0.,9.81])

    def test_sparse_sensor_gaps_and_reordered_samples_are_not_silently_relabelled(self):
        from backend.signals.multirate import SparseSensorTiming
        timing=SparseSensorTiming(1/60)
        timing.seed_radar('radar',NS(frame=0,timestamp=NS(elapsed_seconds=0.)),self.transform())
        timing.radar('radar',NS(frame=3,timestamp=.05,transform=self.transform()),[])
        with self.assertRaisesRegex(ValueError,'advance'):
            timing.radar('radar',NS(frame=3,timestamp=.05,transform=self.transform()),[])
        with self.assertRaisesRegex(ValueError,'interval'):
            timing.radar('radar',NS(frame=9,timestamp=.15,transform=self.transform()),[])

    def test_native_tick_jitter_uses_observed_intervals_instead_of_nominal_time(self):
        from backend.signals.multirate import SparseSensorTiming,SensorWarmup
        timing=SparseSensorTiming(1/60)
        timing.seed_radar('radar',NS(frame=0,timestamp=NS(elapsed_seconds=0.)),self.transform())
        raw=[{'depth_m':20.,'azimuth_rad':0.,'altitude_rad':0.,'velocity_mps':-20.}]
        timing.radar('radar',NS(frame=2,timestamp=2/60,transform=self.transform(x=10*2/60)),raw)
        raw[0]['velocity_mps']=-40.
        data,meta=timing.radar('radar',NS(frame=6,timestamp=6/60,transform=self.transform(x=1.)),raw)
        self.assertAlmostEqual(data[0]['velocity_mps'],-10.)
        self.assertEqual(meta['sample_stride'],4)
        for i,stamp in enumerate((0.,2/60,6/60)):
            native=NS(frame=round(stamp*60),timestamp=stamp,
                transform=self.transform(x=1.5*stamp**2),accelerometer=NS(x=27.,y=0.,z=9.81))
            if i<2:
                with self.assertRaises(SensorWarmup):timing.imu('imu',native)
            else:
                data,_=timing.imu('imu',native)
                np.testing.assert_allclose(data,[3.,0.,9.81],atol=1e-9)


class ImageProtocolTests(unittest.TestCase):
    def test_image_connection_never_takes_or_releases_control_ownership(self):
        import time
        from websockets.sync.client import connect
        from backend.websocket_bridge import WebSocketBridge
        from backend.core.host_clock import monotonic
        service=SimulationService(None);service._publish(packet())
        meta={'frame':1,'timestamp':.05,'width':1280,'height':720,'contentType':'image/jpeg',
            'captureMonotonic':monotonic(),'captureUnix':time.time(),'captureClock':'NATIVE_TICK_REQUEST'}
        service.get_stream_image=lambda camera:(b'native-jpeg',meta)
        bridge=WebSocketBridge(service,'127.0.0.1',0,8000)
        bridge.start()
        url='ws://127.0.0.1:'+str(bridge.server.socket.getsockname()[1])
        try:
            with connect(url+'/images',compression=None) as images:
                images.send(json.dumps({'type':'subscribe','session_id':service.session_id,
                    'camera_id':'drivingCamera','client_unix_ms':time.time()*1000}))
                self.assertEqual(json.loads(images.recv())['type'],'image_stream')
                wire=images.recv()
                self.assertIsInstance(wire,bytes)
                self.assertIsNone(bridge.owner)
                images.send(json.dumps({'type':'ack','session_id':service.session_id,'frame_id':1}))
                with connect(url) as control:
                    state=json.loads(control.recv())
                    self.assertTrue(state['controller'])
                    owner=bridge.owner
                    with patch.object(service,'release_controls') as release:
                        images.close()
                        self.assertIs(bridge.owner,owner)
                        release.assert_not_called()
        finally:
            bridge.close()

    def test_binary_packet_has_exact_identity_dimensions_clock_and_original_bytes(self):
        from backend.image_stream import image_packet
        meta={'frame':7,'timestamp':7/60,'width':1280,'height':720,'contentType':'image/jpeg',
            'captureMonotonic':1.,'captureUnix':100.,'captureClock':'NATIVE_TICK_REQUEST'}
        data=b'original-jpeg'
        wire=image_packet(data,meta,'session-a','drivingCamera')
        length=struct.unpack('!I',wire[:4])[0]
        header=json.loads(wire[4:4+length])
        self.assertEqual(wire[4+length:],data)
        self.assertEqual((header['session_id'],header['camera_id'],header['frame_id']),('session-a','drivingCamera',7))
        self.assertEqual((header['width'],header['height']),(1280,720))
        self.assertEqual(header['capture_clock'],'NATIVE_TICK_REQUEST')
        self.assertEqual(header['simulation_timestamp_s'],7/60)
        for invalid in ({**meta,'width':0},{**meta,'frame':True},{**meta,'timestamp':float('nan')}):
            with self.assertRaises(ValueError):image_packet(data,invalid,'session-a','drivingCamera')

    def test_client_measurements_cannot_create_nonfinite_or_unbounded_shapes(self):
        from backend.image_stream import display_metrics
        self.assertEqual(display_metrics({'displayFps':59.8}),{'displayFps':59.8})
        for data in ({'displayFps':float('nan')},{'displayFps':-1},{'displayFps':True},{'frames':[1,2]},[]):
            with self.assertRaises(ValueError):display_metrics(data)

    def test_invalid_image_ack_is_a_visible_image_error_without_control_side_effects(self):
        import time
        from backend.image_stream import ImageStreamBridge
        from backend.core.host_clock import monotonic
        service=NS(session_id='current',lock=threading.RLock(),display_metrics={},release_controls=Mock(),
            get_stream_image=lambda camera:(b'jpeg',{'frame':1,'timestamp':.05,'width':1280,'height':720,
                'contentType':'image/jpeg','captureMonotonic':monotonic(),'captureUnix':time.time()}))
        messages=[json.dumps({'type':'subscribe','session_id':'current','camera_id':'drivingCamera','client_unix_ms':0}),
            json.dumps({'type':'ack','session_id':'old','frame_id':1})]
        socket=Mock(recv=Mock(side_effect=messages),send=Mock(),close=Mock())
        bridge=ImageStreamBridge(service);bridge.handle(socket)
        self.assertEqual(socket.close.call_args.args[0],1008)
        self.assertIn('identity mismatch',socket.close.call_args.args[1])
        service.release_controls.assert_not_called()


class RenderAuditTests(unittest.TestCase):
    def test_wddm_process_allocations_are_never_mislabelled_as_board_residency(self):
        from backend.core.resources import wddm_process_memory
        records=[{'Name':'pid_42_luid_a_phys_0','DedicatedUsage':1048576,'SharedUsage':2097152},
            {'Name':'pid_42_luid_b_phys_0','DedicatedUsage':3145728,'SharedUsage':0}]
        with patch('backend.core.resources.subprocess.run',return_value=NS(returncode=0,stdout=json.dumps(records))):
            result=wddm_process_memory([42,99])
        self.assertEqual(result['processes'][0]['usedMiB'],4.)
        self.assertEqual(result['processes'][0]['sharedMiB'],2.)
        self.assertEqual(result['missingPids'],[99])
        self.assertEqual(result['scope'],'ALL_ADAPTERS_ALLOCATIONS_NOT_DEVICE_RESIDENCY')

    def test_applied_engine_console_values_are_required_not_just_written_configuration(self):
        from backend.graphics import render_settings
        from backend.carla.runtime import NativeRuntime
        values=render_settings('PERFORMANCE_60')
        self.assertEqual(values['r.Streaming.MipBias'],0)
        self.assertEqual(values['r.ScreenPercentage'],100)
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'engine.log'
            path.write_text('\n'.join(f'LogConsoleResponse: {k} = "{v}" LastSetBy: SystemSettingsIni' for k,v in values.items()))
            audit=NativeRuntime.render_audit(path,'PERFORMANCE_60')
            self.assertTrue(audit['verified'])
            path.write_text('LogConsoleResponse: r.Streaming.PoolSize = "1400"')
            audit=NativeRuntime.render_audit(path,'PERFORMANCE_60')
            self.assertFalse(audit['verified'])
            self.assertTrue(audit['missing'])
            self.assertIn('r.Streaming.PoolSize',audit['mismatches'])
