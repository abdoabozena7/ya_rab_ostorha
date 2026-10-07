import { SimulationClient } from './simulation-client.js';
import { DrivingControls } from './controls.js';
import { telemetryText } from './telemetry.js';
import { sensorFrameKey, matchesSensorResponse } from './sensor-frame.js';

const $ = id => document.getElementById(id);
const provider = new SimulationClient(), controls = new DrivingControls();
const numeric = (value, suffix = '', digits = 1) => Number.isFinite(value) ? `${value.toFixed(digits)}${suffix}` : '—';
let wasControllable = false, paused = false, lastGear = null, cameraReceipt = null;
let cameraUrl = null, cameraRequest = null, cameraGeneration = 0;

function clearControls() {
  controls.clear();
  const nativeGear = provider.getVehicleState().gear;
  controls.gear = nativeGear === 'R' ? -1 : nativeGear === 'N' ? 0 : 1;
  lastGear = controls.gear; $('gearSelect').value = 'D';
  provider.releaseControls();
}
function clearCamera() {
  cameraGeneration++; cameraRequest?.abort(); cameraRequest = null;
  if (cameraUrl) URL.revokeObjectURL(cameraUrl);
  cameraUrl = cameraReceipt = null;
  $('authoritativeCamera').hidden = true; $('authoritativeCamera').removeAttribute('src');
  $('cameraUnavailable').hidden = false; $('cameraActivity').textContent = 'UNAVAILABLE';
  $('cameraTimestamp').textContent = 't —'; $('cameraMetadata').textContent = 'FOV / transform unavailable';
}
async function updateCamera(metadata) {
  const key = sensorFrameKey(metadata);
  if (key === null || !provider.fresh || provider.sensorErrors.frontCamera) { clearCamera(); return; }
  if (cameraRequest || key === cameraReceipt) return;
  const generation = cameraGeneration, request = new AbortController();
  cameraRequest = request;
  try {
    const response = await fetch('/api/simulation/camera.jpg', {cache: 'no-store', signal: request.signal});
    if (!response.ok) throw new Error('No live camera frame');
    // Playback/native callbacks may advance while the HTTP request is in flight.
    // Retry against the next snapshot instead of attaching a different frame's metadata.
    if (!matchesSensorResponse(metadata, response.headers)) return;
    const blob = await response.blob();
    if (!provider.fresh || generation !== cameraGeneration) return;
    if (cameraUrl) URL.revokeObjectURL(cameraUrl);
    cameraUrl = URL.createObjectURL(blob); cameraReceipt = key;
    $('authoritativeCamera').src = cameraUrl; $('authoritativeCamera').hidden = false;
    $('cameraUnavailable').hidden = true; $('cameraActivity').textContent = provider.isReplay ? 'REPLAY RGB' : 'CARLA RGB';
    const timestamp = response.headers.get('X-Sensor-Time');
    $('cameraTimestamp').textContent = timestamp === null ? 't unavailable' : `t ${Number(timestamp).toFixed(3)} s`;
    $('cameraMetadata').textContent = `Frame ${response.headers.get('X-Sensor-Frame') ?? '—'} · FOV ${metadata.fovDeg ?? '—'}° · mount ${JSON.stringify(metadata.mountTransform ?? null)}`;
  } catch (error) { if (error.name !== 'AbortError') clearCamera(); }
  finally { if (cameraRequest === request) cameraRequest = null; }
}

