import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { STEP } from "../src/core/config.js";
import { bodyOnRoad, distance, overlaps } from "../src/core/geometry.js";
import { updateDispatchEscape } from "../src/core/pursuit-dispatch.js";
import { gtaOffset } from "../src/core/pursuit-gta.js";
import { gtaLineClear, updatePursuitResponse } from "../src/core/pursuit-response.js";
import { SpatialIndex } from "../src/core/spatial-index.js";
import { World } from "../src/core/world.js";
import { PursuitScanner } from "../src/signal_processing/pursuit-scanner.js";
import {
  DISPATCH_OBSERVATION_SCHEMA as schema, getDispatchObservation, GtaPursuitEnv,
} from "../src/rl/gta-pursuit-env.js";
import { guardDispatchAction } from "../src/rl/pursuit-shield.js";
import { applyFrozenDispatchAction } from "../src/rl/pursuit-controller.js";

const SEED = "dispatch-development";
const DRIVE = { steer: 0, throttle: 1, brake: 0, gear: 1 };
const BRAKE = { ...DRIVE, throttle: 0, brake: 1 };
const TOWARD_X = Math.PI / 2;
const DEFAULT_LOCAL_Z = -109.3;
const DISPATCH = "dispatch-v1";
const zone = (id, minX, maxX, minZ = -122, maxZ = -102) => ({ id, minX, maxX, minZ, maxZ });
const legacyControl = process.argv.includes("--legacy-control");

const newMetro = options => new World({ cityVersion: 4, seed: SEED, traffic: 0, pedestrians: 0, ...options }, "metro");
const pose = (body, x, z = DEFAULT_LOCAL_Z, heading = TOWARD_X, speed = 0) =>
  Object.assign(body, { x, z, heading, speed, steer: 0 });
const drive = (world, action = DRIVE, record = false) => world.command({ type: "pursuit-drive", action }, record);
const ticks = (world, count) => {
  for (let i = 0; i < count && world.pursuit.phase === "running"; i++) world.step();
};
const start = (world, config = {}, record = false) => world.command({ type: "street-pursuit-start", variant: "gta",
  config: { ruleset: DISPATCH, maxActivePatrols: 1, enableRoadblocks: false,
    enableRamming: false, enablePitManeuver: false, ...config } }, record);
const addSolid = (world, id, point, width = 4, length = .8, heading = TOWARD_X) => {
  const body = { ...point, type: "static", kind: "block", id, width, length, heading, height: 2 };
  world.statics.push(body);
  world.staticIndex = new SpatialIndex(world.statics);
  return body;
};
function sampleFixture(world) {
  world.pursuit.gta.scanner = new PursuitScanner();
  return world.pursuit.gta.scan = world.pursuit.gta.scanner.sample(world);
}
const round = x => Math.round(x * 1e5) / 1e5;

function measuredSpeed(ruleset) {
  const world = newMetro(), ego = pose(world.player, -205, DEFAULT_LOCAL_Z, TOWARD_X, 28);
  start(world, { ruleset, wantedLevelStart: 5, ...(ruleset === DISPATCH ? {
    surveillanceZones: [zone("speed-strip", -278, -85)],
  } : {}) });
  const [chaser] = world.pursuit.patrols;
  pose(chaser, -247, DEFAULT_LOCAL_Z, TOWARD_X, 28);
  assert.ok(bodyOnRoad(chaser, world.drivingRoads) && bodyOnRoad(ego, world.drivingRoads));
  updatePursuitResponse(world, true);
  drive(world);
  const initialGapM = distance(ego, chaser);
  const rows = [];
  for (let i = 0; i < 180; i++) {
    const a = ego.x, b = chaser.x;
    world.step();
    rows.push({ ego: (ego.x - a) / STEP, patrol: (chaser.x - b) / STEP });
  }
  const plateau = rows.slice(-60);
  const mean = which => plateau.reduce((sum, row) => sum + row[which], 0) / plateau.length;
  const egoMps = mean("ego"), patrolMps = mean("patrol");
  assert.ok(egoMps >= 27.5 && world.pursuit.metrics.collisions === 0);
  assert.ok(plateau.every(row => Math.abs(row.ego - egoMps) < .15), "ego must be saturated");
  const result = { egoMps: round(egoMps), patrolMps: round(patrolMps), ratio: round(patrolMps / egoMps),
    initialGapM, finalGapM: round(distance(ego, chaser)), seconds: rows.length * STEP,
    unitType: chaser.unitType, platoon: platoonTrace(world) };
  if (ruleset === DISPATCH) {
    assert.ok(plateau.every(row => Math.abs(row.patrol - patrolMps) < .2), "patrol must sustain a speed plateau");
    assert.ok(result.ratio >= 1.10 && result.ratio <= 1.25, JSON.stringify(result));
    assert.ok(result.finalGapM < initialGapM - 4, "patrol must close physical distance");
  } else assert.ok(result.ratio < 1, JSON.stringify(result));
  return result;
}

