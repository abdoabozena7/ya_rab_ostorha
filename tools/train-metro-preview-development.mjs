import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Random } from "../src/core/random.js";
import { freezePursuitPolicy, PursuitPpo } from "../src/rl/pursuit-ppo.js";
import { isDispatchIncident, runPursuitEpisode } from "../src/rl/pursuit-rollouts.js";

const output = process.env.PROVE_IT_OUTPUT_DIR;
assert.ok(output, "Set a new proof output directory");
const hash = data => createHash("sha256").update(data).digest("hex");
async function load(url, expected) {
  const data = await readFile(url);
  assert.equal(hash(data), expected);
  return JSON.parse(data);
}
async function save(name, value) {
  const data = JSON.stringify(value);
  await writeFile(join(output, name), data, { flag: "wx" });
  return hash(data);
}

const parentSha256 = "854b284350457717cd2c299a0dc86604f2600ed989c1c9aac7ff497d0e5181e3";
const parent = await load(new URL("../.runtime-proof/pursuit-rl-dense-learning-20261120/corrective-trial-20261120-221352/checkpoint-1.json", import.meta.url), parentSha256);
const teachers = new URL("../.runtime-proof/pursuit-rl-preview-curriculum-20261121/runs/routes/20261121T003839-dcfb26aabe/", import.meta.url);
const teachersSha256 = "aaf7ecefafde7fcbd285060d21b3e4cf0e6ac07ff0bbef6cfcc4021aba693bd9";
const teacherReport = await load(new URL("preview-teacher.json", teachers), teachersSha256);
const manifestBytes = await readFile(new URL("../config/pursuit-rl-city-route-development.json", import.meta.url));
const curriculum = JSON.parse(manifestBytes);
assert.ok(teacherReport.civilianCrossingPreview && teacherReport.mediumFeasible && teacherReport.denseFeasible);
assert.equal(teacherReport.episodes.length, 4);
const inputs = teacherReport.episodes.filter(row => row.demonstration);
assert.equal(inputs.length, 3);
const samples = [];
for (const row of inputs) {
  assert.ok(curriculum.trainingSeeds.includes(row.seed) && !curriculum.validationSeeds.includes(row.seed));
  assert.ok(row.phase === "escaped" && row.qualified && row.activePatrols > 0 && !row.contacts && !row.ambientPedestrianImpacts);
  const { file, sha256, samples: count } = row.demonstration;
  const actual = await load(new URL(file, teachers), sha256);
  assert.equal(actual.length, count);
  for (const { obs, action } of actual) samples.push({ obs: Float32Array.from(obs), action });
}

const model = new PursuitPpo("metro-preview-development-v1", null, parent.observation);
model.weights.set(parent.weights);
const adam = model.applyAdam.bind(model);
const warmRate = .00016, epochs = 14, ppoRate = .000018, std = [.05, .18, .16];
const provenance = { parentSha256, teachersSha256, curriculumSha256: hash(manifestBytes), preview: true,
  classification: "development candidate only", warmRate, epochs, ppoRate, std,
  demonstrations: inputs.map(({ seed, level, demonstration }) => ({ seed, level, ...demonstration })) };
model.applyAdam = gradient => adam(gradient, warmRate);
const losses = model.warmStart(samples, epochs);
const warm = model.checkpoint();
const warmSha256 = await save("warm-start.json", { ...warm, development: provenance });
const warmOnly = new PursuitPpo(null, warm);
console.log(JSON.stringify({ kind: "warm", samples: samples.length, warmSha256, initialLoss: losses[0], finalLoss: losses.at(-1) }));

