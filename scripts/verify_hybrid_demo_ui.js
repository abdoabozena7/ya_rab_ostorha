// Run after verify_processing_recovery_ui.js in the same isolated session.
// Every socket and native API is intercepted by that rehearsal. This test does
// not operate CARLA or establish behavioral acceptance.
async (page)=>{
  const checks=[],errors=[];page.on('pageerror',e=>errors.push(e.message));
  const check=(value,label)=>{if(!value)throw new Error(label);checks.push(label);};
  await page.evaluate(()=>{
    const f=window.__redesign,s=f.state;
    s.hybridDriving={available:true,accepted:true,accepted_speed_kmh:50};s.mode='PAUSED';s.controller=true;
    s.journey={status:'IDLE'};s.lastDriveStop=null;s.route=window.__makeRoute();s.recording=false;s.recordingStatus={finalized:true};
    s.vehicle.speedKmh=s.vehicle.speedMps=0;s.dashboardResult={action:'population',status:'APPLIED',operationId:'old-population'};
    const original=window.WebSocket.prototype.send;
    window.WebSocket.prototype.send=function(raw){const c=JSON.parse(raw);original.call(this,raw);
      if(c.type==='population'){
        s.population.requested={...c.value};s.dashboardResult={action:'population',status:'PENDING',operationId:'pending-population-'+(++f.op)};
        setTimeout(()=>{s.dashboardResult={action:'population',status:'APPLIED',operationId:'new-population-'+f.op};},250);
      }
      if(c.type==='start_journey'){
        const pair=c.pair_id||'hybrid-fixture-pair';
        if(!c.pair_id)s.journeyComparison={version:2,pair_id:pair,conditions_match:false,runs:{}};
        s.journeyComparison.runs[c.driving_mode]={id:c.driving_mode,mode:c.driving_mode,status:'RUNNING',distance_m:0,collisions:0,route_completion_percent:0,
          recording:'D:/projects/Ai/ya_rab_ostorha/runs/normal_city/run_'+(c.driving_mode==='BASELINE'?'a':'b').repeat(32)};
      }
    };
    f.commands=[];
  });
  await page.setViewportSize({width:1440,height:900});
  await page.locator('#simpleRun').waitFor({state:'visible'});
  await page.locator('#simpleSpeed').selectOption('50');await page.locator('#simpleTraffic').selectOption('CHAOTIC');
  await page.locator('#simpleRun').click();
  await page.waitForFunction(()=>window.__redesign.commands.some(c=>c.type==='start_journey'&&c.driving_mode==='HYBRID'));
  check(await page.evaluate(()=>window.__redesign.commands.find(c=>c.type==='start_journey').speed_kmh===50),'Requested 50 is sent to the hybrid interface');
  check(await page.locator('#simpleSpeed').isDisabled(),'Speed is locked while a recorded journey runs');
  check(await page.locator('#studioManualStop').isVisible(),'Stop remains visible during driving');
  await page.locator('#studioManualStop').click();
  await page.evaluate(()=>{window.__redesign.commands=[];window.__redesign.state.lastDriveStop=null;});
  await page.locator('#simpleCompare').click();
  await page.waitForFunction(()=>window.__redesign.commands.some(c=>c.type==='start_journey'&&c.driving_mode==='BASELINE'));
  const seed=await page.evaluate(()=>window.__redesign.state.population.requested.seed);
  check(Number.isInteger(seed),'Comparison seed is internal');
  await page.evaluate(()=>{const s=window.__redesign.state;s.mode='PAUSED';s.journey={...s.journey,status:'ARRIVED'};s.recording=false;s.vehicle.speedKmh=s.vehicle.speedMps=0;
    s.journeyComparison.runs.BASELINE.status='ARRIVED';s.journeyComparison.runs.BASELINE.distance_m=100;s.journeyComparison.runs.BASELINE.route_completion_percent=100;});
  await page.waitForFunction(()=>window.__redesign.commands.some(c=>c.type==='start_journey'&&c.driving_mode==='HYBRID'));
  check(await page.evaluate(()=>window.__redesign.commands.some(c=>c.type==='prepare_journey_mode'&&c.value.mode==='HYBRID'&&c.value.pair_id==='hybrid-fixture-pair')),'Second arm restores the saved pair');
  check(await page.evaluate(()=>window.__redesign.state.population.requested.seed)===seed,'Both arms retain the same seed');
  check(await page.locator('#hybridResults').count()===1,'Separate native-baseline results exist');
  await page.locator('#emergencyStopBtn').click();await page.locator('#acknowledgeStopBtn').waitFor({state:'visible'});
  check(await page.locator('#simpleRun').isDisabled(),'Emergency locks simple start');
  await page.locator('#acknowledgeStopBtn').click();
  await page.evaluate(()=>{window.__redesign.state.hybridDriving={available:false,accepted:false};});
  await page.waitForFunction(()=>document.getElementById('simpleStatus').textContent.includes('قيد التحقق'));
  check(await page.locator('#simpleRun').isDisabled(),'Unaccepted native capability is not silently enabled');
  for(const width of [1440,390]){
    await page.setViewportSize({width,height:900});
    check(await page.locator('#simpleDrive').evaluate(n=>{const r=n.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1;}),'Simple controls fit '+width);
    await page.screenshot({path:'output/playwright/hybrid-demo-fixture-'+width+'.png',fullPage:true});
  }
  check(errors.length===0,'No browser runtime errors');
  return {source:'ISOLATED_BROWSER_FIXTURE',checks:checks.length,errors};
}
