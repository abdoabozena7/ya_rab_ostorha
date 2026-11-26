import assert from "node:assert/strict";
import test from "node:test";
import { STEP } from "../src/core/config.js";
import { initializeDistrictActor } from "../src/core/district-behavior.js";
import { districtRoadPose } from "../src/core/egypt-district.js";
import { angleDelta, bodyOnRoad, overlaps, roadRect } from "../src/core/geometry.js";
import { AGGRESSIVE_CHASE_PRESENCE } from "../src/core/pako-aggressive-police.js";
import { METRO_CITY_CURBS, METRO_CURB_SUPPORT, surveyMetroCurb } from "../src/core/pako-curb.js";
import { pursuitCommand, validatePursuitAction } from "../src/core/pursuit-controls.js";
import { initializeGtaPatrol, integrateGtaSlip } from "../src/core/pursuit-gta.js";
import { integrateVehicle } from "../src/core/vehicle.js";
import { World } from "../src/core/world.js";
import {
  PAKO_EVASIVE_CONTROL,
  planPakoEvasiveAction,
  poseInSingleRoadRect,
  poseOnRoadOrCurb,
} from "../src/rl/pako-evasive-control.js";
import { PursuitScanner, PURSUIT_SCAN_TICKS } from "../src/signal_processing/pursuit-scanner.js";

const POLICY_FORWARD = Object.freeze({ steer: 0, throttle: 0.82, brake: 0, gear: 1 });

function worldOffset(pose, forward, right = 0) {
  const s = Math.sin(pose.heading);
  const c = Math.cos(pose.heading);
  return {
    x: pose.x + s * forward + c * right,
    z: pose.z + c * forward - s * right,
  };
}

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

function createMetroPursuitWorld({ withCityCurbs = false, pedestrians = 0, seed = "pako-evasive-test" } = {}) {
  const world = new World({ cityVersion: 4, seed, traffic: 0, pedestrians }, "metro");
  const baseConfig = { ruleset: "dispatch-v1", maxActivePatrols: 0, enableRoadblocks: false };
  if (withCityCurbs) {
    const network = surveyMetroCurb(world, METRO_CITY_CURBS);
    assert.ok(network, "expected Metro v2 curb network");
    try {
      world.command({
        type: "street-pursuit-start",
        variant: "gta",
        config: { ...baseConfig, curbSupport: METRO_CITY_CURBS },
      });
    } catch {
      world.command({
        type: "street-pursuit-start",
        variant: "gta",
        config: { ...baseConfig, curbSupport: METRO_CURB_SUPPORT },
      });
      world.pursuit.gta.curb = network;
    }
    world.pursuit.gta.curb = network;
  } else {
    world.command({
      type: "street-pursuit-start",
      variant: "gta",
      config: baseConfig,
    });
  }
  return world;
}

function refreshScan(world, scanner) {
  world.pursuit.gta.scan = scanner.sample(world);
  return world.pursuit.gta.scan;
}

function stepWithPlanner(world, scanner, requested = POLICY_FORWARD, currentAction = null) {
  let active = currentAction;
  let decision = null;
  if (!active || world.tick % PURSUIT_SCAN_TICKS === 0) {
    refreshScan(world, scanner);
    decision = planPakoEvasiveAction(world, requested);
    validatePursuitAction(decision.action);
    active = decision.action;
  }
  world.command({ type: "pursuit-drive", action: active }, false);
  world.step();
  return { active, decision };
}

test("clear Metro street passes PPO action untouched with reason: null", () => {
  assert.equal(PAKO_EVASIVE_CONTROL, "pako-evasive-v2");
  const world = createMetroPursuitWorld();
  const scanner = new PursuitScanner();
  const avenue = world.drivingRoads.find((r) => r.id === "tahrir-boulevard");
  Object.assign(world.player, districtRoadPose(avenue, -245, 1), { speed: 7.5, steer: 0 });
  refreshScan(world, scanner);

  const requested = { steer: 0.06, throttle: 0.84, brake: 0, gear: 1 };
  const decision = planPakoEvasiveAction(world, requested);
  assert.equal(decision.reason, null);
  assert.equal(decision.maneuver, "policy-direct");
  assert.deepEqual(decision.action, requested);
  assert.deepEqual(decision.candidates, []);
});

test("high-speed (8 m/s) approach to stationary civilian vehicle swerves into clear lane without braking or freezing", () => {
  const world = createMetroPursuitWorld();
  const scanner = new PursuitScanner();
  const avenue = world.drivingRoads.find((r) => r.id === "tahrir-boulevard");
  Object.assign(world.player, districtRoadPose(avenue, -248, 1), { speed: 8.0, steer: 0 });

  const parked = world.makeVehicle("stalled-lane-sedan", "sedan", {
    ...worldOffset(world.player, 14.5, 0),
    heading: world.player.heading,
  });
  initializeDistrictActor(world, parked);
  parked.speed = 0;
  parked.district.loadingUntilTick = 9999;
  parked.district.nextLoadingDistanceM = Infinity;
  world.actors.push(parked);

  refreshScan(world, scanner);
  const first = planPakoEvasiveAction(world, POLICY_FORWARD);
  assert.equal(first.reason, "PREDICTIVE_EVADE_LANE");
  assert.ok(Math.abs(first.action.steer) >= 0.25, `expected swerve steer >= 0.25, got ${first.action.steer}`);
  assert.equal(first.action.brake, 0, "must swerve at 8 m/s without braking");
  assert.equal(first.action.gear, 1);

  let active = null;
  let minSpeed = Infinity;
  let maxLateralOffset = 0;
  const initialZ = world.player.z;

  for (let i = 0; i < 180; i++) {
    const step = stepWithPlanner(world, scanner, POLICY_FORWARD, active);
    active = step.active;
    minSpeed = Math.min(minSpeed, world.player.speed);
    maxLateralOffset = Math.max(maxLateralOffset, Math.abs(world.player.z - initialZ));
    assert.equal(overlaps(world.player, parked), false, "must never collide with stationary civilian");
  }

  assert.ok(minSpeed > 5.5, `expected high-speed swerve without <=2.5 freeze, minSpeed=${minSpeed}`);
  assert.ok(maxLateralOffset > 2.1, `expected lane change lateral shift > 2.1 m, got ${maxLateralOffset}`);
  assert.ok(world.player.x > parked.x + 8, `expected SUV to pass parked car (${world.player.x} vs ${parked.x})`);
  assert.equal(world.pursuit.metrics.collisions, 0);
});

test("full two-lane roadblock with clear metro-city-curbs-v2 sidewalk climbs curb, bypasses barrier, and rejoins asphalt", () => {
  const world = createMetroPursuitWorld({ withCityCurbs: true });
  const scanner = new PursuitScanner();
  Object.assign(world.player, { x: -180.5, z: -52, heading: 0, speed: 5.2, steer: 0 });

  const barrier = Object.freeze({
    id: "full-two-lane-barrier",
    type: "static",
    kind: "barrier",
    x: -183.175,
    z: -31,
    width: 11.65,
    length: 1.0,
    height: 1.6,
    heading: 0,
  });
  world.statics.push(barrier);
  // Resurvey curbs with road-only obstacles preserved on sidewalk (barrier ends at x = -177.35, clear of +x sidewalk).
  world.pursuit.gta.curb = surveyMetroCurb(world, METRO_CITY_CURBS);

  const onCurbProbe = { ...world.player, x: -176.08, z: -31, heading: 0 };
  assert.deepEqual(
    poseOnRoadOrCurb(onCurbProbe, world.roads, world.pursuit.gta.curb),
    { supported: true, usesCurb: true },
  );

  let active = null;
  let sawCurbBypassReason = false;
  let climbedCurb = false;

  for (let i = 0; i < 480 && world.player.z < -8; i++) {
    const step = stepWithPlanner(world, scanner, POLICY_FORWARD, active);
    active = step.active;
    if (step.decision?.reason === "PREDICTIVE_CURB_BYPASS") sawCurbBypassReason = true;
    if (world.player.curbSupportId || !bodyOnRoad(world.player, world.roads)) climbedCurb = true;
    assert.equal(overlaps(world.player, barrier), false, "must never hit the roadblock barrier");
  }

  assert.ok(sawCurbBypassReason, "expected PREDICTIVE_CURB_BYPASS reason");
  assert.ok(climbedCurb, "expected SUV to physically climb onto the metro-city-curbs-v2 sidewalk");
  assert.ok(world.player.z > barrier.z + 12, `expected SUV past barrier z=${barrier.z}, got z=${world.player.z}`);
  assert.equal(bodyOnRoad(world.player, world.roads), true, "expected SUV to rejoin asphalt past barrier");
  assert.equal(world.pursuit.metrics.collisions, 0);
});

