import test from "node:test";
import assert from "node:assert/strict";
import { VISION_CASES, createVisionScenario, advanceVisionActor } from "../src/core/vision-scenarios.js";
import { VisualCrossingPredictor } from "../src/core/visual-prediction.js";
import { World } from "../src/core/world.js";

const near = (a, b, epsilon = 1e-7) =>
  assert.ok(Math.abs(a - b) <= epsilon, `${a} differs from ${b}`);
function run(caseId, durationS) {
  const scenario = createVisionScenario(caseId);
  let actor = scenario.people[0];
  const positions = [];
  for (let tick = 0; tick < durationS * 60; tick++) {
    const before = actor;
    actor = advanceVisionActor(actor, 1 / 60, { simulationTimeS: tick / 60 });
    const travel = Math.hypot(actor.x - before.x, actor.z - before.z);
    assert.ok(travel <= 0.9 / 60 + 1e-8);
    assert.ok(actor.speed <= 0.9 + 1e-8);
    positions.push({ x: actor.x, z: actor.z });
  }
  return { scenario, actor, positions };
}

test("five public definitions have the exact standalone shape and fresh deterministic state", () => {
  assert.deepEqual(VISION_CASES.map((item) => item.id),
    ["cross-left", "cross-right", "parallel", "stationary", "empty"]);
  for (const item of VISION_CASES) {
    const a = createVisionScenario(item.id), b = createVisionScenario(item.id);
    assert.deepEqual(a, b);
    assert.deepEqual(Object.keys(a).sort(),
      ["id", "roads", "statics", "playerStart", "people", "goalZ", "requestedSpeedMps"].sort());
    assert.deepEqual(a.roads, [{ axis: "z", fixed: 0, min: -60, max: 70, width: 10 }]);
    assert.deepEqual(a.playerStart, { x: 0, z: -22, heading: 0, speed: 0 });
    assert.equal(a.goalZ, 14);
    assert.ok(a.requestedSpeedMps > 0 && a.requestedSpeedMps <= 8);
    a.statics[0].x = 0;
    assert.notEqual(a.statics[0].x, b.statics[0].x);
    if (a.people[0]) {
      a.people[0].script.velocity.x = 99;
      assert.notEqual(a.people[0].script.velocity.x, b.people[0].script.velocity.x);
    }
  }
  assert.throws(() => createVisionScenario("invented-crossing"), /Unknown/);
});

test("all registered side-building footprints clear the entire road and sidewalk", () => {
  for (const { id } of VISION_CASES) {
    const scenario = createVisionScenario(id);
    for (const site of scenario.statics) {
      assert.equal(site.kind, "building");
      assert.equal(site.type, "static");
      assert.ok(site.height >= 8 && site.height <= 20);
      assert.ok(Math.abs(site.x) - site.width / 2 >= 5 + 2.5 + 1);
      for (const person of scenario.people)
        assert.ok(Math.abs(site.x - person.x) > site.width / 2 + person.radius);
    }
  }
});

test("actual crossings are mirrored, straight and deterministic after a visible pause", () => {
  const left = run("cross-left", 8), right = run("cross-right", 8);
  const replay = run("cross-left", 8);
  assert.deepEqual(left.positions, replay.positions);
  near(left.positions[37].x, -4.8);
  near(left.actor.x, -4.8 + 0.9 * (8 - 0.65));
  near(left.actor.z, 0);
  for (let i = 0; i < left.positions.length; i++) {
    near(left.positions[i].x, -right.positions[i].x);
    near(left.positions[i].z, right.positions[i].z);
  }
  assert.ok(left.positions.some((p) => Math.abs(p.x) < 1));
  assert.ok(right.positions.some((p) => Math.abs(p.x) < 1));
  const finishedLeft = run("cross-left", 16).actor;
  const finishedRight = run("cross-right", 16).actor;
  near(finishedLeft.x, 6.4);
  near(finishedRight.x, -6.4);
  assert.equal(finishedLeft.speed, 0);
  assert.equal(finishedRight.speed, 0);
});

