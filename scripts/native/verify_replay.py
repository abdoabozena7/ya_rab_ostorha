"""Verify real recorded frames offline, with an optional native-client rejection guard."""
import argparse
from dataclasses import replace
import json
from pathlib import Path
import socket
from backend.core.replay import ReplayReader
from backend.replay_service import ReplayService
from backend.core.timing import SensorSynchronizer, FrameIssue


def main():
    parser=argparse.ArgumentParser();parser.add_argument('run')
    parser.add_argument('--output',default='output/native-validation/replay.json')
    parser.add_argument('--require-population',action='store_true')
    parser.add_argument('--guard-native-client',action='store_true',
        help='Reject every CARLA Client construction instead of requiring the shared engine to stop')
    args=parser.parse_args()
    with socket.socket() as connection:
        connection.settimeout(1)
        carla_running=connection.connect_ex(('127.0.0.1',2000))==0
        if carla_running and not args.guard_native_client:
            raise RuntimeError('Stop CARLA before the offline real-run replay test')
    client_calls=[]
    if args.guard_native_client:
        import carla
        original_client=carla.Client
        def reject_native_client(*args,**kwargs):
            client_calls.append(True)
            raise AssertionError('Replay attempted to construct a native CARLA client')
        carla.Client=reject_native_client
    reader=ReplayReader(args.run);service=ReplayService(reader)
    frames=[f for f in reader.frames() if f.complete and len(f.sensors)==6]
    first,next_frame=frames[0],frames[1]
    try:
        service.set_paused(True);service.seek(first.timestamp_s)
        state=service.snapshot()
        assert state['mode']=='REPLAY' and not state['connected'] and state['available']
        assert state['vehicle']['frame']==first.frame_id
        if args.require_population:
            assert first.population and first.population.traffic_vehicles > 0 and first.population.pedestrians > 0
            assert state['population']['source']=='RECORDED_FRAME'
            assert state['population']['actual']['vehicles']==first.population.traffic_vehicles
            assert state['population']['actual']['pedestrians']==first.population.pedestrians
            assert first.ground_truth and first.ground_truth.frame_id==first.frame_id
        camera,metadata=service.get_camera_frame(first.frame_id)
        assert camera.startswith(b'\xff\xd8') and metadata['frame']==first.frame_id
        assert abs(metadata['timestamp']-first.timestamp_s)<1e-6
        try:service.require_connected()
        except RuntimeError:pass
        else:raise AssertionError('Replay accepted a native control connection')
        service.seek(next_frame.timestamp_s)
        camera2,metadata2=service.get_camera_frame(next_frame.frame_id)
        assert metadata2['frame']!=metadata['frame'] and camera2.startswith(b'\xff\xd8')
        # Exercise actual recorded native packets under delayed/reordered delivery.
        required=[s.sensor_id for s in first.sensors]
        sync=SensorSynchronizer(required);sync.begin(first);assert sync.drain()[0].complete
        duplicate=sync.receive(first.sensors[0]);assert FrameIssue.DUPLICATE in duplicate.issues and FrameIssue.LATE in duplicate.issues
        ordered=SensorSynchronizer(required)
        ordered.begin(replace(first,sensors=()))
        ordered.receive(next_frame.sensors[0]);out_of_order=ordered.receive(first.sensors[0])
        assert FrameIssue.OUT_OF_ORDER in out_of_order.issues
        for s in first.sensors[1:]:ordered.receive(s)
        delivered=ordered.drain();assert delivered[0].frame_id==first.frame_id and delivered[0].complete
        missing=SensorSynchronizer(required);missing.begin(replace(first,sensors=tuple(s for s in first.sensors if s.sensor_id!='depth')))
        incomplete=missing.drain(force=True)[0];assert incomplete.missing_required_sensors==('depth',)
        assert not client_calls
        result={'status':'PASS','carla_running':carla_running,
            'native_client_guard':args.guard_native_client,'native_client_constructions':len(client_calls),
            'recording':str(reader.root),'mode':'REPLAY','connected':False,
            'telemetry_frame':first.frame_id,'replayed_camera_frames':[metadata['frame'],metadata2['frame']],
            'native_controls_disabled':True,'recorded_provenance':reader.metadata.data_origin.value,
            'real_packet_synchronizer_checks':{'duplicate':sorted(x.value for x in duplicate.issues),
                'out_of_order':sorted(x.value for x in out_of_order.issues),'missing':list(incomplete.missing_required_sensors)},
            'frames':len(reader.index),'duration_sim_s':reader.index[-1][0]-reader.index[0][0],
            'recorded_population':state.get('population')}
        Path(args.output).write_text(json.dumps(result,indent=2),encoding='utf8');print(json.dumps(result,indent=2))
    finally:
        service.close()
        if args.guard_native_client:
            carla.Client=original_client


if __name__=='__main__':main()
