// Local development experiment. This feature layout is not a public checkpoint format.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { STEP } from "../src/core/config.js";
import { angleDelta, bodyOnRoad, distance, roadRect, sweepSafe } from "../src/core/geometry.js";
import { pursuitCommand } from "../src/core/pursuit-controls.js";
import { Random } from "../src/core/random.js";
import { integrateVehicle } from "../src/core/vehicle.js";
import { GtaPursuitEnv } from "../src/rl/gta-pursuit-env.js";
import { freezePursuitPolicy, PursuitPpo } from "../src/rl/pursuit-ppo.js";
import { isDispatchIncident, resetPursuitEpisode } from "../src/rl/pursuit-rollouts.js";

const output = process.env.PROVE_IT_OUTPUT_DIR;
assert.ok(output, "Run this experiment in a new proof output directory");
const preview = new URL("../.runtime-proof/pursuit-rl-preview-policy-20261121/", import.meta.url);
const teachers = new URL("../.runtime-proof/pursuit-rl-preview-curriculum-20261121/runs/routes/20261121T003839-dcfb26aabe/", import.meta.url);
const turn = new URL("early-turn-20261121-032400/", preview);
const fit = new URL("runs/fit/20261121T004347-f6c3fd04b9/", preview);
const digests = Object.freeze({
  frozen: "052e656cd8354b700f47c4849686c966df3b16e4586b96dd7aa66022ef705ff3",
  warm: "137f4602cea2280462cd388c927cf9445b59267fbcc89175fd5db4e317c684ae",
  failure: "bb7a9a5482efe6f03783bc4417d5201c75042a21e9bd2ec712f8b7d254907f9b",
  correction: "e9a8e6fe6152e600fda6b389ff13be7a8fe82ef97ff3fc836e754cfe085b9e26",
  demonstrations: "aaf7ecefafde7fcbd285060d21b3e4cf0e6ac07ff0bbef6cfcc4021aba693bd9",
});
const hash = data => createHash("sha256").update(data).digest("hex");
async function load(url, expected) {
  const bytes = await readFile(url);
  assert.equal(hash(bytes), expected, `Unexpected input bytes: ${url.pathname}`);
  return JSON.parse(bytes);
}
async function save(name, value) {
  const data = JSON.stringify(value);
  await writeFile(join(output, name), data, { flag: "wx" });
  return hash(data);
}

const observation = "dispatch-route-v2";
const stageFor = (level, episodeSeconds = 120) => ({
  observation, traffic: level === 5 ? 96 : 36, pedestrians: level === 5 ? 144 : 80,
  wantedLevel: level, wantedLevelMax: level, patrols: level === 5 ? 12 : 7,
  episodeSeconds, civilianCrossingPreview: true,
});
const denseTrainingSeed = "city-route-train-01";
const trainingSeeds = ["route-train-00", denseTrainingSeed];
const validationSeeds = ["city-route-dev-eval-00", "city-route-dev-eval-01"];
const HORIZON_M = 5, STEERS = [-.8, -.4, 0, .4, .8], CUE_COUNT = 2 * STEERS.length;
const pose = ({ x, z, speed, heading }) => ({ x, z, speed, heading });
const poseAt = (tick, player) => ({ tick, ...pose(player) });

