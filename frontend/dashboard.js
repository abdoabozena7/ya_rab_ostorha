import {SimulationClient} from './simulation-client.js';
import {DrivingControls} from './controls.js';
import {telemetryText} from './telemetry.js';
import {sensorFrameKey,matchesSensorResponse} from './sensor-frame.js';
import {DashboardTools} from './dashboard-tools.js';
import {DRIVING_KEYS,isEditableTarget,drivingInputAllowed} from './input-policy.js';
import {PerceptionView} from './perception-view.js';
const $ = id => document.getElementById(id);
const provider = new SimulationClient(), controls = new DrivingControls();
const perception = new PerceptionView(provider);
const number = (value,suffix='',digits=1) => Number.isFinite(value) ? value.toFixed(digits)+suffix : '—';
let manualArmed = false, manualRequestedUntil = 0, manualOverridePending = false, lastMode = null;
let lastGear = null, seenSession = null, cameraReceipt = null, cameraUrl = null, cameraRequest = null, cameraGeneration = 0;
const tools = new DashboardTools(provider,controls,clearControls,{canInput,intervene});
function canInput() {
  return drivingInputAllowed({fresh:provider.fresh,replay:provider.isReplay,owner:provider.controller,
    focused:document.hasFocus()&&!document.hidden,modal:!!tools.panel,mode:provider.controlMode,armed:manualArmed});
}
function resetKeys() {
  controls.clear(); controls.setMode($('gearSelect').value);
  controls.gear = controls.mode === 'R' ? -1 : controls.mode === 'N' ? 0 : 1;
  lastGear = null; manualOverridePending = false;
}
function clearControls(reason='operator_stop') {
  resetKeys(); manualArmed = false; manualRequestedUntil = 0;
  provider.stopDriving(reason);
}
function sendManual(state) {
  const command = controls.sample(state.speedMps,performance.now());
  if (command.gear !== lastGear) { provider.setGear(command.gear); lastGear = command.gear; }
  if (provider.updateControls(command)) manualOverridePending = false;
}
function intervene() {
  if (provider.controlMode !== 'AUTOMATIC') return;
  manualArmed = true; manualOverridePending = true; $('drivingMode').value = 'MANUAL';
  $('gearSelect').value = 'D'; controls.setMode('D'); lastGear = null;
  sendManual(provider.getVehicleState());
}
function clearCamera() {
  cameraGeneration++; cameraRequest?.abort(); cameraRequest = null;
  if (cameraUrl) URL.revokeObjectURL(cameraUrl);
  cameraUrl = cameraReceipt = null; $('authoritativeCamera').hidden = true;
  $('authoritativeCamera').removeAttribute('src'); $('cameraUnavailable').hidden = false;
  $('cameraActivity').textContent = 'Image unavailable'; $('cameraTimestamp').textContent = 't —';
}
async function updateCamera(metadata) {
  const key = sensorFrameKey(metadata);
  if (key === null || !provider.fresh || provider.sensorErrors.frontCamera) { clearCamera(); return; }
  if (cameraRequest || key === cameraReceipt) return;
  const generation = cameraGeneration, request = new AbortController(); cameraRequest = request;
  try {
    const response = await fetch('/api/simulation/camera.jpg?frame_id='+metadata.frame,{cache:'no-store',signal:request.signal});
    if (!response.ok || !matchesSensorResponse(metadata,response.headers)) return;
    const blob = await response.blob();
    if (!provider.fresh || generation !== cameraGeneration) return;
    if (cameraUrl) URL.revokeObjectURL(cameraUrl);
    cameraUrl = URL.createObjectURL(blob); cameraReceipt = key;
    $('authoritativeCamera').src = cameraUrl; $('authoritativeCamera').hidden = false;
    $('cameraUnavailable').hidden = true; $('cameraActivity').textContent = provider.isReplay ? 'REPLAY · Recorded image' : 'RGB · Live image';
    $('cameraTimestamp').textContent = 't '+number(Number(response.headers.get('X-Sensor-Time')),' s',3);
    $('cameraMetadata').textContent = 'Frame '+response.headers.get('X-Sensor-Frame')+
      ' · '+metadata.width+'×'+metadata.height+' · FOV '+metadata.fovDeg+
      '° · mount '+JSON.stringify(metadata.mountTransform ?? null);
  } catch(error) { if (error.name !== 'AbortError') clearCamera(); }
  finally { if (cameraRequest === request) cameraRequest = null; }
}
function refresh() {
  if ((provider.connected||provider.isReplay)&&!provider.fresh) {
    manualArmed = false; provider.disconnect('Data stream lost; driving stopped');
  }
  if (provider.sessionId !== seenSession) {
    seenSession = provider.sessionId; manualArmed = false; resetKeys(); clearCamera();
  }
  const state = provider.getVehicleState(), live = provider.fresh;
  $('cameraEmptyTitle').textContent = live ? 'Waiting for camera image' : 'Waiting for simulator connection';
  $('cameraEmptyDescription').textContent = live ? 'No image available yet. Inspect sensor status in Details.' : 'Connect CARLA to view camera and telemetry, then enable driving.';
  $('connectionSetupBtn').hidden = live || provider.isReplay;
  if (!live) $('mapEmpty').hidden = false;
  if (!live || provider.isReplay || !document.hasFocus() || document.hidden ||
      performance.now()>manualRequestedUntil && (!provider.controller ||
      provider.controlMode === 'PAUSED' && lastMode === 'MANUAL' || provider.controlMode === 'EMERGENCY_STOP')) manualArmed = false;
  lastMode = provider.controlMode;
  const controllable = canInput();
  const connectedLabel = provider.isReplay ? 'REPLAY — real recording' : provider.restarting ? 'CARLA — RESTARTING'
    : 'CARLA — '+(live&&provider.connected?'CONNECTED':'DISCONNECTED');
  $('cityStatus').textContent = $('simulationState').textContent = connectedLabel;
  $('connectionDot').classList.toggle('connected',live&&provider.connected);
  $('missionText').textContent = provider.isReplay ? 'Replay · Driving disabled' : provider.population ?
    provider.population.actual.vehicles+' traffic vehicle · '+provider.population.actual.pedestrians+' walkers' : 'Waiting for population CARLA';
  const modeNames = {MANUAL:manualArmed?'Manual driving':'Vehicle held by command safety',AUTOMATIC:'Destination journey',PAUSED:state.speedKmh>.54?'Stopping vehicle':'Vehicle stopped',
    EMERGENCY_STOP:'Emergency stop',DISCONNECTED:'Simulator disconnected',REPLAY:'Replay'};
  $('controlMode').textContent = modeNames[provider.controlMode] || provider.controlMode;
  $('controlSource').textContent = provider.controlSource || '';
  $('connectionDetail').textContent = provider.isReplay ? 'Recorded data view; no simulator controls.'
    : live ? (provider.controller?'Take control from this page.':'Another page controls the vehicle; take control in Settings.')
    : provider.restarting ? 'Restarting CARLA and reconnecting…' : 'Simulator disconnected. Open connection setup to continue.';
  $('phoneStatus').textContent = live ? 'Destinations from map '+(provider.world.map?.split('/').at(-1)||'CARLA') : 'Waiting for simulator connection.';
  $('providerStatus').textContent = provider.status;
  $('providerTitle').textContent = provider.isReplay ? 'Recorded camera' : 'Camera CARLA';
  $('cameraSource').textContent = provider.isReplay ? 'RECORDED RGB' : 'CARLA RGB';
  $('speedVal').textContent = number(state.speedKmh,'',0); $('gearVal').textContent = state.gear ?? '—';
  $('throttleVal').textContent = number(state.throttle==null?null:state.throttle*100,'%');
  $('brakeVal').textContent = number(state.brake==null?null:state.brake*100,'%');
  $('steerVal').textContent = number(state.steeringInput);
  $('versionVal').textContent = provider.world.version ?? '—';
  $('mapVal').textContent = provider.world.map?.split('/').at(-1) ?? '—';
  $('frameVal').textContent = state.frame ?? '—'; $('timeVal').textContent = number(state.timestamp,' s',3);
  $('accelVal').textContent = number(state.accelerationMps2,' m/s²');
  $('reverseVal').textContent = state.reverse==null?'—':state.reverse?'Yes':'No';
  $('positionVal').textContent = state.positionWorldM ? 'X / Y / Z: '+state.positionWorldM.map(v=>number(v)).join(' / ')+' m' : 'Position unavailable';
  $('headingVal').textContent = state.rotationDeg ? 'Yaw '+number(state.rotationDeg.yaw,'°') : '';
  $('gearSelect').disabled = !controllable || provider.controlMode === 'AUTOMATIC';
  $('gearSelect').title = !$('gearSelect').disabled ? '' : provider.isReplay ? 'Replay is read-only; driving is disabled'
    : !live ? 'Waiting for native connection to CARLA' : provider.controlMode === 'AUTOMATIC' ? 'Journey controller selects the gear; take manual control to change it'
    : !provider.controller ? 'Take control in connection settings first' : 'Enable manual driving to change gear';
  $('controlStatus').textContent = provider.isReplay ? 'REPLAY · Driving disabled' : !document.hasFocus()||document.hidden
    ? 'Focus the dashboard to use the keyboard' : controllable ? 'WASD ready · W+Shift More throttle' : 'Keyboard stopped — Enable driving first';
  const sensorCount = Object.keys(provider.sensorMetadata).length;
  $('sensorStatus').textContent = provider.isReplay ? sensorCount+' sensors from recorded frame · recorded collision events' :
    live ? sensorCount+' periodic sensors receiving data · Collision sensor is event-driven' : 'Sensors unavailable';
  $('cameraFps').textContent = number(provider.performance?.sensorWallRatesHz?.frontCamera)+' /wall seconds · '+number(provider.sensorRates.frontCamera)+' Hz sim';
  const perf = provider.performance || {}, gpu = perf.gpu;
  $('performance').textContent = 'actual steps: '+number(perf.nativeTickRateHz)+' /s · Simulation time: '+
    (provider.world.fixedDeltaSeconds?number(1/provider.world.fixedDeltaSeconds)+' Hz':'—')+
    (gpu?' · VRAM '+gpu.usedMiB+' / '+gpu.totalMiB+' MiB':'')+' · FPS Rendering unavailable';
  $('debugTelemetry').textContent = telemetryText(state,{remote:true,latencyMs:provider.latencyMs,
    sensorRates:provider.sensorRates,sensorErrors:provider.sensorErrors,world:provider.world,mode:provider.controlMode});
  $('replayPauseBtn').hidden = !provider.isReplay;
  $('replayPauseBtn').textContent = provider.replay?.paused ? 'Resume replay' : 'Pause replay';
  if (controllable && (provider.controlMode === 'MANUAL' ||
      provider.controlMode === 'AUTOMATIC' && (manualOverridePending||controls.keys.size>0))) sendManual(state);
  if (live&&provider.controller&&!provider.isReplay&&document.hasFocus()&&!document.hidden&&
      ['STARTING','RUNNING'].includes(provider.journey?.status) && !manualOverridePending) provider.journeyHeartbeat();
  updateCamera(provider.sensorMetadata.frontCamera);
  tools.render(state,controllable);
  perception.update();
}
$('startDrivingBtn').onclick = () => {
  resetKeys(); manualArmed = true; manualRequestedUntil = performance.now()+1000;
  $('drivingMode').value = 'MANUAL';
  provider.startDriving(); document.activeElement?.blur(); $('drivingInstruction').textContent = 'Enable manual driving…';
};
function startJourney() {
  const speed = Number($('journeySpeed').value);
  if (!Number.isFinite(speed) || speed < 5 || speed > 30) {
    $('operationStatus').textContent = 'Choose a speed between 5 and 30 km/h.'; return;
  }
  tools.close(false); resetKeys(); manualArmed = false; manualRequestedUntil = 0;
  $('drivingMode').value = 'AUTOMATIC';
  if (provider.startJourney(speed)) $('journeyStatus').textContent = 'Starting destination journey…';
  document.activeElement?.blur();
}
$('startJourneyBtn').onclick = $('phoneJourneyBtn').onclick = $('driveJourneyBtn').onclick = startJourney;
$('journeySpeed').onchange = () => {
  const speed = Number($('journeySpeed').value);
  if (!Number.isFinite(speed) || speed < 5 || speed > 30) {
    $('operationStatus').textContent = 'Choose a speed between 5 and 30 km/h.'; return;
  }
  if (provider.controlMode === 'AUTOMATIC') provider.journeySpeed(speed);
};
$('drivingMode').onchange = () => { clearControls(); };
$('gearSelect').onchange = () => { controls.setMode($('gearSelect').value); provider.releaseControls(); lastGear = null; };
$('pauseBtn').onclick = () => clearControls();
$('resetBtn').onclick = () => { clearControls(); provider.resetVehicle(); };
$('emergencyStopBtn').onclick = () => { clearControls(); provider.emergencyStop(); };
$('acknowledgeStopBtn').onclick = () => { clearControls(); provider.acknowledgeStop(); };
$('replayPauseBtn').onclick = () => provider.setReplayPaused(!provider.replay?.paused).catch(e=>{$('operationStatus').textContent=e.message;});
document.addEventListener('keydown',event => {
  if (isEditableTarget(event.target)) return;
  if (DRIVING_KEYS.has(event.code)) {
    event.preventDefault();
    if (provider.controlMode === 'AUTOMATIC' && event.code.startsWith('Shift')) return;
    if (!event.repeat&&canInput()) { controls.keys.add(event.code); intervene(); }
  }
  if (!event.repeat&&event.code === 'KeyP') tools.toggle('inGamePhone','phoneToggleBtn');
});
document.addEventListener('keyup',event => controls.keys.delete(event.code));
window.addEventListener('blur',()=>clearControls('focus_lost'));
document.addEventListener('visibilitychange',()=>{if(document.hidden)clearControls('focus_lost');});
window.addEventListener('pagehide',()=>{clearControls('page_closed');clearCamera();provider.close();});
provider.connect(); refresh(); setInterval(refresh,50);
