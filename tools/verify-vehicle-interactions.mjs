import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import * as THREE from "three";
import { STEP } from "../src/core/config.js";
import { World } from "../src/core/world.js";
import { WorldView } from "../src/render/world-view.js";
import { createCrashEffects } from "../src/render/crash-effects.js";
import { createStreetSurfacesView } from "../src/render/street-surfaces-view.js";
import {
  WHEEL_SCRUB_MODE,
  getActorImpactReaction,
} from "../src/core/wheel-interaction-physics.js";
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
  : resolve(rootDir, ".runtime-proof/vehicle-surface-object-interactions-20261124/local-eval");
mkdirSync(outDir, { recursive: true });

const negativeFaultMode = process.argv.includes("--negative-fault");

function evaluateWheelAndObjectPhysics({ interactionProfile = WHEEL_SCRUB_MODE } = {}) {
  // 1. Shallow curb grazing vs decisive curb climbing in manual Metro City v5
  const worldGraze = new World(
    { cityVersion: 5, traffic: 0, pedestrians: 0, seed: "eval-curb-graze", interactionProfile },
    "metro",
  );
  const site =
    worldGraze.curbs?.sites?.find((s) => s.axis === "z" && s.avenue && s.maxZ - s.minZ >= 35) ??
    { edge: 7, side: 1, minZ: -40, maxZ: 40 };
  const curbSide = site.side ?? 1;
  const startZ = (site.minZ + site.maxZ) * 0.5 - 10;
  const grazeAngle = curbSide * ((8 * Math.PI) / 180);

  worldGraze.player.x = site.edge - curbSide * (worldGraze.player.width * 0.5 - 0.04);
  worldGraze.player.z = startZ;
  worldGraze.player.heading = grazeAngle;
  worldGraze.player.speed = 10.5;
  worldGraze.command({ type: "drive", targetSpeed: 10.5, steer: 0 });

  let sawCurbScrub = false;
  let peakSteerKick = 0;
  for (let i = 0; i < 18; i++) {
    worldGraze.step();
    const scr = worldGraze.player.vehicle?.interaction?.scraping;
    if (scr?.active && scr.kind === "curb") {
      sawCurbScrub = true;
      if (Math.abs(scr.steerKickRad ?? 0) > peakSteerKick) {
        peakSteerKick = Math.abs(scr.steerKickRad ?? 0);
      }
    }
  }
  const headingDeflectedMrad = (Math.abs(grazeAngle) - Math.abs(worldGraze.player.heading)) * 1000;
  const grazeSpeedLossMps = 10.5 - worldGraze.player.speed;

  // 2. Steeper ~36 deg climb onto sidewalk
  const worldClimb = new World(
    { cityVersion: 5, traffic: 0, pedestrians: 0, seed: "eval-curb-climb", interactionProfile },
    "metro",
  );
  const climbAngle = curbSide * ((36 * Math.PI) / 180);
  worldClimb.player.x = site.edge - curbSide * 1.25;
  worldClimb.player.z = startZ;
  worldClimb.player.heading = climbAngle;
  worldClimb.player.speed = 6.5;
  worldClimb.command({ type: "drive", targetSpeed: 6.5, steer: curbSide * 0.25 });

  let climbedSidewalk = false;
  for (let i = 0; i < 30; i++) {
    worldClimb.step();
    const offsets = worldClimb.player.vehicle?.suspension?.terrainOffsetsM;
    if (worldClimb.player.curbSupportId && offsets && Object.values(offsets).some((v) => Math.abs(v) > 0.005)) {
      climbedSidewalk = true;
      break;
    }
  }

  // 3. Sideswiping a real City parked sedan: Coulomb friction + two-body vehicle rocking
  const worldSwipe = new World(
    { cityVersion: 5, traffic: 0, pedestrians: 0, seed: "eval-sideswipe", interactionProfile },
    "metro",
  );
  const worldBaseline = new World(
    { cityVersion: 5, traffic: 0, pedestrians: 0, seed: "eval-sideswipe", interactionProfile: "none" },
    "metro",
  );
  const parked = worldSwipe.statics.find((a) => a.id === "grand-parked-tahrir-boulevard-0");
  const parkedBase = worldBaseline.statics.find((a) => a.id === "grand-parked-tahrir-boulevard-0");
  const theta = 0.14;
  const placeSwipe = (p, target) => {
    Object.assign(p, {
      x: target.x - 1.1,
      z: target.z - target.width / 2 - (Math.sin(theta) * p.length / 2 + Math.cos(theta) * p.width / 2) - 0.004,
      heading: Math.PI / 2 - theta,
      speed: 9.5,
      steer: 0,
      path: [],
    });
  };
  placeSwipe(worldSwipe.player, parked);
  placeSwipe(worldBaseline.player, parkedBase);
  worldSwipe.command({ type: "drive", targetSpeed: 9.5, steer: 0 });
  worldBaseline.command({ type: "drive", targetSpeed: 9.5, steer: 0 });

  let sawVehicleScrape = false;
  let peakParkedJoltRollRad = 0;
  for (let i = 0; i < 16; i++) {
    worldSwipe.step();
    worldBaseline.step();
    const scr = worldSwipe.player.vehicle?.interaction?.scraping;
    if (scr?.active && scr.kind === "vehicle") sawVehicleScrape = true;
    const rx = getActorImpactReaction(parked);
    if (Math.abs(rx.rollRad) > peakParkedJoltRollRad) peakParkedJoltRollRad = Math.abs(rx.rollRad);
  }
  const coulombSpeedDeltaMps = worldBaseline.player.speed - worldSwipe.player.speed;

  // 4. Moving traffic jolt + relative tangential contact speed check
  const worldMoving = new World(
    { cityVersion: 5, traffic: 4, pedestrians: 0, seed: "eval-moving-jolt", interactionProfile },
    "metro",
  );
  const movingCar = worldMoving.actors.find((a) => a !== worldMoving.player && a.type === "vehicle");
  let peakMovingTrafficJoltRollRad = 0;
  let sameSpeedTangentialMps = 99;
  if (movingCar) {
    Object.assign(movingCar, {
      x: 0,
      z: -108.0,
      heading: Math.PI / 2,
      speed: 10.8,
      steer: 0,
      path: [{ x: -10, z: -108.0 }, { x: 80, z: -108.0 }],
      cursor: 0,
    });
    Object.assign(worldMoving.player, {
      x: movingCar.x - 0.8,
      z: movingCar.z - movingCar.width / 2 -
        (Math.sin(theta) * worldMoving.player.length / 2 + Math.cos(theta) * worldMoving.player.width / 2) - 0.004,
      heading: Math.PI / 2 - theta,
      speed: 11.0,
      steer: 0,
      path: [],
    });
    worldMoving.command({ type: "drive", targetSpeed: 11.0, steer: 0 });
    for (let i = 0; i < 12; i++) {
      worldMoving.step();
      const scr = worldMoving.player.vehicle?.interaction?.scraping;
      if (scr?.active && scr.tangentialSpeedMps < sameSpeedTangentialMps) {
        sameSpeedTangentialMps = scr.tangentialSpeedMps;
      }
      const rx = getActorImpactReaction(movingCar);
      if (Math.abs(rx.rollRad) > peakMovingTrafficJoltRollRad) {
        peakMovingTrafficJoltRollRad = Math.abs(rx.rollRad);
      }
    }
  }

  const passed =
    sawCurbScrub &&
    headingDeflectedMrad >= 4.0 &&
    grazeSpeedLossMps >= 0.12 &&
    climbedSidewalk &&
    sawVehicleScrape &&
    coulombSpeedDeltaMps >= 0.08 &&
    peakParkedJoltRollRad >= 0.008 &&
    peakMovingTrafficJoltRollRad >= 0.004 &&
    (interactionProfile !== WHEEL_SCRUB_MODE || sameSpeedTangentialMps < 1.2);

  return {
    passed,
    sawCurbScrub,
    headingDeflectedMrad: Number(headingDeflectedMrad.toFixed(3)),
    grazeSpeedLossMps: Number(grazeSpeedLossMps.toFixed(4)),
    peakSteerKickRad: Number(peakSteerKick.toFixed(4)),
    climbedSidewalk,
    climbTerrainOffsetsSample: worldClimb.player.vehicle?.suspension?.terrainOffsetsM ?? null,
    sawVehicleScrape,
    coulombSpeedDeltaMps: Number(coulombSpeedDeltaMps.toFixed(4)),
    peakParkedJoltRollRad: Number(peakParkedJoltRollRad.toFixed(4)),
    peakMovingTrafficJoltRollRad: Number(peakMovingTrafficJoltRollRad.toFixed(4)),
    sameSpeedTangentialMps: Number(sameSpeedTangentialMps.toFixed(4)),
    sideswipeInteractionSample: worldSwipe.player.vehicle?.interaction ?? null,
  };
}

