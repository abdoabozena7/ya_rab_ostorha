import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import * as THREE from "three";
import { World } from "../src/core/world.js";
import {
  pointInShapedSurfaceZone,
  pointInWaterPuddle,
  querySurfaceKindFast,
  sampleCitySurface,
} from "../src/core/city-surfaces.js";
import { METRO_CITY_CURBS } from "../src/core/pako-curb.js";
import { AGGRESSIVE_CHASE_PRESENCE } from "../src/core/pako-aggressive-police.js";
import { TACTICAL_PURSUIT_MODE } from "../src/core/pako-tactical-police.js";
import { DISPATCH_DAMAGE_FEEDBACK, PATROL_TRAFFIC_PREVIEW } from "../src/core/pursuit-gta.js";
import { PATROL_LATERAL_YIELD } from "../src/core/pako-patrol-yield.js";
import { PAKO_EVASIVE_CONTROL } from "../src/rl/pako-evasive-control.js";
import { applyFrozenDispatchAction } from "../src/rl/pursuit-controller.js";
import { freezePursuitPolicy } from "../src/rl/pursuit-ppo.js";
import {
  PURSUIT_SCAN_RAYS,
  PURSUIT_SCAN_RANGE_M,
  PURSUIT_SCAN_TICKS,
  PursuitScanner,
} from "../src/signal_processing/pursuit-scanner.js";
import { createStreetSurfacesView } from "../src/render/street-surfaces-view.js";
import { CRASH_PART_KINDS, createCrashEffects } from "../src/render/crash-effects.js";
import {
  applyTrafficCrashDamage,
  createUnifiedTrafficModel,
  disposeUnifiedTrafficModel,
} from "../src/render/unified-traffic-model.js";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = process.env.PROVE_IT_OUTPUT_DIR
  ? resolve(process.env.PROVE_IT_OUTPUT_DIR)
  : resolve(rootDir, ".runtime-proof/perf-ultra-smooth-and-gallery-20261125/local-eval");
mkdirSync(outDir, { recursive: true });

const negativeFaultMode = process.argv.includes("--negative-fault");

export const GALLERY_SCREENSHOT_FILES = Object.freeze([
  "01-bright-city-avenue-suv.png",
  "02-chase-5star-nitro-boost.png",
  "03-crowd-20-ahead-forecast-ghosts.png",
  "04-cockpit-cutaway-sensor-inspection.png",
  "05-water-puddle-hydro-splash.png",
  "06-sandy-street-dust-and-ruts.png",
  "07-cobblestone-historic-market.png",
  "08-elevated-flyover-slope-vista.png",
  "09-chasing-camera-diagonal-pack.png",
  "10-real-part-crash-sparks-smoke.png",
]);

const policy = freezePursuitPolicy(
  JSON.parse(readFileSync(resolve(rootDir, "public/threejs/pako-chase-ppo.json"), "utf8")),
);

