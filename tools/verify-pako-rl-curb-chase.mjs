import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { World } from "../src/core/world.js";
import { SpatialIndex } from "../src/core/spatial-index.js";
import { bodyOnRoad, distance, overlaps, pointOnRoad } from "../src/core/geometry.js";
import { districtRoadPose } from "../src/core/egypt-district.js";
import { METRO_CITY_CURBS, acceptCurbPose, surveyMetroCurb } from "../src/core/pako-curb.js";
import { AGGRESSIVE_CHASE_PRESENCE } from "../src/core/pako-aggressive-police.js";
import { PATROL_TRAFFIC_PREVIEW, DISPATCH_DAMAGE_FEEDBACK, initializeGtaPatrol } from "../src/core/pursuit-gta.js";
import { initializeDistrictActor } from "../src/core/district-behavior.js";
import { PATROL_LATERAL_YIELD } from "../src/core/pako-patrol-yield.js";
import { CLEAN_ESCAPE_REWARD, CLEARANCE_ROUTE_OBSERVATION_SCHEMA, GtaPursuitEnv, getDispatchObservation } from "../src/rl/gta-pursuit-env.js";
import { PAKO_EVASIVE_CONTROL, planPakoEvasiveAction } from "../src/rl/pako-evasive-control.js";
import { applyFrozenDispatchAction } from "../src/rl/pursuit-controller.js";
import { selectDispatchMovement } from "../src/rl/pursuit-shield.js";
import { freezePursuitPolicy, PursuitPpo } from "../src/rl/pursuit-ppo.js";
import { runPursuitEpisode } from "../src/rl/pursuit-rollouts.js";
import { PursuitScanner, PURSUIT_SCAN_TICKS } from "../src/signal_processing/pursuit-scanner.js";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = process.env.PROVE_IT_OUTPUT_DIR
  ? resolve(process.env.PROVE_IT_OUTPUT_DIR)
  : resolve(rootDir, ".runtime-proof/pako-rl-curb-chase-20261122/local-eval");
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

function measureOpeningPolice(level, aggressive) {
  const world = new World({ cityVersion: 4, seed: `police-presence-${level}`, traffic: 24, pedestrians: 40 }, "metro");
  world.command({
    type: "street-pursuit-start",
    variant: "gta",
    level,
    config: {
      ruleset: "dispatch-v1",
      wantedLevelMax: level,
      ...(aggressive ? { chasePresence: AGGRESSIVE_CHASE_PRESENCE } : {}),
    },
  }, false);
  const patrols = [...world.pursuit.patrols];
  const distances = patrols.map(u => distance(u, world.player)).sort((a, b) => a - b);
  const speeds = patrols.map(u => u.speed);
  return {
    level,
    count: patrols.length,
    nearestM: distances[0] ?? Infinity,
    within36M: distances.filter(d => d <= 36).length,
    maxInitialSpeedMps: Math.max(0, ...speeds),
  };
}

