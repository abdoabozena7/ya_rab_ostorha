"""Pilot reward hypotheses. Physical truth stays on the reward/evaluation side."""
import math


def driver_controls_changed(desired,applied):
    """Compare physical controls; candidate IDs and source frames are provenance."""
    return (any(abs(applied[k]-desired[k])>1e-5 for k in ('throttle','brake','steering')) or
            any(applied[k]!=desired[k] for k in ('gear','reverse','handbrake')))


class ManeuverReward:
    def __init__(self,route_length):
        if not math.isfinite(route_length) or route_length<=0:raise ValueError('Route length required')
        self.route_length=route_length;self.previous_progress=0.;self.positive=0.;self.completed=False

    def evaluate(self,*,progress_m,dt,collision=None,completed=False,risk=0.,
                 discomfort=0.,unnecessary_manual_intervention=False):
        if not all(math.isfinite(v) for v in (progress_m,dt,risk,discomfort)) or dt<=0:
            raise ValueError('Finite independent reward measurements required')
        progress=max(-self.route_length,min(self.route_length,progress_m))
        components={'progress':10.*(progress-self.previous_progress)/self.route_length,
                    'completion':20. if completed and not self.completed else 0.,
                    'near_miss':-10.*max(0.,min(1.,risk))*dt,'time':-.02*dt,
                    'discomfort':-.1*max(0.,min(1.,discomfort))*dt,
                    'manual_intervention':-.5*dt if unnecessary_manual_intervention else 0.,
                    'collision':-200. if collision=='VULNERABLE' else -100. if collision else 0.}
        self.previous_progress=progress;self.completed|=completed
        for key in ('progress','completion'):
            if components[key]>0:
                credited=min(components[key],max(0.,30.-self.positive))
                self.positive+=credited;components[key]=credited
        return sum(components.values()),components
