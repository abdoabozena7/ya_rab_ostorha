import test from 'node:test';
import assert from 'node:assert/strict';
import { createParcels } from '../src/render/city-layout.js';
import { roadLayout } from '../src/simulation/road-lanes.js';

test('street parcels reproduce the seed and leave every road corridor clear',()=>{
  for(const extent of [100,140,180]) {
    const roads=roadLayout(extent).roads,parcels=createParcels(roads,extent,42);
    assert.deepEqual(parcels,createParcels(roads,extent,42));assert.ok(parcels.length>50);
    assert.notDeepEqual(parcels,createParcels(roads,extent,43));
    for(const p of parcels)for(const r of roads) {
      const intersects=r.axis==='z'
        ? Math.abs(p.x-r.fixed)<p.hx+r.width/2+2.8&&p.z+p.hz>r.min&&p.z-p.hz<r.max
        : Math.abs(p.z-r.fixed)<p.hz+r.width/2+2.8&&p.x+p.hx>r.min&&p.x-p.hx<r.max;
      assert.equal(intersects,false,`parcel ${p.id} blocks a road at extent ${extent}`);
    }
    for(let i=0;i<parcels.length;i++)for(let j=i+1;j<parcels.length;j++) {
      const a=parcels[i],b=parcels[j];
      assert.ok(Math.abs(a.x-b.x)>=a.hx+b.hx+.5||Math.abs(a.z-b.z)>=a.hz+b.hz+.5,'overlapping parcels');
    }
  }
});
