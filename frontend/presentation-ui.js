import {driveState,comparisonBusy} from './workspace-state.js';
import {renderComparison,renderJourneyResults} from './results-view.js';
import {comparisonV2Busy,comparisonStartBlocked} from './comparison-v2.js';
const $=id=>document.getElementById(id);
const setText=(id,value)=>{if($(id).textContent!==value)$(id).textContent=value;};
let activePhase='drive',lastResults=null,historySession=null,lastSafety=null,newDriveRequested=false;
const history=[];

export function showWorkspace(phase,{focus=false}={}) {
  if(phase==='setup') {
    const dialog=$('advancedSetupDialog');
    if(dialog){$('setupPhase').hidden=false;dialog.showModal();document.dispatchEvent(new CustomEvent('advancedsetupopen'));return;}
  }
  if(!['drive','results'].includes(phase))return;
  if($('advancedSetupDialog')?.open)$('advancedSetupDialog').close();
  activePhase=phase;
  for(const other of ['drive','results','setup']) {
    $(other+'Phase').hidden=other!==phase;
    $(other+'Tab').setAttribute('aria-selected',String(other===phase));
    $(other+'Tab').tabIndex=other===phase ? 0 : -1;
  }
  document.body.dataset.workspace=phase;
  document.dispatchEvent(new CustomEvent('workspacechange',{detail:{phase}}));
  window.scrollTo({top:0,behavior:'auto'});
  if(focus)$(phase+'Tab').focus();
}

