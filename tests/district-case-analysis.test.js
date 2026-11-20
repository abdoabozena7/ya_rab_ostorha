import test from "node:test";
import assert from "node:assert/strict";
import {
  analyzeDistrictCase, analyzeDistrictBaseline, analyzeDistrictHiddenTwin,
  analyzeDistrictPolicyIsolation, observeDistrictCrossing,
} from "../tools/district-case-analysis.mjs";
import {
  createDistrictSpeedState, decideDistrictVisualSpeed, mappedDistrictSpeed, composeDistrictSpeed,
} from "../src/core/visual-speed-policy.js";

// Hand-authored kinematic traces and synthetic frame metadata test the evaluator, not NN/product acceptance.
const DT = 1 / 60, HASH = "a".repeat(64);
const policy = { decide: decideDistrictVisualSpeed, mapped: mappedDistrictSpeed, compose: composeDistrictSpeed };
const model = { id: "YOLOX synthetic oracle fixture", method: "fixture", provider: "fixture", weightsSha256: HASH };
const clone = structuredClone;
const gap = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const car = (id, x, z, heading = 0) => ({
  id, type: "vehicle", x, z, heading, speed: 0, distance: 0, maxSpeed: 4.5,
  width: 1.85, length: 4.2, reason: "driving", blockedBy: null, pathRevision: 0,
});
const person = (x, z, heading, speed = 0) => ({
  id: "person", type: "pedestrian", x, z, heading, speed, distance: 0,
  maxSpeed: 3.2, radius: .3, heightM: 1.78, reason: "walking",
});
const zone = { id: "corner", x: 0, z: 12, heading: 0, approachM: 20,
  clearanceM: 2, visibilityDistanceM: 4, speedLimitMps: 3 };
const occluder = { id: "van", x: 1.75, z: 12, heading: 0, width: 1.2, length: 2, height: 2.2 };
const checked = (result, id) => result.checks.find((check) => check.id === id);
const passes = (run) => {
  const result = analyzeDistrictCase(run);
  assert.equal(result.passed, true, JSON.stringify(result.checks.filter((item) => !item.passed)));
  return result;
};
const fails = (run, id) => {
  const result = analyzeDistrictCase(run);
  assert.equal(checked(result, id)?.passed, false, JSON.stringify(result));
  assert.equal(result.passed, false);
  return result;
};

function walking(t, hesitant = false) {
  const phases = hesitant
    ? [[.6, 0, 1.2], [1.3, 1.2, 1.2], [.6, 1.2, 0], [.5, 0, 0],
      [.6, 0, 1.2], [2.5, 1.2, 1.2], [.6, 1.2, 0]]
    : [[.6, 0, 1.2], [4.4, 1.2, 1.2], [.6, 1.2, 0]];
  let distance = 0;
  for (const [duration, from, to] of phases) {
    if (t <= 0) return { distance, speed: 0 };
    const elapsed = Math.min(t, duration), acceleration = (to - from) / duration;
    distance += from * elapsed + acceleration * elapsed ** 2 / 2;
    if (t <= duration) return { distance, speed: from + acceleration * elapsed };
    t -= duration;
  }
  return { distance, speed: 0 };
}

function positionOnPath(points, distance) {
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i], size = gap(a, b);
    if (distance <= size) return { x: a.x + (b.x - a.x) * distance / size,
      z: a.z + (b.z - a.z) * distance / size, heading: Math.atan2(b.x - a.x, b.z - a.z) };
    distance -= size;
  }
  const a = points.at(-2), b = points.at(-1);
  return { ...b, heading: Math.atan2(b.x - a.x, b.z - a.z) };
}

