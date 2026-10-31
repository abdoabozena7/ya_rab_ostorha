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
from standard_launch import token_elevation, compatibility, LAUNCHER

HERE=Path(__file__).resolve().parent
CACHE=HERE/'downloads/render'
ROOT=HERE/'.runtime-proof/gta-urban-junction-20261031/runs'
SOURCES=('urban_probe.py','urban_probe.cpp','sensor_shared.hpp','capture_addon.cpp','OstorhaDepth.fx',
         'urban-scenario.json','render-lock.json','bootstrap.py','preflight.py','owner_file_allowance.ps1',
         'uac_bootstrap.py','downloads/owner-file-allowance.json','urban_vision.py','vision_probe.py','vision-lock.json')
GAME_TOKENS={}
COMMAND=struct.Struct('<IHHQQ33sfff')
TICK=ctypes.windll.kernel32.GetTickCount64;TICK.restype=ctypes.c_ulonglong


def packet(owner,sequence,deadline,steer=0.,throttle=0.,brake=1.):
    if (not re.fullmatch('[0-9a-f]{32}',owner) or not 0<sequence<2**64 or not 0<=deadline<2**64
            or not all(math.isfinite(v) for v in (steer,throttle,brake))
            or not -1<=steer<=1 or not 0<=throttle<=1 or not 0<=brake<=1):
        raise ValueError('Invalid local command')
    return COMMAND.pack(0x4f475431,1,1,sequence,deadline,owner.encode()+b'\0',steer,throttle,brake)


def output_path(path,check='native-urban-probe'):
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
    config=json.loads((HERE/'urban-scenario.json').read_text());validate_scenario(config)
    (output/'urban_settings.hpp').write_text('#pragma once\nnamespace U {\n'+
        'constexpr float X='+str(config['anchor_gta_xyz'][0])+'.f,Y='+str(config['anchor_gta_xyz'][1])+'.f,Z='+str(config['anchor_gta_xyz'][2])+'.f;\n'+
        'constexpr unsigned SEED='+str(config['seed'])+'; constexpr int CARS=60,PEDS=100,DURATION_MS='+str(config['duration_s']*1000)+';\n}\n')
    assets();source=(HERE/'urban_probe.cpp').read_text();db=json.loads((CACHE/'natives.json').read_text())
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
             f'cl.exe /nologo /LD /MT /EHsc /we4129 /std:c++17 /I"{HERE}" /I"{output}" "{HERE / "urban_probe.cpp"}" '
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


def validate_scenario(config):
    if config['traffic_vehicles']!=60 or config['on_foot_pedestrians']!=100 or config['training_admitted'] is not False:raise ValueError('Unapproved population/training configuration')
    if not 1000<=config['seed']<=1999 or config['duration_s']!=100:raise ValueError('Unregistered seed/duration')
    sites=config['split_sites'];ranges=[set(range(*[v['seeds'][0],v['seeds'][1]+1])) for v in sites.values()]
    if any(a&b for i,a in enumerate(ranges) for b in ranges[i+1:]):raise ValueError('Overlapping split seeds')
    return config


def local_jam(rows):
    qualified=[r for r in rows if r.get('blocker_stopped') and r.get('near_slow',0)>=4
               and r.get('near_queue_from_moving',0)>=4 and r.get('away_moving',0)>=3]
    return bool(len(qualified)>=6 and qualified[-1]['host_ms']-qualified[0]['host_ms']>=5000)


