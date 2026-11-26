import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { STEP } from "../src/core/config.js";
import { initializeDistrictActor } from "../src/core/district-behavior.js";
import { districtRoadPose } from "../src/core/egypt-district.js";
import { overlaps, roadPoseAt } from "../src/core/geometry.js";
import { AGGRESSIVE_CHASE_PRESENCE } from "../src/core/pako-aggressive-police.js";
import { METRO_CITY_CURBS, surveyMetroCurb } from "../src/core/pako-curb.js";
import { validatePursuitAction } from "../src/core/pursuit-controls.js";
import { initializeGtaPatrol } from "../src/core/pursuit-gta.js";
import { SpatialIndex } from "../src/core/spatial-index.js";
import { World } from "../src/core/world.js";
import {
  CLEAN_ESCAPE_REWARD,
  CLEARANCE_ROUTE_OBSERVATION_SCHEMA,
  GtaPursuitEnv,
  SMOOTH_SMART_ESCAPE_REWARD,
  getDispatchObservation,
} from "../src/rl/gta-pursuit-env.js";
import {
  LOCAL_NITRO_SPEC,
  PAKO_EVASIVE_CONTROL,
  evaluateNitroSafetyAndOpportunity,
  planPakoEvasiveAction,
} from "../src/rl/pako-evasive-control.js";
import { applyFrozenDispatchAction } from "../src/rl/pursuit-controller.js";
import { freezePursuitPolicy } from "../src/rl/pursuit-ppo.js";
import { guardDispatchAction, selectDispatchMovement } from "../src/rl/pursuit-shield.js";
import {
  PURSUIT_SCAN_RAYS,
  PURSUIT_SCAN_RANGE_M,
  PURSUIT_SCAN_TICKS,
  PursuitScanner,
} from "../src/signal_processing/pursuit-scanner.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");

function supportsFiveKeyAction() {
  try {
    validatePursuitAction({ steer: 0, throttle: 1, brake: 0, gear: 1, nitro: 1 });
    return true;
  } catch {
    return false;
  }
}

function makeFrozenScan({ tick = 0, rayOverrides = [], tracks = [] } = {}) {
  const rays = Array.from({ length: PURSUIT_SCAN_RAYS }, (_, i) => {
    const ov = rayOverrides.find((r) => r.index === i);
    return Object.freeze({
      kind: ov?.kind ?? "none",
      rangeM: ov?.rangeM ?? PURSUIT_SCAN_RANGE_M,
    });
  });
  const frozenTracks = tracks.map((tr) =>
    Object.freeze({
      kind: tr.kind ?? "civilian",
      rightM: tr.rightM ?? 0,
      forwardM: tr.forwardM ?? 20,
      rightMps: tr.rightMps ?? 0,
      forwardMps: tr.forwardMps ?? 0,
      ageS: tr.ageS ?? 0,
      motionKnown: Boolean(tr.motionKnown),
      ttcS: tr.ttcS ?? null,
    }),
  );
  return Object.freeze({
    tick,
    rays: Object.freeze(rays),
    tracks: Object.freeze(frozenTracks),
  });
}