test("curb lookalikes preserve appearance without eventually crossing the ego lane", () => {
  const crossing = createVisionScenario("cross-left").people[0];
  const parallel = run("parallel", 16), stationary = run("stationary", 16);
  assert.equal(parallel.actor.kind, crossing.kind);
  assert.equal(stationary.actor.kind, crossing.kind);
  assert.equal(parallel.actor.radius, crossing.radius);
  for (const point of [...parallel.positions, ...stationary.positions])
    near(point.x, -4.8);
  assert.ok(parallel.actor.z > 10);
  near(stationary.actor.z, 0);
  near(stationary.actor.distance, 0);
  assert.deepEqual(createVisionScenario("empty").people, []);
});

test("step boundary is immutable, bounded and integrates fractional onset without future sampling", () => {
  const actor = createVisionScenario("cross-left").people[0];
  actor.script.elapsedS = 0.64;
  const original = structuredClone(actor);
  const next = advanceVisionActor(actor, 0.1, { simulationTimeS: 0.64 });
  assert.deepEqual(actor, original);
  near(next.x, -4.8 + 0.9 * 0.09);
  assert.equal(next.phase, actor.phase, "distance drives the renderer's gait; the phase offset stays fixed");
  assert.deepEqual(next.script.evaluation.samples,
    [{ simulationTimeS: 0.64, x: -4.8, z: 0, speedMps: 0 }]);
  const constrained = { ...next, x: -4.77 };
  const afterConstraint = advanceVisionActor(constrained, 1 / 60, { simulationTimeS: 0.75 });
  assert.equal(afterConstraint.script.evaluation.samples.at(-1).x, -4.77,
    "record the accepted prior pose, not the unconstrained next proposal");
  assert.ok(!("visible" in afterConstraint.script.evaluation.samples.at(-1)));
  const worldContext = advanceVisionActor(actor, 0.1, { timeS: 0.64, tick: 38 });
  assert.deepEqual(worldContext, next);
  assert.throws(() => advanceVisionActor(actor, NaN), /finite/);
  assert.throws(() => advanceVisionActor(actor, 1), /finite/);
  assert.throws(() => advanceVisionActor(actor, -0.01), /finite/);
  assert.throws(() => advanceVisionActor({ ...actor, script: null }, 1 / 60), /assigned/);
  assert.throws(() => advanceVisionActor({
    ...actor, script: { ...actor.script, velocity: { x: 9, z: 0 } },
  }, 1 / 60), /finite/);
});

test("post-run actual-pose recording is bounded and never accepted as visual evidence", () => {
  const { actor } = run("stationary", 40);
  const evaluation = actor.script.evaluation;
  assert.equal(evaluation.source, "committed-scenario-motion");
  assert.equal(evaluation.samples.length, 320);
  assert.ok(evaluation.droppedSamples > 0);
  assert.ok(evaluation.samples.every((sample) =>
    sample.x === -4.8 && sample.z === 0 && Number.isFinite(sample.simulationTimeS)));
  for (let i = 1; i < evaluation.samples.length; i++)
    assert.ok(evaluation.samples[i].simulationTimeS > evaluation.samples[i - 1].simulationTimeS);
  const p = new VisualCrossingPredictor();
  p.reset("actual-case-does-not-enter-vision");
  assert.throws(() => p.observe(actor), /unknown|plain/);
  assert.throws(() => p.observe({ ...createVisionScenario("cross-left") }), /unknown/);
});

test("a stopped vision World holds actual motion and rejects replay without its run event", () => {
  const world = new World({ seed: "vision-world-stopped", visionCase: "cross-left" }, "vision");
  assert.deepEqual(world.capacity, { traffic: 0, pedestrians: 1 });
  const start = world.snapshot();
  for (let i = 0; i < 60; i++) world.step();
  assert.equal(world.tick, 0);
  assert.deepEqual(world.snapshot(), start);
  assert.throws(() => World.fromReplay({ ...world.replay(), totalTicks: 1, events: [] }),
    /cannot advance a stopped scene/i);
});

