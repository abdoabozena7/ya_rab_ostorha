import {missionState} from './mission-state.js';
// One source for the next user action. A fault is never an ordinary pause.
export function driveState(p) {
  if(p.presentation?.guided){
    const m=missionState(p),phase=p.presentation.status;
    return {action:m.action,busy:!['IDLE','COMPLETE','CANCELLED','ERROR'].includes(phase),failed:phase==='ERROR',resumable:false,presentationStatus:phase,startLabel:'Start simulation',configurationLocked:!['COMPLETE','CANCELLED','ERROR'].includes(phase)||!!p.recording,emergencyVisible:!!p.connected&&!p.isReplay&&p.controlMode!=='EMERGENCY_STOP',enabled:!!m.action};
  }
  const savedStatus=p.presentation?.status||'IDLE';
  const ordinary=!!p.journey?.route_id&&!p.journey?.presentation_id;
  const status=ordinary&&['ERROR','COMPLETE','CANCELLED'].includes(savedStatus)?'IDLE':savedStatus;
  const busy=!['IDLE','COMPLETE','CANCELLED','ERROR'].includes(status);
  const driving=['STARTING','RUNNING'].includes(p.journey?.status);
  const emergency=p.controlMode==='EMERGENCY_STOP';
  const failed=p.lastDriveStop?.status==='ERROR'||p.journey?.status==='ERROR'||status==='ERROR';
  const attempted=!!p.presentation?.id||!!p.journey?.route_id||!!p.journey?.presentation_id||failed||driving||
    status!=='IDLE'||['ARRIVED','COMPLETE','CANCELLED'].includes(p.journey?.status);
  const resumable=!busy&&!failed&&!p.journey?.presentation_id&&p.controlMode==='PAUSED'&&
    p.journey?.status==='PAUSED'&&p.journey?.route_id&&p.route&&p.journey.route_id===p.route.id&&!p.route.arrived&&
    ['operator_stop','focus_lost','dashboard_disconnected','dashboard_heartbeat_timeout','controls_released'].includes(p.journey.reason);
  const action=emergency?'RELEASE':status==='PLAYBACK'||p.presentationPlayback?'PLAYBACK':p.connected===false&&!p.simulationStarting&&!p.restarting?'RESTART':busy||
    driving||p.simulationStarting?'STOP':resumable?'RESUME':'RESTART';
  return {action,busy,failed,resumable:!!resumable,presentationStatus:status,startLabel:attempted?'Restart':'Start',
    configurationLocked:busy||driving||!!p.recording||!!p.simulationStarting||!!p.restarting||emergency||p.controlMode==='TRAINING',
    emergencyVisible:!!p.connected&&!p.isReplay&&!emergency,
    enabled:action==='PLAYBACK'?true:action==='RESTART'?!p.restarting&&!p.isReplay&&p.controlMode!=='TRAINING':!!p.fresh&&!!p.controller&&
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
