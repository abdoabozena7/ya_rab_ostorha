// playwright-cli run-code --filename scripts/verify_traffic_preparation_ui.js
// Real dashboard assets; browser-only command sink. No native control/spawn calls.
async (page) => {
  const response=await page.request.get('http://127.0.0.1:8000/api/simulation/state');
  if(!response.ok())throw new Error('Read-only application state unavailable');
  const native=await response.json(),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.setViewportSize({width:1440,height:1100});
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.addInitScript(snapshot=>{
    Object.assign(snapshot,{connected:true,controller:true,mode:'PAUSED',provider:'carla',sessionId:'traffic-ui-fixture',
      type:'snapshot',recording:false,journey:{status:'IDLE'},route:null,sensors:{},sensorErrors:{},comparisonV2:null,
      comparisonDemo:{phase:'IDLE',mode:null,results:{}},environment:{mode:'LIVING_CITY'},dashboardResult:null});
    Object.assign(snapshot.vehicle,{speedMps:0,speedMagnitudeMps:0,speedKmh:0,throttle:0,brake:1});
    snapshot.population={...snapshot.population,requested:{...snapshot.population.requested,vehicle_count:5},
      actual:{...snapshot.population.actual,vehicles:5},npc_failed:0,errors:[],traffic_manager_connected:true};
    snapshot.safetySystem={enabled:true,status:'STANDBY',risk:'UNKNOWN',active:false,intervention_count:0,
      controller:'RULE',available_controllers:['RULE']};
    window.__trafficState=snapshot;window.__trafficCommands=[];window.__trafficOperation=0;
    window.WebSocket=class {
      readyState=1;
      constructor(){this.timer=setInterval(()=>{
        const state=window.__trafficState;
        state.vehicle.frame++;state.vehicle.timestamp+=.05;
        state.world.frame=state.population.frame_id=state.vehicle.frame;
        state.world.timestamp=state.vehicle.timestamp;
        this.onmessage?.({data:JSON.stringify(state)});
      },80);}
      send(json){
        const command=JSON.parse(json),state=window.__trafficState;
        window.__trafficCommands.push(command);state.acknowledged=command.sequence;
        if(command.type==='stop_driving')state.mode='PAUSED';
        if(command.type==='settings')state.dashboardResult={action:'settings',status:'PENDING',
          operationId:'traffic-'+(++window.__trafficOperation)};
      }
      close(){clearInterval(this.timer);this.readyState=3;}
    };
  },native);
  await page.route('**/api/simulation/perception',route=>route.fulfill({json:{status:'UNAVAILABLE'}}));
  await page.goto('http://127.0.0.1:8000/');
  await page.waitForFunction(()=>document.getElementById('prepareTrafficBtn')?.disabled===false);
  const check=(value,message)=>{if(!value)throw new Error(message);};
  check(await page.locator('#prepareTrafficBtn').isVisible(),'Traffic button must be visible in the driving workspace');
  await page.screenshot({path:'output/playwright/traffic-preparation-before.png',fullPage:true});
  await page.locator('#prepareTrafficBtn').click();
  await page.waitForFunction(()=>window.__trafficCommands.some(c=>c.type==='settings'));
  await page.waitForFunction(()=>document.getElementById('startDrivingBtn').disabled);
  check(await page.locator('#demoWithBtn').isDisabled(),'Comparison must not start during traffic preparation');
  check(await page.locator('#primaryDriveAction').isDisabled(),'Primary drive action must be held during preparation');
  await page.evaluate(()=>{
    const s=window.__trafficState;
    s.population.requested.vehicle_count=40;s.population.actual.vehicles=39;s.population.npc_failed=1;
    s.dashboardResult={...s.dashboardResult,status:'APPLIED',result:{population:structuredClone(s.population)}};
  });
  await page.waitForFunction(()=>document.getElementById('trafficPreparationStatus').textContent.includes('39/40'));
  check(await page.locator('#startDrivingBtn').isDisabled(),'Partial traffic must not silently admit driving');
  await page.screenshot({path:'output/playwright/traffic-preparation-failed.png',fullPage:true});
  await page.locator('#prepareTrafficBtn').click();
  await page.waitForFunction(()=>window.__trafficCommands.filter(c=>c.type==='settings').length===2);
  await page.evaluate(()=>{
    const s=window.__trafficState;
    s.population.actual.vehicles=40;s.population.npc_failed=0;
    s.dashboardResult={...s.dashboardResult,status:'APPLIED',result:{population:structuredClone(s.population)}};
  });
  await page.waitForFunction(()=>document.getElementById('trafficPreparationStatus').textContent.includes('confirmed in CARLA'));
  await page.waitForFunction(()=>document.getElementById('startDrivingBtn').disabled===false);
  await page.screenshot({path:'output/playwright/traffic-preparation-ready.png',fullPage:true});
  await page.evaluate(()=>{window.__trafficState.mode='AUTOMATIC';window.__trafficState.vehicle.speedMps=5;});
  await page.waitForFunction(()=>document.getElementById('prepareTrafficBtn').disabled);
  check((await page.locator('#prepareTrafficBtn').getAttribute('title')).includes('Stop driving'),'Moving vehicle must reject preparation');
  await page.evaluate(()=>{const s=window.__trafficState;s.mode='PAUSED';s.vehicle.speedMps=0;s.environment.mode='TRAINING';});
  await page.waitForFunction(()=>document.getElementById('prepareTrafficBtn').title.includes('Living city'));
  const commands=await page.evaluate(()=>window.__trafficCommands);
  check(commands.filter(c=>c.type==='settings').length===2,'Only explicit clicks may request native setup');
  check(commands.every(c=>c.type==='stop_driving'||c.type==='settings'),'No driving/safety/scenario command may escape the browser test');
  check(commands.filter(c=>c.type==='settings').every(c=>c.value.population.vehicle_count===40),'Requested count must be explicit');
  check(errors.length===0,JSON.stringify(errors));
  return {passed:true,scope:'Real dashboard assets with an isolated browser-only command sink',
    native_control_calls:0,native_spawn_calls:0,explicit_preparation_requests:2,partial_spawn_rejected:true,
    pending_start_blocked:true,complete_native_snapshot_contract_checked:true,moving_and_training_guards:true,errors,commands};
}
