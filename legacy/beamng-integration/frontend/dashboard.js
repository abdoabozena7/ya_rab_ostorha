import { BeamNGProvider } from './beamng-provider.js';
import { DrivingControls } from './controls.js';
import { telemetryText } from './telemetry.js';

const $ = id => document.getElementById(id);
const provider = new BeamNGProvider(), controls = new DrivingControls();
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
  if (!metadata?.frameAvailable || !provider.fresh || provider.sensorErrors.frontCamera) { clearCamera(); return; }
  if (cameraRequest || metadata.receivedMonotonic === cameraReceipt) return;
  const generation = cameraGeneration, request = new AbortController();
  cameraRequest = request;
  try {
    const response = await fetch('/api/simulation/camera.jpg', {cache: 'no-store', signal: request.signal});
    if (!response.ok) throw new Error('No live camera frame');
    const blob = await response.blob();
    if (!provider.fresh || generation !== cameraGeneration) return;
    if (cameraUrl) URL.revokeObjectURL(cameraUrl);
    cameraUrl = URL.createObjectURL(blob); cameraReceipt = metadata.receivedMonotonic;
    $('authoritativeCamera').src = cameraUrl; $('authoritativeCamera').hidden = false;
    $('cameraUnavailable').hidden = true; $('cameraActivity').textContent = 'BEAMNG RGB';
    const timestamp = response.headers.get('X-Sensor-Time');
    $('cameraTimestamp').textContent = timestamp === null ? 't unavailable' : `t ${Number(timestamp).toFixed(3)} s`;
    $('cameraMetadata').textContent = `FOV ${metadata.fovDeg ?? '—'}° · mount ${JSON.stringify(metadata.positionVehicleM ?? null)}`;
  } catch (error) { if (error.name !== 'AbortError') clearCamera(); }
  finally { if (cameraRequest === request) cameraRequest = null; }
}

function refresh() {
  const state = provider.getVehicleState(), live = provider.fresh;
  const controllable = live && provider.controller && document.hasFocus() && !document.hidden;
  if (wasControllable !== controllable) {
    clearControls(); wasControllable = controllable;
    if (!live) { paused = false; $('pauseBtn').textContent = 'Pause'; }
  }
  const connectedLabel = live ? 'BEAMNG CONNECTED' : 'BEAMNG NOT AVAILABLE';
  $('cityStatus').textContent = connectedLabel; $('cityStatus').dataset.connected = String(live);
  $('simulationState').textContent = connectedLabel; $('connectionDot').classList.toggle('connected', live);
  $('connectionDetail').textContent = provider.status;
  $('phoneStatus').textContent = provider.status;
  $('providerStatus').textContent = provider.status;
  $('speedVal').textContent = numeric(state.speedMps == null ? null : Math.abs(state.speedMps) * 3.6, '', 0);
  $('speedFill').style.width = `${Number.isFinite(state.speedMps) ? Math.min(100, Math.abs(state.speedMps) * 3.6 / 2) : 0}%`;
  $('gearVal').textContent = state.gear ?? '—';
  $('rpmVal').textContent = numeric(state.engineRPM, '', 0);
  $('engineVal').textContent = state.engineRunning == null ? '—' : state.engineRunning ? 'Running' : 'Stopped';
  $('fuelVal').textContent = numeric(state.fuelLevelL, ' L');
  $('throttleVal').textContent = numeric(state.throttle == null ? null : state.throttle * 100, '%');
  $('brakeVal').textContent = numeric(state.brake == null ? null : state.brake * 100, '%');
  $('steerVal').textContent = numeric(state.steeringWheelAngleRad == null ? null : state.steeringWheelAngleRad * 180 / Math.PI, '°');
  $('accelVal').textContent = numeric(state.accelerationMps2, ' m/s²');
  $('timeVal').textContent = numeric(state.timestamp, ' s', 3);
  $('damageVal').textContent = numeric(state.damageTotal);
  $('positionVal').textContent = state.positionWorldM ? `X/Y/Z ${state.positionWorldM.map(v => numeric(v)).join(' / ')} m` : 'Position unavailable';
  $('headingVal').textContent = Number.isFinite(state.headingRad) ? `Heading ${numeric(state.headingRad * 180 / Math.PI, '°')} from +Y` : 'Heading unavailable';
  $('minimapView').firstElementChild.textContent = live ? 'Road geometry pending' : 'BeamNG map not loaded';
  $('performance').textContent = `RTT ${numeric(provider.latencyMs, ' ms')}`;
  for (const id of ['pauseBtn', 'resetBtn', 'gearSelect']) $(id).disabled = !controllable;
  $('controlStatus').textContent = !live ? 'Controls unavailable' : !provider.controller ? 'Read only · another dashboard owns controls' : !controllable ? 'Focus this dashboard to drive' : paused ? 'Pause requested · commands released' : 'Keyboard controls active';
  const sensors = Object.keys(provider.sensorMetadata);
  $('sensorStatus').textContent = sensors.length ? sensors.map(name => `${name}: ${provider.sensorErrors[name] ? 'error' : 'receiving'}`).join(' · ') : live ? 'Sensor suite disabled for the first connection checkpoint.' : 'Waiting for BeamNG sensors.';
  $('cameraFps').textContent = `${numeric(provider.sensorRates.frontCamera)} poll Hz`;
  $('debugTelemetry').textContent = telemetryText(state, {remote: true, latencyMs: provider.latencyMs,
    sensorRates: provider.sensorRates, sensorErrors: provider.sensorErrors});
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
  clearControls(); paused = !paused; provider.setPaused(paused);
  $('pauseBtn').textContent = paused ? 'Resume' : 'Pause';
};
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