function platoonTrace(world) {
  return [...world.pursuit.patrols].map(({ id, x, z, heading, speed, path, cursor, aiState, squadRole }) =>
    ({ id, x, z, heading, speed, path, cursor, aiState, squadRole }));
}

function idle(ruleset, crippled = false) {
  const env = new GtaPursuitEnv();
  env.reset({ seed: SEED, config: { ruleset, maxActivePatrols: Number(crippled), wantedLevelMax: 1,
    episodeMaxSeconds: 8, ...(crippled ? { npcSpeedMultiplier: .01 } : {}) } });
  const step = env.step(BRAKE, 500);
  const outcome = { phase: step.info.phase, distanceM: env.world.pursuit.metrics.distanceM, reward: step.reward,
    components: step.info.rewardComponents, tick: step.info.tick };
  if (ruleset === DISPATCH) {
    assert.equal(step.terminated, false, JSON.stringify(outcome));
    assert.ok(step.truncated && outcome.reward < 0);
    assert.equal(outcome.components.progress, 0);
  } else assert.ok(step.terminated && step.reward > 0 && outcome.distanceM === 0);
  return outcome;
}

function coverage() {
  const w = newMetro();
  start(w);
  const zones = w.pursuit.gta.config.surveillanceZones;
  let total = 0, uncovered = 0, overlap = 0;
  for (const r of w.drivingRoads) for (let along = r.min + 1; along <= r.max; along += 2) {
    const x = r.axis === "x" ? along : r.fixed, z = r.axis === "z" ? along : r.fixed;
    const count = zones.filter(p => p.minX <= x && p.maxX >= x && p.minZ <= z && p.maxZ >= z).length;
    total++;
    uncovered += Number(count === 0);
    overlap += Number(count > 1);
  }
  assert.ok(uncovered / total > .15 && uncovered / total < .7, "Metro must have substantial covered and uncovered routes");
  assert.ok(overlap >= 5, "zones overlap along live streets");
  return { total, uncovered, overlap };
}

function reportTransitions() {
  const w = newMetro();
  pose(w.player, -254, DEFAULT_LOCAL_Z, TOWARD_X, 5);
  start(w, { surveillanceZones: [zone("west-gate", -258, -253.5)], episodeMaxSeconds: 20 });
  const [patrol] = w.pursuit.patrols;
  pose(patrol, -269);
  patrol.aiState = "ROADBLOCK";
  const wall = addSolid(w, "tracking-test-wall", { x: -263, z: DEFAULT_LOCAL_Z });
  const { response } = w.pursuit;
  updatePursuitResponse(w, true);
  const trace = [];
  const capture = () => trace.push({ tick: w.tick, x: w.player.x, report: response.lastSeen?.x,
    state: response.dispatch.state, local: response.sightedBy.size });
  assert.equal(response.dispatch.state, "ZONE_TRACKED");
  assert.equal(response.sightedBy.size, 0);
  capture();
  drive(w);
  ticks(w, 4);
  assert.ok(response.lastSeen.x > trace[0].report);
  assert.equal(response.lastSeen.tick, w.tick);
  capture();
  ticks(w, 5);
  assert.equal(response.dispatch.state, "LAST_KNOWN");
  const report = response.lastSeen;
  capture();
  drive(w, BRAKE);
  ticks(w, 480);
  assert.equal(w.pursuit.phase, "running");
  assert.ok(w.player.x > report.x && response.lastSeen === report);
  capture();
  assert.equal(response.dispatch.state, "LOST");
  // Fixture variant: remove the occluder, not the patrol, and test the live cone again.
  w.statics.splice(w.statics.indexOf(wall), 1);
  w.staticIndex = new SpatialIndex(w.statics);
  ticks(w, 1);
  assert.equal(response.dispatch.state, "VISUALLY_SPOTTED");
  assert.equal(response.lastSeen.tick, w.tick);
  capture();
  return trace;
}

