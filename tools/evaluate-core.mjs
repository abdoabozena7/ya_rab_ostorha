import { World } from "../src/core/world.js";
import { PLACES } from "../src/core/places.js";
import { mkdir, writeFile } from "node:fs/promises";

const cases = [
  {
    seed: "cairo-42",
    traffic: 28,
    pedestrians: 32,
    seconds: 120,
    destination: "market",
  },
  {
    seed: "dense-11",
    traffic: 28,
    pedestrians: 32,
    seconds: 120,
    destination: "hospital",
  },
  {
    seed: "crossings-31",
    traffic: 28,
    pedestrians: 32,
    seconds: 120,
    destination: "station",
  },
  {
    seed: "stress-7",
    traffic: 72,
    pedestrians: 96,
    chaos: 1,
    seconds: 120,
    destination: "market",
  },
];
const results = [];
for (const scenario of cases) {
  const world = new World(scenario),
    violations = new Set();
  world.command({
    type: "destination",
    place: PLACES.find((place) => place.id === scenario.destination),
  });
  const started = performance.now();
  let arrivalTick = null,
    peakVehicleWait = 0,
    blockingCycleTicks = 0;
  for (let i = 0; i < scenario.seconds * 60; i++) {
    world.step();
    if (world.metrics.trafficBlockingCycles) blockingCycleTicks++;
    if (arrivalTick === null && world.metrics.completedTrips)
      arrivalTick = world.tick;
    if (i % 60 === 0)
      peakVehicleWait = Math.max(
        peakVehicleWait,
        ...world.actors
          .filter((a) => a.type === "vehicle" && a !== world.player)
          .map((a) => a.wait),
      );
    for (const error of world.audit()) violations.add(`${i}:${error}`);
  }
  const result = {
    scenario,
    capacity: world.capacity,
    ticks: world.tick,
    wallSeconds: (performance.now() - started) / 1000,
    metrics: world.metrics,
    arrivalTick,
    peakVehicleWait,
    blockingCycleTicks,
    violations: [...violations],
    stopped: world.actors
      .filter((a) => a.wait > 20 && !(a === world.player && !a.path.length))
      .map((a) => ({
        id: a.id,
        reason: a.reason,
        blockedBy: a.blockedBy,
        wait: a.wait,
        distance: a.distance,
        x: a.x,
        z: a.z,
      })),
    minPedestrianDistance: Math.min(
      ...world.actors
        .filter((a) => a.type === "pedestrian")
        .map((a) => a.distance),
    ),
  };
  results.push(result);
  console.log(JSON.stringify(result));
}
await mkdir("output", { recursive: true });
await writeFile(
  "output/core-evaluation.json",
  JSON.stringify({ createdAt: new Date().toISOString(), results }, null, 2),
);
if (results.some((r) => r.violations.length || !r.metrics.completedTrips))
  process.exitCode = 1;
