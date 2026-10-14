"""Bounded native execution/settling state for each repositioning action."""


class RepositionLease:
    def __init__(self):self.reset()
    def reset(self):
        self.action=None;self.started=None;self.distance=0.;self.phase='READY';self.cooldown_until=0.

    def allow(self,action,ego,timestamp_s):
        bounded=action.startswith('REVERSE') or action in ('FORWARD_LEFT','FORWARD_RIGHT')
        if self.phase=='SETTLING':
            if ego.speed_mps>=.15 or ego.reverse:return False,'SETTLE_BEFORE_REPLAN'
            self.reset();self.cooldown_until=timestamp_s+2.
            return False,'REPLAN_REQUIRED'
        stop_margin=ego.speed_mps*.35+ego.speed_mps**2/6.+.1
        if self.action and (self.distance+stop_margin>=2. or
                timestamp_s-self.started+.35+ego.speed_mps/3.>=4. or ego.speed_mps>1.):
            self.phase='SETTLING';return False,'REPOSITION_LEASE_EXHAUSTED'
        if not bounded:
            if self.action and ego.reverse:
                self.phase='SETTLING';return False,'SETTLE_BEFORE_FORWARD_GEAR'
            cooldown=self.cooldown_until;self.reset();self.cooldown_until=cooldown
            return True,'ORDINARY_MOTION'
        if timestamp_s<self.cooldown_until:return False,'REPOSITION_COOLDOWN'
        if self.action!=action:
            if self.action and ego.speed_mps>=.15:
                self.phase='SETTLING';return False,'SETTLE_BEFORE_INTENT_CHANGE'
            self.action=action;self.started=timestamp_s;self.distance=0.;self.phase='EXECUTING'
        return True,'BOUNDED_REPOSITION'

    def observe(self,distance_m):
        if self.action:self.distance+=max(0.,distance_m)
