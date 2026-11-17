import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { VisualCrossingPredictor, decideVisualBrake } from "../src/core/visual-prediction.js";
import { integrateVehicle } from "../src/core/vehicle.js";

// These are independent geometric fixtures, not detector/model acceptance.
const STREAM = "unit-camera-stream";
const near = (a, b, epsilon = 1e-7) =>
  assert.ok(Math.abs(a - b) <= epsilon, `${a} differs from ${b}`);
const egoAt = (t = 0, speed = 4.5) => ({
  x: 0, z: -22 + speed * t, headingRad: 0, speedMps: speed, lengthM: 4.2, widthM: 1.85,
});
function cameraAt(ego) {
  return {
    width: 640, height: 360, fovYDeg: 76,
    position: {
      x: ego.x + Math.sin(ego.headingRad) * 0.72,
      y: 1.58, z: ego.z + Math.cos(ego.headingRad) * 0.72,
    },
    headingRad: ego.headingRad, groundY: 0.12,
  };
}
function physicalBox(position, camera) {
  const dx = position.x - camera.position.x, dz = position.z - camera.position.z;
  const depth = dx * Math.sin(camera.headingRad) + dz * Math.cos(camera.headingRad);
  const imageRight = -dx * Math.cos(camera.headingRad) + dz * Math.sin(camera.headingRad);
  const f = camera.height / (2 * Math.tan(camera.fovYDeg * Math.PI / 360));
  const u = camera.width / 2 + f * imageRight / depth;
  const foot = camera.height / 2 + f * (camera.position.y - camera.groundY) / depth;
  return [u - f * 0.25 / depth, foot - f * 1.72 / depth, u + f * 0.25 / depth, foot];
}
function frame(t, frameId, positions, ego = egoAt(t), label = "person") {
  const camera = cameraAt(ego);
  return {
    streamId: STREAM, frameId, simulationTimeS: t, camera, ego,
    width: 640, height: 360, latencyMs: 42,
    model: {
      id: "unit-physical-box-fixture", method: "synthetic-geometry",
      provider: "unit-only", weightsSha256: null,
    },
    status: "ready",
    detections: positions.map((position) => ({
      box: physicalBox(position, camera), label, confidence: 0.98,
    })),
  };
}
function predictor() {
  const p = new VisualCrossingPredictor();
  p.reset(STREAM);
  return p;
}
function sequence(positionAt, { count = 9, step = 0.1, label = "person", speed = 4.5 } = {}) {
  const p = predictor();
  let state;
  for (let i = 0; i < count; i++) {
    const t = i * step;
    p.observe(frame(t, i, [positionAt(t)], egoAt(t, speed), label));
    state = p.snapshot(t, egoAt(t, speed));
  }
  return { p, state };
}
function assertFinite(value) {
  if (typeof value === "number") assert.ok(Number.isFinite(value));
  else if (value && typeof value === "object") Object.values(value).forEach(assertFinite);
}

test("no observation, reset and no projected track never claim an available crossing decision", () => {
  const p = predictor();
  assert.equal(p.snapshot(0, egoAt()).decision.available, false);
  p.observe(frame(0, 0, []));
  const empty = p.snapshot(0, egoAt());
  assert.equal(empty.available, true, "an actual empty frame is still a received camera frame");
  assert.equal(empty.decision.available, false, "no track is not proof of a clear road");
  assert.equal(empty.decision.brake, false);
  p.reset("other-stream");
  const reset = p.snapshot(0, egoAt());
  assert.equal(reset.frameId, null);
  assert.equal(reset.model, null);
  assert.deepEqual(reset.tracks, []);
  assert.equal(reset.available, false);
});

