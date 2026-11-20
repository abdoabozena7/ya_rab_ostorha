import assert from "node:assert/strict";
import test from "node:test";
import { STEP } from "../src/core/config.js";
import { districtTrafficCommand, initializeDistrictActor, stepDistrictPedestrian,
  updateDistrictTraffic } from "../src/core/district-behavior.js";
import { planDistrictRoute } from "../src/core/district-navigation.js";
import { districtRoadPose } from "../src/core/egypt-district.js";
import { bodyOnRoad, distance, overlaps } from "../src/core/geometry.js";
import { createPedestrianBody } from "../src/core/pedestrian-body.js";
import { PURSUIT_STOP } from "../src/core/pursuit-controls.js";
import { beginStreetPursuit, endStreetPursuit, pursuitSnapshot, stepPursuit } from "../src/core/pursuit-world.js";
import { SpatialIndex } from "../src/core/spatial-index.js";
import { followPath } from "../src/core/vehicle.js";
import { World } from "../src/core/world.js";

const DRIVE = { steer: 0, throttle: 1, brake: 0, gear: 1 };
const lane = { id: "local", axis: "z", fixed: 0, min: -50, max: 60, width: 3.6,
  flow: 1, laneOffsetM: 0, speedLimitMps: 3.1 };
const goal = (road, along) => ({ id: "exit", roadId: road.id, ...districtRoadPose(road, along) });

function stepStreet(world, action, { allowContact = false, onCommand = () => {} } = {}) {
  const { player } = world, tick = world.tick, nowS = tick * STEP;
  const ownMotion = {
    x: player.x, z: player.z, headingRad: player.heading, speedMps: player.speed,
    lengthM: player.length, widthM: player.width,
  };
  world.visualState = world.visualPredictor.snapshot(nowS, ownMotion);
  updateDistrictTraffic(world);
  const result = stepPursuit(world, action, {
    vehicleCommand(actor, requested) {
      onCommand(actor, requested);
      const command = requested ?? followPath(actor, actor.path, actor.cursor);
      if (requested === null) actor.cursor = command.cursor;
      return allowContact ? districtTrafficCommand(world, actor, command)
        : world.districtDrivingCommand(actor, command, ownMotion, nowS, actor !== player);
    },
    pedestrianMotion: (actor) => stepDistrictPedestrian(world, actor),
  });
  assert.equal(world.tick, tick + 1);
  return result;
}

// Use the real plant, sensors and district hooks, with small initial street
// layouts that isolate directed travel and left/right contact.
function streetScene(road, exit, cross = null) {
  const world = new World({ traffic: 0, pedestrians: 0, seed: "embedded-physical" }, "egypt");
  world.environment = "metro";
  world.drivingRoads = world.roads = cross ? [road, cross] : [road];
  world.statics = [];
  world.district = { ...world.district, drivingRoads: world.roads, roads: world.roads,
    statics: world.statics, conflictZones: [], cautionZones: [], pursuitExits: [exit] };
  world.player = world.makeVehicle("player", "sedan", districtRoadPose(road, 0));
  world.actors = [world.player];
  world.actorIndex = new SpatialIndex(world.actors);
  world.staticIndex = new SpatialIndex(world.statics);
  world.command({ type: "mode", mode: "manual" });
  initializeDistrictActor(world, world.player);
  world.updateSensors();
  return world;
}

test("rush gives patrols extra pace only on avenues, not in a narrow one-way street", () => {
  const world = streetScene(lane, goal(lane, 50));
  const launch = { type: "street-pursuit-start", level: 4 };
  assert.throws(() => world.command({ ...launch, variant: "unrecognized" }), /variant/);
  world.command({ ...launch, variant: "rush" });
  world.command({ type: "mode", mode: "manual" });
  world.command({ type: "pursuit-drive", action: DRIVE });
  const patrols = [...world.pursuit.patrols];
  assert.ok(patrols.length > 0);
  for (let i = 0; i < 180; i++) {
    world.step();
    assert.ok(world.player.speed <= lane.speedLimitMps + 1e-8);
    assert.ok(patrols.every(patrol => patrol.speed <= lane.speedLimitMps + 1e-8));
  }
  assert.ok(world.player.distance > 3 && patrols.some(patrol => patrol.distance > 3));
  assert.deepEqual(world.audit(), []);
});

