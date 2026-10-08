"""YA RAB OSTORHA experiment-only recording/contract helpers. No CARLA client."""
import json
from pathlib import Path
from backend.core.contracts import SimulationFrame,ControlCommand,CommandSource,from_dict,to_dict
from backend.core.safety_policy import sensor_observation

ROOT=Path(__file__).resolve().parents[2]


def write(path,value):
    path.parent.mkdir(parents=True,exist_ok=True)
    path.write_text(json.dumps(to_dict(value),indent=2,allow_nan=False)+'\n',encoding='utf8')


def rows(path):
    with path.open(encoding='utf8') as stream:return [json.loads(line) for line in stream if line.strip()]


def read_frame(stream,info):
    # Recorder flushes the exact synchronized frame before answering step/reset.
    line=stream.readline()
    if not line:raise RuntimeError('Current sensor frame was not durably recorded')
    frame=from_dict(SimulationFrame,json.loads(line))
    if not frame.complete or frame.frame_id!=info['frame_id'] or frame.timestamp_s!=info['timestamp_s']:
        raise RuntimeError('Recorded observation is incomplete, stale or mismatched')
    if len({s.sensor_id for s in frame.sensors})!=len(frame.sensors) or any(
            s.frame_id!=frame.frame_id or abs(s.sensor_timestamp_s-frame.timestamp_s)>1e-6 for s in frame.sensors):
        raise RuntimeError('Duplicate or unsynchronized sensor channels')
    return frame,sensor_observation(frame)


def base_command(observation,action):
    return ControlCommand(observation.frame_id,observation.timestamp_s,float(action[1]),float(action[2]),
        float(action[0]),False,False,CommandSource.TRAINING,1)
