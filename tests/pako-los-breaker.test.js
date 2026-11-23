import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { STEP } from "../src/core/config.js";
import { angleDelta, makeDiagonalRoad, overlaps, roadPointAt, roadPoseAt } from "../src/core/geometry.js";
import { METRO_CITY_CURBS, surveyMetroCurb } from "../src/core/pako-curb.js";
import { validatePursuitAction } from "../src/core/pursuit-controls.js";
import { initializeGtaPatrol } from "../src/core/pursuit-gta.js";
import { SpatialIndex } from "../src/core/spatial-index.js";
import { World } from "../src/core/world.js";
import {
  choosePakoEvasiveAction,
  computeLosBreakBonus,
  detectClosingPursuersFromScan,
  planPakoEvasiveAction,
  segmentIntersectsOrientedBox,
} from "../src/rl/pako-evasive-control.js";
import { selectDispatchMovement } from "../src/rl/pursuit-shield.js";
import {
  PURSUIT_SCAN_RAYS,
  PURSUIT_SCAN_RANGE_M,
  PURSUIT_SCAN_TICKS,
  PursuitScanner,
} from "../src/signal_processing/pursuit-scanner.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EVASIVE_CONTROL_PATH = path.resolve(__dirname, "../src/rl/pako-evasive-control.js");
const STRAIGHT_GUIDE = Object.freeze({ steer: 0, throttle: 0.86, brake: 0, gear: 1 });

function boxToCircleGap(box, circle) {
  const dx = circle.x - box.x;
  const dz = circle.z - box.z;
  const c = Math.cos(box.heading ?? 0);
  const s = Math.sin(box.heading ?? 0);
  const localRight = Math.abs(dx * c - dz * s) - box.width / 2;
  const localForward = Math.abs(dx * s + dz * c) - box.length / 2;
  const boxDist =
    localRight <= 0 && localForward <= 0
      ? Math.max(localRight, localForward)
      : Math.hypot(Math.max(0, localRight), Math.max(0, localForward));
  return boxDist - (circle.radius ?? 0);
}

function makeSensorOnlyAuditedWorld(world) {
  const forbiddenTrap = (label) =>
    new Proxy(
      {},
      {
        get(_, prop) {
          throw new Error(`Forbidden private read on ${label}.${String(prop)}`);
        },
        has(_, prop) {
          throw new Error(`Forbidden private check on ${label}.${String(prop)}`);
        },
        ownKeys() {
          throw new Error(`Forbidden enumeration of ${label}`);
        },
      },
    );

  return {
    get tick() {
      return world.tick;
    },
    player: world.player,
    get roads() {
      return world.roads;
    },
    get drivingRoads() {
      return world.drivingRoads;
    },
    get statics() {
      return world.statics;
    },
    get district() {
      return world.district;
    },
    get visualState() {
      return world.visualState;
    },
    pursuit: {
      get phase() {
        return world.pursuit.phase;
      },
      get wantedLevel() {
        return world.pursuit.wantedLevel;
      },
      get gta() {
        return world.pursuit.gta;
      },
      get patrols() {
        throw new Error("Forbidden read of world.pursuit.patrols");
      },
      get police() {
        throw new Error("Forbidden read of world.pursuit.police");
      },
      get response() {
        throw new Error("Forbidden read of world.pursuit.response");
      },
    },
    actors: new Proxy(world.actors, {
      get(_, prop) {
        throw new Error(`Forbidden read of world.actors.${String(prop)}`);
      },
    }),
    get actorIndex() {
      return forbiddenTrap("world.actorIndex");
    },
  };
}

