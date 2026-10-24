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
        via = target.get('via', [])
        if (not isinstance(via, list) or len(via) > 8 or any(not isinstance(p, (list, tuple))
                or len(p) != 3 or any(type(v) not in (int, float) or not math.isfinite(v) for v in p) for p in via)):
            raise ValueError('Route intermediate destinations must be finite native positions')
        points = []
        for position in [*via, target['location']]:
            destination = self.api.Location(*position)
            waypoint = self.map.get_waypoint(destination, project_to_road=True, lane_type=self.api.LaneType.Driving)
            if waypoint is None or waypoint.transform.location.distance(destination) > 10.:
                raise ValueError('Destination is outside a valid driving lane')
            leg = self.planner.trace_route(origin, waypoint.transform.location)
            if not leg: raise ValueError('No drivable route to this destination')
            gap = leg[-1][0].transform.location.distance(waypoint.transform.location)
            if gap > 8.1: raise ValueError('Native route does not reach the selected road waypoint')
            if gap > .5:
                from agents.navigation.local_planner import RoadOption
                leg.append((waypoint, RoadOption.LANEFOLLOW))
            if points and points[-1][0].transform.location.distance(leg[0][0].transform.location) > 8.1:
                raise ValueError('Native route intermediate destinations are disconnected')
            points.extend(leg)
            origin = waypoint.transform.location
        polyline = [[wp.transform.location.x, wp.transform.location.y, wp.transform.location.z] for wp, _ in points]
        route = {'id': uuid.uuid4().hex, 'destination': target, 'points': polyline,
                 'length_m': sum(math.dist(a, b) for a, b in zip(polyline, polyline[1:])),
                 'source': 'CARLA_ROAD_GRAPH', 'mode': 'MANUAL_GUIDANCE', 'active': True,
                 'instructions': [{'location': polyline[i], 'action': option.name, 'point_index': i}
                                  for i, (_, option) in enumerate(points) if option.name != 'LANEFOLLOW'
                                  and (i == 0 or points[i-1][1] != option)]}
        return route, points

    def alternative(self, origin, target, blocked_location):
        """Find a different legal graph route without a measured blocked edge.

        The original graph and previous turn state are restored even on failure.
        A missing detour is an explicit result, never permission to cross space.
        """
        import networkx as nx
        prior=self.planner
        prior_turn=(prior._previous_decision,prior._intersection_end_node) if prior else None
        try:self.plan(origin,target)
        except (nx.NetworkXNoPath,nx.NodeNotFound,KeyError,ValueError,IndexError):return None
        finally:
            if prior_turn is not None:
                prior._previous_decision,prior._intersection_end_node=prior_turn
        planner = self.planner
        edge = planner._localize(blocked_location)
        if edge is None or not planner._graph.has_edge(*edge): return None
        original = planner._graph
        modified = original.copy()
        modified.remove_edge(*edge)
        turn = planner._previous_decision, planner._intersection_end_node
        try:
            planner._graph = modified
            route, points = self.plan(origin, target)
            sequence = [(w.road_id, w.section_id, w.lane_id) for w, _ in points]
            blocked = self.map.get_waypoint(blocked_location)
            key = (blocked.road_id, blocked.section_id, blocked.lane_id)
            if key in sequence[2:]: return None
            return route, points
        except (nx.NetworkXNoPath, nx.NodeNotFound, KeyError, ValueError, IndexError):
            return None
        finally:
            planner._graph = original
            planner._previous_decision, planner._intersection_end_node = turn

    @staticmethod
    def progress(route, position):
        if route is None: return None
        candidates = range(len(route['points']))
        if route.get('destination', {}).get('via'):
            previous = route.get('_progress_index', 0)
            candidates = range(max(0, previous - 2), min(len(route['points']), previous + 9))
        nearest = min(candidates, key=lambda i: math.dist(position, route['points'][i]))
        if route.get('destination', {}).get('via'):
            route['_progress_index'] = nearest
        remaining = math.dist(position, route['points'][nearest])+sum(
            math.dist(a, b) for a, b in zip(route['points'][nearest:], route['points'][nearest+1:]))
        upcoming = next((step for step in route['instructions'] if step['point_index'] >= nearest), None)
        return {**route, 'remaining_m': remaining, 'next_instruction': upcoming,
                'arrived': math.dist(position, route['destination']['location']) <= 5
                    and (not route['destination'].get('via') or remaining <= 6.)}
