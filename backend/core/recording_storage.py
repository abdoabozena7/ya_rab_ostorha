"""Lossless storage of closed recordings; logical references keep original hashes."""
from datetime import datetime, timezone
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from contextlib import nullcontext
import gzip
import hashlib
import json
import math
import os
from pathlib import Path
import shutil
import threading
import time
import uuid

from .storage_retention import contained


def stored_path(path):
    path = Path(path)
    return path if path.is_file() else path.with_name(path.name + '.gz')


def stored_exists(path):
    return stored_path(path).is_file()


def open_recorded(path, mode='rb'):
    path = Path(path)
    target = stored_path(path)
    options = {} if 'b' in mode else {'encoding': 'utf8'}
    return target.open(mode, **options) if target == path else gzip.open(target, mode, **options)


def _digest(stream):
    digest = hashlib.sha256()
    size = 0
    for chunk in iter(lambda: stream.read(1024 * 1024), b''):
        digest.update(chunk)
        size += len(chunk)
    return digest.hexdigest(), size


def compress_file(path, root, manifest, *, proof_lock=None):
    """Persist proof of decompressed equality before removing this one source."""
    path = contained(path, root)
    before = path.stat()
    target = contained(path.with_name(path.name + '.gz'), root)
    temporary = target.with_name(target.name + '.' + uuid.uuid4().hex + '.compressing')
    try:
        with path.open('rb') as source:
            original_hash, original_size = _digest(source)
        if not target.exists():
            with path.open('rb') as source, temporary.open('xb') as raw:
                with gzip.GzipFile(fileobj=raw, mode='wb', compresslevel=1, mtime=0, filename='') as compressed:
                    shutil.copyfileobj(source, compressed, 1024 * 1024)
                raw.flush()
                os.fsync(raw.fileno())
            candidate = temporary
        else:
            candidate = target
        with gzip.open(candidate, 'rb') as decoded:
            checked_hash, checked_size = _digest(decoded)
        if (original_hash, original_size) != (checked_hash, checked_size):
            raise ValueError('Lossless recording compression checksum mismatch: ' + str(path))
        current = path.stat()
        if (before.st_size, before.st_mtime_ns) != (current.st_size, current.st_mtime_ns):
            raise RuntimeError('Recording changed during compression: ' + str(path))
        if candidate.stat().st_size >= original_size:
            return {'path': path.relative_to(root).as_posix(), 'saved_bytes': 0, 'status': 'KEPT_ORIGINAL'}
        if candidate == temporary:
            temporary.replace(target)
        with target.open('rb') as stream:
            stored_hash, stored_size = _digest(stream)
        entry = {'path': path.relative_to(root).as_posix(), 'stored_path': target.relative_to(root).as_posix(),
                 'codec': 'gzip', 'original_sha256': original_hash, 'original_bytes': original_size,
                 'stored_sha256': stored_hash, 'stored_bytes': stored_size,
                 'decompressed_sha256_verified': True, 'saved_bytes': original_size - stored_size}
        with proof_lock if proof_lock is not None else nullcontext():
            manifest.write(json.dumps(entry, separators=(',', ':')) + '\n')
            manifest.flush()
            os.fsync(manifest.fileno())
            path.unlink()
        return entry
    finally:
        if temporary.exists():
            temporary.unlink()


