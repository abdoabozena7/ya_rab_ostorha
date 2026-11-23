import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { clamp } from "../src/core/config.js";
import { Random } from "../src/core/random.js";
import { PAKO_ENDPOINT_OBSERVATION } from "../src/rl/pako-curve-observation.js";
import { freezePursuitPolicy, PursuitPpo } from "../src/rl/pursuit-ppo.js";
import { runReverseTrial } from "./pako-frozen-reverse.mjs";

const output = process.env.PROVE_IT_OUTPUT_DIR;
assert.ok(output, "Use a fresh PROVE_IT_OUTPUT_DIR");
const write = (name, value) => {
  const data = JSON.stringify(value, null, 2) + "\n";
  writeFileSync(join(output, name), data, { flag: "wx" });
  return createHash("sha256").update(data).digest("hex");
};
const settings = { epochs: 80, updates: 3, exploration: [.035, .10, .085], actorSeed: "pako-reverse-motor-01" };
const fit = [
  { frontGapM: 3.15, seed: "pako-frozen-reverse-transfer-01" },
  { frontGapM: 3.08, seed: "pako-fit-reverse-terminal-02" },
  { frontGapM: 3.12, seed: "pako-fit-motor-01:2" },
  { frontGapM: 3.19, seed: "pako-fit-motor-01:3" },
];
const repeat = [3.1, 3.135, 3.18, 3.24].map((frontGapM, i) => ({ frontGapM, seed: `pako-eval-motor-01:${i}`, split: "repeat" }));
const transfer = [3.09, 3.125, 3.165, 3.22].map((frontGapM, i) =>
  ({ frontGapM, seed: `pako-transfer-motor-02:${i}`, split: "transfer" }));
const evaluation = [...repeat, ...transfer];
const referencePace = { capMps: 4, whenWithinM: 24 };
const protocol = { settings, fit, evaluation, source: PAKO_ENDPOINT_OBSERVATION,
  scope: "A shared scripted guarded reverse and supported path. After the switch the PPO emits actual steering, throttle, brake and gear; the guard can still veto.",
  fitSource: "Prior traces found that two failed fit variants completed real clean escapes after reducing pace for an actually observed near return. Keep the same fit cases. Use original evaluation only for retesting and retain a fresh transfer split.",
  referencePace,
  reward: "Existing Metro clean objective, accumulated per accepted physics tick after the takeover.",
  controls: ["guarded reference", "exact old motor without shared reference", "exact initial weights", "demonstrations only", "sampled PPO continuation"],
  admission: "Complete scripted fixture runs without contact and denial before checking the frozen candidates." };
write("protocol.json", protocol);
const execute = (start, name, motor, extra = {}) => runReverseTrial({ ...start, name, motor,
  evasion: true, reference: true, terminalRun: true, onward: { side: 1 }, ...extra });
const originalTeacher = (_obs, action) => ({ action });
const teacher = (obs, action) => {
  const speedMps = obs[0] * 24, frontRangeM = obs[4] * 28;
  const { capMps, whenWithinM } = referencePace;
  if (frontRangeM >= whenWithinM || action.brake) return { action };
  const brake = clamp((speedMps - capMps - .15) / 2.5, 0, 1);
  return { action: { ...action, brake,
    throttle: brake ? 0 : Math.min(action.throttle, clamp(capMps - speedMps, 0, 1)) } };
};
const references = fit.map(row => execute(row, "teacher", teacher));
write("fit-references.json", references.map(row => row.summary));
const eligible = references.filter(row => row.summary.passed);
assert.ok(eligible.length >= 2, "Need at least two full clean fit references before warm starting");
const fresh = () => new PursuitPpo(settings.actorSeed, null, PAKO_ENDPOINT_OBSERVATION.version);
const warmOnly = fresh(), demonstration = eligible.flatMap(row => row.motion);
const losses = warmOnly.warmStart(demonstration, settings.epochs);
const warm = warmOnly.checkpoint(), warmSha = write("warm-checkpoint.json", warm);
const model = new PursuitPpo(null, warm);
model.layout = { ...model.layout, std: settings.exploration };
const summaryFor = ({ name, seed, phase, passed, ticks, prefix, switchAt, acceptedMotorDecisions, distanceAfterEntry, denied, contacts }) =>
  ({ name, seed, phase, passed, ticks, prefix, switchAt, acceptedMotorDecisions, distanceAfterEntry, denied,
    firstContact: contacts[0]?.tick, contacts: contacts.length });
