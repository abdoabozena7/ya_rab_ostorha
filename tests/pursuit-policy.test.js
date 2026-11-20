import test from "node:test";
import assert from "node:assert/strict";
import { STEP } from "../src/core/config.js";
import { integrateVehicle, resolveVehicleContact } from "../src/core/vehicle.js";
import { distance, overlaps } from "../src/core/geometry.js";
import { PURSUIT_STOP, pursuitCommand, validatePursuitAction } from "../src/core/pursuit-controls.js";
import {
  decidePursuit, observePursuit, selectPursuitRoute, validatePursuitPolicy, PURSUIT_ACTIONS,
} from "../src/core/pursuit-policy.js";
import { createPackLearner, packCommand, PACK_PENALTIES, validatePackPolicy } from "../src/core/pack-driving.js";

const corridor = [{ axis: "z", fixed: 0, min: -50, max: 50, width: 30 }];
const car = (id, x, z, speed = 0) => ({
  id, x, z, heading: 0, type: "vehicle", width: 1.85, length: 4.2, speed, steer: 0, maxSpeed: 10,
});
const obstacle = (id, x, z, width, length, kind = "barrier") =>
  ({ id, x, z, width, length, type: "static", kind, heading: 0 });
const roadScene = (player, actors, statics = [], roads = corridor, exits = []) => ({
  player, actors: [player, ...actors], statics, roads, drivingRoads: roads, tick: 0, pursuit: { exits },
});
const sensed = (body, extra = {}) => ({ ...body, lateral: body.x, forward: body.z,
  rangeM: Math.hypot(body.x, body.z), vx: 0, vz: 0, motionKnown: true, ...extra });
const room = (ego = car("player", 0, 0), entities = [], support = corridor) => ({
  ego, entities, roads: support, drivingRoads: support, obstacles: [], unknown: [],
  exits: [{ id: "north", x: 0, z: 42 }],
});

test("ranging takes new motion samples on both sides and does not expose a hidden actor", () => {
  const ego = car("player", 0, 0);
  const left = car("left", -7, 0), rear = car("rear", 0, -9);
  const hidden = car("behind-wall", 0, 16);
  const scene = roadScene(ego, [left, rear, hidden], [obstacle("wall", 0, 7, 22, 1, "wall")]);
  const initial = observePursuit(scene);
  assert.deepEqual(initial.entities.filter(a => a.type === "vehicle").map(a => a.id), ["left", "rear"]);
  rear.z += .9;
  left.x += .3;
  scene.tick = 12;
  const reading = observePursuit(scene);
  assert.ok(Math.abs(reading.entities.find(x => x.id === "rear").vz - 4.5) < 1e-8);
  assert.ok(Math.abs(reading.entities.find(x => x.id === "left").vx - 1.5) < 1e-8);
  assert.ok(reading.entities.every(x => x.id !== hidden.id));
});

test("an occluded track resumes with a fresh position before it can establish motion again", () => {
  const ego = car("player", 0, 0), cross = car("crossing", -7, 9);
  const screen = obstacle("screen", 10, 4, 3, 1, "wall");
  const scene = roadScene(ego, [cross], [screen]);
  observePursuit(scene);
  scene.tick = 12;
  cross.x = -6;
  assert.ok(observePursuit(scene).entities.find(body => body.id === cross.id).motionKnown);
  screen.x = -2.7;
  scene.tick = 24;
  cross.x = -5;
  const hidden = observePursuit(scene);
  assert.equal(hidden.entities.some(body => body.id === cross.id), false);
  assert.equal(hidden.unknown[0].lastSeen.x, -6);
  screen.x = 10;
  scene.tick = 36;
  cross.x = -2.5;
  const reacquired = observePursuit(scene).entities.find(body => body.id === cross.id);
  assert.equal(reacquired.x, -2.5);
  assert.equal(reacquired.motionKnown, false);
  scene.tick = 48;
  cross.x = -1.5;
  assert.ok(observePursuit(scene).entities.find(body => body.id === cross.id).motionKnown);
});

test("the planner changes to a longer real path when the short passage is closed", () => {
  const streets = [
    { axis: "z", fixed: 0, min: -20, max: 42, width: 10 },
    { axis: "z", fixed: 18, min: -20, max: 42, width: 10 },
    { axis: "x", fixed: 0, min: 0, max: 18, width: 10 },
  ];
  const observed = { ...room(car("player", -1.65, -12), [], streets),
    exits: [{ id: "near", x: 0, z: 34 }, { id: "detour", x: 18, z: 40 }] };
  const direct = selectPursuitRoute(observed);
  assert.equal(direct.id, "near");
  const alternative = selectPursuitRoute({ ...observed, obstacles: [obstacle("closure", 0, 12, 10, 1)] });
  assert.equal(alternative.id, "detour");
  assert.ok(alternative.cost > direct.cost);
  assert.ok(alternative.path.some(point => point.x > 12));
});

