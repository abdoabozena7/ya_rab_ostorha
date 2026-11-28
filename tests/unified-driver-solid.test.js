import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import { STEP } from "../src/core/config.js";
import {
  CAIRO_DEFENSIVE_STRATEGY, CITY_CRUISE_STRATEGY, PURSUIT_ESCAPE_STRATEGY, createDriverStrategy,
  getUnifiedDriverResults, resetUnifiedDriverState, stepUnifiedDriver,
} from "../src/core/driver/index.js";
import { DEFENSIVE_OFFSETS_M, DEFENSIVE_SPEED_FACTORS, defensiveAutoCommand } from "../src/core/defensive-driver.js";
import { overlaps, angleDelta } from "../src/core/geometry.js";
import * as laneGeometry from "../src/core/lane-geometry.js";
import * as streetChaos from "../src/core/street-chaos.js";
import { SpatialIndex } from "../src/core/spatial-index.js";
import { followPath, nearestPathPoint } from "../src/core/vehicle.js";
import { World } from "../src/core/world.js";

const read = (path) => readFileSync(new URL(`../src/core/${path}`, import.meta.url), "utf8");
const OPTIONS = { cityVersion: 5, traffic: 0, pedestrians: 0, seed: "king-long-vehicle-verification", chaos: 0 };
const BLOCK_AHEAD_M = 100;

test("SOLID layout: Cairo is a thin adapter and every stage lives in exactly one module", () => {
  const adapter = read("defensive-driver.js");
  const lines = adapter.split(/\r?\n/).filter((line) => line.trim());
  assert.ok(lines.length < 45, `adapter has ${lines.length} lines`);
  assert.match(adapter, /driver\/unified-driver\.js/);
  assert.match(adapter, /stepUnifiedDriver\(world, player, baseCommand, CAIRO_DEFENSIVE_STRATEGY, options\)/);
  for (const duplicated of ["simulate", "gatherObstacles", "aimSteer", "predictVehicle", "contestedZoneAhead"])
    assert.doesNotMatch(adapter, new RegExp(`function ${duplicated}\\b`));

  const driverFiles = readdirSync(new URL("../src/core/driver/", import.meta.url)).filter((f) => f.endsWith(".js"));
  const stages = { simulate: "trajectory-planner.js", gatherObstacles: "perception.js", aimSteer: "trajectory-planner.js",
    contestedZoneAhead: "perception.js", applySafetyShield: "safety-shield.js", stepUnifiedDriver: "unified-driver.js" };
  for (const [name, owner] of Object.entries(stages)) {
    const owners = ["defensive-driver.js", "world.js", ...driverFiles.map((f) => `driver/${f}`)]
      .filter((file) => new RegExp(`function ${name}\\b`).test(read(file)));
    assert.deepEqual(owners, [`driver/${owner}`], `${name} must be defined once`);
  }

  assert.deepEqual(DEFENSIVE_OFFSETS_M, CAIRO_DEFENSIVE_STRATEGY.offsetsM);
  assert.deepEqual(DEFENSIVE_SPEED_FACTORS, CITY_CRUISE_STRATEGY.speedFactors);
  for (const strategy of [CITY_CRUISE_STRATEGY, CAIRO_DEFENSIVE_STRATEGY, PURSUIT_ESCAPE_STRATEGY]) {
    assert.ok(Object.isFrozen(strategy));
    assert.equal(typeof strategy.scoreCandidate, "function");
    assert.equal(typeof strategy.selectReaction, "function");
  }
  assert.equal(CITY_CRUISE_STRATEGY.id, "city-cruise");
  assert.equal(CITY_CRUISE_STRATEGY.maintainContinuousCruise, false);
  assert.equal(CITY_CRUISE_STRATEGY.parkingArrivalRadiusM, 16);
  assert.equal(CITY_CRUISE_STRATEGY.pedestrianOffsetCapM, 1.4);
  assert.equal(CAIRO_DEFENSIVE_STRATEGY.id, "cairo-defensive");
  assert.equal(CAIRO_DEFENSIVE_STRATEGY.maintainContinuousCruise, true);
});

test("the driver stages have no street-chaos dependency; lane geometry lives in a neutral module", () => {
  for (const file of ["perception.js", "trajectory-planner.js", "safety-shield.js", "unified-driver.js"])
    assert.doesNotMatch(read(`driver/${file}`), /street-chaos/, `${file} must not import street-chaos`);
  assert.equal(typeof CITY_CRUISE_STRATEGY.isWreckActor, "function");
  assert.equal(CITY_CRUISE_STRATEGY.isWreckActor({}, {}), false);
  assert.equal(CITY_CRUISE_STRATEGY.getRouteLock({}, {}), null);
  assert.equal(typeof CAIRO_DEFENSIVE_STRATEGY.getRouteLock, "function");
  for (const name of ["coordsOn", "laneFrame", "idealPathSpeed", "zoneAheadM", "straightLanePath", "lanePoint"]) {
    assert.equal(typeof laneGeometry[name], "function", name);
    assert.equal(streetChaos[name], laneGeometry[name], `${name} is re-exported unchanged`);
  }
  assert.match(read("driver/perception.js"), /export const SOLID_PROP_KINDS/);
});

