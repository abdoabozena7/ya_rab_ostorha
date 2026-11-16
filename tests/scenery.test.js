import test from "node:test";
import assert from "node:assert/strict";
import { World } from "../src/core/world.js";
import { overlaps, pointOnRoad } from "../src/core/geometry.js";
import { PLACES } from "../src/core/places.js";

test("market stalls occupy real space behind the curb without blocking roads", () => {
  const world = new World({ traffic: 0, pedestrians: 0 });
  const stalls = world.statics.filter((site) => site.kind === "market-stall");
  assert.equal(stalls.length, 4);
  for (const stall of stalls) {
    assert.equal(pointOnRoad(stall, world.roads), false);
    assert.ok(
      !world.statics.some(
        (site) => site !== stall && overlaps(stall, site, 0.3),
      ),
    );
  }
  assert.deepEqual(world.audit(), []);
});

test("destination signs have physical posts outside the traffic lanes", () => {
  const world = new World({ traffic: 0, pedestrians: 0 });
  const signs = world.statics.filter((site) => site.kind === "place-sign");
  assert.deepEqual(
    signs.map((site) => site.placeId).sort(),
    PLACES.map((place) => place.id).sort(),
  );
  for (const sign of signs) {
    assert.equal(pointOnRoad(sign, world.roads), false);
    assert.ok(
      !world.statics.some(
        (site) => site !== sign && overlaps(sign, site, 0.25),
      ),
    );
  }
  assert.deepEqual(world.audit(), []);
});
