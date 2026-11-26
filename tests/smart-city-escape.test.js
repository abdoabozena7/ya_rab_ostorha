import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { STEP } from "../src/core/config.js";
import { distance, overlaps, roadProject } from "../src/core/geometry.js";
import { World } from "../src/core/world.js";
import { spawnCrowdAhead } from "../src/core/pursuit-world.js";
import { updatePursuitResponse } from "../src/core/pursuit-response.js";
import { refreshTacticalPatrolSpecs } from "../src/core/pursuit-gta.js";
import { PursuitScanner } from "../src/signal_processing/pursuit-scanner.js";
import { planSmartEscapeAction, selectSensorEscapeGoal } from "../src/rl/pako-smart-escape.js";
import { runSmartEscapeTrial } from "../src/rl/smart-escape-trials.js";
import { smartEscapeCurriculum, SMART_ESCAPE_SCENARIOS } from "../src/rl/smart-escape-curriculum.js";
import { pursuitStageVariants } from "../src/rl/pursuit-rollouts.js";
import { freezePursuitPolicy } from "../src/rl/pursuit-ppo.js";

const config = { ruleset: "dispatch-v1", tacticalPursuit: "gta-tactical-v1",
  policeFairness: "city-fair-v1", surveillanceZones: [], maxActivePatrols: 4 };
const forward = { steer: 0, throttle: .8, brake: 0, gear: 1 };
const city = seed => new World({ seed, cityVersion: 5, traffic: 0, pedestrians: 0 }, "metro");
function chase(world, options = {}) {
  world.command({ type: "street-pursuit-start", variant: "gta", level: 1,
    config: { ...config, ...options } }, false);
}

test("smart shield brakes before crossing/static impacts, retaining the crowd and meaningful progress on two seeds", () => {
  let oldContacts = 0, newContacts = 0;
  for (const seed of ["smart-a", "smart-b"]) for (const scenario of SMART_ESCAPE_SCENARIOS) {
    const baseline = runSmartEscapeTrial({ seed, scenario, controller: "pako-evasive-v2" });
    const smart = runSmartEscapeTrial({ seed, scenario });
    oldContacts += baseline.contacts;
    newContacts += smart.contacts;
    assert.equal(smart.contacts, 0, `${seed}/${scenario}: ${JSON.stringify(smart.contactEvents)}`);
    assert.equal(smart.originalActorsRetained, true);
    assert.equal(smart.pedestrianNitroViolations, 0);
    assert.ok(smart.distanceM > (scenario === "smart-gap-crowd" ? 20 : 50));
    assert.ok(smart.displacementM > 15);
    assert.ok(smart.decisions.some(d => d.conflict?.seconds >= .5 && d.action.brake > 0),
      "brake is actually submitted before imminent-contact range");
    assert.equal(smart.destinationCount, 1, "escape destination does not churn at scan rate");
    console.log(JSON.stringify({ seed, scenario, baselineContacts: baseline.contacts,
      smartContacts: smart.contacts, baselineDistanceM: baseline.distanceM,
      smartDistanceM: smart.distanceM, ticks: smart.ticks }));
  }
  assert.ok(oldContacts >= 4, "old controller is a collision-positive negative control");
  assert.ok(newContacts < oldContacts);
});

test("destination and controller cannot read hidden actors, dispatch reports or police truth", () => {
  const world = city("sensor-goal");
  chase(world, { maxActivePatrols: 0 });
  const scan = new PursuitScanner().sample(world);
  world.pursuit.gta.scan = scan;
  const deny = new Proxy({}, { get() { throw new Error("privileged police truth"); } });
  const pursuit = new Proxy(world.pursuit, { get(target, prop) {
    if (["response", "patrols", "playerStart"].includes(prop)) return deny;
    return target[prop];
  } });
  const audited = new Proxy(world, { get(target, prop) {
    if (["actors", "actorIndex", "rng"].includes(prop)) throw new Error(`privileged ${String(prop)}`);
    return prop === "pursuit" ? pursuit : target[prop];
  } });
  const threatScan = { ...scan, tracks: [{ kind: "police", ageS: 0, rightM: 0, forwardM: -20 }] };
  const goal = selectSensorEscapeGoal(audited, threatScan);
  assert.ok(goal && goal.x > world.player.x + 80, "observed rear threat produces a reachable forward road destination");
  const first = planSmartEscapeAction(audited, forward);
  const again = planSmartEscapeAction(audited, forward);
  assert.equal(again.escapeDestination, first.escapeDestination);
  assert.ok(first.escapeDestination.routeLengthM > 80);
});

