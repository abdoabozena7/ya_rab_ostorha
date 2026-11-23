import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Random } from "../src/core/random.js";
import { evaluateChoice, fitStarts, measured, obstructions } from "./pako-onward-choice.mjs";

const output = process.env.PROVE_IT_OUTPUT_DIR;
assert.ok(output, "Use a fresh PROVE_IT_OUTPUT_DIR");
const hash = data => createHash("sha256").update(JSON.stringify(data)).digest("hex");
const write = (name, value) => writeFileSync(join(output, name), JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
const settings = Object.freeze({ updates: 6, epochs: 4, epsilon: .2, learningRate: .65, seed: "onward-categorical-fit-01" });
const fields = ["bias", "route-0-return", "route-1-return"];
const training = Array.from({ length: settings.updates }, (_, batch) => fitStarts
  .flatMap((start, i) => Object.entries(obstructions).map(([layout, wall]) => ({
    start, wall, layout, seed: `pako-onward-ppo-fit-01:${batch}:${i}:${layout}`,
  }))));
const laterStarts = [
  { offsetM: -.97, speedMps: 5.36, lateralM: -.17, decisionZ: -22.15, civic: 17.8, turn: -192.8 },
  { offsetM: -.22, speedMps: 5.34, lateralM: -.06, decisionZ: -19.5, civic: 14.7, turn: -191.05 },
];
const transferStarts = [
  { offsetM: -1.27, speedMps: 5.47, lateralM: -.05, decisionZ: -21.6, civic: 18.45, turn: -191.4 },
  { offsetM: -.52, speedMps: 5.27, lateralM: .07, decisionZ: -19.1, civic: 15.75, turn: -192.15 },
];
const split = (starts, split) => starts.flatMap((start, i) => Object.keys(obstructions).map(layout => ({
  seed: `pako-onward-ppo-${split}-01:${i}:${layout}`, layout, start, split,
  wall: layout === "clear" ? null : { ...obstructions[layout], along: layout === "civic" ? start.civic : start.turn },
})));
const evaluation = [...split(laterStarts, "eval"), ...split(transferStarts, "transfer")];
assert.equal(new Set([...training.flat(), ...evaluation].map(row => row.seed)).size,
  training.flat().length + evaluation.length);
const protocol = {
  scope: "One high-level route choice in sparse local Metro. Same scripted low-level follower and independent safety in every primary arm.",
  settings, fields, training, evaluation,
  reward: "One sampled option per full episode. +1 qualified contact-free escape with intact patrol and full onward travel; -1 otherwise.",
  admission: "In the opposed scenes only the prescribed physically unblocked route may succeed; the two controls must share the accepted approach, and measured choice must take the winning route. Both fixed routes must succeed in both open controls. Admission never reads learned predictions.",
  temporalControl: "Known evaluation rows are a regression after the single-frame miss. New transfer rows were not used to diagnose or fit the repair. Compare the same frozen weights with the most recent frame only.",
  controls: ["always direct", "always connected", "sensor rule", "exact initialization", "frozen candidate with inputs zeroed",
    "latest frame only", "separate exact frozen low-level incumbent without the route follower; not a matched attribution arm"],
};
write("protocol.json", protocol);

const observe = returns => [1, Number(returns[0].length > 0), Number(returns[1].length > 0)];
const probability = (weights, features) => 1 / (1 + Math.exp(-weights.reduce((sum, weight, i) => sum + weight * features[i], 0)));
const chance = (p, action) => action ? p : 1 - p;
const greedy = (weights, mode) => ({ returns, latest }) => {
  const p = probability(weights, mode === "off" ? [1, 0, 0] : observe(mode === "latest" ? latest : returns));
  return { index: Number(p > .5), probabilityConnected: p };
};

const weights = [0, 0, 0], original = [...weights];
let baseline = 0, optimizerSteps = 0;
const train = training.map((cases, update) => {
  const before = [...weights];
  const episodes = cases.map(row => {
    const rng = new Random(`${settings.seed}:${row.seed}`);
    let sample;
    const result = evaluateChoice(row.start, row.wall, ({ returns }) => {
      assert.equal(sample, undefined, "The route option must be sampled exactly once");
      const features = observe(returns), p = probability(before, features), action = Number(rng.next() < p);
      sample = { features, action, oldProbability: chance(p, action) };
      return { index: action, probabilityConnected: p };
    }, "on-policy", row.seed);
    const reward = result.full ? 1 : -1;
    return { ...row, sample, reward, result };
  });
  const valid = episodes.filter(row => row.sample);
  assert.ok(valid.length, "No on-policy route decisions were reached in this batch");
  for (let epoch = 0; epoch < settings.epochs; epoch++) {
    const direction = [0, 0, 0];
    for (const { sample, reward } of valid) {
      const { features, action, oldProbability } = sample;
      const p = probability(weights, features), ratio = chance(p, action) / oldProbability, advantage = reward - baseline;
      if ((advantage > 0 && ratio > 1 + settings.epsilon) || (advantage < 0 && ratio < 1 - settings.epsilon)) continue;
      for (let j = 0; j < direction.length; j++) direction[j] += advantage * ratio * (action - p) * features[j] / valid.length;
    }
    optimizerSteps++;
    for (let j = 0; j < weights.length; j++) weights[j] += settings.learningRate * direction[j];
  }
  baseline = (baseline + valid.reduce((sum, row) => sum + row.reward, 0) / valid.length) / 2;
  console.log(JSON.stringify({ update: update + 1, decisions: valid.length, clean: valid.filter(row => row.result.full).length,
    optimizerSteps, weights }));
  return { update: update + 1, before, after: [...weights], episodes };
});
const rollouts = train.reduce((sum, batch) => sum + batch.episodes.filter(row => row.sample).length, 0);
assert.ok(weights.every(Number.isFinite) && weights.some((weight, i) => weight !== original[i]));
const frozen = Object.freeze([...weights]);
const checkpoint = Object.freeze({ schema: "metro-onward-option-research-v1", researchOnly: true,
  algorithm: "ppo-clip-categorical", fields, preTrainingWeights: original, weights: frozen,
  optimizerSteps, updates: settings.updates, rollouts, protocolSha256: hash(protocol) });
const checkpointSha256 = hash(checkpoint);
write("onward-research-policy.json", checkpoint);

const fixed = [() => ({ index: 0 }), () => ({ index: 1 })];
const primary = ["direct", "connected", "measured", "initial", "learner", "latestOnly", "cueOff"];
const results = evaluation.map(row => {
  const execute = (name, pick, extra) => evaluateChoice(row.start, row.wall, pick, name, row.seed, extra);
  const direct = execute("direct", fixed[0]), connected = execute("connected", fixed[1]);
  const rule = execute("measured", measured);
  const sameApproach = [direct, connected, rule].every(run => run.approach === direct.approach &&
    run.selection?.tick > run.cleared?.tick && run.selection?.tick === run.selection?.scanTick && run.obstructionIntact && run.alive);
  const winner = row.layout === "clear" ? null : Number(row.layout === "civic");
  const feasible = sameApproach && rule.full && (winner === null ? direct.full && connected.full :
    [direct, connected][winner].full && ![direct, connected][1 - winner].full && rule.selection.index === winner);

  const arms = { direct, connected, measured: rule, initial: execute("initial", greedy(original)),
    learner: execute("learner", greedy(frozen)), latestOnly: execute("latestOnly", greedy(frozen, "latest")),
    cueOff: execute("cueOff", greedy(frozen, "off")),
    incumbent: execute("incumbent", fixed[0], { arm: "prior", routeCue: true }) };
  for (const name of ["initial", "learner", "latestOnly", "cueOff"]) {
    const result = arms[name];
    assert.equal(result.approach, direct.approach, "A decision arm changed the accepted common approach");
    assert.equal(result.positions, [direct, connected][result.selection.index].positions,
      "The learned action must change only route selection, not assistance or physics");
  }
  console.log(JSON.stringify({ seed: row.seed, layout: row.layout, feasible,
    arms: Object.fromEntries(Object.entries(arms).map(([name, run]) =>
      [name, { chosen: run.selection?.index, full: run.full, phase: run.phase, ticks: run.ticks, impacts: run.contacts.length }])) }));
  return { ...row, sameApproach, feasible, winner, arms };
});
assert.equal(hash(checkpoint), checkpointSha256, "Evaluation must not mutate the frozen policy");
const admitted = results.filter(row => row.feasible);
const qualifiedLayouts = new Set(admitted.filter(row => row.winner !== null).map(row => row.layout)).size;
const totalsFor = rows => Object.fromEntries([...primary, "incumbent"]
  .map(name => [name, rows.filter(row => row.arms[name].full).length]));
const totals = totalsFor(results), qualified = totalsFor(admitted);
const temporalRepairs = admitted.filter(({ arms }) =>
  arms.learner.full && !arms.latestOnly.full && arms.learner.selection.heard.some((hits, i) =>
    hits.length && !arms.learner.selection.latest[i].length && hits[0].seenTick < arms.learner.selection.scanTick));
const passed = rollouts === training.flat().length && qualifiedLayouts === 2 &&
  results.filter(row => row.winner === null).every(row => row.feasible && row.arms.learner.full) &&
  ["direct", "connected", "initial", "cueOff"].every(name => qualified.learner > qualified[name]) &&
  admitted.every(row => row.arms.learner.full && !row.arms.learner.contacts.length) &&
  totals.learner >= totals.measured && temporalRepairs.some(row => row.seed === "pako-onward-ppo-eval-01:1:souq");
write("onward-learning.json", { passed, rollouts, qualifiedLayouts, checkpointSha256, updates: settings.updates, optimizerSteps,
  totals, qualified, qualifiedCount: admitted.length, temporalRepairs: temporalRepairs.map(row => row.seed), train, results });
console.log(JSON.stringify({ passed, rollouts, qualifiedLayouts, totals, qualified, qualifiedCount: admitted.length,
  temporalRepairs: temporalRepairs.map(row => row.seed) }));
assert.ok(passed, "The frozen choice did not improve full paired clean escapes over the required matched controls");
