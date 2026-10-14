// Display rules only. These checks never issue controls or change safety limits.
const finite = value => Number.isFinite(value) && value >= 0;
export const metricText = (value, digits = 0) => finite(value) ? value.toFixed(digits) : '—';

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
    detail: 'Movement locked. Use فك إيقاف الطوارئ in the header, then start driving again.',
  };
  if(provider.controlMode==='PAUSED'&&provider.lastDriveStop?.status!=='ERROR'&&
      (provider.journey?.status==='ARRIVED'||provider.route?.arrived))return {
    tone:'neutral',title:'وصلت للوجهة',detail:'العربية وصلت وتوقفت. اختار وجهة جديدة لبدء مشوار آخر.'};
  if (provider.controlMode === 'PAUSED' && provider.route && ['PAUSED','ERROR'].includes(provider.journey?.status)) {
    const stopped=provider.lastDriveStop;
    const reason=stopped?.detail || provider.stopDiagnostics?.reason || provider.journey?.reason;
    const names={focus_lost:'القيادة توقفت عند فقدان تركيز الصفحة',operator_stop:'إيقاف العربية بطلب المستخدم',
      controls_released:'أوامر القيادة اتقفلت',dashboard_heartbeat_timeout:'انقطع اتصال أوامر القيادة'};
    return {tone:stopped?.status==='ERROR'?'warning':'neutral', title:'القيادة متوقفة',
      detail:(names[reason]||reason||'العربية متوقفة')+' · اضغط استئناف القيادة للمتابعة.'};
  }
  if(provider.controlMode==='AUTOMATIC'&&provider.stopDiagnostics?.braking&&
      provider.stopDiagnostics?.decision_source==='NAVIGATION'&&/red traffic light/i.test(provider.stopDiagnostics.reason||''))return {
    tone:'neutral',title:'انتظار الإشارة الحمراء',detail:'المشوار شغّال؛ العربية تتحرك تلقائيًا لما الإشارة تسمح.'};
  const safety = provider.safetySystem;
  if (!safety) return {tone:'neutral', title:'Safety unavailable', detail:'Waiting for safety telemetry. Inspect Diagnostics before driving.'};
  if (/FAULT|UNAVAILABLE/.test(safety.status || '')) return {
    tone:'danger', title:'Safety sensors unavailable', detail:safety.reason || 'Inspect Diagnostics before driving.',
  };
  if (/SUSPENDED/.test(safety.status || '')) return {
    tone:'warning', title:'Safety supervision suspended', detail:safety.reason || 'Inspect the active mode in Scenarios.',
  };
  if (!safety.active) return null;
  if(safety.status==='SENSOR_DELAY_HOLD')return {tone:'warning',title:'انتظار فريم حساسات جديد',detail:safety.reason};
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