function addPixelChain(run, { stop = false, cruiseSpeed = 3, loss = false } = {}) {
  let lastResult = null;
  for (let i = 0; i < run.samples.length; i++) {
    const sample = run.samples[i], t = sample.timeS, previous = run.samples[i - 1] ?? sample;
    if (i % 6 === 0 && (!loss || t < 1 || t >= 4)) {
      const ego = { x: sample.player.x, z: sample.player.z, headingRad: sample.player.heading,
        speedMps: sample.player.speed, widthM: sample.player.width, lengthM: sample.player.length };
      const camera = { width: 640, height: 360, fovYDeg: 76, groundY: .12,
        position: { x: ego.x + Math.sin(ego.headingRad) * .72, y: 1.58,
          z: ego.z + Math.cos(ego.headingRad) * .72 }, headingRad: ego.headingRad };
      const detections = sample.people.flatMap((p) => {
        const dx = p.x - camera.position.x, dz = p.z - camera.position.z;
        const depth = dx * Math.sin(camera.headingRad) + dz * Math.cos(camera.headingRad);
        if (depth <= 0 || (run.id === "fully-hidden-emergence" && t < 2.5)) return [];
        const focal = 360 / (2 * Math.tan(76 * Math.PI / 360));
        const side = dx * Math.cos(camera.headingRad) - dz * Math.sin(camera.headingRad);
        const center = 320 - side * focal / depth, half = p.radius * focal / depth;
        return [{ label: "person", confidence: .9, box: [center - half,
          180 - (p.heightM + .12 - 1.58) * focal / depth,
          center + half, 180 - (.12 - 1.58) * focal / depth] }];
      });
      const streamId = loss && t >= 4 ? "recovered" : "fixture";
      const result = { streamId, frameId: i, simulationTimeS: t, ego, camera,
        model, detections, latencyMs: 1 };
      const key = JSON.stringify([streamId, i]);
      run.frames.push({ ...clone(result), key, imageSha256: HASH, byteLength: 1234 });
      const tracks = detections.length ? [{ id: "track", label: "person", source: "camera-pixels",
        history: [{ frameId: Math.max(0, i - 6), simulationTimeS: Math.max(0, t - .1) },
          { frameId: i, simulationTimeS: t }] }] : [];
      const observation = { key, observedTick: i + 1, result, visual: { tracks } };
      run.observations.push(observation);
    }
    const atS = Math.max(0, t - DT);
    lastResult = run.observations.findLast((item) => item.result.simulationTimeS <= atS + 1e-8)?.result
      ?? run.observations[0].result;
    const mapDistance = zone.z - previous.player.z;
    const mapped = run.geometry.cautionZones.length && mapDistance > -2 && mapDistance <= 20
      && Math.abs(previous.player.x) <= 4 && Math.abs(previous.player.heading) <= .7;
    const map = { source: "static-map", available: true, state: mapped ? "caution" : "clear",
      reason: mapped ? "mapped-blind-corner" : "outside-mapped-caution",
      targetSpeedMps: mapped ? 3 : null, zoneId: mapped ? zone.id : null, distanceM: mapped ? mapDistance : null };
    const stopping = stop && t >= 1 && t < 9.5;
    let visualState = stopping ? "stop" : "clear", cap = stopping ? 0 : null, available = true;
    if (cruiseSpeed < 3 && lastResult.detections.some((item) => item.label === "person")) {
      visualState = "caution"; cap = cruiseSpeed;
    }
    if (loss) {
      if (t >= 1 && t <= 4.2) { visualState = "unavailable"; cap = 0; available = false; }
      else if (t > 4.2 && t < 5.45) cap = 2.4 * (t - 4.2);
    }
    const visual = { source: "camera-pixels", available, state: visualState,
      targetSpeedMps: cap, reason: "synthetic-case-observation",
      streamId: lastResult.streamId, frameId: lastResult.frameId,
      ageMs: (atS - lastResult.simulationTimeS) * 1000,
      evidenceTrackId: ["caution", "stop"].includes(visualState) ? "track" : null };
    const requested = loss ? 3 : 4.5;
    const composed = Math.min(requested, cap ?? Infinity, map.targetSpeedMps ?? Infinity);
    sample.player.sources = { requestedMps: requested, behaviorMps: requested, visual, map,
      composedMps: composed, finalMps: composed,
      appliedSource: cap != null && cap < Math.min(requested, map.targetSpeedMps ?? Infinity)
        ? "camera-pixels" : mapped ? "static-map" : "requested" };
    sample.decisionTimeS = atS;
    sample.decisionEgo = { x: previous.player.x, z: previous.player.z,
      headingRad: previous.player.heading, speedMps: previous.player.speed,
      lengthM: previous.player.length, widthM: previous.player.width };
    sample.visualAgeMs = visual.ageMs;
  }
  run.observations = run.observations.filter((item) => item.observedTick <= run.samples.at(-1).tick);
}

