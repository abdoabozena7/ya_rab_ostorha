import assert from "node:assert/strict";
import test from "node:test";
import { STEP } from "../src/core/config.js";
import { initializeDistrictActor } from "../src/core/district-behavior.js";
import { bodyOnRoad, overlaps } from "../src/core/geometry.js";
import { timedCivilianYield } from "../src/core/pako-civilian-yield.js";
import { PURSUIT_STOP } from "../src/core/pursuit-controls.js";
import { SpatialIndex } from "../src/core/spatial-index.js";
import { integrateVehicle } from "../src/core/vehicle.js";
import { World } from "../src/core/world.js";
import { GtaPursuitEnv, getDispatchObservation } from "../src/rl/gta-pursuit-env.js";
import { MEASURED_QUEUE_CORRIDOR, MEASURED_QUEUE_DETOUR, planMeasuredQueueDetour, queuePassingConflict }
  from "../src/rl/pako-measured-detour.js";
import { planDispatchEvasion } from "../src/rl/pursuit-evasion.js";
import { applyFrozenDispatchAction } from "../src/rl/pursuit-controller.js";
import { CLEARANCE_CORRIDOR, CLEARANCE_ROUTE_CONTEXT, dispatchRouteGuide } from "../src/rl/pursuit-route-context.js";
import { guardDispatchAction } from "../src/rl/pursuit-shield.js";
import { forecastPursuitSurface, PursuitScanner, PURSUIT_SCAN_TICKS, samplePursuitCornerRays }
  from "../src/signal_processing/pursuit-scanner.js";

const request = Object.freeze({ steer: 0, throttle: .65, brake: 0, gear: 1 });
const contactTypes = new Set(["static_or_civilian_hit", "police_hit", "pedestrian_hit"]);
const worldPoint = (pose, forward, right) => ({
  x: pose.x + Math.sin(pose.heading) * forward + Math.cos(pose.heading) * right,
  z: pose.z + Math.cos(pose.heading) * forward - Math.sin(pose.heading) * right,
});

test("time-matched civilian yield brakes for a crossing, not a parallel or unseen walker", () => {
  const car = { type: "vehicle", x: 0, z: 0, heading: 0, steer: 0, speed: 6, length: 4.2, width: 1.85 };
  const walker = { type: "pedestrian", id: "walker", x: 2.55, z: 5.8, heading: -Math.PI / 2, speed: 3.1, radius: .35 };
  const world = (person, statics = []) => ({ statics, actorIndex: new SpatialIndex([car, person]),
    staticIndex: new SpatialIndex(statics) });
  const cruise = { targetSpeed: 6, steer: 0 };
  const yielded = timedCivilianYield(world(walker), car, cruise);
  assert.equal(yielded.reason, "pedestrian-yield");
  assert.equal(yielded.blockedBy, walker.id);
  let rolling = car, braking = car, stockHit = false;
  for (let tick = 1; tick <= 60; tick++) {
    const person = { ...walker, x: walker.x - walker.speed * tick * STEP };
    rolling = integrateVehicle(rolling, cruise, STEP);
    braking = integrateVehicle(braking, yielded, STEP);
    stockHit ||= overlaps(rolling, person);
    assert.ok(!overlaps(braking, person));
  }
  assert.ok(stockHit && braking.speed === 0, "The chosen brake must change the real projected crossing outcome");
  assert.equal(timedCivilianYield(world({ ...walker, heading: 0 }), car, cruise), cruise);
  const wall = { type: "static", x: 1.275, z: 2.9, width: .42, length: .2 };
  assert.equal(timedCivilianYield(world(walker, [wall]), car, cruise), cruise);
  const stop = { ...cruise, targetSpeed: 0 };
  assert.equal(timedCivilianYield(world(walker), car, stop), stop);
});

test("mounted corner rays use accepted pose and cannot see through the nearer body", () => {
  for (const pose of [{ x: 0, z: 0, heading: 0 }, { x: 17, z: -12, heading: Math.PI / 2 }]) {
    const shape = (forward, width, length, type) => ({
      ...pose, ...worldPoint(pose, forward, 0), width, length, type,
    });
    const player = shape(0, 1.85, 4.2, "vehicle");
    const lead = shape(15.75, 1.85, 4.2, "vehicle");
    const barrier = shape(36.65, 3.2, 1.1, "static");
    const scene = { tick: 18, player, actors: [player, lead], statics: [barrier] };
    const original = structuredClone(scene);
    const center = new PursuitScanner().sample(scene);
    assert.equal(center.rays[0].kind, "civilian");
    assert.ok(Math.abs(center.rays[0].rangeM - 13.65) < .001);
    const frame = samplePursuitCornerRays(scene);
    assert.equal(frame.tick, scene.tick);
    for (const side of [-1, 1]) {
      const ray = frame.rays.find(ray => ray.kind === "static" && Math.sign(ray.angleRad) === side);
      assert.ok(ray, "A physical edge must be observed from each existing corner");
      const face = worldPoint(pose, 36.1, 1.501 * side);
      assert.ok(Math.hypot(ray.x - face.x, ray.z - face.z) < .005);
    }
    assert.deepEqual(scene, original);
    lead.width = 6;
    assert.ok(!samplePursuitCornerRays(scene).rays.some(ray => ray.kind === "static"));
  }
});

