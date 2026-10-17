import test from 'node:test';
import assert from 'node:assert/strict';
import {CameraPerformance} from '../frontend/camera-performance.js';
test('camera quality uses decoded distinct frames and fails a visible gap',()=>{
  const meter=new CameraPerformance();
  for(let i=0;i<=205;i++)meter.present(i,i*.05,i*50,'arm');
  assert.equal(meter.snapshot().passed,true);
  meter.present(206,10.3,11000,'arm');
  assert.equal(meter.snapshot().passed,false);
  meter.present(1,0,12000,'next-arm');
  assert.equal(meter.snapshot().passed,false);
  assert.equal(meter.snapshot().windows.length,0);
});
