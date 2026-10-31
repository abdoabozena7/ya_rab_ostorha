"""Bounded native RGB/depth/control qualification. No training or CARLA cleanup."""
import argparse
import ctypes
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import socket
import struct
import subprocess
import time
import uuid
import numpy as np
import bootstrap as boot
import preflight
from uac_bootstrap import elevated

HERE=Path(__file__).resolve().parent
CACHE=HERE/'downloads/render'
ROOT=HERE/'.runtime-proof/gta-field-motion-20261031/runs'
SOURCES=('scene_probe.py','scene_probe.cpp','sensor_shared.hpp','capture_addon.cpp','OstorhaDepth.fx',
         'scene_uac.ps1','render-lock.json','bootstrap.py','preflight.py','owner_file_allowance.ps1',
         'uac_bootstrap.py','downloads/owner-file-allowance.json','live_vision.py','vision_probe.py','vision-lock.json')
COMMAND=struct.Struct('<IHHQQ33sfff')
TICK=ctypes.windll.kernel32.GetTickCount64;TICK.restype=ctypes.c_ulonglong


def packet(owner,sequence,deadline,steer=0.,throttle=0.,brake=1.):
    if (not re.fullmatch('[0-9a-f]{32}',owner) or not 0<sequence<2**64 or not 0<=deadline<2**64
            or not all(math.isfinite(v) for v in (steer,throttle,brake))
            or not -1<=steer<=1 or not 0<=throttle<=1 or not 0<=brake<=1):
        raise ValueError('Invalid local command')
    return COMMAND.pack(0x4f475431,1,1,sequence,deadline,owner.encode()+b'\0',steer,throttle,brake)


def output_path(path,check='native-scene-probe'):
    for part in (path,*path.parents):
        if part.exists() and getattr(part.stat(),'st_file_attributes',0)&0x400:raise ValueError('Reparse proof path')
    path=path.resolve()
    if path.parent!=(ROOT/check).resolve() or not re.fullmatch(r'\d{8}T\d{6}-[0-9a-f]{10}',path.name):
        raise ValueError('Outside scoped proof run')
    return path


def assets():
    lock=json.loads((HERE/'render-lock.json').read_text())
    if lock['version']!='6.8.0' or lock['api_version']!=20:raise ValueError('Wrong capture dependency version')
    for name,info in lock['payloads'].items():
        if boot.digest(CACHE/name)!=info['sha256']:raise ValueError('Pinned payload changed: '+name)
        if name.endswith('.hpp') and boot.digest(CACHE/'sdk/include'/name)!=info['sha256']:
            raise ValueError('Actual compiler header changed: '+name)
    if boot.digest(CACHE/'ReShade64.dll')!=lock['runtime_sha256']:raise ValueError('Runtime changed')
    return lock


def build(output):
    assets();source=(HERE/'scene_probe.cpp').read_text();db=json.loads((CACHE/'natives.json').read_text())
    known={d['name']:h for group in db.values() for h,d in group.items()}
    names=sorted(set(re.findall(r'N::([A-Z_0-9]+)',source)))
    (output/'native_hashes.hpp').write_text('#pragma once\nnamespace N {\n'+''.join(
        'constexpr unsigned long long '+name+'='+known[name]+'ULL;\n' for name in names)+'}\n')
    exports=['?scriptRegister@@YAXPEAUHINSTANCE__@@P6AXXZ@Z','?scriptUnregister@@YAXPEAUHINSTANCE__@@@Z',
             '?scriptWait@@YAXK@Z','?nativeInit@@YAX_K@Z','?nativePush64@@YAX_K@Z','?nativeCall@@YAPEA_KXZ']
    definition=output/'ScriptHookV.def';definition.write_text('LIBRARY ScriptHookV.dll\nEXPORTS\n'+'\n'.join(exports)+'\n')
    for path in (HERE,output,boot.VCVARS,CACHE):
        if any(c in str(path) for c in '&|<>^%!"\r\n'):raise ValueError('Unsafe compiler path')
    command=(f'call "{boot.VCVARS}" >nul && lib.exe /nologo /machine:x64 /def:"{definition}" /out:"{output / "ScriptHookV.lib"}" && '
             f'cl.exe /nologo /LD /MT /EHsc /we4129 /std:c++17 /I"{HERE}" /I"{output}" "{HERE / "scene_probe.cpp"}" '
             f'"{output / "ScriptHookV.lib"}" /Fo"{output / "sensor.obj"}" /Fe"{output / "OstorhaSensor.asi"}" && '
             f'cl.exe /nologo /LD /MT /EHsc /we4129 /std:c++17 /I"{HERE}" /I"{CACHE / "sdk/include"}" "{HERE / "capture_addon.cpp"}" '
             f'/Fo"{output / "capture.obj"}" /Fe"{output / "OstorhaCapture.addon64"}"')
    done=subprocess.run('cmd.exe /d /s /c "'+command+'"',cwd=output,capture_output=True,timeout=100)
    (output/'build.stdout.log').write_bytes(done.stdout);(output/'build.stderr.log').write_bytes(done.stderr)
    result={'build_available':done.returncode==0,'installer_executed':False,'runtime_sha256':boot.digest(CACHE/'ReShade64.dll')}
    preflight.write_json(output/'build-result.json',result)
    if done.returncode:raise RuntimeError('C++ build failed; inspect actual build logs')
    shader=output/'shaders';shader.mkdir(exist_ok=True);(shader/'OstorhaDepth.fx').write_bytes((HERE/'OstorhaDepth.fx').read_bytes())
    (output/'preset.ini').write_text('Techniques=OstorhaDepth@OstorhaDepth.fx\nTechniqueSorting=OstorhaDepth@OstorhaDepth.fx\n')
    return result


