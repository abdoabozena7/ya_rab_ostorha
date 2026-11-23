import test from "node:test";
import assert from "node:assert/strict";
import { cameraFrameKey, pairCameraEvidence, projectCameraPoint, projectPixelTrack } from "../src/ui/camera-evidence.js";
import { pedestrianForecasts } from "../src/ui/city-perception.js";
import { VisualCrossingPredictor } from "../src/core/visual-prediction.js";

function fixture() {
  const camera = {
    width: 640, height: 360, fovYDeg: 90,
    position: { x: 0, y: 1.8, z: 0 }, headingRad: 0, groundY: 0.12,
  };
  const ego = { x: 0, z: 0, headingRad: 0, speedMps: 4, lengthM: 4.2, widthM: 1.85 };
  const frame = {
    schema: 1, streamId: "pixels-only", frameId: 3, simulationTimeS: 1.2,
    camera, ego, imageJpegBase64: "/9j/actual-encoded-image-is-decoded-by-the-view",
  };
  const result = {
    streamId: frame.streamId, frameId: frame.frameId, simulationTimeS: frame.simulationTimeS,
    camera: structuredClone(camera), ego: { ...ego }, width: 640, height: 360,
    status: "ready", latencyMs: 21.5,
    model: { id: "installed-detector", method: "neural-network", provider: "CPU", weightsSha256: null },
    detections: [{ label: "person", confidence: 0.91, box: [344, 150, 368, 210.24] }],
  };
  const track = {
    id: "visual-1", source: "camera-pixels", streamId: frame.streamId, frameId: 3,
    label: "person", confidence: 0.91, lastSeenS: 1.2, firstSeenS: 1,
    observations: 3, spanS: 0.2, ageMs: 0, reliable: true,
    position: { x: -2, z: 10 }, velocity: { x: 1, z: 0 },
    uncertaintyM: 0.12, velocityUncertaintyMps: 0.08,
    history: [1, 2, 3].map((frameId, i) => ({
      frameId, simulationTimeS: 1 + i * 0.1, position: { x: -2.2 + i * 0.1, z: 10 },
    })),
  };
  const visual = {
    source: "visual-prediction", streamId: frame.streamId, frameId: 3,
    available: true, status: "ready", ageMs: 0, model: { ...result.model },
    tracks: [track], forecasts: [{ trackId: track.id, reason: "observed-person-crossing-conflict" }],
  };
  return { frame, result, visual, enabled: true, availability: { source: "camera-pixels", status: "ready", available: true } };
}
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-7, `${a} differs from ${b}`);

test("exact retained JPEG evidence requires matching stream, frame, time, calibration and captured odometry", () => {
  const f = fixture();
  const good = pairCameraEvidence(f);
  assert.equal(good.canAnalyze, true);
  assert.equal(good.frame, f.frame);
  assert.equal(good.result, f.result);
  assert.equal(cameraFrameKey(f.frame), cameraFrameKey(f.result));
  for (const change of [
    (value) => { value.frame.streamId = "restarted-stream"; },
    (value) => { value.frame.frameId++; },
    (value) => { value.frame.simulationTimeS += 0.1; },
    (value) => { value.result.camera.headingRad += Math.PI; },
    (value) => { value.result.camera.position.x += 0.1; },
    (value) => { value.result.camera.fovYDeg = 80; },
    (value) => { value.result.ego.x = 2; },
  ]) {
    const wrong = fixture();
    change(wrong);
    const pair = pairCameraEvidence(wrong);
    assert.equal(pair.canAnalyze, false);
    assert.equal(pair.status, "mismatch");
    assert.equal(pair.motionAvailable, false);
  }
});

test("off, missing, source mismatch, service faults and stale evidence never authorize an overlay", () => {
  for (const [status, mutate] of [
    ["off", (f) => { f.enabled = false; }],
    ["starting", (f) => { f.availability.status = "loading"; }],
    ["unavailable", (f) => { f.availability.available = false; }],
    ["unavailable", (f) => { f.frame = null; }],
    ["unavailable", (f) => { f.frame.imageJpegBase64 = ""; }],
    ["waiting", (f) => { f.result = null; }],
    ["mismatch", (f) => { f.availability.source = "world-actors"; }],
    ["mismatch", (f) => { f.visual.source = "committed-scenario-motion"; }],
    ["mismatch", (f) => { f.visual.frameId--; }],
    ["mismatch", (f) => { f.visual.model.id = "different-model"; }],
    ["stale", (f) => { f.availability.status = "stale"; }],
    ["stale", (f) => { f.visual.ageMs = 751; }],
    ["stale", (f) => { f.visual.ageMs = null; }],
    ["error", (f) => { f.availability.error = "Worker disconnected"; }],
    ["error", (f) => { f.enabled = false; f.availability = { status: "error", error: "Model start failed" }; }],
    ["unavailable", (f) => { f.enabled = false; f.availability.status = "unavailable"; }],
    ["starting", (f) => { f.enabled = false; f.availability.status = "loading"; }],
    ["error", (f) => { f.result.actors = [{ future: "forbidden" }]; }],
  ]) {
    const f = fixture();
    mutate(f);
    const pair = pairCameraEvidence(f);
    assert.equal(pair.status, status);
    assert.equal(pair.canAnalyze, false);
    assert.equal(pair.motionAvailable, false);
    assert.match(pair.reason, /unavailable|mismatch|does not match|stale|off|raw|stopped|starting|invalid/i);
  }
});

