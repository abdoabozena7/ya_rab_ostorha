import test from "node:test";
import assert from "node:assert/strict";
import { World } from "../src/core/world.js";
import { lanePath } from "../src/core/navigation.js";
import { SpatialIndex } from "../src/core/spatial-index.js";
import { safeSpeed } from "../src/core/traffic-control.js";

test("red signal is reported as the stop cause when its junction cap is also zero", () => {
  const world = new World({ traffic: 0, pedestrians: 0 });
  const car = world.makeVehicle("signal-car", "sedan", {
    x: 58.7,
    z: 18.35,
    heading: -Math.PI / 2,
  });
  car.reckless = false;
  world.actors.push(car);
  world.actorIndex = new SpatialIndex(world.actors);
  world.tick = 60 * 8; // east-west signal is red
  const command = safeSpeed(world, car, { targetSpeed: 5, steer: 0 });
  assert.ok(command.targetSpeed < 0.001);
  assert.equal(command.reason, "red-light");
  assert.equal(command.blockedBy, null);
});

test("a car waiting at red relinquishes the junction and reacquires on green", () => {
  const world = new World({ traffic: 0, pedestrians: 0 });
  const group = world.junctionGroups.find((g) =>
    g.members.some((n) => n.x === 50 && n.z === 20),
  );
  assert.ok(group);
  const car = world.makeVehicle("red-car", "sedan", {
    x: 48.35,
    z: 13,
    heading: 0,
  });
  car.path = [
    { x: 48.35, z: 13 },
    { x: 48.35, z: 20 },
    { x: 48.35, z: 40 },
    { x: 48.35, z: 60 },
  ];
  world.actors.push(car);
  world.tick = 60 * 11; // north-south signal is red
  world.junctionOwners.set(group.key, [
    { id: car.id, entered: true, since: world.tick - 100 },
  ]);
  world.updateJunctions();
  assert.ok(
    !(world.junctionOwners.get(group.key) ?? []).some((o) => o.id === car.id),
  );
  world.tick = 60;
  world.updateJunctions();
  assert.ok(
    (world.junctionOwners.get(group.key) ?? []).some((o) => o.id === car.id),
  );
});

test("a car already ahead in the same lane may clear a reserved group", () => {
  const world = new World({ traffic: 0, pedestrians: 0 });
  const group = world.junctionGroups.find((g) =>
    g.members.some((n) => n.x === 50 && n.z === 20),
  );
  const behind = world.makeVehicle("behind", "sedan", {
    x: 51.65,
    z: 35.6,
    heading: Math.PI,
  });
  const ahead = world.makeVehicle("ahead", "sedan", {
    x: 51.65,
    z: 27,
    heading: Math.PI,
  });
  behind.path = [
    { x: 51.65, z: 35.6 },
    { x: 51.65, z: 20 },
    { x: 51.65, z: 0 },
  ];
  ahead.path = [
    { x: 51.65, z: 27 },
    { x: 51.65, z: 20 },
    { x: 51.65, z: 0 },
  ];
  world.actors.push(behind, ahead);
  world.tick = 60; // north-south green
  world.junctionOwners.set(group.key, [
    { id: behind.id, entered: true, since: 10 },
  ]);
  world.updateJunctions();
  assert.ok(
    (world.junctionOwners.get(group.key) ?? []).some((o) => o.id === ahead.id),
  );
  assert.deepEqual(world.audit(), []);
});

test("a front car can clear a reserved junction when its owner is behind outside", () => {
  const world = new World({ traffic: 0, pedestrians: 0 });
  const group = world.junctionGroups.find((g) =>
    g.members.some((n) => n.x === -100 && n.z === -80),
  );
  const behind = world.makeVehicle("behind", "sedan", {
    x: -101.9,
    z: -96.9,
    heading: 2 * Math.PI - 0.25,
  });
  const ahead = world.makeVehicle("ahead", "sedan", {
    x: -101.65,
    z: -86.98,
    heading: 0.01,
  });
  behind.path = [
    { x: -101.65, z: -96.9 },
    { x: -101.65, z: -80 },
    { x: -101.65, z: -60 },
  ];
  ahead.path = [
    { x: -101.65, z: -86.98 },
    { x: -101.65, z: -80 },
    { x: -101.65, z: -60 },
  ];
  world.actors.push(behind, ahead);
  world.tick = 60;
  world.junctionOwners.set(group.key, [
    { id: behind.id, entered: false, since: 10 },
  ]);
  world.updateJunctions();
  assert.ok(
    (world.junctionOwners.get(group.key) ?? []).some((o) => o.id === ahead.id),
  );
});

test("a right-angle road end arbitrates crossing cars so a lab trip can finish", () => {
  const world = new World(
    {
      seed: "holdout-2",
      traffic: 8,
      pedestrians: 12,
      chaos: 0.7,
      difficulty: 3,
      scenarioInterval: 7,
    },
    "lab",
  );
  assert.ok(
    world.junctionGroups.some((g) =>
      g.members.some((n) => n.x === 20 && n.z === 40),
    ),
  );
  assert.ok(world.command({ type: "destination", place: { x: 20, z: 40 } }));
  for (let tick = 0; tick < 3600 && !world.metrics.completedTrips; tick++) {
    world.step();
    assert.deepEqual(world.audit(), []);
  }
  assert.equal(world.metrics.completedTrips, 1);
});

test("a route ending before a junction cannot reserve a future crossing", () => {
  const world = new World({ traffic: 0, pedestrians: 0 });
  const group = world.junctionGroups.find((g) => g.key === "-70.0000,100.0000");
  assert.ok(group);
  const westbound = world.makeVehicle("westbound", "sedan", {
    x: -46.2,
    z: 98.35,
    heading: -Math.PI / 2,
  });
  westbound.path = [
    { x: -46.2, z: 98.35 },
    { x: -70, z: 98.35 },
    { x: -90, z: 98.35 },
  ];
  const northbound = world.makeVehicle("northbound", "sedan", {
    x: -71.65,
    z: 80.75,
    heading: 0,
  });
  northbound.path = [
    { x: -71.65, z: 80.75 },
    { x: -71.65, z: 81.7 },
  ];
  world.actors.push(westbound, northbound);
  world.tick = 4798;
  world.junctionOwners.set(group.key, [
    { id: westbound.id, entered: false, since: 4729 },
  ]);
  world.updateJunctions();
  assert.deepEqual(
    world.junctionOwners.get(group.key).map((owner) => owner.id),
    ["westbound"],
  );
  northbound.path = lanePath([
    { x: -70, z: 80 },
    { x: -70, z: 100 },
    { x: -100, z: 100 },
  ]);
  world.updateJunctions();
  assert.deepEqual(
    world.junctionOwners.get(group.key).map((owner) => owner.id),
    ["westbound"],
  );
  let westboundCleared = false;
  let northboundCleared = false;
  for (let tick = 0; tick < 1200; tick++) {
    world.step();
    assert.deepEqual(world.audit(), []);
    westboundCleared ||= westbound.x < -80;
    northboundCleared ||= northbound.x < -80;
    if (westboundCleared && northboundCleared) break;
  }
  assert.ok(westboundCleared, "the first owner should cross");
  assert.ok(northboundCleared, "the later turn should cross after the owner");
});
