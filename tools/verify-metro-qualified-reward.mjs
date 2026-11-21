import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PURSUIT_STOP } from "../src/core/pursuit-controls.js";
import { distance } from "../src/core/geometry.js";
import { GtaPursuitEnv } from "../src/rl/gta-pursuit-env.js";

const output = process.env.PROVE_IT_OUTPUT_DIR;
assert.ok(output, "Set a new proof output directory");
const go = { steer: 0, throttle: 1, brake: 0, gear: 1 };
const base = { ruleset: "dispatch-v1", wantedLevelStart: 1, wantedLevelMax: 1,
  enableRoadblocks: false, enableRamming: false, enablePitManeuver: false };

function run(name, patrols, options = {}, progressOption = {}) {
  const env = new GtaPursuitEnv();
  const reset = env.reset({ seed: "public-dispatch-progress-proof", traffic: 0, pedestrians: 0,
    shield: true, config: { ...base, maxActivePatrols: patrols, episodeMaxSeconds: 120, ...options }, ...progressOption });
  const { world } = env, { player, pursuit } = world;
  const [patrol] = pursuit.patrols;
  const motion = createHash("sha256"), observations = createHash("sha256");
  let preQualificationProgress = 0, postQualificationProgress = 0, initialQualifiedTick = null;
  let outcome = 0, total = 0, safety = 0, firstQualifiedCredit = null;
  const originalScore = env.scoreDispatchTick;
  env.scoreDispatchTick = function (reward, steer, events) {
    const before = reward.progress;
    originalScore.call(this, reward, steer, events);
    const delta = reward.progress - before;
    if (pursuit.response.dispatch.escapeEligible) {
      initialQualifiedTick ??= world.tick;
      if (firstQualifiedCredit === null && delta > 0) firstQualifiedCredit = delta;
      postQualificationProgress += delta;
    } else preQualificationProgress += delta;
  };
  observations.update(Buffer.from(reset.obs.buffer));
  do {
    const result = env.step(player.x < -135 ? go : PURSUIT_STOP);
    observations.update(Buffer.from(result.obs.buffer));
    motion.update(JSON.stringify([world.tick, player.x, player.z, player.heading, player.speed,
      pursuit.appliedCommand, pursuit.phase, pursuit.response.dispatch.escapeEligible, result.info.events]));
    total += result.reward;
    safety += result.info.rewardComponents.safety;
    outcome += result.info.rewardComponents.outcome;
  } while (pursuit.phase === "running");
  return { name, profile: reset.info.rewardProfile, phase: pursuit.phase, ticks: world.tick, distanceM: pursuit.metrics.distanceM,
    displacementM: distance(player, pursuit.playerStart), patrolM: patrol?.distance ?? 0,
    qualified: pursuit.response.dispatch.escapeEligible, collisions: pursuit.metrics.collisions,
    motion: motion.digest("hex"), observations: observations.digest("hex"),
    total, outcome, safety, progress: preQualificationProgress + postQualificationProgress,
    preQualificationProgress, postQualificationProgress, initialQualifiedTick, firstQualifiedCredit };
}

const empty = run("no-patrol", 0), crippled = run("slow-patrol", 1, { npcSpeedMultiplier: .01 });
const active = run("active", 1, { episodeMaxSeconds: 9 });
const mode = process.argv[2];
const report = { classification: "local authoritative Metro reward controls", node: process.version, v8: process.versions.v8,
  empty, crippled, active };
if (mode === "current") {
  const practice = run("practice", 0, {}, { practiceProgress: true });
  const prior = await readFile(new URL(
    "../.runtime-proof/pursuit-rl-qualified-reward-20261121/reward-before/qualified-reward.json", import.meta.url));
  const baselineSha256 = createHash("sha256").update(prior).digest("hex");
  assert.equal(baselineSha256, "27f67e2d01433e4eb0bc4c6b333ee94dc3791ff5b655b71dd5f0bfd110f2b982");
  const baseline = JSON.parse(prior);
  assert.ok(baseline.empty.total > 0 && !baseline.empty.qualified && baseline.empty.phase === "timeout");
  const exact = (a, b) => a.motion === b.motion && a.observations === b.observations &&
    a.safety === b.safety && a.outcome === b.outcome;
  Object.assign(report, { practice, baselineSha256,
    emptyMatchesPractice: exact(practice, empty), matchesBaselinePhysics: [empty, crippled, active].every(row =>
      exact(row, [baseline.empty, baseline.crippled, baseline.active].find(before => before.name === row.name))) });
}
await writeFile(join(output, "qualified-reward.json"), JSON.stringify(report, null, 2), { flag: "wx" });
console.log(JSON.stringify(report));
assert.ok([empty, crippled].every(row => row.phase === "timeout" && !row.qualified && row.distanceM > 100 && row.outcome === 0));
assert.ok(crippled.patrolM > 0 && active.qualified && active.patrolM > 3 && active.postQualificationProgress > .1);
if (mode === "before") {
  assert.ok(empty.total > 0 && empty.progress > 5.9 && active.preQualificationProgress > 0);
} else if (mode === "current") {
  assert.ok(report.emptyMatchesPractice && report.matchesBaselinePhysics);
  assert.ok([empty, crippled].every(row => row.progress === 0 && row.total < 0));
  assert.ok(active.preQualificationProgress === 0 && active.firstQualifiedCredit < .03);
  assert.ok(report.practice.phase === "timeout" && !report.practice.qualified && report.practice.progress > 5.9);
  assert.equal(report.practice.profile, "maneuver-practice-v1");
  assert.equal(empty.profile, "qualified-progress-v2");
  const invalid = new GtaPursuitEnv();
  assert.throws(() => invalid.reset({ config: { ...base, maxActivePatrols: 1 }, practiceProgress: true }), /only available in no-patrol/);
  assert.throws(() => invalid.reset({ config: { ruleset: "legacy" }, practiceProgress: true }), /only available in no-patrol/);
  assert.throws(() => invalid.reset({ config: { ...base, maxActivePatrols: 0 }, practiceProgress: "true" }), /boolean/);
} else throw new RangeError("Choose before or current");