function refresh() {
  if ((provider.connected || provider.isReplay) && !provider.fresh) provider.disconnect('Observation stream stale; commands suspended');
  const state = provider.getVehicleState(), live = provider.fresh;
  const nativeOwner = live && !provider.isReplay && provider.controller && document.hasFocus() && !document.hidden;
  const controllable = nativeOwner && ['MANUAL', 'ASSISTED', 'AI'].includes(provider.controlMode);
  paused = provider.controlMode === 'PAUSED';
  if (wasControllable !== controllable) {
    clearControls(); wasControllable = controllable;
    if (!live) { paused = false; $('pauseBtn').textContent = 'Pause'; }
  }
  const connectedLabel = provider.isReplay ? 'MODE: REPLAY' : `CARLA — ${live ? 'CONNECTED' : provider.phase === 'CONNECTED' ? 'DISCONNECTED' : provider.phase}`;
  $('controlMode').textContent = provider.controlMode.replaceAll('_', ' ');
  $('providerTitle').textContent = provider.isReplay ? 'RECORDED REPLAY' : 'CARLA 0.9.16';
  $('missionText').textContent = provider.isReplay ? 'Recorded observations · No simulator running' : 'One vehicle · CARLA 0.9.16';
  $('cameraSource').textContent = provider.isReplay ? 'RECORDED SENSOR' : 'CARLA SENSOR';
  $('cityStatus').textContent = connectedLabel; $('cityStatus').dataset.connected = String(live && provider.connected);
  $('simulationState').textContent = connectedLabel; $('connectionDot').classList.toggle('connected', live && provider.connected);
  $('connectionDetail').textContent = provider.status;
  $('phoneStatus').textContent = provider.status;
  $('providerStatus').textContent = provider.status;
  $('speedVal').textContent = numeric(state.speedMps == null ? null : Math.abs(state.speedMps) * 3.6, '', 0);
  $('speedFill').style.width = `${Number.isFinite(state.speedMps) ? Math.min(100, Math.abs(state.speedMps) * 3.6 / 2) : 0}%`;
  $('gearVal').textContent = state.gear ?? '—';
  $('versionVal').textContent = provider.world.version ?? '—';
  $('mapVal').textContent = provider.world.map?.split('/').at(-1) ?? '—';
  $('frameVal').textContent = state.frame ?? '—';
  $('throttleVal').textContent = numeric(state.throttle == null ? null : state.throttle * 100, '%');
  $('brakeVal').textContent = numeric(state.brake == null ? null : state.brake * 100, '%');
  $('steerVal').textContent = numeric(state.steeringInput);
  $('accelVal').textContent = numeric(state.accelerationMps2, ' m/s²');
  $('timeVal').textContent = numeric(state.timestamp, ' s', 3);
  $('reverseVal').textContent = state.reverse == null ? '—' : state.reverse ? 'Yes' : 'No';
  $('positionVal').textContent = state.positionWorldM ? `X/Y/Z ${state.positionWorldM.map(v => numeric(v)).join(' / ')} m` : 'Position unavailable';
  $('headingVal').textContent = Number.isFinite(state.headingRad) ? `Heading ${numeric(state.headingRad * 180 / Math.PI, '°')} from +X toward +Y` : 'Heading unavailable';
  $('minimapView').firstElementChild.textContent = live ? 'Road geometry pending' : 'CARLA map not loaded';
  $('performance').textContent = `RTT ${numeric(provider.latencyMs, ' ms')}`;
  $('gearSelect').disabled = !controllable;
  for (const id of ['pauseBtn', 'resetBtn', 'emergencyStopBtn']) $(id).disabled = !nativeOwner;
  $('pauseBtn').textContent = provider.controlMode === 'EMERGENCY_STOP' ? 'Acknowledge stop' : paused ? 'Resume' : 'Pause';
  $('replayPauseBtn').hidden = !provider.isReplay;
  $('replayPauseBtn').textContent = provider.replay?.paused ? 'Resume replay' : 'Pause replay';
  $('controlStatus').textContent = provider.isReplay ? 'REPLAY · All driving commands disabled' : !live ? 'Controls unavailable' : !provider.controller ? 'Read only · another dashboard owns controls' : provider.controlMode === 'EMERGENCY_STOP' ? 'EMERGENCY STOP · Acknowledge, then resume manually' : paused ? 'PAUSED · Resume explicitly' : !controllable ? 'Focus this dashboard to drive' : 'Keyboard controls active';
  const sensors = Object.keys(provider.sensorMetadata);
  $('sensorStatus').textContent = sensors.length ? sensors.map(name => `${name}: ${provider.sensorErrors[name] ? 'error' : 'receiving'}`).join(' · ') : live ? 'Sensor suite disabled for the first connection checkpoint.' : 'RGB · Depth · Radar · LiDAR · IMU · GNSS · Collision: unavailable';
  $('cameraFps').textContent = `${numeric(provider.sensorRates.frontCamera)} Hz`;
  $('debugTelemetry').textContent = telemetryText(state, {remote: true, latencyMs: provider.latencyMs,
    sensorRates: provider.sensorRates, sensorErrors: provider.sensorErrors, world: provider.world, mode: provider.controlMode});
  if (controllable && !paused) {
    const command = controls.sample(state.speedMps, performance.now());
    if (command.gear !== lastGear) { provider.setGear(command.gear); lastGear = command.gear; }
    provider.updateControls(command);
  }
  updateCamera(provider.sensorMetadata.frontCamera);
}

function toggle(id, button) { const panel = $(id); panel.hidden = !panel.hidden; $(button).setAttribute('aria-expanded', String(!panel.hidden)); }
$('phoneToggleBtn').onclick = () => toggle('inGamePhone', 'phoneToggleBtn');
$('routeBtn').onclick = () => toggle('routePanel', 'routeBtn');
$('sensorBtn').onclick = () => toggle('sensorPanel', 'sensorBtn');
$('reconnectBtn').onclick = () => provider.connect();
$('gearSelect').onchange = () => { controls.setMode($('gearSelect').value); provider.releaseControls(); };
$('resetBtn').onclick = () => { clearControls(); provider.resetVehicle(); };
$('pauseBtn').onclick = () => {
  clearControls();
  if (provider.controlMode === 'EMERGENCY_STOP') { provider.acknowledgeStop(); return; }
  paused = !paused; provider.setPaused(paused);
  $('pauseBtn').textContent = paused ? 'Resume' : 'Pause';
};
$('emergencyStopBtn').onclick = () => { controls.clear(); provider.emergencyStop(); };
$('replayPauseBtn').onclick = () => provider.setReplayPaused(!provider.replay?.paused).catch(error => { $('connectionDetail').textContent = error.message; });
$('hideCameraBtn').onclick = () => { $('cameraCard').hidden = !$('cameraCard').hidden; $('hideCameraBtn').textContent = $('cameraCard').hidden ? 'Show camera' : 'Hide camera'; };
document.addEventListener('keydown', event => {
  if (/INPUT|SELECT|TEXTAREA/.test(event.target.tagName)) return;
  if (['KeyW', 'KeyS', 'KeyA', 'KeyD', 'Space'].includes(event.code)) {
    event.preventDefault();
    if (!event.repeat && provider.fresh && provider.controller && !paused) controls.keys.add(event.code);
  }
  if (!event.repeat && event.code === 'KeyP') toggle('inGamePhone', 'phoneToggleBtn');
});
document.addEventListener('keyup', event => controls.keys.delete(event.code));
window.addEventListener('blur', clearControls);
document.addEventListener('visibilitychange', () => { if (document.hidden) clearControls(); });
window.addEventListener('pagehide', () => { clearControls(); clearCamera(); provider.close(); });
provider.connect(); refresh(); setInterval(refresh, 50);
