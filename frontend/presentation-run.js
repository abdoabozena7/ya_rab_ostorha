import {showWorkspace} from './presentation-ui.js';
import {safetyNotice} from './cockpit-state.js';
import {driveState} from './drive-state.js';
import {recordingVideoRoot,selectPlaybackLeader,benchmarkSpeedText,demoFailure} from './demo-drive.js';
import {metricValue} from './journey-comparison.js';
import {stressSummary,modeLabel} from './mission-state.js';
import {recordedDriverDescription,preferredVideo} from './driver-profile.js';
import {PROJECT_NAME} from './project-name.js';

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
  if(data.scenario_validation)return data.scenario_validation.passed&&data.conditions_match?
    `Normal recorded a pedestrian collision. ${PROJECT_NAME} reached the destination without contact.`:
    'This attempt did not meet the crossing comparison checks. Review the actual recorded outcomes.';
  if(data?.version===5)return (data.world_start_match?'World starting conditions matched. ':'World starting conditions were not verified. ')+'The cars have different models and physical geometry; results are observations, not a brake-only comparison.';
  if(runs.some(r=>r.status!=='ARRIVED'))return 'One or both attempts ended early. Review each outcome and its covered distance.';
  if(!data.conditions_match)return 'Initial conditions were not verified. These are separate observations.';
  return 'Both drivers reached the destination from verified matching initial conditions. Traffic can react differently during each run.';
}

