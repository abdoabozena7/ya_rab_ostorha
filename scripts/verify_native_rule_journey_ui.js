// Start the persisted native RULE journey from the actual application.
// Evidence is observational; the application's normal heartbeat owns the drive.
async (page) => {
  let state=null,last=0; const commands=[],errors=[],samples=[]; let heartbeats=0;
  page.on('pageerror',error=>errors.push(error.message));
  page.on('websocket',socket=>{
    socket.on('framesent',event=>{
      const row=JSON.parse(event.payload);
      if(row.type==='journey_heartbeat')heartbeats++;
      else commands.push(row);
    });
    socket.on('framereceived',event=>{
      const row=JSON.parse(event.payload);
      if(row.type==='error')errors.push(row.error);
      if(row.type!=='snapshot')return;
      state=row;
      if(Date.now()-last<1000)return;last=Date.now();
      const v=row.comparisonV2||{},s=row.safetySystem||{};
      samples.push({wall_ms:Date.now(),mode:row.mode,phase:v.phase,recording:row.recording,
        frame:row.vehicle.frame,speed_kmh:row.vehicle.speedKmh,position:row.vehicle.positionWorldM,
        controller:s.controller,reason:s.reason,risk:s.risk,source:s.decision_source,
        prediction_objects:s.prediction?.trajectories?.length,latest:v.latest_attempt?.attempt_id});
      page.evaluate(e=>window.__nativeJourneyEvidence=e,{transport:'unmodified actual dashboard WebSocket',commands,errors,heartbeats,samples,
        latest:v.latest_attempt,results:v.results,budget:v.budget,journey:row.journey}).catch(()=>{});
    });
  });
  await page.goto('http://127.0.0.1:8000/');
  await page.waitForFunction(()=>!document.getElementById('ruleDrivingBtn').disabled);
  if(state?.comparisonV2?.seed!==2811||state?.comparisonV2?.pair_id!=='90ab411017f54272b96493fd1cfea0de')throw Error('Persisted verified journey changed');
  await page.locator('#ruleDrivingBtn').click();
  await page.waitForFunction(()=>document.getElementById('comparisonV2Results').textContent.includes('RUNNING'),null,{timeout:90000});
  await page.screenshot({path:'output/playwright/native-rule-journey-start.png'});
  return {status:'RUNNING',pair_id:state.comparisonV2.pair_id,seed:state.comparisonV2.seed,
    recording:state.recording,commands:commands.map(c=>({type:c.type,value:c.value})),budget:state.comparisonV2.budget};
}