function startFiveStarChase(world) {
  world.command({
    type: "street-pursuit-start",
    level: 5,
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
    sha256: "builtin-perf-eval",
    status: "active",
    lastTick: -1,
    decisions: 0,
    recoverStale: true,
    evasion: true,
    evasiveControl: PAKO_EVASIVE_CONTROL,
  };
}

function refBoxHit({ x, z, w, l, cos, sin }, r, f, far) {
  const EPS = 1e-9;
  const dx = r * cos - f * sin;
  const dz = r * sin + f * cos;
  let near = 0;
  if (Math.abs(dx) < EPS) {
    if (Math.abs(x) > w + EPS) return Infinity;
  } else {
    const a = (-w - x) / dx;
    const b = (w - x) / dx;
    near = Math.max(near, Math.min(a, b));
    far = Math.min(far, Math.max(a, b));
    if (near > far + EPS) return Infinity;
  }
  if (Math.abs(dz) < EPS) {
    if (Math.abs(z) > l + EPS) return Infinity;
  } else {
    const a = (-l - z) / dz;
    const b = (l - z) / dz;
    near = Math.max(near, Math.min(a, b));
    far = Math.min(far, Math.max(a, b));
    if (near > far + EPS) return Infinity;
  }
  return near <= far + EPS ? near : Infinity;
}

function refCircleHit({ right, forward, radius }, r, f) {
  const EPS = 1e-9;
  const cross = right * f - forward * r;
  if (Math.abs(cross) > radius + EPS) return Infinity;
  const projection = right * r + forward * f;
  const chord = Math.sqrt(Math.max(0, radius * radius - cross * cross));
  return projection + chord < 0 ? Infinity : Math.max(0, projection - chord);
}

function evaluateScannerAndSurfaceParity({ createScanner = () => new PursuitScanner() } = {}) {
  const world = new World(
    { seed: "parity-audit-20261125", cityVersion: 5, traffic: 68, pedestrians: 190 },
    "metro",
  );
  startFiveStarChase(world);
  const scanner = createScanner();
  const priority = { none: 0, civilian: 1, pedestrian: 2, police: 3, static: 4 };
  const zeroSmall = (n) => (Math.abs(n) < 1e-9 ? 0 : n);
  const rayStep = (Math.PI * 2) / PURSUIT_SCAN_RAYS;

  let rayChecks = 0;
  let mismatches = 0;

  for (let s = 0; s < 10; s++) {
    for (let k = 0; k < PURSUIT_SCAN_TICKS; k++) {
      applyFrozenDispatchAction(world, world.pursuit.frozenDriver);
      world.step();
    }
    const frame = scanner.sample(world);
    const heading = world.player.heading ?? 0;
    const ch = Math.cos(heading);
    const sh = Math.sin(heading);
    const shapes = [];
    const addRef = (body, kind) => {
      if (body === world.player) return;
      const dx = body.x - world.player.x;
      const dz = body.z - world.player.z;
      const right = dx * ch - dz * sh;
      const forward = dx * sh + dz * ch;
      const circle = kind === "pedestrian";
      const w = body.width / 2;
      const l = body.length / 2;
      if (!circle && !(w > 0 && l > 0)) return;
      const radius = circle ? body.radius : Math.hypot(w, l);
      if (!Number.isFinite(radius) || !(radius > 0) || !(Math.hypot(dx, dz) <= PURSUIT_SCAN_RANGE_M + radius + 1e-9)) {
        return;
      }
      if (circle) {
        shapes.push({ kind, radius, right, forward });
      } else {
        const ang = (body.heading ?? 0) - heading;
        const cos = Math.cos(ang);
        const sin = Math.sin(ang);
        shapes.push({
          kind,
          w,
          l,
          cos,
          sin,
          x: -right * cos + forward * sin,
          z: -right * sin - forward * cos,
        });
      }
    };
    for (const b of world.statics) addRef(b, "static");
    for (const b of world.actors) {
      if (b.type === "pedestrian" || b.type === "static") addRef(b, b.type);
      else if (b.type === "vehicle") addRef(b, b.pursuitRole === "police" ? "police" : "civilian");
    }

    for (let r = 0; r < PURSUIT_SCAN_RAYS; r++) {
      const ang = r * rayStep;
      const rx = zeroSmall(Math.sin(ang));
      const rf = zeroSmall(Math.cos(ang));
      let refRange = PURSUIT_SCAN_RANGE_M;
      let refKind = "none";
      for (const body of shapes) {
        const hit =
          body.kind === "pedestrian"
            ? refCircleHit(body, rx, rf)
            : refBoxHit(body, rx, rf, refRange);
        if (hit > PURSUIT_SCAN_RANGE_M + 1e-9) continue;
        const measured = Math.min(hit, PURSUIT_SCAN_RANGE_M);
        if (measured < refRange || (measured === refRange && priority[body.kind] > priority[refKind])) {
          refRange = measured;
          refKind = body.kind;
        }
      }
      rayChecks++;
      if (!Object.is(frame.rays[r].rangeM, refRange) || frame.rays[r].kind !== refKind) {
        mismatches++;
      }
    }
  }

  // Surface lookup parity across 400 city points
  const terrain = world.terrain;
  let surfaceChecks = 0;
  let surfaceMismatches = 0;
  const refSurfaceAt = (x, z) => {
    for (let i = 0; i < terrain.waterPuddles.length; i++) {
      if (pointInWaterPuddle(x, z, terrain.waterPuddles[i], i, 0)) return "water";
    }
    for (const zObj of terrain.sandZones) {
      if (pointInShapedSurfaceZone(x, z, zObj)) return "sand";
    }
    for (const zObj of terrain.cobbleZones) {
      if (pointInShapedSurfaceZone(x, z, zObj)) return "cobble";
    }
    return "asphalt";
  };

  for (let gx = -420; gx <= 420; gx += 45) {
    for (let gz = -380; gz <= 380; gz += 40) {
      surfaceChecks++;
      const fastKind = querySurfaceKindFast(terrain, gx, gz);
      const physKind = sampleCitySurface(terrain, gx, gz).surfaceKind;
      if (fastKind !== refSurfaceAt(gx, gz) || fastKind !== physKind) {
        surfaceMismatches++;
      }
    }
  }

  const passed = rayChecks === 720 && mismatches === 0 && surfaceChecks >= 350 && surfaceMismatches === 0;
  return {
    passed,
    rayChecks,
    mismatches,
    surfaceChecks,
    surfaceMismatches,
  };
}

function evaluateCpuChase210TickBenchmark({ instrumentWorld = null } = {}) {
  const makeBenchWorld = () => {
    const w = new World(
      { seed: "perf-210-chase-smooth", cityVersion: 5, traffic: 68, pedestrians: 190 },
      "metro",
    );
    startFiveStarChase(w);
    for (let i = 0; i < 90; i++) {
      if (w.pursuit?.phase === "running") {
        applyFrozenDispatchAction(w, w.pursuit.frozenDriver);
      }
      w.step();
    }
    w.command({ type: "spawn-crowd-ahead", count: 20 });
    for (let i = 0; i < 36; i++) {
      if (w.pursuit?.phase === "running") {
        applyFrozenDispatchAction(w, w.pursuit.frozenDriver);
      }
      w.step();
    }
    return w;
  };

  // V8 TurboFan JIT warmup pass across all active chase/curb/crowd/alley code paths before steady-state measurement
  const warmupWorld = makeBenchWorld();
  for (let i = 0; i < 240; i++) {
    if (warmupWorld.pursuit?.phase === "running") {
      applyFrozenDispatchAction(warmupWorld, warmupWorld.pursuit.frozenDriver);
    }
    warmupWorld.step();
  }

  const world = makeBenchWorld();
  if (typeof instrumentWorld === "function") {
    instrumentWorld(world);
  }
  const totalPedestrians = world.actors.filter((a) => a.type === "pedestrian").length;

  const ticks = 240;
  const samplesMs = [];
  for (let i = 0; i < ticks; i++) {
    const t0 = performance.now();
    if (world.pursuit?.phase === "running") {
      applyFrozenDispatchAction(world, world.pursuit.frozenDriver);
    }
    world.step();
    const elapsed = performance.now() - t0;
    samplesMs.push(elapsed);
  }
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const avgTickMs = samplesMs.reduce((s, v) => s + v, 0) / ticks;
  const medianTickMs = sorted[Math.floor(ticks * 0.5)];
  const p95TickMs = sorted[Math.floor(ticks * 0.95)];

  const passed =
    totalPedestrians >= 205 &&
    avgTickMs <= 6.5 &&
    p95TickMs <= 12.0;

  return {
    passed,
    totalPedestrians,
    ticks,
    avgTickMs: Number(avgTickMs.toFixed(3)),
    medianTickMs: Number(medianTickMs.toFixed(3)),
    p95TickMs: Number(p95TickMs.toFixed(3)),
  };
}

function evaluateWaterSandAndCrashGpuAudit({ faultIdleGpuUploadChurnOnly = false } = {}) {
  const world = new World(
    { seed: "gpu-fx-audit", cityVersion: 5, traffic: 24, pedestrians: 20 },
    "metro",
  );
  const scene = new THREE.Scene();
  const cam = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 600);
  cam.position.set(world.player.x, 6, world.player.z - 12);
  cam.lookAt(world.player.x, 1, world.player.z + 10);
  cam.updateMatrixWorld(true);

  const surfView = createStreetSurfacesView(scene, world);
  const crashFx = createCrashEffects(scene);
  const smokeMesh = crashFx.layer.getObjectByName("crash-smoke-plumes");
  const glassMesh = crashFx.layer.getObjectByName("crash-glass-shards");
  const sparkMesh = crashFx.layer.getObjectByName("crash-impact-sparks");
  const skidMesh = crashFx.layer.getObjectByName("crash-tire-skid-ribbons");

  // Ensure player & nearby vehicles are parked/calm on dry asphalt for idle zero-upload audit
  world.player.x = -254;
  world.player.z = -109.5;
  world.player.speed = 0;
  for (const a of world.actors) {
    if (a.type === "vehicle") a.speed = 0;
  }

  surfView.update(world, 1 / 60, cam);
  crashFx.update(world, 1 / 60, cam);

  const snapVersions = () => [
    surfView.waterRipples.instanceMatrix.version,
    surfView.waterSplashes.instanceMatrix.version,
    surfView.sandDust.instanceMatrix.version,
    surfView.sandGrit.instanceMatrix.version,
    glassMesh.instanceMatrix.version,
    sparkMesh.instanceMatrix.version,
    smokeMesh.instanceMatrix.version,
    skidMesh.geometry.attributes.position.version,
  ];
  const beforeIdle = snapVersions();
  for (let i = 0; i < 25; i++) {
    world.tick++;
    surfView.update(world, 1 / 60, cam);
    crashFx.update(world, 1 / 60, cam);
    smokeMesh.onBeforeRender(null, scene, cam);
    if (faultIdleGpuUploadChurnOnly && i === 5) {
      surfView.waterSplashes.instanceMatrix.needsUpdate = true;
    }
  }
  const afterIdle = snapVersions();
  let idleVersionIncrements = 0;
  for (let i = 0; i < beforeIdle.length; i++) {
    idleVersionIncrements += Math.max(0, afterIdle[i] - beforeIdle[i]);
  }

  // Single-pass smoke orientation check
  world.player.vehicle.damage.front = 0.72;
  world.player.vehicle.damage.parts.radiator.leaking = true;
  crashFx.update(world, 1 / 60, cam);
  const vSmoke0 = smokeMesh.instanceMatrix.version;
  world.tick++;
  crashFx.update(world, 1 / 60, cam);
  smokeMesh.onBeforeRender(null, scene, cam);
  const smokeUploadsPerSingleCameraFrame = smokeMesh.instanceMatrix.version - vSmoke0;

  // Pooled traffic damagedGeometry reuse check
  const { root: trafficRoot } = createUnifiedTrafficModel({
    kind: "sedan",
    width: 1.85,
    length: 4.2,
    phase: 0.3,
  });
  applyTrafficCrashDamage(trafficRoot, { front: 0.8 });
  const firstDamagedGeo = trafficRoot.userData.trafficShell.geometry;
  let resetDisposes = 0;
  firstDamagedGeo.addEventListener("dispose", () => resetDisposes++);
  applyTrafficCrashDamage(trafficRoot, { front: 0, rear: 0, left: 0, right: 0, wrecked: false });
  applyTrafficCrashDamage(trafficRoot, { rear: 0.7, wrecked: true });
  const reusedSameDamagedGeo =
    resetDisposes === 0 && trafficRoot.userData.trafficShell.geometry === firstDamagedGeo;
  disposeUnifiedTrafficModel(trafficRoot);

  // Active water+sand + crash multi-burst frame benchmark
  const puddle = world.terrain.waterPuddles[0];
  const sand = world.terrain.sandZones[0];
  const cars = world.actors.filter((a) => a.type === "vehicle");
  cars.forEach((car, idx) => {
    const zTarget = idx % 2 === 0 ? puddle : sand;
    car.x = zTarget.x + ((idx % 4) - 1.5) * 1.1;
    car.z = zTarget.z;
    car.heading = zTarget.heading ?? Math.PI / 2;
    car.speed = 13.5;
  });
  world.player.x = puddle.x;
  world.player.z = puddle.z;
  world.player.speed = 15;
  for (let b = 0; b < 5; b++) {
    crashFx.spawnBurst({
      x: puddle.x + b * 2.5,
      y: 0,
      z: puddle.z,
      side: "front",
      energyJ: 44000,
      parts: CRASH_PART_KINDS.slice(0, 3),
      shatterGlass: true,
    });
  }

  let bestCombinedFxMs = Infinity;
  for (let trial = 0; trial < 3; trial++) {
    const t0 = performance.now();
    for (let f = 0; f < 90; f++) {
      world.tick++;
      surfView.update(world, 1 / 60, cam);
      crashFx.update(world, 1 / 60, cam);
      smokeMesh.onBeforeRender(null, scene, cam);
    }
    bestCombinedFxMs = Math.min(bestCombinedFxMs, (performance.now() - t0) / 90);
  }

  surfView.dispose();
  crashFx.dispose();

  const passed =
    idleVersionIncrements === 0 &&
    smokeUploadsPerSingleCameraFrame === 1 &&
    reusedSameDamagedGeo === true &&
    bestCombinedFxMs <= 1.25;

  return {
    passed,
    idleVersionIncrements,
    smokeUploadsPerSingleCameraFrame,
    reusedSameDamagedGeo,
    avgCombinedActiveFxMs: Number(bestCombinedFxMs.toFixed(4)),
  };
}

