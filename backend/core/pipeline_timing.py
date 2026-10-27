"""Frame-bound timing evidence, separate from control authority and freshness."""
import math
from .contracts import to_dict


def _number(value):
    return type(value) in (int, float) and math.isfinite(value)


def sensor_timing(frame, required, completed_wall_s):
    required = set(required)
    sensors = {s.sensor_id: s for s in frame.sensors if s.sensor_id in required}
    issues = []
    received, encoded = [], []
    for name in sorted(required):
        sensor = sensors.get(name)
        arrival = sensor.metadata.get('received_monotonic_s') if sensor else None
        finished = sensor.metadata.get('encoded_monotonic_s') if sensor else None
        if not _number(arrival):
            issues.append('MISSING_SENSOR_RECEIPT:' + name)
        else:
            received.append(arrival)
        if not _number(finished):
            issues.append('MISSING_SENSOR_ENCODING:' + name)
        else:
            encoded.append(finished)
        if (_number(arrival) and _number(finished) and
                (finished < arrival or _number(completed_wall_s) and completed_wall_s < finished)):
            issues.append('SENSOR_CLOCK_ORDER:' + name)
    if not required:
        issues.append('NO_REQUIRED_SENSOR_TIMING')
    if not frame.complete:
        issues.append('INCOMPLETE_SENSOR_FRAME')
    stages = {
        'first_required_sensor_received': min(received) if required and len(received) == len(required) else None,
        'last_required_sensor_received': max(received) if required and len(received) == len(required) else None,
        'required_sensors_encoded': max(encoded) if required and len(encoded) == len(required) else None,
        'frame_complete': completed_wall_s if frame.complete and _number(completed_wall_s) else None,
    }
    return {'source': 'LIVE_SYNCHRONIZER_HOST_MONOTONIC', 'issues': issues, 'stages': stages}


INTERVALS = {
    'sensor_collection_ms': ('first_required_sensor_received', 'last_required_sensor_received'),
    'sensor_encode_tail_ms': ('last_required_sensor_received', 'required_sensors_encoded'),
    'synchronization_ms': ('required_sensors_encoded', 'frame_complete'),
    'scene_queue_ms': ('frame_complete', 'scene_build_started'),
    'scene_build_ms': ('scene_build_started', 'scene_published'),
    'prediction_ms': ('prediction_started', 'prediction_completed'),
    'maneuver_ms': ('maneuver_selection_started', 'maneuver_selection_completed'),
    'execution_shield_ms': ('execution_shield_started', 'execution_shield_completed'),
    'rpc_ms': ('carla_control_called', 'carla_control_returned'),
    'sensor_to_submit_ms': ('first_required_sensor_received', 'carla_control_called'),
    'sensor_to_rpc_return_ms': ('first_required_sensor_received', 'carla_control_returned'),
}


def elapsed_ms(stages, first, last):
    start, end = stages.get(first), stages.get(last)
    if not _number(start) or not _number(end) or end < start:
        return None
    return (end-start)*1000


def command_trace(timing, scene, command, *, acknowledged, actor_id):
    stages = dict(timing.get('stages_monotonic_s') or {})
    metadata = getattr(scene, 'timing_metadata', None) or {
        'source': 'UNINSTRUMENTED_OR_REPLAY', 'issues': ['SENSOR_TIMING_NOT_CAPTURED']}
    issues = list(metadata.get('issues', ()))
    intervals = {}
    for name, (first, last) in INTERVALS.items():
        intervals[name] = elapsed_ms(stages, first, last)
        if intervals[name] is None:
            issues.append('UNMEASURED_INTERVAL:' + name)
    if metadata['source'] != 'LIVE_SYNCHRONIZER_HOST_MONOTONIC':
        intervals['sensor_to_submit_ms'] = intervals['sensor_to_rpc_return_ms'] = None
    session = timing['session_id']
    frame = timing['frame_id']
    return {
        'kind': 'CONTROL_PIPELINE_TIMING', 'version': 1,
        'trace_id': f'{session}:{frame}:{stages.get("carla_control_called")}',
        'session_id': session, 'frame_id': frame, 'source_frame': timing.get('source_frame'),
        'command_timestamp_s': command.timestamp_s,
        'measurement_timestamp_s': scene.observation.timestamp_s if scene else None,
        'simulation_age_at_check_s': timing.get('simulation_age_s'),
        'fresh_at_check': timing.get('fresh_aligned'), 'actor_id': actor_id,
        'command': to_dict(command), 'stages_monotonic_s': stages, 'intervals_ms': intervals,
        'clock_source': metadata['source'], 'timing_issues': issues,
        'sensor_timing_valid': not metadata.get('issues'),
        'server_acknowledged': acknowledged, 'application_status': 'SUBMITTED_NOT_OBSERVED',
        'exact_physical_application_timestamp_s': None,
        'native_acceptance': False,
    }


