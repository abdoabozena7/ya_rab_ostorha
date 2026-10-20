import {CITY_PRESETS, cityPopulation} from './city-setup.js';
import {showWorkspace} from './presentation-ui.js';
import {controlReasonText} from './cockpit-state.js';
import {benchmarkTerminalSupported} from './journey-comparison.js';

const $=id=>document.getElementById(id);
export const benchmarkModes=['BASELINE','HYBRID'];
export function benchmarkSpeedText(run) {
  if(!run)return '';
  const measured=value=>run.samples!==0&&Number.isFinite(value)?value.toFixed(1):'—';
  const requested=Number.isFinite(run.setup?.speed_kmh)?run.setup.speed_kmh.toFixed(0):'—';
  return `Speed km/h: mean ${measured(run.mean_speed_kmh)} · peak ${measured(run.maximum_speed_kmh)} · requested ${requested}`;
}
export function selectPlaybackLeader(items) {
  return items.reduce((best,item)=>!best||((item.duration_s||item.video?.duration||0)>(best.duration_s||best.video?.duration||0))?item:best,null);
}
export function recordingVideoRoot(path) {
  const match=String(path||'').replaceAll('\\','/').match(/\/normal_city\/(run_[a-f0-9]{32})$/);
  return match?'/runs/normal_city/'+match[1]+'/':null;
}
export function demoFailure(reason) {
  if(!reason)return '';
  const control=controlReasonText(reason);
  if(control!==reason)return control;
  if(/benchmark.*mismatch|initial.conditions/i.test(reason))return 'The initial conditions did not match. Use Restart to begin a new comparison.';
  if(/comparison traffic changed/i.test(reason))return 'The comparison traffic changed. Saved recordings are retained, but a matched comparison cannot continue. Use Restart.';
  if(reason==='collision')return 'Contact ended this attempt. Its recording and result are saved.';
  if(/acceptance|unfinished/i.test(reason))return 'Hybrid native validation is unfinished. Review the recorded evidence in Results.';
  if(/no space left|not enough.*space|insufficient.*space|storage|disk|ENOSPC/i.test(reason))return 'Recording needs free disk space. Archive saved runs, then try again.';
  if(/recording.*queue|queue.*exhaust/i.test(reason))return 'The recording queue is falling behind. Reduce extra displays, then try again.';
  if(/recording_failure|video_export_failed|recording\b.*(?:fail|error|incomplete|did not|timed out)|(?:failed|incomplete).*recording\b/i.test(reason))return 'Recording did not finish. This failed attempt remains saved; restart the simulation.';
  if(/sensor|scene|freshness/i.test(reason))return 'Motion sensors are unavailable. Restart the simulation before driving.';
  if(/heartbeat|connection|disconnected/i.test(reason))return 'The connection was lost. Reconnect, then resume driving.';
  if(reason==='focus_lost')return 'This earlier drive was paused when the page was hidden. Use Resume driving.';
  if(reason==='operator_stop')return 'Stopped by the operator. Use Resume driving or Restart.';
  return String(reason);
}