function runBlockedAvenueCurbTrial({ enableCurb, enableEvasion, addSidewalkPedestrian = false, policyAction }) {
  const world = new World({ cityVersion: 4, seed: "curb-avenue-bypass-01", traffic: 0, pedestrians: addSidewalkPedestrian ? 1 : 0 }, "metro");
  const civic = world.drivingRoads.find(r => r.id === "civic-avenue");
  assert.ok(civic && civic.axis === "z");
  const startPose = districtRoadPose(civic, -60, 1);
  Object.assign(world.player, { x: startPose.x, z: startPose.z, heading: 0, speed: 4.5 });
  world.player.previous = { ...world.player };

  world.command({
    type: "street-pursuit-start",
    variant: "gta",
    level: 1,
    config: {
      ruleset: "dispatch-v1",
      wantedLevelMax: 1,
      maxActivePatrols: 0,
      episodeMaxSeconds: 45,
      ...(enableCurb ? { curbSupport: METRO_CITY_CURBS } : {}),
    },
  }, false);

  // Full roadway shutter on civic-avenue at z = -38 (0.45 m gutter inset, blocking all 1.85 m vehicle lanes while leaving sidewalks open)
  const shutter = Object.freeze({
    id: "civic-asphalt-block",
    type: "static",
    kind: "barrier",
    x: civic.fixed,
    z: -38,
    width: civic.width - 0.9,
    length: 1.2,
    height: 1.6,
    heading: 0,
  });
  world.statics.push(shutter);

  if (addSidewalkPedestrian) {
    const person = world.actors.find(a => a.type === "pedestrian");
    // Block +x sidewalk with a static kiosk and place pedestrian directly on the -x sidewalk beside the shutter
    world.statics.push(Object.freeze({
      id: "civic-east-kiosk",
      type: "static",
      kind: "barrier",
      x: civic.fixed + civic.width / 2 + 1.2,
      z: -38,
      width: 2.2,
      length: 3.0,
      height: 2.0,
      heading: 0,
    }));
    const westCurbX = civic.fixed - civic.width / 2 - 1.05;
    Object.assign(person, {
      x: westCurbX,
      z: -38,
      heading: 0,
      speed: 0,
      walkSpeed: 0,
      motionMode: "stop",
      target: { x: westCurbX, z: -38 },
      walkRoute: [{ x: westCurbX, z: -38 }],
    });
    person.previous = { ...person };
  }
  world.staticIndex = new SpatialIndex(world.statics);
  world.actorIndex = new SpatialIndex(world.actors);
  world.pursuit.gta.publicRouteGoal = { ...districtRoadPose(civic, 40, 1), roadId: "civic-avenue", id: "civic-north-goal" };
  world.pursuit.gta.scanner = new PursuitScanner();
  world.pursuit.gta.scan = world.pursuit.gta.scanner.sample(world);

  let passedShutter = false;
  for (let step = 0; step < 200 && world.pursuit.phase === "running"; step++) {
    const obs = getDispatchObservation(world, CLEARANCE_ROUTE_OBSERVATION_SCHEMA.version);
    const requested = policyAction(obs);
    const guarded = selectDispatchMovement(world, requested, enableEvasion ? planPakoEvasiveAction : null);
    world.command({ type: "pursuit-drive", action: guarded.action }, false);
    for (let i = 0; i < PURSUIT_SCAN_TICKS && world.pursuit.phase === "running"; i++) {
      world.step();
      if (world.player.z > -26) passedShutter = true;
    }
    if (passedShutter && !world.player.curbSupportId && world.player.z > -18) break;
  }

  return {
    passedShutter,
    finalZ: world.player.z,
    distanceM: world.pursuit.metrics.distanceM,
    shoulderEntries: world.pursuit.metrics.shoulderEntries,
    shoulderExits: world.pursuit.metrics.shoulderExits,
    maxSupportHeightM: world.pursuit.metrics.maxSupportHeightM,
    collisions: world.pursuit.metrics.collisions,
    pedestrianCollisions: world.pursuit.metrics.pedestrianCollisions,
  };
}

function runNoseBlockedReverseTrial({ enableEvasion, policyAction }) {
  const world = new World({ cityVersion: 4, seed: "nose-blocked-reverse-01", traffic: 0, pedestrians: 0 }, "metro");
  const avenue = world.drivingRoads.find(r => r.id === "tahrir-boulevard");
  const startPose = districtRoadPose(avenue, -235, 1);
  Object.assign(world.player, { ...startPose, speed: 0, steer: 0 });
  world.player.previous = { ...world.player };

  world.command({
    type: "street-pursuit-start",
    variant: "gta",
    level: 1,
    config: {
      ruleset: "dispatch-v1",
      wantedLevelMax: 1,
      maxActivePatrols: 0,
      episodeMaxSeconds: 35,
      curbSupport: METRO_CITY_CURBS,
      ...(enableEvasion ? { chasePresence: AGGRESSIVE_CHASE_PRESENCE } : {}),
    },
  }, false);

  // Nose-to-nose police cruiser ~3.0 m ahead of ego center blocking the lane, requiring active reverse-turn + forward escape past the cruiser
  const cruiser = world.makeVehicle("nose-police-cruiser", "sedan", {
    x: world.player.x + Math.sin(world.player.heading) * 5.1,
    z: world.player.z + Math.cos(world.player.heading) * 5.1,
    heading: world.player.heading + Math.PI,
  });
  initializeGtaPatrol(cruiser, "patrol", world.pursuit);
  cruiser.aiState = "ROADBLOCK";
  cruiser.squadRole = "ROADBLOCK";
  cruiser.speed = 0;
  initializeDistrictActor(world, cruiser);
  cruiser.district.nextLoadingDistanceM = Infinity;
  world.pursuit.patrols.add(cruiser);
  world.actors.push(cruiser);
  world.actorIndex = new SpatialIndex(world.actors);
  world.pursuit.particles?.clear?.();
  world.pursuit.gta.publicRouteGoal = { ...districtRoadPose(avenue, -195, 1), roadId: "tahrir-boulevard", id: "tahrir-east-goal" };
  world.pursuit.gta.scanner = new PursuitScanner();
  world.pursuit.gta.scan = world.pursuit.gta.scanner.sample(world);

  let reversed = false;
  for (let step = 0; step < 140 && world.pursuit.phase === "running"; step++) {
    const obs = getDispatchObservation(world, CLEARANCE_ROUTE_OBSERVATION_SCHEMA.version);
    const requested = policyAction(obs);
    const guarded = selectDispatchMovement(world, requested, enableEvasion ? planPakoEvasiveAction : null);
    if (guarded.action.gear === -1) reversed = true;
    world.command({ type: "pursuit-drive", action: guarded.action }, false);
    for (let i = 0; i < PURSUIT_SCAN_TICKS && world.pursuit.phase === "running"; i++) world.step();
    if (world.player.x > cruiser.x + 8) break;
  }
  return {
    reversed,
    passedCruiser: world.player.x > cruiser.x + 6,
    distanceM: world.pursuit.metrics.distanceM,
    collisions: world.pursuit.metrics.collisions,
    pedestrianCollisions: world.pursuit.metrics.pedestrianCollisions,
  };
}

