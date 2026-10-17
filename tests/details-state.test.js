import test from 'node:test';
import assert from 'node:assert/strict';
import {DetailsNavigation,configurationReason,availableRecordings,recordedConditionsMatch} from '../frontend/details-state.js';
import {driveState} from '../frontend/drive-state.js';

test('Details Back preserves the navigation branch; Close resets to four-group root',()=>{
  const nav=new DetailsNavigation();nav.open('view');nav.open('diagnostics');
  assert.equal(nav.back(),'view');assert.equal(nav.back(),'root');
  nav.open('system');nav.open('settings');nav.reset();assert.equal(nav.page,'root');
});
test('every active phase locks configuration and always exposes one next action',()=>{
  const p={connected:true,fresh:true,controller:true,controlMode:'PAUSED'};
  for(const status of ['STOPPING','PREPARING','READY','STARTING','DRIVING','FINALIZING','RESTORING','RECOVERING','EXPORTING']){
    const live={...p,presentation:{status}};
    assert.equal(driveState(live).action,'STOP',status);assert.equal(driveState(live).configurationLocked,true);
    assert.match(configurationReason(live),/Stop it/);
  }
  assert.equal(driveState({...p,presentation:{status:'PLAYBACK'}}).action,'PLAYBACK');
  assert.equal(driveState({...p,controlMode:'EMERGENCY_STOP'}).action,'RELEASE');
  assert.equal(driveState({...p,controlMode:'EMERGENCY_STOP'}).emergencyVisible,false);
  assert.equal(driveState(p).emergencyVisible,true);
  assert.equal(driveState({...p,connected:false}).emergencyVisible,false);
  assert.equal(driveState({...p,connected:false,presentation:{status:'DRIVING'}}).action,'RESTART');
  assert.equal(driveState({...p,isReplay:true}).enabled,false);
  assert.equal(driveState({...p,controlMode:'TRAINING'}).enabled,false);
});
test('inspection availability distinguishes offline, observer and active configuration',()=>{
  assert.match(configurationReason({fresh:false}),/Connect CARLA/);
  assert.match(configurationReason({fresh:true,controller:false}),/does not own/);
  assert.equal(configurationReason({fresh:true,controller:true}),'');
  assert.match(configurationReason({recording:true}),/Stop it/);
});
test('saved media URLs cannot refer to arbitrary files',()=>{
  const path='D:\\runs\\normal_city\\run_'+'a'.repeat(32);
  const files=availableRecordings({runs:{ROBOSPHERE:{recording:path},NORMAL:{recording:path+'/../secret'},OTHER:{recording:'/output/test.mp4'}}});
  assert.equal(files.length,1);assert.equal(files[0].root,'/runs/normal_city/run_'+'a'.repeat(32)+'/');
});
test('saved conditions require complete setup and independent matching audits',()=>{
  const setup={map:'Town10HD',blueprint:'car',destination:{name:'End',location:[1,2,3]},speed_kmh:50,population:{seed:1},
    weather:{cloudiness:0},actual_population:{vehicles:24},origin:{location:[1,2,3],rotation:[0,359.9,0]},initial_condition_id:'same'};
  const pair={version:3,runs:{ROBOSPHERE:{setup,initial_condition_audit:{passed:true}},
    NORMAL:{setup:structuredClone(setup),initial_condition_audit:{passed:true}}}};
  pair.runs.NORMAL.setup.origin.rotation[1]=.1;assert.equal(recordedConditionsMatch(pair),true);
  pair.runs.NORMAL.initial_condition_audit.passed=false;assert.equal(recordedConditionsMatch(pair),false);
  pair.runs.NORMAL.initial_condition_audit.passed=true;pair.runs.NORMAL.setup.origin.location[0]+=1;
  assert.equal(recordedConditionsMatch(pair),false);
});
