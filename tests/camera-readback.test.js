import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { createVisualClient } from "../src/integration/bridge.js";

const jpeg = "data:image/jpeg;base64,/9j/2Q==";
const flush = () => new Promise(setImmediate);
const ready = (result = null) => ({ available: true, source: "camera-pixels", status: "ready", result });

function fixture(t, { webgl2 = true, respond = () => ready() } = {}) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  let encoderWorkMs = 0, encoderResult = jpeg;
  t.mock.method(performance, "now", () => Date.now() + encoderWorkMs);
  const tick = (ms) => t.mock.timers.tick(ms);
  const frames = [], results = [], requests = [], uploads = [], encodes = [];
  const renders = [], waits = [], buffers = new Set(), fences = new Set(), queued = [];
  const rearTarget = {}, externalPackBuffer = {};
  const surface = new EventTarget();
  let activeTarget = [rearTarget, 3, 1], boundPackBuffer = externalPackBuffer;
  let currentColor, allocated = 0, externalReads = 0, lost = false, drawError = 0;
  const gl = {
    PIXEL_PACK_BUFFER: 1, PIXEL_PACK_BUFFER_BINDING: 2, STREAM_READ: 3, RGBA: 4, UNSIGNED_BYTE: 5,
    SYNC_GPU_COMMANDS_COMPLETE: 6, ALREADY_SIGNALED: 7, CONDITION_SATISFIED: 8,
    TIMEOUT_EXPIRED: 9, WAIT_FAILED: 10, NO_ERROR: 0,
    isContextLost: () => lost,
    getError() { const err = drawError; drawError = 0; return err; },
    getParameter(key) {
      assert.equal(key, gl.PIXEL_PACK_BUFFER_BINDING);
      return boundPackBuffer;
    },
    bindBuffer(key, buffer) {
      assert.equal(key, gl.PIXEL_PACK_BUFFER);
      boundPackBuffer = buffer;
    },
    createBuffer() { const buffer = { id: ++allocated }; buffers.add(buffer); return buffer; },
    deleteBuffer(buffer) { assert.ok(buffers.delete(buffer)); },
    bufferData(target, size, mode) {
      assert.deepEqual([target, size, mode], [gl.PIXEL_PACK_BUFFER, 921600, gl.STREAM_READ]);
      assert.ok(buffers.has(boundPackBuffer));
      boundPackBuffer.bytes = new Uint8Array(size);
    },
    readPixels(x, y, width, height, format, type, offset) {
      assert.deepEqual([x, y, width, height, format, type, offset],
        [0, 0, 640, 360, gl.RGBA, gl.UNSIGNED_BYTE, 0]);
      assert.equal(activeTarget[0], renders.at(-1).target);
      assert.ok(buffers.has(boundPackBuffer));
      stampPixels(boundPackBuffer.bytes);
      queued.push(boundPackBuffer);
    },
    fenceSync(condition, flags) {
      assert.deepEqual([condition, flags], [gl.SYNC_GPU_COMMANDS_COMPLETE, 0]);
      assert.ok(queued.length);
      const fence = {};
      fences.add(fence);
      return fence;
    },
    flush() { assert.equal(fences.size, 1); },
    waitStatus: 9,
    clientWaitSync(fence, flags, timeout) {
      assert.equal(activeTarget[0], rearTarget);
      assert.ok(fences.has(fence));
      waits.push({ flags, timeout });
      return gl.waitStatus;
    },
    deleteSync(fence) { assert.ok(fences.delete(fence)); },
    getBufferSubData(target, offset, destination) {
      assert.deepEqual([target, offset], [gl.PIXEL_PACK_BUFFER, 0]);
      assert.ok([gl.ALREADY_SIGNALED, gl.CONDITION_SATISFIED].includes(gl.waitStatus));
      assert.equal(activeTarget[0], rearTarget);
      destination.set(boundPackBuffer.bytes);
    },
  };
  function stampPixels(bytes) {
    bytes.fill(0);
    bytes[0] = currentColor;
    bytes[bytes.length - 640 * 4] = currentColor + 80;
  }
  const canvas = {
    getContext: () => ({
      createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
      putImageData({ data }, x, y) {
        assert.deepEqual([x, y, activeTarget[0], boundPackBuffer], [0, 0, rearTarget, externalPackBuffer]);
        uploads.push([data[0], data[(360 - 1) * 640 * 4]]);
      },
    }),
    toBlob() { assert.fail("This transport must not queue a toBlob task"); },
    toDataURL(type, quality) {
      encodes.push({ type, quality });
      encoderWorkMs += 3;
      return encoderResult;
    },
  };
  const oldDocument = globalThis.document, oldReader = globalThis.FileReader;
  globalThis.document = { createElement: () => canvas };
  // Provide both browser capabilities so falling back only when toBlob/FileReader are absent cannot pass.
  globalThis.FileReader = class {};
  t.after(() => {
    globalThis.document = oldDocument;
    globalThis.FileReader = oldReader;
  });
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const request = { url, options };
    requests.push(request);
    const data = await respond(request);
    return { ok: true, json: async () => data };
  });
  const renderer = {
    capabilities: { isWebGL2: webgl2 }, domElement: surface, getContext: () => gl,
    getRenderTarget: () => activeTarget[0],
    getActiveCubeFace: () => activeTarget[1],
    getActiveMipmapLevel: () => activeTarget[2],
    setRenderTarget(target, face = 0, level = 0) { activeTarget = [target, face, level]; },
    render(scene, camera) {
      const [target] = activeTarget;
      assert.notEqual(target, rearTarget);
      assert.deepEqual(target.viewport.toArray(), [0, 0, 640, 360]);
      assert.equal(target.scissorTest, false);
      assert.equal(target.samples, 0);
      assert.equal(target.texture.colorSpace, THREE.SRGBColorSpace);
      renders.push({ scene, camera, target });
      currentColor = camera.userData.front ? 42 : 5;
    },
    readRenderTargetPixels(target, x, y, w, h, out) {
      externalReads++;
      assert.deepEqual([target, x, y, w, h], [activeTarget[0], 0, 0, 640, 360]);
      stampPixels(out);
    },
  };
  const camera = new THREE.PerspectiveCamera(76, 16 / 9, 0.1, 250);
  camera.position.set(1, 1.58, 2);
  camera.lookAt(1, 1.58, 10);
  camera.userData.front = true;
  const ego = { x: 1, z: 2, heading: 0, speed: 8, length: 4.2, width: 1.85, actorId: "not-an-input" };
  const scene = new THREE.Scene();
  const client = createVisualClient({ renderer, onFrame: (frame) => frames.push(frame),
    onResult: (result) => results.push(result) });
  t.after(() => client.dispose());
  return {
    client, tick, frames, requests, results, encodes, uploads, gl, waits, queued, buffers, fences,
    renders, camera, ego, scene, rearTarget, externalPackBuffer,
    setEncodeResult: (value) => { encoderResult = value; },
    capture: (s) => client.capture(scene, camera, ego, s),
    signalFence: () => { gl.waitStatus = gl.CONDITION_SATISFIED; tick(8); },
    syncReads: () => externalReads, activeTarget: () => activeTarget, packBinding: () => boundPackBuffer,
    loseContext: () => { lost = true; surface.dispatchEvent(new Event("webglcontextlost")); },
    restoreContext: () => { lost = false; surface.dispatchEvent(new Event("webglcontextrestored")); },
    glError: (value) => { drawError = value; },
  };
}

