import assert from "node:assert/strict";
import test from "node:test";
import { districtRoadPose } from "../src/core/egypt-district.js";
import { angleDelta } from "../src/core/geometry.js";
import { pursuitSnapshot } from "../src/core/pursuit-world.js";
import { PURSUIT_STOP } from "../src/core/pursuit-controls.js";
import { World } from "../src/core/world.js";

const DRIVE = Object.freeze({ steer: 0, throttle: 1, brake: 0, gear: 1 });
const drill = (caseId, seed = "cairo-42") => new World({
  pursuitVariant: "pack", pursuitCase: caseId, pursuitLevel: 3, seed, speedLimit: 48,
}, "pursuit");

function runLab(caseId, { learn, checkpoint } = {}) {
  const world = drill(caseId);
  world.command({ type: "pursuit-run", ...(learn ? { learn } : {}), ...(checkpoint ? { checkpoint } : {}) });
  return world;
}

function advance(world, limit, observe = () => {}) {
  for (let i = 0; i < limit && world.pursuit.phase === "running"; i++) {
    world.step();
    observe(world);
  }
}

function formation(world, earlier) {
  const { player, pursuit } = world;
  const distances = new Map(), sides = new Set();
  let closing = 0;
  for (const car of pursuit.patrols) {
    const dx = car.x - player.x, dz = car.z - player.z, gap = Math.hypot(dx, dz);
    distances.set(car.id, gap);
    if (gap > 22) continue;
    sides.add(Math.round(angleDelta(Math.atan2(dx, dz), player.heading) / (Math.PI / 2)) & 3);
    if (earlier?.get(car.id) - gap > .18) closing++;
  }
  return { sectors: sides.size, closing, distances };
}

function trackPack(world) {
  let best = { sectors: 0, closing: 0 };
  let previous = formation(world).distances;
  advance(world, 540, w => {
    if (w.tick % 9) return;
    const frame = formation(w, previous);
    previous = frame.distances;
    if (frame.closing >= 2 && frame.sectors > best.sectors) best = frame;
  });
  return best;
}

test("pack closes from three sides and its actual evasion steers continuously", context => {
  const lab = runLab("pack-dodge");
  assert.ok(trackPack(lab).sectors >= 3, "the Lab swarm must converge concurrently");
  const city = new World({ cityVersion: 4, seed: "cairo-42" }, "metro");
  city.command({ type: "street-pursuit-start", level: 3, variant: "pack" });
  assert.ok(trackPack(city).sectors >= 3, "the real City swarm must converge concurrently");
  assert.deepEqual(city.audit(), []);
  const backup = city.pursuit.events.filter(event => event.kind === "reinforcement");
  assert.ok(backup.every(event => (event.tick - city.pursuit.startedTick) % 180 === 0));

  const world = runLab("pack-dodge");
  world.command({ type: "mode", mode: "manual" });
  const start = { ...world.player };
  let previous = start, maxDelta = 0, lateralM = 0, heading = 0;
  world.command({ type: "pursuit-drive", action: { ...DRIVE, steer: .67 } });
  advance(world, 125, w => {
    const p = w.player;
    maxDelta = Math.max(maxDelta, Math.abs(p.steer - previous.steer));
    heading = Math.max(heading, Math.abs(angleDelta(p.heading, start.heading)));
    lateralM = Math.max(lateralM, Math.abs((p.x - start.x) * Math.cos(start.heading) -
      (p.z - start.z) * Math.sin(start.heading)));
    previous = { ...p };
  });
  context.diagnostic(JSON.stringify({ maxDelta, lateralM, heading, phase: world.pursuit.phase }));
  assert.ok(maxDelta <= .016 && lateralM >= 2.5 && heading >= Math.PI / 6);
});

test("pack learns measured contact and transfers frozen policy", context => {
  const touch = runLab("pack-touch", { learn: true });
  advance(touch, 340);
  const { metrics, learner, phase } = touch.pursuit;
  assert.equal(phase, "crashed");
  assert.equal(metrics.terminalCause, "police-touch");
  assert.equal(metrics.policeContacts, 1);
  assert.ok(metrics.impact.severity < .44 && metrics.impact.closingSpeedMps > 0);
  assert.ok(metrics.penalty <= -100 && learner.snapshot().lastReward <= -100);
  assert.ok(learner.snapshot().updates > 0);
  const checkpoint = learner.checkpoint();
  assert.ok(Object.values(checkpoint.q).some(row => row.some(value => value !== 0)));
  const replay = World.fromReplay(touch.replay());
  assert.deepEqual(pursuitSnapshot(replay), pursuitSnapshot(touch));
  assert.deepEqual(replay.pursuit.learner.checkpoint(), checkpoint);

  const city = new World({ cityVersion: 4, seed: "cairo-42" }, "metro");
  city.command({ type: "street-pursuit-start", level: 3, variant: "pack", checkpoint });
  advance(city, 200);
  assert.equal(city.pursuit.driver, "lab-policy");
  assert.deepEqual(city.pursuit.learner.checkpoint(), checkpoint);
  context.diagnostic(JSON.stringify({ touchSpeed: metrics.impact.closingSpeedMps, reward: learner.snapshot().lastReward,
    learn: learner.snapshot(), eval: city.pursuit.learner.snapshot() }));
});

