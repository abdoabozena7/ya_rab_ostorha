import test from 'node:test';
import assert from 'node:assert/strict';
import {driveState,mapTracks,trackKind} from '../frontend/drive-state.js';

test('unknown surface and unconfirmed label never become a vehicle marker',()=>{
  const tracks=[{id:'1',class:'UNKNOWN',confirmed:true},{id:'2',class:'car',confirmed:false},
    {id:'3',class:'person',confirmed:true,semantic_evidence:{}},{id:'4',class:'car',confirmed:true,semantic_evidence:{}}];
  assert.deepEqual(tracks.map(trackKind),['surface','surface','person','vehicle']);
  assert.deepEqual(mapTracks(tracks,'route',{vehicles:true,people:true,surfaces:true}),[]);
  assert.deepEqual(mapTracks(tracks,'both',{vehicles:true}).map(t=>t.id),['4']);
});
test('fault, ordinary pause, preparation, playback and emergency have a single next action',()=>{
  const p={fresh:true,controller:true,controlMode:'PAUSED',route:{},journey:{status:'PAUSED',reason:'operator_stop',route_id:'route'}};
  assert.equal(driveState({...p,journey:{status:'PAUSED',reason:'operator_stop'}}).action,'RESTART');
  assert.equal(driveState(p).action,'RESUME');
  assert.equal(driveState({...p,lastDriveStop:{status:'ERROR'}}).action,'RESTART');
  assert.equal(driveState({...p,journey:{...p.journey,presentation_id:'p'}}).action,'RESTART');
  assert.equal(driveState({...p,presentation:{status:'RECOVERING'}}).action,'STOP');
  assert.equal(driveState({...p,presentation:{status:'PLAYBACK'}}).action,'PLAYBACK');
  assert.equal(driveState({...p,presentationPlayback:true}).action,'PLAYBACK');
  assert.equal(driveState({...p,controlMode:'EMERGENCY_STOP',presentation:{status:'DRIVING'}}).action,'RELEASE');
  assert.equal(driveState({...p,controller:false}).enabled,false);
});