function evaluateVolumetricSmokeAndScrape({ faultSolidSmoke = false } = {}) {
  const scene = new THREE.Scene();
  const fx = createCrashEffects(scene);
  const cam = new THREE.PerspectiveCamera(62, 16 / 9, 0.1, 500);
  cam.position.set(0, 4.5, -10);
  cam.lookAt(0, 0.8, 0);

  if (faultSolidSmoke) {
    // Inject REAL Three.js renderer fault onto live crash-smoke-plumes InstancedMesh!
    const smokeMesh = fx.layer.getObjectByName("crash-smoke-plumes");
    if (smokeMesh) {
      smokeMesh.geometry = new THREE.IcosahedronGeometry(0.5, 1);
      smokeMesh.material.map = null;
    }
  }

  const diag0 = fx.diagnostics();
  const geometryType = diag0.smokeGeometryType;
  const hasPerInstanceAlpha = Boolean(diag0.hasPerInstanceSmokeAlpha);
  const hasFbmTex = Boolean(diag0.hasSmokeFbmTexture);

  // Keep identical real driving & scraping inputs active whether faultSolidSmoke is true or false
  // so the negative control tests ONLY the injected rendering defect!
  const mockWorld = {
    tick: 120,
    terrainElevationAt: () => 0,
    actors: [],
    player: {
      id: "player",
      x: 0,
      y: 0,
      z: 0,
      heading: 0,
      speed: 14.5,
      chaseSlip: 0.28,
      width: 1.85,
      length: 4.2,
      vehicle: {
        controls: { throttle: 0.85, brake: 0 },
        damage: { front: 0.52, impactCount: 0, parts: { radiator: { leaking: true } } },
        surface: { kind: "asphalt" },
        interaction: {
          tireSmokeIntensity: 0.82,
          scraping: { active: false, kind: "none", intensity: 0 },
        },
      },
    },
  };
  mockWorld.actors = [mockWorld.player];

  // Phase A: 9 frames of pure dry drift (emits rear tire smoke + skids)
  for (let i = 0; i < 9; i++) {
    mockWorld.tick++;
    mockWorld.player.z += 14.5 / 60;
    fx.update(mockWorld, 1 / 60, cam);
  }
  const driftDiag = fx.diagnostics();

  // Phase B: 9 frames of pure right-front barrier scrape (tireSmokeIntensity = 0; must emit localized scrape smoke & sparks with 0 drift smoke!)
  fx.reset();
  mockWorld.player.vehicle.damage = { front: 0, impactCount: 0, parts: {} };
  mockWorld.player.vehicle.interaction.tireSmokeIntensity = 0;
  mockWorld.player.vehicle.interaction.scraping = {
    active: true,
    kind: "barrier",
    wheel: "frontRight",
    side: "right",
    intensity: 0.86,
    tangentialSpeedMps: 11.2,
    closingSpeedMps: 1.5,
    worldX: 0.92,
    worldZ: mockWorld.player.z + 1.34,
    normalX: -1,
    normalZ: 0,
  };
  for (let i = 0; i < 9; i++) {
    mockWorld.tick++;
    mockWorld.player.z += 14.5 / 60;
    mockWorld.player.vehicle.interaction.scraping.worldZ = mockWorld.player.z + 1.34;
    fx.update(mockWorld, 1 / 60, cam);
  }

  const diagAfter = fx.diagnostics();
  const oppositeSideScrapePuffs = diagAfter.activeSmokePositions.filter(
    (p) => (p.kind === "scrape" || p.kind === "tire") && p.x < 0,
  ).length;
  fx.dispose();

  const passed =
    geometryType === "PlaneGeometry" &&
    hasFbmTex === true &&
    hasPerInstanceAlpha === true &&
    driftDiag.activeDriftTireSmoke >= 2 &&
    diagAfter.activeSmoke >= 4 &&
    diagAfter.activeScrapeSmoke >= 2 &&
    diagAfter.activeDriftTireSmoke === 0 &&
    oppositeSideScrapePuffs === 0 &&
    diagAfter.activeSparks >= 4 &&
    diagAfter.activeSkidSegments >= 2;

  return {
    passed,
    smokeGeometryType: geometryType,
    hasSmokeFbmTexture: hasFbmTex,
    hasPerInstanceSmokeAlpha: hasPerInstanceAlpha,
    activeDriftTireSmokeInDrift: driftDiag.activeDriftTireSmoke,
    activeSmokePuffs: diagAfter.activeSmoke,
    activeTireSmokePuffs: diagAfter.activeTireSmoke,
    activeDriftTireSmokeDuringScrape: diagAfter.activeDriftTireSmoke,
    oppositeSideScrapePuffs,
    activeScrapeSparks: diagAfter.activeSparks,
    activeSkidSegments: diagAfter.activeSkidSegments,
  };
}

