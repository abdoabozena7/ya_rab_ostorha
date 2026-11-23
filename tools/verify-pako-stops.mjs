import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { STEP } from "../src/core/config.js";
import { districtRoadPose } from "../src/core/egypt-district.js";
import { bodyOnRoad, overlaps } from "../src/core/geometry.js";
import { PURSUIT_STOP } from "../src/core/pursuit-controls.js";
import { SpatialIndex } from "../src/core/spatial-index.js";
import { GtaPursuitEnv } from "../src/rl/gta-pursuit-env.js";
import { applyFrozenDispatchAction } from "../src/rl/pursuit-controller.js";
import { PursuitDecisionTrace, finishPursuitDecision, observePursuitDecision,
  startPursuitDecision } from "../src/rl/pursuit-diagnostics.js";
import { PursuitScanner } from "../src/signal_processing/pursuit-scanner.js";

const go = { ...PURSUIT_STOP, brake: 0, throttle: 0.8 };
const config = { ruleset: "dispatch-v1", wantedLevelStart: 1, wantedLevelMax: 1,
  maxActivePatrols: 0, episodeMaxSeconds: 4, enableRoadblocks: false };
const rows = [];
const checkDiagnostics = process.argv.includes("--diagnostics");

function fresh(name, options = {}) {
  const env = new GtaPursuitEnv();
  env.reset({ seed: `pako-diagnostic-${name}`, traffic: 0, pedestrians: 0, shield: true, ...options,
    decisionTrace: new PursuitDecisionTrace(name, "local-stops-probe"),
    config: { ...config, ...options.config } });
  return env;
}

function episode(name, env, action, decisions = 40) {
  const { world } = env, { player, pursuit } = world;
  for (let i = 0; i < decisions && pursuit.phase === "running"; i++) {
    const step = env.step(action, 6, { source: "policy", policyId: "controlled-action" });
    rows.push({ name, tick: world.tick, seconds: world.tick * STEP, phase: pursuit.phase,
      terminated: step.terminated, truncated: step.truncated, requested: step.info.requestedAction,
      applied: step.info.appliedCommand, shield: step.info.shield, guard: pursuit.metrics.guard,
      contacts: step.info.events.filter(event => event.type.includes("collision") || event.type.includes("hit")),
      reward: step.info.rewardComponents, activePatrols: step.info.activePatrols, pressure: pursuit.metrics.capturePressureS,
      x: player.x, z: player.z, heading: player.heading, speedMps: player.speed, travelM: pursuit.metrics.distanceM,
      rearTtcS: pursuit.gta.scan?.tracks.find(track => track.kind === "police" &&
        track.forwardM < 0 && track.motionKnown && !track.ageS)?.ttcS ?? null,
      stopReason: step.info.decision?.stopReason ?? null, decision: step.info.decision ?? null });
  }
  return rows.at(-1);
}

const rear = episode("rear-open", fresh("tail", { scenario: "L01", config: { maxActivePatrols: 1 } }), go, 14);
assert.ok(rear.activePatrols && rear.travelM > 8);
assert.ok(rows.some(row => row.name === "rear-open" && Number.isFinite(row.rearTtcS)));
const timeout = episode("timeout", fresh("timeout", { config: { episodeMaxSeconds: 0.3 } }), PURSUIT_STOP);
assert.equal(timeout.tick, 18);
assert.equal(timeout.phase, "timeout");
assert.equal(timeout.truncated, true);
assert.ok(!timeout.terminated);

const pinnedEnv = fresh("pin", { config: { wantedLevelStart: 2, wantedLevelMax: 2, maxActivePatrols: 2,
  npcSpeedMultiplier: 0.015, enableRamming: false, enablePitManeuver: false } });
const pinWorld = pinnedEnv.world, pinRun = pinWorld.pursuit;
const pinRoad = pinWorld.drivingRoads.find(road => road.id === "university-avenue");
const pinPose = districtRoadPose(pinRoad, -132, -1);
Object.assign(pinWorld.player, pinPose);
assert.equal(pinRun.patrols.size, 2);
for (const [index, patrol] of [...pinRun.patrols].entries()) {
  const sign = index * 2 - 1;
  const distance = sign * 6.6;
  Object.assign(patrol, { x: pinPose.x + Math.sin(pinPose.heading) * distance,
    z: pinPose.z + Math.cos(pinPose.heading) * distance, heading: pinPose.heading + (sign > 0 ? Math.PI : 0),
    speed: 0 });
  assert.ok(bodyOnRoad(patrol, pinWorld.drivingRoads));
  assert.ok(!pinWorld.statics.some(solid => overlaps(patrol, solid, .15)));
  assert.ok(!overlaps(pinWorld.player, patrol, .15));
}
pinWorld.actorIndex = new SpatialIndex(pinWorld.actors);
pinRun.gta.scanner = new PursuitScanner();
pinRun.gta.scan = pinRun.gta.scanner.sample(pinWorld);
const pin = episode("police-pin", pinnedEnv, PURSUIT_STOP);
assert.equal(pin.tick, 132);
assert.equal(pin.phase, "busted");
assert.equal(pin.terminated, true);
assert.ok(rows.some(row => row.name === "police-pin" && row.activePatrols === 2 && row.pressure > 2));

