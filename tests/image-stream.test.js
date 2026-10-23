import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate as settle} from 'node:timers/promises';
import {CameraImageStream,parseImagePacket} from '../frontend/image-stream.js';
import {CameraPerformance} from '../frontend/camera-performance.js';

const epoch=1700000000000;
function packet(frame,{session='a',camera='drivingCamera',capture=epoch,width=1280,height=720,time=frame/60}={}){
  const payload=new Uint8Array([255,216,255,217]);
  const header=new TextEncoder().encode(JSON.stringify({protocol:'ostorha-image-v1',session_id:session,camera_id:camera,
    frame_id:frame,simulation_timestamp_s:time,width,height,content_type:'image/jpeg',
    capture_unix_s:capture/1000,capture_clock:'NATIVE_TICK_REQUEST',payload_bytes:payload.length}));
  const bytes=new Uint8Array(4+header.length+payload.length);
  new DataView(bytes.buffer).setUint32(0,header.length);bytes.set(header,4);bytes.set(payload,4+header.length);
  return bytes.buffer;
}
function fixture({deferred=false}={}){
  let time=0,token=0;const callbacks=new Map(),sockets=[],jobs=[],drawn=[],errors=[];
  class Socket{
    constructor(url){this.url=url;this.sent=[];this.readyState=0;sockets.push(this);}
    send(value){this.sent.push(JSON.parse(value));}
    close(){this.readyState=3;this.onclose?.();}
    open(){
      this.readyState=1;this.onopen();
      const request=this.sent.at(-1);
      this.onmessage({data:JSON.stringify({type:'image_stream',protocol:'ostorha-image-v1',
        session_id:request.session_id,camera_id:request.camera_id,client_unix_ms:request.client_unix_ms,
        server_unix_ms:epoch+time})});
    }
    receive(buffer){this.onmessage({data:buffer});}
  }
  function bitmap(frame){return {width:1280,height:720,frame,closed:0,close(){this.closed++;}};}
  const stream=new CameraImageStream({Socket,
    decode:()=>deferred?new Promise((resolve,reject)=>jobs.push({resolve,reject})):Promise.resolve(bitmap(1)),
    raf:callback=>{const id=++token;callbacks.set(id,callback);return id;},cancel:id=>callbacks.delete(id),
    now:()=>time,wallNow:()=>epoch+time,visible:()=>true,
    draw:(image,header)=>drawn.push(header.frame_id),onUnavailable:error=>errors.push(error)});
  const configure=(session='a')=>stream.configure({enabled:true,sessionId:session,url:'ws://local/images',
    cameraId:'drivingCamera',profile:'PERFORMANCE_60',arm:session});
  function raf(at){time=at;const batch=[...callbacks.values()];callbacks.clear();for(const callback of batch)callback(time);}
  configure();sockets[0].open();
  return {stream,sockets,jobs,drawn,errors,bitmap,configure,raf};
}

test('binary header preserves exact JPEG bytes and rejects malformed dimensions and lengths',()=>{
  const decoded=parseImagePacket(packet(42));
  assert.equal(decoded.header.session_id,'a');assert.equal(decoded.header.frame_id,42);
  assert.equal(decoded.header.simulation_timestamp_s,.7);
  assert.deepEqual([...decoded.payload],[255,216,255,217]);
  assert.equal(decoded.header.width,1280);assert.equal(decoded.header.height,720);
  assert.throws(()=>parseImagePacket(packet(1,{width:0})),/dimensions/);
  assert.throws(()=>parseImagePacket(packet(1,{time:NaN})),/identity/);
  assert.throws(()=>parseImagePacket(new ArrayBuffer(3)),/size/);
  const invalid=packet(1);new DataView(invalid).setUint32(0,16385);
  assert.throws(()=>parseImagePacket(invalid),/header/);
});

test('image socket only subscribes and acknowledges; decoded images wait for RAF',async()=>{
  const f=fixture();f.sockets[0].receive(packet(1));await settle();
  assert.deepEqual(f.drawn,[]);
  f.raf(16.7);
  assert.deepEqual(f.drawn,[1]);
  assert.deepEqual(f.sockets[0].sent.map(v=>v.type),['subscribe','ack']);
  assert.equal(f.stream.meter.snapshot().displayed_frames,1);
  f.stream.stop();
});

test('slow decode keeps one pending compressed image and newest ready bitmap without starving display',async()=>{
  const f=fixture({deferred:true});f.sockets[0].receive(packet(1));await settle();
  f.sockets[0].receive(packet(2));f.sockets[0].receive(packet(3));
  assert.equal(f.stream.pending.header.frame_id,3);
  assert.equal(f.stream.drops.superseded,1);
  const first=f.bitmap(1);f.jobs[0].resolve(first);await settle();
  f.raf(16.7);
  assert.deepEqual(f.drawn,[1]);assert.equal(first.closed,1);
  const newest=f.bitmap(3);f.jobs[1].resolve(newest);await settle();f.raf(33.4);
  assert.deepEqual(f.drawn,[1,3]);assert.equal(newest.closed,1);
  f.stream.stop();
});