def compress_recording(root, workspace):
    from .driving_video import wait_for_exports
    from ..learning.egypt_budget import require_stopped_storage_access, save_json
    if not Path(root).resolve().is_relative_to(Path(workspace).resolve()):
        from .recording_locations import recording_location
        root = recording_location(root, Path(workspace) / 'runs' / 'normal_city', workspace=workspace)
        workspace = root.parent
    root = contained(root, workspace)
    require_stopped_storage_access()
    if not wait_for_exports(0):
        raise RuntimeError('Finalize active video exports before compressing recordings')
    status = json.loads((root / 'recording-status.json').read_text(encoding='utf8'))
    if status.get('finalized') is not True:
        raise ValueError('Only closed recordings may be compressed')
    if (root / 'storage-retention.json').exists():
        raise ValueError('Retired raw recordings cannot be relabelled as lossless recordings')
    paths = []
    for folder, suffixes in (('depth', ('.npy', '.bin')), ('lidar', ('.bin', '.npy')),
                             ('telemetry', ('.jsonl',)), ('events', ('.jsonl',))):
        directory = root / folder
        if directory.exists():
            contained(directory, workspace)
            paths.extend(contained(p, workspace) for p in sorted(directory.iterdir()) if p.suffix in suffixes)
    report = {'version': 1, 'status': 'COMPRESSING', 'recording': str(root), 'raw_replay_available': True,
              'original_recording_status': status, 'files_compressed': 0, 'saved_bytes': 0,
              'manifest': 'lossless-compression.jsonl', 'rgb_policy': 'ORIGINAL_COMPRESSED_IMAGES_UNCHANGED',
              'started_at_utc': datetime.now(timezone.utc).isoformat()}
    marker = root / 'lossless-compression.json'
    previous = None
    if marker.exists():
        previous = json.loads(marker.read_text(encoding='utf8'))
    if marker.exists() and not paths:
        if previous.get('status') == 'COMPLETE':
            return previous
    if previous:
        report['previous_attempts'] = [*previous.get('previous_attempts', []),
            {key: previous.get(key) for key in ('status', 'started_at_utc', 'finished_at_utc', 'error', 'saved_bytes')}]
    report.update(planned_files=len(paths), processed_files=0, maximum_parallel_files=4)
    began = time.monotonic()
    save_json(marker, report)
    try:
        with (root / report['manifest']).open('a', encoding='utf8') as manifest, ThreadPoolExecutor(max_workers=4) as pool:
            remaining = iter(paths)
            proof_lock = threading.Lock()
            pending = {pool.submit(compress_file, path, root, manifest, proof_lock=proof_lock) for path in
                       [next(remaining, None) for _ in range(4)] if path is not None}
            while pending:
                finished, pending = wait(pending, return_when=FIRST_COMPLETED)
                for future in finished:
                    result = future.result()
                    report['saved_bytes'] += result['saved_bytes']
                    report['files_compressed'] += result['saved_bytes'] > 0
                    report['processed_files'] += 1
                    if report['processed_files'] % 512 == 0:
                        save_json(marker, report)
                    path = next(remaining, None)
                    if path is not None:
                        pending.add(pool.submit(compress_file, path, root, manifest, proof_lock=proof_lock))
        entries = {}
        with (root / report['manifest']).open(encoding='utf8') as manifest:
            for line in manifest:
                entry = json.loads(line)
                if not (root / entry['path']).exists():
                    entries[entry['path']] = entry
        report['files_compressed'] = len(entries)
        report['saved_bytes'] = sum(entry['saved_bytes'] for entry in entries.values())
        report['status'] = 'COMPLETE'
    except (OSError, ValueError, RuntimeError, EOFError) as error:
        report.update(status='ERROR', error=str(error))
        raise
    finally:
        report['finished_at_utc'] = datetime.now(timezone.utc).isoformat()
        report['elapsed_s'] = time.monotonic() - began
        save_json(marker, report)
    return report


