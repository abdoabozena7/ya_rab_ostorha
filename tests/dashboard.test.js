import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import {SimulationClient, unavailableState} from '../frontend/simulation-client.js';
import {DrivingControls} from '../frontend/controls.js';
import {telemetryText} from '../frontend/telemetry.js';

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
  assert.equal(p.fresh, false); assert.equal(scheduled[0].delay, 1000);
  p.close(); scheduled[0].callback(); assert.equal(p.closed, true);
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
