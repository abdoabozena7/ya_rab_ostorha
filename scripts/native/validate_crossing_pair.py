"""Complete production guided pair. No shortening, actor labels or future intent enter control."""
import argparse
import json
from pathlib import Path
import subprocess
import sys
import threading
import time
import traceback
import uuid
from scripts.validate_hybrid_native import ROOT,source_hashes,archive_sources


def cleanup_probe():
    code=('import carla,json; c=carla.Client("127.0.0.1",2000);c.set_timeout(8);w=c.get_world(); '
        'sync=w.get_settings().synchronous_mode; '
        'w.wait_for_tick(5) if not sync else None; '
        'owned=[a.id for a in w.get_actors() if a.attributes.get("role_name","").startswith("ostorha_") or a.type_id=="controller.ai.walker"]; '
        'print("CLEANUP_PROBE "+json.dumps({"synchronous":sync,"remaining_project_actors":owned,"passed":not sync and not owned}))')
    try:
        result=subprocess.run([sys.executable,'-c',code],capture_output=True,text=True,timeout=20,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
        return next(json.loads(line.removeprefix('CLEANUP_PROBE ')) for line in result.stdout.splitlines() if line.startswith('CLEANUP_PROBE '))
    except (OSError,ValueError,StopIteration,subprocess.TimeoutExpired) as error:return {'passed':False,'error':str(error)}


def verify_videos(report):
    import hashlib
    from imageio_ffmpeg import get_ffmpeg_exe
    files={}
    try:
        for mode in ('NORMAL','ROBOSPHERE'):
            root=Path(report['pair']['runs'][mode]['recording']).resolve()
            if not root.is_relative_to((ROOT/'runs/normal_city').resolve()):raise ValueError('Unexpected video root')
            state=json.loads((root/'video-status.json').read_text(encoding='utf8'));name=state.get('preferred_video','driving.mp4')
            if name not in ('driving.mp4','driving-annotated.mp4'):raise ValueError('Unexpected video variant')
            variant=state.get('variants',{}).get('annotated' if 'annotated' in name else 'raw',state)
            files[mode]=(root/name,state,variant)
        common=report['shared_perception'];root=Path(common['recording']).resolve()
        if root!=Path(report['pair']['runs']['NORMAL']['recording']).resolve():raise ValueError('Unexpected shared root')
        files['shared']=(root/'shared-perception.mp4',common,common)
        checks={}
        for label,(path,state,variant) in files.items():
            valid=variant['status']=='READY' and hashlib.sha256(path.read_bytes()).hexdigest()==variant['sha256']
            probes=[]
            for stamp in (0.,max(0.,state.get('duration_s',0)-.15)):
                command=[get_ffmpeg_exe(),'-hide_banner','-loglevel','error','-ss',str(stamp),'-i',str(path),'-frames:v','1','-f','null','-']
                probes.append(subprocess.run(command,capture_output=True,timeout=30,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0)).returncode==0)
            checks[label]={'sha256_verified':valid,'first_and_last_decode':probes,'duration_s':state.get('duration_s')}
        return {'passed':all(c['sha256_verified'] and all(c['first_and_last_decode']) for c in checks.values()),'checks':checks,'clock':'AFTER_VERIFIED_ENGINE_EXIT'}
    except (OSError,ValueError,KeyError,TypeError,subprocess.TimeoutExpired) as error:return {'passed':False,'error':str(error)}


