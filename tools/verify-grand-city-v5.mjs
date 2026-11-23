import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { World } from "../src/core/world.js";
import { SpatialIndex } from "../src/core/spatial-index.js";
import {
  bodyOnRoad,
  distance,
  isDiagonalRoad,
  overlaps,
  pointOnRoad,
  roadFrame,
  roadPointAt,
  roadPoseAt,
  roadRect,
} from "../src/core/geometry.js";
import { planDistrictRoute } from "../src/core/district-navigation.js";
import { METRO_CITY_CURBS, surveyMetroCurb } from "../src/core/pako-curb.js";
import { AGGRESSIVE_CHASE_PRESENCE } from "../src/core/pako-aggressive-police.js";
import { DISPATCH_DAMAGE_FEEDBACK, PATROL_TRAFFIC_PREVIEW } from "../src/core/pursuit-gta.js";
import { PATROL_LATERAL_YIELD } from "../src/core/pako-patrol-yield.js";
import { PAKO_EVASIVE_CONTROL } from "../src/rl/pako-evasive-control.js";
import { applyFrozenDispatchAction } from "../src/rl/pursuit-controller.js";
import { freezePursuitPolicy } from "../src/rl/pursuit-ppo.js";
import { PursuitScanner } from "../src/signal_processing/pursuit-scanner.js";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = process.env.PROVE_IT_OUTPUT_DIR
  ? resolve(process.env.PROVE_IT_OUTPUT_DIR)
  : resolve(rootDir, ".runtime-proof/grand-city-v5-20261122/local-eval");
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

function measureCityMetrics(world) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const r of world.drivingRoads) {
    if (r.parkingBay || r.supportApron) continue;
    const b = roadRect(r);
    minX = Math.min(minX, b.minX);
    maxX = Math.max(maxX, b.maxX);
    minZ = Math.min(minZ, b.minZ);
    maxZ = Math.max(maxZ, b.maxZ);
  }
  const mapWidthM = Number((maxX - minX).toFixed(1));
  const mapDepthM = Number((maxZ - minZ).toFixed(1));
  const mapAreaM2 = Math.round((maxX - minX) * (maxZ - minZ));
  const diagonalRoads = world.drivingRoads.filter(r => !r.parkingBay && !r.supportApron && isDiagonalRoad(r));
  const buildings = world.statics.filter(s => s.kind === "building");
  const parked = world.statics.filter(s => s.kind === "parked-vehicle");
  const sortedWidths = buildings.map(b => Math.max(b.width, b.length)).sort((a, b) => a - b);
  const medianBuildingWidthM = sortedWidths.length
    ? Number(sortedWidths[Math.floor(sortedWidths.length / 2)].toFixed(2))
    : 0;
  const maxBuildingHeightM = buildings.reduce((m, b) => Math.max(m, b.height ?? 0), 0);
  const auditIssues = world.audit();
  return {
    cityVersion: world.config.cityVersion,
    mapWidthM,
    mapDepthM,
    mapAreaM2,
    drivingRoadCount: world.drivingRoads.filter(r => !r.parkingBay && !r.supportApron).length,
    diagonalRoadCount: diagonalRoads.length,
    diagonalRoadIds: diagonalRoads.map(r => r.id),
    buildingCount: buildings.length,
    medianBuildingWidthM,
    maxBuildingHeightM,
    parkedVehicleCount: parked.length,
    crowdHotspotCount: world.district?.hotspots?.crowds?.length ?? 0,
    trafficHotspotCount: world.district?.hotspots?.traffic?.length ?? 0,
    auditIssueCount: auditIssues.length,
    auditIssues: auditIssues.slice(0, 5),
  };
}

