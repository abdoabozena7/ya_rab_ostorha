import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { initializeDistrictActor } from "../src/core/district-behavior.js";
import { districtRoadPose } from "../src/core/egypt-district.js";
import { bodyOnRoad, overlaps } from "../src/core/geometry.js";
import { PURSUIT_STOP } from "../src/core/pursuit-controls.js";
import { updatePursuitResponse } from "../src/core/pursuit-response.js";
import { SpatialIndex } from "../src/core/spatial-index.js";
import { CLEARANCE_ROUTE_OBSERVATION_SCHEMA as schema, GtaPursuitEnv } from "../src/rl/gta-pursuit-env.js";
import { freezePursuitPolicy, PursuitPpo } from "../src/rl/pursuit-ppo.js";
import { isDispatchIncident, resetPursuitEpisode } from "../src/rl/pursuit-rollouts.js";
import { PursuitScanner } from "../src/signal_processing/pursuit-scanner.js";

const output = process.env.PROVE_IT_OUTPUT_DIR;
assert.ok(output, "Set a new proof output directory");
const bytes = await readFile(new URL("../.runtime-proof/pursuit-rl-dense-learning-20261120/corrective-trial-20261120-221352/checkpoint-1.json", import.meta.url));
const checkpointSha256 = createHash("sha256").update(bytes).digest("hex");
assert.equal(checkpointSha256, "854b284350457717cd2c299a0dc86604f2600ed989c1c9aac7ff497d0e5181e3");
const checkpoint = JSON.parse(bytes);
const original = freezePursuitPolicy(checkpoint);
const { INPUT, HIDDEN_BIAS, OUTPUT_WEIGHTS, OUTPUT_BIAS } = new PursuitPpo(null, checkpoint).layout;
const hiddenCount = OUTPUT_WEIGHTS - HIDDEN_BIAS;
const headStart = OUTPUT_WEIGHTS + 2 * hiddenCount, headBias = OUTPUT_BIAS + 2;
const baseHead = checkpoint.weights.slice(headStart, headStart + hiddenCount).concat(checkpoint.weights[headBias]);
const brakeThreshold = .35;
const coast = { steer: 0, throttle: 0, brake: 0, gear: 1 };
const go = { ...coast, throttle: .76 };
const trainLayouts = [
  ["station-avenue", -263, 1, 6.1, 10.1], ["station-avenue", -112, -1, 7.3, 12.2],
  ["civic-avenue", -24, -1, 8.3, 12.9], ["corniche-avenue", 31, 1, 7.7, 11.9],
  ["souq-collector", -259, 1, 6.7, 10.8], ["tahrir-boulevard", -148, 1, 8.1, 13],
];
const validationLayouts = [["gateway-avenue", -51, 1, 6.8, 11.1], ["university-avenue", -132, -1, 8.5, 13.6]];
const kinds = ["front", "clear", "rear", "adjacent"];
assert.ok(validationLayouts.every(([road]) => trainLayouts.every(([training]) => training !== road)));

// Use the policy's existing encoder and accumulation order, not a second observation pipeline.
function features(obs) {
  const weights = checkpoint.weights, row = new Float64Array(hiddenCount + 1);
  for (let h = 0; h < hiddenCount; h++) {
    let sum = weights[HIDDEN_BIAS + h];
    for (let j = 0; j < INPUT; j++) sum += obs[j] * weights[h * INPUT + j];
    row[h] = Math.tanh(sum);
  }
  row[hiddenCount] = 1;
  assert.ok(row.every(Number.isFinite));
  return row;
}

function logit(head, row) {
  let value = head[hiddenCount];
  for (let i = 0; i < hiddenCount; i++) value += row[i] * head[i];
  return value;
}

