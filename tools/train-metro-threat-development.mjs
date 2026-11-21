import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { clamp } from "../src/core/config.js";
import { PURSUIT_STOP } from "../src/core/pursuit-controls.js";
import { Random } from "../src/core/random.js";
import { CLEARANCE_ROUTE_OBSERVATION_SCHEMA as schema } from "../src/rl/gta-pursuit-env.js";
import { freezePursuitPolicy, PursuitPpo } from "../src/rl/pursuit-ppo.js";

const output = process.env.PROVE_IT_OUTPUT_DIR;
const priorPath = new URL("../.runtime-proof/pursuit-rl-dense-learning-20261120/corrective-trial-20261120-221352/checkpoint-1.json", import.meta.url);
export const threatPriorSha256 = "854b284350457717cd2c299a0dc86604f2600ed989c1c9aac7ff497d0e5181e3";
const hash = bytes => createHash("sha256").update(bytes).digest("hex");

const updateConfig = Object.freeze({ fitEpochs: 72, fitRate: .0018, ppoRate: .000035, tether: .02,
  std: [.055, .08, .07] });
const featureNames = ["speed", "steer", "yawRate", "headingFromEntry", "lateralFromEntry",
  "forwardFromEntry", "forwardFromFrontReturn", "entryRange", "entrySpeed",
  "rearClosing", "elapsed", "entrySideReturn"];
const controlIntervalS = .1, maxDecisions = 42;

async function save(name, value) {
  const json = JSON.stringify(value);
  await writeFile(join(output, name), json, { flag: "wx" });
  return hash(json);
}

function salient(obs) {
  const { rays, tracks, scales } = schema;
  let front = Infinity, right = Infinity, rearClosure = 0;
  for (let i = -4; i <= 4; i++) {
    const at = rays.offset + (i + rays.count) % rays.count * rays.stride;
    const range = obs[at] * scales.rayM;
    if (obs[at + 2] && Math.abs(Math.sin(i * Math.PI / 36) * range) < 1.6)
      front = Math.min(front, range);
  }
  for (let i = 15; i <= 21; i++) {
    const at = rays.offset + i * rays.stride;
    right = Math.min(right, obs[at] * scales.rayM);
  }
  for (let i = 0; i < tracks.count; i++) {
    const at = tracks.offset + i * tracks.stride, track = obs.subarray(at, at + tracks.stride);
    const forward = track[6] * scales.offsetM, side = track[5] * scales.offsetM;
    const closure = track[8] * scales.relativeSpeedMps;
    if (track[0] && track[4] && track[9] === 0 && track[10] && track[11] &&
        forward < -4 && forward > -38 && Math.abs(side) < 4)
      rearClosure = Math.max(rearClosure, closure);
  }
  return { front, right, rearClosure };
}

function context() {
  let progress, finished = false;
  return obs => {
    const { scales } = schema;
    const speed = obs[0] * scales.speedMps, steer = obs[1] * scales.steerRad;
    const yaw = obs[3] * scales.yawRadS, slip = obs[2] * scales.slipMps;
    if (finished) return null;
    if (!progress) {
      const { front, right, rearClosure } = salient(obs);
      if (!(front > 4 && front < 16 && rearClosure > .8 && speed > 2 && speed < 13)) return null;
      progress = { count: 0, heading: 0, lateral: 0, forward: 0, speed, yaw, slip,
        entrySpeed: speed, front, right, rearClosure };
    } else {
      const headingDelta = (yaw + progress.yaw) * controlIntervalS / 2;
      const heading = progress.heading + headingDelta / 2;
      const averageSpeed = (progress.speed + speed) / 2;
      const averageSlip = (progress.slip + slip) / 2;
      const tangentAngle = Math.atan(.5 * Math.tan(steer));
      progress.lateral += (Math.sin(heading + tangentAngle) * averageSpeed +
        Math.cos(heading) * averageSlip) * controlIntervalS;
      progress.forward += (Math.cos(heading + tangentAngle) * averageSpeed -
        Math.sin(heading) * averageSlip) * controlIntervalS;
      progress.heading += headingDelta;
      Object.assign(progress, { speed, yaw, slip });
    }
    if (progress.count === maxDecisions) {
      finished = true;
      return null;
    }
    const features = [speed / 15, steer / .62, yaw / 3, progress.heading / .8, progress.lateral / 8,
      progress.forward / 35, (progress.forward - progress.front) / 20, progress.front / 16,
      progress.entrySpeed / 12, progress.rearClosure / 8, progress.count++ / maxDecisions, progress.right / 48];
    return Float32Array.from(features, value => clamp(value, -1, 1));
  };
}

