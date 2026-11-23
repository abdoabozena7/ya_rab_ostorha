import assert from "node:assert/strict";
import test from "node:test";
import { STEP } from "../src/core/config.js";
import {
  aheadJunctionTargets,
  dispatchJunctionStillRelevant,
  dispatchRoadblockDetour,
  gtaJunctionCommand,
  onRoad,
  selectDispatchJunction,
} from "../src/core/dispatch-junctions.js";
import { districtRoadPose } from "../src/core/egypt-district.js";
import {
  angleDelta,
  bodyOnRoad,
  distance,
  isDiagonalRoad,
  makeDiagonalRoad,
  roadIntersection,
  roadPoseAt,
  roadProject,
} from "../src/core/geometry.js";
import { integrateVehicle } from "../src/core/vehicle.js";
import { World } from "../src/core/world.js";
import {
  CLEARANCE_CORRIDOR,
  CLEARANCE_ROUTE_CONTEXT,
  LEGACY_ROUTE_CONTEXT,
  ROUTE_NAVIGATION_FIELDS,
  dispatchRouteGuide,
  sampleRouteNavigation,
} from "../src/rl/pursuit-route-context.js";

const CAR_SHAPE = Object.freeze({
  type: "vehicle",
  width: 1.85,
  length: 4.2,
  spec: Object.freeze({
    wheelbase: 2.6,
    maxSteer: 0.62,
    acceleration: 5.2,
    braking: 8.5,
    steerRate: 2.1,
  }),
  maxSpeed: 28,
});

function orthoRoad(id, axis, fixed, min, max, width = 14, laneOffsetM = 2.7, extra = {}) {
  return {
    id,
    axis,
    fixed,
    min,
    max,
    width,
    laneOffsetM,
    speedLimitMps: 10.5,
    flow: 0,
    zone: "avenue",
    marking: "center",
    ...extra,
  };
}

function junctionApronsFor(drivingRoads) {
  const aprons = [];
  for (let i = 0; i < drivingRoads.length; i++) {
    for (let j = i + 1; j < drivingRoads.length; j++) {
      const hit = roadIntersection(drivingRoads[i], drivingRoads[j], 0.5);
      if (!hit) continue;
      aprons.push({
        id: `apron-${drivingRoads[i].id}-${drivingRoads[j].id}`,
        axis: "z",
        fixed: hit.x,
        min: hit.z - 2,
        max: hit.z + 2,
        width: 22,
        laneOffsetM: 0,
        flow: 0,
        speedLimitMps: 6,
        zone: "avenue",
        marking: "none",
        parkingBay: true,
        supportApron: true,
      });
    }
  }
  return aprons;
}