function makeMockSensorOnlyWorld({
  speed = 13.5,
  nitroCharge = 0.85,
  nitroActive = false,
  scan = makeFrozenScan(),
  visualState = null,
  pursuitStatus = { stars: 2, unitsInContact: 1 },
  maxActivePatrols = 6,
} = {}) {
  const boulevard = Object.freeze({
    id: "mock-straight-avenue",
    axis: "z",
    fixed: 0,
    min: -120,
    max: 220,
    width: 14,
    laneOffsetM: 3.0,
    speedLimitMps: 20,
    flow: 0,
  });
  const player = {
    id: "ego-suv",
    type: "vehicle",
    x: 0,
    z: 0,
    heading: 0,
    speed,
    maxSpeed: 28,
    steer: 0,
    width: 1.85,
    length: 4.2,
    health: 100,
    maxHealth: 100,
    gtaSlipMps: 0,
    gtaYawRate: 0,
    nitroCharge,
    nitroActive,
    nitroSuppressedByPedestrian: false,
    spec: {
      wheelbase: 2.6,
      maxSteer: 0.62,
      steerRate: 2.2,
      acceleration: 6.4,
      braking: 11.5,
      reverseSpeed: 6.0,
    },
  };
  const commands = [];
  const mockWorld = {
    tick: scan.tick,
    player,
    roads: [boulevard],
    drivingRoads: [boulevard],
    statics: [],
    visualState,
    sensors: { imu: { yawRateRadS: 0 } },
    pursuit: {
      phase: "running",
      wantedLevel: pursuitStatus?.stars ?? 1,
      status: pursuitStatus,
      gta: {
        config: { ruleset: "dispatch-v1", maxActivePatrols },
        scan,
        curb: null,
      },
      get patrols() {
        throw new Error("Forbidden access to pursuit.patrols");
      },
      get police() {
        throw new Error("Forbidden access to pursuit.police");
      },
      get response() {
        throw new Error("Forbidden access to pursuit.response");
      },
    },
    get actorIndex() {
      throw new Error("Forbidden access to world.actorIndex");
    },
    command(cmd) {
      commands.push(cmd);
      return true;
    },
    commands,
  };
  // Explicitly freeze/trap world.actors so any ground-truth read immediately throws.
  Object.defineProperty(mockWorld, "actors", {
    configurable: false,
    enumerable: true,
    get() {
      throw new Error("Forbidden ground-truth access to world.actors");
    },
  });
  return mockWorld;
}

function worldOffset(pose, forward, right = 0) {
  const s = Math.sin(pose.heading);
  const c = Math.cos(pose.heading);
  return {
    x: pose.x + s * forward + c * right,
    z: pose.z + c * forward - s * right,
  };
}

