import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { freezePursuitPolicy, PursuitPpo } from "../src/rl/pursuit-ppo.js";
import { isDispatchIncident, runPursuitEpisode } from "../src/rl/pursuit-rollouts.js";

const output = process.env.PROVE_IT_OUTPUT_DIR;
assert.ok(output, "Set a new proof output directory");
const base = new URL("../.runtime-proof/pursuit-rl-dense-learning-20261120/corrective-trial-20261120-221352/", import.meta.url);
const hashes = { warm: "d65189ef9935813d6b59c3f66e935edd8e5ac3f458470fef2e5c0580111bbb05",
  ppo: "854b284350457717cd2c299a0dc86604f2600ed989c1c9aac7ff497d0e5181e3" };
async function load(file, hash) {
  const contents = await readFile(new URL(file, base));
  assert.equal(createHash("sha256").update(contents).digest("hex"), hash);
  return JSON.parse(contents);
}
const [warm, ppo] = await Promise.all([load("warm-start.json", hashes.warm), load("checkpoint-1.json", hashes.ppo)]);
assert.equal(ppo.development.warmSha, hashes.warm);
assert.deepEqual([warm.updates, warm.transitions, ppo.updates, ppo.transitions], [0, 0, 1, 600]);
const prior = new PursuitPpo(null, warm), updated = freezePursuitPolicy(ppo);
assert.equal(prior.observation, updated.observation);

const curriculum = JSON.parse(await readFile(new URL("../config/pursuit-rl-city-route-development.json", import.meta.url)));
const report = { classification: "development-only paired warm-to-PPO update comparison",
  runtime: { node: process.version, v8: process.versions.v8, platform: process.platform },
  checkpoints: hashes, fromDemoSamples: warm.demonstrations, learnedTransitions: ppo.transitions,
  episodes: [] };
for (const stage of curriculum.stages) for (const seed of curriculum.validationSeeds) {
  const pair = { seed, level: stage.wantedLevel, traffic: stage.traffic, pedestrians: stage.pedestrians };
  for (const [name, select] of [["warm", obs => prior.action(obs)], ["ppo", updated.action]]) {
    let original, sampleCount = 0, peakPatrols = 0;
    const incidents = [], motion = createHash("sha256");
    const started = performance.now();
    try {
      const { metrics } = runPursuitEpisode({ ...stage, episodeSeconds: 120 }, seed, select, false, (pose, events) => {
        assert.ok(pose.slice(0, 5).every(Number.isFinite));
        motion.update(JSON.stringify(pose));
        incidents.push(...events.filter(isDispatchIncident));
      }, world => {
        assert.equal(world.config.seed, seed);
        const ambient = world.actors.filter(a => a !== world.player && !a.pursuitRole);
        assert.equal(ambient.filter(a => a.type === "vehicle").length, stage.traffic);
        assert.equal(ambient.filter(a => a.type === "pedestrian").length, stage.pedestrians);
        const actual = new Map(ambient.map(a => [a.id, a]));
        assert.equal(actual.size, ambient.length);
        if (original) {
          for (const [id, actor] of original) assert.ok(actual.get(id) === actor, `Ambient actor changed: ${id}`);
        } else original = actual;
        sampleCount++;
        peakPatrols = Math.max(peakPatrols, world.pursuit.patrols.size);
      });
      assert.equal(sampleCount, Math.ceil(metrics.ticks / 6) + 1);
      pair[name] = metrics;
    } catch (error) {
      pair[name] = { phase: "error", error: error.message };
    }
    Object.assign(pair[name], { sampleCount, peakPatrols, incidents, digest: motion.digest("hex"),
      wallSeconds: (performance.now() - started) / 1000 });
    const row = { seed, level: pair.level, controller: name, ...pair[name] };
    await appendFile(join(output, "episodes.ndjson"), JSON.stringify(row) + "\n");
    console.log(JSON.stringify({ seed, level: pair.level, controller: name, phase: row.phase,
      distanceM: row.distanceM, egoContacts: row.collisions, ambientContacts: row.ambientCollisions }));
  }
  report.episodes.push(pair);
}
const clean = row => row.phase === "escaped" && row.pursuitQualified && row.collisions === 0;
report.comparable = report.episodes.length === 4 && report.episodes.every(p =>
  [p.warm, p.ppo].every(a => a.phase !== "error" && a.sampleCount > 1 && a.peakPatrols > 0));
report.cleanEscapes = Object.fromEntries(["warm", "ppo"].map(arm =>
  [arm, report.episodes.filter(p => clean(p[arm])).length]));
await writeFile(join(output, "update-comparison.json"), JSON.stringify(report, null, 2));
assert.ok(report.comparable, "An incomplete pair cannot support update attribution");
