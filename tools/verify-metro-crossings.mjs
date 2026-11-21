import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { STEP } from "../src/core/config.js";
import { initializeDistrictActor } from "../src/core/district-behavior.js";
import { distance, overlaps } from "../src/core/geometry.js";
import { createPedestrianBody } from "../src/core/pedestrian-body.js";
import { updatePursuitResponse } from "../src/core/pursuit-response.js";
import { SpatialIndex } from "../src/core/spatial-index.js";
import { World } from "../src/core/world.js";
import { GtaPursuitEnv, getDispatchObservation } from "../src/rl/gta-pursuit-env.js";
import { PursuitScanner } from "../src/signal_processing/pursuit-scanner.js";

const openRoad = { steer: 0, throttle: 1, brake: 0, gear: 1 };
const maxTicks = 400;

function run(id, seed, shield, setup = null) {
  const env = new GtaPursuitEnv(), mixed = id === "L12" || id === "L12-control";
  const reset = env.reset({ scenario: id, seed, traffic: mixed ? 12 : 0, pedestrians: mixed ? 28 : 0, shield,
    config: { ruleset: "dispatch-v1", maxActivePatrols: id === "L12" ? 1 : 0, enableRoadblocks: false,
      enablePitManeuver: false, episodeMaxSeconds: 8 } });
  const { world: w } = env, { player, pursuit } = w;
  const person = w.actors.find(a => a.id === reset.info.scenario.walkerId);
  const [patrol] = pursuit.patrols;
  const start = { player: player.x, pedestrian: person.z,
    crossingX: person.x,
    patrol: patrol && { x: patrol.x, z: patrol.z } };
  if (setup) setup(w, person);
  let entryTick = null, clearTick = null, visible = null, firstBrake = null, contact = null;
  let guardSteps = 0, minSeparationM = Infinity, atClear = 0, policeMovedWhileYieldingM = 0, priorPolice;
  const trajectory = [], trafficBrakes = { police: 0 };
  while (w.tick < maxTicks && pursuit.phase === "running") {
    const { scan } = pursuit.gta;
    const observed = scan.tracks.some(track => track.kind === "pedestrian" && track.ageS === 0);
    if (observed && !visible) visible = { tick: w.tick, distanceM: distance(player, person), speedMps: player.speed };
    const approaching = { tick: w.tick, speedMps: player.speed, distanceM: distance(player, person) };
    const result = env.step(openRoad);
    if (result.info.shield?.reason === "police") trafficBrakes.police++;
    if (result.info.shield?.reason === "pedestrian") {
      guardSteps++;
      firstBrake ??= approaching;
      if (patrol && priorPolice && !clearTick) policeMovedWhileYieldingM += distance(patrol, priorPolice);
    }
    if (patrol) priorPolice = { x: patrol.x, z: patrol.z };
    minSeparationM = Math.min(minSeparationM, distance(player, person));
    if (Math.abs(person.z - person.road.fixed) < person.road.width / 2) entryTick ??= w.tick;
    if (clearTick === null && entryTick !== null && Math.sign(person.z - person.road.fixed) !== person.side &&
        Math.abs(person.z - person.road.fixed) >= person.road.width / 2 - .45) {
      clearTick = w.tick;
      atClear = player.x;
    }
    contact ??= result.info.events.find(e => e.type === "static_or_civilian_hit" && e.kind === "pedestrian") ?? null;
    if (w.tick % 30 === 0 || result.info.events.some(event => event.kind === "pedestrian"))
      trajectory.push({ tick: w.tick, player: { x: player.x, z: player.z, speedMps: player.speed },
        pedestrian: { x: person.x, z: person.z, speedMps: person.speed },
        patrol: patrol && { x: patrol.x, z: patrol.z, speedMps: patrol.speed },
        brakeReason: result.info.shield?.reason ?? null });
  }
  assert.ok(w.actors.includes(person), "pedestrian cannot be removed to avoid contact");
  return {
    phase: pursuit.phase, start, entryTick, clearTick, pedestrianDistanceM: person.distance,
    pedestrianHits: pursuit.metrics.pedestrianCollisions, contacts: pursuit.metrics.collisions,
    contact, visible, firstBrake, guardSteps, minSeparationM,
    distanceM: pursuit.metrics.distanceM, travelAfterClearM: clearTick === null ? 0 : player.x - atClear,
    policeMovedWhileYieldingM, policeDistanceM: patrol?.distance ?? 0, trajectory, trafficBrakes,
    population: { traffic: w.actors.filter(a => a !== player && a.type === "vehicle" && !a.pursuitRole).length,
      pedestrians: w.actors.filter(a => a.type === "pedestrian").length },
  };
}