test("a live City pursuit retains its people and ongoing trip and cleans event-owned objects only", () => {
  const world = new World({ seed: "cairo-42" }, "metro");
  world.command({ type: "visual-mode", mode: "sensors-only" });
  world.command({ type: "destination", place: world.district.places[0] });
  for (let i = 0; i < 60; i++) world.step();
  const { actors, statics, player, destination, drivingRoads, roads, district, mode, tick } = world;
  const originals = actors.slice(), permanentSolids = statics.slice();
  const { path, cursor, parking, previous, vehicle } = player;
  const positions = originals.map(({ x, z, distance }) => ({ x, z, distance }));
  const rng = world.rng.state, overallDistance = world.metrics.distance;
  assert.ok(path.length > 10 && overallDistance > 0, "start from a moving normal trip");
  assert.equal(district.statics, statics, "exercise the aliased map");

  const state = beginStreetPursuit(world, 2);
  const patrols = [...state.patrols];
  assert.equal(world.pursuit, state);
  assert.equal(state.startedTick, tick);
  assert.equal(world.tick, tick);
  assert.equal(world.rng.state, rng);
  assert.equal(world.actors, actors);
  assert.equal(world.player, player);
  assert.deepEqual(originals.map(({ x, z, distance }) => ({ x, z, distance })), positions);
  for (const [actual, before] of [[player.path, path], [player.cursor, cursor],
    [player.parking, parking], [player.previous, previous], [player.vehicle, vehicle],
    [world.drivingRoads, drivingRoads], [world.roads, roads], [world.district, district],
    [world.destination, destination], [world.mode, mode]]) assert.equal(actual, before);
  assert.equal(patrols.length, 4);
  assert.ok(patrols.every((p) => distance(p, player) <= 52 && bodyOnRoad(p, roads)));
  assert.deepEqual(world.audit(), []);
  assert.throws(() => beginStreetPursuit(world), /already running/);
  assert.throws(() => stepPursuit(world, { ...DRIVE, gear: 0 }), /normalized/);
  assert.throws(() => stepPursuit(world, DRIVE), /hooks/);
  assert.equal(world.tick, tick);

  const requestedBy = new Map();
  stepStreet(world, DRIVE, { onCommand(actor, requested) {
    assert.ok(!requestedBy.has(actor), "each vehicle requests exactly one plant step");
    requestedBy.set(actor, requested);
  } });
  assert.ok(requestedBy.get(player).targetSpeed > 0);
  assert.ok(patrols.every((actor) => requestedBy.has(actor) && requestedBy.get(actor) !== null));
  assert.ok(originals.filter((a) => a.type === "vehicle" && a !== player)
    .every((actor) => requestedBy.has(actor) && requestedBy.get(actor) === null));

  for (let i = 0; i < 300 && !state.closures.size && state.phase === "running"; i++)
    stepStreet(world, DRIVE);
  assert.equal(state.phase, "running");
  const [closure] = state.closures.keys();
  assert.ok(closure, "the running event creates a physical obstruction");
  assert.ok(world.statics.includes(closure) && world.staticIndex.near(closure, 0).includes(closure));
  assert.equal(district.statics, statics);
  assert.deepEqual(district.statics, permanentSolids);
  assert.ok(originals.some((a, i) => a.type === "pedestrian" && a.distance - positions[i].distance > 0.1));
  assert.ok(originals.some((a, i) => a.type === "vehicle" && a !== player && a.distance - positions[i].distance > 0.5));
  assert.ok(patrols.some((a) => a.distance > 1));
  assert.ok(state.metrics.distanceM > 3);
  assert.ok(Math.abs(world.metrics.distance - (overallDistance + state.metrics.distanceM)) < 1e-8);
  assert.deepEqual(world.audit(), []);

  const stopTick = world.tick, atStop = { x: player.x, z: player.z, distance: player.distance };
  endStreetPursuit(world);
  assert.equal(world.pursuit, state);
  assert.equal(state.phase, "stopped");
  assert.equal(state.endedTick, stopTick);
  assert.equal(state.events.at(-1).kind, "stopped");
  assert.equal(world.tick, stopTick);
  assert.equal(world.actors, actors);
  assert.equal(world.statics, statics);
  assert.equal(world.destination, destination);
  assert.equal(world.mode, mode);
  assert.deepEqual({ x: player.x, z: player.z, distance: player.distance }, atStop);
  assert.ok(actors.every((a, i) => a === originals[i]));
  assert.equal(actors.length, originals.length);
  assert.ok(!world.staticIndex.near(closure, 0).includes(closure));
  for (const patrol of patrols) assert.ok(!world.actorIndex.near(patrol, 0).includes(patrol));
  assert.deepEqual(statics, permanentSolids);
  const terminal = pursuitSnapshot(world);
  assert.equal(terminal.street, true);
  endStreetPursuit(world);
  for (let i = 0; i < 30; i++) world.step();
  assert.equal(world.tick, stopTick + 30);
  assert.ok(player.distance > atStop.distance + 0.1);
  assert.deepEqual(pursuitSnapshot(world), terminal, "ordinary driving must not extend event metrics");
  assert.deepEqual(world.audit(), []);
  const fresh = beginStreetPursuit(world);
  assert.ok([...fresh.patrols].every((actor) => patrols.every((before) => before.id !== actor.id)));
  assert.equal(fresh.metrics.distanceM, 0);
  endStreetPursuit(world);
});