function evaluateWaterAndSandInteractions({ faultOpaqueWater = false, faultStaticSand = false } = {}) {
  const world = new World({ cityVersion: 5, traffic: 0, pedestrians: 0, seed: "eval-water-sand" }, "metro");
  const scene = new THREE.Scene();
  const surfView = createStreetSurfacesView(scene, world);
  const cam = new THREE.PerspectiveCamera(62, 16 / 9, 0.1, 500);
  cam.position.set(0, 4.5, -10);
  cam.lookAt(0, 0.5, 0);

  if (faultOpaqueWater) {
    // Strip the actual Fresnel onBeforeCompile shader hook and make water opaque!
    const waterMesh = surfView.root.getObjectByName("street-water-puddles");
    if (waterMesh?.material) {
      waterMesh.material.opacity = 0.92;
      waterMesh.material.envMapIntensity = 1.65;
      waterMesh.material.onBeforeCompile = () => {};
    }
    if (surfView.waterSplashes) {
      surfView.waterSplashes.geometry = new THREE.SphereGeometry(0.2);
    }
  }
  if (faultStaticSand) {
    // Disable dynamic sand ruts and dust meshes so sand behaves as a static painted polygon!
    if (surfView.sandTireRuts) surfView.sandTireRuts.visible = false;
    if (surfView.sandDust) surfView.sandDust.visible = false;
  }

  const diag0 = surfView.diagnostics();
  const waterOpacity = diag0.waterBaseOpacity;
  const waterEnvIntensity = diag0.waterEnvMapIntensity;
  const hasFresnel = Boolean(diag0.hasFresnelWaterShader);
  const billboardFx = Boolean(diag0.billboardSprayAndDust);
  const hasDynamicSand = Boolean(diag0.hasDynamicSandRuts);

  // 1. Slice through a standing water puddle then exit onto dry asphalt to leave wet tire tracks
  const puddle = world.terrain.waterPuddles[0];
  const ph = puddle.heading ?? 0;
  for (let step = 0; step < 14; step++) {
    const along = -3.0 + step * 0.45;
    world.player.x = puddle.x + Math.sin(ph) * along;
    world.player.z = puddle.z + Math.cos(ph) * along;
    world.player.heading = ph;
    world.player.speed = 13.0;
    world.player.vehicle.speed = 13.0;
    world.player.vehicle.surface = { kind: "water" };
    surfView.update(world, 1 / 60, cam);
  }
  const inWaterDiag = surfView.diagnostics();

  // Exit puddle onto dry asphalt ~40 m away so wet tire reservoir stamps wet tracks
  const dryRoad = world.drivingRoads.find((r) => r.zone === "avenue" && r.axis === "z") ?? world.drivingRoads[0];
  for (let step = 0; step < 12; step++) {
    world.player.x = dryRoad.fixed ?? 0;
    world.player.z = (dryRoad.min + dryRoad.max) * 0.5 + step * 0.55;
    world.player.heading = 0;
    world.player.speed = 11.5;
    world.player.vehicle.speed = 11.5;
    world.player.vehicle.surface = { kind: "asphalt" };
    surfView.update(world, 1 / 60, cam);
  }
  const wetExitDiag = surfView.diagnostics();

  // 2. Plow through a sand zone to carve persistent 4-wheel sand ruts + FBM dust + ballistic grit
  const sand = world.terrain.sandZones[0];
  const sh = sand.heading ?? 0;
  for (let step = 0; step < 16; step++) {
    const along = -4.0 + step * 0.52;
    world.player.x = sand.x + Math.sin(sh) * along;
    world.player.z = sand.z + Math.cos(sh) * along;
    world.player.heading = sh;
    world.player.speed = 12.0;
    world.player.vehicle.speed = 12.0;
    world.player.vehicle.surface = { kind: "sand" };
    surfView.update(world, 1 / 60, cam);
  }
  const sandDiag = surfView.diagnostics();
  surfView.dispose();

  const passed =
    hasFresnel === true &&
    billboardFx === true &&
    hasDynamicSand === true &&
    waterOpacity <= 0.60 &&
    waterEnvIntensity <= 0.85 &&
    inWaterDiag.activeWaterRipples >= 2 &&
    inWaterDiag.activeWaterSplashes >= 6 &&
    wetExitDiag.activeWetTrackSegments >= 4 &&
    sandDiag.activeSandRutSegments >= 6 &&
    sandDiag.activeSandDust >= 4 &&
    sandDiag.activeSandGrit >= 4 &&
    sandDiag.drawCalls <= 18;

  return {
    passed,
    hasFresnelWaterShader: hasFresnel,
    billboardSprayAndDust: billboardFx,
    hasDynamicSandRuts: hasDynamicSand,
    waterBaseOpacity: waterOpacity,
    waterEnvMapIntensity: waterEnvIntensity,
    activeWaterRipples: inWaterDiag.activeWaterRipples,
    activeWaterSplashes: inWaterDiag.activeWaterSplashes,
    activeWetTrackSegments: wetExitDiag.activeWetTrackSegments,
    activeSandRutSegments: sandDiag.activeSandRutSegments,
    activeSandDust: sandDiag.activeSandDust,
    activeSandGrit: sandDiag.activeSandGrit,
    streetSurfaceDrawCalls: sandDiag.drawCalls,
  };
}

