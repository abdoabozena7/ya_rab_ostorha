"""Prepare ordered, real TRAIN/VALIDATION sequences; no TEST or sensor binaries."""
import hashlib
import json
from pathlib import Path
import numpy as np
from backend.core.contracts import from_dict, ControlCommand, SimulationFrame
from backend.core.safety_policy import SensorObservation, sensor_observation
from backend.rl.demonstrations import load_episode
from backend.learned.features import features, VERSION, DECISIONS

ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'output/learned-data'


def main():
    OUT.mkdir(parents=True,exist_ok=True); arrays={}; manifest={'feature_version':VERSION,'episodes':[]}
    train=ROOT/'runs/demonstrations/experiment3a_20261009T031432Z'
    for path in sorted(train.glob('TRAIN_*/transitions.jsonl')):
        verified=list(load_episode(path))
        rows=[json.loads(line) for line in path.read_text().splitlines()]
        xx=[]; yy=[]
        for row in rows:
            obs=from_dict(SensorObservation,row['sensor_provenance']['sensor_only_observation'])
            base=from_dict(ControlCommand,row['validated_actions']['base_proposed_control'])
            previous=row['sensor_provenance']['lightweight_history']['previous_action'][-1]
            xx.append(features(obs,base,previous)); yy.append(DECISIONS.index(row['teacher_targets']['decision']))
        assert len(verified)==len(rows)
        key=path.parent.name
        arrays[key+'_x']=np.asarray(xx,np.float32);arrays[key+'_y']=np.asarray(yy,np.int64)
        manifest['episodes'].append({'id':key,'split':'TRAIN','transitions':len(xx),'source':str(path.relative_to(ROOT)),
            'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'counts':np.bincount(yy,minlength=3).tolist()})
    evidence=json.loads((ROOT/'docs/evidence/experiment2c/native.json').read_text())
    for ep in evidence['episodes']:
        assert ep['split']=='VALIDATION'
        key='VALIDATION_'+str(ep['seed'])
        path=Path(evidence['run'])/(key+'-steps.jsonl')
        rows=[json.loads(line) for line in path.read_text().splitlines()]
        wanted={r['source_frame'] for r in rows}; frames={}
        with (Path(ep['initial']['recording_path'])/'telemetry/frames.jsonl').open() as stream:
            for line in stream:
                data=json.loads(line)
                if data['frame_id'] in wanted: frames[data['frame_id']]=data
        xx=[];yy=[]
        for row in rows:
            obs=sensor_observation(from_dict(SimulationFrame,frames[row['source_frame']]))
            base=from_dict(ControlCommand,row['base_proposed_control'])
            previous=row['policy_inputs_47'][36:39]
            xx.append(features(obs,base,previous));yy.append(DECISIONS.index(row['teacher']['decision']))
        arrays[key+'_x']=np.asarray(xx,np.float32);arrays[key+'_y']=np.asarray(yy,np.int64)
        manifest['episodes'].append({'id':key,'split':'VALIDATION','transitions':len(xx),'source':str(path),
            'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'counts':np.bincount(yy,minlength=3).tolist()})
    np.savez_compressed(OUT/'sequences.npz',**arrays)
    (OUT/'manifest.json').write_text(json.dumps(manifest,indent=2))
    print(json.dumps({'episodes':len(manifest['episodes']),'splits':{s:sum(e['transitions'] for e in manifest['episodes'] if e['split']==s) for s in ('TRAIN','VALIDATION')}}))

if __name__=='__main__': main()
