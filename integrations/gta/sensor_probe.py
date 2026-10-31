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
ROOT=HERE/'.runtime-proof/gta-sensor-calibration-20261031/runs'
SOURCES=('sensor_probe.py','sensor_probe.cpp','sensor_shared.hpp','capture_addon.cpp','OstorhaDepth.fx',
         'sensor_uac.ps1','render-lock.json','bootstrap.py','preflight.py','owner_file_allowance.ps1',
         'uac_bootstrap.py','downloads/owner-file-allowance.json')
COMMAND=struct.Struct('<IHHQQ33sfff')
TICK=ctypes.windll.kernel32.GetTickCount64;TICK.restype=ctypes.c_ulonglong


def packet(owner,sequence,deadline,steer=0.,throttle=0.,brake=1.):
    if (not re.fullmatch('[0-9a-f]{32}',owner) or not 0<sequence<2**64 or not 0<=deadline<2**64
            or not all(math.isfinite(v) for v in (steer,throttle,brake))
            or not -1<=steer<=1 or not 0<=throttle<=1 or not 0<=brake<=1):
        raise ValueError('Invalid local command')
    return COMMAND.pack(0x4f475431,1,1,sequence,deadline,owner.encode()+b'\0',steer,throttle,brake)


def output_path(path,check='native-sensor-probe'):
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
    assets();source=(HERE/'sensor_probe.cpp').read_text();db=json.loads((CACHE/'natives.json').read_text())
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
             f'cl.exe /nologo /LD /MT /EHsc /std:c++17 /I"{HERE}" /I"{output}" "{HERE / "sensor_probe.cpp"}" '
             f'"{output / "ScriptHookV.lib"}" /Fo"{output / "sensor.obj"}" /Fe"{output / "OstorhaSensor.asi"}" && '
             f'cl.exe /nologo /LD /MT /EHsc /std:c++17 /I"{HERE}" /I"{CACHE / "sdk/include"}" "{HERE / "capture_addon.cpp"}" '
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
    rows=all_rows(output/'bridge.jsonl');captures=all_rows(output/'capture.jsonl')
    result={'camera_accepted':False,'depth_ray_accepted':False,'control_accepted':False,'contact_accepted':False,
            'sensor_probe_accepted':False,'capture_count':len(captures),'bridge_count':len(rows),
            'full_migration_accepted':False,'training_started':False,'coverage':'Center projection/range qualification only; whole-field/360-degree coverage not certified'}
    if not rows or not captures:return result
    if any(r['pid'] not in pids or r['run_id']!=run for r in rows+captures):
        result['error']='Native/renderer source identity mismatch';return result
    images=[];measured=[];acquisition=[]
    for c in captures:
        if not c['rgb_ok'] or not c['depth_ok']:continue
        base=output/('capture-%06d'%c['serial']);rgb=Path(str(base)+'.rgb');dep=Path(str(base)+'.depth')
        if rgb.stat().st_size!=640*360*3:continue
        image=np.fromfile(rgb,np.uint8).reshape(360,640,3)
        if len(images)<12:images.append(hashlib.sha256(image.tobytes()).hexdigest())
        acquisition.append(c['capture_end_ms']-c['capture_start_ms'])
        if c['stage'].startswith('RANGE') or c['stage']=='OCCLUSION':
            if c['phase_s']<1 or c['ray_status']!=2 or not c['ray_hit'] or c['ray_entity']!=c['target'] or not 0<c['near']<c['far']:continue
            x,y=c['project_xy']
            if abs(x-.5)>.03 or abs(y-.5)>.03:continue
            try:d=depth_value(dep,x,y)
            except ValueError:continue
            measured.append({**c,'raw_depth':d})
    valid=[c for c in captures if c.get('rgb_ok') and c.get('depth_ok')]
    ordered=all(b['native_frame']>a['native_frame'] and b['game_ms']>a['game_ms'] for a,b in zip(valid,valid[1:]))
    result.update(camera_accepted=len(valid)>=6 and len(set(images))>=2 and ordered,
                  acquisition_p50_ms=float(np.median(acquisition)) if acquisition else None,
                  acquisition_p95_ms=float(np.percentile(acquisition,95)) if acquisition else None)
    def convert(m,projection):
        d=m['raw_depth'];near=m['near'];far=m['far']
        if projection=='infinite_reversed_z':return near/d
        return near*far/(near+d*(far-near)) if projection=='reversed_z' else near*far/(far-d*(far-near))
    train=[m for m in measured if m['stage'] in ('RANGE10','RANGE30')]
    if len(train)>=6 and all(sum(m['stage']==stage for m in train)>=3 for stage in ('RANGE10','RANGE30')):
        mode=min(('standard_z','reversed_z','infinite_reversed_z'),key=lambda rev:np.median([abs(convert(m,rev)-m['ray_distance_m']) for m in train]))
        result['depth_projection']=mode
        by_stage={}
        for stage in ('RANGE10','RANGE30','RANGE60','RANGE100','RANGE80','RANGE120','OCCLUSION'):
            group=[m for m in measured if m['stage']==stage]
            errors=[abs(convert(m,mode)-m['ray_distance_m']) for m in group]
            limit=.5 if stage in ('RANGE10','RANGE30') else 1.
            good=len(group)>=3 and all(e<=max(limit,.05*m['ray_distance_m']) for e,m in zip(errors,group))
            by_stage[stage]={'count':len(group),'max_error_m':max(errors) if errors else None,'passed':bool(good)}
        result['depth_calibration']=by_stage;result['depth_ray_accepted']=all(v['passed'] for v in by_stage.values())
    def phase(name):return [r for r in rows if r['stage']==name and r['phase_s']>=.5]
    throttle=phase('THROTTLE');brake=phase('BRAKE');left=phase('LEFT');right=phase('RIGHT')
    displacement=float(np.linalg.norm(np.array(throttle[-1]['position'])-throttle[0]['position'])) if throttle else 0.
    def yaw_change(values):
        return float(np.unwrap(np.radians([v['heading_deg'] for v in values]))[-1]-np.unwrap(np.radians([v['heading_deg'] for v in values]))[0]) if len(values)>1 else 0.
    yl,yr=yaw_change(left),yaw_change(right)
    disconnect=[r for r in phase('DISCONNECT') if r['phase_s']>=1]
    stale=[r for r in phase('STALE_SENSORS') if r['phase_s']>=1]
    safe=lambda values,flag:bool(values and all(v.get(flag) and v['brake']>=.99 and v['throttle']==0 for v in values))
    result['physical_control']={'throttle_displacement_m':displacement,'max_speed_mps':max((r['speed_mps'] for r in throttle),default=0.),
                                'brake_final_mps':brake[-1]['speed_mps'] if brake else None,'left_yaw_rad':yl,'right_yaw_rad':yr,
                                'disconnect_safe':safe(disconnect,'lease_expired'),'sensor_stale_safe':safe(stale,'sensor_stale'),
                                'replays_rejected':max((r['rejected_replay'] for r in rows),default=0),
                                'delayed_rejected':max((r['rejected_stale'] for r in rows),default=0),
                                'foreign_owners_rejected':max((r['rejected_owner'] for r in rows),default=0),
                                'driver_survived':all(r.get('ped_alive') for r in rows if r['stage']!='INITIALIZING')}
    v=result['physical_control']
    result['control_accepted']=bool(displacement>=3 and v['max_speed_mps']>=2 and brake and v['brake_final_mps']<=.5
                                    and abs(yl)>=.05 and abs(yr)>=.05 and yl*yr<0 and v['disconnect_safe'] and v['sensor_stale_safe']
                                    and v['replays_rejected']>0 and v['delayed_rejected']>0 and v['foreign_owners_rejected']>0 and v['driver_survived'])
    result['contact_accepted']=physical_contact(rows)
    result['sensor_probe_accepted']=all(result[k] for k in ('camera_accepted','depth_ray_accepted','control_accepted','contact_accepted'))
    return result


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
        pids=set();seq=0;sock=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);foreign=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);deadline=min(time.monotonic()+430,request['deadline']-25)
        next_send=0;storage_measured=False
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
                if not storage_measured and capture and capture.get('serial',0)>=10:
                    elapsed=max(1.,(capture['capture_end_ms']-all_rows(output/'capture.jsonl')[0]['capture_start_ms'])/1000)
                    used=sum(p.stat().st_size for p in output.glob('capture-*.rgb'))+sum(p.stat().st_size for p in output.glob('capture-*.depth'))
                    projected=math.ceil(1.5*used/elapsed*max(0,deadline-now))+4*1024**3
                    storage={'measured_bytes':used,'elapsed_s':elapsed,'bytes_per_s':used/elapsed,'required_remaining_bytes':projected,
                             'free_bytes':shutil.disk_usage(output).free,'margin':1.5,'reserve_bytes':4*1024**3}
                    preflight.write_json(output/'storage-projection.json',storage);storage_measured=True
                    if storage['free_bytes']<projected:raise RuntimeError('Measured recording projection fails storage reserve')
                if phase=='DONE':break
                if phase in ('DRIVER_DIED','MODEL_FAILED','SPAWN_FAILED'):raise RuntimeError('Native qualification failed: '+phase)
                if not job.members():break
                time.sleep(.02)
        finally:sock.close();foreign.close()
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
    if (path.name!='sensor-request.json' or not elevated() or request.get('operation')!='OWNER_GTA_SENSOR_PROBE'
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
    request={'operation':'OWNER_GTA_SENSOR_PROBE','id':identifier,'owner':uuid.uuid4().hex,'port':port,'deadline':began+550,
             'sources':{s:boot.digest(HERE/s) for s in SOURCES},'binaries':{n:boot.digest(output/n) for n in ('OstorhaSensor.asi','OstorhaCapture.addon64')},
             'launcher_sha256':boot.digest(preflight.GAME.parent/'PlayGTAV.exe')}
    preflight.write_json(output/'sensor-request.json',request);code=1;timed_out=False
    try:
        with (output/'uac.stdout.log').open('wb') as stdout,(output/'uac.stderr.log').open('wb') as stderr:
            p=subprocess.run(['powershell.exe','-NoProfile','-NonInteractive','-File',str(HERE/'sensor_uac.ps1'),
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
    if args.build_only:build(output_path(args.output,'build-sensor-probe'));return 0
    return controller(args.output)


if __name__=='__main__':raise SystemExit(main())
