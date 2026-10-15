import test from 'node:test';
import assert from 'node:assert/strict';
import {recordingVideoRoot,demoFailure,benchmarkModes,selectPlaybackLeader} from '../frontend/demo-drive.js';

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
test('unaccepted driving and missing disk space offer factual recovery messages',()=>{
  assert.match(demoFailure('Hybrid native acceptance is unfinished'),/لم يكتمل/);
  assert.match(demoFailure('No space left on device'),/مساحة/);
  assert.match(demoFailure('Recording queue exhausted'),/أبطأ/);
  assert.match(demoFailure('SWEPT_SPACE_UNKNOWN_OR_OCCUPIED'),/مساحة الحركة/);
  assert.doesNotMatch(demoFailure('SWEPT_SPACE_UNKNOWN_OR_OCCUPIED'),/التسجيل/);
  assert.match(demoFailure('sensor freshness fault'),/بيانات الحركة/);
});