// Move existing controls without replacing their authoritative driving handlers.
export function presentationUI(provider) {
  const inspector=$('simulationCenter'),old=document.createElement('div');
  while(inspector.firstChild)old.append(inspector.firstChild);
  old.querySelector('#safetyStatus').remove();
  const nav=document.createElement('nav'); nav.className='workspace-tabs';
  nav.setAttribute('role','tablist'); nav.setAttribute('aria-label','Workspaces');
  nav.title='Destination journeys continue across workspaces. Manual keyboard driving stops when leaving Driving.';
  nav.innerHTML='<button role="tab" id="driveTab" aria-controls="drivePhase" aria-selected="true">Driving</button><button role="tab" id="resultsTab" aria-controls="resultsPhase" aria-selected="false" tabindex="-1">Results</button><button role="tab" id="setupTab" aria-controls="setupPhase" aria-selected="false" tabindex="-1">Setup</button>';
  $('brand').after(nav);
  $('setupTab').hidden=true;
  const ownership=document.createElement('button'); ownership.id='ownershipBtn'; ownership.textContent='Take control';
  ownership.onclick=()=>provider.takeControl(); document.querySelector('.connection').after(ownership);
  const emergency=old.querySelector('#emergencyStopBtn'); emergency.innerHTML='<span aria-hidden="true">■</span> Emergency stop';
  document.querySelector('.app-header').append(emergency);
  document.querySelector('#brand .eyebrow').textContent='Driving safety lab';
  const heading=document.querySelector('.workspace-heading');
  heading.innerHTML='<div><span id="sessionScope" class="eyebrow">CURRENT SESSION</span><h2 id="workspaceTitle">Driving workspace</h2></div><div class="workspace-tools"></div>';
  heading.querySelector('.workspace-tools').append($('toolbar'));
  $('sensorBtn').lastChild.textContent='Diagnostics';
  const strip=document.createElement('section'); strip.className='controller-strip'; strip.setAttribute('aria-label','Current session status');
  strip.innerHTML='<div><span class="eyebrow">Drive state</span><span id="driveState" class="state-value" role="status">Disconnected</span></div><div><span class="eyebrow">Driving mode</span><strong id="currentDrivingMode">Unavailable</strong></div><div><span class="eyebrow">Safety system</span><strong id="currentSafetyState">Waiting for sensors</strong></div><div title="Reported by the live controller; resets when driving stops. Recorded totals appear in Results."><span class="eyebrow">Live safety counter</span><strong id="liveInterventions">— interventions</strong></div>';
  heading.after(strip);
  const drive=document.createElement('section'); drive.id='drivePhase'; drive.className='driving-layout'; drive.setAttribute('role','tabpanel'); drive.setAttribute('aria-labelledby','driveTab');
  drive.append(document.querySelector('.visual-workspace'),inspector); strip.after(drive);
  inspector.innerHTML=`<section class="safety-monitor" aria-labelledby="safetyMonitorTitle"><div class="section-heading"><h2 id="safetyMonitorTitle"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 8 4v5c0 5-8 9-8 9s-8-4-8-9V7ZM8 12l3 3 5-6"/></svg> Safety monitor</h2><span class="session-label">CURRENT SESSION</span></div><p id="safetyStatus" class="safety-readout" role="status">Waiting for sensors</p><div class="safety-risk"><span>Risk level</span><strong id="safetyRisk">Not assessed</strong></div><p id="safetyReason">Connect the simulator to assess risk.</p><div class="last-intervention"><span>Last observed intervention</span><p id="lastIntervention">None observed in this session</p></div></section>
    <section class="route-overview" aria-labelledby="routeOverviewTitle"><div class="section-heading"><h3 id="routeOverviewTitle">Route & map</h3><span aria-hidden="true">N ↑</span></div><div id="inlineMapSlot"></div><div class="route-summary"><strong id="routeName">Choose a destination</strong><span id="routeRemaining">Your route will appear here.</span></div></section>
    <section class="drive-actions"><button id="primaryDriveAction" class="primary">Start the simulation</button><p id="primaryActionHint" class="muted" role="status"></p><div id="quickDriveActions" class="secondary-actions"></div><div id="stopAcknowledgement"></div></section>
    <details class="normal-driving"><summary>Manual controls & destination speed</summary><div id="normalControls"></div></details>
    <details class="comparison-controls"><summary>Run a safety comparison</summary><p class="muted">Two recorded runs with the same starting conditions.</p><div id="comparisonControls"></div><button id="comparisonSetupBtn">Configure comparison</button></details>
    <details class="session-timeline"><summary>Safety timeline <span id="timelineCount">0 events</span></summary><p class="muted">Observed on this page in the current session. This is a partial event log.</p><ol id="safetyTimeline"></ol></details>
    <div id="liveOperationStatus" class="inspector-footer"></div>`;
  $('inlineMapSlot').append($('miniMapToggle')); $('miniMapToggle').setAttribute('aria-label','Expand route map and choose a destination'); $('miniRouteHint').textContent='Expand map ↗';
  $('primaryDriveAction').onclick=()=>{const target=$('primaryDriveAction').dataset.action; if(target)$(target)?.click();};
  inspector.querySelector('.safety-monitor').after(inspector.querySelector('.drive-actions'));
  $('quickDriveActions').append(old.querySelector('#startDrivingBtn'),$('phoneToggleBtn'));
  $('stopAcknowledgement').append(old.querySelector('#acknowledgeStopBtn'));
  $('normalControls').append(old);
  for(const [label,title] of [['Training environment','Controlled research tools'],['City population','City population & recording']]) {
    const details=document.createElement('details'); details.innerHTML='<summary>'+title+'</summary>'; details.append($('normalControls').querySelector('[aria-label="'+label+'"]')); $('sensorPanel').append(details);
  }
  $('liveOperationStatus').append($('operationStatus'),$('recordingStatus'));
  $('controlMode').hidden=true;
  $('sensorPanel').append($('controlMode'),$('controlSource'),$('sensorStatus'),$('performance'),$('cameraTimestamp'));
  $('toolbar').append($('replayPauseBtn'));
  const demo=document.querySelector('.comparison-demo');
  demo.querySelector('.muted').textContent='Each run resets the scene and records automatically. Traffic can diverge after an intervention.';
  $('comparisonControls').append(demo); $('demoStopBtn').textContent='Reset simulation'; $('demoStopBtn').classList.add('reset-action');
  const activity=document.createElement('details'); activity.innerHTML='<summary>Hazard schedule</summary><pre id="hazardActivity">No comparison active</pre>'; $('comparisonControls').append(activity);
  const results=document.createElement('section'); results.id='resultsPhase'; results.setAttribute('role','tabpanel'); results.setAttribute('aria-labelledby','resultsTab'); results.hidden=true;
  results.innerHTML='<div class="analysis-heading"><div><h2>Comparison results</h2><p id="resultScope" class="muted">Recorded measurements</p></div><button id="newDriveBtn" class="primary">Start a new drive ↗</button></div><div id="resultContent"></div><details class="recording-archive"><summary>Recording archive</summary><p class="muted">Saved runs, including interrupted attempts. These measurements are separate from the current session.</p><div id="recordingArchive"></div></details>';
  drive.after(results);
  results.querySelector('h2').textContent='Journey results';
  const journeyResults=document.createElement('section'); journeyResults.id='journeyResults';
  const historicalHeading=document.createElement('h2'); historicalHeading.textContent='Historical safety comparison';
  const journeyScope=document.createElement('p'); journeyScope.className='muted'; journeyScope.textContent='Saved RULE measurements · MODEL is experimental';
  $('resultScope').before(journeyScope);
  $('resultContent').append(journeyResults,historicalHeading,$('resultScope'),$('demoResults'));
  $('newDriveBtn').onclick=()=>{newDriveRequested=true; showWorkspace('drive',{focus:true}); $('primaryDriveAction').focus();};
  const setup=document.createElement('section'); setup.id='setupPhase'; setup.className='setup-workspace'; setup.setAttribute('role','tabpanel'); setup.setAttribute('aria-labelledby','setupTab'); setup.hidden=true;
  setup.innerHTML=`<div class="analysis-heading"><div><h2>Experiment setup</h2><p class="muted">Set the starting conditions before recording a comparison.</p></div><button id="setupDriveBtn" class="primary">Return to driving ↗</button></div><div class="setup-columns"><section><h3>Comparison scenario</h3><label for="comparisonScenario">Scenario</label><select id="comparisonScenario"><option value="URBAN_CHAOS">Urban Chaos</option><option value="FRONT_OBSTACLE">Front Obstacle</option></select><label for="comparisonSeed">Scenario seed · test split</label><input id="comparisonSeed" type="number" min="2000" max="2999" value="2589"><p id="comparisonRecipe" class="muted">40 traffic vehicles · 30 pedestrians · 20 km/h · 60 simulation seconds</p><p class="muted">BasicAgent vehicle and traffic-light checks are disabled in both research runs. Normal destination journeys retain their checks.</p></section><section><h3>Graphics preset</h3><div class="graphics-presets"><button data-preset="LOW">Low</button><button data-preset="BALANCED">Balanced</button><button data-preset="HIGH">High</button><button data-preset="ULTRA">Ultra</button></div><p id="presetApplied" role="status">Reading engine configuration…</p><p class="muted">Applying a preset restarts CARLA and leaves the vehicle stopped.</p><button id="setupSettings">Simulator settings</button></section></div>`;
  results.after(setup);
  const dialog=document.createElement('dialog');dialog.id='advancedSetupDialog';dialog.setAttribute('aria-label','Advanced configuration');
  dialog.innerHTML='<div class="advanced-dialog-heading"><strong>Advanced configuration</strong><button id="advancedSetupEmergency" class="emergency">Emergency stop</button><button id="closeAdvancedSetup" aria-label="Close advanced configuration">Close ×</button></div>';
  document.body.append(dialog);dialog.append(setup);setup.removeAttribute('role');setup.removeAttribute('aria-labelledby');
  const closeSetup=()=>{dialog.close();setup.hidden=true;};
  $('closeAdvancedSetup').onclick=closeSetup;
  $('advancedSetupEmergency').onclick=()=>{closeSetup();$('emergencyStopBtn').click();};
  dialog.addEventListener('close',()=>{setup.hidden=true;});
  $('setupDriveBtn').onclick=()=>{closeSetup();showWorkspace('drive',{focus:true});};
  $('comparisonSetupBtn').onclick=()=>showWorkspace('setup',{focus:true});
  $('setupSettings').onclick=()=>{closeSetup();$('settingsBtn').click();};
  for(const phase of ['setup','drive','results'])$(phase+'Tab').onclick=()=>showWorkspace(phase);
  nav.onkeydown=event=>{
    const tabs=[...nav.querySelectorAll('[role=tab]')].filter(el=>!el.hidden),current=tabs.indexOf(document.activeElement);
    if(current<0||!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(event.key))return;
    event.preventDefault(); const next=event.key==='Home' ? 0 : event.key==='End' ? tabs.length-1 : (current+(['ArrowRight','ArrowDown'].includes(event.key) ? 1 : -1)+tabs.length)%tabs.length;
    tabs[next].click(); tabs[next].focus();
  };
  document.querySelectorAll('[data-preset]').forEach(button=>button.onclick=()=>{provider.stopDriving('graphics_preset'); provider.dashboardAction('restart_graphics',{preset:button.dataset.preset});});
  const detection=document.createElement('details'); detection.className='detection-details';
  detection.innerHTML='<summary>Object detection & sign reading <span id="detectionSummary">Waiting for camera</span></summary>'; detection.append($('perceptionPanel')); $('liveOperationStatus').before(detection);
  const cameraHeading=$('cameraCard').querySelector('.section-heading'),providerTitle=$('providerTitle'),activityBadge=$('cameraActivity'),caption=document.querySelector('.camera-caption');
  providerTitle.classList.add('sr-only'); $('cameraCard').prepend(providerTitle);
  cameraHeading.classList.add('camera-heading');
  cameraHeading.replaceChildren(...heading.children,document.querySelector('.camera-tools'));
  heading.remove();
  caption.prepend(activityBadge); $('cameraSource').classList.add('sr-only');
  document.querySelector('.app-footer').append(caption);
  const freshness=document.createElement('p'); freshness.id='perceptionFreshness'; freshness.setAttribute('role','status'); $('perceptionFrame').before(freshness);
  for(const [id,label] of [['throttleVal','Throttle'],['brakeVal','Brake']]) {
    const meter=document.createElement('span'); meter.className='instrument-meter'; meter.setAttribute('role','progressbar'); meter.setAttribute('aria-label',label); meter.setAttribute('aria-valuemin','0'); meter.setAttribute('aria-valuemax','100'); meter.innerHTML='<i></i>'; $(id).after(meter);
  }
  const resolution=document.createElement('option'); resolution.textContent='1280x720'; $('settingResolution').append(resolution);
  showWorkspace('drive');
}

