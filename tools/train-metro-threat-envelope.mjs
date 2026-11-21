import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PURSUIT_STOP } from "../src/core/pursuit-controls.js";
import { Random } from "../src/core/random.js";
import { run, training, validation } from "./train-metro-lateral-development.mjs";
import { createFrozenThreatDriver, createThreatContext, createThreatDriver, createThreatLearner,
  loadThreatPrior, threatFeatureNames, threatPriorSha256 } from "./train-metro-threat-development.mjs";

const output = process.env.PROVE_IT_OUTPUT_DIR;
assert.ok(output, "Set a new proof output directory");
const hash = data => createHash("sha256").update(data).digest("hex");
const previousSha256 = "650a977417d59d66b2cfbeb9bf3d669f49f57efb21c2be722dbec6d99f5250b0";
const previousBytes = await readFile(new URL(
  "../.runtime-proof/pursuit-rl-threat-development-20261121/runs/fit/20261121T034335-0ae6dd5f61/threat-context-checkpoint.json",
  import.meta.url));
assert.equal(hash(previousBytes), previousSha256);
const previous = JSON.parse(previousBytes);
const prior = await loadThreatPrior();
const settings = { warmEpochs: 54, warmRate: .0012, ppoRate: .000026, tether: .015, std: [.045, .07, .055],
  preferredRoadMarginM: .28, marginCost: .3, boundaryRejectCost: .065 };

const trainingProfiles = [[5, 14.5, 26.5, 4.95], [5.5, 15.2, 28, 5.55], [6.15, 14, 27, 4.05],
  [6.6, 16.5, 30.5, 5.10], [7.25, 15.5, 25.5, 3.55], [5.2, 13.2, 29, 4.7], [6, 13, 28, 5.8]];
const validationProfiles = [
  [[5.35, 14.75, 27.5, 5.25], [7.1, 15.7, 26.85, 4.25]],
  [[5.8, 13.85, 28.4, 5.3], [6.95, 15.85, 26.5, 4.45]],
];
const plans = [[6.1, 7.4, .72, .30], [5.6, 7.5, .72, .14], [4.8, 6.7, .82, .13],
  [5.2, 7, .65, .06], [5.5, 7, .70, .23], [5.4, 6.6, .59, .41], [4.85, 6.6, .54, .34],
  [6.7, 8, .74, .26], [5.05, 6.35, .57, .24], [5.4, 7.1, .59, .41], [5.9, 6.85, .65, .4],
  [6.1, 7.15, .65, .36], [4.9, 6.25, .53, .36], [6, 6.95, .60, .28], [6, 7.8, .70, .25],
  [6.2, 7, .58, .16]];
const layout = (site, [speed, frontGap, tailGap, closing]) =>
  [...site.slice(0, 3), speed, frontGap, tailGap, speed + closing];
const fitLayouts = training.flatMap(site => [site, ...trainingProfiles.map(profile => layout(site, profile))]);
const verifyLayouts = validation.flatMap((site, i) => validationProfiles[i].map(profile => layout(site, profile)));
assert.equal(fitLayouts.length, 24);
assert.equal(verifyLayouts.length, 4);
assert.ok(verifyLayouts.every(row => !fitLayouts.some(other => other[0] === row[0])));
assert.ok([...fitLayouts, ...verifyLayouts].every(row => row[0] !== "tahrir-boulevard"));

const physical = row => row.pass && row.roadBoundaryTicks === 0 &&
  (row.kind !== "combined" || (row.postClearAdvanceM >= 2 && row.postClearNonforwardTicks === 0));
const near = row => row.incidents.filter(event => event.type === "near_miss").length;
const freshRearHit = row => row.incidents.some(event => event.type === "patrol_collision" &&
  event.fresh && event.closingSpeed > .5);
const brief = row => ({ pass: physical(row), clear: row.firstClearTick, progress: row.progressM,
  roadBoundaryTicks: row.roadBoundaryTicks, roadMarginM: row.minimumRoadMarginM, postClearAdvanceM: row.postClearAdvanceM,
  nearMisses: near(row), hits: row.incidents.filter(event => event.fresh && event.type === "patrol_collision") });
async function save(name, obj) {
  const data = JSON.stringify(obj);
  await writeFile(join(output, name), data, { flag: "wx" });
  return hash(data);
}

function reference(site, preferMargin = false) {
  const attempts = plans.map(plan => run(site, "combined", () => null, plan));
  const marginShortfall = row => Math.max(0, settings.preferredRoadMarginM - row.minimumRoadMarginM);
  const accepted = attempts.filter(({ summary }) => physical(summary)).sort((a, b) =>
    (preferMargin ? marginShortfall(a.summary) - marginShortfall(b.summary) : 0) || near(a.summary) - near(b.summary));
  return { selected: accepted[0], attempts: attempts.map(({ summary }) => ({ plan: summary.plan, ...brief(summary) })) };
}

const report = { classification: "broader local physics and learning only", runtime: process.version, v8: process.versions.v8,
  previousSha256, settings, fitLayouts, verifyLayouts, plans, controls: [], controlsPassed: false };
