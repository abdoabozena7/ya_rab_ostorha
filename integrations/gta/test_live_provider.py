import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from backend.gta.provider import GtaProvider, forward_clearance, guarded_command, latest_json


def geometry():
    return {'rays': [[a, e, 2, 0, 100., 0, 0, 0, 0] for a in range(0, 360, 2) for e in (-6, -2, -.5, 0, 2, 6)]}


def observation():
    return {'connected': True, 'native_ms': 1000, 'capture_ms': 1000, 'geometry_ms': 1000,
            'speed_mps': 1., 'depth_valid': True, 'front': forward_clearance(geometry())}


def intent():
    return {'expires_ms': 1220, 'source_host_ms': 1000, 'steering': .2, 'throttle': .3, 'brake': 0.}


class BoundaryTests(unittest.TestCase):
    def test_no_or_expired_client_never_renews_throttle(self):
        for i in (None, {**intent(), 'expires_ms': 999}):
            r = guarded_command(i, observation(), 1100)
            self.assertEqual((r['throttle'], r['brake']), (0., 1.))

    def test_stale_future_or_missing_measurement_brakes(self):
        for key in ('native_ms', 'capture_ms', 'geometry_ms'):
            for value in (500, 1200, -1000000):
                o = observation();o[key] = value
                self.assertEqual(guarded_command(intent(), o, 1100)['brake'], 1.)

    def test_stale_display_is_not_replaced_with_fresh_hidden_frame(self):
        i = intent();i['source_host_ms'] = 100
        self.assertEqual(guarded_command(i, observation(), 1100)['reason'], 'STALE_DISPLAYED_FRAME')

    def test_close_object_unknown_depth_nonfinite_speed_brakes(self):
        variants = []
        o = observation();o['front']['distance_m'] = 1.;variants.append(o)
        o = observation();o['depth_valid'] = False;variants.append(o)
        o = observation();o['speed_mps'] = float('nan');variants.append(o)
        for o in variants:
            self.assertEqual(guarded_command(intent(), o, 1100)['brake'], 1.)

    def test_pending_missing_duplicate_and_invalid_ray_are_unknown(self):
        g = geometry();g['rays'][0][2] = 1
        self.assertFalse(forward_clearance(g)['known'])
        g = geometry();g['rays'].pop(0)
        self.assertFalse(forward_clearance(g)['known'])
        g = geometry();g['rays'][0] = list(g['rays'][1])
        self.assertFalse(forward_clearance(g)['known'])
        g = geometry();g['rays'][0][4] = float('nan')
        self.assertFalse(forward_clearance(g)['known'])

    def test_clear_current_sample_admits_bounded_requested_motion(self):
        r = guarded_command(intent(), observation(), 1100)
        self.assertEqual((r['steering'], r['throttle'], r['brake']), (.2, .3, 0.))

    def test_large_geometry_and_partial_write_are_parsed_without_inventing_latest(self):
        with tempfile.TemporaryDirectory() as tmp:
            f = Path(tmp)/'geometry.jsonl';g = geometry();g['padding'] = 'x'*30000
            f.write_text(json.dumps(g)+'\n{"incomplete":')
            self.assertEqual(len(latest_json(f)['rays']), 1080)

    def test_single_owner_and_invalid_source_session_or_replay_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp);(p/'sensor-request.json').write_text(json.dumps({'id': 'a'*32, 'owner': 'b'*32, 'port': 31001}))
            provider = GtaProvider(p, clock=lambda: 1100, start=False)
            try:
                owner = provider.acquire('one')
                with self.assertRaises(RuntimeError):provider.acquire('two')
                body = {'owner': owner['owner'], 'session_id': 'wrong', 'sequence': 1, 'steering': 0, 'throttle': .2, 'brake': 0, 'source_frame': 1}
                with self.assertRaises(ValueError):provider.control(body)
                body['session_id'] = owner['session_id']
                with self.assertRaises(ValueError):provider.control(body)
                provider.frames[1] = {'capture': {'native_frame': 1, 'native_host_ms': 1000}}
                provider.control(body)
                with self.assertRaises(ValueError):provider.control(body)
            finally:provider.close()


if __name__ == '__main__':unittest.main()
