import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { World } from "../src/core/world.js";
import { Random } from "../src/core/random.js";
import {
  policyObservation,
  policyAction,
  POLICY_VERSION,
  SPEED_ACTIONS,
  validatePolicy,
} from "../src/core/policy.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(ROOT, process.argv[2] ?? "output/policy-lab.json");
const trainEpisodes = Number(process.argv[3] ?? 24);
const evalEpisodes = Number(process.argv[4] ?? 6);
const resume = process.argv.includes("--resume");
if (
  !Number.isInteger(trainEpisodes) ||
  trainEpisodes < 1 ||
  trainEpisodes > 1000 ||
  !Number.isInteger(evalEpisodes) ||
  evalEpisodes < 1 ||
  evalEpisodes > 100
)
  throw new Error(
    "Usage: node tools/train-policy.mjs [output.json] [train episodes] [evaluation episodes] [--resume]",
  );

let weights;
if (resume)
  weights = validatePolicy(JSON.parse(await readFile(output, "utf8")));
else
  weights = {
    schemaVersion: POLICY_VERSION,
    algorithm: "tabular-q-learning",
    id: "lab-speed-v1",
    actions: [...SPEED_ACTIONS],
    observation: "forward obstacle range, kind and ego speed",
    episodes: 0,
    q: {},
  };
const rng = new Random(`policy-training:${weights.episodes}`);
const options = (seed) => ({
  seed,
  traffic: 8,
  pedestrians: 12,
  chaos: 0.7,
  difficulty: 3,
  scenarioInterval: 7,
});
const goal = { id: "lab-north", name: "شمال الأوضة", x: 20, z: 40 };
async function checkpoint() {
  await mkdir(dirname(output), { recursive: true });
  const temporary = `${output}.tmp`;
  await writeFile(temporary, JSON.stringify(weights, null, 2) + "\n");
  await rename(temporary, output);
}

function episode(seed, select, learn = null) {
  const world = new World(options(seed), "lab");
  if (!world.command({ type: "destination", place: goal }))
    throw new Error(`No lab route for ${seed}`);
  let violations = 0;
  let decisions = 0;
  for (let t = 0; t < 60 * 60 && world.metrics.completedTrips === 0; t += 30) {
    const state = policyObservation(world, world.player);
    const action = select(state, decisions++);
    world.policyActionOverride = action;
    const distanceBefore = world.metrics.distance;
    const waitBefore = world.metrics.waitSeconds;
    const interventionsBefore = world.metrics.interventions;
    for (let j = 0; j < 30 && world.metrics.completedTrips === 0; j++) {
      world.step();
      violations += world.audit().length;
    }
    const reward =
      (world.metrics.distance - distanceBefore) * 0.2 -
      (world.metrics.waitSeconds - waitBefore) * 0.05 -
      (world.metrics.interventions - interventionsBefore) * 5 -
      0.5 +
      (world.metrics.completedTrips ? 10 : 0) -
      violations * 20;
    if (learn)
      learn(
        state,
        action,
        reward,
        policyObservation(world, world.player),
        world.metrics.completedTrips > 0,
      );
  }
  return {
    seed,
    arrived: world.metrics.completedTrips > 0,
    seconds: Math.round((world.tick / 60) * 100) / 100,
    distanceM: Math.round(world.metrics.distance * 100) / 100,
    waitS: Math.round(world.metrics.waitSeconds * 100) / 100,
    interventions: world.metrics.interventions,
    violations,
  };
}
const row = (state) => (weights.q[state] ??= SPEED_ACTIONS.map(() => 0));
const firstEpisode = weights.episodes;
for (let i = 0; i < trainEpisodes; i++) {
  const episodeNumber = firstEpisode + i;
  const epsilon = Math.max(0.08, 0.55 * Math.exp(-episodeNumber / 28));
  const sample = episode(
    `train-${episodeNumber}`,
    (state) =>
      rng.next() < epsilon
        ? Math.floor(rng.next() * SPEED_ACTIONS.length)
        : policyAction(weights, state),
    (state, action, reward, next, done) => {
      const current = row(state);
      const future = done ? 0 : Math.max(...row(next));
      current[action] += 0.18 * (reward + 0.92 * future - current[action]);
    },
  );
  console.log(
    `train ${episodeNumber + 1}: ${sample.arrived ? "arrived" : "timeout"}, ${sample.seconds}s, wait ${sample.waitS}s, interventions ${sample.interventions}, violations ${sample.violations}`,
  );
  weights.episodes = episodeNumber + 1;
  await checkpoint();
}

const cases = [];
for (let i = 0; i < evalEpisodes; i++) {
  const seed = `evaluation-${weights.episodes}-${i}`;
  cases.push({
    seed,
    baseline: episode(seed, () => SPEED_ACTIONS.length - 1),
    trained: episode(seed, (state) => policyAction(weights, state)),
  });
}
const mean = (key, side) =>
  cases.reduce((sum, c) => sum + c[side][key], 0) / cases.length;
const report = {
  policy: output,
  trainEpisodes: weights.episodes,
  evaluationSeeds: cases.length,
  baseline: {
    arrivals: cases.filter((c) => c.baseline.arrived).length,
    ...Object.fromEntries(
      ["seconds", "waitS", "interventions", "violations"].map((key) => [
        key,
        mean(key, "baseline"),
      ]),
    ),
  },
  trained: {
    arrivals: cases.filter((c) => c.trained.arrived).length,
    ...Object.fromEntries(
      ["seconds", "waitS", "interventions", "violations"].map((key) => [
        key,
        mean(key, "trained"),
      ]),
    ),
  },
  cases,
};
const reportPath = output.replace(/\.json$/, "-evaluation.json");
await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
console.log(
  JSON.stringify(
    {
      weights: output,
      report: reportPath,
      baseline: report.baseline,
      trained: report.trained,
    },
    null,
    2,
  ),
);
