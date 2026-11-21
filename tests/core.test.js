import test from "node:test";
import assert from "node:assert/strict";
import { World } from "../src/core/world.js";
import { FixedClock } from "../src/core/clock.js";
import { integrateVehicle } from "../src/core/vehicle.js";
import {
  bodyOnRoad,
  overlaps,
  sweepSafe,
  angleDelta,
} from "../src/core/geometry.js";
import { VEHICLE, STEP } from "../src/core/config.js";
import { PLACES } from "../src/core/places.js";

test("steering cannot rotate a parked car; yaw and steering obey physical limits", () => {
  let car = {
    id: "car",
    type: "vehicle",
    x: 0,
    z: 0,
    heading: 0,
    speed: 0,
    steer: 0,
    maxSpeed: 10,
    ...VEHICLE,
  };
  for (let i = 0; i < 120; i++)
    car = integrateVehicle(car, { steer: 1, targetSpeed: 0 }, STEP);
  assert.equal(car.heading, 0);
  assert.equal(car.x, 0);
  assert.equal(car.z, 0);
  for (let i = 0; i < 300; i++) {
    const before = car;
    car = integrateVehicle(car, { steer: -1, targetSpeed: 10 }, STEP);
    assert.ok(Math.abs(car.steer) <= VEHICLE.maxSteer);
    assert.ok(
      Math.abs(car.steer - before.steer) <= VEHICLE.steerRate * STEP + 1e-9,
    );
    assert.ok(
      Math.abs(angleDelta(car.heading, before.heading)) <=
        (10 / VEHICLE.wheelbase) * Math.tan(VEHICLE.maxSteer) * STEP + 1e-9,
    );
  }
});

test("full body must fit asphalt; sweep catches a person between endpoints", () => {
  const road = { axis: "z", fixed: 0, min: -50, max: 50, width: 8 };
  const car = {
    type: "vehicle",
    x: 3.5,
    z: 0,
    heading: 0,
    length: 4.2,
    width: 1.85,
  };
  assert.equal(bodyOnRoad(car, [road]), false);
  assert.equal(bodyOnRoad({ ...car, x: 0 }, [road]), true);
  const person = { id: "person", type: "pedestrian", radius: 0.34, x: 0, z: 5 };
  assert.equal(overlaps({ ...car, x: 0 }, person), false);
  assert.equal(
    sweepSafe({ ...car, x: 0 }, { ...car, x: 0, z: 10 }, [person], [road]).safe,
    false,
  );
  // Moving away from the obstacle is allowed, unlike the old radial stop rule.
  assert.equal(
    sweepSafe(
      { ...car, x: 0, z: 2 },
      { ...car, x: 0, z: 1.5 },
      [person],
      [road],
    ).safe,
    true,
  );
});

test("an idle player starts in a bay and does not block the live traffic lane", () => {
  const world = new World({ traffic: 0, pedestrians: 0 });
  assert.equal(bodyOnRoad(world.player, world.roads), true);
  assert.ok(
    world.parkingBays.some(
      (bay) =>
        bay.axis === "z" &&
        bay.min < world.player.z &&
        bay.max > world.player.z &&
        Math.abs(bay.fixed - world.player.x) < 0.01,
    ),
  );
  const car = world.makeVehicle("probe", "sedan", {
    x: 18.35,
    z: -49,
    heading: 0,
  });
  car.path = [
    { x: 18.35, z: -49 },
    { x: 18.35, z: -20 },
    { x: 18.35, z: 0 },
    { x: 18.35, z: 20 },
  ];
  world.actors.push(car);
  for (let tick = 0; tick < 600; tick++) {
    world.step();
    assert.deepEqual(world.audit(), []);
  }
  assert.ok(car.z > 0);
  assert.ok(car.distance > 45);
  assert.equal(world.player.x, 14.4);
  assert.equal(world.player.z, -40);
});

