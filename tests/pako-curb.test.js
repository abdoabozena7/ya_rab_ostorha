import assert from "node:assert/strict";
import test from "node:test";
import { Raycaster, Vector3 } from "three";
import { STEP } from "../src/core/config.js";
import { angleDelta, bodyOnRoad, corners, distance, overlaps } from "../src/core/geometry.js";
import { mountToWorld } from "../src/core/vehicle-spec.js";
import { World } from "../src/core/world.js";
import { WorldView } from "../src/render/world-view.js";

const VERSION = "metro-survey-v1";
const DEV_SEED = "pako-curb-local-dev";
const start = (config = {}) => ({
  type: "street-pursuit-start", variant: "gta",
  config: { ruleset: "dispatch-v1", maxActivePatrols: 0, enableRoadblocks: false, ...config },
});
const enabled = (config = {}) => start({ curbSupport: VERSION, ...config });
const makeCity = (traffic = 0, pedestrians = 0) =>
  new World({ cityVersion: 4, seed: DEV_SEED, traffic, pedestrians }, "metro");
const solid = (id, x, z, width, length, height) =>
  Object.freeze({ id, type: "static", kind: "barrier", x, z, width, length, height, heading: 0 });
// Test fixture only: a physical 13.65 m shutter terminating 0.35 m short of
// the surveyed asphalt edge. The real map and every normal solid stay put.
const shutter = () => solid("dev-road-shutter", -230, -112.175, 1, 13.65, 1.6);
const smooth = value => (1 - Math.cos(Math.PI * Math.max(0, Math.min(1, value)))) / 2;
const target = (x, offset = 5.16) =>
  -109.3 + offset * (smooth((x + 252) / 17) - smooth((x + 224) / 17));
function actionFor(player, { throttle, offset } = {}) {
  const z = target(player.x, offset);
  const slope = (target(player.x + .1, offset) - z) / .1;
  const heading = Math.PI / 2 - Math.atan((z - player.z) * .45 + slope);
  return {
    steer: Math.max(-.7, Math.min(.7, angleDelta(heading, player.heading) * 1.7)),
    throttle: throttle ?? (player.speed < 2.30 ? .8 : 0), brake: 0, gear: 1,
  };
}
const drive = (world, action, record = false) => {
  world.command({ type: "pursuit-drive", action }, record);
  world.step();
};
const bodySample = p => [p.x, p.z, p.y ?? 0, p.heading, p.speed, p.distance, p.curbSupportId ?? null, p.reason];
const proof = (context, data) => context.diagnostic(JSON.stringify(data));

