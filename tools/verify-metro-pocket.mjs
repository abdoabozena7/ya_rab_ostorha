import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { clamp } from "../src/core/config.js";
import { angleDelta, bodyOnRoad, corners, distance, overlaps } from "../src/core/geometry.js";
import { PURSUIT_STOP } from "../src/core/pursuit-controls.js";
import { Random } from "../src/core/random.js";
import { followPath } from "../src/core/vehicle.js";
import { GtaPursuitEnv } from "../src/rl/gta-pursuit-env.js";
import { freezePursuitPolicy, PursuitPpo } from "../src/rl/pursuit-ppo.js";
import { dispatchRouteGuide } from "../src/rl/pursuit-route-context.js";
import { isDispatchIncident, runPursuitEpisode } from "../src/rl/pursuit-rollouts.js";

const output = process.env.PROVE_IT_OUTPUT_DIR;
assert.ok(output, "Set a new proof output directory");
const priorPath = new URL(
  "../.runtime-proof/pursuit-rl-dense-learning-20261120/corrective-trial-20261120-221352/checkpoint-1.json", import.meta.url);
const expectedPrior = "854b284350457717cd2c299a0dc86604f2600ed989c1c9aac7ff497d0e5181e3";
const hash = data => createHash("sha256").update(data).digest("hex");
async function save(name, value) {
  const data = JSON.stringify(value);
  await writeFile(join(output, name), data, { flag: "wx" });
  return hash(data);
}
const trainSites = ["civic-souq", "gateway-station", "gateway-university"];
const validateSites = ["corniche-station", "civic-university"];
const sites = trainSites.concat(validateSites);
const modes = ["boxed", "open"];
const observation = "dispatch-route-v2";
const maxTicks = 480;
const go = { steer: 0, throttle: 1, brake: 0, gear: 1 };
const pose = ({ id, x, z, speed, heading }) => ({ id, x, z, speed, heading });
assert.equal(new Set(sites).size, sites.length);
assert.ok(!sites.includes("civic-station"));