test("a closing rear patrol leads to actual forward movement, not an idle reward", () => {
  const ego = car("player", 0, 0, 3.5);
  const rear = sensed(car("tail", 0, -9), { police: true, vz: 5.5 });
  const observation = room(ego, [rear]);
  const route = selectPursuitRoute(observation);
  const choice = decidePursuit(observation, route);
  assert.equal(choice.action.gear, 1);
  assert.ok(choice.action.throttle > 0 && choice.action.brake === 0);
  assert.ok(choice.threatSectors.includes("rear"));
  let pose = ego;
  for (let tick = 0; tick < 30; tick++)
    pose = integrateVehicle(pose, pursuitCommand(pose, choice.action), 1 / 60);
  assert.ok(pose.z > ego.z + 1.75);
});

test("the controller can pull away from a nonpenetrating rear contact", () => {
  const ego = car("player", 0, 0), other = sensed(car("rear-contact", 0, -4.25), { police: true });
  const observation = room(ego, [other]);
  const choice = decidePursuit(observation, selectPursuitRoute(observation));
  assert.equal(choice.action.gear, 1);
  assert.ok(choice.action.throttle > 0);
  const accepted = integrateVehicle(ego, pursuitCommand(ego, choice.action), 1 / 60);
  assert.ok(distance(accepted, other) > distance(ego, other));
});

test("the same adjacent gap admits a merge only when its follower is not closing", () => {
  const ego = car("player", 0, 0, 4.2);
  const lead = sensed(car("lead", 0, 8), { vz: 2 });
  for (const [side, maneuver] of [[-1, "left"], [1, "right"]]) {
    const follower = sensed(car("follower", side * 3.4, -5));
    const model = room(ego, [lead, follower]);
    const route = selectPursuitRoute(model);
    const gap = decidePursuit(model, route);
    assert.ok(gap.availableActions.includes(PURSUIT_ACTIONS.indexOf(maneuver)));
    const closing = decidePursuit({ ...model, entities: [lead, { ...follower, vz: 8 }] }, route);
    assert.ok(closing.rejected.some(result => result.action === maneuver && result.reason === "traffic"));
    assert.notEqual(closing.name, maneuver);
  }
});

test("an unsafe exit cannot be bought with a high learned value", () => {
  const narrow = [{ ...corridor[0], width: 3.3 }];
  const person = sensed({ id: "person", type: "pedestrian", x: 0, z: 2.65, radius: .38, heading: 0 });
  const barricade = obstacle("rear-wall", 0, -3.2, 3.3, .7);
  const observation = { ...room(car("player", 0, 0), [person], narrow), obstacles: [barricade] };
  const route = selectPursuitRoute(observation);
  const plain = decidePursuit(observation, route);
  const weights = validatePursuitPolicy({ schemaVersion: 2, algorithm: "tabular-q-learning",
    episodes: 1, actions: [...PURSUIT_ACTIONS], q: { [plain.key]: PURSUIT_ACTIONS.map((_, i) => i < 2 ? 1e4 : 0) } });
  const guarded = decidePursuit(observation, route, weights);
  assert.ok(guarded.rejected.some(action => action.action === "forward" && action.reason === "pedestrian"));
  assert.equal(guarded.action.throttle, 0);
  const next = integrateVehicle(observation.ego, pursuitCommand(observation.ego, PURSUIT_STOP), 1 / 60);
  assert.equal(distance(next, observation.ego), 0);
  assert.throws(() => validatePursuitAction({ ...PURSUIT_STOP, steer: 8 }), /normalized/);
});

const packRoom = (ego, entities = []) => ({ ...room(ego, entities), pack: true });
const advancePack = (ego, action, ticks, inspect = () => {}) => {
  let distanceM = 0;
  for (let tick = 0; tick < ticks; tick++) {
    const next = integrateVehicle(ego, packCommand(ego, action), STEP);
    distanceM += distance(ego, next);
    inspect(next, ego);
    ego = next;
  }
  return { ego, distanceM, survivalS: ticks * STEP };
};
const metrics = (overrides = {}) => ({
  distanceM: 0, survivalS: 0, collisions: 0, policeContacts: 0, pedestrianCollisions: 0, nearCollisions: 0,
  guard: "clear", ...overrides,
});

