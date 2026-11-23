import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { STEP } from "../src/core/config.js";
import { bodyOnRoad, overlaps } from "../src/core/geometry.js";
import { PATROL_CHAIN_YIELD } from "../src/core/pako-patrol-yield.js";
import { resolveGtaChaseConfig } from "../src/core/pursuit-gta.js";
import { PURSUIT_STOP } from "../src/core/pursuit-controls.js";
import { updatePursuitResponse } from "../src/core/pursuit-response.js";
import { SpatialIndex } from "../src/core/spatial-index.js";
import { World } from "../src/core/world.js";
import { GtaPursuitEnv } from "../src/rl/gta-pursuit-env.js";
import { PursuitScanner } from "../src/signal_processing/pursuit-scanner.js";

const scope = { seed: 39217, ruleset: "dispatch-v1", maxActivePatrols: 1, wantedLevelMax: 1, enableRoadblocks: false };
const { seed, ...config } = scope;

function run(on, kind) {
  const env = new GtaPursuitEnv();
  env.reset({ seed, traffic: 0, pedestrians: Number(kind !== "clear"), shield: true,
    config: { ...config, ...(on ? { patrolChainYield: PATROL_CHAIN_YIELD } : {}) } });
  const world = env.world, { player, pursuit } = world, [tail] = pursuit.patrols;
  const person = world.actors.find(actor => actor.type === "pedestrian");
  const pose = { x: -275.3, z: -55, heading: 0, speed: 0, steer: 0, gtaSlipMps: 0, gtaYawRate: 0 };
  const gap = kind === "late" ? .35 : 2.05;
  Object.assign(player, pose, { previous: { ...player, ...pose } });
  const tailPose = { ...pose, z: pose.z - (player.length + tail.length) / 2 - gap, speed: kind === "late" ? 10 : 4.4 };
  Object.assign(tail, tailPose, { previous: { ...tail, ...tailPose, z: tailPose.z - tailPose.speed * STEP } });
  if (person) {
    Object.assign(person, { x: player.x + (kind === "off-path" ? 3.1 : kind === "edge" ? 1.37 : .18),
      z: player.z + player.length / 2 + person.radius + .39, speed: 0, pause: 5, walkRoute: null, crossing: false });
    person.target = { x: person.x, z: person.z };
    Object.assign(person.district, { caseId: "pako-chain-disposable", holdAtTarget: true });
  }
  const road = world.roads.find(road => road.id === "corniche-avenue");
  assert.ok([player, tail].every(actor => bodyOnRoad(actor, [road])));
  assert.ok(world.actors.every(a => world.actors.every(b => a === b || !overlaps(a, b))));
  const actors = [...world.actors];
  world.actorIndex = new SpatialIndex(world.actors);
  updatePursuitResponse(world, true);
  pursuit.gta.scanner = new PursuitScanner();
  pursuit.gta.scan = pursuit.gta.scanner.sample(world);
  const events = [], ticks = [];
  const step = world.step.bind(world);
  world.step = () => {
    step();
    const bumperGapM = player.z - tail.z - (player.length + tail.length) / 2;
    assert.ok(actors.every(actor => world.actors.includes(actor)));
    ticks.push({ tick: world.tick, player: [player.x, player.z, player.speed, player.health],
      tail: [tail.x, tail.z, tail.speed, tail.health], tailReason: tail.reason, blocker: tail.blockedBy,
      bumperGapM, samePatrol: pursuit.patrols.has(tail), seen: pursuit.response.sightedBy.has(tail),
      person: person ? [person.x, person.z, person.speed] : null });
    events.push(...pursuit.stepEvents.filter(event => event.fresh &&
      (event.type === "patrol_collision" || event.type === "static_or_civilian_hit" || event.type === "ambient_collision")));
  };
  const requested = kind === "drive-demand" ? { ...PURSUIT_STOP, throttle: .65, brake: 0 } : PURSUIT_STOP;
  const intervals = [];
  while (world.tick < 150 && pursuit.phase === "running") {
    const { info, reward } = env.step(requested);
    intervals.push({ tick: world.tick, requested, applied: info.appliedCommand, shield: info.shield, reward });
  }
  return { on, kind, ticks, intervals, events, distanceM: pursuit.metrics.distanceM,
    phase: pursuit.phase, tailM: tail.distance, egoHealth: player.health,
    firstYield: ticks.find(row => row.tailReason === "indirect-pedestrian-yield")?.tick ?? null,
    minimumGapM: Math.min(...ticks.map(row => row.bumperGapM)),
    freshEgoPatrol: events.find(event => event.type === "patrol_collision")?.tick ?? null,
    freshEgoPedestrian: events.find(event => event.kind === "pedestrian")?.tick ?? null };
}

