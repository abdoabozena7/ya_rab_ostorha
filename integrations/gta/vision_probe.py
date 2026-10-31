"""Actual local models on pinned recorded GTA data. Static replay, no policy admission."""
import argparse
import hashlib
import json
import math
from pathlib import Path
import subprocess
import sys
import time
import uuid
import zipfile
import numpy as np
import bootstrap as boot
import preflight

HERE=Path(__file__).resolve().parent
PROJECT=HERE.parents[1]
TASK=HERE/'.runtime-proof/gta-vision-replay-20261031'


def scoped_output(output):
    resolved=output.resolve()
    if not resolved.is_relative_to((TASK/'runs/recorded-vision-models').resolve()):raise ValueError('Output must be a dedicated vision proof run')
    return resolved


def validate():
    lock=json.loads((HERE/'vision-lock.json').read_text());source=Path(lock['source_run']).resolve()
    if not source.is_relative_to((HERE/'.runtime-proof/gta-sensor-calibration-20261031/runs').resolve()):raise ValueError('Wrong native source run')
    for name,key in (('receipt.json','source_receipt_sha256'),('capture.jsonl','capture_jsonl_sha256'),('bridge.jsonl','bridge_jsonl_sha256')):
        if boot.digest(source/name)!=lock[key]:raise ValueError('Recorded source changed: '+name)
    if not json.loads((source/'receipt.json').read_text())['passed']:raise ValueError('Native receipt did not pass')
    for name,value in lock['upstream_source_hashes'].items():
        if boot.digest(PROJECT/name)!=value:raise ValueError('Pinned implementation changed: '+name)
    if boot.digest(PROJECT/lock['model_path'])!=lock['model_sha256']:raise ValueError('Existing model changed')
    return lock,source


def raw_bytes(source,lock,name):
    if name not in lock['raw_hashes'] or Path(name).name!=name:raise ValueError('Unpinned raw input')
    path=source/name
    if path.exists():body=path.read_bytes()
    else:
        with zipfile.ZipFile(source/'raw-captures.zip') as archive:body=archive.read(name)
    if hashlib.sha256(body).hexdigest()!=lock['raw_hashes'][name]:raise ValueError('Raw input hash mismatch')
    return body


def center_vehicle(detections):
    candidates=[d for d in detections if d['class'] in ('car','truck','bus','motorcycle')
                and d['xyxy'][0]<=320<=d['xyxy'][2] and d['xyxy'][1]<=180<=d['xyxy'][3]]
    return max(candidates,key=lambda d:d['confidence']) if candidates else None


def metric_position(capture,box,depth,ego):
    if depth.size!=640*360:raise ValueError('Malformed depth input')
    x1,y1,x2,y2=box;x=(x1+x2)/2;y=(y1+y2)/2
    if not all(math.isfinite(v) for v in box) or not 0<=x<640 or not 0<=y<360:raise ValueError('Invalid image geometry')
    roi=depth.reshape(360,640)[max(0,int(y)-2):int(y)+3,max(0,int(x)-2):int(x)+3]
    valid=roi[np.isfinite(roi)&(roi>1e-8)&(roi<1-1e-8)]
    if valid.size<9:raise ValueError('Unknown metric depth')
    n,f=capture['near'],capture['far'];raw=float(np.median(valid));z=n*f/(n+raw*(f-n))
    focal=360/(2*math.tan(math.radians(ego['fov'])/2));lateral=(x-320)*z/focal
    heading=math.radians(ego['heading_deg']);forward=np.array([-math.sin(heading),math.cos(heading)])
    right=np.array([math.cos(heading),math.sin(heading)])
    world=np.array(ego['camera'][:2])+forward*z+right*lateral
    # Canonical planar y-right frame; adapter performs its documented reflection.
    return [float(world[0]),-float(world[1])]