function runCurbIntersectionContactTrial({ enableUnstickFixes, policy, sha256 }) {
  const world = new World({ cityVersion: 4, seed: "screenshot-curb-contact-repro", traffic: 8, pedestrians: 16 }, "metro");
  const curb = surveyMetroCurb(world, METRO_CITY_CURBS);
  // Pick a z-axis sidewalk span whose +z end meets a cross-street intersection
  const site = curb.sites.find(s =>
    s.axis === "z" && s.side < 0 &&
    world.drivingRoads.some(r => r.axis === "x" && !r.parkingBay && Math.abs((r.fixed - r.width / 2) - s.maxZ) < 1.5),
  ) ?? curb.sites.find(s => s.axis === "z" && s.side < 0);
  assert.ok(site, "Expected a z-axis left sidewalk span approaching a cross-street");

  const egoX = site.edge + site.side * 0.96;
  const roadStartX = site.edge - site.side * 2.2;
  const egoZ = site.maxZ - 2.7;
  Object.assign(world.player, {
    x: roadStartX,
    z: egoZ,
    heading: 0,
    speed: 0,
    steer: 0,
  });
  world.player.previous = { ...world.player };

  world.command({
    type: "street-pursuit-start",
    variant: "gta",
    level: 5,
    config: {
      ruleset: "dispatch-v1",
      damageFeedback: DISPATCH_DAMAGE_FEEDBACK,
      wantedLevelMax: 5,
      maxActivePatrols: 4,
      episodeMaxSeconds: 35,
      ...(enableUnstickFixes
        ? {
            curbSupport: METRO_CITY_CURBS,
            chasePresence: AGGRESSIVE_CHASE_PRESENCE,
            patrolTrafficPreview: PATROL_TRAFFIC_PREVIEW,
            patrolChainYield: PATROL_LATERAL_YIELD,
          }
        : {}),
    },
  }, false);

  Object.assign(world.player, { x: egoX, z: egoZ, heading: 0, speed: 0, steer: 0 });
  if (enableUnstickFixes) acceptCurbPose(world.pursuit.gta.curb, world.roads, world.player);
  world.player.previous = { ...world.player };

  // Place an active police cruiser diagonally touching (~1 cm gap, non-penetrating) the rear-left corner of the SUV (matching screenshot)
  const cruiser = world.makeVehicle("rear-left-patrol", "sedan", {
    x: egoX - 1.98,
    z: egoZ - 3.35,
    heading: 0.58,
  });
  while (overlaps(world.player, cruiser)) {
    cruiser.x -= Math.sin(cruiser.heading) * 0.02;
    cruiser.z -= Math.cos(cruiser.heading) * 0.02;
  }
  initializeGtaPatrol(cruiser, "patrol", world.pursuit);
  cruiser.aiState = "PURSUIT";
  cruiser.squadRole = "PRIMARY_CHASER";
  cruiser.speed = 0.6;
  initializeDistrictActor(world, cruiser);
  cruiser.district.nextLoadingDistanceM = Infinity;
  world.pursuit.patrols.add(cruiser);
  world.pursuit.response.sightedBy.add(cruiser);
  world.actors.push(cruiser);
  world.actorIndex = new SpatialIndex(world.actors);
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
    ...(enableUnstickFixes ? { evasiveControl: PAKO_EVASIVE_CONTROL } : {}),
  };

  let maxWaitS = 0;
  for (let t = 0; t < 1080 && world.pursuit.phase === "running"; t++) {
    applyFrozenDispatchAction(world, world.pursuit.frozenDriver, null);
    world.step();
    maxWaitS = Math.max(maxWaitS, world.player.wait ?? 0);
    if (world.pursuit.metrics.distanceM >= 40) break;
  }

  return {
    escapedFreeze: world.pursuit.metrics.distanceM >= 25 && maxWaitS <= 3.5 && world.pursuit.metrics.pedestrianCollisions === 0,
    distanceM: Number(world.pursuit.metrics.distanceM.toFixed(2)),
    maxWaitS: Number(maxWaitS.toFixed(2)),
    finalCurbId: world.player.curbSupportId ?? null,
    pedestrianCollisions: world.pursuit.metrics.pedestrianCollisions,
  };
}

