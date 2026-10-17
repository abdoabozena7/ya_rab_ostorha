"""Limited low-speed bypass lifecycle around the ordinary RULE route driver.

Normal cruising keeps the existing route follower. A sustained measured stopped
obstacle warms synchronized motion tracking, slows the route follower, and gives
the bounded behavior owner a short maneuver. The execution shield remains a
per-frame veto. Deployment requires its own scoped native evidence.
"""
import hashlib
import json
import math
from pathlib import Path
import time
from functools import lru_cache
from collections import deque
from ..learning.hybrid_budget import active_ticket
from .hybrid_driver import HybridDriver

ROOT=Path(__file__).resolve().parents[2]
CONFIG=ROOT/'config/route-bypass.json'
REPORT=ROOT/'docs/evidence/route-bypass-20261016/acceptance.json'


def configuration():return json.loads(CONFIG.read_text())


def source_fingerprint():
    files=sorted([*ROOT.glob('backend/core/*.py'),*ROOT.glob('backend/carla/*.py')])
    hashes={p.relative_to(ROOT).as_posix():hashlib.sha256(p.read_bytes()).hexdigest() for p in files}
    config=configuration()
    for key in ('enabled','accepted_sides','reason'):config.pop(key,None)
    hashes['config/route-bypass.json']=hashlib.sha256(json.dumps(config,sort_keys=True).encode()).hexdigest()
    return hashlib.sha256(json.dumps(hashes,sort_keys=True).encode()).hexdigest()


@lru_cache(maxsize=2)
def availability(second):
    config=configuration();ticket=active_ticket()
    accepted=False
    if config['enabled']:
        try:
            report=json.loads(REPORT.read_text())
            required={'clear_left','clear_right','occupied_lane','traffic_stop','ordinary_resume'}
            accepted=(report.get('accepted') is True and report.get('source_fingerprint')==source_fingerprint()
                and set(report.get('gates',{}))==required and all(report['gates'].values())
                and set(config['accepted_sides'])<=set(report['tested_sides'])
                and config['maneuver_speed_mps']<=report['maximum_maneuver_speed_mps'])
        except (OSError,ValueError,KeyError,TypeError):pass
    return {'available':accepted or ticket is not None,'accepted':accepted,
        'sides':config['accepted_sides'] if accepted else ['left','right'] if ticket else [],
        'deadline':ticket['expires_monotonic_s'] if ticket and not accepted else float('inf')}


def available():return availability(int(time.monotonic()))['available']


