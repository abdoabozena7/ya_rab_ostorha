"""Native pilot runner with explicit invalid/failure outcomes and a new ledger.

Physical control is validated first. The trainer refuses to run until ordinary
native motion gates pass; no random or untrained weights are called a checkpoint.
"""
import argparse
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import urllib.request
from backend.learning.pilot_budget import PilotBudget,DEFAULT_ROOT
from backend.learning.pilot_provenance import control_hashes

ROOT=Path(__file__).resolve().parents[1]


def historical_hashes():
    paths=[ROOT/'output'/name/'budget.sqlite' for name in ('motion-reliability','congestion-recovery','predictive-v2')]
    return {str(p.relative_to(ROOT)):hashlib.sha256(p.read_bytes()).hexdigest() for p in paths if p.exists()}


def request(operation,**data):
    body=json.dumps({'operation':operation,**data},allow_nan=False).encode()
    req=urllib.request.Request('http://127.0.0.1:8000/api/simulation/rl',body,{'Content-Type':'application/json'})
    try:
        with urllib.request.urlopen(req,timeout=65) as r:return json.load(r)
    except urllib.error.HTTPError as error:raise RuntimeError(json.load(error).get('error',str(error))) from error


def take_control_and_hold():
    from websockets.sync.client import connect
    with connect('ws://127.0.0.1:8001',max_size=2**23) as ws:
        state=json.loads(ws.recv())
        for seq,kind in enumerate(('take_control','acknowledge_stop','stop_driving'),1):
            ws.send(json.dumps({'type':kind,'sequence':seq}))
            deadline=time.monotonic()+15
            while time.monotonic()<deadline:
                value=json.loads(ws.recv(timeout=5))
                if value.get('type')=='error':
                    if kind=='acknowledge_stop':break
                    raise RuntimeError(value.get('error'))
                if value.get('acknowledged')==seq:break
            else:raise RuntimeError('Control acknowledgement missing')


