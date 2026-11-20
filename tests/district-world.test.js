import test from "node:test";
import assert from "node:assert/strict";
import { World } from "../src/core/world.js";
import { createReplayBlob, readReplayFile } from "../src/ui/replay-file.js";

test("district keeps actual configured population and rejects unsupported layout or encounter identifiers", () => {
  const world = new World({ seed: "district-dev-a" }, "egypt");
  assert.equal(world.actors.filter((actor) => actor.type === "vehicle" && actor !== world.player).length, 28);
  assert.equal(world.actors.filter((actor) => actor.type === "pedestrian").length, 32);
  assert.equal(world.config.districtVersion, 1);
  assert.deepEqual(world.audit(), []);
  assert.throws(() => new World({ districtVersion: 999 }, "egypt"), /version/i);
  assert.throws(() => new World({ districtCase: "not-an-authored-case" }, "egypt"), /case|encounter/i);
});

test("district commands and accepted behavior reconstruct through the file round trip", async () => {
  const world = new World({ seed: "district-dev-b" }, "egypt");
  world.command({ type: "visual-mode", mode: "sensors-only" });
  world.command({ type: "destination", place: world.district.places[0] });
  for (let i = 0; i < 180; i++) {
    world.step();
    assert.deepEqual(world.audit(), []);
  }
  const replay = world.replay();
  assert.equal(replay.environment, "egypt");
  assert.equal(replay.config.districtVersion, 1);
  const restored = World.fromReplay(await readReplayFile(createReplayBlob(replay)));
  assert.deepEqual(restored.snapshot(), world.snapshot());
});

test("the district can reload a long command history without admitting oversized legacy replays", async () => {
  const world = new World({ traffic: 0, pedestrians: 0 }, "egypt");
  const replay = {
    ...world.replay(),
    totalTicks: 30_000,
    events: Array.from({ length: 30_000 }, (_, tick) => ({
      tick, command: { type: "drive", targetSpeed: tick % 2, steer: 0 },
    })),
  };
  const district = createReplayBlob(replay);
  assert.ok(district.size > 2_000_000, "The fixture must exercise the old import failure");
  assert.deepEqual(await readReplayFile(district), replay);
  const legacy = createReplayBlob({ ...replay, environment: "city" });
  await assert.rejects(readReplayFile(legacy), /too large/);
  await assert.rejects(readReplayFile({
    size: 16_000_001,
    text: () => assert.fail("Do not read a file past the absolute limit"),
  }), /too large/);
});

test("an isolated district encounter waits for its recorded public run event and cannot be retargeted as an ordinary person", () => {
  const world = new World({ seed: "district-dev-a", districtCase: "visible-left" }, "egypt");
  assert.equal(world.districtCase.phase, "ready");
  world.step();
  assert.equal(world.tick, 0);
  const person = world.actors.find((actor) => actor.type === "pedestrian");
  assert.ok(person);
  assert.throws(() => world.command({ type: "pedestrian-motion", id: person.id, mode: "jog" }));
  world.command({ type: "visual-mode", mode: "sensors-only" });
  world.command({ type: "district-run" });
  for (let i = 0; i < 120; i++) world.step();
  assert.equal(world.tick, 120);
  assert.deepEqual(World.fromReplay(world.replay()).snapshot(), world.snapshot());
});

test("a failed bounded encounter actually brakes instead of continuing its autonomous path", () => {
  const world = new World({ seed: "district-dev-a", districtCase: "blind-corner-empty" }, "egypt");
  world.command({ type: "visual-mode", mode: "sensors-only" });
  world.command({ type: "district-run" });
  for (let i = 0; i < 90; i++) world.step();
  const speed = world.player.speed;
  assert.ok(speed > .1, "The failure path must start from actual moving physics");
  world.districtCase.error = "Bounded encounter failed";
  world.step();
  assert.ok(world.player.speed < speed);
  assert.equal(world.player.districtSources.requestedMps, 0);
  for (let i = 0; i < 120; i++) world.step();
  assert.equal(world.player.speed, 0);
  assert.deepEqual(world.audit(), []);
});