for (const headingRad of [0, Math.PI / 2, 0.63]) {
test(`bottom-center inversion agrees with actual Three.js lookAt at heading ${headingRad}`, () => {
  const p = predictor();
  const ego = { ...egoAt(), x: 3, z: -14, headingRad };
  const camera = cameraAt(ego);
  const target = { x: 3 + Math.sin(headingRad) * 20 - Math.cos(headingRad) * 3.2,
    z: -14 + Math.cos(headingRad) * 20 + Math.sin(headingRad) * 3.2 };
  const view = new THREE.PerspectiveCamera(76, 640 / 360, 0.1, 250);
  view.position.set(camera.position.x, camera.position.y, camera.position.z);
  view.lookAt(view.position.clone().add(new THREE.Vector3(Math.sin(headingRad), 0, Math.cos(headingRad))));
  view.updateMatrixWorld(true);
  const foot = new THREE.Vector3(target.x, 0.12, target.z).project(view);
  const box = [(foot.x + 1) * 320 - 4, (1 - foot.y) * 180 - 20,
    (foot.x + 1) * 320 + 4, (1 - foot.y) * 180];
  const result = frame(0, 0, [], ego);
  result.detections.push({ box, label: "person", confidence: 0.98 });
  p.observe(result);
  const projected = p.snapshot(0, ego).tracks[0].position;
  near(projected.x, target.x);
  near(projected.z, target.z);
});
}

test("own translating/rotating camera odometry does not manufacture a moving pedestrian", () => {
  const p = predictor();
  const physical = { x: -3.1, z: 2 };
  for (let i = 0; i < 10; i++) {
    const t = i * 0.1;
    const ego = { ...egoAt(t), x: 0.15 * t, headingRad: 0.025 * t };
    p.observe(frame(t, i, [physical], ego));
  }
  const result = p.snapshot(0.9, egoAt(0.9));
  assert.equal(result.tracks.length, 1);
  near(result.tracks[0].position.x, physical.x);
  near(result.tracks[0].position.z, physical.z);
  near(result.tracks[0].velocity.x, 0);
  near(result.tracks[0].velocity.z, 0);
  assert.equal(result.decision.brake, false);
});

for (const side of [-1, 1]) {
  test(`observed crossing from ${side < 0 ? "left" : "right"} forecasts physical lane/time conflict`, () => {
    const { state } = sequence((t) => ({ x: side * (4.8 - 0.9 * t), z: 0 }));
    const physicalLaneEntryS = (4.8 - (1.85 / 2 + 0.35)) / 0.9;
    assert.equal(state.decision.brake, true);
    assert.equal(state.decision.source, "visual-prediction");
    assert.equal(state.decision.targetSpeedMps, 0);
    assert.equal(state.decision.evidenceFrameId, 8);
    near(state.decision.crossingTimeS, physicalLaneEntryS - 0.8);
    assert.ok(state.decision.crossingTimeS >= 0.3);
    near(state.tracks[0].velocity.x, -side * 0.9);
    near(state.tracks[0].velocity.z, 0);
    assert.ok(state.forecasts[0].conflict);
    assertFinite(state);
  });
}

test("three actual observations and at least 0.2 seconds are both necessary", () => {
  const p = predictor();
  for (const [i, t] of [0, 0.05, 0.1].entries())
    p.observe(frame(t, i, [{ x: -4.8 + 0.9 * t, z: 0 }]));
  assert.equal(p.snapshot(0.1, egoAt(0.1)).decision.brake, false);
  p.observe(frame(0.2, 3, [{ x: -4.62, z: 0 }]));
  assert.equal(p.snapshot(0.2, egoAt(0.2)).decision.brake, true);
  const two = sequence((t) => ({ x: -4.8 + t * 0.9, z: 0 }), { count: 2, step: 0.3 });
  assert.equal(two.state.decision.brake, false);
});

test("motion remains ambiguous and a vehicle cannot become a semantic crossing person", () => {
  const move = (t) => ({ x: -4.8 + 0.9 * t, z: 0 });
  const motion = sequence(move, { label: "motion" }).state;
  assert.equal(motion.decision.brake, true);
  assert.equal(motion.tracks[0].label, "motion");
  assert.equal(motion.decision.reason, "observed-motion-crossing-conflict");
  const vehicle = sequence(move, { label: "vehicle" }).state;
  assert.equal(vehicle.decision.brake, false);
  assert.equal(vehicle.tracks[0].label, "vehicle");
});

