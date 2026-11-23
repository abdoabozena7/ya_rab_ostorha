import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { on } from "node:events";
import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import test from "node:test";
import { build } from "esbuild";
import { STEP } from "../src/core/config.js";
import { districtRoadPose } from "../src/core/egypt-district.js";
import { bodyOnRoad, distance, overlaps } from "../src/core/geometry.js";
import { DEFAULT_SURVEILLANCE_ZONES } from "../src/core/pursuit-dispatch.js";
import { GTA_PIN_SECONDS } from "../src/core/pursuit-gta.js";
import { updatePursuitResponse } from "../src/core/pursuit-response.js";
import { Random } from "../src/core/random.js";
import { SpatialIndex } from "../src/core/spatial-index.js";
import { World } from "../src/core/world.js";
import { PursuitScanner } from "../src/signal_processing/pursuit-scanner.js";
import { CLEAN_ESCAPE_REWARD, GtaPursuitEnv } from "../src/rl/gta-pursuit-env.js";
import { measureConnectedCurve, measureConnectedEndpoint, PAKO_CURVE_OBSERVATION,
  PAKO_ENDPOINT_OBSERVATION } from "../src/rl/pako-curve-observation.js";
import { measureQueueBranchIntent, measureQueueIntent, PAKO_QUEUE_BRANCH_OBSERVATION,
  PAKO_QUEUE_OBSERVATION } from "../src/rl/pako-queue-observation.js";
import { freezePursuitPolicy, PursuitPpo } from "../src/rl/pursuit-ppo.js";
import { collectPursuitRollout, runPursuitEpisode } from "../src/rl/pursuit-rollouts.js";
import { createPursuitSession } from "../src/rl/pursuit-session.js";

const load = path => readFile(new URL(path, import.meta.url), "utf8").then(JSON.parse);
const curriculum = await load("../config/pursuit-rl-development.json");
const routeCurriculum = await load("../config/pursuit-rl-route-development.json");
const chaseCurriculum = await load("../config/pursuit-rl-city-escape-focus.json");
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");

test("connected curve observation uses actual range, invariant route offsets and no private actors", () => {
  const env = new GtaPursuitEnv();
  env.reset({ seed: "connected-curve-boundary", shield: true, config: { ruleset: "dispatch-v1" } });
  const { pursuit, tick } = env.world;
  const measured = (player, sampleTick = tick) => ({
    player, pursuit, tick: sampleTick,
    get actors() { throw Error("private actor state"); },
    get statics() { throw Error("private collider state"); },
  });
  const ego = { ...env.world.player, x: 0, z: 1.3, heading: 0, speed: 5.5 };
  const path = [{ x: 0, z: 0 }, { x: 0, z: 3 }, { x: 2, z: 5 }, { x: 8, z: 5 }, { x: 18, z: 5 }];
  const rotation = point => ({ x: point.z + 17, z: 25 - point.x });
  const compare = (player, route) => measureConnectedCurve(measured(player), route);
  const obs = compare(ego, path);
  const rotated = compare({ ...ego, ...rotation(ego), heading: Math.PI / 2 }, path.map(rotation));
  for (const [i, value] of obs.entries()) assert.ok(Math.abs(rotated[i] - value) < 1e-6);
  const straight = compare(ego, [{ x: 0, z: 0 }, { x: 0, z: 9 }, { x: 0, z: 18 }]);
  const mirrored = compare(ego, path.map(point => ({ ...point, x: -point.x })));
  const fields = Object.fromEntries(PAKO_CURVE_OBSERVATION.fields.map((name, i) => [name, i]));
  assert.ok(obs[fields.turnFar] > .8 && mirrored[fields.turnFar] < -.8);
  assert.equal(straight[fields.turnFar], 0);
  assert.ok(straight[fields.curveRange] > obs[fields.curveRange]);
  assert.ok(compare({ ...ego, speed: 8 }, path)[fields.curveLoad] > obs[fields.curveLoad]);
  assert.ok(compare({ ...ego, x: -.65 }, path)[fields.crossTrack] > obs[fields.crossTrack]);
  assert.throws(() => measureConnectedCurve(measured(ego, tick + 6), path), { code: "STALE_OBSERVATION" });
  const actor = new PursuitPpo("connected-curve-observation", null, PAKO_CURVE_OBSERVATION.version);
  assert.deepEqual(new PursuitPpo(null, actor.checkpoint()).action(obs), actor.action(obs));
  assert.throws(() => freezePursuitPolicy(actor.checkpoint()), /connected curve research adapter/);
});

test("connected endpoint observation distinguishes passed finish and available braking room", () => {
  const env = new GtaPursuitEnv();
  env.reset({ seed: "connected-endpoint-boundary", shield: true, config: { ruleset: "dispatch-v1" } });
  const { world } = env;
  const path = [{ x: 2, z: 0 }, { x: 2, z: 7 }, { x: 2, z: 14 }];
  const at = (z, speed) => ({ tick: world.tick, pursuit: world.pursuit,
    player: { ...world.player, x: 2, z, heading: 0, speed } });
  const approaching = at(8, 3), lowSpeed = measureConnectedEndpoint(approaching, path);
  const fast = measureConnectedEndpoint(at(8, 11), path);
  const overrun = measureConnectedEndpoint(at(17, 3), path);
  assert.deepEqual(lowSpeed.slice(0, PAKO_CURVE_OBSERVATION.length), measureConnectedCurve(approaching, path));
  assert.equal(lowSpeed.at(-2), fast.at(-2));
  assert.ok(lowSpeed.at(-2) > 0 && overrun.at(-2) < 0);
  assert.ok(lowSpeed.at(-1) > 0 && fast.at(-1) < 0);
  const model = new PursuitPpo("connected-endpoint-boundary", null, PAKO_ENDPOINT_OBSERVATION.version);
  assert.doesNotThrow(() => model.action(lowSpeed));
  assert.throws(() => freezePursuitPolicy(model.checkpoint()), /connected endpoint research adapter/);
});

