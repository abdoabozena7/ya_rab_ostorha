import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Random } from "../src/core/random.js";
import { freezePursuitPolicy, PursuitPpo } from "../src/rl/pursuit-ppo.js";
import { fit, prior, priorCheckpoint, run } from "./pako-connected-window.mjs";

const output = process.env.PROVE_IT_OUTPUT_DIR;
assert.ok(output, "Use a fresh PROVE_IT_OUTPUT_DIR");
const save = (name, payload) => {
  const bytes = JSON.stringify(payload, null, 2) + "\n";
  writeFileSync(join(output, name), bytes, { flag: "wx" });
  return createHash("sha256").update(bytes).digest("hex");
};
const trainingSites = fit.filter(site => ["station-avenue", "souq-collector"].includes(site.entry));
const testSites = [
  { entry: "tahrir-boulevard", start: -205, sign: 1, branch: "civic-avenue", branchSign: 1, lead: -163,
    direct: ["civic-avenue", 76, 1], connected: ["corniche-avenue", 76, 1], path: 0 },
  { entry: "civic-avenue", start: -9, sign: 1, branch: "souq-collector", branchSign: -1, lead: 26,
    direct: ["corniche-avenue", 76, 1], connected: ["corniche-avenue", 76, 1], path: 0 },
];
const cases = (sites, split, starts) => sites.flatMap(site => starts.map(([offsetM, speedMps], index) => ({
  site, options: { routeCue: true, path: site.path ?? 0, offsetM, speedMps,
    seed: `pako-connected-learning-01:${split}:${site.entry}:${index}` },
})));
const train = cases(trainingSites, "fit", [[-.45, 5.45], [0, 5.7], [.55, 5.95]]);
const validate = cases(testSites, "development-validation", [[-.55, 5.5], [.35, 5.85]]);
const settings = { seed: "pako-connected-pace-v1", epochs: 64, updates: 2, explorationStd: [.035, .12, .09] };
assert.ok(validate.every(entry => train.every(fit => fit.site.entry !== entry.site.entry && fit.options.seed !== entry.options.seed)));
save("protocol.json", { scope: "Complete sparse development City recovery episodes; public destination and independent guard common to all test arms",
  node: process.version, priorObservation: prior.observation, settings, train, validate,
  oracle: "PPO must improve clean qualified escape count versus the unchanged predecessor, same-schema untrained actor and warm-only actor on separately staged starts; all attempted arms count." });

const execute = ({ site, options }, arm, extra = {}) => run(site, { ...options, ...extra, arm });
const demonstrations = train.map(entry => execute(entry, "reference", { demonstrate: true }));
const cleanData = demonstrations.filter(row => row.summary.full);
save("fit-references.json", { results: demonstrations.map(row => row.summary), eligible: cleanData.map(row => row.summary.seed) });
assert.equal(new Set(cleanData.map(row => row.summary.entry)).size, 2, "Both fit layouts need complete clean episodes");
const samples = cleanData.flatMap(row => row.data);
const actor = new PursuitPpo(settings.seed, null, prior.observation);
assert.equal(actor.observation, priorCheckpoint.observation);
const untrained = new PursuitPpo(settings.seed, null, prior.observation);
const loss = actor.warmStart(samples, settings.epochs);
const warm = actor.checkpoint(), warmSha = save("warm-checkpoint.json", warm);
actor.layout = { ...actor.layout, std: settings.explorationStd };
const fitting = [];
const concise = row => row.map(({ arm, full, phase, ticks, denied, cleared, contacts }) =>
  [arm, full, phase, ticks, denied, cleared?.tick, contacts[0]?.tick]);
for (let update = 0; update < settings.updates; update++) {
  const arms = train.filter((_, index) => index % 3 === update + 1);
  const sampled = arms.map(entry => {
    const rng = new Random(`${entry.options.seed}:${update}:sampling`);
    return execute(entry, "sampled", { sample: true, choose: obs => actor.sample(obs, rng) });
  });
  const trajectories = sampled.flatMap(row => {
    row.data.at(-1).episodeBootstrap = row.last.terminated ? 0 : actor.value(row.last.obs);
    return row.data;
  });
  assert.ok(trajectories.length > 150 && sampled.every(row => row.data.length > 0));
  const training = actor.update(trajectories);
  const summaries = sampled.map(row => row.summary);
  fitting.push({ training, summaries });
  console.log(JSON.stringify({ update: update + 1, training, sampled: concise(summaries) }));
}
const checkpoint = actor.checkpoint(), ppoSha = save("ppo-checkpoint.json", checkpoint);
assert.ok(checkpoint.weights.some((value, index) => value !== warm.weights[index]));
assert.equal(checkpoint.updates, settings.updates);
const warmActor = new PursuitPpo(null, warm), frozenPpo = freezePursuitPolicy(checkpoint);
const chooses = { prior: prior.action, untrained: obs => untrained.action(obs),
  warm: obs => warmActor.action(obs), ppo: frozenPpo.action };
const evaluations = validate.map(entry => {
  const rows = [execute(entry, "reference"), ...Object.entries(chooses)
    .map(([name, choose]) => execute(entry, name, { choose }))];
  console.log(JSON.stringify({ seed: entry.options.seed, rows: concise(rows) }));
  return rows;
});
const totals = Object.fromEntries(["reference", ...Object.keys(chooses)]
  .map(name => [name, evaluations.flat().filter(row => row.arm === name && row.full).length]));
const feasibleSites = new Set(evaluations.flat().filter(row => row.arm === "reference" && row.full).map(row => row.entry));
const passed = feasibleSites.size >= 2 && ["prior", "untrained", "warm"].every(key => totals.ppo > totals[key]) &&
  evaluations.every(rows => !rows.find(row => row.arm === "prior").full || rows.find(row => row.arm === "ppo").full);
save("learning-comparison.json", { passed, totals, feasibleSites: [...feasibleSites], loss, samples: samples.length,
  accountable: { warmSha, ppoSha, updates: checkpoint.updates, transitions: checkpoint.transitions }, fitting, evaluations });
console.log(JSON.stringify({ passed, totals, feasibleSites: [...feasibleSites] }));
assert.ok(passed, "The PPO update did not establish attributable terminal escape improvement");
