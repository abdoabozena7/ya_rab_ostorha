import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { bodyOnRoad, overlaps } from "../src/core/geometry.js";
import { PATROL_CHAIN_YIELD } from "../src/core/pako-patrol-yield.js";
import { DISPATCH_DAMAGE_FEEDBACK, resolveGtaChaseConfig } from "../src/core/pursuit-gta.js";
import { PURSUIT_STOP } from "../src/core/pursuit-controls.js";
import { updatePursuitResponse } from "../src/core/pursuit-response.js";
import { SpatialIndex } from "../src/core/spatial-index.js";
import { World } from "../src/core/world.js";
import { GtaPursuitEnv } from "../src/rl/gta-pursuit-env.js";
import { PursuitScanner } from "../src/signal_processing/pursuit-scanner.js";

const lateralProfile = "indirect-pedestrian-yield-v2";
const baselineOnly = process.argv.includes("--baseline");
const output = process.env.PROVE_IT_OUTPUT_DIR;
const windowTicks = 150;
const course = { seed: "pako-development-station-lateral-01", x: -209, z: -72.8, road: "station-avenue" };

function run(kind, profile) {
  const env = new GtaPursuitEnv();
  env.reset({ seed: course.seed, traffic: 0, pedestrians: Number(kind !== "clear"),
    shield: true, config: { ruleset: "dispatch-v1", wantedLevelMax: 1, maxActivePatrols: 1,
      damageFeedback: DISPATCH_DAMAGE_FEEDBACK,
      ...(profile === null ? {} : { patrolChainYield: profile }) } });
  const { world } = env, { player, pursuit } = world, [patrol] = pursuit.patrols;
  const person = world.actors.find(actor => actor.type === "pedestrian");
  const road = world.drivingRoads.find(road => road.id === course.road);
  const pose = { x: course.x, z: course.z, speed: 0, steer: 0, gtaSlipMps: 0, gtaYawRate: 0, heading: Math.PI / 2 };
  Object.assign(player, pose, { previous: { ...player, ...pose } });
  const side = kind === "late" ? player.width / 2 + patrol.length / 2 + .11 : 5.45;
  const start = { ...pose, x: pose.x - .1, z: pose.z - side, heading: 0, speed: kind === "late" ? 9 : 4.65 };
  Object.assign(patrol, start, { previous: { ...patrol, ...start } });
  if (person) {
    const moving = kind === "moving-clear";
    Object.assign(person, { x: pose.x + (moving ? 1.22 : 1.67), z: pose.z + (kind === "far" ? 2.75 : 1.46),
      speed: moving ? 1.2 : 0, pause: moving ? 0 : 9, walkRoute: null, crossing: false });
    person.target = { x: person.x + (moving ? 6 : 0), z: person.z };
    Object.assign(person.district, { caseId: "pako-lateral-disposable", holdAtTarget: true });
    if (moving) {
      Object.assign(person, { road, heading: Math.PI / 2, walkSpeed: 1.2, walkRoute: [person.target],
        walkGoal: `${person.target.x},${person.target.z}`, walkPlanTick: 0, motionMode: "ambient" });
      Object.assign(person.district, { routeConstrained: true, yieldAtCurb: false });
    }
  }
  const bodies = [...world.actors];
  assert.ok([player, patrol].every(actor => bodyOnRoad(actor, [road])), "initial car bodies must fit the registered road");
  assert.ok(bodies.every(a => bodies.every(b => a === b || !overlaps(a, b))), "no initial overlaps may pre-create contact");
  world.actorIndex = new SpatialIndex(bodies);
  updatePursuitResponse(world, true);
  pursuit.gta.scanner = new PursuitScanner();
  pursuit.gta.scan = pursuit.gta.scanner.sample(world);
  const events = [], ticks = [], actions = [], impacts = [];
  const step = world.step.bind(world);
  world.step = () => {
    step();
    assert.ok(bodies.every(actor => world.actors.includes(actor)));
    const { impact } = pursuit.metrics;
    if (impact && impact.tick === world.tick) impacts.push(impact);
    ticks.push({ tick: world.tick, phase: pursuit.phase,
      ego: [player.x, player.z, player.heading, player.speed, player.gtaSlipMps, player.gtaYawRate, player.health],
      patrol: [patrol.x, patrol.z, patrol.heading, patrol.speed, patrol.distance, patrol.health],
      reason: patrol.reason, seen: pursuit.response.sightedBy.has(patrol), samePatrol: pursuit.patrols.has(patrol),
      person: person ? [person.x, person.z, person.speed] : null });
    events.push(...pursuit.stepEvents.filter(event => event.fresh &&
      ["patrol_collision", "static_or_civilian_hit", "ambient_collision"].includes(event.type)));
  };
  while (world.tick < windowTicks && pursuit.phase === "running") {
    const { info } = env.step(PURSUIT_STOP);
    actions.push({ tick: world.tick, requested: info.requestedAction, command: info.appliedCommand });
  }
  return { kind, profile, ticks, events, actions, impacts,
    tailM: patrol.distance, egoHealth: player.health, phase: pursuit.phase,
    firstYield: ticks.find(row => row.reason === "indirect-pedestrian-yield")?.tick ?? null,
    firstPatrol: events.find(event => event.type === "patrol_collision")?.tick ?? null,
    firstWalker: events.find(event => person && (event.actorId === person.id ||
      event.first?.id === person.id || event.second?.id === person.id))?.tick ?? null,
  };
}

