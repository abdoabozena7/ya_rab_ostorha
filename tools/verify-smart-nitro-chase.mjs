import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import * as THREE from "three";
import { STEP } from "../src/core/config.js";
import { bodyOnRoad, roadPoseAt } from "../src/core/geometry.js";
import { World } from "../src/core/world.js";
import {
  GRAND_CITY_POPULATION_DEFAULTS,
  GRAND_CITY_POPULATION_LIMITS,
} from "../src/core/unified-city.js";
import { NITRO_SPEC, stepNitroTank } from "../src/core/pursuit-controls.js";
import { METRO_CITY_CURBS } from "../src/core/pako-curb.js";
import { AGGRESSIVE_CHASE_PRESENCE } from "../src/core/pako-aggressive-police.js";
import {
  TACTICAL_PURSUIT_MODE,
  tacticalPatrolSpec,
} from "../src/core/pako-tactical-police.js";
import { DISPATCH_DAMAGE_FEEDBACK, PATROL_TRAFFIC_PREVIEW } from "../src/core/pursuit-gta.js";
import { PATROL_LATERAL_YIELD } from "../src/core/pako-patrol-yield.js";
import { PAKO_EVASIVE_CONTROL, planPakoEvasiveAction } from "../src/rl/pako-evasive-control.js";
import { applyFrozenDispatchAction } from "../src/rl/pursuit-controller.js";
import { freezePursuitPolicy } from "../src/rl/pursuit-ppo.js";
import {
  CITY_CLEAR_CINEMATIC_GRADE,
  DEFAULT_CINEMATIC_GRADE,
} from "../src/render/cinematic-post.js";
import { WorldView } from "../src/render/world-view.js";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = process.env.PROVE_IT_OUTPUT_DIR
  ? resolve(process.env.PROVE_IT_OUTPUT_DIR)
  : resolve(rootDir, ".runtime-proof/smart-nitro-chase-crowd-lighting-20261124/local-eval");
mkdirSync(outDir, { recursive: true });

const negativeFaultMode = process.argv.includes("--negative-fault");

function loadBuiltInChasePolicy() {
  const bytes = readFileSync(resolve(rootDir, "public/threejs/pako-chase-ppo.json"));
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const raw = JSON.parse(bytes.toString("utf8"));
  const allowlist = JSON.parse(
    readFileSync(resolve(rootDir, "config/pako-release-policies.json"), "utf8"),
  );
  const releaseEntry = (allowlist?.verified ?? []).find(
    (entry) => entry.sha256 === sha256 && entry.observation === raw.observation,
  );
  return {
    policy: freezePursuitPolicy(raw),
    sha256,
    releaseAllowlisted: Boolean(releaseEntry && releaseEntry.evasionProfile === "bounded-recovery-v1"),
  };
}

function startMetroFiveStarChase(world, policy, level = 5) {
  world.command({
    type: "street-pursuit-start",
    level,
    variant: "gta",
    config: {
      ruleset: "dispatch-v1",
      damageFeedback: DISPATCH_DAMAGE_FEEDBACK,
      wantedLevelMax: 5,
      maxActivePatrols: 14,
      curbSupport: METRO_CITY_CURBS,
      chasePresence: AGGRESSIVE_CHASE_PRESENCE,
      tacticalPursuit: TACTICAL_PURSUIT_MODE,
      patrolTrafficPreview: PATROL_TRAFFIC_PREVIEW,
      patrolChainYield: PATROL_LATERAL_YIELD,
    },
  });
  world.pursuit.cityChase = true;
  world.pursuit.frozenDriver = {
    policy,
    sha256: "builtin-eval",
    status: "active",
    lastTick: -1,
    decisions: 0,
    recoverStale: true,
    evasion: true,
    evasiveControl: PAKO_EVASIVE_CONTROL,
  };
}

function stepChaseTicks(world, ticks, onTick = null, customControl = null, onDecisionBeforeStep = null) {
  for (let i = 0; i < ticks; i++) {
    if (world.pursuit?.phase !== "running") break;
    if (customControl) {
      customControl(i, world);
    } else {
      applyFrozenDispatchAction(world, world.pursuit.frozenDriver);
    }
    if (onDecisionBeforeStep) onDecisionBeforeStep(i, world);
    world.step();
    if (onTick) onTick(i, world);
  }
}

const {
  policy,
  sha256: builtInPolicySha256,
  releaseAllowlisted: builtInPolicyReleaseAllowlisted,
} = loadBuiltInChasePolicy();