function createV5CornerLosWorld({
  seed = "v5-los-corner",
  withCrossStreet = true,
  withDiagonalStreet = false,
  pedestrians = 0,
} = {}) {
  const world = new World({ cityVersion: 5, seed, traffic: 0, pedestrians }, "metro");

  const mainBoulevard = {
    id: "v5-main-boulevard",
    axis: "z",
    fixed: 0,
    min: -120,
    max: 160,
    width: 12,
    laneOffsetM: 2.6,
    speedLimitMps: 14.0,
    flow: 0,
    zone: "avenue",
    marking: "center",
  };
  const eastCrossStreet = {
    id: "v5-east-cross",
    axis: "x",
    fixed: 0,
    min: -6,
    max: 140,
    width: 12,
    laneOffsetM: 2.6,
    speedLimitMps: 12.0,
    flow: 0,
    zone: "avenue",
    marking: "center",
  };
  const diagSlashStreet = makeDiagonalRoad({
    id: "v5-slash-escape",
    x1: 0,
    z1: 0,
    x2: 96,
    z2: 86,
    width: 12,
    laneOffsetM: 2.6,
    speedLimitMps: 12.5,
    zone: "avenue",
    marking: "center",
  });

  // Grand City v5 corner building shielding the +x cross-street / alley from a rear southbound-origin pursuer at z < 0.
  const seCornerBuilding = Object.freeze({
    id: "v5-se-corner-building",
    type: "static",
    kind: "building",
    x: 21.4,
    z: -21.4,
    width: 26.0,
    length: 26.0,
    height: 32.0,
    heading: 0,
  });
  // West wall building so only the +x building-shielded corner/alley is open.
  const westWallBuilding = Object.freeze({
    id: "v5-west-frontage-building",
    type: "static",
    kind: "building",
    x: -18.5,
    z: 0,
    width: 18.0,
    length: 140.0,
    height: 28.0,
    heading: 0,
  });
  const neCornerBuilding = Object.freeze({
    id: "v5-ne-corner-building",
    type: "static",
    kind: "building",
    x: 24.0,
    z: 24.0,
    width: 26.0,
    length: 24.0,
    height: 30.0,
    heading: 0,
  });

  const activeRoads = [mainBoulevard];
  if (withCrossStreet) activeRoads.push(eastCrossStreet);
  if (withDiagonalStreet) activeRoads.push(diagSlashStreet);
  world.drivingRoads = activeRoads;
  world.roads = [...world.drivingRoads];
  world.statics = withDiagonalStreet
    ? [seCornerBuilding, westWallBuilding]
    : [seCornerBuilding, westWallBuilding, neCornerBuilding];
  world.staticIndex = new SpatialIndex(world.statics);

  const startPose = roadPoseAt(mainBoulevard, -7.0, 1);
  Object.assign(world.player, startPose, {
    x: 2.6,
    z: -7.0,
    heading: 0,
    speed: 8.5,
    steer: 0,
    maxSpeed: 32.0,
  });

  world.district = {
    ...world.district,
    grand: true,
    playerStart: { ...startPose },
    pursuitExits: [{ id: "north-straight-exit", x: 2.6, z: 140, heading: 0, roadId: mainBoulevard.id }],
    drivingRoads: world.drivingRoads,
    roads: world.roads,
    statics: world.statics,
  };

  const baseCmd = {
    type: "street-pursuit-start",
    variant: "gta",
    config: {
      ruleset: "dispatch-v1",
      maxActivePatrols: 0,
      enableRoadblocks: false,
      curbSupport: METRO_CITY_CURBS,
    },
  };
  try {
    world.command(baseCmd);
  } catch {
    world.config = { ...world.config, cityVersion: 4 };
    world.command(baseCmd);
    world.config = { ...world.config, cityVersion: 5 };
  }

  const surveyed = surveyMetroCurb(world, METRO_CITY_CURBS);
  const courtyard = Object.freeze({
    id: "v5-alley-courtyard",
    minX: -8,
    maxX: 90,
    minZ: -40,
    maxZ: 60,
  });
  world.pursuit.gta.curb = Object.freeze({
    ...(surveyed ?? { mode: METRO_CITY_CURBS, sites: [] }),
    mode: METRO_CITY_CURBS,
    maxPace: 14.0,
    maxYawRate: 3.6,
    courtyards: Object.freeze([courtyard]),
  });

  // Straight road guide ahead on mainBoulevard when unpressured.
  world.pursuit.gta.publicRouteGoal = Object.freeze({
    x: 2.6,
    z: 120,
    heading: 0,
    roadId: mainBoulevard.id,
    id: "straight-north-goal",
  });

  return { world, seCornerBuilding, mainBoulevard, eastCrossStreet };
}

