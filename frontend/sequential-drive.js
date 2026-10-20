import {installGuidedDetails} from './guided-details.js';
import {missionState,modeLabel,stressSummary,missionFailure} from './mission-state.js';
import {controlReasonText} from './cockpit-state.js';
import {PROJECT_NAME} from './project-name.js';
import {showWorkspace} from './presentation-ui.js';
import {presentationOutcome} from './presentation-run.js';
import {installPreviewPlayer} from './preview-player.js';
import {recordedDriverDescription} from './driver-profile.js';

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
  const telemetry=document.createElement('p');telemetry.id='missionTelemetry';telemetry.setAttribute('role','status');
  experience.querySelector('#missionDetail').after(telemetry);
  const guide=document.createElement('section');guide.id='missionGuide';guide.setAttribute('aria-labelledby','missionGuideTitle');
  guide.innerHTML='<h2 id="missionGuideTitle">Before you drive</h2>';
  for(const [index,[question,answer]] of [
    ['What will I see?','The same Mercedes, sensors and crossing scenario. Normal uses reactive braking; Ya Rab Ostorha adds early crossing prediction and visible forecast paths. Choose either drive first; the other starts automatically.'],
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
  const local={pageId,pageAdmitted:false,firstMode:'NORMAL',launchPending:false,shutdownPending:false,commandPending:false,autoRequested:false,preloadRequested:false};
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
    if(operation==='START_GUIDED')Object.assign(value,{first_mode:local.firstMode,page_id:local.pageId,scene:'DENSE_CHAOS',speed_kmh:120,...(d.status==='CHOOSING'?{prepared_id:d.id}:{})});
    if(!p.dashboardAction('presentation',value))return;
    pending={id:d.id,phase:d.status,arm:d.arm,sequence:p.sequence,at:performance.now()};local.commandPending=true;
  };
  const prepareHere=(replace=false)=>{
    p.operationError=null;local.preloadError=null;local.pageAdmitted=false;
    if(!p.dashboardAction('presentation',{operation:'PRELOAD',page_id:local.pageId,replace})){
      local.preloadError=p.operationError;return;
    }
    local.preloadRequested=true;local.preloadSequence=p.sequence;local.preloadAt=performance.now();
  };
  $('drivePrimaryAction').onclick=()=>{
    const state=missionState(p,local);if(!state.action)return;p.operationError=null;
    if(state.action==='NEW_DRIVE'){
      local.newDrive=true;local.newDriveFrom=p.presentation?.id;local.autoRequested=true;local.preloadRequested=false;local.pageAdmitted=false;clearMedia();
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
    const d=p.presentation||{};if(p.connected&&p.fresh)local.launchPending=false;
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
    if(!savedResults&&!local.autoRequested&&!p.isReplay&&p.simulatorStart?.available){
      local.autoRequested=true;
      if(!p.connected&&!p.simulationStarting&&p.simulatorStart.status!=='FAILED'&&p.simulatorStop?.status!=='STOPPING'){
        local.launchPending=true;p.startSimulation().finally(()=>{local.launchPending=false;update();});
      }
    }
    const activePresentation=d.id&&!['IDLE','COMPLETE','CANCELLED','ERROR'].includes(d.status);
    if(!savedResults&&!activePresentation&&!['STARTING','RUNNING'].includes(p.journey?.status)&&p.connected&&p.fresh&&!p.isReplay&&!local.shutdownPending&&!local.preloadRequested&&!local.preloadError){
      prepareHere();
    }
    if(d.page_id===local.pageId){local.pageAdmitted=true;if(d.id!==local.newDriveFrom)local.newDrive=false;}
    if(local.preloadSequence&&p.failedSequence===local.preloadSequence)local.preloadError=p.operationError||'The fresh scene request was rejected.';
    if(local.preloadRequested&&!local.pageAdmitted&&p.acknowledged<local.preloadSequence&&performance.now()-local.preloadAt>45000)local.preloadError='The page did not receive confirmation. Reconnect or prepare a fresh drive here.';
    const state=missionState(p,local);document.body.dataset.mission=state.screen;

    if(!state.camera&&$('cameraCard').classList.contains('camera-expanded'))tools.expandCamera(false);
    const history=document.body.dataset.workspace==='results';experience.hidden=history;returnToMission.hidden=!history;
    if(history&&results.parentNode!==resultsAnchor.parentNode)resultsAnchor.after(results);
    const showPreview=['welcome','choose'].includes(state.screen);
    $('missionPreview').hidden=!showPreview;preview.setVisible(showPreview&&!history);$('missionScene').hidden=!state.camera;
    const previewParent=state.choices?experience.querySelector('.mission-copy'):experience;
    if($('missionPreview').parentElement!==previewParent)previewParent.insertBefore($('missionPreview'),state.choices?$('missionOutcomes'):$('missionScene'));
    if($('missionTitle').textContent!==state.title){
      $('missionTitle').textContent=state.title;
      if(state.screen==='welcome'){
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
    for(const input of experience.querySelectorAll('[name=firstDrive]'))input.disabled=!!local.commandPending||!!d.preloaded&&!d.awaiting_choice;
    const primary=$('drivePrimaryAction');
    primary.hidden=!state.action&&!state.choices&&!state.loadingDrive;
    if(primary.textContent!==state.label)primary.textContent=state.label;primary.dataset.action=state.action||'';primary.disabled=!state.action;
    primary.dataset.loading=String(state.loadingDrive);primary.setAttribute('aria-busy',String(state.loadingDrive));
    primary.style.setProperty('--load-step',state.loadStep??4);
    primary.setAttribute('aria-describedby','missionNextHint');
    $('missionFreeGPU').hidden=!state.freeGPU||state.action==='FREE_GPU';$('missionWorking').hidden=!['loading','releasing'].includes(state.screen);
    $('missionNextHint').textContent=state.loadingDrive?state.detail:state.choices&&!state.action?'Simulation ready. Choose your first drive.':
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
