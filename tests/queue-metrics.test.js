import test from "node:test";
import assert from "node:assert/strict";
import {
  stoppedVehicleCycles,
  trafficQueueStats,
} from "../src/core/queue-metrics.js";

test("queue diagnostics separate moving leaders from closed stopped cycles", () => {
  const actors = [
    { id: "player", type: "vehicle", speed: 0, wait: 60 },
    { id: "a", type: "vehicle", speed: 0, wait: 21, blockedBy: "b" },
    { id: "b", type: "vehicle", speed: 3, wait: 0, blockedBy: null },
    { id: "c", type: "vehicle", speed: 0, wait: 8, blockedBy: "d" },
    { id: "d", type: "vehicle", speed: 0, wait: 9, blockedBy: "c" },
    { id: "person", type: "pedestrian", speed: 0, wait: 90 },
  ];
  assert.deepEqual(trafficQueueStats(actors), {
    trafficStoppedOver5: 3,
    trafficStoppedOver20: 1,
    longestCurrentTrafficWait: 21,
    trafficBlockingCycles: 1,
  });
  assert.deepEqual(stoppedVehicleCycles(actors), [["c", "d"]]);
  assert.deepEqual(
    stoppedVehicleCycles(actors, (actor) => actor.id !== "d"),
    [],
  );
  assert.equal(
    trafficQueueStats(actors, (actor) => actor.id !== "d")
      .trafficBlockingCycles,
    0,
  );
  actors[4].speed = 0.2;
  assert.equal(trafficQueueStats(actors).trafficBlockingCycles, 0);
});
