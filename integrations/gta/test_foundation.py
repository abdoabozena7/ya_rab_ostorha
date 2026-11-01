import copy
import json
from pathlib import Path
import sys
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[2]))
from backend.gta.foundation import FoundationCalibration
from backend.gta.provider import guarded_command
from backend.gta.provider import latest_json
from integrations.gta.test_live_provider import geometry,observation


class FoundationBoundaries(unittest.TestCase):
    def test_startup_waits_for_native_trace_and_capture(self):
        sys.path.insert(0,str(Path(__file__).resolve().parent))
        from live_probe import startup_evidence_ready
        native=[{'stage':'FOUNDATION_CALIBRATION'}]*10
        self.assertFalse(startup_evidence_ready({'serial':19},native))
        self.assertFalse(startup_evidence_ready({'serial':20},native[:9]))
        self.assertTrue(startup_evidence_ready({'serial':20},native))

    def test_window_evidence_must_be_visible_window_and_recent(self):
        import tempfile,time
        from integrations.gta.foundation_acceptance import window_screenshot_is_current
        with tempfile.TemporaryDirectory() as tmp:
            shot=Path(tmp)/'screen.png';shot.write_bytes(b'evidence')
            window={'desktop':[1536,864],'observed_wall_s':time.time(),
                    'windows':[{'style':0x00C00000,'rect':[20,20,802,540]}]}
            self.assertTrue(window_screenshot_is_current(window,shot))
            self.assertFalse(window_screenshot_is_current({**window,'windows':[]},shot))
            self.assertFalse(window_screenshot_is_current({**window,'observed_wall_s':time.time()-60},shot))
            self.assertFalse(window_screenshot_is_current(window,shot.parent/'missing.png'))

    def test_startup_input_provenance_fails_closed(self):
        from collections import deque
        from integrations.gta.foundation_acceptance import InputProvenance
        probe=object.__new__(InputProvenance)
        probe.recent=deque([{'tick':42,'kind':'mouse','injected':True,'targeted_game':True}])
        self.assertEqual(probe.classify(42),'injected')
        self.assertEqual(probe.classify(43),'physical_or_unknown')
        probe.recent.append({'tick':41,'kind':'mouse','injected':False,'targeted_game':False})
        self.assertEqual(probe.classify(41),'outside_game')
        probe.recent.append({'tick':42,'kind':'mouse','injected':False,'targeted_game':True})
        self.assertEqual(probe.classify(42),'physical_or_unknown')

    def test_pretty_metadata_and_partial_jsonl_never_return_a_string_as_state(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            file=Path(tmp)/'observed.json'
            file.write_text(json.dumps({'saved_views':['CAM_FRONT','CAM_REAR']},indent=2))
            self.assertEqual(latest_json(file)['saved_views'],['CAM_FRONT','CAM_REAR'])
            stream=Path(tmp)/'bridge.jsonl'
            stream.write_text('{"frame":4}\n"not-state"\n{"incomplete":')
            self.assertEqual(latest_json(stream),{'frame':4})
    def test_reverse_requires_completed_rear_scan_and_fresh_sources(self):
        calibration=FoundationCalibration();calibration.started=1000
        g=geometry();o=observation()
        for key in ('native_ms','capture_ms','geometry_ms'):o[key]=35000
        good=calibration.step(o,g,35000)
        self.assertEqual(good['packet_type'],2);self.assertGreater(good['throttle'],0)
        for fault in ('missing','pending','near'):
            data=geometry();index=next(i for i,r in enumerate(data['rays']) if r[0]==180)
            if fault=='missing':data['rays'].pop(index)
            elif fault=='pending':data['rays'][index][2]=1
            else:data['rays'][index][3:5]=[1,1.]
            self.assertEqual(calibration.step(o,data,35000)['brake'],1.)
        o['capture_ms']=30000
        self.assertEqual(calibration.step(o,g,35000)['brake'],1.)

    def test_camera_phase_is_braked_and_has_no_route_or_human_recorder(self):
        calibration=FoundationCalibration();calibration.started=1000
        o=observation()
        for delta,kind in ((0,10),(5000,11),(10000,12),(15000,13)):
            out=calibration.step(o,geometry(),1000+delta)
            self.assertEqual((out['packet_type'],out['throttle'],out['brake']),(kind,0.,1.))
        self.assertFalse(calibration.latest['training']);self.assertFalse(calibration.latest['human_recording'])

    def test_missing_capture_does_not_start_calibration(self):
        calibration=FoundationCalibration();o=observation();o['depth_valid']=False
        out=calibration.step(o,geometry(),1000)
        self.assertIsNone(calibration.started);self.assertEqual(out['throttle'],0.)


if __name__=='__main__':unittest.main()