test("all named destinations complete without curb corrections on clear streets", () => {
  for (const place of PLACES) {
    const world = new World({ traffic: 0, pedestrians: 0 });
    assert.equal(
      world.command({ type: "destination", place }),
      true,
      place.name,
    );
    for (
      let tick = 0;
      tick < 7200 && world.metrics.completedTrips === 0;
      tick++
    ) {
      world.step();
      assert.notEqual(
        world.player.reason,
        "road-boundary",
        `${place.name} at ${world.tick}`,
      );
    }
    assert.equal(world.metrics.completedTrips, 1, place.name);
    assert.equal(world.player.speed, 0, `${place.name}: arrival speed`);
    assert.equal(
      world.player.reason,
      "arrived",
      `${place.name}: arrival state`,
    );
    assert.ok(world.player.parking, `${place.name}: parking bay`);
    assert.ok(
      Math.hypot(
        world.player.x - world.player.parking.x,
        world.player.z - world.player.parking.z,
      ) < 0.8,
      `${place.name}: final pose in bay`,
    );
    assert.deepEqual(world.audit(), []);
  }
});

test("a new trip can leave a parking bay without clipping the curb", () => {
  const world = new World({ traffic: 0, pedestrians: 0 });
  for (const place of [PLACES[0], PLACES[2]]) {
    assert.equal(world.command({ type: "destination", place }), true);
    const completed = world.metrics.completedTrips;
    for (
      let i = 0;
      i < 7200 && world.metrics.completedTrips === completed;
      i++
    ) {
      world.step();
      assert.notEqual(
        world.player.reason,
        "road-boundary",
        `tick ${world.tick}`,
      );
    }
    assert.equal(world.metrics.completedTrips, completed + 1);
    assert.equal(world.player.speed, 0);
    assert.deepEqual(world.audit(), []);
  }
});

test("30, 60 and 144 FPS produce the identical simulation state", () => {
  const outputs = [];
  for (const fps of [30, 60, 144]) {
    const world = new World({
      seed: "frame-partitions",
      traffic: 5,
      pedestrians: 6,
    });
    const clock = new FixedClock();
    world.command({ type: "destination", place: PLACES[1] });
    for (let frame = 0; frame < fps * 12; frame++)
      clock.advance(1 / fps, () => world.step());
    assert.equal(world.tick, 720);
    outputs.push(world.snapshot());
  }
  assert.deepEqual(outputs[0], outputs[1]);
  assert.deepEqual(outputs[0], outputs[2]);
});

test("a bounded render-frame catch-up budgets the work without dropping a brief delay", () => {
  const clock = new FixedClock();
  let ticks = 0;
  assert.equal(clock.advance(.1, () => ticks++, 3), 3);
  assert.equal(clock.alpha, 1);
  assert.equal(clock.advance(0, () => ticks++, 3), 3);
  assert.equal(clock.advance(1 / 60, () => ticks++, 3), 1);
  assert.equal(ticks, 7);
  assert.equal(clock.discardedSeconds, 0);
});

test("seed and recorded commands reproduce the complete resulting state", () => {
  const world = new World({
    seed: "replay-turn-and-brake",
    traffic: 4,
    pedestrians: 7,
  });
  world.command({ type: "drive", targetSpeed: 5, steer: 0 });
  for (let tick = 0; tick < 800; tick++) {
    if (tick === 120)
      world.command({ type: "drive", targetSpeed: 0, steer: 0.6 });
    if (tick === 300) world.command({ type: "destination", place: PLACES[0] });
    world.step();
  }
  world.command({ type: "mode", mode: "manual" });
  const replay = World.fromReplay(JSON.parse(JSON.stringify(world.replay())));
  assert.deepEqual(replay.snapshot(), world.snapshot());
  assert.notDeepEqual(
    new World({ seed: "different", traffic: 4, pedestrians: 7 }).snapshot()
      .actors,
    new World(world.config).snapshot().actors,
  );
});

test("cooperative replay yields without changing commands at slice or terminal ticks", () => {
  const world = new World({ seed: "cooperative-replay", traffic: 2, pedestrians: 1 });
  world.command({ type: "drive", targetSpeed: 3, steer: 0 });
  for (let i = 0; i < 13; i++) {
    if (i === 6) world.command({ type: "drive", targetSpeed: 0, steer: .1 });
    world.step();
  }
  world.command({ type: "mode", mode: "manual" });
  let ticks = 0;
  const reconstruction = World.reconstruct(world.replay(), () => ++ticks % 3 === 0);
  let current = reconstruction.next();
  const pauses = [];
  while (!current.done) {
    pauses.push(current.value.tick);
    current = reconstruction.next();
  }
  assert.deepEqual(pauses, [3, 6, 9, 12]);
  assert.deepEqual(current.value.snapshot(), world.snapshot());
});