// 1. Multi-seed 5-star smooth low-collision RL + tactical police audit (100% constant scenario across positive & isolated faults!)
function evaluateSmoothSmartRlAndPolice({
  faultSawtoothSteer = false,
  faultDisableEvasiveCollisionDodge = false,
} = {}) {
  const seeds = ["smart-chase-01", "smart-chase-02", "smart-chase-03", "smart-chase-04"];
  let totalSteerSamples = 0;
  let totalAbsSteerDelta = 0;
  let totalPedestrianCollisions = 0;
  let totalCollisions = 0;
  let totalTrafficCollisions = 0;
  let baselineTotalCollisions = 0;
  let totalDistanceM = 0;
  let sawActiveTacticalPursuit = false;
  let maxOpeningPatrolsBeforeStep = 0;
  const perSeed = [];

  for (const seed of seeds) {
    // Baseline: raw un-evasive controller without PAKO_EVASIVE_CONTROL proactive dodge
    const baseWorld = new World({ seed, cityVersion: 5 }, "metro");
    startMetroFiveStarChase(baseWorld, policy);
    baseWorld.pursuit.frozenDriver.evasiveControl = null;
    baseWorld.pursuit.frozenDriver.evasion = false;
    stepChaseTicks(baseWorld, 420);
    baselineTotalCollisions += baseWorld.pursuit?.metrics?.collisions ?? 0;

    // Hold scenario 100% CONSTANT (exact same seeds, cityVersion 5, default 68 traffic, 190 pedestrians, level 5, normal steerRate!)
    const world = new World({ seed, cityVersion: 5 }, "metro");
    startMetroFiveStarChase(world, policy, 5);
    if (world.pursuit.patrols.size > maxOpeningPatrolsBeforeStep) {
      maxOpeningPatrolsBeforeStep = world.pursuit.patrols.size;
    }
    if (faultDisableEvasiveCollisionDodge) {
      world.pursuit.frozenDriver.evasiveControl = null;
    }

    let prevDecisionSteer = null;
    let lastObservedDecisionTick = -1;
    let seedAbsDelta = 0;
    let seedSamples = 0;
    let seedNitroTicks = 0;
    let ditherToggle = 0;
    const startX = world.player.x;
    const startZ = world.player.z;

    stepChaseTicks(
      world,
      420,
      () => {
        if (world.player.nitroActive) seedNitroTicks++;
        if ((world.pursuit?.patrols?.size ?? 0) >= 3) {
          sawActiveTacticalPursuit = true;
        }
      },
      faultSawtoothSteer
        ? (_, w) => {
            const drv = w.pursuit.frozenDriver;
            const beforeTick = drv.lastTick;
            applyFrozenDispatchAction(w, drv);
            if (drv.lastTick !== beforeTick && drv.lastDecision?.submitted) {
              // Inject ONLY alternating +/-1 steer on the identical world/spec so physical wheel delta = 0.235 > 0.22!
              const clean = drv.lastDecision.submitted;
              const jittered = {
                ...clean,
                steer: ++ditherToggle % 2 === 0 ? 1 : -1,
              };
              drv.lastDecision.submitted = jittered;
              w.command({ type: "pursuit-drive", action: jittered });
            }
          }
        : null,
      () => {
        // Sample physical wheel angle at each 10 Hz scan decision instant BEFORE stepping the new command!
        const drv = world.pursuit?.frozenDriver;
        if (drv && drv.lastTick !== lastObservedDecisionTick) {
          lastObservedDecisionTick = drv.lastTick;
          const curWheelSteer = world.player.steer ?? 0;
          if (prevDecisionSteer !== null) {
            const d = Math.abs(curWheelSteer - prevDecisionSteer);
            totalAbsSteerDelta += d;
            seedAbsDelta += d;
            totalSteerSamples++;
            seedSamples++;
          }
          prevDecisionSteer = curWheelSteer;
        }
      },
    );

    const m = world.pursuit?.metrics ?? {};
    const pedCols = m.pedestrianCollisions ?? 0;
    const allCols = m.collisions ?? 0;
    const trafCols = m.trafficCollisions ?? 0;
    const distM =
      Math.hypot(world.player.x - startX, world.player.z - startZ) +
      (world.player.distance ?? 0) * 0.25;
    totalPedestrianCollisions += pedCols;
    totalCollisions += allCols;
    totalTrafficCollisions += trafCols;
    totalDistanceM += distM;
    perSeed.push({
      seed,
      meanAbsSteerDelta: Number((seedAbsDelta / Math.max(1, seedSamples)).toFixed(4)),
      distanceMetricM: Number(distM.toFixed(2)),
      nitroTicks: seedNitroTicks,
      pedestrianCollisions: pedCols,
      trafficCollisions: trafCols,
      collisions: allCols,
      finalPhase: world.pursuit?.phase ?? "unknown",
    });
  }

  // Verify strict zero near-player teleport/spawn when unitsInContact === 0 — instrumented BEFORE world.pursuit assignment!
  const covertWorld = new World({ seed: "no-teleport-check", cityVersion: 5, traffic: 20, pedestrians: 40 }, "metro");
  const preContactRegistrations = [];
  let activeZeroContactRegistrations = 0;
  const origActorsPush = covertWorld.actors.push.bind(covertWorld.actors);
  covertWorld.actors.push = (...items) => {
    for (const item of items) {
      if (item?.pursuitRole === "police") {
        const contactCount = covertWorld.pursuit?.response?.unitsInContact ?? 0;
        const d = Number(Math.hypot(item.x - covertWorld.player.x, item.z - covertWorld.player.z).toFixed(2));
        if (covertWorld.pursuit == null) {
          if (contactCount === 0) preContactRegistrations.push({ id: item.id, distM: d });
        } else if (contactCount === 0) {
          activeZeroContactRegistrations++;
        }
      }
    }
    return origActorsPush(...items);
  };
  startMetroFiveStarChase(covertWorld, policy);
  for (const patrol of covertWorld.pursuit.patrols) {
    patrol.x = covertWorld.player.x + 260;
    patrol.z = covertWorld.player.z + 260;
  }
  covertWorld.pursuit.response.unitsInContact = 0;
  covertWorld.pursuit.response.sightedBy.clear();
  let minPatrolDistWhenHiddenM = Infinity;
  for (let t = 0; t < 30; t++) {
    covertWorld.step();
    if ((covertWorld.pursuit?.response?.unitsInContact ?? 0) === 0) {
      for (const patrol of covertWorld.pursuit.patrols) {
        const d = Math.hypot(patrol.x - covertWorld.player.x, patrol.z - covertWorld.player.z);
        if (d < minPatrolDistWhenHiddenM) minPatrolDistWhenHiddenM = d;
      }
    }
  }

  const meanAbsSteerDelta = totalAbsSteerDelta / Math.max(1, totalSteerSamples);
  const minPreContactDistM = preContactRegistrations.length
    ? Math.min(...preContactRegistrations.map((r) => r.distM))
    : Infinity;

  // Partial-occlusion probe (both aggressive & non-aggressive tacticalPursuit="gta-tactical-v1"):
  // Block the primary eastern sight line (+38 m east across tahrir-boulevard) and verify the pre-contact initial
  // patrol genuinely switches to an unoccluded [66.5..109.5 m] sighted berth (dist >= 66.5 m <= 109.5 m) with real LOS!
  let partialOcclusionVerified = true;
  for (const useAggressive of [true, false]) {
    const occWorld = new World({ seed: "occlusion-probe", cityVersion: 5, traffic: 0, pedestrians: 0 }, "metro");
    occWorld.statics.push({
      id: "occ-east-avenue",
      type: "static",
      kind: "building",
      x: occWorld.player.x + 38,
      z: occWorld.player.z,
      width: 6,
      length: 30,
      heading: 0,
    });
    occWorld.staticIndex = new occWorld.staticIndex.constructor(occWorld.statics);
    const occPreRegs = [];
    const origOccPush = occWorld.actors.push.bind(occWorld.actors);
    occWorld.actors.push = (...items) => {
      for (const it of items) {
        if (it?.pursuitRole === "police" && occWorld.pursuit == null) {
          occPreRegs.push(Math.hypot(it.x - occWorld.player.x, it.z - occWorld.player.z));
        }
      }
      return origOccPush(...items);
    };
    occWorld.command({
      type: "street-pursuit-start",
      level: 5,
      variant: "gta",
      config: {
        ruleset: "dispatch-v1",
        wantedLevelMax: 5,
        maxActivePatrols: 14,
        curbSupport: METRO_CITY_CURBS,
        ...(useAggressive ? { chasePresence: AGGRESSIVE_CHASE_PRESENCE } : {}),
        tacticalPursuit: TACTICAL_PURSUIT_MODE,
      },
    });
    if (
      occPreRegs.length !== 1 ||
      occPreRegs[0] < 66.5 ||
      occPreRegs[0] > 109.5 ||
      (occWorld.pursuit?.response?.unitsInContact ?? 0) < 1
    ) {
      partialOcclusionVerified = false;
    }
  }

  // Total-wall occlusion probe (both aggressive & non-aggressive tacticalPursuit="gta-tactical-v1"):
  // If ALL sight lines are walled off, startStreetPursuit must throw with 0 police actor pushes!
  let totalWallRejectedZeroSight = true;
  let totalWallPolicePushes = 0;
  for (const useAggressive of [true, false]) {
    const totalWallWorld = new World({ seed: "total-wall-probe", cityVersion: 5, traffic: 0, pedestrians: 0 }, "metro");
    const px0 = totalWallWorld.player.x;
    const pz0 = totalWallWorld.player.z;
    totalWallWorld.statics.push(
      { id: "wall-e", type: "static", kind: "building", x: px0 + 14, z: pz0, width: 4, length: 40, heading: 0 },
      { id: "wall-w", type: "static", kind: "building", x: px0 - 14, z: pz0, width: 4, length: 40, heading: 0 },
      { id: "wall-n", type: "static", kind: "building", x: px0, z: pz0 - 14, width: 40, length: 4, heading: 0 },
      { id: "wall-s", type: "static", kind: "building", x: px0, z: pz0 + 14, width: 40, length: 4, heading: 0 },
    );
    totalWallWorld.staticIndex = new totalWallWorld.staticIndex.constructor(totalWallWorld.statics);
    const origWallPush = totalWallWorld.actors.push.bind(totalWallWorld.actors);
    totalWallWorld.actors.push = (...items) => {
      for (const it of items) if (it?.pursuitRole === "police") totalWallPolicePushes++;
      return origWallPush(...items);
    };
    let threwExpected = false;
    try {
      totalWallWorld.command({
        type: "street-pursuit-start",
        level: 5,
        variant: "gta",
        config: {
          ruleset: "dispatch-v1",
          wantedLevelMax: 5,
          maxActivePatrols: 14,
          curbSupport: METRO_CITY_CURBS,
          ...(useAggressive ? { chasePresence: AGGRESSIVE_CHASE_PRESENCE } : {}),
          tacticalPursuit: TACTICAL_PURSUIT_MODE,
        },
      });
    } catch (err) {
      if (String(err?.message || err).includes("No safe GTA patrol deployment")) {
        threwExpected = true;
      }
    }
    if (!threwExpected) totalWallRejectedZeroSight = false;
  }

  const noNearSpawnWithoutContact =
    preContactRegistrations.length <= 1 &&
    minPreContactDistM >= 66.5 &&
    minPreContactDistM <= 109.5 &&
    activeZeroContactRegistrations === 0 &&
    partialOcclusionVerified === true &&
    totalWallRejectedZeroSight === true &&
    totalWallPolicePushes === 0 &&
    minPatrolDistWhenHiddenM > 95 &&
    maxOpeningPatrolsBeforeStep <= 4;
  const collisionReductionPct =
    baselineTotalCollisions > 0
      ? Number((((baselineTotalCollisions - totalCollisions) / baselineTotalCollisions) * 100).toFixed(1))
      : 0;
  const passed =
    builtInPolicyReleaseAllowlisted === true &&
    meanAbsSteerDelta <= 0.22 &&
    totalPedestrianCollisions === 0 &&
    totalCollisions < baselineTotalCollisions &&
    collisionReductionPct >= 50 &&
    totalDistanceM >= 65 &&
    sawActiveTacticalPursuit &&
    noNearSpawnWithoutContact;

  return {
    passed,
    builtInPolicySha256,
    builtInPolicyReleaseAllowlisted,
    seeds: seeds.length,
    meanAbsSteerDelta: Number(meanAbsSteerDelta.toFixed(4)),
    totalPedestrianCollisions,
    totalTrafficCollisions,
    totalCollisions,
    baselineTotalCollisions,
    collisionReductionPct,
    totalDistanceM: Number(totalDistanceM.toFixed(2)),
    sawActiveTacticalPursuit,
    maxOpeningPatrolsBeforeStep,
    preContactRegistrations,
    minPreContactDistM: Number.isFinite(minPreContactDistM) ? Number(minPreContactDistM.toFixed(2)) : null,
    activeZeroContactRegistrations,
    noNearSpawnWithoutContact,
    minPatrolDistWhenHiddenM: Number(minPatrolDistWhenHiddenM.toFixed(2)),
    perSeed,
  };
}

