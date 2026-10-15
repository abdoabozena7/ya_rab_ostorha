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
  return `السرعة كم/س: متوسط ${measured(run.mean_speed_kmh)} · أقصى ${measured(run.maximum_speed_kmh)} · المطلوب ${requested}`;
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
  if(/benchmark.*mismatch|initial.conditions/i.test(reason))return 'تعذرت مطابقة بداية المشوارين. أعد تشغيل المقارنة من البداية.';
  if(reason==='collision')return 'حدث تلامس فتوقف المشوار. أعد تهيئة المحاكاة قبل المحاولة التالية.';
  if(/acceptance|unfinished/i.test(reason))return 'التحقق الحركي للهجين لم يكتمل. تفاصيل الاختبارات متاحة في النتائج.';
  if(/no space left|not enough.*space|insufficient.*space|storage|disk|ENOSPC/i.test(reason))return 'التسجيل يحتاج مساحة متاحة. احتفظ بالأرشيف ثم وفّر مساحة وأعد المحاولة.';
  if(/recording.*queue|queue.*exhaust/i.test(reason))return 'حفظ التسجيل أبطأ من وصول البيانات. أوقف العرض الإضافي ثم أعد المحاولة.';
  if(/recording/i.test(reason))return 'التسجيل لم يكتمل. المحاولة محفوظة؛ أعد تهيئة المحاكاة قبل مشوار جديد.';
  if(/sensor|scene|freshness/i.test(reason))return 'بيانات الحركة غير جاهزة. أوقف السيارة ثم أعد تهيئة المحاكاة.';
  if(/heartbeat|connection|disconnected/i.test(reason))return 'الاتصال انقطع. أعد الاتصال ثم اضغط تشغيل.';
  if(reason==='focus_lost')return 'توقفت القيادة عند إخفاء الصفحة. اضغط تشغيل للمتابعة.';
  if(reason==='operator_stop')return 'تم إيقاف السيارة. يمكنك بدء مشوار جديد.';
  return String(reason);
}