def latest(path):
    try:
        with path.open('rb') as stream:
            stream.seek(max(0,path.stat().st_size-16384));lines=stream.read().decode('utf8').splitlines()
        for line in reversed(lines):
            try:return json.loads(line)
            except ValueError:continue
    except OSError:pass
    return None


def all_rows(path):
    try:return [json.loads(line) for line in path.read_text().splitlines() if line]
    except (OSError,ValueError):return []


def remove_owned(path,expected):
    until=time.monotonic()+8
    while path.exists():
        if boot.digest(path)!=expected:raise ValueError('Owned temporary file changed: '+str(path))
        try:path.unlink();return
        except PermissionError:
            if time.monotonic()>=until:raise
            time.sleep(.25)


def physical_contact(rows):
    impact=[r for r in rows if r['stage']=='COLLISION']
    return bool(len(impact)>=3 and any(r.get('contact') for r in impact)
                and all(r.get('ped_alive') for r in impact) and any(r.get('target_contact') for r in impact)
                and max(r['body_health'] for r in impact)-min(r['body_health'] for r in impact)>=.1
                and max(r['speed_mps'] for r in impact)-min(r['speed_mps'] for r in impact)>=.5)


def depth_value(path,x,y):
    depth=np.fromfile(path,np.float32)
    if depth.size!=640*360:raise ValueError('Missing/malformed raw depth')
    if not 0<=x<1 or not 0<=y<1:raise ValueError('Invalid evaluated projection')
    px,py=int(x*640),int(y*360)
    roi=depth.reshape(360,640)[max(0,py-2):py+3,max(0,px-2):px+3]
    valid=roi[np.isfinite(roi)&(roi>1e-8)&(roi<1-1e-8)]
    if valid.size<9:raise ValueError('Unknown depth remains unknown')
    return float(np.median(valid))


