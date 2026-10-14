"""All-actor independent future-label scoring; no policy-generated avoidability."""
import argparse
import hashlib
import json
from pathlib import Path
import math
import sys
import numpy as np


def evaluate(path):
    rows=[json.loads(line) for line in path.read_text().splitlines()]
    totals={h:{'relevant_actors':0,'associated':0,'scored':0,'missing_future':0,'ambiguous':0,'ade':[],'fde':[]} for h in (1,2,3)}
    histories={}
    for row in rows:
        for actor in row['independent_actor_labels']:
            histories.setdefault(actor['id'],[]).append((row['timestamp_s'],*actor['position'][:2]))
    for row in rows[::5]:
        ego=row['ego']['transform'];origin=np.array(ego['position_m'][:2]);yaw=ego['rotation_rad']['yaw']
        rotation=np.array([[math.cos(yaw),-math.sin(yaw)],[math.sin(yaw),math.cos(yaw)]])
        prediction=row['prediction'];stamp=row['timestamp_s']
        used=set()
        for actor in row['independent_actor_labels']:
            position=np.array(actor['position'][:2]);local=rotation.T@(position-origin)
            if np.linalg.norm(local)>50:continue
            choices=[t for t in prediction['tracks'] if t['id'] not in used and t['confirmed'] and
                     np.linalg.norm(np.array(t['position_m'])-local)<2.5]
            track=min(choices,key=lambda t:np.linalg.norm(np.array(t['position_m'])-local)) if choices else None
            if track:used.add(track['id'])
            for h,stats in totals.items():
                stats['relevant_actors']+=1
                if len(choices)>1:stats['ambiguous']+=1;continue
                if track is None:continue
                stats['associated']+=1
                history=np.array(histories.get(actor['id'],[]))
                if len(history)<2 or history[-1,0]<stamp+h:
                    stats['missing_future']+=1;continue
                modes=[m for m in prediction['control_trajectories'] if m['track_id']==track['id'] and m.get('selected',m.get('mode')==0)]
                if not modes:continue
                mode=modes[0];points=np.asarray(mode['points']);times=np.arange(.1,h+.001,.1)
                predicted=np.column_stack([np.interp(times,points[:,0],points[:,i]) for i in (1,2)])@rotation.T+origin
                truth=np.column_stack([np.interp(stamp+times,history[:,0],history[:,i]) for i in (1,2)])
                errors=np.linalg.norm(predicted-truth,axis=1)
                stats['ade'].append(float(errors.mean()));stats['fde'].append(float(errors[-1]));stats['scored']+=1
    result={}
    for h,stats in totals.items():
        ade=stats.pop('ade');fde=stats.pop('fde')
        result[h]={**stats,'ade_m':float(np.mean(ade)) if ade else None,'fde_m':float(np.mean(fde)) if fde else None,
                   'coverage':stats['scored']/stats['relevant_actors'] if stats['relevant_actors'] else None}
    return {'source':str(path),'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),
            'labels':'INDEPENDENT_FUTURE_NATIVE_ACTOR_POSITIONS','horizons':result,
            'accepted':False,'reason':'Matched baseline/ablation hazard and driving gates also required'}


def main():
    parser=argparse.ArgumentParser();parser.add_argument('transitions',type=Path);parser.add_argument('--output',type=Path)
    args=parser.parse_args();report=evaluate(args.transitions)
    if args.output:args.output.write_text(json.dumps(report,indent=2),encoding='utf8')
    print(json.dumps(report,indent=2));return 0


if __name__=='__main__':sys.exit(main())