function buildMultiZoneDiagonalDistrict() {
  const ewCentral = orthoRoad("central-ew", "x", 0, -420, 420, 14, 2.7);
  const ewNorth = orthoRoad("north-ew", "x", 220, -420, 420, 14, 2.7);
  const ewSouth = orthoRoad("south-ew", "x", -220, -420, 420, 14, 2.7);
  const nsCentral = orthoRoad("central-ns", "z", 0, -380, 380, 14, 2.7);
  const nsWest = orthoRoad("west-ns", "z", -220, -380, 380, 14, 2.7);
  const nsEast = orthoRoad("east-ns", "z", 220, -380, 380, 14, 2.7);

  const diagNE = makeDiagonalRoad({
    id: "grand-slash-ne",
    x1: -320,
    z1: -320,
    x2: 320,
    z2: 320,
    width: 15,
    laneOffsetM: 2.7,
    speedLimitMps: 11,
  });
  const diagNW = makeDiagonalRoad({
    id: "grand-slash-nw",
    x1: -320,
    z1: 320,
    x2: 320,
    z2: -320,
    width: 15,
    laneOffsetM: 2.7,
    speedLimitMps: 11,
  });
  const diagConnector = makeDiagonalRoad({
    id: "harbor-diag",
    x1: -360,
    z1: -110,
    x2: 80,
    z2: 260,
    width: 13,
    laneOffsetM: 2.5,
    speedLimitMps: 9.5,
  });

  const drivingRoads = [
    ewCentral,
    ewNorth,
    ewSouth,
    nsCentral,
    nsWest,
    nsEast,
    diagNE,
    diagNW,
    diagConnector,
  ];
  const aprons = junctionApronsFor(drivingRoads);
  const roads = [...drivingRoads, ...aprons];

  // Permanent parked car near one diagonal endpoint to verify clearanceGoals nudges cleanly
  const endParked = {
    id: "parked-near-ne-tip",
    type: "static",
    kind: "parked-car",
    ...roadPoseAt(diagNE, diagNE.length - 12, 1),
    width: 1.9,
    length: 4.4,
    height: 1.5,
  };

  const pursuitExits = [
    { id: "diag-exit-ne", roadId: diagNE.id, ...roadPoseAt(diagNE, diagNE.length - 28, 1) },
    { id: "diag-exit-nw", roadId: diagNW.id, ...roadPoseAt(diagNW, diagNW.length - 20, 1) },
    { id: "ortho-exit-east", roadId: ewNorth.id, ...districtRoadPose(ewNorth, 395, 1) },
  ];

  // 8 v5-style surveillance zones covering interior & hub pockets while leaving outer corridors open
  const surveillanceZones = [
    { id: "z1-plaza", minX: -75, maxX: 75, minZ: -75, maxZ: 75 },
    { id: "z2-west-hub", minX: -265, maxX: -175, minZ: -65, maxZ: 65 },
    { id: "z3-east-hub", minX: 175, maxX: 265, minZ: -65, maxZ: 65 },
    { id: "z4-north-hub", minX: -65, maxX: 65, minZ: 175, maxZ: 265 },
    { id: "z5-south-hub", minX: -65, maxX: 65, minZ: -265, maxZ: -175 },
    { id: "z6-nw-gate", minX: -260, maxX: -180, minZ: 180, maxZ: 260 },
    { id: "z7-se-gate", minX: 180, maxX: 260, minZ: -260, maxZ: -180 },
    { id: "z8-sw-quarter", minX: -260, maxX: -180, minZ: -260, maxZ: -180 },
  ];

  return {
    district: {
      id: "grand-city-v5-test",
      metro: true,
      grand: true,
      drivingRoads,
      roads,
      statics: [endParked],
      pursuitExits,
    },
    surveillanceZones,
    byId: new Map(drivingRoads.map(r => [r.id, r])),
  };
}

function makeVehicleBody(id, pose, extra = {}) {
  return {
    id,
    ...CAR_SHAPE,
    x: pose.x,
    z: pose.z,
    heading: pose.heading,
    speed: 0,
    steer: 0,
    ...extra,
  };
}

test("onRoad and aheadJunctionTargets handle diagonal roads and reject nearly-collinear grazes", () => {
  const { district, byId } = buildMultiZoneDiagonalDistrict();
  const diagNE = byId.get("grand-slash-ne");
  const shallowGraze = makeDiagonalRoad({
    id: "nearly-collinear-diag",
    x1: -120,
    z1: -108,
    x2: 120,
    z2: 108,
    width: 12,
    laneOffsetM: 2.4,
  });
  const roads = [...district.drivingRoads, shallowGraze];

  const centerHit = roadIntersection(diagNE, byId.get("central-ew"), 0.5);
  assert.ok(centerHit);
  const egoPose = roadPoseAt(diagNE, centerHit.alongA - 36, 1);
  const ego = makeVehicleBody("ego", egoPose, { speed: 11 });

  assert.equal(onRoad(diagNE, ego), true);
  assert.equal(onRoad(ego, diagNE), true);
  assert.equal(onRoad(diagNE, { x: ego.x - 20, z: ego.z + 20 }), false);
  assert.equal(onRoad(diagNE, roadPoseAt(diagNE, diagNE.length + 1.5, 1), 2), true);
  assert.equal(onRoad(diagNE, roadPoseAt(diagNE, diagNE.length + 3.5, 1), 2), false);

  const ahead = aheadJunctionTargets(roads, ego, { minGap: 7, maxGap: 70 });
  assert.ok(ahead.length >= 3, `expected intersections with x, z, and cross-diag, got ${ahead.length}`);
  const crossingIds = new Set(ahead.map(t => t.crossing.id));
  assert.ok(crossingIds.has("central-ew"), "must find diagonal->x junction");
  assert.ok(crossingIds.has("central-ns"), "must find diagonal->z junction");
  assert.ok(crossingIds.has("grand-slash-nw"), "must find diagonal->diagonal junction");
  assert.equal(crossingIds.has("nearly-collinear-diag"), false, "must reject angle < 0.35 rad");

  for (const item of ahead) {
    assert.ok(Math.abs(item.gap - 36) < 1e-6);
    assert.ok(item.goals.length >= 2);
    for (const goal of item.goals) {
      assert.ok([goal.x, goal.z, goal.heading].every(Number.isFinite));
      const targetRoad = roads.find(r => r.id === goal.roadId);
      assert.equal(onRoad(targetRoad, goal), true);
    }
  }

  // Reverse motion uses reversed velocity alignment without throwing
  const reversing = makeVehicleBody("ego-rev", roadPoseAt(diagNE, centerHit.alongA + 30, 1), { speed: -9 });
  const revTargets = aheadJunctionTargets(roads, reversing, { minGap: 7, maxGap: 50 });
  assert.ok(revTargets.some(t => t.crossing.id === "grand-slash-nw" && t.direction === -1));
});

