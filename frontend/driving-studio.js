import {showWorkspace} from './presentation-ui.js';
import {JOURNEY_MODES,modeName,comparisonSummary,metricValue,measuredDifference} from './journey-comparison.js';
import {installUnifiedMap} from './unified-map.js';
import {controlReasonText} from './cockpit-state.js';

const $=id=>document.getElementById(id);
const node=(tag,cls,text)=>{const el=document.createElement(tag);if(cls)el.className=cls;if(text!==undefined)el.textContent=text;return el;};
const txt=(el,value)=>{if(el.textContent!==String(value))el.textContent=value;};
const icon=path=>`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
const icons={drive:icon('<path d="m3 11 9-8 9 8M5 10v11h14V10M10 21v-7h4v7"/>'),results:icon('<path d="M4 21V11h4v10M10 21V6h4v15M16 21V2h4v19"/>'),map:icon('<path d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3ZM9 3v15M15 6v15"/>'),settings:icon('<path d="M4 7h16M4 17h16M8 4v6M16 14v6"/>')};

export function installDrivingStudio(p,guided,predictionView,tools) {
  const rail=node('aside','studio-rail');rail.setAttribute('aria-label','Main navigation');
  rail.innerHTML='<span class="rail-brand" title="Ya Rab Ostorha" aria-hidden="true">o<span></span></span>';
  const nav=document.querySelector('.workspace-tabs');rail.append(nav);document.body.prepend(rail);
  for(const phase of ['drive','results','setup']) {
    const b=$(phase+'Tab');b.innerHTML=(icons[phase]||icons.settings)+`<span>${phase==='drive'?'Driving':phase==='results'?'Results':'Setup'}</span>`;
    b.title=phase==='drive'?'Driving':phase==='results'?'Results':'Advanced setup';b.setAttribute('aria-label',b.title);
  }
  const map=node('button');map.innerHTML=icons.map+'<span>Map</span>';map.title='Choose destination';map.onclick=()=>$('routeBtn').click();
  const settings=node('button');settings.innerHTML=icons.settings+'<span>Settings</span>';settings.title='Settings';settings.onclick=()=>$('settingsBtn').click();
  const advanced=node('button','','City & research configuration ↗');advanced.id='openAdvancedSetup';
  advanced.onclick=()=>{tools.close(false);if(p.controlMode==='MANUAL')tools.clearControls('setup_inspection');showWorkspace('setup');};$('settingsPanel').append(advanced);
  document.addEventListener('advancedsetupopen',()=>{if(p.controlMode==='MANUAL'||tools.options.isManualArmed?.())tools.clearControls('setup_inspection');});
  const diagnostics=node('button');diagnostics.innerHTML=icon('<path d="M3 12h4l3-8 4 16 3-8h4"/>')+'<span>Diagnostics</span>';diagnostics.title='Diagnostics';diagnostics.setAttribute('aria-label','Diagnostics');diagnostics.onclick=()=>$('sensorBtn').click();
  const research=node('button');research.innerHTML=icon('<path d="M9 3h6M10 3v6l-6 10a1 1 0 0 0 1 2h14a1 1 0 0 0 1-2L14 9V3M7 15h10"/>')+'<span>Tools</span>';research.title='Tools';research.setAttribute('aria-label','Tools');research.onclick=()=>{tools.close(false);showWorkspace('setup');};
  rail.append(map,research,diagnostics,settings,node('span','rail-orb'));
  const setupShade=node('button','studio-setup-shade');setupShade.setAttribute('aria-label','Close driving setup');setupShade.onclick=()=>document.body.classList.remove('studio-setup-open');
  const setupDock=node('button','studio-setup-dock');setupDock.innerHTML='<span>YOUR NEXT STEP</span><strong id="studioSetupDockLabel">Open driving setup</strong><b>↑</b>';setupDock.onclick=()=>document.body.classList.add('studio-setup-open');
  document.body.append(setupShade,setupDock);
  const setupClose=node('button','studio-setup-close','Close ×');setupClose.setAttribute('aria-label','Close driving setup');setupClose.onclick=()=>document.body.classList.remove('studio-setup-open');$('guidedDrive').prepend(setupClose);
  const mobileEngineStop=node('button','studio-mobile-engine-stop','Stop CARLA · Free GPU');mobileEngineStop.onclick=()=>$('stopSimulatorBtn').click();$('settingsPanel').prepend(mobileEngineStop);
  document.addEventListener('workspacechange',e=>{if(e.detail.phase==='results')document.body.classList.remove('studio-setup-open');});
  map.setAttribute('aria-label','Choose destination on map');settings.setAttribute('aria-label','Settings');
  for(const selector of ['.normal-driving','.comparison-controls','.comparison-v2']) {
    const feature=document.querySelector(selector);if(feature)$('setupPhase').append(feature);
  }
  $('normalControls').prepend($('quickDriveActions'),$('stopAcknowledgement'));
  const town=node('div','studio-town');town.innerHTML=icons.map+'<div><strong id="studioTown">CARLA</strong><span id="studioOwnership">Driving simulator</span></div>';
  $('brand').after(town);
  document.querySelector('#brand h1').textContent='Ya Rab Ostorha';
  document.querySelector('#brand .eyebrow').textContent='CARLA Driving Simulator';
  document.querySelector('.guided-heading .eyebrow').textContent='YOUR NEXT JOURNEY';
  const camera=$('frontCameraView');
  const stage=camera.parentElement;
  const controlBar=node('section','studio-control-bar');controlBar.setAttribute('aria-label','Driving controls');
  controlBar.innerHTML='<div class="studio-drive-context"><span>LIVE DRIVE / CONTROL</span><strong id="studioRouteContext">No destination selected</strong><small id="studioControlStage">Vehicle held</small></div><div class="studio-manual-cluster"><div id="studioManualMode" class="studio-manual-modes" data-mode="ROBOSPHERE" role="group" aria-label="Keyboard driving protection"><button type="button" data-manual-mode="ROBOSPHERE" aria-pressed="true">Protected</button><button type="button" data-manual-mode="NORMAL" aria-pressed="false">Normal</button></div><span id="studioManualContext">Robosphere protection</span></div><div class="studio-drive-buttons"><button id="studioManualStop" type="button">Stop</button><button id="studioResultsLink" type="button">Results ↗</button></div>';
  $('cameraCard').insertBefore(controlBar,stage);
  controlBar.querySelector('.studio-drive-buttons').prepend($('startDrivingBtn'));
  $('studioManualStop').onclick=()=>tools.clearControls('operator_stop');
  $('studioResultsLink').onclick=()=>showWorkspace('results');
  const shortcutButton=node('button','','Keys ?');shortcutButton.id='studioShortcutButton';shortcutButton.type='button';shortcutButton.title='Keyboard shortcuts (H)';
  controlBar.querySelector('.studio-drive-buttons').append(shortcutButton);
  const shortcutDialog=node('dialog');shortcutDialog.id='studioShortcutDialog';
  shortcutDialog.innerHTML='<header><h2>Driving shortcuts</h2><button type="button" id="studioShortcutClose">Close ×</button></header><dl><dt>Steer and drive <small>Manual mode</small></dt><dd><kbd>W</kbd> <kbd>A</kbd> <kbd>S</kbd> <kbd>D</kbd></dd><dt>Boost to 80 km/h <small>Hold with W</small></dt><dd><kbd>Shift</kbd> + <kbd>W</kbd></dd><dt>Brake / parking brake</dt><dd><kbd>Space</kbd></dd><dt>Cycle cameras</dt><dd><kbd>C</kbd></dd><dt>Open / close route map</dt><dd><kbd>M</kbd></dd><dt>Fullscreen simulation</dt><dd><kbd>F</kbd></dd><dt>Phone tools</dt><dd><kbd>P</kbd></dd><dt>Show this guide</dt><dd><kbd>H</kbd></dd><dt>Close overlay</dt><dd><kbd>Esc</kbd></dd></dl>';
  document.body.append(shortcutDialog);
  shortcutButton.onclick=()=>{if(shortcutDialog.open)return;if(p.controlMode==='MANUAL'||tools.options.isManualArmed?.())tools.clearControls('shortcut_inspection');shortcutDialog.showModal();};
  shortcutDialog.querySelector('#studioShortcutClose').onclick=()=>shortcutDialog.close();
  controlBar.querySelectorAll('[data-manual-mode]').forEach(button=>button.onclick=()=>{
    if(button.disabled)return;
    $('studioManualMode').dataset.mode=button.dataset.manualMode;
    controlBar.querySelectorAll('[data-manual-mode]').forEach(other=>other.setAttribute('aria-pressed',String(other===button)));
  });
  const hud=node('div','studio-hud');hud.innerHTML='<span id="studioGear">N</span><strong id="studioSpeed">—</strong><span>km/h</span><small id="studioTarget">Target —</small>';camera.append(hud);
  const mode=node('div','studio-mode-pill');mode.innerHTML='<i></i><span id="studioMode">Ready when you are</span><b id="studioElapsed"></b>';camera.append(mode);
  const intervention=node('div','studio-safety-alert');intervention.id='studioSafetyAlert';intervention.setAttribute('role','status');intervention.hidden=true;camera.append(intervention);
  const mapLabel=node('span','sensor-overlay-label','Measured surroundings');camera.append(mapLabel);
  $('miniMapToggle').hidden=true;
  const unifiedMap=installUnifiedMap(p,predictionView,tools);
  const views=node('section','studio-camera-views');views.setAttribute('aria-label','Camera views');
  views.innerHTML='<h3>'+icon('<path d="M3 6h13v13H3zM16 10l5-3v11l-5-3"/>')+' Camera views</h3><div class="studio-view-buttons"></div>';
  for(const [value,label] of [['front','Front'],['hood','Hood'],['chase','Chase'],['rear','Rear'],['top','Top']]) {
    const b=node('button','',label);b.dataset.camera=value;b.onclick=()=>{if(b.disabled)return;$('cameraView').value=value;$('cameraView').dispatchEvent(new Event('change'));};views.lastElementChild.append(b);
  }
  $('modelVision').before(views);
  const cameraStatus=node('span','studio-camera-status','');cameraStatus.id='studioCameraStatus';cameraStatus.setAttribute('role','status');
  views.append(cameraStatus,$('replayPauseBtn'),$('expandCameraBtn'));
  const fullscreen=node('div','studio-fullscreen-controls');fullscreen.innerHTML='<strong>Ya Rab Ostorha · Live simulation</strong><button id="studioFullscreenStop">إيقاف العربية</button><button id="studioFullscreenEmergency" class="emergency">إيقاف طوارئ</button><button id="studioFullscreenClose" aria-label="Exit expanded simulator">Close ×</button>';
  $('cameraCard').prepend(fullscreen);
  $('studioFullscreenStop').onclick=()=>tools.clearControls('operator_stop');
  $('studioFullscreenEmergency').onclick=()=>$('emergencyStopBtn').click();$('studioFullscreenClose').onclick=()=>tools.expandCamera(false);
  const kpis=node('section','studio-kpis');kpis.setAttribute('aria-label','Live measurements');
  const liveFields=['Vehicles','Pedestrians','Front gap','TTC','Brake','Collisions'];
  const liveValues=liveFields.map((name,i)=>{const cell=node('div');cell.dataset.index=i;cell.append(node('span','',name),node('strong','','—'));kpis.append(cell);return cell.lastChild;});
  $('cameraCard').append(kpis);
  const health=node('section','studio-health');health.innerHTML='<h3>Safety monitor <span id="studioHealthStatus">Offline</span></h3><dl><div><dt>Sensors</dt><dd id="studioSensorHealth">—</dd></div><div><dt>Control</dt><dd id="studioControlHealth">Vehicle held</dd></div><div><dt>Simulation</dt><dd id="studioRate">—</dd></div></dl>';$('sensorPanel').append(health);
  const results=$('resultsPhase');
  results.querySelector('.analysis-heading h2').textContent='Comparison results';
  const sub=node('p','studio-result-subtitle','Your driving, with and without Robosphere.');results.querySelector('.analysis-heading h2').after(sub);
  const ordinary=node('section','journey-comparison');ordinary.id='ordinaryComparison';
  ordinary.dataset.view='journey';ordinary.dataset.focusMode='ROBOSPHERE';
  ordinary.innerHTML='<div class="studio-comparison-banner"><div><strong id="ordinaryComparisonTitle">Comparison incomplete</strong><p id="ordinaryComparisonHint">Run both modes to complete your comparison.</p><p id="ordinaryRecoveryStatus" role="status"></p></div><div><span id="ordinaryComparisonCount">0 of 2 attempts recorded</span><progress id="ordinaryComparisonProgress" max="2" value="0" aria-label="Recorded modes"></progress></div></div><div class="studio-result-controls"><div class="studio-result-view" role="group" aria-label="Comparison measurements"><button data-result-view="journey" aria-pressed="true">Journey</button><button data-result-view="safety" aria-pressed="false">Safety & sensing</button></div><div class="studio-run-switch" role="group" aria-label="Comparison mode"><button data-focus-mode="ROBOSPHERE" aria-pressed="true">With Robosphere</button><button data-focus-mode="NORMAL" aria-pressed="false">Without</button></div><button id="studioResultDetailsBtn">More details ↗</button></div><div id="ordinaryComparisonPanels" class="studio-result-pair"></div>';
  ordinary.querySelectorAll('[data-result-view]').forEach(button=>button.onclick=()=>{ordinary.dataset.view=button.dataset.resultView;ordinary.querySelectorAll('[data-result-view]').forEach(other=>other.setAttribute('aria-pressed',String(other===button)));});
  ordinary.querySelectorAll('[data-focus-mode]').forEach(button=>button.onclick=()=>{ordinary.dataset.focusMode=button.dataset.focusMode;ordinary.querySelectorAll('[data-focus-mode]').forEach(other=>other.setAttribute('aria-pressed',String(other===button)));});
  results.querySelector('.analysis-heading').after(ordinary);
  const detail=node('details','studio-diagnostics');detail.id='studioDiagnostics';detail.innerHTML='<summary>Diagnostics & research archive</summary><div id="studioDiagnosticContent"></div>';
  results.append(detail);
  const researchScope=results.querySelector('.analysis-heading .muted');if(researchScope)$('studioDiagnosticContent').append(researchScope);
  $('sensorPanel').append($('motionReadout'));
  for(const el of [document.querySelector('.safety-monitor'),document.querySelector('.session-timeline'),$('liveOperationStatus'),$('resultContent'),document.querySelector('.recording-archive')])if(el)$('studioDiagnosticContent').append(el);
  const definitions=node('details','studio-definitions');definitions.innerHTML='<summary>How the comparison is measured</summary><p>Collisions are native contact episodes per actor, separated by more than 1 second. Impulse is the maximum native contact impulse (N·s). A forward near miss requires measured TTC below 1.5 s and range below 5 m, with a 1-second release gap.</p><p>High-risk time comes from the same forward sensor observer in both modes. Coverage shows how much of the run had fresh, usable observations. Unknown space is not counted as clear. Normal follows the native route and traffic signals. Normal manual control preserves the driver pedals and steering. Normal autonomous control follows the route and signals without automatic obstacle braking. Sensors and RULE proposals are recorded for observation only; operator stops, emergency stops and connection watchdogs remain active.</p><p>Each run records automatically. Arrived, stopped, collision and failed attempts stay distinct. The paired setup restores origin, destination, weather, requested speed and seeded traffic settings. Live actor trajectories can diverge; these are measured differences, not a causal count of prevented accidents. Historical research and its budgets remain separate.</p><p id="ordinaryRecordingReferences"></p>';
  ordinary.append(definitions);
  const provenance=node('details','studio-provenance');provenance.innerHTML='<summary>Comparison Details · setup & recordings</summary><div id="ordinaryProvenance"></div>';ordinary.append(provenance);
  const fields=[['Collision episodes','collisions',0,''],['Run duration','duration_s',1,' s'],['Reached & stopped','destination_reached',0,''],['Route completion','route_completion_percent',0,'%'],['Distance travelled','distance_m',0,' m'],['Minimum forward gap','minimum_forward_range_m',1,' m'],['Harsh braking episodes','harsh_braking_events',0,''],['RULE interventions','safety_interventions',0,''],['Intervention time','safety_intervention_s',1,' s'],['Forward near misses','near_misses',0,''],['High-risk time','high_risk_s',1,' s'],['Sensor coverage','sensor_coverage_percent',0,'%']];
  const cards={},pending={intent:null,sent:false};
  const recovery=node('div','studio-recovery-actions');recovery.hidden=true;
  const retryRecovery=node('button','','Retry saved setup'),cancelRecovery=node('button','','Use current setup');
  recovery.append(retryRecovery,cancelRecovery);$('guidedStatus').after(recovery);
  let failedPreparation=null;
  retryRecovery.onclick=()=>{if(!failedPreparation)return;p.operationError=null;pending.intent=failedPreparation;pending.sent=false;recovery.hidden=true;};
  cancelRecovery.onclick=()=>{p.operationError=null;pending.intent=preparedRequest=failedPreparation=null;recovery.hidden=true;guided.chooseMode(selectedRecoveryMode);};
  let selectedRecoveryMode='ROBOSPHERE';
  for(const mode of JOURNEY_MODES) {
    const panel=node('article','studio-run-panel');panel.dataset.mode=mode;
    const header=node('header');header.innerHTML=`<span class="mode-symbol" aria-hidden="true">${mode==='NORMAL'?'◇':'◎'}</span><div><h3>${mode==='NORMAL'?'Without Robosphere':'With Robosphere'}</h3><p>${mode==='NORMAL'?'Normal Mode · native route driver':'Ya Rab Ostorha Mode · RULE protection'}</p></div><span class="run-status">Not Run</span>`;panel.append(header);
    const grid=node('dl','studio-run-metrics');const values=fields.map(([label,key],i)=>{const cell=node('div');cell.dataset.field=key;cell.dataset.group=i<6?'journey':'safety';cell.append(node('dt','',label),node('dd','','—'),node('span','metric-difference',''));grid.append(cell);return cell;});panel.append(grid);
    const chart=node('div','studio-risk-chart');chart.innerHTML='<h4>Forward risk over time</h4><div class="risk-bars"></div><p class="risk-chart-caption">No simulation data</p>';panel.append(chart);
    const extra=node('p','run-extra');panel.append(extra);
    const events=node('ol','studio-run-events');panel.append(events);
    const button=node('button','run-mode-cta',`Run ${modeName(mode)} ↗`);panel.insertBefore(button,grid);
    button.onclick=()=>{
      if(button.disabled)return;
      if(['RUNNING','STARTING'].includes(p.journey?.status)){p.operationError='Stop the current drive before preparing another mode.';return;}
      pending.intent={mode,pair_id:p.journeyComparison?.pair_id};pending.sent=false;
      selectedRecoveryMode=mode;failedPreparation=null;recovery.hidden=true;
      showWorkspace('drive');document.body.classList.add('studio-setup-open');guided.chooseMode(mode,{restoring:!!pending.intent.pair_id});
      txt($('ordinaryRecoveryStatus'),'Preparing '+modeName(mode)+'. Follow the readiness steps in Driving.');
    };
    $('ordinaryComparisonPanels').append(panel);cards[mode]={panel,header,values,chart,extra,events,button,eventKey:null};
  }
  const detailDialog=node('dialog','studio-result-dialog');detailDialog.id='studioResultDialog';
  const detailHeading=node('div','studio-result-dialog-heading');detailHeading.innerHTML='<strong>Comparison details</strong><button id="studioResultDialogClose" aria-label="Close comparison details">Close ×</button>';
  detailDialog.append(detailHeading,definitions,provenance,detail);
  for(const mode of JOURNEY_MODES){const section=node('section','studio-event-detail');section.append(node('h3','',mode==='NORMAL'?'Normal Mode events':'Ya Rab Ostorha Mode events'),cards[mode].events);detailDialog.append(section);}
  document.body.append(detailDialog);
  $('studioResultDetailsBtn').onclick=()=>detailDialog.showModal();$('studioResultDialogClose').onclick=()=>detailDialog.close();
  const backToDrive=node('button','studio-back-to-drive','← Live drive');
  backToDrive.onclick=()=>showWorkspace('drive');
  results.querySelector('.analysis-heading').append(backToDrive);
  let resultKey='',preparedRequest=null,previousPreparation=null;
  let modeSession=null;
  return {update(vehicle){
    if(modeSession!==p.sessionId){modeSession=p.sessionId;$('studioManualMode').dataset.mode=p.manualDrivingMode||'ROBOSPHERE';}
    const automatic=['STARTING','RUNNING'].includes(p.journey?.status)&&p.controlMode==='AUTOMATIC';
    if(automatic)$('studioManualMode').dataset.mode=p.journey?.driving_mode||'ROBOSPHERE';
    if(p.controlMode==='MANUAL')$('studioManualMode').dataset.mode=p.manualDrivingMode||'ROBOSPHERE';
    const manualMode=$('studioManualMode').dataset.mode;
    controlBar.querySelectorAll('[data-manual-mode]').forEach(button=>{
      button.disabled=automatic||p.controlMode==='MANUAL'||p.isReplay||!p.fresh;
      button.setAttribute('aria-pressed',String(button.dataset.manualMode===manualMode));
      button.title=button.disabled&&automatic?'Stop autonomous driving before changing protection':'';
    });
    txt($('studioRouteContext'),p.route?.destination?.name||'No destination · keyboard available');
    txt($('studioControlStage'),automatic?'Self-driving · '+modeName(manualMode):p.controlMode==='MANUAL'?'Keyboard driving · '+modeName(manualMode):'Vehicle held');
    txt($('studioManualContext'),manualMode==='NORMAL'?'Normal · obstacle protection off':'Robosphere · '+(p.safetySystem?.controller||'RULE')+' protection');
    txt($('startDrivingBtn'),automatic?'Take manual control':p.controlMode==='MANUAL'?'Keyboard active':'Start keyboard control');
    $('startDrivingBtn').disabled ||= p.controlMode==='MANUAL';
    $('studioManualStop').disabled=!p.fresh||p.isReplay||!p.controller||!['MANUAL','AUTOMATIC'].includes(p.controlMode);
    $('studioResultsLink').disabled=p.isReplay&&!p.journeyComparison;
    mobileEngineStop.disabled=$('stopSimulatorBtn').disabled;
    txt($('studioSetupDockLabel'),$('guidedPrimary').textContent||'Open driving setup');
    if(!document.body.classList.contains('light-cockpit')&&['RUNNING','STARTING'].includes(p.journey?.status))document.body.classList.remove('studio-setup-open');
    unifiedMap.update(vehicle);
    $('studioFullscreenEmergency').disabled=$('emergencyStopBtn').disabled;
    $('studioFullscreenStop').disabled=!p.fresh||!p.controller||p.isReplay;
    const setupEmergency=$('advancedSetupEmergency');if(setupEmergency)setupEmergency.disabled=$('emergencyStopBtn').disabled;
    for(const m of JOURNEY_MODES)cards[m].button.disabled=['RUNNING','STARTING'].includes(p.journey?.status)||!!p.recording||!!pending.intent||p.isReplay;
    const fresh=p.fresh&&!p.isReplay,measured=p.fresh,num=(v,suffix='',digits=0)=>Number.isFinite(v)?v.toFixed(digits)+suffix:'—';
    txt($('studioTown'),p.world?.map?.split('/').pop()||'CARLA');
    txt($('studioOwnership'),p.isReplay?'Recorded replay':!fresh?'Simulator offline':p.controller?'Vehicle control owned':'Observer · control elsewhere');
    txt($('studioSpeed'),measured?num(vehicle.speedKmh):'—');txt($('studioGear'),measured?vehicle.gear||'N':'N');
    txt($('studioTarget'),p.controlMode==='MANUAL'?'30 · Shift 80 max':'Target '+(fresh?num(p.journey?.speed_kmh,' km/h'):'—'));
    const run=p.journeyComparison?.runs?.[p.journey?.driving_mode];
    txt($('studioMode'),p.isReplay?'Recorded replay':!fresh?'Simulator disconnected':p.controlMode==='MANUAL'?'Keyboard · '+modeName(p.manualDrivingMode):['RUNNING','STARTING'].includes(p.journey?.status)?(p.journey.status==='STARTING'?'Starting · ':'')+modeName(p.journey.driving_mode):$('driveState').textContent);
    const braking=p.stopDiagnostics?.braking,active=p.safetySystem?.active&&p.journey?.driving_mode!=='NORMAL';
    const rear=p.journey?.status==='RUNNING'&&p.safetySystem?.side_rear_observations?.find(item=>item.relation==='REAR_APPROACH'&&item.matched_frames>=5&&item.time_to_conflict_s>0&&item.time_to_conflict_s<=2);
    const front=p.safetySystem?.measured_range_m;
    if(!document.body.classList.contains('light-cockpit')){
      intervention.hidden=!fresh||!(active||braking||rear);
      intervention.dataset.tone=rear&&!active&&!braking?'info':'warning';
      txt(intervention,rear&&Number.isFinite(front)&&front<5?`Rear vehicle closing · front gap ${front.toFixed(1)} m; holding to avoid a front collision`:active?'Safety intervention · '+controlReasonText(p.safetySystem.reason||'RULE braking'):braking?(p.stopDiagnostics.decision_source||'Vehicle hold')+' · '+controlReasonText(p.stopDiagnostics.reason||'Brake applied'):rear?`Rear vehicle closing · ${p.rearAssist?'accelerating within target speed':'keeping lane and forward clearance'}`:'');
    }
    txt($('studioElapsed'),run?.status==='RUNNING'?num(run.duration_s,' s'):'');
    mode.dataset.mode=p.controlMode==='MANUAL'?p.manualDrivingMode:p.journey?.driving_mode||'';
    const sensorKeys=Object.keys(p.sensorMetadata||{}),healthy=sensorKeys.filter(k=>!p.sensorErrors?.[k]).length;
    [fresh?p.population?.actual?.vehicles:null,fresh?p.population?.actual?.pedestrians:null,
      fresh?p.maneuver?.front_gap_m??p.safetySystem?.measured_range_m:null,fresh?p.maneuver?.front_ttc_s??p.safetySystem?.ttc_s:null,
      fresh&&Number.isFinite(vehicle.brake)?vehicle.brake*100:null,fresh&&run?.setup?.collision_measurement_available?run.collisions:null].forEach((value,i)=>txt(liveValues[i],num(value,i===2?' m':i===3?' s':i===4?'%':'',i===2||i===3?1:0)));
    txt($('studioHealthStatus'),fresh?p.controlMode==='AUTOMATIC'?'Active':'Ready':'Offline');
    $('studioHealthStatus').dataset.tone=!fresh?'neutral':p.safetySystem?.active?'danger':p.safetySystem?.status?.includes('FAULT')?'danger':'success';
    txt($('studioSensorHealth'),fresh?healthy+' / '+sensorKeys.length:'Waiting');
    txt($('studioControlHealth'),fresh?p.controlMode==='AUTOMATIC'&&p.journey?.driving_mode==='BASELINE'?'حماية سائق CARLA':p.controlMode==='AUTOMATIC'&&p.journey?.driving_mode==='HYBRID'?'متابعة الحركة':p.journey?.driving_mode==='NORMAL'&&p.controlMode==='AUTOMATIC'?'Normal · route and signals':p.safetySystem?.active?'RULE braking':p.controlMode==='AUTOMATIC'?'RULE monitoring':'Vehicle held':'Vehicle held');
    txt($('studioRate'),fresh?num(p.performance?.nativeTickRateHz,' Hz',1):'Offline');
    const cameraChange=tools.cameraChange,confirmedView=cameraChange?.status==='applied'?cameraChange.requested:tools.catalog?.settings?.camera_view;
    views.querySelectorAll('[data-camera]').forEach(b=>{b.setAttribute('aria-pressed',String(!!confirmedView&&b.dataset.camera===confirmedView));b.disabled=$('cameraView').disabled||cameraChange?.status==='pending';});
    txt(cameraStatus,cameraChange?.status==='pending'?'Changing camera…':cameraChange?.status==='failed'?cameraChange.error:cameraChange?.status==='applied'?cameraChange.requested[0].toUpperCase()+cameraChange.requested.slice(1)+' view applied':'');
    cameraStatus.dataset.tone=cameraChange?.status||'';
    // Advanced mode keeps the original control layout; guided mode puts vision below the road.
    if(document.body.dataset.ui==='guided'&&views.nextElementSibling!==$('modelVision'))$('modelVision').before(views);
    if(pending.intent&&!pending.sent&&fresh&&p.controller&&p.controlMode==='PAUSED'&&Math.abs(vehicle.speedMps)<.15) {
      if(pending.intent.pair_id) {
        previousPreparation=p.dashboardResult?.operationId;
        if(p.dashboardAction('prepare_journey_mode',pending.intent)){pending.sent=true;preparedRequest=pending.intent;}
      } else {guided.chooseMode(pending.intent.mode);pending.intent=null;}
    }
    if(preparedRequest&&p.dashboardResult?.operationId!==previousPreparation&&p.dashboardResult?.action==='prepare_journey_mode'&&['APPLIED','REJECTED'].includes(p.dashboardResult.status)) {
      if(p.dashboardResult.status==='APPLIED')guided.chooseMode(preparedRequest.mode);
      else {p.operationError=p.dashboardResult.error;failedPreparation=preparedRequest;recovery.hidden=false;}
      pending.intent=preparedRequest=null;
    }
    if(preparedRequest&&p.operationError){failedPreparation=preparedRequest;recovery.hidden=false;pending.intent=preparedRequest=null;}
    if(pending.intent&&!pending.sent)txt($('guidedStatus'),!fresh?'Comparison selected. Connect the simulator to restore its setup.':!p.controller?'Comparison selected. Take vehicle control to restore its setup.':p.controlMode!=='PAUSED'||Math.abs(vehicle.speedMps)>=.15?'Stop and wait for the vehicle to be held before restoring the comparison.':'Restoring the saved comparison setup…');
    if(preparedRequest)txt($('guidedStatus'),'Restoring the saved origin, route and traffic. Waiting for confirmation.');
    const data=p.journeyComparison,key=JSON.stringify(data);
    if(key===resultKey)return;resultKey=key;
    const summary=comparisonSummary(data);
    txt($('ordinaryComparisonTitle'),summary.title);txt($('ordinaryComparisonHint'),summary.detail);
    if(summary.arrived&&!pending.intent&&!preparedRequest&&!failedPreparation)txt($('ordinaryRecoveryStatus'),'');
    const archiveNote=data?.storage_error?` · Result save failed: ${data.storage_error}`:'';
    if(archiveNote&&!$('ordinaryComparisonHint').textContent.includes(archiveNote))$('ordinaryComparisonHint').textContent+=archiveNote;
    txt($('ordinaryComparisonCount'),summary.count+' of 2 attempts recorded');$('ordinaryComparisonProgress').value=summary.count;
    ordinary.dataset.complete=String(summary.arrived&&data?.conditions_match===true);
    txt($('ordinaryRecordingReferences'),JOURNEY_MODES.filter(m=>data?.runs?.[m]?.recording).map(m=>modeName(m)+': '+data.runs[m].recording).join(' · ')||'No recordings yet.');
    for(const m of JOURNEY_MODES) {
      const c=cards[m],r=data?.runs?.[m];c.panel.dataset.empty=String(!r);
      const labels={ARRIVED:'Completed',RUNNING:'Recording',COLLISION:'Collision',INTERRUPTED:'Incomplete',ERROR:'Failed',FAILURE:'Failed',TIMEOUT:'Incomplete'};
      txt(c.header.querySelector('.run-status'),r?labels[r.status]||r.status:'Not run');
      c.header.querySelector('.run-status').dataset.status=r?.status||'EMPTY';
      fields.forEach(([,field,digits,suffix],i)=>{
        txt(c.values[i].querySelector('dd'),metricValue(r,field,digits,suffix));
        const d=m==='ROBOSPHERE'?measuredDifference(data,field):null;
        txt(c.values[i].lastChild,d!==null?(d>0?'+':'')+d.toFixed(digits)+suffix+' vs Normal':'');
      });
      const timeline=r?.risk_timeline||[],bars=c.chart.querySelector('.risk-bars');
      const chartKey=JSON.stringify(timeline);
      if(c.chartKey!==chartKey){c.chartKey=chartKey;bars.replaceChildren(...timeline.filter((_,i)=>i%Math.max(1,Math.ceil(timeline.length/100))===0).map(point=>{const bar=node('i');bar.dataset.risk=point.risk;bar.title=point.elapsed_s.toFixed(1)+' s · '+point.risk;return bar;}));}
      txt(c.chart.lastChild,!r?'No simulation data':timeline.length?'High · clear · unknown (grey)':'Waiting for measured samples');
      txt(c.extra,r?`Mean ${metricValue(r,'mean_speed_kmh',1,' km/h')} · max impulse ${metricValue(r,'maximum_impulse_ns',1,' N·s')} · ${r.samples} samples${r.reason?' · '+r.reason.replaceAll('_',' '):''}`:'Not simulated yet. No measurements recorded.');
      const eventKey=JSON.stringify(r?.events||[]);
      if(eventKey!==c.eventKey){c.eventKey=eventKey;c.events.replaceChildren(...(r?.events||[]).slice(-3).reverse().map(e=>{const li=node('li');li.append(node('strong','',e.title),node('span','',e.detail));return li;}));}
      txt(c.button,(r?'Run again · ':'Run ')+modeName(m)+' ↗');
    }
    const rows=[['Run ID',r=>r.id],['Status',r=>r.status],['Town',r=>r.setup?.map],['Vehicle',r=>r.setup?.blueprint],['Destination',r=>r.setup?.destination?.name],['Origin',r=>r.setup?.origin?.location?.map(x=>x.toFixed(2)).join(', ')],['Target speed',r=>Number.isFinite(r.setup?.speed_kmh)?r.setup.speed_kmh+' km/h':null],['Traffic seed',r=>r.setup?.population?.seed],['Requested population',r=>r.setup?.population&&`${r.setup.population.vehicle_count} vehicles · ${r.setup.population.pedestrian_count} pedestrians · ${r.setup.population.chaos_percent}% randomness`],['Applied population',r=>r.setup?.actual_population&&JSON.stringify(r.setup.actual_population)],['Weather',r=>r.setup?.weather&&JSON.stringify(r.setup.weather)],['Protection',r=>r.mode==='NORMAL'?'Obstacle protection off; route and signals only':'Established RULE protection'],['Recording',r=>r.recording||'No recording reference'],['Recorded at UTC',r=>r.created_at_utc]];
    const table=node('table');table.innerHTML='<thead><tr><th scope="col">Conditions</th><th scope="col">With Robosphere</th><th scope="col">Without Robosphere</th></tr></thead>';
    const tbody=node('tbody');for(const [label,get] of rows){const tr=node('tr');const th=node('th','',label);th.scope='row';tr.append(th);for(const m of JOURNEY_MODES){const r=data?.runs?.[m];tr.append(node('td','',r?get(r)??'Not measured':'Not Run'));}tbody.append(tr);}table.append(tbody);$('ordinaryProvenance').replaceChildren(table);
  }};
}