test("pack driving traces a physical arc, smoothly unwinds steer under brake and reaches reverse", t => {
  const ego = { ...car("player", 0, 0, 4.2), spec: { steerRate: 2.2 } };
  const turn = validatePursuitAction({ steer: .82, throttle: .55, brake: 0, gear: 1 });
  let maxSteerChange = 0, maxYawChange = 0;
  const inspect = (after, before) => {
    maxSteerChange = Math.max(maxSteerChange, Math.abs(after.steer - before.steer));
    maxYawChange = Math.max(maxYawChange, Math.abs(after.heading - before.heading));
  };
  const arc = advancePack(ego, turn, 72, (after, before) => {
    inspect(after, before);
    assert.ok(after.heading > before.heading);
    assert.ok(after.x > before.x);
  }).ego;
  assert.ok(arc.heading >= Math.PI / 6 && arc.x >= 2.5);
  const brake = { ...PURSUIT_STOP, steer: -.8, throttle: 1 };
  const braked = advancePack(arc, brake, 60, inspect).ego;
  assert.equal(braked.speed, 0);
  assert.ok(braked.steer < 0);
  const reverse = { steer: -.8, throttle: .8, brake: 0, gear: -1 };
  const backed = advancePack(braked, reverse, 36, inspect).ego;
  assert.ok(backed.speed < -.8);
  assert.ok(backed.heading > braked.heading, "opposite yaw under the same accepted wheel turn in reverse");
  assert.ok(maxSteerChange <= .016 && maxYawChange < .035);
  const fast = advancePack({ ...ego, maxSpeed: 10, speed: 10 }, turn, 40, inspect).ego;
  assert.ok(fast.steer > .08 && fast.steer < .15, "fast driving should keep a shallower curvature");
  t.diagnostic(JSON.stringify({ arcHeadingDeg: arc.heading * 180 / Math.PI, lateralM: arc.x,
    maxSteerChange, maxYawChange, reverseMps: backed.speed }));
});

test("pack learns accepted movement and imports a frozen checkpoint that changes a safe ranking", t => {
  const learner = createPackLearner("lab");
  const ego = car("player", 0, 0, 4.2);
  const observation = packRoom(ego);
  const route = selectPursuitRoute(observation);
  const planner = decidePursuit(observation, route);
  const forward = PURSUIT_ACTIONS.indexOf("forward");
  assert.notEqual(planner.index, forward);
  assert.ok(planner.availableActions.includes(forward));
  for (let round = 0; round < 28; round++) {
    const decision = decidePursuit(observation, route, learner.weights, () => forward);
    learner.record(decision, metrics());
    assert.equal(learner.snapshot().updates, round, "choosing a command does not learn from a future step");
    const after = advancePack(ego, decision.action, 12);
    const next = decidePursuit(packRoom(after.ego), route, learner.weights);
    learner.record(next, metrics(after));
    const trace = learner.snapshot().lastTransition;
    assert.equal(trace.key, decision.key);
    assert.equal(trace.action, "forward");
    assert.equal(trace.next, next.key);
    assert.ok(trace.deltas.distanceM > 0 && trace.reward > 0);
    learner.interrupt();
  }
  const checkpoint = JSON.parse(JSON.stringify(learner.checkpoint()));
  assert.ok(checkpoint.updates === 28 && checkpoint.q[planner.key][forward] > 0);
  assert.doesNotThrow(() => validatePackPolicy(checkpoint));
  const frozen = createPackLearner("city", checkpoint, false);
  const street = { ...observation, street: true };
  const city = decidePursuit(street, route, frozen.weights, frozen.choose);
  assert.equal(city.baselineIndex, planner.index);
  assert.equal(city.index, forward);
  assert.equal(city.learnedIndex, forward);
  assert.ok(city.rankChanged && city.changed && city.policyLookup);
  assert.equal(city.source, "learned-tactical");
  frozen.record(city, metrics());
  frozen.finish(metrics(advancePack(ego, city.action, 12)), "timeout");
  assert.deepEqual(frozen.checkpoint(), checkpoint);
  assert.equal(frozen.snapshot().lookups, 1);
  assert.equal(frozen.snapshot().changedDecisions, 1);
  assert.equal(frozen.snapshot().explored, 0);
  const originalQ = frozen.weights.q[city.key][forward];
  checkpoint.q[city.key][forward] = 100;
  assert.equal(frozen.weights.q[city.key][forward], originalQ);
  assert.throws(() => createPackLearner("bad", { ...checkpoint, actions: [...checkpoint.actions].reverse() }, false),
    /Unsupported pack policy/);
  delete checkpoint.q[city.key][forward];
  assert.throws(() => validatePackPolicy(checkpoint), /Invalid pack policy weights/);
  t.diagnostic(JSON.stringify({ key: city.key, updates: frozen.snapshot().updates, frozenQ: originalQ,
    baseline: PURSUIT_ACTIONS[city.baselineIndex], learned: city.name }));
});