for (const [name, position, options] of [
  ["stationary curb", () => ({ x: -4.8, z: 0 })],
  ["parallel walker", (t) => ({ x: -4.8, z: 0.9 * t })],
  ["away walker", (t) => ({ x: -4.8 - 0.9 * t, z: 0 })],
  ["different arrival time", (t) => ({ x: -4.8 + 0.9 * t, z: 0 }), { speed: 0.5 }],
]) {
  test(`${name} is a meaningful no-brake lookalike`, () => {
    const { state } = sequence(position, options);
    assert.equal(state.decision.brake, false);
    assert.equal(state.decision.targetSpeedMps, null);
  });
}

test("nearby semantic presence by itself cannot cause a predictive stop", () => {
  const { state } = sequence(() => ({ x: -1.6, z: 2 }), { speed: 0, count: 7 });
  assert.equal(state.decision.brake, false);
});

test("association is temporal and one-to-one, not array order or a supplied perfect track ID", () => {
  const p = predictor();
  p.observe(frame(0, 0, [{ x: -4.8, z: 0 }, { x: 4.8, z: 0 }]));
  const initial = p.snapshot(0, egoAt()).tracks;
  p.observe(frame(0.1, 1, [{ x: 4.71, z: 0 }, { x: -4.71, z: 0 }]));
  const tracked = p.snapshot(0.1, egoAt(0.1)).tracks;
  assert.equal(tracked.length, 2);
  assert.equal(tracked[0].id, initial[0].id);
  assert.equal(tracked[0].observations, 2);
  assert.ok(tracked[0].position.x < 0);
  assert.ok(tracked[1].position.x > 0);
});

test("multi-observation fit tolerates small pixel jitter without an unbounded derivative", () => {
  const p = predictor();
  for (let i = 0; i < 12; i++) {
    const t = i * 0.1;
    const result = frame(t, i, [{ x: -4.8 + 0.9 * t, z: 0 }]);
    const jitter = Math.sin(i * 1.7) * 0.1;
    result.detections[0].box = result.detections[0].box.map((n) => n + jitter);
    p.observe(result);
  }
  const state = p.snapshot(1.1, egoAt(1.1));
  assert.equal(state.tracks.length, 1);
  assert.ok(state.tracks[0].observations >= 3);
  near(state.tracks[0].velocity.x, 0.9, 0.12);
  assert.ok(state.tracks[0].uncertaintyM > 0);
  assert.ok(Math.hypot(...Object.values(state.tracks[0].velocity)) <= 4);
  assert.equal(state.decision.brake, true);
});

test("stationary curb jitter cannot be laundered into a confident incoming trajectory", () => {
  const p = predictor();
  for (let i = 0; i < 20; i++) {
    const t = i * 0.1;
    const result = frame(t, i, [{ x: -4.8, z: 0 }]);
    result.detections[0].box = result.detections[0].box.map((n, k) =>
      n + (k % 2 ? Math.cos(i * 1.9) : Math.sin(i * 2.3)) * 0.5);
    p.observe(result);
    assert.equal(p.snapshot(t, egoAt(t)).decision.brake, false);
  }
});

test("brief missing detections retain original evidence identity; stale data cannot grant brake or clear success", () => {
  const { p, state } = sequence((t) => ({ x: -4.8 + 0.9 * t, z: 0 }), { count: 5 });
  assert.equal(state.decision.brake, true);
  p.observe(frame(0.5, 5, []));
  const occluded = p.snapshot(0.5, egoAt(0.5));
  assert.equal(occluded.decision.brake, true);
  assert.equal(occluded.decision.evidenceFrameId, 4);
  near(occluded.decision.ageMs, 100);
  const stale = p.snapshot(1.251, egoAt(1.251));
  assert.equal(stale.status, "stale");
  assert.equal(stale.available, false);
  assert.equal(stale.decision.available, false);
  assert.equal(stale.decision.brake, false);
  assert.equal(stale.decision.targetSpeedMps, null);
});