function runCrowdHotspotTrial({ guarded, policy, sha256 }) {
  const world = new World({ cityVersion: 5, seed: "v5-crowd-hotspot-trial", traffic: 12, pedestrians: 48 }, "metro");
  const tahrir = world.drivingRoads.find(r => r.id === "tahrir-boulevard");
  assert.ok(tahrir, "Expected tahrir-boulevard in Metro City v5");

  // Position SUV approaching the Tahrir radial crowd hotspot (x = -196 -> -152)
  const startPose = roadPoseAt(tahrir, -206 - tahrir.min + tahrir.min, 1);
  Object.assign(world.player, { ...startPose, x: -206, z: tahrir.fixed + (tahrir.laneOffsetM ?? 2.7), heading: Math.PI / 2, speed: 6.5, steer: 0 });
  world.player.previous = { ...world.player };

  // Ensure no ambient vehicle initially overlaps ego
  for (const a of world.actors) {
    if (a !== world.player && overlaps(a, world.player, 1.5)) {
      a.x += 40;
      a.previous = { ...a };
    }
  }

  world.command({
    type: "street-pursuit-start",
    variant: "gta",
    level: 1,
    config: {
      ruleset: "dispatch-v1",
      damageFeedback: DISPATCH_DAMAGE_FEEDBACK,
      wantedLevelMax: 1,
      maxActivePatrols: 0,
      episodeMaxSeconds: 45,
      ...(guarded ? { curbSupport: METRO_CITY_CURBS, chasePresence: AGGRESSIVE_CHASE_PRESENCE } : {}),
    },
  }, false);

  // Stage a full-width crossing crowd wave across BOTH halves of tahrir-boulevard (-193..-190)
  // flanked by curbside parked vans so the SUV must genuinely wait/yield for the wave to open a gap, then drive through!
  for (const side of [-1, 1]) {
    world.statics.push(Object.freeze({
      id: `crowd-curb-van-${side}`,
      type: "static",
      kind: "parked-vehicle",
      vehicleKind: "van",
      x: -196.5,
      z: tahrir.fixed + side * 6.2,
      width: 2.2,
      length: 7.5,
      height: 2.0,
      heading: Math.PI / 2,
    }));
  }
  world.staticIndex = new SpatialIndex(world.statics);
  // Re-survey curbs so the flanking vans cut the sidewalk beside -196.5 cleanly
  if (guarded) world.pursuit.gta.curb = surveyMetroCurb(world, METRO_CITY_CURBS);

  const walkers = world.actors.filter(a => a.type === "pedestrian").slice(0, 6);
  const waveSpecs = [
    [-197.0, tahrir.fixed - 3.8, tahrir.fixed - 9.0, 1.35],
    [-196.6, tahrir.fixed - 1.5, tahrir.fixed - 9.0, 1.30],
    [-196.2, tahrir.fixed + 0.6, tahrir.fixed - 9.0, 1.25],
    [-196.4, tahrir.fixed + 2.5, tahrir.fixed + 9.0, 1.30],
    [-196.8, tahrir.fixed + 4.3, tahrir.fixed + 9.0, 1.35],
    [-194.5, tahrir.fixed + 1.8, tahrir.fixed + 9.0, 1.25],
  ];
  walkers.forEach((p, idx) => {
    const [px, pz, targetZ, wSpeed] = waveSpecs[idx];
    const h = targetZ > pz ? 0 : Math.PI;
    Object.assign(p, {
      x: px,
      z: pz,
      heading: h,
      speed: wSpeed,
      walkSpeed: wSpeed,
      pause: 0,
      crossing: true,
      motionMode: "ambient",
      target: { x: px, z: targetZ },
      walkRoute: [{ x: px, z: targetZ }],
      district: {
        ...p.district,
        caseId: "crowd-wave",
        stage: "moving",
        routeConstrained: true,
        holdAtTarget: true,
        yieldAtCurb: false,
        origin: { x: px, z: pz },
      },
    });
    p.previous = { ...p };
  });
  world.actorIndex = new SpatialIndex(world.actors);
  world.pursuit.gta.publicRouteGoal = { x: -132, z: tahrir.fixed + (tahrir.laneOffsetM ?? 2.7), heading: Math.PI / 2, roadId: "tahrir-boulevard", id: "east-of-crowd" };
  world.pursuit.gta.scanner = new PursuitScanner();
  world.pursuit.gta.scan = world.pursuit.gta.scanner.sample(world);

  if (guarded) {
    world.pursuit.cityChase = true;
    world.pursuit.frozenDriver = {
      policy,
      sha256,
      status: "active",
      lastTick: -1,
      decisions: 0,
      recoverStale: true,
      evasion: false,
      evasiveControl: PAKO_EVASIVE_CONTROL,
    };
  }

  let observedCrowdPedestrians = 0;
  let minSpeedMps = world.player.speed;
  for (let t = 0; t < 1200 && world.pursuit.phase === "running"; t++) {
    if (guarded) {
      applyFrozenDispatchAction(world, world.pursuit.frozenDriver, null);
    } else {
      world.command({ type: "pursuit-drive", action: { steer: 0, throttle: 1, brake: 0, gear: 1 } }, false);
    }
    const scanPeds = (world.pursuit.gta.scan?.tracks ?? []).filter(tr => tr.kind === "pedestrian" && Math.hypot(tr.rightM, tr.forwardM) < 22).length;
    observedCrowdPedestrians = Math.max(observedCrowdPedestrians, scanPeds);
    world.step();
    minSpeedMps = Math.min(minSpeedMps, Math.abs(world.player.speed));
    if (world.player.x > -158 && world.pursuit.metrics.distanceM >= 45) break;
  }

  return {
    passed:
      observedCrowdPedestrians >= 4 &&
      minSpeedMps < 5.2 &&
      world.pursuit.metrics.distanceM >= 38 &&
      world.pursuit.metrics.pedestrianCollisions === 0,
    observedCrowdPedestrians,
    minSpeedMps: Number(minSpeedMps.toFixed(2)),
    distanceM: Number(world.pursuit.metrics.distanceM.toFixed(2)),
    finalX: Number(world.player.x.toFixed(2)),
    pedestrianCollisions: world.pursuit.metrics.pedestrianCollisions,
    collisions: world.pursuit.metrics.collisions,
  };
}

