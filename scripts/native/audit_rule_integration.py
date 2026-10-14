"""Offline verification of native integration evidence and unchanged safety assets."""
import hashlib
import argparse
import json
from pathlib import Path
from backend.core.replay import ReplayReader
from scripts.native.retest_journey import audit

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT/'docs/evidence/native_rule_integration_20261012'


def command_audit(traces, diagnostics, result):
    """Match applied commands to their evaluation frame, before the next tick.

    Arrival's paused full-brake hold has no evaluated policy proposal. Require
    explicit terminal evidence for that one case, rather than inventing one.
    Sensor faults and missing proposals while driving still fail this audit.
    """
    by_frame={row['evaluation_frame']:row for row in diagnostics}
    terminal_holds=0
    for index, row in enumerate(traces):
        applied=row.get('applied_command')
        if not applied:return False,terminal_holds
        diagnostic=by_frame.get(applied['frame_id'],{})
        if diagnostic.get('applied_command')!=applied:return False,terminal_holds
        if row.get('pre_protection_command') is not None:continue
        safety=row.get('safety',{})
        if not (index==len(traces)-1 and result.get('side')=='RULE' and result.get('status')=='ARRIVED'
                and result.get('destination_arrived') and safety.get('status')=='STANDBY'
                and not safety.get('active') and applied['throttle']==0 and applied['brake']==1
                and diagnostic.get('reason')=='paused'
                and diagnostic.get('decision_source')=='EMERGENCY_PROTECTION'):
            return False,terminal_holds
        terminal_holds+=1
    return bool(traces),terminal_holds


def main():
    global OUT
    parser=argparse.ArgumentParser();parser.add_argument('--output',type=Path,default=OUT)
    OUT=parser.parse_args().output
    state=json.loads((OUT/'native-terminal-state.json').read_text())
    latest=state['comparisonV2']['latest_attempt']; recording=Path(latest['recording'])
    result=json.loads((recording/'comparison-v2-result.json').read_text())
    pair=json.loads((ROOT/'output/comparison_v2/active-pair.json').read_text())
    pose=json.loads((OUT/'independent-arrival.json').read_text())
    reader=ReplayReader(recording)
    writer=json.loads((recording/'recording-status.json').read_text())
    measurement=audit(recording,result,pair)
    measurement['initial_poses_match_verified_pair']=measurement.pop('initial_poses_match_failed_run')
    traces=[json.loads(line) for line in (recording/'telemetry/comparison-controls.jsonl').open()]
    rows=[json.loads(line) for line in (recording/'telemetry/safety-v2.jsonl').open()]
    commands_auditable,terminal_holds=command_audit(traces,rows,result)
    driving_rows=[row for row in rows if row['safety'].get('pre_protection_command') is not None]
    before=json.loads((OUT/'before.json').read_text())
    preserved={path:hashlib.sha256((ROOT/path).read_bytes()).hexdigest()==checksum
        for path,checksum in before['checksums'].items()}
    actors={frame.vehicle.actor_id for frame in reader.frames()}
    checks={
        'new_native_arrival':result['status']=='ARRIVED' and result['destination_arrived'],
        'independent_native_arrival':pose['arrival_verified'] and pose['world_frame']>0,
        'recorded_arrival':measurement['independently_verified_arrival'],
        'zero_collision_callbacks_and_episodes':measurement['collision_count']==0 and measurement['collision_callbacks']==0,
        'no_sensor_or_communication_faults':all(row.get('decision_source') not in ('SENSOR_FAILURE','COMMUNICATION_FAILURE') for row in rows),
        'approved_initial_conditions':all(result['initial_condition_audit'][key] for key in ('passed','configuration_matches','traffic_lights_match')),
        'finalized_without_loss':writer['finalized'] and not writer['incomplete'] and not writer['error'] and all(writer[key]==0 for key in ('dropped_frames','dropped_events','dropped_trace_rows')),
        'one_native_ego_in_recording':len(actors)==1,
        'sensor_sidecar_matches_frames':len(reader.safety_index)==len(reader.index),
        'commands_auditable':commands_auditable,
        'evaluated_driving_commands_within_wall_freshness_limit':bool(driving_rows) and all(row['sensor_wall_age_s']<=.25 for row in driving_rows),
        'intervention_causes_present':bool(rows) and all(row['safety'].get('reason') for row in rows if row['safety'].get('active')),
        'safety_scenario_weights_and_research_ledger_preserved':all(preserved.values()),
        'geometry_p95_within_10ms':measurement['geometry_p95_ms']<=10.,
        'paused_rule_after_arrival':state['mode']=='PAUSED' and state['safetySystem']['controller']=='RULE' and state['safetySystem']['enabled'],
    }
    report={'status':'PASS' if all(checks.values()) else 'FAIL','checks':checks,'measurements':measurement,
        'maximum_sensor_wall_age_s_all_rows_including_paused_setup':max((row.get('sensor_wall_age_s',0) for row in rows),default=None),
        'maximum_sensor_wall_age_s_driving':max((row.get('sensor_wall_age_s',0) for row in driving_rows),default=None),
        'terminal_paused_holds_without_policy_proposal':terminal_holds,
        'maximum_control_timing_ms':{key:max((row.get('control_timing_ms',{}).get(key) or 0 for row in rows),default=0)
            for key in ('lock_wait','since_publication','navigation','safety')},
        'independent_native_arrival':pose,'recording_status':writer,'recording_frames':len(reader.index),
        'safety_sidecar_frames':len(reader.safety_index),'command_trace_rows':len(traces),'preserved':preserved}
    (OUT/'recording-audit.json').write_text(json.dumps(report,indent=2),encoding='utf8')
    (OUT/'rule-result.json').write_text(json.dumps(result,indent=2),encoding='utf8')
    print(json.dumps(report,indent=2))
    if report['status']!='PASS':raise SystemExit(1)


if __name__=='__main__':main()
