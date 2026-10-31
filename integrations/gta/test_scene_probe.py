import tempfile
from pathlib import Path
import unittest
import scene_probe as scene


class SceneControls(unittest.TestCase):
    def test_pending_and_failed_do_not_clear_space(self):
        for status in (0,1):self.assertFalse(scene.known_ray([0,0,status,0,100,0,0,0,0]))
    def test_nonfinite_and_wrong_nohit_range_are_unknown(self):
        self.assertFalse(scene.known_ray([0,0,2,1,float('nan'),0,0,0,1]))
        self.assertFalse(scene.known_ray([0,0,2,0,0,0,0,0,0]))
    def test_only_completed_measured_hit_or_max_range_line_is_known(self):
        self.assertTrue(scene.known_ray([0,0,2,1,20,0,20,0,1]))
        self.assertTrue(scene.known_ray([0,0,2,0,100,0,0,0,0]))
    def test_empty_runtime_evidence_fails_all_capabilities(self):
        with tempfile.TemporaryDirectory() as directory:
            r=scene.evaluate(Path(directory),set(),'x')
            for key in ('sensor_probe_accepted','field_accepted','rays_accepted','motion_accepted','live_vision_accepted'):self.assertFalse(r[key])
    def test_unscoped_output_is_rejected(self):
        with self.assertRaises(ValueError):scene.output_path(Path('.'))
    def test_cpu_fallback_or_repeated_frames_cannot_qualify_live_gpu(self):
        rows=[{'serial':i,'execution_provider':'CPUExecutionProvider','stage':('MOVE_AWAY','MOVE_APPROACH','PED_CROSS')[i%3],
               'detections':[{'class':'bus'}]} for i in range(40)]
        self.assertFalse(scene.live_qualified(rows))
        for r in rows:r.update(serial=1,execution_provider='DmlExecutionProvider')
        self.assertFalse(scene.live_qualified(rows))


if __name__=='__main__':unittest.main()