if (negativeFaultMode) {
  // Inject EACH named defect independently and require its corresponding check to fail!
  const frictionlessFault = evaluateWheelAndObjectPhysics({ interactionProfile: "none" });
  const solidSmokeFault = evaluateVolumetricSmokeAndScrape({ faultSolidSmoke: true });
  const opaqueWaterFault = evaluateWaterAndSandInteractions({ faultOpaqueWater: true, faultStaticSand: false });
  const staticSandFault = evaluateWaterAndSandInteractions({ faultOpaqueWater: false, faultStaticSand: true });

  const detectedWater = !opaqueWaterFault.passed && opaqueWaterFault.hasFresnelWaterShader === false;
  const detectedSand = !staticSandFault.passed && staticSandFault.hasDynamicSandRuts === false;

  const faultReport = {
    passed:
      frictionlessFault.passed ||
      solidSmokeFault.passed ||
      opaqueWaterFault.passed ||
      staticSandFault.passed,
    detectedFrictionlessZeroReactionFault: !frictionlessFault.passed,
    detectedFakeSolidBallSmokeFault: !solidSmokeFault.passed && solidSmokeFault.smokeGeometryType === "IcosahedronGeometry",
    detectedStaticSandAndOpaqueWaterFault: detectedWater && detectedSand,
    detectedOpaqueNonFresnelWaterIndependently: detectedWater,
    detectedStaticSandIndependently: detectedSand,
    frictionlessFault,
    solidSmokeFault,
    opaqueWaterFault,
    staticSandFault,
  };
  writeFileSync(join(outDir, "negative-fault.json"), JSON.stringify(faultReport, null, 2));
  console.log(JSON.stringify(faultReport));
  process.exit(faultReport.passed ? 0 : 1);
}