function createRoadCue(roads, { spec, type, length, width, maxSpeed }) {
  const shape = { type, length, width, spec, maxSpeed: Math.min(maxSpeed, 3) };
  const reach = HORIZON_M + Math.hypot(length, width) / 2 + .3;
  const bounds = roads.map(road => ({ road, ...roadRect(road, .08) }));
  const arcs = [1, -1].flatMap(gear => STEERS.map(steer => {
    let before = { ...shape, x: 0, z: 0, heading: 0, speed: gear * 1.6, steer: 0 };
    const poses = [{ ...pose(before), travel: 0 }];
    const action = { steer, gear, throttle: .35, brake: 0 };
    let travel = 0;
    for (let i = 0; i < 240 && travel < HORIZON_M; i++) {
      const next = integrateVehicle(before, pursuitCommand(before, action), STEP);
      travel += distance(before, next);
      poses.push({ ...pose(next), travel });
      before = next;
    }
    assert.ok(travel >= HORIZON_M, "The nominal cue arc did not reach its declared distance");
    return poses;
  }));
  // The ten values describe pavement only. They never substitute for the scan or choose actions.
  return ({ x, z, heading }) => {
    const local = bounds.filter(box => x + reach >= box.minX && x - reach <= box.maxX &&
      z + reach >= box.minZ && z - reach <= box.maxZ).map(box => box.road);
    const sin = Math.sin(heading), cos = Math.cos(heading);
    const before = { type, length, width, x, z, heading };
    const next = { ...before };
    const values = Float32Array.from(arcs, arc => {
      Object.assign(before, { x, z, heading });
      let acceptedM = 0;
      for (let i = 1; i < arc.length; i++) {
        const point = arc[i];
        next.x = x + point.x * cos + point.z * sin;
        next.z = z - point.x * sin + point.z * cos;
        next.heading = heading + point.heading;
        if (!sweepSafe(before, next, [], local).safe) break;
        acceptedM = point.travel;
        Object.assign(before, next);
      }
      return Math.min(1, acceptedM / HORIZON_M);
    });
    assert.ok(values.every(value => Number.isFinite(value) && value >= 0 && value <= 1));
    return values;
  };
}

async function geometry() {
  const prior = freezePursuitPolicy(await load(new URL("checkpoint-1.json", fit), digests.frozen));
  const pinned = await load(new URL("frozen-control.json", turn), digests.failure);
  const { env, initial } = resetPursuitEpisode(stageFor(5), denseTrainingSeed);
  const { world } = env, { player } = world;
  const cue = createRoadCue(world.roads, player);
  const checks = new Set([450, 600, 648, 780]), rows = [];
  let obs = initial.obs;
  for (const decision of pinned.decisions) {
    const action = prior.action(obs);
    assert.deepEqual(action, decision.action);
    const step = env.step(action);
    obs = step.obs;
    assert.deepEqual(poseAt(world.tick, player), { tick: decision.tick, ...pose(decision) });
    assert.deepEqual(step.info.appliedCommand, decision.applied);
    if (checks.has(world.tick)) rows.push({ ...poseAt(world.tick, player), cue: Array.from(cue(player)),
      applied: step.info.appliedCommand });
  }
  const barrier = scenario => {
    const env = new GtaPursuitEnv();
    const { obs } = env.reset({ scenario, observation, seed: "development-road-context-barrier",
      traffic: 0, pedestrians: 0, shield: true,
      config: { ruleset: "dispatch-v1", maxActivePatrols: 1, enableRoadblocks: false } });
    const { world } = env, { player, pursuit } = world;
    return { pose: pose(player), rear: pursuit.gta.scan.rays[36], scanHash: hash(Buffer.from(obs.buffer)),
      cue: Array.from(createRoadCue(world.roads, player)(player)) };
  };
  const clear = barrier("L07"), blocked = barrier("L07-blocked");
  assert.deepEqual(clear.pose, blocked.pose);
  assert.notDeepEqual(clear.rear, blocked.rear);
  const early = rows.find(row => row.tick === 600), stalled = rows.find(row => row.tick === 780);
  const barrierPair = { clear, blocked, differentScan: clear.scanHash !== blocked.scanHash,
    sameRoadCue: clear.cue.every((value, i) => value === blocked.cue[i]) };
  const report = { classification: "development observation diagnostic; no action replacement",
    node: process.version, v8: process.versions.v8, inputDigests: digests, checkedAcceptedPoses: true,
    horizonM: HORIZON_M, steers: STEERS, rows, barrierPair };
  await save("road-context.json", report);
  assert.ok(early.cue[2] - early.cue[0] >= .25);
  assert.ok(stalled.cue.slice(0, 5).every(value => value < .02));
  assert.ok(stalled.cue.slice(5).every(value => value >= .98));
  assert.ok(barrierPair.differentScan && barrierPair.sameRoadCue);
  console.log(JSON.stringify({ early, stalled, barrierPair }));
}