def physical_choice(bundle,mode,scenario=None):
    # Baseline explicitly owns useful motion here. PPO uses the same candidates
    # and emergency shield, and never gets credited for these baseline decisions.
    if scenario=='BLOCKED_REVERSE':
        moving_forward=next((i for i,c in enumerate(bundle['candidates']) if c['id']=='CONTINUE' and
            c['admitted'] and c['command']['throttle']>0 and c['command']['brake']==0),None)
        if moving_forward is not None:return moving_forward
        reverse=next((i for i,c in enumerate(bundle['candidates']) if c['id']=='REVERSE_STRAIGHT' and c['admitted']),None)
        if reverse is not None:return reverse
    preference=('DRIVER','STOP','SLOW','HOLD') if mode=='MANUAL_PROTECTION' else ('CONTINUE','SLOW','STOP','HOLD')
    for name in preference:
        for i,c in enumerate(bundle['candidates']):
            if c['id']==name and c['admitted']:return i
    return 0


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--phase',choices=('control','scenario_prediction','evaluation'),default='control')
    parser.add_argument('--seconds',type=float,default=300.)
    parser.add_argument('--episodes',type=int,default=2)
    parser.add_argument('--scenario',default='EMPTY_ROAD')
    parser.add_argument('--spawn-indices',default='152,54,73,91')
    parser.add_argument('--route-length',type=float,default=40.)
    parser.add_argument('--reload',action='store_true')
    parser.add_argument('--split',choices=('TRAIN','VALIDATION','TEST'),default='VALIDATION')
    args=parser.parse_args()
    if not 1<=args.episodes<=100 or not 30<=args.seconds<=2700:parser.error('Invalid native experiment bounds')
    indices=[int(i) for i in args.spawn_indices.split(',')]
    budget=PilotBudget();reservation=budget.reserve(args.phase,args.seconds);budget.publish_ticket(reservation)
    before=historical_hashes();token=None;report={'source':'LIVE_NATIVE_CARLA','phase':args.phase,'episodes':[],
        'native_accepted':False,'learned_control_used':False,'historical_before':before,
        'backend_blas_threads':1 if args.reload else 'INHERITED_UNVERIFIED',
        'qualification':{'implementation_sha256':control_hashes(),
                         'freshness_measurement':'AT_ACTION_REQUEST_FROM_ORIGINAL_SENSOR_RECEIPT'}}
    deadline=reservation[1]+args.seconds-15.
    try:
        if args.reload:
            runtime_env={**os.environ,'OPENBLAS_NUM_THREADS':'1','OMP_NUM_THREADS':'1','MKL_NUM_THREADS':'1'}
            proc=subprocess.run([str(ROOT/'.venv-carla/Scripts/python.exe'),'-m','scripts.final_runtime','--reload'],cwd=ROOT,
                                env=runtime_env,capture_output=True,text=True,timeout=90)
            report['reload']={'returncode':proc.returncode,'stdout':proc.stdout,'stderr':proc.stderr}
            if proc.returncode:raise RuntimeError('Backend reload failed')
        take_control_and_hold()
        value=request('maneuver_acquire',split=args.split,max_steps=800,policy_id='PHYSICAL_BASELINE');token=value['token']
        for episode in range(args.episodes):
            if time.monotonic()>=deadline:raise TimeoutError('Experiment deadline; remaining required episodes incomplete')
            mode='MANUAL_PROTECTION' if args.scenario=='BENIGN_MANUAL' else 'AUTONOMOUS'
            trace=[{'at_s':0.,'throttle':.3,'brake':0.,'steering':0.},
                   {'at_s':8.,'throttle':0.,'brake':1.,'steering':0.}]
            parameters={'spawn_index':indices[episode%len(indices)],'route_length':args.route_length,
                        'time_limit_s':50.,'cap_mps':4.}
            if mode=='MANUAL_PROTECTION':parameters['driver_trace']=trace
            started=time.monotonic()
            try:
                first_seed={'TRAIN':0,'VALIDATION':1000,'TEST':2000}[args.split]
                value=request('maneuver_reset',token=token,seed=first_seed+episode,mode=mode,scenario=args.scenario,parameters=parameters)
                while time.monotonic()<deadline:
                    bundle=value['bundle'];action=physical_choice(bundle,mode,args.scenario)
                    value=request('maneuver_step',token=token,action=action,snapshot_hash=bundle['snapshot_hash'],
                                  frame_id=bundle['frame_id'],timestamp_s=bundle['timestamp_s'])
                    if value['terminated'] or value['truncated']:break
                else:raise TimeoutError('Episode incomplete at experiment deadline')
                report['episodes'].append({**value['info'],'wall_seconds':time.monotonic()-started})
            except Exception as error:
                report['episodes'].append({'outcome':'INFRASTRUCTURE_OR_SCENARIO_FAILURE','error':str(error),
                                          'spawn_index':parameters['spawn_index'],'wall_seconds':time.monotonic()-started})
                if 'Transport' in str(error) or 'lease' in str(error).lower():raise
        valid=[e for e in report['episodes'] if e.get('scenario_validity',{}).get('valid')]
        completions=[e for e in valid if e.get('outcome')=='SUCCESS' and e['metrics']['collisions']==0 and
                     e['metrics']['maximum_clear_path_stop_s']<=3.]
        report.update(valid_episodes=len(valid),ordinary_completions=len(completions),
                      ordinary_gate=args.scenario in ('EMPTY_ROAD','CURVE') and len(completions)>=10 and len(completions)==len(report['episodes']))
    except Exception as error:report['error']=str(error)
    finally:
        if token:
            try:report['restoration']=request('maneuver_close',token=token)
            except Exception as error:report['restoration_error']=str(error)
        try:budget.finish(reservation)
        except Exception as error:report['budget_error']=str(error)
        report['budget']=budget.status();report['historical_after']=historical_hashes()
        report['historical_ledgers_unchanged']=report['historical_before']==report['historical_after']
        report['qualification']['implementation_unchanged']=report['qualification']['implementation_sha256']==control_hashes()
        total=sum(e.get('metrics',{}).get('decision_frames',0) for e in report['episodes'])
        fresh=sum(e.get('metrics',{}).get('fresh_decision_frames',0) for e in report['episodes'])
        report['qualification']['fresh_scene_fraction']=fresh/total if total else 0.
        path=DEFAULT_ROOT/('run-'+reservation[0]+'.json');path.write_text(json.dumps(report,indent=2,allow_nan=False),encoding='utf8')
        print(json.dumps({'report':str(path),'outcomes':[e.get('outcome') for e in report['episodes']],
                          'ordinary_gate':report.get('ordinary_gate',False),'error':report.get('error'),
                          'charged_s':report['budget']['charged_s']}),flush=True)
    return 0 if report.get('ordinary_gate') and not report.get('restoration_error') and report['historical_ledgers_unchanged'] else 1


if __name__=='__main__':sys.exit(main())