def detector_worker(output,provider):
    lock,source=validate();sys.path.insert(0,str(PROJECT))
    from backend.computer_vision.detector import RoadDetector
    captures=[json.loads(s) for s in (source/'capture.jsonl').read_text().splitlines()]
    ego_rows=[json.loads(s) for s in (source/'bridge.jsonl').read_text().splitlines()]
    phases=('RANGE10','RANGE30','RANGE60','RANGE80','RANGE100','RANGE120')
    selected=[min((c for c in captures if c['stage']==phase and c['rgb_ok']),key=lambda c:abs(c['phase_s']-2)) for phase in phases]
    inputs={};runs=[];detector=None;providers={}
    def image(c):
        name='capture-%06d.rgb'%c['serial'];body=raw_bytes(source,lock,name);inputs[name]=lock['raw_hashes'][name]
        return np.frombuffer(body,np.uint8).reshape(360,640,3)
    try:
        for requested in (provider,):
            if detector is not None:detector.close()
            detector=RoadDetector(PROJECT/lock['model_path'],execution_provider=requested)
            if requested=='DML' and detector.runtime['execution_provider']!='DmlExecutionProvider':raise ValueError('Requested real GPU environment fell back to CPU')
            detector.predict(image(selected[0]),frame_id=selected[0]['native_frame']) # measured separately from warmed calls
            measured=[]
            for c in selected:
                rgb=image(c);start=time.perf_counter();found=detector.predict(rgb,frame_id=c['native_frame']);elapsed=time.perf_counter()-start
                measured.append({'serial':c['serial'],'stage':c['stage'],'duration_ms':elapsed*1000,'detections':found,
                                 'center_vehicle':center_vehicle(found)})
            run={'requested_provider':provider,'runtime':detector.runtime,'profile':detector.profile,'frames':measured,
                 'median_ms':float(np.median([r['duration_ms'] for r in measured]))}
            runs.append(run);providers[provider]=run
        if provider=='CPU':
            preflight.write_json(output/'detector-cpu.json',runs[0]);validate();return 0
        cpu=json.loads((output/'detector-cpu.json').read_text());runs.insert(0,cpu)
        # A single recorded stationary bus sequence; no game ID/target pose is used.
        track=[];previous=None
        for c in captures:
            if c['stage']!='RANGE10' or not .15<=c['phase_s']<=3.95:continue
            found=detector.predict(image(c),frame_id=c['native_frame']);chosen=center_vehicle(found)
            if chosen is None:continue
            depname='capture-%06d.depth'%c['serial'];body=raw_bytes(source,lock,depname);inputs[depname]=lock['raw_hashes'][depname]
            ego=min(ego_rows,key=lambda r:abs(r['host_ms']-c['native_host_ms']))
            xy=metric_position(c,chosen['xyxy'],np.frombuffer(body,np.float32),ego)
            stamp=c['game_ms']/1000
            if previous is not None and stamp<=previous:raise ValueError('Nonadvancing measured history')
            previous=stamp;track.append({'timestamp_s':stamp,'position_m':xy,'class':chosen['class'],'serial':c['serial']})
        if len(track)<8:raise ValueError('Insufficient measured CV history/future')
        anchor=min(track,key=lambda t:abs(t['timestamp_s']-(track[0]['timestamp_s']+.65)))
        history=[t for t in track if t['timestamp_s']<=anchor['timestamp_s']]
        if len(history)<2 or history[-1]['timestamp_s']-history[0]['timestamp_s']<.5:raise ValueError('Measured history is too short')
        request={'timestamp_s':anchor['timestamp_s'],'seed':20261031,'tracks':[{'id':'rgb-track-0','class':anchor['class'],
          'fixed_position_m':anchor['position_m'],'history':[[t['timestamp_s'],*t['position_m']] for t in history]}]}
        near_ok=all(any(f['stage']==phase and f['center_vehicle'] for f in run['frames']) for run in runs for phase in ('RANGE10','RANGE30'))
        equivalent=True;equivalence=[]
        for a,b in zip(runs[0]['frames'],runs[1]['frames']):
            x,y=a['detections'],b['detections']
            same=len(x)==len(y) and all(i['class']==j['class'] and abs(i['confidence']-j['confidence'])<=.02
                 and max(abs(u-v) for u,v in zip(i['xyxy'],j['xyxy']))<=1 for i,j in zip(x,y))
            equivalence.append({'stage':a['stage'],'equivalent_within_1px_and_0_02_confidence':same});equivalent=equivalent and same
        result={'detector_smoke_passed':bool(near_ok),'runs':runs,'measured_track':track,'forecast_request':request,
                'cpu_dml_equivalent_sample':equivalent,'cpu_dml_equivalence':equivalence,
                'track_geometry_scope':'Stationary, near-center, approximately flat recorded scene; full moving/extrinsic qualification is pending',
                'no_game_actor_truth_in_inference':True,'driving_policy_admitted':False}
        preflight.write_json(output/'detector.json',result)
        preflight.write_json(output/'input-manifest.json',{'source_receipt_sha256':lock['source_receipt_sha256'],'raw_inputs':inputs,
              'model_sha256':lock['model_sha256'],'external_source_hashes':lock['upstream_source_hashes']})
        validate();return 0
    finally:
        if detector is not None:detector.close()


