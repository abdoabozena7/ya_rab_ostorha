import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as THREE from "three";
import { VisualCrossingPredictor } from "../src/core/visual-prediction.js";
import {
  createDistrictSpeedState, decideDistrictVisualSpeed, mappedDistrictSpeed,
  composeDistrictSpeed, attributeDistrictApplied,
} from "../src/core/visual-speed-policy.js";
import { integrateVehicle } from "../src/core/vehicle.js";
import { safeSpeed } from "../src/core/traffic-control.js";
import { SpatialIndex } from "../src/core/spatial-index.js";
import { mountCameraScreen } from "../src/ui/camera-screen.js";

// Projected boxes exercise the actual predictor/policy/plant, not neural-detector acceptance.
const STREAM = "district-unit-pixels";
const DT = 1 / 60;
const near = (a, b, epsilon = 1e-8) =>
  assert.ok(Math.abs(a - b) <= epsilon, `${a} differs from ${b}`);
const egoAt = (t = 0, speedMps = 4.5, headingRad = 0, startZ = -22) => ({
  x: Math.sin(headingRad) * (startZ + speedMps * t),
  z: Math.cos(headingRad) * (startZ + speedMps * t),
  headingRad, speedMps, lengthM: 4.2, widthM: 1.85,
});
const rotated = (x, z, yaw) => ({
  x: x * Math.cos(yaw) + z * Math.sin(yaw),
  z: -x * Math.sin(yaw) + z * Math.cos(yaw),
});
function frame(timeS, frameId, positions = [], ego = egoAt(timeS), label = "person", confidence = 0.98) {
  const camera = { width: 640, height: 360, fovYDeg: 76,
    position: { x: ego.x + Math.sin(ego.headingRad) * 0.72,
      y: 1.58, z: ego.z + Math.cos(ego.headingRad) * 0.72 },
    headingRad: ego.headingRad, groundY: 0.12 };
  const view = new THREE.PerspectiveCamera(76, 640 / 360, 0.1, 250);
  view.position.set(camera.position.x, camera.position.y, camera.position.z);
  view.lookAt(view.position.clone().add(new THREE.Vector3(Math.sin(ego.headingRad), 0,
    Math.cos(ego.headingRad))));
  view.updateMatrixWorld(true);
  const detections = positions.map((position) => {
    const foot = new THREE.Vector3(position.x, 0.12, position.z).project(view);
    const top = new THREE.Vector3(position.x, 1.84, position.z).project(view);
    const u = (foot.x + 1) * 320, v = (1 - foot.y) * 180;
    return { label, confidence, box: [u - 3, (1 - top.y) * 180, u + 3, v] };
  });
  return { streamId: STREAM, frameId, simulationTimeS: timeS, camera, ego,
    width: 640, height: 360, latencyMs: 20,
    model: { id: "unit-three-projection", method: "synthetic-geometry",
      provider: "unit-only", weightsSha256: null }, status: "ready", detections };
}
function predictor() {
  const p = new VisualCrossingPredictor();
  p.reset(STREAM);
  return p;
}
function sequence(positionAt = (t) => ({ x: -4.8 + 0.9 * t, z: 0 }),
  { count = 2, speed = 4.5, heading = 0, startZ = -22, label = "person", confidence = 0.98,
    intervalS = 0.1 } = {}) {
  const p = predictor();
  let ego, visual;
  for (let i = 0; i < count; i++) {
    const t = i * intervalS;
    ego = egoAt(t, speed, heading, startZ);
    const position = positionAt(t);
    p.observe(frame(t, i, position ? [position] : [], ego, label, confidence));
    visual = p.snapshot(t, ego);
  }
  return { p, ego, visual, nowS: (count - 1) * intervalS };
}
const decide = (sample, previousState = createDistrictSpeedState(), visionRequired = true) =>
  decideDistrictVisualSpeed({ ...sample, requestedSpeedMps: 4.5, previousState, visionRequired });
