"""Conservative crossing hypotheses for sensor-associated people, never intent certainty."""
from .prediction import assess_conflicts,ego_paths
import numpy as np

# Keep intermediate responses: a fast launch can pass before a crossing while
# an intermediate acceleration collides. Native resumption exceeded 2 m/s².
DRIVE_ACCELERATIONS=(2.,4.,6.,8.)


def cautious_roadside_approach(prediction,forecast,observation,geometry,*,road_range,distance,envelope,hazard,conflict,maximum_speed_mps=1.5):
    """A measured stationary curbside person permits walking-speed approach.

    This never licenses a moving, unobserved or in-lane person, nor overrides
    physical braking. It prevents unknown future intent holding an empty lane
    forever after a crossing or when a new identity appears on the sidewalk.
    """
    if (not forecast or forecast.get('source') not in ('PEDESTRIAN_POSSIBLE_START','PEDESTRIAN_POSSIBLE_RETREAT','PEDESTRIAN_POSSIBLE_RUN')
            or hazard or conflict or abs(observation.ego.speed_mps)>maximum_speed_mps
            or road_range<envelope+2. or distance is not None and distance<=envelope+2.):return False
    track=next((t for t in (prediction or {}).get('tracks',()) if t['id']==forecast['track_id']),None)
    if (not track or not track.get('confirmed') or track.get('occlusion_s',1)>.1
            or np.linalg.norm(track['velocity_mps'])>=.3
            or abs(track['position_m'][1])<=geometry.half_width_m+track['half_size_m'][1]+track.get('uncertainty_m',.4)+.5):return False
    history=np.asarray([r for r in track.get('history',()) if 0<=observation.timestamp_s-r[0]<=1.])
    # Match the existing stationary hypothesis threshold and the measured
    # position uncertainty; sub-resolution torso/depth jitter is not ingress.
    return bool(len(history)>=3 and history[-1,0]-history[0,0]>=.6-1e-6
        and np.max(np.linalg.norm(history[:,1:3]-history[-1,1:3],axis=1))<=max(.15,track.get('uncertainty_m',.15)))


def cautious_roadside_speed(prediction,forecast,observation,base,geometry,*,maximum_cap_mps=None,
        reaction_time_s=.35,deceleration_mps2=5.,**conditions):
    """Choose a bounded response verified against all current crossing modes.

    A 1 m/s override was excessively slow beside distant stationary people.
    Moving crossings also permit a slower verified response instead of holding
    the vehicle inside another person's crossing while a farther risk clears.
    Every candidate instead retains all acceleration hypotheses, current body
    measurements and crossing modes. No safe candidate means ordinary braking.
    """
    if (not prediction or prediction.get('source')!='CONTROL_SENSOR_PIPELINE' or not prediction.get('motion_tracking_complete')
            or prediction.get('evaluation_frame')!=observation.frame_id or prediction.get('timestamp_s')!=observation.timestamp_s
            or not forecast or forecast.get('measurement_frame')!=observation.frame_id
            or forecast.get('timestamp_s')!=observation.timestamp_s):return None
    stationary=cautious_roadside_approach(prediction,forecast,observation,geometry,
        maximum_speed_mps=4.5,**conditions)
    track=next((t for t in (prediction or {}).get('tracks',()) if forecast and t['id']==forecast['track_id']),None)
    evidence=(track or {}).get('measurement_evidence') or {}
    conflict=conditions.get('conflict')
    moving=bool(track and forecast.get('source') in ('CONSTANT_VELOCITY','CONSTANT_ACCELERATION','COORDINATED_TURN')
        and track.get('confirmed') and track.get('occlusion_s',1)<=.1
        and evidence.get('session_id')==prediction.get('session_id') and evidence.get('frame_id')==observation.frame_id
        and .3<=np.linalg.norm(track['velocity_mps'])<=5. and abs(observation.ego.speed_mps)<=4.5
        and not conditions.get('hazard') and (conflict is None or conflict.get('source')=='CURRENT_DEPTH_SURFACE_TRACK')
        and conditions['road_range']>=conditions['envelope']+2.
        and (conditions.get('distance') is None or conditions['distance']>conditions['envelope']+2.))
    if not stationary and not moving:return None
    tested=set()
    for candidate in (4.,3.,2.,1.):
        cap=min(candidate,maximum_cap_mps) if maximum_cap_mps is not None else candidate
        if cap<=0 or cap in tested:continue
        tested.add(cap)
        # A stationary curbside person's unobserved intent cannot require
        # continuing an open-loop launch for three seconds. At walking speed
        # recheck every frame over the reaction + full stopping interval, with
        # one extra observation interval. Actual moving crossings retain the
        # full horizon; immediate hazards and missing observations still brake.
        horizon=(reaction_time_s+max(abs(observation.ego.speed_mps),cap)/deceleration_mps2+.1
            if stationary else None)
        if crossing_forecast(prediction,observation,base,geometry,
                allow_measured_unknown=True,cap_mps=cap,
                stationary_response=(track['id'],horizon) if stationary else None) is None:return cap
    return None