test("1. Strict sensor-only compliance: source audit & missing/trapped world.actors execution across planner, shield, and controller", () => {
  const rlFiles = [
    "src/rl/pako-evasive-control.js",
    "src/rl/pursuit-shield.js",
    "src/rl/pursuit-controller.js",
  ];
  for (const rel of rlFiles) {
    const src = fs.readFileSync(path.resolve(ROOT_DIR, rel), "utf8");
    for (const forbidden of [
      "world.actors",
      ".actorIndex",
      ".patrols",
      ".police",
      ".response",
      "lastSeen",
      "maxActivePatrols",
      "wantedLevel",
      "unitsInContact",
    ]) {
      assert.equal(
        src.includes(forbidden),
        false,
        `Forbidden private ground-truth token "${forbidden}" found in ${rel}`,
      );
    }
  }

  // Run with world.actors getter throwing AND on a minimal clone where "actors" property is completely absent
  const scanWithRearPolice = makeFrozenScan({
    tick: 12,
    rayOverrides: [{ index: 36, kind: "police", rangeM: 19.5 }],
    tracks: [
      {
        kind: "police",
        rightM: 0,
        forwardM: -19.5,
        rightMps: 0,
        forwardMps: 3.5,
        ageS: 0,
        motionKnown: true,
        ttcS: null,
      },
    ],
  });
  const trappedWorld = makeMockSensorOnlyWorld({ scan: scanWithRearPolice });
  const requested = { steer: 0, throttle: 0.9, brake: 0, gear: 1 };

  const planned = planPakoEvasiveAction(trappedWorld, requested);
  assert.equal(planned.action.gear, 1);
  assert.equal(planned.action.nitro, 1);

  const selected = selectDispatchMovement(trappedWorld, requested, planPakoEvasiveAction);
  assert.equal(selected.reason, null);
  assert.equal(selected.action.nitro, 1);

  const driver = {
    status: "active",
    lastTick: -1,
    decisions: 0,
    sha256: "sensor-only-test",
    evasiveControl: PAKO_EVASIVE_CONTROL,
    policy: {
      observation: "dispatch-scan-v3",
      action: (obs) => {
        assert.ok(obs instanceof Float32Array && obs.every(Number.isFinite));
        return requested;
      },
    },
  };
  applyFrozenDispatchAction(trappedWorld, driver);
  assert.equal(driver.decisions, 1);
  assert.equal(driver.lastDecision.submitted.nitro, 1);
  assert.equal(trappedWorld.player.nitroSuppressedByPedestrian, false);

  // Runtime pursuit roadblocks/closures in world.statics must NEVER have their coordinates read!
  const trappedRoadblock = new Proxy(
    { id: "street-pursuit-1-roadblock", kind: "roadblock", gtaRoadblock: true, type: "static" },
    {
      get(target, prop) {
        if (prop === "x" || prop === "z" || prop === "width" || prop === "length") {
          throw new Error(`Forbidden runtime roadblock ground-truth read: .${String(prop)}`);
        }
        return target[prop];
      },
    },
  );
  trappedWorld.statics.push(trappedRoadblock);
  trappedWorld.pursuit.closures = new Set([trappedRoadblock]);
  const plannedWithRoadblock = planPakoEvasiveAction(trappedWorld, requested);
  assert.equal(plannedWithRoadblock.action.gear, 1);

  // Also test an object with no "actors" property at all and frozen player
  const actorlessWorld = {
    tick: 12,
    player: Object.freeze({ ...trappedWorld.player }),
    roads: trappedWorld.roads,
    drivingRoads: trappedWorld.drivingRoads,
    statics: [],
    visualState: null,
    pursuit: {
      phase: "running",
      wantedLevel: 2,
      status: { stars: 2, unitsInContact: 1 },
      gta: { config: { ruleset: "dispatch-v1", maxActivePatrols: 4 }, scan: scanWithRearPolice, curb: null },
    },
  };
  assert.equal("actors" in actorlessWorld, false);
  const actorlessDec = planPakoEvasiveAction(actorlessWorld, requested);
  assert.equal(actorlessDec.action.nitro, 1);

  // Trapped pursuit.gta.config.maxActivePatrols, pursuit.status, and pursuit.wantedLevel test:
  // With empty sensor observations and trapped config/status getters, planner must NOT throw and must NOT engage Nitro!
  const emptyScan = makeFrozenScan({ tick: 18 });
  const trappedConfigWorld = makeMockSensorOnlyWorld({ scan: emptyScan });
  Object.defineProperty(trappedConfigWorld.pursuit, "status", {
    get() {
      throw new Error("Forbidden access to pursuit.status");
    },
  });
  Object.defineProperty(trappedConfigWorld.pursuit, "wantedLevel", {
    get() {
      throw new Error("Forbidden access to pursuit.wantedLevel");
    },
  });
  Object.defineProperty(trappedConfigWorld.pursuit.gta.config, "maxActivePatrols", {
    get() {
      throw new Error("Forbidden access to pursuit.gta.config.maxActivePatrols");
    },
  });
  const trappedEmptyDec = planPakoEvasiveAction(trappedConfigWorld, requested);
  assert.equal(Boolean(trappedEmptyDec.action.nitro), false, "Empty sensor scan must not engage Nitro regardless of config");

  // And with police present in scan + trapped config/status/wantedLevel, Nitro MUST engage purely from sensor scan!
  trappedConfigWorld.pursuit.gta.scan = scanWithRearPolice;
  trappedConfigWorld.tick = scanWithRearPolice.tick;
  const trappedPoliceScanDec = planPakoEvasiveAction(trappedConfigWorld, requested);
  assert.equal(trappedPoliceScanDec.action.nitro, 1);
});

