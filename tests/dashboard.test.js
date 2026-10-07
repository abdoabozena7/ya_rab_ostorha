import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import {SimulationClient, unavailableState} from '../frontend/simulation-client.js';
import {DrivingControls} from '../frontend/controls.js';
import {telemetryText} from '../frontend/telemetry.js';
import {sensorFrameKey, matchesSensorResponse} from '../frontend/sensor-frame.js';

test('production modules have no legacy world, renderer, or mock physics dependency', () => {
  for (const name of readdirSync(new URL('../frontend/', import.meta.url)).filter(n => n.endsWith('.js'))) {
    const module = readFileSync(new URL(`../frontend/${name}`, import.meta.url), 'utf8');
    assert.doesNotMatch(module, /(?:from\s*['"][^'"]*(?:legacy|three|vehicle-dynamics)|DevelopmentMockProvider|WebGLRenderer)/);
  }
});

test('missing observations stay unavailable, rather than decorative zero values', () => {
  const text = telemetryText(unavailableState(), {remote: true});
  assert.match(text, /Speed unavailable/); assert.match(text, /suspension compression: unavailable/);
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

test('commands require fresh CARLA state and exclusive control ownership', () => {
  const {p, sent, snapshot, advance} = clientFixture();
  p.updateControls({throttle: 1}); assert.equal(sent.length, 0);
  p.acceptSnapshot(snapshot); p.updateControls({throttle: .2}); p.updateControls({throttle: .3});
  assert.equal(sent[0].controls.gear, 1); assert.equal(sent[1].controls.gear, undefined);
  advance(800); p.updateControls({throttle: 1}); assert.equal(sent.length, 2);
  assert.equal(p.getVehicleState().speedMps, null);
  p.acceptSnapshot({...snapshot, controller: false}); p.updateControls({throttle: 1});
  assert.equal(sent.length, 2);
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
  command = c.sample(0, 700); assert.equal(command.gear, 1); assert.equal(command.throttle, 1);
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