function attachRearClosingPolice(world, scanner, { forwardM = -18.0, rightM = 0, speed = 22.0 } = {}) {
  const s = Math.sin(world.player.heading);
  const c = Math.cos(world.player.heading);
  const chaser = world.makeVehicle("rear-closing-interceptor", "suv", {
    x: world.player.x + s * forwardM + c * rightM,
    z: world.player.z + c * forwardM - s * rightM,
    heading: world.player.heading,
  });
  initializeGtaPatrol(chaser, "interceptor", world.pursuit);
  chaser.speed = speed;
  world.pursuit.patrols.add(chaser);
  world.actors.push(chaser);

  // Sample two consecutive scan frames separated by PURSUIT_SCAN_TICKS so motionKnown & closingSpeed are measured by sensor!
  const prevX = chaser.x;
  const prevZ = chaser.z;
  const dt = PURSUIT_SCAN_TICKS * STEP;
  chaser.x = prevX - s * (speed - world.player.speed) * dt;
  chaser.z = prevZ - c * (speed - world.player.speed) * dt;
  scanner.sample(world);

  world.tick += PURSUIT_SCAN_TICKS;
  chaser.x = prevX;
  chaser.z = prevZ;
  world.pursuit.gta.scan = scanner.sample(world);
  return chaser;
}

test("Test 1: source-level & runtime sensor-boundary audit + detectClosingPursuersFromScan accuracy", () => {
  const source = fs.readFileSync(EVASIVE_CONTROL_PATH, "utf8");
  for (const forbidden of [".patrols", ".actorIndex", "world.actors", "lastSeen", ".police", ".response"]) {
    assert.equal(
      source.includes(forbidden),
      false,
      `Forbidden private simulator token "${forbidden}" found in src/rl/pako-evasive-control.js`,
    );
  }
  assert.equal(choosePakoEvasiveAction, planPakoEvasiveAction);

  // Verify detectClosingPursuersFromScan uses ONLY scanModel + egoHeading.
  const emptyRays = Array.from({ length: PURSUIT_SCAN_RAYS }, () => ({ kind: "none", rangeM: PURSUIT_SCAN_RANGE_M }));
  const quiet = detectClosingPursuersFromScan({ freshTracks: [], rays: emptyRays }, Math.PI / 2);
  assert.deepEqual(quiet, {
    active: false,
    count: 0,
    nearestM: Infinity,
    dominantWorldBearing: null,
    rearPursuer: false,
  });

  const egoHeading = Math.PI / 2; // Heading East (+X); directly behind (-18 m forward) is West (-PI/2)
  const pressured = detectClosingPursuersFromScan(
    {
      freshTracks: [
        {
          kind: "police",
          rightM: 0,
          forwardM: -18,
          rangeM: 18,
          motionKnown: true,
          closingMps: 6.5,
        },
      ],
      rays: emptyRays,
    },
    egoHeading,
  );
  assert.equal(pressured.active, true);
  assert.equal(pressured.count, 1);
  assert.equal(pressured.nearestM, 18);
  assert.equal(pressured.rearPursuer, true);
  assert.ok(
    Math.abs(angleDelta(pressured.dominantWorldBearing, -Math.PI / 2)) < 1e-6,
    `expected dominantWorldBearing ~ -PI/2 (West), got ${pressured.dominantWorldBearing}`,
  );
});