function blockedWorld(options = {}) {
  const world = new World({ ...OPTIONS, ...options }, "metro");
  const ego = world.player;
  assert.equal(world.command({ type: "destination", place: world.district.showcaseRoutes[0].goal }), true);
  const stopX = ego.x + BLOCK_AHEAD_M;
  const blocker = world.makeVehicle("stopped-sedan", "sedan", {
    x: stopX, z: ego.path.find((p) => p.x > stopX).z, heading: ego.heading,
  });
  Object.assign(blocker, { maxSpeed: 0, speed: 0, path: [] });
  world.actors.push(blocker);
  world.actorIndex = new SpatialIndex(world.actors);
  return { world, ego, blocker };
}

test("a custom Strategy changes the plan without touching the planner (Open/Closed)", () => {
  const { world, ego, blocker } = blockedWorld();
  while (blocker.x - ego.x > 38) world.step();
  const base = followPath(ego, ego.path, ego.cursor ?? 0);
  const plan = (strategy) => {
    resetUnifiedDriverState(ego);
    return stepUnifiedDriver(world, ego, base, strategy).defensiveState;
  };

  const city = plan(CITY_CRUISE_STRATEGY);
  assert.ok(Math.abs(city.offsetM) >= 2, `city cruise sidesteps the stopped car (offset ${city.offsetM})`);

  let scored = 0;
  const hugger = createDriverStrategy({
    id: "opposite-side", offsetsM: CITY_CRUISE_STRATEGY.offsetsM, speedFactors: [1, 0],
    scoreCandidate: (result) => { scored++; return -result.offset * 10 + (1 - result.factor); },
  });
  const custom = plan(hugger);
  assert.ok(scored > 0, "the planner scored candidates through the injected policy");
  assert.ok(Math.sign(custom.offsetM) === -Math.sign(city.offsetM) && Math.abs(custom.offsetM) >= 2,
    `custom ${custom.offsetM} vs city ${city.offsetM}`);

  const rigid = plan(createDriverStrategy({ id: "no-lateral", offsetsM: [0], speedFactors: [1, 0.5, 0] }));
  assert.equal(rigid.offsetM, 0);
  assert.ok(rigid.speedFactor < 1, "without lateral room the same planner brakes instead");

  assert.equal(getUnifiedDriverResults(ego).length > 0, true);
  const cairo = defensiveAutoCommand(world, ego, base);
  assert.equal(cairo.defensiveState.enabled, true);
  const direct = defensiveAutoCommand(world, ego, base, { disableLateralAvoidance: true });
  assert.equal(direct.defensiveState.enabled, false);
  assert.equal(direct.steer, base.steer);
});

const HAZARDS = {
  vehicle: (world, ego, x, z) => {
    const car = world.makeVehicle("stopped-sedan", "sedan", { x, z, heading: ego.heading });
    Object.assign(car, { maxSpeed: 0, speed: 0, path: [] });
    world.actors.push(car);
    return car;
  },
  lamp: (world, ego, x, z) => {
    const lamp = { id: "city-lamp-test", type: "static", kind: "city-lamp", x, z, heading: 0, width: 0.36, length: 0.36 };
    world.statics.push(lamp);
    world.staticIndex = new SpatialIndex(world.statics);
    return lamp;
  },
  pedestrian: (world, ego, x, z) => {
    const walker = world.actors.find((a) => a.type === "pedestrian");
    Object.assign(walker, { x, z: z - 4.2, heading: 0, speed: 0, crossing: true, motionMode: "stop" });
    return walker;
  },
};

