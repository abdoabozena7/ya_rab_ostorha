import assert from "node:assert/strict";
import test from "node:test";
import { angleDelta, bodyOnRoad, distance, overlaps, roadRect } from "../src/core/geometry.js";
import { createPursuitState, stepPursuit } from "../src/core/pursuit-world.js";
import { World } from "../src/core/world.js";

const HOLD = { steer: 0, throttle: 0, brake: 1, gear: 1 };
const DRIVE = { steer: 0, throttle: 1, brake: 0, gear: 1 };
const CASES = [
  "short-route-open", "short-route-closes-or-becomes-risky", "rear-close-forward-clear",
  "rear-close-front-blocked-side-clear", "reverse-then-side", "incoming-left-or-right",
  "front-obstruction-with-rear-traffic", "pedestrian-priority-no-safe-exit",
  "legal-gap-and-rejected-cut", "curb-bypass-and-return", "boxed-in-multi-threat",
  "occluded-stale-and-recovery",
];
const MIRRORS = ["dev-physical=0", "dev-physical=1"];
const clamp = (x, min, max) => Math.min(max, Math.max(min, x));

function create(pursuitCase = "ambient", seed = MIRRORS[0], pursuitLevel = 1) {
  return new World({ pursuitCase, seed, pursuitLevel }, "pursuit");
}

function run(w, action = HOLD) {
  w.command({ type: "mode", mode: "manual" });
  w.command({ type: "pursuit-drive", action });
  w.command({ type: "pursuit-run" });
  return w;
}

function drive(w, action) {
  w.command({ type: "pursuit-drive", action }, false);
  w.step();
}

function repeat(w, count, onTick = () => {}) {
  for (let i = 0; i < count && w.pursuit.phase === "running"; i++) {
    w.step();
    assert.deepEqual(w.audit(), [], `tick ${w.tick}`);
    onTick();
  }
}

function poses(w) {
  return w.actors.map(({ id, type, pursuitRole, policeTactic, x, z, heading, speed }) =>
    ({ id, type, pursuitRole, policeTactic, x, z, heading, speed }));
}

test("the public World seam validates cases, creates clean independent seeded spawns and holds ready", () => {
  for (const pursuitLevel of [0, 5, 1.5, "2", null])
    assert.throws(() => createPursuitState({ pursuitLevel }), /level/);
  assert.throws(() => createPursuitState({ pursuitCase: "undocumented" }), /case/);
  for (const seed of MIRRORS) {
    for (const name of CASES) {
      const w = create(name, seed, 4);
      assert.deepEqual(w.audit(), [], name);
      assert.equal(w.snapshot().pursuit.caseId, name);
    }
  }
  for (const [level, police, cars, people] of [[1, 1, 3, 1], [2, 4, 5, 2], [3, 5, 7, 3], [4, 6, 9, 4]]) {
    for (let n = 0; n < 6; n++) {
      const w = create("ambient", `dev-world-spawns=${n}`, level);
      const patrol = w.actors.filter((a) => a.pursuitRole === "police");
      assert.equal(patrol.length, police);
      if (level > 1) {
        assert.deepEqual(new Set(patrol.map((a) => a.policeTactic)), new Set(["tail", "flank", "intercept"]));
        assert.ok(new Set(patrol.map((a) => a.heading)).size >= 3);
      }
      assert.equal(w.actors.filter((a) => a.pursuitRole === "civilian").length, cars);
      assert.deepEqual(w.capacity, { traffic: police + cars, pedestrians: people });
      assert.deepEqual(w.audit(), []);
      assert.ok(w.actors.filter((a) => a.type === "pedestrian").every((a) => a.radius === a.body.radiusM));
      assert.equal(w.mode, "auto");
      assert.strictEqual(w.statics, w.pursuit.statics);
      assert.strictEqual(w.roads, w.pursuit.roads);
      assert.ok(w.actorIndex.near(w.player, 0).includes(w.player));
    }
  }
  const first = create("ambient"), same = create("ambient"), alternate = create("ambient", MIRRORS[1]);
  assert.deepEqual(poses(first), poses(same));
  assert.notDeepEqual(poses(first), poses(alternate));
  assert.notEqual(first.roads[0], same.roads[0]);
  assert.notEqual(first.statics, same.statics);
  first.step();
  assert.equal(first.tick, 0);
  assert.equal(first.snapshot().pursuit.phase, "ready");
  assert.equal(first.snapshot().pursuit.action, null);
});

