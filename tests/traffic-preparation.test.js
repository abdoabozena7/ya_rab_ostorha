import test from 'node:test';
import assert from 'node:assert/strict';
import {TrafficPreparation,trafficCommandBlocked,trafficPreparationReason,routeCrowdingReady,routeCrowdingPrepared} from '../frontend/traffic-preparation.js';
import {SimulationClient} from '../frontend/simulation-client.js';

function fixture() {
  let clock=0;
  const sent=[],stops=[];
  const config={vehicle_count:5,pedestrian_count:3,speed_behavior:'NORMAL',seed:2604,fast_walk_percent:10,
    driver_behavior:'NORMAL',light_compliance_percent:90,crossing_percent:5,world_profile:'VISUAL_DEMO'};
  const population={requested:config,actual:{vehicles:5,pedestrians:3},frame_id:10,
    traffic_manager_connected:true,npc_failed:0,errors:[]};
  const p={fresh:true,connected:true,controller:true,isReplay:false,restarting:false,recording:false,
    controlMode:'PAUSED',sessionId:'one',population,environment:{mode:'LIVING_CITY'},dashboardResult:null,
    getVehicleState:()=>({speedMps:0,frame:10}),dashboardAction:(type,value)=>{sent.push({type,value});return true;}};
  const t=new TrafficPreparation(p,r=>stops.push(r),{now:()=>clock});
  const apply=(changes={})=>{
    const current={...population,requested:{...config,vehicle_count:25,pedestrian_count:20,placement:'EGO_SURROUNDING',vehicle_mix:'MIXED'},actual:{vehicles:25,pedestrians:20,controllers:20,walkers_active:20},walkers_failed:0,...changes};
    p.population=current;
    p.dashboardResult={action:'settings',status:'APPLIED',operationId:'new',result:{population:structuredClone(current)}};
  };
  return {p,t,sent,stops,apply,advance:n=>{clock+=n;}};
}

test('custom city waits for actual pedestrian and controller admission as well as vehicles',()=>{
  const {p,t,sent,apply}=fixture();
  const config={...p.population.requested,vehicle_count:12,pedestrian_count:8,chaos_percent:85,crossing_percent:60};
  assert.equal(t.request(config),true);assert.deepEqual(sent[0].value.population,config);
  apply({requested:config,actual:{vehicles:12,pedestrians:7,controllers:8},walkers_failed:0});
  t.update();assert.equal(t.state.status,'FAILED');
  assert.equal(t.request(config),true);
  apply({requested:config,actual:{vehicles:12,pedestrians:8,controllers:8,walkers_active:8},walkers_failed:0});
  p.dashboardResult.operationId='new-retry';
  t.update();assert.equal(t.state.status,'READY');assert.equal(t.state.actual_count,12);
});

test('zero-traffic city is explicit and invalid custom counts never send a request',()=>{
  const {p,t,sent,stops,apply}=fixture();
  assert.equal(t.request({...p.population.requested,vehicle_count:76}),false);assert.equal(sent.length,0);assert.equal(stops.length,0);
  const config={...p.population.requested,vehicle_count:0,pedestrian_count:0};
  assert.equal(t.request(config),true);
  apply({requested:config,actual:{vehicles:0,pedestrians:0,controllers:0},walkers_failed:0});
  t.update();assert.equal(t.state.status,'READY');
});

test('explicit preparation requests 25 vehicles and 20 walkers around ego and stops first',()=>{
  const {p,t,sent,stops}=fixture();
  const old=structuredClone(p.population.requested);
  assert.equal(t.request(),true);
  assert.deepEqual(stops,['traffic_preparation']);
  assert.deepEqual(sent,[{type:'settings',value:{population:{...old,vehicle_count:25,pedestrian_count:20,placement:'EGO_SURROUNDING',vehicle_mix:'MIXED'}}}]);
  assert.deepEqual(p.population.requested,old);
  assert.equal(p.trafficPreparation.status,'REQUESTED');
  assert.equal(t.request(),false);
  assert.equal(sent.length,1);
  t.update();assert.equal(t.state.status,'REQUESTED');
});

