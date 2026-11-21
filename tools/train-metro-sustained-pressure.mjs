import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { clamp } from "../src/core/config.js";
import { PATROL_TRAFFIC_PREVIEW } from "../src/core/pursuit-gta.js";
import { Random } from "../src/core/random.js";
import { CLEARANCE_ROUTE_OBSERVATION_SCHEMA as schema } from "../src/rl/gta-pursuit-env.js";
import { freezePursuitPolicy } from "../src/rl/pursuit-ppo.js";
import { run, training, validation } from "./train-metro-lateral-development.mjs";
import { loadThreatPrior } from "./train-metro-threat-development.mjs";
import { createFrozenVergeDriver, createVergeContext, createVergeLearner, createVergeRoadObserver,
  vergeFeatureNames } from "./train-metro-verge-development.mjs";

const output = process.env.PROVE_IT_OUTPUT_DIR, mode = process.argv[2];
const last = new URL("../.runtime-proof/pursuit-rl-verge-development-20261121/runs/learning/20261121T041332-940bfba341/", import.meta.url);
const envelope = new URL("../.runtime-proof/pursuit-rl-threat-envelope-20261121/revision-2/runs/learning/20261121T040230-bed272cab7/threat-envelope.json", import.meta.url);
const vergeSha256 = "30c05559c080d7a8eafaa6c788e3a7ca322405872052d9361fe48145c473b4c3";
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
async function read(path, expected) {
  const bytes = await readFile(path);
  assert.equal(hash(bytes), expected, `Changed input: ${path}`);
  return JSON.parse(bytes);
}
async function save(file, value) {
  const text = JSON.stringify(value);
  await writeFile(join(output, file), text, { flag: "wx" });
  return hash(text);
}

const endTick = 264, originalEndTick = 228;
const options = { createRoadObserver: createVergeRoadObserver };
const trace = (site, kind, policy, plan, end, audit = false) =>
  run(site, kind, policy, plan, end, audit, options);
const continued = row => row.tick === endTick && row.onRoad && row.noContact && row.clearanceOK &&
  row.firstClearTick !== null && row.firstClearTick <= originalEndTick - 36 &&
  row.handoff.rear?.forwardMps > 1.5 && row.handoff.tailDistance > 1 && row.patrolM - row.handoff.tailDistance > 8 &&
  row.roadBoundaryTicks === 0 && row.postClearAdvanceM >= 2 && row.postClearNonforwardTicks === 0;
const original = row => row.pass && row.roadBoundaryTicks === 0 &&
  row.postClearAdvanceM >= 2 && row.postClearNonforwardTicks === 0;
const rearHits = row => row.incidents.filter(event => event.type === "patrol_collision" && event.fresh);
const score = row => ({ tick: row.tick, clear: row.firstClearTick, roadDenials: row.roadBoundaryTicks,
  postClearAdvanceM: row.postClearAdvanceM, hits: rearHits(row), noContact: row.noContact });

const pinned = await read(envelope, "2d2f8417050624cb792fed9d575fea0860e30237ee800d56219a0a3e827eee60");
const base = await read(new URL("verge-checkpoint.json", last), vergeSha256);
const preserved = await read(new URL("verge-development.json", last),
  "800de2307ecbc67e8b2af1e86a4f2587bfbabc5e9ce6d403ed34996cb488b10f");
const prior = await loadThreatPrior();
const report = { classification: "standalone Metro research course; no product or independent acceptance",
  vergeSha256, node: process.version, v8: process.versions.v8, originalEndTick, endTick };

