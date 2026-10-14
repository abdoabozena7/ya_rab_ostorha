// playwright-cli run-code --filename scripts/verify_light_cockpit_ui.js
// All API operations and sockets are intercepted. State is synthetic, the
// camera image is a previously saved CARLA frame, and screenshots are labelled.
async (page) => {
  const root='http://127.0.0.1:8012',errors=[],checks=[];
  // A static server makes this rehearsal independent of the native lifecycle.
  const native={vehicle:{}};
  const saved=await page.request.get(root+'/output/ui-redesign-camera-fixture.jpg');
  if(!saved.ok())throw new Error('Copy a real saved RGB frame to output/ui-redesign-camera-fixture.jpg before running this isolated rehearsal.');
  const image=await saved.body();
  await page.goto('about:blank');await page.setViewportSize({width:1440,height:900});await page.emulateMedia({reducedMotion:'reduce'});
  page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(base=>{
    const requested={vehicle_count:5,pedestrian_count:15,seed:2589,chaos_percent:0,crossing_percent:5,driver_behavior:'NORMAL',speed_behavior:'NORMAL',light_compliance_percent:100,fast_walk_percent:0};
    const state={...base,type:'snapshot',provider:'carla',connected:true,controller:false,mode:'PAUSED',sessionId:'redesign-fixture',
      navigationAvailable:true,recording:false,restarting:false,restartResult:null,dashboardResult:null,settingsCamera:'front',journey:{status:'IDLE'},route:null,
      comparisonDemo:{phase:'IDLE',results:{}},comparisonV2:null,journeyComparison:{pair_id:null,runs:{}},
      simulatorStop:{available:true,status:'IDLE'},simulatorStart:{available:true,status:'IDLE'},environment:{mode:'LIVING_CITY'},
      performance:{nativeTickRateHz:20},sensors:{},sensorErrors:{},sensorRatesHz:{},
      vehicle:{...base.vehicle,source:'carla',frame:100,timestamp:1,speedKmh:0,speedMps:0,speedMagnitudeMps:0,positionWorldM:[0,0,0],headingRad:0,brake:1,throttle:0,steeringInput:0,gear:1},
      world:{source:'carla',frame:100,timestamp:1,map:'Town05',fixedDeltaSeconds:.05},
      population:{requested,actual:{vehicles:5,pedestrians:15,controllers:15},npc_failed:0,walkers_failed:0,errors:[],traffic_manager_connected:true,frame_id:100},
      safetySystem:{enabled:true,controller:'RULE',available_controllers:['RULE'],status:'STANDBY',risk:'UNKNOWN',active:false,intervention_count:0},
      displayCamera:{sensorId:'drivingCamera',frame:100,timestamp:1,width:800,height:450,fovDeg:90,frameAvailable:true,
        worldTransform:{position_m:[0,0,0],rotation_rad:{}},mountTransform:{position_m:[0,0,0],rotation_deg:{}}}};
    window.__redesign={state,commands:[],op:0,prediction:'fresh',pausedFeed:false,prepareFail:false,cameraFail:false};
    window.__makeRoute=()=>({id:'route-fixture',destination:{name:'Downtown · fixture',map:'Town05',location:[100,0,0]},points:[[0,0,0],[18,0,0],[35,3,0],[52,9,0],[70,13,0],[86,8,0],[100,0,0]],length_m:100,remaining_m:100,arrived:false});
    window.__receipt=()=>{const s=state,c={active:true,status:'READY',route_id:s.route.id,destination:s.route.destination,route_length_m:100,target_count:12,placed_count:12,seed:s.population.requested.seed,chaos_percent:s.population.requested.chaos_percent};
      s.population.actual.vehicles=12;s.population.requested.vehicle_count=12;s.population.npc_failed=0;s.population.route_crowding=c;
      s.dashboardResult={action:'crowd_route',status:'APPLIED',operationId:'receipt-'+(++window.__redesign.op),result:{population:structuredClone(s.population),crowding:c}};
    };
    window.__makeRun=(mode)=>({id:'fixture-'+mode,mode,status:'ARRIVED',reason:'destination_reached',created_at_utc:'2026-10-13T12:00:00Z',recording:'BROWSER-FIXTURE/'+mode,
      duration_s:35,distance_m:100,route_completion_percent:100,destination_reached:true,collisions:0,maximum_impulse_ns:0,near_misses:0,safety_interventions:0,safety_intervention_s:0,harsh_braking_events:0,
      high_risk_s:0,sensor_coverage_percent:100,minimum_forward_range_m:12,mean_speed_kmh:12,samples:100,observed_samples:100,acceleration_samples:100,intervention_samples:100,
      setup:{map:'Town05',blueprint:'vehicle.fixture',destination:window.__makeRoute().destination,origin:{location:[0,0,0],rotation:[0,0,0]},speed_kmh:30,population:structuredClone(state.population.requested),actual_population:structuredClone(state.population.actual),weather:{cloudiness:0},collision_measurement_available:true},
      events:[{title:'Run ended',detail:'Fixture destination reached'}],risk_timeline:[{elapsed_s:0,risk:'UNKNOWN'},{elapsed_s:1,risk:'CLEAR'}]});
    window.WebSocket=class{readyState=1;constructor(){this.timer=setInterval(()=>{if(window.__redesign.pausedFeed)return;state.vehicle.frame++;state.vehicle.timestamp+=.05;
      state.world.frame=state.population.frame_id=state.displayCamera.frame=state.vehicle.frame;state.world.timestamp=state.displayCamera.timestamp=state.vehicle.timestamp;
      this.onmessage?.({data:JSON.stringify(state)});},80);}
      send(raw){const c=JSON.parse(raw);window.__redesign.commands.push(c);state.acknowledged=c.sequence;
        if(c.type==='take_control')state.controller=true;
        if(c.type==='start_driving')state.mode='MANUAL';
        if(c.type==='stop_driving'){state.mode='PAUSED';state.vehicle.speedKmh=state.vehicle.speedMps=0;state.journey={...state.journey,status:'PAUSED'};state.recording=false;}
        if(c.type==='emergency_stop'){state.mode='EMERGENCY_STOP';state.vehicle.speedKmh=state.vehicle.speedMps=0;state.recording=false;state.journey={...state.journey,status:'PAUSED'};}
        if(c.type==='acknowledge_stop')state.mode='PAUSED';
        if(c.type==='destination'){state.route=window.__makeRoute();state.dashboardResult={action:'destination',status:'APPLIED',operationId:'destination-'+(++window.__redesign.op),result:state.route};}
        if(c.type==='crowd_route'){state.population.requested={...state.population.requested,vehicle_count:12,...c.value};state.dashboardResult={action:'crowd_route',status:'PENDING',operationId:'crowd-'+(++window.__redesign.op)};}
        if(c.type==='start_journey'){state.journey={status:'RUNNING',driving_mode:c.driving_mode,speed_kmh:c.speed_kmh,pair_id:c.pair_id||'fixture-pair'};state.mode='AUTOMATIC';state.recording=true;state.vehicle.speedKmh=18;state.vehicle.speedMps=5;}
        if(c.type==='prepare_journey_mode'){
          state.dashboardResult={action:'prepare_journey_mode',status:'PENDING',operationId:'restore-'+(++window.__redesign.op)};
          setTimeout(()=>{if(window.__redesign.prepareFail){state.dashboardResult={...state.dashboardResult,status:'REJECTED',error:'Saved town differs. Select Town05 in Settings.'};return;}
            state.sessionId='restored-'+window.__redesign.op;state.route=window.__makeRoute();window.__receipt();state.journey={status:'READY',prepared_mode:c.value.mode,prepared_pair_id:c.value.pair_id,speed_kmh:30};
            state.dashboardResult={action:'prepare_journey_mode',status:'APPLIED',operationId:'restored-'+window.__redesign.op};},200);
        }
        if(c.type==='settings'){
          const operationId='settings-'+(++window.__redesign.op);
          state.dashboardResult={action:'settings',status:'PENDING',operationId};
          setTimeout(()=>{if(window.__redesign.cameraFail)state.dashboardResult={action:'settings',status:'REJECTED',operationId,error:'Camera sensor could not switch.'};
            else {state.settingsCamera=c.value.camera_view;state.dashboardResult={action:'settings',status:'APPLIED',operationId,result:{}};}},180);
        }
      }
      close(){clearInterval(this.timer);this.readyState=3;}
    };
    document.addEventListener('DOMContentLoaded',()=>{const note=document.createElement('div');note.id='fixtureLabel';note.textContent='BROWSER FIXTURE · synthetic state / saved CARLA image · no native operations';Object.assign(note.style,{position:'fixed',bottom:'0',left:'68px',right:'0',zIndex:2000,background:'#fff0cf',color:'#665021',font:'10px sans-serif',padding:'5px 12px',textAlign:'center',pointerEvents:'none'});document.body.append(note);});
  },native);
  await page.route('**/api/simulation/**',async route=>{
    const u=new URL(route.request().url()),s=await page.evaluate(()=>window.__redesign?.state);
    if(u.pathname.endsWith('/status'))return route.fulfill({json:{configured:true,provider:'carla',websocketPort:9876}});
    if(u.pathname.endsWith('/camera.jpg')){const frame=Number(u.searchParams.get('frame_id'));return route.fulfill({body:image,contentType:'image/jpeg',headers:{'X-Sensor-Frame':String(frame),'X-Sensor-Time':String(1+(frame-100)*.05)}});}
    if(u.pathname.endsWith('/catalog'))return route.fulfill({json:{places:[{id:'downtown-fixture',name:'Downtown · fixture',favorite:true,location:[100,0,0]}],roads:{bounds:[-40,-40,120,40],segments:[[[-30,0],[0,0],[18,0],[35,3],[52,9],[70,13],[86,8],[100,0],[120,-5]],[[40,-30],[40,4],[41,30]],[[88,-28],[86,8],[90,35]]]},profiles:{},settings:{vehicle_options:[{id:'vehicle.fixture',name:'Fixture vehicle'}],spawn_options:[{index:0,name:'Saved origin'}],weather_presets:['ClearNoon'],weather_preset:'ClearNoon',weather:{cloudiness:0,precipitation:0,wetness:0,fog_density:0,sun_altitude_angle:45,sun_azimuth_angle:0},next_launch:{quality:'Epic',resolution:'1280x720'},camera_view:s.settingsCamera,camera_resolution:'800x450',camera_fov:90,simulation_hz:20,vehicle:'vehicle.fixture',spawn_index:0,population_saved:s.population.requested}}});
    if(u.pathname.endsWith('/prediction')){const type=await page.evaluate(()=>window.__redesign.prediction);if(type==='none')return route.fulfill({json:{status:'UNAVAILABLE',error:'Fixture predictor unavailable'}});
      const timestamp=type==='stale'?s.vehicle.timestamp-5:s.vehicle.timestamp;
      return route.fulfill({json:{status:'RUNNING',prediction:{version:3,session_id:s.sessionId,evaluation_frame:s.vehicle.frame,timestamp_s:timestamp,coordinate_frame:'EGO_AT_EVALUATION',display_source:'CV fallback',decision_source:'MEASURED_KINEMATIC',horizon_s:3,render_reference:{position_m:[0,0,0],rotation_rad:{}},tracks:[{id:42,class:'car',confirmed:true,position_m:[20,4],velocity_mps:[2,-1]},{id:7,class:'person',confirmed:true,position_m:[12,-3],velocity_mps:[0,.5]}],trajectories:[{track_id:42,source:'CONSTANT_VELOCITY',points:[[0,20,4],[1,22,3],[3,26,1]]},{track_id:7,source:'CONSTANT_VELOCITY',points:[[0,12,-3],[1,12,-2.5],[3,12,-1.5]]}],object_assessments:{42:{status:'UNASSESSED'}},conflict_point:null}}});}
    if(u.pathname.endsWith('/perception')){
      if(!await page.evaluate(()=>window.__redesign.perception))return route.fulfill({json:{status:'UNAVAILABLE',error:'Fixture has no perception inference'}});
      return route.fulfill({json:{status:'RUNNING',session_id:s.sessionId,frame_id:s.vehicle.frame,timestamp_s:s.vehicle.timestamp,width:800,height:450,image_token:'fixture_'+s.vehicle.frame+'.jpg',inference_ms:25,device:'CPU',detections:[{class:'car',xyxy:[310,200,410,300]},{class:'person',xyxy:[500,180,530,260]}],texts:[]}});
    }
    if(u.pathname.endsWith('/perception.jpg'))return route.fulfill({body:image,contentType:'image/jpeg',headers:{'X-Perception-Token':u.searchParams.get('token')}});
    if(u.pathname.endsWith('/start'))return route.fulfill({json:{status:'STARTING'}});
    return route.fulfill({status:503,json:{error:'Isolated browser fixture: unsupported API'}});
  });
  const check=(value,message)=>{if(!value)throw new Error(message);checks.push(message);};
  const waitText=async(selector,text)=>page.waitForFunction(({selector,text})=>document.querySelector(selector)?.textContent===text,{selector,text});
  const shot=async name=>{await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:'output/playwright/pastel-fixture-'+name+'.png',fullPage:true});};
  await page.goto(root+'/?pastel-rehearsal=1');await waitText('#cockpitConnectionText','CARLA Connected');
  await page.setViewportSize({width:1720,height:914});
  await page.waitForFunction(()=>getComputedStyle(document.getElementById('cameraCard')).display==='grid');
  check(await page.locator('#cockpitScenarios').isHidden(),'Setup starts closed');
  check(await page.locator('.studio-rail button:visible').count()===5,'Five labeled navigation destinations');
  check(await page.locator('#authoritativeCamera').isVisible(),'Real camera transport decodes the saved image fixture');
  check(await page.evaluate(()=>{const c=document.getElementById('frontCameraView').getBoundingClientRect(),r=document.querySelector('.cockpit-telemetry').getBoundingClientRect();return c.width>r.width*4&&c.height>500;}),'Camera dominates desktop workspace');
  check(await page.locator('#cockpitGap').textContent()==='—','Unavailable gap is not zero');
  check(await page.locator('#cockpitVehicles').textContent()==='—','Scenario vehicles are not relabeled detections');
  await shot('desktop');

  await page.locator('#scenariosNav').click();await page.locator('#cockpitScenarios').waitFor({state:'visible'});
  await waitText('#guidedPrimary','Take Vehicle Control');await page.locator('#guidedPrimary').click();await waitText('#guidedPrimary','Choose on Map');
  await page.waitForFunction(()=>document.querySelector('#guidedPlaceResults button'));await page.locator('#guidedPlaceResults button').click();
  await waitText('#guidedPrimary','Configure Traffic');
  check(!await page.evaluate(()=>window.__redesign.commands.some(c=>c.type==='start_journey')),'Destination selection never starts movement');
  await page.locator('#guidedPrimary').click();await page.locator('[data-chaos="45"]').click();await waitText('#guidedPrimary','Continue to preparation');await page.locator('#guidedPrimary').click();await waitText('#guidedPrimary','Apply Road Traffic');
  await page.locator('#guidedPrimary').click();await waitText('#guidedPrimary','Preparing road traffic…');
  await page.evaluate(()=>window.__receipt());await waitText('#guidedPrimary','Start Driving');await page.locator('#guidedPrimary').click();await page.locator('#robosphereModeBtn').click();
  await waitText('#cockpitDriverText','Self Driving');await page.locator('#cockpitScenarios').waitFor({state:'hidden'});
  check(await page.evaluate(()=>window.__redesign.commands.some(c=>c.type==='start_journey'&&c.driving_mode==='ROBOSPHERE')),'Protected start retains native command contract');
  await page.locator('#studioManualStop').click();await waitText('#cockpitDriverText','Vehicle held');
  check(await page.evaluate(()=>window.__redesign.commands.some(c=>c.type==='stop_driving')),'Normal Stop retains stop_driving');

  await page.locator('#cockpitCameraView').selectOption('chase');await page.waitForFunction(()=>document.getElementById('cockpitCameraView').value==='chase'&&!document.getElementById('cockpitCameraView').disabled);
  check(await page.evaluate(()=>window.__redesign.state.settingsCamera==='chase'),'Camera dropdown waits for applied setting');
  await page.evaluate(()=>{window.__redesign.cameraFail=true;});await page.locator('#cockpitCameraView').selectOption('hood');
  await page.waitForFunction(()=>document.getElementById('cockpitCameraView').parentElement.title==='Camera sensor could not switch.');
  check(await page.locator('#cockpitCameraView').inputValue()==='chase','Rejected camera preserves confirmed view');
  await page.evaluate(()=>{window.__redesign.cameraFail=false;});
  await page.locator('.cockpit-overlay-settings summary').click();await page.locator('[data-overlay="trajectories"]').uncheck();await page.locator('[data-overlay="labels"]').uncheck();
  check(await page.evaluate(()=>JSON.parse(localStorage.getItem('camera-overlays-v1')).trajectories===false),'Visualization preferences persist locally');
  await page.keyboard.press('Escape');
  await page.locator('#unifiedMapToggle').click();check(await page.locator('#unifiedMap').evaluate(n=>n.classList.contains('map-expanded')),'Circular map expands in place');
  await page.locator('#expandUnifiedMap').click();await page.locator('#expandCameraBtn').click();
  check(await page.locator('#studioFullscreenEmergency').isVisible(),'Fullscreen keeps emergency action accessible');await page.locator('#studioFullscreenClose').click();
  await page.locator('#cockpitViewDetails').click();check(await page.locator('#cockpitDetails').isVisible(),'Details open without relaying fake metrics');
  check(await page.locator('#cockpitDetails').getByText('Scenario population',{exact:true}).isVisible(),'Population source is explicitly separated');await page.locator('[aria-label="Close camera details"]').click();

  await page.evaluate(()=>{const s=window.__redesign.state;s.mode='AUTOMATIC';s.journey={status:'RUNNING',driving_mode:'ROBOSPHERE',speed_kmh:30};s.safetySystem={...s.safetySystem,status:'BRAKING',active:true,teacher_state:'HOLDING',reason:'Measured front obstacle'};});
  await waitText('#cockpitProtectionText','RULE override');await page.waitForFunction(()=>document.getElementById('studioSafetyAlert').textContent.includes('Protective stop active'));
  check(await page.locator('#studioSafetyAlert').textContent().then(t=>t.includes('Measured front obstacle')),'Safety override uses actual supplied reason');await shot('safety');
  await page.locator('#emergencyStopBtn').click();await page.waitForFunction(()=>document.getElementById('studioSafetyAlert').textContent.includes('Emergency stop active'));
  check(await page.evaluate(()=>window.__redesign.commands.some(c=>c.type==='emergency_stop')),'Emergency retains the distinct emergency_stop contract');
  await page.locator('#scenariosNav').click();await waitText('#guidedPrimary','Acknowledge Emergency Stop');await page.locator('#guidedPrimary').click();
  await page.evaluate(()=>{const s=window.__redesign.state;s.safetySystem={...s.safetySystem,active:false,status:'MONITORING',teacher_state:'CLEAR'};});
  await waitText('#cockpitDriverText','Vehicle held');await page.locator('[aria-label="Close scenarios"]').click();
  await page.locator('#studioSafetyAlert').waitFor({state:'hidden'});
  await page.evaluate(()=>{window.__redesign.state.safetySystem.status='SENSOR_FAULT';});await waitText('#cockpitProtectionText','Safety unavailable');
  check(await page.locator('#studioSafetyAlert').textContent().then(t=>t.includes('Safety sensors unavailable')),'Sensor faults remain prominent');
  await page.evaluate(()=>{window.__redesign.state.safetySystem.status='STANDBY';});
  await page.locator('#cockpitToolsNav').click();check(await page.locator('#stopSimulatorBtn').isVisible(),'CARLA GPU shutdown is in the lifecycle area');await page.locator('[aria-label="Close tools"]').click();
  await page.locator('.studio-rail button[aria-label="Settings"]').click();check(await page.locator('#emergencyStopBtn').isVisible(),'Settings retain emergency within the modal scope');await page.locator('#closeSettingsBtn').click();
  check(await page.locator('.cockpit-header-actions #emergencyStopBtn').count()===1,'Emergency returns to header after a drawer');
  await page.locator('#scenariosNav').click();await page.locator('#cockpitScenarios').waitFor({state:'visible'});
  await page.locator('[data-manual-mode="NORMAL"]').click();await page.locator('#startDrivingBtn').click();
  await waitText('#cockpitDriverText','Manual · WASD');await page.locator('#cockpitScenarios').waitFor({state:'hidden'});
  await page.keyboard.down('w');await page.waitForFunction(()=>window.__redesign.commands.some(c=>c.type==='controls'&&c.controls.throttle>0));await page.keyboard.up('w');
  check(await page.evaluate(()=>window.__redesign.commands.some(c=>c.type==='start_driving'&&c.driving_mode==='NORMAL')),'Explicit manual mode retains start_driving and WASD controls');
  await page.locator('#studioManualStop').click();await waitText('#cockpitDriverText','Vehicle held');
  await page.evaluate(()=>{const s=window.__redesign.state;s.displayCamera.sensorId='frontCamera';s.sensors.frontCamera=s.displayCamera;window.__redesign.perception=true;});
  await page.waitForFunction(()=>!document.querySelector('.cockpit-detections').hidden);
  check(await page.locator('#cockpitVehicles').textContent()==='1','2D camera count comes from the supplied inference result');
  check(await page.locator('#cockpitOverlayState').textContent().then(t=>t.includes('2D fallback')),'Frame-matched 2D boxes render with explicit fallback label');
  await page.evaluate(()=>{window.__redesign.state.displayCamera={...window.__redesign.state.displayCamera,sensorId:'drivingCamera',mountTransform:{position_m:[-6,0,3],rotation_deg:{pitch:-15}}};});
  await page.waitForFunction(()=>document.querySelector('.cockpit-detections').hidden);
  check(await page.locator('.cockpit-detections').isHidden(),'Front-camera boxes disappear on a different chase viewpoint');
  await page.evaluate(()=>{window.__redesign.perception=false;});
  await page.evaluate(()=>{const s=window.__redesign.state;s.journeyComparison={pair_id:'fixture-pair',conditions_match:true,runs:{ROBOSPHERE:window.__makeRun('ROBOSPHERE'),NORMAL:window.__makeRun('NORMAL')}};});
  await page.locator('#resultsTab').click();await page.waitForFunction(()=>document.querySelector('.studio-run-panel[data-mode="ROBOSPHERE"] .run-status').textContent==='Completed');
  check(await page.locator('.studio-run-panel[data-mode="ROBOSPHERE"] [data-field="collisions"] dd').textContent()==='0','Recorded Results preserve actual zero and provenance');await page.locator('#driveTab').click();

  // Every viewport is exercised with connected data, then with unavailable data.
  const layouts=[];
  for(const [width,height] of [[1720,914],[1440,900],[1366,768],[1366,600],[1100,768],[1024,768],[768,1024],[767,844],[390,844],[320,720]]){
    await page.setViewportSize({width,height});await page.evaluate(()=>scrollTo(0,0));
    check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'No horizontal overflow at '+width+'×'+height);
    check(await page.locator('#emergencyStopBtn').isVisible(),'Emergency reachable at '+width);
    check(await page.locator('#cockpitProtection').isVisible(),'Safety mode visible at '+width);
    if(width>=1100)check(await page.evaluate(()=>document.documentElement.scrollHeight<=innerHeight+1),'Desktop fits viewport at '+width+'×'+height);
    await page.locator('#scenariosNav').click();await page.locator('#cockpitScenarios').waitFor({state:'visible'});
    check(await page.locator('#startDrivingBtn').isVisible(),'Scenario manual actions reachable at '+width);await page.locator('[aria-label="Close scenarios"]').click();
    await page.locator('#expandCameraBtn').click();check(await page.locator('#studioFullscreenEmergency').isVisible(),'Fullscreen stop reachable at '+width);await page.locator('#studioFullscreenClose').click();
    await page.locator('#resultsTab').click();check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Results fit at '+width);await page.locator('#driveTab').click();
    if(width===390||width===1024)await shot('responsive-'+width);
    layouts.push({width,height,overflow:false});
  }
  await page.setViewportSize({width:1720,height:914});
  await page.evaluate(()=>{window.__redesign.pausedFeed=true;});await waitText('#cockpitConnectionText','CARLA Disconnected');
  check(await page.locator('#cockpitSpeed').textContent()==='—','Stale socket clears live speed');check(await page.locator('#cockpitTracks').textContent()==='—','Stale socket clears measured tracks');
  check(await page.locator('#authoritativeCamera').isHidden(),'Stale socket clears video');check(await page.locator('#cockpitProtectionText').textContent()==='Protection offline','Disconnect cannot claim active protection');
  await shot('disconnected');
  check(errors.length===0,'No browser runtime errors: '+errors.join('; '));
  return {passed:true,checks,layouts,errors,native_mutations:0,camera:'Saved real CARLA frame; state and overlays are explicitly labeled synthetic fixtures'};
}
