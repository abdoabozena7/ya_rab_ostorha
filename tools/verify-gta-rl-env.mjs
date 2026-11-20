import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { STEP } from "../src/core/config.js";
import { onRoadLimit } from "../src/core/district-behavior.js";
import { bodyOnRoad, distance, overlaps } from "../src/core/geometry.js";
import { gtaLocal, gtaOffset } from "../src/core/pursuit-gta.js";
import { updatePursuitResponse } from "../src/core/pursuit-response.js";
import { SpatialIndex } from "../src/core/spatial-index.js";
import { World } from "../src/core/world.js";
import { GtaPursuitEnv, GTA_OBSERVATION_SCHEMA as schema } from "../src/rl/gta-pursuit-env.js";

const SEED = "cairo-42";
const DRIVE = { steer: 0, throttle: 1, brake: 0, gear: 1 };
const BRAKE = { ...DRIVE, throttle: 0, brake: 1 };
const start = (w, config = {}, record = false) => w.command({ type: "street-pursuit-start", variant: "gta", config }, record);
const drive = (w, action = DRIVE, record = false) => w.command({ type: "pursuit-drive", action }, record);
const stop = w => w.command({ type: "street-pursuit-stop" }, false);
const clearCity = () => new World({ cityVersion: 4, seed: SEED, traffic: 0, pedestrians: 0 }, "metro");
const tick = (w, count) => { for (let i = 0; i < count; i++) w.step(); };
const patrols = w => [...w.pursuit.patrols];
const put = (car, ego, forward, right = 0, headingOffset = 0, speed = 0) =>
  Object.assign(car, gtaOffset(ego, forward, right), { heading: ego.heading + headingOffset, speed });
const watch = (w, count, eventType) => {
  for (let i = 0; i < count && w.pursuit.phase === "running"; i++) {
    w.step();
    const event = w.pursuit.stepEvents.find(entry => entry.type === eventType);
    if (event) return event;
  }
  assert.fail(`Missing ${eventType} in ${count} actual City ticks`);
};
const sameIdentities = (after, before) => after.length === before.length && after.every((body, i) => body === before[i]);
const finiteObs = obs => assert.ok(obs instanceof Float32Array && obs.length === 131 &&
  obs.length === schema.length && obs.every(value => Number.isFinite(value) && Math.abs(value) <= 1));

function deterministic(differentAction) {
  const config = { wantedLevelStart: 4, maxActivePatrols: 6, enableRoadblocks: false, playerMaxHealth: 1000 };
  const a = new GtaPursuitEnv(), b = new GtaPursuitEnv();
  const opts = { seed: SEED, config };
  const first = a.reset(opts);
  assert.deepEqual(first, b.reset(opts));
  assert.equal(first.info.phase, "running");
  assert.equal(first.info.tick, 0);
  assert.equal(a.world.mode, "manual");
  assert.equal(a.world.config.cityVersion, 4);
  assert.equal(a.world.environment, "metro");
  assert.equal(schema.source, "virtual/privileged simulation state");
  finiteObs(first.obs);
  for (let i = 0; i < 10; i++) {
    const expected = Math.fround(a.world.sensors.rays[i].rangeM / schema.scales.rayM);
    assert.equal(first.obs[schema.rays.offset + i], expected);
  }
  assert.ok(first.obs.subarray(schema.patrols.offset + 6 * schema.patrols.stride, schema.hazards.offset)
    .every(value => value === 0), "unused patrol slots are zero");
  const fsmStates = new Set();
  let reward = 0;
  for (let i = 0; i < 600; i++) {
    const segment = Math.floor(i / 100);
    const action = { steer: [0, .11, -.11, 0, 0, 0][segment],
      throttle: segment === 5 ? .4 : .9, brake: 0, gear: segment === 5 ? -1 : 1 };
    const x = a.step(action, 1), y = b.step(differentAction && i === 0 ? { ...DRIVE, gear: -1 } : action, 1);
    assert.deepEqual(x.obs, y.obs, `same-seed observations diverged on tick ${i + 1}`);
    assert.equal(x.reward, y.reward, `same-seed rewards diverged on tick ${i + 1}`);
    assert.deepEqual(x.info, y.info);
    finiteObs(x.obs);
    assert.ok(Number.isFinite(x.reward));
    assert.equal(x.info.tick, i + 1);
    assert.equal(x.terminated || x.truncated, false);
    for (const car of patrols(a.world)) fsmStates.add(car.aiState);
    reward += x.reward;
  }
  assert.ok(fsmStates.has("APPROACH") && fsmStates.has("FLANK") && fsmStates.has("BLOCK_INTERCEPT") && fsmStates.has("RAM"));
  assert.equal(a.world.replay().events.length, 0);
  assert.equal(b.world.replay().events.length, 0);
  return { deterministicTicks: a.world.tick, observationLength: first.obs.length, reward, fsmStates: [...fsmStates] };
}

