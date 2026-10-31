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
ROOT=HERE/'.runtime-proof/gta-chaos-crossing-20261031/runs'
SOURCES=('chaos_probe.py','chaos_probe.cpp','sensor_shared.hpp','capture_addon.cpp','OstorhaDepth.fx',
         'chaos-scenario.json','render-lock.json','bootstrap.py','preflight.py','owner_file_allowance.ps1',
         'uac_bootstrap.py','downloads/owner-file-allowance.json','chaos_vision.py','vision_probe.py','vision-lock.json')
GAME_TOKENS={}
COMMAND=struct.Struct('<IHHQQ33sfff')
TICK=ctypes.windll.kernel32.GetTickCount64;TICK.restype=ctypes.c_ulonglong


def packet(owner,sequence,deadline,steer=0.,throttle=0.,brake=1.):
    if (not re.fullmatch('[0-9a-f]{32}',owner) or not 0<sequence<2**64 or not 0<=deadline<2**64
            or not all(math.isfinite(v) for v in (steer,throttle,brake))
            or not -1<=steer<=1 or not 0<=throttle<=1 or not 0<=brake<=1):
        raise ValueError('Invalid local command')
    return COMMAND.pack(0x4f475431,1,1,sequence,deadline,owner.encode()+b'\0',steer,throttle,brake)


def output_path(path,check='native-chaos-probe'):
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
    config=json.loads((HERE/'chaos-scenario.json').read_text());validate_scenario(config)
    (output/'urban_settings.hpp').write_text('#pragma once\nnamespace U {\n'+
        'constexpr float X='+str(config['anchor_gta_xyz'][0])+'.f,Y='+str(config['anchor_gta_xyz'][1])+'.f,Z='+str(config['anchor_gta_xyz'][2])+'.f;\n'+
        'constexpr unsigned SEED='+str(config['seed'])+'; constexpr int CARS=60,PEDS=100,DURATION_MS='+str(config['duration_s']*1000)+';\n}\n')
    assets();source=(HERE/'chaos_probe.cpp').read_text();db=json.loads((CACHE/'natives.json').read_text())
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
             f'cl.exe /nologo /LD /MT /EHsc /we4129 /std:c++17 /I"{HERE}" /I"{output}" "{HERE / "chaos_probe.cpp"}" '
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
    if (config.get('parked_vehicles'),config.get('local_moving_cars'),config.get('local_motorcycles'),config.get('designated_crossers'))!=(10,6,4,24):raise ValueError('Unapproved chaos population')
    sites=config['split_sites'];ranges=[set(range(*[v['seeds'][0],v['seeds'][1]+1])) for v in sites.values()]
    if any(a&b for i,a in enumerate(ranges) for b in ranges[i+1:]):raise ValueError('Overlapping split seeds')
    return config


def local_jam(rows):
    qualified=[r for r in rows if r.get('blocker_stopped') and r.get('near_slow',0)>=4
               and r.get('near_queue_from_moving',0)>=4 and r.get('away_moving',0)>=3]
    return bool(len(qualified)>=6 and qualified[-1]['host_ms']-qualified[0]['host_ms']>=5000)


def parking_summary(rows):
    gaps=[];count_ok=bool(rows);ego_width=0
    for row in rows:
        ego_width=max(ego_width,float(row['ego_width_m']));cars=row['parked'];sides=[c['side'] for c in cars if c['exists']]
        count_ok=count_ok and len(cars)==10 and len(sides)==10 and sides.count('LEFT')>=4 and sides.count('RIGHT')>=4
        for x in np.arange(3,85,.5):
            left=-row['road_band_m']/2;right=row['road_band_m']/2;active=False
            for c in cars:
                if c['along_min_m']<=x<=c['along_max_m']:
                    active=True
                    if c['side']=='LEFT':left=max(left,c['lateral_max_m'])
                    else:right=min(right,c['lateral_min_m'])
            if active:gaps.append(right-left)
    finite=bool(gaps and np.isfinite(gaps).all() and math.isfinite(ego_width) and ego_width>0)
    minimum=min(gaps) if finite else None;maximum=max(gaps) if finite else None
    return {'accepted':bool(count_ok and finite and minimum>=ego_width+.45 and minimum<=4.2 and maximum-minimum>=.5),
            'minimum_gap_m':minimum,'maximum_gap_m':maximum,'actual_ego_width_m':ego_width,'count_verified':count_ok,
            'method':'Actual parked model corner bounds projected in fixed local road frame; no learned ego passage claim'}


def crossing_summary(events,population):
    entered={r['entity'] for r in events if r['event']=='ENTERED_ROAD'}
    completed=[r for r in events if r['event']=='COMPLETED'];directions={r['direction'] for r in completed}
    duration=0
    for a,b in zip(population,population[1:]):
        dt=(b['host_ms']-a['host_ms'])/1000
        if a.get('road_crossers',0)>0 and b.get('road_crossers',0)>0 and 0<dt<=2:duration+=dt
    return {'accepted':bool(len(entered)>=8 and len(completed)>=6 and {'LEFT_TO_RIGHT','RIGHT_TO_LEFT'}<=directions and duration>=8),
           'distinct_entered_road':len(entered),'completed_crossings':len(completed),'directions':sorted(directions),
           'conservative_road_occupancy_s':duration,'casualty_events':sum(r['event']=='CASUALTY' for r in events),
           'stalled_events':sum(r['event']=='STALLED' for r in events),'assigned_tasks_not_crossings':sum(r['event']=='TASK_ASSIGNED' for r in events)}