function physicalReacquisition() {
  function run(occluded, compareTick) {
    const w = newMetro({ seed: "dispatch-reacquire-development-01" });
    const ego = pose(w.player, -198, DEFAULT_LOCAL_Z, TOWARD_X, 5);
    start(w, { wantedLevelStart: 1, wantedLevelMax: 1, episodeMaxSeconds: 12,
      surveillanceZones: [zone("reacquire-start", -205, -192, -112, -106)] });
    const [patrol] = w.pursuit.patrols;
    pose(patrol, -275, DEFAULT_LOCAL_Z, TOWARD_X, 1);
    w.actorIndex = new SpatialIndex(w.actors);
    assert.ok([ego, patrol].every(actor => bodyOnRoad(actor, w.drivingRoads) &&
      !w.statics.some(solid => overlaps(actor, solid, .1))));
    const screen = occluded ? { id: "reacquisition-control-screen", type: "static", kind: "block",
      x: -209, z: DEFAULT_LOCAL_Z, heading: TOWARD_X, width: 12, length: .7, height: 2 } : null;
    if (screen) {
      assert.ok(w.statics.every(solid => !overlaps(solid, screen)));
      // Temporary cover belongs to the physical scene, not the public static street map.
      w.statics = w.statics.concat(screen);
      w.staticIndex = new SpatialIndex(w.statics);
    }
    updatePursuitResponse(w, true);

    const { response } = w.pursuit;
    const transitions = [];
    let originalReport, reacquired, final, matchedFrame;
    const position = actor => [actor.x, actor.z, actor.heading, actor.speed];
    for (let i = 0; i <= 510; i++) {
      assert.equal(w.pursuit.phase, "running");
      assert.ok(w.actors.includes(patrol) && w.pursuit.patrols.has(patrol));
      const state = response.dispatch.state, gap = distance(ego, patrol);
      const row = { tick: w.tick, state, gap, reportTick: response.lastSeen?.tick,
        ego: position(ego), patrol: position(patrol), patrolTravel: patrol.distance,
        sight: response.sightedBy.has(patrol),
        clear: gtaLineClear(w, patrol, ego.x - patrol.x, ego.z - patrol.z, gap) };
      final = row;
      if (w.tick === compareTick) matchedFrame = row;
      if (transitions.at(-1)?.state !== state) transitions.push(row);
      if (state === "LAST_KNOWN") originalReport ??= response.lastSeen;
      if (state === "VISUALLY_SPOTTED") {
        reacquired ??= row;
        assert.ok(row.sight && row.clear && row.gap <= 65);
        assert.equal(row.reportTick, w.tick);
      } else if (originalReport && !reacquired) {
        assert.equal(response.lastSeen, originalReport);
      }
      if (i === 510 || (reacquired && w.tick >= reacquired.tick + 30)) break;
      if (i === 0) drive(w, { ...DRIVE, throttle: .34 });
      if (i === 135) drive(w, BRAKE);
      w.step();
    }
    assert.equal(w.pursuit.metrics.collisions, 0);
    assert.ok(!screen || w.statics.includes(screen));
    assert.deepEqual(transitions.slice(0, 3).map(row => row.state), ["ZONE_TRACKED", "LAST_KNOWN", "SEARCHING"]);
    assert.ok(transitions[0].gap > 65 && !transitions[0].sight);
    return { transitions, reacquired: reacquired ?? null, final, matchedFrame,
      frozenReportTick: originalReport.tick, ambientContacts: w.pursuit.metrics.trafficCollisions };
  }
  const clear = run(false);
  assert.ok(clear.reacquired && clear.reacquired.patrolTravel >= 20);
  assert.ok(clear.final.state === "VISUALLY_SPOTTED" &&
    clear.final.patrolTravel - clear.reacquired.patrolTravel >= 5);
  const { matchedFrame: twin, ...occluded } = run(true, clear.reacquired.tick);
  assert.ok(twin);
  assert.deepEqual(twin.ego, clear.reacquired.ego);
  assert.deepEqual(twin.patrol, clear.reacquired.patrol);
  assert.ok(!twin.clear && !twin.sight && twin.reportTick === occluded.frozenReportTick);
  assert.equal(occluded.reacquired, null);
  assert.equal(occluded.final.state, "LOST");
  assert.equal(occluded.final.reportTick, occluded.frozenReportTick);
  return { clear, occluded, blockedAtSighting: twin, matchedAtSighting: true };
}