function observeSafety(p,state) {
  const session=[p.sessionId,p.comparisonDemo?.recording||'normal'].join(':');
  if(historySession!==session) {historySession=session; history.length=0; lastSafety=null; $('safetyTimeline').replaceChildren(); $('lastIntervention').textContent='None observed in this session'; $('timelineCount').textContent='0 events';}
  const safety=p.safetySystem; if(!p.fresh||p.isReplay||!safety)return;
  if((safety.active&&(!lastSafety?.active||safety.intervention_count!==lastSafety.count))||(lastSafety?.active&&!safety.active)) {
    const entry={time:state.timestamp,title:safety.active ? 'Safety intervention' : 'Control released',reason:safety.reason||'Reason unavailable',brake:state.brake,speed:state.speedKmh};
    history.push(entry); if(history.length>40)history.shift();
    if(safety.active)$('lastIntervention').textContent=entry.reason+' · brake '+(Number.isFinite(entry.brake) ? Math.round(entry.brake*100)+'%' : 'unavailable');
    $('safetyTimeline').replaceChildren(...history.slice().reverse().map(event=>{
      const row=document.createElement('li'),title=document.createElement('strong'),detail=document.createElement('p');
      title.textContent=event.title+' · t '+(Number.isFinite(event.time) ? event.time.toFixed(1)+' s' : '—');
      detail.textContent=event.reason+' · Brake '+(Number.isFinite(event.brake) ? Math.round(event.brake*100)+'%' : '—')+' · '+(Number.isFinite(event.speed) ? event.speed.toFixed(1)+' km/h' : 'Speed unavailable'); row.append(title,detail); return row;
    }));
    $('timelineCount').textContent=history.length+' events';
  }
  lastSafety={active:safety.active,count:safety.intervention_count};
}

