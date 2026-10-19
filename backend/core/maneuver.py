"""Measured-motion navigation planner and independent maneuver admission.

RoadContext is an onboard map/route adapter, not target ground truth. Occupancy,
target tracks and forecasts contain sensor evidence only. The emergency braking
supervisor retains priority over every admitted navigation command.
"""
from dataclasses import replace
import math
import time
import numpy as np
from .contracts import CommandSource
from .motion_geometry import GRID, VehicleGeometry, footprint_centers,object_assessments
from .prediction import assess_conflicts
from .measured_rows import unique_row_indices


class ObservedSpace:
    RESOLUTION=.5
    LIMIT=50.

    def __init__(self,points,geometry,*,measured_surfaces=(),scope_m=None,limit_m=50.):
        self.LIMIT=min(100.,max(50.,float(limit_m)))
        self.size=int(round(2*self.LIMIT/self.RESOLUTION))+1
        self.geometry=geometry
        self.scope_m=self.LIMIT if scope_m is None else min(self.LIMIT,max(geometry.front_m,geometry.rear_m,geometry.half_width_m,float(scope_m)))
        self.free=np.zeros((self.size,self.size),bool);self.occupied=np.zeros_like(self.free)
        sources=[(points,np.array([0.,0.,1.9]))]+list(measured_surfaces)
        from .ground_geometry import measured_ground_plane
        self.ground_plane,self.ground_support=measured_ground_plane(np.vstack([p for p,_ in sources]),geometry)
        for points,origin in sources:self._observe(points,np.asarray(origin,float))
        # Only sub-cell discretization tolerance; never bridge an occupied cell.
        def dilate(array, offsets):
            padded=np.pad(array,1);out=np.zeros_like(array)
            for dx,dy in offsets:out|=padded[1+dx:self.size+1+dx,1+dy:self.size+1+dy]
            return out
        self.free=dilate(self.free,[(0,0),(-1,0),(0,-1),(-1,-1)])&~dilate(self.occupied,[(x,y) for x in (-1,0,1) for y in (-1,0,1)])
        self.measured_free=self.free.copy()
        cells=np.indices(self.free.shape).transpose(1,2,0)*self.RESOLUTION-self.LIMIT
        own=(cells[:,:,0]<=geometry.front_m)&(cells[:,:,0]>=-geometry.rear_m)&(np.abs(cells[:,:,1])<=geometry.half_width_m)
        self.free[own]=True
        self.own_cells=own
        self.occupied[own]=False

    def _observe(self,points,origin):
        xyz=np.asarray(points,float)
        if xyz.ndim!=2 or xyz.shape[1]!=3 or not np.isfinite(xyz).all():raise ValueError('Invalid space observations')
        radius=np.linalg.norm(xyz[:,:2],axis=1)
        relative_height=xyz[:,2]-xyz[:,0]*self.ground_plane[0]-xyz[:,1]*self.ground_plane[1]-self.ground_plane[2]
        usable=(radius>.5)&(radius<self.LIMIT)&(relative_height>-.2)&(relative_height<2.5)
        g=self.geometry
        # Own body returns cannot cast an external occupied halo around the
        # vehicle. Filter them before obstacle dilation, using onboard geometry.
        usable&=~((xyz[:,0]<=g.front_m)&(xyz[:,0]>=-g.rear_m)&(np.abs(xyz[:,1])<=g.half_width_m))
        xyz=xyz[usable];radius=radius[usable]
        # Retain a real return for each occupancy cell/height band. Dense depth
        # images otherwise repeat the same ray work thousands of times. This
        # discards redundant observations; it never invents a free return.
        if len(xyz):
            cells=self.indices(xyz[:,:2])
            keys=np.column_stack((cells,xyz[:,2]>.25,np.floor(xyz[:,2]/.2).astype(int)))
            keep=unique_row_indices(keys)
            xyz=xyz[keep]
        # Lane paint/ground stay out of actor tracking; low curbs still retain
        # geometric protection. Sloped surfaces require independent admission.
        heights=xyz[:,2]-xyz[:,0]*self.ground_plane[0]-xyz[:,1]*self.ground_plane[1]-self.ground_plane[2]
        fg=heights>.12
        # No return is UNKNOWN. Ground hits and rays preceding a real surface
        # establish observed cells; elevated rays do not certify low obstacles.
        if not len(xyz):return
        idx=self.indices(xyz[:,:2])
        self.occupied[idx[fg,0],idx[fg,1]]=True
        ground=np.abs(heights)<=.08
        self.free[idx[ground,0],idx[ground,1]]=True
        # Clip actual calibrated rays to the candidate stopping neighborhood.
        # Endpoints beyond it still cast real rays through it; they are never
        # replaced by fabricated ground/free endpoints. Occupancy hits remain.
        delta=xyz[:,:2]-origin[:2]
        near=np.zeros(len(xyz));far=np.ones(len(xyz))
        for axis in (0,1):
            moving=np.abs(delta[:,axis])>1e-8
            low=np.divide(-self.scope_m-origin[axis],delta[:,axis],out=np.full(len(xyz),-np.inf),where=moving)
            high=np.divide(self.scope_m-origin[axis],delta[:,axis],out=np.full(len(xyz),np.inf),where=moving)
            near=np.maximum(near,np.minimum(low,high));far=np.minimum(far,np.maximum(low,high))
        valid=far>near
        xyz=xyz[valid];delta=delta[valid];near=near[valid];far=far[valid]
        if not len(xyz):return
        count=max(2,int(np.ceil(2*self.scope_m/self.RESOLUTION))+1)
        fractions=near[:,None]+(far-near)[:,None]*np.linspace(0.,.999,count)[None,:]
        sample=origin[:2]+delta[:,None,:]*fractions[:,:,None]
        # Vectorized calibrated rays avoid hundreds of Python calls per frame.
        height=origin[2]+(xyz[:,2,None]-origin[2])*fractions
        height-=sample[:,:,0]*self.ground_plane[0]+sample[:,:,1]*self.ground_plane[1]+self.ground_plane[2]
        idx=self.indices(sample[(height>=.25)&(height<=1.5)])
        self.free[idx[:,0],idx[:,1]]=True

    def indices(self,xy):return np.clip(np.rint((np.asarray(xy)+self.LIMIT)/self.RESOLUTION).astype(int),0,self.size-1)

    def _footprint_status(self,sample):
        g=self.geometry
        # Include exact body edges. Occupied-cell dilation supplies clearance;
        # padding the body again required fictitious rear/side space while held.
        xx=np.linspace(-g.rear_m,g.front_m,int(np.ceil((g.front_m+g.rear_m)/self.RESOLUTION))+1)
        yy=np.linspace(-g.half_width_m,g.half_width_m,int(np.ceil(2*g.half_width_m/self.RESOLUTION))+1)
        local=np.array(np.meshgrid(xx,yy)).reshape(2,-1).T
        co=np.cos(sample[:,3]);si=np.sin(sample[:,3])
        xy=sample[:,None,1:3]+np.stack((co[:,None]*local[None,:,0]-si[:,None]*local[None,:,1],
            si[:,None]*local[None,:,0]+co[:,None]*local[None,:,1]),axis=2)
        xy=xy.reshape(-1,2);inside=np.all(np.abs(xy)<=self.LIMIT,axis=1);idx=self.indices(xy)
        # The occupied ego body is known; its unobserved voxel fringe is not.
        # This matters for very short reverse commands below grid resolution.
        in_body=(xy[:,0]<=g.front_m+1e-8)&(xy[:,0]>=-g.rear_m-1e-8)&(np.abs(xy[:,1])<=g.half_width_m+1e-8)
        # A real body edge can round to a voxel whose centre is outside the
        # body. The exact stationary body remains known in that case; external
        # movement still needs measured free evidence beyond its true boundary.
        known=inside&(self.free[idx[:,0],idx[:,1]]|in_body)
        known&=~self.own_cells[idx[:,0],idx[:,1]]|in_body|self.measured_free[idx[:,0],idx[:,1]]
        blocked=~inside|(self.occupied[idx[:,0],idx[:,1]]&~in_body)
        return known.reshape(len(sample),-1), blocked.reshape(len(sample),-1)

    def certificate(self,path):
        path=np.asarray(path);sample=path[np.unique(np.r_[np.arange(0,len(path),2),len(path)-1])]
        known,blocked=self._footprint_status(sample)
        return {'verified':bool(known.all() and not blocked.any()),'known_percent':float(100*known.mean()),
            'occupied':bool(blocked.any()),'source':'MEASURED_CALIBRATED_RAYS_AND_GROUND','unknown_cells':int((~known).sum()),
            'ground_plane':self.ground_plane.tolist(),'ground_support':self.ground_support}

    def continuous_coverage(self,path):
        """Distance before the first unverified complete body footprint.

        A far ground return never bridges a disconnected near corridor. Inspect
        all intermediate poses; a later observed island cannot resume coverage.
        """
        path=np.asarray(path,float)
        if not len(path):return 0.
        distance=np.r_[0.,np.cumsum(np.linalg.norm(np.diff(path[:,1:3],axis=0),axis=1))]
        # Check every original pose, including rear/body edges. Batch geometry
        # avoids dozens of tiny numpy calls; no unknown slice is skipped.
        known,blocked=self._footprint_status(path)
        failed=np.flatnonzero(~known.all(axis=1)|blocked.any(axis=1))
        end=int(failed[0])-1 if len(failed) else len(path)-1
        return float(distance[end]) if end>=0 else 0.