test("selectDispatchJunction, dispatchJunctionStillRelevant, and gtaJunctionCommand work across diag<->x, diag<->z, and diag<->diag", () => {
  const { district, byId } = buildMultiZoneDiagonalDistrict();
  const diagNE = byId.get("grand-slash-ne");
  const diagNW = byId.get("grand-slash-nw");
  const ewCentral = byId.get("central-ew");
  const nsCentral = byId.get("central-ns");

  const scenarios = [
    { name: "ego on diagNE, FLANKER on x-road", egoRoad: diagNE, egoDir: 1, patrolRoad: ewCentral, patrolDir: -1, role: "FLANKER" },
    { name: "ego on diagNE, INTERCEPTOR on z-road", egoRoad: diagNE, egoDir: 1, patrolRoad: nsCentral, patrolDir: -1, role: "INTERCEPTOR" },
    { name: "ego on x-road, INTERCEPTOR on diagNE", egoRoad: ewCentral, egoDir: 1, patrolRoad: diagNE, patrolDir: -1, role: "INTERCEPTOR" },
    { name: "ego on diagNE, INTERCEPTOR on diagNW", egoRoad: diagNE, egoDir: 1, patrolRoad: diagNW, patrolDir: 1, role: "INTERCEPTOR" },
    { name: "ego on diagNW, FLANKER on diagNE", egoRoad: diagNW, egoDir: -1, patrolRoad: diagNE, patrolDir: -1, role: "FLANKER" },
  ];

  for (const sc of scenarios) {
    const hit = roadIntersection(sc.egoRoad, sc.patrolRoad, 0.5);
    assert.ok(hit, `expected intersection for ${sc.name}`);
    const egoGap = sc.role === "INTERCEPTOR" ? 42 : 28;
    const patrolGap = 24;
    const egoPose = isDiagonalRoad(sc.egoRoad)
      ? roadPoseAt(sc.egoRoad, hit.alongA - egoGap * sc.egoDir, sc.egoDir)
      : districtRoadPose(sc.egoRoad, hit.alongA - egoGap * sc.egoDir, sc.egoDir);
    const patrolPose = isDiagonalRoad(sc.patrolRoad)
      ? roadPoseAt(sc.patrolRoad, hit.alongB - patrolGap * sc.patrolDir, sc.patrolDir)
      : districtRoadPose(sc.patrolRoad, hit.alongB - patrolGap * sc.patrolDir, sc.patrolDir);

    const report = {
      ...egoPose,
      speed: 9.5,
      tick: 10,
      vx: Math.sin(egoPose.heading) * 9.5,
      vz: Math.cos(egoPose.heading) * 9.5,
    };
    const patrol = makeVehicleBody(`patrol-${sc.name}`, patrolPose, {
      speed: 7.5,
      squadRole: sc.role,
      aiState: "PURSUIT",
      gtaAI: { nextJointCheck: 0, junctionRoute: null },
    });

    const singlePairRoads = [sc.egoRoad, sc.patrolRoad];
    const choice = selectDispatchJunction(singlePairRoads, patrol, report);
    assert.ok(choice, `expected tactical junction choice for ${sc.name}`);
    assert.equal(choice.role, sc.role === "INTERCEPTOR" ? "BLOCK_INTERCEPT" : "FLANK");
    assert.equal(choice.goal.roadId, sc.role === "INTERCEPTOR" ? sc.egoRoad.id : sc.patrolRoad.id);
    assert.ok([choice.goal.x, choice.goal.z, choice.goal.heading].every(Number.isFinite));
    assert.equal(dispatchJunctionStillRelevant(choice, report), true);

    // Once ego passes >= 12 m past the junction along its approach road, route becomes irrelevant
    const passedPose = isDiagonalRoad(sc.egoRoad)
      ? roadPoseAt(sc.egoRoad, hit.alongA + 14 * sc.egoDir, sc.egoDir)
      : districtRoadPose(sc.egoRoad, hit.alongA + 14 * sc.egoDir, sc.egoDir);
    assert.equal(dispatchJunctionStillRelevant(choice, { ...passedPose, speed: 9.5 }), false);

    // Verify gtaJunctionCommand plans and advances patrol cleanly on the shared roadway
    const pairDistrict = {
      metro: true,
      drivingRoads: singlePairRoads,
      roads: [...singlePairRoads, ...junctionApronsFor(singlePairRoads)],
      statics: [],
    };
    const worldStub = {
      tick: 10,
      drivingRoads: singlePairRoads,
      district: pairDistrict,
      pursuit: {
        wantedLevel: 4,
        patrolMap: pairDistrict,
        response: {
          lastSeen: report,
          dispatch: { state: "ZONE_TRACKED" },
        },
      },
    };

    const cmd = gtaJunctionCommand(worldStub, patrol);
    assert.ok(cmd, `gtaJunctionCommand must produce command for ${sc.name}`);
    assert.equal(cmd.reason, choice.role);
    assert.ok(Number.isFinite(cmd.steer) && Number.isFinite(cmd.targetSpeed) && cmd.targetSpeed > 0);
    assert.ok(patrol.gtaAI.junctionRoute?.path?.length > 2);

    let moving = patrol;
    for (let step = 0; step < 36; step++) {
      worldStub.tick++;
      const stepCmd = gtaJunctionCommand(worldStub, moving);
      if (!stepCmd) break;
      const next = integrateVehicle(moving, stepCmd, STEP);
      Object.assign(moving, next);
      assert.equal(bodyOnRoad(moving, pairDistrict.roads), true, `patrol stayed on road in ${sc.name}`);
    }
    assert.ok(distance(moving, patrolPose) > 2, `patrol physically advanced in ${sc.name}`);
  }

  // Wrong-way ego on a one-way diagonal slash street can still be flanked without RangeError
  const oneWayDiag = makeDiagonalRoad({
    id: "one-way-slash",
    x1: -200,
    z1: -200,
    x2: 200,
    z2: 200,
    width: 11,
    laneOffsetM: 2.2,
    flow: 1,
  });
  const hitOneWay = roadIntersection(oneWayDiag, ewCentral, 0.5);
  const wrongWayReport = {
    ...roadPoseAt(oneWayDiag, hitOneWay.alongA + 30, 1, 0),
    heading: Math.atan2(-oneWayDiag.ux, -oneWayDiag.uz),
    speed: 9,
    tick: 5,
  };
  const flankerOnX = makeVehicleBody("flanker-oneway", districtRoadPose(ewCentral, hitOneWay.alongB - 22, 1), {
    speed: 7,
    squadRole: "FLANKER",
  });
  const wrongWayFlank = selectDispatchJunction([oneWayDiag, ewCentral], flankerOnX, wrongWayReport);
  assert.ok(wrongWayFlank && wrongWayFlank.role === "FLANK");
  assert.equal(dispatchJunctionStillRelevant(wrongWayFlank, wrongWayReport), true);
});

