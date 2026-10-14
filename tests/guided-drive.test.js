import {test} from 'node:test';
import assert from 'node:assert/strict';
import {guidedStep} from '../frontend/guided-drive.js';
const state=()=>({connected:true,fresh:true,controller:true,controlMode:'PAUSED',route:null});
test('starting state stays visible during backend handoff',()=>{
  assert.equal(guidedStep({...state(),connected:false,simulationStarting:true},{speedMps:0}),'starting');
});
test('guided sequence selects destination before crowding that road and driving',()=>{
  const p=state(),v={speedMps:0};
  assert.equal(guidedStep(p,v),'destination');
  p.route={destination:{name:'Native destination'}};assert.equal(guidedStep(p,v),'traffic');
  assert.equal(guidedStep(p,v,false,true),'behaviour');
  assert.equal(guidedStep(p,v,true,true),'behaviour');
  p.trafficPreparation={status:'APPLYING'};assert.equal(guidedStep(p,v),'pending');
  p.trafficPreparation={status:'READY'};assert.equal(guidedStep(p,v,true),'drive');
  p.route.arrived=true;assert.equal(guidedStep(p,v,true),'destination');p.route.arrived=false;
  p.dashboardResult={action:'destination',status:'REJECTED'};assert.equal(guidedStep(p,v,true),'destination');
});
test('ownership, disconnection and emergency take priority over driving',()=>{
  const p=state(),v={speedMps:0};p.route={destination:{}};
  p.controller=false;assert.equal(guidedStep(p,v,true),'ownership');
  p.fresh=false;assert.equal(guidedStep(p,v,true),'connect');
  p.fresh=p.controller=true;p.controlMode='EMERGENCY_STOP';assert.equal(guidedStep(p,v,true),'acknowledge');
  p.controlMode='AUTOMATIC';assert.equal(guidedStep(p,v,true),'stop');
});
test('failed population and moving vehicle cannot advance to start',()=>{
  const p=state();p.route={destination:{}};p.trafficPreparation={status:'FAILED'};
  assert.equal(guidedStep(p,{speedMps:0},true),'traffic');
  assert.equal(guidedStep(p,{speedMps:0},false,true),'behaviour');
  assert.equal(guidedStep(p,{speedMps:1},true),'stop');
});
