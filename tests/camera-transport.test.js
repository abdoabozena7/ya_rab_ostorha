import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { createVisualClient } from "../src/integration/bridge.js";

function harness(t, respond = () => ({ available: true, status: "ready", result: null })) {
  const requests = [], frames = [], statuses = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    requests.push({ url, options });
    const data = await respond(url, options);
    return { ok: true, json: async () => data };
  });
  const originalDocument = globalThis.document;
  globalThis.document = {
    createElement() {
      return { getContext: () => ({
        createImageData: (width, height) => ({ data: new Uint8ClampedArray(width * height * 4) }),
        putImageData() {},
      }), toDataURL: () => "data:image/jpeg;base64,dW5pdC10cmFuc3BvcnQtZml4dHVyZQ==" };
    },
  };
  t.after(() => {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  });
  let renders = 0;
  const renderer = {
    getRenderTarget: () => null,
    getViewport: (value) => value.set(0, 0, 1365, 900),
    getScissor: (value) => value.set(0, 0, 1365, 900),
    getScissorTest: () => false,
    setRenderTarget() {}, setScissorTest() {}, setViewport() {}, setScissor() {},
    render() { renders++; },
    readRenderTargetPixels(target, x, y, width, height, pixels) { pixels.fill(127); },
  };
  const camera = new THREE.PerspectiveCamera(76, 16 / 9, 0.1, 250);
  camera.position.set(0, 1.58, 0.72);
  camera.lookAt(0, 1.58, 5);
  camera.updateMatrixWorld();
  const ego = { x: 0, z: 0, heading: 0, speed: 0, length: 4.2, width: 1.85 };
  const client = createVisualClient({ renderer, onFrame: (frame) => frames.push(frame),
    onStatus: (status) => statuses.push(status), onResult() {} });
  t.after(() => client.dispose());
  return { client, requests, frames, statuses, capture: (time) => client.capture(new THREE.Scene(), camera, ego, time),
    renderCount: () => renders };
}

test("raw camera preview stays local and retains only exact immutable current-stream frames", (t) => {
  const h = harness(t);
  h.capture(0);
  assert.equal(h.renderCount(), 0);
  h.client.setPreviewEnabled(true);
  for (let i = 0; i < 15; i++) h.capture(i * 0.11);
  assert.equal(h.renderCount(), 15);
  assert.equal(h.requests.length, 0, "Preview alone must not start or submit to a model");
  assert.equal(h.client.enabled, false);
  assert.equal(h.client.status.available, false);
  assert.equal(h.client.getFrame(h.client.streamId, 1), null);
  const frame = h.frames.at(-1);
  assert.equal(h.client.getFrame(frame.streamId, frame.frameId), frame);
  assert.equal(h.client.getFrame("wrong-stream", frame.frameId), null);
  assert.throws(() => { frame.camera.position.y = -10; }, TypeError);
  assert.equal(frame.camera.width, 640);
  assert.equal(frame.camera.height, 360);
  const previous = h.client.streamId;
  h.client.reset();
  assert.notEqual(h.client.streamId, previous);
  assert.equal(h.client.latestFrame, null);
  assert.equal(h.client.getFrame(previous, frame.frameId), null);
  h.client.setPreviewEnabled(false);
  h.capture(2);
  assert.equal(h.renderCount(), 15);
});

test("explicit model start submits the same cached pixel envelope, and stop revokes it", async (t) => {
  const h = harness(t);
  assert.equal((await h.client.start()).ok, true);
  h.capture(0.1);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const request = h.requests.find(({ url }) => url === "/api/vision/frame");
  assert.ok(request);
  const submitted = JSON.parse(request.options.body);
  assert.equal(request.options.body,
    JSON.stringify(h.client.getFrame(submitted.streamId, submitted.frameId)));
  assert.deepEqual(Object.keys(submitted).sort(), [
    "schema", "streamId", "frameId", "simulationTimeS", "camera", "ego", "imageJpegBase64",
  ].sort());
  const original = submitted.streamId;
  assert.equal((await h.client.stop()).ok, true);
  assert.equal(h.client.enabled, false);
  assert.equal(h.client.status.available, false);
  assert.equal(h.client.status.result, null);
  assert.equal(h.client.getFrame(original, submitted.frameId), null);
  h.capture(0.3);
  assert.equal(h.renderCount(), 1);
});

test("an older asynchronous start cannot re-enable inference after an explicit stop", async (t) => {
  let releaseStart;
  const h = harness(t, (url) => url === "/api/vision/start"
    ? new Promise((resolve) => { releaseStart = resolve; })
    : { available: false, status: "disabled", result: null });
  const start = h.client.start();
  await Promise.resolve();
  assert.equal((await h.client.stop()).ok, true);
  releaseStart({ available: true, status: "ready" });
  assert.equal((await start).ok, false);
  assert.equal(h.client.enabled, false);
  assert.equal(h.client.status.status, "disabled");
});

test("accepted NN results remain exactly pairable while a newer result awaits the next physical step", async (t) => {
  let resultFrame = 1, h;
  h = harness(t, (url) => ({
    available: true, status: "ready",
    result: url.startsWith("/api/vision/state")
      ? { streamId: h.client.streamId, frameId: resultFrame, simulationTimeS: resultFrame / 10 }
      : null,
  }));
  await h.client.start();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const stream = h.client.streamId;
  assert.equal(h.client.getResult(stream, 1).frameId, 1);
  resultFrame = 2;
  const deadline = Date.now() + 1000;
  while (h.client.status.result?.frameId !== 2 && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(h.client.status.result.frameId, 2);
  assert.equal(h.client.getResult(stream, 1).frameId, 1);
  assert.equal(h.client.getResult(stream, 2).frameId, 2);
  assert.equal(h.client.getResult("wrong-stream", 1), null);
  h.client.reset();
  assert.equal(h.client.getResult(stream, 1), null);
  assert.equal(h.client.status.result, null);
});

test("model stop failure is explicit while locally revoking visual evidence", async (t) => {
  const h = harness(t, (url) => {
    if (url === "/api/vision/stop") throw new Error("Owned camera service unreachable");
    return { available: true, status: "ready", result: null };
  });
  await h.client.start();
  const result = await h.client.stop();
  assert.equal(result.ok, false);
  assert.match(result.error, /unreachable/);
  assert.equal(h.client.enabled, false);
  assert.equal(h.client.status.available, false);
  assert.equal(h.client.status.status, "error");
  assert.equal(h.client.status.result, null);
});
