import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { World } from "../src/core/world.js";
import { overlaps } from "../src/core/geometry.js";
import { vehicleProbe } from "../src/core/vehicle.js";
import { cityPropImpactTargets } from "../src/core/city-props.js";
import { runSmartEscapeTrial } from "../src/rl/smart-escape-trials.js";
import { freezePursuitPolicy, PursuitPpo } from "../src/rl/pursuit-ppo.js";
import { collectPursuitRollout, pursuitStageVariants, runPursuitEpisode } from "../src/rl/pursuit-rollouts.js";

const output = process.env.PROVE_IT_OUTPUT_DIR;
assert.ok(output, "Set PROVE_IT_OUTPUT_DIR to a fresh evidence directory.");
await mkdir(output, { recursive: true });
const report = { passed: false, runtime: "actual standalone World fixed-step engine", props: [], trials: [] };
try {
  for (const chase of [false, true]) for (const id of ["city-tree-4", "district-produce"]) {
    const world = new World({ seed: "smart-city-prop-acceptance", cityVersion: 5, chaos: 0 }, "metro");
    const ambient = [...world.actors];
    if (chase) world.command({ type: "street-pursuit-start", level: 1, variant: "gta",
      config: { ruleset: "dispatch-v1", curbSupport: "metro-city-curbs-v2" } });
    const prop = world.statics.find(s => s.id === id), p = world.player;
    assert.ok(prop, `Physical prop ${id} is missing`);
    Object.assign(p, { x: prop.x, z: prop.z - 6, heading: 0, speed: 40, steer: 0, path: [] });
    world.command({ type: "mode", mode: "manual" });
    world.command({ type: "drive", targetSpeed: 40, steer: 0 });
    if (chase) world.pursuit.manualAction = { steer: 0, throttle: 1, brake: 0, gear: 1 };
    const contacts = [];
    for (let tick = 0; tick < 60; tick++) {
      world.step();
      assert.equal(overlaps(vehicleProbe(p), prop), false, `${id} penetrated at tick ${world.tick}`);
      if (p.vehicle.contact?.hitId === id)
        contacts.push({ tick: world.tick, speed: p.speed, x: p.x, z: p.z });
    }
    assert.ok(contacts.length > 0, `${id} must have a genuine contact, not a predictive-only stop`);
    assert.ok(prop.propImpact.damage > 0 && p.vehicle.damage.total > 0, `${id} must transfer impact`);
    assert.ok(ambient.every(a => world.actors.includes(a)), "Impacts must not remove ambient actors");
    report.props.push({ id, chase, initialSpeedMps: 40, contacts, impact: prop.propImpact,
      targets: cityPropImpactTargets(world).filter(t => t.id === id), vehicleDamage: p.vehicle.damage.total });
  }
  // The explicit legacy profile is a safe, known-broken collision control.
  const legacy = new World({ seed: "smart-city-prop-negative", cityVersion: 5, cityPropProfile: "none", chaos: 0 }, "metro");
  assert.equal(legacy.statics.some(s => s.id === "city-tree-4"), false);
  const p = legacy.player;
  Object.assign(p, { x: -511.45, z: -140, heading: 0, speed: 14, steer: 0, path: [] });
  legacy.command({ type: "mode", mode: "manual" });
  legacy.command({ type: "drive", targetSpeed: 14, steer: 0 });
  for (let tick = 0; tick < 40; tick++) legacy.step();
  assert.ok(p.z > -134, `Legacy negative control must demonstrate original tree pass-through: ${p.z}`);
  report.negativeControl = { profile: "none", legacyTreePassThroughDetected: true, finalZ: p.z };
  report.fairness = [];
  for (const level of [1, 2, 3, 4, 5]) {
    const world = new World({ seed: `smart-fairness-${level}`, cityVersion: 5, chaos: 0 }, "metro");
    world.command({ type: "street-pursuit-start", level, variant: "gta", config: {
      ruleset: "dispatch-v1", tacticalPursuit: "gta-tactical-v1", policeFairness: "city-fair-v1",
      wantedLevelStart: level, wantedLevelMax: 5, maxActivePatrols: 14, npcSpeedMultiplier: 2,
      curbSupport: "metro-city-curbs-v2",
    } });
    const patrols = [...world.pursuit.patrols], positions = new Map(patrols.map(p => [p.id, { x: p.x, z: p.z }]));
    assert.ok(patrols.length > 0);
    for (let tick = 0; tick < 120; tick++) {
      world.step();
      assert.deepEqual([...world.pursuit.patrols].map(p => p.id), patrols.map(p => p.id), "No rolling replacement patrols");
      for (const p of patrols) {
        assert.ok(p.maxSpeed <= world.player.maxSpeed, `Level ${level}: police may not be faster than base SUV`);
        const previous = positions.get(p.id);
        assert.ok(Math.hypot(p.x - previous.x, p.z - previous.z) < 2, "Patrol must move physically, never teleport");
        positions.set(p.id, { x: p.x, z: p.z });
      }
    }
    report.fairness.push({ level, playerMaxSpeed: world.player.maxSpeed,
      patrols: patrols.map(p => ({ id: p.id, maxSpeed: p.maxSpeed, x: p.x, z: p.z })) });
  }
  const crowdWorld = new World({ seed: "smart-crowd-acceptance", cityVersion: 5, chaos: 0 }, "metro");
  const originals = [...crowdWorld.actors], start = { ...crowdWorld.player };
  crowdWorld.command({ type: "spawn-crowd-ahead", count: 20, layout: "dispersed-cohorts-v1" });
  assert.equal(crowdWorld.lastCrowdSpawn.ok, true, JSON.stringify(crowdWorld.lastCrowdSpawn));
  const added = crowdWorld.actors.filter(a => !originals.includes(a));
  assert.equal(added.length, 20);
  assert.ok(originals.every(a => crowdWorld.actors.includes(a)));
  const along = added.map(p => (p.x - start.x) * Math.sin(start.heading) + (p.z - start.z) * Math.cos(start.heading));
  assert.ok(Math.max(...along) - Math.min(...along) >= 40, "Crowd must span much more than the previous 20 m wall");
  report.crowd = { before: originals.length, after: crowdWorld.actors.length,
    longitudinalSpanM: Math.max(...along) - Math.min(...along), spawn: crowdWorld.lastCrowdSpawn };
  const stage = {
    id: "smart-bounded-development", cityVersion: 5, observation: "dispatch-route-v2",
    traffic: 0, pedestrians: 0, patrols: 0, episodeSeconds: 8, wantedLevel: 1, wantedLevelMax: 5,
    curbSupport: "metro-city-curbs-v2", chasePresence: "city-chase-v1", tacticalPursuit: "gta-tactical-v1",
    evasiveControl: "pako-smart-escape-v3", policeFairness: "city-fair-v1",
    patrolTrafficPreview: "visible-traffic-v1", patrolChainYield: "indirect-pedestrian-yield-v2",
    scenarios: ["smart-gap-crowd", "smart-crossing-traffic", "smart-static-hazard"],
  };
  const model = new PursuitPpo("smart-bounded-development", null, stage.observation);
  const weightHash = () => createHash("sha256").update(JSON.stringify(model.weights)).digest("hex");
  const before = weightHash();
  const collected = collectPursuitRollout(model, stage, ["chase-practice-01"]);
  const update = model.update(collected.rollout, collected.bootstrap);
  assert.equal(model.updates, 1);
  assert.equal(model.transitions, 240);
  assert.ok(model.optimizerSteps > 0);
  assert.notEqual(weightHash(), before, "An optimizer run must actually change model weights");
  const trained = freezePursuitPolicy(model.checkpoint());
  report.training = { scope: "bounded development drills; not learned escape improvement or a shipped policy replacement",
    stage, update, transitions: model.transitions, optimizerSteps: model.optimizerSteps, metrics: collected.metrics,
    evaluation: pursuitStageVariants(stage).map(variant =>
      runPursuitEpisode(variant, "chase-test-01", trained.action).metrics) };
  assert.equal(report.training.evaluation.length, 3);
  await writeFile(join(output, "bounded-training-checkpoint.json"), JSON.stringify(model.checkpoint()));
  const policy = freezePursuitPolicy(JSON.parse(await readFile(new URL("../public/threejs/pako-chase-ppo.json", import.meta.url), "utf8")));
  for (const seed of ["smart-a", "smart-b"]) for (const scenario of [
    "smart-gap-crowd", "smart-crossing-traffic", "smart-static-hazard",
  ]) {
    const baseline = runSmartEscapeTrial({ seed, scenario, controller: "pako-evasive-v2" });
    const smart = runSmartEscapeTrial({ seed, scenario });
    const production = runSmartEscapeTrial({ seed, scenario, policy });
    report.trials.push({ scenario, seed, baseline, smart, production });
    assert.equal(smart.contacts, 0, `${scenario} must avoid controlled contacts`);
    assert.equal(smart.pedestrianContacts, 0);
    assert.equal(smart.pedestrianNitroViolations, 0);
    assert.equal(smart.originalActorsRetained, true);
    assert.ok(smart.distanceM > 20 && smart.destinationCount > 0 && smart.destinationCount <= 2);
    assert.equal(production.contacts, 0, `Shipped-policy controlled contacts: ${scenario}`);
    assert.equal(production.pedestrianNitroViolations, 0);
    assert.ok(production.distanceM > 20 && production.originalActorsRetained);
    if (scenario !== "smart-gap-crowd")
      assert.ok(smart.anticipatoryBrakes > 0 && baseline.contacts > smart.contacts, "Predictive safety must beat a collision-positive old control");
  }
  report.dense = [];
  for (const seed of ["smart-city-a", "smart-city-b", "smart-city-c"]) {
    const result = runSmartEscapeTrial({ seed, seconds: 120, traffic: 48, pedestrians: 100, patrols: 14, policy });
    report.dense.push(result);
  }
  report.failures = [];
  for (const result of report.dense) {
    if (result.contacts !== 0) report.failures.push(`Dense avoidable contacts: ${result.seed}: ${result.contacts}`);
    if (result.pedestrianNitroViolations !== 0) report.failures.push(`Unsafe pedestrian Nitro: ${result.seed}`);
    if (!result.originalActorsRetained) report.failures.push(`Ambient population changed: ${result.seed}`);
    if (!(result.distanceM > 100 && result.displacementM > 100))
      report.failures.push(`Insufficient escape progress: ${result.seed}: ${result.phase}, ${result.distanceM} m, ${result.displacementM} m displacement`);
  }
  if (!report.dense.some(r => r.phase === "escaped" && r.qualifiedEscape))
    report.failures.push("No qualified dense escape using the shipped policy; survival alone is not escape");
  assert.deepEqual(report.failures, [], "Integrated escape behavior has unresolved failures");
  report.passed = true;
} finally {
  await writeFile(join(output, "engine.json"), `${JSON.stringify(report, null, 2)}\n`);
}
assert.equal(report.passed, true, "Integrated escape acceptance is not complete");
console.log(JSON.stringify(report));
