import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Random } from "../src/core/random.js";
import { MEASURED_QUEUE_DETOUR } from "../src/rl/pako-measured-detour.js";
import { freezePursuitPolicy, PursuitPpo } from "../src/rl/pursuit-ppo.js";
import { isDispatchIncident, joinPursuitRollout, runPursuitEpisode } from "../src/rl/pursuit-rollouts.js";

const output = process.env.PROVE_IT_OUTPUT_DIR;
assert.ok(output, "Use a new PROVE_IT_OUTPUT_DIR for the measured City continuation");
const read = path => readFileSync(new URL(path, import.meta.url));
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const priorBytes = read("../.runtime-proof/pursuit-rl-dense-learning-20261120/corrective-trial-20261120-221352/checkpoint-1.json");
const priorSha256 = sha(priorBytes);
assert.equal(priorSha256, "854b284350457717cd2c299a0dc86604f2600ed989c1c9aac7ff497d0e5181e3");
const prior = JSON.parse(priorBytes);
const predecessor = freezePursuitPolicy(prior);
const curriculum = JSON.parse(read("../config/pursuit-rl-city-route-development.json"));
const on = MEASURED_QUEUE_DETOUR;
const [standard, dense] = ["city-clearance", "city-clearance-dense"].map(id =>
  ({ ...curriculum.stages.find(stage => stage.id === id), episodeSeconds: 120 }));
const fit = [
  { stage: standard, seed: "city-route-train-01" },
  { stage: dense, seed: "city-route-train-02" },
];
const validation = [
  { stage: standard, seed: "city-route-dev-eval-01" },
  { stage: dense, seed: "city-route-dev-eval-00" },
];
assert.ok(fit.every(({ seed }) => curriculum.trainingSeeds.includes(seed) && !curriculum.validationSeeds.includes(seed)));
assert.ok(validation.every(({ seed }) => curriculum.validationSeeds.includes(seed) && !curriculum.trainingSeeds.includes(seed)));
const episodesPath = join(output, "episodes.jsonl");
writeFileSync(episodesPath, "", { flag: "wx" });
const write = (name, data) => {
  const bytes = JSON.stringify(data, null, 2) + "\n";
  writeFileSync(join(output, name), bytes, { flag: "wx" });
  return sha(bytes);
};

function execute({ stage, seed }, arm, action, queueDetour, collect = false) {
  const digest = createHash("sha256"), incidents = [], path = [];
  let ambient, lostActorAt = null, roadDenials = 0, solverContacts = 0, decisionCount = 0;
  const started = performance.now();
  const episode = runPursuitEpisode({ ...stage, queueDetour }, seed, action, collect, (row, events) => {
    assert.ok(row.slice(0, 5).every(Number.isFinite));
    digest.update(JSON.stringify(row));
    if (++decisionCount % 6 === 1) path.push(row);
    incidents.push(...events.filter(isDispatchIncident));
  }, world => {
    if (!ambient) {
      const { pursuit, player } = world;
      ambient = world.actors.filter(a => a !== player && !pursuit.patrols.has(a));
      assert.deepEqual(["vehicle", "pedestrian"].map(type => ambient.filter(a => a.type === type).length),
        [stage.traffic, stage.pedestrians]);
      const step = world.step.bind(world);
      world.step = () => {
        step();
        roadDenials += Number(pursuit.metrics.guard === "road-boundary");
        solverContacts += Number(pursuit.metrics.guard === "contact");
      };
    }
    if (lostActorAt === null && !ambient.every(a => world.actors.includes(a))) lostActorAt = world.tick;
  });
  const egoEventCount = incidents.filter(e => e.type === "patrol_collision" || e.type === "static_or_civilian_hit").length;
  const clean = episode.metrics.phase === "escaped" && episode.metrics.pursuitQualified &&
    episode.metrics.collisions === 0 && egoEventCount === 0 && solverContacts === 0 &&
    lostActorAt === null && roadDenials === 0;
  const summary = { arm, stage: stage.id, queueDetour: queueDetour ?? null, ...episode.metrics,
    clean, roadDenials, solverContacts, egoEventCount, lostActorAt, motionSha256: digest.digest("hex"),
    wallSeconds: (performance.now() - started) / 1000 };
  appendFileSync(episodesPath, JSON.stringify({ ...summary, path, incidents }) + "\n");
  console.log(JSON.stringify(summary));
  return { episode, summary };
}

const model = new PursuitPpo(null, prior);
assert.deepEqual(model.checkpoint().weights, prior.weights);
assert.deepEqual(model.checkpoint().firstMoment, prior.firstMoment);
assert.deepEqual(model.checkpoint().secondMoment, prior.secondMoment);
const training = fit.map(entry => {
  const rng = new Random(`pako-measured-city:continuation:${prior.updates}:${entry.seed}`);
  return execute(entry, "sampled-training", obs => model.sample(obs, rng), on, true);
});
const batch = joinPursuitRollout(model, "pako-measured-city", training.map(row => row.episode));
const update = model.update(batch.rollout, batch.bootstrap);
const after = { ...model.checkpoint(), research: { experiment: "pako-measured-city", support: on, parent: priorSha256 } };
const weightDelta = Math.sqrt(after.weights.reduce((sum, v, i) => sum + (v - prior.weights[i]) ** 2, 0));
assert.ok(weightDelta > 0 && after.updates === prior.updates + 1 &&
  after.transitions === prior.transitions + batch.rollout.length && after.optimizerSteps > prior.optimizerSteps);
const candidateSha256 = write("candidate.json", after);
const frozen = freezePursuitPolicy(JSON.parse(readFileSync(join(output, "candidate.json"))));
const untrained = new PursuitPpo(prior.seed, null, prior.observation);
const scores = validation.map(entry => ({ seed: entry.seed, stage: entry.stage.id,
  prior: execute(entry, "prior", predecessor.action).summary,
  sameAssist: execute(entry, "prior-assisted", predecessor.action, on).summary,
  untrained: execute(entry, "untrained-assisted", obs => untrained.action(obs), on).summary,
  continued: execute(entry, "continued-assisted", frozen.action, on).summary,
}));
const totals = Object.fromEntries(["prior", "sameAssist", "untrained", "continued"].map(
  key => [key, scores.filter(row => row[key].clean).length]));
const noRegression = scores.every(({ prior: base, sameAssist, continued }) =>
  (!(base.clean || sameAssist.clean) || continued.clean) &&
  continued.egoEventCount <= sameAssist.egoEventCount &&
  continued.ambientPedestrianImpacts <= sameAssist.ambientPedestrianImpacts &&
  continued.lostActorAt === null);
const pass = noRegression && totals.continued > totals.sameAssist &&
  totals.continued > totals.untrained && totals.continued > totals.prior;
write("report.json", { scope: "City development; not held-out or promoted", priorSha256, candidateSha256, update,
  weightDelta, training: training.map(row => row.summary), scores, totals, noRegression, pass });
assert.ok(pass, "The updated weights did not improve clean escape beyond the unchanged same-assist actor");
