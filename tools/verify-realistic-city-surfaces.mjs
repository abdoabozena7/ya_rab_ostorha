import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { World } from "../src/core/world.js";
import { WorldView } from "../src/render/world-view.js";
import { STEP } from "../src/core/config.js";
import { integrateVehicle } from "../src/core/vehicle.js";
import { createVehicleState, advanceVehicleState } from "../src/core/vehicle-state.js";
import { SURFACE_SPECS, sampleCitySurface, terrainElevationAt } from "../src/core/city-surfaces.js";
import { createEgyptStreetLayer } from "../src/render/egypt-streets.js";
import { METRO_CITY_CURBS } from "../src/core/pako-curb.js";
import { AGGRESSIVE_CHASE_PRESENCE } from "../src/core/pako-aggressive-police.js";
import { TACTICAL_PURSUIT_MODE } from "../src/core/pako-tactical-police.js";
import { DISPATCH_DAMAGE_FEEDBACK, PATROL_TRAFFIC_PREVIEW } from "../src/core/pursuit-gta.js";
import { PATROL_LATERAL_YIELD } from "../src/core/pako-patrol-yield.js";
import { PAKO_EVASIVE_CONTROL } from "../src/rl/pako-evasive-control.js";
import { applyFrozenDispatchAction } from "../src/rl/pursuit-controller.js";
import { freezePursuitPolicy } from "../src/rl/pursuit-ppo.js";
import { PursuitScanner } from "../src/signal_processing/pursuit-scanner.js";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = process.env.PROVE_IT_OUTPUT_DIR
  ? resolve(process.env.PROVE_IT_OUTPUT_DIR)
  : resolve(rootDir, ".runtime-proof/realistic-city-surfaces-20261123/local-eval");
mkdirSync(outDir, { recursive: true });

const negativeFaultMode = process.argv.includes("--negative-fault");

function makeRealisticCar(overrides = {}) {
  return {
    id: "probe",
    type: "vehicle",
    x: 0,
    z: 0,
    heading: 0,
    speed: 0,
    steer: 0,
    length: 4.2,
    width: 1.9,
    maxSpeed: 24,
    chaseSlipRad: 0,
    spec: {
      wheelbase: 2.68,
      maxSteer: 0.62,
      acceleration: 6.4,
      braking: 8.6,
      realisticDynamics: true,
      tireGripMps2: 8.5,
      contactResponse: "inelastic-slide-v1",
      massKg: 1920,
    },
    vehicle: createVehicleState(),
    ...overrides,
  };
}

function simulateStraightRun(surface, initialSpeed, targetSpeed, ticks = 120) {
  let car = makeRealisticCar({ speed: initialSpeed });
  let distM = 0;
  for (let i = 0; i < ticks; i++) {
    const next = integrateVehicle(car, { targetSpeed, steer: 0, ...(surface ? { surface } : {}) }, STEP);
    distM += Math.hypot(next.x - car.x, next.z - car.z);
    car = next;
    if (targetSpeed === 0 && Math.abs(car.speed) < 1e-4) break;
  }
  return { finalSpeedMps: car.speed, distanceM: distM };
}

function simulateHighSpeedTurn(surface, ticks = 60) {
  let car = makeRealisticCar({ speed: 16.5, steer: 0.45 });
  let peakSlipRad = 0;
  for (let i = 0; i < ticks; i++) {
    car = integrateVehicle(car, { targetSpeed: 16.5, steer: 0.52, ...(surface ? { surface } : {}) }, STEP);
    peakSlipRad = Math.max(peakSlipRad, Math.abs(car.chaseSlipRad ?? 0));
  }
  return { finalSpeedMps: car.speed, peakSlipRad };
}