test("the scan changes vehicle faces without adding a phantom forecast", () => {
  const player = { x: 0, z: 0, heading: 0, type: "vehicle" };
  const patrol = { x: 5.2, z: 27, heading: .4, width: 1.85, length: 4.2,
    type: "vehicle", pursuitRole: "police" };
  const world = { player, actors: [player, patrol], statics: [], tick: 0 };
  const scanner = new PursuitScanner();
  let jumps = 0;
  for (let i = 0; i < 36; i++) {
    Object.assign(player, { x: i * .039, z: i * .37, heading: i * .004 });
    world.tick = i * PURSUIT_SCAN_TICKS;
    const frame = scanner.sample(world);
    const surface = frame.tracks.find(track => track.kind === "police" && !track.ageS);
    assert.ok(surface && frame.rays.some(ray => ray.kind === "police"));
    if (Math.hypot(surface.estimatedXMps, surface.estimatedZMps) <= 4) continue;
    assert.ok(surface.motionKnown);
    assert.deepEqual(forecastPursuitSurface(surface), { status: "motion-unresolved", points: [] });
    jumps++;
  }
  assert.ok(jumps >= 2, "The stationary negative must exercise actual range-return jumps");

  const moving = new PursuitScanner();
  Object.assign(player, { x: 0, z: 0, heading: 0 });
  Object.assign(patrol, { x: 0, z: 26, heading: Math.PI });
  let observed;
  for (let i = 0; i < 5; i++) {
    world.tick = i * PURSUIT_SCAN_TICKS;
    patrol.z = 26 - 4 * world.tick * STEP;
    observed = moving.sample(world).tracks.find(track => track.kind === "police" && !track.ageS);
    if (i < 2) assert.equal(forecastPursuitSurface(observed).status, "motion-unresolved");
  }
  const prediction = forecastPursuitSurface(observed);
  assert.equal(prediction.status, "constant-velocity");
  assert.ok(Math.abs(prediction.points[0].zM - (observed.observedZM - 2)) < .05);
  world.statics.push({ x: 0, z: 12, heading: 0, width: 6, length: .5, type: "static" });
  world.tick += PURSUIT_SCAN_TICKS;
  const occluded = moving.sample(world).tracks.find(track => track.trackId === observed.trackId);
  assert.ok(occluded?.ageS > 0 && !occluded.motionKnown);
  assert.equal(forecastPursuitSurface(occluded).status, "not-observed");
});

test("a verified frame's person forecast can add braking to a frozen request, not override stronger safety", () => {
  const env = new GtaPursuitEnv();
  env.reset({ seed: "hybrid-braking-boundary", shield: true, traffic: 0, pedestrians: 0,
    config: { ruleset: "dispatch-v1", maxActivePatrols: 0 } });
  const { world } = env;
  const frame = { source: "visual-prediction", streamId: "camera-stream", status: "ready", available: true,
    ageMs: 150, frameId: 8,
    decision: { available: true, brake: true, reason: "observed-person-crossing-conflict", evidenceFrameId: 8,
      trackId: "visual-1" },
    forecasts: [{ label: "person", trackId: "visual-1", qualified: true, conflict: true }] };
  const drive = (visualState, stream = "camera-stream", selected = request) => {
    const driver = { status: "active", decisions: 0, lastTick: -1, sha256: "bound-check",
      policy: { observation: "dispatch-scan-v3", action: () => selected } };
    world.visualState = visualState;
    applyFrozenDispatchAction(world, driver, stream);
    assert.equal(driver.decisions, 1);
    return driver.lastDecision;
  };
  const selected = drive(frame);
  assert.deepEqual(selected.requested, request);
  assert.equal(selected.submitted.brake, 1);
  assert.equal(selected.submitted.throttle, 0);
  assert.equal(selected.cameraBrake.frameId, 8);
  for (const decision of [drive({ ...frame, ageMs: 701 }), drive(frame, "other-stream"),
    drive({ ...frame, decision: { ...frame.decision, evidenceFrameId: 7 } }), drive(frame, null)]) {
    assert.equal(decision.cameraBrake, null);
    assert.deepEqual(decision.submitted, request);
  }
  assert.deepEqual(drive(frame, frame.streamId, PURSUIT_STOP).submitted, PURSUIT_STOP);
  const track = { id: "visual-1", source: "camera-pixels", label: "person", streamId: frame.streamId,
    frameId: frame.frameId, stopEpisode: { streamId: frame.streamId, trackId: "visual-1", phase: "stopping" } };
  const held = { ...frame, decision: { ...frame.decision, reason: "committed-visual-stop" },
    forecasts: [], tracks: [track] };
  assert.equal(drive(held).cameraBrake.reason, "committed-visual-stop");
  const clear = { ...held, tracks: [{ ...track, stopEpisode: { ...track.stopEpisode, phase: "cleared" } }] };
  assert.equal(drive(clear).cameraBrake, null);
  assert.equal(drive({ ...held, decision: { ...held.decision, available: false } }).cameraBrake, null);
});