function frontRear(proof) {
  const test = shield => {
    const env = new GtaPursuitEnv();
    env.reset({ seed: "frontal-blocking-patrol", traffic: 0, pedestrians: 0, shield,
      config: { ruleset: "dispatch-v1", maxActivePatrols: 1, enableRoadblocks: false } });
    const w = env.world, [patrol] = w.pursuit.patrols;
    Object.assign(w.player, { speed: 8, x: -243 });
    Object.assign(patrol, { x: -226, z: w.player.z, heading: w.player.heading, speed: 0, aiState: "ROADBLOCK" });
    w.pursuit.gta.scanner = new PursuitScanner();
    w.pursuit.gta.scan = w.pursuit.gta.scanner.sample(w);
    let brakes = 0;
    for (let i = 0; i < 40 && w.pursuit.phase === "running"; i++)
      if (env.step(openRoad).info.shield?.reason === "police") brakes++;
    return { brakes, contacts: w.pursuit.metrics.collisions, distanceM: w.pursuit.metrics.distanceM };
  };
  const guarded = test(true), unguarded = test(false);
  return { frontBrakes: guarded.brakes, frontContacts: guarded.contacts, unguardedFrontContacts: unguarded.contacts,
    rearBrakes: proof.trafficBrakes.police, frontTravelM: guarded.distanceM };
}

function sides(id, seed) {
  const guarded = run(id, seed, true), unguarded = run(id, seed, false);
  const standing = run(id, seed, true, (_, person) => { person.motionMode = "stop"; });
  return { guarded, unguarded, standing };
}

function testSide({ guarded, unguarded, standing }) {
  assert.deepEqual(guarded.start, unguarded.start);
  assert.ok(unguarded.pedestrianHits > 0 && unguarded.contact?.closingSpeed > 0, JSON.stringify(unguarded));
  assert.ok(guarded.visible?.distanceM > 16 && guarded.firstBrake, JSON.stringify(guarded));
  assert.ok(guarded.firstBrake.distanceM > 2.1 + guarded.firstBrake.speedMps ** 2 / 14,
    `must respond outside physical braking distance: ${JSON.stringify(guarded)}`);
  assert.ok(guarded.entryTick !== null && guarded.clearTick !== null && guarded.pedestrianDistanceM > 12);
  assert.equal(guarded.pedestrianHits, 0, JSON.stringify(guarded));
  assert.ok(guarded.travelAfterClearM > .5, `must resume rather than park forever: ${JSON.stringify(guarded)}`);
  assert.ok(standing.entryTick === null && standing.guardSteps === 0 && standing.distanceM > 40,
    `a person staying at the curb must not prevent forward travel: ${JSON.stringify(standing)}`);
}

function stageStationaryShoulder(w, person) {
  person.z = person.road.fixed + 3.5;
  person.motionMode = "stop";
  w.pursuit.gta.scanner = new PursuitScanner();
  w.pursuit.gta.scan = w.pursuit.gta.scanner.sample(w);
}

function occluded() {
  const env = new GtaPursuitEnv();
  const { info } = env.reset({ seed: "dispatch-crossing-development-1", scenario: "L09", traffic: 0, pedestrians: 0,
    config: { ruleset: "dispatch-v1", maxActivePatrols: 0 } });
  const w = env.world, person = w.actors.find(a => a.id === info.scenario.walkerId);
  w.statics.push({ id: "crosswalk-masked-return", x: person.x - 4, z: w.player.z,
    type: "static", width: 20, length: 1, heading: w.player.heading, height: 2 });
  const rescan = () => w.pursuit.gta.scan = new PursuitScanner().sample(w);
  const hidden = rescan();
  assert.ok(!hidden.tracks.some(track => track.kind === "pedestrian"));
  const obs = getDispatchObservation(w);
  person.z -= .65;
  person.speed = 2;
  rescan();
  assert.deepEqual(getDispatchObservation(w), obs);
  return true;
}