const sampleOf = ({ visual, ego, nowS }) => ({ visual, ego, nowS });
const cap = (targetSpeedMps, state = "caution") => ({
  source: "camera-pixels", available: true, state, targetSpeedMps, reason: "observed-approach-caution",
  streamId: STREAM, frameId: 1, ageMs: 200, evidenceTrackId: "visual-1",
});
const mapCap = (targetSpeedMps) => ({
  source: "static-map", available: true, state: targetSpeedMps === null ? "clear" : "caution",
  targetSpeedMps, reason: targetSpeedMps === null ? "outside-mapped-caution" : "mapped-blind-corner",
  zoneId: "static-corner", distanceM: 4,
});
function composed(visual, map = null, previousState = createDistrictSpeedState(), targetSpeed = 4.5) {
  return composeDistrictSpeed({ steer: 0, targetSpeed, reason: "driving", blockedBy: null },
    { visual, map, dt: DT, previousState });
}
function freeze(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

function walkingBoxJourney({ heading, phase, crossing }) {
  const p = predictor(), pending = [], rows = [];
  const start = rotated(0, crossing ? -8 : -11, heading);
  let body = { ...start, id: "visual-car", type: "vehicle", heading, speed: 2.5,
    steer: 0, length: 4.2, width: 1.85, path: [], cursor: 0 };
  let baseline = { ...body, id: "baseline-car" }, previousState = createDistrictSpeedState();
  const rootAt = (timeS) => ({ id: "walking-person", type: "pedestrian", radius: 0.35,
    ...rotated(crossing ? -4.8 + timeS : -1.75, 1.12 * timeS, heading) });
  const guarded = (car, command, person) => safeSpeed({
    environment: "egypt", junctionGroups: [], junctionOwners: new Map(),
    actorIndex: new SpatialIndex([car, person]), staticIndex: new SpatialIndex([]),
  }, car, command);
  for (let tick = 0; tick < (crossing ? 420 : 360); tick++) {
    const nowS = tick * DT, person = rootAt(nowS);
    const ego = { x: body.x, z: body.z, headingRad: body.heading,
      speedMps: body.speed, lengthM: body.length, widthM: body.width };
    if (tick % 6 === 0) {
      const observedFoot = rotated((crossing ? -4.8 + nowS : -1.75) +
        0.075 * Math.sin(phase + nowS * 2 * Math.PI / 0.6), 1.12 * nowS, heading);
      pending.push({ applyTick: tick + 12, result: frame(nowS, tick / 6, [observedFoot], ego, "person", 0.924) });
    }
    while (pending[0]?.applyTick <= tick) p.observe(pending.shift().result);
    if (tick < 12) {
      body = integrateVehicle(body, { steer: 0, targetSpeed: 2.5 }, DT);
      baseline = integrateVehicle(baseline, { steer: 0, targetSpeed: 2.5 }, DT);
      continue;
    }
    const visual = p.snapshot(nowS, ego);
    const decision = decideDistrictVisualSpeed({ visual, ego, nowS, requestedSpeedMps: 3.8,
      visionRequired: true, previousState });
    const composedCommand = composeDistrictSpeed({ steer: 0, targetSpeed: 3.8 },
      { visual: decision, map: mapCap(2.5), dt: DT, previousState });
    previousState = composedCommand.nextState;
    const applied = attributeDistrictApplied({ requested: { targetSpeed: 3.8 },
      behavior: { targetSpeed: 3.8 }, composed: composedCommand,
      safe: guarded(body, composedCommand, person) });
    body = integrateVehicle(body, applied, DT);
    const baselineCommand = composeDistrictSpeed({ steer: 0, targetSpeed: 3.8 },
      { map: mapCap(2.5), dt: DT });
    const baselineSafe = guarded(baseline, baselineCommand, person);
    baseline = integrateVehicle(baseline, baselineSafe, DT);
    rows.push({ timeS: nowS + DT, decision, visual, speed: body.speed, baselineSpeed: baseline.speed,
      source: applied.districtSources.appliedSource,
      baselineReactive: baselineSafe.targetSpeed < baselineCommand.targetSpeed - 0.05,
      entered: crossing && Math.abs(-4.8 + nowS + DT) <= body.width / 2 + 0.35 });
  }
  return rows;
}

test("parallel walking-box sway is not lateral body motion or a graded same-map slowdown", (t) => {
  for (const heading of [0, 0.63]) for (const phase of [0, Math.PI / 2, Math.PI]) {
    const rows = walkingBoxJourney({ heading, phase, crossing: false });
    const minimumMps = Math.min(...rows.map((r) => r.speed));
    const baselineMinimumMps = Math.min(...rows.map((r) => r.baselineSpeed));
    t.diagnostic(JSON.stringify({ heading, phase, minimumMps, baselineMinimumMps }));
    near(baselineMinimumMps, 2.5);
    assert.ok(minimumMps >= 0.8 * baselineMinimumMps,
      "bbox/foot sway along a truly parallel path must preserve the matched physical-speed control");
    assert.ok(rows.every((r) => r.decision.available && r.decision.state !== "stop"));
    assert.ok(rows.every((r) => r.source !== "physical-guard"));
  }
});

test("resolved diagonal body motion with the same walking-box sway retains a complete early visual stop", (t) => {
  for (const heading of [0, 0.63]) {
    const rows = walkingBoxJourney({ heading, phase: Math.PI / 2, crossing: true });
    const qualified = rows.find((r) => r.decision.state === "stop");
    const stopped = rows.find((r) => r.speed === 0);
    const baselineReactive = rows.find((r) => r.baselineReactive);
    const entry = rows.find((r) => r.entered);
    t.diagnostic(JSON.stringify({ heading, qualifiedS: qualified?.timeS, zeroS: stopped?.timeS,
      baselineReactiveS: baselineReactive?.timeS, entryS: entry?.timeS }));
    assert.ok(qualified && stopped && baselineReactive && entry);
    assert.equal(qualified.visual.decision.brake, true);
    assert.ok(stopped.timeS < baselineReactive.timeS && stopped.timeS < entry.timeS);
    assert.ok(rows.filter((r) => r.timeS <= stopped.timeS)
      .every((r) => r.source !== "physical-guard" && r.decision.available));
  }
});

for (const heading of [0, Math.PI / 2, 0.63]) {
  test(`actual Three camera projections reject unresolved two-frame motion, then preserve qualified stop at yaw ${heading}`, () => {
    const position = (t) => rotated(-4.8 + 0.9 * t, 0, heading);
    const two = sequence(position, { heading });
    const unresolved = decide(sampleOf(two));
    assert.equal(two.visual.decision.brake, false);
    assert.equal(unresolved.source, "camera-pixels");
    assert.equal(unresolved.state, "clear");
    assert.equal(unresolved.targetSpeedMps, null);
    near(unresolved.ageMs, 0);
    const three = sequence(position, { heading, count: 3 });
    assert.equal(three.visual.decision.brake, true);
    const stop = decide(sampleOf(three), unresolved.nextState);
    assert.equal(stop.state, "stop");
    assert.equal(stop.targetSpeedMps, 0);
    assert.equal(stop.evidenceTrackId, three.visual.decision.trackId);
    assert.equal(composed(stop).decelerationMps2, undefined, "qualified stop must use the full old brake");
  });
}

test("an observed imminent approach can slow before hard-stop qualification without a nearby-person rule", () => {
  const sample = sequence((t) => ({ x: -1.8 + 0.9 * t, z: 0 }), { startZ: -7 });
  const result = decide(sampleOf(sample));
  assert.equal(sample.visual.decision.brake, false);
  assert.equal(result.state, "slow");
  near(result.targetSpeedMps, 1.5);
  near(composed(result).decelerationMps2, 2);
});

test("City reserves stopping room for a measured approach, not a parallel walker", () => {
  const options = { count: 4, speed: 6.5, startZ: -24, intervalS: .16, confidence: .66 };
  const choose = (positionAt, cityLead = true) => decideDistrictVisualSpeed({
    ...sampleOf(sequence(positionAt, options)), requestedSpeedMps: 8, visionRequired: true, cityLead,
  });
  const approaching = t => ({ x: -3 + 1.4 * t, z: 0 });
  const toward = choose(approaching);
  assert.equal(toward.state, "slow");
  assert.ok(toward.targetSpeedMps > 0 && toward.targetSpeedMps < options.speed);
  assert.equal(composed(toward, null, createDistrictSpeedState(), 8).districtSources.appliedSource, "camera-pixels");
  assert.equal(choose(approaching, false).targetSpeedMps, null);
  assert.equal(choose(t => ({ x: -3, z: 1.4 * t })).targetSpeedMps, null);
});

function urgencyWarning() {
  const tailX = [-2.7, -2.66, -2.61, -2.55], tailZ = [0, 0.05, 0.1, -0.05];
  const sample = sequence((timeS) => {
    const index = Math.round(timeS * 10);
    return index < 8 ? { x: -2.7, z: 0 } : { x: tailX[index - 8], z: tailZ[index - 8] };
  }, { count: 12, speed: 3, startZ: -12 });
  const nowS = 1.3, ego = egoAt(nowS, 3, 0, -12);
  return { p: sample.p, ego, nowS, visual: sample.p.snapshot(nowS, ego) };
}

test("corroborated stopping budgets request bounded firm nonzero response, not maximal braking for two points", (t) => {
  const sample = urgencyWarning();
  const choose = (evidence) => decideDistrictVisualSpeed({ ...sampleOf(evidence),
    requestedSpeedMps: 3.8, visionRequired: true });
  const urgent = choose(sample);
  assert.equal(sample.visual.decision.brake, false);
  assert.equal(urgent.state, "slow");
  near(urgent.targetSpeedMps, 1.5);
  assert.ok(urgent.decelerationMps2 > 2 && urgent.decelerationMps2 <= 7);
  near(urgent.nextState.visualDecelerationMps2, urgent.decelerationMps2);
  const command = composed(urgent, mapCap(3), createDistrictSpeedState(), 3.8);
  near(command.decelerationMps2, urgent.decelerationMps2);
  near(integrateVehicle({ x: 0, z: 0, heading: 0, speed: 3 }, command, 0.1).speed,
    3 - urgent.decelerationMps2 * 0.1);
  let body = { x: 0, z: 0, heading: 0, speed: 3 };
  for (let tick = 0; tick < 60; tick++) {
    body = integrateVehicle(body, command, DT);
    assert.ok(body.speed >= 1.5, "a firm positive cap must never masquerade as an unqualified zero");
  }
  const slowerEgo = { ...sample.ego, z: sample.ego.z - 0.1, speedMps: 2 };
  const moderate = choose({ ego: slowerEgo, nowS: sample.nowS,
    visual: sample.p.snapshot(sample.nowS, slowerEgo) });
  assert.ok(moderate.decelerationMps2 > 2 && moderate.decelerationMps2 < 7,
    "actual speed and remaining budgets must produce a graduated request, not unconditional max7");
  t.diagnostic(JSON.stringify({ strongRequestMps2: urgent.decelerationMps2,
    lowerActualSpeedRequestMps2: moderate.decelerationMps2, targetMps: urgent.targetSpeedMps,
    oldestSupportAgeMs: urgent.ageMs }));
  const two = sampleOf(sequence((timeS) => ({ x: -1.8 + 0.9 * timeS, z: 0 }), { startZ: -7 }));
  const ordinary = choose(two);
  near(ordinary.decelerationMps2 ?? 2, 2);
  const weak = structuredClone(sample.visual);
  weak.forecasts.forEach((forecast) => { forecast.confidence = 0.54; });
  near(choose({ ...sampleOf(sample), visual: weak }).decelerationMps2 ?? 2, 2);
  const transient = structuredClone(sample.visual);
  transient.tracks[0].velocity.x = 0;
  assert.equal(choose({ ...sampleOf(sample), visual: transient }).decelerationMps2 ?? 2, 2,
    "a fast local stroke without resolved representative lateral drift stays ordinary");
});

test("optional urgency fields keep absent/null ordinary behavior and reject invalid present values", () => {
  const legacyState = { ...createDistrictSpeedState() };
  delete legacyState.visualDecelerationMps2;
  for (const patch of [{}, { decelerationMps2: null }, { decelerationMps2: 2 }]) {
    near(composed({ ...cap(1.5, "slow"), ...patch }, mapCap(3), legacyState).decelerationMps2, 2);
  }
  const sample = sampleOf(sequence());
  for (const value of [undefined, 0, 1.999, 7.001, -1, NaN, Infinity, "3", false, {}]) {
    assert.throws(() => composed({ ...cap(1.5), decelerationMps2: value }), /[Dd]eceleration/);
    assert.throws(() => decide(sample, { ...createDistrictSpeedState(), visualDecelerationMps2: value }),
      /[Dd]eceleration/);
  }
  for (const value of [null, 2, 7]) {
    assert.doesNotThrow(() => decide(sample, { ...legacyState, visualDecelerationMps2: value }));
  }
  const accessor = { ...cap(1.5) };
  Object.defineProperty(accessor, "decelerationMps2", { get() { throw new Error("must not execute"); } });
  assert.throws(() => composed(accessor), /accessor/);
  assert.throws(() => decide({ ...sample,
    visual: { ...sample.visual, decelerationMps2: 4 } }), /unknown/);
});

test("same-evidence held urgency is serialized but fresh unsupported, missing and qualified evidence cannot inherit it", () => {
  const sample = urgencyWarning(), first = decideDistrictVisualSpeed({ ...sampleOf(sample),
    requestedSpeedMps: 3.8, visionRequired: true });
  const initial = composed(first, mapCap(3), createDistrictSpeedState(), 3.8);
  const state = JSON.parse(JSON.stringify(initial.nextState));
  assert.ok(state.visualDecelerationMps2 > 2);
  const slowEgo = { ...sample.ego, speedMps: 0.5 };
  const heldAtS = sample.nowS + DT;
  const held = decideDistrictVisualSpeed({ visual: sample.p.snapshot(heldAtS, slowEgo),
    ego: slowEgo, nowS: heldAtS, requestedSpeedMps: 3.8, visionRequired: true, previousState: state });
  assert.equal(held.reason, "camera-evidence-hold");
  near(held.decelerationMps2, first.decelerationMps2);
  const heldCommand = composed(held, mapCap(3), state, 3.8);
  near(heldCommand.nextState.visualDecelerationMps2, first.decelerationMps2);
  const unidentified = decideDistrictVisualSpeed({ visual: sample.p.snapshot(heldAtS, slowEgo),
    ego: slowEgo, nowS: heldAtS, requestedSpeedMps: 3.8, visionRequired: true,
    previousState: { ...state, evidenceTrackId: null } });
  assert.equal(unidentified.decelerationMps2, undefined);
  assert.equal(unidentified.nextState.visualDecelerationMps2, null);
  const freshAtS = heldAtS + 0.1;
  sample.p.observe(frame(freshAtS, 12, [], slowEgo));
  const clear = decideDistrictVisualSpeed({ visual: sample.p.snapshot(freshAtS, slowEgo),
    ego: slowEgo, nowS: freshAtS, requestedSpeedMps: 3.8, visionRequired: true,
    previousState: heldCommand.nextState });
  assert.equal(clear.state, "clear");
  assert.equal(clear.decelerationMps2, undefined);
  assert.equal(clear.nextState.visualDecelerationMps2, null);
  near(composed(clear, mapCap(3), heldCommand.nextState, 3.8).decelerationMps2, 2);
  const expiredAtS = state.supportTimeS + 0.751, oldVisual = structuredClone(sample.visual);
  oldVisual.ageMs = (expiredAtS - sample.visual.tracks[0].lastSeenS) * 1000;
  oldVisual.tracks.forEach((track) => { track.ageMs = (expiredAtS - track.lastSeenS) * 1000; });
  const stale = decideDistrictVisualSpeed({ visual: oldVisual, ego: sample.ego, nowS: expiredAtS,
    requestedSpeedMps: 3.8, visionRequired: true, previousState: state });
  assert.equal(stale.state, "unavailable");
  assert.ok(stale.ageMs > 750);
  assert.equal(stale.nextState.visualDecelerationMps2, null);
  near(composed(stale, mapCap(3), state, 3.8).decelerationMps2, 2);
  const unavailable = decideDistrictVisualSpeed({ visual: null, ego: slowEgo, nowS: freshAtS,
    requestedSpeedMps: 3.8, visionRequired: true, previousState: state });
  assert.equal(unavailable.nextState.visualDecelerationMps2, null);
  near(composed(unavailable, mapCap(3), state, 3.8).decelerationMps2, 2);
  const qualified = sampleOf(sequence(undefined, { count: 3 }));
  const stopped = decide(qualified, { ...createDistrictSpeedState(), visualDecelerationMps2: 7 });
  assert.equal(stopped.state, "stop");
  assert.equal(stopped.nextState.visualDecelerationMps2, null);
  assert.equal(composed(stopped).decelerationMps2, undefined);
  const recovering = decideDistrictVisualSpeed({ ...sampleOf(sample), requestedSpeedMps: 3.8,
    visionRequired: true, previousState: { ...createDistrictSpeedState(), state: "unavailable",
      capMps: 0, streamId: STREAM, lastFrameId: 10, lastTimeS: 1.2,
      recoveryFrames: 1, recoverySinceS: 1 } });
  assert.equal(recovering.available, true);
  assert.ok(recovering.targetSpeedMps > 0 && recovering.targetSpeedMps < 1.5);
  assert.equal(recovering.decelerationMps2, undefined);
  near(composed(recovering, mapCap(3)).decelerationMps2, 2);
});

test("urgent camera response follows actual winner, ties and independent full7 guard arbitration", () => {
  const urgent = { ...cap(2, "slow"), decelerationMps2: 5.5 };
  const camera = composed(urgent, mapCap(3));
  near(camera.decelerationMps2, 5.5);
  near(camera.nextState.visualDecelerationMps2, 5.5);
  const map = composed(urgent, mapCap(1.5), camera.nextState);
  assert.equal(map.districtSources.appliedSource, "static-map");
  near(map.decelerationMps2, 2);
  assert.equal(map.nextState.visualDecelerationMps2, null);
  const behavior = composed(urgent, mapCap(3), createDistrictSpeedState(), 1);
  assert.equal(behavior.decelerationMps2, undefined);
  assert.equal(behavior.nextState.visualDecelerationMps2, null);
  const both = composed(urgent, mapCap(2));
  assert.equal(both.districtSources.appliedSource, "both");
  near(both.decelerationMps2, 5.5);
  for (const patch of [{ available: false }, { ageMs: 751 }, { ageMs: null }, { targetSpeedMps: 0.5 },
    { evidenceTrackId: null }, { state: "clear" }]) {
    const unsupported = composed({ ...urgent, ...patch }, mapCap(3), camera.nextState);
    near(unsupported.decelerationMps2, 2);
    assert.equal(unsupported.nextState.visualDecelerationMps2, null);
  }
  const unavailable = composed({ ...urgent, available: false, state: "unavailable", targetSpeedMps: 0 });
  near(unavailable.decelerationMps2, 2);
  const stop = composed({ ...urgent, state: "stop", targetSpeedMps: 0 });
  assert.equal(stop.decelerationMps2, undefined);
  const actual = attributeDistrictApplied({ requested: { targetSpeed: 4.5 }, behavior: { targetSpeed: 4.5 },
    composed: camera, safe: { ...camera, targetSpeed: 1, reason: "yielding", blockedBy: "real-blocker" } });
  assert.equal(actual.districtSources.appliedSource, "physical-guard");
  assert.equal(actual.decelerationMps2, undefined);
  near(integrateVehicle({ x: 0, z: 0, heading: 0, speed: 3 }, actual, 0.1).speed, 2.3);
});

test("unresolved two-frame localization jitter cannot create approach or stale hazard with a fresh camera", (t) => {
  const p = predictor(), pending = [], rows = [];
  let body = { x: 0, z: -12, heading: 0, speed: 2.4, steer: 0, length: 4.2, width: 1.85 };
  let baseline = { ...body }, previousState = createDistrictSpeedState(), twoPointTrack;
  for (let tick = 0; tick <= 90; tick++) {
    const nowS = tick * DT;
    const ego = { x: body.x, z: body.z, headingRad: body.heading,
      speedMps: body.speed, lengthM: body.length, widthM: body.width };
    if (tick % 6 === 0) {
      const positions = tick === 0 ? [{ x: 2.06919, z: 0.2093 }]
        : tick === 6 ? [{ x: 2.03109, z: -0.00556 }] : [];
      pending.push({ applyTick: tick + 12, result: frame(nowS, tick / 6, positions, ego, "person", 0.734) });
    }
    while (pending[0]?.applyTick <= tick) p.observe(pending.shift().result);
    if (tick < 12) {
      body = integrateVehicle(body, { steer: 0, targetSpeed: 2.4 }, DT);
      baseline = integrateVehicle(baseline, { steer: 0, targetSpeed: 2.4 }, DT);
      continue;
    }
    const visual = p.snapshot(nowS, ego);
    twoPointTrack ??= visual.tracks.find((track) => track.observations === 2);
    const decision = decideDistrictVisualSpeed({ visual, ego, nowS, requestedSpeedMps: 3.8,
      visionRequired: true, previousState });
    const command = composeDistrictSpeed({ steer: 0, targetSpeed: 3.8 },
      { visual: decision, map: mapCap(3), dt: DT, previousState });
    previousState = command.nextState;
    body = integrateVehicle(body, command, DT);
    baseline = integrateVehicle(baseline, composeDistrictSpeed({ steer: 0, targetSpeed: 3.8 },
      { map: mapCap(3), dt: DT }), DT);
    rows.push({ nowS, decision, visual, speed: body.speed, baselineSpeed: baseline.speed });
  }
  assert.ok(twoPointTrack);
  const lateralDisplacementM = Math.abs(twoPointTrack.history[1].position.x -
    twoPointTrack.history[0].position.x);
  const endpointPositionBudgetM = 2 * Math.sqrt(twoPointTrack.positionCovarianceM2.xx);
  assert.ok(lateralDisplacementM < endpointPositionBudgetM,
    "overlapping measured position intervals cannot establish a crossing direction");
  t.diagnostic(JSON.stringify({ lateralDisplacementM, endpointPositionBudgetM,
    firstCapS: rows.find((r) => r.decision.targetSpeedMps !== null)?.nowS,
    unavailableS: rows.find((r) => r.decision.state === "unavailable")?.nowS }));
  assert.ok(rows.every((r) => r.visual.available && r.visual.ageMs <= 300));
  assert.ok(rows.every((r) => r.decision.available && r.decision.state === "clear" &&
    r.decision.targetSpeedMps === null), "never-supported motion must not become an aged hazard");
  assert.ok(rows.every((r) => r.speed >= r.baselineSpeed * 0.8 - 1e-8));
});

test("resolved two-frame displacement retains positive caution at three camera yaws", () => {
  for (const heading of [0, Math.PI / 2, 0.63]) {
    const sample = sequence((timeS) => rotated(-4.8 + 1.5 * timeS, 0, heading),
      { speed: 3, heading, startZ: -12, intervalS: 0.2 });
    const result = decide(sampleOf(sample));
    assert.equal(sample.visual.tracks[0].observations, 2);
    assert.equal(sample.visual.decision.brake, false);
    assert.equal(result.state, "caution");
    assert.ok(result.targetSpeedMps > 0 && result.targetSpeedMps < 4.5);
    near(composed(result).decelerationMps2, 2);
  }
});

test("recent directional motion uses enough measured history without borrowing an obsolete approach", () => {
  for (const heading of [0, Math.PI / 2, 0.63]) {
    const p = predictor(), tailX = [-2.7, -2.66, -2.61, -2.55], tailZ = [0, 0.05, 0.1, -0.05];
    for (let i = 0; i < 12; i++) {
      const position = i < 8 ? rotated(-2.7, 0, heading) : rotated(tailX[i - 8], tailZ[i - 8], heading);
      p.observe(frame(i * 0.1, i, [position], egoAt(i * 0.1, 3, heading, -12), "person", 0.9));
    }
    const ego = egoAt(1.3, 3, heading, -12), visual = p.snapshot(1.3, ego);
    const track = visual.tracks[0], c = Math.cos(heading), s = Math.sin(heading);
    const covariance = track.positionCovarianceM2;
    const lateralVariance = c * c * covariance.xx - 2 * c * s * covariance.xz + s * s * covariance.zz;
    const addedVariance = Math.max(0, 0.04 ** 2 - lateralVariance);
    covariance.xx += addedVariance * c * c;
    covariance.xz -= addedVariance * c * s;
    covariance.zz += addedVariance * s * s;
    track.uncertaintyM = Math.max(track.uncertaintyM, Math.sqrt(covariance.xx + covariance.zz));
    assert.equal(visual.decision.brake, false);
    const result = decideDistrictVisualSpeed({ visual, ego, nowS: 1.3,
      requestedSpeedMps: 3.8, visionRequired: true });
    assert.equal(result.state, "slow");
    assert.ok(result.targetSpeedMps > 0 && result.targetSpeedMps < 3);
    near(result.ageMs, 500);
    const atBound = decideDistrictVisualSpeed({ visual: { ...visual, ageMs: 450 }, ego, nowS: 1.55,
      requestedSpeedMps: 3.8, visionRequired: true });
    near(atBound.ageMs, 750);
    assert.equal(atBound.available, true);
    const stale = decideDistrictVisualSpeed({ visual: { ...visual, ageMs: 451 }, ego, nowS: 1.551,
      requestedSpeedMps: 3.8, visionRequired: true });
    assert.equal(stale.state, "unavailable");
    near(stale.ageMs, 751);
    p.observe(frame(1.4, 12, [rotated(-2.85, 0, heading)], egoAt(1.4, 3, heading, -12), "person", 0.9));
    const awayEgo = egoAt(1.4, 3, heading, -12), awayVisual = p.snapshot(1.4, awayEgo);
    assert.equal(awayVisual.decision.brake, false);
    const away = decideDistrictVisualSpeed({ visual: awayVisual, ego: awayEgo, nowS: 1.4,
      requestedSpeedMps: 3.8, visionRequired: true });
    assert.equal(away.targetSpeedMps, null, "a resolved recent away direction must win over older inward history");
  }
});

test("resolved lateral motion cannot turn uncertain longitudinal closing into known approach", () => {
  const sample = sequence((timeS) => ({ x: -3.5 + timeS, z: 2 * timeS }),
    { speed: 3, startZ: -7, intervalS: 0.2 });
  const visual = structuredClone(sample.visual), track = visual.tracks[0];
  track.positionCovarianceM2.zz += 0.04;
  track.uncertaintyM = Math.max(track.uncertaintyM,
    Math.sqrt(track.positionCovarianceM2.xx + track.positionCovarianceM2.zz));
  assert.equal(visual.decision.brake, false);
  const result = decideDistrictVisualSpeed({ visual, ego: sample.ego, nowS: sample.nowS,
    requestedSpeedMps: 3.8, visionRequired: true });
  assert.equal(result.targetSpeedMps, null);
});

test("person slowing budgets current stopping time, not a fraction of a higher requested speed", (t) => {
  const sample = sequence((t) => ({ x: -2.5 + t, z: 0 }), { speed: 3, startZ: -7 });
  const choose = (evidence, requestedSpeedMps) => decideDistrictVisualSpeed({
    ...sampleOf(evidence), requestedSpeedMps, visionRequired: true,
  });
  const fresh = choose(sample, 3.8);
  assert.equal(sample.visual.decision.brake, false);
  assert.equal(fresh.state, "slow");
  assert.ok(fresh.targetSpeedMps > 0);
  const laneHalfM = sample.ego.widthM / 2 + 0.35;
  const nominalEntryS = (2.4 - laneHalfM) / 1;
  assert.ok(fresh.targetSpeedMps / 2 <= nominalEntryS,
    "the graded target must leave an ordinary-braking stopping-time budget");
  near(choose(sample, 8).targetSpeedMps, fresh.targetSpeedMps);
  near(choose(sample, 1).targetSpeedMps, 1);
  const command = composeDistrictSpeed({ steer: 0, targetSpeed: 3.8 },
    { visual: fresh, map: mapCap(3), dt: 0.1 });
  near(command.decelerationMps2, 2);
  near(integrateVehicle({ x: 0, z: -6.7, heading: 0, speed: 3 }, command, 0.1).speed, 2.8);

  const ego = egoAt(0.35, 3, 0, -7);
  const delayed = choose({ ego, visual: sample.p.snapshot(0.35, ego), nowS: 0.35 }, 3.8);
  near(fresh.targetSpeedMps, 1.5);
  near(delayed.targetSpeedMps, 1.5);
  near(delayed.ageMs, 350);
  near(sample.visual.latencyMs, 20);
  const withMargin = sequence((timeS) => ({ x: -3.5 + timeS, z: 0 }),
    { speed: 3, startZ: -7, intervalS: 0.2 });
  const marginFresh = choose(withMargin, 3.8);
  const marginEgo = egoAt(0.45, 3, 0, -7);
  const marginDelayed = choose({ ego: marginEgo, visual: withMargin.p.snapshot(0.45, marginEgo),
    nowS: 0.45 }, 3.8);
  assert.ok(marginFresh.targetSpeedMps > 1.5 && marginDelayed.targetSpeedMps >= 1.5 &&
    marginDelayed.targetSpeedMps < marginFresh.targetSpeedMps,
    "capture delay consumes a resolved stopping-time margin before the positive floor saturates");
  near(marginDelayed.ageMs, 450);
  t.diagnostic(JSON.stringify({ actualMps: sample.ego.speedMps, requestedMps: 3.8,
    freshCapMps: fresh.targetSpeedMps, delayedCapMps: delayed.targetSpeedMps,
    marginFreshCapMps: marginFresh.targetSpeedMps, marginDelayedCapMps: marginDelayed.targetSpeedMps }));
});

test("person slowing also reserves current ordinary stopping distance for a short forward body gap", () => {
  const shortGap = sequence((t) => ({ x: -3 + t, z: -3.5 }), { speed: 3, startZ: -7 });
  const spatial = decideDistrictVisualSpeed({
    ...sampleOf(shortGap), requestedSpeedMps: 3.8, visionRequired: true,
  });
  assert.equal(shortGap.visual.decision.brake, false);
  assert.equal(spatial.state, "slow");
  assert.ok(spatial.targetSpeedMps > 0);
  const availableGapM = -3.5 - shortGap.ego.z - shortGap.ego.lengthM / 2 - 0.35;
  assert.ok(spatial.targetSpeedMps ** 2 / (2 * 2) <= availableGapM,
    "the graded target must also leave an ordinary-braking stopping-distance budget");
});

for (const [side, delayTicks, initialGapM] of [-1, 1].flatMap((side) =>
  [[12, 12], [15, 12], [18, 12], [9, 10], [12, 10], [15, 10]]
    .map(([delay, gap]) => [side, delay, gap]))) {
  test(`actual plant stops before real reactive baseline from side ${side}, gap${initialGapM}m, delay${delayTicks * DT}s`, (t) => {
    const p = predictor(), pending = [], rows = [];
    let body = { id: "visual-car", type: "vehicle", x: 0, z: -initialGapM, heading: 0,
      speed: 3, steer: 0, length: 4.2, width: 1.85, path: [], cursor: 0 };
    let baseline = { ...body, id: "baseline-car" }, firstBaselineReactiveS = null;
    let firstBaselineReactiveDecisionS = null;
    let previousState = createDistrictSpeedState();
    const personAt = (timeS) => {
      const elapsedS = Math.max(0, timeS - 1);
      const accelerationS = Math.min(elapsedS, 1.2 / 2.5);
      const displacementM = 0.5 * 2.5 * accelerationS ** 2 +
        1.2 * Math.max(0, elapsedS - accelerationS);
      return { x: side * (2.7 - displacementM), z: 0 };
    };
    const guarded = (car, command, nowS) => safeSpeed({
      environment: "egypt", junctionGroups: [], junctionOwners: new Map(),
      actorIndex: new SpatialIndex([car, { ...personAt(nowS), id: "crossing-person",
        type: "pedestrian", radius: 0.35 }]),
      staticIndex: new SpatialIndex([]),
    }, car, command);
    for (let tick = 0; tick < 200; tick++) {
      const nowS = tick * DT;
      const ego = { x: body.x, z: body.z, headingRad: body.heading,
        speedMps: body.speed, lengthM: body.length, widthM: body.width };
      if (tick % 6 === 0)
        pending.push({ applyTick: tick + delayTicks, result: frame(nowS, tick / 6, [personAt(nowS)], ego, "person", 0.9) });
      while (pending[0]?.applyTick <= tick) p.observe(pending.shift().result);
      if (tick < delayTicks) {
        body = integrateVehicle(body, { steer: 0, targetSpeed: 3 }, DT);
        baseline = integrateVehicle(baseline, { steer: 0, targetSpeed: 3 }, DT);
        continue;
      }
      const visual = p.snapshot(nowS, ego);
      const decision = decideDistrictVisualSpeed({ visual, ego, nowS, requestedSpeedMps: 3.8,
        visionRequired: true, previousState });
      const command = composeDistrictSpeed({ steer: 0, targetSpeed: 3.8 },
        { visual: decision, map: mapCap(3), dt: DT, previousState });
      previousState = command.nextState;
      const applied = attributeDistrictApplied({ requested: { targetSpeed: 3.8 },
        behavior: { targetSpeed: 3.8 }, composed: command, safe: guarded(body, command, nowS) });
      body = integrateVehicle(body, applied, DT);
      const baselineCommand = composeDistrictSpeed({ steer: 0, targetSpeed: 3.8 },
        { map: mapCap(3), dt: DT });
      const baselineSafe = guarded(baseline, baselineCommand, nowS);
      if (firstBaselineReactiveS === null && baselineSafe.targetSpeed < baselineCommand.targetSpeed - 0.05) {
        firstBaselineReactiveDecisionS = nowS;
        firstBaselineReactiveS = nowS + DT;
      }
      baseline = integrateVehicle(baseline, baselineSafe, DT);
      rows.push({ timeS: nowS + DT, decision, visual, command, speed: body.speed,
        entered: Math.abs(personAt(nowS + DT).x) <= body.width / 2 + 0.35,
        appliedSource: applied.districtSources.appliedSource });
    }
    const graded = rows.find((r) => r.decision.state === "slow" &&
      r.decision.targetSpeedMps > 0 && r.decision.targetSpeedMps < 3);
    const qualified = rows.find((r) => r.decision.state === "stop");
    const stopped = rows.find((r) => r.speed === 0);
    const entry = rows.find((r) => r.entered);
    t.diagnostic(JSON.stringify({ side, initialGapM, delayS: delayTicks * DT,
      gradedAtS: graded?.timeS, gradedCapMps: graded?.decision.targetSpeedMps,
      qualifiedAtS: qualified?.timeS, stoppedAtS: stopped?.timeS, laneEntryS: entry?.timeS,
      baselineReactiveS: firstBaselineReactiveS, baselineReactiveDecisionS: firstBaselineReactiveDecisionS }));
    assert.ok(graded && qualified && stopped && entry);
    assert.ok(graded.timeS < qualified.timeS);
    assert.equal(graded.visual.decision.brake, false);
    near(graded.command.decelerationMps2, graded.decision.decelerationMps2 ?? 2);
    assert.ok(graded.visual.ageMs >= delayTicks * DT * 1000 - 1e-8);
    near(graded.visual.latencyMs, 20);
    assert.equal(qualified.visual.decision.brake, true);
    assert.equal(qualified.decision.targetSpeedMps, 0);
    assert.equal(qualified.command.decelerationMps2, undefined);
    assert.ok(stopped.timeS < entry.timeS, "complete physical zero must precede actual near-side entry");
    assert.ok(firstBaselineReactiveDecisionS !== null && stopped.timeS < firstBaselineReactiveDecisionS,
      "complete physical zero must precede the same-map baseline's actual reactive-guard onset");
    assert.ok(rows.filter((r) => r.timeS <= stopped.timeS)
      .every((r) => r.appliedSource !== "physical-guard"), "a guard-assisted stop is not a visual causal success");
    assert.ok(rows.every((r) => r.decision.state !== "unavailable"),
      "ordinary camera loss must not substitute for the qualified visual stop");
  });
}

for (const [name, position, options] of [
  ["stationary curb", () => ({ x: -1.8, z: 0 })],
  ["parallel", (t) => ({ x: -1.8, z: t })],
  ["away", (t) => ({ x: -1.8 - t, z: 0 })],
  ["disjoint arrival", (t) => ({ x: -4.8 + 0.9 * t, z: 0 }), { speed: 0.5 }],
]) {
  test(`${name} lookalike is not slowed below 0.8 of the identical-map baseline`, () => {
    const sample = sequence(position, { count: 6, ...options });
    const result = decide(sampleOf(sample));
    const predictive = composed(result, mapCap(3.2));
    const baseline = composed(decide(sampleOf(sample), createDistrictSpeedState(), false), mapCap(3.2));
    assert.notEqual(result.state, "stop");
    assert.equal(result.targetSpeedMps, null);
    assert.ok(predictive.targetSpeed >= baseline.targetSpeed * 0.8);
    let a = { x: 0, z: 0, heading: 0, speed: 4.5 }, b = { ...a };
    for (let i = 0; i < 120; i++) {
      a = integrateVehicle(a, predictive, DT);
      b = integrateVehicle(b, baseline, DT);
      assert.ok(a.speed >= b.speed * 0.8 - 1e-8, "compare actual plant speeds, not just cap labels");
    }
  });
}

test("an actually observed vehicle permits bounded view caution, not an invented hidden crossing", () => {
  const sample = sequence(() => ({ x: -2, z: -12 }), { label: "vehicle" });
  const result = decide(sampleOf(sample));
  assert.equal(result.state, "caution");
  assert.equal(result.reason, "observed-vehicle-view-caution");
  assert.ok(result.targetSpeedMps >= 4.5 * 0.8 && result.targetSpeedMps > 0);
});

test("vehicle view caution ages the current observation, not an unused motion fit", () => {
  const { p, ego } = sequence(() => ({ x: -2, z: -12 }),
    { count: 3, intervalS: 0.25, speed: 0, label: "vehicle" });
  const current = decide({ visual: p.snapshot(0.9, ego), ego, nowS: 0.9 });
  assert.equal(current.reason, "observed-vehicle-view-caution");
  assert.equal(current.available, true);
  near(current.ageMs, 400);
  near(current.targetSpeedMps, 4.05);

  p.observe(frame(0.85, 3, [], ego, "vehicle"));
  const absent = decide({ visual: p.snapshot(0.95, ego), ego, nowS: 0.95 }, current.nextState);
  assert.equal(absent.available, true);
  assert.equal(absent.evidenceTrackId, null);
  assert.equal(absent.reason, "camera-cap-release");
});

test("person slowing respects the tracker's motion reliability veto", () => {
  const sample = sampleOf(sequence((t) => ({ x: -1.8 + 0.9 * t, z: 0 }), { startZ: -7 }));
  assert.equal(decide(sample).state, "slow");
  sample.visual.tracks[0].reliable = false;
  const result = decide(sample);
  assert.equal(result.available, true);
  assert.equal(result.state, "clear");
  assert.equal(result.targetSpeedMps, null);
});

test("a fresh newest frame cannot renew old support; the actual oldest used frame has a 750ms boundary", () => {
  const { p, ego } = sequence((timeS) => ({ x: -1.8 + 0.9 * timeS, z: 0 }), { startZ: -7 });
  assert.equal(decide({ visual: p.snapshot(0.1, ego), ego, nowS: 0.1 }).state, "slow");
  p.observe(frame(0.75, 2, [], ego));
  const atBound = decide({ visual: p.snapshot(0.75, ego), ego, nowS: 0.75 });
  assert.equal(atBound.available, true);
  near(atBound.ageMs, 750);
  p.observe(frame(0.751, 3, [], ego));
  const stale = decide({ visual: p.snapshot(0.751, ego), ego, nowS: 0.751 });
  assert.equal(stale.state, "unavailable");
  assert.equal(stale.targetSpeedMps, 0);
  assert.equal(stale.reason, "camera-support-stale");
  near(stale.ageMs, 751);
});

test("missing NN explicitly holds target0 with ordinary2 while sensors-only does not acquire an NN cap", () => {
  const ego = egoAt();
  const missing = decide({ visual: null, ego, nowS: 0 });
  assert.equal(missing.state, "unavailable");
  assert.equal(missing.ageMs, null, "unknown evidence age must never default to zero");
  assert.equal(missing.targetSpeedMps, 0);
  const command = composed(missing);
  const actual = attributeDistrictApplied({ requested: command, behavior: command, composed: command, safe: command });
  near(actual.decelerationMps2, 2);
  let body = { x: 0, z: 0, heading: 0, speed: 4.5 };
  near(integrateVehicle(body, actual, 0.1).speed, 4.3);
  for (let i = 0; i < 135; i++) {
    const before = body.speed;
    body = integrateVehicle(body, actual, DT);
    assert.ok(body.speed >= 0);
    near(before - body.speed, Math.min(before, 2 * DT));
  }
  near(body.speed, 0);
  const guarded = attributeDistrictApplied({ requested: { targetSpeed: 4.5 },
    behavior: { targetSpeed: 4.5 }, composed: command,
    safe: { ...command, targetSpeed: 0, reason: "yielding", blockedBy: "real-blocker",
      decelerationMps2: undefined } });
  assert.equal(guarded.districtSources.appliedSource, "physical-guard");
  assert.equal("decelerationMps2" in guarded, false);
  assert.equal(guarded.reason, "yielding");
  near(integrateVehicle({ x: 0, z: 0, heading: 0, speed: 4.5 }, guarded, 0.1).speed, 3.8);
  const baseline = decide({ visual: null, ego, nowS: 0 }, createDistrictSpeedState(), false);
  assert.equal(baseline.targetSpeedMps, null);
  assert.equal(composed(baseline).targetSpeed, 4.5);
  assert.equal(composed(baseline, mapCap(2)).targetSpeed, 2);
});

test("recovery requires two distinct actual frames spanning .1s, not two ticks or receipt time", () => {
  const p = predictor(), ego = egoAt(0, 0);
  let previousState = decide({ visual: null, ego, nowS: 0 }).nextState;
  const observe = (nowS, frameId, capture = true) => {
    if (capture) p.observe(frame(nowS, frameId, [], ego));
    const result = decide({ visual: p.snapshot(nowS, ego), ego, nowS }, previousState);
    previousState = result.nextState;
    return result;
  };
  assert.equal(observe(0.1, 1).state, "unavailable");
  assert.equal(observe(0.18, 1, false).state, "unavailable");
  assert.equal(observe(0.19, 2).state, "unavailable");
  assert.equal(observe(0.195, 2, false).state, "unavailable");
  const recovered = observe(0.2, 3);
  assert.equal(recovered.available, true);
  assert.ok(recovered.targetSpeedMps > 0 && recovered.targetSpeedMps <= 2.4 * 0.005 + 1e-8);
});

test("strict visual boundary rejects truth, map, getters and contamination nested in pixel tracks/forecasts/state", () => {
  const sample = sampleOf(sequence());
  for (const key of ["world", "actors", "map", "zones", "seed", "caseId", "intent"]) {
    assert.throws(() => decide({ ...sample, [key]: {} }), /unknown/);
    assert.throws(() => decide({ ...sample, ego: { ...sample.ego, [key]: {} } }), /unknown/);
    assert.throws(() => decide({ ...sample, visual: { ...sample.visual, [key]: {} } }), /unknown/);
    const state = { ...createDistrictSpeedState(), [key]: {} };
    assert.throws(() => decide(sample, state), /unknown/);
  }
  for (const mutate of [
    (v) => { v.tracks[0].actorId = "hidden-actor"; },
    (v) => { v.tracks[0].history[0].position.intent = "cross"; },
    (v) => { v.tracks[0].velocityCovarianceM2S2.world = {}; },
    (v) => { v.forecasts[0].futurePath = []; },
    (v) => { v.forecasts[0].longitudinalArrivalS = { actorId: "private" }; },
    (v) => { v.decision.actorId = "private"; },
  ]) {
    const visual = structuredClone(sample.visual);
    mutate(visual);
    assert.throws(() => decide({ ...sample, visual }), /unknown/);
  }
  const withGetter = { ...sample, requestedSpeedMps: 4.5, visionRequired: true };
  Object.defineProperty(withGetter, "world", { get() { throw new Error("must not execute"); } });
  assert.throws(() => decideDistrictVisualSpeed(withGetter), /unknown|accessor/);
  for (const mutate of [
    (v) => { v.model.id = { actor: "private" }; },
    (v) => { v.forecasts[0].reason = { future: [] }; },
    (v) => { v.forecasts[0].confidence = { actorId: "private" }; },
    (v) => { v.decision.reason = { intent: "private" }; },
    (v) => { v.availability.error = { world: {} }; },
  ]) {
    const visual = structuredClone(sample.visual);
    mutate(visual);
    assert.throws(() => decide({ ...sample, visual }), /Invalid|nonempty|finite/);
  }
});

test("hidden-actor invariance is exact, snapshot inputs are immutable and memory is serializable/deterministic", () => {
  const sample = freeze(sampleOf(sequence()));
  const state = freeze(createDistrictSpeedState());
  const worlds = [
    { actors: [{ x: -2, z: -3, intent: "cross" }], seed: "different-a" },
    { actors: [], seed: "different-b" },
  ];
  const decisions = worlds.map(() => decide(sample, state));
  assert.deepEqual(decisions[0], decisions[1]);
  assert.deepEqual(decisions[0], decide(sample, JSON.parse(JSON.stringify(state))));
  assert.notEqual(decisions[0].nextState, state);
  const wrongStream = structuredClone(sample.visual);
  wrongStream.streamId = "another-stream";
  assert.equal(decide({ ...sample, visual: wrongStream }).state, "unavailable");
});

test("unchanged observation cannot cause repeated >.3m/s cap direction reversals as own speed changes", () => {
  const sample = sampleOf(sequence((timeS) => ({ x: -1.8 + 0.9 * timeS, z: 0 }), { startZ: -7 }));
  let state = createDistrictSpeedState();
  const caps = [];
  let gradedDecisions = 0;
  for (let i = 0; i < 180; i++) {
    const nowS = 0.1 + i * DT;
    const visual = structuredClone(sample.visual);
    visual.ageMs = (nowS - 0.1) * 1000;
    for (const track of visual.tracks) track.ageMs = (nowS - track.lastSeenS) * 1000;
    const result = decide({ visual, ego: { ...sample.ego, speedMps: i % 2 ? 0.5 : 4.5 }, nowS }, state);
    if (["caution", "slow"].includes(result.state)) {
      gradedDecisions++;
      assert.equal(result.evidenceTrackId, sample.visual.tracks[0].id);
    }
    caps.push(result.targetSpeedMps ?? 4.5);
    state = JSON.parse(JSON.stringify(result.nextState));
  }
  let extreme = caps[0], direction = 0, reversals = 0;
  for (const value of caps.slice(1)) {
    if (!direction && Math.abs(value - extreme) > 0.3) direction = Math.sign(value - extreme);
    if ((direction > 0 && value > extreme) || (direction < 0 && value < extreme)) extreme = value;
    if (direction && (value - extreme) * direction < -0.3) {
      reversals++;
      direction *= -1;
      extreme = value;
    }
  }
  assert.ok(gradedDecisions > 0, "exercise an actually resolved cap, not an always-clear fixture");
  assert.ok(reversals <= 1, `observed ${reversals} reversals`);
});

test("static map has heading/lateral/approach gates, a positive floor and genuine post-corner release", () => {
  const zone = { id: "literal-corner", x: 0, z: 0, heading: 0,
    approachM: 12, clearanceM: 3, visibilityDistanceM: 1, speedLimitMps: 2 };
  const mapAt = (patch = {}) => mappedDistrictSpeed({ zones: [zone],
    ego: { ...egoAt(0, 4.5, 0, -4), ...patch } });
  const active = mapAt();
  assert.equal(active.source, "static-map");
  assert.equal(active.reason, "mapped-blind-corner");
  assert.ok(active.targetSpeedMps >= 1.5 && active.targetSpeedMps <= 2);
  for (const patch of [{ headingRad: Math.PI }, { headingRad: 0.71 }, { x: 4.01 }, { z: -12.01 }])
    assert.equal(mapAt(patch).targetSpeedMps, null);
  assert.ok(mapAt({ z: 2.99 }).targetSpeedMps >= 1.5);
  assert.equal(mapAt({ z: 3 }).targetSpeedMps, null);
  assert.throws(() => mappedDistrictSpeed({ zones: [zone], ego: egoAt(), actors: [] }), /unknown/);
  assert.throws(() => mappedDistrictSpeed({ zones: [{ ...zone, hiddenPerson: true }], ego: egoAt() }), /unknown/);
});

test("composed nextState bounds map release at2.4 independent of NN mode and actual physical speed", () => {
  const noNN = decide({ visual: null, ego: egoAt(), nowS: 0 }, createDistrictSpeedState(), false);
  const before = composed(noNN, mapCap(1.5));
  const released = composed(noNN, mapCap(null), before.nextState);
  near(released.targetSpeed, 1.5 + 2.4 * DT);
  assert.equal(released.districtSources.appliedSource, "static-map");
  assert.equal(released.districtSources.map.reason, "mapped-caution-release");
  near(released.nextState.mapCapMps, released.targetSpeed);
  const missingMap = composed(noNN, null, before.nextState);
  near(missingMap.targetSpeed, released.targetSpeed);
  assert.equal(missingMap.districtSources.map.available, false);
  assert.throws(() => composeDistrictSpeed({ targetSpeed: 4.5 },
    { visual: noNN, map: null, dt: DT, previousSpeedMps: 10 }), /unknown/);
});

test("B1 actual after-guard attribution preserves winning reasons/blockedBy and independent full7 braking", () => {
  const requested = { steer: 0, targetSpeed: 8, reason: "normal-route", blockedBy: null };
  const behavior = { ...requested, targetSpeed: 6, reason: "single-lane-ticket", blockedBy: "passage" };
  const composition = composeDistrictSpeed(behavior,
    { visual: cap(5), map: mapCap(4), dt: DT, previousState: createDistrictSpeedState() });
  assert.equal(composition.districtSources.appliedSource, "static-map");
  near(composition.decelerationMps2, 2);
  const safe = { ...composition, targetSpeed: 2, reason: "yielding", blockedBy: "actual-blocker" };
  const actual = attributeDistrictApplied({ requested, behavior, composed: composition, safe });
  assert.equal(actual.targetSpeed, 2);
  assert.equal(actual.reason, "yielding");
  assert.equal(actual.blockedBy, "actual-blocker");
  assert.equal(actual.districtSources.appliedSource, "physical-guard");
  assert.equal(actual.districtSources.requestedMps, 8);
  assert.equal(actual.districtSources.behaviorMps, 6);
  assert.equal(actual.districtSources.composedMps, 4);
  assert.equal(actual.districtSources.finalMps, 2);
  assert.equal(actual.decelerationMps2, undefined);
  near(integrateVehicle({ x: 0, z: 0, heading: 0, speed: 5 }, actual, 0.1).speed, 4.3);
  const noExtraGuard = attributeDistrictApplied({ requested, behavior,
    composed: composition, safe: { ...composition, reason: "driving", blockedBy: null } });
  assert.equal(noExtraGuard.reason, "mapped-blind-corner");
  assert.equal(noExtraGuard.blockedBy, "static-corner");
  near(noExtraGuard.decelerationMps2, 2);
  const stop = attributeDistrictApplied({ requested, behavior, composed: composition,
    safe: { ...composition, targetSpeed: 0, reason: "yielding", blockedBy: "actual-blocker" } });
  assert.equal(stop.decelerationMps2, undefined);
  near(integrateVehicle({ x: 0, z: 0, heading: 0, speed: 5 }, stop, 0.1).speed, 4.3);
});

test("camera/map ties are both; tighter upstream behavior and normal requests retain their actual source", () => {
  const tie = composed(cap(3), mapCap(3));
  assert.equal(tie.districtSources.appliedSource, "both");
  assert.equal(tie.targetSpeed, 3);
  assert.equal("nextState" in tie.districtSources.visual, false);
  const requested = { targetSpeed: 6, reason: "route" };
  const behavior = { targetSpeed: 2, reason: "loading-queue", blockedBy: "front-car" };
  const composition = composeDistrictSpeed(behavior, { visual: cap(3), map: mapCap(3), dt: DT });
  const actual = attributeDistrictApplied({ requested, behavior, composed: composition, safe: composition });
  assert.equal(actual.districtSources.appliedSource, "behavior");
  assert.equal(actual.reason, "loading-queue");
  assert.equal(actual.blockedBy, "front-car");
  const normal = composed(null);
  assert.equal(attributeDistrictApplied({ requested: normal, behavior: normal, composed: normal,
    safe: normal }).districtSources.appliedSource, "requested");
  const pathCommand = { steer: 0.1, targetSpeed: 4.5, cursor: 3, remaining: 20 };
  const pathComposed = composeDistrictSpeed(pathCommand, { visual: null, map: null, dt: DT });
  const pathApplied = attributeDistrictApplied({ requested: pathCommand, behavior: pathCommand,
    composed: pathComposed, safe: { ...pathComposed, reason: "driving", blockedBy: null } });
  assert.equal(pathApplied.reason, "driving");
  assert.equal(pathApplied.blockedBy, null);
  const tinyGuard = attributeDistrictApplied({ requested: tie, behavior: tie, composed: tie,
    safe: { ...tie, targetSpeed: 2.98 } });
  assert.equal(tinyGuard.decelerationMps2, undefined, "even a sub-attribution-threshold physical reduction must not inherit soft braking");
});

test("explicit deceleration is validated against actual spec; no-field plant is exactly the frozen c62 trace", () => {
  const body = { x: 0, z: 0, heading: 0, speed: 5, maxSpeed: 8, spec: { braking: 3 } };
  for (const decelerationMps2 of [undefined, null, 0, -1, NaN, Infinity, 3.01])
    assert.throws(() => integrateVehicle(body, { targetSpeed: 0, decelerationMps2 }, DT), /deceleration/);
  assert.throws(() => integrateVehicle({ ...body, spec: { braking: NaN } },
    { targetSpeed: 0, decelerationMps2: 2 }, DT), /deceleration/);
  near(integrateVehicle(body, { targetSpeed: 0, decelerationMps2: 2 }, 0.1).speed, 4.8);
  near(integrateVehicle(body, { targetSpeed: 0 }, 0.1).speed, 4.7);
  let car = { id: "golden", type: "vehicle", x: 0, z: 0, heading: 0, speed: 0, steer: 0,
    length: 4.2, width: 1.85, maxSpeed: 8 };
  const trace = [];
  for (let i = 0; i < 600; i++) {
    car = integrateVehicle(car, { targetSpeed: i < 300 ? 5 : 0, steer: i < 150 ? 0 : 0.3 }, DT);
    trace.push(car);
  }
  const expected = JSON.parse(readFileSync(new URL("./fixtures/district-legacy-golden.json", import.meta.url))).vehicle;
  assert.equal(createHash("sha256").update(JSON.stringify(trace)).digest("hex"), expected);
});

function districtStopFeedback(weakUntilS = 4.2) {
  const p = predictor(), rows = [];
  let body = { x: 0, z: -22, heading: 0, speed: 4.5, steer: 0, length: 4.2, width: 1.85 };
  let previousState = createDistrictSpeedState();
  for (let tick = 0; tick <= 510; tick++) {
    const nowS = tick * DT;
    const ego = { x: body.x, z: body.z, headingRad: body.heading,
      speedMps: body.speed, lengthM: body.length, widthM: body.width };
    if (tick % 6 === 0) {
      const position = { x: -4.8 + 0.9 * Math.max(0, nowS - 0.65), z: 0 };
      p.observe(frame(nowS, tick / 6, nowS < 2.1 || tick === 156 || tick === 162 ? [] : [position], ego,
        "person", nowS >= 2.5 && nowS < weakUntilS ? 0.4 : 0.9));
    }
    const visual = p.snapshot(nowS, ego);
    const decision = decide({ visual, ego, nowS }, previousState);
    const command = composed(decision, null, previousState);
    previousState = command.nextState;
    body = integrateVehicle(body, command, DT);
    rows.push({ nowS, decision, visual, speed: body.speed });
  }
  return rows;
}

test("actual predictor-policy-plant holds the original stop across a long weak-support identity gap", () => {
  const rows = districtStopFeedback();
  const firstRequest = rows.find((r) => r.decision.state === "stop");
  assert.ok(firstRequest);
  const firstStop = rows.find((r) => r.nowS >= firstRequest.nowS && r.speed < 0.05);
  const entryS = 0.65 + (4.8 - (1.85 / 2 + 0.35)) / 0.9;
  assert.ok(firstStop && firstStop.nowS < entryS);
  assert.ok(firstStop.nowS - firstRequest.nowS <= 4.5 / 7 + DT);
  const originId = firstRequest.decision.evidenceTrackId;
  const committed = rows.filter((r) => r.nowS >= firstRequest.nowS);
  assert.ok(committed.every((r) => r.decision.targetSpeedMps === 0 &&
    r.decision.evidenceTrackId === originId));
  assert.ok(committed.some((r) => r.decision.reason === "committed-visual-stop"));
  assert.equal(rows.find((r) => r.nowS >= 3.2).decision.state, "unavailable");
  assert.ok(rows.find((r) => r.nowS >= 3.2).decision.ageMs > 750);
  const weak = rows.filter((r) => r.nowS >= 2.5 && r.nowS < 4.2);
  assert.ok(weak.every((r) => r.visual.tracks.find((track) => track.id === originId)?.frameId === 24));
  assert.ok(rows.at(-1).visual.tracks.some((track) => track.id !== originId),
    "fresh later detections do not certify clearance of the lost original identity");
  assert.equal(rows.some((r) => r.visual.tracks.some((track) =>
    track.id === originId && track.stopEpisode?.phase === "cleared")), false);
  const staleAt = rows.find((r) => r.decision.state === "stop");
  const staleVisual = structuredClone(staleAt.visual);
  staleVisual.ageMs = 751;
  const stale = decide({ visual: staleVisual, ego: staleAt.visual.tracks[0].stopEpisode.referenceEgo,
    nowS: staleAt.nowS + 0.751 }, staleAt.decision.nextState);
  assert.equal(stale.state, "unavailable");
  assert.equal(stale.targetSpeedMps, 0);
});

test("actual predictor-policy-plant releases only admitted same-track clearance after a bounded weak interval", () => {
  const rows = districtStopFeedback(2.9);
  const firstRequest = rows.find((r) => r.decision.state === "stop");
  const firstStop = rows.find((r) => firstRequest && r.nowS >= firstRequest.nowS && r.speed === 0);
  const release = rows.find((r) => r.visual.decision.reason === "visual-clearance-confirmed");
  assert.ok(firstRequest && firstStop && release && release.nowS > firstStop.nowS);
  const originId = firstRequest.decision.evidenceTrackId;
  assert.equal(release.visual.tracks.find((track) => track.id === originId)?.stopEpisode?.phase, "cleared");
  const committed = rows.filter((r) => r.nowS >= firstRequest.nowS && r.nowS < release.nowS);
  assert.ok(committed.every((r) => r.decision.state === "stop" && r.decision.targetSpeedMps === 0));
  const weak = rows.filter((r) => r.nowS >= 2.5 && r.nowS < 2.9);
  assert.ok(weak.every((r) => r.visual.tracks.find((track) => track.id === originId)?.frameId === 24));
  assert.ok(rows.some((r) => r.nowS > release.nowS && r.speed > 0.2));
});

class Element {
  constructor(tag, document) {
    this.tagName = tag; this.document = document; this.children = [];
    this.dataset = {}; this.listeners = new Map(); this.textContent = "";
    this.context = { clearRect() {} };
  }
  append(...children) { for (const child of children) { this.children.push(child); child.parentNode = this; } }
  setAttribute() {}
  addEventListener(type, callback) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(callback);
  }
  removeEventListener(type, callback) { this.listeners.get(type)?.delete(callback); }
  getContext() { return this.context; }
  get lastElementChild() { return this.children.at(-1); }
  contains(element) { return this === element || this.children.some((child) => child.contains(element)); }
  focus() {}
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((c) => c !== this); }
  click() { for (const callback of this.listeners.get("click") ?? []) callback({ target: this }); }
}

