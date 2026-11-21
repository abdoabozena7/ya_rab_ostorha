import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { initializeDistrictActor } from "../src/core/district-behavior.js";
import { planDistrictRoute } from "../src/core/district-navigation.js";
import { districtRoadPose } from "../src/core/egypt-district.js";
import { bodyOnRoad, overlaps } from "../src/core/geometry.js";
import { createPedestrianBody } from "../src/core/pedestrian-body.js";
import { PURSUIT_STOP } from "../src/core/pursuit-controls.js";
import { SpatialIndex } from "../src/core/spatial-index.js";
import { GtaPursuitEnv } from "../src/rl/gta-pursuit-env.js";
import { run } from "./train-metro-lateral-development.mjs";

const output = process.env.PROVE_IT_OUTPUT_DIR, mode = process.argv[2];
assert.ok(output && ["before", "current"].includes(mode));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const input = await readFile(new URL("../.runtime-proof/pursuit-rl-sustained-pressure-20261121/runs/fit/20261121T041811-efe40aab39/sustained-pressure.json", import.meta.url));
assert.equal(hash(input), "33fdcb83a4d23f85d16a35a70266dbaac4b894e8af47ade63925b7ade63ea6cf");
const { validation, controls } = JSON.parse(input);

function replay(site, expected) {
  let i = 2; // The shared runner owns the first two six-tick prelude decisions.
  const { summary, samples, motionAudit, last } = run(site, "combined", () => expected.trace[i++].request,
    expected.plan, expected.tick, true);
  assert.deepEqual(summary, expected);
  const hits = summary.incidents.filter(event => event.type === "ambient_collision");
  const trajectory = hash(JSON.stringify(summary.trace));
  const observed = createHash("sha256");
  for (const { obs } of samples) observed.update(Buffer.from(obs.buffer));
  return { site, trajectory, observations: observed.digest("hex"), hits, profile: last.info.rewardProfile,
    safety: motionAudit.reduce((total, step) => total + step.rewardSafety, 0),
    chargedDecisions: motionAudit.filter(step => step.rewardSafety !== 0).map(step => step.tick + 6) };
}

function crossing(away) {
  // Same physical Bab el-Louk setup as the moving-walker preview regression.
  const env = new GtaPursuitEnv();
  env.reset({ seed: "preview-local-walker", traffic: 0, pedestrians: 0, config: {
    ruleset: "dispatch-v1", maxActivePatrols: 0, civilianCrossingPreview: true,
  } });
  const { world } = env, road = world.drivingRoads.find(road => road.id === "bab-el-louk-link");
  const car = world.makeVehicle("local-van", "van", districtRoadPose(road, -53.04));
  car.path = planDistrictRoute(world.district, car, { id: "exit", roadId: road.id, ...districtRoadPose(road, -42.1) });
  car.speed = 6.5;
  initializeDistrictActor(world, car);
  Object.assign(car.district, { caseId: "motion-preview", profile: "ordinary", nextLoadingDistanceM: null });
  const target = { x: away ? -37.35 : -27, z: -46.42 };
  const walker = { id: "local-walker", type: "pedestrian", kind: "woman-shirt", x: -36, z: target.z,
    heading: away ? -Math.PI / 2 : Math.PI / 2, speed: 1.36, walkSpeed: 1.36, distance: 0, wait: 0,
    phase: .2, pause: 0, motionMode: "ambient", crossing: false, road, target, side: -1,
    along: target.z, walkRoute: [target], walkGoal: `${target.x},${target.z}`, walkPlanTick: 0,
    district: { caseId: "motion-preview", pattern: "parallel", routeConstrained: true, holdAtTarget: true } };
  walker.body = createPedestrianBody(walker);
  walker.radius = walker.body.radiusM;
  walker.height = walker.body.heightM;
  assert.ok(car.path.length > 10 && bodyOnRoad(car, world.roads) && world.free(car, .1) &&
    world.free(walker, .1) && !overlaps(walker, car, .1));
  world.actors.push(car, walker);
  world.actorIndex = new SpatialIndex(world.actors);
  const trajectory = createHash("sha256"), observations = createHash("sha256"), hits = [], chargedDecisions = [];
  let safety = 0;
  for (let i = 0; i < 240; i++) {
    const { obs, info } = env.step(PURSUIT_STOP, 1);
    assert.equal(world.tick, i + 1);
    assert.ok(world.actors.includes(car) && world.actors.includes(walker));
    trajectory.update(JSON.stringify([world.tick, ...[car, walker, world.player].map(({ x, z, heading, speed }) =>
      [x, z, heading, speed]), info.events]));
    observations.update(Buffer.from(obs.buffer));
    hits.push(...info.events.filter(event => event.type === "ambient_collision"));
    safety += info.rewardComponents.safety;
    if (info.rewardComponents.safety !== 0) chargedDecisions.push(world.tick);
  }
  return { trajectory: trajectory.digest("hex"), observations: observations.digest("hex"), hits, safety, chargedDecisions,
    carDistanceM: car.distance, walkerDistanceM: walker.distance, profile: env.rewardProfile };
}

const traffic = validation.map(({ site, candidate }) => replay(site, candidate.last));
const cleanTraffic = controls.map(({ site, long }) => replay(site, long));
const walker = crossing(false), clearWalker = crossing(true);
const report = { runtime: process.version, traffic, cleanTraffic, walker, clearWalker,
  vehicleContacts: traffic.reduce((total, row) => total + row.hits.length, 0),
  allUncharged: [...traffic, ...cleanTraffic, walker, clearWalker].every(row => row.safety === 0) };
assert.ok(traffic.every(row => row.hits.length === 1 && row.hits[0].second.kind === "sedan"));
assert.ok(walker.hits.length === 1 && walker.hits[0].second.type === "pedestrian" && walker.hits[0].closingSpeed > 1);
assert.ok(cleanTraffic.every(row => !row.hits.length) && clearWalker.hits.length === 0);
if (mode === "before") assert.ok(report.allUncharged);
else {
  const bytes = await readFile(new URL(
    "../.runtime-proof/pursuit-rl-ambient-safety-reward-20261121/before-20261121-062318/ambient-reward.json", import.meta.url));
  assert.equal(hash(bytes), "e604b6a48df97c01066d53cddac87c30f7da125d43e5b603f44fc707e827a53f");
  const before = JSON.parse(bytes);
  const unchanged = (old, next) => {
    assert.deepEqual(next.hits, old.hits);
    assert.equal(next.trajectory, old.trajectory);
    assert.equal(next.observations, old.observations);
    assert.equal(next.profile, "qualified-progress-v2");
  };
  traffic.forEach((row, i) => unchanged(before.traffic[i], row));
  cleanTraffic.forEach((row, i) => unchanged(before.cleanTraffic[i], row));
  unchanged(before.walker, walker);
  unchanged(before.clearWalker, clearWalker);
  assert.ok(before.allUncharged);
  report.matchesBaseline = true;
  for (const row of [...traffic, walker]) {
    const [hit] = row.hits;
    assert.equal(row.chargedDecisions.length, 1);
    assert.ok(row.chargedDecisions[0] >= hit.tick && row.chargedDecisions[0] < hit.tick + 6);
  }
  for (const row of [...cleanTraffic, clearWalker]) assert.equal(row.safety, 0);
  assert.ok(traffic.every(row => row.safety < -3 && row.safety > walker.safety) && walker.safety < -12);
}
await writeFile(join(output, "ambient-reward.json"), JSON.stringify(report, null, 2), { flag:"wx" });