export function updatePresentation(p,state,armed,manualStartPending=false) {
  const demo=p.comparisonDemo,busy=comparisonBusy(demo)||comparisonV2Busy(p.comparisonV2);
  if(busy||['MANUAL','AUTOMATIC'].includes(p.controlMode))newDriveRequested=false;
  const presentationProvider=newDriveRequested ? {...p,fresh:p.fresh,comparisonDemo:demo?.phase==='FINISHED' ? {...demo,phase:'IDLE'} : demo,comparisonV2:p.comparisonV2?.phase==='FINISHED' ? {...p.comparisonV2,phase:'IDLE'} : p.comparisonV2,journey:p.journey?.status==='ARRIVED' ? {...p.journey,status:'READY'} : p.journey} : p;
  const view=driveState(manualStartPending ? {...presentationProvider,fresh:p.fresh,manualStartPending:true} : presentationProvider,state,armed);
  $('ownershipBtn').hidden=p.controller||p.isReplay||!p.fresh; $('ownershipBtn').disabled=!p.fresh||p.isReplay;
  setText('driveState',view.label); $('driveState').dataset.tone=view.tone;
  $('currentDrivingMode').textContent=view.mode; $('currentSafetyState').textContent=view.safetyLabel; $('currentSafetyState').dataset.tone=view.safetyTone;
  if(p.fresh&&!p.isReplay&&p.safetySystem)$('currentSafetyState').textContent=view.safetyLabel+' · '+p.safetySystem.controller;
  $('liveInterventions').textContent=(view.interventions??'—')+' interventions';
  setText('safetyStatus',view.safetyLabel); $('safetyStatus').dataset.tone=view.safetyTone;
  $('safetyRisk').textContent=view.risk; $('safetyRisk').dataset.tone=view.safetyTone; $('safetyReason').textContent=view.reason;
  setText('workspaceTitle',{drive:'Driving workspace',results:'Results workspace',setup:'Simulation setup'}[activePhase]);
  setText('sessionScope','CURRENT SESSION · '+(p.isReplay ? 'RECORDED REPLAY' : p.fresh ? 'CARLA CONNECTED' : 'CARLA DISCONNECTED'));
  if(busy)for(const id of ['startDrivingBtn','startJourneyBtn','phoneJourneyBtn','driveJourneyBtn','journeySpeed']) {$(id).disabled=true; $(id).title='Stop the comparison before starting another drive';}
  setText('primaryDriveAction',view.actionLabel); $('primaryDriveAction').dataset.action=view.action||''; $('primaryDriveAction').disabled=!view.action||!!$(view.action)?.disabled;
  setText('primaryActionHint',p.operationError||p.comparisonV2?.error||demo?.error||(p.isReplay ? 'Playback only. Vehicle controls are disabled.' : !p.fresh ? p.status : !p.controller ? 'Another page currently controls the vehicle.' : view.label==='Drive completed' ? 'Your drive is recorded. Review it or start another.' : busy ? 'Comparison recording is active.' : p.comparisonV2 ? comparisonStartBlocked(p)||'Rules driving restores the saved journey and records automatically. MODEL is experimental.' : 'Choose a destination or start a manual drive.'));
  $('routeName').textContent=p.route?.destination?.name||'Choose a destination'; $('routeRemaining').textContent=p.route ? (Number.isFinite(p.route.remaining_m) ? Math.round(p.route.remaining_m)+' m remaining' : 'Route selected')+(p.route.arrived ? ' · Arrived' : '') : 'Select a road point or saved destination.';
  $('miniRouteHint').textContent='Expand map ↗';
  $('hazardActivity').textContent=Object.entries(demo?.hazards||{}).map(([name,v])=>name+': '+v.status).join('\n')||'No comparison active';
  const journeyResults=p.comparisonV2 || p.recordedComparisonV2;
  const signature=JSON.stringify([demo?.results,demo?.archived_comparison,demo?.archive,journeyResults?.results,journeyResults?.latest_attempt,journeyResults?.pair_id,p.fresh]);
  if(signature!==lastResults) {lastResults=signature; renderComparison(demo); renderJourneyResults(journeyResults,p.fresh);}
  $('presetApplied').textContent=($('activeGraphics').textContent||'Waiting for engine settings')+(p.restartResult ? ' · '+p.restartResult.status : '');
  $('comparisonRecipe').textContent=$('comparisonScenario').value==='URBAN_CHAOS' ? '40 traffic vehicles · 30 pedestrians · 20 km/h · 60 simulation seconds' : 'Front obstacle · 28 km/h · 14 simulation seconds';
  for(const id of ['demoWithoutBtn','demoWithBtn'])$(id).disabled ||= busy;
  $('cameraView').disabled=busy||!p.controller||!p.fresh;
  for(const id of ['comparisonScenario','comparisonSeed'])$(id).disabled=busy;
  document.querySelectorAll('[data-preset]').forEach(button=>button.disabled=busy||!p.controller||!p.fresh||p.isReplay||Math.abs(state.speedMps??0)>.15);
  for(const [id,value] of [['throttleVal',state.throttle],['brakeVal',state.brake]]) {
    const meter=$(id).parentElement.querySelector('.instrument-meter'),percent=Number.isFinite(value) ? Math.max(0,Math.min(100,value*100)) : 0;
    meter.style.setProperty('--value',percent+'%');
    if(Number.isFinite(value))meter.setAttribute('aria-valuenow',Math.round(percent)); else meter.removeAttribute('aria-valuenow');
    meter.setAttribute('aria-valuetext',Number.isFinite(value) ? Math.round(percent)+'%' : 'Unavailable');
  }
  observeSafety(p,state);
}