test("Camera optionally separates actual camera/map/behavior/guard without touching exact-frame evidence", (t) => {
  const previous = globalThis.document;
  const document = new Element("document");
  document.createElement = (tag) => new Element(tag, document);
  document.body = document.createElement("body");
  document.append(document.body);
  globalThis.document = document;
  const navigation = document.createElement("nav");
  const screen = mountCameraScreen({ navigation, onAction: () => ({ ok: true }) });
  t.after(() => {
    screen.dispose();
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  });
  const find = (id, element = document) => element.id === id ? element
    : element.children.map((child) => find(id, child)).find(Boolean);
  find("cameraScreenToggleBtn", navigation).click();
  assert.equal(find("cameraDistrictSources").hidden, true);
  const command = composed(cap(3), mapCap(2));
  const actual = attributeDistrictApplied({ requested: { targetSpeed: 4.5 },
    behavior: { targetSpeed: 4 }, composed: command,
    safe: { ...command, targetSpeed: 0, reason: "yielding", blockedBy: "front-car" } });
  screen.update({ applied: { reason: actual.reason, districtSources: actual.districtSources }, ego: { speedMps: 3 } });
  const lines = find("cameraDistrictSources");
  assert.equal(lines.hidden, false);
  assert.equal(lines.children.length, 4);
  assert.match(lines.children[0].textContent, /Camera pixels: caution.*oldest support 200 ms/);
  assert.match(lines.children[1].textContent, /Static map:.*Geometric prior, not measured camera visibility/);
  assert.match(lines.children[2].textContent, /Behavior: requested 4.50 m\/s → 4.00/);
  assert.match(lines.children[3].textContent, /Physical guard:.*actual 0.00.*full braking/);
  assert.match(find("cameraAppliedReason").textContent, /source physical guard.*target 0.00/);
  assert.equal(find("cameraAnalysisCanvas").dataset.frameId, undefined);
  screen.update({ applied: { reason: "ordinary-city" } });
  assert.equal(lines.hidden, true);
  assert.equal(lines.children.length, 0);
});
