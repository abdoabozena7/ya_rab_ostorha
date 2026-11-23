import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULTS, settings, STEP } from "../src/core/config.js";
import {
  angleDelta,
  bodyOnRoad,
  distance,
  isDiagonalRoad,
  makeDiagonalRoad,
  pointOnRoad,
  roadFrame,
  roadIntersection,
  roadPointAt,
  roadPoseAt,
  roadProject,
  roadRect,
  sweepSafe,
} from "../src/core/geometry.js";
import { createRoadGraph, planNavigation } from "../src/core/navigation.js";
import { districtTurnPaths, planDistrictRoute } from "../src/core/district-navigation.js";
import {
  avenueCrossings,
  createDistrictBehaviorState,
  districtTrafficCommand,
  initializeDistrictActor,
  nextDistrictWalk,
  onRoadLimit,
  stepDistrictPedestrian,
  updateDistrictTraffic,
} from "../src/core/district-behavior.js";
import { advanceCityEncounters, createCityEncounters } from "../src/core/city-encounters.js";
import { nextWalk, pedestrianMotion } from "../src/core/pedestrian.js";
import { Random } from "../src/core/random.js";
import { SpatialIndex } from "../src/core/spatial-index.js";
import { followPath, integrateVehicle } from "../src/core/vehicle.js";
import { PLAYER_VEHICLE } from "../src/core/vehicle-spec.js";
import { walkingWaypoint } from "../src/core/walk-route.js";

const SUV = {
  id: "player",
  type: "vehicle",
  length: PLAYER_VEHICLE.lengthM,
  width: PLAYER_VEHICLE.widthM,
  spec: { wheelbase: PLAYER_VEHICLE.wheelbaseM, maxSteer: PLAYER_VEHICLE.maxSteerRad },
  speed: 0,
  steer: 0,
  maxSpeed: DEFAULTS.speedLimit / 3.6,
};

const orthoRoad = (id, axis, fixed, min, max, width = 12, laneOffsetM = 2.5, extra = {}) => ({
  id,
  axis,
  fixed,
  min,
  max,
  width,
  laneOffsetM,
  speedLimitMps: 9.5,
  flow: 0,
  zone: "avenue",
  marking: "center",
  sideStreet: false,
  ...extra,
});

const apronAt = (id, x, z, size = 24) => ({
  id,
  axis: "z",
  fixed: x,
  min: z,
  max: z,
  width: size,
  laneOffsetM: 0,
  speedLimitMps: 6,
  flow: 0,
  zone: "avenue",
  marking: "none",
  parkingBay: true,
  supportApron: true,
  junctionX: x,
  junctionZ: z,
});

function makeDiagonalWalkways(road, sideOffset = road.width / 2 + 1.65, endInset = 7) {
  return [-1, 1].map((side) => {
    const start = roadPointAt(road, endInset, side * sideOffset);
    const len = road.length - endInset * 2;
    return {
      id: `${road.id}-walk-${side}`,
      roadId: road.id,
      axis: "diag",
      x1: start.x,
      z1: start.z,
      ux: road.ux,
      uz: road.uz,
      length: len,
      min: 0,
      max: len,
      side,
      shared: false,
      roadPreference: "avenue",
    };
  });
}