test("pure legacy release hysteresis is finite and cannot outlive fresh visual evidence", () => {
  const { state } = sequence((t) => ({ x: -4.8 + 0.9 * t, z: 0 }), { count: 5 });
  const track = { ...state.tracks[0], velocity: { x: 0, z: 0 }, stopEpisode: null };
  const held = decideVisualBrake({ tracks: [track], nowS: 0.5, ego: egoAt(0.5), enabled: true });
  assert.equal(held.reason, "release-hysteresis");
  assert.equal(held.brake, true);
  const released = decideVisualBrake({ tracks: [track], nowS: 0.76, ego: egoAt(0.76), enabled: true });
  assert.equal(released.brake, false);
  const stale = decideVisualBrake({ tracks: [track], nowS: 1.151, ego: egoAt(1.151), enabled: true });
  assert.equal(stale.available, false);
  assert.equal(stale.brake, false);
  assert.equal(decideVisualBrake({ tracks: state.tracks, nowS: 0.4,
    ego: egoAt(0.4), enabled: false }).available, false);
});

test("invalid/out-of-order/cross-stream observations revoke availability until a newer valid result", () => {
  const { p } = sequence((t) => ({ x: -4.8 + 0.9 * t, z: 0 }), { count: 5 });
  assert.throws(() => p.observe(frame(0.3, 3, [])), /out-of-order/);
  assert.equal(p.snapshot(0.5, egoAt(0.5)).available, false);
  p.observe(frame(0.6, 6, [{ x: -4.26, z: 0 }]));
  assert.equal(p.snapshot(0.6, egoAt(0.6)).available, true);
  assert.throws(() => p.observe({ ...frame(0.7, 7, []), streamId: "old-stream" }), /stream/);
  assert.equal(p.snapshot(0.7, egoAt(0.7)).available, false);
  p.snapshot(2, egoAt(2));
  assert.throws(() => p.observe(frame(0.8, 8, [])), /stale/);
  const slow = predictor();
  assert.throws(() => slow.observe({ ...frame(0, 0, []), latencyMs: 751 }), /stale/);
  assert.equal(slow.snapshot(0, egoAt()).available, false);
});

test("horizon, clipped-footpoint, impossible speed and nonfinite inputs cannot create a valid crossing", () => {
  const p = predictor();
  const horizon = frame(0, 0, []);
  horizon.detections = [{ box: [300, 100, 330, 179], label: "person", confidence: 1 }];
  p.observe(horizon);
  assert.equal(p.snapshot(0, egoAt()).tracks.length, 0);
  const clipped = frame(0.1, 1, []);
  clipped.detections = [{ box: [300, 220, 330, 360], label: "person", confidence: 1 }];
  p.observe(clipped);
  assert.equal(p.snapshot(0.1, egoAt(0.1)).decision.brake, false);
  const impossible = sequence((t) => ({ x: -4.8 + 15 * t, z: 0 }), { count: 4 }).state;
  assert.equal(impossible.decision.brake, false);
  const bad = frame(0.2, 2, [{ x: -4.6, z: 0 }]);
  bad.detections[0].box[3] = NaN;
  assert.throws(() => p.observe(bad), /finite/);
  assert.equal(p.snapshot(0.2, egoAt(0.2)).available, false);
});

test("explicit truth injection is rejected at result, detection, camera, ego and decision boundaries", () => {
  const mutations = [
    (r) => { r.actors = [{ id: "truth", x: 1, z: 2 }]; },
    (r) => { r.caseId = "cross-left"; },
    (r) => { r.futurePath = [{ x: 0, z: 0 }]; },
    (r) => { r.detections[0].actorId = "truth"; },
    (r) => { r.camera.hitId = "person-0"; },
    (r) => { r.ego.scenario = "cross-left"; },
    (r) => { r.model.intent = "crossing"; },
    (r) => { r.observations = [{ futurePath: [0, 1] }]; },
  ];
  for (const mutate of mutations) {
    const p = predictor();
    const data = frame(0, 0, [{ x: -4.8, z: 0 }]);
    mutate(data);
    assert.throws(() => p.observe(data), /unknown|forbidden/);
    assert.equal(p.snapshot(0, egoAt()).available, false);
  }
  const { state } = sequence((t) => ({ x: -4.8 + 0.9 * t, z: 0 }));
  assert.throws(() => decideVisualBrake({ tracks: state.tracks, nowS: 0.8,
    ego: egoAt(0.8), caseId: "cross-left" }), /unknown/);
  assert.throws(() => decideVisualBrake({ tracks: [{ ...state.tracks[0],
    futurePath: [0, 1] }], nowS: 0.8, ego: egoAt(0.8) }), /unknown/);
  assert.throws(() => decideVisualBrake({ tracks: [{ ...state.tracks[0],
    position: { ...state.tracks[0].position, actorId: "truth" } }],
  nowS: 0.8, ego: egoAt(0.8) }), /unknown/);
  const contaminatedHistory = structuredClone(state.tracks);
  contaminatedHistory[0].history[0].futurePath = [0, 1];
  assert.throws(() => decideVisualBrake({ tracks: contaminatedHistory,
    nowS: 0.8, ego: egoAt(0.8) }), /unknown/);
  const forgedCount = structuredClone(state.tracks);
  forgedCount[0].history = forgedCount[0].history.slice(0, 1);
  assert.throws(() => decideVisualBrake({ tracks: forgedCount,
    nowS: 0.8, ego: egoAt(0.8) }), /count/);
});

