import test from 'node:test';
import assert from 'node:assert/strict';
import {createCinematic} from '../src/render/cinematic.js';
import {createFixedStep} from '../src/simulation/fixed-step.js';

test('predicted impact slows simulation time, recovers, and respects cooldown and disable',()=>{
  const previous=globalThis.document;
  const panel={hidden:true},classes=new Set();
  globalThis.document={getElementById:()=>panel,body:{classList:{add:s=>classes.add(s),remove:s=>classes.delete(s)}}};
  class Vector3{set(x,y,z){Object.assign(this,{x,y,z});return this;}lerp(){return this;}}
  try {
    const camera={position:new Vector3(),lookAt(){},updateProjectionMatrix(){}},c=createCinematic({Vector3},camera);
    const actor={position:{x:0,z:14},width:2,length:4,heading:0,velocity:{x:0,z:0}};
    c.detect({x:0,z:0},0,12,[actor]);
    assert.equal(c.active,true);assert.equal(c.events.length,1);assert.equal(panel.hidden,false);
    const clock=createFixedStep();let steps=0;
    for(let i=0;i<60;i++)clock.advance(c.scale/60,()=>steps++);
    assert.ok(steps>=12&&steps<=14,'one wall second should advance about .22 simulation seconds');
    c.update(6,{position:{x:0,z:0}},0);
    assert.equal(c.active,false);assert.equal(c.scale,1);
    c.detect({x:0,z:0},0,12,[actor]);assert.equal(c.events.length,1);
    c.update(20,{position:{x:0,z:0}},0);c.setEnabled(false);
    c.detect({x:0,z:0},0,12,[actor]);assert.equal(c.active,false);
  } finally {globalThis.document=previous;}
});
