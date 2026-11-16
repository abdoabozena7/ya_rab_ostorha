import test from "node:test";
import assert from "node:assert/strict";
import { World } from "../src/core/world.js";
import {
  policyObservation,
  policyAction,
  policySpeed,
  validatePolicy,
} from "../src/core/policy.js";

const weights = {
  schemaVersion: 1,
  algorithm: "tabular-q-learning",
  id: "test-policy",
  q: { "clear:clear:slow": [4, 2, 1, 0] },
};

test("policy weights select a bounded speed and remain replayable", () => {
  const world = new World(
    { seed: "policy-test", traffic: 0, pedestrians: 0 },
    "lab",
  );
  assert.equal(policyObservation(world, world.player), "clear:clear:slow");
  assert.equal(policyAction(weights, "clear:clear:slow"), 0);
  assert.equal(policyAction(weights, "unseen"), 3);
  world.command({ type: "policy", weights });
  world.command({ type: "destination", place: { x: 20, z: 40 } });
  assert.equal(
    policySpeed(world, world.player, world.player.maxSpeed),
    world.player.maxSpeed * 0.35,
  );
  for (let i = 0; i < 120; i++) world.step();
  const restored = World.fromReplay(world.replay());
  assert.equal(restored.player.x, world.player.x);
  assert.equal(restored.player.z, world.player.z);
  assert.equal(restored.policy.id, "test-policy");
  assert.deepEqual(world.audit(), []);
});

test("invalid or excessive policy values are rejected", () => {
  assert.throws(() =>
    validatePolicy({
      ...weights,
      q: { "clear:clear:slow": [0, 0, Infinity, 0] },
    }),
  );
  assert.throws(() =>
    validatePolicy({ ...weights, q: { "unexpected-key": [0, 0, 0, 0] } }),
  );
});
