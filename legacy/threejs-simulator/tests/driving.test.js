import test from 'node:test';
import assert from 'node:assert/strict';
import { createFixedStep, SPEED_TO_KMH } from '../src/simulation/fixed-step.js';
import { stepManualDriving, MAX_FORWARD_SPEED, MAX_REVERSE_SPEED } from '../src/simulation/manual-driving.js';
import { canAdvance, guardDynamicMotion } from '../src/simulation/safety.js';

const initial = () => ({ speed:0, angle:0, steering:0, reverseWait:0 });
function drive(frames, input, state=initial()) {
  for(let i=0;i<frames;i++) state=stepManualDriving(state,input);
  return state;
}

test('six seconds of driving has identical travel at 30, 60 and 144 display FPS', () => {
  function run(fps) {
    const clock=createFixedStep();
    let state=initial(), distance=0, ticks=0;
    for(let frame=0;frame<fps*6;frame++) clock.advance(1/fps,()=>{
      state=stepManualDriving(state,{forward:true}); distance+=state.speed; ticks++;
    });
    return {distance,speed:state.speed,ticks};
  }
  assert.deepEqual(run(30),run(60));
  assert.deepEqual(run(144),run(60));
  assert.equal(run(60).ticks,360);
  assert.ok(run(60).speed*SPEED_TO_KMH>50);
  assert.ok(run(60).speed<=MAX_FORWARD_SPEED);
});

test('a stalled/background frame cannot cause unbounded catch-up', () => {
  const clock=createFixedStep(); let ticks=0;
  clock.advance(12,()=>ticks++);
  assert.equal(ticks,6);
  clock.advance(1/120,()=>ticks++);
  clock.reset();
  clock.advance(1/120,()=>ticks++);
  assert.equal(ticks,6);
});

test('braking stops first, then holding S selects capped reverse', () => {
  let state={...initial(),speed:50/SPEED_TO_KMH};
  state=drive(110,{backward:true},state);
  assert.equal(state.speed,0);
  state=drive(4,{backward:true},state);
  assert.equal(state.speed,0);
  state=drive(200,{backward:true},state);
  assert.equal(state.speed,-MAX_REVERSE_SPEED);
});

test('Space stops either direction and never accelerates', () => {
  for(const speed of [MAX_FORWARD_SPEED,-MAX_REVERSE_SPEED]) {
    const state=drive(450,{handbrake:true,forward:true},{...initial(),speed});
    assert.equal(state.speed,0);
  }
});

test('steering cannot pivot at rest and turns oppositely in reverse', () => {
  assert.equal(drive(60,{left:true}).angle,0);
  assert.ok(drive(60,{left:true,forward:true}).angle>0);
  assert.ok(drive(60,{right:true,forward:true}).angle<0);
  assert.ok(drive(60,{left:true,backward:true}).angle<0);
});

test('release coasts to a full stop and opposite pedals brake', () => {
  const state=drive(20000,{},drive(200,{forward:true}));
  assert.equal(state.speed,0);
  assert.equal(drive(450,{forward:true,backward:true},{...initial(),speed:MAX_FORWARD_SPEED}).speed,0);
});

test('reverse motion is guarded behind the vehicle and permits escaping overlap', () => {
  const actor={position:{x:0,z:-3.2},radius:1,velocity:{x:0,z:0}};
  assert.equal(guardDynamicMotion({x:0,z:0},0,-MAX_REVERSE_SPEED,[actor]).speed,0);
  assert.equal(canAdvance({x:0,z:0},{x:0,z:-1},[actor],2.65),false);
  assert.equal(canAdvance({x:0,z:0},{x:0,z:1},[actor],2.65),true);
});
