from unittest import TestCase
import numpy as np
from backend.core.closed_loop_metrics import brake_reason, episode_metrics


def episode(*, crossing=True, stop_without_hazard=False, oscillate=False):
    manifest = {'scenario_id': 's', 'behavior': 'CROSS_NORMAL' if crossing else 'WAIT_AT_CURB', 'split': 'TEST',
                'route': [[x, 0.] for x in range(0, 202, 2)], 'ego_front_m': 2.3, 'corridor_half_width_m': 1.25,
                'ego_geometry': {'front_m': 2.3, 'rear_m': 2.3, 'half_width_m': 1.0}, 'native_route_length_m': 200.,
                'admission': {'configuration': 'D_EVIDENCE_BUDGETED'}, 'spec': {'counterfactual': None}}
    rows = [];x = 0.;v = 8.
    for k in range(int(20/.05)):
        t = k*.05
        braking = crossing and 2.5 <= t < 6. or stop_without_hazard and 8. <= t < 11.
        if oscillate and 12. <= t < 16.:braking = int((t-12.)/.6) % 2 == 0
        a = -5. if braking else 2. if v < 8. else 0.
        v = max(0., min(8., v+a*.05));x += v*.05
        y = 6. if t < 3. else max(-6., 6.-1.5*(t-3.)) if crossing else 6.
        reason = 'Braking for a person who may cross the driving path' if braking else 'Observed forward stopping corridor is clear'
        rows.append({'timestamp_s': 100.+t, 'elapsed_s': t, 'ego': {'speed_mps': v, 'position_m': [x, 0., 0.], 'yaw_rad': 0.},
                     'applied_command': {'brake': 1. if braking else 0., 'throttle': 0. if braking else .5, 'source': 'SAFETY' if braking else 'NAVIGATION'},
                     'safety': {'status': 'BRAKING' if braking else 'MONITORING', 'reason': reason},
                     'route': {'remaining_m': 200.-x}, 'scene': {'usable': True}, 'step_ms': 150.,
                     'evaluator_truth': [{'id': 9, 'role': 'ped_0', 'kind': 'walker', 'position_m': [60., y, 1.], 'half_size_m': [.3, .3]}]})
    return manifest, rows, {'outcome': 'ARRIVED', 'contacts': [], 'distance_m': x}


class ClosedLoopMetricTests(TestCase):
    def test_hazard_response_is_credited_with_lead_times_and_not_unnecessary(self):
        manifest, rows, outcome = episode()
        m = episode_metrics(manifest, rows, outcome)
        self.assertEqual(m['collisions'], 0);self.assertTrue(m['arrived'])
        self.assertEqual(m['unnecessary_braking_events'], 0)
        ingress = m['ingress_events'][0]
        self.assertGreater(ingress['prediction_lead_s'], 0.);self.assertGreater(ingress['braking_lead_s'], 0.)
        self.assertEqual(m['missed_hazards'], 0)
        self.assertGreater(m['maximum_deceleration_mps2'], 3.)
        self.assertAlmostEqual(m['freshness']['fraction'], 1.)
        self.assertAlmostEqual(m['performance']['real_time_factor'], .05/.15, places=2)

    def test_braking_and_stops_without_independent_hazard_are_unnecessary(self):
        manifest, rows, outcome = episode(crossing=False, stop_without_hazard=True)
        m = episode_metrics(manifest, rows, outcome)
        self.assertEqual(m['unnecessary_braking_events'], 1)
        self.assertGreaterEqual(m['unnecessary_full_stops'], 1);self.assertGreater(m['unnecessary_stationary_s'], .5)
        self.assertEqual(m['ingress_events'], [])

    def test_brake_release_oscillations_are_counted(self):
        manifest, rows, outcome = episode(crossing=False, oscillate=True)
        self.assertGreaterEqual(episode_metrics(manifest, rows, outcome)['brake_release_oscillations'], 2)

    def test_red_light_and_vehicle_queue_waits_are_legitimate_not_unnecessary(self):
        baseline = episode_metrics(*episode(crossing=False, stop_without_hazard=True))
        manifest, rows, outcome = episode(crossing=False, stop_without_hazard=True)
        for row in rows:
            if 8. <= row['elapsed_s'] < 11.2:row['speed'] = {'navigation_stop_reason': 'Red traffic light on the planned route'}
        signal = episode_metrics(manifest, rows, outcome)
        self.assertGreater(baseline['unnecessary_stationary_s'], .5)
        self.assertEqual((signal['unnecessary_stationary_s'], signal['unnecessary_full_stops']), (0., 0))
        self.assertGreater(signal['legitimate_wait_s']['signal'], .5)
        manifest, rows, outcome = episode(crossing=False, stop_without_hazard=True)
        for row in rows:
            ahead = row['ego']['position_m'][0]+2.3+(8. if 8. <= row['elapsed_s'] < 11.2 else 40.)
            row['evaluator_truth'].append({'id': 7, 'role': 'background', 'kind': 'vehicle', 'position_m': [ahead, .3, 0.]})
        queued = episode_metrics(manifest, rows, outcome)
        self.assertEqual(queued['unnecessary_stationary_s'], 0.);self.assertGreater(queued['legitimate_wait_s']['vehicle_queue'], .5)
        # A vehicle beside the corridor is not a queue.
        for row in rows:row['evaluator_truth'][-1]['position_m'][1] = 4.
        self.assertGreater(episode_metrics(manifest, rows, outcome)['unnecessary_stationary_s'], .5)

    def test_arrivals_must_be_at_the_destination(self):
        manifest, rows, outcome = episode(crossing=False)
        final = rows[-1]['ego']['position_m'][0]
        manifest['route'] = [[float(x), 0.] for x in np.arange(0., final, 2.)]+[[final+1., 0.]]
        self.assertFalse(episode_metrics(manifest, rows, outcome)['false_arrival'])
        self.assertTrue(episode_metrics(manifest, rows[:len(rows)//2], outcome)['false_arrival'])

    def test_timeouts_are_not_arrivals_and_reasons_are_classified(self):
        manifest, rows, _ = episode(crossing=False)
        m = episode_metrics(manifest, rows, {'outcome': 'TIMEOUT', 'contacts': []})
        self.assertFalse(m['arrived']);self.assertTrue(m['timeout']);self.assertIsNone(m['journey_time_s'])
        self.assertEqual(brake_reason({'safety': {'status': 'HOLD', 'reason': 'CONTROL_PROCESSING_DEADLINE'}}), 'TIMING_DEADLINE')
        self.assertEqual(brake_reason({'safety': {'reason': 'Insufficient measured forward road coverage'}}), 'COVERAGE')
        self.assertEqual(brake_reason({'safety': {'evidence_decision': {'response': 'CAUTIOUS_APPROACH', 'people': [{}]}}}),
                         'PEDESTRIAN_FORECAST')