function controls() {
  const rows = pinned.controls.map(({ site, reference }, i) => {
    const script = () => assert.fail("Expected the pinned physical witness");
    const short = trace(site, "combined", script, reference.plan, originalEndTick).summary;
    const long = trace(site, "combined", script, reference.plan, endTick).summary;
    assert.deepEqual(short, reference);
    assert.ok(original(short) && continued(long));
    assert.deepEqual(long.trace.slice(0, short.trace.length), short.trace);
    const shortDriver = createFrozenVergeDriver(prior, base), longDriver = createFrozenVergeDriver(prior, base);
    const past = trace(site, "combined", shortDriver.select, null, originalEndTick).summary;
    const prolonged = trace(site, "combined", longDriver.select, null, endTick).summary;
    assert.deepEqual({ ...past, stats: shortDriver.stats }, preserved.validation[i].candidate);
    assert.deepEqual(prolonged.trace.slice(0, past.trace.length), past.trace);
    return { site, short, long, past, prolonged, extraHits: rearHits(prolonged).filter(hit => hit.tick > originalEndTick) };
  });
  report.controls = rows;
  report.controlsCount = rows.length;
  report.additionalImpactTick = rows.find(row => original(row.past) && row.extraHits.length)?.extraHits[0].tick;
  assert.equal(report.additionalImpactTick, 230);
  assert.equal(rows.filter(row => continued(row.prolonged)).length, 1);
}

const extra = ["freshRear", "rearSurfaceForward", "rearSurfaceRight", "rearMotionKnown",
  "rearSurfaceForwardRate", "rearSurfaceRightRate", "rearTtcKnown", "rearTtc"];
const features = [...vergeFeatureNames, ...extra], start = vergeFeatureNames.length;
const format = "metro-sustained-pressure-development-v1";
const settings = { warmEpochs: 75, warmRate: .0013, ppoRate: .00013, std: [.06, .085, .06], repeats: 3, updates: 2 };

function observe() {
  const roadContext = createVergeContext();
  return (obs, road, mask = false) => {
    const base = roadContext(obs, road);
    if (!base) return null;
    const input = new Float32Array(features.length);
    input.set(base);
    if (mask) return input;
    const { tracks, scales } = schema;
    let nearest, range = Infinity;
    for (let i = 0; i < tracks.count; i++) {
      const offset = tracks.offset + i * tracks.stride;
      const t = obs.subarray(offset, offset + tracks.stride);
      if (t[0] && t[4] && t[6] < 0 && t[9] === 0) {
        const d = Math.hypot(t[5], t[6]);
        if (d < range) [nearest, range] = [t, d];
      }
    }
    if (nearest) {
      const [, , , , , right, forward, rightRate, forwardRate, , motion, timed, ttc] = nearest;
      input.set([1, clamp(forward * scales.offsetM / 28, -1, 0),
        clamp(right * scales.offsetM / 10, -1, 1), motion,
        motion ? clamp(forwardRate * scales.relativeSpeedMps / 12, -1, 1) : 0,
        motion ? clamp(rightRate * scales.relativeSpeedMps / 12, -1, 1) : 0, timed, timed ? ttc : 0], start);
    }
    return input;
  };
}

function teacherRollout(site, plan, audit, perturbReference) {
  return run(site, "combined", () => assert.fail("Expected a training reference"), plan, endTick, audit,
    { ...options, perturbReference });
}

function lessons() {
  const permitted = new Set(training.map(site => site[0]));
  const samples = [], sites = [], evidence = [];
  let recoverySamples = 0;
  for (const { site, attempts } of pinned.teachers) {
    assert.ok(permitted.has(site[0]));
    const candidates = attempts.filter(row => row.pass).map(row => teacherRollout(site, row.plan, true));
    const minimumRearGapM = row => Math.min(...row.motionAudit.slice(-18)
      .map(({ tailForwardM, tailRightM }) => Math.hypot(tailForwardM, tailRightM)));
    const viable = candidates.filter(row => continued(row.summary)).sort((a, b) => minimumRearGapM(b) - minimumRearGapM(a));
    const selected = viable[0];
    if (!selected) {
      evidence.push({ site, considered: candidates.length, selected: null });
      continue;
    }
    const add = (trial, since) => {
      const encode = observe();
      const before = samples.length;
      trial.samples.forEach(({ obs, road, action, teacherAction }, i) => {
        const input = encode(obs, road);
        if (input && 12 + 6 * i >= since) samples.push({ obs: input, action: teacherAction ?? action });
      });
      return samples.length - before;
    };
    sites.push(site);
    const nominal = add(selected, 0), recovered = [];
    for (const [onset, pulse] of [[78, -.23], [78, .23], [114, -.23], [114, .23]]) {
      const out = teacherRollout(site, selected.summary.plan, false, (tick, action) =>
        tick >= onset && tick < onset + 18 ? { ...action, steer: clamp(action.steer + pulse, -1, 1) } : action);
      const peakDeviationM = Math.max(...out.summary.trace.map((row, i) =>
        Math.abs(row.lateralM - selected.summary.trace[i].lateralM)));
      const retained = continued(out.summary) && peakDeviationM > .1 ? add(out, onset + 6) : 0;
      recoverySamples += retained;
      recovered.push({ onset, pulse, peakDeviationM, retained, ...score(out.summary) });
    }
    evidence.push({ site, considered: candidates.length, continuing: viable.length,
      selected: selected.summary.plan, minimumRearGapM: minimumRearGapM(selected), nominal, recovered });
  }
  assert.ok(training.every(([road]) => sites.some(site => site[0] === road)));
  return { sites, samples, evidence, recoverySamples };
}