function patrolAtCrossing(scenario, mode = "moving") {
  const stationary = mode === "stationary", tooLate = mode === "inside-stopping-distance";
  const env = new GtaPursuitEnv();
  const { info } = env.reset({ scenario, seed: "dispatch-crossing-development-1",
    traffic: 0, pedestrians: 0, shield: true, config: { ruleset: "dispatch-v1",
      wantedLevelStart: 3, wantedLevelMax: 3, maxActivePatrols: 1, enableRoadblocks: false, episodeMaxSeconds: 10 } });
  const { world } = env, { player, pursuit } = world, [patrol] = pursuit.patrols;
  const person = world.actors.find(actor => actor.id === info.scenario.walkerId);
  const heading = Math.PI / 2;
  Object.assign(player, { x: -181, z: -112, heading, speed: 0 });
  Object.assign(patrol, { x: tooLate ? person.x - 5.8 : -239, z: -112, heading, speed: 11,
    squadRole: "PRIMARY_CHASER", squadSide: 1 });
  if (stationary) person.motionMode = "stop";
  if (tooLate) Object.assign(person, { z: -112, speed: 1, heading: Math.PI, pause: 0 });
  pursuit.gta.nextSquadTick = 10_000;
  world.actorIndex = new SpatialIndex(world.actors);
  updatePursuitResponse(world, true);
  const trace = [], ambientIncidents = [];
  let brakeTick = null, reached = false, crossingComplete = false, hitPedestrian = false;
  const brake = { steer: 0, throttle: 0, brake: 1, gear: 1 };
  for (let i = 0; i < (tooLate ? 60 : 360) && pursuit.phase === "running"; i++) {
    const speed = patrol.speed;
    world.command({ type: "pursuit-drive", action: brake }, false);
    world.step();
    ambientIncidents.push(...pursuit.stepEvents.filter(event => event.type === "ambient_collision"));
    if (patrol.reason === "pedestrian-yield" && patrol.blockedBy === person.id && patrol.speed < speed)
      brakeTick ??= world.tick;
    reached ||= patrol.x > person.x + 5;
    crossingComplete ||= (person.z - person.road.fixed) * person.side < -3;
    hitPedestrian ||= patrol.blockedBy === person.id && patrol.reason === "contact" || person.reason === "contact";
    if (world.tick % 12 === 0)
      trace.push([world.tick, patrol.x, patrol.speed, patrol.reason, person.z, person.speed]);
    if (reached && (stationary || crossingComplete)) break;
  }
  assert.ok(world.actors.includes(person) && pursuit.patrols.has(patrol));
  return { reached, crossingComplete, hitPedestrian, brakeTick, patrolTravel: patrol.distance,
    pedestrianTravel: person.distance, otherContacts: pursuit.metrics.trafficCollisions,
    egoContacts: pursuit.metrics.collisions, ambientIncidents, trace };
}

function leaveSoftMargin(dispatch, contactBand = false) {
  const world = new World({ cityVersion: 4, seed: "route-train-00", traffic: 0,
    pedestrians: 0, chaos: 0 }, "metro");
  const road = world.drivingRoads.find(road => road.id === "souq-collector");
  const parked = world.makeVehicle("fixture-parked-at-souq", "sedan",
    { x: -173.50875, z: 5.8, heading: -Math.PI / 2 });
  initializeDistrictActor(world, parked);
  Object.assign(parked.district, { nextLoadingDistanceM: Infinity, loadingUntilTick: 1200 });
  const target = { x: -174.48095, z: 1.35 };
  const person = { id: "fixture-walker-in-soft-margin", type: "pedestrian", kind: "woman-jacket",
    x: -175.60970, z: 7.04742, heading: 2.946, speed: 0, wait: 0, pause: 0, distance: 0,
    phase: .3, walkSpeed: 1.35, motionMode: "ambient", road, target, crossing: true, side: 1 };
  person.body = createPedestrianBody(person);
  person.radius = person.body.radiusM;
  person.height = person.body.heightM;
  if (contactBand) {
    // Reproduce the accepted resting gap from the dense Civic queue.
    person.x = parked.x;
    person.z = parked.z + parked.width / 2 + person.radius - 0.00000008;
    person.heading = 0;
    target.x = person.x;
    target.z = person.z + 5.2;
  }
  initializeDistrictActor(world, person);
  Object.assign(person.district, { routeConstrained: true, yieldAtCurb: false, holdAtTarget: true,
    pattern: "diagonal", stage: "moving" });
  world.actors.push(parked, person);
  world.actorIndex = new SpatialIndex(world.actors);
  assert.ok(!overlaps(person, parked) && overlaps(person, parked, .12));
  const start = { x: person.x, z: person.z, radius: person.radius };
  world.command({ type: "street-pursuit-start", level: 1, variant: "gta", config: {
    ...(dispatch ? { ruleset: "dispatch-v1" } : {}), maxActivePatrols: 1, enableRoadblocks: false,
  } }, false);
  let contacts = 0;
  const trace = [];
  for (let i = 0; i < 420 && world.pursuit.phase === "running"; i++) {
    world.command({ type: "pursuit-drive", action: { ...openRoad, throttle: 0, brake: 1 } }, false);
    world.step();
    contacts += Number(overlaps(person, parked) ||
      (person.reason === "contact" && person.blockedBy === parked.id) ||
      (parked.reason === "contact" && parked.blockedBy === person.id));
    if (i % 12 === 0) trace.push([world.tick, person.x, person.z, person.speed, person.reason]);
  }
  assert.ok(world.actors.includes(parked) && world.actors.includes(person));
  return { start, distanceM: person.distance, contacts, targetDistanceM: distance(person, target),
    parkedTravelM: parked.distance, ticks: world.tick, trace };
}

