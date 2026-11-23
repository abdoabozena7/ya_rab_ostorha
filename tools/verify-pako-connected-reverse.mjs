import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { clamp } from "../src/core/config.js";
import { angleDelta, bodyOnRoad, overlaps } from "../src/core/geometry.js";
import { SpatialIndex } from "../src/core/spatial-index.js";
import { GtaPursuitEnv } from "../src/rl/gta-pursuit-env.js";
import { PursuitScanner } from "../src/signal_processing/pursuit-scanner.js";

function trial(scenario, evasion, cancel = false) {
  const env = new GtaPursuitEnv();
  const initial = env.reset({ seed: "pako-reverse-oracle", scenario, traffic: 0, pedestrians: 0, shield: true, evasion,
    config: { ruleset: "dispatch-v1", maxActivePatrols: 1, wantedLevelMax: 1, enableRoadblocks: false,
      enablePitManeuver: false, episodeMaxSeconds: 15 } });
  const { world } = env, { player, pursuit } = world, [patrol] = pursuit.patrols;
  const start = { x: player.x, z: player.z, heading: player.heading };
  const { roadId, exitRoadId, barrierId } = initial.info.scenario;
  const entry = world.drivingRoads.find(road => road.id === roadId);
  const exit = world.drivingRoads.find(road => road.id === exitRoadId);
  const barrier = world.statics.find(body => body.id === barrierId);
  // A closer front stop isolates the already-vetoed case; the existing L07 course is unchanged.
  barrier.x = start.x + 3.15;
  assert.ok(bodyOnRoad(barrier, [entry], 0) && !overlaps(player, barrier, .1));
  world.staticIndex = new SpatialIndex(world.statics);
  pursuit.gta.scanner = new PursuitScanner();
  pursuit.gta.scan = pursuit.gta.scanner.sample(world);
  let setbackM = 0, reverseYaw = 0, offRoad = 0, denied = 0, exitAt = null, rejections = 0;
  let cancelledAt = null;
  const trace = [], contacts = [], planNames = new Set();
  const physical = world.step.bind(world);
  world.step = () => {
    physical();
    denied += Number(pursuit.metrics.guard === "road-boundary");
    offRoad += Number(!bodyOnRoad(player, world.roads));
  };
  while (world.tick < 660 && pursuit.phase === "running") {
    const exitError = angleDelta(0, player.heading);
    if (cancel && setbackM > .22) cancelledAt ??= world.tick;
    const requested = cancelledAt !== null ? { gear: 1, throttle: 0, brake: 1, steer: 0 }
      : { gear: 1, throttle: .55, brake: 0, steer: Math.abs(exitError) < .35 ? clamp(.9 * exitError, -1, 1) : 0 };
    const { info } = env.step(requested);
    setbackM = Math.max(setbackM, start.x - player.x);
    if (player.speed < -.05) reverseYaw = Math.max(reverseYaw, Math.abs(angleDelta(player.heading, start.heading)));
    if (player.z - entry.fixed >= 8 && bodyOnRoad(player, [exit]) && player.speed > 0) exitAt ??= world.tick;
    assert.ok(pursuit.patrols.has(patrol) && world.statics.includes(barrier));
    contacts.push(...info.events.filter(e => (e.type === "static_or_civilian_hit" || e.type === "patrol_collision") && e.fresh));
    for (const candidate of info.planner?.candidates ?? []) {
      if (candidate.selected) planNames.add(candidate.name);
      if (!candidate.feasible && candidate.name.startsWith("reverse")) rejections++;
    }
    trace.push({ tick: world.tick, x: player.x, z: player.z, heading: player.heading, speed: player.speed,
      patrol: [patrol.x, patrol.z], requested, applied: info.appliedCommand, shield: info.shield, planner: info.planner });
  }
  return { scenario, evasion, tick: world.tick, phase: pursuit.phase, exitAt, exitM: player.z - entry.fixed,
    patrolM: patrol.distance, setbackM, reverseYaw, offRoad, denied, rejections, contacts,
    planNames: [...planNames], distanceM: player.distance, onExit: bodyOnRoad(player, [exit]), cancelledAt, trace };
}

const clear = trial("L07", true), blocked = trial("L07-blocked", true), guardOnly = trial("L07", false);
const cancelled = trial("L07", true, true);
const output = process.env.PROVE_IT_OUTPUT_DIR;
if (output) writeFileSync(join(output, "connected-reverse.json"), JSON.stringify({ clear, blocked, guardOnly, cancelled }, null, 2));
console.log(JSON.stringify([clear, blocked, guardOnly, cancelled].map(({ trace, ...row }) => row)));
assert.ok(clear.setbackM >= 5 && clear.reverseYaw >= 1.1 && clear.exitAt !== null &&
  clear.exitM >= 16 && clear.onExit && clear.patrolM >= 7 && clear.denied === 0 && clear.contacts.length === 0 &&
  clear.offRoad === 0 && ["reverse-straight", "reverse-turn", "reverse-settle"].every(name => clear.planNames.includes(name)),
"the selected reverse, steered recovery, and subsequent policy request must physically clear the branch");
for (const control of [blocked, guardOnly])
  assert.ok(control.exitAt === null && control.distanceM < .25 && control.contacts.length === 0 && !control.planNames.length);
assert.ok(cancelled.cancelledAt && cancelled.exitAt === null && cancelled.contacts.length === 0);
const after = cancelled.trace.filter(row => row.tick > cancelled.cancelledAt);
assert.equal(after[0].planner.reason, "PREDICTIVE_REVERSE_CANCELLED");
assert.ok(after.every(row => row.applied.targetSpeed === 0));
