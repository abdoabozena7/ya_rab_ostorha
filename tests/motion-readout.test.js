import test from 'node:test';
import assert from 'node:assert/strict';
import {motionReadout,objectReadout} from '../frontend/motion-readout.js';
test('stale scenes never claim a clear path and zero remains a measured value',()=>{
  const p={sessionId:'s',maneuver:{action:'CONTINUE',front_gap_m:0}},prediction={session_id:'s',timestamp_s:1};
  assert.equal(motionReadout(p,prediction,{timestamp:2}).state,'Insufficient data');
  const current=motionReadout(p,prediction,{timestamp:1,speedKmh:0});
  assert.equal(current.state,'No predicted intersection');assert.ok(current.values[1][1].startsWith('0.0'));
});
test('object direction uses movement and gaze remains unknown',()=>{
  const text=objectReadout({id:'1',class:'person',position_m:[10,4],velocity_mps:[1,0],half_size_m:[.3,.3]},null,null,4);
  assert.ok(text.includes('0.0° relative to ego'));assert.ok(text.includes('gaze unknown'));
});
test('ordinary RULE driving still reports the measured conflict and applied braking',()=>{
  const p={sessionId:'s',maneuver:{action:'RULE_FOLLOW'},stopDiagnostics:{braking:true,reason:'FORWARD_COLLISION_RISK'}};
  const value=motionReadout(p,{session_id:'s',timestamp_s:1,conflict_point:{time_s:1}},{timestamp:1,speedKmh:10});
  assert.equal(value.state,'Possible intersection');assert.equal(value.action,'RULE BRAKE');
});
test('unknown road coverage cannot be displayed as a clear prediction',()=>{
  const p={sessionId:'s',safetySystem:{risk:'UNKNOWN_SPACE'},maneuver:{action:'RULE_FOLLOW'}};
  assert.equal(motionReadout(p,{session_id:'s',timestamp_s:1},{timestamp:1}).state,'Insufficient data');
});

test('deferred diagnostic scoring never becomes a no-intersection claim',()=>{
  const p={sessionId:'s',maneuver:{action:'RULE_FOLLOW'}};
  for(const flag of ['diagnostic_scoring_deferred','display_observer_deferred']){
    const value=motionReadout(p,{session_id:'s',timestamp_s:1,[flag]:true},{timestamp:1});
    assert.equal(value.state,'Intersection scoring deferred');
  }
});