// 2. Nitro boost top-speed advantage (> 5-star police) + autonomous clear-road boost + hard pedestrian zero-Nitro gate
function placePlayerOnOpenAvenue(world, offsetAlong = -90) {
  const avenue =
    world.drivingRoads.find(
      (r) =>
        r.zone === "avenue" &&
        !Number.isFinite(r.x1) &&
        Number.isFinite(r.min) &&
        Number.isFinite(r.max) &&
        r.max - r.min >= 260,
    ) ?? world.drivingRoads[0];
  const mid = (avenue.min + avenue.max) * 0.5 + offsetAlong;
  const pose = roadPoseAt(avenue, mid, 2.0, 1);
  if (pose && bodyOnRoad({ ...world.player, x: pose.x, z: pose.z, heading: pose.heading }, world.roads)) {
    world.player.x = pose.x;
    world.player.z = pose.z;
    world.player.heading = pose.heading;
  }
}

function evaluateNitroBoostAndPedSafety({
  faultIgnorePedestrianNitroOnly = false,
  faultPedestrianCollisionOnly = false,
  faultNarrowCenterBeamOnly = false,
} = {}) {
  const interceptor5StarMaxSpeedMps = tacticalPatrolSpec("interceptor", 5).maxSpeed;

  // 2a. Open straightaway top-speed benchmark with Nitro active (> 5-star interceptor 38.05 m/s!)
  const speedWorld = new World({ seed: "nitro-top-speed", cityVersion: 5, traffic: 0, pedestrians: 0 }, "metro");
  placePlayerOnOpenAvenue(speedWorld, -90);
  speedWorld.player.speed = 24.0;
  speedWorld.player.nitroCharge = 1.0;
  startMetroFiveStarChase(speedWorld, policy);
  speedWorld.command({ type: "mode", mode: "manual" });

  let peakNitroSpeedMps = 0;
  for (let i = 0; i < 210; i++) {
    speedWorld.player.nitroCharge = 1.0;
    speedWorld.command({
      type: "pursuit-drive",
      action: { steer: 0, throttle: 1, brake: 0, gear: 1, nitro: 1 },
    });
    speedWorld.step();
    if (speedWorld.player.speed > peakNitroSpeedMps) {
      peakNitroSpeedMps = speedWorld.player.speed;
    }
  }

  // 2b. Autonomous RL/planner Nitro engagement on clear avenue under pursuit pressure
  const clearAutoWorld = new World({ seed: "auto-nitro-clear", cityVersion: 5, traffic: 0, pedestrians: 0 }, "metro");
  clearAutoWorld.player.x = -175;
  clearAutoWorld.player.z = -109.5;
  clearAutoWorld.player.heading = Math.PI / 2;
  clearAutoWorld.player.speed = 14.0;
  startMetroFiveStarChase(clearAutoWorld, policy);
  if (clearAutoWorld.pursuit?.gta) clearAutoWorld.pursuit.gta.escapeGoal = null;
  clearAutoWorld.statics = clearAutoWorld.statics.filter(
    (s) => !clearAutoWorld.pursuit.closures?.has(s) && s.kind !== "parked-vehicle",
  );
  clearAutoWorld.staticIndex = new clearAutoWorld.staticIndex.constructor(clearAutoWorld.statics);
  for (const p of clearAutoWorld.pursuit.patrols) {
    p.x = -205;
    p.z = -109.5;
    p.heading = Math.PI / 2;
    p.speed = 18.0;
  }
  clearAutoWorld.actorIndex = new clearAutoWorld.actorIndex.constructor(clearAutoWorld.actors);
  clearAutoWorld.pursuit.gta.scanner = new clearAutoWorld.pursuit.gta.scanner.constructor();
  clearAutoWorld.pursuit.gta.scan = clearAutoWorld.pursuit.gta.scanner.sample(clearAutoWorld);

  let autoNitroEngagedTicks = 0;
  stepChaseTicks(clearAutoWorld, 120, (_, w) => {
    if (w.player.nitroActive) autoNitroEngagedTicks++;
  });

  // 2c. Hard Pedestrian Zero-Nitro Safety Gate (100% constant scenario across normal & both single-variable faults!)
  const pedGateWorld = new World({ seed: "cairo-42", cityVersion: 5, traffic: 0, pedestrians: 0 }, "metro");
  pedGateWorld.player.x = -175;
  pedGateWorld.player.z = -109.5;
  pedGateWorld.player.heading = Math.PI / 2;
  pedGateWorld.player.speed = 11.5;
  startMetroFiveStarChase(pedGateWorld, policy);
  if (pedGateWorld.pursuit?.gta) pedGateWorld.pursuit.gta.escapeGoal = null;
  pedGateWorld.statics = pedGateWorld.statics.filter(
    (s) => !pedGateWorld.pursuit.closures?.has(s) && s.kind !== "parked-vehicle",
  );
  pedGateWorld.staticIndex = new pedGateWorld.staticIndex.constructor(pedGateWorld.statics);
  for (const p of pedGateWorld.pursuit.patrols) {
    p.x = -208;
    p.z = -109.5;
    p.heading = Math.PI / 2;
    p.speed = 14.0;
  }
  pedGateWorld.actorIndex = new pedGateWorld.actorIndex.constructor(pedGateWorld.actors);
  pedGateWorld.pursuit.gta.scanner = new pedGateWorld.pursuit.gta.scanner.constructor();
  pedGateWorld.pursuit.gta.scan = pedGateWorld.pursuit.gta.scanner.sample(pedGateWorld);
  if (faultIgnorePedestrianNitroOnly) {
    // Mutate ONLY _faultIgnorePedestrianNitroOnly — policy, evasiveControl, shield, speed, and all 20 pedestrians stay 100% untouched!
    pedGateWorld.pursuit.frozenDriver._faultIgnorePedestrianNitroOnly = true;
  }
  applyFrozenDispatchAction(pedGateWorld, pedGateWorld.pursuit.frozenDriver);
  pedGateWorld.command({ type: "spawn-crowd-ahead", count: 20 });

  if (faultPedestrianCollisionOnly) {
    // Mutate ONLY _faultIgnorePedestrianCollisionOnly — speed, policy, evasiveControl, Nitro suppression, and vehicle/static shield all stay 100% real!
    pedGateWorld.pursuit.frozenDriver._faultIgnorePedestrianCollisionOnly = true;
  }

  let nitroTicksWithPedHazard = 0;
  let sawPedSuppressedFlag = Boolean(pedGateWorld.player.nitroSuppressedByPedestrian);
  for (let i = 0; i < 210; i++) {
    if (pedGateWorld.pursuit?.phase !== "running") break;
    applyFrozenDispatchAction(pedGateWorld, pedGateWorld.pursuit.frozenDriver);
    const submittedAction = pedGateWorld.pursuit.frozenDriver.lastDecision?.submitted ?? null;
    if (pedGateWorld.player.nitroSuppressedByPedestrian) sawPedSuppressedFlag = true;
    const scan = pedGateWorld.pursuit.gta.scan;
    const hasCloseFrontPed =
      scan.rays.some(
        (ray, idx) => (idx <= 8 || idx >= 64) && ray.kind === "pedestrian" && ray.rangeM <= 38,
      ) ||
      scan.tracks.some(
        (tr) => tr.kind === "pedestrian" && tr.forwardM > 0 && tr.forwardM <= 38 && Math.abs(tr.rightM) <= 6.5,
      );
    pedGateWorld.step();
    if (hasCloseFrontPed && ((submittedAction?.nitro ?? 0) > 0 || pedGateWorld.player.nitroActive)) {
      nitroTicksWithPedHazard++;
    }
  }
  const pedHits = pedGateWorld.pursuit?.metrics?.pedestrianCollisions ?? 0;

  // Verify 104m Full-Corridor Forward Radar gates stopping horizon at high speed — INCLUDING laterally offset obstacles (62m ahead, 1.5m sideways)!
  const horizonCheckWorld = new World({ seed: "horizon-radar-gate", cityVersion: 5, traffic: 0, pedestrians: 0 }, "metro");
  startMetroFiveStarChase(horizonCheckWorld, policy);
  if (faultNarrowCenterBeamOnly) {
    horizonCheckWorld.pursuit.frozenDriver._faultNarrowCenterBeamOnly = true;
  }
  if (horizonCheckWorld.pursuit?.gta) horizonCheckWorld.pursuit.gta.escapeGoal = null;
  horizonCheckWorld.statics = horizonCheckWorld.statics.filter(
    (s) => !horizonCheckWorld.pursuit.closures?.has(s) && s.kind !== "parked-vehicle",
  );
  horizonCheckWorld.staticIndex = new horizonCheckWorld.staticIndex.constructor(horizonCheckWorld.statics);
  for (const p of horizonCheckWorld.pursuit.patrols) {
    p.x = -197;
    p.z = -109.5;
    p.heading = Math.PI / 2;
    p.speed = 37.5;
  }
  horizonCheckWorld.player.x = -175;
  horizonCheckWorld.player.z = -109.5;
  horizonCheckWorld.player.heading = Math.PI / 2;
  horizonCheckWorld.player.speed = 38.0;
  horizonCheckWorld.player.nitroCharge = 1.0;
  horizonCheckWorld.actorIndex = new horizonCheckWorld.actorIndex.constructor(horizonCheckWorld.actors);
  horizonCheckWorld.pursuit.gta.scanner = new horizonCheckWorld.pursuit.gta.scanner.constructor();
  const clearLongScan = horizonCheckWorld.pursuit.gta.scanner.sample(horizonCheckWorld);
  horizonCheckWorld.pursuit.gta.scan = clearLongScan;
  applyFrozenDispatchAction(horizonCheckWorld, horizonCheckWorld.pursuit.frozenDriver);
  const nitroAllowedWhen96mClear = (horizonCheckWorld.pursuit.frozenDriver.lastDecision?.submitted?.nitro ?? 0) >= 0.5;
  // Place a civilian vehicle 62m ahead AND 1.5m sideways (overlapping the SUV's swept path!) -> must inhibit Nitro at 38 m/s!
  const farOffsetBlocker = horizonCheckWorld.makeVehicle("radar-62m-offset-1p5m", "sedan", {
    x: -113,
    z: -109.5 + 1.5,
    heading: Math.PI / 2,
  });
  farOffsetBlocker.speed = 0;
  horizonCheckWorld.actors.push(farOffsetBlocker);
  horizonCheckWorld.actorIndex = new horizonCheckWorld.actorIndex.constructor(horizonCheckWorld.actors);
  horizonCheckWorld.pursuit.gta.scanner = new horizonCheckWorld.pursuit.gta.scanner.constructor();
  const blocked62mOffsetScan = horizonCheckWorld.pursuit.gta.scanner.sample(horizonCheckWorld);
  horizonCheckWorld.pursuit.gta.scan = blocked62mOffsetScan;
  horizonCheckWorld.pursuit.frozenDriver.lastTick = -1;
  applyFrozenDispatchAction(horizonCheckWorld, horizonCheckWorld.pursuit.frozenDriver);
  const nitroBlockedWhen62mOffset1p5m = (horizonCheckWorld.pursuit.frozenDriver.lastDecision?.submitted?.nitro ?? 0) === 0;
  const stoppingHorizonSensorVerified =
    clearLongScan.longRangeForward?.maxRangeM === 104 &&
    clearLongScan.longRangeForward?.minCorridorM >= 103 &&
    blocked62mOffsetScan.longRangeForward?.minCorridorM < 64 &&
    nitroAllowedWhen96mClear === true &&
    nitroBlockedWhen62mOffset1p5m === true;

  // Recharge verification
  const dummyTank = { nitroCharge: 0.25, nitroActive: false, nitroIntensity: 0, nitroSuppressedByPedestrian: false, speed: 10 };
  stepNitroTank(dummyTank, { steer: 0, throttle: 1, brake: 0, gear: 1 }, 1.0);
  const rechargedAfter1s = dummyTank.nitroCharge > 0.35;

  const passed =
    peakNitroSpeedMps > interceptor5StarMaxSpeedMps &&
    autoNitroEngagedTicks > 0 &&
    sawPedSuppressedFlag &&
    nitroTicksWithPedHazard === 0 &&
    pedHits === 0 &&
    stoppingHorizonSensorVerified &&
    rechargedAfter1s;

  return {
    passed,
    interceptor5StarMaxSpeedMps: Number(interceptor5StarMaxSpeedMps.toFixed(2)),
    nitroSpecMaxBoostMps: NITRO_SPEC.maxBoostSpeedMps,
    peakNitroSpeedMps: Number(peakNitroSpeedMps.toFixed(2)),
    autoNitroEngagedTicks,
    sawPedSuppressedFlag,
    nitroTicksWithPedHazard,
    pedHits,
    stoppingHorizonSensorVerified,
    rechargedAfter1s,
  };
}