test("observations/snapshots do not share caller-owned mutable data and tracks stay bounded", () => {
  const p = predictor();
  const input = frame(0, 0, [{ x: -4.8, z: 0 }]);
  p.observe(input);
  input.detections[0].box[0] = 0;
  const a = p.snapshot(0, egoAt());
  a.tracks[0].position.x = 999;
  a.tracks[0].history[0].position.x = 999;
  a.model.id = "forged";
  const b = p.snapshot(0, egoAt());
  near(b.tracks[0].position.x, -4.8);
  assert.equal(b.model.id, "unit-physical-box-fixture");
  for (let i = 1; i < 40; i++)
    p.observe(frame(i * 0.1, i, [{ x: -4.8, z: 0 }]));
  assert.ok(p.snapshot(3.9, egoAt(3.9)).tracks.every((track) => track.history.length <= 12));
  const crowded = predictor();
  crowded.observe(frame(0, 0, Array.from({ length: 128 }, (_, i) =>
    ({ x: -8 + (i % 16), z: Math.floor(i / 16) * 2 }))));
  assert.ok(crowded.snapshot(0, egoAt()).tracks.length <= 24);
});

function axisNoiseSequence({
  headingRad = 0, axis = "forward", amplitude = 0.2,
  lateralStart = -4.8, lateralVelocity = 0.9, forward = 0, speed = 4.5,
} = {}) {
  const p = predictor(), jitter = [1, -1, 0, -1, 1];
  const c = Math.cos(headingRad), s = Math.sin(headingRad);
  let state, ego;
  for (let i = 0; i < jitter.length; i++) {
    const t = i * 0.1, noise = amplitude * jitter[i];
    ego = { ...egoAt(t, speed), x: s * (-22 + speed * t),
      z: c * (-22 + speed * t), headingRad };
    const lateral = lateralStart + lateralVelocity * t + (axis === "lateral" ? noise : 0);
    const along = forward + (axis === "forward" ? noise : 0);
    const result = frame(t, i, [{ x: lateral * c + along * s,
      z: -lateral * s + along * c }], ego);
    result.detections[0].confidence = 0.8;
    p.observe(result);
  }
  // This helper isolates the covariance decision, not a prior committed action.
  state = p.snapshot(0.4, ego);
  return { p, state, ego };
}

for (const headingRad of [0, Math.PI / 2]) {
  test(`anisotropic depth noise preserves evidenced lateral conflict at yaw ${headingRad}`, () => {
    const { state } = axisNoiseSequence({ headingRad });
    assert.equal(state.decision.brake, true,
      "independent depth scatter must not be used as lateral velocity uncertainty");
    const forecast = state.forecasts[0], track = state.tracks[0];
    near(forecast.lateralSpeedMps, 0.9);
    near(forecast.forwardSpeedMps, 0);
    assert.ok(forecast.lateralVelocityUncertaintyMps < 0.1);
    assert.ok(forecast.longitudinalVelocityUncertaintyMps > 0.65);
    assert.ok(forecast.arrivalQualified);
    assert.ok(forecast.confidence >= 0.55 && forecast.confidence <= 0.8);
    // Five samples: sum(depth residual²)=.16, residual df=3, sum(centered time²)=.1.
    const expectedVelocityVariance = (0.16 / 3) / 0.1;
    near(headingRad === 0 ? track.velocityCovarianceM2S2.zz
      : track.velocityCovarianceM2S2.xx, expectedVelocityVariance);
    assertFinite(state);
  });
}