test("clearance corridor chooses an earlier continuous outside path without changing the default cue", () => {
  const world = new World({ cityVersion: 4, seed: "corridor-map-test", traffic: 0, pedestrians: 0 }, "metro");
  world.command({ type: "street-pursuit-start", variant: "gta", level: 1, config: { ruleset: "dispatch-v1" } });
  const v2 = CLEARANCE_ROUTE_CONTEXT;
  const original = getDispatchObservation(world, v2);
  const originalGuide = dispatchRouteGuide(world, v2);
  const { district, player, pursuit, tick, sensors } = world;
  const restricted = { district, player, tick, sensors,
    pursuit: { gta: pursuit.gta,
      get response() { throw new Error("Map guide read pursuit reports"); } },
    get actors() { throw new Error("Map guide read actor truth"); },
    get statics() { throw new Error("Map guide read temporary colliders"); },
  };
  const cue = getDispatchObservation(restricted, v2, CLEARANCE_CORRIDOR);
  const corridor = dispatchRouteGuide(restricted, v2, CLEARANCE_CORRIDOR);
  const zones = pursuit.gta.config.surveillanceZones;
  const lastCovered = corridor.path.findLastIndex(p =>
    zones.some(z => p.x >= z.minX && p.x <= z.maxX && p.z >= z.minZ && p.z <= z.maxZ));
  assert.ok(corridor.earliestM + 20 < originalGuide.lengthM);
  assert.ok(corridor.path.slice(0, lastCovered + 1).some(p => p.x < -240 && Math.abs(p.z + 77.5) < .5));
  const release = corridor.path[lastCovered], end = corridor.path.at(-1);
  assert.ok(Math.hypot(end.x - release.x, end.z - release.z) > 38);
  assert.equal(cue.length, original.length);
  assert.deepEqual(getDispatchObservation(world, v2), original);
  assert.equal(dispatchRouteGuide(world, v2), originalGuide);
  assert.throws(() => getDispatchObservation(world, undefined, CLEARANCE_CORRIDOR), /requires the Metro v2/);

  const blocked = { ...pursuit.gta, config: { surveillanceZones: [{ minX: -350, maxX: 100, minZ: -200, maxZ: 150 }] } };
  assert.equal(dispatchRouteGuide({ district, player, tick, pursuit: { gta: blocked } }, v2, CLEARANCE_CORRIDOR), null);
  const explicit = { ...pursuit.gta, publicRouteGoal: { ...originalGuide.path.at(-1), id: "staged-course-end",
    roadId: "civic-avenue", heading: 0 } };
  assert.equal(dispatchRouteGuide({ district, player, tick, pursuit: { gta: explicit } }, v2, CLEARANCE_CORRIDOR).id,
    "staged-course-end");
});

function stageMeasuredDetour({ queueDetour, opposingM, atJunction = false, releaseLead = false, late = false } = {}) {
  const env = new GtaPursuitEnv();
  env.reset({ seed: "measured-detour-boundary", shield: true, queueDetour, traffic: 0, pedestrians: 0,
    config: { ruleset: "dispatch-v1", maxActivePatrols: 0 } });
  const { world } = env, { player, pursuit } = world;
  if (atJunction) player.x = -191;
  player.speed = 2.2;
  const lead = world.makeVehicle("stopped-lead", "sedan", {
    ...worldPoint(player, 6.7, 0), heading: player.heading,
  });
  initializeDistrictActor(world, lead);
  lead.district.loadingUntilTick = releaseLead ? 24 : 700;
  lead.district.nextLoadingDistanceM = null;
  if (releaseLead) lead.path = [lead, worldPoint(player, 35, 0)].map(({ x, z }) => ({ x, z }));
  world.actors.push(lead);
  if (opposingM !== undefined) {
    const oncoming = world.makeVehicle("moving-opposition", "sedan", {
      ...worldPoint(player, opposingM, 5.4), heading: -Math.PI / 2,
    });
    initializeDistrictActor(world, oncoming);
    oncoming.path = [oncoming, worldPoint(player, -15, 5.4)].map(({ x, z }) => ({ x, z }));
    oncoming.speed = late ? 0 : 4.1;
    if (late) oncoming.district.loadingUntilTick = 42;
    oncoming.district.nextLoadingDistanceM = null;
    world.actors.push(oncoming);
  }
  assert.ok(world.actors.every((actor, i) => bodyOnRoad(actor, world.roads) &&
    world.actors.slice(0, i).every(other => !overlaps(actor, other, .12))));
  world.actorIndex = new SpatialIndex(world.actors);
  pursuit.gta.scanner = new PursuitScanner();
  pursuit.gta.scan = pursuit.gta.scanner.sample(world);
  env.step({ ...request, throttle: 0 });
  assert.ok(pursuit.gta.scan.tracks.some(t => t.kind === "civilian" && t.forwardM > 2 && t.motionKnown));
  return env;
}

