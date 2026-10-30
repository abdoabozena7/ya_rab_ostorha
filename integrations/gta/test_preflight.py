"""Malformed dependency inputs must never become a usable native candidate."""
import io
import tempfile
from pathlib import Path
import unittest
import zipfile
import preflight as gate


def archive(version='v3725.0/1013.20', extra=None):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w') as target:
        target.writestr('readme.txt', 'SCRIPT HOOK V\n'+version+'\nDescription:\n')
        target.writestr('bin/ScriptHookV.dll', b'MZfixture-only-never-executed')
        target.writestr('bin/dinput8.dll', b'MZfixture-only-never-executed')
        if extra:
            # Serialize the hostile spelling verbatim; ZipInfo's constructor
            # would otherwise turn backslashes into '/' on the Windows host.
            entry = zipfile.ZipInfo('entry')
            entry.filename = extra
            target.writestr(entry, b'bad')
    return buffer.getvalue()


class PreflightTests(unittest.TestCase):
    def test_wrong_build(self):
        with self.assertRaisesRegex(ValueError, 'Wrong build'):
            gate.inspect_archive(archive('v3586.0/889.22'))

    def test_changelog_match_is_not_version_match(self):
        bad = archive('v3889.0/1158.13\nDescription:\nChangelog: v3725.0/1013.20')
        with self.assertRaisesRegex(ValueError, 'Wrong build'):
            gate.inspect_archive(bad)

    def test_candidate_is_not_native_acceptance(self):
        result = gate.inspect_archive(archive())
        self.assertFalse(result['native_compatibility_verified'])
        self.assertEqual(result['declared_version'], 'v3725.0/1013.20')

    def test_error_page(self):
        with self.assertRaises(zipfile.BadZipFile):
            gate.inspect_archive(b'<html>Not Acceptable</html>')

    def test_traversal(self):
        for entry in ('../other.dll', '/other.dll', 'C:/other.dll', 'bin\\other.dll'):
            with self.subTest(entry=entry), self.assertRaisesRegex(ValueError, 'Unsafe'):
                gate.inspect_archive(archive(extra=entry))

    def test_original_https_only(self):
        for url in ('http://www.dev-c.com/files/'+gate.ARCHIVE,
                    'https://example.com/files/'+gate.ARCHIVE,
                    'https://www.dev-c.com/files/'+gate.ARCHIVE+'?redirect=other',
                    'https://www.dev-c.com/files/ScriptHookV_newer.zip'):
            with self.subTest(url=url), self.assertRaises(ValueError):
                gate.original_url(url)

    def test_budget_exhaustion(self):
        with tempfile.TemporaryDirectory() as directory:
            ledger = gate.DownloadLedger(Path(directory)/'ledger.json', limit=10)
            ledger.reserve(8, gate.SOURCES[0])
            # Simulate interruption: a new process cannot reuse reserved bytes.
            resumed = gate.DownloadLedger(ledger.path, limit=10)
            with self.assertRaisesRegex(ValueError, 'budget exhausted'):
                resumed.reserve(3, gate.SOURCES[0])
            self.assertEqual(resumed.state['charged_payload_bytes'], 8)

    def test_actual_charge_and_double_refund(self):
        with tempfile.TemporaryDirectory() as directory:
            ledger = gate.DownloadLedger(Path(directory)/'ledger.json', limit=10)
            entry = ledger.reserve(8, gate.SOURCES[0]); ledger.finish(entry, 5)
            self.assertEqual(ledger.state['charged_payload_bytes'], 5)
            with self.assertRaises(ValueError):
                ledger.finish(entry, 0)


if __name__ == '__main__':
    unittest.main()
