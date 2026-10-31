import tempfile
from pathlib import Path
import unittest
import numpy as np
import vision_probe as gate


class VisionTests(unittest.TestCase):
    def test_unscoped_output_is_rejected(self):
        with self.assertRaisesRegex(ValueError,'dedicated vision'):gate.scoped_output(Path('.'))

    def test_empty_or_peripheral_detections_are_not_central_vehicle(self):
        self.assertIsNone(gate.center_vehicle([]))
        self.assertIsNone(gate.center_vehicle([{'class':'car','confidence':.9,'xyxy':[1,1,20,20]}]))

    def test_unpinned_image_is_rejected(self):
        with self.assertRaisesRegex(ValueError,'Unpinned'):gate.raw_bytes(Path('.'),{'raw_hashes':{}},'foreign.rgb')

    def test_wrong_raw_hash_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            p=Path(directory);(p/'input.rgb').write_bytes(b'changed')
            with self.assertRaisesRegex(ValueError,'hash mismatch'):gate.raw_bytes(p,{'raw_hashes':{'input.rgb':'wrong'}},'input.rgb')

    def test_missing_depth_is_not_metric_history(self):
        for value in (0.,1.,float('nan')):
            with self.assertRaisesRegex(ValueError,'Unknown'):
                gate.metric_position({'near':.15,'far':10000},[300,160,340,200],np.full(640*360,value,np.float32),
                                     {'fov':60,'heading_deg':0,'camera':[0,0,1.5]})


if __name__=='__main__':unittest.main()
