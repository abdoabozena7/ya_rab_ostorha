import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { World } from "../src/core/world.js";
import { overlaps } from "../src/core/geometry.js";
import { Random } from "../src/core/random.js";
import { SpatialIndex } from "../src/core/spatial-index.js";
import { validatePursuitPolicy } from "../src/core/pursuit-policy.js";
import { runPursuitTrial, summarizePursuit } from "./pursuit-trials.mjs";

const families = [
  "short-route-open", "short-route-closes-or-becomes-risky", "rear-close-forward-clear",
  "rear-close-front-blocked-side-clear", "reverse-then-side", "incoming-left-or-right",
  "front-obstruction-with-rear-traffic", "pedestrian-priority-no-safe-exit",
  "legal-gap-and-rejected-cut", "curb-bypass-and-return", "boxed-in-multi-threat",
  "occluded-stale-and-recovery",
];
const mirroredSeeds = prefix => {
  const seeds = new Map();
  for (let i = 0; i < 32 && seeds.size < 2; i++) {
    const seed = `${prefix}-case-${i}`;
    const side = new Random(`${seed}:pursuit-world-v1`).next() < .5 ? -1 : 1;
    if (!seeds.has(side)) seeds.set(side, seed);
  }
  assert.equal(seeds.size, 2, "Both sides must be represented before running the trials");
  return [...seeds.values()];
};
const obstruct = (world, geometry) => {
  const barrier = { id: "verification-obstruction", type: "static", kind: "barrier", height: .9,
    heading: 0, ...geometry };
  assert.ok(world.actors.every(actor => !overlaps(actor, barrier, .1)), "Obstruction must start clear");
  world.statics.push(barrier);
  world.staticIndex = new SpatialIndex(world.statics);
};
const safetyTwins = (seed) => [
  runPursuitTrial({ seed, caseId: "reverse-then-side", level: 1, arm: "rear-blocked",
    maxSeconds: 14, prepare: world => obstruct(world, { x: 0, z: -5.8, width: 5.4, length: .8 }) }),
  runPursuitTrial({ seed, caseId: "curb-bypass-and-return", level: 1, arm: "shoulder-blocked",
    maxSeconds: 18, prepare: world => obstruct(world, { x: world.roads.find(r => r.pursuitShoulder).fixed,
      z: -6, width: 3.45, length: 1.0 }) }),
];

