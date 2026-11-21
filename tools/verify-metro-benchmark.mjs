import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { GtaPursuitEnv } from "../src/rl/gta-pursuit-env.js";
import { PURSUIT_SCAN_TICKS } from "../src/signal_processing/pursuit-scanner.js";
import { PursuitPpo } from "../src/rl/pursuit-ppo.js";
import { collectUpdate, curriculum } from "./train-metro-pursuit.mjs";
import { admitMetroHoldout, evaluateMetroPairing, summarizeMetroArm } from "./evaluate-metro-pursuit.mjs";

const development = [1, 3, 5].map(level => ({
  level, density: level === 5 ? "dense" : "standard", seed: `bench-dev-${level}`,
}));
const fakeHoldout = Array.from({ length: 108 }, (_, i) => ({
  level: [1, 3, 5][Math.floor(i / 36)], density: i % 36 < 12 ? "dense" : "standard",
  seed: `metro-holdout:${i.toString(16).padStart(32, "0")}`,
}));
const manifest = { schema: 1, mode: "metro-full-holdout", cases: fakeHoldout };
assert.equal(admitMetroHoldout(manifest).length, 108);
assert.throws(() => admitMetroHoldout({ ...manifest, cases: fakeHoldout.slice(2) }), /108-episode/);
assert.throws(() => admitMetroHoldout({ ...manifest, cases: [
  { ...fakeHoldout[0], seed: curriculum.trainingSeeds[0] }, ...fakeHoldout.slice(1),
] }), /development seed/);
assert.throws(() => admitMetroHoldout({ ...manifest, cases: [
  { ...fakeHoldout[0], seed: fakeHoldout[1].seed }, ...fakeHoldout.slice(1),
] }), /repeated/);
assert.throws(() => admitMetroHoldout({ ...manifest, cases: [
  { ...fakeHoldout[0], density: "standard" }, ...fakeHoldout.slice(1),
] }), /predeclared level and density/);

const model = new PursuitPpo("benchmark-development");
const { rollout, bootstrap } = collectUpdate(model, curriculum.stages[0]);
model.update(rollout, bootstrap);
const events = [];
const result = await evaluateMetroPairing(model.checkpoint(), development, 8, row => events.push(row));
assert.equal(events.length, 9);
const { provenance } = result;
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
assert.deepEqual(provenance.runtime, { node: process.version, v8: process.versions.v8, platform: process.platform, arch: process.arch });
assert.equal(provenance.protocolSha256, hash(await readFile(new URL("../config/pursuit-rl-acceptance-protocol.json", import.meta.url))));
assert.equal(provenance.source.files["src/core/world.js"], hash(await readFile(new URL("../src/core/world.js", import.meta.url))));
assert.equal(provenance.source.sha256, hash(JSON.stringify(provenance.source.files)));
assert.equal(provenance.source.sha256, provenance.sourceAfterSha256);
assert.equal(provenance.sourceStable, true);
assert.ok(events.every(row => row.sourceSha256 === provenance.source.sha256));
for (const row of result.results) for (const arm of Object.values(row.arms)) {
  assert.equal(arm.error, undefined);
  assert.equal(arm.seed, row.seed);
  assert.match(arm.digest, /^[a-f0-9]{64}$/);
  const counts = row.density === "dense" ? { traffic: 96, pedestrians: 144 } : { traffic: 36, pedestrians: 80 };
  assert.deepEqual(arm.population.initial, counts);
  assert.deepEqual(arm.population.last, counts);
  assert.equal(arm.population.samples, Math.ceil(arm.ticks / PURSUIT_SCAN_TICKS) + 1);
  assert.equal(arm.population.retained, true);
  assert.equal(new Set(arm.population.originalIds).size, counts.traffic + counts.pedestrians);
  assert.equal(arm.population.originalIds.length, counts.traffic + counts.pedestrians);
  assert.ok(arm.population.peakPatrols > 0);
  assert.equal(arm.incidents.filter(event => event.type === "near_miss").length, arm.nearMisses);
  const ambient = arm.incidents.filter(event => event.type === "ambient_collision");
  assert.equal(ambient.length, arm.ambientCollisions);
  assert.equal(ambient.filter(({ first, second }) =>
    first.type === "pedestrian" || second.type === "pedestrian").length, arm.ambientPedestrianImpacts);
  const ego = arm.incidents.filter(event => ["patrol_collision", "static_or_civilian_hit"].includes(event.type));
  assert.equal(ego.filter(event => event.fresh).length, arm.collisions);
  for (const event of [...ambient, ...ego]) {
    assert.ok([event.closingSpeed, event.energyJ, event.severity].every(Number.isFinite));
    assert.ok(event.severity >= 0 && event.severity <= 1);
  }
}
async function populationNegative(fault) {
  const originalStep = GtaPursuitEnv.prototype.step;
  let injected = false;
  const rows = [];
  try {
    GtaPursuitEnv.prototype.step = function (...args) {
      const step = originalStep.apply(this, args);
      if (!injected && this.world.tick === PURSUIT_SCAN_TICKS) {
        const index = this.world.actors.findIndex(actor => actor.type === "pedestrian");
        assert.ok(index > 0);
        if (fault === "drop") this.world.actors.splice(index, 1);
        else this.world.actors[index] = { ...this.world.actors[index] };
        injected = true;
      }
      return step;
    };
    const report = await evaluateMetroPairing(model.checkpoint(), [development[0]], .2, row => rows.push(row));
    const failed = report.results[0].arms.frozen;
    assert.ok(injected);
    assert.match(failed.error, /ambient population|ambient actor/i);
    assert.equal(failed.population.mismatch.tick, PURSUIT_SCAN_TICKS);
    assert.equal(failed.population.retained, false);
    assert.equal(failed.population.last.pedestrians, fault === "drop" ? 79 : 80);
    assert.equal(report.levels[0].frozen.failures.error, 1);
    assert.equal(report.levels[0].frozen.legitimate.n, 1);
    assert.deepEqual(rows.map(row => [row.arm, Boolean(row.metrics.error)]),
      [["frozen", true], ["untrained", false], ["scripted", false]]);
    return { retainedAsFailure: true, rows, summary: report.levels[0].frozen };
  } finally {
    GtaPursuitEnv.prototype.step = originalStep;
  }
}
const populationControls = { drop: await populationNegative("drop"), replace: await populationNegative("replace") };
const fabricated = summarizeMetroArm([{ phase: "escaped", pursuitQualified: false, collisions: 0, nearMisses: 0, pedestrianImpacts: 0 },
  { error: "test error" }]);
assert.equal(fabricated.legitimate.hits, 0);
assert.equal(fabricated.legitimate.n, 2);
assert.deepEqual(fabricated.failures, { unqualifiedEscape: 1, error: 1 });
const proof = { cases: result.results.length, holdoutRejected: true, scoringControl: fabricated, populationControls, ...result };
if (process.env.PROVE_IT_OUTPUT_DIR)
  await writeFile(join(process.env.PROVE_IT_OUTPUT_DIR, "benchmark-proof.json"), JSON.stringify(proof, null, 2));
console.log(`Development only: ${result.results.length} cases, ${events.length} real benchmark arms, and two population faults; no holdout was run.`);
