import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { World } from "../src/core/world.js";
import { districtRoadPose } from "../src/core/egypt-district.js";
import { bodyOnRoad } from "../src/core/geometry.js";
import { updatePursuitResponse } from "../src/core/pursuit-response.js";
import { selectDispatchJunction } from "../src/core/dispatch-junctions.js";
import { createDispatchResponse } from "../src/core/pursuit-dispatch.js";
import { SpatialIndex } from "../src/core/spatial-index.js";

const originX = -183, crossStartZ = -98;

function run(sign, { tracked = true, level = 3, role = "FLANKER" } = {}) {
  const world = new World({ cityVersion: 4, seed: `tactical-junction-verifier-${sign}`,
    traffic: 0, pedestrians: 0, chaos: 0 }, "metro");
  const ego = world.player;
  const avenue = world.drivingRoads.find(road => road.id === "tahrir-boulevard");
  const side = world.drivingRoads.find(road => road.id === "civic-avenue");
  const approachGap = role === "INTERCEPTOR" ? 43 : 28;
  Object.assign(ego, districtRoadPose(avenue, originX - approachGap * sign, sign), { speed: 8 });
  world.command({ type: "street-pursuit-start", variant: "gta", config: {
    ruleset: "dispatch-v1", wantedLevelStart: level, wantedLevelMax: level, maxActivePatrols: 1,
    enableRoadblocks: false, ...(tracked ? {} : { surveillanceZones: [] }),
  } }, false);
  const { pursuit } = world, [car] = pursuit.patrols;
  Object.assign(car, districtRoadPose(side, crossStartZ, -1), { speed: 5, squadRole: role, squadSide: sign });
  pursuit.gta.nextSquadTick = 10_000; // Pin only the experiment's role; ordinary City assigns roles itself.
  if (!tracked) {
    pursuit.response.lastSeen = null;
    pursuit.response.dispatch = createDispatchResponse();
    world.statics = world.statics.concat({ id: "fixture-vision-screen", type: "static", kind: "barrier",
      x: originX, z: -103, heading: 0, width: 65, length: .7, height: 2 });
    world.staticIndex = new SpatialIndex(world.statics);
  }
  updatePursuitResponse(world, true);
  const trace = [], hits = [], considered = selectDispatchJunction(world.drivingRoads, car, pursuit.response.lastSeen);
  world.command({ type: "pursuit-drive", action: { steer: 0, throttle: .3, brake: 0, gear: 1 } }, false);
  let ordered = 0, approached = 0, reachedIntercept = false;
  for (let i = 0; i < 260 && pursuit.phase === "running"; i++) {
    world.step();
    assert.ok(bodyOnRoad(car, world.roads), "patrol must not cut outside the shared roadway");
    if (car.gtaAI.junctionRoute) ordered++;
    if (car.gtaAI.junctionRoute && car.z <= crossStartZ - 8 && car.speed > 1 &&
        (originX - ego.x) * sign > 5)
      approached++;
    if (role === "INTERCEPTOR" && Math.abs(car.z - avenue.fixed) < 6 &&
        (car.x - originX) * sign > 4 && (originX - ego.x) * sign > 0 && Math.abs(Math.sin(car.heading)) > .7)
      reachedIntercept = true;
    if (world.tick % 12 === 0)
      trace.push({ tick: world.tick, police: [car.x, car.z, car.heading, car.speed], ego: [ego.x, ego.z], role: car.aiState,
        target: car.gtaAI.junctionRoute?.goal ?? null, state: pursuit.response.dispatch.state });
    for (const event of pursuit.stepEvents) if (event.type === "patrol_collision") hits.push(event);
  }
  return { sign, role, ordered, approached, reachedIntercept, policeDistanceM: car.distance, trace, hits, considered };
}

const results = [run(-1), run(1)], intercepts = [-1, 1].map(sign => run(sign, { role: "INTERCEPTOR" }));
const untracked = run(1, { tracked: false });
const low = run(1, { level: 1 });
const sideApproaches = results.filter(row => row.approached > 0 && row.policeDistanceM > 10).length;
const report = { results, intercepts, untracked, low, sideApproaches, hiddenInvariant: untracked.trace.every(row => row.target === null) };
if (process.env.PROVE_IT_OUTPUT_DIR)
  await writeFile(join(process.env.PROVE_IT_OUTPUT_DIR, "tactics.json"), JSON.stringify(report, null, 2));
assert.ok(low.ordered === 0 && low.approached === 0);
assert.ok(untracked.trace.every(row => row.state === "LOST" && row.target === null));
assert.ok(intercepts.every(row => row.ordered > 0 && row.considered.goal.roadId === "tahrir-boulevard"));
assert.ok(intercepts.some(row => row.reachedIntercept), "at least one patrol must physically turn onto the target avenue");
const replay = run(1);
assert.deepEqual(replay, results[1]);
assert.equal(sideApproaches, 2);
console.log(JSON.stringify({ sideApproaches, hiddenInvariant: report.hiddenInvariant,
  intercepts: intercepts.map(row => ({ sign: row.sign, reached: row.reachedIntercept, meters: row.policeDistanceM })) }, null, 2));