test("one-way patrol motion follows a supported lane and a driven escape cleans up automatically", () => {
  const world = streetScene(lane, goal(lane, 10.6));
  const state = beginStreetPursuit(world);
  const [patrol] = state.patrols, start = { ...patrol };
  assert.equal(patrol.heading, districtRoadPose(lane, patrol.z).heading);
  let capped = false;
  for (let i = 0; i < 325 && state.phase === "running"; i++) {
    const result = stepStreet(world, DRIVE);
    assert.equal(result.impact, null);
    capped ||= state.appliedCommand.reason === "district-road-limit";
    assert.ok(world.player.speed <= lane.speedLimitMps + 1e-8);
    assert.ok(patrol.z >= start.z && bodyOnRoad(patrol, world.drivingRoads));
    assert.ok(Math.abs(patrol.heading) < 0.1 && Math.abs(patrol.x) < 0.1);
  }
  assert.ok(capped, "the real road speed cap reaches the shared vehicle plant");
  assert.ok(patrol.z - start.z > 3 && patrol.distance > 3);
  assert.equal(state.phase, "escaped");
  assert.ok(state.metrics.escape && state.metrics.distanceM >= 8);
  assert.ok(world.player.vehicle.wheelSpinRad > 0);
  assert.equal(world.sensors.imu.speedMps, world.player.speed);
  assert.equal(state.events.at(-1).kind, "escaped");
  assert.deepEqual(world.actors, [world.player]);
  assert.equal(world.statics, world.district.statics);
  assert.deepEqual(world.audit(), []);
});

