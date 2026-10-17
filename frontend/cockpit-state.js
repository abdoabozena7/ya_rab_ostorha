// Display rules only. These checks never issue controls or change safety limits.
const finite = value => Number.isFinite(value) && value >= 0;
export const metricText = (value, digits = 0) => finite(value) ? value.toFixed(digits) : '—';

export function controlReasonText(reason) {
  if(/^presentation_phase_timeout:/.test(reason||''))return 'The presentation exceeded its time limit. The unfinished attempt and its trace are saved; use Restart to prepare a new run.';
  return ({
    CONTROL_PROCESSING_DEADLINE:'Control calculation missed its deadline. Waiting for a fresh frame.',
    STALE_CONTROL_SCENE:'Sensors are stale or out of sync. Waiting for a fresh frame.',
    AWAITING_CURRENT_SENSOR_FRAME:'Waiting for sensors from the current vehicle frame.',
    NO_VERIFIED_SAFE_ACTION:'No verified maneuver is available. Vehicle held.',
    SWEPT_SPACE_UNKNOWN_OR_OCCUPIED:'The movement corridor is unmeasured or occupied.',
    REACHABLE_CORRIDOR_UNCERTAINTY:'A nearby object has uncertain motion. Waiting for a clearer measurement.',
    PREDICTED_INTERSECTION:'A predicted object path intersects the vehicle path.',
    BODY_OUTSIDE_DRIVABLE_ROAD:'This maneuver would take part of the vehicle outside the drivable road.',
    ADJACENT_ROUTE_BLOCKED:'A measured stationary obstacle also blocks the passing route.',
    TRAFFIC_RULE_STOP:'Waiting for the traffic signal.',
    HYBRID_CONTROLLED_DECELERATION:'Slowing for the route and measured available space.',
    HYBRID_VALIDATION_EXPIRED:'Native validation time expired. Vehicle held.',
    route_ended_before_destination:'The route follower ended before the destination. This failed attempt is saved.',
    dashboard_disconnected:'Dashboard connection lost. Reconnect, then resume driving.',
    dashboard_heartbeat_timeout:'Dashboard connection lease expired. Reconnect, then resume driving.',
    destination_reached:'Destination reached. The vehicle has stopped.',
    operator_stop:'Stopped by the operator.',
    simulator_shutdown:'The simulator was stopped. Use Restart to start the presentation.',
    command_timeout:'The latest driving command expired. Vehicle held.',
    presentation_route_timeout:'The route did not finish within the presentation time limit. This attempt is saved.',
    presentation_failed:'The presentation stopped after a failure. Its evidence is saved.',
    fresh_native_session:'Vehicle held after simulator startup. Select a destination or use Restart.',
    ya_rab_ostorha_sensor_fault:'Sensor processing could not recover. Use Restart to prepare a fresh run.',
    controls_released:'Driving controls released. Vehicle held.',
    emergency_stop:'Emergency stop active. Movement remains locked until explicitly released.',
    emergency_stop_released:'Emergency stop released. The vehicle is held until you start driving.',
    NAVIGATION:'Following the selected route.',
    page_closed:'The previous dashboard page closed. Vehicle held; start driving when ready.',
    ownership_taken:'Vehicle control moved to this dashboard. The vehicle remains held.',
  })[reason]||String(reason||'');
}

export function observationCurrent(value, provider, maxAge = .75) {
  const age = provider.telemetry?.timestamp - value?.timestamp_s;
  return provider.fresh && !provider.isReplay && Number.isFinite(value?.timestamp_s) &&
    Number.isFinite(age) && age >= -1e-6 && age <= maxAge &&
    (!value.session_id || value.session_id === provider.sessionId);
}

export function cockpitMeasurements(provider, vehicle) {
  const live = provider.fresh && !provider.isReplay;
  const safety = provider.safetySystem;
  const fault = /FAULT|UNAVAILABLE|SUSPENDED/.test(safety?.status || '');
  const motion = observationCurrent(provider.maneuver, provider) && !fault ? provider.maneuver : null;
  const observed = observationCurrent(safety, provider) && !fault ? safety : null;
  return {
    speed: provider.fresh ? vehicle.speedKmh : null,
    brake: provider.fresh && finite(vehicle.brake) && vehicle.brake <= 1 ? vehicle.brake * 100 : null,
    target: live && provider.controlMode !== 'MANUAL' ? provider.journey?.speed_kmh : null,
    gap: motion?.front_gap_m ?? observed?.measured_range_m ?? null,
    ttc: motion?.front_ttc_s ?? observed?.ttc_s ?? null,
    measurement: motion || observed,
  };
}

