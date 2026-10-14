// Browser-only fixture: all WebSocket actions terminate here.
async(page)=>{
  const snapshot=await(await page.request.get('http://127.0.0.1:8000/api/simulation/state')).json(),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.setViewportSize({width:1440,height:900});
  await page.addInitScript(s=>{
    s.sessionId='motion-fixture';s.controller=false;s.mode='PAUSED';s.type='snapshot';s.connected=true;
    s.motionQuality={coverage_percent:80,unobservable_samples:5,horizons:{1:{samples:20,ade_m:0,fde_m:0,within_threshold_percent:100},2:{samples:12,ade_m:.5,fde_m:1,within_threshold_percent:80},3:{samples:8,ade_m:1,fde_m:2,within_threshold_percent:50}}};
    s.maneuver={action:'CONTINUE',phase:'FOLLOW',reason:'LOWEST_RISK_ADMITTED_PATH',target_speed_kmh:30,front_gap_m:12,rear_gap_m:5,front_ttc_s:null,rear_ttc_s:2,planning_ms:3,rejected:[{action:'CHANGE_LEFT',reason:'SURROUNDING_SPACE_UNKNOWN_OR_OCCUPIED'}],experimental:true};
    window.__motionState=s;window.__motionCommands=[];window.__motionStale=false;
    window.WebSocket=class{readyState=1;constructor(){this.timer=setInterval(()=>{s.vehicle.frame++;s.vehicle.timestamp+=.05;s.world.frame=s.vehicle.frame;s.world.timestamp=s.vehicle.timestamp;this.onmessage?.({data:JSON.stringify(s)});},80);}send(c){window.__motionCommands.push(JSON.parse(c));}close(){clearInterval(this.timer);}};
  },snapshot);
  await page.route('**/api/simulation/perception',r=>r.fulfill({json:{status:'UNAVAILABLE'}}));
  await page.route('**/api/simulation/prediction',async r=>{
    const data=await page.evaluate(()=>({timestamp:window.__motionState.vehicle.timestamp,stale:window.__motionStale}));
    await r.fulfill({json:{status:'RUNNING',prediction:{version:3,session_id:'motion-fixture',coordinate_frame:'EGO_AT_EVALUATION',
      timestamp_s:data.timestamp-(data.stale?2:0),display_source:'MEASURED_KINEMATIC',tracks:[{id:'1',class:'person',confirmed:true,position_m:[8,4],velocity_mps:[1,0],half_size_m:[.3,.3]}],trajectories:[]}}});
  });
  await page.goto('http://127.0.0.1:8000/?mode=guided&rehearsal=1');
  await page.waitForFunction(()=>document.getElementById('motionState')?.textContent==='No predicted intersection');
  await page.locator('#motionReadout summary').click();
  await page.waitForFunction(()=>document.getElementById('motionObjectData')?.textContent.includes('gaze unknown'));
  const text=await page.locator('#motionReadout').innerText();
  if(!text.includes('0.00 m')||!text.includes('Coverage 80.0%')||!text.includes('CHANGE_LEFT'))throw new Error('Numeric quality or rejection reasons missing');
  await page.screenshot({path:'output/playwright/motion-measurements.png'});
  await page.evaluate(()=>window.__motionStale=true);
  await page.waitForFunction(()=>document.getElementById('motionState')?.textContent==='Insufficient data');
  await page.setViewportSize({width:390,height:844});
  if(!(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)))throw new Error('Mobile overflow');
  if(errors.length)throw new Error(JSON.stringify(errors));
  return {passed:true,quality_numbers:true,unknown_gaze:true,rejection_reasons:true,stale_data:true,mobile_overflow:false,native_mutations:0,errors};
}
