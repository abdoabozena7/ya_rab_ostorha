async page=>{
  const root=new URL(page.url()).origin,checks=[];
  const observed=await (await page.request.get(root+'/output/guided-ui-20261018/observed-state.json')).json();
  const v=observed.vehicle,reference={position_m:v.positionWorldM,rotation_rad:Object.fromEntries(
    Object.entries(v.rotationDeg).map(([k,value])=>[k,value*Math.PI/180]))};
  let available=true;
  await page.route('**/api/simulation/prediction*',async route=>{
    const frame=Number(await page.locator('#frameVal').textContent())-5,timestamp=1+(frame-100)*.05;
    const tracks=[{id:'pedestrian',confirmed:true,class:'person',semantic_evidence:{source_sensor:'frontCamera'},position_m:[17,3],velocity_mps:[0,-1],half_size_m:[.35,.35]},
      {id:'vehicle',confirmed:true,class:'car',semantic_evidence:{source_sensor:'frontCamera'},position_m:[25,-2],velocity_mps:[5,0],half_size_m:[2,1]}];
    const trajectories=[{track_id:'pedestrian',source:'PEDESTRIAN_POSSIBLE_START',points:[[0,17,3],[1,17,2],[2,17,0],[3,17,-1]]},
      {track_id:'vehicle',source:'CONSTANT_VELOCITY',points:[[0,25,-2],[1,30,-2],[2,35,-2],[3,40,-2]]}];
    return route.fulfill({json:available?{status:'RUNNING',prediction:{session_id:'isolated-guided-ui',
      timestamp_s:timestamp,evaluation_frame:frame,coordinate_frame:'EGO_AT_EVALUATION',render_reference:reference,tracks,trajectories,
      display_source:'ISOLATED_UI_PROJECTION_FIXTURE'}}:{status:'WAITING'}});
  });
  await page.evaluate(()=>window.setMissionFixture({connected:true,available:true,mode:'PAUSED',
    simulatorStop:{status:'IDLE'},journey:{status:'IDLE'}}));
  await page.getByRole('button',{name:'Start the normal drive',exact:true}).waitFor({state:'visible'});
  const evidenceBefore=await page.evaluate(()=>window.missionEvidence());
  const pageId=evidenceBefore.commands.find(c=>c.value?.operation==='PRELOAD')?.value.page_id;
  await page.evaluate(pageId=>window.setMissionFixture({connected:true,available:true,mode:'AUTOMATIC',
    journey:{status:'RUNNING',driving_mode:'ROBOSPHERE',speed_kmh:80},
    presentation:{id:'fixture-preloaded',status:'DRIVING',guided:true,preloaded:true,page_id:pageId,arm:0,modes:['ROBOSPHERE','NORMAL']}}),pageId);
  await page.setViewportSize({width:1440,height:900});
  const overlay=page.locator('#frontCameraView > canvas.prediction-overlay').first();
  await overlay.waitFor({state:'visible',timeout:15000});
  await page.getByText('Predicted paths · may change',{exact:true}).waitFor({state:'visible'});
  const pixels=await overlay.evaluate(canvas=>{
    const rgba=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;let visible=0;
    for(let i=3;i<rgba.length;i+=4)if(rgba[i])visible++;
    return visible;
  });
  if(pixels<50)throw Error('Forecast canvas is visible but did not draw paths');
  checks.push('Protected main camera renders time-advanced paths, without opening Details');
  await page.screenshot({path:'output/playwright/guided-forecast-desktop.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:'output/playwright/guided-forecast-mobile.png',fullPage:true});
  const fits=await overlay.evaluate(canvas=>{const a=canvas.getBoundingClientRect(),b=canvas.parentElement.getBoundingClientRect();
    return a.left>=b.left-1&&a.right<=b.right+1&&a.top>=b.top-1&&a.bottom<=b.bottom+1;});
  if(!fits)throw Error('Mobile forecast exceeds the camera bounds');
  checks.push('Forecast fits the contained camera on mobile');
  available=false;
  await overlay.waitFor({state:'hidden',timeout:5000});
  checks.push('Missing/stale source removes the overlay');
  available=true;
  await page.evaluate(pageId=>window.setMissionFixture({journey:{status:'RUNNING',driving_mode:'NORMAL'},
    presentation:{id:'fixture-preloaded',status:'DRIVING',guided:true,preloaded:true,page_id:pageId,arm:0,modes:['NORMAL','ROBOSPHERE']}}),pageId);
  await overlay.waitFor({state:'hidden'});
  checks.push('Normal main camera remains distinct from protected forecasts');
  const evidence=await page.evaluate(()=>window.missionEvidence());
  if(evidence.errors.length)throw Error(evidence.errors.join('\n'));
  return {scope:'ISOLATED_UI_FIXTURE_NOT_NATIVE_PREDICTION_ACCEPTANCE',pixels,checks,
    commands:evidence.commands.filter(c=>c.type!=='journey_heartbeat'),errors:evidence.errors,requests:evidence.requests};
}