test("real Metro SUV traverses the surveyed curb, passes the intact shutter, and returns; identical off controls do not", t => {
  const world = makeCity(2);
  const off = makeCity(2);
  const wall = shutter();
  world.statics.push(wall);
  off.statics.push(shutter());
  const roads = world.roads, driveRoads = world.drivingRoads, roadGeometry = structuredClone(roads);
  const original = [...world.actors], originalStatics = [...world.statics];
  const ordinaryPace = world.player.maxSpeed;
  const view = new WorldView(world);
  t.after(() => view.dispose());
  world.command(enabled());
  off.command(start());
  assert.equal(Object.hasOwn(off.pursuit.gta.config, "curbSupport"), false);
  assert.ok(bodyOnRoad(world.player, roads) && world.player.x === -254);
  const tape = [];
  const samples = [];
  let climb = 0, low = 0, curbPace = 0, wheelDelta = 0, bypass = null, biggestStep = 0;
  let entry = null, exit = null, offBoundary = null, wheelSurvey = null;
  for (let i = 0; i < 1300 && world.player.x < -210; i++) {
    const p = world.player;
    const before = { ...p };
    const action = actionFor(p);
    tape.push(action);
    drive(world, action);
    drive(off, action);
    biggestStep = Math.max(biggestStep, distance(before, p));
    const raised = p.y ?? 0;
    climb = Math.max(climb, raised);
    low = Math.min(low, raised);
    assert.equal(overlaps(p, wall), false);
    assert.equal(bodyOnRoad(off.player, off.roads), true);
    assert.ok(!(off.player.y ?? 0));
    if (off.player.reason === "road-boundary") offBoundary ??= [off.tick, ...bodySample(off.player)];
    if (p.curbSupportId) {
      assert.equal(bodyOnRoad(p, roads), false);
      assert.ok(corners(p).every(({ x, z }) => x >= -249 && x <= -206 && z <= -102.62));
      const pace = Math.hypot(p.speed, p.gtaSlipMps);
      assert.ok(pace <= 2.8 + 1e-8);
      curbPace = Math.max(curbPace, pace);
      const offsets = Object.values(p.vehicle.suspension.wheelOffsetsM);
      assert.ok(offsets.every(v => Math.abs(v) <= .07));
      wheelDelta = Math.max(wheelDelta, Math.max(...offsets) - Math.min(...offsets));
      entry ??= [world.tick, ...bodySample(p)];
      if (Math.abs(p.x - wall.x) < .03) bypass = [world.tick, ...bodySample(p)];
      assert.ok(Math.abs(mountToWorld(p, { x: 0, y: 1, z: 0 }).y - (1.12 + raised)) < 1e-12);
      if (!wheelSurvey && raised >= .01) {
        const root = view.syncMetroPlayer(1);
        assert.equal(root.position.y, .12 + p.y);
        const surfaces = [...view.surfaces.road, ...view.surfaces.pavement,
          view.egyptStreets.root.getObjectByName("egypt-painted-curb")];
        wheelSurvey = ["front-left", "front-right", "rear-left", "rear-right"].map(name => {
          const pivot = root.getObjectByName(`wheel-${name}`).getWorldPosition(new Vector3());
          const ray = new Raycaster(new Vector3(pivot.x, 2, pivot.z), new Vector3(0, -1, 0));
          const surface = ray.intersectObjects(surfaces, false)[0].point.y;
          const tire = pivot.y - .35;
          assert.ok(Math.abs(tire - surface) < .008, `${name} tire ${tire} vs rendered surface ${surface}`);
          return { name, tire, surface };
        });
        assert.ok(wheelSurvey.some(p => p.surface > .15));
      }
    } else if (entry) exit ??= [world.tick, ...bodySample(p)];
    if (world.tick % 240 === 0) samples.push([world.tick, ...bodySample(p)]);
  }
  assert.equal(world.pursuit.phase, "running");
  assert.ok(entry && bypass && exit && entry[0] < bypass[0] && bypass[0] < exit[0]);
  assert.ok(climb >= .01 && low < -.02 && wheelDelta > .025 && wheelSurvey);
  assert.ok(curbPace > 1 && biggestStep < 2.8 * STEP);
  assert.ok(world.player.x > -210 && world.player.distance > 44 && bodyOnRoad(world.player, roads));
  assert.equal(world.player.y, 0);
  assert.equal(world.player.supportHeightM, 0);
  assert.equal(world.pursuit.metrics.shoulderEntries, 1);
  assert.equal(world.pursuit.metrics.shoulderExits, 1);
  assert.equal(world.pursuit.metrics.collisions, 0);
  assert.ok(offBoundary && offBoundary[0] <= entry[0]);
  assert.ok(off.player.x < wall.x - 5 && off.player.distance < 14);
  assert.equal(off.pursuit.metrics.shoulderEntries, 0);
  world.command({ type: "street-pursuit-stop" });
  assert.equal(world.player.maxSpeed, ordinaryPace);
  const restoredRoot = view.syncMetroPlayer(1);
  assert.equal(restoredRoot.position.y, .12);
  assert.equal(restoredRoot.getObjectByName("wheel-front-left").position.y, .35);
  assert.equal(world.roads, roads);
  assert.equal(world.drivingRoads, driveRoads);
  assert.deepEqual(world.roads, roadGeometry);
  assert.ok(world.actors.length === original.length && original.every((actor, i) => world.actors[i] === actor));
  assert.ok(original.slice(1).every(actor => actor.distance > 40));
  assert.ok(world.statics.length === originalStatics.length && originalStatics.every((body, i) => world.statics[i] === body));
  proof(t, { entry, bypass, exit, climb, low, wheelDelta, curbPace, biggestStep, samples, wheelSurvey,
    offBoundary, off: bodySample(off.player), final: bodySample(world.player), trafficM: original.slice(1).map(p => p.distance) });

  // Production replay has no shutter-injection event. Exercise its real
  // command/reconstruction boundary on the original City without that fixture.
  const clean = makeCity(2);
  clean.command(enabled());
  const trajectory = tape.map(action => {
    drive(clean, action, true);
    return bodySample(clean.player);
  });
  clean.command({ type: "street-pursuit-stop" });
  const recorded = JSON.parse(JSON.stringify(clean.replay()));
  assert.equal(recorded.events[0].command.config.curbSupport, VERSION);
  assert.equal(clean.pursuit.metrics.shoulderEntries, 1);
  const replay = World.reconstruct(recorded, () => true);
  for (const expected of trajectory) {
    const step = replay.next();
    assert.equal(step.done, false);
    assert.deepEqual(bodySample(step.value.player), expected);
  }
  const finished = replay.next();
  assert.equal(finished.done, true);
  assert.equal(finished.value.pursuit.phase, "stopped");
  assert.deepEqual(finished.value.pursuit.metrics, clean.pursuit.metrics);
  proof(t, { deterministicReplayPoses: trajectory.length, replayFixture: "stock Metro, no injected shutter" });
});

