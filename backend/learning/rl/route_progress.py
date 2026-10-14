"""Continuous signed progress on a frozen route, used only by reward/evaluation."""
import numpy as np


class FrozenRouteProgress:
    def __init__(self,points,initial_position):
        line=np.asarray(points,float)[:,:2].copy()
        keep=np.r_[True,np.linalg.norm(np.diff(line,axis=0),axis=1)>1e-6];line=line[keep]
        if len(line)<2 or not np.isfinite(line).all():raise ValueError('A finite ordered route is required')
        self.line=line;self.delta=np.diff(line,axis=0);self.length=np.linalg.norm(self.delta,axis=1)
        self.arc=np.r_[0.,np.cumsum(self.length)];self.start=self._project(initial_position)
        self.route_length=float(self.arc[-1]-self.start)
        if self.route_length<1.:raise ValueError('Frozen route has insufficient remaining journey length')
        for value in (self.line,self.delta,self.length,self.arc):value.flags.writeable=False

    def _project(self,position):
        xy=np.asarray(position,float)[:2]
        if not np.isfinite(xy).all():raise ValueError('Finite independent ego position required')
        fractions=np.sum((xy-self.line[:-1])*self.delta,axis=1)/(self.length**2)
        clipped=np.clip(fractions,0.,1.);projected=self.line[:-1]+clipped[:,None]*self.delta
        index=int(np.argmin(np.linalg.norm(projected-xy,axis=1)))
        fraction=fractions[index] if index==0 and fractions[index]<0 else clipped[index]
        return float(self.arc[index]+fraction*self.length[index])

    def measure(self,position):return self._project(position)-self.start
