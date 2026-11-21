import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { clamp } from "../src/core/config.js";
import { planDistrictRoute } from "../src/core/district-navigation.js";
import { districtRoadPose } from "../src/core/egypt-district.js";
import { bodyOnRoad, distance } from "../src/core/geometry.js";
import { PURSUIT_STOP } from "../src/core/pursuit-controls.js";
import { followPath } from "../src/core/vehicle.js";
import { GtaPursuitEnv } from "../src/rl/gta-pursuit-env.js";
import { dispatchRouteGuide } from "../src/rl/pursuit-route-context.js";
import { isDispatchIncident } from "../src/rl/pursuit-rollouts.js";

const output = process.env.PROVE_IT_OUTPUT_DIR;
assert.ok(output, "Set a new proof output directory");
const curriculum = JSON.parse(await readFile(new URL("../config/pursuit-rl-city-route-development.json", import.meta.url)));
const report = { classification: "offline reference on full-population development training seeds only",
  engine: process.version, v8: process.versions.v8, civilianCrossingPreview: true, episodes: [] };
const smooth = value => {
  const u = clamp(value, 0, 1);
  return u * u * (3 - 2 * u);
};

function reference(world, observation, dense) {
  const { player, district } = world;
  if (!dense) return { path: dispatchRouteGuide(world, observation).path };
  const road = district.drivingRoads.find(road => road.id === "civic-avenue");
  assert.ok(road);
  const goal = { ...districtRoadPose(road, 78, 1), roadId: road.id };
  const path = planDistrictRoute(district, player, goal).map(({ x, z }) => {
    const shift = Math.abs(x - goal.x) < .02 ? 2.35 * smooth((z + 82) / 42) * smooth((77 - z) / 18) : 0;
    return Object.freeze({ x: x - shift, z });
  });
  return { path: Object.freeze(path), goal };
}

for (const stage of curriculum.stages) {
  const dense = stage.traffic === 96;
  const trainingSeeds = dense ? curriculum.trainingSeeds : curriculum.trainingSeeds.slice(0, 1);
  for (const seed of trainingSeeds) {
    assert.ok(!curriculum.validationSeeds.includes(seed));
    const env = new GtaPursuitEnv(), { observation, traffic, pedestrians, wantedLevel, patrols } = stage;
    let { obs } = env.reset({ seed, traffic, pedestrians, observation, shield: true,
      config: { ruleset: "dispatch-v1", civilianCrossingPreview: true, wantedLevelStart: wantedLevel,
        wantedLevelMax: wantedLevel, maxActivePatrols: patrols, episodeMaxSeconds: 120 } });
    const { world } = env, { player, pursuit } = world;
    const { path, goal } = reference(world, observation, dense);
    assert.ok(path.length > 10);
    const ambient = world.actors.filter(a => a !== player && !pursuit.patrols.has(a)).map(actor => [actor, actor.id, actor.type]);
    assert.equal(ambient.filter(([, , type]) => type === "vehicle").length, traffic);
    assert.equal(ambient.filter(([, , type]) => type === "pedestrian").length, pedestrians);
    let cursor = 0, result, parked = false, peakActivePatrols = 0, interventions = 0;
    const samples = [], trace = [], incidents = [];
    do {
      const request = followPath(player, path, cursor);
      cursor = request.cursor;
      const offsetSegment = dense && player.z > -88 && player.z < 78;
      const target = Math.min(offsetSegment ? 7 : dense ? 16 : stage.demonstrationSpeedMps, request.targetSpeed);
      const brake = clamp((player.speed - target) / 2.5, 0, 1);
      parked ||= Boolean(goal && player.z > goal.z - 1.6 && distance(player, goal) < 1.65);
      const action = parked ? PURSUIT_STOP : { steer: clamp(request.steer / player.spec.maxSteer, -1, 1),
        throttle: brake ? 0 : clamp((target - player.speed) / 1.8, 0, 1), brake, gear: 1 };
      samples.push({ obs: Array.from(obs), action });
      result = env.step(action);
      obs = result.obs;
      assert.ok(bodyOnRoad(player, world.roads));
      const present = new Set(world.actors);
      assert.ok(ambient.every(([actor, id, type]) => present.has(actor) && actor.id === id && actor.type === type),
        "A required ambient actor was removed, replaced or recategorized");
      peakActivePatrols = Math.max(peakActivePatrols, result.info.activePatrols);
      const shield = result.info.shield;
      interventions += shield.interventions;
      incidents.push(...result.info.events.filter(isDispatchIncident));
      if (world.tick % 60 === 0) trace.push([world.tick, player.x, player.z, player.speed, player.reason,
        player.blockedBy ?? null, shield.reason, pursuit.response.dispatch.state]);
    } while (!result.terminated && !result.truncated);
    const ambientPedestrianImpacts = incidents.filter(event => event.type === "ambient_collision" &&
      [event.first, event.second].some(body => body.type === "pedestrian")).length;
    const row = { seed, level: wantedLevel, traffic, pedestrians, phase: pursuit.phase, activePatrols: peakActivePatrols,
      qualified: pursuit.response.dispatch.escapeEligible, ticks: world.tick, distanceM: pursuit.metrics.distanceM,
      contacts: pursuit.metrics.collisions, ambientContacts: pursuit.metrics.trafficCollisions,
      ambientPedestrianImpacts, interventions, trace, incidents };
    if (row.qualified && row.phase === "escaped" && !row.contacts && !row.ambientPedestrianImpacts && peakActivePatrols > 0) {
      const file = `${stage.id}-${seed}-demonstration.json`, data = JSON.stringify(samples);
      await writeFile(join(output, file), data, { flag: "wx" });
      row.demonstration = { file, samples: samples.length, sha256: createHash("sha256").update(data).digest("hex") };
    }
    report.episodes.push(row);
    await appendFile(join(output, "episodes.ndjson"), JSON.stringify(row) + "\n");
    const { trace: _trace, incidents: _incidents, ...metrics } = row;
    console.log(JSON.stringify(metrics));
  }
}

report.denseFeasible = report.episodes.some(row => row.traffic === 96 && row.demonstration);
report.mediumFeasible = report.episodes.some(row => row.traffic === 36 && row.demonstration);
await writeFile(join(output, "preview-teacher.json"), JSON.stringify(report, null, 2), { flag: "wx" });
assert.ok(report.denseFeasible && report.mediumFeasible, "No physically qualified teacher trajectory for one or both populations");