// 3. Live 20-pedestrian crowd-ahead spawn (including T-junction forward projection 22..42m!) & autonomous evasion audit
function evaluateCrowdAheadSpawnAndEvasion({
  faultCrowdTooCloseOnly = false,
  faultCrowdStaticOnly = false,
} = {}) {
  const world = new World({ seed: "crowd-ahead-live-eval", cityVersion: 5 }, "metro");
  assert.equal(GRAND_CITY_POPULATION_DEFAULTS.pedestrians, 190);
  assert.equal(GRAND_CITY_POPULATION_LIMITS.pedestrians, 280);

  startMetroFiveStarChase(world, policy);
  stepChaseTicks(world, 30);

  const px0 = world.player.x;
  const pz0 = world.player.z;
  const fx0 = Math.sin(world.player.heading ?? 0);
  const fz0 = Math.cos(world.player.heading ?? 0);
  const rx0 = Math.cos(world.player.heading ?? 0);
  const rz0 = -Math.sin(world.player.heading ?? 0);
  world.command({ type: "spawn-crowd-ahead", count: 20 });

  if (faultCrowdTooCloseOnly) {
    // Pull spawned walkers along their own valid road corridor to ~12..20 m ahead (preserving valid targets & walking!),
    // Shift forward corridor by -6.0 m (~16.7 m ahead < 22.0 m) while keeping walking routes intact,
    // proving the [22..42 m] forward-corridor oracle ALONE rejects < 22 m placement while movedWalkers >= 16 stays true!
    const faultIds = new Set(world.lastCrowdSpawn?.ids ?? []);
    let shiftedCount = 0;
    for (const actor of world.actors) {
      if (!faultIds.has(actor.id)) continue;
      if (shiftedCount < 4) {
        actor.x -= fx0 * 6.0;
        actor.z -= fz0 * 6.0;
        if (actor.previous) {
          actor.previous.x = actor.x;
          actor.previous.z = actor.z;
        }
        shiftedCount++;
      }
    }
  } else if (faultCrowdStaticOnly) {
    // Keep exact [22..42 m] placement untouched, freeze walkers so ONLY movedWalkers < 16 fails!
    const faultIds = new Set(world.lastCrowdSpawn?.ids ?? []);
    for (const actor of world.actors) {
      if (!faultIds.has(actor.id)) continue;
      actor.speed = 0;
      actor.motionMode = "stop";
    }
  }

  const summary = world.lastCrowdSpawn;
  const spawnedIds = new Set(summary?.ids ?? []);
  const initialPositions = new Map();
  const headings = new Set();
  let trueMinProjectionM = Infinity;
  let trueMaxProjectionM = -Infinity;

  for (const actor of world.actors) {
    if (spawnedIds.has(actor.id)) {
      initialPositions.set(actor.id, { x: actor.x, z: actor.z });
      headings.add(Math.round((actor.heading ?? 0) * 4));
      const projM = (actor.x - px0) * fx0 + (actor.z - pz0) * fz0;
      if (projM < trueMinProjectionM) trueMinProjectionM = projM;
      if (projM > trueMaxProjectionM) trueMaxProjectionM = projM;
    }
  }

  // Test spawning across a 4-way avenue intersection (civic-avenue at z = -98 facing north toward station-avenue z = -75)
  const juncWorld = new World({ seed: "crowd-junc-check", cityVersion: 5, traffic: 0, pedestrians: 0 }, "metro");
  juncWorld.player.x = -183 + 2.2;
  juncWorld.player.z = -104;
  juncWorld.player.heading = 0;
  const jx = juncWorld.player.x;
  const jz = juncWorld.player.z;
  const jfx = Math.sin(juncWorld.player.heading);
  const jfz = Math.cos(juncWorld.player.heading);
  const jrx = Math.cos(juncWorld.player.heading);
  const jrz = -Math.sin(juncWorld.player.heading);
  juncWorld.command({ type: "spawn-crowd-ahead", count: 20 });
  const juncSummary = juncWorld.lastCrowdSpawn;
  const juncIds = new Set(juncSummary?.ids ?? []);
  let juncTrueMinProjM = Infinity;
  let juncTrueMaxProjM = -Infinity;
  let juncTrueMaxAbsLatM = 0;
  let juncTrueMinEuclidM = Infinity;
  for (const actor of juncWorld.actors) {
    if (!juncIds.has(actor.id)) continue;
    const proj = (actor.x - jx) * jfx + (actor.z - jz) * jfz;
    const absLat = Math.abs((actor.x - jx) * jrx + (actor.z - jz) * jrz);
    const euc = Math.hypot(actor.x - jx, actor.z - jz);
    if (proj < juncTrueMinProjM) juncTrueMinProjM = proj;
    if (proj > juncTrueMaxProjM) juncTrueMaxProjM = proj;
    if (absLat > juncTrueMaxAbsLatM) juncTrueMaxAbsLatM = absLat;
    if (euc < juncTrueMinEuclidM) juncTrueMinEuclidM = euc;
  }
  const juncReportMatchesTruth =
    juncIds.size === 20 &&
    juncTrueMaxAbsLatM <= 16.0 &&
    Math.abs((juncSummary?.nearestForwardM ?? -999) - juncTrueMinProjM) <= 0.05;

  stepChaseTicks(world, 240);

  let movedWalkers = 0;
  for (const actor of world.actors) {
    if (!spawnedIds.has(actor.id)) continue;
    const init = initialPositions.get(actor.id);
    if (init && Math.hypot(actor.x - init.x, actor.z - init.z) >= 0.45) {
      movedWalkers++;
    }
  }

  // Test all 6 named road-ends & perimeter junctions in active 5-star Chase:
  // - Reachable upcoming streets (bab-el-louk-S, entry-local-N) must spawn 20 with BOTH 22 <= rawFwd <= 42 AND absLat <= 16 m!
  // - Dead-end walls / outer map boundary (bab-el-louk-N, east-conn-N, east-conn-S, alley-east-S) must return ok: false, spawned: 0
  //   and preserve the existing 20-walker wave rather than dumping walkers > 16 m sideways!
  const perimWorld = new World({ seed: "cairo-42", cityVersion: 5 }, "metro");
  startMetroFiveStarChase(perimWorld, policy);
  const roadEndProbes = [
    ["bab-el-louk-S", -32, -304, 0, true],
    ["bab-el-louk-N", -32, -304, Math.PI, false],
    ["entry-local-N", -40, -42, Math.PI, true],
    ["east-conn-N", 54, -34, Math.PI, false],
    ["east-conn-S", 54, 30, 0, false],
    ["alley-east-S", 20, 34, 0, false],
  ];
  let allRoadEndsStrict22To42 = true;
  const roadEndResults = [];
  for (const [label, rx, rz, rh, expectReachable] of roadEndProbes) {
    perimWorld.player.x = rx;
    perimWorld.player.z = rz;
    perimWorld.player.heading = rh;
    const rfx = Math.sin(rh);
    const rfz = Math.cos(rh);
    const rrx = Math.cos(rh);
    const rrz = -Math.sin(rh);
    perimWorld.command({ type: "spawn-crowd-ahead", count: 20 });
    const rs = perimWorld.lastCrowdSpawn;
    if (!expectReachable) {
      const okBlocked = rs?.ok === false && rs?.spawned === 0 && perimWorld.crowdAheadCount === 20;
      if (!okBlocked) allRoadEndsStrict22To42 = false;
      roadEndResults.push({ label, ok: rs?.ok ?? null, spawned: rs?.spawned ?? -1, preservedCrowdCount: perimWorld.crowdAheadCount });
    } else {
      const rIds = new Set(rs?.ids ?? []);
      let rMin = Infinity;
      let rMax = -Infinity;
      let rMaxLat = 0;
      for (const a of perimWorld.actors) {
        if (!rIds.has(a.id)) continue;
        const fwd = (a.x - rx) * rfx + (a.z - rz) * rfz;
        const absLat = Math.abs((a.x - rx) * rrx + (a.z - rz) * rrz);
        if (fwd < rMin) rMin = fwd;
        if (fwd > rMax) rMax = fwd;
        if (absLat > rMaxLat) rMaxLat = absLat;
      }
      const reportExact =
        rs?.ok === true &&
        rIds.size === 20 &&
        rMin >= 22.0 &&
        rMax <= 42.0 &&
        rMaxLat <= 16.0 &&
        Math.abs((rs?.nearestForwardM ?? -999) - rMin) <= 0.02 &&
        Math.abs((rs?.farthestForwardM ?? -999) - rMax) <= 0.02;
      if (!reportExact) allRoadEndsStrict22To42 = false;
      roadEndResults.push({
        label,
        ok: rs?.ok ?? null,
        spawned: rs?.spawned ?? 0,
        trueMinForwardM: Number(rMin.toFixed(2)),
        trueMaxForwardM: Number(rMax.toFixed(2)),
        trueMaxAbsLateralM: Number(rMaxLat.toFixed(2)),
        reportedMinForwardM: Number((rs?.nearestForwardM ?? -1).toFixed(2)),
      });
    }
  }
  perimWorld.player.x = 9999;
  perimWorld.player.z = 9999;
  perimWorld.command({ type: "spawn-crowd-ahead", count: 20 });
  const offMapResult = perimWorld.lastCrowdSpawn;
  const offMapPreservedPrevCrowd =
    offMapResult?.ok === false &&
    offMapResult?.spawned === 0 &&
    perimWorld.crowdAheadCount === 20;

  const escapeDistFromSpawnM = Math.hypot(world.player.x - px0, world.player.z - pz0);
  const pedCollisions = world.pursuit?.metrics?.pedestrianCollisions ?? 0;
  const passed =
    summary?.spawned === 20 &&
    trueMinProjectionM >= 22.0 &&
    trueMaxProjectionM <= 42.0 &&
    juncIds.size === 20 &&
    juncTrueMinProjM >= 22.0 &&
    juncTrueMaxProjM <= 42.0 &&
    juncTrueMinEuclidM >= 22.0 &&
    juncReportMatchesTruth &&
    allRoadEndsStrict22To42 &&
    offMapPreservedPrevCrowd &&
    movedWalkers >= 16 &&
    headings.size >= 3 &&
    escapeDistFromSpawnM >= 18.0 &&
    pedCollisions === 0;

  return {
    passed,
    ambientDefaultPeds: GRAND_CITY_POPULATION_DEFAULTS.pedestrians,
    ambientLimitPeds: GRAND_CITY_POPULATION_LIMITS.pedestrians,
    spawned: summary?.spawned ?? 0,
    nearestForwardM: Number(trueMinProjectionM.toFixed(2)),
    farthestForwardM: Number(trueMaxProjectionM.toFixed(2)),
    juncSpawned: juncIds.size,
    juncTrueMinProjM: Number.isFinite(juncTrueMinProjM) ? Number(juncTrueMinProjM.toFixed(2)) : -1,
    juncTrueMaxProjM: Number.isFinite(juncTrueMaxProjM) ? Number(juncTrueMaxProjM.toFixed(2)) : -1,
    juncTrueMinEuclidM: Number.isFinite(juncTrueMinEuclidM) ? Number(juncTrueMinEuclidM.toFixed(2)) : -1,
    juncReportMatchesTruth,
    allRoadEndsStrict22To42,
    roadEndResults,
    offMapPreservedPrevCrowd,
    movedWalkers,
    distinctHeadingBuckets: headings.size,
    escapeDistFromSpawnM: Number(escapeDistFromSpawnM.toFixed(2)),
    pedestrianCollisions: pedCollisions,
  };
}