function run(site, mode, seed, select, { teacher = false, sample = false, shield = true, noise = 0 } = {}) {
  const env = new GtaPursuitEnv();
  const scenario = `pocket-${site}:${mode}`;
  let { obs, info } = env.reset({ scenario, seed, shield, traffic: 0, pedestrians: 0, observation,
    config: { ruleset: "dispatch-v1", maxActivePatrols: 1, enableRoadblocks: false,
      enablePitManeuver: false, episodeMaxSeconds: maxTicks / 60 } });
  const { world } = env, { player, pursuit } = world, { scenario: course } = info;
  const { axis, sign, exitPlane, heading, roadId, center, halfX, halfZ } = course;
  const exit = world.drivingRoads.find(road => road.id === roadId);
  const fixed = course.wallIds.map(id => world.statics.find(body => body.id === id));
  assert.ok(fixed.every(Boolean));
  if (mode === "boxed") {
    const ends = fixed.filter(body => body.width < body.length), cross = fixed.filter(body => body.width > body.length);
    assert.ok(ends.length === 2 && cross.length === 2 &&
      ends.every(end => cross.every(wall => overlaps(end, wall))), "Closed pocket corners must overlap physically");
  } else assert.equal(world.statics.some(body => body.id === course.barrierId), false);
  const [patrol] = pursuit.patrols;
  assert.ok(patrol);
  const roster = world.actors.slice(), guide = dispatchRouteGuide(world, observation);
  assert.ok(guide?.path.length >= 20 && guide.path.length <= 200);
  const start = { player: pose(player), patrol: pose(patrol), pathSha256: hash(JSON.stringify(guide.path)),
    obsSha256: hash(Buffer.from(obs.buffer)) };
  const radar = [0, 9, 18, 27, 36, 45, 54, 63].map(i => pursuit.gta.scan.rays[i]);
  const trace = [], incidents = [], demonstrations = [], rollout = [];
  let cursor = 0, firstClear = null, postClearM = 0, postClearTicks = 0, keptClear = true, inside = true;
  let stopTick = null, stopRun = 0, stopRunM = 0, stopWindow = null, reverseM = 0, denies = 0, guards = 0;
  let rawBrake = 0, rawForward = 0, result, perturb = 0, bestAlong = 0;
  const random = new Random(`${seed}:${site}:teacher-disturbance`);
  const along = body => sign * body[axis], validGate = () => corners(player).every(corner => along(corner) > sign * exitPlane) &&
    Math.abs(angleDelta(player.heading, heading)) < .35 && bodyOnRoad(player, [exit]);
  const startAlong = along(player);
  const movement = () => distance(player, player.previous ?? player);
  const step = world.step;
  world.step = function () {
    const before = along(player);
    step.call(this);
    const tick = world.tick, acceptedM = movement();
    assert.ok(fixed.every(body => world.statics.includes(body)));
    assert.ok(world.actors.includes(player));
    if (pursuit.phase === "running")
      assert.ok(roster.every(actor => world.actors.includes(actor)), `A running-course actor disappeared at ${tick}`);
    assert.ok(bodyOnRoad(player, world.roads));
    if (pursuit.appliedCommand?.reason === "road-boundary") denies++;
    inside &&= corners(player).every(point =>
      Math.abs(point.x - center.x) <= halfX && Math.abs(point.z - center.z) <= halfZ);
    if (player.speed < -.05) reverseM += acceptedM;
    if (stopWindow === null) {
      if (Math.abs(player.speed) + Math.abs(player.gtaSlipMps ?? 0) <= .05) {
        stopTick ??= tick;
        stopRun++;
        stopRunM += acceptedM;
        if (stopRun === 120 && stopRunM <= .05) stopWindow = { start: stopTick, end: tick, travelM: stopRunM };
      } else {
        stopTick = null;
        stopRun = stopRunM = 0;
      }
    }
    if (firstClear === null && player.speed >= .6 && validGate()) firstClear = tick;
    if (firstClear !== null && tick > firstClear && tick <= firstClear + 120) {
      const progress = along(player) - before;
      postClearTicks++;
      postClearM += progress;
      keptClear &&= player.speed >= .6 && progress > 0 && validGate();
    }
  };
  while (world.tick < maxTicks && pursuit.phase === "running") {
    let action, chosen, label;
    if (teacher) {
      if (mode === "boxed") label = action = PURSUIT_STOP;
      else {
        const command = followPath(player, guide.path, cursor);
        cursor = command.cursor;
        const target = Math.min(6.4, Math.max(3.1, command.targetSpeed)), brake = clamp((player.speed - target) / 2.5, 0, 1);
        label = { steer: clamp(command.steer / player.spec.maxSteer, -1, 1),
          throttle: brake ? 0 : clamp((target - player.speed) / 1.8, 0, 1), brake, gear: 1 };
        if (world.tick % 24 === 0) perturb = random.range(-noise, noise);
        action = { ...label, steer: clamp(label.steer + perturb, -1, 1) };
      }
      demonstrations.push({ obs, action: label });
    } else {
      chosen = select(obs);
      action = sample ? chosen.action : chosen;
    }
    rawBrake += Number(action.brake > 0);
    rawForward += Number(action.gear === 1 && action.throttle > 0);
    result = env.step(action);
    guards += result.info.shield?.interventions ?? 0;
    incidents.push(...result.info.events.filter(isDispatchIncident));
    if (sample) {
      const { action: _action, ...policy } = chosen;
      // Supplement the standard reward in the local curriculum only. Escapes still come only from the City scorer.
      const denied = result.info.appliedCommand?.reason === "road-boundary";
      const safeStop = mode === "boxed" && action.brake >= .6 && Math.abs(player.speed) <= .05 && inside;
      const rollingClear = mode === "open" && validGate() && player.speed > .6;
      const alongM = Math.min(20, along(player) - startAlong);
      const gateProgress = mode === "open" ? .16 * Math.max(0, alongM - bestAlong) : 0;
      bestAlong = Math.max(bestAlong, alongM);
      rollout.push({ obs, ...policy, reward: result.reward + gateProgress + (safeStop || rollingClear ? .045 : 0) -
        (denied ? .08 : 0) });
    }
    obs = result.obs;
    trace.push([world.tick, player.x, player.z, player.heading, player.speed, action, result.info.appliedCommand,
      result.info.shield?.reason ?? null, patrol.distance]);
  }
  const contacts = pursuit.metrics.collisions, otherContacts = pursuit.metrics.trafficCollisions;
  const pass = world.tick === maxTicks && !contacts && !otherContacts && !denies && patrol.distance > .2 &&
    world.player.health === 100 && (mode === "open"
      ? firstClear !== null && firstClear <= 360 && postClearTicks === 120 && keptClear && postClearM >= 2
      : stopWindow !== null && stopWindow.start <= 60 && inside);
  const row = { site, mode, seed, start, course, radar, pass, tick: world.tick, phase: pursuit.phase, firstClear, keptClear,
    postClearTicks, postClearM, inside, stopWindow, contacts, otherContacts, denies, guards, rawBrake, rawForward, reverseM,
    patrolM: patrol.distance, distanceM: pursuit.metrics.distanceM, health: player.health, incidents, trace };
  return { row, demonstrations, rollout, result };
}