function actor(model, masked = false, rng) {
  const encode = observe(), stats = { admitted: 0, freshRear: 0, withMotion: 0, missingRoad: 0 };
  const select = (obs, road) => {
    const input = encode(obs, road, masked);
    if (!input) return prior.action(obs);
    stats.admitted++;
    if (!road) stats.missingRoad++;
    stats.freshRear += input[start];
    stats.withMotion += input[start + 3];
    return rng ? { ...model.sample(input, rng), obs: input } : model.action(input);
  };
  return { select, stats };
}

export function restoreSustainedActor(checkpoint, arm = "candidate") {
  if (checkpoint?.format !== format || checkpoint.vergeSha256 !== vergeSha256 ||
      !Array.isArray(checkpoint.features) || checkpoint.features.length !== features.length ||
      !features.every((name, i) => checkpoint.features[i] === name) ||
      !["candidate", "warm", "masked"].includes(arm))
    throw new TypeError("Incompatible sustained pressure research checkpoint");
  const state = checkpoint[arm], loaded = createVergeLearner(null, start, features.length);
  if (state?.schema !== 1 || state.observation !== schema.version || state.algorithm !== loaded.checkpoint().algorithm ||
      !Array.isArray(state.weights) || state.weights.length !== loaded.layout.PARAMETERS ||
      !state.weights.every(weight => Number.isFinite(weight) && Math.abs(weight) <= 1e4) ||
      (arm === "candidate" && ![state.updates, state.transitions, state.optimizerSteps]
        .every(value => Number.isSafeInteger(value) && value > 0)))
    throw new TypeError("Invalid sustained pressure research weights");
  loaded.weights.set(state.weights);
  return actor(loaded, arm === "masked");
}

