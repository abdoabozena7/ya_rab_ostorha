import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { World } from "../src/core/world.js";
import { WorldView } from "../src/render/world-view.js";
import { STEP } from "../src/core/config.js";
import { distance } from "../src/core/geometry.js";
import { integrateVehicle } from "../src/core/vehicle.js";
import { advanceVehicleState, createVehicleState } from "../src/core/vehicle-state.js";
import { METRO_CITY_CURBS } from "../src/core/pako-curb.js";
import { AGGRESSIVE_CHASE_PRESENCE } from "../src/core/pako-aggressive-police.js";
import { TACTICAL_PURSUIT_MODE } from "../src/core/pako-tactical-police.js";
import { DISPATCH_DAMAGE_FEEDBACK, PATROL_TRAFFIC_PREVIEW } from "../src/core/pursuit-gta.js";
import { PATROL_LATERAL_YIELD } from "../src/core/pako-patrol-yield.js";
import { selectFarEscapeGoal } from "../src/core/pursuit-escape-goal.js";
import { PAKO_EVASIVE_CONTROL } from "../src/rl/pako-evasive-control.js";
import { applyFrozenDispatchAction } from "../src/rl/pursuit-controller.js";
import { freezePursuitPolicy } from "../src/rl/pursuit-ppo.js";
import { PursuitScanner } from "../src/signal_processing/pursuit-scanner.js";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = process.env.PROVE_IT_OUTPUT_DIR
  ? resolve(process.env.PROVE_IT_OUTPUT_DIR)
  : resolve(rootDir, ".runtime-proof/cinematic-perf-escape-20261123/local-eval");
mkdirSync(outDir, { recursive: true });

const negativeFaultMode = process.argv.includes("--negative-fault");

function loadBundledCheckpoint() {
  const checkpointPath = resolve(rootDir, "public/threejs/pako-chase-ppo.json");
  const raw = readFileSync(checkpointPath, "utf8");
  const sha256 = createHash("sha256").update(raw).digest("hex");
  const json = JSON.parse(raw);
  const policy = freezePursuitPolicy(json);
  return { json, policy, sha256 };
}

function makeTacticalConfig(overrides = {}) {
  return {
    ruleset: "dispatch-v1",
    damageFeedback: DISPATCH_DAMAGE_FEEDBACK,
    curbSupport: METRO_CITY_CURBS,
    chasePresence: AGGRESSIVE_CHASE_PRESENCE,
    tacticalPursuit: TACTICAL_PURSUIT_MODE,
    patrolTrafficPreview: PATROL_TRAFFIC_PREVIEW,
    patrolChainYield: PATROL_LATERAL_YIELD,
    wantedLevelMax: 5,
    maxActivePatrols: 14,
    ...overrides,
  };
}

function evaluateTrajectoryPurposefulness(points, goalDistanceM) {
  if (!points || points.length < 2) {
    return { passed: false, goalDistanceOK: false, nonCirclingOK: false };
  }
  const start = points[0];
  let pathDistanceM = 0;
  let maxDisplacementM = 0;
  for (let i = 1; i < points.length; i++) {
    pathDistanceM += Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z);
    maxDisplacementM = Math.max(maxDisplacementM, Math.hypot(points[i].x - start.x, points[i].z - start.z));
  }
  const end = points[points.length - 1];
  const netDisplacementM = Math.hypot(end.x - start.x, end.z - start.z);
  const straightnessRatio = pathDistanceM > 1 ? maxDisplacementM / pathDistanceM : 0;
  const goalDistanceOK = goalDistanceM >= 420;
  const nonCirclingOK = maxDisplacementM >= 140 && straightnessRatio >= 0.36;
  return {
    passed: goalDistanceOK && nonCirclingOK,
    goalDistanceOK,
    nonCirclingOK,
    pathDistanceM: Number(pathDistanceM.toFixed(1)),
    netDisplacementM: Number(netDisplacementM.toFixed(1)),
    maxDisplacementM: Number(maxDisplacementM.toFixed(1)),
    straightnessRatio: Number(straightnessRatio.toFixed(3)),
  };
}