function trace(id = "visible-right", { cruise = false, speed = 3, driver = "vision-first" } = {}) {
  const stoppedCase = ["visible-left", "visible-right", "diagonal-hesitant", "partial-occluded-history"].includes(id);
  cruise ||= !stoppedCase;
  const noPerson = ["same-occluder-empty", "blind-corner-empty"].includes(id);
  const occluded = ["partial-occluded-history", "fully-hidden-emergence",
    "same-occluder-empty", "blind-corner-empty"].includes(id);
  const goal = { x: 0, z: 28.5, heading: 0 };
  const run = { id, seed: "synthetic-development", driver, evidenceClass: "synthetic oracle-unit fixture",
    frames: [], observations: [], paths: [], samples: [],
    geometry: { playerStart: { x: 0, z: 0, heading: 0 }, goal, trafficGoals: [],
      cautionZones: [zone], statics: occluded ? [occluder] : [],
      roads: [], conflictZones: [], occluderId: "van" } };
  const speedAt = (t) => {
    if (cruise) return t <= 27 / speed ? speed : Math.max(0, speed * (1 - (t - 27 / speed) / (3 / speed)));
    if (t < 1) return 3;
    if (t < 1.5) return 6 * (1.5 - t);
    if (t < 9.5) return 0;
    if (t < 10.5) return 3 * (t - 9.5);
    if (t < 18) return 3;
    return Math.max(0, 6 * (18.5 - t));
  };
  const duration = cruise ? 27 / speed + 3 / speed + .1 : 19;
  let z = 0, priorSpeed = speedAt(0), distance = 0, oldPerson = null;
  for (let tick = 0; tick <= Math.ceil(duration * 60); tick++) {
    const t = tick * DT, currentSpeed = speedAt(t);
    if (tick) { const moved = (priorSpeed + currentSpeed) * DT / 2; z += moved; distance += moved; }
    priorSpeed = currentSpeed;
    let p;
    if (!noPerson) {
      if (id === "stationary-curb" || id === "camera-loss-recovery")
        p = person(3, 20, 0);
      else if (id === "parallel-away") {
        const d = t <= .6 ? t * t : .36 + 1.2 * (t - .6);
        p = person(3, 20 + d, 0, Math.min(1.2, 2 * t));
      } else {
        const diagonal = id === "diagonal-hesitant";
        const start = id === "partial-occluded-history" ? 0 : diagonal ? .5 : 1.8;
        const motion = walking(t - start, diagonal), sign = id === "visible-left" ? 1 : -1;
        p = person(-sign * 3 + sign * motion.distance, 20 + (diagonal ? .3 * motion.distance : 0),
          Math.atan2(sign, diagonal ? .3 : 0), motion.speed * (diagonal ? Math.hypot(1, .3) : 1));
      }
      p.distance = oldPerson ? oldPerson.distance + gap(p, oldPerson) : 0;
      oldPerson = p;
    }
    run.samples.push({ tick, timeS: t, player: { ...car("player", 0, z), speed: currentSpeed, distance, goal: clone(goal) },
      traffic: [], people: p ? [p] : [], audit: [], blockingCycles: 0,
      resources: { holds: {}, reservations: {} } });
  }
  run.paths.push({ actorId: "player", revision: 0, firstTick: 0, points: [{ x: 0, z: 0 }, goal] });
  addPixelChain(run, { stop: !cruise, cruiseSpeed: speed });
  return run;
}