test("a real civilian clips the shared fixed step at nonpenetrating left and right contacts", () => {
  for (const side of [-1, 1]) {
    const cross = { ...lane, id: "cross-street", axis: "x", width: 7, flow: -side, speedLimitMps: 6 };
    const world = streetScene(lane, goal(lane, 36), cross);
    const civilian = world.makeVehicle("civilian", "sedan", districtRoadPose(cross, 3.7 * side));
    civilian.speed = 4;
    civilian.path = planDistrictRoute(world.district, civilian, goal(cross, -18 * side));
    assert.ok(civilian.path.length > 10);
    world.actors.push(civilian);
    world.actorIndex.add(civilian);
    initializeDistrictActor(world, civilian);
    assert.deepEqual(world.audit(), []);
    const rng = world.rng.state;
    const state = beginStreetPursuit(world);
    let impact;
    for (let i = 0; i < 30 && !impact; i++)
      ({ impact } = stepStreet(world, PURSUIT_STOP, { allowContact: true }));
    assert.equal(world.rng.state, rng, "patrol reservation state must not consume ambient randomness");
    assert.ok(impact && impact.energyJ > 1000 && impact.closingSpeedMps > 2);
    assert.equal(impact.actorId, civilian.id);
    assert.equal(impact.side, side === -1 ? "left" : "right");
    assert.equal(state.metrics.collisions, 1);
    assert.equal(state.metrics.guard, "contact");
    assert.equal(world.player.distance, 0, "the held body does not teleport out of contact");
    // Impacts from moving actors still reach the rig when parked; the
    // existing cosmetic damage model only counts impacts while ego is moving.
    assert.equal(world.player.vehicle.contact.hitId, civilian.id);
    assert.equal(world.player.vehicle.controls.brake, 1);
    assert.ok(civilian.distance > 0.5 && civilian.speed === 0);
    assert.equal(overlaps(world.player, civilian), false);
    assert.ok(overlaps(world.player, civilian, 0.002), "both bodies stop at the physical tangent");
    assert.deepEqual(world.audit(), []);
    endStreetPursuit(world);
    assert.deepEqual(world.actors, [world.player, civilian]);
    assert.equal(state.metrics.impact.actorId, civilian.id);
  }
});

test("an unsupported deployment and non-city commands are rejected without installing an episode", () => {
  const short = { ...lane, min: -8, max: 10 };
  const world = streetScene(short, goal(short, 5));
  const { actors, tick, statics, actorIndex } = world, rng = world.rng.state;
  assert.throws(() => beginStreetPursuit(world), /No safe street pursuit deployment/);
  assert.equal(world.actors, actors);
  assert.equal(world.actorIndex, actorIndex);
  assert.equal(world.statics, statics);
  assert.equal(world.rng.state, rng);
  assert.equal(world.tick, tick);
  assert.equal(world.pursuit, null);
  assert.throws(() => beginStreetPursuit(world, 5), /level/);
  assert.throws(() => beginStreetPursuit(new World({}, "lab")), /metro/);
});

function contactStreet(variant = "cinematic") {
  const street = { ...lane, min: -55, max: 115 };
  const world = streetScene(street, goal(street, 10.6));
  world.command({ type: "street-pursuit-start", level: 1, variant });
  world.command({ type: "mode", mode: "manual" });
  return world;
}

function driveStreet(world, count, action = DRIVE) {
  world.command({ type: "pursuit-drive", action });
  for (let i = 0; i < count && world.pursuit.phase === "running"; i++) world.step();
}

function blockSightAt(world, z) {
  const wall = { id: "fixture-wall", type: "static", kind: "wall", x: 0, z,
    width: 4.7, length: .55, heading: .25, height: 2.4 };
  assert.ok(world.actors.every(actor => !overlaps(actor, wall, .1)), "insert only in a physical gap");
  world.statics.push(wall);
  world.staticIndex = new SpatialIndex(world.statics);
  return wall;
}

function removeSightWall(world) {
  world.statics.length = 0;
  world.staticIndex = new SpatialIndex(world.statics);
}

const patrolMotion = world => [...world.pursuit.patrols].map(car => ({
  x: car.x, z: car.z, speed: car.speed, distance: car.distance, target: car.pursuitDrive.target,
}));