test("dispatchRoadblockDetour finds safe detours from and onto diagonal roads without throwing", () => {
  const { district, byId } = buildMultiZoneDiagonalDistrict();
  const diagNE = byId.get("grand-slash-ne");
  const ewCentral = byId.get("central-ew");
  const hit = roadIntersection(diagNE, ewCentral, 0.5);
  assert.ok(hit);

  // Case 1: Ego on diagonal road, roadblock ahead past central-ew, detours onto x/z/diag branch
  const egoDiag = makeVehicleBody("ego-diag", roadPoseAt(diagNE, hit.alongA - 28, 1), { speed: 10 });
  const blockAlongDiag = hit.alongA + 26;
  const blockCenterDiag = roadPoseAt(diagNE, blockAlongDiag, 1, 0);
  const blockerDiag = {
    id: "diag-roadblock",
    type: "static",
    x: blockCenterDiag.x,
    z: blockCenterDiag.z,
    heading: blockCenterDiag.heading,
    width: diagNE.width,
    length: 2.2,
  };
  const detourFromDiag = dispatchRoadblockDetour(
    district,
    egoDiag,
    diagNE,
    1,
    blockAlongDiag,
    [blockerDiag],
  );
  assert.ok(detourFromDiag, "expected detour branch before diagonal roadblock");
  assert.notEqual(detourFromDiag.roadId, diagNE.id);
  assert.ok(
    roadProject(diagNE, detourFromDiag).along !== blockAlongDiag,
    "detour turns away from blocked diagonal segment",
  );

  // Case 2: Ego on orthogonal road in a map containing diagonal branches, detours onto diagonal branch
  const diagOnlyMap = {
    metro: true,
    drivingRoads: [ewCentral, diagNE],
    roads: [ewCentral, diagNE, ...junctionApronsFor([ewCentral, diagNE])],
    statics: [],
  };
  const egoOrtho = makeVehicleBody("ego-ortho", districtRoadPose(ewCentral, hit.alongB - 28, 1), { speed: 10 });
  const blockX = hit.alongB + 26;
  const blockerOrtho = {
    id: "ortho-roadblock",
    type: "static",
    x: blockX,
    z: ewCentral.fixed,
    heading: Math.PI / 2,
    width: ewCentral.width,
    length: 2.2,
  };
  const detourToDiag = dispatchRoadblockDetour(
    diagOnlyMap,
    egoOrtho,
    ewCentral,
    1,
    blockX,
    [blockerOrtho],
  );
  assert.ok(detourToDiag, "expected detour onto diagonal branch from orthogonal road");
  assert.equal(detourToDiag.roadId, diagNE.id);
});

