import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { bodyOnRoad, overlaps } from "../src/core/geometry.js";
import { gtaLocal } from "../src/core/pursuit-gta.js";
import { GtaPursuitEnv } from "../src/rl/gta-pursuit-env.js";

const seed = "metro-approaches-production-fixture";
const drive = { steer: 0, throttle: 1, brake: 0, gear: 1 };
const config = { ruleset: "dispatch-v1", wantedLevelStart: 1, wantedLevelMax: 1,
  enableRoadblocks: false, enablePitManeuver: false, enableRamming: false, episodeMaxSeconds: 2.4 };
const ticks = 144;
const digest = bytes => createHash("sha256").update(bytes).digest("hex");

function run(scenario, maxActivePatrols, shield = true) {
  const env = new GtaPursuitEnv();
  const start = env.reset({ seed, scenario, traffic: 0, pedestrians: 0, shield, config: { ...config, maxActivePatrols } });
  const { world } = env, { pursuit, player } = world, patrols = [...pursuit.patrols];
  assert.equal(world.environment, "metro");
  assert.equal(start.info.scenario.id, scenario);
  assert.equal(patrols.length, maxActivePatrols);
  const road = world.drivingRoads.find(road => road.id === start.info.scenario.roadId);
  const motion = () => ({
    ego: [player.x, player.z, player.heading, player.speed],
    patrols: patrols.map(car => ({ id: car.id, x: car.x, z: car.z, heading: car.heading, speed: car.speed,
      forward: gtaLocal(player, car).forward, distanceM: car.distance, state: car.aiState })),
  });
  const initial = motion(), trace = [], sightings = [], incidents = [];
  assert.ok(patrols.every((car, i) => bodyOnRoad(car, [road]) && !overlaps(car, player, .15) &&
    patrols.slice(0, i).every(other => !overlaps(car, other, .15))));
  let qualifiedAt = null, firstBrake = null, streak = 0, consecutive = 0, last;
  let previous = initial;
  while (world.tick < ticks && pursuit.phase === "running") {
    const { tick } = world, next = env.step(drive, 1), current = motion();
    assert.equal(world.tick, tick + 1);
    assert.ok(world.actors.includes(player) && bodyOnRoad(player, world.roads));
    assert.ok(patrols.every(car => bodyOnRoad(car, world.roads) &&
      world.actors.includes(car) === (pursuit.phase === "running")));
    assert.ok(next.obs.every(Number.isFinite));
    if (next.info.shield?.reason === "police" && current.ego[3] < previous.ego[3])
      firstBrake ??= { decisionTick: tick, acceptedTick: world.tick, beforeMps: previous.ego[3], afterMps: current.ego[3] };
    const [rear, front] = current.patrols, [oldRear, oldFront] = previous.patrols;
    if (rear?.forward < -4 && front?.forward > 4 &&
        rear.forward > oldRear.forward && front.forward < oldFront.forward &&
        rear.x > oldRear.x && front.x < oldFront.x) streak = Math.max(streak, ++consecutive);
    else consecutive = 0;
    if (world.tick % 6 === 0) sightings.push({ tick: world.tick, tracks: pursuit.gta.scan.tracks.filter(track =>
      track.kind === "police" && track.ageS === 0).map(track =>
      [track.forwardM, track.rightM, track.motionKnown, track.forwardMps, track.ttcS]) });
    if (pursuit.response.dispatch.escapeEligible) qualifiedAt ??= world.tick;
    incidents.push(...next.info.events.filter(event =>
      ["patrol_collision", "static_or_civilian_hit", "ambient_collision", "near_miss"].includes(event.type)));
    trace.push({ tick: world.tick, ...current, requested: next.info.requestedAction, applied: next.info.appliedCommand,
      guard: next.info.shield?.reason ?? null });
    previous = current;
    last = next;
  }
  return { scenario, shield, initial, trace, sightings, incidents, streak, qualifiedAt, firstBrake,
    initialScanSha256: digest(Buffer.from(start.obs.buffer)), qualified: pursuit.response.dispatch.escapeEligible,
    phase: pursuit.phase, ticks: world.tick, distanceM: pursuit.metrics.distanceM,
    truncated: last?.truncated, collisions: pursuit.metrics.collisions,
    ambientContacts: pursuit.metrics.trafficCollisions };
}

