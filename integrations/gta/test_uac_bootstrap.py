"""Fail before any UAC/launch for expired, changed or out-of-scope requests."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import uac_bootstrap as gate


class UacTests(unittest.TestCase):
    def test_unscoped_output_rejected(self):
        with self.assertRaisesRegex(ValueError,'actual scoped proof run'):
            gate.validate_output(Path(tempfile.gettempdir())/'anything')

    def request_case(self,changes=None):
        directory=tempfile.TemporaryDirectory();self.addCleanup(directory.cleanup)
        output=Path(directory.name)
        data={'schema':1,'operation':'OWNER_GTA_UAC_BOOTSTRAP','id':'a'*32,
              'controller_elevated':False,'false_positive_proven':False,'deadline':200,
              'source_hashes':{s:'hash' for s in gate.SOURCES},'launcher_sha256':'hash'}
        data.update(changes or {})
        path=output/'uac-request.json';path.write_text(json.dumps(data))
        return path,output

    def test_expired_request_rejected_before_any_elevation(self):
        path,output=self.request_case({'deadline':99})
        with patch.object(gate,'validate_output',return_value=output):
            with self.assertRaisesRegex(ValueError,'expired'):gate.validate_request(path,now=100)

    def test_extra_source_is_not_an_arbitrary_command(self):
        path,output=self.request_case({'source_hashes':{'arbitrary.ps1':'hash'}})
        with patch.object(gate,'validate_output',return_value=output):
            with self.assertRaisesRegex(ValueError,'broadened'):gate.validate_request(path,now=100)

    def test_source_drift_rejected(self):
        path,output=self.request_case()
        with patch.object(gate,'validate_output',return_value=output),patch.object(gate.bootstrap,'digest',return_value='changed'):
            with self.assertRaisesRegex(ValueError,'source changed'):gate.validate_request(path,now=100)

    def test_matching_request_shape(self):
        path,output=self.request_case()
        with patch.object(gate,'validate_output',return_value=output),patch.object(gate.bootstrap,'digest',return_value='hash'):
            self.assertEqual(gate.validate_request(path,now=100)[0],output)


if __name__=='__main__':unittest.main()