def worker(args):
    # Keep this owned validation process responsive while unrelated normal-
    # priority background jobs run. Safety and command deadlines stay intact.
    if sys.platform=='win32':
        import ctypes
        kernel=ctypes.WinDLL('kernel32',use_last_error=True)
        kernel.GetCurrentProcess.restype=ctypes.c_void_p
        kernel.SetPriorityClass.argtypes=(ctypes.c_void_p,ctypes.c_uint)
        kernel.SetPriorityClass(kernel.GetCurrentProcess(),0x8000)
    import carla
    from backend.carla.runtime import NativeRuntime
    from backend.carla.provider import CarlaProvider
    from backend.core.service import SimulationService
    from backend.core.journey_comparison import JourneyComparison
    from backend.server import DashboardHTTPServer,Handler
    from backend.computer_vision.service import PerceptionService,ControlPerceptionCache
    folder=Path(args.folder);report=json.loads((folder/'initial.json').read_text());service=provider=http=perception=None
    began=time.monotonic();last=None;last_progress=-1;heartbeat_stop=threading.Event()
    try:
        runtime=NativeRuntime()
        from backend.graphics import launch
        if not runtime.active:runtime.launch({**launch(args.render_profile),'offscreen':True},'127.0.0.1',2000,carla)
        report['render_profile']=runtime.active
        if sys.platform=='win32':
            from backend.carla.runtime import native_processes
            identities=[int(p['ProcessId']) for p in native_processes()]
            for pid in identities:
                subprocess.run(['powershell','-NoProfile','-Command',f'(Get-Process -Id {pid}).PriorityClass="AboveNormal"'],capture_output=True,timeout=10,creationflags=subprocess.CREATE_NO_WINDOW)
            report['validation_priority']='ABOVE_NORMAL_OWNED_WORKER_AND_VERIFIED_ENGINE'
        provider=CarlaProvider(blueprint='vehicle.mercedes.coupe_2020',spawn_index=152,sensor_suite=True,collision_sensor=True,fresh_start=True,traffic_manager_port=8052)
        provider.camera_settings['_comparison_rig']=True
        provider.connect();provider._ensure_dashboard_tools()
        service=SimulationService(provider,required_sensors=provider.required_sensors)
        service.journey_comparison=JourneyComparison(folder/'comparisons');service.presentation.directory=folder/'presentations'
        service.pause_on_first_observation=True;service.start(threaded=False)
        def heartbeat():
            while not heartbeat_stop.wait(.1):service.navigation_transport_heartbeat(service.session_id)
        threading.Thread(target=heartbeat,daemon=True).start()
        http=DashboardHTTPServer(('127.0.0.1',8011),Handler);http.simulation_service=service
        perception=PerceptionService(8011);http.perception=perception;service.control_perception=ControlPerceptionCache()
        threading.Thread(target=http.serve_forever,daemon=True).start()
        for _ in range(20):service.step_once()
        service.presentation.start(120,guided=True,seed=args.seed,first_mode=args.first,scene='DENSE_CHAOS')
        service.presentation.data.update(preloaded=True,awaiting_choice=True,vehicle_variants=True)
        report['samples']=[];report['phases']=[]
        while time.monotonic()-began<args.seconds-75:
            if (folder/'abort.json').exists():
                report['calibration_aborted']=json.loads((folder/'abort.json').read_text())
                service.stop_driving('calibration_aborted')
                for _ in range(6):service.step_once()
                break
            service.journey_heartbeat(service.session_id);service.step_once();d=service.presentation.data
            if d['status']!=last:
                last=d['status'];event={'phase':last,'arm':d.get('arm'),'reason':d.get('reason'),'wall_s':time.monotonic()-began}
                report['phases'].append(event);print(json.dumps(event),flush=True)
                checkpoint={k:v for k,v in report.items() if k!='samples'}
                checkpoint['pair']=service.journey_comparison.snapshot()
                (folder/'checkpoint.json').write_text(json.dumps(checkpoint,indent=2),encoding='utf8')
            if last=='CHOOSING':service.presentation.choose_preloaded(d['id'],args.first)
            if last=='DRIVING':
                v=service.observation.vehicle
                row={'frame':service.observation.frame_id,'timestamp_s':service.observation.timestamp_s,
                    'arm':d['arm'],'mode':service.journey.get('driving_mode'),'speed_kmh':v.speed_mps*3.6,
                    'yaw_rad':v.transform.rotation_rad.yaw,
                    'position_m':list(v.transform.position_m),'stop':service._public_stop_diagnostics(),
                    'scenario':getattr(provider,'dense_chaos',None).run_evidence(),'performance':service.backend_step_ms}
                report['samples'].append(row)
                second=int(service.observation.timestamp_s)
                if second!=last_progress:
                    last_progress=second
                    with (folder/'progress.jsonl').open('a',encoding='utf8') as stream:
                        stream.write(json.dumps({k:row[k] for k in ('frame','timestamp_s','arm','mode','speed_kmh','position_m','scenario')})+'\n')
            if last in ('RESULTS','ERROR','CANCELLED'):break
        report['presentation']=service.presentation.snapshot();report['pair']=service.journey_comparison.snapshot()
        report['journey']=service.journey;report['last_drive_stop']=service.last_drive_stop;report['dashboard_result']=service.dashboard_result
        report['completed_without_shortening']=service.presentation.data['status']=='RESULTS' and len(report['pair']['runs'])==2 and all(r['status'] in ('ARRIVED','COLLISION') for r in report['pair']['runs'].values())
        if service.presentation.data['status']=='RESULTS' and len(report['pair']['runs'])==2:
            stopped=threading.Event()
            def dispatch(status):
                report['shutdown_dispatch']=status;stopped.set()
            provider.shutdown_handler=dispatch
            report['exports_at_finish_request']=service.presentation.video_states()
            service.presentation.finish(service.presentation.data['id'])
            service.presentation.finish(service.presentation.data['id'])
            while service.presentation.data['status']=='FINISHING' and time.monotonic()-began<args.seconds-45:
                service.navigation_transport_heartbeat(service.session_id);service.step_once()
            if service.presentation.data['status']=='COMPLETE':stopped.wait(20.)
            report['finish_completed']=stopped.is_set() and service.presentation.data['status']=='COMPLETE'
            report['presentation']=service.presentation.snapshot();report['pair']=service.journey_comparison.snapshot()
            report['video_states']=service.presentation.video_states()
            report['shared_perception']=service.presentation.data.get('shared_perception')
    except BaseException as error:report.update(error=str(error),traceback=traceback.format_exc())
    finally:
        # Save actual measurements before entering native destruction. A C++
        # exception during cleanup must not erase the failed attempt.
        report['source_unchanged']=source_hashes()==report['source_hashes'];report['wall_s']=time.monotonic()-began
        (folder/'report.json').write_text(json.dumps(report,indent=2,allow_nan=False),encoding='utf8')
        heartbeat_stop.set()
        if http:http.shutdown();http.server_close()
        if perception:perception.close()
        if service:
            try:
                if service.journey_comparison.active:report['incomplete_pair']=service.journey_comparison.snapshot()
                service.close();report['cleanup_confirmed']=not provider.cleanup_errors
                from backend.core.driving_video import wait_for_exports
                report['exports_closed']=wait_for_exports(45.)
            except BaseException as error:report['cleanup_error']=str(error)
        elif provider:
            try:provider.close()
            except BaseException as error:report['cleanup_error']=str(error)
        report['source_unchanged']=source_hashes()==report['source_hashes'];report['wall_s']=time.monotonic()-began
        (folder/'report.json').write_text(json.dumps(report,indent=2,allow_nan=False),encoding='utf8')
    print(json.dumps({'report':str(folder/'report.json'),'passed':report.get('pair',{}).get('scenario_validation',{}).get('passed',False),'error':report.get('error')}),flush=True)
    return 0 if report.get('pair',{}).get('scenario_validation',{}).get('passed') else 1


