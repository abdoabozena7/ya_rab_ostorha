// playwright-cli run-code --filename scripts/verify_guided_drive_ui.js
// Real application assets; all mutations terminate in a browser-only sink.
async (page) => {
  const native=await (await page.request.get('http://127.0.0.1:8000/api/simulation/state')).json(),errors=[];
  await page.goto('about:blank');
  page.on('pageerror',error=>errors.push(error.message));
  await page.setViewportSize({width:1440,height:900});
  await page.addInitScript(snapshot=>{
    localStorage.setItem('ostorha.uiMode','advanced');
    Object.assign(snapshot,{type:'snapshot',connected:true,controller:false,mode:'PAUSED',provider:'carla',sessionId:'guided-fixture',
      recording:false,journey:{status:'IDLE'},route:null,sensors:{},sensorErrors:{},comparisonV2:null,navigationAvailable:true,
      comparisonDemo:{phase:'IDLE',results:{}},environment:{mode:'LIVING_CITY'},dashboardResult:null});
    snapshot.vehicle={...snapshot.vehicle,source:'carla',frame:100,timestamp:1,speedMps:0,speedMagnitudeMps:0,speedKmh:0,throttle:0,brake:1};
    snapshot.world={source:'carla',frame:100,timestamp:1};
    snapshot.simulatorStop={available:true,status:'IDLE'};snapshot.simulatorStart={available:true,status:'IDLE'};
    snapshot.population={...snapshot.population,requested:{...snapshot.population?.requested,vehicle_count:5},
      actual:{vehicles:5,pedestrians:30,controllers:30},npc_failed:0,walkers_failed:0,errors:[],traffic_manager_connected:true};
    snapshot.safetySystem={enabled:true,controller:'RULE',available_controllers:['RULE'],status:'STANDBY',risk:'UNKNOWN',intervention_count:0};
    window.__guidedState=snapshot;window.__guidedCommands=[];window.__guidedOperation=0;
    window.WebSocket=class{
      readyState=1;
      constructor(){this.timer=setInterval(()=>{const s=window.__guidedState;s.vehicle.frame++;s.vehicle.timestamp+=.05;
        s.world.frame=s.population.frame_id=s.vehicle.frame;s.world.timestamp=s.vehicle.timestamp;this.onmessage?.({data:JSON.stringify(s)});},80);}
      send(raw){const c=JSON.parse(raw),s=window.__guidedState;window.__guidedCommands.push(c);s.acknowledged=c.sequence;
        if(c.type==='take_control')s.controller=true;
        if(c.type==='stop_driving')s.mode='PAUSED';
        if(c.type==='crowd_route'){s.population.requested={...s.population.requested,vehicle_count:23,seed:c.value.seed,chaos_percent:c.value.chaos_percent};s.dashboardResult={action:'crowd_route',status:'PENDING',operationId:'guided-'+(++window.__guidedOperation)};}
        if(c.type==='start_journey'){s.mode='AUTOMATIC';s.journey={status:'RUNNING'};}
      }
      close(){clearInterval(this.timer);this.readyState=3;}
    };
  },native);
  await page.route('**/api/simulation/perception',route=>route.fulfill({json:{status:'UNAVAILABLE',error:'Browser-only flow verification'}}));
  await page.route('**/api/simulation/prediction',route=>route.fulfill({json:{status:'WAITING',error:'Browser-only flow verification'}}));
  await page.goto('http://127.0.0.1:8000/?mode=guided&rehearsal=1');
  const check=(v,m)=>{if(!v)throw new Error(m);};
  await page.waitForFunction(()=>document.getElementById('guidedPrimary').textContent==='Take vehicle control');
  await page.locator('#guidedPrimary').click();
  await page.waitForFunction(()=>document.getElementById('guidedPrimary').textContent.includes('Choose destination'));
  check(!(await page.evaluate(()=>window.__guidedCommands.some(c=>c.type==='crowd_route'))),'No traffic spawn before destination');
  await page.locator('#guidedPrimary').click();
  check(await page.locator('#routePanel').isVisible(),'Destination step opens the real map tool');
  await page.locator('#closeMapBtn').click();
  await page.evaluate(()=>{window.__guidedState.route={id:'road-one',destination:{name:'Browser fixture route',map:'Town',location:[200,0,0]},points:[[0,0],[200,0]],length_m:200,remaining_m:200,arrived:false};});
  await page.waitForFunction(()=>document.getElementById('guidedPrimary').textContent==='Make your road crowded');
  await page.locator('#guidedPrimary').click();
  await page.waitForFunction(()=>!document.getElementById('guidedBehaviour').hidden);
  await page.waitForFunction(()=>document.getElementById('guidedPrimary').textContent==='Apply traffic & continue' && document.activeElement.id==='guidedChaos');
  check(await page.evaluate(()=>document.querySelector('[data-step="behaviour"]').getAttribute('aria-current')==='step'),'Behaviour must be a distinct next step');
  check(await page.locator('#guidedJourneyOptions').isHidden(),'Journey speed should wait for the driving step');
  check(!(await page.evaluate(()=>window.__guidedCommands.some(c=>c.type==='crowd_route'))),'Crowding first reveals behaviour');
  await page.locator('[data-chaos="45"]').click();await page.locator('#guidedSeed').fill('987');
  await page.screenshot({path:'output/playwright/guided-behaviour.png'});
  await page.locator('#guidedPrimary').click();
  await page.waitForFunction(()=>window.__guidedCommands.some(c=>c.type==='crowd_route'));
  await page.waitForFunction(()=>document.getElementById('guidedPrimary').textContent==='Crowding your road…');
  check(await page.locator('#guidedPrimary').isDisabled(),'Pending native placement holds driving');
  const applyRoad=async(count,failed=23-count)=>page.evaluate(({count,failed})=>{const s=window.__guidedState;s.population.actual.vehicles=count;s.population.npc_failed=failed;
    const c={active:true,status:count===23?'READY':'PARTIAL',route_id:s.route.id,destination:s.route.destination,route_length_m:200,
      target_count:23,placed_count:count,seed:987,chaos_percent:45};s.population.route_crowding=c;
    s.dashboardResult={...s.dashboardResult,status:'APPLIED',result:{population:structuredClone(s.population),crowding:c}};
  },{count,failed});
  await applyRoad(22);
  await page.waitForFunction(()=>document.getElementById('guidedStatus').textContent.includes('22/23'));
  check(!(await page.evaluate(()=>window.__guidedCommands.some(c=>c.type==='start_journey'))),'Partial native placement must not start');
  check(await page.locator('#guidedBehaviour').isVisible(),'Failed placement keeps the settings open');
  check(await page.locator('#guidedSeed').inputValue()==='987','Retry preserves the chosen seed');
  check(await page.locator('#guidedPrimary').textContent()==='Retry traffic & continue','Retry must have a clear next action');
  await page.locator('#guidedPrimary').click();
  await page.waitForFunction(()=>window.__guidedCommands.filter(c=>c.type==='crowd_route').length===2);
  await applyRoad(22,0);
  await page.waitForFunction(()=>document.getElementById('guidedStatus').textContent.includes('Waiting for native traffic confirmation'));
  check(await page.locator('#guidedPrimary').isDisabled(),'A late native frame keeps driving held without requesting more cars');
  await page.evaluate(()=>{const s=window.__guidedState;s.population.actual.vehicles=23;
    s.population.route_crowding={...s.population.route_crowding,status:'READY',placed_count:23};});
  await page.waitForFunction(()=>document.getElementById('guidedPrimary').textContent.includes('Start driving'));
  await page.waitForFunction(()=>document.activeElement.id==='guidedPrimary');
  check(await page.locator('#guidedJourneyOptions').isVisible(),'Journey options appear at the driving step');
  const admittedFrame=await page.evaluate(()=>{const s=window.__guidedState;s.population.actual.vehicles=22;s.population.npc_failed=1;
    s.population.route_crowding={...s.population.route_crowding,status:'PARTIAL',placed_count:22};return s.vehicle.frame;});
  await page.waitForFunction(frame=>window.__guidedState.vehicle.frame>frame+12,admittedFrame);
  check((await page.locator('#guidedPrimary').textContent()).includes('Start driving'),'Traffic recycling must not rewind completed setup');
  check(await page.locator('#modelVision').isVisible(),'Model view must be visible without opening a sidebar');
  const positions=await page.evaluate(()=>{const a=document.getElementById('frontCameraView').getBoundingClientRect(),b=document.getElementById('modelVision').getBoundingClientRect();return {a:a.right,b:b.left};});
  check(positions.a<=positions.b,'Camera and model view must be side by side');
  await page.screenshot({path:'output/playwright/guided-ready.png'});
  await page.locator('#guidedPrimary').click();await page.waitForFunction(()=>window.__guidedCommands.some(c=>c.type==='start_journey'));
  await page.waitForFunction(()=>document.getElementById('guidedPrimary').textContent==='Stop driving');
  await page.locator('#guidedPrimary').click();
  await page.waitForFunction(()=>window.__guidedState.mode==='PAUSED');
  await page.evaluate(()=>{window.__guidedState.route={...window.__guidedState.route,id:'road-two',destination:{map:'Town',location:[500,0,0],name:'Another destination'}};});
  await page.waitForFunction(()=>document.getElementById('guidedPrimary').textContent==='Make your road crowded');
  await page.locator('#interfaceMode').click();
  check(await page.locator('#setupTab').isVisible(),'Previous advanced workspace remains available');
  await page.locator('#interfaceMode').click();
  check(await page.evaluate(()=>localStorage.getItem('ostorha.uiMode')==='advanced'),'Rehearsal must preserve the saved UI mode');
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:'output/playwright/guided-mobile.png'});
  check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Mobile must have no horizontal overflow');
  const commands=await page.evaluate(()=>window.__guidedCommands);
  check(commands.filter(c=>c.type==='crowd_route').every(c=>c.value.route_id==='road-one'&&c.value.chaos_percent===45&&c.value.seed===987&&!('vehicle_count' in c.value)),'Route, randomness and seed must reach native contract without a fixed count');
  check(errors.length===0,JSON.stringify(errors));
  return {passed:true,native_mutations:0,ownership_step:true,behaviour_before_spawn:true,partial_spawn_held:true,
    sequence_complete:true,clear_behaviour_step:true,focus_advances:true,delayed_admission_waited:true,confirmed_step_survives_recycling:true,destination_first:true,new_destination_invalidates:true,adaptive_count:true,advanced_retained:true,preferences_unchanged:true,mobile_overflow:false,errors,commands};
}