function runNegativeFaultOracle() {
  // 1. Fault A: Color-only surface zones (sand/water omit surface physics, behaving identically to asphalt)
  const realAsphaltAccel = simulateStraightRun({ ...SURFACE_SPECS.asphalt, surfaceKind: "asphalt", gradeSin: 0 }, 0, 18, 120);
  const realSandAccel = simulateStraightRun({ ...SURFACE_SPECS.sand, surfaceKind: "sand", gradeSin: 0 }, 0, 18, 120);
  const faultyColorOnlySandAccel = simulateStraightRun(null, 0, 18, 120);
  const detectedColorOnlySurfaceFault =
    realAsphaltAccel.finalSpeedMps - realSandAccel.finalSpeedMps >= 1.8 &&
    Math.abs(faultyColorOnlySandAccel.finalSpeedMps - realAsphaltAccel.finalSpeedMps) < 1e-6;

  // 2. Fault B: Zero-gravity flat slopes (uphill +9% and downhill -9% accelerate identically)
  const realUphill = simulateStraightRun({ ...SURFACE_SPECS.asphalt, surfaceKind: "asphalt", gradeSin: 0.09 }, 6, 24, 90);
  const realDownhill = simulateStraightRun({ ...SURFACE_SPECS.asphalt, surfaceKind: "asphalt", gradeSin: -0.09 }, 6, 24, 90);
  const faultyFlatUphill = simulateStraightRun({ ...SURFACE_SPECS.asphalt, surfaceKind: "asphalt", gradeSin: 0 }, 6, 24, 90);
  const faultyFlatDownhill = simulateStraightRun({ ...SURFACE_SPECS.asphalt, surfaceKind: "asphalt", gradeSin: 0 }, 6, 24, 90);
  const detectedZeroSlopeGravityFault =
    realDownhill.finalSpeedMps - realUphill.finalSpeedMps >= 1.5 &&
    Math.abs(faultyFlatDownhill.finalSpeedMps - faultyFlatUphill.finalSpeedMps) < 1e-6;

  // 3. Fault C: Flat featureless upper apartment tower floors (boulevard tower without balconies/upper reveals)
  const road = { id: "tahrir-boulevard", axis: "x", fixed: 0, min: -100, max: 100, width: 14, laneOffsetM: 2.7, speedLimitMps: 10.5, zone: "avenue", marking: "center" };
  const tower = { id: "cairo-tower-neg", type: "static", kind: "building", architecture: "boulevard", x: 0, z: 22, width: 26, length: 18, height: 38, heading: Math.PI };
  const realV5Layer = createEgyptStreetLayer({ environment: "metro", config: { cityVersion: 5 }, roads: [road], drivingRoads: [road], statics: [tower], player: { x: 0, z: 0 } }, { streamDetails: false });
  const legacyFlatBoulevardLayer = createEgyptStreetLayer({ environment: "metro", config: { cityVersion: 4 }, roads: [road], drivingRoads: [road], statics: [tower], player: { x: 0, z: 0 } }, { streamDetails: false });
  const realBalconies = realV5Layer.diagnostics.counts.balconies;
  const legacyBoulevardBalconies = legacyFlatBoulevardLayer.diagnostics.counts.balconies;
  realV5Layer.dispose();
  legacyFlatBoulevardLayer.dispose();
  const detectedFlatBuildingTowerFault = realBalconies >= 6 && legacyBoulevardBalconies === 0;

  const report = {
    passed: !(detectedColorOnlySurfaceFault && detectedZeroSlopeGravityFault && detectedFlatBuildingTowerFault),
    detectedColorOnlySurfaceFault,
    detectedZeroSlopeGravityFault,
    detectedZeroSlopeDetails: {
      realUphillSpeedMps: Number(realUphill.finalSpeedMps.toFixed(3)),
      realDownhillSpeedMps: Number(realDownhill.finalSpeedMps.toFixed(3)),
      faultyDiffMps: Math.abs(faultyFlatDownhill.finalSpeedMps - faultyFlatUphill.finalSpeedMps),
    },
    detectedColorOnlyDetails: {
      realAsphaltSpeedMps: Number(realAsphaltAccel.finalSpeedMps.toFixed(3)),
      realSandSpeedMps: Number(realSandAccel.finalSpeedMps.toFixed(3)),
      faultySandSpeedMps: Number(faultyColorOnlySandAccel.finalSpeedMps.toFixed(3)),
    },
    detectedFlatBuildingTowerFault,
    towerBalconyComparison: { realBalconies, legacyBoulevardBalconies },
  };
  writeFileSync(join(outDir, "negative-fault.json"), JSON.stringify(report, null, 2));
  console.log("Negative control faults verified:", JSON.stringify({
    passed: report.passed,
    detectedColorOnlySurfaceFault,
    detectedZeroSlopeGravityFault,
    detectedFlatBuildingTowerFault,
  }));
  process.exit(report.passed ? 0 : 1);
}

