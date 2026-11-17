import test from "node:test";
import assert from "node:assert/strict";
import { mountCameraScreen } from "../src/ui/camera-screen.js";

class Element {
  constructor(tag, document) {
    this.tagName = tag.toUpperCase(); this.document = document; this.children = [];
    this.dataset = {}; this.attributes = new Map(); this.listeners = new Map();
    this.textContent = ""; this.hidden = false; this.disabled = false;
    this.context = { calls: [] };
    for (const method of ["clearRect", "drawImage", "save", "restore", "beginPath", "rect", "clip",
      "setLineDash", "moveTo", "lineTo", "stroke", "strokeRect", "fillRect", "fillText"])
      this.context[method] = (...args) => this.context.calls.push([method, ...args]);
    this.context.measureText = (content) => ({ width: content.length * 7 });
  }
  get lastElementChild() { return this.children.at(-1); }
  append(...children) { for (const child of children) { child.parentNode = this; this.children.push(child); } }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  setAttribute(key, value) { this.attributes.set(key, String(value)); }
  getAttribute(key) { return this.attributes.get(key) ?? null; }
  removeAttribute(key) { this.attributes.delete(key); }
  getContext() { return this.context; }
  addEventListener(type, callback) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(callback);
  }
  removeEventListener(type, callback) { this.listeners.get(type)?.delete(callback); }
  contains(element) { return this === element || this.children.some((child) => child.contains(element)); }
  focus() { this.document.activeElement = this; }
  fire(type, details = {}) {
    if (this.disabled) return;
    const event = { type, target: this, preventDefault() {}, ...details };
    for (let element = this; element; element = element.parentNode)
      for (const listener of element.listeners.get(type) ?? []) listener(event);
  }
  remove() {
    if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((child) => child !== this);
    this.parentNode = null;
  }
}
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function data(streamId = "front-pixels", frameId = 3) {
  const camera = { width: 640, height: 360, fovYDeg: 90,
    position: { x: 0, y: 1.8, z: 0 }, headingRad: 0, groundY: 0.12 };
  const ego = { x: 0, z: 0, headingRad: 0, speedMps: 4, lengthM: 4.2, widthM: 1.85 };
  const frame = { schema: 1, streamId, frameId, simulationTimeS: 1.2, camera, ego, imageJpegBase64: `/9j/${streamId}-${frameId}` };
  const model = { id: "installed-detector", method: "neural-network", provider: "CPU", weightsSha256: null };
  const result = { streamId, frameId, simulationTimeS: 1.2, camera, ego, width: 640, height: 360,
    model, latencyMs: 22.5, status: "ready", detections: [{ box: [344, 150, 368, 210], label: "person", confidence: 0.91 }] };
  const visual = { source: "visual-prediction", streamId, frameId, available: true, status: "ready", ageMs: 0, model,
    tracks: [], forecasts: [] };
  return { frame, result, visual, availability: { source: "camera-pixels", status: "ready", available: true },
    enabled: true, ego: { speedMps: 4 }, applied: { reason: "observed-person-crossing-conflict" } };
}
function fixture(t, action = () => ({ ok: true }), visibilityAction = () => {}, clock = null) {
  const previous = { document: globalThis.document, Image: globalThis.Image,
    performance: globalThis.performance, fetch: globalThis.fetch };
  if (clock) globalThis.performance = { now: () => clock.ms };
  const document = new Element("document"); document.document = document;
  document.createElement = (tag) => new Element(tag, document);
  document.body = document.createElement("body"); document.append(document.body);
  globalThis.document = document;
  const images = [], requests = [];
  globalThis.fetch = async (...args) => {
    requests.push(args);
    throw new Error("Component fixture must not start a model or transport inference");
  };
  globalThis.Image = class {
    constructor() { this.naturalWidth = 640; this.naturalHeight = 360; images.push(this); }
    decode() { return new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject; }); }
  };
  const navigation = document.createElement("nav"), incumbent = document.createElement("button");
  navigation.append(incumbent); document.body.append(navigation);
  const actions = [], visibility = [];
  const screen = mountCameraScreen({ navigation,
    onAction: (name) => { actions.push(name); return action(name); },
    onVisibilityChange: (value) => { visibility.push(value); return visibilityAction(value); } });
  const find = (id, element = document) => element.id === id ? element
    : element.children.map((child) => find(id, child)).find(Boolean);
  t.after(() => {
    screen.dispose();
    for (const [key, value] of Object.entries(previous))
      if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
  });
  return { screen, document, navigation, incumbent, images, actions, requests, visibility, byId: find,
    async finish(index = images.length - 1) { await flush(); images[index].resolve(); await flush(); } };
}