function replayRoundtrip() {
  const world = new World({ seed: "pako-chain-replay-local", cityVersion: 4, traffic: 8, pedestrians: 18 }, "metro");
  world.command({ type: "street-pursuit-start", variant: "gta", level: 1, config: {
    ruleset: "dispatch-v1", patrolChainYield: PATROL_CHAIN_YIELD, maxActivePatrols: 3,
  } });
  const poses = value => JSON.stringify(value.actors.map(({ id, x, z, speed, reason }) => [id, x, z, speed, reason]));
  const expected = [];
  for (let tick = 0; tick < 180; tick++) {
    if (tick % 15 === 0) world.command({ type: "pursuit-drive",
      action: { steer: tick > 95 ? -.18 : 0, gear: 1, throttle: .7, brake: 0 } });
    world.step();
    expected.push(poses(world));
  }
  const recorded = JSON.parse(JSON.stringify(world.replay()));
  assert.equal(recorded.events[0].command.config.patrolChainYield, PATROL_CHAIN_YIELD);
  const replay = World.reconstruct(recorded, () => true);
  const accepted = expected.every(pose => poses(replay.next().value) === pose);
  return { accepted, ticks: expected.length, sha256: createHash("sha256").update(expected.join("\n")).digest("hex") };
}

const cases = ["danger", "drive-demand", "off-path", "edge", "clear", "late"].map(kind =>
  ({ kind, before: run(false, kind), after: run(true, kind) }));
const [close, demanding, offPath, edge, clear, late] = cases;
const replay = replayRoundtrip();
assert.throws(() => resolveGtaChaseConfig({ ruleset: "legacy", patrolChainYield: PATROL_CHAIN_YIELD }), /patrolChainYield/);
assert.throws(() => resolveGtaChaseConfig({ ruleset: "dispatch-v1", patrolChainYield: true }), /patrolChainYield/);
const matched = [offPath, edge, clear].every(({ before, after }) =>
  JSON.stringify(before.ticks) === JSON.stringify(after.ticks) && JSON.stringify(before.events) === JSON.stringify(after.events));
const physical = [close, demanding].every(({ before, after }) =>
  before.freshEgoPatrol > 0 && before.freshEgoPedestrian > before.freshEgoPatrol &&
  after.firstYield > 0 && after.firstYield < before.freshEgoPatrol && after.events.length === 0 &&
  after.tailM > .25 && after.minimumGapM > .32 && after.ticks.every(row => row.seen && row.samePatrol));
const contactPreserved = late.after.freshEgoPatrol > 0 && late.after.egoHealth < 100 && late.after.firstYield > 0;
const report = { scope, matched, physical, contactPreserved, replay, pass: matched && physical && contactPreserved && replay.accepted, cases };
const output = process.env.PROVE_IT_OUTPUT_DIR;
if (output) writeFileSync(join(output, "chain-safety.json"), JSON.stringify(report, null, 2), { flag: "wx" });
const summary = ({ firstYield, freshEgoPatrol, freshEgoPedestrian, minimumGapM, tailM, egoHealth }) =>
  ({ firstYield, freshEgoPatrol, freshEgoPedestrian, minimumGapM, tailM, egoHealth });
console.log(JSON.stringify({ matched, physical, contactPreserved, replay, cases: cases.map(({ kind, before, after }) =>
  ({ kind, before: summary(before), after: summary(after) })) }));
assert.ok(report.pass, "The real City did not prevent a feasible secondary impact while retaining the paired collision evidence");