function createModel() {
  const model = new PursuitPpo("metro-observed-threat-development", null, schema.version);
  const hidden = model.layout.HIDDEN_BIAS / model.layout.INPUT, inputs = featureNames.length;
  const hiddenBias = inputs * hidden, outputWeights = hiddenBias + hidden;
  const outputBias = outputWeights + 4 * hidden, size = outputBias + 4;
  model.layout = { ...model.layout, INPUT: inputs, HIDDEN_BIAS: hiddenBias, OUTPUT_WEIGHTS: outputWeights,
    OUTPUT_BIAS: outputBias, PARAMETERS: size, std: updateConfig.std };
  model.weights = new Float64Array(size);
  model.firstMoment = new Float64Array(size);
  model.secondMoment = new Float64Array(size);
  const rng = new Random(model.seed);
  for (let i = 0; i < hiddenBias; i++) model.weights[i] = rng.range(-.7, .7);
  for (let i = outputWeights; i < outputBias; i++) model.weights[i] = rng.range(-.05, .05);
  return model;
}

function driver(prior, model, rng) {
  const observe = context();
  const stats = { admitted: 0, bypassed: 0 };
  const select = obs => {
    const base = prior.action(obs);
    const features = observe(obs);
    if (!features) {
      stats.bypassed++;
      return base;
    }
    stats.admitted++;
    return rng ? { ...model.sample(features, rng), obs: features } : model.action(features);
  };
  return { stats, select };
}

export async function loadThreatPrior() {
  const bytes = await readFile(priorPath);
  assert.equal(hash(bytes), threatPriorSha256);
  return freezePursuitPolicy(JSON.parse(bytes));
}

export function createFrozenThreatDriver(prior, data, arm = "candidate") {
  if (data?.format !== "metro-threat-context-development-only" || data.priorSha256 !== threatPriorSha256 ||
      prior?.observation !== schema.version || typeof prior.action !== "function" ||
      !Array.isArray(data.features) || data.features.length !== featureNames.length ||
      !featureNames.every((name, index) => data.features[index] === name) ||
      !["warm", "candidate"].includes(arm))
    throw new TypeError("Incompatible development threat policy");
  const state = data[arm], model = createModel();
  if (state?.schema !== 1 || state.algorithm !== model.checkpoint().algorithm ||
      state.observation !== schema.version || !Array.isArray(state.weights) ||
      state.weights.length !== model.layout.PARAMETERS ||
      !state.weights.every(value => Number.isFinite(value) && Math.abs(value) <= 1e4) ||
      (arm === "candidate" && ![state.updates, state.transitions, state.optimizerSteps]
        .every(value => Number.isSafeInteger(value) && value > 0)))
    throw new TypeError("Invalid development threat weights");
  model.weights.set(state.weights);
  return driver(prior, model);
}