test("2. Nitro engages (nitro === 1) on >= 35 m clear straightaway under pursuit pressure and preserves 4-key shape when off", () => {
  assert.equal(LOCAL_NITRO_SPEC.speedMultiplier, 1.34);
  assert.equal(LOCAL_NITRO_SPEC.accelMultiplier, 1.72);
  assert.equal(LOCAL_NITRO_SPEC.maxBoostSpeedMps, 38.5);
  assert.equal(LOCAL_NITRO_SPEC.minEngageCharge, 0.18);

  const fiveKeySupported = supportsFiveKeyAction();
  const clearPursuitScan = makeFrozenScan({
    tick: 6,
    rayOverrides: [
      { index: 0, kind: "static", rangeM: 39.0 },
      { index: 36, kind: "police", rangeM: 22.0 },
    ],
    tracks: [
      {
        kind: "police",
        rightM: -1.2,
        forwardM: -22.0,
        rightMps: 0,
        forwardMps: 4.0,
        ageS: 0,
        motionKnown: true,
        ttcS: null,
      },
    ],
  });

  // Engage when clear >= 35 m ahead, under pursuit pressure, and nitroCharge >= 0.25
  const boostWorld = makeMockSensorOnlyWorld({
    speed: 14.0,
    nitroCharge: 0.25,
    scan: clearPursuitScan,
  });
  const straightReq = { steer: 0.04, throttle: 0.88, brake: 0, gear: 1 };
  const boostDecision = planPakoEvasiveAction(boostWorld, straightReq);
  assert.equal(boostDecision.action.nitro, 1);
  assert.deepEqual(Object.keys(boostDecision.action).sort(), ["brake", "gear", "nitro", "steer", "throttle"]);
  assert.equal(boostDecision.nitroSuppressedByPedestrian, false);
  assert.equal(boostWorld.player.nitroSuppressedByPedestrian, false);
  if (fiveKeySupported) {
    assert.doesNotThrow(() => validatePursuitAction(boostDecision.action));
  }

  // Low tank (nitroCharge < 0.18 when not already active) returns exact 4-key action
  const lowTankWorld = makeMockSensorOnlyWorld({
    speed: 14.0,
    nitroCharge: 0.12,
    nitroActive: false,
    scan: clearPursuitScan,
  });
  const lowTankDec = planPakoEvasiveAction(lowTankWorld, straightReq);
  assert.equal("nitro" in lowTankDec.action, false);
  assert.deepEqual(Object.keys(lowTankDec.action).sort(), ["brake", "gear", "steer", "throttle"]);
  validatePursuitAction(lowTankDec.action);

  // Blocked at 24 m (< 30 m threshold) returns exact 4-key action without nitro
  const shortCorridorScan = makeFrozenScan({
    tick: 6,
    rayOverrides: [
      { index: 0, kind: "civilian", rangeM: 24.0 },
      { index: 36, kind: "police", rangeM: 22.0 },
    ],
  });
  const shortCorridorWorld = makeMockSensorOnlyWorld({
    speed: 14.0,
    nitroCharge: 0.9,
    scan: shortCorridorScan,
  });
  const shortCorridorDec = planPakoEvasiveAction(shortCorridorWorld, straightReq);
  assert.equal("nitro" in shortCorridorDec.action, false);

  // Shield graceful Nitro shutoff: obstacle inside boosted reach but clear of unboosted reach strips nitro before slamming brake
  const midObstacleScan = makeFrozenScan({
    tick: 6,
    rayOverrides: [{ index: 0, kind: "static", rangeM: 18.8 }],
  });
  const shieldWorld = makeMockSensorOnlyWorld({
    speed: 15.2,
    nitroCharge: 1.0,
    scan: midObstacleScan,
  });
  const guardedGraceful = guardDispatchAction(shieldWorld, {
    steer: 0,
    throttle: 1,
    brake: 0,
    gear: 1,
    nitro: 1,
  });
  assert.equal(guardedGraceful.reason, null);
  assert.equal(guardedGraceful.action.brake, 0, "shield should shut off nitro smoothly before slamming full brake");
  assert.equal("nitro" in guardedGraceful.action, false);
});