test("ambient street solids are indexed and sensed without encroaching on drivable space", () => {
  const w = create("ambient", "cairo-42", 4);
  const copy = create("ambient", "cairo-42", 4);
  const routeFixture = create("short-route-open", "cairo-42", 4);
  assert.deepEqual(w.statics, copy.statics);
  assert.notDeepEqual(w.statics, create("ambient", "dev-street-layout=0", 4).statics);
  assert.deepEqual(w.drivingRoads, routeFixture.drivingRoads);
  assert.deepEqual(w.graph, routeFixture.graph);
  const kinds = new Set(w.statics.map((s) => s.kind));
  assert.deepEqual(kinds, new Set(["building", "wall", "parked-vehicle"]));
  assert.equal(routeFixture.statics.length, 0);
  const paved = w.roads.map((road) => {
    const r = roadRect(road);
    return {
      x: (r.minX + r.maxX) / 2, z: (r.minZ + r.maxZ) / 2, heading: 0,
      width: r.maxX - r.minX, length: r.maxZ - r.minZ,
    };
  });
  for (const [i, solid] of w.statics.entries()) {
    assert.equal(solid.type, "static");
    assert.ok(w.staticIndex.near(solid, 0).includes(solid));
    assert.ok(paved.every((r) => !overlaps(solid, r, 0.5)), `${solid.id} obstructs a street`);
    assert.ok(w.statics.slice(i + 1).every((s) => !overlaps(solid, s)), `${solid.id} intersects another solid`);
  }
  assert.ok(w.sensors.rays.some((r) => w.statics.some((s) => s.id === r.hitId)));
  assert.deepEqual(w.audit(), []);
});

test("level-four patrols close in from connected roads after a genuine opening to move", () => {
  const seeds = ["cairo-42", ...Array.from({ length: 6 }, (_, i) => `dev-street-layout=${i}`)];
  let clearOpenings = 0;
  for (const seed of seeds) {
    const w = run(create("ambient", seed, 4), DRIVE);
    const egoStart = { x: w.player.x, z: w.player.z };
    const patrol = w.actors.filter((a) => a.pursuitRole === "police");
    assert.equal(patrol.length, 6);
    const ranges = patrol.map((a) => distance(a, egoStart));
    assert.ok(ranges.every((r) => r >= 15), `${seed} spawns a patrol at the player's doorstep`);
    assert.ok(patrol.filter((a) => Math.abs(a.x) > 12).length >= 4, `${seed} lacks side approaches`);
    repeat(w, 195);
    if (w.pursuit.phase === "running" && w.player.z - egoStart.z > 10 && !w.pursuit.metrics.collisions)
      clearOpenings++;
    assert.ok(patrol.filter((a, i) => distance(a, egoStart) < ranges[i] - 2).length >= 3, `${seed} patrols did not approach`);
  }
  assert.ok(clearOpenings >= 5, `only ${clearOpenings}/${seeds.length} contact-free opening drives`);
});

test("admitted steering, signed reverse and brake move the real plant, rig and sensor state", () => {
  const w = run(create("short-route-open"), { ...HOLD, steer: 1 });
  assert.throws(() => stepPursuit(w, { ...HOLD, gear: 0 }), /normalized/);
  assert.equal(w.tick, 0);
  const a = w.player, start = { ...a };
  repeat(w, 10);
  assert.equal(distance(a, start), 0);
  assert.ok(a.steer > 0.1, "stationary steering must reach the wheels");
  drive(w, HOLD);
  repeat(w, 47);
  assert.ok(Math.abs(a.steer) < 1e-8);
  drive(w, { ...DRIVE, gear: -1 });
  repeat(w, 29);
  assert.ok(a.z < start.z - 0.25);
  assert.ok(a.speed < -0.5);
  assert.ok(a.vehicle.wheelSpinRad < 0);
  assert.equal(a.vehicle.controls.gear, "R");
  assert.equal(a.previous.z > a.z, true);
  assert.equal(w.sensors.imu.speedMps, a.speed);
  drive(w, DRIVE);
  assert.ok(a.speed < 0, "direction changes cannot instantly reset signed speed");
  repeat(w, 90);
  assert.ok(a.speed > 2.5);
  assert.ok(w.player.distance > Math.abs(a.z - start.z));
  const snapshot = w.snapshot().pursuit;
  assert.equal(snapshot.metrics.distanceM, w.metrics.distance);
  assert.equal(snapshot.metrics.survivalS, w.tick / 60);
  assert.deepEqual(snapshot.action, DRIVE);
  snapshot.action.throttle = 0.3;
  assert.equal(w.snapshot().pursuit.action.throttle, 1);
});

