import json
import tempfile
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock


class LockstepPerceptionTests(unittest.TestCase):
    def setUp(self):
        import backend.computer_vision.service as vision
        from scripts.native import run_pedestrian_suite as harness
        self.harness = harness
        self.tmp = tempfile.TemporaryDirectory();self.out = Path(self.tmp.name)
        self.patch = mock.patch.object(vision, 'OUTPUT', self.out);self.patch.start()
        self.service = SimpleNamespace(observation=SimpleNamespace(frame_id=10, timestamp_s=50.5), session_id='s1', journey={'status': 'RUNNING'})

    def tearDown(self):
        self.patch.stop();self.tmp.cleanup()

    def publish(self, **value):
        (self.out/'latest-detections.json').write_text(json.dumps({'status': 'RUNNING', 'session_id': 's1', **value}), encoding='utf8')

    def lockstep(self, stride=2, max_wait_s=.3):
        lockstep = self.harness.LockstepPerception(self.service, stride=stride, max_wait_s=max_wait_s)
        lockstep.active = True;lockstep.in_step = True
        return lockstep

    def test_internal_provider_ticks_outside_control_steps_never_wait(self):
        # A vehicle respawn ticks the world while the observation is the previous vehicle's.
        lockstep = self.lockstep();lockstep.in_step = False
        started = time.monotonic();lockstep.before_tick()
        self.assertLess(time.monotonic()-started, .05);self.assertEqual(lockstep.waits, [])

    def test_activation_restarts_camera_derived_state(self):
        builder = SimpleNamespace(semantics='old labels', depth_people=SimpleNamespace(next_id=41))
        self.service.control_scene_builder = builder
        lockstep = self.harness.LockstepPerception(self.service);lockstep.value = {'frame_id': 3};lockstep.waits = [.1]
        lockstep.activate()
        self.assertTrue(lockstep.active);self.assertIsNone(lockstep.value);self.assertEqual(lockstep.waits, [])
        self.assertEqual((builder.semantics.labels, builder.depth_people.tracks, builder.depth_people.next_id), ({}, {}, 41))

    def test_exposes_only_the_result_of_the_exact_frame(self):
        lockstep = self.lockstep();self.publish(frame_id=10, detections=[])
        lockstep.before_tick()
        self.assertEqual(lockstep.latest('s1')['frame_id'], 10)
        self.assertIsNone(lockstep.latest('another-session'))
        self.assertEqual(len(lockstep.waits), 1)

    def test_frames_off_the_stride_neither_wait_nor_update(self):
        lockstep = self.lockstep();self.service.observation.frame_id = 11;self.publish(frame_id=11)
        lockstep.before_tick()
        self.assertIsNone(lockstep.value);self.assertEqual(lockstep.waits, [])

    def test_a_missing_frame_is_recorded_within_the_bounded_wait(self):
        # Bounded below the service's 1 s telemetry-liveness window; never stalls the service.
        lockstep = self.lockstep(max_wait_s=.1);lockstep.value = {'session_id': 's1', 'frame_id': 6};self.publish(frame_id=8)
        started = time.monotonic();lockstep.before_tick()
        self.assertLess(time.monotonic()-started, .5)
        self.assertEqual((lockstep.missed, lockstep.value['frame_id']), ([(10, 50.5)], 6))
        summary = lockstep.summary()
        self.assertEqual((summary['missed_frames'], summary['missed_at_s'], summary['complete']), (1, [50.5], False))

    def test_other_sessions_are_not_accepted(self):
        lockstep = self.lockstep(max_wait_s=.05)
        (self.out/'latest-detections.json').write_text(json.dumps({'status': 'RUNNING', 'session_id': 'old', 'frame_id': 10}), encoding='utf8')
        lockstep.before_tick()
        self.assertIsNone(lockstep.value);self.assertEqual(lockstep.missed, [(10, 50.5)])

    def test_waits_only_while_the_journey_runs(self):
        lockstep = self.lockstep(max_wait_s=.05);self.service.journey = {'status': 'ARRIVED'}
        started = time.monotonic();lockstep.before_tick()
        self.assertLess(time.monotonic()-started, .04);self.assertEqual((lockstep.waits, lockstep.missed), ([], []))

    def test_fast_polling_request_file_names_this_process(self):
        import os
        self.harness.LockstepPerception.request(True)
        self.assertEqual(json.loads((self.out/'lockstep-request.json').read_text(encoding='utf8')), {'parent': os.getpid()})
        self.harness.LockstepPerception.request(False)
        self.assertFalse((self.out/'lockstep-request.json').exists())

    def test_waits_for_a_late_publication(self):
        lockstep = self.lockstep(max_wait_s=2.);self.publish(frame_id=8)
        timer = threading.Timer(.05, lambda: self.publish(frame_id=10));timer.start()
        try:lockstep.before_tick()
        finally:timer.join()
        self.assertEqual(lockstep.value['frame_id'], 10);self.assertGreaterEqual(lockstep.waits[0], .04)

    def test_inactive_lockstep_never_waits(self):
        lockstep = self.lockstep();lockstep.active = False
        started = time.monotonic();lockstep.before_tick()
        self.assertLess(time.monotonic()-started, .05);self.assertIsNone(lockstep.value)

    def test_episode_selection(self):
        lockstep_for = self.harness.lockstep_for
        counterfactual = {'counterfactual': {'pair_id': 'p', 'arm': 'A'}};plain = {'counterfactual': None}
        self.assertTrue(lockstep_for(SimpleNamespace(lockstep_perception='counterfactual'), counterfactual))
        self.assertFalse(lockstep_for(SimpleNamespace(lockstep_perception='counterfactual'), plain))
        self.assertTrue(lockstep_for(SimpleNamespace(lockstep_perception='all'), plain))
        self.assertFalse(lockstep_for(SimpleNamespace(lockstep_perception='off'), counterfactual))
        with self.assertRaises(ValueError):self.harness.LockstepPerception(self.service, stride=0)


