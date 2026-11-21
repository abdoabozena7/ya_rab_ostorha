import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { clamp } from "../src/core/config.js";
import { followPath } from "../src/core/vehicle.js";
import { SpatialIndex } from "../src/core/spatial-index.js";
import { PursuitScanner } from "../src/signal_processing/pursuit-scanner.js";
import { CLEARANCE_ROUTE_OBSERVATION_SCHEMA, GtaPursuitEnv } from "../src/rl/gta-pursuit-env.js";
import { dispatchRouteGuide } from "../src/rl/pursuit-route-context.js";

const version = CLEARANCE_ROUTE_OBSERVATION_SCHEMA.version;
const seed = "route-train-00";
const settings = { seed, shield: true, traffic: 36, pedestrians: 80,
  config: { ruleset: "dispatch-v1", wantedLevelStart: 3, wantedLevelMax: 3,
    maxActivePatrols: 7, episodeMaxSeconds: 65 } };

function run(observation) {
  const env = new GtaPursuitEnv();
  const initial = env.reset({ ...settings, observation });
  const { world } = env, { player, pursuit } = world;
  const guide = dispatchRouteGuide(world, observation);
  assert.ok(guide && guide.path.length > 10);
  assert.equal(initial.info.observationVersion, observation);
  const population = world.actors.filter(actor => actor !== player && !pursuit.patrols.has(actor));
  assert.equal(population.filter(actor => actor.type === "vehicle").length, 36);
  assert.equal(population.filter(actor => actor.type === "pedestrian").length, 80);
  let cursor = 0, trackedAndMobile = false;
  const trace = [], states = new Set(), incidents = [], motion = createHash("sha256");
  while (pursuit.phase === "running") {
    const command = followPath(player, guide.path, cursor);
    cursor = command.cursor;
    const target = Math.min(12, command.targetSpeed), brake = clamp((player.speed - target) / 2.5, 0, 1);
    const result = env.step({ steer: clamp(command.steer / player.spec.maxSteer, -1, 1),
      throttle: brake ? 0 : clamp((target - player.speed) / 1.8, 0, 1), brake, gear: 1 });
    const state = pursuit.response.dispatch.state;
    states.add(state);
    trackedAndMobile ||= state === "ZONE_TRACKED" && pursuit.response.dispatch.escapeEligible &&
      [...pursuit.patrols].some(patrol => patrol.distance > 10 && patrol.speed >= 3);
    const pose = [world.tick, player.x, player.z, player.heading, player.speed, state, result.info.appliedCommand];
    assert.ok(pose.slice(0, 5).every(Number.isFinite));
    motion.update(JSON.stringify(pose));
    if (world.tick % 60 === 0 || pursuit.phase !== "running") trace.push(pose);
    incidents.push(...result.info.events.filter(event => event.type === "patrol_collision" ||
      event.type === "static_or_civilian_hit" || event.type === "near_miss"));
  }
  assert.ok(population.every(actor => world.actors.includes(actor)), "The shared City population must be retained");
  return { observation, phase: pursuit.phase, distanceM: pursuit.metrics.distanceM, contacts: pursuit.metrics.collisions,
    goal: guide.id, end: guide.path.at(-1), pathM: guide.lengthM, states: [...states], trackedAndMobile,
    ticks: world.tick, digest: motion.digest("hex"), trace, incidents };
}

function hiddenTwin(shift) {
  const env = new GtaPursuitEnv();
  env.reset({ ...settings, observation: version, traffic: 0, pedestrians: 0,
    config: { ...settings.config, maxActivePatrols: 1 } });
  const { world } = env, { player, pursuit } = world, [patrol] = pursuit.patrols;
  const cover = { id: "fixture-route-occluder", type: "static", kind: "barrier", height: 3,
    x: player.x - 6, z: player.z, heading: player.heading, width: 14, length: .3 };
  Object.assign(patrol, { x: player.x - 15 - shift, z: player.z, heading: player.heading });
  world.statics = world.statics.concat(cover);
  if (shift) world.statics.push({ ...cover, id: "hidden-fixture-closure", x: player.x - 9, width: 2 });
  world.staticIndex = new SpatialIndex(world.statics);
  pursuit.gta.scanner = new PursuitScanner();
  pursuit.gta.scan = pursuit.gta.scanner.sample(world);
  pursuit.response.lastSeen = { x: 25 + shift, z: 15, heading: 0, speed: 12, tick: 0 };
  pursuit.wantedLevel += Number(Boolean(shift));
  assert.ok(!pursuit.gta.scan.rays.some(ray => ray.kind === "police"));
  return { observation: env.getObservation(), goal: dispatchRouteGuide(world, version).id };
}

const left = hiddenTwin(0), right = hiddenTwin(2);
const hiddenInvariant = left.goal === right.goal && left.observation.every((v, i) => v === right.observation[i]);
const original = run("dispatch-route-v1"), extended = run(version);
const report = { mode: "scripted public-route feasibility, not learned performance", seed, original, extended, hiddenInvariant };
if (process.env.PROVE_IT_OUTPUT_DIR)
  await writeFile(join(process.env.PROVE_IT_OUTPUT_DIR, "clearance-route.json"), JSON.stringify(report, null, 2), { flag: "wx" });
console.log(JSON.stringify({ original: [original.goal, original.phase, original.contacts, original.distanceM],
  extended: [extended.goal, extended.phase, extended.contacts, extended.distanceM], hiddenInvariant }));
assert.ok(hiddenInvariant);
assert.equal(original.goal, "metro-exit-riverside");
assert.notEqual(original.phase, "escaped");
assert.ok(extended.states.includes("LOST") && extended.trackedAndMobile && extended.distanceM > 200);
assert.equal(extended.phase, "escaped");
assert.equal(extended.contacts, 0);