def spatial_route(offset,road,distance):
    distance=np.asarray(distance,float)
    line=np.asarray(road.get('centerline',[[0.,0.],[50.,0.]]),float)
    if len(line)<2 or line.shape[1]!=2 or not np.isfinite(line).all():raise ValueError('Invalid local road centerline')
    lengths=np.linalg.norm(np.diff(line,axis=0),axis=1);arc=np.r_[0.,np.cumsum(lengths)]
    keep=np.r_[True,np.diff(arc)>1e-5];line=line[keep];arc=arc[keep]
    if len(line)<2:raise ValueError('Degenerate local road centerline')
    xy=np.column_stack([np.interp(distance,arc,line[:,i]) for i in (0,1)])
    tangent=np.gradient(xy,axis=0);heading=np.unwrap(np.arctan2(tangent[:,1],tangent[:,0]))
    # A lane transition is a spatial curve, not a lateral animation on a timer.
    # At creep speed a timed 3.5 m shift could rotate the body toward the curb
    # while it had advanced only centimetres. Bound curvature by spreading the
    # remaining lateral displacement over sufficient actual forward travel.
    transition=max(8.,abs(offset+line[0,1])*3.)
    u=np.clip(distance/transition,0.,1.);blend=10*u**3-15*u**4+6*u**5
    displacement=-line[0,1]+(offset+line[0,1])*blend
    xy+=displacement[:,None]*np.column_stack((-np.sin(heading),np.cos(heading)))
    xy-=xy[0]
    delta=np.gradient(xy,axis=0);yaw=np.unwrap(np.arctan2(delta[:,1],delta[:,0]))
    return np.column_stack((distance,xy,yaw))


