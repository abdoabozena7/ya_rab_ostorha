import test from 'node:test';
import assert from 'node:assert/strict';
import {PerceptionView} from '../frontend/perception-view.js';

test('an unavailable processed JPEG cannot relabel the previously displayed frame',async()=>{
  const oldDocument=globalThis.document,oldFetch=globalThis.fetch;
  const elements={perceptionStatus:{textContent:'Running frame 10'},
    perceptionFrame:{textContent:'Frame 10'},perceptionCamera:{src:'blob:frame10'}};
  let requests=0;
  globalThis.document={getElementById:id=>elements[id]};
  globalThis.fetch=async()=>++requests===1?
    {ok:true,json:async()=>({status:'RUNNING',session_id:'live',frame_id:20,
      timestamp_s:1,image_token:'frame_live_20.jpg',device:'CPU',inference_ms:100,
      detections:[],texts:[]})}:{ok:false};
  try {
    const view=new PerceptionView({fresh:true,isReplay:false,sessionId:'live',telemetry:{frame:21}});
    view.token='frame_live_10.jpg';view.url='blob:frame10';
    await view.update();
    assert.equal(elements.perceptionFrame.textContent,'Frame 10');
    assert.equal(elements.perceptionCamera.src,'blob:frame10');
    assert.equal(view.token,'frame_live_10.jpg');
    assert.equal(view.busy,false);
  } finally {globalThis.document=oldDocument;globalThis.fetch=oldFetch;}
});