function runAlleyBetweenBuildingsTrial({ enableCourtyard, policy, sha256 }) {
  const world = new World({ cityVersion: 4, seed: "alley-between-buildings-01", traffic: 0, pedestrians: 0 }, "metro");
  const tahrir = world.drivingRoads.find(r => r.id === "tahrir-boulevard");
  const station = world.drivingRoads.find(r => r.id === "station-avenue");
  assert.ok(tahrir && station);

  // Start on tahrir-boulevard just before the real 8.5 m alley gap (x in [-244, -235.5]) between
  // tahrir-boulevard-frontage-1-0 and station-avenue-frontage--1-1, facing into the alley mouth
  Object.assign(world.player, {
    x: -242.5,
    z: -108.4,
    heading: 0.42,
    speed: 3.5,
    steer: 0,
  });
  world.player.previous = { ...world.player };

  world.command({
    type: "street-pursuit-start",
    variant: "gta",
    level: 3,
    config: {
      ruleset: "dispatch-v1",
      damageFeedback: DISPATCH_DAMAGE_FEEDBACK,
      wantedLevelMax: 3,
      maxActivePatrols: 0,
      episodeMaxSeconds: 40,
      ...(enableCourtyard
        ? {
            curbSupport: METRO_CITY_CURBS,
            chasePresence: AGGRESSIVE_CHASE_PRESENCE,
          }
        : {}),
    },
  }, false);

  // Full roadblock across tahrir-boulevard east & west of the alley mouth so the only open exit is through the alley between the houses
  world.statics.push(
    Object.freeze({
      id: "tahrir-east-wall",
      type: "static",
      kind: "barrier",
      x: -233.2,
      z: -112,
      width: 1.4,
      length: 18.8,
      height: 1.8,
      heading: 0,
    }),
    Object.freeze({
      id: "tahrir-west-wall",
      type: "static",
      kind: "barrier",
      x: -250.5,
      z: -112,
      width: 1.4,
      length: 18.8,
      height: 1.8,
      heading: 0,
    }),
  );
  world.staticIndex = new SpatialIndex(world.statics);
  world.actorIndex = new SpatialIndex(world.actors);
  world.pursuit.gta.publicRouteGoal = { ...districtRoadPose(station, -225, 1), roadId: "station-avenue", id: "station-goal" };
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
    ...(enableCourtyard ? { evasiveControl: PAKO_EVASIVE_CONTROL } : {}),
  };

  let enteredCourtyard = false;
  let reachedParallelStreet = false;
  for (let t = 0; t < 900 && world.pursuit.phase === "running"; t++) {
    applyFrozenDispatchAction(world, world.pursuit.frozenDriver, null);
    world.step();
    if (world.player.z > -101.5 && world.player.z < -84.5) enteredCourtyard = true;
    if (enteredCourtyard && pointOnRoad(world.player, [station])) {
      reachedParallelStreet = true;
      break;
    }
  }

  return {
    enteredCourtyard,
    reachedParallelStreet: reachedParallelStreet && world.pursuit.metrics.pedestrianCollisions === 0,
    finalX: Number(world.player.x.toFixed(2)),
    finalZ: Number(world.player.z.toFixed(2)),
    collisions: world.pursuit.metrics.collisions,
    pedestrianCollisions: world.pursuit.metrics.pedestrianCollisions,
  };
}

