"""Supervisor integration of the evaluation decision layers (offline contracts)."""
from dataclasses import replace
import unittest
from unittest.mock import patch
from backend.core.active_safety import ActiveSafetySupervisor, assess_forward_space
from backend.core.kinematic_prediction import kinematic_modes
from backend.core.motion_geometry import VehicleGeometry
from tests.test_active_safety import scene
from tests.test_safety_teacher import case


def evaluate(layer, *, position=(30., 4.), velocity=(0., 0.), speed=8., road=60., risk=None, asynchronous=False):
    from tests.test_pedestrian_anticipation import PedestrianAnticipationTests
    supervisor = ActiveSafetySupervisor();supervisor.geometry = VehicleGeometry();supervisor.decision_layer = layer
    if risk is not None:
        import numpy as np
        from backend.core.path_entry_risk import AsyncRiskEstimator, RiskEstimator
        model = type('Stub', (), {'probabilities': lambda self, x: np.tile([risk/2, risk*.8, risk], (len(x), 1))})()
        supervisor.risk_estimator = RiskEstimator(model, corridor_half_width_m=1.4, front_m=2.5, experimental=True)
        if asynchronous:supervisor.risk_estimator = AsyncRiskEstimator(supervisor.risk_estimator, wait_budget_ms=5000.)
    supervisor.prediction_speed_cap_mps = 11.;supervisor.processing_latency_s = .1
    o, b = case(distance=None, speed=speed);o, reader = scene(o, clear=True);b = replace(b, throttle=.6, steering=0.)
    assessed = assess_forward_space(o, reader, supervisor.config)
    assessed.update(target_range_m=None, radar_range_m=None, observed_road_range_m=road)
    p, _ = PedestrianAnticipationTests().case();track = p['tracks'][0];now = o.timestamp_s
    track.update(position_m=list(position), velocity_mps=list(velocity),
                 history=[[now-.9+.1*k, *position, *velocity] for k in range(9)]+[[now, *position, *velocity]])
    p.update(evaluation_frame=o.frame_id, timestamp_s=now, odometry_origin_m=[0., 0.], odometry_yaw_rad=0.)
    track['measurement_evidence']['frame_id'] = o.frame_id;track['semantic_evidence']['timestamp_s'] = now
    p['trajectories'] = kinematic_modes([track]);supervisor.control_prediction = p
    with patch('backend.core.active_safety.assess_forward_space', return_value=assessed):
        selected = supervisor.evaluate(o, b, reader, as_of_timestamp_s=now)
    if hasattr(supervisor.risk_estimator, 'close'):supervisor.risk_estimator.close()
    return selected, supervisor.status


class DecisionLayerTests(unittest.TestCase):
    def test_original_rule_is_unchanged_without_a_layer(self):
        selected, status = evaluate(None)
        self.assertIsNotNone(status['pedestrian_prediction']);self.assertEqual(selected.brake, 1.)
        self.assertIsNone(status['decision_layer']);self.assertIsNone(status['evidence_decision'])

    def test_evidence_budget_defers_speculative_braking_for_a_verified_stationary_person(self):
        selected, status = evaluate('EVIDENCE_BUDGETED')
        decision = status['evidence_decision']
        # RULE brakes fully here; the time-indexed layer verifies a moving plan instead.
        self.assertIn(decision['response'], ('CONTINUE', 'CAUTIOUS_APPROACH'));self.assertIsNone(status['pedestrian_prediction'])
        self.assertIn(decision['kind'], ('PASS_BEFORE_REACH', 'OBSERVATION_AFFORDABLE', 'SLOWING_FOR_OBSERVATION'))
        self.assertTrue(selected is None or selected.brake <= .4)
        self.assertNotIn('UNVERIFIED', (decision['responses'] or {}).values())
        far, status = evaluate('EVIDENCE_BUDGETED', position=(55., 4.))
        self.assertIn(status['evidence_decision']['response'], ('CONTINUE', 'CAUTIOUS_APPROACH'))
        self.assertTrue(far is None or far.brake == 0.)

    def test_measured_motion_toward_the_path_keeps_rule_protection(self):
        for layer in ('EVIDENCE_BUDGETED', 'LEARNED_RISK'):
            selected, status = evaluate(layer, velocity=(0., -1.2))
            self.assertEqual(selected.brake, 1.);self.assertIsNotNone(status['pedestrian_prediction'])
        _, status = evaluate('EVIDENCE_BUDGETED', velocity=(0., -1.2))
        self.assertEqual(status['evidence_decision']['response'], 'PROTECTIVE_BRAKING')
        self.assertEqual(status['evidence_decision']['physical_conflicts'][0]['reason'], 'MEASURED_MOTION_CONFLICT')

    def test_too_close_and_fast_to_verify_any_plan_still_brakes(self):
        selected, status = evaluate('EVIDENCE_BUDGETED', position=(12., 4.), speed=11.)
        self.assertEqual(status['evidence_decision']['response'], 'PROTECTIVE_BRAKING');self.assertEqual(selected.brake, 1.)
        self.assertIn(status['evidence_decision']['kind'], ('STOP_BEFORE_POSSIBLE_CONFLICT', 'AMBIGUOUS_PROTECTIVE'))

    def test_learned_risk_layer_without_a_model_keeps_rule_decisions(self):
        selected, status = evaluate('LEARNED_RISK')
        self.assertEqual(selected.brake, 1.);self.assertEqual(status['evidence_decision']['risk_status']['status'],
                                                              'NO_ADMITTED_OR_EXPERIMENTAL_MODEL')

    def test_calibrated_risk_only_lowers_verified_speeds(self):
        _, low = evaluate('EVIDENCE_BUDGETED', position=(27., 4.), risk=.05)
        _, high = evaluate('EVIDENCE_BUDGETED', position=(27., 4.), risk=.9)
        self.assertEqual(high['evidence_decision']['risk_status']['status'], 'READY')
        self.assertTrue(high['evidence_decision']['risk_used']);self.assertFalse(low['evidence_decision']['risk_used'])
        low_cap = low['evidence_decision'].get('target_speed_mps') or 11.
        self.assertLess(high['evidence_decision']['target_speed_mps'] if high['evidence_decision']['target_speed_mps'] is not None else 11., low_cap)
        # C keeps RULE's brake for the speculative conflict and adds no release.
        selected, status = evaluate('LEARNED_RISK', risk=.05)
        self.assertEqual(selected.brake, 1.);self.assertIsNotNone(status['pedestrian_prediction'])
        selected, status = evaluate('LEARNED_RISK', position=(58., 4.), risk=.9)
        self.assertTrue(status['evidence_decision']['risk_used'])
        self.assertTrue(selected is None or selected.throttle <= .5)

    def test_off_path_frame_bound_risk_matches_in_step_inference(self):
        for layer, position in (('EVIDENCE_BUDGETED', (27., 4.)), ('LEARNED_RISK', (58., 4.))):
            synchronous, sync_status = evaluate(layer, position=position, risk=.9)
            asynchronous, async_status = evaluate(layer, position=position, risk=.9, asynchronous=True)
            risk_status = async_status['evidence_decision']['risk_status']
            self.assertEqual((risk_status['status'], risk_status['inference']), ('READY', 'ASYNC_FRAME_BOUND'))
            self.assertEqual(async_status['evidence_decision']['target_speed_mps'], sync_status['evidence_decision']['target_speed_mps'])
            self.assertEqual(async_status['evidence_decision']['response'], sync_status['evidence_decision']['response'])
            self.assertEqual(getattr(asynchronous, 'brake', None), getattr(synchronous, 'brake', None))
