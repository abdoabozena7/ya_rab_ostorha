import sys
import unittest
from types import SimpleNamespace as NS
from unittest.mock import Mock,patch
import numpy as np
from backend.computer_vision.detector import RoadDetector


class DetectorFocusTests(unittest.TestCase):
    def test_center_is_always_preserved_and_roadside_phase_replays_from_frame_identity(self):
        detector=RoadDetector.__new__(RoadDetector);detector.size=640;detector.focus_divisor=4
        detector.profile={'id':'YOLOV8S_640_FRONT_AND_FOCUS_V3'};detector._view=Mock(return_value=[])
        self.addCleanup(detector.close)
        rgb=np.broadcast_to(np.arange(1280)[None,:,None],(720,1280,3))
        cv=NS(dnn=NS(NMSBoxes=lambda *args:np.empty(0,dtype=int)))
        with patch.dict(sys.modules,{'cv2':cv}):
            for frame,left in ((42,160),(43,800),(42,160)):
                detector._view.reset_mock();self.assertEqual(detector.predict(rgb,frame_id=frame),[])
                views=[call.args[0]for call in detector._view.call_args_list]
                self.assertEqual(len(views),3)
                self.assertEqual(sum(v.shape==(720,1280,3)for v in views),1)
                self.assertEqual(sorted(int(v[0,0,0])for v in views if v.shape==(320,320,3)),sorted([480,left]))
            with self.assertRaises(ValueError):detector.predict(rgb)
            detector.profile={'id':'YOLOV8S_640_FRONT_AND_FOCUS_V2'};detector._view.reset_mock()
            self.assertEqual(detector.predict(rgb),[]);self.assertEqual(detector._view.call_count,2)

    def test_three_cpu_views_run_concurrently_without_changing_frame_crop_selection(self):
        import threading
        detector=RoadDetector.__new__(RoadDetector);detector.size=640;detector.focus_divisor=4
        detector.profile={'id':'YOLOV8S_640_FRONT_AND_FOCUS_V3'};barrier=threading.Barrier(3)
        self.addCleanup(detector.close)
        def view(_):barrier.wait(timeout=2.);return []
        detector._view=view
        with patch.dict(sys.modules,{'cv2':NS(dnn=NS(NMSBoxes=lambda *args:np.empty(0,dtype=int)))}):
            self.assertEqual(detector.predict(np.zeros((720,1280,3),np.uint8),frame_id=42),[])