test("3. Hard Pedestrian Zero-Nitro Safety Gate: instant PED HOLD on scan.rays (28 m), scan.tracks (34 m), and visualState (30 m) + 20-pedestrian cluster weave", () => {
  const straightReq = { steer: 0, throttle: 0.92, brake: 0, gear: 1 };

  // Case A: Pedestrian in scan.rays at 28 m ahead
  {
    const pedRayScan = makeFrozenScan({
      tick: 18,
      rayOverrides: [
        { index: 0, kind: "pedestrian", rangeM: 28.0 },
        { index: 36, kind: "police", rangeM: 20.0 },
      ],
    });
    const w = makeMockSensorOnlyWorld({ speed: 12.5, nitroCharge: 1.0, scan: pedRayScan });
    const dec = planPakoEvasiveAction(w, straightReq);
    assert.equal(Boolean(dec.action.nitro), false);
    assert.equal("nitro" in dec.action, false);
    assert.equal(dec.nitroSuppressedByPedestrian, true);
    assert.equal(w.player.nitroSuppressedByPedestrian, true);

    const shieldCheck = guardDispatchAction(w, { ...straightReq, nitro: 1 });
    assert.equal("nitro" in shieldCheck.action, false);
  }

  // Case B: Pedestrian in scan.tracks at 34 m ahead
  {
    const pedTrackScan = makeFrozenScan({
      tick: 24,
      rayOverrides: [{ index: 36, kind: "police", rangeM: 18.0 }],
      tracks: [
        {
          kind: "pedestrian",
          rightM: 1.8,
          forwardM: 34.0,
          rightMps: -0.9,
          forwardMps: -12.5,
          ageS: 0,
          motionKnown: true,
          ttcS: 2.7,
        },
      ],
    });
    const w = makeMockSensorOnlyWorld({ speed: 12.5, nitroCharge: 1.0, scan: pedTrackScan });
    const dec = planPakoEvasiveAction(w, straightReq);
    assert.equal(Boolean(dec.action.nitro), false);
    assert.equal("nitro" in dec.action, false);
    assert.equal(dec.nitroSuppressedByPedestrian, true);
    assert.equal(w.player.nitroSuppressedByPedestrian, true);
  }

  // Case C: Pedestrian in world.visualState at 30 m ahead (with completely clear LiDAR scan!)
  {
    const clearLidarWithRearCop = makeFrozenScan({
      tick: 30,
      rayOverrides: [{ index: 36, kind: "police", rangeM: 17.0 }],
    });
    const visualState = {
      source: "visual-prediction",
      available: true,
      status: "ready",
      frameId: 12,
      ageMs: 90,
      forecasts: [
        {
          label: "person",
          qualified: true,
          lateralM: -1.1,
          longitudinalM: 30.0,
          lateralSpeedMps: 0.4,
          forwardSpeedMps: 0,
        },
      ],
    };
    const w = makeMockSensorOnlyWorld({
      speed: 12.5,
      nitroCharge: 1.0,
      scan: clearLidarWithRearCop,
      visualState,
    });
    const driver = {
      status: "active",
      lastTick: -1,
      decisions: 0,
      sha256: "ped-hold-visual-test",
      evasiveControl: PAKO_EVASIVE_CONTROL,
      policy: { observation: "dispatch-scan-v3", action: () => straightReq },
    };
    applyFrozenDispatchAction(w, driver);
    assert.equal(Boolean(driver.lastDecision.submitted.nitro), false);
    assert.equal("nitro" in driver.lastDecision.submitted, false);
    assert.equal(driver.lastDecision.planner?.nitroSuppressedByPedestrian, true);
    assert.equal(w.player.nitroSuppressedByPedestrian, true);
  }

  // Case D: 20 walking pedestrians 22..42 m ahead on a live Metro street under police pursuit -> 0 hits & zero Nitro near pedestrians
  {
    const world = new World({ cityVersion: 4, seed: "twenty-peds-ahead", traffic: 0, pedestrians: 20 }, "metro");
    const curb = surveyMetroCurb(world, METRO_CITY_CURBS);
    world.command({
      type: "street-pursuit-start",
      variant: "gta",
      config: {
        ruleset: "dispatch-v1",
        maxActivePatrols: 1,
        enableRoadblocks: false,
        curbSupport: METRO_CITY_CURBS,
      },
    });
    world.pursuit.gta.curb = curb;
    const avenue = world.drivingRoads.find((r) => r.id === "tahrir-boulevard");
    Object.assign(world.player, districtRoadPose(avenue, -240, 1), {
      speed: 13.5,
      steer: 0,
      nitroCharge: 1.0,
      nitroActive: false,
    });

    // Place a trailing police patrol 22 m behind so Nitro WOULD engage if pedestrians weren't ahead
    const patrol = [...world.pursuit.patrols][0];
    if (patrol) {
      Object.assign(patrol, {
        ...worldOffset(world.player, -22.0, 0),
        heading: world.player.heading,
        speed: 13.0,
      });
    }

    // Distribute all 20 walking pedestrians 22..42 m ahead across right-half and sidewalk/corridor
    const peds = world.actors.filter((a) => a.type === "pedestrian");
    assert.equal(peds.length, 20);
    peds.forEach((p, idx) => {
      const fwd = 22.0 + (idx / 19) * 20.0;
      const right = 0.6 + (idx % 5) * 0.95;
      const pos = worldOffset(world.player, fwd, right);
      Object.assign(p, {
        x: pos.x,
        z: pos.z,
        heading: world.player.heading + (idx % 2 === 0 ? 0 : Math.PI),
        speed: 1.15,
      });
    });
    world.actorIndex = new SpatialIndex(world.actors);

    const scanner = new PursuitScanner();
    world.pursuit.gta.scan = scanner.sample(world);
    const firstDec = planPakoEvasiveAction(world, straightReq);
    assert.equal(Boolean(firstDec.action.nitro), false, "Nitro must stay 0 facing 20 pedestrians 22..42 m ahead");
    assert.equal(firstDec.nitroSuppressedByPedestrian, true);

    let active = null;
    for (let tick = 0; tick < 180; tick++) {
      if (!active || world.tick % PURSUIT_SCAN_TICKS === 0) {
        world.pursuit.gta.scan = scanner.sample(world);
        const dec = planPakoEvasiveAction(world, straightReq);
        if (dec.nitroSuppressedByPedestrian) {
          assert.equal(Boolean(dec.action.nitro), false);
        }
        active = dec.action;
      }
      world.command({ type: "pursuit-drive", action: active }, false);
      world.step();
    }
    assert.equal(world.pursuit.metrics.pedestrianCollisions, 0, "Must achieve 0 pedestrian collisions across 20-pedestrian encounter");
  }
});

