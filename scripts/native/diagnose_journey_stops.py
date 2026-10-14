"""Offline stop attribution. Native poses are evaluation data only."""
import argparse
import json
import math
from pathlib import Path


def diagnose(root):
    frames = [json.loads(line) for line in (root/'telemetry/frames.jsonl').open()]
    segments = []
    first = None
    for i, frame in enumerate(frames):
        if frame['vehicle']['speed_mps'] < .2:
            if first is None: first = i
        elif first is not None:
            segments.append((first, i-1)); first = None
    if first is not None: segments.append((first, len(frames)-1))
    segments = [(a,b) for a,b in segments if frames[b]['timestamp_s']-frames[a]['timestamp_s'] >= 1.]
    wanted = {frames[(a+b)//2]['frame_id']: (a,b) for a,b in segments}
    decisions = {}
    for line in (root/'telemetry/safety-v2.jsonl').open():
        row = json.loads(line)
        if row['evaluation_frame'] in wanted: decisions[row['evaluation_frame']] = row
    distance = sum(math.dist(a['vehicle']['transform']['position_m'], b['vehicle']['transform']['position_m']) for a,b in zip(frames,frames[1:]))
    rows = []
    for frame_id,(a,b) in wanted.items():
        frame = frames[(a+b)//2]; vehicle = frame['vehicle']; s = decisions.get(frame_id,{}).get('safety',{})
        prediction = s.get('prediction') or {}; conflict = prediction.get('conflict_point') or {}
        tr = next((t for t in prediction.get('tracks',[]) if t['id']==conflict.get('track_id')),None)
        xy = vehicle['transform']['position_m']; yaw = vehicle['transform']['rotation_rad']['yaw']; co,si = math.cos(yaw),math.sin(yaw)
        nearby = []
        for actor in frame['actors']:
            pos = actor['transform']['position_m']; dx,dy = pos[0]-xy[0],pos[1]-xy[1]
            if 0 < math.hypot(dx,dy) < 18:
                nearby.append(dict(id=actor['actor_id'],type=actor.get('class_name'),local=[round(dx*co+dy*si,2),round(-dx*si+dy*co,2)],velocity=actor.get('linear_velocity_mps'),position=pos))
        rows.append(dict(duration_s=round(frames[b]['timestamp_s']-frames[a]['timestamp_s'],2),start_s=round(frames[a]['timestamp_s']-frames[0]['timestamp_s'],2),frame=frame_id,position=xy,
            risk=s.get('risk'),reason=s.get('reason'),base_brake=s.get('base_driver_brake'),target=s.get('target_speed_mps'),brake=vehicle['brake'],
            measured_range=s.get('measured_range_m'),free_range=s.get('observed_road_range_m'),conflict={k:v for k,v in conflict.items() if k!='trajectory'},
            track={k:v for k,v in (tr or {}).items() if k!='history'},nearby=nearby))
    result = json.loads((root/'comparison-v2-result.json').read_text())
    return dict(recording=str(root),distance_m=distance,start=frames[0]['vehicle']['transform']['position_m'],end=frames[-1]['vehicle']['transform']['position_m'],
        progress=result['outcome']['metrics']['progress_m'],route_completion=result['outcome']['metrics']['route_completion'],segments=rows)


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('recording');p.add_argument('--output',required=True);args=p.parse_args()
    report=diagnose(Path(args.recording));out=Path(args.output);out.parent.mkdir(parents=True,exist_ok=True);out.write_text(json.dumps(report,indent=2))
    print(json.dumps({**{k:v for k,v in report.items() if k!='segments'},'longest_stops':sorted(report['segments'],key=lambda x:x['duration_s'],reverse=True)[:3]}))
