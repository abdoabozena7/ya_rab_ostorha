import unittest
from scripts.audit_hybrid_sensor_coverage import camera_contains


class NominalCameraAuditTests(unittest.TestCase):
    def test_denser_lidar_is_confined_to_the_admitted_or_ticketed_hybrid_rig(self):
        from types import SimpleNamespace as NS
        from unittest.mock import patch
        from backend.carla.sensors import CarlaSensorManager
        api=NS(Location=lambda **values:NS(**values),Rotation=lambda **values:NS(**values),
               Transform=lambda *values:NS(values=values))
        ego=NS(bounding_box=NS(location=NS(x=0.,y=0.),extent=NS(x=2.4,y=.9)))
        for enabled,suppress,expected in ((False,False,(16,32000,-30)),(True,False,(32,128000,-60)),(True,True,(16,32000,-30))):
            manager=CarlaSensorManager(None,ego);manager.actors['collision']=object();plans={}
            manager.spawn=lambda name,blueprint,mount,attrs,decode:plans.update({name:attrs})
            with patch('backend.learning.hybrid_budget.active_ticket',return_value={'validation':True} if enabled else None),\
                 patch('backend.learning.recovery_budget.active_ticket',return_value=None):
                manager.enable_suite(api,.05,{'camera_view':'front','camera_resolution':'640x360',
                    'camera_fov':90,'_suppress_pilot_surround':suppress})
            self.assertEqual(tuple(plans['lidar'][k] for k in ('channels','points_per_second','lower_fov')),expected)
            self.assertEqual(plans['lidar']['rotation_frequency'],20.)
            self.assertEqual('frontLeftDepth' in plans,enabled and not suppress)

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
