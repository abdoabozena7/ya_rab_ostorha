import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { STEP } from "../src/core/config.js";
import { bodyOnRoad, overlaps, roadFrame } from "../src/core/geometry.js";
import { classSpec, coordsOn, laneFrame, lanePoint, streetChaosSnapshot } from "../src/core/street-chaos.js";
import { integrateVehicle } from "../src/core/vehicle.js";
import { JETOUR_T2_ID, KING_LONG_MICROBUS_ID } from "../src/core/vehicle-spec.js";
import { World } from "../src/core/world.js";

const output = process.env.PROVE_IT_OUTPUT_DIR || join(process.cwd(), "tmp", "layer2-observation");
const round = (n, digits = 3) => Number.isFinite(n) ? +n.toFixed(digits) : null;
const ticks = (s) => Math.round(s / STEP);
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const isEvasive = (reaction) => ["accident-bypass", "evasive-shift"].includes(reaction);
const save = (name, value) => writeFile(join(output, name), JSON.stringify(value, null, 2) + "\n");
const histogram = (obj, key) => { if (key) obj[key] = (obj[key] ?? 0) + 1; };
const DISTANCE_LIMIT = 2.5;
const STALL_SPEED = 0.3;
const SAMPLE_TICKS = 15;

function relative(ego, actor) {
  const dx = actor.x - ego.x, dz = actor.z - ego.z;
  return {
    dx_fwd: dx * Math.sin(ego.heading) + dz * Math.cos(ego.heading),
    dx_lat: dx * Math.cos(ego.heading) - dz * Math.sin(ego.heading),
    distanceM: Math.hypot(dx, dz), headingDelta: wrap(actor.heading - ego.heading),
  };
}

function createScenario(vehicleModel, disableDefensiveAvoidance = false) {
  const world = new World({ seed: "cairo-42", cityVersion: 5 }, "metro");
  if (vehicleModel === KING_LONG_MICROBUS_ID && !world.command({ type: "player-vehicle", model: vehicleModel }).ok)
    throw new Error("Could not equip King Long microbus");
  // Use one clear mid-block position for paired trials, leaving the full ambient population in place.
  const road = world.district.drivingRoads.find(({ id }) => id === "university-avenue");
  const heading = roadFrame(road).heading;
  const start = Array.from({ length: 40 }, (_, i) => lanePoint(road, 1, -360 + i * 2, -road.laneOffsetM))
    .find((pose) => {
      const test = { ...world.player, ...pose, heading };
      return !world.actors.some((a) => a !== world.player && overlaps(test, a, 2.5)) &&
        !world.statics.some((a) => overlaps(test, a, 0.5));
    });
  if (!start) throw new Error("No clear University Avenue start position");
  const pose = { ...start, heading, speed: 6 };
  Object.assign(world.player, pose, { previous: { ...pose } });
  const result = world.command({ type: "street-chaos-start", intensity: "rush", driverMode: "auto", disableDefensiveAvoidance });
  if (result !== true || !world.streetChaos?.active) throw new Error(`Cairo Traffic start failed: ${JSON.stringify(result)}`);
  world.streetChaos.nextEventTick = Infinity; // Offline isolation only; the live journey leaves scheduling untouched.
  return world;
}

function truckOracle(trucks) {
  const measure = (spec) => {
    const body = (speed) => ({ x: 0, z: 0, heading: 0, steer: 0, speed, maxSpeed: 20, spec });
    const step = (state, targetSpeed, steer = 0) => integrateVehicle(state, { targetSpeed, steer }, STEP);
    let stop = body(12), accel = body(0), turn = body(3), first = step(turn, 3, 0.8);
    for (let i = 0; i < ticks(10) && stop.speed > 0; i++) stop = step(stop, 0);
    for (let i = 0; i < ticks(3); i++) accel = step(accel, 12);
    for (let i = 0; i < ticks(6); i++) turn = step(turn, 3, 0.8);
    const next = step(turn, 3, 0.8);
    return { stopDistanceM: round(stop.z), stopped: stop.speed === 0, speedAfter3sMps: round(accel.speed),
      steerRateRadS: round(first.steer / STEP), turnRadiusM: round(3 * STEP / Math.abs(wrap(next.heading - turn.heading))) };
  };
  const sedan = measure(classSpec("sedan", true)), tuktuk = measure(classSpec("tuktuk", true));
  const readings = trucks.map((truck) => {
    const { id, length, width, height, spec } = truck;
    const measured = measure(spec);
    const faults = [];
    const dimensions = { length, width, height };
    for (const [key, expected] of Object.entries({ length: 8.2, width: 2.45, height: 3.35 }))
      if (dimensions[key] !== expected) faults.push(`${key}=${dimensions[key]} expected ${expected}`);
    for (const [key, expected] of Object.entries({ massKg: 14500, wheelbase: 4.9, acceleration: 1.15,
      braking: 4.1, steerRate: 0.48, maxSteer: 0.4, tireGripMps2: 5.2, reverseSpeed: 2, realisticDynamics: true }))
      if (spec[key] !== expected) faults.push(`${key}=${spec[key]} expected ${expected}`);
    if (!measured.stopped || measured.stopDistanceM < 1.5 * Math.max(sedan.stopDistanceM, tuktuk.stopDistanceM))
      faults.push("truck does not take at least 1.5x as far as the lighter classes to stop");
    if (measured.speedAfter3sMps >= 0.5 * Math.min(sedan.speedAfter3sMps, tuktuk.speedAfter3sMps))
      faults.push("truck accelerates too quickly");
    if (measured.turnRadiusM === null || measured.turnRadiusM < 2.5 * Math.max(sedan.turnRadiusM, tuktuk.turnRadiusM) ||
        Math.abs(measured.steerRateRadS - 0.48) > 0.01) faults.push("truck steering is too agile");
    return { id, dimensions, spec, measured, faults };
  });
  return { passed: readings.length >= 4 && readings.every(({ faults }) => faults.length === 0), sedan, tuktuk, trucks: readings };
}

