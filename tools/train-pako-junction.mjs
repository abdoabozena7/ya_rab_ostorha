import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Random } from "../src/core/random.js";
import { clamp } from "../src/core/config.js";
import { angleDelta, bodyOnRoad } from "../src/core/geometry.js";
import { GtaPursuitEnv } from "../src/rl/gta-pursuit-env.js";
import { freezePursuitPolicy, PursuitPpo } from "../src/rl/pursuit-ppo.js";
import { PAKO_JUNCTION_TRAIN, PAKO_JUNCTION_VALIDATE } from "../src/rl/pako-junction-course.js";
import { measureJunctionIntent, PAKO_JUNCTION_OBSERVATION } from "../src/rl/pako-junction-observation.js";

const output = process.env.PROVE_IT_OUTPUT_DIR;
assert.ok(output, "Set PROVE_IT_OUTPUT_DIR to a new output directory");
const incomingSHA = "854b284350457717cd2c299a0dc86604f2600ed989c1c9aac7ff497d0e5181e3";
const checkpointFile = new URL("../.runtime-proof/pursuit-rl-dense-learning-20261120/corrective-trial-20261120-221352/checkpoint-1.json", import.meta.url);
const bytes = await readFile(checkpointFile);
const sha256 = value => createHash("sha256").update(value).digest("hex");
assert.equal(sha256(bytes), incomingSHA);
const checkpoint = JSON.parse(bytes);
const incoming = freezePursuitPolicy(checkpoint);
const intent = !process.argv.includes("--legacy-cues");
const feedback = intent && !process.argv.includes("--bang-bang");
const trainingObservation = intent ? PAKO_JUNCTION_OBSERVATION.version : incoming.observation;
const training = PAKO_JUNCTION_TRAIN.flatMap((scenario, i) =>
  ["a", "b", "c"].map(suffix => ({ scenario, seed: `pako-earlier-train-${i}-${suffix}` })));
const validation = PAKO_JUNCTION_VALIDATE.flatMap((scenario, i) =>
  ["a", "b"].map(suffix => ({ scenario, seed: `pako-earlier-held-dev-${i}-${suffix}` })));
const settings = { episodeSeconds: 5, epochs: intent ? 72 : 16, ppoUpdates: 1, minimumPostTurnM: 10, clearanceTailTicks: 120,
  teacherKind: feedback ? "heading-and-lane-feedback" : "piecewise",
  teacherLeadsM: [4.05, 5.75, 2.25] };
assert.ok(validation.every(row => training.every(other => other.scenario !== row.scenario && other.seed !== row.seed)));

const forward = { steer: 0, throttle: .9, brake: 0, gear: 1 };
const brake = { steer: 0, throttle: 0, brake: 1, gear: 1 };
const dot = (p, q, a) => (p.x - q.x) * a.x + (p.z - q.z) * a.z;
const teacher = lead => (_obs, ego, course) => {
  const angle = course.turn * angleDelta(ego.heading, course.heading);
  const t = dot(ego, course.node, course.along);
  if (feedback) {
    if (t < -lead && angle < .06) return forward;
    const target = Math.PI / 2 + clamp((t + course.exitLaneM) * .28, -.31, .34);
    return { ...forward, steer: course.turn *
      clamp(1.9 * (target - angle) - ego.gtaYawRate * course.turn * .38, -.85, .92) };
  }
  return { ...forward, steer: course.turn * (angle > 1.60 ? -.45 : t >= -lead && angle < 1.43 ? .92 : 0) };
};