class RuleRouteBypass:
    def __init__(self,geometry,*,deadline=float('inf'),sides=('left','right')):
        self.config=configuration();self.driver=HybridDriver(geometry,deadline=deadline,allow_reverse=False)
        self.sides=tuple(sides);self.arming=self.engaged=False
        self.stationary_since=self.last_target=self.detour_at=None
        self.cooldown_until=0.
        self.preparing=True;self.preparation_since=None
        self.range_history=deque();self.travelled=0.;self.previous_stamp=None;self.previous_speed=0.
        self.reset_pending=False
        self.target_anchor=None

    @property
    def motion_required(self):return self.preparing or self.arming or self.engaged

    def _remember_target(self,scene):
        if self.target_anchor is not None:return
        front=[t for t in scene.prediction['tracks'] if t.get('confirmed') and t.get('occlusion_s',0)<=.1 and
            t['position_m'][0]>scene.geometry.front_m and
            abs(t['position_m'][1])<scene.geometry.half_width_m+t['half_size_m'][1]+.2 and
            math.hypot(*t['velocity_mps'])<.75]
        if front:
            from .prediction import rotation
            import numpy as np
            target=min(front,key=lambda t:t['position_m'][0])
            point=np.asarray(scene.prediction['odometry_origin_m'])+rotation(scene.prediction['odometry_yaw_rad'])@np.asarray(target['position_m'])
            self.target_anchor=(point,list(target['half_size_m']))

    def observe(self,scene,status,*,traffic_stop=False,wall):
        if scene is None:return False
        now=scene.observation.timestamp_s;ego=scene.observation.ego
        dt=0. if self.previous_stamp is None else now-self.previous_stamp
        if 0<dt<=.15:self.travelled+=(ego.speed_mps+self.previous_speed)*.5*dt
        elif dt>.15:self.range_history.clear()
        self.previous_stamp=now;self.previous_speed=ego.speed_mps
        if self.preparation_since is None:self.preparation_since=now
        if now-self.preparation_since>=.6:self.preparing=False
        if self.engaged:
            if scene.usable(now,wall):self._remember_target(scene)
            finished='PASS_RETURN' in self.driver.completed_maneuvers
            # The native route can already contain a legal lane transition.
            # In that case the behavior owner follows it without entering EXIT.
            # Release the temporary low-speed owner only after measured ego
            # travel has cleared the last observed stationary blocker bounds.
            if self.target_anchor is not None and self.driver.phase=='FOLLOW' and scene.usable(now,wall):
                from .prediction import rotation
                import numpy as np
                point,half=self.target_anchor
                local=rotation(scene.prediction['odometry_yaw_rad']).T@(point-np.asarray(scene.prediction['odometry_origin_m']))
                if local[0]+max(half)<-scene.geometry.rear_m-2.:
                    finished=True
                    if 'ROUTE_BYPASS' not in self.driver.completed_maneuvers:self.driver.completed_maneuvers.append('ROUTE_BYPASS')
            # A graph detour can be a lane transition on this same road.
            # Travelling eight metres on it does not prove clearing the object;
            # retain the measured-clearance completion above for that case too.
            if finished:
                self.engaged=self.arming=self.preparing=False;self.cooldown_until=now+2.;self.stationary_since=None
                self.reset_pending=True
                return True
            return False
        if traffic_stop or wall>=self.driver.deadline or now<self.cooldown_until:
            self.arming=self.preparing=False;self.stationary_since=None;return False
        age=now-status.get('timestamp_s',-math.inf)
        distance=status.get('measured_range_m');closing=status.get('closing_speed_mps')
        usable=(0<=age<=.1+1e-6 and isinstance(distance,(int,float)) and
            0<distance<max(35.,ego.speed_mps*3.+10.))
        if usable:
            self.range_history.append((now,distance+self.travelled-ego.speed_mps*age))
        while self.range_history and now-self.range_history[0][0]>.65:self.range_history.popleft()
        range_static=False
        if len(self.range_history)>=6 and now-self.range_history[0][0]>=.35 and abs(ego.angular_velocity_radps[2])<.15:
            import numpy as np
            samples=np.asarray(self.range_history);x=samples[:,0]-samples[:,0].mean();y=samples[:,1]-samples[:,1].mean()
            slope=float(x@y/(x@x))
            range_static=abs(slope)<.75 and float(np.quantile(abs(y-slope*x),.9))<.2
        stationary=usable and ((closing is not None and abs(ego.speed_mps-closing)<.75) or ego.speed_mps<.15)
        stationary=stationary or usable and range_static
        if usable and scene.usable(now,wall) and scene.prediction.get('motion_tracking_complete'):
            g=scene.geometry
            stationary=stationary or any(t.get('confirmed') and t.get('occlusion_s',0)<=.1 and
                abs(t['position_m'][1])<g.half_width_m+t['half_size_m'][1]+.2 and
                2.<t['position_m'][0]-t['half_size_m'][0]-g.front_m<max(35.,ego.speed_mps*3.+10.) and
                math.hypot(*t['velocity_mps'])<.5 for t in scene.prediction['tracks'])
        if stationary:
            self.last_target=now
            if self.stationary_since is None:self.stationary_since=now
            if now-self.stationary_since>=self.config['stationary_confirmation_s']:self.arming=True
        elif not self.arming:self.stationary_since=None
        elif self.last_target is not None and now-self.last_target>2.:
            self.arming=False;self.stationary_since=None
        if self.arming and self.reset_pending:
            self.driver=HybridDriver(self.driver.geometry,deadline=self.driver.deadline,allow_reverse=False)
            self.reset_pending=False;self.detour_at=None;self.target_anchor=None
        if (self.arming and not self.preparing and scene.prediction.get('motion_tracking_complete') and scene.usable(now,wall)
                and ego.speed_mps<=self.config['maneuver_speed_mps']+.25
                and any(t.get('confirmed') for t in scene.prediction['tracks'])):
            self.engaged=True
            self._remember_target(scene)
        return False
