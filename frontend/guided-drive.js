import {trafficPreparationReason,trafficPrepared,routeDestinationKey,TRAFFIC_COUNT,PEDESTRIAN_COUNT} from './traffic-preparation.js';
import {showWorkspace} from './presentation-ui.js';

export function guidedStep(p, vehicle, configured=false, choosing=false) {
  if (p.simulationStarting || p.restarting) return 'starting';
  if (!p.connected || !p.fresh || p.isReplay) return 'connect';
  if (!p.controller) return 'ownership';
  if (p.controlMode === 'EMERGENCY_STOP') return 'acknowledge';
  if (p.journey?.status === 'STARTING') return 'journey-starting';
  if (p.controlMode === 'AUTOMATIC' || p.controlMode === 'MANUAL' || Math.abs(vehicle.speedMps) > .15) return 'stop';
  if (['REQUESTED','APPLYING'].includes(p.trafficPreparation?.status) || p.dashboardResult?.status === 'PENDING') return 'pending';
  if (!p.route?.destination || p.route.arrived || p.dashboardResult?.action==='destination'&&p.dashboardResult.status==='REJECTED') return 'destination';
  if (choosing) return 'behaviour';
  if (!configured || p.trafficPreparation?.status === 'FAILED') return 'traffic';
  return 'drive';
}

export function modeBlockedReason(p,vehicle,prepared) {
  if(!p.connected||!p.fresh||p.isReplay)return 'Connect to live CARLA first.';
  if(!p.controller)return 'Take vehicle control first.';
  if(p.restarting||p.simulationStarting)return 'Wait for the simulator to reconnect.';
  if(p.controlMode==='EMERGENCY_STOP')return 'Acknowledge the emergency stop first.';
  if(p.controlMode!=='PAUSED'||!Number.isFinite(vehicle.speedMps)||Math.abs(vehicle.speedMps)>.15)return 'Stop driving and wait for the vehicle to stop.';
  if(!p.route?.destination||p.route.arrived)return 'Choose a destination first.';
  if(!prepared)return 'Apply road traffic and wait for confirmation.';
  if(p.dashboardResult?.status==='PENDING')return 'Wait for the current operation to finish.';
  if(p.recording)return 'Finish the current recording first.';
  if(['RESETTING','RUNNING','STOPPING'].includes(p.comparisonDemo?.phase)||['QUEUED','RESETTING','RUNNING','STOPPING'].includes(p.comparisonV2?.phase))return 'Stop the research run before starting a journey.';
  if(p.environment?.mode==='TRAINING')return 'Return to Living city in Tools.';
  if(!p.navigationAvailable)return 'Destination driving is unavailable. Inspect Diagnostics.';
  if(p.safetySystem?.status?.includes('FAULT')||p.safetySystem?.status==='UNAVAILABLE')return 'Sensors are unavailable. Inspect Diagnostics before driving.';
  return '';
}

export function simulatorNeedsStart(p) {
  return p.simulatorStop?.status==='STOPPED'||p.simulatorStart?.status==='FAILED'||!p.simulatorStop&&p.simulatorStart?.available===true&&!p.connected;
}