async function train() {
  const { sites, evidence, samples, recoverySamples } = lessons();
  assert.ok(recoverySamples && samples.some(row => row.obs[start] && row.obs[start + 3]));
  const fit = (mask) => {
    const model = createVergeLearner(base.candidate, start, features.length), adam = model.applyAdam.bind(model);
    model.layout = { ...model.layout, std: settings.std };
    model.applyAdam = grad => adam(grad, settings.warmRate);
    const data = mask ? samples.map(({ obs, action }) => {
      const input = obs.slice();
      input.fill(0, start);
      return { obs: input, action };
    }) : samples;
    const losses = model.warmStart(data, settings.warmEpochs);
    model.applyAdam = grad => adam(grad, settings.ppoRate);
    return { model, losses, warm: model.checkpoint() };
  };
  const { model, losses, warm } = fit(false), { warm: masked, losses: maskedLosses } = fit(true);
  report.fit = { lessons: sites.length, samples: samples.length, recoverySamples, evidence, losses, maskedLosses, settings, features };
  report.updates = [];
  let transitions = 0;
  for (let update = 0; update < settings.updates; update++) {
    const batch = [], episodes = [];
    for (const [i, site] of sites.entries()) for (let j = 0; j < settings.repeats; j++) {
      const policy = actor(model, false, new Random(`${model.seed}:sustained:${update}:${i}:${j}`));
      const outcome = trace(site, "combined", policy.select, null, endTick);
      assert.ok(outcome.rollout.length > 12);
      assert.equal(outcome.rollout.length, policy.stats.admitted);
      outcome.rollout.at(-1).episodeBootstrap = 0;
      batch.push(...outcome.rollout);
      episodes.push({ site, ...score(outcome.summary), stats: policy.stats });
    }
    transitions += batch.length;
    report.updates.push({ ...model.update(batch), episodes });
  }
  report.transitions = transitions;
  const candidate = model.checkpoint();
  assert.equal(candidate.updates, settings.updates);
  assert.equal(candidate.transitions, transitions);
  assert.ok(candidate.weights.slice(0, model.layout.OUTPUT_WEIGHTS).some((x, i) => x !== warm.weights[i]));
  assert.throws(() => freezePursuitPolicy(candidate), /Incompatible/);
  const checkpoint = { format, vergeSha256, features, candidate, warm, masked };
  report.checkpointSha256 = await save("sustained-checkpoint.json", checkpoint);
  const saved = await read(join(output, "sustained-checkpoint.json"), report.checkpointSha256);
  const frozen = arm => restoreSustainedActor(saved, arm);
  report.validation = pinned.verifyLayouts.map(site => {
    const compare = arm => {
      const short = frozen(arm), long = frozen(arm);
      const first = trace(site, "combined", short.select, null, originalEndTick).summary;
      const last = trace(site, "combined", long.select, null, endTick).summary;
      assert.deepEqual(last.trace.slice(0, first.trace.length), first.trace);
      assert.ok(short.stats.admitted > 0 && long.stats.admitted >= short.stats.admitted &&
        (arm === "masked" || short.stats.withMotion > 0));
      return { shortPass: original(first) && short.stats.missingRoad === 0,
        longPass: continued(last) && long.stats.missingRoad === 0, first, last, stats: long.stats };
    };
    const rows = Object.fromEntries(["masked", "warm", "candidate"].map(arm => [arm, compare(arm)]));
    console.log(JSON.stringify({ site, ...Object.fromEntries(Object.entries(rows).map(([arm, row]) =>
      [arm, { short: row.shortPass, long: row.longPass, ...score(row.last) }])) }));
    return { site, ...rows };
  });
  const unchanged = (site, kind) => {
    const driver = frozen("candidate"), old = trace(site, kind, prior.action, null, endTick).summary;
    const next = trace(site, kind, driver.select, null, endTick).summary;
    assert.deepEqual(old, next);
    return driver.stats.admitted === 0;
  };
  report.nonAdmittedExact = [...validation.map(site => unchanged(site, "rear-only")),
    ...pinned.verifyLayouts.map(site => unchanged(site, "no-tail"))].every(Boolean);
  const counts = arm => ["shortPass", "longPass"].map(field => report.validation.filter(row => row[arm][field]).length);
  [report.shortPasses, report.longPasses] = counts("candidate");
  report.warmPasses = counts("warm");
  report.maskedPasses = counts("masked");
  assert.ok(report.shortPasses === 4 && report.longPasses === 4 && report.nonAdmittedExact,
    "The frozen actor failed the continued physical safety requirement");
}

