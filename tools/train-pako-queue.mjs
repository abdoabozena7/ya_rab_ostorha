import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { clamp } from "../src/core/config.js";
import { initializeDistrictActor } from "../src/core/district-behavior.js";
import { districtRoadPose } from "../src/core/egypt-district.js";
import { angleDelta, bodyOnRoad, corners, overlaps } from "../src/core/geometry.js";
import { PURSUIT_STOP } from "../src/core/pursuit-controls.js";
import { updatePursuitResponse } from "../src/core/pursuit-response.js";
import { Random } from "../src/core/random.js";
import { SpatialIndex } from "../src/core/spatial-index.js";
import { GtaPursuitEnv } from "../src/rl/gta-pursuit-env.js";
import { MEASURED_QUEUE_DETOUR, queuePassingConflict } from "../src/rl/pako-measured-detour.js";
import { freezePursuitPolicy, PursuitPpo } from "../src/rl/pursuit-ppo.js";
import { measureQueueBranchIntent, measureQueueIntent, PAKO_QUEUE_BRANCH_OBSERVATION,
  PAKO_QUEUE_OBSERVATION } from "../src/rl/pako-queue-observation.js";
import { PursuitScanner } from "../src/signal_processing/pursuit-scanner.js";

const output = process.env.PROVE_IT_OUTPUT_DIR;
assert.ok(output, "Set a fresh PROVE_IT_OUTPUT_DIR");
const file = new URL("../.runtime-proof/pursuit-rl-dense-learning-20261120/corrective-trial-20261120-221352/checkpoint-1.json", import.meta.url);
const priorBytes = await readFile(file);
const hash = value => createHash("sha256").update(value).digest("hex");
const priorSha = hash(priorBytes);
assert.equal(priorSha, "854b284350457717cd2c299a0dc86604f2600ed989c1c9aac7ff497d0e5181e3");
const predecessor = freezePursuitPolicy(JSON.parse(priorBytes));

const closeTail = process.argv.includes("--close-tail");
const lateMerge = process.argv.includes("--late-merge");
const connectedReference = process.argv.includes("--connected-reference");
const connectedLearning = process.argv.includes("--connected-learning");
const followThrough = process.argv.includes("--follow-through-diagnostics");
const lookaheadReference = process.argv.includes("--lookahead-reference");
const reservePassingLane = process.argv.includes("--reserve-passing-lane");
const requirePassingCorridor = process.argv.includes("--require-passing-corridor");
assert.ok(!reservePassingLane || lookaheadReference);
assert.ok(!requirePassingCorridor || reservePassingLane);
assert.ok(!(connectedReference || followThrough || lookaheadReference) || process.argv.includes("--reference-only"),
  "Screen connected references on fit roads before training");
assert.ok(!connectedLearning || !(connectedReference || followThrough || closeTail || lateMerge || lookaheadReference),
  "Connected learning uses the sealed reference layout");
const training = [["corniche-avenue", -17, 1], ["station-avenue", closeTail ? -133 : -144, -1],
  ["tahrir-boulevard", closeTail ? -251 : -224, 1]];
const branches = new Map([
  ["corniche-avenue", ["souq-collector", 1]],
  ["station-avenue", ["civic-avenue", -1]],
  ["tahrir-boulevard", ["civic-avenue", 1]],
  ["university-avenue", ["civic-avenue", -1]],
  ["gateway-avenue", ["souq-collector", -1]],
]);
const validation = [["university-avenue", -232, 1], ["gateway-avenue", -47, 1]];
assert.ok(validation.every(site => training.every(other => site[0] !== other[0])));
const settings = { horizon: 600, epochCount: 74, optimumGapM: 11,
  reattachAtM: lateMerge ? 40 : 27, reattachSpanM: lateMerge ? 12 : 17, retainTicks: 120,
  retainProgressM: 10, ppoCount: 1, tailStartM: closeTail || lookaheadReference ? 25 : 43 };