test("opening raw preview never starts a detector, image identity is tagged only after actual draw, and close restores focus", async (t) => {
  const f = fixture(t), state = data();
  state.enabled = false;
  f.screen.update(state);
  f.byId("cameraScreenToggleBtn").fire("click");
  assert.deepEqual(f.actions, []);
  assert.deepEqual(f.visibility, [true]);
  assert.equal(f.byId("cameraRawCanvas").dataset.frameId, undefined);
  await f.finish();
  assert.equal(f.byId("cameraRawCanvas").dataset.frameId, "3");
  assert.equal(f.byId("cameraAnalysisCanvas").dataset.frameId, undefined);
  assert.equal(f.byId("cameraAnalysisCanvas").hidden, true);
  assert.match(f.byId("cameraScreenStatus").textContent, /off.*unanalysed/i);
  f.document.fire("keydown", { key: "Escape" });
  assert.equal(f.byId("cameraScreen").hidden, true);
  assert.equal(f.document.activeElement, f.byId("cameraScreenToggleBtn"));
  assert.deepEqual(f.visibility, [true, false]);
});

test("out-of-order JPEG decodes and advanced raw frames cannot acquire old detection overlays", async (t) => {
  const f = fixture(t), state = data();
  f.screen.update(state);
  f.byId("cameraScreenToggleBtn").fire("click");
  await flush();
  const advanced = { ...state, frame: data("front-pixels", 4).frame };
  f.screen.update(advanced);
  await flush();
  f.images[0].resolve(); await flush();
  assert.equal(f.byId("cameraRawCanvas").dataset.frameId, undefined);
  await f.finish(1);
  assert.equal(f.byId("cameraRawCanvas").dataset.frameId, "4");
  assert.equal(f.byId("cameraAnalysisCanvas").dataset.frameId, undefined);
  assert.match(f.byId("cameraScreenStatus").textContent, /mismatch/i);
  f.screen.update(state);
  await f.finish();
  const raw = f.byId("cameraRawCanvas"), annotated = f.byId("cameraAnalysisCanvas");
  assert.equal(raw.dataset.frameId, "3");
  assert.equal(annotated.dataset.frameId, "3");
  assert.equal(raw.dataset.streamId, annotated.dataset.streamId);
  const rawDraw = raw.context.calls.filter(([method]) => method === "drawImage").at(-1);
  const annotatedDraw = annotated.context.calls.filter(([method]) => method === "drawImage").at(-1);
  assert.equal(rawDraw[1], annotatedDraw[1], "the exact same decoded JPEG object feeds both canvases");
  assert.ok(annotated.context.calls.some(([method]) => method === "strokeRect"));
  assert.match(f.byId("cameraAppliedReason").textContent, /current controller.*observed person crossing conflict/);
  assert.match(f.byId("cameraFrameTiming").textContent, /NN inference 22.5 ms.*transport not separately measured/);
});

test("stale visual evidence clears actual annotations rather than leaving a success-shaped old image", async (t) => {
  const f = fixture(t), state = data();
  f.screen.update(state); f.byId("cameraScreenToggleBtn").fire("click"); await f.finish();
  assert.equal(f.byId("cameraAnalysisCanvas").hidden, false);
  f.screen.update({ ...state, visual: { ...state.visual, ageMs: 751 } });
  assert.equal(f.byId("cameraAnalysisCanvas").hidden, true);
  assert.equal(f.byId("cameraAnalysisCanvas").dataset.frameId, undefined);
  assert.equal(f.byId("cameraRawCanvas").dataset.frameId, "3");
  assert.match(f.byId("cameraRecognition").textContent, /unavailable/i);
});

test("wall-clock expiry with no new result removes overlays even when simulation is paused", async (t) => {
  const f = fixture(t), state = data();
  f.screen.update(state); f.byId("cameraScreenToggleBtn").fire("click"); await f.finish();
  await new Promise((resolve) => setTimeout(resolve, 790));
  assert.equal(f.byId("cameraAnalysisCanvas").hidden, true);
  assert.equal(f.byId("cameraAnalysisCanvas").dataset.frameId, undefined);
  assert.match(f.byId("cameraScreenStatus").textContent, /750 ms.*stale/);
});

test("stop/restart suppresses pending old-stream decodes and requires a newly acknowledged live frame", async (t) => {
  const resolvers = {};
  const f = fixture(t, (action) => new Promise((resolve) => { resolvers[action] = resolve; }));
  const first = data();
  f.screen.update(first); f.byId("cameraScreenToggleBtn").fire("click"); await flush();
  f.byId("cameraPerceptionStopBtn").fire("click");
  await flush();
  f.images[0].resolve(); await flush();
  assert.equal(f.byId("cameraAnalysisCanvas").dataset.frameId, undefined);
  const stopped = { ...first, enabled: false, result: null, visual: null,
    availability: { source: "camera-pixels", status: "disabled" } };
  f.screen.update(stopped);
  resolvers.stop({ ok: true }); await flush();
  f.byId("cameraPerceptionStartBtn").fire("click"); await flush();
  const next = data("new-pixel-stream", 1);
  f.screen.update(next); await f.finish();
  assert.equal(f.byId("cameraAnalysisCanvas").dataset.frameId, undefined);
  resolvers.start({ ok: true }); await flush();
  assert.equal(f.byId("cameraRawCanvas").dataset.streamId, next.frame.streamId);
  assert.equal(f.byId("cameraAnalysisCanvas").dataset.streamId, next.frame.streamId);
  assert.deepEqual(f.actions, ["stop", "start"]);
});

