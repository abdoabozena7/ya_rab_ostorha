"""Offline evidence summary, privileged-input invariance and original-model hash."""
from dataclasses import replace
import hashlib
import json
from pathlib import Path
import statistics
import numpy as np
from backend.core.contracts import CommandSource, ControlCommand, to_dict
from backend.core.safety_policy import sensor_observation
from backend.core.replay import ReplayReader
from backend.learned.features import features

ROOT=Path(__file__).resolve().parents[1]
EVIDENCE=ROOT/'docs/evidence/final_delivery'


def main():
    native=json.loads((EVIDENCE/'native.json').read_text());isolated=0;duplicates=0;missing=0;bytes_total=0
    brake_edges={};failure_evidence={}
    for case in native['cases']:
        reader=ReplayReader(case['recording']);frames=list(reader.frames());seen=set()
        for i,frame in enumerate(frames):
            if frame.frame_id in seen:duplicates+=1
            seen.add(frame.frame_id)
            if not frame.complete:missing+=1;continue
            if i%20:continue
            obs=sensor_observation(frame)
            clean=replace(frame,actors=(),ground_truth=None)
            projected=sensor_observation(clean)
            base=ControlCommand(frame.frame_id,frame.timestamp_s,.4,0.,0.,False,False,CommandSource.MANUAL,1)
            previous=[frame.vehicle.steering,frame.vehicle.throttle,frame.vehicle.brake]
            np.testing.assert_array_equal(features(obs,base,previous),features(projected,base,previous));isolated+=1
            text=json.dumps(to_dict(obs))
            for key in ('actors','actor_id','ground_truth','future_trajectory','scenario','reward','teacher_state'):
                assert '"'+key+'"' not in text
        bytes_total+=sum(p.stat().st_size for p in Path(case['recording']).rglob('*') if p.is_file())
        # Applied pedal threshold edges, separately from source arbitration edges.
        pedals=[(f.timestamp_s,f.vehicle.brake>=.5) for f in frames];edges=[]
        for prior,current in zip(pedals,pedals[1:]):
            if prior[1]!=current[1]:edges.append(current)
        brake_edges[case['case']]={'threshold':.5,'edges':len(edges),'pulses_under_150ms':sum(b[0]-a[0]<=.150001 for a,b in zip(edges,edges[1:]))}
        if case['controller'] in ('LEARNED','HYBRID'):
            trace=Path(case['trace_path']) if case.get('trace_path') else ROOT/'output/final-delivery/native'/(case['case']+'.jsonl')
            rows=[json.loads(line) for line in trace.read_text().splitlines()]
            start=min(r['time_s'] for r in rows)
            contradictory=[r for r in rows if r['time_s']-start>7. and r['safety'].get('learned_decision')=='BRAKE_INTERVENTION' and
                           r['safety'].get('risk')=='CLEAR']
            failure_evidence[case['case']]={'post_resumption_brake_predictions_while_rule_risk_clear':len(contradictory),
                'sample':[{k:r[k] for k in ('frame','time_s','speed_mps')}|{'range_m':r['safety'].get('measured_range_m'),
                    'closing_speed_mps':r['safety'].get('closing_speed_mps'),'probabilities':r['safety'].get('learned_probabilities')} for r in contradictory[:3]]}
    sac=ROOT/'runs/experiments/experiment1_20261008T165154Z/final_model.zip'
    original_hash=hashlib.sha256(sac.read_bytes()).hexdigest()
    assert original_hash=='9b3bceb0c77aaea8a6cad71600d36f90b1dfbf2277ffad94ea6b91f42f5ac679'
    assert all(not c['application_mismatches'] and c['actor_cleanup_verified'] for c in native['cases'])
    # Episode/condition IDs match within each automatic group. No frame split.
    assert all(len({c['condition_id'] for c in native['cases'] if c['kind']==kind and c['mode']=='AUTOMATIC'})==1 for kind in ('FRONT_OBSTACLE','SUDDEN_BRAKING'))
    result={'scope':'Initial frozen pilot with HYBRID V1; repaired V2 acceptance is separately recorded in hybrid-v2.json',
        'native_episodes':len(native['cases']),'native_wall_s':native['wall_s'],
        'isolation_samples':isolated,'privileged_input_invariance':True,'duplicate_recorded_frames':duplicates,
        'incomplete_recorded_frames':missing,'recording_bytes':bytes_total,'sac_sha256_unchanged':original_hash,
        'native_command_application_mismatches':0,'actor_cleanup_all_cases':True,'matched_condition_ids':True,
        'applied_brake_edges':brake_edges,'learned_failure_evidence':failure_evidence,
        'acceptance':{'RULE':True,'LEARNED':False,'HYBRID':False},
        'decision':'Retain RULE default; no final TEST tuning or additional neural training.'}
    (EVIDENCE/'audit.json').write_text(json.dumps(result,indent=2));print(json.dumps(result),flush=True)

if __name__=='__main__':main()