test("WebGL2 yields for the fence, then encodes and publishes the original sample in the same callback", (t) => {
  const h = fixture(t);
  h.capture(0);
  assert.equal(h.renders.length, 0);
  h.client.setPreviewEnabled(true);
  h.capture(0.1);
  assert.equal(h.renders[0].camera, h.camera);
  assert.equal(h.renders[0].scene, h.scene);
  assert.equal(h.syncReads(), 0);
  assert.deepEqual(h.activeTarget(), [h.rearTarget, 3, 1]);
  assert.equal(h.packBinding(), h.externalPackBuffer);
  assert.equal(h.fences.size, 1);
  assert.equal(h.waits.length, 0);
  assert.equal(h.encodes.length, 0);
  assert.equal(h.client.latestFrame, null);
  h.tick(8);
  assert.deepEqual(h.waits, [{ flags: 0, timeout: 0 }]);
  assert.equal(h.uploads.length, 0);
  h.capture(0.3);
  assert.equal(h.renders.length, 1, "a busy capture should not queue another GPU transfer");
  h.camera.position.set(99, 9, 99);
  h.camera.lookAt(1, 1, 1);
  h.camera.fov = 40;
  h.ego.speed = 99;
  h.ego.x = 99;
  h.signalFence();
  assert.deepEqual(h.uploads, [[122, 42]], "the front sensor's bottom-up pixels must be flipped exactly once");
  assert.equal(h.fences.size, 0);
  assert.deepEqual(h.encodes, [{ type: "image/jpeg", quality: 0.86 }]);
  const frame = h.client.latestFrame;
  assert.deepEqual(JSON.parse(JSON.stringify(frame)), {
    schema: 1, streamId: h.client.streamId, frameId: 1, simulationTimeS: 0.1,
    camera: { width: 640, height: 360, fovYDeg: 76, position: { x: 1, y: 1.58, z: 2 }, headingRad: 0, groundY: 0.12 },
    ego: { x: 1, z: 2, headingRad: 0, speedMps: 8, lengthM: 4.2, widthM: 1.85 },
    imageJpegBase64: "/9j/2Q==",
  });
  assert.throws(() => { frame.ego.x = 0; }, TypeError);
  assert.equal(h.client.getFrame(h.client.streamId, 1), frame);
  const timing = h.client.timings[0];
  assert.equal(timing.readbackMode, "pbo");
  assert.equal(timing.renderReadbackMs, 16);
  assert.equal(timing.encodeMs, 3, "the encoder time excludes the fence wait and pixel conversion");
  assert.equal(timing.encodedAfterMs, 19);
  h.capture(0.4);
  assert.equal(h.queued[0], h.queued[1], "the next sample must reuse the freed slot");
  h.client.setPreviewEnabled(false);
  assert.equal(h.buffers.size + h.fences.size, 0);
  h.tick(500);
  assert.equal(h.frames.length, 1);
  assert.equal(h.requests.length, 0, "manual preview never touches the model API");
});

