"""Complete production guided pair. No shortening, actor labels or future intent enter control."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import time
import traceback
import uuid
from scripts.validate_hybrid_native import ROOT,source_hashes,archive_sources
from backend.learning.egypt_budget import EgyptBudget, remaining_seconds, save_json


DIAGNOSTIC_TARGETS = {(2707, 'ROBOSPHERE'): (50., 30.),
                      (1703, 'NORMAL'): (157.3512154797993, 0.),
                      (3709, 'NORMAL'): (111.24587573731478, 0.)}


def diagnostic_goal(seed, mode, run):
    distance, duration = DIAGNOSTIC_TARGETS[(seed, mode)]
    terminal = run.get('status') == 'ARRIVED' or (
        run.get('status') == 'COLLISION' and run.get('contact_callbacks', 0) > 0)
    return ((mode == 'NORMAL' and terminal) or
            run.get('distance_m', 0.) >= distance and run.get('duration_s', 0.) >= duration)


class EvidenceFiles:
    def __init__(self, root):
        self.root, self.metadata = root, None
        self.streams = {}

    def record_trace(self, row):
        name = row['file']
        if name not in ('checkpoint.json', 'samples.jsonl', 'progress.jsonl'):
            raise ValueError('Unexpected native evidence destination')
        if name.endswith('.json'):
            save_json(self.root / name, row['data'])
        else:
            if name not in self.streams:
                self.streams[name] = (self.root / name).open('a', encoding='utf8')
            self.streams[name].write(json.dumps(row['data'], separators=(',', ':')) + '\n')
            self.streams[name].flush()

    def close(self):
        for stream in self.streams.values():
            stream.flush()
            os.fsync(stream.fileno())
            stream.close()


def diagnostic_assessment(report):
    from backend.core.egypt_urban import control_latency_passed
    mode = report['first_mode']
    run = report.get('pair', {}).get('runs', {}).get(mode, {})
    latency = run.get('control_latency', {})
    gates = {
        'measured_diagnostic_goal': diagnostic_goal(report['seed'], mode, run),
        'protected_without_contact': mode == 'NORMAL' or run.get('collisions') == 0,
        'no_control_timeout': not report.get('error') and (
            run.get('reason') == 'diagnostic_goal_reached' or run.get('status') in ('ARRIVED', 'COLLISION')),
        'sensor_latency_targets': control_latency_passed(latency),
        'clean_worker_exit': report.get('native_worker_exit_code') in (0, 1) and report.get('cleanup_stage') == 'COMPLETE'
            and report.get('cleanup_confirmed') is True and not report.get('cleanup_error'),
        'exports_closed': report.get('exports_closed') is True,
        'saved_video_playback': report.get('video_playback_after_exit', {}).get('passed') is True,
        'independent_cleanup': report.get('independent_cleanup_probe', {}).get('passed') is True,
        'engine_exited': report.get('simulator_exit_confirmed') is True,
        'source_unchanged': report.get('source_unchanged') is True and report.get('attempts_retained') is True,
    }
    return {'passed': all(gates.values()), 'gates': gates, 'native_acceptance': False}


def cleanup_probe(deadline=None):
    code=('import carla,json; c=carla.Client("127.0.0.1",2000);c.set_timeout(8);w=c.get_world(); '
        'sync=w.get_settings().synchronous_mode; '
        'w.wait_for_tick(5) if not sync else None; '
        'owned=[a.id for a in w.get_actors() if a.attributes.get("role_name","").startswith("ostorha_") or a.type_id=="controller.ai.walker"]; '
        'print("CLEANUP_PROBE "+json.dumps({"synchronous":sync,"remaining_project_actors":owned,"passed":not sync and not owned}))')
    try:
        result=subprocess.run([sys.executable,'-c',code],capture_output=True,text=True,
            timeout=remaining_seconds(deadline,20) if deadline is not None else 20,
            creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
        return next(json.loads(line.removeprefix('CLEANUP_PROBE ')) for line in result.stdout.splitlines() if line.startswith('CLEANUP_PROBE '))
    except (OSError,ValueError,StopIteration,subprocess.TimeoutExpired) as error:return {'passed':False,'error':str(error)}


def verify_videos(report, deadline=None, *, diagnostic=False):
    import hashlib
    from imageio_ffmpeg import get_ffmpeg_exe
    files={}
    try:
        for mode in (report['first_mode'],) if diagnostic else ('NORMAL','ROBOSPHERE'):
            root=Path(report['pair']['runs'][mode]['recording']).resolve()
            if not root.is_relative_to((ROOT/'runs/normal_city').resolve()):raise ValueError('Unexpected video root')
            state=json.loads((root/'video-status.json').read_text(encoding='utf8'));name=state.get('preferred_video','driving.mp4')
            if name not in ('driving.mp4','driving-annotated.mp4'):raise ValueError('Unexpected video variant')
            variant=state.get('variants',{}).get('annotated' if 'annotated' in name else 'raw',state)
            files[mode]=(root/name,state,variant)
        if not diagnostic:
            common=report['shared_perception'];root=Path(common['recording']).resolve()
            if root!=Path(report['pair']['runs']['NORMAL']['recording']).resolve():raise ValueError('Unexpected shared root')
            files['shared']=(root/'shared-perception.mp4',common,common)
        checks={}
        for label,(path,state,variant) in files.items():
            valid=variant['status']=='READY' and hashlib.sha256(path.read_bytes()).hexdigest()==variant['sha256']
            probes=[]
            for stamp in (0.,max(0.,state.get('duration_s',0)-.15)):
                command=[get_ffmpeg_exe(),'-hide_banner','-loglevel','error','-ss',str(stamp),'-i',str(path),'-frames:v','1','-f','null','-']
                probes.append(subprocess.run(command,capture_output=True,
                    timeout=remaining_seconds(deadline,30) if deadline is not None else 30,
                    creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0)).returncode==0)
            checks[label]={'sha256_verified':valid,'first_and_last_decode':probes,'duration_s':state.get('duration_s')}
        return {'passed':all(c['sha256_verified'] and all(c['first_and_last_decode']) for c in checks.values()),'checks':checks,'clock':'AFTER_VERIFIED_ENGINE_EXIT'}
    except (OSError,ValueError,KeyError,TypeError,subprocess.TimeoutExpired) as error:return {'passed':False,'error':str(error)}


def progress_pair(comparison):
    """Small, explicitly incomplete checkpoint; full evidence stays in final report."""
    data = comparison.data
    fields = ('id', 'mode', 'status', 'reason', 'recording', 'duration_s', 'distance_m',
              'route_completion_percent', 'collisions', 'destination_reached')
    return {'version': data.get('version'), 'pair_id': data.get('pair_id'),
            'progress_only': True, 'conditions_match': False,
            'manifest': {'comparison_scenario': {key: value for key, value in
                ((data.get('manifest') or {}).get('comparison_scenario') or {}).items()
                if key in ('id', 'version', 'seed')}},
            'runs': {mode: {key: run.get(key) for key in fields}
                     for mode, run in data.get('runs', {}).items()}}


def worker(args):
    import faulthandler
    faulthandler.enable()
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
    folder=Path(args.folder);report=json.loads((folder/'initial.json').read_text());service=provider=http=perception=evidence=None
    began=time.monotonic();last=None;last_progress=-1;heartbeat_stop=threading.Event()
    worker_deadline = min(began + args.seconds, args.egypt_deadline - 120.) if getattr(args, 'egypt_deadline', None) else began + args.seconds
    try:
        egypt = getattr(args, 'scenario', None) == 'EGYPT_URBAN_CHAOS_V1'
        if egypt:
            from backend.core.egypt_urban import admission
            validate_egypt_worker(args)
            os.environ['OSTORHA_EGYPT_DEADLINE'] = str(args.egypt_deadline)
            admission('Town10HD_Opt', 60.)
        worker_deadline = min(began + args.seconds, args.egypt_deadline - 120.) if egypt else began + args.seconds
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
        provider=CarlaProvider(blueprint='vehicle.mercedes.coupe_2020',spawn_index=152,sensor_suite=True,collision_sensor=True,
            fresh_start=True,traffic_manager_port=8052, **({'map_name':'Town10HD_Opt'} if egypt else {}))
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
        service.presentation.start(60 if egypt else 120,guided=True,seed=args.seed,first_mode=args.first,scene='DENSE_CHAOS',
            **({'scenario_id':'EGYPT_URBAN_CHAOS_V1','holdout_acceptance':getattr(args,'holdout_acceptance',False)} if egypt else
               {'scenario_id':'SUDDEN_PEDESTRIAN_COMPARISON_V1'}))
        service.presentation.data.update(preloaded=True,awaiting_choice=True,vehicle_variants=True)
        from backend.core.recording import BufferedRunRecorder
        evidence = BufferedRunRecorder(EvidenceFiles(folder), capacity=32, maximum_bytes=32*1024*1024)
        report.update(samples=[], phases=[], full_samples='samples.jsonl', samples_summary_period_s=1, sample_count=0)
        def write_evidence(name, data):
            if not evidence.record_trace({'file': name, 'data': data}):
                raise RuntimeError('Native evidence queue exhausted; its saved prefix is retained')
        def capture_after_control():
            nonlocal last, last_progress
            d=service.presentation.data
            if d['status']!=last:
                last=d['status'];event={'phase':last,'arm':d.get('arm'),'reason':d.get('reason'),'wall_s':time.monotonic()-began}
                report['phases'].append(event);print(json.dumps(event),flush=True)
                checkpoint={k:v for k,v in report.items() if k!='samples'}
                checkpoint['pair']=progress_pair(service.journey_comparison)
                write_evidence('checkpoint.json',checkpoint)
            if last!='DRIVING':
                return
            v=service.observation.vehicle
            row={'frame':service.observation.frame_id,'timestamp_s':service.observation.timestamp_s,
                'arm':d['arm'],'mode':service.journey.get('driving_mode'),'speed_kmh':v.speed_mps*3.6,
                'yaw_rad':v.transform.rotation_rad.yaw,
                'position_m':list(v.transform.position_m),'stop':service._public_stop_diagnostics(),
                'scenario':getattr(provider,'dense_chaos',None).run_evidence(),'performance':service.backend_step_ms,
                'application_timing':dict(service.application_timing)}
            write_evidence('samples.jsonl',row)
            report['sample_count']+=1
            second=int(service.observation.timestamp_s)
            if second!=last_progress:
                last_progress=second
                report['samples'].append(row)
                write_evidence('progress.jsonl',{k:row[k] for k in ('frame','timestamp_s','arm','mode','speed_kmh','position_m','scenario')})
            run=service.journey_comparison.active
            if getattr(args,'diagnostic',False) and run and diagnostic_goal(args.seed,args.first,run):
                report['diagnostic_goal_reached']=True
                service.stop_driving('diagnostic_goal_reached',cancel_comparison=False,cancel_presentation=False)
        service.after_control=capture_after_control
        while time.monotonic()<worker_deadline-75:
            if (folder/'abort.json').exists():
                report['calibration_aborted']=json.loads((folder/'abort.json').read_text())
                service.stop_driving('calibration_aborted')
                for _ in range(6):service.step_once()
                break
            service.journey_heartbeat(service.session_id);service.step_once();d=service.presentation.data
            if d['status']=='CHOOSING':service.presentation.choose_preloaded(d['id'],args.first)
            if d['status'] in ('RESULTS','ERROR','CANCELLED'):break
            if getattr(args,'diagnostic',False) and report.get('diagnostic_goal_reached') and not service.journey_recording_stop_pending:break
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
            while service.presentation.data['status']=='FINISHING' and time.monotonic()<worker_deadline-45:
                service.navigation_transport_heartbeat(service.session_id);service.step_once()
            if service.presentation.data['status']=='COMPLETE':stopped.wait(max(0.,min(20.,worker_deadline-time.monotonic())))
            report['finish_completed']=stopped.is_set() and service.presentation.data['status']=='COMPLETE'
            report['presentation']=service.presentation.snapshot();report['pair']=service.journey_comparison.snapshot()
            report['video_states']=service.presentation.video_states()
            report['shared_perception']=service.presentation.data.get('shared_perception')
    except BaseException as error:report.update(error=str(error),traceback=traceback.format_exc())
    finally:
        # Save actual measurements before entering native destruction. A C++
        # exception during cleanup must not erase the failed attempt.
        report['source_unchanged']=source_hashes()==report['source_hashes'];report['wall_s']=time.monotonic()-began
        save_json(folder/'report.json',report)
        def cleanup_stage(name):
            report['cleanup_stage'] = name
            report.setdefault('shutdown_stages', []).append({'stage':name,'monotonic_s':time.monotonic()})
            save_json(folder/'cleanup-stage.json', {'stage':name,'stages':report['shutdown_stages']})
        heartbeat_stop.set()
        if service:
            try:
                service.after_control=None
                service.shutdown_observer=cleanup_stage
                if service.journey_comparison.active:report['incomplete_pair']=service.journey_comparison.snapshot()
                cleanup_stage('SIMULATION_SERVICE_CLOSE')
                service.close(deadline=args.egypt_deadline-90. if egypt else worker_deadline)
                report['cleanup_confirmed']=not provider.cleanup_errors and service.shutdown_error is None
                report['pair']=service.journey_comparison.snapshot()
                from backend.core.driving_video import wait_for_exports
                cleanup_stage('RECORDING_EXPORTS_CLOSE')
                report['exports_closed']=wait_for_exports(0.)
            except BaseException as error:report['cleanup_error']=str(error)
        elif provider:
            cleanup_stage('PROVIDER_CLOSE')
            try:provider.close()
            except BaseException as error:report['cleanup_error']=str(error)
        cleanup_stage('HTTP_SERVER_CLOSE')
        if http:http.shutdown();http.server_close()
        cleanup_stage('PERCEPTION_CLOSE')
        if perception:perception.close()
        if evidence:
            cleanup_stage('EVIDENCE_WRITER_CLOSE')
            try:evidence.close()
            except RuntimeError as error:report['cleanup_error']=str(error)
        report['source_unchanged']=source_hashes()==report['source_hashes'];report['wall_s']=time.monotonic()-began
        report['cleanup_stage'] = 'ERROR' if report.get('cleanup_error') else 'COMPLETE'
        save_json(folder/'report.json',report)
    print(json.dumps({'report':str(folder/'report.json'),'passed':report.get('pair',{}).get('scenario_validation',{}).get('passed',False),'error':report.get('error')}),flush=True)
    if getattr(args,'diagnostic',False):
        run=report.get('pair',{}).get('runs',{}).get(args.first,{})
        return 0 if diagnostic_goal(args.seed,args.first,run) and report.get('cleanup_confirmed') and report.get('exports_closed') and not report.get('cleanup_error') and not report.get('error') else 1
    return 0 if report.get('pair',{}).get('scenario_validation',{}).get('passed') else 1


def validate_egypt_worker(args):
    if getattr(args,'rule_ticket',None) or args.render_profile != 'LOW':
        raise ValueError('Egypt validation requires its separate allowance and LOW rendering')
    if not all(getattr(args,name,None) is not None for name in ('egypt_budget','egypt_reservation','egypt_deadline')):
        raise ValueError('Egypt worker requires --egypt-budget, reservation and deadline from its parent')
    ticket = EgyptBudget(args.egypt_budget).worker_ticket(
        args.egypt_reservation,args.egypt_deadline,args.seed,args.first)
    if (ticket['phase']=='ACCEPTANCE') != bool(getattr(args,'holdout_acceptance',False)):
        raise ValueError('Egypt worker partition differs from its parent reservation')
    if bool(getattr(args, 'diagnostic', False)) != (ticket.get('purpose') == 'DIAGNOSTIC'):
        raise ValueError('Egypt worker diagnostic scope differs from its reservation')
    return ticket


def run(args):
    from scripts.final_runtime import state
    s=state()
    if s and s.get('connected'):raise RuntimeError('Stop the ordinary dashboard before isolated native validation')
    from backend.carla.runtime import NativeRuntime
    runtime=NativeRuntime();was_running=runtime.active is not None
    egypt = getattr(args, 'scenario', None) == 'EGYPT_URBAN_CHAOS_V1'
    if egypt:
        from backend.core.egypt_urban import admission, configuration, source_fingerprint
        egypt_ticket=validate_egypt_worker(args)
        if was_running:
            raise RuntimeError('Egypt validation requires an unowned stopped simulator; the active engine is not touched')
        if args.seed in configuration()['holdout_seeds'] and not getattr(args, 'holdout_acceptance', False):
            raise ValueError('Reserved seeds require the frozen one-shot Egypt acceptance matrix')
        admission('Town10HD_Opt', 60.)
        if getattr(args,'diagnostic',False) and (egypt_ticket.get('purpose')!='DIAGNOSTIC' or (args.seed,args.first) not in DIAGNOSTIC_TARGETS):
            raise ValueError('Diagnostic workers require a development diagnostic reservation and declared target')
    folder=ROOT/'output'/('egypt-urban-pairs' if egypt else 'crossing-pairs')/uuid.uuid4().hex;folder.mkdir(parents=True)
    args.report_folder = folder
    if egypt:
        EgyptBudget(args.egypt_budget).record_attempt_report(egypt_ticket,args.seed,args.first,folder/'report.json')
    report={'source':'LIVE_NATIVE_CARLA','seed':args.seed,'first_mode':args.first,'source_hashes':source_hashes()}
    if egypt:
        report.update(scenario_id='EGYPT_URBAN_CHAOS_V1', source_sha256=source_fingerprint())
        if getattr(args,'diagnostic',False):
            report.update(diagnostic=True, scope='DEVELOPMENT_DIAGNOSTIC', native_acceptance=False)
    report['source_archive']=archive_sources(folder,report['source_hashes'])
    if egypt:
        report['egypt_reservation']={'id':args.egypt_reservation,'deadline':args.egypt_deadline,'budget':args.egypt_budget}
    save_json(folder/'initial.json',report);print(str(folder),flush=True)
    child=None
    try:
        with (folder/'worker.log').open('w',encoding='utf8') as log:
            child=subprocess.Popen([sys.executable,'-m','scripts.native.validate_crossing_pair','--worker','--folder',str(folder),
                '--seed',str(args.seed),'--first',args.first,'--seconds',str(args.seconds),'--render-profile',args.render_profile,
                *(['--scenario','EGYPT_URBAN_CHAOS_V1'] if egypt else []),
                *(['--holdout-acceptance'] if egypt and getattr(args,'holdout_acceptance',False) else []),
                *(['--diagnostic'] if getattr(args,'diagnostic',False) else []),
                *(['--egypt-budget',str(args.egypt_budget),'--egypt-reservation',args.egypt_reservation,
                   '--egypt-deadline',str(args.egypt_deadline)] if egypt else []),
                *(['--rule-ticket',str(args.rule_ticket)] if getattr(args,'rule_ticket',None) else [])],cwd=ROOT,stdout=log,stderr=subprocess.STDOUT,
                creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
            deadline=min(time.monotonic()+args.seconds+180.,args.egypt_deadline-90.) if egypt else time.monotonic()+args.seconds
            while child.poll() is None:
                try:
                    child.wait(timeout=remaining_seconds(deadline,1.))
                except subprocess.TimeoutExpired:
                    callback=getattr(args,'on_progress',None);checkpoint=folder/'checkpoint.json'
                    if callback and checkpoint.is_file():
                        callback(json.loads(checkpoint.read_text(encoding='utf8')).get('pair',{}))
                except TimeoutError:
                    child.kill();child.wait(timeout=10)
                    report['worker_deadline_expired']=True
                    break
        if not (folder/'report.json').exists():
            partial=json.loads((folder/'checkpoint.json').read_text()) if (folder/'checkpoint.json').exists() else report
            partial.update(error='Native worker exited before finalization; original logs and checkpoints retained',native_worker_exit_code=child.returncode,
                cleanup_confirmed=False,completed_without_shortening=False)
            save_json(folder/'report.json',partial)
        print(json.dumps({'report':str(folder/'report.json'),'exit_code':child.returncode}),flush=True)
    finally:
        if child is not None and child.poll() is None:
            child.kill();child.wait(timeout=10)
        if not was_running:
            path=folder/'report.json'
            saved=json.loads(path.read_text(encoding='utf8')) if path.exists() else {**report,'error':'Worker failed before reporting'}
            saved['native_worker_exit_code'] = child.returncode if child is not None else None
            cleanup_marker=folder/'cleanup-stage.json'
            if cleanup_marker.is_file() and child is not None and child.returncode not in (0,1):
                marker=json.loads(cleanup_marker.read_text(encoding='utf8'))
                saved.update(cleanup_stage=marker['stage'],shutdown_stages=marker['stages'])
            saved['native_acceptance']=False
            try:
                deadline=args.egypt_deadline if egypt else None
                probe=cleanup_probe(deadline)
                runtime.stop(**({'port':2000,'deadline':deadline} if egypt else {}))
                saved['independent_cleanup_probe']=probe
                if egypt:
                    from backend.carla.runtime import native_processes
                    saved['simulator_exit_confirmed']=not native_processes(timeout=remaining_seconds(deadline,15))
                else:
                    saved['simulator_exit_confirmed']=runtime.inspect() is None
                saved['video_playback_after_exit']=(verify_videos(saved,deadline,diagnostic=True) if saved['simulator_exit_confirmed'] and getattr(args,'diagnostic',False) else
                    verify_videos(saved,deadline) if saved['simulator_exit_confirmed'] else
                    {'passed':False,'error':'CARLA process exit was not verified; playback was not attempted'})
                if not egypt:
                    from .crossing_causality import critical_prediction_evidence
                    saved['critical_prediction_evidence']=critical_prediction_evidence(saved)
                saved['native_acceptance']=bool(saved.get('pair',{}).get('scenario_validation',{}).get('passed')
                    and saved['pair'].get('conditions_match') and (egypt or saved['critical_prediction_evidence']['passed'])
                    and saved.get('source_unchanged') and saved.get('completed_without_shortening') and saved.get('finish_completed')
                    and saved.get('exports_closed') and saved.get('cleanup_confirmed') and probe['passed']
                    and saved['video_playback_after_exit']['passed'] and child is not None and child.returncode==0
                    and saved['simulator_exit_confirmed'])
            except (OSError,ValueError,RuntimeError,subprocess.SubprocessError) as error:
                saved['finalization_error']=str(error)
            if egypt:
                saved['source_unchanged'] = saved.get('source_unchanged') and source_fingerprint() == saved['source_sha256']
                saved['native_acceptance'] = saved['native_acceptance'] and saved['source_unchanged']
                saved['attempts_retained'] = all((folder/name).is_file() for name in ('initial.json','worker.log','source.zip'))
                saved['worker_deadline_expired']=report.get('worker_deadline_expired',False)
                saved['native_acceptance']=saved['native_acceptance'] and not saved['worker_deadline_expired']
                if getattr(args,'diagnostic',False):
                    saved['native_acceptance']=False
                    saved['diagnostic_assessment']=diagnostic_assessment(saved)
                    saved['diagnostic_passed']=saved['diagnostic_assessment']['passed']
            save_json(path,saved)
    return 0 if json.loads((folder/'report.json').read_text(encoding='utf8')).get(
        'diagnostic_passed' if getattr(args,'diagnostic',False) else 'native_acceptance') else 1


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--seed',type=int,default=1701);p.add_argument('--first',choices=('NORMAL','ROBOSPHERE'),default='NORMAL')
    p.add_argument('--render-profile',choices=('LOW','BALANCED','HIGH'),default='LOW')
    p.add_argument('--seconds',type=float,default=900.);p.add_argument('--worker',action='store_true');p.add_argument('--folder')
    p.add_argument('--scenario',choices=('EGYPT_URBAN_CHAOS_V1',));p.add_argument('--rule-ticket')
    p.add_argument('--egypt-budget');p.add_argument('--egypt-reservation');p.add_argument('--egypt-deadline',type=float)
    p.add_argument('--holdout-acceptance',action='store_true')
    p.add_argument('--diagnostic',action='store_true')
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