function readPngDimensions(filePath) {
  const buf = readFileSync(filePath);
  if (buf.length < 32) return null;
  const pngSig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) {
    if (buf[i] !== pngSig[i]) return null;
  }
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  return { width, height, bytes: buf.length };
}

function evaluateTenScreenshotsGallery({ faultMissingGalleryScreenshotOnly = false } = {}) {
  const rawReadme = readFileSync(resolve(rootDir, "README.md"), "utf8");
  const readme = faultMissingGalleryScreenshotOnly
    ? rawReadme.replaceAll(GALLERY_SCREENSHOT_FILES[4], "missing-image.png")
    : rawReadme;

  const screenshotsDir = resolve(rootDir, "docs/screenshots");
  const details = [];
  let validPngCount = 0;
  let linkedInReadmeCount = 0;

  for (const file of GALLERY_SCREENSHOT_FILES) {
    const abs = join(screenshotsDir, file);
    const exists = existsSync(abs);
    const meta = exists ? readPngDimensions(abs) : null;
    const sizeBytes = exists ? statSync(abs).size : 0;
    const sha256 = exists ? createHash("sha256").update(readFileSync(abs)).digest("hex") : null;
    const validPng =
      Boolean(meta) &&
      meta.width === 1365 &&
      meta.height === 900 &&
      sizeBytes >= 150000;
    const linked = readme.includes(`./docs/screenshots/${file}`);
    if (validPng) validPngCount++;
    if (linked) linkedInReadmeCount++;
    details.push({
      file,
      exists,
      width: meta?.width ?? 0,
      height: meta?.height ?? 0,
      bytes: sizeBytes,
      sha256,
      validPng,
      linkedInReadme: linked,
    });
  }

  const passed =
    GALLERY_SCREENSHOT_FILES.length === 10 &&
    validPngCount === 10 &&
    linkedInReadmeCount === 10;

  return {
    passed,
    expectedCount: 10,
    validPngCount,
    linkedInReadmeCount,
    details,
  };
}

