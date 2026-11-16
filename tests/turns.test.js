import test from "node:test";
import assert from "node:assert/strict";
import {
  createRoadGraph,
  planNavigation,
  junctionPressure,
  LANE_OFFSET,
} from "../src/core/navigation.js";
import { bodyOnRoad, overlaps } from "../src/core/geometry.js";
import { integrateVehicle, followPath } from "../src/core/vehicle.js";
import { STEP, VEHICLE } from "../src/core/config.js";
import { roadLayout } from "../src/core/roads.js";

test("opposing vehicles can use an unmarked eight-metre local street", () => {
  const roads = roadLayout(100).roads;
  const graph = createRoadGraph(roads);
  const north = {
    id: "north",
    type: "vehicle",
    x: 75 - LANE_OFFSET,
    z: -50,
    heading: 0,
    speed: 0,
    steer: 0,
    length: VEHICLE.length,
    width: VEHICLE.width,
    maxSpeed: 8,
  };
  const south = {
    ...north,
    id: "south",
    x: 75 + LANE_OFFSET,
    z: 10,
    heading: Math.PI,
  };
  const northPath = planNavigation(graph, north, { x: 75, z: 20 });
  const southPath = planNavigation(graph, south, { x: 75, z: -60 });
  assert.ok(northPath.length && southPath.length);
  let northCursor = 0;
  let southCursor = 0;
  for (let tick = 0; tick < 900; tick++) {
    const a = followPath(north, northPath, northCursor);
    const b = followPath(south, southPath, southCursor);
    northCursor = a.cursor;
    southCursor = b.cursor;
    Object.assign(north, integrateVehicle(north, a, STEP));
    Object.assign(south, integrateVehicle(south, b, STEP));
    assert.ok(bodyOnRoad(north, roads));
    assert.ok(bodyOnRoad(south, roads));
    assert.equal(overlaps(north, south), false);
    if (north.z > 9 && south.z < -40) break;
  }
  assert.ok(north.z > 9);
  assert.ok(south.z < -40);
});

test("every left/right turn fits an eight-metre junction from all four approaches", () => {
  const roads = [
    { axis: "x", fixed: 0, min: -30, max: 30, width: 8 },
    { axis: "z", fixed: 0, min: -30, max: 30, width: 8 },
  ];
  const graph = createRoadGraph(roads);
  for (const startSpeed of [0, 8])
    for (let direction = 0; direction < 4; direction++)
      for (const turn of [-1, 1]) {
        const heading = (direction * Math.PI) / 2,
          exit = heading + (turn * Math.PI) / 2;
        let body = {
          id: "car",
          type: "vehicle",
          x: -Math.sin(heading) * 25 - Math.cos(heading) * LANE_OFFSET,
          z: -Math.cos(heading) * 25 + Math.sin(heading) * LANE_OFFSET,
          heading,
          speed: startSpeed,
          steer: 0,
          width: VEHICLE.width,
          length: VEHICLE.length,
          maxSpeed: 9.72,
        };
        const goal = { x: Math.sin(exit) * 25, z: Math.cos(exit) * 25 };
        const path = planNavigation(graph, body, goal, []);
        assert.ok(path.length > 0);
        let cursor = 0,
          arrived = false;
        for (let tick = 0; tick < 1800; tick++) {
          const command = followPath(body, path, cursor);
          cursor = command.cursor;
          if (command.remaining < 1.5) {
            arrived = true;
            break;
          }
          body = integrateVehicle(body, command, STEP);
          assert.ok(
            bodyOnRoad(body, roads),
            `direction ${direction}, turn ${turn}, speed ${startSpeed}, tick ${tick}`,
          );
        }
        assert.ok(arrived, `turn ${direction}/${turn} should complete`);
      }
});

test("new routes avoid a queued junction when a legal alternate street exists", () => {
  const roads = [
    { axis: "x", fixed: 0, min: 0, max: 20, width: 8 },
    { axis: "x", fixed: 20, min: 10, max: 20, width: 8 },
    { axis: "z", fixed: 10, min: 0, max: 20, width: 8 },
    { axis: "z", fixed: 20, min: 0, max: 20, width: 8 },
  ];
  const graph = createRoadGraph(roads);
  const body = { x: 0, z: LANE_OFFSET, heading: Math.PI / 2 };
  const goal = { x: 20, z: 20 };
  const direct = planNavigation(graph, body, goal);
  const pressure = junctionPressure(
    [{ key: "busy", members: [graph.get("20.0000,0.0000")] }],
    [{ type: "vehicle", queuedJunction: "busy", path: [{}], wait: 60 }],
  );
  const detour = planNavigation(graph, body, goal, [], pressure);
  assert.ok(pressure.get("20.0000,0.0000") > 40);
  assert.ok(direct.some((p) => p.x > 17 && p.z < 6));
  assert.ok(detour.some((p) => p.x < 11 && p.z > 10));
  assert.ok(detour.every((p) => Number.isFinite(p.x) && Number.isFinite(p.z)));
});
