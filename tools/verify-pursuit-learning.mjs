import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { GtaPursuitEnv } from "../src/rl/gta-pursuit-env.js";
import { freezePursuitPolicy, PursuitPpo } from "../src/rl/pursuit-ppo.js";
import { collectUpdate, curriculum, runEpisode, scripted } from "./train-metro-pursuit.mjs";

const stage = curriculum.stages[0], model = new PursuitPpo("ppo-integrated-development");
const reference = new PursuitPpo(model.seed);
const untrained = model.checkpoint();
assert.throws(() => freezePursuitPolicy(untrained), /No learning updates/);
const first = collectUpdate(model, stage);
model.update(first.rollout, first.bootstrap);
const firstCheckpoint = model.checkpoint();
const out = process.env.PROVE_IT_OUTPUT_DIR;
let decoded = JSON.parse(JSON.stringify(firstCheckpoint));
if (out) {
  const file = join(out, "resume-input.json");
  await writeFile(file, JSON.stringify(firstCheckpoint));
  decoded = JSON.parse(await readFile(file, "utf8"));
}
const resumed = new PursuitPpo(null, decoded);
const reverseReward = new PursuitPpo(null, untrained);
reverseReward.update(first.rollout.map(x => ({ ...x, reward: -x.reward })), -first.bootstrap);
assert.notDeepEqual(firstCheckpoint.weights, untrained.weights);
assert.notDeepEqual(reverseReward.checkpoint().weights, firstCheckpoint.weights);

for (const learner of [model, resumed]) {
  const { rollout, bootstrap } = collectUpdate(learner, stage);
  learner.update(rollout, bootstrap);
}
assert.deepEqual(model.checkpoint(), resumed.checkpoint());
const checkpoint = model.checkpoint();
assert.throws(() => freezePursuitPolicy({ ...checkpoint, weights: [Infinity, ...checkpoint.weights.slice(1)] }), /nonfinite/);
const frozen = freezePursuitPolicy(checkpoint);
const env = new GtaPursuitEnv();
const { obs } = env.reset({ seed: curriculum.validationSeeds[0],
  config: { ruleset: "dispatch-v1", maxActivePatrols: 0, episodeMaxSeconds: stage.episodeSeconds }, traffic: 0, pedestrians: 0 });
const firstAction = frozen.action(obs);
assert.deepEqual(firstAction, model.action(obs));
assert.notDeepEqual(firstAction, reference.action(obs));
assert.deepEqual(env.step(firstAction).info.requestedAction, firstAction);
const comparison = curriculum.validationSeeds.map(seed => {
  const learned = runEpisode(stage, seed, frozen.action).metrics;
  const untrained = runEpisode(stage, seed, obs => reference.action(obs)).metrics;
  assert.notEqual(learned.trajectorySha256, untrained.trajectorySha256);
  return { seed, frozen: learned, untrained, scripted: runEpisode(stage, seed, scripted).metrics };
});
const result = { exactResume: true, rewardSensitive: true, trainedSteps: checkpoint.transitions, firstAction,
  validation: comparison, trainingFirst: first.metrics,
  sha256: createHash("sha256").update(JSON.stringify(checkpoint)).digest("hex") };
if (out) {
  await writeFile(join(out, "learning.json"), JSON.stringify(result, null, 2));
  await writeFile(join(out, "development-checkpoint.json"), JSON.stringify(checkpoint));
}
console.log(JSON.stringify(result, null, 2));