test("diagonal geometry helpers preserve orthogonal behavior and round-trip arbitrary angles", () => {
  const diag = makeDiagonalRoad({
    id: "nile-diag",
    x1: -60,
    z1: -80,
    x2: 60,
    z2: 80,
    width: 12,
    laneOffsetM: 2.5,
    speedLimitMps: 10.5,
  });
  assert.equal(isDiagonalRoad(diag), true);
  assert.equal(diag.length, 200);
  assert.ok(Math.abs(diag.ux - 0.6) < 1e-12 && Math.abs(diag.uz - 0.8) < 1e-12);
  assert.ok(Math.abs(diag.nx - 0.8) < 1e-12 && Math.abs(diag.nz - -0.6) < 1e-12);
  assert.equal(diag.min, 0);
  assert.equal(diag.max, 200);
  assert.equal(diag.fixed, 0);

  const zRoad = orthoRoad("z-ave", "z", 10, -100, 100, 12, 2.5);
  const xRoad = orthoRoad("x-ave", "x", -20, -100, 100, 12, 2.5);
  assert.equal(isDiagonalRoad(zRoad), false);
  assert.equal(isDiagonalRoad(xRoad), false);

  for (const road of [diag, zRoad, xRoad]) {
    const frame = roadFrame(road);
    assert.ok(Number.isFinite(frame.heading) && frame.length > 0);
    for (const along of [frame.minAlong + 5, (frame.minAlong + frame.maxAlong) / 2, frame.maxAlong - 7]) {
      for (const leftOffset of [-3.2, 0, 2.5]) {
        const pt = roadPointAt(road, along, leftOffset);
        const proj = roadProject(road, pt);
        assert.ok(Math.abs(proj.along - along) < 1e-10, `${road.id} along round-trip`);
        assert.ok(Math.abs(proj.leftOffset - leftOffset) < 1e-10, `${road.id} lateral round-trip`);
        assert.ok(Math.abs(proj.absLateral - Math.abs(leftOffset)) < 1e-10);
      }
    }
    const fwd = roadPoseAt(road, (frame.minAlong + frame.maxAlong) / 2, 1);
    const rev = roadPoseAt(road, (frame.minAlong + frame.maxAlong) / 2, -1);
    assert.ok(Math.abs(angleDelta(fwd.heading, frame.heading)) < 1e-12);
    assert.ok(Math.abs(Math.abs(angleDelta(rev.heading, frame.heading)) - Math.PI) < 1e-12);
    assert.ok(Math.abs(roadProject(road, fwd).leftOffset - 2.5) < 1e-10);
    assert.ok(Math.abs(roadProject(road, rev).leftOffset - -2.5) < 1e-10);
  }

  const hitXZ = roadIntersection(xRoad, zRoad);
  assert.deepEqual(hitXZ, { x: 10, z: -20, alongA: 10, alongB: -20 });

  const hitXD = roadIntersection(xRoad, diag);
  assert.ok(hitXD);
  assert.ok(Math.abs(hitXD.z - -20) < 1e-9 && Math.abs(hitXD.x - -15) < 1e-9);
  assert.ok(Math.abs(hitXD.alongA - -15) < 1e-9 && Math.abs(hitXD.alongB - 75) < 1e-9);

  const parallelDiag = makeDiagonalRoad({ id: "parallel-diag", x1: -50, z1: -80, x2: 70, z2: 80, width: 10 });
  assert.equal(roadIntersection(diag, parallelDiag), null, "parallel diagonals must not intersect");

  const shortDiag = makeDiagonalRoad({ id: "short-diag", x1: 30, z1: 30, x2: 60, z2: 60, width: 10 });
  assert.equal(roadIntersection(xRoad, shortDiag, 0.5), null, "out-of-segment intersection must be rejected");
});

test("pointOnRoad and bodyOnRoad clip oriented rectangles accurately across orthogonal+diagonal junctions", () => {
  const xRoad = orthoRoad("x-main", "x", 0, -80, 80, 12, 2.5);
  const diag45 = makeDiagonalRoad({
    id: "diag-45",
    x1: -60,
    z1: -60,
    x2: 60,
    z2: 60,
    width: 12,
    laneOffsetM: 2.5,
  });

  // Inside AABB of diag45, but far outside its actual 12m rotated corridor (negative control).
  const offCurb = { x: -30, z: 30 };
  const rect = roadRect(diag45);
  assert.ok(offCurb.x > rect.minX && offCurb.x < rect.maxX && offCurb.z > rect.minZ && offCurb.z < rect.maxZ);
  assert.equal(pointOnRoad(offCurb, [diag45]), false);
  assert.equal(bodyOnRoad({ ...SUV, ...offCurb, heading: diag45.heading }, [diag45]), false);

  // Car centered on diagonal lane is fully on road; overhanging diagonal curb by 0.4m fails.
  const onLane = roadPoseAt(diag45, 45, 1);
  assert.equal(bodyOnRoad({ ...SUV, ...onLane }, [diag45]), true);
  const overhangingCurb = roadPointAt(diag45, 45, diag45.width / 2 - SUV.width / 2 + 0.35);
  assert.equal(bodyOnRoad({ ...SUV, ...overhangingCurb, heading: diag45.heading }, [diag45]), false);

  // Car straddling the boundary where xRoad meets diag45: neither road covers 100% alone,
  // but together [xRoad, diag45] cover the entire car polygon with 0 uncovered area.
  const straddle = {
    ...SUV,
    x: 12.1,
    z: 4.8,
    heading: Math.PI / 4,
  };
  assert.equal(bodyOnRoad(straddle, [xRoad]), false, "xRoad alone cannot cover nose on diag45");
  assert.equal(bodyOnRoad(straddle, [diag45]), false, "diag45 alone cannot cover corner in xRoad");
  assert.equal(bodyOnRoad(straddle, [xRoad, diag45]), true, "union of xRoad and diag45 covers full body");
});