function run(row, choose, mode = "plain", useIntent = false) {
  const env = new GtaPursuitEnv();
  const setup = env.reset({ seed: row.seed, scenario: row.scenario, traffic: 0, pedestrians: 0,
    shield: true, observation: incoming.observation,
    config: { ruleset: "dispatch-v1", wantedLevelStart: 1, wantedLevelMax: 1, maxActivePatrols: 1,
      enableRoadblocks: false, episodeMaxSeconds: settings.episodeSeconds } });
  const exit = env.world.drivingRoads.find(road => road.id === setup.info.scenario.exitRoadId);
  const { world } = env, course = setup.info.scenario;
  const [patrol] = world.pursuit.patrols;
  const person = world.actors.find(a => a.id === course.walkerId);
  assert.ok(patrol && person);
  let obs = setup.obs, result, crossed = null, denied = 0, clearanceM = 0, reward = 0, interventions = 0;
  const samples = [], rollout = [], trace = [], contacts = [];
  const plant = world.step.bind(world);
  world.step = () => {
    plant();
    denied += Number(world.pursuit.metrics.guard === "road-boundary");
  };
  const encode = () => useIntent ? measureJunctionIntent(world) : { observation: obs, side: 1 };
  let input = encode();
  do {
    const decision = choose(input.observation, world.player, course);
    const selected = mode === "sample" ? decision.action : decision;
    const action = mode === "demonstrate" ? selected : { ...selected, steer: selected.steer * input.side };
    result = env.step(action);
    const { x, z, speed, heading } = world.player;
    trace.push({ tick: world.tick, x, z, heading, speed, patrol: [patrol.x, patrol.z, patrol.speed],
      person: [person.x, person.z], requested: action, applied: result.info.appliedCommand, shield: result.info.shield.reason });
    if (mode === "demonstrate") samples.push({ obs: input.observation, action: { ...action, steer: action.steer * input.side } });
    if (mode === "sample") rollout.push({ obs: input.observation, raw: decision.raw, logp: decision.logp,
      value: decision.value, reward: result.reward });
    contacts.push(...result.info.events.filter(e => e.type === "patrol_collision" ||
      e.type === "static_or_civilian_hit" || e.type === "ambient_collision"));
    reward += result.reward;
    interventions += result.info.shield.interventions;
    const ahead = dot(world.player, course.node, course.onward);
    if (!crossed && ahead >= 12 && Math.abs(angleDelta(heading, course.exitHeading)) <= .32 &&
        bodyOnRoad(world.player, [exit])) crossed = { tick: world.tick, ahead };
    if (crossed) clearanceM = ahead - crossed.ahead;
    obs = result.obs;
    input = encode();
  } while (!result.terminated && !result.truncated);
  const passed = Boolean(crossed && world.tick - crossed.tick >= settings.clearanceTailTicks &&
    clearanceM >= settings.minimumPostTurnM && contacts.length === 0 && patrol.distance > 10 && denied === 0);
  return { summary: { ...row, passed, crossed, clearanceM, denied, patrolM: patrol.distance,
    phase: result.info.phase, tick: world.tick, trace, contacts, reward, interventions },
  samples, rollout, obs: input.observation, result };
}

function references(rows) {
  return rows.map(row => ({
    ...row,
    brake: run(row, () => brake).summary,
    forward: run(row, () => forward).summary,
    turns: settings.teacherLeadsM.map(lead => {
      const measured = run(row, teacher(lead), "demonstrate", intent);
      return { lead, ...measured };
    }),
  }));
}

const trainingRefs = references(training);
const demonstrationRows = trainingRefs.flatMap(record => record.turns
  .filter(arm => arm.summary.passed).slice(0, 1).flatMap(arm => arm.samples));
const referenceEvidence = rows => rows.map(({ turns, ...rest }) =>
  ({ ...rest, turns: turns.map(({ lead, summary }) => ({ lead, summary })) }));
const trainingReport = referenceEvidence(trainingRefs);
await writeFile(join(output, "junction-qualification.json"), JSON.stringify({ settings, incomingSHA,
  training: trainingReport }, null, 2), { flag: "wx" });
