import test from 'node:test';
import assert from 'node:assert/strict';
import {cockpitMeasurements,metricText,safetyNotice,safetyChip,driverCaption,perceptionCounts,detectionFrameMatches,containedImageRect,validDetectionBox,controlReasonText} from '../frontend/cockpit-state.js';

const provider=()=>({fresh:true,isReplay:false,sessionId:'a',controlMode:'AUTOMATIC',telemetry:{frame:20,timestamp:1},journey:{speed_kmh:30},safetySystem:{enabled:true,controller:'RULE',status:'MONITORING',active:false,timestamp_s:1,frame_id:20,measured_range_m:12,ttc_s:null}});
const result=()=>({session_id:'a',frame_id:20,timestamp_s:1,width:800,height:450,detections:[{class:'car'},{class:'person'},{class:'truck'}]});
const front=()=>({sensorId:'frontCamera',frame:20,timestamp:1,width:800,height:450,fovDeg:90,mountTransform:{position_m:[1.5,0,1.6],rotation_deg:{}}});

test('hybrid brake distinguishes processing delay from an uncertain maneuver corridor',()=>{
  const p=provider();p.journey.driving_mode='HYBRID';
  p.stopDiagnostics={braking:true,decision_source:'EXECUTION_SHIELD',reason:'CONTROL_PROCESSING_DEADLINE'};
  assert.equal(cockpitMeasurements(p,{speedKmh:0,brake:1}).brake,100);
  assert.match(safetyNotice(p).detail,/deadline/);
  p.stopDiagnostics.reason='NO_VERIFIED_SAFE_ACTION';
  assert.match(safetyNotice(p).detail,/verified maneuver/);
  assert.doesNotMatch(safetyNotice(p).detail,/deadline/);
  assert.equal(controlReasonText('Original exception text'),'Original exception text');
});

test('stationary rear blockage is factual and never claims a person or a moving crossing',()=>{
  const p=provider();p.stopDiagnostics={braking:true,decision_source:'NAVIGATION',reason:'NAVIGATION'};
  const conflict={source:'STATIONARY',point_m:[-3.9,-2.5]};
  p.maneuver={timestamp_s:1,scope:'LOW_SPEED_STATIONARY_OBSTACLE_BYPASS',phase:'WAIT',action:'HOLD',
    rejected:[{reason:'PREDICTED_INTERSECTION',evidence:{conflicts:[conflict]}}]};
  assert.equal(safetyNotice(p).title,'Waiting for clearance near the rear corner');
  assert.match(safetyNotice(p).detail,/type is unconfirmed/);
  assert.doesNotMatch(safetyNotice(p).detail,/pedestrian|crossing/);
  for(const update of [{source:'CONSTANT_VELOCITY'},{point_m:[3.9,-2.5]}]){
    Object.assign(conflict,{source:'STATIONARY',point_m:[-3.9,-2.5]},update);
    assert.notEqual(safetyNotice(p).title,'Waiting for clearance near the rear corner');
  }
  p.stopDiagnostics.reason='STALE_CONTROL_SCENE';
  assert.equal(safetyNotice(p).title,'Waiting for a fresh control frame');
});

test('presentation timeouts explain the retained incomplete attempt and recovery',()=>{
  const detail=controlReasonText('presentation_phase_timeout: DRIVING');
  assert.match(detail,/time limit/);assert.match(detail,/unfinished/);assert.match(detail,/Restart/);
  assert.doesNotMatch(detail,/presentation_phase_timeout/);
});

test('the original synchronized-scene failure takes precedence over generic presentation cleanup',()=>{
  const p=provider();p.controlMode='PAUSED';p.route={id:'route'};
  p.journey={status:'ERROR',reason:'presentation_failed'};
  p.lastDriveStop={status:'ERROR',detail:'presentation_failed'};
  p.stopDiagnostics={runtime_fault:{exception_type:'ControlSceneTimeout'}};
  const notice=safetyNotice(p);
  assert.equal(notice.title,'Driving stopped: control sensors fell behind');
  assert.match(notice.detail,/one second/);assert.match(notice.detail,/Restart/);
  assert.doesNotMatch(notice.detail,/presentation_failed/);
});