test("Test 2: line-of-sight corner & alley break hooks behind Grand City v5 building under rear police pressure, cruises straight without police, and paces briskly in clear alleys", () => {
  // Subcase A: With NO police behind and a straight road guide, SUV cruises straight (steer === 0).
  {
    const { world } = createV5CornerLosWorld({ seed: "v5-los-no-police", withCrossStreet: true });
    const scanner = new PursuitScanner();
    world.pursuit.gta.scan = scanner.sample(world);
    const auditedWorld = makeSensorOnlyAuditedWorld(world);

    const cruiseDec = choosePakoEvasiveAction(auditedWorld, STRAIGHT_GUIDE);
    validatePursuitAction(cruiseDec.action);
    assert.equal(cruiseDec.action.steer, 0, "without police pressure, SUV must cruise straight along straight guide");
    assert.equal(cruiseDec.tacticalTag ?? null, null);
  }

  // Subcase B: Same intersection bordered by Grand City v5 building WITH police closing at forwardM = -18 m behind:
  // decisively hooks onto the building-shielded cross-street (tacticalTag === "los-break", |steer| >= 0.25) and occludes LOS!
  {
    const { world, seCornerBuilding } = createV5CornerLosWorld({
      seed: "v5-los-with-police",
      withCrossStreet: true,
    });
    const scanner = new PursuitScanner();
    const chaser = attachRearClosingPolice(world, scanner, { forwardM: -18.0, speed: 13.5 });
    const auditedWorld = makeSensorOnlyAuditedWorld(world);

    const breakDec = choosePakoEvasiveAction(auditedWorld, STRAIGHT_GUIDE);
    validatePursuitAction(breakDec.action);
    assert.equal(breakDec.tacticalTag, "los-break", "expected tacticalTag === 'los-break' when hooking behind corner building");
    assert.equal(breakDec.mode, "los-break");
    assert.ok(breakDec.losBreakBonus >= 8, `expected losBreakBonus >= 8, got ${breakDec.losBreakBonus}`);
    assert.ok(
      breakDec.action.steer >= 0.25,
      `expected decisive rightward corner hook steer >= 0.25 behind SE building, got ${breakDec.action.steer}`,
    );
    assert.equal(breakDec.action.gear, 1);

    // Verify selectDispatchMovement accepts the LOS-break turn and live rollout physically places the building between chaser and SUV!
    const guarded = selectDispatchMovement(world, STRAIGHT_GUIDE, () => choosePakoEvasiveAction(auditedWorld, STRAIGHT_GUIDE));
    assert.equal(guarded.reason, null);
    assert.equal(guarded.action.steer, breakDec.action.steer);

    let active = null;
    let achievedBuildingOcclusion = false;
    for (let i = 0; i < 190; i++) {
      if (!active || world.tick % PURSUIT_SCAN_TICKS === 0) {
        world.pursuit.gta.scan = scanner.sample(world);
        const dec = choosePakoEvasiveAction(auditedWorld, STRAIGHT_GUIDE);
        validatePursuitAction(dec.action);
        active = dec.action;
      }
      world.command({ type: "pursuit-drive", action: active }, false);
      world.step();
      if (
        segmentIntersectsOrientedBox(
          chaser.x,
          chaser.z,
          world.player.x,
          world.player.z,
          seCornerBuilding,
          0,
        )
      ) {
        achievedBuildingOcclusion = true;
        break;
      }
    }
    assert.ok(achievedBuildingOcclusion, "expected SUV to hook behind SE corner building and physically occlude police LOS");
    assert.equal(world.pursuit.metrics.collisions, 0);
  }

  // Subcase B2: Diagonal slash boulevard corner break under rear police pressure.
  {
    const { world } = createV5CornerLosWorld({
      seed: "v5-los-diag-slash",
      withCrossStreet: false,
      withDiagonalStreet: true,
    });
    const scanner = new PursuitScanner();
    attachRearClosingPolice(world, scanner, { forwardM: -18.0, speed: 22.0 });
    const auditedWorld = makeSensorOnlyAuditedWorld(world);

    const diagBreakDec = choosePakoEvasiveAction(auditedWorld, STRAIGHT_GUIDE);
    validatePursuitAction(diagBreakDec.action);
    assert.equal(diagBreakDec.tacticalTag, "los-break");
    assert.ok(diagBreakDec.action.steer >= 0.25, `expected rightward hook onto diagonal slash boulevard, got ${diagBreakDec.action.steer}`);
  }

  // Subcase C: Straight-road alley mouth between buildings (no paved cross-street) + brisk clear-alley escape pace (12.5-13.5 m/s).
  {
    const { world } = createV5CornerLosWorld({
      seed: "v5-los-alley-mouth",
      withCrossStreet: false,
    });
    const scanner = new PursuitScanner();
    attachRearClosingPolice(world, scanner, { forwardM: -18.0, speed: 24.0 });
    const auditedWorld = makeSensorOnlyAuditedWorld(world);

    const alleyBreakDec = choosePakoEvasiveAction(auditedWorld, STRAIGHT_GUIDE);
    validatePursuitAction(alleyBreakDec.action);
    assert.ok(
      alleyBreakDec.tacticalTag === "los-break" || Math.abs(alleyBreakDec.action.steer) >= 0.25,
      `expected alley-mouth LOS break turn, got steer=${alleyBreakDec.action.steer}, tag=${alleyBreakDec.tacticalTag}`,
    );
    assert.ok(alleyBreakDec.action.steer >= 0.25, `expected rightward turn into building-shielded alley, got ${alleyBreakDec.action.steer}`);

    // Once inside the wide clear alley/courtyard (minPedGapM >= 3.5, minStaticGapM >= 1.1) at 11.8 m/s, verify brisk pace without braking!
    Object.assign(world.player, { x: 24.0, z: 0.0, heading: Math.PI / 2, speed: 11.8, steer: 0 });
    world.tick += PURSUIT_SCAN_TICKS;
    world.pursuit.gta.scan = scanner.sample(world);
    const briskAlleyDec = choosePakoEvasiveAction(auditedWorld, { steer: 0, throttle: 0.92, brake: 0, gear: 1 });
    validatePursuitAction(briskAlleyDec.action);
    assert.equal(briskAlleyDec.action.brake, 0, "wide clear alley with zero pedestrians must allow brisk ~12-13 m/s escape without braking");
    assert.ok(briskAlleyDec.action.throttle >= 0.48, `expected brisk throttle in clear alley, got ${briskAlleyDec.action.throttle}`);
  }
});

