import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { STEP, clamp } from "../src/core/config.js";
import { angleDelta, bodyOnRoad } from "../src/core/geometry.js";
import { GtaPursuitEnv } from "../src/rl/gta-pursuit-env.js";
import { PURSUIT_SCAN_TICKS } from "../src/signal_processing/pursuit-scanner.js";

const reset = {
  seed: "development-reverse", traffic: 0, pedestrians: 0, shield: true,
  config: { ruleset: "dispatch-v1", maxActivePatrols: 1, wantedLevelMax: 1,
    enableRoadblocks: false, enablePitManeuver: false, episodeMaxSeconds: 15 },
};
const TRIAL_TICKS = 660;
const FORWARD_THROTTLE = .55;
const contactKinds = new Set(["patrol_collision", "static_or_civilian_hit"]);

function odometry(body) {
  return { x: body.x, z: body.z, headingRad: body.heading, speedMps: body.speed, distanceM: body.distance };
}

function observe({ tick, rays, tracks }) {
  return { sampleTick: tick, front: rays[0], rear: rays[rays.length / 2],
    policeReturns: rays.filter(ray => ray.kind === "police").length,
    policeTracks: tracks.filter(track => track.kind === "police") };
}

function collider(body) {
  const { id, type, x, z, width, length, heading } = body;
  return { id, type, x, z, width, length, heading };
}

function run(scenario, forwardOnly = false) {
  const env = new GtaPursuitEnv();
  const { info } = env.reset({ ...reset, scenario });
  const world = env.world, { player, pursuit } = world, [patrol] = pursuit.patrols;
  const { roadId, exitRoadId, barrierId, rearBarrierId } = info.scenario;
  const avenue = world.drivingRoads.find(road => road.id === roadId);
  const exit = world.drivingRoads.find(road => road.id === exitRoadId);
  const front = world.statics.find(body => body.id === barrierId);
  const rear = world.statics.find(body => body.id === rearBarrierId);
  assert.ok(avenue?.axis === "x" && exit?.axis === "z" && front && patrol, "Incomplete Metro reverse reset");
  const initial = { ego: odometry(player), patrol: odometry(patrol), patrolId: patrol.id,
    front: collider(front), rear: rear ? collider(rear) : null, scan: observe(pursuit.gta.scan) };
  let stage = forwardOnly ? "forward-only" : "back-straight", reverseM = 0, reverseTurnRad = 0;
  let forwardM = 0, visiblePatrolM = 0, movingPoliceSamples = 0, reverseBrakes = 0;
  let offRoadSamples = 0, sameActivePatrol = info.activePatrols === 1;
  const trace = [], contactEvents = [];
  while (world.tick < TRIAL_TICKS && pursuit.phase === "running") {
    const tick = world.tick;
    const before = odometry(player), patrolBefore = patrol.distance;
    const northError = angleDelta(0, before.headingRad);
    if (stage === "back-straight" && before.x < initial.ego.x - 2.4) stage = "back-turn";
    if (stage === "back-turn" && Math.abs(northError) < .20) stage = "settle";
    if (stage === "settle" && before.speedMps === 0) stage = "exit";

    // Scripted fixture driver: only ego odometry and the public turn direction.
    // The production guard uses the scan; patrol state is evidence, not control input.
    const action = forwardOnly || stage === "exit"
      ? { gear: 1, steer: forwardOnly ? 0 : clamp(.9 * northError, -1, 1),
        throttle: FORWARD_THROTTLE, brake: 0 }
      : stage === "settle"
        ? { gear: -1, steer: 0, throttle: 0, brake: 1 }
        : { gear: -1, steer: Number(stage === "back-turn"), throttle: .65, brake: 0 };
    const scan = observe(pursuit.gta.scan);
    const step = env.step(action, PURSUIT_SCAN_TICKS);
    const { requestedAction, appliedCommand, shield, events, activePatrols } = step.info;
    const ego = odometry(player), police = odometry(patrol);
    const moved = ego.distanceM - before.distanceM;
    const along = (ego.x - before.x) * Math.sin(before.headingRad) +
      (ego.z - before.z) * Math.cos(before.headingRad);
    if (requestedAction.gear === -1 && appliedCommand?.targetSpeed < 0 && ego.speedMps < 0 && along < 0) {
      reverseM += moved;
      reverseTurnRad = Math.max(reverseTurnRad, Math.abs(angleDelta(ego.headingRad, initial.ego.headingRad)));
    }
    if (requestedAction.gear === 1 && appliedCommand?.targetSpeed > 0 && ego.speedMps > 0 && along > 0)
      forwardM += moved;
    if (requestedAction.gear === -1 && requestedAction.throttle > 0 && shield.interventions > 0 &&
        shield.reason === "static" && appliedCommand?.targetSpeed === 0 && appliedCommand.decelerationMps2 > 0)
      reverseBrakes++;

    const scanAfter = observe(pursuit.gta.scan);
    const patrolMoved = police.distanceM - patrolBefore;
    if (patrolMoved > 0 && scanAfter.policeReturns > 0 &&
        scanAfter.policeTracks.some(track => track.ageS === 0 && track.motionKnown)) {
      movingPoliceSamples++;
      visiblePatrolM += patrolMoved;
    }
    sameActivePatrol &&= activePatrols === 1 && pursuit.patrols.has(patrol);
    offRoadSamples += Number(!bodyOnRoad(player, world.drivingRoads));
    contactEvents.push(...events.filter(event => contactKinds.has(event.type)));
    trace.push({ tick, afterTick: world.tick, stage, scan, requestedAction,
      appliedLastTick: appliedCommand, shield, ego, patrol: police, activePatrols,
      egoContacts: pursuit.metrics.collisions, otherContacts: pursuit.metrics.trafficCollisions });
  }
  const { collisions, trafficCollisions, escape } = pursuit.metrics;
  return { scenario, roadId, exitRoadId, initial, ticks: world.tick, seconds: world.tick * STEP,
    contacts: collisions + trafficCollisions, egoContacts: collisions, otherContacts: trafficCollisions,
    contactEvents, reverseM, reverseTurnRad, forwardM, exitM: player.z - avenue.fixed,
    headingChangeRad: Math.abs(angleDelta(player.heading, initial.ego.headingRad)),
    onExitRoad: bodyOnRoad(player, [exit]), offRoadSamples,
    patrolM: patrol.distance - initial.patrol.distanceM, movingPoliceSamples, visiblePatrolM, sameActivePatrol,
    reverseBrakes, phase: pursuit.phase, escape, final: { ego: odometry(player), patrol: odometry(patrol),
      scan: observe(pursuit.gta.scan) }, trace };
}