test("measured detour uses current returns, and preserves braking when the other lane is occupied", () => {
  const queueDetour = MEASURED_QUEUE_DETOUR;
  const clear = stageMeasuredDetour({ queueDetour });
  const blocked = stageMeasuredDetour({ queueDetour, opposingM: 13 });
  const junction = stageMeasuredDetour({ queueDetour, atJunction: true });
  const disabled = stageMeasuredDetour();
  const { player, pursuit, tick, drivingRoads } = clear.world;
  const restricted = { player, pursuit, tick, drivingRoads,
    get actors() { throw new Error("planner accessed actor truth"); },
    get statics() { throw new Error("planner accessed live colliders"); },
  };
  assert.equal(planMeasuredQueueDetour({ player, pursuit, drivingRoads, tick: tick + 1 }, request).reason, null);
  assert.equal(planMeasuredQueueDetour(restricted, PURSUIT_STOP).reason, null);
  const eligible = planMeasuredQueueDetour(restricted, request);
  assert.ok(eligible.action.steer > .5);
  const first = clear.step(request).info;
  assert.equal(first.planner.queue.phase, "pass");
  assert.ok(first.appliedCommand.steer > .3 && !first.events.some(e => e.type === "static_or_civilian_hit"));
  assert.equal(blocked.step(request).info.planner, null);
  assert.equal(junction.step(request).info.planner, null);
  assert.equal(disabled.step(request).info.planner, undefined);
  assert.throws(() => new GtaPursuitEnv().reset({ queueDetour: MEASURED_QUEUE_DETOUR }), /independent Dispatch/);

  const moving = stageMeasuredDetour({ queueDetour, releaseLead: true });
  let completed, returnedAt;
  while (moving.world.tick < 600) {
    const { info } = moving.step(request);
    assert.ok(!info.events.some(e => e.type === "static_or_civilian_hit"));
    if (info.planner?.queue?.phase === "returned") {
      completed = info.planner.queue;
      returnedAt = { x: moving.world.player.x, z: moving.world.player.z };
    }
  }
  assert.equal(completed?.returnCause, "lead-moving-away");
  assert.ok(Math.abs(returnedAt.z + 109.3) < .37);
});

test("passing corridor protects against a visible farther stopped opponent", () => {
  const old = stageMeasuredDetour({ queueDetour: MEASURED_QUEUE_DETOUR, opposingM: 23, late: true });
  const cautious = stageMeasuredDetour({ queueDetour: MEASURED_QUEUE_CORRIDOR, opposingM: 23, late: true });
  const open = stageMeasuredDetour({ queueDetour: MEASURED_QUEUE_CORRIDOR });
  const plain = stageMeasuredDetour({ opposingM: 23, late: true });
  const { player, pursuit } = cautious.world;
  const scan = pursuit.gta.scan;
  assert.ok(scan.tracks.some(t => t.kind === "civilian" && t.forwardM > 18 && t.rightM > 4));
  assert.equal(queuePassingConflict({ tracks: [{ ...scan.tracks[0], observedXM: undefined }] },
    player, player.heading, 5.4, 24), "unresolved-corridor");
  const next = cautious.step(request).info;
  assert.equal(next.planner.queue.phase, "declined");
  assert.equal(next.planner.candidates[0].rejectReason, "observed-corridor");
  assert.deepEqual(next.appliedCommand, plain.step(request).info.appliedCommand);
  assert.equal(old.step(request).info.planner.queue.phase, "pass");
  assert.equal(open.step(request).info.planner.queue.phase, "pass");
  const braking = cautious.step(PURSUIT_STOP).info;
  assert.equal(braking.planner, null);
  assert.equal(braking.appliedCommand.targetSpeed, 0);
});

