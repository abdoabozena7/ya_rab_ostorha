import test from 'node:test';
import assert from 'node:assert/strict';
import { DevelopmentMockProvider, WHEEL_RADIUS_M } from '../src/simulation/provider.js';
import { BeamNGProvider,unavailableBeamNGState } from '../src/simulation/beamng-provider.js';
import { telemetryText } from '../src/ui/telemetry.js';

test('development provider wheel speed and spin follow vehicle displacement', () => {
  const provider = new DevelopmentMockProvider();
  for (let i = 0; i < 120; i++) provider.step({ forward: true, throttle: 1 });
  const state = provider.getVehicleState();
  assert.ok(state.speedMps > 0);
  for (const wheel of state.wheels) {
    assert.ok(Math.abs(wheel.angularVelocityRadps - state.speedMps / WHEEL_RADIUS_M) < 1e-8);
    assert.ok(wheel.angleRad > 0);
  }
});

test('development fuel flow responds to load and empty tank removes power', () => {
  const idle = new DevelopmentMockProvider();
  idle.step({ throttle: 0 });
  const driving = new DevelopmentMockProvider();
  driving.step({ forward: true, throttle: 1 });
  assert.ok(driving.getVehicleState().instantConsumptionLph > idle.getVehicleState().instantConsumptionLph);
  driving.setFuelLitres(0);
  for (let i = 0; i < 60; i++) driving.step({ forward: true, throttle: 1 });
  assert.equal(driving.getVehicleState().engineRunning, false);
  assert.equal(driving.getVehicleState().throttle, 0);
});

test('development collision records impulse and component damage', () => {
  const provider = new DevelopmentMockProvider();
  const impact = provider.recordCollision({ speedMps: 20, direction: 'front',
    position: { x: 1, z: 2 }, component: 'front' });
  assert.ok(impact.impulseNs > 0);
  assert.equal(impact.position.x, 1);
  assert.ok(provider.getDamageState().cooling > 0);
  assert.equal(provider.getSensorFrame('lidar'), null);
});

test('empty fuel cannot power reverse and temperature remains bounded',()=>{
  const p=new DevelopmentMockProvider();p.setFuelLitres(0);
  for(let i=0;i<180;i++)p.step({backward:true,throttle:1});
  assert.equal(p.getVehicleState().speedMps,0);
  const driving=new DevelopmentMockProvider();
  for(let i=0;i<3600;i++)driving.step({forward:true,throttle:1});
  assert.ok(driving.getVehicleState().engineTemperatureC<105);
});

test('missing BeamNG observations are shown as unavailable, never zero',()=>{
  const state=unavailableBeamNGState();assert.equal(state.speedMps,null);
  const text=telemetryText(state,{remote:true});
  assert.match(text,/Speed unavailable/);assert.match(text,/Suspension unavailable/);
  assert.doesNotMatch(text,/NaN|Speed 0.0/);
});

test('initial gear command survives disconnected controls and is sent only once',()=>{
  const p=new BeamNGProvider(),sent=[];
  p.updateControls({throttle:0});assert.equal(p.gearCommand,1);
  p.controller=true;p.socket={readyState:1,send:json=>sent.push(JSON.parse(json))};
  p.updateControls({throttle:.2});p.updateControls({throttle:.3});
  assert.equal(sent[0].controls.gear,1);
  assert.equal(sent[1].controls.gear,undefined);
});