export function safetyNotice(provider) {
  if (!provider.fresh || provider.isReplay) return null;
  if (provider.controlMode === 'EMERGENCY_STOP') return {
    tone: 'danger', title: 'Emergency stop active',
    detail: 'Movement locked. Use Release emergency stop in the header, then start driving again.',
  };
  if(provider.controlMode==='PAUSED'&&provider.journey?.reason==='emergency_stop_released')return {
    tone:'neutral',title:'Emergency stop released',detail:'The lock is released. The vehicle remains held; use Restart or Resume driving when ready.'};
  if(provider.controlMode==='PAUSED'&&provider.lastDriveStop?.status!=='ERROR'&&
      (provider.journey?.status==='ARRIVED'||provider.route?.arrived))return {
    tone:'neutral',title:'Destination reached',detail:'The vehicle has arrived and stopped. Choose a new destination to drive again.'};
  if (provider.controlMode === 'PAUSED' && provider.route && ['PAUSED','ERROR'].includes(provider.journey?.status)) {
    const runtime=provider.stopDiagnostics?.runtime_fault;
    if(runtime?.exception_type==='ControlSceneTimeout')return {
      tone:'warning',title:'Driving stopped: control sensors fell behind',
      detail:'A synchronized control frame could not be recovered for one second. The vehicle is held and the failed recording is saved. Use Restart to prepare a fresh run.'};
    const stopped=provider.lastDriveStop;
    const reason=stopped?.detail || provider.stopDiagnostics?.reason || provider.journey?.reason;
    const names={focus_lost:'Driving was paused when the page lost focus',operator_stop:'Stopped by the operator',
      controls_released:'Driving controls were released',dashboard_heartbeat_timeout:'The dashboard connection lease expired'};
    const failed=stopped?.status==='ERROR';
    return {tone:failed?'warning':'neutral', title:failed?'Drive needs attention':'Driving paused',
      detail:(names[reason]||controlReasonText(reason)||'Vehicle held')+(failed?' · Use Restart to prepare a fresh run.':' · Use Resume driving here to continue.')};
  }
  if(provider.controlMode==='AUTOMATIC'&&provider.stopDiagnostics?.braking&&
      provider.stopDiagnostics?.decision_source==='NAVIGATION'&&/red traffic light/i.test(provider.stopDiagnostics.reason||''))return {
    tone:'neutral',title:'Waiting at a red light',detail:'The journey is active. Driving resumes automatically when the signal permits.'};
  if(provider.controlMode==='AUTOMATIC'&&provider.journey?.driving_mode==='HYBRID'&&provider.stopDiagnostics?.braking)return {
    tone:'warning',title:'Hybrid slowing or holding',detail:controlReasonText(provider.stopDiagnostics.reason)};
  const bypass=provider.maneuver;
  if(provider.controlMode==='AUTOMATIC'&&observationCurrent(bypass,provider,.15)&&bypass.action==='PREPARE_DRIVE')return {
    tone:'neutral',title:'Checking the road before driving',detail:'Measuring the route and surrounding traffic. Driving starts automatically.'};
  if(provider.controlMode==='AUTOMATIC'&&observationCurrent(bypass,provider,.15)&&
      (bypass?.scope==='LOW_SPEED_STATIONARY_OBSTACLE_BYPASS'||bypass?.action==='PREPARE_BYPASS')){
    const held=provider.stopDiagnostics?.braking;
    if(held&&['CONTROL_PROCESSING_DEADLINE','STALE_CONTROL_SCENE','AWAITING_CURRENT_SENSOR_FRAME'].includes(provider.stopDiagnostics?.reason))return {
      tone:'warning',title:'Waiting for a fresh control frame',detail:controlReasonText(provider.stopDiagnostics.reason)+' The journey remains active.'};
    const conflicts=(bypass.rejected||[]).flatMap(r=>r.evidence?.conflicts||[]);
    if(held&&bypass.action==='HOLD'&&conflicts.length&&conflicts.every(c=>c.source==='STATIONARY'&&c.point_m?.[0]<0))return {
      tone:'warning',title:'Waiting for clearance near the rear corner',
      detail:'A measured stationary object behind the vehicle limits the available maneuver. The journey remains active; the object type is unconfirmed.'};
    if(held&&provider.stopDiagnostics?.decision_source==='EXECUTION_SHIELD')return {
      tone:'warning',title:'Passing paused for clearance',detail:controlReasonText(provider.stopDiagnostics.reason)+' The journey remains active.'};
    if(bypass.action==='PREPARE_BYPASS')return {tone:'neutral',title:'Preparing to pass the stopped obstacle',
      detail:'Slowing down and measuring adjacent traffic before choosing a passing path.'};
    if(['FOLLOW','SLOW','DECELERATE'].includes(bypass.action)&&bypass.target_speed_kmh<=.5&&
        bypass.rejected?.some(r=>r.reason==='ADJACENT_ROUTE_BLOCKED'))return {
      tone:'warning',title:'Waiting: passing lane blocked',
      detail:'Another stationary obstacle blocks the passing route. The journey remains active and resumes when a verified route opens.'};
    if(bypass.action==='HOLD')return {tone:'warning',title:'Waiting for a verified passing path',
      detail:'The adjacent road or traffic does not yet permit this maneuver. '+controlReasonText(bypass.reason)};
    return {tone:'neutral',title:bypass.phase==='RETURN'?'Returning to the original lane':'Passing the stopped obstacle',
      detail:'Following the measured passing corridor at low speed. Requested route speed resumes after the obstacle is cleared.'};
  }
  if(provider.controlMode==='AUTOMATIC'&&provider.stopDiagnostics?.braking&&
      /vehicle footprint|blocked.*vehicle/i.test(provider.stopDiagnostics.reason||''))return {
    tone:'neutral',title:'Waiting for a vehicle on the route',detail:'A vehicle overlaps the planned path. The journey remains active and resumes when it clears.'};
  const safety = provider.safetySystem;
  if (!safety) return {tone:'neutral', title:'Safety unavailable', detail:'Waiting for safety telemetry. Inspect Diagnostics before driving.'};
  if (/FAULT|UNAVAILABLE/.test(safety.status || '')) return {
    tone:'danger', title:'Safety sensors unavailable', detail:safety.reason || 'Inspect Diagnostics before driving.',
  };
  if (/SUSPENDED/.test(safety.status || '')) return {
    tone:'warning', title:'Safety supervision suspended', detail:safety.reason || 'Inspect the active mode in Scenarios.',
  };
  if (!safety.active) return null;
  if(safety.status==='SENSOR_DELAY_HOLD')return {tone:'warning',title:'Waiting for a fresh sensor frame',detail:safety.reason};
  if(safety.risk==='PATH_CONFLICT'&&safety.path_conflict)return {
    tone:'warning',title:'Moving object approaching the route',
    detail:'Measured sideways movement may enter the driving path. Braking until it clears. Object type is unconfirmed.'};
  if(safety.risk==='FORWARD_COLLISION_RISK'&&Number.isFinite(safety.measured_range_m))return {
    tone:'warning',title:'Obstacle on the driving path',
    detail:'Braking for the measured obstacle ahead. Object type is unconfirmed.'};
  const releasing = /RELEAS/.test(safety.status || '');
  const holding = /HOLD/.test(safety.teacher_state || safety.status || '');
  return {
    tone:'warning',
    title:releasing ? 'Safety brake releasing' : holding ? 'Protective stop active' : 'Safety braking active',
    detail:safety.reason || 'The safety supervisor is overriding the driver.',
  };
}