test("a non-WebGL2 context keeps the existing synchronous 640x360 JPEG preview", (t) => {
  const h = fixture(t, { webgl2: false });
  h.client.setPreviewEnabled(true);
  h.capture(0);
  assert.equal(h.syncReads(), 1);
  assert.deepEqual(h.uploads, [[122, 42]]);
  assert.deepEqual(h.encodes, [{ type: "image/jpeg", quality: 0.86 }]);
  assert.equal(h.frames[0].imageJpegBase64, "/9j/2Q==");
  assert.equal(h.client.timings[0].readbackMode, "sync");
  assert.equal(h.queued.length + h.waits.length + h.requests.length, 0);
  assert.deepEqual(h.activeTarget(), [h.rearTarget, 3, 1]);
});

test("fence timeout, GL read errors and context loss release the slot without synchronous downgrade", (t) => {
  const h = fixture(t);
  h.client.setPreviewEnabled(true);
  h.capture(0);
  h.tick(251);
  assert.match(h.client.status.error, /fence timed out/);
  assert.equal(h.buffers.size + h.fences.size, 0);
  h.glError(1282);
  h.capture(0.2);
  assert.match(h.client.status.error, /could not queue WebGL camera readback/i);
  assert.equal(h.buffers.size + h.fences.size, 0);
  assert.equal(h.packBinding(), h.externalPackBuffer);
  h.capture(0.4);
  h.loseContext();
  assert.match(h.client.status.error, /context was lost/);
  assert.equal(h.buffers.size + h.fences.size, 0);
  assert.equal(h.syncReads() + h.uploads.length + h.frames.length, 0);
  h.restoreContext();
  h.capture(0.6);
  h.signalFence();
  assert.equal(h.frames[0].frameId, 4);
  assert.equal(h.frames[0].simulationTimeS, 0.6);
});

test("a non-JPEG canvas result never publishes a frame or POSTs to vision", async (t) => {
  const h = fixture(t);
  await h.client.start();
  h.setEncodeResult("data:image/png;base64,fixture");
  h.capture(0);
  h.signalFence();
  assert.match(h.client.status.error, /did not encode a JPEG/);
  assert.equal(h.client.latestFrame, null);
  assert.ok(!h.requests.some(({ url }) => url === "/api/vision/frame"));
  h.setEncodeResult(jpeg);
  h.capture(0.11);
  h.signalFence();
  assert.equal(h.client.latestFrame.frameId, 2);
  assert.equal(h.requests.filter(({ url }) => url === "/api/vision/frame").length, 1);
});