function manualControl() {
  const w = clearCity(), { player } = w;
  const ordinaryMax = player.maxSpeed;
  w.command({ type: "destination", place: w.district.showcaseRoutes[0].goal }, false);
  assert.ok(player.path.length > 1 && player.parking && w.mode === "auto");
  start(w, { wantedLevelStart: 5, maxActivePatrols: 0 });
  assert.deepEqual(player.path, []);
  assert.equal(player.parking, null);
  assert.equal(w.mode, "manual");
  drive(w);
  tick(w, 320);
  const { limit, roadId } = onRoadLimit(w, player);
  assert.ok(Number.isFinite(limit) && player.speed > limit + 1);
  assert.equal(player.speed, w.pursuit.appliedCommand.targetSpeed);
  assert.equal(w.pursuit.appliedCommand.reason, null);
  const speed = player.speed;
  drive(w, { steer: -.4, throttle: 0, brake: .5, gear: 1 });
  tick(w, 1);
  assert.equal(w.pursuit.appliedCommand.steer, -.4 * player.spec.maxSteer);
  assert.ok(Math.abs((speed - player.speed) / STEP - 3.5) < 1e-8);
  stop(w);
  assert.equal(w.mode, "auto");
  assert.equal(player.maxSpeed, ordinaryMax);
  return { roadId, postedMps: limit, reachedMps: speed };
}

function sideContact(pitEnabled) {
  const w = clearCity(), { player } = w;
  start(w, { wantedLevelStart: 2, maxActivePatrols: 1, enablePitManeuver: pitEnabled });
  const [car] = patrols(w);
  put(car, player, -1.6, 2.85, -.39, 8);
  player.speed = 8;
  assert.equal(overlaps(car, player), false);
  updatePursuitResponse(w, true);
  drive(w);
  const event = watch(w, 24, "patrol_collision");
  assert.equal(event.isPit, pitEnabled);
  assert.ok(event.damageToPlayer > 0 && event.damageToPatrol > 0 && event.closingSpeed > .65);
  assert.equal(w.pursuit.phase, "running");
  const slip = player.gtaSlipMps, yaw = player.gtaYawRate;
  assert.ok(Math.abs(slip) > .25 && Math.abs(yaw) > .2 && player.speed > 5);
  const before = player.distance;
  tick(w, 15);
  assert.ok(player.distance > before + .5, "a side impact must not freeze the SUV");
  return { playerDamage: event.damageToPlayer, patrolDamage: event.damageToPatrol, slip, yaw, pit: event.isPit };
}

function nearMiss() {
  const w = clearCity(), { player } = w;
  start(w, { maxActivePatrols: 1 });
  const [car] = patrols(w);
  put(car, player, 7, 2.35);
  car.aiState = "ROADBLOCK";
  player.speed = 8;
  drive(w);
  const near = watch(w, 45, "near_miss");
  assert.equal(near.actorKind, "patrol");
  assert.ok(near.minDist > 0 && near.minDist <= .72);
  tick(w, 25);
  assert.equal(player.health, player.maxHealth);
  return near.minDist;
}

