import test from 'node:test';
import assert from 'node:assert/strict';
import {missionState,stressSummary} from '../frontend/mission-state.js';
const ready={connected:true,fresh:true,controller:true,simulatorStop:{available:true}};
const guided=(status,arm=0,first='NORMAL')=>({...ready,presentation:{guided:true,id:'current',status,arm,modes:[first,first==='NORMAL'?'ROBOSPHERE':'NORMAL']}});

test('preloaded world can be inspected while preparing but only starts once held and ready',()=>{
  const loading=guided('PREPARING');loading.presentation.preloaded=true;loading.presentation.awaiting_choice=true;
  const selecting=missionState(loading,{firstMode:'NORMAL'});
  assert.equal(selecting.choices,true);assert.equal(selecting.action,null);assert.match(selecting.detail,/60 vehicles and 100 pedestrians/);
  loading.presentation.status='CHOOSING';assert.equal(missionState(loading,{firstMode:'ROBOSPHERE'}).action,'START_GUIDED');
  loading.controller=false;assert.equal(missionState(loading,{firstMode:'ROBOSPHERE'}).action,'START_GUIDED');
  assert.equal(missionState(loading).action,null);
});
test('stopped and loading never expose stale camera or old results',()=>{
  const p={connected:false,presentation:{id:'old',status:'COMPLETE'},journeyComparison:{runs:{NORMAL:{status:'COLLISION'}}}};
  assert.equal(missionState(p).action,'START_SIMULATION');assert.equal(missionState(p).camera,false);
  assert.equal(missionState({...p,simulationStarting:true}).action,null);
  assert.equal(missionState({...p,simulationStarting:true}).screen,'loading');
});
test('selection and native preparation are distinct screens',()=>{
  assert.equal(missionState(ready).choices,true);assert.equal(missionState(ready).action,null);
  assert.equal(missionState(ready,{firstMode:'NORMAL'}).action,'START_GUIDED');
  for(const phase of ['PREPARING','READY','STARTING','FINALIZING','RESTORING','RECOVERING']){
    assert.equal(missionState(guided(phase)).action,null);assert.equal(missionState(guided(phase)).camera,false);
  }
});
test('both orders have the correct next action; second stops to compare',()=>{
  assert.equal(missionState(guided('DRIVING')).label,'See the solution now');
  assert.equal(missionState(guided('DRIVING',0,'ROBOSPHERE')).label,'See the world before our solution');
  assert.equal(missionState(guided('DRIVING',1)).label,'End drive & compare');
  assert.equal(missionState(guided('RESULTS')).action,'FINISH');
});
test('contact outcome and independent GPU release survive loading',()=>{
  const p=guided('AWAITING_NEXT');p.presentation.pair_id='p';p.presentation.runs={NORMAL:{status:'COLLISION'}};
  assert.match(missionState(p).title,/after a contact/);assert.equal(missionState(p).action,'NEXT');
  assert.equal(missionState(guided('FINALIZING')).freeGPU,true);
  assert.equal(missionState(p,{shutdownPending:true}).action,null);
});
test('faults expose only contextual retries and emergency release',()=>{
  const p=guided('ERROR');p.presentation.failed_phase='RESTORING';assert.equal(missionState(p).action,'RETRY_STEP');
  p.presentation.failed_phase='DRIVING';assert.equal(missionState(p).action,null);
  assert.equal(missionState({...p,controlMode:'EMERGENCY_STOP'}).action,'RELEASE');
  assert.equal(missionState({...ready,simulatorStop:{status:'FAILED',error:'process still alive'}}).action,'FREE_GPU');
});

test('stress shortfalls remain visible with actual measured counts',()=>{
  const text=stressSummary({passed:false,counts:{vehicles:{front_frustum_100m:4,moving_front_frustum:3},pedestrians:{front_frustum_100m:19,moving_front_frustum:10}}});
  assert.match(text,/below the local target/);assert.match(text,/4 vehicles and 19 pedestrians/);
  assert.match(text,/Buildings may hide/);assert.equal(stressSummary(null),'');
  assert.match(stressSummary({passed:true,sustained_passed:false}),/below the local target/);
  assert.match(stressSummary({motion_measurement_ready:false,series:{motion_samples:0,samples:1,density_failures:0}}),/Motion not measured yet/);
});