export function installDemoDrive(p,tools,clearControls) {
  document.body.classList.add('demo-drive');
  const panel=document.createElement('section');panel.id='simpleDrive';panel.dir='rtl';
  panel.setAttribute('aria-label','تشغيل القيادة');
  panel.innerHTML='<div class="simple-route"><span>الوجهة</span><strong id="simpleDestination">اختر وجهة على الخريطة</strong><button id="simpleChooseDestination">اختيار الوجهة</button></div><label>السرعة المطلوبة<select id="simpleSpeed"><option value="20">20 كم/س</option><option value="30" selected>30 كم/س</option><option value="40">40 كم/س</option><option value="50">50 كم/س</option></select></label><label>الزحمة<select id="simpleTraffic"><option value="CALM">خفيفة</option><option value="BUSY" selected>متوسطة</option><option value="CHAOTIC">كثيفة</option></select></label><div class="simple-actions"><button id="simpleRun" class="primary">تشغيل</button><button id="simpleCompare">تشغيل المقارنة</button></div><p id="simpleStatus" role="status">اختر الوجهة والسرعة، ثم شغّل القيادة.</p>';
  $('cameraCard').before(panel);
  const results=document.createElement('section');results.id='hybridResults';results.dir='rtl';
  results.innerHTML='<div class="hybrid-results-heading"><div><h2>السائق العادي والنظام الهجين</h2><p id="hybridPairStatus">المقارنة تستخدم نفس البداية والطريق والسرعة والمرور.</p></div><button id="hybridPlayPair">تشغيل الفيديوهين</button></div><div class="hybrid-videos"></div><p id="hybridVideoStatus" role="status"></p>';
  $('resultsPhase').querySelector('.analysis-heading').after(results);
  const videos={};
  for(const mode of benchmarkModes){const box=document.createElement('article');box.innerHTML='<h3>'+(mode==='BASELINE'?'سائق CARLA العادي':'النظام الهجين')+'</h3><video controls playsinline preload="metadata"></video><p class="hybrid-run-result">لم يبدأ</p><p class="hybrid-run-result hybrid-run-speed"></p>';
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
    if(!requested){p.operationError='بيانات المرور غير جاهزة.';return false;}
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
    $('simpleRun').textContent=p.connected?'تشغيل القيادة':'تشغيل المحاكاة';
    $('simpleRun').disabled=p.connected&&(locked||!p.route||!available||p.controlMode==='EMERGENCY_STOP');
    $('simpleCompare').disabled=locked||!p.fresh||!p.route||!available||p.controlMode==='EMERGENCY_STOP';
    $('simpleChooseDestination').disabled=locked||!p.fresh;
    $('simpleSpeed').disabled=$('simpleTraffic').disabled=locked;
    $('simpleDestination').textContent=p.route?.destination?.name||'اختر وجهة على الخريطة';
    const actions={FOLLOW:'اتباع الطريق',SLOW:'تهدئة',DECELERATE:'تهدئة',EXIT:'تغيير الحارة',PASS:'تجاوز عائق',RETURN:'العودة للمسار',REVERSE:'إعادة تمركز للخلف',HOLD:'انتظار مساحة للحركة'};
    let message=p.recordingStatus?.error?demoFailure(p.recordingStatus.error):p.operationError?demoFailure(p.operationError):!available&&p.connected?'القيادة الهجينة قيد التحقق الحركي؛ نتائج الاختبارات لا تُعتبر قبولًا تلقائيًا.':active?'القيادة تعمل · '+(actions[p.maneuver?.action]||'اتباع الطريق'):p.journey?.status==='ARRIVED'?'وصلت السيارة إلى الوجهة.':p.lastDriveStop?.detail?demoFailure(p.lastDriveStop.detail):'اختر الوجهة والسرعة والزحمة، ثم شغّل القيادة.';
    if(active&&p.stopDiagnostics?.braking&&p.journey?.driving_mode==='HYBRID')message=controlReasonText(p.stopDiagnostics.reason);
    if(p.hybridDriving?.validation_active&&!p.hybridDriving?.accepted)message='اختبار حركي محدود المدة · '+message;
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
      }else{pair=null;message='المحاولة الأولى لم تكتمل؛ نتيجتها محفوظة. أعد المقارنة من البداية.';}
    }
    $('simpleStatus').textContent=message;
    const data=p.journeyComparison,benchmark=data?.version===2;
    results.hidden=!benchmark;$('ordinaryComparison').hidden=benchmark;
    const heading=$('resultsPhase').querySelector('.analysis-heading');
    heading.querySelector('h2').textContent=benchmark?'نتائج المقارنة':'Comparison results';
    heading.querySelector('p').textContent=benchmark?'سائق CARLA العادي والنظام الهجين':'Your driving, with and without Robosphere.';
    if(benchmark){
      if(renderPair!==data.pair_id){linkedPlayback=false;playbackLeader=null;renderPair=data.pair_id;for(const v of Object.values(videos)){v.video.pause();v.key=null;v.status='MISSING';v.error=null;v.duration_s=null;v.video.removeAttribute('src');}}
      $('hybridPairStatus').textContent=data.conditions_match?'تم التحقق من تطابق ظروف البداية. المرور يتفاعل أثناء كل محاولة.':'المقارنة غير مكتملة أو لم تثبت مطابقة البداية.';
      for(const mode of benchmarkModes){const run=data.runs?.[mode],item=videos[mode];
        const status={ARRIVED:'وصل',ERROR:'توقف بسبب خطأ',PAUSED:'متوقف',RUNNING:'يعمل',STARTING:'يبدأ'};
        item.box.querySelector('.hybrid-run-result').textContent=run?`${status[run.status]||run.status} · ${run.distance_m.toFixed(1)} متر · تلامس ${run.collisions} · ${run.route_completion_percent.toFixed(0)}% من الطريق`:'لم يبدأ';
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
      $('hybridVideoStatus').textContent=failedVideo?'تعذر تجهيز الفيديو · '+demoFailure(failedVideo.error||'التسجيل الأصلي محفوظ.'):Object.values(videos).every(v=>v.status==='READY')?'الفيديوهات تستخدم توقيت المحاكاة، ويبدأ كل مشوار من الزمن صفر.':'الفيديو يُجهّز بعد انتهاء التسجيل. المحاولات الفاشلة تظل محفوظة.';
    }
  }};
}