const rear = run("L01", 1), noPatrol = run("L01-control", 0);
const opposing = run("L03", 2), sameSide = run("L03-control", 2), unguarded = run("L03", 2, false);
const repeated = run("L03", 2);
const report = { purpose: "Scripted physical Lab checks, not learned or holdout acceptance", seed, runtime: process.version,
  rear, noPatrol, opposing, sameSide, unguarded, resetExact: true };
assert.deepEqual(opposing, repeated);
const output = process.env.PROVE_IT_OUTPUT_DIR;
if (output) await writeFile(join(output, "lab-approaches.json"), JSON.stringify(report), { flag: "wx" });

assert.deepEqual(rear.initial.ego, noPatrol.initial.ego);
assert.deepEqual(rear.trace.map(row => row.ego), noPatrol.trace.map(row => row.ego));
assert.ok([rear, noPatrol].every(row => row.ticks === ticks && row.phase === "timeout" && row.truncated &&
  row.collisions === 0 && row.ambientContacts === 0));
const lastTail = rear.trace.at(-1).patrols[0];
assert.ok(lastTail.distanceM > 18 && lastTail.forward - rear.initial.patrols[0].forward > 8);
assert.ok(rear.qualified && !noPatrol.qualified && noPatrol.sightings.every(row => row.tracks.length === 0));
const rearClosing = ([forward, , known, rate, ttc]) => forward < -4 && known && rate > 1 && ttc > 0;
const frontClosing = ([forward, , known, rate, ttc]) => forward > 4 && known && rate < -1 && ttc > 0;
assert.ok(rear.sightings.some(row => row.tracks.some(rearClosing)));
assert.deepEqual(opposing.initial, unguarded.initial);
assert.deepEqual(opposing.initial.ego, sameSide.initial.ego);
assert.deepEqual(opposing.initial.patrols[0], sameSide.initial.patrols[0]);
assert.ok(opposing.streak >= 45 && opposing.trace.at(-1).patrols.every(car => car.distanceM > 8));
assert.ok(opposing.sightings.some(row => row.tracks.some(rearClosing) && row.tracks.some(frontClosing)));
assert.equal(sameSide.streak, 0);
assert.ok(sameSide.trace.at(-1).patrols.every(car => car.distanceM > 8 && car.forward < 0));
assert.ok(sameSide.sightings.every(row => row.tracks.every(track => track[0] < 0)));
const rearProbe = opposing.trace.find(row => row.tick === 84);
assert.ok(rearProbe.patrols[0].x > opposing.initial.patrols[0].x + 8 &&
  rearProbe.patrols[1].x < opposing.initial.patrols[1].x - 8);
assert.ok(opposing.firstBrake && unguarded.firstBrake === null);
assert.ok(opposing.collisions === 0 && opposing.ambientContacts === 0);
assert.ok([opposing, sameSide, unguarded].every(row => row.ticks === ticks && row.phase === "timeout" && row.truncated));
assert.ok(unguarded.incidents.some(event => event.type === "patrol_collision" && event.fresh && event.closingSpeed > 1));

const incompatible = (scenario, changes) =>
  new GtaPursuitEnv().reset({ seed, scenario, traffic: 0, pedestrians: 0, config: { ...config, ...changes } });
assert.throws(() => incompatible("L03", { maxActivePatrols: 1 }), /fixture requires 2 patrols/);
assert.throws(() => incompatible("L01-control", { maxActivePatrols: 1 }), /fixture requires 0 patrols/);
assert.throws(() => incompatible("L03", { ruleset: "legacy", maxActivePatrols: 2 }), /compatible pursuit settings/);
console.log(JSON.stringify([rear, noPatrol, opposing, sameSide, unguarded].map(row =>
  ({ scenario: row.scenario, shield: row.shield, phase: row.phase, ticks: row.ticks, qualifiedAt: row.qualifiedAt,
    distanceM: row.distanceM, firstBrake: row.firstBrake, streak: row.streak, collisions: row.collisions }))));
