import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {presentationSummary,presentationStep,presentationTrafficText} from '../frontend/presentation-run.js';

test('automatic route population shows actual counts and capacity limits',()=>{
  assert.match(presentationTrafficText(null,null),/up to 40 vehicles · 30 pedestrians/);
  const p={actual:{vehicles:34,pedestrians:30},route_crowding:{target_count:34}};
  assert.match(presentationTrafficText(p,null),/34\/40 vehicles · 30\/30 pedestrians/);
  assert.match(presentationTrafficText(p,null),/limited by safe road spaces/);
  p.actual.vehicles=40;p.route_crowding.target_count=40;
  assert.doesNotMatch(presentationTrafficText(p,null),/limited/);
});

test('presentation results never infer superiority from a failed or mismatched pair',()=>{
  const data={conditions_match:true,runs:{ROBOSPHERE:{status:'ARRIVED'},NORMAL:{status:'ARRIVED'}}};
  assert.match(presentationSummary(data),/Both drivers reached/);
  assert.match(presentationSummary({...data,conditions_match:false}),/not verified/);
  assert.match(presentationSummary({...data,runs:{...data.runs,NORMAL:{status:'COLLISION'}}}),/ended early/);
  assert.doesNotMatch(presentationSummary(data),/prevented|better|safer/);
  assert.equal(presentationStep('DRIVING',1),1);
  assert.equal(presentationStep('EXPORTING'),2);
  assert.equal(presentationStep('PLAYBACK'),3);
  assert.equal(presentationStep('COMPLETE'),4);
});

test('shipped dashboard interface contains no Arabic UI strings',()=>{
  const files=['index.html',...readdirSync('frontend').filter(n=>n.endsWith('.js')).map(n=>'frontend/'+n)];
  for(const file of files)assert.doesNotMatch(readFileSync(file,'utf8'),/[\u0600-\u06ff]/,file);
});
