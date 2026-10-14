import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import {SimulationClient, unavailableState} from '../frontend/simulation-client.js';
import {DrivingControls} from '../frontend/controls.js';
import {telemetryText} from '../frontend/telemetry.js';
import {sensorFrameKey, matchesSensorResponse} from '../frontend/sensor-frame.js';
import {DRIVING_KEYS, isEditableTarget, drivingInputAllowed} from '../frontend/input-policy.js';

test('one explicit start launches the simulation while automatic connection never launches it',async()=>{
  const calls=[],timers=[];
  const p=new SimulationClient({fetcher:async(url,options)=>{calls.push({url,options});return {ok:true,json:async()=>({status:'STARTING'})};},
    schedule:(callback,delay)=>{timers.push({callback,delay});return timers.length;},cancel:()=>{}});
  let connections=0;p.connect=async()=>connections++;
  assert.equal(await p.startSimulation(),true);assert.equal(await p.startSimulation(),false);
  assert.equal(calls.length,1);assert.equal(calls[0].url,'/api/simulation/start');
  assert.equal(calls[0].options.method,'POST');assert.equal(calls[0].options.body,'{}');
  assert.equal(connections,1);assert.equal(p.simulationStarting,true);
  p.disconnect('backend handoff');assert.equal(p.simulationStarting,true);
  timers.find(t=>t.delay===180_000).callback();assert.equal(p.simulationStarting,false);
  assert.match(p.operationError,/timed out/);
});

test('session reset waits for a new native session and blocks controls during the handoff',async()=>{
  const {p,snapshot,sent}=clientFixture(),calls=[];
  p.acceptSnapshot({...snapshot,sessionId:'old',mode:'MANUAL'});
  p.fetcher=async(url,options)=>{calls.push({url,options});return {ok:true,json:async()=>({status:'STARTING',operation:'RESET'})};};
  p.connect=async()=>true;p.schedule=()=>1;p.cancel=()=>{};
  assert.equal(await p.resetSimulation(),true);assert.equal(await p.resetSimulation(),false);
  assert.equal(calls[0].url,'/api/simulation/reset-session');assert.equal(calls[0].options.body,'{}');
  assert.equal(p.startDriving(),false);assert.deepEqual(sent,[]);
  p.acceptSnapshot({...snapshot,sessionId:'old',simulatorStart:{status:'STARTING',operation:'RESET'},
    vehicle:{...snapshot.vehicle,frame:2,timestamp:.1},world:{...snapshot.world,frame:2,timestamp:.1}});
  assert.equal(p.resetReady,false);assert.equal(p.resetting,true);
  p.acceptSnapshot({...snapshot,sessionId:'new',mode:'PAUSED',simulatorStart:{status:'READY'},
    vehicle:{...snapshot.vehicle,frame:0,timestamp:0},world:{...snapshot.world,frame:0,timestamp:0}});
  assert.equal(p.resetReady,true);assert.equal(p.resetting,false);assert.equal(p.simulationStarting,false);
});

test('failed start gives an actionable error and replay cannot launch CARLA',async()=>{
  let count=0;
  const p=new SimulationClient({fetcher:async()=>{count++;return {ok:false,json:async()=>({error:'GPU launch failed'})};},schedule:()=>1,cancel:()=>{}});
  assert.equal(await p.startSimulation(),false);assert.equal(p.simulationStarting,false);
  assert.equal(p.operationError,'GPU launch failed');p.isReplay=true;
  assert.equal(await p.startSimulation(),false);assert.equal(count,1);
  const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
  assert.match(html,/<button id="startSimulationBtn">Start the simulation<\/button>/);
  assert.doesNotMatch(html,/id="(?:reconnectBtn|nativeReconnectBtn)"/);
});

test('explicit GPU shutdown works from an observer but cannot grant pedal control',()=>{
  const {p,sent,snapshot}=clientFixture();p.acceptSnapshot({...snapshot,controller:false});
  assert.equal(p.stopSimulator(),true);assert.equal(sent.at(-1).type,'stop_simulator');
  assert.equal(p.send('controls',{controls:{throttle:1}}),false);
  p.isReplay=true;assert.equal(p.stopSimulator(),false);
});

test('comparison RUN can explicitly claim control while STOP and pedals require ownership',()=>{
  const {p,sent,snapshot}=clientFixture();p.acceptSnapshot({...snapshot,controller:false});
  assert.equal(p.dashboardAction('comparison_v2',{operation:'RUN',side:'MODEL'}),true);
  assert.equal(p.dashboardAction('comparison_v2',{operation:'STOP'}),false);
  assert.equal(p.send('controls',{controls:{throttle:1}}),false);
  assert.equal(sent.at(-1).type,'comparison_v2');
});

