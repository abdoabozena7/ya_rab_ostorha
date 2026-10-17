import {showWorkspace} from './presentation-ui.js';
import {measuredPredictionFresh} from './prediction-view.js';
import {cockpitMeasurements,metricText,safetyNotice,safetyChip,driverCaption,perceptionCounts,detectionFrameMatches,containedImageRect,validDetectionBox,controlReasonText} from './cockpit-state.js';

const $ = id => document.getElementById(id);
const el = (tag,cls,text) => {const n=document.createElement(tag); if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};
const svg = path => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
const icons = {
  car:svg('<path d="m5 8 2-4h10l2 4M4 8h16v10H4zM7 12h2m6 0h2M6 18v2m12-2v2"/>'),
  route:svg('<path d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3ZM9 3v15M15 6v15"/>'),
  shield:svg('<path d="m12 3 8 4v5c0 5-8 9-8 9s-8-4-8-9V7Z"/><path d="m8 12 3 3 5-6"/>'),
  camera:svg('<path d="M4 7h4l2-3h4l2 3h4v13H4Z"/><circle cx="12" cy="13" r="3"/>'),
  expand:svg('<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>'),
  layers:svg('<path d="m12 3 10 5-10 5L2 8ZM2 12l10 5 10-5M2 16l10 5 10-5"/>'),
  person:svg('<circle cx="12" cy="5" r="2"/><path d="m7 21 3-7-2-4 4-2 3 4 4 1M12 9v6l4 6M8 10l-3 5"/>'),
  cube:svg('<path d="m12 3 9 5v9l-9 5-9-5V8ZM3 8l9 5 9-5M12 13v9M8 5l9 5"/>'),
  brake:svg('<circle cx="12" cy="12" r="6"/><path d="M4 5a10 10 0 0 0 0 14M20 5a10 10 0 0 1 0 14M12 9v4m0 3v.1"/>'),
  distance:svg('<path d="M3 7v10M21 7v10M4 12h16m-13-3-3 3 3 3m10-6 3 3-3 3"/>'),
  clock:svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
};
const set = (id,value) => {const n=$(id),s=String(value);if(n.textContent!==s)n.textContent=s;};

