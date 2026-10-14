"""Bounded read-only native footprint audit. Never sends a vehicle command."""
import json
from pathlib import Path
import time
import urllib.request
import numpy as np
from backend.learning.motion_budget import MotionBudget
from backend.core.congestion_recovery import CongestionRecovery
from backend.core.maneuver import ObservedSpace
from backend.core.motion_geometry import VehicleGeometry,footprint_centers
from backend.core.prediction import assess_conflicts

ROOT=Path(__file__).resolve().parents[2]
BASE='http://127.0.0.1:8000/api/simulation/'

def get(path):
    with urllib.request.urlopen(BASE+path,timeout=.8) as r:return json.load(r)

def main():
    budget=MotionBudget();reservation=budget.reserve('validation',24.)
    report={'scope':'LIVE_NATIVE_READ_ONLY_FOOTPRINT_AUDIT','vehicle_commands':0,'rows':[],'rejected_frames':[],
        'ordinary_recovery_enabled':False,'closed_loop_acceptance':False}
    deadline=time.monotonic()+20.
    try:
        while time.monotonic()<deadline:
            try:
                state=get('state');frame=state['vehicle']['frame']
                forecast=get('prediction?frame_id='+str(frame))
                if forecast.get('status')!='RUNNING':
                    report['rejected_frames'].append({'frame':frame,'reason':'No prediction for exact sensor frame'});continue
                p=forecast['prediction'];sensor=state['sensors']['lidar']
                if p['session_id']!=state['sessionId'] or p['evaluation_frame']!=frame or abs(p['timestamp_s']-state['vehicle']['timestamp'])>1e-6 or sensor['frame']!=frame:
                    raise ValueError('Sensor/forecast frame identity mismatch')
                geometry=p.get('vehicle_geometry')
                if not geometry:raise ValueError('Native onboard geometry is unavailable')
                g=VehicleGeometry(**geometry)
                with urllib.request.urlopen(BASE+'sensor.bin?name=lidar&frame_id='+str(frame),timeout=.8) as r:
                    if int(r.headers['X-Sensor-Frame'])!=frame:raise ValueError('LiDAR response frame mismatch')
                    raw=r.read()
                if time.monotonic()-p['published_wall_s']>.25:
                    raise ValueError('Native forecast exceeds wall freshness bound')
                mount=sensor['mountTransform']
                if any(abs(v)>1e-6 for v in mount['rotation_deg'].values()):raise ValueError('LiDAR requires calibrated rotation')
                points=np.frombuffer(raw,dtype='<f4').reshape(-1,4)[:,:3]+np.asarray(mount['position_m'])
                space=ObservedSpace(points,g);planner=CongestionRecovery(g)
                candidates=[]
                for name,steering,reverse in [('forward',0.,False),('reverse',0.,True),('left',-.15,False),('right',.15,False)]:
                    path,_=planner._path(state['vehicle']['speedMagnitudeMps'],steering,reverse)
                    certificate=space.certificate(path)
                    conflicts=assess_conflicts(p['tracks'],p['control_trajectories'],[{'intent':name,'points':footprint_centers(path,g),'half':g.half}])
                    candidates.append({'action':name,'space':certificate,'conflicts':len(conflicts),
                        'verified_clear':certificate['verified'] and not conflicts})
                report['rows'].append({'frame':frame,'timestamp_s':p['timestamp_s'],'mode':state['mode'],
                    'safety':state['safetySystem']['status'],'sensor_errors':state['sensorErrors'],
                    'native_hz':state['performance']['nativeTickRateHz'],'candidates':candidates})
            except (OSError,ValueError,KeyError,TypeError) as error:
                report['rejected_frames'].append({'reason':str(error)})
            time.sleep(.05)
    finally:
        report['charged_seconds']=budget.finish(reservation)
        report['budget']=budget.status()
        report['samples']=len(report['rows'])
        report['verified_candidates']=sum(c['verified_clear'] for row in report['rows'] for c in row['candidates'])
        path=ROOT/'output/congestion-recovery/native-readiness.json';path.parent.mkdir(parents=True,exist_ok=True)
        path.write_text(json.dumps(report,indent=2),encoding='utf8')
    print(json.dumps({k:v for k,v in report.items() if k not in ('rows','rejected_frames')}))

if __name__=='__main__':main()
