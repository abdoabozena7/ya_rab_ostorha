import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { districtRoadPose } from "../src/core/egypt-district.js";
import { planDistrictRoute } from "../src/core/district-navigation.js";
import { distance } from "../src/core/geometry.js";
import { SpatialIndex } from "../src/core/spatial-index.js";
import { World } from "../src/core/world.js";

function run(ruleset, chaos) {
  const w = new World({ cityVersion: 4, seed: "dispatch-ambient-development", traffic: 0,
    pedestrians: 0, chaos, scenarioInterval: 2, difficulty: 4, speedLimit: 50 }, "metro");
  const entry = w.drivingRoads.find(road => road.id === "entry-local");
  const local = w.drivingRoads.find(road => road.id === "west-local");
  Object.assign(w.player, districtRoadPose(entry, -25, -1), { speed: 1.9 });
  const actor = w.makeVehicle("existing-side-traffic", "tuktuk", districtRoadPose(local, -34, -1));
  actor.speed = 3.5;
  actor.path = planDistrictRoute(w.district, actor, { ...districtRoadPose(entry, -3, 1), roadId: entry.id });
  assert.ok(actor.path.length > 10);
  w.actors.push(actor);
  w.actorIndex = new SpatialIndex(w.actors);
  const original = w.actors.slice(), opening = { x: actor.x, z: actor.z };
  w.command({ type: "street-pursuit-start", variant: "gta",
    config: { ruleset, maxActivePatrols: 1, enableRoadblocks: false, episodeMaxSeconds: 10 } }, false);
  w.cityEncounters.nextTick = 0;
  let observedPace = 0, lastPhase, minSpeed = actor.speed;
  const patrolled = [...w.pursuit.patrols][0], samples = [];
  for (let i = 0; i < 500 && w.pursuit.phase === "running"; i++) {
    const brake = w.player.speed > 6 ? .4 : 0;
    w.command({ type: "pursuit-drive", action: { steer: 0, throttle: brake ? 0 : .12, brake, gear: 1 } }, false);
    w.step();
    if (actor.reason === "side-street-tuktuk") {
      observedPace++;
      minSpeed = Math.min(minSpeed, actor.speed);
    }
    if (lastPhase !== actor.reason || i % 30 === 0)
      samples.push({ tick: w.tick, x: actor.x, z: actor.z, speedMps: actor.speed, reason: actor.reason });
    lastPhase = actor.reason;
  }
  assert.ok(original.every(member => w.actors.includes(member)) && w.actors.includes(patrolled));
  return { ruleset, chaos, distanceM: distance(opening, actor), minSpeed, observedPace, patrolM: patrolled.distance,
    phase: w.pursuit.phase, events: w.cityEncounters.events, samples };
}

const active = run("dispatch-v1", 1), chaosOff = run("dispatch-v1", 0), original = run("legacy", 1);
const report = { active, chaosOff, original };
if (process.env.PROVE_IT_OUTPUT_DIR)
  await writeFile(join(process.env.PROVE_IT_OUTPUT_DIR, "ambient.json"), JSON.stringify(report, null, 2));
assert.ok(active.events.some(event => event.kind === "side-street-tuktuk" && event.phase === "applied"));
assert.ok(active.events.some(event => event.kind === "side-street-tuktuk" && event.phase === "resumed"));
assert.ok(active.observedPace > 0 && active.patrolM > 3 && active.distanceM > 3);
assert.ok(active.events.every(event => event.kind !== "roadworks"));
for (const control of [chaosOff, original]) assert.deepEqual(control.events, []);
console.log(JSON.stringify({ event: active.events.find(event => event.phase === "applied"),
  trafficM: active.distanceM, patrolM: active.patrolM }, null, 2));