function wreckAndRecover() {
  const wreck = clearCity();
  start(wreck, { maxActivePatrols: 1, wreckSeconds: .2 });
  const [damaged] = patrols(wreck);
  put(damaged, wreck.player, 9, 0, Math.PI, 5);
  Object.assign(damaged, { health: 9 });
  wreck.player.speed = 10;
  updatePursuitResponse(wreck, true);
  drive(wreck);
  const lost = watch(wreck, 50, "patrol_wrecked");
  assert.equal(lost.causedByPlayer, true);
  assert.equal(damaged.aiState, "WRECKED");
  assert.equal(damaged.speed, 0);
  assert.ok(wreck.pursuit.stepEvents.some(event => event.type === "wanted_changed" && event.from === 1 && event.to === 2));
  const pose = { x: damaged.x, z: damaged.z };
  tick(wreck, 11);
  assert.ok(wreck.actors.includes(damaged) && distance(damaged, pose) === 0);
  tick(wreck, 2);
  assert.ok(!wreck.actors.includes(damaged) && !wreck.pursuit.patrols.has(damaged));

  const w = clearCity(), { player } = w;
  start(w, { maxActivePatrols: 2 });
  const [car, obstacle] = patrols(w);
  put(car, player, -18);
  put(obstacle, car, car.length / 2 + obstacle.length / 2 + .03);
  obstacle.aiState = "ROADBLOCK";
  updatePursuitResponse(w, true);
  let recoverTick;
  for (let i = 0; i < 120; i++) {
    w.step();
    if (car.aiState === "RECOVER") { recoverTick = w.tick; break; }
  }
  assert.ok(recoverTick > 84 && recoverTick <= 100);
  const startX = car.x;
  tick(w, 40);
  assert.equal(car.aiState, "RECOVER");
  assert.ok(car.speed < -.5 && car.x < startX - .2, "recover must actually reverse the patrol");
  const reverseTravel = startX - car.x;
  tick(w, 15);
  assert.equal(car.aiState, "PURSUIT");
  return { reverseTravel, recoverTick, wreckRemoved: !wreck.actors.includes(damaged) };
}

