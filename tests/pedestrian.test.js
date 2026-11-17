import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { World } from "../src/core/world.js";
import { SpatialIndex } from "../src/core/spatial-index.js";
import { distance, angleDelta, sweepSafe, pointOnRoad } from "../src/core/geometry.js";
import { STEP } from "../src/core/config.js";
import { walkSegmentClear } from "../src/core/walk-route.js";
import { nextWalk } from "../src/core/pedestrian.js";
import {
  createPedestrianBody,
  setPedestrianMotionMode,
} from "../src/core/pedestrian-body.js";

function walkingFixture(overrides = {}) {
  const world = new World({ traffic: 0, pedestrians: 0, chaos: 0 });
  const p = {
    id: "body-walker", type: "pedestrian", kind: "man-polo",
    x: 13.75, z: 0, heading: 0, speed: 0, walkSpeed: 1.4,
    radius: 0.34, distance: 0, phase: 0.25, wait: 0,
    road: { axis: "z", fixed: 20, min: -1000, max: 1000, width: 10 },
    along: 0, side: 1, crossing: false, pause: 0,
    target: { x: 13.75, z: 300 },
    ...overrides,
  };
  p.body = createPedestrianBody(p);
  p.radius = p.body.radiusM;
  world.roads = [p.road];
  world.actors = [p];
  world.statics = [];
  world.staticIndex = new SpatialIndex();
  world.actorIndex = new SpatialIndex(world.actors);
  return { world, p };
}

function acceptedStep(world, p) {
  world.actorIndex = new SpatialIndex(world.actors);
  const previous = { ...p };
  const next = world.pedestrianMotion(p);
  const obstacles = world.actors.filter((actor) => actor !== p).concat(world.statics);
  const guard = sweepSafe(p, next, obstacles);
  assert.equal(guard.safe, true, `${p.id}: motion proposal penetrates ${guard.actor}`);
  const moved = distance(p, next);
  Object.assign(p, next, {
    previous,
    distance: p.distance + moved,
    motionTimeS: ++world.tick * STEP,
  });
  return { previous, moved };
}

function assertOrdinaryBounds(p, previous, moved) {
  const acceleration = (p.speed - previous.speed) / STEP;
  assert.ok(acceleration <= p.body.maxAccelerationMps2 + 1e-8, `${acceleration} acceleration`);
  assert.ok(acceleration >= -p.body.maxDecelerationMps2 - 1e-8, `${acceleration} deceleration`);
  assert.ok(Math.abs(angleDelta(p.heading, previous.heading)) <=
    p.body.maxTurnRateRadS * STEP + 1e-8);
  assert.ok(Math.abs(moved / STEP - p.speed) < 1e-8, "speed must describe accepted metres/second");
}

test("a pedestrian keeps a walking direction until the sidewalk ends", () => {
  const world = new World({ traffic: 0, pedestrians: 0, chaos: 0 });
  world.rng.next = () => 0.99;
  world.rng.range = (a, b) => (a + b) / 2;
  const person = {
    road: { axis: "z", fixed: 20, min: -100, max: 100, width: 10 },
    along: 0,
    side: 1,
    phase: 0.75,
  };
  const targets = [];
  for (let i = 0; i < 5; i++) {
    nextWalk(world, person);
    targets.push(person.target.z);
    person.along = person.target.z;
  }
  assert.deepEqual(targets, [30, 60, 90, 60, 30]);
});

test("pedestrians keep moving through a sidewalk waypoint without an artificial stop", () => {
  const world = new World({ traffic: 0, pedestrians: 0, chaos: 0 });
  world.rng.next = () => 0.99;
  world.rng.range = (a, b) => (a + b) / 2;
  const person = {
    id: "walker",
    type: "pedestrian",
    x: 13.75,
    z: 0,
    heading: 0,
    speed: 1,
    walkSpeed: 1.4,
    radius: 0.34,
    road: { axis: "z", fixed: 20, min: -100, max: 100, width: 10 },
    along: 0,
    side: 1,
    phase: 0.75,
    crossing: false,
    pause: 0,
    target: { x: 13.75, z: 0 },
  };
  world.actors = [person];
  world.actorIndex = new SpatialIndex(world.actors);
  const next = world.pedestrianMotion(person);
  assert.ok(next.speed > 0);
  assert.ok(next.z > person.z);
  assert.equal(next.reason, "walking");
});

test("pedestrians clear the two captured parked-car deadlocks without jitter or penetration", () => {
  const cases = JSON.parse(
    readFileSync(
      new URL("./fixtures/pedestrian-detours.json", import.meta.url),
    ),
  );
  for (const fixture of cases) {
    const world = new World({ traffic: 0, pedestrians: 0 });
    const p = structuredClone(fixture.person),
      start = { ...p };
    world.actors = [p, ...fixture.obstacles];
    world.statics = [];
    world.staticIndex = new SpatialIndex();
    let lastCheckpoint = { ...p },
      maxStillSeconds = 0,
      stillSeconds = 0;
    for (let tick = 0; tick < 1500; tick++) {
      world.tick = tick;
      world.actorIndex = new SpatialIndex(world.actors);
      const next = world.pedestrianMotion(p);
      assert.ok(Math.abs(angleDelta(next.heading, p.heading)) <= 3 / 60 + 1e-8);
      const guard = sweepSafe(p, next, fixture.obstacles);
      if (guard.safe) Object.assign(p, next);
      else {
        p.heading = next.heading;
        p.speed = 0;
      }
      assert.deepEqual(world.audit(), [], `${p.id} at ${tick}`);
      if (tick % 60 === 59) {
        stillSeconds = distance(p, lastCheckpoint) < 0.2 ? stillSeconds + 1 : 0;
        maxStillSeconds = Math.max(maxStillSeconds, stillSeconds);
        lastCheckpoint = { ...p };
      }
    }
    assert.ok(distance(p, start) > 4, p.id);
    assert.ok(
      maxStillSeconds < 5,
      `${p.id} must not oscillate beside the same obstacle`,
    );
  }
});