test("queue research observes actual scan and public branch intent without reading actor truth or admitting City playback", () => {
  const env = new GtaPursuitEnv();
  env.reset({ seed: "queue-intent-boundary", shield: true, config: { ruleset: "dispatch-v1" } });
  const { player, pursuit, tick } = env.world;
  const measured = {
    player, pursuit, tick,
    get actors() { throw new Error("private actor state"); },
    get statics() { throw new Error("private collider state"); },
  };
  const heading = player.heading;
  const lane = { heading, center: player.x * Math.cos(heading) - player.z * Math.sin(heading),
    targetLateral: 1.5, halfWidth: 6 };
  const branch = { approachM: -20, roomM: 40, turn: 1 };
  const base = measureQueueIntent(measured, lane);
  const approaching = measureQueueBranchIntent(measured, lane, branch);
  const closer = measureQueueBranchIntent(measured, lane, { ...branch, approachM: -8 });
  assert.deepEqual(approaching.slice(0, base.length), base);
  assert.ok(approaching[base.length + 1] < closer[base.length + 1]);
  assert.throws(() => measureQueueBranchIntent(measured, lane, { ...branch, roomM: Infinity }),
    /finite public branch geometry/);
  assert.throws(() => measureQueueIntent({ ...{ player, pursuit }, tick: tick + 6 }, lane),
    { code: "STALE_OBSERVATION" });
  for (const [schema, obs] of [[PAKO_QUEUE_OBSERVATION, base], [PAKO_QUEUE_BRANCH_OBSERVATION, approaching]]) {
    const actor = new PursuitPpo("queue-admission", null, schema.version);
    const checkpoint = actor.checkpoint();
    assert.deepEqual(new PursuitPpo(null, checkpoint).action(obs), actor.action(obs));
    assert.throws(() => freezePursuitPolicy(checkpoint), /queue research adapter/);
  }
});

const { outputFiles: [bundle] } = await build({
  entryPoints: [fileURLToPath(new URL("../src/rl/pursuit-lab-worker.js", import.meta.url))],
  bundle: true, format: "iife", platform: "browser", target: "es2022", write: false,
});
// Exercise the real worker entrypoint and structured-clone boundary, without starting a browser.
const workerCode = `import { parentPort } from 'node:worker_threads';
globalThis.self = { postMessage: data => parentPort.postMessage(data) };
${bundle.text}
parentPort.on('message', data => self.onmessage({ data }));`;
const workerUrl = new URL(`data:text/javascript;base64,${Buffer.from(workerCode).toString("base64")}`);
const isTerminal = message => ["stopped", "completed", "fault"].includes(message.status);
const trainingSeed = "metro-dispatch-development";
const begin = (sessionId, options) => ({ type: "session-start", sessionId, stage: "maneuver",
  mode: "train", maxEpisodes: 2, maxSeconds: 40, speed: "fast", ...options });
const finishedEpisodes = (messages, sessionId) => [...new Map(messages.flatMap(message =>
  message.sessionId === sessionId && message.lastEpisode ? [[message.lastEpisode.index, message.lastEpisode]] : [])).values()];

function connect(t) {
  const worker = new Worker(workerUrl);
  t.after(() => worker.terminate());
  const inbox = on(worker, "message", { signal: t.signal }), seen = [];
  worker.on("message", message => seen.push(message));
  return {
    seen,
    send: data => worker.postMessage(data),
    async read(match = () => true) {
      for (;;) {
        const { value: [message] } = await inbox.next();
        if (match(message)) return message;
        if (message.status === "fault" || message.error) assert.fail(message.error);
      }
    },
  };
}

function checkActual(episode) {
  const { trajectory } = episode;
  assert.equal(episode.traceSource, "actual");
  assert.equal(trajectory[0][0], 0, "real reset sample");
  assert.equal(trajectory.at(-1)[0], episode.ticks, "real terminal sample");
  assert.ok(trajectory.length > 1 && trajectory.length <= 128);
  assert.ok(trajectory.every((row, index) => row.length === 5 && row.every(Number.isFinite) &&
    (!index || row[0] > trajectory[index - 1][0])));
  assert.ok(Math.hypot(trajectory.at(-1)[1] - trajectory[0][1], trajectory.at(-1)[2] - trajectory[0][2]) > .01);
}

test("the focused worker selects clean scoring for new sessions and preserves legacy resume", { timeout: 20_000 }, async t => {
  const worker = connect(t);
  const stage = chaseCurriculum.stages[0];
  const options = { stage: stage.id, maxSeconds: 10, speed: "normal" };
  const oldCheckpoint = { ...new PursuitPpo(trainingSeed, null, stage.observation).checkpoint(),
    development: { stage: stage.id, curriculumSha256: digest(chaseCurriculum) } };

  async function stopAfterStart(id, checkpoint) {
    worker.send(begin(id, { ...options, checkpoint }));
    const active = await worker.read(row => row.sessionId === id && row.activeEpisode && row.status === "running");
    worker.send({ type: "session-control", sessionId: id, action: "stop" });
    const stopped = await worker.read(row => row.sessionId === id && isTerminal(row));
    assert.equal(stopped.status, "stopped");
    return { active, stopped };
  }
  const fresh = await stopAfterStart("new-clean-scoring");
  assert.equal(fresh.active.rewardProfile, CLEAN_ESCAPE_REWARD);
  const legacy = await stopAfterStart("old-scoring", oldCheckpoint);
  assert.equal(legacy.active.rewardProfile, undefined);
  assert.deepEqual(legacy.stopped.checkpoint, oldCheckpoint);

  const incompatible = { ...oldCheckpoint, development: { ...oldCheckpoint.development, rewardProfile: "unknown" } };
  worker.send(begin("wrong-reward", { ...options, checkpoint: incompatible }));
  const fault = await worker.read(row => row.sessionId === "wrong-reward" && isTerminal(row));
  assert.equal(fault.status, "fault");
  assert.match(fault.error, /reward profile/);
  assert.equal(fault.episodes, 0);
});

