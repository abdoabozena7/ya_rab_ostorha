import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import * as THREE from "three";
import { World } from "../src/core/world.js";
import { createUnifiedCity } from "../src/core/unified-city.js";
import { WorldView } from "../src/render/world-view.js";
import { createEgyptStreetLayer } from "../src/render/egypt-streets.js";
import { createCinematicRoadTextures } from "../src/render/street-surfaces-view.js";
import { createPursuitCamera } from "../src/render/pursuit-camera.js";
import {
  DEFAULT_CINEMATIC_GRADE,
  evaluateCinematicGradePixel,
} from "../src/render/cinematic-post.js";
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
  : resolve(rootDir, ".runtime-proof/cinematic-grade-street-realism-20261124/local-eval");
mkdirSync(outDir, { recursive: true });

const negativeFaultMode = process.argv.includes("--negative-fault");

function rgbLuma([r, g, b]) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function rgbHsvSat([r, g, b]) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max <= 1e-6 ? 0 : (max - min) / max;
}

function evaluateGradeOracle(gradeConfig) {
  const palette = {
    middaySky: [0.847, 0.792, 0.722],
    brightPlaster: [0.812, 0.768, 0.682],
    brightGreenCanopy: [0.345, 0.585, 0.265],
    blueRoad: [0.678, 0.788, 0.937],
    deepShadow: [0.115, 0.118, 0.125],
    sunlitLimestone: [0.835, 0.795, 0.725],
    policeRed: [0.94, 0.15, 0.12],
    policeBlue: [0.14, 0.36, 0.98],
  };

  const rawDaySamples = [
    palette.middaySky,
    palette.brightPlaster,
    palette.brightGreenCanopy,
    palette.blueRoad,
  ];
  const gradedDaySamples = rawDaySamples.map((c) =>
    evaluateCinematicGradePixel(c, [0.5, 0.5], { enabled: true }, gradeConfig),
  );

  const rawMeanLuma =
    rawDaySamples.reduce((s, c) => s + rgbLuma(c), 0) / rawDaySamples.length;
  const gradedMeanLuma =
    gradedDaySamples.reduce((s, c) => s + rgbLuma(c), 0) / gradedDaySamples.length;
  const lumaDropFraction = 1 - gradedMeanLuma / rawMeanLuma;

  const rawMeanSat =
    rawDaySamples.reduce((s, c) => s + rgbHsvSat(c), 0) / rawDaySamples.length;
  const gradedMeanSat =
    gradedDaySamples.reduce((s, c) => s + rgbHsvSat(c), 0) / gradedDaySamples.length;
  const satDropFraction = 1 - gradedMeanSat / rawMeanSat;

  const gradedShadow = evaluateCinematicGradePixel(
    palette.deepShadow,
    [0.5, 0.5],
    { enabled: true },
    gradeConfig,
  );
  const gradedSunlit = evaluateCinematicGradePixel(
    palette.sunlitLimestone,
    [0.5, 0.5],
    { enabled: true },
    gradeConfig,
  );
  const contrastSpan = rgbLuma(gradedSunlit) - rgbLuma(gradedShadow);

  const centerSample = evaluateCinematicGradePixel(
    palette.brightPlaster,
    [0.5, 0.5],
    { enabled: true },
    gradeConfig,
  );
  const cornerSample = evaluateCinematicGradePixel(
    palette.brightPlaster,
    [0.04, 0.04],
    { enabled: true },
    gradeConfig,
  );
  const vignetteDropFraction = 1 - rgbLuma(cornerSample) / Math.max(1e-5, rgbLuma(centerSample));

  const gradedRed = evaluateCinematicGradePixel(
    palette.policeRed,
    [0.5, 0.5],
    { enabled: true },
    gradeConfig,
  );
  const gradedBlue = evaluateCinematicGradePixel(
    palette.policeBlue,
    [0.5, 0.5],
    { enabled: true },
    gradeConfig,
  );
  const gradedGreen = evaluateCinematicGradePixel(
    palette.brightGreenCanopy,
    [0.5, 0.5],
    { enabled: true },
    gradeConfig,
  );

  const passed =
    lumaDropFraction >= 0.22 &&
    satDropFraction >= 0.25 &&
    contrastSpan >= 0.44 &&
    gradedShadow[2] > gradedShadow[0] &&
    vignetteDropFraction >= 0.20 &&
    rgbHsvSat(gradedRed) > rgbHsvSat(gradedGreen) + 0.18 &&
    rgbHsvSat(gradedBlue) > rgbHsvSat(gradedGreen) + 0.18;

  return {
    passed,
    rawMeanLuma: Number(rawMeanLuma.toFixed(4)),
    gradedMeanLuma: Number(gradedMeanLuma.toFixed(4)),
    lumaDropFraction: Number(lumaDropFraction.toFixed(4)),
    rawMeanSat: Number(rawMeanSat.toFixed(4)),
    gradedMeanSat: Number(gradedMeanSat.toFixed(4)),
    satDropFraction: Number(satDropFraction.toFixed(4)),
    contrastSpan: Number(contrastSpan.toFixed(4)),
    coolShadowBlueMinusRed: Number((gradedShadow[2] - gradedShadow[0]).toFixed(4)),
    vignetteDropFraction: Number(vignetteDropFraction.toFixed(4)),
    policeRedSat: Number(rgbHsvSat(gradedRed).toFixed(4)),
    policeBlueSat: Number(rgbHsvSat(gradedBlue).toFixed(4)),
    foliageGreenSat: Number(rgbHsvSat(gradedGreen).toFixed(4)),
    gradedSamples: {
      middaySkyToDusk: gradedDaySamples[0].map((v) => Number(v.toFixed(4))),
      brightPlasterToMutedStone: gradedDaySamples[1].map((v) => Number(v.toFixed(4))),
      brightGreenToDustyOlive: gradedDaySamples[2].map((v) => Number(v.toFixed(4))),
      deepShadowSlate: gradedShadow.map((v) => Number(v.toFixed(4))),
      sunlitLimestoneHighlight: gradedSunlit.map((v) => Number(v.toFixed(4))),
      vignetteCenter: centerSample.map((v) => Number(v.toFixed(4))),
      vignetteCorner: cornerSample.map((v) => Number(v.toFixed(4))),
    },
  };
}

