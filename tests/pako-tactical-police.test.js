import assert from "node:assert/strict";
import test from "node:test";
import { VEHICLE } from "../src/core/config.js";
import { initializeDistrictActor } from "../src/core/district-behavior.js";
import { planDistrictRoute } from "../src/core/district-navigation.js";
import {
  bodyOnRoad,
  distance,
  makeDiagonalRoad,
  overlaps,
  pointOnRoad,
  roadPoseAt,
} from "../src/core/geometry.js";
import {
  AGGRESSIVE_CHASE_PRESENCE,
  aggressivePatrolPace,
  aggressiveSquadCap,
  recycleTrailingChasePatrols,
} from "../src/core/pako-aggressive-police.js";
import { METRO_CITY_CURBS, surveyMetroCurb } from "../src/core/pako-curb.js";
import {
  TACTICAL_PURSUIT_MODE,
  canDrivePrivilegedDirect,
  canPatrolUseCurbPrivilege,
  isTacticalPatrolPoseSupported,
  isTacticalPursuit,
  resolveTacticalRoadAim,
  selectTacticalSearchTarget,
  tacticalPatrolPace,
  tacticalPatrolSpec,
  tacticalSquadCap,
  tacticalTrafficOvertake,
} from "../src/core/pako-tactical-police.js";
import { SpatialIndex } from "../src/core/spatial-index.js";
import { PATROL_TRAFFIC_PREVIEW } from "../src/core/pursuit-gta.js";
import { World } from "../src/core/world.js";

const SUV_MAX_SPEED_MPS = 32.0;

function makeGrandCityV5TacticalWorld() {
  const world = new World({ cityVersion: 5, traffic: 0, pedestrians: 0, seed: "tactical-v5" }, "metro");
  const curb = surveyMetroCurb(world, METRO_CITY_CURBS);
  assert.ok(curb, "expected surveyed METRO_CITY_CURBS on Grand Metro City v5");
  world.pursuit = {
    phase: "running",
    wantedLevel: 3,
    tacticalPursuit: TACTICAL_PURSUIT_MODE,
    patrols: new Set(),
    response: {
      unitsInContact: 1,
      sightedBy: new Set(),
      dispatch: { state: "VISUALLY_SPOTTED" },
    },
    gta: {
      curb,
      config: {
        ruleset: "dispatch-v1",
        chasePresence: AGGRESSIVE_CHASE_PRESENCE,
        tacticalPursuit: TACTICAL_PURSUIT_MODE,
        curbSupport: METRO_CITY_CURBS,
        npcSpeedMultiplier: 1,
        maxActivePatrols: 14,
      },
    },
  };
  return { world, curb };
}