def forecast_worker(output):
    validate();sys.path.insert(0,str(PROJECT))
    from backend.learning.trajectron_adapter import TrajectronAdapter
    detector=json.loads((output/'detector.json').read_text());request=detector['forecast_request']
    adapter=TrajectronAdapter();start=time.perf_counter();prediction=adapter.predict(request);duration=time.perf_counter()-start
    empty=adapter.predict({'timestamp_s':request['timestamp_s'],'tracks':[]})
    if empty['accepted_objects'] or empty['modes']:raise ValueError('Empty perception created forecasts')
    modes=prediction.get('modes',[])
    valid=bool(prediction.get('accepted_objects') and modes and all(len(m['points'])==7 and np.isfinite(m['points']).all() for m in modes))
    scores=[];track=detector['measured_track'];anchor=request['timestamp_s']
    for mode in modes:
        errors=[]
        for point in mode['points'][1:]:
            wanted=anchor+point[0];truth=min(track,key=lambda t:abs(t['timestamp_s']-wanted))
            if abs(truth['timestamp_s']-wanted)<=.15:errors.append(float(np.linalg.norm(np.array(point[1:])-truth['position_m'])))
        scores.append({'mode':mode['mode'],'matched_future_samples':len(errors),'ade_m':float(np.mean(errors)) if errors else None,
                       'fde_m':errors[-1] if len(errors)==6 else None})
    result={'forecast_executed':valid,'duration_ms':duration*1000,'prediction':prediction,'unranked_mode_errors':scores,
            'empty_input_forecasts':0,'scope':'Recorded stationary CV-derived track only; no dynamic accuracy or policy admission',
            'driving_policy_admitted':False}
    preflight.write_json(output/'forecast.json',result);validate();return 0


def controller(output):
    output=scoped_output(output);output.mkdir(parents=True,exist_ok=True)
    ledger_path=HERE/'downloads/native-runtime-ledger.json'
    if not ledger_path.exists():raise ValueError('Original runtime grant missing; no automatic reset')
    budget=boot.RuntimeBudget(ledger_path);item=budget.reserve('vision-replay-'+uuid.uuid4().hex);began=time.monotonic()
    result={'detector_smoke_passed':False,'forecast_executed':False,'driving_policy_admitted':False,'training_started':False,'mode':'recorded-static-replay'}
    before=preflight.protected_inventory()
    try:
        for mode,environment in (('detector-cpu','.venv-perception'),('detector-dml','.venv-perception-dml'),('forecast','.venv-trajectron')):
            remaining=550-(time.monotonic()-began)
            if remaining<=0:raise TimeoutError('Reserved replay window expired')
            with (output/(mode+'.stdout.log')).open('wb') as stdout,(output/(mode+'.stderr.log')).open('wb') as stderr:
                done=subprocess.run([str(PROJECT/environment/'Scripts/python.exe'),'-B',str(HERE/'vision_probe.py'),
                                     '--output',str(output),'--worker',mode],cwd=PROJECT,stdout=stdout,stderr=stderr,timeout=min(240,remaining))
            if done.returncode:raise RuntimeError(mode+' model worker failed; inspect actual stderr')
        detector=json.loads((output/'detector.json').read_text());forecast=json.loads((output/'forecast.json').read_text())
        result.update(detector_smoke_passed=detector['detector_smoke_passed'],forecast_executed=forecast['forecast_executed'],
                      detector_runtimes=[{'requested':r['requested_provider'],'runtime':r['runtime'],'median_ms':r['median_ms']} for r in detector['runs']],
                      forecast_ms=forecast['duration_ms'],forecast_scope=forecast['scope'],cpu_dml_equivalent_sample=detector['cpu_dml_equivalent_sample'])
    except Exception as error:result['error']=str(error)
    finally:
        elapsed=time.monotonic()-began
        try:budget.finish(item,elapsed)
        except Exception as error:result['budget_error']=str(error)
        result.update(wall_seconds=elapsed,budget=budget.state,protected_inputs_unchanged=before==preflight.protected_inventory())
        preflight.write_json(output/'vision-result.json',result)
    print(json.dumps(result,indent=2));return int(not (result['detector_smoke_passed'] and result['forecast_executed'] and result['protected_inputs_unchanged'] and not result.get('budget_error')))


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--output',type=Path,required=True);parser.add_argument('--worker',choices=('detector-cpu','detector-dml','forecast'))
    args=parser.parse_args()
    args.output=scoped_output(args.output)
    if args.worker=='detector-cpu':return detector_worker(args.output,'CPU')
    if args.worker=='detector-dml':return detector_worker(args.output,'DML')
    if args.worker=='forecast':return forecast_worker(args.output)
    return controller(args.output)


if __name__=='__main__':raise SystemExit(main())