test('keyboard uses physical codes and never admits driving from an editable target', () => {
  assert.equal(DRIVING_KEYS.has('KeyW'),true); assert.equal(DRIVING_KEYS.has('w'),false);
  assert.equal(isEditableTarget({tagName:'INPUT'}),true);
  assert.equal(isEditableTarget({tagName:'DIV',isContentEditable:true}),true);
  const policy = {fresh:true,replay:false,owner:true,focused:true,modal:false,mode:'MANUAL',armed:true};
  assert.equal(drivingInputAllowed(policy),true);
  for (const field of ['fresh','owner','focused','armed']) assert.equal(drivingInputAllowed({...policy,[field]:false}),false);
  assert.equal(drivingInputAllowed({...policy,modal:true}),false);
  assert.equal(drivingInputAllowed({...policy,replay:true}),false);
  assert.equal(drivingInputAllowed({...policy,mode:'AUTOMATIC',armed:false}),false);
});

test('native restart accepts lower frames only after a genuine new session identity', () => {
  const {p,snapshot} = clientFixture();
  p.acceptSnapshot({...snapshot,sessionId:'one'});
  p.acceptSnapshot({...snapshot,sessionId:'two',vehicle:{...snapshot.vehicle,frame:0,timestamp:0},
    world:{...snapshot.world,frame:0,timestamp:0}});
  assert.equal(p.connected,true); assert.equal(p.lastFrame,0);
  p.acceptSnapshot({...snapshot,sessionId:'two',vehicle:{...snapshot.vehicle,frame:0,timestamp:.1},
    world:{...snapshot.world,frame:0,timestamp:.1}});
  assert.equal(p.connected,false);
});

test('choosing a route and heartbeating never emit manual pedal commands', () => {
  const {p,sent,snapshot} = clientFixture();
  p.acceptSnapshot({...snapshot,sessionId:'live',mode:'AUTOMATIC',journey:{status:'RUNNING'}});
  p.dashboardAction('destination','road-point-10'); p.journeyHeartbeat();
  assert.deepEqual(sent.map(s=>s.type),['destination','journey_heartbeat']);
  assert.equal(sent[1].session_id,'live');
});

test('safety comparison carries no driving commands and disconnect clears active status', () => {
  const {p,sent,snapshot} = clientFixture();
  const safety = {type:'RULE_BASED_SAFETY',enabled:true,active:true,intervention_count:2};
  p.acceptSnapshot({...snapshot,safetySystem:safety});
  assert.deepEqual(p.safetySystem,safety);
  p.dashboardAction('safety_mode',{enabled:false});
  assert.equal(sent[0].type,'safety_mode');assert.deepEqual(sent[0].value,{enabled:false});
  assert.equal(sent[0].controls,undefined);
  p.disconnect('test');assert.equal(p.safetySystem,null);
});

test('explicit destination start emits only journey request, never manual pedals or AI opt-in', () => {
  const {p,sent,snapshot} = clientFixture();
  p.acceptSnapshot({...snapshot,mode:'PAUSED',controller:false,navigationAvailable:true});
  assert.equal(p.navigationAvailable,true);
  assert.equal(p.startJourney(20),true);
  assert.deepEqual(sent.map(s=>s.type),['start_journey']);
  assert.equal(sent[0].speed_kmh,20);
  assert.equal(sent[0].controls,undefined);
  p.disconnect('test');
  assert.equal(p.navigationAvailable,false);
  assert.equal(p.startJourney(20),false);
});

