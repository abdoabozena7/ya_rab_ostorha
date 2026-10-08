"""Right-positive normalized steering, forward gear only; brakes win conflicts."""
from collections.abc import Mapping
import numpy as np
from ..core.contracts import ControlCommand, CommandSource

ACTION_LOW = np.array([-1.,0.,0.],np.float32)
ACTION_HIGH = np.ones(3,np.float32)


def normalize_action(action):
    if isinstance(action,Mapping):
        if set(action)!={'steering','throttle','brake'}:raise ValueError('Action requires steering/throttle/brake only')
        action=[action['steering'],action['throttle'],action['brake']]
    if isinstance(action,(list,tuple)) and any(isinstance(value,(bool,np.bool_)) for value in action):
        raise ValueError('Boolean action values are not actuator requests')
    a=np.asarray(action)
    if a.shape!=(3,) or a.dtype.kind not in 'fiu' or not np.isfinite(a).all():
        raise ValueError('Action must be three finite numeric values')
    proposed=a.astype(np.float64)
    clipped=np.clip(proposed,ACTION_LOW,ACTION_HIGH)
    if clipped[2]>0:clipped[1]=0.
    return proposed,clipped


def physical_command(action, frame, previous, fixed_delta, *, max_steering_rate=1.5):
    proposed,clipped=normalize_action(action)
    # Steering actuator rate bound, not a claim of hazard feasibility. Throttle
    # and brake remain normalized native actuator requests. No reverse/gear switch.
    clipped[0]=np.clip(clipped[0],previous[0]-max_steering_rate*fixed_delta,
                       previous[0]+max_steering_rate*fixed_delta)
    command=ControlCommand(frame.frame_id,frame.timestamp_s,float(clipped[1]),float(clipped[2]),
                           float(clipped[0]),False,False,CommandSource.TRAINING,1)
    return proposed,clipped,command
