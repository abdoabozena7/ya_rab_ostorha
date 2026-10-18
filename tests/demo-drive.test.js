import test from 'node:test';
import assert from 'node:assert/strict';
import {recordingVideoRoot,demoFailure,benchmarkModes,selectPlaybackLeader,benchmarkSpeedText} from '../frontend/demo-drive.js';
import {benchmarkTerminalSupported} from '../frontend/journey-comparison.js';

test('a stopped route-end failure remains comparable while user stops and runtime faults cancel',()=>{
  assert.equal(benchmarkTerminalSupported({status:'ERROR',reason:'route_ended_before_destination'}),true);
  assert.equal(benchmarkTerminalSupported({status:'PAUSED',reason:'collision'}),true);
  for(const journey of [{status:'ERROR',reason:'runtime_failure'},{status:'PAUSED',reason:'operator_stop'},
      {status:'RUNNING',reason:'collision'}])assert.equal(benchmarkTerminalSupported(journey),false);
});

test('paired playback continues to the longer journey after the shorter one ends',()=>{
  const baseline={duration_s:21},hybrid={duration_s:28};
  assert.equal(selectPlaybackLeader([baseline,hybrid]),hybrid);
  assert.equal(selectPlaybackLeader([hybrid,baseline]),hybrid);
  assert.equal(selectPlaybackLeader([]),null);
});

test('video references are confined to native ordinary recording IDs',()=>{
  const id='run_'+'a'.repeat(32);
  assert.equal(recordingVideoRoot('D:\\projects\\Ai\\ya_rab_ostorha\\runs\\normal_city\\'+id),'/runs/normal_city/'+id+'/');
  for(const path of ['../../secret','/normal_city/run_1234','/normal_city/'+id+'/../other','/experiments/'+id])assert.equal(recordingVideoRoot(path),null);
});
test('native benchmark drivers remain distinct from legacy protection modes',()=>{
  assert.deepEqual(benchmarkModes,['BASELINE','HYBRID']);
});
test('comparison distinguishes measured speed from the request and missing legacy peaks',()=>{
  const run={samples:20,mean_speed_kmh:14.2,maximum_speed_kmh:28.68,setup:{speed_kmh:50}};
  assert.match(benchmarkSpeedText(run),/mean 14.2.*peak 28.7.*requested 50/);
  assert.match(benchmarkSpeedText({...run,maximum_speed_kmh:undefined}),/peak —/);
  assert.match(benchmarkSpeedText({...run,samples:0}),/mean —.*peak —/);
  assert.equal(benchmarkSpeedText(null),'');
});
test('unaccepted driving and missing disk space offer factual recovery messages',()=>{
  assert.match(demoFailure('Hybrid native acceptance is unfinished'),/unfinished/);
  assert.match(demoFailure('No space left on device'),/space/);
  assert.match(demoFailure('Recording queue exhausted'),/falling behind/);
  assert.match(demoFailure('SWEPT_SPACE_UNKNOWN_OR_OCCUPIED'),/movement corridor/);
  assert.doesNotMatch(demoFailure('SWEPT_SPACE_UNKNOWN_OR_OCCUPIED'),/recording/);
  assert.match(demoFailure('sensor freshness fault'),/Motion sensors/);
});

test('changed native traffic retains its actual failure instead of blaming recording',()=>{
  const reason='The comparison traffic changed; its recordings are retained. Use Restart for a new matched setup.';
  assert.match(demoFailure(reason),/comparison traffic changed/);
  assert.match(demoFailure(reason),/matched comparison cannot continue/);
  assert.doesNotMatch(demoFailure(reason),/Recording did not finish/);
  assert.equal(demoFailure(demoFailure(reason)),demoFailure(reason));
});

test('saved recording text is not itself an export or recording fault',()=>{
  for(const reason of ['Contact ended this attempt. Its recording and result are saved.',
      'Both recordings are retained.'])assert.equal(demoFailure(reason),reason);
  for(const reason of ['recording_failure','video_export_failed: encoder failure',
      'Recording write failed'])assert.match(demoFailure(reason),/Recording did not finish/);
});