function evaluateCinematicMotionOracle({ cinematicEnabled = true } = {}) {
  const camFollow = new THREE.PerspectiveCamera(62, 1365 / 900, 0.1, 950);
  const rigFollow = createPursuitCamera();
  const pos = new THREE.Vector3(0, 0.12, 0);
  let heading = 0;

  rigFollow.update(camFollow, {
    position: pos,
    heading,
    speedMps: 0,
    streetWidthM: 14,
    deltaS: 1 / 60,
    snap: true,
    cameraStyle: "follow",
    cinematicMotion: cinematicEnabled,
    accelMps2: 0,
  });
  const idleFov = camFollow.fov;

  // 1. Hard throttle launch (+6.2 m/s^2) up to 17.5 m/s
  let speed = 0;
  for (let i = 0; i < 50; i++) {
    speed = Math.min(17.5, speed + 6.2 / 60);
    pos.z += speed / 60;
    rigFollow.update(camFollow, {
      position: pos,
      heading,
      speedMps: speed,
      streetWidthM: 14,
      deltaS: 1 / 60,
      cameraStyle: "follow",
      cinematicMotion: cinematicEnabled,
      accelMps2: 6.2,
    });
  }
  const throttleDiag = rigFollow.diagnostics();

  // 2. High-speed cruise + sweeping boulevard corner with drift slip
  for (let i = 0; i < 60; i++) {
    speed = 18.0;
    heading += 0.95 / 60;
    pos.x += Math.sin(heading) * (speed / 60);
    pos.z += Math.cos(heading) * (speed / 60);
    rigFollow.update(camFollow, {
      position: pos,
      heading,
      speedMps: speed,
      streetWidthM: 14,
      deltaS: 1 / 60,
      cameraStyle: "follow",
      cinematicMotion: cinematicEnabled,
      accelMps2: 0.4,
      slipRad: -0.22,
      surfaceRoughness: 0.75,
      impactPulse: i === 40 ? 0.85 : 0,
    });
  }
  const cornerDiag = rigFollow.diagnostics();

  // 3. Hard emergency braking (-7.8 m/s^2)
  for (let i = 0; i < 35; i++) {
    speed = Math.max(4.0, speed - 7.8 / 60);
    pos.x += Math.sin(heading) * (speed / 60);
    pos.z += Math.cos(heading) * (speed / 60);
    rigFollow.update(camFollow, {
      position: pos,
      heading,
      speedMps: speed,
      streetWidthM: 14,
      deltaS: 1 / 60,
      cameraStyle: "follow",
      cinematicMotion: cinematicEnabled,
      accelMps2: -7.8,
    });
  }
  const brakeDiag = rigFollow.diagnostics();

  const fovGainDeg = cornerDiag.fov - idleFov;
  const passed =
    fovGainDeg >= 3.8 &&
    throttleDiag.accelLagM >= 0.30 &&
    brakeDiag.accelLagM <= -0.25 &&
    Math.abs(cornerDiag.rollRad) >= 0.012 &&
    Math.abs(cornerDiag.lateralSwingM) >= 0.22 &&
    cornerDiag.shakeAmpM > 0.004;

  return {
    passed,
    idleFov: Number(idleFov.toFixed(3)),
    highSpeedCornerFov: Number(cornerDiag.fov.toFixed(3)),
    fovGainDeg: Number(fovGainDeg.toFixed(3)),
    throttleAccelLagM: Number(throttleDiag.accelLagM.toFixed(4)),
    brakeAccelLagM: Number(brakeDiag.accelLagM.toFixed(4)),
    cornerRollRad: Number(cornerDiag.rollRad.toFixed(4)),
    cornerLateralSwingM: Number(cornerDiag.lateralSwingM.toFixed(4)),
    cornerShakeAmpM: Number(cornerDiag.shakeAmpM.toFixed(4)),
  };
}