test('newer decoded bitmap replaces an undisplayed bitmap and disposes it',async()=>{
  const f=fixture({deferred:true});f.sockets[0].receive(packet(1));await settle();
  const old=f.bitmap(1);f.jobs[0].resolve(old);await settle();
  f.sockets[0].receive(packet(2));await settle();
  const next=f.bitmap(2);f.jobs[1].resolve(next);await settle();
  assert.equal(old.closed,1);f.raf(16.7);assert.deepEqual(f.drawn,[2]);
  assert.equal(next.closed,1);f.stream.stop();
});

test('a late packet, a replayed identity and out-of-order pending frames are dropped',async()=>{
  const f=fixture({deferred:true});f.raf(300);
  f.sockets[0].receive(packet(1));assert.equal(f.stream.drops.late,1);
  f.sockets[0].receive(packet(4,{capture:epoch+300}));await settle();
  f.sockets[0].receive(packet(3,{capture:epoch+300}));
  assert.equal(f.stream.drops.outOfOrder,1);
  f.sockets[0].receive(packet(5,{session:'old',capture:epoch+300}));
  assert.equal(f.stream.drops.session,1);
  f.jobs[0].resolve(f.bitmap(4));await settle();f.raf(316);
  f.sockets[0].receive(packet(4,{capture:epoch+316}));
  assert.equal(f.stream.drops.outOfOrder,2);
  assert.deepEqual(f.drawn,[4]);f.stream.stop();
});

test('session replacement closes a late decode instead of presenting the previous car',async()=>{
  const f=fixture({deferred:true});f.sockets[0].receive(packet(1));await settle();
  f.configure('b');f.sockets[1].open();
  const old=f.bitmap(1);f.jobs[0].resolve(old);await settle();f.raf(16);
  assert.equal(old.closed,1);assert.deepEqual(f.drawn,[]);
  f.sockets[1].receive(packet(2,{session:'b'}));await settle();
  f.jobs[1].resolve(f.bitmap(2));await settle();f.raf(32);
  assert.deepEqual(f.drawn,[2]);f.stream.stop();
});

test('disconnect clears stale ready frames, cannot release controls and reconnects independently',async()=>{
  const f=fixture({deferred:true});f.sockets[0].receive(packet(1));await settle();
  f.sockets[0].close();
  const old=f.bitmap(1);f.jobs[0].resolve(old);await settle();f.raf(16);
  assert.equal(old.closed,1);assert.deepEqual(f.drawn,[]);
  assert.match(f.errors.at(-1),/controls are separate/);
  f.raf(600);assert.equal(f.sockets.length,2);
  assert.deepEqual(f.sockets[0].sent.map(v=>v.type),['subscribe','ack']);f.stream.stop();
});

test('decoder errors surface explicitly and stale frames cannot keep a healthy-looking image',async()=>{
  const f=fixture();f.sockets[0].receive(packet(1));await settle();f.raf(16);
  f.raf(300);assert.match(f.errors.at(-1),/expired/);
  f.stream.stop();
  const failing=fixture({deferred:true});failing.sockets[0].receive(packet(1));await settle();
  failing.jobs[0].reject(new Error('bad JPEG'));await settle();
  assert.match(failing.errors.at(-1),/decode failed.*bad JPEG/);assert.deepEqual(failing.drawn,[]);
  failing.stream.stop();
});

function windowAt(hz,{ratio=1,jitter=false}={}){
  const meter=new CameraPerformance({profile:'PERFORMANCE_60'});let wall=0;
  for(let i=0;i<hz*10;i++){
    meter.present(i,wall/1000*ratio,wall,'arm');
    wall+=jitter?(i%10===0?30:(1000/60*10-30)/9):1000/hz;
  }
  meter.advance(10000);
  return meter;
}
test('acceptance tests the exact 10-second 58-60 Hz, simulation ratio and p95 thresholds',()=>{
  for(const hz of [58,59,60]){
    const meter=windowAt(hz);
    assert.equal(meter.snapshot().windows[0].fps,hz);
    assert.equal(meter.snapshot().passed,true);
  }
  for(const hz of [57,61])assert.equal(windowAt(hz).snapshot().passed,false);
  for(const ratio of [.94,1.06])assert.equal(windowAt(60,{ratio}).snapshot().passed,false);
  for(const ratio of [.95,1.05])assert.equal(windowAt(60,{ratio}).snapshot().passed,true);
  const uneven=windowAt(60,{jitter:true});
  assert.equal(uneven.snapshot().windows[0].fps,60);
  assert.equal(uneven.snapshot().windows[0].p95_frame_interval_ms,30);
  assert.equal(uneven.snapshot().passed,false);
});

test('a telemetry-only stall closes failed windows without inventing presentations',()=>{
  const meter=windowAt(60);meter.advance(30000);
  assert.equal(meter.snapshot().completed_windows,3);
  assert.equal(meter.snapshot().windows[1].fps,0);
  assert.equal(meter.snapshot().passed,false);
  const before=meter.snapshot().displayed_frames;
  assert.equal(meter.present(599,9.9,31000,'arm'),false);
  assert.equal(meter.snapshot().displayed_frames,before);
});
