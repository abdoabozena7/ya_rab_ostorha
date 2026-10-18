import {installGuidedDetails} from './guided-details.js';
import {missionState,modeLabel,stressSummary} from './mission-state.js';
import {showWorkspace} from './presentation-ui.js';
import {presentationOutcome,presentationSummary} from './presentation-run.js';

export function installSequentialDrive(p,tools) {
  const $=id=>document.getElementById(id);
  document.body.classList.add('sequential-drive','mission-experience');p.guidedExperience=true;
  const actions=document.querySelector('.cockpit-header-actions');
  const details=document.createElement('button');details.id='driveDetailsAction';details.textContent='Menu';
  details.setAttribute('aria-controls','cockpitDetails');details.setAttribute('aria-expanded','false');actions.prepend(details);
  const returnToMission=document.createElement('button');returnToMission.textContent='Back to drive';returnToMission.hidden=true;actions.prepend(returnToMission);
  returnToMission.onclick=()=>{p.reviewedComparison=null;p.presentationPlayback=false;for(const video of document.querySelectorAll('#presentationResults video'))video.pause();showWorkspace('drive');update();};
  const navigator=installGuidedDetails(p,tools,details);details.onclick=()=>navigator.open();
  const experience=document.createElement('main');experience.id='missionExperience';
  experience.innerHTML='<section id="missionPreview"><img src="/public/assets/native-preview.jpg" alt="A saved CARLA view of a car on a city street"><span>PREVIEW · SAVED SIMULATOR IMAGE</span></section><section id="missionScene" hidden></section><section class="mission-copy"><div class="mission-location"><span id="missionStep"></span><span id="missionTraffic"></span></div><h2 id="missionTitle" tabindex="-1"></h2><p id="missionDetail" role="status"></p><fieldset id="missionChoices" hidden><legend>Choose your first drive</legend><label><input type="radio" name="firstDrive" value="NORMAL"><span><strong>The problem</strong>Normal · obstacle protection off</span></label><label><input type="radio" name="firstDrive" value="ROBOSPHERE"><span><strong>The solution</strong>Protected · RULE protection</span></label><label class="mission-scene-choice">Starting scene<select id="missionSceneChoice"><option value="BUSY_ROUTE">Busy route</option><option value="DENSE_CHAOS">Dense Chaos Stress Test · requests 40 vehicles / 50 pedestrians</option></select></label></fieldset><div id="missionOutcomes" hidden></div><p id="missionError" role="alert" hidden></p><div class="mission-actions"><button id="drivePrimaryAction" class="primary" hidden></button><button id="missionFreeGPU" hidden>Free GPU</button><span id="missionWorking" hidden><i></i> In progress</span></div><p id="missionNextHint"></p></section>';
  document.querySelector('.app-header').after(experience);$('missionScene').append($('cameraCard'));
  const header=document.querySelector('.app-header');
  if(globalThis.ResizeObserver)new ResizeObserver(()=>document.body.style.setProperty('--mission-header-height',header.offsetHeight+'px')).observe(header);
  const skip=document.querySelector('.skip-link');if(skip)skip.href='#missionTitle';
  const local={firstMode:null,launchPending:false,shutdownPending:false,commandPending:false};
  let previousScreen='',outcomeKey='',pending=null;
  const clearMedia=()=>{p.reviewedComparison=null;p.presentationPlayback=false;document.body.classList.remove('archive-review');
    for(const video of document.querySelectorAll('#presentationResults video'))video.pause();showWorkspace('drive');};
  experience.querySelectorAll('[name=firstDrive]').forEach(input=>input.onchange=()=>{local.firstMode=input.value;update();});
  const command=operation=>{
    const d=p.presentation||{},value={operation,id:d.id,expected_arm:d.arm,expected_phase:d.status};
    if(operation==='START_GUIDED')Object.assign(value,{first_mode:local.firstMode,scene:$('missionSceneChoice').value,speed_kmh:50});
    if(!p.dashboardAction('presentation',value))return;
    pending={id:d.id,phase:d.status,arm:d.arm,at:performance.now()};local.commandPending=true;
  };
  $('drivePrimaryAction').onclick=()=>{
    const state=missionState(p,local);if(!state.action)return;p.operationError=null;
    if(state.action==='START_SIMULATION'){
      clearMedia();local.launchPending=true;local.firstMode=null;experience.querySelectorAll('[name=firstDrive]').forEach(i=>i.checked=false);
      p.startSimulation().finally(()=>{if(!p.simulationStarting)local.launchPending=false;update();});
    } else if(state.action==='CONNECT')p.reconnectNative();
    else if(state.action==='RELEASE')p.acknowledgeStop();
    else if(state.action==='FREE_GPU')freeGPU();
    else {clearMedia();command(state.action);}update();
  };
  const freeGPU=()=>{
    if(local.shutdownPending)return;clearMedia();local.commandPending=false;pending=null;
    if(p.stopSimulator()){local.shutdownPending=true;local.launchPending=false;}update();
  };
  $('missionFreeGPU').onclick=freeGPU;
  function renderRun(mode,run){
    const section=document.createElement('article'),title=document.createElement('h3'),outcome=document.createElement('p'),dl=document.createElement('dl');
    title.textContent=modeLabel(mode);outcome.textContent=presentationOutcome(run);
    for(const [label,key,suffix] of [['Distance','distance_m',' m'],['Recorded contacts','collisions',''],['Recorded time','duration_s',' s']]){
      const row=document.createElement('div'),dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=label;
      dd.textContent=Number.isFinite(run?.[key])?run[key].toFixed(key==='collisions'?0:1)+suffix:'Not measured';row.append(dt,dd);dl.append(row);
    }section.append(title,outcome,dl);
    if(run?.stress_audit){const note=document.createElement('p');note.textContent=stressSummary(run.stress_audit);section.append(note);}
    return section;
  }
  function update(){
    const d=p.presentation||{};if(p.connected&&p.fresh)local.launchPending=false;
    if(local.shutdownPending&&(['STOPPED','FAILED'].includes(p.simulatorStop?.status)||p.operationError))local.shutdownPending=false;
    if(pending&&(p.operationError||d.id!==pending.id||d.status!==pending.phase||d.arm!==pending.arm||performance.now()-pending.at>15000)){
      if(performance.now()-pending.at>15000&&!p.operationError)p.operationError='The step did not confirm. Check the connection, then try the available action.';
      pending=null;local.commandPending=false;
    }
    const state=missionState(p,local);document.body.dataset.mission=state.screen;
    if(!state.camera&&$('cameraCard').classList.contains('camera-expanded'))tools.expandCamera(false);
    const history=document.body.dataset.workspace==='results';experience.hidden=history;returnToMission.hidden=!history;
    $('missionPreview').hidden=!['welcome','choose'].includes(state.screen);$('missionScene').hidden=!state.camera;
    $('missionTitle').textContent=state.title;$('missionDetail').textContent=state.detail;
    $('missionStep').textContent=state.screen==='driving'?`DRIVE ${state.arm+1} OF 2 · LIVE`:state.screen==='choose'?'CHOOSE YOUR FIRST DRIVE':state.screen==='comparison'?'COMPARISON':state.screen==='outcome'?'DRIVE 1 OF 2 · SAVED':'YA RAB OSTORHA / SIMULATOR';
    const actual=p.population?.actual,setup=d.setup;
    $('missionTraffic').textContent=state.camera&&actual?`${actual.vehicles??'—'} vehicles · ${actual.pedestrians??'—'} pedestrians`+(setup?.scene==='DENSE_CHAOS'?' · requested 40 / 50':''):'';
    $('missionChoices').hidden=!state.choices;
    const primary=$('drivePrimaryAction');primary.hidden=!state.action;primary.textContent=state.label;primary.dataset.action=state.action||'';primary.disabled=!state.action;
    $('missionFreeGPU').hidden=!state.freeGPU||state.action==='FREE_GPU';$('missionWorking').hidden=!['loading','releasing'].includes(state.screen);
    $('missionNextHint').textContent={START_SIMULATION:'Next: connect the camera, then choose your first drive.',START_GUIDED:'Next: prepare the scene, then watch live.',NEXT:state.arm===0?'Next: stop, save, then check the other drive’s starting scene.':'Next: stop, save, then compare the recorded results.',FINISH:'Recordings and previous comparisons remain in Menu.'}[state.action]||'';
    $('missionError').hidden=!p.operationError;$('missionError').textContent=p.operationError||'';
    $('missionOutcomes').hidden=!['comparison','outcome','fault'].includes(state.screen);
    const pair=p.journeyComparison,runs=pair?.pair_id&&pair.pair_id===d.pair_id?pair.runs:d.runs||{},key=state.screen+JSON.stringify(runs)+String(pair?.conditions_match);
    if(key!==outcomeKey){outcomeKey=key;$('missionOutcomes').replaceChildren();
      if(state.screen==='outcome')$('missionOutcomes').append(renderRun(state.mode,state.run));
      else if(['comparison','fault'].includes(state.screen)){
        for(const mode of d.modes||[])if(runs?.[mode])$('missionOutcomes').append(renderRun(mode,runs[mode]));
        if(state.screen==='comparison'){const note=document.createElement('p');note.textContent=presentationSummary(pair);$('missionOutcomes').append(note);}
      }
    }
    $('emergencyStopBtn').hidden=!p.connected||p.isReplay||p.controlMode==='EMERGENCY_STOP';
    for(const id of ['presentationRestart','presentationResume','studioManualStop','acknowledgeStopBtn','cockpitResumeDrive','replayPauseBtn','connectionSetupBtn'])$(id)?.setAttribute('hidden','');
    navigator.update();
    if(state.screen!==previousScreen){experience.dataset.screen=state.screen;
      if(previousScreen&&!history&&experience.contains(document.activeElement)&&document.activeElement!==primary)$('missionTitle').focus({preventScroll:true});
      previousScreen=state.screen;
    }
  }return {update};
}
