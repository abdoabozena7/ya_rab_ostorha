"""Conservative crossing hypotheses for sensor-associated people, never intent certainty."""
from .prediction import assess_conflicts,ego_paths


def crossing_forecast(prediction,observation,base,geometry):
    if not prediction or prediction.get('source')!='CONTROL_SENSOR_PIPELINE' or not prediction.get('motion_tracking_complete'):
        return None
    if prediction.get('evaluation_frame')!=observation.frame_id or abs(prediction.get('timestamp_s',-1)-observation.timestamp_s)>1e-6:
        return None
    people=[]
    for track in prediction.get('tracks',()):
        semantic=track.get('semantic_evidence') or {};evidence=track.get('measurement_evidence') or {}
        if (not track.get('confirmed') or track.get('occlusion_s',1)>.1 or
                str(track.get('class','')).lower() not in ('person','pedestrian') or
                semantic.get('session_id')!=prediction.get('session_id') or semantic.get('confidence',0)<.65 or
                semantic.get('source_sensor')!='frontCamera' or
                not semantic.get('depth_evidence') or
                not 0<=observation.timestamp_s-semantic.get('timestamp_s',-10)<=.75 or
                evidence.get('session_id')!=prediction.get('session_id') or evidence.get('frame_id')!=observation.frame_id):continue
        # Rear-only proximity cannot command forward braking. A broad or
        # merged surface is not accepted as a reliably located person.
        if track['position_m'][0]<=geometry.front_m or max(track['half_size_m'])>1.5:continue
        people.append(track)
    if not people:return None
    ids={t['id'] for t in people}
    cleared={t['id'] for t in people if t.get('observed_crossing_cleared')}
    modes=[m for m in prediction.get('trajectories',()) if m['track_id'] in ids and
        not (m['track_id'] in cleared and m['source'] in ('PEDESTRIAN_POSSIBLE_START','PEDESTRIAN_POSSIBLE_RETREAT'))]
    paths=[p for p in ego_paths(observation.ego.speed_mps,base.steering,base.throttle,geometry=geometry)
        if p['intent']!='BRAKE']
    for conflict in assess_conflicts(people,modes,paths):
        if not conflict['separating_rear_overlap'] and not conflict['braking_worsens_rear_conflict']:
            return {**conflict,'certainty':'POSSIBLE_CROSSING_NOT_KNOWN_INTENT',
                'measurement_frame':observation.frame_id,'timestamp_s':observation.timestamp_s}
    return None