function runDiagonalAndParkedChicaneTrial({ policy, sha256 }) {
  const world = new World({ cityVersion: 5, seed: "v5-diagonal-parked-trial", traffic: 0, pedestrians: 0 }, "metro");
  const diag = world.drivingRoads.find(r => r.id === "qasr-diagonal") ?? world.drivingRoads.find(isDiagonalRoad);
  assert.ok(diag && isDiagonalRoad(diag), "Expected qasr-diagonal in Metro City v5");
  const f = roadFrame(diag);

  const startPose = roadPoseAt(diag, 28, 1);
  Object.assign(world.player, { ...startPose, speed: 5.5, steer: 0 });
  world.player.previous = { ...world.player };

  world.command({
    type: "street-pursuit-start",
    variant: "gta",
    level: 2,
    config: {
      ruleset: "dispatch-v1",
      damageFeedback: DISPATCH_DAMAGE_FEEDBACK,
      wantedLevelMax: 2,
      maxActivePatrols: 0,
      episodeMaxSeconds: 40,
      curbSupport: METRO_CITY_CURBS,
      chasePresence: AGGRESSIVE_CHASE_PRESENCE,
    },
  }, false);

  // Add a tight staggered chicane of 3 parked cars encroaching into the lane on the diagonal boulevard
  for (const [idx, along, lat] of [
    [1, 52, 2.3],
    [2, 70, -0.4],
    [3, 88, 2.5],
  ]) {
    const pt = roadPointAt(diag, along, lat);
    world.statics.push(Object.freeze({
      id: `diag-chicane-parked-${idx}`,
      type: "static",
      kind: "parked-vehicle",
      vehicleKind: "sedan",
      x: pt.x,
      z: pt.z,
      width: 1.85,
      length: 4.3,
      height: 1.5,
      heading: f.heading,
    }));
  }
  world.staticIndex = new SpatialIndex(world.statics);
  const goalPose = roadPoseAt(diag, Math.min(diag.length - 18, 145), 1);
  world.pursuit.gta.publicRouteGoal = { ...goalPose, roadId: diag.id, id: "diag-goal" };
  world.pursuit.gta.scanner = new PursuitScanner();
  world.pursuit.gta.scan = world.pursuit.gta.scanner.sample(world);

  world.pursuit.cityChase = true;
  world.pursuit.frozenDriver = {
    policy,
    sha256,
    status: "active",
    lastTick: -1,
    decisions: 0,
    recoverStale: true,
    evasion: false,
    evasiveControl: PAKO_EVASIVE_CONTROL,
  };

  for (let t = 0; t < 720 && world.pursuit.phase === "running"; t++) {
    applyFrozenDispatchAction(world, world.pursuit.frozenDriver, null);
    world.step();
    if (world.pursuit.metrics.distanceM >= 85) break;
  }

  return {
    passed: world.pursuit.metrics.distanceM >= 65 && world.pursuit.metrics.collisions === 0,
    roadId: diag.id,
    roadHeadingDeg: Number(((f.heading * 180) / Math.PI).toFixed(1)),
    distanceM: Number(world.pursuit.metrics.distanceM.toFixed(2)),
    collisions: world.pursuit.metrics.collisions,
    pedestrianCollisions: world.pursuit.metrics.pedestrianCollisions,
  };
}