async function main() {
  assert.ok(output, "Set a new proof output directory");
  const { measuredReference, run, stopControlHorizon, training, validation } =
    await import("./train-metro-lateral-development.mjs");
  const prior = await loadThreatPrior(), priorSha256 = threatPriorSha256;
  const report = { classification: "development-only sensor-conditioned actor; not a public policy",
    node: process.version, priorSha256, inputs: featureNames, updateConfig, training, validation, controls: [],
  teachers: [], results: [], controlsPassed: false, learnedPasses: 0 };
try {
  for (const layout of validation) {
    const reference = measuredReference(layout, "combined").summary;
    const stopped = run(layout, "combined", () => PURSUIT_STOP, null, stopControlHorizon).summary;
    const noTailDriver = driver(prior, null), noTail = run(layout, "no-tail", noTailDriver.select).summary;
    const stoppedNoTail = run(layout, "no-tail", () => PURSUIT_STOP, null, stopControlHorizon).summary;
    const rearOnly = run(layout, "rear-only", prior.action).summary;
    const valid = reference.pass && rearOnly.pass && reference.handoff.obsSha256 === stopped.handoff.obsSha256 &&
      stopped.incidents.some(event => event.type === "patrol_collision" && event.fresh) &&
      stoppedNoTail.noContact && noTailDriver.stats.admitted === 0;
    report.controls.push({ reference, stopped, stoppedNoTail, noTail, noTailStats: noTailDriver.stats, rearOnly, valid });
  }
  report.controlsPassed = report.controls.every(row => row.valid);
  assert.ok(report.controlsPassed, "An unchanged physical control failed; refuse to fit");

  const samples = [], validTeachers = [];
  for (const layout of training) for (const shift of [0, -.55, -1.1, .25]) {
    const variant = [...layout];
    variant[3] += shift;
    const teacher = measuredReference(variant, "combined");
    const observe = context();
    const admitted = teacher.samples.map(({ obs, action }) => ({ obs: observe(obs), action })).filter(row => row.obs);
    const usable = teacher.summary.pass && admitted.length >= 32;
    report.teachers.push({ variant, usable, admitted: admitted.length, trial: teacher.summary });
    if (!usable) continue;
    samples.push(...admitted);
    validTeachers.push(variant);
  }
  assert.ok(training.every(([road]) => validTeachers.some(variant => variant[0] === road)));
  const model = createModel(), adam = model.applyAdam.bind(model);
  model.applyAdam = grad => adam(grad, updateConfig.fitRate);
  const losses = model.warmStart(samples, updateConfig.fitEpochs), warm = model.checkpoint();
  report.fit = { samples: samples.length, firstLoss: losses[0], lastLoss: losses.at(-1) };
  model.applyAdam = grad => {
    adam(grad, updateConfig.ppoRate);
    for (let i = 0; i < model.weights.length; i++) {
      const { OUTPUT_WEIGHTS, OUTPUT_BIAS } = model.layout;
      if ((i >= OUTPUT_WEIGHTS + (OUTPUT_BIAS - OUTPUT_WEIGHTS) * .75 && i < OUTPUT_BIAS) || i === OUTPUT_BIAS + 3) continue;
      model.weights[i] += updateConfig.tether * (warm.weights[i] - model.weights[i]);
    }
  };
  const batch = [];
  report.onPolicy = [];
  for (const [i, layout] of validTeachers.entries()) {
    const policy = driver(prior, model, new Random(`${model.seed}:${i}`));
    const { rollout, summary } = run(layout, "combined", policy.select);
    assert.equal(rollout.length, policy.stats.admitted);
    assert.ok(rollout.length >= 32);
    // Each bounded observation window ends here; do not link advantage across resets.
    rollout.at(-1).episodeBootstrap = 0;
    batch.push(...rollout);
    report.onPolicy.push({ ...summary, stats: policy.stats });
  }
  report.update = model.update(batch);
  const next = model.checkpoint();
  assert.ok(next.weights.slice(0, model.layout.OUTPUT_WEIGHTS).some((value, i) => value !== warm.weights[i]));
  assert.throws(() => freezePursuitPolicy(next), /Incompatible/);
  const checkpoint = {
    format: "metro-threat-context-development-only", priorSha256, features: featureNames,
    fields: updateConfig, warm, candidate: next,
  };
  report.checkpointSha256 = await save("threat-context-checkpoint.json", checkpoint);
  const saved = JSON.parse(await readFile(join(output, "threat-context-checkpoint.json"), "utf8"));
  assert.throws(() => createFrozenThreatDriver(prior, { ...saved, features: saved.features.slice(1) }),
    /Incompatible development/);
  for (const layout of validation) for (const kind of ["combined", "rear-only"]) {
    const original = run(layout, kind, prior.action).summary;
    const rows = { original, layout, kind };
    for (const [arm, value] of [["warm", "warm"], ["ppo", "candidate"]]) {
      const policy = createFrozenThreatDriver(prior, saved, value);
      rows[arm] = { ...run(layout, kind, policy.select).summary, stats: policy.stats };
    }
    report.results.push(rows);
  }
  report.rearOnlyExact = report.results.filter(row => row.kind === "rear-only").every(row =>
    ["ppo", "warm"].every(arm => row[arm].stats.admitted === 0 &&
      JSON.stringify(row[arm].trace) === JSON.stringify(row.original.trace) && row[arm].pass));
  report.learnedPasses = report.results.filter(row => row.ppo.pass).length;
  report.warmPasses = report.results.filter(row => row.warm.pass).length;
  assert.ok(report.learnedPasses === 4 && report.rearOnlyExact, "The learned bypass failed one or more unchanged physical windows");
} finally {
  await save("threat-development.json", report);
  const brief = summary => [summary.pass, summary.handoff?.action.steer, summary.firstClearTick,
    summary.progressM, summary.noContact];
  console.log(JSON.stringify({ controlsPassed: report.controlsPassed, fit: report.fit, update: report.update,
    rearOnlyExact: report.rearOnlyExact, warmPasses: report.warmPasses, ppoPasses: report.learnedPasses,
    results: report.results.map(({ layout, kind, original, warm, ppo }) =>
      [layout[0], kind, brief(original), brief(warm), brief(ppo)]) }));
}
}

export { context as createThreatContext, createModel as createThreatLearner, driver as createThreatDriver,
  featureNames as threatFeatureNames };

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