function runScenario({ vehicleModel, events, durationS = 45, disableDefensiveAvoidance = false }) {
  const world = createScenario(vehicleModel, disableDefensiveAvoidance);
  const ego = world.player;
  const baseDistance = ego.distance, baseImpacts = ego.vehicle.damage.impactCount;
  const start = { x: ego.x, z: ego.z, heading: ego.heading, speed: ego.speed };
  const trucks = world.actors.filter((a) => a.kind === "truck");
  const audit = new Map(), previous = new Map(), liveEvents = new Map(), encounters = new Map();
  const reactions = {}, evasiveEpisodes = [], triggers = [];
  const truckBehavior = { followingTicks: 0, heldBehindTicks: 0, passes: [], encounters: [] };
  const motions = { maxStepJumpM: 0, stepJumpWitness: null, steeringOscillations: 0, steeringReversals: 0, maxSteerDeltaRad: 0 };
  let steerSign = 0, lastReversal = -Infinity, burst = 0, priorSteer = ego.steer;
  let stallTicks = 0, maxStall = 0, sums = 0, vehicleTouchTicks = 0, pedestrianConcernTicks = 0, offLaneVehicles = 0;
  let priorEvasive = null, wreckPassed = false, wreckFormed = false, wreckClearanceM = null;
  const timeTicks = ticks(durationS);
  const requests = new Map(events.map(([t, kind]) => [t, kind]));
  for (let i = 0; i < timeTicks; i++) {
    if (requests.has(world.tick)) {
      const kind = requests.get(world.tick);
      const response = world.command({ type: "street-chaos-event", kind });
      triggers.push({ kind, requestedTick: world.tick, response, spawnFailure: world.streetChaos.lastFailure });
    }
    world.step();
    const { streetChaos: state } = world;
    sums += Math.abs(ego.speed);
    const stalled = Math.abs(ego.speed) < STALL_SPEED;
    stallTicks = stalled ? stallTicks + 1 : 0;
    maxStall = Math.max(maxStall, stallTicks);
    const sign = Math.abs(ego.steer) >= 0.035 ? Math.sign(ego.steer) : 0;
    if (sign && steerSign && sign !== steerSign) {
      motions.steeringReversals++;
      burst = world.tick - lastReversal <= ticks(0.65) ? burst + 1 : 1;
      if (burst === 4) motions.steeringOscillations++;
      lastReversal = world.tick;
    }
    if (sign) steerSign = sign;
    motions.maxSteerDeltaRad = Math.max(motions.maxSteerDeltaRad, Math.abs(ego.steer - priorSteer));
    priorSteer = ego.steer;
    const currentReaction = state.egoReaction;
    histogram(reactions, currentReaction?.reaction);
    const key = isEvasive(currentReaction?.reaction) ? `${currentReaction.reaction}:${currentReaction.threatId}` : null;
    if (key && key !== priorEvasive) evasiveEpisodes.push({ tick: world.tick, ...currentReaction });
    priorEvasive = key;
    if (state.accident?.formed) {
      wreckFormed = true;
      const wreck = state.accident;
      wreckClearanceM ??= Math.max(wreck.latMin + wreck.halfW, -0.2 - wreck.latMax);
      wreckPassed ||= coordsOn(wreck.road, wreck.d, ego).s - ego.length / 2 > wreck.sMax + 2;
    }
    for (const e of [...state.events, ...state.recent]) {
      const seen = liveEvents.get(e.id) ?? { id: e.id, kind: e.kind, startTick: e.startTick, phases: [], actorIds: e.actorIds };
      if (e.phase && !seen.phases.includes(e.phase)) seen.phases.push(e.phase);
      if (e.outcome) Object.assign(seen, { outcome: e.outcome, endTick: e.endTick });
      liveEvents.set(e.id, seen);
    }
    for (const actor of world.actors) {
      const dx = Math.abs(actor.x - ego.x), dz = Math.abs(actor.z - ego.z);
      if (actor.type === "vehicle") {
        const last = previous.get(actor.id);
        if (last?.tick === world.tick - 1) {
          const jump = Math.hypot(actor.x - last.x, actor.z - last.z);
          if (jump > motions.maxStepJumpM) {
            motions.maxStepJumpM = jump;
            motions.stepJumpWitness = { tick: world.tick, actorId: actor.id };
          }
        }
        previous.set(actor.id, { x: actor.x, z: actor.z, tick: world.tick });
        if (actor !== ego && dx < 12 && dz < 12 && overlaps(ego, actor)) vehicleTouchTicks++;
      } else if (actor.type === "pedestrian" && dx < 6 && dz < 6 &&
          (overlaps(ego, actor) || ego.speed > 1 && overlaps(ego, actor, 0.3))) pedestrianConcernTicks++;
      if (actor.kind !== "truck" || dx > 75 || dz > 75) continue;
      const r = relative(ego, actor);
      const sameFlow = Math.abs(r.headingDelta) < 0.45;
      const following = sameFlow && r.dx_fwd >= 5 && r.dx_fwd <= 34 && Math.abs(r.dx_lat) < (ego.width + actor.width) / 2;
      let encounter = encounters.get(actor.id);
      if (following) {
        encounter ??= { id: actor.id, firstTick: world.tick, closestFollowingM: Infinity, followingTicks: 0, heldBehindTicks: 0, passed: false };
        encounter.closestFollowingM = Math.min(encounter.closestFollowingM, r.dx_fwd);
        encounter.followingTicks++;
        truckBehavior.followingTicks++;
        if (ego.speed <= actor.speed + 0.6) { truckBehavior.heldBehindTicks++; encounter.heldBehindTicks++; }
        encounters.set(actor.id, encounter);
      }
      if (encounter && !encounter.passed && sameFlow && r.dx_fwd < -(actor.length + ego.length) / 2 &&
          Math.abs(r.dx_lat) < 8 && Math.abs(r.dx_lat) > 1.5) {
        encounter.passed = true;
        truckBehavior.passes.push({ id: actor.id, tick: world.tick, dx_fwd: round(r.dx_fwd), dx_lat: round(r.dx_lat) });
      }
    }
    if (i % 20 === 0 || i === timeTicks - 1) {
      for (const line of world.audit()) if (!audit.has(line)) audit.set(line, world.tick);
    }
    offLaneVehicles = Math.max(offLaneVehicles, state.metrics.offLaneActiveCount ?? 0);
  }
  truckBehavior.encounters = [...encounters.values()].map((e) => ({ ...e, closestFollowingM: round(e.closestFollowingM) }));
  const collisions = ego.vehicle.damage.impactCount - baseImpacts;
  const { metrics } = streetChaosSnapshot(world);
  const initialTruckRoads = trucks.map((truck) => {
    const frame = laneFrame(world, truck, { maxPsi: 1 });
    return { id: truck.id, roadId: frame?.road.id ?? null, roadWidthM: frame?.road.width ?? null, onRoad: bodyOnRoad(truck, world.roads) };
  });
  return {
    durationS, vehicleModel, start, disableDefensiveAvoidance, triggers, events: [...liveEvents.values()],
    distance: round(ego.distance - baseDistance), avgSpeed: round(sums / timeTicks), collisions: Math.max(collisions, metrics.collisions),
    auditErrors: [...audit].map(([error, firstTick]) => ({ error, firstTick })), reactions, evasiveEpisodes,
    maxStepJumpM: round(motions.maxStepJumpM), steeringOscillations: motions.steeringOscillations, motion: motions,
    vehicleTouchTicks, pedestrianConcernTicks, longestStallS: round(maxStall * STEP), wreckFormed, wreckPassed,
    wreckClearanceM: round(wreckClearanceM), observedEvents: { ghorz: metrics.ghorzCount, laneChange: metrics.laneCutCount,
      accident: metrics.accidentCount, evasiveReactions: evasiveEpisodes.length, offLaneVehicles },
    truckFollowingVsPassingBehavior: truckBehavior, truckRoadsAtEnd: initialTruckRoads,
  };
}

function clearancePass(run) {
  return run.wreckFormed && run.wreckPassed && run.wreckClearanceM >= 3 && run.distance >= 100 &&
    run.collisions === 0 && run.vehicleTouchTicks === 0 && run.pedestrianConcernTicks === 0 &&
    run.auditErrors.length === 0 && run.maxStepJumpM <= DISTANCE_LIMIT;
}

