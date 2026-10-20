import test from 'node:test';
import assert from 'node:assert/strict';
import {boxCorners,drawSceneOverlays} from '../frontend/scene-overlays.js';
const pose={position_m:[0,0,0],rotation_rad:{yaw:0,pitch:0,roll:0}};
const camera={width:800,height:450,fovDeg:90,timestamp:1,worldTransform:pose};
test('sensor boxes have eight rotated metric corners and preserve measured motion',()=>{
  const box={center_m:[10,2,1],half_size_m:[2,1,1],yaw_rad:Math.PI/2,velocity_mps:[2,0]};
  const points=boxCorners(box,.1);assert.equal(points.length,8);
  assert.ok(Math.abs(points[0][0]-11.2)<1e-6);assert.ok(Math.abs(points[0][1])<1e-6);
  assert.deepEqual(boxCorners({...box,half_size_m:[1,1,0]}),[]);
});
test('all supported objects get 3D boxes while only supplied conflict hypotheses get arrows',()=>{
  let strokes=0;const ctx={stroke:()=>strokes++,setLineDash(){},beginPath(){},moveTo(){},lineTo(){}};
  const boxes=Array.from({length:9},(_,i)=>({center_m:[10+i,2,1],half_size_m:[.4,.3,.8],
    source:'CURRENT_SENSOR_GEOMETRY',measurement_frame:20,class:'person'}));
  const prediction={timestamp_s:1,evaluation_frame:20,render_reference:pose,boxes_3d:boxes,
    trajectories:[{class:'person',points:[[0,12,3],[1,12,0],[2,12,-3]]}]};
  assert.deepEqual(drawSceneOverlays(ctx,prediction,camera),{boxes:9,arrows:1});assert.equal(strokes,11);
  assert.deepEqual(drawSceneOverlays(ctx,prediction,{...camera,timestamp:1.2}),{boxes:0,arrows:1});
  assert.deepEqual(drawSceneOverlays(ctx,prediction,{...camera,timestamp:2}),{boxes:0,arrows:0});
  prediction.boxes_3d=boxes.map(b=>({...b,source:'SIMULATOR_GROUND_TRUTH'}));
  assert.equal(drawSceneOverlays(ctx,prediction,camera).boxes,0);
});