function compact({ trace: _trace, incidents: _incidents, ...row }) { return row; }

async function controls() {
  const pairs = [];
  for (const site of sites) {
    const seed = `pocket-dev-control:${site}`;
    const boxed = run(site, "boxed", seed, null, { teacher: true }).row;
    const open = run(site, "open", seed, null, { teacher: true }).row;
    const sameStart = ["player", "patrol", "pathSha256"].every(key =>
      JSON.stringify(boxed.start[key]) === JSON.stringify(open.start[key]));
    const distinctScan = boxed.start.obsSha256 !== open.start.obsSha256;
    pairs.push({ site, sameStart, distinctScan, boxed, open });
    console.log(JSON.stringify({ site, sameStart, distinctScan, boxed: compact(boxed), open: compact(open) }));
  }
  const unsafe = run(trainSites[0], "boxed", `pocket-dev-control:${trainSites[0]}`, () => go, { shield: false }).row;
  const solidWallContact = unsafe.incidents.some(event => event.type === "static_or_civilian_hit" &&
    unsafe.course.wallIds.includes(event.actorId) && event.closingSpeed > 0);
  const physicalPairsPassed = pairs.reduce((sum, pair) => sum + Number(pair.boxed.pass) + Number(pair.open.pass), 0);
  await save("pocket-controls.json", { physicalPairsPassed, solidWallContact, pairs, unsafe });
  assert.ok(physicalPairsPassed === sites.length * 2 && solidWallContact &&
    pairs.every(pair => pair.sameStart && pair.distinctScan), "A physical control failed; do not train on an unverified course");
}

