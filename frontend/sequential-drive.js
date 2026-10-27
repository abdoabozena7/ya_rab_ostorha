import {installGuidedDetails} from './guided-details.js';
import {missionState,modeLabel,stressSummary,missionFailure,preloadWasObserved} from './mission-state.js';
import {controlReasonText} from './cockpit-state.js';
import {PROJECT_NAME} from './project-name.js';
import {showWorkspace} from './presentation-ui.js';
import {presentationOutcome} from './presentation-run.js';
import {installPreviewPlayer} from './preview-player.js';
import {recordedDriverDescription} from './driver-profile.js';
import {EGYPT_SCENARIO,LEGACY_SCENARIO,scenarioOptions,scenarioDriverText,urbanAvailability,scenarioStartState,validationSummary,validationDetails,validationOwnsSimulator as reservedElsewhere} from './scenario-profile.js';
import {installGPUStatus} from './gpu-status.js';

export function installSequentialDrive(p,tools) {
  const $=id=>document.getElementById(id);
  document.body.classList.add('sequential-drive','mission-experience');p.guidedExperience=true;
  document.querySelector('#brand h1').textContent=PROJECT_NAME;
  document.querySelector('#brand .eyebrow').textContent='A guided driving experience';
  const atmosphere=document.createElement('div');atmosphere.id='missionAtmosphere';atmosphere.setAttribute('aria-hidden','true');
  atmosphere.innerHTML='<i></i><i></i>';document.body.prepend(atmosphere);
  const actions=document.querySelector('.cockpit-header-actions');
  const details=document.createElement('button');details.id='driveDetailsAction';details.textContent='Menu';
  details.setAttribute('aria-controls','cockpitDetails');details.setAttribute('aria-expanded','false');actions.prepend(details);
  const returnToMission=document.createElement('button');returnToMission.textContent='Back to drive';returnToMission.hidden=true;actions.prepend(returnToMission);
  returnToMission.onclick=()=>{p.reviewedComparison=null;p.presentationPlayback=false;for(const video of document.querySelectorAll('#presentationResults video'))video.pause();showWorkspace('drive');update();};
  const navigator=installGuidedDetails(p,tools,details);details.onclick=()=>navigator.open();
  const experience=document.createElement('main');experience.id='missionExperience';
  experience.innerHTML='<section id="missionPreview" aria-label="Illustrated driving preview"></section><section id="missionScene" hidden></section><section class="mission-copy"><div class="mission-location"><span id="missionStep"></span><span id="missionTraffic"></span></div><h2 id="missionTitle" tabindex="-1"></h2><p id="missionDetail" role="status"></p><fieldset id="missionChoices" hidden><legend>Choose your first drive</legend><label><input type="radio" name="firstDrive" value="NORMAL"><span><strong>Normal</strong>Mercedes · reactive sensor braking</span></label><label><input type="radio" name="firstDrive" value="ROBOSPHERE"><span><strong lang="en" dir="ltr">Ya Rab Ostorha</strong>Same Mercedes · sensor braking + prediction</span></label></fieldset><div id="missionOutcomes" hidden></div><p id="missionError" role="alert" hidden></p><div class="mission-actions"><button id="drivePrimaryAction" class="primary" hidden></button><button id="missionFreeGPU" hidden>Free GPU</button><span id="missionWorking" hidden><i></i> In progress</span></div><p id="missionNextHint"></p></section>';
  const preview=installPreviewPlayer(experience.querySelector('#missionPreview'));
  const scenarioField=document.createElement('fieldset');scenarioField.id='missionScenarioChoices';
  scenarioField.innerHTML='<legend>Road scenario</legend><p class="mission-scenario-intro">Choose the route for both drivers.</p><div id="missionScenario"><label class="mission-scenario-option"><input type="radio" name="roadScenario" value="SUDDEN_PEDESTRIAN_COMPARISON_V1"><span class="mission-scenario-copy"><span class="mission-scenario-heading"><strong>Historical crossing comparison</strong><span class="mission-scenario-status">Ready</span></span><span class="mission-scenario-description">Crossing experiment · up to 120 km/h</span></span></label><label class="mission-scenario-option"><input type="radio" name="roadScenario" value="EGYPT_URBAN_CHAOS_V1" aria-describedby="missionScenarioNotice"><span class="mission-scenario-copy"><span class="mission-scenario-heading"><strong>Egypt mixed urban journey</strong><span id="missionUrbanStatus" class="mission-scenario-status">Checking access</span></span><span class="mission-scenario-description">600–800 m · mixed traffic · up to 60 km/h</span></span></label></div><div id="missionScenarioAccess"><strong id="missionScenarioAccessTitle"></strong><p id="missionScenarioNotice" role="status"></p><details id="missionScenarioTechnical"><summary>Validation details</summary><p id="missionScenarioBackendReason"></p></details></div><div class="mission-scenario-footer"><span id="missionScenarioSelectionHint"></span><button id="missionRefreshScenarios" type="button">Refresh availability</button></div>';
  experience.querySelector('#missionChoices').before(scenarioField);
  const actionArea=document.createElement('div');actionArea.id='missionActionArea';
  const gpuPanel=document.createElement('section');gpuPanel.id='missionGPU';
  actionArea.append(experience.querySelector('.mission-actions'),gpuPanel,experience.querySelector('#missionNextHint'));
  experience.querySelector('#missionError').after(actionArea);
  const updateGPU=installGPUStatus(gpuPanel);
  const validationNotice=document.createElement('p');validationNotice.id='missionValidationStatus';validationNotice.setAttribute('role','status');validationNotice.hidden=true;
  actionArea.prepend(validationNotice);
  const scenarios=()=>tools.scenarioError?null:tools.scenarios||tools.catalog?.presentation_scenarios;
  for(const label of experience.querySelectorAll('#missionChoices label span')){
    const description=document.createElement('span');description.className='mission-driver-description';
    for(const node of [...label.childNodes])if(node.nodeType===Node.TEXT_NODE)node.remove();
    label.append(description);
  }
  const telemetry=document.createElement('p');telemetry.id='missionTelemetry';telemetry.setAttribute('role','status');
  experience.querySelector('#missionDetail').after(telemetry);
  const guide=document.createElement('section');guide.id='missionGuide';guide.setAttribute('aria-labelledby','missionGuideTitle');
  guide.innerHTML='<h2 id="missionGuideTitle">Before you drive</h2>';
  for(const [index,[question,answer]] of [
    ['What will I see?','Choose a road scenario independently of your first driver. The historical crossing remains available. Egypt urban chaos adds mixed traffic and verified maneuvers, capped at 60 km/h, inside an authorized validation window until native acceptance. Both use the same Mercedes and sensors.'],
    ['Does protection prevent every contact?','No. RULE protection may slow or stop the car, but contacts are still possible. The comparison shows what actually happened, including attempts ended early.'],
    ['What does Free GPU do?','It saves the recorded portion, closes CARLA and checks that its processes have exited. Your next start begins a new comparison. Previous recordings stay in Menu.'],
  ].entries()){
    const item=document.createElement('div');item.className='mission-faq';
    const heading=document.createElement('h3'),button=document.createElement('button'),answerBox=document.createElement('div'),content=document.createElement('p'),inner=document.createElement('div');
    button.type='button';button.textContent=question;button.setAttribute('aria-expanded','false');button.setAttribute('aria-controls',`missionAnswer${index}`);
    const plus=document.createElement('span');plus.textContent='+';plus.setAttribute('aria-hidden','true');button.append(plus);
    answerBox.id=`missionAnswer${index}`;answerBox.className='mission-faq-answer';answerBox.inert=true;content.textContent=answer;inner.append(content);answerBox.append(inner);
    button.onclick=()=>{const open=button.getAttribute('aria-expanded')!=='true';button.setAttribute('aria-expanded',String(open));answerBox.inert=!open;};
    heading.append(button);item.append(heading,answerBox);guide.append(item);
  }
  experience.append(guide);
  if(globalThis.IntersectionObserver){
    const reveals=new IntersectionObserver(entries=>{for(const entry of entries)if(entry.isIntersecting){entry.target.classList.add('is-revealed');reveals.unobserve(entry.target);}},{threshold:.08});
    for(const element of [experience.querySelector('#missionPreview'),guide]){element.classList.add('mission-reveal');reveals.observe(element);}
  }
  document.querySelector('.app-header').after(experience);$('missionScene').append($('cameraCard'));
  const header=document.querySelector('.app-header');
  if(globalThis.ResizeObserver)new ResizeObserver(()=>document.body.style.setProperty('--mission-header-height',header.offsetHeight+'px')).observe(header);
  const skip=document.querySelector('.skip-link');if(skip)skip.href='#missionTitle';
  let pageId;
  try{pageId=sessionStorage.getItem('ostorha.guidedPage')||crypto.randomUUID();sessionStorage.setItem('ostorha.guidedPage',pageId);}catch{pageId=crypto.randomUUID();}
  const local={pageId,pageAdmitted:false,firstMode:'NORMAL',launchPending:false,shutdownPending:false,commandPending:false,autoRequested:false,preloadRequested:false,
    scenarioId:LEGACY_SCENARIO,scenarioChosen:false,scenarioSelectionPending:false,scenarioDraft:false};
  experience.querySelector('[name=firstDrive][value=NORMAL]').checked=true;
  let previousScreen='',outcomeKey='',pending=null;
  const results=$('presentationResults'),resultsAnchor=document.createComment('saved comparison');results.before(resultsAnchor);
  results.querySelector('.presentation-results-heading').append($('presentationReplay'));
  const clearMedia=()=>{p.reviewedComparison=null;p.presentationPlayback=false;document.body.classList.remove('archive-review');
    for(const video of document.querySelectorAll('#presentationResults video'))video.pause();showWorkspace('drive');};
  experience.querySelectorAll('[name=firstDrive]').forEach(input=>{
    input.onchange=()=>{local.firstMode=input.value;preview.select(input.value);update();};
    input.onclick=()=>{if(local.firstMode===input.value)preview.select(input.value);};
  });
  const command=operation=>{
    const d=p.presentation||{},value={operation,id:d.id,expected_arm:d.arm,expected_phase:d.status};
    if(operation==='START_GUIDED')Object.assign(value,{first_mode:local.firstMode,page_id:local.pageId,
      ...scenarioOptions(d.status==='CHOOSING'?(d.scenario_id||LEGACY_SCENARIO):local.scenarioId),
      ...(d.status==='CHOOSING'?{prepared_id:d.id}:{})});
    if(!p.dashboardAction('presentation',value))return;
    pending={id:d.id,phase:d.status,arm:d.arm,sequence:p.sequence,at:performance.now()};local.commandPending=true;
  };
  const prepareHere=(replace=false)=>{
    if(local.scenarioDraft){
      if(!replace)return false;
      local.scenarioId=p.presentation?.scenario_id||LEGACY_SCENARIO;
      if(local.scenarioId===EGYPT_SCENARIO&&!urbanAvailability(scenarios()).available)local.scenarioId=LEGACY_SCENARIO;
      local.scenarioDraft=false;
    }
    p.operationError=null;local.preloadError=null;local.pageAdmitted=false;local.observing=false;
    if(!p.dashboardAction('presentation',{operation:'PRELOAD',page_id:local.pageId,replace,
      ...(local.scenarioChosen||scenarios()?{scenario_id:local.scenarioId}:{})})){
      local.preloadError=p.operationError;return false;
    }
    local.preloadRequested=true;local.preloadSequence=p.sequence;local.preloadAt=performance.now();
    return true;
  };
  const prepareSelectedScenario=()=>{
    local.scenarioDraft=false;local.scenarioSelectionPending=true;
    if(!prepareHere(true)){local.scenarioDraft=true;local.scenarioSelectionPending=false;}
  };
  for(const input of scenarioField.querySelectorAll('[name=roadScenario]'))input.onchange=()=>{
    local.scenarioId=input.value;local.scenarioChosen=true;local.scenarioDraft=true;
    const d=p.presentation||{},available=!scenarios()?.simulator_reserved&&(input.value!==EGYPT_SCENARIO||urbanAvailability(scenarios()).available);
    if(available&&d.preloaded&&d.awaiting_choice&&(d.scenario_id||LEGACY_SCENARIO)===input.value)local.scenarioDraft=false;
    else if(available&&p.connected&&p.fresh)prepareSelectedScenario();
    update();
  };
  $('missionRefreshScenarios').onclick=async()=>{
    local.scenarioRefreshing=true;update();
    try{await tools.loadScenarios();}
    finally{local.scenarioRefreshing=false;update();}
  };
  $('drivePrimaryAction').onclick=()=>{
    const state=missionState(p,local);if(!state.action)return;p.operationError=null;
    if(['NEW_DRIVE','START_SIMULATION','START_GUIDED','PREPARE_HERE'].includes(state.action)&&(!scenarios()||scenarios().simulator_reserved)){
      p.operationError=tools.scenarioError||'Wait for current validation status before preparing a new drive.';update();return;
    }
    if(state.action==='START_GUIDED'){
      const scenario=scenarioStartState(local,scenarios());
      if(scenario.blocked)return;
      if(scenario.needsPreparation){prepareSelectedScenario();update();return;}
    }
    if(state.action==='NEW_DRIVE'){
      local.newDrive=true;local.newDriveFrom=p.presentation?.id;local.autoRequested=true;local.preloadRequested=false;local.pageAdmitted=false;clearMedia();
      local.scenarioChosen=false;local.scenarioDraft=false;local.scenarioId=scenarios()?.default_id||LEGACY_SCENARIO;
      if(p.connected&&p.fresh)prepareHere(true);
      else {local.launchPending=true;p.startSimulation().finally(()=>{local.launchPending=false;update();});}
    } else if(state.action==='START_SIMULATION'){
      clearMedia();local.launchPending=true;local.preloadRequested=false;local.firstMode='NORMAL';experience.querySelectorAll('[name=firstDrive]').forEach(i=>i.checked=i.value==='NORMAL');
      p.startSimulation().finally(()=>{if(!p.simulationStarting)local.launchPending=false;update();});
    } else if(state.action==='PREPARE_HERE'){clearMedia();prepareHere(true);
    } else if(state.action==='CONNECT')p.reconnectNative();
    else if(state.action==='RELEASE')p.acknowledgeStop();
    else if(state.action==='FREE_GPU')freeGPU(state.screen==='comparison');
    else {if(state.action!=='FINISH')clearMedia();command(state.action);}update();
  };
  $('newDriveBtn').onclick=()=>{
    const action=missionState(p,local).action;clearMedia();
    // An archive button must never become the current drive's Next command.
    if(['NEW_DRIVE','START_SIMULATION','PREPARE_HERE'].includes(action))$('drivePrimaryAction').click();
  };
  const freeGPU=(keepResults=false)=>{
    if(local.shutdownPending)return;local.autoRequested=true;local.preloadRequested=true;if(!keepResults)clearMedia();local.commandPending=false;pending=null;
    if(p.stopSimulator()){local.shutdownPending=true;local.launchPending=false;}update();
  };
  $('missionFreeGPU').onclick=freeGPU;
  function renderRun(mode,run){
    const section=document.createElement('article'),title=document.createElement('h3'),outcome=document.createElement('p'),dl=document.createElement('dl');
    title.textContent=modeLabel(mode);outcome.textContent=presentationOutcome(run)+' · '+recordedDriverDescription(run);
    for(const [label,key,suffix] of [['Distance','distance_m',' m'],['Recorded contacts','collisions',''],['Recorded time','duration_s',' s']]){
      const row=document.createElement('div'),dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=label;
      dd.textContent=Number.isFinite(run?.[key])?run[key].toFixed(key==='collisions'?0:1)+suffix:'Not measured';row.append(dt,dd);dl.append(row);
    }section.append(title,outcome,dl);
    if(run?.stress_audit){const note=document.createElement('p');note.textContent=stressSummary(run.stress_audit);section.append(note);}
    return section;
  }
  function update(){
    const d=p.presentation||{},scenarioCatalog=scenarios();
    if(!local.scenarioChosen&&(!d.id||local.newDrive)&&scenarioCatalog?.default_id)local.scenarioId=scenarioCatalog.default_id;
    if(p.connected&&p.fresh)local.launchPending=false;
    const driving=p.journey?.status==='RUNNING',speed=Number.isFinite(p.telemetry?.speedMps)?p.telemetry.speedMps*3.6:null,target=p.journey?.speed_kmh;
    const brakeReason=p.stopDiagnostics?.comfort_control?.constraint==='MEASURED_APPROACH'?
      'Slowing for measured forward clearance':controlReasonText(p.stopDiagnostics?.reason||p.safetySystem?.reason||'Following route');
    telemetry.hidden=!driving;
    telemetry.textContent=driving?`Speed ${Number.isFinite(speed)?speed.toFixed(1):'—'} / requested ${Number.isFinite(target)?target:'—'} km/h · ${p.stopDiagnostics?.decision_source||p.safetySystem?.actual_generator||'Driver'} · ${brakeReason}`:'';
    if(local.shutdownPending&&(['STOPPED','FAILED'].includes(p.simulatorStop?.status)||p.operationError))local.shutdownPending=false;
    const transitioned=pending&&(d.id!==pending.id||d.status!==pending.phase||d.arm!==pending.arm);
    if(pending&&(p.failedSequence===pending.sequence||p.acknowledged>=pending.sequence&&transitioned||performance.now()-pending.at>45000)){
      if(performance.now()-pending.at>45000&&!p.operationError)p.operationError='Waiting for confirmation. Check the session connection before retrying.';
      pending=null;local.commandPending=false;
    }
    const savedResults=!local.newDrive&&d.guided&&['RESULTS','FINISHING','COMPLETE'].includes(d.status)&&d.pair_id;
    const activePresentation=d.id&&!['IDLE','COMPLETE','CANCELLED','ERROR'].includes(d.status);
    if(activePresentation&&p.controller===false)local.observing=true;
    const validationOwnsSimulator=reservedElsewhere(scenarioCatalog);
    if(scenarioCatalog&&!validationOwnsSimulator&&!savedResults&&!activePresentation&&!local.autoRequested&&!p.isReplay&&p.simulatorStart?.available){
      local.autoRequested=true;
      if(!p.connected&&!p.simulationStarting&&p.simulatorStart.status!=='FAILED'&&p.simulatorStop?.status!=='STOPPING'){
        local.launchPending=true;p.startSimulation().finally(()=>{local.launchPending=false;update();});
      }
    }
    if(scenarioCatalog&&!validationOwnsSimulator&&!savedResults&&!activePresentation&&!['STARTING','RUNNING'].includes(p.journey?.status)&&p.connected&&p.fresh&&!p.isReplay&&!local.shutdownPending&&!local.preloadRequested&&!local.preloadError&&!local.observing){
      prepareHere();
    }
    if(d.page_id===local.pageId){local.pageAdmitted=true;if(d.id!==local.newDriveFrom)local.newDrive=false;}
    if(preloadWasObserved(p,local)){
      local.preloadRequested=false;local.preloadSequence=null;local.preloadError=null;local.observing=true;
    }
    if(local.preloadSequence&&p.failedSequence===local.preloadSequence){
      local.preloadError=p.operationError||'The fresh scene request was rejected.';
      if(local.scenarioSelectionPending){local.scenarioId=d.scenario_id||LEGACY_SCENARIO;local.scenarioSelectionPending=false;}
    }
    if(local.preloadRequested&&!local.pageAdmitted&&p.acknowledged<local.preloadSequence&&performance.now()-local.preloadAt>45000)local.preloadError='The page did not receive confirmation. Reconnect or prepare a fresh drive here.';
    const state=missionState(p,{...local,validationReserved:validationOwnsSimulator});document.body.dataset.mission=state.screen;

    if(!state.camera&&$('cameraCard').classList.contains('camera-expanded'))tools.expandCamera(false);
    const history=document.body.dataset.workspace==='results';experience.hidden=history;returnToMission.hidden=!history;
    if(history&&results.parentNode!==resultsAnchor.parentNode)resultsAnchor.after(results);
    const showPreview=['welcome','choose'].includes(state.screen);
    $('missionPreview').hidden=!showPreview;preview.setVisible(showPreview&&!history);$('missionScene').hidden=!state.camera;
    const previewParent=state.choices?experience.querySelector('.mission-copy'):experience;
    if($('missionPreview').parentElement!==previewParent)previewParent.insertBefore($('missionPreview'),state.choices?$('missionOutcomes'):$('missionScene'));
    if($('missionTitle').textContent!==state.title){
      $('missionTitle').textContent=state.title;
      if(state.screen==='welcome'&&state.title==='Take the driver’s view.'){
        const emphasis=document.createElement('span');emphasis.className='mission-handwritten';emphasis.textContent='view.';
        $('missionTitle').replaceChildren(document.createTextNode('Take the driver’s '),emphasis);
      }
    }
    if($('missionDetail').textContent!==state.detail)$('missionDetail').textContent=state.detail;
    $('missionStep').textContent=state.screen==='driving'?`Drive ${state.arm+1} of 2 · Live`:state.screen==='choose'?'Your starting point':state.screen==='comparison'?'Your comparison':state.screen==='outcome'?'Drive 1 of 2 · Saved':state.screen==='welcome'?'The simulator is off':'Your driving session';
    guide.hidden=state.screen!=='welcome';
    const actual=p.population?.actual,setup=d.setup;
    $('missionTraffic').textContent=state.camera&&actual?`${actual.vehicles??'—'} vehicles · ${actual.pedestrians??'—'} pedestrians`+(setup?.scene==='DENSE_CHAOS'?' · requested '+(setup?.requested_route_vehicles??60)+' / '+(setup?.requested_route_pedestrians??100):''):'';
    $('missionChoices').hidden=!state.choices;
    const actionAnchor=state.choices?$('missionChoices'):$('missionError');
    if(actionAnchor.nextElementSibling!==actionArea)actionAnchor.after(actionArea);
    updateGPU(p);
    scenarioField.hidden=history||!state.choices&&state.screen!=='welcome';
    if(!p.isReplay&&!document.hidden&&(!scenarioCatalog||!scenarioField.hidden)&&!tools.scenarioLoading&&performance.now()>=(local.scenarioRefreshAt||0)){
      local.scenarioRefreshAt=performance.now()+2000;
      tools.loadScenarios().then(update);
    }
    if(local.scenarioSelectionPending&&d.id&&d.page_id===local.pageId&&(d.scenario_id||LEGACY_SCENARIO)===local.scenarioId)local.scenarioSelectionPending=false;
    if(!local.scenarioDraft&&!local.scenarioSelectionPending&&d.id&&d.page_id===local.pageId)local.scenarioId=d.scenario_id||LEGACY_SCENARIO;
    else if(!local.scenarioChosen&&!d.id&&scenarioCatalog?.default_id)local.scenarioId=scenarioCatalog.default_id;
    scenarioField.dataset.selected=local.scenarioId;
    for(const input of scenarioField.querySelectorAll('[name=roadScenario]'))input.checked=input.value===local.scenarioId;
    const urbanOption=scenarioCatalog?.options?.find(option=>option.id===EGYPT_SCENARIO);
    const availability=urbanAvailability(scenarioCatalog);
    if($('missionUrbanStatus').textContent!==availability.label)$('missionUrbanStatus').textContent=availability.label;
    scenarioField.dataset.urbanAccess=availability.available?'available':'pending';
    scenarioField.disabled=!!local.commandPending||local.scenarioSelectionPending||!!d.id&&!d.awaiting_choice&&!['COMPLETE','CANCELLED','ERROR','IDLE'].includes(d.status);
    $('missionRefreshScenarios').disabled=tools.scenarioLoading||local.scenarioRefreshing;
    $('missionRefreshScenarios').textContent=tools.scenarioLoading?'Checking availability…':'Refresh availability';
    $('missionScenarioAccessTitle').textContent=availability.title;
    $('missionScenarioBackendReason').textContent=urbanOption?validationDetails(scenarioCatalog):'Waiting for the simulator catalog.';
    $('missionScenarioTechnical').hidden=!urbanOption;
    $('missionScenarioSelectionHint').textContent=local.scenarioDraft?'Selection only · no drive started':'Both drivers use the selected scenario';
    const scenarioNotice=(local.scenarioId===EGYPT_SCENARIO&&availability.available?
      `EGYPT_URBAN_CHAOS_V1 · v1 · seed ${d.seed??'assigned during preparation'} · 600–800 m · requested 60 vehicles / 100 pedestrians. `+
        (urbanOption?.native_accepted?'Source-bound native acceptance verified.':'Native acceptance pending; bounded validation only. No zero-contact guarantee.'):
      availability.notice)+(tools.scenarioError?' '+tools.scenarioError:'');
    if($('missionScenarioNotice').textContent!==scenarioNotice)$('missionScenarioNotice').textContent=scenarioNotice;
    for(const input of experience.querySelectorAll('[name=firstDrive]'))input.closest('label').querySelector('.mission-driver-description').textContent=scenarioDriverText(input.value,local.scenarioId);
    for(const input of experience.querySelectorAll('[name=firstDrive]'))input.disabled=!!local.commandPending||local.scenarioSelectionPending||!!d.preloaded&&!d.awaiting_choice;
    const primary=$('drivePrimaryAction');
    primary.hidden=!state.action&&!state.choices&&!state.loadingDrive;
    const scenario=validationOwnsSimulator||['START_GUIDED','START_SIMULATION','PREPARE_HERE'].includes(state.action)?scenarioStartState(local,scenarioCatalog):{};
    const scenarioBlocked=scenario.blocked;
    const actionLabel=local.scenarioSelectionPending?'Preparing selected scenario…':scenario.label||state.label;
    const busy=!!(state.loadingDrive||local.scenarioSelectionPending||scenario.checking);
    if(scenarioBlocked)primary.hidden=false;
    validationNotice.hidden=!scenarioBlocked;
    validationNotice.textContent=scenarioBlocked?validationSummary(scenarioCatalog):'';
    if(primary.textContent!==actionLabel)primary.textContent=actionLabel;primary.dataset.action=scenarioBlocked?'':state.action||'';primary.disabled=!state.action||local.scenarioSelectionPending||scenarioBlocked;
    if(scenario.needsPreparation)primary.dataset.action='PREPARE_SCENARIO';
    primary.dataset.loading=String(busy);primary.setAttribute('aria-busy',String(busy));
    primary.dataset.gpuStatus=gpuPanel.dataset.status;
    primary.setAttribute('aria-describedby','missionValidationStatus missionNextHint missionGPU');
    $('missionFreeGPU').hidden=!state.freeGPU||state.action==='FREE_GPU';$('missionWorking').hidden=!['loading','releasing'].includes(state.screen);
    $('missionNextHint').textContent=scenarioBlocked?availability.notice:scenario.needsPreparation?'Access is available. Prepare this scenario, then choose when to start driving.':local.scenarioSelectionPending?'Waiting for the selected road scenario to be prepared.':state.loadingDrive?state.detail:state.choices&&!state.action?'Simulation ready. Choose your first drive.':
      {PREPARE_HERE:'Next: save and stop the previous attempt, then prepare a new starting scene using the same running simulator.',START_SIMULATION:'Next: connect the camera, then choose your first drive.',START_GUIDED:'Your fresh scene is ready. Next: fit the selected car, verify sensors, then start from the beginning.',NEXT:state.arm===0?'Next: stop, save, then check the other drive’s starting scene.':'Next: stop, save, then compare the recorded results.',FINISH:'Recordings and previous comparisons remain in Menu.'}[state.action]||'';
    $('missionError').hidden=!p.operationError;$('missionError').textContent=p.operationError?missionFailure(p.operationError):'';
    $('missionOutcomes').hidden=!['comparison','outcome','fault'].includes(state.screen);
    const pair=p.journeyComparison,runs=pair?.pair_id&&pair.pair_id===d.pair_id?pair.runs:d.runs||{},key=state.screen+JSON.stringify(runs)+String(pair?.conditions_match);
    if(key!==outcomeKey){outcomeKey=key;
      if($('missionOutcomes').contains(results))resultsAnchor.after(results);
      $('missionOutcomes').replaceChildren();
      if(state.screen==='outcome')$('missionOutcomes').append(renderRun(state.mode,state.run));
      else if(state.screen==='comparison'&&!history)$('missionOutcomes').append(results);
      else if(state.screen==='fault'){
        for(const mode of d.modes||[])if(runs?.[mode])$('missionOutcomes').append(renderRun(mode,runs[mode]));
      }
    }
    if(state.screen==='comparison'&&!history&&results.parentNode!==$('missionOutcomes'))$('missionOutcomes').append(results);
    $('emergencyStopBtn').hidden=!p.connected||p.isReplay||p.controlMode==='EMERGENCY_STOP';
    for(const id of ['presentationRestart','presentationResume','studioManualStop','acknowledgeStopBtn','cockpitResumeDrive','replayPauseBtn','connectionSetupBtn'])$(id)?.setAttribute('hidden','');
    navigator.update();
    if(state.screen!==previousScreen){experience.dataset.screen=state.screen;
      if(previousScreen&&!history&&experience.contains(document.activeElement)&&document.activeElement!==primary)$('missionTitle').focus({preventScroll:true});
      previousScreen=state.screen;
    }
  }return {update};
}