test("pack yields, recovers and distinguishes a real pedestrian impact", context => {
  const safe = runLab("pack-crossing");
  const walker = safe.actors.find(a => a.type === "pedestrian");
  advance(safe, 520);
  assert.ok(safe.pursuit.metrics.firstYieldTick > 0);
  assert.ok(safe.pursuit.metrics.firstClearTick > safe.pursuit.metrics.firstYieldTick);
  assert.ok(safe.pursuit.metrics.distanceM > 10, "car must physically proceed, not just turn a HUD badge green");
  assert.equal(safe.pursuit.metrics.pedestrianCollisions, 0);
  assert.equal(safe.pursuit.metrics.penalty, 0);
  assert.equal(walker.impact, undefined);
  const hit = runLab("pack-person-impact", { learn: true });
  advance(hit, 135);
  const m = hit.pursuit.metrics;
  const struck = hit.actors.find(a => a.id === m.impact?.actorId);
  assert.equal(m.terminalCause, "pedestrian-impact");
  assert.equal(m.pedestrianCollisions, 1);
  assert.equal(struck?.impact?.tick, m.impact.tick);
  assert.equal(m.impact.closingSpeedMps, struck.impact.closingSpeedMps);
  assert.ok(m.penalty <= -220);
  assert.ok(hit.pursuit.learner.snapshot().lastReward <= -220);
  assert.deepEqual(hit.audit(), []);
  context.diagnostic(JSON.stringify({ safeYield: safe.pursuit.metrics.firstYieldTick,
    safeResumed: safe.pursuit.metrics.firstClearTick, impact: m.impact, reward: hit.pursuit.learner.snapshot().lastReward }));
});

test("pack Lab checkpoint and planner run matched City episodes on separate seeds", context => {
  let checkpoint;
  for (const [seed, caseId] of [["cairo-42", "pack-dodge"], ["pack-train-mirror", "pack-dodge"],
    ["cairo-42", "pack-touch"], ["cairo-42", "pack-person-impact"]]) {
    const lab = drill(caseId, seed);
    lab.command({ type: "pursuit-run", learn: true, ...(checkpoint ? { checkpoint } : {}) });
    advance(lab, 540);
    checkpoint = lab.pursuit.learner.checkpoint();
  }
  const evidence = [];
  for (const [seed, startRoad] of [["pack-eval-north", "tahrir-boulevard"], ["pack-eval-east", "civic-avenue"]]) {
    for (const useLab of [false, true]) {
      const city = new World({ cityVersion: 4, seed }, "metro");
      if (startRoad === "civic-avenue") {
        const road = city.drivingRoads.find(road => road.id === startRoad);
        Object.assign(city.player, districtRoadPose(road, -44), { speed: 5 });
      }
      assert.deepEqual(city.audit(), [], "Each matched arm must start in a physically clear pose");
      city.command({ type: "street-pursuit-start", level: 3, variant: "pack",
        ...(useLab ? { checkpoint } : {}) });
      advance(city, 540);
      const { phase, metrics: m, learner } = city.pursuit;
      if (useLab) assert.deepEqual(learner.checkpoint(), checkpoint);
      evidence.push({ seed, startRoad, driver: useLab ? "frozen" : "planner", phase,
        timeS: m.survivalS, distanceM: m.distanceM, policeContacts: m.policeContacts,
        personContacts: m.pedestrianCollisions, learning: learner?.snapshot() ?? null });
      assert.deepEqual(city.audit(), []);
    }
  }
  assert.ok(evidence.some(attempt => attempt.learning?.lookups > 0),
    "at least one matched City evaluation must actually consult learned values");
  context.diagnostic(JSON.stringify({ labUpdates: checkpoint.updates, evidence }));
});

