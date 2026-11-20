import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { distance } from "../src/core/geometry.js";
import { World } from "../src/core/world.js";

const old = process.argv.includes("--old");
const output = process.env.PROVE_IT_OUTPUT_DIR;
const world = new World({ seed: "cairo-42", cityVersion: old ? 3 : 4,
  traffic: 96, pedestrians: old ? 120 : 144, speedLimit: 50 }, "metro");
const originalActors = [...world.actors], originalStatics = world.statics;
const report = { passed: false };
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const startCommand = { type: "street-pursuit-start", level: 4, ...(old ? {} : { variant: "rush" }) };

function busyJunction() {
  const trip = new World({ ...world.config, difficulty: 5, chaos: 1, scenarioInterval: 2 }, "metro");
  while (trip.tick < 91) trip.step();
  trip.command({ type: "destination", place: trip.district.places[0] });
  while (trip.tick < 788) trip.step();
  const approach = { x: trip.player.x, z: trip.player.z, reason: trip.player.reason };
  assert.equal(approach.reason, "district-merge", "Exercise a pursuer launch during actual junction yielding");
  trip.command(startCommand);
  for (let i = 0; i < 720 && trip.pursuit.phase === "running"; i++) trip.step();
  const metrics = trip.pursuit.metrics;
  assert.ok(metrics.distanceM >= 20 && metrics.pedestrianCollisions === 0);
  assert.deepEqual(trip.audit(), []);
  return { approach, drivenM: metrics.distanceM, phase: trip.pursuit.phase,
    pursuitS: metrics.survivalS, pedestrianHits: metrics.pedestrianCollisions };
}

try {
  world.command(startCommand);
  const { player, pursuit } = world;
  const rear = [...pursuit.patrols].find(car => car.policeTactic === "tail" &&
    (car.x - player.x) * Math.sin(player.heading) + (car.z - player.z) * Math.cos(player.heading) < 0);
  assert.ok(rear, "Start with a genuine rear pursuit");
  const initialGapM = distance(rear, player);
  let peakMps = 0, fastestTailMps = 0, highSpeedGainM = 0;
  const timeline = [];
  for (let i = 1; i <= 360; i++) {
    world.step();
    peakMps = Math.max(peakMps, player.speed);
    fastestTailMps = Math.max(fastestTailMps, rear.speed);
    if (player.speed >= 11) highSpeedGainM = Math.max(highSpeedGainM, initialGapM - distance(rear, player));
    if (i % 30 === 0) timeline.push({ tick: world.tick, x: player.x, z: player.z,
      speedMps: player.speed, gapM: distance(rear, player), patrols: pursuit.patrols.size,
      reason: player.reason, blockedBy: player.blockedBy });
  }
  const patrols = [...pursuit.patrols].map(car => ({ id: car.id, pattern: car.policeTactic, movedM: car.distance }));
  const ordinaryMoving = originalActors.filter(actor => actor !== player && actor.distance > 1);
  const snapshot = digest(world.snapshot());
  report.metrics = { phase: pursuit.phase, peakMps, fastestTailMps, initialGapM, highSpeedGainM,
    playerM: pursuit.metrics.distanceM, patrols, events: pursuit.events, timeline, snapshot };
  assert.deepEqual(world.audit(), [], "No actors should overlap");
  const stronger = peakMps >= 11 && highSpeedGainM >= 3 && patrols.length >= 8 &&
    patrols.filter(car => car.movedM >= 8).length >= 3 && pursuit.metrics.distanceM >= 35;
  if (old) {
    assert.equal(snapshot, "4a649b15a8f12c39a2a3a894dde87ed500101a00fb5e3e712e66f7c5c966ee6e");
    assert.equal(stronger, false, "The old run must not appear to meet the new pace and pressure criteria");
    console.log("EXPECTED_OLD_PURSUIT_LIMIT_DETECTED", JSON.stringify(report.metrics));
    process.exitCode = 3;
  } else {
    assert.ok(stronger, JSON.stringify(report.metrics));
    assert.ok(fastestTailMps > 11 && pursuit.events.some(event => event.kind === "reinforcement") &&
      pursuit.events.some(event => ["roadblock", "closure"].includes(event.kind)));
    assert.ok(originalActors.every(actor => world.actors.includes(actor)));
    assert.ok(ordinaryMoving.filter(actor => actor.type === "pedestrian").length > 100);
    assert.equal(pursuit.metrics.pedestrianCollisions, 0);
    assert.equal(snapshot, digest(World.fromReplay(world.replay()).snapshot()));
    world.command({ type: "street-pursuit-stop" });
    assert.equal(world.mode, "manual");
    assert.deepEqual(world.actors, originalActors);
    assert.equal(world.statics, originalStatics);
    assert.deepEqual(world.audit(), []);
    report.busyJunction = busyJunction();
    report.passed = true;
    console.log("LIVE_RUSH_PURSUIT_AND_REPLAY_VERIFIED");
  }
} finally {
  if (output) await writeFile(join(output, "pursuit-engine.json"), JSON.stringify(report, null, 2));
}