test("1. tacticalPatrolSpec, tacticalSquadCap & tacticalPatrolPace outpace 32 m/s SUV while preserving legacy aggressive caps", () => {
  assert.equal(TACTICAL_PURSUIT_MODE, "gta-tactical-v1");
  assert.equal(isTacticalPursuit({ tacticalPursuit: TACTICAL_PURSUIT_MODE }), true);
  assert.equal(isTacticalPursuit({ gta: { config: { tacticalPursuit: TACTICAL_PURSUIT_MODE } } }), true);
  assert.equal(isTacticalPursuit({ tacticalPursuit: "legacy" }), false);
  assert.equal(isTacticalPursuit(null), false);

  // Squad cap escalation across wanted levels 1..5
  assert.deepEqual(
    [1, 2, 3, 4, 5].map((star) => tacticalSquadCap(star)),
    [4, 6, 8, 11, 14],
  );
  assert.equal(tacticalSquadCap(5, 10), 10);
  assert.equal(tacticalSquadCap(0, 14), 4);
  assert.equal(
    aggressiveSquadCap({ wantedLevel: 4, tacticalPursuit: TACTICAL_PURSUIT_MODE, gta: { config: { maxActivePatrols: 14 } } }),
    11,
  );
  assert.equal(
    aggressiveSquadCap({ wantedLevel: 4, gta: { config: { maxActivePatrols: 12 } } }),
    9,
  );

  // Patrol & interceptor exceed 32.0 m/s SUV maxSpeed at every wanted level 1..5 and scale monotonically
  let prevPatrolSpeed = 0;
  let prevInterceptorSpeed = 0;
  let prevSwatSpeed = 0;
  for (let level = 1; level <= 5; level++) {
    const patrol = tacticalPatrolSpec("patrol", level, 1);
    const interceptor = tacticalPatrolSpec("interceptor", level, 1);
    const swat = tacticalPatrolSpec("swat", level, 1);

    assert.ok(patrol.maxSpeed >= 33.5 && patrol.maxSpeed > SUV_MAX_SPEED_MPS);
    assert.ok(interceptor.maxSpeed >= 36.0 && interceptor.maxSpeed > patrol.maxSpeed);
    assert.ok(swat.maxSpeed >= 29.2 && swat.maxSpeed <= 30.81);

    assert.ok(patrol.maxSpeed > prevPatrolSpeed);
    assert.ok(interceptor.maxSpeed > prevInterceptorSpeed);
    assert.ok(swat.maxSpeed > prevSwatSpeed);

    prevPatrolSpeed = patrol.maxSpeed;
    prevInterceptorSpeed = interceptor.maxSpeed;
    prevSwatSpeed = swat.maxSpeed;
  }

  const p1 = tacticalPatrolSpec("patrol", 1);
  const p5 = tacticalPatrolSpec("patrol", 5);
  assert.ok(Math.abs(p1.maxSpeed - 33.55) < 1e-9);
  assert.ok(Math.abs(p5.maxSpeed - 35.35) < 1e-9);
  assert.equal(p1.acceleration, 7.6);
  assert.equal(p1.braking, 10.6);
  assert.equal(p1.steerRate, 2.45);
  assert.equal(p1.wheelbase, VEHICLE.wheelbase);
  assert.equal(p1.reverseSpeed, 7.0);

  const i1 = tacticalPatrolSpec("interceptor", 1);
  const i5 = tacticalPatrolSpec("interceptor", 5);
  assert.ok(Math.abs(i1.maxSpeed - 36.0) < 1e-9);
  assert.ok(Math.abs(i5.maxSpeed - 38.0) < 1e-9);
  assert.equal(i1.acceleration, 8.8);
  assert.equal(i1.braking, 11.4);
  assert.equal(i1.steerRate, 2.75);
  assert.equal(i1.reverseSpeed, 7.5);

  const swat5 = tacticalPatrolSpec("swat", 5);
  assert.ok(Math.abs(swat5.maxSpeed - 30.8) < 1e-9);
  assert.equal(swat5.wheelbase, 3.15);

  // Unknown unitType falls back to patrol; npcSpeedMultiplier scales maxSpeed
  assert.deepEqual(tacticalPatrolSpec("unknown-cruiser", 3, 1.1), tacticalPatrolSpec("patrol", 3, 1.1));

  // tacticalPatrolPace range bands: >26 (100% catch-up), 11..26 (closing), <=11 (boxing/intercept)
  const tacPursuit = { wantedLevel: 4, tacticalPursuit: TACTICAL_PURSUIT_MODE };
  const cruiser = { maxSpeed: 37.5, squadRole: "PRIMARY_CHASER", aiState: "PURSUIT" };
  assert.equal(tacticalPatrolPace(tacPursuit, cruiser, 32, 30), 37.5);
  const midPace = tacticalPatrolPace(tacPursuit, cruiser, 24, 18);
  assert.ok(midPace >= 37.5 * 0.9 && midPace <= 37.5);

  const closeChase = tacticalPatrolPace(tacPursuit, cruiser, 18, 8);
  const closeBlock = tacticalPatrolPace(tacPursuit, { ...cruiser, squadRole: "BLOCK" }, 18, 8);
  const closeIntercept = tacticalPatrolPace(tacPursuit, { ...cruiser, aiState: "INTERCEPT" }, 18, 8);
  assert.equal(closeChase, 23.2);
  assert.equal(closeBlock, 22.5);
  assert.equal(closeIntercept, 22.5);

  // Delegation from aggressivePatrolPace under TACTICAL_PURSUIT_MODE vs legacy caps when unset
  assert.equal(aggressivePatrolPace(tacPursuit, cruiser, 32, 40), 37.5);
  const legacyPursuitLv1 = {
    wantedLevel: 1,
    gta: { config: { ruleset: "dispatch-v1", chasePresence: AGGRESSIVE_CHASE_PRESENCE, npcSpeedMultiplier: 1 } },
  };
  const legacyPursuitLv5 = {
    wantedLevel: 5,
    gta: { config: { ruleset: "dispatch-v1", chasePresence: AGGRESSIVE_CHASE_PRESENCE, npcSpeedMultiplier: 1 } },
  };
  assert.equal(aggressivePatrolPace(legacyPursuitLv1, cruiser, 32, 40), 17.5);
  assert.equal(aggressivePatrolPace(legacyPursuitLv5, cruiser, 32, 40), 24.8);
});