if (process.argv.includes("--negative")) {
  const world = new World({ seed: "pursuit-negative-0", pursuitLevel: 4 }, "pursuit");
  assert.throws(() => world.command({ type: "pursuit-drive",
    action: { steer: 0, brake: -1, throttle: 1, gear: 1 } }), /normalized/);
  const held = runPursuitTrial({ seed: "pursuit-negative-0", level: 4, arm: "hold", maxSeconds: 14 });
  assert.equal(held.escape, false);
  assert.equal(held.distanceM, 0);
  for (const run of safetyTwins("dev-physical=0")) {
    assert.deepEqual(run.errors, []);
    assert.equal(run.escape, false, run.arm);
    assert.equal(run.collisions, 0, run.arm);
    assert.ok((run.encounter.rejected.obstacle ?? 0) > 0, run.arm);
  }
  console.log("EXPECTED_PURSUIT_FAILURE_DETECTED");
  process.exitCode = 3;
} else {
  const file = process.env.PURSUIT_POLICY_FILE ?? "public/threejs/pursuit.policy.json";
  const policy = validatePursuitPolicy(JSON.parse(await readFile(file, "utf8")));
  const development = process.argv.includes("--development");
  const prefix = development ? "pursuit-dev-v1" : "pursuit-eval-v1";
  assert.notEqual(policy.seedPrefix, prefix);
  const runs = [], levels = [];
  const trials = development ? 1 : 3;
  for (let level = 1; level <= 4; level++) {
    const arms = ["hold", "planner", "learned"];
    for (let index = 0; index < trials; index++) for (const arm of arms) {
      const run = runPursuitTrial({ seed: `${prefix}-${level}-${index}`, level, arm,
        policy: arm === "learned" ? policy : null, maxSeconds: development ? 20 : 36 });
      runs.push(run);
      console.log(JSON.stringify(run));
    }
    levels.push({ level, ...Object.fromEntries(arms.map(arm => [arm, summarizePursuit(
      runs.filter(run => run.level === level && run.arm === arm))])) });
  }
  const learned = runs.filter(run => run.arm === "learned"), allActive = runs.filter(run => run.arm !== "hold");
  const challenges = [], twins = [];
  for (const seed of mirroredSeeds(prefix)) {
    for (const caseId of families) {
      challenges.push(runPursuitTrial({ seed, caseId, level: 1, arm: "named-planner", maxSeconds: 38 }));
    }
    twins.push(...safetyTwins(seed));
  }
  const results = id => challenges.filter(run => run.caseId === id);
  const cleanEscape = run => run.escape && run.collisions === 0;
  const passedTwins = twins.every(run => !run.escape && run.collisions === 0 &&
    (run.encounter.rejected.obstacle ?? 0) > 0 && !run.errors.length);
  const namedChecks = {
    allCasesPhysicallyValid: challenges.every(r => !r.errors.length && r.ticks > 0),
    actualShortExit: results("short-route-open").every(cleanEscape),
    actualClosureDetour: results("short-route-closes-or-becomes-risky").every(closed => {
      const open = results("short-route-open").find(run => run.seed === closed.seed);
      return cleanEscape(closed) && open.escape && closed.eventKinds.includes("closure") &&
        closed.routes.length > 1 && closed.distanceM > open.distanceM + 5;
    }),
    observedRearMakesProgress: results("rear-close-forward-clear").every(r =>
      cleanEscape(r) && r.threatSectors.includes("rear") && r.encounter.earlyForwardM > 8),
    actualSideBypass: results("rear-close-front-blocked-side-clear").every(r =>
      r.encounter.earlyLateralM > 2.5 && r.encounter.earlyForwardM > 7 && r.encounter.earlyContacts === 0 &&
      r.threatSectors.includes("rear") && r.encounter.rejected.traffic > 0),
    lateralResponses: results("incoming-left-or-right").every(r => cleanEscape(r) &&
      r.threatSectors.includes(r.encounter.incomingSide < 0 ? "left" : "right") &&
      r.encounter.earlyForwardM > 5),
    handlesOpposingTraffic: results("front-obstruction-with-rear-traffic").every(r => cleanEscape(r) &&
      r.encounter.simultaneousSectors >= 2 && r.encounter.rejected.traffic > 0),
    pedestrianHold: results("pedestrian-priority-no-safe-exit").every(r => !r.pedestrianCollisions &&
      r.encounter.heldForPerson > 0 && r.firstContact?.side === "rear"),
    protectedPedestrians: challenges.every(r => r.pedestrianCollisions === 0),
    activeSurround: results("boxed-in-multi-threat").every(r => r.policeTactics.length > 1 &&
      r.encounter.simultaneousSectors >= 3 && (r.escape || r.outcome === "captured")),
    actualReverseThenExit: results("reverse-then-side").every(r => r.reverseDistanceM > .5 &&
      r.travelAfterReverseM > 1 && r.maxHeadingChangeRad > .2 && cleanEscape(r)),
    actualRaisedBypassAndReturn: results("curb-bypass-and-return").every(r =>
      r.maxSupportHeightM > .06 && r.shoulderEntries > 0 && r.shoulderExits > 0 && cleanEscape(r)),
    respectsTimedTraffic: results("legal-gap-and-rejected-cut").every(r => cleanEscape(r) &&
      r.encounter.rejected.traffic > 0 && r.encounter.earlyForwardM > 5),
    distinguishesMissingCoverage: results("occluded-stale-and-recovery").every(r => cleanEscape(r) &&
      r.encounter.hiddenReadings > 0) && challenges.some(r => r.encounter.recoveredTracks > 0),
    deniesUnsafeTwins: passedTwins,
  };
  const checks = {
    consistentPlant: runs.every(run => !run.errors.length && run.survivalS > 0),
    moreThanStopOnly: allActive.some(run => run.distanceM > 15) && runs.filter(r => r.arm === "hold").every(run => !run.escape),
    learnedActuallySelected: learned.some(run => run.learnedDecisions > 0 && runs.some(
      baseline => baseline.seed === run.seed && baseline.arm === "planner" && baseline.actionHash !== run.actionHash)),
    variedPursuit: allActive.some(run => run.police > 1) &&
      new Set(allActive.flatMap(run => run.policeTactics)).size >= 2,
    reachesAnExit: allActive.some(run => run.escape),
    ...namedChecks,
  };
  const report = { passed: Object.values(checks).every(Boolean), development,
    policyId: policy.id, trainEpisodes: policy.episodes, evaluationSeedPrefix: prefix,
    levels, checks, runs, challenges, twins };
  const output = process.env.PROVE_IT_OUTPUT_DIR ?? "output/pursuit";
  await mkdir(output, { recursive: true });
  await writeFile(join(output, "pursuit-evaluation.json"), JSON.stringify(report, null, 2));
  if (!report.passed) throw new Error(`Pursuit evaluation needs repair: ${JSON.stringify(checks)}`);
}