def evaluate(output,pids,run):
    rows=all_rows(output/'bridge.jsonl');captures=all_rows(output/'capture.jsonl');geometry=all_rows(output/'geometry.jsonl');actors=all_rows(output/'actors-eval.jsonl')
    vision=all_rows(output/'live-vision.jsonl')
    result={'sensor_probe_accepted':False,'field_accepted':False,'rays_accepted':False,'motion_accepted':False,
            'live_vision_accepted':False,'full_migration_accepted':False,'training_started':False}
    raw={p.name:{'sha256':boot.digest(p),'bytes':p.stat().st_size} for pattern in ('capture-*.rgb','capture-*.depth') for p in output.glob(pattern)}
    preflight.write_json(output/'raw-manifest.json',{'run_id':run,'files':raw})
    if not rows or not captures or not geometry or not actors:return result
    if any(r['pid'] not in pids or r['run_id']!=run for r in rows+captures):raise ValueError('Native/capture identity mismatch')
    fields={name:[] for name in ('FIELD_M25','FIELD_M15','FIELD_P15','FIELD_P25','FIELD_M35','FIELD_P35')}
    for c in captures:
        if c['stage'] not in fields or c['phase_s']<1 or c['ray_status']!=2 or not c['ray_hit'] or c['ray_entity']!=c['target']:continue
        try:
            raw=depth_value(output/('capture-%06d.depth'%c['serial']),*c['project_xy'])
            near,far=c['near'],c['far'];z=near*far/(near+raw*(far-near))
            pose=min(rows,key=lambda r:abs(r['host_ms']-c['native_host_ms']));focal=360/(2*math.tan(math.radians(pose['fov'])/2))
            x,y=c['project_xy'];distance=z*math.sqrt(1+((x-.5)*640/focal)**2+((y-.5)*360/focal)**2)
            error=abs(distance-c['ray_distance_m'])
            fields[c['stage']].append({'serial':c['serial'],'error_m':error,'native_range_m':c['ray_distance_m'],
                                      'accepted':error<=max(.5,.05*c['ray_distance_m'])})
        except (OSError,ValueError,KeyError):continue
    result['field_samples']=fields;result['field_accepted']=all(len(v)>=10 and all(x['accepted'] for x in v) for v in fields.values())
    ring=[g for g in geometry if g['stage']=='RING' and g['phase_s']>=1];ring_ids=set(next((a['ring_ids'] for a in actors if a['stage']=='RING'),[]))
    hits={int(ray[8]) for g in ring for ray in g['rays'] if known_ray(ray) and ray[3]}
    scans=[g['scan_ms'] for g in geometry];scan95=float(np.percentile(scans,95))
    complete=bool(ring and all(len(g['rays'])==1080 and {r[0] for r in g['rays']}==set(range(0,360,2)) for g in ring))
    result['rays_accepted']=bool(complete and len(ring_ids)==8 and ring_ids<=hits and scan95<=150)
    result['rays']={'azimuth_step_deg':2,'elevations_deg':[-6,-2,-.5,0,2,6],'rays_per_scan':1080,
       'maximum_range_m':100,'scan_p95_ms':scan95,'scan_max_ms':max(scans),'ring_actor_count':len(ring_ids),
       'ring_actors_intersected':len(ring_ids&hits),'space_between_rays':'UNKNOWN','pending_or_failed_query':'UNKNOWN',
       'range_rate':'NOT_MEASURED','actor_handles':'EVALUATION_ONLY','continuous_coverage_certified':False}
    movement={}
    for phase in ('MOVE_AWAY','MOVE_APPROACH','PED_CROSS'):
        samples=[a for a in actors if a['stage']==phase and a['phase_s']>=.5]
        displacement=max((float(np.linalg.norm(np.array(a['position'])-samples[0]['position'])) for a in samples),default=0)
        movement[phase]={'samples':len(samples),'displacement_m':displacement,'alive':bool(samples and all(a['alive'] for a in samples))}
    settled=[r for r in rows if r['phase_s']>=1]
    result['motion']=movement;result['wanted_levels']=sorted({r.get('wanted_level',-1) for r in settled})
    result['motion_accepted']=bool(all(v['samples']>=10 and v['displacement_m']>2 and v['alive'] for v in movement.values())
        and settled and all(r['ped_alive'] for r in settled) and result['wanted_levels']==[0])
    phases_seen={r['stage'] for r in vision if r['detections']};unique=len({r['serial'] for r in vision})
    result['live_vision_accepted']=live_qualified(vision)
    result['live_vision']={'processed_frames':unique,'captured_frames':len(captures),'phases_with_detection':sorted(phases_seen),
         'inference_p95_ms':float(np.percentile([r['inference_ms'] for r in vision],95)) if vision else None,
         'native_snapshot_to_result_p95_ms':float(np.percentile([r['snapshot_age_ms'] for r in vision],95)) if vision else None,
         'source':'actual asynchronous native capture and existing ONNX, not synchronous simulation steps'}
    raw={p.name:{'sha256':boot.digest(p),'bytes':p.stat().st_size} for pattern in ('capture-*.rgb','capture-*.depth') for p in output.glob(pattern)}
    preflight.write_json(output/'raw-manifest.json',{'run_id':run,'files':raw})
    result['sensor_probe_accepted']=all(result[k] for k in ('field_accepted','rays_accepted','motion_accepted','live_vision_accepted'))
    return result


def known_ray(ray):
    if len(ray)!=9 or ray[2]!=2 or not all(math.isfinite(float(v)) for v in ray):return False
    return bool((ray[3]==1 and 0<=ray[4]<=100) or (ray[3]==0 and abs(ray[4]-100)<.001))


def live_qualified(rows):
    return bool(len({r['serial'] for r in rows})>=40 and all(r['execution_provider']=='DmlExecutionProvider' for r in rows)
                and all(any(r['stage']==phase and any(d['class'] in labels for d in r['detections']) for r in rows)
                    for phase,labels in (('MOVE_AWAY',{'bus','truck','car'}),('MOVE_APPROACH',{'bus','truck','car'}),('PED_CROSS',{'person'}))))