async function compareSavedPatrolProfiles() {
  const folder = new URL("../.runtime-proof/pursuit-rl-sustained-pressure-20261121/runs/fit/", import.meta.url);
  const runs = [
    ["before-ambient-reward", "20261121T041811-efe40aab39",
      "610f19db04f166e6907b3e1661ad70d297f57efe5a7373a2523ad6420eee0c84",
      "33fdcb83a4d23f85d16a35a70266dbaac4b894e8af47ade63925b7ade63ea6cf"],
    ["ambient-reward", "20261121T042613-0014298b7d",
      "d3c5e4efa00c28a6c4343ec6f598310513eb5d719ec471cc921e5b16f0520834",
      "661054940833c9b50bd1dd4fffd60ca5ba78e4b1309866434ad553d4d6c8ef76"],
  ];
  const paired = report.paired = { profile: PATROL_TRAFFIC_PREVIEW, defaultArms: 0, candidates: [] };
  for (const [label, name, checkpointSha256, reportSha256] of runs) {
    const root = new URL(`${name}/`, folder);
    const checkpoint = await read(new URL("sustained-checkpoint.json", root), checkpointSha256);
    const originalRun = await read(new URL("sustained-pressure.json", root), reportSha256);
    assert.equal(originalRun.checkpointSha256, checkpointSha256);
    const cases = originalRun.validation.map(({ site, candidate }) => {
      assert.ok(pinned.verifyLayouts.some(layout => JSON.stringify(site) === JSON.stringify(layout)));
      const compare = (end, expected) => {
        const control = restoreSustainedActor(checkpoint);
        const baseline = trace(site, "combined", control.select, null, end).summary;
        assert.deepEqual(baseline, expected);
        paired.defaultArms++;
        const newActor = restoreSustainedActor(checkpoint);
        let firstYield = null, finalPatrolSpeed = 0;
        const updated = run(site, "combined", newActor.select, null, end, false, { ...options,
          patrolTrafficPreview: PATROL_TRAFFIC_PREVIEW,
          observeTick(world, tail) {
            finalPatrolSpeed = tail.speed;
            if (tail.reason === "traffic-yield" && tail.speed < tail.previous.speed)
              firstYield ??= world.tick;
          },
        }).summary;
        assert.deepEqual(updated.handoff, baseline.handoff);
        assert.ok(newActor.stats.admitted > 0 && newActor.stats.withMotion > 0);
        const pass = (end === endTick ? continued(updated) : original(updated)) &&
          newActor.stats.missingRoad === 0 && firstYield !== null && finalPatrolSpeed > 3;
        return { pass, baseline, updated, stats: newActor.stats, firstYield, finalPatrolSpeed };
      };
      const short = compare(originalEndTick, candidate.first), long = compare(endTick, candidate.last);
      assert.deepEqual(long.updated.trace.slice(0, short.updated.trace.length), short.updated.trace);
      console.log(JSON.stringify({ label, site, short: short.pass, long: long.pass, ...score(long.updated),
        incidents: long.updated.incidents.filter(event => event.type !== "near_miss") }));
      return { site, short, long };
    });
    const inactive = (site, kind) => {
      const control = trace(site, kind, prior.action, null, endTick).summary;
      const tested = restoreSustainedActor(checkpoint);
      const next = run(site, kind, tested.select, null, endTick, false,
        { ...options, patrolTrafficPreview: PATROL_TRAFFIC_PREVIEW }).summary;
      assert.deepEqual(next, control);
      return { site, kind, unchanged: tested.stats.admitted === 0 };
    };
    const nonAdmitted = [...validation.map(site => inactive(site, "rear-only")),
      ...pinned.verifyLayouts.map(site => inactive(site, "no-tail"))];
    paired.candidates.push({ label, checkpointSha256, cases, nonAdmitted,
      shortPasses: cases.filter(row => row.short.pass).length, longPasses: cases.filter(row => row.long.pass).length });
  }
  paired.nonAdmittedExact = paired.candidates.every(candidate => candidate.nonAdmitted.every(row => row.unchanged));
  paired.qualifyingCandidates = paired.candidates.filter(row => row.shortPasses === 4 && row.longPasses === 4).length;
  assert.ok(paired.nonAdmittedExact && paired.qualifyingCandidates,
    "Neither saved actor met the closed-loop extended course requirement");
}

