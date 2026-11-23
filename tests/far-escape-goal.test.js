import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { STEP } from "../src/core/config.js";
import { planDistrictRoute } from "../src/core/district-navigation.js";
import { districtRoadPose } from "../src/core/egypt-district.js";
import { distance, isDiagonalRoad, roadPoseAt } from "../src/core/geometry.js";
import { AGGRESSIVE_CHASE_PRESENCE } from "../src/core/pako-aggressive-police.js";
import { METRO_CITY_CURBS, surveyMetroCurb } from "../src/core/pako-curb.js";
import { validatePursuitAction } from "../src/core/pursuit-controls.js";
import {
  advanceEscapeGoalIfReached,
  buildCityEscapeCandidates,
  escapeGoalSnapshot,
  goalPoseClear,
  planPublicEscapeRoute,
  selectFarEscapeGoal,
} from "../src/core/pursuit-escape-goal.js";
import { World } from "../src/core/world.js";
import {
  computeCellRevisitPenalty,
  computeFarEscapeBonus,
  planPakoEvasiveAction,
} from "../src/rl/pako-evasive-control.js";
import { CLEARANCE_ROUTE_CONTEXT, dispatchRouteGuide } from "../src/rl/pursuit-route-context.js";
import { PURSUIT_SCAN_TICKS, PursuitScanner } from "../src/signal_processing/pursuit-scanner.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUDITED_MODULES = Object.freeze([
  path.resolve(__dirname, "../src/core/pursuit-escape-goal.js"),
  path.resolve(__dirname, "../src/rl/pursuit-route-context.js"),
  path.resolve(__dirname, "../src/rl/pako-evasive-control.js"),
]);

const POLICY_FORWARD = Object.freeze({ steer: 0, throttle: 0.92, brake: 0, gear: 1 });

