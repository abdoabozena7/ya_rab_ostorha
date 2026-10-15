"""Map-only route context and fair native baseline adapters for hybrid driving."""
import math
import xml.etree.ElementTree as ET


class RoadSpeedPolicy:
    """Explicit OpenDRIVE units, with a conservative native fallback.

    CARLA's default last-seen sign value is not a posted sign on an unsigned
    OpenDRIVE road. Both benchmark drivers use this same map policy.
    """
    def __init__(self, native_map):
        self.roads = {}
        root = ET.fromstring(native_map.to_opendrive())
        for road in root.findall('road'):
            speeds = []
            for kind in road.findall('type'):
                speed = kind.find('speed')
                if speed is None: continue
                try: value = float(speed.get('max'))
                except (TypeError, ValueError): continue
                unit = speed.get('unit', 'm/s')
                factor = {'m/s': 3.6, 'km/h': 1., 'mph': 1.609344}.get(unit)
                if factor and math.isfinite(value) and 1 <= value*factor <= 160:
                    speeds.append((float(kind.get('s', 0)), value*factor))
            self.roads[int(road.get('id'))] = sorted(speeds)

    def limit(self, waypoint, native_limit):
        eligible = [limit for start, limit in self.roads.get(waypoint.road_id, []) if start <= waypoint.s]
        if eligible: return eligible[-1], 'OPENDRIVE_EXPLICIT_UNITS'
        if math.isfinite(native_limit) and 5 <= native_limit <= 160: return native_limit, 'NATIVE_LAST_SIGN'
        return 20., 'CONSERVATIVE_UNAVAILABLE_MAP_LIMIT'


def build_drivable_strips(native_map):
    from collections import defaultdict
    groups=defaultdict(list)
    # Uniform samples stop before a segment end when less than one sample
    # interval remains. Exact topology boundaries close that unsampled tail.
    points=list(native_map.generate_waypoints(1.))
    for start,end in native_map.get_topology():points.extend((start,end))
    for point in points:
        if str(point.lane_type)=='Driving':
            groups[(point.road_id,point.section_id,point.lane_id)].append(point)
    strips=[]
    def add(a,b):
        x,y=a.transform.location,b.transform.location
        if .0001<x.distance(y)<2.1:
            forward=a.transform.get_forward_vector()
            key=(a.road_id,a.section_id,a.lane_id);other=(b.road_id,b.section_id,b.lane_id)
            strips.append((key,other,(x.x,x.y,y.x,y.y,min(a.lane_width,b.lane_width)/2,forward.x,forward.y)))
    for points in groups.values():
        points.sort(key=lambda q:q.s)
        for a,b in zip(points,points[1:]):add(a,b)
        for a in points:
            for b in a.next(1.):
                if str(b.lane_type)=='Driving':add(a,b)
    return strips


def behavior_agent_class():
    from agents.navigation.behavior_agent import BehaviorAgent

    class MatchedBehaviorAgent(BehaviorAgent):
        def __init__(self, *args, speed_policy, requested_speed, **kwargs):
            super().__init__(*args, behavior='normal', **kwargs)
            self.speed_policy = speed_policy
            self.requested_speed = requested_speed

        def _update_information(self):
            super()._update_information()
            waypoint = self._map.get_waypoint(self._vehicle.get_location())
            limit, _ = self.speed_policy.limit(waypoint, self._vehicle.get_speed_limit())
            self._speed_limit = limit
            self._behavior.max_speed = min(50., self.requested_speed)
            self._local_planner.set_speed(min(self.requested_speed, limit))

        def set_target_speed(self, speed):
            self.requested_speed = speed

    return MatchedBehaviorAgent


def road_context(provider, session_id):
    """Only ego pose, native road topology and the selected route are read."""
    base = provider.local_road_context(session_id)
    pose = provider.ego.actor.get_transform()
    wp = provider.dashboard_tools.map.get_waypoint(pose.location)
    route = provider.dashboard_tools.native_route
    reference = min(route, key=lambda item: item[0].transform.location.distance(pose.location))[0]
    # The first queued route point can be metres ahead; its lateral coordinate
    # is not the lane center under the current body during a maneuver.
    lane = wp
    if wp.road_id == reference.road_id and wp.lane_id != reference.lane_id:
        for side in ('left','right'):
            candidate=wp
            for _ in range(3):
                candidate=getattr(candidate,'get_'+side+'_lane')() if candidate else None
                if candidate is None:break
                if candidate.lane_id==reference.lane_id:lane=candidate;break
            if lane.lane_id==reference.lane_id:break
    right=pose.get_right_vector();center=lane.transform.location
    dx,dy=center.x-pose.location.x,center.y-pose.location.y
    base['centerline'][0]=[0.,dx*right.x+dy*right.y]
    base.update(lane_key=[wp.road_id, wp.section_id, wp.lane_id],
                route_lane_key=[reference.road_id, reference.section_id, reference.lane_id],
                return_allowed=False, alternatives=False)
    import numpy as np
    if getattr(provider,'hybrid_road_strips_map',None)!=provider.dashboard_tools.map_name:
        provider.hybrid_road_strips=build_drivable_strips(provider.dashboard_tools.map)
        provider.hybrid_road_strip_array=np.unique(np.round(np.array([row for _,_,row in provider.hybrid_road_strips]),4),axis=0)
        provider.hybrid_road_strips_map=provider.dashboard_tools.map_name
    allowed={(point.road_id,point.section_id,point.lane_id) for point,_ in route}
    allowed.add((wp.road_id,wp.section_id,wp.lane_id))
    progress=provider.route_state()
    base['remaining_m']=progress.get('remaining_m') if progress else None
    for side in ('left', 'right'):
        neighbour = getattr(wp, 'get_'+side+'_lane')()
        if neighbour is not None and base[side+'_allowed']:
            allowed.add((neighbour.road_id,neighbour.section_id,neighbour.lane_id))
        if neighbour is not None and neighbour.lane_id == reference.lane_id and base[side+'_allowed']:
            base['return_allowed'] = True
    co,si=math.cos(math.radians(pose.rotation.yaw)),math.sin(math.radians(pose.rotation.yaw))
    # Vectorized local geometry avoids two Python scans/transforms of the
    # entire town during every control decision and its independent veto.
    rows=provider.hybrid_road_strip_array
    origin=np.array([pose.location.x,pose.location.y])
    first=rows[:,:2]-origin;second=rows[:,2:4]-origin
    speed=abs((provider.last_vehicle or {}).get('speedMps',0.))
    scope=max(12.,speed*.6+speed**2/6.+provider.vehicle_geometry.front_m+provider.vehicle_geometry.rear_m+5.)
    keep=np.minimum(np.sum(first*first,axis=1),np.sum(second*second,axis=1))<=scope**2
    transform=np.array([[co,-si],[si,co]])
    base['drivable_strips']=np.column_stack((first[keep]@transform,second[keep]@transform,
                                            rows[keep,4],rows[keep,5:7]@transform)).tolist()
    # A map route is only available after the provider actually found it around
    # a measured route blocker. Search can precede a complete standstill.
    base['alternatives'] = bool(getattr(provider, 'hybrid_alternative', None))
    return base