async function benchmark() {
  const truckPhysics = truckOracle(createScenario(JETOUR_T2_ID).streetChaos.trucks);
  const observedEvents = { ghorz: 0, laneChange: 0, accident: 0, evasiveReactions: 0, offLaneVehicles: 0 };
  const failures = [];
  const runs = [KING_LONG_MICROBUS_ID, JETOUR_T2_ID].map((vehicleModel) => {
    const accident = runScenario({ vehicleModel, events: [[60, "accident"]] });
    const cutIns = runScenario({ vehicleModel, events: [[60, "ghorz"], [90, "lane-change"]] });
    if (!clearancePass(accident) || !accident.reactions["accident-bypass"])
      failures.push(`${vehicleModel}: accident bypass or safety oracle failed`);
    if (!["ghorz", "lane-change"].every((kind) => cutIns.events.some((event) => event.kind === kind && event.outcome === "completed")))
      failures.push(`${vehicleModel}: not both physical cut-in events completed`);
    if (!Object.keys(cutIns.reactions).some((r) => ["evasive-shift", "defensive-yield", "emergency-brake"].includes(r)) || cutIns.distance < 100)
      failures.push(`${vehicleModel}: cut-in reaction or progress was not observed`);
    for (const [scenario, run] of Object.entries({ accident, cutIns })) {
      if (run.collisions || run.auditErrors.length || run.vehicleTouchTicks || run.pedestrianConcernTicks ||
          run.maxStepJumpM > DISTANCE_LIMIT || run.steeringOscillations)
        failures.push(`${vehicleModel}/${scenario}: contact, audit, teleport or rapid alternating steering`);
      if (run.truckRoadsAtEnd.some((t) => t.roadWidthM < 10 || !t.onRoad))
        failures.push(`${vehicleModel}/${scenario}: a heavy truck left the wide carriageway`);
      for (const key of Object.keys(observedEvents)) observedEvents[key] = key === "offLaneVehicles"
        ? Math.max(observedEvents[key], run.observedEvents[key]) : observedEvents[key] + run.observedEvents[key];
    }
    return {
      vehicleModel, distance: round(accident.distance + cutIns.distance), avgSpeed: round((accident.avgSpeed + cutIns.avgSpeed) / 2),
      collisions: accident.collisions + cutIns.collisions, auditErrors: [...accident.auditErrors, ...cutIns.auditErrors],
      reactions: { accident: accident.reactions, cutIns: cutIns.reactions }, maxStepJumpM: Math.max(accident.maxStepJumpM, cutIns.maxStepJumpM),
      steeringOscillations: accident.steeringOscillations + cutIns.steeringOscillations,
      truckFollowingVsPassingBehavior: { accident: accident.truckFollowingVsPassingBehavior, cutIns: cutIns.truckFollowingVsPassingBehavior },
      scenarios: { accident, cutIns },
    };
  });
  if (!truckPhysics.passed) failures.push("heavy-truck physics oracle failed");
  if (!observedEvents.ghorz || !observedEvents.laneChange || !observedEvents.accident ||
      observedEvents.evasiveReactions < 2 || !observedEvents.offLaneVehicles) failures.push("event, avoidance or off-lane coverage too low");
  const totalCollisions = runs.reduce((n, r) => n + r.collisions, 0);
  const passed = !failures.length && totalCollisions === 0;
  await save("cairo-benchmark.json", { passed, totalCollisions, truckPhysicsVerified: truckPhysics.passed, observedEvents,
    units: { distance: "m", avgSpeed: "m/s" }, failures, runs, truckPhysics });
  console.log(`Cairo benchmark ${passed ? "passed" : "failed"}: ${failures.join("; ") || "both models exercised"}`);
  return passed ? 0 : 2;
}

async function negativeControl() {
  const options = { vehicleModel: JETOUR_T2_ID, events: [[60, "accident"]], durationS: 30 };
  const control = runScenario(options);
  const naive = runScenario({ ...options, disableDefensiveAvoidance: true });
  const trucks = createScenario(JETOUR_T2_ID).streetChaos.trucks;
  const validPhysics = truckOracle(trucks);
  const sedan = classSpec("sedan", true);
  const wrongTrucks = trucks.map((truck) => ({ ...truck, spec: { ...truck.spec, massKg: sedan.massKg, braking: sedan.braking } }));
  const faultyPhysics = truckOracle(wrongTrucks);
  const detectedFaults = [];
  if (clearancePass(control) && control.reactions["accident-bypass"] && naive.wreckFormed &&
      (!naive.wreckPassed && naive.longestStallS >= 10 || naive.collisions > 0 || naive.vehicleTouchTicks > 0))
    detectedFaults.push("disabled avoidance failed the same live-World accident clearance that Defensive AI passed");
  if (validPhysics.passed && !faultyPhysics.passed && faultyPhysics.trucks.every(({ faults }) =>
    faults.some((f) => f.startsWith("massKg=")) && faults.some((f) => f.startsWith("braking=")) &&
    faults.some((f) => f.includes("to stop"))))
    detectedFaults.push("sedan-mass and sedan-braking truck failed spec and measured stopping-distance oracles");
  const faultCaught = detectedFaults.length === 2;
  await save("negative-control.json", { faultCaught, detectedFaults, avoidance: { control, naive }, truck: { validPhysics, faultyPhysics } });
  if (faultCaught) console.error(`NEGATIVE_CONTROL_CAUGHT: ${detectedFaults.join("; ")}`);
  else console.error(`Negative control incomplete: ${detectedFaults.join("; ") || "no faults proven"}`);
  return faultCaught ? 1 : 2;
}

function loadPlaywright() {
  const require = createRequire(import.meta.url);
  if (process.env.PLAYWRIGHT_MODULE) return require(process.env.PLAYWRIGHT_MODULE);
  const candidates = ["playwright"];
  if (process.env.LOCALAPPDATA) {
    const cache = join(process.env.LOCALAPPDATA, "npm-cache", "_npx");
    if (existsSync(cache)) for (const dir of readdirSync(cache)) candidates.push(join(cache, dir, "node_modules", "playwright"));
  }
  let fallback;
  for (const candidate of candidates) {
    try {
      const module = require(candidate);
      if (existsSync(module.chromium.executablePath())) return module;
      fallback ??= module;
    } catch (error) {
      if (error.code !== "MODULE_NOT_FOUND") throw error;
    }
  }
  if (fallback) return fallback;
  throw new Error("Playwright not found; set PLAYWRIGHT_MODULE to the installed package path");
}