function sightAndTerminals() {
  const w = clearCity(), { player } = w;
  start(w, { maxActivePatrols: 1 });
  const [car] = patrols(w);
  put(car, player, 22);
  updatePursuitResponse(w);
  assert.ok(!w.pursuit.response.sightedBy.has(car), "outside the cone and proximity");
  car.heading += Math.PI;
  updatePursuitResponse(w);
  assert.ok(w.pursuit.response.sightedBy.has(car), "within cone on an open avenue");
  put(car, player, 12);
  updatePursuitResponse(w);
  assert.ok(w.pursuit.response.sightedBy.has(car), "close awareness works behind the patrol");
  w.statics.push({ ...gtaOffset(player, 6), id: "sight-test-solid", type: "static", width: 3, length: 1, heading: player.heading });
  w.staticIndex = new SpatialIndex(w.statics);
  updatePursuitResponse(w);
  assert.ok(!w.pursuit.response.sightedBy.has(car), "a solid occludes even proximity sight");

  const boxed = clearCity();
  start(boxed, { maxActivePatrols: 2 });
  const [front, back] = patrols(boxed);
  for (const unit of [front, back]) unit.aiState = "ROADBLOCK";
  put(front, boxed.player, 5.5);
  put(back, boxed.player, -20);
  tick(boxed, 132);
  assert.equal(boxed.pursuit.phase, "running", "one nearby unit cannot bust the player");
  put(back, boxed.player, -5.5);
  tick(boxed, 131);
  assert.equal(boxed.pursuit.phase, "running");
  assert.ok(boxed.pursuit.stepEvents.find(event => event.type === "pinned_progress").ratio < 1);
  tick(boxed, 1);
  assert.equal(boxed.pursuit.phase, "busted");
  assert.ok(boxed.pursuit.stepEvents.some(event => event.type === "pinned_progress" && event.ratio === 1));

  const env = new GtaPursuitEnv();
  env.reset({ config: { wantedLevelStart: 2, maxActivePatrols: 0 } });
  const escaped = env.step(BRAKE, 600);
  assert.ok(escaped.terminated && !escaped.truncated);
  assert.equal(escaped.info.tick, 468);
  assert.equal(escaped.info.phase, "escaped");
  assert.deepEqual(escaped.info.events.filter(event => event.type === "wanted_changed").map(e => [e.from, e.to]), [[2, 1], [1, 0]]);
  env.reset({ config: { maxActivePatrols: 0, episodeMaxSeconds: .17 } });
  assert.throws(() => env.step(DRIVE, 0), /actionRepeat/);
  assert.throws(() => env.step({ ...DRIVE, steer: 1.1 }), /normalized/);
  const timed = env.step(DRIVE, 60);
  assert.equal(timed.info.phase, "timeout");
  assert.equal(timed.info.tick, 11);
  assert.equal(timed.terminated, false);
  assert.equal(timed.truncated, true);
  assert.deepEqual(timed.info.requestedAction, DRIVE);
  assert.ok(timed.info.appliedCommand.targetSpeed > 0);
  assert.deepEqual(timed.info.events.map(event => event.tick), Array.from({ length: 11 }, (_, i) => i + 1));
  assert.equal(env.world.pursuit.stepEvents.length, 1);
  assert.throws(() => env.step(DRIVE), /Reset/);
  assert.equal(env.world.tick, 11);

  env.reset({ config: { wantedLevelStart: 3, playerMaxHealth: 5 } });
  const barrier = env.world.pursuit.gta.roadblock.barrier;
  put(env.world.player, barrier, -3.2, 0, 0, 15);
  const totaled = env.step(DRIVE, 30);
  assert.ok(totaled.terminated && !totaled.truncated);
  assert.equal(totaled.info.phase, "wrecked");
  assert.equal(totaled.info.playerHealth, 0);
  assert.ok(totaled.info.events.some(event => event.type === "static_or_civilian_hit" &&
    event.kind === "roadblock" && event.damageToPlayer > 0));
  assert.ok(totaled.reward < 0);
  for (const result of [escaped, timed, totaled]) finiteObs(result.obs);
  return { escapeTick: escaped.info.tick, bustedTick: boxed.tick, timeoutTick: timed.info.tick, wreckedTick: totaled.info.tick };
}

