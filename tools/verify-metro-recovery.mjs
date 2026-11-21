import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { World } from "../src/core/world.js";
import { angleDelta, bodyOnRoad, distance, overlaps } from "../src/core/geometry.js";
import { updatePursuitResponse } from "../src/core/pursuit-response.js";
import { SpatialIndex } from "../src/core/spatial-index.js";

const brake = { steer: 0, throttle: 0, brake: 1, gear: 1 };
const stalled = { x: -185.7361789535715, z: -106.86165577519358, heading: .8133311793008253 };

function run(mode) {
  const world = new World({ cityVersion: 4, seed: "route-train-00", traffic: 0,
    pedestrians: 0, chaos: 0 }, "metro");
  const ego = world.player;
  const holding = mode === "holding";
  Object.assign(ego, { x: holding ? -207 : -190.0056, z: -109.3, heading: Math.PI / 2, speed: holding ? 4 : 0 });
  world.command({ type: "street-pursuit-start", level: 3, variant: "gta", config: {
    ruleset: "dispatch-v1", maxActivePatrols: 1, wantedLevelStart: 3, wantedLevelMax: 3,
    enableRoadblocks: false, ...(mode === "unreported" ? { surveillanceZones: [] } : {}),
  } }, false);
  const { pursuit } = world, [patrol] = pursuit.patrols;
  Object.assign(patrol, holding ? { x: -193, z: -109.3, heading: Math.PI / 2 } : stalled,
    { speed: 0, path: [], cursor: 0, squadRole: holding ? "INTERCEPTOR" : "PRIMARY_CHASER", squadSide: -1 });
  pursuit.gta.nextSquadTick = 10_000; // Keep the experiment's role fixed, not its pose or drive command.
  const blockers = [];
  if (mode === "unreported")
    blockers.push({ id: "fixture-recovery-screen", x: -188.1, z: -108.6, width: 4, length: .1, heading: 1.55 });
  if (mode === "occupied") for (const sign of [-1, 1]) {
    const along = sign * (patrol.length / 2 + .24);
    blockers.push({ id: `fixture-recovery-stop-${sign}`, x: patrol.x + Math.sin(patrol.heading) * along,
      z: patrol.z + Math.cos(patrol.heading) * along, width: 6, length: .12, heading: patrol.heading });
  }
  for (const body of blockers) Object.assign(body, { type: "static", kind: "barrier", height: 2.4 });
  assert.ok(bodyOnRoad(patrol, world.drivingRoads) &&
    ![...world.statics, ...world.actors.filter(actor => actor !== patrol), ...blockers]
      .some(body => overlaps(patrol, body, .12)));
  world.statics = world.statics.concat(blockers);
  world.staticIndex = new SpatialIndex(world.statics);
  world.actorIndex = new SpatialIndex(world.actors);
  updatePursuitResponse(world, true);
  const start = { x: patrol.x, z: patrol.z, heading: patrol.heading };
  const trace = [], incidents = [];
  let recoveryTicks = 0, maxStepM = 0, reportedTicks = 0, recoverTravelM = 0;
  while (world.tick < 300 && pursuit.phase === "running") {
    const before = { x: patrol.x, z: patrol.z };
    world.command({ type: "pursuit-drive", action: brake }, false);
    world.step();
    const moved = distance(before, patrol);
    maxStepM = Math.max(maxStepM, moved);
    if (patrol.aiState === "RECOVER") {
      recoveryTicks++;
      recoverTravelM += moved;
    }
    if (pursuit.response.lastSeen?.tick === world.tick) reportedTicks++;
    assert.ok(bodyOnRoad(patrol, world.roads) && !blockers.some(body => overlaps(patrol, body)));
    incidents.push(...pursuit.stepEvents.filter(event =>
      ["patrol_collision", "static_or_civilian_hit"].includes(event.type)));
    if (world.tick % 12 === 0)
      trace.push([world.tick, patrol.x, patrol.z, patrol.heading, patrol.speed, patrol.aiState,
        pursuit.response.dispatch.state, patrol.gtaAI.stuckTicks]);
  }
  return { travelM: patrol.distance, phase: pursuit.phase, ticks: world.tick, headingChange: angleDelta(patrol.heading, start.heading),
    recoveryTicks, recoverTravelM, reportedTicks, maxStepM, contactCount: pursuit.metrics.collisions,
    otherContacts: pursuit.metrics.trafficCollisions, start, trace, incidents };
}

const recovery = run("recovery"), occupied = run("occupied"), unreported = run("unreported"), holding = run("holding");
const rows = { recovery, occupied, unreported, holding };
if (process.env.PROVE_IT_OUTPUT_DIR)
  await writeFile(join(process.env.PROVE_IT_OUTPUT_DIR, "patrol-recovery.json"), JSON.stringify(rows, null, 2));
console.log(JSON.stringify(Object.fromEntries(Object.entries(rows).map(([id, { trace, ...row }]) => [id, row]))));
for (const row of Object.values(rows)) {
  assert.equal(row.ticks, 300);
  assert.ok(row.maxStepM < .08 && row.contactCount === 0 && row.otherContacts === 0);
}
assert.ok(recovery.reportedTicks === 300 && recovery.travelM > 3 && recovery.headingChange > .3 &&
  recovery.recoveryTicks > 30 && recovery.recoverTravelM > 2);
assert.ok(unreported.reportedTicks === 0 && unreported.recoveryTicks === 0);
assert.ok(holding.reportedTicks === 300 && holding.recoveryTicks === 0 && holding.travelM < .1);
assert.ok(occupied.reportedTicks === 300 && occupied.recoveryTicks === 0 && occupied.travelM < .1);
