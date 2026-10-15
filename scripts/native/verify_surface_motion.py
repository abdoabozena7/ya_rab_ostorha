"""Bounded recorded RULE drive through the production dashboard commands.

Select a 140 m native route ahead of the stopped car. Never owns world ticks,
changes traffic, disables safety or promotes an experimental controller.
"""
from collections import Counter
import hashlib
import json
from pathlib import Path
import time
from .evaluate_drive_experience import ObservationSession
from backend.core.path_conflicts import PATH_CONFLICT_POLICY


def main():
    output=Path('output/path-conflict-repair/native.json')
    sources=['backend/core/path_conflicts.py','backend/core/surface_motion.py',
             'backend/core/active_safety.py','backend/core/control_scene.py',
             'frontend/cockpit-state.js','frontend/dashboard.bundle.js']
    report={'source':'LIVE_NATIVE_CARLA_PRODUCTION_WEBSOCKET','policy':PATH_CONFLICT_POLICY,
        'scope':'One bounded ordinary 30 km/h RULE journey; no general dynamic-actor or 50 km/h acceptance claim',
        'source_sha256':{p:hashlib.sha256(Path(p).read_bytes()).hexdigest() for p in sources},'samples':[]}
    with ObservationSession() as session:
        s=session.state
        assert s['mode']=='PAUSED' and not s.get('recording'),'Only test from a held, finalized operator session'
        assert s['safetySystem']['path_conflict_policy']==PATH_CONFLICT_POLICY
        assert s['safetySystem']['controller']=='RULE' and s['safetySystem']['enabled']
        vehicle=s['vehicle'];position=vehicle['positionWorldM']
        import carla
        waypoint=session.world.get_map().get_waypoint(carla.Location(*position))
        for _ in range(70):
            choices=waypoint.next(2.)
            if not choices:break
            yaw=waypoint.transform.rotation.yaw
            waypoint=min(choices,key=lambda w:abs((w.transform.rotation.yaw-yaw+180)%360-180))
        loc=waypoint.transform.location
        destination={'location':[loc.x,loc.y,loc.z],'name':'Surface motion verification destination'}
        session.action('destination',destination)
        report['destination']=destination
        start=time.monotonic()
        try:
            prior_pair=session.state['journeyComparison'].get('pair_id')
            session.send('start_journey',speed_kmh=30,driving_mode='ROBOSPHERE')
            # The acknowledgement admits a queued request; it is not the
            # first driving frame. Never report a previous saved run as this test.
            session.wait(lambda s:s['journey'].get('status')=='ERROR' or
                s['journey'].get('status')=='RUNNING' and s['journeyComparison'].get('pair_id')!=prior_pair)
            if session.state['journey']['status']=='ERROR':raise RuntimeError(session.state['journey'])
            started=session.state['vehicle']['timestamp']
            last_log=-1.
            while time.monotonic()-start<180:
                session.send('journey_heartbeat',session_id=session.state['sessionId'])
                s=session.state;v=s['vehicle'];safety=s['safetySystem'];stop=s.get('stopDiagnostics') or {}
                report['samples'].append({'frame':v['frame'],'timestamp_s':v['timestamp'],'speed_kmh':v['speedKmh'],
                    'brake':v['brake'],'remaining_m':s['route']['remaining_m'],'reason':stop.get('reason'),
                    'risk':safety.get('risk'),'path_conflict':safety.get('path_conflict'),
                    'side_rear_observations':safety.get('side_rear_observations'),
                    'sensor_wall_age_s':stop.get('sensor_wall_age_s'),'journey':s['journey']})
                elapsed=v['timestamp']-started
                if elapsed-last_log>=10:
                    print(json.dumps({'sim_s':round(elapsed,2),'speed_kmh':round(v['speedKmh'],2),
                        'remaining_m':round(s['route']['remaining_m'],2),'reason':stop.get('reason')}),flush=True);last_log=elapsed
                if s['journey']['status'] not in ('STARTING','RUNNING'):break
                if elapsed>=100:break
                time.sleep(.15)
            report['outcome']=dict(session.state['journey'])
            report['run']=dict(session.state['journeyComparison']['runs']['ROBOSPHERE'])
            report['elapsed_wall_s']=time.monotonic()-start
        except Exception as error:
            report['error']={'type':type(error).__name__,'message':str(error)}
            raise
        finally:
            session.send('stop_driving')
            session.wait(lambda s:s['vehicle']['speedKmh']<.1 and not s.get('recording'))
            report['final_mode']=session.state['mode'];report['final_brake']=session.state['vehicle']['brake']
            report['reason_counts']=dict(Counter(r['reason'] for r in report['samples']))
            output.parent.mkdir(parents=True,exist_ok=True)
            output.write_text(json.dumps(report,indent=2),encoding='utf8')
    print(json.dumps({'outcome':report.get('outcome'),'recording':report.get('run',{}).get('recording'),
        'distance_m':report.get('run',{}).get('distance_m'),'collisions':report.get('run',{}).get('collisions'),
        'output':str(output)}),flush=True)


if __name__=='__main__':main()
