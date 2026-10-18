async page=>{
  const root='http://127.0.0.1:8016',commands=[],errors=[],requests=[];
  const observed=await (await page.request.get(root+'/output/guided-ui-20261018/observed-state.json')).json();
  const catalog=await (await page.request.get(root+'/output/guided-ui-20261018/observed-catalog.json')).json();
  const image=await (await page.request.get(root+'/public/assets/native-preview.jpg')).body();
  const state={...observed,type:'snapshot',connected:false,available:false,mode:'DISCONNECTED',controller:true,
    sessionId:'isolated-guided-ui',presentation:{status:'IDLE',id:null},journey:{status:'IDLE'},route:null,
    journeyComparison:{pair_id:null,runs:{}},comparisonV2:null,comparisonDemo:{phase:'IDLE',results:{}},
    dashboardResult:null,restarting:false,restartResult:null,simulatorStart:{status:'IDLE',available:false},
    simulatorStop:{status:'STOPPED',available:true},sensorErrors:{},nearbyActors:null,canonical:null,maneuver:null};
  let socket,frame=100;
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/api/**',async route=>{
    const url=new URL(route.request().url());
    if(route.request().method()==='POST')requests.push(url.pathname);
    if(url.pathname.endsWith('/status'))return route.fulfill({json:{provider:'carla',configured:true,websocketPort:8017}});
    if(url.pathname.endsWith('/catalog'))return route.fulfill({json:catalog});
    if(url.pathname.endsWith('/start'))return route.fulfill({json:{status:'STARTING'}});
    if(url.pathname.endsWith('/camera.jpg'))return route.fulfill({body:image,contentType:'image/jpeg',headers:{'X-Sensor-Frame':url.searchParams.get('frame_id')||String(frame),'X-Sensor-Time':String(1+(Number(url.searchParams.get('frame_id'))-100)*.05)}});
    return route.fulfill({json:{status:'UNAVAILABLE'}});
  });
  const publish=()=>{if(!socket)return;const timestamp=1+(++frame-100)*.05;
    state.vehicle={...observed.vehicle,source:'carla',frame,timestamp,speedKmh:0,speedMps:0,speedMagnitudeMps:0};
    state.world={...observed.world,source:'carla',frame,timestamp};
    state.displayCamera={...observed.displayCamera,frame,timestamp};socket.send(JSON.stringify(state));};
  await page.routeWebSocket('ws://127.0.0.1:8017',connection=>{socket=connection;connection.onMessage(raw=>{
    const c=JSON.parse(String(raw));commands.push(c);state.acknowledged=c.sequence;
    if(c.type==='presentation'&&c.value?.operation==='PRELOAD')state.presentation={id:'fixture-preloaded',status:'CHOOSING',guided:true,preloaded:true,awaiting_choice:true,
      arm:0,modes:['NORMAL','ROBOSPHERE'],seed:123,scene:'DENSE_CHAOS',prepared_condition_id:'fixture-world',setup:{scene:'DENSE_CHAOS',requested_route_vehicles:60,requested_route_pedestrians:100}};
    publish();
  });});
  setInterval(publish,100);
  await page.exposeFunction('setMissionFixture',patch=>{Object.assign(state,patch);publish();});
  await page.exposeFunction('missionEvidence',()=>({commands,errors,requests,scope:'ISOLATED_UI_FIXTURE_NO_NATIVE_COMMANDS'}));
  await page.goto(root+'/?verification=guided-mission');
  return {installed:true};
}
