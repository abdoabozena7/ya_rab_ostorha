"""Conservative common-prefix export. Native truth is evaluation-only here."""
import copy
import hashlib
import json
import math
from pathlib import Path
import subprocess
import tempfile
import threading
import time
from PIL import Image, ImageDraw
from .storage_retention import open_telemetry

_lock=threading.Lock()
_workers={}


def rows(root,name):
    with open_telemetry(Path(root)/name) as stream:
        for line in stream:yield json.loads(line)


def evidence(root):
    return {r['frame_id']:r for r in rows(root,'telemetry/comparison-controls.jsonl') if r.get('kind')=='SCENARIO_FRAME'}


def comparable_frames(root):
    measured=evidence(root)
    anchor=None
    try:
        for event in rows(root,'events/events.jsonl'):
            if event.get('payload',{}).get('journey',{}).get('status')=='RUNNING':anchor=event['timestamp_s'];break
    except FileNotFoundError:pass
    for frame in rows(root,'telemetry/frames.jsonl'):
        native=measured.get(frame['frame_id'])
        if native is not None:
            if anchor is not None:native={**native,'elapsed_s':frame['timestamp_s']-anchor}
            if native.get('elapsed_s') is not None:yield {**frame,'comparison':native}


def divergence(a,b):
    """Stop at the first measured difference, including unaligned/missing data."""
    x,y=a['comparison'],b['comparison']
    if abs(x['elapsed_s']-y['elapsed_s'])>.026:return 'SIMULATION_CLOCK_MISMATCH'
    if x['scenario_id']!=y['scenario_id']:return 'SCENARIO_MISMATCH'
    av,bv=a['vehicle'],b['vehicle'];ap,bp=av['transform'],bv['transform']
    if math.dist(ap['position_m'],bp['position_m'])>.15:return 'EGO_POSITION_DIVERGED'
    if abs((ap['rotation_rad']['yaw']-bp['rotation_rad']['yaw']+math.pi)%(2*math.pi)-math.pi)>math.radians(.5):return 'EGO_HEADING_DIVERGED'
    if abs(av['speed_mps']-bv['speed_mps'])>.15:return 'EGO_SPEED_DIVERGED'
    if set(x['roles'])!=set(y['roles']):return 'VISIBLE_PARTICIPANTS_DIVERGED'
    for role,p in x['roles'].items():
        q=y['roles'][role]
        if math.dist(p[:3],q[:3])>.25 or abs((p[3]-q[3]+180)%360-180)>2:return 'VISIBLE_PARTICIPANT_MOTION_DIVERGED'
    return None


def common_prefix(first,second):
    result=[];reason='END_OF_VERIFIABLE_COMMON_EVIDENCE'
    first,second=iter(first),iter(second);a,b=next(first,None),next(second,None)
    # Controller warm-up can record a different number of held frames. Align
    # the overlapping held start only; never skip a moving/divergent frame.
    while a is not None and b is not None and abs(a['comparison']['elapsed_s']-b['comparison']['elapsed_s'])>.026:
        if a['comparison']['elapsed_s']<min(0.,b['comparison']['elapsed_s']):a=next(first,None)
        elif b['comparison']['elapsed_s']<min(0.,a['comparison']['elapsed_s']):b=next(second,None)
        else:return [],'SIMULATION_CLOCK_MISMATCH'
    while a is not None and b is not None:
        reason=divergence(a,b)
        if reason:break
        result.append(a)
        a,b=next(first,None),next(second,None)
    return result,reason or 'END_OF_VERIFIABLE_COMMON_EVIDENCE'


def write_status(root,value):
    target=Path(root)/'shared-perception-status.json';temporary=target.with_suffix('.tmp')
    temporary.write_text(json.dumps(value,indent=2),encoding='utf8')
    for attempt in range(12):
        try:temporary.replace(target);return
        except PermissionError:
            if attempt==11:raise
            time.sleep(.01*(attempt+1))