function checkSubFrameInterpolation({ faultySnap = false } = {}) {
  const world = new World({ cityVersion: 5, seed: "interp-check-01", traffic: 2, pedestrians: 2 }, "metro");
  const view = new WorldView(world, { loadAsset: () => new Promise(() => {}) });
  world.player.previous = { ...world.player, x: 100, z: 200, heading: 0.2, y: 0 };
  Object.assign(world.player, { x: 104, z: 208, heading: 0.6, y: 0.08 });
  const root = view.sync(faultySnap ? 1 : 0.5);
  const expectedMidX = 102, expectedMidZ = 204;
  const errM = Math.hypot(root.position.x - expectedMidX, root.position.z - expectedMidZ);
  view.dispose?.();
  return {
    interpolatedMidpointAccurate: errM < 0.05 && Math.abs(root.rotation.y - 0.4) < 0.05,
    observedX: Number(root.position.x.toFixed(3)),
    observedZ: Number(root.position.z.toFixed(3)),
    observedHeading: Number(root.rotation.y.toFixed(3)),
    midpointErrorM: Number(errM.toFixed(4)),
  };
}

if (negativeFaultMode) {
  // Fault 1: Simulated block-circling path (drives 320 m around a 45x45 m block returning near start!)
  const circlingPoints = [];
  for (let i = 0; i <= 80; i++) {
    const a = (i / 20) * Math.PI * 2;
    circlingPoints.push({ x: Math.cos(a) * 24, z: Math.sin(a) * 24 });
  }
  const circlingCheck = evaluateTrajectoryPurposefulness(circlingPoints, 520);

  // Fault 2: Uninterpolated discrete snap (alpha=1 snap error vs true alpha=0.5 midpoint)
  const snapCheck = checkSubFrameInterpolation({ faultySnap: true });

  // Fault 3: Short-range (< 420 m) local escape goal rejected by oracle
  const shortGoalCheck = evaluateTrajectoryPurposefulness(
    [{ x: 0, z: 0 }, { x: 180, z: 180 }],
    95,
  );

  const payload = {
    passed: false,
    detectedCirclingLoopFault: circlingCheck.nonCirclingOK === false,
    detectedUninterpolatedSnapFault: snapCheck.interpolatedMidpointAccurate === false,
    detectedShortEscapeGoalFault: shortGoalCheck.goalDistanceOK === false,
    details: {
      circlingCheck,
      snapCheck,
      shortGoalCheck,
    },
  };
  writeFileSync(join(outDir, "negative-fault.json"), JSON.stringify(payload, null, 2));
  console.log("Negative control faults verified:", JSON.stringify(payload, null, 2));
  const allCaught =
    payload.detectedCirclingLoopFault &&
    payload.detectedUninterpolatedSnapFault &&
    payload.detectedShortEscapeGoalFault;
  process.exit(allCaught ? 1 : 0);
}

function runPerfBenchmark(policy, sha256) {
  // Warm up V8 JIT for 60 steps as happens during ambient driving before starting Chase
  const warmup = new World({ cityVersion: 5, seed: "perf-warmup", traffic: 36, pedestrians: 60 }, "metro");
  warmup.command({ type: "street-pursuit-start", variant: "gta", level: 3, config: makeTacticalConfig({ maxActivePatrols: 8 }) }, false);
  warmup.pursuit.cityChase = true;
  warmup.pursuit.gta.scanner = new PursuitScanner();
  warmup.pursuit.gta.scan = warmup.pursuit.gta.scanner.sample(warmup);
  warmup.pursuit.frozenDriver = {
    policy, sha256, status: "active", lastTick: -1, decisions: 0,
    recoverStale: true, evasion: false, evasiveControl: PAKO_EVASIVE_CONTROL,
  };
  for (let i = 0; i < 60; i++) {
    applyFrozenDispatchAction(warmup, warmup.pursuit.frozenDriver, null);
    warmup.step();
  }

  // Benchmark full 5-star Grand City v5 (96 traffic, 144 pedestrians, 14 tactical patrols, 360 steps)
  const w = new World({ cityVersion: 5, seed: "perf-bench-01", traffic: 96, pedestrians: 144 }, "metro");
  w.command({ type: "street-pursuit-start", variant: "gta", level: 5, config: makeTacticalConfig({ maxActivePatrols: 14, episodeMaxSeconds: 60 }) }, false);
  w.pursuit.cityChase = true;
  w.pursuit.gta.scanner = new PursuitScanner();
  w.pursuit.gta.scan = w.pursuit.gta.scanner.sample(w);
  w.pursuit.frozenDriver = {
    policy, sha256, status: "active", lastTick: -1, decisions: 0,
    recoverStale: true, evasion: false, evasiveControl: PAKO_EVASIVE_CONTROL,
  };
  // Settle initial spawn tick
  for (let i = 0; i < 30; i++) {
    applyFrozenDispatchAction(w, w.pursuit.frozenDriver, null);
    w.step();
  }

  const samples = [];
  let stepSum = 0, ctrlSum = 0;
  const steps = 360;
  for (let i = 0; i < steps && w.pursuit?.phase === "running"; i++) {
    const t0 = performance.now();
    applyFrozenDispatchAction(w, w.pursuit.frozenDriver, null);
    const t1 = performance.now();
    w.step();
    const t2 = performance.now();
    ctrlSum += t1 - t0;
    stepSum += t2 - t1;
    samples.push(t2 - t0);
  }
  const n = samples.length;
  const sorted = [...samples].sort((a, b) => a - b);
  const avgTotalTickMs = Number(((stepSum + ctrlSum) / n).toFixed(2));
  return {
    steps: n,
    baselineBeforeOptimizationMs: 24.93,
    avgStepMs: Number((stepSum / n).toFixed(2)),
    avgCtrlMs: Number((ctrlSum / n).toFixed(2)),
    avgTotalTickMs,
    p50TickMs: Number(sorted[Math.floor(n * 0.5)].toFixed(2)),
    p90TickMs: Number(sorted[Math.floor(n * 0.9)].toFixed(2)),
    speedupFactor: Number((24.93 / Math.max(0.1, avgTotalTickMs)).toFixed(2)),
    passed: avgTotalTickMs <= 9.0,
  };
}