function evaluateRoadAndCurbOracle({ roadMeanRgb, roadBlueBias, curbDarkCount, curbLightCount, manholeCount }) {
  const neutralDarkRoad = roadMeanRgb < 0.24 && Math.abs(roadBlueBias) < 0.03;
  const segmentedCurbs = curbDarkCount >= 500 && curbLightCount >= 500;
  const richManholes = manholeCount >= 35;
  return {
    passed: neutralDarkRoad && segmentedCurbs && richManholes,
    neutralDarkRoad,
    segmentedCurbs,
    richManholes,
  };
}

if (negativeFaultMode) {
  // Fault 1: Washed-out bright oversaturated midday grade (no darkening, no desaturation, no vignette)
  const washedGrade = evaluateGradeOracle({
    exposure: 1.15,
    contrast: 1.0,
    shadowToe: 0.0,
    highlightShoulder: 0.0,
    saturation: 1.12,
    shadowTint: [0.3, 0.28, 0.24],
    highlightTint: [1, 1, 1],
    vignette: 0.0,
    grain: 0,
    maxSpeedStreak: 0,
    maxChromaticFringe: 0,
  });

  // Fault 2: Static non-cinematic camera (locked 62 deg FOV, zero banking, zero G-force surge)
  const staticMotion = evaluateCinematicMotionOracle({ cinematicEnabled: false });

  // Fault 3: Blue-tinted washed road (#adc9ef) + uniform single-color curb + 0 manholes
  const flatCurbRoad = evaluateRoadAndCurbOracle({
    roadMeanRgb: 0.42,
    roadBlueBias: 0.14,
    curbDarkCount: 0,
    curbLightCount: 12000,
    manholeCount: 0,
  });

  const faultReport = {
    passed: washedGrade.passed && staticMotion.passed && flatCurbRoad.passed,
    detectedWashedOutColorGradeFault: !washedGrade.passed,
    detectedStaticNonCinematicMotionFault: !staticMotion.passed,
    detectedFlatUnrealisticCurbStreetFault: !flatCurbRoad.passed,
    washedGrade,
    staticMotion,
    flatCurbRoad,
  };

  writeFileSync(join(outDir, "negative-fault.json"), JSON.stringify(faultReport, null, 2));
  console.log(JSON.stringify(faultReport));
  process.exit(faultReport.passed ? 0 : 1);
}

