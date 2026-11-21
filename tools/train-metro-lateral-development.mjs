import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { clamp } from "../src/core/config.js";
import { initializeDistrictActor } from "../src/core/district-behavior.js";
import { districtRoadPose } from "../src/core/egypt-district.js";
import { angleDelta, bodyOnRoad, corners, overlaps } from "../src/core/geometry.js";
import { PURSUIT_STOP } from "../src/core/pursuit-controls.js";
import { updatePursuitResponse } from "../src/core/pursuit-response.js";
import { Random } from "../src/core/random.js";
import { SpatialIndex } from "../src/core/spatial-index.js";
import { CLEARANCE_ROUTE_OBSERVATION_SCHEMA as schema, GtaPursuitEnv } from "../src/rl/gta-pursuit-env.js";
import { freezePursuitPolicy, PursuitPpo } from "../src/rl/pursuit-ppo.js";
import { isDispatchIncident, resetPursuitEpisode } from "../src/rl/pursuit-rollouts.js";
import { PURSUIT_SCAN_TICKS, PursuitScanner } from "../src/signal_processing/pursuit-scanner.js";

const output = process.env.PROVE_IT_OUTPUT_DIR;
assert.ok(output, "Set a new proof output directory");
const hash = data => createHash("sha256").update(data).digest("hex");
const originalBytes = await readFile(new URL("../.runtime-proof/pursuit-rl-dense-learning-20261120/corrective-trial-20261120-221352/checkpoint-1.json", import.meta.url));
const parentSha256 = hash(originalBytes);
assert.equal(parentSha256, "854b284350457717cd2c299a0dc86604f2600ed989c1c9aac7ff497d0e5181e3");
const parent = JSON.parse(originalBytes), prior = freezePursuitPolicy(parent);
const curriculum = JSON.parse(await readFile(new URL("../config/pursuit-rl-city-route-development.json", import.meta.url)));
export const training = [
  ["corniche-avenue", -39, 1, 8.45, 16.6, 25.5, 9.9],
  ["station-avenue", -158, -1, 8.25, 16.3, 27.8, 9.7],
  ["civic-avenue", 46, -1, 8.35, 16.5, 25.4, 9.8],
];
export const validation = [
  ["gateway-avenue", -55, 1, 8.35, 16.4, 25.5, 9.75],
  ["university-avenue", -220, 1, 8.35, 16.4, 25.8, 9.75],
];
assert.ok(validation.every(([id]) => !training.some(([source]) => source === id)));
assert.ok([...training, ...validation].every(([id]) => id !== "tahrir-boulevard"));
const coast = { steer: 0, throttle: 0, brake: 0, gear: 1 };
const go = { ...coast, throttle: 1 };
const horizon = 228, handoffTick = 12;
export const stopControlHorizon = 240;
const referencePlans = [
  [4.9, 4.9, .53, .36], [4.9, 6.25, .53, .36], [5.65, 6.25, .57, .36],
  [4.35, 6.25, .48, .34], [4.35, 6.6, .48, .30], [5.1, 6.6, .48, .40],
];
const rearPlans = [null, [.85, .85, .18, .38], [-.85, -.85, .18, .38],
  [1.05, 1.05, .18, .38], [-1.05, -1.05, .18, .38]];

async function save(name, value) {
  const text = JSON.stringify(value, null, 2) + "\n";
  await writeFile(join(output, name), text, { flag: "wx" });
  return hash(text);
}

function referenceTurn(road, along, side, frontGap, [passingOffset, continuationOffset, turnLimit, preview]) {
  const start = districtRoadPose(road, along, side);
  const sin = Math.sin(start.heading), cos = Math.cos(start.heading);
  // The passing line stays clear of the sedan until there is room for a second lateral move.
  return own => {
    const right = (own.x - start.x) * cos - (own.z - start.z) * sin;
    const forward = (own.x - start.x) * sin + (own.z - start.z) * cos;
    const room = road.width / 2 + road.laneOffsetM - own.width / 2 - .45;
    const target = Math.min(room, forward > frontGap - 1 ? continuationOffset : passingOffset);
    const desired = clamp(.24 * (target - right), -.21, turnLimit);
    const tangent = Math.tan(own.steer);
    const yaw = own.speed / own.spec.wheelbase * Math.cos(Math.atan(.5 * tangent)) * tangent;
    const error = desired - angleDelta(own.heading, start.heading) - preview * yaw;
    return { ...go, steer: clamp(1.35 * error / own.spec.maxSteer, -.87, .87) };
  };
}