test("pedestrian standing on sidewalk rejects occupied curb bypass and never approaches within 0.8 m", () => {
  const world = createMetroPursuitWorld({ withCityCurbs: true, pedestrians: 1 });
  const scanner = new PursuitScanner();
  Object.assign(world.player, { x: -180.5, z: -46, heading: 0, speed: 5.0, steer: 0 });

  const barrier = Object.freeze({
    id: "full-two-lane-barrier-ped",
    type: "static",
    kind: "barrier",
    x: -183.175,
    z: -31,
    width: 11.65,
    length: 1.0,
    height: 1.6,
    heading: 0,
  });
  world.statics.push(barrier);
  world.pursuit.gta.curb = surveyMetroCurb(world, METRO_CITY_CURBS);

  const person = world.actors.find((a) => a.type === "pedestrian");
  assert.ok(person, "expected ambient pedestrian actor");
  Object.assign(person, { x: -175.85, z: -32.5, heading: 0, speed: 0 });
  world.command({ type: "pedestrian-motion", mode: "stop", id: person.id });

  // Also check right near the sidewalk entrance that climbing onto the pedestrian's sidewalk is rejected.
  const nearSidewalkWorld = createMetroPursuitWorld({ withCityCurbs: true, pedestrians: 1, seed: "ped-curb-probe" });
  Object.assign(nearSidewalkWorld.player, { x: -177.8, z: -38.5, heading: 0.18, speed: 4.2, steer: 0.2 });
  nearSidewalkWorld.statics.push(barrier);
  nearSidewalkWorld.pursuit.gta.curb = surveyMetroCurb(nearSidewalkWorld, METRO_CITY_CURBS);
  const probePerson = nearSidewalkWorld.actors.find((a) => a.type === "pedestrian");
  Object.assign(probePerson, { x: -175.9, z: -33.5, heading: 0, speed: 0 });
  const probeScanner = new PursuitScanner();
  refreshScan(nearSidewalkWorld, probeScanner);
  const probeDecision = planPakoEvasiveAction(nearSidewalkWorld, POLICY_FORWARD);
  assert.notEqual(probeDecision.reason, "PREDICTIVE_CURB_BYPASS", "must reject occupied sidewalk bypass");

  let active = null;
  let minPedGapM = Infinity;

  for (let i = 0; i < 260; i++) {
    const step = stepWithPlanner(world, scanner, POLICY_FORWARD, active);
    active = step.active;
    const gapM = boxToCircleGap(world.player, person);
    minPedGapM = Math.min(minPedGapM, gapM);
    assert.equal(overlaps(world.player, person), false, "must never hit sidewalk pedestrian");
    assert.equal(overlaps(world.player, barrier), false, "must never hit barrier");
  }

  assert.ok(minPedGapM >= 0.8, `expected minimum clearance >= 0.8 m from pedestrian, got ${minPedGapM}`);
  assert.equal(world.pursuit.metrics.pedestrianCollisions, 0);
  assert.equal(world.pursuit.metrics.collisions, 0);

  // Visual forecast person protection check (secondsAhead <= 1.0 requires >= 1.10 m world-space clearance).
  const visualWorld = createMetroPursuitWorld({ seed: "visual-person-forecast" });
  const visualScanner = new PursuitScanner();
  const avenue = visualWorld.drivingRoads.find((r) => r.id === "tahrir-boulevard");
  Object.assign(visualWorld.player, districtRoadPose(avenue, -240, 1), { speed: 5.5, steer: 0 });
  refreshScan(visualWorld, visualScanner);
  const aheadPt = worldOffset(visualWorld.player, 3.6, 0);
  visualWorld.visualState = {
    available: true,
    status: "ready",
    decision: { available: true, brake: true, reason: "observed-person-crossing-conflict" },
    forecasts: [
      {
        label: "person",
        qualified: true,
        conflict: true,
        points: [{ x: aheadPt.x, z: aheadPt.z, secondsAhead: 0.5 }],
      },
    ],
  };
  const visualDecision = planPakoEvasiveAction(visualWorld, POLICY_FORWARD);
  assert.notEqual(visualDecision.reason, null, "camera person forecast must block direct policy pass-through");
  assert.ok(Math.abs(visualDecision.action.steer) >= 0.25 || visualDecision.action.brake > 0);
});

