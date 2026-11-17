import test from "node:test";
import assert from "node:assert/strict";
import {
  createPedestrianBody,
  setPedestrianMotionMode,
} from "../src/core/pedestrian-body.js";

test("body variation is repeatable without consuming RNG or mutating route state", () => {
  const person = Object.freeze({
    type: "pedestrian", kind: "woman-shirt", phase: 0.13, walkSpeed: 1.26,
    radius: 0.34, x: 10, z: 2, heading: 1, speed: 0.8,
    target: Object.freeze({ x: 10, z: 30 }),
    get rng() { throw new Error("Body setup must not read an RNG"); },
  });
  const random = Math.random;
  Math.random = () => { throw new Error("Body setup consumed randomness"); };
  try {
    const first = createPedestrianBody(person);
    assert.deepEqual(createPedestrianBody(person), first);
    assert.equal(first.walkSpeedMps, 1.26);
    assert.equal(person.radius, 0.34);
    assert.equal(person.speed, 0.8);
    assert.deepEqual(person.target, { x: 10, z: 30 });
    const taller = createPedestrianBody({
      kind: person.kind, phase: 0.87, walkSpeed: person.walkSpeed,
    });
    const otherKind = createPedestrianBody({
      kind: "man-jacket", phase: person.phase, walkSpeed: person.walkSpeed,
    });
    assert.ok(taller.heightM > first.heightM);
    assert.ok(taller.massKg > first.massKg);
    assert.ok(otherKind.widthM > first.widthM);
    assert.ok(otherKind.heightM > first.heightM);
  } finally {
    Math.random = random;
  }
});

test("body envelopes enclose the neutral clothed body with finite bounded profiles", () => {
  for (const kind of [
    "man-polo", "woman-shirt", "man-jacket", "woman-jacket",
    "male-longsleeve", "female-casual", "__proto__", null,
  ])
    for (const phase of [-Infinity, -100, 0, 0.5, 1, 100, NaN])
      for (const walkSpeed of [NaN, -100, 1.35, 2.35, Infinity]) {
        const body = createPedestrianBody({ kind, phase, walkSpeed });
        for (const value of Object.values(body)) assert.ok(Number.isFinite(value));
        assert.ok(body.heightM >= 1.55 && body.heightM <= 1.9);
        assert.ok(body.widthM > 0.4 && body.widthM < 0.7);
        assert.ok(body.depthM > 0.3 && body.depthM < 0.5);
        assert.ok(body.massKg > 45 && body.massKg < 100);
        assert.ok(body.radiusM * 2 >= Math.hypot(body.widthM, body.depthM));
        assert.ok(body.walkSpeedMps > 0 && body.walkSpeedMps <= 2.4);
        assert.ok(body.jogSpeedMps >= body.walkSpeedMps && body.jogSpeedMps <= 3.2);
      }
});

test("motion modes change only the requested mode and reject invalid or fixed-fixture controls", () => {
  const actor = {
    type: "pedestrian", x: 4, z: 5, heading: 0.3, speed: 1.2,
    distance: 18, target: { x: 4, z: 20 }, pause: 0.5,
    walkRoute: [{ x: 4, z: 10 }],
  };
  const before = structuredClone(actor);
  for (const mode of ["walk", "jog", "stop", "ambient"]) {
    assert.equal(setPedestrianMotionMode(actor, mode), true);
    assert.deepEqual(actor, { ...before, motionMode: mode });
  }
  for (const mode of ["run", "", null, { mode: "walk" }]) {
    assert.equal(setPedestrianMotionMode(actor, mode), false);
    assert.deepEqual(actor, { ...before, motionMode: "ambient" });
  }
  const fixed = {
    ...before, script: { type: "vision-linear", elapsedS: 0, velocity: { x: 0.9, z: 0 } },
  };
  const fixedBefore = structuredClone(fixed);
  assert.equal(setPedestrianMotionMode(fixed, "jog"), false);
  assert.deepEqual(fixed, fixedBefore);
  assert.equal(setPedestrianMotionMode({ type: "vehicle" }, "walk"), false);
  assert.equal(setPedestrianMotionMode(null, "stop"), false);
});