if (negativeFaultMode) {
  runNegativeFaultOracle();
}

function auditArchitectureAndProps() {
  const world = new World({ cityVersion: 5, seed: "cairo-arch-eval-01", traffic: 12, pedestrians: 16 }, "metro");
  const view = new WorldView(world, { loadAsset: () => new Promise(() => {}) });
  const cam = new THREE.PerspectiveCamera(62, 16 / 9, 0.1, 950);
  cam.position.set(world.player.x - 12, 6, world.player.z - 8);
  view.sync(1);
  view.prepareFrame({ cameras: [cam] });

  const archDiag = view.egyptStreets.diagnostics;
  const surfDiag = view.streetSurfaceDiagnostics();

  // Check upper-floor (> 22 m) recessed/balcony vertices in resident detail meshes
  let upperFloorDetailVerts = 0;
  for (const mesh of view.egyptStreets.root.children) {
    if (!mesh.name.endsWith("-structure")) continue;
    const pos = mesh.geometry.getAttribute("position");
    const feat = mesh.geometry.getAttribute("featureIndex");
    for (let i = 0; i < pos.count; i++) {
      if (pos.getY(i) > 22 && (feat.getX(i) === 1 || feat.getX(i) === 2)) upperFloorDetailVerts++;
    }
  }

  view.dispose();
  return {
    passed:
      archDiag.budget.withinBudget === true &&
      archDiag.drawCalls <= 75 &&
      archDiag.triangles <= 260000 &&
      archDiag.counts.balconies >= 30 &&
      archDiag.counts.airConditioners >= 15 &&
      archDiag.counts.awnings >= 10 &&
      archDiag.counts.shops >= 18 &&
      archDiag.counts.tanks >= 4 &&
      archDiag.counts.dishes >= 4 &&
      upperFloorDetailVerts >= 40 &&
      Boolean(surfDiag?.active) &&
      surfDiag.streetLampCount >= 20 &&
      surfDiag.streetTreeCount >= 20 &&
      surfDiag.furnitureCount >= 10,
    withinBudget: archDiag.budget.withinBudget,
    archDrawCalls: archDiag.drawCalls,
    archTriangles: archDiag.triangles,
    residentSites: archDiag.residentSites,
    counts: archDiag.counts,
    upperFloorDetailVerts,
    streetProps: {
      streetLampCount: surfDiag?.streetLampCount ?? 0,
      streetTreeCount: surfDiag?.streetTreeCount ?? 0,
      furnitureCount: surfDiag?.furnitureCount ?? 0,
    },
  };
}

function auditPbrSurfaceTexturesAndFx() {
  const world = new World({ cityVersion: 5, seed: "cairo-pbr-eval-01", traffic: 4, pedestrians: 4 }, "metro");
  const view = new WorldView(world, { loadAsset: () => new Promise(() => {}) });
  view.sync(1);
  view.prepareFrame();

  const diag0 = view.streetSurfaceDiagnostics();
  const mats = view.streetSurfaces.root.userData.materials;
  const hasRealPbrTextures = Boolean(
    mats?.water?.map?.isDataTexture &&
    mats?.water?.bumpMap?.isDataTexture &&
    mats?.water?.roughnessMap?.isDataTexture &&
    mats?.sand?.map?.isDataTexture &&
    mats?.sand?.bumpMap?.isDataTexture &&
    mats?.sand?.roughnessMap?.isDataTexture &&
    mats?.cobble?.map?.isDataTexture &&
    mats?.cobble?.bumpMap?.isDataTexture &&
    mats?.cobble?.roughnessMap?.isDataTexture,
  );

  // Verify 0 splash/dust when parked on puddle & sand
  const puddle = world.terrain.waterPuddles[0];
  Object.assign(world.player, { x: puddle.x, z: puddle.z, heading: puddle.heading, speed: 0 });
  view.streetSurfaces.update(world, STEP);
  const parkedSplashes = view.streetSurfaceDiagnostics().activeWaterSplashes;

  // Drive through puddle at 12 m/s -> spawns water splash droplets!
  world.player.speed = 12;
  for (let i = 0; i < 4; i++) view.streetSurfaces.update(world, STEP);
  const movingSplashes = view.streetSurfaceDiagnostics().activeWaterSplashes;

  // Drive across sand zone at 12 m/s -> spawns sandy dust plumes!
  const sandZone = world.terrain.sandZones[0];
  Object.assign(world.player, { x: sandZone.x, z: sandZone.z, heading: sandZone.heading, speed: 12 });
  for (let i = 0; i < 5; i++) view.streetSurfaces.update(world, STEP);
  const movingSandDust = view.streetSurfaceDiagnostics().activeSandDust;

  view.dispose();
  return {
    passed:
      hasRealPbrTextures &&
      diag0.drawCalls <= 12 &&
      diag0.waterRoughness <= 0.10 &&
      diag0.sandRoughness >= 0.88 &&
      diag0.waterPuddleCount >= 15 &&
      diag0.sandZoneCount >= 12 &&
      diag0.cobbleZoneCount >= 6 &&
      parkedSplashes === 0 &&
      movingSplashes >= 4 &&
      movingSandDust >= 2,
    hasRealPbrTextures,
    surfaceDrawCalls: diag0.drawCalls,
    waterRoughness: diag0.waterRoughness,
    sandRoughness: diag0.sandRoughness,
    zoneCounts: {
      waterPuddles: diag0.waterPuddleCount,
      sandZones: diag0.sandZoneCount,
      cobbleZones: diag0.cobbleZoneCount,
    },
    parkedSplashes,
    movingSplashes,
    movingSandDust,
  };
}

