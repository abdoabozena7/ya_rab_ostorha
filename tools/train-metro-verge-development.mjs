import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { clamp } from "../src/core/config.js";
import { angleDelta } from "../src/core/geometry.js";
import { PURSUIT_STOP } from "../src/core/pursuit-controls.js";
import { Random } from "../src/core/random.js";
import { getVehicleMounts, PLAYER_VEHICLE } from "../src/core/vehicle-spec.js";
import { CLEARANCE_ROUTE_OBSERVATION_SCHEMA as schema } from "../src/rl/gta-pursuit-env.js";
import { freezePursuitPolicy } from "../src/rl/pursuit-ppo.js";
import { run, training, validation } from "./train-metro-lateral-development.mjs";
import { createThreatContext, createThreatLearner, loadThreatPrior, threatFeatureNames,
  threatPriorSha256 } from "./train-metro-threat-development.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const envelope = new URL("../.runtime-proof/pursuit-rl-threat-envelope-20261121/revision-2/runs/learning/20261121T040230-bed272cab7/", import.meta.url);
const envelopeSha256 = "2d2f8417050624cb792fed9d575fea0860e30237ee800d56219a0a3e827eee60";
const initializerSha256 = "ffdcf6bb0323c33ac6640e547a0cc6031e565f21af8d8422bfc98f4475ae3985";
const format = "metro-verge-development-only-v1";
const features = [...threatFeatureNames, "roadAvailable", "roadLateral", "roadWidth", "roadHeading",
  "roadRightMargin", "roadLeftMargin", "roadRightProjectedMargin"];
const settings = Object.freeze({ warmEpochs: 76, warmRate: .0014, ppoRate: .000065, std: [.045, .07, .055],
  supportPreviewS: .35 });
const pulses = [[90, .24], [90, -.24], [126, .27], [126, -.27], [144, .2], [144, -.2]];
const preferredTeacher = [4.85, 6.6, .54, .34];
const earlierTeacher = [4.9, 6.25, .53, .36];
const mount = getVehicleMounts().telemetry.position;
const signed = (value, scale) => clamp(value / scale, -1, 1);

async function load(url, expected) {
  const bytes = await readFile(url);
  assert.equal(hash(bytes), expected, `Changed pinned development input: ${url.pathname}`);
  return JSON.parse(bytes);
}

function footprint(headingError) {
  return (PLAYER_VEHICLE.widthM * Math.abs(Math.cos(headingError)) +
    PLAYER_VEHICLE.lengthM * Math.abs(Math.sin(headingError))) / 2;
}

export function createVergeRoadObserver(roads) {
  const corridors = roads.filter(road => !road.parkingBay && !road.supportApron);
  return ({ positionM, headingRad }) => {
    const sin = Math.sin(headingRad), cos = Math.cos(headingRad);
    const center = { x: positionM.x - sin * mount.z - cos * mount.x,
      z: positionM.z - cos * mount.z + sin * mount.x };
    let selected, best = Infinity;
    for (const { axis, min, max, fixed, width } of corridors) {
      const along = center[axis], cross = axis === "x" ? center.z : center.x, halfWidth = width / 2;
      if (along < min || along > max || Math.abs(cross - fixed) > halfWidth) continue;
      const roadHeading = axis === "x" ? Math.sign(sin) * Math.PI / 2 : cos < 0 ? Math.PI : 0;
      const error = angleDelta(headingRad, roadHeading), alignment = Math.abs(error);
      if (alignment > .8) continue;
      const rank = alignment + .25 * Math.abs(cross - fixed) / halfWidth;
      if (rank >= best) continue;
      best = rank;
      selected = { halfWidth, lateral: (cross - fixed) * (axis === "x" ? -Math.sign(sin) : Math.sign(cos)), error };
    }
    return selected ?? null;
  };
}

function encode() {
  const history = createThreatContext();
  return (obs, road, maskRoad = false) => {
    const base = history(obs);
    if (!base) return null;
    const result = new Float32Array(features.length);
    result.set(base);
    if (road && !maskRoad) {
      const { halfWidth, lateral, error } = road, extent = footprint(error), t = settings.supportPreviewS;
      const yaw = obs[3] * schema.scales.yawRadS, steer = obs[1] * schema.scales.steerRad;
      const heading = error + yaw * t / 2;
      const sideways = obs[0] * schema.scales.speedMps * Math.sin(heading + Math.atan(.5 * Math.tan(steer))) +
        obs[2] * schema.scales.slipMps * Math.cos(heading);
      result.set([1, signed(lateral, 8), signed(halfWidth, 8), signed(error, .8),
        signed(halfWidth - lateral - extent, 4), signed(halfWidth + lateral - extent, 4),
        signed(halfWidth - lateral - sideways * t - footprint(error + yaw * t), 4)], base.length);
    }
    return result;
  };
}

