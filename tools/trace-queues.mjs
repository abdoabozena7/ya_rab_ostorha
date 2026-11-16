import { World } from "../src/core/world.js";
import { PLACES } from "../src/core/places.js";
import { stoppedVehicleCycles } from "../src/core/queue-metrics.js";
import { signalSpeedLimit } from "../src/core/signals.js";
import { mkdir, writeFile } from "node:fs/promises";

const [
  seed = "stress-7",
  traffic = "72",
  pedestrians = "96",
  seconds = "120",
  chaos = "1",
  destination = "market",
] = process.argv.slice(2);
const world = new World({
  seed,
  traffic: Number(traffic),
  pedestrians: Number(pedestrians),
  chaos: Number(chaos),
});
world.command({
  type: "destination",
  place: PLACES.find((place) => place.id === destination),
});

function describe(car) {
  const group = world.junctionGroups.find(
    (candidate) => candidate.key === car.queuedJunction,
  );
  return {
    id: car.id,
    position: [Number(car.x.toFixed(2)), Number(car.z.toFixed(2))],
    heading: Number(car.heading.toFixed(2)),
    speed: Number(car.speed.toFixed(2)),
    wait: Number(car.wait.toFixed(2)),
    reason: car.reason,
    blockedBy: car.blockedBy,
    route: `${car.cursor}/${car.path.length}`,
    junction: group?.members.map((member) => [member.x, member.z]) ?? null,
    junctionArrival: car.junctionArrival ?? null,
    corridorSamples:
      world.junctionCorridors?.get(`${car.queuedJunction}:${car.id}`)?.samples
        .length ?? null,
    owners: (world.junctionOwners.get(car.queuedJunction) ?? []).map(
      ({ id, since, entered }) => ({ id, since, entered }),
    ),
    holding: [...world.junctionOwners.entries()]
      .filter(([, owners]) => owners.some((owner) => owner.id === car.id))
      .map(([key]) => key),
  };
}

function chain(start, cars) {
  const seen = new Set();
  const path = [];
  let car = start;
  while (car && !seen.has(car.id) && path.length < 12) {
    seen.add(car.id);
    path.push(describe(car));
    car = cars.get(car.blockedBy);
  }
  if (car) path.push({ cycle: car.id });
  return path;
}

const samples = [];
const cycleEpisodes = [];
let activeCycle = null;
const thresholds = [10, 20, 30, 40, 50];
for (let tick = 0; tick < Number(seconds) * 60; tick++) {
  world.step();
  if (world.metrics.trafficBlockingCycles) {
    if (!activeCycle) {
      const byId = new Map(world.actors.map((actor) => [actor.id, actor]));
      activeCycle = {
        startedTick: world.tick,
        actors: stoppedVehicleCycles(
          world.actors,
          (actor) => signalSpeedLimit(world, actor) === Infinity,
        ).map((ids) => ids.map((id) => describe(byId.get(id)))),
      };
    }
  } else if (activeCycle) {
    activeCycle.endedTick = world.tick;
    cycleEpisodes.push(activeCycle);
    activeCycle = null;
  }
  if (world.tick % 60 !== 0) continue;
  const cars = world.actors.filter(
    (actor) => actor.type === "vehicle" && actor !== world.player,
  );
  const worst = [...cars].sort((a, b) => b.wait - a.wait)[0];
  if (thresholds.length && worst.wait >= thresholds[0]) {
    thresholds.shift();
    const byId = new Map(cars.map((car) => [car.id, car]));
    samples.push({
      tick: world.tick,
      worst: describe(worst),
      chain: chain(worst, byId),
      stopped: cars.filter((car) => car.wait > 10).map(describe),
    });
  }
}
const cars = world.actors.filter(
  (actor) => actor.type === "vehicle" && actor !== world.player,
);
const byId = new Map(cars.map((car) => [car.id, car]));
if (activeCycle) {
  activeCycle.endedTick = world.tick;
  cycleEpisodes.push(activeCycle);
}
const report = {
  config: world.config,
  ticks: world.tick,
  metrics: world.metrics,
  samples,
  cycleEpisodes,
  ending: [...cars]
    .sort((a, b) => b.wait - a.wait)
    .slice(0, 10)
    .map((car) => chain(car, byId)),
  violations: world.audit(),
};
await mkdir("output", { recursive: true });
const path = `output/queue-trace-${seed}.json`;
await writeFile(path, JSON.stringify(report, null, 2));
console.log(
  JSON.stringify({
    path,
    samples: samples.map(({ tick, worst }) => ({ tick, worst })),
    cycleEpisodes,
    ending: report.ending.map((entry) => entry[0]),
    violations: report.violations,
  }),
);