test('only new applied settings plus a matching native snapshot admit ready',()=>{
  const {p,t,apply}=fixture();
  p.dashboardResult={action:'settings',status:'APPLIED',operationId:'old'};
  t.request();
  t.update();assert.equal(t.state.status,'REQUESTED');
  p.dashboardResult={action:'settings',status:'PENDING',operationId:'new'};
  t.update();assert.equal(t.state.status,'APPLYING');
  apply();t.update();
  assert.equal(t.state.status,'READY');
  assert.equal(t.state.native_frame,10);
  assert.equal(t.state.actual_count,25);
});

for(const [name,changes] of Object.entries({partial:{actual:{vehicles:39}},nativeFailure:{npc_failed:1},
  stale:{frame_id:9},disconnectedTM:{traffic_manager_connected:false},errors:{errors:['spawn failed']},
  missingErrors:{errors:undefined},changedSeed:{requested:{vehicle_count:40,seed:17}}})) {
  test(`does not admit ${name} population evidence`,()=>{
    const {t,apply}=fixture();t.request();apply(changes);t.update();
    assert.equal(t.state.status,'FAILED');
    assert.equal(trafficCommandBlocked(t.state,'start_journey'),true);
  });
}

test('absent or wrong-action completion never becomes success',()=>{
  const {p,t,apply}=fixture();t.request();apply();
  p.dashboardResult.action='destination';t.update();assert.equal(t.state.status,'REQUESTED');
  p.dashboardResult={action:'settings',status:'APPLIED',operationId:'new'};
  t.update();assert.equal(t.state.status,'FAILED');
});

test('native rejection and protocol error are visible without retries',()=>{
  for(const protocol of [true,false]) {
    const {p,t,sent}=fixture();t.request();
    if(protocol)p.operationError='Permission denied';
    else p.dashboardResult={action:'settings',status:'REJECTED',operationId:'failed',error:'Occupied spawns'};
    t.update();assert.equal(t.state.status,'FAILED');
    assert.match(t.state.reason,protocol?/Permission denied/:/Occupied spawns/);
    assert.equal(sent.length,1);
  }
});

test('disconnect, replay and lost ownership keep completion unverified',()=>{
  for(const [key,value] of [['fresh',false],['isReplay',true],['controller',false]]) {
    const {p,t,apply}=fixture();t.request();apply();p[key]=value;t.update();
    assert.equal(t.state.status,'FAILED');
  }
});

test('timeout holds driving without repeating the request; late authentic completion is accepted',()=>{
  const {t,sent,advance,apply}=fixture();t.request();advance(30_001);t.update();
  assert.equal(t.state.status,'FAILED');assert.equal(sent.length,1);
  apply();t.update();assert.equal(t.state.status,'READY');
});

test('request rejection never reports success and supports an explicit retry',()=>{
  const {p,t,sent}=fixture();
  p.dashboardAction=()=>false;
  assert.equal(t.request(),false);assert.equal(t.state.status,'FAILED');
  p.dashboardAction=(type,value)=>{sent.push({type,value});return true;};
  assert.equal(t.request(),true);assert.equal(sent.length,1);
});

test('new native session resets only the old preparation result',()=>{
  const {p,t}=fixture();t.request();p.sessionId='two';t.update();
  assert.equal(t.state,null);assert.equal(p.trafficPreparation,null);
});

test('an independently loaded controlled scene clears the normal-city gate without claiming success',()=>{
  const {p,t,sent,apply}=fixture();t.request();apply({actual:{vehicles:39}});t.update();
  assert.equal(t.state.status,'FAILED');
  p.environment={mode:'TRAINING'};t.update();
  assert.equal(t.state,null);assert.equal(p.trafficPreparation,null);
  assert.equal(sent.length,1);
});