export function installLightCockpit(p,tools,perception,predictionView,onResume) {
  document.body.classList.add('light-cockpit');
  document.querySelector('#brand h1').textContent='YA RAB OSTORHA';
  document.querySelector('#brand .eyebrow').textContent='Driving Simulator';
  document.querySelector('.brand-mark').innerHTML=icons.shield;
  const rail=document.querySelector('.studio-rail'),nav=rail.querySelector('nav');
  rail.querySelector('.rail-brand').innerHTML=icons.car;
  $('driveTab').innerHTML=icons.car+'<span>Driving</span>';
  const oldButtons=[...rail.children].filter(n=>n.tagName==='BUTTON');
  const scenario=oldButtons.find(n=>n.textContent==='Map');
  const toolsNav=oldButtons.find(n=>n.textContent==='Tools');
  const diagnostics=oldButtons.find(n=>n.textContent==='Diagnostics');
  const settings=oldButtons.find(n=>n.textContent==='Settings');
  scenario.id='scenariosNav';scenario.innerHTML=icons.route+'<span>Scenarios</span>';
  scenario.setAttribute('aria-label','Scenarios');scenario.setAttribute('aria-controls','cockpitScenarios');scenario.setAttribute('aria-expanded','false');
  scenario.removeAttribute('title');settings.removeAttribute('title');toolsNav.removeAttribute('title');
  $('driveTab').removeAttribute('title');$('resultsTab').removeAttribute('title');
  nav.insertBefore(scenario,$('resultsTab'));nav.append(toolsNav,settings);
  const railCaption=el('span','rail-caption','CARLA 0.9.16');rail.querySelector('.rail-orb').replaceWith(railCaption);

  const setup=el('dialog','cockpit-dialog cockpit-scenarios');setup.id='cockpitScenarios';setup.setAttribute('aria-labelledby','cockpitScenariosTitle');
  setup.innerHTML='<header class="cockpit-dialog-heading"><div><span class="eyebrow">DRIVE CONFIGURATION</span><h2 id="cockpitScenariosTitle">Scenarios</h2></div><button type="button" class="cockpit-dialog-emergency">Emergency stop</button><button type="button" class="cockpit-dialog-close" aria-label="Close scenarios">×</button></header>';
  const inspector=document.querySelector('.drive-inspector');setup.append(inspector);
  const controlBar=document.querySelector('.studio-control-bar');setup.append(controlBar);
  document.body.append(setup);
  const openSetup=()=>{showWorkspace('drive');tools.close(false);if(p.controlMode==='MANUAL'||tools.options.isManualArmed?.())tools.clearControls('setup_inspection');document.body.classList.add('studio-setup-open');};
  scenario.onclick=openSetup;
  document.addEventListener('workspacechange',e=>{if(e.detail.phase==='results'&&setup.open)setup.close();});
  setup.querySelector('.cockpit-dialog-close').onclick=()=>setup.close();
  setup.addEventListener('close',()=>{document.body.classList.remove('studio-setup-open');scenario.setAttribute('aria-expanded','false');});
  setup.addEventListener('click',e=>{if(e.target===setup){const r=setup.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)setup.close();}});
  const syncSetup=()=>{
    const open=document.body.classList.contains('studio-setup-open');
    if(open&&!setup.open)setup.showModal();
    if(!open&&setup.open){setup.close();$('frontCameraView').focus({preventScroll:true});}
    scenario.setAttribute('aria-expanded',String(open));
  };
  new MutationObserver(syncSetup).observe(document.body,{attributes:true,attributeFilter:['class']});

  const toolDialog=el('dialog','cockpit-dialog');toolDialog.id='cockpitTools';toolDialog.setAttribute('aria-labelledby','cockpitToolsTitle');
  toolDialog.innerHTML='<header class="cockpit-dialog-heading"><h2 id="cockpitToolsTitle">Simulator tools</h2><button type="button" class="cockpit-dialog-emergency">Emergency stop</button><button type="button" class="cockpit-dialog-close" aria-label="Close tools">×</button></header><section class="cockpit-tool-group"><h3>Inspect & configure</h3><div id="cockpitToolActions"></div></section><section class="cockpit-tool-group"><h3>Simulator lifecycle</h3><p>Shut down the CARLA server and release its GPU memory. Use Stop in the header to end only the current drive.</p><div id="cockpitLifecycle"></div></section>';
  document.body.append(toolDialog);toolDialog.querySelector('.cockpit-dialog-close').onclick=()=>toolDialog.close();
  $('cockpitToolActions').append(diagnostics);
  diagnostics.onclick=()=>{toolDialog.close();tools.open('sensorPanel',toolsNav.id);};
  const research=el('button','','Scenario & research configuration');research.onclick=()=>{toolDialog.close();showWorkspace('setup');};$('cockpitToolActions').append(research);
  $('cockpitLifecycle').textContent='Free GPU and Reset are always available in the main header. Reset creates an empty session at the default start.';
  toolsNav.id='cockpitToolsNav';toolsNav.setAttribute('aria-controls','cockpitTools');toolsNav.setAttribute('aria-expanded','false');
  toolsNav.onclick=()=>{tools.close(false);if(p.controlMode==='MANUAL'||tools.options.isManualArmed?.())tools.clearControls('tools_inspection');toolDialog.showModal();toolsNav.setAttribute('aria-expanded','true');};
  toolDialog.addEventListener('close',()=>toolsNav.setAttribute('aria-expanded','false'));

  const header=document.querySelector('.app-header');
  const chips=el('div','cockpit-status-chips');chips.setAttribute('aria-label','Live simulator status');
  chips.innerHTML='<span class="cockpit-chip" id="cockpitConnection"><i></i><span id="cockpitConnectionText">CARLA Disconnected</span></span><span class="cockpit-chip" id="cockpitProtection">'+icons.shield+'<span id="cockpitProtectionText">Protection offline</span></span><span class="cockpit-chip" id="cockpitDriver">'+icons.car+'<span id="cockpitDriverText">Vehicle held</span></span>';
  const actions=el('div','cockpit-header-actions');actions.append($('replayPauseBtn'),$('stopSimulatorBtn'),$('resetSimulatorBtn'),$('studioManualStop'),$('emergencyStopBtn'),$('acknowledgeStopBtn'));
  header.append(chips,actions);
  $('studioManualStop').innerHTML='<span aria-hidden="true">■</span> Stop vehicle';$('studioManualStop').setAttribute('aria-label','Stop vehicle');
  $('studioManualStop').title='Full brake and end the current drive; start driving again to resume';
  $('emergencyStopBtn').textContent='Emergency stop';
  for(const btn of document.querySelectorAll('.cockpit-dialog-emergency'))btn.textContent='Emergency stop';
  for(const btn of document.querySelectorAll('.cockpit-dialog-emergency'))btn.onclick=()=>{btn.closest('dialog').close();$('emergencyStopBtn').click();};

  const camera=$('frontCameraView');camera.tabIndex=-1;
  const cameraTools=el('div','cockpit-camera-tools');
  const selector=el('label','cockpit-camera-select');selector.innerHTML=icons.camera+'<span class="sr-only">Camera view</span>';
  const select=el('select');select.id='cockpitCameraView';select.setAttribute('aria-label','Camera view');
  for(const option of $('cameraView').options){const n=option.cloneNode(true);n.textContent=n.value[0].toUpperCase()+n.value.slice(1)+' View';select.append(n);}
  selector.append(select);cameraTools.append(selector);
  const options=el('details','cockpit-overlay-settings');options.innerHTML='<summary aria-label="Overlay settings" title="Overlay settings">'+icons.layers+'</summary><div class="cockpit-overlay-menu"><strong>Camera overlays</strong><label><input type="checkbox" data-overlay="boxes">Bounding boxes <small>2D</small></label><label><input type="checkbox" data-overlay="labels">Object labels</label><label><input type="checkbox" data-overlay="trajectories">Trajectory predictions</label><label><input type="checkbox" data-overlay="safety">Safety highlights</label><p id="cockpitOverlayState">3D geometry unavailable. 2D boxes require the matching front-camera frame.</p><button type="button" id="cockpitAnalysisLink">View analyzed frame ↗</button></div>';
  cameraTools.append(options);camera.append(cameraTools);
  let preferences={boxes:true,labels:true,trajectories:true,safety:true};
  try{const saved=JSON.parse(localStorage.getItem('camera-overlays-v1'));for(const k of Object.keys(preferences))if(typeof saved?.[k]==='boolean')preferences[k]=saved[k];}catch{/* Optional browser-local preferences. */}
  predictionView.visualOptions=preferences;
  for(const box of options.querySelectorAll('input')){box.checked=preferences[box.dataset.overlay];box.onchange=()=>{preferences[box.dataset.overlay]=box.checked;try{localStorage.setItem('camera-overlays-v1',JSON.stringify(preferences));}catch{/* Keep in-memory settings. */}};}
  select.onchange=()=>{
    $('cameraView').value=select.value;$('cameraView').dispatchEvent(new Event('change'));
    if(tools.cameraChange?.status==='pending'){select.disabled=true;select.value=tools.cameraChange.confirmed||select.value;}
    select.blur();
  };
  document.addEventListener('click',e=>{if(!options.contains(e.target))options.open=false;});
  options.addEventListener('keydown',e=>{if(e.key==='Escape'){e.stopPropagation();options.open=false;options.querySelector('summary').focus();}});
  const expand=$('expandCameraBtn');expand.classList.add('camera-icon-button');expand.innerHTML=icons.expand;expand.setAttribute('aria-label','Expand camera');expand.title='Expand camera (F)';camera.append(expand);
  const cameraCaption=el('div','cockpit-camera-caption');cameraCaption.innerHTML='<span id="cockpitCameraState">Waiting for camera</span><span id="cockpitCameraRate"></span>';camera.append(cameraCaption);
  const canvas=el('canvas','cockpit-detections');canvas.hidden=true;canvas.setAttribute('aria-hidden','true');camera.append(canvas);

  const telemetry=el('aside','cockpit-telemetry');telemetry.setAttribute('aria-label','Essential driving telemetry');
  telemetry.innerHTML='<div class="cockpit-speed"><div class="cockpit-rail-heading">'+icons.car+'<h2>Vehicle speed</h2></div><div class="cockpit-gauge"><svg viewBox="0 0 200 115" aria-hidden="true"><path class="gauge-track" d="M22 98a78 78 0 0 1 156 0" pathLength="100"/><path id="cockpitSpeedArc" class="gauge-value" d="M22 98a78 78 0 0 1 156 0" pathLength="100"/><text x="19" y="114">0</text><text x="92" y="15">60</text><text x="165" y="114">120</text></svg><div class="cockpit-speed-value"><strong id="cockpitSpeed">—</strong><span>km/h</span></div></div><p id="cockpitTarget">Target —</p></div><div class="cockpit-metric cockpit-brake"><div>'+icons.brake+'<h3>Brake</h3><span>Applied</span></div><p><strong id="cockpitBrake">—</strong><span>%</span></p><div class="cockpit-brake-track"><span id="cockpitBrakeBar"></span></div><small id="cockpitBrakeReason" role="status">Waiting for command</small></div><div class="cockpit-metric cockpit-gap"><div>'+icons.distance+'<h3>Front gap</h3></div><p><strong id="cockpitGap">—</strong><span>m</span></p><small id="cockpitGapStatus">Measurement unavailable</small></div><div class="cockpit-metric cockpit-ttc"><div>'+icons.clock+'<h3 title="Time to collision from measured closing speed">Time to collision</h3></div><p><strong id="cockpitTtc">—</strong><span>s</span></p><small id="cockpitTtcStatus">Measurement unavailable</small></div>';
  $('cameraCard').append(telemetry);
  const summary=el('section','cockpit-summary');summary.setAttribute('aria-label','Perception summary');
  summary.innerHTML='<div class="cockpit-summary-heading"><h2>Objects in view</h2><p id="cockpitObjectsStatus">Front detections unavailable</p></div><div class="cockpit-object vehicles">'+icons.car+'<div><span>Vehicles</span><strong id="cockpitVehicles">—</strong></div></div><div class="cockpit-object people">'+icons.person+'<div><span>Pedestrians</span><strong id="cockpitPeople">—</strong></div></div><div class="cockpit-object tracks" title="Confirmed measured tracks from surrounding sensors; these are not camera detections">'+icons.cube+'<div><span>Tracked objects</span><strong id="cockpitTracks">—</strong><small>Surrounding sensors</small></div></div><button id="cockpitViewDetails">View details <span aria-hidden="true">↗</span></button>';
  $('cameraCard').append(summary);

  const details=el('dialog','cockpit-dialog cockpit-details');details.id='cockpitDetails';details.setAttribute('aria-labelledby','cockpitDetailsTitle');
  details.innerHTML='<header class="cockpit-dialog-heading"><h2 id="cockpitDetailsTitle">Camera & sensor details</h2><button type="button" class="cockpit-dialog-emergency">Emergency stop</button><button type="button" class="cockpit-dialog-close" aria-label="Close camera details">×</button></header><p id="cockpitDetailsStatus"></p><h3>Scenario population</h3><p class="muted">Actors configured in the world. These counts are separate from camera detections.</p>';
  const kpis=document.querySelector('.studio-kpis');kpis.firstElementChild.firstElementChild.textContent='Scenario vehicles';kpis.children[1].firstElementChild.textContent='Scenario pedestrians';
  details.append(kpis,$('modelVision'));
  const diagnosticButton=el('button','','Open full Diagnostics ↗');diagnosticButton.onclick=()=>{details.close();tools.open('sensorPanel','cockpitViewDetails');};details.append(diagnosticButton);
  document.body.append(details);details.querySelector('.cockpit-dialog-close').onclick=()=>details.close();
  details.querySelector('.cockpit-dialog-emergency').onclick=()=>{details.close();$('emergencyStopBtn').click();};
  const openDetails=()=>{if(p.controlMode==='MANUAL'||tools.options.isManualArmed?.())tools.clearControls('details_inspection');details.showModal();};
  $('cockpitViewDetails').onclick=openDetails;$('cockpitAnalysisLink').onclick=()=>{options.open=false;$('modelVision').open=true;openDetails();};
  // The existing empty-state action becomes the same native start/setup flow.
  $('connectionSetupBtn').onclick=()=>{
    const restart=$('presentationRestart');
    if(restart&&!p.simulationStarting&&!p.restarting)restart.click();else openSetup();
  };$('connectionSetupBtn').textContent='Run presentation';
  const safety=$('studioSafetyAlert');safety.replaceChildren();safety.setAttribute('aria-live','polite');safety.append(el('span','notice-icon'),el('div','notice-copy'));
  safety.firstElementChild.innerHTML=icons.shield;safety.lastElementChild.append(el('strong'),el('p'));
  const resume=el('button','','Resume driving');resume.id='cockpitResumeDrive';resume.type='button';resume.hidden=true;
  resume.onclick=()=>onResume?.(p.journey?.driving_mode||p.manualDrivingMode||'ROBOSPHERE');safety.append(resume);
  let lastNotice='',lastBoxKey='',previousMode=p.controlMode;

  function drawDetections(displayed) {
    const result=perception.result,front=p.sensorMetadata?.frontCamera;
    const match=preferences.boxes&&!tools.cameraChange?.status?.includes('pending')&&!$('authoritativeCamera').hidden&&detectionFrameMatches(result,p,displayed,front);
    canvas.hidden=!match;
    set('cockpitOverlayState',match?'2D fallback · exact front-camera frame. 3D geometry unavailable.':!preferences.boxes?'Bounding boxes hidden. 3D geometry unavailable.':'3D geometry unavailable. 2D boxes require the matching front-camera frame.');
    if(!match)return;
    const bounds=$('authoritativeCamera').getBoundingClientRect(),host=camera.getBoundingClientRect();
    const rect=containedImageRect(bounds,displayed.width,displayed.height);if(!rect){canvas.hidden=true;return;}
    Object.assign(canvas.style,{left:bounds.left-host.left+rect.left+'px',top:bounds.top-host.top+rect.top+'px',width:rect.width+'px',height:rect.height+'px'});
    const key=[result.image_token,preferences.labels].join(':');if(key===lastBoxKey)return;lastBoxKey=key;
    canvas.width=result.width;canvas.height=result.height;const c=canvas.getContext('2d');c.clearRect(0,0,canvas.width,canvas.height);c.lineWidth=Math.max(1,result.width/500);
    c.font=`600 ${Math.max(11,result.width/65)}px Manrope, sans-serif`;
    for(const detection of result.detections||[]){const b=validDetectionBox(detection,result.width,result.height);if(!b)continue;
      c.strokeStyle=detection.class==='person'?'#753CF7':'#4B84FC';c.strokeRect(b[0],b[1],b[2]-b[0],b[3]-b[1]);
      if(preferences.labels){const text=String(detection.class||'Object')+' · 2D',width=c.measureText(text).width+10,y=Math.max(0,b[1]-20);c.fillStyle='#111827';c.fillRect(b[0],y,width,20);c.fillStyle='#FFFFFF';c.fillText(text,b[0]+5,y+14);}
    }
  }

  return {update(vehicle,displayed){
    const m=cockpitMeasurements(p,vehicle),fresh=p.fresh&&!p.isReplay;
    set('cockpitSpeed',metricText(m.speed));set('cockpitBrake',metricText(m.brake));set('cockpitGap',metricText(m.gap,1));set('cockpitTtc',metricText(m.ttc,1));
    set('cockpitTarget',p.isReplay?'Recorded replay':p.controlMode==='MANUAL'?'Manual control':'Target '+metricText(m.target)+(Number.isFinite(m.target)?' km/h':''));
    $('cockpitSpeedArc').style.strokeDasharray=`${Number.isFinite(m.speed)?Math.min(100,Math.max(0,m.speed/120*100)):0} 100`;
    $('cockpitBrakeBar').style.width=(Number.isFinite(m.brake)?m.brake:0)+'%';
    document.querySelector('.cockpit-brake>div>span:last-child').textContent=Number.isFinite(m.brake)?m.brake>0?'Applied':'Released':'Unavailable';
    const sensorFailure=p.controlMode==='PAUSED'&&p.stopDiagnostics?.runtime_fault?.exception_type==='ControlSceneTimeout';
    set('cockpitBrakeReason',fresh ? sensorFailure?'CONTROL SENSORS · Synchronized data fell behind. Vehicle held; use Restart.':
      (p.stopDiagnostics?.decision_source||'Driver')+' · '+controlReasonText(p.stopDiagnostics?.reason||'No braking requested') : 'Waiting for live command');
    set('cockpitGapStatus',Number.isFinite(m.gap)?'Measured forward distance':fresh?'Unavailable or stale':'Waiting for live sensors');
    set('cockpitTtcStatus',Number.isFinite(m.ttc)?'Measured closing time':fresh?'No valid closing measurement':'Waiting for live sensors');
    set('cockpitConnectionText',p.isReplay?'Recorded replay':fresh?'CARLA Connected':p.simulationStarting?'CARLA Starting':p.restarting?'CARLA Restarting':p.phase==='ERROR'?'CARLA Error':'CARLA Disconnected');
    $('cockpitConnection').dataset.tone=fresh?'connected':'neutral';
    const protection=safetyChip(p);set('cockpitProtectionText',protection.label);$('cockpitProtection').dataset.tone=protection.tone;
    set('cockpitDriverText',driverCaption(p));
    $('cockpitDriver').title=!fresh?'No live control session':p.controller?'This page owns vehicle control':'Observer · another page owns vehicle control';
    const cameraChange=tools.cameraChange,confirmed=cameraChange?.status==='applied'?cameraChange.requested:tools.catalog?.settings?.camera_view;
    if(confirmed&&select.value!==confirmed)select.value=confirmed;select.disabled=$('cameraView').disabled||cameraChange?.status==='pending';
    selector.title=cameraChange?.status==='failed'?cameraChange.error:cameraChange?.status==='pending'?'Changing camera…':'Select a camera view';
    set('cockpitCameraState',$('authoritativeCamera').hidden?fresh?'Waiting for live camera':'Camera offline':p.isReplay?'RECORDED · RGB':'LIVE · CARLA RGB');
    if($('authoritativeCamera').hidden){
      const starting=p.simulationStarting,restarting=p.restarting,failed=p.simulatorStart?.status==='FAILED'||p.phase==='ERROR',stopped=p.simulatorStop?.status==='STOPPED';
      set('cameraEmptyTitle',starting?'Starting CARLA':restarting?'Restarting CARLA':failed?'Simulator connection failed':stopped?'CARLA is stopped':fresh?'Waiting for camera frames':'Simulator disconnected');
      set('cameraEmptyDescription',failed?p.simulatorStart?.error||p.operationError||p.status:starting||restarting?'Connecting the simulator, vehicle and sensors. Driving remains stopped.':fresh?'The connection is live. Camera frames are not available; inspect Diagnostics.':'Use Restart above to start the simulator and run the presentation.');
      $('connectionSetupBtn').hidden=fresh||p.isReplay;set('connectionSetupBtn',starting||restarting?'View startup progress':'Run presentation');
    }
    set('cockpitCameraRate',!$('authoritativeCamera').hidden&&Number.isFinite(p.performance?.sensorWallRatesHz?.[displayed?.sensorId])?p.performance.sensorWallRatesHz[displayed.sensorId].toFixed(1)+' Hz':'');
    const counts=perceptionCounts(perception.result,p);set('cockpitVehicles',metricText(counts.vehicles));set('cockpitPeople',metricText(counts.people));set('cockpitObjectsStatus',counts.label);
    const prediction=predictionView.currentPrediction;
    set('cockpitTracks',fresh&&measuredPredictionFresh(prediction,p.sessionId,p.telemetry?.timestamp)?(prediction.tracks||[]).filter(t=>t.confirmed).length:'—');
    const notice=safetyNotice(p),noticeKey=JSON.stringify(notice);safety.hidden=!notice;
    if(noticeKey!==lastNotice){lastNotice=noticeKey;if(notice){safety.dataset.tone=notice.tone;safety.querySelector('.notice-copy strong').textContent=notice.title;safety.querySelector('.notice-copy p').textContent=notice.detail;}}
    resume.hidden=!(notice&&p.controlMode==='PAUSED'&&p.route&&!p.route.arrived&&!p.journey?.presentation_id&&['PAUSED','ERROR'].includes(p.journey?.status));
    resume.disabled=!fresh||!p.controller||p.recording||p.recordingStatus?.finalized===false||p.restarting||!onResume||
      (p.journey?.driving_mode==='HYBRID'&&p.hybridDriving?.available!==true);
    for(const btn of document.querySelectorAll('.cockpit-dialog-emergency'))btn.disabled=$('emergencyStopBtn').disabled;
    set('cockpitDetailsStatus',p.isReplay?'Recorded replay · live inference is stopped.':fresh?'Live measurements · '+(p.world?.map?.split('/').pop()||'CARLA'):'Simulator disconnected · live measurements unavailable.');
    if(setup.open&&p.controlMode!==previousMode&&['MANUAL','AUTOMATIC'].includes(p.controlMode))document.body.classList.remove('studio-setup-open');
    previousMode=p.controlMode;
    document.querySelector('.studio-fullscreen-controls strong').textContent=protection.label+' · '+$('cockpitDriverText').textContent;
    drawDetections(displayed);
  }};
}
