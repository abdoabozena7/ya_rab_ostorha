// Isolated UI states and a routed media fixture. Native acceptance is separate.
async page=>{
  const root=await page.evaluate(()=>location.origin),checks=[],layouts=[];
  const check=(value,label)=>{if(!value)throw Error(label);checks.push(label);};
  await page.setViewportSize({width:1440,height:1000});
  await page.evaluate(()=>window.setMissionFixture({connected:true,available:true,mode:'PAUSED',journey:{status:'IDLE'},simulatorStop:{available:true,status:'IDLE'}}));
  await page.waitForFunction(()=>document.querySelector('#drivePrimaryAction')?.dataset.action==='START_GUIDED');
  let evidence=await page.evaluate(()=>window.missionEvidence());
  const pageId=evidence.commands.find(c=>c.value?.operation==='PRELOAD').value.page_id;
  const d={guided:true,automatic_pair:true,id:'fixture-crossing',page_id:pageId,preloaded:true,awaiting_choice:false,arm:0,modes:['NORMAL','ROBOSPHERE'],pair_id:'fixture-pair'};
  check((await page.locator('#missionChoices').innerText()).includes('Ya Rab Ostorha'),'Mode name matches the English project title');
  await page.locator('#drivePrimaryAction').dblclick();
  evidence=await page.evaluate(()=>window.missionEvidence());
  check(evidence.commands.filter(c=>c.value?.operation==='START_GUIDED').length===1,'Duplicate Start dispatches once');
  await page.evaluate(d=>window.setMissionFixture({presentation:{...d,status:'STARTING'},mode:'PAUSED',journey:{status:'STARTING'}}),d);
  await page.waitForFunction(()=>document.querySelector('#drivePrimaryAction')?.disabled);
  const startLabel=await page.locator('#drivePrimaryAction').innerText();
  await page.evaluate(()=>window.setMissionFixture({available:false,connected:false}));
  await page.evaluate(()=>window.setMissionFixture({available:true,connected:true}));
  check(await page.locator('#drivePrimaryAction').innerText()===startLabel,'Slow loading and reconnect keep the Start label stable');
  for(const mode of ['NORMAL','ROBOSPHERE']){
    await page.evaluate(({d,mode})=>window.setMissionFixture({presentation:{...d,status:'DRIVING',arm:mode==='NORMAL'?0:1},mode:'AUTOMATIC',journey:{status:'RUNNING',driving_mode:mode,speed_kmh:120}}),{d,mode});
    await page.waitForFunction(()=>document.body.dataset.mission==='driving');
    check(await page.locator('#drivePrimaryAction').isHidden(),'No shortening action during '+mode);
  }
  await page.evaluate(()=>{window.dispatchEvent(new Event('blur'));document.dispatchEvent(new Event('visibilitychange'));window.dispatchEvent(new Event('pagehide'));});
  await page.reload({waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>document.body.dataset.mission==='driving');
  evidence=await page.evaluate(()=>window.missionEvidence());
  check(evidence.commands.filter(c=>c.value?.operation==='START_GUIDED').length===1,'Reload during automatic driving does not start another comparison');
  check(!evidence.commands.some(c=>c.value?.operation==='CANCEL'||c.type==='stop_driving'||c.type==='release_controls'||c.type==='controls'),'Focus loss and page reload preserve automatic driving');
  const nativePair=await (await page.request.get(root+'/output/journey-comparisons/a9b856ca31d4433ab783b0cb3973cd43.json')).json();
  const pair={...nativePair,pair_id:d.pair_id,version:6,manifest:{...nativePair.manifest,comparison_scenario:{id:'UI_FIXTURE'}},
    shared_perception:{status:'ENCODING',recording:nativePair.runs.NORMAL.recording,video:'shared-perception.mp4'}};
  let exportsReady=false;
  await page.route('**/runs/normal_city/*/video-status.json',async route=>{
    if(!exportsReady)return route.fulfill({json:{status:'ENCODING_ANNOTATION'}});
    return route.continue();
  });
  const normalRoot='/'+nativePair.runs.NORMAL.recording.replaceAll('\\','/').split('/runs/')[1];
  // Explicit media fixture for UI playback; never a native common-prefix claim.
  const media=await (await page.request.get(root+'/runs/'+normalRoot.slice(1)+'/'+ 'driving.mp4')).body();
  await page.route('**/shared-perception.mp4',route=>route.fulfill({body:media,contentType:'video/mp4'}));
  await page.evaluate(({d,pair})=>window.setMissionFixture({presentation:{...d,status:'RESULTS',arm:1},mode:'PAUSED',journey:{status:'PAUSED'},journeyComparison:pair}),{d,pair});
  await page.getByRole('button',{name:'Finish',exact:true}).waitFor({state:'visible'});
  check(await page.locator('#missionOutcomes video').count()===3,'Three result videos exist');
  check(await page.locator('#missionOutcomes .video-preparing:visible').count()===3,'All exports have independent placeholders');
  await page.getByRole('button',{name:'Finish',exact:true}).dblclick();
  evidence=await page.evaluate(()=>window.missionEvidence());
  check(evidence.commands.filter(c=>c.value?.operation==='FINISH').length===1,'Finish is idempotent during export');
  await page.evaluate(d=>window.setMissionFixture({presentation:{...d,status:'FINISHING',arm:1,finish_requested:true}}),d);
  check(await page.locator('#sharedPerception').isVisible(),'Shared video remains while saving and closing');
  exportsReady=true;pair.shared_perception={...pair.shared_perception,status:'READY',duration_s:1.};
  await page.evaluate(({d,pair})=>window.setMissionFixture({connected:false,available:false,mode:'DISCONNECTED',simulatorStop:{available:true,status:'STOPPED',process_exited:true},
    presentation:{...d,status:'COMPLETE',arm:1,finish_requested:true,completed_pair_id:d.pair_id,shared_perception:pair.shared_perception},journeyComparison:pair}),{d,pair});
  await page.getByRole('button',{name:'Start a new drive',exact:true}).waitFor({state:'visible'});
  await page.waitForFunction(()=>[...document.querySelectorAll('#missionOutcomes video')].every(v=>v.readyState>=1),{timeout:30000});
  check((await page.locator('#missionOutcomes article h3').allTextContents()).join('|')==='Normal|Ya Rab Ostorha','Names sit underneath the correct videos');
  for(const [width,height] of [[1440,1000],[390,844],[320,740]]){
    await page.setViewportSize({width,height});
    await page.evaluate(()=>{document.activeElement?.blur();scrollTo(0,0);});
    const fit=await page.evaluate(()=>{const top=document.querySelector('#sharedPerception').getBoundingClientRect(),lower=document.querySelector('.presentation-videos').getBoundingClientRect();return {width:innerWidth,scroll:document.documentElement.scrollWidth,topBottom:top.bottom,lowerTop:lower.top};});
    check(fit.scroll<=width+1&&fit.topBottom<=fit.lowerTop+1,'Shared intro above the pair, without overflow at '+width+'px');layouts.push(fit);
    await page.screenshot({path:`output/playwright/crossing-results-${width}.png`,fullPage:true});
  }
  await page.setViewportSize({width:1440,height:1000});
  await page.getByRole('button',{name:'Replay both',exact:true}).click();
  await page.locator('#sharedPerception video').evaluate(v=>v.play());
  await page.waitForFunction(()=>[...document.querySelectorAll('#missionOutcomes video')].every(v=>v.currentTime>0));
  check(true,'All three media elements play with CARLA stopped');
  await page.reload({waitUntil:'domcontentloaded'});
  await page.getByRole('button',{name:'Start a new drive',exact:true}).waitFor({state:'visible'});
  check(await page.locator('#sharedPerception').isVisible(),'Refresh retains the complete three-video result');
  evidence=await page.evaluate(()=>window.missionEvidence());check(evidence.errors.length===0,'No browser exceptions');
  return {scope:'ISOLATED_UI_STATES_AND_EXPLICIT_MEDIA_FIXTURE_NOT_NATIVE_ACCEPTANCE',checks,layouts};
}