test("2. canDrivePrivilegedDirect cuts across opposing lanes, curbs & courtyards when clear, rejects buildings, and strictly protects pedestrians (>= 1.25 m)", () => {
  const { world } = makeGrandCityV5TacticalWorld();

  // Controlled block on Grand Metro City v5 curb/courtyard framework
  const avenue = { id: "tac-avenue-x", axis: "x", fixed: 0, min: -120, max: 120, width: 14, laneOffsetM: 2.7, zone: "avenue" };
  const northStreet = { id: "tac-north-x", axis: "x", fixed: 60, min: -120, max: 120, width: 12, laneOffsetM: 2.2 };
  const westStreet = { id: "tac-west-z", axis: "z", fixed: -80, min: -40, max: 80, width: 12, laneOffsetM: 2.2 };
  const eastStreet = { id: "tac-east-z", axis: "z", fixed: 80, min: -40, max: 80, width: 12, laneOffsetM: 2.2 };

  world.drivingRoads = [avenue, northStreet, westStreet, eastStreet];
  world.roads = [...world.drivingRoads];
  world.statics = [];
  world.actors = [world.player];
  world.staticIndex = new SpatialIndex(world.statics);
  world.actorIndex = new SpatialIndex(world.actors);
  world.pursuit.gta.curb = surveyMetroCurb(world, METRO_CITY_CURBS);
  assert.ok(world.pursuit.gta.curb, "expected curb sites + courtyard on block");

  const car = {
    id: "patrol-direct-1",
    type: "vehicle",
    x: -10,
    z: -2.7,
    heading: Math.atan2(12, 22), // diagonal across opposing lane, curb & into open courtyard
    width: 1.85,
    length: 4.2,
    gtaAI: { order: 0 },
    aiState: "PURSUIT",
  };
  assert.equal(canPatrolUseCurbPrivilege(world, car), true);
  assert.equal(canPatrolUseCurbPrivilege(world, { ...car, gtaRoadblock: true }), false);
  assert.equal(canPatrolUseCurbPrivilege(world, { ...car, aiState: "WRECKED" }), false);

  const courtyardAim = { x: 2, z: 19.3 }; // z = 19.3 is well beyond road edge z = 7, inside open courtyard!
  assert.equal(pointOnRoad(courtyardAim, world.drivingRoads), false);
  assert.equal(isTacticalPatrolPoseSupported(world, { ...courtyardAim, heading: car.heading, width: 1.85, length: 4.2 }), true);
  assert.equal(canDrivePrivilegedDirect(world, car, courtyardAim), true);

  // Without curb support, cutting off-road into the courtyard must be rejected
  const noCurbWorld = {
    ...world,
    pursuit: { ...world.pursuit, gta: { ...world.pursuit.gta, curb: null } },
  };
  assert.equal(canDrivePrivilegedDirect(noCurbWorld, car, courtyardAim), false);

  // Building blocking the courtyard shortcut must reject direct drive (even for large SpatialIndex buildings)
  const blockingBuilding = {
    id: "courtyard-tower",
    type: "static",
    kind: "building",
    x: -2,
    z: 24,
    width: 28,
    length: 26,
    heading: 0,
  };
  world.statics = [blockingBuilding];
  world.staticIndex = new SpatialIndex(world.statics);
  assert.equal(canDrivePrivilegedDirect(world, car, courtyardAim), false);

  // Remove building -> path is clear again
  world.statics = [];
  world.staticIndex = new SpatialIndex(world.statics);
  assert.equal(canDrivePrivilegedDirect(world, car, courtyardAim), true);

  // STRICT PEDESTRIAN SAFETY: pedestrian within 1.25 m of swept probe box MUST reject!
  const midX = car.x + (courtyardAim.x - car.x) * 0.5;
  const midZ = car.z + (courtyardAim.z - car.z) * 0.5;
  const perpX = Math.cos(car.heading);
  const perpZ = -Math.sin(car.heading);

  // Lateral offset 1.8m from centerline -> gap = 1.8 - (1.85/2) - 0.30 = 0.575 m (< 1.25 m) -> REJECT!
  const closePedByType = {
    id: "ped-close-type",
    type: "pedestrian",
    kind: "man-polo",
    x: midX + perpX * 1.8,
    z: midZ + perpZ * 1.8,
    radius: 0.3,
  };
  world.actors = [world.player, closePedByType];
  world.actorIndex = new SpatialIndex(world.actors);
  assert.equal(canDrivePrivilegedDirect(world, car, courtyardAim), false);

  // Also test synthetic actor with kind === "pedestrian"
  const closePedByKind = {
    id: "ped-close-kind",
    kind: "pedestrian",
    x: midX - perpX * 1.9,
    z: midZ - perpZ * 1.9,
    radius: 0.3,
  };
  world.actors = [world.player, closePedByKind];
  world.actorIndex = new SpatialIndex(world.actors);
  assert.equal(canDrivePrivilegedDirect(world, car, courtyardAim), false);

  // Pedestrian far clear (lateral offset 3.4m -> gap = 3.4 - 0.925 - 0.30 = 2.175 m >= 1.25 m) -> ALLOW!
  const safePed = {
    id: "ped-safe",
    type: "pedestrian",
    kind: "woman-shirt",
    x: midX + perpX * 3.4,
    z: midZ + perpZ * 3.4,
    radius: 0.3,
  };
  world.actors = [world.player, safePed];
  world.actorIndex = new SpatialIndex(world.actors);
  assert.equal(canDrivePrivilegedDirect(world, car, courtyardAim), true);

  // Civilian traffic blocking path: rejected by default, allowed when avoidTraffic === false
  const trafficBlocker = {
    id: "civ-1",
    type: "vehicle",
    x: midX,
    z: midZ,
    heading: 0,
    width: 1.85,
    length: 4.2,
  };
  world.actors = [world.player, trafficBlocker];
  world.actorIndex = new SpatialIndex(world.actors);
  assert.equal(canDrivePrivilegedDirect(world, car, courtyardAim), false);
  assert.equal(canDrivePrivilegedDirect(world, car, courtyardAim, { avoidTraffic: false }), true);
});