test("dense traffic and pedestrians stay disjoint and keep making progress", () => {
  for (const config of [
    { seed: "cairo-42", traffic: 28, pedestrians: 32 },
    { seed: "stress-7", traffic: 72, pedestrians: 96, chaos: 1 },
  ]) {
    const world = new World(config);
    world.command({ type: "destination", place: PLACES[1] });
    assert.equal(world.capacity.traffic, config.traffic);
    assert.equal(world.capacity.pedestrians, config.pedestrians);
    for (
      let tick = 0;
      tick < 7200 && (tick < 3600 || !world.metrics.completedTrips);
      tick++
    ) {
      world.step();
      if (tick % 30 === 0)
        assert.deepEqual(
          world.audit(),
          [],
          `seed ${config.seed}, tick ${tick}`,
        );
    }
    const people = world.actors.filter((a) => a.type === "pedestrian");
    assert.ok(
      people.every((a) => a.distance > 10),
      "every pedestrian must get a chance to move",
    );
    assert.ok(
      world.metrics.trafficTrips > 8,
      "traffic must keep completing routes",
    );
    assert.ok(
      world.player.distance > 35,
      "player must make progress through traffic",
    );
    assert.equal(
      world.metrics.completedTrips,
      1,
      "the player's trip must finish through the seeded congestion",
    );
    assert.deepEqual(world.audit(), []);
  }
});

test("paused city state is untouched when the independent lab advances", () => {
  const city = new World({ traffic: 3, pedestrians: 3 });
  city.command({ type: "destination", place: PLACES[0] });
  for (let i = 0; i < 100; i++) city.step();
  const before = city.snapshot(),
    lab = new World({ traffic: 3, pedestrians: 3 }, "lab");
  for (let i = 0; i < 180; i++) lab.step();
  assert.deepEqual(city.snapshot(), before);
  assert.deepEqual(lab.audit(), []);
});

test("lab scenarios reserve empty space and replay both scheduled and manual events", () => {
  const world = new World(
    {
      seed: "lab-hazards",
      traffic: 8,
      pedestrians: 12,
      scenarioInterval: 3,
      difficulty: 5,
    },
    "lab",
  );
  world.command({ type: "destination", place: { x: 20, z: 40, name: "lab" } });
  for (let tick = 0; tick < 1200; tick++) {
    if (tick === 10) world.command({ type: "scenario", kind: "barrier" });
    if (tick === 90) world.command({ type: "scenario", kind: "crossing" });
    if (tick === 240) world.command({ type: "scenario", kind: "side-traffic" });
    world.step();
    if (tick % 20 === 0)
      assert.deepEqual(world.audit(), [], `lab tick ${tick}`);
  }
  assert.ok(world.metrics.scenarios >= 3);
  assert.deepEqual(
    World.fromReplay(world.replay()).snapshot(),
    world.snapshot(),
  );
});

test("malformed replay events fail before any simulation is started", () => {
  const replay = new World({ traffic: 0, pedestrians: 0 }).replay();
  assert.throws(() =>
    World.fromReplay({
      ...replay,
      events: [{ tick: -1, command: { type: "drive" } }],
    }),
  );
  assert.throws(() => World.fromReplay({ ...replay, environment: "unknown" }));
});

test("stop cancels the route and brakes through physics, and is replayable", () => {
  const world = new World({ traffic: 0, pedestrians: 0 });
  world.command({ type: "destination", place: PLACES[0] });
  for (let i = 0; i < 90; i++) world.step();
  const speed = world.player.speed;
  assert.ok(speed > 0);
  world.command({ type: "stop" });
  assert.equal(
    world.player.speed,
    speed,
    "a command must not teleport velocity",
  );
  assert.equal(world.mode, "manual");
  assert.equal(world.destination, null);
  assert.equal(world.player.path.length, 0);
  world.step();
  assert.ok(world.player.speed < speed);
  for (let i = 0; i < 120; i++) world.step();
  assert.equal(world.player.speed, 0);
  assert.deepEqual(world.audit(), []);
  assert.deepEqual(
    World.fromReplay(world.replay()).snapshot(),
    world.snapshot(),
  );
});
