import test from 'node:test';
import assert from 'node:assert/strict';
import {EGYPT_SCENARIO,LEGACY_SCENARIO,scenarioOptions,scenarioDriverText,completedOvertakes,scenarioRunSummary,urbanAvailability} from '../frontend/scenario-profile.js';
import {recordedDriverDescription} from '../frontend/driver-profile.js';
import {presentationSummary} from '../frontend/presentation-run.js';
import {missionState,stressSummary} from '../frontend/mission-state.js';

test('scenario availability explains missing catalog, pending acceptance and validation access',()=>{
  assert.equal(urbanAvailability(null).available,false);
  assert.match(urbanAvailability(null).notice,/has not been received/);
  const catalog={options:[{id:EGYPT_SCENARIO,available:false,reason:'Twelve source-bound native trips have not been accepted'}]};
  assert.equal(urbanAvailability(catalog).suffix,'unavailable');
  assert.match(urbanAvailability(catalog).notice,/Twelve source-bound native trips/);
  assert.match(urbanAvailability(catalog).notice,/No active validation window/);
  Object.assign(catalog.options[0],{available:true,validation_window_active:true});
  assert.equal(urbanAvailability(catalog).available,true);assert.equal(urbanAvailability(catalog).suffix,'validation only');
  Object.assign(catalog.options[0],{native_accepted:true});
  assert.match(urbanAvailability(catalog).notice,/acceptance verified/);
});

test('scenario selection is independent from first driver and preserves legacy speed',()=>{
  assert.deepEqual(scenarioOptions(EGYPT_SCENARIO),{scenario_id:EGYPT_SCENARIO,scene:'DENSE_CHAOS',speed_kmh:60});
  assert.equal(scenarioOptions(LEGACY_SCENARIO).speed_kmh,120);
  assert.equal(scenarioOptions().scenario_id,LEGACY_SCENARIO);
  assert.match(scenarioDriverText('ROBOSPHERE',EGYPT_SCENARIO),/moving-traffic/);
  assert.match(scenarioDriverText('NORMAL',EGYPT_SCENARIO),/reactive/);
});
test('recorded profiles do not relabel old videos as new maneuver driving',()=>{
  assert.match(recordedDriverDescription({driver_profile:{protocol:'EGYPT_COMPLETE_DRIVERS_V1',motion_prediction_used:true}}),/driver v2/);
  assert.match(recordedDriverDescription({driver_profile:{protocol:'EGYPT_COMPLETE_DRIVERS_V1',motion_prediction_used:false}}),/Normal driver/);
  assert.doesNotMatch(recordedDriverDescription({mode:'NORMAL'}),/driver v2/);
});
test('only completed measured passes count, and unknown metrics stay unknown',()=>{
  const run={driver_id:'ROBOSPHERE_URBAN_MANEUVER_V2',setup:{comparison_scenario:{id:EGYPT_SCENARIO,version:1,seed:1703}},
    completed_maneuvers:[{kind:'LANE_CHANGE',status:'REQUESTED'},{kind:'OVERTAKE',status:'COMPLETED',measured_clearance:true,return_required:true,returned:false},
      {kind:'OVERTAKE',status:'COMPLETED',measured_clearance:true,return_required:true,returned:true}]};
  assert.equal(completedOvertakes(run),1);assert.equal(completedOvertakes({}),null);
  assert.match(scenarioRunSummary(run),/v1 · seed 1703/);
  assert.match(scenarioRunSummary(run),/body separation unmeasured/);
  assert.match(scenarioRunSummary(run),/native scoring only/);
  assert.equal(scenarioRunSummary({setup:{protocol:'SENSOR_REACTIVE_PREDICTIVE_V1'}}),'');
});
test('Normal may arrive safely; acceptance summary never prescribes a Normal collision',()=>{
  const data={conditions_match:true,manifest:{comparison_scenario:{id:EGYPT_SCENARIO}},
    scenario_validation:{protocol:'EGYPT_COMPLETE_DRIVERS_V1',passed:true},
    runs:{NORMAL:{status:'ARRIVED'},ROBOSPHERE:{status:'ARRIVED',completed_maneuvers:[]}}};
  const summary=presentationSummary(data);
  assert.match(summary,/Normal: Destination reached/);assert.match(summary,/complete drivers/);
  assert.match(summary,/Normal contact is not required/);
  assert.doesNotMatch(summary,/Normal recorded a pedestrian collision/);
  data.scenario_validation.passed=false;data.runs.ROBOSPHERE.status='TIMEOUT';
  assert.match(presentationSummary(data),/incomplete or failed/);
});
test('guided urban driving reports its own scenario and bounded completion',()=>{
  const state=missionState({connected:true,fresh:true,controller:true,presentation:{guided:true,automatic_pair:true,
    scenario_id:EGYPT_SCENARIO,status:'DRIVING',modes:['NORMAL','ROBOSPHERE'],arm:1}});
  assert.match(state.detail,/maximum 60 km\/h/);assert.match(state.detail,/time limit/);
  assert.doesNotMatch(state.detail,/same crossing scenario/);
});
test('Egypt density and movement reporting does not reuse a short-crossing frustum quota',()=>{
  const summary=stressSummary({scenario_id:EGYPT_SCENARIO,motion_measurement_ready:true,
    counts:{vehicles:{total:60,moving_total:22},pedestrians:{total:100,moving_total:38}},
    series:{samples:10,motion_samples:9,density_failures:0}});
  assert.match(summary,/Actual totals: 60 \/ 100/);assert.match(summary,/22 vehicles \/ 38 pedestrians/);
  assert.doesNotMatch(summary,/frustum|Forward viewing area|unmeasured/);
});