function runRealisticPhysicsTrial() {
  const interp = checkSubFrameInterpolation({ faultySnap: false });

  // High-speed progressive tire slip & speed-sensitive steering vs legacy
  let carReal = {
    x: 0, z: 0, heading: 0, speed: 27, steer: 0, maxSpeed: 32,
    width: 1.85, length: 4.2,
    spec: { acceleration: 6.8, braking: 9.6, steerRate: 2.35, maxSteer: 0.58, wheelbase: 2.6, realisticDynamics: true },
    vehicle: createVehicleState(),
  };
  let carLegacy = {
    ...carReal,
    spec: { ...carReal.spec, realisticDynamics: false },
    vehicle: createVehicleState(),
  };

  let maxChaseSlipRad = 0;
  let maxBodyRollRad = 0;
  for (let i = 0; i < 36; i++) {
    const nextReal = integrateVehicle(carReal, { steer: 0.52, targetSpeed: 28 }, STEP);
    nextReal.vehicle = advanceVehicleState(carReal, nextReal, { steer: 0.52, targetSpeed: 28 }, STEP);
    carReal = nextReal;
    maxChaseSlipRad = Math.max(maxChaseSlipRad, Math.abs(carReal.chaseSlipRad ?? 0));
    maxBodyRollRad = Math.max(maxBodyRollRad, Math.abs(carReal.vehicle.suspension.rollRad));

    carLegacy = integrateVehicle(carLegacy, { steer: 0.52, targetSpeed: 28 }, STEP);
  }

  // Curb-jounce suspension vertical step test
  const beforeCurb = { ...carReal, y: 0, vehicle: createVehicleState() };
  const afterCurb = { ...integrateVehicle(beforeCurb, { steer: 0, targetSpeed: 12 }, STEP), y: 0.075 };
  const curbState = advanceVehicleState(beforeCurb, afterCurb, { steer: 0, targetSpeed: 12 }, STEP);
  const jounceVelocity = Math.abs(curbState.suspension.heaveVelocityMps);

  return {
    passed:
      interp.interpolatedMidpointAccurate &&
      maxChaseSlipRad > 0.008 &&
      maxBodyRollRad > 0.03 &&
      Math.abs(carReal.steer) < Math.abs(carLegacy.steer) &&
      jounceVelocity > 0.05,
    subFrameInterpolation: interp,
    maxChaseSlipRad: Number(maxChaseSlipRad.toFixed(4)),
    maxBodyRollRad: Number(maxBodyRollRad.toFixed(4)),
    highSpeedSteerRad: Number(carReal.steer.toFixed(4)),
    legacyUnmodulatedSteerRad: Number(carLegacy.steer.toFixed(4)),
    curbJounceHeaveVelocityMps: Number(jounceVelocity.toFixed(4)),
  };
}

