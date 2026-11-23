import assert from "node:assert/strict";
import test from "node:test";
import { STEP } from "../src/core/config.js";
import { createUnifiedCity } from "../src/core/unified-city.js";
import {
  angleDelta,
  bodyOnRoad,
  makeDiagonalRoad,
  overlaps,
  pointOnRoad,
  roadPointAt,
  roadPoseAt,
  roadProject,
  roadRect,
} from "../src/core/geometry.js";
import {
  METRO_CITY_CURBS,
  METRO_CURB_SUPPORT,
  acceptCurbPose,
  curbClearance,
  isPoseSupportedWithCurbs,
  nearCurb,
  surveyMetroCurb,
} from "../src/core/pako-curb.js";
import { validatePursuitAction } from "../src/core/pursuit-controls.js";
import { initializeGtaPatrol, integrateGtaSlip } from "../src/core/pursuit-gta.js";
import { SpatialIndex } from "../src/core/spatial-index.js";
import { integrateVehicle } from "../src/core/vehicle.js";
import { PLAYER_VEHICLE } from "../src/core/vehicle-spec.js";
import { World } from "../src/core/world.js";
import {
  nearestLocalRoadHeading,
  planPakoEvasiveAction,
  poseInSingleRoadRect,
  poseOnRoadOrCurb,
} from "../src/rl/pako-evasive-control.js";
import { selectDispatchMovement } from "../src/rl/pursuit-shield.js";
import { PursuitScanner, PURSUIT_SCAN_TICKS } from "../src/signal_processing/pursuit-scanner.js";

const POLICY_FORWARD = Object.freeze({ steer: 0, throttle: 0.84, brake: 0, gear: 1 });

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

