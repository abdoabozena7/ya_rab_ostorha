"""Native navigation geometry. Privileged BasicAgent inputs stay in this adapter."""
import math


def blocks_forward_route(route, footprint, half_width, origin, forward, front_extent):
    """Rear/adjacent proximity alone is not a route obstacle.

    Buffer an ordered centerline rather than connecting alternating left/right
    edges into a self-intersecting polygon. Preserve real corner/crossing overlap.
    """
    from shapely.geometry import LineString, Polygon
    if len(route) < 2 or len(footprint) < 3:
        return False
    if max((x-origin[0])*forward[0]+(y-origin[1])*forward[1] for x,y in footprint) <= front_extent:
        return False
    return LineString(route).buffer(half_width, cap_style=2, join_style=2).intersects(Polygon(footprint))


def route_agent_class():
    from agents.navigation.basic_agent import BasicAgent, ObstacleDetectionResult
    from .geometry import footprint

    class ForwardRouteAgent(BasicAgent):
        def run_step(self):
            self.stop_reason = None
            value = super().run_step()
            if value.brake > .01 and self.stop_reason is None:
                self.stop_reason = 'Navigation speed/route controller'
            return value

        def _affected_by_traffic_light(self, *args, **kwargs):
            result = super()._affected_by_traffic_light(*args, **kwargs)
            if result[0]: self.stop_reason = 'Red traffic light on the planned route'
            return result

        def _vehicle_obstacle_detected(self, vehicle_list=None, max_distance=None, **kwargs):
            if self._ignore_vehicles:
                return ObstacleDetectionResult(False, None, -1)
            transform = self._vehicle.get_transform()
            origin = (transform.location.x, transform.location.y)
            direction = transform.get_forward_vector()
            forward = (direction.x, direction.y)
            box = self._vehicle.bounding_box
            front = box.extent.x + box.location.x
            distance = max_distance or self._base_vehicle_threshold
            # Front bumper to the ordered route, clipped at the existing horizon.
            route = [(origin[0]+front*forward[0], origin[1]+front*forward[1])]
            for wp, _ in self._local_planner.get_plan():
                loc = wp.transform.location
                if math.hypot(loc.x-origin[0],loc.y-origin[1]) > distance: break
                if (loc.x-origin[0])*forward[0]+(loc.y-origin[1])*forward[1] < front: continue
                route.append((loc.x,loc.y))
            if len(route) == 1:
                route.append((origin[0]+distance*forward[0],origin[1]+distance*forward[1]))
            closest = None
            for target in vehicle_list if vehicle_list is not None else self._world.get_actors().filter('*vehicle*'):
                if target.id == self._vehicle.id: continue
                tt = target.get_transform()
                gap = math.hypot(tt.location.x-origin[0],tt.location.y-origin[1])
                if gap > distance or abs(tt.location.z-transform.location.z)>3.: continue
                if blocks_forward_route(route, footprint(tt,target.bounding_box), box.extent.y+.1,
                                        origin,forward,front):
                    if closest is None or gap < closest[0]: closest=(gap,target)
            if closest:
                self.stop_reason = 'Vehicle footprint intersects the forward planned route'
                return ObstacleDetectionResult(True,closest[1],closest[0])
            return ObstacleDetectionResult(False,None,-1)
    return ForwardRouteAgent
