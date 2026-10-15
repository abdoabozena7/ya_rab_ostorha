"""Evaluator-only physical fixtures for hybrid validation, never control input."""
import math
from .pilot_world import PilotWorld,SUPPORTED

ALIASES={'PEDESTRIAN':'PEDESTRIAN_CROSSING','PARALLEL':'PARALLEL_TRAFFIC',
         'DENSE_TRAFFIC':'MIXED_TRAFFIC','PASS_RETURN':'FRONT_OBSTACLE',
         'LANE_CHANGE':'FRONT_OBSTACLE','REVERSE':'BLOCKED_REVERSE',
         'OCCUPIED_LANE':'FRONT_OBSTACLE','OCCLUDED_PEDESTRIAN':'PEDESTRIAN_CROSSING',
         'ALTERNATE_ROUTE':'FRONT_OBSTACLE'}


class HybridWorld(PilotWorld):
    def setup(self,kind,seed,**kwargs):
        self.requested_kind=kind;self.occluder=None
        result=super().setup(ALIASES.get(kind,kind),seed,**kwargs)
        result['hybrid_scenario']=kind
        if kind in ('REVERSE','OCCUPIED_LANE'):
            self._spawn(5. if kind=='REVERSE' else 18.,-3.5)
        if kind=='ALTERNATE_ROUTE':
            self._spawn(18.,-3.5)
        if kind=='OCCLUDED_PEDESTRIAN':
            self.occluder=self._spawn(10.,3.)
            result['occlusion_measurement']='Native vehicle box blocks the initial ego-to-pedestrian ray; crossing must physically occur'
        return result

    def begin(self,timestamp_s):
        super().begin(timestamp_s)
        if self.occluder:
            person=next(a for a in self.actors if a.type_id.startswith('walker.'))
            # Independent native geometry checks construction only. Neither
            # this label nor its future crossing schedule enters a sensor scene.
            origin=self.p.ego.actor.get_transform().location
            target=person.get_location();box=self.occluder.bounding_box
            pose=self.occluder.get_transform();right=pose.get_right_vector();forward=pose.get_forward_vector()
            ax,ay=origin.x-pose.location.x,origin.y-pose.location.y
            bx,by=target.x-origin.x,target.y-origin.y
            start=(ax*forward.x+ay*forward.y,ax*right.x+ay*right.y)
            direction=(bx*forward.x+by*forward.y,bx*right.x+by*right.y)
            low,high=0.,1.
            for p,v,half in zip(start,direction,(box.extent.x,box.extent.y)):
                if abs(v)<1e-6:
                    if abs(p)>half:high=-1.;break
                else:
                    a,b=sorted(((-half-p)/v,(half-p)/v));low=max(low,a);high=min(high,b)
            self.manifest['initial_occlusion_verified']=0.<low<high<1.

    def validity(self):
        result=super().validity()
        if self.requested_kind=='OCCLUDED_PEDESTRIAN':
            result['initial_occlusion_verified']=self.manifest.get('initial_occlusion_verified',False)
            result['valid'] &= result['initial_occlusion_verified']
        result['feasibility']='UNVERIFIED: no successful behavior is inferred from fixture construction'
        return result