test("identical inputs complete the open route but reach an actual nonpenetrating closure in the twin", () => {
  const open = run(create(CASES[0]), DRIVE), closed = run(create(CASES[1]), DRIVE);
  assert.deepEqual(poses(open), poses(closed));
  assert.deepEqual(open.statics, closed.statics);
  repeat(open, 800);
  repeat(closed, 800);
  assert.equal(open.pursuit.phase, "escaped");
  assert.equal(open.pursuit.metrics.escape, true);
  assert.ok(open.player.z > 51 && open.metrics.distance > 85);
  const c = closed.snapshot().pursuit;
  assert.equal(c.phase, "crashed");
  const event = c.events.find((e) => e.kind === "closure");
  const solid = closed.statics.find((s) => s.id === event.actorId);
  assert.equal(solid.kind, "barrier");
  assert.ok(event.tick > 120 && event.tick < 180);
  assert.equal(closed.staticIndex.near(solid, 0)[0], solid);
  assert.equal(c.metrics.collisions, 1);
  assert.ok(c.metrics.nearCollisions > 0);
  assert.equal(c.metrics.impact.actorId, solid.id);
  assert.equal(c.metrics.impact.side, "front");
  assert.ok(c.metrics.impact.closingSpeedMps > 7 && c.metrics.impact.energyJ > 40000);
  assert.equal(c.metrics.guard, "contact");
  assert.ok(Math.abs(solid.z - solid.length / 2 - closed.player.length / 2 - closed.player.z) < 0.002);
  assert.equal(overlaps(closed.player, solid), false);
  assert.equal(closed.player.speed, 0);
  assert.equal(closed.player.vehicle.damage.impactCount, 1);
  const finalTick = closed.tick;
  closed.step();
  assert.equal(closed.tick, finalTick);
});