function frontBarrier(name, health, shield) {
  const env = fresh(name, { shield, config: { playerMaxHealth: health } });
  const { world } = env, { player, pursuit } = world;
  const road = world.drivingRoads.find(row => row.id === "university-avenue");
  Object.assign(player, districtRoadPose(road, -132, -1), { speed: 8 });
  const block = { id: "diagnostic-front-solid", type: "obstacle", kind: "barrier", length: 1, width: 3,
    heading: player.heading, x: player.x + Math.sin(player.heading) * 7, z: player.z + Math.cos(player.heading) * 7 };
  assert.ok(bodyOnRoad(player, world.drivingRoads) && bodyOnRoad(block, world.drivingRoads));
  assert.ok(!world.statics.some(body => overlaps(body, player, .1) || overlaps(body, block, .1)));
  world.statics.push(block);
  world.staticIndex = new SpatialIndex(world.statics);
  pursuit.gta.scanner = new PursuitScanner();
  pursuit.gta.scan = pursuit.gta.scanner.sample(world);
  return env;
}
const shield = episode("front-shield", frontBarrier("shield", 100, true), go);
assert.ok(rows.some(row => row.name === "front-shield" && row.shield?.reason === "static"));
assert.equal(shield.contacts.length, 0);
assert.equal(shield.speedMps, 0);
const crash = episode("collision", frontBarrier("collision", 1, false), go);
assert.equal(crash.phase, "wrecked");
assert.equal(crash.terminated, true);
assert.ok(crash.contacts.some(event => event.actorId === "diagnostic-front-solid"));
const boundaryEnv = fresh("boundary");
const boundaryWorld = boundaryEnv.world;
assert.equal(pinRoad.axis, "x");
Object.assign(boundaryWorld.player, { x: -132, z: pinRoad.fixed + pinRoad.width / 2 - boundaryWorld.player.width / 2 - .34,
  heading: Math.PI / 2 - .10, speed: 3.2 });
assert.ok(bodyOnRoad(boundaryWorld.player, [pinRoad]));
assert.ok(!boundaryWorld.statics.some(solid => overlaps(boundaryWorld.player, solid, .12)));
boundaryWorld.pursuit.gta.scanner = new PursuitScanner();
boundaryWorld.pursuit.gta.scan = boundaryWorld.pursuit.gta.scanner.sample(boundaryWorld);
const edge = episode("road-boundary", boundaryEnv, { ...go, steer: -.6 }, 12);
assert.equal(edge.guard, "road-boundary");
assert.equal(edge.speedMps, 0);
assert.equal(edge.contacts.length, 0);
if (checkDiagnostics) {
  assert.equal(timeout.stopReason, "EPISODE_TIMEOUT");
  assert.equal(pin.stopReason, "POLICE_PIN");
  assert.equal(rows.find(row => row.name === "police-pin").stopReason, "POLICY_BRAKE");
  assert.equal(edge.stopReason, "ROAD_BOUNDARY");
  assert.ok(edge.decision.requestedAction.throttle > 0);
  assert.equal(edge.decision.appliedAction.brake, 1);
  assert.equal(crash.stopReason, "COLLISION_RESPONSE");
  const diverted = rows.find(row => row.name === "front-shield" && row.shield?.reason);
  assert.equal(diverted.stopReason, "SAFETY_INTERVENTION");
  assert.equal(diverted.decision.requestedAction.brake, 0);
  assert.equal(diverted.decision.appliedAction.brake, 1);
  assert.equal(diverted.decision.appliedCommand.targetSpeed, 0);
  assert.ok(diverted.decision.accelerationMps2 < 0);
  assert.notEqual(rear.stopReason, "SAFETY_INTERVENTION");
  const rearIds = rows.filter(row => row.name === "rear-open")
    .flatMap(row => row.decision.observation.threats.filter(track => track.kind === "police" && track.motionKnown)
      .map(track => track.trackId));
  assert.ok(rearIds.some((id, i) => id && rearIds[i + 1] === id));
  const creep = episode("accepted-creep", fresh("creep"), { ...go, throttle: .14 }, 1);
  assert.ok(creep.speedMps > 0 && creep.speedMps < .15 && creep.decision.acceptedDisplacementM > 0);
  assert.equal(creep.stopReason, null);
}

