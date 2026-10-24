async (page,options={})=>{
  // Reuse either known local asset host; all API calls and the fake socket stay intercepted.
  const origin=page.url().split('/').slice(0,3).join('/');
  const hosts=['http://127.0.0.1:8000','http://127.0.0.1:8016','http://127.0.0.1:8019'];
  const root=options.root||(hosts.includes(origin)?origin:'http://127.0.0.1:8000'),commands=[],errors=[],requests=[];
  if(!hosts.includes(root))throw Error('Browser fixture requires a local project asset host');
  const observed=options.observed||await (await page.request.get(root+'/output/guided-ui-20261018/observed-state.json')).json();
  const catalog=options.catalog||await (await page.request.get(root+'/output/guided-ui-20261018/observed-catalog.json')).json();
  const image=options.image_path?null:await (await page.request.get(root+'/public/assets/native-preview.jpg')).body();
  const state={...observed,type:'snapshot',connected:false,available:false,mode:'DISCONNECTED',controller:true,
    sessionId:'isolated-guided-ui',presentation:{status:'IDLE',id:null},journey:{status:'IDLE'},route:null,
    journeyComparison:{pair_id:null,runs:{}},comparisonV2:null,comparisonDemo:{phase:'IDLE',results:{}},
    dashboardResult:null,restarting:false,restartResult:null,simulatorStart:{status:'IDLE',available:false},
    simulatorStop:{status:'STOPPED',available:true},sensorErrors:{},nearbyActors:null,canonical:null,maneuver:null};
  let socket,frame=100;
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/api/**',async route=>{
    const url=route.request().url(),path=url.split('?')[0];
    if(route.request().method()==='POST')requests.push(path.slice(root.length));
    if(path.endsWith('/status'))return route.fulfill({json:{provider:'carla',configured:true,websocketPort:8017}});
    if(path.endsWith('/catalog'))return route.fulfill({json:catalog});
    if(path.endsWith('/scenarios'))return route.fulfill({json:catalog.presentation_scenarios||{
      default_id:'SUDDEN_PEDESTRIAN_COMPARISON_V1',options:[
        {id:'SUDDEN_PEDESTRIAN_COMPARISON_V1',available:true},
        {id:'EGYPT_URBAN_CHAOS_V1',available:false,native_accepted:false}]}});
    if(path.endsWith('/start'))return route.fulfill({json:{status:'STARTING'}});
    const frameId=/[?&]frame_id=(\d+)/.exec(url)?.[1];
    if(path.endsWith('/camera.jpg'))return route.fulfill({...(options.image_path?{path:options.image_path}:{body:image}),contentType:'image/jpeg',headers:{'X-Sensor-Frame':frameId||String(frame),'X-Sensor-Time':String(1+(Number(frameId)-100)*.05)}});
    return route.fulfill({json:{status:'UNAVAILABLE'}});
  });
  const publish=()=>{if(!socket)return;const timestamp=1+(++frame-100)*.05;
    state.vehicle={...observed.vehicle,source:'carla',frame,timestamp,speedKmh:0,speedMps:0,speedMagnitudeMps:0};
    state.world={...observed.world,source:'carla',frame,timestamp};
    state.displayCamera={...observed.displayCamera,frame,timestamp};socket.send(JSON.stringify(state));};
  await page.routeWebSocket(/^ws:\/\/127\.0\.0\.1:8017\/?$/,connection=>{socket=connection;connection.onMessage(raw=>{
    const c=JSON.parse(String(raw));commands.push(c);state.acknowledged=c.sequence;
    if(c.type==='presentation'&&c.value?.operation==='PRELOAD')state.presentation={id:'fixture-preloaded',status:'CHOOSING',guided:true,preloaded:true,awaiting_choice:true,
      page_id:c.value.page_id,arm:0,modes:['NORMAL','ROBOSPHERE'],seed:123,scene:'DENSE_CHAOS',prepared_condition_id:'fixture-world',
      ...(c.value.scenario_id==='EGYPT_URBAN_CHAOS_V1'?{scenario_id:c.value.scenario_id,scenario_version:1,speed_kmh:60}:{}),
      setup:{scene:'DENSE_CHAOS',requested_route_vehicles:60,requested_route_pedestrians:100}};
    publish();
  });});
  await page.exposeFunction('publishMissionFixture',publish);
  await page.addInitScript(()=>{
    const publishing=setInterval(()=>window.publishMissionFixture(),100);
    window.stopMissionFixture=()=>clearInterval(publishing);
  });
  await page.exposeFunction('setMissionFixture',patch=>{Object.assign(state,patch);publish();});
  await page.exposeFunction('missionEvidence',()=>({commands,errors,requests,scope:'ISOLATED_UI_FIXTURE_NO_NATIVE_COMMANDS'}));
  await page.goto(root+'/?verification=guided-mission');
  return {installed:true};
}