test("police and civilians react to actual displacements and a seed controls physical events", () => {
  function sample(seed, action, steps, level = 1) {
    const w = run(create("ambient", seed, level), action);
    const initial = poses(w);
    const effects = { lostSpeed: false, lateralTravel: false, crossing: false, hadBarrier: false };
    const lanes = new Map(), congestion = new Map();
    repeat(w, steps, () => {
      for (const e of w.pursuit.events) {
        if (e.kind === "congestion" && w.tick === e.tick + 1)
          congestion.set(e.actorId, w.actors.find((a) => a.id === e.actorId).speed);
        if (e.kind === "closure" && w.tick === e.tick + 1)
          effects.hadBarrier ||= w.staticIndex.near(e, 0.1).some((b) => b.id === e.actorId && b.kind === "barrier");
      }
      for (const a of w.actors) {
        if (a.type === "pedestrian") {
          effects.crossing ||= a.crossing && Math.abs(a.x) < 2.1 && a.distance > 2;
        } else if (a.pursuitRole === "civilian") {
          effects.lostSpeed ||= congestion.has(a.id) && a.speed < congestion.get(a.id) - 0.6;
          if (a.pursuitDrive.laneBiasM) {
            if (!lanes.has(a)) lanes.set(a, { x: a.x, z: a.z, heading: a.heading });
            const before = lanes.get(a);
            const lateral = (a.x - before.x) * Math.cos(before.heading) - (a.z - before.z) * Math.sin(before.heading);
            effects.lateralTravel ||= Math.abs(lateral) > 0.7;
          } else lanes.delete(a);
        }
      }
    });
    return { w, initial, effects };
  }
  const seed = "dev-ambient-world=0";
  const { w, initial, effects } = sample(seed, HOLD, 950);
  assert.ok(effects.lostSpeed && effects.crossing && effects.hadBarrier);
  assert.ok(["closure", "roadblock", "congestion"].every((kind) => w.pursuit.events.some((e) => e.kind === kind)));
  const patrol = w.actors.filter((a) => a.pursuitRole === "police");
  assert.equal(patrol.length, 1);
  assert.ok(patrol[0].distance > 4);
  assert.equal(w.pursuit.metrics.impact.actorId, patrol[0].id);
  assert.equal(w.pursuit.metrics.impact.side, "rear");
  assert.equal(w.pursuit.metrics.escape, false);
  assert.notDeepEqual(poses(w), initial);
  const replay = sample(seed, HOLD, 950).w;
  assert.deepEqual(poses(w), poses(replay));
  assert.deepEqual(w.pursuit.events, replay.pursuit.events);
  const other = sample("dev-ambient-world=2", HOLD, 950).w;
  assert.notDeepEqual(
    w.pursuit.events.filter((e) => e.kind === "closure").map(({ tick, x, z }) => ({ tick, x, z })),
    other.pursuit.events.filter((e) => e.kind === "closure").map(({ tick, x, z }) => ({ tick, x, z })),
  );
  const mixed = sample(seed, HOLD, 950, 2);
  assert.ok(mixed.effects.lateralTravel, "mixed traffic should accept a real lane change");
  assert.ok(mixed.w.actors.filter((a) => a.pursuitRole === "police" && a.distance > 4).length >= 3);
  const moving = sample(seed, DRIVE, 100, 2).w;
  const holding = sample(seed, HOLD, 100, 2).w;
  assert.ok(distance(moving.player, holding.player) > 2);
  assert.ok(moving.actors.filter((a) => a.pursuitRole === "police").some((a) =>
    distance(a.pursuitDrive.target, holding.actors.find((b) => b.id === a.id).pursuitDrive.target) > 1));
});

test("a held car really receives rear and mirrored lateral impacts, while a person contact crashes", () => {
  for (const [seed, side] of [[MIRRORS[0], "right"], [MIRRORS[1], "left"]]) {
    const w = run(create("incoming-left-or-right", seed));
    repeat(w, 190);
    const { metrics: m } = w.snapshot().pursuit;
    assert.equal(m.impact.side, side);
    assert.equal(m.impact.actorId, "police-flank-1");
    assert.ok(m.impact.closingSpeedMps > 2 && m.impact.energyJ > 0);
    assert.equal(m.collisions, 1, "sticky contact is not repeatedly counted");
    assert.equal(m.escape, false);
  }
  const held = run(create("pedestrian-priority-no-safe-exit"));
  repeat(held, 190);
  assert.equal(held.pursuit.metrics.impact.side, "rear");
  assert.equal(held.pursuit.metrics.pedestrianCollisions, 0);
  assert.equal(held.pursuit.metrics.distanceM, 0);
  assert.equal(held.pursuit.metrics.escape, false);
  const driven = run(create("pedestrian-priority-no-safe-exit"), DRIVE);
  repeat(driven, 180);
  assert.equal(driven.pursuit.phase, "crashed");
  assert.equal(driven.pursuit.metrics.pedestrianCollisions, 1);
  assert.equal(driven.pursuit.metrics.impact.actorId, "walker-crossing");
  assert.equal(driven.pursuit.metrics.impact.side, "front");
});

function rearContact(seed) {
  const w = run(create("rear-close-forward-clear", seed));
  const tail = w.actors.find((a) => a.policeTactic === "tail");
  for (let i = 0; i < 150 && !w.pursuit.metrics.impact; i++) repeat(w, 1);
  const impact = w.snapshot().pursuit.metrics.impact;
  assert.equal(impact?.side, "rear");
  assert.equal(impact.actorId, tail.id);
  assert.ok(impact.closingSpeedMps > 1);
  assert.equal(tail.speed, 0);
  assert.equal(w.player.speed, 0);
  return { w, tail, impact };
}

