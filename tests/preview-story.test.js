import test from 'node:test';
import assert from 'node:assert/strict';
import {previewFrame} from '../frontend/preview-story.js';

test('both illustrations start from the same car and pedestrian setup',()=>{
  for(const mode of ['NORMAL','ROBOSPHERE']){const f=previewFrame(mode,0);assert.equal(f.carX,-350);assert.equal(f.pedestrianY,0);assert.equal(f.contact,false);}
});
test('reactive illustration reaches contact while the predictive car remains clear',()=>{
  const crossing=previewFrame('NORMAL',3),stopped=previewFrame('NORMAL',4);
  assert.ok(crossing.pedestrianY>0);assert.equal(crossing.prediction,false);
  assert.ok(stopped.carX+724>=780);assert.equal(stopped.pedestrianY,36);assert.equal(stopped.contact,true);
  assert.equal(previewFrame('NORMAL',8).carX,stopped.carX);
  assert.equal(previewFrame('NORMAL',9).carX,stopped.carX);
});
test('reactive sensing still detects and brakes before the illustrated contact',()=>{
  const before=previewFrame('NORMAL',1.9),detected=previewFrame('NORMAL',2.1),later=previewFrame('NORMAL',3.2);
  assert.equal(before.reactive,false);assert.equal(detected.reactive,true);assert.equal(detected.braking,true);
  assert.ok(detected.pedestrianY>0);assert.ok(detected.carX+724<780);
  assert.ok(later.carX>detected.carX);assert.equal(later.reactive,true);assert.equal(later.contact,false);assert.equal(previewFrame('NORMAL',4).contact,true);
});
test('prediction precedes crossing, car remains stopped until pedestrian clears',()=>{
  const prediction=previewFrame('ROBOSPHERE',1.5),stopped=previewFrame('ROBOSPHERE',3.2);
  assert.equal(prediction.prediction,true);assert.equal(prediction.pedestrianY,0);
  assert.equal(stopped.phase,'stopped');assert.ok(stopped.pedestrianY>0);assert.ok(stopped.carX+724<780-100);
  for(const t of [4,5,6,7,7.5,8]){const f=previewFrame('ROBOSPHERE',t);assert.equal(f.carX,stopped.carX);assert.equal(f.contact,false);}
  assert.equal(previewFrame('ROBOSPHERE',7.5).pedestrianY,100);
  assert.ok(previewFrame('ROBOSPHERE',9).carX>stopped.carX);
});

test('both sensors see the same person on the pavement before either response',()=>{
  for(const t of [0,.5,1.5]){const normal=previewFrame('NORMAL',t),protectedRun=previewFrame('ROBOSPHERE',t);assert.equal(normal.detected,true);assert.equal(protectedRun.detected,true);assert.equal(normal.pedestrianY,0);assert.equal(protectedRun.pedestrianY,0);}
  assert.equal(previewFrame('NORMAL',1.5).braking,false);assert.equal(previewFrame('ROBOSPHERE',1.5).braking,true);
});

test('both illustrations observe the same crossing timeline; contact is specific to the reactive story',()=>{
  for(const t of [0,1,2,2.5,3,4,5,7.5,9]){
    assert.equal(previewFrame('NORMAL',t).pedestrianY,previewFrame('ROBOSPHERE',t).pedestrianY);
    assert.equal(previewFrame('NORMAL',t).contact,t>=3.25);
    assert.equal(previewFrame('ROBOSPHERE',t).contact,false);
  }
});