test("4. Steering smoothness (mean |dSteer| <= 0.22) and proactive early 28..36 m lane-shift & side-ram evasion with 0 collisions", () => {
  const world = new World({ cityVersion: 4, seed: "smooth-proactive-lane-shift", traffic: 0, pedestrians: 0 }, "metro");
  world.command({
    type: "street-pursuit-start",
    variant: "gta",
    config: { ruleset: "dispatch-v1", maxActivePatrols: 0, enableRoadblocks: false },
  });
  const scanner = new PursuitScanner();
  const avenue = world.drivingRoads.find((r) => r.id === "tahrir-boulevard");
  Object.assign(world.player, districtRoadPose(avenue, -250, 1), { speed: 12.5, steer: 0 });

  // Place slower/stopped civilian car 31 m ahead in ego's current lane while adjacent lane is wide open!
  const leadCar = world.makeVehicle("distant-lane-blocker", "sedan", {
    ...worldOffset(world.player, 31.0, 0),
    heading: world.player.heading,
  });
  initializeDistrictActor(world, leadCar);
  leadCar.speed = 0;
  leadCar.district.loadingUntilTick = 9999;
  leadCar.district.nextLoadingDistanceM = Infinity;
  world.actors.push(leadCar);
  world.actorIndex = new SpatialIndex(world.actors);

  // Sample two frames so freshTracks has motionKnown === true at 31 m ahead
  scanner.sample(world);
  world.tick += PURSUIT_SCAN_TICKS;
  world.pursuit.gta.scan = scanner.sample(world);

  const req = { steer: 0, throttle: 0.88, brake: 0, gear: 1 };
  const earlyDec = planPakoEvasiveAction(world, req);
  assert.equal(
    earlyDec.reason,
    "PREDICTIVE_EVADE_LANE",
    "Planner must initiate early lane-shift at 31 m instead of blind policy-direct",
  );
  assert.notEqual(earlyDec.action.steer, 0, "Expected non-zero smooth lane-shift steer at 31 m");
  assert.equal(earlyDec.action.brake, 0, "Early lane-shift at 31 m must not slam brakes");

  // Continue for 180 ticks (3.0 s) past the obstacle and measure steering smoothness + 0 collisions
  let active = earlyDec.action;
  let prevDecisionSteer = earlyDec.action.steer;
  let dSteerSum = 0;
  let decisionCount = 0;

  for (let i = 0; i < 180; i++) {
    if (i > 0 && world.tick % PURSUIT_SCAN_TICKS === 0) {
      world.pursuit.gta.scan = scanner.sample(world);
      const dec = planPakoEvasiveAction(world, req);
      dSteerSum += Math.abs(dec.action.steer - prevDecisionSteer);
      prevDecisionSteer = dec.action.steer;
      decisionCount++;
      active = dec.action;
    }
    world.command({ type: "pursuit-drive", action: active }, false);
    world.step();
    assert.equal(overlaps(world.player, leadCar), false, "Must never collide with scanned forward vehicle");
  }

  const meanAbsDSteer = dSteerSum / Math.max(1, decisionCount);
  assert.ok(
    meanAbsDSteer <= 0.22,
    `Expected smooth steering continuity (mean |dSteer| <= 0.22), got ${meanAbsDSteer.toFixed(4)}`,
  );
  assert.equal(world.pursuit.metrics.collisions, 0);

  // Also verify diagonal/lateral closing police side-ram threat triggers proactive lateral dodge away from cruiser
  const sideRamScan = makeFrozenScan({
    tick: 60,
    rayOverrides: [{ index: 12, kind: "police", rangeM: 7.2 }],
    tracks: [
      {
        kind: "police",
        rightM: 3.4,
        forwardM: 4.2,
        rightMps: -3.8,
        forwardMps: -2.2,
        ageS: 0,
        motionKnown: true,
        ttcS: 1.15,
      },
    ],
  });
  const sideRamWorld = makeMockSensorOnlyWorld({ speed: 12.0, scan: sideRamScan });
  const dodgeDec = planPakoEvasiveAction(sideRamWorld, req);
  assert.ok(dodgeDec.action.steer < 0, `Expected leftward dodge away from right-flank closing cruiser, got ${dodgeDec.action.steer}`);
});