export function safetyChip(provider) {
  if (provider.isReplay) return {label:'Recorded safety', tone:'neutral'};
  if (!provider.fresh) return {label:'Protection offline', tone:'neutral'};
  const s = provider.safetySystem;
  if (!s) return {label:'Safety unavailable', tone:'neutral'};
  if (provider.controlMode === 'EMERGENCY_STOP') return {label:'Emergency stopped', tone:'danger'};
  if (/FAULT|UNAVAILABLE/.test(s.status || '')) return {label:'Safety unavailable', tone:'danger'};
  if(provider.controlMode==='AUTOMATIC'&&provider.journey?.driving_mode==='BASELINE')return {label:'CARLA driver protection',tone:'protection'};
  if (s.status === 'STANDARD_DRIVER') return {label:'Normal · protection off', tone:'neutral'};
  if (!s.enabled) return {label:'Protection off', tone:'danger'};
  if (/SUSPENDED/.test(s.status || '')) return {label:'Protection suspended', tone:'warning'};
  if (s.active) return {label:'Safety override', tone:'warning'};
  return {label:s.experimental || s.controller==='MODEL' ? 'Experimental protection' : s.status==='STANDBY' ? 'Protection standby' : 'Protection active', tone:'protection'};
}

export function driverCaption(provider) {
  if(provider.isReplay)return 'Read only';
  if(!provider.fresh)return 'Driver offline';
  if(provider.controlMode==='EMERGENCY_STOP')return 'Emergency stop';
  if(provider.controlMode==='PAUSED')return provider.lastDriveStop?.status!=='ERROR'&&
    (provider.journey?.status==='ARRIVED'||provider.route?.arrived)?'Arrived':'Vehicle held';
  if(provider.safetySystem?.status==='SENSOR_DELAY_HOLD')return 'Waiting for sensors';
  if(provider.safetySystem?.active)return 'Safety override';
  if(provider.controlMode==='AUTOMATIC'&&provider.journey?.driving_mode==='HYBRID')return 'Hybrid driving';
  if(provider.controlMode==='AUTOMATIC'&&provider.journey?.driving_mode==='BASELINE')return 'CARLA normal driver';
  const m=provider.maneuver;
  if(provider.controlMode==='AUTOMATIC'&&observationCurrent(m,provider,.1)){
    if(m.phase==='REVERSING'&&m.action==='BACK_UP')return 'Repositioning · Reverse';
    if(m.phase==='CLEARING'&&m.selected_path)return 'Repositioning';
    if(m.phase==='SETTLE')return 'Repositioning · Stopping';
  }
  return provider.controlMode==='AUTOMATIC'?'Self Driving':provider.controlMode==='MANUAL'?'Manual · WASD':'Vehicle held';
}

