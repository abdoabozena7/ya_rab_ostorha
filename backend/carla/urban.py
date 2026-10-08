"""Seeded NPC behavior, independent of the future ego safety policy.

TM retains collision checks and full physics. Lane-change probabilities apply
per simulation step, so deliberately small values avoid continuous weaving.
"""
from dataclasses import dataclass, asdict
import random


@dataclass(frozen=True)
class DriverProfile:
    name: str
    following_distance_m: float
    speed_offset_percent: float
    lane_change_percent: float
    light_violation_percent: float
    sign_violation_percent: float


PROFILES = {
    'NORMAL': DriverProfile('NORMAL', 3.5, 5., 0., 0., 0.),
    'BUSY': DriverProfile('BUSY', 2., 0., .08, 0., 0.),
    'AGGRESSIVE': DriverProfile('AGGRESSIVE', 1.2, -8., .18, 5., 2.),
    'UNREGULATED': DriverProfile('UNREGULATED', 1.5, -3., .12, 20., 10.),
}
MIXTURES = {
    'NORMAL': (100, 0, 0, 0),
    'BUSY': (25, 60, 15, 0),
    'AGGRESSIVE': (15, 30, 45, 10),
    'UNREGULATED': (15, 30, 25, 30),
}
WORLD_PROFILES = {
    'VISUAL_DEMO': {'vehicle_count': 40, 'pedestrian_count': 30},
    'TRAINING_DEVELOPMENT': {'vehicle_count': 25, 'pedestrian_count': 20},
    'EVALUATION': {'vehicle_count': 25, 'pedestrian_count': 20},
}
REQUIRED_TM_METHODS = ('distance_to_leading_vehicle', 'vehicle_percentage_speed_difference',
                       'random_left_lanechange_percentage', 'random_right_lanechange_percentage',
                       'auto_lane_change', 'ignore_lights_percentage', 'ignore_signs_percentage',
                       'ignore_walkers_percentage', 'ignore_vehicles_percentage')


def sample_driver(seed, ordinal, behavior, speed_difference, compliance):
    """Stable per owned actor; seeds do not depend on native actor IDs."""
    rng = random.Random(f'{seed}:{ordinal}:driver')
    name = rng.choices(tuple(PROFILES), weights=MIXTURES[behavior], k=1)[0]
    profile = asdict(PROFILES[name])
    profile['speed_difference_percent'] = max(-10., min(60.,
        speed_difference + profile.pop('speed_offset_percent') + rng.uniform(-4., 4.)))
    profile['following_distance_m'] *= rng.uniform(.9, 1.1)
    profile['light_violation_percent'] = min(profile['light_violation_percent'], 100.-compliance)
    return profile


def apply_driver(tm, actor, profile):
    missing = [name for name in REQUIRED_TM_METHODS if not callable(getattr(tm, name, None))]
    if missing:
        raise RuntimeError('Installed TM lacks required urban methods: '+', '.join(missing))
    tm.distance_to_leading_vehicle(actor, profile['following_distance_m'])
    tm.vehicle_percentage_speed_difference(actor, profile['speed_difference_percent'])
    tm.auto_lane_change(actor, profile['lane_change_percent'] > 0)
    tm.random_left_lanechange_percentage(actor, profile['lane_change_percent'])
    tm.random_right_lanechange_percentage(actor, profile['lane_change_percent'])
    tm.ignore_lights_percentage(actor, profile['light_violation_percent'])
    tm.ignore_signs_percentage(actor, profile['sign_violation_percent'])
    tm.ignore_vehicles_percentage(actor, 0.)
    tm.ignore_walkers_percentage(actor, 0.)
    tm.update_vehicle_lights(actor, True)