export function run(layout, kind, select, plan = null, endTick = horizon, audit = false,
  { createRoadObserver, perturbReference, observeTick, patrolTrafficPreview } = {}) {
  assert.ok(!perturbReference || plan, "Perturbations are for training reference runs only");
  const [roadId, along, side, speed, frontGap, tailGap, tailSpeed] = layout;
  const seed = `metro-lateral-development:${roadId}:${side}`, withTail = kind !== "no-tail";
  const withSedan = kind !== "rear-only";
  const env = new GtaPursuitEnv();
  env.reset({ seed, traffic: 0, pedestrians: 0, shield: true, config: {
    ruleset: "dispatch-v1", wantedLevelStart: 1, wantedLevelMax: 1,
    maxActivePatrols: Number(withTail), episodeMaxSeconds: 10, enableRoadblocks: false,
    ...(patrolTrafficPreview === undefined ? {} : { patrolTrafficPreview }),
  } });
  const { world } = env, { player, pursuit } = world, [tail] = pursuit.patrols;
  const road = world.drivingRoads.find(value => value.id === roadId);
  const start = districtRoadPose(road, along, side);
  const reference = plan && referenceTurn(road, along, side, frontGap, plan);
  Object.assign(player, start, { speed });
  pursuit.playerStart = { ...start, speed };
  if (tail) Object.assign(tail, districtRoadPose(road, along - tailGap * side, side), { speed: tailSpeed });
  let sedan;
  if (withSedan) {
    sedan = world.makeVehicle("lateral-training-loading-sedan", "sedan", districtRoadPose(road, along + frontGap * side, side));
    initializeDistrictActor(world, sedan);
    sedan.district.loadingUntilTick = stopControlHorizon + 60;
    world.actors.push(sedan);
  }
  const bodies = [player, tail, sedan].filter(Boolean);
  assert.ok(bodies.every((body, i) => bodyOnRoad(body, [road]) &&
    !world.statics.some(solid => overlaps(body, solid, .12)) &&
    bodies.slice(0, i).every(other => !overlaps(body, other, .12))));
  world.actorIndex = new SpatialIndex(world.actors);
  updatePursuitResponse(world, true);
  pursuit.gta.scanner = new PursuitScanner();
  pursuit.gta.scan = pursuit.gta.scanner.sample(world);
  env.schema = schema;
  const observeRoad = createRoadObserver?.(world.drivingRoads.map(
    ({ axis, min, max, fixed, width, parkingBay, supportApron }) => ({ axis, min, max, fixed, width, parkingBay, supportApron })));
  const sin = Math.sin(start.heading), cos = Math.cos(start.heading);
  const forward = body => sin * (body.x - start.x) + cos * (body.z - start.z);
  const lateral = body => cos * (body.x - start.x) - sin * (body.z - start.z);
  const samples = [], rollout = [], trace = [], incidents = [], motionAudit = audit ? [] : null;
  let last, handoff, firstClearTick = null, clearanceOK = true, stayedClear = true, onRoad = true, lateralMax = 0;
  const sedanNose = sedan ? Math.max(...corners(sedan).map(forward)) : null;
  const cross = road.axis === "x" ? "z" : "x";
  let roadBoundaryTicks = 0, minimumRoadMarginM = Infinity, decisionMarginM = Infinity, firstDenialTick = null;
  let postClearAdvanceM = 0, postClearNonforwardTicks = 0;
  const stepWorld = world.step.bind(world);
  world.step = () => {
    const before = forward(player);
    stepWorld();
    observeTick?.(world, tail, sedan);
    if (pursuit.appliedCommand?.reason === "road-boundary") {
      roadBoundaryTicks++;
      if (audit) firstDenialTick ??= world.tick;
    }
    for (const point of corners(player))
      decisionMarginM = Math.min(decisionMarginM, road.width / 2 - Math.abs(point[cross] - road.fixed));
    minimumRoadMarginM = Math.min(minimumRoadMarginM, decisionMarginM);
    if (firstClearTick !== null) {
      const advance = forward(player) - before;
      postClearAdvanceM += advance;
      if (advance <= 0) postClearNonforwardTicks++;
    }
  };
  do {
    const obs = env.getObservation(), tick = world.tick, prelude = tick < handoffTick;
    let measured;
    if (audit && !prelude) {
      const roadCenter = (road.fixed - start[cross]) * (cross === "x" ? cos : -sin);
      const footprintRight = corners(player).map(lateral);
      measured = { tick, headingRad: angleDelta(player.heading, start.heading), steerRad: player.steer,
        yawRateRadS: world.sensors.imu.yawRateRadS, speedMps: player.speed,
        forwardM: forward(player), lateralM: lateral(player),
        leftMarginM: Math.min(...footprintRight) - (roadCenter - road.width / 2),
        rightMarginM: roadCenter + road.width / 2 - Math.max(...footprintRight),
        tailForwardM: tail ? forward(tail) - forward(player) : null,
        tailRightM: tail ? lateral(tail) - lateral(player) : null,
        tailClosingMps: tail ? tail.speed * Math.cos(angleDelta(tail.heading, start.heading)) -
          player.speed * Math.cos(angleDelta(player.heading, start.heading)) : null };
    }
    const roadObservation = !prelude && observeRoad ? observeRoad(world.sensors.imu) : null;
    const teacherAction = !prelude && reference ? reference(player) : null;
    const request = prelude ? coast : teacherAction ?
      (perturbReference ? perturbReference(tick, teacherAction, obs, roadObservation) : teacherAction) : select(obs, roadObservation);
    const action = request.action ?? request;
    if (tick === handoffTick) {
      const { rays, tracks } = pursuit.gta.scan;
      handoff = { action, obsSha256: hash(Buffer.from(obs.buffer)), front: rays[0], tailDistance: tail?.distance ?? 0,
        rear: tracks.find(t => t.kind === "police" && t.forwardM < 0 && t.ageS === 0 &&
          t.motionKnown && t.ttcS !== null) ?? null };
    }
    const deniedBefore = roadBoundaryTicks;
    decisionMarginM = Infinity;
    firstDenialTick = null;
    last = env.step(action);
    if (measured) motionAudit.push({ ...measured, firstDenialTick,
      deniedTicks: roadBoundaryTicks - deniedBefore, rewardSafety: last.info.rewardComponents.safety });
    if (!prelude) samples.push({ obs, action, ...(observeRoad ? { road: roadObservation } : {}),
      ...(perturbReference ? { teacherAction } : {}) });
    if (!prelude && request.action)
      rollout.push({ obs: request.obs ?? obs, value: request.value, logp: request.logp, raw: request.raw, reward: last.reward,
        deniedTicks: roadBoundaryTicks - deniedBefore, roadMarginM: decisionMarginM });
    incidents.push(...last.info.events.filter(isDispatchIncident));
    onRoad &&= bodies.every(body => world.actors.includes(body) && bodyOnRoad(body, [road]));
    lateralMax = Math.max(lateralMax, Math.abs(lateral(player)));
    if (sedan) {
      clearanceOK &&= !overlaps(player, sedan, .25);
      const clear = Math.min(...corners(player).map(forward)) - sedanNose > .25;
      if (clear) firstClearTick ??= world.tick;
      else if (firstClearTick !== null) stayedClear = false;
    }
    trace.push({ tick: world.tick, progressM: forward(player), lateralM: lateral(player), speed: player.speed,
      tailTravelM: tail?.distance ?? 0, request: action, applied: last.info.appliedCommand, guard: last.info.shield.reason });
  } while (world.tick < endTick && !last.terminated && !last.truncated);
  const noContact = pursuit.metrics.collisions === 0 && pursuit.metrics.trafficCollisions === 0;
  const hasRear = Boolean(handoff?.rear && handoff.rear.forwardMps > 1.5 && handoff.tailDistance > 1 &&
    tail.distance - handoff.tailDistance > 8);
  const pass = noContact && onRoad && world.tick === horizon && (withSedan
    ? clearanceOK && stayedClear && hasRear && sedan.distance === 0 && handoff.front.kind === "civilian" &&
      firstClearTick !== null && firstClearTick <= horizon - 36 && forward(player) - sedanNose > 4
    : hasRear && lateralMax < 1.4 && forward(player) > 18);
  return { samples, rollout, last, motionAudit, summary: { layout, seed, kind, plan, pass, tick: world.tick, onRoad, noContact, clearanceOK,
    roadBoundaryTicks, minimumRoadMarginM, postClearAdvanceM, postClearNonforwardTicks,
    handoff, progressM: forward(player), lateralMax, patrolM: tail?.distance ?? 0, firstClearTick, incidents, trace } };
}

