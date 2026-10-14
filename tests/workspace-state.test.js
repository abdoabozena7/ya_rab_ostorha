import test from 'node:test';
import assert from 'node:assert/strict';
import {driveState,selectedComparison,collisionOutcome,detectionFreshness} from '../frontend/workspace-state.js';
const ready = {fresh:true,controller:true,controlMode:'PAUSED',safetySystem:{enabled:true,status:'STANDBY',risk:'UNKNOWN',intervention_count:0}};

test('unknown risk and unavailable intervention counts never imply a safe live drive',()=>{
  assert.equal(driveState(ready,{speedKmh:0}).risk,'Not assessed');
  const disconnected=driveState({...ready,fresh:false},{speedKmh:null});
  assert.equal(disconnected.interventions,null); assert.equal(disconnected.action,'startSimulationBtn');
  assert.equal(disconnected.actionLabel,'Start the simulation');
  assert.equal(driveState({...ready,fresh:false,connecting:true},{speedKmh:null}).action,'startSimulationBtn');
  assert.equal(driveState({...ready,simulationStarting:true},{speedKmh:null}).action,null);
});
test('emergency acknowledgement takes priority over active intervention and completed results',()=>{
  const view=driveState({...ready,controlMode:'EMERGENCY_STOP',safetySystem:{...ready.safetySystem,active:true},comparisonDemo:{phase:'FINISHED'}},{speedKmh:0});
  assert.equal(view.label,'Emergency stopped'); assert.equal(view.action,'acknowledgeStopBtn'); assert.equal(view.tone,'danger');
});
test('read-only, replay and starting states cannot offer an active driving command',()=>{
  assert.equal(driveState({...ready,controller:false},{speedKmh:0}).action,'ownershipBtn');
  assert.equal(driveState({...ready,isReplay:true},{speedKmh:0}).action,'replayPauseBtn');
  assert.equal(driveState({...ready,comparisonDemo:{phase:'RESETTING'}},{speedKmh:0}).action,null);
});
test('a completed collision and a sensor fault cannot use a success state',()=>{
  const ended=driveState({...ready,comparisonDemo:{phase:'FINISHED',latest_outcome:'COLLISION'}},{speedKmh:0});
  assert.equal(ended.tone,'danger'); assert.equal(ended.label,'Drive ended · collision'); assert.equal(ended.action,'resultsTab');
  const fault=driveState({...ready,safetySystem:{...ready.safetySystem,status:'SENSOR_FAULT_STOP'}},{speedKmh:0});
  assert.equal(fault.tone,'danger'); assert.equal(fault.action,'sensorBtn');
});
test('autonomous driving, safety intervention and arrival have distinct states and actions',()=>{
  assert.equal(driveState({...ready,controlMode:'AUTOMATIC'},{speedKmh:12}).mode,'Autonomous');
  const active=driveState({...ready,controlMode:'AUTOMATIC',safetySystem:{...ready.safetySystem,active:true,risk:'HIGH'}},{speedKmh:12});
  assert.equal(active.label,'Safety intervention'); assert.equal(active.action,'pauseBtn');
  assert.equal(driveState({...ready,journey:{status:'ARRIVED'}},{speedKmh:0}).action,'resultsTab');
  assert.equal(driveState({...ready,controlMode:'MANUAL'},{speedKmh:0},false).mode,'Vehicle held');
});
test('current results and archived comparison are separate scopes, including partial comparisons',()=>{
  const archive={results:{WITHOUT:{},WITH:{}}};
  assert.equal(selectedComparison({results:{},archived_comparison:archive}).archived,true);
  const current={results:{WITHOUT:{}},archived_comparison:archive};
  assert.equal(selectedComparison(current).comparison,current); assert.equal(selectedComparison(current).archived,false);
});
test('missing or interrupted collision observations are never reported as a completed safe run',()=>{
  assert.equal(collisionOutcome({}).label,'Collision data unavailable');
  assert.equal(collisionOutcome({collision:false,completed:false}).tone,'warning');
  assert.equal(collisionOutcome({collision:false,completed:true}).label,'No collision recorded');
  assert.equal(collisionOutcome({collision:false,outcome:{metrics:{collision_count:1}}}).tone,'danger');
});
test('detection age uses simulation time, flags half-second delays and rejects future frames',()=>{
  const current={frame:100,timestamp:5};
  assert.equal(detectionFreshness({frame_id:90,timestamp_s:4.5},current,.05).tone,'warning');
  assert.equal(detectionFreshness({frame_id:99,timestamp_s:4.95},current,.05).tone,'neutral');
  assert.equal(detectionFreshness({frame_id:101,timestamp_s:5.05},current,.05).label,'Frame alignment unavailable');
  assert.equal(detectionFreshness({frame_id:90},{frame:100},.05).seconds,.5);
  assert.equal(detectionFreshness({frame_id:90},{frame:100}).seconds,null);
});