test("the actual shipped PPO remains contact-free through gap, crossing and static drills", () => {
  const policy = freezePursuitPolicy(JSON.parse(readFileSync(
    new URL("../public/threejs/pako-chase-ppo.json", import.meta.url), "utf8")));
  for (const scenario of SMART_ESCAPE_SCENARIOS) {
    const result = runSmartEscapeTrial({ seed: "smart-a", scenario, policy });
    assert.equal(result.actionSource, "frozen-ppo");
    assert.equal(result.contacts, 0, scenario);
    assert.ok(result.distanceM > 20, scenario);
    assert.equal(result.originalActorsRetained, true);
    assert.equal(result.pedestrianNitroViolations, 0);
  }
});

test("smart route tracking completes a legally qualified, contact-free escape in the populated City", () => {
  const result = runSmartEscapeTrial({ seed: "smart-city-a", seconds: 120,
    traffic: 48, pedestrians: 100, patrols: 14 });
  const final = result.pursuitSamples.at(-1);
  assert.equal(result.phase, "escaped");
  assert.equal(result.qualifiedEscape, true);
  assert.equal(final.dispatch.everSpotted, true);
  assert.equal(final.dispatch.state, "ESCAPED");
  assert.equal(final.unitsInContact, 0);
  assert.ok(final.nearestPatrolM >= final.dispatch.minEscapeDistanceM);
  assert.ok(Math.hypot(final.x - final.lastReportX, final.z - final.lastReportZ) >= 48);
  assert.ok(result.distanceM > 350, "tracking advances along the road instead of surviving while stopped");
  assert.equal(result.contacts, 0);
  assert.equal(result.originalActorsRetained, true);
  assert.ok(result.nitroDecisions > 0);
  assert.equal(result.pedestrianNitroViolations, 0);
});

test("fair police acquire by actual FOV/LOS and keep fixed identities and capped physical speed", () => {
  const world = city("fair-beats");
  chase(world);
  const units = [...world.pursuit.patrols], ids = units.map(p => p.id);
  const unit = units[0];
  const openingReport = world.pursuit.response.lastSeen;
  Object.assign(unit, { x: world.player.x + 10, z: world.player.z, heading: Math.PI / 2, speed: 0 });
  updatePursuitResponse(world, true);
  assert.equal(world.pursuit.response.unitsInContact, 0, "nearby SUV behind the patrol is not visual acquisition");
  assert.equal(world.pursuit.response.lastSeen, openingReport);
  unit.heading = -Math.PI / 2;
  updatePursuitResponse(world);
  assert.equal(world.pursuit.response.unitsInContact, 1);
  const report = world.pursuit.response.lastSeen;
  unit.heading = Math.PI / 2;
  world.player.x -= 2;
  updatePursuitResponse(world);
  assert.equal(world.pursuit.response.unitsInContact, 0);
  assert.equal(world.pursuit.response.lastSeen, report, "radio search keeps last observed report, not hidden current position");
  for (const level of [1, 2, 3, 4, 5]) {
    world.pursuit.wantedLevel = level;
    world.pursuit.gta.config = { ...world.pursuit.gta.config, npcSpeedMultiplier: 2 };
    refreshTacticalPatrolSpecs(world.pursuit);
    assert.ok(units.every(p => p.maxSpeed <= world.player.maxSpeed));
  }
  for (let tick = 0; tick < 180 && world.pursuit.phase === "running"; tick++) {
    const positions = units.map(p => ({ x: p.x, z: p.z }));
    world.command({ type: "pursuit-drive", action: forward }, false);
    world.step();
    assert.deepEqual([...world.pursuit.patrols].map(p => p.id), ids, "no ahead-of-player replacement");
    units.forEach((p, i) => assert.ok(distance(p, positions[i]) <= 32 * STEP + .03));
  }
  assert.ok(units.every(p => p.gtaAI.beat?.roadId));
});

