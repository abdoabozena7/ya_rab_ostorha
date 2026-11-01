"""Synthetic negative controls for evidence analysis, not native acceptance."""
import unittest
from integrations.gta.protocol_probe import assess, FAULTS, GAPS


def fixture():
    trace, captures, views, events = [], [], [], []
    counters = dict(rejected_replay=0, rejected_owner=0, rejected_stale=0)
    for step in range(421):
        seconds = step/10
        ms = 10000+step*100
        phase = next((k for k, (a, b, _) in {**FAULTS, **GAPS}.items() if a <= seconds < b), 'HOLD')
        sequence = step+1
        lease_gap = 27 <= seconds < 30
        capture_gap = 34 <= seconds < 37
        common = dict(host_ms=ms, elapsed_s=seconds, phase=phase, valid_sequence=sequence, run_id='test')
        events.append({**common, 'event': 'withheld' if lease_gap else 'valid_sent'})
        if phase in FAULTS:
            counter = FAULTS[phase][2]
            events.append({**common, 'event': 'fault_sent', 'counter': counter, 'baseline': counters[counter],
                           'invalid_sequence': sequence if phase == 'REPLAY' else sequence+1000000})
            counters[counter] += 1
        trace.append(dict(run_id='test', pid=1, frame=step+1, stage='FOUNDATION_CALIBRATION', host_ms=ms,
                          sequence=270 if lease_gap else sequence, speed_mps=0., throttle=0., brake=1.,
                          lease_expired=int(lease_gap), sensor_stale=int(capture_gap),
                          capture_ms=13300 if capture_gap else ms, **counters))
        if not capture_gap:
            captures.append(dict(run_id='test', pid=1, serial=step+1))
        views.append(dict(yaw_offset_deg=0))
    return [trace, captures, views, events, 'test', [1]]


class ProtocolOracleTests(unittest.TestCase):
    def test_complete_fixture_is_accepted_as_fixture_only(self):
        self.assertTrue(assess(*fixture())['passed'])

    def test_missing_fault_response_cannot_use_cumulative_counter(self):
        data = fixture()
        for r in data[0]:
            r['rejected_replay'] = 100
        for e in data[3]:
            if e.get('phase') == 'REPLAY' and e['event'] == 'fault_sent':
                e['baseline'] = 100
        self.assertFalse(assess(*data)['protocol_rejections'])

    def test_each_fault_is_independently_required(self):
        for phase in FAULTS:
            with self.subTest(phase=phase):
                data = fixture()
                data[3] = [e for e in data[3] if not (e['phase'] == phase and e['event'] == 'fault_sent')]
                self.assertFalse(assess(*data)['passed'])

    def test_sentinel_acceptance_is_failure(self):
        data = fixture(); data[0][-1]['sequence'] = 1000001
        self.assertFalse(assess(*data)['no_sentinel_acknowledgment'])

    def test_rejected_camera_must_not_take_effect(self):
        data = fixture(); data[2][150]['yaw_offset_deg'] = 90
        self.assertFalse(assess(*data)['camera_unchanged'])

    def test_wrong_run_or_process_is_failure(self):
        for index, key, value in ((0, 'pid', 2), (1, 'run_id', 'another')):
            data = fixture(); data[index][0][key] = value
            self.assertFalse(assess(*data)['live_identity'])

    def test_repeating_one_frame_cannot_qualify_live_identity(self):
        data = fixture()
        for row in data[0]: row['frame'] = 1
        self.assertFalse(assess(*data)['live_identity'])

    def test_watchdog_flag_without_brake_is_failure(self):
        data = fixture(); data[0][285]['brake'] = 0
        self.assertFalse(assess(*data)['watchdogs_and_recovery'])

    def test_recovery_requires_acknowledged_new_commands(self):
        data = fixture()
        for row in data[0][300:325]: row['sequence'] = 270
        self.assertFalse(assess(*data)['watchdogs_and_recovery'])

    def test_capture_recovery_requires_new_sensor_time(self):
        data = fixture()
        for row in data[0][370:400]: row['capture_ms'] = 13300
        self.assertFalse(assess(*data)['watchdogs_and_recovery'])

    def test_motion_or_missing_measurement_is_failure(self):
        for value in (.2, float('nan')):
            data = fixture(); data[0][150]['speed_mps'] = value
            self.assertFalse(assess(*data)['stationary'])


if __name__ == '__main__':
    unittest.main()
