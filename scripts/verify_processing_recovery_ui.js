// playwright-cli run-code --filename scripts/verify_processing_recovery_ui.js
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

  await page.goto(root+'/?braking-rehearsal=1');
  await waitText('#cockpitConnectionText','CARLA Connected');
  await page.evaluate(()=>{
    const s=window.__redesign.state;s.controller=true;s.mode='AUTOMATIC';
    s.journey={status:'RUNNING',driving_mode:'ROBOSPHERE',speed_kmh:30};
    s.vehicle.brake=.2;
    s.stopDiagnostics={braking:true,decision_source:'RULE',reason:'Braking toward measured coverage speed limit 3.04 m/s'};
    s.safetySystem={...s.safetySystem,status:'COVERAGE_LIMITED',active:true,reason:s.stopDiagnostics.reason};
  });
  await page.waitForFunction(()=>document.getElementById('cockpitBrakeReason').textContent.includes('coverage speed limit 3.04'));
  check(await page.locator('#studioManualStop').textContent().then(t=>t.includes('Stop vehicle')),'Clear ordinary stop label');
  check(await page.locator('#emergencyStopBtn').textContent()==='Emergency stop','Clear emergency label');
  check(await page.locator('#cockpitBrakeReason').isVisible(),'Applied brake reason visible beside percentage');
  await page.locator('#emergencyStopBtn').click();
  await page.waitForFunction(()=>document.getElementById('acknowledgeStopBtn').hidden===false);
  check(await page.locator('.cockpit-header-actions #acknowledgeStopBtn').count()===1,'Release action in the main header');
  check(await page.locator('#acknowledgeStopBtn').textContent()==='Release emergency stop','Clear emergency release label');
  for(const [width,height] of [[1720,914],[1440,900],[1366,768],[1100,768],[1024,768],[768,1024],[390,844],[320,720]]){
    await page.setViewportSize({width,height});
    check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Emergency: no horizontal overflow at '+width);
    check(await page.locator('#acknowledgeStopBtn').isVisible(),'Release button visible at '+width);
    check(await page.locator('#emergencyStopBtn').isVisible(),'Emergency button visible at '+width);
    if(width===1440||width===390)await page.screenshot({path:'output/playwright/braking-repair-emergency-'+width+'.png',fullPage:true});
  }
  await page.setViewportSize({width:1440,height:900});
  await page.locator('#acknowledgeStopBtn').click();
  await waitText('#cockpitDriverText','Vehicle held');
  check(await page.evaluate(()=>window.__redesign.commands.some(c=>c.type==='acknowledge_stop')),'Explicit release sends acknowledge_stop');
  check(await page.locator('#acknowledgeStopBtn').isHidden(),'Release action disappears after acknowledgement');
  check(await page.evaluate(()=>!window.__redesign.commands.some(c=>c.type==='start_driving'||c.type==='start_journey')),'Release does not restart movement');
  await page.evaluate(()=>{
    const s=window.__redesign.state;s.mode='MANUAL';s.manualDrivingMode='NORMAL';
    s.safetySystem={...s.safetySystem,status:'STANDARD_DRIVER',active:false,enabled:false,actual_generator:'BASE_DRIVER'};
    s.stopDiagnostics={braking:false,decision_source:'DRIVER',reason:'MANUAL'};s.vehicle.brake=0;
  });
  await waitText('#cockpitProtectionText','Normal · protection off');
  await page.waitForFunction(()=>document.getElementById('studioManualContext').textContent==='Normal · obstacle protection off');
  check(await page.locator('#cockpitBrakeReason').textContent()==='DRIVER · MANUAL','Normal displays driver command provenance');

  await page.evaluate(()=>{
    const s=window.__redesign.state;s.mode='PAUSED';s.route=window.__makeRoute();
    s.journey={status:'PAUSED',reason:'focus_lost',speed_kmh:30,driving_mode:'ROBOSPHERE'};
    s.lastDriveStop={status:'ERROR',detail:'Safety processing exceeded sensor wall freshness limit'};
    s.stopDiagnostics={braking:true,decision_source:'VEHICLE_HOLD',reason:'focus_lost'};s.vehicle.brake=1;
    s.safetySystem={...s.safetySystem,active:false,status:'STANDBY'};
  });
  await page.locator('#cockpitResumeDrive').waitFor({state:'visible'});
  check(await page.locator('.notice-copy p').textContent().then(t=>t.includes('processing exceeded')),'Original processing failure survives focus loss');
  for(const [width,height] of [[1440,900],[1366,768],[1100,768],[390,844],[320,720]]){
    await page.setViewportSize({width,height});
    check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Resume: no horizontal overflow at '+width);
    check(await page.locator('#cockpitResumeDrive').isVisible(),'Resume reachable at '+width);
    check(await page.locator('#cockpitBrakeReason').evaluate(n=>{const a=n.getBoundingClientRect(),b=n.closest('.cockpit-brake').getBoundingClientRect();return a.bottom<=b.bottom&&a.top>=b.top;}),'Brake reason fits its card at '+width);
    if(width===1440||width===390)await page.screenshot({path:'output/playwright/processing-recovery-paused-'+width+'.png',fullPage:true});
  }
  await page.setViewportSize({width:1440,height:900});
  await page.locator('#cockpitResumeDrive').click();
  await page.waitForFunction(()=>window.__redesign.commands.some(c=>c.type==='start_journey'&&c.driving_mode==='ROBOSPHERE'));
  await page.locator('#cockpitResumeDrive').waitFor({state:'hidden'});
  check(await page.locator('#cockpitResumeDrive').isHidden(),'Explicit resume hides the held notice');
  await page.evaluate(()=>{
    const s=window.__redesign.state;s.mode='AUTOMATIC';
    s.stopDiagnostics={braking:true,decision_source:'NAVIGATION',reason:'Red traffic light on the planned route'};
    s.lastDriveStop=null;
  });
  await page.waitForFunction(()=>document.querySelector('.notice-copy strong').textContent==='Waiting at a red light');
  check(await page.locator('#cockpitResumeDrive').isHidden(),'Red signal never offers a restart or brake bypass');
  await page.evaluate(()=>{
    const s=window.__redesign.state;s.mode='PAUSED';s.journey={status:'ARRIVED',reason:'destination_reached'};s.route.arrived=true;
    s.lastDriveStop={status:'ARRIVED',detail:'destination_reached'};
  });
  await waitText('#cockpitDriverText','Arrived');
  await page.waitForFunction(()=>document.querySelector('.notice-copy strong').textContent==='Destination reached');
  check(await page.locator('#cockpitResumeDrive').isHidden(),'Arrival offers a new destination instead of restarting the completed route');
  await page.screenshot({path:'output/playwright/processing-recovery-arrived.png',fullPage:true});
  check(errors.length===0,'No browser exceptions');
  await page.screenshot({path:'output/playwright/braking-repair-normal.png',fullPage:true});
  await page.evaluate(report=>{window.__processingReport=report;},{source:'ISOLATED_BROWSER_FIXTURE',checks});
  return {source:'ISOLATED_BROWSER_FIXTURE',checks:checks.length,errors};
}
