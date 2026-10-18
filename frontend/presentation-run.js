import {showWorkspace} from './presentation-ui.js';
import {safetyNotice} from './cockpit-state.js';
import {driveState} from './drive-state.js';
import {recordingVideoRoot,selectPlaybackLeader,benchmarkSpeedText,demoFailure} from './demo-drive.js';
import {metricValue} from './journey-comparison.js';

const $=id=>document.getElementById(id);
const phases={STOPPING:'Stopping the previous drive',PREPARING:'Choosing the route and preparing traffic',READY:'Confirming route traffic',
  STARTING:'Starting the recording',DRIVING:'Driving and recording',FINALIZING:'Saving the recording',RESTORING:'Restoring the same initial conditions',
  RECOVERING:'Checking sensors before Normal',EXPORTING:'Exporting both videos',PLAYBACK:'Playing the comparison',COMPLETE:'Presentation complete',CANCELLED:'Presentation stopped',ERROR:'Presentation needs attention'};
export function presentationStep(status,arm=0){
  if(['PLAYBACK','COMPLETE'].includes(status))return status==='COMPLETE'?4:3;
  if(status==='EXPORTING')return 2;
  return arm===1||status==='RESTORING'?1:0;
}
export function presentationSummary(data){
  const runs=['ROBOSPHERE','NORMAL'].map(m=>data?.runs?.[m]);
  if(runs.some(r=>!r))return 'Both attempts must be recorded before comparing results.';
  if(runs.some(r=>r.status!=='ARRIVED'))return 'One or both attempts ended early. Review each outcome and its covered distance.';
  if(!data.conditions_match)return 'Initial conditions were not verified. These are separate observations.';
  return 'Both drivers reached the destination from verified matching initial conditions. Traffic can react differently during each run.';
}

export function presentationOutcome(run, failure){
  if(!run)return 'Not started';
  const fault=failure?.fault||run.stop_diagnostics?.runtime_fault;
  const faultText=fault?.exception_type==='KeyError'?'A required record was lost: '+fault.message: fault?.message;
  const reason=run.reason==='collision'?(faultText?demoFailure(run.reason)+' Additional runtime error: '+faultText:run.reason):faultText||run.reason;
  return (run.status==='ARRIVED'?'Destination reached':run.status)+
    (reason&&reason!=='destination_reached'?' · '+(fault?reason:demoFailure(reason)):'')+
    (fault?.injected_validation_fault?' · Injected validation fault; excluded from driving acceptance.':'');
}

export function presentationTrafficText(population,setup){
  const requested=setup?.requested_route_vehicles??40,walkers=setup?.requested_route_pedestrians??30;
  const crowding=population?.route_crowding;
  if(!crowding)return `Busy route · up to ${requested} vehicles · ${walkers} pedestrians`;
  return `Route traffic · ${population.actual?.vehicles??'—'}/${requested} vehicles · ${population.actual?.pedestrians??'—'}/${walkers} pedestrians`+
    (crowding.target_count<requested?' · limited by safe road spaces':'');
}

