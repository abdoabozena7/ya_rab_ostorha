import {SimulationClient} from './simulation-client.js';
import {DrivingControls} from './controls.js';
import {telemetryText} from './telemetry.js';
import {sensorFrameKey,matchesSensorResponse} from './sensor-frame.js';
import {DashboardTools} from './dashboard-tools.js';
import {DRIVING_KEYS,isEditableTarget,drivingInputAllowed} from './input-policy.js';
const $ = id => document.getElementById(id);
const provider = new SimulationClient(), controls = new DrivingControls();
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
  $('cameraActivity').textContent = 'الصورة غير متاحة'; $('cameraTimestamp').textContent = 't —';
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
    $('cameraUnavailable').hidden = true; $('cameraActivity').textContent = provider.isReplay ? 'REPLAY · صورة مسجلة' : 'RGB · صورة حية';
    $('cameraTimestamp').textContent = 't '+number(Number(response.headers.get('X-Sensor-Time')),' s',3);
    $('cameraMetadata').textContent = 'Frame '+response.headers.get('X-Sensor-Frame')+
      ' · '+metadata.width+'×'+metadata.height+' · FOV '+metadata.fovDeg+
      '° · mount '+JSON.stringify(metadata.mountTransform ?? null);
  } catch(error) { if (error.name !== 'AbortError') clearCamera(); }
  finally { if (cameraRequest === request) cameraRequest = null; }
}
function refresh() {
  if ((provider.connected||provider.isReplay)&&!provider.fresh) {
    manualArmed = false; provider.disconnect('انقطع تدفق البيانات؛ القيادة متوقفة');
  }
  if (provider.sessionId !== seenSession) {
    seenSession = provider.sessionId; manualArmed = false; resetKeys(); clearCamera();
  }
  const state = provider.getVehicleState(), live = provider.fresh;
  if (!live || provider.isReplay || !document.hasFocus() || document.hidden ||
      performance.now()>manualRequestedUntil && (!provider.controller ||
      provider.controlMode === 'PAUSED' && lastMode === 'MANUAL' || provider.controlMode === 'EMERGENCY_STOP')) manualArmed = false;
  lastMode = provider.controlMode;
  const controllable = canInput();
  const connectedLabel = provider.isReplay ? 'REPLAY — تسجيل حقيقي' : provider.restarting ? 'CARLA — RESTARTING'
    : 'CARLA — '+(live&&provider.connected?'CONNECTED':'DISCONNECTED');
  $('cityStatus').textContent = $('simulationState').textContent = connectedLabel;
  $('connectionDot').classList.toggle('connected',live&&provider.connected);
  $('missionText').textContent = provider.isReplay ? 'عرض تسجيل · القيادة مقفولة' : 'عربية واحدة · المرور غير مفعّل';
  const modeNames = {MANUAL:manualArmed?'قيادة يدوية':'العربية تحت الأمان',AUTOMATIC:'رحلة تلقائية',PAUSED:state.speedKmh>.54?'جاري إيقاف العربية':'العربية متوقفة',
    EMERGENCY_STOP:'إيقاف طوارئ',DISCONNECTED:'المحاكي غير متصل',REPLAY:'عرض تسجيل'};
  $('controlMode').textContent = modeNames[provider.controlMode] || provider.controlMode;
  $('controlSource').textContent = provider.controlSource || '';
  $('connectionDetail').textContent = provider.isReplay ? 'عرض بيانات مسجلة؛ لا يوجد تحكم بالمحاكي.'
    : live ? (provider.controller?'هذه الصفحة تملك التحكم.':'هذه الصفحة للعرض؛ التحكم لدى صفحة أخرى.') : provider.status;
  $('phoneStatus').textContent = live ? 'الوجهات من خريطة '+(provider.world.map?.split('/').at(-1)||'CARLA') : 'بانتظار اتصال المحاكي.';
  $('providerStatus').textContent = provider.status;
  $('providerTitle').textContent = provider.isReplay ? 'الكاميرا المسجلة' : 'كاميرا CARLA';
  $('cameraSource').textContent = provider.isReplay ? 'RECORDED RGB' : 'CARLA RGB';
  $('speedVal').textContent = number(state.speedKmh,'',0); $('gearVal').textContent = state.gear ?? '—';
  $('throttleVal').textContent = number(state.throttle==null?null:state.throttle*100,'%');
  $('brakeVal').textContent = number(state.brake==null?null:state.brake*100,'%');
  $('steerVal').textContent = number(state.steeringInput);
  $('versionVal').textContent = provider.world.version ?? '—';
  $('mapVal').textContent = provider.world.map?.split('/').at(-1) ?? '—';
  $('frameVal').textContent = state.frame ?? '—'; $('timeVal').textContent = number(state.timestamp,' s',3);
  $('accelVal').textContent = number(state.accelerationMps2,' m/s²');
  $('reverseVal').textContent = state.reverse==null?'—':state.reverse?'نعم':'لا';
  $('positionVal').textContent = state.positionWorldM ? 'X / Y / Z: '+state.positionWorldM.map(v=>number(v)).join(' / ')+' m' : 'الموقع غير متاح';
  $('headingVal').textContent = state.rotationDeg ? 'Yaw '+number(state.rotationDeg.yaw,'°') : '';
  $('gearSelect').disabled = !controllable || provider.controlMode === 'AUTOMATIC';
  $('gearSelect').title = !$('gearSelect').disabled ? '' : provider.isReplay ? 'التسجيل للعرض فقط؛ القيادة مقفولة'
    : !live ? 'بانتظار اتصال حقيقي بـCARLA' : provider.controlMode === 'AUTOMATIC' ? 'الغيار يديره متحكم الرحلة؛ استلم القيادة اليدوية لتغييره'
    : !provider.controller ? 'استلم التحكم من إعدادات الاتصال أولًا' : 'فعّل القيادة اليدوية لتغيير الغيار';
  $('controlStatus').textContent = provider.isReplay ? 'REPLAY · القيادة مقفولة' : !document.hasFocus()||document.hidden
    ? 'ارجع للداشبورد لاستقبال الكيبورد' : controllable ? 'WASD وأزرار الشاشة جاهزة' : 'الكيبورد متوقف — فعّل القيادة أولًا';
  const sensorCount = Object.keys(provider.sensorMetadata).length;
  $('sensorStatus').textContent = live ? sensorCount+' حساسات دورية تستقبل بيانات · التصادم يعمل عند الحدث' : 'الحساسات غير متاحة';
  $('cameraFps').textContent = number(provider.performance?.sensorWallRatesHz?.frontCamera)+' /ث فعلية · '+number(provider.sensorRates.frontCamera)+' Hz sim';
  const perf = provider.performance || {}, gpu = perf.gpu;
  $('performance').textContent = 'خطوات فعلية: '+number(perf.nativeTickRateHz)+' /ث · زمن المحاكاة: '+
    (provider.world.fixedDeltaSeconds?number(1/provider.world.fixedDeltaSeconds)+' Hz':'—')+
    (gpu?' · VRAM '+gpu.usedMiB+' / '+gpu.totalMiB+' MiB':'')+' · FPS الرسم غير متاح';
  $('debugTelemetry').textContent = telemetryText(state,{remote:true,latencyMs:provider.latencyMs,
    sensorRates:provider.sensorRates,sensorErrors:provider.sensorErrors,world:provider.world,mode:provider.controlMode});
  $('replayPauseBtn').hidden = !provider.isReplay;
  $('replayPauseBtn').textContent = provider.replay?.paused ? 'استئناف عرض التسجيل' : 'إيقاف عرض التسجيل';
  if (controllable && (provider.controlMode === 'MANUAL' ||
      provider.controlMode === 'AUTOMATIC' && (manualOverridePending||controls.keys.size>0))) sendManual(state);
  if (live&&provider.controller&&!provider.isReplay&&document.hasFocus()&&!document.hidden&&
      ['STARTING','RUNNING'].includes(provider.journey?.status) && !manualOverridePending) provider.journeyHeartbeat();
  updateCamera(provider.sensorMetadata.frontCamera);
  tools.render(state,controllable);
}
$('startDrivingBtn').onclick = () => {
  resetKeys(); manualArmed = true; manualRequestedUntil = performance.now()+1000;
  provider.startDriving(); document.activeElement?.blur(); $('drivingInstruction').textContent = 'تفعيل القيادة اليدوية…';
};
$('startJourneyBtn').onclick = () => {
  clearControls(); provider.startJourney(Number($('journeySpeed').value));
  document.activeElement?.blur();
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
    if (!event.repeat&&canInput()) { controls.keys.add(event.code); intervene(); }
  }
  if (!event.repeat&&event.code === 'KeyP') tools.toggle('inGamePhone','phoneToggleBtn');
});
document.addEventListener('keyup',event => controls.keys.delete(event.code));
window.addEventListener('blur',()=>clearControls('focus_lost'));
document.addEventListener('visibilitychange',()=>{if(document.hidden)clearControls('focus_lost');});
window.addEventListener('pagehide',()=>{clearControls('page_closed');clearCamera();provider.close();});
provider.connect(); refresh(); setInterval(refresh,50);
