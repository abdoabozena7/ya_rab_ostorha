"""Bounded production-worker hybrid probe with an independent charged ledger.

This is a diagnostic, not the full frozen acceptance matrix. Failed attempts,
source identity, actual controls, movement and cleanup are always retained.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path
import subprocess
import time
import uuid
import sys
import zipfile
from contextlib import nullcontext

from backend.learning.hybrid_budget import HybridBudget, DIRECTORY,working_time
from backend.core.journey_comparison import benchmark_terminal_supported

ROOT = Path(__file__).resolve().parents[1]


def source_hashes():
    return {str(p.relative_to(ROOT)):hashlib.sha256(p.read_bytes()).hexdigest()
        for pattern in ('backend/core/*.py','backend/carla/*.py','backend/computer_vision/*.py','backend/learning/hybrid_budget.py',
                        'config/hybrid-driving.json','config/route-bypass.json','scripts/validate_hybrid_native.py',
                        'scripts/native/route_bypass_world.py','scripts/native/validate_sensor_comparison.py') for p in ROOT.glob(pattern)}


def archive_sources(folder,hashes,root=ROOT):
    root=Path(root).resolve();sources={}
    for name,expected in hashes.items():
        source=(root/name).resolve()
        if not source.is_relative_to(root):raise ValueError('Source archive escaped the checkout')
        data=source.read_bytes()
        if hashlib.sha256(data).hexdigest()!=expected:
            raise RuntimeError('Source changed before archival: '+name)
        sources[source.relative_to(root).as_posix()]=data
    path=Path(folder)/'source.zip'
    with zipfile.ZipFile(path,'x',compression=zipfile.ZIP_DEFLATED) as archive:
        for name,data in sorted(sources.items()):archive.writestr(name,data)
    return {'path':str(path.resolve()),'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),
            'files':len(sources),'scope':'EXACT_SOURCE_BYTES_FOR_THIS_DIAGNOSTIC'}


def worker(args):
    from backend.learning.hybrid_budget import active_ticket
    if args.rule_ticket:
        from backend.learning.native_validation_budget import NativeValidationBudget
        budget=NativeValidationBudget(args.rule_ticket)
        if budget.status()['remaining_s']<=0:raise TimeoutError('Native validation allowance expired')
        if not args.production_drivers:budget.activate_rule()
        report_scope='PRODUCTION_DRIVERS' if args.production_drivers else 'DIAGNOSTIC_RULE_ADMISSION'
    elif active_ticket() is None:raise RuntimeError('A live parent-owned hybrid reservation is required')
    from backend.carla.provider import CarlaProvider
    from backend.core.service import SimulationService
    from backend.core.contracts import to_dict
    folder=Path(args.folder).resolve()
    if not folder.is_relative_to(DIRECTORY.resolve()):raise ValueError('Invalid native evidence directory')
    report=json.loads((folder/'initial-report.json').read_text(encoding='utf8'))
    service = None; signal_restore=[];provider=None;fixture=None;arm=None
    semantics_server=None;semantics=None
    profiler=None;profiled_steps=0
    if args.profile_steps:
        import cProfile
        profiler=cProfile.Profile()
    with nullcontext():
        began=args.began
        def stage(name):
            with (folder/'stages.jsonl').open('a',encoding='utf8') as stream:
                stream.write(json.dumps({'stage':name,'wall_s':time.monotonic()-began})+'\n');stream.flush()
        def capture_arm():
            if arm is None or service is None:return
            arm.update(journey=dict(service.journey),native_planar_distance_m=distance,
                maximum_speed_kmh=max((r['speed_kmh'] for r in arm['samples']),default=0.),
                maximum_unexplained_stop_s=maximum_stop,
                contacts=[to_dict(c) for c in service.collision_events if c.timestamp_s>=start_sim],
                recording=service.journey_comparison.snapshot(),wall_s=time.monotonic()-began)
            from backend.core.driving_quality import evaluate_quality
            arm['driving_quality']=evaluate_quality(arm['samples'],
                arrived=service.journey.get('status')=='ARRIVED',contacts=len(arm['contacts']))
            report['original_safety_fault']=service.safety_fault
            if not any(saved is arm for saved in report['arms']):report['arms'].append(arm)
            report.update(arm)
        try:
            stage('ensure_native_runtime')
            from backend.carla.runtime import NativeRuntime
            import carla
            runtime=NativeRuntime()
            report['prior_graphics']=runtime.active
            if args.graphics_profile!='REUSE':
                from backend.graphics import launch
                desired={**launch(args.graphics_profile),'renderer':args.renderer,'offscreen':True}
                if not runtime.active or any(runtime.active.get(k)!=v for k,v in desired.items()):
                    runtime.stop()
                    try:runtime.launch(desired,'127.0.0.1',2000,carla)
                    except Exception:
                        runtime.stop()
                        runtime.launch({'quality':'Epic','resolution':'1280x720','render_profile':'HIGH','offscreen':True},'127.0.0.1',2000,carla)
                        raise
            if not runtime.active:
                runtime.launch({'quality':'Epic','resolution':'1280x720','render_profile':'HIGH','offscreen':True},'127.0.0.1',2000,carla)
            report['graphics']=runtime.active
            stage('connect_production_provider')
            provider=CarlaProvider(blueprint=args.blueprint,spawn_index=args.spawn,sensor_suite=True,collision_sensor=True,fresh_start=True,traffic_manager_port=8052)
            if args.ordinary_sensors:provider.camera_settings['_suppress_pilot_surround']=True
            if args.rule_ticket:report['driver_admission_scope']=report_scope
            provider.connect(); provider._ensure_dashboard_tools()
            population={**provider.population.config,'vehicle_count':0,'pedestrian_count':0,'seed':args.seed,'chaos_percent':0}
            provider.population.apply(population)
            if args.scenario!='DIAGNOSTIC':
                if args.scenario.startswith('RULE_BYPASS_'):
                    from scripts.native.route_bypass_world import RuleBypassWorld
                    fixture=RuleBypassWorld(provider)
                else:
                    from backend.carla.hybrid_world import HybridWorld
                    fixture=HybridWorld(provider)
                options={'fixture_variant':args.fixture_variant} if args.scenario.startswith('RULE_BYPASS_') else {}
                if args.scenario=='PEDESTRIAN' and args.pedestrian_lateral is not None:
                    options.update(pedestrian_lateral=args.pedestrian_lateral,require_complete_crossing=True)
                fixture.setup(args.scenario,args.seed,spawn_index=args.spawn,route_length=args.length,**options)
                if args.pedestrian_delay is not None:
                    for event in fixture.events:
                        if event['kind']=='PEDESTRIAN_CROSSING':event['at_s']=args.pedestrian_delay
                    report['pedestrian_delay_s']=args.pedestrian_delay
            api=provider.connection.api
            for light in provider.world.world.get_actors().filter('traffic.traffic_light*'):
                signal_restore.append((light,light.get_state(),light.get_green_time(),light.get_yellow_time(),light.get_red_time(),light.is_frozen()))
                light.set_state(api.TrafficLightState.Red if args.scenario=='RULE_BYPASS_RED_SIGNAL' else api.TrafficLightState.Green)
                light.set_green_time(1000.);light.freeze(True)
            waypoint=provider.dashboard_tools.map.get_waypoint(provider.ego.actor.get_location())
            for _ in range(max(1,round(args.length/2.))):
                choices=waypoint.next(2.)
                if not choices:break
                prior=waypoint.transform.rotation.yaw
                waypoint=min(choices,key=lambda w:abs((w.transform.rotation.yaw-prior+180)%360-180))
            location=waypoint.transform.location
            target={'map':provider.dashboard_tools.map_name,'location':[location.x,location.y,location.z],'name':'Hybrid physical diagnostic'}
            tools=provider.dashboard_tools
            tools.route,tools.native_route=tools.route_service.plan(provider.ego.actor.get_location(),target)
            service=SimulationService(provider,required_sensors=provider.required_sensors)
            from backend.core.journey_comparison import JourneyComparison
            service.journey_comparison=JourneyComparison(folder/'journeys')
            if args.recording_directory:
                service.recording_directory=Path(args.recording_directory).resolve()
                report['recording_directory']=str(service.recording_directory)
            service.pause_on_first_observation=True;service.start(threaded=False)
            if args.camera_semantics:
                import threading
                from backend.server import DashboardHTTPServer,Handler
                from backend.computer_vision.service import PerceptionService,ControlPerceptionCache
                semantics_server=DashboardHTTPServer(('127.0.0.1',8011),Handler)
                semantics_server.simulation_service=service
                semantics=PerceptionService(8011);semantics_server.perception=semantics
                service.control_perception=ControlPerceptionCache()
                threading.Thread(target=semantics_server.serve_forever,daemon=True).start()
                report['semantic_source']='REAL_FRONT_CAMERA_YOLO_ONNX_CPU; no fixture labels supplied'
            stage('warmup')
            for _ in range(20):service.step_once()
            if fixture:fixture.configure_route()
            report['sensor_ids']=list(provider.sensor_manager.actors)
            report['arms']=[]
            modes=('BASELINE','HYBRID') if args.paired else (args.mode,)
            for arm_index,mode in enumerate(modes):
                if arm_index:
                    for _ in range(6):service.step_once()
                    pair_id=service.journey_comparison.data['pair_id']
                    service.queue_dashboard_action('prepare_journey_mode',{'mode':mode,'pair_id':pair_id})
                    service.step_once()
                    if service.dashboard_result.get('status')!='APPLIED':
                        raise RuntimeError('Matched pair restoration failed: '+str(service.dashboard_result))
                    for _ in range(8):service.step_once()
                else:pair_id=None
                service.start_journey(args.speed,driving_mode=mode,pair_id=pair_id,benchmark=args.benchmark or args.paired)
                stage('journey_requested_'+mode)
                arm={'mode':mode,'samples':[]}
                start_sim=service.observation.timestamp_s;previous=None;distance=0.;stopped=maximum_stop=0.
                while time.monotonic()-began<args.seconds-150 and service.observation.timestamp_s-start_sim<args.sim_seconds:
                    if fixture and service.journey['status']=='RUNNING':
                        if fixture.started is None:fixture.begin(service.observation.timestamp_s)
                        fixture.before_tick(service.observation.timestamp_s)
                    service.journey_heartbeat(service.session_id)
                    profile_this_step=(profiler is not None and mode in ('HYBRID','ROBOSPHERE')
                        and service.journey['status']=='RUNNING' and profiled_steps<args.profile_steps)
                    if profile_this_step:profiler.enable()
                    try:service.step_once()
                    finally:
                        if profile_this_step:profiler.disable();profiled_steps+=1
                    frame=service.observation; vehicle=frame.vehicle
                    if previous:
                        distance+=math.dist(previous.vehicle.transform.position_m[:2],vehicle.transform.position_m[:2])
                        dt=frame.timestamp_s-previous.timestamp_s
                        traffic_wait='traffic light' in (getattr(provider,'navigation_stop_reason',None) or '').lower()
                        if vehicle.speed_mps<.15 and service.journey['status']=='RUNNING' and not traffic_wait:stopped+=dt
                        else:stopped=0.
                        maximum_stop=max(maximum_stop,stopped)
                    previous=frame
                    bypass=getattr(provider,'navigation_bypass',None)
                    bypass_state=None
                    if bypass is not None:
                        anchor=bypass.target_anchor
                        bypass_state={'preparing':bypass.preparing,'arming':bypass.arming,'engaged':bypass.engaged,
                            'driver_phase':bypass.driver.phase,'cooldown_until':bypass.cooldown_until,
                            'target_anchor':None if anchor is None else [anchor[0].tolist(),list(anchor[1])],
                            'odometry_origin_m':service.control_scene.prediction.get('odometry_origin_m') if service.control_scene else None,
                            'odometry_yaw_rad':service.control_scene.prediction.get('odometry_yaw_rad') if service.control_scene else None}
                    arm['samples'].append({'frame_id':frame.frame_id,'timestamp_s':frame.timestamp_s,
                        'position_m':list(vehicle.transform.position_m),'speed_kmh':vehicle.speed_mps*3.6,
                        'throttle':vehicle.throttle,'brake':vehicle.brake,'gear':vehicle.gear,'reverse':vehicle.reverse,
                        'steering':vehicle.steering,'yaw_rate_radps':vehicle.angular_velocity_radps[2],
                        'longitudinal_acceleration_mps2':vehicle.longitudinal_acceleration_mps2,
                        'journey':dict(service.journey),'control_scene':service.control_scene.snapshot(frame.timestamp_s,service.now()) if service.control_scene else None,
                        'maneuver':dict(getattr(service,'maneuver_status',{})),'stop':service._public_stop_diagnostics(),
                        'route_bypass':bypass_state,
                        'independent_reference':provider.ground_truth_debug(),
                        'backend_step_ms':service.backend_step_ms})
                    if args.camera_semantics and service.control_scene:
                        prediction=service.control_scene.prediction
                        people=[t for t in prediction['tracks'] if t.get('class') in ('person','pedestrian')]
                        arm['samples'][-1]['pedestrian_forecast_audit']={
                            'tracks':[{k:to_dict(t[k]) for k in ('id','position_m','velocity_mps','half_size_m','confirmed','occlusion_s','observed_crossing_cleared','semantic_evidence','measurement_evidence') if k in t} for t in people[:12]],
                            'modes':[{'track_id':m['track_id'],'source':m['source']} for m in prediction['trajectories'] if any(t['id']==m['track_id'] for t in people)]}
                    if args.audit_tracks and service.control_scene and len(arm['samples'])%20==0:
                        arm['samples'][-1]['measured_tracks_audit']=[{k:to_dict(t[k]) for k in
                            ('id','position_m','half_size_m','velocity_mps','confirmed','occlusion_s','support_points') if k in t}
                            for t in service.control_scene.prediction['tracks']]
                    if len(arm['samples'])%20==0:
                        with (folder/'progress.jsonl').open('a',encoding='utf8') as stream:
                            stream.write(json.dumps(arm['samples'][-1],allow_nan=False)+'\n')
                    if service.journey['status'] in ('ARRIVED','ERROR','PAUSED'):break
                capture_arm()
                if args.paired and not benchmark_terminal_supported(service.journey):
                    report['pair_interrupted']=mode+' arm did not reach a supported terminal outcome'
                    break
            if fixture:
                report['fixture']=fixture.manifest
                report['scenario_validity']=fixture.validity()
        except BaseException as error:
            import traceback
            report.update(error=str(error),traceback=traceback.format_exc())
            if service:report['original_runtime_fault']=service.runtime_fault
            try:
                if arm is not None:arm.update(incomplete_episode=True,exception_type=type(error).__name__)
                capture_arm()
            except Exception as capture_error:report['partial_capture_error']=str(capture_error)
        finally:
            stage('cleanup')
            if semantics_server:semantics_server.shutdown();semantics_server.server_close()
            if semantics:semantics.close()
            if profiler is not None:
                import pstats
                profiler.dump_stats(str(folder/'native-control.pstats'))
                with (folder/'native-control-profile.txt').open('w',encoding='utf8') as stream:
                    pstats.Stats(profiler,stream=stream).sort_stats('cumtime').print_stats(90)
                report['profiled_control_steps']=profiled_steps
                report['profiling_qualification']='Instrumented diagnostic; profile overhead is included and cannot establish acceptance timing'
            if service:
                try:
                    service.stop_driving('operator_stop')
                    for _ in range(4):service.step_once()
                except Exception as error:report['terminal_stop_warning']=str(error)
                try:
                    benchmark_fixture=getattr(provider,'benchmark_fixture',None)
                    if benchmark_fixture:benchmark_fixture.close();provider.benchmark_fixture=None
                    if fixture:fixture.close()
                    for light,state,green,yellow,red,frozen in signal_restore:
                        light.set_green_time(green);light.set_yellow_time(yellow);light.set_red_time(red)
                        light.set_state(state);light.freeze(frozen)
                    report['signal_settings_restored']=True
                except Exception as error:report['signal_cleanup_error']=str(error)
                try:
                    # Always close, even when the ordinary stop rejects stale
                    # telemetry. Close applies a terminal brake and restores the
                    # world. Large JSON serialization happens only afterwards.
                    service.close();report['native_cleanup_confirmed']=not provider.cleanup_errors
                    from backend.core.driving_video import wait_for_exports
                    report['video_exports_finished']=wait_for_exports(min(30.,max(0.,args.seconds-(time.monotonic()-began)-90.)))
                except Exception as error:report['cleanup_error']=str(error)
            elif provider:
                try:provider.close();report['native_cleanup_confirmed']=not provider.cleanup_errors
                except Exception as error:report['cleanup_error']=str(error)
            report['source_unchanged']=source_hashes()==report['source_hashes']
            (folder/'report.json').write_text(json.dumps(report,indent=2,allow_nan=False),encoding='utf8')
    return 0 if not report.get('error') and report.get('journey',{}).get('status')=='ARRIVED' and not report.get('contacts') else 1


def run(args):
    # Restore only after the child process and its C++ TrafficManager registry
    # have exited. Python close() alone does not end those native lifetimes.
    from scripts import final_runtime
    saved=final_runtime.state()
    if not saved or not saved.get('connected'):
        raise RuntimeError('A connected dashboard snapshot is required to preserve and restore the operator session')
    report={'id':uuid.uuid4().hex,'scope':'Diagnostic production-worker probe; not complete behavioral acceptance',
            'source':'LIVE_NATIVE_CARLA','speed_kmh':args.speed,'mode':args.mode,'scenario':args.scenario,
            'seed':args.seed,'cases':[],'samples':[]}
    folder=DIRECTORY/('probe-'+report['id']);folder.mkdir(parents=True)
    (folder/'operator-before.json').write_text(json.dumps(saved,indent=2),encoding='utf8')
    from backend.carla.runtime import NativeRuntime
    prior=NativeRuntime().active
    (folder/'prior-graphics.json').write_text(json.dumps(prior),encoding='utf8')
    report['source_hashes']=source_hashes()
    report['source_archive']=archive_sources(folder,report['source_hashes'])
    (folder/'initial-report.json').write_text(json.dumps(report),encoding='utf8')
    if args.rule_ticket:
        from backend.learning.native_validation_budget import NativeValidationBudget
        budget=NativeValidationBudget(args.rule_ticket)
    else:budget=HybridBudget()
    with budget.experiment('physical-diagnostic',args.seconds):
        began=time.monotonic();working_began=working_time()
        try:
            final_runtime.disconnect_backend()
            command=[sys.executable,'-m','scripts.validate_hybrid_native',*sys.argv[1:],
                     '--worker','--folder',str(folder),'--began',str(began)]
            with (folder/'native-worker.log').open('w',encoding='utf8') as output:
                child=subprocess.Popen(command,cwd=ROOT,stdout=output,stderr=subprocess.STDOUT,
                    creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
                try:child.wait(timeout=args.seconds-120)
                except subprocess.TimeoutExpired:
                    subprocess.run(['taskkill','/PID',str(child.pid),'/T','/F'],capture_output=True,timeout=15)
                    child.wait(timeout=10);raise
            if (folder/'report.json').exists():report=json.loads((folder/'report.json').read_text(encoding='utf8'))
            else:report['error']='Native worker exited before it could finalize its report; inspect stages and native-worker.log'
            report['native_worker_exit_code']=child.returncode
            if child.returncode not in (0,1) or report.get('cleanup_error') or not report.get('native_cleanup_confirmed'):
                with (folder/'runtime-recovery.log').open('w',encoding='utf8') as output:
                    subprocess.run([sys.executable,'-m','scripts.restore_hybrid_runtime',str(folder/'prior-graphics.json')],
                        stdout=output,stderr=subprocess.STDOUT,timeout=100,check=True)
                report['prior_graphics_restored_after_worker_crash']=True
        except BaseException as error:
            if (folder/'report.json').exists():report=json.loads((folder/'report.json').read_text(encoding='utf8'))
            report['orchestration_error']=str(error)
        finally:
            ticket=DIRECTORY/'active-ticket.json'
            if not args.rule_ticket and ticket.exists():ticket.unlink()
            try:
                restore_command=[sys.executable,'-m','scripts.final_runtime']
                if args.rule_ticket and budget.status()['remaining_s']>0:restore_command+=['--validation-ticket',args.rule_ticket]
                subprocess.run(restore_command,cwd=ROOT,check=True,
                    timeout=90,capture_output=True,text=True)
                final_runtime.restore_operator(saved)
                restored=final_runtime.state()
                first=(restored.get('vehicle') or {}).get('frame')
                # Verify continued ticking after the worker is gone, beyond
                # the initial HTTP-ready response.
                for _ in range(5):time.sleep(1.);restored=final_runtime.state()
                report['restored']={'connected':restored.get('connected'),'mode':restored.get('mode'),
                    'speed_kmh':(restored.get('vehicle') or {}).get('speedKmh'),
                    'continued_ticking':(restored.get('vehicle') or {}).get('frame')!=first}
            except BaseException as error:report['restore_error']=str(error)
            report['reservation_wall_s']=time.monotonic()-began
            report['reservation_working_s']=working_time()-working_began
            report['platform_suspend_s']=max(0.,report['reservation_wall_s']-report['reservation_working_s'])
            report['platform_interrupted']=report['platform_suspend_s']>1.
            (folder/'report.json').write_text(json.dumps(report,indent=2,allow_nan=False),encoding='utf8')
    print(json.dumps({k:v for k,v in report.items() if k not in ('samples','arms','source_hashes','recording','contacts','fixture','original_safety_fault')}),flush=True)
    print(str(folder/'report.json'),flush=True)
    return 0 if report.get('native_worker_exit_code')==0 and report.get('restored',{}).get('connected') else 1


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--seconds',type=float,default=600)
    parser.add_argument('--rule-ticket',help='Separate expiring RULE repair authorization; never admits hybrid')
    parser.add_argument('--speed',type=float,default=20);parser.add_argument('--mode',choices=('HYBRID','BASELINE','ROBOSPHERE','NORMAL'),default='HYBRID')
    parser.add_argument('--spawn',type=int,default=152);parser.add_argument('--length',type=float,default=60)
    parser.add_argument('--sim-seconds',type=float,default=45)
    parser.add_argument('--benchmark',action='store_true')
    parser.add_argument('--paired',action='store_true',help='Run BASELINE then HYBRID with audited identical initial conditions')
    parser.add_argument('--scenario',default='DIAGNOSTIC')
    parser.add_argument('--seed',type=int,default=1701)
    parser.add_argument('--recording-directory',help='Optional local evidence disk for diagnostic recordings')
    parser.add_argument('--profile-steps',type=int,default=0,help='Instrument up to 100 running hybrid ticks; diagnostic timing only')
    parser.add_argument('--camera-semantics',action='store_true',help='Use the real RGB worker through an isolated read-only HTTP host')
    parser.add_argument('--ordinary-sensors',action='store_true',help='Keep the ordinary sensor rig instead of ticket-only surround sensors')
    parser.add_argument('--production-drivers',action='store_true',help='Use the resource bound without admitting experimental RULE bypass')
    parser.add_argument('--pedestrian-lateral',type=float,help='Evaluator-only starting lateral position; require complete physical crossing')
    parser.add_argument('--pedestrian-delay',type=float,help='Evaluator-only crossing delay in simulation seconds; never sent to the controller')
    parser.add_argument('--audit-tracks',action='store_true',help='Retain compact measured track geometry once per simulation second')
    parser.add_argument('--fixture-variant',type=int,default=0,help='Evaluator-only alternative legal road fixture; all failed variants remain retained')
    parser.add_argument('--blueprint',default='vehicle.lincoln.mkz_2020',help='Native ego model; onboard geometry is measured for this actor')
    parser.add_argument('--graphics-profile',choices=('REUSE','LOW','BALANCED','HIGH'),default='REUSE')
    parser.add_argument('--renderer',choices=('D3D11','D3D12'),default='D3D12')
    parser.add_argument('--worker',action='store_true',help=argparse.SUPPRESS)
    parser.add_argument('--folder',help=argparse.SUPPRESS);parser.add_argument('--began',type=float,help=argparse.SUPPRESS)
    args=parser.parse_args()
    if args.rule_ticket and (args.mode not in ('ROBOSPHERE','NORMAL') or args.paired):parser.error('Sensor repair ticket cannot enable hybrid or paired hybrid diagnostics')
    if not 180<=args.seconds<=1800 or not 5<=args.speed<=50:parser.error('Use a bounded 180–1800 second probe and 5–50 km/h')
    if not 0<=args.profile_steps<=100:parser.error('Profile 0–100 control ticks')
    if not 0<=args.fixture_variant<=100:parser.error('Fixture variant must be 0–100')
    if args.pedestrian_delay is not None and (args.scenario!='PEDESTRIAN' or not 0<=args.pedestrian_delay<=120):
        parser.error('Pedestrian delay requires PEDESTRIAN and a finite 0–120 second delay')
    if args.pedestrian_lateral is not None and (args.scenario!='PEDESTRIAN' or not 1.5<=abs(args.pedestrian_lateral)<=5.):
        parser.error('Pedestrian lateral requires PEDESTRIAN and a finite 1.5–5 metre offset on either side')
    if args.paired and args.scenario!='DIAGNOSTIC':parser.error('Matched scripted hazards require fixture-reset validation first')
    raise SystemExit(worker(args) if args.worker else run(args))
