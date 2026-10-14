// Real one-button cold start, followed by GPU release. Never starts driving.
async(page)=>{
  const root='http://127.0.0.1:8000',errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.setViewportSize({width:1440,height:960});
  await page.goto(root+'/?mode=guided&rehearsal=1');
  await page.waitForFunction(()=>['CARLA — CONNECTED','CARLA — STOPPED'].includes(document.getElementById('cityStatus').textContent));
  if((await page.locator('#cityStatus').textContent())==='CARLA — CONNECTED')await page.locator('#stopSimulatorBtn').click();
  await page.waitForFunction(()=>document.getElementById('cityStatus').textContent==='CARLA — STOPPED',null,{timeout:75_000});
  await page.locator('#guidedPrimary').filter({hasText:'Start the simulation'}).waitFor();
  const starts=[];
  page.on('request',request=>{if(request.url().endsWith('/api/simulation/start'))starts.push(request.method());});
  await page.locator('#guidedPrimary').click();
  await page.waitForFunction(()=>document.getElementById('guidedPrimary').textContent==='Starting the simulation…');
  if(!(await page.locator('#guidedPrimary').isDisabled()))throw new Error('Duplicate start is not blocked');
  await page.screenshot({path:'output/simulation-start/starting.png'});
  await page.waitForFunction(()=>document.getElementById('cityStatus').textContent==='CARLA — CONNECTED',null,{timeout:180_000});
  const state=await(await page.request.get(root+'/api/simulation/state')).json();
  if(state.mode!=='PAUSED'||state.vehicle.source!=='carla'||!state.sensorRegistry)throw new Error('Native stopped sensor session missing');
  if(starts.length!==1||starts[0]!=='POST')throw new Error('Cold start did not use one explicit request');
  if(await page.locator('#reconnectBtn,#nativeReconnectBtn').count())throw new Error('Old separate connection actions remain');
  await page.screenshot({path:'output/simulation-start/connected.png'});
  await page.locator('#stopSimulatorBtn').click();
  await page.waitForFunction(()=>document.getElementById('cityStatus').textContent==='CARLA — STOPPED',null,{timeout:75_000});
  await page.screenshot({path:'output/simulation-start/stopped-ready-to-start.png'});
  const final=await(await page.request.get(root+'/api/simulation/state')).json();
  if(final.simulatorStart?.status==='FAILED')throw new Error('Successful start was later marked failed');
  if(errors.length)throw new Error(JSON.stringify(errors));
  return {passed:true,explicit_start_requests:starts.length,live_carla:true,mode_after_start:state.mode,
    sensors:Object.keys(state.sensorRegistry),driving_started:false,final_status:'STOPPED',errors};
}
