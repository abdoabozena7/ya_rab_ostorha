"""Post-drive MP4 export of original native driving-camera frames in sim time."""
import hashlib
import json
from pathlib import Path
import subprocess
import threading
import time

_workers=set()
_lock=threading.Lock()


def wait_for_exports(timeout=30.):
    """Shutdown/validation only; never called from the native tick worker."""
    deadline=time.monotonic()+timeout
    with _lock:workers=list(_workers)
    for worker in workers:worker.join(max(0.,deadline-time.monotonic()))
    return not any(worker.is_alive() for worker in workers)


def export_video(root, *, ffmpeg=None, allow_test_data=False):
    root = Path(root)
    if (root/'storage-retention.json').exists():
        raise ValueError('Raw camera frames were archived; only an already exported video can be viewed')
    metadata=json.loads((root/'metadata.json').read_text(encoding='utf8'))
    native=metadata.get('data_origin')=='REAL_SIMULATION' and metadata.get('provider')=='carla'
    if not native and not allow_test_data:raise ValueError('Video native provenance is unavailable')
    source = root / 'telemetry/video-frames.jsonl'
    if not source.exists(): raise ValueError('No recorded driving-camera frames; no substitute image is used')
    frames = [json.loads(line) for line in source.read_text(encoding='utf8').splitlines()]
    if not frames: raise ValueError('The native driving-camera recording is empty')
    anchor=None
    events=root/'events/events.jsonl'
    if events.exists():
        with events.open(encoding='utf8') as stream:
            for line in stream:
                event=json.loads(line);journey=event.get('payload',{}).get('journey',{})
                if journey.get('status')=='RUNNING' and (journey.get('driving_mode') in ('HYBRID','BASELINE') or journey.get('presentation_id')):
                    anchor=event['timestamp_s'];break
    if anchor is not None:
        frames=[row for row in frames if row['timestamp_s']>=anchor-1e-6]
        if not frames:raise ValueError('No driving-camera frames follow the admitted journey start')
    previous = None
    for row in frames:
        if row['sensor_id'] != 'drivingCamera': raise ValueError('Video requires the actual driving camera')
        if previous is not None and row['timestamp_s'] <= previous: raise ValueError('Video timestamps must increase')
        previous = row['timestamp_s']
        path = (root/row['asset']['path']).resolve()
        if root.resolve() not in path.parents: raise ValueError('Video asset escaped its recording')
        if hashlib.sha256(path.read_bytes()).hexdigest() != row['asset']['sha256']:
            raise ValueError('Original native camera checksum mismatch')
    if ffmpeg is None:
        from imageio_ffmpeg import get_ffmpeg_exe
        ffmpeg = get_ffmpeg_exe()
    concat = root/'video.ffconcat'
    lines = ['ffconcat version 1.0']
    for i,row in enumerate(frames):
        path = (root/row['asset']['path']).resolve().as_posix().replace("'", "'\\''")
        lines.append("file '"+path+"'")
        lines.append('option framerate 1000')
        dt = frames[i+1]['timestamp_s']-row['timestamp_s'] if i+1<len(frames) else .05
        lines.append(f'duration {dt:.9f}')
    lines.append(lines[-3])
    lines.append('option framerate 1000')
    concat.write_text('\n'.join(lines)+'\n',encoding='utf8')
    output=root/'driving.mp4'; temporary=root/'driving.encoding.mp4'
    command=[str(ffmpeg),'-hide_banner','-loglevel','error','-y','-safe','0','-f','concat','-i',str(concat),
             '-fps_mode','vfr','-vf','pad=ceil(iw/2)*2:ceil(ih/2)*2','-c:v','libx264','-threads','1',
             '-preset','veryfast','-crf','20','-pix_fmt','yuv420p','-movflags','+faststart',str(temporary)]
    result=subprocess.run(command,capture_output=True,text=True,timeout=300,
                          creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
    if result.returncode: raise RuntimeError('Native video export failed: '+result.stderr[-1000:])
    temporary.replace(output)
    status={'status':'READY','source':'RECORDED_NATIVE_DRIVING_CAMERA' if native else 'TEST_FIXTURE','clock':'SIMULATION_TIME',
            'frames':len(frames),'first_timestamp_s':frames[0]['timestamp_s'],
            'last_timestamp_s':frames[-1]['timestamp_s'],'duration_s':frames[-1]['timestamp_s']-frames[0]['timestamp_s'],
            'video':'driving.mp4','sha256':hashlib.sha256(output.read_bytes()).hexdigest(),
            'frame_index':'telemetry/video-frames.jsonl',
            'clock_zero_timestamp_s':anchor if anchor is not None else frames[0]['timestamp_s'],
            'alignment_source':'ADMITTED_JOURNEY_START' if anchor is not None else 'FIRST_RECORDED_CAMERA_FRAME',
            'maximum_frame_gap_s':max((b['timestamp_s']-a['timestamp_s'] for a,b in zip(frames,frames[1:])),default=0.)}
    _status(root,status)
    return status


def _status(root, value):
    temporary=Path(root)/'video-status.tmp'
    temporary.write_text(json.dumps(value,indent=2),encoding='utf8')
    temporary.replace(Path(root)/'video-status.json')


def export_after_close(recorder):
    """Wait outside control, then encode with a single CPU worker."""
    def run():
        root=recorder.root
        try:
            _status(root,{'status':'WAITING_FOR_RECORDING'})
            while not recorder.closed: time.sleep(.05)
            if recorder.status().get('incomplete'): raise ValueError('Recording is incomplete; inspect recording-status.json')
            _status(root,{'status':'ENCODING'})
            export_video(root)
            from .storage_retention import retire_guided_history
            try:retire_guided_history(Path(__file__).resolve().parents[2])
            except (OSError,ValueError,RuntimeError) as error:
                (root/'storage-retention-warning.json').write_text(json.dumps({'error':str(error)}),encoding='utf8')
        except Exception as error:
            _status(root,{'status':'ERROR','error':str(error)})
        finally:
            with _lock:_workers.discard(threading.current_thread())
    worker=threading.Thread(target=run,daemon=True,name='native-video-export')
    with _lock:_workers.add(worker)
    worker.start()
    return worker
