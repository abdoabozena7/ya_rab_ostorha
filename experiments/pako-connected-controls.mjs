import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { freezePursuitPolicy } from "../src/rl/pursuit-ppo.js";
import { run } from "./pako-connected-window.mjs";

const output = process.env.PROVE_IT_OUTPUT_DIR;
assert.ok(output, "Use a fresh PROVE_IT_OUTPUT_DIR");
const sealedRun = new URL("../.runtime-proof/pako-connected-learning-20261121/runs/learning/20261121T141656-55f847c5eb/", import.meta.url);
const read = name => JSON.parse(readFileSync(new URL(name, sealedRun)));
const protocol = read("protocol.json");
const priorReport = read("learning-comparison.json");
const bytes = readFileSync(new URL("ppo-checkpoint.json", sealedRun));
const checkpointSha = createHash("sha256").update(bytes).digest("hex");
assert.equal(checkpointSha, priorReport.accountable.ppoSha);
const policy = freezePursuitPolicy(JSON.parse(bytes));
const baseline = priorReport.evaluations.map(rows => rows.find(row => row.arm === "ppo"));
const cases = protocol.validate.map(({ site, options }, i) => {
  const common = { ...options, choose: policy.action };
  const unchanged = run(site, { ...common, arm: "ppo" });
  assert.equal(unchanged.positions, baseline[i].positions, "The unmodified intervention control changed");
  const matched = {
    unchanged,
    referenceSteer: run(site, { ...common, arm: "ppo-reference-steer", replaceWithReference: "steer" }),
    referencePace: run(site, { ...common, arm: "ppo-reference-pace", replaceWithReference: "pace" }),
  };
  console.log(JSON.stringify({ seed: options.seed, arms: Object.entries(matched).map(([key, row]) =>
    [key, row.full, row.phase, row.ticks, row.denied, row.contacts[0]?.tick]) }));
  return { site, options, matched };
});
const totals = Object.fromEntries(["unchanged", "referenceSteer", "referencePace"]
  .map(arm => [arm, cases.filter(row => row.matched[arm].full).length]));
writeFileSync(join(output, "controls.json"), JSON.stringify({
  scope: "Diagnostic channel substitution, not learned behavior, not a policy validation run",
  checkpointSha, node: process.version, totals, cases,
}, null, 2) + "\n", { flag: "wx" });
console.log(JSON.stringify(totals));
