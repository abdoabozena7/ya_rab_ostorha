import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { clamp } from "../src/core/config.js";
import { initializeDistrictActor } from "../src/core/district-behavior.js";
import { angleDelta, bodyOnRoad, overlaps } from "../src/core/geometry.js";
import { SpatialIndex } from "../src/core/spatial-index.js";
import { GtaPursuitEnv } from "../src/rl/gta-pursuit-env.js";
import { PursuitScanner } from "../src/signal_processing/pursuit-scanner.js";

function run(sign, shield, width = 2) {
  const env = new GtaPursuitEnv();
  env.reset({ seed: "route-shield-baseline", traffic: 0, pedestrians: 0, shield,
    config: { ruleset: "dispatch-v1", maxActivePatrols: 0, episodeMaxSeconds: 6 } });
  const w = env.world, { player, pursuit } = w;
  const initialHeading = Math.PI / 2, startingZ = -112, startingX = -245;
  Object.assign(player, { x: startingX, z: startingZ, heading: initialHeading, speed: 5.5 });
  const barrier = { id: "lab-road-bypass", type: "static", kind: "barrier", x: startingX + 9,
    z: startingZ, width, length: .7, heading: initialHeading, height: .8 };
  w.statics = w.statics.concat(barrier);
  w.staticIndex = new SpatialIndex(w.statics);
  pursuit.gta.scanner = new PursuitScanner();
  pursuit.gta.scan = pursuit.gta.scanner.sample(w);
  let brakeSteps = 0, lateralM = 0;
  const trace = [];
  while (w.tick < 160 && pursuit.phase === "running") {
    const swerved = Math.abs(player.z - startingZ) > 2.35 || player.x > barrier.x + 1;
    const steer = sign === 0 ? 0 : swerved ? (player.heading - initialHeading) * -.75 : .24 * sign;
    const step = env.step({ steer, throttle: .29, brake: 0, gear: 1 });
    brakeSteps += step.info.shield?.interventions ?? 0;
    lateralM = Math.max(lateralM, Math.abs(player.z - startingZ));
    if (w.tick % 12 === 0) trace.push({ tick: w.tick, x: player.x, z: player.z, speedMps: player.speed,
      appliedSteer: step.info.appliedCommand?.steer, brakeReason: step.info.shield?.reason ?? null });
    assert.ok(bodyOnRoad(player, w.roads), "an alternate path cannot cut the registered roadway");
  }
  assert.ok(w.statics.includes(barrier), "the actual collider must remain");
  return { passed: player.x > barrier.x + player.length / 2, x: player.x, z: player.z, speed: player.speed,
    lateralM, brakeSteps, distanceM: pursuit.metrics.distanceM, contacts: pursuit.metrics.collisions, trace };
}

const result = { left: run(-1, true), right: run(1, true), zeroSteer: run(0, true),
  boxed: run(1, true, 14), unguarded: run(0, false) };
function frontRear(steer, patrols, wait = false, windowTicks = 246) {
  const env = new GtaPursuitEnv();
  const { info } = env.reset({ scenario: "L13", seed: "development-front-rear", traffic: 0, pedestrians: 0, shield: true,
    config: { ruleset: "dispatch-v1", maxActivePatrols: patrols, wantedLevelMax: 1,
      enableRoadblocks: false, enablePitManeuver: false, episodeMaxSeconds: 10 } });
  const w = env.world, { player, pursuit } = w, [patrol] = pursuit.patrols;
  const barrier = w.statics.find(actor => actor.id === info.scenario.barrierId);
  let simultaneousReads = 0, rearContacts = 0, closestTtcS = Infinity;
  while (w.tick < windowTicks && pursuit.phase === "running") {
    const scan = pursuit.gta.scan;
    const threat = scan.tracks.find(track => track.kind === "police" && track.forwardM < 0 && track.ttcS !== null);
    if (scan.rays[0].kind === "static" && threat) {
      simultaneousReads++;
      closestTtcS = Math.min(closestTtcS, threat.ttcS);
    }
    const past = Math.abs(player.z + 112) > 2.35 || player.x > barrier.x + 1;
    const action = { steer: wait ? 0 : past ? (player.heading - Math.PI / 2) * -.75 : steer,
      throttle: wait ? 0 : .29, brake: wait ? 1 : 0, gear: 1 };
    const step = env.step(action);
    rearContacts += step.info.events.filter(event => event.type === "patrol_collision").length;
    assert.ok(bodyOnRoad(player, w.roads));
  }
  assert.ok(w.statics.includes(barrier));
  return { simultaneousReads, closestTtcS: Number.isFinite(closestTtcS) ? closestTtcS : null,
    contacts: pursuit.metrics.collisions, rearContacts, travelM: pursuit.metrics.distanceM,
    passed: player.x > barrier.x + player.length / 2, patrolM: patrol?.distance ?? 0 };
}
result.combined = { steering: frontRear(.24, 1), standing: frontRear(0, 1, true), absent: frontRear(0, 0, true),
  extended: frontRear(.24, 1, false, 360) };