test("the untyped one-update worker preserves its result shape and cross-stage resume", { timeout: 20_000 }, async t => {
  const worker = connect(t);
  worker.send({ stage: "maneuver" });
  const first = await worker.read();
  assert.deepEqual(Object.keys(first), ["checkpoint", "metrics"]);
  const model = new PursuitPpo(trainingSeed);
  const { rollout, bootstrap, metrics } = collectPursuitRollout(model, curriculum.stages[0], curriculum.trainingSeeds);
  model.update(rollout, bootstrap);
  assert.deepEqual(first, { checkpoint: { ...model.checkpoint(),
    development: { curriculumSha256: digest(curriculum), stage: "maneuver" } }, metrics });

  const restarted = connect(t);
  restarted.send({ stage: "left-crossing", checkpoint: first.checkpoint });
  const continued = await restarted.read();
  assert.ok(continued.checkpoint, continued.error);
  assert.equal(continued.checkpoint.development.stage, "left-crossing");
  assert.equal(continued.checkpoint.updates, 2);

  const singleton = connect(t);
  singleton.send(begin("explicit-single", { worlds: 1, maxEpisodes: 1 }));
  const typed = await singleton.read(isTerminal);
  assert.equal(typed.worlds, 1);
  assert.equal(digest(typed.checkpoint), digest(first.checkpoint), "explicit single-world checkpoint keeps legacy bytes");
  t.diagnostic(JSON.stringify({ legacySha256: digest(first), resumedUpdates: continued.checkpoint.updates }));
});

test("the Worker interleaves two Metro worlds and resumes the next shared update exactly", { timeout: 40_000 }, async t => {
  const worker = connect(t);
  worker.send(begin("joined", { worlds: 2, maxEpisodes: 4 }));
  const progress = await worker.read(row => row.activeWorlds === 2 && row.activeEpisodes.every(ep => ep.ticks > 0));
  assert.deepEqual(progress.activeEpisodes.map(ep => ep.index), [1, 2]);
  assert.deepEqual(progress.activeEpisode, progress.activeEpisodes[0]);
  assert.equal(progress.worlds, 2);
  assert.equal(progress.updates, 0);
  const first = await worker.read(row => row.checkpoint?.updates === 1);
  assert.deepEqual([first.episodes, first.transitions, first.optimizerSteps], [2, 120, 16]);
  assert.equal(first.checkpoint.development.worlds, 2);
  const full = await worker.read(isTerminal);
  assert.deepEqual([full.status, full.episodes, full.updates, full.transitions, full.optimizerSteps],
    ["completed", 4, 2, 240, 32]);
  assert.deepEqual([full.activeWorlds, full.activeEpisodes, full.activeEpisode], [0, [], undefined]);
  const observed = finishedEpisodes(worker.seen, "joined");
  assert.deepEqual(observed.map(ep => [ep.index, ep.worldIndex, ep.policy.updates, ep.policy.selection]), [
    [1, 1, 0, "sampled"], [2, 2, 0, "sampled"], [3, 1, 1, "sampled"], [4, 2, 1, "sampled"],
  ]);
  assert.deepEqual(observed.map(ep => ep.seed), curriculum.trainingSeeds);
  assert.equal(new Set(observed.map(ep => ep.rngSeed)).size, 4);
  observed.forEach(checkActual);
  assert.notDeepEqual(observed[0].trajectory, observed[1].trajectory);

  worker.send(begin("interrupt", { worlds: 2, checkpoint: first.checkpoint, maxEpisodes: 4 }));
  await worker.read(row => row.activeWorlds === 2 && row.activeEpisodes.every(ep => ep.ticks > 0));
  worker.send({ type: "session-control", sessionId: "interrupt", action: "pause" });
  const paused = await worker.read(row => row.status === "paused");
  assert.equal(paused.activeWorlds, 2);
  const count = worker.seen.length;
  await sleep(100);
  assert.equal(worker.seen.length, count);
  worker.send({ type: "session-control", action: "resume" });
  const resumed = await worker.read(row => row.status === "running");
  assert.deepEqual(resumed.activeEpisodes, paused.activeEpisodes);
  worker.send({ type: "session-control", action: "stop" });
  const stopped = await worker.read(isTerminal);
  assert.deepEqual([stopped.status, stopped.episodes, stopped.updates, stopped.activeWorlds], ["stopped", 0, 1, 0]);
  assert.deepEqual(stopped.checkpoint, first.checkpoint);

  const reopened = connect(t);
  const serialized = JSON.parse(JSON.stringify(stopped.checkpoint));
  reopened.send(begin("resume-joined", { worlds: 2, checkpoint: serialized, maxEpisodes: 3 }));
  const continued = await reopened.read(isTerminal);
  assert.deepEqual([continued.status, continued.episodes, continued.updates, continued.transitions],
    ["completed", 3, 2, 240]);
  assert.deepEqual(continued.checkpoint, full.checkpoint, "the extra unpaired episode cannot commit");
  const [a, b, partial] = finishedEpisodes(reopened.seen, "resume-joined");
  for (const [actual, expected] of [[a, observed[2]], [b, observed[3]]]) {
    assert.equal(actual.seed, expected.seed);
    assert.equal(actual.rngSeed, expected.rngSeed);
    assert.deepEqual(actual.trajectory, expected.trajectory);
  }
  assert.equal(partial.policy.updates, 2);
  assert.equal(partial.index, 3);
  checkActual(partial);

  reopened.send(begin("wrong-width", { checkpoint: serialized }));
  const wrongWidth = await reopened.read(isTerminal);
  assert.equal(wrongWidth.status, "fault");
  assert.match(wrongWidth.error, /same number of worlds/);

  reopened.send(begin("parallel-frozen", { mode: "evaluate", worlds: 4, checkpoint: continued.checkpoint }));
  const evaluated = await reopened.read(isTerminal);
  assert.equal(evaluated.worlds, 4);
  assert.deepEqual(evaluated.checkpoint, continued.checkpoint);
  const evaluation = reopened.seen.filter(row => row.sessionId === "parallel-frozen");
  const evalCapacity = Math.max(...evaluation.map(row => row.activeWorlds));
  assert.equal(evalCapacity, curriculum.validationSeeds.length);
  assert.deepEqual(finishedEpisodes(evaluation, "parallel-frozen").map(ep => [ep.seed, ep.policy.selection]),
    curriculum.validationSeeds.map(seed => [seed, "frozen"]));
  t.diagnostic(JSON.stringify({ concurrentAcceptedTicks: progress.activeEpisodes.map(ep => [ep.index, ep.ticks]),
    phases: observed.map(ep => [ep.index, ep.seed, ep.phase, ep.ticks, ep.policy.updates]),
    pausedAt: paused.activeEpisodes.map(ep => ep.ticks), updates: full.updates, transitions: full.transitions,
    optimizerSteps: full.optimizerSteps, uninterrupted: digest(full.checkpoint), resumed: digest(continued.checkpoint),
    discardedPartialIndex: partial.index, frozenCapacity: evaluated.worlds, frozenPeakActive: evalCapacity }));
});