function retainAmbient({ actors, player, pursuit }, stage) {
  const roster = actors.filter(a => a !== player && !pursuit.patrols.has(a)).map(a => [a, a.id, a.type]);
  assert.equal(roster.filter(row => row[2] === "vehicle").length, stage.traffic);
  assert.equal(roster.filter(row => row[2] === "pedestrian").length, stage.pedestrians);
  return current => {
    const live = new Set(current.actors.filter(a => a !== player && !pursuit.patrols.has(a)));
    assert.ok(live.size === roster.length && roster.every(([a, id, type]) =>
      live.has(a) && a.id === id && a.type === type), "An ambient actor changed during the experiment");
  };
}

const isAmbientPedImpact = event => event.type === "ambient_collision" &&
  [event.first, event.second].some(body => body.type === "pedestrian");

async function replayTraining(stage, seed, decisions, expected, take, samples) {
  assert.ok(trainingSeeds.includes(seed) && !validationSeeds.includes(seed));
  const { env, initial } = resetPursuitEpisode(stage, seed);
  const { world } = env, { player, pursuit } = world;
  const cue = createRoadCue(world.roads, player);
  const retained = retainAmbient(world, stage);
  let obs = initial.obs, impacts = 0, selected = 0;
  for (const [i, decision] of decisions.entries()) {
    retained(world);
    assert.equal(pursuit.phase, "running");
    const { action } = decision;
    if (decision.obs) assert.ok(obs.length === decision.obs.length &&
      obs.every((value, j) => value === decision.obs[j]), `Training observation changed at tick ${world.tick}`);
    if (take(i, world.tick)) {
      samples.push({ obs, cue: cue(player), action });
      selected++;
    }
    const step = env.step(action);
    obs = step.obs;
    impacts += step.info.events.filter(isAmbientPedImpact).length;
    if (decision.tick !== undefined)
      assert.deepEqual(poseAt(world.tick, player), { tick: decision.tick, ...pose(decision) });
  }
  retained(world);
  assert.deepEqual([pursuit.phase, world.tick, pursuit.metrics.distanceM, pursuit.metrics.collisions,
    pursuit.metrics.trafficCollisions, impacts, pursuit.response.dispatch.escapeEligible],
  ["escaped", expected.ticks, expected.distanceM, 0, expected.ambientContacts, 0, true]);
  return { seed, level: stage.wantedLevel, ticks: world.tick, replayed: decisions.length, selected, distanceM: expected.distanceM };
}

function widenedModel(base) {
  const model = new PursuitPpo("metro-road-context-ablation", null, observation);
  const { INPUT, HIDDEN_BIAS, OUTPUT_WEIGHTS, OUTPUT_BIAS, PARAMETERS } = model.layout;
  const hidden = HIDDEN_BIAS / INPUT, n = INPUT + CUE_COUNT, extra = hidden * CUE_COUNT;
  const weights = new Float64Array(PARAMETERS + extra);
  assert.equal(base.weights.length, PARAMETERS);
  for (let i = 0; i < hidden; i++)
    weights.set(base.weights.slice(i * INPUT, (i + 1) * INPUT), i * n);
  weights.set(base.weights.slice(HIDDEN_BIAS), HIDDEN_BIAS + extra);
  // Build two identical copies for the ablation using the shared optimizer; do not export a City checkpoint.
  model.layout = { ...model.layout, INPUT: n, HIDDEN_BIAS: HIDDEN_BIAS + extra,
    OUTPUT_WEIGHTS: OUTPUT_WEIGHTS + extra, OUTPUT_BIAS: OUTPUT_BIAS + extra, PARAMETERS: weights.length };
  model.weights = weights;
  model.firstMoment = new Float64Array(weights.length);
  model.secondMoment = new Float64Array(weights.length);
  return model;
}