function hiddenDispatchTwins() {
  function make() {
    const w = newMetro();
    pose(w.player, -148);
    start(w, { wantedLevelStart: 3, wantedLevelMax: 3, surveillanceZones: [] });
    const [patrol] = w.pursuit.patrols;
    pose(patrol, -269);
    addSolid(w, "far-patrol-occluder", { x: -232, z: -112 }, 14);
    updatePursuitResponse(w, true);
    return w;
  }
  const a = make(), b = make();
  drive(a);
  drive(b, BRAKE);
  for (let i = 0; i < 420; i++) {
    a.step();
    b.step();
    assert.ok(a.pursuit.response.sightedBy.size === 0 && b.pursuit.response.sightedBy.size === 0,
      `unseen control became visible at tick ${i + 1}`);
    assert.deepEqual(platoonTrace(a), platoonTrace(b), `police followed hidden ego at tick ${i + 1}`);
    assert.deepEqual(a.pursuit.response.lastSeen, b.pursuit.response.lastSeen);
    for (const timer of ["nextSquadTick", "nextDispatchTick", "nextRoadblockTick"])
      assert.equal(a.pursuit.gta[timer], b.pursuit.gta[timer]);
    assert.equal(a.pursuit.closures.size, b.pursuit.closures.size);
  }
  assert.ok(distance(a.player, b.player) > 30, "the two hidden actions must diverge");
  return { hiddenTicks: a.tick, divergenceM: distance(a.player, b.player), patrol: platoonTrace(a).map(({ id, x, z }) => ({ id, x, z })) };
}

function escapeWithPursuit() {
  const w = newMetro();
  const ego = pose(w.player, -245, DEFAULT_LOCAL_Z, TOWARD_X, 15);
  start(w, { wantedLevelMax: 1, surveillanceZones: [zone("western-district", -268, -218, -122, -60)],
    episodeMaxSeconds: 18 });
  const [car] = w.pursuit.patrols;
  pose(car, -252, -72.5, TOWARD_X, 9);
  assert.ok(bodyOnRoad(car, w.drivingRoads) && bodyOnRoad(ego, w.drivingRoads));
  updatePursuitResponse(w, true);
  drive(w);
  const trajectory = [];
  let braking = false;
  for (let i = 0; i < 1080 && w.pursuit.phase === "running"; i++) {
    if (!braking && ego.x >= -137) {
      drive(w, BRAKE);
      braking = true;
    }
    w.step();
    if (i % 60 === 0 || w.pursuit.phase !== "running")
      trajectory.push({ tick: w.tick, x: ego.x, z: ego.z, patrolX: car.x, patrolZ: car.z,
        patrolMps: car.speed, state: w.pursuit.response.dispatch.state, patrolState: car.aiState });
  }
  const { phase, metrics } = w.pursuit;
  assert.equal(phase, "escaped", JSON.stringify(trajectory));
  assert.ok(metrics.distanceM >= 45 && metrics.collisions === 0);
  assert.ok(trajectory.some(row => row.state === "ZONE_TRACKED" &&
    Math.abs(row.patrolMps) >= 3 && row.patrolX !== -252));
  return { phase, distanceM: metrics.distanceM, collisions: metrics.collisions, trajectory };
}