test("planDistrictRoute plans and physically drives 45deg, 60deg, and 135deg diagonal-orthogonal turns", () => {
  const xRoad = orthoRoad("x-boulevard", "x", 0, -110, 120, 12, 2.5);
  const zRoad = orthoRoad("z-boulevard", "z", 0, -110, 110, 12, 2.5);
  const diag45 = makeDiagonalRoad({
    id: "diag-45",
    x1: -80,
    z1: -80,
    x2: 80,
    z2: 80,
    width: 12,
    laneOffsetM: 2.5,
    speedLimitMps: 9.5,
  });
  // 60-degree road crossing x-boulevard at (55, 0): angle from +Z is PI/6 (30deg),
  // so angle with +X (PI/2) is PI/3 (60deg) and 2*PI/3 (120deg).
  const ux60 = Math.sin(Math.PI / 6), uz60 = Math.cos(Math.PI / 6);
  const diag60 = makeDiagonalRoad({
    id: "diag-60",
    x1: 55 - ux60 * 75,
    z1: -uz60 * 75,
    x2: 55 + ux60 * 75,
    z2: uz60 * 75,
    width: 12,
    laneOffsetM: 2.5,
    speedLimitMps: 9.5,
  });
  // Near-138deg acute connector (~0.767 * PI <= 0.78 * PI) meeting x-boulevard at (-55, 0).
  const acuteHeading = Math.PI / 2 + Math.PI * 0.765;
  const uxAcute = Math.sin(acuteHeading), uzAcute = Math.cos(acuteHeading);
  const diagAcute = makeDiagonalRoad({
    id: "diag-acute",
    x1: -55,
    z1: 0.18, // within 0.35m of (-55, 0) to also exercise node snapping!
    x2: -55 + uxAcute * 75,
    z2: 0.18 + uzAcute * 75,
    width: 12,
    laneOffsetM: 2.5,
    speedLimitMps: 8.5,
  });

  const drivingRoads = [xRoad, zRoad, diag45, diag60, diagAcute];
  const aprons = [
    apronAt("hub-0-0", 0, 0, 26),
    apronAt("hub-55-0", 55, 0, 24),
    apronAt("hub--55-0", -55, 0, 28),
  ];
  const district = {
    metro: true,
    drivingRoads,
    roads: [...drivingRoads, ...aprons],
    statics: [],
  };

  const allTurns = districtTurnPaths(district, SUV);
  const hasTurn = (inId, outId, expectedDeg, tolDeg = 4) =>
    allTurns.some((t) =>
      t.incomingRoadId === inId &&
      t.outgoingRoadId === outId &&
      Math.abs((Math.abs(t.bend) * 180) / Math.PI - expectedDeg) <= tolDeg);

  assert.ok(hasTurn("x-boulevard", "diag-45", 45), "45deg x -> diag-45 turn admitted");
  assert.ok(hasTurn("diag-45", "z-boulevard", 45), "45deg diag-45 -> z turn admitted");
  assert.ok(hasTurn("x-boulevard", "diag-45", 135), "135deg x -> diag-45 acute turn admitted");
  assert.ok(hasTurn("x-boulevard", "diag-60", 60), "60deg x -> diag-60 turn admitted");
  assert.ok(hasTurn("diag-60", "x-boulevard", 60), "60deg diag-60 -> x turn admitted");
  assert.ok(hasTurn("x-boulevard", "diag-acute", 137.7, 3), "~138deg snapped acute turn admitted");

  // Physically simulate full trips across 45deg, 60deg, and 135deg turns.
  const cases = [
    {
      label: "45deg x-boulevard -> diag-45",
      start: { ...roadPoseAt(xRoad, -45, 1), roadId: "x-boulevard" },
      goal: { ...roadPoseAt(diag45, diag45.length / 2 + 48, 1), roadId: "diag-45" },
    },
    {
      label: "60deg diag-60 -> x-boulevard",
      start: { ...roadPoseAt(diag60, 20, 1), roadId: "diag-60" },
      goal: { ...roadPoseAt(xRoad, 98, 1), roadId: "x-boulevard" },
    },
    {
      label: "135deg x-boulevard -> diag-45 acute",
      start: { ...roadPoseAt(xRoad, 45, -1), roadId: "x-boulevard" },
      goal: { ...roadPoseAt(diag45, diag45.length / 2 + 48, 1), roadId: "diag-45" },
    },
  ];

  for (const { label, start, goal } of cases) {
    const rawPath = planDistrictRoute(district, { ...SUV, ...start }, goal);
    assert.ok(rawPath.length > 12, `${label}: planned non-empty route`);
    const path = Object.freeze(rawPath.map(Object.freeze));
    let body = { ...SUV, ...start, speed: 4 };
    let cursor = 0;
    for (let tick = 0; tick < 30 / STEP && distance(body, goal) > 0.8; tick++) {
      const cmd = followPath(body, path, cursor);
      cursor = cmd.cursor;
      cmd.targetSpeed = Math.min(cmd.targetSpeed, 8.5);
      const next = integrateVehicle(body, cmd, STEP);
      assert.ok(Number.isFinite(next.x) && Number.isFinite(next.z) && Number.isFinite(next.heading));
      assert.ok(sweepSafe(body, next, district.statics, district.roads).safe, `${label}: sweep safe`);
      assert.ok(bodyOnRoad(next, district.roads, 0.12), `${label}: body on road`);
      body = next;
    }
    assert.ok(distance(body, goal) <= 0.8, `${label}: arrived within 0.8m (got ${distance(body, goal)})`);
    assert.ok(Math.abs(angleDelta(body.heading, goal.heading)) < 0.2, `${label}: aligned heading`);
  }

  // Legacy navigation.js graph & planner also route cleanly across diagonal + orthogonal streets.
  const graph = createRoadGraph([xRoad, diag45]);
  const navPath = planNavigation(
    graph,
    { id: "ego", x: -45, z: 2.5, heading: Math.PI / 2 },
    { x: 40, z: 40 },
  );
  assert.ok(navPath.length > 10 && navPath.every((p) => Number.isFinite(p.x) && Number.isFinite(p.z)));
});