export function installDemoDrive(p,tools,clearControls) {
  document.body.classList.add('demo-drive');
  const panel=document.createElement('section');panel.id='simpleDrive';panel.dir='ltr';
  panel.setAttribute('aria-label','Start driving');
  panel.innerHTML='<div class="simple-route"><span>Destination</span><strong id="simpleDestination">Choose a destination on the map</strong><button id="simpleChooseDestination">Choose destination</button></div><label>Requested speed<select id="simpleSpeed"><option value="20">20 km/h</option><option value="30" selected>30 km/h</option><option value="40">40 km/h</option><option value="50">50 km/h</option></select></label><label>Traffic<select id="simpleTraffic"><option value="CALM">Light</option><option value="BUSY" selected>Moderate</option><option value="CHAOTIC">Dense</option></select></label><div class="simple-actions"><button id="simpleRun" class="primary">Start</button><button id="simpleCompare">Hybrid benchmark</button></div><p id="simpleStatus" role="status">Choose a destination and speed, then start driving.</p>';
  $('cameraCard').before(panel);
  const results=document.createElement('section');results.id='hybridResults';results.dir='ltr';
  results.innerHTML='<div class="hybrid-results-heading"><div><h2>Normal driver and hybrid system</h2><p id="hybridPairStatus">Both runs use the same initial conditions, route, requested speed and traffic seed.</p></div><button id="hybridPlayPair">Play both videos</button></div><div class="hybrid-videos"></div><p id="hybridVideoStatus" role="status"></p>';
  $('resultsPhase').querySelector('.analysis-heading').after(results);
  const videos={};
  for(const mode of benchmarkModes){const box=document.createElement('article');box.innerHTML='<h3>'+(mode==='BASELINE'?'CARLA normal driver':'Hybrid system')+'</h3><video controls playsinline preload="metadata"></video><p class="hybrid-run-result">Not started</p><p class="hybrid-run-result hybrid-run-speed"></p>';
    results.querySelector('.hybrid-videos').append(box);videos[mode]={box,video:box.querySelector('video'),key:null,status:'MISSING'};}
  let linkedPlayback=false,playbackLeader=null;
  for(const item of Object.values(videos)){
    const leading=()=>linkedPlayback&&playbackLeader===item;
    const others=()=>Object.values(videos).filter(v=>v!==item);
    const sync=()=>{if(leading())for(const peer of others()){
      if(peer.video.readyState<1)continue;
      const time=Math.min(item.video.currentTime,Number.isFinite(peer.video.duration)?peer.video.duration:Infinity);
      if(Math.abs(peer.video.currentTime-time)>.08)peer.video.currentTime=time;
    }};
    const playOthers=()=>{if(leading())for(const peer of others()){
      if(!Number.isFinite(peer.video.duration)||peer.video.currentTime<peer.video.duration-.02)peer.video.play().catch(()=>{});
    }};
    item.video.addEventListener('timeupdate',sync);item.video.addEventListener('seeking',sync);
    item.video.addEventListener('pause',()=>{if(leading())for(const peer of others())peer.video.pause();});
    item.video.addEventListener('waiting',()=>{if(leading())for(const peer of others())peer.video.pause();});
    item.video.addEventListener('play',playOthers);item.video.addEventListener('playing',playOthers);
  }
  $('hybridPlayPair').onclick=async()=>{const available=Object.values(videos).filter(v=>v.status==='READY');
    linkedPlayback=available.length===2;
    playbackLeader=selectPlaybackLeader(available);
    for(const item of available)item.video.currentTime=0;
    await Promise.all(available.map(v=>v.video.play().catch(()=>{})));};
  let pending=null,pair=null,lastResult=null,lastVideoPoll=0,renderPair=null;
  const requestRun=(mode,pairId=null,benchmark=false)=>{clearControls('operator_stop');p.startJourney(Number($('simpleSpeed').value),mode,pairId,benchmark);};
  const prepareTraffic=()=>{
    lastResult=p.dashboardResult?.operationId;
    const requested=p.population?.requested;
    if(!requested){p.operationError='Traffic data is not ready.';return false;}
    const config=cityPopulation(requested,CITY_PRESETS[$('simpleTraffic').value]);
    // The seed stays internal and is reused by both arms; a new pair receives
    // a new seed. Test seeds and historical comparison protocols are untouched.
    const seed=new Uint32Array(1);crypto.getRandomValues(seed);config.seed=seed[0]%2147483648;
    p.takeControl();return p.dashboardAction('population',config);
  };
  $('simpleChooseDestination').onclick=()=>tools.open('routePanel','simpleChooseDestination');
  $('simpleRun').onclick=()=>{
    if(!p.connected){p.startSimulation();return;}
    if(p.operationError)p.operationError=null;
    if(prepareTraffic())pending={stage:'population',comparison:false};
  };
  $('simpleCompare').onclick=()=>{if(prepareTraffic())pending={stage:'population',comparison:true};};
  $('hybridPlayPair').disabled=true;
  return {update(){
    const active=['STARTING','RUNNING'].includes(p.journey?.status),locked=active||!!p.recording||p.restarting||!!pending;
    const available=p.hybridDriving?.available===true;
    $('simpleRun').textContent=p.connected?'Start driving':'Start simulation';
    $('simpleRun').disabled=p.connected&&(locked||!p.route||!available||p.controlMode==='EMERGENCY_STOP');
    $('simpleCompare').disabled=locked||!p.fresh||!p.route||!available||p.controlMode==='EMERGENCY_STOP';
    $('simpleChooseDestination').disabled=locked||!p.fresh;
    $('simpleSpeed').disabled=$('simpleTraffic').disabled=locked;
    $('simpleDestination').textContent=p.route?.destination?.name||'Choose a destination on the map';
    const actions={FOLLOW:'Following the route',SLOW:'Slowing down',DECELERATE:'Slowing down',EXIT:'Changing lanes',PASS:'Passing an obstacle',RETURN:'Returning to the route',REVERSE:'Repositioning in reverse',HOLD:'Waiting for measured space'};
    let message=p.recordingStatus?.error?demoFailure(p.recordingStatus.error):p.operationError?demoFailure(p.operationError):!available&&p.connected?'Hybrid driving is awaiting native acceptance. Restart uses the existing Ya Rab Ostorha and Normal drivers.':active?'Driving · '+(actions[p.maneuver?.action]||'Following the route'):p.journey?.status==='ARRIVED'?'Destination reached.':p.lastDriveStop?.detail?demoFailure(p.lastDriveStop.detail):'Choose a destination, speed and traffic, then start driving.';
    if(active&&p.stopDiagnostics?.braking&&p.journey?.driving_mode==='HYBRID')message=controlReasonText(p.stopDiagnostics.reason);
    if(p.hybridDriving?.validation_active&&!p.hybridDriving?.accepted)message='Bounded native diagnostic · '+message;
    const result=p.dashboardResult;
    if(pending&&p.operationError){pending=null;pair=null;}
    if(pending&&result?.operationId!==lastResult&&['APPLIED','REJECTED'].includes(result?.status)){
      if(pending.stage==='population'&&result.action==='population'){
        lastResult=result.operationId;
        if(result.status==='REJECTED'){pending=null;}
        else {const comparison=pending.comparison;pending=null;pair=comparison?{stage:'first'}:null;requestRun(comparison?'BASELINE':'HYBRID',null,comparison);}
      }else if(pending.stage==='restore'&&result.action==='prepare_journey_mode'){
        lastResult=result.operationId;const id=pending.id;pending=null;
        if(result.status==='APPLIED'){pair={stage:'second'};requestRun('HYBRID',id,true);}else pair=null;
      }
    }
    if(pair?.stage==='first'&&p.journey?.driving_mode==='BASELINE'&&['ARRIVED','ERROR','PAUSED'].includes(p.journey.status)&&!p.recording&&p.recordingStatus?.finalized!==false){
      if(benchmarkTerminalSupported(p.journey)){
        const id=p.journeyComparison?.pair_id;
        if(id&&p.dashboardAction('prepare_journey_mode',{mode:'HYBRID',pair_id:id})){pending={stage:'restore',id};pair.stage='restoring';}
      }else{pair=null;message='The first attempt ended early. Its result is saved. Start a new comparison.';}
    }
    $('simpleStatus').textContent=message;
    const data=p.journeyComparison,benchmark=data?.version===2;
    panel.hidden=!available;
    results.hidden=!benchmark;$('ordinaryComparison').hidden=benchmark;
    const heading=$('resultsPhase').querySelector('.analysis-heading');
    heading.querySelector('h2').textContent=benchmark?'Comparison results':'Comparison results';
    heading.querySelector('p').textContent=benchmark?'CARLA normal driver and hybrid system':'Your driving, with and without Ya Rab Ostorha.';
    if(benchmark){
      if(renderPair!==data.pair_id){linkedPlayback=false;playbackLeader=null;renderPair=data.pair_id;for(const v of Object.values(videos)){v.video.pause();v.key=null;v.status='MISSING';v.error=null;v.duration_s=null;v.video.removeAttribute('src');}}
      $('hybridPairStatus').textContent=data.conditions_match?'Matching initial conditions verified. Reactive traffic can diverge during the runs.':'The comparison is incomplete or its initial conditions are unverified.';
      for(const mode of benchmarkModes){const run=data.runs?.[mode],item=videos[mode];
        const status={ARRIVED:'Arrived',ERROR:'Failed',PAUSED:'Paused',RUNNING:'Running',STARTING:'Starting'};
        item.box.querySelector('.hybrid-run-result').textContent=run?`${status[run.status]||run.status} · ${run.distance_m.toFixed(1)} m · contacts ${run.collisions} · ${run.route_completion_percent.toFixed(0)}% route completed`:'Not started';
        item.box.querySelector('.hybrid-run-speed').textContent=benchmarkSpeedText(run);
        const root=recordingVideoRoot(run?.recording);
        if(root&&item.status!=='READY'&&performance.now()-lastVideoPoll>2000){
          fetch(root+'video-status.json',{cache:'no-store'}).then(r=>r.ok?r.json():null).then(status=>{
            if(!status||p.journeyComparison?.pair_id!==renderPair)return;
            item.status=status.status;item.error=status.error;item.duration_s=status.duration_s;
            if(status.status==='READY'&&item.key!==root){item.key=root;item.video.src=root+'driving.mp4';}
          }).catch(()=>{});
        }
      }
      if(performance.now()-lastVideoPoll>2000)lastVideoPoll=performance.now();
      $('hybridPlayPair').disabled=!Object.values(videos).every(v=>v.status==='READY');
      const failedVideo=Object.values(videos).find(v=>v.status==='ERROR');
      $('hybridVideoStatus').textContent=failedVideo?'Video export failed · '+demoFailure(failedVideo.error||'The original recording is retained.'):Object.values(videos).every(v=>v.status==='READY')?'Both videos use simulation time and begin at elapsed time zero.':'Video is exported after recording. Failed attempts remain visible.';
    }
  }};
}
