import io
import unittest
import zipfile
import tempfile
from pathlib import Path
import capture_dependencies as gate


class DependencyTests(unittest.TestCase):
    def test_exact_primary_sources_only(self):
        for url in ('http://reshade.me/downloads/a','file:///C:/a','https://evil.example/ReShade.exe',
                    gate.SPECS['natives.json'][0]+'?redirect=evil'):
            with self.assertRaisesRegex(ValueError,'Unapproved'):gate.validate_url(url)
        for url,_ in gate.SPECS.values():self.assertEqual(url,gate.validate_url(url))

    def test_zip_traversal_is_rejected(self):
        for name in ('../escape.dll','/absolute.dll','C:/absolute.dll',r'bin\escape.dll'):
            data=io.BytesIO()
            with zipfile.ZipFile(data,'w') as z:z.writestr(name,b'a')
            raw=data.getvalue()
            if '\\' in name:raw=raw.replace(name.replace('\\','/').encode(),name.encode())
            with zipfile.ZipFile(io.BytesIO(raw)) as z:
                with self.assertRaisesRegex(ValueError,'Unsafe'):gate.safe_members(z)

    def test_ledger_payload_overflow_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            ledger=gate.preflight.DownloadLedger(Path(directory)/'ledger.json',limit=1)
            with self.assertRaisesRegex(ValueError,'exhausted'):ledger.reserve(2,'fixture')

    def test_html_is_not_a_candidate_zip(self):
        with self.assertRaises(zipfile.BadZipFile):zipfile.ZipFile(io.BytesIO(b'<html>not a setup</html>'))

    def test_foreign_redirect_stops_before_follow(self):
        with self.assertRaisesRegex(ValueError,'Unapproved'):
            gate.FixedRedirect().redirect_request(None,None,302,'redirect',{},'https://evil.example/payload.exe')


if __name__=='__main__':unittest.main()