def export_shared(pair,*,allow_test_data=False,encode=None):
    roots={m:Path(pair['runs'][m]['recording']) for m in ('NORMAL','ROBOSPHERE')};root=roots['NORMAL']
    for folder in roots.values():
        metadata=json.loads((folder/'metadata.json').read_text(encoding='utf8'))
        if not allow_test_data and (metadata.get('provider')!='carla' or metadata.get('data_origin')!='REAL_SIMULATION'):
            raise ValueError('The shared view requires two original native recordings')
        state=json.loads((folder/'recording-status.json').read_text(encoding='utf8'))
        if not state.get('finalized') or state.get('incomplete'):raise ValueError('Both recordings must be finalized and complete')
    frames,reason=common_prefix(comparable_frames(root),comparable_frames(roots['ROBOSPHERE']))
    if not frames:raise ValueError('No verified common camera prefix: '+reason)
    detections={r['result']['frame_id']:r['result'] for r in rows(root,'telemetry/comparison-controls.jsonl') if r.get('kind')=='CAMERA_DETECTIONS'}
    session=json.loads((root/'metadata.json').read_text(encoding='utf8'))['config']['session_id']
    missing=[]
    for frame in frames:
        sensor=next((s for s in frame['sensors'] if s['sensor_id']=='frontCamera' and s['frame_id']==frame['frame_id']),None)
        if sensor and not detections.get(sensor['frame_id']):missing.append(sensor)
    # This is an export worker after recording. No inference, image preparation
    # or subprocess waits enter the synchronized control path.
    if missing and not allow_test_data:
        project=Path(__file__).resolve().parents[2]
        (root/'shared-detection-job.json').write_text(json.dumps({'session_id':session,'frames':missing,
            'detector_profile':pair['runs']['NORMAL'].get('setup',{}).get('perception_profile')}),encoding='utf8')
        process=subprocess.run([str(project/'.venv-perception/Scripts/python.exe'),'-m','backend.computer_vision.shared_export',str(root)],
            cwd=project,capture_output=True,text=True,timeout=180,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
        if process.returncode:raise ValueError('Shared camera detection export failed: '+process.stderr[-500:])
        detections.update({r['frame_id']:r for r in rows(root,'telemetry/shared-camera-detections.jsonl')})
    if encode is None:
        from imageio_ffmpeg import get_ffmpeg_exe
        from .driving_video import _encode_video
        encode=lambda rows,name:_encode_video(root,rows,get_ffmpeg_exe(),name)
    derived=[];detected=0
    with tempfile.TemporaryDirectory(prefix='shared-view-',dir=root) as temporary:
        for frame in frames:
            sensor=next((s for s in frame['sensors'] if s['sensor_id']=='frontCamera' and s['frame_id']==frame['frame_id']),None)
            if sensor is None:break # No substitute or a previous image at a new timestamp.
            path=(root/sensor['asset']['path']).resolve()
            if root.resolve() not in path.parents or hashlib.sha256(path.read_bytes()).hexdigest()!=sensor['asset']['sha256']:
                raise ValueError('Shared front-camera asset checksum mismatch')
            with Image.open(path) as image:image=image.convert('RGB')
            result=detections.get(sensor['frame_id']);drawing=ImageDraw.Draw(image)
            if (result and result.get('session_id')==session and abs(result['timestamp_s']-sensor['timestamp_s'])<1e-6
                    and result.get('source_image_sha256')==sensor['asset']['sha256']):
                detected+=draw_detections(drawing,image.size,result)
            target=Path(temporary)/f'{len(derived):08d}.jpg';image.save(target,quality=95)
            derived.append({'timestamp_s':sensor['timestamp_s'],'asset':{'path':str(target.relative_to(root))}})
        if not derived:raise ValueError('The common prefix has no synchronized front-camera images')
        encode(derived,'shared-perception.mp4')
    output=root/'shared-perception.mp4'
    status={'status':'READY','pair_id':pair['pair_id'],'recording':str(root),'video':output.name,
        'sha256':hashlib.sha256(output.read_bytes()).hexdigest(),'frames':len(derived),'detection_boxes':detected,
        'start_elapsed_s':frames[0]['comparison']['elapsed_s'],'end_elapsed_s':frames[len(derived)-1]['comparison']['elapsed_s'],
        'duration_s':derived[-1]['timestamp_s']-derived[0]['timestamp_s']+.05,'last_frame_hold_s':.05,
        'boundary_reason':reason,'source':'VERIFIED_COMMON_PREFIX_NATIVE_FRONT_CAMERA',
        'tolerances':{'position_m':.15,'heading_deg':.5,'speed_mps':.15,'participant_position_m':.25,'participant_heading_deg':2.},
        'detection_alignment':'EXACT_SESSION_FRAME_TIMESTAMP_IMAGE_CHECKSUM_ONLY',
        'derived_detection_index':'telemetry/shared-camera-detections.jsonl' if missing and not allow_test_data else None}
    write_status(root,status);return status


def draw_detections(drawing,size,result):
    width,height=size;count=0
    for box in result.get('detections',[]):
        if box.get('confidence',0)<.65 or box.get('class') not in ('person','car','truck','bus','motorcycle','bicycle'):continue
        bounds=box.get('xyxy',[])
        if len(bounds)!=4 or not all(math.isfinite(v) for v in bounds):continue
        x1,y1,x2,y2=bounds
        rw,rh=result.get('width',width),result.get('height',height)
        if not (0<=x1<x2<=rw and 0<=y1<y2<=rh):continue
        drawing.rectangle((x1*width/rw,y1*height/rh,x2*width/rw,y2*height/rh),outline='#FFB7B2' if box['class']=='person' else '#83d9df',width=2)
        count+=1
    return count


def ensure_shared(pair,*,retry=False):
    if not (pair.get('manifest') or {}).get('comparison_scenario'):return None
    if not all(pair.get('runs',{}).get(m,{}).get('recording') and pair['runs'][m].get('status')!='RUNNING' for m in ('NORMAL','ROBOSPHERE')):
        return {'status':'WAITING_FOR_RECORDINGS'}
    root=Path(pair['runs']['NORMAL']['recording']);key=str(root.resolve())
    with _lock:
        try:status=json.loads((root/'shared-perception-status.json').read_text(encoding='utf8'))
        except (OSError,ValueError):status=None
        if status and status.get('pair_id')==pair['pair_id'] and (status.get('status')=='READY' or status.get('status')=='ERROR' and not retry):return status
        if key in _workers:return status or {'status':'ENCODING','recording':str(root)}
        status={'status':'ENCODING','pair_id':pair['pair_id'],'recording':str(root)};write_status(root,status)
        saved=copy.deepcopy(pair)
        def run():
            try:export_shared(saved)
            except Exception as error:write_status(root,{**status,'status':'ERROR','error':str(error)})
            finally:
                with _lock:_workers.pop(key,None)
        worker=threading.Thread(target=run,daemon=True,name='shared-perception-export');_workers[key]=worker;worker.start()
        return status
