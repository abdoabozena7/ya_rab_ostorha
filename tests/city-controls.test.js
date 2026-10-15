import test from 'node:test';
import assert from 'node:assert/strict';
import {CITY_PRESETS,cityPopulation} from '../frontend/city-setup.js';
import {journeyActive,keepJourneyOnInspection,journeyHeartbeatAllowed} from '../frontend/journey-continuity.js';

const active=()=>({fresh:true,connected:true,controller:true,isReplay:false,restarting:false,controlMode:'AUTOMATIC',journey:{status:'RUNNING'}});
test('autonomous journey survives inspection and hidden tabs with transport liveness',()=>{
  const p=active(); assert.equal(keepJourneyOnInspection(p,false),true);
  assert.equal(journeyHeartbeatAllowed(p,false,false),true);
  assert.equal(keepJourneyOnInspection(p,true),true);
  assert.equal(journeyHeartbeatAllowed(p,true,false),true);
  assert.equal(journeyHeartbeatAllowed(p,false,true),false);
});
test('lease cannot revive stopped, collided, stale, read-only or emergency journeys',()=>{
  for(const value of [{fresh:false},{connected:false},{controller:false},{isReplay:true},{restarting:true},
    {journey:{status:'PAUSED',reason:'collision'}},{journey:{status:'ERROR'}},{controlMode:'EMERGENCY_STOP'},
    {controlMode:'MANUAL'},{controlMode:'DISCONNECTED'}]) {
    assert.equal(journeyActive({...active(),...value}),false,JSON.stringify(value));
  }
  assert.equal(journeyActive({...active(),controlMode:'PAUSED',journey:{status:'STARTING'}}),true);
  assert.equal(journeyActive({...active(),controlMode:'MANUAL',journey:{status:'STARTING'}}),true);
});

test('presentation preparation and playback survive workspace changes without releasing manual controls',()=>{
  for(const status of ['PREPARING','RESTORING','EXPORTING','PLAYBACK']){
    const p={...active(),controlMode:'PAUSED',journey:{status:'ARRIVED'},presentation:{id:'current',status}};
    assert.equal(keepJourneyOnInspection(p,true),true);
    assert.equal(keepJourneyOnInspection({...p,controlMode:'MANUAL'},true),false);
    assert.equal(keepJourneyOnInspection({...p,controller:false},true),false);
  }
});
test('city presets stay within the declared ordinary population bounds and preserve the seed',()=>{
  for(const preset of Object.values(CITY_PRESETS)) {
    const config=cityPopulation({seed:2604,fast_walk_percent:10,world_profile:'VISUAL_DEMO'},preset);
    assert.equal(config.seed,2604);assert.equal(config.fast_walk_percent,10);
    assert.equal(config.world_profile,'VISUAL_DEMO');
  }
  for(const changes of [{seed:-1},{vehicle_count:76},{pedestrian_count:51},{chaos_percent:101},
    {crossing_percent:61},{light_compliance_percent:NaN},{vehicle_count:1.5},{speed_behavior:'UNLIMITED'}]) {
    assert.throws(()=>cityPopulation({seed:42,...CITY_PRESETS.BUSY},changes));
  }
});