function squadAndCleanup() {
  const counts = [];
  for (const wantedLevelStart of [1, 2, 3, 4, 5]) {
    const w = clearCity(), ambient = w.actors.slice(), solids = w.statics.slice();
    start(w, { wantedLevelStart });
    const squad = patrols(w);
    counts.push(squad.length);
    assert.equal(new Set(squad.map(body => body.id)).size, squad.length);
    assert.ok(squad.every(unit => bodyOnRoad(unit, w.drivingRoads) && ![...ambient, ...solids].some(b => overlaps(b, unit))));
    assert.equal(squad.some(unit => unit.unitType === "interceptor"), wantedLevelStart >= 3);
    assert.equal(squad.some(unit => unit.unitType === "swat"), wantedLevelStart >= 4);
    const block = w.pursuit.gta.roadblock;
    if (wantedLevelStart >= 3) {
      const road = w.drivingRoads.find(road => road.id === block.barrier.roadId);
      assert.ok(road.width >= 12 && [2, 3].includes(block.cars.length));
      for (const body of [block.barrier, ...block.cars]) {
        assert.ok(bodyOnRoad(body, [road]) && distance(w.player, body) > 16 && gtaLocal(w.player, body).forward > 0);
      }
      assert.ok(w.pursuit.closures.has(block.barrier) && block.cars.every(car => w.pursuit.patrols.has(car)));
    } else assert.equal(block, null);
    tick(w, 31);
    assert.equal(squad.filter(car => car.squadRole === "PRIMARY_CHASER").length, 1);
    assert.deepEqual(squad.filter(car => car.squadRole === "FLANKER").map(car => car.squadSide).sort(), [-1, 1]);
    if (wantedLevelStart >= 3) assert.ok(squad.some(car => car.squadRole === "INTERCEPTOR"));
  }
  assert.deepEqual(counts, [3, 5, 7, 9, 12]);

  const hot = clearCity();
  start(hot, { maxActivePatrols: 1, wantedLevelMax: 2 });
  const [sentinel] = patrols(hot);
  put(sentinel, hot.player, 13);
  sentinel.aiState = "ROADBLOCK";
  updatePursuitResponse(hot, true);
  const hotter = watch(hot, 790, "wanted_changed");
  assert.ok(hotter.tick >= 780 && hotter.from === 1 && hotter.to === 2);

  const recycled = clearCity();
  recycled.player.x = -65;
  start(recycled, { wantedLevelStart: 4, maxActivePatrols: 1, npcSpeedMultiplier: .02, enableRoadblocks: false });
  const [old] = patrols(recycled);
  put(old, recycled.player, -105);
  updatePursuitResponse(recycled, true);
  tick(recycled, 360);
  assert.ok(recycled.actors.includes(old), "do not recycle early");
  tick(recycled, 2);
  const [replacement] = patrols(recycled);
  assert.ok(replacement !== old && !recycled.actors.includes(old) && gtaLocal(recycled.player, replacement).forward > 0);
  assert.ok(bodyOnRoad(replacement, recycled.drivingRoads) && recycled.actors.every(a => a === replacement || !overlaps(a, replacement)));

  const w = new World({ cityVersion: 4, seed: SEED }, "metro");
  const ambient = w.actors.slice(), originalStatics = w.statics, statics = originalStatics.slice();
  const ambientRng = w.rng.state;
  start(w, { wantedLevelStart: 5 });
  assert.equal(w.rng.state, ambientRng, "pursuit uses its own seeded stream");
  const owned = patrols(w), block = w.pursuit.gta.roadblock;
  assert.ok(ambient.some(body => body.type === "pedestrian") && owned.length > 0 && block);
  tick(w, 36);
  stop(w);
  assert.ok(sameIdentities(w.actors, ambient) && w.statics === originalStatics && sameIdentities(w.statics, statics));
  assert.ok(owned.every(a => !w.actors.includes(a)) && !w.statics.includes(block.barrier));
  start(w, { wantedLevelStart: 5, maxActivePatrols: 6, enableRoadblocks: false, enableSwat: false, enableRamming: false });
  assert.equal(patrols(w).length, 6);
  assert.ok(!w.pursuit.gta.roadblock && patrols(w).every(unit => unit.unitType !== "swat"));
  return { counts, timeEscalationTick: hotter.tick, recycledAhead: true, ambientPreserved: true,
    actorCount: ambient.length, staticCount: statics.length };
}

const results = deterministic(process.argv.includes("--different-action"));
results.manual = manualControl();
results.contact = sideContact(true);
assert.ok(Math.abs(sideContact(false).yaw) < Math.abs(results.contact.yaw), "PIT adds a distinct yaw shove");
results.nearMissM = nearMiss();
results.recover = wreckAndRecover();
results.terminals = sightAndTerminals();
results.cleanup = squadAndCleanup();

const replay = clearCity();
start(replay, { wantedLevelStart: 3 }, true);
drive(replay, DRIVE, true);
tick(replay, 24);
assert.deepEqual(World.fromReplay(replay.replay()).snapshot(), replay.snapshot());
results.replayTicks = replay.tick;
const output = process.env.PROVE_IT_OUTPUT_DIR;
if (output) await writeFile(join(output, "gta.json"), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