function measured(stage, seed, select, collect) {
  let original, sampleCount = 0, activePatrols = 0;
  const incidents = [], motion = createHash("sha256");
  const result = runPursuitEpisode({ ...stage, civilianCrossingPreview: true, episodeSeconds: 120 }, seed, select, collect, (pose, events) => {
    assert.ok(pose.slice(0, 5).every(Number.isFinite));
    motion.update(JSON.stringify(pose));
    incidents.push(...events.filter(isDispatchIncident));
  }, world => {
    assert.equal(world.config.seed, seed);
    assert.equal(world.pursuit.gta.config.civilianCrossingPreview, true);
    const ambient = world.actors.filter(a => a !== world.player && !world.pursuit.patrols.has(a) &&
      (a.type === "vehicle" || a.type === "pedestrian"));
    assert.equal(ambient.filter(a => a.type === "vehicle").length, stage.traffic);
    assert.equal(ambient.filter(a => a.type === "pedestrian").length, stage.pedestrians);
    if (!original) original = ambient.map(a => [a, a.id, a.type]);
    else {
      const observed = new Set(ambient);
      assert.ok(original.every(([actor, id, type]) => observed.has(actor) && actor.id === id && actor.type === type));
    }
    activePatrols = Math.max(activePatrols, [...world.pursuit.patrols].filter(unit => unit.aiState !== "WRECKED").length);
    sampleCount++;
  });
  const metrics = { ...result.metrics, level: stage.wantedLevel, traffic: stage.traffic, pedestrians: stage.pedestrians,
    sampleCount, activePatrols, incidents, motionSha256: motion.digest("hex") };
  assert.ok(activePatrols > 0 && sampleCount === Math.ceil(metrics.ticks / 6) + 1);
  return { ...result, metrics };
}
async function record(arm, row) {
  await appendFile(join(output, "episodes.ndjson"), JSON.stringify({ arm, ...row }) + "\n");
  console.log(JSON.stringify({ arm, seed: row.seed, level: row.level, phase: row.phase, ticks: row.ticks,
    distanceM: row.distanceM, egoContacts: row.collisions, ambientPedestrianImpacts: row.ambientPedestrianImpacts }));
}

model.layout = { ...model.layout, std };
model.applyAdam = gradient => adam(gradient, ppoRate);
const trainBatch = [], onPolicy = [];
for (const [i, stage] of curriculum.stages.entries()) {
  const seed = curriculum.trainingSeeds[i];
  const rng = new Random(`${model.seed}:${stage.id}:${seed}`);
  const { rollout, last, metrics } = measured(stage, seed, obs => model.sample(obs, rng), true);
  rollout.at(-1).episodeBootstrap = last.terminated ? 0 : model.value(last.obs);
  trainBatch.push(...rollout);
  onPolicy.push(metrics);
  await record("on-policy", metrics);
}
const update = model.update(trainBatch);
const candidate = model.checkpoint(), driver = freezePursuitPolicy(candidate);
assert.ok(candidate.weights.some((weight, i) => weight !== warm.weights[i]), "No numerical PPO change");
const candidateSha256 = await save("checkpoint-1.json", { ...candidate, development: { ...provenance, warmSha256 } });
const episodes = [];
for (const stage of curriculum.stages) for (const seed of curriculum.validationSeeds) {
  for (const [arm, select] of [["frozen", driver.action], ["warm", obs => warmOnly.action(obs)]]) {
    const { metrics } = measured(stage, seed, select, false);
    episodes.push({ arm, ...metrics });
    await record(arm, metrics);
  }
}
const frozen = episodes.filter(row => row.arm === "frozen");
const qualifiedEscapes = level => frozen.filter(row => row.level === level && row.phase === "escaped" && row.pursuitQualified).length;
const accepted = frozen.length === 4 && qualifiedEscapes(3) === 2 && qualifiedEscapes(5) >= 1 &&
  frozen.every(row => row.collisions === 0 && row.ambientPedestrianImpacts === 0);
await save("preview-fit.json", { provenance, node: process.version, v8: process.versions.v8, warmSha256, candidateSha256,
  samples: samples.length, losses, update, onPolicy, episodes, accepted });
assert.ok(accepted, "Preview policy did not retain the required full City safety and escape behavior");
