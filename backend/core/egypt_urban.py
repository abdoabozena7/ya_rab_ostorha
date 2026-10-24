"""Scenario identity, measured evidence and source-bound native admission."""
import copy
import hashlib
import json
import math
from pathlib import Path
import time

ROOT = Path(__file__).resolve().parents[2]
SCENARIO_ID = 'EGYPT_URBAN_CHAOS_V1'
PROTOCOL = 'EGYPT_COMPLETE_DRIVERS_V1'
DRIVER_ID = 'ROBOSPHERE_URBAN_MANEUVER_V2'
CONFIG = ROOT / 'config' / 'egypt-urban-chaos-v1.json'
ACCEPTANCE = ROOT / 'docs' / 'evidence' / 'egypt-urban-chaos-v1' / 'acceptance.json'


def configuration():
    value = json.loads(CONFIG.read_text(encoding='utf8'))
    if (value['id'] != SCENARIO_ID or value['version'] != 1 or value['protocol'] != PROTOCOL
            or value['map'] != 'Town10HD_Opt' or value['maximum_speed_kmh'] != 60
            or not 600 <= value['route_minimum_m'] < value['route_maximum_m'] <= 800
            or len(set(value['holdout_seeds'])) != 3
            or set(value['holdout_seeds']) & set(value['development_seeds'])):
        raise ValueError('Invalid Egypt scenario contract or seed partition')
    return value


def source_fingerprint():
    configs = [p for p in sorted((ROOT / 'config').glob('*.json'))
               if p.name != 'dashboard-preferences.json' and not p.name.startswith('places-')]
    paths = [*configs, *sorted((ROOT / 'backend' / 'core').glob('*.py')),
             *sorted((ROOT / 'backend' / 'carla').glob('*.py')),
             *sorted((ROOT / 'backend' / 'computer_vision').glob('*.py')),
             ROOT / 'scripts' / 'native' / 'validate_egypt_urban.py',
             ROOT / 'scripts' / 'native' / 'validate_crossing_pair.py',
             ROOT / 'scripts' / 'validate_hybrid_native.py']
    hashes = {p.relative_to(ROOT).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest() for p in paths}
    return hashlib.sha256(json.dumps(hashes, sort_keys=True).encode()).hexdigest()


def acceptance_matrix(pairs, fingerprint):
    config = configuration()
    expected = {(seed, first) for seed in config['holdout_seeds'] for first in ('NORMAL', 'ROBOSPHERE')}
    keys = [(p.get('seed'), p.get('first_mode')) for p in pairs]
    gates = {
        'six_unique_pairs_twelve_trips': len(keys) == 6 and set(keys) == expected,
        'frozen_source': bool(fingerprint) and all(p.get('source_sha256') == fingerprint
                                                  and p.get('source_unchanged') is True for p in pairs),
        'all_attempts_retained': all(p.get('attempts_retained') is True for p in pairs),
        'all_pairs_accepted': len(pairs) == 6 and all(p.get('native_acceptance') is True for p in pairs),
        'reserved_seed_and_order_verified': len(pairs) == 6 and all(
            p.get('pair', {}).get('manifest', {}).get('comparison_scenario', {}).get('seed') == p.get('seed')
            and p.get('pair', {}).get('manifest', {}).get('seed_partition') == 'HOLDOUT'
            and p.get('pair', {}).get('order') == [p.get('first_mode'), 'ROBOSPHERE' if p.get('first_mode') == 'NORMAL' else 'NORMAL']
            and p.get('source') == 'LIVE_NATIVE_CARLA' for p in pairs),
        'all_driver_outcomes_recorded': all(set(p.get('pair', {}).get('runs', {})) == {'NORMAL', 'ROBOSPHERE'}
                                            and evaluate_pair(p['pair'])['passed'] for p in pairs)
    }
    return {'scenario_id': SCENARIO_ID, 'version': 1, 'source_sha256': fingerprint,
            'accepted': all(gates.values()), 'gates': gates, 'pairs': pairs}


def deployment_status():
    if not ACCEPTANCE.exists():
        return {'accepted': False, 'reason': 'Twelve source-bound native trips have not been accepted'}
    try:
        report = json.loads(ACCEPTANCE.read_text(encoding='utf8'))
        checked = acceptance_matrix(report['pairs'], source_fingerprint())
        accepted = report.get('accepted') is True and checked['accepted']
        return {'accepted': accepted, 'reason': 'Source-bound native acceptance verified' if accepted
                else 'Native acceptance is incomplete or belongs to different source'}
    except (OSError, ValueError, KeyError, TypeError) as error:
        return {'accepted': False, 'reason': 'Cannot verify Egypt native acceptance: ' + str(error)}


