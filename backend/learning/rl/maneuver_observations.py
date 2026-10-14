"""Two seconds of measured history; no scenario identities or actor truth."""
from collections import deque
import numpy as np
from ...core.maneuver_candidates import CANDIDATE_IDS,MODES

HISTORY=21
TRACKS=32
WIDTH=8+TRACKS*12


def observation_space():
    from gymnasium import spaces
    return spaces.Dict({'history':spaces.Box(-1.,1.,(HISTORY,WIDTH),np.float32),
                        'history_valid':spaces.Box(0.,1.,(HISTORY,),np.float32),
                        'mode':spaces.Box(0.,1.,(2,),np.float32),
                        'intent':spaces.Box(-1.,1.,(8,),np.float32),
                        'candidates':spaces.Box(-1.,1.,(len(CANDIDATE_IDS),8),np.float32),
                        'occupancy':spaces.Box(0.,1.,(3,20,20),np.float32)})


class ManeuverObservationEncoder:
    def __init__(self):self.history=deque(maxlen=64)
    def clear(self):self.history.clear()

    def append(self,scene,bundle,base,road):
        stamp=scene.observation.timestamp_s;ego=scene.observation.ego
        if self.history and stamp<=self.history[-1][0]:raise ValueError('Policy history must advance')
        if self.history and stamp-self.history[-1][0]>.15:self.history.clear()
        row=np.zeros(WIDTH,np.float32)
        from ...core.ego_motion import signed_speed
        row[:8]=[signed_speed(ego)/15.,ego.steering,ego.throttle,ego.brake,
                 float(ego.reverse),ego.angular_velocity_radps[2]/2.,float(ego.handbrake),ego.gear/6.]
        tracks=sorted(scene.prediction['tracks'],key=lambda t:np.linalg.norm(t['position_m']))[:TRACKS]
        samples={}
        for i,tr in enumerate(scene.prediction['tracks']):
            kind=tr['class'].upper()
            samples[tr['id']]=np.clip(np.array([*np.asarray(tr['position_m'])/50.,
                *np.asarray(tr['velocity_mps'])/20.,*np.asarray(tr['half_size_m'])/5.,
                tr['uncertainty_m']/5.,tr.get('occlusion_s',0.),float(tr['confirmed']),
                float(kind in ('PERSON','PEDESTRIAN')),float(kind in ('BICYCLE','MOTORCYCLE','CYCLIST')),float(kind=='UNKNOWN')],np.float32),-1.,1.)
        self.history.append((stamp,np.clip(row[:8],-1.,1.),samples))
        history=np.zeros((HISTORY,WIDTH),np.float32);valid=np.zeros(HISTORY,np.float32)
        available=list(self.history)
        for i,wanted in enumerate(stamp-np.arange(HISTORY-1,-1,-1)*.1):
            sample=min(available,key=lambda x:abs(x[0]-wanted))
            if abs(sample[0]-wanted)<=.051:
                history[i,:8]=sample[1];valid[i]=1.
                # Reindex every past row by this snapshot's measured track IDs.
                # Near-distance order changes cannot mix two actors' histories.
                for slot,tr in enumerate(tracks):
                    old=sample[2].get(tr['id'])
                    if old is not None:history[i,8+slot*12:8+(slot+1)*12]=old
        line=np.asarray(road.get('centerline',[[0.,0.],[10.,0.]]))
        goal=line[min(len(line)-1,5)]
        intent=np.array([base.steering,base.throttle,base.brake,float(base.reverse),
                         goal[0]/50.,goal[1]/50.,float(bool(road.get('traffic_stop'))),
                         float(road.get('junction_ahead',True))],np.float32)
        candidate_features=np.zeros((len(CANDIDATE_IDS),8),np.float32)
        for i,c in enumerate(bundle.candidates):
            end=c['path'][-1];command=c['command']
            candidate_features[i]=[end[1]/50.,end[2]/50.,end[3]/3.14,
                                   command['steering'],command['throttle'],command['brake'],
                                   float(command['reverse']),float(c['admitted'])]
        # Distinguish occupied/free/unknown. Never fill unknown with road truth.
        scene.space.certificate(np.array([[0.,0.,0.,0.]]))
        space=scene.space._map
        coordinates=np.linspace(-10.,9.,20)
        xy=np.stack(np.meshgrid(coordinates,coordinates,indexing='ij'),axis=-1)
        idx=space.indices(xy)
        free=space.free[idx[:,:,0],idx[:,:,1]];occupied=space.occupied[idx[:,:,0],idx[:,:,1]]
        occupancy=np.stack((free,occupied,~(free|occupied))).astype(np.float32)
        return {'history':history,'history_valid':valid,'mode':np.eye(2,dtype=np.float32)[MODES.index(bundle.mode)],
                'intent':np.clip(intent,-1.,1.),'candidates':np.clip(candidate_features,-1.,1.),'occupancy':occupancy}
