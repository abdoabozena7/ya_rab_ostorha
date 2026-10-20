"""Explicit raw-recording retirement; outcomes and lossless telemetry survive."""
import gzip
import hashlib
import json
import os
from pathlib import Path
import shutil
import threading
from datetime import datetime,timezone

ASSET_FOLDERS=('rgb','depth','lidar')
_RETIRE_LOCK=threading.Lock()


def contained(path,workspace):
    workspace=Path(workspace).resolve();path=Path(path)
    resolved=path.resolve()
    if resolved==workspace or not resolved.is_relative_to(workspace):
        raise ValueError('Storage target escapes the project workspace')
    for parent in (path,*path.parents):
        if parent==workspace:break
        if parent.is_symlink() or os.path.isjunction(parent):raise ValueError('Storage target uses a link or junction')
    return resolved


def recording_roots(folder,workspace):
    folder=contained(folder,workspace)
    for base,dirs,files in os.walk(folder,followlinks=False):
        dirs[:]=[name for name in dirs if not (Path(base)/name).is_symlink() and not os.path.isjunction(Path(base)/name)]
        if 'metadata.json' in files and (Path(base)/'telemetry').is_dir():
            dirs.clear();yield Path(base)


def archive_recording(root,workspace,*,apply=False):
    root=contained(root,workspace)
    if not (root/'metadata.json').is_file() or not (root/'telemetry').is_dir():
        raise ValueError('Storage target is not a native recording root')
    folders=[];bytes_removed=0;files_removed=0
    for name in ASSET_FOLDERS:
        path=root/name
        if not path.exists():continue
        path=contained(path,workspace)
        with os.scandir(path) as entries:
            for entry in entries:
                if not entry.is_file(follow_symlinks=False) or entry.is_symlink():
                    raise ValueError('Unexpected nested/link entry in sensor assets')
                bytes_removed+=entry.stat().st_size;files_removed+=1
        folders.append(path)
    result={'root':str(root),'raw_bytes':bytes_removed,'raw_files':files_removed,
        'video_available':(root/'driving.mp4').is_file(),'telemetry_compressed':[]}
    if not apply:return result
    marker=root/'storage-retention.json'
    result.update(version=1,status='ARCHIVING',raw_replay_available=False,
        reason='Old raw sensor assets removed at the operator request; outcomes and compressed telemetry retained',
        timestamp_utc=datetime.now(timezone.utc).isoformat())
    marker.write_text(json.dumps(result,indent=2),encoding='utf8')
    for folder in folders:shutil.rmtree(contained(folder,workspace))
    for name in ('telemetry','events'):
        directory=root/name
        if not directory.exists():continue
        contained(directory,workspace)
        for path in directory.glob('*.jsonl'):
            contained(path,workspace)
            zipped=path.with_suffix(path.suffix+'.gz');temporary=zipped.with_suffix('.tmp')
            digest=hashlib.sha256()
            with path.open('rb') as source,gzip.open(temporary,'wb',compresslevel=3) as destination:
                for chunk in iter(lambda:source.read(1024*1024),b''):
                    digest.update(chunk);destination.write(chunk)
            check=hashlib.sha256()
            with gzip.open(temporary,'rb') as source:
                for chunk in iter(lambda:source.read(1024*1024),b''):check.update(chunk)
            if digest.digest()!=check.digest():raise RuntimeError('Lossless telemetry archive checksum mismatch')
            temporary.replace(zipped);path.unlink()
            result['telemetry_compressed'].append({'path':str(zipped.relative_to(root)),'uncompressed_sha256':digest.hexdigest()})
    result['status']='ARCHIVED';marker.write_text(json.dumps(result,indent=2),encoding='utf8')
    return result


def open_telemetry(path):
    path=Path(path)
    return path.open(encoding='utf8') if path.exists() else gzip.open(str(path)+'.gz','rt',encoding='utf8')


def retire_guided_history(workspace,keep=2):
    """After video export, bound ordinary guided raw history; research stays explicit."""
    with _RETIRE_LOCK:return _retire_guided_history(workspace,keep)


def _retire_guided_history(workspace,keep):
    workspace=Path(workspace).resolve();parent=workspace/'runs/normal_city'
    if not parent.is_dir():return []
    candidates=[]
    for root in recording_roots(parent,workspace):
        try:
            metadata=json.loads((root/'metadata.json').read_text(encoding='utf8'))
            if metadata.get('config',{}).get('storage_policy')!='GUIDED_KEEP_TWO_RAW':continue
            candidates.append((metadata.get('created_at_utc',''),root))
        except (OSError,ValueError):continue
    retired=[]
    for _,root in sorted(candidates,reverse=True)[keep:]:
        if (root/'storage-retention.json').exists():continue
        status=json.loads((root/'recording-status.json').read_text(encoding='utf8'))
        video=json.loads((root/'video-status.json').read_text(encoding='utf8')) if (root/'video-status.json').exists() else {}
        if status.get('finalized') is not True or video.get('status')!='READY' or not (root/'driving.mp4').is_file():continue
        metadata=json.loads((root/'metadata.json').read_text(encoding='utf8'))
        # The third export needs both raw front-camera prefixes. Do not retire
        # either arm while their comparison has not produced that artifact.
        presentation_id=metadata.get('config',{}).get('presentation_id')
        if presentation_id and metadata.get('config',{}).get('automatic_pair'):
            saved=workspace/'output/presentations'/(presentation_id+'.json')
            if not saved.exists():continue
            presentation=json.loads(saved.read_text(encoding='utf8'))
            if presentation.get('shared_perception',{}).get('status')!='READY':continue
        if video.get('annotation_required'):
            annotated=video.get('variants',{}).get('annotated',{})
            path=root/'driving-annotated.mp4'
            if annotated.get('status')!='READY' or not path.is_file():continue
            if hashlib.sha256(path.read_bytes()).hexdigest()!=annotated.get('sha256'):continue
        retired.append(archive_recording(root,workspace,apply=True))
    return retired
