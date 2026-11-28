import assert from "node:assert/strict";
import test from "node:test";
import { ObservedCorridorMemory } from "../src/rl/observed-corridor-memory.js";
import { PURSUIT_SCAN_TICKS } from "../src/signal_processing/pursuit-scanner.js";

function approach() {
  const memory = new ObservedCorridorMemory();
  const player = { x: -24, z: 0, heading: Math.PI / 2, width: 1.7 };
  let tick = 0;
  const accept = (x, recoveryTick, { goal = "same-road", age = 0, lag = 0, kind = "static" } = {}) => {
    tick += PURSUIT_SCAN_TICKS;
    player.x = x;
    memory.observe(player, {
      tick: tick - lag,
      tracks: [{ kind, ageS: age, forwardM: 4, rightM: 0.5 }],
    }, tick, goal, recoveryTick);
  };
  for (let x = -24; x < 0; x++) accept(x);
  return { player, memory, accept };
}

test("a repeated recovery with little accepted progress backtracks through previously driven space", () => {
  const { player, memory, accept } = approach();
  accept(0, 144);
  accept(-0.45, 144);
  accept(-0.8, 144);
  accept(-0.15);
  assert.equal(memory.target(player), null, "one recovery is not a repeated failure");
  accept(0.1, 174);

  const initialTarget = memory.target(player);
  assert.ok(initialTarget.x < -2 && initialTarget.x > -6 && initialTarget.z === 0);
  for (let x = -1; x >= -9; x--) accept(x);
  assert.ok(memory.target(player).x < initialTarget.x - 4, "physical movement advances the reverse prefix");
  for (let x = -10; x >= -18; x--) accept(x);
  assert.equal(memory.target(player), null, "the route stops after leaving the pocket");
  assert.equal(memory.pocket.left, true);
  for (let i = 0; i < 160; i++) accept(-18);
  assert.equal(memory.pocket, null, "the remembered obstruction is not permanent");
});

test("stale scans, stale obstacles, pedestrian yields and a new goal do not mark a previous corridor", () => {
  for (const control of [{ lag: 1 }, { age: 0.2 }, { kind: "pedestrian" }, { goal: "other-road" }]) {
    const { memory, player, accept } = approach();
    accept(0, 144);
    accept(-0.6, 144);
    accept(-0.1);
    accept(0.1, 168, control);
    assert.equal(memory.target(player), null);
    assert.equal(memory.pocket, null);
  }
});

test("recovery commands without accepted motion do not establish a loop", () => {
  const { memory, player, accept } = approach();
  accept(0, 144);
  accept(0, 144);
  accept(0, 162);
  assert.equal(memory.target(player), null);
  assert.equal(memory.pocket, null);
});