function makeAuditedWorld(world) {
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
      get gta() {
        return world.pursuit.gta;
      },
      get patrols() {
        throw new Error("Forbidden read of world.pursuit.patrols");
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

function startV5Pursuit(world, extraConfig = {}) {
  const cmd = {
    type: "street-pursuit-start",
    variant: "gta",
    config: {
      ruleset: "dispatch-v1",
      maxActivePatrols: 0,
      enableRoadblocks: false,
      curbSupport: METRO_CITY_CURBS,
      ...extraConfig,
    },
  };
  world.config = { ...world.config, cityVersion: 5 };
  try {
    world.command(cmd);
  } catch (err) {
    if (!/Metro City v4/i.test(String(err?.message ?? err))) throw err;
    world.config = { ...world.config, cityVersion: 4 };
    world.command(cmd);
    world.config = { ...world.config, cityVersion: 5 };
  }
  const curb = surveyMetroCurb(world, METRO_CITY_CURBS);
  assert.ok(curb, "expected surveyed METRO_CITY_CURBS network on cityVersion 5");
  world.pursuit.gta.curb = curb;
  return curb;
}

function createDiagonalTestWorld({ seed = "diag-v5-test", pedestrians = 0 } = {}) {
  const world = new World({ cityVersion: 4, seed, traffic: 0, pedestrians }, "metro");

  const deg40 = (40 * Math.PI) / 180;
  const len = 180;
  const ux = Math.sin(deg40);
  const uz = Math.cos(deg40);
  const x1 = 420;
  const z1 = 220;
  const diagAvenue = makeDiagonalRoad({
    id: "heliopolis-diag-40",
    x1,
    z1,
    x2: x1 + ux * len,
    z2: z1 + uz * len,
    width: 14,
    laneOffsetM: 2.7,
    speedLimitMps: 10.5,
    zone: "avenue",
    marking: "center",
  });

  // Flanking diagonal buildings behind the 2.38 m sidewalks so snapping to 0 deg or 90 deg hits buildings/off-road.
  const diagBuildings = [];
  for (const side of [-1, 1]) {
    for (const [idx, along] of [38, 86, 134].entries()) {
      const pt = roadPointAt(diagAvenue, along, side * (diagAvenue.width / 2 + 2.9 + 7.0));
      diagBuildings.push(
        Object.freeze({
          id: `diag-bldg-${side > 0 ? "pos" : "neg"}-${idx}`,
          type: "static",
          kind: "building",
          x: pt.x,
          z: pt.z,
          width: 14,
          length: 34,
          height: 28,
          heading: diagAvenue.heading,
        }),
      );
    }
  }

  const startPose = roadPoseAt(diagAvenue, 20, 1);
  const exitPose = { id: "diag-exit-north", ...roadPoseAt(diagAvenue, 162, 1), roadId: diagAvenue.id };
  world.drivingRoads = [diagAvenue];
  world.roads = [diagAvenue];
  world.statics = [...diagBuildings];
  world.staticIndex = new SpatialIndex(world.statics);
  Object.assign(world.player, startPose, { speed: 0, steer: 0 });
  world.district = {
    ...world.district,
    grand: true,
    playerStart: { ...startPose },
    pursuitExits: [exitPose],
    drivingRoads: world.drivingRoads,
    roads: world.roads,
    statics: world.statics,
  };

  startV5Pursuit(world);
  return { world, diagAvenue };
}

test("Grand Metro City v5 curb survey & 40 deg diagonal avenue driving, weaving, and curb-climbing work cleanly without 0/90 deg snapping", () => {
  // 1. Verify v1 curb stays restricted to cityVersion === 4 while v2 supports cityVersion 4 and 5 (including Grand Metro City v5).
  const grandCity = createUnifiedCity({ dense: true, rush: true, grand: true });
  const v5MockWorld = {
    environment: "metro",
    config: { cityVersion: 5 },
    roads: grandCity.roads,
    drivingRoads: grandCity.drivingRoads,
    statics: grandCity.statics,
  };
  assert.equal(surveyMetroCurb(v5MockWorld, METRO_CURB_SUPPORT), null, "v1 curb must remain restricted to cityVersion 4");
  const grandCurb = surveyMetroCurb(v5MockWorld, METRO_CITY_CURBS);
  assert.ok(grandCurb && grandCurb.mode === METRO_CITY_CURBS);
  assert.ok(grandCurb.sites.filter((s) => s.axis === "diag").length >= 20, "expected oriented diagonal curb sites in v5");
  assert.deepEqual(
    grandCurb.courtyards.map((c) => ({ id: c.id, minX: c.minX, maxX: c.maxX, minZ: c.minZ, maxZ: c.maxZ })),
    [{ id: "metro-grand-blocks", minX: -520, maxX: 420, minZ: -420, maxZ: 360 }],
  );
  // Interior block courtyard pose inside [-520, 420] x [-420, 360] is supported; outside outer sidewalk (> 2.38 m) is rejected.
  const interiorPose = {
    x: -330,
    z: -250,
    heading: 0.4,
    width: PLAYER_VEHICLE.widthM,
    length: PLAYER_VEHICLE.lengthM,
  };
  assert.equal(isPoseSupportedWithCurbs(grandCurb, grandCity.roads, interiorPose), true);
  const outsidePerimeterPose = {
    x: -532,
    z: 0,
    heading: 0,
    width: PLAYER_VEHICLE.widthM,
    length: PLAYER_VEHICLE.lengthM,
  };
  assert.equal(isPoseSupportedWithCurbs(grandCurb, grandCity.roads, outsidePerimeterPose), false);

  // 2. Verify O(1) diagonal geometry helpers, wheel heights, nearCurb, curbClearance, and nearestLocalRoadHeading on a 40 deg avenue.
  const { world, diagAvenue } = createDiagonalTestWorld();
  const curb = world.pursuit.gta.curb;
  const diagSites = curb.sites.filter((s) => s.roadId === diagAvenue.id && s.axis === "diag");
  assert.equal(diagSites.length, 2, "expected clean +1 and -1 oriented curb ribbons along 40 deg avenue");

  const onDiagRoadPose = {
    ...roadPoseAt(diagAvenue, 40, 1),
    width: PLAYER_VEHICLE.widthM,
    length: PLAYER_VEHICLE.lengthM,
    type: "vehicle",
  };
  assert.equal(poseInSingleRoadRect(onDiagRoadPose, [diagAvenue]), true);
  assert.deepEqual(poseOnRoadOrCurb(onDiagRoadPose, world.roads, curb), { supported: true, usesCurb: false });
  assert.equal(isPoseSupportedWithCurbs(curb, world.roads, onDiagRoadPose), true);
  assert.ok(
    Math.abs(angleDelta(nearestLocalRoadHeading(onDiagRoadPose, onDiagRoadPose.heading + 0.18, world.roads), diagAvenue.heading)) < 1e-9,
    "nearestLocalRoadHeading must return exact 40 deg road tangent rather than snapping to 0/90 deg",
  );

  // Pose straddling +1 diagonal curb lip/sidewalk (leftOffset = +7.98 m, edge = +7.0 m).
  const onDiagCurbPt = roadPointAt(diagAvenue, 60, 7.98);
  const onDiagCurbPose = {
    x: onDiagCurbPt.x,
    z: onDiagCurbPt.z,
    heading: diagAvenue.heading,
    speed: 5.5,
    gtaSlipMps: 0,
    gtaYawRate: 0,
    width: PLAYER_VEHICLE.widthM,
    length: PLAYER_VEHICLE.lengthM,
    type: "vehicle",
  };
  assert.equal(bodyOnRoad(onDiagCurbPose, world.roads), false);
  assert.equal(isPoseSupportedWithCurbs(curb, world.roads, onDiagCurbPose), true);
  assert.deepEqual(poseOnRoadOrCurb(onDiagCurbPose, world.roads, curb), { supported: true, usesCurb: true });
  assert.equal(nearCurb(curb, onDiagCurbPose), true);
  const wheelOffsets = acceptCurbPose(curb, world.roads, onDiagCurbPose);
  assert.ok(wheelOffsets && onDiagCurbPose.curbSupportId?.startsWith("heliopolis-diag-40:pos:"));
  assert.ok(Object.values(wheelOffsets).every((v) => Math.abs(v) <= PLAYER_VEHICLE.suspensionTravelM + 1e-9));

  const projectStep = (actor, cmd) => {
    const next = integrateVehicle(actor, cmd, STEP);
    integrateGtaSlip(actor, next);
    return next;
  };
  const nextCurbStep = projectStep(onDiagCurbPose, { steer: 0, targetSpeed: 5.5 });
  assert.equal(
    curbClearance(
      world,
      curb,
      { a: onDiagCurbPose, next: nextCurbStep, command: { steer: 0, targetSpeed: 5.5 }, travel: 5.5 * STEP },
      [],
      projectStep,
    ),
    null,
  );

  // Off-ribbon beyond 2.38 m outer diagonal sidewalk is rejected.
  const beyondDiagSidewalkPt = roadPointAt(diagAvenue, 60, 10.6);
  const beyondDiagPose = { ...onDiagCurbPose, x: beyondDiagSidewalkPt.x, z: beyondDiagSidewalkPt.z };
  assert.equal(isPoseSupportedWithCurbs(curb, world.roads, beyondDiagPose), false);
  assert.deepEqual(poseOnRoadOrCurb(beyondDiagPose, world.roads, curb), { supported: false, usesCurb: false });

  // 3. Subcase A: Live weaving around a lane blocker on the 40 deg diagonal avenue without snapping to 0/90 deg.
  Object.assign(world.player, roadPoseAt(diagAvenue, 22, 1), {
    speed: 7.6,
    steer: 0,
    y: 0,
    supportHeightM: 0,
    curbSupportId: null,
  });
  const blockerPt = roadPointAt(diagAvenue, 42, 2.7);
  const laneBlocker = world.makeVehicle("diag-stalled-sedan", "sedan", {
    x: blockerPt.x,
    z: blockerPt.z,
    heading: diagAvenue.heading,
  });
  laneBlocker.speed = 0;
  world.actors.push(laneBlocker);

  const scanner = new PursuitScanner();
  const auditedWorld = makeAuditedWorld(world);
  let active = null;
  let maxHeadingErrRad = 0;
  let sawWeaveDecision = false;

  for (let i = 0; i < 280; i++) {
    if (!active || world.tick % PURSUIT_SCAN_TICKS === 0) {
      world.pursuit.gta.scan = scanner.sample(world);
      const dec = planPakoEvasiveAction(auditedWorld, POLICY_FORWARD);
      validatePursuitAction(dec.action);
      if (dec.reason !== null) sawWeaveDecision = true;
      assert.notEqual(dec.action.gear, -1, "must weave forward on 40 deg street without reversing");
      active = dec.action;
    }
    world.command({ type: "pursuit-drive", action: active }, false);
    world.step();
    maxHeadingErrRad = Math.max(maxHeadingErrRad, Math.abs(angleDelta(world.player.heading, diagAvenue.heading)));
    assert.equal(overlaps(world.player, laneBlocker), false, "must never collide with diagonal lane blocker");
  }

  const afterWeaveAlong = roadProject(diagAvenue, world.player).along;
  assert.ok(sawWeaveDecision, "expected active evasive steering around blocker on 40 deg street");
  assert.ok(afterWeaveAlong > 65, `expected SUV to pass blocker at along=42 and reach >65 m, got ${afterWeaveAlong}`);
  assert.ok(maxHeadingErrRad < 0.62, `expected smooth 40 deg diagonal weave without 0/90 deg snap, maxErr=${maxHeadingErrRad}`);
  assert.equal(world.pursuit.metrics.collisions, 0);

  // 4. Subcase B: Full-carriageway barrier on the 40 deg diagonal avenue climbs the 40 deg curb, bypasses, and rejoins asphalt.
  const { world: curbWorld, diagAvenue: diagAve2 } = createDiagonalTestWorld({ seed: "diag-curb-climb-40" });
  const shutterCenter = roadPointAt(diagAve2, 72, -0.35);
  const diagBarrier = Object.freeze({
    id: "diag-full-shutter",
    type: "static",
    kind: "barrier",
    x: shutterCenter.x,
    z: shutterCenter.z,
    width: 13.3,
    length: 1.0,
    height: 1.6,
    heading: diagAve2.heading,
  });
  curbWorld.statics.push(diagBarrier);
  curbWorld.staticIndex = new SpatialIndex(curbWorld.statics);
  curbWorld.pursuit.gta.curb = surveyMetroCurb(curbWorld, METRO_CITY_CURBS);

  // Start in the +leftOffset lane near the clear +1 sidewalk on the 40 deg avenue.
  const startClimbPt = roadPointAt(diagAve2, 46, 3.2);
  Object.assign(curbWorld.player, {
    x: startClimbPt.x,
    z: startClimbPt.z,
    heading: diagAve2.heading,
    speed: 5.2,
    steer: 0,
  });

  const curbScanner = new PursuitScanner();
  const auditedCurbWorld = makeAuditedWorld(curbWorld);
  let curbAction = null;
  let climbedDiagCurb = false;
  let sawCurbBypass = false;

  for (let i = 0; i < 420 && roadProject(diagAve2, curbWorld.player).along < 98; i++) {
    if (!curbAction || curbWorld.tick % PURSUIT_SCAN_TICKS === 0) {
      curbWorld.pursuit.gta.scan = curbScanner.sample(curbWorld);
      const dec = planPakoEvasiveAction(auditedCurbWorld, POLICY_FORWARD);
      validatePursuitAction(dec.action);
      if (dec.reason === "PREDICTIVE_CURB_BYPASS") sawCurbBypass = true;
      curbAction = dec.action;
    }
    curbWorld.command({ type: "pursuit-drive", action: curbAction }, false);
    curbWorld.step();
    if (curbWorld.player.curbSupportId?.startsWith("heliopolis-diag-40:pos:")) {
      climbedDiagCurb = true;
    }
    assert.equal(overlaps(curbWorld.player, diagBarrier), false, "must never hit 40 deg carriageway barrier");
  }

  const finalAlong = roadProject(diagAve2, curbWorld.player).along;
  assert.ok(sawCurbBypass, "expected PREDICTIVE_CURB_BYPASS on 40 deg diagonal street");
  assert.ok(climbedDiagCurb, "expected SUV to physically climb onto heliopolis-diag-40:pos curb ribbon");
  assert.ok(finalAlong > 86, `expected SUV past barrier at along=72 to >86 m, got ${finalAlong}`);
  assert.equal(bodyOnRoad(curbWorld.player, curbWorld.roads), true, "expected SUV to rejoin 40 deg asphalt after barrier");
  assert.equal(curbWorld.pursuit.metrics.collisions, 0);
});

test("staggered curbside parked-vehicle chicane weaves cleanly between left and right parked cars with 0 contacts and 0 private reads", () => {
  const { world, diagAvenue } = createDiagonalTestWorld({ seed: "parked-chicane-v5" });

  // Place 6 staggered parked-vehicle statics alternating across right and left pockets to force a multi-bend S-chicane weave.
  const chicaneSpecs = [
    [38, 4.9],
    [38, 2.5],
    [64, -4.9],
    [64, -2.5],
    [90, 4.9],
    [90, 2.5],
  ];
  const parkedCars = chicaneSpecs.map(([along, leftOff], idx) => {
    const pt = roadPointAt(diagAvenue, along, leftOff);
    return Object.freeze({
      id: `chicane-parked-${idx}`,
      type: "static",
      kind: "parked-vehicle",
      vehicleKind: idx % 2 === 0 ? "sedan" : "van",
      x: pt.x,
      z: pt.z,
      width: 1.86,
      length: 4.4,
      height: 1.6,
      heading: diagAvenue.heading,
    });
  });
  world.statics.push(...parkedCars);
  world.staticIndex = new SpatialIndex(world.statics);
  world.pursuit.gta.curb = surveyMetroCurb(world, METRO_CITY_CURBS);

  const startPt = roadPointAt(diagAvenue, 14, 2.4);
  Object.assign(world.player, {
    x: startPt.x,
    z: startPt.z,
    heading: diagAvenue.heading,
    speed: 6.8,
    steer: 0,
  });

  const scanner = new PursuitScanner();
  const auditedWorld = makeAuditedWorld(world);
  let active = null;
  let minLeftOffset = Infinity;
  let maxLeftOffset = -Infinity;
  let reverseTicks = 0;

  for (let i = 0; i < 540 && roadProject(diagAvenue, world.player).along < 112; i++) {
    if (!active || world.tick % PURSUIT_SCAN_TICKS === 0) {
      world.pursuit.gta.scan = scanner.sample(world);
      const dec = planPakoEvasiveAction(auditedWorld, POLICY_FORWARD);
      validatePursuitAction(dec.action);
      active = dec.action;
    }
    if (active.gear === -1) reverseTicks++;
    world.command({ type: "pursuit-drive", action: active }, false);
    world.step();

    const proj = roadProject(diagAvenue, world.player);
    minLeftOffset = Math.min(minLeftOffset, proj.leftOffset);
    maxLeftOffset = Math.max(maxLeftOffset, proj.leftOffset);
    for (const parked of parkedCars) {
      assert.equal(overlaps(world.player, parked), false, `must never touch ${parked.id}`);
    }
  }

  const endAlong = roadProject(diagAvenue, world.player).along;
  assert.equal(reverseTicks, 0, "chicane weave must stay in forward gear with 0 reverse flips");
  assert.ok(endAlong >= 110, `expected SUV to clear entire chicane past along=110 m, got ${endAlong}`);
  assert.ok(minLeftOffset < 0.2 && maxLeftOffset > 0.8, `expected true lateral S-weave, span=[${minLeftOffset}, ${maxLeftOffset}]`);
  assert.equal(world.pursuit.metrics.collisions, 0);
});

test("dense pedestrian crossing wave (5 pedestrians ahead): SUV waits/creeps calmly with 0 reverse flips, then proceeds with 0 hits and 0 private reads", () => {
  const world = new World({ cityVersion: 4, seed: "crowd-wave-v5", traffic: 0, pedestrians: 5 }, "metro");
  startV5Pursuit(world);

  // Place SUV heading North (0 rad) on civic-avenue (x in [-189, -177]) approaching a 5-pedestrian crossing wave at z = -42..-39.
  Object.assign(world.player, { x: -181.2, z: -51.5, heading: 0, speed: 4.8, steer: 0 });

  const walkers = world.actors.filter((a) => a.type === "pedestrian");
  assert.equal(walkers.length, 5, "expected 5 ambient pedestrians");
  const waveOffsets = [
    { x: -187.2, z: -41.8 },
    { x: -184.8, z: -40.8 },
    { x: -182.4, z: -41.5 },
    { x: -180.0, z: -40.4 },
    { x: -178.0, z: -41.2 },
  ];
  for (let i = 0; i < walkers.length; i++) {
    const w = walkers[i];
    // Freeze built-in walk-route AI by stopping command, then advance each walker smoothly East across the crosswalk each tick.
    world.command({ type: "pedestrian-motion", mode: "stop", id: w.id });
    Object.assign(w, {
      x: waveOffsets[i].x,
      z: waveOffsets[i].z,
      heading: Math.PI / 2,
      speed: 1.55,
    });
  }

  const scanner = new PursuitScanner();
  const auditedWorld = makeAuditedWorld(world);
  let active = null;
  let sawCrowdYield = false;
  let reverseFlips = 0;
  let minSpeedDuringWave = Infinity;
  let minPedGapM = Infinity;
  let climbedSidewalkUnnecessarily = false;

  for (let tick = 0; tick < 520 && world.player.z < -16; tick++) {
    // Advance the 5 crossing pedestrians East across civic-avenue onto the far +x sidewalk (x = -173.5) so a realistic crosswalk wave clears.
    for (const w of walkers) {
      if (w.x < -173.2) {
        w.x += 1.55 * STEP;
        w.speed = 1.55;
      } else {
        w.speed = 0;
      }
    }

    if (!active || world.tick % PURSUIT_SCAN_TICKS === 0) {
      world.pursuit.gta.scan = scanner.sample(world);
      const checked = selectDispatchMovement(world, POLICY_FORWARD, (w, req) => {
        assert.equal(w, world);
        return planPakoEvasiveAction(auditedWorld, req);
      });
      validatePursuitAction(checked.action);
      if (
        checked.planner?.maneuver === "crowd-wait" ||
        checked.planner?.maneuver === "crowd-creep"
      ) {
        sawCrowdYield = true;
      }
      if (checked.action.gear === -1) reverseFlips++;
      active = checked.action;
    }

    world.command({ type: "pursuit-drive", action: active }, false);
    world.step();

    if (world.player.z < -38) {
      minSpeedDuringWave = Math.min(minSpeedDuringWave, world.player.speed);
      if (world.player.curbSupportId) climbedSidewalkUnnecessarily = true;
    }
    for (const w of walkers) {
      minPedGapM = Math.min(minPedGapM, boxToCircleGap(world.player, w));
      assert.equal(overlaps(world.player, w), false, `must never hit crossing pedestrian ${w.id}`);
    }
  }

  assert.ok(sawCrowdYield, "expected SUV to enter calm crowd-wait / crowd-creep while 5 pedestrians cross");
  assert.ok(minSpeedDuringWave < 1.2, `expected SUV to genuinely slow/yield for crossing crowd, minSpeed=${minSpeedDuringWave}`);
  assert.equal(climbedSidewalkUnnecessarily, false, "must wait on roadway rather than jumping sidewalk when no police are nearby");
  assert.equal(reverseFlips, 0, "must have 0 panic reverse gear flips while waiting for crossing pedestrians");
  assert.ok(minPedGapM > 0.55, `expected safe clearance to all 5 pedestrians, minPedGapM=${minPedGapM}`);
  assert.ok(world.player.z >= -18, `expected SUV to proceed cleanly past z=-41 crosswalk to >= -18, got z=${world.player.z}`);
  assert.equal(world.pursuit.metrics.pedestrianCollisions, 0);
  assert.equal(world.pursuit.metrics.collisions, 0);
});

test("police cruiser closing within 9.5 m behind dense crowd triggers smooth curb/alley diversion away from crowd with 0 pedestrian hits", () => {
  const world = new World({ cityVersion: 4, seed: "crowd-police-divert-v5", traffic: 0, pedestrians: 4 }, "metro");
  startV5Pursuit(world);

  // SUV on civic-avenue near the clear +x sidewalk/courtyard with 4 pedestrians blocking the carriageway ahead at z = -40,
  // while a police interceptor closes fast at 7.5 m behind ego!
  Object.assign(world.player, { x: -179.8, z: -50.0, heading: 0, speed: 4.5, steer: 0 });
  const walkers = world.actors.filter((a) => a.type === "pedestrian");
  const positions = [
    [-187.5, -40.2],
    [-184.8, -39.8],
    [-182.2, -40.4],
    [-179.8, -39.9],
  ];
  for (let i = 0; i < walkers.length; i++) {
    world.command({ type: "pedestrian-motion", mode: "stop", id: walkers[i].id });
    Object.assign(walkers[i], { x: positions[i][0], z: positions[i][1], heading: 0, speed: 0 });
  }

  const chaser = world.makeVehicle("closing-police-chaser", "suv", {
    x: -179.8,
    z: -57.4,
    heading: 0,
  });
  initializeGtaPatrol(chaser, "interceptor", world.pursuit);
  chaser.speed = 13.5;
  world.pursuit.patrols.add(chaser);
  world.actors.push(chaser);

  const scanner = new PursuitScanner();
  const auditedWorld = makeAuditedWorld(world);
  world.pursuit.gta.scan = scanner.sample(world);

  // Immediately verify planner diverts onto the clear +x curb/alley instead of crowd-wait when police is 7.4 m behind!
  const firstDec = planPakoEvasiveAction(auditedWorld, POLICY_FORWARD);
  assert.notEqual(firstDec.maneuver, "crowd-wait", "must divert rather than hold when police cruiser is within 9.5 m");
  assert.equal(firstDec.reason, "PREDICTIVE_CURB_BYPASS");
  assert.ok(firstDec.action.steer > 0, "expected rightward diversion onto clear +x curb/courtyard away from crowd");

  let active = null;
  let divertedOntoCurb = false;
  for (let i = 0; i < 180; i++) {
    if (!active || world.tick % PURSUIT_SCAN_TICKS === 0) {
      world.pursuit.gta.scan = scanner.sample(world);
      const dec = planPakoEvasiveAction(auditedWorld, POLICY_FORWARD);
      validatePursuitAction(dec.action);
      active = dec.action;
    }
    world.command({ type: "pursuit-drive", action: active }, false);
    world.step();
    if (world.player.curbSupportId || !bodyOnRoad(world.player, world.roads)) {
      divertedOntoCurb = true;
    }
    for (const w of walkers) {
      assert.equal(overlaps(world.player, w), false, `must never hit crowd pedestrian ${w.id}`);
    }
  }

  assert.ok(divertedOntoCurb, "expected SUV to divert onto clear curb/courtyard away from crowd when police close within 9.5 m");
  assert.ok(world.player.z > -36, `expected SUV to bypass crowd past z=-40, got z=${world.player.z}`);
  assert.equal(world.pursuit.metrics.pedestrianCollisions, 0);
});