test("dispersed +20 is additive, spans cohorts with a real centre gap and atomically rejects an impossible road", () => {
  const world = city("cohort-gaps");
  chase(world, { maxActivePatrols: 0 });
  const ambient = [...world.actors], first = spawnCrowdAhead(world, 20);
  assert.equal(first.spawned, 20);
  assert.equal(world.actors.length, ambient.length + 20);
  assert.ok(first.farthestForwardM - first.nearestForwardM >= 55);
  const road = world.drivingRoads.find(r => r.id === "tahrir-boulevard");
  const people = first.ids.map(id => world.actors.find(a => a.id === id));
  assert.ok(people.every(p => Math.abs(roadProject(road, p).leftOffset) >= 2.35));
  assert.ok(people.some(p => roadProject(road, p).leftOffset > 0));
  assert.ok(people.some(p => roadProject(road, p).leftOffset < 0));
  assert.ok(people.every((p, i) => people.slice(i + 1).every(q => !overlaps(p, q))));
  const second = spawnCrowdAhead(world, 20);
  assert.equal(second.spawned, 20);
  assert.equal(world.actors.length, ambient.length + 40);
  assert.ok(ambient.concat(people).every(a => world.actors.includes(a)));
  world.player.x = world.player.z = 9999;
  const before = [...world.actors], blocked = spawnCrowdAhead(world, 20);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.spawned, 0);
  assert.deepEqual(world.actors, before);
});

test("a fair patrol brakes behind a stopped visible SUV and never awards an unspotted victory", () => {
  const world = city("fair-stopped-lead");
  chase(world, { maxActivePatrols: 1 });
  const unit = [...world.pursuit.patrols][0], start = { x: unit.x, z: unit.z };
  for (let tick = 0; tick < 480; tick++) {
    world.command({ type: "pursuit-drive", action: { ...forward, throttle: 0, brake: 1 } }, false);
    world.step();
  }
  assert.ok(distance(start, unit) > 20, "patrol actually approaches instead of being disabled");
  assert.equal(world.pursuit.metrics.collisions, 0, "observed stationary lead is not rear-ended");
  assert.ok(distance(unit, world.player) >= 6);
  const hidden = city("unspotted-no-victory");
  chase(hidden, { maxActivePatrols: 0 });
  for (let tick = 0; tick < 480; tick++) hidden.step();
  assert.equal(hidden.pursuit.response.lastSeen, null);
  assert.equal(hidden.pursuit.response.dispatch.escapeEligible, false);
  assert.equal(hidden.pursuit.phase, "running");
});

test("dispersed crowd follows the actual avenue when the SUV yaws across its lane", () => {
  const world = new World({ cityVersion: 5, traffic: 68, pedestrians: 190 }, "metro");
  Object.assign(world.player, { x: -238.11926297164453, z: -111.1226847980722,
    heading: 1.948113263398728 });
  const original = [...world.actors];
  const result = spawnCrowdAhead(world, 20, { layout: "dispersed-cohorts-v1" });
  assert.equal(result.ok, true);
  assert.equal(result.spawned, 20);
  assert.equal(world.actors.length, original.length + 20);
  assert.ok(original.every(a => world.actors.includes(a)));
  assert.ok(result.farthestForwardM - result.nearestForwardM >= 55);
  const road = world.drivingRoads.find(r => r.id === "tahrir-boulevard");
  for (const id of result.ids) {
    const person = world.actors.find(a => a.id === id);
    assert.ok(person.x > world.player.x);
    assert.ok(Math.abs(roadProject(road, person).leftOffset) >= 2.35);
    assert.ok(!world.statics.some(s => overlaps(person, s, .18)));
    assert.ok(!world.actors.some(a => a !== person && overlaps(person, a, .18)));
  }
});

test("current Chase curriculum schedules gap, crossing and static scenarios without relabelling a learned policy", () => {
  const base = { description: "Chase", stages: [{ id: "chase-level-1", patrols: 0 }] };
  const upgraded = smartEscapeCurriculum(base);
  assert.deepEqual(pursuitStageVariants(upgraded.stages[0]).map(s => s.scenario), SMART_ESCAPE_SCENARIOS);
  assert.equal(base.stages[0].evasiveControl, undefined, "old saved curriculum is not mutated");
  assert.equal(upgraded.stages[0].evasiveControl, "pako-smart-escape-v3");
});
