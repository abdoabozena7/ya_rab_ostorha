"""Bounded held-ego placement check. No driving, model training or second tick."""
import json
import math
from pathlib import Path
import urllib.request
from .evaluate_drive_experience import ObservationSession
from backend.carla.routes import RouteService


def main():
    import carla
    output=Path('output/route-crowding');output.mkdir(parents=True,exist_ok=True)
    preferences=Path('config/dashboard-preferences.json').read_bytes()
    proof={'source':'LIVE_NATIVE', 'driving_started':False, 'cases':[]}
    with ObservationSession() as s:
        s.send('stop_driving')
        before=s.state
        original_route=before.get('route')
        origin=s.world.get_actor(before['vehicle']['actorId']).get_location() if 'actorId' in before['vehicle'] else carla.Location(*before['vehicle']['positionWorldM'])
        catalog=json.load(urllib.request.urlopen('http://127.0.0.1:8000/api/simulation/catalog'))
        (output/'native-catalog.json').write_text(json.dumps(catalog),encoding='utf8')
        planner=RouteService(s.world.get_map(),carla)
        candidates=[]
        places=sorted(catalog['places'],key=lambda p:math.dist(p['location'],[origin.x,origin.y,origin.z]))
        for target in places[::max(1,len(places)//36)]:
            try: route,_=planner.plan(origin,target)
            except ValueError: continue
            if route['length_m']>80: candidates.append(route)
        candidates.sort(key=lambda r:r['length_m'])
        short=next(r for r in candidates if r['length_m']>100)
        long=next(r for r in reversed(candidates) if r['length_m']>short['length_m']*2)
        try:
            for selected in (short,long):
                s.action('destination',selected['destination']['id'])
                route=s.state['route']
                result=s.action('crowd_route',{'route_id':route['id'],'seed':987,'chaos_percent':45})
                pop=s.state['population'];crowd=result['crowding']
                points=[carla.Location(*p) for p in route['points']]
                distances=[];gaps=[]
                snapshot=s.world.get_snapshot()
                for actor_id in pop['vehicle_ids']:
                    actor=snapshot.find(actor_id)
                    if actor is None: continue
                    location=actor.get_transform().location
                    gaps.append(min(location.distance(p) for p in points))
                    distances.append(location.distance(origin))
                case={'route_length_m':route['length_m'],'crowding':crowd,'actual':pop['actual'],
                    'nearby_120m':sum(d<120 for d in distances),'nearest_m':min(distances),
                    'furthest_from_ego_m':max(distances),'max_route_gap_m':max(gaps),
                    'ego_displacement_m':math.dist(before['vehicle']['positionWorldM'],s.state['vehicle']['positionWorldM']),
                    'mode':s.state['mode'],'npc_failed':pop['npc_failed'],'errors':pop['errors']}
                proof['cases'].append(case)
                (output/'native-placement.json').write_text(json.dumps(proof,indent=2),encoding='utf8')
                assert crowd['status']=='READY',case
                assert pop['actual']['vehicles']==crowd['target_count']==crowd['placed_count'],case
                assert case['nearby_120m']>=3 and case['nearest_m']<60,case
                assert case['max_route_gap_m']<12,case
                assert case['ego_displacement_m']<.2 and case['mode']=='PAUSED',case
            assert proof['cases'][1]['actual']['vehicles']>proof['cases'][0]['actual']['vehicles'],proof
        finally:
            if original_route:s.action('destination',original_route['destination']['id'])
            else:s.action('clear_route')
            s.send('stop_driving')
            proof['restored_destination']=True
            proof['preferences_unchanged']=Path('config/dashboard-preferences.json').read_bytes()==preferences
            (output/'native-placement.json').write_text(json.dumps(proof,indent=2),encoding='utf8')
    print(json.dumps(proof,indent=2))


if __name__=='__main__':main()