// 4. Toned-down police strobe + bright street/SUV visibility lighting audit (real CSS & real 3D scene!)
function evaluateLightingAndStrobe({
  faultCssScreenWashOnly = false,
  faultHaloOpacityOnly = false,
  faultMissingStreetLightOnly = false,
  faultDarkSuvOnly = false,
  faultDarkGradeOnly = false,
} = {}) {
  const rawCss = readFileSync(resolve(rootDir, "src/ui/styles.css"), "utf8");
  const css = faultCssScreenWashOnly
    ? rawCss.replace(/var\(--strobe-intensity,\s*0\)\s*\*\s*0\.24/g, "var(--strobe-intensity, 0) * 0.95")
    : rawCss;
  const multMatches = [...css.matchAll(/var\(--strobe-intensity,\s*0\)\s*\*\s*(0?\.\d+)/g)].map((m) =>
    Number(m[1]),
  );
  const maxCssStrobeMultiplier = multMatches.length ? Math.max(...multMatches) : 1;
  const activeGrade = faultDarkGradeOnly
    ? DEFAULT_CINEMATIC_GRADE
    : CITY_CLEAR_CINEMATIC_GRADE;

  const world = new World({ seed: "lighting-audit", cityVersion: 5, traffic: 8, pedestrians: 20 }, "metro");
  startMetroFiveStarChase(world, policy);
  world.step();
  const view = new WorldView(world);
  const cam = new THREE.PerspectiveCamera(62, 16 / 9, 0.1, 900);
  cam.position.set(world.player.x, 4.5, world.player.z - 8);
  cam.lookAt(world.player.x, 1.2, world.player.z + 15);
  const patrolCam = new THREE.PerspectiveCamera(62, 16 / 9, 0.1, 900);
  const firstPatrol = [...world.pursuit.patrols][0];
  patrolCam.position.set((firstPatrol?.x ?? world.player.x) - 6, 3.5, (firstPatrol?.z ?? world.player.z) - 6);
  patrolCam.lookAt(firstPatrol?.x ?? world.player.x, 1.2, firstPatrol?.z ?? world.player.z);
  view.sync(world.state(), 1);
  view.prepareFrame({ cameras: [cam, patrolCam] });
  view.pursuitView?.update(world, 1);

  if (faultHaloOpacityOnly) {
    const halos = view.scene.getObjectByName("pursuit-lightbar-halos");
    halos?.traverse((obj) => {
      if (obj.material && typeof obj.material.opacity === "number") {
        obj.visible = true;
        obj.material.opacity = 0.85;
      }
    });
  }
  if (faultMissingStreetLightOnly) {
    const keyL = view.scene.getObjectByName("player-street-key-light");
    if (keyL) keyL.parent?.remove(keyL);
  }
  if (faultDarkSuvOnly) {
    view.playerRig.root.traverse((obj) => {
      if (obj.isMesh && obj.material?.color && obj.material.clearcoat >= 0.7) {
        obj.material.color.setHex(0x1f2329);
      }
    });
  }

  let maxHaloSpriteOpacity = 0;
  const haloGroup = view.scene.getObjectByName("pursuit-lightbar-halos");
  haloGroup?.traverse((obj) => {
    if (obj.visible && obj.material && typeof obj.material.opacity === "number") {
      if (obj.material.opacity > maxHaloSpriteOpacity) {
        maxHaloSpriteOpacity = obj.material.opacity;
      }
    }
  });

  const playerStreetLight = view.scene.getObjectByName("player-street-key-light");
  const corridorFillLight = view.scene.getObjectByName("street-corridor-fill-light");
  const redBounce = view.scene.getObjectByName("pursuit-bounce-red");

  let suvBodyLuma = 0;
  view.playerRig.root.traverse((obj) => {
    if (obj.isMesh && obj.material?.color && obj.material.clearcoat >= 0.7) {
      const c = obj.material.color;
      const luma = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
      if (luma > suvBodyLuma) suvBodyLuma = luma;
    }
  });

  view.playerRig.update({ ...world.player, nitroIntensity: 0.9, nitroActive: true });
  let visibleExterior = false;
  view.playerRig.withExteriorChaseCulling(() => {
    visibleExterior = Boolean(view.playerRig.nitroFlames?.visible);
  });
  let visibleSensor = true;
  view.playerRig.withSensorOverlayCulling(() => {
    visibleSensor = Boolean(view.playerRig.nitroFlames?.visible);
  });

  view.dispose();

  const passed =
    DEFAULT_CINEMATIC_GRADE.exposure === 0.82 &&
    activeGrade.exposure >= 1.08 &&
    activeGrade.shadowToe <= 0.025 &&
    maxCssStrobeMultiplier <= 0.28 &&
    maxHaloSpriteOpacity > 0 &&
    maxHaloSpriteOpacity <= 0.30 &&
    Boolean(playerStreetLight) &&
    playerStreetLight.intensity >= 3.0 &&
    Boolean(corridorFillLight) &&
    Boolean(redBounce) &&
    redBounce.distance <= 15 &&
    suvBodyLuma >= 0.75 &&
    visibleExterior === true &&
    visibleSensor === false;

  return {
    passed,
    cityGradeExposure: activeGrade.exposure,
    cityGradeShadowToe: activeGrade.shadowToe,
    maxCssStrobeMultiplier,
    maxHaloSpriteOpacity: Number(maxHaloSpriteOpacity.toFixed(3)),
    hasPlayerStreetKeyLight: Boolean(playerStreetLight),
    playerStreetLightIntensity: playerStreetLight?.intensity ?? 0,
    hasStreetCorridorFillLight: Boolean(corridorFillLight),
    bounceLightDistanceM: redBounce?.distance ?? 99,
    suvBodyLuma: Number(suvBodyLuma.toFixed(3)),
    nitroVisibleExterior: visibleExterior,
    nitroVisibleSensor: visibleSensor,
  };
}

