"""Native keyboard diagnostics are excluded from user demonstration learning."""
import argparse
import hashlib
import json
from pathlib import Path
import sys
import time
import unittest
import urllib.request
import urllib.error
import numpy as np
sys.path.insert(0,str(Path(__file__).resolve().parents[2]))
from backend.gta.provider import latest_json, TICK
from goal_acceptance import rows, finalize as goal_finalize


def live(output,url):
    first=None;observed={};deadline=time.monotonic()+430
    while time.monotonic()<deadline:
        try:
            with urllib.request.urlopen(url+'/api/gta/state',timeout=3) as f:state=json.load(f)
            if not state['connected']:
                time.sleep(.2);continue
            if first is None:first=time.monotonic()
            inputs=latest_json(output/'driving-input.jsonl')
            if inputs and inputs['human'] and time.monotonic()-first>=15:
                if 'owner_loss_ms' not in observed:
                    observed['owner_loss_ms']=TICK();(output/'drop-goal-commands').touch();time.sleep(2)
                    (output/'drop-goal-commands').unlink();observed['owner_restored_ms']=TICK()
                elif 'capture_loss_ms' not in observed and time.monotonic()-first>=25:
                    observed['capture_loss_ms']=TICK();(output/'drop-capture').touch();time.sleep(2)
                    try:urllib.request.urlopen(url+f"/api/gta/image?serial={state['image']['serial']}&kind=rgb",timeout=3)
                    except urllib.error.HTTPError as e:observed['stale_image_rejected']=e.code==503
                    (output/'drop-capture').unlink();observed['capture_restored_ms']=TICK()
            (output/'goal-http-observed.json').write_text(json.dumps(observed,indent=2))
            time.sleep(.2)
        except (OSError,ValueError,KeyError):time.sleep(.2)
    (output/'goal-http-observed.json').write_text(json.dumps(observed,indent=2))


def finalize(output):
    result=goal_finalize(output)
    inputs=rows(output/'driving-input.jsonl');native=rows(output/'bridge.jsonl');applied=rows(output/'applied-controls.jsonl')
    modes=[]
    for r in inputs:
        if not modes or modes[-1]!=r['human']:modes.append(r['human'])
    human=[r for r in applied if r.get('human') and r['throttle']>.01 and r['brake']==0]
    human_positions=[]
    for r in human:
        n=min(native,key=lambda n:abs(n['host_ms']-r['host_ms'])) if native else None
        if n and abs(n['host_ms']-r['host_ms'])<150:human_positions.append(n['position'])
    displacement=max((float(np.linalg.norm(np.asarray(p)-human_positions[0])) for p in human_positions),default=0.)
    files=list((output/'human-demonstrations').glob('*.npz'))
    valid=0;diagnostic_excluded=True;errors=[]
    for file in files:
        try:
            with np.load(file,allow_pickle=False) as data:
                row=json.loads(data['metadata'].tobytes());rgb=data['rgb'];depth=data['depth_m'];rays=data['rays']
                good=rgb.shape==(360,640,3) and depth.shape==(360,640) and rays.shape==(1080,8)
                good=good and hashlib.sha256(rgb.tobytes()).hexdigest()==row['rgb_sha256'] and row['native_acknowledged']
                if good:valid+=1
                if row['diagnostic'] and row['eligible_for_imitation']:diagnostic_excluded=False
        except Exception as e:errors.append(str(e))
    result.update(native_toggle_observed=modes[:3]==[False,True,False],guarded_human_motion=displacement>=1. and len(human)>=5,
                  human_motion_m=displacement,source_aligned_dataset=valid>=5 and not errors,
                  imitation_boundary_verified=bool(valid>=5 and diagnostic_excluded),
                  fault_stop_observed=result['fault_stops_observed'],decoded_demonstrations=valid,
                  demonstration_errors=errors,observed_modes=modes,learning='QUALIFIED_EXAMPLE_MEMORY;NO_PPO_UPDATES',
                  diagnostic_training_excluded=diagnostic_excluded)
    (output/'demo-measurements.json').write_text(json.dumps(result,indent=2))
    return result


def main():
    p=argparse.ArgumentParser();p.add_argument('--output',type=Path,required=True);p.add_argument('--url');p.add_argument('--offline',action='store_true');a=p.parse_args()
    if a.offline:
        loader=unittest.TestLoader();suite=unittest.TestSuite(loader.discover(str(Path(__file__).parent),pattern=pattern)
            for pattern in ('test_goal_driver.py','test_demonstrations.py','test_live_provider.py'))
        result=unittest.TextTestRunner(verbosity=2).run(suite)
        (a.output/'boundary.json').write_text(json.dumps({'negative_controls_passed':result.wasSuccessful(),'tests':result.testsRun}))
        return int(not result.wasSuccessful())
    live(a.output,a.url);return 0

if __name__=='__main__':raise SystemExit(main())
