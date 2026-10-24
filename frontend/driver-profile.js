export function recordedDriverDescription(run) {
  const profile=run?.driver_profile||run?.setup?.driver_profile;
  if(profile?.protocol==='EGYPT_COMPLETE_DRIVERS_V1')return profile.motion_prediction_used?
    'Complete protected driver v2 · sensor prediction + verified moving-traffic maneuvers · RL not active':
    'Complete Normal driver · reactive sensor braking · project motion prediction off';
  if(profile?.protocol==='SENSOR_REACTIVE_PREDICTIVE_V1')return profile.motion_prediction_used?
    'Sensors + reactive braking + predictive RULE · RL not active':
    'Sensors + reactive braking · project motion prediction off';
  if(run?.mode==='BASELINE')return 'CARLA BehaviorAgent normal · native obstacle checks';
  if(run?.mode==='HYBRID')return 'Experimental hybrid behavior · recorded validation applies';
  if(run?.mode==='NORMAL')return ['PRESENTATION_RULE_NORMAL_V1','GUIDED_RULE_NORMAL_V2'].includes(run.setup?.protocol)?
    'Historical Normal · obstacle protection off; route and signals only':
    'Historical Normal · protection settings not recorded';
  return 'Historical Robosphere · RULE protection';
}

export function preferredVideo(status) {
  if(status?.status!=='READY')return null;
  if(status.annotation_required)return status.variants?.annotated?.status==='READY'&&
    status.variants.annotated.video==='driving-annotated.mp4'?'driving-annotated.mp4':null;
  return 'driving.mp4';
}
