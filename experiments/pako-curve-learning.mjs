import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Random } from "../src/core/random.js";
import { measureConnectedCurve, PAKO_CURVE_OBSERVATION } from "../src/rl/pako-curve-observation.js";
import { freezePursuitPolicy, PursuitPpo } from "../src/rl/pursuit-ppo.js";
import { fit, prior, run } from "./pako-connected-window.mjs";

const output = process.env.PROVE_IT_OUTPUT_DIR;
assert.ok(output, "Use a fresh PROVE_IT_OUTPUT_DIR");
const save = (name, value) => {
  const bytes = JSON.stringify(value, null, 2) + "\n";
  writeFileSync(join(output, name), bytes, { flag: "wx" });
  return createHash("sha256").update(bytes).digest("hex");
};
const previous = new URL(
  "../.runtime-proof/pako-connected-learning-20261121/runs/learning/20261121T141656-55f847c5eb/protocol.json",
  import.meta.url);
const diagnosis = JSON.parse(readFileSync(previous)).validate;
const validation = diagnosis.map(({ site, options }, i) => ({
  site, options: { ...options, seed: `connected-curve-development-01:${site.entry}:${i}`,
    offsetM: i % 2 ? -.8 : .7, speedMps: i % 2 ? 5.4 : 6.05, lateralM: i % 2 ? .18 : -.16 },
}));
const settings = { actorSeed: "pako-curve-v1", epochs: 80, updates: 3, explorationStd: [.045, .12, .11] };
const variants = [
  { offsetM: -.6, speedMps: 5.4, lateralM: -.42 }, { offsetM: -.3, speedMps: 5.9, lateralM: .45 },
  { offsetM: .65, speedMps: 5.7, lateralM: 0 }, { offsetM: 0, speedMps: 6.05, lateralM: -.28 },
  { offsetM: .35, speedMps: 5.3, lateralM: .25 }, { offsetM: -.4, speedMps: 5.6, lateralM: 0 },
];
const training = fit.filter(site => ["station-avenue", "souq-collector"].includes(site.entry)).flatMap(site =>
  variants.map((pose, index) => ({
    site, options: { ...pose, path: index % 3 === 2 && site.entry === "station-avenue" ? 1 : 0,
      seed: `connected-curve-fit-01:${site.entry}:${index}` }, index,
  })));
assert.ok(validation.every(row => training.every(other => other.site.entry !== row.site.entry &&
  other.options.seed !== row.options.seed)));
save("protocol.json", { settings, node: process.version, observation: PAKO_CURVE_OBSERVATION, training, validation, diagnosis,
  scope: "Sparse, full-episode Metro development only; the public destination is shared and no controls are substituted" });

const execute = ({ site, options }, arm, extra = {}) => run(site, { ...options, arm, ...extra });
const demonstrations = training.map(row => execute(row, "reference", { observe: measureConnectedCurve, demonstrate: true }));
const clean = demonstrations.filter(row => row.summary.full);
save("fit.json", { arms: demonstrations.map(row => row.summary), eligibleSeeds: clean.map(row => row.summary.seed) });
assert.equal(new Set(clean.map(row => row.summary.entry)).size, 2, "Both fit roads require complete clean references");
const examples = clean.flatMap(row => row.data);
const actor = new PursuitPpo(settings.actorSeed, null, PAKO_CURVE_OBSERVATION.version);
const untrained = new PursuitPpo(settings.actorSeed, null, actor.observation);
const losses = actor.warmStart(examples, settings.epochs);
const warm = actor.checkpoint(), warmSha256 = save("warm-checkpoint.json", warm);
actor.layout = { ...actor.layout, std: settings.explorationStd };
const fitUpdates = [];
const brief = rows => rows.map(row => [row.arm, row.full, row.phase, row.ticks, row.denied, row.contacts[0]?.tick]);
for (let index = 0; index < settings.updates; index++) {
  const sampled = training.filter(row => row.index % 3 === index).map(row => {
    const rng = new Random(`${row.options.seed}:${index}:curve-exploration`);
    return execute(row, "sampled", { observe: measureConnectedCurve, sample: true, choose: obs => actor.sample(obs, rng) });
  });
  const batch = sampled.flatMap(episode => {
    episode.data.at(-1).episodeBootstrap = episode.last.terminated ? 0 : actor.value(episode.lastObservation);
    return episode.data;
  });
  const step = actor.update(batch);
  const outcomes = sampled.map(row => row.summary);
  fitUpdates.push({ step, outcomes });
  console.log(JSON.stringify({ update: index + 1, step, outcomes: brief(outcomes) }));
}
const updated = actor.checkpoint(), ppoSha256 = save("ppo-checkpoint.json", updated);
assert.ok(updated.updates === settings.updates && updated.weights.some((value, index) => warm.weights[index] !== value));
assert.throws(() => freezePursuitPolicy(updated), /connected curve research adapter/);
const warmActor = new PursuitPpo(null, warm), ppo = new PursuitPpo(null, updated);
const choices = {
  incumbent: { choose: prior.action, routeCue: true },
  untrained: { choose: input => untrained.action(input), observe: measureConnectedCurve },
  warm: { choose: input => warmActor.action(input), observe: measureConnectedCurve },
  ppo: { choose: input => ppo.action(input), observe: measureConnectedCurve },
};
const score = entries => entries.map(entry => {
  const rows = [execute(entry, "reference", { observe: measureConnectedCurve }),
    ...Object.entries(choices).map(([name, option]) => execute(entry, name, option))];
  console.log(JSON.stringify({ seed: entry.options.seed, outcomes: brief(rows) }));
  return { seed: entry.options.seed, rows };
});
const evals = score(validation), earlier = score(diagnosis);
const totalsFor = attempts => Object.fromEntries(["reference", ...Object.keys(choices)].map(name => [name,
  attempts.filter(row => row.rows.some(arm => arm.arm === name && arm.full)).length]));
const totals = totalsFor(evals), diagnosticTotals = totalsFor(earlier);
const feasibleSites = [...new Set(evals.flatMap(row => row.rows.filter(a => a.arm === "reference" && a.full).map(a => a.entry)))];
const passed = feasibleSites.length >= 2 && ["incumbent", "untrained", "warm"].every(key => totals.ppo > totals[key]) &&
  evals.every(({ rows }) => !rows.find(row => row.arm === "incumbent").full || rows.find(row => row.arm === "ppo").full);
save("curve-learning.json", { passed, totals, diagnosticTotals, feasibleSites, samples: examples.length, losses, fitUpdates,
  policies: { warmSha256, ppoSha256, updates: updated.updates, transitions: updated.transitions }, evals, earlier });
console.log(JSON.stringify({ passed, totals, diagnosticTotals, feasibleSites }));
assert.ok(passed, "The curve-aware frozen PPO did not demonstrate a larger clean escape count than all matched baselines");