function loadingTraffic(sign, shield, oncoming = false, steerMagnitude = .45) {
  const env = new GtaPursuitEnv();
  env.reset({ seed: "route-train-00", traffic: 0, pedestrians: 0, shield,
    config: { ruleset: "dispatch-v1", maxActivePatrols: 0, episodeMaxSeconds: 9 } });
  const w = env.world, { player, pursuit } = w;
  const heading = Math.PI / 2, lane = -112, x = -245;
  Object.assign(player, { x, z: lane, heading, speed: 4.7 });
  const car = w.makeVehicle("physical-loading-traffic", "sedan",
    { x: x + (oncoming ? 17 : 9), z: lane, heading: heading * (oncoming ? -1 : 1) });
  initializeDistrictActor(w, car);
  Object.assign(car.district, {
    nextLoadingDistanceM: Infinity, loadingUntilTick: oncoming ? null : 1200,
  });
  if (oncoming) {
    car.path = Array.from({ length: 42 }, (_, i) => ({ x: car.x - i, z: lane }));
    car.speed = 5;
  }
  w.actors.push(car);
  w.actorIndex = new SpatialIndex(w.actors);
  pursuit.gta.scanner = new PursuitScanner();
  pursuit.gta.scan = pursuit.gta.scanner.sample(w);
  let guardSteps = 0, trafficBrakeAt = null, clearanceOK = true;
  const targetZ = lane - sign * 3.1, resetX = car.x, trace = [];
  while (w.tick < (oncoming ? 80 : 342) && pursuit.phase === "running") {
    const steer = player.x < resetX - 1 && Math.abs(player.z - lane) < 2.05 ? steerMagnitude * sign :
      clamp(1.7 * angleDelta(heading, player.heading) - .17 * (targetZ - player.z), -.62, .62);
    const step = env.step({ steer, throttle: .34, brake: 0, gear: 1 });
    if (step.info.shield?.reason === "civilian") trafficBrakeAt ??= w.tick;
    guardSteps += step.info.shield?.interventions ?? 0;
    clearanceOK &&= !overlaps(player, car, .25);
    if (w.tick % 12 === 0)
      trace.push([w.tick, player.x, player.z, player.heading, player.speed, car.x, car.speed,
        step.info.shield?.reason ?? null]);
    assert.ok(bodyOnRoad(player, w.roads));
  }
  assert.ok(w.actors.includes(car), "loading traffic remains an actual collider");
  return { passed: player.x > resetX + 4.4, travelM: pursuit.metrics.distanceM, contacts: pursuit.metrics.collisions,
    carTravelM: car.distance, guardSteps, trafficBrakeAt, clearanceOK, trace };
}
result.traffic = { left: loadingTraffic(-1, true), right: loadingTraffic(1, true), straight: loadingTraffic(0, true),
  tightTurn: loadingTraffic(1, true, false, .36), unguardedStraight: loadingTraffic(0, false),
  oncoming: loadingTraffic(1, true, true) };
if (process.env.PROVE_IT_OUTPUT_DIR)
  await writeFile(join(process.env.PROVE_IT_OUTPUT_DIR, "bypass.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify(Object.fromEntries(Object.entries(result).map(([id, { trace, ...row }]) => [id, row])), null, 2));
for (const row of [result.left, result.right])
  assert.ok(row.passed && row.contacts === 0 && row.lateralM > 2.25, "admit the actual physically clear turn");
for (const row of [result.zeroSteer, result.boxed])
  assert.ok(!row.passed && row.contacts === 0 && row.brakeSteps > 0 && Math.abs(row.speed) < .15,
    "keep a vehicle stopped when its requested continuation is blocked");
assert.ok(result.unguarded.contacts > 0);
const { steering, standing, absent } = result.combined;
assert.ok(steering.passed && steering.contacts === 0 && steering.simultaneousReads > 1 && steering.patrolM > 3);
assert.ok(!standing.passed && standing.contacts > 0 && standing.rearContacts > 0, "waiting exposes the SUV to real rear contact");
assert.ok(absent.contacts === 0 && absent.simultaneousReads === 0 && absent.patrolM === 0);
assert.ok(result.combined.extended.rearContacts > 0, "the scripted local maneuver is not an evasive route");
for (const row of [result.traffic.left, result.traffic.right])
  assert.ok(row.passed && row.contacts === 0 && row.carTravelM === 0 && row.clearanceOK,
    "admit a real turn around measured loading traffic with clearance");
assert.ok(!result.traffic.straight.passed && result.traffic.straight.contacts === 0 &&
  result.traffic.straight.trafficBrakeAt !== null);
assert.ok(!result.traffic.tightTurn.passed && result.traffic.tightTurn.contacts === 0 &&
  result.traffic.tightTurn.trafficBrakeAt !== null, "an ambiguous close pass should still stop");
assert.ok(result.traffic.unguardedStraight.contacts > 0);
assert.ok(result.traffic.oncoming.trafficBrakeAt !== null && result.traffic.oncoming.carTravelM > 3);