def crossing_forecast(prediction,observation,base,geometry,*,allow_measured_unknown=False,cap_mps=None,stationary_response=None):
    if not prediction or prediction.get('source')!='CONTROL_SENSOR_PIPELINE' or not prediction.get('motion_tracking_complete'):
        return None
    if prediction.get('evaluation_frame')!=observation.frame_id or abs(prediction.get('timestamp_s',-1)-observation.timestamp_s)>1e-6:
        return None
    people=[];unknown=set()
    for track in prediction.get('tracks',()):
        semantic=track.get('semantic_evidence') or {};evidence=track.get('measurement_evidence') or {}
        if (not track.get('confirmed') or track.get('occlusion_s',1)>.1 or
                evidence.get('session_id')!=prediction.get('session_id') or evidence.get('frame_id')!=observation.frame_id):continue
        measured_unknown=(allow_measured_unknown and track.get('class')=='UNKNOWN'
            and evidence.get('source')=='CURRENT_DEPTH_BODY_CORE' and evidence.get('timestamp_s')==observation.timestamp_s
            and evidence.get('support_points',0)>=4 and 0<=evidence.get('mad_m',1)<=.25
            and evidence.get('motion_span_s',0)>=.15-1e-6 and track.get('motion_observations',0)>=3
            and .3<=np.linalg.norm(track.get('velocity_mps',[0.,0.]))<=5.)
        if not measured_unknown and (str(track.get('class','')).lower() not in ('person','pedestrian') or
                semantic.get('session_id')!=prediction.get('session_id') or semantic.get('confidence',0)<.65 or
                semantic.get('source_sensor')!='frontCamera' or
                not semantic.get('depth_evidence') or
                not 0<=observation.timestamp_s-semantic.get('timestamp_s',-10)<=.75 or
                evidence.get('session_id')!=prediction.get('session_id') or evidence.get('frame_id')!=observation.frame_id):continue
        # Rear-only proximity cannot command forward braking. A broad or
        # merged surface is not accepted as a reliably located person.
        if track['position_m'][0]<=geometry.front_m or max(track['half_size_m'])>1.5:continue
        people.append(track)
        if measured_unknown:unknown.add(track['id'])
    if not people:return None
    ids={t['id'] for t in people}
    cleared={t['id'] for t in people if t.get('observed_crossing_cleared')}
    modes=[m for m in prediction.get('trajectories',()) if m['track_id'] in ids and
        (m['track_id'] not in unknown or m['source']=='CONSTANT_VELOCITY') and
        not (m['track_id'] in cleared and m['source'] in ('PEDESTRIAN_POSSIBLE_START','PEDESTRIAN_POSSIBLE_RETREAT','PEDESTRIAN_POSSIBLE_RUN'))]
    horizon=max(3.,.6+abs(observation.ego.speed_mps)/5.)
    grid=np.round(np.arange(int(np.ceil(horizon/.1))+1)*.1,6)
    paths=[p for p in ego_paths(observation.ego.speed_mps,base.steering,base.throttle,geometry=geometry,grid=grid,
            drive_accelerations=DRIVE_ACCELERATIONS,cap_mps=cap_mps)
        if p['intent']!='BRAKE']
    for conflict in assess_conflicts(people,modes,paths,grid=grid):
        if (stationary_response and conflict['track_id']==stationary_response[0]
                and conflict['source'] in ('PEDESTRIAN_POSSIBLE_START','PEDESTRIAN_POSSIBLE_RETREAT','PEDESTRIAN_POSSIBLE_RUN')
                and conflict['time_s']>stationary_response[1]):continue
        if not conflict['separating_rear_overlap'] and not conflict['braking_worsens_rear_conflict']:
            return {**conflict,'certainty':'MEASURED_MOVING_DEPTH_SURFACE_UNKNOWN_CLASS' if conflict['track_id'] in unknown else 'POSSIBLE_CROSSING_NOT_KNOWN_INTENT',
                'object_class':'UNKNOWN' if conflict['track_id'] in unknown else 'person',
                'measurement_frame':observation.frame_id,'timestamp_s':observation.timestamp_s}
    return None
