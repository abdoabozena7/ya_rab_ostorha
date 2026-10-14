// playwright-cli run-code --filename scripts/verify_redesign_ui.js
// All API operations and sockets are intercepted. State is synthetic, the
// camera image is a previously saved CARLA frame, and screenshots are labelled.
async (page) => {
  const root='http://127.0.0.1:8000',errors=[],checks=[];
  const native=await(await page.request.get(root+'/api/simulation/state')).json();
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
    if(u.pathname.endsWith('/perception'))return route.fulfill({json:{status:'UNAVAILABLE',error:'Fixture has no perception inference'}});
    if(u.pathname.endsWith('/start'))return route.fulfill({json:{status:'STARTING'}});
    return route.fulfill({status:503,json:{error:'Isolated browser fixture: unsupported API'}});
  });
  const check=(v,m)=>{if(!v)throw new Error(m);checks.push(m);};
  const shot=async name=>{await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:'output/playwright/redesign-'+name+'.png',fullPage:true});};
  const waitText=async(selector,text)=>page.waitForFunction(({selector,text})=>document.querySelector(selector)?.textContent===text,{selector,text});
  await page.goto(root+'/?rehearsal=1');await waitText('#guidedPrimary','Take Vehicle Control');
  check(await page.getByRole('tab').count()===2,'Exactly two primary tabs');await shot('01-before-setup');
  await page.locator('#guidedPrimary').click();await waitText('#guidedPrimary','Choose on Map');
  await page.waitForFunction(()=>document.querySelector('#guidedPlaceResults button'));
  await page.locator('#guidedPlaceResults button').click();await waitText('#guidedPrimary','Configure Traffic');
  check(!await page.evaluate(()=>window.__redesign.commands.some(c=>c.type==='start_journey')),'Destination never starts movement');
  await page.locator('#guidedPrimary').click();await page.locator('[data-chaos="45"]').click();await page.locator('#guidedPrimary').click();await waitText('#guidedPrimary','Apply Road Traffic');
  check(!await page.evaluate(()=>window.__redesign.commands.some(c=>c.type==='crowd_route')),'Traffic choice is separate from apply');
  await page.locator('#guidedPrimary').click();await waitText('#guidedPrimary','Preparing road traffic…');check(await page.locator('#guidedPrimary').isDisabled(),'Pending preparation holds driving');
  await page.evaluate(()=>{const s=window.__redesign.state;s.population.actual.vehicles=11;s.population.npc_failed=1;s.dashboardResult={...s.dashboardResult,status:'REJECTED',error:'Only 11 of 12 vehicles could be placed.'};});
  await waitText('#guidedPrimary','Retry preparation');check(await page.locator('#guidedModeChoices').isHidden(),'Preparation failure blocks mode selection');
  await page.locator('#guidedPrimary').click();await page.evaluate(()=>window.__receipt());await waitText('#guidedPrimary','Start Driving');
  const before=await page.evaluate(()=>window.__redesign.commands.filter(c=>c.type==='start_journey').length);
  await page.locator('#guidedPrimary').click();await page.locator('#guidedModeChoices').waitFor({state:'visible'});
  check(await page.evaluate(()=>document.querySelector('#guidedPrimary').getBoundingClientRect().bottom<=innerHeight),'Mode choice fits without page scrolling');
  check(await page.locator('#guidedModeChoices [data-mode]').count()===2,'Start Driving reveals exactly two options');
  check(await page.evaluate(()=>window.__redesign.commands.filter(c=>c.type==='start_journey').length)===before,'Mode reveal sends no movement request');
  await shot('02-mode-choices');
  for(const [width,height] of [[390,844],[320,720]]){
    await page.setViewportSize({width,height});await page.locator('.studio-setup-dock').click();
    check(await page.evaluate(()=>{const box=document.getElementById('guidedDrive'),last=document.getElementById('normalModeBtn').getBoundingClientRect();return box.scrollHeight<=box.clientHeight+1&&last.bottom<=innerHeight;}),'Mobile mode choices fit the setup sheet without scrolling at '+width);
    if(width===390)await shot('13-mobile-mode-choices');
    await page.locator('.studio-setup-close').click();
  }
  for(const width of [1366,1024]){
    await page.setViewportSize({width,height:600});
    check(await page.evaluate(()=>{const box=document.getElementById('guidedDrive'),last=document.getElementById('normalModeBtn').getBoundingClientRect();return box.scrollHeight<=box.clientHeight+1&&last.bottom<=innerHeight&&document.documentElement.scrollHeight<=innerHeight+1;}),'Short desktop mode choices fit without scrolling at '+width);
  }
  await page.setViewportSize({width:1440,height:900});
  const initialImage=await page.locator('#authoritativeCamera').evaluate(e=>{window.__sameImage=e;return !e.hidden;});check(initialImage,'Saved real camera frame rendered by fixture');
  await page.locator('#robosphereModeBtn').click();await waitText('#guidedPrimary','Stop Driving');
  check(await page.evaluate(()=>window.__redesign.commands.find(c=>c.type==='start_journey').driving_mode)==='ROBOSPHERE','Protected card sends actual ROBOSPHERE command');
  check(await page.locator('#guidedActiveSummary').isVisible(),'Active journey collapses setup');await shot('03-active-protected');
  check(await page.evaluate(()=>{const camera=document.getElementById('frontCameraView').getBoundingClientRect(),map=document.getElementById('unifiedMap').getBoundingClientRect();return map.top>=camera.top&&map.top<camera.top+35&&map.right<=camera.right&&Math.abs(map.width-map.height)<2;}),'Round map stays inside the top of the simulation');
  await page.keyboard.press('m');check(await page.locator('#unifiedMap').evaluate(e=>e.classList.contains('map-expanded')),'M opens map details');
  await page.keyboard.press('m');check(await page.locator('#unifiedMap').evaluate(e=>!e.classList.contains('map-expanded')),'M closes map details');
  await page.keyboard.press('f');check(await page.locator('#cameraCard').evaluate(e=>e.classList.contains('camera-expanded')),'F expands simulation');
  check(await page.locator('#unifiedMap').isVisible()&&await page.locator('.prediction-label').first().isVisible(),'Fullscreen keeps map and prediction overlays');
  await page.keyboard.press('f');check(await page.locator('#cameraCard').evaluate(e=>!e.classList.contains('camera-expanded')),'F returns to cockpit');
  const stopsBeforeHelp=await page.evaluate(()=>window.__redesign.commands.filter(c=>c.type==='stop_driving').length);
  await page.keyboard.press('h');check(await page.locator('#studioShortcutDialog').isVisible(),'H opens shortcut guide');
  await page.keyboard.press('Escape');check(await page.locator('#studioShortcutDialog').isHidden(),'Escape closes shortcut guide');
  check(await page.evaluate(()=>window.__redesign.commands.filter(c=>c.type==='stop_driving').length)===stopsBeforeHelp,'Opening shortcut guide preserves autonomous driving');
  await page.locator('#modelVision>summary').click();check(await page.locator('#perceptionPanel').isVisible(),'Camera analysis opens over the viewport');await page.locator('#modelVision>summary').click();
  await page.waitForFunction(()=>document.getElementById('unifiedMapMeta').textContent.includes('CV fallback'));await shot('04-unified-map');
  await page.evaluate(()=>{const s=window.__redesign.state;window.__redesign.baseSafety=s.safetySystem;window.__redesign.baseVehicle={speedKmh:s.vehicle.speedKmh,speedMps:s.vehicle.speedMps,brake:s.vehicle.brake};
    s.vehicle.speedKmh=s.vehicle.speedMps=0;s.vehicle.brake=1;
    s.safetySystem={...s.safetySystem,status:'BRAKING',active:true,reason:'Measured forward obstacle',measured_range_m:.8,side_rear_observations:[{relation:'REAR_APPROACH',matched_frames:8,time_to_conflict_s:.4}]};
    s.stopDiagnostics={braking:true,decision_source:'RULE',reason:'Measured forward obstacle'};
    s.journeyComparison.runs.ROBOSPHERE={...window.__makeRun('ROBOSPHERE'),status:'RUNNING',collisions:2};});
  await page.waitForFunction(()=>document.getElementById('studioSafetyAlert').textContent.includes('front gap 0.8 m'));
  check(await page.locator('#studioSafetyAlert').textContent().then(v=>v.includes('holding to avoid a front collision')),'Rear approach cannot override measured front obstacle');
  check(await page.locator('.studio-kpis [data-index="5"] strong').textContent()==='2','Live native collision episodes are visible beside speed and clearance');
  await shot('14-rear-front-blocked');
  await page.setViewportSize({width:390,height:667});
  check(await page.evaluate(()=>document.documentElement.scrollHeight<=innerHeight+1),'Rear and front hazard status fits mobile without page scrolling');
  await shot('15-mobile-rear-front-blocked');
  await page.setViewportSize({width:1440,height:900});
  await page.evaluate(()=>{window.__redesign.state.journeyComparison.runs.ROBOSPHERE.setup.collision_measurement_available=false;});
  await waitText('.studio-kpis [data-index="5"] strong','—');
  check(await page.locator('.studio-kpis [data-index="5"] strong').textContent()==='—','Missing collision sensor never displays a false zero');
  await page.evaluate(()=>{const s=window.__redesign.state;s.safetySystem={...s.safetySystem,status:'MONITORING',active:false,measured_range_m:null};s.stopDiagnostics={braking:false};s.rearAssist=true;});
  await page.waitForFunction(()=>document.getElementById('studioSafetyAlert').textContent.includes('accelerating within target speed'));
  check(await page.locator('#studioSafetyAlert').getAttribute('data-tone')==='info','Safe rear response is presented as measured status');
  await page.evaluate(()=>{const s=window.__redesign.state;s.safetySystem=window.__redesign.baseSafety;s.stopDiagnostics=null;s.rearAssist=false;Object.assign(s.vehicle,window.__redesign.baseVehicle);delete s.journeyComparison.runs.ROBOSPHERE;});
  await page.locator('#unifiedMapToggle').click();
  check(await page.locator('#unifiedMapCanvas').evaluate(e=>e.getContext('2d').getImageData(Math.floor(e.width/2),Math.floor(e.height/2),1,1).data[3]===255),'Expanded map draws immediately without waiting for another telemetry frame');
  await page.locator('#unifiedMapActor').selectOption('42');await page.waitForFunction(()=>document.getElementById('unifiedActorInfo').textContent.includes('car #42'));
  check(await page.locator('#unifiedMapCanvas').evaluate(e=>e.width>=400),'Expanded map redraws native geometry at its wider aspect');
  await page.locator('[data-layer="route"]').click();check(await page.locator('[data-layer="route"]').getAttribute('aria-pressed')==='true','Layer control updates actual selection');
  await page.locator('[data-layer="both"]').click();await shot('05-expanded-map');
  check(await page.locator('#authoritativeCamera').evaluate(e=>e===window.__sameImage),'Map expansion keeps camera node');
  await page.locator('#expandUnifiedMap').click();
  await page.evaluate(()=>{window.__redesign.prediction='stale';});await page.waitForFunction(()=>document.getElementById('unifiedMapMeta').textContent.includes('stale'));
  check(await page.locator('#unifiedMapCanvas').isVisible(),'Route map survives stale prediction');
  await page.evaluate(()=>{window.__redesign.prediction='none';});await page.waitForFunction(()=>document.getElementById('unifiedMapMeta').textContent.includes('unavailable'));
  await page.evaluate(()=>{window.__redesign.prediction='fresh';});
  await page.locator('#guidedPrimary').click();await page.evaluate(()=>{const s=window.__redesign.state;s.route.arrived=true;s.journey={status:'ARRIVED',driving_mode:'ROBOSPHERE',pair_id:'fixture-pair'};s.journeyComparison={pair_id:'fixture-pair',conditions_match:false,runs:{ROBOSPHERE:window.__makeRun('ROBOSPHERE')}};});
  await page.locator('#guidedViewResults').waitFor({state:'visible'});await page.locator('#guidedViewResults').click();
  await page.waitForFunction(()=>document.querySelector('[data-mode="ROBOSPHERE"] .run-status').textContent==='Completed');
  check(await page.locator('.studio-run-panel[data-mode="NORMAL"] [data-field="collisions"] dd').textContent()==='—','Missing run is unavailable rather than zero');
  check(await page.locator('.studio-run-panel[data-mode="ROBOSPHERE"] [data-field="collisions"] dd').textContent()==='0','Recorded collision zero is preserved');await shot('06-one-missing');
  const starts=await page.evaluate(()=>window.__redesign.commands.filter(c=>c.type==='start_journey').length);
  await page.locator('.studio-run-panel[data-mode="NORMAL"] .run-mode-cta').click();
  await page.waitForFunction(()=>document.getElementById('normalModeBtn').getAttribute('aria-pressed')==='true'&&!document.getElementById('normalModeBtn').disabled);
  check(await page.evaluate(()=>window.__redesign.commands.some(c=>c.type==='prepare_journey_mode'&&c.value.mode==='NORMAL'&&c.value.pair_id==='fixture-pair')),'Missing arm restores saved pair through backend contract');
  check(await page.evaluate(()=>window.__redesign.commands.filter(c=>c.type==='start_journey').length)===starts,'Missing-arm recovery never starts movement');
  await page.locator('#normalModeBtn').click();await waitText('#guidedPrimary','Stop Driving');
  check(await page.evaluate(()=>window.__redesign.commands.filter(c=>c.type==='start_journey').at(-1).driving_mode)==='NORMAL','Normal card sends actual NORMAL command');
  await page.locator('#expandCameraBtn').click();check(await page.locator('#studioFullscreenEmergency').isEnabled(),'Expanded simulator retains emergency stop');await shot('08-expanded-simulator');
  await page.locator('#studioFullscreenEmergency').click();await waitText('#guidedPrimary','Acknowledge Emergency Stop');
  check(await page.evaluate(()=>window.__redesign.commands.some(c=>c.type==='emergency_stop')),'Emergency stop sends dedicated latch command');
  check(await page.locator('#studioFullscreenClose').isHidden(),'Emergency stop returns to Driving');await page.locator('#guidedPrimary').click();await page.waitForFunction(()=>window.__redesign.state.mode==='PAUSED');
  check(await page.evaluate(()=>window.__redesign.commands.filter(c=>c.type==='start_journey').length)===starts+1,'Emergency acknowledgement does not restart driving');
  await page.evaluate(()=>{window.__redesign.cameraFail=true;});await page.locator('[data-camera="hood"]').click();
  await page.waitForFunction(()=>document.getElementById('studioCameraStatus').textContent==='Changing camera…');
  check(await page.locator('[data-camera="front"]').getAttribute('aria-pressed')==='true','Camera stays on confirmed view while switch is pending');
  await page.waitForFunction(()=>document.getElementById('studioCameraStatus').textContent.includes('could not switch'));
  check(await page.locator('[data-camera="front"]').getAttribute('aria-pressed')==='true','Rejected camera switch restores confirmed selection');
  await page.evaluate(()=>{window.__redesign.cameraFail=false;});await page.locator('[data-camera="hood"]').click();
  await page.waitForFunction(()=>document.getElementById('studioCameraStatus').textContent==='Hood view applied');
  check(await page.locator('[data-camera="hood"]').getAttribute('aria-pressed')==='true','Applied camera view follows backend confirmation');
  await page.keyboard.press('c');await page.waitForFunction(()=>document.getElementById('studioCameraStatus').textContent==='Chase view applied');
  check(await page.locator('[data-camera="chase"]').getAttribute('aria-pressed')==='true','C cycles confirmed camera views');
  await page.locator('.studio-rail button[aria-label="Settings"]').click();
  check(await page.locator('.studio-rail').evaluate(e=>e.inert),'Settings make navigation inert');
  check(await page.locator('#settingsPanel #emergencyStopBtn').isVisible(),'Settings retain immediate emergency stop');await page.locator('#closeSettingsBtn').click();
  await page.locator('#interfaceMode').click();check(await page.locator('#advancedSetupDialog').isVisible(),'Research and manual controls open contextually');
  check(await page.locator('#advancedSetupEmergency').isVisible(),'Tools retain emergency stop');await page.locator('#closeAdvancedSetup').click();
  await page.locator('#interfaceMode').click();await page.locator('#cityChooseRoute').click();
  check(await page.locator('#advancedSetupDialog').isHidden()&&await page.locator('#routePanel').isVisible(),'Map launched from Tools remains interactive');await page.locator('#closeMapBtn').click();
  await page.locator('#interfaceMode').click();await page.locator('.normal-driving>summary').click();await page.locator('#setupDriveBtn').click();await page.locator('#startDrivingBtn').click();
  await page.waitForFunction(()=>window.__redesign.state.mode==='MANUAL');check(await page.locator('#advancedSetupDialog').isHidden(),'Manual enable returns to Driving without acceleration');
  await page.locator('.studio-rail button[aria-label="Settings"]').click();await page.waitForFunction(()=>window.__redesign.state.mode==='PAUSED');
  await page.locator('#populationSettings>summary').click();await page.locator('#settingSeed').fill('100');const pedalCount=await page.evaluate(()=>window.__redesign.commands.filter(c=>c.type==='controls').length);await page.keyboard.press('w');
  check(await page.evaluate(()=>window.__redesign.commands.filter(c=>c.type==='controls').length)===pedalCount,'Typing in settings never sends pedal controls');await page.locator('#closeSettingsBtn').click();
  await page.evaluate(()=>{const s=window.__redesign.state;s.journey={status:'ARRIVED',pair_id:'fixture-pair',driving_mode:'NORMAL'};s.route.arrived=true;s.journeyComparison.conditions_match=true;s.journeyComparison.runs.NORMAL=window.__makeRun('NORMAL');});
  await page.locator('#resultsTab').click();await page.waitForFunction(()=>document.getElementById('ordinaryComparisonTitle').textContent==='Both journeys complete');await shot('07-both-recorded');
  await page.locator('#studioResultDetailsBtn').click();await page.locator('.studio-provenance>summary').click();
  check(await page.locator('#studioResultDialog').isVisible()&&await page.locator('#ordinaryProvenance table').isVisible(),'Recorded conditions and archives open contextually');await page.locator('#studioResultDialogClose').click();
  await page.evaluate(()=>{window.__redesign.state.journeyComparison.conditions_match=false;});await page.waitForFunction(()=>document.getElementById('ordinaryComparisonHint').textContent.includes('unverified'));
  check(await page.locator('.metric-difference').allTextContents().then(v=>v.every(x=>!x)),'Mismatched setup suppresses differences');
  await page.evaluate(()=>{const r=window.__redesign.state.journeyComparison.runs.NORMAL;r.status='ERROR';r.collisions=null;});await page.waitForFunction(()=>document.querySelector('.studio-run-panel[data-mode="NORMAL"] .run-status').textContent==='Failed');
  check(await page.locator('.studio-run-panel[data-mode="NORMAL"] [data-field="collisions"] dd').textContent()==='—','Missing collision measurement stays unavailable');
  await page.evaluate(()=>{const s=window.__redesign.state;window.__savedRedesignPair=structuredClone(s.journeyComparison);s.journeyComparison.runs={};});
  await page.waitForFunction(()=>document.querySelectorAll('.studio-run-panel[data-empty="true"]').length===2);check(await page.locator('.studio-run-panel [data-field="collisions"] dd').allTextContents().then(v=>v.every(x=>x==='—')),'Neither run uses unavailable slots');
  await page.evaluate(()=>{window.__redesign.state.journeyComparison.runs={NORMAL:window.__makeRun('NORMAL')};});
  await page.waitForFunction(()=>document.querySelector('.studio-run-panel[data-mode="NORMAL"] .run-status').textContent==='Completed');check(await page.locator('.studio-run-panel[data-mode="ROBOSPHERE"] .run-mode-cta').isEnabled(),'Only Normal offers missing protected arm');
  await page.evaluate(()=>{window.__redesign.prepareFail=true;});await page.locator('.studio-run-panel[data-mode="ROBOSPHERE"] .run-mode-cta').click();
  await page.getByRole('button',{name:'Retry saved setup',exact:true}).waitFor({state:'visible'});check(await page.locator('#robosphereModeBtn').isDisabled(),'Rejected setup restoration keeps driving blocked');
  await page.evaluate(()=>{window.__redesign.prepareFail=false;});await page.getByRole('button',{name:'Retry saved setup',exact:true}).click();await page.waitForFunction(()=>!document.getElementById('robosphereModeBtn').disabled);
  check(await page.evaluate(()=>window.__redesign.state.mode==='PAUSED'),'Restoration retry leaves vehicle held');
  await page.evaluate(()=>{const s=window.__redesign.state;s.journeyComparison=window.__savedRedesignPair;s.journey={status:'ARRIVED',pair_id:'fixture-pair',driving_mode:'NORMAL'};s.route.arrived=true;});
  const layouts=[];
  for(const [width,height] of [[1440,900],[1366,768],[1366,600],[1024,768],[768,1024],[390,844],[390,667],[320,720]]){
    await page.setViewportSize({width,height});await page.locator('#resultsTab').click();
    check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Results fit '+width);
    check(await page.evaluate(()=>document.documentElement.scrollHeight<=innerHeight+1),'Results need no page scroll at '+width);
    check(await page.evaluate(()=>document.querySelector('.studio-run-panel:not([style*="display: none"])')?.getBoundingClientRect().bottom<=innerHeight+1),'Result panel remains inside viewport at '+width+'×'+height);
    if(width===390){await page.locator('[data-focus-mode="NORMAL"]').click();check(await page.locator('.studio-run-panel[data-mode="NORMAL"]').isVisible(),'Mobile mode switch reveals Normal results');await page.locator('[data-focus-mode="ROBOSPHERE"]').click();await page.locator('[data-result-view="safety"]').click();check(await page.locator('.studio-run-panel[data-mode="ROBOSPHERE"] [data-group="safety"]').first().isVisible(),'Safety measurements switch in place');await page.locator('[data-result-view="journey"]').click();}
    if(width===390)await shot('09-mobile-results');
    if(width>=768){const panels=await page.locator('.studio-run-panel').evaluateAll(es=>es.map(e=>e.getBoundingClientRect().top));check(panels[0]===panels[1],'Desktop comparison remains side by side at '+width);}
    await page.locator('#driveTab').click();check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Driving fits '+width);
    check(await page.evaluate(()=>document.documentElement.scrollHeight<=innerHeight+1),'Driving needs no page scroll at '+width);
    if(width===390){await page.locator('.studio-setup-dock').click();check(await page.locator('#guidedPrimary').isVisible(),'Mobile setup opens over the simulator');await page.locator('.studio-setup-close').click();await page.locator('.studio-rail button[aria-label="Settings"]').click();check(await page.locator('.studio-mobile-engine-stop').isVisible(),'Mobile settings preserve CARLA shutdown');await page.locator('#closeSettingsBtn').click();}
    if(width===390)await shot('10-mobile-driving');
    await page.locator('#expandCameraBtn').click();check(await page.locator('#studioFullscreenEmergency').isVisible(),'Expanded emergency reachable at '+width);await page.locator('#studioFullscreenClose').click();
    layouts.push({width,height,overflow:false});
  }
  await page.setViewportSize({width:1440,height:900});
  await page.evaluate(()=>{document.documentElement.dataset.appearance='dark';});
  await page.locator('#driveTab').click();
  await page.waitForFunction(()=>document.getElementById('unifiedMapCanvas').getContext('2d').getImageData(2,2,1,1).data[0]>180);
  check(await page.evaluate(()=>document.getElementById('unifiedMapCanvas').getContext('2d').getImageData(2,2,1,1).data[0]>180),'Map ground keeps the supplied warm palette');
  check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Dark Driving fits');await shot('11-dark-driving');
  await page.locator('#resultsTab').click();check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Dark Results fit');await shot('12-dark-results');
  await page.evaluate(()=>{document.documentElement.dataset.appearance='light';});
  await page.evaluate(()=>{window.__redesign.pausedFeed=true;});await page.waitForFunction(()=>document.getElementById('guidedPrimary').textContent==='Connect to Simulator');
  check(await page.locator('#guidedModeChoices').isHidden(),'Stale connection disables mode starts');
  await page.locator('#resultsTab').click();check(await page.locator('.studio-run-panel[data-mode="ROBOSPHERE"] [data-field="collisions"] dd').textContent()==='0','Saved results survive connection loss');
  await page.evaluate(()=>{window.__redesign.pausedFeed=false;});await page.locator('#driveTab').click();
  await page.evaluate(()=>{window.__redesign.state.connected=false;window.__redesign.state.mode='DISCONNECTED';window.__redesign.state.simulatorStop.status='STOPPED';});await waitText('#guidedPrimary','Start Simulation');
  check(errors.length===0,'No browser runtime errors: '+errors.join('; '));
  return {passed:true,checks,layouts,errors,native_mutations:0,camera:'saved CARLA frame; fixture screenshots labelled'};
}