test("four independent Metro cursors join by allocation order, not finish order", { timeout: 20_000 }, async t => {
  const stage = { ...routeCurriculum.stages[0], episodeSeconds: .6 };
  const manifest = { stages: [stage], trainingSeeds: ["pako-batch-slow", "pako-batch-early", "pako-batch-third"] };
  const curriculumSha256 = digest(manifest), msgs = [], worlds = [];
  const reset = GtaPursuitEnv.prototype.reset;
  t.mock.method(GtaPursuitEnv.prototype, "reset", function (options) {
    const seconds = options.seed.endsWith("early") ? .2 : stage.episodeSeconds;
    const result = reset.call(this, { ...options, config: { ...options.config, episodeMaxSeconds: seconds } });
    assert.equal(this.world.environment, "metro");
    assert.equal(this.world.tick, 0);
    worlds.push(this.world);
    return result;
  });
  const end = await new Promise(resolve => {
    createPursuitSession(begin("ordered", { worlds: 4, maxEpisodes: 8 }), {
      manifest, stage, curriculumSha256,
    }, message => {
      msgs.push(message);
      if (isTerminal(message)) resolve(message);
    }).start();
  });
  assert.equal(end.status, "completed", end.error);
  assert.deepEqual([end.episodes, end.updates, end.checkpoint.development.worlds], [8, 1, 4]);
  assert.equal(new Set(worlds).size, 8);
  assert.equal(new Set(worlds.map(world => world.player)).size, 8);
  assert.equal(Math.max(...msgs.map(row => row.activeWorlds)), 4);
  const finished = finishedEpisodes(msgs, "ordered");
  assert.deepEqual(finished.map(ep => ep.index), [2, 1, 3, 4, 5, 8, 6, 7]);
  const allocated = [...finished].sort((a, b) => a.index - b.index);
  assert.deepEqual(allocated.slice(0, 4).map(ep => ep.seed), [...manifest.trainingSeeds,
    "pako-training-world-4-0:pako-batch-slow"]);
  assert.equal(new Set(allocated.map(ep => ep.seed)).size, 8);
  assert.ok(worlds.every((world, index) => world.config.seed === allocated[index].seed));
  assert.equal(new Set(allocated.map(ep => ep.rngSeed)).size, 8);
  allocated.forEach(checkActual);

  const baseline = new PursuitPpo(trainingSeed, null, stage.observation);
  const completionOrder = new PursuitPpo(trainingSeed, null, stage.observation);
  const replayed = new Map(allocated.map(episode => {
    const rng = new Random(episode.rngSeed);
    const run = runPursuitEpisode({ ...stage, scenario: episode.scenario }, episode.seed,
      obs => baseline.sample(obs, rng), true);
    assert.equal(run.metrics.ticks, episode.ticks);
    assert.equal(run.metrics.reward, episode.reward);
    run.rollout.at(-1).episodeBootstrap = run.last.terminated ? 0 : baseline.value(run.last.obs);
    return [episode.index, run.rollout];
  }));
  baseline.update(allocated.flatMap(episode => replayed.get(episode.index)));
  completionOrder.update(finished.flatMap(episode => replayed.get(episode.index)));
  assert.deepEqual(end.checkpoint, { ...baseline.checkpoint(),
    development: { curriculumSha256, stage: stage.id, worlds: 4 } });
  assert.notDeepEqual(end.checkpoint.weights, completionOrder.checkpoint().weights);
  t.diagnostic(JSON.stringify({ worldsCreated: 8, peakActive: 4, allocation: allocated.map(ep =>
    [ep.index, ep.seed, ep.scenario, ep.ticks]), completion: finished.map(ep => ep.index),
    optimizerSteps: end.optimizerSteps, checkpoint: digest(end.checkpoint) }));
});

test("normal speed paces each world and a wall cutoff cannot commit a partial batch", { timeout: 20_000 }, async t => {
  const worker = connect(t), maxSeconds = 1.2;
  worker.send(begin("multi-clock", { worlds: 2, speed: "normal", maxSeconds }));
  const end = await worker.read(isTerminal);
  assert.deepEqual([end.reason, end.worlds, end.episodes, end.updates, end.activeWorlds, end.checkpoint],
    ["time-budget", 2, 0, 0, 0, undefined]);
  const ticks = worker.seen.flatMap(row => row.activeEpisodes.map(episode => episode.ticks));
  assert.ok(worker.seen.some(row => row.activeWorlds === 2 && row.activeEpisodes.every(episode => episode.ticks > 0)));
  assert.ok(Math.max(...ticks) <= Math.ceil(maxSeconds * 60), "normal cadence is not accelerated by batching");
  t.diagnostic(JSON.stringify({ maxSeconds, maxReportedPhysicalTick: Math.max(...ticks), updates: end.updates }));
});