function fixture(layout, kind, select, { training = false, collect = false } = {}) {
  const [roadId, along, side, speed, gap] = layout;
  const front = kind === "front", rear = kind === "rear", adjacent = kind === "adjacent";
  const index = (training ? trainLayouts : validationLayouts).indexOf(layout);
  assert.ok(index >= 0);
  const seed = `metro-obstruction-${training ? "train" : "validation"}-${index}`;
  const env = new GtaPursuitEnv();
  env.reset({ seed, traffic: 0, pedestrians: 0, shield: training, config: {
    ruleset: "dispatch-v1", wantedLevelStart: 1, wantedLevelMax: 1, maxActivePatrols: Number(rear),
    episodeMaxSeconds: 4, enableRoadblocks: false,
  } });
  const { world } = env, { player, pursuit } = world;
  const road = world.drivingRoads.find(value => value.id === roadId);
  assert.ok(road);
  Object.assign(player, districtRoadPose(road, along, side), { speed });
  const goal = Math.max(road.min + 4, Math.min(road.max - 4, along + 33 * side));
  pursuit.gta.publicRouteGoal = { ...districtRoadPose(road, goal, side), roadId };
  let threat;
  if (rear) {
    [threat] = pursuit.patrols;
    assert.ok(threat);
    Object.assign(threat, districtRoadPose(road, along - (training ? 11.5 : 12.9) * side, side), { speed: speed + 3.2 });
  } else if (front || adjacent) {
    const position = districtRoadPose(road, along + gap * side, front ? side : -side);
    if (front) {
      position.x -= .18 * side * Math.cos(player.heading);
      position.z += .18 * side * Math.sin(player.heading);
    }
    threat = world.makeVehicle("brake-margin-loading-sedan", "sedan", position);
    initializeDistrictActor(world, threat);
    Object.assign(threat.district, { nextLoadingDistanceM: null, loadingUntilTick: 600 });
    world.actors.push(threat);
  }
  assert.ok([player, threat].filter(Boolean).every(body => bodyOnRoad(body, [road]) &&
    !world.statics.some(solid => overlaps(body, solid, .12))));
  assert.ok(!threat || !overlaps(player, threat, .12));
  world.actorIndex = new SpatialIndex(world.actors);
  updatePursuitResponse(world, true);
  pursuit.gta.scanner = new PursuitScanner();
  pursuit.gta.scan = pursuit.gta.scanner.sample(world);
  env.schema = schema;

  const endTick = front ? 180 : training ? 84 : 102, trace = [], featuresSeen = [], impacts = [];
  let handoff, startDistance;
  while (world.tick < endTick && pursuit.phase === "running") {
    const tick = world.tick, obs = env.getObservation();
    const prelude = tick < 12;
    const action = prelude ? coast : select(obs);
    if (tick === 12) {
      startDistance = pursuit.metrics.distanceM;
      handoff = { action, speed: player.speed, front: pursuit.gta.scan.rays[0],
        rear: pursuit.gta.scan.tracks.find(track => track.kind === "police" &&
          track.forwardM < 0 && track.ageS === 0 && track.motionKnown && track.ttcS !== null) ?? null };
    }
    const step = env.step(action);
    if (!prelude && collect && !step.info.shield?.interventions) featuresSeen.push(features(obs));
    impacts.push(...step.info.events.filter(event => isDispatchIncident(event) && event.fresh));
    assert.ok(bodyOnRoad(player, world.roads) && (!threat || world.actors.includes(threat)));
    trace.push([world.tick, player.x, player.z, player.speed, threat?.x ?? null, threat?.z ?? null, action,
      step.info.shield?.reason ?? null]);
  }
  assert.ok(handoff);
  return { featuresSeen, result: { layout, seed, kind, handoff, ticks: world.tick, impacts, trace,
    distanceM: pursuit.metrics.distanceM - startDistance, finalSpeed: player.speed,
    quarterMeterClear: !threat || !overlaps(player, threat, .25) } };
}

function project(constraints) {
  const head = baseHead.slice();
  let passes = 0;
  for (; passes < 400; passes++) {
    let worst = 0;
    for (const { row, lower, upper, norm2 } of constraints) {
      const current = logit(head, row), target = Math.max(lower, Math.min(upper, current));
      const delta = target - current;
      worst = Math.max(worst, Math.abs(delta));
      if (Math.abs(delta) <= 1e-9) continue;
      for (let h = 0; h < head.length; h++) head[h] += delta * row[h] / norm2;
    }
    if (worst < 1e-8) break;
  }
  return { head, passes };
}

const constraint = (row, lower, upper) => ({ row, lower, upper, norm2: row.reduce((sum, x) => sum + x * x, 0) });
const obeys = (head, { row, lower, upper }) => {
  const value = logit(head, row);
  return value >= lower - 1e-7 && value <= upper + 1e-7;
};
const stopped = row => row.handoff.front.kind === "civilian" && row.handoff.action.brake >= .8 &&
  row.quarterMeterClear && Math.abs(row.finalSpeed) < .3 && !row.impacts.length;
const advanced = row => row.distanceM > 7 && row.handoff.action.brake < .25 && !row.impacts.length;