test("observed compressing bearings are distinct and pack learning and exploration cannot buy an unsafe action", () => {
  const ego = car("player", 0, 0, 4.2);
  const patrols = [car("tail", 0, -11), car("left", -6, 0), car("right", 9, 0)]
    .map(patrol => ({ ...patrol, pursuitRole: "police" }));
  const scene = roadScene(ego, patrols, [], corridor, [{ id: "north", x: 0, z: 42 }]);
  scene.pursuit.variant = "pack";
  observePursuit(scene);
  scene.tick = 12;
  patrols[0].z += 1.2;
  patrols[1].x += .8;
  patrols[2].x -= .4;
  const observation = observePursuit(scene);
  assert.ok(observation.pack);
  const route = selectPursuitRoute(observation);
  const planner = decidePursuit(observation, route);
  assert.deepEqual(new Set(planner.packThreat.sectors), new Set(["left", "right", "rear"]));
  assert.deepEqual(new Set(planner.packThreat.closingSectors), new Set(["left", "right", "rear"]));
  const blocked = PURSUIT_ACTIONS.indexOf("left");
  assert.ok(planner.rejected.some(r => r.action === "left" && r.reason === "police"));
  const weights = { q: { [planner.key]: PURSUIT_ACTIONS.map((_, i) => i === blocked ? 4096 : 0) } };
  const chosen = decidePursuit(observation, route, weights, () => blocked);
  assert.equal(chosen.index, chosen.baselineIndex);
  assert.ok(chosen.policyLookup && !chosen.rankChanged);
  assert.ok(chosen.availableActions.includes(chosen.index));
  assert.ok(!chosen.availableActions.includes(blocked));
});

test("pack exact contact costs learn the measured soft rear touch and pedestrian impact after a forced hold", t => {
  const learner = createPackLearner("contact-drill");
  const still = car("player", 0, 0);
  const rear = car("soft-tail", 0, -4.207, .9);
  const walker = { id: "person", type: "pedestrian", x: 0, z: 2.52, radius: .38, heading: 0 };
  for (const [ego, other, police, cost, cause] of [
    [still, rear, true, PACK_PENALTIES.police, "police-contact"],
    [{ ...still, speed: 4.2 }, walker, false, PACK_PENALTIES.pedestrian, "pedestrian-impact"],
  ]) {
    const observation = packRoom(ego, [sensed(other, { police, vz: other.speed ?? 0 })]);
    const decision = decidePursuit(observation, selectPursuitRoute(observation), learner.weights,
      () => assert.fail("exploration must not run when every forecast is blocked"));
    assert.deepEqual(decision.availableActions, []);
    assert.ok(decision.forcedHold);
    assert.equal(decision.name, "hold");
    learner.record(decision, metrics());
    const proposed = integrateVehicle(ego, packCommand(ego, decision.action), STEP);
    const hit = police
      ? resolveVehicleContact(other, integrateVehicle(other, { steer: 0, targetSpeed: other.speed }, STEP), proposed)
      : resolveVehicleContact(ego, proposed, other);
    assert.ok(hit, "proposed fixed step should produce a physical contact, not a near miss");
    assert.ok(!overlaps(hit.body, police ? proposed : other), "contact must stop short of penetration");
    if (police) assert.ok(hit.closingSpeedMps > .2 && hit.closingSpeedMps < 1);
    learner.finish(metrics({ distanceM: police ? distance(ego, proposed) : distance(ego, hit.body),
      collisions: 1, policeContacts: police ? 1 : 0, pedestrianCollisions: police ? 0 : 1,
      survivalS: STEP, guard: "contact" }), "crashed");
    const transition = learner.snapshot().lastTransition;
    assert.ok(cost >= (police ? 100 : 220));
    assert.equal(transition.reward, -cost);
    assert.equal(transition.cause, cause);
    assert.equal(transition.next, null);
    assert.ok(transition.forcedHold && transition.qAfter < transition.qBefore);
    t.diagnostic(JSON.stringify({ cause, closingMps: hit.closingSpeedMps, reward: transition.reward,
      qAfter: transition.qAfter }));
  }
  const previous = learner.checkpoint();
  const rejected = decidePursuit(packRoom(still), null);
  learner.record({ ...rejected, availableActions: [] }, metrics());
  learner.finish(metrics({ policeContacts: 1, survivalS: STEP }), "crashed");
  assert.deepEqual(learner.checkpoint(), previous, "an unexecuted or unmarked decision is not a transition");
});