function runFrontHitFastKTurnTrial({ enableEvasion, policy, sha256 }) {
  const world = new World({ cityVersion: 4, seed: "tjunction-kturn-repro-01", traffic: 0, pedestrians: 0 }, "metro");
  // Place player at the bab-el-louk-link -> entry-local T-junction facing the building across entry-local,
  // with a front obstacle right off the nose and two trailing vehicles behind-left/right (matching screenshot)
  Object.assign(world.player, {
    x: -32.0,
    z: -41.2,
    heading: 0,
    speed: 0,
    steer: 0,
  });
  world.player.previous = { ...world.player };

  world.command({
    type: "street-pursuit-start",
    variant: "gta",
    level: 3,
    config: {
      ruleset: "dispatch-v1",
      damageFeedback: DISPATCH_DAMAGE_FEEDBACK,
      wantedLevelMax: 3,
      maxActivePatrols: 0,
      episodeMaxSeconds: 35,
      ...(enableEvasion
        ? {
            curbSupport: METRO_CITY_CURBS,
            chasePresence: AGGRESSIVE_CHASE_PRESENCE,
          }
        : {}),
    },
  }, false);

  // Front blocker 0.9 m ahead of front bumper so forward straight motion is blocked
  world.statics.push(Object.freeze({
    id: "tjunction-front-block",
    type: "static",
    kind: "barrier",
    x: -32.0,
    z: -37.6,
    width: 6.0,
    length: 1.2,
    height: 1.6,
    heading: 0,
  }));
  // Trailing stationary cruiser & sedan 6.5 m behind-left and behind-right leaving K-turn room
  for (const [id, dx, dz, h] of [
    ["trailing-left-cruiser", -2.2, -6.8, 0.2],
    ["trailing-right-sedan", 2.0, -7.2, -0.1],
  ]) {
    const car = world.makeVehicle(id, "sedan", { x: -32.0 + dx, z: -41.2 + dz, heading: h });
    initializeGtaPatrol(car, "patrol", world.pursuit);
    car.aiState = "ROADBLOCK";
    car.squadRole = "ROADBLOCK";
    car.speed = 0;
    initializeDistrictActor(world, car);
    car.district.nextLoadingDistanceM = Infinity;
    world.pursuit.patrols.add(car);
    world.actors.push(car);
  }
  world.staticIndex = new SpatialIndex(world.statics);
  world.actorIndex = new SpatialIndex(world.actors);
  const entry = world.drivingRoads.find(r => r.id === "entry-local");
  world.pursuit.gta.publicRouteGoal = { ...districtRoadPose(entry, -52, -1), roadId: "entry-local", id: "entry-west-goal" };
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
    ...(enableEvasion ? { evasiveControl: PAKO_EVASIVE_CONTROL } : {}),
  };

  let lastGear = 1;
  let gearFlips = 0;
  for (let t = 0; t < 480 && world.pursuit.phase === "running"; t++) {
    applyFrozenDispatchAction(world, world.pursuit.frozenDriver, null);
    const subGear = world.pursuit.frozenDriver.lastDecision?.submitted?.gear ?? 1;
    if (subGear !== lastGear) {
      gearFlips++;
      lastGear = subGear;
    }
    world.step();
    if (Math.hypot(world.player.x - (-32.0), world.player.z - (-41.2)) >= 16) break;
  }

  const netDispM = Math.hypot(world.player.x - (-32.0), world.player.z - (-41.2));
  return {
    escapedCleanly: netDispM >= 14 && gearFlips <= 4 && world.pursuit.metrics.pedestrianCollisions === 0,
    netDispM: Number(netDispM.toFixed(2)),
    distanceM: Number(world.pursuit.metrics.distanceM.toFixed(2)),
    gearFlips,
    pedestrianCollisions: world.pursuit.metrics.pedestrianCollisions,
  };
}

