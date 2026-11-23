import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { clamp } from "../src/core/config.js";
import { Random } from "../src/core/random.js";
import { measureConnectedEndpoint, PAKO_ENDPOINT_OBSERVATION } from "../src/rl/pako-curve-observation.js";
import { freezePursuitPolicy, PursuitPpo } from "../src/rl/pursuit-ppo.js";
import { prior, run } from "./pako-connected-window.mjs";

const output = process.env.PROVE_IT_OUTPUT_DIR;
assert.ok(output, "Use a fresh PROVE_IT_OUTPUT_DIR");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const write = (name, value) => {
  const bytes = JSON.stringify(value, null, 2) + "\n";
  writeFileSync(join(output, name), bytes, { flag: "wx" });
  return hash(bytes);
};
const previous = readFileSync(new URL(
  "../.runtime-proof/pako-curve-cues-20261121/runs/learning/20261121T142235-585fde99ba/protocol.json", import.meta.url));
const source = JSON.parse(previous);
const settings = { seed: source.settings.actorSeed, epochs: 80, updates: 3,
  exploration: [.045, .12, .11], penalty: { reserve: .015, overrun: .035, roadDenial: .075 } };
const end = (site, path, along) => {
  const key = path ? "connected" : "direct";
  return { ...site, [key]: [site[key][0], along, site[key][2]] };
};
const finishVariation = [0, -3, +2, -5, +1.2, -2];
const training = source.training.map(({ site, options, index }) => ({
  site: end(site, options.path, 76 + finishVariation[index]),
  options: { ...options, seed: `pako-endpoint-fit-01:${site.entry}:${index}` },
  index,
}));
const staged = [
  [1.1, 5.65, -.2, 75], [-1.1, 5.95, .2, 77.5],
  [-.7, 5.8, -.2, 74.5], [.9, 5.45, .2, 77],
];
const validation = source.validation.map(({ site, options }, i) => {
  const [offsetM, speedMps, lateralM, finish] = staged[i];
  return { site: end(site, options.path, finish), options: { ...options, offsetM, speedMps, lateralM,
    seed: `pako-endpoint-development-01:${site.entry}:${i}` } };
});
assert.ok(validation.every(row => training.every(fit => fit.site.entry !== row.site.entry &&
  fit.options.seed !== row.options.seed)));
write("protocol.json", { node: process.version, previousProtocolSha256: hash(previous), settings,
  source: PAKO_ENDPOINT_OBSERVATION, training, validation,
  scope: "Sparse Metro development. Both PPO arms start from the same warm weights and seed schedule, with three update calls each. No runtime route-control replacement or protected test." });

const execute = ({ site, options }, arm, extra = {}) =>
  run(site, { ...options, routeCue: false, observe: measureConnectedEndpoint, arm, ...extra });
const references = training.map(row => execute(row, "reference", { demonstrate: true }));
const eligible = references.filter(row => row.summary.full);
write("fit-references.json", references.map(row => row.summary));
assert.equal(new Set(eligible.map(row => row.summary.entry)).size, 2, "Need complete demonstrations from both fit roads");
const samples = eligible.flatMap(row => row.data);
const sameLayout = () => new PursuitPpo(settings.seed, null, PAKO_ENDPOINT_OBSERVATION.version);
const teacherStudent = sameLayout();
const losses = teacherStudent.warmStart(samples, settings.epochs);
const warm = teacherStudent.checkpoint(), warmSha = write("warm-checkpoint.json", warm);

const { reserve, overrun, roadDenial } = settings.penalty;
const endpointPenalty = (obs, deniedTicks) => {
  const finishM = obs.at(-2) * 40;
  const reserveM = obs.at(-1) * 30;
  const moving = obs[0] > .3 / 24;
  return -roadDenial * deniedTicks - (moving && finishM < 38 ?
    reserve * clamp(-reserveM, 0, 16) + overrun * clamp(-finishM, 0, 8) : 0);
};
const brief = rows => rows.map(row => [row.arm, row.full, row.phase, row.ticks, row.denied,
  row.contacts[0]?.tick, row.addedReward]);
const learned = {};
for (const [arm, adjustment] of [["ordinaryPpo", null], ["stopAwarePpo", endpointPenalty]]) {
  const actor = new PursuitPpo(null, warm);
  assert.deepEqual(actor.checkpoint(), warm);
  actor.layout = { ...actor.layout, std: settings.exploration };
  const updates = [];
  for (let i = 0; i < settings.updates; i++) {
    const episodes = training.filter(row => row.index % 3 === i).map(row => {
      const rng = new Random(`${row.options.seed}:${i}:shared-noise`);
      return execute(row, arm, { choose: obs => actor.sample(obs, rng), sample: true, rewardAdjustment: adjustment });
    });
    const trajectory = episodes.flatMap(row => {
      row.data.at(-1).episodeBootstrap = row.last.terminated ? 0 : actor.value(row.lastObservation);
      return row.data;
    });
    const change = actor.update(trajectory);
    const outcomes = episodes.map(row => row.summary);
    updates.push({ change, outcomes });
    console.log(JSON.stringify({ arm, update: i + 1, change, outcomes: brief(outcomes) }));
  }
  const checkpoint = actor.checkpoint();
  assert.equal(checkpoint.updates, settings.updates);
  assert.ok(checkpoint.weights.some((weight, index) => weight !== warm.weights[index]));
  assert.throws(() => freezePursuitPolicy(checkpoint), /connected endpoint research adapter/);
  const sha256 = write(`${arm}-checkpoint.json`, checkpoint);
  learned[arm] = { sha256, updates, inference: new PursuitPpo(null, checkpoint) };
}
const notTrained = sameLayout();
const choices = { incumbent: { routeCue: true, observe: null, choose: prior.action },
  untrained: { choose: obs => notTrained.action(obs) },
  warm: { choose: obs => teacherStudent.action(obs) },
  ...Object.fromEntries(Object.entries(learned).map(([name, { inference }]) =>
    [name, { choose: obs => inference.action(obs) }])) };
const attempts = validation.map(row => {
  const arms = [execute(row, "reference"),
    ...Object.entries(choices).map(([name, select]) => execute(row, name, select))];
  console.log(JSON.stringify({ seed: row.options.seed, arms: brief(arms) }));
  return { ...row, arms };
});
const totals = Object.fromEntries(["reference", ...Object.keys(choices)]
  .map(name => [name, attempts.filter(row => row.arms.some(arm => arm.arm === name && arm.full)).length]));
const feasibleSites = [...new Set(attempts.filter(row => row.arms.find(arm => arm.arm === "reference").full)
  .map(row => row.site.entry))];
const improvement = Object.keys(learned).filter(arm => feasibleSites.length === 2 &&
  ["incumbent", "untrained", "warm"].every(control => totals[arm] > totals[control]) &&
  attempts.every(({ arms }) => !arms.find(row => row.arm === "incumbent").full || arms.find(row => row.arm === arm).full));
const passed = improvement.length > 0;
write("endpoint-learning.json", { passed, totals, improvement, feasibleSites, warmSha, samples: samples.length, losses,
  learned: Object.fromEntries(Object.entries(learned).map(([key, { inference, ...row }]) => [key, row])), attempts });
console.log(JSON.stringify({ passed, totals, improvement, feasibleSites }));
assert.ok(passed, "No PPO arm established a full clean-escape gain over the exact prior, untrained and warm-only controls");