test("pack old-behavior probe", context => {
  const previous = process.env.PACK_TEST_PREVIOUS === "1";
  const world = drill("pack-touch");
  if (previous) world.pursuit.variant = "arcade";
  world.command({ type: "mode", mode: "manual" });
  world.command({ type: "pursuit-drive", action: PURSUIT_STOP });
  world.command({ type: "pursuit-run" });
  const probe = [];
  advance(world, 300, w => {
    if (w.pursuit.metrics.impact && !probe.length) probe.push({
      tick: w.tick, phase: w.pursuit.phase, severity: w.pursuit.metrics.impact.severity,
      penalty: w.pursuit.metrics.penalty,
    });
  });
  context.diagnostic(JSON.stringify(probe));
  assert.ok(probe[0]?.severity < .44 && probe[0]?.phase === "crashed" && probe[0]?.penalty <= -100,
    "Previous chase cannot satisfy coordinated pack and hard-contact outcomes");
});

function facingOut(variant = "hunt", rearBlocked = false) {
  const city = new World({ cityVersion: 4, traffic: 0, pedestrians: rearBlocked === "person" ? 1 : 0 }, "metro");
  Object.assign(city.player, { x: -239, z: -116.2, heading: Math.PI });
  if (rearBlocked === "person") {
    const walker = city.actors.find(actor => actor.type === "pedestrian");
    Object.assign(walker, { x: -239, z: -112.7, speed: 0, motionMode: "stop" });
  } else if (rearBlocked) {
    city.statics = city.statics.concat({ id: "rear-block", type: "static", kind: "barrier",
      x: -239, z: -112.7, heading: 0, width: 7, length: .3, height: 1 });
    city.staticIndex = new city.staticIndex.constructor(city.statics);
  }
  city.command({ type: "street-pursuit-start", level: 3, variant });
  return city;
}

test("hunt backs out and turns on City pavement", context => {
  const city = facingOut(process.env.PURSUIT_HUNT_PREVIOUS === "1" ? "pack" : "hunt");
  let backedM = 0, forwardM = 0, turnRad = 0, prior = { ...city.player };
  advance(city, 248, w => {
    const car = w.player, moved = Math.hypot(car.x - prior.x, car.z - prior.z);
    if (car.speed < -.05) backedM += moved;
    if (backedM > 1.5 && car.speed > .05) forwardM += moved;
    turnRad = Math.max(turnRad, Math.abs(angleDelta(car.heading, Math.PI)));
    prior = { ...car };
  });
  context.diagnostic(JSON.stringify({ backedM, forwardM, turnRad, phase: city.pursuit.phase }));
  assert.ok(backedM >= 1.5 && forwardM >= 2 && turnRad >= Math.PI / 6,
    "A physically open reverse and turn must move the vehicle");
  assert.deepEqual(city.audit(), []);
  for (const obstacle of [true, "person"]) {
    const blocked = facingOut("hunt", obstacle);
    advance(blocked, 36, w => assert.notEqual(w.pursuit.decision.source, "escape-search"));
    assert.equal(blocked.pursuit.metrics.collisions, 0);
    assert.deepEqual(blocked.audit(), []);
  }
});

test("hunt patrols take distinct reachable approaches", context => {
  const city = new World({ cityVersion: 4, traffic: 0, pedestrians: 0 }, "metro");
  Object.assign(city.player, { x: -180.5, z: -114.5, heading: Math.PI });
  city.command({ type: "street-pursuit-start", level: 3, variant: "hunt" });
  const s = city.pursuit;
  const approaches = new Set(), movedBySector = new Map(), progress = new Map();
  advance(city, 360, w => {
    for (const car of s.patrols) {
      if (car.pursuitDrive.approach && car.distance >= 2) approaches.add(car.pursuitDrive.approach.roadId);
      if (Math.hypot(car.x - w.player.x, car.z - w.player.z) > 22 || car.distance < 2) continue;
      const bearing = Math.atan2(car.x - w.player.x, car.z - w.player.z);
      const sector = Math.round(bearing / (Math.PI / 2)) & 3;
      progress.set(car.id, car.distance);
      if (!movedBySector.has(sector)) movedBySector.set(sector, car.id);
    }
  });
  context.diagnostic(JSON.stringify({ roads: [...approaches], patrols: [...progress.keys()],
    sectors: [...movedBySector], reassignments: s.metrics.patrolReassignments }));
  assert.ok(approaches.size >= 2 && movedBySector.size >= 3 && progress.size >= 3);
  assert.ok(s.metrics.patrolReassignments > 0);
  assert.deepEqual(city.audit(), []);
});