function makeSensorAuditedWorld(world) {
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
    get config() {
      return world.config;
    },
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
      get rng() {
        return world.pursuit.rng;
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

function createGrandCityV5PursuitWorld({
  seed = "far-escape-v5",
  traffic = 0,
  pedestrians = 0,
} = {}) {
  const world = new World({ cityVersion: 5, seed, traffic, pedestrians }, "metro");
  const cmd = {
    type: "street-pursuit-start",
    variant: "gta",
    config: {
      ruleset: "dispatch-v1",
      maxActivePatrols: 0,
      enableRoadblocks: false,
      curbSupport: METRO_CITY_CURBS,
      chasePresence: AGGRESSIVE_CHASE_PRESENCE,
    },
  };
  try {
    world.command(cmd);
  } catch {
    world.config = { ...world.config, cityVersion: 4 };
    world.command(cmd);
    world.config = { ...world.config, cityVersion: 5 };
  }
  world.pursuit.gta.curb = surveyMetroCurb(world, METRO_CITY_CURBS);
  return world;
}

test("1. Sensor-boundary audit: pursuit-escape-goal, pursuit-route-context, and pako-evasive-control have zero private actor/police reads", () => {
  const forbiddenTokens = [".patrols", ".actorIndex", "world.actors", "lastSeen", ".police", ".response"];
  for (const filePath of AUDITED_MODULES) {
    const source = fs.readFileSync(filePath, "utf8");
    const relName = path.basename(filePath);
    for (const token of forbiddenTokens) {
      assert.equal(
        source.includes(token),
        false,
        `Forbidden private simulator token "${token}" found in ${relName}`,
      );
    }
  }

  const world = createGrandCityV5PursuitWorld({ seed: "sensor-proxy-audit-v5" });
  const scanner = new PursuitScanner();
  world.pursuit.gta.scan = scanner.sample(world);
  const auditedWorld = makeSensorAuditedWorld(world);

  const cands = buildCityEscapeCandidates(auditedWorld.district);
  assert.ok(cands.length >= 16 && cands.length <= 36, `expected 16..36 candidates, got ${cands.length}`);

  const goal = selectFarEscapeGoal(auditedWorld);
  assert.ok(goal && Object.isFrozen(goal));
  auditedWorld.pursuit.gta.escapeGoal = goal;

  const snap = escapeGoalSnapshot(auditedWorld);
  assert.equal(snap.id, goal.id);

  const guide = dispatchRouteGuide(auditedWorld, CLEARANCE_ROUTE_CONTEXT);
  assert.ok(guide && guide.path.length >= 3);

  const decision = planPakoEvasiveAction(auditedWorld, POLICY_FORWARD);
  validatePursuitAction(decision.action);

  const unchanged = advanceEscapeGoalIfReached(auditedWorld, 38);
  assert.equal(unchanged.id, goal.id);
});

test("2. selectFarEscapeGoal, advanceEscapeGoalIfReached, escapeGoalSnapshot & dispatchRouteGuide replanning across 6 Grand Metro City v5 starts", () => {
  const world = createGrandCityV5PursuitWorld({ seed: "six-starts-v5" });
  const auditedWorld = makeSensorAuditedWorld(world);

  assert.equal(escapeGoalSnapshot(auditedWorld), null, "snapshot must be null before escapeGoal is set");

  const candidates = buildCityEscapeCandidates(world.district);
  assert.equal(
    buildCityEscapeCandidates(world.district),
    candidates,
    "buildCityEscapeCandidates must return WeakMap-cached frozen array per district",
  );
  assert.ok(candidates.length >= 16 && candidates.length <= 36, `expected 16..36 candidates, got ${candidates.length}`);
  for (const cand of candidates) {
    assert.ok(Object.isFrozen(cand));
    assert.ok(typeof cand.label === "string" && cand.label.length >= 6, `invalid label on ${cand.id}`);
    assert.equal(goalPoseClear(world.district, cand), true, `candidate ${cand.id} must be clear of statics`);
  }

  // Verify dynamic loop on Grand City v5 prefers far goals (>= 320 m) even when no explicit goal is set
  delete world.pursuit.gta.escapeGoal;
  delete world.pursuit.gta.publicRouteGoal;
  const dynamicV5Guide = dispatchRouteGuide(auditedWorld, CLEARANCE_ROUTE_CONTEXT);
  assert.ok(dynamicV5Guide && dynamicV5Guide.path.length >= 3);
  const dynamicEndDistM = distance(world.player, dynamicV5Guide.path.at(-1));
  assert.ok(
    dynamicEndDistM >= 320,
    `expected Grand City v5 dynamic route guide >= 320 m away, got ${dynamicEndDistM.toFixed(1)} m`,
  );

  const sixStarts = [
    { name: "Tahrir Boulevard West", roadId: "tahrir-boulevard", along: -254, side: 1 },
    { name: "Nile West Boulevard North", roadId: "nile-west-boulevard", along: 240, side: -1 },
    { name: "Citadel East Ring South", roadId: "citadel-east-ring", along: -280, side: 1 },
    { name: "Ramses North Arterial East", roadId: "ramses-north-arterial", along: 280, side: -1 },
    { name: "Qasr El-Nil Diagonal", roadId: "qasr-diagonal", along: 120, side: 1 },
    { name: "Khan Market Street Interior", roadId: "khan-market-street", along: 40, side: 1 },
  ];

  for (const startSpec of sixStarts) {
    const road = world.drivingRoads.find((r) => r.id === startSpec.roadId);
    assert.ok(road, `expected road ${startSpec.roadId}`);
    const pose = isDiagonalRoad(road)
      ? roadPoseAt(road, startSpec.along, startSpec.side)
      : districtRoadPose(road, startSpec.along, startSpec.side);
    Object.assign(world.player, pose, { speed: 9.0, steer: 0, curbSupportId: null });

    const leg1 = selectFarEscapeGoal(auditedWorld);
    assert.ok(leg1 && Object.isFrozen(leg1), `expected frozen leg 1 goal for ${startSpec.name}`);
    assert.equal(leg1.leg, 1);
    const dist1 = distance(world.player, leg1);
    assert.ok(
      dist1 >= 450,
      `[${startSpec.name}] expected leg 1 distance >= 450 m, got ${dist1.toFixed(1)} m`,
    );
    assert.equal(goalPoseClear(world.district, leg1), true, `[${startSpec.name}] leg 1 must be clear of statics`);
    const route1 = planDistrictRoute(world.district, world.player, leg1);
    assert.ok(
      route1.length >= 3,
      `[${startSpec.name}] expected leg 1 planDistrictRoute length >= 3, got ${route1.length}`,
    );

    world.pursuit.gta.escapeGoal = leg1;
    const guide1 = dispatchRouteGuide(auditedWorld, CLEARANCE_ROUTE_CONTEXT);
    assert.ok(guide1 && guide1.path.length >= 3);
    assert.equal(guide1.id, leg1.id, "dispatchRouteGuide must immediately plan toward new escapeGoal");

    const snap1 = escapeGoalSnapshot(auditedWorld);
    assert.equal(snap1.id, leg1.id);
    assert.equal(snap1.leg, 1);
    assert.equal(snap1.distanceM, Math.round(dist1));
    assert.equal(snap1.initialDistanceM, leg1.initialDistanceM);

    // Still > 38 m away: goal remains leg 1
    assert.equal(advanceEscapeGoalIfReached(auditedWorld, 38), leg1);

    // Move player within 38 m of leg 1 goal: automatically advances to leg 2 >= 450 m away!
    Object.assign(world.player, { x: leg1.x, z: leg1.z, heading: leg1.heading });
    const leg2 = advanceEscapeGoalIfReached(auditedWorld, 38);
    assert.ok(leg2 && Object.isFrozen(leg2));
    assert.equal(leg2.leg, 2);
    assert.notEqual(leg2.id, leg1.id, "leg 2 must exclude leg 1 goal ID");
    const dist2 = distance(world.player, leg2);
    assert.ok(
      dist2 >= 450,
      `[${startSpec.name}] expected leg 2 distance >= 450 m, got ${dist2.toFixed(1)} m`,
    );
    assert.equal(goalPoseClear(world.district, leg2), true);
    const route2 = planDistrictRoute(world.district, world.player, leg2);
    assert.ok(
      route2.length >= 3,
      `[${startSpec.name}] expected leg 2 planDistrictRoute length >= 3, got ${route2.length}`,
    );

    // Cache invalidation check: dispatchRouteGuide immediately switches to leg 2 without waiting for retryAt!
    const guide2 = dispatchRouteGuide(auditedWorld, CLEARANCE_ROUTE_CONTEXT);
    assert.ok(guide2 && guide2.path.length >= 3);
    assert.equal(guide2.id, leg2.id, "dispatchRouteGuide must immediately invalidate cache when escapeGoal changes");
  }

  // Verify offPath (> 22 m) replanning after a detour onto another street preserves the same far escapeGoal!
  const tahrir = world.drivingRoads.find((r) => r.id === "tahrir-boulevard");
  Object.assign(world.player, districtRoadPose(tahrir, -254, 1), { speed: 10, curbSupportId: null });
  const detourGoal = selectFarEscapeGoal(auditedWorld);
  world.pursuit.gta.escapeGoal = detourGoal;
  const initialGuide = dispatchRouteGuide(auditedWorld, CLEARANCE_ROUTE_CONTEXT);
  assert.equal(initialGuide.id, detourGoal.id);

  // Move SUV onto distant parallel avenue > 22 m from every point of initialGuide.path
  const nile = world.drivingRoads.find((r) => r.id === "nile-west-boulevard");
  Object.assign(world.player, districtRoadPose(nile, 160, 1));
  assert.equal(
    initialGuide.path.every((p) => distance(world.player, p) > 22),
    true,
    "detoured pose must be > 22 m from initial path",
  );
  const replannedGuide = dispatchRouteGuide(auditedWorld, CLEARANCE_ROUTE_CONTEXT);
  assert.ok(replannedGuide && replannedGuide.path.length >= 3);
  assert.equal(replannedGuide.id, detourGoal.id, "must replan toward the SAME far escapeGoal");
  assert.ok(
    distance(world.player, replannedGuide.path[0]) < 8,
    "replanned route must start from the SUV's new street",
  );

  // Verify curb-supported player fallback & Metro v4 140 m threshold
  const curbSite = world.pursuit.gta.curb.sites.find((s) => s.roadId === "opera-avenue");
  assert.ok(curbSite);
  Object.assign(world.player, {
    x: curbSite.edge + curbSite.side * 0.95,
    z: 20,
    heading: 0,
    curbSupportId: curbSite.id,
  });
  const fromCurbGoal = selectFarEscapeGoal(auditedWorld);
  assert.ok(fromCurbGoal && distance(world.player, fromCurbGoal) >= 450);
  assert.ok(planPublicEscapeRoute(world.district, world.player, fromCurbGoal).length >= 3);

  const v4World = new World({ cityVersion: 4, seed: "v4-far-goal-check", traffic: 0, pedestrians: 0 }, "metro");
  const v4Goal = selectFarEscapeGoal(v4World);
  assert.ok(v4Goal && distance(v4World.player, v4Goal) >= 140);
});

test("3. Purposeful outward Grand Metro City v5 traversal (600 ticks / 10 s), anti-loop revisit memory, and smooth straightaway steering", () => {
  const world = createGrandCityV5PursuitWorld({ seed: "outward-v5-traversal", traffic: 0, pedestrians: 0 });
  const scanner = new PursuitScanner();
  const auditedWorld = makeSensorAuditedWorld(world);

  // Place SUV on opera-avenue heading North so its route to the far eastern escapeGoal carves through intersections & diagonal boulevards!
  const opera = world.drivingRoads.find((r) => r.id === "opera-avenue");
  Object.assign(world.player, districtRoadPose(opera, 45, 1), {
    speed: 12.5,
    steer: 0,
  });

  const startOrigin = { x: world.player.x, z: world.player.z };
  const escapeGoal = selectFarEscapeGoal(auditedWorld);
  assert.ok(escapeGoal && distance(startOrigin, escapeGoal) >= 450);
  world.pursuit.gta.escapeGoal = escapeGoal;

  let active = null;
  let pathDistance = 0;
  let prevX = world.player.x;
  let prevZ = world.player.z;
  const straightSteerSamples = [];

  for (let tick = 0; tick < 600; tick++) {
    if (!active || world.tick % PURSUIT_SCAN_TICKS === 0) {
      advanceEscapeGoalIfReached(auditedWorld, 38);
      world.pursuit.gta.scan = scanner.sample(world);
      // Inject tiny < 0.035 rad micro-jitter (+/- 0.03 * 0.62 = 0.0186 rad) to verify straight-boulevard deadband & smoothness!
      const jitterSteer = tick % 12 === 0 ? 0.03 : -0.03;
      const requested = { steer: jitterSteer, throttle: 0.92, brake: 0, gear: 1 };
      const dec = planPakoEvasiveAction(auditedWorld, requested);
      validatePursuitAction(dec.action);
      active = dec.action;
      if (tick >= 240 && tick <= 480) {
        straightSteerSamples.push(active.steer);
      }
    }
    world.command({ type: "pursuit-drive", action: active }, false);
    world.step();
    pathDistance += Math.hypot(world.player.x - prevX, world.player.z - prevZ);
    prevX = world.player.x;
    prevZ = world.player.z;
  }

  const netDisplacementFromStartM = distance(startOrigin, world.player);
  const efficiencyRatio = netDisplacementFromStartM / Math.max(1e-6, pathDistance);

  assert.ok(
    netDisplacementFromStartM >= 120,
    `expected netDisplacementFromStartM >= 120 m in 10 s, got ${netDisplacementFromStartM.toFixed(1)} m`,
  );
  assert.ok(
    efficiencyRatio >= 0.5,
    `expected netDisplacement / pathDistance >= 0.50, got ${efficiencyRatio.toFixed(3)}`,
  );
  assert.equal(world.pursuit.metrics.collisions, 0, "expected 0 vehicle/static collisions");
  assert.equal(world.pursuit.metrics.pedestrianCollisions, 0, "expected 0 pedestrian collisions");

  // Verify _evasiveMemory visitedCells ringbuffer was populated and stayed bounded <= 36 cells
  const mem = world.pursuit.gta._evasiveMemory;
  assert.ok(mem && Array.isArray(mem.visitedCells) && mem.visitedCells.length >= 4 && mem.visitedCells.length <= 36);

  // Verify straight-line boulevard sprint suppressed micro-oscillations (majority of straight cruise ticks have steer === 0)
  const zeroSteerCount = straightSteerSamples.filter((s) => s === 0).length;
  assert.ok(
    zeroSteerCount >= Math.floor(straightSteerSamples.length * 0.6),
    `expected rock-steady straightaway deadband (zeroSteer=${zeroSteerCount}/${straightSteerSamples.length})`,
  );

  // Verify anti-looping revisit penalty (-12 * visitCount up to -30 pts after > 4.5 s, 0 for current cell)
  const tickNow = 1000;
  const recentTicks = Math.round(2.0 / STEP); // 2.0 s ago (<= 4.5 s) -> 0 penalty
  const oldTicks1 = Math.round(10.0 / STEP); // 10.0 s ago (> 4.5 s) -> -12 pts
  const oldTicks2 = Math.round(22.0 / STEP); // 22.0 s ago (> 4.5 s) -> -24 pts
  const oldTicks3 = Math.round(34.0 / STEP); // 34.0 s ago (> 4.5 s) -> -30 pts cap
  const testCells = [
    { key: "0:0", enteredTick: tickNow - recentTicks, lastTick: tickNow },
    { key: "2:3", enteredTick: tickNow - oldTicks1, lastTick: tickNow - oldTicks1 },
    { key: "5:5", enteredTick: tickNow - oldTicks2, lastTick: tickNow - oldTicks2 },
    { key: "5:5", enteredTick: tickNow - oldTicks1, lastTick: tickNow - oldTicks1 },
    { key: "8:8", enteredTick: tickNow - oldTicks3, lastTick: tickNow - oldTicks3 },
    { key: "8:8", enteredTick: tickNow - oldTicks2, lastTick: tickNow - oldTicks2 },
    { key: "8:8", enteredTick: tickNow - oldTicks1, lastTick: tickNow - oldTicks1 },
  ];
  assert.equal(computeCellRevisitPenalty({ x: 10, z: 10 }, 0, testCells, tickNow, false), 0);
  assert.equal(computeCellRevisitPenalty({ x: 2 * 28 + 5, z: 3 * 28 + 5 }, 0, testCells, tickNow, false), -12);
  assert.equal(computeCellRevisitPenalty({ x: 5 * 28 + 5, z: 5 * 28 + 5 }, 0, testCells, tickNow, false), -24);
  assert.equal(computeCellRevisitPenalty({ x: 8 * 28 + 5, z: 8 * 28 + 5 }, 0, testCells, tickNow, false), -30);

  // Verify computeFarEscapeBonus rewards advancing along routeGuide toward far escapeGoal over turning away
  const guide = dispatchRouteGuide(auditedWorld, CLEARANCE_ROUTE_CONTEXT);
  assert.ok(guide && guide.path.length >= 3);
  const cumArc = guide.path.reduce((arr, p, i) => {
    arr[i] = i === 0 ? 0 : arr[i - 1] + distance(guide.path[i - 1], p);
    return arr;
  }, new Float64Array(guide.path.length));
  let nearestIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < guide.path.length; i++) {
    const d = distance(world.player, guide.path[i]);
    if (d < bestDist) {
      bestDist = d;
      nearestIdx = i;
    }
  }
  const aheadIdx = Math.min(guide.path.length - 1, nearestIdx + 45);
  const lookIdx = Math.min(guide.path.length - 1, nearestIdx + 95);
  const look35H = Math.atan2(
    guide.path[lookIdx].x - world.player.x,
    guide.path[lookIdx].z - world.player.z,
  );
  const synthCtx = {
    path: guide.path,
    cumArc,
    nearestIdx,
    startArc: cumArc[nearestIdx],
    distToPathM: bestDist,
    scanLo: Math.max(0, nearestIdx - 20),
    scanHi: Math.min(guide.path.length - 1, nearestIdx + 120),
    routeEndPoint: world.pursuit.gta.escapeGoal,
    goalDistFromStartM: distance(world.player, world.pursuit.gta.escapeGoal),
    lookahead35Heading: look35H,
    hasExplicitEscapeGoal: true,
  };
  const fwdBonus = computeFarEscapeBonus({
    endPose: { x: guide.path[aheadIdx].x, z: guide.path[aheadIdx].z },
    lookaheadHeading: look35H,
    action: { steer: 0, throttle: 0.9, brake: 0, gear: 1 },
    farRouteCtx: synthCtx,
  });
  const awayBonus = computeFarEscapeBonus({
    endPose: {
      x: world.player.x - Math.sin(look35H) * 10,
      z: world.player.z - Math.cos(look35H) * 10,
    },
    lookaheadHeading: look35H + Math.PI,
    action: { steer: 0, throttle: 0.9, brake: 0, gear: 1 },
    farRouteCtx: synthCtx,
  });
  assert.ok(fwdBonus > 12, `expected positive far-escape corridor bonus > 12, got ${fwdBonus.toFixed(2)}`);
  assert.ok(awayBonus < 0, `expected negative bonus when moving away from escapeGoal, got ${awayBonus.toFixed(2)}`);
});
