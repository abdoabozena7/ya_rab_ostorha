import {presentationUI,updatePresentation,showWorkspace} from './presentation-ui.js';
import {installTrafficPreparation} from './traffic-preparation.js';
import {installCitySetup} from './city-setup.js';
import {installGuidedDrive} from './guided-drive.js';
import {keepJourneyOnInspection,journeyHeartbeatAllowed} from './journey-continuity.js';
import {SimulationClient} from './simulation-client.js';
import {DrivingControls} from './controls.js';
import {telemetryText} from './telemetry.js';
import {sensorFrameKey,matchesSensorResponse} from './sensor-frame.js';
import {DashboardTools} from './dashboard-tools.js';
import {DRIVING_KEYS,isEditableTarget,drivingInputAllowed} from './input-policy.js';
import {PerceptionView} from './perception-view.js';
import {PredictionView} from './prediction-view.js';
import {installMotionReadout} from './motion-readout.js';
import {installComparisonV2} from './comparison-v2.js';
import {installDrivingStudio} from './driving-studio.js';
import {installLightCockpit} from './light-cockpit.js';
import {installDemoDrive} from './demo-drive.js';
const $ = id => document.getElementById(id);
const provider = new SimulationClient(), controls = new DrivingControls();
presentationUI(provider);
const perception = new PerceptionView(provider);
const predictionView = new PredictionView(provider);
const comparisonV2 = installComparisonV2(provider,()=>{resetKeys();manualArmed=false;manualRequestedUntil=0;});
let displayedCamera = null;
const number = (value,suffix='',digits=1) => Number.isFinite(value) ? value.toFixed(digits)+suffix : '—';
let manualArmed = false, manualRequestedUntil = 0, manualOverridePending = false, lastMode = null;
let lastGear = null, seenSession = null, cameraReceipt = null, cameraUrl = null, cameraRequest = null, cameraGeneration = 0;
const tools = new DashboardTools(provider,controls,clearControls,{canInput,isManualArmed:()=>manualArmed});
const trafficPreparation = installTrafficPreparation(provider,clearControls);
const citySetup = installCitySetup(provider,trafficPreparation.preparation,tools,startJourney);
const guided = installGuidedDrive(provider,trafficPreparation.preparation,tools,startJourney,clearControls,predictionView);
const motionReadout=installMotionReadout(provider,predictionView);
const studio=installDrivingStudio(provider,guided,predictionView,tools);
const cockpit=installLightCockpit(provider,tools,perception,predictionView,mode=>startJourney(mode));
const demoDrive=installDemoDrive(provider,tools,clearControls);
$('stopSimulatorBtn').onclick=()=>{clearControls('simulator_shutdown');provider.stopSimulator();};
$('resetSimulatorBtn').onclick=()=>{resetKeys();manualArmed=false;manualRequestedUntil=0;clearCamera();provider.resetSimulation();};
function canInput() {
  if (document.body.dataset.workspace !== 'drive') return false;
  return drivingInputAllowed({fresh:provider.fresh,replay:provider.isReplay,owner:provider.controller,
    focused:document.hasFocus()&&!document.hidden,modal:!!tools.panel||!!document.querySelector('dialog[open]'),mode:provider.controlMode,armed:manualArmed});
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
function clearCamera() {
  displayedCamera = null;
  cameraGeneration++; cameraRequest?.abort(); cameraRequest = null;
  if (cameraUrl) URL.revokeObjectURL(cameraUrl);
  cameraUrl = cameraReceipt = null; $('authoritativeCamera').hidden = true;
  $('authoritativeCamera').removeAttribute('src'); $('cameraUnavailable').hidden = false;
  $('cameraActivity').textContent = 'Image unavailable'; $('cameraTimestamp').textContent = 't —';
}
async function updateCamera(metadata) {
  if (document.hidden) return;
  // A healthy telemetry socket cannot make an old camera frame live.
  if(displayedCamera&&Number.isFinite(provider.telemetry?.timestamp)&&provider.telemetry.timestamp-displayedCamera.timestamp>.75)clearCamera();
  const key = sensorFrameKey(metadata);
  if (key === null || !provider.fresh || provider.sensorErrors[metadata?.sensorId||'frontCamera']) { clearCamera(); return; }
  if (cameraRequest || key === cameraReceipt) return;
  const generation = cameraGeneration, request = new AbortController(); cameraRequest = request;
  try {
    const response = await fetch('/api/simulation/camera.jpg?frame_id='+metadata.frame+(metadata.sensorId==='drivingCamera'?'&view=driving':''),{cache:'no-store',signal:request.signal});
    if (!response.ok || !matchesSensorResponse(metadata,response.headers)) return;
    const blob = await response.blob();
    if (!provider.fresh || generation !== cameraGeneration) return;
    const nextUrl=URL.createObjectURL(blob);
    const decoded = new Image(); decoded.src = nextUrl;
    try {await decoded.decode();} catch(error){URL.revokeObjectURL(nextUrl);throw error;}
    if (!provider.fresh || generation !== cameraGeneration) {URL.revokeObjectURL(nextUrl);return;}
    const previousUrl=cameraUrl;cameraUrl=nextUrl;cameraReceipt=key;
    displayedCamera = {...metadata};
    $('authoritativeCamera').src = cameraUrl; $('authoritativeCamera').hidden = false;
    if(previousUrl)URL.revokeObjectURL(previousUrl);
    $('cameraUnavailable').hidden = true; $('cameraActivity').textContent = provider.isReplay ? 'REPLAY · Recorded image' : 'RGB · Live image';
    $('cameraTimestamp').textContent = 't '+number(Number(response.headers.get('X-Sensor-Time')),' s',3);
    $('cameraMetadata').textContent = 'Frame '+response.headers.get('X-Sensor-Frame')+
      ' · '+metadata.width+'×'+metadata.height+' · FOV '+metadata.fovDeg+
      '° · mount '+JSON.stringify(metadata.mountTransform ?? null);
  } catch(error) { if (error.name !== 'AbortError'&&!provider.fresh) clearCamera(); }
  finally { if (cameraRequest === request) cameraRequest = null; }
}
function refresh() {
  if(provider.resetReady){provider.resetReady=false;window.location.reload();return;}
  if ((provider.connected||provider.isReplay)&&!provider.fresh) {
    manualArmed = false; provider.disconnect('Data stream lost; driving stopped');
  }
  if (provider.sessionId !== seenSession) {
    seenSession = provider.sessionId; manualArmed = false; resetKeys(); clearCamera();
  }
  const state = provider.getVehicleState(), live = provider.fresh;
  $('cameraEmptyTitle').textContent = live ? 'Waiting for camera image' : 'Waiting for simulator connection';
  $('cameraEmptyDescription').textContent = live ? 'No image available yet. Inspect sensor status in Details.' : 'Select Start the simulation to launch CARLA and connect cameras and telemetry.';
  $('connectionSetupBtn').hidden = live || provider.isReplay;
  if (!live) $('mapEmpty').hidden = false;
  if (!live || provider.isReplay || !document.hasFocus() || document.hidden ||
      performance.now()>manualRequestedUntil && (!provider.controller ||
      provider.controlMode === 'PAUSED' && lastMode === 'MANUAL' || provider.controlMode === 'EMERGENCY_STOP')) manualArmed = false;
  lastMode = provider.controlMode;
  const controllable = canInput();
  const stopped=provider.simulatorStop;
  const connectedLabel = provider.isReplay ? 'REPLAY — real recording' : provider.simulationStarting?'CARLA — STARTING':stopped?.status==='STOPPING'?'CARLA — STOPPING':stopped?.status==='STOPPED'?'CARLA — STOPPED':provider.restarting ? 'CARLA — RESTARTING'
    : 'CARLA — '+(live&&provider.connected?'CONNECTED':'DISCONNECTED');
  $('cityStatus').textContent = $('simulationState').textContent = connectedLabel;
  const stopButton=$('stopSimulatorBtn');
  stopButton.disabled=!stopped?.available||provider.isReplay||provider.simulationStarting||provider.restarting||['STOPPING','STOPPED'].includes(stopped?.status)||provider.controlMode==='TRAINING';
  stopButton.textContent=provider.simulationStarting?'Starting…':stopped?.status==='STOPPING'?'Stopping…':stopped?.status==='STOPPED'?'GPU released':stopped?.status==='FAILED'?'Retry GPU release':'Free GPU';
  stopButton.title=stopped?.error|| (stopped?.status==='STOPPED'?'GPU resources released. Select Start the simulation to start again.':'Stop CARLA and release its GPU and VRAM');
  const resetButton=$('resetSimulatorBtn');
  resetButton.disabled=!provider.simulatorReset?.available||provider.isReplay||provider.simulationStarting||provider.restarting||stopped?.status==='STOPPING'||provider.controlMode==='TRAINING';
  resetButton.textContent=provider.resetting?'Resetting…':'Reset';
  resetButton.title=provider.operationError||'Restart CARLA and the application: default start, zero speed, no traffic or route. Recordings are kept.';
  $('connectionDot').classList.toggle('connected',live&&provider.connected);
  $('missionText').textContent = provider.isReplay ? 'Replay · Driving disabled' : provider.population ?
    provider.population.actual.vehicles+' traffic vehicle · '+provider.population.actual.pedestrians+' walkers' : 'Waiting for population CARLA';
  const modeNames = {MANUAL:manualArmed?'Manual driving':'Vehicle held by command safety',AUTOMATIC:'Destination journey',PAUSED:state.speedKmh>.54?'Stopping vehicle':'Vehicle stopped',
    EMERGENCY_STOP:'Emergency stop',DISCONNECTED:'Simulator disconnected',REPLAY:'Replay'};
  $('controlMode').textContent = modeNames[provider.controlMode] || provider.controlMode;
  $('controlSource').textContent = provider.controlSource || '';
  const safety = provider.safetySystem;
  const demo = provider.comparisonDemo;
  const demoBusy = ['RESETTING','RUNNING','STOPPING'].includes(demo?.phase);
  for (const id of ['demoWithoutBtn','demoWithBtn','demoStopBtn']) {
    $(id).disabled = !live || provider.isReplay || !provider.controller || provider.restarting || provider.controlMode === 'EMERGENCY_STOP';
  }
  $('demoWithoutBtn').setAttribute('aria-pressed', String(demo?.mode === 'WITHOUT' && demoBusy));
  $('demoWithBtn').setAttribute('aria-pressed', String(demo?.mode === 'WITH' && demoBusy));
  $('demoStatus').textContent = demo?.mode ?
    (demo.mode === 'WITH' ? 'WITH YA RAB OSTORHA' : 'WITHOUT SAFETY')+' · '+demo.phase+
    ' · Safety '+(demo.safety_enabled ? 'ON' : 'OFF')+' during run · Controller: '+demo.active_controller+
    (demo.latest_outcome ? ' · Outcome: '+demo.latest_outcome : '')+
    (demo.error ? ' · '+demo.error : '') :
    demo?.error || 'Choose a comparison mode. Each button resets and automatically records a fresh run.';
  const measured = demo?.mode && ['RUNNING','STOPPING','FINISHED'].includes(demo.phase);
  const ds = demoBusy ? safety : demo?.last_safety;
  $('demoMeasurements').textContent = measured ?
    'Hazard: '+(demo.mode === 'WITHOUT' ? 'Safety detection OFF' : ds?.risk ?? 'UNKNOWN')+
    ' · Reason: '+(ds?.reason ?? 'Waiting for sensors')+
    ' · Run brake: '+number((demoBusy ? state.brake : demo.last_applied_brake) == null ? null :
      (demoBusy ? state.brake : demo.last_applied_brake)*100,'%')+
    ' · Interventions: '+(demo.metrics?.safety_intervention_count ?? '—')+
    ' · Collision: '+(demo.metrics?.collision_count == null ? 'Not assessed' : demo.metrics.collision_count > 0 ? 'Collision detected' : 'No collision recorded')+
    ' · Time: '+number(demo.metrics?.elapsed_simulation_s,' s')+
    ' · Distance: '+number(demo.metrics?.distance_traveled_m,' m')+
    ' · Progress: '+number(demo.metrics?.progress_m,' m') : 'Measurements appear during the real CARLA run.';
  $('safetyEnabled').checked = safety?.enabled === true;
  $('safetyEnabled').disabled = !live || provider.isReplay || !provider.controller || provider.controlMode === 'TRAINING' ||
    demoBusy || !Number.isFinite(state.speedMps) || Math.abs(state.speedMps) > .15;
  $('safetyController').disabled = $('safetyEnabled').disabled;
  $('safetyController').value = safety?.controller ?? 'RULE';
  for (const option of $('safetyController').options) option.disabled = !(safety?.available_controllers ?? ['RULE']).includes(option.value);
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
  const displayedSensor=provider.displayCamera?'drivingCamera':'frontCamera';
  $('cameraFps').textContent = number(provider.performance?.sensorWallRatesHz?.[displayedSensor])+' /wall seconds · '+number(provider.sensorRates[displayedSensor])+' Hz sim';
  const perf = provider.performance || {}, gpu = perf.gpu;
  $('performance').textContent = 'actual steps: '+number(perf.nativeTickRateHz)+' /s · Simulation time: '+
    (provider.world.fixedDeltaSeconds?number(1/provider.world.fixedDeltaSeconds)+' Hz':'—')+
    (gpu?' · VRAM '+gpu.usedMiB+' / '+gpu.totalMiB+' MiB':'')+' · FPS Rendering unavailable';
  $('debugTelemetry').textContent = telemetryText(state,{remote:true,latencyMs:provider.latencyMs,
    sensorRates:provider.sensorRates,sensorErrors:provider.sensorErrors,world:provider.world,mode:provider.controlMode});
  $('replayPauseBtn').hidden = !provider.isReplay;
  $('replayPauseBtn').textContent = provider.replay?.paused ? 'Resume replay' : 'Pause replay';
  if (controllable && provider.controlMode === 'MANUAL') sendManual(state);
  updateCamera(provider.displayCamera || provider.sensorMetadata.frontCamera);
  tools.render(state,controllable);
  trafficPreparation.update(state);
  citySetup.update(state);
  perception.update();
  comparisonV2.update();
  updatePresentation(provider,state,manualArmed,manualArmed&&provider.controlMode==='PAUSED'&&performance.now()<manualRequestedUntil);
  predictionView.draw(displayedCamera);
  guided.update(state);
  motionReadout.update(state);
  studio.update(state);
  cockpit.update(state,displayedCamera);
  demoDrive.update();
}
$('startDrivingBtn').onclick = () => {
  showWorkspace('drive');
  resetKeys(); manualArmed = true; manualRequestedUntil = performance.now()+1000;
  $('drivingMode').value = 'MANUAL';
  const selected=document.querySelector('#studioManualMode')?.dataset.mode;
  const drivingMode=provider.controlMode==='AUTOMATIC' ? provider.journey?.driving_mode : selected||provider.manualDrivingMode;
  const manualMode=['ROBOSPHERE','NORMAL'].includes(drivingMode)?drivingMode:provider.manualDrivingMode||'ROBOSPHERE';
  if(!provider.startDriving(manualMode)){manualArmed=false;manualRequestedUntil=0;return;}
  document.activeElement?.blur(); $('drivingInstruction').textContent = 'Switching to keyboard control…';
};
function startJourney(drivingMode=null,pairId=null) {
  if(typeof drivingMode!=='string')drivingMode=null;
  const hybrid=['HYBRID','BASELINE'].includes(drivingMode);
  const speed = Number(hybrid ? provider.journey?.speed_kmh||30 : $('journeySpeed').value);
  if (!Number.isFinite(speed) || speed < 5 || speed > (hybrid?50:30)) {
    $('operationStatus').textContent = 'Choose a valid driving speed.'; return;
  }
  showWorkspace('drive');tools.close(false); resetKeys(); manualArmed = false; manualRequestedUntil = 0;
  $('drivingMode').value = 'AUTOMATIC';
  const sent=provider.startJourney(speed,drivingMode,pairId);
  if (sent) $('journeyStatus').textContent = 'Starting destination journey…';
  document.activeElement?.blur();
  return sent;
}
$('startJourneyBtn').onclick = $('phoneJourneyBtn').onclick = $('driveJourneyBtn').onclick = () => startJourney();
$('journeySpeed').onchange = () => {
  const speed = Number($('journeySpeed').value);
  if (!Number.isFinite(speed) || speed < 5 || speed > 30) {
    $('operationStatus').textContent = 'Choose a speed between 5 and 30 km/h.'; return;
  }
  if (provider.controlMode === 'AUTOMATIC') provider.journeySpeed(speed);
};
$('drivingMode').onchange = () => { clearControls(); };
$('safetyEnabled').onchange = () => provider.dashboardAction('safety_mode', {enabled:$('safetyEnabled').checked});
for (const [id,mode] of [['demoWithoutBtn','WITHOUT'],['demoWithBtn','WITH'],['demoStopBtn','STOP']]) {
  $(id).onclick = () => {
    if (mode === 'STOP' && !window.confirm('Reset the simulation? This returns the vehicle to its starting position and rebuilds traffic. Saved recordings are kept.')) return;
    const seed = Number($('comparisonSeed').value);
    if (!Number.isInteger(seed) || seed < 2000 || seed > 2999) {
      $('operationStatus').textContent = 'Choose a whole scenario seed between 2000 and 2999.'; return;
    }
    resetKeys(); manualArmed = false; manualRequestedUntil = 0;
    if (provider.dashboardAction('comparison', {mode,scenario:$('comparisonScenario').value,seed})) {
      if(mode!=='STOP')showWorkspace('drive');
      $('demoStatus').textContent = mode === 'STOP' ? 'Resetting simulation…' : 'Starting comparison…';
      $('primaryActionHint').textContent = $('demoStatus').textContent;
    }
  };
}
$('safetyController').onchange = () => provider.dashboardAction('safety_mode', {enabled:$('safetyEnabled').checked,controller:$('safetyController').value});
$('gearSelect').onchange = () => { controls.setMode($('gearSelect').value); provider.releaseControls(); lastGear = null; };
$('pauseBtn').onclick = () => clearControls();
$('resetBtn').onclick = () => {
  if (!window.confirm('Reset the vehicle to its spawn point? The current drive will end.')) return;
  resetKeys(); manualArmed = false; manualRequestedUntil = 0;
  provider.resetVehicle();
};
$('emergencyStopBtn').onclick = () => {
  tools.close(false); tools.expandCamera(false);
  resetKeys(); manualArmed = false; manualRequestedUntil = 0;
  provider.emergencyStop();
};
$('acknowledgeStopBtn').onclick = () => {
  resetKeys(); manualArmed = false; manualRequestedUntil = 0;
  provider.acknowledgeStop();
};
$('replayPauseBtn').onclick = () => provider.setReplayPaused(!provider.replay?.paused).catch(e=>{$('operationStatus').textContent=e.message;});
document.addEventListener('keydown',event => {
  if (isEditableTarget(event.target)||event.altKey||event.ctrlKey||event.metaKey||tools.panel||document.querySelector('dialog[open]')) return;
  if (!event.repeat&&document.body.dataset.workspace==='drive') {
    if(event.code==='KeyM'){
      event.preventDefault();document.getElementById('unifiedMapToggle')?.click();return;
    }
    if(event.code==='KeyF'){
      event.preventDefault();$('expandCameraBtn').click();return;
    }
    if(event.code==='KeyC'){
      event.preventDefault();
      const select=$('cameraView');
      if(!select.disabled){
        const options=[...select.options].filter(option=>!option.disabled);
        const index=options.findIndex(option=>option.value===select.value);
        select.value=options[(index+1)%options.length]?.value||select.value;
        select.dispatchEvent(new Event('change'));
      }
      return;
    }
    if(event.code==='KeyH'){
      event.preventDefault();$('studioShortcutButton')?.click();return;
    }
  }
  if (DRIVING_KEYS.has(event.code)) {
    event.preventDefault();
    if (provider.controlMode === 'AUTOMATIC' && event.code.startsWith('Shift')) return;
    if (!event.repeat&&canInput()) controls.keys.add(event.code);
  }
  if (!event.repeat&&event.code === 'KeyP') tools.toggle('inGamePhone','phoneToggleBtn');
});
document.addEventListener('keyup',event => controls.keys.delete(event.code));
function inspectWithoutManualControl(reason) {
  if (keepJourneyOnInspection(provider,document.hidden) && !manualOverridePending) {
    resetKeys(); manualArmed = false; manualRequestedUntil = 0;
  } else clearControls(reason);
}
document.addEventListener('workspacechange',event => { if(event.detail.phase !== 'drive') inspectWithoutManualControl('workspace_changed'); });
window.addEventListener('blur',()=>inspectWithoutManualControl('focus_lost'));
document.addEventListener('visibilitychange',()=>{if(document.hidden)clearControls('focus_lost');});
window.addEventListener('pagehide',()=>{clearControls('page_closed');clearCamera();provider.close();});
provider.connect(); refresh(); setInterval(refresh,50);
// Separate the short control lease from camera/layout work. No automatic resume
// of a paused, disconnected, collided or emergency-stopped journey.
setInterval(()=>{
  if (journeyHeartbeatAllowed(provider,document.hidden,manualOverridePending)) provider.journeyHeartbeat();
},100);