function extended(obs, cue) {
  const input = new Float32Array(obs.length + CUE_COUNT);
  input.set(obs);
  if (cue) input.set(cue, obs.length);
  return input;
}

async function measured(arm, part, seed, model, includeCue, collecting) {
  const stage = stageFor(5, 35);
  const { env, initial } = resetPursuitEpisode(stage, seed);
  const { world } = env, { player, pursuit } = world;
  const retained = retainAmbient(world, stage);
  const cue = includeCue && createRoadCue(world.roads, player);
  const rng = new Random(`${model.seed}:${seed}`);
  let obs = initial.obs, turnTick = null, advanceTick = null, last, peakPatrols = 0, boundaryRejects = 0, maxCueMs = 0;
  let offRoad = 0;
  const rollout = [], incidents = [], trace = [];
  do {
    retained(world);
    const t = performance.now(), values = cue && cue(player);
    if (cue) maxCueMs = Math.max(maxCueMs, performance.now() - t);
    const input = extended(obs, values), request = collecting ? model.sample(input, rng) : null;
    last = env.step(request ? request.action : model.action(input));
    if (collecting) rollout.push({ obs: input, raw: request.raw, value: request.value, logp: request.logp, reward: last.reward });
    obs = last.obs;
    const applied = last.info.appliedCommand?.reason ?? null;
    boundaryRejects += Number(applied === "road-boundary");
    offRoad += Number(!bodyOnRoad(player, world.roads));
    peakPatrols = Math.max(peakPatrols, last.info.activePatrols);
    incidents.push(...last.info.events.filter(isDispatchIncident));
    if (world.tick % 60 === 0)
      trace.push([world.tick, player.x, player.z, player.heading, player.speed, applied, last.info.shield.reason]);
    if (turnTick === null && player.z > -97.65 && player.x > -190 && player.x < -181 &&
        Math.abs(angleDelta(player.heading, 0)) < .24)
      turnTick = world.tick;
    if (turnTick !== null && advanceTick === null && player.z >= -80) advanceTick = world.tick;
  } while (!last.terminated && !last.truncated);
  retained(world);
  const ambientPedestrianImpacts = incidents.filter(isAmbientPedImpact).length;
  const { collisions, trafficCollisions: ambientContacts, distanceM } = pursuit.metrics;
  const pass = turnTick !== null && advanceTick !== null && world.tick === 2100 && world.tick - turnTick >= 180 &&
    offRoad === 0 && collisions === 0 && ambientPedestrianImpacts === 0 && peakPatrols > 0;
  const row = { arm, part, seed, pass, ticks: world.tick, phase: pursuit.phase, distanceM, turnTick, advanceTick,
    boundaryRejects, offRoad, collisions, ambientContacts, ambientPedestrianImpacts, peakPatrols, maxCueMs,
    incidents, trace };
  await appendFile(join(output, "episodes.ndjson"), JSON.stringify(row) + "\n");
  const { incidents: _incidents, trace: _trace, ...summary } = row;
  console.log(JSON.stringify(summary));
  if (collecting)
    rollout.at(-1).episodeBootstrap = last.terminated ? 0 : model.value(extended(obs, cue && cue(player)));
  return { summary, rollout };
}