const brake = PURSUIT_STOP;
const go = { ...brake, throttle: .85, brake: 0 };
const teacherVariants = [[3.6, 5.8, 7.3], [4.8, 3.1, 9.5], [5.8, 4.2, 12], [6.3, 4.2, 15], [6.1, 5, 17.5]];
const teach = ([entryPace, lookahead, cruise], intent, ego) => {
  const angle = angleDelta(ego.heading, intent.heading);
  const error = intent.targetLateral - (ego.x * Math.cos(intent.heading) - ego.z * Math.sin(intent.heading) - intent.center);
  const target = Math.atan2(error, lookahead + Math.max(0, ego.speed - 3));
  const yaw = ego.speed * Math.tan(ego.steer) / ego.spec.wheelbase + ego.gtaYawRate;
  const steer = clamp(1.45 * (target - angle) - .19 * yaw, -.86, .86);
  const maxSpeed = entryPace + (cruise - entryPace) / (1 + (error / 1.8) ** 2);
  const brake = ego.speed > maxSpeed + .25 ? .35 : 0;
  return { ...go, steer, throttle: brake ? 0 : clamp(.55 * (maxSpeed - ego.speed), 0, 1), brake };
};

function connectedTeacher(turnLeadM, turnPace, { outer = false, yieldOpposing = false } = {}) {
  let turning = false, opposingClear = !yieldOpposing, leadBehind = false;
  return (_, ego, intent, exit, scan) => {
    if (!opposingClear) {
      opposingClear = scan.tracks.some(track => track.kind === "civilian" && track.ageS === 0 &&
        track.motionKnown && track.rightM > 2.8 && track.forwardM < -ego.length / 2 - .5 &&
        track.forwardMps + ego.speed < -.5);
      if (!opposingClear) return teach([3.8, 4.2, 3.8], { ...intent, targetLateral: intent.home }, ego);
    }
    const approach = exit && exit.approachM(ego);
    if (!turning && (!exit || approach < -turnLeadM)) {
      const pace = exit ? Math.min(24, Math.sqrt(turnPace ** 2 + 6 * (-approach - turnLeadM))) : 26;
      if (outer && exit.turn > 0) {
        leadBehind ||= scan.tracks.some(track => track.kind === "civilian" && track.ageS === 0 &&
          track.rightM < -2.8 && track.forwardM < -ego.length / 2 - .5);
        if (leadBehind) {
          const shift = clamp((approach + 32) / 15, 0, 1);
          const targetLateral = intent.targetLateral + (intent.home - intent.targetLateral) * shift * shift * (3 - 2 * shift);
          return teach([6.1, 4.2, pace], { ...intent, targetLateral }, ego);
        }
      }
      return teach([6.1, 4.2, pace], intent, ego);
    }
    turning = true;
    const angle = exit.turn * angleDelta(ego.heading, intent.heading);
    const target = Math.PI / 2 + clamp(approach * .28, -.33, .37);
    const steer = exit.turn * clamp(1.85 * (target - angle) - ego.gtaYawRate * exit.turn * .32, -.76, .9);
    const exitPace = Math.sqrt(4.5 * Math.max(0, exit.roomM(ego) - ego.length / 2 - 2));
    const pace = Math.min(Math.abs(target - angle) < .21 ? 23 : turnPace, exitPace);
    const brake = clamp((ego.speed - pace - .15) * .27, 0, .7);
    return { ...go, steer, throttle: brake ? 0 : clamp((pace - ego.speed) * .65, 0, 1), brake };
  };
}