class InitialConditionAuditTests(unittest.TestCase):
    def write_arm(self, root, arm, *, timing, missed_at=None, walker_offset=0.):
        import gzip
        directory = Path(root)/arm;directory.mkdir()
        spec = {'counterfactual': {'pair_id': 'p', 'arm': arm, 'decision_s': 2.}}
        (directory/'manifest.json').write_text(json.dumps({'spec': spec, 'admission': {'configuration': 'B_PHYSICAL_PREDICTIVE'},
                                                           'perception_timing': {'mode': timing}}), encoding='utf8')
        outcome = {'outcome': 'ARRIVED', 'contacts': []}
        if timing == 'LOCKSTEP':outcome['perception_timing'] = {'mode': 'LOCKSTEP', 'complete': missed_at is None,
                                                                 'missed_at_s': [] if missed_at is None else [100.+missed_at]}
        (directory/'outcome.json').write_text(json.dumps(outcome), encoding='utf8')
        with gzip.open(directory/'episode.jsonl.gz', 'wt', encoding='utf8') as stream:
            for k in range(80):
                t = k*.05;walker = [30., 4.+(walker_offset if t >= 2. else 0.)]
                stream.write(json.dumps({'timestamp_s': 100.+t, 'elapsed_s': t, 'ego': {'position_m': [t*5., 0., 0.], 'yaw_rad': 0.},
                                         'applied_command': {'throttle': .5, 'brake': 0., 'steering': 0.},
                                         'evaluator_truth': [{'role': 'ped_0', 'position_m': walker+[0.]}], 'scene': {'tracks': []}})+'\n')
        return directory

    def test_counterfactual_prefixes_require_same_timing_and_report_lockstep_misses(self):
        from backend.learning.counterfactual_check import verify_pair
        with tempfile.TemporaryDirectory() as root:
            a = self.write_arm(root, 'A', timing='LOCKSTEP', missed_at=3.5)
            b = self.write_arm(root, 'B', timing='LOCKSTEP', missed_at=1., walker_offset=-3.)
            result = verify_pair(a, b)
            self.assertTrue(result['observable_prefix_identical_within_tolerance'])
            self.assertEqual(result['lockstep_complete_before_decision'], [True, False])
            c = self.write_arm(root, 'C', timing='ASYNC')
            with self.assertRaisesRegex(ValueError, 'perception timing'):verify_pair(a, c)

    def test_background_construction_uses_only_this_episode(self):
        from backend.carla.pedestrian_world import PedestrianBehaviorWorld
        calls = []
        population = SimpleNamespace(set_route=lambda points: calls.append(points), sidewalk_locations=['previous episode'],
                                     last_recycle_at=3.2, last_replacement_at=7.7, last_walker_replacement_at=-float('inf'))
        PedestrianBehaviorWorld.prepare_background(population, [[1., 2., 0.], [3., 4., 0.]], 120.5)
        self.assertEqual(calls, [[[1., 2., 0.], [3., 4., 0.]]])
        self.assertIsNone(population.sidewalk_locations)
        self.assertEqual((population.last_recycle_at, population.last_replacement_at, population.last_walker_replacement_at),
                         (120.5, 120.5, 120.5))

    def test_respawn_starts_every_episode_from_the_same_neutral_reading(self):
        from scripts.native.run_pedestrian_suite import reset_ego
        from tests.core_packets import packet
        events, resets = [], []
        def service_after(previous_gear):
            previous = packet(frame_id=40, timestamp_s=2.)
            previous = previous.__class__(**{**previous.__dict__, 'vehicle': previous.vehicle.__class__(
                **{**previous.vehicle.__dict__, 'gear': previous_gear})})
            return SimpleNamespace(policy_history=[], active_safety=None, _clear_safety_command=lambda: None,
                                   _drain_collision_events=lambda: None, _ingest_provider_sensors=lambda: None,
                                   synchronizer=SimpleNamespace(drain=lambda force=False: [], optional=(), timeout_s=.25),
                                   observation=previous, provider=SimpleNamespace(reset_vehicle=lambda: resets.append(True)),
                                   _required_after_sensor_rebuild=lambda: ('imu',), camera_cache={}, sensor_frame_cache={},
                                   collision_events=[], control_scene=None, control_scene_builder=None, now=time.monotonic,
                                   _event=lambda kind, **payload: events.append(payload))
        after_first_gear, after_neutral = service_after(1), service_after(0)
        reset_ego(after_first_gear);reset_ego(after_neutral)
        self.assertEqual(len(resets), 2)
        # The destroyed vehicle's ending no longer selects the first post-respawn gear.
        self.assertEqual(after_first_gear.observation.vehicle, after_neutral.observation.vehicle)
        self.assertEqual((after_first_gear.observation.vehicle.gear, after_first_gear.observation.vehicle.reverse), (0, False))
        self.assertEqual(events[0]['actor_id'], after_first_gear.observation.vehicle.actor_id)

    def test_background_vehicle_and_walker_mismatches_are_reported(self):
        from scripts.evaluate_closed_loop import initial_conditions
        base = {'scenario_id': 's', 'behavior': 'MIXED_TRAFFIC', 'condition_hash': 'h', 'construction': 'c',
                'ego_initial': {'position_m': [0., 0., 0.]}, 'unrealized_walkers': [], 'walkers_realized': True}
        episodes = [dict(base, configuration='A_REACTIVE', initial_walkers=[('background', [1., 2.])], initial_background_vehicles=[[5., 5.]]),
                    dict(base, configuration='B_PHYSICAL_PREDICTIVE', initial_walkers=[('background', [3., 4.])],
                         initial_background_vehicles=[[9., 9.]]),
                    dict(base, configuration='D_EVIDENCE_BUDGETED', initial_walkers=[('background', [3., 4.])],
                         initial_background_vehicles=[[9., 9.]])]
        report = initial_conditions(episodes)[0]
        self.assertEqual(report['background_vehicles_differ'], ['A_REACTIVE'])
        self.assertEqual(report['background_population_differs'], ['A_REACTIVE'])
        self.assertEqual(report['background_vehicles'], 1)
        self.assertEqual(report['perception_timing'], ['ASYNC'])


if __name__ == '__main__':
    unittest.main()