test('held journey retains its original failure after focus loss and offers explicit resume',()=>{
  const p=provider();p.controlMode='PAUSED';p.route={id:'route'};
  p.journey={status:'PAUSED',reason:'focus_lost'};
  p.lastDriveStop={status:'ERROR',detail:'Safety processing exceeded sensor wall freshness limit'};
  const notice=safetyNotice(p);
  assert.equal(notice.title,'Drive needs attention');
  assert.match(notice.detail,/processing exceeded/);
  assert.match(notice.detail,/Restart/);
  p.controlMode='AUTOMATIC';p.safetySystem.status='SENSOR_DELAY_HOLD';p.safetySystem.active=true;p.safetySystem.reason='Waiting for next fresh frame';
  assert.equal(driverCaption(p),'Waiting for sensors');
  assert.equal(safetyNotice(p).title,'Waiting for a fresh sensor frame');
});
test('arrival is distinct from a failed or interrupted held drive',()=>{
  const p=provider();p.controlMode='PAUSED';p.route={arrived:true};p.journey={status:'ARRIVED'};
  assert.equal(driverCaption(p),'Arrived');assert.equal(safetyNotice(p).title,'Destination reached');
  p.lastDriveStop={status:'ERROR',detail:'Sensor input invalid'};p.journey.status='ERROR';
  assert.equal(driverCaption(p),'Vehicle held');assert.match(safetyNotice(p).detail,/Sensor input invalid/);
});
test('a red signal keeps the journey active and explains the navigation brake',()=>{
  const p=provider();p.stopDiagnostics={braking:true,decision_source:'NAVIGATION',reason:'Red traffic light on the planned route'};
  assert.equal(safetyNotice(p).title,'Waiting at a red light');
  assert.equal(driverCaption(p),'Self Driving');
});

test('ordinary bypass explains preparation, returning and an actual execution veto',()=>{
  const p=provider();p.maneuver={timestamp_s:1,scope:'LOW_SPEED_STATIONARY_OBSTACLE_BYPASS',phase:'EXIT',action:'EXIT'};
  assert.equal(safetyNotice(p).title,'Passing the stopped obstacle');
  p.maneuver.phase='RETURN';assert.equal(safetyNotice(p).title,'Returning to the original lane');
  p.stopDiagnostics={braking:true,decision_source:'EXECUTION_SHIELD',reason:'SWEPT_SPACE_UNKNOWN_OR_OCCUPIED'};
  assert.equal(safetyNotice(p).title,'Passing paused for clearance');
  assert.match(safetyNotice(p).detail,/unmeasured or occupied/);
  p.maneuver.timestamp_s=.5;assert.equal(safetyNotice(p),null);
});

test('a known occupied passing lane explains a stationary wait without claiming a pass',()=>{
  const p=provider();p.maneuver={timestamp_s:1,scope:'LOW_SPEED_STATIONARY_OBSTACLE_BYPASS',phase:'FOLLOW',action:'FOLLOW',
    target_speed_kmh:0,rejected:[{action:'CHANGE_LEFT',reason:'ADJACENT_ROUTE_BLOCKED'}]};
  assert.equal(safetyNotice(p).title,'Waiting: passing lane blocked');
  assert.match(safetyNotice(p).detail,/stationary obstacle/);
  assert.doesNotMatch(safetyNotice(p).detail,/pedestrian/);
});

test('an expired navigation control frame cannot be described as an active pass',()=>{
  const p=provider();p.maneuver={timestamp_s:1,scope:'LOW_SPEED_STATIONARY_OBSTACLE_BYPASS',phase:'FOLLOW',action:'FOLLOW'};
  p.stopDiagnostics={braking:true,decision_source:'NAVIGATION',reason:'CONTROL_PROCESSING_DEADLINE'};
  assert.equal(safetyNotice(p).title,'Waiting for a fresh control frame');
  assert.match(safetyNotice(p).detail,/deadline/);
});

