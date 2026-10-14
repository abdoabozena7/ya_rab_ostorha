// Alternating exact-frame availability and transient perception waits.
// Browser-only commands; no native mutations.
async(page)=>{
  const root='http://127.0.0.1:8000',errors=[];
  const snapshot=await(await page.request.get(root+'/api/simulation/state')).json();
  const source=await page.request.get(root+'/api/simulation/camera.jpg?view=driving');
  const photoType=source.ok()?'image/jpeg':'image/svg+xml';
  const photo=source.ok()?await source.body():Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="450"><rect width="800" height="450" fill="#152238"/><text x="400" y="225" text-anchor="middle" fill="white" font-size="28">Browser layout fixture</text></svg>');
  if(!snapshot.connected){
    snapshot.provider='carla';snapshot.vehicle={...snapshot.vehicle,source:'carla',frame:100,timestamp:1,speedMps:0,speedKmh:0,brake:1,throttle:0,gear:1};
    snapshot.world={...snapshot.world,source:'carla',frame:100,timestamp:1};snapshot.sensorErrors={};
    snapshot.displayCamera={sensorId:'drivingCamera',frame:100,timestamp:1,width:800,height:450,fovDeg:90,frameAvailable:true,
      worldTransform:{position_m:[0,0,0],rotation_rad:{}},mountTransform:{position_m:[0,0,0],rotation_deg:{}}};
  }
  const initialFrame=snapshot.vehicle.frame,initialTime=snapshot.vehicle.timestamp;
  await page.goto('about:blank');
  page.on('pageerror',e=>errors.push(e.message));
  await page.setViewportSize({width:1440,height:960});
  await page.addInitScript(s=>{
    s.sessionId='stability-fixture';s.type='snapshot';s.controller=false;s.mode='PAUSED';s.connected=true;
    s.simulatorStop={available:true,status:'IDLE'};s.maneuver={action:'HOLD'};
    window.__stabilityState=s;window.__stabilityCommands=[];
    window.WebSocket=class{readyState=1;constructor(){this.timer=setInterval(()=>{
      s.vehicle.frame++;s.vehicle.timestamp+=.05;s.world.frame=s.vehicle.frame;s.world.timestamp=s.vehicle.timestamp;
      s.displayCamera.frame=s.vehicle.frame;s.displayCamera.timestamp=s.vehicle.timestamp;
      this.onmessage?.({data:JSON.stringify(s)});
    },80);}send(raw){const c=JSON.parse(raw);window.__stabilityCommands.push(c);
      if(c.type==='stop_simulator'){s.connected=false;s.mode='DISCONNECTED';s.simulatorStop={available:true,status:'STOPPED',process_exited:true};}
    }close(){clearInterval(this.timer);}};
  },snapshot);
  await page.route('**/api/simulation/camera.jpg?*',r=>{
    const frame=Number(new URL(r.request().url()).searchParams.get('frame_id'));
    return r.fulfill({body:photo,contentType:photoType,headers:{'X-Sensor-Frame':String(frame),'X-Sensor-Time':String(initialTime+(frame-initialFrame)*.05)}});
  });
  let exactRequests=0,waiting=0;
  await page.route('**/api/simulation/prediction*',async r=>{
    const s=await page.evaluate(()=>window.__stabilityState),requested=new URL(r.request().url()).searchParams.get('frame_id');
    if(requested&&++exactRequests%2){waiting++;return r.fulfill({json:{status:'WAITING'}});}
    const frame=requested?Number(requested):s.vehicle.frame;
    const stamp=requested?initialTime+(frame-initialFrame)*.05:s.vehicle.timestamp;
    return r.fulfill({json:{status:'RUNNING',prediction:{version:3,session_id:'stability-fixture',evaluation_frame:frame,
      timestamp_s:stamp,coordinate_frame:'EGO_AT_EVALUATION',display_source:'MEASURED_KINEMATIC',tracks:[],trajectories:[],
      model_reason:frame%2?'Waiting for classified motion history':'Measured motion · learned control acceptance pending',
      render_reference:{position_m:[0,0,0],rotation_rad:{}},front_camera:{...s.displayCamera,frame,timestamp:stamp}}}});
  });
  let perceptionRequests=0;
  await page.route('**/api/simulation/perception',async r=>{
    if(++perceptionRequests%2===0)return r.fulfill({json:{status:'WAITING'}});
    const s=await page.evaluate(()=>window.__stabilityState);
    return r.fulfill({json:{status:'RUNNING',session_id:'stability-fixture',frame_id:s.vehicle.frame,timestamp_s:s.vehicle.timestamp,
      image_token:'stability-'+s.vehicle.frame,detections:[],texts:[],device:'CPU',inference_ms:47}});
  });
  await page.route('**/api/simulation/perception.jpg?*',r=>r.fulfill({body:photo,contentType:photoType,headers:{'X-Perception-Token':new URL(r.request().url()).searchParams.get('token')}}));
  await page.goto(root+'/?mode=guided&rehearsal=1');
  await page.locator('#perceptionCamera').waitFor({state:'visible'});
  await page.waitForFunction(()=>document.getElementById('guidedPredictionStatus').textContent.includes('MEASURED_KINEMATIC'));
  const result=await page.evaluate(async()=>{
    const selectors=['.prediction-insight','.perception-image','#motionReadout','#speedVal'];
    const cells=[...document.querySelectorAll('#motionNumbers dd')],rects=[],mapHidden=[],images=[];
    for(let i=0;i<35;i++){
      rects.push(selectors.map(s=>{const r=document.querySelector(s).getBoundingClientRect();return [r.y,r.height];}));
      mapHidden.push(document.querySelector('.prediction-surroundings').hidden);images.push(document.getElementById('perceptionCamera').hidden);
      await new Promise(r=>setTimeout(r,100));
    }
    const baseline=rects[0],maxShift=Math.max(...rects.flatMap(sample=>sample.flatMap((rect,i)=>rect.map((v,j)=>Math.abs(v-baseline[i][j])))));
    return {maxShift,mapStayedVisible:mapHidden.every(v=>!v),imageStayedVisible:images.every(v=>!v),
      numericNodesStable:cells.every((cell,i)=>cell===document.querySelectorAll('#motionNumbers dd')[i])};
  });
  if(result.maxShift>1||!result.mapStayedVisible||!result.imageStayedVisible||!result.numericNodesStable||waiting<2)throw new Error(JSON.stringify({result,waiting}));
  await page.screenshot({path:'output/playwright/ui-stability.png'});
  await page.getByRole('button',{name:'Stop CARLA · Free GPU',exact:true}).click();
  await page.waitForFunction(()=>document.getElementById('cityStatus').textContent==='CARLA — STOPPED');
  const commands=await page.evaluate(()=>window.__stabilityCommands);
  if(commands.filter(c=>c.type==='stop_simulator').length!==1||commands.some(c=>c.type==='take_control'))throw new Error('GPU stop ownership or duplicate request regression');
  if(!(await page.locator('#stopSimulatorBtn').isDisabled()))throw new Error('Completed stop must disable the action');
  await page.setViewportSize({width:390,height:844});
  if(!(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)))throw new Error('Mobile overflow');
  if(errors.length)throw new Error(JSON.stringify(errors));
  return {passed:true,...result,alignmentWaits:waiting,shutdown_without_takeover:true,mobile_overflow:false,errors,native_mutations:0};
}