def native(output,request):
    result={'sensor_probe_accepted':False,'cleanup_confirmed':False,'files_restored':False,
            'full_migration_accepted':False,'training_started':False,'native_runtime_seconds':0.}
    installed=[];job=None;process=None;reservation=None;began=None;before=None
    lock=HERE/'downloads/native-bootstrap.lock'
    with lock.open('x') as f:f.write(str(os.getpid()))
    try:
        if boot.existing_native():raise RuntimeError('Another native simulator/game owns the host')
        allowance=boot.load_owner_allowance();boot.require_clean_security(boot.security_observation(),allowance)
        assets();candidate=boot.inspect_candidate();before=preflight.protected_inventory()
        preflight.write_json(output/'protected-before.json',before)
        from zipfile import ZipFile
        with ZipFile(boot.CANDIDATE) as z:
            payload={'ScriptHookV.dll':z.read('bin/ScriptHookV.dll'),'xinput1_4.dll':z.read('bin/xinput1_4.dll')}
        payload.update({'OstorhaSensor.asi':(output/'OstorhaSensor.asi').read_bytes(),
                        'OstorhaCapture.addon64':(output/'OstorhaCapture.addon64').read_bytes(),
                        'dxgi.dll':(CACHE/'ReShade64.dll').read_bytes(),
                        'ReShade.ini':('[GENERAL]\nEffectSearchPaths='+str(output/'shaders')+'\nTextureSearchPaths='+str(output)+
                          '\nPresetPath='+str(output/'preset.ini')+'\n[OVERLAY]\nTutorialProgress=4\nShowFPS=0\nShowClock=0\n').encode()})
        game=preflight.GAME.parent
        if list(game.glob('*.asi')) or list(game.glob('*.addon*')) or any((game/n).exists() for n in ('dinput8.dll',*payload)):
            raise RuntimeError('Existing proxy/addon/config requires inspection; nothing overwritten')
        for name,data in payload.items():
            p=game/name
            with p.open('xb') as f:f.write(data)
            installed.append((p,hashlib.sha256(data).hexdigest()))
        preflight.write_json(output/'install-manifest.json',{'new_files':[{'path':str(p),'sha256':h} for p,h in installed]})
        forecast=math.ceil(1.5*640*360*7*10*120)+4*1024**3
        if shutil.disk_usage(output).free<forecast:raise RuntimeError('Insufficient capture storage with50% margin and4GiB reserve')
        ledger=boot.RuntimeBudget(HERE/'downloads/native-runtime-ledger.json');reservation=ledger.reserve(request['id']+'-native');began=time.monotonic()
        job=boot.OwnedJob();env={**os.environ,'OSTORHA_SENSOR_OUTPUT':str(output),'OSTORHA_BOOTSTRAP_ID':request['id'],
                               'OSTORHA_SENSOR_OWNER':request['owner'],'OSTORHA_SENSOR_PORT':str(request['port'])}
        process=subprocess.Popen([str(game/'PlayGTAV.exe')],cwd=game,env=env)
        try:job.assign(process)
        except Exception:process.terminate();process.wait(timeout=15);raise
        preflight.write_json(output/'native-progress.json',{'stage':'LAUNCHED','launcher_pid':process.pid,'request_id':request['id']})
        vision_stdout=(output/'live-vision.stdout.log').open('wb');vision_stderr=(output/'live-vision.stderr.log').open('wb')
        vision=subprocess.Popen([str(preflight.PROJECT/'.venv-perception-dml/Scripts/python.exe'),'-B',str(HERE/'live_vision.py'),'--output',str(output)],cwd=preflight.PROJECT,stdout=vision_stdout,stderr=vision_stderr)
        pids=set();seq=0;sock=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);foreign=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);deadline=min(time.monotonic()+430,request['deadline']-25)
        next_send=0;storage_measured=False;world_ready=False;completed=False;world_deadline=time.monotonic()+150
        try:
            while time.monotonic()<deadline:
                for pid in job.members():
                    if boot.process_image(pid)==preflight.GAME.resolve():pids.add(pid)
                row=latest(output/'bridge.jsonl');phase=row.get('stage','WAIT') if row else 'WAIT'
                if (output/'cancel-sensor-probe').exists():break
                drop=output/'drop-capture'
                if phase=='STALE_SENSORS':drop.touch(exist_ok=True)
                elif drop.exists():drop.unlink()
                now=time.monotonic()
                if now>=next_send and phase!='DISCONNECT':
                    seq+=1;steer=0.;throttle=0.;brake=1.
                    if phase in ('THROTTLE','LEFT','RIGHT','STALE_SENSORS','COLLISION'):
                        throttle=.55 if phase in ('THROTTLE','COLLISION') else .35;brake=0.
                        steer=-.5 if phase=='LEFT' else .5 if phase=='RIGHT' else 0.
                    expiry=TICK()+250 if phase!='DELAYED' else TICK()-100
                    raw=packet(request['owner'],seq,expiry,steer,throttle,brake)
                    sock.sendto(raw,('127.0.0.1',request['port']))
                    if phase=='REPLAY':sock.sendto(raw,('127.0.0.1',request['port']))
                    if phase=='FOREIGN_OWNER':foreign.sendto(packet(request['owner'],seq+100000,TICK()+250,1.,1.,0.),('127.0.0.1',request['port']))
                    next_send=now+.05
                capture=latest(output/'capture.jsonl')
                if capture:world_ready=True
                if not world_ready and time.monotonic()>world_deadline:raise RuntimeError('Story world/render not ready within150s; owner interaction may be needed')
                if not storage_measured and capture and capture.get('serial',0)>=10:
                    elapsed=max(1.,(capture['capture_end_ms']-all_rows(output/'capture.jsonl')[0]['capture_start_ms'])/1000)
                    used=sum(p.stat().st_size for p in output.glob('capture-*.rgb'))+sum(p.stat().st_size for p in output.glob('capture-*.depth'))
                    projected=math.ceil(1.5*used/elapsed*max(0,deadline-now))+4*1024**3
                    storage={'measured_bytes':used,'elapsed_s':elapsed,'bytes_per_s':used/elapsed,'required_remaining_bytes':projected,
                             'free_bytes':shutil.disk_usage(output).free,'margin':1.5,'reserve_bytes':4*1024**3}
                    preflight.write_json(output/'storage-projection.json',storage);storage_measured=True
                    if storage['free_bytes']<projected:raise RuntimeError('Measured recording projection fails storage reserve')
                if phase=='DONE':completed=True;break
                if phase in ('DRIVER_DIED','MODEL_FAILED','SPAWN_FAILED'):raise RuntimeError('Native qualification failed: '+phase)
                if not job.members():break
                time.sleep(.02)
        finally:
            sock.close();foreign.close();(output/'stop-live-vision').touch()
            try:vision.wait(timeout=10)
            except subprocess.TimeoutExpired:vision.kill();vision.wait(timeout=5)
            vision_stdout.close();vision_stderr.close()
        if not completed:raise RuntimeError('Native scene program did not reach DONE')
        result['cleanup_confirmed']=job.stop()
        if not result['cleanup_confirmed']:raise RuntimeError('Owned native job did not close before evidence analysis')
        job=None
        result.update(evaluate(output,pids,request['id']),owned_game_pids=sorted(pids))
    except Exception as error:result['error']=str(error)
    finally:
        preflight.write_json(output/'native-progress.json',{**result,'stage':'STOPPING_OWNED_JOB'})
        if job:
            try:result['cleanup_confirmed']=job.stop()
            except Exception as error:result['cleanup_error']=str(error)
        elif process is None:result['cleanup_confirmed']=True
        if began is not None:
            result['native_runtime_seconds']=time.monotonic()-began
            try:ledger.finish(reservation,result['native_runtime_seconds'])
            except Exception as error:result['budget_error']=str(error)
        if result['cleanup_confirmed']:
            for path,expected in installed:
                try:
                    if path.exists():remove_owned(path,expected)
                except (OSError,ValueError) as error:result['restore_error']=str(error)
            result['files_restored']=all(not p.exists() for p,_ in installed)
            if result['files_restored']:lock.unlink()
        if before is not None:
            try:
                after=preflight.protected_inventory();result['protected_inputs_unchanged']=before==after
                preflight.write_json(output/'protected-after.json',after)
            except Exception as error:result['protected_inventory_error']=str(error)
        for name in ('ScriptHookV.log','asiloader.log','ReShade.log'):
            source=preflight.GAME.parent/name
            if source.is_file():(output/name).write_bytes(source.read_bytes())
        preflight.write_json(output/'sensor-result.json',result)
    return result


