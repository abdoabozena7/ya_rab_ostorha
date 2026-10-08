"""Radar measurement/contract tests. No vehicle physics or fake native runs."""
from dataclasses import replace
import unittest
import numpy as np
from backend.core.contracts import SensorKind
from backend.core.safety_policy import sensor_observation
from backend.rl.radar import foreground_index, measured_heights
from backend.rl.radar_retention import retention_indices, retain_detections, retained_radar_observation
from backend.rl.observations import ObservationAssembler, CONFIGS
from backend.rl.supervisor import policy_features
from tests.test_rl import policy_fixture


def measured_points(locations):
    local = np.asarray(locations)-[2.5, 0., .65]
    depth = np.linalg.norm(local, axis=1)
    return np.column_stack((depth, np.arctan2(local[:, 1], local[:, 0]),
                            np.arcsin(local[:, 2]/depth), np.full(len(depth), -5.))).astype(np.float32)


class RadarRetentionTests(unittest.TestCase):
    def test_far_foreground_is_not_lost_behind_nearer_road(self):
        ground = [(x, (i%3-1)*.2, 0.) for i,x in enumerate(np.linspace(6, 16, 40))]
        points = measured_points(ground+[(24.,0.,1.), (25.,.2,1.2)])
        old = np.argsort(points[:,0],kind='stable')[:32]
        self.assertIsNone(foreground_index(points[old]))
        keep = retention_indices(points)
        self.assertIn(40,keep);self.assertIn(41,keep)
        self.assertTrue(np.all(np.diff(points[keep,0])>=0))
        self.assertEqual(len(set(keep)),32)
        self.assertIn(int(keep[foreground_index(points[keep])]),(40,41))

    def test_foreground_coverage_includes_other_bearings_not_one_lead(self):
        points = measured_points([(6+i*.2,(i%3-1)*.1,0.) for i in range(40)] +
            [(17+i*.1,0.,1.) for i in range(24)] + [(20.,-3.,1.),(21.,3.,1.)])
        keep = retention_indices(points)
        self.assertIn(64,keep);self.assertIn(65,keep)
        self.assertIn(40,keep)

    def test_ground_plane_support_and_missing_foreground_remain_explicit(self):
        points = measured_points([(x,(i%3-1)*.2,.08*x) for i,x in enumerate(np.linspace(6,24,42))])
        keep = retention_indices(points)
        self.assertTrue(measured_heights(points[keep])[1])
        self.assertIsNone(foreground_index(points[keep]))
        self.assertEqual(len(retention_indices(np.empty((0,4)))),0)
        np.testing.assert_array_equal(retention_indices(points[:5]),np.argsort(points[:5,0],kind='stable'))

    def test_plane_refactor_preserves_original_measured_screen(self):
        points = measured_points([(x,(i%3-1)*.2,.08*x) for i,x in enumerate(np.linspace(6,20,31))]+[(24.,0.,3.)])
        self.assertEqual(foreground_index(points),31)

    def test_working_nearest_set_is_preserved_not_reclassified_by_new_voters(self):
        points = measured_points([(6+i*.2,(i%3-1)*.1,0.) for i in range(40)]+[(8.,0.,1.)])
        order = np.argsort(points[:,0],kind='stable')[:32]
        self.assertIsNotNone(foreground_index(points[order]))
        np.testing.assert_array_equal(retention_indices(points),order)

    def test_measurements_and_contract_are_preserved_without_privileged_inputs(self):
        frame = policy_fixture();observation = sensor_observation(frame)
        radar = next(s for s in observation.channels if s.kind==SensorKind.RADAR)
        points = measured_points([(6+i*.2,(i%3-1)*.1,0.) for i in range(40)]+[(24.,0.,1.)])
        detections = tuple(dict(zip(('depth_m','azimuth_rad','altitude_rad','velocity_mps'),map(float,p))) for p in points)
        radar = replace(radar,data={'detections':detections})
        observation = replace(observation,channels=tuple(radar if s.kind==SensorKind.RADAR else s for s in observation.channels))
        adapted = retained_radar_observation(observation)
        selected = next(s for s in adapted.channels if s.kind==SensorKind.RADAR)
        self.assertTrue(all(any(d == original for original in detections) for d in selected.data['detections']))
        self.assertEqual(selected.frame_id,radar.frame_id);self.assertEqual(selected.calibration,radar.calibration)
        raw = ObservationAssembler(CONFIGS['lightweight'],lambda _:None).append(observation,[0,0,0])
        np.testing.assert_array_equal(raw['radar'][-1],np.array([list(d.values()) for d in selected.data['detections']],np.float32))
        self.assertEqual(policy_features(raw,[0,.7,0]).shape,(47,))
        with self.assertRaises(ValueError):retained_radar_observation(frame)
        with self.assertRaises(ValueError):
            replace(radar,data={'detections':[dict(detections[0],actor_id=123)]})

    def test_invalid_points_are_rejected_not_padded_as_valid(self):
        for points in (np.array([[np.nan,0,0,0]]),np.array([[-1,0,0,0]]),np.array([[2,4,0,0]])):
            with self.assertRaises(ValueError):retention_indices(points)
        with self.assertRaises(ValueError):retention_indices(np.empty((0,4)),4)


if __name__=='__main__':unittest.main()