test("5. Retrained pako-chase-ppo.json loads cleanly via freezePursuitPolicy and smooth-smart-escape-v3 reward profile works end-to-end", () => {
  const ckptPath = path.resolve(ROOT_DIR, "public/threejs/pako-chase-ppo.json");
  const rawBytes = fs.readFileSync(ckptPath);
  const sha256 = createHash("sha256").update(rawBytes).digest("hex");
  assert.match(sha256, /^[0-9a-f]{64}$/);

  const rawJson = JSON.parse(rawBytes.toString("utf8"));
  const policy = freezePursuitPolicy(rawJson);
  assert.equal(policy.algorithm, "metro-dispatch-ppo-v2");
  assert.equal(policy.observation, CLEARANCE_ROUTE_OBSERVATION_SCHEMA.version);
  assert.ok(policy.updates >= 2, `Expected retrained PPO updates >= 2, got ${policy.updates}`);

  const env = new GtaPursuitEnv();
  const { obs, info } = env.reset({
    seed: "smart-nitro-v3-env-check",
    cityVersion: 5,
    traffic: 24,
    pedestrians: 40,
    observation: CLEARANCE_ROUTE_OBSERVATION_SCHEMA.version,
    shield: true,
    evasiveControl: PAKO_EVASIVE_CONTROL,
    rewardProfile: SMOOTH_SMART_ESCAPE_REWARD,
    config: {
      ruleset: "dispatch-v1",
      wantedLevelStart: 2,
      wantedLevelMax: 3,
      maxActivePatrols: 4,
      episodeMaxSeconds: 20,
      curbSupport: METRO_CITY_CURBS,
      chasePresence: AGGRESSIVE_CHASE_PRESENCE,
    },
  });
  assert.equal(info.rewardProfile, SMOOTH_SMART_ESCAPE_REWARD);

  for (let stepIdx = 0; stepIdx < 12; stepIdx++) {
    const act = policy.action(obs);
    validatePursuitAction(act);
    assert.ok([act.steer, act.throttle, act.brake, act.gear].every(Number.isFinite));
    const stepRes = env.step(act, PURSUIT_SCAN_TICKS);
    assert.ok(Number.isFinite(stepRes.reward));
    assert.equal(stepRes.info.rewardProfile, SMOOTH_SMART_ESCAPE_REWARD);
    obs.set(stepRes.obs);
    if (stepRes.terminated || stepRes.truncated) break;
  }

  // Ensure legacy CLEAN_ESCAPE_REWARD remains intact
  const legacyEnv = new GtaPursuitEnv();
  const legacyReset = legacyEnv.reset({
    seed: "legacy-clean-escape-check",
    shield: true,
    rewardProfile: CLEAN_ESCAPE_REWARD,
    config: { ruleset: "dispatch-v1", maxActivePatrols: 2 },
  });
  assert.equal(legacyReset.info.rewardProfile, CLEAN_ESCAPE_REWARD);
});