function run({ site, seed }, select, { fitted = false, negative = false, sample = false, record = false,
  reference = null, queueDetour } = {}) {
  const env = new GtaPursuitEnv();
  env.reset({ seed, traffic: 0, pedestrians: 0, shield: true, queueDetour, observation: predecessor.observation, config: {
    ruleset: "dispatch-v1", wantedLevelStart: 1, wantedLevelMax: 1, maxActivePatrols: 1,
    enableRoadblocks: false, episodeMaxSeconds: settings.horizon / 60,
  } });
  const { world } = env, { player, pursuit } = world, [police] = pursuit.patrols;
  const [roadId, along, direction] = site, road = world.drivingRoads.find(r => r.id === roadId);
  const rng = new Random(seed);
  const start = { ...districtRoadPose(road, along + rng.range(-.44, .44), direction),
    speed: lookaheadReference ? rng.range(4.45, 5.05) : rng.range(2.25, 2.85) };
  const leadGap = settings.optimumGapM + rng.range(-.35, .70) + (lookaheadReference ? 3 : 0);
  Object.assign(player, start);
  pursuit.playerStart = { ...start };
  const lead = world.makeVehicle("queue-practice-lead", "sedan", districtRoadPose(road, along + leadGap * direction, direction));
  initializeDistrictActor(world, lead);
  lead.district.loadingUntilTick = settings.horizon + 60;
  lead.district.nextLoadingDistanceM = null;
  world.actors.push(lead);
  Object.assign(police, districtRoadPose(road, along - settings.tailStartM * direction, direction), { speed: 4.6 });
  pursuit.gta.publicRouteGoal = { ...districtRoadPose(road, along + 28 * direction, direction), roadId };
  const occupied = [player, lead, police];
  if (negative) {
    // The opposite lane is physically occupied, not just flagged blocked to a learner.
    const other = world.makeVehicle("queue-opposite-mover", "sedan",
      districtRoadPose(road, along + (negative === "late" ? 29 : 15) * direction, -direction));
    initializeDistrictActor(world, other);
    const ahead = districtRoadPose(road, along - direction * 16, -direction);
    other.path = [{ x: other.x, z: other.z }, ahead];
    other.speed = negative === "late" ? 0 : 2.3;
    if (negative === "late") other.district.loadingUntilTick = 42;
    other.district.nextLoadingDistanceM = null;
    occupied.push(other);
    world.actors.push(other);
  }
  assert.ok(occupied.every((a, i) => bodyOnRoad(a, [road]) && world.statics.every(b => !overlaps(a, b, .12)) &&
    occupied.slice(0, i).every(b => !overlaps(a, b, .12))), `Invalid physical starting poses: ${site}`);
  world.actorIndex = new SpatialIndex(world.actors);
  updatePursuitResponse(world, true);
  pursuit.gta.scanner = new PursuitScanner();
  pursuit.gta.scan = pursuit.gta.scanner.sample(world);
  const directionSin = Math.sin(start.heading), directionCos = Math.cos(start.heading);
  const center = (road.axis === "x" ? -directionSin : directionCos) * road.fixed;
  const home = start.x * directionCos - start.z * directionSin - center;
  const alternate = -home;
  const intent = { heading: start.heading, targetLateral: alternate, center, halfWidth: road.width / 2, home };
  const longitudinal = a => (a.x - start.x) * directionSin + (a.z - start.z) * directionCos;
  const lateral = a => a.x * directionCos - a.z * directionSin - center;
  let exit;
  if (reference === "branch") {
    const [exitId, exitDirection] = branches.get(roadId);
    const exitRoad = world.drivingRoads.find(r => r.id === exitId);
    const node = road.axis === "x" ? { x: exitRoad.fixed, z: road.fixed } : { x: road.fixed, z: exitRoad.fixed };
    assert.ok(bodyOnRoad({ ...player, ...node, heading: start.heading }, world.roads), "Disconnected reference junction");
    const lane = districtRoadPose(exitRoad, road.fixed + 14 * exitDirection, exitDirection);
    exit = { road: exitRoad, heading: lane.heading, turn: Math.sign(angleDelta(lane.heading, start.heading)),
      approachM: pose => longitudinal(pose) - longitudinal(lane),
      roomM: pose => (exitDirection > 0 ? exitRoad.max - pose[exitRoad.axis] : pose[exitRoad.axis] - exitRoad.min),
      outwardM: pose => (pose[exitRoad.axis] - node[exitRoad.axis]) * exitDirection };
    if (connectedLearning)
      pursuit.gta.publicRouteGoal = { ...districtRoadPose(exitRoad, road.fixed + 26 * exitDirection, exitDirection),
        roadId: exitId };
  }
  const observe = () => fitted && connectedLearning
    ? measureQueueBranchIntent(world, intent, { approachM: exit.approachM(player), roomM: exit.roomM(player), turn: exit.turn })
    : fitted ? measureQueueIntent(world, intent) : env.getObservation();
  const leadNose = Math.max(...corners(lead).map(longitudinal));
  let result, passedAt = null, progressedM = 0, releaseAt = null, denied = 0, firstDenied = Infinity;
  let branchCrossedAt = null, movedAtClearanceM = 0, patrolAtClearanceM = 0, patrolLostAt = null;
  const samples = [], decisions = [], contacts = [], rollout = [];
  const baseStep = world.step.bind(world);
  world.step = () => {
    if (reference && !pursuit.patrols.has(police)) patrolLostAt ??= world.tick;
    baseStep();
    if (pursuit.metrics.guard === "road-boundary") {
      denied++;
      firstDenied = Math.min(firstDenied, world.tick);
    }
  };
  do {
    const progress = longitudinal(player);
    if (!reference && progress > settings.reattachAtM) {
      const blend = clamp((progress - settings.reattachAtM) / settings.reattachSpanM, 0, 1);
      intent.targetLateral = alternate + (home - alternate) * blend * blend * (3 - 2 * blend);
      releaseAt ??= world.tick;
    }
    const obs = observe();
    const proposed = select(obs, player, intent, exit, pursuit.gta.scan);
    const action = sample ? proposed.action : proposed;
    result = env.step(action);
    if (record) samples.push({ obs, action });
    if (sample) rollout.push({ obs, raw: proposed.raw, value: proposed.value, logp: proposed.logp, reward: result.reward });
    const clear = Math.min(...corners(player).map(longitudinal)) - leadNose;
    if (clear > .35 && !passedAt) {
      passedAt = { tick: world.tick, atM: longitudinal(player) };
      movedAtClearanceM = pursuit.metrics.distanceM;
      patrolAtClearanceM = police.distance;
    }
    if (passedAt) progressedM = longitudinal(player) - passedAt.atM;
    contacts.push(...result.info.events.filter(e => e.type === "patrol_collision" || e.type === "static_or_civilian_hit" ||
      e.type === "ambient_collision"));
    assert.ok(world.actors.includes(lead), "Scenario cannot remove its obstruction");
    if (reference) {
      if (exit && branchCrossedAt === null && passedAt && exit.outwardM(player) >= 12 &&
          Math.abs(angleDelta(player.heading, exit.heading)) <= .32 && bodyOnRoad(player, [exit.road]))
        branchCrossedAt = world.tick;
    }
    decisions.push({ tick: world.tick, progress: longitudinal(player), lateral: lateral(player), speed: player.speed,
      policeGapM: longitudinal(player) - longitudinal(police), leadM: lead.distance, action, shield: result.info.shield.reason,
      ...(reference && { pose: [player.x, player.z, player.heading],
        police: [police.x, police.z, police.speed], guard: pursuit.metrics.guard }) });
  } while (!result.terminated && !result.truncated);
  const pass = Boolean(world.tick === settings.horizon && passedAt && world.tick - passedAt.tick >= settings.retainTicks &&
    progressedM >= settings.retainProgressM && police.distance > 10 && contacts.length === 0 && denied === 0);
  const firstUnsafe = Math.min(firstDenied, ...contacts.map(contact => contact.tick));
  const prefix = passedAt && decisions.find(row => row.tick < firstUnsafe && row.tick - passedAt.tick >= settings.retainTicks &&
    row.progress >= passedAt.atM + settings.retainProgressM);
  const movedAfterClearanceM = passedAt ? pursuit.metrics.distanceM - movedAtClearanceM : 0;
  const patrolAfterClearanceM = passedAt ? police.distance - patrolAtClearanceM : 0;
  const branchPass = Boolean(exit && branchCrossedAt !== null && patrolLostAt === null && patrolAfterClearanceM > 10 &&
    world.tick === settings.horizon && world.tick - passedAt.tick >= settings.retainTicks &&
    movedAfterClearanceM >= settings.retainProgressM && contacts.length === 0 && denied === 0 &&
    exit.outwardM(player) >= 12 && Math.abs(angleDelta(player.heading, exit.heading)) <= .32 &&
    bodyOnRoad(player, [exit.road]));
  return { summary: { site, seed, negative, pass, passedAt, progressedM, releaseAt,
    ticks: world.tick, phase: pursuit.phase, policeM: police.distance, denied, contacts, decisions,
    teachablePrefixTick: prefix?.tick ?? null,
    leadM: lead.distance, oppositeM: occupied.at(3)?.distance ?? null,
    ...(reference && { exitRoad: exit?.road.id ?? null, branchCrossedAt, branchPass, movedAfterClearanceM,
      patrolLostAt, patrolAfterClearanceM }) },
  samples, rollout, result, obs: fitted ? observe() : result.obs };
}