test("lateral jitter is not excused by separating depth uncertainty", () => {
  const { state } = axisNoiseSequence({ axis: "lateral" });
  assert.equal(state.decision.brake, false);
  assert.ok(state.forecasts[0].lateralVelocityUncertaintyMps > 0.65);
  for (const [lateralStart, lateralVelocity] of [[-4.8, 0], [-4.8, -0.9]]) {
    const negative = axisNoiseSequence({ lateralStart, lateralVelocity }).state;
    assert.equal(negative.decision.brake, false);
  }
  const parallel = predictor();
  for (let i = 0; i < 5; i++) {
    const t = i * 0.1;
    const result = frame(t, i, [{ x: -4.8, z: 0.9 * t + [0.2, -0.2, 0, -0.2, 0.2][i] }]);
    result.detections[0].confidence = 0.8;
    parallel.observe(result);
  }
  assert.equal(parallel.snapshot(0.4, egoAt(0.4)).decision.brake, false);
});

test("uncertain longitudinal arrival is not silently discarded or treated as a certain conflict", () => {
  const disjoint = axisNoiseSequence({ forward: -12 }).state;
  assert.equal(disjoint.decision.brake, false);
  const uncertain = axisNoiseSequence({
    lateralStart: -2.8, speed: 1, forward: -18.4,
  }).state;
  assert.equal(uncertain.tracks[0].observations, 5);
  assert.equal(uncertain.decision.brake, false);
  assert.equal(uncertain.decision.available, false);
  assert.equal(uncertain.decision.reason, "uncertain-longitudinal-arrival");
  assert.equal(uncertain.forecasts[0].arrivalQualified, false);
  assert.ok(uncertain.forecasts[0].longitudinalVelocityUncertaintyMps > 0.65);
  assert.ok(uncertain.forecasts[0].confidence > 0.55,
    "arrival uncertainty must still veto a track whose lateral evidence is confident");
});

test("projection covariance matches independent Three ray finite differences including horizontal noise", () => {
  for (const headingRad of [0, 0.63]) {
    const ego = { ...egoAt(), headingRad }, camera = cameraAt(ego);
    const actual = { x: ego.x + 20 * Math.sin(headingRad),
      z: ego.z + 20 * Math.cos(headingRad) };
    const result = frame(0, 0, [actual], ego);
    const view = new THREE.PerspectiveCamera(76, 640 / 360, 0.1, 250);
    view.position.set(camera.position.x, camera.position.y, camera.position.z);
    view.lookAt(view.position.clone().add(new THREE.Vector3(Math.sin(headingRad), 0, Math.cos(headingRad))));
    view.updateMatrixWorld(true);
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -0.12);
    function ground(u, v) {
      const ray = new THREE.Raycaster();
      ray.setFromCamera(new THREE.Vector2(u / 320 - 1, 1 - v / 180), view);
      return ray.ray.intersectPlane(plane, new THREE.Vector3());
    }
    const b = result.detections[0].box, u = (b[0] + b[2]) / 2, v = b[3], epsilon = 0.001;
    const du = ground(u + epsilon, v).sub(ground(u - epsilon, v)).divideScalar(2 * epsilon);
    const dv = ground(u, v + epsilon).sub(ground(u, v - epsilon)).divideScalar(2 * epsilon);
    const expected = { xx: 0.25 * (du.x ** 2 + dv.x ** 2),
      xz: 0.25 * (du.x * du.z + dv.x * dv.z),
      zz: 0.25 * (du.z ** 2 + dv.z ** 2) };
    const p = predictor();
    p.observe(result);
    const covariance = p.snapshot(0, ego).tracks[0].positionCovarianceM2;
    for (const key of ["xx", "xz", "zz"]) near(covariance[key], expected[key], 1e-7);
    assert.ok(covariance.xx > 0 && covariance.zz > 0);
  }
});

