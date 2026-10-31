"""Concurrent actual DML on live native frames; no actor truth or policy control."""
import argparse
import json
import sys
import time
from pathlib import Path
import numpy as np
import chaos_probe as scene
import vision_probe as replay
import preflight


def run(output):
    output=scene.output_path(output);lock,_=replay.validate();sys.path.insert(0,str(preflight.PROJECT))
    from backend.computer_vision.detector import RoadDetector
    deadline=time.monotonic()+480
    while time.monotonic()<deadline and not (output/'stop-live-vision').exists():
        capture=scene.latest(output/'capture.jsonl')
        if capture and capture.get('rgb_ok'):break
        time.sleep(.05)
    else:
        preflight.write_json(output/'live-vision-result.json',{'processed_frames':0,'reason':'No world capture; GPU model was not initialized',
                             'training_started':False,'driving_policy_admitted':False});return
    detector=RoadDetector(preflight.PROJECT/lock['model_path'],execution_provider='DML')
    if detector.runtime['execution_provider']!='DmlExecutionProvider':raise ValueError('Live DML unexpectedly fell back to CPU')
    serial=0;count=0
    try:
        with (output/'live-vision.jsonl').open('w',encoding='utf8') as stream:
            while time.monotonic()<deadline and not (output/'stop-live-vision').exists():
                c=scene.latest(output/'capture.jsonl')
                if not c or c['serial']<=serial or not c['rgb_ok']:time.sleep(.01);continue
                serial=c['serial'];path=output/('capture-%06d.rgb'%serial)
                rgb=np.fromfile(path,np.uint8).reshape(360,640,3)
                start=time.perf_counter();detections=detector.predict(rgb,frame_id=c['native_frame']);elapsed=(time.perf_counter()-start)*1000
                result={'serial':serial,'native_frame':c['native_frame'],'stage':c['stage'],'game_ms':c['game_ms'],
                        'capture_start_ms':c['capture_start_ms'],'capture_end_ms':c['capture_end_ms'],
                        'execution_provider':detector.runtime['execution_provider'],'inference_ms':elapsed,
                        'snapshot_age_ms':scene.TICK()-c['native_host_ms'],'detections':detections}
                stream.write(json.dumps(result,allow_nan=False)+'\n');stream.flush();count+=1
    finally:
        detector.close();preflight.write_json(output/'live-vision-result.json',{'runtime':detector.runtime,'processed_frames':count,
              'profile':detector.profile,'training_started':False,'driving_policy_admitted':False})


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--output',type=Path,required=True);run(parser.parse_args().output)