// === Live Acceptance Evaluation ===
const cinematicMotionAudit = evaluateCinematicMotionOracle({ cinematicEnabled: true });
const cinematicGradeAudit = evaluateGradeOracle(DEFAULT_CINEMATIC_GRADE);

const world = new World({ cityVersion: 5, seed: "cairo-cinematic-eval" }, "metro");
const view = new WorldView(world);

// Check SUV sub-frame alpha interpolation & dusk headlamp/brake light pools
world.player.previous = {
  ...world.player,
  vehicle: {
    ...world.player.vehicle,
    wheelSpinRad: 0.0,
    suspension: { heaveM: 0.0, pitchRad: 0.0, rollRad: 0.0 },
  },
};
world.player.vehicle.wheelSpinRad = 0.8;
world.player.vehicle.suspension = { heaveM: -0.02, pitchRad: 0.04, rollRad: -0.05 };
world.player.vehicle.controls = { ...(world.player.vehicle.controls ?? {}), brake: 0.85 };
view.sync(0.5);
const rigDiag = view.playerRig.diagnostics;
const roadPoolsGroup = view.playerRig.root.getObjectByName("suv-road-light-pools");
const suvSubframeMotionOk =
  Math.abs(rigDiag.suspension.pitchRad - 0.02) < 1e-4 &&
  Math.abs(rigDiag.suspension.rollRad - -0.025) < 1e-4 &&
  Boolean(roadPoolsGroup && roadPoolsGroup.visible && roadPoolsGroup.children.length >= 3);
cinematicMotionAudit.suvSubframeMotionOk = suvSubframeMotionOk;
cinematicMotionAudit.passed = cinematicMotionAudit.passed && suvSubframeMotionOk;

const atmosphere = view.atmosphereDiagnostics();
cinematicGradeAudit.atmosphere = atmosphere;
cinematicGradeAudit.passed =
  cinematicGradeAudit.passed &&
  atmosphere.grandCity === true &&
  atmosphere.skyBackgroundHex === 0x465668 &&
  atmosphere.fogColorHex === 0x565f6a &&
  atmosphere.hemiIntensity <= 0.72 &&
  atmosphere.sunElevationDeg < 30 &&
  atmosphere.hasSkyDome === true &&
  atmosphere.hasCinematicRoadPbr === true &&
  atmosphere.hasCinematicSidewalkPbr === true;

// Audit 512x512 PBR road & sidewalk textures + 3D segmented curbs + manholes + <v5 invariance
const roadTexSuite = createCinematicRoadTextures();
const roadBytes = roadTexSuite.road.map.image.data;
let sumR = 0, sumG = 0, sumB = 0;
const pxCount = roadTexSuite.road.map.image.width * roadTexSuite.road.map.image.height;
for (let i = 0; i < roadBytes.length; i += 4) {
  sumR += roadBytes[i] / 255;
  sumG += roadBytes[i + 1] / 255;
  sumB += roadBytes[i + 2] / 255;
}
const roadMeanR = sumR / pxCount;
const roadMeanG = sumG / pxCount;
const roadMeanB = sumB / pxCount;
const roadMeanRgb = (roadMeanR + roadMeanG + roadMeanB) / 3;
const roadBlueBias = roadMeanB - roadMeanR;

const paveBytes = roadTexSuite.pavement.map.image.data;
const paveBumpBytes = roadTexSuite.pavement.bumpMap.image.data;
let paveSumRgb = 0;
let minJointBump = 255;
let maxTileBump = 0;
for (let i = 0; i < paveBytes.length; i += 4) {
  paveSumRgb += (paveBytes[i] + paveBytes[i + 1] + paveBytes[i + 2]) / (3 * 255);
  const bVal = paveBumpBytes[i];
  if (bVal < minJointBump) minJointBump = bVal;
  if (bVal > maxTileBump) maxTileBump = bVal;
}
const sidewalkMeanRgb = paveSumRgb / pxCount;
const sidewalkBumpRelief = (maxTileBump - minJointBump) / 255;
roadTexSuite.dispose();

