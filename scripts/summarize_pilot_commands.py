"""Compact, source-bound native command evidence for a completed episode."""
import argparse
from collections import Counter
import hashlib
import json
import math
from pathlib import Path
from backend.core.maneuver_candidates import CANDIDATE_IDS


def summarize(episode,output):
    manifest=json.loads((episode/'manifest.json').read_text(encoding='utf8'))
    outcome=json.loads((episode/'outcome.json').read_text(encoding='utf8'))
    position=manifest['ego_initial']['position'][:2]
    yaw=math.radians(manifest['ego_initial']['yaw_deg'])
    counts=Counter();rejections=Counter();controls=Counter();available=Counter();digest=hashlib.sha256()
    planar=0.;signed_reverse=0.;ages=[];steps=0;masked=0
    output.parent.mkdir(parents=True,exist_ok=True)
    compact=output.with_suffix('.commands.jsonl')
    with (episode/'transitions.jsonl').open('rb') as source,compact.open('w',encoding='utf8') as destination:
        for raw in source:
            digest.update(raw);row=json.loads(raw);steps+=1
            counts[row['candidate_id']]+=1;masked+=int(row['masked'])
            for index,admitted in enumerate(row['candidate_masks']):
                if admitted:available[CANDIDATE_IDS[index]]+=1
            if row.get('shield_rejection'):rejections[row['shield_rejection']]+=1
            ego=row['ego'];current=ego['transform']['position_m'][:2]
            dx,dy=current[0]-position[0],current[1]-position[1]
            planar+=math.hypot(dx,dy)
            signed_reverse+=max(0.,-(dx*math.cos(yaw)+dy*math.sin(yaw)))
            position=current;yaw=ego['transform']['rotation_rad']['yaw']
            if row.get('scene_age_at_action_s') is not None:ages.append(row['scene_age_at_action_s'])
            applied=[]
            for value in row['applied']:
                native=value['native'];controls['total']+=1
                if native['brake']>=.99:controls['full_brake']+=1
                if native['throttle']>0. and native['brake']<=.01:
                    controls['reverse_throttle' if native['reverse'] else 'forward_throttle']+=1
                applied.append({'frame_id':value['frame_id'],'requested':value['command'],'native':native})
            prediction=row.get('applied_decision_prediction') or {}
            destination.write(json.dumps({'step':row['step'],'frame':row['frame'],'timestamp_s':row['timestamp_s'],
                'candidate_id':row['candidate_id'],'masked':row['masked'],'shield_rejection':row.get('shield_rejection'),
                'fallback':row.get('fallback'),'bundle_hash':row['bundle_hash'],
                'scene_age_at_action_s':row.get('scene_age_at_action_s'),
                'applied_prediction_source_frame':prediction.get('prediction_source_frame'),
                'applied':applied,'ego_position_m':ego['transform']['position_m'],
                'longitudinal_speed_mps':ego.get('longitudinal_speed_mps'),'outcome':row.get('outcome')},allow_nan=False)+'\n')
    ages.sort()
    report={'episode':str(episode),'policy_id':manifest['policy_id'],'condition_hash':manifest['condition_hash'],
        'outcome':outcome['outcome'],'source_sha256':digest.hexdigest(),'decisions':steps,
        'candidate_choices':dict(counts),'admitted_candidate_counts':dict(available),
        'masked_choices':masked,'shield_rejections':dict(rejections),
        'native_commands':dict(controls),'native_planar_distance_m':planar,
        'reverse_projection_m':signed_reverse,'reverse_projection_definition':'Sum of negative native planar displacement projected on preceding native ego heading; diagnostic only',
        'action_scene_wall_age_s':{'measured_decisions':len(ages),'maximum':max(ages) if ages else None,
            'p99':ages[min(len(ages)-1,math.ceil(.99*len(ages))-1)] if ages else None,
            'above_250_ms':sum(v>.25 for v in ages)},
        'compact_commands':str(compact),'compact_commands_sha256':hashlib.sha256(compact.read_bytes()).hexdigest(),
        'accepted':False,'reason':'Command and movement evidence does not replace complete behavioral admission'}
    output.write_text(json.dumps(report,indent=2,allow_nan=False),encoding='utf8')
    return report


def main():
    parser=argparse.ArgumentParser();parser.add_argument('episode',type=Path);parser.add_argument('output',type=Path)
    args=parser.parse_args();print(json.dumps(summarize(args.episode,args.output),indent=2))


if __name__=='__main__':main()
