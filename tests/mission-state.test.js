import test from 'node:test';
import assert from 'node:assert/strict';
import {missionState,missionStatus,stressSummary,missionFailure,preloadWasObserved} from '../frontend/mission-state.js';
const ready={connected:true,fresh:true,controller:true,simulatorStop:{available:true}};
const guided=(status,arm=0,first='NORMAL')=>({...ready,presentation:{guided:true,id:'current',status,arm,modes:[first,first==='NORMAL'?'ROBOSPHERE':'NORMAL']}});

test('primary status separates preparation, driving, saving and verification from readiness',()=>{
  assert.equal(missionStatus(missionState(guided('CHOOSING'))),'Ready');
  assert.equal(missionStatus(missionState(guided('PREPARING'))),'Preparing');
  assert.equal(missionStatus(missionState(guided('DRIVING'))),'Running');
  assert.equal(missionStatus(missionState(guided('FINALIZING'))),'Saving');
  for(const phase of ['FINISHING','COMPLETE']){
    const p=guided(phase);p.presentation.pair_id='saved';p.connected=false;
    assert.equal(missionStatus(missionState(p)),phase==='FINISHING'?'Saving':'Ready');
  }
  const results=guided('RESULTS');results.presentation.pair_id='saved';
  assert.equal(missionStatus(missionState(results,{commandPending:true})),'Saving');
  assert.equal(missionStatus(missionState(ready,{shutdownPending:true})),'Saving');
  assert.equal(missionStatus(missionState(guided('ERROR'))),'Verification Required');
  assert.equal(missionStatus(missionState({...ready,controlMode:'EMERGENCY_STOP'})),'Verification Required');
  assert.equal(missionStatus(missionState(guided('DRIVING')),{verificationRequired:true}),'Verification Required');
  assert.equal(missionStatus(missionState(guided('CHOOSING')),{verificationRequired:true}),'Verification Required');
});

test('the primary action waits for the server-confirmed post-release sensor stage',()=>{
  const p={...guided('STARTING'),journey:{startup_stage:'WAITING_FOR_FRESH_SENSORS'}};
  const state=missionState(p);
  assert.equal(state.action,null);assert.equal(state.label,'Waiting for fresh sensors…');
  assert.equal(state.loadingDrive,true);
});

test('an acknowledged observational preload does not leave another active session behind a loader',()=>{
  const local={pageId:'observer',preloadRequested:true,pageAdmitted:false,preloadSequence:12};
  const p={...guided('DRIVING'),controller:false,acknowledged:12};
  assert.equal(preloadWasObserved(p,local),true);
  assert.equal(preloadWasObserved({...p,acknowledged:11},local),false);
  assert.equal(preloadWasObserved({...p,presentation:{...p.presentation,page_id:'observer'}},local),false);
  assert.equal(preloadWasObserved(p,{...local,pageAdmitted:true}),false);
  assert.equal(preloadWasObserved({...p,presentation:{...p.presentation,status:'CANCELLED'}},local),false);
  const resolved={...local,preloadRequested:false,observing:true};
  assert.equal(missionState(p,resolved).camera,true);
});
test('automatic crossing runs expose no shortening action in either order',()=>{
  for(const first of ['NORMAL','ROBOSPHERE'])for(const arm of [0,1]){
    const p=guided('DRIVING',arm,first);p.presentation.automatic_pair=true;
    const state=missionState(p);assert.equal(state.action,null);assert.equal(state.camera,true);
    assert.match(state.detail,/until the destination or a contact/);
  }
});

test('sensor handoff keeps the preparation title, layout and loader until its native phase changes',()=>{
  for(const phase of ['STOPPING','PREPARING','READY','SELECTING','STARTING','RESTORING','FINALIZING']){
    for(const awaiting of [false,true]){
      const p=guided(phase);Object.assign(p.presentation,{preloaded:true,awaiting_choice:awaiting});
      const local={firstMode:'NORMAL'},expected=missionState(p,local);
      const stable=s=>Object.fromEntries(['screen','title','detail','label','choices','loadingDrive'].map(k=>[k,s[k]]));
      assert.deepEqual(stable(missionState({...p,fresh:false},local)),stable(expected));
      assert.deepEqual(stable(missionState({...p,fresh:false,connected:false,transportAlive:true},local)),stable(expected));
    }
  }
});