const curbMesh = view.egyptStreets.root.getObjectByName("egypt-painted-curb");
const curbColors = curbMesh.geometry.getAttribute("color");
let curbDarkCount = 0;
let curbLightCount = 0;
for (let i = 0; i < curbColors.count; i++) {
  const y = 0.2126 * curbColors.getX(i) + 0.7152 * curbColors.getY(i) + 0.0722 * curbColors.getZ(i);
  if (y < 0.22) curbDarkCount++;
  else if (y > 0.48) curbLightCount++;
}

const repairsMesh = view.egyptStreets.root.getObjectByName("egypt-asphalt-repairs");
const repairColors = repairsMesh.geometry.getAttribute("color");
let maxRepairLuma = 0;
for (let i = 0; i < repairColors.count; i++) {
  const y = 0.2126 * repairColors.getX(i) + 0.7152 * repairColors.getY(i) + 0.0722 * repairColors.getZ(i);
  if (y > maxRepairLuma) maxRepairLuma = y;
}

const cam = new THREE.PerspectiveCamera(62, 1365 / 900, 0.1, 950);
cam.position.set(world.player.x - 10, 4.5, world.player.z - 10);
view.prepareFrame({ cameras: [cam] });

const surfDiag = view.streetSurfaceDiagnostics();
const archDiag = view.egyptStreets.diagnostics;

// Verify legacy <v5 skylineDigest remains byte-for-byte identical
const legacyMap = createUnifiedCity();
const legacyLayer = createEgyptStreetLayer({ ...legacyMap, environment: "metro" }, { streamDetails: true });
const skyHash = createHash("sha256");
for (const mesh of legacyLayer.root.children.filter((m) => m.name.endsWith("-skyline"))) {
  skyHash.update(mesh.name);
  for (const { array } of Object.values(mesh.geometry.attributes)) {
    skyHash.update(Buffer.from(array.buffer, array.byteOffset, array.byteLength));
  }
}
const legacySkylineDigest = skyHash.digest("hex");
legacyLayer.dispose();

const oracleCurbRoad = evaluateRoadAndCurbOracle({
  roadMeanRgb,
  roadBlueBias,
  curbDarkCount,
  curbLightCount,
  manholeCount: surfDiag.manholeCount,
});

const streetAndCurbRealismAudit = {
  passed:
    oracleCurbRoad.passed &&
    maxRepairLuma < 0.34 &&
    surfDiag.lampPoolCount === surfDiag.propCounts.lamps &&
    surfDiag.lampPoolCount >= 180 &&
    surfDiag.drawCalls <= 14 &&
    archDiag.budget.withinBudget === true &&
    archDiag.counts.drains >= 400 &&
    legacySkylineDigest === "22aff5ca5c7b73283b0d1d4a69c610b1108a6a810578532b596e0e320d72d53d",
  roadMeanRgb: Number(roadMeanRgb.toFixed(4)),
  roadBlueBias: Number(roadBlueBias.toFixed(4)),
  sidewalkMeanRgb: Number(sidewalkMeanRgb.toFixed(4)),
  sidewalkBumpRelief: Number(sidewalkBumpRelief.toFixed(4)),
  curbDarkCount,
  curbLightCount,
  maxRepairLuma: Number(maxRepairLuma.toFixed(4)),
  drains: archDiag.counts.drains,
  manholeCount: surfDiag.manholeCount,
  lampPoolCount: surfDiag.lampPoolCount,
  streetTreeCount: surfDiag.streetTreeCount,
  furnitureCount: surfDiag.furnitureCount,
  streetSurfaceDrawCalls: surfDiag.drawCalls,
  architectureDraws: archDiag.drawCalls,
  architectureTriangles: archDiag.triangles,
  withinGpuBudget: archDiag.budget.withinBudget,
  legacySkylineDigestMatch:
    legacySkylineDigest === "22aff5ca5c7b73283b0d1d4a69c610b1108a6a810578532b596e0e320d72d53d",
};