test("diagonal walkways, district traffic, and city encounters run without NaNs", () => {
  const diag = makeDiagonalRoad({
    id: "corniche-diag",
    x1: -70,
    z1: -70,
    x2: 70,
    z2: 70,
    width: 12,
    laneOffsetM: 2.5,
    speedLimitMps: 9.0,
    zone: "avenue",
  });
  const crossX = orthoRoad("cross-x", "x", 0, -90, 90, 12, 2.5, { zone: "avenue" });
  const drivingRoads = [diag, crossX];
  const roads = [...drivingRoads, apronAt("apron-0", 0, 0, 24)];
  const walkways = makeDiagonalWalkways(diag);

  // avenueCrossings works in both directions (diag crossed by x, and x crossed by diag).
  const diagCrossings = avenueCrossings(diag, drivingRoads);
  const xCrossings = avenueCrossings(crossX, drivingRoads);
  assert.equal(diagCrossings.length, 2);
  assert.equal(xCrossings.length, 2);
  assert.ok(diagCrossings.every((v) => v > 8 && v < diag.length - 8));

  // Build a lightweight metro world with cityVersion: 5 to exercise >= 4 junction merging,
  // diagonal speed limits, diagonal walkways, and city encounters.
  const cfg = {
    ...settings({ chaos: 1, scenarioInterval: 2, difficulty: 4 }),
    environment: "metro",
    cityVersion: 5,
  };
  const playerPose = roadPoseAt(diag, 25, 1);
  const player = {
    ...SUV,
    ...playerPose,
    speed: 6.5,
    distance: 0,
    wait: 0,
    cursor: 0,
    path: [
      roadPointAt(diag, 25, 2.5),
      roadPointAt(diag, 60, 2.5),
      roadPointAt(diag, 90, 2.5),
      roadPointAt(diag, 125, 2.5),
      roadPointAt(diag, 160, 2.5),
    ],
  };
  const taxiPose = roadPoseAt(diag, 45, 1);
  const taxi = {
    ...SUV,
    id: "taxi-1",
    kind: "taxi",
    ...taxiPose,
    speed: 5.5,
    distance: 20,
    wait: 0,
    cursor: 0,
    path: [
      roadPointAt(diag, 45, 2.5),
      roadPointAt(diag, 75, 2.5),
      roadPointAt(diag, 110, 2.5),
      roadPointAt(diag, 145, 2.5),
      roadPointAt(diag, 175, 2.5),
    ],
  };
  const walkStart = {
    x: walkways[0].x1 + walkways[0].ux * 115,
    z: walkways[0].z1 + walkways[0].uz * 115,
  };
  const walker = {
    id: "ped-diag-1",
    type: "pedestrian",
    x: walkStart.x,
    z: walkStart.z,
    heading: diag.heading,
    speed: 0,
    radius: 0.38,
    side: walkways[0].side,
    along: 115,
    road: diag,
    phase: 0.25,
    pause: 0,
    wait: 0,
    distance: 0,
    motionMode: "ambient",
  };
  const crossingWalkerPos = {
    x: walkways[1].x1 + walkways[1].ux * 38,
    z: walkways[1].z1 + walkways[1].uz * 38,
  };
  const crossingWalker = {
    id: "ped-diag-2",
    type: "pedestrian",
    x: crossingWalkerPos.x,
    z: crossingWalkerPos.z,
    heading: diag.heading,
    speed: 0,
    radius: 0.38,
    side: walkways[1].side,
    along: 38,
    road: diag,
    phase: 0.6,
    pause: 0,
    wait: 0,
    distance: 0,
    motionMode: "ambient",
  };

  // Adjoining junction conflict zones merge when cityVersion === 5 (>= 4).
  const conflictZones = [
    { id: "j-a", kind: "junction", minX: -8, maxX: 0, minZ: -8, maxZ: 8, approachM: 8 },
    { id: "j-b", kind: "junction", minX: 0, maxX: 8, minZ: -8, maxZ: 8, approachM: 8 },
  ];
  // Add an orthogonal walkway touching walkways[0]'s far end to also test diagonal<->orthogonal corner walking.
  const endJoint = {
    x: walkways[0].x1 + walkways[0].ux * walkways[0].max,
    z: walkways[0].z1 + walkways[0].uz * walkways[0].max,
  };
  const orthoCornerWalk = {
    id: "cross-x-walk-1",
    roadId: "cross-x",
    axis: "x",
    fixed: endJoint.z,
    min: endJoint.x - 30,
    max: endJoint.x,
    side: 1,
    shared: false,
    roadPreference: "avenue",
  };
  const allWalkways = [...walkways, orthoCornerWalk];

  const world = {
    environment: "metro",
    mode: "auto",
    tick: 0,
    config: cfg,
    rng: new Random("diag-engine-seed"),
    roads,
    drivingRoads,
    statics: [],
    junctions: [{ x: 0, z: 0 }],
    player,
    actors: [player, taxi, walker, crossingWalker],
    metrics: { scenarios: 0 },
    district: {
      metro: true,
      roads,
      drivingRoads,
      walkways: allWalkways,
      statics: [],
      conflictZones,
      trafficGoals: [],
    },
    free: (body, gap = 0.2) =>
      !world.actors.some((a) => distance(body, a) < gap + 2) &&
      !world.statics.some((s) => distance(body, s) < gap + 2),
    nextWalk: (p) => nextWalk(world, p),
  };
  world.actorIndex = new SpatialIndex(world.actors);
  world.staticIndex = new SpatialIndex(world.statics);
  world.districtBehavior = createDistrictBehaviorState();
  world.cityEncounters = createCityEncounters(cfg);

  initializeDistrictActor(world, player);
  initializeDistrictActor(world, taxi);
  initializeDistrictActor(world, walker);
  initializeDistrictActor(world, crossingWalker);
  walker.district.pattern = "parallel";

  // Verify onRoadLimit & districtTrafficCommand respect diagonal road speedLimitMps (9.0 m/s).
  const roadLim = onRoadLimit(world, player);
  assert.equal(roadLim.roadId, "corniche-diag");
  assert.equal(roadLim.limit, 9.0);
  const capped = districtTrafficCommand(world, player, { targetSpeed: 13.5, steer: 0, reason: "cruise" });
  assert.equal(capped.targetSpeed, 9.0);
  assert.equal(capped.reason, "district-road-limit");

  // Step walkers, traffic reservations, and city encounters for 300 ticks on diagonal geometry.
  assert.equal(nextDistrictWalk(world, walker), true);
  assert.equal(nextDistrictWalk(world, crossingWalker), true);
  let walkerMoved = 0;
  for (let tick = 1; tick <= 300; tick++) {
    world.tick = tick;
    world.actorIndex = new SpatialIndex(world.actors);
    updateDistrictTraffic(world);
    for (const ped of [walker, crossingWalker]) {
      const nextPed = stepDistrictPedestrian(world, ped);
      assert.ok(
        Number.isFinite(nextPed.x) && Number.isFinite(nextPed.z) &&
        Number.isFinite(nextPed.heading) && Number.isFinite(nextPed.speed),
        `tick ${tick}: diagonal pedestrian state must stay finite`,
      );
      const stepDist = distance(ped, nextPed);
      if (ped === walker) walkerMoved += stepDist;
      Object.assign(ped, nextPed);
      ped.distance += stepDist;
    }
    advanceCityEncounters(world);
  }
  assert.ok(walkerMoved > 3, `diagonal walker should progress along walkway (moved ${walkerMoved}m)`);
  assert.ok(
    world.cityEncounters.events.length > 0,
    "city encounters should trigger cleanly on diagonal avenues without NaN",
  );
  for (const s of world.statics) {
    assert.ok(bodyOnRoad(s, world.roads), "any spawned encounter barrier on diagonal road is on-road");
  }

  // Place a vehicle inside j-a to confirm cityVersion: 5 merged j-a and j-b into j-a+j-b!
  const junctionProbe = {
    ...SUV,
    id: "j-probe",
    x: -3,
    z: 0,
    heading: Math.PI / 2,
    speed: 2,
    distance: 0,
    wait: 0,
    cursor: 0,
    path: [{ x: -3, z: 0 }, { x: 10, z: 0 }],
  };
  world.actors.push(junctionProbe);
  world.tick++;
  world.actorIndex = new SpatialIndex(world.actors);
  updateDistrictTraffic(world);
  assert.ok(
    Object.hasOwn(world.districtBehavior.reservations, "j-a+j-b"),
    "cityVersion >= 4 merges adjoining junction mouths into a combined resource",
  );

  // Corner-turning walker near endJoint transitions from diagonal walkway to orthogonal walkway.
  const cornerWalker = {
    id: "ped-corner",
    type: "pedestrian",
    x: walkways[0].x1 + walkways[0].ux * (walkways[0].max - 0.8),
    z: walkways[0].z1 + walkways[0].uz * (walkways[0].max - 0.8),
    heading: diag.heading,
    speed: 0,
    radius: 0.38,
    side: walkways[0].side,
    along: walkways[0].max - 0.8,
    road: diag,
    phase: 0.4,
    pause: 0,
    wait: 0,
    distance: 0,
    motionMode: "ambient",
  };
  assert.equal(nextDistrictWalk(world, cornerWalker), true);
  assert.equal(cornerWalker.district.targetWalkwayId, "cross-x-walk-1");
  assert.ok(cornerWalker.walkRoute?.length === 2);

  // Also verify standalone ambient pedestrianMotion + walkingWaypoint curb detour on a diagonal road.
  const parkedCar = {
    id: "parked-diag",
    type: "vehicle",
    ...roadPointAt(diag, 60, -(diag.width / 2 + 1.25)),
    heading: diag.heading,
    width: 1.9,
    length: 4.4,
    speed: 0,
  };
  const ambientWalker = {
    id: "ambient-ped",
    type: "pedestrian",
    ...roadPointAt(diag, 52, -(diag.width / 2 + 1.25)),
    heading: diag.heading,
    speed: 1.1,
    radius: 0.38,
    side: -1,
    along: 52,
    road: diag,
    phase: 0.7,
    pause: 0,
    crossing: false,
    target: { x: parkedCar.x, z: parkedCar.z },
    motionMode: "ambient",
  };
  const detourWp = walkingWaypoint({ tick: 1 }, ambientWalker, [parkedCar]);
  assert.ok(Number.isFinite(detourWp.x) && Number.isFinite(detourWp.z));
  assert.ok(distance(ambientWalker.target, parkedCar) > 1.2, "curb target shifted along diagonal road away from parked car");

  const ambientWorld = {
    environment: "city",
    tick: 2,
    config: cfg,
    rng: new Random("ambient-diag"),
    roads,
    actors: [ambientWalker],
    actorIndex: new SpatialIndex([ambientWalker]),
    staticIndex: new SpatialIndex([]),
    nextWalk: (p) => nextWalk(ambientWorld, p),
  };
  ambientWalker.x = ambientWalker.target.x;
  ambientWalker.z = ambientWalker.target.z;
  ambientWalker.pause = 0;
  const stepped = pedestrianMotion(ambientWorld, ambientWalker);
  assert.ok(Number.isFinite(stepped.x) && Number.isFinite(stepped.z) && Number.isFinite(ambientWalker.along));
  assert.ok(ambientWalker.along > 45 && ambientWalker.along < 70, `along projected onto diag road (${ambientWalker.along})`);
});
