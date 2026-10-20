from unittest import TestCase
import numpy as np
from types import SimpleNamespace as NS
from backend.computer_vision.depth_evidence import attach_depth
from backend.core.control_semantics import SemanticAssociator


class SemanticDepthTests(TestCase):
    def test_walking_leg_background_gaps_do_not_discard_the_measured_torso(self):
        image=np.full((180,320),80.)
        image[70:95,107:114]=20. # torso; the lower centre contains the gap between legs
        row={'class':'person','xyxy':[100.,50.,120.,130.]}
        attach_depth([row],image,42,2.1)
        proof=row['depth_evidence']
        self.assertEqual(proof['axial_m'],20.);self.assertEqual(proof['region'],'TORSO')
        self.assertLess(proof['pixel_center_depth'][1],95.)
        self.assertEqual(proof['depth_resolution'],[320,180])

    def test_depth_comes_from_the_detected_body_and_keeps_frame_identity(self):
        depth=np.full((100,100),40.,dtype=float);depth[30:71,44:57]=8.
        detection={'class':'person','xyxy':[30,10,70,90]}
        attach_depth([detection],depth,42,2.1)
        self.assertEqual(detection['depth_evidence']['axial_m'],8.)
        self.assertEqual(detection['depth_evidence']['frame_id'],42)

    def test_missing_or_discontinuous_depth_does_not_become_range_evidence(self):
        for depth in (np.full((100,100),np.nan),np.tile([2.,40.],(100,50))):
            detection={'class':'person','xyxy':[30,10,70,90]}
            attach_depth([detection],depth,42,2.1)
            self.assertNotIn('depth_evidence',detection)

    def test_distant_surface_in_the_same_image_box_cannot_take_the_person_label(self):
        calibration={'width':320,'height':180,'fov_deg':90.,
            'mount_transform':{'position_m':[0.,0.,1.],'rotation_deg':{}}}
        obs=NS(timestamp_s=1.,frame_id=20,channels=[NS(sensor_id='frontCamera',calibration=calibration)])
        tracks=[{'id':str(i),'history':[[0.,x,y,0.,0.],[1.,x,y,0.,0.]]} for i,(x,y) in enumerate(((8.,2.),(20.,5.)))]
        result={'session_id':'s','status':'RUNNING','frame_id':10,'timestamp_s':.5,'detections':[
            {'class':'person','confidence':.9,'xyxy':[190,70,210,110],
             'depth_evidence':{'frame_id':10,'timestamp_s':.5,'axial_m':8.}}]}
        SemanticAssociator().apply({'session_id':'s','tracks':tracks},obs,[[0,0,0,0,0],[1,0,0,0,20]],result)
        self.assertEqual(tracks[0]['class'],'person');self.assertEqual(tracks[1]['class'],'UNKNOWN')