for (const name of ["inference", "stale", "malformed"]) {
  const { world } = fresh(name);
  const run = world.pursuit, driver = { status: "active", sha256: "controlled-fault", lastTick: -1, decisions: 0,
    policy: { observation: "dispatch-scan-v3", action() { throw new Error("Controlled inference failure"); } } };
  if (name === "stale") run.gta.scan = null;
  if (name === "malformed") run.gta.scan = { tick: world.tick, rays: [null] };
  const tick = world.tick;
  applyFrozenDispatchAction(world, driver);
  const context = startPursuitDecision(world, driver.lastDecision);
  world.step();
  observePursuitDecision(world, context);
  const decision = finishPursuitDecision(world, context);
  assert.equal(driver.status, "fault");
  assert.deepEqual(run.manualAction, PURSUIT_STOP);
  assert.equal(world.tick, tick + 1);
  assert.equal(run.phase, "running");
  if (checkDiagnostics) {
    assert.equal(decision.stopReason, name === "stale" ? "STALE_OBSERVATION" : "CONTROLLER_FAULT");
    assert.equal(decision.requestedAction, null);
    assert.equal(decision.appliedAction.brake, 1);
    assert.equal(decision.terminalCause, null);
  }
  rows.push({ name, tick: world.tick, seconds: world.tick * STEP, phase: run.phase, error: driver.error,
    driverStatus: driver.status, applied: run.appliedCommand, stopReason: decision.stopReason, decision });
}

const faultCases = rows.slice(-3).map(({ name, error, stopReason }) => ({ name, error, stopReason }));
const badScanCases = [];
for (const evasion of [false, true]) {
  const env = fresh(`malformed-env-${evasion}`, { evasion });
  const { world } = env;
  world.pursuit.gta.scan = { tick: 0, rays: [null] };
  assert.throws(() => env.step(go), /Malformed pursuit scan/);
  assert.equal(world.tick, 0);
  assert.deepEqual(world.pursuit.manualAction, PURSUIT_STOP);
  const { latest } = env.decisionTrace;
  assert.equal(latest.requestedAction.throttle, go.throttle);
  assert.equal(latest.submittedAction.brake, 1);
  assert.equal(latest.appliedAction, null);
  assert.equal(latest.stopReason, "CONTROLLER_FAULT");
  world.step();
  assert.equal(world.pursuit.metrics.distanceM, 0);
  badScanCases.push({ evasion, tickBeforeRejection: latest.tick, tickAfterRejection: latest.endTick,
    distanceAfterOnePlantTick: world.pursuit.metrics.distanceM, latched: world.pursuit.manualAction });
}
for (const mode of ["temporary", "persistent"]) {
  const { world } = fresh(`stale-${mode}`), run = world.pursuit;
  const driver = { status: "active", lastTick: -1, sha256: "controlled-recovery", decisions: 0,
    recoverStale: true, policy: { observation: "dispatch-scan-v3", action: () => go } };
  run.gta.scan = null;
  if (mode === "persistent") run.gta.scanner = null;
  applyFrozenDispatchAction(world, driver);
  assert.equal(driver.status, "waiting-for-scan");
  assert.equal(driver.lastDecision.fault.code, "STALE_OBSERVATION");
  assert.deepEqual(run.manualAction, PURSUIT_STOP);
  let resumedAt = null, faultedAt = null;
  while (world.tick < 30) {
    world.step();
    applyFrozenDispatchAction(world, driver);
    if (driver.status === "active") resumedAt ??= world.tick;
    if (driver.status === "fault") faultedAt ??= world.tick;
  }
  assert.equal(driver.status, mode === "temporary" ? "active" : "fault");
  if (mode === "temporary") {
    assert.equal(resumedAt, 6);
    assert.ok(driver.decisions > 1 && run.metrics.distanceM > .1);
  } else {
    assert.equal(faultedAt, 18);
    assert.deepEqual(run.manualAction, PURSUIT_STOP);
  }
  rows.push({ name: `stale-${mode}`, phase: run.phase, tick: world.tick, driverStatus: driver.status,
    distanceM: run.metrics.distanceM, decisions: driver.decisions, faultCode: driver.faultCode, resumedAt, faultedAt });
}

const output = process.env.PROVE_IT_OUTPUT_DIR;
if (output) writeFileSync(join(output, "stops.jsonl"), rows.map(row => JSON.stringify(row)).join("\n") + "\n");
console.log(JSON.stringify({ rearDistanceM: rear.travelM, timeoutTick: timeout.tick, collisionTick: crash.tick, pinTick: pin.tick,
  guardedStopM: shield.travelM, faultCases, badScanCases, scanRecovery: rows.slice(-2),
  decisions: rows.length }));