test("3. resolveTacticalRoadAim snaps off-road alley/courtyard targets to downstream exit road mouth along velocity and unlocks planDistrictRoute", () => {
  const { world } = makeGrandCityV5TacticalWorld();

  // Pick a real interior courtyard spot between two parallel horizontal roads in Grand City v5
  // Also test on both an explicit Grand City v5 alley block AND a diagonal exit avenue
  const southRoad = { id: "alley-south-road", axis: "x", fixed: -40, min: -80, max: 80, width: 12, laneOffsetM: 2.2 };
  const northRoad = { id: "alley-north-road", axis: "x", fixed: 40, min: -80, max: 80, width: 12, laneOffsetM: 2.2 };
  const westRoad = { id: "alley-west-road", axis: "z", fixed: -60, min: -40, max: 40, width: 12, laneOffsetM: 2.2 };
  const eastDiag = makeDiagonalRoad({
    id: "alley-east-diag",
    x1: 50,
    z1: -40,
    x2: 80,
    z2: 40,
    width: 12,
    laneOffsetM: 2.2,
  });

  const alleyWestBuilding = { id: "bldg-left", type: "static", kind: "building", x: -22, z: 0, width: 24, length: 56, heading: 0 };
  const alleyEastBuilding = { id: "bldg-right", type: "static", kind: "building", x: 22, z: 0, width: 24, length: 56, heading: 0 };

  const blockWorld = {
    metro: true,
    drivingRoads: [southRoad, northRoad, westRoad, eastDiag],
    roads: [southRoad, northRoad, westRoad, eastDiag],
    statics: [alleyWestBuilding, alleyEastBuilding],
    staticIndex: new SpatialIndex([alleyWestBuilding, alleyEastBuilding]),
  };

  const patrol = {
    id: "patrol-router",
    type: "vehicle",
    ...roadPoseAt(westRoad, 0, 1),
    width: 1.85,
    length: 4.2,
    spec: { wheelbase: VEHICLE.wheelbase, maxSteer: VEHICLE.maxSteer },
  };

  // On-road clear aim returns unsnapped immediately
  const onRoadAim = { x: 0, z: -37.8, heading: Math.PI / 2 };
  const kept = resolveTacticalRoadAim(blockWorld, patrol, onRoadAim);
  assert.deepEqual(kept, { x: onRoadAim.x, z: onRoadAim.z, snapped: false, roadId: null });

  // Off-road SUV at (0, -4) cutting NORTH (vx = 0, vz = 20) through the alley between buildings:
  // Even though (0, -4) is closer to southRoad (z = -40, 36m away) than northRoad (z = +40, 44m away),
  // velocity alignment routes police to the NORTHERN exit mouth (alley-north-road)!
  const offRoadNorthCut = { x: 0, z: -4 };
  assert.equal(pointOnRoad(offRoadNorthCut, blockWorld.drivingRoads), false);
  // Raw planDistrictRoute fails on the off-road courtyard point:
  assert.equal(planDistrictRoute(blockWorld, patrol, { ...offRoadNorthCut, heading: 0 }).length, 0);

  const snappedNorth = resolveTacticalRoadAim(blockWorld, patrol, offRoadNorthCut, { vx: 0, vz: 20 });
  assert.equal(snappedNorth.snapped, true);
  assert.equal(snappedNorth.roadId, "alley-north-road");
  assert.ok(pointOnRoad(snappedNorth, [northRoad], 0.2));
  assert.equal(
    blockWorld.statics.some((st) => overlaps({ ...snappedNorth, width: 1.9, length: 4.5 }, st, 0.22)),
    false,
  );

  // planDistrictRoute now succeeds cleanly to the resolved northern exit mouth!
  const plannedPath = planDistrictRoute(blockWorld, patrol, snappedNorth);
  assert.ok(plannedPath.length >= 3, `expected non-empty route to snapped mouth, got ${plannedPath.length}`);

  // Cutting SOUTH (vx = 0, vz = -20) from (0, +4) snaps to the SOUTHERN exit mouth instead!
  const snappedSouth = resolveTacticalRoadAim(blockWorld, patrol, { x: 0, z: 4 }, { vx: 0, vz: -20 });
  assert.equal(snappedSouth.snapped, true);
  assert.equal(snappedSouth.roadId, "alley-south-road");

  // Cutting EAST-NORTHEAST toward the diagonal road snaps cleanly onto alley-east-diag!
  const nearDiagCut = { x: 42, z: -2, vx: 18, vz: 6 };
  const snappedDiag = resolveTacticalRoadAim(blockWorld, patrol, nearDiagCut);
  assert.equal(snappedDiag.snapped, true);
  assert.equal(snappedDiag.roadId, "alley-east-diag");
  assert.ok(pointOnRoad(snappedDiag, [eastDiag], 0.2));

  // Empty-roads fallback preserves aim safely
  assert.deepEqual(
    resolveTacticalRoadAim({ drivingRoads: [], roads: [] }, patrol, offRoadNorthCut, { vx: 0, vz: 20 }),
    { x: offRoadNorthCut.x, z: offRoadNorthCut.z, snapped: false, roadId: null },
  );

  // Verify on actual Grand Metro City v5 road/static network as well
  const v5OffRoad = { x: -135, z: -72, vx: 0, vz: 22 };
  const v5Patrol = { ...world.player, width: 1.85, length: 4.2 };
  const v5Resolved = resolveTacticalRoadAim(world, v5Patrol, v5OffRoad);
  assert.ok(pointOnRoad(v5Resolved, world.drivingRoads, 0.1));
  if (!pointOnRoad(v5OffRoad, world.drivingRoads, 0.25)) {
    assert.equal(v5Resolved.snapped, true);
    assert.ok(v5Resolved.roadId);
  }
});