// Normal Metro v5 self driving to a destination; no Cairo Traffic, no Chase.
function drive(hazard, { unifiedDriver = true, maxTicks = 5000, stopWhenPassed = false } = {}) {
  const world = new World({ ...OPTIONS, pedestrians: hazard === "pedestrian" ? 1 : 0,
    ...(unifiedDriver ? {} : { unifiedDriver: false }) }, "metro");
  const ego = world.player;
  assert.equal(world.command({ type: "destination", place: world.district.showcaseRoutes[0].goal }), true);
  const x = ego.x + BLOCK_AHEAD_M;
  const laneZ = ego.path.find((p) => p.x > x).z;
  const obstacle = HAZARDS[hazard](world, ego, x, laneZ);
  world.actorIndex = new SpatialIndex(world.actors);
  const stats = { world, ego, obstacle, contacts: 0, passed: false, maxDeviationM: 0, reasons: new Set() };
  for (let i = 0; i < maxTicks && !world.metrics.completedTrips; i++) {
    world.step();
    if (hazard === "vehicle") obstacle.speed = 0;
    if (hazard === "pedestrian") {
      // A walker steps across the ego's lane as the car arrives, then waits on the far side.
      const walking = Math.abs(obstacle.x - ego.x) < 30 && obstacle.z < laneZ + 6.8;
      obstacle.z += walking ? 1.3 * STEP : 0;
      obstacle.speed = walking ? 1.3 : 0;
    }
    if (overlaps(ego, obstacle)) stats.contacts++;
    stats.passed ||= ego.x > obstacle.x + 6;
    stats.maxDeviationM = Math.max(stats.maxDeviationM, Math.abs(ego.z - laneZ));
    stats.reasons.add(ego.reason);
    if (stopWhenPassed && stats.passed) break;
  }
  return stats;
}

test("normal Metro v5 self driving steers around a stopped car on Tahrir and keeps going", () => {
  const run = drive("vehicle");
  const { world, ego } = run;
  assert.equal(world.streetChaos?.active ?? false, false);
  assert.equal(world.pursuit, null);
  assert.equal(world.mode, "auto");
  assert.equal(run.contacts, 0);
  assert.equal(run.passed, true);
  assert.ok(run.maxDeviationM >= 1.5, `sidestep of ${run.maxDeviationM.toFixed(2)} m`);
  assert.ok(run.reasons.has("evasive-shift"));
  assert.equal(world.metrics.completedTrips, 1, `trip must finish, not stop at ${ego.reason}`);
  assert.deepEqual(world.audit(), []);
  assert.equal(ego.vehicle.damage.impactCount, 0);
});

test("negative control: the rigid centre-line driver stalls behind the same stopped car", () => {
  const run = drive("vehicle", { unifiedDriver: false, maxTicks: 2400 });
  assert.equal(run.world.config.unifiedDriver, false);
  assert.equal(run.passed, false);
  assert.equal(run.world.metrics.completedTrips, 0);
  assert.ok(run.maxDeviationM < 0.5);
  assert.ok(run.ego.x < run.obstacle.x - 3 && run.ego.speed < 0.1, "parked dead behind the car");
});

for (const hazard of ["lamp", "pedestrian"]) {
  test(`normal Metro v5 self driving clears a ${hazard === "lamp" ? "solid city-lamp pole" : "crossing pedestrian"} with no impact`, () => {
    const run = drive(hazard);
    assert.equal(run.contacts, 0);
    assert.equal(run.passed, true);
    assert.ok(["evasive-shift", "defensive-yield", "emergency-brake"].some((r) => run.reasons.has(r)),
      "the driver reacted instead of relying on the route");
    assert.equal(run.ego.vehicle.damage.impactCount, 0);
    assert.equal(run.world.metrics.completedTrips, 1);
    assert.deepEqual(run.world.audit(), []);
  });
}

test("full-traffic normal self driving arrives at junctions aligned, without impacts, and finishes its trip", () => {
  const world = new World({ ...OPTIONS, traffic: 40, pedestrians: 60 }, "metro");
  const ego = world.player;
  assert.equal(world.command({ type: "destination", place: world.district.showcaseRoutes[0].goal }), true);
  let holdTicks = 0;
  let maxSkewRad = 0;
  for (let i = 0; i < 7000 && !world.metrics.completedTrips; i++) {
    world.step();
    if (!world.districtBehavior?.holds?.[ego.id] || ego.speed >= 0.5 || ego.path.length < 3) continue;
    holdTicks++;
    const at = nearestPathPoint(ego.path, ego.x, ego.z, ego.cursor ?? 0);
    const from = ego.path[at];
    const to = ego.path[Math.min(ego.path.length - 1, at + 4)];
    maxSkewRad = Math.max(maxSkewRad, Math.abs(angleDelta(ego.heading, Math.atan2(to.x - from.x, to.z - from.z))));
  }
  assert.ok(world.actors.filter((a) => a.type === "vehicle").length > 10 && world.actors.some((a) => a.type === "pedestrian"));
  assert.equal(ego.vehicle.damage.impactCount, 0);
  assert.ok(holdTicks > 0, "the car actually waited at a junction");
  assert.ok(maxSkewRad < 0.35, `heading skew at junction holds ${maxSkewRad.toFixed(3)} rad`);
  assert.equal(world.metrics.completedTrips, 1, `real progress: stopped at ${ego.reason}`);
  assert.ok(ego.distance > 300);
  assert.deepEqual(world.audit(), []);
});