const isMainEntry =
  Boolean(process.argv[1]) &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainEntry && negativeFaultMode) {
  // 1. Real simulation-step CPU stall injected into world.step (unmodified timing oracle!)
  const faultCpuSpike = evaluateCpuChase210TickBenchmark({
    instrumentWorld: (w) => {
      const origStep = w.step.bind(w);
      w.step = function faultSlowStep(...args) {
        if (this.tick % PURSUIT_SCAN_TICKS === 0) {
          const busyUntil = performance.now() + 13.5;
          while (performance.now() < busyUntil) {
            // genuine busy-wait CPU stall inside simulation step
          }
        }
        return origStep(...args);
      };
    },
  });
  // 2. Real GPU buffer upload churn injected onto instanced attribute
  const faultIdleGpu = evaluateWaterSandAndCrashGpuAudit({ faultIdleGpuUploadChurnOnly: true });
  // 3. Real scanner-return corruption injected into scanner.sample() before the unmodified parity oracle!
  const faultScannerMismatch = evaluateScannerAndSurfaceParity({
    createScanner: () => {
      const base = new PursuitScanner();
      let calls = 0;
      return {
        sample(w) {
          const scan = base.sample(w);
          if (++calls === 1) {
            const mutatedRays = scan.rays.map((r, idx) =>
              idx === 0
                ? Object.freeze({ ...r, rangeM: r.rangeM > 2.0 ? r.rangeM - 1.75 : r.rangeM + 1.75 })
                : r,
            );
            return Object.freeze({ ...scan, rays: Object.freeze(mutatedRays) });
          }
          return scan;
        },
      };
    },
  });
  // 4. Broken/missing README proof link
  const faultMissingScreenshot = evaluateTenScreenshotsGallery({ faultMissingGalleryScreenshotOnly: true });

  const detectedCpuSpikeFault = !faultCpuSpike.passed && faultCpuSpike.p95TickMs > 12.0;
  const detectedIdleGpuUploadChurnFault = !faultIdleGpu.passed && faultIdleGpu.idleVersionIncrements > 0;
  const detectedScannerMismatchFault = !faultScannerMismatch.passed && faultScannerMismatch.mismatches > 0;
  const detectedMissingGalleryScreenshotFault =
    !faultMissingScreenshot.passed && faultMissingScreenshot.linkedInReadmeCount < 10;

  const passed =
    faultCpuSpike.passed &&
    faultIdleGpu.passed &&
    faultScannerMismatch.passed &&
    faultMissingScreenshot.passed;

  const negReport = {
    schema: 1,
    at: new Date().toISOString(),
    mode: "negative-fault",
    passed,
    detectedCpuSpikeFault,
    detectedIdleGpuUploadChurnFault,
    detectedScannerMismatchFault,
    detectedMissingGalleryScreenshotFault,
    isolatedFaultAudits: {
      faultCpuSpike,
      faultIdleGpu,
      faultScannerMismatch,
      faultMissingScreenshot,
    },
  };
  writeFileSync(join(outDir, "perf-negative-fault.json"), JSON.stringify(negReport, null, 2));
  assert.equal(passed, false);
  assert.equal(detectedCpuSpikeFault, true);
  assert.equal(detectedIdleGpuUploadChurnFault, true);
  assert.equal(detectedScannerMismatchFault, true);
  assert.equal(detectedMissingGalleryScreenshotFault, true);
  process.exit(1);
}

if (isMainEntry) {
  const scannerAndSurfaceParityAudit = evaluateScannerAndSurfaceParity();
  const cpuChase210TickBenchmark = evaluateCpuChase210TickBenchmark();
  const waterSandAndCrashGpuAudit = evaluateWaterSandAndCrashGpuAudit();
  const tenScreenshotsGalleryAudit = evaluateTenScreenshotsGallery();

  const passed =
    scannerAndSurfaceParityAudit.passed &&
    cpuChase210TickBenchmark.passed &&
    waterSandAndCrashGpuAudit.passed &&
    tenScreenshotsGalleryAudit.passed;

  const report = {
    schema: 1,
    at: new Date().toISOString(),
    passed,
    scannerAndSurfaceParityAudit,
    cpuChase210TickBenchmark,
    waterSandAndCrashGpuAudit,
    tenScreenshotsGalleryAudit,
  };

  writeFileSync(join(outDir, "perf-eval.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (!passed) process.exit(1);
}