async function comparison() {
  const base = await load(new URL("warm-start.json", fit), digests.warm);
  assert.equal(base.updates, 0);
  const original = await load(new URL("preview-teacher.json", teachers), digests.demonstrations);
  const teacherReplays = [], samples = [];
  for (const row of original.episodes.filter(row => row.demonstration)) {
    const { file, sha256, samples: count } = row.demonstration;
    const decisions = await load(new URL(file, teachers), sha256);
    assert.equal(decisions.length, count);
    teacherReplays.push(await replayTraining(stageFor(row.level), row.seed, decisions, row, i => i % 3 === 0, samples));
    console.log(JSON.stringify(teacherReplays.at(-1)));
  }
  const correction = await load(new URL("teacher-through.json", turn), digests.correction);
  teacherReplays.push(await replayTraining(stageFor(5), denseTrainingSeed, correction.decisions,
    { ...correction, ticks: correction.terminal.tick }, (_, tick) => tick >= 450 && tick < 1620, samples));
  assert.equal(samples.length, 1003);
  console.log(JSON.stringify(teacherReplays.at(-1)));
  const epochs = 10, fitRate = .00038, ppoRate = .000022, std = [.04, .15, .13];
  const previous = new PursuitPpo(null, base);
  const initialWeightsSha256 = hash(Buffer.from(widenedModel(base).weights.buffer));
  const results = [];
  for (const arm of ["masked", "road-cues"]) {
    const includeCue = arm === "road-cues", model = widenedModel(base), adam = model.applyAdam.bind(model);
    assert.equal(hash(Buffer.from(model.weights.buffer)), initialWeightsSha256);
    for (const sample of samples.filter((_, i) => i % 37 === 0))
      assert.deepEqual(model.action(extended(sample.obs, sample.cue)), previous.action(sample.obs));
    model.applyAdam = grad => adam(grad, fitRate);
    const losses = model.warmStart(samples.map(({ obs, cue, action }) =>
      ({ obs: extended(obs, includeCue && cue), action })), epochs);
    const snapshot = () => ({ format: "metro-road-context-development-only", inputs: model.layout.INPUT, arm,
      updates: model.updates, transitions: model.transitions, optimizerSteps: model.optimizerSteps, weights: Array.from(model.weights) });
    const warmSha256 = await save(`${arm}-warm.json`, snapshot());
    const warm = [];
    for (const seed of validationSeeds) warm.push((await measured(arm, "warm", seed, model, includeCue, false)).summary);
    model.layout = { ...model.layout, std };
    model.applyAdam = grad => adam(grad, ppoRate);
    const batch = [], collected = [];
    for (const seed of trainingSeeds) {
      const row = await measured(arm, "on-policy", seed, model, includeCue, true);
      batch.push(...row.rollout);
      collected.push(row.summary);
    }
    const beforeUpdate = hash(Buffer.from(model.weights.buffer));
    const update = model.update(batch);
    assert.notEqual(hash(Buffer.from(model.weights.buffer)), beforeUpdate);
    assert.throws(() => freezePursuitPolicy(model.checkpoint()), /Incompatible/);
    const ppoSha256 = await save(`${arm}-ppo.json`, snapshot());
    const ppo = [];
    for (const seed of validationSeeds) ppo.push((await measured(arm, "ppo", seed, model, includeCue, false)).summary);
    results.push({ arm, warmSha256, ppoSha256, losses, update, collected, warm, ppo });
  }
  const passes = (row, part) => row[part].filter(result => result.pass).length;
  const [masked, cued] = results, cuePpoPasses = passes(cued, "ppo"), maskedPpoPasses = passes(masked, "ppo");
  const report = { classification: "research-only development comparison; no public checkpoint",
    node: process.version, v8: process.versions.v8, inputDigests: digests, initialWeightsSha256,
    trainingSeeds, validationSeeds, epochs, fitRate, ppoRate, std, horizonM: HORIZON_M, steers: STEERS,
    samples: samples.length, teacherReplays, results, bothPpoUpdatesExecuted: results.every(row => row.update.transitions === 700),
    cuePpoPasses, maskedPpoPasses, cueWarmPasses: passes(cued, "warm"), maskedWarmPasses: passes(masked, "warm"),
    cueImproved: cuePpoPasses > maskedPpoPasses };
  await save("road-context-comparison.json", report);
  assert.ok(report.bothPpoUpdatesExecuted && report.cuePpoPasses === 2 && report.cueImproved,
    "Road-support PPO did not pass both guarded development windows and improve on the masked control");
}

const mode = process.argv[2];
if (mode === "geometry") await geometry();
else if (mode === "comparison") await comparison();
else throw new RangeError("Choose geometry or comparison");