test("one Worker start repeats actual Metro episodes, resumes Adam exactly and evaluates frozen", { timeout: 40_000 }, async t => {
  const worker = connect(t), stageId = "crossing-pursuit", stage = curriculum.stages.find(row => row.id === stageId);
  worker.send(begin("continuous", { stage: stageId }));
  const first = await worker.read(message => message.checkpoint?.updates === 1);
  const full = await worker.read(isTerminal);
  assert.equal(full.status, "completed");
  assert.equal(full.reason, "episode-budget");
  assert.deepEqual([full.episodes, full.updates, full.transitions, full.optimizerSteps], [2, 2, 160, 24]);
  const traced = new Map(worker.seen.filter(row => row.lastEpisode).map(row => [row.lastEpisode.index, row.lastEpisode]));
  assert.deepEqual([...traced.values()].map(row => [row.id, row.seed, row.phase, row.ticks, row.policy.updates]), [
    ["continuous:1", curriculum.trainingSeeds[0], "timeout", 480, 0],
    ["continuous:2", curriculum.trainingSeeds[1], "timeout", 480, 1],
  ]);
  for (const episode of traced.values()) {
    checkActual(episode);
    assert.equal(episode.policy.selection, "sampled");
    assert.ok(episode.reward < 0);
  }
  assert.deepEqual(traced.get(1).trajectory[0], traced.get(2).trajectory[0]);
  assert.notDeepEqual(traced.get(1).trajectory.at(-1), traced.get(2).trajectory.at(-1));
  assert.notDeepEqual(first.checkpoint.weights, full.checkpoint.weights);
  for (const key of ["firstMoment", "secondMoment"])
    assert.ok(first.checkpoint[key].some(value => value !== 0), `${key} is actual Adam state`);

  const saved = JSON.parse(JSON.stringify(first.checkpoint));
  worker.send(begin("continued", { stage: stageId, maxEpisodes: 1, checkpoint: saved }));
  const resumed = await worker.read(isTerminal);
  assert.equal(resumed.episodes, 1);
  assert.deepEqual(resumed.lastEpisode.trajectory, full.lastEpisode.trajectory);
  assert.deepEqual(resumed.checkpoint, full.checkpoint, "weights, moments, seeds and counters resume bit for bit");

  const resetAdam = new PursuitPpo(null, { ...saved,
    firstMoment: saved.firstMoment.map(() => 0), secondMoment: saved.secondMoment.map(() => 0) });
  const { rollout, bootstrap } = collectPursuitRollout(resetAdam, stage, curriculum.trainingSeeds);
  resetAdam.update(rollout, bootstrap);
  assert.notDeepEqual(resetAdam.checkpoint().weights, full.checkpoint.weights, "weight-only resume fails the oracle");

  worker.send(begin("testing", { stage: stageId, mode: "evaluate", checkpoint: resumed.checkpoint }));
  const evaluated = await worker.read(isTerminal);
  const evaluation = worker.seen.filter(row => row.sessionId === "testing");
  assert.equal(evaluated.episodes, 2);
  assert.deepEqual(evaluated.checkpoint, resumed.checkpoint);
  assert.ok(evaluation.every(row => row.updates === 2 && row.transitions === 160 && row.optimizerSteps === 24));
  assert.deepEqual([...new Set(evaluation.flatMap(row => row.lastEpisode ? [row.lastEpisode.seed] : []))],
    curriculum.validationSeeds);
  const frozen = freezePursuitPolicy(resumed.checkpoint), actual = [];
  const reference = runPursuitEpisode(stage, evaluated.lastEpisode.seed, frozen.action, false,
    row => actual.push(row.slice(0, 5)),
    world => { if (world.tick === 0) {
      const { x, z, speed, heading } = world.player;
      actual.push([0, x, z, speed, heading]);
    } });
  assert.equal(evaluated.lastEpisode.policy.selection, "frozen");
  assert.equal(evaluated.lastEpisode.reward, reference.metrics.reward);
  assert.deepEqual(evaluated.lastEpisode.trajectory, actual);
  t.diagnostic(JSON.stringify({ episodes: [...traced.values()].map(({ id, seed, phase, ticks, reward, collisions,
    distanceM, trajectory }) => ({ id, seed, phase, ticks, reward, collisions, distanceM, samples: trajectory.length,
    first: trajectory[0], last: trajectory.at(-1) })), updates: full.updates, transitions: full.transitions,
    firstCheckpointSha256: digest(first.checkpoint),
    adam: full.optimizerSteps, continuedSha256: digest(resumed.checkpoint), uninterruptedSha256: digest(full.checkpoint),
    weightOnlySha256: digest(resetAdam.checkpoint().weights), trainedWeightSha256: digest(full.checkpoint.weights),
    frozenSeed: evaluated.lastEpisode.seed, frozenSha256: digest(evaluated.checkpoint) }));
});

test("pause and stop take effect mid-episode without needing the time budget", { timeout: 20_000 }, async t => {
  const worker = connect(t);
  worker.send(begin("controls", { maxEpisodes: 8 }));
  const committed = await worker.read(row => row.checkpoint?.updates === 1);
  await worker.read(row => row.episodes === 1 && row.activeEpisode?.ticks > 0);
  worker.send({ type: "session-control", sessionId: "other-session", action: "stop" });
  worker.send({ type: "session-control", action: "pause" });
  const paused = await worker.read(row => row.status === "paused");
  assert.equal(paused.episodes, 1);
  assert.equal(paused.activeEpisode.index, 2);
  assert.ok(paused.activeEpisode.ticks > 0 && paused.activeEpisode.ticks < 360);
  const before = worker.seen.length;
  await sleep(330);
  assert.equal(worker.seen.length, before, "no progress while paused");

  worker.send({ type: "session-control", action: "resume" });
  const resumed = await worker.read(row => row.status === "running");
  assert.deepEqual(resumed.activeEpisode, paused.activeEpisode, "resume the same world rather than resetting");
  const stopStarted = performance.now();
  worker.send({ type: "session-control", action: "stop" });
  const stopped = await worker.read(isTerminal);
  const stopAckMs = performance.now() - stopStarted;
  assert.equal(stopped.status, "stopped");
  assert.equal(stopped.reason, "user-stop");
  assert.equal(stopped.episodes, 1);
  assert.deepEqual(stopped.checkpoint, committed.checkpoint);
  assert.equal(stopped.lastEpisode.id, "controls:1");
  const after = worker.seen.length;
  await sleep(150);
  assert.equal(worker.seen.length, after, "stopped driver stays stopped");
  t.diagnostic(JSON.stringify({ pausedTick: paused.activeEpisode.ticks, resumedTick: resumed.activeEpisode.ticks,
    stop: stopped.reason, stopAckMs, committedSha256: digest(committed.checkpoint), stoppedSha256: digest(stopped.checkpoint) }));
});

