"""Measured-response longitudinal shaping before the final safety veto.

This controller is experimental until native comfort gates pass. It follows
the route target; it cannot reduce a hazard or traffic-signal brake request.
"""
from dataclasses import replace
import math


def measured_approach_target(command,vehicle,target_mps,status):
    if not status or status.get('enabled') is not True:return target_mps
    frame,stamp=status.get('frame_id'),status.get('timestamp_s')
    if (type(frame) is not int or type(stamp) not in (int,float) or not math.isfinite(stamp) or
            not 0<=command.frame_id-frame<=2 or not 0<=command.timestamp_s-stamp<=.1+1e-6):return target_mps
    distance=status.get('measured_range_m');coverage=status.get('observed_road_range_m')
    if any(type(value) not in (int,float) or not math.isfinite(value) or value<0
            for value in (distance,coverage)):return target_mps
    reserve=5.+abs(vehicle.speed_mps)*.75
    available=max(0.,min(distance,coverage)-reserve)
    return min(target_mps,math.sqrt(4.*available))


class ComfortControl:
    def __init__(self):
        self.stamp=None;self.acceleration=0.;self.status={}

    def apply(self,command,vehicle,target_mps,*,hazard=False,forward_status=None):
        stamp=command.timestamp_s
        dt=.05 if self.stamp is None else max(.001,min(.1,stamp-self.stamp))
        self.stamp=stamp
        self.status={'requested_target_mps':target_mps,'effective_target_mps':target_mps,
            'constraint':'PRIORITY_STOP' if hazard else 'ROUTE_TARGET','source_frame':None}
        if hazard or command.reverse:
            self.acceleration=0.
            return command
        approach=measured_approach_target(command,vehicle,target_mps,forward_status)
        if approach<target_mps:
            self.status.update(effective_target_mps=approach,constraint='MEASURED_APPROACH',
                source_frame=forward_status['frame_id'])
            target_mps=approach
        speed=abs(vehicle.speed_mps)
        desired=max(-2.5,min(1.5,.65*(target_mps-speed)))
        self.acceleration+=max(-2.*dt,min(2.*dt,desired-self.acceleration))
        measured=vehicle.longitudinal_acceleration_mps2
        # Use actual applied pedals across a shield intervention or handover,
        # avoiding a second accumulated actuator state that can wind up.
        effort=vehicle.throttle-vehicle.brake
        effort+=max(-.18*dt,min(.18*dt,.16*(self.acceleration-measured)*dt))
        if speed<.15 and vehicle.brake>.1:effort=0.
        if target_mps<.05 and speed<.15:return replace(command,throttle=0.,brake=.25)
        return replace(command,throttle=max(0.,min(.6,effort)),brake=max(0.,min(.5,-effort)))