export function perceptionCounts(result, provider) {
  const age = provider.telemetry?.timestamp - result?.timestamp_s;
  const compatible = provider.fresh && !provider.isReplay && result?.session_id === provider.sessionId &&
    Number.isFinite(age) && age >= 0 && Number.isInteger(result.frame_id) && result.frame_id <= provider.telemetry?.frame;
  if (!compatible || age >= .5 || !Array.isArray(result.detections)) return {
    vehicles:null, people:null, label:compatible ? 'Front detections delayed · ' + age.toFixed(1) + ' s' : 'Front detections unavailable',
  };
  const vehicleClasses = new Set(['car','truck','bus','motorcycle','bicycle','train']);
  return {
    vehicles:result.detections.filter(d => vehicleClasses.has(d.class)).length,
    people:result.detections.filter(d => d.class === 'person' || d.class === 'pedestrian').length,
    label:'Front camera · 2D detections · ' + age.toFixed(1) + ' s old',
  };
}

// Inference is from the fixed front sensor, not the selected chase/hood camera.
// An identical frame number alone does not make their image coordinates equal.
export function detectionFrameMatches(result, provider, displayed, front) {
  if (!provider.fresh || provider.isReplay || result?.session_id !== provider.sessionId ||
      !Number.isInteger(result?.frame_id) || result.frame_id !== displayed?.frame ||
      !Number.isFinite(result.timestamp_s) || !Number.isFinite(displayed?.timestamp) ||
      Math.abs(result.timestamp_s - displayed.timestamp) > 1e-6 ||
      !finite(result.width) || !finite(result.height) || !result.width || !result.height) return false;
  if (displayed.sensorId === 'frontCamera') return displayed.width === result.width && displayed.height === result.height;
  if (!front?.mountTransform || !displayed.mountTransform || !Number.isFinite(front.fovDeg) ||
      Math.abs(front.fovDeg - displayed.fovDeg) > 1e-6 ||
      Math.abs(result.width / result.height - displayed.width / displayed.height) > 1e-6) return false;
  const a = front.mountTransform, b = displayed.mountTransform;
  return ['pitch','yaw','roll'].every(k => Math.abs((a.rotation_deg?.[k] ?? 0) - (b.rotation_deg?.[k] ?? 0)) < 1e-6) &&
    a.position_m?.length === 3 && b.position_m?.length === 3 && a.position_m.every((v,i) => Number.isFinite(v) && Math.abs(v - b.position_m[i]) < 1e-6);
}

export function containedImageRect(bounds, width, height) {
  if (![bounds.width,bounds.height,width,height].every(v => Number.isFinite(v) && v > 0)) return null;
  const scale = Math.min(bounds.width / width, bounds.height / height);
  return {left:(bounds.width - width * scale)/2, top:(bounds.height - height * scale)/2, width:width * scale, height:height * scale};
}

export function validDetectionBox(detection, width, height) {
  const b = detection.xyxy;
  if (!Array.isArray(b) || b.length !== 4 || !b.every(Number.isFinite) || b[2] <= b[0] || b[3] <= b[1]) return null;
  const clipped = [Math.max(0,b[0]),Math.max(0,b[1]),Math.min(width,b[2]),Math.min(height,b[3])];
  return clipped[2] > clipped[0] && clipped[3] > clipped[1] ? clipped : null;
}