function runSurfacePhysicsDifferential() {
  const asphaltSurf = { ...SURFACE_SPECS.asphalt, surfaceKind: "asphalt", gradeSin: 0 };
  const sandSurf = { ...SURFACE_SPECS.sand, surfaceKind: "sand", gradeSin: 0 };
  const waterSurf = { ...SURFACE_SPECS.water, surfaceKind: "water", gradeSin: 0 };
  const cobbleSurf = { ...SURFACE_SPECS.cobble, surfaceKind: "cobble", gradeSin: 0 };

  const accelAsphalt = simulateStraightRun(asphaltSurf, 0, 18, 120);
  const accelSand = simulateStraightRun(sandSurf, 0, 18, 120);
  const accelCobble = simulateStraightRun(cobbleSurf, 0, 18, 120);

  const brakeAsphalt = simulateStraightRun(asphaltSurf, 18, 0, 240);
  const brakeWater = simulateStraightRun(waterSurf, 18, 0, 240);
  const brakeSand = simulateStraightRun(sandSurf, 18, 0, 240);

  const turnAsphalt = simulateHighSpeedTurn(asphaltSurf, 60);
  const turnWater = simulateHighSpeedTurn(waterSurf, 60);
  const turnSand = simulateHighSpeedTurn(sandSurf, 60);

  return {
    passed:
      accelAsphalt.finalSpeedMps - accelSand.finalSpeedMps >= 1.8 &&
      accelAsphalt.finalSpeedMps > accelCobble.finalSpeedMps &&
      brakeWater.distanceM >= brakeAsphalt.distanceM * 1.25 &&
      brakeSand.distanceM > brakeAsphalt.distanceM * 1.10 &&
      turnWater.peakSlipRad > turnAsphalt.peakSlipRad * 1.20 &&
      turnSand.peakSlipRad > turnAsphalt.peakSlipRad * 1.08,
    accelFinalSpeedMps: {
      asphalt: Number(accelAsphalt.finalSpeedMps.toFixed(3)),
      cobble: Number(accelCobble.finalSpeedMps.toFixed(3)),
      sand: Number(accelSand.finalSpeedMps.toFixed(3)),
    },
    brakingDistanceFrom18Mps: {
      asphaltM: Number(brakeAsphalt.distanceM.toFixed(2)),
      sandM: Number(brakeSand.distanceM.toFixed(2)),
      waterM: Number(brakeWater.distanceM.toFixed(2)),
    },
    corneringPeakSlipRad: {
      asphalt: Number(turnAsphalt.peakSlipRad.toFixed(4)),
      sand: Number(turnSand.peakSlipRad.toFixed(4)),
      water: Number(turnWater.peakSlipRad.toFixed(4)),
    },
  };
}