const mode = process.argv[2];
assert.ok(["controls", "learning"].includes(mode));
try {
  for (const site of verifyLayouts) {
    const { selected, attempts } = reference(site);
    const stopped = run(site, "combined", () => PURSUIT_STOP).summary;
    const stopWithoutTail = run(site, "no-tail", () => PURSUIT_STOP).summary;
    const control = { site, reference: selected?.summary ?? null, attempts, stopped, stopWithoutTail,
      valid: Boolean(selected && selected.summary.handoff.obsSha256 === stopped.handoff.obsSha256 &&
        stopWithoutTail.noContact && stopWithoutTail.onRoad) };
    report.controls.push(control);
    console.log(JSON.stringify({ site: site[0], speed: site[3], valid: control.valid,
      stopContact: freshRearHit(stopped), witness: selected && brief(selected.summary) }));
  }
  report.controlCount = report.controls.length;
  report.controlsPassed = report.controls.every(row => row.valid) &&
    validation.every(site => report.controls.some(row => row.site[0] === site[0] && freshRearHit(row.stopped)));
  assert.ok(report.controlsPassed, "Not all stronger motion references or paired difficulty controls succeeded");

  if (mode === "learning") {
    const samples = [], feasible = [], attempts = [];
    report.teachers = attempts;
    for (const site of fitLayouts) {
      const { selected, attempts: physicalAttempts } = reference(site, true);
      const encode = createThreatContext();
      const admitted = selected?.samples.map(({ obs, action }) => ({ obs: encode(obs), action })).filter(row => row.obs) ?? [];
      attempts.push({ site, selected: selected?.summary ?? null, admitted: admitted.length, attempts: physicalAttempts });
      if (admitted.length < 32) continue;
      feasible.push(site);
      samples.push(...admitted);
    }
    assert.ok(training.every(road => feasible.filter(site => site[0] === road[0] && site[3] < 6.5).length >= 2));
    const model = createThreatLearner();
    model.weights.set(previous.candidate.weights);
    const adam = model.applyAdam.bind(model);
    model.applyAdam = grad => adam(grad, settings.warmRate);
    const losses = model.warmStart(samples, settings.warmEpochs), warm = model.checkpoint();
    model.layout = { ...model.layout, std: settings.std };
    model.applyAdam = grad => {
      adam(grad, settings.ppoRate);
      const { OUTPUT_WEIGHTS, OUTPUT_BIAS } = model.layout;
      const valueWeights = OUTPUT_WEIGHTS + (OUTPUT_BIAS - OUTPUT_WEIGHTS) * .75;
      for (let i = 0; i < model.weights.length; i++) {
        if ((i >= valueWeights && i < OUTPUT_BIAS) || i === OUTPUT_BIAS + 3) continue;
        model.weights[i] += settings.tether * (warm.weights[i] - model.weights[i]);
      }
    };
    const batch = [];
    report.onPolicy = [];
    for (const [i, site] of feasible.entries()) {
      const agent = createThreatDriver(prior, model, new Random(`${model.seed}:pressure-envelope:${i}`));
      const outcome = run(site, "combined", agent.select);
      assert.ok(outcome.rollout.length >= 32);
      assert.equal(outcome.rollout.length, agent.stats.admitted);
      let marginPenalty = 0, rejectedTicks = 0;
      for (const transition of outcome.rollout) {
        const margin = Math.max(0, settings.preferredRoadMarginM - transition.roadMarginM) * settings.marginCost;
        transition.reward -= margin + transition.deniedTicks * settings.boundaryRejectCost;
        marginPenalty += margin;
        rejectedTicks += transition.deniedTicks;
      }
      outcome.rollout.at(-1).episodeBootstrap = 0;
      batch.push(...outcome.rollout);
      report.onPolicy.push({ site, ...brief(outcome.summary), marginPenalty, rejectedTicks });
    }
    report.update = model.update(batch);
    const candidate = model.checkpoint();
    assert.ok(candidate.weights.slice(0, model.layout.OUTPUT_WEIGHTS).some((value, i) => value !== warm.weights[i]));
    const checkpoint = { format: "metro-threat-context-development-only", priorSha256: threatPriorSha256,
      features: threatFeatureNames, warm, candidate, fields: settings, previousSha256 };
    report.fit = { samples: samples.length, feasible: feasible.length, losses };
    report.sha256 = await save("threat-envelope-checkpoint.json", checkpoint);
    const saved = JSON.parse(await readFile(join(output, "threat-envelope-checkpoint.json"), "utf8"));
    report.validation = verifyLayouts.map(site => {
      const trial = (data, arm) => {
        const model = createFrozenThreatDriver(prior, data, arm);
        return { ...run(site, "combined", model.select).summary, stats: model.stats };
      };
      const previousResult = trial(previous), warmResult = trial(saved, "warm"), frozen = trial(saved);
      console.log(JSON.stringify({ site: site[0], speed: site[3], original: brief(previousResult),
        warm: brief(warmResult), frozen: brief(frozen) }));
      return { site, previous: previousResult, warm: warmResult, frozen };
    });
    report.rearOnly = validation.map(site => {
      const base = run(site, "rear-only", prior.action).summary;
      const policy = createFrozenThreatDriver(prior, saved), tested = run(site, "rear-only", policy.select).summary;
      return { base, tested, stats: policy.stats, exact: physical(tested) && policy.stats.admitted === 0 &&
        JSON.stringify(base.trace) === JSON.stringify(tested.trace) };
    });
    report.noTail = verifyLayouts.map(site => {
      const policy = createFrozenThreatDriver(prior, saved);
      return { site, summary: run(site, "no-tail", policy.select).summary, stats: policy.stats };
    });
    report.learnedPasses = report.validation.filter(row => physical(row.frozen) && row.frozen.stats.admitted > 0).length;
    report.rearOnlyExact = report.rearOnly.every(row => row.exact) && report.noTail.every(row => row.stats.admitted === 0);
    assert.ok(report.learnedPasses === 4 && report.rearOnlyExact, "The broader candidate still failed guarded transfer");
  }
} finally {
  await save("threat-envelope.json", report);
}
