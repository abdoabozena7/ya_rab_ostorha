// Run with playwright-cli run-code --filename scripts/verify_workspace_ui.js.
// Uses real assets and a read-only state GET; all driving commands terminate in
// the isolated browser's WebSocket fixture. Nothing is sent to the simulator.
async (page) => {
  const response = await page.request.get('http://127.0.0.1:8000/api/simulation/state');
  const native = await response.json();
  const errors = [];
  await page.emulateMedia({reducedMotion:'reduce'});
  page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(snapshot=>{
    snapshot.connected=true; snapshot.controller=true; snapshot.mode='PAUSED'; snapshot.provider='carla';
    snapshot.vehicle.speedKmh=0; snapshot.vehicle.speedMps=0; snapshot.vehicle.speedMagnitudeMps=0;
    snapshot.restarting=false; snapshot.restartResult=null;
    snapshot.journey={status:'IDLE'}; snapshot.route=null; snapshot.sensors={}; snapshot.sensorErrors={};
    snapshot.comparisonDemo={...snapshot.comparisonDemo,phase:'IDLE',mode:null,error:null,results:{}};
    snapshot.comparisonV2=null;
    snapshot.safetySystem={enabled:true,status:'STANDBY',risk:'UNKNOWN',active:false,intervention_count:0,controller:'RULE',available_controllers:['RULE']};
    snapshot.sessionId='workspace-browser-test'; snapshot.type='snapshot'; snapshot.recording=false;
    window.__uiState=snapshot; window.__uiCommands=[];
    window.WebSocket=class {
      readyState=1;
      constructor() {this.timer=setInterval(()=>{
        const state=window.__uiState;
        state.vehicle.frame++; state.vehicle.timestamp+=.05;
        state.world.frame=state.vehicle.frame; state.world.timestamp=state.vehicle.timestamp;
        this.onmessage?.({data:JSON.stringify(state)});
      },80);}
      send(json) {
        const command=JSON.parse(json),state=window.__uiState;
        window.__uiCommands.push(command); state.acknowledged=command.sequence;
        if(command.type==='emergency_stop') {state.mode='EMERGENCY_STOP'; state.safetySystem.active=false;}
        if(command.type==='stop_driving'||command.type==='acknowledge_stop')state.mode='PAUSED';
      }
      close(){clearInterval(this.timer);this.readyState=3;}
    };
  },native);
  await page.route('**/api/simulation/perception',route=>route.fulfill({json:{status:'UNAVAILABLE'}}));
  await page.goto('http://127.0.0.1:8000/');
  await page.waitForFunction(()=>document.getElementById('driveState')?.textContent==='Ready');
  const check=(value,message)=>{if(!value)throw new Error(message);};
  check(await page.locator('#primaryDriveAction').isEnabled(),'Ready state must have an enabled primary action');
  await page.getByRole('tab',{name:'Results',exact:true}).click();
  check(await page.locator('#drivePhase').isHidden(),'Driving workspace must be hidden in results');
  check((await page.locator('#resultScope').textContent()).includes('Archived'),'Archive scope must be explicit');
  await page.keyboard.press('ArrowRight');
  check(await page.locator('#setupPhase').isVisible(),'Arrow key must activate the next workspace');
  await page.keyboard.press('Home');
  check(await page.locator('#drivePhase').isVisible(),'Home must return to the first workspace');
  const beforeInspection=await page.evaluate(()=>window.__uiCommands.length);
  await page.evaluate(()=>{window.__uiState.mode='AUTOMATIC'; window.__uiState.journey={status:'RUNNING'};});
  await page.waitForFunction(()=>document.getElementById('currentDrivingMode').textContent==='Autonomous');
  await page.getByRole('tab',{name:'Results',exact:true}).click();
  check(await page.evaluate(()=>window.__uiState.mode==='AUTOMATIC'),'Visible destination journey must continue across workspaces');
  check(await page.evaluate(start=>!window.__uiCommands.slice(start).some(c=>c.type==='stop_driving'&&c.reason==='workspace_changed'),beforeInspection),'Inspection must not stop destination driving');
  await page.getByRole('tab',{name:'Driving',exact:true}).click();
  await page.evaluate(()=>{window.__uiState.mode='AUTOMATIC'; window.__uiState.journey={status:'RUNNING'};});
  await page.waitForFunction(()=>document.getElementById('currentDrivingMode').textContent==='Autonomous');
  await page.evaluate(()=>{window.__uiState.safetySystem.active=true; window.__uiState.safetySystem.risk='HIGH'; window.__uiState.safetySystem.reason='Obstacle ahead'; window.__uiState.safetySystem.intervention_count=1;});
  await page.waitForFunction(()=>document.getElementById('driveState').textContent==='Safety intervention');
  check((await page.locator('#lastIntervention').textContent()).includes('Obstacle ahead'),'Intervention must show its cause');
  check((await page.locator('#timelineCount').textContent())==='1 events','Observed intervention must appear in the session timeline');
  await page.evaluate(()=>{window.__uiState.safetySystem.active=false;});
  await page.waitForFunction(()=>document.getElementById('timelineCount').textContent==='2 events');
  await page.getByRole('button',{name:'Settings',exact:true}).click();
  check(await page.locator('#settingsPanel #emergencyStopBtn').isVisible(),'Emergency stop must remain visible inside a modal');
  check(await page.locator('#emergencyStopBtn').evaluate(el=>!el.closest('[inert]')),'Emergency stop must not be inert in a modal');
  await page.locator('#emergencyStopBtn').click();
  await page.waitForFunction(()=>document.getElementById('driveState').textContent==='Emergency stopped');
  check(await page.locator('#settingsPanel').isHidden(),'Emergency stop must return to the live workspace');
  let commands=await page.evaluate(()=>window.__uiCommands);
  check(commands.some(c=>c.type==='emergency_stop'),'Emergency action must send the dedicated latch command');
  check(!commands.some(c=>c.type==='reset'||c.type==='comparison'),'Emergency action must not reset the vehicle or experiment');
  check(await page.locator('#startDrivingBtn').isDisabled(),'Driving must stay disabled until acknowledgement');
  await page.locator('#primaryDriveAction').click();
  await page.waitForFunction(()=>window.__uiState.mode==='PAUSED');
  await page.evaluate(()=>{window.__uiState.journey={status:'IDLE'};});
  await page.locator('.comparison-controls>summary').click();
  await page.locator('summary').filter({hasText:'Historical safety comparison'}).click();
  const before=await page.evaluate(()=>window.__uiCommands.length);
  await page.evaluate(()=>{window.confirm=()=>false;});
  await page.locator('#demoStopBtn').click();
  commands=await page.evaluate(count=>window.__uiCommands.slice(count),before);
  check(!commands.some(c=>c.type==='comparison'),'Cancelling reset must not issue a comparison request');
  await page.evaluate(()=>{window.confirm=()=>true;});
  await page.locator('#demoStopBtn').click();
  commands=await page.evaluate(()=>window.__uiCommands);
  check(commands.filter(c=>c.type==='comparison'&&c.value.mode==='STOP').length===1,'Confirmed reset must issue exactly one reset request');
  await page.evaluate(()=>{window.__uiState.comparisonDemo.phase='FINISHED'; window.__uiState.comparisonDemo.latest_outcome='SAFE_PROGRESS'; window.__uiState.journey={status:'IDLE'};});
  await page.waitForFunction(()=>document.getElementById('driveState').textContent==='Drive completed');
  await page.getByRole('tab',{name:'Results',exact:true}).click();
  await page.locator('#newDriveBtn').click();
  await page.waitForFunction(()=>document.getElementById('primaryDriveAction').textContent==='Start manual drive');
  check(await page.locator('#primaryDriveAction').isEnabled(),'New drive action must retain the live connection and return to a start action');
  await page.evaluate(()=>{window.__uiState.mode='PAUSED'; window.__uiState.journey={status:'IDLE'};});
  const viewports=[[1920,1080],[1366,768],[1024,768],[768,1024],[390,844],[320,720]];
  const layouts=[];
  for(const [width,height] of viewports) {
    await page.setViewportSize({width,height});
    await page.getByRole('tab',{name:'Driving',exact:true}).click();
    const driving=await page.evaluate(()=>({overflow:document.documentElement.scrollWidth>innerWidth,cameraRatio:(()=>{const r=document.getElementById('frontCameraView').getBoundingClientRect();return r.width/r.height;})(),telemetryBottom:document.querySelector('.telemetry-strip').getBoundingClientRect().bottom}));
    check(!driving.overflow,'Driving overflow at '+width);
    if(width>=1024) {
      const cameraWidth=await page.locator('#frontCameraView').evaluate(el=>el.getBoundingClientRect().width);
      check(cameraWidth>=width*.7,'Native scene must occupy most of the desktop width at '+width);
      check(await page.locator('#frontCameraView').evaluate(el=>el.getBoundingClientRect().bottom<=innerHeight),'Complete scene must fit the desktop viewport at '+width);
      check(await page.locator('#authoritativeCamera').evaluate(el=>getComputedStyle(el).objectFit==='contain'),'Native image must not be cropped at '+width);
    } else check(Math.abs(driving.cameraRatio-16/9)<.01,'Camera aspect ratio at '+width);
    await page.getByRole('tab',{name:'Results',exact:true}).click();
    check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Results overflow at '+width);
    layouts.push({width,height,...driving});
  }
  await page.evaluate(()=>{window.__uiState.connected=false; window.__uiState.mode='DISCONNECTED';});
  await page.getByRole('tab',{name:'Driving',exact:true}).click();
  await page.waitForFunction(()=>document.getElementById('driveState').textContent==='Disconnected');
  check(await page.locator('#emergencyStopBtn').isDisabled(),'Disconnected view must block control');
  check((await page.locator('#liveInterventions').textContent()).startsWith('—'),'Disconnected observations must not become zero');
  const duplicates=await page.evaluate(()=>[...document.querySelectorAll('[id]')].map(el=>el.id).filter((id,index,ids)=>ids.indexOf(id)!==index));
  check(duplicates.length===0,'DOM IDs must stay unique');
  check(errors.length===0,'Runtime errors: '+errors.join('; '));
  const report={status:'PASS',checks:['workspace separation','keyboard navigation','intervention cause and timeline','modal emergency stop','latch acknowledgement','reset confirmation','six responsive viewports','disconnected controls','unique IDs','no runtime errors'],layouts};
  await page.evaluate(report=>window.__uiVerification=report,report);
  return report;
}
