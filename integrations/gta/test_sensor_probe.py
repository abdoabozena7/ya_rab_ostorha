import tempfile
from pathlib import Path
import unittest
import hashlib
import numpy as np
import sensor_probe as gate


class SensorTests(unittest.TestCase):
    def test_command_abi_and_invalid_owner_controls(self):
        self.assertEqual(len(gate.packet('a'*32,1,1000)),69)
        for changes in ({'owner':'foreign'},{'sequence':0},{'throttle':2},{'steer':float('nan')}):
            values={'owner':'a'*32,'sequence':1,'deadline':1000};values.update(changes)
            with self.assertRaises(ValueError):gate.packet(**values)

    def test_unscoped_output_rejected(self):
        with self.assertRaisesRegex(ValueError,'Outside'):gate.output_path(Path(tempfile.gettempdir()))

    def test_unknown_depth_does_not_become_free(self):
        with tempfile.TemporaryDirectory() as directory:
            p=Path(directory)/'depth'
            for value in (0.,1.,float('nan')):
                np.full((360,640),value,np.float32).tofile(p)
                with self.assertRaisesRegex(ValueError,'Unknown'):gate.depth_value(p,.5,.5)
            np.full((360,640),.1,np.float32).tofile(p)
            self.assertAlmostEqual(gate.depth_value(p,.5,.5),.1,places=6)

    def test_contact_flag_alone_is_not_physical_contact(self):
        values=[{'stage':'COLLISION','contact':True,'body_health':1000.,'speed_mps':5.,'ped_alive':1,'target_contact':0} for _ in range(4)]
        self.assertFalse(gate.physical_contact(values))
        values[-1].update(body_health=900.,speed_mps=0.)
        self.assertFalse(gate.physical_contact(values))
        values[-1]['target_contact']=1
        self.assertTrue(gate.physical_contact(values))
        values[-1]['ped_alive']=0;self.assertFalse(gate.physical_contact(values))

    def test_empty_native_measurements_are_not_accepted(self):
        with tempfile.TemporaryDirectory() as d:
            result=gate.evaluate(Path(d),{1},'test')
            self.assertFalse(result['sensor_probe_accepted']);self.assertFalse(result['camera_accepted'])

    def test_owned_cleanup_preserves_changed_file(self):
        with tempfile.TemporaryDirectory() as directory:
            p=Path(directory)/'owned.ini';p.write_bytes(b'changed')
            with self.assertRaisesRegex(ValueError,'changed'):gate.remove_owned(p,hashlib.sha256(b'original').hexdigest())
            self.assertEqual(p.read_bytes(),b'changed')
            gate.remove_owned(p,hashlib.sha256(b'changed').hexdigest());self.assertFalse(p.exists())


if __name__=='__main__':unittest.main()