test("covariance outputs remain copied, finite, positive-semidefinite and truth-strict", () => {
  const { p, state, ego } = axisNoiseSequence();
  for (const name of ["positionCovarianceM2", "velocityCovarianceM2S2", "regressionResidualCovarianceM2"]) {
    const matrix = state.tracks[0][name];
    assert.ok(matrix.xx >= 0 && matrix.zz >= 0);
    assert.ok(matrix.xx * matrix.zz - matrix.xz ** 2 >= -1e-10);
    const bad = structuredClone(state.tracks);
    bad[0][name].actorId = "forbidden-truth";
    assert.throws(() => decideVisualBrake({ tracks: bad, nowS: 0.4, ego }), /unknown/);
    delete bad[0][name].actorId;
    bad[0][name].xz = Math.sqrt(matrix.xx * matrix.zz) + 1;
    assert.throws(() => decideVisualBrake({ tracks: bad, nowS: 0.4, ego }), /covariance/);
  }
  state.tracks[0].positionCovarianceM2.xx = 999;
  assert.notEqual(p.snapshot(0.4, ego).tracks[0].positionCovarianceM2.xx, 999);
});

function feedbackRun({ side = -1, away = false, apply = true, dropAfter = Infinity, until = 8.5 } = {}) {
  const p = predictor(), rows = [];
  let body = { x: 0, z: -22, heading: 0, speed: 4.5, steer: 0, length: 4.2, width: 1.85 };
  let firstStop = null, firstRequest = null;
  for (let tick = 0; tick <= Math.round(until * 60); tick++) {
    const timeS = tick / 60;
    const ego = { x: body.x, z: body.z, headingRad: body.heading,
      speedMps: body.speed, lengthM: body.length, widthM: body.width };
    if (tick % 6 === 0) {
      const travelled = 0.9 * Math.max(0, timeS - 0.65);
      let x = side * (4.8 - travelled);
      if (away && timeS >= 3.5)
        x = side * (4.8 - 0.9 * (3.5 - 0.65) + 0.9 * (timeS - 3.5));
      const missing = timeS < 2.1 || tick === 156 || tick === 162 || timeS > dropAfter;
      const result = frame(timeS, tick / 6, missing ? [] : [{ x, z: 0 }], ego);
      for (const detection of result.detections)
        detection.confidence = timeS >= 2.5 && timeS < 4.2 ? 0.4 : 0.9;
      p.observe(result);
    }
    const state = p.snapshot(timeS, ego);
    const cap = state.decision.available && state.decision.brake;
    if (cap && firstRequest === null) firstRequest = timeS;
    const next = integrateVehicle(body, { targetSpeed: apply && cap ? 0 : 4.5, steer: 0 }, 1 / 60);
    if (firstRequest !== null && firstStop === null && next.speed < 0.05)
      firstStop = { timeS: timeS + 1 / 60, decision: state.decision };
    rows.push({ timeS, ego, decision: state.decision, track: state.tracks[0],
      forecast: state.forecasts[0], nextSpeedMps: next.speed });
    body = next;
  }
  return { p, rows, firstRequest, firstStop };
}

for (const side of [-1, 1]) {
  test(`committed visual stop reaches actual zero before lane entry with fresh uncertainty, side ${side}`, () => {
    const run = feedbackRun({ side, until: 4.4 });
    const physicalLaneEntryS = 0.65 + (4.8 - (1.85 / 2 + 0.34)) / 0.9;
    assert.ok(run.firstStop && run.firstStop.timeS < physicalLaneEntryS,
      "an early onset is not success: the real vehicle integrator must finish the visual stop before occupancy");
    assert.ok(run.firstStop.timeS <= run.firstRequest + 4.5 / 7 + 1 / 60);
    assert.equal(run.firstStop.decision.source, "visual-prediction");
    const stopping = run.rows.filter((row) =>
      row.timeS >= run.firstRequest && row.timeS < run.firstStop.timeS - 1 / 60);
    assert.ok(stopping.every((row) => row.decision.available && row.decision.brake));
    const uncertain = stopping.find((row) => row.decision.reason === "committed-visual-stop" &&
      row.forecast?.confidence < 0.55);
    assert.ok(uncertain, "exercise continuation, not another high-confidence crossing fixture");
    assert.ok(uncertain.track.stopEpisode.originConfidence >= 0.55);
    assert.equal(uncertain.track.stopEpisode.originFrameId,
      stopping[0].track.stopEpisode.originFrameId);
    assert.equal(uncertain.decision.evidenceFrameId, uncertain.track.frameId);
    assert.ok(uncertain.decision.ageMs <= 750);
    assert.ok(stopping.some((row) => row.decision.ageMs >= 150),
      "short actually missing observations must not manufacture new frames or release the cap");
  });
}

