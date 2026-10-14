// Presentation only. Native control and safety authority stay in the backend.
import {comparisonV2Busy,comparisonStartBlocked} from './comparison-v2.js';
export const comparisonBusy = demo => ['RESETTING','RUNNING','STOPPING'].includes(demo?.phase);

export function driveState(p, state, armed = false) {
  const demo = p.comparisonDemo, journeyRun = p.comparisonV2, safety = p.safetySystem;
  let label = 'Ready', tone = 'neutral', action = 'startDrivingBtn', actionLabel = 'Start manual drive';
  if (p.isReplay) { label = 'Recorded replay'; action = 'replayPauseBtn'; actionLabel = p.replay?.paused ? 'Resume replay' : 'Pause replay'; }
  else if (p.simulationStarting || p.restarting) { label = p.simulationStarting ? 'Starting the simulation' : 'Restarting simulator'; action = null; actionLabel = label+'…'; }
  else if (!p.fresh) { label = p.phase === 'ERROR' ? 'Connection error' : 'Disconnected'; tone = 'warning'; action = 'startSimulationBtn'; actionLabel = 'Start the simulation'; }
  else if (p.controlMode === 'EMERGENCY_STOP') { label = 'Emergency stopped'; tone = 'danger'; action = 'acknowledgeStopBtn'; actionLabel = 'Acknowledge emergency stop'; }
  else if (safety?.enabled && (safety.status?.includes('FAULT') || safety.status === 'UNAVAILABLE')) { label = 'Safety sensor fault'; tone = 'danger'; action = 'sensorBtn'; actionLabel = 'Review sensor status'; }
  else if (demo?.error || journeyRun?.error || p.operationError || p.journey?.status === 'ERROR') { label = 'Action failed'; tone = 'danger'; action = 'settingsBtn'; actionLabel = 'Review settings'; }
  else if (p.manualStartPending || demo?.phase === 'RESETTING' || ['QUEUED','RESETTING'].includes(journeyRun?.phase) || p.journey?.status === 'STARTING') { label = 'Starting drive'; action = comparisonV2Busy(journeyRun) ? 'pauseBtn' : null; actionLabel = action ? 'Stop drive' : 'Starting…'; }
  else if (demo?.phase === 'STOPPING' || journeyRun?.phase === 'STOPPING' || (p.controlMode === 'PAUSED' && Math.abs(state.speedKmh ?? 0) > .54)) { label = 'Stopping vehicle'; tone = 'warning'; action = null; actionLabel = 'Stopping…'; }
  else if (safety?.active) { label = 'Safety intervention'; tone = 'danger'; action = 'pauseBtn'; actionLabel = 'Stop drive'; }
  else if (demo?.phase === 'RUNNING' || p.controlMode === 'AUTOMATIC' || (p.controlMode === 'MANUAL' && armed)) { label = 'Driving'; tone = 'success'; action = 'pauseBtn'; actionLabel = 'Stop drive'; }
  else if (journeyRun?.phase === 'FINISHED' && journeyRun.latest_attempt) {
    const status=journeyRun.latest_attempt.status;
    label=({ARRIVED:'Journey arrived',COLLISION:'Drive ended · collision',TIMEOUT:'Journey timed out',FAILURE:'Journey failed',INTERRUPTED:'Journey interrupted'})[status] || 'Journey ended';
    tone=status==='ARRIVED' ? 'success' : ['COLLISION','FAILURE'].includes(status) ? 'danger' : 'warning';
    action='resultsTab'; actionLabel='Review journey results';
  }
  else if (demo?.phase === 'FINISHED' || p.journey?.status === 'ARRIVED') {
    label = demo?.latest_outcome === 'COLLISION' ? 'Drive ended · collision' : demo?.latest_outcome === 'INTERRUPTED' ? 'Comparison interrupted' : demo?.latest_outcome === 'INCOMPLETE' ? 'Run incomplete' : 'Drive completed';
    tone = demo?.latest_outcome === 'COLLISION' ? 'danger' : ['INTERRUPTED','INCOMPLETE'].includes(demo?.latest_outcome) ? 'warning' : 'success';
    action = 'resultsTab'; actionLabel = 'Review results';
  }
  else if (p.journey?.reason && p.journey.reason !== 'fresh_native_session') label = p.journey.reason === 'focus_lost' ? 'Stopped · focus lost' : 'Drive stopped';
  if (p.fresh && !p.isReplay && !p.controller && !p.simulationStarting) { action = 'ownershipBtn'; actionLabel = 'Take vehicle control'; }
  else if (action === 'startDrivingBtn' && p.route && !p.route.arrived) { action = 'driveJourneyBtn'; actionLabel = p.journey?.status === 'PAUSED' ? 'Resume destination drive' : 'Start destination drive'; }
  if (action === 'startDrivingBtn' && journeyRun) {
    const saved=Object.keys(journeyRun.results || {}).length || journeyRun.latest_attempt;
    action=comparisonStartBlocked(p) && saved ? 'journeyResultsBtn' : 'ruleDrivingBtn';
    actionLabel=action==='journeyResultsBtn' ? 'Review recorded RULE journey' : 'Rules driving';
  }
  const mode = p.isReplay ? 'Replay · read only' : !p.fresh ? 'Unavailable' : p.controlMode === 'AUTOMATIC' ? 'Autonomous' : p.controlMode === 'MANUAL' && armed ? 'Manual · keyboard' : 'Vehicle held';
  let safetyLabel = 'Waiting for sensors', safetyTone = 'neutral', risk = 'Not assessed';
  if (p.isReplay) safetyLabel = 'Recorded safety data';
  else if (p.fresh && safety) {
    if(safety.status==='STANDARD_DRIVER'){safetyLabel=safety.actual_generator==='SENSOR_BASELINE'?'Sensor-guided route':'CARLA standard';safetyTone='neutral';}
    else if (!safety.enabled) { safetyLabel = 'Safety disabled'; safetyTone = 'danger'; }
    else if (safety.status?.startsWith('SUSPENDED')) { safetyLabel = 'Safety suspended'; safetyTone = 'warning'; }
    else if (safety.status?.includes('FAULT') || safety.status === 'UNAVAILABLE') { safetyLabel = 'Sensor fault'; safetyTone = 'danger'; }
    else if (safety.active) { safetyLabel = 'Intervening'; safetyTone = 'danger'; }
    else if (safety.status === 'STANDBY') safetyLabel = 'Standby';
    else { safetyLabel = 'Monitoring'; safetyTone = 'success'; }
    const names = {UNKNOWN:'Not assessed',LOW:'Low',CLEAR:'No active risk',NONE:'No active risk',MEDIUM:'Elevated',HIGH:'High',CRITICAL:'Critical'};
    risk = !safety.enabled&&safety.status!=='STANDARD_DRIVER' ? 'Detection disabled' : names[safety.risk] ?? safety.risk ?? 'Not assessed';
    if (['MEDIUM','HIGH','CRITICAL'].includes(safety.risk)) safetyTone = safety.risk === 'MEDIUM' ? 'warning' : 'danger';
  }
  return {label,tone,mode,action,actionLabel,safetyLabel,safetyTone,risk,
    reason:p.fresh && safety ? safety.reason || 'No intervention reported' : 'Connect the simulator to assess risk.',
    interventions:p.fresh ? safety?.intervention_count ?? null : null};
}

