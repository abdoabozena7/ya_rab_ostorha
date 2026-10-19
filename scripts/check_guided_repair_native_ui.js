// Explicit, authorized native comparison. Uses visible controls; retains every
// sampled outcome. Finish must close CARLA before the playback/refresh checks.
async page=>{
  const root='http://127.0.0.1:8000',checks=[],samples=[],events=[],errors=[];
  const first=new URL(page.url()).searchParams.get('first')||'ROBOSPHERE';
  page.on('pageerror',error=>errors.push(error.message));
  await page.setViewportSize({width:1600,height:1000});
  const check=(value,label)=>{if(!value)throw Error(label);checks.push(label);};
  const state=async()=>await (await page.request.get(root+'/api/simulation/state',{timeout:15000})).json();
  let previousPhase=null;
  const capture=async()=>{
    const s=await state(),d=s.presentation||{};
    if(d.status!==previousPhase){events.push({status:d.status,arm:d.arm,reason:d.reason});previousPhase=d.status;}
    if(d.status==='DRIVING')samples.push({frame:s.vehicle?.frame,timestamp:s.vehicle?.timestamp,arm:d.arm,
      speed_kmh:s.vehicle?.speedKmh,stop:s.stopDiagnostics,performance:s.performance});
    return s;
  };
  const wait=async predicate=>{
    for(let attempt=0;attempt<100;attempt++){
      let s;
      try{s=await capture();}catch(error){
        if(!/ECONNREFUSED|ECONNRESET|socket hang up/.test(error.message))throw error;
        await page.waitForTimeout(1000);continue;
      }
      if(predicate(s))return s;
      if(s.presentation?.status==='ERROR')throw Error(JSON.stringify(s.presentation));
      await page.waitForTimeout(1000);
    }
    throw Error('Native state did not confirm');
  };
  await page.goto(root+'/?verification=guided-repair-native',{waitUntil:'domcontentloaded'});
  const initial=await state();
  if(initial.presentation?.status==='COMPLETE'){
    await page.getByRole('button',{name:'Start a new drive',exact:true}).waitFor({state:'visible'});
    await page.getByRole('button',{name:'Start a new drive',exact:true}).click();
  }
  let s=await wait(s=>s.presentation?.status==='CHOOSING');
  if(await page.locator('#drivePrimaryAction').getAttribute('data-action')==='PREPARE_HERE'){
    await page.locator('#drivePrimaryAction').click();s=await wait(s=>s.presentation?.status==='CHOOSING');
  }
  const identity=s.presentation.id;
  await page.locator(`[name=firstDrive][value=${first}]`).check();
  await page.locator('#drivePrimaryAction').click();
  for(let arm=0;arm<2;arm++){
    s=await wait(s=>s.presentation?.arm===arm&&['DRIVING','AWAITING_NEXT','RESULTS'].includes(s.presentation.status));
    if(arm===0&&s.presentation.status==='DRIVING'){
      const observer=await page.context().newPage();
      try{
        await observer.goto(root+'/?verification=observe-native',{waitUntil:'domcontentloaded'});
        await observer.waitForTimeout(2000);
        const observed=await state();
        check(observed.presentation.id===identity&&observed.journey.status==='RUNNING','Opening another native page preserves the active drive');
      }finally{await observer.close();await page.bringToFront();}
    }
    const started=Date.now();
    while(s.presentation.status==='DRIVING'&&Date.now()-started<30000){
      await page.waitForTimeout(1500);s=await capture();
    }
    await page.screenshot({path:`output/playwright/repair-native-arm-${arm}.png`,fullPage:true});
    const p=s.presentation.status;
    if(['DRIVING','AWAITING_NEXT'].includes(p))await page.locator('#drivePrimaryAction').click();
    else if(p==='FINALIZING')s=await wait(s=>['AWAITING_NEXT','RESULTS'].includes(s.presentation?.status));
    if(arm===0){
      s=await wait(s=>s.presentation?.arm===1||s.presentation?.status==='AWAITING_NEXT');
      if(s.presentation.status==='AWAITING_NEXT')await page.locator('#drivePrimaryAction').click();
    }
  }
  s=await wait(s=>s.presentation?.status==='RESULTS');
  const pair=s.journeyComparison;
  check(Object.values(pair.runs).every(run=>!['ERROR','INTERRUPTED'].includes(run.status)),'Both native drives complete their requested recording interval without a technical interruption');
  check(Object.values(pair.runs).every(run=>run.setup.speed_kmh===120),'Both native arms recorded a requested 120 km/h');
  check(Object.values(pair.runs).every(run=>run.driver_profile.sensor_obstacle_braking),'Both arms retain sensor braking');
  check(pair.runs.ROBOSPHERE.driver_profile.motion_prediction_used&&!pair.runs.NORMAL.driver_profile.motion_prediction_used,'Only the project arm uses motion prediction');
  const finishExportStatuses={};
  for(const [mode,run] of Object.entries(pair.runs)){
    const runName=run.recording.replaceAll('\\','/').split('/').at(-1);
    const response=await page.request.get(root+'/runs/normal_city/'+runName+'/video-status.json');
    finishExportStatuses[mode]=response.ok()?(await response.json()).status:'PENDING';
  }
  await page.reload({waitUntil:'domcontentloaded'});
  await page.getByRole('button',{name:'Finish',exact:true}).waitFor({state:'visible'});
  check((await state()).presentation.id===identity,'Refreshing results before Finish preserves the comparison');
  await page.getByRole('button',{name:'Finish',exact:true}).click();
  check(await page.locator('#missionOutcomes video').count()===2,'Native result videos stay mounted after Finish');
  // The old SDK host retires before the stopped host returns. Read through that
  // expected transport handoff without inventing a second presentation.
  let stopped=null;
  for(let attempt=0;attempt<180;attempt++){
    try{
      stopped=await state();
      if(stopped.simulatorStop?.status==='STOPPED')break;
      if(stopped.presentation?.finish_error)throw Error(stopped.presentation.finish_error);
    }catch(error){if(error.message.includes('original recordings'))throw error;}
    await page.waitForTimeout(1000);
  }
  check(stopped?.simulatorStop?.status==='STOPPED'&&stopped.simulatorStop.process_exited===true,'Finish verifies CARLA process exit');
  check(stopped.presentation.id===identity&&stopped.presentation.completed_pair_id===pair.pair_id,'Stopped backend retains the completed comparison reference');
  await page.getByRole('button',{name:'Start a new drive',exact:true}).waitFor({state:'visible',timeout:45000});
  await page.getByRole('button',{name:'Replay both',exact:true}).click();
  await page.waitForFunction(()=>[...document.querySelectorAll('#missionOutcomes video')].every(v=>v.currentTime>0),{timeout:30000});
  check(true,'Both native recordings play after CARLA exits');
  await page.reload({waitUntil:'domcontentloaded'});
  await page.getByRole('button',{name:'Start a new drive',exact:true}).waitFor({state:'visible'});
  await page.waitForFunction(()=>[...document.querySelectorAll('#missionOutcomes video')].every(v=>v.readyState>=1));
  check(await page.locator('#missionOutcomes video').count()===2,'Refresh restores both playable recordings with CARLA stopped');
  await page.evaluate(()=>scrollTo(0,0));
  await page.screenshot({path:'output/playwright/repair-native-results-stopped.png',fullPage:true});
  check(errors.length===0,'Native browser has no JavaScript exceptions');
  return {scope:'LIVE_NATIVE_GUIDED_120_REQUEST_LIFECYCLE',checks,pair,events,finishExportStatuses,samples,errors};
}