def evaluate(output,pids,run):
    rows=all_rows(output/'bridge.jsonl');captures=all_rows(output/'capture.jsonl');population=all_rows(output/'urban.jsonl');vision=all_rows(output/'live-vision.jsonl')
    raw={p.name:{'sha256':boot.digest(p),'bytes':p.stat().st_size} for pattern in ('capture-*.rgb','capture-*.depth') for p in output.glob(pattern)}
    preflight.write_json(output/'raw-manifest.json',{'run_id':run,'files':raw})
    result={'sensor_probe_accepted':False,'urban_accepted':False,'localized_congestion_accepted':False,'live_vision_accepted':False,
            'normal_token_verified':bool(pids and all(GAME_TOKENS.get(p) is False for p in pids)),'full_migration_accepted':False,'training_started':False}
    if not rows or not captures or not population:return result
    if any(r['run_id']!=run or r['pid'] not in pids for r in rows+captures+population):raise ValueError('Native identity mismatch')
    settled=[r for r in population if r['elapsed_s']>=10]
    actual=bool(settled and all(r['cars_alive']==60 and r['pedestrians_alive']==100 and r['pedestrians_on_foot']==100 for r in settled))
    place=bool(settled and all(r['ego_on_road'] and 3<=r['road_membership_width_m']<=12 and r['street_name']!='UNKNOWN' for r in settled))
    moved=bool(settled and max(r['cars_moved'] for r in settled)>=20 and max(r['pedestrians_moved'] for r in settled)>=50)
    visible=[r for r in population if r.get('visible_pedestrians',0)>=5 and r.get('visible_cars',0)>=2]
    result['user_view_accepted']=len(visible)>=10
    result['urban_accepted']=actual and place and moved and result['user_view_accepted'] and all(r['ped_alive'] for r in rows if r['frame'])
    result['localized_congestion_accepted']=local_jam(population)
    result['live_vision_accepted']=bool(len({r['serial'] for r in vision})>=40 and all(r['execution_provider']=='DmlExecutionProvider' for r in vision)
          and any(any(d['class']=='person' for d in r['detections']) for r in vision)
          and any(any(d['class'] in ('car','bus','truck') for d in r['detections']) for r in vision))
    result['population_summary']={'samples':len(population),'actual_full_counts':actual,'narrow_road':place,'sufficient_physical_motion':moved,
          'max_cars_moved':max(r['cars_moved'] for r in population),'max_pedestrians_moved':max(r['pedestrians_moved'] for r in population),
          'max_near_slow':max(r['near_slow'] for r in population),'max_away_moving':max(r['away_moving'] for r in population),
          'street_names':sorted({r['street_name'] for r in population}),'junction_names':sorted({r['junction_name'] for r in population}),
          'road_membership_width_m':population[0]['road_membership_width_m'],'ego_spawn':population[0]['ego_spawn'],'junction':population[0]['junction'],
          'simultaneous_visible_people_5_cars_2_samples':len(visible),'max_visible_people':max(r.get('visible_pedestrians',0) for r in population),
          'max_visible_cars':max(r.get('visible_cars',0) for r in population)}
    result['live_vision']={'processed_frames':len(vision),'captured_frames':len(captures),
          'inference_p95_ms':float(np.percentile([r['inference_ms'] for r in vision],95)) if vision else None,
          'native_snapshot_to_result_p95_ms':float(np.percentile([r['snapshot_age_ms'] for r in vision],95)) if vision else None}
    result['sensor_probe_accepted']=all(result[k] for k in ('urban_accepted','localized_congestion_accepted','live_vision_accepted','normal_token_verified'))
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
        vision_stdout=(output/'live-vision.stdout.log').open('wb');vision_stderr=(output/'live-vision.stderr.log').open('wb')
        vision=subprocess.Popen([str(preflight.PROJECT/'.venv-perception-dml/Scripts/python.exe'),'-B',str(HERE/'urban_vision.py'),'--output',str(output)],cwd=preflight.PROJECT,stdout=vision_stdout,stderr=vision_stderr)
        pids=set();seq=0;sock=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);foreign=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);deadline=min(time.monotonic()+430,request['deadline']-25)
        next_send=0;storage_measured=False;world_ready=False;completed=False;world_deadline=time.monotonic()+240
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
                if not world_ready and time.monotonic()>world_deadline:raise RuntimeError('Story world/render not ready within240s; owner interaction may be needed')
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


def ordinary(output):
    output=output_path(output)
    if elevated():raise RuntimeError('Ordinary process required; no elevated wrapper')
    if any(str(Path(k).resolve()).casefold()==str(LAUNCHER.resolve()).casefold() and 'RUNASADMIN' in v[0].upper() for k,v in compatibility().items()):raise RuntimeError('Owner per-game RUNASADMIN flag is still enabled')
    if boot.existing_native():raise RuntimeError('Native host occupied')
    build(output);identifier=uuid.uuid4().hex
    with socket.socket(socket.AF_INET,socket.SOCK_DGRAM) as choice:choice.bind(('127.0.0.1',0));port=choice.getsockname()[1]
    request={'id':identifier,'owner':uuid.uuid4().hex,'port':port,'deadline':time.monotonic()+550}
    preflight.write_json(output/'sensor-request.json',request)
    original=boot.OwnedJob
    class ObservedJob(original):
        def members(self):
            members=super().members()
            for pid in members:
                if pid not in GAME_TOKENS and boot.process_image(pid)==preflight.GAME.resolve():
                    GAME_TOKENS[pid]=token_elevation(pid)
                    if GAME_TOKENS[pid]:raise RuntimeError('Unexpected elevated game')
            return members
    try:
        boot.OwnedJob=ObservedJob;result=native(output,request)
    finally:boot.OwnedJob=original
    result['owned_game_tokens']=GAME_TOKENS;result['controller_elevated']=False
    preflight.write_json(output/'sensor-result.json',result)
    print(json.dumps({k:v for k,v in result.items() if k!='budget'},indent=2))
    return int(not (result['sensor_probe_accepted'] and result['cleanup_confirmed'] and result['files_restored'] and result.get('protected_inputs_unchanged') and not result.get('budget_error')))


def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--output',type=Path,required=True);p.add_argument('--build-only',action='store_true');args=p.parse_args()
    if args.build_only:build(output_path(args.output,'build-urban-probe'));return 0
    return ordinary(args.output)


if __name__=='__main__':raise SystemExit(main())