function sensing() {
  const w = newMetro();
  pose(w.player, -225);
  start(w);
  const [patrol] = w.pursuit.patrols;
  pose(patrol, -244, DEFAULT_LOCAL_Z, TOWARD_X, 9);
  const front = addSolid(w, "scan-front", gtaOffset(w.player, 7), 3.5);
  addSolid(w, "scan-right", gtaOffset(w.player, 0, 5), .7, 1.2);
  addSolid(w, "scan-diagonal", gtaOffset(w.player, 4, -4), 1.1, 1.1);
  // This civilian is behind the wide screen but is still a real world actor.
  const civilian = w.makeVehicle("scan-hidden-vehicle", "sedan", gtaOffset(w.player, 18));
  pose(civilian, w.player.x + 18);
  w.actors.push(civilian);
  const frame = sampleFixture(w);
  assert.equal(frame.rays.length, 72);
  const rays = [0, 36, 18, 63].map(i => frame.rays[i]);
  assert.deepEqual(rays.map(r => r.kind), ["static", "police", "static", "static"]);
  assert.ok(rays[0].rangeM < 7 && rays[0].rangeM > 6, "range must be to the obstacle surface");
  const rear = f => f.tracks.find(track => track.kind === "police" && track.forwardM < 0);
  assert.equal(rear(frame).ttcS, null);
  const before = getDispatchObservation(w);
  assert.equal(before.length, schema.length);
  assert.notEqual(before.length, GtaPursuitEnv.observationSchema.length);
  pose(civilian, w.player.x + 28);
  civilian.gtaAI = { target: "hidden" };
  updatePursuitResponse(w, true);
  sampleFixture(w);
  assert.deepEqual(getDispatchObservation(w), before, "hidden body changes cannot reach learner vector");
  w.pursuit.gta.scan = null;
  assert.throws(() => getDispatchObservation(w), /sampled dispatch/);
  // Rebuild actor references for the following actual accepted motion.
  w.actors.splice(w.actors.indexOf(civilian), 1);
  updatePursuitResponse(w, true);
  sampleFixture(w);
  drive(w, BRAKE);
  ticks(w, 6);
  const closing = rear(w.pursuit.gta.scan);
  assert.ok(closing.motionKnown && closing.forwardMps >= 7 && Number.isFinite(closing.ttcS),
    JSON.stringify(closing));
  assert.ok(closing.ttcS > .5 && closing.ttcS < 3, JSON.stringify(closing));
  assert.notDeepEqual(getDispatchObservation(w), before);
  ticks(w, 5);
  assert.equal(w.tick - w.pursuit.gta.scan.tick, 5);
  assert.equal(getDispatchObservation(w)[schema.ego.fields.indexOf("frameAge")], Math.fround(5 / 6));
  addSolid(w, "scan-rear-screen", gtaOffset(w.player, -4), 6.5);
  ticks(w, 1);
  const stale = rear(w.pursuit.gta.scan);
  assert.ok(stale && stale.ageS > 0 && !stale.motionKnown && stale.ttcS === null, JSON.stringify(stale));
  ticks(w, 36);
  assert.equal(rear(w.pursuit.gta.scan), undefined);
  assert.ok(w.statics.includes(front));
  return { hiddenInvariant: true, rays, closing, stale, length: schema.length };
}

function sharedReplay() {
  const w = newMetro({ traffic: 36, pedestrians: 80 });
  const actors = w.actors.slice(), statics = w.statics;
  start(w, { wantedLevelStart: 5 }, true);
  drive(w, DRIVE, true);
  ticks(w, 37);
  const restored = World.fromReplay(w.replay());
  assert.deepEqual(restored.snapshot(), w.snapshot());
  assert.deepEqual(getDispatchObservation(restored), getDispatchObservation(w));
  w.command({ type: "street-pursuit-stop" });
  assert.equal(w.statics, statics);
  assert.equal(w.actors.length, actors.length);
  assert.ok(w.actors.every((actor, i) => actor === actors[i]));
  return { tick: w.tick, ambient: actors.length, replay: true };
}

function brakeShield() {
  function run(gear, enabled) {
    const w = newMetro();
    const reverse = gear < 0;
    pose(w.player, -219, DEFAULT_LOCAL_Z, TOWARD_X, reverse ? -2.35 : 10);
    start(w, { maxActivePatrols: 0 });
    const wall = addSolid(w, "brake-fixture-wall", gtaOffset(w.player, gear * (reverse ? 3.7 : 12)));
    sampleFixture(w);
    const expected = { ...DRIVE, gear };
    let interventions = 0;
    for (let i = 0; i < 90; i++) {
      if (i % 6 === 0) {
        const result = enabled ? guardDispatchAction(w, expected) : { action: expected, reason: null };
        interventions += Number(Boolean(result.reason));
        drive(w, result.action);
      }
      w.step();
    }
    assert.ok(w.statics.includes(wall), "a brake intervention must not remove the obstructing body");
    return { contacts: w.pursuit.metrics.collisions, distanceM: w.pursuit.metrics.distanceM, interventions,
      remainingM: distance(w.player, wall), speedMps: w.player.speed };
  }
  const front = run(1, true), frontWithout = run(1, false), rear = run(-1, true), rearWithout = run(-1, false);
  for (const [guarded, baseline] of [[front, frontWithout], [rear, rearWithout]]) {
    assert.ok(guarded.contacts === 0 && guarded.distanceM > 0 && guarded.interventions > 0, JSON.stringify(guarded));
    assert.ok(baseline.contacts > 0 && baseline.interventions === 0, JSON.stringify(baseline));
  }
  const clear = newMetro();
  start(clear, { maxActivePatrols: 0 });
  assert.deepEqual(guardDispatchAction(clear, DRIVE), { action: DRIVE, reason: null });
  clear.pursuit.gta.scan = null;
  assert.throws(() => guardDispatchAction(clear, DRIVE), /current scan/);
  return { front, frontWithout, rear, rearWithout, clearStreetUnchanged: true };
}