test("dispatchRouteGuide and sampleRouteNavigation compute valid diagonal routes and cycle visited clearance goals across 8 surveillance zones without reading private actor/patrol state", () => {
  const { district, surveillanceZones, byId } = buildMultiZoneDiagonalDistrict();
  const diagNE = byId.get("grand-slash-ne");
  const centerAlong = diagNE.length / 2;
  const player = makeVehicleBody("player", roadPoseAt(diagNE, centerAlong, 1), { speed: 12 });

  const pursuit = {
    gta: {
      config: {
        ruleset: "dispatch-v1",
        surveillanceZones,
        curbSupport: "metro-city-curbs-v2",
      },
    },
    get patrols() {
      throw new Error("pursuit-route-context must not read pursuit.patrols");
    },
    get response() {
      throw new Error("pursuit-route-context must not read pursuit.response");
    },
  };

  const makeRestrictedWorld = (tick, cityVersion = 5) => ({
    config: { cityVersion },
    district,
    player,
    pursuit,
    tick,
    get actors() {
      throw new Error("pursuit-route-context must not read world.actors");
    },
    get statics() {
      throw new Error("pursuit-route-context must not read world.statics");
    },
  });

  // 1. Initial guide from diagonal boulevard inside central surveillance zone (v5, 8 zones)
  const w0 = makeRestrictedWorld(0, 5);
  const firstGuide = dispatchRouteGuide(w0, CLEARANCE_ROUTE_CONTEXT);
  assert.ok(firstGuide && firstGuide.path.length >= 3, "expected valid v2 clearance route from diagonal road");
  const nav = sampleRouteNavigation(w0, CLEARANCE_ROUTE_CONTEXT);
  assert.equal(nav.length, ROUTE_NAVIGATION_FIELDS.length);
  assert.equal(nav[0], 1);
  assert.ok(nav.every(Number.isFinite));

  // Verify goal lies >= 38 m outside all 8 surveillance zones
  const checkZoneClearance = pt => {
    for (const z of surveillanceZones) {
      const clear = Math.hypot(
        Math.max(0, z.minX - pt.x, pt.x - z.maxX),
        Math.max(0, z.minZ - pt.z, pt.z - z.maxZ),
      );
      assert.ok(clear >= 38 - 1e-6, `goal (${pt.x}, ${pt.z}) too close to zone ${z.id}: ${clear}`);
    }
  };
  checkZoneClearance(firstGuide.path.at(-1));

  // Verify CLEARANCE_CORRIDOR and LEGACY_ROUTE_CONTEXT also work on diagonal road without private reads
  const corridor = dispatchRouteGuide(w0, CLEARANCE_ROUTE_CONTEXT, CLEARANCE_CORRIDOR);
  assert.ok(corridor && corridor.path.length >= 3 && Number.isFinite(corridor.earliestM));
  const legacy = dispatchRouteGuide(w0, LEGACY_ROUTE_CONTEXT);
  assert.ok(legacy && legacy.path.length >= 3);

  // 2. Cycle visited clearance goals when reaching each goal's end, then verify full-set wraparound
  const seenIds = [firstGuide.id];
  let current = firstGuide;
  let wrapped = false;
  for (let step = 1; step <= 40; step++) {
    const end = current.path.at(-1);
    const prev = current.path.at(-2);
    const arrivalHeading = Math.atan2(end.x - prev.x, end.z - prev.z);
    Object.assign(player, { x: end.x, z: end.z, heading: arrivalHeading, speed: 10 });
    const next = dispatchRouteGuide(makeRestrictedWorld(step * 30, 5), CLEARANCE_ROUTE_CONTEXT);
    assert.ok(next && next.path.length >= 3, `expected next clearance guide at cycle step ${step}`);
    assert.notEqual(next.id, current.id, "must immediately advance off the just-visited clearance goal");
    checkZoneClearance(next.path.at(-1));
    if (seenIds.includes(next.id)) {
      wrapped = true;
      break;
    }
    seenIds.push(next.id);
    current = next;
  }
  assert.ok(seenIds.length >= 4, `expected at least 4 distinct clearance goals cycled, got ${seenIds.length}`);
  assert.equal(wrapped, true, "expected visited clearance goals to wrap cleanly into a new cycle");

  // 3. Verify curb-supported player pose alongside diagonal road still computes a valid static route cue
  const curbPlayer = makeVehicleBody("curb-player", {
    ...roadPoseAt(diagNE, centerAlong - 30, 1, diagNE.width / 2 + 1.2),
  }, { speed: 6, curbSupportId: "diag-curb-site-1" });
  const curbPursuit = {
    gta: { config: { ruleset: "dispatch-v1", surveillanceZones, curbSupport: "metro-city-curbs-v2" } },
  };
  const curbGuide = dispatchRouteGuide(
    { config: { cityVersion: 4 }, district, player: curbPlayer, pursuit: curbPursuit, tick: 0 },
    CLEARANCE_ROUTE_CONTEXT,
  );
  assert.ok(curbGuide && curbGuide.path.length >= 3, "curb-supported player on diagonal road receives valid route guide");
});

