import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { distance } from "../src/core/geometry.js";
import { CIVILIAN_MOTION_PREVIEW } from "../src/core/pursuit-gta.js";
import { gtaLineClear } from "../src/core/pursuit-response.js";
import { freezePursuitPolicy } from "../src/rl/pursuit-ppo.js";
import { resetPursuitEpisode } from "../src/rl/pursuit-rollouts.js";

const output = process.env.PROVE_IT_OUTPUT_DIR;
assert.ok(output, "Set a new proof output directory");
const checkpoint = await readFile(new URL(
  "../.runtime-proof/pursuit-rl-preview-policy-20261121/runs/fit/20261121T004347-f6c3fd04b9/checkpoint-1.json", import.meta.url));
const checkpointSha256 = createHash("sha256").update(checkpoint).digest("hex");
assert.equal(checkpointSha256, "052e656cd8354b700f47c4849686c966df3b16e4586b96dd7aa66022ef705ff3");
const policy = freezePursuitPolicy(JSON.parse(checkpoint));
const cases = [
  { seed: "city-route-dev-eval-01", level: 5, carId: "traffic-91", personId: "person-47", impactAt: 1249 },
  { seed: "city-route-dev-eval-00", level: 3, carId: "traffic-21", personId: "person-1", impactAt: 4642 },
];
const motion = a => ({ x: a.x, z: a.z, speed: a.speed, heading: a.heading, distanceM: a.distance, reason: a.reason,
  blockedBy: a.blockedBy ?? null, crossing: a.crossing, pattern: a.district?.pattern });

function run({ level, seed, carId, personId, impactAt }, civilianCrossingPreview) {
  const [traffic, pedestrians] = level === 5 ? [96, 144] : [36, 80];
  const { env, initial } = resetPursuitEpisode({ observation: policy.observation, wantedLevel: level,
    wantedLevelMax: level, patrols: level === 5 ? 12 : 7, traffic, pedestrians,
    civilianCrossingPreview, episodeSeconds: 120 }, seed);
  const { world } = env, { pursuit, player } = world;
  const original = world.actors.filter(a => a !== player && !pursuit.patrols.has(a)).map(a => [a, a.id, a.type]);
  assert.equal(original.filter(row => row[2] === "vehicle").length, traffic);
  assert.equal(original.filter(row => row[2] === "pedestrian").length, pedestrians);
  const car = world.actors.find(a => a.id === carId), person = world.actors.find(a => a.id === personId);
  assert.equal(car.type, "vehicle");
  assert.equal(person.type, "pedestrian");
  const start = { car: motion(car), person: motion(person) };
  const trace = [], pairHits = [], allPedestrianImpacts = [];
  let firstYield = null, resumed = null, peakPatrols = 0, retained = true;
  const limit = Math.ceil((impactAt + 720) / 6) * 6;
  const step = world.step;
  world.step = function () {
    const before = { car: motion(car), person: motion(person) };
    step.call(this);
    const live = new Set(world.actors.filter(a => a !== player && !pursuit.patrols.has(a)));
    retained &&= live.size === original.length && original.every(([a, id, type]) =>
      live.has(a) && a.id === id && a.type === type);
    for (const event of pursuit.stepEvents) {
      if (event.type !== "ambient_collision") continue;
      if (event.first.type === "pedestrian" || event.second.type === "pedestrian") allPedestrianImpacts.push(event);
      if ([event.first.id, event.second.id].includes(carId) &&
          [event.first.id, event.second.id].includes(personId)) pairHits.push(event);
    }
    if (world.tick < impactAt - 300) return;
    if (!firstYield && world.tick < impactAt && car.reason === "pedestrian-yield" && car.blockedBy === personId &&
        before.person.crossing === false && before.person.speed > .2 && car.speed < before.car.speed) {
      const dx = before.person.x - before.car.x, dz = before.person.z - before.car.z;
      if (gtaLineClear(world, before.car, dx, dz, Math.hypot(dx, dz)))
        firstYield = { tick: world.tick, rangeM: Math.hypot(dx, dz), before, car: motion(car) };
    }
    if (firstYield && !resumed && car.reason !== "pedestrian-yield" && car.speed > .6 &&
        car.distance - firstYield.car.distanceM > 2 && person.distance - firstYield.before.person.distanceM > 2) {
      resumed = { tick: world.tick, carM: car.distance - firstYield.car.distanceM,
        walkerM: person.distance - firstYield.before.person.distanceM, rangeM: distance(car, person) };
    }
    if (world.tick % 6 === 0)
      trace.push({ tick: world.tick, car: motion(car), person: motion(person), rangeM: distance(car, person) });
  };
  let obs = initial.obs;
  while (world.tick < limit && pursuit.phase === "running") {
    const result = env.step(policy.action(obs));
    obs = result.obs;
    peakPatrols = Math.max(peakPatrols, result.info.activePatrols);
  }
  return { civilianCrossingPreview, start, ticks: world.tick, limit, traffic, pedestrians, retained, peakPatrols,
    firstYield, resumed, pairHits, allPedestrianImpacts, egoContacts: pursuit.metrics.collisions, trace };
}

const report = { classification: "local paired City development cases, not a held-out score",
  checkpointSha256, node: process.version, v8: process.versions.v8, cases: [] };
for (const setup of cases) {
  const previous = run(setup, true), current = run(setup, CIVILIAN_MOTION_PREVIEW);
  const matched = JSON.stringify(previous.start) === JSON.stringify(current.start);
  const passed = matched && [previous, current].every(row => row.retained && row.ticks === row.limit && row.peakPatrols > 0) &&
    previous.pairHits[0]?.tick === setup.impactAt && previous.pairHits[0].closingSpeed > 1 &&
    current.egoContacts === 0 && current.pairHits.length === 0 && current.firstYield !== null && current.resumed !== null;
  report.cases.push({ setup, previous, current, matched, passed });
  console.log(JSON.stringify({ setup, matched, passed, previousHit: previous.pairHits[0] ?? null,
    newHits: current.pairHits, firstYield: current.firstYield, resumed: current.resumed,
    beforePedestrianImpacts: previous.allPedestrianImpacts.length, afterPedestrianImpacts: current.allPedestrianImpacts.length }));
}
report.bothYieldedAndContinued = report.cases.every(row => row.passed);
await writeFile(join(output, "civilian-motion.json"), JSON.stringify(report, null, 2), { flag: "wx" });
assert.ok(report.bothYieldedAndContinued, "The new profile did not prove both named physical yield-and-resume contrasts");
