import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PATROL_TRAFFIC_PREVIEW } from "../src/core/pursuit-gta.js";
import { runPursuitEpisode } from "../src/rl/pursuit-rollouts.js";
import { freezePursuitPolicy } from "../src/rl/pursuit-ppo.js";

const output = process.env.PROVE_IT_OUTPUT_DIR;
assert.ok(output, "Use a fresh proof output directory");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const priorSha256 = "76a6c7d09cb78f4b9efb70fcf863541b0f4be300d1d5d9f492c177dbc259aad3";
const checkpointSha256 = "854b284350457717cd2c299a0dc86604f2600ed989c1c9aac7ff497d0e5181e3";
const prior = await readFile(new URL(
  "../.runtime-proof/pursuit-rl-threat-development-20261121/retention-20261121-054914/retention.json", import.meta.url));
const checkpoint = await readFile(new URL(
  "../.runtime-proof/pursuit-rl-dense-learning-20261120/corrective-trial-20261120-221352/checkpoint-1.json", import.meta.url));
assert.equal(hash(prior), priorSha256);
assert.equal(hash(checkpoint), checkpointSha256);
const manifest = JSON.parse(prior).arms;
const policy = freezePursuitPolicy(JSON.parse(checkpoint));
const report = { scope: "four paired full Metro development cases only", runtime: process.version,
  v8: process.versions.v8, priorSha256, checkpointSha256, profile: PATROL_TRAFFIC_PREVIEW, cases: [] };
assert.equal(manifest.length, 4);

function trial({ seed, level, density }, profile) {
  const stage = { observation: policy.observation, wantedLevel: level, wantedLevelMax: level,
    patrols: level === 5 ? 12 : 7, episodeSeconds: 120,
    traffic: density === "dense" ? 96 : 36, pedestrians: density === "dense" ? 144 : 80,
    patrolTrafficPreview: profile };
  let ambient, peakPatrols = 0, peakPatrolBodies = 0, firstYield = null, yieldTicks = 0, decisionSamples = 0;
  const yieldingPatrols = new Set(), movingPatrols = new Set(), incidents = [], poseDigest = createHash("sha256");
  const started = performance.now();
  const result = runPursuitEpisode(stage, seed, policy.action, false, (row, events) => {
    assert.ok(row.slice(0, 5).every(Number.isFinite), "Nonfinite accepted pose");
    poseDigest.update(JSON.stringify(row));
    incidents.push(...events.filter(event => ["patrol_collision", "static_or_civilian_hit", "near_miss", "ambient_collision"].includes(event.type)));
  }, world => {
    const present = world.actors.filter(actor => actor !== world.player && !world.pursuit.patrols.has(actor));
    if (!ambient) {
      ambient = new Map(present.map(actor => [actor, [actor.id, actor.type]]));
      assert.equal(present.filter(actor => actor.type === "pedestrian").length, stage.pedestrians);
      assert.equal(present.filter(actor => actor.type === "vehicle").length, stage.traffic);
      assert.equal(new Set(present.map(actor => actor.id)).size, ambient.size);
      const step = world.step.bind(world);
      world.step = () => {
        step();
        let intervened = false;
        for (const patrol of world.pursuit.patrols) {
          if (patrol.speed > 3 && patrol.distance > 8) movingPatrols.add(patrol.id);
          if (patrol.reason !== "traffic-yield") continue;
          if (patrol.speed < patrol.previous.speed) {
            firstYield ??= { tick: world.tick, id: patrol.id, speedMps: patrol.speed, blocker: patrol.blockedBy };
            intervened = true;
            yieldingPatrols.add(patrol.id);
          }
        }
        yieldTicks += Number(intervened);
      };
    }
    assert.equal(present.length, ambient.size, "Ambient population changed");
    for (const actor of present) {
      const original = ambient.get(actor);
      assert.ok(original && actor.id === original[0] && actor.type === original[1], "Ambient actor replaced or altered");
    }
    assert.equal(world.pursuit.gta.config.patrolTrafficPreview, profile);
    decisionSamples++;
    const units = [...world.pursuit.patrols];
    peakPatrolBodies = Math.max(peakPatrolBodies, units.length);
    peakPatrols = Math.max(peakPatrols, units.filter(unit => unit.health > 0 && unit.aiState !== "WRECKED").length);
  });
  return { ...result.metrics, profile: profile ?? null, wallSeconds: (performance.now() - started) / 1000,
    poseSha256: poseDigest.digest("hex"), peakPatrols, peakPatrolBodies, movingPatrols: movingPatrols.size,
    firstYield, yieldTicks, yieldingPatrols: yieldingPatrols.size, decisionSamples,
    population: { traffic: stage.traffic, pedestrians: stage.pedestrians, retained: true }, incidents };
}

const cleanEscape = x => x?.phase === "escaped" && x.pursuitQualified && x.collisions === 0;
const receipt = join(output, "patrol-episodes.ndjson");
for (const { seed, level, density, after: expected } of manifest) {
  const entry = { seed, level, density }, row = { ...entry };
  report.cases.push(row);
  for (const [name, profile] of [["baseline", undefined], ["preview", PATROL_TRAFFIC_PREVIEW]]) {
    const result = trial(entry, profile);
    row[name] = result;
    await appendFile(receipt, JSON.stringify({ ...entry, name, result }) + "\n");
    console.log(JSON.stringify({ ...entry, name, phase: result.phase, ticks: result.ticks,
      distanceM: result.distanceM, qualified: result.pursuitQualified, ego: result.collisions,
      pedestrianImpacts: result.ambientPedestrianImpacts, ambient: result.ambientCollisions,
      movingPatrols: result.movingPatrols, yieldTicks: result.yieldTicks, wallSeconds: result.wallSeconds }));
  }
  const keys = ["phase", "ticks", "distanceM", "collisions", "ambientCollisions",
    "ambientPedestrianImpacts", "pursuitQualified", "peakPatrols"];
  row.baselineExact = keys.every(k => row.baseline[k] === expected[k]);
}
report.episodeCount = report.cases.length * 2;
report.baselineExact = report.cases.every(row => row.baselineExact && row.baseline.yieldTicks === 0);
report.retainedAll = report.cases.every(({ baseline, preview }) => [baseline, preview]
  .every(arm => arm.population.retained && arm.movingPatrols > 0));
report.cleanAtLevel3 = report.cases.filter(row => row.level === 3 && cleanEscape(row.preview)).length;
report.cleanAtLevel5 = report.cases.filter(row => row.level === 5 && cleanEscape(row.preview)).length;
report.pedestrianCounts = ["baseline", "preview"].map(key =>
  report.cases.reduce((total, row) => total + row[key].ambientPedestrianImpacts, 0));
report.activatedBothDensities = [3, 5].every(level => report.cases.some(row => row.level === level &&
  row.preview.yieldTicks > 0 && row.baseline.poseSha256 !== row.preview.poseSha256));
report.metTargets = report.cleanAtLevel3 === 2 && report.cleanAtLevel5 >= 1 &&
  report.cases.every(row => row.preview.collisions === 0) &&
  report.pedestrianCounts[1] <= report.pedestrianCounts[0] && report.activatedBothDensities;
await writeFile(join(output, "patrol-retention.json"), JSON.stringify(report), { flag: "wx" });
assert.ok(report.baselineExact && report.retainedAll && report.metTargets,
  "Full development retention failed; keep the traffic preview out of public defaults");
