"""Score the observed comparison; expected outcomes never create collision events."""
import math
PROTOCOL='SUDDEN_PEDESTRIAN_COMPARISON_V1'


def scheduled_origins_verified(scenario,runs):
    plans=scenario.get('events') or {}
    if not plans:return False
    for mode,run in runs.items():
        events=run.get('scenario_evidence',{}).get('events',{})
        for role,plan in plans.items():
            event=events.get(role,{})
            stamp=event.get('first_crossing_command_s');position=event.get('start_position')
            if stamp is None:
                if mode=='ROBOSPHERE':return False
                continue # Normal ends before later scheduled crossings.
            origin=plan.get('origin')
            if (not position or not origin or math.dist(position[:2],origin[:2])>.75
                    or not 0<=stamp-plan['start_s']<=.11):return False
    return True


def evaluate_pair(data):
    scenario=(data.get('manifest') or {}).get('comparison_scenario')
    if not scenario or scenario.get('protocol')!=PROTOCOL:return None
    runs=data.get('runs',{});normal=runs.get('NORMAL',{});project=runs.get('ROBOSPHERE',{})
    gates={'both_recorded':set(runs)>={'NORMAL','ROBOSPHERE'},
        'normal_pedestrian_collision':normal.get('status')=='COLLISION' and any(
            c.get('role')=='critical_pedestrian' and str(c.get('type','')).startswith('walker.') for c in normal.get('collision_events',[])),
        'project_arrived_without_contact':project.get('status')=='ARRIVED' and project.get('collisions')==0,
        'initial_conditions_verified':bool(normal.get('setup',{}).get('initial_condition_id')) and
            normal.get('setup',{}).get('initial_condition_id')==project.get('setup',{}).get('initial_condition_id') and
            all(r.get('initial_condition_audit',{}).get('passed') is True for r in (normal,project)),
        'same_requested_speed':all(r.get('setup',{}).get('speed_kmh')==120. for r in (normal,project)),
        'same_detector':bool(normal.get('setup',{}).get('perception_profile',{})) and
            normal.get('setup',{}).get('perception_profile')==project.get('setup',{}).get('perception_profile'),
        'same_scenario':all(r.get('setup',{}).get('comparison_scenario',{}).get('definition_sha256')==scenario['definition_sha256'] for r in runs.values()) and len(runs)==2,
        'scheduled_crossing_origins_verified':scheduled_origins_verified(scenario,runs),
        'critical_crossing_realized':all(r.get('scenario_evidence',{}).get('events',{}).get('critical_pedestrian',{}).get('realized') for r in runs.values()) and len(runs)==2}
    return {'protocol':PROTOCOL,'scenario_id':scenario['id'],'passed':all(gates.values()),'gates':gates,
        'source':'ACTUAL_COLLISION_EVENTS_AND_DESTINATION_STATUS'}