// Runs inside Chromium. The wrappers observe actual fixed-step poses and the applied district command;
// neither changes the City, controls, spawn schedule, driver decisions, or actor physics.
function installBrowserObserver() {
  const { world, view } = window.sim;
  const observer = {
    world, view, actorIds: new Set(world.actors.map(({ id }) => id)), roads: world.roads, statics: world.statics,
    bundle: document.querySelector('script[src$="game.bundle.js"]')?.src,
    command: null, requestEvents: new Map(), longestUnexplainedStop: { ticks: 0 }, unexplainedStopTicks: 0, maxJump: { distanceM: 0 }, teleports: [], stoppedTicks: 0, longestStall: { ticks: 0 },
    maxSteerDelta: 0, steeringReversals: 0, oscillations: [], steerSign: 0, lastReversal: -Infinity, burst: 0,
    rearSideEmergencyFrames: [], closestTruck: null, nearTruckFollowingTicks: 0, nearTruckHeldTicks: 0, truckPasses: [], followedTrucks: new Set(),
  };
  window.__cairoObserver = observer;
  const step = world.step;
  const districtCommand = world.districtDrivingCommand;
  world.districtDrivingCommand = function (actor, ...args) {
    const next = districtCommand.call(this, actor, ...args);
    if (actor === this.player) observer.command = {
      targetSpeed: next.targetSpeed, commandSteer: next.steer, reason: next.reason, blockedBy: next.blockedBy,
    };
    return next;
  };
  const relative = (ego, a) => {
    const dx = a.x - ego.x, dz = a.z - ego.z;
    return {
      dx_fwd: dx * Math.sin(ego.heading) + dz * Math.cos(ego.heading),
      dx_lat: dx * Math.cos(ego.heading) - dz * Math.sin(ego.heading),
      distanceM: Math.hypot(dx, dz), headingDelta: angle(a.heading - ego.heading),
    };
  };
  const angle = (a) => Math.atan2(Math.sin(a), Math.cos(a));
  world.step = function (...args) {
    if (!this.streetChaos?.active) return step.apply(this, args);
    const prev = new Map(this.actors.filter((a) => a.type === "vehicle").map(({ id, x, z }) => [id, { x, z }]));
    const prevSteer = this.player.steer;
    const priorRequest = this.streetChaos.request;
    const stepTick = this.tick;
    const result = step.apply(this, args);
    const request = this.streetChaos.request;
    if (request?.id && request.status === "started" && priorRequest?.id === request.id && priorRequest.status === "pending") {
      const event = this.streetChaos.events.find((event) => event.kind === request.kind && event.startTick === stepTick);
      if (event) observer.requestEvents.set(request.id, event.id);
    }
    const ego = this.player;
    for (const actor of this.actors) {
      const p = prev.get(actor.id);
      if (p) {
        const distanceM = Math.hypot(actor.x - p.x, actor.z - p.z);
        if (distanceM > observer.maxJump.distanceM) observer.maxJump = { actorId: actor.id, tick: this.tick, distanceM };
        if (distanceM > 2.5) observer.teleports.push({ actorId: actor.id, tick: this.tick, distanceM });
      }
      if (actor.kind !== "truck") continue;
      const r = relative(ego, actor);
      if (Math.abs(r.headingDelta) > 0.45) continue;
      if (r.dx_fwd >= 5 && r.dx_fwd <= 34 && Math.abs(r.dx_lat) < (ego.width + actor.width) / 2) {
        observer.nearTruckFollowingTicks++;
        observer.followedTrucks.add(actor.id);
        if (ego.speed <= actor.speed + 0.6) observer.nearTruckHeldTicks++;
        if (!observer.closestTruck || r.distanceM < observer.closestTruck.distanceM) observer.closestTruck = {
          tick: this.tick, id: actor.id, ...r, egoSpeedMps: ego.speed, truckSpeedMps: actor.speed,
        };
      }
      if (observer.followedTrucks.has(actor.id) && r.dx_fwd < -(actor.length + ego.length) / 2 &&
          Math.abs(r.dx_lat) > 1.5 && Math.abs(r.dx_lat) < 8 && !observer.truckPasses.some((p) => p.id === actor.id))
        observer.truckPasses.push({ tick: this.tick, id: actor.id, ...r });
    }
    const reaction = this.streetChaos.egoReaction;
    if (reaction?.reaction === "emergency-brake" && this.streetChaos.events.some((event) =>
      event.kind === "ghorz" && event.actorIds.includes(reaction.threatId))) {
      const actor = this.actors.find((a) => a.id === reaction.threatId);
      if (actor) {
        const r = relative(ego, actor);
        if (r.dx_fwd < 0 && Math.abs(r.dx_lat) > (ego.width + actor.width) / 2 &&
            Math.abs(r.headingDelta) < 0.1 && r.dx_lat * Math.sin(r.headingDelta) >= -0.02)
          observer.rearSideEmergencyFrames.push({ tick: this.tick, actorId: actor.id, ...r,
            egoSpeedMps: ego.speed, weaverSpeedMps: actor.speed, targetSpeed: observer.command?.targetSpeed, ttcS: reaction.ttcS });
      }
    }
    observer.stoppedTicks = Math.abs(ego.speed) < 0.3 ? observer.stoppedTicks + 1 : 0;
    if (observer.stoppedTicks > observer.longestStall.ticks) observer.longestStall = {
      ticks: observer.stoppedTicks, startTick: this.tick - observer.stoppedTicks + 1, endTick: this.tick, reason: ego.reason,
      blockedBy: ego.blockedBy,
    };
    const junctionHold = this.streetChaos.egoReaction?.reaction === "junction-hold";
    observer.unexplainedStopTicks = !junctionHold && observer.stoppedTicks > 0 ? observer.unexplainedStopTicks + 1 : 0;
    if (observer.unexplainedStopTicks > observer.longestUnexplainedStop.ticks) observer.longestUnexplainedStop = {
      ticks: observer.unexplainedStopTicks, startTick: this.tick - observer.unexplainedStopTicks + 1, endTick: this.tick,
      reason: ego.reason, blockedBy: ego.blockedBy,
    };
    observer.maxSteerDelta = Math.max(observer.maxSteerDelta, Math.abs(ego.steer - prevSteer));
    const sign = Math.abs(ego.steer) >= 0.035 ? Math.sign(ego.steer) : 0;
    if (sign && observer.steerSign && observer.steerSign !== sign) {
      observer.steeringReversals++;
      observer.burst = this.tick - observer.lastReversal <= 39 ? observer.burst + 1 : 1;
      if (observer.burst === 4) observer.oscillations.push({ tick: this.tick, reason: ego.reason });
      observer.lastReversal = this.tick;
    }
    if (sign) observer.steerSign = sign;
    return result;
  };

  const pose = ({ id, kind, x, z, y, speed, heading, steer, length, width, height, reason, blockedBy }) =>
    ({ id, kind, x, z, y, speed, heading, steer, length, width, height, reason, blockedBy });
  const lane = (body, minWidth = 0) => {
    let best = null;
    for (const r of world.district.drivingRoads) {
      if (r.width < minWidth || r.parkingBay || r.supportApron) continue;
      const dx = body.x - r.x1, dz = body.z - r.z1;
      const along = r.axis === "x" ? body.x : r.axis === "z" ? body.z : dx * r.ux + dz * r.uz;
      const left = r.axis === "x" ? body.z - r.fixed : r.axis === "z" ? r.fixed - body.x : -dx * r.uz + dz * r.ux;
      const h = r.axis === "x" ? Math.PI / 2 : r.axis === "z" ? 0 : r.heading ?? Math.atan2(r.ux, r.uz);
      const phi = angle(body.heading - h), d = Math.abs(phi) <= Math.PI / 2 ? 1 : -1;
      const psi = Math.abs(angle(d === 1 ? phi : phi - Math.PI));
      if (along < r.min || along > r.max || Math.abs(left) > r.width / 2 || psi >= (best?.psi ?? 0.8)) continue;
      best = { id: r.id, width: r.width, lat: -d * left, laneOffsetM: r.laneOffsetM, psi, d, s: d * along };
    }
    return best;
  };
  observer.read = (ids, audit = true) => {
    const s = window.sim, w = s.world, e = w.player;
    const state = s.cairoChaosState();
    const tracked = [...new Set([...ids, ...(state?.activeEvents ?? []).flatMap((a) => a.actorIds),
      ...(state?.accidentActorIds ?? []), ...w.actors.filter((a) => a.kind === "truck").map((a) => a.id)])];
    const byId = new Map(w.actors.map((a) => [a.id, a]));
    const actors = tracked.map((id) => byId.get(id)).filter(Boolean).map((a) => {
      const record = s.view.roots.get(a.id);
      const p = { ...pose(a), ...relative(e, a), road: lane(a), accident: state?.accidentActorIds.includes(a.id) ?? false };
      if (p.accident) p.render = {
        role: state.accidentRoles?.[a.id]?.role ?? null,
        hazardFlasherVisible: record?.hazardFlasher?.visible ?? false,
        hazardFlasherParts: record?.hazardFlasher?.children.length ?? 0,
        smokeVisible: record?.accidentSmoke?.visible ?? false,
        smokeParts: record?.accidentSmoke?.children.length ?? 0,
        smokeColor: record?.accidentSmoke?.children[0]?.material?.color.getHexString() ?? null,
        externalFlashers: record?.hazardFlasher?.parent?.isGroup === true && record.hazardFlasher.parent === s.view.crashEffects?.layer,
        visualDamageKey: record?.lastTrafficDmgKey ?? null,
      };
      return p;
    });
    const a = w.streetChaos?.accident;
    let wreck = null;
    if (a) {
      const { road: r, d } = a;
      const sEgo = d * (r.axis === "x" ? e.x : r.axis === "z" ? e.z : (e.x - r.x1) * r.ux + (e.z - r.z1) * r.uz);
      const lat = -d * (r.axis === "x" ? e.z - r.fixed : r.axis === "z" ? r.fixed - e.x :
        -(e.x - r.x1) * r.uz + (e.z - r.z1) * r.ux);
      const h = angle(e.heading - a.laneHeading);
      const halfLength = (Math.abs(Math.cos(h)) * e.length + Math.abs(Math.sin(h)) * e.width) / 2;
      const halfWidth = (Math.abs(Math.sin(h)) * e.length + Math.abs(Math.cos(h)) * e.width) / 2;
      wreck = { eventId: a.eventId, formed: a.formed, variant: a.variant, roadId: r.id, sEgo, egoRoadLat: lat,
        gapAheadM: a.sMin - sEgo - halfLength, rearPastWreckM: sEgo - halfLength - a.sMax,
        sideClearanceM: Math.max(a.latMin - lat - halfWidth, lat - halfWidth - a.latMax),
        bypassCorridorM: Math.max(a.latMin + a.halfW, -0.2 - a.latMax), impactTick: a.impactTick };
    }
    const offLaneWitnesses = state?.active ? w.actors.filter((actor) => actor.type === "vehicle" && actor !== e &&
      Math.hypot(actor.x - e.x, actor.z - e.z) <= 120 && actor.speed > 1).map((actor) => {
      const road = lane(actor);
      return { id: actor.id, road, laneOffsetErrorM: road ? Math.abs(road.lat + road.laneOffsetM) : null };
    }).filter((a) => a.road?.psi <= 0.2 && a.road.lat < 0 && a.laneOffsetErrorM >= 0.7) : [];
    const hudNotice = document.getElementById("chaosNotice");
    const notice = hudNotice && { hidden: hudNotice.hidden, text: hudNotice.textContent.trim(), className: hudNotice.className };
    return { tick: w.tick, environment: w.environment, state, actors, wreck, offLaneWitnesses, notice,
      requestedEventId: observer.requestEvents.get(state?.request?.id) ?? null,
      ego: { ...pose(e), road: lane(e), ...observer.command, egoReaction: state?.egoReaction, distance: e.distance,
        collisions: e.vehicle?.damage?.impactCount, brake: e.vehicle?.controls?.brake },
      auditErrors: audit ? w.audit() : [], pending: w.streetChaos?.pending ?? [], lastFailure: w.streetChaos?.lastFailure ?? null,
    };
  };
  observer.observe = (stage, ids, cap, args) => {
    const locate = (frame) => [...(frame.state?.activeEvents ?? []), ...(frame.state?.recentEvents ?? [])]
      .find((e) => e.id === args.eventId);
    const ownWreck = (frame) => frame.wreck?.eventId === args.eventId && frame.wreck?.formed;
    const matches = (f) => {
      switch (stage) {
        case "near-truck": return f.actors.some((a) => a.kind === "truck" && a.road?.width >= 11 &&
          a.dx_fwd > 0 && Math.abs(a.headingDelta) < 0.45 && a.distanceM <= 45);
        case "requested": return f.state?.request?.id === args.requestId &&
          ["started", "rejected", "expired"].includes(f.state.request.status);
        case "ghorz-response": return ["cut", "settle"].includes(locate(f)?.phase) &&
          f.actors.some((a) => args.actorIds.includes(a.id) && a.dx_fwd > 0 && Math.abs(a.steer) >= 0.015);
        case "lane-cut": return ["cut", "settle"].includes(locate(f)?.phase) &&
          f.actors.some((a) => args.actorIds.includes(a.id) && Math.abs(a.steer) >= 0.015);
        case "ended": return Boolean(locate(f)?.outcome);
        case "wreck-approach": return ownWreck(f) && f.wreck.gapAheadM > 0 && f.wreck.gapAheadM <= 28;
        case "wreck-alongside": return ownWreck(f) && f.ego.road?.id === f.wreck.roadId &&
          f.wreck.gapAheadM <= 1 && f.wreck.rearPastWreckM < 3 && f.wreck.sideClearanceM > 0;
        case "wreck-cleared": return ownWreck(f) && f.ego.road?.id === f.wreck.roadId && f.wreck.rearPastWreckM >= 2;
        default: throw new Error(`Unknown observation stage: ${stage}`);
      }
    };
    const stopped = (f) => stage.startsWith("wreck-") && Boolean(locate(f)?.outcome);
    const frames = [];
    let last = observer.read(ids, false);
    for (let i = 0; i < cap && !matches(last) && !stopped(last); i++) {
      window.sim.step(15);
      last = observer.read(ids);
      frames.push(last);
    }
    return { matched: matches(last), ended: stopped(last), frames };
  };
  observer.scene = () => {
    const s = window.sim, w = s.world;
    const actorIds = new Set(w.actors.map(({ id }) => id));
    return { environment: w.environment, mode: w.mode, playerPathLength: w.player.path.length, playerCursor: w.player.cursor,
      sameWorld: w === world, sameView: s.view === view,
      sameRoads: w.roads === observer.roads, sameStatics: w.statics === observer.statics,
      pedestrians: w.actors.filter((a) => a.type === "pedestrian").length,
      ambientVehicles: w.actors.filter((a) => a.type === "vehicle" && a !== w.player && !a.id.startsWith("chaos-")).length,
      absentAmbientIds: [...observer.actorIds].filter((id) => !actorIds.has(id)),
      chaosIds: [...actorIds].filter((id) => id.startsWith("chaos-")),
      truckCount: w.actors.filter((a) => a.kind === "truck").length };
  };
  observer.stats = () => ({ maxStepJump: observer.maxJump, teleports: observer.teleports,
    longestStall: observer.longestStall, longestUnexplainedStop: observer.longestUnexplainedStop, maxSteerDelta: observer.maxSteerDelta,
    steeringReversals: observer.steeringReversals, oscillations: observer.oscillations, closestTruck: observer.closestTruck,
    truckFollowingTicks: observer.nearTruckFollowingTicks, truckHeldBehindTicks: observer.nearTruckHeldTicks,
    truckPasses: observer.truckPasses, rearSideEmergencyFrames: observer.rearSideEmergencyFrames });
  observer.frame = (camera, ids) => {
    const w = window.sim.world, e = w.player;
    const parts = ids.map((id) => w.actors.find((a) => a.id === id)).filter(Boolean);
    if (!camera || !parts.length) { window.sim.setFreeCameraShot(null); return; }
    const a = parts[0];
    if (camera === "truck") {
      const sx = Math.sin(a.heading), sz = Math.cos(a.heading), y = a.y ?? 0;
      window.sim.setFreeCameraShot({ pos: { x: a.x + sx * 9 + sz * 7, y: y + 4.2, z: a.z + sz * 9 - sx * 7 },
        lookAt: { x: a.x, y: y + 1.6, z: a.z } });
      return;
    }
    const dx = a.x - e.x, dz = a.z - e.z, d = Math.hypot(dx, dz);
    const look = d > 65 ? 0.25 : 0.53;
    const x = e.x + dx * look, z = e.z + dz * look;
    const h = camera === "accident" ? Math.min(36, 10 + d * 0.62) : Math.min(28, 8 + d * 0.44);
    const sx = Math.sin(e.heading), sz = Math.cos(e.heading), y = e.y ?? 0;
    window.sim.setFreeCameraShot({ pos: { x: x - sx * (8 + d * 0.22) + sz * 5, y: y + h, z: z - sz * (8 + d * 0.22) - sx * 5 },
      lookAt: { x, y: y + 0.65, z } });
  };
  return { scene: observer.scene(), bundle: observer.bundle };
}