def admission(map_name, speed_kmh):
    config = configuration()
    if map_name.rsplit('/', 1)[-1] != config['map'] or type(speed_kmh) not in (int, float) or not 5 <= speed_kmh <= 60:
        raise ValueError('Egypt urban chaos requires Town10HD_Opt and a 5--60 km/h request')
    status = deployment_status()
    if status['accepted']:
        return {'accepted': True, 'deadline': float('inf'), 'reason': status['reason']}
    from ..learning.hybrid_budget import active_ticket
    from ..learning.native_validation_budget import active_rule_ticket
    ticket = active_ticket() or active_rule_ticket()
    if ticket is None or ticket['expires_monotonic_s'] <= time.monotonic():
        raise ValueError(status['reason'] + '; an existing live bounded validation reservation is required')
    return {'accepted': False, 'deadline': ticket['expires_monotonic_s'], 'reason': status['reason']}


def default_scenario():
    return SCENARIO_ID if deployment_status()['accepted'] else None


def scenario_catalog():
    from ..learning.hybrid_budget import active_ticket
    from ..learning.native_validation_budget import active_rule_ticket
    status = deployment_status()
    validation = active_ticket() is not None or active_rule_ticket() is not None
    legacy = 'SUDDEN_PEDESTRIAN_COMPARISON_V1'
    return {'default_id': SCENARIO_ID if status['accepted'] else legacy,
            'options': [{'id': legacy, 'version': 1, 'name': 'Historical crossing comparison',
                         'available': True, 'maximum_speed_kmh': 120},
                        {'id': SCENARIO_ID, 'version': 1, 'name': 'Egypt mixed urban journey',
                         'available': status['accepted'] or validation, 'native_accepted': status['accepted'],
                         'validation_window_active': validation, 'maximum_speed_kmh': 60,
                         'reason': status['reason']}]}


def event_realized(kind, measurements, persona=None):
    m = measurements
    if kind == 'STOP_GO':
        return m.get('approach_m', 0) >= 1 and m.get('stopped_s', 0) >= 1 and m.get('resumed_m', 0) >= 1
    if kind == 'DOUBLE_PARK':
        return m.get('stopped_s', 0) >= 4 and m.get('resumed_m', 0) >= 1
    if kind in ('CUT_IN', 'CHANGING_GAPS'):
        realized = (m.get('signal_s', 0) >= .8 and m.get('lane_entry_complete') is True
                    and m.get('lateral_m', 0) >= 2 and m.get('forward_m', 0) >= 3)
        return realized and (kind != 'CHANGING_GAPS' or m.get('gap_change_m', 0) >= 3)
    if kind == 'PEDESTRIAN_CROSSING':
        return (m.get('crossing_m', 0) >= 3 and m.get('road_observed') is True
                and m.get('sidewalk_reached') is True
                and (persona != 'HESITANT' or m.get('hesitated_s', 0) >= .6)
                and (persona != 'RETREATING' or m.get('retreated_m', 0) >= .6)
                and (persona != 'OCCLUDED' or m.get('occluded_observed') is True))
    if kind == 'OVERLAP':
        return m.get('both_realized') is True and m.get('overlap_s', 0) >= .2
    raise ValueError('Unknown Egypt event kind: ' + str(kind))


class EventLedger:
    """A request or elapsed timer cannot certify a physical event."""
    def __init__(self, plans):
        self.plans = copy.deepcopy(plans)
        self.events = {key: {'kind': p['kind'], 'persona': p.get('persona'), 'status': 'PENDING',
                             'realized': False, 'measurements': {}, 'transitions': []}
                       for key, p in plans.items()}

    def transition(self, key, phase, frame, stamp, *, reason=None, measurements=None):
        event = self.events[key]
        allowed = {'PENDING': ('REQUESTED', 'MISSED'), 'REQUESTED': ('EXECUTING', 'EXPIRED', 'ACTOR_LOST'),
                   'EXECUTING': ('EXECUTING', 'COMPLETED', 'EXPIRED', 'ACTOR_LOST')}
        if phase not in allowed.get(event['status'], ()):
            raise ValueError(f'Invalid event transition {event["status"]} -> {phase}')
        if measurements:
            event['measurements'].update(measurements)
        realized = event_realized(event['kind'], event['measurements'], event.get('persona'))
        if phase == 'COMPLETED' and not realized:
            raise ValueError('Physical realization is required before event completion')
        event.update(status=phase, realized=realized, reason=reason)
        if phase != 'EXECUTING' or not event['transitions'] or event['transitions'][-1]['phase'] != phase:
            event['transitions'].append({'phase': phase, 'frame_id': frame, 'timestamp_s': stamp, 'reason': reason})
        return event


