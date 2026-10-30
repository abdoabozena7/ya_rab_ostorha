"""Inspect the installed GTA build and retrieve an original matching dependency.

This CLI never installs/executes a binary, launches a simulator, trains a model,
retires data or certifies native compatibility. A valid ZIP is only a candidate.
"""
import argparse
import ctypes
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import zipfile

COMPONENT = Path(__file__).resolve().parent
PROJECT = COMPONENT.parents[1]
GAME = Path(r'D:\games\Grand Theft Auto V Enhanced\GTA5_Enhanced.exe')
ENGINE = Path(r'C:\CARLA\CARLA_0.9.16\CarlaUE4.exe')
BUILD = '1.0.1013.20'
LIMIT = 100_000_000
ARCHIVE = 'ScriptHookV_3725.0_1013.20.zip'
HOSTS = frozenset(('dev-c.com', 'www.dev-c.com', 'dev-c.enbdev.com', 'www.dev-c.enbdev.com'))
SOURCES = (f'https://www.dev-c.com/files/{ARCHIVE}',
           f'https://www.dev-c.enbdev.com/files/{ARCHIVE}')


def write_json(path, value):
    temporary = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    with temporary.open('x', encoding='utf8') as stream:
        json.dump(value, stream, indent=2, allow_nan=False)
        stream.write('\n'); stream.flush(); os.fsync(stream.fileno())
    os.replace(temporary, path)


class DownloadLedger:
    """Reserve before reading: interruption retains the whole reservation charge."""
    def __init__(self, path, limit=LIMIT):
        if not 0 < limit <= LIMIT:
            raise ValueError('Invalid payload limit')
        self.path, self.limit = Path(path), limit
        self.state = json.loads(self.path.read_text()) if self.path.exists() else {
            'limit': limit, 'charged_payload_bytes': 0, 'attempts': []}
        charged = self.state.get('charged_payload_bytes')
        if self.state.get('limit') != limit or type(charged) is not int or not 0 <= charged <= limit:
            raise ValueError('Invalid persistent download ledger; never reset it automatically')

    def reserve(self, amount, source):
        if type(amount) is not int or amount < 0 or amount > self.limit-self.state['charged_payload_bytes']:
            raise ValueError('Download budget exhausted')
        entry = {'id': uuid.uuid4().hex, 'url': source, 'reserved': amount, 'finished': False}
        self.state['attempts'].append(entry)
        self.state['charged_payload_bytes'] += amount
        write_json(self.path, self.state)
        return entry

    def finish(self, entry, actual):
        if entry['finished'] or type(actual) is not int or not 0 <= actual <= entry['reserved']:
            raise ValueError('Invalid or repeated download accounting')
        self.state['charged_payload_bytes'] -= entry['reserved']-actual
        entry.update(finished=True, actual=actual)
        write_json(self.path, self.state)


def original_url(url):
    parsed = urllib.parse.urlsplit(url)
    if (parsed.scheme != 'https' or parsed.hostname not in HOSTS or parsed.port not in (None, 443)
            or parsed.username or parsed.password or parsed.query or parsed.fragment
            or parsed.path != '/files/'+ARCHIVE):
        raise ValueError('Dependency URL is not the approved original HTTPS archive')
    return url


class OriginalRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        original_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def inspect_archive(payload):
    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        names = archive.namelist()
        for info in archive.infolist():
            # ZipInfo normalizes backslashes on Windows; inspect the original
            # central-directory spelling rather than trusting that normalization.
            name = info.orig_filename
            item = PurePosixPath(name)
            if (item.is_absolute() or '..' in item.parts or '\\' in name or ':' in name
                    or archive.getinfo(name).file_size > 20_000_000):
                raise ValueError('Unsafe archive entry')
        if len(names) != len(set(names)):
            raise ValueError('Duplicate archive entries')
        required = {'readme.txt', 'bin/ScriptHookV.dll', 'bin/dinput8.dll'}
        if not required.issubset(names):
            raise ValueError('Required Script Hook V files missing')
        text = archive.read('readme.txt').decode('utf8', 'replace')
        # The version declaration must match, not merely a historical changelog.
        heading = text.split('Description:', 1)[0]
        if 'v3725.0/1013.20' not in heading:
            raise ValueError('Wrong build: archive version is not 3725.0/1013.20')
        binaries = {name: archive.read(name) for name in required if name.endswith('.dll')}
        if any(not value.startswith(b'MZ') for value in binaries.values()):
            raise ValueError('Required DLL is not a PE candidate')
        return {'declared_version': 'v3725.0/1013.20', 'sha256': hashlib.sha256(payload).hexdigest(),
                'bytes': len(payload), 'entries': names,
                'binary_sha256': {name: hashlib.sha256(value).hexdigest() for name, value in binaries.items()},
                'native_compatibility_verified': False}