test("normal pacing honors active wall-time, excluding time spent paused", { timeout: 20_000 }, async t => {
  const worker = connect(t);
  const maxSeconds = .8;
  worker.send(begin("clock", { speed: "normal", maxSeconds }));
  const ready = await worker.read(row => row.activeEpisode?.ticks === 0);
  worker.send({ type: "session-control", action: "pause" });
  const paused = await worker.read(row => row.status === "paused");
  await sleep(850);
  worker.send({ type: "session-control", action: "resume" });
  const resumed = await worker.read(row => row.status === "running");
  assert.deepEqual(resumed.activeEpisode, paused.activeEpisode);
  const end = await worker.read(isTerminal);
  assert.equal(end.status, "completed");
  assert.equal(end.reason, "time-budget");
  assert.equal(end.episodes, 0);
  assert.equal(end.updates, 0);
  assert.equal(end.checkpoint, undefined);
  const maxTick = Math.max(...worker.seen.flatMap(row => row.activeEpisode ? [row.activeEpisode.ticks] : []));
  assert.ok(maxTick > ready.activeEpisode.ticks && maxTick <= Math.ceil(maxSeconds * 60),
    `normal speed advances with the clock, actual sampled tick ${maxTick}`);
  t.diagnostic(JSON.stringify({ activeSecondsBudget: maxSeconds, maxReportedPhysicalTick: maxTick, end: end.reason }));
});

test("real paired course variants retain separate returns and never checkpoint a partial batch", { timeout: 30_000 }, async t => {
  const stage = { ...routeCurriculum.stages[0], episodeSeconds: 12 };
  const manifest = { ...routeCurriculum, stages: [stage] };
  const workload = { manifest, stage, curriculumSha256: digest(manifest) };
  const drive = (id, maxEpisodes) => new Promise(resolve => {
    const rows = [];
    createPursuitSession(begin(id, { stage: stage.id, maxEpisodes }), workload, row => {
      rows.push(row);
      if (isTerminal(row)) resolve(rows);
    }).start();
  });
  const partial = (await drive("partial", 1)).at(-1);
  assert.equal(partial.episodes, 1);
  assert.ok(partial.lastEpisode.collisions > 0);
  assert.equal(partial.updates, 0);
  assert.equal(partial.checkpoint, undefined);
  const rows = await drive("paired", 2), end = rows.at(-1);
  const episodes = rows.filter(row => row.lastEpisode && row.status === "running").map(row => row.lastEpisode);
  assert.deepEqual(episodes.map(row => row.scenario), stage.scenarios);
  assert.ok(episodes.every(row => row.seed === manifest.trainingSeeds[0] &&
    row.policy.updates === 0 && row.collisions > 0), "both physical variants complete before the shared update");
  episodes.forEach(checkActual);

  const model = new PursuitPpo(trainingSeed, null, stage.observation);
  const leaked = new PursuitPpo(trainingSeed, null, stage.observation);
  const rng = new Random(`${trainingSeed}:rollout:0`);
  const references = stage.scenarios.map(scenario => runPursuitEpisode({ ...stage, scenario },
    manifest.trainingSeeds[0], obs => model.sample(obs, rng), true));
  const [a, b] = references;
  const aValue = a.last.terminated ? 0 : model.value(a.last.obs);
  const bValue = b.last.terminated ? 0 : model.value(b.last.obs);
  const rollout = [...a.rollout, ...b.rollout];
  leaked.update(rollout, bValue); // Deliberately carry the second episode's GAE into the first.
  a.rollout.at(-1).episodeBootstrap = aValue;
  b.rollout.at(-1).episodeBootstrap = bValue;
  model.update(rollout);
  assert.deepEqual(end.checkpoint, { ...model.checkpoint(),
    development: { stage: stage.id, curriculumSha256: workload.curriculumSha256 } });
  assert.notDeepEqual(end.checkpoint.weights, leaked.checkpoint().weights);
  t.diagnostic(JSON.stringify({ sampledVariants: episodes.map(({ scenario, phase, ticks, collisions, reward }) =>
    ({ scenario, phase, ticks, collisions, reward })), jointUpdates: end.updates, jointTransitions: end.transitions,
    boundaryAwareSha256: digest(end.checkpoint.weights), leakedReturnsSha256: digest(leaked.checkpoint().weights) }));
});