function trafficTrace(id, waitingS = 14) {
  const narrow = id === "two-car-narrow-passage";
  const passage = { id: "passage", minX: -1, maxX: 1, minZ: -2, maxZ: 2, approachM: 20 };
  const original = narrow ? [{ x: 0, z: -12 }, { x: 0, z: 12 }, { x: -3, z: 12 }]
    : [{ x: 0, z: -12 }, { x: 0, z: 12 }];
  const alternate = [{ x: 0, z: -12 }, { x: 3, z: -12 }, { x: 3, z: 6 }, { x: 0, z: 6 }, { x: 0, z: 12 }];
  const otherPath = narrow ? [{ x: 3, z: 12 }, { x: 3, z: 7 }, { x: 0, z: 7 }, { x: 0, z: -12 }]
    : [{ x: 0, z: 0 }, { x: 0, z: .1 }];
  const goal = narrow ? { x: -3, z: 12, heading: -Math.PI / 2 } : { x: 0, z: 12, heading: 0 };
  const otherGoal = narrow ? { x: 0, z: -12, heading: Math.PI } : { x: 0, z: .1, heading: 0 };
  const run = { id, seed: "synthetic-development", driver: "vision-first",
    evidenceClass: "synthetic oracle-unit fixture", samples: [], frames: [], observations: [],
    geometry: { playerStart: { ...original[0], heading: 0 }, goal,
      trafficGoals: [{ id: "other", goal: otherGoal }], cautionZones: [], statics: [], roads: [],
      conflictZones: [passage], waitingZoneId: passage.id },
    paths: [{ actorId: "player", revision: 0, firstTick: 0, points: original },
      { actorId: "other", revision: 0, firstTick: 0, points: otherPath }] };
  if (!narrow) run.paths.push({ actorId: "player", revision: 1, firstTick: 60, points: alternate });
  const previous = new Map();
  for (let tick = 0; tick <= Math.max(28, waitingS + 10) * 60; tick++) {
    const t = tick * DT;
    const playerArc = narrow ? Math.min(27, t * 3) : Math.min(30, Math.max(0, t - 1) * 3);
    const otherArc = narrow ? Math.min(27, Math.max(0, t - waitingS) * 3) : 0;
    const player = { ...car("player", 0, 0), ...positionOnPath(narrow || t < 1 ? original : alternate, playerArc),
      speed: narrow ? t < 9 ? 3 : 0 : t > 1 && t < 11 ? 3 : 0,
      pathRevision: !narrow && t >= 1 ? 1 : 0, goal: clone(goal), blockedBy: !narrow && t < 1 ? "other" : null };
    const other = { ...car("other", 0, 0), ...positionOnPath(otherPath, otherArc),
      speed: narrow && t > waitingS && t < waitingS + 9 ? 3 : 0,
      goal: clone(otherGoal), blockedBy: narrow && t < waitingS ? "player" : null };
    for (const vehicle of [player, other]) {
      const old = previous.get(vehicle.id);
      vehicle.distance = old ? old.distance + gap(vehicle, old) : 0;
      previous.set(vehicle.id, vehicle);
    }
    run.samples.push({ tick, timeS: t, player, traffic: [other], people: [],
      resources: { holds: !narrow && t < 1 ? { player: { blockedBy: "other" } } : {}, reservations: {} },
      blockingCycles: 0, audit: [] });
  }
  addPixelChain(run);
  return run;
}

test("mirrored visible crossings require a held physical zero before actual body-corridor entry", () => {
  for (const id of ["visible-left", "visible-right"]) {
    const run = trace(id), result = passes(run);
    assert.ok(result.metrics.firstStopS < result.metrics.firstLaneEntryS);
    const wrongSide = clone(run);
    wrongSide.id = id === "visible-left" ? "visible-right" : "visible-left";
    fails(wrongSide, "requested-mirrored-physical-crossing-side");
    const pulse = clone(run);
    for (const sample of pulse.samples) {
      if (sample.timeS > 1.5 && sample.timeS < result.metrics.firstLaneEntryS) {
        sample.player.sources.visual.state = "clear";
        sample.player.sources.visual.targetSpeedMps = null;
      }
    }
    fails(pulse, "complete-zero-visual-stop-before-later-entry-and-guard");
    const neverZero = clone(run);
    for (const sample of neverZero.samples) if (sample.player.speed === 0) sample.player.speed = .001;
    fails(neverZero, "complete-zero-visual-stop-before-later-entry-and-guard");
    const guard = clone(run);
    guard.samples[48].player.sources = {
      ...guard.samples[48].player.sources, appliedSource: "physical-guard", finalMps: 0,
    };
    fails(guard, "complete-zero-visual-stop-before-later-entry-and-guard");
    const wrongClass = clone(run);
    for (const observation of wrongClass.observations)
      for (const track of observation.visual.tracks) track.label = "vehicle";
    fails(wrongClass, "complete-zero-visual-stop-before-later-entry-and-guard");
  }
});