function runMultiSeedLevel5AntiStall({ policy, sha256 }) {
  const cases = [
    { label: "default-t0", cfg: { cityVersion: 4 }, warmup: 1 },
    { label: "default-t60", cfg: { cityVersion: 4 }, warmup: 60 },
    { label: "default-t120", cfg: { cityVersion: 4 }, warmup: 120 },
    { label: "default-t240", cfg: { cityVersion: 4 }, warmup: 240 },
    { label: "default-t360", cfg: { cityVersion: 4 }, warmup: 360 },
    { label: "seed-a", cfg: { cityVersion: 4, seed: "chase-probe-1" }, warmup: 90 },
    { label: "seed-b", cfg: { cityVersion: 4, seed: "chase-probe-2" }, warmup: 90 },
    { label: "seed-c", cfg: { cityVersion: 4, seed: "chase-probe-3" }, warmup: 90 },
    { label: "seed-d", cfg: { cityVersion: 4, seed: "chase-probe-4" }, warmup: 90 },
    { label: "seed-e", cfg: { cityVersion: 4, seed: "chase-probe-5" }, warmup: 90 },
    { label: "seed-f", cfg: { cityVersion: 4, seed: "chase-probe-6" }, warmup: 90 },
    { label: "seed-g", cfg: { cityVersion: 4, seed: "chase-probe-7" }, warmup: 90 },
  ];

  const rows = [];
  let stuckRuns = 0;
  let oscillatingRuns = 0;
  let pedestrianCollisions = 0;
  let totalCurbEntries = 0;

  for (const c of cases) {
    const world = new World(c.cfg, "metro");
    for (let i = 0; i < c.warmup; i++) world.step();
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

    let maxRunningWaitS = 0;
    let oscillated = false;
    let prevGear = 1;
    let totalGearFlips = 0;
    const windowSamples = [];
    for (let t = 0; t < 3600 && world.pursuit.phase === "running"; t++) {
      applyFrozenDispatchAction(world, world.pursuit.frozenDriver, null);
      const g = world.pursuit.frozenDriver.lastDecision?.submitted?.gear ?? 1;
      if (g !== prevGear) {
        totalGearFlips++;
        prevGear = g;
      }
      world.step();
      if (world.pursuit.phase === "running") {
        maxRunningWaitS = Math.max(maxRunningWaitS, world.player.wait ?? 0);
        if (t % 30 === 0) {
          windowSamples.push({
            x: world.player.x,
            z: world.player.z,
            dist: world.pursuit.metrics.distanceM,
            flips: totalGearFlips,
          });
          if (windowSamples.length > 13) {
            const old = windowSamples[windowSamples.length - 13]; // 6.0s window
            const cur = windowSamples[windowSamples.length - 1];
            const netM = Math.hypot(cur.x - old.x, cur.z - old.z);
            const pathM = cur.dist - old.dist;
            const flipsInWindow = cur.flips - old.flips;
            if (flipsInWindow >= 4 && pathM >= 2.2 && netM < 3.2) {
              oscillated = true;
            }
          }
        }
      }
    }
    const stuck = world.pursuit.phase === "running" && (world.player.wait ?? 0) > 6.5 || maxRunningWaitS > 6.5;
    if (stuck) stuckRuns++;
    if (oscillated) oscillatingRuns++;
    pedestrianCollisions += world.pursuit.metrics.pedestrianCollisions;
    totalCurbEntries += world.pursuit.metrics.shoulderEntries;
    const endedPhase = world.pursuit.phase;
    const finalSurvivalS = Number(world.pursuit.metrics.survivalS.toFixed(1));
    const finalDistanceM = Number(world.pursuit.metrics.distanceM.toFixed(1));
    const finalCurbEntries = world.pursuit.metrics.shoulderEntries;
    const finalPedCollisions = world.pursuit.metrics.pedestrianCollisions;

    // Verify post-chase or "End chase" curb snap-back leaves player strictly on-road, overlap-free, and ready for "Run again"
    if (world.pursuit.phase === "running") {
      world.command({ type: "street-pursuit-stop" }, false);
    }
    const postAudit = world.audit().filter(issue => issue.includes("player"));
    assert.equal(bodyOnRoad(world.player, world.roads), true, `${c.label}: player stranded off-road after chase end`);
    assert.deepEqual(postAudit, [], `${c.label}: player audit failed after chase end: ${JSON.stringify(postAudit)}`);
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
    assert.equal(world.pursuit.phase, "running", `${c.label}: Run again failed to start`);
    world.command({ type: "street-pursuit-stop" }, false);

    rows.push({
      case: c.label,
      phase: endedPhase,
      survivalS: finalSurvivalS,
      distanceM: finalDistanceM,
      maxRunningWaitS: Number(maxRunningWaitS.toFixed(2)),
      curbEntries: finalCurbEntries,
      pedestrianCollisions: finalPedCollisions,
      postChaseAuditClean: postAudit.length === 0,
      runAgainReady: true,
      oscillated,
      stuck,
    });
  }

  const sortedDist = rows.map(r => r.distanceM).sort((a, b) => a - b);
  const mid = Math.floor(sortedDist.length / 2);
  const medianDistanceM = Number(((sortedDist[mid - 1] + sortedDist[mid]) / 2).toFixed(2));
  return {
    totalRuns: rows.length,
    stuckRuns,
    oscillatingRuns,
    medianDistanceM,
    totalCurbEntries,
    pedestrianCollisions,
    rows,
  };
}

const { json: checkpointJson, policy: trainedPolicy, sha256 } = loadBundledCheckpoint();
const untrainedModel = new PursuitPpo("untrained-baseline-check", null, CLEARANCE_ROUTE_OBSERVATION_SCHEMA.version);

