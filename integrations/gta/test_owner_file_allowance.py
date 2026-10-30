"""Exercise the actual PowerShell validator without elevation or mutation."""
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
import uuid

HERE=Path(__file__).resolve().parent
HELPER=HERE/'owner_file_allowance.ps1'


class AllowanceTests(unittest.TestCase):
    def request(self):
        return {'schema':1,'operation':'OWNER_THREE_FILE_ALLOWANCE','request_id':uuid.uuid4().hex,
                'helper_sha256':hashlib.sha256(HELPER.read_bytes()).hexdigest(),
                'targets':[str(Path(r'D:\games\Grand Theft Auto V Enhanced')/name) for name in ('RUNE64.dll','PlayGTAV.exe','version.dll')],
                'false_positive_proven':False}

    def validate(self,request):
        with tempfile.TemporaryDirectory(prefix='allowance-fixture-',dir=HERE/'.runtime-proof') as directory:
            root=Path(directory).resolve()
            self.assertTrue(root.is_relative_to((HERE/'.runtime-proof').resolve()))
            path=root/'request.json';path.write_text(json.dumps(request))
            return subprocess.run(['powershell.exe','-NoProfile','-File',str(HELPER),
                '-OutputDirectory',str(root),'-RequestPath',str(path),'-ValidateOnly'],capture_output=True,text=True,timeout=15)

    def test_exact_files_validate_without_mutation(self):
        result=self.validate(self.request())
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertIn('VALIDATED_NO_MUTATION',result.stdout)

    def test_folder_scope_rejected(self):
        request=self.request();request['targets'][0]=r'D:\games\Grand Theft Auto V Enhanced'
        result=self.validate(request)
        self.assertNotEqual(result.returncode,0)
        self.assertIn('Path outside approved file scope',result.stderr)

    def test_extra_file_rejected(self):
        request=self.request();request['targets'].append(r'C:\other.exe')
        result=self.validate(request)
        self.assertNotEqual(result.returncode,0)
        self.assertIn('Scope must contain exactly three approved files',result.stderr)

    def test_relative_path_rejected(self):
        request=self.request();request['targets'][0]='RUNE64.dll'
        result=self.validate(request)
        self.assertNotEqual(result.returncode,0)
        self.assertIn('Path outside approved file scope',result.stderr)

    def test_altered_helper_rejected(self):
        request=self.request();request['helper_sha256']='0'*64
        result=self.validate(request)
        self.assertNotEqual(result.returncode,0)
        self.assertIn('Helper source hash mismatch',result.stderr)


if __name__=='__main__':unittest.main()