def route_path(speed,acceleration,offset,road,geometry,cap):
    v=np.clip(speed+acceleration*GRID,0.,max(speed,cap))
    distance=np.r_[0.,np.cumsum((v[:-1]+v[1:])*.05)]
    curve=spatial_route(offset,road,distance);xy=curve[:,1:3];yaw=curve[:,3]
    if speed<.1 and acceleration<=0:xy[:]=0.;yaw[:]=0.
    return np.column_stack((GRID,xy,yaw)),v


def stationary_route_blocker(tracks,path,geometry,lookahead):
    """Reject a known blocked escape corridor beyond the short control lease.

    This is only a negative geometric screen. Absence of a track never certifies
    free space; fresh body/stopping/dynamic admission is still required.
    """
    from .motion_geometry import path_coordinates
    for track in tracks:
        if not track.get('confirmed') or track.get('occlusion_s',0)>.1 or np.linalg.norm(track['velocity_mps'])>=.75:continue
        x,y=track['position_m'];hx,hy=track['half_size_m']
        if x+hx<0:continue
        along,lateral=path_coordinates([x],[y],path)
        if along[0]-hx<lookahead and lateral[0]<geometry.half_width_m+hy+.25:
            return track['id']
    return None


class ManeuverValidator:
    def validate(self,path,speeds,space,road,geometry,*,lateral=False,acceleration=False):
        delta=np.diff(path[:,1:3],axis=0);ds=np.linalg.norm(delta,axis=1)
        curvature=np.divide(np.diff(path[:,3]),ds,out=np.zeros_like(ds),where=ds>.05)
        lat=np.abs(curvature)*speeds[1:]**2
        if np.max(lat)>2.05:return False,'LATERAL_ACCELERATION_LIMIT',None
        if np.max(np.abs(np.arctan(curvature*geometry.wheelbase_m)))>geometry.max_steer_rad+.01:return False,'STEERING_LIMIT',None
        checked=path
        if acceleration:
            # Certify the complete stopping distance beyond the forecast horizon.
            extra=speeds[-1]**2/6.+geometry.front_m+2.
            distances=np.arange(.5,extra+.5,.5);last=path[-1]
            extension=np.column_stack((last[0]+distances/max(speeds[-1],.1),
                last[1]+distances*np.cos(last[3]),last[2]+distances*np.sin(last[3]),np.full(len(distances),last[3])))
            checked=np.vstack((path,extension))
        certificate=space.certificate(checked)
        if (lateral or acceleration) and not certificate['verified']:return False,'SURROUNDING_SPACE_UNKNOWN_OR_OCCUPIED',certificate
        if lateral and road.get('junction_ahead',True):return False,'JUNCTION_OR_UNKNOWN_LANE_PERMISSION',certificate
        return True,'VERIFIED_MANEUVER' if lateral or acceleration else 'FORWARD_RULE_GUARD_REQUIRED',certificate


