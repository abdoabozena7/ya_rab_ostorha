import importlib.util
import unittest
from unittest.mock import Mock
import numpy as np
from backend.computer_vision.detector import RoadDetector


@unittest.skipUnless(importlib.util.find_spec('cv2'),'OpenCV is optional in the control environment')
class DetectionQualityTests(unittest.TestCase):
    def test_uncertain_lead_candidate_is_retained_without_supporting_a_false_signal(self):
        detector=RoadDetector.__new__(RoadDetector);detector.input='images';detector.model=Mock()
        output=np.zeros((1,84,4),np.float32)
        output[0,:4,:]=np.array([[160,265,232,40],[164,190,116,110],
            [21,90,17,10],[21,60,36,20]])
        output[0,6,0]=.28;output[0,6,1]=.9
        output[0,13,2]=.394;output[0,13,3]=.8
        detector.model.run.return_value=[output]
        detections=detector.predict(np.zeros((180,320,3),np.uint8))
        cars=[row for row in detections if row['class']=='car']
        lead=next(row for row in cars if row['confidence']<.65)
        self.assertEqual(lead['classification_status'],'UNCERTAIN')
        np.testing.assert_allclose(lead['xyxy'],[149.5,83.5,170.5,104.5])
        lights=[row for row in detections if row['class']=='traffic light']
        self.assertEqual(len(lights),1)
        self.assertGreater(lights[0]['confidence'],.65)
        self.assertEqual(lights[0]['classification_status'],'SUPPORTED')
