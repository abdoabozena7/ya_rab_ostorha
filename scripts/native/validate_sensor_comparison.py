"""Three-seed native sensor-driver matrix; failures and original videos survive."""
import argparse
import copy
import hashlib
import json
import math
from pathlib import Path
import subprocess
import sys
import time
import uuid
from backend.learning.native_validation_budget import NativeValidationBudget
from scripts.validate_hybrid_native import ROOT,DIRECTORY,source_hashes,archive_sources

SEEDS=(1701,2811,4137)
SCENARIOS=('EMPTY_ROAD','FRONT_OBSTACLE','SUDDEN_BRAKING','PEDESTRIAN')


def normalized_condition(report):
    fixture=report.get('fixture') or {}
    ego=fixture.get('ego_initial') or {}
    if not ego or not fixture.get('sensor_configuration'):return None
    def actor_state(actor):
        return {key:copy.deepcopy(actor.get(key)) for key in ('blueprint','position','yaw_deg','velocity_mps','control')}
    return {'ego':actor_state(ego),'actors':[actor_state(actor) for actor in fixture.get('actors',[])],
            'sensors':fixture['sensor_configuration'],'geometry':fixture.get('ego_geometry'),
            'weather':fixture.get('weather'),'route':fixture.get('native_route')}


def conditions_match(first,second):
    if first is None or second is None:return False
    for key in ('sensors','geometry','weather','route'):
        if first[key]!=second[key]:return False
    if len(first['actors'])!=len(second['actors']):return False
    for left,right in zip([first['ego'],*first['actors']],[second['ego'],*second['actors']]):
        if left['blueprint']!=right['blueprint']:return False
        if math.dist(left['position'],right['position'])>.1:return False
        if abs((left['yaw_deg']-right['yaw_deg']+180)%360-180)>1:return False
        if math.dist(left['velocity_mps'],right['velocity_mps'])>.2:return False
    return True