test("Test 3: pedestrian safety absolute priority blocks blind LOS-break turn into pedestrian-occupied cross-street/alley mouth", () => {
  const { world } = createV5CornerLosWorld({
    seed: "v5-los-pedestrian-priority",
    withCrossStreet: true,
    pedestrians: 1,
  });
  const scanner = new PursuitScanner();

  // Place pedestrian directly across the +x cross-street / alley mouth while police interceptor closes from -18 m behind!
  const mouthPed = world.actors.find((a) => a.type === "pedestrian");
  assert.ok(mouthPed, "expected pedestrian actor");
  world.command({ type: "pedestrian-motion", mode: "stop", id: mouthPed.id });
  Object.assign(mouthPed, { x: 8.2, z: -1.5, heading: 0, speed: 0 });

  attachRearClosingPolice(world, scanner, { forwardM: -18.0, speed: 25.0 });
  const auditedWorld = makeSensorOnlyAuditedWorld(world);

  const safeDec = choosePakoEvasiveAction(auditedWorld, STRAIGHT_GUIDE);
  validatePursuitAction(safeDec.action);
  assert.notEqual(
    safeDec.tacticalTag,
    "los-break",
    "must NOT award los-break turn into a pedestrian-occupied cross-street/alley mouth",
  );
  assert.ok(
    safeDec.action.steer <= 0.05,
    `must NEVER turn right into cross-street pedestrian (x=8.2, z=-1.5) despite rear police pressure; got steer=${safeDec.action.steer}`,
  );

  // Also verify computeLosBreakBonus directly returns 0 when pedestrian stands in the escape corridor.
  const scanModelForCheck = {
    egoHeading: world.player.heading,
    rays: world.pursuit.gta.scan.rays,
    rayPoints: [],
    hitPoints: [{ x: 5.6, z: 5.5, rangeM: Math.hypot(5.6, 5.5), kind: "pedestrian" }],
    surfacePoints: [],
    pedRays: [{ x: 5.6, z: 5.5, rangeM: Math.hypot(5.6, 5.5) }],
    freshTracks: [
      {
        kind: "pedestrian",
        rightM: 5.6,
        forwardM: 5.5,
        vx: 0,
        vz: 0,
        motionKnown: false,
        rangeM: Math.hypot(5.6, 5.5),
      },
    ],
  };
  const zeroPedBonus = computeLosBreakBonus({
    player: world.player,
    endPose: { x: 4.5, z: -1.5, heading: Math.PI / 2 },
    action: { steer: 0.72, throttle: 0.85, brake: 0, gear: 1 },
    pursuerPressure: {
      active: true,
      count: 1,
      nearestM: 18,
      dominantWorldBearing: Math.PI,
      rearPursuer: true,
    },
    localGeometry: {
      roads: world.roads,
      roadRects: [],
      pointRoadRects: [],
      statics: world.statics,
      curb: world.pursuit.gta.curb,
    },
    scanModel: scanModelForCheck,
    hasCrossRoadAhead: true,
  });
  assert.equal(zeroPedBonus, 0, "computeLosBreakBonus must return 0 whenever any pedestrian hazard is in the escape corridor");

  // Also verify immediate speed drop when cruising in an alley and a pedestrian appears within 6.5 m ahead!
  const { world: alleyPedWorld } = createV5CornerLosWorld({
    seed: "v5-alley-ped-slowdown",
    withCrossStreet: false,
    pedestrians: 1,
  });
  const alleyPed = alleyPedWorld.actors.find((a) => a.type === "pedestrian");
  alleyPedWorld.command({ type: "pedestrian-motion", mode: "stop", id: alleyPed.id });
  Object.assign(alleyPedWorld.player, { x: 24.0, z: 0.0, heading: Math.PI / 2, speed: 11.5, steer: 0 });
  Object.assign(alleyPed, { x: 29.8, z: 1.8, heading: 0, speed: 0 }); // ~6.1 m ahead in alley
  const alleyScanner = new PursuitScanner();
  alleyPedWorld.pursuit.gta.scan = alleyScanner.sample(alleyPedWorld);
  const alleyAudited = makeSensorOnlyAuditedWorld(alleyPedWorld);
  const slowDownDec = choosePakoEvasiveAction(alleyAudited, { steer: 0, throttle: 0.92, brake: 0, gear: 1 });
  validatePursuitAction(slowDownDec.action);
  assert.ok(
    slowDownDec.action.brake > 0 || slowDownDec.action.throttle <= 0.48 || Math.abs(slowDownDec.action.steer) >= 0.25,
    "must immediately drop from brisk alley speed or steer clear when pedestrian is within 6.5 m",
  );

  // Run multi-tick rollout past the intersection with mouthPed in place and rear police chasing: 0 pedestrian hits!
  let active = null;
  let minPedGapM = Infinity;
  for (let tick = 0; tick < 90; tick++) {
    if (!active || world.tick % PURSUIT_SCAN_TICKS === 0) {
      world.pursuit.gta.scan = scanner.sample(world);
      const dec = choosePakoEvasiveAction(auditedWorld, STRAIGHT_GUIDE);
      validatePursuitAction(dec.action);
      active = dec.action;
    }
    world.command({ type: "pursuit-drive", action: active }, false);
    world.step();
    minPedGapM = Math.min(minPedGapM, boxToCircleGap(world.player, mouthPed));
    assert.equal(overlaps(world.player, mouthPed), false, "must NEVER hit pedestrian in cross-street mouth");
  }
  assert.ok(minPedGapM >= 0.85, `expected safe pedestrian clearance >= 0.85 m, got ${minPedGapM}`);
  assert.equal(world.pursuit.metrics.pedestrianCollisions, 0);
});
