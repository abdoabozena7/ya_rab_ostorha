import test from 'node:test';
import assert from 'node:assert/strict';
import {stepVehicle} from '../src/simulation/vehicle-dynamics.js';
import {SURFACES,surfaceAhead,WORLD_EXTENT} from '../src/simulation/road-conditions.js';
import {rectangle,hullDistance,motionClear,leadVehicle,collisionRisk} from '../src/simulation/vehicle-geometry.js';
import {followingAcceleration,stoppingDistance} from '../src/simulation/longitudinal.js';
import {buildDrivingPath,followRoute,endTurn} from '../src/simulation/route-driver.js';
import {roadLayout,isOnRoad} from '../src/simulation/road-lanes.js';
import {createIncidents} from '../src/simulation/incidents.js';
import {findRoute} from '../src/simulation/pathfinding.js';

function run(seconds,input,state={speed:0,angle:0}){for(let i=0;i<seconds*60;i++)state=stepVehicle(state,input);return state;}
test('pedal pressure changes acceleration, brake pressure changes stopping distance',()=>{
  assert.ok(run(6,{throttle:1}).speed>run(6,{throttle:.25}).speed*1.5);
  const stop=pressure=>{let s={speed:20/60,angle:0},d=0;for(let i=0;i<4000&&s.speed>0;i++){s=stepVehicle(s,{brake:pressure});d+=s.speed;}return d;};
  assert.ok(stop(.25)>stop(1)*2);
});
test('wet road takes longer to stop and rough road is anticipated',()=>{
  assert.ok(stoppingDistance(25,SURFACES.wet.grip)>stoppingDistance(25,SURFACES.asphalt.grip));
  const ahead=surfaceAhead({x:17.5,z:65},0,20);
  assert.ok(ahead.limit<20);assert.equal(ahead.surface,SURFACES.asphalt);
});
test('full throttle reaches high speed on an unrestricted straight and steering obeys grip',()=>{
  assert.ok(run(45,{throttle:1}).speed*216>170);
  const s=run(2,{throttle:1,left:true,surface:SURFACES.wet},{speed:30/60,angle:0});
  assert.ok(Math.abs(s.lateralAcceleration)<=SURFACES.wet.grip*9.81*.72);
  assert.equal(run(2,{left:true}).angle,0);
});
test('centimetre clearances measure oriented hulls and permit narrow parallel passing',()=>{
  const a=rectangle({x:0,z:0},0,2,4),b=rectangle({x:2.25,z:0},0,2,4);
  assert.equal(Math.round(hullDistance(a,b)*100),25);
  assert.ok(motionClear({x:0,z:-5},0,10,[{position:{x:2.3,z:0},width:2,length:4,heading:0}],{width:2,length:4},.1));
  assert.equal(motionClear({x:0,z:-5},0,10,[{position:{x:0,z:0},width:2,length:4}],{width:2,length:4}),false);
  const neighbour={position:{x:2.1,z:0},width:2,length:4,heading:0};
  assert.equal(motionClear({x:0,z:0},0,.1,[neighbour],{width:2,length:4},.16),true);
  assert.equal(motionClear({x:0,z:0},Math.PI/2,.2,[neighbour],{width:4,length:2},.16),false);
});
test('leader gap is bumper to bumper; crossing risk detects future intersection',()=>{
  const lead=leadVehicle({x:0,z:0},0,[{position:{x:0,z:10},width:2,length:4,heading:0,velocity:{x:0,z:.1}}],{width:2,length:4});
  assert.equal(lead.gap,6);assert.equal(lead.velocity,6);
  assert.ok(collisionRisk({x:0,z:0},0,15,[{position:{x:-8,z:15},width:2,length:4,heading:Math.PI/2,velocity:{x:.15,z:0}}]));
});
test('a traffic queue brakes behind a stopped leader and resumes when it moves',()=>{
  let v=12,gap=35,minGap=gap;
  for(let i=0;i<900;i++){v=Math.max(0,v+followingAcceleration(v,15,gap,0)/60);gap-=v/60;minGap=Math.min(minGap,gap);}
  assert.ok(minGap>1);assert.ok(v<.01);
  for(let i=0;i<180;i++){gap+=7/60;v=Math.max(0,v+followingAcceleration(v,15,gap,7)/60);gap-=v/60;}
  assert.ok(v>3);
});
test('extended road supports a route exceeding one kilometre',()=>{
  const roads=roadLayout(WORLD_EXTENT).roads;
  const nodes=roads.flatMap(r=>Array.from({length:(r.max-r.min)/10+1},(_,i)=>r.axis==='z'?{x:r.fixed,z:r.min+i*10}:{x:r.min+i*10,z:r.fixed}));
  const path=findRoute(nodes,{x:20,z:-620},{x:20,z:620});
  assert.ok(path.at(-1).g>=1240);
});
test('route following keeps a turn on the road and does not rotate at rest',()=>{
  const path=[{x:20,z:-40},{x:20,z:-30},{x:20,z:-20},{x:30,z:-20},{x:40,z:-20},{x:50,z:-20}];
  const points=buildDrivingPath(path);let state={speed:0,angle:0},pos={x:17.5,z:-40},cursor=0,offRoad=0;
  for(let i=0;i<4000;i++){
    const route=followRoute(points,pos,state.angle,state.speed*60,cursor);cursor=route.cursor;
    const target=Math.min(8,route.limit),error=target-state.speed*60;
    state=stepVehicle(state,{throttle:Math.max(0,Math.min(1,error)),brake:Math.max(0,Math.min(1,-error*.5)),steering:route.steering});
    pos.x+=Math.sin(state.angle)*state.speed;pos.z+=Math.cos(state.angle)*state.speed;
    if(!isOnRoad(pos.x,pos.z,100,3.8))offRoad++;
    if(route.remaining<3)break;
  }
  assert.equal(offRoad,0);assert.ok(Math.hypot(pos.x-50,pos.z+17.5)<5);
});
test('seeded incidents expire and repeat with the same seed',()=>{
  const vehicles=Array.from({length:5},(_,i)=>({position:{x:0,z:20+i*10}}));
  const a=createIncidents(12),b=createIncidents(12);
  const ea=a.trigger(vehicles,{x:0,z:0}),eb=b.trigger(vehicles,{x:0,z:0});
  assert.equal(ea.type,eb.type);assert.equal(ea.vehicle,eb.vehicle);
  a.tick(60,vehicles,{x:0,z:0},false);assert.equal(a.active.length,0);
});
test('traffic joins the arterial extension and turns out of a side street',()=>{
  const roads=roadLayout(WORLD_EXTENT).roads;
  const main=roads.find(r=>r.axis==='z'&&r.fixed===20&&r.max===100);
  const through=endTurn(main,1,roads,0);
  assert.equal(through.road.min,100);assert.equal(through.road.max,WORLD_EXTENT);
  assert.equal(through.points[0].x,17.5);assert.equal(through.points.at(-1).x,17.5);
  const side=roads.find(r=>r.sideStreet&&r.axis==='x'&&r.fixed===40);
  const turn=endTurn(side,-1,roads,2);
  assert.equal(turn.road.axis,'z');assert.equal(turn.road.fixed,20);
  assert.ok(turn.points.every(p=>isOnRoad(p.x,p.z,WORLD_EXTENT,4)));
  assert.ok(turn.points.at(-1).s>8);
});
test('narrow streets use a lane offset that leaves room for the body',()=>{
  const points=buildDrivingPath([{x:-60,z:-80},{x:-50,z:-80},{x:-40,z:-80}],()=>1.5);
  for(const p of points)assert.ok(Math.abs(p.z+80)+1.86/2<6.4/2);
});