function tailMetro({ receding = false, front = false } = {}) {
  const world = new World({
    cityVersion: 4, seed: "prediction-tail-disposable-v1", traffic: 0, pedestrians: 0,
  }, "metro");
  const { player } = world;
  if (front) world.statics.push({ id: "thin-front", type: "static", ...worldPoint(player, 4.5, 0),
    heading: player.heading, width: .12, length: .13 });
  world.command({ type: "street-pursuit-start", variant: "gta", level: 1, config: {
    ruleset: "dispatch-v1", maxActivePatrols: 1, episodeMaxSeconds: 5,
    enableRoadblocks: false, enablePitManeuver: false,
  } });
  const [patrol] = world.pursuit.patrols;
  Object.assign(patrol, worldPoint(player, -9, 0), {
    heading: player.heading + (receding ? Math.PI : 0), speed: 3, steer: 0,
    gtaSlipMps: 0, gtaYawRate: 0, path: [], cursor: 0,
  });
  assert.ok(bodyOnRoad(patrol, world.roads));
  assert.ok(world.statics.every(body => !overlaps(body, patrol)));
  const { gta } = world.pursuit;
  gta.scanner = new PursuitScanner();
  gta.scan = gta.scanner.sample(world);
  assert.equal(gta.scan.tracks.find(track => track.kind === "police").motionKnown, false);
  assert.strictEqual(planDispatchEvasion(world, PURSUIT_STOP).action, PURSUIT_STOP);
  world.command({ type: "pursuit-drive", action: PURSUIT_STOP });
  for (let i = 0; i < 12; i++) world.step();
  return { world, patrol };
}

test("measured rear pressure can release a deliberate brake only into a clear guarded front", t => {
  const run = adapt => {
    const { world, patrol } = tailMetro();
    const { player } = world;
    const initialX = player.x, initialPatrolX = patrol.x;
    const track = world.pursuit.gta.scan.tracks.find(track => track.kind === "police" && track.ageS === 0);
    assert.ok(track.motionKnown && track.forwardMps > 3);
    const hits = [], recoveries = [];
    let minGapM = Infinity;
    while (world.tick < 60) {
      if (world.tick % PURSUIT_SCAN_TICKS === 0) {
        const decision = adapt ? planDispatchEvasion(world, PURSUIT_STOP) : { action: PURSUIT_STOP, reason: null };
        if (decision.reason === "PREDICTIVE_RECOVERY") {
          assert.ok(decision.candidates.some(c => c.name === "rear-pressure-forward" && c.feasible && c.selected));
          assert.equal(guardDispatchAction(world, decision.action).reason, null);
          recoveries.push(world.tick);
        } else assert.strictEqual(decision.action, PURSUIT_STOP);
        world.command({ type: "pursuit-drive", action: decision.action });
      }
      world.step();
      assert.equal(world.pursuit.phase, "running");
      assert.ok(bodyOnRoad(player, world.roads));
      minGapM = Math.min(minGapM, player.x - patrol.x - (player.length + patrol.length) / 2);
      hits.push(...world.pursuit.stepEvents.filter(e => e.type === "patrol_collision" || contactTypes.has(e.type)));
    }
    return { start: [initialX, initialPatrolX], rearMps: track.forwardMps, minGapM, recoveries,
      egoTravelM: player.x - initialX, patrolTravelM: patrol.x - initialPatrolX,
      hits: hits.map(e => [e.type, e.tick]) };
  };
  const brake = run(false), predicted = run(true);
  t.diagnostic(JSON.stringify({ brake, predicted }));
  assert.deepEqual(brake.start, predicted.start);
  assert.equal(brake.rearMps, predicted.rearMps);
  assert.equal(predicted.recoveries[0], 12);
  assert.ok(predicted.patrolTravelM > 3 && brake.patrolTravelM > 3);
  assert.ok(predicted.egoTravelM > .35);
  assert.ok(brake.hits.some(([kind]) => kind === "patrol_collision"));
  assert.equal(predicted.hits.length, 0);
  assert.ok(predicted.minGapM > .3 && predicted.minGapM - brake.minGapM > .3);
});

test("receding rear and an independently guard-admitted thin front return preserve intentional braking", t => {
  const { world: receding } = tailMetro({ receding: true });
  const recession = receding.pursuit.gta.scan.tracks.find(track => track.kind === "police" && track.ageS === 0);
  assert.ok(recession.motionKnown && recession.forwardMps < -1);
  assert.strictEqual(planDispatchEvasion(receding, PURSUIT_STOP).action, PURSUIT_STOP);

  const { world: obstructed } = tailMetro({ front: true });
  assert.equal(obstructed.pursuit.gta.scan.rays[0].kind, "static");
  assert.equal(guardDispatchAction(obstructed, request).reason, null);
  const held = planDispatchEvasion(obstructed, PURSUIT_STOP);
  assert.strictEqual(held.action, PURSUIT_STOP);
  assert.equal(held.reason, null);
  assert.equal(held.candidates[0]?.rejectReason, "front-clearance");
  t.diagnostic(JSON.stringify({ recedingMps: recession.forwardMps, thinFront: held.candidates[0].rejectReason }));
});