// Presentation follows backend receipts. No native operation runs on page load.
export function installGuidedDrive(p, preparation, tools, startJourney, stop, predictionView) {
  const $=id=>document.getElementById(id),body=document.body;
  body.dataset.ui='guided';
  let choosing=false,review=false,submitting=false,session=null,destination=null,action='connect';
  let modeChoice=false,selectedMode=null,preparedKey=null,startPending=false,setupOpen=false,placeKey='',recoveryPending=false;
  const toggle=document.createElement('button');toggle.id='interfaceMode';toggle.textContent='Tools';toggle.title='Manual controls, city configuration and research';
  toggle.onclick=()=>{tools.close(false);showWorkspace('setup');};
  document.querySelector('.app-header').insertBefore(toggle,$('emergencyStopBtn'));
  const panel=document.createElement('section');panel.id='guidedDrive';panel.setAttribute('aria-label','Guided simulation setup');
  panel.innerHTML=`<div class="guided-heading"><span class="eyebrow">YOUR NEXT JOURNEY</span><h2>Prepare your drive</h2><p id="guidedHeadingDetail">Choose a road. Then compare both modes.</p></div>
    <div id="guidedActiveSummary" hidden><span id="guidedActiveMode"></span><strong id="guidedActiveDestination"></strong><span id="guidedActiveTraffic"></span><button id="guidedInspectSetup">Inspect setup</button></div>
    <ol class="drive-steps"><li data-step="destination"><b>01</b><span>Choose destination</span></li><li data-step="behaviour"><b>02</b><span>Configure traffic</span></li><li data-step="traffic"><b>03</b><span>Prepare the road</span></li><li data-step="drive"><b>04</b><span>Start driving</span></li></ol>
    <div id="guidedDestination" hidden><label for="guidedDestinationSearch">Find a destination</label><input id="guidedDestinationSearch" type="search" placeholder="Search places or favorites" autocomplete="off"><div id="guidedPlaceResults" aria-label="Available destinations"></div><p class="muted">Current vehicle position is your starting point.</p></div>
    <div id="guidedBehaviour" hidden><label for="guidedChaos">Traffic randomness <output id="guidedChaosValue">0%</output></label><div class="behaviour-presets"><button data-chaos="0">Calm</button><button data-chaos="45">Mixed</button><button data-chaos="85">Chaotic</button></div><input id="guidedChaos" type="range" min="0" max="100" step="5" value="0"><details><summary>Advanced traffic settings</summary><label for="guidedSeed">Random seed</label><div class="guided-seed"><input id="guidedSeed" type="number" min="0" max="2147483647"><button id="guidedShuffle" aria-label="Choose another random seed">Shuffle</button></div><p class="muted">Road density follows native route capacity. Population and driver behavior are available in Settings.</p></details></div>
    <div id="guidedPreparation" hidden><strong id="guidedPreparationTitle">Ready to prepare</strong><p id="guidedPreparationDetail"></p></div>
    <button id="guidedPrimary" class="primary">Start Simulation</button><p id="guidedStatus" role="status" aria-live="polite"></p>
    <div id="guidedModeChoices" hidden aria-label="Choose your driving experience"><button id="robosphereModeBtn" data-mode="ROBOSPHERE"><span class="mode-symbol" aria-hidden="true">◎</span><strong>Ya Rab Ostorha Mode</strong><span>Drive with Robosphere protection</span><em>Drive with Ya Rab Ostorha ↗</em></button><button id="normalModeBtn" data-mode="NORMAL"><span class="mode-symbol" aria-hidden="true">◇</span><strong>Normal Mode</strong><span>Self-driving route, no Robosphere overlay</span><em>Drive in Normal Mode ↗</em></button></div>
    <div id="guidedJourneyOptions" hidden><label for="guidedSpeed">Target speed</label><input id="guidedSpeed" type="number" min="5" max="30" step="1" value="30"><span>km/h</span></div>
    <button id="guidedViewResults" class="primary" hidden>View Results ↗</button><button id="guidedOtherMode" hidden>Run the other mode ↗</button>
    <button id="guidedRoute" hidden>Edit destination</button><button id="guidedEditTraffic" hidden>Edit traffic</button><p id="guidedLiveCounts" class="muted"></p>`;
  document.querySelector('.drive-inspector').prepend(panel);
  // Keep the real auxiliary analysis below the main camera, in one disclosure.
  const vision=document.createElement('details');vision.id='modelVision';vision.setAttribute('aria-label','Camera analysis');
  vision.innerHTML='<summary>Camera analysis <span id="guidedPredictionStatus">Waiting for measured tracks</span></summary>';
  vision.append($('perceptionPanel'));document.querySelector('.camera-stage').append(vision);
  const set=(id,value)=>{if($(id).textContent!==String(value))$(id).textContent=String(value);};
  const route=()=>tools.open('routePanel','guidedPrimary');
  const choose=()=>{choosing=true;review=false;submitting=false;p.operationError=null;$('guidedChaos').value=p.population?.requested?.chaos_percent??0;$('guidedChaos').oninput();$('guidedSeed').value=p.population?.requested?.seed??2589;};
  const validate=()=>{const seed=Number($('guidedSeed').value);if(!Number.isInteger(seed)||seed<0||seed>2147483647){p.operationError='Choose a seed between 0 and 2147483647.';$('guidedSeed').closest('details').open=true;$('guidedSeed').focus();return false;}return true;};
  $('guidedChaos').oninput=()=>{set('guidedChaosValue',$('guidedChaos').value+'%');panel.querySelectorAll('[data-chaos]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.chaos===$('guidedChaos').value)));};
  panel.querySelectorAll('[data-chaos]').forEach(b=>b.onclick=()=>{$('guidedChaos').value=b.dataset.chaos;$('guidedChaos').oninput();});
  $('guidedShuffle').onclick=()=>{$('guidedSeed').value=crypto.getRandomValues(new Uint32Array(1))[0]%2147483648;};
  $('guidedSpeed').onchange=()=>{$('journeySpeed').value=$('guidedSpeed').value;$('journeySpeed').dispatchEvent(new Event('change'));};
  $('guidedRoute').onclick=route;$('guidedEditTraffic').onclick=choose;
  $('guidedViewResults').onclick=()=>showWorkspace('results',{focus:true});
  $('guidedOtherMode').onclick=()=>{showWorkspace('results');document.querySelector(`#ordinaryComparisonPanels [data-mode="${p.journey?.driving_mode==='NORMAL'?'ROBOSPHERE':'NORMAL'}"] .run-mode-cta`)?.click();};
  $('guidedInspectSetup').onclick=()=>{setupOpen=!setupOpen;panel.classList.toggle('inspect-running-setup',setupOpen);$('guidedInspectSetup').setAttribute('aria-expanded',String(setupOpen));};
  panel.querySelectorAll('[data-step]').forEach(li=>{const b=document.createElement('button');b.type='button';b.textContent='Edit';b.className='step-edit';b.setAttribute('aria-label','Edit '+li.querySelector('span').textContent);b.onclick=()=>li.dataset.step==='destination'?route():choose();li.append(b);});
  const renderPlaces=()=>{
    const query=$('guidedDestinationSearch').value.toLocaleLowerCase(),places=(tools.catalog?.places||[]).filter(v=>v.name.toLocaleLowerCase().includes(query)).sort((a,b)=>Number(!!b.favorite)-Number(!!a.favorite)).slice(0,4);
    const key=JSON.stringify([p.sessionId,query,places]);if(key===placeKey)return;placeKey=key;
    $('guidedPlaceResults').replaceChildren(...places.map(place=>{const b=document.createElement('button');b.type='button';b.textContent=(place.favorite?'★ ':'')+place.name;b.onclick=()=>tools.choose(place.id);return b;}));
    if(!places.length)$('guidedPlaceResults').textContent=tools.catalog?'No matching places. Choose on the map.':'Waiting for native destinations.';
  };
  $('guidedDestinationSearch').oninput=renderPlaces;
  $('guidedPrimary').onclick=()=>{
    if(action==='connect'){if(simulatorNeedsStart(p))p.startSimulation();else {p.reconnectNative();p.connect();}return;}
    if(action==='ownership'){p.takeControl();return;}
    if(action==='acknowledge'){p.acknowledgeStop();return;}
    if(action==='stop'){stop('operator_stop');return;}
    if(action==='destination'){route();return;}
    if(action==='drive'){modeChoice=true;return;}
    if(action==='traffic'){choose();return;}
    if(action==='behaviour'){if(validate()){choosing=false;review=true;}return;}
    if(action!=='prepare'||!validate())return;
    if(preparation.request({...p.population.requested,vehicle_count:TRAFFIC_COUNT,pedestrian_count:PEDESTRIAN_COUNT,
      seed:Number($('guidedSeed').value),chaos_percent:Number($('guidedChaos').value),placement:'EGO_SURROUNDING',vehicle_mix:'MIXED'})){submitting=true;review=true;$('guidedPrimary').disabled=true;}
  };
  panel.querySelectorAll('[data-mode]').forEach(button=>button.onclick=()=>{
    if(action!=='drive'||button.disabled)return;
    const blocked=modeBlockedReason(p,p.getVehicleState(),trafficPrepared(p,preparation));
    if(blocked){p.operationError=blocked;return;}
    selectedMode=button.dataset.mode;
    if(startJourney(selectedMode,p.journey?.prepared_pair_id)!==false){startPending=true;panel.querySelectorAll('[data-mode]').forEach(b=>b.disabled=true);}
  });
  return {chooseMode(value,{restoring=false}={}){modeChoice=true;selectedMode=value;recoveryPending=restoring;},update(vehicle){
    const routeKey=routeDestinationKey(p.route);
    if(session!==p.sessionId||destination!==routeKey){session=p.sessionId;destination=routeKey;choosing=review=submitting=false;startPending=false;}
    const key=p.sessionId+':'+p.journey?.prepared_pair_id+':'+p.journey?.prepared_mode;
    if(p.journey?.prepared_pair_id&&key!==preparedKey){preparedKey=key;modeChoice=true;selectedMode=p.journey.prepared_mode;$('guidedSpeed').value=$('journeySpeed').value=String(p.journey.speed_kmh);}
    const configured=trafficPrepared(p,preparation),failed=preparation.state?.status==='FAILED';
    if(submitting&&configured){choosing=review=submitting=false;}
    else if(submitting&&failed){submitting=false;review=true;}
    action=guidedStep(p,vehicle,configured,choosing);
    if(action==='traffic'&&(review||failed))action='prepare';
    if(p.journey?.status==='STARTING'||p.journey?.status==='RUNNING'||p.operationError)startPending=false;
    const running=['RUNNING','STARTING'].includes(p.journey?.status),ended=!!p.journey?.pair_id&&!running&&p.journey.status!=='READY'&&p.journeyComparison?.pair_id===p.journey.pair_id;
    body.classList.toggle('journey-active',running);panel.classList.toggle('journey-running',running);
    $('guidedDestination').hidden=action!=='destination';if(action==='destination')renderPlaces();
    $('guidedBehaviour').hidden=action!=='behaviour';$('guidedPreparation').hidden=!['prepare','pending'].includes(action);
    set('guidedPreparationTitle',failed?'Road preparation failed':action==='pending'?'Preparing the road…':'Verify your road traffic');
    set('guidedPreparationDetail',failed?preparation.state.reason:action==='pending'?'Waiting for native placement confirmation. Vehicle held.':$('guidedChaos').value+'% randomness · seed '+$('guidedSeed').value);
    const names={connect:simulatorNeedsStart(p)?'Start Simulation':'Connect to Simulator',starting:'Starting simulation…','journey-starting':'Starting your drive…',ownership:'Take Vehicle Control',acknowledge:'Release emergency stop',stop:'Stop vehicle',pending:'Preparing road traffic…',traffic:'Configure Traffic',behaviour:'Continue to preparation',prepare:failed?'Retry preparation':'Apply Road Traffic',destination:'Choose on Map',drive:'Start Driving'};
    set('guidedPrimary',p.isReplay?'Recorded replay':names[action]);
    const blocked=action==='drive'?(recoveryPending?'Restore the saved comparison setup before driving.':modeBlockedReason(p,vehicle,configured)):['behaviour','prepare'].includes(action)?trafficPreparationReason(p,vehicle):'';
    $('guidedPrimary').disabled=['pending','starting','journey-starting'].includes(action)||p.isReplay||!!blocked||startPending;
    $('guidedPrimary').hidden=action==='drive'&&modeChoice;
    $('guidedModeChoices').hidden=action!=='drive'||!modeChoice;
    panel.querySelectorAll('[data-mode]').forEach(b=>{b.disabled=action!=='drive'||!!blocked||startPending;b.title=blocked||'';b.setAttribute('aria-pressed',String(selectedMode===b.dataset.mode));});
    const hints={connect:simulatorNeedsStart(p)?'Launch CARLA with the vehicle held.':'Reconnect this dashboard. Movement requires an explicit start.',starting:'CARLA and its sensors are starting. Vehicle held.',ownership:'This dashboard is observing. Taking control leaves the vehicle held.',acknowledge:'Acknowledgement releases the latch and keeps the vehicle stopped.',stop:p.safetySystem?.active?p.safetySystem.reason||'Safety intervention active':'Stop finalizes this run and keeps its recording.',pending:'Driving stays blocked until preparation is confirmed.',traffic:'Choose how traffic should behave.',behaviour:'These settings have not been applied yet.',prepare:'Apply the selected settings to this route.',destination:'Select a destination without moving the vehicle.',drive:modeChoice?'Select a mode to begin driving and recording.':'Road traffic confirmed. Choose your driving mode.'};
    set('guidedStatus',p.isReplay?'Recorded data · vehicle controls are unavailable. Use Pause replay below the camera.':p.operationError||blocked||(startPending?'Start requested. Waiting for backend acceptance.':hints[action]));
    panel.dataset.error=String(!!p.operationError||failed);
    const crowd=p.population?.route_crowding,live=p.fresh&&!p.isReplay;
    set('guidedLiveCounts',!live?'Live measurements unavailable':configured?`Surrounding traffic · ${p.population.actual.vehicles}/${p.population.requested.vehicle_count} vehicles · ${p.population.actual.pedestrians}/${p.population.requested.pedestrian_count} pedestrians`:`Live city · ${p.population?.actual?.vehicles??'—'} vehicles · ${p.population?.actual?.pedestrians??'—'} pedestrians`);
    $('guidedJourneyOptions').hidden=action!=='drive';$('guidedRoute').hidden=!['traffic','behaviour','prepare','drive'].includes(action);$('guidedEditTraffic').hidden=action!=='drive';
    $('guidedViewResults').hidden=!ended;$('guidedOtherMode').hidden=!ended;
    set('guidedActiveMode',p.journey?.driving_mode==='NORMAL'?'Normal Mode':'Ya Rab Ostorha Mode');set('guidedActiveDestination',p.route?.destination?.name||'Destination journey');set('guidedActiveTraffic',`${p.population?.requested?.chaos_percent??'—'}% randomness · ${p.journeyComparison?.runs?.[p.journey?.driving_mode]?.duration_s?.toFixed(1)??'—'} s`);
    $('guidedActiveSummary').hidden=!running;
    set('guidedHeadingDetail',ended?({ARRIVED:'Destination reached and stopped',COLLISION:'Run ended with a collision',ERROR:'Run failed',PAUSED:'Run interrupted'})[p.journey.status]||'Review the saved run.':'Choose a road. Then compare both modes.');
    panel.querySelector('.guided-heading h2').textContent=running?'Simulation active':ended?'Run recorded':'Prepare your drive';
    const order=['destination','behaviour','traffic','drive'],step=action==='traffic'?'behaviour':['prepare','pending'].includes(action)?'traffic':action==='stop'||action==='journey-starting'?'drive':action,current=order.indexOf(step);
    panel.querySelectorAll('[data-step]').forEach(el=>{const index=order.indexOf(el.dataset.step),complete=running||current>index;el.setAttribute('aria-current',el.dataset.step===step?'step':'false');el.dataset.complete=String(complete);el.querySelector('b').textContent=complete?'✓':String(index+1).padStart(2,'0');el.querySelector('.step-edit').hidden=!complete||running||el.dataset.step==='drive';if(el.dataset.step==='destination')el.querySelector('span').textContent=complete?p.route?.destination?.name||'Destination selected':'Choose destination';if(el.dataset.step==='traffic')el.querySelector('span').textContent=complete?'Road ready':'Prepare the road';});
    set('guidedPredictionStatus',predictionView.message||'Waiting for measured tracks');
  }};
}
