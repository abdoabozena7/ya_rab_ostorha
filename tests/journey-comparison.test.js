import {test} from 'node:test';
import assert from 'node:assert/strict';
import {comparisonSummary,metricValue,measuredDifference} from '../frontend/journey-comparison.js';
import {worldToEgo,perspectivePoint,mapPrediction,mapForecastStatus,mapCanvasPoint} from '../frontend/unified-map.js';
import {modeBlockedReason,simulatorNeedsStart} from '../frontend/guided-drive.js';

const run=(overrides={})=>({status:'ARRIVED',samples:20,collisions:0,observed_samples:20,sensor_coverage_percent:100,high_risk_s:0,...overrides});
test('comparison retains neither, left, right, both and incomplete states',()=>{
  for(const runs of [{},{ROBOSPHERE:run()},{NORMAL:run()}])assert.equal(comparisonSummary({runs}).arrived,false);
  assert.equal(comparisonSummary({runs:{ROBOSPHERE:run(),NORMAL:run()},conditions_match:true}).arrived,true);
  assert.match(comparisonSummary({runs:{ROBOSPHERE:run(),NORMAL:run({status:'ERROR'})}}).detail,/ended early/);
  assert.match(comparisonSummary({runs:{ROBOSPHERE:run(),NORMAL:run()}}).detail,/unverified/);
});
test('unavailable measurements remain distinct from measured zero and arrival',()=>{
  assert.equal(metricValue(null,'collisions'),'—');assert.equal(metricValue(run(),'collisions'),'0');
  assert.equal(metricValue(run({samples:0}),'collisions'),'—');
  assert.equal(metricValue(run({collisions:null}),'collisions'),'—');
  assert.equal(metricValue(run({setup:{collision_measurement_available:false}}),'collisions'),'—');
  assert.equal(metricValue(run({observed_samples:0}),'high_risk_s'),'—');
  assert.equal(metricValue(run({acceleration_samples:0}),'harsh_braking_events'),'—');
  assert.equal(metricValue(run(),'destination_reached'),'Yes');
  assert.equal(metricValue(run({status:'INTERRUPTED',destination_reached:false}),'destination_reached'),'No');
});
test('differences require complete matching arms and valid observation coverage',()=>{
  const d={conditions_match:true,runs:{ROBOSPHERE:run(),NORMAL:run({collisions:2,high_risk_s:3})}};
  assert.equal(measuredDifference(d,'collisions'),-2);assert.equal(measuredDifference(d,'high_risk_s'),-3);
  assert.equal(measuredDifference({...d,conditions_match:false},'collisions'),null);
  for(const overrides of [{status:'INTERRUPTED'},{collisions:null},{samples:0}])assert.equal(measuredDifference({...d,runs:{...d.runs,NORMAL:run(overrides)}},'collisions'),null);
  for(const coverage of [undefined,null,60])assert.equal(measuredDifference({...d,runs:{...d.runs,NORMAL:run({sensor_coverage_percent:coverage})}},'high_risk_s'),null);
});
test('world and forecast poses share CARLA axes through turns',()=>{
  assert.deepEqual(worldToEgo([15,23],[10,20],0),[5,3]);
  const turned=worldToEgo([10,30],[10,20],Math.PI/2);assert.ok(Math.abs(turned[0]-10)<1e-9);assert.ok(Math.abs(turned[1])<1e-9);
});
test('perspective map keeps native route turns and actors aligned with the car',()=>{
  const origin=[0,0,0],yaw=0;
  assert.deepEqual(perspectivePoint(origin,origin,yaw),[240,262]);
  assert.ok(perspectivePoint([30,0,0],origin,yaw)[1]<262);
  assert.ok(perspectivePoint([30,8,0],origin,yaw)[0]>240);
  assert.equal(perspectivePoint(origin,origin,yaw,1,true,800)[0],400);
});
test('actor selection compensates for letterboxing in expanded maps',()=>{
  assert.deepEqual(mapCanvasPoint(250,200,{left:10,top:20,width:480,height:360}),[240,180]);
  assert.deepEqual(mapCanvasPoint(250,320,{left:10,top:20,width:480,height:600}),[240,180]);
  assert.deepEqual(mapCanvasPoint(370,200,{left:10,top:20,width:720,height:360}),[240,180]);
});
test('map rejects old/future/foreign forecasts and identifies empty measured scenes',()=>{
  const p={fresh:true,sessionId:'s',telemetry:{timestamp:3}},prediction={session_id:'s',timestamp_s:2.8,render_reference:{position_m:[0,0,0]},coordinate_frame:'EGO_AT_EVALUATION',display_source:'CV fallback',tracks:[]};
  assert.equal(mapPrediction(prediction,p),prediction);assert.match(mapForecastStatus(prediction,p),/CV fallback.*No tracked actors/);
  for(const change of [{timestamp_s:2},{timestamp_s:4},{session_id:'other'},{coordinate_frame:'CAMERA'}])assert.equal(mapPrediction({...prediction,...change},p),null);
  assert.match(mapForecastStatus(prediction,{...p,fresh:false}),/disconnected/);assert.match(mapForecastStatus(null,p),/unavailable/);
});
test('mode admission explains readiness and respects research, recording and emergency locks',()=>{
  const p={connected:true,fresh:true,controller:true,controlMode:'PAUSED',route:{destination:{}},navigationAvailable:true},v={speedMps:0};
  assert.equal(modeBlockedReason(p,v,true),'');
  for(const change of [{fresh:false},{controller:false},{recording:true},{controlMode:'EMERGENCY_STOP'},{navigationAvailable:false},{environment:{mode:'TRAINING'}},{comparisonV2:{phase:'RUNNING'}},{safetySystem:{status:'SENSOR_FAULT'}}])assert.ok(modeBlockedReason({...p,...change},v,true));
  assert.ok(modeBlockedReason(p,{speedMps:null},true));assert.ok(modeBlockedReason(p,v,false));
  assert.equal(simulatorNeedsStart({simulatorStop:{status:'STOPPED'}}),true);assert.equal(simulatorNeedsStart({connected:true}),false);
  assert.equal(simulatorNeedsStart({connected:false,simulatorStart:{available:true},simulatorStop:{status:'IDLE'}}),false);
});
