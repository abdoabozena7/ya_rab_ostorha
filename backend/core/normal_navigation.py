"""Bounded rear response for protected native route driving.

The route follower supplies steering, speed control and traffic-signal stops.
This layer uses only the already synchronized radar/LiDAR/depth assessment for
LiDAR surface motion for a rear approach. NORMAL bypasses this layer. It never
overrides a route stop, exceeds the selected speed, or assumes rear free space.
"""

from dataclasses import replace


def stopping_distance(speed_mps):
    speed = max(0., float(speed_mps))
    return 2.5 + .55 * speed + speed * speed / 7.


def rear_approach(status):
    return any(
        item.get('relation') == 'REAR_APPROACH'
        and item.get('matched_frames', 0) >= 5
        and isinstance(item.get('time_to_conflict_s'), (int, float))
        and 0 < item['time_to_conflict_s'] <= 2.
        for item in status.get('side_rear_observations', ()) or ()
    )


def sensor_navigation_command(command, status, *, frame_id, timestamp_s, speed_mps, target_speed_mps,
                              normal_mode, allow_rear_assist=True):
    """Return (command, reason, rear_assist) without changing steering or gear.

    NORMAL preserves the driver's command regardless of observer state.
    ROBOSPHERE keeps its independent RULE supervisor. A
    verified rear catch-up can only raise a low route throttle toward the
    existing target; it cannot release any forward/traffic/safety brake.
    """
    if normal_mode:
        return command, None, False
    status = status or {}
    if command.brake > .01 or command.handbrake or command.reverse:
        return command, None, False
    source_frame, source_time = status.get('frame_id'), status.get('timestamp_s')
    current = (isinstance(source_frame, int) and 0 <= frame_id-source_frame <= 3
               and isinstance(source_time, (int, float)) and 0 <= timestamp_s-source_time <= .15
               and status.get('risk') not in (None, 'UNKNOWN', 'UNKNOWN_SPACE'))
    if not current:
        return command, None, False

    distance = status.get('measured_range_m')
    road_range = status.get('observed_road_range_m')
    required = stopping_distance(speed_mps)
    clear_ahead = ((distance is None or distance > required + 5.)
                   and isinstance(road_range, (int, float)) and road_range >= max(8., required + 3.))
    if (allow_rear_assist and clear_ahead and rear_approach(status) and abs(command.steering) <= .2
            and speed_mps < target_speed_mps - 1.
            and command.throttle < .55):
        return replace(command, throttle=min(.75, max(.55, command.throttle))), None, True
    return command, None, False