const course = (sites, category, alternatives) => sites.flatMap((site, i) =>
  alternatives.map(suffix => ({ site, seed: `pako-queue-${category}-${i}-${suffix}` })));
const trainCases = course(training, "fit", ["a", "b", "c"]);
const valCases = course(validation, "validation", ["p", "q"]);
const branchOptions = connectedLearning ? { reference: "branch" } : {};
const connectedTune = [7.8, 9.2];
const teacherAt = (row, variant, record) => run(row, connectedLearning
  ? connectedTeacher(...variant) : (_, actor, intent) => teach(variant, intent, actor),
  { ...branchOptions, fitted: true, record });
const recordFile = (name, data) => writeFile(join(output, name), JSON.stringify(data, null, 2) + "\n", { flag: "wx" });
if (lookaheadReference) {
  const starts = course([["corniche-avenue", -23, 1], ["station-avenue", -151, -1],
    ["tahrir-boulevard", -211, 1]], "lookahead-fit", ["a", "b"]);
  const runBranch = (row, select, options) => run(row, select, { reference: "branch", ...options }).summary;
  const early = (tune, reserve = reservePassingLane) => {
    const follow = connectedTeacher(...tune);
    let sawSlowLead = false, clearanceReserved = false;
    return (obs, ego, intent, exit, scan) => {
      const slowLead = scan.tracks.find(t => t.kind === "civilian" && t.motionKnown && t.ageS === 0 &&
        t.forwardM >= 6 && t.forwardM < 18 && Math.abs(t.rightM) < 1.3 &&
        Math.hypot(t.estimatedXMps, t.estimatedZMps) < 1.35);
      const relativeRight = intent.targetLateral -
        (ego.x * Math.cos(intent.heading) - ego.z * Math.sin(intent.heading) - intent.center);
      if (reserve) {
        const reach = clearanceReserved ? 11 : (slowLead?.forwardM ?? 10) + 20;
        if (queuePassingConflict(scan, ego, intent.heading, relativeRight, reach)) return brake;
        if (slowLead) clearanceReserved = true;
      }
      sawSlowLead ||= Boolean(slowLead);
      if (!sawSlowLead) return { ...go, throttle: .3 };
      const oncoming = scan.tracks.some(t => t.kind === "civilian" && t.motionKnown && t.ageS === 0 &&
        t.forwardM > 0 && t.forwardM < 30 && Math.abs(t.rightM - relativeRight) < 2.05 &&
        t.forwardMps + ego.speed < -.6);
      return oncoming ? brake : follow(obs, ego, intent, exit, scan);
    };
  };
  const candidates = [[7.8, 9.2], [8.6, 9.2], [8.6, 10.7]];
  const cases = starts.map(row => ({ ...row,
    held: runBranch(row, () => brake),
    predecessor: runBranch(row, predecessor.action),
    measured: runBranch(row, predecessor.action, { queueDetour: MEASURED_QUEUE_DETOUR }),
    candidates: candidates.map(tune => ({ tune, clear: runBranch(row, early(tune)),
      late: runBranch(row, early(tune), { negative: "late" }),
      ...(requirePassingCorridor && { unreserved: runBranch(row, early(tune, false), { negative: "late" }) }) })),
  }));
  const trials = cases.flatMap(row => row.candidates);
  const opposingHit = ({ contacts }) => contacts.some(e =>
    [e.actorId, e.first?.id, e.second?.id].includes("queue-opposite-mover"));
  const lateOpponentHits = trials.filter(row => opposingHit(row.late)).length;
  const unreservedOpponentHits = trials.filter(row => row.unreserved && opposingHit(row.unreserved)).length;
  const clearCompletions = trials.filter(row => row.clear.branchPass).length;
  const safety = { lateOpponentHits, unreservedOpponentHits, clearCompletions,
    pass: requirePassingCorridor && lateOpponentHits === 0 && unreservedOpponentHits > 0 && clearCompletions > 0 &&
      trials.every(row => row.clear.ticks === settings.horizon && row.late.ticks === settings.horizon &&
        row.unreserved.ticks === settings.horizon && row.late.oppositeM > 1 && row.unreserved.oppositeM > 1) };
  await recordFile("queue-lookahead.json", { settings, candidates, reservePassingLane, cases, safety });
  const brief = arm => [arm.passedAt?.tick, arm.branchCrossedAt, arm.branchPass,
    arm.contacts[0]?.type, arm.contacts[0]?.tick, arm.denied];
  console.log(JSON.stringify({ safety, cases: cases.map(row => [row.seed, brief(row.predecessor), brief(row.measured),
    row.candidates.map(({ tune, clear, late }) => [tune, brief(clear), brief(late)])]) }));
  if (requirePassingCorridor) assert.ok(safety.pass, "No demonstrated full-window protection of the opposing sedan");
} else if (followThrough) {
  const compare = (row, tune, options, negative = false) =>
    run(row, connectedTeacher(...tune, options), { fitted: true, reference: "branch", negative }).summary;
  const faster = [8.6, 10.7];
  const longApproach = course([["corniche-avenue", -42, 1], ["tahrir-boulevard", -134, -1]], "long-fit", ["a", "b"])
    .map(row => ({ ...row, nominal: compare(row, connectedTune), faster: compare(row, faster),
      outer: compare(row, faster, { outer: true }) }));
  const opposing = trainCases.map(row => ({ ...row,
    immediate: compare(row, connectedTune, {}, true), yield: compare(row, connectedTune, { yieldOpposing: true }, true) }));
  await recordFile("queue-follow-through.json", { settings, longApproach, opposing });
  const brief = a => [a.branchPass, a.passedAt?.tick, a.contacts[0]?.tick, a.denied, a.oppositeM];
  console.log(JSON.stringify({ longApproach: longApproach.map(row =>
    [row.seed, brief(row.nominal), brief(row.faster), brief(row.outer)]),
  opposing: opposing.map(row => [row.seed, brief(row.immediate), brief(row.yield)]) }));
} else if (connectedReference) {
  const turns = [[7.8, 7.4], [7.8, 9.2], [8.6, 9.2]];
  const cases = trainCases.map(row => ({ ...row,
    straight: run(row, connectedTeacher(0, 0), { fitted: true, reference: "straight" }).summary,
    branches: turns.map(tune => ({ tune,
      ...run(row, connectedTeacher(...tune), { fitted: true, reference: "branch" }).summary })),
  }));
  await recordFile("queue-connected-reference.json", { settings, cases });
  console.log(JSON.stringify(cases.map(row => ({ seed: row.seed, straight: row.straight.pass,
    branches: row.branches.map(run => [run.tune, run.branchCrossedAt, run.branchPass, run.pass,
      run.contacts[0]?.tick, run.denied]) }))));
} else {
  const variants = connectedLearning ? [connectedTune] : teacherVariants;
  const trainingTrials = trainCases.map(row => variants.map(variant => ({ variant, ...teacherAt(row, variant, true) })));
  const supervised = trainingTrials.flatMap(trials => trials.filter(row => connectedLearning
    ? row.summary.branchPass : row.summary.teachablePrefixTick !== null)
    .sort((a, b) => a.summary.passedAt.tick - b.summary.passedAt.tick).slice(0, 2));
  await recordFile("queue-qualification.json", { connectedLearning, settings,
    teacher: trainingTrials.map(variants => variants.map(({ variant, summary }) => ({ variant, summary }))) });
  console.log(JSON.stringify({ teacherTrajectories: trainingTrials.flat().length, prefixes: supervised.length,
    fullTeachers: trainingTrials.flat().filter(row => connectedLearning ? row.summary.branchPass : row.summary.pass).length }));
  if (!process.argv.includes("--reference-only")) await train(supervised);
}

