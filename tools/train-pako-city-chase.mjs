import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Random } from "../src/core/random.js";
import { METRO_CITY_CURBS } from "../src/core/pako-curb.js";
import { AGGRESSIVE_CHASE_PRESENCE } from "../src/core/pako-aggressive-police.js";
import { PATROL_TRAFFIC_PREVIEW } from "../src/core/pursuit-gta.js";
import { PATROL_LATERAL_YIELD } from "../src/core/pako-patrol-yield.js";
import { CLEAN_ESCAPE_REWARD, CLEARANCE_ROUTE_OBSERVATION_SCHEMA, GtaPursuitEnv } from "../src/rl/gta-pursuit-env.js";
import { PAKO_EVASIVE_CONTROL, planPakoEvasiveAction } from "../src/rl/pako-evasive-control.js";
import { freezePursuitPolicy, PursuitPpo } from "../src/rl/pursuit-ppo.js";
import { joinPursuitRollout, runPursuitEpisode } from "../src/rl/pursuit-rollouts.js";
import { dispatchRouteGuide, CLEARANCE_ROUTE_CONTEXT } from "../src/rl/pursuit-route-context.js";
import { followPath } from "../src/core/vehicle.js";
import { clamp } from "../src/core/config.js";
import { PURSUIT_SCAN_TICKS } from "../src/signal_processing/pursuit-scanner.js";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const focusManifestPath = resolve(rootDir, "config/pursuit-rl-city-escape-focus.json");
const outCheckpointPath = resolve(rootDir, "public/threejs/pako-chase-ppo.json");
const outReportPath = process.env.TRAINING_REPORT_PATH
  ? resolve(process.env.TRAINING_REPORT_PATH)
  : resolve(rootDir, ".runtime-proof/pako-rl-curb-chase-20261122/training-summary.json");

const manifestText = readFileSync(focusManifestPath, "utf8");
const manifest = JSON.parse(manifestText);
const curriculumSha256 = createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
const priorCheckpointPath = resolve(rootDir, ".runtime-proof/pursuit-rl-dense-learning-20261120/corrective-trial-20261120-221352/checkpoint-1.json");
const priorRaw = JSON.parse(readFileSync(priorCheckpointPath, "utf8"));

const trainSeeds = [
  "pako-chase-fit-01",
  "pako-chase-fit-02",
  "pako-chase-fit-03",
  "pako-chase-fit-04",
  "pako-chase-fit-05",
  "pako-chase-fit-06",
];
const devSelectSeeds = ["chase-practice-01", "chase-practice-02", "chase-practice-03"];
assert.ok(trainSeeds.every(s => !manifest.validationSeeds.includes(s)));
assert.ok(devSelectSeeds.every(s => !manifest.validationSeeds.includes(s)));

function routeBaseProposal(world) {
  const { player } = world;
  const guide = dispatchRouteGuide(world, CLEARANCE_ROUTE_CONTEXT);
  if (guide?.path?.length >= 2) {
    const cmd = followPath(player, guide.path, 0, true);
    const steer = clamp(cmd.steer / (player.spec?.maxSteer ?? 0.62), -0.98, 0.98);
    const throttle = Math.abs(steer) > 0.55 ? 0.68 : 0.92;
    return { steer, throttle, brake: 0, gear: 1 };
  }
  return { steer: 0, throttle: 0.88, brake: 0, gear: 1 };
}

function collectDemonstrations() {
  const demos = [];
  const configs = [
    { level: 1, traffic: 28, pedestrians: 56, patrols: 3, maxTicks: 1800 },
    { level: 3, traffic: 36, pedestrians: 80, patrols: 7, maxTicks: 2100 },
    { level: 5, traffic: 72, pedestrians: 110, patrols: 10, maxTicks: 2100 },
  ];
  for (const cfg of configs) {
    for (const seed of trainSeeds.slice(0, 4)) {
      const env = new GtaPursuitEnv();
      let { obs } = env.reset({
        seed: `${seed}:lvl${cfg.level}`,
        traffic: cfg.traffic,
        pedestrians: cfg.pedestrians,
        observation: CLEARANCE_ROUTE_OBSERVATION_SCHEMA.version,
        shield: true,
        evasiveControl: PAKO_EVASIVE_CONTROL,
        rewardProfile: CLEAN_ESCAPE_REWARD,
        config: {
          ruleset: "dispatch-v1",
          wantedLevelStart: cfg.level,
          wantedLevelMax: cfg.level,
          maxActivePatrols: cfg.patrols,
          episodeMaxSeconds: 75,
          curbSupport: METRO_CITY_CURBS,
          chasePresence: AGGRESSIVE_CHASE_PRESENCE,
          patrolTrafficPreview: PATROL_TRAFFIC_PREVIEW,
          patrolChainYield: PATROL_LATERAL_YIELD,
        },
      });
      const episodeSamples = [];
      while (env.world.pursuit.phase === "running" && env.world.tick < cfg.maxTicks) {
        const base = routeBaseProposal(env.world);
        const step = env.step(base, PURSUIT_SCAN_TICKS);
        const chosen = step.info.planner?.action ?? base;
        if (env.world.pursuit.metrics.pedestrianCollisions === 0) {
          episodeSamples.push({
            obs,
            action: step.info.shield?.reason ? { ...chosen, throttle: 0, brake: 0.75 } : chosen,
          });
        }
        obs = step.obs;
        if (step.terminated || step.truncated) break;
      }
      if (env.world.pursuit.metrics.pedestrianCollisions === 0 && env.world.pursuit.metrics.distanceM >= 35) {
        demos.push(...episodeSamples);
      }
    }
  }
  return demos;
}