export function measuredReference(layout, kind) {
  const attempts = [];
  for (const plan of kind === "combined" ? referencePlans : rearPlans) {
    const result = run(layout, kind, () => go, plan);
    attempts.push(result.summary);
    if (result.summary.pass) return { ...result, attempts };
  }
  return { summary: attempts.at(-1), samples: [], attempts };
}

async function main() {
const report = { classification: "local Metro development only", parentSha256, training, validation, referencePlans, rearPlans,
  horizon, stopControlHorizon,
  teachers: [], controls: [], local: [], oracle: { validControls: false, learnedPass: false } };
const retained = [];
try {
  for (const layout of validation) {
    const { summary: reference, attempts } = measuredReference(layout, "combined");
    const stop = run(layout, "combined", () => PURSUIT_STOP, null, stopControlHorizon).summary;
    const stopNoTail = run(layout, "no-tail", () => PURSUIT_STOP, null, stopControlHorizon).summary;
    const { summary: rearOnly, attempts: rearAttempts } = measuredReference(layout, "rear-only");
    assert.equal(stop.handoff.obsSha256, reference.handoff.obsSha256);
    report.controls.push({ reference, attempts, stop, stopNoTail, rearOnly, rearAttempts, valid: reference.pass && rearOnly.pass &&
      stop.incidents.some(event => event.type === "patrol_collision" && event.fresh) &&
      stopNoTail.tick === stopControlHorizon && stopNoTail.onRoad && stopNoTail.noContact && stopNoTail.clearanceOK });
  }
  report.oracle.validControls = report.controls.every(row => row.valid);
  if (report.oracle.validControls) {
    for (const layout of training) {
      for (const kind of ["combined", "rear-only"]) {
        const { summary, samples, attempts } = measuredReference(layout, kind);
        report.teachers.push({ ...summary, attempts });
        if (summary.pass) for (let i = 0; i < samples.length; i++) {
          retained.push(samples[i]);
          if (kind === "combined" && i < 10) retained.push(samples[i]);
        }
      }
    }
  }
  if (report.teachers.length === training.length * 2 && report.teachers.every(row => row.pass)) {
    const anchorCounts = [];
    for (const [i, stage] of curriculum.stages.entries()) {
      const seed = curriculum.trainingSeeds[i * 2];
      const { env, initial } = resetPursuitEpisode({ ...stage, episodeSeconds: 30 }, seed);
      let obs = initial.obs, result, samples = 0;
      do {
        const action = prior.action(obs);
        retained.push({ obs, action });
        samples++;
        result = env.step(action);
        obs = result.obs;
      } while (!result.terminated && !result.truncated);
      anchorCounts.push({ seed, samples, ticks: env.world.tick });
    }
    const model = new PursuitPpo("metro-lateral-corrective-development", null, schema.version);
    model.weights.set(parent.weights);
    const adam = model.applyAdam.bind(model), fitRate = .00032, fitEpochs = 20;
    model.applyAdam = grad => adam(grad, fitRate);
    const losses = model.warmStart(retained, fitEpochs);
    const development = { parentSha256, training, fitRate, fitEpochs, anchorCounts };
    const warm = { ...model.checkpoint(), development };
    const warmSha256 = await save("warm-start.json", warm);
    const warmPolicy = new PursuitPpo(null, warm);
    const std = [.08, .11, .13], rate = .000012;
    model.layout = { ...model.layout, std };
    model.applyAdam = grad => adam(grad, rate);
    const batch = [], sampled = [];
    for (const layout of training) for (const kind of ["combined", "rear-only"]) {
      const rng = new Random(`${model.seed}:${layout[0]}:${kind}`);
      const { summary, rollout, last } = run(layout, kind, obs => model.sample(obs, rng));
      rollout.at(-1).episodeBootstrap = last.terminated ? 0 : model.value(last.obs);
      batch.push(...rollout);
      sampled.push(summary);
    }
    report.update = model.update(batch);
    const candidate = { ...model.checkpoint(), development: { ...development, warmSha256, std, rate } };
    report.fit = { samples: retained.length, losses, warmSha256, candidateSha256: await save("checkpoint-1.json", candidate), sampled };
    const frozen = freezePursuitPolicy(candidate);
    for (const layout of validation) for (const kind of ["combined", "rear-only"])
      for (const [arm, select] of [["prior", prior.action], ["warm", obs => warmPolicy.action(obs)], ["learned", frozen.action]])
        report.local.push({ arm, ...run(layout, kind, select).summary });
    const learnedRows = report.local.filter(row => row.arm === "learned");
    report.oracle.learnedPass = learnedRows.length === validation.length * 2 && learnedRows.every(row => row.pass);
  }
} finally {
  if (!report.oracle.validControls) report.failure = "No complete positive and negative contrast on every validation street";
  else if (!report.update) report.failure = "A training teacher did not complete its physical scenario";
  else if (!report.oracle.learnedPass) report.failure = "The PPO candidate did not pass every physical validation arm";
  await save("lateral-learning.json", report);
  const compact = row => [row.layout[0], row.kind, row.pass, row.firstClearTick, row.progressM,
    row.incidents.filter(event => event.type.endsWith("collision") || event.type === "static_or_civilian_hit").map(e => [e.type, e.tick])];
  console.log(JSON.stringify({ oracle: report.oracle, update: report.update,
    controls: report.controls.map(r => [r.valid, r.attempts.map(compact), compact(r.stop), r.rearAttempts.map(compact)]),
    teachers: report.teachers.map(r => [compact(r), r.attempts?.map(compact)]), local: report.local.map(r => [r.arm, ...compact(r)]) }));
  if (report.failure) {
    console.error(report.failure);
    process.exitCode = 1;
  }
}
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
