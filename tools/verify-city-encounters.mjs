import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { World } from "../src/core/world.js";
import { CITY_ENCOUNTERS } from "../src/core/city-encounters.js";
import { districtRoadPose } from "../src/core/egypt-district.js";
import { planDistrictRoute } from "../src/core/district-navigation.js";
import { distance } from "../src/core/geometry.js";
import { SpatialIndex } from "../src/core/spatial-index.js";
import { passesCityDensity } from "./city-density-metrics.mjs";

const output = process.env.PROVE_IT_OUTPUT_DIR ?? "output/city-encounters";
const workload = { traffic: 72, pedestrians: 96, chaos: 1, speedLimit: 50, scenarioInterval: 2, difficulty: 5 };
const bakery = world => world.district.showcaseRoutes[0].goal;

function run(world, ticks, tracked = null) {
  const people = world.actors.filter(actor => actor.type === "pedestrian").length;
  const cars = world.actors.filter(actor => actor.type === "vehicle").length;
  const originals = [...world.actors];
  const events = [], seen = new Set();
  let longestQueue = 0;
  for (let i = 0; i < ticks; i++) {
    const before = tracked ? { x: tracked.x, z: tracked.z, speed: tracked.speed } : null;
    world.step();
    if (before) assert.ok(distance(before, tracked) <=
      (Math.max(Math.abs(tracked.speed), Math.abs(before.speed)) + .01) / 60,
    "The encounter must not relocate an actor");
    for (const event of world.cityEncounters.events) {
      const key = `${event.id}:${event.phase}`;
      if (!seen.has(key)) {
        seen.add(key);
        events.push(event);
      }
    }
    longestQueue = Math.max(longestQueue, world.metrics.trafficStoppedOver5);
    if (i % 180 === 0) assert.deepEqual(world.audit(), []);
  }
  assert.deepEqual(world.audit(), []);
  assert.equal(world.actors.length, cars + people);
  assert.ok(originals.every(actor => world.actors.includes(actor)), "Ambience cannot replace live actors");
  return { seed: world.config.seed, tick: world.tick, cars, people,
    distanceM: world.metrics.distance, longestQueue, events, applied: world.metrics.scenarios,
    roadworksLeft: world.statics.filter(actor => actor.cityEncounter).map(actor => actor.id) };
}

function junction(withTuktuk = true) {
  const world = new World({ ...workload, seed: "street-side-verified", traffic: 0, pedestrians: 0 }, "metro");
  const entry = world.drivingRoads.find(road => road.id === "entry-local");
  const local = world.drivingRoads.find(road => road.id === "west-local");
  Object.assign(world.player, districtRoadPose(entry, -25, -1), { speed: 1.9 });
  const actor = world.makeVehicle("fixture-side-vehicle", withTuktuk ? "tuktuk" : "sedan",
    districtRoadPose(local, -27, -1));
  actor.speed = 3.5;
  actor.path = planDistrictRoute(world.district, actor, { ...districtRoadPose(entry, -3, 1), roadId: entry.id });
  assert.ok(actor.path.length > 10);
  world.actors.push(actor);
  world.actorIndex = new SpatialIndex(world.actors);
  // Isolate the crossing approach while a previous roadworks event cools down.
  world.cityEncounters.nextTick = 0;
  world.cityEncounters.lastStarted.set("roadworks", world.tick);
  world.command({ type: "drive", targetSpeed: 2.1, steer: 0 });
  const result = run(world, 500, actor);
  return { ...result, approachingActor: actor.kind, finalPose: { x: actor.x, z: actor.z, heading: actor.heading } };
}

const load = (seed, override = {}) => {
  const world = new World({ seed, ...workload, ...override }, "metro");
  assert.ok(world.command({ type: "destination", place: bakery(world) }));
  return world;
};

if (process.argv.includes("--negative")) {
  const off = run(load("cairo-42", { chaos: 0 }), 360);
  const absent = junction(false);
  assert.equal(off.applied, 0);
  assert.deepEqual(off.events, []);
  assert.ok(off.distanceM > 10);
  assert.ok(absent.events.every(event => event.kind !== "side-street-tuktuk"));
  const baseline = JSON.parse(await readFile(new URL(
    "../.runtime-proof/metro-density-v1/baseline-browser/city-density.json", import.meta.url), "utf8"));
  assert.ok(!passesCityDensity(baseline.driving) && baseline.driving.ticksPerSecond >= 50,
    "The measured frozen browser could have passed a physics-clock-only check");
  console.log("EXPECTED_CITY_ENCOUNTER_FAILURE_DETECTED");
  process.exitCode = 3;
} else {
  const report = { passed: false };
  try {
    const city = load("cairo-42");
    report.first = run(city, 4100);
    report.other = run(load("city-stress-check"), 2700);
    report.sideStreetFixture = junction();
    const applied = report.first.events.concat(report.other.events, report.sideStreetFixture.events)
      .filter(event => event.phase === "applied");
    assert.deepEqual(new Set(applied.map(event => event.kind)), new Set(CITY_ENCOUNTERS));
    const events = report.first.events.concat(report.other.events);
    assert.ok(events.some(event => event.kind === "curb-pickup" && event.phase === "resumed"));
    assert.ok(events.some(event => event.kind === "traffic-wave" && event.followerDropMps > .32));
    assert.ok(events.some(event => event.kind === "curb-crossing" && event.reachedOppositeSide));
    assert.ok(events.some(event => event.kind === "roadworks" && event.blockedId === "player"));
    assert.ok(events.some(event => event.kind === "roadworks" && event.phase === "cleared"));
    assert.ok(report.sideStreetFixture.events.some(event =>
      event.kind === "side-street-tuktuk" && event.movedM > 3 && event.lowMps < event.speedBeforeMps));
    assert.ok(report.sideStreetFixture.finalPose.x > -41,
      "The side vehicle reaches the actual connecting road after yielding");
    assert.ok(report.first.distanceM >= 110 && report.first.longestQueue >= 2);
    assert.notDeepEqual(report.first.events.slice(0, 4), report.other.events.slice(0, 4));
    const replay = World.fromReplay(city.replay());
    assert.deepEqual(replay.snapshot(), city.snapshot());
    assert.equal(city.visualState.available, false, "World encounters are never injected into the predictor");
    report.exactReplay = true;
    report.passed = true;
  } catch (error) {
    report.failure = error.stack;
    throw error;
  } finally {
    await mkdir(output, { recursive: true });
    await writeFile(join(output, "city-encounters.json"), JSON.stringify(report, null, 2));
  }
}
