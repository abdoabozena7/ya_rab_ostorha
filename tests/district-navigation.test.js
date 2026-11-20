import test from "node:test";
import assert from "node:assert/strict";
import { createEgyptDistrict, districtRoadPose } from "../src/core/egypt-district.js";
import { districtTurnPaths, planDistrictRoute } from "../src/core/district-navigation.js";
import { angleDelta, bodyOnRoad, corners, distance, pointOnRoad, sweepSafe } from "../src/core/geometry.js";
import { followPath, integrateVehicle } from "../src/core/vehicle.js";
import { STEP } from "../src/core/config.js";
import { PLAYER_VEHICLE } from "../src/core/vehicle-spec.js";

const npc = {
  id: "route-probe", type: "vehicle", length: 4.2, width: 1.85,
  speed: 0, steer: 0, maxSpeed: 5.5, heading: 0,
};
const suv = {
  ...npc, id: "player",
  length: PLAYER_VEHICLE.lengthM, width: PLAYER_VEHICLE.widthM,
  spec: { wheelbase: PLAYER_VEHICLE.wheelbaseM, maxSteer: PLAYER_VEHICLE.maxSteerRad },
};

function expectedMovements(roads) {
  const junctions = new Map(), movements = new Set();
  for (const a of roads)
    for (const b of roads) {
      if (a.axis === b.axis || b.fixed < a.min || b.fixed > a.max
          || a.fixed < b.min || a.fixed > b.max) continue;
      const x = a.axis === "z" ? a.fixed : b.fixed;
      const z = a.axis === "x" ? a.fixed : b.fixed;
      junctions.set(`${x.toFixed(5)},${z.toFixed(5)}`, { x, z });
    }
  for (const [id, point] of junctions) {
    const incoming = [], outgoing = [];
    for (const road of roads) {
      const along = road.axis === "z" ? point.z : point.x;
      const cross = road.axis === "z" ? point.x : point.z;
      if (cross !== road.fixed || along < road.min || along > road.max) continue;
      for (const sign of road.flow ? [road.flow] : [-1, 1]) {
        const arm = { id: road.id, sign };
        if (sign === 1 ? along > road.min : along < road.max) incoming.push(arm);
        if (sign === 1 ? along < road.max : along > road.min) outgoing.push(arm);
      }
    }
    for (const from of incoming)
      for (const to of outgoing)
        if (from.id !== to.id || from.sign === to.sign)
          movements.add(`${id}:${from.id}:${from.sign}>${to.id}:${to.sign}`);
  }
  return movements;
}

function drive(district, initial, goal, path, maxTicks = 24000) {
  assert.ok(path.length > 10, "A real dense path is required");
  let body = { ...initial }, cursor = 0, moved = 0;
  const narrowDistance = { "alley-west": 0, "alley-east": 0 };
  const narrowRun = { "alley-west": 0, "alley-east": 0 };
  const widened = district.roads.filter((r) => r.supportApron);
  for (let tick = 0; tick < maxTicks; tick++) {
    const command = followPath(body, path, cursor);
    cursor = command.cursor;
    const toStop = (goal.x - body.x) * Math.sin(goal.heading)
      + (goal.z - body.z) * Math.cos(goal.heading);
    command.targetSpeed = Math.min(command.targetSpeed,
      toStop < 12 && distance(body, goal) < 14
        ? Math.sqrt(Math.max(0, toStop - 0.25) * 3.2) : body.maxSpeed);
    const next = integrateVehicle(body, command, STEP);
    const guard = sweepSafe(body, next, district.statics, district.roads);
    assert.equal(guard.safe, true, `${initial.id}: tick ${tick}, ${JSON.stringify(guard)}, ${JSON.stringify(body)}`);
    assert.ok(bodyOnRoad(next, district.roads, 0.12),
      `${initial.id}: whole-body 0.12m curb clearance at ${tick}: ${JSON.stringify(next)}`);
    const delta = distance(body, next);
    assert.ok(delta <= Math.max(Math.abs(body.speed), Math.abs(next.speed)) * STEP + 1e-8);
    moved += delta;
    for (const id of Object.keys(narrowDistance)) {
      const road = district.drivingRoads.find((r) => r.id === id);
      const entirelyNarrow = bodyOnRoad(body, [road], 0.12)
        && corners(body).every((p) => !pointOnRoad(p, widened));
      narrowRun[id] = entirelyNarrow ? narrowRun[id] + delta : 0;
      narrowDistance[id] = Math.max(narrowDistance[id], narrowRun[id]);
    }
    body = next;
    if (distance(body, goal) <= 0.8 && Math.abs(body.speed) <= 0.05
        && Math.abs(angleDelta(body.heading, goal.heading)) <= 0.2)
      return { body, ticks: tick + 1, moved, narrowDistance };
  }
  assert.fail(`No actual arrival: ${JSON.stringify({ initial, body, goal, cursor, pathLength: path.length })}`);
}

