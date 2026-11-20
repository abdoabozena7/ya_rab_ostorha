import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Random } from "../src/core/random.js";
import { PURSUIT_ACTIONS, PURSUIT_POLICY_VERSION, validatePursuitPolicy } from "../src/core/pursuit-policy.js";
import { runPursuitTrial } from "./pursuit-trials.mjs";

const episodes = Number(process.argv[2] ?? 24);
if (!Number.isInteger(episodes) || episodes < 4 || episodes > 160)
  throw new Error("Usage: node tools/train-pursuit.mjs [episodes: 4..160] [output.json]");
const output = resolve(process.argv[3] ?? "public/threejs/pursuit.policy.json");
const seedPrefix = "pursuit-train-v1";
const rng = new Random(seedPrefix);
const policy = { schemaVersion: PURSUIT_POLICY_VERSION, algorithm: "tabular-q-learning",
  id: "pursuit-tactical-v2", actions: [...PURSUIT_ACTIONS], seedPrefix, episodes: 0, q: {} };
const values = (key) => (policy.q[key] ??= PURSUIT_ACTIONS.map(() => 0));
let updates = 0;
for (let episode = 0; episode < episodes; episode++) {
  const level = Math.min(4, 1 + Math.floor(episode * 4 / episodes));
  const epsilon = Math.max(.08, .5 * Math.exp(-episode / 24));
  const summary = runPursuitTrial({
    seed: `${seedPrefix}-${episode}`, level, policy, arm: "training", maxSeconds: 30,
    choose: (_key, safe, best) => rng.next() < epsilon ? rng.pick(safe) : best,
    learn: (state, action, reward, next, safe, done) => {
      const current = values(state);
      const future = done || !safe?.length ? 0 : Math.max(...safe.map(index => values(next)[index]));
      current[action] += .18 * (reward + .92 * future - current[action]);
      updates++;
    },
  });
  if (summary.errors.length)
    throw new Error(`Training rejected an invalid episode ${episode}: ${summary.errors.join(", ")}`);
  policy.episodes++;
  console.log(JSON.stringify({ episode, level, ...summary }));
}
validatePursuitPolicy(policy);
await mkdir(dirname(output), { recursive: true });
await writeFile(`${output}.tmp`, JSON.stringify(policy, null, 2) + "\n");
await rename(`${output}.tmp`, output);
console.log(JSON.stringify({ policy: output, episodes, updates, learnedRows: Object.keys(policy.q).length }));