const clear = run("L07"), blocked = run("L07-blocked"), forward = run("L07", true);
const arms = { clear, blocked, forward };
const report = { mode: "scripted local maneuver, not a Dispatch escape", reset, ...arms };
const output = process.env.PROVE_IT_OUTPUT_DIR;
if (output) await writeFile(join(output, "reverse-recovery.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify({
  ...report,
  ...Object.fromEntries(Object.entries(arms).map(([id, { trace, ...row }]) => [id, output ? row : {
    ...row, trace: trace.filter((frame, i) => i === 0 || i === trace.length - 1 ||
      frame.stage !== trace[i - 1].stage || frame.shield.reason !== trace[i - 1].shield.reason),
  }])),
}, null, 2));

for (const [id, row] of Object.entries(arms)) {
  assert.equal(row.ticks, TRIAL_TICKS, `${id}: all arms must exercise the same full physics window`);
  assert.ok(row.sameActivePatrol, `${id}: keep one live Dispatch patrol throughout`);
  assert.ok(row.phase === "running" && !row.escape, `${id}: a local test must not award a chase escape`);
  assert.deepEqual(row.initial.ego, clear.initial.ego, `${id}: paired ego reset`);
  assert.deepEqual([row.initial.patrolId, row.initial.patrol], [clear.initial.patrolId, clear.initial.patrol],
    `${id}: paired patrol reset`);
  assert.deepEqual(row.initial.front, clear.initial.front, `${id}: paired front barrier`);
  assert.equal(row.initial.scan.front.kind, "static", `${id}: front barrier must be observed`);
  assert.ok(Math.abs(row.initial.scan.front.rangeM -
    (row.initial.front.x - row.initial.front.length / 2 - row.initial.ego.x)) < 1e-6,
  `${id}: front observation must match the collider`);
}

assert.ok(!clear.initial.rear && clear.initial.scan.rear.kind === "none" &&
  !forward.initial.rear && forward.initial.scan.rear.kind === "none", "L07 must show rear clearance");
assert.ok(blocked.initial.rear?.type === "static" && blocked.initial.scan.rear.kind === "static" &&
  blocked.initial.scan.rear.rangeM < clear.initial.scan.rear.rangeM, "control must add an observed rear collider");
assert.ok(clear.contacts === 0 && clear.reverseM > 5 && clear.reverseTurnRad >= 1 &&
  clear.headingChangeRad >= 1 && clear.forwardM > 0 && clear.exitM > 16 && clear.onExitRoad &&
  clear.offRoadSamples === 0, "accepted reverse and turn must leave via Civic Avenue without contact");
assert.ok(clear.patrolM > 7 && clear.movingPoliceSamples > 0 && clear.visiblePatrolM > 0,
  "the clear arm needs actual moving police visible in the scan");
assert.ok(blocked.exitM < 6 && blocked.contacts === 0 && blocked.reverseBrakes > 0 &&
  Math.abs(blocked.final.ego.speedMps) < .02, "the rear-blocked attempt must brake, not exit or hit");
assert.ok(forward.exitM < 6 && forward.reverseM === 0 && forward.forwardM > 0,
  "the forward-only attempt must drive but not exit");