test("decode failure is explicit and retryable; async action errors and disposal preserve incumbent controls", async (t) => {
  const f = fixture(t, async () => { throw new Error("Installed detector unavailable"); });
  const state = { ...data(), enabled: false };
  f.screen.update(state); f.byId("cameraScreenToggleBtn").fire("click"); await flush();
  f.images[0].reject(new Error("Broken JPEG")); await flush();
  assert.match(f.byId("cameraScreenError").textContent, /Broken JPEG/);
  assert.equal(f.byId("cameraRawCanvas").dataset.frameId, undefined);
  const attempts = f.images.length;
  f.screen.update(state); await flush();
  assert.equal(f.images.length, attempts, "a failed JPEG is retried only after reopen or a new frame");
  f.byId("cameraPerceptionStartBtn").fire("click"); await flush();
  assert.match(f.byId("cameraScreenError").textContent, /Installed detector unavailable/);
  assert.equal(f.byId("cameraPerceptionStartBtn").disabled, false);
  const toggle = f.byId("cameraScreenToggleBtn"), count = f.actions.length;
  f.screen.dispose(); f.screen.dispose();
  toggle.fire("click");
  assert.equal(f.byId("cameraScreen"), undefined);
  assert.equal(f.navigation.children[0], f.incumbent);
  assert.equal(f.actions.length, count);
});

test("a failed disabled model start is explicitly unavailable with a usable retry and an above-image alert", async (t) => {
  const f = fixture(t, async () => ({ ok: false, error: "Installed weights are missing" }));
  const state = { ...data(), enabled: false, result: null, visual: null,
    availability: { source: "camera-pixels", status: "error", available: false, error: "Installed weights are missing" } };
  f.screen.update(state); f.byId("cameraScreenToggleBtn").fire("click"); await f.finish();
  assert.match(f.byId("cameraScreenStatus").textContent, /unavailable.*weights are missing.*Retry/);
  assert.equal(f.byId("cameraPerceptionStartBtn").textContent, "Retry detector");
  assert.equal(f.byId("cameraPerceptionStartBtn").disabled, false);
  f.byId("cameraPerceptionStartBtn").fire("click"); await flush();
  assert.equal(f.byId("cameraScreenError").hidden, false);
  const children = f.byId("cameraScreen").children;
  assert.ok(children.indexOf(f.byId("cameraScreenError")) < children.findIndex((element) =>
    element.className === "camera-screen-images"), "errors remain above large images even in compact view");
});

test("close/reopen invalidates an in-flight decode and failed display recovery stays visible for retry", async (t) => {
  let rejectClose = true;
  const f = fixture(t, () => ({ ok: true }), async (visible) => {
    if (!visible && rejectClose) throw new Error("Vehicle view change failed");
  });
  f.screen.update(data()); f.byId("cameraScreenToggleBtn").fire("click"); await flush();
  f.byId("cameraScreenCloseBtn").fire("click"); await flush();
  assert.equal(f.byId("cameraScreen").hidden, false, "failed recovery must remain visible");
  assert.match(f.byId("cameraScreenError").textContent, /Vehicle view change failed/);
  f.images[0].resolve(); await flush();
  assert.equal(f.byId("cameraRawCanvas").dataset.frameId, undefined);
  await f.finish();
  assert.equal(f.byId("cameraAnalysisCanvas").dataset.frameId, "3");
  rejectClose = false;
  f.byId("cameraScreenCloseBtn").fire("click"); await flush();
  assert.equal(f.byId("cameraScreen").hidden, true);
  f.byId("cameraScreenToggleBtn").fire("click"); await f.finish();
  assert.equal(f.byId("cameraAnalysisCanvas").dataset.frameId, "3");
});