test("labels, missing physical ticks, actor recycling and substitute goals cannot close a case", () => {
  const original = trace();
  const missing = clone(original);
  missing.samples.splice(90, 1);
  fails(missing, "complete-fixed-step-physical-trace");
  const recycled = clone(original);
  recycled.samples[30].people[0].id = "replacement";
  fails(recycled, "constant-actors-bounded-accepted-motion");
  const teleported = clone(original);
  teleported.samples[30].people[0].x += 5;
  fails(teleported, "constant-actors-bounded-accepted-motion");
  const changedGoal = clone(original);
  changedGoal.samples[40].player.goal.z += 2;
  fails(changedGoal, "original-physical-goals-retained");
  const fakeComplete = clone(original);
  fakeComplete.completed = true;
  fakeComplete.geometry.goal.z += 10;
  fails(fakeComplete, "actual-saved-player-goal-arrival");
});

test("diagonal hesitation is an interior stationary interval with actual resumed movement", () => {
  const run = trace("diagonal-hesitant");
  passes(run);
  const noPause = clone(run);
  for (const sample of noPause.samples) if (sample.people[0].speed === 0) sample.people[0].speed = .001;
  fails(noPause, "interior-physical-hesitation-then-resumed-motion");
});

test("partially occluded history needs a real occluder and seen moving-person history", () => {
  const run = trace("partial-occluded-history");
  passes(run);
  const noOccluder = clone(run);
  noOccluder.geometry.statics = [];
  fails(noOccluder, "moving-person-actually-partially-occluded-with-history");
  const noHistory = clone(run);
  for (const item of noHistory.observations) for (const track of item.visual.tracks) track.history = [];
  fails(noHistory, "actual-history-and-camera-led-physical-response");
});

test("hidden emergence and empty twins require actual geometry, movement and separate map causality", () => {
  const hidden = trace("fully-hidden-emergence"), empty = trace("same-occluder-empty");
  passes(hidden);
  passes(empty);
  passes(trace("blind-corner-empty"));
  const psychic = clone(hidden);
  const early = psychic.samples[2].player.sources;
  early.visual.state = "caution"; early.visual.evidenceTrackId = "track"; early.visual.targetSpeedMps = 2;
  psychic.observations[0].visual.tracks = [{ id: "track", label: "person", source: "camera-pixels" }];
  fails(psychic, "no-person-prediction-before-an-actual-pixel-cue");
  const absent = clone(empty);
  absent.geometry.statics = [];
  fails(absent, "same-registered-occluder-present");
  const fakeVision = clone(empty);
  fakeVision.samples[30].player.sources.visual.state = "stop";
  fakeVision.samples[30].player.sources.visual.targetSpeedMps = 0;
  fails(fakeVision, "no-predictive-crossing-stop");
  const twins = analyzeDistrictHiddenTwin(hidden, empty);
  assert.equal(twins.passed, false, "Different actual ego histories are not identical policy inputs");
});

test("actually seen stationary/parallel negatives enforce the moving same-map 0.8 baseline", () => {
  for (const id of ["stationary-curb", "parallel-away"]) {
    const predictive = trace(id), baseline = trace(id, { driver: "sensors-only" });
    passes(predictive);
    assert.equal(analyzeDistrictBaseline(predictive, baseline).passed, true);
    const slow = trace(id, { speed: 2.1 });
    passes(slow);
    assert.equal(analyzeDistrictBaseline(slow, baseline).passed, false, "Blanket slowing is not a pass");
    const unseen = clone(predictive);
    for (const item of unseen.observations) item.result.detections = [];
    fails(unseen, "three-actually-seen-negative-person-frames");
  }
});