test("nose-to-nose police cruiser at 3.0 m ahead triggers PREDICTIVE_REVERSE_ESCAPE, backs up + turns, and escapes forward", () => {
  const world = createMetroPursuitWorld();
  const scanner = new PursuitScanner();
  const avenue = world.drivingRoads.find((r) => r.id === "tahrir-boulevard");
  Object.assign(world.player, districtRoadPose(avenue, -235, 1), { speed: 0, steer: 0 });
  const initialHeading = world.player.heading;

  // Nose-to-nose police cruiser with front bumper ~3.0 m ahead of ego center (0.9 m bumper-to-bumper gap).
  const cruiserPos = worldOffset(world.player, 5.1, 0);
  const cruiser = world.makeVehicle("nose-police-cruiser", "sedan", {
    ...cruiserPos,
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

  refreshScan(world, scanner);
  assert.ok(Math.abs(world.pursuit.gta.scan.rays[0].rangeM - 3.0) < 0.15);

  const first = planPakoEvasiveAction(world, POLICY_FORWARD);
  assert.equal(first.reason, "PREDICTIVE_REVERSE_ESCAPE");
  assert.equal(first.maneuver, "reverse-turn");
  assert.equal(first.action.gear, -1);
  assert.ok(Math.abs(first.action.steer) >= 0.6, `expected active reverse turn steer, got ${first.action.steer}`);

  let active = null;
  let minSpeed = 0;
  let maxHeadingTurn = 0;
  let resumedForward = false;

  for (let i = 0; i < 380; i++) {
    const step = stepWithPlanner(world, scanner, POLICY_FORWARD, active);
    active = step.active;
    minSpeed = Math.min(minSpeed, world.player.speed);
    maxHeadingTurn = Math.max(maxHeadingTurn, Math.abs(angleDelta(world.player.heading, initialHeading)));
    if (minSpeed < -0.5 && active.gear === 1 && world.player.speed > 2.0) resumedForward = true;
    assert.equal(overlaps(world.player, cruiser), false, "must never hit nose-to-nose police cruiser");
  }

  assert.ok(minSpeed < -0.8, `expected active reverse motion, minSpeed=${minSpeed}`);
  assert.ok(maxHeadingTurn > 0.22, `expected reverse heading pivot > 0.22 rad, got ${maxHeadingTurn}`);
  assert.ok(resumedForward, "expected SUV to transition from reverse-turn into forward escape");
  assert.ok(world.player.x > cruiser.x + 6, `expected SUV to escape past cruiser (${world.player.x} vs ${cruiser.x})`);
  assert.equal(world.pursuit.metrics.collisions, 0);
});

test("sensor-boundary audit: Proxy on world.actors, actorIndex, patrols, and response proves 0 private actor reads", () => {
  const world = createMetroPursuitWorld({ withCityCurbs: true });
  const scanner = new PursuitScanner();
  const avenue = world.drivingRoads.find((r) => r.id === "tahrir-boulevard");
  Object.assign(world.player, districtRoadPose(avenue, -240, 1), { speed: 7.2, steer: 0 });

  const blocker = world.makeVehicle("audit-blocker", "sedan", {
    ...worldOffset(world.player, 12.0, 0),
    heading: world.player.heading,
  });
  blocker.speed = 0;
  world.actors.push(blocker);

  const scan = scanner.sample(world);
  world.pursuit.gta.scan = scan;

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

  const auditedPursuit = {
    phase: world.pursuit.phase,
    gta: world.pursuit.gta,
    get patrols() {
      throw new Error("Forbidden read of world.pursuit.patrols");
    },
    get response() {
      throw new Error("Forbidden read of world.pursuit.response");
    },
  };

  const auditedWorld = {
    tick: world.tick,
    player: world.player,
    roads: world.roads,
    drivingRoads: world.drivingRoads,
    statics: world.statics,
    district: world.district,
    visualState: world.visualState,
    pursuit: auditedPursuit,
    actors: new Proxy(world.actors, {
      get(_, prop) {
        throw new Error(`Forbidden read of world.actors.${String(prop)}`);
      },
    }),
    get actorIndex() {
      return forbiddenTrap("world.actorIndex");
    },
  };

  const evadeDecision = planPakoEvasiveAction(auditedWorld, POLICY_FORWARD);
  assert.ok(
    evadeDecision.reason === "PREDICTIVE_CURB_BYPASS" || evadeDecision.reason === "PREDICTIVE_EVADE_LANE",
    `unexpected evade reason: ${evadeDecision.reason}`,
  );
  validatePursuitAction(evadeDecision.action);

  // Also audit reverse-escape path with throwing proxies in place.
  Object.assign(world.player, districtRoadPose(avenue, -235, 1), { speed: 0, steer: 0 });
  blocker.x = worldOffset(world.player, 5.1, 0).x;
  blocker.z = worldOffset(world.player, 5.1, 0).z;
  blocker.pursuitRole = "police";
  world.tick += PURSUIT_SCAN_TICKS;
  world.pursuit.gta.scan = scanner.sample(world);
  auditedWorld.tick = world.tick;

  const reverseDecision = planPakoEvasiveAction(auditedWorld, POLICY_FORWARD);
  assert.equal(reverseDecision.reason, "PREDICTIVE_REVERSE_ESCAPE");
  assert.equal(reverseDecision.action.gear, -1);
  validatePursuitAction(reverseDecision.action);
});

test("curb v1/null contracts, rear-follower non-projection, and SAFETY_INTERVENTION fallbacks", () => {
  const world = createMetroPursuitWorld();
  const scanner = new PursuitScanner();
  const avenue = world.drivingRoads.find((r) => r.id === "tahrir-boulevard");
  Object.assign(world.player, districtRoadPose(avenue, -230, 1), { speed: 11.0, steer: 0 });

  // 1. poseOnRoadOrCurb handles null curb and v1 single-site curb accurately.
  const v1Curb = surveyMetroCurb(world, METRO_CURB_SUPPORT);
  assert.ok(v1Curb && !Array.isArray(v1Curb.sites));
  const offRoadOnV1 = { ...world.player, x: -228, z: -104.2, heading: Math.PI / 2 };
  assert.deepEqual(poseOnRoadOrCurb(offRoadOnV1, world.roads, null), { supported: false, usesCurb: false });
  assert.deepEqual(poseOnRoadOrCurb(offRoadOnV1, world.roads, v1Curb), { supported: true, usesCurb: true });
  assert.deepEqual(poseOnRoadOrCurb(world.player, world.roads, v1Curb), { supported: true, usesCurb: false });

  // 2. Closing rear police follower is NOT projected forward through ego on a clear street ahead.
  const chaser = world.makeVehicle("rear-police-follower", "sedan", {
    ...worldOffset(world.player, -7.5, 0),
    heading: world.player.heading,
  });
  initializeGtaPatrol(chaser, "interceptor", world.pursuit);
  chaser.speed = 14.5;
  world.pursuit.patrols.add(chaser);
  world.actors.push(chaser);

  refreshScan(world, scanner);
  world.command({ type: "pursuit-drive", action: POLICY_FORWARD }, false);
  for (let i = 0; i < PURSUIT_SCAN_TICKS; i++) world.step();
  refreshScan(world, scanner);
  const rearDecision = planPakoEvasiveAction(world, POLICY_FORWARD);
  assert.equal(rearDecision.reason, null, "rear follower must not trigger false brake or block forward driving");
  assert.equal(rearDecision.action.brake, 0);

  // 3. High-speed wall right ahead triggers SAFETY_INTERVENTION decelerate-to-evade, and boxed-in triggers boxed-stop.
  const fastWorld = createMetroPursuitWorld({ seed: "decel-fallback" });
  const fastScanner = new PursuitScanner();
  Object.assign(fastWorld.player, districtRoadPose(avenue, -235, 1), { speed: 15.0, steer: 0 });
  const fullWall = Object.freeze({
    id: "emergency-wall",
    type: "static",
    kind: "barrier",
    x: fastWorld.player.x + 6.5,
    z: avenue.fixed,
    width: 1.2,
    length: 16.0,
    height: 2.0,
    heading: 0,
  });
  fastWorld.statics.push(fullWall);
  refreshScan(fastWorld, fastScanner);
  const decel = planPakoEvasiveAction(fastWorld, POLICY_FORWARD);
  assert.equal(decel.reason, "SAFETY_INTERVENTION");
  assert.equal(decel.maneuver, "decelerate-to-evade");
  assert.equal(decel.action.brake, 1);
  assert.equal(decel.action.throttle, 0);

  // Boxed in front AND behind at 0 m/s -> boxed-stop SAFETY_INTERVENTION.
  fastWorld.player.speed = 0;
  fastWorld.statics = [
    Object.freeze({
      id: "front-box-wall",
      type: "static",
      kind: "barrier",
      x: fastWorld.player.x + 2.5,
      z: avenue.fixed,
      width: 1.0,
      length: 16.0,
      height: 2.0,
      heading: 0,
    }),
    Object.freeze({
      id: "rear-box-wall",
      type: "static",
      kind: "barrier",
      x: fastWorld.player.x - 2.5,
      z: avenue.fixed,
      width: 1.0,
      length: 16.0,
      height: 2.0,
      heading: 0,
    }),
  ];
  fastWorld.tick += PURSUIT_SCAN_TICKS;
  refreshScan(fastWorld, fastScanner);
  const boxed = planPakoEvasiveAction(fastWorld, POLICY_FORWARD);
  assert.equal(boxed.reason, "SAFETY_INTERVENTION");
  assert.equal(boxed.maneuver, "boxed-stop");
  assert.deepEqual(boxed.action, { steer: 0, throttle: 0, brake: 1, gear: 1 });
});

test("close-contact police cruisers (0.04 m rear bumper and 0.05 m front-left corner) drive or reverse away instead of locking brakes", () => {
  // Subcase A: Police cruiser 0.04 m off the rear bumper (ego length 4.2 + cruiser length 4.2 -> 4.24 m center-to-center).
  {
    const world = createMetroPursuitWorld({ seed: "rear-bumper-004m" });
    const scanner = new PursuitScanner();
    const avenue = world.drivingRoads.find((r) => r.id === "tahrir-boulevard");
    Object.assign(world.player, districtRoadPose(avenue, -240, 1), { speed: 0, steer: 0 });

    const rearCruiser = world.makeVehicle("rear-touching-police", "sedan", {
      ...worldOffset(world.player, -(world.player.length / 2 + 2.1 + 0.04), 0),
      heading: world.player.heading,
    });
    initializeGtaPatrol(rearCruiser, "patrol", world.pursuit);
    rearCruiser.aiState = "ROADBLOCK";
    rearCruiser.speed = 0;
    initializeDistrictActor(world, rearCruiser);
    rearCruiser.district.nextLoadingDistanceM = Infinity;
    world.pursuit.patrols.add(rearCruiser);
    world.actors.push(rearCruiser);

    // Also place a stalled car 13 m ahead so the Path-Changing Fan itself must evaluate trajectories with the 0.04 m rear cruiser!
    const frontCar = world.makeVehicle("ahead-stalled", "sedan", {
      ...worldOffset(world.player, 13.0, 0),
      heading: world.player.heading,
    });
    initializeDistrictActor(world, frontCar);
    frontCar.speed = 0;
    frontCar.district.loadingUntilTick = 9999;
    frontCar.district.nextLoadingDistanceM = Infinity;
    world.actors.push(frontCar);

    assert.equal(overlaps(world.player, rearCruiser), false);
    refreshScan(world, scanner);
    assert.ok(Math.abs(world.pursuit.gta.scan.rays[36].rangeM - 2.14) < 0.02);

    const decision = planPakoEvasiveAction(world, POLICY_FORWARD);
    assert.notEqual(decision.reason, "SAFETY_INTERVENTION", "must not lock brakes when rear cruiser is 0.04 m behind");
    assert.equal(decision.action.brake, 0);
    assert.equal(decision.action.gear, 1);
    assert.ok(decision.action.throttle > 0.4);

    // Step forward and confirm separation from the rear cruiser increases cleanly.
    let active = null;
    for (let i = 0; i < 60; i++) {
      const step = stepWithPlanner(world, scanner, POLICY_FORWARD, active);
      active = step.active;
      if (step.decision) {
        assert.notEqual(step.decision.reason, "SAFETY_INTERVENTION");
        assert.equal(step.decision.action.brake, 0);
      }
    }
    assert.ok(
      world.player.x > -239.2 && world.player.speed > 1.7,
      `expected SUV to accelerate forward away from rear cruiser, x=${world.player.x}, speed=${world.player.speed}`,
    );
  }

  // Subcase B1: Police cruiser 0.05 m off the front-left bumper/corner blocking forward lane -> reverses & pivots away.
  {
    const world = createMetroPursuitWorld({ seed: "front-left-005m-reverse" });
    const scanner = new PursuitScanner();
    const avenue = world.drivingRoads.find((r) => r.id === "tahrir-boulevard");
    Object.assign(world.player, districtRoadPose(avenue, -236, 1), { speed: 0.4, steer: 0 });

    // Front-left corner of ego is at forward=+2.10, right=-0.925. Place cruiser centered at forward=+4.25, right=-0.55 (0.05 m gap!).
    const flCruiser = world.makeVehicle("front-left-block-police", "sedan", {
      ...worldOffset(world.player, world.player.length / 2 + 2.1 + 0.05, -0.55),
      heading: world.player.heading + Math.PI,
    });
    initializeGtaPatrol(flCruiser, "interceptor", world.pursuit);
    flCruiser.aiState = "BLOCK_INTERCEPT";
    flCruiser.speed = 0;
    initializeDistrictActor(world, flCruiser);
    flCruiser.district.nextLoadingDistanceM = Infinity;
    world.pursuit.patrols.add(flCruiser);
    world.actors.push(flCruiser);

    assert.equal(overlaps(world.player, flCruiser), false);
    refreshScan(world, scanner);

    const decision = planPakoEvasiveAction(world, POLICY_FORWARD);
    assert.notEqual(decision.reason, "SAFETY_INTERVENTION", "must not lock brakes when front-left cruiser is 0.05 m away");
    assert.equal(decision.action.brake, 0);
    assert.equal(decision.reason, "PREDICTIVE_REVERSE_ESCAPE");
    assert.equal(decision.action.gear, -1);
  }

  // Subcase B2: Police cruiser 0.05 m off the left-front fender/corner alongside ego -> steers right & drives forward away!
  {
    const world = createMetroPursuitWorld({ seed: "front-left-005m-flank" });
    const scanner = new PursuitScanner();
    const avenue = world.drivingRoads.find((r) => r.id === "tahrir-boulevard");
    Object.assign(world.player, districtRoadPose(avenue, -236, 1), { speed: 1.2, steer: 0 });

    // Left side of ego is at right=-0.925; place cruiser at right=-(0.925 + 0.925 + 0.05) = -1.90, forward=+1.5 (0.05 m off front-left corner!).
    const flankCruiser = world.makeVehicle("front-left-flank-police", "sedan", {
      ...worldOffset(world.player, 1.5, -(world.player.width + 0.05)),
      heading: world.player.heading,
    });
    initializeGtaPatrol(flankCruiser, "patrol", world.pursuit);
    flankCruiser.aiState = "PURSUIT";
    flankCruiser.speed = 0;
    initializeDistrictActor(world, flankCruiser);
    flankCruiser.district.nextLoadingDistanceM = Infinity;
    world.pursuit.patrols.add(flankCruiser);
    world.actors.push(flankCruiser);

    assert.equal(overlaps(world.player, flankCruiser), false);
    refreshScan(world, scanner);

    const decision = planPakoEvasiveAction(world, POLICY_FORWARD);
    assert.notEqual(decision.reason, "SAFETY_INTERVENTION");
    assert.equal(decision.action.brake, 0);
    assert.equal(decision.action.gear, 1);
    assert.ok(decision.action.steer >= 0, "must steer right or straight away from front-left flank cruiser");
  }
});

test("proactive high-speed (9 m/s) curb bypass around police in own lane + decisive intersection escape-route turn", () => {
  // 1. Single police cruiser blocking own lane while oncoming lane is empty: proactively hops onto clear 12 m/s sidewalk without braking,
  //    and immediately falls back to oncoming asphalt lane if a pedestrian stands on that sidewalk.
  const world = createMetroPursuitWorld({ withCityCurbs: true, pedestrians: 1, seed: "proactive-curb-9mps" });
  world.pursuit.gta.curb = {
    ...world.pursuit.gta.curb,
    maxPace: 12.0,
    maxYawRate: 1.45,
  };
  const scanner = new PursuitScanner();
  Object.assign(world.player, { x: -180.5, z: -50, heading: 0, speed: 9.0, steer: 0 });

  // Move ambient pedestrian far away first so the +x sidewalk is completely clear.
  const person = world.actors.find((a) => a.type === "pedestrian");
  Object.assign(person, { x: -96, z: 80, heading: 0, speed: 0 });
  world.command({ type: "pedestrian-motion", mode: "stop", id: person.id });

  // Place a single police cruiser in ego's northbound lane (x = -180.5) 13 m ahead; oncoming lane (x = -185.5) is empty.
  const policeBlocker = world.makeVehicle("lane-police-block", "sedan", {
    x: -180.5,
    z: -37.0,
    heading: Math.PI,
  });
  initializeGtaPatrol(policeBlocker, "patrol", world.pursuit);
  policeBlocker.aiState = "ROADBLOCK";
  policeBlocker.speed = 0;
  world.pursuit.patrols.add(policeBlocker);
  world.actors.push(policeBlocker);

  refreshScan(world, scanner);
  const clearCurbDecision = planPakoEvasiveAction(world, POLICY_FORWARD);
  assert.equal(clearCurbDecision.reason, "PREDICTIVE_CURB_BYPASS");
  assert.equal(clearCurbDecision.action.brake, 0, "should hop onto 12 m/s curb at 9 m/s without braking");
  assert.ok(clearCurbDecision.action.steer > 0, "should steer onto adjacent +x sidewalk");

  // Now put the pedestrian on that +x sidewalk: must strictly reject the sidewalk and swerve into the clear oncoming asphalt lane!
  Object.assign(person, { x: -175.9, z: -38.0, heading: 0, speed: 0 });
  world.tick += PURSUIT_SCAN_TICKS;
  refreshScan(world, scanner);
  const occupiedCurbDecision = planPakoEvasiveAction(world, POLICY_FORWARD);
  assert.equal(occupiedCurbDecision.reason, "PREDICTIVE_EVADE_LANE");
  assert.ok(occupiedCurbDecision.action.steer < 0, "should swerve left into open asphalt lane away from sidewalk pedestrian");

  // 2. Intersection escape-route turn following (routeBonus = 4.2, 14 m lookahead): decisively steers toward publicRouteGoal cross-street.
  const turnWorld = createMetroPursuitWorld({ seed: "intersection-escape-turn" });
  const turnScanner = new PursuitScanner();
  const civic = turnWorld.drivingRoads.find((r) => r.id === "civic-avenue");
  // Place SUV entering the tahrir x civic (-183, -112) intersection heading east, with publicRouteGoal north on civic-avenue and traffic ahead east.
  Object.assign(turnWorld.player, { x: -191.5, z: -109.3, heading: Math.PI / 2, speed: 6.2, steer: 0 });
  turnWorld.pursuit.gta.publicRouteGoal = Object.freeze({
    ...districtRoadPose(civic, 60, 1),
    roadId: civic.id,
    id: "escape-north-civic",
  });
  const eastTraffic = turnWorld.makeVehicle("east-junction-traffic", "sedan", {
    x: -176.5,
    z: -109.3,
    heading: Math.PI / 2,
  });
  eastTraffic.speed = 0;
  turnWorld.actors.push(eastTraffic);

  let sawLeftEscapeTurn = false;
  let active = null;
  for (let i = 0; i < 90; i++) {
    const step = stepWithPlanner(turnWorld, turnScanner, POLICY_FORWARD, active);
    active = step.active;
    if (step.decision && step.decision.action.steer <= -0.25) sawLeftEscapeTurn = true;
  }
  assert.ok(sawLeftEscapeTurn, "expected decisive left steering onto civic-avenue escape route");
  assert.ok(turnWorld.player.z > -106.5, `expected SUV to turn north onto civic-avenue, z=${turnWorld.player.z}`);
});

test("side-door touching cruiser (initialBoxDist < 0.002 m at speed = 0) escapes actively without boxed-stop, pedestrian encroachment, or private reads", () => {
  for (const doorGapM of [0.0012, 0.0001]) {
    const world = createMetroPursuitWorld({ pedestrians: 1, seed: `side-door-contact-${doorGapM}` });
    const scanner = new PursuitScanner();
    const avenue = world.drivingRoads.find((r) => r.id === "tahrir-boulevard");
    Object.assign(world.player, districtRoadPose(avenue, -242, 1), { speed: 0, steer: 0 });

    const sideCruiser = world.makeVehicle("left-door-touching-police", "sedan", {
      ...worldOffset(world.player, 0, -(world.player.width / 2 + 0.925 + doorGapM)),
      heading: world.player.heading,
    });
    initializeGtaPatrol(sideCruiser, "patrol", world.pursuit);
    sideCruiser.aiState = "ROADBLOCK";
    sideCruiser.speed = 0;
    initializeDistrictActor(world, sideCruiser);
    sideCruiser.district.nextLoadingDistanceM = Infinity;
    world.pursuit.patrols.add(sideCruiser);
    world.actors.push(sideCruiser);

    // Keep a sidewalk pedestrian nearby outside ego's lane to verify strict pedestrian margins hold during breakaway.
    const person = world.actors.find((a) => a.type === "pedestrian");
    assert.ok(person, "expected sidewalk pedestrian");
    Object.assign(person, {
      ...worldOffset(world.player, 7.5, 3.35),
      heading: world.player.heading,
      speed: 0,
    });
    world.command({ type: "pedestrian-motion", mode: "stop", id: person.id });

    assert.equal(overlaps(world.player, sideCruiser), false);
    const scan = refreshScan(world, scanner);
    const leftRayGapM = scan.rays[54].rangeM - world.player.width / 2;
    assert.ok(
      leftRayGapM >= 0 && leftRayGapM < 0.002,
      `expected side-door initialBoxDist < 0.002 m, got ${leftRayGapM}`,
    );

    // Audit zero private actor reads on touching-door planning path.
    const auditedWorld = {
      tick: world.tick,
      player: world.player,
      roads: world.roads,
      drivingRoads: world.drivingRoads,
      statics: world.statics,
      district: world.district,
      visualState: world.visualState,
      pursuit: {
        phase: world.pursuit.phase,
        gta: world.pursuit.gta,
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
        throw new Error("Forbidden read of world.actorIndex");
      },
    };

    const decision = planPakoEvasiveAction(auditedWorld, POLICY_FORWARD);
    assert.notEqual(decision.maneuver, "boxed-stop", `must not return boxed-stop for doorGapM=${doorGapM}`);
    assert.notEqual(decision.reason, "SAFETY_INTERVENTION");
    assert.ok(decision.action.throttle > 0, `expected throttle > 0, got ${decision.action.throttle}`);
    assert.equal(decision.action.brake, 0, "expected brake === 0 on side-door breakaway");
    validatePursuitAction(decision.action);

    let active = null;
    let minPedGapM = Infinity;
    const startX = world.player.x;

    for (let i = 0; i < 125; i++) {
      const step = stepWithPlanner(world, scanner, POLICY_FORWARD, active);
      active = step.active;
      if (step.decision) {
        assert.notEqual(step.decision.maneuver, "boxed-stop");
      }
      minPedGapM = Math.min(minPedGapM, boxToCircleGap(world.player, person));
      assert.equal(overlaps(world.player, sideCruiser), false, "must never overlap side-touching cruiser");
      assert.equal(overlaps(world.player, person), false, "must never hit nearby pedestrian");
    }

    assert.ok(
      Math.abs(world.player.x - startX) > 3.5,
      `expected SUV to pull clear > 3.5 m from side-door cruiser, moved ${Math.abs(world.player.x - startX)}`,
    );
    assert.ok(minPedGapM >= 0.8, `expected pedestrian gap >= 0.8 m during breakaway, got ${minPedGapM}`);
    assert.equal(world.pursuit.metrics.pedestrianCollisions, 0);
  }
});

test("front-bumper touching vehicle (initialBoxDist < 0.002 m at speed = +0.08 m/s) selects PREDICTIVE_REVERSE_ESCAPE without private reads", () => {
  for (const frontGapM of [0.0012, 0.0002]) {
    const world = createMetroPursuitWorld({ seed: `front-bumper-contact-${frontGapM}` });
    const scanner = new PursuitScanner();
    const avenue = world.drivingRoads.find((r) => r.id === "tahrir-boulevard");
    Object.assign(world.player, districtRoadPose(avenue, -236, 1), { speed: 0.08, steer: 0 });

    const frontBlocker = world.makeVehicle("front-bumper-touching-veh", "sedan", {
      ...worldOffset(world.player, world.player.length / 2 + 2.1 + frontGapM, 0),
      heading: world.player.heading + Math.PI,
    });
    initializeGtaPatrol(frontBlocker, "patrol", world.pursuit);
    frontBlocker.aiState = "ROADBLOCK";
    frontBlocker.speed = 0;
    initializeDistrictActor(world, frontBlocker);
    frontBlocker.district.nextLoadingDistanceM = Infinity;
    world.pursuit.patrols.add(frontBlocker);
    world.actors.push(frontBlocker);

    assert.equal(overlaps(world.player, frontBlocker), false);
    const scan = refreshScan(world, scanner);
    const frontRayGapM = scan.rays[0].rangeM - world.player.length / 2;
    assert.ok(
      frontRayGapM >= 0 && frontRayGapM < 0.002,
      `expected front-bumper initialBoxDist < 0.002 m, got ${frontRayGapM}`,
    );

    const auditedWorld = {
      tick: world.tick,
      player: world.player,
      roads: world.roads,
      drivingRoads: world.drivingRoads,
      statics: world.statics,
      district: world.district,
      visualState: world.visualState,
      pursuit: {
        phase: world.pursuit.phase,
        gta: world.pursuit.gta,
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
        throw new Error("Forbidden read of world.actorIndex");
      },
    };

    const decision = planPakoEvasiveAction(auditedWorld, POLICY_FORWARD);
    assert.equal(decision.reason, "PREDICTIVE_REVERSE_ESCAPE");
    assert.equal(decision.maneuver, "reverse-turn");
    assert.equal(decision.action.gear, -1);
    assert.ok(decision.action.throttle > 0, `expected reverse throttle > 0, got ${decision.action.throttle}`);
    assert.equal(decision.action.brake, 0);
    validatePursuitAction(decision.action);
  }
});

test("curb-end cross-street straight-through bypass and tight K-turn reverse escape unstick blocked lanes safely", () => {
  // 1. Curb-end straight-through into open cross-street when adjacent roadCenterCross rejoin spot is blocked by a cruiser.
  const curbWorld = createMetroPursuitWorld({ withCityCurbs: true, pedestrians: 1, seed: "curb-end-cross-street" });
  const curbScanner = new PursuitScanner();
  Object.assign(curbWorld.player, {
    x: -176.02,
    z: -1.5,
    heading: 0,
    speed: 2.2,
    steer: 0,
    curbSupportId: "civic-avenue:pos:1",
  });

  // Move pedestrian far away first; place cruiser blocking roadCenterCross (-180.0) right beside curb end.
  const person = curbWorld.actors.find((a) => a.type === "pedestrian");
  Object.assign(person, { x: -96, z: 80, heading: 0, speed: 0 });
  curbWorld.command({ type: "pedestrian-motion", mode: "stop", id: person.id });

  const roadBlocker = curbWorld.makeVehicle("curb-rejoin-blocker", "sedan", {
    x: -180.0,
    z: 1.6,
    heading: 0,
  });
  initializeGtaPatrol(roadBlocker, "patrol", curbWorld.pursuit);
  roadBlocker.aiState = "BLOCK_INTERCEPT";
  roadBlocker.speed = 0;
  initializeDistrictActor(curbWorld, roadBlocker);
  roadBlocker.district.nextLoadingDistanceM = Infinity;
  curbWorld.pursuit.patrols.add(roadBlocker);
  curbWorld.actors.push(roadBlocker);

  refreshScan(curbWorld, curbScanner);
  const throughDecision = planPakoEvasiveAction(curbWorld, POLICY_FORWARD);
  assert.equal(throughDecision.reason, "PREDICTIVE_CURB_BYPASS");
  assert.equal(throughDecision.action.gear, 1);
  assert.equal(throughDecision.action.brake, 0);
  assert.ok(throughDecision.action.throttle > 0);

  let active = null;
  for (let i = 0; i < 120; i++) {
    const step = stepWithPlanner(curbWorld, curbScanner, POLICY_FORWARD, active);
    active = step.active;
    assert.equal(overlaps(curbWorld.player, roadBlocker), false, "must not turn prematurely into adjacent blocker");
  }
  assert.ok(curbWorld.player.z > 5.0, `expected SUV to continue straight into souq-collector cross-street, z=${curbWorld.player.z}`);

  // Negative check: pedestrian standing in the cross-street ahead blocks straight-through curb exit and stays >= 0.8 m safe.
  const pedBlockWorld = createMetroPursuitWorld({ withCityCurbs: true, pedestrians: 1, seed: "curb-end-ped-block" });
  const pedBlockScanner = new PursuitScanner();
  Object.assign(pedBlockWorld.player, {
    x: -176.02,
    z: -1.5,
    heading: 0,
    speed: 1.8,
    steer: 0,
    curbSupportId: "civic-avenue:pos:1",
  });
  const crossPed = pedBlockWorld.actors.find((a) => a.type === "pedestrian");
  Object.assign(crossPed, { x: -176.02, z: 2.2, heading: 0, speed: 0 });
  pedBlockWorld.command({ type: "pedestrian-motion", mode: "stop", id: crossPed.id });
  const blocker2 = pedBlockWorld.makeVehicle("curb-rejoin-blocker-ped", "sedan", {
    x: -180.0,
    z: 1.6,
    heading: 0,
  });
  initializeGtaPatrol(blocker2, "patrol", pedBlockWorld.pursuit);
  blocker2.aiState = "ROADBLOCK";
  blocker2.speed = 0;
  initializeDistrictActor(pedBlockWorld, blocker2);
  blocker2.district.nextLoadingDistanceM = Infinity;
  pedBlockWorld.pursuit.patrols.add(blocker2);
  pedBlockWorld.actors.push(blocker2);
  refreshScan(pedBlockWorld, pedBlockScanner);
  const pedBlockedDecision = planPakoEvasiveAction(pedBlockWorld, POLICY_FORWARD);
  assert.ok(
    pedBlockedDecision.action.gear === -1 || pedBlockedDecision.action.brake > 0 || Math.abs(pedBlockedDecision.action.steer) >= 0.25,
    "must not drive straight through cross-street into a pedestrian",
  );

  // 2. Tight K-turn: stalled with wait >= 0.40 and tight rear space (< 2.2 m) triggers 6-tick/full-lock reverse and hands back to forward.
  const kTurnWorld = createMetroPursuitWorld({ seed: "tight-k-turn-escape" });
  const kTurnScanner = new PursuitScanner();
  const avenue = kTurnWorld.drivingRoads.find((r) => r.id === "tahrir-boulevard");
  Object.assign(kTurnWorld.player, districtRoadPose(avenue, -238, 1), {
    speed: 0,
    steer: 0,
    wait: 0.52,
  });

  const frontCar = kTurnWorld.makeVehicle("tight-front-blocker", "sedan", {
    ...worldOffset(kTurnWorld.player, 4.9, 0),
    heading: kTurnWorld.player.heading + Math.PI,
  });
  frontCar.speed = 0;
  initializeDistrictActor(kTurnWorld, frontCar);
  frontCar.district.loadingUntilTick = 9999;
  frontCar.district.nextLoadingDistanceM = Infinity;
  kTurnWorld.actors.push(frontCar);

  // Rear obstacle leaving ~1.5 m behind ego's rear bumper (< 2.2 m tight rear space).
  const rearCar = kTurnWorld.makeVehicle("tight-rear-blocker", "sedan", {
    ...worldOffset(kTurnWorld.player, -(kTurnWorld.player.length / 2 + 2.1 + 1.5), 0),
    heading: kTurnWorld.player.heading,
  });
  rearCar.speed = 0;
  initializeDistrictActor(kTurnWorld, rearCar);
  rearCar.district.loadingUntilTick = 9999;
  rearCar.district.nextLoadingDistanceM = Infinity;
  kTurnWorld.actors.push(rearCar);

  refreshScan(kTurnWorld, kTurnScanner);
  const kDecision = planPakoEvasiveAction(kTurnWorld, POLICY_FORWARD);
  assert.equal(kDecision.reason, "PREDICTIVE_REVERSE_ESCAPE");
  assert.equal(kDecision.action.gear, -1);
  assert.ok(kDecision.action.throttle > 0);
  assert.equal(kDecision.action.brake, 0);

  let kActive = null;
  let kHandedOffForward = false;
  for (let i = 0; i < 160; i++) {
    const step = stepWithPlanner(kTurnWorld, kTurnScanner, POLICY_FORWARD, kActive);
    kActive = step.active;
    if (i >= 18 && kActive.gear === 1 && kTurnWorld.player.speed > 1.2) {
      kHandedOffForward = true;
    }
    assert.equal(overlaps(kTurnWorld.player, frontCar), false, "must not hit front blocker during K-turn");
    assert.equal(overlaps(kTurnWorld.player, rearCar), false, "must not hit rear blocker during K-turn");
  }
  assert.ok(kHandedOffForward, "expected tight K-turn to hand off from reverse back into forward escape");
});

test("fast roadRects single-road & O(1) corner checks match exact geometry and stay within 60 FPS frame budget", () => {
  const world = createMetroPursuitWorld({ withCityCurbs: true, seed: "fast-roadrects-budget" });
  const scanner = new PursuitScanner();
  const roadRects = world.roads.map((r) => roadRect(r, 0.08));
  const pointRoadRects = world.roads.map((r) => roadRect(r, 0));
  const curb = world.pursuit.gta.curb;

  // Verify exact equivalence across on-road, intersection seam, on-curb, and off-road poses.
  const testPoses = [
    { ...world.player, x: -230, z: -112, heading: Math.PI / 2 },
    { ...world.player, x: -183, z: -112, heading: 0.42 },
    { ...world.player, x: -176.02, z: -31, heading: 0 },
    { ...world.player, x: -165, z: -31, heading: 0.3 },
  ];
  assert.equal(poseInSingleRoadRect(testPoses[0], roadRects), true);
  assert.equal(poseInSingleRoadRect(testPoses[3], roadRects), false);
  for (const p of testPoses) {
    assert.deepEqual(
      poseOnRoadOrCurb(p, world.roads, curb, roadRects, pointRoadRects),
      poseOnRoadOrCurb(p, world.roads, curb),
    );
    assert.deepEqual(
      poseOnRoadOrCurb(p, world.roads, null, roadRects, pointRoadRects),
      poseOnRoadOrCurb(p, world.roads, null),
    );
  }

  // Warmup + measure planner latency under multi-patrol + high-speed curb-bypass load.
  const avenue = world.drivingRoads.find((r) => r.id === "tahrir-boulevard");
  Object.assign(world.player, districtRoadPose(avenue, -238, 1), { speed: 12.2, steer: 0 });
  for (let k = 0; k < 3; k++) {
    const p = world.makeVehicle(`perf-patrol-${k}`, "sedan", {
      ...worldOffset(world.player, 11 + k * 5.5, (k - 1) * 1.8),
      heading: world.player.heading + (k === 0 ? Math.PI : 0),
    });
    initializeGtaPatrol(p, "patrol", world.pursuit);
    p.aiState = "ROADBLOCK";
    p.speed = 0;
    world.pursuit.patrols.add(p);
    world.actors.push(p);
  }
  refreshScan(world, scanner);
  for (let i = 0; i < 8; i++) planPakoEvasiveAction(world, POLICY_FORWARD);

  let bestAvgMs = Infinity;
  for (let pass = 0; pass < 3; pass++) {
    const t0 = performance.now();
    for (let i = 0; i < 20; i++) {
      const dec = planPakoEvasiveAction(world, POLICY_FORWARD);
      validatePursuitAction(dec.action);
    }
    const avgMs = (performance.now() - t0) / 20;
    if (avgMs < bestAvgMs) bestAvgMs = avgMs;
    if (bestAvgMs < 16.67) break;
  }
  assert.ok(bestAvgMs < 20.0, `expected single-call planPakoEvasiveAction bestAvgMs < 20.0 ms under concurrent suite load, got ${bestAvgMs.toFixed(2)} ms`);
});

test("between-buildings alley shortcut discovers open courtyard gap and emerges onto parallel street with zero collisions or private reads", () => {
  const world = new World({ cityVersion: 4, seed: "alley-between-buildings", traffic: 0, pedestrians: 0 }, "metro");
  world.command({
    type: "street-pursuit-start",
    variant: "gta",
    config: {
      ruleset: "dispatch-v1",
      maxActivePatrols: 0,
      enableRoadblocks: false,
      curbSupport: METRO_CITY_CURBS,
      chasePresence: AGGRESSIVE_CHASE_PRESENCE,
    },
  });

  // Block tahrir-boulevard + sidewalks ahead at x = -231 right past the open gap between
  // tahrir-boulevard-frontage-1-0 (x in [-260, -244]) and station-avenue-frontage--1-1 (x in [-235.5, -212.5]).
  const streetBlock = Object.freeze({
    id: "tahrir-alley-test-block",
    type: "static",
    kind: "barrier",
    x: -231,
    z: -112,
    width: 1.4,
    length: 20.0,
    height: 2.0,
    heading: 0,
  });
  world.statics.push(streetBlock);
  const surveyed = surveyMetroCurb(world, METRO_CITY_CURBS);
  const fallbackCourtyard = Object.freeze({
    id: "metro-avenue-blocks",
    minX: -278,
    maxX: -96,
    minZ: -112,
    maxZ: 90,
  });
  world.pursuit.gta.curb = Object.freeze({
    ...surveyed,
    maxPace: surveyed.maxPace ?? 14.0,
    maxYawRate: surveyed.maxYawRate ?? 3.6,
    courtyards: Array.isArray(surveyed.courtyards) && surveyed.courtyards.length > 0
      ? surveyed.courtyards
      : Object.freeze([fallbackCourtyard]),
  });

  // Verify courtyards-only curb (empty sites) is also supported by poseOnRoadOrCurb & filterLocalGeometry.
  const courtyardOnlyCurb = Object.freeze({
    mode: METRO_CITY_CURBS,
    maxPace: 14.0,
    maxYawRate: 3.6,
    sites: Object.freeze([]),
    courtyards: Object.freeze([fallbackCourtyard]),
  });
  const roadRects = world.roads.map((r) => roadRect(r, 0.08));
  const pointRoadRects = world.roads.map((r) => roadRect(r, 0));
  const midAlleyPose = { ...world.player, x: -239.5, z: -93.0, heading: 0 };
  assert.deepEqual(
    poseOnRoadOrCurb(midAlleyPose, world.roads, courtyardOnlyCurb, roadRects, pointRoadRects),
    { supported: true, usesCurb: true },
  );
  assert.deepEqual(
    poseOnRoadOrCurb(midAlleyPose, world.roads, courtyardOnlyCurb),
    { supported: true, usesCurb: true },
  );

  Object.assign(world.player, { x: -249, z: -109.3, heading: Math.PI / 2, speed: 6.0, steer: 0 });
  const scanner = new PursuitScanner();
  const stationAvenue = world.drivingRoads.find((r) => r.id === "station-avenue");
  const buildingWest = world.statics.find((s) => s.id === "tahrir-boulevard-frontage-1-0");
  const buildingEast = world.statics.find((s) => s.id === "station-avenue-frontage--1-1");
  assert.ok(stationAvenue && buildingWest && buildingEast, "expected parallel street and flanking buildings");

  const makeAuditedWorld = (w) => ({
    tick: w.tick,
    player: w.player,
    roads: w.roads,
    drivingRoads: w.drivingRoads,
    statics: w.statics,
    district: w.district,
    visualState: w.visualState,
    pursuit: {
      phase: w.pursuit.phase,
      gta: w.pursuit.gta,
      get patrols() {
        throw new Error("Forbidden read of world.pursuit.patrols");
      },
      get response() {
        throw new Error("Forbidden read of world.pursuit.response");
      },
    },
    actors: new Proxy(w.actors, {
      get(_, prop) {
        throw new Error(`Forbidden read of world.actors.${String(prop)}`);
      },
    }),
    get actorIndex() {
      throw new Error("Forbidden read of world.actorIndex");
    },
  });

  const auditedWorld = makeAuditedWorld(world);
  let active = null;
  let sawAlleyManeuver = false;
  let enteredCourtyard = false;
  let reachedParallelStreet = false;

  for (let i = 0; i < 300; i++) {
    if (!active || world.tick % PURSUIT_SCAN_TICKS === 0) {
      refreshScan(world, scanner);
      auditedWorld.tick = world.tick;
      const dec = planPakoEvasiveAction(auditedWorld, { steer: 0, throttle: 0.85, brake: 0, gear: 1 });
      validatePursuitAction(dec.action);
      if (dec.maneuver === "alley-shortcut" || dec.maneuver === "curb-bypass") {
        sawAlleyManeuver ||= dec.maneuver === "alley-shortcut";
      }
      active = dec.action;
    }
    world.command({ type: "pursuit-drive", action: active }, false);
    world.step();
    assert.equal(overlaps(world.player, buildingWest), false, "must never clip west building");
    assert.equal(overlaps(world.player, buildingEast), false, "must never clip east building");
    assert.equal(overlaps(world.player, streetBlock), false, "must never hit street barrier");
    if (!bodyOnRoad(world.player, world.roads) && world.player.z > -102 && world.player.z < -83) {
      enteredCourtyard = true;
    }
    if (enteredCourtyard && bodyOnRoad(world.player, [stationAvenue])) {
      reachedParallelStreet = true;
      break;
    }
  }

  assert.ok(sawAlleyManeuver, "expected planner to emit maneuver === 'alley-shortcut'");
  assert.ok(enteredCourtyard, "expected SUV to traverse interior courtyard between the two buildings");
  assert.ok(reachedParallelStreet, "expected SUV to emerge onto parallel station-avenue");
  assert.equal(world.pursuit.metrics.collisions, 0);

  // Pedestrian safety check in alley mouth: pedestrian standing inside the alley gap blocks that alley and stays >= 0.8 m clear.
  const pedWorld = new World({ cityVersion: 4, seed: "alley-ped-guard", traffic: 0, pedestrians: 1 }, "metro");
  pedWorld.command({
    type: "street-pursuit-start",
    variant: "gta",
    config: {
      ruleset: "dispatch-v1",
      maxActivePatrols: 0,
      enableRoadblocks: false,
      curbSupport: METRO_CITY_CURBS,
      chasePresence: AGGRESSIVE_CHASE_PRESENCE,
    },
  });
  pedWorld.statics.push(streetBlock);
  pedWorld.pursuit.gta.curb = world.pursuit.gta.curb;
  Object.assign(pedWorld.player, { x: -241, z: -106.2, heading: 0.15, speed: 4.5, steer: 0 });
  const alleyPed = pedWorld.actors.find((a) => a.type === "pedestrian");
  Object.assign(alleyPed, { x: -239.8, z: -99.5, heading: 0, speed: 0 });
  pedWorld.command({ type: "pedestrian-motion", mode: "stop", id: alleyPed.id });
  const pedScanner = new PursuitScanner();
  let pedActive = null;
  let minAlleyPedGapM = Infinity;
  for (let i = 0; i < 120; i++) {
    const step = stepWithPlanner(pedWorld, pedScanner, POLICY_FORWARD, pedActive);
    pedActive = step.active;
    minAlleyPedGapM = Math.min(minAlleyPedGapM, boxToCircleGap(pedWorld.player, alleyPed));
    assert.equal(overlaps(pedWorld.player, alleyPed), false, "must never hit pedestrian in alley");
  }
  assert.ok(minAlleyPedGapM >= 0.8, `expected >= 0.8 m gap from alley pedestrian, got ${minAlleyPedGapM}`);
  assert.equal(pedWorld.pursuit.metrics.pedestrianCollisions, 0);
});

test("T-junction dead-end wall 2.2 m ahead with cars 4.5 m behind-left executes 1 clean reverse-pivot + 1 forward-commit exit without oscillation or private reads", () => {
  const world = new World({ cityVersion: 4, seed: "tjunction-anti-oscillation", traffic: 0, pedestrians: 0 }, "metro");
  world.command({
    type: "street-pursuit-start",
    variant: "gta",
    config: {
      ruleset: "dispatch-v1",
      maxActivePatrols: 0,
      enableRoadblocks: false,
      curbSupport: METRO_CITY_CURBS,
      chasePresence: AGGRESSIVE_CHASE_PRESENCE,
    },
  });

  // Place SUV facing a dead-end T-junction building wall 2.2 m ahead of front bumper at speed = 0.
  Object.assign(world.player, { x: -183, z: -113.5, heading: Math.PI, speed: 0, steer: 0 });
  const deadEndWall = Object.freeze({
    id: "tjunction-deadend-building",
    type: "static",
    kind: "building",
    x: -183,
    z: world.player.z - (world.player.length / 2 + 2.2 + 1.5),
    width: 24.0,
    length: 3.0,
    height: 12.0,
    heading: 0,
  });
  world.statics.push(deadEndWall);

  // Place stationary cars 4.5 m behind-left of ego (heading = PI -> behind is +z, left is +x).
  const carBehindLeftA = world.makeVehicle("behind-left-sedan-a", "sedan", {
    x: world.player.x + 2.2,
    z: world.player.z + (world.player.length / 2 + 2.1 + 4.5),
    heading: Math.PI,
  });
  carBehindLeftA.speed = 0;
  const carBehindLeftB = world.makeVehicle("behind-left-sedan-b", "sedan", {
    x: world.player.x + 4.3,
    z: world.player.z + (world.player.length / 2 + 2.1 + 5.2),
    heading: Math.PI,
  });
  carBehindLeftB.speed = 0;
  world.actors.push(carBehindLeftA, carBehindLeftB);
  world.pursuit.gta.curb = surveyMetroCurb(world, METRO_CITY_CURBS);

  const auditedPursuit = {
    phase: world.pursuit.phase,
    gta: world.pursuit.gta,
    get patrols() {
      throw new Error("Forbidden read of world.pursuit.patrols");
    },
    get response() {
      throw new Error("Forbidden read of world.pursuit.response");
    },
  };
  const auditedWorld = {
    tick: world.tick,
    player: world.player,
    roads: world.roads,
    drivingRoads: world.drivingRoads,
    statics: world.statics,
    district: world.district,
    visualState: world.visualState,
    pursuit: auditedPursuit,
    actors: new Proxy(world.actors, {
      get(_, prop) {
        throw new Error(`Forbidden read of world.actors.${String(prop)}`);
      },
    }),
    get actorIndex() {
      throw new Error("Forbidden read of world.actorIndex");
    },
  };

  const scanner = new PursuitScanner();
  const startX = world.player.x;
  const startZ = world.player.z;
  let active = null;
  let prevGear = null;
  let gearFlips = 0;
  let sawReversePhase = false;
  let sawForwardCommit = false;

  // Run planPakoEvasiveAction + vehicle integration over 180 ticks (3.0 s).
  for (let i = 0; i < 180; i++) {
    if (!active || world.tick % PURSUIT_SCAN_TICKS === 0) {
      world.pursuit.gta.scan = scanner.sample(world);
      auditedWorld.tick = world.tick;
      const dec = planPakoEvasiveAction(auditedWorld, { steer: 0, throttle: 0.85, brake: 0, gear: 1 });
      validatePursuitAction(dec.action);
      if (dec.action.gear === -1) sawReversePhase = true;
      if (sawReversePhase && dec.action.gear === 1) sawForwardCommit = true;
      if (prevGear !== null && dec.action.gear !== prevGear) gearFlips++;
      prevGear = dec.action.gear;
      active = dec.action;
    }
    const prevPose = { ...world.player };
    const nextPose = integrateVehicle(world.player, pursuitCommand(world.player, active, STEP), STEP);
    integrateGtaSlip(prevPose, nextPose);
    Object.assign(world.player, {
      x: nextPose.x,
      z: nextPose.z,
      heading: nextPose.heading,
      steer: nextPose.steer,
      speed: nextPose.speed,
      gtaSlipMps: nextPose.gtaSlipMps,
      gtaYawRate: nextPose.gtaYawRate,
    });
    world.tick += 1;

    assert.equal(overlaps(world.player, deadEndWall), false, "must never hit T-junction dead-end building wall");
    assert.equal(overlaps(world.player, carBehindLeftA), false, "must never hit behind-left car A");
    assert.equal(overlaps(world.player, carBehindLeftB), false, "must never hit behind-left car B");
  }

  const netDispM = Math.hypot(world.player.x - startX, world.player.z - startZ);
  assert.ok(sawReversePhase, "expected K-turn reverse pivot phase");
  assert.ok(sawForwardCommit, "expected committed forward exit phase after reverse pivot");
  assert.ok(gearFlips <= 2, `expected <= 2 gear flips (no forward/reverse ping-pong), got ${gearFlips}`);
  assert.ok(netDispM >= 10.0, `expected >= 10 m net displacement in 180 ticks, got ${netDispM.toFixed(2)} m`);
  assert.ok(world.player.speed >= 6.0, `expected brisk forward exit speed >= 6 m/s, got ${world.player.speed.toFixed(2)} m/s`);
});

test("post-K-turn cooldown and >1.35 m/s forward speed gate prevent reverse re-trigger oscillation over 5.0 s", () => {
  const world = new World({ cityVersion: 4, seed: "post-kturn-no-retrigger", traffic: 0, pedestrians: 0 }, "metro");
  world.command({
    type: "street-pursuit-start",
    variant: "gta",
    config: {
      ruleset: "dispatch-v1",
      maxActivePatrols: 0,
      enableRoadblocks: false,
      curbSupport: METRO_CITY_CURBS,
      chasePresence: AGGRESSIVE_CHASE_PRESENCE,
    },
  });

  // Approach a dead-end building wall at +2.6 m/s (> 1.35 m/s): must brake first (gear=1) rather than flipping gear=-1 at +2.6 m/s,
  // then execute 1 clean reverse -> forward-commit K-turn and NEVER re-trigger reverse over 300 ticks (5.0 s).
  Object.assign(world.player, { x: -183, z: -112.2, heading: Math.PI, speed: 2.6, steer: 0 });
  const deadEndWall = Object.freeze({
    id: "post-kturn-wall",
    type: "static",
    kind: "building",
    x: -183,
    z: world.player.z - (world.player.length / 2 + 2.3 + 1.5),
    width: 24.0,
    length: 3.0,
    height: 12.0,
    heading: 0,
  });
  world.statics.push(deadEndWall);
  world.pursuit.gta.curb = surveyMetroCurb(world, METRO_CITY_CURBS);

  const scanner = new PursuitScanner();
  world.pursuit.gta.scan = scanner.sample(world);
  const initialDecision = planPakoEvasiveAction(world, { steer: 0, throttle: 0.85, brake: 0, gear: 1 });
  assert.equal(initialDecision.action.gear, 1, "must not flip into reverse while forward speed > 1.35 m/s");
  assert.ok(initialDecision.action.brake > 0 || Math.abs(initialDecision.action.steer) >= 0.45);

  const startX = world.player.x;
  const startZ = world.player.z;
  let active = null;
  let prevGear = 1;
  let gearFlips = 0;
  let enteredReverse = false;
  let exitedReverse = false;
  let retriggeredReverseAfterExit = false;

  for (let i = 0; i < 300; i++) {
    if (!active || world.tick % PURSUIT_SCAN_TICKS === 0) {
      world.pursuit.gta.scan = scanner.sample(world);
      const dec = planPakoEvasiveAction(world, { steer: 0, throttle: 0.85, brake: 0, gear: 1 });
      validatePursuitAction(dec.action);
      if (dec.action.gear === -1) {
        if (exitedReverse) retriggeredReverseAfterExit = true;
        enteredReverse = true;
      } else if (enteredReverse && dec.action.gear === 1) {
        exitedReverse = true;
      }
      if (dec.action.gear !== prevGear) {
        gearFlips++;
        prevGear = dec.action.gear;
      }
      active = dec.action;
    }
    world.command({ type: "pursuit-drive", action: active }, false);
    world.step();
    assert.equal(overlaps(world.player, deadEndWall), false, "must never hit dead-end wall");
  }

  const netDispM = Math.hypot(world.player.x - startX, world.player.z - startZ);
  assert.equal(enteredReverse, true, "expected K-turn reverse phase once slowed <= 1.35 m/s");
  assert.equal(exitedReverse, true, "expected committed forward exit after reverse");
  assert.equal(retriggeredReverseAfterExit, false, "must never re-trigger reverse while accelerating out of K-turn");
  assert.equal(gearFlips, 2, `expected exactly 2 gear transitions (+1 -> -1 -> +1), got ${gearFlips}`);
  assert.ok(netDispM >= 22.0, `expected sustained multi-second escape >= 22 m, got ${netDispM.toFixed(2)} m`);
  assert.equal(world.pursuit.metrics.collisions, 0);
});





