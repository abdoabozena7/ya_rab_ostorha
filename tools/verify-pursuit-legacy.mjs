import { createHash } from "node:crypto";
import { GtaPursuitEnv } from "../src/rl/gta-pursuit-env.js";

const traces = {};
const explicitLegacy = process.argv.includes("--explicit-legacy");
for (const seed of ["cairo-42", "pursuit-preservation"]) {
  for (let wantedLevelStart = 1; wantedLevelStart <= 5; wantedLevelStart++) {
    const env = new GtaPursuitEnv();
    const config = { wantedLevelStart, playerMaxHealth: 1000 };
    if (explicitLegacy) config.ruleset = "legacy";
    env.reset({ seed, config });
    const digest = createHash("sha256");
    const sample = () => {
      digest.update(JSON.stringify(env.world.snapshot()));
      digest.update(Buffer.from(env.getObservation().buffer));
    };
    sample();
    for (const [steer, throttle, brake, gear, duration] of [
      [0, 1, 0, 1, 120], [.13, .8, 0, 1, 60], [-.13, .8, 0, 1, 60],
      [0, 0, 1, 1, 60], [.06, .6, 0, -1, 120],
    ]) {
      for (let t = 0; t < duration && env.world.pursuit.phase === "running"; t += 60) {
        env.world.command({ type: "pursuit-drive", action: { steer, throttle, brake, gear } });
        const r = env.step({ steer, throttle, brake, gear }, 60);
        digest.update(JSON.stringify(r.reward));
        sample();
      }
    }
    digest.update(JSON.stringify(env.world.replay()));
    traces[`${seed}/${wantedLevelStart}`] = { tick: env.world.tick, sha256: digest.digest("hex") };
  }
}
console.log(JSON.stringify(traces, null, 2));