async function learning() {
  const bytes = await readFile(priorPath);
  assert.equal(hash(bytes), expectedPrior);
  const checkpoint = JSON.parse(bytes), prior = freezePursuitPolicy(checkpoint);
  const samples = [], teachers = [], anchors = [];
  for (const site of trainSites) for (const mode of modes) for (let i = 0; i < 3; i++) {
    const seed = i === 0 ? `pocket-dev-control:${site}` : `pocket-train:${site}:${i}`;
    const trial = run(site, mode, seed, null, { teacher: true, noise: i * .025 });
    teachers.push(compact(trial.row));
    if (!trial.row.pass) continue;
    for (const [decision, demo] of trial.demonstrations.entries()) {
      if (mode === "open" || decision <= 17 || decision % 6 === 0) samples.push(demo);
    }
  }
  assert.ok(trainSites.every(site => modes.every(mode =>
    teachers.filter(row => row.site === site && row.mode === mode && row.pass).length >= 2)));
  const pocketSamples = samples.length;
  for (const [seed, level, traffic, pedestrians, patrols] of [
    ["route-train-00", 3, 36, 80, 7], ["city-route-train-02", 5, 96, 144, 12],
  ]) {
    const stage = { observation, wantedLevel: level, wantedLevelMax: level, traffic, pedestrians, patrols, episodeSeconds: 30 };
    const action = obs => {
      const decision = prior.action(obs);
      samples.push({ obs, action: decision });
      return decision;
    };
    const { metrics } = runPursuitEpisode(stage, seed, action);
    anchors.push(metrics);
  }
  const provenance = { classification: "development pocket trial only", prior: expectedPrior,
    teacherSites: trainSites, validationSites: validateSites, pocketSamples, anchors,
    fitEpochs: 22, imitationRate: .00035, ppoRate: .000006, actorAnchor: .015, std: [.055, .16, .13] };
  const model = new PursuitPpo("metro-pocket-physical-development", null, observation);
  model.weights.set(checkpoint.weights);
  const adam = model.applyAdam.bind(model);
  model.applyAdam = grad => adam(grad, provenance.imitationRate);
  const losses = model.warmStart(samples, provenance.fitEpochs);
  const warm = model.checkpoint();
  const warmSha256 = await save("warm-start.json", { ...warm, development: provenance });
  const warmPolicy = new PursuitPpo(null, warm);
  console.log(JSON.stringify({ kind: "warm", pocketSamples, samples: samples.length, losses, warmSha256 }));
  model.layout = { ...model.layout, std: provenance.std };
  model.applyAdam = grad => {
    adam(grad, provenance.ppoRate);
    const { OUTPUT_WEIGHTS, OUTPUT_BIAS } = model.layout;
    const criticStart = OUTPUT_WEIGHTS + (OUTPUT_BIAS - OUTPUT_WEIGHTS) * .75;
    for (let i = 0; i < model.weights.length; i++) {
      if ((i >= criticStart && i < OUTPUT_BIAS) || i === OUTPUT_BIAS + 3) continue;
      model.weights[i] += provenance.actorAnchor * (warm.weights[i] - model.weights[i]);
    }
  };
  const batch = [], onPolicy = [];
  for (const site of trainSites) for (const mode of modes) {
    const seed = `pocket-ppo:${site}`;
    const rng = new Random(`${model.seed}:${site}:${mode}`);
    const trial = run(site, mode, seed, obs => model.sample(obs, rng), { sample: true });
    trial.rollout.at(-1).episodeBootstrap = trial.result.terminated ? 0 : model.value(trial.result.obs);
    batch.push(...trial.rollout);
    onPolicy.push(trial.row);
  }
  const update = model.update(batch);
  const next = model.checkpoint();
  const { OUTPUT_WEIGHTS, OUTPUT_BIAS } = model.layout;
  assert.ok(next.weights.slice(0, OUTPUT_WEIGHTS).some((value, i) => value !== warm.weights[i]) ||
    next.weights.slice(OUTPUT_BIAS, OUTPUT_BIAS + 3).some((value, i) => value !== warm.weights[OUTPUT_BIAS + i]));
  const frozen = freezePursuitPolicy(next);
  const candidateSha256 = await save("checkpoint-1.json", { ...next, development: { ...provenance, warmSha256 } });
  const rows = [], alternatives = [["prior", prior.action], ["warm", obs => warmPolicy.action(obs)], ["frozen", frozen.action]];
  for (const site of validateSites) for (const mode of modes) for (const [arm, select] of alternatives) {
    const seed = `pocket-dev-control:${site}`;
    const row = { arm, ...run(site, mode, seed, select).row };
    if (arm === "frozen" && mode === "boxed" && row.pass) {
      row.rawBoxed = run(site, mode, seed, select, { shield: false }).row;
      row.pass &&= row.rawBoxed.pass;
    }
    rows.push(row);
    await appendFile(join(output, "runs.ndjson"), JSON.stringify(row) + "\n");
    console.log(JSON.stringify({ kind: "validation", ...compact(row), rawBoxed: row.rawBoxed && compact(row.rawBoxed) }));
  }
  const frozenPasses = rows.filter(row => row.arm === "frozen" && row.pass).length;
  const bothNewJunctionsPassed = frozenPasses === validateSites.length * modes.length;
  const report = { classification: "development training/validation, not independent L19 or full City retention", provenance,
    node: process.version, v8: process.versions.v8, warmSha256, candidateSha256, losses, samples: samples.length,
    teachers, update, updatesRecorded: next.updates, onPolicy, rows, frozenPasses, bothNewJunctionsPassed };
  await save("pocket-learning.json", report);
  assert.ok(bothNewJunctionsPassed, "This checkpoint did not stop and take the open branch on both new junctions");
}

const mode = process.argv[2];
if (mode === "controls") await controls();
else if (mode === "learning") await learning();
else throw new RangeError("Choose controls or learning");