function runGrandCityLevel5Sweep({ policy, sha256 }) {
  const seeds = [
    { label: "v5-default-t0", seed: undefined, warmup: 1 },
    { label: "v5-default-t90", seed: undefined, warmup: 90 },
    { label: "v5-seed-01", seed: "grand-chase-01", warmup: 60 },
    { label: "v5-seed-02", seed: "grand-chase-02", warmup: 60 },
    { label: "v5-seed-03", seed: "grand-chase-03", warmup: 60 },
    { label: "v5-seed-04", seed: "grand-chase-04", warmup: 60 },
    { label: "v5-diag-start-qasr", seed: "grand-diag-qasr", warmup: 30, startDiag: "qasr-diagonal" },
    { label: "v5-diag-start-talaat", seed: "grand-diag-talaat", warmup: 30, startDiag: "talaat-diagonal" },
  ];

  const rows = [];
  let stuckRuns = 0;
  let oscillatingRuns = 0;
  let pedestrianCollisions = 0;
  let diagonalVisits = 0;

  for (const item of seeds) {
    const world = new World(
      {
        cityVersion: 5,
        ...(item.seed ? { seed: item.seed } : {}),
        traffic: 96,
        pedestrians: 150,
      },
      "metro",
    );
    for (let i = 0; i < item.warmup; i++) world.step();

    if (item.startDiag) {
      const diag = world.drivingRoads.find(r => r.id === item.startDiag);
      if (diag) {
        for (const along of [45, 75, 105, 135]) {
          const candidate = { ...world.player, ...roadPoseAt(diag, Math.min(diag.length - 30, along), 1) };
          if (
            bodyOnRoad(candidate, world.roads) &&
            !world.statics.some(s => overlaps(s, candidate, 0.5)) &&
            !world.actors.some(a => a !== world.player && overlaps(a, candidate, 0.8))
          ) {
            Object.assign(world.player, candidate, { speed: 0, steer: 0, wait: 0 });
            world.player.previous = { ...world.player };
            break;
          }
        }
      }
    }

    world.command({
      type: "street-pursuit-start",
      level: 5,
      variant: "gta",
      config: {
        ruleset: "dispatch-v1",
        damageFeedback: DISPATCH_DAMAGE_FEEDBACK,
        wantedLevelMax: 5,
        curbSupport: METRO_CITY_CURBS,
        chasePresence: AGGRESSIVE_CHASE_PRESENCE,
        patrolTrafficPreview: PATROL_TRAFFIC_PREVIEW,
        patrolChainYield: PATROL_LATERAL_YIELD,
      },
    }, false);
    world.pursuit.cityChase = true;
    world.pursuit.frozenDriver = {
      policy,
      sha256,
      status: "active",
      lastTick: -1,
      decisions: 0,
      recoverStale: true,
      evasion: false,
      evasiveControl: PAKO_EVASIVE_CONTROL,
    };

    const diagRoads = world.drivingRoads.filter(isDiagonalRoad);
    let visitedDiagonal = false;
    let maxRunningWaitS = 0;
    let oscillated = false;
    let prevGear = 1;
    let totalGearFlips = 0;
    const samples = [];

    for (let t = 0; t < 2700 && world.pursuit.phase === "running"; t++) {
      applyFrozenDispatchAction(world, world.pursuit.frozenDriver, null);
      const g = world.pursuit.frozenDriver.lastDecision?.submitted?.gear ?? 1;
      if (g !== prevGear) {
        totalGearFlips++;
        prevGear = g;
      }
      world.step();
      if (!visitedDiagonal && pointOnRoad(world.player, diagRoads)) visitedDiagonal = true;
      if (world.pursuit.phase === "running") {
        maxRunningWaitS = Math.max(maxRunningWaitS, world.player.wait ?? 0);
        if (t % 30 === 0) {
          samples.push({
            x: world.player.x,
            z: world.player.z,
            dist: world.pursuit.metrics.distanceM,
            flips: totalGearFlips,
          });
          if (samples.length > 13) {
            const old = samples[samples.length - 13];
            const cur = samples[samples.length - 1];
            if (cur.flips - old.flips >= 4 && cur.dist - old.dist >= 2.2 && Math.hypot(cur.x - old.x, cur.z - old.z) < 3.2) {
              oscillated = true;
            }
          }
        }
      }
    }

    const stuck = (world.pursuit.phase === "running" && (world.player.wait ?? 0) > 6.5) || maxRunningWaitS > 6.5;
    if (stuck) stuckRuns++;
    if (oscillated) oscillatingRuns++;
    if (visitedDiagonal) diagonalVisits++;
    pedestrianCollisions += world.pursuit.metrics.pedestrianCollisions;

    const endedPhase = world.pursuit.phase;
    const finalDistM = Number(world.pursuit.metrics.distanceM.toFixed(1));
    const finalSurvS = Number(world.pursuit.metrics.survivalS.toFixed(1));
    const finalCurbs = world.pursuit.metrics.shoulderEntries;
    const finalPedHits = world.pursuit.metrics.pedestrianCollisions;

    if (world.pursuit.phase === "running") {
      world.command({ type: "street-pursuit-stop" }, false);
    }
    const postAudit = world.audit().filter(x => x.includes("player"));
    assert.equal(bodyOnRoad(world.player, world.roads), true, `${item.label}: off-road after chase end`);
    assert.deepEqual(postAudit, [], `${item.label}: player audit failed: ${JSON.stringify(postAudit)}`);
    world.command({
      type: "street-pursuit-start",
      level: 5,
      variant: "gta",
      config: {
        ruleset: "dispatch-v1",
        damageFeedback: DISPATCH_DAMAGE_FEEDBACK,
        wantedLevelMax: 5,
        curbSupport: METRO_CITY_CURBS,
        chasePresence: AGGRESSIVE_CHASE_PRESENCE,
        patrolTrafficPreview: PATROL_TRAFFIC_PREVIEW,
        patrolChainYield: PATROL_LATERAL_YIELD,
      },
    }, false);
    assert.equal(world.pursuit.phase, "running");
    world.command({ type: "street-pursuit-stop" }, false);

    rows.push({
      case: item.label,
      phase: endedPhase,
      survivalS: finalSurvS,
      distanceM: finalDistM,
      maxRunningWaitS: Number(maxRunningWaitS.toFixed(2)),
      curbEntries: finalCurbs,
      visitedDiagonal,
      pedestrianCollisions: finalPedHits,
      postChaseAuditClean: true,
      runAgainReady: true,
      oscillated,
      stuck,
    });
  }

  const sorted = rows.map(r => r.distanceM).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const medianDistanceM = Number(((sorted[mid - 1] + sorted[mid]) / 2).toFixed(2));

  return {
    totalRuns: rows.length,
    stuckRuns,
    oscillatingRuns,
    diagonalVisits,
    medianDistanceM,
    pedestrianCollisions,
    rows,
  };
}