function streamData(frameId, simulationTimeS = 2, streamId = "continuous-pixels") {
  const state = data(streamId, frameId);
  state.frame.simulationTimeS = state.result.simulationTimeS = simulationTimeS;
  state.result.latencyMs = 20 + frameId / 2;
  state.result.detections[0] = {
    label: frameId % 2 ? "person" : "vehicle", confidence: frameId % 2 ? 0.91 : 0.63,
    box: [340 + frameId % 7, 150, 370 + frameId % 7, 210],
  };
  const track = {
    source: "camera-pixels", id: `pixel-track-${frameId}`, streamId, frameId, label: "person",
    confidence: 0.91, firstSeenS: simulationTimeS - 0.2, lastSeenS: simulationTimeS,
    spanS: 0.2, observations: 3, ageMs: 0, reliable: true,
    position: { x: -2, z: 10 }, velocity: { x: 1, z: 0 },
    uncertaintyM: 0.12, velocityUncertaintyMps: 0.08,
    history: [simulationTimeS - 0.2, simulationTimeS - 0.1, simulationTimeS].map((time, i) => ({
      frameId: frameId - 2 + i, simulationTimeS: time, position: { x: -2.2 + i * 0.1, z: 10 },
    })),
  };
  state.visual.tracks = [track];
  state.visual.forecasts = [{ trackId: track.id, reason: "observed-person-crossing-conflict" }];
  return state;
}

function assertCompleteFrame(f, state) {
  const raw = f.byId("cameraRawCanvas"), analysis = f.byId("cameraAnalysisCanvas");
  assert.equal(raw.hidden, false);
  assert.equal(analysis.hidden, false);
  for (const canvas of [raw, analysis]) {
    assert.equal(canvas.dataset.frameId, String(state.frame.frameId));
    assert.equal(canvas.dataset.streamId, state.frame.streamId);
    const draw = canvas.context.calls.filter(([method]) => method === "drawImage").at(-1);
    assert.equal(draw[1].src, `data:image/jpeg;base64,${state.frame.imageJpegBase64}`);
  }
  assert.match(f.byId("cameraFrameIdentity").textContent, new RegExp(`frame #${state.frame.frameId} ·`));
  assert.ok(f.byId("cameraFrameTiming").textContent.includes(`NN inference ${state.result.latencyMs.toFixed(1)} ms`));
  assert.ok(f.byId("cameraDetectionList").children[0].textContent.startsWith(state.result.detections[0].label));
  assert.ok(f.byId("cameraMotionList").children[0].textContent.includes(state.visual.tracks[0].id));
  assert.deepEqual(analysis.context.calls.filter(([method]) => method === "strokeRect").at(-1).slice(1),
    [state.result.detections[0].box[0], 150, 30, 60]);
}

test("pending valid JPEG keeps a complete pair and its own metadata until all new pixels and overlays commit", async (t) => {
  const clock = { ms: 0 }, f = fixture(t, undefined, undefined, clock), first = streamData(3);
  f.screen.update(first); f.byId("cameraScreenToggleBtn").fire("click"); await f.finish();
  assertCompleteFrame(f, first);
  const next = streamData(4, 2.1);
  clock.ms = 100;
  f.screen.update(next); await flush();
  assertCompleteFrame(f, first);
  const beforeCommit = [];
  const context = f.byId("cameraAnalysisCanvas").context, stroke = context.strokeRect;
  context.strokeRect = (...args) => {
    beforeCommit.push(f.byId("cameraFrameIdentity").textContent);
    stroke(...args);
  };
  clock.ms = 135;
  await f.finish();
  assert.ok(beforeCommit.length);
  assert.ok(beforeCommit.every((value) => value.includes("frame #3 ·")),
    "new frame-bound metadata must not publish before its image and overlays finish drawing");
  assertCompleteFrame(f, next);
  assert.doesNotMatch(f.byId("cameraScreenStatus").textContent, /decoding/i);
});