async function fitBothPatrolProfiles() {
  const initialSha256 = "610f19db04f166e6907b3e1661ad70d297f57efe5a7373a2523ad6420eee0c84";
  const checkpoint = await read(new URL(
    "../.runtime-proof/pursuit-rl-sustained-pressure-20261121/runs/fit/20261121T041811-efe40aab39/sustained-checkpoint.json",
    import.meta.url), initialSha256);
  const profiles = [{ label: "ordinary" }, { label: "preview", patrolTrafficPreview: PATROL_TRAFFIC_PREVIEW }];
  const recipe = { warmEpochs: 64, warmRate: .0008, ppoRate: .00004, updates: 2,
    takeoverTicks: [54, 72, 84, 114, 144], maximumRecoveryPlans: 3 };
  const paired = report.pairedFit = { initialSha256, profiles, recipe, curriculum: [] };
  const evaluate = (site, kind, select, plan, end, profile, extra) =>
    run(site, kind, select, plan, end, false, { ...options, patrolTrafficPreview: profile.patrolTrafficPreview, ...extra });
  const safe = row => continued(row) && row.trace.slice(-6).every(step => step.speed > 2);
  const lessons = [], samples = [];
  let recoverySamples = 0;
  for (const { site, attempts } of pinned.teachers) {
    assert.ok(training.some(([road]) => road === site[0]));
    const reference = (plan, profile, perturbReference) =>
      evaluate(site, "combined", () => assert.fail("Expected instructor"), plan, endTick, profile, { perturbReference });
    const candidates = attempts.filter(row => row.pass).map(({ plan }) => ({
      plan, arms: profiles.map(profile => reference(plan, profile)),
    }));
    const margin = ({ arms }) => Math.min(.45, ...arms.map(row => row.summary.minimumRoadMarginM));
    const viable = candidates.filter(row => row.arms.every(arm => safe(arm.summary)))
      .sort((a, b) => margin(b) - margin(a));
    const evidence = { site, candidates: candidates.map(({ plan, arms }) =>
      ({ plan, arms: arms.map(({ summary }) => ({ ...score(summary), pass: safe(summary) })) })), recovery: [] };
    paired.curriculum.push(evidence);
    if (!viable.length) continue;
    lessons.push(site);
    const examples = ({ samples: observed }, since = 12) => {
      const encode = observe(), collected = [];
      for (const [i, { obs, road, action, teacherAction }] of observed.entries()) {
        const input = encode(obs, road);
        if (input && 12 + 6 * i >= since) collected.push({ obs: input, action: teacherAction ?? action });
      }
      return collected;
    };
    const recoveryPlans = viable.slice(0, recipe.maximumRecoveryPlans).map(instructor => {
      const recovered = [], recoveredProfiles = new Set();
      for (const [j, profile] of profiles.entries()) for (const takeover of recipe.takeoverTicks) {
        const incoming = restoreSustainedActor(checkpoint);
        const trial = reference(instructor.plan, profile, (tick, action, obs, road) =>
          tick < takeover ? incoming.select(obs, road) : action);
        const summary = trial.summary;
        const first = summary.trace.findIndex(row => row.tick >= takeover);
        const deviationM = first < 0 ? null :
          Math.abs(summary.trace[first].lateralM - instructor.arms[j].summary.trace[first].lateralM);
        const labels = incoming.stats.admitted > 0 && deviationM > .08 && safe(summary) ? examples(trial, takeover) : [];
        const record = { plan: instructor.plan, profile: profile.label, takeover, deviationM, eligible: labels.length,
          retained: 0, ...score(summary), clearanceOK: summary.clearanceOK,
          postClearNonforwardTicks: summary.postClearNonforwardTicks, endSpeedMps: summary.trace.at(-1).speed };
        evidence.recovery.push(record);
        if (!labels.length) continue;
        recovered.push({ labels, record });
        recoveredProfiles.add(profile.label);
      }
      return { instructor, recovered, coverage: recoveredProfiles.size };
    });
    const chosen = recoveryPlans.sort((a, b) => b.coverage - a.coverage || b.recovered.length - a.recovered.length)[0];
    evidence.selected = chosen.instructor.plan;
    for (const arm of chosen.instructor.arms) samples.push(...examples(arm));
    for (const { labels, record } of chosen.recovered) {
      samples.push(...labels);
      record.retained = labels.length;
      recoverySamples += labels.length;
    }
  }
  paired.fit = { lessons: lessons.length, samples: samples.length, recoverySamples };
  for (const [road] of training) {
    const qualified = paired.curriculum.filter(row => row.site[0] === road && row.selected);
    assert.ok(qualified.length && qualified.some(row => row.recovery.some(arm => arm.retained > 0)),
      `No paired instructor and physical learner-prefix correction at ${road}`);
  }

  const model = createVergeLearner(checkpoint.candidate, features.length, features.length);
  const adam = model.applyAdam.bind(model);
  model.layout = { ...model.layout, std: settings.std };
  model.applyAdam = grad => adam(grad, recipe.warmRate);
  paired.fit.losses = model.warmStart(samples, recipe.warmEpochs);
  const warm = model.checkpoint();
  model.applyAdam = grad => adam(grad, recipe.ppoRate);
  paired.updates = [];
  paired.transitions = 0;
  for (let update = 0; update < recipe.updates; update++) {
    const batch = [], arms = [];
    for (const [i, site] of lessons.entries()) for (const profile of profiles) {
      const sampled = actor(model, false, new Random(`${model.seed}:paired:${update}:${i}:${profile.label}`));
      const trial = evaluate(site, "combined", sampled.select, null, endTick, profile);
      assert.equal(sampled.stats.admitted, trial.rollout.length);
      assert.ok(sampled.stats.withMotion > 0 && trial.rollout.length >= 32);
      trial.rollout.at(-1).episodeBootstrap = 0;
      batch.push(...trial.rollout);
      arms.push({ site, profile: profile.label, ...score(trial.summary), pass: safe(trial.summary) });
    }
    paired.updates.push({ ...model.update(batch), arms });
    paired.transitions += batch.length;
  }
  const candidate = model.checkpoint();
  assert.equal(candidate.transitions, paired.transitions);
  assert.ok(candidate.weights.slice(0, model.layout.OUTPUT_WEIGHTS).some((weight, i) => weight !== warm.weights[i]));
  paired.checkpointSha256 = await save("paired-checkpoint.json", { ...checkpoint, warm, candidate, paired: { initialSha256, recipe } });
  const saved = await read(join(output, "paired-checkpoint.json"), paired.checkpointSha256);
  assert.throws(() => freezePursuitPolicy(saved.candidate), /Incompatible/);
  paired.scored = pinned.verifyLayouts.flatMap(site => profiles.map(profile => {
    const test = (data, arm) => {
      const measure = horizon => {
        const controller = restoreSustainedActor(data, arm);
        let tailSpeed, yields = 0;
        const { summary } = evaluate(site, "combined", controller.select, null, horizon, profile, {
          observeTick(_world, tail) {
            tailSpeed = tail.speed;
            if (tail.reason === "traffic-yield" && tail.speed < tail.previous.speed) yields++;
          },
        });
        const pass = controller.stats.missingRoad === 0 && controller.stats.withMotion > 0 && tailSpeed > 3 &&
          (horizon === endTick ? safe(summary) : original(summary));
        return { summary, pass, tailSpeed, yields, stats: controller.stats };
      };
      const short = measure(originalEndTick), long = measure(endTick);
      assert.deepEqual(long.summary.trace.slice(0, short.summary.trace.length), short.summary.trace);
      return { short, long };
    };
    const row = { site, profile: profile.label, incoming: test(checkpoint, "candidate"),
      warm: test(saved, "warm"), candidate: test(saved, "candidate") };
    console.log(JSON.stringify({ site, profile: profile.label, ...Object.fromEntries(["incoming", "warm", "candidate"]
      .map(key => [key, [row[key].short.pass, row[key].long.pass, ...["clear", "roadDenials", "noContact"]
        .map(field => score(row[key].long.summary)[field])]])) }));
    return row;
  }));
  paired.inactive = [...validation.map(site => [site, "rear-only"]), ...pinned.verifyLayouts.map(site => [site, "no-tail"])]
    .flatMap(([site, kind]) => profiles.map(profile => {
      const incoming = evaluate(site, kind, prior.action, null, endTick, profile).summary;
      const controller = restoreSustainedActor(saved);
      const result = evaluate(site, kind, controller.select, null, endTick, profile).summary;
      assert.deepEqual(result, incoming);
      return { site, kind, profile: profile.label, exact: controller.stats.admitted === 0 };
    }));
  paired.inactiveExact = paired.inactive.every(row => row.exact);
  for (const key of ["incoming", "warm", "candidate"])
    paired[`${key}Passes`] = paired.scored.reduce((count, row) =>
      count + Number(row[key].short.pass) + Number(row[key].long.pass), 0);
  assert.ok(paired.candidatePasses === 16 && paired.inactiveExact, "The paired policy still failed unchanged safety windows");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  assert.ok(output && ["controls", "fit", "patrol-preview", "paired-fit"].includes(mode), "Select a mode and fresh output directory");
  try {
    controls();
    if (mode === "fit") await train();
    if (mode === "patrol-preview") await compareSavedPatrolProfiles();
    if (mode === "paired-fit") await fitBothPatrolProfiles();
  } finally {
    await save("sustained-pressure.json", report);
  }
}