async function train(supervised) {
  const examples = supervised.flatMap(row => row.samples.filter((_, i) =>
    connectedLearning || row.summary.decisions[i].tick <= row.summary.teachablePrefixTick));
  const distinct = new Set(supervised.map(row => row.summary.site[0]));
  assert.ok(examples.length >= 180 && distinct.size >= 2, "Need recent guarded physics from distinct training roads");
  const schema = connectedLearning ? PAKO_QUEUE_BRANCH_OBSERVATION : PAKO_QUEUE_OBSERVATION;
  const model = new PursuitPpo(connectedLearning ? schema.version : "pako-queue-v1", null, schema.version);
  const untrained = new PursuitPpo(model.seed, null, model.observation);
  const losses = model.warmStart(examples, settings.epochCount), warm = model.checkpoint();
  const learnerRows = [];
  const updateBatch = trainCases.flatMap(row => {
    const rng = new Random(`${row.seed}:sampled-ppo`);
    const trial = run(row, obs => model.sample(obs, rng), { ...branchOptions, fitted: true, sample: true });
    learnerRows.push(trial.summary);
    const last = trial.rollout.at(-1);
    last.episodeBootstrap = trial.result.terminated || connectedLearning ? 0 : model.value(trial.obs);
    if (connectedLearning && trial.summary.branchPass) last.reward += 6;
    return trial.rollout;
  });
  const update = model.update(updateBatch);
  assert.ok(update.transitions > 400);
  const trained = model.checkpoint();
  assert.throws(() => freezePursuitPolicy(trained), /queue research adapter/);
  await recordFile("pako-queue-ppo.json", trained);
  await recordFile("pako-queue-warm.json", warm);
  const warmActor = new PursuitPpo(null, warm), ppo = new PursuitPpo(null, trained);
  const validate = connectedLearning ? course(validation, "connected-validation", ["a", "b"]) : valCases;
  const paired = validate.map(row => ({ ...row,
    teacher: teacherAt(row, supervised[0].variant, false).summary,
    predecessor: run(row, predecessor.action, branchOptions).summary,
    untrained: run(row, obs => untrained.action(obs), { ...branchOptions, fitted: true }).summary,
    warm: run(row, obs => warmActor.action(obs), { ...branchOptions, fitted: true }).summary,
    ppo: run(row, obs => ppo.action(obs), { ...branchOptions, fitted: true }).summary,
    blocked: run(row, obs => ppo.action(obs), { ...branchOptions, fitted: true, negative: true }).summary,
    held: run(row, () => brake, branchOptions).summary, straight: run(row, () => go, branchOptions).summary,
  }));
  const passed = arm => connectedLearning ? arm.branchPass : arm.pass;
  const totals = Object.fromEntries(["teacher", "predecessor", "untrained", "warm", "ppo", "blocked", "held", "straight"]
    .map(key => [key, paired.filter(row => passed(row[key])).length]));
  const safeBlocked = row => connectedLearning ? row.contacts.length === 0 && row.denied === 0
    : row.contacts.every(hit => hit.type === "ambient_collision");
  const robust = new Set(paired.filter(row => passed(row.teacher) && passed(row.ppo) &&
    !passed(row.held) && !passed(row.straight) && safeBlocked(row.blocked) &&
    row.blocked.oppositeM > .15).map(row => row.site[0]));
  const pass = robust.size >= 2 && totals.ppo > totals.predecessor && totals.ppo > totals.untrained && totals.ppo >= totals.warm;
  await recordFile("queue-learning.json", { connectedLearning, settings, priorSha, observation: model.observation, examples: examples.length,
    losses, update, totals, robust: [...robust], pass, paired, learnerRows });
  console.log(JSON.stringify({ totals, robust: [...robust], pass, update,
    evaluation: paired.map(row => [row.seed, row.ppo.contacts.length, row.ppo.denied, row.ppo.passedAt?.tick,
      row.ppo.progressedM, row.blocked.contacts.length, row.blocked.oppositeM]) }));
  if (process.argv.includes("--require-improvement"))
    assert.ok(pass, "Frozen PPO did not improve guarded early queue response on distinct validation roads");
}