function observationFaults() {
  const setup = () => {
    const w = newMetro();
    start(w, { maxActivePatrols: 0 });
    const driver = { status: "active", lastTick: -1, decisions: 0, policy: { action: () => DRIVE } };
    return { w, driver };
  };
  const { w, driver } = setup();
  const heldScan = w.pursuit.gta.scan;
  w.pursuit.gta.scanner = { sample: () => heldScan };
  for (let i = 0; i < 7; i++) {
    applyFrozenDispatchAction(w, driver);
    w.step();
  }
  assert.equal(driver.status, "fault");
  assert.equal(driver.decisions, 1);
  assert.match(driver.error, /current scan/);
  assert.equal(w.pursuit.manualAction.brake, 1);
  assert.ok(w.player.speed < .24, "prior throttle cannot remain active on a stale scan");
  const malformed = setup();
  malformed.w.pursuit.gta.scan = Object.freeze({ tick: 0, rays: Object.freeze([]), tracks: Object.freeze([]) });
  assert.ok(applyFrozenDispatchAction(malformed.w, malformed.driver));
  assert.match(malformed.driver.error, /Malformed pursuit scan/);
  assert.equal(malformed.driver.decisions, 0);
  assert.equal(malformed.w.pursuit.manualAction.brake, 1);
  return { staleFaultTick: 6, malformedRejected: true };
}

function hiddenScoring() {
  const w = newMetro();
  start(w, { wantedLevelStart: 3, surveillanceZones: [zone("initial", -260, -230)] });
  pose(w.player, -165);
  const [chaser] = w.pursuit.patrols;
  const { response, gta } = w.pursuit;
  addSolid(w, "hidden-under-score", { x: -174, z: DEFAULT_LOCAL_Z }, 12);
  // Stage a separated, previously mobile pursuit ready to fade one star.
  // The actual scoring function, not the fixture, computes the wanted value.
  w.tick = 420;
  response.dispatch.escapeEligible = true;
  response.clearAtTick = 0;
  gta.fadeStars = 3;
  pose(chaser, w.player.x - 29);
  updateDispatchEscape(w, false);
  assert.equal(w.pursuit.wantedLevel, 2);
  const before = getDispatchObservationAfterFixture(w);
  pose(chaser, w.player.x - 27);
  updateDispatchEscape(w, false);
  assert.equal(w.pursuit.wantedLevel, 3);
  assert.deepEqual(getDispatchObservationAfterFixture(w), before, "hidden scoring must not affect policy input");
  return { wantedChanged: [2, 3], hiddenScoringInvariant: true };
}

function getDispatchObservationAfterFixture(world) {
  sampleFixture(world);
  return getDispatchObservation(world);
}

const result = legacyControl ? { idle: idle("legacy"), speed: measuredSpeed("legacy") } : {
  speed: measuredSpeed(DISPATCH), sensing: sensing(), dispatch: {
    streetCoverage: coverage(), transitions: reportTransitions(), hidden: hiddenDispatchTwins(),
    physicalReacquisition: physicalReacquisition(),
    idle: idle(DISPATCH), crippled: idle(DISPATCH, true), legitimate: escapeWithPursuit(),
  },
  replay: sharedReplay(), brakeShield: brakeShield(), controller: observationFaults(), scoring: hiddenScoring(),
};
const out = process.env.PROVE_IT_OUTPUT_DIR;
if (out) await writeFile(join(out, legacyControl ? "legacy-control.json" : "foundation.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