export function installPresentationRun(p,tools,clearControls){
  const panel=document.createElement('section');panel.id='presentationControls';panel.setAttribute('aria-label','Automatic presentation');
  panel.innerHTML='<div class="presentation-intro"><span class="eyebrow">AUTOMATIC PRESENTATION</span><strong>One route. Two recorded drives.</strong><span>Robosphere → Normal · target 50 km/h</span></div><div class="presentation-actions"><button id="presentationRestart" class="primary" title="Choose a route and seeded traffic, record both drivers, then play the comparison">↻ Restart</button><button id="presentationResume" hidden>Resume driving</button><button id="presentationChoose">Choose destination</button></div><ol class="presentation-steps" aria-label="Presentation progress"><li>01 <span>Robosphere</span></li><li>02 <span>Normal</span></li><li>03 <span>Export</span></li><li>04 <span>Playback</span></li><li>05 <span>Results</span></li></ol><div id="presentationNotice" role="status"><strong id="presentationStatus">Ready when you are</strong><p id="presentationDetail">Restart prepares the route, traffic and recordings automatically.</p></div>';
  const custom=document.createElement('details');custom.className='presentation-custom';
  const populationNote=document.createElement('span');populationNote.id='presentationPopulation';
  populationNote.textContent=presentationTrafficText(null,null);panel.querySelector('.presentation-intro').append(populationNote);
  custom.innerHTML='<summary>Custom drive</summary><div><span id="presentationDestination">Choose a destination on the map</span><label>Target speed <select id="presentationCustomSpeed"><option value="20">20 km/h</option><option value="30" selected>30 km/h</option></select></label><button id="presentationCustomStart">Start driving & recording</button></div>';
  panel.append(custom);
  $('cameraCard').before(panel);
  const results=document.createElement('section');results.id='presentationResults';results.hidden=true;
  results.innerHTML='<header class="presentation-results-heading"><div><span class="eyebrow">RECORDED COMPARISON</span><h2>Robosphere & Normal</h2><p id="presentationMatch"></p></div><button id="presentationReplay">Replay both</button></header><div class="presentation-videos"></div><p id="presentationPlaybackStatus" role="status"></p><section id="presentationConclusion"><h3>Measured results</h3><p id="presentationSummary"></p><p class="muted">Normal follows the route and traffic signals with obstacle protection off. An intervention is not a proven prevented collision. Requested speed and measured speed are reported separately.</p></section>';
  $('resultsPhase').querySelector('.analysis-heading').after(results);
  const items=['ROBOSPHERE','NORMAL'].map(mode=>{
    const box=document.createElement('article');box.innerHTML='<h3>'+(mode==='ROBOSPHERE'?'Robosphere · RULE protection':'Normal · obstacle protection off')+'</h3><video muted playsinline preload="metadata"></video><p class="presentation-outcome">Not started</p><p class="presentation-speed"></p><dl class="presentation-metrics"></dl><details><summary>Recorded events</summary><ol></ol></details>';
    results.querySelector('.presentation-videos').append(box);
    return {mode,box,video:box.querySelector('video'),root:null,status:'PENDING'};
  });
  const fields=[['Destination reached','destination_reached',0,''],['Contacts','collisions',0,''],['Forward near misses','near_misses',0,''],
    ['Harsh braking events','harsh_braking_events',0,''],['Safety interventions','safety_interventions',0,''],['Travel time','duration_s',1,' s'],['Distance','distance_m',1,' m']];
  for(const item of items)for(const [label] of fields){const row=document.createElement('div');row.innerHTML='<dt></dt><dd>—</dd>';row.firstChild.textContent=label;item.box.querySelector('dl').append(row);}
  let pendingStart=false,pendingAt=0,lastPoll=0,polling=false,lastPhase='',autoplayId=null,leader=null,linked=false,acknowledged=null;
  const play=async()=>{
    if(!items.every(i=>i.status==='READY'))return;
    p.presentationPlayback=true;showWorkspace('results');
    linked=true;leader=selectPlaybackLeader(items);
    for(const i of items)i.video.currentTime=0;
    const attempts=await Promise.allSettled(items.map(i=>i.video.play()));
    const blocked=attempts.some(r=>r.status==='rejected');
    $('presentationPlaybackStatus').textContent=blocked?'Playback was blocked. Select Replay both to continue.':'Playing both recordings on the same simulation clock.';
  };
  $('presentationReplay').onclick=play;
  for(const item of items){
    item.video.addEventListener('timeupdate',()=>{if(linked&&leader===item)for(const peer of items)if(peer!==item&&peer.video.readyState){
      const at=Math.min(item.video.currentTime,Number.isFinite(peer.video.duration)?peer.video.duration:Infinity);
      if(Math.abs(peer.video.currentTime-at)>.12)peer.video.currentTime=at;
    }});
    item.video.addEventListener('pause',()=>{if(linked&&leader===item&&!item.video.ended)for(const peer of items)if(peer!==item)peer.video.pause();});
    item.video.addEventListener('play',()=>{if(linked&&leader===item)for(const peer of items)if(peer!==item&&!peer.video.ended)peer.video.play().catch(()=>{});});
    item.video.addEventListener('ended',()=>{if(linked&&leader===item){
      p.presentationPlayback=false;
      if(p.presentation?.status==='PLAYBACK'&&acknowledged!==p.presentation.id){
        acknowledged=p.presentation.id;p.dashboardAction('presentation',{operation:'PLAYBACK_FINISHED',id:acknowledged});
      } else $('presentationPlaybackStatus').textContent='Saved playback complete. These recorded outcomes are unchanged.';
    }});
    item.video.addEventListener('error',()=>{$('presentationPlaybackStatus').textContent='Video playback failed. The saved run remains available; use Replay both to retry.';});
  }
  $('presentationRestart').onclick=()=>{
    p.reviewedComparison=null;p.presentationPlayback=false;
    p.operationError=null;tools.close(false);document.body.classList.remove('studio-setup-open');showWorkspace('drive');
    pendingStart=true;pendingAt=performance.now();
    if(!p.connected)p.startSimulation();
    else if(p.dashboardAction('presentation',{operation:'RESTART',speed_kmh:50}))pendingStart=false;
  };
  $('presentationResume').onclick=()=>{p.operationError=null;p.startJourney(p.journey?.speed_kmh||30,p.journey?.driving_mode||'ROBOSPHERE');};
  $('presentationChoose').onclick=()=>tools.open('routePanel','presentationChoose');
  $('presentationCustomStart').onclick=()=>{p.operationError=null;p.startJourney(Number($('presentationCustomSpeed').value),'ROBOSPHERE');};
  return {update(){
    const data=p.presentation,state=driveState(p),status=state.presentationStatus,busy=state.busy,active=['STARTING','RUNNING'].includes(p.journey?.status);
    $('presentationPopulation').textContent=presentationTrafficText(p.fresh?p.population:null,data?.setup);
    if(['CANCELLED','ERROR'].includes(status)&&lastPhase!==status){linked=false;p.presentationPlayback=false;for(const i of items)i.video.pause();}
    if(pendingStart&&p.connected&&p.fresh&&!p.simulationStarting){
      if(p.dashboardAction('presentation',{operation:'RESTART',speed_kmh:50}))pendingStart=false;
    }
    if(pendingStart&&(p.operationError||performance.now()-pendingAt>180000)){pendingStart=false;if(!p.operationError)p.operationError='Simulator startup timed out. Use Restart to retry.';}
    $('presentationRestart').disabled=busy||pendingStart||p.restarting||p.isReplay||p.controlMode==='EMERGENCY_STOP';
    $('presentationRestart').textContent=pendingStart?'Starting simulation…':busy?'Presentation running':'↻ Restart';
    $('presentationChoose').disabled=busy||active||!p.fresh;
    $('presentationDestination').textContent=p.route?.destination?.name||'Choose a destination on the map';
    $('presentationCustomStart').disabled=busy||active||!p.fresh||!p.route||p.recording||p.controlMode==='EMERGENCY_STOP';
    $('presentationCustomSpeed').disabled=busy||active;
    const resumable=driveState(p).resumable;
    $('presentationResume').hidden=!resumable;
    $('presentationResume').disabled=!p.fresh||p.recording||p.recordingStatus?.finalized===false||p.controlMode==='EMERGENCY_STOP';
    const notice=safetyNotice(p);
    let title=pendingStart?'Starting the simulator':!p.connected?'Simulator stopped or disconnected':busy?(phases[status]||status)+(status==='DRIVING'?' · '+(data.arm===0?'Robosphere':'Normal'):''):notice?.title||phases[status]||'Ready when you are';
    let detail=pendingStart?'The route and both recordings will follow automatically.':p.operationError?demoFailure(p.operationError):status==='ERROR'?demoFailure(data.reason):notice?.detail||
      (status==='DRIVING'?(data.arm===1?'Recording is active. Normal follows the route and traffic signals.':'Recording is active. Signal and protective stops resume automatically.'):busy?'The next step runs automatically. Stop and Emergency stop remain available.':'Restart prepares the route, traffic and recordings automatically.');
    if(status==='ERROR'&&p.stopDiagnostics?.runtime_fault?.exception_type==='ControlSceneTimeout'&&notice){title=notice.title;detail=notice.detail;}
    if(active&&notice){title=notice.title;detail=notice.detail;}
    if(p.stopDiagnostics?.stopped_for_s>=1&&active)detail+=' Waiting '+p.stopDiagnostics.stopped_for_s.toFixed(0)+' s.';
    if(!p.connected&&!pendingStart)detail=p.operationError||'Use Restart to start the simulator and run both recorded drives automatically.';
    if(!busy&&p.operationError)title='Action needs attention';
    $('presentationStatus').textContent=title;$('presentationDetail').textContent=detail;
    $('presentationNotice').dataset.tone=p.operationError||status==='ERROR'?'warning':notice?.tone||'neutral';
    const step=presentationStep(status,data?.arm);
    panel.querySelectorAll('.presentation-steps li').forEach((el,i)=>{el.dataset.active=String(busy&&i===step);el.dataset.complete=String(status==='COMPLETE'||i<step);});
    const archived=p.reviewedComparison;
    const pair=archived||p.journeyComparison,isPresentation=pair?.version===3;
    results.hidden=!isPresentation;
    if(isPresentation){
      $('ordinaryComparison').hidden=true;$('hybridResults').hidden=true;
      $('presentationMatch').textContent=pair.conditions_match?'Verified matching initial conditions · reactive traffic can diverge':'Initial conditions pending or unverified';
      $('presentationSummary').textContent=presentationSummary(pair);
      for(const item of items){const run=pair.runs?.[item.mode];
        item.box.querySelector('.presentation-outcome').textContent=presentationOutcome(run,!archived&&data?.failures?.find(f=>f.mode===item.mode));
        item.box.querySelector('.presentation-speed').textContent=benchmarkSpeedText(run);
        fields.forEach(([,field,digits,suffix],i)=>{item.box.querySelectorAll('dd')[i].textContent=metricValue(run,field,digits,suffix);});
        const events=run?.events||[],key=run?.id+':'+events.length;
        if(item.eventsKey!==key){item.eventsKey=key;const list=item.box.querySelector('ol');list.replaceChildren();for(const event of events.slice(-12)){const li=document.createElement('li');li.textContent=event.title+' · '+event.detail;list.append(li);}}
        const root=recordingVideoRoot(run?.recording);
        if(item.root!==root){item.video.pause();item.root=root;item.status='PENDING';item.video.removeAttribute('src');}
      }
      if(!polling&&performance.now()-lastPoll>1500){lastPoll=performance.now();polling=true;
        Promise.allSettled(items.filter(i=>i.root&&i.status!=='READY').map(async i=>{const root=i.root,response=await fetch(root+'video-status.json',{cache:'no-store'});if(!response.ok)return;const v=await response.json();if(i.root!==root)return;i.status=v.status;i.duration_s=v.duration_s;if(v.status==='READY')i.video.src=root+'driving.mp4';})).finally(()=>{polling=false;});
      }
      $('presentationReplay').disabled=!items.every(i=>i.status==='READY');
      if(status==='PLAYBACK'&&archived)p.reviewedComparison=null;
      if(status==='PLAYBACK'&&!archived&&autoplayId!==data.id&&items.every(i=>i.status==='READY')){autoplayId=data.id;showWorkspace('results');results.scrollIntoView({behavior:'smooth',block:'start'});play();}
      if(status==='COMPLETE'&&lastPhase!=='COMPLETE'){$('presentationPlaybackStatus').textContent='Playback complete. Both measured results are shown below.';showWorkspace('results');$('presentationConclusion').scrollIntoView({behavior:'smooth',block:'center'});}
    }
    lastPhase=status;
  }};
}
