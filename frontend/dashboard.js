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
import {installPresentationRun} from './presentation-run.js';
import {installSequentialDrive} from './sequential-drive.js';
import {CameraPerformance} from './camera-performance.js';
import {CameraImageStream} from './image-stream.js';
const $ = id => document.getElementById(id);
const provider = new SimulationClient(), controls = new DrivingControls();
const cameraPerformance=new CameraPerformance();
let lastCameraMetricsAt=-Infinity;
const imageStream=new CameraImageStream({meter:cameraPerformance,
  visible:()=>!document.hidden&&!!$('cameraCard').getClientRects().length,
  draw:bitmap=>drawCamera(bitmap),
  onUnavailable:message=>clearCameraVisual(message),
  onPresent:(header,measurement,metrics)=>{
    displayedCamera={source:'carla',sensorId:header.camera_id,sessionId:header.session_id,
      frame:header.frame_id,timestamp:header.simulation_timestamp_s,width:header.width,height:header.height,
      fovDeg:header.fov_deg,mountTransform:header.mount_transform,worldTransform:header.world_transform};
    cameraCaption(displayedCamera);
    const canvas=$('authoritativeCamera');
    canvas.dataset.frame=String(header.frame_id);canvas.dataset.sessionId=header.session_id;
    canvas.dataset.cameraId=header.camera_id;canvas.dataset.timestamp=String(header.simulation_timestamp_s);
    canvas.dataset.captureClock=header.capture_clock||'UNAVAILABLE';
    canvas.dataset.imageSha256=header.image_sha256||'';
    provider.cameraDisplayMetrics=metrics;
    if(performance.now()-lastCameraMetricsAt>=250){
      lastCameraMetricsAt=performance.now();canvas.dataset.performance=JSON.stringify(measurement);
    }
  }});
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
const presentationRun=installPresentationRun(provider,tools,clearControls);
const sequentialDrive=installSequentialDrive(provider,tools);
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
  imageStream.stop();
  cameraGeneration++; cameraRequest?.abort(); cameraRequest = null;
  if (cameraUrl) URL.revokeObjectURL(cameraUrl);
  cameraUrl = cameraReceipt = null;clearCameraVisual();
}
function clearCameraVisual(message='Image unavailable'){
  displayedCamera=null;$('authoritativeCamera').hidden=true;$('cameraUnavailable').hidden=false;
  $('cameraActivity').textContent=message;$('cameraTimestamp').textContent='t —';
}
function drawCamera(image){
  const canvas=$('authoritativeCamera'),width=image.width||image.naturalWidth,height=image.height||image.naturalHeight;
  if(canvas.width!==width||canvas.height!==height){canvas.width=width;canvas.height=height;}
  canvas.getContext('2d',{alpha:false,desynchronized:true}).drawImage(image,0,0);
  canvas.hidden=false;$('cameraUnavailable').hidden=true;
}
function cameraCaption(metadata){
  $('cameraActivity').textContent=provider.isReplay?'REPLAY · Recorded image':'RGB · Live image';
  $('cameraTimestamp').textContent='t '+number(metadata.timestamp,' s',3);
  $('cameraMetadata').textContent='Frame '+metadata.frame+' · '+metadata.width+'×'+metadata.height+
    ' · FOV '+metadata.fovDeg+'° · mount '+JSON.stringify(metadata.mountTransform??null);
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
    await new Promise(resolve=>requestAnimationFrame(()=>{
      if(provider.fresh&&generation===cameraGeneration){
        displayedCamera={...metadata};drawCamera(decoded);cameraCaption(displayedCamera);
        cameraPerformance.present(metadata.frame,metadata.timestamp,performance.now(),
          provider.journey?.pair_id+':'+provider.journey?.driving_mode);
        $('authoritativeCamera').dataset.frame=String(metadata.frame);
        $('authoritativeCamera').dataset.timestamp=String(metadata.timestamp);
        $('authoritativeCamera').dataset.performance=JSON.stringify(cameraPerformance.snapshot());
      }
      resolve();
    }));
    if(previousUrl)URL.revokeObjectURL(previousUrl);
  } catch(error) { if (error.name !== 'AbortError') clearCameraVisual('Camera request failed: '+error.message); }
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
  $('cameraFps').textContent = number(provider.cameraDisplayMetrics?.displayFps)+' displayed fps · '+
    number(provider.performance?.sensorWallRatesHz?.[displayedSensor])+' captured /s';
  const perf = provider.performance || {}, gpu = perf.gpu;
  const display=provider.cameraDisplayMetrics||{},nvml=gpu?.processMemory?.processes||[];
  const processMeasured=nvml.some(p=>Number.isFinite(p.usedMiB));
  const memory=processMeasured?nvml:gpu?.wddmProcessMemory?.processes||[];
  $('performance').textContent = 'Display '+number(display.displayFps)+' fps · p95 '+number(display.p95IntervalMs,' ms')+
    ' · image age '+number(display.imageLatencyMs,' ms')+' · simulation '+number(perf.simulationRealTimeFactor,'×',2)+
    ' · physics '+number(perf.nativeTickRateHz)+' /s · decisions '+number(perf.decisionRateHz)+' /s'+
    (gpu?' · total GPU '+gpu.usedMiB+' / '+gpu.totalMiB+' MiB (budget 4608)':' · total GPU unmeasured')+
    ' · process GPU '+(memory.some(p=>Number.isFinite(p.usedMiB))?memory.filter(p=>Number.isFinite(p.usedMiB)).map(p=>p.pid+': '+number(p.usedMiB,' MiB',0)).join(', ')+(processMeasured?'':' allocated across adapters'):'unavailable')+
    ' · dropped images '+((display.droppedLate||0)+(display.droppedSuperseded||0))+' · engine renderer FPS unmeasured';
  $('debugTelemetry').textContent = telemetryText(state,{remote:true,latencyMs:provider.latencyMs,
    sensorRates:provider.sensorRates,sensorErrors:provider.sensorErrors,world:provider.world,mode:provider.controlMode});
  $('replayPauseBtn').hidden = !provider.isReplay;
  $('replayPauseBtn').textContent = provider.replay?.paused ? 'Resume replay' : 'Pause replay';
  if (controllable && provider.controlMode === 'MANUAL') sendManual(state);
  const streaming=live&&!provider.isReplay&&!!provider.imageWebsocketUrl&&!document.hidden&&!!$('cameraCard').getClientRects().length;
  imageStream.configure({enabled:streaming,sessionId:provider.sessionId,url:provider.imageWebsocketUrl,
    cameraId:provider.displayCamera?'drivingCamera':'frontCamera',profile:perf.runtimeRates?.profile||'LEGACY',
    arm:provider.journey?.status==='RUNNING'?provider.journey.pair_id+':'+provider.journey.driving_mode:provider.sessionId+':held'});
  if(streaming){
    if(cameraRequest){cameraGeneration++;cameraRequest.abort();cameraRequest=null;}
  }else if(!provider.imageWebsocketUrl&&!document.hidden&&$('cameraCard').getClientRects().length)
    updateCamera(provider.displayCamera || provider.sensorMetadata.frontCamera);
  else if(cameraRequest||displayedCamera)clearCamera();
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
  presentationRun.update();
  sequentialDrive.update();
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
  if (event.target.closest?.('button, a, summary, [role="button"]')) return;
  if (isEditableTarget(event.target)||event.altKey||event.ctrlKey||event.metaKey||tools.panel||document.querySelector('dialog[open]')) return;
  if (!event.repeat&&document.body.dataset.workspace==='drive') {
    if(event.code==='KeyM'){
      if(document.body.classList.contains('sequential-drive')){event.preventDefault();document.dispatchEvent(new CustomEvent('detailsnavigate',{detail:{page:'diagnostics'}}));return;}
      event.preventDefault();document.getElementById('unifiedMapToggle')?.click();return;
    }
    if(event.code==='KeyF'){
      event.preventDefault();$('expandCameraBtn').click();return;
    }
    if(event.code==='KeyC'){
      if(document.body.classList.contains('sequential-drive')){event.preventDefault();document.dispatchEvent(new CustomEvent('detailsnavigate',{detail:{page:'view'}}));return;}
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
document.addEventListener('visibilitychange',()=>{if(document.hidden)inspectWithoutManualControl('focus_lost');});
window.addEventListener('pagehide',()=>{
  const held=['AWAITING_NEXT','RESULTS','FINISHING','COMPLETE'].includes(provider.presentation?.status)||
    provider.presentation?.status==='CHOOSING'&&provider.presentation?.awaiting_choice;
  if(held||keepJourneyOnInspection(provider,document.hidden)&&!manualOverridePending)resetKeys();else clearControls('page_closed');
  clearCamera();provider.close();
});
provider.connect(); refresh(); setInterval(refresh,50);
// Separate the short control lease from camera/layout work. No automatic resume
// of a paused, disconnected, collided or emergency-stopped journey.
setInterval(()=>{
  if (journeyHeartbeatAllowed(provider,document.hidden,manualOverridePending)) provider.journeyHeartbeat();
},100);
