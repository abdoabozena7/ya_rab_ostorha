"""Construction-time map probe for pedestrian behavior locations.

Reads only static OpenDRIVE geometry (spawn points, lanes and sidewalks) to
select road segments; no actor is spawned and nothing enters a controller.
"""
import argparse
import json
import math
from pathlib import Path
import sys
import time
from backend.core.pedestrian_behaviors import lateral_profile

ROOT = Path(__file__).resolve().parents[2]


def straight_route(start, length_m, step=2.):
    path = [start]
    while len(path)*step < length_m:
        choices = path[-1].next(step)
        if not choices:return path, False
        heading = path[-1].transform.rotation.yaw
        choices.sort(key=lambda q: (abs((q.transform.rotation.yaw-heading+180) % 360-180), q.road_id, q.lane_id))
        path.append(choices[0])
    return path, True


def scan(world_map, carla, waypoint, half_width=18., step=.25):
    t = waypoint.transform;right = t.get_right_vector();samples = []
    for i in range(int(-half_width/step), int(half_width/step)+1):
        y = i*step
        location = carla.Location(t.location.x+right.x*y, t.location.y+right.y*y, t.location.z+.5)
        found = world_map.get_waypoint(location, project_to_road=False, lane_type=carla.LaneType.Any)
        samples.append((y, str(found.lane_type) if found is not None else 'NONE'))
    return samples


def probe_town(client, carla, town, *, route_length=140., placements=(30., 45., 60., 75., 90.)):
    world = client.load_world(town);time.sleep(2.)
    world_map = world.get_map();spawns = world_map.get_spawn_points();rows = []
    for index, spawn in enumerate(spawns):
        start = world_map.get_waypoint(spawn.location, lane_type=carla.LaneType.Driving)
        row = {'town': town, 'spawn_index': index, 'accepted': False}
        try:
            if start is None or start.is_junction:raise ValueError('Spawn is not on a regular driving lane')
            path, complete = straight_route(start, route_length)
            if not complete:raise ValueError('Route ends before the required length')
            if any(q.is_junction for q in path[10:51]):raise ValueError('Junction inside the pedestrian segment')
            yaw0 = path[0].transform.rotation.yaw
            turn = max(abs((q.transform.rotation.yaw-yaw0+180) % 360-180) for q in path[:51])
            profiles = [lateral_profile(scan(world_map, carla, path[int(s/2.)])) for s in placements]
            widths = [p['road_width_m'] for p in profiles]
            sidewalk = min(min(p['right']['sidewalk_width_m'], p['left']['sidewalk_width_m']) for p in profiles)
            if sidewalk < 1.5:raise ValueError('Sidewalk narrower than 1.5 m')
            if max(widths)-min(widths) > 4.:raise ValueError('Road width changes inside the pedestrian segment')
            row.update(accepted=True, max_heading_change_deg=round(turn, 2), road_width_m=[min(widths), max(widths)],
                       min_sidewalk_m=sidewalk, right_curb_m=[p['right']['curb_m'] for p in profiles],
                       left_curb_m=[p['left']['curb_m'] for p in profiles],
                       parking_right=any(p['right']['parking_or_shoulder'] for p in profiles),
                       lane_id=start.lane_id, road_id=start.road_id)
        except ValueError as error:row['reason'] = str(error)
        rows.append(row)
    return rows


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--towns', default='Town10HD_Opt,Town03_Opt,Town05_Opt,Town02_Opt,Town01_Opt')
    parser.add_argument('--out', default=str(ROOT/'output/pedestrian-suite/location-probe.json'))
    parser.add_argument('--render-profile', default='LOW')
    args = parser.parse_args()
    import carla
    from backend.carla.runtime import NativeRuntime
    from backend.graphics import launch
    runtime = NativeRuntime();launched = False
    if not runtime.active:
        runtime.launch({**launch(args.render_profile), 'offscreen': True}, '127.0.0.1', 2000, carla);launched = True
    client = carla.Client('127.0.0.1', 2000);client.set_timeout(120.)
    report = {'source': 'STATIC_OPENDRIVE_MAP_GEOMETRY', 'towns': {}, 'started_unix': time.time()}
    try:
        for town in args.towns.split(','):
            try:report['towns'][town] = probe_town(client, carla, town)
            except RuntimeError as error:report['towns'][town] = {'error': str(error)}
            accepted = [r for r in report['towns'][town] if isinstance(r, dict) and r.get('accepted')] if isinstance(report['towns'][town], list) else []
            print(json.dumps({'town': town, 'accepted': len(accepted)}), flush=True)
    finally:
        report['finished_unix'] = time.time()
        out = Path(args.out);out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(report, indent=1), encoding='utf8')
        if launched:runtime.stop()
    print(json.dumps({'report': str(out)}))
    return 0


if __name__ == '__main__':sys.exit(main())