test("visible causal controls need a real later reactive reduction and exactly the same map", () => {
  const predictive = trace("visible-right");
  const baseline = trace("visible-right", { cruise: true, driver: "sensors-only" });
  Object.assign(baseline.samples[240].player.sources, { finalMps: 2.5, appliedSource: "physical-guard" });
  assert.equal(analyzeDistrictBaseline(predictive, baseline).passed, true);
  const earlier = clone(baseline);
  Object.assign(earlier.samples[60].player.sources, { finalMps: 2.5, appliedSource: "physical-guard" });
  assert.equal(analyzeDistrictBaseline(predictive, earlier).passed, false);
  const mislabeled = clone(predictive);
  mislabeled.driver = "sensors-only";
  fails(mislabeled, "sensors-only-never-applies-camera-speed-caps");
  const differentMap = clone(baseline);
  differentMap.geometry.cautionZones[0].visibilityDistanceM += 1;
  assert.equal(analyzeDistrictBaseline(predictive, differentMap).passed, false);
  const differentActor = clone(baseline);
  for (const sample of differentActor.samples) {
    sample.people[0].x *= -1;
    sample.people[0].heading *= -1;
  }
  assert.equal(checked(analyzeDistrictBaseline(predictive, differentActor),
    "same-initial-actual-ego-and-other-actor-poses").passed, false);
});

test("two opposing saved goals, physical occupancy, 1.5s arrivals, 20s wait and 45s completion are measured", () => {
  const run = trafficTrace("two-car-narrow-passage");
  passes(run);
  const wrongGoal = clone(run);
  wrongGoal.geometry.trafficGoals[0].goal.z -= 10;
  fails(wrongGoal, "both-physical-goals-within-45s");
  const frozen = clone(run);
  for (const sample of frozen.samples) sample.traffic[0] = clone(frozen.samples[0].traffic[0]);
  fails(frozen, "both-actually-approach-enter-and-clear");
  const cycle = clone(run);
  cycle.samples[10].player.speed = 0;
  cycle.samples[10].player.blockedBy = "other";
  cycle.samples[10].traffic[0].blockedBy = "player";
  fails(cycle, "no-observed-blocking-cycle");
  const reportedCycle = clone(run);
  reportedCycle.samples[10].behaviorBlockingCycles = 1;
  reportedCycle.samples[10].blockingCycles = 0;
  fails(reportedCycle, "no-observed-blocking-cycle");
  const lateApproach = clone(run);
  lateApproach.geometry.conflictZones[0].approachM = 6;
  const approach = fails(lateApproach, "opposing-geometric-approaches-within-1.5s");
  // Front edge -4.1 minus 6m approach: 1.9m from start at 3m/s, exactly tick38.
  assert.ok(Math.abs(approach.metrics.narrow.find((item) => item.actorId === "player").approachS - 38 / 60) < 1e-8,
    "A 0.2m path probe must not shift actual approach timing across a sealed limit");
  fails(trafficTrace("two-car-narrow-passage", 18), "second-physical-approach-wait-at-most-20s");
  fails(trafficTrace("two-car-narrow-passage", 38), "both-physical-goals-within-45s");
  const conflicting = clone(run);
  Object.assign(conflicting.samples[240].traffic[0], { x: 0, z: 0 });
  fails(conflicting, "no-conflicting-passage-occupancy");
});

test("queued replan counters do not substitute for new geometry driven to the same original goal", () => {
  const run = trafficTrace("queue-alternate-route");
  passes(run);
  const counterOnly = clone(run);
  counterOnly.paths.find((item) => item.actorId === "player" && item.revision === 1).points =
    clone(counterOnly.paths[0].points);
  fails(counterOnly, "changed-route-geometry-actually-followed-to-original-goal");
  const imaginaryBlocker = clone(run);
  for (const sample of imaginaryBlocker.samples) {
    if (sample.player.blockedBy) sample.player.blockedBy = "nonexistent";
    sample.resources.holds = {};
  }
  fails(imaginaryBlocker, "actual-queued-hold-with-blocker");
});