def run(args):
    from scripts.final_runtime import state
    s=state()
    if s and s.get('connected'):raise RuntimeError('Stop the ordinary dashboard before isolated native validation')
    from backend.carla.runtime import NativeRuntime
    runtime=NativeRuntime();was_running=runtime.active is not None
    folder=ROOT/'output/crossing-pairs'/uuid.uuid4().hex;folder.mkdir(parents=True)
    report={'source':'LIVE_NATIVE_CARLA','seed':args.seed,'first_mode':args.first,'source_hashes':source_hashes()}
    report['source_archive']=archive_sources(folder,report['source_hashes'])
    (folder/'initial.json').write_text(json.dumps(report,indent=2));print(str(folder),flush=True)
    try:
        with (folder/'worker.log').open('w',encoding='utf8') as log:
            child=subprocess.Popen([sys.executable,'-m','scripts.native.validate_crossing_pair','--worker','--folder',str(folder),
                '--seed',str(args.seed),'--first',args.first,'--seconds',str(args.seconds),'--render-profile',args.render_profile],cwd=ROOT,stdout=log,stderr=subprocess.STDOUT,
                creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
            try:child.wait(timeout=args.seconds)
            except subprocess.TimeoutExpired:
                subprocess.run(['taskkill','/PID',str(child.pid),'/T','/F'],capture_output=True,timeout=15);child.wait(timeout=10)
        if not (folder/'report.json').exists():
            partial=json.loads((folder/'checkpoint.json').read_text()) if (folder/'checkpoint.json').exists() else report
            partial.update(error='Native worker exited before finalization; original logs and checkpoints retained',native_worker_exit_code=child.returncode,
                cleanup_confirmed=False,completed_without_shortening=False)
            (folder/'report.json').write_text(json.dumps(partial,indent=2),encoding='utf8')
        print(json.dumps({'report':str(folder/'report.json'),'exit_code':child.returncode}),flush=True)
    finally:
        if not was_running:
            probe=cleanup_probe()
            runtime.stop()
            path=folder/'report.json';saved=json.loads(path.read_text(encoding='utf8'))
            saved['independent_cleanup_probe']=probe
            saved['simulator_exit_confirmed']=runtime.inspect() is None
            saved['video_playback_after_exit']=verify_videos(saved)
            from .crossing_causality import critical_prediction_evidence
            saved['critical_prediction_evidence']=critical_prediction_evidence(saved)
            saved['native_acceptance']=bool(saved.get('pair',{}).get('scenario_validation',{}).get('passed')
                and saved['pair'].get('conditions_match') and saved['critical_prediction_evidence']['passed']
                and saved.get('source_unchanged') and saved.get('completed_without_shortening') and saved.get('finish_completed')
                and saved.get('cleanup_confirmed') and probe['passed'] and saved['video_playback_after_exit']['passed']
                and child.returncode==0 and saved['simulator_exit_confirmed'])
            path.write_text(json.dumps(saved,indent=2,allow_nan=False),encoding='utf8')
    return 0 if json.loads((folder/'report.json').read_text(encoding='utf8')).get('native_acceptance') else 1


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--seed',type=int,default=1701);p.add_argument('--first',choices=('NORMAL','ROBOSPHERE'),default='NORMAL')
    p.add_argument('--render-profile',choices=('LOW','BALANCED','HIGH'),default='LOW')
    p.add_argument('--seconds',type=float,default=900.);p.add_argument('--worker',action='store_true');p.add_argument('--folder')
    a=p.parse_args()
    if not 180<=a.seconds<=1800:p.error('Use a bounded 180–1800 second validation')
    if a.worker:
        result=worker(a)
        # All recording/actor cleanup results are saved above. Retire the SDK
        # process before the parent stops UE, as the production stop helper
        # does; Windows libcarla destructor unwinding is not reliable.
        import os
        sys.stdout.flush();sys.stderr.flush();os._exit(result)
    raise SystemExit(run(a))