const kinds = ["side", "far", "clear", "late", "moving-clear"];
const cases = kinds.map(kind => ({ kind, standard: run(kind, null), v1: run(kind, PATROL_CHAIN_YIELD),
  ...(baselineOnly ? {} : { lateral: run(kind, lateralProfile) }) }));
const [side, far, clear, late, moving] = cases;
const sameMotion = (first, second) => JSON.stringify(first.ticks) === JSON.stringify(second.ticks) &&
  JSON.stringify(first.events) === JSON.stringify(second.events);
const isSideChain = trial => trial.firstPatrol > 0 && trial.firstWalker > trial.firstPatrol &&
  trial.impacts.some(impact => impact.tick === trial.firstPatrol && ["right", "left"].includes(impact.side)) &&
  Math.abs(trial.ticks.find(row => row.tick === trial.firstPatrol).ego[4]) > .5 &&
  trial.actions.every(row => row.requested?.brake === 1 && row.command?.targetSpeed === 0 && row.command.decelerationMps2 > 0);
const observed = isSideChain(side.standard) && sameMotion(side.standard, side.v1);
const retained = !baselineOnly && [far, clear].every(item => sameMotion(item.standard, item.lateral)) &&
  late.lateral.firstPatrol > 0 && late.lateral.egoHealth < 100;
const protectedSide = !baselineOnly && side.lateral.firstYield > 0 &&
  side.lateral.firstYield < side.standard.firstPatrol && side.lateral.events.length === 0 &&
  side.lateral.tailM > .25 && side.lateral.ticks.length === windowTicks &&
  side.lateral.ticks.every(row => row.samePatrol && row.seen);
const movingClear = !baselineOnly && moving.lateral.firstYield > 0 && moving.lateral.firstWalker === null &&
  moving.lateral.ticks.length === windowTicks && moving.lateral.ticks.some(row =>
    row.tick > moving.lateral.firstYield && row.reason === "PURSUIT" && row.patrol[3] > .5 && row.person[0] > course.x + 2.7);
function repeatReplay() {
  const world = new World({ cityVersion: 4, seed: "pako-development-lateral-replay-01", traffic: 6, pedestrians: 16 }, "metro");
  world.command({ type: "street-pursuit-start", variant: "gta", level: 2,
    config: { ruleset: "dispatch-v1", patrolChainYield: lateralProfile } });
  const signature = state => JSON.stringify(state.actors.map(actor =>
    [actor.id, actor.x, actor.z, actor.heading, actor.speed, actor.gtaSlipMps, actor.reason, actor.health]));
  const poses = [];
  for (let i = 0; i < 180; i++) {
    if (i % 24 === 0) world.command({ type: "pursuit-drive",
      action: { steer: i >= 96 ? -.12 : 0, throttle: .65, brake: 0, gear: 1 } });
    world.step();
    poses.push(signature(world));
  }
  const replay = JSON.parse(JSON.stringify(world.replay()));
  assert.equal(replay.events[0].command.config.patrolChainYield, lateralProfile);
  const restored = World.reconstruct(replay, () => true);
  return poses.every(pose => pose === signature(restored.next().value));
}
if (!baselineOnly)
  assert.throws(() => resolveGtaChaseConfig({ ruleset: "legacy", patrolChainYield: lateralProfile }), /patrolChainYield/);
const replayParity = !baselineOnly && repeatReplay();
const report = { scope: "Staged, actor-intact City physics, not a learned escape or release gate",
  course, observed, retained, protectedSide, movingClear, replayParity,
  pass: observed && retained && protectedSide && movingClear && replayParity, cases };
if (output) writeFileSync(join(output, "lateral-contact.json"), JSON.stringify(report, null, 2), { flag: "wx" });
const summary = trial => ({ firstPatrol: trial.firstPatrol, firstWalker: trial.firstWalker, firstYield: trial.firstYield,
  windowTicks: trial.ticks.length, side: trial.impacts[0]?.side, tailM: trial.tailM });
console.log(JSON.stringify({ observed, retained, protectedSide, movingClear, replayParity, cases: cases.map(item =>
  Object.fromEntries(Object.entries(item).map(([name, trial]) => [name, name === "kind" ? trial : summary(trial)]))) }));
assert.ok(baselineOnly ? observed : report.pass, "The paired simulation did not establish physical lateral-chain protection");
