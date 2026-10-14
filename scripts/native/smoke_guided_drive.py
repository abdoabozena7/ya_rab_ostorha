"""Short normal-city smoke check. No physics ticks, resets or preference changes."""
import json
from pathlib import Path
import time
from collections import Counter
from .evaluate_drive_experience import ObservationSession


def main():
    folder=Path('output/guided-drive');folder.mkdir(parents=True,exist_ok=True)
    preferences=Path('config/dashboard-preferences.json').read_bytes()
    rows=[];contacts={};began=time.monotonic()
    with ObservationSession() as session:
        session.send('stop_driving');session.wait(lambda s:s['vehicle']['speedMagnitudeMps']<.15)
        assert session.state['population']['actual']['vehicles']==40
        assert session.state['safetySystem']['path_conflict_policy']=='FORWARD_PHYSICAL_INGRESS_V3'
        session.action('destination',{'location':[-36.883373,-68.379028,0.],'name':'Forward city check'})
        started=session.state['vehicle']['timestamp'];initial=session.state['safetySystem']['intervention_count']
        try:
            session.send('start_journey',speed_kmh=20)
            deadline=time.monotonic()+60
            while time.monotonic()<deadline:
                session.send('journey_heartbeat',session_id=session.state['sessionId'])
                s=session.state;v=s['vehicle'];safety=s['safetySystem'];stop=s['stopDiagnostics']
                rows.append({'frame':v['frame'],'timestamp_s':v['timestamp'],'speed_kmh':v['speedKmh'],
                    'remaining_m':s['route']['remaining_m'],'mode':s['mode'],'journey':s['journey'],
                    'brake':v['brake'],'source':stop['decision_source'],'reason':stop['reason'],
                    'risk':safety['risk'],'conflict':safety.get('path_conflict'),
                    'observations':safety.get('side_rear_observations'),'interventions':safety['intervention_count'],
                    'sensor_age_s':stop['sensor_wall_age_s']})
                for c in s['collisionEvents']:
                    if c['timestamp_s']>=started:contacts[(c['frame_id'],c['other_actor_id'])]=c
                if s['journey']['status'] not in ('STARTING','RUNNING'):break
                time.sleep(.15)
        finally:
            final=dict(session.state['journey']);remaining=session.state['route']['remaining_m']
            count=session.state['safetySystem']['intervention_count']-initial
            session.send('stop_driving');session.wait(lambda s:s['vehicle']['speedMagnitudeMps']<.15)
            (folder/'physical-v3-telemetry.json').write_text(json.dumps(rows,indent=2))
            report={'scope':'Single unrecorded native smoke check; not a research comparison or general safety validation',
                'source':'LIVE_NATIVE_CARLA','controller':'BasicAgent + RULE','policy':'FORWARD_PHYSICAL_INGRESS_V3',
                'elapsed_wall_s':time.monotonic()-began,'journey':final,'remaining_m':remaining,
                'max_speed_kmh':max((r['speed_kmh'] for r in rows),default=0),'interventions':count,
                'brake_reasons':dict(Counter(r['reason'] for r in rows if r['brake']>.01)),
                'contact_callbacks_since_start':len(contacts),'contacts':list(contacts.values()),
                'preferences_unchanged':preferences==Path('config/dashboard-preferences.json').read_bytes(),
                'final_mode':session.state['mode'],'final_speed_kmh':session.state['vehicle']['speedKmh']}
            (folder/'physical-v3-summary.json').write_text(json.dumps(report,indent=2))
            print(json.dumps(report),flush=True)


if __name__=='__main__':main()

