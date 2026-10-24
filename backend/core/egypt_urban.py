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


def source_manifest():
    configs = [p for p in sorted((ROOT / 'config').glob('*.json'))
               if p.name != 'dashboard-preferences.json' and not p.name.startswith('places-')]
    paths = [*configs, *sorted((ROOT / 'backend').rglob('*.py')),
             ROOT / 'scripts' / 'native' / 'validate_egypt_urban.py',
             ROOT / 'scripts' / 'native' / 'validate_crossing_pair.py',
             ROOT / 'scripts' / 'validate_hybrid_native.py']
    return {p.relative_to(ROOT).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest() for p in paths}


def source_fingerprint():
    return hashlib.sha256(json.dumps(source_manifest(), sort_keys=True).encode()).hexdigest()


def evaluate_matrix(pairs, fingerprint, *, acceptance=True):
    config = configuration()
    seeds = config['holdout_seeds' if acceptance else 'development_seeds']
    expected = {(seed, first) for seed in seeds for first in ('NORMAL', 'ROBOSPHERE')}
    keys = [(p.get('seed'), p.get('first_mode')) for p in pairs]
    gates = {
        'six_unique_pairs_twelve_trips': len(keys) == 6 and set(keys) == expected,
        'frozen_source': bool(fingerprint) and all(p.get('source_sha256') == fingerprint
                                                  and p.get('source_unchanged') is True for p in pairs),
        'all_attempts_retained': all(p.get('attempts_retained') is True for p in pairs),
        'all_pairs_accepted': len(pairs) == 6 and all(p.get('native_acceptance') is True for p in pairs),
        'reserved_seed_and_order_verified': len(pairs) == 6 and all(
            p.get('pair', {}).get('manifest', {}).get('comparison_scenario', {}).get('seed') == p.get('seed')
            and p.get('pair', {}).get('manifest', {}).get('seed_partition') == ('HOLDOUT' if acceptance else 'DEVELOPMENT')
            and p.get('pair', {}).get('order') == [p.get('first_mode'), 'ROBOSPHERE' if p.get('first_mode') == 'NORMAL' else 'NORMAL']
            and p.get('source') == 'LIVE_NATIVE_CARLA' for p in pairs),
        'all_driver_outcomes_recorded': all(set(p.get('pair', {}).get('runs', {})) == {'NORMAL', 'ROBOSPHERE'}
                                            and evaluate_pair(p['pair'])['passed'] for p in pairs),
        'exports_playback_and_cleanup_verified': len(pairs) == 6 and all(
            all(p.get(key) is True for key in ('completed_without_shortening', 'finish_completed',
                'exports_closed', 'cleanup_confirmed', 'simulator_exit_confirmed'))
            and p.get('independent_cleanup_probe', {}).get('passed') is True
            and p.get('video_playback_after_exit', {}).get('passed') is True for p in pairs),
        'town10_low_profile_verified': len(pairs) == 6 and all(
            p.get('render_profile', {}).get('render_profile') == 'LOW'
            and all(run.get('setup', {}).get('map', '').rsplit('/', 1)[-1] == config['map']
                    for run in p.get('pair', {}).get('runs', {}).values()) for p in pairs)
    }
    return {'scenario_id': SCENARIO_ID, 'version': 1, 'source_sha256': fingerprint,
            'passed': all(gates.values()), 'accepted': acceptance and all(gates.values()),
            'partition': 'HOLDOUT' if acceptance else 'DEVELOPMENT', 'gates': gates, 'pairs': pairs}


def acceptance_matrix(pairs, fingerprint):
    return evaluate_matrix(pairs, fingerprint)


def publication_gates(report, fingerprint):
    from ..learning.egypt_budget import SCOPE, CAP_SECONDS, PHASE_SECONDS
    budget = report.get('budget_after', {})
    reservations = budget.get('reservations', [])
    acceptance = [row for row in reservations if row.get('phase') == 'ACCEPTANCE']
    development = report.get('development', {})
    return {
        'development_matrix_passed_before_freeze': development.get('source_sha256') == fingerprint
            and evaluate_matrix(development.get('pairs', []), fingerprint, acceptance=False)['passed'],
        'source_configuration_hashes_frozen': report.get('source_manifest') == source_manifest()
            and report.get('source_sha256') == fingerprint and report.get('source_unchanged') is True,
        'separate_allowance_and_cleanup_charged': budget.get('kind') == SCOPE
            and budget.get('cap_s') == CAP_SECONDS and budget.get('unfinished') == 0
            and len(acceptance) == 1 and acceptance[0].get('reserved_s') == PHASE_SECONDS
            and acceptance[0].get('outcome') == 'FINISHED'
            and type(acceptance[0].get('elapsed_s')) in (int, float)
            and 0 <= acceptance[0]['elapsed_s'] <= PHASE_SECONDS
            and all(type(row.get('charged_s')) in (int, float) and math.isfinite(row['charged_s'])
                    and row['charged_s'] >= 0 for row in reservations)
            and all(sum(row['charged_s'] for row in reservations if row.get('phase') == phase) <= PHASE_SECONDS
                    for phase in ('DEVELOPMENT', 'ACCEPTANCE'))
    }