function cameraLossTrace() {
  const run = trace("camera-loss-recovery");
  run.samples = []; run.frames = []; run.observations = [];
  run.geometry.cautionZones = [];
  run.geometry.goal = { x: 0, z: 17.625, heading: 0 };
  const speedAt = (t) => t < 1 ? 2 : t < 2 ? 2 * (2 - t)
    : t <= 4.2 ? 0 : t < 5.45 ? 2.4 * (t - 4.2)
      : t < 9.45 ? 3 : t < 9.95 ? 6 * (9.95 - t) : 0;
  let z = 0, previousSpeed = 2;
  for (let tick = 0; tick <= 10.2 * 60; tick++) {
    const timeS = tick * DT, speed = speedAt(timeS);
    if (tick) z += (speed + previousSpeed) * DT / 2;
    previousSpeed = speed;
    run.samples.push({ tick, timeS,
      player: { ...car("player", 0, z), speed, distance: z, goal: clone(run.geometry.goal) },
      traffic: [], people: [person(3, 20, 0)], audit: [], blockingCycles: 0,
      resources: { holds: {}, reservations: {} } });
  }
  run.faults = [
    { type: "withhold-start", timeS: 1, speedMps: 2 },
    { type: "request-blocked", timeS: 1.1 },
    { type: "public-retry", timeS: 4, oldStreamId: "fixture", newStreamId: "recovered" },
    { type: "withhold-end", timeS: 4, speedMps: 0 },
  ];
  addPixelChain(run, { loss: true });
  return run;
}

test("camera loss requires real >750ms aging, physical ordinary stop, public retry and two fresh recovery frames", () => {
  const run = cameraLossTrace();
  passes(run);
  const fakeFault = clone(run);
  fakeFault.faults = fakeFault.faults.filter((event) => event.type !== "request-blocked");
  fails(fakeFault, "actual-camera-withholding-while-moving");
  const noAging = clone(run);
  for (const sample of noAging.samples) if (sample.timeS > 1.7 && sample.timeS < 4) {
    sample.player.sources.visual.state = "clear";
    sample.player.sources.visual.available = true;
  }
  fails(noAging, "over-750ms-evidence-becomes-unavailable");
  const noRetry = clone(run);
  noRetry.faults = noRetry.faults.filter((event) => event.type !== "public-retry");
  fails(noRetry, "actual-public-retry-and-new-camera-stream");
  const earlyRelease = clone(run);
  const early = earlyRelease.samples[241].player.sources;
  Object.assign(early.visual, { available: true, state: "clear", targetSpeedMps: 3 });
  early.finalMps = 3; early.composedMps = 3;
  fails(earlyRelease, "zero-held-until-two-fresh-frames-spanning-0.1s");
  const jump = clone(run);
  jump.samples[253].player.sources.visual.targetSpeedMps = 3;
  fails(jump, "recovered-cap-release-at-most-2.4mps2");
  const emergency = clone(run);
  emergency.samples[90].player.speed = 0;
  fails(emergency, "ordinary-unavailable-deceleration-at-most-2mps2");
});

test("pixel/model pairing and map-axis geometry reject stale or mislabeled camera causality", () => {
  const run = trace("blind-corner-empty");
  passes(run);
  const yawed = clone(run);
  for (const sample of yawed.samples) sample.decisionEgo.headingRad = .2;
  passes(yawed);
  const wrongPair = clone(run);
  wrongPair.observations[0].result.ego.x += 1;
  fails(wrongPair, "exact-pixel-result-model-pairing");
  const wrongPhysicalPose = clone(run);
  for (const sample of wrongPhysicalPose.samples) sample.player.x += .2;
  fails(wrongPhysicalPose, "exact-pixel-result-model-pairing");
  const stale = clone(run);
  stale.samples[60].player.sources.visual.ageMs = 0;
  fails(stale, "fresh-identified-visual-support");
  const guardAsVision = clone(run);
  guardAsVision.samples[60].player.sources.finalMps = 0;
  fails(guardAsVision, "post-guard-source-attribution");
  const future = clone(run);
  future.observations[0].observedTick = 100000;
  fails(future, "fresh-identified-visual-support");
  const repeated = trace("visible-left");
  const oneFrame = repeated.observations[40];
  repeated.observations = [clone(oneFrame), clone(oneFrame), clone(oneFrame)];
  fails(repeated, "three-actually-seen-person-frames");
});