def worker(path):
    output=output_path(path.parent);request=json.loads(path.read_text())
    if (path.name!='sensor-request.json' or not elevated() or request.get('operation')!='OWNER_GTA_SCENE_PROBE'
            or not time.monotonic()<request['deadline']<=time.monotonic()+550
            or set(request['sources'])!=set(SOURCES) or not re.fullmatch('[0-9a-f]{32}',request['id'])
            or not re.fullmatch('[0-9a-f]{32}',request['owner']) or type(request['port']) is not int or not 1<=request['port']<=65535
            or set(request['binaries'])!={'OstorhaSensor.asi','OstorhaCapture.addon64'}):raise ValueError('Invalid/expired/unapproved elevated worker')
    for source,value in request['sources'].items():
        if boot.digest(HERE/source)!=value:raise ValueError('Worker source changed')
    for name,value in request['binaries'].items():
        if name not in ('OstorhaSensor.asi','OstorhaCapture.addon64') or boot.digest(output/name)!=value:raise ValueError('Built probe changed')
    if boot.digest(preflight.GAME.parent/'PlayGTAV.exe')!=request['launcher_sha256']:raise ValueError('Launcher changed')
    result=native(output,request);result['uac_worker_elevated']=True;preflight.write_json(output/'sensor-result.json',result)
    return int(not (result['sensor_probe_accepted'] and result['cleanup_confirmed'] and result['files_restored'] and result.get('protected_inputs_unchanged') and not result.get('budget_error')))