test("Metro v4 orthogonal dispatch junctions and route context preserve exact behavior", () => {
  const world = new World({ cityVersion: 4, seed: "v4-compat-diagonal-check", traffic: 0, pedestrians: 0 }, "metro");
  const avenue = world.drivingRoads.find(r => r.id === "tahrir-boulevard");
  const side = world.drivingRoads.find(r => r.id === "civic-avenue");
  Object.assign(world.player, districtRoadPose(avenue, -226, 1), { speed: 8 });
  world.command({
    type: "street-pursuit-start",
    variant: "gta",
    config: { ruleset: "dispatch-v1", wantedLevelStart: 3, wantedLevelMax: 3, maxActivePatrols: 1, enableRoadblocks: false },
  }, false);
  const [patrol] = world.pursuit.patrols;
  Object.assign(patrol, districtRoadPose(side, -98, -1), { speed: 5, squadRole: "INTERCEPTOR" });
  const report = { ...world.player, tick: world.tick };
  const target = selectDispatchJunction(world.drivingRoads, patrol, report);
  assert.ok(target);
  assert.equal(target.role, "BLOCK_INTERCEPT");
  assert.equal(target.goal.roadId, "tahrir-boulevard");
  assert.deepEqual(target.junction, { x: -183, z: -112 });

  const v4Guide = dispatchRouteGuide(world, CLEARANCE_ROUTE_CONTEXT);
  assert.ok(v4Guide && v4Guide.path.length > 10);
});
