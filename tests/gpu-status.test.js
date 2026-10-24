import test from 'node:test';
import assert from 'node:assert/strict';
import {gpuStatus} from '../frontend/gpu-status.js';
import {missionState} from '../frontend/mission-state.js';

const gpu={name:'Fixture GPU',usedMiB:5950,totalMiB:6144,utilizationPercent:29,observedAtUnix:100};
const provider=(patch={},extra={})=>({performance:{gpu:{...gpu,...patch},gpuBudget:{limitMiB:4608}},...extra});

test('device VRAM pressure and GPU utilization are different measured counters',()=>{
  const state=gpuStatus(provider(),102);
  assert.equal(state.status,'critical');assert.match(state.memory,/5,950 \/ 6,144 MiB · 97% VRAM/);
  assert.equal(state.load,'29% GPU load');assert.match(state.detail,/194 MiB available/);
  assert.match(state.detail,/nearly full/);assert.match(state.budget,/target exceeded.*all apps.*advisory only/);
  assert.equal(state.freshness,'Updated 2 s ago');
  assert.equal(gpuStatus(provider({usedMiB:5600}),100).status,'high');
  assert.equal(gpuStatus(provider({usedMiB:2000}),100).status,'normal');
});

test('stale, undated and future samples are never presented as current',()=>{
  for(const observedAtUnix of [90,undefined,NaN,110]){
    const state=gpuStatus(provider({observedAtUnix}),100);
    assert.equal(state.status,'stale');assert.equal(state.budget,'');assert.doesNotMatch(state.freshness,/^Updated/);
    assert.match(state.detail,/last reported/);assert.doesNotMatch(state.detail,/nearly full/);
  }
  assert.equal(gpuStatus(provider(),106).status,'critical');
  assert.equal(gpuStatus(provider(),106.1).status,'stale');
});

test('missing and invalid measurements never become zero usage or a ready GPU',()=>{
  for(const input of [{},{performance:{gpu:null,gpuMonitorError:'test error'}}]){
    const state=gpuStatus(input,100);assert.equal(state.percent,null);assert.equal(state.status,'unavailable');
    assert.equal(state.memory,'VRAM unmeasured');assert.equal(state.load,'GPU load unmeasured');
  }
  for(const patch of [{usedMiB:null},{totalMiB:0},{usedMiB:-1},{usedMiB:7000},{usedMiB:'5950'}]){
    const state=gpuStatus(provider(patch),100);assert.equal(state.percent,null);assert.equal(state.memory,'VRAM unmeasured');
  }
  assert.equal(gpuStatus(provider({utilizationPercent:null}),100).load,'GPU load unmeasured');
  assert.equal(gpuStatus(provider({usedMiB:0,utilizationPercent:0}),100).percent,0);
});

test('shutdown confirmation uses lifecycle, while remaining device VRAM can stay nonzero',()=>{
  const closing=gpuStatus(provider({}, {simulatorStop:{status:'STOPPING'}}),100);
  assert.match(closing.detail,/confirmed by process exit/);assert.equal(closing.status,'critical');
  const stopped=gpuStatus(provider({}, {simulatorStop:{status:'STOPPED'}}),100);
  assert.match(stopped.detail,/CARLA is closed/);assert.match(stopped.memory,/97%/);
  assert.match(gpuStatus({simulatorStop:{status:'STOPPED'}},100).detail,/CARLA is closed/);
  const replay=gpuStatus(provider({}, {isReplay:true}),100);
  assert.equal(replay.percent,null);assert.match(replay.detail,/replay/);
});

test('VRAM readings cannot admit an unprepared drive or block lifecycle recovery',()=>{
  const preparing={connected:true,fresh:true,presentation:{guided:true,status:'PREPARING',preloaded:true,awaiting_choice:true}};
  for(const usedMiB of [0,5950]){
    assert.equal(missionState({...preparing,...provider({usedMiB})},{firstMode:'NORMAL'}).action,null);
    const closing=missionState({...preparing,...provider({usedMiB}),simulatorStop:{status:'STOPPING'}});
    assert.equal(closing.loadingDrive,true);assert.equal(closing.label,'Closing CARLA…');assert.equal(closing.action,null);
    assert.equal(missionState({...preparing,...provider({usedMiB}),simulatorStop:{status:'FAILED'}}).action,'FREE_GPU');
  }
});