test('real faults explain their cause and recovery without raw interruption codes',()=>{
  for(const [reason,detail] of [['ya_rab_ostorha_sensor_fault',/sensor measurements/],['dashboard_heartbeat_timeout',/connection was lost/],['recording_failure',/saving/],['presentation_phase_timeout:RESTORING',/Retry the step/]]){
    const p=guided('ERROR');p.presentation.reason=reason;
    assert.match(missionState(p).detail,detail);assert.doesNotMatch(missionState(p).detail,/Interrupted|_/);
  }
  assert.match(missionFailure('Interrupted'),/recorded portion is saved/);
});

test('preloaded world can be inspected while preparing but only starts once held and ready',()=>{
  const loading=guided('PREPARING');loading.presentation.preloaded=true;loading.presentation.awaiting_choice=true;
  const selecting=missionState(loading,{firstMode:'NORMAL'});
  assert.equal(selecting.choices,true);assert.equal(selecting.action,null);assert.match(selecting.detail,/60 vehicles and 100 pedestrians/);
  assert.equal(selecting.loadingDrive,true);assert.equal(selecting.label,'Preparing your drive…');assert.equal(selecting.freeGPU,false);
  loading.presentation.status='CHOOSING';assert.equal(missionState(loading,{firstMode:'ROBOSPHERE'}).action,'START_GUIDED');
  assert.equal(missionState(loading,{firstMode:'ROBOSPHERE'}).loadingDrive,false);assert.equal(missionState(loading).freeGPU,true);
  loading.controller=false;assert.equal(missionState(loading,{firstMode:'ROBOSPHERE'}).action,'START_GUIDED');
  assert.equal(missionState(loading).action,null);
});
test('stopped and loading never expose stale camera or old results',()=>{
  const p={connected:false,presentation:{id:'old',status:'COMPLETE'},journeyComparison:{runs:{NORMAL:{status:'COLLISION'}}}};
  assert.equal(missionState(p).action,'START_SIMULATION');assert.equal(missionState(p).camera,false);
  assert.equal(missionState({...p,simulationStarting:true}).action,null);
  assert.equal(missionState({...p,simulationStarting:true}).loadingDrive,true);
});
test('a page never starts from another page’s scene or shows its GPU action',()=>{
  const p=guided('CHOOSING');Object.assign(p.presentation,{preloaded:true,awaiting_choice:true,page_id:'other-page'});
  const waiting=missionState(p,{pageId:'this-page',preloadRequested:true,firstMode:'NORMAL'});
  assert.equal(waiting.action,null);assert.equal(waiting.loadingDrive,true);assert.equal(waiting.freeGPU,false);
  const replaced=missionState(p,{pageId:'this-page',pageAdmitted:true,preloadRequested:true,firstMode:'NORMAL'});
  assert.equal(replaced.action,'PREPARE_HERE');assert.equal(replaced.freeGPU,false);assert.equal(replaced.loadingDrive,false);
  p.presentation.page_id='this-page';
  assert.equal(missionState(p,{pageId:'this-page',firstMode:'NORMAL'}).action,'START_GUIDED');
  p.presentation.status='DRIVING';p.presentation.awaiting_choice=false;p.presentation.page_id='other-page';
  assert.equal(missionState(p,{pageId:'this-page',pageAdmitted:true}).action,'PREPARE_HERE');
});
test('native preparation stages advance the organic fill; rejected requests have a recovery action',()=>{
  for(const [phase,step] of [['STOPPING',1],['PREPARING',2],['READY',3],['CHOOSING',4]]){
    const p=guided(phase);Object.assign(p.presentation,{preloaded:true,awaiting_choice:true});
    assert.equal(missionState(p,{firstMode:'NORMAL'}).loadStep,step);
  }
  const failure=missionState(ready,{preloadError:'Scene request rejected'});
  assert.equal(failure.action,'PREPARE_HERE');assert.equal(failure.freeGPU,false);assert.match(failure.detail,/rejected/);
  const cancelled=guided('CANCELLED');Object.assign(cancelled.presentation,{preloaded:true,page_id:'this-page',reason:'dashboard_disconnected'});
  const reconnect=missionState(cancelled,{pageId:'this-page',pageAdmitted:true,preloadRequested:true});
  assert.equal(reconnect.action,'PREPARE_HERE');assert.equal(reconnect.loadingDrive,false);
});
test('startup and preload acknowledgement keep a blocked start and hide GPU release',()=>{
  for(const [p,local] of [
    [{...ready,connected:false,simulationStarting:true},{}],
    [{...ready,fresh:false},{}],
    [ready,{preloadRequested:true}],
    [guided('READY'),{}],
  ]){
    if(p.presentation)Object.assign(p.presentation,{preloaded:true,awaiting_choice:true});
    const state=missionState(p,{...local,firstMode:'ROBOSPHERE'});
    assert.equal(state.action,null);assert.equal(state.loadingDrive,true);assert.equal(state.choices,true);
    assert.doesNotMatch(state.label,/^Start the protected drive$/);assert.match(state.label,/…$/);assert.equal(state.freeGPU,false);
  }
  assert.equal(missionState({...ready,connected:false}).freeGPU,false);
});
test('GPU release remains independent once a prepared scene has been admitted',()=>{
  for(const phase of ['CHOOSING','SELECTING','DRIVING','FINALIZING','RESTORING','RESULTS']){
    const p=guided(phase);Object.assign(p.presentation,{preloaded:true,awaiting_choice:phase==='CHOOSING',prepared_condition_id:'held-start'});
    assert.equal(missionState(p).freeGPU,true,phase);
    assert.equal(missionState(p,{shutdownPending:true}).freeGPU,false,phase);
    assert.equal(missionState({...p,connected:false,fresh:false}).freeGPU,true,phase+' after connection loss');
  }
});
test('selection and native preparation are distinct screens',()=>{
  assert.equal(missionState(ready).choices,true);assert.equal(missionState(ready).action,null);
  assert.equal(missionState(ready,{firstMode:'NORMAL'}).action,'START_GUIDED');
  for(const phase of ['PREPARING','READY','STARTING','FINALIZING','RESTORING','RECOVERING']){
    assert.equal(missionState(guided(phase)).action,null);assert.equal(missionState(guided(phase)).camera,false);
  }
});
test('both orders have the correct next action; second stops to compare',()=>{
  assert.equal(missionState(guided('DRIVING')).label,'See predictive driving now');
  assert.equal(missionState(guided('DRIVING',0,'ROBOSPHERE')).label,'See reactive sensor driving now');
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

test('results survive Finish, native disconnection, shutdown and a refreshed page',()=>{
  for(const phase of ['RESULTS','FINISHING','COMPLETE'])for(const connected of [true,false]){
    const p=guided(phase,1);p.presentation.pair_id='saved';p.connected=connected;p.fresh=connected;
    p.simulatorStop={available:true,status:phase==='COMPLETE'?'STOPPED':'IDLE'};
    const state=missionState(p);
    assert.equal(state.screen,'comparison');assert.equal(state.freeGPU,false);
    assert.equal(state.action,phase==='RESULTS'?'FINISH':phase==='COMPLETE'?'NEW_DRIVE':null);
    assert.equal(state.loadingDrive,phase==='FINISHING');
  }
});

test('the selected Start button stays busy throughout native car and recording preparation',()=>{
  for(const phase of ['SELECTING','READY','STARTING']){
    const p=guided(phase);Object.assign(p.presentation,{preloaded:true,awaiting_choice:false});
    const state=missionState(p,{firstMode:'NORMAL'});
    assert.equal(state.screen,'choose');assert.equal(state.choices,true);assert.equal(state.loadingDrive,true);assert.equal(state.action,null);
  }
});
