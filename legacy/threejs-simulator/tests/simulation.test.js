import test from 'node:test';
import assert from 'node:assert/strict';
import { findRoute, hasArrived } from '../src/simulation/pathfinding.js';
import { limitForwardSpeed, canAdvance, guardDynamicMotion } from '../src/simulation/safety.js';
import { findPlaceInText } from '../src/simulation/places.js';
import { isOnRoad, constrainToRoad, roadLayout } from '../src/simulation/road-lanes.js';

test('A* crosses an intersection even when expansion duplicates road nodes', () => {
  const nodes = [
    { x: 0, z: 0 }, { x: 0, z: 10 }, { x: 0, z: 20 },
    { x: 10, z: 10 }, { x: 20, z: 10 }, { x: 0, z: 10 },
  ];
  const path = findRoute(nodes, { x: 0, z: 0 }, { x: 20, z: 10 });
  assert.deepEqual(path.map(({ x, z }) => [x, z]), [[0, 0], [0, 10], [10, 10], [20, 10]]);
  assert.equal(path.at(-1).g, 30);
});

test('unreachable roads return no route', () => {
  assert.deepEqual(findRoute([{ x: 0, z: 0 }, { x: 100, z: 100 }], { x: 0, z: 0 }, { x: 100, z: 100 }), []);
});

test('arrival allows lane offset from a place marker', () => {
  assert.equal(hasArrived({ x: -62.9, z: 15.6 }, { x: -60, z: 20 }), true);
  assert.equal(hasArrived({ x: -70, z: 10 }, { x: -60, z: 20 }), false);
});

test('manual and automatic forward speed is capped near a hazard', () => {
  assert.deepEqual(limitForwardSpeed(0.4, 3), { speed: 0, emergency: true });
  assert.deepEqual(limitForwardSpeed(-0.1, 3), { speed: -0.1, emergency: false });
  assert.deepEqual(limitForwardSpeed(0.4, 40), { speed: 0.4, emergency: false });
});

test('Arabic destination requests map to a named road location', () => {
  assert.equal(findPlaceInText('روح المستشفى').id, 'hospital');
  assert.equal(findPlaceInText('اذهب إلى المحطة').id, 'station');
  assert.equal(findPlaceInText('روح مكان مش موجود'), null);
});

test('autonomous position is kept on the road grid', () => {
  assert.equal(isOnRoad(17.5, -40, 100), true);
  assert.equal(isOnRoad(0, 0, 100), false);
  const point = constrainToRoad(0, 0, 100);
  assert.equal(isOnRoad(point.x, point.z, 100), true);
});

test('irregular streets and side branches share the route graph', () => {
  const layout=roadLayout(100);
  assert.deepEqual(layout.xs,[-100,-70,-20,20,50,100]);
  assert.ok(layout.roads.some(road=>road.sideStreet&&road.fixed===-80));
  assert.equal(isOnRoad(-50,-80,100),true);
  assert.equal(isOnRoad(0,-80,100),false);
  assert.equal(isOnRoad(0,-60,100),false);
  const nodes=layout.roads.flatMap(road=>{
    const points=[];
    for(let n=road.min;n<=road.max;n+=10) points.push(road.axis==='z'?{x:road.fixed,z:n}:{x:n,z:road.fixed});
    return points;
  });
  assert.ok(findRoute(nodes,{x:-100,z:-80},{x:50,z:70}).length>10);
});

test('sweep blocks touching a person even between two frames', () => {
  const actors=[{position:{x:0,z:0},radius:0.6}];
  assert.equal(canAdvance({x:0,z:-4},{x:0,z:4},actors,2.2),false);
  assert.equal(canAdvance({x:5,z:-4},{x:5,z:4},actors,2.2),true);
});

test('predictive guard brakes for a crossing pedestrian', () => {
  const person={position:{x:-2,z:6},velocity:{x:0.12,z:0},radius:0.6};
  const guarded=guardDynamicMotion({x:0,z:0},0,0.4,[person]);
  assert.equal(guarded.emergency,true);
  assert.ok(guarded.speed<0.4);
});