if (negativeFaultMode) {
  const legacyPolice = measureOpeningPolice(5, false);
  const curbDisabled = runBlockedAvenueCurbTrial({
    enableCurb: false,
    enableEvasion: false,
    policyAction: obs => untrainedModel.action(obs),
  });
  const stallBlocked = runNoseBlockedReverseTrial({
    enableEvasion: false,
    policyAction: () => ({ steer: 0, throttle: 0.8, brake: 0, gear: 1 }),
  });
  const intersectionFrozen = runCurbIntersectionContactTrial({
    enableUnstickFixes: false,
    policy: trainedPolicy,
    sha256,
  });
  const alleyBlocked = runAlleyBetweenBuildingsTrial({
    enableCourtyard: false,
    policy: trainedPolicy,
    sha256,
  });
  const detectedDistantPoliceFailure = legacyPolice.nearestM > 34;
  const detectedCurbBlockedFailure = !curbDisabled.passedShutter && curbDisabled.shoulderEntries === 0;
  const detectedStallFailure = !stallBlocked.reversed && stallBlocked.distanceM < 6;
  const detectedIntersectionCurbFreeze = !intersectionFrozen.escapedFreeze;
  const detectedAlleyBlockedFailure = !alleyBlocked.reachedParallelStreet;
  const passed = !(
    detectedDistantPoliceFailure &&
    detectedCurbBlockedFailure &&
    detectedStallFailure &&
    detectedIntersectionCurbFreeze &&
    detectedAlleyBlockedFailure
  );
  const report = {
    passed,
    detectedAlleyBlockedFailure,
    detectedIntersectionCurbFreeze,
    detectedCurbBlockedFailure,
    detectedStallFailure,
    detectedDistantPoliceFailure,
    alleyBlocked,
    intersectionFrozen,
    legacyPolice,
    curbDisabled,
    stallBlocked,
  };
  writeFileSync(join(outDir, "negative-fault.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report));
  process.exit(passed ? 0 : 1);
}

const surveyWorld = new World({ cityVersion: 4, seed: "curb-survey-audit" }, "metro");
const curbNetwork = surveyMetroCurb(surveyWorld, METRO_CITY_CURBS);
assert.ok(curbNetwork?.sites?.length >= 12, "Expected city-wide Metro curb ribbons on multiple streets");

const policeLvl3 = measureOpeningPolice(3, true);
const policeLvl5 = measureOpeningPolice(5, true);

const curbEnabled = runBlockedAvenueCurbTrial({
  enableCurb: true,
  enableEvasion: true,
  policyAction: trainedPolicy.action,
});
const curbDisabled = runBlockedAvenueCurbTrial({
  enableCurb: false,
  enableEvasion: false,
  policyAction: trainedPolicy.action,
});
const curbPedestrianNegative = runBlockedAvenueCurbTrial({
  enableCurb: true,
  enableEvasion: true,
  addSidewalkPedestrian: true,
  policyAction: trainedPolicy.action,
});
const reverseRecovery = runNoseBlockedReverseTrial({
  enableEvasion: true,
  policyAction: trainedPolicy.action,
});
const curbIntersectionContactRepro = runCurbIntersectionContactTrial({
  enableUnstickFixes: true,
  policy: trainedPolicy,
  sha256,
});
const alleyShortcutTrial = runAlleyBetweenBuildingsTrial({
  enableCourtyard: true,
  policy: trainedPolicy,
  sha256,
});
const frontHitFastKTurn = runFrontHitFastKTurnTrial({
  enableEvasion: true,
  policy: trainedPolicy,
  sha256,
});
const multiSeedAntiStall = runMultiSeedLevel5AntiStall({
  policy: trainedPolicy,
  sha256,
});

const unseenSeeds = ["chase-test-01", "chase-test-02", "chase-test-03", "chase-test-04"];
const evalStages = [
  { id: "chase-level-1", level: 1, traffic: 36, pedestrians: 80, patrols: 3 },
  { id: "chase-level-3", level: 3, traffic: 36, pedestrians: 80, patrols: 7 },
  { id: "chase-level-5", level: 5, traffic: 96, pedestrians: 144, patrols: 12 },
];

let trainedEscapes = 0, trainedCleanEscapes = 0, untrainedUnassistedEscapes = 0;
let trainedUnassistedDistanceM = 0, untrainedUnassistedDistanceM = 0;
let totalPedestrianHits =
  curbEnabled.pedestrianCollisions +
  curbPedestrianNegative.pedestrianCollisions +
  reverseRecovery.pedestrianCollisions +
  curbIntersectionContactRepro.pedestrianCollisions +
  alleyShortcutTrial.pedestrianCollisions +
  frontHitFastKTurn.pedestrianCollisions +
  multiSeedAntiStall.pedestrianCollisions;
let totalCurbEntriesInCity = 0;
const episodeRows = [];

for (const cfg of evalStages) {
  const stageAssisted = {
    id: cfg.id,
    observation: CLEARANCE_ROUTE_OBSERVATION_SCHEMA.version,
    traffic: cfg.traffic,
    pedestrians: cfg.pedestrians,
    episodeSeconds: 95,
    wantedLevel: cfg.level,
    wantedLevelMax: cfg.level,
    patrols: cfg.patrols,
    rewardProfile: CLEAN_ESCAPE_REWARD,
    curbSupport: METRO_CITY_CURBS,
    chasePresence: AGGRESSIVE_CHASE_PRESENCE,
    evasiveControl: PAKO_EVASIVE_CONTROL,
    patrolTrafficPreview: PATROL_TRAFFIC_PREVIEW,
    patrolChainYield: PATROL_LATERAL_YIELD,
  };
  const stageUnassisted = {
    ...stageAssisted,
    curbSupport: undefined,
    evasiveControl: undefined,
  };

  for (const [seedIdx, seed] of unseenSeeds.slice(0, 2).entries()) {
    let shoulderEntries = 0;
    const trainedRun = runPursuitEpisode(stageAssisted, seed, trainedPolicy.action, false, null, world => {
      shoulderEntries = Math.max(shoulderEntries, world.pursuit.metrics.shoulderEntries);
    });
    let pureTrainedM = null, pureUntrainedM = null;
    if (seedIdx === 0 && cfg.level <= 3) {
      const quickPure = { ...stageUnassisted, episodeSeconds: 45 };
      const trainedPure = runPursuitEpisode(quickPure, seed, trainedPolicy.action, false);
      const untrainedPure = runPursuitEpisode(quickPure, seed, obs => untrainedModel.action(obs), false);
      pureTrainedM = trainedPure.metrics.distanceM;
      pureUntrainedM = untrainedPure.metrics.distanceM;
      if (untrainedPure.metrics.phase === "escaped" && untrainedPure.metrics.pursuitQualified) {
        untrainedUnassistedEscapes++;
      }
      trainedUnassistedDistanceM += pureTrainedM;
      untrainedUnassistedDistanceM += pureUntrainedM;
    }

    if (trainedRun.metrics.phase === "escaped" && trainedRun.metrics.pursuitQualified) {
      trainedEscapes++;
      if (trainedRun.metrics.collisions === 0) trainedCleanEscapes++;
    }
    totalPedestrianHits += trainedRun.metrics.pedestrianImpacts;
    totalCurbEntriesInCity += shoulderEntries;

    episodeRows.push({
      stage: cfg.id,
      seed,
      trained: {
        phase: trainedRun.metrics.phase,
        ticks: trainedRun.metrics.ticks,
        distanceM: trainedRun.metrics.distanceM,
        collisions: trainedRun.metrics.collisions,
        pedestrianImpacts: trainedRun.metrics.pedestrianImpacts,
        shoulderEntries,
      },
      trainedPureNetworkDistanceM: pureTrainedM,
      untrainedPureNetworkDistanceM: pureUntrainedM,
    });
  }
}

const passed =
  policeLvl3.nearestM <= 34 &&
  policeLvl5.nearestM <= 34 &&
  policeLvl5.within36M >= 2 &&
  curbEnabled.passedShutter &&
  curbEnabled.shoulderEntries >= 1 &&
  !curbDisabled.passedShutter &&
  curbPedestrianNegative.pedestrianCollisions === 0 &&
  reverseRecovery.reversed &&
  reverseRecovery.passedCruiser &&
  reverseRecovery.distanceM >= 15 &&
  curbIntersectionContactRepro.escapedFreeze &&
  alleyShortcutTrial.reachedParallelStreet &&
  frontHitFastKTurn.escapedCleanly &&
  multiSeedAntiStall.stuckRuns === 0 &&
  multiSeedAntiStall.oscillatingRuns === 0 &&
  multiSeedAntiStall.medianDistanceM > 80 &&
  totalPedestrianHits === 0 &&
  trainedEscapes > untrainedUnassistedEscapes &&
  trainedUnassistedDistanceM > untrainedUnassistedDistanceM;

const summary = {
  passed,
  checkpoint: {
    sha256,
    updates: checkpointJson.updates,
    transitions: checkpointJson.transitions,
    optimizerSteps: checkpointJson.optimizerSteps,
    demonstrations: checkpointJson.demonstrations ?? 0,
    ppoClipEpsilon: 0.2,
  },
  curbSurveyCount: curbNetwork.sites.length,
  courtyardZoneCount: curbNetwork.courtyards?.length ?? 0,
  policePresence: { level3: policeLvl3, level5: policeLvl5 },
  curbBypass: {
    curbEnabledEscaped: curbEnabled.passedShutter && curbEnabled.shoulderEntries >= 1,
    curbDisabledEscaped: curbDisabled.passedShutter,
    curbEnabled,
    curbDisabled,
  },
  curbPedestrianNegative,
  reverseRecovery,
  curbIntersectionContactRepro,
  alleyShortcutTrial,
  frontHitFastKTurn,
  multiSeedAntiStall,
  pedestrianHits: totalPedestrianHits,
  cityEval: {
    trainedEscapes,
    trainedCleanEscapes,
    untrainedUnassistedEscapes,
    trainedUnassistedDistanceM,
    untrainedUnassistedDistanceM,
    totalCurbEntriesInCity,
    episodes: episodeRows,
  },
};

writeFileSync(join(outDir, "rl-curb-chase-eval.json"), JSON.stringify(summary, null, 2) + "\n");
console.log(JSON.stringify({
  passed,
  trainedEscapes,
  trainedCleanEscapes,
  pedestrianHits: totalPedestrianHits,
  curbSurveyCount: curbNetwork.sites.length,
  policeLvl5NearestM: policeLvl5.nearestM,
}));
assert.ok(passed, "RL curb chase evaluation failed one or more acceptance criteria");
