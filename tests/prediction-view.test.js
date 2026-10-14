import test from 'node:test';
import assert from 'node:assert/strict';
import {projectPrediction,predictionMatches,measuredPredictionFresh} from '../frontend/prediction-view.js';
const pose={position_m:[0,0,0],rotation_rad:{yaw:0,pitch:0,roll:0}};
const camera={width:800,height:450,fovDeg:90,timestamp:1,worldTransform:pose};
test('measured map freshness is independent from exact camera overlay matching',()=>{
  const p={session_id:'s',timestamp_s:1,coordinate_frame:'EGO_AT_EVALUATION',evaluation_frame:7};
  assert.ok(measuredPredictionFresh(p,'s',1.2));
  assert.ok(!predictionMatches(p,'s',{...camera,frame:8,timestamp:1.2}));
  assert.ok(!measuredPredictionFresh(p,'other',1.2));assert.ok(!measuredPredictionFresh(p,'s',2));
});
test('camera projections transform all five poses, including rear and top',()=>{
  assert.deepEqual(projectPrediction([10,0,0],pose,camera),[399.5,224.5]);
  assert.equal(projectPrediction([-10,0,0],pose,camera),null);
  for(const [position,rotation,target] of [
    [[1.5,0,1.6],{},[10,0,1.6]],[[0,0,2],{},[10,0,2]],
    [[-6,0,3],{},[10,0,3]],[[0,0,2],{yaw:Math.PI},[-10,0,2]],
    [[0,0,20],{pitch:-Math.PI/2},[0,0,0]]]) {
    const c={...camera,worldTransform:{position_m:position,rotation_rad:rotation}};
    const q=projectPrediction(target,pose,c);assert.ok(q);assert.ok(Math.abs(q[0]-399.5)<1e-6);assert.ok(Math.abs(q[1]-224.5)<1e-6);
  }
});
test('predictions clear on a session change, future/stale image or missing metadata',()=>{
  const p={session_id:'s',timestamp_s:1,coordinate_frame:'EGO_AT_EVALUATION'};
  assert.ok(predictionMatches(p,'s',camera));assert.ok(!predictionMatches(p,'new',camera));
  assert.ok(!predictionMatches(p,'s',{...camera,timestamp:2}));assert.ok(!predictionMatches(p,'s',null));
  assert.ok(!predictionMatches(p,'s',{...camera,timestamp:1.05}));
  assert.ok(!predictionMatches({...p,evaluation_frame:7},'s',{...camera,frame:8}));
  assert.ok(predictionMatches({...p,evaluation_frame:8},'s',{...camera,frame:8}));
});
