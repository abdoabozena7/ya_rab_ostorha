"""Inspect the official Windows ZIP directory without downloading the whole game.

Uses normal curl HTTP byte ranges; requires server range support. Inspection
does not execute any package code or imply that the simulator is installed.
"""
import io
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import tempfile
import zipfile


PACKAGE_URL = 'https://downloads.carlasim.com/Windows/CARLA_0.9.16.zip'


class OfficialZip(io.RawIOBase):
    def __init__(self):
        head = subprocess.run(['curl.exe', '--fail', '--silent', '--show-error', '--head',
                               '--location', '--max-time', '30', PACKAGE_URL],
                              check=True, capture_output=True, text=True).stdout
        lengths = re.findall(r'^Content-Length:\s*(\d+)', head, re.I | re.M)
        if not lengths:
            raise RuntimeError('Official archive size unavailable')
        self.size = int(lengths[-1])
        self.position = 0
        self.headers = head

    def seekable(self):
        return True

    def seek(self, offset, whence=0):
        self.position = offset + (0 if whence == 0 else self.position if whence == 1 else self.size)
        return self.position

    def tell(self):
        return self.position

    def read(self, size=-1):
        size = min(self.size - self.position, size if size >= 0 else self.size - self.position)
        if size <= 0:
            return b''
        if size > 64 * 1024 * 1024:
            raise RuntimeError('Archive inspection request exceeds 64 MB; use the full package')
        start, end = self.position, self.position + size - 1
        with tempfile.TemporaryDirectory() as directory:
            body = Path(directory) / 'range.bin'
            headers = Path(directory) / 'headers.txt'
            subprocess.run(['curl.exe', '--fail', '--silent', '--show-error', '--location',
                            '--max-time', '60', '--max-filesize', str(64 * 1024 * 1024),
                            '--range', f'{start}-{end}', '--dump-header', str(headers),
                            '--output', str(body), PACKAGE_URL], check=True)
            header_text = headers.read_text()
            ranges = re.findall(r'^Content-Range:\s*bytes (\d+)-(\d+)/(\d+)', header_text, re.I | re.M)
            if not ranges or tuple(map(int, ranges[-1])) != (start, end, self.size):
                raise RuntimeError('Official server did not honor the requested byte range')
            data = body.read_bytes()
        if len(data) != size:
            raise RuntimeError('Incomplete official archive range')
        self.position += len(data)
        return data


def inspect(local_archive=None, wheel_cache=None):
    remote = OfficialZip() if local_archive is None else Path(local_archive)
    archive_size = remote.size if local_archive is None else remote.stat().st_size
    with zipfile.ZipFile(remote) as archive:
        wheels = [info for info in archive.infolist()
                  if re.search(r'carla-0\.9\.16-cp\d+-[^/]+-win_amd64\.whl$', info.filename)]
        result = {'version': '0.9.16', 'url': PACKAGE_URL, 'archiveBytes': archive_size,
                  'uncompressedBytes': sum(info.file_size for info in archive.infolist()),
                  'entryCount': len(archive.infolist()),
                  'launchers': [info.filename for info in archive.infolist()
                                if Path(info.filename).name == 'CarlaUE4.exe'],
                  'windowsWheels': [{'path': info.filename, 'bytes': info.file_size,
                                     'crc32': f'{info.CRC:08x}'} for info in wheels],
                  'pythonEggs': [info.filename for info in archive.infolist() if info.filename.endswith('.egg')]}
        if not wheels:
            raise RuntimeError('No CARLA 0.9.16 Windows wheels found in official package')
        for wheel, metadata in zip(wheels, result['windowsWheels']):
            data = archive.read(wheel)  # zipfile validates the packaged wheel's CRC.
            metadata['sha256'] = hashlib.sha256(data).hexdigest()
            with zipfile.ZipFile(io.BytesIO(data)) as api:
                names = api.namelist()
                wheel_meta = next(name for name in names if name.endswith('.dist-info/WHEEL'))
                package_meta = next(name for name in names if name.endswith('.dist-info/METADATA'))
                metadata['tags'] = [tag.strip() for tag in re.findall(
                    r'^Tag: (.+)$', api.read(wheel_meta).decode(), re.M)]
                metadata['packageMetadata'] = [line for line in api.read(package_meta).decode().splitlines()
                                               if line.startswith(('Name:', 'Version:', 'Requires-Python:'))]
            if wheel_cache:
                cache = Path(wheel_cache)
                cache.mkdir(parents=True, exist_ok=True)
                (cache / Path(wheel.filename).name).write_bytes(data)
        return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--archive', help='Inspect an already downloaded local ZIP')
    parser.add_argument('--output', help='Save the inspected package manifest as JSON')
    parser.add_argument('--wheel-cache', help='Save only the shipped API wheels; does not install them')
    args = parser.parse_args()
    result = inspect(args.archive, args.wheel_cache)
    rendered = json.dumps(result, indent=2)
    if args.output:
        Path(args.output).write_text(rendered, encoding='utf-8')
    print(rendered)