for (const caseId of ["cross-left", "empty"]) {
  test(`public World sensors-only run is finite and nonpenetrating for ${caseId}`, () => {
    const world = new World({ seed: "vision-world-run", visionCase: caseId }, "vision");
    assert.equal(world.command({ type: "visual-mode", mode: "sensors-only" }), true);
    assert.equal(world.command({ type: "vision-run" }), true);
    assert.equal(world.command({ type: "vision-run" }), false);
    let maximumSpeed = 0;
    for (let i = 0; i < 30 * 60 && world.visionLab.phase === "running"; i++) {
      world.step();
      maximumSpeed = Math.max(maximumSpeed, world.player.speed);
      if (i % 30 === 0) assert.deepEqual(world.audit(), []);
      assert.equal(world.visualDecision.available, false, "no live visual observation was supplied");
      assert.equal(world.visualDecision.brake, false);
    }
    assert.equal(world.visionLab.phase, "complete");
    assert.ok(world.player.z >= world.visionLab.goalZ);
    assert.ok(maximumSpeed > 0 && maximumSpeed <= world.visionLab.requestedSpeedMps + 1e-8);
    assert.equal(world.visionLab.firstVisualBrakeS, null);
    assert.equal(world.player.vehicle.damage.impactCount, 0);
    assert.deepEqual(world.audit(), []);
    const finalTick = world.tick;
    world.step();
    assert.equal(world.tick, finalTick, "a completed scene must hold its accepted final pose");
    if (caseId === "cross-left") {
      const actualWalker = world.actors.find((actor) => actor.type === "pedestrian");
      assert.ok(actualWalker.x > 0, "the assigned walker actually crossed, not merely a case flag");
      assert.ok(actualWalker.script.evaluation.samples.some((sample) => sample.x < -4));
      assert.ok(actualWalker.script.evaluation.samples.some((sample) => sample.x > 0));
    }
  });
}

test("World pixel admission rejects truth; stream reset and actual run replay are deterministic", () => {
  const world = new World({ seed: "vision-world-replay", visionCase: "cross-right" }, "vision");
  const ego = { x: 0, z: -22, headingRad: 0, speedMps: 0, lengthM: 4.2, widthM: 1.85 };
  const emptyFrame = {
    streamId: "world-unit-first", frameId: 0, simulationTimeS: 0,
    camera: { width: 640, height: 360, fovYDeg: 76,
      position: { x: 0, y: 1.58, z: -21.28 }, headingRad: 0, groundY: 0.12 },
    ego, width: 640, height: 360, latencyMs: 1,
    model: { id: "unit-empty-frame", method: "fixture-only", provider: "unit", weightsSha256: null },
    detections: [], status: "ready",
  };
  world.command({ type: "visual-reset", streamId: emptyFrame.streamId });
  assert.equal(world.command({ type: "visual-observation", result: emptyFrame }), true);
  const eventsBefore = world.events.length;
  assert.throws(() => world.command({ type: "visual-observation",
    result: { ...emptyFrame, frameId: 1, actors: [{ id: "forbidden-truth", x: 0, z: 0 }] },
  }), /unknown/);
  assert.equal(world.events.length, eventsBefore, "rejected truth cannot be retained as an admitted observation");
  world.command({ type: "visual-reset", streamId: "world-unit-fresh" });
  const reset = world.visualPredictor.snapshot(0, ego);
  assert.equal(reset.available, false);
  assert.equal(reset.model, null);
  assert.deepEqual(reset.tracks, []);
  world.command({ type: "visual-mode", mode: "sensors-only" });
  world.command({ type: "vision-run" });
  for (let i = 0; i < 180; i++) world.step();
  const replayed = World.fromReplay(world.replay());
  assert.deepEqual(replayed.snapshot(), world.snapshot());
  assert.equal(replayed.visualPredictor.streamId, "world-unit-fresh");
  assert.deepEqual(replayed.actors.find((actor) => actor.type === "pedestrian").script,
    world.actors.find((actor) => actor.type === "pedestrian").script);
});
