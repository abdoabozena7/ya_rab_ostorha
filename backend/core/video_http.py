"""Serve only exported journey video assets, with bounded byte-range streaming."""
import hashlib
import json
import re
from functools import lru_cache
from pathlib import Path

VIDEO_ROUTE=re.compile(r'/runs/normal_city/(run_[a-f0-9]{32})/(video-status\.json|shared-perception-status\.json|driving(?:-annotated)?\.mp4|shared-perception\.mp4)')


@lru_cache(maxsize=32)
def _verified(path,size,modified_ns,expected):
    digest=hashlib.sha256()
    with Path(path).open('rb') as source:
        for chunk in iter(lambda:source.read(256*1024),b''):digest.update(chunk)
    return digest.hexdigest()==expected


def _bounds(header,size):
    if header is None:return 0,size-1,200
    match=re.fullmatch(r'bytes=(\d*)-(\d*)',header)
    if not match or not any(match.groups()):raise ValueError('Unsupported byte range')
    first,last=match.groups()
    if not first:
        count=int(last)
        if count<=0:raise ValueError('Empty suffix range')
        start,end=max(0,size-count),size-1
    else:start,end=int(first),min(size-1,int(last)) if last else size-1
    if not 0<=start<=end<size:raise ValueError('Unsatisfiable byte range')
    return start,end,206


def serve_video(handler,path,root):
    match=VIDEO_ROUTE.fullmatch(path)
    if not match:return False
    started=False
    try:
        root=Path(root).resolve();folder=(root/match[1]).resolve()
        if folder.parent!=root:raise ValueError('Video escaped its recording directory')
        metadata_path=(folder/'metadata.json').resolve()
        if metadata_path.parent!=folder:raise ValueError('Metadata escaped its recording')
        metadata=json.loads(metadata_path.read_text(encoding='utf8'))
        if metadata.get('provider')!='carla' or metadata.get('data_origin')!='REAL_SIMULATION':
            raise ValueError('Native recording provenance unavailable')
        shared=match[2].startswith('shared-perception')
        status_path=(folder/('shared-perception-status.json' if shared else 'video-status.json')).resolve()
        if status_path.parent!=folder:raise ValueError('Video status escaped its recording')
        status=json.loads(status_path.read_text(encoding='utf8')) if status_path.exists() else {'status':'PENDING'}
        if match[2].endswith('-status.json'):
            started=True
            if handler.command=='HEAD':
                handler.send_response(200);handler.send_header('Content-Type','application/json');handler.end_headers()
            else:handler._json(200,status)
            return True
        variant=status if shared else status.get('variants',{}).get('annotated' if match[2]=='driving-annotated.mp4' else 'raw',status if match[2]=='driving.mp4' else {})
        allowed=('VERIFIED_COMMON_PREFIX_NATIVE_FRONT_CAMERA',) if shared else ('RECORDED_NATIVE_DRIVING_CAMERA','RECORDED_NATIVE_DRIVING_CAMERA_WITH_MEASURED_OVERLAY')
        if variant.get('status')!='READY' or variant.get('source') not in allowed:
            raise ValueError('Native video export is not ready')
        video=(folder/match[2]).resolve()
        if video.parent!=folder:raise ValueError('Video escaped its recording')
        info=video.stat()
        if not _verified(str(video),info.st_size,info.st_mtime_ns,variant.get('sha256')):
            raise ValueError('Exported video checksum mismatch')
        try:start,end,response=_bounds(handler.headers.get('Range'),info.st_size)
        except ValueError:
            started=True
            handler.send_response(416);handler.send_header('Content-Range',f'bytes */{info.st_size}')
            handler.send_header('Content-Length','0');handler.end_headers();return True
        with video.open('rb') as source:
            started=True
            handler.send_response(response);handler.send_header('Content-Type','video/mp4')
            handler.send_header('Accept-Ranges','bytes');handler.send_header('Content-Length',str(end-start+1))
            if response==206:handler.send_header('Content-Range',f'bytes {start}-{end}/{info.st_size}')
            handler.end_headers()
            if handler.command!='HEAD':
                source.seek(start);remaining=end-start+1
                while remaining:
                    chunk=source.read(min(256*1024,remaining))
                    if not chunk:break
                    handler.wfile.write(chunk);remaining-=len(chunk)
    except (OSError,ValueError,TypeError):
        # A media request never opens arbitrary raw sensor files. Browser
        # cancellation can close the socket while a range is being streamed.
        if not started:
            try:handler._json(404,{'error':'Journey video unavailable'})
            except OSError:pass
    return True
