import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { World } from "../src/core/world.js";
import { SpatialIndex } from "../src/core/spatial-index.js";
import { distance, angleDelta, sweepSafe } from "../src/core/geometry.js";
import { walkSegmentClear } from "../src/core/walk-route.js";
import { nextWalk } from "../src/core/pedestrian.js";

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