function learner(initializer, initialInputs = threatFeatureNames.length, inputs = features.length) {
  const model = createThreatLearner();
  const hidden = model.layout.HIDDEN_BIAS / threatFeatureNames.length;
  const hiddenBias = inputs * hidden, outputWeights = hiddenBias + hidden, outputBias = outputWeights + 4 * hidden;
  const size = outputBias + 4;
  model.layout = { ...model.layout, INPUT: inputs, HIDDEN_BIAS: hiddenBias, OUTPUT_WEIGHTS: outputWeights,
    OUTPUT_BIAS: outputBias, PARAMETERS: size, std: settings.std };
  model.weights = new Float64Array(size);
  model.firstMoment = new Float64Array(size);
  model.secondMoment = new Float64Array(size);
  if (initializer) {
    assert.equal(initializer.weights.length, hidden * initialInputs + 5 * hidden + 4);
    for (let h = 0; h < hidden; h++)
      model.weights.set(initializer.weights.slice(h * initialInputs, (h + 1) * initialInputs), h * inputs);
    model.weights.set(initializer.weights.slice(initialInputs * hidden), hiddenBias);
  }
  return model;
}

function driver(prior, model, rng, maskRoad) {
  const observe = encode(), stats = { admitted: 0, missingRoad: 0 };
  const select = (obs, road) => {
    const input = observe(obs, road, maskRoad);
    if (!input) return prior.action(obs);
    stats.admitted++;
    if (!road) stats.missingRoad++;
    return rng ? { ...model.sample(input, rng), obs: input } : model.action(input);
  };
  return { select, stats };
}

export function createFrozenVergeDriver(prior, checkpoint, arm = "candidate") {
  if (checkpoint?.format !== format || checkpoint.priorSha256 !== threatPriorSha256 ||
      checkpoint.initializerSha256 !== initializerSha256 || !Array.isArray(checkpoint.features) ||
      checkpoint.features.length !== features.length || !features.every((name, i) => name === checkpoint.features[i]) ||
      prior?.observation !== schema.version || !["candidate", "warm", "masked"].includes(arm))
    throw new TypeError("Incompatible Metro verge development checkpoint");
  const model = learner(), state = checkpoint[arm];
  if (state?.schema !== 1 || state.observation !== schema.version || state.algorithm !== model.checkpoint().algorithm ||
      !Array.isArray(state.weights) || state.weights.length !== model.layout.PARAMETERS ||
      !state.weights.every(weight => Number.isFinite(weight) && Math.abs(weight) <= 1e4) ||
      (arm === "candidate" && ![state.updates, state.transitions, state.optimizerSteps]
        .every(value => Number.isSafeInteger(value) && value > 0)))
    throw new TypeError("Invalid Metro verge development weights");
  model.weights.set(state.weights);
  return driver(prior, model, null, arm === "masked");
}

const physicsPass = row => row.pass && row.roadBoundaryTicks === 0 &&
  (row.kind !== "combined" || (row.postClearAdvanceM >= 2 && row.postClearNonforwardTicks === 0));
const activeRearHit = row => row.incidents.some(event => event.type === "patrol_collision" &&
  event.fresh && event.closingSpeed > .5);
const brief = row => ({ pass: physicsPass(row), clear: row.firstClearTick, denials: row.roadBoundaryTicks,
  postClearAdvanceM: row.postClearAdvanceM, minimumRoadMarginM: row.minimumRoadMarginM,
  hits: row.incidents.filter(event => event.fresh && event.type === "patrol_collision"), stats: row.stats });
const localRun = (site, kind, select, plan = null, audit = false, perturbReference) =>
  run(site, kind, select, plan, undefined, audit, { createRoadObserver: createVergeRoadObserver, perturbReference });