test("the unchanged SUV chains all three actual district trips without resetting pose or clipping either narrow alley", () => {
  const district = createEgyptDistrict();
  let body = { ...suv, ...district.playerStart };
  const evidence = [];
  for (const [i, goal] of district.places.entries()) {
    const path = planDistrictRoute(district, body, goal);
    const result = drive(district, body, goal, path);
    const required = district.showcaseRoutes[i].mustUseRoadIds[0];
    assert.ok(result.narrowDistance[required] >= 12,
      `${required} actual narrow traversal: ${result.narrowDistance[required]}`);
    evidence.push({ trip: goal.id, seconds: result.ticks * STEP,
      distanceM: result.moved, narrowDistanceM: result.narrowDistance[required],
      arrivalDistanceM: distance(result.body, goal),
      arrivalHeadingRad: Math.abs(angleDelta(result.body.heading, goal.heading)),
      arrivalSpeedMps: result.body.speed });
    body = result.body;
  }
  console.log(`DISTRICT_CHAIN ${JSON.stringify(evidence)}`);
});

test("every emittable directed junction movement is driven by actual SUV and normal NPC at rest and 4.5m/s", () => {
  const district = createEgyptDistrict();
  let driven = 0;
  for (const shape of [suv, npc]) {
    const turns = districtTurnPaths(district, shape);
    assert.deepEqual(new Set(turns.map((turn) => turn.id)), expectedMovements(district.drivingRoads),
      "The enumerable plant checks must include every directed movement this profile admits");
    const used = new Set(turns.flatMap((turn) => [turn.incomingRoadId, turn.outgoingRoadId]));
    assert.equal(used.size, district.drivingRoads.length, "No road may be isolated by turn filtering");
    for (const turn of turns)
      for (const speed of [0, 4.5]) {
        drive(district, { ...shape, ...turn.start, speed, maxSpeed: 4.5,
          id: `${shape.id}/${turn.id}/${speed}` }, turn.goal, turn.path, 1800);
        driven++;
      }
  }
  console.log(`DISTRICT_ACTUAL_TURNS ${driven}`);
});

test("every authored traffic spawn has at least two legal dense continuations and the directed goal graph remains connected", () => {
  const district = createEgyptDistrict();
  for (const [i, start] of district.trafficSpawns.entries()) {
    const body = { ...npc, ...start, id: `traffic-${i}` };
    const goals = [];
    for (const goal of district.trafficGoals) {
      if (distance(start, goal) > 18 && planDistrictRoute(district, body, goal).length > 10)
        goals.push(goal);
      if (goals.length >= 2) break;
    }
    assert.ok(goals.length >= 2, `Spawn ${i} has only ${goals.length} legal goals`);
  }
  for (const start of district.trafficGoals) {
    const alternatives = district.trafficGoals.filter((goal) => goal !== start
      && planDistrictRoute(district, { ...npc, ...start }, goal).length > 10);
    assert.equal(alternatives.length, district.trafficGoals.length - 1,
      `${start.id} directed reachability`);
  }
});

test("the planner rejects wrong-way, unregistered, oversized and actor-independent false shortcuts", () => {
  const district = createEgyptDistrict();
  const alley = district.drivingRoads.find((road) => road.id === "alley-east");
  assert.throws(() => districtRoadPose(alley, 18, -1), /Wrong-way/);
  const negativeFlow = { ...alley, flow: -1 };
  assert.equal(districtRoadPose(negativeFlow, 18).heading, Math.PI);
  assert.throws(() => districtRoadPose(negativeFlow, 18, 1), /Wrong-way/);
  assert.deepEqual(planDistrictRoute(district,
    { ...npc, x: 20, z: 18, heading: Math.PI }, district.places[0]), []);
  assert.deepEqual(planDistrictRoute(district,
    { ...npc, ...district.playerStart }, { x: 1000, z: 1000, heading: 0 }), []);
  const wideStart = { ...npc, x: -31, z: -41.1, heading: Math.PI / 2, width: 3.7 };
  assert.ok(bodyOnRoad(wideStart, district.roads, 0.12), "Oversized negative starts on a valid wide street");
  assert.deepEqual(planDistrictRoute(district, wideStart, { x: 20, z: 18, heading: 0 }), []);
  const reverseGoal = { x: 20, z: 18, heading: Math.PI };
  assert.deepEqual(planDistrictRoute(district, { ...npc, ...district.playerStart }, reverseGoal), []);
  const before = JSON.stringify(district);
  const blocked = [{ id: "parked-on-route", type: "vehicle", x: -12, z: -25 }];
  const path = planDistrictRoute(district, { ...npc, ...district.playerStart }, district.places[0], blocked);
  assert.ok(path.length > 10, "A moving actor changes route cost, not the registered road graph");
  assert.equal(JSON.stringify(district), before);
  const middle = Math.floor(path.length / 2), original = { ...path[middle] };
  path[middle].x += 1000;
  assert.deepEqual(planDistrictRoute(district, { ...npc, ...district.playerStart },
    district.places[0], blocked)[middle], original, "One vehicle cannot mutate another route's cached geometry");
  const fromAlley = { ...npc, x: 20, z: 18, heading: 0 };
  assert.ok(planDistrictRoute(district, fromAlley, district.places[1]).length > 10);
  alley.flow = -1;
  assert.deepEqual(planDistrictRoute(district, fromAlley, district.places[1]), [],
    "Geometry caching must not retain a stale one-way graph after a profile change");
});
