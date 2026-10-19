// Run after verify_guided_mission_ui.js. Browser-only command sink; saved MP4s
// retain native provenance, while all session/transition states are fixtures.
async page=>{
  const checks=[],layouts=[],root=new URL(page.url()).origin;
  const check=(value,label)=>{if(!value)throw Error(label);checks.push(label);};
  await page.setViewportSize({width:1440,height:1000});
  await page.evaluate(()=>window.setMissionFixture({connected:true,available:true,mode:'PAUSED',
    simulatorStop:{available:true,status:'IDLE'},journey:{status:'IDLE'}}));
  await page.waitForFunction(()=>document.querySelector('#drivePrimaryAction')?.dataset.action==='START_GUIDED');
  let evidence=await page.evaluate(()=>window.missionEvidence());
  const pageId=evidence.commands.find(c=>c.value?.operation==='PRELOAD').value.page_id;
  const d={guided:true,id:'fixture-preloaded',page_id:pageId,preloaded:true,awaiting_choice:false,
    arm:0,modes:['NORMAL','ROBOSPHERE'],pair_id:'repair-pair'};
  check((await page.locator('#missionChoices').innerText()).includes('يا رب تسترها'),'Project name appears in the mode choice');
  await page.locator('[name=firstDrive][value=ROBOSPHERE]').check();
  const examples=await page.evaluate(async()=>{
    const {previewFrame}=await import('/frontend/preview-story.js');
    return {normal:previewFrame('NORMAL',4),project:previewFrame('ROBOSPHERE',4)};
  });
  check(examples.normal.contact&&!examples.project.contact&&examples.project.phase==='stopped','Illustration distinguishes late reactive braking from early prediction');
  await page.screenshot({path:'output/playwright/repair-choices.png',fullPage:true});
  await page.locator('#drivePrimaryAction').dblclick();
  evidence=await page.evaluate(()=>window.missionEvidence());
  check(evidence.commands.filter(c=>c.value?.operation==='START_GUIDED').length===1,'Repeated Start dispatches exactly one selected drive');
  check(evidence.commands.find(c=>c.value?.operation==='START_GUIDED').value.speed_kmh===120,'Guided Start requests 120 km/h');
  for(const status of ['SELECTING','READY','STARTING']){
    await page.evaluate(d=>window.setMissionFixture({presentation:d}),{...d,status});
    await page.waitForFunction(()=>document.querySelector('#drivePrimaryAction').getAttribute('aria-busy')==='true');
    check(await page.locator('#drivePrimaryAction').isVisible()&&await page.locator('#drivePrimaryAction').isDisabled(),'Start remains visible and disabled in '+status);
    const loader=await page.locator('#drivePrimaryAction').evaluate(el=>({animation:getComputedStyle(el,'::after').animationName,detail:document.querySelector('#missionDetail').textContent}));
    check(loader.animation==='mission-spinner'&&loader.detail.length>15,'Continuous loader and actual stage text in '+status);
  }
  await page.emulateMedia({reducedMotion:'reduce'});
  check(await page.locator('#drivePrimaryAction').evaluate(el=>getComputedStyle(el,'::after').animationName)==='none','Reduced motion keeps a static loading indicator');
  await page.emulateMedia({reducedMotion:'no-preference'});
  await page.evaluate(d=>window.setMissionFixture({presentation:{...d,status:'DRIVING'},mode:'AUTOMATIC',
    journey:{status:'RUNNING',driving_mode:'ROBOSPHERE',speed_kmh:120}}),d);
  await page.waitForFunction(()=>document.body.dataset.mission==='driving');
  await page.getByRole('button',{name:'Menu',exact:true}).click();await page.keyboard.press('Escape');
  check(await page.locator('#drivePrimaryAction').isVisible(),'Opening and closing Menu keeps the driving surface');
  await page.evaluate(d=>window.setMissionFixture({presentation:{...d,status:'DRIVING',page_id:'other-page'}}),d);
  await page.waitForFunction(()=>document.querySelector('#missionTitle').textContent.includes('another page'));
  const afterObserver=await page.evaluate(()=>window.missionEvidence());
  check(afterObserver.commands.filter(c=>c.value?.operation==='PRELOAD').length===1,'An observing page does not automatically replace an active presentation');
  // Real recorded videos, with isolated session identity and delayed export state.
  const nativePair=await (await page.request.get(root+'/output/journey-comparisons/latest.json')).json();
  check(!!nativePair.runs.NORMAL?.recording&&!!nativePair.runs.ROBOSPHERE?.recording,'Retained native recordings available for media QA');
  const pair={...nativePair,pair_id:d.pair_id,version:6};
  let exportsReady=false;
  await page.route('**/runs/normal_city/*/video-status.json',async route=>{
    if(!exportsReady)return route.fulfill({json:{status:'ENCODING_ANNOTATION'}});
    return route.continue();
  });
  await page.evaluate(({d,pair})=>window.setMissionFixture({mode:'PAUSED',journey:{status:'PAUSED'},
    presentation:{...d,status:'RESULTS',arm:1},journeyComparison:pair}),{d,pair});
  await page.getByRole('button',{name:'Finish',exact:true}).waitFor({state:'visible'});
  check(await page.locator('#missionOutcomes video').count()===2,'Both result video elements are on the primary result screen');
  check(await page.locator('#missionOutcomes .video-preparing:visible').count()===2,'Each pending export has its own preparation placeholder');
  check(await page.locator('#missionOutcomes .video-download:visible').count()===0,'Pending exports do not expose download links from an older comparison');
  const beforeRefresh=await page.evaluate(()=>window.missionEvidence());
  await page.reload({waitUntil:'domcontentloaded'});
  await page.getByRole('button',{name:'Finish',exact:true}).waitFor({state:'visible'});
  const afterRefresh=await page.evaluate(()=>window.missionEvidence());
  check(afterRefresh.commands.filter(c=>c.type==='stop_driving').length===beforeRefresh.commands.filter(c=>c.type==='stop_driving').length,
    'Refreshing held results sends no stop or cancellation command');
  await page.getByRole('button',{name:'Finish',exact:true}).dblclick();
  evidence=await page.evaluate(()=>window.missionEvidence());
  check(evidence.commands.filter(c=>c.value?.operation==='FINISH').length===1,'Repeated Finish dispatches once');
  await page.evaluate(d=>window.setMissionFixture({presentation:{...d,status:'FINISHING',arm:1,finish_requested:true}}),d);
  await page.waitForFunction(()=>document.querySelector('#drivePrimaryAction').getAttribute('aria-busy')==='true');
  check(await page.locator('#missionOutcomes video').count()===2,'Both videos remain during Finish while exports are pending');
  exportsReady=true;
  await page.waitForFunction(()=>[...document.querySelectorAll('#missionOutcomes video')].every(v=>v.readyState>=1),{timeout:30000});
  await page.evaluate(d=>window.setMissionFixture({connected:false,available:false,mode:'DISCONNECTED',
    simulatorStop:{available:true,status:'STOPPED',process_exited:true},
    presentation:{...d,status:'COMPLETE',arm:1,finish_requested:true,completed_pair_id:d.pair_id}}),d);
  await page.getByRole('button',{name:'Start a new drive',exact:true}).waitFor({state:'visible'});
  check(await page.locator('#missionOutcomes video').count()===2,'Results remain on screen with the simulator stopped');
  const labels=await page.locator('#missionOutcomes article h3').allTextContents();
  check(labels.join('|')==='Normal|يا رب تسترها','Mode names appear underneath their videos');
  for(const [width,height] of [[1440,1000],[390,844],[320,740]]){
    await page.setViewportSize({width,height});
    await page.locator('#presentationResults').scrollIntoViewIfNeeded();
    const fit=await page.locator('#presentationResults').evaluate(el=>({left:el.getBoundingClientRect().left,right:el.getBoundingClientRect().right,scroll:document.documentElement.scrollWidth,width:innerWidth}));
    check(fit.left>=0&&fit.right<=width+1&&fit.scroll<=width+1,'Results fit '+width+'px without horizontal overflow');
    layouts.push({width,...fit});
    await page.evaluate(()=>{document.activeElement.blur();scrollTo(0,0);});
    await page.screenshot({path:`output/playwright/repair-results-${width}.png`,fullPage:true});
  }
  await page.setViewportSize({width:1440,height:1000});
  await page.getByRole('button',{name:'Replay both',exact:true}).click();
  await page.waitForFunction(()=>[...document.querySelectorAll('#missionOutcomes video')].every(v=>v.currentTime>0));
  check(true,'Saved native MP4s actually play on the primary result surface');
  await page.reload({waitUntil:'domcontentloaded'});
  await page.getByRole('button',{name:'Start a new drive',exact:true}).waitFor({state:'visible'});
  check(await page.locator('#missionOutcomes video').count()===2,'Refreshing the stopped page restores the saved comparison');
  evidence=await page.evaluate(()=>window.missionEvidence());
  check(evidence.errors.length===0,'No browser exceptions across loading, driving, Finish, playback and refresh');
  return {scope:'ISOLATED_UI_TRANSITIONS_WITH_RETAINED_NATIVE_MP4S',checks,layouts,errors:evidence.errors};
}