const seed = "dispatch-crossing-development-1";
const mixedSeed = "dispatch-crossing-development-mixed";
const result = {
  left: sides("L09", seed), right: sides("L10", seed), occluded: occluded(),
  mixed: run("L12", mixedSeed, true),
  mixedNoPolice: run("L12-control", mixedSeed, true),
  mixedUnguarded: run("L12", mixedSeed, false),
  stationaryShoulder: {
    guarded: run("L09", seed, true, stageStationaryShoulder),
    unguarded: run("L09", seed, false, stageStationaryShoulder),
  },
};
result.frontRear = frontRear(result.mixed);
result.patrolYield = { left: patrolAtCrossing("L09"), right: patrolAtCrossing("L10"),
  stationary: patrolAtCrossing("L09", "stationary"),
  tooLate: patrolAtCrossing("L09", "inside-stopping-distance") };
result.marginRecovery = { dispatch: leaveSoftMargin(true), legacy: leaveSoftMargin(false) };
result.contactBandRecovery = { dispatch: leaveSoftMargin(true, true), legacy: leaveSoftMargin(false, true) };
if (process.env.PROVE_IT_OUTPUT_DIR)
  await writeFile(join(process.env.PROVE_IT_OUTPUT_DIR, "crossings.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
testSide(result.left);
testSide(result.right);
assert.equal(result.mixed.population.traffic, 12);
assert.equal(result.mixed.population.pedestrians, 29);
assert.ok(result.mixed.policeDistanceM > 1 && result.mixed.entryTick !== null &&
  result.mixed.policeMovedWhileYieldingM > 1, "the patrol must actually move during the crossing intervention");
assert.ok(result.mixedUnguarded.pedestrianHits > 0, "combined negative must retain a real conflict");
assert.ok(result.mixed.pedestrianHits === 0 && result.mixed.clearTick !== null && result.mixed.travelAfterClearM > .5,
  "guarded mixed run must yield to the moving person and start moving again");
assert.equal(result.mixed.start.crossingX, result.mixedNoPolice.start.crossingX);
assert.deepEqual(result.mixed.population, result.mixedNoPolice.population);
assert.ok(result.mixedNoPolice.pedestrianHits === 0 && result.mixedNoPolice.policeDistanceM === 0 &&
  result.mixedNoPolice.firstBrake && result.mixedNoPolice.travelAfterClearM > .5);
assert.equal(result.frontRear.rearBrakes, 0, "a vehicle following from behind must not cause a forward brake");
assert.ok(result.frontRear.frontBrakes > 0 && result.frontRear.frontContacts === 0 &&
  result.frontRear.unguardedFrontContacts > 0, "the same class can still be a physical frontal obstacle");
const { guarded: stationary, unguarded: noGuard } = result.stationaryShoulder;
assert.ok(stationary.visible && !stationary.guardSteps && !stationary.contacts && !noGuard.contacts &&
  Math.abs(stationary.distanceM - noGuard.distanceM) < 1e-8,
"quantized returns from a stationary person safely outside the travel path must not become a crossing");
assert.ok(maxTicks * STEP < 8);
for (const row of [result.patrolYield.left, result.patrolYield.right])
  assert.ok(row.brakeTick !== null && row.reached && row.crossingComplete && !row.hitPedestrian &&
    row.otherContacts === 0 && row.egoContacts === 0, "a real Dispatch patrol must yield and resume");
assert.ok(result.patrolYield.stationary.reached && result.patrolYield.stationary.brakeTick === null &&
  result.patrolYield.stationary.otherContacts === 0, "a clear curb does not interrupt normal pressure");
const late = result.patrolYield.tooLate;
assert.ok(late.hitPedestrian && late.egoContacts === 0 && late.ambientIncidents.length === late.otherContacts);
assert.ok(late.ambientIncidents.some(event => [event.first, event.second].some(body => body.type === "pedestrian") &&
  [event.first, event.second].some(body => body.patrol) && event.closingSpeed > 0 &&
  event.energyJ > 0 && event.severity > 0), "retain a late physical patrol impact separately from ego counts");
for (const { dispatch: margin, legacy } of [result.marginRecovery, result.contactBandRecovery]) {
  assert.deepEqual(margin.start, legacy.start);
  assert.ok(margin.distanceM > 4 && margin.contacts === 0 && margin.targetDistanceM < 1 &&
    margin.parkedTravelM === 0 && legacy.parkedTravelM === 0 && legacy.distanceM === 0);
}
