// One source for the next user action. A fault is never an ordinary pause.
export function driveState(p) {
  const status=p.presentation?.status||'IDLE';
  const busy=!['IDLE','COMPLETE','CANCELLED','ERROR'].includes(status);
  const emergency=p.controlMode==='EMERGENCY_STOP';
  const failed=p.lastDriveStop?.status==='ERROR'||p.journey?.status==='ERROR'||status==='ERROR';
  const resumable=!busy&&!failed&&!p.journey?.presentation_id&&p.controlMode==='PAUSED'&&
    p.journey?.status==='PAUSED'&&p.journey?.route_id&&p.route&&!p.route.arrived&&
    ['operator_stop','focus_lost','dashboard_disconnected','dashboard_heartbeat_timeout','controls_released'].includes(p.journey.reason);
  const action=emergency?'RELEASE':status==='PLAYBACK'||p.presentationPlayback?'PLAYBACK':busy||
    ['STARTING','RUNNING'].includes(p.journey?.status)||p.simulationStarting?'STOP':resumable?'RESUME':'RESTART';
  return {action,busy,failed,resumable:!!resumable,
    enabled:action==='PLAYBACK'?true:action==='RESTART'?!p.restarting:!!p.fresh&&!!p.controller&&
      (action!=='RESUME'||(!p.recording&&p.recordingStatus?.finalized!==false))};
}

const vehicles=new Set(['car','truck','bus','motorcycle','bicycle','train']);
export function trackKind(track) {
  const label=String(track.class||'UNKNOWN').toLowerCase();
  if(!track.confirmed||!track.semantic_evidence)return 'surface';
  return label==='person'||label==='pedestrian'?'person':vehicles.has(label)?'vehicle':'surface';
}

export function mapTracks(tracks,layer,filters) {
  if(layer==='route')return [];
  return (tracks||[]).filter(t=>filters[{person:'people',vehicle:'vehicles',surface:'surfaces'}[trackKind(t)]]);
}