function runSlopeElevationTrial() {
  const world = new World({ cityVersion: 5, seed: "cairo-slope-eval-01", traffic: 0, pedestrians: 0 }, "metro");
  const view = new WorldView(world, { loadAsset: () => new Promise(() => {}) });
  view.scene.updateMatrixWorld(true);

  const rampPeakElev = terrainElevationAt(world.terrain, 24, -112);
  const citadelPeakElev = terrainElevationAt(world.terrain, 355, -210);
  const retainingWalls = view.scene.getObjectByName("road-retaining-walls");

  // Raycast 3D sloped road mesh at Tahrir Overpass crest (x=24, z=-112) and flank (x=-22, z=-112)
  const raycaster = new THREE.Raycaster();
  const checkRoadHeightAt = (x, z) => {
    raycaster.set(new THREE.Vector3(x, 20, z), new THREE.Vector3(0, -1, 0));
    const hit = raycaster.intersectObjects(view.surfaces.road, false)[0];
    const expectedY = 0.115 + terrainElevationAt(world.terrain, x, z);
    return { hitY: hit?.point?.y ?? NaN, expectedY, errM: hit ? Math.abs(hit.point.y - expectedY) : Infinity };
  };
  const crestRay = checkRoadHeightAt(24, -112);
  const flankRay = checkRoadHeightAt(-22, -112);

  // Place player on uphill west flank of Tahrir Overpass Ramp facing east (+X, heading = PI/2)
  Object.assign(world.player, { x: -32, z: -112 + 2.7, heading: Math.PI / 2, speed: 7, steer: 0, path: [] });
  const uphillSurf = sampleCitySurface(world.terrain, world.player.x, world.player.z, world.player.heading);
  world.command({ type: "drive", targetSpeed: 15, steer: 0 });
  for (let i = 0; i < 45; i++) world.step(STEP);
  const uphillSpeedAfter45 = world.player.speed;
  const playerRoot = view.sync(1);
  const uphillPitchRad = playerRoot.rotation.x;
  const uphillRenderY = playerRoot.position.y;

  // Compare with descending east flank at same starting speed (x = +72, z = -112 + 2.7, heading = PI/2)
  Object.assign(world.player, { x: 72, z: -112 + 2.7, heading: Math.PI / 2, speed: 7, steer: 0, path: [] });
  world.command({ type: "drive", targetSpeed: 15, steer: 0 });
  for (let i = 0; i < 45; i++) world.step(STEP);
  const downhillSpeedAfter45 = world.player.speed;

  view.dispose();
  return {
    passed:
      rampPeakElev >= 3.0 &&
      citadelPeakElev >= 4.0 &&
      Boolean(retainingWalls && retainingWalls.geometry.attributes.position.count > 0) &&
      crestRay.errM <= 0.04 &&
      flankRay.errM <= 0.04 &&
      uphillSurf.gradeSin > 0.04 &&
      uphillPitchRad < -0.035 &&
      uphillRenderY > 1.2 &&
      downhillSpeedAfter45 - uphillSpeedAfter45 >= 0.9,
    rampPeakElev: Number(rampPeakElev.toFixed(3)),
    citadelPeakElev: Number(citadelPeakElev.toFixed(3)),
    hasRetainingWalls: Boolean(retainingWalls),
    crestRay: { hitY: Number(crestRay.hitY.toFixed(3)), expectedY: Number(crestRay.expectedY.toFixed(3)), errM: Number(crestRay.errM.toFixed(4)) },
    flankRay: { hitY: Number(flankRay.hitY.toFixed(3)), expectedY: Number(flankRay.expectedY.toFixed(3)), errM: Number(flankRay.errM.toFixed(4)) },
    uphillGradePct: Number((uphillSurf.gradeSin * 100).toFixed(2)),
    uphillPitchRad: Number(uphillPitchRad.toFixed(4)),
    uphillRenderY: Number(uphillRenderY.toFixed(3)),
    uphillSpeedAfter45: Number(uphillSpeedAfter45.toFixed(3)),
    downhillSpeedAfter45: Number(downhillSpeedAfter45.toFixed(3)),
  };
}

