import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isDispatchIncident, resetPursuitEpisode } from "../src/rl/pursuit-rollouts.js";
import { freezePursuitPolicy } from "../src/rl/pursuit-ppo.js";
import { PATROL_CHAIN_YIELD } from "../src/core/pako-patrol-yield.js";

const output = process.env.PROVE_IT_OUTPUT_DIR;
assert.ok(output, "Set PROVE_IT_OUTPUT_DIR to a fresh evidence directory");
const checkpointPath = "../.runtime-proof/pursuit-rl-dense-learning-20261120/corrective-trial-20261120-221352/checkpoint-1.json";
const bytes = await readFile(new URL(checkpointPath, import.meta.url));
const sha256 = createHash("sha256").update(bytes).digest("hex");
assert.equal(sha256, "854b284350457717cd2c299a0dc86604f2600ed989c1c9aac7ff497d0e5181e3");
const checkpoint = freezePursuitPolicy(JSON.parse(bytes));
const curriculum = JSON.parse(await readFile(new URL("../config/pursuit-rl-city-route-development.json", import.meta.url)));
assert.ok(curriculum.validationSeeds.every(seed => !curriculum.trainingSeeds.includes(seed)));
const chainAblation = process.argv.includes("--chain-yield");
const episodes = [];
for (const stage of curriculum.stages) {
  for (const seed of curriculum.validationSeeds) for (const predictive of [false, true]) {
    const chainYield = chainAblation && predictive;
    const { env } = resetPursuitEpisode({ ...stage, episodeSeconds: 120,
      ...(chainYield ? { patrolChainYield: PATROL_CHAIN_YIELD } : {}) }, seed);
    env.evasion = predictive && !chainAblation;
    const { world } = env, { pursuit, player } = world;
    const ambient = world.actors.filter(actor => actor !== player && !pursuit.patrols.has(actor));
    assert.equal(ambient.filter(actor => actor.type === "vehicle").length, stage.traffic);
    assert.equal(ambient.filter(actor => actor.type === "pedestrian").length, stage.pedestrians);
    const motion = createHash("sha256"), paths = [], contacts = [], evaluated = {};
    let shielding = 0, roadDenials = 0, recoveries = 0, reward = 0, frames = 0, pursuitQualified = false;
    let patrolYieldTicks = 0;
    const yieldingPatrols = new Set();
    if (chainYield) {
      const step = world.step.bind(world);
      world.step = () => {
        step();
        for (const patrol of pursuit.patrols) if (patrol.reason === "indirect-pedestrian-yield") {
          patrolYieldTicks++;
          yieldingPatrols.add(patrol.id);
        }
      };
    }
    const started = performance.now();
    while (pursuit.phase === "running") {
      const action = checkpoint.action(env.getObservation());
      const next = env.step(action);
      reward += next.reward;
      shielding += next.info.shield.interventions;
      roadDenials += Number(pursuit.metrics.guard === "road-boundary");
      pursuitQualified ||= pursuit.response.dispatch.escapeEligible;
      contacts.push(...next.info.events.filter(isDispatchIncident));
      const { planner } = next.info;
      if (planner?.reason) {
        evaluated[planner.reason] = (evaluated[planner.reason] ?? 0) + 1;
        recoveries += Number(planner.reason === "PREDICTIVE_RECOVERY");
      }
      const pose = [world.tick, player.x, player.z, player.heading, player.speed];
      assert.ok(pose.every(Number.isFinite));
      motion.update(JSON.stringify(pose));
      if (++frames % 10 === 1 || planner?.reason === "PREDICTIVE_RECOVERY" || pursuit.phase !== "running")
        paths.push({ pose, action, applied: next.info.appliedCommand, planner });
      assert.ok(ambient.every(actor => world.actors.includes(actor)), "Ambient actor disappeared");
    }
    const wallSeconds = (performance.now() - started) / 1000;
    const { metrics } = pursuit;
    const row = { stage: stage.id, seed, predictive, chainYield, phase: pursuit.phase, ticks: world.tick,
      distanceM: metrics.distanceM, collisions: metrics.collisions, ambientCollisions: metrics.trafficCollisions,
      ambientPedestrian: contacts.filter(event => event.type === "ambient_collision" &&
        (event.first.type === "pedestrian" || event.second.type === "pedestrian")).length,
      cleanEscape: pursuit.phase === "escaped" && pursuitQualified && metrics.collisions === 0,
      pursuitQualified, reward, shielding, roadDenials, recoveries, evaluated, wallSeconds, patrolYieldTicks,
      yieldPatrols: [...yieldingPatrols],
      motionSha256: motion.digest("hex") };
    episodes.push(row);
    await appendFile(join(output, "episodes.jsonl"), JSON.stringify({ ...row, contacts, paths }) + "\n");
    console.log(JSON.stringify(row));
  }
}
const totals = Object.fromEntries([false, true].map(predictive => {
  const arms = episodes.filter(episode => episode.predictive === predictive);
  return [predictive ? "preview" : "baseline", { episodes: arms.length,
    cleanEscapes: arms.filter(arm => arm.cleanEscape).length, recoveries: arms.reduce((sum, arm) => sum + arm.recoveries, 0),
    ambientPedestrian: arms.reduce((sum, arm) => sum + arm.ambientPedestrian, 0),
    patrolYieldTicks: arms.reduce((sum, arm) => sum + arm.patrolYieldTicks, 0) }];
}));
await writeFile(join(output, "comparison.json"), JSON.stringify({ type: chainAblation
  ? "development-only patrol secondary impact ablation; no policy change"
  : "development-only planner ablation; not learned improvement",
  sha256, node: process.version, episodes, totals }, null, 2) + "\n", { flag: "wx" });