function metro({ obstruction = "right", ruleset = "dispatch-v1", walkerDirection = 0, occlusionM } = {}) {
  const world = new World({
    cityVersion: 4, seed: occlusionM === undefined ? "pako-recovery-disposable-v1" : "pako-stale-occlusion-disposable-v1",
    traffic: 0, pedestrians: Number(walkerDirection !== 0),
  }, "metro");
  const p = world.player;
  const wall = (id, forward, right, width, length) => world.statics.push({
    id, type: "static", ...worldPoint(p, forward, right), heading: p.heading, width, length,
  });
  if (obstruction === "box") {
    wall("fixture-front", 2.994, 0, 4, .5);
    wall("fixture-rear", -2.994, 0, 4, .5);
    wall("fixture-left", 0, -1.55, .5, 5.7);
    wall("fixture-right", 0, 1.55, .5, 5.7);
  } else if (obstruction !== "clear") {
    // The face is in the current guard's margin but leaves an adjacent lane.
    wall("fixture-edge", 2.994, obstruction === "right" ? 1.625 : -1.625, 1.25, .5);
  }
  if (walkerDirection) {
    const person = world.actors.find(a => a.type === "pedestrian");
    assert.ok(person, "Metro must spawn a real person for the motion evidence");
    const heading = p.heading + (walkerDirection < 0 ? Math.PI : 0);
    const forward = occlusionM === undefined ? 6.4 : occlusionM - 2.2;
    const right = occlusionM === undefined ? -1.7 : -4;
    if (occlusionM !== undefined) wall("fixture-screen", occlusionM * .65, -2.6, .08, 1.6);
    Object.assign(person, worldPoint(p, forward, right), {
      speed: 1.5, heading, walkHeading: heading, pause: 0, motionMode: "walk",
      target: worldPoint(p, forward + 5 * walkerDirection, right),
      district: { ...person.district, caseId: "prediction-leaf", routeConstrained: false,
        holdAtTarget: false, stage: "moving" },
    });
  }
  world.command({ type: "street-pursuit-start", variant: "gta", level: 1,
    config: { ruleset, maxActivePatrols: 0, episodeMaxSeconds: 5 } });
  return world;
}

function drive(world, decision, { stopAtContact = false, ticks = 180 } = {}) {
  const initial = { ...world.player };
  const endTick = world.tick + ticks;
  const hits = [], decisions = [];
  while (world.tick < endTick && world.pursuit.phase === "running" && (!stopAtContact || !hits.length)) {
    assert.equal(world.pursuit.gta.scan.tick, world.tick);
    const { action, reason, candidates } = decision(world);
    decisions.push({ tick: world.tick, action, reason, candidates });
    world.command({ type: "pursuit-drive", action });
    for (let i = 0; i < PURSUIT_SCAN_TICKS && world.pursuit.phase === "running"; i++) {
      world.step();
      assert.ok(bodyOnRoad(world.player, world.roads), "accepted vehicle footprint must remain on the road");
      hits.push(...world.pursuit.stepEvents.filter(event => contactTypes.has(event.type)));
    }
  }
  const dx = world.player.x - initial.x, dz = world.player.z - initial.z;
  return {
    tick: world.tick, phase: world.pursuit.phase, decisions, hits,
    forwardM: dx * Math.sin(initial.heading) + dz * Math.cos(initial.heading),
    rightM: dx * Math.cos(initial.heading) - dz * Math.sin(initial.heading),
    distanceM: world.pursuit.metrics.distanceM,
  };
}

function summary({ tick, phase, decisions, hits, forwardM, rightM, distanceM }) {
  const selected = decisions[0].candidates?.find(c => c.selected);
  return { tick, phase, forwardM, rightM, distanceM, hits: hits.map(({ tick, actorId }) => [tick, actorId]),
    reasons: Object.fromEntries([...new Set(decisions.map(d => String(d.reason)))].map(reason =>
      [reason, decisions.filter(d => String(d.reason) === reason).length])),
    ...(selected ? { firstChoice: selected.name, minClearanceM: selected.minClearanceM } : {}) };
}