test("4. tacticalTrafficOvertake breaks lanes & mounts curbs around slow traffic/parked cars at speed, yet returns null near pedestrians", () => {
  const road = { id: "overtake-road", axis: "z", fixed: 0, min: -80, max: 120, width: 10, laneOffsetM: 2.0, zone: "avenue" };
  const world = new World({ cityVersion: 5, traffic: 0, pedestrians: 0, seed: "overtake-v5" }, "metro");
  world.drivingRoads = [road];
  world.roads = [road];
  world.statics = [];
  world.staticIndex = new SpatialIndex(world.statics);
  world.pursuit = {
    phase: "running",
    wantedLevel: 4,
    tacticalPursuit: TACTICAL_PURSUIT_MODE,
    patrols: new Set(),
    gta: {
      curb: surveyMetroCurb(world, METRO_CITY_CURBS),
      config: { tacticalPursuit: TACTICAL_PURSUIT_MODE },
    },
  };

  const spec = tacticalPatrolSpec("interceptor", 4);
  const car = {
    id: "patrol-overtaker",
    type: "vehicle",
    x: -2.0,
    z: 0,
    heading: 0,
    steer: 0,
    speed: 18,
    maxSpeed: spec.maxSpeed,
    width: 1.85,
    length: 4.2,
    spec,
    gtaAI: { order: 0 },
    aiState: "PURSUIT",
  };

  // Clear road ahead -> returns null (keep normal baseSteer)
  world.actors = [world.player, car];
  world.actorIndex = new SpatialIndex(world.actors);
  assert.equal(tacticalTrafficOvertake(world, car, 0, 32), null);

  // Slow civilian car 20m ahead in same lane (-2.0): patrol overtakes cleanly via 1:1 integrateVehicle S-curve!
  const slowCivilian = {
    id: "civ-slow",
    type: "vehicle",
    x: -2.0,
    z: 20.0,
    heading: 0,
    speed: 2.0,
    width: 1.85,
    length: 4.2,
  };
  world.actors = [world.player, car, slowCivilian];
  world.actorIndex = new SpatialIndex(world.actors);

  const laneOvertake = tacticalTrafficOvertake(world, car, 0, 32);
  assert.ok(laneOvertake, "expected lane-breaking/curb overtake around slow civilian");
  assert.equal(laneOvertake.reason, "tactical-overtake");
  assert.ok(
    Math.abs(laneOvertake.steer) > 0.05 && Math.abs(laneOvertake.steer) <= VEHICLE.maxSteer,
    `expected valid integrateVehicle swerve steer, got ${laneOvertake.steer}`,
  );
  assert.ok(laneOvertake.targetSpeed >= 24, `expected high overtake speed, got ${laneOvertake.targetSpeed}`);

  // Block oncoming lane (+1.5) as well so ONLY sidewalk curb-mounting on left (-5.0..-7.38) is open!
  const oncomingBlocker = {
    id: "civ-oncoming",
    type: "vehicle",
    x: 1.5,
    z: 19.5,
    heading: Math.PI,
    speed: 0,
    width: 1.95,
    length: 4.5,
  };
  world.actors = [world.player, car, slowCivilian, oncomingBlocker];
  world.actorIndex = new SpatialIndex(world.actors);

  const curbOvertake = tacticalTrafficOvertake(world, car, 0, 30);
  assert.ok(curbOvertake, "expected curb-mounting overtake on METRO_CITY_CURBS sidewalk when oncoming lane is blocked");
  assert.ok(curbOvertake.steer < 0, `expected left swerve onto negative-x sidewalk, got ${curbOvertake.steer}`);
  assert.equal(curbOvertake.reason, "tactical-overtake");

  // Sidewalk pedestrian on left (< 1.45 m from left curb-mount arc, though clear of baseSteer = 0) MUST reject mounting left sidewalk,
  // and when pedestrians occupy both sidewalks while lanes are blocked, tacticalTrafficOvertake MUST return null!
  const leftSidewalkPed = {
    id: "ped-sidewalk-left",
    type: "pedestrian",
    kind: "man-jacket",
    x: -5.5,
    z: 16.5,
    radius: 0.3,
  };
  const rightSidewalkPed = {
    id: "ped-sidewalk-right",
    type: "pedestrian",
    kind: "woman-shirt",
    x: 5.5,
    z: 16.5,
    radius: 0.3,
  };
  world.actors = [world.player, car, slowCivilian, oncomingBlocker, leftSidewalkPed];
  world.actorIndex = new SpatialIndex(world.actors);
  const reroutedAwayFromLeftPed = tacticalTrafficOvertake(world, car, 0, 30);
  assert.ok(reroutedAwayFromLeftPed === null || reroutedAwayFromLeftPed.steer > 0, "must never mount left sidewalk near leftSidewalkPed");

  world.actors = [world.player, car, slowCivilian, oncomingBlocker, leftSidewalkPed, rightSidewalkPed];
  world.actorIndex = new SpatialIndex(world.actors);
  assert.equal(
    tacticalTrafficOvertake(world, car, 0, 30),
    null,
    "must never mount any sidewalk within 1.45 m of a pedestrian",
  );

  // Restore actors without sidewalk pedestrian before no-curb check
  world.actors = [world.player, car, slowCivilian, oncomingBlocker];
  world.actorIndex = new SpatialIndex(world.actors);

  // Without curb privilege/network, mounting the sidewalk when oncoming lane is blocked is rejected
  const noCurbWorld = {
    ...world,
    pursuit: { ...world.pursuit, gta: { ...world.pursuit.gta, curb: null } },
  };
  assert.equal(tacticalTrafficOvertake(noCurbWorld, car, 0, 30), null);

  // Parked-vehicle static blocker within 30m ahead also triggers tactical overtake when clear
  world.actors = [world.player, car];
  world.actorIndex = new SpatialIndex(world.actors);
  const parkedVan = {
    id: "parked-van-1",
    type: "static",
    kind: "parked-vehicle",
    x: -2.0,
    z: 22.0,
    heading: 0,
    width: 1.9,
    length: 4.5,
  };
  world.statics = [parkedVan];
  world.staticIndex = new SpatialIndex(world.statics);
  const parkedOvertake = tacticalTrafficOvertake(world, car, 0, 28);
  assert.ok(parkedOvertake && parkedOvertake.reason === "tactical-overtake");

  // STRICT PEDESTRIAN SAFETY: pedestrian near forward path (< 1.45 m) MUST immediately return null!
  const crossingPedestrian = {
    id: "ped-crossing",
    type: "pedestrian",
    kind: "woman-jacket",
    x: -0.9,
    z: 10.5,
    radius: 0.3,
  };
  world.actors = [world.player, car, slowCivilian, crossingPedestrian];
  world.actorIndex = new SpatialIndex(world.actors);
  world.statics = [];
  world.staticIndex = new SpatialIndex(world.statics);
  assert.equal(
    tacticalTrafficOvertake(world, car, 0, 30),
    null,
    "must refuse aggressive overtake and return null when pedestrian is within 1.45 m of forward path",
  );
});