const wheelAndObjectPhysicsAudit = evaluateWheelAndObjectPhysics({ interactionProfile: WHEEL_SCRUB_MODE });
const volumetricSmokeAndScrapeAudit = evaluateVolumetricSmokeAndScrape({ faultSolidSmoke: false });
const waterAndSandInteractionAudit = evaluateWaterAndSandInteractions({ faultOpaqueWater: false, faultStaticSand: false });

// 5-Star 300-Tick 60 FPS Benchmark with full WorldView + volumetric FX + wheel interaction physics
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

function makeManual5StarChaseWorld(seed, traffic, pedestrians, patrols) {
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
  return w;
}

const warmup = makeManual5StarChaseWorld("interact-warmup", 40, 60, 8);
for (let i = 0; i < 60; i++) {
  if (warmup.pursuit?.phase !== "running") break;
  warmup.command({
    type: "pursuit-drive",
    action: { steer: Math.sin(i * 0.08) * 0.35, throttle: 1, brake: 0, gear: 1 },
  }, false);
  warmup.step(STEP);
}

// Primary Live 5-Star Metro Chase 300-Tick 60 FPS Benchmark (96 traffic, 144 pedestrians, 14 tactical police + full WorldView & FX)
const bench = makeManual5StarChaseWorld("interact-bench-5star", 96, 144, 14);
const benchView = new WorldView(bench);
const cam = new THREE.PerspectiveCamera(62, 1365 / 900, 0.1, 950);
for (let wStep = 0; wStep < 30; wStep++) {
  if (bench.pursuit?.phase !== "running") break;
  bench.command({
    type: "pursuit-drive",
    action: { steer: Math.sin(wStep * 0.07) * 0.25, throttle: 1, brake: 0, gear: 1 },
  }, false);
  bench.step(STEP);
  const wp = benchView.sync(1);
  cam.position.set(wp.position.x - 11, wp.position.y + 4.8, wp.position.z - 11);
  cam.lookAt(wp.position);
  benchView.prepareFrame({ cameras: [cam] });
}
const stepTimesMs = [];
for (let t = 0; t < 300; t++) {
  if (bench.pursuit?.phase !== "running") break;
  const t0 = performance.now();
  bench.command({
    type: "pursuit-drive",
    action: { steer: Math.sin(t * 0.06) * 0.32, throttle: 1, brake: 0, gear: 1 },
  }, false);
  bench.step(STEP);
  const p = benchView.sync(1);
  cam.position.set(p.position.x - 11, p.position.y + 4.8, p.position.z - 11);
  cam.lookAt(p.position);
  benchView.prepareFrame({ cameras: [cam] });
  stepTimesMs.push(performance.now() - t0);
}
benchView.dispose();