test("guarded recovery uses the actual open corridor on either side, then returns control to policy", t => {
  const stopped = drive(metro(), world => guardDispatchAction(world, request));
  assert.equal(stopped.tick, 180);
  assert.equal(stopped.distanceM, 0);
  assert.equal(stopped.hits.length, 0);
  assert.ok(stopped.decisions.every(d => d.reason === "static"));

  const usable = {};
  for (const [obstruction, direction] of [["left", 1], ["right", -1]]) {
    const alternate = drive(metro({ obstruction }), world => {
      const decision = planDispatchEvasion(world, request);
      assert.equal(guardDispatchAction(world, decision.action).reason, null);
      return decision;
    });
    const first = alternate.decisions[0];
    assert.equal(first.reason, "PREDICTIVE_RECOVERY");
    assert.equal(first.candidates.find(c => c.selected)?.name, `steer-${direction > 0 ? "left" : "right"}`);
    assert.equal(first.candidates.find(c => c.name === `steer-${direction > 0 ? "right" : "left"}`).rejectReason,
      "scan-clearance");
    assert.ok(first.candidates.find(c => c.selected).minClearanceM > 0);
    assert.equal(Math.sign(first.action.steer), direction);
    assert.equal(alternate.tick * STEP, 3);
    assert.equal(alternate.phase, "running");
    assert.equal(alternate.hits.length, 0);
    assert.ok(alternate.forwardM > 6, "the rear must pass the obstacle's far face, not just pulse the throttle");
    assert.ok(alternate.rightM * direction > .5, "the accepted poses must go to the open side");
    assert.equal(alternate.decisions.at(-1).reason, null);
    assert.strictEqual(alternate.decisions.at(-1).action, request);
    usable[obstruction] = summary(alternate);
  }
  t.diagnostic(JSON.stringify({ guardOnly: summary(stopped), openings: usable }));
});

test("sealed box stays stopped for forward and reverse, even when the independent guard permits a short turn", t => {
  const arms = [];
  for (const gear of [1, -1]) {
    const requested = { ...request, gear };
    const blocked = drive(metro({ obstruction: "box" }), world => planDispatchEvasion(world, requested));
    assert.equal(blocked.tick, 180);
    assert.equal(blocked.distanceM, 0);
    assert.equal(blocked.hits.length, 0);
    assert.ok(blocked.decisions.every(d => d.reason === "PREDICTIVE_NO_SUPPORTED_EXIT" &&
      d.action.brake === 1 && d.action.throttle === 0 && d.candidates.every(c => !c.feasible)));
    assert.equal(blocked.decisions[0].candidates.find(c => c.name === "steer-left").rejectReason, "scan-clearance");

    const raw = drive(metro({ obstruction: "box" }), () => ({ action: requested }), { stopAtContact: true });
    assert.equal(raw.hits[0]?.actorId, gear > 0 ? "fixture-front" : "fixture-rear");
    arms.push({ gear, blocked: summary(blocked), collisionControl: summary(raw) });
  }
  t.diagnostic(JSON.stringify(arms));
});

test("approaching and receding walkers differ after consecutive physical samples, not at the first return", t => {
  const arms = [];
  for (const walkerDirection of [-1, 1]) {
    const world = metro({ walkerDirection });
    const person = world.actors.find(a => a.type === "pedestrian");
    const { x, z } = person;
    const track = () => world.pursuit.gta.scan.tracks.find(t => t.kind === "pedestrian" && t.ageS === 0);
    const escape = decision => decision.candidates.find(c => c.name === "steer-right");
    const initial = planDispatchEvasion(world, request);
    assert.equal(track().motionKnown, false);
    assert.equal(initial.action.brake, 1);
    assert.equal(escape(initial).rejectReason, "uncertain-motion");

    world.command({ type: "pursuit-drive", action: PURSUIT_STOP });
    for (let i = 0; i < PURSUIT_SCAN_TICKS; i++) world.step();
    const acceptedMps = ((person.x - x) * Math.sin(world.player.heading) +
      (person.z - z) * Math.cos(world.player.heading)) / (world.tick * STEP);
    const { motionKnown, forwardMps, ttcS } = track();
    assert.equal(world.tick, 6);
    assert.equal(motionKnown, true);
    assert.ok(acceptedMps * walkerDirection > 1);
    assert.ok(Math.abs(acceptedMps - forwardMps) < .4);
    const next = planDispatchEvasion(world, request);
    if (walkerDirection < 0) {
      assert.ok(Number.isFinite(ttcS));
      assert.equal(escape(next).rejectReason, "predicted-conflict");
      assert.equal(next.action.brake, 1);
    } else {
      assert.equal(ttcS, null);
      assert.equal(next.reason, "PREDICTIVE_RECOVERY");
      assert.equal(escape(next).selected, true);
      assert.equal(guardDispatchAction(world, next.action).reason, null);
    }
    arms.push({ walkerDirection, acceptedMps, forwardMps, ttcS, reason: next.reason,
      escapeVerdict: escape(next).rejectReason });
  }
  t.diagnostic(JSON.stringify(arms));
});