test("one real Metro session resets after a qualified escape, a wreck and a capture", { timeout: 30_000 }, async t => {
  const [escape, wreck, capture, empty] = ["escape", "wreck", "capture", "empty"].map(x => `pako-session-terminal-${x}`);
  const stage = { id: "local-session-terminal-order", traffic: 0, pedestrians: 0, observation: "dispatch-route-v1",
    wantedLevel: 1, wantedLevelMax: 1, patrols: 2, episodeSeconds: 12 };
  const manifest = { trainingSeeds: [escape, wreck, capture, empty], stages: [stage] };
  const curriculumSha256 = digest(manifest), worlds = [], rows = [];
  const command = World.prototype.command, reset = GtaPursuitEnv.prototype.reset, step = GtaPursuitEnv.prototype.step;
  const corniche = world => world.drivingRoads.find(road => road.id === "corniche-avenue");
  const apronRun = seed => seed === escape || seed === empty;
  // Only tick-zero setup changes. The game owns movement, contacts, capture and escape throughout.
  t.mock.method(World.prototype, "command", function (action, ...args) {
    if (action.type === "street-pursuit-start" && apronRun(this.config.seed)) {
      assert.equal(this.tick, 0);
      const road = corniche(this);
      Object.assign(this.player, districtRoadPose(road, -65, 1), { speed: 26 });
      this.actorIndex = new SpatialIndex(this.actors);
      const result = command.call(this, action, ...args);
      // The static navigation cue must be set before Env reads and caches its first observation.
      this.pursuit.gta.publicRouteGoal = { ...districtRoadPose(road, 82, 1), roadId: road.id };
      return result;
    }
    return command.call(this, action, ...args);
  });
  t.mock.method(GtaPursuitEnv.prototype, "reset", function (options) {
    const { seed, config } = options;
    const initial = reset.call(this, { ...options, config: { ...config,
      maxActivePatrols: seed === capture ? 2 : seed === escape ? 1 : 0,
      playerMaxHealth: seed === wreck ? 1 : 100 } });
    const { world } = this, { player, pursuit } = world;
    assert.equal(world.tick, 0);
    assert.equal(pursuit.phase, "running");
    assert.equal(this.shield, true);
    assert.equal(pursuit.gta.config.npcSpeedMultiplier, 1);
    assert.deepEqual(pursuit.gta.config.surveillanceZones, DEFAULT_SURVEILLANCE_ZONES);
    const units = [...pursuit.patrols];
    if (apronRun(seed)) {
      if (seed === escape) {
        assert.equal(units.length, 1);
        Object.assign(units[0], districtRoadPose(corniche(world), -107, 1), { speed: 6.8 });
      }
    } else if (seed === wreck) {
      player.speed = 8;
      const solid = { id: "pako-session-local-solid", type: "static", kind: "barrier", length: .7,
        width: 2.3, height: .9, heading: player.heading, x: player.x + 4.2, z: player.z };
      assert.ok(bodyOnRoad(solid, world.drivingRoads) && world.free(solid, .15));
      world.statics.push(solid);
      world.staticIndex = new SpatialIndex(world.statics);
    } else {
      assert.equal(units.length, 2);
      units.forEach((unit, i) => Object.assign(unit, { x: player.x + (i ? 7 : -7), z: player.z,
        heading: i ? -Math.PI / 2 : Math.PI / 2, speed: 2 }));
    }
    const bodies = [player, ...units];
    assert.ok(bodies.every((body, i) => bodyOnRoad(body, world.drivingRoads) &&
      !world.statics.concat(bodies.slice(0, i)).some(other => overlaps(body, other, .1))));
    world.actorIndex = new SpatialIndex(world.actors);
    updatePursuitResponse(world, true);
    pursuit.gta.scanner = new PursuitScanner();
    pursuit.gta.scan = pursuit.gta.scanner.sample(world);
    const tail = seed === escape ? units[0] : null;
    worlds.push({ world, tail, start: { x: player.x, z: player.z }, startHealth: player.health,
      tailStart: tail && { x: tail.x, z: tail.z }, activeMax: 0, activeBeforeEnd: 0, contacts: [], outcome: 0 });
    return { ...initial, obs: this.getObservation() };
  });
  t.mock.method(GtaPursuitEnv.prototype, "step", function (...args) {
    const result = step.apply(this, args), witness = worlds.at(-1);
    assert.equal(this.world, witness.world);
    witness.activeMax = Math.max(witness.activeMax, result.info.activePatrols);
    if (!result.terminated && !result.truncated) witness.activeBeforeEnd = result.info.activePatrols;
    witness.outcome += result.info.rewardComponents.outcome;
    witness.contacts.push(...result.info.events.filter(event => event.damageToPlayer > 0));
    if (result.terminated || result.truncated) witness.terminal = result;
    return result;
  });

  // Hand-set starting actor for a controlled lifecycle test, not evidence of learned skill.
  const model = new PursuitPpo("pako-session-local-terminal-policy", null, stage.observation);
  const { INPUT, HIDDEN_BIAS, OUTPUT_WEIGHTS, OUTPUT_BIAS, schema } = model.layout;
  const cue = schema.navigation.offset, hiddenCount = OUTPUT_WEIGHTS - HIDDEN_BIAS;
  model.weights.fill(0);
  model.weights[cue + 1] = .9;
  model.weights[cue + 5] = 1.4;
  model.weights[INPUT] = 7;
  model.weights[HIDDEN_BIAS + 1] = -.7;
  model.weights[2 * INPUT + cue + 8] = 14;
  model.weights[HIDDEN_BIAS + 2] = -5.6;
  model.weights[OUTPUT_WEIGHTS] = .95;
  model.weights[OUTPUT_WEIGHTS + 2 * hiddenCount + 1] = -6;
  model.weights[OUTPUT_WEIGHTS + 2 * hiddenCount + 2] = -6;
  model.weights[OUTPUT_BIAS + 1] = 6;
  model.weights[OUTPUT_BIAS + 2] = 5;
  const checkpoint = { ...model.checkpoint(), development: { curriculumSha256, stage: stage.id } };
  const end = await new Promise(resolve => {
    createPursuitSession(begin("terminals", { stage: stage.id, checkpoint, maxEpisodes: 4, maxSeconds: 20 }),
      { manifest, stage, curriculumSha256 }, message => {
        rows.push(message);
        if (isTerminal(message)) resolve(message);
      }).start();
  });

  const episodes = [...new Map(rows.flatMap(row => row.lastEpisode ? [[row.lastEpisode.id, row.lastEpisode]] : [])).values()];
  const observed = worlds.map(({ world, tail, tailStart, start, startHealth, contacts, activeMax, activeBeforeEnd,
    terminal, outcome }, i) => {
    const { response, gta, phase, wantedLevel } = world.pursuit;
    return { seed: world.config.seed, phase, tick: world.tick, startHealth, health: world.player.health, activeMax,
      activeBeforeEnd, tookDamage: contacts.map(({ actorId, damageToPlayer, closingSpeed }) =>
        ({ actorId, damageToPlayer, closingSpeed })), pinTicks: gta.pinnedTicks, outcome, wantedLevel,
      startGap: distance(start, world.player), lostAt: response.lostAtTick, clearAt: response.clearAtTick,
      clearProgress: response.clearProgress, reportGap: response.lastSeen && distance(response.lastSeen, world.player),
      mobileTrackTicks: response.dispatch.mobileTrackTicks, qualified: response.dispatch.escapeEligible,
      tailTravel: tail && distance(tailStart, tail), tailGap: tail && distance(tail, world.player),
      terminated: terminal?.terminated, truncated: terminal?.truncated,
      collisions: episodes[i]?.collisions, reward: episodes[i]?.reward };
  });
  t.diagnostic(JSON.stringify({ end: end.status, error: end.error, reason: end.reason, episodes: observed,
    updates: end.updates, transitions: end.transitions, adam: end.optimizerSteps }));
  assert.equal(end.status, "completed", end.error);
  assert.equal(end.reason, "episode-budget");
  assert.deepEqual(episodes.map(({ phase }) => phase), ["escaped", "wrecked", "busted", "timeout"]);
  assert.deepEqual(episodes.map(({ policy }) => policy.updates), [0, 1, 2, 3]);
  assert.deepEqual(episodes.map(({ seed }) => seed), manifest.trainingSeeds);
  assert.deepEqual(episodes.map(({ trajectory }) => [trajectory[0][0], trajectory.at(-1)[0]]),
    observed.map(({ tick }) => [0, tick]));
  assert.equal(end.updates, 4);
  assert.ok(end.optimizerSteps > 0);
  assert.equal(end.transitions, episodes.reduce((n, episode) => n + Math.ceil(episode.ticks / 6), 0));
  assert.notDeepEqual(checkpoint.weights, end.checkpoint.weights);
  assert.equal(new Set(worlds.map(row => row.world)).size, 4, "each episode uses a new World");
  assert.deepEqual(observed.map(row => [row.terminated, row.truncated]), [[true, false], [true, false],
    [true, false], [false, true]]);

  const [fled, hit, pinned, noPolice] = observed;
  assert.ok(fled.qualified && fled.mobileTrackTicks >= 60 && fled.tailTravel > 10 && fled.activeBeforeEnd === 1);
  assert.ok(fled.startGap >= 45 && fled.reportGap >= 32 && fled.tailGap >= 28);
  assert.ok(fled.lostAt <= fled.clearAt && fled.tick - fled.clearAt >= 324);
  assert.equal(fled.wantedLevel, 0);
  assert.equal(fled.clearProgress, 1);
  assert.ok(fled.outcome > 0 && fled.collisions === 0);
  assert.equal(hit.health, 0);
  assert.equal(hit.startHealth, 1);
  assert.ok(hit.outcome < 0 && hit.collisions > 0 && hit.tookDamage.some(row =>
    row.actorId === "pako-session-local-solid" && row.closingSpeed > 0 && row.damageToPlayer > 0));
  assert.ok(episodes[1].collisionMarkers.some(({ tick, poseTick, x, z, kind }) =>
    kind === "barrier" && tick === hit.tick && tick === poseTick &&
    x === worlds[1].world.player.x && z === worlds[1].world.player.z));
  assert.ok(pinned.activeMax === 2 && pinned.health > 0 && pinned.outcome < 0);
  assert.ok(pinned.pinTicks * STEP >= GTA_PIN_SECONDS);
  assert.ok(noPolice.startGap >= 45 && noPolice.activeMax === 0 && !noPolice.qualified && noPolice.wantedLevel === 1);
});