test("five simulated seconds of 8-10Hz asynchronous NN arrivals keep every ready rendered sample coherent", async (t) => {
  const clock = { ms: 0 }, f = fixture(t, undefined, undefined, clock);
  let state = streamData(3), sourceAt = 0, nextSourceAt = 100, sourceFrames = 1;
  let completedFrames = 1, hiddenSamples = 0, mismatchedSamples = 0, samples = 0, pendingSamples = 0;
  const queued = [];
  f.screen.update(state); f.byId("cameraScreenToggleBtn").fire("click"); await f.finish();
  const sample = () => {
    samples++;
    const raw = f.byId("cameraRawCanvas"), analysis = f.byId("cameraAnalysisCanvas");
    if (raw.hidden || analysis.hidden) { hiddenSamples++; return; }
    const frameId = analysis.dataset.frameId;
    const draw = analysis.context.calls.filter(([method]) => method === "drawImage").at(-1);
    if (raw.dataset.frameId !== frameId || raw.dataset.streamId !== analysis.dataset.streamId ||
        !f.byId("cameraFrameIdentity").textContent.includes(`frame #${frameId} ·`) ||
        draw?.[1].src !== `data:image/jpeg;base64,/9j/continuous-pixels-${frameId}` ||
        !f.byId("cameraMotionList").children[0]?.textContent.includes(`pixel-track-${frameId} ·`))
      mismatchedSamples++;
  };
  for (let tick = 1; tick <= 600; tick++) {
    clock.ms = tick * 1000 / 120;
    if (clock.ms + 1e-8 >= nextSourceAt) {
      sourceAt = nextSourceAt;
      state = streamData(3 + sourceFrames, 2 + sourceAt / 1000);
      sourceFrames++;
      nextSourceAt += sourceFrames % 2 ? 100 : 125;
      f.screen.update(state); await flush();
      queued.push({ at: sourceAt + 17 + sourceFrames % 4 * 11, image: f.images.length - 1 });
    }
    state = { ...state, visual: { ...state.visual, ageMs: clock.ms - sourceAt } };
    f.screen.update(state); await flush();
    if (queued.length) pendingSamples++;
    sample();
    while (queued.length && queued[0].at <= clock.ms) {
      await f.finish(queued.shift().image);
      completedFrames++;
      sample();
    }
  }
  t.diagnostic(JSON.stringify({ simulatedSeconds: 5, renderedHz: 120, sourceFrames,
    completedFrames, samples, pendingSamples, hiddenSamples, mismatchedSamples }));
  assert.ok(sourceFrames >= 40 && completedFrames >= 40 && pendingSamples >= 100,
    "exercise a sustained 8-10Hz stream with actual deferred product decode callbacks, not one transition");
  assert.equal(hiddenSamples, 0, "ordinary fresh decoding must not blank completed paired evidence");
  assert.equal(mismatchedSamples, 0, "pixels, stream/frame IDs and visible evidence must remain one committed bundle");
});

