import test from 'node:test';
import assert from 'node:assert/strict';
import {recordedDriverDescription,preferredVideo} from '../frontend/driver-profile.js';

test('recorded capabilities preserve historical Normal and identify actual RULE control',()=>{
  assert.match(recordedDriverDescription({mode:'NORMAL',setup:{protocol:'GUIDED_RULE_NORMAL_V2'}}),/Historical Normal.*protection off/);
  assert.match(recordedDriverDescription({mode:'NORMAL'}),/protection settings not recorded/);
  assert.match(recordedDriverDescription({mode:'BASELINE'}),/BehaviorAgent/);
  assert.match(recordedDriverDescription({mode:'HYBRID'}),/Experimental hybrid/);
  const profile={protocol:'SENSOR_REACTIVE_PREDICTIVE_V1',motion_prediction_used:false};
  assert.match(recordedDriverDescription({mode:'NORMAL',driver_profile:profile}),/reactive braking/);
  assert.match(recordedDriverDescription({driver_profile:{...profile,motion_prediction_used:true}}),/RULE.*RL not active/);
});

test('required annotated video never silently falls back to raw',()=>{
  assert.equal(preferredVideo({status:'READY'}),'driving.mp4');
  assert.equal(preferredVideo({status:'READY',annotation_required:true}),null);
  assert.equal(preferredVideo({status:'READY',annotation_required:true,variants:{annotated:{status:'READY',video:'../../secret'}}}),null);
  assert.equal(preferredVideo({status:'READY',annotation_required:true,variants:{annotated:{status:'READY',video:'driving-annotated.mp4'}}}),'driving-annotated.mp4');
});