test('preparation is unavailable during movement, recordings, controlled scenarios and other ownership',()=>{
  const changes=[{fresh:false},{connected:false},{isReplay:true},{controller:false},{restarting:true},
    {recording:true},{controlMode:'AUTOMATIC'},{environment:{mode:'TRAINING'}},
    {comparisonDemo:{phase:'RUNNING'}},{dashboardResult:{status:'PENDING'}}];
  for(const change of changes) {
    const {p,t,sent}=fixture();Object.assign(p,change);
    assert.equal(t.request(),false);assert.equal(sent.length,0);
  }
  const {p}=fixture();assert.match(trafficPreparationReason(p,{speedMps:.16}),/stop/);
  assert.match(trafficPreparationReason(p,{speedMps:NaN}),/stop/);
});

test('transport holds starts and motion but always permits stop and emergency controls',()=>{
  const sent=[];
  const p=new SimulationClient({now:()=>1});
  Object.assign(p,{connected:true,controller:true,receivedAt:1,controlMode:'MANUAL',telemetry:{frame:10,timestamp:.5},
    socket:{readyState:1,send:json=>sent.push(JSON.parse(json))},trafficPreparation:{status:'REQUESTED'}});
  assert.equal(p.startDriving(),false);assert.equal(p.startJourney(20),false);
  assert.equal(p.dashboardAction('comparison',{mode:'WITH'}),false);
  assert.equal(p.dashboardAction('settings',{}),false);
  assert.equal(p.updateControls({throttle:.5,brake:0}),false);
  assert.equal(p.emergencyStop(),true);assert.equal(p.stopDriving(),true);
  assert.equal(p.send('controls',{controls:{throttle:0,brake:1,steering:0}}),true);
  assert.deepEqual(sent.map(x=>x.type),['emergency_stop','stop_driving','controls']);
  p.trafficPreparation={status:'READY'};
  assert.equal(p.startJourney(20),true);
});

const route={id:'road-one',destination:{map:'Town',location:[200,0,0]},length_m:200};
function applyRoad(f,count=23,changes={}) {
  const c={active:true,status:'READY',route_id:route.id,destination:route.destination,
    route_length_m:200,target_count:count,placed_count:count,seed:987,chaos_percent:45,...changes};
  const pop={...f.p.population,requested:{...f.p.population.requested,vehicle_count:count,seed:987,chaos_percent:45},
    actual:{vehicles:c.placed_count,pedestrians:3},route_crowding:c};
  f.p.population=pop;
  f.p.dashboardResult={action:'crowd_route',status:'APPLIED',operationId:'crowded',result:{population:structuredClone(pop),crowding:c}};
}
test('road crowding requires a destination and sends no fixed vehicle count',()=>{
  const f=fixture();assert.equal(f.t.requestRouteCrowding(),false);assert.equal(f.sent.length,0);
  f.p.route=route;assert.equal(f.t.requestRouteCrowding({seed:987,chaos_percent:45}),true);
  assert.deepEqual(f.sent[0],{type:'crowd_route',value:{route_id:route.id,seed:987,chaos_percent:45}});
  const previousError=f.p.operationError;
  assert.equal(f.t.requestRouteCrowding({seed:987,chaos_percent:45}),false);
  assert.equal(f.sent.length,1);assert.equal(f.p.operationError,previousError);
  applyRoad(f);f.t.update();assert.equal(f.t.state.status,'READY');assert.equal(f.t.state.actual_count,23);
  assert.match(f.t.state.reason,/200 m road/);assert.equal(routeCrowdingReady(f.p),true);
});
test('partial or mismatched road placement cannot advance to driving',()=>{
  for(const changes of [{placed_count:22,status:'PARTIAL'},{destination:{map:'Town',location:[300,0,0]}},{seed:42}]) {
    const f=fixture();f.p.route=route;f.t.requestRouteCrowding({seed:987,chaos_percent:45});
    applyRoad(f,23,changes);f.t.update();assert.notEqual(f.t.state.status,'READY');
    assert.equal(trafficCommandBlocked(f.t.state,'start_journey'),true);
  }
});
test('a new destination invalidates road readiness but replanning the same destination preserves it',()=>{
  const f=fixture();f.p.route=route;f.t.requestRouteCrowding({seed:987,chaos_percent:45});applyRoad(f);f.t.update();
  f.p.route={...route,id:'replanned'};assert.equal(routeCrowdingReady(f.p),true);f.t.update();assert.equal(f.t.state.status,'READY');
  f.p.route={...route,destination:{...route.destination,location:[500,0,0]}};
  assert.equal(routeCrowdingReady(f.p),false);f.t.update();assert.equal(f.t.state,null);
});