test("new arrivals cannot renew the previous complete pair's original wall deadline", async (t) => {
  const clock = { ms: 0 }, f = fixture(t, undefined, undefined, clock), first = streamData(3);
  f.screen.update(first); f.byId("cameraScreenToggleBtn").fire("click"); await f.finish();
  let next;
  for (let i = 1; i <= 7; i++) {
    clock.ms = i * 100;
    next = streamData(3 + i);
    f.screen.update(next); await flush();
  }
  clock.ms = 749; f.screen.update(next);
  assertCompleteFrame(f, first);
  clock.ms = 750; f.screen.update(next);
  assert.equal(f.byId("cameraAnalysisCanvas").hidden, true);
  assert.equal(f.byId("cameraAnalysisCanvas").dataset.frameId, undefined);
  assert.match(f.byId("cameraRecognition").textContent, /unavailable/i);
  assert.doesNotMatch(f.byId("cameraFrameIdentity").textContent, /frame #3 ·/);
  clock.ms = 765;
  await f.finish();
  assertCompleteFrame(f, next);
});

test("the retained pair expires by its own simulation age even when a pending newer result is fresh", async (t) => {
  const clock = { ms: 0 }, f = fixture(t, undefined, undefined, clock), first = streamData(3);
  first.visual.ageMs = 700;
  f.screen.update(first); f.byId("cameraScreenToggleBtn").fire("click"); await f.finish();
  clock.ms = 40;
  f.screen.update(streamData(4, 2.74)); await flush();
  assertCompleteFrame(f, first);
  assert.match(f.byId("cameraFrameTiming").textContent, /simulation age 740 ms/);
  clock.ms = 51;
  f.screen.update(streamData(5, 2.751)); await flush();
  assert.equal(f.byId("cameraAnalysisCanvas").hidden, true);
  assert.equal(f.byId("cameraAnalysisCanvas").dataset.frameId, undefined);
  assert.match(f.byId("cameraRecognition").textContent, /unavailable/i);
});

test("a decode completing after its original deadline cannot publish a stale success without another update", async (t) => {
  const clock = { ms: 0 }, f = fixture(t, undefined, undefined, clock);
  f.screen.update(streamData(3)); f.byId("cameraScreenToggleBtn").fire("click"); await flush();
  assert.doesNotMatch(f.byId("cameraFrameIdentity").textContent, /frame #3 ·/,
    "unpainted metadata must not identify an analysed image");
  clock.ms = 751;
  await f.finish();
  assert.equal(f.byId("cameraAnalysisCanvas").hidden, true);
  assert.equal(f.byId("cameraAnalysisCanvas").dataset.frameId, undefined);
  assert.match(f.byId("cameraScreenStatus").textContent, /stale|750 ms/i);
});

test("a mismatched source or service fault revokes the retained pair immediately while a next decode is pending", async (t) => {
  const clock = { ms: 0 }, f = fixture(t, undefined, undefined, clock), first = streamData(3);
  f.screen.update(first); f.byId("cameraScreenToggleBtn").fire("click"); await f.finish();
  clock.ms = 100;
  const next = streamData(4, 2.1);
  f.screen.update(next); await flush();
  assertCompleteFrame(f, first);
  f.screen.update({ ...next, availability: { source: "camera-pixels", status: "error", error: "Worker lost" } });
  assert.equal(f.byId("cameraAnalysisCanvas").hidden, true);
  assert.equal(f.byId("cameraAnalysisCanvas").dataset.frameId, undefined);
  assert.match(f.byId("cameraRecognition").textContent, /unavailable/i);
  await f.finish();
  assert.equal(f.byId("cameraAnalysisCanvas").hidden, true, "late decode cannot revive evidence after a real fault");
  f.screen.update(first); await f.finish();
  f.screen.update(next); await flush();
  f.screen.update({ ...next, result: first.result });
  assert.equal(f.byId("cameraAnalysisCanvas").hidden, true);
  assert.equal(f.byId("cameraAnalysisCanvas").dataset.frameId, undefined);
  assert.match(f.byId("cameraScreenStatus").textContent, /mismatch/i);
});

test("stream restart never retains a previous stream's complete pair or late decoder", async (t) => {
  const clock = { ms: 0 }, f = fixture(t, undefined, undefined, clock);
  f.screen.update(streamData(3)); f.byId("cameraScreenToggleBtn").fire("click"); await f.finish();
  clock.ms = 100;
  f.screen.update(streamData(4, 2.1)); await flush();
  const oldPending = f.images.length - 1;
  const restarted = streamData(3, 0.2, "restarted-pixels");
  f.screen.update(restarted); await flush();
  assert.equal(f.byId("cameraAnalysisCanvas").hidden, true);
  assert.equal(f.byId("cameraAnalysisCanvas").dataset.streamId, undefined);
  await f.finish(oldPending);
  assert.equal(f.byId("cameraAnalysisCanvas").dataset.streamId, undefined);
  await f.finish();
  assertCompleteFrame(f, restarted);
});

test("real stale evidence immediately revokes the retained pair and a pending decode cannot restore it", async (t) => {
  const clock = { ms: 0 }, f = fixture(t, undefined, undefined, clock), first = streamData(3);
  f.screen.update(first); f.byId("cameraScreenToggleBtn").fire("click"); await f.finish();
  clock.ms = 100;
  const next = streamData(4, 2.1);
  f.screen.update(next); await flush();
  assertCompleteFrame(f, first);
  f.screen.update({ ...next, visual: { ...next.visual, ageMs: 751 } });
  assert.equal(f.byId("cameraAnalysisCanvas").hidden, true);
  assert.equal(f.byId("cameraAnalysisCanvas").dataset.frameId, undefined);
  assert.match(f.byId("cameraRecognition").textContent, /unavailable/i);
  await f.finish();
  assert.equal(f.byId("cameraAnalysisCanvas").hidden, true);
  assert.match(f.byId("cameraScreenStatus").textContent, /stale/i);
});

test("explicit stop invalidates an already committed pair and the next pending decoder together", async (t) => {
  const clock = { ms: 0 }, f = fixture(t, undefined, undefined, clock), first = streamData(3);
  f.screen.update(first); f.byId("cameraScreenToggleBtn").fire("click"); await f.finish();
  clock.ms = 100;
  f.screen.update(streamData(4, 2.1)); await flush();
  const obsolete = f.images.length - 1;
  assertCompleteFrame(f, first);
  f.byId("cameraPerceptionStopBtn").fire("click"); await flush();
  assert.equal(f.byId("cameraAnalysisCanvas").hidden, true);
  assert.equal(f.byId("cameraAnalysisCanvas").dataset.frameId, undefined);
  await f.finish(obsolete);
  assert.equal(f.byId("cameraAnalysisCanvas").hidden, true);
  assert.doesNotMatch(f.byId("cameraFrameIdentity").textContent, /frame #3 ·/);
});

function rawStreamData(frameId, simulationTimeS = 2, streamId = "raw-only-pixels") {
  const state = streamData(frameId, simulationTimeS, streamId);
  return { ...state, enabled: false, result: null, visual: null,
    availability: { source: "camera-pixels", status: "disabled", available: false },
    applied: { reason: "manual-drive" } };
}

function assertUnanalysedRaw(f, state) {
  const raw = f.byId("cameraRawCanvas"), analysis = f.byId("cameraAnalysisCanvas");
  assert.equal(raw.hidden, false);
  assert.equal(raw.dataset.frameId, String(state.frame.frameId));
  assert.equal(raw.dataset.streamId, state.frame.streamId);
  const draw = raw.context.calls.filter(([method]) => method === "drawImage").at(-1);
  assert.equal(draw[1].src, `data:image/jpeg;base64,${state.frame.imageJpegBase64}`);
  assert.ok(f.byId("cameraFrameIdentity").textContent.includes(`frame #${state.frame.frameId} ·`));
  assert.match(f.byId("cameraFrameIdentity").textContent, /unanalysed/);
  assert.doesNotMatch(f.byId("cameraFrameIdentity").textContent, /installed-detector|neural-network|CPU/);
  assert.match(f.byId("cameraFrameTiming").textContent, /^Inference unavailable/);
  assert.match(f.byId("cameraRecognition").textContent, /Recognition and future motion are unavailable/);
  assert.equal(analysis.hidden, true);
  assert.equal(analysis.dataset.frameId, undefined);
  assert.equal(analysis.dataset.streamId, undefined);
  assert.equal(analysis.context.calls.filter(([method]) => method === "drawImage" || method === "strokeRect").length, 0);
  assert.deepEqual(f.actions, []);
  assert.deepEqual(f.requests, []);
}

test("raw successor decode retains completed unanalysed pixels and publishes its own metadata only after draw", async (t) => {
  const clock = { ms: 0 }, f = fixture(t, undefined, undefined, clock), first = rawStreamData(3);
  f.screen.update(first); f.byId("cameraScreenToggleBtn").fire("click"); await f.finish();
  assertUnanalysedRaw(f, first);
  const next = rawStreamData(4, 2.1);
  clock.ms = 100;
  f.screen.update(next); await flush();
  assertUnanalysedRaw(f, first);
  const duringDraw = [];
  const context = f.byId("cameraRawCanvas").context, draw = context.drawImage;
  context.drawImage = (...args) => {
    duringDraw.push(f.byId("cameraFrameIdentity").textContent);
    draw(...args);
  };
  clock.ms = 135;
  await f.finish();
  assert.ok(duringDraw.length);
  assert.ok(duringDraw.every((value) => value.includes("frame #3 ·")),
    "successor raw identity must not publish before its actual JPEG is drawn");
  assertUnanalysedRaw(f, next);
});

test("five raw simulated seconds at 8-10Hz have no hidden completed preview, analysis or inference requests", async (t) => {
  const clock = { ms: 0 }, f = fixture(t, undefined, undefined, clock);
  let state = rawStreamData(3), nextSourceAt = 100, sourceFrames = 1, completedFrames = 1;
  let samples = 0, pendingSamples = 0, hiddenSamples = 0, mismatchedSamples = 0, analysisSamples = 0, modelLeaks = 0;
  const queued = [];
  f.screen.update(state); f.byId("cameraScreenToggleBtn").fire("click"); await f.finish();
  const sample = () => {
    samples++;
    const raw = f.byId("cameraRawCanvas"), analysis = f.byId("cameraAnalysisCanvas");
    if (raw.hidden) hiddenSamples++;
    else {
      const frameId = raw.dataset.frameId;
      const draw = raw.context.calls.filter(([method]) => method === "drawImage").at(-1);
      if (raw.dataset.streamId !== state.frame.streamId ||
          !f.byId("cameraFrameIdentity").textContent.includes(`frame #${frameId} ·`) ||
          draw?.[1].src !== `data:image/jpeg;base64,/9j/raw-only-pixels-${frameId}`)
        mismatchedSamples++;
    }
    if (!analysis.hidden || analysis.dataset.frameId || analysis.dataset.streamId) analysisSamples++;
    if (/installed-detector|neural-network/.test(f.byId("cameraFrameIdentity").textContent) ||
        /NN inference/.test(f.byId("cameraFrameTiming").textContent) ||
        /score \d/.test(f.byId("cameraDetectionList").children[0]?.textContent ?? "") ||
        /pixel-track-|constant-velocity/.test(f.byId("cameraMotionList").children[0]?.textContent ?? ""))
      modelLeaks++;
  };
  for (let tick = 1; tick <= 600; tick++) {
    clock.ms = tick * 1000 / 120;
    if (clock.ms + 1e-8 >= nextSourceAt) {
      const sourceAt = nextSourceAt;
      state = rawStreamData(3 + sourceFrames, 2 + sourceAt / 1000);
      sourceFrames++;
      nextSourceAt += sourceFrames % 2 ? 100 : 125;
      f.screen.update(state); await flush();
      queued.push({ at: sourceAt + 17 + sourceFrames % 4 * 11, image: f.images.length - 1 });
    }
    f.screen.update(state); await flush();
    if (queued.length) pendingSamples++;
    sample();
    while (queued.length && queued[0].at <= clock.ms) {
      await f.finish(queued.shift().image);
      completedFrames++;
      sample();
    }
  }
  t.diagnostic(JSON.stringify({ mode: "detector-OFF component simulation", simulatedSeconds: 5, renderedHz: 120,
    sourceFrames, completedFrames, samples, pendingSamples, hiddenSamples, mismatchedSamples,
    analysisSamples, modelLeaks, inferenceRequests: f.requests.length, modelActions: f.actions.length }));
  assert.ok(sourceFrames >= 40 && completedFrames >= 40 && pendingSamples >= 100);
  assert.equal(hiddenSamples, 0, "ordinary unanalysed raw successors must not blank the completed source image");
  assert.equal(mismatchedSamples, 0, "raw pixels and raw frame-bound metadata must commit together");
  assert.equal(analysisSamples, 0);
  assert.equal(modelLeaks, 0);
  assert.deepEqual(f.requests, []);
  assert.deepEqual(f.actions, []);
  assertUnanalysedRaw(f, state);
});

test("raw stream reset drops the previous preview and rejects a pending obsolete decoder", async (t) => {
  const clock = { ms: 0 }, f = fixture(t, undefined, undefined, clock), first = rawStreamData(3);
  f.screen.update(first); f.byId("cameraScreenToggleBtn").fire("click"); await f.finish();
  clock.ms = 100;
  f.screen.update(rawStreamData(4, 2.1)); await flush();
  assertUnanalysedRaw(f, first);
  const obsolete = f.images.length - 1;
  const next = rawStreamData(3, 0.2, "reset-raw-pixels");
  f.screen.update(next); await flush();
  assert.equal(f.byId("cameraRawCanvas").hidden, true);
  assert.equal(f.byId("cameraRawCanvas").dataset.streamId, undefined);
  assert.doesNotMatch(f.byId("cameraFrameIdentity").textContent, /raw-only-pixels/);
  await f.finish(obsolete);
  assert.equal(f.byId("cameraRawCanvas").dataset.streamId, undefined);
  await f.finish();
  assertUnanalysedRaw(f, next);
});

test("raw decode failure and invalid JPEG clear completed preview rather than retaining a misleading success", async (t) => {
  const clock = { ms: 0 }, f = fixture(t, undefined, undefined, clock), first = rawStreamData(3);
  f.screen.update(first); f.byId("cameraScreenToggleBtn").fire("click"); await f.finish();
  clock.ms = 100;
  f.screen.update(rawStreamData(4, 2.1)); await flush();
  assertUnanalysedRaw(f, first);
  f.images.at(-1).reject(new Error("Raw JPEG failed to decode")); await flush();
  assert.equal(f.byId("cameraRawCanvas").hidden, true);
  assert.equal(f.byId("cameraRawCanvas").dataset.frameId, undefined);
  assert.match(f.byId("cameraScreenError").textContent, /Raw JPEG failed/);
  assert.doesNotMatch(f.byId("cameraFrameIdentity").textContent, /frame #3 ·/);
  const valid = rawStreamData(5, 2.2);
  f.screen.update(valid); await f.finish();
  assertUnanalysedRaw(f, valid);
  assert.equal(f.byId("cameraScreenError").hidden, true);
  const invalid = rawStreamData(6, 2.3);
  invalid.frame.imageJpegBase64 = "";
  f.screen.update(invalid);
  assert.equal(f.byId("cameraRawCanvas").hidden, true);
  assert.equal(f.byId("cameraRawCanvas").dataset.frameId, undefined);
  assert.match(f.byId("cameraFrameIdentity").textContent, /unavailable/);
  assert.equal(f.byId("cameraAnalysisCanvas").hidden, true);
});

test("turning the detector OFF never retains completed NN overlays or model metadata as raw evidence", async (t) => {
  const clock = { ms: 0 }, f = fixture(t, undefined, undefined, clock), analysed = streamData(3);
  f.screen.update(analysed); f.byId("cameraScreenToggleBtn").fire("click"); await f.finish();
  assertCompleteFrame(f, analysed);
  const analysis = f.byId("cameraAnalysisCanvas");
  const priorDraws = analysis.context.calls.filter(([method]) => method === "drawImage" || method === "strokeRect").length;
  const off = { ...analysed, enabled: false,
    availability: { source: "camera-pixels", status: "disabled", available: false } };
  f.screen.update(off); await flush();
  assert.equal(analysis.hidden, true);
  assert.equal(analysis.dataset.frameId, undefined);
  assert.doesNotMatch(f.byId("cameraFrameIdentity").textContent, /installed-detector|neural-network/);
  await f.finish();
  assert.equal(f.byId("cameraRawCanvas").hidden, false);
  assert.match(f.byId("cameraFrameIdentity").textContent, /unanalysed/);
  assert.doesNotMatch(f.byId("cameraFrameIdentity").textContent, /installed-detector|neural-network/);
  assert.match(f.byId("cameraFrameTiming").textContent, /^Inference unavailable/);
  assert.equal(analysis.hidden, true);
  assert.equal(analysis.context.calls.filter(([method]) => method === "drawImage" || method === "strokeRect").length, priorDraws);
  assert.deepEqual(f.requests, []);
  assert.deepEqual(f.actions, []);
});