def observed_control(trace, observation, observed_wall_s):
    stages = {**trace['stages_monotonic_s'], 'control_state_observed': observed_wall_s}
    command, vehicle = trace['command'], observation.vehicle
    actual = {k: getattr(vehicle, k) for k in ('throttle', 'brake', 'steering', 'reverse', 'handbrake')}
    match = all(math.isclose(command[k], actual[k], rel_tol=0., abs_tol=1e-6)
                for k in ('throttle', 'brake', 'steering'))
    match = match and all(command[k] == actual[k] for k in ('reverse', 'handbrake'))
    new_frame = observation.frame_id > trace['frame_id'] and observation.timestamp_s > trace['command_timestamp_s']
    same_actor = vehicle.actor_id == trace['actor_id']
    ordered = elapsed_ms(stages, 'carla_control_returned', 'control_state_observed') is not None
    status = ('NO_NEW_NATIVE_FRAME' if not new_frame else 'VEHICLE_CHANGED' if not same_actor
              else 'INVALID_HOST_CLOCK' if not ordered else 'CONTROL_STATE_MISMATCH' if not match
              else 'MATCHING_CONTROL_STATE')
    measured = (status == 'MATCHING_CONTROL_STATE' and trace.get('sensor_timing_valid') is True
                and trace['clock_source'] == 'LIVE_SYNCHRONIZER_HOST_MONOTONIC')
    latency = elapsed_ms(stages, 'first_required_sensor_received', 'control_state_observed') if measured else None
    return {
        'kind': 'CONTROL_APPLICATION_OBSERVED', 'version': 1,
        'trace_id': trace['trace_id'], 'session_id': trace['session_id'], 'frame_id': trace['frame_id'],
        'source_frame': trace['source_frame'], 'observation_frame': observation.frame_id,
        'observation_timestamp_s': observation.timestamp_s, 'observed_wall_s': observed_wall_s,
        'application_status': status, 'observed_control': actual,
        'sensor_to_observed_control_ms': latency,
        'sensor_simulation_age_at_observation_s': (
            observation.timestamp_s-trace['measurement_timestamp_s']
            if trace['measurement_timestamp_s'] is not None else None),
        'application_time_is_upper_bound': measured and latency is not None,
        'command_identity_proven': False,
        'exact_physical_application_timestamp_s': None,
        'native_acceptance': False,
    }


def summarize_timing(rows):
    import numpy as np
    submitted, observed = {}, {}
    for row in rows:
        destination = (submitted if row.get('kind') == 'CONTROL_PIPELINE_TIMING' else
                       observed if row.get('kind') == 'CONTROL_APPLICATION_OBSERVED' else None)
        if destination is not None:
            identity = row['trace_id']
            if identity in destination:
                raise ValueError('Duplicate control timing trace: ' + identity)
            destination[identity] = row
    if not submitted:
        raise ValueError('No submitted control pipeline timing rows')
    if set(observed) - set(submitted):
        raise ValueError('Control observations have no corresponding submission')
    values = [r['sensor_to_observed_control_ms'] for key, r in observed.items()
              if r.get('application_status') == 'MATCHING_CONTROL_STATE'
              and _number(r.get('sensor_to_observed_control_ms'))
              and r['sensor_to_observed_control_ms'] >= 0.
              and r.get('application_time_is_upper_bound') is True
              and submitted[key].get('fresh_at_check') is True
              and not submitted[key]['timing_issues']]
    p95 = float(np.percentile(values, 95)) if values else None
    complete = len(values) == len(submitted)
    return {'submitted': len(submitted), 'observed': len(observed), 'eligible': len(values),
            'unobserved': len(submitted)-len(observed), 'complete_timing_evidence': complete,
            'sensor_to_observed_control_p95_ms': p95,
            'proposed_target_ms': 200., 'proposed_target_met': p95 < 200. if complete else None,
            'exact_application_time_measured': False, 'native_acceptance': False,
            'real_time_verified': False}