test("an exact detector frame may show boxes without inventing motion or a transport time", () => {
  const f = fixture();
  f.visual = null;
  const pair = pairCameraEvidence(f);
  assert.equal(pair.canAnalyze, true);
  assert.equal(pair.motionAvailable, false);
  assert.equal(pair.ageMs, null);
  assert.equal(projectPixelTrack(fixture().visual.tracks[0], pair), null);
});

test("ground-plane projection uses actual image-right minus X, camera heading and front clipping", () => {
  const { camera } = fixture().frame;
  const center = projectCameraPoint({ x: 0, z: 10 }, camera);
  near(center[0], 320);
  near(center[1], 210.24);
  near(projectCameraPoint({ x: -2, z: 10 }, camera)[0], 356);
  near(projectCameraPoint({ x: 2, z: 10 }, camera)[0], 284);
  const turned = { ...camera, headingRad: Math.PI / 2, position: { x: 5, y: 1.8, z: -7 } };
  near(projectCameraPoint({ x: 15, z: -5 }, turned)[0], 356);
  near(projectCameraPoint({ x: 15, z: -9 }, turned)[0], 284);
  assert.equal(projectCameraPoint({ x: 0, z: -1 }, camera), null);
  assert.equal(projectCameraPoint({ x: NaN, z: 1 }, camera), null);
  assert.equal(projectCameraPoint({ x: 0, z: 10 }, { ...camera, fovYDeg: 0 }), null);
});

test("solid history is observed, future is fitted velocity only and the display horizon is bounded", () => {
  const f = fixture(), pair = pairCameraEvidence(f);
  const path = projectPixelTrack(f.visual.tracks[0], pair, { horizonS: 99 });
  assert.equal(path.observed.length, 3);
  near(path.observed[0][0], 359.6);
  near(path.observed.at(-1)[0], 356);
  assert.equal(path.horizonS, 3);
  near(path.predicted[0][0], 356);
  near(path.predicted.at(-1)[0], 302);
  const uncertain = structuredClone(f.visual.tracks[0]);
  uncertain.reliable = false;
  const unqualified = projectPixelTrack(uncertain, pair);
  assert.equal(unqualified.observed.length, 3);
  assert.deepEqual(unqualified.predicted, []);
  assert.match(unqualified.reason, /unavailable/i);
  f.visual.forecasts[0].reason = "uncertain-longitudinal-arrival";
  assert.deepEqual(projectPixelTrack(f.visual.tracks[0], pair).predicted, []);
});

test("a camera frame with a person, vehicle and unclassified motion renders only the person's ghost", () => {
  const f = fixture(), [person] = f.visual.tracks;
  f.visual.tracks.unshift({ ...person, id: "passing-vehicle", label: "vehicle" });
  f.visual.tracks.push({ ...person, id: "unclassified", label: "motion" });
  const pair = pairCameraEvidence(f);
  assert.deepEqual(pedestrianForecasts({ tick: 72, pair }), [{
    id: `camera:${person.id}`, source: "camera", heading: Math.PI / 2,
    points: [0, .5, 1, 2].map(secondsAhead => ({ x: -2 + secondsAhead, z: 10, secondsAhead })),
  }]);
});

test("wrong-source, old, unsorted, future-injected or unobserved tracks cannot become projected paths", () => {
  const f = fixture(), pair = pairCameraEvidence(f);
  for (const mutate of [
    (track) => { track.source = "world-reference"; },
    (track) => { track.streamId = "another-stream"; },
    (track) => { track.frameId--; },
    (track) => { track.ageMs = 751; },
    (track) => { track.history[0].simulationTimeS = 2; },
    (track) => { track.history[1].frameId = track.history[0].frameId; },
    (track) => { track.history.at(-1).position.x = Infinity; },
    (track) => { track.history.at(-1).future = { x: 20, z: 0 }; },
    (track) => { track.target = { x: 20, z: 0 }; },
    (track) => { track.future = [[0, 0], [1, 2]]; },
  ]) {
    const track = structuredClone(f.visual.tracks[0]);
    mutate(track);
    assert.equal(projectPixelTrack(track, pair), null);
  }
});

test("the actual VisualCrossingPredictor producer is compatible with the evidence consumer", () => {
  const f = fixture(), predictor = new VisualCrossingPredictor();
  predictor.reset(f.frame.streamId);
  for (let i = 0; i < 3; i++) {
    const result = structuredClone(f.result);
    result.frameId = i + 1;
    result.simulationTimeS = 1 + i * 0.1;
    const center = 359.6 - i * 1.8;
    result.detections[0].box = [center - 12, 150, center + 12, 210.24];
    assert.equal(predictor.observe(result).accepted, true);
    f.result = result;
  }
  f.visual = predictor.snapshot(1.2, f.frame.ego);
  const pair = pairCameraEvidence(f);
  assert.equal(pair.canAnalyze, true);
  assert.equal(pair.motionAvailable, true);
  const path = projectPixelTrack(f.visual.tracks[0], pair);
  assert.ok(path);
  near(path.observed.at(-1)[0], 356);
  near(path.speedMps, 1);
  assert.ok(path.predicted.length > 1);
});
