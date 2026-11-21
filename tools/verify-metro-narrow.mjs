import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { clamp } from "../src/core/config.js";
import { angleDelta, bodyOnRoad } from "../src/core/geometry.js";
import { followPath } from "../src/core/vehicle.js";
import { GtaPursuitEnv } from "../src/rl/gta-pursuit-env.js";

const stop = { steer: 0, brake: 1, throttle: 0, gear: 1 };
const windowTicks = 1080;

function run(scenario, shield = true, waitForTraffic = true) {
  const env = new GtaPursuitEnv();
  const { info } = env.reset({ scenario, seed: "route-train-00", shield, traffic: 0, pedestrians: 0,
    config: { ruleset: "dispatch-v1", wantedLevelStart: 1, wantedLevelMax: 1,
      maxActivePatrols: 1, episodeMaxSeconds: 20, enableRoadblocks: false },
    observation: "dispatch-route-v2" });
  const { world } = env, { player, pursuit } = world, [patrol] = pursuit.patrols;
  const { roadId, oncomingId, barrierId } = info.scenario;
  const road = world.drivingRoads.find(road => road.id === roadId);
  const civilian = world.actors.find(actor => actor.id === oncomingId);
  const barrier = barrierId && world.statics.find(body => body.id === barrierId);
  assert.ok(civilian && patrol && road.width < 4);
  assert.equal(Boolean(barrier), scenario === "L18-blocked");
  const start = { x: player.x, z: player.z };
  const path = Object.freeze(Array.from({ length: 154 }, (_, i) => {
    const z = start.z + player.spec.wheelbase / 2 - i * .25;
    const t = clamp((start.z - z) / 7.4, 0, 1);
    return Object.freeze({ z, x: start.x + (road.fixed - start.x) * t * t * (3 - 2 * t) });
  }));
  const initial = [player, civilian, patrol].map(({ id, x, z, speed, heading }) => [id, x, z, speed, heading]);
  const trace = [], incidents = [];
  let releaseTick = null, firstApproach = null, lastApproach = null, civilianClearTick = null;
  let firstClosingTtcS = null, entryTick = null;
  let cursor = 0, staticBrakes = 0, offRoadTicks = 0, travelInAlleyM = 0;
  while (world.tick < windowTicks && pursuit.phase === "running") {
    const scan = pursuit.gta.scan;
    const approaching = scan.tracks.find(track => track.kind === "civilian" && track.ageS === 0 &&
      track.motionKnown && track.ttcS !== null && track.forwardM > 0 && track.ttcS < 5);
    if (approaching) {
      firstApproach ??= world.tick;
      firstClosingTtcS ??= approaching.ttcS;
      lastApproach = world.tick;
    }
    // Release only after the actual sighting and a fresh observation that the
    // same-class traffic is receding into Market, not disappearing behind a wall.
    const departing = scan.tracks.some(track => track.kind === "civilian" && track.ageS === 0 &&
      track.motionKnown && track.ttcS === null && track.rightM < -5.2 &&
      track.rightM * track.rightMps + track.forwardM * track.forwardMps > 3);
    if (releaseTick === null && firstApproach !== null && world.tick - lastApproach >= 30 && departing)
      releaseTick = world.tick;
    const command = followPath(player, path, cursor);
    cursor = command.cursor;
    const target = Math.min(player.z > -8 ? 2.8 : 4.8, command.targetSpeed);
    const brake = clamp((player.speed - target) / 2.5, 0, 1);
    const request = waitForTraffic && releaseTick === null ? stop : { gear: 1, brake,
      steer: clamp(command.steer / player.spec.maxSteer, -1, 1),
      throttle: brake ? 0 : clamp((target - player.speed) / 1.8, 0, 1) };
    const step = env.step(request);
    if (civilian.x > road.fixed + 5 && Math.abs(angleDelta(civilian.heading, Math.PI / 2)) < .3)
      civilianClearTick ??= world.tick;
    if (step.info.shield?.reason === "static") staticBrakes++;
    offRoadTicks += Number(!bodyOnRoad(player, world.roads));
    if (bodyOnRoad(player, [road])) {
      entryTick ??= world.tick;
      travelInAlleyM = Math.max(travelInAlleyM, -player.z);
    }
    incidents.push(...step.info.events.filter(event => event.type === "static_or_civilian_hit"));
    if (world.tick % 12 === 0) trace.push([world.tick, player.x, player.z, player.speed,
      civilian.x, civilian.z, civilian.speed, approaching?.ttcS ?? null, departing, releaseTick,
      request, step.info.shield?.reason ?? null, step.info.appliedCommand, patrol.distance]);
    if (!waitForTraffic && incidents.some(event => event.actorId === oncomingId && event.fresh)) break;
  }
  assert.ok(world.actors.includes(civilian) && pursuit.patrols.has(patrol));
  if (barrier) assert.ok(world.statics.includes(barrier));
  return { initial, scenario, ticks: world.tick, phase: pursuit.phase, releaseTick, firstApproach,
    firstClosingTtcS, civilianClearTick, entryTick,
    distanceM: pursuit.metrics.distanceM, travelInAlleyM, contacts: pursuit.metrics.collisions,
    ambientContacts: pursuit.metrics.trafficCollisions,
    patrolM: patrol.distance, civilianM: civilian.distance, staticBrakes, offRoadTicks,
    finalSpeed: player.speed, finalPose: [player.x, player.z], incidents, trace };
}

const result = { clear: run("L18"), blocked: run("L18-blocked"), unguarded: run("L18-blocked", false),
  noWaitControl: run("L18", false, false) };
if (process.env.PROVE_IT_OUTPUT_DIR)
  await writeFile(join(process.env.PROVE_IT_OUTPUT_DIR, "narrow.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify(Object.fromEntries(Object.entries(result).map(([id, { trace, ...row }]) => [id, row]))));
const { clear, blocked, unguarded, noWaitControl } = result;
for (const row of [clear, blocked, unguarded]) {
  assert.deepEqual(row.initial, clear.initial);
  assert.equal(row.ticks, windowTicks);
  assert.equal(row.phase, "running");
  assert.ok(row.firstApproach !== null && row.releaseTick > row.firstApproach && row.firstClosingTtcS > 0);
  assert.equal(row.releaseTick, clear.releaseTick);
  assert.deepEqual(row.trace.filter(frame => frame[0] <= row.releaseTick), clear.trace.filter(frame => frame[0] <= clear.releaseTick));
  assert.ok(row.civilianClearTick !== null && row.entryTick > row.civilianClearTick &&
    row.civilianM > 20 && row.patrolM > 6);
  assert.equal(row.offRoadTicks, 0);
}
assert.ok(clear.travelInAlleyM > 28 && clear.contacts === 0);
assert.ok(blocked.travelInAlleyM > 14 && blocked.travelInAlleyM < 24 &&
  blocked.finalSpeed === 0 && blocked.staticBrakes > 0 && blocked.contacts === 0);
assert.ok(unguarded.incidents.some(event => event.actorId === "metro-lab-L18-closure" && event.fresh));
assert.deepEqual(noWaitControl.initial, clear.initial);
assert.ok(noWaitControl.incidents.some(event => event.actorId === "metro-lab-L18-oncoming" && event.fresh),
  "entering without yielding must expose the actual oncoming conflict");
