"""Meaningful failure controls for the asynchronous GTA boundary."""
import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
import numpy as np
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from backend.gta.goal import measured_points, route_context, AsyncScene
from backend.gta.provider import GtaProvider


def scan():
    return {'rays': [[a, e, 2, 0, 100., 0, 0, 0, 12345] for a in range(0, 360, 3)
                     for e in (-65, -45, -35, -25, -15, -8, -3, 0, 6)],
            'position': [0, 0, 0], 'forward': [1, 0, 0], 'right': [0, 1, 0],
            'up': [0, 0, 1], 'origin_world': [0, 0, 1.1]}


class GoalBoundaries(unittest.TestCase):
    def test_no_hit_is_not_a_fabricated_free_surface(self):
        points, origin = measured_points(scan())
        self.assertEqual(points.shape, (0, 3))
        self.assertEqual(origin.tolist(), [0, 0, 1.1])

    def test_reverse_swept_body_unknown_and_low_rear_obstacle_are_blocked(self):
        from backend.core.maneuver import ObservedSpace
        from backend.core.motion_geometry import VehicleGeometry
        from backend.core.maneuver_candidates import signed_path
        geometry = VehicleGeometry(front_m=1.8, rear_m=1.8, half_width_m=.9)
        path = signed_path(.8, 0., 0., geometry, reverse=True, bounded=True)
        for returns in (np.empty((0, 3)), np.array([[-2.8, 0., .3], [-3., .3, .3], [-3., -.3, .3]])):
            space = ObservedSpace(returns, geometry)
            self.assertFalse(space.certificate(path)['verified'])

    def test_unknown_rear_and_incomplete_scan_rejected(self):
        for mutate in (lambda s: s['rays'].pop(), lambda s: s['rays'][540].__setitem__(2, 1),
                       lambda s: s['rays'][540].__setitem__(4, float('nan')),
                       lambda s: s['rays'].__setitem__(540, s['rays'][541])):
            s = scan();mutate(s)
            with self.assertRaises(ValueError):measured_points(s)

    def test_completed_real_return_transformed_without_actor_handle(self):
        s = scan();s['rays'][540] = [180, -65, 2, 1, 3., -3., 0, -.2, 12345]
        points, _ = measured_points(s)
        self.assertEqual(points.tolist(), [[-3., 0, -.2]])

    def test_asynchronous_scene_cannot_renew_old_simulation_or_host_age(self):
        from types import SimpleNamespace
        s = AsyncScene('s', SimpleNamespace(timestamp_s=10.), None, None, None, None, 100., 0., 10.05)
        self.assertTrue(s.usable(10.05, 100.2))
        self.assertFalse(s.usable(10.2, 100.2))
        self.assertFalse(s.usable(10.05, 100.3))
        s.latest_game_s = 10.5
        self.assertFalse(s.usable(10.05, 100.2))

    def test_route_is_a_real_length_prior_not_a_short_prefix(self):
        r = {'points': [[x, 0, 0] for x in range(0, 701, 5)]}
        road, progress = route_context(r, scan(), 's')
        self.assertEqual(road['remaining_m'], 700.)
        self.assertEqual(progress, 0.)
        r['points'] = r['points'][:10]
        with self.assertRaises(ValueError):route_context(r, scan(), 's')

    def test_transient_writer_lock_preserves_original_age_not_freshness(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp);(p/'sensor-request.json').write_text(json.dumps({'id': 'a'*32, 'owner': 'b'*32, 'port': 31001}))
            provider = GtaProvider(p, clock=lambda: 1600, start=False)
            provider.last_native = {'run_id': 'a'*32, 'pid': 4, 'frame': 3, 'host_ms': 1000, 'ped_alive': 1}
            provider.geometry = {'run_id': 'a'*32, 'pid': 4, 'host_ms': 1000, 'rays': []}
            try:
                with patch('backend.gta.provider.latest_json', return_value=None):provider._refresh()
                self.assertEqual(provider.geometry['host_ms'], 1000)
                self.assertEqual(provider._observation(1600)['geometry_ms'], 1000)
            finally:provider.close()


if __name__ == '__main__':unittest.main()