test('surface movement and physical obstacles do not claim pedestrian recognition',()=>{
  const p=provider();Object.assign(p.safetySystem,{active:true,status:'BRAKING',risk:'PATH_CONFLICT',path_conflict:{source:'LIDAR_SURFACE_TRACK'}});
  assert.equal(safetyNotice(p).title,'Moving object approaching the route');
  assert.match(safetyNotice(p).detail,/Object type is unconfirmed/);
  assert.doesNotMatch(safetyNotice(p).detail,/person|pedestrian/i);
  p.safetySystem.risk='FORWARD_COLLISION_RISK';p.safetySystem.path_conflict=null;
  assert.equal(safetyNotice(p).title,'Obstacle on the driving path');
  assert.doesNotMatch(safetyNotice(p).detail,/sideways|person|pedestrian/i);
  p.safetySystem.measured_range_m=null;p.safetySystem.reason='Holding a prior protective brake';
  assert.equal(safetyNotice(p).detail,'Holding a prior protective brake');
  p.safetySystem.active=false;assert.equal(safetyNotice(p),null);
});

test('live applied brake, valid zero and missing TTC remain distinct',()=>{
  const p=provider(),m=cockpitMeasurements(p,{speedKmh:0,brake:1});
  assert.deepEqual([m.speed,m.brake,m.target,m.gap,m.ttc],[0,100,30,12,null]);
  assert.equal(metricText(0),'0');assert.equal(metricText(null),'—');assert.equal(metricText(NaN),'—');assert.equal(metricText(Infinity),'—');assert.equal(metricText(-1),'—');
});
test('stale, future and faulty observations cannot appear as current gap or TTC',()=>{
  for(const update of [{timestamp_s:0},{timestamp_s:2},{status:'SENSOR_FAULT'},{timestamp_s:undefined},{session_id:'other'}]){
    const p=provider();Object.assign(p.safetySystem,update);
    assert.equal(cockpitMeasurements(p,{speedKmh:5,brake:0}).gap,null);
  }
  const p=provider();p.maneuver={timestamp_s:1,front_gap_m:0,front_ttc_s:0};
  assert.deepEqual([cockpitMeasurements(p,{}).gap,cockpitMeasurements(p,{}).ttc],[0,0]);
});
test('disconnection clears stale numeric measurements and never promises protection',()=>{
  const p={...provider(),fresh:false};
  const m=cockpitMeasurements(p,{speedKmh:18,brake:1});
  assert.deepEqual([m.speed,m.brake,m.target,m.gap,m.ttc],[null,null,null,null,null]);
  assert.equal(safetyChip(p).label,'Protection offline');assert.equal(safetyNotice(p),null);
});
test('emergency, holding, releasing and unavailable safety have factual distinct notices',()=>{
  const p=provider();assert.equal(safetyNotice(p),null);
  p.safetySystem.active=true;p.safetySystem.reason='Measured front obstacle';
  assert.equal(safetyNotice(p).detail,'Measured front obstacle');assert.equal(safetyChip(p).label,'Safety override');
  p.safetySystem.teacher_state='HOLDING';assert.equal(safetyNotice(p).title,'Protective stop active');
  p.safetySystem.status='RELEASING';assert.equal(safetyNotice(p).title,'Safety brake releasing');
  p.controlMode='EMERGENCY_STOP';assert.equal(safetyNotice(p).tone,'danger');assert.equal(safetyChip(p).label,'Emergency stopped');
  p.controlMode='PAUSED';p.safetySystem.status='SENSOR_FAULT';assert.equal(safetyNotice(p).title,'Safety sensors unavailable');
});

test('an acknowledged emergency does not keep claiming that movement is locked',()=>{
  const p=provider();p.controlMode='PAUSED';p.journey={status:'PAUSED',reason:'emergency_stop_released'};
  p.lastDriveStop={status:'PAUSED',detail:'emergency_stop'};
  assert.equal(safetyNotice(p).title,'Emergency stop released');
  assert.match(safetyNotice(p).detail,/remains held/);
  assert.doesNotMatch(safetyNotice(p).detail,/Movement locked/);
});
test('experimental protection remains factual without exposing controller names',()=>{
  const p=provider();p.safetySystem.status='STANDARD_DRIVER';p.safetySystem.actual_generator='SENSOR_BASELINE';
  assert.equal(safetyChip(p).label,'Normal · protection off');
  p.safetySystem.status='MONITORING';p.safetySystem.controller='MODEL';assert.equal(safetyChip(p).label,'Experimental protection');
  p.safetySystem.enabled=false;assert.equal(safetyChip(p).label,'Protection off');
});

