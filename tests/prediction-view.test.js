import test from 'node:test';
import assert from 'node:assert/strict';
import {PredictionView,projectPrediction,predictionMatches,measuredPredictionFresh,forecastCanProject,remainingForecast,visibleModes} from '../frontend/prediction-view.js';
const pose={position_m:[0,0,0],rotation_rad:{yaw:0,pitch:0,roll:0}};
const camera={width:800,height:450,fovDeg:90,timestamp:1,worldTransform:pose};

test('main camera uses the shared risk, draws at most two paths and expires a selected maneuver',()=>{
  let strokes=0;
  const ctx={clearRect:()=>{strokes=0;},setLineDash(){},beginPath(){},moveTo(){},lineTo(){},stroke:()=>strokes++};
  const bounds={left:0,top:0,width:800,height:450};
  const img={hidden:false,getBoundingClientRect:()=>bounds,parentElement:{getBoundingClientRect:()=>bounds}};
  const prior=globalThis.document;
  globalThis.document={body:{classList:{contains:()=>true}},querySelector:()=>null,getElementById:()=>img};
  try{
    const mode={track_id:'person',source:'PEDESTRIAN_POSSIBLE_START',points:[[0,20,3],[1,20,0],[2,20,-3]]};
    const prediction={session_id:'s',timestamp_s:1,evaluation_frame:7,coordinate_frame:'EGO_AT_EVALUATION',render_reference:pose,
      tracks:[{id:'person',confirmed:true,class:'person',semantic_evidence:{}}],trajectories:Array(40).fill(mode),
      selected_path:[[0,0,0,0],[1,10,0,0]],selected_path_reference:pose,selected_path_timestamp_s:1};
    const provider={journey:{status:'RUNNING',driving_mode:'ROBOSPHERE'},sessionId:'s',fresh:true,telemetry:{timestamp:1},drivingForecast:prediction};
    const view=Object.assign(Object.create(PredictionView.prototype),{provider,canvas:{style:{},getContext:()=>ctx},map:{},label:{dataset:{}},diagnostic:{},drawMap(){},
      poll(){throw Error('Main view must not request a second forecast');},pollFrame(){throw Error('Main view must not request a second forecast');}});
    view.draw({...camera,frame:7});assert.equal(strokes,2);assert.equal(prediction.trajectories.length,40);
    prediction.selected_path_timestamp_s=.8;view.draw({...camera,frame:7});assert.equal(strokes,1);
    provider.journey.driving_mode='NORMAL';view.draw({...camera,frame:7});assert.equal(view.canvas.hidden,true);
  }finally{if(prior===undefined)delete globalThis.document;else globalThis.document=prior;}
});

test('classified person forecasts remain visible ahead of abundant background surfaces',()=>{
  const tracks=Array.from({length:25},(_,i)=>({id:String(i),confirmed:true,position_m:[i+1,0],class:'UNKNOWN'}));
  tracks.push({id:'person',confirmed:true,position_m:[20,3],class:'person',semantic_evidence:{}});
  const trajectories=tracks.map(t=>({track_id:t.id,points:[]}));
  assert.equal(visibleModes({tracks,trajectories}).slice(0,18)[0].track_id,'person');
  assert.equal(trajectories[0].track_id,'0');
});

test('recent forecasts reproject into a later camera without inventing exact frame alignment',()=>{
  const p={session_id:'s',timestamp_s:1,coordinate_frame:'EGO_AT_EVALUATION',evaluation_frame:7,render_reference:pose};
  assert.ok(forecastCanProject(p,'s',{...camera,frame:8,timestamp:1.2}));
  assert.ok(!forecastCanProject(p,'other',{...camera,frame:8,timestamp:1.2}));
  for(const c of [{...camera,frame:6},{...camera,frame:8,timestamp:.9},{...camera,frame:8,timestamp:2}])assert.ok(!forecastCanProject(p,'s',c));
  assert.ok(!forecastCanProject({...p,render_reference:null},'s',{...camera,frame:8}));
  assert.deepEqual(remainingForecast([[0,10,3],[1,10,1],[2,10,-1]],.5),[[.5,10,2],[1,10,1],[2,10,-1]]);
  assert.deepEqual(remainingForecast([[0,0,0],[1,1,1]],2),[]);
});
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
