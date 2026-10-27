from dataclasses import replace
import json
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from backend.core import urban_driver
from backend.core.behavior_proposals import BehaviorProposalShadow, measured_situation, parse_proposal
from backend.core.contracts import CommandSource, freeze_json, to_dict
from backend.core.control import ControlMode
from backend.core.service import SimulationService
from tests.core_packets import packet
from tests import test_egypt_urban as urban_fixtures
from tests import test_braking_decisions as braking_fixtures


def response(request, **changes):
    value = {'version': 1, 'request_id': request['request_id'], 'session_id': request['session_id'],
             'source_frame': request['source_frame'], 'source_timestamp_s': request['source_timestamp_s'],
             'expires_timestamp_s': request['expires_timestamp_s'], 'intent': 'PREPARE_TO_PASS',
             'blocker_track_id': 'lead', 'reason_code': 'PERSISTENT_STATIONARY_BLOCKAGE', 'abstain': False}
    return {**value, **changes}


class BehaviorProposalTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixtures = urban_fixtures.UrbanDriverTests()
        cls.fixtures.setUpClass()

    def setUp(self):
        self.scene, self.base, self.road = self.fixtures.scene([urban_fixtures.track('lead', 35., 0.)])
        self.baseline = {'action': 'FOLLOW', 'front_blocker': {'track_id': 'lead'}}
        self.gate = BehaviorProposalShadow()
        self.gate.observe(self.scene, self.road, self.baseline, wall_s=100.05)
        self.request = self.gate.take_request()

    def poll(self, **changes):
        return self.gate.observe(changes.get('scene', self.scene), changes.get('road', self.road),
                                 changes.get('baseline', self.baseline), wall_s=changes.get('wall_s', 100.1))

    def test_valid_proposal_is_only_semantics_and_has_no_control_authority(self):
        proposal = response(self.request)
        self.assertEqual(to_dict(parse_proposal(proposal)), proposal)
        self.gate.submit(self.request['request_id'], proposal)
        before = to_dict(self.base)
        result = self.poll()
        self.assertEqual(result['status'], 'VALID_SHADOW_PROPOSAL')
        self.assertFalse(result['control_authority'])
        self.assertFalse(result['learned_control_used'])
        self.assertEqual(result['fallback'], 'UNCHANGED_BASE_DRIVER')
        self.assertEqual(to_dict(self.base), before)
        self.assertEqual(set(result['proposal']), set(proposal))
        self.assertEqual(result['candidate_feasibility'], 'NOT_EVALUATED_BY_PROPOSAL_INTERFACE')

    def test_schema_rejects_commands_unknown_fields_nonfinite_and_inconsistent_intents(self):
        invalid = [
            {'throttle': 1.}, {'path': [[0., 0.]]}, {'intent': 'OVERTAKE_NOW'},
            {'source_frame': True}, {'expires_timestamp_s': float('nan')},
            {'expires_timestamp_s': 3.}, {'source_timestamp_s': True}, {'abstain': 'false'},
            {'reason_code': 'MOVING_QUEUE'}, {'blocker_track_id': None},
            {'request_id': ''}, {'request_id': 'x' * 129}, {'version': 2},
            {'abstain': True}, {'intent': 'FOLLOW', 'reason_code': 'CLEAR_ROAD'},
        ]
        for change in invalid:
            with self.subTest(change=change), self.assertRaises((ValueError, TypeError)):
                parse_proposal(response(self.request, **change))
        missing = response(self.request)
        del missing['abstain']
        with self.assertRaises(ValueError):
            parse_proposal(missing)
        for raw in ('not json', '[]', '{"version":1,"version":1}', '"' + 'x' * 8193 + '"'):
            with self.subTest(raw=raw[:25]), self.assertRaises(ValueError):
                parse_proposal(raw)

    def test_invalid_model_data_and_disconnect_are_explicit_without_raising_in_observe(self):
        with self.assertLogs('simulation', level='WARNING'):
            result = self.gate.submit(self.request['request_id'], {'invalid': True})
        self.assertEqual(result['status'], 'INVALID_PROPOSAL')
        self.assertEqual(self.poll()['status'], 'INVALID_PROPOSAL')
        for reason in ('MODEL_UNAVAILABLE', 'MODEL_FAILED', 'MODEL_TIMEOUT'):
            with self.subTest(reason=reason), self.assertLogs('simulation', level='WARNING'):
                self.gate.fail(self.request['request_id'], reason, 'injected failure')
            self.assertEqual(self.poll()['status'], reason)
            self.assertFalse(self.poll()['control_authority'])
        raw = '[' * 1500 + '0' + ']' * 1500
        self.assertEqual(self.gate.submit(self.request['request_id'], raw)['status'], 'INVALID_PROPOSAL')

    def test_out_of_order_or_clock_rollback_never_creates_an_admissible_replacement(self):
        scene, _, road = self.fixtures.scene([urban_fixtures.track('lead', 35., 0.)], stamp=.95, frame=19)
        self.assertEqual(self.poll(scene=scene, road=road)['status'], 'OUT_OF_ORDER_SCENE')
        self.assertIsNone(self.gate.take_request())
        self.assertEqual(self.poll(scene=scene, road=road)['status'], 'OUT_OF_ORDER_SCENE')
        self.setUp()
        self.assertEqual(self.poll(wall_s=100.04)['status'], 'INVALID_HOST_CLOCK')
        self.assertIsNone(self.gate.take_request())

    def test_abstention_and_conflicting_replies_cannot_choose_a_maneuver(self):
        abstain = response(self.request, intent='WAIT', reason_code='INSUFFICIENT_EVIDENCE',
                           blocker_track_id=None, abstain=True)
        self.gate.submit(self.request['request_id'], abstain)
        self.assertEqual(self.poll()['status'], 'ABSTAINED')
        self.gate.submit(self.request['request_id'], response(self.request))
        self.assertEqual(self.poll()['status'], 'CONFLICTING_PROPOSALS')
        self.gate.submit(self.request['request_id'], abstain)
        self.assertEqual(self.poll()['status'], 'CONFLICTING_PROPOSALS')

    def test_references_and_unknown_track_are_not_trusted(self):
        for change in ({'session_id': 'other'}, {'source_frame': 99}, {'source_timestamp_s': 1.01},
                       {'request_id': 'other'}):
            with self.subTest(change=change):
                self.gate.submit(self.request['request_id'], response(self.request, **change))
                self.assertEqual(self.poll()['status'], 'REFERENCE_MISMATCH')
        self.setUp()
        self.gate.submit(self.request['request_id'], response(self.request, blocker_track_id='ghost'))
        self.assertEqual(self.poll()['status'], 'BLOCKER_REFERENCE_MISMATCH')
        self.assertEqual(self.gate.submit('old-request', response(self.request))['status'], 'UNKNOWN_REQUEST')

    def test_current_freshness_and_proposal_lifetimes_are_independent(self):
        self.gate.submit(self.request['request_id'], response(self.request))
        self.assertEqual(self.poll(wall_s=100.251)['status'], 'STALE_MEASUREMENTS')
        self.assertIsNone(self.gate.take_request())
        self.setUp()
        scene, _, road = self.fixtures.scene([urban_fixtures.track('lead', 35., 0.)], stamp=1.1, frame=22)
        scene = replace(scene, received_wall_s=101.)
        result = self.poll(scene=scene, road=road, wall_s=101.1)
        self.assertEqual(result['status'], 'PROPOSAL_TIMEOUT')
        self.assertNotEqual(result['next_request_id'], self.request['request_id'])
        self.assertEqual(self.gate.submit(self.request['request_id'], response(self.request))['status'], 'UNKNOWN_REQUEST')
        self.setUp()
        self.gate.submit(self.request['request_id'], response(self.request, expires_timestamp_s=1.05))
        self.assertEqual(self.poll(scene=replace(scene, received_wall_s=100.), wall_s=100.1)['status'], 'PROPOSAL_EXPIRED')

    def test_road_blocker_and_session_changes_invalidate_captured_suggestions(self):
        self.gate.submit(self.request['request_id'], response(self.request))
        for change in ({'left_allowed': False}, {'junction_ahead': True}, {'traffic_stop': 'red'},
                       {'centerline': [[0., 1.], [120., 1.]]}):
            with self.subTest(change=change):
                self.setUp()
                self.gate.submit(self.request['request_id'], response(self.request))
                self.assertEqual(self.poll(road={**self.road, **change})['status'], 'ROAD_CONTEXT_CHANGED')
        for track in (urban_fixtures.track('lead', 37., 0.), urban_fixtures.track('lead', 35., 0., 1.),
                      urban_fixtures.track('lead', 35., 0., person=True)):
            with self.subTest(track=track):
                self.setUp()
                changed, _, road = self.fixtures.scene([track], stamp=1.05, frame=21)
                self.assertEqual(self.poll(scene=changed, road=road)['status'], 'BLOCKER_MEASUREMENT_CHANGED')
        self.setUp()
        changed = replace(self.scene, session_id='other')
        result = self.poll(scene=changed, road={**self.road, 'session_id': 'other'})
        self.assertEqual(result['status'], 'SESSION_CHANGED')
        self.assertEqual(len(self.gate.history), 1)

    def test_missing_track_illegal_pass_and_moving_blocker_do_not_admit_prepare(self):
        for tracks, road_change, expected in (
            ([], {}, 'INVALID_MEASURED_CONTEXT'),
            ([urban_fixtures.track('lead', 35., 0.)], {'left_allowed': False}, 'PASS_NOT_PERMITTED'),
            ([urban_fixtures.track('lead', 35., 0., .4)], {}, 'BLOCKER_NOT_STATIONARY'),
        ):
            with self.subTest(expected=expected):
                scene, _, road = self.fixtures.scene(tracks)
                gate = BehaviorProposalShadow()
                first = gate.observe(scene, {**road, **road_change}, self.baseline, wall_s=100.05)
                request = gate.take_request()
                if request:
                    gate.submit(request['request_id'], response(request))
                    first = gate.observe(scene, {**road, **road_change}, self.baseline, wall_s=100.1)
                self.assertEqual(first['status'], expected)

    def test_payload_is_bounded_immutable_and_excludes_privileged_inputs(self):
        tracks = [{**urban_fixtures.track('lead' if i == 0 else f'track-{i}', 10. + i, 0.),
                   'actor_id': 'secret-native-actor', 'oracle_trajectory': 'secret-future'} for i in range(50)]
        scene, _, road = self.fixtures.scene(tracks)
        scene = replace(scene, prediction=freeze_json({**dict(scene.prediction), 'scenario': 'secret-scenario'}))
        situation = measured_situation(scene, {**road, 'scenario_label': 'secret-label'}, 'lead')
        encoded = json.dumps(to_dict(situation))
        self.assertNotIn('secret-', encoded)
        self.assertEqual(len(situation['tracks']), 32)
        self.assertEqual(situation['tracks'][0]['id'], 'lead')
        self.assertTrue(situation['tracks_truncated'])
        self.assertLessEqual(len(situation['images']), 2)
        with self.assertRaises(TypeError):
            situation['tracks'][0]['id'] = 'mutated'
        self.request['situation']['tracks'][0]['id'] = 'worker-mutation'
        self.assertEqual(self.gate.pending['situation']['tracks'][0]['id'], 'lead')

    def test_one_pending_request_and_bounded_history(self):
        self.assertIsNone(self.gate.take_request())
        for i in range(1, 15):
            scene, _, road = self.fixtures.scene([urban_fixtures.track('lead', 35., 0.)],
                                                 stamp=1. + i * .05, frame=20 + i)
            self.poll(scene=scene, road=road)
            self.assertIsNone(self.gate.take_request())
        self.assertEqual(len(self.gate.history), 8)
        self.assertEqual(self.gate.pending['request_id'], self.request['request_id'])

    def test_service_shadow_observes_after_submission_and_cannot_change_the_selected_command(self):
        results = []
        for enabled in (False, True):
            service, _, _ = braking_fixtures.fixture(driving_mode='NORMAL')
            order = []
            service.provider.apply_control.side_effect = lambda _: order.append('apply')
            service.provider.apply_control_confirmed.side_effect = lambda _: order.append('apply')
            if enabled:
                gate = BehaviorProposalShadow()
                scene = replace(self.scene, received_wall_s=0.)
                gate.observe(scene, self.road, self.baseline, wall_s=0.)
                request = gate.take_request()
                service.behavior_shadow = gate
                service.behavior_shadow_context = (scene, self.road, self.baseline)
                gate.fail(request['request_id'], 'MODEL_FAILED', 'injected disconnect')
                original = gate.observe

                def observe(*args, **kwargs):
                    self.assertIn('apply', order)
                    order.append('shadow')
                    return original(*args, **kwargs)

                with patch.object(gate, 'observe', side_effect=observe):
                    service._iteration()
                self.assertEqual(order, ['apply', 'shadow'])
                self.assertEqual(service.behavior_shadow_status['status'], 'MODEL_FAILED')
                self.assertFalse(service.behavior_shadow_status['control_authority'])
            else:
                service._iteration()
            calls = service.provider.apply_control.call_args or service.provider.apply_control_confirmed.call_args
            results.append(to_dict(calls.args[0]))
        self.assertEqual(results[0], results[1])
        with self.assertRaises(ValueError):
            SimulationService(SimpleNamespace(), behavior_shadow=lambda: {'throttle': 1.})

    def test_egypt_service_default_and_valid_shadow_intent_apply_identical_controls(self):
        outputs = []
        for enabled in (False, True):
            template, clock, _ = braking_fixtures.fixture(driving_mode='ROBOSPHERE', automatic=True)
            clock[0] = 100.
            provider = template.provider
            gate = BehaviorProposalShadow() if enabled else None
            service = SimulationService(provider, now=template.now, behavior_shadow=gate)
            service.active_safety = template.active_safety
            scene = replace(self.scene, session_id=service.session_id)
            road = {**self.road, 'session_id': service.session_id}
            base = replace(self.base, source=CommandSource.NAVIGATION)
            service._publish(packet(base.frame_id, base.timestamp_s, speed=scene.observation.ego.speed_mps))
            service.clock.observe(service.observation.world)
            service.control_scene = scene
            service.arbiter.machine.transition(ControlMode.AUTOMATIC, connected=True, explicit=True)
            service.journey.update(status='RUNNING', driving_mode='ROBOSPHERE',
                                   scenario_id='EGYPT_URBAN_CHAOS_V1', speed_kmh=60.)
            service.navigation_heartbeat_at = service.navigation_transport_at = 100.
            driver = urban_driver.UrbanManeuverDriver(scene.geometry)
            provider.hybrid_driver = provider.urban_driver = driver
            provider.navigation_speed_limit_mps = 60. / 3.6
            provider.navigation_command = Mock(return_value=base)
            provider.hybrid_road_context = Mock(return_value=road)
            provider.get_simulation_frame = lambda: packet(base.frame_id + 1, base.timestamp_s + .05, speed=6.)
            service._audit_command = Mock()
            if gate is not None:
                gate.observe(scene, road, self.baseline, wall_s=100.)
                request = gate.take_request()
                gate.submit(request['request_id'], response(request))
            else:
                self.assertIsNone(service.behavior_shadow)
            with patch.object(urban_driver, 'time', SimpleNamespace(perf_counter=lambda: 0.)):
                service._iteration()
            call = provider.apply_control.call_args or provider.apply_control_confirmed.call_args
            self.assertIsNotNone(call)
            self.assertFalse(service.maneuver_status['learned_control_used'])
            outputs.append((to_dict(call.args[0]), {key: service.maneuver_status.get(key)
                                                  for key in ('action', 'phase', 'reason', 'selected_path')}))
            if gate is not None:
                self.assertEqual(service.behavior_shadow_status['status'], 'VALID_SHADOW_PROPOSAL')
                self.assertEqual(service.behavior_shadow_status['proposal']['intent'], 'PREPARE_TO_PASS')
                self.assertFalse(service.behavior_shadow_status['control_authority'])
                self.assertEqual(service.maneuver_status['action'], 'FOLLOW')
                self.assertIsNone(service.behavior_shadow_context)
            else:
                self.assertIsNone(service.behavior_shadow_status)
        self.assertEqual(outputs[0], outputs[1])

    def test_six_development_cases_replay_with_unchanged_driver_and_shield_outputs(self):
        cases = {
            'CLEAR_ROAD': ([], {}),
            'MOVING_QUEUE': ([urban_fixtures.track('lead', 35., 0., 3.)], {}),
            'PARKED_BLOCKER': ([urban_fixtures.track('lead', 35., 0.)], {}),
            'PASS_FORBIDDEN': ([urban_fixtures.track('lead', 35., 0.)], {'left_allowed': False}),
            'UNSAFE_GAP': ([urban_fixtures.track('lead', 35., 0.),
                            urban_fixtures.track('rear', -20., -3.5, 20.)], {}),
            'AMBIGUOUS_WAIT': ([urban_fixtures.track('lead', 8., 0., person=True)], {}),
        }
        for name, (tracks, road_change) in cases.items():
            with self.subTest(case=name):
                arms = []
                for shadow in (False, True):
                    driver = urban_driver.UrbanManeuverDriver(self.scene.geometry)
                    gate = BehaviorProposalShadow()
                    output = []
                    with patch.object(urban_driver, 'time', SimpleNamespace(perf_counter=lambda: 0.)):
                        for frame, stamp in ((20, 1.), (30, 1.5)):
                            scene, base, road = self.fixtures.scene(tracks, frame=frame, stamp=stamp)
                            wall = 100. + stamp
                            scene = replace(scene, received_wall_s=wall)
                            road = {**road, **road_change}
                            command, behavior = driver.evaluate(scene, base, road, 8., wall=wall + .05)
                            before = to_dict(command)
                            if shadow:
                                gate.observe(scene, road, behavior, wall_s=wall + .06)
                                request = gate.take_request()
                                if request:
                                    gate.submit(request['request_id'], response(request, throttle=1.))
                                    gate.observe(scene, road, behavior, wall_s=wall + .07)
                            self.assertEqual(to_dict(command), before)
                            output.append((before, {k: behavior.get(k) for k in (
                                'action', 'phase', 'reason', 'selected_path', 'rejected', 'completed_maneuvers')}))
                    arms.append(output)
                self.assertEqual(arms[0], arms[1])
                if name in ('PASS_FORBIDDEN', 'UNSAFE_GAP'):
                    self.assertFalse(arms[0][-1][1]['action'].startswith('CHANGE_'))


if __name__ == '__main__':
    unittest.main()
