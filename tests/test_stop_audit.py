import unittest
from scripts.audit_driving_stops import obstruction_evidence


class StopAuditTests(unittest.TestCase):
    def test_native_presence_screen_keeps_unknown_and_side_returns_distinct(self):
        vehicle={'transform':{'rotation_rad':{'yaw':0.}}}
        geometry={'half_width_m':1.,'front_m':2.5}
        def actor(actor_id,position):
            return {'actor_id':actor_id,'relative_position_m':position,'yaw_deg':0.,
                'category':'VEHICLE','type':'vehicle.test',
                'bounding_box':{'extent_m':[2.,1.,1.],'offset_m':[0.,0.,0.]}}
        oracle={'actors':[actor(1,[10.,0.,0.]),actor(2,[8.,4.,0.]),actor(3,[-8.,0.,0.])
            ,actor(4,[50.,0.,0.]),{**actor(5,[8.,0.,0.]),'bounding_box':None}]}
        result=obstruction_evidence(oracle,vehicle,geometry)
        self.assertEqual([item['actor_id'] for item in result],[1])
        self.assertEqual(result[0]['bumper_gap_m'],5.5)

    def test_rotated_native_box_uses_its_projected_forward_extent(self):
        vehicle={'transform':{'rotation_rad':{'yaw':0.}}};geometry={'half_width_m':1.,'front_m':2.5}
        actor={'actor_id':1,'relative_position_m':[10.,0.,0.],'yaw_deg':90.,'category':'VEHICLE',
            'type':'vehicle.test','bounding_box':{'extent_m':[2.,1.,1.],'offset_m':[0.,0.,0.]}}
        result=obstruction_evidence({'actors':[actor]},vehicle,geometry)
        self.assertAlmostEqual(result[0]['bumper_gap_m'],6.5)