// 5-Star 300-Tick 60 FPS Performance Benchmark (96 traffic, 144 pedestrians, 14 tactical patrols + WorldView frame prep)
view.dispose();
const checkpointPath = resolve(rootDir, "public/threejs/pako-chase-ppo.json");
const checkpointRaw = readFileSync(checkpointPath, "utf8");
const checkpointSha = createHash("sha256").update(checkpointRaw).digest("hex");
const frozenPolicy = freezePursuitPolicy(JSON.parse(checkpointRaw));

function makeChaseWorld(seed, traffic, pedestrians, patrols) {
  const w = new World({ cityVersion: 5, seed, traffic, pedestrians }, "metro");
  w.command(
    {
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
    },
    false,
  );
  w.pursuit.cityChase = true;
  w.pursuit.gta.scanner = new PursuitScanner();
  w.pursuit.gta.scan = w.pursuit.gta.scanner.sample(w);
  w.pursuit.frozenDriver = {
    policy: frozenPolicy,
    sha256: checkpointSha,
    status: "active",
    lastTick: -1,
    decisions: 0,
    recoverStale: true,
    evasion: false,
    evasiveControl: PAKO_EVASIVE_CONTROL,
  };
  return w;
}

const warmup = makeChaseWorld("cinematic-warmup", 40, 60, 8);
for (let i = 0; i < 60; i++) {
  if (warmup.pursuit?.phase !== "running") break;
  applyFrozenDispatchAction(warmup, warmup.pursuit.frozenDriver, null);
  warmup.step();
}

const bench = makeChaseWorld("cinematic-bench-5star", 96, 144, 14);
const benchView = new WorldView(bench);
const stepTimesMs = [];
for (let t = 0; t < 300; t++) {
  if (bench.pursuit?.phase !== "running") break;
  const t0 = performance.now();
  applyFrozenDispatchAction(bench, bench.pursuit.frozenDriver, null);
  bench.step();
  const p = benchView.sync(1);
  cam.position.set(p.position.x - 11, p.position.y + 4.8, p.position.z - 11);
  cam.lookAt(p.position);
  benchView.prepareFrame({ cameras: [cam] });
  stepTimesMs.push(performance.now() - t0);
}
benchView.dispose();

const sorted = [...stepTimesMs].sort((a, b) => a - b);
const avgTotalTickMs = stepTimesMs.reduce((s, v) => s + v, 0) / stepTimesMs.length;
const p50TickMs = sorted[Math.floor(sorted.length * 0.5)];
const p95TickMs = sorted[Math.floor(sorted.length * 0.95)];

const perfBenchmark5Star = {
  passed: avgTotalTickMs <= 12.0,
  ticks: stepTimesMs.length,
  avgTotalTickMs: Number(avgTotalTickMs.toFixed(3)),
  p50TickMs: Number(p50TickMs.toFixed(3)),
  p95TickMs: Number(p95TickMs.toFixed(3)),
  budgetMaxAvgMs: 12.0,
};

const finalReport = {
  passed:
    cinematicMotionAudit.passed &&
    cinematicGradeAudit.passed &&
    streetAndCurbRealismAudit.passed &&
    perfBenchmark5Star.passed,
  cinematicMotionAudit,
  cinematicGradeAudit,
  streetAndCurbRealismAudit,
  perfBenchmark5Star,
};

writeFileSync(join(outDir, "cinematic-street-eval.json"), JSON.stringify(finalReport, null, 2));
console.log(
  JSON.stringify({
    passed: finalReport.passed,
    avgTotalTickMs: perfBenchmark5Star.avgTotalTickMs,
    fovGainDeg: cinematicMotionAudit.fovGainDeg,
    gradedMeanLuma: cinematicGradeAudit.gradedMeanLuma,
    manholes: streetAndCurbRealismAudit.manholeCount,
  }),
);
assert.equal(finalReport.passed, true, "All cinematic motion, film grade, street/curb realism, and 60 FPS checks must pass");
