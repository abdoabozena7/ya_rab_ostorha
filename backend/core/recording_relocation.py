"""Verified copy, reversible path activation and explicit closed-run release."""
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
from contextlib import contextmanager
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace

from .recording_locations import ROOT, _plain_directory, receipt_path, registered_location
from .storage_retention import contained


def _digest(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def inventory(root):
    root = _plain_directory(root)
    paths, directories = [], []
    for base, folders, names in os.walk(root, followlinks=False):
        for name in folders:
            path = Path(base) / name
            _plain_directory(path)
            directories.append(path.relative_to(root).as_posix())
        for name in names:
            paths.append(Path(base) / name)
    def measured(path):
        contained(path, root)
        if not path.is_file():
            raise ValueError('Recording contains a non-file asset')
        return path.relative_to(root).as_posix(), {'bytes': path.stat().st_size, 'sha256': _digest(path)}
    with ThreadPoolExecutor(max_workers=8) as pool:
        files = dict(pool.map(measured, paths))
    return {'files': files, 'directories': sorted(directories)}


def _copy_file(source, destination):
    with source.open('rb') as original, destination.open('xb') as copied:
        shutil.copyfileobj(original, copied, 1024 * 1024)
        copied.flush()
        os.fsync(copied.fileno())
    shutil.copystat(source, destination)


def _save(path, value):
    from ..learning.egypt_budget import save_json
    save_json(path, value)
    with path.open('rb+') as stream:
        os.fsync(stream.fileno())


def _stopped():
    from .driving_video import wait_for_exports
    from ..learning.egypt_budget import ownership_status, require_stopped_storage_access
    require_stopped_storage_access()
    if ownership_status()['reserved'] or not wait_for_exports(0):
        raise RuntimeError('Relocation requires no reservation and drained exports')


def _link(alias, target):
    if os.name == 'nt':
        if any(c in str(alias) + str(target) for c in '&|<>^%!\r\n'):
            raise ValueError('Unsafe junction path')
        subprocess.run([os.environ['COMSPEC'], '/c', 'mklink', '/J', str(alias), str(target)],
                       check=True, capture_output=True)
    else:
        alias.symlink_to(target, target_is_directory=True)


def _unlink(alias):
    if os.path.isjunction(alias):
        os.rmdir(alias)
    else:
        alias.unlink()


@contextmanager
def relocation_lock(directory):
    directory.mkdir(parents=True, exist_ok=True)
    lock = directory / 'relocation.lock'
    with lock.open('x') as stream:
        stream.write(str(os.getpid()))
    try:
        yield
    finally:
        lock.unlink()


def verify_closed_recording(root):
    from .replay import ReplayReader
    from imageio_ffmpeg import get_ffmpeg_exe
    from .video_http import serve_video
    result = {'replay': 'PREVIOUSLY_RETIRED', 'videos': []}
    status = json.loads((root / 'recording-status.json').read_text(encoding='utf8'))
    if status.get('incomplete') is True:
        result['replay'] = 'ORIGINAL_INCOMPLETE_RECORDING_PRESERVED'
    elif not (root / 'storage-retention.json').exists():
        reader = ReplayReader(root)
        for index in {0, len(reader.index) - 1}:
            frame = reader.frame_at(index)
            for sensor in frame.sensors:
                if sensor.asset is not None:
                    reader.asset_bytes(sensor)
        result['replay'] = {'frames': len(reader.index), 'endpoint_assets_verified': True}
    for path in sorted(root.glob('*.mp4')):
        if '.encoding.' in path.name:
            result['videos'].append({'name': path.name, 'status': 'ORIGINAL_ENCODING_INTERMEDIATE_PRESERVED'})
            continue
        if path.name in ('driving.mp4', 'driving-annotated.mp4', 'shared-perception.mp4'):
            shared = path.name == 'shared-perception.mp4'
            status_path = root / ('shared-perception-status.json' if shared else 'video-status.json')
            state = json.loads(status_path.read_text(encoding='utf8')) if status_path.exists() else {}
            variant = state if shared else state.get('variants', {}).get(
                'annotated' if path.name == 'driving-annotated.mp4' else 'raw',
                state if path.name == 'driving.mp4' else {})
            if variant.get('status') != 'READY':
                result['videos'].append({'name': path.name, 'status': 'ORIGINAL_UNAVAILABLE_VIDEO_PRESERVED'})
                continue
        probe = subprocess.run([get_ffmpeg_exe(), '-hide_banner', '-loglevel', 'error',
            '-i', str(path), '-frames:v', '1', '-f', 'null', '-'],
            capture_output=True, timeout=30)
        end = subprocess.run([get_ffmpeg_exe(), '-hide_banner', '-loglevel', 'error',
            '-sseof', '-0.15', '-i', str(path), '-frames:v', '1', '-f', 'null', '-'],
            capture_output=True, timeout=30)
        if probe.returncode or end.returncode:
            raise ValueError('Relocated video failed endpoint decode: ' + path.name)
        http_verified = None
        if path.name in ('driving.mp4', 'driving-annotated.mp4', 'shared-perception.mp4'):
            responses = []
            handler = SimpleNamespace(command='HEAD', headers={},
                send_response=lambda status: responses.append(status),
                send_header=lambda *args: None, end_headers=lambda: None,
                _json=lambda status, value: responses.append(status))
            served = serve_video(handler, '/runs/normal_city/' + root.name + '/' + path.name,
                                 ROOT / 'runs' / 'normal_city')
            http_verified = served and responses == [200]
            if not http_verified:
                raise ValueError('Original video URL is not available after relocation: ' + path.name)
        result['videos'].append({'name': path.name, 'first_and_last_decode': True,
                                 'original_http_route_verified': http_verified})
    return result


def relocate_recording(source, destination, *, workspace=ROOT):
    """Keep the original staged until independent consumer checks permit release."""
    workspace = Path(workspace).resolve()
    source = contained(source, workspace)
    receipt = receipt_path(source.name, workspace)
    if source.parent != workspace / 'runs' / 'normal_city' or receipt.exists():
        raise ValueError('Relocate only an unmapped native recording')
    destination = _plain_directory(destination)
    if destination.is_relative_to(workspace) or destination == workspace.parent:
        raise ValueError('Use a dedicated external recording destination')
    target = destination / source.name
    if target.exists():
        raise ValueError('Destination recording already exists')
    _stopped()
    status = json.loads((source / 'recording-status.json').read_text(encoding='utf8'))
    if status.get('finalized') is not True:
        raise ValueError('Only finalized recordings can be relocated')
    manifest = inventory(source)
    size = sum(row['bytes'] for row in manifest['files'].values())
    destination.mkdir(parents=True, exist_ok=True)
    if shutil.disk_usage(destination).free < int(size * 1.5) + 4 * 1024**3:
        raise ValueError('Relocation destination needs copy capacity, 50% margin and 4 GiB reserve')
    receipt.parent.mkdir(parents=True, exist_ok=True)
    with relocation_lock(receipt.parent):
        _stopped()
        target.mkdir()
        for name in manifest['directories']:
            (target / name).mkdir()
        with ThreadPoolExecutor(max_workers=8) as pool:
            list(pool.map(lambda name: _copy_file(source / name, target / name), manifest['files']))
        if inventory(target) != manifest or inventory(source) != manifest:
            raise ValueError('Recording changed or copy checksum mismatch; original retained')
        manifest_path = receipt.with_suffix('.manifest.json')
        _save(manifest_path, manifest)
        staged = receipt.parent / 'staging' / source.name
        staged.parent.mkdir(exist_ok=True)
        data = {'version': 1, 'status': 'COPY_VERIFIED', 'source': str(source), 'target': str(target),
                'staged_source': str(staged), 'bytes': size, 'files': len(manifest['files']),
                'manifest_sha256': _digest(manifest_path),
                'metadata_sha256': manifest['files']['metadata.json']['sha256'],
                'created_at_utc': datetime.now(timezone.utc).isoformat()}
        _save(receipt, data)
        _stopped()
        source.rename(staged)
        try:
            _link(source, target)
            data['status'] = 'ACTIVE'
            _save(receipt, data)
            if registered_location(source.name, workspace) != target:
                raise ValueError('Relocation mapping failed verification')
        except Exception:
            if source.is_symlink() or os.path.isjunction(source):
                _unlink(source)
            staged.rename(source)
            data['status'] = 'COPY_VERIFIED'
            _save(receipt, data)
            raise
        return data


def restore_recording(name, *, workspace=ROOT):
    """Restore the original physical directory; retain the external evidence copy."""
    workspace = Path(workspace).resolve()
    receipt = receipt_path(name, workspace)
    with relocation_lock(receipt.parent):
        _stopped()
        data = json.loads(receipt.read_text(encoding='utf8'))
        target = registered_location(name, workspace)
        if target is None:
            raise ValueError('Recording has no active relocation')
        source = workspace / 'runs' / 'normal_city' / name
        staged = receipt.parent / 'staging' / name
        manifest = json.loads(receipt.with_suffix('.manifest.json').read_text(encoding='utf8'))
        if inventory(target) != manifest:
            raise ValueError('Destination changed; rollback must not discard evidence')
        if not staged.exists():
            if shutil.disk_usage(workspace).free < int(data['bytes'] * 1.5) + 4 * 1024**3:
                raise ValueError('Insufficient original-volume capacity for rollback')
            shutil.copytree(target, staged)
            for path in staged.rglob('*'):
                if path.is_file():
                    with path.open('rb+') as stream:
                        os.fsync(stream.fileno())
        if inventory(staged) != manifest:
            raise ValueError('Staged rollback copy does not match preserved evidence')
        _stopped()
        _unlink(source)
        try:
            staged.rename(source)
        except OSError:
            _link(source, target)
            raise
        data.update(status='RESTORED', restored_at_utc=datetime.now(timezone.utc).isoformat())
        _save(receipt, data)
        return data


def release_staged_recording(name, *, workspace=ROOT):
    """Release only this hash-identical staged source, never the preserved target."""
    directory = Path(workspace) / 'output' / 'recording-relocations'
    with relocation_lock(directory):
        return _release_staged_recording(name, workspace=workspace)


def _release_staged_recording(name, *, workspace):
    workspace = Path(workspace).resolve()
    receipt = receipt_path(name, workspace)
    data = json.loads(receipt.read_text(encoding='utf8'))
    target = registered_location(name, workspace)
    if data['status'] != 'ACTIVE' or target is None:
        raise ValueError('Recording is not awaiting verified source release')
    staged = receipt.parent / 'staging' / name
    if data['staged_source'] != str(staged):
        raise ValueError('Unexpected staged source')
    _stopped()
    manifest = json.loads(receipt.with_suffix('.manifest.json').read_text(encoding='utf8'))
    if inventory(target) != manifest or inventory(staged) != manifest:
        raise ValueError('Staged or destination recording changed; both retained')
    checks = verify_closed_recording(target)
    alias = workspace / 'runs' / 'normal_city' / name
    if alias.resolve() != target:
        raise ValueError('Original path no longer resolves to the verified recording')
    data['consumer_checks'] = checks
    _save(receipt, data)
    _stopped()
    shutil.rmtree(contained(staged, receipt.parent))
    data.update(status='RELEASED', released_at_utc=datetime.now(timezone.utc).isoformat())
    _save(receipt, data)
    return data
