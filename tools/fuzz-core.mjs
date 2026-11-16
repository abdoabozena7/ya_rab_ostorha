// Deterministic extra seeds outside the four regression scenarios.
// Audit every simulated step and retain the first concrete failure.
import { World } from "../src/core/world.js";
import { PLACES } from "../src/core/places.js";
import { mkdir, writeFile } from "node:fs/promises";

const cases = [
  ["fuzz-a-1", 36, 48, 0.7, "hospital", 100],
  ["fuzz-b-2", 20, 64, 1, "market", 100],
  ["fuzz-c-3", 40, 24, 0.2, "university", 100],
  ["fuzz-d-4", 12, 80, 1, "station", 100],
  ["fuzz-e-5", 48, 72, 1, "corniche", 100],
  ["fuzz-f-6", 28, 32, 0, "downtown", 100],
  ["fuzz-g-7", 72, 96, 1, "hospital", 60],
  ["fuzz-h-8", 72, 96, 0.3, "university", 60],
];
const selected = process.argv[2];
if (selected && !cases.some(([seed]) => seed === selected))
  throw new Error(`Unknown seed: ${selected}`);
const results = [];
for (const [seed, traffic, pedestrians, chaos, placeId, seconds] of cases.filter(
  ([seed]) => !selected || seed === selected,
)) {
  const world = new World({ seed, traffic, pedestrians, chaos });
  const destination = PLACES.find((place) => place.id === placeId);
  const routeFound = world.command({ type: "destination", place: destination });
  const started = performance.now();
  let failure = null;
  let arrivalTick = null;
  let peakVehicleWait = 0;
  for (let step = 0; step < seconds * 60; step++) {
    world.step();
    if (arrivalTick === null && world.metrics.completedTrips)
      arrivalTick = world.tick;
    if (step % 60 === 0)
      peakVehicleWait = Math.max(
        peakVehicleWait,
        ...world.actors
          .filter((a) => a.type === "vehicle" && a !== world.player)
          .map((a) => a.wait),
      );
    const errors = world.audit();
    if (errors.length) {
      failure = { tick: world.tick, errors: errors.slice(0, 10) };
      break;
    }
  }
  const result = {
    seed,
    config: world.config,
    destination: placeId,
    routeFound,
    ticks: world.tick,
    wallSeconds: (performance.now() - started) / 1000,
    arrivalTick,
    completedTrips: world.metrics.completedTrips,
    trafficTrips: world.metrics.trafficTrips,
    peakVehicleWait,
    stoppedOver20s: world.actors.filter(
      (actor) => actor.type === "vehicle" && actor !== world.player && actor.wait > 20,
    ).length,
    longestStops: world.actors
      .filter((actor) => actor.type === "vehicle" && actor !== world.player)
      .sort((a, b) => b.wait - a.wait)
      .slice(0, 8)
      .map((actor) => ({
        id: actor.id,
        wait: actor.wait,
        reason: actor.reason,
        blockedBy: actor.blockedBy ?? null,
        x: actor.x,
        z: actor.z,
      })),
    failure,
  };
  results.push(result);
  console.log(JSON.stringify(result));
}
await mkdir("output", { recursive: true });
await writeFile(
  selected ? `output/fuzz-${selected}.json` : "output/fuzz-core.json",
  JSON.stringify({ createdAt: new Date().toISOString(), results }, null, 2),
);
if (results.some((result) => !result.routeFound || result.failure))
  process.exitCode = 1;
