"""Measured-response longitudinal shaping before the final safety veto.

This controller is experimental until native comfort gates pass. It follows
the route target; it cannot reduce a hazard or traffic-signal brake request.
"""
from dataclasses import replace


class ComfortControl:
    def __init__(self):self.stamp=None;self.acceleration=0.

    def apply(self,command,vehicle,target_mps,*,hazard=False):
        stamp=command.timestamp_s
        dt=.05 if self.stamp is None else max(.001,min(.1,stamp-self.stamp))
        self.stamp=stamp
        if hazard or command.reverse:
            self.acceleration=0.
            return command
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