test('native preparation receipt survives circulating traffic count changes and page reload',()=>{
  const f=fixture();f.p.route=route;f.t.requestRouteCrowding({seed:987,chaos_percent:45});applyRoad(f);f.t.update();
  f.p.population=structuredClone(f.p.population);
  f.p.population.actual.vehicles=22;f.p.population.npc_failed=1;
  f.p.population.route_crowding={...f.p.population.route_crowding,status:'PARTIAL',placed_count:22};
  assert.equal(routeCrowdingReady(f.p),false);
  assert.equal(routeCrowdingPrepared(f.p,f.t),true);
  assert.equal(routeCrowdingPrepared(f.p),true); // native applied receipt after reload
  f.p.dashboardResult={action:'inspector',status:'APPLIED'};
  assert.equal(routeCrowdingPrepared(f.p,f.t),true); // local confirmed receipt
  f.p.population.requested.seed=99;f.p.population.route_crowding.seed=99;
  assert.equal(routeCrowdingPrepared(f.p,f.t),false);
  f.p.population.requested.seed=f.p.population.route_crowding.seed=987;
  f.p.route={...route,destination:{...route.destination,location:[400,0,0]}};
  assert.equal(routeCrowdingPrepared(f.p,f.t),false);
});

test('initial partial admission or another unfinished request cannot use an old receipt',()=>{
  const f=fixture();f.p.route=route;f.t.requestRouteCrowding({seed:987,chaos_percent:45});
  applyRoad(f,23,{placed_count:22,status:'PARTIAL'});f.t.update();
  assert.equal(routeCrowdingPrepared(f.p,f.t),false);assert.equal(routeCrowdingPrepared(f.p),false);
  f.t.requestRouteCrowding({seed:987,chaos_percent:45});
  assert.equal(routeCrowdingPrepared(f.p,f.t),false);
});

test('a delayed native admission advances once without requesting another fleet',()=>{
  const f=fixture();f.p.route=route;f.t.requestRouteCrowding({seed:987,chaos_percent:45});
  applyRoad(f,23,{placed_count:22,status:'PARTIAL'});f.t.update();
  assert.equal(f.t.state.status,'APPLYING');assert.equal(trafficCommandBlocked(f.t.state,'start_journey'),true);
  f.p.population=structuredClone(f.p.population);f.p.population.actual.vehicles=23;
  f.p.population.route_crowding={...f.p.population.route_crowding,status:'READY',placed_count:23};
  f.t.update();assert.equal(f.t.state.status,'READY');assert.equal(routeCrowdingPrepared(f.p,f.t),true);
  assert.equal(f.sent.length,1);
});

test('route confirmation waits for aligned telemetry instead of rejecting a frame in flight',()=>{
  const f=fixture();f.p.route=route;f.t.requestRouteCrowding({seed:987,chaos_percent:45});applyRoad(f);
  f.p.population.frame_id=11;f.t.update();assert.equal(f.t.state.status,'APPLYING');
  f.p.getVehicleState=()=>({speedMps:0,frame:11});f.t.update();assert.equal(f.t.state.status,'READY');
  assert.equal(f.sent.length,1);
});