test("cinematic sees a rotating-footprint obstruction, searches a frozen report, reacquires and cools anew", () => {
  const world = contactStreet(), held = contactStreet();
  for (const scene of [world, held]) {
    driveStreet(scene, 245);
    const ep = scene.pursuit;
    assert.ok(scene.player.z > 10.6, "pass the real marker at the authored road speed");
    assert.equal(ep.phase, "running", "a marker is not an escape with a clear line of sight");
    assert.equal(ep.response.stage, "contact");
    assert.ok(ep.response.unitsInContact > 0 && ep.response.unitsInContact < ep.patrols.size);
    assert.ok(ep.events.some(event => event.kind === "reinforcement"));
    blockSightAt(scene, 5);
  }
  const { pursuit: ep, player, actors, statics } = world;
  const patrols = [...ep.patrols];
  const { response } = ep, report = response.lastSeen;
  const eventCount = ep.events.length;
  assert.deepEqual(report, { x: player.x, z: player.z, heading: player.heading, speed: player.speed, tick: world.tick });

  driveStreet(world, 120);
  driveStreet(held, 120, PURSUIT_STOP);
  assert.ok(world.player.z - held.player.z > 4, "paired concealed poses differ by actual displacement");
  assert.equal(response.stage, "search");
  assert.equal(response.unitsInContact, 0);
  assert.equal(response.lastSeen, report, "the sighting is a frozen copy, not a reference to the SUV");
  assert.deepEqual(held.pursuit.response.lastSeen, report);
  assert.deepEqual(patrolMotion(world), patrolMotion(held), "concealed motion cannot redirect a patrol");
  assert.ok(patrols.some(car => car.z < 5 && car.pursuitDrive.target?.z < 5),
    "try a checked approach on the report's street rather than driving through the wall");
  assert.deepEqual(ep.events.slice(eventCount).map(event => event.kind), ["contact-lost"]);

  driveStreet(world, 300);
  const cooling = pursuitSnapshot(world).response;
  assert.equal(cooling.stage, "clearing");
  assert.ok(cooling.clearProgress > 0 && cooling.clearProgress < 1);
  assert.equal(cooling.unitsInContact, 0);
  assert.equal(response.lastSeen, report);
  assert.deepEqual(ep.events.slice(eventCount).map(event => event.kind), ["contact-lost", "clearing"]);
  removeSightWall(world);
  driveStreet(world, 18);
  assert.equal(response.stage, "contact");
  assert.equal(response.clearProgress, 0);
  assert.ok(response.lastSeen.tick > report.tick && response.lastSeen.z > report.z + 20);
  assert.equal(ep.events.at(-1).kind, "reacquired");

  const finalWall = blockSightAt(world, 5);
  driveStreet(world, 150);
  assert.equal(ep.phase, "running", "reacquisition cancels the previous near-complete cooling window");
  assert.equal(response.clearProgress, 0);
  driveStreet(world, 330);
  assert.equal(ep.phase, "escaped");
  assert.equal(response.clearProgress, 1);
  assert.ok(ep.metrics.escape && ep.metrics.distanceM > 40);
  assert.deepEqual(ep.events.slice(-4).map(event => event.kind), ["reacquired", "contact-lost", "clearing", "escaped"]);
  assert.equal(world.actors, actors);
  assert.deepEqual(world.actors, [player]);
  assert.equal(world.statics, statics);
  assert.deepEqual(statics, [finalWall]);
  assert.ok(patrols.every(car => !world.actorIndex.near(car, 0).includes(car)));
  assert.deepEqual(world.audit(), []);
});

test("hidden waiting at launch cannot clear, while old rush still ends at a marker without search", () => {
  const world = contactStreet();
  blockSightAt(world, -6);
  driveStreet(world, 460, PURSUIT_STOP);
  assert.equal(world.pursuit.phase, "running");
  assert.deepEqual(pursuitSnapshot(world).response, { stage: "search", pressure: 0, clearProgress: 0, unitsInContact: 0 });
  assert.equal(world.pursuit.metrics.distanceM, 0);
  assert.deepEqual(world.pursuit.events.map(event => event.kind), ["start", "contact-lost"]);
  assert.deepEqual(world.audit(), []);

  const old = contactStreet("rush");
  driveStreet(old, 245);
  assert.equal(old.pursuit.phase, "escaped", "the old marker is deliberately still a win");
  assert.equal(Object.hasOwn(pursuitSnapshot(old), "response"), false, "rush cannot meet the new search oracle");
  assert.ok(!old.pursuit.events.some(event => event.kind === "contact-lost"));
});

