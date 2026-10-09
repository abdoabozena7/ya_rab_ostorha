"""Read-only camera, native launch and actor audit after a dashboard preset click."""
import argparse,json,time,urllib.request
from pathlib import Path
from backend.graphics import PRESETS
ROOT=Path(__file__).resolve().parents[2]
def read(path):
    return json.load(urllib.request.urlopen('http://127.0.0.1:8000/api/simulation/'+path,timeout=5))
def main():
    parser=argparse.ArgumentParser();parser.add_argument('--preset',choices=list(PRESETS),required=True);parser.add_argument('--initial',action='store_true');args=parser.parse_args()
    deadline=time.monotonic()+240
    while time.monotonic()<deadline:
        try:
            s=read('state');status=s.get('restartResult') or {}
            requested=status.get('requested') or {};expected=PRESETS[args.preset]
            terminal=status.get('status') in ('APPLIED','ROLLED_BACK','FAILED') and requested.get('quality')==expected['quality'] and requested.get('resolution')==expected['resolution']
            if s['connected'] and (args.initial or terminal):break
        except OSError:pass
        time.sleep(.5)
    else:raise TimeoutError('Native preset verification did not finish')
    catalog=read('catalog')['settings'];rgb=s['sensorRegistry']['frontCamera']['latestValidData']['metadata'];depth=s['sensorRegistry']['depth']['latestValidData']['metadata']
    import carla
    c=carla.Client('127.0.0.1',2000);c.set_timeout(15);w=c.get_world();w.wait_for_tick(10);actors=w.get_actors()
    native_sensors={a.type_id:a.attributes for a in actors.filter('sensor.*')}
    p=PRESETS[args.preset];applied=catalog['active_launch']
    matches=(applied['quality']==p['quality'] and applied['resolution']==p['resolution'] and catalog['camera_resolution']==p['rgb'] and catalog['camera_postprocess']==p['postprocess'] and abs(catalog['camera_bloom']-p['bloom'])<.001)
    report={'source':'REAL_DASHBOARD_PRESET_AND_NATIVE_SENSOR_ATTRIBUTES','preset':args.preset,'status':status or {'status':'INITIAL'},'matched_requested_preset':matches,'active_launch':applied,'camera_settings':{k:catalog[k] for k in ('camera_resolution','camera_postprocess','camera_motion_blur','camera_bloom','weather_preset')},'rgb':rgb,'depth':depth,'native_sensors':native_sensors,'actor_counts':{k:len(actors.filter(pattern)) for k,pattern in [('vehicles','vehicle.*'),('walkers','walker.pedestrian.*'),('controllers','controller.ai.walker'),('sensors','sensor.*')]},'performance':s['performance'],'mode':s['mode'],'sensor_errors':s['sensorErrors'],'safety':s['safetySystem']}
    assert depth['width']==640 and depth['height']==360
    counts=report['actor_counts'];assert counts['vehicles']<=41 and counts['walkers']<=30 and counts['controllers']<=30 and counts['sensors']==7
    assert catalog['camera_motion_blur']==0 and s['mode']=='PAUSED' and not s['sensorErrors'] and s['safetySystem']['controller']=='RULE'
    if status.get('status')!='ROLLED_BACK':assert matches
    target=ROOT/'docs/evidence/urban_chaos';target.mkdir(exist_ok=True,parents=True);(target/f'graphics-{args.preset.lower()}.json').write_text(json.dumps(report,indent=2),encoding='utf8')
    print(json.dumps({k:report[k] for k in ('preset','status','matched_requested_preset','active_launch','camera_settings','actor_counts','mode')},indent=2))
if __name__=='__main__':main()