function isolationFixture(run = trace("fully-hidden-emergence")) {
  const sample = run.samples[1];
  const input = {
    visual: { source: "visual-prediction", streamId: "fixture", status: "ready", available: true,
      availability: { status: "ready", available: true, error: null }, frameId: 0, ageMs: 0,
      model, latencyMs: 1, tracks: [], forecasts: [] },
    ego: clone(sample.decisionEgo),
    requestedSpeedMps: 4.5, nowS: 0, visionRequired: true, previousState: createDistrictSpeedState(),
  };
  const visual = policy.decide(input), map = policy.mapped({ zones: [zone], ego: input.ego });
  const command = policy.compose({ targetSpeed: 4.5 }, { visual, map, dt: DT, previousState: input.previousState });
  const { nextState: _next, ...recordedVisual } = visual;
  sample.player.sources.visual = recordedVisual;
  sample.player.sources.map = command.districtSources.map;
  sample.player.sources.composedMps = command.targetSpeed;
  run.observations[0].visual = clone(input.visual);
  run.policyInputs = [{ tick: 1, input, expected: {
      visual: recordedVisual, map: command.districtSources.map, composedMps: command.targetSpeed,
    } }];
  return run;
}

test("hidden-truth invariance actually replays identical strict captured inputs, not a with/without ego assumption", () => {
  const fixture = isolationFixture();
  const checkedPolicy = analyzeDistrictPolicyIsolation(fixture, policy);
  assert.equal(checkedPolicy.passed, true, JSON.stringify(checkedPolicy));
  assert.equal(checkedPolicy.metrics.identicalAllowedInputPairs, 1);
  const permissive = { ...policy, decide: (input) => {
    const { actors: _actors, ...allowed } = input;
    return policy.decide(allowed);
  } };
  assert.equal(analyzeDistrictPolicyIsolation(fixture, permissive).passed, false,
    "A policy that silently accepts hidden truth must fail strict isolation");
  const altered = clone(fixture);
  altered.policyInputs[0].input.ego.z += 1;
  assert.equal(analyzeDistrictPolicyIsolation(altered, policy).passed, false,
    "Replay with different allowed ego input cannot match the recorded map decision");
  const twins = analyzeDistrictHiddenTwin(fixture, trace("same-occluder-empty"),
    { policyIsolation: checkedPolicy });
  assert.equal(twins.passed, true, JSON.stringify(twins));
  assert.equal(twins.metrics.identicalCrossRunInputPairs, 0,
    "Pure identical-input replay must never be reported as two identical live scenes");
  const unrelatedReport = analyzeDistrictPolicyIsolation(isolationFixture(trace("blind-corner-empty")), policy);
  assert.equal(analyzeDistrictHiddenTwin(fixture, trace("same-occluder-empty"),
    { policyIsolation: unrelatedReport }).passed, false, "A green replay from another trace cannot supply the chain");
});

test("policy replay accepts an honestly unavailable initial frame, never an unlinked available image", () => {
  for (const visionRequired of [false, true]) {
    const run = isolationFixture(trace("blind-corner-empty"));
    const record = run.policyInputs[0], sample = run.samples[1];
    record.input.visionRequired = visionRequired;
    Object.assign(record.input.visual, { status: "unavailable", available: false,
      availability: { status: "unavailable", available: false, error: null },
      frameId: null, ageMs: null, model: null, latencyMs: null, tracks: [], forecasts: [] });
    const visual = policy.decide(record.input);
    const map = policy.mapped({ zones: [zone], ego: record.input.ego });
    const command = policy.compose({ targetSpeed: record.input.requestedSpeedMps },
      { visual, map, dt: DT, previousState: record.input.previousState });
    const { nextState: _next, ...recordedVisual } = visual;
    record.expected = { visual: recordedVisual, map: command.districtSources.map, composedMps: command.targetSpeed };
    Object.assign(sample.player.sources, record.expected);
    sample.visualAgeMs = null;
    const result = analyzeDistrictPolicyIsolation(run, policy);
    assert.equal(result.passed, true, JSON.stringify(result));
    assert.equal(result.metrics.pairs[0].hasCapturedPixels, false);
    const forged = clone(run);
    forged.policyInputs[0].input.visual.available = true;
    forged.policyInputs[0].input.visual.status = "ready";
    assert.equal(checked(analyzeDistrictPolicyIsolation(forged, policy),
      "exact-policy-inputs-linked-to-retained-pixels-and-accepted-ticks").passed, false);
  }
});