def deployment_status():
    if not ACCEPTANCE.exists():
        return {'accepted': False, 'reason': 'Twelve source-bound native trips have not been accepted'}
    try:
        report = json.loads(ACCEPTANCE.read_text(encoding='utf8'))
        fingerprint = source_fingerprint()
        checked = acceptance_matrix(report['pairs'], fingerprint)
        gates = {**checked['gates'], **publication_gates(report, fingerprint)}
        accepted = report.get('accepted') is True and all(gates.values())
        return {'accepted': accepted, 'reason': 'Source-bound native acceptance verified' if accepted
                else 'Native acceptance is incomplete or belongs to different source',
                'failed_gates': [name for name, passed in gates.items() if not passed]}
    except (OSError, ValueError, KeyError, TypeError, AttributeError) as error:
        return {'accepted': False, 'reason': 'Cannot verify Egypt native acceptance: ' + str(error),
                'failed_gates': ['acceptance_artifact_readable']}


def admission(map_name, speed_kmh):
    from ..learning.egypt_budget import active_ticket as egypt_ticket, require_simulator_access
    require_simulator_access()
    config = configuration()
    if map_name.rsplit('/', 1)[-1] != config['map'] or type(speed_kmh) not in (int, float) or not 5 <= speed_kmh <= 60:
        raise ValueError('Egypt urban chaos requires Town10HD_Opt and a 5--60 km/h request')
    status = deployment_status()
    if status['accepted']:
        return {'accepted': True, 'deadline': float('inf'), 'reason': status['reason']}
    from ..learning.hybrid_budget import active_ticket
    from ..learning.native_validation_budget import active_rule_ticket
    ticket = egypt_ticket() or active_ticket() or active_rule_ticket()
    if ticket is None or ticket['expires_monotonic_s'] <= time.monotonic():
        raise ValueError(status['reason'] + '; an existing live bounded validation reservation is required')
    return {'accepted': False, 'deadline': ticket['expires_monotonic_s'], 'reason': status['reason']}


def default_scenario():
    return SCENARIO_ID if deployment_status()['accepted'] else None


def validation_status():
    from ..learning.egypt_budget import PROGRESS, ownership_status
    deployed = deployment_status()
    owner = ownership_status()
    progress = {}
    if PROGRESS.exists():
        try:
            progress = json.loads(PROGRESS.read_text(encoding='utf8'))
            if not isinstance(progress, dict):
                raise ValueError('Expected validation progress object')
        except (OSError, ValueError) as error:
            progress = {'state': 'FAILED', 'failed_gates': ['validation_progress_readable'], 'error': str(error)}
    state = 'ACCEPTED' if deployed['accepted'] else progress.get('state', 'PENDING')
    failed = [] if deployed['accepted'] else progress.get('failed_gates', [])
    if not deployed['accepted'] and state == 'ACCEPTED':
        state, failed = 'SOURCE_CHANGED', deployed.get('failed_gates', ['frozen_source'])
    if not progress and deployed.get('failed_gates'):
        failed = deployed['failed_gates']
        state = 'SOURCE_CHANGED' if any(name in failed for name in (
            'frozen_source', 'source_configuration_hashes_frozen')) else 'FAILED'
    if state == 'RUNNING' and not owner['active']:
        state = 'INTERRUPTED'
        failed = [*failed, 'reservation_interrupted']
    return {**progress, 'state': state, 'native_accepted': deployed['accepted'],
            'phase': 'ACCEPTANCE' if deployed['accepted'] else progress.get('phase', 'ACCEPTANCE'),
            'completed_trips': 12 if deployed['accepted'] else progress.get('completed_trips', 0),
            'total_trips': 12, 'failed_gates': failed, 'reason': deployed['reason'],
            'simulator_reserved': owner['reserved'], 'ownership': owner}


def scenario_catalog():
    from ..learning.hybrid_budget import active_ticket
    from ..learning.native_validation_budget import active_rule_ticket
    from ..learning.egypt_budget import active_ticket as egypt_ticket
    status = validation_status()
    validation = any(ticket is not None and ticket['expires_monotonic_s'] > time.monotonic()
                     for ticket in (egypt_ticket(), active_ticket(), active_rule_ticket()))
    owned_elsewhere = status['simulator_reserved'] and egypt_ticket() is None
    available = (status['native_accepted'] or validation) and not owned_elsewhere
    blocking = ([status['ownership']['reason']] if owned_elsewhere else []) + (
        [] if status['native_accepted'] else [status['reason'], *status['failed_gates']])
    legacy = 'SUDDEN_PEDESTRIAN_COMPARISON_V1'
    return {'default_id': SCENARIO_ID if status['native_accepted'] else legacy,
            'validation': status, 'simulator_reserved': status['simulator_reserved'],
            'options': [{'id': legacy, 'version': 1, 'name': 'Historical crossing comparison',
                         'available': not owned_elsewhere, 'maximum_speed_kmh': 120},
                        {'id': SCENARIO_ID, 'version': 1, 'name': 'Egypt mixed urban journey',
                         'available': available, 'native_accepted': status['native_accepted'],
                         'validation_window_active': validation, 'maximum_speed_kmh': 60,
                         'reason': status['reason'], 'blocking_reasons': blocking,
                         'validation': status}]}


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