// Separate dev-mode PPO + 10Hz multi-rollout planner check (kept transparent & distinct from primary manual chase)
const devPpoWorld = makeChaseWorld("interact-dev-ppo", 48, 72, 10);
const devPpoTimesMs = [];
for (let t = 0; t < 60; t++) {
  if (devPpoWorld.pursuit?.phase !== "running") break;
  const t0 = performance.now();
  applyFrozenDispatchAction(devPpoWorld, devPpoWorld.pursuit.frozenDriver, null);
  devPpoWorld.step(STEP);
  devPpoTimesMs.push(performance.now() - t0);
}

const sorted = [...stepTimesMs].sort((a, b) => a - b);
const avgTotalTickMs = stepTimesMs.reduce((s, v) => s + v, 0) / stepTimesMs.length;
const p50TickMs = sorted[Math.floor(sorted.length * 0.5)];
const p95TickMs = sorted[Math.floor(sorted.length * 0.95)];

const perfBenchmark5Star = {
  passed: avgTotalTickMs <= 12.0 && p95TickMs <= 16.67,
  mode: "primary-manual-5star-metro-chase",
  ticks: stepTimesMs.length,
  avgTotalTickMs: Number(avgTotalTickMs.toFixed(3)),
  p50TickMs: Number(p50TickMs.toFixed(3)),
  p95TickMs: Number(p95TickMs.toFixed(3)),
  devPpoAvgTickMs: Number((devPpoTimesMs.reduce((s, v) => s + v, 0) / Math.max(1, devPpoTimesMs.length)).toFixed(3)),
  budgetMaxAvgMs: 12.0,
  budgetMaxP95Ms: 16.67,
};

const finalReport = {
  passed:
    wheelAndObjectPhysicsAudit.passed &&
    volumetricSmokeAndScrapeAudit.passed &&
    waterAndSandInteractionAudit.passed &&
    perfBenchmark5Star.passed,
  wheelAndObjectPhysicsAudit,
  volumetricSmokeAndScrapeAudit,
  waterAndSandInteractionAudit,
  perfBenchmark5Star,
};

writeFileSync(join(outDir, "interaction-eval.json"), JSON.stringify(finalReport, null, 2));
console.log(
  JSON.stringify({
    passed: finalReport.passed,
    avgTotalTickMs: perfBenchmark5Star.avgTotalTickMs,
    curbDeflectMrad: wheelAndObjectPhysicsAudit.headingDeflectedMrad,
    activeSmokePuffs: volumetricSmokeAndScrapeAudit.activeSmokePuffs,
    sandRutSegs: waterAndSandInteractionAudit.activeSandRutSegments,
    waterRipples: waterAndSandInteractionAudit.activeWaterRipples,
  }),
);
assert.equal(finalReport.passed, true, "All wheel physics, volumetric smoke, sand/water FX, and 60 FPS checks must pass");