export function presentationOutcome(run, failure){
  if(!run)return failure?'Drive could not start · '+demoFailure(failure.reason||failure.fault?.message||'Unknown preparation fault'):'Not started';
  const fault=failure?.fault||run.stop_diagnostics?.runtime_fault;
  const faultText=fault?.exception_type==='KeyError'?'A required record was lost: '+fault.message: fault?.message;
  const reason=run.reason==='collision'?(faultText?demoFailure(run.reason)+' Additional runtime error: '+faultText:run.reason):faultText||(run.reason==='guided_shortened'?'Stopped early by your choice':run.reason);
  const pedestrian=run.status==='COLLISION'&&run.collision_events?.some(c=>String(c.type).startsWith('walker.'));
  return (pedestrian?'Collision with a pedestrian':{ARRIVED:'Destination reached',SHORTENED:'Stopped by your choice',INTERRUPTED:'Attempt stopped',ERROR:'Drive needs attention',COLLISION:'Contact recorded',RUNNING:'Recording',TIMEOUT:'Time limit reached'}[run.status]||'Saved attempt')+
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
  panel.innerHTML='<div class="presentation-intro"><span class="eyebrow">AUTOMATIC PRESENTATION</span><strong>One route. Two recorded drives.</strong><span>Ya Rab Ostorha → Normal · target 50 km/h</span></div><div class="presentation-actions"><button id="presentationRestart" class="primary" title="Choose a route and seeded traffic, record both drivers, then play the comparison">Start</button><button id="presentationResume" hidden>Resume driving</button><button id="presentationChoose">Choose destination</button></div><ol class="presentation-steps" aria-label="Presentation progress"><li>01 <span>Ya Rab Ostorha</span></li><li>02 <span>Normal</span></li><li>03 <span>Export</span></li><li>04 <span>Playback</span></li><li>05 <span>Results</span></li></ol><div id="presentationNotice" role="status"><strong id="presentationStatus">Ready when you are</strong><p id="presentationDetail">Start prepares the route, traffic and recordings automatically.</p></div>';
  const custom=document.createElement('details');custom.className='presentation-custom';
  const populationNote=document.createElement('span');populationNote.id='presentationPopulation';
  populationNote.textContent=presentationTrafficText(null,null);panel.querySelector('.presentation-intro').append(populationNote);
  custom.innerHTML='<summary>Custom drive</summary><div><span id="presentationDestination">Choose a destination on the map</span><label>Target speed <select id="presentationCustomSpeed"><option value="20">20 km/h</option><option value="30" selected>30 km/h</option></select></label><button id="presentationCustomStart">Start driving & recording</button></div>';
  panel.append(custom);
  $('cameraCard').before(panel);
  const results=document.createElement('section');results.id='presentationResults';results.hidden=true;
  results.innerHTML='<header class="presentation-results-heading"><div><span class="eyebrow">RECORDED COMPARISON</span><h2>Normal &amp; Ya Rab Ostorha</h2><p id="presentationMatch"></p></div><button id="presentationReplay">Replay both</button></header><div class="presentation-videos"></div><p id="presentationPlaybackStatus" role="status"></p><section id="presentationConclusion"><h3>Measured results</h3><p id="presentationSummary"></p><p class="muted">Requested speed and measured speed are reported separately. Outcomes come from each recording.</p></section>';
  $('resultsPhase').querySelector('.analysis-heading').after(results);
  results.querySelector('h2').textContent='Normal & '+PROJECT_NAME;
  const shared=document.createElement('section');shared.id='sharedPerception';shared.hidden=true;
  shared.innerHTML='<div class="shared-perception-heading"><h3>The shared starting view</h3><p>Front camera · 2D detections · before the drives diverge</p></div><div class="recorded-video"><video muted controls playsinline preload="metadata"></video><p class="video-preparing" role="status">Preparing the shared starting view…</p></div><p class="shared-perception-status" role="status"></p><a class="shared-perception-download" download hidden>Download shared view</a>';
  results.querySelector('.presentation-videos').before(shared);
  const sharedVideo=shared.querySelector('video');let sharedURL=null;
  const items=['NORMAL','ROBOSPHERE'].map(mode=>{
    const box=document.createElement('article');box.dataset.mode=mode;box.innerHTML='<div class="recorded-video"><video muted controls playsinline preload="metadata"></video><p class="video-preparing" role="status">Preparing this video…</p></div><h3>'+modeLabel(mode)+'</h3><p class="presentation-driver"></p><p class="presentation-outcome">Not started</p><p class="presentation-speed"></p><a class="video-download" hidden download>Download video</a><p class="presentation-stress"></p><dl class="presentation-metrics"></dl><details><summary>Recorded events</summary><ol></ol></details>';
    results.querySelector('.presentation-videos').append(box);
    return {mode,box,video:box.querySelector('video'),root:null,status:'PENDING'};
  });
  const fields=[['Destination reached','destination_reached',0,''],['Contacts','collisions',0,''],['Forward near misses','near_misses',0,''],
    ['Harsh braking events','harsh_braking_events',0,''],['Safety interventions','safety_interventions',0,''],['Travel time','duration_s',1,' s'],['Distance','distance_m',1,' m']];
  for(const item of items)for(const [label] of fields){const row=document.createElement('div');row.innerHTML='<dt></dt><dd>—</dd>';row.firstChild.textContent=label;item.box.querySelector('dl').append(row);}
  let pendingStart=false,pendingAt=0,lastPoll=0,polling=false,lastPhase='',autoplayId=null,leader=null,linked=false,acknowledged=null;
  const play=async()=>{
    if(!items.every(i=>i.status==='READY'))return;
    p.presentationPlayback=true;if(!p.guidedExperience||p.reviewedComparison)showWorkspace('results');
    linked=true;leader=selectPlaybackLeader(items);
    for(const i of items){if(i.video.error)i.video.load();i.video.currentTime=0;}
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
    $('presentationRestart').textContent=pendingStart?'Starting simulation…':busy?'Presentation running':state.startLabel;
    $('presentationChoose').disabled=busy||active||!p.fresh;
    $('presentationDestination').textContent=p.route?.destination?.name||'Choose a destination on the map';
    $('presentationCustomStart').disabled=busy||active||!p.fresh||!p.route||p.recording||p.controlMode==='EMERGENCY_STOP';
    $('presentationCustomSpeed').disabled=busy||active;
    const resumable=driveState(p).resumable;
    $('presentationResume').hidden=!resumable;
    $('presentationResume').disabled=!p.fresh||p.recording||p.recordingStatus?.finalized===false||p.controlMode==='EMERGENCY_STOP';
    const notice=safetyNotice(p);
    let title=pendingStart?'Starting the simulator':!p.connected?'Simulator stopped or disconnected':busy?(phases[status]||status)+(status==='DRIVING'?' · '+(data.arm===0?'Ya Rab Ostorha':'Normal'):''):notice?.title||phases[status]||'Ready when you are';
    let detail=pendingStart?'The route and both recordings will follow automatically.':p.operationError?demoFailure(p.operationError):status==='ERROR'?demoFailure(data.reason):notice?.detail||
      (status==='DRIVING'?(data.arm===1?'Recording is active. Normal follows the route and traffic signals.':'Recording is active. Signal and protective stops resume automatically.'):busy?'The next step runs automatically. Stop and Emergency stop remain available.':state.startLabel+' prepares the route, traffic and recordings automatically.');
    if(status==='ERROR'&&p.stopDiagnostics?.runtime_fault?.exception_type==='ControlSceneTimeout'&&notice){title=notice.title;detail=notice.detail;}
    if(active&&notice){title=notice.title;detail=notice.detail;}
    if(p.stopDiagnostics?.stopped_for_s>=1&&active)detail+=' Waiting '+p.stopDiagnostics.stopped_for_s.toFixed(0)+' s.';
    if(!p.connected&&!pendingStart)detail=p.operationError||'Use '+state.startLabel+' to start the simulator and run both recorded drives automatically.';
    if(!busy&&p.operationError)title='Action needs attention';
    $('presentationStatus').textContent=title;$('presentationDetail').textContent=detail;
    $('presentationNotice').dataset.tone=p.operationError||status==='ERROR'?'warning':notice?.tone||'neutral';
    const step=presentationStep(status,data?.arm);
    panel.querySelectorAll('.presentation-steps li').forEach((el,i)=>{el.dataset.active=String(busy&&i===step);el.dataset.complete=String(status==='COMPLETE'||i<step);});
    const archived=p.reviewedComparison;
    const pair=archived||p.journeyComparison,newAttempt=!archived&&data?.guided&&!['RESULTS','FINISHING','COMPLETE'].includes(status)&&pair?.manifest?.presentation_id!==data.id;
    const isPresentation=[3,4,6].includes(pair?.version)&&!newAttempt;
    results.hidden=!isPresentation;
    if(!isPresentation&&items.some(i=>i.root)){
      linked=false;p.presentationPlayback=false;sharedVideo.pause();sharedVideo.removeAttribute('src');sharedVideo.load();sharedURL=null;
      for(const item of items){item.video.pause();item.video.removeAttribute('src');item.video.load();item.root=null;item.status='PENDING';}
    }
    if(isPresentation){
      $('ordinaryComparison').hidden=true;$('hybridResults').hidden=true;
      const common=pair.shared_perception||(!archived&&data?.shared_perception);
      shared.hidden=!pair.manifest?.comparison_scenario&&!common;
      const root=recordingVideoRoot(common?.recording),url=common?.status==='READY'&&root&&common.video==='shared-perception.mp4'?root+common.video:null;
      if(url!==sharedURL){sharedVideo.pause();sharedURL=url;if(url)sharedVideo.src=url;else sharedVideo.removeAttribute('src');}
      shared.querySelector('.video-preparing').hidden=!!url;
      shared.querySelector('.video-preparing').textContent=common?.status==='UNAVAILABLE'?common.reason:common?.status==='ERROR'?'Shared-view export needs attention. The original recordings remain saved.':'Preparing the shared starting view…';
      shared.querySelector('.shared-perception-status').textContent=url?
        `Shared beginning only · ${(common.duration_s||0).toFixed(1)} s. The view ends when the recorded drives first diverge.`:common?.error||'Checking the common camera prefix of both recordings.';
      const download=shared.querySelector('.shared-perception-download');download.hidden=!url;if(url)download.href=url;else download.removeAttribute('href');
      $('presentationMatch').textContent=pair.conditions_match?'Verified matching initial conditions · reactive traffic can diverge':'Initial conditions pending or unverified';
      $('presentationSummary').textContent=presentationSummary(pair);
      for(const item of items){const run=pair.runs?.[item.mode];
        item.box.querySelector('h3').textContent=modeLabel(item.mode);
        item.box.querySelector('.presentation-driver').textContent=!run?'No recorded attempt':run?.setup?.comparison_scenario?
          item.mode==='NORMAL'?'Reactive sensor braking':'Early crossing prediction and sensor braking':recordedDriverDescription(run);
        item.box.querySelector('.presentation-outcome').textContent=presentationOutcome(run,!archived&&data?.failures?.find(f=>f.mode===item.mode));
        item.box.querySelector('.presentation-speed').textContent=benchmarkSpeedText(run);
        item.box.querySelector('.presentation-stress').textContent=stressSummary(run?.stress_audit);
        item.box.querySelector('.presentation-stress').hidden=!run?.stress_audit;
        fields.forEach(([,field,digits,suffix],i)=>{item.box.querySelectorAll('dd')[i].textContent=metricValue(run,field,digits,suffix);});
        const events=run?.events||[],key=run?.id+':'+events.length;
        if(item.eventsKey!==key){item.eventsKey=key;const list=item.box.querySelector('ol');list.replaceChildren();for(const event of events.slice(-12)){const li=document.createElement('li');li.textContent=event.title+' · '+event.detail;list.append(li);}}
        const root=recordingVideoRoot(run?.recording);
        if(item.root!==root||!root&&item.status!=='UNAVAILABLE'){item.video.pause();item.root=root;item.status=root?'PENDING':'UNAVAILABLE';item.video.removeAttribute('src');
          const download=item.box.querySelector('.video-download');download.hidden=true;download.removeAttribute('href');}
        const placeholder=item.box.querySelector('.video-preparing');placeholder.hidden=item.status==='READY';
        placeholder.textContent=!root?'No video: this drive was not recorded.':item.status==='ERROR'?'Video export needs attention. The recorded outcome is saved.':item.status==='ENCODING_ANNOTATION'?'Adding the selected forecast…':'Preparing this video…';
      }
      if(!polling&&performance.now()-lastPoll>1500){lastPoll=performance.now();polling=true;
        Promise.allSettled(items.filter(i=>i.root&&i.status!=='READY').map(async i=>{const root=i.root,response=await fetch(root+'video-status.json',{cache:'no-store',signal:AbortSignal.timeout(5000)});if(!response.ok)return;const v=await response.json();if(i.root!==root)return;const filename=preferredVideo(v);i.status=filename?'READY':v.status==='READY'?'WAITING_FOR_ANNOTATION':v.status;i.duration_s=v.duration_s;if(filename){i.video.src=root+filename;const download=i.box.querySelector('.video-download');download.href=root+filename;download.hidden=false;}if(v.status==='ERROR')$('presentationPlaybackStatus').textContent=v.error||'Video export failed; the saved outcome remains available.';})).finally(()=>{polling=false;});
      }
      $('presentationReplay').disabled=!items.every(i=>i.status==='READY');
      if(status==='PLAYBACK'&&archived)p.reviewedComparison=null;
      if(!p.guidedExperience&&status==='PLAYBACK'&&!archived&&autoplayId!==data.id&&items.every(i=>i.status==='READY')){autoplayId=data.id;showWorkspace('results');results.scrollIntoView({behavior:'smooth',block:'start'});play();}
      if(!p.guidedExperience&&status==='COMPLETE'&&lastPhase!=='COMPLETE'){$('presentationPlaybackStatus').textContent='Playback complete. Both measured results are shown below.';showWorkspace('results');$('presentationConclusion').scrollIntoView({behavior:'smooth',block:'center'});}
    }
    lastPhase=status;
  }};
}