test("actual stop waits for positive observed clearance, not ego-induced TTC reduction", () => {
  const run = feedbackRun();
  assert.ok(run.firstStop);
  const release = run.rows.find((row) => row.decision.reason === "visual-clearance-confirmed");
  assert.ok(release, "fresh outgoing observations must eventually release the completed episode");
  assert.ok(release.timeS > run.firstStop.timeS);
  assert.ok(run.rows.filter((row) => row.timeS >= run.firstRequest && row.timeS < release.timeS)
    .every((row) => row.decision.available && row.decision.brake));
  assert.equal(release.track.stopEpisode.phase, "cleared");
  assert.ok(release.forecast.lateralM - release.forecast.lateralPositionUncertaintyM > 1.85 / 2 + 0.35);
  assert.ok(run.rows.some((row) => row.timeS > release.timeS && row.nextSpeedMps > 0.2));
  const reversed = feedbackRun({ away: true, until: 6 });
  const awayRelease = reversed.rows.find((row) => row.decision.reason === "visual-clearance-confirmed");
  assert.ok(awayRelease && reversed.firstStop);
  assert.ok(awayRelease.timeS > reversed.firstStop.timeS);
  assert.ok(awayRelease.forecast.lateralM < -1.85 / 2 - 0.35);
  assert.ok(awayRelease.forecast.lateralSpeedMps < -0.2);
});

test("stale or unseen observations cannot claim a confirmed stop continuation", () => {
  const lost = feedbackRun({ dropAfter: 2.4, until: 3.5 });
  const stale = lost.rows.find((row) => row.timeS >= 3.2);
  assert.equal(stale.decision.available, false);
  assert.equal(stale.decision.brake, false);
  assert.ok(stale.decision.ageMs > 750);
  lost.p.reset("new-unseen-stream");
  assert.deepEqual(lost.p.snapshot(0, egoAt(0)).tracks, []);
  assert.equal(lost.p.snapshot(0, egoAt(0)).decision.available, false);
  for (const position of [
    () => ({ x: -4.8, z: 0 }),
    (t) => ({ x: -4.8, z: t }),
    (t) => ({ x: -4.8 - t, z: 0 }),
  ]) {
    const state = sequence(position).state;
    assert.equal(state.decision.brake, false);
    assert.ok(state.tracks.every((track) => track.stopEpisode === null));
  }
});

test("unobserved actuation and persistent uncertain evidence cannot renew an episode forever", () => {
  const run = feedbackRun({ apply: false, until: 3.5 });
  const expired = run.rows.find((row) => row.track?.stopEpisode?.phase === "expired");
  assert.ok(expired);
  assert.equal(expired.decision.available, false);
  assert.equal(expired.decision.brake, false);
  assert.equal(expired.decision.reason, "visual-stop-no-braking-progress");
  assert.equal(expired.track.stopEpisode.stoppedAtS, null);
});

test("stop episode evidence is copied, identity-bound and cannot enter through detector input", () => {
  const run = feedbackRun({ until: 2.5 });
  const track = run.rows.at(-1).track;
  assert.ok(track.stopEpisode);
  const forged = structuredClone(track);
  forged.stopEpisode.streamId = "other-person-stream";
  assert.throws(() => decideVisualBrake({ tracks: [forged], nowS: 2.5,
    ego: run.rows.at(-1).ego }), /identity/);
  const injected = frame(2.6, 26, [], run.rows.at(-1).ego);
  injected.stopEpisode = track.stopEpisode;
  assert.throws(() => run.p.observe(injected), /unknown/);
  track.stopEpisode.referenceEgo.x = 999;
  const current = run.p.snapshot(2.5, run.rows.at(-1).ego).tracks[0];
  assert.notEqual(current.stopEpisode.referenceEgo.x, 999);
});