test("a lone rear patrol leaves measured bumper space after a hit, then reacquires", () => {
  for (const seed of MIRRORS) {
    const { w, tail, impact } = rearContact(seed);
    const atContact = { x: tail.x, z: tail.z };
    const playerAtContact = { x: w.player.x, z: w.player.z };
    let minSpeed = 0;
    repeat(w, 210, () => { minSpeed = Math.min(minSpeed, tail.speed); });
    assert.ok(minSpeed < -0.75, "the patrol must actually reverse");
    assert.ok(atContact.z - tail.z > 0.9 && atContact.z - tail.z < 1.7);
    assert.ok(!overlaps(w.player, tail, 0.8), "positive space while the ego remains held");
    assert.equal(distance(w.player, playerAtContact), 0);
    assert.equal(w.pursuit.metrics.collisions, 1);
    assert.deepEqual(w.pursuit.metrics.impact, impact);
    assert.equal(w.pursuit.events.filter((e) => e.kind === "impact").length, 1);
    drive(w, DRIVE);
    repeat(w, 180);
    assert.ok(w.player.z - playerAtContact.z > 8);
    assert.ok(tail.z > atContact.z + 2 && tail.speed > 1);
    assert.equal(w.pursuit.metrics.collisions, 1);
  }
});

test("an occupied rear sweep prevents backing without pinning a car moving away", () => {
  const { w, tail } = rearContact(MIRRORS[0]);
  const x = tail.x, z = tail.z, egoZ = w.player.z;
  const solid = {
    id: "retreat-negative-control", type: "static", kind: "barrier", height: 1,
    x, z: z - tail.length / 2 - 0.5, width: 3, length: 0.4, heading: 0,
  };
  w.statics.push(solid);
  w.staticIndex.add(solid);
  repeat(w, 150, () => { assert.ok(tail.z >= z - 0.002); });
  assert.ok(!overlaps(tail, solid));
  assert.equal(w.pursuit.metrics.collisions, 1);
  assert.equal(w.pursuit.metrics.trafficCollisions, 0);
  drive(w, { ...DRIVE, throttle: 0.3 });
  repeat(w, 165);
  assert.ok(w.player.z - egoZ > 2);
  assert.equal(w.pursuit.metrics.collisions, 1);
});

test("bounded phases distinguish a surrounded capture and an idle timeout from an escape", () => {
  const boxed = run(create("boxed-in-multi-threat", "dev-world-1"), DRIVE);
  repeat(boxed, 420);
  assert.equal(boxed.pursuit.phase, "captured");
  assert.equal(boxed.pursuit.metrics.escape, false);
  assert.ok(boxed.pursuit.metrics.capturePressureS >= 2.1);
  for (const seed of MIRRORS) {
    const held = run(create("boxed-in-multi-threat", seed));
    const tail = held.actors.find((a) => a.policeTactic === "tail");
    repeat(held, 420, () => { assert.ok(tail.speed >= 0, "nearby patrols keep pressure"); });
    assert.equal(held.pursuit.phase, "captured");
    assert.equal(held.pursuit.metrics.impact.actorId, tail.id);
  }
  const still = run(create("short-route-open"));
  repeat(still, 2400);
  assert.equal(still.pursuit.phase, "timeout");
  assert.equal(still.pursuit.metrics.distanceM, 0);
  assert.equal(still.pursuit.metrics.escape, false);
  assert.equal(still.pursuit.metrics.collisions, 0);
});

function curbTestDriver(w) {
  const a = w.player;
  const side = Math.sign(w.pursuit.playerStart.x), lookahead = 3.8, z = a.z + lookahead;
  const ease = (n) => { const t = clamp(n, 0, 1); return t * t * (3 - 2 * t); };
  const aim = side * (1.3 + 3.89 * ease((z + 22) / 13)) * (1 - ease((z - 5) / 12));
  const turn = angleDelta(Math.atan2(aim - a.x, lookahead), a.heading);
  const brake = a.speed > 3.1 ? 0.25 : 0;
  return { steer: clamp(turn * 1.35 / 0.62, -1, 1), throttle: a.speed < 3 ? 0.85 : 0, brake, gear: 1 };
}