test("cinematic capture needs real crowding on the same side of an opaque footprint", () => {
  const world = contactStreet();
  const patrols = [...world.pursuit.patrols];
  for (const [i, z] of [-6.5, 6.7, -35, -44].entries()) {
    const car = patrols[i];
    Object.assign(car, { z, speed: 0 });
    car.pursuitDrive.cruise = 0;
  }
  world.actorIndex = new SpatialIndex(world.actors);
  blockSightAt(world, 3.1);
  assert.deepEqual(world.audit(), []);
  driveStreet(world, 150, PURSUIT_STOP);
  assert.equal(world.pursuit.metrics.capturePressureS, 0);
  assert.equal(world.pursuit.phase, "running");
  removeSightWall(world);
  driveStreet(world, 150, PURSUIT_STOP);
  assert.equal(world.pursuit.phase, "captured");
  assert.deepEqual(world.actors, [world.player]);
  assert.deepEqual(world.audit(), []);
});

test("the cinematic manual command still brakes for a real pedestrian in front", () => {
  const world = contactStreet();
  const person = {
    id: "front-person", type: "pedestrian", kind: "man-polo",
    x: 0, z: 13, heading: Math.PI / 2, speed: 0, walkSpeed: 1.3, phase: 0,
    road: world.roads[0], side: 1, along: 13, target: { x: 1.8, z: 13 },
    distance: 0, wait: 0, pause: 0, crossing: true, motionMode: "stop",
  };
  person.body = createPedestrianBody(person);
  person.radius = person.body.radiusM;
  world.actors.push(person);
  world.actorIndex.add(person);
  initializeDistrictActor(world, person);
  driveStreet(world, 350);
  assert.ok(world.player.distance > 3 && world.player.speed < .05, "advance, then physically brake");
  assert.equal(world.pursuit.appliedCommand.blockedBy, person.id);
  assert.equal(world.pursuit.metrics.pedestrianCollisions, 0);
  assert.ok(!overlaps(world.player, person, .12));
  assert.deepEqual(world.audit(), []);
});

const arcadeVariant = process.env.CITY_PURSUIT_TEST_VARIANT ?? "arcade";

test("arcade patrols outrun and ram while consecutive backup cars raise wanted stars", context => {
  const world = new World({ cityVersion: 4 }, "metro");
  const original = [...world.actors];
  world.command({ type: "street-pursuit-start", level: 3, variant: arcadeVariant });
  const { pursuit } = world, initial = [...pursuit.patrols];
  assert.ok(initial.length >= 8, "Arcade must start with at least eight patrols");
  assert.equal(pursuitSnapshot(world).wantedLevel, 3);
  assert.equal(pursuitSnapshot(world).learning, null);
  assert.ok(initial.every(car => bodyOnRoad(car, world.drivingRoads) &&
    world.actors.every(other => other === car || !overlaps(car, other))));
  const tail = initial.find(car => car.policeTactic === "tail");
  const before = distance(tail, world.player);
  let peakMps = 0, playerPeakMps = 0;
  for (let i = 0; i < 390; i++) {
    assert.equal(pursuit.phase, "running");
    world.step();
    peakMps = Math.max(peakMps, tail.speed);
    playerPeakMps = Math.max(playerPeakMps, world.player.speed);
    if (i === 180) assert.equal(pursuitSnapshot(world).wantedLevel, 4);
  }
  assert.ok(peakMps > playerPeakMps + 3, "the faster patrol must reach higher actual speed");
  assert.ok(distance(tail, world.player) < before - 6, "the tail physically closes over six metres");
  assert.ok(initial.filter(car => car.distance > 10).length >= 5, "the group drives, not just its closest patrol");
  const backup = pursuit.events.filter(event => event.kind === "reinforcement");
  assert.deepEqual(backup.map(event => event.tick - pursuit.startedTick), [180, 360]);
  assert.equal(new Set(backup.map(event => event.actorId)).size, 2);
  assert.equal(pursuitSnapshot(world).wantedLevel, 5);
  context.diagnostic(`patrol=${peakMps.toFixed(2)} m/s player=${playerPeakMps.toFixed(2)} m/s backup=${backup.map(e => e.tick)}`);
  assert.deepEqual(world.audit(), []);
  world.command({ type: "street-pursuit-stop" });
  assert.equal(pursuitSnapshot(world).wantedLevel, 0);
  assert.deepEqual(world.actors, original);

  const straight = { ...lane, width: 14, min: -72, max: 140, speedLimitMps: 10.5 };
  const held = streetScene(straight, goal(straight, 115));
  held.command({ type: "street-pursuit-start", level: 3, variant: arcadeVariant });
  held.command({ type: "mode", mode: "manual" });
  driveStreet(held, 450, PURSUIT_STOP);
  const impact = held.pursuit.metrics.impact;
  assert.ok(impact?.actorId.startsWith("street-pursuit-1-patrol-") && impact.closingSpeedMps > 3,
    "a patrol must physically strike the held target instead of stopping at a following gap");
  assert.equal(held.pursuit.metrics.distanceM, 0);
  assert.deepEqual(held.audit(), []);
});