let sampledDecisions = 0;
const training = [];
for (let i = 0; i < settings.updates; i++) {
  const episodes = fit.slice(i).concat(fit.slice(0, i)).slice(0, 2).map(row => {
    const rng = new Random(`${row.seed}:ppo:${i}`);
    return execute(row, "actual-sampled", obs => model.sample(obs, rng));
  });
  const samples = episodes.flatMap(row => {
    assert.ok(row.motion.length && row.summary.switchAt);
    row.motion.at(-1).episodeBootstrap = row.lastObservation ? model.value(row.lastObservation) : 0;
    return row.motion;
  });
  const change = model.update(samples);
  sampledDecisions += samples.length;
  training.push({ change, episodes: episodes.map(row => row.summary) });
  console.log(JSON.stringify({ update: i + 1, change, arms: episodes.map(row => summaryFor(row.summary)) }));
}
const checkpoint = model.checkpoint(), sha256 = write("ppo-checkpoint.json", checkpoint);
assert.equal(checkpoint.transitions, sampledDecisions);
assert.ok(checkpoint.weights.some((value, i) => value !== warm.weights[i]));
assert.throws(() => freezePursuitPolicy(checkpoint), /connected endpoint research adapter/);
const frozen = new PursuitPpo(null, checkpoint);
const initial = fresh();
const use = actor => obs => ({ action: actor.action(obs) });
const results = evaluation.map(start => {
  const reference = execute(start, "reference", teacher).summary;
  const admitted = reference.passed;
  const arms = { reference,
    uncapped: execute(start, "uncapped", originalTeacher).summary,
    untrained: execute(start, "untrained", use(initial)).summary,
    warm: execute(start, "warm", use(warmOnly)).summary,
    ppo: execute(start, "ppo", use(frozen)).summary,
    incumbent: execute(start, "incumbent", null, { reference: false }),
  };
  for (const drive of [arms.uncapped, arms.untrained, arms.warm, arms.ppo]) assert.equal(drive.prefix, reference.prefix);
  console.log(JSON.stringify({ seed: start.seed, admitted, arms: Object.values(arms).map(summaryFor) }));
  return { start, admitted, arms };
});
assert.deepEqual(frozen.checkpoint(), checkpoint);
const eligibleTests = results.filter(row => row.admitted);
const totals = rows => Object.fromEntries(["reference", "uncapped", "untrained", "warm", "ppo", "incumbent"]
  .map(name => [name, rows.filter(row => row.arms[name].passed).length]));
const qualified = totals(eligibleTests);
const transferTotals = totals(results.filter(row => row.start.split === "transfer"));
const passed = eligibleTests.length >= 2 && ["untrained", "warm", "incumbent"].every(name => qualified.ppo > qualified[name]) &&
  transferTotals.ppo > transferTotals.warm &&
  eligibleTests.every(({ arms }) => (!arms.ppo.passed || arms.ppo.acceptedMotorDecisions >= 20) &&
    (!arms.warm.passed || arms.ppo.passed) && (!arms.incumbent.passed || arms.ppo.passed));
write("reverse-motor.json", { passed, admitted: eligibleTests.length, totals: totals(results), qualified,
  transferTotals, demonstrations: demonstration.length, warmSha, sha256, sampledDecisions, losses, training, results });
console.log(JSON.stringify({ passed, admitted: eligibleTests.length, qualified, transferTotals, sampledDecisions }));
assert.ok(passed, "Frozen PPO did not improve the terminal clean-escape metric over identical-assistance controls");