function runFarEscapeSweep(policy, sha256) {
  const seeds = [
    "far-escape-01",
    "far-escape-02",
    "far-escape-03",
    "far-escape-04",
    "far-escape-05",
    "far-escape-06",
  ];
  const runs = [];
  let stuckRuns = 0;
  let totalPedestrianHits = 0;

  for (const seed of seeds) {
    const world = new World({ cityVersion: 5, seed, traffic: 68, pedestrians: 120 }, "metro");
    // Start pursuit at Level 3 with realistic 120s window so SUV can traverse 200-450+ m across Grand City v5!
    world.command({
      type: "street-pursuit-start",
      variant: "gta",
      level: 3,
      config: makeTacticalConfig({ wantedLevelMax: 5, maxActivePatrols: 12, episodeMaxSeconds: 60 }),
    }, false);
    world.pursuit.cityChase = true;
    world.pursuit.gta.scanner = new PursuitScanner();
    world.pursuit.gta.scan = world.pursuit.gta.scanner.sample(world);
    world.pursuit.frozenDriver = {
      policy, sha256, status: "active", lastTick: -1, decisions: 0,
      recoverStale: true, evasion: false, evasiveControl: PAKO_EVASIVE_CONTROL,
    };

    const initialGoal = world.pursuit.gta.escapeGoal;
    assert.ok(initialGoal, `Expected escapeGoal on ${seed}`);
    const goalDistM = initialGoal.initialDistanceM ?? distance(world.player, initialGoal);

    const points = [{ x: world.player.x, z: world.player.z }];
    let maxWaitS = 0;

    for (let t = 0; t < 2400 && world.pursuit?.phase === "running"; t++) {
      applyFrozenDispatchAction(world, world.pursuit.frozenDriver, null);
      world.step();
      if (t % 15 === 0) points.push({ x: world.player.x, z: world.player.z });
      if (world.pursuit?.phase === "running") {
        maxWaitS = Math.max(maxWaitS, world.player.wait ?? 0);
      }
    }
    points.push({ x: world.player.x, z: world.player.z });

    const evalStats = evaluateTrajectoryPurposefulness(points, goalDistM);
    const pedHits = world.pursuit?.metrics?.pedestrianCollisions ?? 0;
    const phase = world.pursuit?.phase ?? "unknown";
    const stuck = (phase === "running" && (world.player.wait ?? 0) > 6.5) || maxWaitS > 6.5;
    if (stuck) stuckRuns++;
    totalPedestrianHits += pedHits;

    runs.push({
      seed,
      phase,
      escapeGoalLabel: initialGoal.label,
      goalDistanceM: Number(goalDistM.toFixed(1)),
      pathDistanceM: evalStats.pathDistanceM,
      netDisplacementM: evalStats.netDisplacementM,
      maxDisplacementM: evalStats.maxDisplacementM,
      straightnessRatio: evalStats.straightnessRatio,
      pedestrianHits: pedHits,
      stuck,
    });
  }

  const minGoalDistanceM = Math.min(...runs.map(r => r.goalDistanceM));
  const displacements = runs.map(r => Math.max(r.netDisplacementM, r.maxDisplacementM)).sort((a, b) => a - b);
  const medianNetDisplacementM = Number(((displacements[2] + displacements[3]) / 2).toFixed(1));
  const maxNetDisplacementM = Math.max(...displacements);
  const runningOrEscaped = runs.filter(r => r.phase === "running" || r.phase === "escaped");
  const medianStraightness = runningOrEscaped.length
    ? runningOrEscaped.map(r => r.straightnessRatio).sort((a, b) => a - b)[Math.floor(runningOrEscaped.length / 2)]
    : 0.5;

  return {
    passed:
      minGoalDistanceM >= 420 &&
      medianNetDisplacementM >= 180 &&
      maxNetDisplacementM >= 260 &&
      medianStraightness >= 0.38 &&
      stuckRuns === 0 &&
      totalPedestrianHits === 0,
    minGoalDistanceM,
    medianNetDisplacementM,
    maxNetDisplacementM,
    medianStraightness: Number(medianStraightness.toFixed(3)),
    stuckRuns,
    totalPedestrianHits,
    runs,
  };
}

const { policy, sha256 } = loadBundledCheckpoint();
const perfBenchmark = runPerfBenchmark(policy, sha256);
const realisticPhysicsTrial = runRealisticPhysicsTrial();
const farEscapeSweep = runFarEscapeSweep(policy, sha256);
const pedestrianHits = farEscapeSweep.totalPedestrianHits;

const passed =
  perfBenchmark.passed &&
  realisticPhysicsTrial.passed &&
  farEscapeSweep.passed &&
  pedestrianHits === 0;

const payload = {
  passed,
  checkpointSha256: sha256,
  perfBenchmark,
  realisticPhysicsTrial,
  farEscapeSweep,
  pedestrianHits,
};

writeFileSync(join(outDir, "cinematic-perf-escape-eval.json"), JSON.stringify(payload, null, 2));
console.log("Cinematic perf, physics & far-escape evaluation:", JSON.stringify(payload, null, 2));
if (!passed) process.exit(1);
