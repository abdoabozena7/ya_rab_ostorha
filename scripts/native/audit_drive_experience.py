"""Audit native evidence from the driving evaluation without controlling CARLA."""
import argparse
import hashlib
import json
import math
from pathlib import Path


def audit(row, folder):
    root=Path(row['recording']);metadata=json.loads((root/'metadata.json').read_text(encoding='utf8'))
    count=0;previous=None;missing=0;assets=0;collisions={};sampled_assets=[]
    actor_distance={};positions={};moving_walkers=set();moving_vehicles=set()
    with (root/'telemetry/frames.jsonl').open(encoding='utf8') as file:
        for line in file:
            frame=json.loads(line);count+=1
            if previous and (frame['frame_id']<=previous['frame_id'] or frame['timestamp_s']<=previous['timestamp_s']):
                raise ValueError('Nonmonotonic native recording')
            missing+=bool(frame['missing_required_sensors']);previous=frame
            for sensor in frame['sensors']:
                asset=sensor['asset']
                if asset:
                    assets+=1
                    if count in (1,401,801):
                        path=root/asset['path'];data=path.read_bytes()
                        assert len(data)==asset['byte_count'] and hashlib.sha256(data).hexdigest()==asset['sha256']
                        sampled_assets.append(asset['path'])
            for actor in frame['actors']:
                actor_id=actor['actor_id'];position=actor['transform']['position_m']
                if actor_id in positions:actor_distance[actor_id]=actor_distance.get(actor_id,0)+math.dist(position,positions[actor_id])
                positions[actor_id]=position
                if actor_distance.get(actor_id,0)>2:
                    (moving_walkers if actor['class_name']=='PEDESTRIAN' else moving_vehicles).add(actor_id)
            for collision in frame['collisions']:
                collisions[(collision['frame_id'],collision['other_actor_id'])]=collision
    with (root/'events/events.jsonl').open(encoding='utf8') as file:
        for line in file:
            event=json.loads(line)
            if event['event_type']=='CollisionDetected':
                collision=event['payload']['collision']
                collisions[(collision['frame_id'],collision['other_actor_id'])]=collision
    contacts=sorted(collisions.values(),key=lambda c:c['timestamp_s'])
    episodes=0;last_contact={};episode_starts=[]
    for contact in contacts:
        actor=contact['other_actor_id']
        if contact['timestamp_s']-last_contact.get(actor,-float('inf'))>1:
            episodes+=1;episode_starts.append(contact)
        last_contact[actor]=contact['timestamp_s']
    tracepath=root/'telemetry/comparison-controls.jsonl'
    mismatches=[];safety_frames=0;contact_context=[]
    if tracepath.exists():
        starts={c['frame_id']:c for c in episode_starts}
        with tracepath.open(encoding='utf8') as file:
            for line in file:
                trace=json.loads(line);command=trace['applied_command']
                if command and command['source']=='SAFETY':
                    safety_frames+=1
                    if any(abs(command[k]-trace['actual_vehicle_controls'][k])>1e-5 for k in ('throttle','brake','steering')):
                        mismatches.append(trace['frame_id'])
                if trace['frame_id'] in starts:
                    contact_context.append({'collision':starts[trace['frame_id']],
                                            'safety':trace['safety'],'controls':trace['actual_vehicle_controls'],
                                            'hazards':trace['hazard_actors'],'frame_complete':trace['complete']})
    result={'data_origin':metadata['data_origin'],'native_version':metadata['config']['native_version'],
            'api_version':metadata['config']['python_api_version'],'launch':metadata['config']['launch'],
            'camera':metadata['config']['camera'],'frames':count,'required_sensor_incomplete_frames':missing,
            'sensor_assets':assets,'sampled_assets_checksum_verified':sampled_assets,
            'collision_event_callbacks':len(contacts),'collision_episodes':episodes,
            'unique_collision_other_actors':len({c['other_actor_id'] for c in contacts}),
            'episode_starts':episode_starts,'contact_context':contact_context,
            'safety_command_frames':safety_frames if tracepath.exists() else None,
            'safety_command_application_mismatch_frames':mismatches if tracepath.exists() else None,
            'notes':'Collision episodes use the existing >1s per-actor contact gap definition. Frame monotonicity and required channels audited on every frame; checksums sampled at 3 frames per run.'}
    (folder/(row['kind'].lower()+'-'+str(row['seed'])+'-audit.json')).write_text(json.dumps(result,indent=2),encoding='utf8')
    return result


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output',default='output/native-validation/drive-experience-20261009')
    args=parser.parse_args();folder=Path(args.output);audits=[]
    for pattern in ('urban-*-summary.json','journey-*-summary.json'):
        for path in sorted(folder.glob(pattern)):
            row=json.loads(path.read_text(encoding='utf8'))
            if not row.get('recording'):continue
            existing=folder/(row['kind'].lower()+'-'+str(row['seed'])+'-audit.json')
            result=json.loads(existing.read_text(encoding='utf8')) if existing.exists() else audit(row,folder)
            audits.append({'seed':row['seed'],'audit':result})
            print(json.dumps({'audited_seed':row['seed'],'frames':result['frames'],'collision_episodes':result['collision_episodes'],
                              'required_sensor_incomplete':result['required_sensor_incomplete_frames'],
                              'application_mismatches':result['safety_command_application_mismatch_frames']}),flush=True)
    (folder/'native-recording-audits.json').write_text(json.dumps(audits,indent=2),encoding='utf8')


if __name__=='__main__':main()