function controlRows(pinned) {
  const matched = pinned.controls.map(({ site, reference, stopped, stopWithoutTail }) => {
    const teacher = localRun(site, "combined", () => assert.fail("The reference was not applied"), reference.plan, true);
    const withTail = localRun(site, "combined", () => PURSUIT_STOP);
    const noTail = localRun(site, "no-tail", () => PURSUIT_STOP);
    assert.deepEqual(teacher.summary, reference);
    assert.deepEqual(withTail.summary, stopped);
    assert.deepEqual(noTail.summary, stopWithoutTail);
    assert.deepEqual(teacher.samples[0].road, noTail.samples[0].road);
    assert.notDeepEqual(teacher.samples[0].obs, noTail.samples[0].obs);
    const errors = teacher.samples.map(({ road }, i) => {
      assert.ok(road, "A continuous avenue needs an available static corridor");
      const extent = footprint(road.error), actual = teacher.motionAudit[i];
      return Math.max(Math.abs(road.halfWidth - road.lateral - extent - actual.rightMarginM),
        Math.abs(road.halfWidth + road.lateral - extent - actual.leftMarginM));
    });
    const maxMarginErrorM = Math.max(...errors), rearHit = activeRearHit(withTail.summary);
    assert.ok(maxMarginErrorM < 1e-8 && physicsPass(teacher.summary) && noTail.summary.noContact);
    return { site, roadCuesIndependentAtHandoff: true, maxMarginErrorM, rearHit,
      reference: teacher.summary, stopped: withTail.summary, stopWithoutTail: noTail.summary };
  });
  assert.ok(validation.every(site => matched.some(row => row.site[0] === site[0] && row.rearHit)));
  return matched;
}

function collect(pinned) {
  const eligibleSites = new Set(training.map(([road]) => road));
  const samples = [], curriculum = [], trials = [];
  let recoverySamples = 0;
  for (const { site, attempts, selected } of pinned.teachers) {
    assert.ok(eligibleSites.has(site[0]), "Only the original training partition may contribute labels");
    const feasible = attempts.filter(row => row.pass);
    const presets = [preferredTeacher, earlierTeacher];
    const primary = presets.find(plan => feasible.some(row => row.plan.every((value, i) => value === plan[i]))) ??
      selected?.plan;
    if (!primary) continue;
    const normal = localRun(site, "combined", () => null, primary);
    assert.ok(physicsPass(normal.summary));
    curriculum.push(site);
    const add = (rollout, since = 0) => {
      const observe = encode();
      const before = samples.length;
      for (const [i, { obs, road, action, teacherAction }] of rollout.samples.entries()) {
        const input = observe(obs, road);
        if (input && i >= since) samples.push({ obs: input, action: teacherAction ?? action });
      }
      return samples.length - before;
    };
    const examples = add(normal), recovery = [];
    for (const [tick, amount] of pulses) {
      const perturbed = localRun(site, "combined", () => null, primary, false, (at, action) =>
        at >= tick && at < tick + 18 ? { ...action, steer: clamp(action.steer + amount, -1, 1) } : action);
      const peakDeviationM = Math.max(...perturbed.summary.trace.map((row, i) =>
        Math.abs(row.lateralM - normal.summary.trace[i].lateralM)));
      const admitted = physicsPass(perturbed.summary) && peakDeviationM > .1 ?
        add(perturbed, (tick + 6 - 12) / 6) : 0;
      recoverySamples += admitted;
      recovery.push({ tick, amount, peakDeviationM, admitted, measured: brief(perturbed.summary) });
    }
    trials.push({ site, normal: brief(normal.summary), examples, recovery });
  }
  assert.ok(training.every(([road]) => trials.some(row => row.site[0] === road && row.recovery.some(pulse => pulse.admitted))),
    "Every training site needs measured off-reference corrections");
  return { samples, curriculum, trials, recoverySamples };
}