class ManeuverPlanner:
    def __init__(self,geometry=None,*,lateral_accepted=False):
        self.geometry=geometry or VehicleGeometry();self.lateral_accepted=lateral_accepted
        self.phase='FOLLOW';self.offset=0.;self.blocker=None;self.started=None;self.last=None
        self.validator=ManeuverValidator()
        self.cached=None
        self.previous_control=None

    def reset(self):self.phase='FOLLOW';self.offset=0.;self.blocker=None;self.last=None;self.started=None;self.cached=None;self.previous_control=None

    def evaluate(self,observation,base,prediction,points,road,cap_mps,*,wall=None):
        began=time.perf_counter();wall=time.monotonic() if wall is None else wall
        if getattr(self,'lateral_deadline',None) is not None and wall>=self.lateral_deadline:self.lateral_accepted=False
        g=self.geometry;speed=observation.ego.speed_mps
        result={'version':1,'experimental':True,'phase':self.phase,'action':'HOLD',
            'reason':'FRESH_MOTION_REQUIRED','source_frame':observation.frame_id,'timestamp_s':observation.timestamp_s,
            'selected_path':None,'rejected':[],'learned_control_used':False}
        if (not prediction or prediction.get('session_id')!=road.get('session_id') or
            not 0<=observation.timestamp_s-prediction['timestamp_s']<=.1+1e-6 or
            wall-prediction.get('published_wall_s',0)>.25):
            self.last=result;return replace(base,throttle=0.,brake=1.),result
        # A traffic rule always takes priority over risk-reducing acceleration.
        if road.get('traffic_stop'):
            result.update(action='RULE_STOP',reason=road['traffic_stop']);self.last=result
            return replace(base,throttle=0.,brake=1.),result
        if self.cached and 0<observation.timestamp_s-self.cached[0].timestamp_s<.1-1e-6:
            old,command,status=self.cached;dt=observation.timestamp_s-old.timestamp_s
            yaw=(old.ego.angular_velocity_radps[2]+observation.ego.angular_velocity_radps[2])*.5*dt
            distance=(speed+old.ego.speed_mps)*.5*dt;co,si=np.cos(yaw),np.sin(yaw)
            updated={**status,'source_frame':observation.frame_id,'timestamp_s':observation.timestamp_s,'planning_reused':True}
            if status.get('selected_path'):
                path=np.asarray(status['selected_path']).copy()
                path[:,1:3]=(path[:,1:3]-[distance*np.cos(yaw/2),distance*np.sin(yaw/2)])@np.array([[co,-si],[si,co]])
                path[:,3]-=yaw;updated['selected_path']=path.tolist()
            self.last=updated
            return replace(command,frame_id=base.frame_id,timestamp_s=base.timestamp_s),updated
        space=prediction.get('_observed_space') or ObservedSpace(points,g);tracks=prediction['tracks']
        modes=prediction.get('control_trajectories',prediction.get('measured_trajectories',prediction['trajectories']))
        rear=[];front=[]
        for tr in tracks:
            if not tr['confirmed']:continue
            x,y=tr['position_m'];vx,vy=tr['velocity_mps'];hx,hy=tr['half_size_m']
            if abs(y)>g.half_width_m+hy+.4:continue
            if x<0:
                gap=max(0.,-x-hx-g.rear_m);closing=vx-speed
                rear.append((gap/closing if closing>.25 else None,gap,tr))
            else:front.append((max(0.,x-hx-g.front_m),tr))
        rear_ttc=min((a for a,_,_ in rear if a is not None),default=None)
        front_gap=min((a for a,_ in front),default=None)
        result.update(front_gap_m=front_gap,rear_gap_m=min((a for _,a,_ in rear),default=None),rear_ttc_s=rear_ttc)
        line=np.asarray(road.get('centerline',[[0.,0.],[50.,0.]]));center_y=float(line[0,1])
        if self.phase=='EXIT' and abs(center_y+self.offset)<.35:self.phase='PASS'
        if self.phase=='PASS':
            blocker=next((t for t in tracks if t['id']==self.blocker),None)
            passed=blocker is not None and blocker['position_m'][0]+blocker['half_size_m'][0]<-g.rear_m-1.
            if passed and not road.get('junction_ahead',True):self.phase='RETURN'
        if self.phase=='RETURN' and abs(center_y)<.3:self.reset()
        target_offset=0. if self.phase in ('FOLLOW','RETURN') else self.offset
        preferred_accel=min(2.,max(-3.,(cap_mps-speed)*.8))
        if rear_ttc is not None and rear_ttc<2.5:preferred_accel=min(0.,preferred_accel)
        candidates=[('CONTINUE',target_offset,preferred_accel),('SLOW',target_offset,-1.5),('BRAKE',target_offset,-3.)]
        if rear_ttc is not None and rear_ttc<2.5 and speed<cap_mps-.2:candidates.append(('ACCELERATE',target_offset,2.))
        if self.phase=='FOLLOW':
            candidates += [('OFFSET_LEFT',-.35,preferred_accel),('OFFSET_RIGHT',.35,preferred_accel)] if front_gap is not None else []
            if front_gap is not None and front_gap<max(12.,speed*2.):
                for side,offset in (('left',-road.get('lane_width_m',3.5)),('right',road.get('lane_width_m',3.5))):
                    if road.get(side+'_allowed'):candidates.append(('CHANGE_'+side.upper(),offset,max(.5,preferred_accel)))
        accepted=[]
        for name,offset,accel in candidates:
            lateral=abs(offset+center_y)>.25
            if name.startswith('OFFSET') and abs(offset)+g.half_width_m+.2>road.get('lane_width_m',3.5)/2:
                result['rejected'].append({'action':name,'reason':'LANE_TOO_NARROW'});continue
            path,vel=route_path(speed,accel,offset,road,g,cap_mps)
            ok,reason,certificate=self.validator.validate(path,vel,space,road,g,lateral=lateral,acceleration=name=='ACCELERATE')
            conflicts=assess_conflicts(tracks,modes,[{'intent':name,'points':footprint_centers(path,g),'half':g.half}])
            conflicts=[c for c in conflicts if not c.get('separating_rear_overlap')]
            indexed={t['id']:t for t in tracks}
            rear_conflicts=[];forward_conflicts=[]
            for c in conflicts:
                tr=indexed[c['track_id']];trajectory=np.asarray(c['trajectory'])
                target_x=np.interp(GRID,trajectory[:,0],trajectory[:,1])
                if tr['position_m'][0]<-g.rear_m and np.all(target_x-path[:,1]<0):rear_conflicts.append(c)
                else:forward_conflicts.append(c)
            conflicts=forward_conflicts
            if lateral and not self.lateral_accepted:ok=False;reason='LATERAL_NATIVE_ACCEPTANCE_PENDING'
            if not ok:
                result['rejected'].append({'action':name,'reason':reason,'space':certificate});continue
            # A feasible collision-free path beats progress. No averaging of modes.
            risk=sum(1.+2./(.2+c['time_s']) for c in conflicts+rear_conflicts)
            progress=float(path[-1,1]);cost=risk*1000.-progress+.8*abs(offset)+.15*abs(accel)
            if name=='ACCELERATE' and rear_ttc is not None:cost-=5.
            if self.phase!='FOLLOW' and name=='CONTINUE':cost-=2.
            accepted.append((cost,name,path,vel,certificate,conflicts,accel,offset,rear_conflicts))
        if not accepted:
            result.update(action='BRAKE',reason='NO_ADMITTED_PATH',phase=self.phase)
            # Hold the currently occupied lane when a return is not verified.
            steer=observation.ego.steering if self.phase!='FOLLOW' else base.steering
            self.last=result;return replace(base,throttle=0.,brake=1.,steering=steer),result
        _,name,path,vel,certificate,conflicts,accel,offset,rear_conflicts=min(accepted,key=lambda c:c[0])
        if conflicts:
            # A front collision cannot justify fleeing into another front hazard.
            name='BRAKE';accel=-3.;path,vel=route_path(speed,accel,target_offset,road,g,cap_mps)
            conflicts=assess_conflicts(tracks,modes,[{'intent':name,'points':footprint_centers(path,g),'half':g.half}])
        elif name.startswith('CHANGE_'):
            self.offset=offset;self.phase='EXIT';self.started=observation.timestamp_s
            self.blocker=min(front,key=lambda a:a[0])[1]['id'] if front else None
        look=max(3.,min(7.,speed*.7));distance=np.linalg.norm(path[:,1:3],axis=1)
        index=min(len(path)-1,int(np.searchsorted(distance,look)))
        x,y=path[index,1:3];angle=math.atan2(2*g.wheelbase_m*y,max(.5,x*x+y*y))
        steer=float(np.clip(angle/g.max_steer_rad,observation.ego.steering-.15,observation.ego.steering+.15))
        # Feedback on measured acceleration, with bounded pedal changes. The
        # independent emergency layer can exceed these comfort limits.
        previous=self.previous_control
        actual_accel=0. if previous is None else (speed-previous[0])/max(.05,observation.timestamp_s-previous[1])
        old_throttle=previous[2] if previous else min(.15,base.throttle)
        old_brake=previous[3] if previous else 0.
        if accel>=0:
            throttle=float(np.clip(old_throttle+np.clip(.02*(accel-actual_accel),-.04,.04),0.,.55));brake=0.
        else:
            throttle=0.;brake=float(np.clip(old_brake+np.clip(.02*(-accel+actual_accel),-.04,.04),0.,.6))
        if name=='BRAKE':throttle=0.;brake=max(brake,.08)
        self.previous_control=(speed,observation.timestamp_s,throttle,brake)
        if abs(offset+center_y)<.25 and self.phase=='FOLLOW':steer=base.steering
        command=replace(base,throttle=throttle,brake=brake,steering=steer,source=CommandSource.NAVIGATION)
        result.update(action=name,phase=self.phase,reason='PREDICTED_OVERLAP_PROTECTIVE_BRAKE' if conflicts else
            'REAR_APPROACH_CLEAR_FORWARD_ESCAPE' if name=='ACCELERATE' else 'LOWEST_RISK_ADMITTED_PATH',
            selected_path=path.tolist(),target_speed_kmh=float(vel[-1]*3.6),
            predicted_conflicts=conflicts,rear_conflicts=rear_conflicts,space=certificate,planning_ms=(time.perf_counter()-began)*1000,
            selected_offset_m=float(offset),front_ttc_s=min((c['time_s'] for c in conflicts if c['point_m'][0]>0),default=None))
        result['object_assessments']=object_assessments(tracks,modes,path,g,conflicts)
        result['planning_ms']=(time.perf_counter()-began)*1000
        self.last=result
        self.cached=(observation,command,result)
        return command,result