export function selectedComparison(demo) {
  const current = Object.keys(demo?.results || {}).length > 0;
  const comparison = current ? demo : demo?.archived_comparison;
  return {comparison,archived:!current && !!comparison,scope:current ? 'Recorded results · this comparison' : 'Archived comparison · saved recording'};
}

export function collisionOutcome(result) {
  if (!result) return {label:'Run not recorded',tone:'neutral',symbol:'—'};
  if (result.collision === true || result.outcome?.metrics?.collision_count > 0) return {label:'Collision detected',tone:'danger',symbol:'!'};
  if (result.collision === false || result.outcome?.metrics?.collision_count === 0) return {label:result.completed ? 'No collision recorded' : 'No collision · incomplete run',tone:result.completed ? 'success' : 'warning',symbol:result.completed ? '✓' : '!'};
  return {label:'Collision data unavailable',tone:'neutral',symbol:'—'};
}

// This is a notice for display-only inference, not the safety controller's limit.
export function detectionFreshness(result, telemetry, delta) {
  const frames = Number.isFinite(telemetry?.frame) && Number.isFinite(result.frame_id) ? telemetry.frame-result.frame_id : null;
  const seconds = Number.isFinite(telemetry?.timestamp) && Number.isFinite(result.timestamp_s) ? telemetry.timestamp-result.timestamp_s : frames !== null && Number.isFinite(delta) ? frames*delta : null;
  if (frames === null || seconds === null || frames < 0 || seconds < 0) return {tone:'warning',label:'Frame alignment unavailable',frames,seconds:null};
  return {tone:seconds >= .5 ? 'warning' : 'neutral',label:seconds >= .5 ? 'Delayed detection' : 'Detection age',frames,seconds};
}