test("a tall barrier inserted in the only shoulder corridor remains solid; insufficient clearance stays paved", t => {
  const tall = solid("dev-tall-shoulder-block", -233, -104.21, .6, 2.48, 2.2);
  for (const kind of ["tall", "unsupported-wheelbase", "outside-ribbon"]) {
    const world = makeCity();
    world.statics.push(shutter());
    if (kind === "tall") world.statics.push(tall);
    // Unsupported running gear is a deliberately invalid clearance witness,
    // not a replacement vehicle or a teleported ego pose.
    if (kind === "unsupported-wheelbase") world.player.spec = { ...world.player.spec, wheelbase: 2.9 };
    world.command(enabled());
    let rejected = null;
    for (let i = 0; i < 800; i++) {
      const p = world.player;
      drive(world, actionFor(p, { offset: kind === "outside-ribbon" ? 7.4 : 5.16 }));
      if (kind === "tall") assert.ok(!overlaps(p, tall));
      if (kind === "unsupported-wheelbase") assert.ok(bodyOnRoad(p, world.roads) && !(p.y ?? 0));
      if (p.reason === ({ tall: "curb-solid", "unsupported-wheelbase": "curb-clearance", "outside-ribbon": "road-boundary" })[kind])
        rejected ??= [world.tick, p.x, p.z, p.blockedBy];
    }
    assert.ok(rejected, kind);
    if (kind === "tall") {
      assert.equal(rejected[3], tall.id);
      assert.equal(world.statics.at(-1), tall);
      assert.ok(world.player.x < tall.x - 2);
    }
    if (kind === "outside-ribbon") assert.ok(Math.max(...corners(world.player).map(p => p.z)) <= -102.62);
    assert.equal(world.pursuit.metrics.collisions, 0);
    proof(t, { kind, rejected, final: bodySample(world.player) });
  }
});

test("yield to an actual occupied walkway, then return once its original pedestrian moves", t => {
  const world = makeCity(0, 17);
  const person = world.actors.find(p => p.id === "person-14");
  const wall = shutter();
  world.statics.push(wall);
  world.command({ type: "pedestrian-motion", mode: "stop", id: person.id });
  world.command(enabled());
  let yieldAt = null, lastHeldSpeed, firstResume = null;
  for (let i = 0; i < 1450 && world.player.x < -210; i++) {
    const p = world.player;
    if (i === 900) {
      lastHeldSpeed = p.speed;
      assert.ok(p.x < person.x - 2 && world.actors.includes(person));
      assert.equal(person.distance, 0);
      world.command({ type: "pedestrian-motion", mode: "jog", id: person.id });
    }
    drive(world, actionFor(p));
    assert.ok(!overlaps(p, person) && !overlaps(p, wall));
    if (p.reason === "curb-pedestrian" && !yieldAt) {
      assert.ok(!overlaps(p, person, .35));
      yieldAt = [world.tick, p.x, p.z, p.blockedBy];
    }
    if (i > 900 && p.speed > 1) firstResume ??= world.tick;
  }
  assert.equal(yieldAt?.[3], person.id);
  assert.ok(yieldAt[0] < 900 && lastHeldSpeed < .1 && firstResume > 900);
  assert.ok(person.distance > 6 && world.actors.includes(person) && world.statics.includes(wall));
  assert.ok(world.player.x > -210 && bodyOnRoad(world.player, world.roads));
  assert.equal(world.pursuit.metrics.pedestrianCollisions, 0);
  assert.equal(world.pursuit.metrics.collisions, 0);
  proof(t, { yieldAt, lastHeldSpeed, firstResume, pedestrianTravelM: person.distance, final: bodySample(world.player) });
});

test("only explicit Dispatch opts in; full throttle caps entry, reverse egress restores pavement and timeout waits for it", t => {
  const world = makeCity();
  for (const command of [start({ curbSupport: true }), start({ curbSupport: "unknown" }),
    start({ curbSupport: VERSION, ruleset: "legacy" }), { ...enabled(), variant: "arcade" }])
    assert.throws(() => world.command(command), /curbSupport/);
  assert.equal(world.pursuit, null);
  world.command(enabled({ episodeMaxSeconds: 5 }));
  let maxPace = 0, curbBraking = false, beforeReverse = null, reverseTravel = 0;
  for (let i = 0; i < 850 && world.pursuit.phase === "running"; i++) {
    const p = world.player;
    if (i === 325) {
      assert.ok(p.curbSupportId && world.pursuit.gta.curbExitPhase === "timeout");
      assert.throws(() => world.command({ type: "street-pursuit-stop" }), /return to the roadway/i);
      beforeReverse = bodySample(p);
    }
    drive(world, beforeReverse ? { steer: 0, gear: -1, throttle: p.speed > -1.7 ? .8 : 0, brake: 0 }
      : actionFor(p, { throttle: 1 }));
    if (p.reason === "curb-approach-speed") curbBraking = true;
    if (p.curbSupportId) {
      maxPace = Math.max(maxPace, Math.abs(p.speed));
      if (p.speed < 0) reverseTravel += distance(p.previous, p);
    }
  }
  assert.ok(curbBraking && maxPace > 2.7 && maxPace <= 2.8 + 1e-8);
  assert.ok(reverseTravel > 1 && world.player.x < beforeReverse[0] - 1 && world.player.speed < 0);
  assert.equal(world.pursuit.phase, "timeout");
  assert.equal(world.pursuit.gta.curbExitPhase, null);
  assert.equal(world.pursuit.metrics.shoulderExits, 1);
  assert.ok(bodyOnRoad(world.player, world.roads));
  assert.equal(world.player.y, 0);
  assert.equal(world.pursuit.metrics.collisions, 0);
  proof(t, { maxPace, beforeReverse, reverseTravel, timedOutAt: world.tick, final: bodySample(world.player) });
});
