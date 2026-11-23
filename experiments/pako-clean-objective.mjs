import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { GtaPursuitEnv } from "../src/rl/gta-pursuit-env.js";
import { fit, run } from "./pako-connected-window.mjs";

const output = process.env.PROVE_IT_OUTPUT_DIR;
assert.ok(output, "Use a fresh PROVE_IT_OUTPUT_DIR");
const profile = "clean-escape-v1";
const cases = [
  ["clean", "station-avenue", "direct", 0, 12],
  ["contact", "gateway-avenue", "connected", 1, 0],
].map(([id, entry, arm, path, expectedBonus]) => {
  const site = fit.find(row => row.entry === entry);
  const legacy = run(site, { arm, path, recordReward: true });
  const current = run(site, { arm, path, rewardProfile: profile, recordReward: true });
  const physical = ["positions", "contacts", "ticks", "denied", "collisions", "patrolM", "qualified", "phase"]
    .every(field => JSON.stringify(legacy[field]) === JSON.stringify(current[field]));
  const { outcome: oldOutcome, ...oldComponents } = legacy.rewardComponents;
  const { outcome: newOutcome, ...newComponents } = current.rewardComponents;
  const pass = physical && current.phase === "escaped" && current.qualified && current.patrolM > 20 &&
    (id === "clean" ? current.full && current.collisions === 0 :
      current.collisions > 0 && current.contacts.some(event => event.type === "patrol_collision")) &&
    legacy.rewardProfile === "qualified-progress-v2" && current.rewardProfile === profile &&
    oldOutcome === 12 && newOutcome === expectedBonus &&
    JSON.stringify(oldComponents) === JSON.stringify(newComponents);
  return { id, physical, pass, legacy, current };
});

for (const options of [
  { shield: false, config: { ruleset: "dispatch-v1" } },
  { shield: true, config: { ruleset: "dispatch-v1", maxActivePatrols: 0 } },
  { config: { ruleset: "legacy" } },
]) assert.throws(() => new GtaPursuitEnv().reset({ ...options, rewardProfile: profile }), /reward profile/i);

const pass = cases.every(row => row.pass);
writeFileSync(join(output, "clean-objective.json"), JSON.stringify({ pass, cases }, null, 2) + "\n", { flag: "wx" });
for (const { id, pass, physical, legacy, current } of cases) {
  console.log(JSON.stringify({ id, pass, physical, contacts: current.collisions, ticks: current.ticks,
    oldOutcome: legacy.rewardComponents.outcome, newOutcome: current.rewardComponents.outcome }));
}
assert.ok(pass, "Clean reward failed on a matched actual Metro terminal trajectory");