test('recovery caption needs current maneuver data and never overrides a held or emergency vehicle',()=>{
  const p=provider();p.maneuver={timestamp_s:1,session_id:'a',action:'BACK_UP',phase:'REVERSING'};
  assert.equal(driverCaption(p),'Repositioning · Reverse');
  p.maneuver.timestamp_s=.8;assert.equal(driverCaption(p),'Self Driving');
  p.maneuver.timestamp_s=1;p.controlMode='PAUSED';assert.equal(driverCaption(p),'Vehicle held');
  p.controlMode='EMERGENCY_STOP';assert.equal(driverCaption(p),'Emergency stop');
});
test('camera counts use current inference, never population or unrelated measured tracks',()=>{
  const p=provider();p.population={actual:{vehicles:99,pedestrians:88}};
  assert.deepEqual(perceptionCounts(result(),p),{vehicles:2,people:1,label:'Front camera · 2D detections · 0.0 s old'});
  assert.equal(perceptionCounts({...result(),detections:[]},p).vehicles,0);
  for(const update of [{timestamp_s:0},{timestamp_s:2},{session_id:'b'},{frame_id:21}])assert.equal(perceptionCounts({...result(),...update},p).vehicles,null);
});
test('2D overlay requires exact displayed frame, timestamp and sensor viewpoint',()=>{
  const p=provider(),r=result(),f=front();assert.equal(detectionFrameMatches(r,p,f,f),true);
  for(const update of [{frame:21},{timestamp:1.05},{sensorId:'drivingCamera',mountTransform:{position_m:[-6,0,3],rotation_deg:{pitch:-15}}}])assert.equal(detectionFrameMatches(r,p,{...f,...update},f),false);
  assert.equal(detectionFrameMatches({...r,session_id:'b'},p,f,f),false);
  assert.equal(detectionFrameMatches(r,{...p,fresh:false},f,f),false);
});
test('identical calibrated front view may resize, but differing FOV or ratio is rejected',()=>{
  const p=provider(),f=front(),d={...f,sensorId:'drivingCamera',width:1600,height:900};
  assert.equal(detectionFrameMatches(result(),p,d,f),true);
  assert.equal(detectionFrameMatches(result(),p,{...d,fovDeg:100},f),false);
  assert.equal(detectionFrameMatches(result(),p,{...d,height:1000},f),false);
  assert.equal(detectionFrameMatches(result(),p,{...d,mountTransform:null},f),false);
});
test('contain coordinates account for both horizontal and vertical letterboxing',()=>{
  assert.deepEqual(containedImageRect({width:1000,height:450},800,450),{left:100,top:0,width:800,height:450});
  assert.deepEqual(containedImageRect({width:800,height:650},800,450),{left:0,top:100,width:800,height:450});
  assert.equal(containedImageRect({width:0,height:100},800,450),null);
});
test('invalid or out-of-frame boxes cannot draw arbitrary screen geometry',()=>{
  assert.deepEqual(validDetectionBox({xyxy:[-5,1,810,460]},800,450),[0,1,800,450]);
  for(const b of [[10,10,1,1],[1,1,NaN,20],[900,1,950,20],[1,2,3]])assert.equal(validDetectionBox({xyxy:b},800,450),null);
});
test('replay displays recorded actuation with recorded provenance and no live inference',()=>{
  const p={...provider(),isReplay:true};assert.equal(cockpitMeasurements(p,{speedKmh:4,brake:.5}).speed,4);
  assert.equal(safetyChip(p).label,'Recorded safety');assert.equal(safetyNotice(p),null);assert.equal(perceptionCounts(result(),p).vehicles,null);
});
