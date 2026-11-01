"""Bounded code-only calibration, no route policy or human-data recording."""
import time
from .provider import guarded_command, forward_clearance


class FoundationCalibration:
    def __init__(self):
        self.started = None
        self.phase = 'WAIT_SENSORS'
        self.latest = {}

    def step(self, observation, geometry, now):
        if self.started is None and observation['connected'] and observation['depth_valid'] and observation['front']['known']:
            self.started = now
        elapsed = (now-self.started)/1000 if self.started is not None else 0.
        phases = [(0,5,'CAM_FRONT',10,0,0,1),(5,10,'CAM_LEFT',11,0,0,1),
                  (10,15,'CAM_RIGHT',12,0,0,1),(15,20,'CAM_REAR',13,0,0,1),
                  (20,30,'FORWARD',1,0,.3,0),(30,33,'STOP_FORWARD',1,0,0,1),
                  (33,43,'REVERSE',2,0,.3,0),(43,46,'STOP_REVERSE',1,0,0,1),
                  (46,53,'LEFT',1,-.3,.3,0),(53,56,'STOP_LEFT',1,0,0,1),
                  (56,63,'RIGHT',1,.3,.3,0),(63,66,'STOP_RIGHT',1,0,0,1),
                  (66,70,'LEASE_LOSS',1,0,.3,0),(70,74,'RECOVER',1,0,0,1),
                  (74,78,'CAPTURE_LOSS',1,0,.3,0),(78,100,'FINAL_STOP',1,0,0,1)]
        selected = next((p for p in phases if p[0] <= elapsed < p[1]), phases[-1])
        _,_,self.phase,kind,steer,throttle,brake = selected
        o = dict(observation)
        if kind == 2:
            rear = {'rays': [[(r[0]-180)%360,*r[1:]] for r in (geometry or {}).get('rays',[])]}
            o['front'] = forward_clearance(rear)
        intent = dict(expires_ms=now+150,source_host_ms=observation['capture_ms'],steering=steer,throttle=throttle,brake=brake)
        command = guarded_command(intent,o,now)
        if kind >= 10:
            command = dict(steering=0.,throttle=0.,brake=1.,reason=self.phase)
        command['packet_type'] = kind
        command['reverse'] = kind == 2
        self.latest = {'phase':self.phase,'elapsed_s':elapsed,'controller':'CODE_FOUNDATION_CALIBRATION',
                       'training':False,'human_recording':False,'command':command}
        return command