def evaluate(output,pids,run):
    rows=all_rows(output/'bridge.jsonl');captures=all_rows(output/'capture.jsonl');population=all_rows(output/'urban.jsonl');vision=all_rows(output/'live-vision.jsonl')
    crossings=all_rows(output/'crossings.jsonl');parking=all_rows(output/'parking.jsonl')
    raw={p.name:{'sha256':boot.digest(p),'bytes':p.stat().st_size} for pattern in ('capture-*.rgb','capture-*.depth') for p in output.glob(pattern)}
    preflight.write_json(output/'raw-manifest.json',{'run_id':run,'files':raw})
    result={'sensor_probe_accepted':False,'parking_accepted':False,'crossing_accepted':False,'local_traffic_accepted':False,'live_vision_accepted':False,
            'normal_token_verified':bool(pids and all(GAME_TOKENS.get(p) is False for p in pids)),'full_migration_accepted':False,'training_started':False}
    if not rows or not captures or not population:return result
    if any(r['run_id']!=run or r['pid'] not in pids for r in rows+captures+population+crossings):raise ValueError('Native identity mismatch')
    initial=population[0];group=initial.get('initial_local_group',[]);bikes=[x for x in group if x['role']=='MOTORCYCLE'];localcars=[x for x in group if x['role']=='LOCAL_CAR']
    placement=bool(len(bikes)==4 and len(localcars)==6 and any(x['lateral_m']<-.5 for x in bikes) and any(x['lateral_m']>.5 for x in bikes)
          and any(x['along_m']<0 for x in bikes) and all(math.hypot(x['along_m'],x['lateral_m'])<=100 for x in group))
    actual=initial['cars_alive']==60 and initial['pedestrians_alive']==100 and initial['pedestrians_on_foot']==100 and initial['motorcycles_alive']==4 and initial['local_cars_alive']==6
    motion=max(r['motorcycles_moved_2m'] for r in population)>=3 and max(r['local_cars_moved_2m'] for r in population)>=4
    clear=all(r['ped_alive'] for r in rows if r['frame']) and all(r['ego_on_road'] for r in population)
    result['parking']=parking_summary(parking);result['parking_accepted']=result['parking']['accepted']
    result['crossings']=crossing_summary(crossings,population);result['crossing_accepted']=result['crossings']['accepted']
    result['local_traffic_accepted']=bool(actual and placement and motion and clear and local_jam(population))
    result['live_vision_accepted']=bool(len({r['serial'] for r in vision})>=40 and all(r['execution_provider']=='DmlExecutionProvider' for r in vision)
          and any(any(d['class']=='person' for d in r['detections']) for r in vision)
          and any(any(d['class'] in ('car','truck','motorcycle') for d in r['detections']) for r in vision))
    result['population_summary']={'initial_targets_verified':actual,'local_placement_verified':placement,'local_motion_verified':motion,
          'initial_local_group':group,'minimum_live_traffic':min(r['cars_alive'] for r in population),'minimum_live_walkers':min(r['pedestrians_alive'] for r in population),
          'max_local_cars_moved':max(r['local_cars_moved_2m'] for r in population),'max_motorcycles_moved':max(r['motorcycles_moved_2m'] for r in population),
          'max_near_queue_from_moving':max(r['near_queue_from_moving'] for r in population),'max_away_moving':max(r['away_moving'] for r in population),
          'street_names':sorted({r['street_name'] for r in population}),'junction_names':sorted({r['junction_name'] for r in population}),
          'road_membership_width_m':initial['road_membership_width_m'],'ego_spawn':initial['ego_spawn'],'junction':initial['junction']}
    result['live_vision']={'processed_frames':len(vision),'captured_frames':len(captures),
          'inference_p95_ms':float(np.percentile([r['inference_ms'] for r in vision],95)) if vision else None,
          'native_snapshot_to_result_p95_ms':float(np.percentile([r['snapshot_age_ms'] for r in vision],95)) if vision else None}
    result['sensor_probe_accepted']=all(result[k] for k in ('parking_accepted','crossing_accepted','local_traffic_accepted','live_vision_accepted','normal_token_verified'))
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
        vision=subprocess.Popen([str(preflight.PROJECT/'.venv-perception-dml/Scripts/python.exe'),'-B',str(HERE/'chaos_vision.py'),'--output',str(output)],cwd=preflight.PROJECT,stdout=vision_stdout,stderr=vision_stderr)
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
    if args.build_only:build(output_path(args.output,'build-chaos-probe'));return 0
    return ordinary(args.output)


if __name__=='__main__':raise SystemExit(main())