function splitPursuit() {
  const city = new World({ cityVersion: 4, traffic: 0, pedestrians: 0 }, "metro");
  Object.assign(city.player, { x: -211, z: -109.3, heading: Math.PI / 2, speed: 13.33 });
  city.command({ type: "street-pursuit-start", level: 3, variant: "hunt" });
  const state = city.pursuit, patrol = [...state.patrols][0];
  for (const unit of state.patrols) {
    if (unit === patrol) continue;
    state.patrols.delete(unit);
    city.actors.splice(city.actors.indexOf(unit), 1);
  }
  Object.assign(patrol, { x: -268, z: -109.3, heading: Math.PI / 2, speed: 0, path: [], cursor: 0 });
  Object.assign(patrol.pursuitDrive, { nextPlan: 0, openingUntil: 0, launchUntil: 0 });
  city.command({ type: "mode", mode: "manual" });
  city.command({ type: "pursuit-drive", action: DRIVE });
  return { city, state, patrol };
}

test("hunt cools one star at a time and reacquisition stops cooldown", context => {
  const { city, state } = splitPursuit(), stars = [3], rounds = [];
  advance(city, 660, w => {
    if (stars.at(-1) !== state.wantedLevel) {
      stars.push(state.wantedLevel);
      rounds.push(w.tick);
      assert.equal(state.response.unitsInContact, 0);
    }
  });
  assert.deepEqual(stars, [3, 2, 1, 0]);
  assert.deepEqual(rounds.slice(1).map((tick, i) => tick - rounds[i]), [144, 144]);
  assert.equal(state.phase, "escaped");
  assert.equal(state.events.filter(event => event.kind === "reinforcement").length, 0);
  assert.deepEqual(city.audit(), []);

  const again = splitPursuit();
  advance(again.city, 180);
  assert.equal(again.state.response.stage, "clearing");
  const last = again.state.response.lastSeen;
  again.city.command({ type: "pursuit-drive", action: PURSUIT_STOP });
  let reacquired = false;
  advance(again.city, 143, w => {
    if (again.state.response.stage === "contact") {
      reacquired = true;
      assert.equal(again.state.response.clearProgress, 0);
      assert.ok(again.state.response.lastSeen.tick > last.tick);
    } else assert.equal(again.state.response.lastSeen, last);
  });
  assert.ok(reacquired, "the searching patrol can close distance on the stopped vehicle");
  assert.equal(again.state.wantedLevel, 3);
  context.diagnostic(JSON.stringify({ stars, rounds, reacquired }));
});

test("hunt starter and pedestrian cost follow accepted game outcomes", context => {
  const city = new World({ cityVersion: 4 }, "metro");
  city.command({ type: "street-pursuit-start", level: 3, variant: "hunt" });
  const startup = city.pursuit.learner.checkpoint();
  assert.ok(Object.values(startup.q).some(row => row.some(value => value !== 0)));
  assert.equal(startup.updates, 0);
  let changed = false;
  advance(city, 150, w => { changed ||= w.pursuit.decision.changed; });
  assert.ok(changed && city.pursuit.metrics.distanceM > 5);
  assert.deepEqual(city.pursuit.learner.checkpoint(), startup);

  function crossing(id, speed) {
    const lab = new World({ pursuitVariant: "hunt", pursuitCase: id, pursuitLevel: 3, speedLimit: 48 }, "pursuit");
    if (speed) lab.player.speed = speed;
    lab.command({ type: "pursuit-run", learn: true });
    advance(lab, 420);
    assert.deepEqual(lab.audit(), []);
    return lab.pursuit;
  }
  const safe = crossing("pack-crossing");
  assert.equal(safe.metrics.pedestrianCollisions, 0);
  assert.ok(safe.metrics.firstClearTick > safe.metrics.firstYieldTick && safe.metrics.distanceM > 10);
  assert.equal(safe.metrics.pedestrianCost, 0);
  assert.ok(safe.metrics.pedestrianDanger < .1, "braking and yielding should not accrue dangerous-approach cost");
  const slow = crossing("pack-person-impact"), fast = crossing("pack-person-impact", 8);
  for (const run of [slow, fast]) {
    assert.equal(run.metrics.pedestrianCollisions, 1);
    assert.equal(run.learner.snapshot().lastReward, -run.metrics.pedestrianCost);
  }
  assert.ok(fast.metrics.impact.closingSpeedMps > slow.metrics.impact.closingSpeedMps);
  assert.ok(fast.metrics.pedestrianCost > slow.metrics.pedestrianCost && slow.metrics.pedestrianCost > 240);
  context.diagnostic(JSON.stringify({ starterChanged: changed, safeDistanceM: safe.metrics.distanceM,
    slowCost: slow.metrics.pedestrianCost, fastCost: fast.metrics.pedestrianCost }));
});
