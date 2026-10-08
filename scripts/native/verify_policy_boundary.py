"""Check the future policy boundary using actual synchronized native packets."""
import json
from pathlib import Path
import urllib.request
from backend.core.contracts import SimulationFrame, from_dict, to_dict
from backend.core.safety_policy import sensor_observation, ObservationHistory
from .verify_urban_world import Session


def main():
    proof={'source':'LIVE_NATIVE','checks':{},'frames':[]}
    history=ObservationHistory()
    with Session() as session:
        for _ in range(5):
            previous=session.state['vehicle']['frame']
            session.wait(lambda s:s['vehicle']['frame']>previous and s['frameComplete'])
            frame=from_dict(SimulationFrame,session.state['canonical'])
            observation=history.append(frame)
            encoded=json.dumps(to_dict(observation))
            for key in ('ground_truth','actor_id','actors','transform','population','predictions','future_trajectory'):
                assert '"'+key+'"' not in encoded,key
            assert all(s.frame_id==observation.frame_id for s in observation.channels)
            for channel in observation.channels:
                if channel.asset:
                    url=f'http://127.0.0.1:8000/api/simulation/sensor.bin?name={channel.sensor_id}&frame_id={channel.frame_id}'
                    with urllib.request.urlopen(url,timeout=10) as response:
                        data=response.read()
                        assert data and int(response.headers['X-Sensor-Frame'])==frame.frame_id
            proof['frames'].append({'frame_id':frame.frame_id,'timestamp_s':frame.timestamp_s,
                'channel_kinds':[s.kind.value for s in observation.channels],
                'angular_velocity_frame':observation.ego.angular_velocity_frame})
        assert len(history.snapshot())==4
        assert session.state['environment']['observation_status']['history_frames']==4
        assert not session.state['environment']['safety_policy']['active']
        proof['checks'].update(real_synchronized_packets=True,sensor_assets_resolved=True,
            privileged_world_data_excluded=True,history_bounded=True,no_running_policy=True)
        proof['latency']=session.state['performance']['observationPipelineLatencyMs']
        proof['pass']=True
    Path('output/native-validation/gate5-policy-boundary.json').write_text(json.dumps(proof,indent=2),encoding='utf8')
    print(json.dumps(proof))


if __name__=='__main__':main()
