// Real dashboard/native CARLA integration. Observes the actual WebSocket;
// no routes, synthetic snapshots, replacement transport, or direct control API.
async (page) => {
  await page.setViewportSize({width:1366,height:900});
  const errors=[]; const commands=[]; let state=null;
  page.on('pageerror',error=>errors.push(error.message));
  page.on('websocket',socket=>{
    socket.on('framesent',event=>{
      const row=JSON.parse(event.payload);
      if(row.type!=='journey_heartbeat' && row.type!=='controls') commands.push(row);
    });
    socket.on('framereceived',event=>{
      const row=JSON.parse(event.payload);
      if(row.type==='snapshot') state=row;
      if(row.type==='error') errors.push(row.error);
    });
  });
  await page.goto('http://127.0.0.1:8000/');
  const wait=async(predicate,label,seconds=60)=>{
    const end=Date.now()+seconds*1000;
    while(Date.now()<end) {if(predicate())return; await page.waitForTimeout(100);}
    throw Error(label+': '+JSON.stringify({mode:state?.mode,v2:state?.comparisonV2,error:state?.error}));
  };
  await wait(()=>state?.connected,'Connected native dashboard');
  if(!state.controller) {
    await page.locator('#settingsBtn').click();
    await page.locator('#connectionSettings>summary').click();
    await page.locator('#takeControlBtn').click();
    await wait(()=>state?.controller,'Explicit dashboard ownership');
    await page.locator('#closeSettingsBtn').click();
  }
  if(state.mode!=='PAUSED'||state.safetySystem.controller!=='RULE'||!state.safetySystem.enabled)throw Error('Startup is not paused RULE');
  if(state.comparisonV2?.budget?.scope!=='NATIVE_RULE_VALIDATION')throw Error('Separate validation authorization unavailable');
  await page.waitForFunction(()=>{const im=document.getElementById('authoritativeCamera');return !im.hidden&&im.naturalWidth>0;});
  if(!(await page.locator('#modelDrivingBtn').isDisabled())||!(await page.locator('#modelDrivingBtn').innerText()).includes('experimental'))throw Error('MODEL must remain experimental and unavailable in RULE validation');
  const samples=[];
  const sample=async(label)=>{
    samples.push({label,mode:state.mode,vehicle:state.vehicle,journey:state.journey,
      phase:state.comparisonV2.phase,latest:state.comparisonV2.latest_attempt,recording:state.recording,safety:state.safetySystem});
    await page.evaluate(report=>window.__nativeLifecycleReport=report,{status:'IN_PROGRESS',commands,samples,errors});
  };
  sample('native-launch');await page.screenshot({path:'output/playwright/native-rule-launch.png'});
  await page.locator('#startDrivingBtn').click();
  await wait(()=>state?.mode==='MANUAL','Manual start');
  await page.keyboard.down('w');
  await wait(()=>state?.vehicle?.speedKmh>1,'Native throttle motion',15);
  await page.keyboard.up('w');sample('manual-moving');
  await page.locator('#primaryDriveAction').click();
  await wait(()=>state?.mode==='PAUSED'&&state?.vehicle?.speedKmh<.54,'Manual stop');sample('manual-stopped');
  await page.locator('#startDrivingBtn').click();await wait(()=>state?.mode==='MANUAL','Emergency preparation');
  await page.locator('#emergencyStopBtn').click();
  await wait(()=>state?.mode==='EMERGENCY_STOP','Emergency latch');
  await page.waitForTimeout(500);
  if(!(await page.locator('#ruleDrivingBtn').isDisabled()))throw Error('Emergency latch admitted RULE');
  sample('emergency-latched');await page.screenshot({path:'output/playwright/native-rule-emergency.png'});
  await page.locator('#primaryDriveAction').click();
  await wait(()=>state?.mode==='PAUSED','Explicit acknowledge');
  await page.waitForTimeout(500);if(state.mode!=='PAUSED')throw Error('Emergency acknowledge resumed driving');
  sample('emergency-acknowledged');
  // Stop a real admitted RULE journey while its automatic recorder is active.
  await page.locator('#ruleDrivingBtn').click();
  await wait(()=>state?.comparisonV2?.phase==='RUNNING'&&state.recording,'Recorded RULE start',90);
  await page.waitForTimeout(1500);sample('rule-before-stop');
  await page.locator('#comparisonV2StopBtn').click();
  await wait(()=>state?.comparisonV2?.phase==='FINISHED'&&!state.recording&&state.mode==='PAUSED','RULE stop finalization',45);
  if(state.comparisonV2.latest_attempt.status!=='INTERRUPTED')throw Error('Stop misreported as completed arrival');
  sample('rule-stop-finalized');
  await page.locator('#journeyResultsBtn').click();
  if(!(await page.locator('#journeyResults').innerText()).includes('INTERRUPTED'))throw Error('Results omitted latest stop');
  await page.getByRole('tab',{name:'Driving',exact:true}).click();
  // Reset during a second real recording; the server must finalize before reset.
  await page.locator('#ruleDrivingBtn').click();
  await wait(()=>state?.comparisonV2?.phase==='RUNNING'&&state.recording,'RULE restart before reset',90);
  await page.waitForTimeout(1200);sample('rule-before-reset');
  const oldActor=state.vehicle.actorId;
  await page.locator('#settingsBtn').click();
  await page.locator('#vehicleSettings>summary').click();
  page.once('dialog',dialog=>dialog.accept());
  await page.locator('#resetBtn').click();
  await wait(()=>state?.comparisonV2?.phase==='FINISHED'&&!state.recording&&state.mode==='PAUSED'&&state.vehicle.actorId!==oldActor,'Active recording reset',60);
  if(state.comparisonV2.latest_attempt.reason!=='vehicle_reset')throw Error('Reset cause missing');
  sample('rule-reset-finalized');
  await page.locator('#closeSettingsBtn').click();
  if(errors.length)throw Error('Browser/native errors: '+errors.join('; '));
  const report={status:'PASS',transport:'unmodified real dashboard WebSocket',checks:['native launch and RGB camera','paused RULE default','MODEL experimental','manual throttle and stop','emergency latch and explicit acknowledgement','RULE start, recording and stop','active recording reset','interrupted result display'],commands,samples,errors};
  await page.evaluate(report=>window.__nativeLifecycleReport=report,report);
  return {status:report.status,checks:report.checks,commands:commands.map(c=>c.type),samples:samples.map(s=>({label:s.label,mode:s.mode,phase:s.phase,recording:s.recording,actor:s.vehicle.actorId}))};
}
