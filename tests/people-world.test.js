import test from "node:test";
import assert from "node:assert/strict";
import { World } from "../src/core/world.js";

test("public human motion commands record actual actor identity and replay accepted poses", () => {
  const world = new World({ seed: "people-replay", traffic: 0, pedestrians: 6 });
  const person = world.actors.find((actor) => actor.type === "pedestrian");
  assert.ok(person.body);
  for (const [mode, ticks] of [["stop", 90], ["walk", 180], ["jog", 180], ["ambient", 90]]) {
    assert.equal(world.command({ type: "pedestrian-motion", id: person.id, mode }), true);
    for (let i = 0; i < ticks; i++) {
      world.step();
      assert.deepEqual(world.audit(), []);
    }
  }
  const replay = world.replay();
  assert.deepEqual(replay.events.filter((event) => event.command.type === "pedestrian-motion")
    .map((event) => event.command.mode), ["stop", "walk", "jog", "ambient"]);
  const restored = World.fromReplay(replay);
  assert.deepEqual(restored.snapshot(), world.snapshot());
  const snapshot = world.snapshot().actors.find((actor) => actor.id === person.id);
  assert.equal(snapshot.motionMode, "ambient");
  assert.ok(snapshot.body.heightM > 1.4 && snapshot.body.heightM < 2.1);
  assert.ok(Number.isFinite(snapshot.accelerationMps2));
});

test("invalid or truth-bearing motion requests cannot mutate actors or the replay ledger", () => {
  const world = new World({ traffic: 0, pedestrians: 1 });
  const person = world.actors.find((actor) => actor.type === "pedestrian");
  const initial = world.snapshot(), events = world.events.length;
  for (const command of [
    { type: "pedestrian-motion", id: person.id, mode: "teleport" },
    { type: "pedestrian-motion", id: "missing-person", mode: "walk" },
    { type: "pedestrian-motion", id: "player", mode: "walk" },
    { type: "pedestrian-motion", id: person.id, mode: "walk", willCross: true },
  ]) {
    assert.throws(() => world.command(command));
    assert.deepEqual(world.snapshot(), initial);
    assert.equal(world.events.length, events);
  }
});

test("fixed Vision actors keep their existing dimensions and reject reference motion controls", () => {
  const world = new World({ visionCase: "cross-left" }, "vision");
  const person = world.actors.find((actor) => actor.type === "pedestrian");
  const initial = world.snapshot();
  assert.equal(person.radius, 0.34);
  assert.equal(person.body.heightM, 1.78);
  assert.throws(() => world.command({ type: "pedestrian-motion", id: person.id, mode: "jog" }));
  assert.deepEqual(world.snapshot(), initial);
  world.command({ type: "vision-run" });
  for (let i = 0; i < 180; i++) world.step();
  assert.ok(Math.abs(person.x - (-4.8 + (3 - 0.65) * 0.9)) < 0.016,
    "A reference-body feature cannot silently change the original physical camera oracle");
});