test("walking clearance catches a grazing corner between sweep samples", () => {
  const p = { id: "p", type: "pedestrian", radius: 0.34, x: -1, z: 1.5 };
  const obstacle = {
    id: "car",
    type: "vehicle",
    x: 0,
    z: 0,
    width: 1,
    length: 2,
    heading: 0,
  };
  assert.equal(walkSegmentClear(p, p, { x: 1, z: 1.1 }, [obstacle]), false);
  assert.equal(walkSegmentClear(p, p, { x: -3, z: 2 }, [obstacle]), true);
});

test("walk, jog and stop requests produce bounded actual motion and a settled stop", () => {
  const { world, p } = walkingFixture();
  for (const [mode, ticks] of [["walk", 90], ["jog", 120], ["stop", 120]]) {
    const target = structuredClone(p.target);
    setPedestrianMotionMode(p, mode);
    const beforeDistance = p.distance;
    for (let tick = 0; tick < ticks; tick++) {
      const { previous, moved } = acceptedStep(world, p);
      assertOrdinaryBounds(p, previous, moved);
    }
    if (mode === "walk") assert.ok(Math.abs(p.speed - 1.4) < 1e-8);
    if (mode === "jog") assert.ok(p.speed > 2.4 && p.distance > beforeDistance + 3);
    if (mode === "stop") {
      assert.equal(p.speed, 0);
      assert.ok(p.distance > beforeDistance, "stopping must brake physically, not teleport to rest");
      assert.deepEqual(p.target, target);
      const settled = { x: p.x, z: p.z, heading: p.heading, distance: p.distance };
      for (let tick = 0; tick < 60; tick++) acceptedStep(world, p);
      assert.deepEqual(
        { x: p.x, z: p.z, heading: p.heading, distance: p.distance },
        settled,
      );
    }
  }
});

test("turning, ordinary waiting and looking decelerate within the body bound", () => {
  for (const overrides of [
    { heading: Math.PI, speed: 1.6 },
    { pause: 1, speed: 1.6 },
  ]) {
    const { world, p } = walkingFixture(overrides);
    for (let tick = 0; tick < 90; tick++) {
      const { previous, moved } = acceptedStep(world, p);
      assertOrdinaryBounds(p, previous, moved);
    }
  }
  const { world, p } = walkingFixture({
    heading: Math.PI / 2, speed: 2.7, crossing: true,
    target: { x: 26.25, z: 0 },
  });
  world.actors.push({
    id: "approaching", type: "vehicle", x: 20, z: -4,
    heading: 0, speed: 4, width: 1.85, length: 4.2,
  });
  for (let tick = 0; tick < 120; tick++) {
    const { previous, moved } = acceptedStep(world, p);
    assertOrdinaryBounds(p, previous, moved);
    assert.equal(pointOnRoad(p, world.roads), false, "braking must finish before the carriageway");
  }
  assert.equal(p.speed, 0);
  assert.equal(p.reason, "looking");
});

test("ambient crossing speed uses the current scenario walkSpeed rather than the frozen body baseline", () => {
  const { world, p } = walkingFixture({ walkSpeed: 1.1 });
  const body = p.body;
  p.walkSpeed = 2.35;
  p.crossing = true;
  for (let tick = 0; tick < 120; tick++) {
    const { previous, moved } = acceptedStep(world, p);
    assertOrdinaryBounds(p, previous, moved);
  }
  assert.equal(p.body, body);
  assert.ok(Math.abs(p.speed - 2.35) < 1e-8);
});

test("only an actually blocked displacement permits an immediate pedestrian safety stop", () => {
  const { world, p } = walkingFixture({ speed: 2.8 });
  const barrier = {
    id: "body-wall", type: "static", x: p.x, z: 0.5,
    width: 10, length: 0.04, heading: 0,
  };
  world.statics = [barrier];
  world.staticIndex = new SpatialIndex([barrier]);
  const { moved } = acceptedStep(world, p);
  assert.equal(moved, 0);
  assert.equal(p.speed, 0);
  assert.equal(p.reason, "blocked");
  assert.equal(p.distance, 0, "a rejected displacement must not advance gait distance");
});

test("identical mode commands replay identical accepted movement, including stationary ticks", () => {
  const replay = () => {
    const { world, p } = walkingFixture();
    const commands = new Map([[0, "walk"], [90, "jog"], [200, "stop"], [280, "ambient"]]);
    const states = [];
    for (let tick = 0; tick < 420; tick++) {
      if (commands.has(tick)) setPedestrianMotionMode(p, commands.get(tick));
      acceptedStep(world, p);
      states.push({
        x: p.x, z: p.z, heading: p.heading, speed: p.speed,
        distance: p.distance, mode: p.motionMode,
      });
    }
    assert.equal(states[260].speed, 0);
    assert.deepEqual(states[260], states[279]);
    assert.ok(states[180].speed > states[80].speed);
    assert.ok(states[419].distance > states[279].distance);
    return states;
  };
  assert.deepEqual(replay(), replay());
});
