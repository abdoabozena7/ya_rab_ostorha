"""Manual route guidance from native CARLA topology; no control output."""
import math
import sys
import uuid
from pathlib import Path


class RouteService:
    def __init__(self, native_map, api):
        self.map, self.api = native_map, api
        self.planner = None

    def plan(self, origin, target):
        if target['map'] != self.map.name:
            raise ValueError('Saved destination belongs to a different CARLA map')
        if self.planner is None:
            api_path = Path('C:/CARLA/CARLA_0.9.16/PythonAPI/carla')
            if str(api_path) not in sys.path: sys.path.insert(0, str(api_path))
            from agents.navigation.global_route_planner import GlobalRoutePlanner
            self.planner = GlobalRoutePlanner(self.map, 4.)
        destination = self.api.Location(*target['location'])
        waypoint = self.map.get_waypoint(destination, project_to_road=True, lane_type=self.api.LaneType.Driving)
        if waypoint is None or waypoint.transform.location.distance(destination) > 10.:
            raise ValueError('Destination is outside a valid driving lane')
        points = self.planner.trace_route(origin, waypoint.transform.location)
        if not points: raise ValueError('No drivable route to this destination')
        gap = points[-1][0].transform.location.distance(waypoint.transform.location)
        if gap > 8.1: raise ValueError('Native route does not reach the selected road waypoint')
        if gap > .5:
            from agents.navigation.local_planner import RoadOption
            points.append((waypoint, RoadOption.LANEFOLLOW))
        polyline = [[wp.transform.location.x, wp.transform.location.y, wp.transform.location.z] for wp, _ in points]
        route = {'id': uuid.uuid4().hex, 'destination': target, 'points': polyline,
                 'length_m': sum(math.dist(a, b) for a, b in zip(polyline, polyline[1:])),
                 'source': 'CARLA_ROAD_GRAPH', 'mode': 'MANUAL_GUIDANCE', 'active': True,
                 'instructions': [{'location': polyline[i], 'action': option.name, 'point_index': i}
                                  for i, (_, option) in enumerate(points) if option.name != 'LANEFOLLOW'
                                  and (i == 0 or points[i-1][1] != option)]}
        return route, points

    @staticmethod
    def progress(route, position):
        if route is None: return None
        nearest = min(range(len(route['points'])), key=lambda i: math.dist(position, route['points'][i]))
        remaining = math.dist(position, route['points'][nearest])+sum(
            math.dist(a, b) for a, b in zip(route['points'][nearest:], route['points'][nearest+1:]))
        upcoming = next((step for step in route['instructions'] if step['point_index'] >= nearest), None)
        return {**route, 'remaining_m': remaining, 'next_instruction': upcoming,
                'arrived': math.dist(position, route['destination']['location']) <= 5}