test("the whole vehicle traverses the actual raised shoulder and rejoins, not through an occupied shoulder", () => {
  for (const seed of MIRRORS) {
    const w = run(create("curb-bypass-and-return", seed));
    const raised = w.roads.find((r) => r.pursuitShoulder);
    assert.equal(w.drivingRoads.includes(raised), false);
    let shouldersOnly = false;
    for (let n = 0; n < 1100 && w.pursuit.phase === "running"; n++) {
      drive(w, curbTestDriver(w));
      assert.deepEqual(w.audit(), []);
      assert.equal(w.player.y, w.player.supportHeightM);
      assert.ok(w.player.y >= 0 && w.player.y <= raised.supportHeightM);
      if (Math.abs(w.player.z) < 0.6) {
        assert.ok(w.player.y > 0.12);
        shouldersOnly ||= !bodyOnRoad(w.player, w.drivingRoads);
      }
    }
    const m = w.pursuit.metrics;
    assert.equal(w.pursuit.phase, "escaped");
    assert.ok(shouldersOnly && Math.abs(w.player.x) < 0.3 && w.player.z > 22);
    assert.equal(m.collisions, 0);
    assert.equal(m.shoulderEntries, 1);
    assert.equal(m.shoulderExits, 1);
    assert.equal(m.supportHeightM, 0);
  }
  const blocked = create("curb-bypass-and-return");
  const raised = blocked.roads.find((r) => r.pursuitShoulder);
  blocked.statics.push({
    id: "shoulder-negative-control", kind: "barrier", type: "static",
    x: raised.fixed, z: -5, width: 2.2, length: 0.8, heading: 0, height: 1,
  });
  run(blocked);
  for (let n = 0; n < 600 && blocked.pursuit.phase === "running"; n++) {
    drive(blocked, curbTestDriver(blocked));
    assert.deepEqual(blocked.audit(), []);
  }
  assert.equal(blocked.pursuit.metrics.escape, false);
  assert.equal(blocked.pursuit.metrics.impact.actorId, "shoulder-negative-control");
  assert.ok(blocked.player.z < -7);
});

test("signed reverse reaches the connector and then a real mirrored exit", () => {
  for (const seed of MIRRORS) {
    const w = run(create("reverse-then-side", seed));
    const side = Math.sign(w.pursuit.exits[0].x);
    let stage = "backing", mostReverse = 0, forwardBlocked = false;
    const deadEnd = run(create("reverse-then-side", seed), DRIVE);
    repeat(deadEnd, 80);
    forwardBlocked = deadEnd.pursuit.metrics.impact?.actorId === "pursuit-bay-end";
    assert.equal(forwardBlocked, true);
    for (let n = 0; n < 750 && w.pursuit.phase === "running"; n++) {
      const a = w.player, action = { ...DRIVE };
      if (stage === "backing" && a.z < -10.15) stage = "braking";
      if (stage === "braking" && a.speed === 0) stage = "turning";
      if (stage === "backing") action.gear = -1;
      if (stage === "braking") Object.assign(action, { brake: 1, throttle: 0, steer: side });
      if (stage === "turning") {
        action.steer = clamp(angleDelta(side * Math.PI / 2, a.heading) * 2.5, -1, 1);
        if (a.speed > 3.5) action.throttle = 0;
        if (Math.abs(angleDelta(side * Math.PI / 2, a.heading)) < 0.17) stage = "outbound";
      }
      if (stage === "outbound")
        action.steer = clamp(angleDelta(Math.atan2(side * 6, -9 - a.z), a.heading) * 1.6, -1, 1);
      drive(w, action);
      assert.deepEqual(w.audit(), []);
      mostReverse = Math.min(mostReverse, a.speed);
    }
    assert.equal(w.pursuit.phase, "escaped");
    assert.equal(w.pursuit.metrics.collisions, 0);
    assert.ok(mostReverse < -2 && side * w.player.x > 27 && Math.abs(w.player.z + 9) < 1);
  }
});