test("arcade reinforcements wait for contact instead of tracking a hidden pose", () => {
  const street = { ...lane, min: -85, max: 15 };
  const world = streetScene(street, goal(street, 11));
  world.command({ type: "street-pursuit-start", level: 2, variant: "arcade" });
  world.command({ type: "mode", mode: "manual" });
  blockSightAt(world, -8);
  driveStreet(world, 205, PURSUIT_STOP);
  assert.equal(world.pursuit.response.stage, "search");
  assert.equal(world.pursuit.response.unitsInContact, 0);
  assert.equal(pursuitSnapshot(world).wantedLevel, 2);
  assert.ok(world.pursuit.events.every(event => event.kind !== "reinforcement"));
  assert.deepEqual(world.audit(), []);
});

test("arcade practice learns from actual transitions, suspends for manual drive and replays", () => {
  const world = new World({ cityVersion: 4, seed: "cairo-42" }, "metro");
  const start = { type: "street-pursuit-start", level: 3, variant: arcadeVariant };
  world.command({ ...start, ...(arcadeVariant === "arcade" ? { learn: true } : {}) });
  let learned = 0;
  for (let i = 0; i < 108; i++) {
    world.step();
    const decision = world.pursuit.decision;
    if (decision?.source === "learned-tactical") {
      assert.ok(decision.availableActions.includes(decision.index));
      learned++;
    }
  }
  const learner = world.pursuit.learner;
  assert.ok(learner?.snapshot().updates > 4, "Arcade practice must update a City policy");
  assert.ok(learned > 0 && Object.values(learner.weights.q).some(row => row.some(value => value !== 0)));
  const beforeManual = learner.snapshot();
  world.command({ type: "mode", mode: "manual" });
  world.command({ type: "pursuit-drive", action: DRIVE });
  for (let i = 0; i < 24; i++) world.step();
  assert.deepEqual(learner.snapshot(), beforeManual);
  world.command({ type: "mode", mode: "auto" });
  for (let i = 0; i < 60; i++) world.step();
  assert.ok(learner.snapshot().updates > beforeManual.updates);
  assert.equal(world.pursuit.phase, "running");
  const replay = World.fromReplay(world.replay());
  assert.deepEqual(replay.pursuit.learner.weights, learner.weights);
  assert.deepEqual(pursuitSnapshot(replay), pursuitSnapshot(world));

  world.command({ type: "street-pursuit-stop" });
  const beforeRestart = learner.snapshot();
  world.command({ ...start, learn: true });
  assert.equal(world.pursuit.learner, learner);
  assert.deepEqual(world.pursuit.learner.snapshot(), beforeRestart);
  world.command({ type: "street-pursuit-stop" });
  world.command(start);
  assert.equal(pursuitSnapshot(world).learning, null);
});
