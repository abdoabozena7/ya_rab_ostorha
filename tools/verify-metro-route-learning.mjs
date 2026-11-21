import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { angleDelta } from "../src/core/geometry.js";
import { GtaPursuitEnv, getDispatchObservation, ROUTE_OBSERVATION_SCHEMA } from "../src/rl/gta-pursuit-env.js";
import { freezePursuitPolicy, PursuitPpo } from "../src/rl/pursuit-ppo.js";
import { pursuitStageVariants, runPursuitEpisode } from "../src/rl/pursuit-rollouts.js";
import { PursuitScanner } from "../src/signal_processing/pursuit-scanner.js";
import { routeCurriculum, scripted } from "./train-metro-pursuit.mjs";
import { routeDemonstration } from "./metro-route-demonstrations.mjs";
import { dispatchRouteGuide } from "../src/rl/pursuit-route-context.js";

const checkpointPath = process.env.METRO_ROUTE_CHECKPOINT || process.argv[2];
if (!checkpointPath) throw new Error("Supply the frozen post-PPO checkpoint path as METRO_ROUTE_CHECKPOINT or argv[2]");
const bytes = await readFile(checkpointPath);
const checkpoint = JSON.parse(bytes), model = freezePursuitPolicy(checkpoint);
const sha256 = createHash("sha256").update(bytes).digest("hex");
assert.equal(model.observation, ROUTE_OBSERVATION_SCHEMA.version);
assert.ok(model.updates > 0 && checkpoint.demonstrations > 0, "A purely supervised model cannot receive PPO credit");
const warmPath = process.env.METRO_ROUTE_WARM_START || process.argv[3];
if (!warmPath) throw new Error("Supply the paired pre-PPO checkpoint for comparison");
const warmBytes = await readFile(warmPath);
const warmSha256 = createHash("sha256").update(warmBytes).digest("hex");
const warm = new PursuitPpo(null, JSON.parse(warmBytes));
assert.equal(warm.updates, 0);
assert.ok(warm.demonstrations > 0);
assert.notDeepEqual(checkpoint.weights, warm.checkpoint().weights);

function isolation() {
  const env = new GtaPursuitEnv();
  env.reset({ seed: "route-info-boundary-check", traffic: 0, pedestrians: 0,
    observation: model.observation, scenario: "tail-civic-eastbound",
    config: { ruleset: "dispatch-v1", maxActivePatrols: 1 } });
  const w = env.world, { player, pursuit } = w, [unit] = pursuit.patrols;
  const barrier = { type: "static", kind: "barrier", id: "route-observation-screen",
    x: player.x - 12, z: player.z, heading: player.heading, width: 10, length: 1, height: 2 };
  w.statics = w.statics.concat(barrier);
  const scan = () => pursuit.gta.scan = new PursuitScanner().sample(w);
  const before = scan();
  assert.ok(!before.tracks.some(track => track.kind === "police"), "the actual patrol must be hidden in this control");
  const obs = getDispatchObservation(w, model.observation);
  unit.x += 3;
  unit.z += .5;
  pursuit.response.lastSeen = { x: 133, z: -111, speed: 10, tick: 0 };
  pursuit.wantedLevel++;
  assert.deepEqual(scan(), before);
  assert.deepEqual(getDispatchObservation(w, model.observation), obs);
  player.heading -= .16;
  const off = ROUTE_OBSERVATION_SCHEMA.navigation.offset;
  assert.notDeepEqual(getDispatchObservation(w, model.observation).subarray(off), obs.subarray(off));
  assert.throws(() => model.action(getDispatchObservation(w)), /dispatch-route-v1/);
  return true;
}

function retryAttachment() {
  const setup = () => {
    const env = new GtaPursuitEnv();
    env.reset({ seed: "route-cache-angle", traffic: 0, pedestrians: 0,
      config: { ruleset: "dispatch-v1", maxActivePatrols: 0 } });
    Object.assign(env.world.player, { heading: 2.4, speed: 5, x: -244, z: -111 });
    return env;
  };
  const first = setup(), fresh = setup();
  assert.equal(dispatchRouteGuide(first.world), null, "must reproduce the initial missed attachment");
  const maneuver = { steer: -.9, throttle: .12, brake: 0, gear: 1 };
  first.step(maneuver, 42);
  fresh.step(maneuver, 42);
  assert.deepEqual(first.world.player, fresh.world.player);
  assert.equal(first.world.pursuit.metrics.collisions, 0);
  const found = dispatchRouteGuide(first.world);
  assert.ok(found?.path.length > 10, "legal realignment must make a previously missed route available");
  assert.deepEqual(found, dispatchRouteGuide(fresh.world));
  return true;
}

function trace(stage, seed, select) {
  const samples = [];
  const result = runPursuitEpisode(stage, seed, select, false, row => samples.push(row));
  assert.ok(samples.length > 10);
  const turnRad = Math.max(...samples.map(row => Math.abs(angleDelta(row[4], samples[0][4]))));
  const signature = createHash("sha256").update(JSON.stringify(samples)).digest("hex");
  return { ...result.metrics, turnRad, signature, samples };
}
const base = routeCurriculum.stages.find(stage => stage.id === "junction-escape");
assert.ok(base.patrols === 1 && base.scenarios.length >= 2);
const initialized = new PursuitPpo(checkpoint.seed, null, model.observation);
const cases = [];
for (const stage of pursuitStageVariants(base)) for (const seed of routeCurriculum.validationSeeds) {
  const trained = trace(stage, seed, model.action);
  const repeated = trace(stage, seed, model.action);
  assert.equal(repeated.signature, trained.signature, "fixed-step rollout must repeat exactly");
  cases.push({ scenario: stage.scenario, seed, trained, warmStart: trace(stage, seed, obs => warm.action(obs)),
    untrained: trace(stage, seed, obs => initialized.action(obs)), straight: trace(stage, seed, scripted),
    routeFollower: routeDemonstration(stage, seed).metrics });
}
const absent = trace({ ...pursuitStageVariants(base)[0], patrols: 0 }, routeCurriculum.validationSeeds[0], model.action);
assert.notEqual(absent.phase, "escaped", "finishing without an actual patrol cannot count as escape");
const hiddenInvariant = isolation();
const attachmentRecovered = retryAttachment();
const collisionFreeEscapes = cases.filter(({ trained: t }) =>
  t.phase === "escaped" && t.turnRad >= 1.2 && t.collisions === 0 && t.pursuitQualified).length;
const report = { sha256, warmSha256, observation: model.observation, updates: model.updates, transitions: model.transitions,
  hiddenInvariant, attachmentRecovered, collisionFreeEscapes, absent, cases };
if (process.env.PROVE_IT_OUTPUT_DIR)
  await writeFile(join(process.env.PROVE_IT_OUTPUT_DIR, "route-learning.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ sha256, hiddenInvariant, collisionFreeEscapes,
  cases: cases.map(({ scenario, seed, trained, warmStart, untrained, straight, routeFollower }) =>
    ({ scenario, seed, trained: [trained.phase, trained.collisions, trained.turnRad],
      warmStart: [warmStart.phase, warmStart.collisions], untrained: [untrained.phase, untrained.collisions],
      straight: [straight.phase, straight.collisions], routeFollower: [routeFollower.phase, routeFollower.collisions] })) }, null, 2));
assert.ok(collisionFreeEscapes > 0, "No actual collision-free PPO turn-and-escape on separated development cases");