async function main() {
  const output = process.env.PROVE_IT_OUTPUT_DIR, mode = process.argv[2];
  assert.ok(output && ["controls", "learning"].includes(mode), "Select a mode and a fresh proof output directory");
  const save = async (file, value) => {
    const text = JSON.stringify(value);
    await writeFile(join(output, file), text, { flag: "wx" });
    return hash(text);
  };
  const pinned = await load(new URL("threat-envelope.json", envelope), envelopeSha256);
  const report = { classification: "standalone Metro development only; no browser or independent acceptance",
    initializerSha256, envelopeSha256, runtime: process.version, v8: process.versions.v8, settings, features };
  try {
    report.controls = controlRows(pinned);
    report.controlsCount = report.controls.length;
    report.controlsPassed = report.controlsCount === 4;
    assert.ok(report.controlsPassed);
    if (mode === "controls") return;

    const initializer = await load(new URL("threat-envelope-checkpoint.json", envelope), initializerSha256);
    const prior = await loadThreatPrior();
    const { samples, curriculum, trials, recoverySamples } = collect(pinned);
    const fit = data => {
      const model = learner(initializer.candidate), adam = model.applyAdam.bind(model);
      model.applyAdam = grad => adam(grad, settings.warmRate);
      const losses = model.warmStart(data, settings.warmEpochs);
      model.applyAdam = grad => adam(grad, settings.ppoRate);
      return { model, losses, snapshot: model.checkpoint() };
    };
    const { model, losses, snapshot: warm } = fit(samples);
    const maskedSamples = samples.map(({ obs, action }) => {
      const withoutRoad = obs.slice();
      withoutRoad.fill(0, threatFeatureNames.length);
      return { obs: withoutRoad, action };
    });
    const { snapshot: masked, losses: maskedLosses } = fit(maskedSamples);
    report.fit = { samples: samples.length, recoverySamples, lessons: curriculum.length, losses, maskedLosses, trials };

    const rollout = [];
    report.onPolicy = curriculum.map((site, i) => {
      const actor = driver(prior, model, new Random(`${model.seed}:verge-development:${i}`), false);
      const outcome = localRun(site, "combined", actor.select);
      assert.ok(outcome.rollout.length >= 32);
      assert.equal(outcome.rollout.length, actor.stats.admitted);
      outcome.rollout.at(-1).episodeBootstrap = 0;
      rollout.push(...outcome.rollout);
      return { site, ...brief(outcome.summary), stats: actor.stats };
    });
    report.update = model.update(rollout);
    const candidate = model.checkpoint();
    assert.ok(candidate.weights.slice(0, model.layout.OUTPUT_WEIGHTS).some((value, i) => value !== warm.weights[i]));
    assert.throws(() => freezePursuitPolicy(candidate), /Incompatible/);
    const checkpoint = { format, priorSha256: threatPriorSha256, initializerSha256, features, settings, candidate, warm, masked };
    report.checkpointSha256 = await save("verge-checkpoint.json", checkpoint);
    const saved = await load(pathToFileURL(resolve(output, "verge-checkpoint.json")), report.checkpointSha256);
    assert.throws(() => createFrozenVergeDriver(prior, { ...saved, features: [] }), /Incompatible Metro/);

    report.validation = pinned.validation.map(({ site, previous, frozen }) => {
      const outcomes = {};
      for (const arm of ["masked", "warm", "candidate"]) {
        const policy = createFrozenVergeDriver(prior, saved, arm);
        outcomes[arm] = { ...localRun(site, "combined", policy.select).summary, stats: policy.stats };
      }
      console.log(JSON.stringify({ site, previous: brief(previous), rejected: brief(frozen),
        ...Object.fromEntries(Object.entries(outcomes).map(([name, row]) => [name, brief(row)])) }));
      return { site, previous: brief(previous), rejected: brief(frozen), ...outcomes };
    });
    const nonAdmitted = (site, kind) => {
      const baseline = localRun(site, kind, prior.action).summary;
      const actor = createFrozenVergeDriver(prior, saved), observed = localRun(site, kind, actor.select).summary;
      return { site, kind, baseline, observed, stats: actor.stats, exact: actor.stats.admitted === 0 &&
        JSON.stringify(baseline) === JSON.stringify(observed) && (kind !== "rear-only" || physicsPass(observed)) };
    };
    report.nonAdmitted = [...validation.map(site => nonAdmitted(site, "rear-only")),
      ...pinned.verifyLayouts.map(site => nonAdmitted(site, "no-tail"))];
    report.nonAdmittedExact = report.nonAdmitted.every(row => row.exact);
    const passes = row => physicsPass(row) && row.stats.admitted > 0 && row.stats.missingRoad === 0;
    report.learnedPasses = report.validation.filter(row => passes(row.candidate)).length;
    report.warmPasses = report.validation.filter(row => passes(row.warm)).length;
    report.maskedPasses = report.validation.filter(row => passes(row.masked)).length;
    assert.ok(report.learnedPasses === 4 && report.nonAdmittedExact, "Static road cues and recovery labels did not pass local transfer");
  } finally {
    await save("verge-development.json", report);
  }
}

export { encode as createVergeContext, learner as createVergeLearner, features as vergeFeatureNames };

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
