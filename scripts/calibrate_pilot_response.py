"""Summarize actual native ego movement and braking; refuse unsupported calibration."""
import argparse
import json
from pathlib import Path
import math
import numpy as np


def main():
    parser=argparse.ArgumentParser();parser.add_argument('episodes',type=Path);parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args();steering=[];braking=[];sources=[]
    for path in args.episodes.rglob('transitions.jsonl'):
        manifest=json.loads((path.parent/'manifest.json').read_text())
        if manifest.get('initialization_version')!=2:continue
        rows=[json.loads(line) for line in path.read_text().splitlines()];sources.append(str(path))
        for previous,current in zip(rows,rows[1:]):
            a=previous['ego'];b=current['ego'];dt=current['timestamp_s']-previous['timestamp_s']
            ds=math.dist(a['transform']['position_m'][:2],b['transform']['position_m'][:2])
            if dt<=0:continue
            delta=(b['transform']['rotation_rad']['yaw']-a['transform']['rotation_rad']['yaw']+math.pi)%(2*math.pi)-math.pi
            if ds>.02 and b['speed_mps']>.5 and abs(b['steering'])>.1:
                steering.append({'normalized_steering':b['steering'],'curvature_per_m':delta/ds,
                                 'speed_mps':b['speed_mps'],'reverse':b['reverse']})
            deceleration=(a['speed_mps']-b['speed_mps'])/dt
            if b['brake']>=.99 and a['speed_mps']>1. and deceleration>0:
                braking.append(deceleration)
    report={'source':'ACTUAL_NATIVE_EGO_MOTION','sources':sources,'steering_samples':len(steering),
            'steering_observations':steering,'emergency_braking_samples':len(braking),
            'braking_deceleration_p10_mps2':float(np.quantile(braking,.1)) if braking else None,
            'calibration_accepted':False,'reason':'Dedicated forward/reverse, speed and simultaneous-steering calibration remains required'}
    args.output.write_text(json.dumps(report,indent=2),encoding='utf8');print(json.dumps({k:v for k,v in report.items() if k not in ('steering_observations','sources')}))


if __name__=='__main__':main()