def summarize(report,path):
    samples=report.get('samples',[])
    active=[sample for sample in samples if sample.get('journey',{}).get('status')=='RUNNING']
    stopped=any(sample.get('speed_kmh',math.inf)<.54 and sample.get('brake',0)>.01 for sample in active)
    sensor_brakes=[sample for sample in active if sample.get('stop',{}).get('applied_command',{}).get('brake',0)>.01
        and (sample.get('stop',{}).get('decision_source') in ('REACTIVE_SENSORS','RULE') or
             sample.get('stop',{}).get('comfort_control',{}).get('constraint')=='MEASURED_APPROACH')]
    validity=report.get('scenario_validity',{}).get('valid') is True
    contacts=len(report.get('contacts',[]))
    moved=report.get('native_planar_distance_m',0.)>2.
    arrived=report.get('journey',{}).get('status')=='ARRIVED'
    blocking=report['scenario'] in ('FRONT_OBSTACLE','SUDDEN_BRAKING')
    passed=bool(validity and moved and contacts==0 and not report.get('error')
                and report.get('native_cleanup_confirmed') and (stopped and sensor_brakes if blocking else arrived))
    recordings=report.get('recording',{}).get('runs',{})
    videos=[]
    for run in recordings.values():
        folder=Path(run['recording']) if run.get('recording') else None
        if folder and (folder/'video-status.json').is_file():
            videos.append({'recording':str(folder),'status':json.loads((folder/'video-status.json').read_text(encoding='utf8'))})
    return {'scenario':report['scenario'],'seed':report['seed'],'mode':report['mode'],'passed':passed,
            'scenario_valid':validity,'arrived':arrived,'contacts':contacts,'stopped':stopped,
            'distance_m':report.get('native_planar_distance_m'),'maximum_speed_kmh':report.get('maximum_speed_kmh'),
            'first_sensor_brake_s':sensor_brakes[0]['timestamp_s']-samples[0]['timestamp_s'] if sensor_brakes and samples else None,
            'sensor_brake_samples':len(sensor_brakes),'native_report':str(path),'videos':videos,
            'source_unchanged':report.get('source_unchanged'),'error':report.get('error'),
            'initial_condition':normalized_condition(report)}


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--seeds',default=','.join(map(str,SEEDS)))
    parser.add_argument('--scenarios',default=','.join(SCENARIOS));parser.add_argument('--seconds',type=float,default=3600.)
    parser.add_argument('--sim-seconds',type=float,default=25.);parser.add_argument('--speed',type=float,default=30.)
    args=parser.parse_args();seeds=[int(value) for value in args.seeds.split(',')];scenarios=args.scenarios.split(',')
    if not seeds or any(scenario not in SCENARIOS for scenario in scenarios):parser.error('Choose fixed seeds and supported native scenarios')
    if not 180<=args.seconds<=3600 or not 10<=args.sim_seconds<=60 or not 5<=args.speed<=30:parser.error('Invalid bounded matrix parameters')
    from scripts import final_runtime
    if final_runtime.state():raise RuntimeError('Run the isolated matrix only with the ordinary dashboard stopped')
    from backend.carla.runtime import NativeRuntime
    runtime=NativeRuntime();was_running=runtime.active is not None
    directory=ROOT/'output/sensor-comparison-20261019'/uuid.uuid4().hex;directory.mkdir(parents=True)
    budget=NativeValidationBudget.create_repair(directory,args.seconds)
    budget.ticket['authorization']='User requested the fixed three-seed Normal/predictive comparison; allowance is an internal resource bound, not a research-ledger reset'
    budget.path.write_text(json.dumps(budget.ticket,indent=2),encoding='utf8')
    summary={'source':'LIVE_NATIVE_CARLA','blueprint':'vehicle.mercedes.coupe_2020','seeds':seeds,
             'requested_speed_kmh':args.speed,'cases':[],'pairs':[],'accepted':False,
             'scope':'Scoped native sensor-driver fixtures; no RL or high-speed acceptance'}
    try:
        for seed in seeds:
            for scenario in scenarios:
                pair=[]
                for mode in ('NORMAL','ROBOSPHERE'):
                    remaining=budget.status()['remaining_s']
                    if remaining<180:raise TimeoutError('Native matrix resource bound reached; unfinished cases remain unaccepted')
                    report={'id':uuid.uuid4().hex,'source':'LIVE_NATIVE_CARLA','mode':mode,'scenario':scenario,
                            'seed':seed,'speed_kmh':args.speed,'samples':[],'cases':[],'source_hashes':source_hashes()}
                    folder=DIRECTORY/('probe-'+report['id']);folder.mkdir(parents=True)
                    report['source_archive']=archive_sources(folder,report['source_hashes'])
                    (folder/'initial-report.json').write_text(json.dumps(report),encoding='utf8')
                    seconds=min(600.,remaining)
                    command=[sys.executable,'-m','scripts.validate_hybrid_native','--worker','--folder',str(folder),
                        '--began',str(time.monotonic()),'--seconds',str(seconds),'--rule-ticket',str(budget.path),
                        '--mode',mode,'--scenario',scenario,'--seed',str(seed),'--speed',str(args.speed),
                        '--length','40','--sim-seconds',str(args.sim_seconds),'--blueprint',summary['blueprint'],
                        '--recording-directory',str(directory/'native-recordings/normal_city'),'--camera-semantics']
                    if scenario=='PEDESTRIAN':command+=['--pedestrian-delay','8']
                    print(json.dumps({'stage':'RUNNING','scenario':scenario,'seed':seed,'mode':mode,'folder':str(folder)}),flush=True)
                    with budget.experiment('physical-diagnostic',seconds),(folder/'native-worker.log').open('w',encoding='utf8') as output:
                        child=subprocess.Popen(command,cwd=ROOT,stdout=output,stderr=subprocess.STDOUT,
                            creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
                        try:child.wait(timeout=seconds-30)
                        except subprocess.TimeoutExpired:
                            subprocess.run(['taskkill','/PID',str(child.pid),'/T','/F'],capture_output=True,timeout=15)
                            child.wait(timeout=10)
                    path=folder/'report.json'
                    if path.exists():report=json.loads(path.read_text(encoding='utf8'))
                    else:report['error']='Native worker did not finalize; original log retained'
                    result=summarize(report,path);summary['cases'].append(result);pair.append(result)
                    print(json.dumps({key:value for key,value in result.items() if key not in ('initial_condition','videos')}),flush=True)
                    (directory/'summary.json').write_text(json.dumps(summary,indent=2),encoding='utf8')
                summary['pairs'].append({'scenario':scenario,'seed':seed,'conditions_match':conditions_match(
                    pair[0]['initial_condition'],pair[1]['initial_condition']),
                    'normal_passed':pair[0]['passed'],'predictive_passed':pair[1]['passed']})
        summary['accepted']=len(summary['cases'])==len(seeds)*len(scenarios)*2 and all(
            case['passed'] and case['source_unchanged'] for case in summary['cases']) and all(pair['conditions_match'] for pair in summary['pairs'])
    except Exception as error:summary['error']=str(error)
    finally:
        if not was_running:
            try:runtime.stop();summary['runtime_returned_to_stopped']=runtime.active is None
            except Exception as error:summary['runtime_cleanup_error']=str(error)
        summary['budget']=budget.status()
        for case in summary['cases']:case.pop('initial_condition',None)
        path=directory/'summary.json';path.write_text(json.dumps(summary,indent=2),encoding='utf8')
        print(json.dumps({'summary':str(path),'accepted':summary['accepted'],'cases':len(summary['cases']),'error':summary.get('error')}),flush=True)
    return 0 if summary['accepted'] else 1


if __name__=='__main__':raise SystemExit(main())
