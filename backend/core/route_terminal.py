"""Shared goal approach for matched drivers; independent of obstacle handling."""
from .contracts import finite

STOP_SHORT_M = 2.5
APPROACH_TIME_S = 2.


def terminal_speed_mps(remaining_m):
    # Stay inside the existing five-metre arrival radius. The planner's last
    # waypoint is removed only one metre away, too late to start braking at 50.
    return max(0.,(finite(remaining_m,'remaining route distance')-STOP_SHORT_M)/APPROACH_TIME_S)
