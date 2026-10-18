import test from 'node:test';
import assert from 'node:assert/strict';
import {driveState,mapTracks,trackKind} from '../frontend/drive-state.js';

test('a fresh session says Start whether CARLA is stopped or already connected',()=>{
  const fresh={fresh:true,controller:true,controlMode:'PAUSED',presentation:{status:'IDLE',id:null},
    journey:{status:'IDLE'},route:null};
  for(const connected of [false,true]){
    const state=driveState({...fresh,connected});
    assert.equal(state.startLabel,'Start');
    assert.equal(state.action,'RESTART');
    assert.equal(state.enabled,true);
  }
  assert.equal(driveState({...fresh,journey:{status:'PAUSED',reason:'fresh_native_session'}}).startLabel,'Start');
  assert.equal(driveState({...fresh,route:{id:'selected-but-not-started'}}).startLabel,'Start');
});

test('Restart reflects an attempted run rather than a page reload or connection',()=>{
  for(const status of ['COMPLETE','CANCELLED','ERROR']){
    assert.equal(driveState({presentation:{id:'retained-run',status}}).startLabel,'Restart');
  }
  for(const journey of [{status:'ERROR'},{status:'ARRIVED'},{status:'PAUSED',route_id:'attempted-route'},
      {status:'PAUSED',presentation_id:'attempted-presentation'}]){
    assert.equal(driveState({journey}).startLabel,'Restart');
  }
  assert.equal(driveState({lastDriveStop:{status:'ERROR'}}).startLabel,'Restart');
  assert.equal(driveState({isReplay:true}).enabled,false);
  assert.equal(driveState({controlMode:'TRAINING'}).enabled,false);
});

test('unknown surface and unconfirmed label never become a vehicle marker',()=>{
  const tracks=[{id:'1',class:'UNKNOWN',confirmed:true},{id:'2',class:'car',confirmed:false},
    {id:'3',class:'person',confirmed:true,semantic_evidence:{}},{id:'4',class:'car',confirmed:true,semantic_evidence:{}}];
  assert.deepEqual(tracks.map(trackKind),['surface','surface','person','vehicle']);
  assert.deepEqual(mapTracks(tracks,'route',{vehicles:true,people:true,surfaces:true}),[]);
  assert.deepEqual(mapTracks(tracks,'both',{vehicles:true}).map(t=>t.id),['4']);
});
test('fault, ordinary pause, preparation, playback and emergency have a single next action',()=>{
  const p={fresh:true,controller:true,controlMode:'PAUSED',route:{id:'route'},journey:{status:'PAUSED',reason:'operator_stop',route_id:'route'}};
  assert.equal(driveState({...p,journey:{status:'PAUSED',reason:'operator_stop'}}).action,'RESTART');
  assert.equal(driveState(p).action,'RESUME');
  assert.equal(driveState({...p,lastDriveStop:{status:'ERROR'}}).action,'RESTART');
  assert.equal(driveState({...p,journey:{...p.journey,presentation_id:'p'}}).action,'RESTART');
  assert.equal(driveState({...p,presentation:{status:'RECOVERING'}}).action,'STOP');
  assert.equal(driveState({...p,presentation:{status:'PLAYBACK'}}).action,'PLAYBACK');
  assert.equal(driveState({...p,presentationPlayback:true}).action,'PLAYBACK');
  assert.equal(driveState({...p,controlMode:'EMERGENCY_STOP',presentation:{status:'DRIVING'}}).action,'RELEASE');
  assert.equal(driveState({...p,controller:false}).enabled,false);
  assert.equal(driveState({...p,route:{id:'another-route'}}).action,'RESTART');
  assert.equal(driveState({...p,presentation:{status:'ERROR',id:'previous-presentation'}}).action,'RESUME');
});
