"""Measured-point contract fixtures; these implement no vehicle physics."""
from dataclasses import replace
import unittest
import numpy as np
from backend.core.contracts import SensorKind
from backend.core.safety_policy import sensor_observation
from backend.rl.radar import foreground_index, RADAR_FEATURES, validate_radar_calibration
from backend.rl.observations import ObservationAssembler, CONFIGS
from backend.rl.supervisor import policy_features
from tests.test_rl import policy_fixture


class RadarFeatureTests(unittest.TestCase):
    def test_ground_screening_preserves_measured_foreground_values(self):
        ground=[5.,0.,np.arcsin(-.65/5),-8.]
        leader=[13.,.02,0.,-3.]
        points=np.array([ground,leader],np.float32)
        self.assertEqual(foreground_index(points),1)
        np.testing.assert_array_equal(points[1],np.array(leader,np.float32))
        self.assertIsNone(foreground_index(points[:1]))

    def test_cone_height_edges_no_return_and_invalid_data(self):
        self.assertIsNone(foreground_index(np.empty((0,4),np.float32)))
        self.assertIsNone(foreground_index(np.array([[5.,.12,0.,-1.]])))
        self.assertIsNone(foreground_index(np.array([[5.,0.,.15,-1.]])))
        angle=np.arcsin((RADAR_FEATURES.minimum_height_m-.65)/5.)
        self.assertIsNone(foreground_index(np.array([[5.,0.,angle-1e-5,-1.]])))
        self.assertEqual(foreground_index(np.array([[5.,0.,angle+1e-5,-1.]])),0)
        for points in (np.array([[np.nan,0,0,0]]),np.array([[-1.,0,0,0]]),np.array([1,2,3,4])):
            with self.assertRaises(ValueError):foreground_index(points)

    def test_local_mount_is_required_world_pose_cannot_replace_calibration(self):
        expected={'mount_transform':{'position_m':[2.5,0.,.65],
            'rotation_deg':{'roll':0.,'pitch':0.,'yaw':0.}}}
        validate_radar_calibration(expected)
        for calibration in ({},{'transform':expected['mount_transform']},
                {'mount_transform':{'position_m':[2.5,0.,1.5], 'rotation_deg':{'roll':0.,'pitch':0.,'yaw':0.}}}):
            with self.assertRaises(ValueError):validate_radar_calibration(calibration)
        frame=policy_fixture()
        radar=next(s for s in frame.sensors if s.kind==SensorKind.RADAR)
        bad=replace(radar,metadata={})
        changed=replace(frame,sensors=tuple(bad if s.kind==SensorKind.RADAR else s for s in frame.sensors))
        with self.assertRaises(ValueError):
            ObservationAssembler(CONFIGS['lightweight'],lambda _:None).append(sensor_observation(changed),[0,0,0])

    def test_47_shape_no_foreground_indicator_and_privileged_isolation(self):
        frame=policy_fixture()
        raw=ObservationAssembler(CONFIGS['lightweight'],lambda _:None).append(sensor_observation(frame),[0,0,0])
        f=policy_features(raw,[.01,.4,0.])
        self.assertEqual(f.shape,(47,));self.assertTrue(np.isfinite(f).all())
        self.assertEqual(f[3*11+9],0.)
        with self.assertRaises(ValueError):policy_features({**raw,'ground_truth':{}},[.01,.4,0.])
        other=replace(frame,ground_truth=None,actors=())
        clean=ObservationAssembler(CONFIGS['lightweight'],lambda _:None).append(sensor_observation(other),[0,0,0])
        np.testing.assert_array_equal(f,policy_features(clean,[.01,.4,0.]))

    def test_pitch_compensation_uses_spanning_measured_ground(self):
        body=np.array([[x,y,.1*x] for x,y in ((6.,-.1),(7.,.15),(8.,-.2),
            (9.,.1),(10.,-.15),(11.,.2),(12.,0.))]+[[15.,0.,2.3]])
        local=body-np.array([2.5,0.,.65])
        depth=np.linalg.norm(local,axis=1)
        points=np.column_stack((depth,np.arctan2(local[:,1],local[:,0]),
            np.arcsin(local[:,2]/depth),np.full(len(depth),-8.)))
        self.assertEqual(foreground_index(points),7)
        with self.assertRaises(ValueError):foreground_index(np.tile(points,(5,1)))


if __name__=='__main__':unittest.main()
