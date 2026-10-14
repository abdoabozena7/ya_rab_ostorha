// playwright-cli run-code --filename scripts/verify_city_controls_ui.js
// Real app assets; every mutation terminates in the browser-only socket fixture.
async (page) => {
  const response=await page.request.get('http://127.0.0.1:8000/api/simulation/state');
  if(!response.ok())throw new Error('Read-only state unavailable');
  const snapshot=await response.json(),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.setViewportSize({width:1440,height:900});
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.addInitScript(s=>{
    Object.assign(s,{connected:true,controller:true,mode:'PAUSED',provider:'carla',sessionId:'city-ui-fixture',type:'snapshot',
      recording:false,restarting:false,journey:{status:'IDLE'},route:null,sensors:{},sensorErrors:{},navigationAvailable:true,comparisonV2:null,
      comparisonDemo:{phase:'IDLE',mode:null,results:{}},environment:{mode:'LIVING_CITY'},dashboardResult:null});
    Object.assign(s.vehicle,{speedMps:0,speedMagnitudeMps:0,speedKmh:0,throttle:0,brake:1});
    s.population={requested:{vehicle_count:20,pedestrian_count:15,speed_behavior:'NORMAL',seed:2604,fast_walk_percent:10,
      driver_behavior:'NORMAL',light_compliance_percent:90,crossing_percent:5,chaos_percent:0,world_profile:'VISUAL_DEMO'},
      actual:{vehicles:20,pedestrians:15,controllers:15,walkers_active:15},npc_failed:0,walkers_failed:0,errors:[],traffic_manager_connected:true};
    s.safetySystem={enabled:true,status:'STANDBY',risk:'UNKNOWN',active:false,intervention_count:0,controller:'RULE',available_controllers:['RULE']};
    window.__cityState=s;window.__cityCommands=[];window.__cityOperation=0;
    window.WebSocket=class {
      readyState=1;
      constructor(){this.timer=setInterval(()=>{
        s.vehicle.frame++;s.vehicle.timestamp+=.05;s.world.frame=s.population.frame_id=s.vehicle.frame;s.world.timestamp=s.vehicle.timestamp;
        this.onmessage?.({data:JSON.stringify(s)});
      },80);}
      send(json){const c=JSON.parse(json);window.__cityCommands.push(c);s.acknowledged=c.sequence;
        if(c.type==='settings')s.dashboardResult={action:'settings',status:'PENDING',operationId:'city-'+(++window.__cityOperation)};
        if(c.type==='safety_mode')s.safetySystem.enabled=c.value.enabled;
        if(c.type==='start_journey'){s.mode='AUTOMATIC';s.journey={status:'RUNNING',speed_kmh:c.speed_kmh};}
        if(c.type==='stop_driving'){s.mode='PAUSED';s.journey={status:'PAUSED',reason:c.reason};}
        if(c.type==='emergency_stop'){s.mode='EMERGENCY_STOP';s.journey={status:'PAUSED',reason:'emergency_stop'};}
        if(c.type==='start_driving'){s.mode='MANUAL';s.journey={status:'PAUSED'};}
      }
      close(){clearInterval(this.timer);this.readyState=3;}
    };
  },snapshot);
  await page.route('**/api/simulation/perception',r=>r.fulfill({json:{status:'UNAVAILABLE'}}));
  await page.goto('http://127.0.0.1:8000/');
  await page.waitForFunction(()=>document.getElementById('prepareTrafficBtn')?.disabled===false);
  const check=(ok,message)=>{if(!ok)throw new Error(message);};
  const shell=()=>page.evaluate(()=>({width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,
    scrollHeight:document.documentElement.scrollHeight,bodyHeight:document.body.scrollHeight}));
  const sizes=[];
  for(const size of [{width:1440,height:900},{width:1280,height:720},{width:390,height:844}]) {
    await page.setViewportSize(size);
    for(const phase of ['drive','setup','results']) {
      await page.locator('#'+phase+'Tab').click();
      const bounds=await shell();sizes.push({phase,...bounds});
      check(bounds.scrollWidth<=size.width && bounds.scrollHeight<=size.height && bounds.bodyHeight<=size.height,`Page scroll at ${JSON.stringify({phase,...bounds})}`);
      const emergency=await page.locator('#emergencyStopBtn').boundingBox();
      check(emergency.y>=0 && emergency.y+emergency.height<=size.height,'Emergency stop must stay in viewport');
      await page.screenshot({path:`output/playwright/city-${phase}-${size.width}x${size.height}.png`});
    }
  }
  await page.setViewportSize({width:1280,height:720});await page.locator('#setupTab').click();
  await page.locator('[data-city-preset="CHAOTIC"]').click();
  check(await page.locator('#cityChaos').inputValue()==='85','Chaos preset missing');
  check(await page.locator('#cityGo').isDisabled(),'Unapplied changes must hold journey start');
  await page.locator('#cityVehicles').fill('37');await page.locator('#cityWalkers').fill('18');
  await page.locator('#cityApply').click();
  await page.waitForFunction(()=>window.__cityCommands.some(c=>c.type==='settings'));
  check(await page.locator('#cityGo').isDisabled(),'Pending native setup must hold starts');
  const config=await page.evaluate(()=>window.__cityCommands.find(c=>c.type==='settings').value.population);
  check(config.vehicle_count===37 && config.pedestrian_count===18 && config.chaos_percent===85 && config.crossing_percent===60 && config.seed===2604,'Custom setup values were lost');
  await page.evaluate(config=>{const s=window.__cityState;s.population.requested=config;
    s.population.actual={vehicles:37,pedestrians:18,controllers:18,walkers_active:18};
    s.dashboardResult={...s.dashboardResult,status:'APPLIED',result:{population:structuredClone(s.population)}};
    s.route={id:'city-route',destination:{name:'Same selected route',location:[-30,-68,0]},remaining_m:120,arrived:false,points:[]};
  },config);
  await page.waitForFunction(()=>document.getElementById('cityGo').disabled===false);
  await page.locator('#cityNormalMode').click();
  await page.waitForFunction(()=>document.getElementById('cityNormalMode').getAttribute('aria-pressed')==='true');
  await page.locator('#citySafetyMode').click();
  await page.waitForFunction(()=>document.getElementById('citySafetyMode').getAttribute('aria-pressed')==='true');
  await page.locator('#cityDrivePace').selectOption('25');
  await page.locator('#cityGo').click();
  await page.waitForFunction(()=>window.__cityState.mode==='AUTOMATIC');
  const starts=await page.evaluate(()=>window.__cityCommands.filter(c=>c.type==='start_journey'));
  check(starts.length===1 && starts[0].speed_kmh===25,'Destination pace/start must use the existing navigation API once');
  await page.locator('#setupTab').click();
  let count=await page.evaluate(()=>window.__cityCommands.filter(c=>c.type==='journey_heartbeat').length);
  await page.evaluate(()=>window.dispatchEvent(new Event('blur')));
  await page.waitForFunction(n=>window.__cityCommands.filter(c=>c.type==='journey_heartbeat').length>n+3,count);
  check(await page.evaluate(()=>window.__cityState.mode==='AUTOMATIC'),'Inspecting Setup/blur must retain visible destination intent');
  check(await page.evaluate(()=>!window.__cityCommands.some(c=>c.type==='stop_driving'&&['workspace_changed','focus_lost'].includes(c.reason))),'Inspection emitted an unintended stop');
  await page.locator('#driveTab').click();
  await page.evaluate(()=>{window.__cityState.safetySystem.active=true;window.__cityState.safetySystem.reason='Test live obstacle';});
  await page.waitForFunction(()=>document.getElementById('driveState').textContent==='Safety intervention');
  await page.evaluate(()=>{window.__cityState.safetySystem.active=false;});
  await page.waitForFunction(()=>document.getElementById('driveState').textContent==='Driving');
  check(await page.evaluate(()=>window.__cityCommands.filter(c=>c.type==='start_journey').length===1),'Clearing a transient safety intervention must not re-arm/reset navigation');
  await page.locator('#emergencyStopBtn').click();await page.waitForFunction(()=>window.__cityState.mode==='EMERGENCY_STOP');
  count=await page.evaluate(()=>window.__cityCommands.filter(c=>c.type==='journey_heartbeat').length);
  await page.waitForTimeout(450);
  check(await page.evaluate(n=>window.__cityCommands.filter(c=>c.type==='journey_heartbeat').length===n,count),'Emergency journey must not receive keepalive');
  await page.evaluate(()=>{window.__cityState.mode='PAUSED';window.__cityState.journey={status:'IDLE'};});
  await page.waitForFunction(()=>document.getElementById('startDrivingBtn').disabled===false);
  await page.locator('#startDrivingBtn').click();await page.waitForFunction(()=>window.__cityState.mode==='MANUAL');
  await page.evaluate(()=>window.dispatchEvent(new Event('blur')));
  await page.waitForFunction(()=>window.__cityState.mode==='PAUSED');
  check(await page.evaluate(()=>window.__cityCommands.some(c=>c.type==='stop_driving'&&c.reason==='focus_lost')),'Manual driving must stop on focus loss');
  check(errors.length===0,JSON.stringify(errors));
  return {passed:true,sizes,customCity:config,visibleJourneyContinues:true,manualFocusStop:true,emergencyLeaseStop:true,
    transientInterventionKeepsJourney:true,errors,commands:await page.evaluate(()=>window.__cityCommands),
    scope:'Browser-only fixture; no native spawn/driving commands reach CARLA'};
}
