import unittest
from scripts.audit_hybrid_sensor_coverage import camera_contains


class NominalCameraAuditTests(unittest.TestCase):
    def test_urban_comparison_mounts_are_identical_across_native_respawn_noise(self):
        from types import SimpleNamespace as NS
        from backend.carla.sensors import CarlaSensorManager
        api=NS(Location=lambda **values:NS(**values),Rotation=lambda **values:NS(**values),
               Transform=lambda *values:NS(values=values))
        def mounts(noise):
            ego=NS(bounding_box=NS(location=NS(x=-.0025927+noise,y=noise),
                                   extent=NS(x=2.3368195+noise,y=.9059073)))
            manager=CarlaSensorManager(None,ego);manager.actors['collision']=object();plans={}
            manager.spawn=lambda name,blueprint,mount,attrs,decode:plans.update({name:mount})
            manager.enable_suite(api,.05,{'camera_view':'chase','camera_resolution':'800x450',
                'camera_fov':90,'_comparison_rig':True,'_urban_rig':True})
            return {name:[vars(value) for value in mount.values] for name,mount in plans.items()
                    if name.startswith(('frontLeft','frontRight','rearLeft','rearRight'))}
        baseline=mounts(0.)
        self.assertEqual(len(baseline),8)
        self.assertEqual(baseline,mounts(.0000008))
        self.assertNotEqual(baseline,mounts(.001))

    def test_denser_lidar_is_confined_to_the_admitted_or_ticketed_hybrid_or_route_bypass_rig(self):
        from types import SimpleNamespace as NS
        from unittest.mock import patch
        from backend.carla.sensors import CarlaSensorManager
        api=NS(Location=lambda **values:NS(**values),Rotation=lambda **values:NS(**values),
               Transform=lambda *values:NS(values=values))
        ego=NS(bounding_box=NS(location=NS(x=0.,y=0.),extent=NS(x=2.4,y=.9)))
        for enabled,bypass,suppress,expected in ((False,False,False,(16,32000,-30)),
                (True,False,False,(32,128000,-60)),(True,False,True,(16,32000,-30)),
                (False,True,False,(32,128000,-60)),(False,True,True,(16,32000,-30))):
            manager=CarlaSensorManager(None,ego);manager.actors['collision']=object();plans={}
            manager.spawn=lambda name,blueprint,mount,attrs,decode:plans.update({name:attrs})
            with patch('backend.learning.hybrid_budget.active_ticket',return_value={'validation':True} if enabled else None),\
                 patch('backend.learning.recovery_budget.active_ticket',return_value=None),\
                 patch('backend.core.route_bypass.available',return_value=bypass):
                manager.enable_suite(api,.05,{'camera_view':'front','camera_resolution':'640x360',
                    'camera_fov':90,'_suppress_pilot_surround':suppress})
            self.assertEqual(tuple(plans['lidar'][k] for k in ('channels','points_per_second','lower_fov')),expected)
            self.assertEqual(plans['lidar']['rotation_frequency'],20.)
            self.assertEqual('frontLeftDepth' in plans,(enabled or bypass) and not suppress)

    def calibration(self,yaw=0.,position=None):
        return {'width':240,'height':135,'fov_deg':120.,'mount_transform':{
            'position_m':position or [0.,0.,1.],'rotation_deg':{'roll':0.,'pitch':0.,'yaw':yaw}}}

    def test_nominal_projection_respects_mount_direction_and_image_edges(self):
        forward=self.calibration()
        self.assertTrue(camera_contains([4.,0.,1.],forward))
        self.assertFalse(camera_contains([-1.,0.,1.],forward))
        self.assertFalse(camera_contains([4.,9.,1.],forward))
        self.assertFalse(camera_contains([4.,0.,20.],forward))
        side=self.calibration(90.,[0.,1.,1.])
        self.assertTrue(camera_contains([0.,3.,1.],side))
        self.assertFalse(camera_contains([0.,-3.,1.],side))


if __name__=='__main__':unittest.main()
