"""Evaluator-only stopped-car fixtures selected from legal native road geometry."""
from backend.carla.hybrid_world import HybridWorld


def permitted(wp,side):
    other=getattr(wp,'get_'+side+'_lane')()
    if other is None or str(other.lane_type)!='Driving':return False
    a=wp.transform.get_forward_vector();b=other.transform.get_forward_vector()
    return a.x*b.x+a.y*b.y>.9 and (side.title() in str(wp.lane_change) or 'Both' in str(wp.lane_change))


def native_start(native_map,side,variant=0):
    opposite='right' if side=='left' else 'left'
    found=0
    for index,pose in enumerate(native_map.get_spawn_points()):
        initial=native_map.get_waypoint(pose.location)
        if initial.is_junction or not permitted(initial,side) or permitted(initial,opposite):continue
        point=initial;valid=True
        for _ in range(25):
            choices=point.next(2.)
            if not choices:valid=False;break
            yaw=initial.transform.rotation.yaw
            point=min(choices,key=lambda p:abs((p.transform.rotation.yaw-yaw+180)%360-180))
            if point.is_junction or not permitted(point,side) or abs((point.transform.rotation.yaw-yaw+180)%360-180)>10.:
                valid=False;break
        if valid:
            if found==variant:return index
            found+=1
    raise RuntimeError('No native straight legal '+side+'-only passing fixture is available')


class RuleBypassWorld(HybridWorld):
    def setup(self,kind,seed,**kwargs):
        self.case_kind=kind
        side='right' if kind=='RULE_BYPASS_RIGHT' else 'left'
        variant=kwargs.pop('fixture_variant',0)
        if kind!='RULE_BYPASS_RED_SIGNAL':
            kwargs['spawn_index']=native_start(self.p.world.world.get_map(),side,variant)
        base='EMPTY_ROAD' if kind=='RULE_BYPASS_RED_SIGNAL' else 'PASS_RETURN'
        result=super().setup(base,seed,**kwargs)
        if kind=='RULE_BYPASS_OCCUPIED':
            wp=self.p.world.world.get_map().get_waypoint(self.origin)
            self._spawn(18.,-float(wp.lane_width))
        result.update(rule_bypass_case=kind,expected_passing_side=side,
            fixture_spawn_index=kwargs['spawn_index'],fixture_variant=variant)
        return result