function run5StarPerformanceBenchmark() {
  const checkpointPath = resolve(rootDir, "public/threejs/pako-chase-ppo.json");
  const raw = readFileSync(checkpointPath, "utf8");
  const sha256 = createHash("sha256").update(raw).digest("hex");
  const policy = freezePursuitPolicy(JSON.parse(raw));

  const makeChaseWorld = (seed, traffic, pedestrians, patrols) => {
    const w = new World({ cityVersion: 5, seed, traffic, pedestrians }, "metro");
    w.command({
      type: "street-pursuit-start",
      variant: "gta",
      level: 5,
      config: {
        ruleset: "dispatch-v1",
        damageFeedback: DISPATCH_DAMAGE_FEEDBACK,
        curbSupport: METRO_CITY_CURBS,
        chasePresence: AGGRESSIVE_CHASE_PRESENCE,
        tacticalPursuit: TACTICAL_PURSUIT_MODE,
        patrolTrafficPreview: PATROL_TRAFFIC_PREVIEW,
        patrolChainYield: PATROL_LATERAL_YIELD,
        wantedLevelMax: 5,
        maxActivePatrols: patrols,
        episodeMaxSeconds: 60,
      },
    }, false);
    w.pursuit.cityChase = true;
    w.pursuit.gta.scanner = new PursuitScanner();
    w.pursuit.gta.scan = w.pursuit.gta.scanner.sample(w);
    w.pursuit.frozenDriver = {
      policy, sha256, status: "active", lastTick: -1, decisions: 0,
      recoverStale: true, evasion: false, evasiveControl: PAKO_EVASIVE_CONTROL,
    };
    return w;
  };

  // V8 JIT warmup (60 steps)
  const warmup = makeChaseWorld("surfaces-warmup", 40, 60, 8);
  for (let i = 0; i < 60; i++) {
    if (warmup.pursuit?.phase !== "running") break;
    applyFrozenDispatchAction(warmup, warmup.pursuit.frozenDriver, null);
    warmup.step(STEP);
  }

  // Full 5-star Grand City v5 benchmark (96 traffic, 144 pedestrians, 14 tactical patrols, 300 ticks)
  const bench = makeChaseWorld("surfaces-bench-5star", 96, 144, 14);
  const samplesMs = [];
  for (let i = 0; i < 300; i++) {
    if (bench.pursuit?.phase !== "running") break;
    const t0 = performance.now();
    applyFrozenDispatchAction(bench, bench.pursuit.frozenDriver, null);
    bench.step(STEP);
    samplesMs.push(performance.now() - t0);
  }
  samplesMs.sort((a, b) => a - b);
  const avgTotalTickMs = samplesMs.reduce((s, v) => s + v, 0) / Math.max(1, samplesMs.length);
  const p50TickMs = samplesMs[Math.floor(samplesMs.length * 0.5)] ?? 0;
  const p95TickMs = samplesMs[Math.floor(samplesMs.length * 0.95)] ?? 0;

  return {
    passed: samplesMs.length >= 120 && avgTotalTickMs <= 12.0,
    ticksMeasured: samplesMs.length,
    avgTotalTickMs: Number(avgTotalTickMs.toFixed(2)),
    p50TickMs: Number(p50TickMs.toFixed(2)),
    p95TickMs: Number(p95TickMs.toFixed(2)),
  };
}

const architectureAndPropsAudit = auditArchitectureAndProps();
const pbrSurfaceTexturesAudit = auditPbrSurfaceTexturesAndFx();
const surfacePhysicsDifferential = runSurfacePhysicsDifferential();
const slopeElevationTrial = runSlopeElevationTrial();
const perfBenchmark5Star = run5StarPerformanceBenchmark();

const report = {
  passed:
    architectureAndPropsAudit.passed &&
    pbrSurfaceTexturesAudit.passed &&
    surfacePhysicsDifferential.passed &&
    slopeElevationTrial.passed &&
    perfBenchmark5Star.passed,
  architectureAndPropsAudit,
  pbrSurfaceTexturesAudit,
  surfacePhysicsDifferential,
  slopeElevationTrial,
  perfBenchmark5Star,
};

writeFileSync(join(outDir, "city-surfaces-eval.json"), JSON.stringify(report, null, 2));
console.log("Realistic city buildings, surfaces, slopes & 60 FPS eval:", JSON.stringify({
  passed: report.passed,
  archPassed: architectureAndPropsAudit.passed,
  pbrPassed: pbrSurfaceTexturesAudit.passed,
  physicsPassed: surfacePhysicsDifferential.passed,
  slopePassed: slopeElevationTrial.passed,
  perfPassed: perfBenchmark5Star.passed,
  avgTickMs: perfBenchmark5Star.avgTotalTickMs,
}));

if (!report.passed) {
  process.exit(1);
}
