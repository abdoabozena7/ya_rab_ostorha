"""Offline sensor-only replay of an existing collision; never connects/ticks."""
import argparse
from dataclasses import replace
import json
from pathlib import Path
from backend.core.active_safety import ActiveSafetySupervisor
from backend.core.contracts import CommandSource,SimulationFrame,from_dict
from backend.core.safety_policy import sensor_observation


def audit(root, first=77400, last=77714):
    root=Path(root).resolve();supervisor=ActiveSafetySupervisor();rows=[]
    for line in (root/'telemetry/frames.jsonl').open(encoding='utf8'):
        data=json.loads(line);frame_id=data['frame_id']
        if frame_id<first or frame_id>last:continue
        frame=from_dict(SimulationFrame,data)
        observation=sensor_observation(frame)
        command=replace(frame.control,source=CommandSource.NAVIGATION,handbrake=False,reverse=False,gear=1,
                        frame_id=frame_id,timestamp_s=frame.timestamp_s)
        supervisor.evaluate(observation,command,lambda a:(root/a.path).read_bytes(),
                            as_of_timestamp_s=observation.timestamp_s)
        s=supervisor.snapshot()
        rows.append({'frame':frame_id,'timestamp_s':frame.timestamp_s,'speed_mps':frame.vehicle.speed_mps,
                     'risk':s['risk'],'conflict':s['path_conflict'],'brake':s['proposed_safety_brake']})
    return {'source':'EXISTING_NATIVE_SENSOR_REPLAY; counterfactual decision, not a new collision outcome',
            'recording':str(root),'first_collision_frame':77714,'rows':rows,
            'first_conflict':next((r for r in rows if r['conflict']),None)}


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('recording');p.add_argument('--output',required=True)
    args=p.parse_args();result=audit(args.recording);target=Path(args.output);target.parent.mkdir(parents=True,exist_ok=True)
    target.write_text(json.dumps(result,indent=2),encoding='utf8');print(json.dumps(result['first_conflict']))