def controller(output):
    output=output_path(output)
    if elevated():raise RuntimeError('Use ordinary controller and normal owner UAC')
    if boot.existing_native():raise RuntimeError('Native host occupied')
    if not boot.load_owner_allowance():raise RuntimeError('No exact-file owner allowance')
    build(output);identifier=uuid.uuid4().hex;ledger=HERE/'downloads/native-runtime-ledger.json'
    budget=boot.RuntimeBudget(ledger)
    if budget.state['charged_seconds']+1200>10800:raise RuntimeError('Insufficient original runtime grant')
    parent=budget.reserve(identifier+'-uac');began=time.monotonic()
    with socket.socket(socket.AF_INET,socket.SOCK_DGRAM) as choice:choice.bind(('127.0.0.1',0));port=choice.getsockname()[1]
    request={'operation':'OWNER_GTA_SCENE_PROBE','id':identifier,'owner':uuid.uuid4().hex,'port':port,'deadline':began+550,
             'sources':{s:boot.digest(HERE/s) for s in SOURCES},'binaries':{n:boot.digest(output/n) for n in ('OstorhaSensor.asi','OstorhaCapture.addon64')},
             'launcher_sha256':boot.digest(preflight.GAME.parent/'PlayGTAV.exe')}
    preflight.write_json(output/'sensor-request.json',request);code=1;timed_out=False
    try:
        with (output/'uac.stdout.log').open('wb') as stdout,(output/'uac.stderr.log').open('wb') as stderr:
            p=subprocess.run(['powershell.exe','-NoProfile','-NonInteractive','-File',str(HERE/'scene_uac.ps1'),
                              '-RequestPath',str(output/'sensor-request.json')],stdout=stdout,stderr=stderr,timeout=600)
        code=p.returncode
    except subprocess.TimeoutExpired:timed_out=True;(output/'cancel-sensor-probe').touch()
    result=json.loads((output/'sensor-result.json').read_text()) if (output/'sensor-result.json').exists() else {
        'sensor_probe_accepted':False,'cleanup_confirmed':False,'files_restored':False,'training_started':False,'full_migration_accepted':False,
        'error':'No final elevated native result; inspect UAC/progress streams'}
    elapsed=time.monotonic()-began
    if not timed_out and elapsed<=600:
        current=boot.RuntimeBudget(ledger);item=next(x for x in current.state['reservations'] if x['id']==parent['id'])
        current.finish(item,max(0.,elapsed-float(result.get('native_runtime_seconds',0))))
    result.update(uac_wall_seconds=elapsed,budget=json.loads(ledger.read_text()),uac_controller_elevated=False)
    preflight.write_json(output/'sensor-result.json',result);print(json.dumps(result,indent=2))
    return 0 if code==0 and result['sensor_probe_accepted'] else 1


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--output',type=Path);parser.add_argument('--worker',type=Path);parser.add_argument('--build-only',action='store_true')
    args=parser.parse_args()
    if args.worker:return worker(args.worker)
    if args.build_only:build(output_path(args.output,'build-scene-probe'));return 0
    return controller(args.output)


if __name__=='__main__':raise SystemExit(main())