test("invalid or mismatched plans fault before accepting any World ticks", { timeout: 20_000 }, async t => {
  const worker = connect(t);
  const seed = new PursuitPpo(trainingSeed).checkpoint();
  const make = (stage = "maneuver", curriculumSha256 = digest(curriculum)) =>
    ({ ...seed, development: { curriculumSha256, stage } });
  const invalid = [
    [{ maxEpisodes: 0 }, /positive episode and time budget/],
    [{ maxSeconds: Infinity }, /positive episode and time budget/],
    ...[0, 5, 1.5, "2", null].map(worlds => [{ worlds }, /integer from 1 to 4 independent worlds/]),
    [{ stage: "another", checkpoint: make() }, /Choose a Lab workload/],
    [{ checkpoint: make("left-crossing") }, /same Lab workload and curriculum/],
    [{ checkpoint: make("maneuver", "wrong") }, /same Lab workload and curriculum/],
    [{ checkpoint: { ...make(), firstMoment: [] } }, /Incompatible or nonfinite/],
    [{ mode: "evaluate" }, /requires a trained PPO checkpoint/],
  ];
  for (const [index, [options, expected]] of invalid.entries()) {
    worker.send(begin(`invalid-${index}`, options));
    const fault = await worker.read(isTerminal);
    assert.equal(fault.status, "fault");
    assert.equal(fault.sessionId, `invalid-${index}`);
    assert.match(fault.error, expected);
    assert.equal(fault.episodes, 0);
    assert.equal(fault.activeEpisode, undefined);
    assert.equal(fault.checkpoint, undefined);
  }
  worker.send(begin("cancel", { speed: "normal" }));
  worker.send({ type: "session-control", sessionId: "cancel", action: "stop" });
  const stopped = await worker.read(isTerminal);
  assert.deepEqual([stopped.sessionId, stopped.status, stopped.episodes, stopped.updates], ["cancel", "stopped", 0, 0]);
});