async function browserMotion() {
  const url = new URL(process.env.THREEJS_URL || "http://127.0.0.1:8769");
  const report = { passed: false, pageErrors: 0, consoleErrors: [], errors: [], truckCount: 0, collisions: 0,
    cleanExitRestored: false, shots: [], trajectories: { sampleEveryTicks: SAMPLE_TICKS, sampleEveryS: SAMPLE_TICKS * STEP,
      coordinates: "x/z in world metres; dx_fwd positive ahead, dx_lat positive steering-positive, headings radians, speeds m/s",
      frames: [], events: {} }, motionAnomalies: [], failures: [], run: { url: url.href, mode: "paused browser rendering with real 60Hz World ticks stepped between user actions" } };
  let browser;
  try {
    const response = await fetch(new URL("/api/health", url), { signal: AbortSignal.timeout(8000) });
    const health = await response.json();
    if (!response.ok || !health.ok || health.mode !== "threejs" || health.externalSimulator !== false)
      throw new Error(`Not a healthy standalone Three.js server: HTTP ${response.status} ${JSON.stringify(health)}`);
    report.run.health = health;
    const { chromium } = loadPlaywright();
    browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE } : {}) });
    report.run.chromium = browser.version();
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
    page.setDefaultTimeout(25_000);
    page.on("pageerror", (error) => { report.pageErrors++; report.errors.push(error.stack ?? error.message); });
    page.on("console", (msg) => { if (msg.type() === "error") report.consoleErrors.push(msg.text()); });
    page.on("response", (res) => {
      if (res.status() >= 400 && new URL(res.url()).pathname !== "/favicon.ico") report.errors.push(`HTTP ${res.status()} ${res.url()}`);
    });
    const check = (ok, message) => { if (!ok) report.failures.push(message); return Boolean(ok); };
    await page.goto(url.href, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.sim?.defaultChaseReady && window.sim.view.actorDiagnostics().ready, null, { timeout: 100_000 });
    await page.evaluate(() => window.sim.pause(true));
    const setup = await page.evaluate(installBrowserObserver);
    report.run.before = setup.scene;
    if (setup.bundle) {
      const bundle = await fetch(setup.bundle, { signal: AbortSignal.timeout(8000) });
      if (bundle.ok) {
        report.run.servedBundleSha256 = createHash("sha256").update(Buffer.from(await bundle.arrayBuffer())).digest("hex");
        report.run.checkoutBundleSha256 = createHash("sha256").update(await readFile(new URL("../public/threejs/game.bundle.js", import.meta.url))).digest("hex");
        check(report.run.servedBundleSha256 === report.run.checkoutBundleSha256, "served browser bundle does not match the checkout build");
      } else check(false, `could not identify served browser bundle: HTTP ${bundle.status}`);
    } else check(false, "browser bundle script not found");
    const tracked = new Set();
    let current;
    const sample = async (count = 0, label = null, keep = true) => {
      current = await page.evaluate(({ count, ids }) => {
        if (count) window.sim.step(count);
        return window.__cairoObserver.read(ids);
      }, { count, ids: [...tracked] });
      if (keep) report.trajectories.frames.push({ label, ...current });
      return current;
    };
    const shot = async (name, camera = null, ids = [], milestone = true) => {
      await page.evaluate(({ camera, ids }) => {
        window.__cairoObserver.frame(camera, ids);
        return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      }, { camera, ids });
      const before = current.tick;
      const hud = await page.evaluate(() => Object.fromEntries(["chaosBar", "chaosStatsText", "chaosHazardStatus", "chaosReactionStatus", "stopChaosBtn", "loadingStatus", "pakoBtn", "cairoChaosBtn", "chaosNotice"].map((id) => {
        const n = document.getElementById(id);
        if (!n) return [id, null];
        const { x, y, width, height } = n.getBoundingClientRect();
        return [id, { text: n.innerText.trim(), x, y, width, height, hidden: n.hidden, className: n.className, title: n.getAttribute("title"), ariaLabel: n.getAttribute("aria-label") }];
      })));
      const png = await page.screenshot({ path: join(output, name), scale: "css", timeout: 45_000 });
      const displayed = await page.evaluate(() => ({ tick: window.sim.world.tick, diagnostics: window.sim.renderDiagnostics(),
        evidence: window.__cairoObserver.read([], false) }));
      const { actors, ego, wreck, state } = displayed.evidence;
      check(before === displayed.tick, `${name}: simulation advanced during frame capture`);
      report.shots.push({ name, tick: displayed.tick, camera: camera ?? "default", focusIds: ids, milestone,
        bytes: png.length, sha256: createHash("sha256").update(png).digest("hex"), hud,
        cameraPosition: displayed.diagnostics.cameraPosition, ego, wreck, actors: actors.filter((a) => ids.includes(a.id)),
        driverMode: state?.driverMode ?? null });
    };
    const tickUntil = async (stage, cap, args = {}) => {
      for (let remaining = cap; remaining > 0; remaining -= 20) {
        const result = await page.evaluate(({ stage, ids, cap, args }) => window.__cairoObserver.observe(stage, ids, cap, args),
          { stage, ids: [...tracked], cap: Math.min(20, remaining), args });
        report.trajectories.frames.push(...result.frames.map((f) => ({ label: null, ...f })));
        if (result.frames.length) current = result.frames.at(-1);
        if (result.matched) return true;
        if (result.ended) return false;
      }
      return false;
    };
    const locate = (binding, frame = current) => [...(frame.state?.activeEvents ?? []), ...(frame.state?.recentEvents ?? [])]
      .find((event) => event.id === binding.eventId);
    const trigger = async (kind, selector) => {
      const binding = { requestedAtTick: current.tick, attempts: [], eventId: null, actorIds: [] };
      report.trajectories.events[kind] = binding;
      for (let retry = 0; retry < (kind === "lane-change" ? 2 : 1) && !binding.eventId; retry++) {
        if (retry) await sample(ticks(0.5), `${kind}-retry-approach`);
        const existing = [...(current.state?.activeEvents ?? []), ...(current.state?.recentEvents ?? [])].map((a) => a.id);
        const attempt = { requestTick: current.tick, ego: current.ego };
        binding.attempts.push(attempt);
        await page.locator(selector).click();
        await sample(0, `${kind}-button`);
        attempt.immediate = { pending: current.pending, lastFailure: current.lastFailure, request: current.state?.request, notice: current.notice };
        const { request, notice } = attempt.immediate;
        check(request?.kind === kind && /^req-\d+$/.test(request.id) && request.atTick === attempt.requestTick &&
          !Object.values(report.trajectories.events).some((other) => other !== binding &&
            other.attempts.some((tryAgain) => tryAgain.immediate?.request?.id === request.id)), `${kind}: invalid UI request identity or timestamp`);
        if (["pending", "rejected", "expired"].includes(request?.status))
          check(notice && !notice.hidden && notice.className.includes(`chaos-notice--${request.status}`) &&
            notice.text && (!request.reason || notice.text === request.reason) && !/chaos-event-\d+|\w+:\d+/.test(notice.text),
            `${kind}: HUD notice did not show a readable ${request.status} request`);
        if (request?.id) await tickUntil("requested", kind === "accident" ? 360 : 180, { requestId: request.id });
        attempt.final = { request: current.state?.request, notice: current.notice, requestedEventId: current.requestedEventId };
        const finalRequest = attempt.final.request;
        const event = finalRequest?.id === request?.id && finalRequest?.status === "started" &&
          [...(current.state?.activeEvents ?? []), ...(current.state?.recentEvents ?? [])]
            .find((a) => a.kind === kind && !existing.includes(a.id) && a.startTick >= attempt.requestTick &&
              (current.requestedEventId ? a.id === current.requestedEventId : a.startTick === attempt.requestTick));
        if (event) {
          Object.assign(binding, { eventId: event.id, actorIds: event.actorIds, startTick: event.startTick, firstObservedTick: current.tick });
          for (const id of binding.actorIds) tracked.add(id);
        } else attempt.finalFailure = current.lastFailure;
      }
      if (!binding.eventId) check(false, `${kind}: no event actor after UI request (${current.state?.request?.reason ?? current.lastFailure ?? "no reason"})`);
      return binding;
    };
    await page.locator("#cairoChaosBtn").evaluate((button) => {
      button.addEventListener("click", () => window.sim.pause(true), { once: true });
    });
    await page.locator("#cairoChaosBtn").click();
    await sample(0, "cairo-mode-start");
    const bar = page.locator("#chaosBar");
    const hudOpened = await bar.isVisible();
    const trucks = current.actors.filter((a) => a.kind === "truck");
    report.truckCount = trucks.length;
    report.run.startTick = current.tick;
    const startDistance = current.ego.distance;
    const startCollisions = current.ego.collisions;
    check(hudOpened && current.state?.active && current.environment === "metro" && current.state.driverMode === "auto",
      "real Cairo Traffic control did not open the HUD and enable Defensive AI in Metro City");
    check(report.truckCount >= 4 && report.truckCount === current.state?.truckCount, "fewer than four active heavy trucks");
    await shot("01-cairo-traffic-start-hud.png", null, [], hudOpened);
    const closestWideTruck = () => current.actors.filter((a) => a.kind === "truck" && a.road?.width >= 11 && a.dx_fwd > 0 && Math.abs(a.headingDelta) < 0.45)
      .sort((a, b) => a.distanceM - b.distanceM)[0];
    await tickUntil("near-truck", 12);
    const truck = closestWideTruck();
    let truckMilestone = truck?.distanceM <= 65;
    await shot("02-heavy-truck-close.png", "truck", truck ? [truck.id] : [], truckMilestone);

    const ghorz = await trigger("ghorz", "#chaosTriggerGhorzBtn");
    await shot("03-ghorz-t0.png", "cut", ghorz.actorIds, Boolean(ghorz.eventId));
    const ghorzCut = ghorz.eventId && await tickUntil("ghorz-response", 52, ghorz);
    check(ghorzCut, "Ghorz never reached a visible cut or an attributed defensive reaction within 13 seconds");
    await shot("04-ghorz-t1-evade.png", "cut", ghorz.actorIds, Boolean(ghorzCut));

    const lane = await trigger("lane-change", "#chaosTriggerLaneBtn");
    const laneCut = lane.eventId && await tickUntil("lane-cut", 28, lane);
    check(laneCut, "lane cutter did not physically begin its lane cut within seven seconds");
    await shot("05-lane-change-cut.png", "cut", lane.actorIds, Boolean(laneCut));

    const activeAcc = current.wreck?.eventId ?? current.state?.activeEvents?.find((e) => e.kind === "accident")?.id;
    if (activeAcc) await tickUntil("ended", 240, { eventId: activeAcc });
    const accident = await trigger("accident", "#chaosTriggerAccidentBtn");
    const accidentWitness = accident.eventId ? accident : { eventId: current.wreck?.eventId,
      actorIds: current.state?.activeEvents.find((e) => e.id === current.wreck?.eventId)?.actorIds ?? [] };
    if (!accident.eventId && accidentWitness.eventId) report.run.automaticWreckWitness = accidentWitness;
    const approach = accident.eventId && await tickUntil("wreck-approach", 84, accident);
    check(approach, "no formed wreck approached within 28 m during the bounded observation");
    await shot("06-accident-ahead-approach.png", "accident", accidentWitness.actorIds, Boolean(approach));
    const alongside = accident.eventId && await tickUntil("wreck-alongside", 100, accident);
    check(alongside, "ego did not draw alongside the wreck with positive lateral clearance");
    await shot("07-accident-bypass.png", "accident", accidentWitness.actorIds, Boolean(alongside));
    const passedWreck = accident.eventId && await tickUntil("wreck-cleared", 54, accident);
    check(passedWreck, "ego did not demonstrably clear the rear of the accident wreck");
    report.run.wreckClearance = passedWreck ? { tick: current.tick, ...current.wreck } : null;
    if (passedWreck) await tickUntil("ended", 100, accident);
    check(locate(accident)?.outcome === "cleared-passed", "street-chaos did not emit cleared-passed for the requested accident");
    for (const event of [ghorz, lane]) if (event.eventId) await tickUntil("ended", 28, event);
    if (!truckMilestone) {
      await tickUntil("near-truck", 36);
      const near = closestWideTruck();
      if (near?.distanceM <= 65) {
        report.shots.splice(report.shots.findIndex((shot) => shot.name === "02-heavy-truck-close.png"), 1);
        await shot("02-heavy-truck-close.png", "truck", [near.id], true);
        truckMilestone = true;
      }
    }
    check(truckMilestone, "no nearby same-flow heavy truck on a wide avenue at close-up");
    await sample(0, "before-mode-exit");
    const beforeExit = current;
    report.collisions = Math.max(current.state?.metrics.collisions ?? 0, current.ego.collisions - startCollisions);
    report.run.distanceM = round(current.ego.distance - startDistance);
    report.run.truckAndMotion = await page.evaluate(() => window.__cairoObserver.stats());
    for (const [kind, binding] of Object.entries(report.trajectories.events)) {
      const match = locate(binding, beforeExit);
      binding.outcome = match?.outcome ?? null;
      binding.lastPhase = match?.phase ?? null;
      binding.endTick = match?.endTick ?? null;
      if (kind !== "accident") check(binding.outcome === "completed", `${kind}: completion not observed (${binding.outcome ?? binding.lastPhase ?? "no event"})`);
    }
    check(report.trajectories.frames.some((f) => f.ego.egoReaction?.reaction === "accident-bypass" &&
      accident.actorIds.includes(f.ego.egoReaction.threatId)) && passedWreck, "no accident-attributed Defensive AI bypass with measured clearance");
    check(report.trajectories.frames.some((f) => f.state?.offLaneCount > 0 && f.offLaneWitnesses.length), "no active off-lane traffic measured");
    const driverButton = page.locator("#chaosDriverBtn");
    await driverButton.click();
    await sample(0, "manual-takeover");
    const manual = current.state?.driverMode === "manual" && await driverButton.getAttribute("aria-pressed") === "true";
    await driverButton.click();
    await sample(0, "defensive-resumed");
    report.run.manualTakeover = check(manual && current.state?.driverMode === "auto" &&
      await driverButton.getAttribute("aria-pressed") === "false", "Cairo driver control did not switch manual and back to Defensive AI");
    await page.locator("#stopChaosBtn").click();
    await sample(SAMPLE_TICKS, "city-restored");
    const clean = await page.evaluate(() => window.__cairoObserver.scene());
    report.run.after = clean;
    report.cleanExitRestored = check(!(await bar.isVisible()) && current.state?.active === false &&
      current.state?.truckCount === 0 && clean.truckCount === 0 && clean.chaosIds.length === 0 && clean.environment === "metro" &&
      clean.sameWorld && clean.sameView && clean.sameRoads && clean.sameStatics && !clean.absentAmbientIds.length &&
      clean.pedestrians === report.run.before.pedestrians && clean.ambientVehicles === report.run.before.ambientVehicles &&
      clean.mode === report.run.before.mode && (clean.mode === "manual" ? clean.playerPathLength === 0 && clean.playerCursor === 0 :
        clean.playerPathLength === report.run.before.playerPathLength),
    "mode exit left Cairo actors, the Cairo route, or failed to restore the same ambient City");
    await shot("08-clean-exit-city.png", null, [], report.cleanExitRestored);

    const seenAudit = new Set();
    for (const f of report.trajectories.frames) for (const error of f.auditErrors) if (!seenAudit.has(error)) {
      seenAudit.add(error);
      report.motionAnomalies.push({ kind: error.startsWith("overlap:") ? "clipping" : "world-audit", tick: f.tick, detail: error });
    }
    const m = report.run.truckAndMotion;
    for (const jump of m.teleports) report.motionAnomalies.push({ kind: "teleport", ...jump });
    for (const burst of m.oscillations) report.motionAnomalies.push({ kind: "rapid-steering-reversals", ...burst });
    if (m.longestUnexplainedStop.ticks >= ticks(5)) report.motionAnomalies.push({ kind: "unexplained-stall",
      ...m.longestUnexplainedStop, seconds: m.longestUnexplainedStop.ticks * STEP });
    if (m.longestStall.ticks >= ticks(18)) report.motionAnomalies.push({ kind: "prolonged-stop",
      ...m.longestStall, seconds: m.longestStall.ticks * STEP });
    for (const [kind, b] of Object.entries(report.trajectories.events)) if (b.outcome === "aborted" || b.outcome === "no-impact")
      report.motionAnomalies.push({ kind: "maneuver-not-completed", maneuver: kind, outcome: b.outcome, tick: b.endTick });
    const approachShot = report.shots.find((a) => a.name.startsWith("06-"));
    const renderedWrecks = approachShot.actors.filter((a) => a.accident && a.render?.smokeVisible && a.render.smokeParts > 0 &&
      a.render.externalFlashers && a.render.hazardFlasherParts >= 4 && a.render.visualDamageKey?.endsWith("|1"));
    check(renderedWrecks.length >= 2 && renderedWrecks.some((a) => a.render.hazardFlasherVisible),
      "the wreck approach frame did not render two damaged vehicles, external alternating flashers and smoke cues");
    check(m.rearSideEmergencyFrames.length === 0, "Ghorz caused emergency braking for a still-behind, separated, non-closing-laterally weaver");
    check(report.motionAnomalies.length === 0 && report.collisions === 0, "live motion showed a collision, audit fault, stall, or anomalous maneuver");
    const labels = { cruising: "Cruising", "defensive-yield": "Yielding", "evasive-shift": "Evasive Shift",
      "accident-bypass": "Accident Bypass", "defensive-brake": "Defensive Brake", "emergency-brake": "Emergency Brake",
      "junction-hold": "Junction Hold", "no-route": "Rerouting" };
    report.hudIssues = report.shots.flatMap(({ name, hud, ego }) => {
      const issues = [];
      const actual = ego.egoReaction?.reaction;
      const badge = hud.chaosReactionStatus;
      if (hud.chaosBar?.hidden === false && actual &&
          (badge?.text !== labels[actual] || (ego.egoReaction.reasonDetail &&
            (badge?.title !== ego.egoReaction.reasonDetail || badge?.ariaLabel !== ego.egoReaction.reasonDetail))))
        issues.push({ kind: "misleading-reaction", name, shown: badge?.text, expected: labels[actual], actual });
      const c = hud.chaosBar, l = hud.loadingStatus;
      if (c?.width && l?.width && c.x < l.x + l.width && l.x < c.x + c.width && c.y < l.y + l.height && l.y < c.y + c.height)
        issues.push({ kind: "overlapping-status-bars", name, overlapHeightPx: Math.min(c.y + c.height, l.y + l.height) - Math.max(c.y, l.y) });
      return issues;
    });
    report.shots.sort((a, b) => a.name.localeCompare(b.name));
    check(report.shots.filter((s) => !s.hud.chaosBar?.hidden).every((s) =>
      /^Trucks \d+ \u00b7 Avoided \d+ \u00b7 Contacts \d+$/.test(s.hud.chaosStatsText?.text)), "Cairo stats have unreadable separators");
    report.hudMaxOverlapPx = Math.max(0, ...report.hudIssues.map((a) => a.overlapHeightPx ?? 0));
    check(!report.hudIssues.length, "Cairo reaction HUD disagreed with the reported reaction or overlapped the City readout");
    check(report.shots.length >= 8 && report.shots.every((s) => s.bytes >= 10_000), "motion captures missing or blank");
    check(!report.pageErrors && !report.consoleErrors.length && !report.errors.length, "browser page, console, or request errors");
    report.passed = !report.failures.length;
  } catch (error) {
    report.failures.push(error.stack ?? error.message);
  } finally {
    await browser?.close();
    await save("browser-motion-report.json", report);
  }
  console.log(`Cairo browser motion ${report.passed ? "passed" : "failed"}: ${report.failures.join("; ") || "live journey recorded"}`);
  return report.passed ? 0 : 2;
}

const mode = process.argv[2];
if (!["benchmark", "negative-control", "browser"].includes(mode)) {
  console.error("Usage: node tools/verify-cairo-traffic.mjs benchmark|negative-control|browser");
  process.exitCode = 2;
} else {
  await mkdir(output, { recursive: true });
  process.exitCode = await (mode === "benchmark" ? benchmark() : mode === "negative-control" ? negativeControl() : browserMotion());
}