test('production modules have no legacy world, renderer, or mock physics dependency', () => {
  for (const name of readdirSync(new URL('../frontend/', import.meta.url)).filter(n => n.endsWith('.js'))) {
    const module = readFileSync(new URL(`../frontend/${name}`, import.meta.url), 'utf8');
    assert.doesNotMatch(module, /(?:from\s*['"][^'"]*(?:legacy|three|vehicle-dynamics)|DevelopmentMockProvider|WebGLRenderer)/);
  }
});

test('missing observations stay unavailable, rather than decorative zero values', () => {
  const text = telemetryText(unavailableState(), {remote: true});
  assert.match(text, /Speed(?: magnitude)? unavailable/); assert.match(text, /suspension compression: unavailable/);
  assert.doesNotMatch(text, /NaN|Speed 0.0/);
});

function clientFixture() {
  let time = 100;
  const sent = [];
  const p = new SimulationClient({now: () => time});
  p.socket = {readyState: 1, send: json => sent.push(JSON.parse(json))};
  const snapshot = {type: 'snapshot', connected: true, controller: true,
    vehicle: {source: 'carla', speedMps: 10, frame: 1, timestamp: .05},
    world: {source: 'carla', frame: 1, timestamp: .05}};
  return {p, sent, snapshot, advance: ms => {time += ms;}};
}

test('disconnect retains explicitly saved journey evidence but clears live run authority',()=>{
  const {p,snapshot}=clientFixture();
  const result={side:'RULE',status:'ARRIVED',destination_arrived:true};
  p.acceptSnapshot({...snapshot,comparisonV2:{phase:'FINISHED',pair_id:'pair',results:{RULE:result},latest_attempt:result}});
  p.disconnect('offline');
  assert.equal(p.comparisonV2,null);
  assert.deepEqual(p.recordedComparisonV2.results.RULE,result);
  assert.equal(p.startDriving(),false);
  assert.equal(p.resetVehicle(),false);
});

test('reset is one atomic backend request without a racing manual pedal command',()=>{
  const {p,sent,snapshot}=clientFixture(); p.acceptSnapshot(snapshot);
  assert.equal(p.resetVehicle(),true);
  assert.deepEqual(sent.map(c=>c.type),['reset']);
});

test('a coalesced later acknowledgement retires queued start and stop requests together',()=>{
  const {p,snapshot}=clientFixture(); p.acceptSnapshot(snapshot);
  p.dashboardAction('comparison_v2',{operation:'RUN',side:'RULE'});
  p.stopDriving();
  assert.equal(p.pending.size,2);
  p.acceptSnapshot({...snapshot,acknowledged:2});
  assert.equal(p.pending.size,0);
});

test('read-only dashboard can explicitly claim driving without admitting pedals first', () => {
  const {p, sent, snapshot} = clientFixture();
  p.acceptSnapshot({...snapshot, controller:false, mode:'PAUSED'});
  p.updateControls({throttle:1}); assert.equal(sent.length, 0);
  assert.equal(p.startDriving(), true); assert.equal(sent[0].type, 'start_driving');
  p.updateControls({throttle:1}); assert.equal(sent.length, 1);
  p.acceptSnapshot({...snapshot, mode:'MANUAL'});
  p.updateControls({throttle:.4}); assert.equal(sent[1].controls.throttle, .4);
});

test('native reconnect is available on a disconnected socket but cannot escape replay', () => {
  const {p, sent, snapshot} = clientFixture();
  assert.equal(p.reconnectNative(), true); assert.equal(sent[0].type, 'reconnect');
  p.acceptSnapshot({...snapshot, connected:false, available:true, mode:'REPLAY', provider:'replay',
    replay:{dataOrigin:'REAL_SIMULATION', recordedProvider:'carla', runId:'test'}});
  assert.equal(p.reconnectNative(), false); assert.equal(p.startDriving(), false);
  assert.equal(sent.length, 1);
});

test('commands require fresh CARLA state and exclusive control ownership', () => {
  const {p, sent, snapshot, advance} = clientFixture();
  p.updateControls({throttle: 1}); assert.equal(sent.length, 0);
  p.acceptSnapshot(snapshot); p.updateControls({throttle: .2});
  p.updateControls({throttle: .3}); assert.equal(sent.length, 1);
  advance(40); p.updateControls({throttle: .3}); assert.equal(sent.length, 1);
  p.acceptSnapshot({...snapshot, vehicle:{...snapshot.vehicle,frame:2,timestamp:.1},
    world:{...snapshot.world,frame:2,timestamp:.1}});
  p.updateControls({throttle: .3});
  assert.equal(sent[0].controls.gear, 1); assert.equal(sent[1].controls.gear, undefined);
  advance(800); p.updateControls({throttle: 1}); assert.equal(sent.length, 2);
  assert.equal(p.getVehicleState().speedMps, null);
  p.acceptSnapshot({...snapshot, controller: false}); p.updateControls({throttle: 1});
  assert.equal(sent.length, 2);
});

test('pedal release deferred by the rate guard sends brake and never carries old throttle', () => {
  const {p, sent, snapshot, advance} = clientFixture();
  let release;
  p.schedule = action => {release = action; return 1;}; p.cancel = () => {};
  p.acceptSnapshot(snapshot); p.updateControls({throttle:1}); p.releaseControls();
  assert.equal(sent.length, 1);
  advance(35); release();
  assert.equal(sent[1].controls.throttle, 0); assert.equal(sent[1].controls.brake, 1);
  assert.equal(sent[1].controls.gear, undefined);
  p.updateControls({throttle:1}); p.releaseControls(); p.isReplay = true;
  advance(35); release(); assert.equal(sent.length, 2);
});

test('disconnect clears cached telemetry and never accepts a different source', () => {
  const {p, snapshot} = clientFixture();
  p.acceptSnapshot(snapshot); assert.equal(p.getVehicleState().speedMps, 10);
  p.acceptSnapshot({...snapshot, vehicle: {source: 'development-mock', speedMps: 90}});
  assert.equal(p.connected, false); assert.equal(p.getVehicleState().speedMps, null);
});

test('missing CARLA schedules bounded retry without creating a simulator', async () => {
  const scheduled = [];
  const p = new SimulationClient({fetcher: async () => ({ok: true, json: async () => ({provider: 'carla', configured: false})}),
    schedule: (callback, delay) => {scheduled.push({callback, delay}); return scheduled.length;}, cancel: () => {}});
  await p.connect();
  assert.equal(p.fresh, false);
  const retry = scheduled.find(item => item.delay === 1000);
  assert.ok(retry);
  p.close(); retry.callback(); assert.equal(p.closed, true);
  assert.equal(p.getVehicleState().engineRPM, null);
});

test('mismatched vehicle and world frames cannot enable controls', () => {
  const {p, sent, snapshot} = clientFixture();
  p.acceptSnapshot({...snapshot, world: {...snapshot.world, frame: 2}});
  p.updateControls({throttle: 1});
  assert.equal(p.fresh, false); assert.equal(sent.length, 0);
  p.acceptSnapshot({...snapshot, world: undefined});
  assert.equal(p.fresh, false);
});

test('S brakes forward motion before requesting reverse, and W brakes reverse first', () => {
  const c = new DrivingControls(); c.keys.add('KeyS');
  let command = c.sample(12, 0);
  assert.equal(command.brake, 1); assert.equal(command.throttle, 0); assert.equal(command.gear, 1);
  command = c.sample(0, 100); assert.equal(command.brake, 1);
  command = c.sample(0, 450); assert.equal(command.gear, -1); assert.equal(command.throttle, 1);
  c.keys.clear(); c.keys.add('KeyW');
  command = c.sample(-3, 500); assert.equal(command.brake, 1); assert.equal(command.gear, -1);
  command = c.sample(0, 700); assert.equal(command.gear, 1); assert.equal(command.throttle, .55);
});

test('Shift increases the W pedal without commanding motion on its own or overriding brakes', () => {
  const c=new DrivingControls();c.keys.add('ShiftLeft');
  assert.equal(c.sample(0,0).throttle,0);
  c.keys.add('KeyW');assert.equal(c.sample(0,1).throttle,1);
  c.keys.delete('ShiftLeft');assert.equal(c.sample(0,2).throttle,.55);
  c.keys.add('ShiftRight');c.keys.add('Space');assert.equal(c.sample(0,3).throttle,0);
  assert.equal(c.sample(0,3).brake,1);
  c.keys.delete('Space');
  assert.equal(c.sample(80/3.6,4).throttle,0);
  assert.equal(c.sample(81/3.6,5).brake>0,true);
  c.keys.delete('ShiftRight');
  assert.equal(c.sample(30/3.6,6).throttle,0);
  assert.equal(c.sample(60/3.6,7).brake>0,true);
});

test('neutral, contradictory pedals, missing speed, and handbrake cannot apply throttle', () => {
  const c = new DrivingControls(); c.keys.add('KeyW');
  c.setMode('N'); assert.equal(c.sample(0, 0).throttle, 0); assert.equal(c.sample(0, 0).gear, 0);
  c.setMode('D'); c.keys.add('KeyS'); assert.equal(c.sample(10, 0).brake, 1);
  c.keys.delete('KeyS'); c.keys.add('Space'); assert.equal(c.sample(10, 0).throttle, 0);
  c.keys.delete('Space'); assert.equal(c.sample(null, 0).throttle, 0);
});

test('recorded camera identity changes with frame, time or file reference', () => {
  const metadata = {frameAvailable: true, frame: 100, timestamp: 5, asset: {path: 'rgb/100.jpg'}};
  assert.equal(sensorFrameKey(metadata), sensorFrameKey({...metadata}));
  assert.notEqual(sensorFrameKey(metadata), sensorFrameKey({...metadata, frame: 101}));
  assert.notEqual(sensorFrameKey(metadata), sensorFrameKey({...metadata, timestamp: 5.05}));
  assert.notEqual(sensorFrameKey(metadata), sensorFrameKey({...metadata, asset: {path: 'rgb/101.jpg'}}));
  assert.equal(sensorFrameKey({...metadata, frame: NaN}), null);
  assert.equal(sensorFrameKey({...metadata, frameAvailable: false}), null);
});

test('camera bytes cannot be paired with metadata from another simulation frame', () => {
  const metadata = {frameAvailable: true, frame: 100, timestamp: 5};
  const headers = (frame, timestamp) => ({get: name => name === 'X-Sensor-Frame' ? frame : timestamp});
  assert.equal(matchesSensorResponse(metadata, headers('100', '5')), true);
  for (const values of [['101', '5.05'], ['100', '5.05'], [null, '5'], ['100', ''], ['100', 'NaN']]) {
    assert.equal(matchesSensorResponse(metadata, headers(...values)), false);
  }
});

test('recorded replay displays data but can never send native commands or claim connection', () => {
  // Contract packet only; no fixture is displayed in the actual browser.
  const {p, sent, snapshot} = clientFixture();
  p.acceptSnapshot({...snapshot, connected: false, available: true, mode: 'REPLAY', provider: 'replay',
    replay: {dataOrigin: 'REAL_SIMULATION', recordedProvider: 'carla', runId: 'contract-test'}});
  assert.equal(p.connected, false); assert.equal(p.controller, false); assert.equal(p.isReplay, true);
  assert.equal(p.getVehicleState().speedMps, 10);
  assert.match(p.status, /MODE: REPLAY/); assert.doesNotMatch(p.status, /CARLA — CONNECTED/);
  p.updateControls({throttle: 1}); p.resetVehicle(); p.setPaused(false); p.emergencyStop();
  assert.equal(sent.length, 0);
  p.acceptSnapshot({...snapshot, mode: 'REPLAY'}); assert.equal(p.fresh, false);
});

test('test-fixture replay is rejected by the production browser client', () => {
  const {p, snapshot} = clientFixture();
  p.acceptSnapshot({...snapshot, connected: false, available: true, provider: 'replay', mode: 'REPLAY',
    replay: {recordedProvider: 'carla', dataOrigin: 'TEST_FIXTURE'}});
  assert.equal(p.fresh, false); assert.equal(p.connected, false);
});

test('paused and emergency-stop states block pedals; controls carry explicit frame and time', () => {
  const {p, sent, snapshot} = clientFixture();
  p.acceptSnapshot({...snapshot, mode: 'PAUSED'}); p.updateControls({throttle: 1});
  assert.equal(sent.length, 0);
  p.acceptSnapshot({...snapshot, mode: 'EMERGENCY_STOP'}); p.updateControls({throttle: 1});
  p.acknowledgeStop(); assert.equal(sent[0].type, 'acknowledge_stop');
  p.acceptSnapshot({...snapshot, mode: 'MANUAL'}); p.updateControls({throttle: .2});
  assert.equal(sent[1].frame_id, 1); assert.equal(sent[1].timestamp_s, .05);
});

test('duplicate frames cannot refresh stale native data and invalid time ordering is rejected', () => {
  const {p, snapshot, advance} = clientFixture();
  p.acceptSnapshot(snapshot); advance(800); p.acceptSnapshot(snapshot);
  assert.equal(p.fresh, false);
  p.acceptSnapshot({...snapshot, vehicle: {...snapshot.vehicle, timestamp: .06}, world: {...snapshot.world, timestamp: .06}});
  assert.equal(p.connected, false); assert.equal(p.phase, 'ERROR');
});

test('connection timeout ignores a late HTTP completion instead of opening a socket', async () => {
  let resolve, callback, opened = 0;
  const p = new SimulationClient({fetcher: () => new Promise(r => {resolve = r;}),
    Socket: class {constructor() {opened++;}}, location: {protocol: 'http:', hostname: 'localhost'},
    schedule: (action, delay) => {if (delay === 5000) callback = action; return delay;}, cancel: () => {}});
  const pending = p.connect(); callback();
  resolve({ok: true, json: async () => ({configured: true, provider: 'carla', websocketPort: 8001})});
  await pending;
  assert.equal(opened, 0); assert.equal(p.connected, false); p.close();
});
