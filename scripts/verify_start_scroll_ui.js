async page=>{
  const root='http://127.0.0.1:8016',commands=[],errors=[],checks=[];
  const observed=await (await page.request.get(root+'/output/guided-ui-20261018/observed-state.json')).json();
  const catalog=await (await page.request.get(root+'/output/guided-ui-20261018/observed-catalog.json')).json();
  const savedImage=await page.request.get(root+'/output/start-scroll-ui-20261018/camera-fixture.jpg');
  if(!savedImage.ok())throw new Error('A retained chase-camera JPEG is required for the isolated layout check');
  const image=await savedImage.body();
  const fresh={connected:true,controller:true,mode:'PAUSED',presentation:{status:'IDLE',id:null},
    journey:{status:'IDLE',speed_kmh:30},route:null,lastDriveStop:null,recording:false};
  const state={...observed,...fresh,type:'snapshot',sessionId:'start-scroll-isolated-fixture',
    journeyComparison:{pair_id:null,runs:{}},comparisonV2:null,comparisonDemo:{phase:'IDLE',results:{}},
    dashboardResult:null,restarting:false,restartResult:null,simulatorStart:{status:'IDLE',available:true},
    safetySystem:{enabled:true,controller:'RULE',status:'STANDBY',active:false},
    displayCamera:{sensorId:'drivingCamera',frame:100,timestamp:1,width:1280,height:720,fovDeg:90,frameAvailable:true},
    sensors:{},sensorErrors:{},sensorRatesHz:{},nearbyActors:null,canonical:null,maneuver:null};
  let socket,frame=100;
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/api/**',async route=>{
    const url=new URL(route.request().url());
    if(url.pathname.endsWith('/status'))return route.fulfill({json:{provider:'carla',configured:true,websocketPort:8017}});
    if(url.pathname.endsWith('/catalog'))return route.fulfill({json:catalog});
    if(url.pathname.endsWith('/camera.jpg')){
      const requested=Number(url.searchParams.get('frame_id'));
      return route.fulfill({body:image,contentType:'image/jpeg',headers:{'X-Sensor-Frame':String(requested),
        'X-Sensor-Time':String(1+(requested-100)*.05)}});
    }
    if(url.pathname.endsWith('/state'))return route.fulfill({json:state});
    return route.fulfill({json:{status:'UNAVAILABLE'}});
  });
  const publish=()=>{
    if(!socket)return;
    const stamp=1+(++frame-100)*.05;
    state.vehicle={...observed.vehicle,source:'carla',frame,timestamp:stamp,speedKmh:0,speedMps:0,speedMagnitudeMps:0};
    state.world={...observed.world,source:'carla',frame,timestamp:stamp};
    state.displayCamera={...state.displayCamera,frame,timestamp:stamp};
    socket.send(JSON.stringify(state));
  };
  await page.routeWebSocket('ws://127.0.0.1:8017',connection=>{
    socket=connection;
    connection.onMessage(raw=>{
      const command=JSON.parse(String(raw));commands.push(command);state.acknowledged=command.sequence;
      if(command.type==='presentation'){
        state.presentation={status:'DRIVING',id:'isolated-first-attempt',arm:0};
        state.journey={status:'RUNNING',presentation_id:'isolated-first-attempt',speed_kmh:50};
        state.mode='AUTOMATIC';
      }
      if(command.type==='stop_driving'){
        state.presentation={...state.presentation,status:'CANCELLED'};
        state.journey={...state.journey,status:'PAUSED',reason:'operator_stop'};state.mode='PAUSED';
      }
      publish();
    });
  });
  const timer=setInterval(publish,100);
  await page.exposeFunction('changeStartScrollFixture',patch=>{Object.assign(state,patch);publish();});
  await page.exposeFunction('readStartScrollFixture',()=>({commands,errors,checks,
    scope:'ISOLATED_SYNTHETIC_UI_STATE_AND_SAVED_CAMERA_IMAGE',native_commands:0}));
  await page.goto(root+'/?verification=start-scroll');
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.evaluate(()=>{
    const label=document.createElement('div');label.textContent='ISOLATED UI CHECK · saved camera image · no native driving';
    Object.assign(label.style,{position:'fixed',bottom:'0',left:'0',right:'0',zIndex:'1000',font:'11px sans-serif',
      textAlign:'center',background:'#fff0c7',color:'#11182f',pointerEvents:'none'});
    document.body.append(label);
  });
  const action=page.locator('#drivePrimaryAction');
  const expectLabel=async(name,label)=>{
    await page.waitForFunction(expected=>document.getElementById('drivePrimaryAction')?.textContent===expected,label);
    checks.push({name,label:await action.textContent()});
  };
  await expectLabel('fresh connected session','Start');
  if(!await page.locator('#presentationDetail').textContent().then(text=>text.startsWith('Start prepares')))
    throw new Error('Fresh-session guidance still says Restart');
  await page.evaluate(()=>window.changeStartScrollFixture({connected:false,mode:'DISCONNECTED'}));
  await expectLabel('fresh stopped simulator','Start');
  await page.evaluate(()=>window.changeStartScrollFixture({connected:true,mode:'PAUSED'}));
  await expectLabel('connected again without an attempt','Start');
  await action.click();
  await expectLabel('explicit Start enters active presentation','Stop');
  if(!commands.some(command=>command.type==='presentation'&&command.value?.operation==='RESTART'))
    throw new Error('Start no longer uses the supported backend operation');
  await action.click();
  await expectLabel('stopped attempt','Restart');
  await page.evaluate(()=>window.changeStartScrollFixture({presentation:{status:'ERROR',id:'isolated-error',reason:'runtime_failure'},
    journey:{status:'ERROR'},lastDriveStop:{status:'ERROR'}}));
  await expectLabel('failed attempt','Restart');
  await page.evaluate(()=>window.changeStartScrollFixture({mode:'EMERGENCY_STOP'}));
  await expectLabel('emergency lock','Release emergency stop');
  await page.evaluate(()=>window.changeStartScrollFixture({mode:'PAUSED',lastDriveStop:null,presentation:{status:'IDLE',id:null},
    journey:{status:'PAUSED',reason:'operator_stop',route_id:'same-route'},route:{id:'same-route',arrived:false,
      destination:{name:'Isolated destination',map:'Town10HD_Opt',location:[20,0,0]},
      length_m:20,remaining_m:20,points:[[0,0,0],[20,0,0]]}}));
  await expectLabel('valid ordinary pause','Resume driving');
  await page.evaluate(patch=>window.changeStartScrollFixture(patch),fresh);
  await expectLabel('fresh layout fixture restored','Start');
  if(errors.length)throw new Error(errors.join('; '));
  return {passed:true,checks,commands,errors,native_commands:0,
    fixture:'Isolated static HTTP 8016, intercepted WebSocket 8017, simulated state and saved camera image',timer_started:!!timer};
}