def retrieve(source, ledger, directory, opener=None):
    original_url(source)
    opener = opener or urllib.request.build_opener(OriginalRedirect())
    request = urllib.request.Request(source, headers={
        'User-Agent': 'Mozilla/5.0', 'Accept': '*/*', 'Referer': 'https://www.dev-c.com/gtav/scripthookv/'})
    record = {'url': source, 'at_unix': time.time(), 'status': None}
    try:
        try:
            response = opener.open(request, timeout=20)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            original_url(response.geturl())
            record['status'] = response.code
            declared = response.headers.get('Content-Length')
            if declared is not None and (not declared.isascii() or not declared.isdigit()):
                raise ValueError('Invalid response length')
            # Error bodies are diagnostic, never candidate archives.
            bound = 10_000_000 if response.code == 200 else 16_384
            amount = min(int(declared), bound) if declared is not None else bound
            if response.code == 200 and declared is not None and int(declared) > bound:
                raise ValueError('Dependency archive exceeds the inspection bound')
            entry = ledger.reserve(amount, source)
            parts = []; total = 0
            while total < amount:
                chunk = response.read(min(65_536, amount-total))
                if not chunk:
                    break
                parts.append(chunk); total += len(chunk)
            ledger.finish(entry, total)
            payload = b''.join(parts)
            record.update(received_payload_bytes=total, body_sha256=hashlib.sha256(payload).hexdigest())
            body = directory/(entry['id']+'.response')
            body.write_bytes(payload)
            record['body_file'] = body.name
            if response.code != 200:
                raise ValueError(f'Original server returned HTTP {response.code}')
            if declared is not None and total != int(declared):
                raise ValueError('Truncated response')
            record['archive'] = inspect_archive(payload)
            record['available'] = True
    except (OSError, ValueError, zipfile.BadZipFile, RuntimeError) as error:
        record.update(available=False, error=str(error))
    return record


def file_version(path):
    class Fixed(ctypes.Structure):
        _fields_ = [(name, ctypes.c_uint32) for name in (
            'signature','struct','fileMS','fileLS','productMS','productLS','mask','flags',
            'OS','type','subtype','dateMS','dateLS')]
    library = ctypes.windll.version
    length = library.GetFileVersionInfoSizeW(str(path), None)
    if not length:
        raise OSError('Executable has no readable version resource')
    buffer = ctypes.create_string_buffer(length)
    if not library.GetFileVersionInfoW(str(path), 0, length, buffer):
        raise OSError('Executable version resource read failed')
    pointer = ctypes.c_void_p(); size = ctypes.c_uint()
    if not library.VerQueryValueW(buffer, '\\', ctypes.byref(pointer), ctypes.byref(size)):
        raise OSError('Executable fixed version resource missing')
    fixed = ctypes.cast(pointer, ctypes.POINTER(Fixed)).contents
    if fixed.signature != 0xFEEF04BD:
        raise ValueError('Invalid executable version signature')
    return '.'.join(map(str, (fixed.fileMS >> 16, fixed.fileMS & 65535, fixed.fileLS >> 16, fixed.fileLS & 65535)))


def protected_inventory():
    tracked = subprocess.run(['git','ls-files','-z'], cwd=PROJECT, capture_output=True, check=True).stdout
    untracked = subprocess.run(['git','ls-files','--others','--exclude-standard','-z'],
                               cwd=PROJECT, capture_output=True, check=True).stdout
    paths = [PROJECT/os.fsdecode(name) for name in (tracked+untracked).split(b'\0') if name]
    paths += [GAME, ENGINE, PROJECT/'.runtime-proof/active.json']
    paths += list((PROJECT/'artifacts/learned_safety').rglob('*'))
    paths += list((PROJECT/'models').glob('*.onnx'))
    for directory in ('output/egypt-validation', 'output/native-validation'):
        paths += [p for p in (PROJECT/directory).glob('*.json')
                  if any(s in p.name for s in ('ledger','budget','grant','allowance','authorization'))]
    result = {}
    for path in sorted(set(paths)):
        if path.is_file():
            h = hashlib.sha256()
            with path.open('rb') as source:
                for chunk in iter(lambda: source.read(1024*1024), b''):
                    h.update(chunk)
            result[str(path)] = h.hexdigest()
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    output = args.output.resolve(); output.mkdir(parents=True, exist_ok=True)
    storage = COMPONENT/'downloads'; storage.mkdir(exist_ok=True)
    lock = storage/'preflight.lock'
    # Interrupted owners require inspection. Never delete another client's lock.
    handle = lock.open('x'); handle.write(str(os.getpid())); handle.close()
    result = {'dependencies_available': False, 'native_capability_accepted': False,
              'gta_runtime_seconds': 0, 'training_started': False, 'cleanup_authorized': False,
              'provider_migrated': False, 'installed_version': None}
    try:
        before = protected_inventory(); write_json(output/'protected-before.json', before)
        result['installed_version'] = file_version(GAME)
        if result['installed_version'] != BUILD:
            raise ValueError('Installed game build differs from the approved build')
        ledger = DownloadLedger(storage/'payload-ledger.json')
        attempts = []
        with (output/'attempts.jsonl').open('x', encoding='utf8') as trace:
            for url in SOURCES:
                attempt = retrieve(url, ledger, output)
                attempts.append(attempt); trace.write(json.dumps(attempt)+'\n'); trace.flush()
                if attempt['available']:
                    break
        result.update(dependencies_available=any(a['available'] for a in attempts), attempts=attempts,
                      charged_payload_bytes=ledger.state['charged_payload_bytes'], download_limit_bytes=LIMIT)
    except Exception as error:
        result['error'] = str(error)
    finally:
        if 'before' in locals():
            after = protected_inventory(); write_json(output/'protected-after.json', after)
            result['protected_inputs_unchanged'] = before == after
        write_json(output/'result.json', result)
        lock.unlink()  # Only this invocation's successfully acquired lock.
    print(json.dumps(result, indent=2))
    return 0 if result['dependencies_available'] and result.get('protected_inputs_unchanged') else 1


if __name__ == '__main__':
    raise SystemExit(main())