def evaluate_pair(data):
    scenario = (data.get('manifest') or {}).get('comparison_scenario') or {}
    if scenario.get('protocol') != PROTOCOL:
        return {'protocol': PROTOCOL, 'passed': False, 'gates': {'egypt_scenario': False}}
    from .journey_comparison import matching_setup
    config = configuration()
    runs = data.get('runs', {})
    protected = runs.get('ROBOSPHERE', {})
    evidence = protected.get('scenario_evidence') or {}
    events = evidence.get('events') or {}
    verified_events = [e for e in events.values() if e.get('realized') and e.get('status') == 'COMPLETED'
                       and e.get('kind') in config['required_event_kinds']
                       and event_realized(e['kind'], e.get('measurements', {}), e.get('persona'))]
    realized = {e['kind'] for e in verified_events}
    maneuvers = protected.get('completed_maneuvers') or []
    overtakes = [m for m in maneuvers if isinstance(m, dict) and m.get('kind') == 'OVERTAKE'
                 and m.get('status') == 'COMPLETED' and m.get('measured_clearance') is True
                 and m.get('clearance_proof', {}).get('rear_clearance_m', 0.) > 2.
                 and m.get('completion_frame', -1) > m.get('clearance_proof', {}).get('frame_id', math.inf)
                 and (not m.get('return_required') or m.get('returned') is True
                      and m.get('return_proof', {}).get('body_inside_lane') is True
                      and m.get('return_proof', {}).get('frame_id') == m.get('completion_frame'))]
    setups = [runs.get(mode, {}).get('setup', {}) for mode in ('NORMAL', 'ROBOSPHERE')]
    ids = [s.get('initial_condition_id') for s in setups]
    maximum = protected.get('maximum_speed_kmh')
    separation = evidence.get('minimum_body_separation_m')
    gates = {
        'both_recorded': set(runs) == {'NORMAL', 'ROBOSPHERE'} and all(r.get('recording') for r in runs.values()),
        'protected_arrived_without_any_contact': protected.get('status') == 'ARRIVED'
            and protected.get('destination_reached') is True and protected.get('collisions') == 0
            and protected.get('contact_callbacks') == 0 and not protected.get('collision_events'),
        'contact_measurement_available_and_healthy': all(s.get('collision_measurement_available') is True
            and 'collision' in s.get('sensor_configuration', {}) for s in setups)
            and evidence.get('collision_measurement_healthy') is True,
        'matching_complete_driver_setup': matching_setup(*setups),
        'initial_conditions_verified': bool(ids[0]) and ids[0] == ids[1]
            and all(runs.get(m, {}).get('initial_condition_audit', {}).get('passed') is True
                    for m in ('NORMAL', 'ROBOSPHERE')),
        'same_scenario_seed_and_definition': bool(scenario.get('definition_sha256')) and all(
            s.get('comparison_scenario', {}).get('definition_sha256') == scenario['definition_sha256']
            and s.get('comparison_scenario', {}).get('seed') == scenario.get('seed') for s in setups),
        'full_route_verified': all(config['route_minimum_m'] <= s.get('route_length_m', 0) <= config['route_maximum_m']
                                   and s.get('comparison_scenario', {}).get('route_validation', {}).get('passed') is True
                                   for s in setups),
        'actual_event_diversity': set(config['required_event_kinds']) <= realized,
        'pedestrian_intent_and_occlusion_realized': {'OCCLUDED', 'HESITANT', 'RETREATING'} <= {
            e.get('persona') for e in verified_events if e.get('kind') == 'PEDESTRIAN_CROSSING'},
        'three_measured_complete_overtakes': len({m.get('id') for m in overtakes}) >= config['minimum_completed_overtakes'],
        'actual_density_and_motion': evidence.get('density_verified') is True and evidence.get('motion_verified') is True,
        'measured_speed_within_sixty': isinstance(maximum, (int, float)) and math.isfinite(maximum) and maximum <= 60
            and all(isinstance(r.get('maximum_speed_kmh'), (int, float)) and math.isfinite(r['maximum_speed_kmh'])
                    and r['maximum_speed_kmh'] <= 60 for r in runs.values())
            and all(5 <= s.get('speed_kmh', 0) <= 60 for s in setups) and setups[0].get('speed_kmh') == setups[1].get('speed_kmh'),
        'body_separation_measured': isinstance(separation, (int, float)) and math.isfinite(separation) and separation > 0,
        'timing_measured': isinstance(protected.get('simulation_wall_ratio'), (int, float))
            and protected['simulation_wall_ratio'] > 0 and protected.get('sensor_age_samples', 0) > 0,
        'new_driver_identified': protected.get('driver_id') == DRIVER_ID
    }
    return {'protocol': PROTOCOL, 'scenario_id': SCENARIO_ID, 'version': 1,
            'passed': all(gates.values()), 'gates': gates,
            'comparison_scope': 'COMPLETE_DRIVERS_MANEUVER_AND_PREDICTION_DIFFER',
            'normal_outcome': runs.get('NORMAL', {}).get('status'),
            'source': 'ACTUAL_CONTACTS_ARRIVAL_PHYSICAL_EVENTS_AND_MEASURED_MANEUVERS'}