const chaseStage = (level, traffic, pedestrians, patrols) => ({
  id: `chase-level-${level}`,
  observation: CLEARANCE_ROUTE_OBSERVATION_SCHEMA.version,
  traffic,
  pedestrians,
  episodeSeconds: 95,
  wantedLevel: level,
  wantedLevelMax: level,
  patrols,
  rewardProfile: CLEAN_ESCAPE_REWARD,
  curbSupport: METRO_CITY_CURBS,
  chasePresence: AGGRESSIVE_CHASE_PRESENCE,
  evasiveControl: PAKO_EVASIVE_CONTROL,
  patrolTrafficPreview: PATROL_TRAFFIC_PREVIEW,
  patrolChainYield: PATROL_LATERAL_YIELD,
});

function scoreFrozen(checkpoint, stages, seeds) {
  const frozen = freezePursuitPolicy(checkpoint);
  let escapes = 0, cleanEscapes = 0, totalDistanceM = 0, pedHits = 0, episodes = 0;
  for (const stage of stages) {
    for (const seed of seeds) {
      const res = runPursuitEpisode(stage, seed, frozen.action, false);
      episodes++;
      totalDistanceM += res.metrics.distanceM;
      pedHits += res.metrics.pedestrianImpacts;
      if (res.metrics.phase === "escaped" && res.metrics.pursuitQualified) {
        escapes++;
        if (res.metrics.collisions === 0) cleanEscapes++;
      }
    }
  }
  return { episodes, escapes, cleanEscapes, pedHits, meanDistanceM: totalDistanceM / Math.max(1, episodes) };
}

console.log(`Continuing PPO from road-trained checkpoint (${priorRaw.updates} updates, ${priorRaw.transitions} transitions)...`);
const model = new PursuitPpo(null, priorRaw);
const stages = [
  chaseStage(1, 36, 80, 3),
  chaseStage(3, 36, 80, 7),
  chaseStage(5, 96, 144, 12),
];

const baselineCandidate = {
  ...model.checkpoint(),
  development: {
    curriculumSha256,
    stage: "chase-level-3",
    rewardProfile: CLEAN_ESCAPE_REWARD,
    ppoClipEpsilon: 0.2,
  },
};
let bestCheckpoint = baselineCandidate;
let bestScore = scoreFrozen(baselineCandidate, [stages[0], stages[1]], devSelectSeeds.slice(0, 2));
console.log("Initial base eval:", JSON.stringify(bestScore));
const updateHistory = [];

const ppoUpdates = Number(process.env.PPO_UPDATES ?? 4);
for (let u = 0; u < ppoUpdates; u++) {
  const stage = stages[u % stages.length];
  const seedA = trainSeeds[(u * 2) % trainSeeds.length];
  const seedB = trainSeeds[(u * 2 + 1) % trainSeeds.length];
  const rngA = new Random(`${model.seed}:city-curb-ppo:${u}:a`);
  const rngB = new Random(`${model.seed}:city-curb-ppo:${u}:b`);
  const epA = runPursuitEpisode(stage, `${seedA}:u${u}`, obs => model.sample(obs, rngA), true);
  const epB = runPursuitEpisode(stage, `${seedB}:u${u}`, obs => model.sample(obs, rngB), true);
  const joined = joinPursuitRollout(model, `${seedA}+${seedB}`, [epA, epB]);
  const stats = model.update(joined.rollout, joined.bootstrap);
  const candidate = {
    ...model.checkpoint(),
    development: {
      curriculumSha256,
      stage: "chase-level-3",
      rewardProfile: CLEAN_ESCAPE_REWARD,
      ppoClipEpsilon: 0.2,
    },
  };
  const evalSummary = scoreFrozen(candidate, [stages[0], stages[1]], devSelectSeeds.slice(0, 2));
  updateHistory.push({
    update: candidate.updates,
    transitions: candidate.transitions,
    optimizerSteps: candidate.optimizerSteps,
    loss: stats.loss,
    rolloutPhases: [epA.metrics.phase, epB.metrics.phase],
    devEval: evalSummary,
  });
  console.log(JSON.stringify(updateHistory.at(-1)));
  if (evalSummary.pedHits === 0 && (
    evalSummary.cleanEscapes > bestScore.cleanEscapes ||
    (evalSummary.cleanEscapes === bestScore.cleanEscapes && evalSummary.escapes > bestScore.escapes) ||
    (evalSummary.cleanEscapes === bestScore.cleanEscapes && evalSummary.escapes === bestScore.escapes &&
      evalSummary.meanDistanceM > bestScore.meanDistanceM)
  )) {
    bestScore = evalSummary;
    bestCheckpoint = candidate;
  }
}

assert.ok(bestCheckpoint && bestCheckpoint.updates >= 1);

const serialized = JSON.stringify(bestCheckpoint) + "\n";
const sha256 = createHash("sha256").update(serialized).digest("hex");
mkdirSync(dirname(outCheckpointPath), { recursive: true });
writeFileSync(outCheckpointPath, serialized);
mkdirSync(dirname(outReportPath), { recursive: true });
writeFileSync(outReportPath, JSON.stringify({
  sha256,
  algorithm: bestCheckpoint.algorithm,
  observation: bestCheckpoint.observation,
  updates: bestCheckpoint.updates,
  transitions: bestCheckpoint.transitions,
  optimizerSteps: bestCheckpoint.optimizerSteps,
  demonstrations: bestCheckpoint.demonstrations ?? 0,
  ppoClipEpsilon: 0.2,
  bestDevScore: bestScore,
  updateHistory,
}, null, 2) + "\n");
console.log(`Saved trained PPO checkpoint (${sha256}) to ${outCheckpointPath}`);