// 5. 210-pedestrian (190 ambient + 20 crowd-ahead) + 68 traffic + 5-star tactical chase 60 FPS CPU benchmark
function evaluatePerfBenchmark210Peds() {
  const world = new World({ seed: "perf-210-chase", cityVersion: 5, pedestrians: 190, traffic: 68 }, "metro");
  startMetroFiveStarChase(world, policy);
  world.command({ type: "spawn-crowd-ahead", count: 20 });
  const totalPedestrians = world.actors.filter((a) => a.type === "pedestrian").length;

  // Warmup
  stepChaseTicks(world, 30);

  const benchTicks = 240;
  const t0 = performance.now();
  stepChaseTicks(world, benchTicks);
  const avgTotalTickMs = (performance.now() - t0) / benchTicks;

  const passed = totalPedestrians >= 205 && avgTotalTickMs <= 11.0;
  return {
    passed,
    totalPedestrians,
    benchTicks,
    avgTotalTickMs: Number(avgTotalTickMs.toFixed(3)),
  };
}

if (negativeFaultMode) {
  // Run EACH fault in strict constant-scenario single-variable isolation through the shared positive oracle functions!
  const faultJerkySteerOnly = evaluateSmoothSmartRlAndPolice({ faultSawtoothSteer: true });
  const faultHighCollisionOnly = evaluateSmoothSmartRlAndPolice({ faultDisableEvasiveCollisionDodge: true });
  const faultPedNitroAutonomous = evaluateNitroBoostAndPedSafety({ faultIgnorePedestrianNitroOnly: true });
  const faultPedCollisionOnly = evaluateNitroBoostAndPedSafety({ faultPedestrianCollisionOnly: true });
  const faultOffsetRadarOnly = evaluateNitroBoostAndPedSafety({ faultNarrowCenterBeamOnly: true });
  const faultCrowdTooCloseOnly = evaluateCrowdAheadSpawnAndEvasion({ faultCrowdTooCloseOnly: true });
  const faultCrowdStaticOnly = evaluateCrowdAheadSpawnAndEvasion({ faultCrowdStaticOnly: true });
  const faultCssScreenWashOnly = evaluateLightingAndStrobe({ faultCssScreenWashOnly: true });
  const faultHaloOpacityOnly = evaluateLightingAndStrobe({ faultHaloOpacityOnly: true });
  const faultMissingStreetLightOnly = evaluateLightingAndStrobe({ faultMissingStreetLightOnly: true });
  const faultDarkSuvOnly = evaluateLightingAndStrobe({ faultDarkSuvOnly: true });
  const faultDarkGradeOnly = evaluateLightingAndStrobe({ faultDarkGradeOnly: true });

  // Verify each single-variable fault failed ONLY on its targeted gate while keeping all unrelated gates valid!
  const detectedJerkyHighCollisionFault =
    !faultJerkySteerOnly.passed &&
    faultJerkySteerOnly.meanAbsSteerDelta > 0.22 &&
    faultJerkySteerOnly.collisionReductionPct >= 50 &&
    faultJerkySteerOnly.totalDistanceM >= 65 &&
    faultJerkySteerOnly.totalPedestrianCollisions === 0 &&
    !faultHighCollisionOnly.passed &&
    faultHighCollisionOnly.meanAbsSteerDelta <= 0.22 &&
    faultHighCollisionOnly.totalDistanceM >= 65 &&
    faultHighCollisionOnly.totalPedestrianCollisions === 0 &&
    faultHighCollisionOnly.collisionReductionPct < 50;

  const detectedPedestrianUnsafeNitroFault =
    !faultPedNitroAutonomous.passed &&
    faultPedNitroAutonomous.nitroTicksWithPedHazard > 0 &&
    faultPedNitroAutonomous.pedHits === 0 &&
    faultPedNitroAutonomous.peakNitroSpeedMps > faultPedNitroAutonomous.interceptor5StarMaxSpeedMps &&
    !faultPedCollisionOnly.passed &&
    faultPedCollisionOnly.nitroTicksWithPedHazard === 0 &&
    faultPedCollisionOnly.sawPedSuppressedFlag === true &&
    faultPedCollisionOnly.pedHits >= 1 &&
    !faultOffsetRadarOnly.passed &&
    faultOffsetRadarOnly.stoppingHorizonSensorVerified === false &&
    faultOffsetRadarOnly.nitroTicksWithPedHazard === 0 &&
    faultOffsetRadarOnly.pedHits === 0;

  const detectedBrokenCrowdSpawnFault =
    !faultCrowdTooCloseOnly.passed &&
    faultCrowdTooCloseOnly.nearestForwardM < 22.0 &&
    faultCrowdTooCloseOnly.movedWalkers >= 16 &&
    faultCrowdTooCloseOnly.pedestrianCollisions === 0 &&
    !faultCrowdStaticOnly.passed &&
    faultCrowdStaticOnly.nearestForwardM >= 22.0 &&
    faultCrowdStaticOnly.movedWalkers === 0 &&
    faultCrowdStaticOnly.pedestrianCollisions === 0;

  const detectedOverpoweringStrobeOrDarkCarFault =
    !faultCssScreenWashOnly.passed &&
    faultCssScreenWashOnly.maxCssStrobeMultiplier === 0.95 &&
    faultCssScreenWashOnly.maxHaloSpriteOpacity <= 0.30 &&
    faultCssScreenWashOnly.hasPlayerStreetKeyLight === true &&
    faultCssScreenWashOnly.suvBodyLuma >= 0.75 &&
    faultCssScreenWashOnly.cityGradeExposure >= 1.08 &&
    !faultHaloOpacityOnly.passed &&
    faultHaloOpacityOnly.maxCssStrobeMultiplier <= 0.28 &&
    faultHaloOpacityOnly.maxHaloSpriteOpacity > 0.30 &&
    faultHaloOpacityOnly.hasPlayerStreetKeyLight === true &&
    faultHaloOpacityOnly.suvBodyLuma >= 0.75 &&
    faultHaloOpacityOnly.cityGradeExposure >= 1.08 &&
    !faultMissingStreetLightOnly.passed &&
    faultMissingStreetLightOnly.maxHaloSpriteOpacity <= 0.30 &&
    faultMissingStreetLightOnly.hasPlayerStreetKeyLight === false &&
    faultMissingStreetLightOnly.suvBodyLuma >= 0.75 &&
    faultMissingStreetLightOnly.cityGradeExposure >= 1.08 &&
    !faultDarkSuvOnly.passed &&
    faultDarkSuvOnly.maxHaloSpriteOpacity <= 0.30 &&
    faultDarkSuvOnly.hasPlayerStreetKeyLight === true &&
    faultDarkSuvOnly.cityGradeExposure >= 1.08 &&
    faultDarkSuvOnly.suvBodyLuma < 0.75 &&
    !faultDarkGradeOnly.passed &&
    faultDarkGradeOnly.maxHaloSpriteOpacity <= 0.30 &&
    faultDarkGradeOnly.hasPlayerStreetKeyLight === true &&
    faultDarkGradeOnly.suvBodyLuma >= 0.75 &&
    faultDarkGradeOnly.cityGradeExposure < 1.08;

  const negCompositePassed =
    faultJerkySteerOnly.passed &&
    faultHighCollisionOnly.passed &&
    faultPedNitroAutonomous.passed &&
    faultPedCollisionOnly.passed &&
    faultOffsetRadarOnly.passed &&
    faultCrowdTooCloseOnly.passed &&
    faultCrowdStaticOnly.passed &&
    faultCssScreenWashOnly.passed &&
    faultHaloOpacityOnly.passed &&
    faultMissingStreetLightOnly.passed &&
    faultDarkSuvOnly.passed &&
    faultDarkGradeOnly.passed;

  const negReport = {
    schema: 1,
    at: new Date().toISOString(),
    mode: "negative-fault",
    passed: negCompositePassed,
    detectedPedestrianUnsafeNitroFault,
    detectedBrokenCrowdSpawnFault,
    detectedOverpoweringStrobeOrDarkCarFault,
    detectedJerkyHighCollisionFault,
    isolatedFaultAudits: {
      faultJerkySteerOnly,
      faultHighCollisionOnly,
      faultPedNitroAutonomous,
      faultPedCollisionOnly,
      faultOffsetRadarOnly,
      faultCrowdTooCloseOnly,
      faultCrowdStaticOnly,
      faultCssScreenWashOnly,
      faultHaloOpacityOnly,
      faultMissingStreetLightOnly,
      faultDarkSuvOnly,
      faultDarkGradeOnly,
    },
  };
  writeFileSync(join(outDir, "negative-fault.json"), JSON.stringify(negReport, null, 2));
  assert.equal(negCompositePassed, false, "Composite passed must be false when real faults are injected");
  assert.equal(detectedPedestrianUnsafeNitroFault, true);
  assert.equal(detectedBrokenCrowdSpawnFault, true);
  assert.equal(detectedOverpoweringStrobeOrDarkCarFault, true);
  assert.equal(detectedJerkyHighCollisionFault, true);
  process.exit(1);
}

const smoothSmartRlAndPoliceAudit = evaluateSmoothSmartRlAndPolice();
const nitroBoostAndPedSafetyAudit = evaluateNitroBoostAndPedSafety();
const crowdAheadSpawnAndEvasionAudit = evaluateCrowdAheadSpawnAndEvasion();
const lightingAndStrobeAudit = evaluateLightingAndStrobe();
const perfBenchmark210Peds = evaluatePerfBenchmark210Peds();

const passed =
  smoothSmartRlAndPoliceAudit.passed &&
  nitroBoostAndPedSafetyAudit.passed &&
  crowdAheadSpawnAndEvasionAudit.passed &&
  lightingAndStrobeAudit.passed &&
  perfBenchmark210Peds.passed;

const report = {
  schema: 1,
  at: new Date().toISOString(),
  passed,
  smoothSmartRlAndPoliceAudit,
  nitroBoostAndPedSafetyAudit,
  crowdAheadSpawnAndEvasionAudit,
  lightingAndStrobeAudit,
  perfBenchmark210Peds,
};

const outPath = join(outDir, "smart-chase-eval.json");
writeFileSync(outPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (!passed) process.exit(1);