test("5. selectTacticalSearchTarget fans across road branches without reading world.player & recycleTrailingChasePatrols refuses to cheat-teleport when unitsInContact === 0", () => {
  const { world } = makeGrandCityV5TacticalWorld();
  world.tick = 360;

  // Build an audited world factory whose `player` getter throws immediately if touched!
  const makeHonestSearchWorld = (tickValue) => ({
    tick: tickValue,
    drivingRoads: world.drivingRoads,
    roads: world.roads,
    statics: world.statics,
    staticIndex: world.staticIndex,
    get player() {
      throw new Error("CHEAT DETECTED: selectTacticalSearchTarget must NEVER read world.player!");
    },
  });
  const honestSearchWorld = makeHonestSearchWorld(360);

  const lastSeen = {
    x: -175,
    z: -112,
    vx: 19,
    vz: 0,
    speed: 19,
    heading: Math.PI / 2,
    lastSeenTick: 180, // 3.0s ago
  };

  const patrolProbe = { x: -210, z: -112, heading: Math.PI / 2, width: 1.85, length: 4.2 };
  const targets = Array.from({ length: 8 }, (_, idx) =>
    selectTacticalSearchTarget(honestSearchWorld, patrolProbe, lastSeen, idx),
  );

  // Every search target lies on a valid road, respects radius bounds [22, 145], and fans out across multiple roads/headings
  for (const t of targets) {
    assert.ok(t.radius >= 22 && t.radius <= 145, `unexpected search radius ${t.radius}`);
    assert.ok(Number.isFinite(t.x) && Number.isFinite(t.z) && Number.isFinite(t.heading));
    assert.ok(pointOnRoad(t, world.drivingRoads, 0.15), `expected search target (${t.x}, ${t.z}) on road`);
  }
  const uniqueRoadIds = new Set(targets.map((t) => t.roadId).filter(Boolean));
  assert.ok(uniqueRoadIds.size >= 3, `expected multi-branch fan across >= 3 roads, got ${uniqueRoadIds.size}`);
  const uniqueFanAngles = new Set(targets.map((t) => t.fanAngle));
  assert.equal(uniqueFanAngles.size, 8);

  // Elapsed time increases search radius up to the 5.5s expansion cap
  const earlyTarget = selectTacticalSearchTarget(makeHonestSearchWorld(195), patrolProbe, lastSeen, 0);
  const lateTarget = selectTacticalSearchTarget(makeHonestSearchWorld(480), patrolProbe, lastSeen, 0);
  assert.ok(lateTarget.radius > earlyTarget.radius);

  // CRITICAL FAIRNESS CHECK on recycleTrailingChasePatrols:
  // When isTacticalPursuit && unitsInContact === 0 (even if dispatch.state === "ZONE_TRACKED"!),
  // recycleTrailingChasePatrols MUST return false, NEVER call deploy/remove, and NEVER read world.player!
  const stuckFarPatrol = {
    id: "trailing-tac-1",
    x: world.player.x - 180,
    z: world.player.z,
    heading: world.player.heading,
    speed: 0,
    unitType: "interceptor",
    aiState: "SEARCH",
    previous: { x: world.player.x - 180, z: world.player.z, heading: world.player.heading },
    gtaAI: { order: 0, chaseFarTicks: 250, chaseStallTicks: 250, nextAggressiveRecycle: 0 },
  };
  world.pursuit.patrols = new Set([stuckFarPatrol]);
  world.pursuit.response.unitsInContact = 0;
  world.pursuit.response.dispatch.state = "ZONE_TRACKED";

  let deployCount = 0;
  let removeCount = 0;
  const auditedRecycleWorld = {
    tick: 500,
    pursuit: world.pursuit,
    get player() {
      throw new Error("CHEAT DETECTED: recycleTrailingChasePatrols read world.player while unitsInContact === 0!");
    },
  };

  const hiddenResult = recycleTrailingChasePatrols(
    auditedRecycleWorld,
    () => {
      deployCount++;
      return { id: "cheat-spawn" };
    },
    () => {
      removeCount++;
    },
  );
  assert.equal(hiddenResult, false, "must return false when isTacticalPursuit && unitsInContact === 0");
  assert.equal(deployCount, 0);
  assert.equal(removeCount, 0);
  assert.equal(stuckFarPatrol.gtaAI.chaseFarTicks, 0);
  assert.equal(stuckFarPatrol.gtaAI.chaseStallTicks, 0);

  // When unitsInContact > 0:
  // - Patrol at 100m behind (<= 135m) is NOT recycled in tactical mode
  world.pursuit.response.unitsInContact = 2;
  world.player.x = 0;
  world.player.z = 0;
  world.player.heading = Math.PI / 2;
  stuckFarPatrol.x = -100;
  stuckFarPatrol.z = 0;
  stuckFarPatrol.speed = 12;
  stuckFarPatrol.previous = { x: -100.2, z: 0, heading: Math.PI / 2 };
  stuckFarPatrol.gtaAI.chaseFarTicks = 149;
  world.tick = 600;
  assert.equal(
    recycleTrailingChasePatrols(world, () => ({ id: "no" }), () => {}),
    0,
  );
  assert.equal(stuckFarPatrol.gtaAI.chaseFarTicks, 0, "100m <= 135m must not accumulate tactical far ticks");

  // - Patrol > 135m behind (e.g. 155m) when unitsInContact > 0 IS recycled after 150 ticks
  stuckFarPatrol.x = -155;
  stuckFarPatrol.gtaAI.chaseFarTicks = 149;
  const recycled = recycleTrailingChasePatrols(
    world,
    () => {
      deployCount++;
      return { id: "legit-redeploy" };
    },
    () => {
      removeCount++;
    },
  );
  assert.equal(recycled, 1);
  assert.equal(deployCount, 1);
  assert.equal(removeCount, 1);
});