def recording_size_estimate(roots, *, trips=12, duration_s=None):
    """Peak storage with closed-pair compression, plus all retained videos."""
    from .recording import DISK_RESERVE_BYTES
    if (type(trips) is not int or trips < 1 or duration_s is not None and (
            type(duration_s) not in (int, float) or not math.isfinite(duration_s) or duration_s <= 0)):
        raise ValueError('Recording estimation requires positive trip count and duration')
    samples = []
    for root in roots:
        root = Path(root)
        metadata = json.loads((root / 'metadata.json').read_text(encoding='utf8'))
        config = metadata.get('config', {})
        if (config.get('scenario_id') != 'EGYPT_URBAN_CHAOS_V1' or config.get('seed_partition') == 'HOLDOUT'
                or (root / 'storage-retention.json').exists()):
            continue
        status = json.loads((root / 'recording-status.json').read_text(encoding='utf8'))
        if status.get('finalized') is not True:
            continue
        raw_sizes = {}
        manifest = root / 'lossless-compression.jsonl'
        if manifest.exists():
            with manifest.open(encoding='utf8') as stream:
                for line in stream:
                    entry = json.loads(line)
                    raw_sizes[entry['stored_path']] = entry['original_bytes']
        sizes = {'recording': 0, 'stored': 0, 'rgb': 0}
        for name in ('rgb', 'depth', 'lidar', 'telemetry', 'events'):
            folder = root / name
            if not folder.is_dir():
                continue
            for path in folder.iterdir():
                if path.is_file():
                    size = raw_sizes.get(path.relative_to(root).as_posix(), path.stat().st_size)
                    sizes['recording'] += size
                    sizes['stored'] += path.stat().st_size
                    if name == 'rgb':
                        sizes['rgb'] += size
        first = last = None
        with open_recorded(root / 'telemetry' / 'frames.jsonl', 'rt') as stream:
            for line in stream:
                stamp = json.loads(line)['timestamp_s']
                first = stamp if first is None else first
                last = stamp
        if first is None or last <= first:
            raise ValueError('Storage estimation needs a positive measured recording duration')
        period = metadata.get('config', {}).get('fixed_delta_seconds', .05)
        seconds = last - first + period
        video_status = root / 'video-status.json'
        video_ready = video_status.is_file() and json.loads(video_status.read_text(encoding='utf8')).get('status') == 'READY'
        videos = sum(path.stat().st_size for path in root.glob('*.mp4') if '.encoding.' not in path.name) if video_ready else 0
        export_bytes = videos if videos else 2 * sizes['rgb']
        samples.append({'recording': str(root), 'duration_s': seconds,
                        'raw_bytes_per_sim_s': sizes['recording'] / seconds,
                        'stored_bytes_per_sim_s': sizes['stored'] / seconds,
                        'export_bytes_per_sim_s': export_bytes / seconds,
                        'export_rate_source': 'SAVED_MP4_BYTES' if videos else 'TWO_ORIGINAL_JPEG_STREAMS_UPPER_BOUND',
                        'temporary_annotation_bytes_per_sim_s': sizes['rgb'] / seconds})
    if not samples:
        raise ValueError('Matrix storage preflight requires closed Egypt development recordings')
    duration_s = max(s['duration_s'] for s in samples) if duration_s is None else duration_s
    concurrent = min(2, trips)
    raw = max(s['raw_bytes_per_sim_s'] for s in samples) * duration_s * concurrent
    retained = max(s['stored_bytes_per_sim_s'] for s in samples) * duration_s * (trips-concurrent)
    export_samples = [s for s in samples if s['export_rate_source'] == 'SAVED_MP4_BYTES'] or samples
    export = max(s['export_bytes_per_sim_s'] for s in export_samples) * duration_s * trips
    temporary = max(s['temporary_annotation_bytes_per_sim_s'] for s in samples) * duration_s
    estimate = int(raw + retained + export + temporary)
    return {'source': 'MEASURED_EGYPT_DEVELOPMENT_RECORDINGS', 'samples': samples,
            'trips': trips, 'estimated_trip_sim_s': duration_s, 'concurrent_raw_trips': concurrent,
            'recording_bytes': int(raw), 'retained_closed_recording_bytes': int(retained),
            'compression_between_pairs_required': True, 'temporary_export_bytes': int(temporary),
            'export_estimate_source': 'MEASURED_READY_VIDEOS' if any(s['export_rate_source'] == 'SAVED_MP4_BYTES' for s in samples) else 'ORIGINAL_JPEG_UPPER_BOUND',
            'export_bytes': int(export), 'matrix_estimate_bytes': estimate, 'margin_fraction': .5,
            'reserve_bytes': DISK_RESERVE_BYTES, 'required_free_bytes': int(estimate * 1.5) + DISK_RESERVE_BYTES}