test("real occlusion holds for a nearby stale walker but does not obstruct a distant recovery", t => {
  const plan = world => planDispatchEvasion(world, request);
  const arms = [];
  for (const occlusionM of [0, 14]) {
    const world = metro({ walkerDirection: 1, occlusionM });
    const { gta } = world.pursuit;
    const walker = world.actors.find(a => a.type === "pedestrian");
    const x0 = walker.x, z0 = walker.z;
    assert.ok(gta.scan.tracks.some(track => track.kind === "pedestrian" && track.ageS === 0));
    world.command({ type: "pursuit-drive", action: PURSUIT_STOP });
    let stale;
    while (world.tick < 126) {
      for (let i = 0; i < PURSUIT_SCAN_TICKS; i++) world.step();
      const tracks = gta.scan.tracks.filter(track => track.kind === "pedestrian");
      if (tracks.length && tracks.every(track => track.ageS > 0)) {
        stale = tracks[0];
        break;
      }
    }
    assert.ok(stale, "the still-present walker must physically enter the baffle's sensor shadow");
    assert.ok(Math.hypot(walker.x - x0, walker.z - z0) > .7);
    assert.equal(gta.scan.tick, world.tick);
    assert.equal(stale.observedTick, world.tick - PURSUIT_SCAN_TICKS);
    assert.equal(stale.motionKnown, false);
    assert.equal(guardDispatchAction(world, request).reason, "static");
    const measuredDistanceM = Math.hypot(stale.observedXM - world.player.x, stale.observedZM - world.player.z);

    if (occlusionM) {
      const scan = gta.scan;
      const missingAnchor = { ...stale };
      delete missingAnchor.observedXM;
      gta.scan = Object.freeze({ ...scan, tracks: Object.freeze(scan.tracks.map(track =>
        track === stale ? Object.freeze(missingAnchor) : track)) });
      const invalid = plan(world);
      assert.equal(invalid.action.brake, 1);
      assert.ok(invalid.candidates.some(c => c.rejectReason === "stale-track-metadata"));
      gta.scan = scan;
    }

    const run = drive(world, plan, { ticks: 18 });
    const first = run.decisions[0];
    const candidate = first.candidates.find(c => c.name === "steer-right");
    assert.equal(run.hits.length, 0);
    if (occlusionM) {
      const control = drive(metro(), plan, { ticks: 18 });
      assert.equal(first.reason, "PREDICTIVE_RECOVERY");
      assert.ok(candidate.selected);
      assert.deepEqual(run.decisions.map(d => d.action), control.decisions.map(d => d.action));
      assert.ok(run.distanceM > .05);
      assert.equal(run.distanceM, control.distanceM);
    } else {
      assert.equal(first.reason, "PREDICTIVE_NO_SUPPORTED_EXIT");
      assert.equal(candidate.rejectReason, "stale-track");
      assert.equal(run.distanceM, 0);
    }
    arms.push({ occlusionM, firstTick: first.tick, observedTick: stale.observedTick, ageS: stale.ageS,
      measuredDistanceM, verdict: first.reason, acceptedDistanceM: run.distanceM, hits: run.hits.length });
  }
  t.diagnostic(JSON.stringify(arms));
});

test("recovery consumes observations without reading collider arrays or writing observation/replay bytes", () => {
  const world = metro();
  const beforeObservation = getDispatchObservation(world).slice();
  const beforeReplay = JSON.stringify(world.replay());
  const observable = new Proxy(world, {
    get(target, key) {
      assert.notEqual(key, "actors");
      assert.notEqual(key, "statics");
      return target[key];
    },
  });
  assert.equal(planDispatchEvasion(observable, request).reason, "PREDICTIVE_RECOVERY");
  assert.deepEqual(getDispatchObservation(world), beforeObservation);
  assert.equal(JSON.stringify(world.replay()), beforeReplay);
});

test("clear policy, deliberate brake and legacy remain unchanged; missing or held scans cannot launch a maneuver", () => {
  const clear = metro({ obstruction: "clear" });
  const boxed = metro({ obstruction: "box" });
  for (const [world, action] of [[clear, request], [boxed, PURSUIT_STOP], [metro({ ruleset: "legacy" }), request]]) {
    const decision = planDispatchEvasion(world, action);
    assert.strictEqual(decision.action, action);
    assert.equal(decision.reason, null);
    assert.deepEqual(decision.candidates, []);
  }
  boxed.step();
  assert.deepEqual(planDispatchEvasion(boxed, request), {
    action: PURSUIT_STOP, reason: "STALE_OBSERVATION", candidates: [],
  });
  clear.pursuit.gta.scan = undefined;
  assert.deepEqual(planDispatchEvasion(clear, request), {
    action: PURSUIT_STOP, reason: "STALE_OBSERVATION", candidates: [],
  });
  clear.pursuit.gta.scan = Object.freeze({ tick: clear.tick, rays: Object.freeze([]), tracks: Object.freeze([]) });
  assert.deepEqual(planDispatchEvasion(clear, request), {
    action: PURSUIT_STOP, reason: "INVALID_OBSERVATION", candidates: [],
  });
});