console.log(JSON.stringify({ demonstrationRows: demonstrationRows.length,
  training: trainingRefs.map(row => ({ scenario: row.scenario, seed: row.seed,
    turns: row.turns.map(arm => [arm.lead, arm.summary.passed, arm.summary.crossed?.tick,
      arm.summary.contacts.length, arm.summary.denied]) })) }));

if (!process.argv.includes("--references")) {
  if (demonstrationRows.length < 200 || new Set(trainingRefs.filter(row =>
    row.turns.some(arm => arm.summary.passed)).map(row => row.scenario)).size < 2)
    throw new Error("Insufficient physical demonstrations from distinct training junctions");
  const actor = new PursuitPpo("pako-earlier-junction-v1", null, trainingObservation);
  if (!intent) actor.weights.set(checkpoint.weights);
  const losses = actor.warmStart(demonstrationRows, settings.epochs);
  const development = { incomingSHA, curriculum: "pako-earlier-junction-v1", training };
  const warm = { ...actor.checkpoint(), development };
  const updateBatch = [];
  for (const row of training) {
    const rng = new Random(`${row.seed}:real-ppo-rollout`);
    const real = run(row, obs => actor.sample(obs, rng), "sample", intent);
    real.rollout.at(-1).episodeBootstrap = real.result.terminated ? 0 : actor.value(real.obs);
    updateBatch.push(...real.rollout);
  }
  const update = actor.update(updateBatch);
  const candidate = { ...actor.checkpoint(), development };
  const encoded = arm => `${JSON.stringify(arm)}\n`;
  await writeFile(join(output, "warm-checkpoint.json"), encoded(warm), { flag: "wx" });
  await writeFile(join(output, "ppo-checkpoint.json"), encoded(candidate), { flag: "wx" });
  const baseline = new PursuitPpo(actor.seed, null, trainingObservation);
  const warmOnly = new PursuitPpo(null, warm), frozenCandidate = new PursuitPpo(null, candidate);
  if (intent) assert.throws(() => freezePursuitPolicy(candidate), /junction research adapter/);
  const attempts = referenceEvidence(references(validation)).map(row => ({ ...row,
    predecessor: run(row, incoming.action).summary,
    untrained: run(row, obs => baseline.action(obs), "plain", intent).summary,
    warm: run(row, obs => warmOnly.action(obs), "plain", intent).summary,
    ppo: run(row, obs => frozenCandidate.action(obs), "plain", intent).summary,
  }));
  const byArm = Object.fromEntries(["predecessor", "untrained", "warm", "ppo"]
    .map(arm => [arm, attempts.filter(row => row[arm].passed).length]));
  const qualified = attempts.filter(row => row.turns.some(arm => arm.summary.passed) &&
    !row.brake.passed && !row.forward.passed);
  const passesScopedLearningGate = new Set(qualified.map(row => row.scenario)).size >= 2 &&
    byArm.ppo > byArm.predecessor && byArm.ppo > byArm.untrained && byArm.ppo >= byArm.warm;
  const report = { settings, incomingSHA, trainingObservation, update, losses, checkpoints: {
    warm: sha256(encoded(warm)), ppo: sha256(encoded(candidate)),
  }, demoes: demonstrationRows.length, byArm, qualified: qualified.map(row => row.seed),
  passesScopedLearningGate, attempts };
  await writeFile(join(output, "junction-comparison.json"), JSON.stringify(report, null, 2), { flag: "wx" });
  console.log(JSON.stringify({ byArm, qualified: report.qualified, passesScopedLearningGate, update,
    diagnostics: attempts.map(row => ({ seed: row.seed, references: row.turns.map(arm => arm.summary.passed),
      finalTicks: [row.warm.crossed, row.ppo.crossed], contacts: [row.warm.contacts.length, row.ppo.contacts.length],
      denials: [row.warm.denied, row.ppo.denied] })) }));
  if (process.argv.includes("--require-improvement")) assert.ok(passesScopedLearningGate,
    "Frozen development comparison did not establish earlier feasible learner improvement");
}