const { policy: trainedPolicy, sha256 } = loadBundledCheckpoint();

if (negativeFaultMode) {
  const legacyV4World = new World({ cityVersion: 4, traffic: 36, pedestrians: 80 }, "metro");
  const legacyMetrics = measureCityMetrics(legacyV4World);
  const detectedLegacySmallMap =
    legacyMetrics.mapAreaM2 < 550000 &&
    legacyMetrics.diagonalRoadCount === 0 &&
    legacyMetrics.parkedVehicleCount < 45;

  const v5World = new World({ cityVersion: 5, traffic: 0, pedestrians: 0 }, "metro");
  const diag = v5World.drivingRoads.find(isDiagonalRoad);
  const offDiagPt = roadPointAt(diag, diag.length / 2, diag.width / 2 + 6.5);
  const offDiagPose = { ...v5World.player, x: offDiagPt.x, z: offDiagPt.z, heading: roadFrame(diag).heading };
  const detectedDiagonalOffRoadRejection = !bodyOnRoad(offDiagPose, [diag]);

  const blindCrowd = runCrowdHotspotTrial({ guarded: false, policy: trainedPolicy, sha256 });
  const detectedBlindCrowdFault = blindCrowd.pedestrianCollisions > 0;

  const passed = !(detectedLegacySmallMap && detectedDiagonalOffRoadRejection && detectedBlindCrowdFault);
  const report = {
    passed,
    detectedLegacySmallMap,
    detectedDiagonalOffRoadRejection,
    detectedBlindCrowdFault,
    legacyMetrics,
    blindCrowd,
  };
  writeFileSync(join(outDir, "negative-fault.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report));
  process.exit(passed ? 0 : 1);
}

const v5World = new World({ cityVersion: 5 }, "metro");
const cityMetrics = measureCityMetrics(v5World);
const curbSurvey = surveyMetroCurb(v5World, METRO_CITY_CURBS);

// Verify cross-network route planning from orthogonal start onto a diagonal boulevard
const tahrir = v5World.drivingRoads.find(r => r.id === "tahrir-boulevard");
const talaat = v5World.drivingRoads.find(r => r.id === "talaat-diagonal") ?? v5World.drivingRoads.find(isDiagonalRoad);
const routeStart = { ...v5World.player, ...roadPoseAt(tahrir, -230, 1) };
const routeGoal = { ...roadPoseAt(talaat, Math.min(talaat.length - 25, 110), 1), roadId: talaat.id };
const crossDiagRoute = planDistrictRoute(v5World.district, routeStart, routeGoal, []);

const crowdHotspotTrial = runCrowdHotspotTrial({ guarded: true, policy: trainedPolicy, sha256 });
const parkedChicaneTrial = runDiagonalAndParkedChicaneTrial({ policy: trainedPolicy, sha256 });
const v5ChaseSweep = runGrandCityLevel5Sweep({ policy: trainedPolicy, sha256 });

const totalPedestrianHits =
  crowdHotspotTrial.pedestrianCollisions +
  parkedChicaneTrial.pedestrianCollisions +
  v5ChaseSweep.pedestrianCollisions;

const passed =
  cityMetrics.cityVersion === 5 &&
  cityMetrics.mapAreaM2 >= 550000 &&
  cityMetrics.diagonalRoadCount >= 4 &&
  cityMetrics.medianBuildingWidthM >= 26 &&
  cityMetrics.maxBuildingHeightM >= 45 &&
  cityMetrics.parkedVehicleCount >= 45 &&
  cityMetrics.auditIssueCount === 0 &&
  (curbSurvey?.sites?.length ?? 0) >= 80 &&
  crossDiagRoute.length > 10 &&
  crowdHotspotTrial.passed &&
  parkedChicaneTrial.passed &&
  v5ChaseSweep.stuckRuns === 0 &&
  v5ChaseSweep.oscillatingRuns === 0 &&
  v5ChaseSweep.diagonalVisits >= 2 &&
  totalPedestrianHits === 0;

const summary = {
  passed,
  cityMetrics,
  curbSurveySites: curbSurvey?.sites?.length ?? 0,
  diagonalRouteWaypoints: crossDiagRoute.length,
  crowdHotspotTrial,
  parkedChicaneTrial,
  v5ChaseSweep,
  pedestrianHits: totalPedestrianHits,
};

writeFileSync(join(outDir, "grand-city-v5-eval.json"), JSON.stringify(summary, null, 2) + "\n");
console.log(JSON.stringify({
  passed,
  mapAreaM2: cityMetrics.mapAreaM2,
  diagonalRoadCount: cityMetrics.diagonalRoadCount,
  parkedVehicleCount: cityMetrics.parkedVehicleCount,
  medianBuildingWidthM: cityMetrics.medianBuildingWidthM,
  maxBuildingHeightM: cityMetrics.maxBuildingHeightM,
  crowdHotspotPassed: crowdHotspotTrial.passed,
  chicanePassed: parkedChicaneTrial.passed,
  stuckRuns: v5ChaseSweep.stuckRuns,
  oscillatingRuns: v5ChaseSweep.oscillatingRuns,
  pedestrianHits: totalPedestrianHits,
}));
assert.ok(passed, "Grand Metro City v5 evaluation failed one or more acceptance criteria");
