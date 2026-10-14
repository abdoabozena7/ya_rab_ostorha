import test from 'node:test';
import assert from 'node:assert/strict';
import {comparisonStartBlocked,comparisonV2Busy} from '../frontend/comparison-v2.js';
import {driveState} from '../frontend/workspace-state.js';
const ready={fresh:true,controller:true,controlMode:'PAUSED',comparisonV2:{phase:'IDLE',budget:{remaining_s:1000,recommended_run_allowance_s:600}}};

test('RULE journey admission shows exhausted/unknown budget and all lifecycle blocks',()=>{
  assert.equal(comparisonStartBlocked(ready),'');
  assert.match(comparisonStartBlocked({...ready,comparisonV2:{phase:'IDLE'}}),/allowance/);
  assert.match(comparisonStartBlocked({...ready,comparisonV2:{...ready.comparisonV2,budget:{remaining_s:40.703,recommended_run_allowance_s:600}}}),/40.7 s/);
  for(const phase of ['QUEUED','RESETTING','RUNNING','STOPPING']) {
    assert.equal(comparisonV2Busy({phase}),true);
    assert.match(comparisonStartBlocked({...ready,comparisonV2:{...ready.comparisonV2,phase}}),/active/);
  }
  assert.match(comparisonStartBlocked({...ready,restarting:true}),/restart/);
  assert.match(comparisonStartBlocked({...ready,isReplay:true}),/read only/);
  assert.match(comparisonStartBlocked({...ready,fresh:false}),/Connect/);
  assert.match(comparisonStartBlocked({...ready,controlMode:'EMERGENCY_STOP'}),/Acknowledge/);
});

test('RULE is the default journey action; latest interrupted/failing attempts never show arrival',()=>{
  assert.equal(driveState(ready,{speedKmh:0}).action,'ruleDrivingBtn');
  for(const [status,tone] of [['INTERRUPTED','warning'],['TIMEOUT','warning'],['FAILURE','danger'],['COLLISION','danger'],['ARRIVED','success']]) {
    const view=driveState({...ready,comparisonV2:{...ready.comparisonV2,phase:'FINISHED',latest_attempt:{status}}},{speedKmh:0});
    assert.equal(view.tone,tone); assert.equal(view.action,'resultsTab');
    assert.equal(view.label==='Journey arrived',status==='ARRIVED');
  }
  assert.equal(driveState({...ready,comparisonV2:{phase:'QUEUED'}},{speedKmh:0}).action,'pauseBtn');
});