test("6. real World.step() overtakes a stopped 0 m/s civilian sedan from 24 m behind at 18 m/s on a Grand City v5 avenue with 0 collisions and no RECOVER", () => {
  const world = new World({ cityVersion: 5, traffic: 0, pedestrians: 0, seed: "tac-world-step-v5" }, "metro");
  const avenue = world.drivingRoads
    .filter((r) => r.axis === "x" && !r.parkingBay && !r.supportApron && r.width >= 12 && r.max - r.min >= 180)
    .sort((a, b) => (b.max - b.min) - (a.max - a.min))[0];
  assert.ok(avenue, "expected long Grand City v5 arterial avenue");

  const laneZ = avenue.fixed + (avenue.laneOffsetM ?? 2.7);
  const startX = avenue.min + 55;

  // Place player ahead on the same avenue moving east (+X, heading = Math.PI / 2)
  Object.assign(world.player, {
    x: startX + 85,
    z: laneZ,
    heading: Math.PI / 2,
    speed: 22,
    steer: 0,
  });
  world.player.previous = { ...world.player };

  world.command({
    type: "street-pursuit-start",
    variant: "gta",
    wantedLevel: 3,
    config: {
      ruleset: "dispatch-v1",
      chasePresence: AGGRESSIVE_CHASE_PRESENCE,
      tacticalPursuit: TACTICAL_PURSUIT_MODE,
      curbSupport: METRO_CITY_CURBS,
      patrolTrafficPreview: PATROL_TRAFFIC_PREVIEW,
      enableRoadblocks: false,
      maxActivePatrols: 1,
    },
  });

  const patrol = [...world.pursuit.patrols][0];
  assert.ok(patrol, "expected deployed tactical GTA patrol");
  Object.assign(patrol, {
    x: startX,
    z: laneZ,
    heading: Math.PI / 2,
    speed: 18,
    steer: 0,
    path: [],
    cursor: 0,
  });
  patrol.previous = { ...patrol };
  patrol.gtaAI.nextPlan = 0;

  // Stopped 0 m/s civilian sedan 24 m ahead of patrol on the exact same lane
  const stoppedCivilian = world.makeVehicle("stopped-avenue-sedan", "sedan", {
    x: startX + 24,
    z: laneZ,
    heading: Math.PI / 2,
  });
  stoppedCivilian.speed = 0;
  stoppedCivilian.maxSpeed = 0;
  initializeDistrictActor(world, stoppedCivilian);
  stoppedCivilian.district.loadingUntilTick = Infinity;
  stoppedCivilian.previous = { ...stoppedCivilian };
  world.actors.push(stoppedCivilian);
  world.actorIndex = new SpatialIndex(world.actors);

  let enteredRecover = false;
  for (let tick = 0; tick < 120; tick++) {
    world.step({ steer: 0, throttle: 0.75, brake: 0, gear: 1 });
    if (patrol.aiState === "RECOVER") enteredRecover = true;
  }

  const forwardPast = patrol.x - stoppedCivilian.x;
  assert.equal(stoppedCivilian.speed, 0, "civilian sedan must remain stopped at 0 m/s");
  assert.ok(forwardPast > 6, `expected patrol cleanly > 6 m past stopped sedan, got ${forwardPast.toFixed(2)} m`);
  assert.equal(world.pursuit.metrics.trafficCollisions, 0, "expected 0 patrol-traffic collisions");
  assert.equal(world.pursuit.metrics.collisions, 0, "expected 0 total collisions");
  assert.equal(world.pursuit.contacts.size, 0, "expected 0 physical contacts");
  assert.equal(enteredRecover, false, "patrol must never enter RECOVER during overtake");
  assert.notEqual(patrol.aiState, "RECOVER");
});
