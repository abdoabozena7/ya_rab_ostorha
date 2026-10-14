// Browser-only integration rehearsal; all control messages end in this fixture.
// Uses saved native results. Never connects a WebSocket to CARLA.
async (page) => {
  const root='http://127.0.0.1:8000';
  const state=await (await page.request.get(root+'/api/simulation/state')).json();
  const result=await (await page.request.get(root+'/docs/evidence/demo_finalization_20261011/rule-result.json')).json();
  if(result.status!=='ARRIVED')throw Error('Saved native RULE fixture is unavailable');
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.addInitScript(({state,result})=>{
    state.type='snapshot';state.connected=true;state.controller=true;state.mode='PAUSED';state.error=null;
    state.sessionId='demo-offline-integration';state.restarting=false;state.recording=false;
    state.vehicle.speedMps=0;state.vehicle.speedKmh=0;state.vehicle.speedMagnitudeMps=0;
    state.comparisonDemo={phase:'IDLE',results:{},archive:[]};state.journey={status:'IDLE'};
    state.sensors={};state.sensorErrors={};state.route=null;
    state.safetySystem={enabled:true,status:'STANDBY',controller:'RULE',risk:'UNKNOWN',active:false,available_controllers:['RULE']};
    state.comparisonV2={phase:'IDLE',side:null,pair_id:'90ab411017f54272b96493fd1cfea0de',seed:2811,model_available:true,
      budget:{remaining_s:1000,recommended_run_allowance_s:600},results:{RULE:result},latest_attempt:result};
    window.__uiState=state;window.__uiCommands=[];window.__savedRule=result;
    window.WebSocket=class {
      readyState=1;
      constructor(){this.timer=setInterval(()=>{
        state.vehicle.frame++;state.vehicle.timestamp+=.05;state.world.frame=state.vehicle.frame;state.world.timestamp=state.vehicle.timestamp;
        this.onmessage?.({data:JSON.stringify(state)});
      },80);}
      send(json){
        const command=JSON.parse(json);window.__uiCommands.push(command);state.acknowledged=command.sequence;
        if(command.type==='comparison_v2') {state.comparisonV2.phase='QUEUED';state.comparisonV2.side=command.value.side;}
        if(command.type==='start_driving'){state.mode='MANUAL';state.journey={status:'PAUSED'};}
        if(command.type==='stop_driving'){state.mode='PAUSED';state.journey={status:'PAUSED',reason:command.reason};
          if(['QUEUED','RESETTING','RUNNING','STOPPING'].includes(state.comparisonV2.phase)){
            state.comparisonV2.phase='FINISHED';state.comparisonV2.latest_attempt={side:state.comparisonV2.side,status:'INTERRUPTED',reason:command.reason,completed:false};}}
        if(command.type==='reset'){state.mode='PAUSED';state.journey={status:'PAUSED',reason:'vehicle_reset'};}
        if(command.type==='emergency_stop')state.mode='EMERGENCY_STOP';
        if(command.type==='acknowledge_stop')state.mode='PAUSED';
      }
      close(){clearInterval(this.timer);this.readyState=3;}
    };
  },{state,result});
  await page.route('**/api/simulation/perception',route=>route.fulfill({json:{status:'UNAVAILABLE'}}));
  await page.goto(root);
  await page.waitForFunction(()=>document.getElementById('primaryDriveAction')?.dataset.action==='ruleDrivingBtn');
  const check=(condition,message)=>{if(!condition)throw Error(message);};
  check(await page.locator('#ruleDrivingBtn').evaluate(el=>el.classList.contains('primary')),'RULE must have the primary style');
  check(!(await page.locator('#modelDrivingBtn').evaluate(el=>el.classList.contains('primary'))),'MODEL must not have the primary style');
  check((await page.locator('#modelDrivingBtn').innerText()).includes('experimental'),'MODEL must be labelled experimental');
  await page.locator('#primaryDriveAction').click();
  await page.waitForFunction(()=>document.getElementById('modelDrivingBtn').disabled);
  check(await page.locator('#startDrivingBtn').isDisabled(),'Queued RULE must block another drive');
  await page.locator('#comparisonV2StopBtn').click();
  await page.waitForFunction(()=>document.getElementById('driveState').textContent==='Journey interrupted');
  await page.locator('#journeyResultsBtn').click();
  const text=await page.locator('#journeyResults').innerText();
  check(text.includes('Latest attempt · RULE · INTERRUPTED'),'Latest interruption must stay distinct from saved arrival');
  check(text.includes('ARRIVED')&&text.includes('184.28')&&text.includes('133.05'),'Results must show saved native outcome metrics');
  check(text.includes('Waiting proxy')&&!text.includes('NaN'),'Waiting proxy and missing metrics must be honest');
  await page.getByRole('tab',{name:'Driving',exact:true}).click();
  await page.evaluate(()=>{window.__uiState.comparisonV2.phase='IDLE';window.__uiState.journey={status:'IDLE'};});
  await page.waitForFunction(()=>!document.getElementById('modelDrivingBtn').disabled);
  await page.locator('#modelDrivingBtn').click();
  await page.waitForFunction(()=>document.getElementById('primaryDriveAction').dataset.action==='pauseBtn');
  await page.locator('#primaryDriveAction').click();
  await page.waitForFunction(()=>window.__uiState.comparisonV2.phase==='FINISHED');
  await page.evaluate(()=>{window.__uiState.comparisonV2.phase='IDLE';window.__uiState.journey={status:'IDLE'};});
  await page.waitForFunction(()=>!document.getElementById('startDrivingBtn').disabled);
  await page.locator('#startDrivingBtn').click();
  await page.waitForFunction(()=>document.getElementById('currentDrivingMode').textContent==='Manual · keyboard'&&document.getElementById('primaryDriveAction').dataset.action==='pauseBtn');
  await page.locator('#primaryDriveAction').click();
  await page.waitForFunction(()=>window.__uiState.mode==='PAUSED');
  await page.locator('#settingsBtn').click();
  await page.locator('#vehicleSettings>summary').click();
  await page.evaluate(()=>{window.confirm=()=>false;});
  let before=await page.evaluate(()=>window.__uiCommands.filter(c=>c.type==='reset').length);
  await page.locator('#resetBtn').click();
  check(await page.evaluate(()=>window.__uiCommands.filter(c=>c.type==='reset').length)===before,'Cancelled reset must send nothing');
  await page.evaluate(()=>{window.confirm=()=>true;});
  await page.locator('#resetBtn').click();
  check(await page.evaluate(()=>window.__uiCommands.filter(c=>c.type==='reset').length)===before+1,'Reset must send exactly one native reset request');
  await page.locator('#emergencyStopBtn').click();
  await page.waitForFunction(()=>document.getElementById('driveState').textContent==='Emergency stopped');
  check(await page.locator('#ruleDrivingBtn').isDisabled(),'Emergency latch must block RULE');
  await page.locator('#primaryDriveAction').click();
  await page.waitForFunction(()=>window.__uiState.mode==='PAUSED');
  for(const view of ['front','hood','chase','rear','top']) await page.locator('#cameraView').selectOption(view);
  await page.evaluate(()=>{window.__uiState.comparisonV2.budget.remaining_s=40.703;});
  await page.waitForFunction(()=>document.getElementById('ruleDrivingBtn').disabled&&document.getElementById('modelDrivingBtn').disabled&&document.getElementById('comparisonV2Status').innerText.includes('40.7 s'));
  check((await page.locator('#comparisonV2Status').innerText()).includes('40.7 s'),'Budget blocker must be visible');
  await page.getByRole('tab',{name:'Results',exact:true}).click();
  const layouts=[];
  for(const [width,height] of [[1920,1080],[1920,910],[1536,728],[1366,768],[1280,720],[1024,600],[900,900],[430,900],[320,720]]) {
    await page.setViewportSize({width,height});
    check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Results overflow at '+width);
    await page.screenshot({path:`output/playwright/demo-results-${width}.png`});
    await page.getByRole('tab',{name:'Driving',exact:true}).click();
    await page.waitForFunction(()=>document.getElementById('workspaceTitle').textContent==='Driving workspace');
    check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Driving overflow at '+width);
    if(width>920) {
      const layout=await page.evaluate(()=>{
        const rect=selector=>{const r=document.querySelector(selector).getBoundingClientRect();return {top:r.top,bottom:r.bottom,width:r.width,height:r.height};};
        return {camera:rect('#frontCameraView'),telemetry:rect('.telemetry-strip'),card:rect('#cameraCard'),
          footer:rect('.app-footer'),panel:rect('#drivePhase'),
          journeyDocked:!!document.querySelector('.drive-inspector>.comparison-v2'),
          imageFit:getComputedStyle(document.getElementById('authoritativeCamera')).objectFit};
      });
      check(layout.journeyDocked,'Journey controls must not precede the camera at '+width);
      check(layout.camera.top<=height*.34,'Excess whitespace above camera at '+width);
      check(layout.camera.height>=height*.44,'Native scene is too short at '+width);
      check(layout.camera.bottom<=layout.telemetry.top+1,'Camera must not overlap instruments at '+width);
      check(layout.telemetry.bottom<=layout.footer.top,'Instruments must fit above footer at '+width);
      check(layout.card.bottom<=layout.panel.bottom+1,'Camera card must fit its workspace at '+width);
      check(layout.imageFit==='contain','Native scene must not be cropped at '+width);
      layouts.push({width,height,...layout});
    } else layouts.push({width,height});
    await page.screenshot({path:`output/playwright/demo-driving-${width}.png`});
    const beforeExpand=await page.evaluate(()=>window.__uiCommands.length);
    await page.locator('#expandCameraBtn').click();
    check(await page.locator('#expandCameraBtn').getAttribute('aria-expanded')==='true','Expand failed at '+width);
    const expandButton=await page.locator('#expandCameraBtn').boundingBox();
    check(expandButton.x>=0&&expandButton.x+expandButton.width<=width&&expandButton.y>=0&&expandButton.y+expandButton.height<=height,'Expanded camera controls must remain reachable at '+width);
    await page.locator('#expandCameraBtn').click();
    check(await page.locator('#expandCameraBtn').getAttribute('aria-expanded')==='false','Shrink failed at '+width);
    await page.locator('#expandCameraBtn').click();
    await page.keyboard.press('Escape');
    check(await page.locator('#expandCameraBtn').getAttribute('aria-expanded')==='false','Escape must restore the workspace at '+width);
    check(await page.evaluate(()=>window.__uiCommands.length)===beforeExpand,'Expanding the image must not send driving commands');
    await page.getByRole('tab',{name:'Results',exact:true}).click();
  }
  await page.evaluate(()=>{window.__uiState.connected=false;window.__uiState.mode='DISCONNECTED';});
  await page.waitForFunction(()=>document.getElementById('journeyResults').textContent.includes('connection unavailable'));
  check((await page.locator('#journeyResults').innerText()).includes('184.28'),'Disconnect must retain saved results');
  check(errors.length===0,'Browser errors: '+errors.join('; '));
  const commands=await page.evaluate(()=>window.__uiCommands);
  check(commands.filter(c=>c.type==='comparison_v2').map(c=>c.value.side).join(',')==='RULE,MODEL','Each explicit button must emit exactly one run request');
  const report={status:'PASS',nativeCommandsSent:0,checks:['RULE primary/default','MODEL experimental','queued stop','manual start/stop','reset confirmation','emergency latch','five camera controls','saved arrival distinct from interrupted retry','budget blocker','offline result retention','responsive layouts','expand/shrink/Escape','no browser errors'],layouts,commands:commands.map(c=>({type:c.type,value:c.value,reason:c.reason})),pageErrors:errors};
  await page.evaluate(report=>window.__demoVerification=report,report);
  return report;
}