test("reset and disposal revoke pending fences and obsolete POST acknowledgements", async (t) => {
  let acknowledge;
  const h = fixture(t, { respond: ({ url }) => url === "/api/vision/frame"
    ? new Promise((resolve) => { acknowledge = resolve; }) : ready() });
  await h.client.start();
  h.capture(1);
  const original = h.client.streamId;
  h.client.reset();
  assert.equal(h.buffers.size + h.fences.size, 0);
  h.tick(8);
  assert.equal(h.uploads.length, 0);
  assert.equal(h.encodes.length, 0);
  assert.equal(h.frames.length, 0);
  h.capture(0.1);
  h.signalFence();
  const post = h.requests.find(({ url }) => url === "/api/vision/frame");
  const frame = h.client.latestFrame;
  assert.equal(post.options.body, JSON.stringify(frame));
  assert.equal(frame.frameId, 1);
  assert.notEqual(frame.streamId, original);
  h.client.reset();
  assert.equal(post.options.signal.aborted, true);
  assert.equal(h.client.getFrame(frame.streamId, frame.frameId), null);
  h.capture(0);
  acknowledge({ accepted: true, streamId: frame.streamId, frameId: 1 });
  await flush();
  h.capture(0.2);
  assert.equal(h.fences.size, 1);
  assert.equal(h.renders.length, 3, "an old POST completion must not release the next capture");
  h.client.dispose();
  h.tick(500);
  assert.equal(h.buffers.size + h.fences.size, 0);
  assert.equal(h.client.latestFrame, null);
  assert.equal(h.requests.filter(({ url }) => url === "/api/vision/frame").length, 1);
});

test("POST wakes result polling promptly without overlap or regressing to an older or mismatched result", async (t) => {
  let serverResult = null, holdState, block = false;
  const h = fixture(t, { respond: ({ url, options }) => {
    if (url === "/api/vision/start") return ready({ streamId: "retired", frameId: 9 });
    if (url.startsWith("/api/vision/state"))
      return block ? new Promise((resolve) => { holdState = resolve; }) : ready(serverResult);
    const { streamId, frameId } = JSON.parse(options.body);
    return { accepted: true, streamId, frameId };
  } });
  await h.client.start();
  assert.equal(h.client.status.result, null);
  h.tick(0);
  await flush();
  const stateRequests = () => h.requests.filter(({ url }) => url.startsWith("/api/vision/state"));
  const capture = async (s) => {
    h.capture(s);
    h.signalFence();
    await flush();
    const { imageJpegBase64, schema, ...result } = h.client.latestFrame;
    return result;
  };
  const first = await capture(0);
  block = true;
  h.tick(0);
  assert.equal(stateRequests().length, 2, "frame acknowledgement wakes polling before the idle delay");
  assert.equal(stateRequests()[1].options.cache, "no-store");
  const second = await capture(0.11);
  h.tick(50);
  assert.equal(stateRequests().length, 2, "a request in progress must not overlap a replacement GET");
  holdState(ready(first));
  block = false;
  await flush();
  serverResult = { ...second, simulationTimeS: 0 };
  h.tick(35);
  await flush();
  assert.equal(h.client.status.result, null);
  assert.deepEqual(h.results, [first], "a mismatched capture timestamp must never reach control");
  serverResult = second;
  h.tick(35);
  await flush();
  assert.equal(h.client.status.result, second);
  assert.deepEqual(h.results, [first, second]);
  assert.equal(h.client.getResult(h.client.streamId, 1), first);
  serverResult = first;
  h.tick(85);
  await flush();
  assert.equal(h.client.status.result, second);
  serverResult = { ...second, streamId: "retired", frameId: 100 };
  h.tick(85);
  await flush();
  assert.equal(h.client.status.result, null);
  assert.deepEqual(h.results, [first, second]);
  serverResult = second;
  h.tick(751);
  await flush();
  assert.equal(h.client.status.status, "stale");
  assert.equal(h.client.status.result, null);
});