const local = [], teachers = [];
for (const layout of trainLayouts) for (const kind of kinds) {
  const front = kind === "front";
  const { featuresSeen, result } = fixture(layout, kind, () => front ? PURSUIT_STOP : go, { training: true, collect: true });
  teachers.push(result);
  for (const row of featuresSeen) local.push(front ? constraint(row, brakeThreshold + Math.atanh(.88), Infinity)
    : constraint(row, -Infinity, .31));
}
await writeFile(join(output, "training-controls.json"), JSON.stringify(teachers, null, 2));
assert.ok(teachers.every(row => row.kind === "front" ? stopped(row) : advanced(row)),
  "An infeasible training teacher cannot supply labels");

const curriculum = JSON.parse(await readFile(new URL("../config/pursuit-rl-city-route-development.json", import.meta.url)));
const retention = [], city = [];
for (const [i, settings] of curriculum.stages.entries()) {
  const seed = curriculum.trainingSeeds[i * 2];
  const { env, initial } = resetPursuitEpisode({ ...settings, episodeSeconds: 60 }, seed);
  const { world } = env, before = world.actors.filter(a => a !== world.player && !a.pursuitRole);
  let obs = initial.obs, result, rawBrakes = 0, coastOrDrive = 0;
  do {
    const row = features(obs), prior = logit(baseHead, row), action = original.action(obs);
    assert.equal(action.brake, Math.max(0, Math.tanh(prior - brakeThreshold)));
    result = env.step(action);
    if (action.brake === 0) {
      retention.push(constraint(row, -Infinity, brakeThreshold - 1e-6));
      coastOrDrive++;
    } else if (!result.info.shield.interventions) {
      retention.push(constraint(row, prior - .019, prior + .019));
      rawBrakes++;
    }
    assert.ok(before.every(actor => world.actors.includes(actor)), "A retained City actor disappeared");
    obs = result.obs;
  } while (!result.terminated && !result.truncated);
  city.push({ seed, phase: result.info.phase, ticks: world.tick, actorCount: before.length,
    distanceM: world.pursuit.metrics.distanceM, rawBrakes, coastOrDrive });
}
assert.ok(city.every((row, i) => row.actorCount === curriculum.stages[i].traffic + curriculum.stages[i].pedestrians));

const fit = { local: project(local), constrained: project(local.concat(retention)) };
const controllers = { original: original.action };
let nonBrakeWeightsExact = true;
for (const [name, result] of Object.entries(fit)) {
  const weights = checkpoint.weights.slice();
  result.head.slice(0, hiddenCount).forEach((value, i) => { weights[headStart + i] = value; });
  weights[headBias] = result.head[hiddenCount];
  nonBrakeWeightsExact &&= weights.every((value, i) =>
    i === headBias || (i >= headStart && i < headStart + hiddenCount) || value === checkpoint.weights[i]);
  controllers[name] = freezePursuitPolicy({ ...checkpoint, weights }).action;
  result.localViolations = local.filter(row => !obeys(result.head, row)).length;
  result.retentionViolations = retention.filter(row => !obeys(result.head, row)).length;
}

const validation = [];
let validControls = true;
for (const layout of validationLayouts) {
  const [fastFront, stoppedFront, fastRear, stoppedRear] = [
    fixture(layout, "front", () => go).result, fixture(layout, "front", () => PURSUIT_STOP).result,
    fixture(layout, "rear", () => go).result, fixture(layout, "rear", () => PURSUIT_STOP).result,
  ];
  validControls &&= fastFront.impacts.some(hit => hit.actorId === "brake-margin-loading-sedan") && stopped(stoppedFront) &&
    fastRear.handoff.rear !== null && advanced(fastRear) && stoppedRear.impacts.some(hit => hit.type === "patrol_collision");
  validation.push(...[[fastFront, "forward"], [stoppedFront, "brake"], [fastRear, "forward"], [stoppedRear, "brake"]]
    .map(([row, arm]) => ({ arm, ...row })));
  for (const [arm, select] of Object.entries(controllers)) for (const kind of kinds)
    validation.push({ arm, ...fixture(layout, kind, select).result });
}
const oracle = { nonBrakeWeightsExact, validControls, cityRetention: fit.constrained.retentionViolations === 0,
  rawValidation: validation.filter(row => row.arm === "constrained").every(row => row.kind === "front" ? stopped(row) : advanced(row)) };
const report = { classification: "development brake-head capacity diagnosis, no new PPO update or production change",
  checkpointSha256, trainingRows: local.length, retentionRows: retention.length, city, fit, teachers, validation, oracle };
await writeFile(join(output, "brake-margin.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ oracle, fit: Object.fromEntries(Object.entries(fit).map(([name, { head, ...rest }]) => [name, rest])),
  validation: validation.map(row => [row.layout[0], row.arm, row.kind, row.handoff.action.brake, row.distanceM, row.impacts.length]) }));
