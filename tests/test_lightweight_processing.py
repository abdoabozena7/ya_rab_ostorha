"""Interpretation boundaries and presentation sensor presets; no model imports."""
import unittest
from backend.nlp.processor import interpret
from backend.graphics import PRESETS, camera
class LightweightTests(unittest.TestCase):
    def test_text_provenance_and_speed_limit_are_preserved(self):
        value=interpret('  speed  limit: 30  ',.92)
        self.assertEqual(value['raw_text'],'  speed  limit: 30  ')
        self.assertEqual(value['tokens'],['SPEED','LIMIT','30'])
        self.assertEqual((value['instruction'],value['value']),('SPEED_LIMIT',30))
        self.assertEqual(value['confidence'],.92)
    def test_low_confidence_and_implausible_limits_do_not_become_instructions(self):
        self.assertEqual(interpret('STOP',.2)['instruction'],'UNCLASSIFIED')
        self.assertEqual(interpret('speed limit 999',.95)['instruction'],'UNCLASSIFIED')
        self.assertEqual(interpret('CAR 30',.95)['instruction'],'UNCLASSIFIED')
    def test_presets_use_only_native_qualities_and_keep_motion_blur_zero(self):
        self.assertEqual({v['quality'] for v in PRESETS.values()},{'Low','Epic'})
        self.assertEqual(camera('LOW')['camera_resolution'],'640x360')
        self.assertEqual(camera('ULTRA')['camera_resolution'],'1280x720')
        self.assertTrue(all(camera(p)['camera_motion_blur']==0 for p in PRESETS))
if __name__=='__main__':unittest.main()
