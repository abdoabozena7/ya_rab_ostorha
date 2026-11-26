import { createHash } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULTS, STEP, VEHICLE } from "../src/core/config.js";
import {
  createDistrictBehaviorState,
  initializeDistrictActor,
  nextDistrictWalk,
  planDistrictTrafficTrip,
  stepDistrictPedestrian,
} from "../src/core/district-behavior.js";
import { planDistrictRoute } from "../src/core/district-navigation.js";
import {
  angleDelta,
  bodyOnRoad,
  distance,
  isDiagonalRoad,
  overlaps,
  pointOnRoad,
  roadIntersection,
  roadPoseAt,
  roadRect,
  sweepSafe,
} from "../src/core/geometry.js";
import { createPedestrianBody } from "../src/core/pedestrian-body.js";
import { resolveSurveillanceZones } from "../src/core/pursuit-dispatch.js";
import { Random } from "../src/core/random.js";
import { SpatialIndex } from "../src/core/spatial-index.js";
import {
  createUnifiedCity,
  GRAND_CITY_POPULATION_DEFAULTS,
  GRAND_CITY_POPULATION_LIMITS,
} from "../src/core/unified-city.js";
import { followPath, integrateVehicle } from "../src/core/vehicle.js";
import { PLAYER_VEHICLE } from "../src/core/vehicle-spec.js";
import { walkSegmentClear } from "../src/core/walk-route.js";

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

function roadFootprintBody(road) {
  if (isDiagonalRoad(road)) {
    return {
      id: road.id,
      type: "static",
      x: (road.x1 + road.x2) / 2,
      z: (road.z1 + road.z2) / 2,
      width: road.width,
      length: road.length + road.width,
      heading: road.heading,
    };
  }
  const r = roadRect(road);
  return {
    id: road.id,
    type: "static",
    x: (r.minX + r.maxX) / 2,
    z: (r.minZ + r.maxZ) / 2,
    width: r.maxX - r.minX,
    length: r.maxZ - r.minZ,
    heading: 0,
  };
}

function walkwayFootprintBody(line) {
  if (isDiagonalRoad(line)) {
    return {
      id: line.id,
      type: "static",
      x: line.x1 + (line.ux * line.length) / 2,
      z: line.z1 + (line.uz * line.length) / 2,
      width: 1.7,
      length: line.length,
      heading: Math.atan2(line.ux, line.uz),
    };
  }
  const r = roadRect({ ...line, width: 1.7 });
  return {
    id: line.id,
    type: "static",
    x: (r.minX + r.maxX) / 2,
    z: (r.minZ + r.maxZ) / 2,
    width: r.maxX - r.minX,
    length: r.maxZ - r.minZ,
    heading: 0,
  };
}

test("grand=false preserves legacy v2, v3, and v4 Metro City bit-for-bit", () => {
  assert.deepEqual(GRAND_CITY_POPULATION_LIMITS, { traffic: 140, pedestrians: 280 });
  assert.deepEqual(GRAND_CITY_POPULATION_DEFAULTS, { traffic: 68, pedestrians: 190 });

  const v2Default = createUnifiedCity();
  const v2Explicit = createUnifiedCity({ dense: false, rush: false, grand: false });
  assert.deepEqual(v2Explicit, v2Default);

  const v3 = createUnifiedCity({ dense: true, grand: false });
  assert.equal(
    createHash("sha256").update(JSON.stringify(v3)).digest("hex"),
    "a70fdb1e8a38a1ef6044406ce23cce2675da1cb139b4928560aaef0f82209afd",
  );

  const v4 = createUnifiedCity({ rush: true });
  assert.deepEqual(createUnifiedCity({ rush: true, grand: false }), v4);

  // Template cache returns independent top-level arrays in sub-millisecond time.
  const firstGrand = createUnifiedCity({ grand: true });
  const t0 = performance.now();
  const clones = Array.from({ length: 20 }, () => createUnifiedCity({ grand: true }));
  const elapsedMs = performance.now() - t0;
  assert.ok(elapsedMs < 25, `20 cached createUnifiedCity({ grand: true }) clones took ${elapsedMs.toFixed(2)}ms`);
  const secondGrand = clones[0];
  assert.notEqual(firstGrand, secondGrand);
  assert.notEqual(firstGrand.drivingRoads, secondGrand.drivingRoads);
  assert.notEqual(firstGrand.roads, secondGrand.roads);
  assert.notEqual(firstGrand.statics, secondGrand.statics);
  assert.notEqual(firstGrand.trafficSpawns, secondGrand.trafficSpawns);
  assert.notEqual(firstGrand.pedestrianSpawns, secondGrand.pedestrianSpawns);
  assert.equal(firstGrand.templateKey, "grand-city-v5");
  assert.equal(firstGrand.drivingRoads.templateKey, secondGrand.drivingRoads.templateKey);
  assert.equal(firstGrand.roads.templateKey, secondGrand.roads.templateKey);
  assert.equal(firstGrand.statics.templateKey, secondGrand.statics.templateKey);
});

test("Grand Metro City v5 expands area >8x with >=4 diagonal avenues, monumental buildings, and 0 overlaps", () => {
  const v4 = createUnifiedCity({ rush: true });
  const v4Rects = v4.drivingRoads.map((r) => roadRect(r));
  const v4Area =
    (Math.max(...v4Rects.map((r) => r.maxX)) - Math.min(...v4Rects.map((r) => r.minX))) *
    (Math.max(...v4Rects.map((r) => r.maxZ)) - Math.min(...v4Rects.map((r) => r.minZ)));

  const city = createUnifiedCity({ grand: true });
  assert.equal(city.cityVersion, 5);
  assert.equal(city.rush, true);
  assert.equal(city.grand, true);
  assert.equal(city.playerStart.roadId, "tahrir-boulevard");

  const rects = city.drivingRoads.map((r) => roadRect(r));
  const minX = Math.min(...rects.map((r) => r.minX));
  const maxX = Math.max(...rects.map((r) => r.maxX));
  const minZ = Math.min(...rects.map((r) => r.minZ));
  const maxZ = Math.max(...rects.map((r) => r.maxZ));
  const mapAreaM2 = (maxX - minX) * (maxZ - minZ);
  assert.ok(minX <= -520 && maxX >= 420 && minZ <= -420 && maxZ >= 360);
  assert.ok(mapAreaM2 >= 650_000 && mapAreaM2 > v4Area * 8, `mapAreaM2=${mapAreaM2}`);

  assert.ok(city.drivingRoads.length >= 28 && city.drivingRoads.length <= 32);
  assert.equal(new Set(city.roads.map((r) => r.id)).size, city.roads.length);

  const diagonalRoads = city.drivingRoads.filter(isDiagonalRoad);
  assert.ok(diagonalRoads.length >= 4);
  for (const id of ["qasr-diagonal", "talaat-diagonal", "ramses-diagonal", "bazaar-slash"]) {
    const diag = diagonalRoads.find((r) => r.id === id);
    assert.ok(diag, `missing diagonal ${id}`);
    assert.ok(
      Math.abs(diag.ux) > 0.25 && Math.abs(diag.uz) > 0.25,
      `${id} must have a true non-orthogonal heading`,
    );
  }

  // Every diagonal road crossing has a wide supportApron pad (width 18..22).
  const aprons = city.roads.filter((r) => r.supportApron && r.id.startsWith("grand-mouth-"));
  assert.ok(aprons.length >= 30);
  assert.ok(aprons.every((a) => a.width >= 18 && a.width <= 22));
  for (const diag of diagonalRoads) {
    for (const other of city.drivingRoads) {
      if (other === diag) continue;
      const hit = roadIntersection(diag, other, 0.5);
      if (!hit) continue;
      assert.ok(
        aprons.some((a) => Math.hypot(a.junctionX - hit.x, a.junctionZ - hit.z) <= 1.0 && a.width >= 20),
        `missing wide supportApron at ${diag.id} x ${other.id}`,
      );
    }
  }

  // Monumental building scale and strict road/walkway/static separation.
  const buildings = city.statics.filter((s) => s.kind === "building");
  const sortedWidths = buildings.map((b) => b.width).sort((a, b) => a - b);
  const medianBuildingWidthM = sortedWidths[Math.floor(sortedWidths.length / 2)];
  const maxBuildingHeightM = Math.max(...buildings.map((b) => b.height));
  assert.ok(buildings.length >= 180, `buildings=${buildings.length}`);
  assert.ok(medianBuildingWidthM >= 28, `medianBuildingWidthM=${medianBuildingWidthM}`);
  assert.ok(maxBuildingHeightM >= 50, `maxBuildingHeightM=${maxBuildingHeightM}`);

  // Diagonal-frontage buildings are rotated flush to non-orthogonal headings.
  const angledBuildings = buildings.filter((b) => {
    const modQuarterTurn = Math.abs(((b.heading % (Math.PI / 2)) + Math.PI / 2) % (Math.PI / 2));
    return modQuarterTurn > 0.15 && modQuarterTurn < Math.PI / 2 - 0.15;
  });
  assert.ok(angledBuildings.length >= 16, `angledBuildings=${angledBuildings.length}`);

  const reservedCorridors = [
    ...city.roads.map(roadFootprintBody),
    ...city.walkways.map(walkwayFootprintBody),
  ];
  const corridorIndex = new SpatialIndex(reservedCorridors, 48);
  const maxCorridorReach = reservedCorridors.reduce(
    (m, r) => Math.max(m, Math.hypot(r.width, r.length) / 2),
    40,
  );
  for (const b of buildings) {
    const reach = maxCorridorReach + Math.hypot(b.width, b.length) / 2 + 2;
    assert.ok(
      !corridorIndex.near(b, reach).some((corridor) => overlaps(b, corridor, 0.6)),
      `building ${b.id} intrudes into road or walkway`,
    );
  }

  for (let i = 0; i < city.statics.length; i++) {
    for (let j = i + 1; j < city.statics.length; j++) {
      assert.equal(
        overlaps(city.statics[i], city.statics[j], 0.12),
        false,
        `static overlap: ${city.statics[i].id} vs ${city.statics[j].id}`,
      );
    }
  }

  for (const line of city.walkways) {
    const start = isDiagonalRoad(line)
      ? { x: line.x1 + line.ux * line.min, z: line.z1 + line.uz * line.min }
      : line.axis === "z" ? { x: line.fixed, z: line.min } : { x: line.min, z: line.fixed };
    const end = isDiagonalRoad(line)
      ? { x: line.x1 + line.ux * line.max, z: line.z1 + line.uz * line.max }
      : line.axis === "z" ? { x: line.fixed, z: line.max } : { x: line.max, z: line.fixed };
    assert.ok(
      walkSegmentClear({ type: "pedestrian", radius: 0.38 }, start, end, city.statics, 0.12),
      `walkway blocked: ${line.id}`,
    );
  }
});

test("hotspots, >=50 curbside parked vehicles, surveillance zones, and multi-hop orthogonal-diagonal routing", () => {
  const rawCity = createUnifiedCity({ grand: true });
  const city = { ...rawCity, metro: true };

  // Surveillance zones & pursuit exits.
  const zones = resolveSurveillanceZones(city.surveillanceZones);
  assert.equal(zones.length, 8);
  assert.ok(
    zones.some(
      (z) =>
        city.playerStart.x >= z.minX &&
        city.playerStart.x <= z.maxX &&
        city.playerStart.z >= z.minZ &&
        city.playerStart.z <= z.maxZ,
    ),
    "playerStart starts inside initial dispatch surveillance",
  );
  assert.equal(city.pursuitExits.length, 20);
  const outsideExits = city.pursuitExits.filter((exit) =>
    zones.every(
      (z) => exit.x < z.minX || exit.x > z.maxX || exit.z < z.minZ || exit.z > z.maxZ,
    ),
  );
  assert.ok(outsideExits.length >= 10, "outer ring avenues provide escape exits outside surveillance");

  // Curbside parked vehicles (>= 50 total, >= 45 required).
  const parkedVehicles = city.statics.filter((s) => s.kind === "parked-vehicle");
  assert.ok(parkedVehicles.length >= 50, `parkedVehicles=${parkedVehicles.length}`);
  const grandParked = parkedVehicles.filter((p) => p.id.startsWith("grand-parked-"));
  const seenKinds = new Set(grandParked.map((p) => p.vehicleKind));
  assert.deepEqual(
    seenKinds,
    new Set(["sedan", "suv", "van", "taxi", "pickup", "tuktuk"]),
  );

  const junctions = [];
  for (let i = 0; i < city.drivingRoads.length; i++) {
    for (let j = i + 1; j < city.drivingRoads.length; j++) {
      const hit = roadIntersection(city.drivingRoads[i], city.drivingRoads[j], 0.5);
      if (hit) junctions.push(hit);
    }
  }
  for (const p of grandParked) {
    assert.ok(distance(p, city.playerStart) >= 16, `${p.id}: >=16m from playerStart`);
    assert.ok(junctions.every((j) => distance(p, j) >= 14), `${p.id}: >=14m from every junction`);
    assert.ok(bodyOnRoad(p, city.roads, 0.12), `${p.id}: on-road`);
  }
  assert.ok(city.hotspots.parked.length >= 3);
  assert.ok(city.hotspots.parked.every((pocket) => pocket.vehicleIds.length >= 3));

  // Traffic hotspots & all 140 traffic spawns.
  assert.ok(city.hotspots.traffic.length >= 3);
  assert.equal(city.trafficSpawns.length, GRAND_CITY_POPULATION_LIMITS.traffic);
  const trafficActors = city.trafficSpawns.map((pose, i) => ({
    id: `traffic-${i}`,
    type: "vehicle",
    width: VEHICLE.width,
    length: VEHICLE.length,
    ...pose,
  }));
  for (let i = 0; i < trafficActors.length; i++) {
    const car = trafficActors[i];
    assert.ok(bodyOnRoad(car, city.roads, 0.12), `traffic-${i} on road`);
    assert.ok(!city.statics.some((s) => overlaps(car, s, 0.12)), `traffic-${i} clear of statics`);
    for (let j = i + 1; j < trafficActors.length; j++) {
      assert.equal(overlaps(car, trafficActors[j], 0.5), false);
    }
  }

  // All public places & pursuit exits are routable from playerStart.
  const egoStart = { ...SUV, ...city.playerStart };
  for (const goal of [...city.places, ...city.pursuitExits]) {
    const path = planDistrictRoute(city, egoStart, goal);
    assert.ok(path.length > 10, `route from playerStart to ${goal.id}`);
  }

  // Explicit multi-hop orthogonal -> diagonal -> orthogonal route & physical drive check.
  const qasrDiag = city.drivingRoads.find((r) => r.id === "qasr-diagonal");
  const talaatDiag = city.drivingRoads.find((r) => r.id === "talaat-diagonal");
  const ramsesDiag = city.drivingRoads.find((r) => r.id === "ramses-diagonal");
  const clotBey = city.drivingRoads.find((r) => r.id === "clot-bey-avenue");
  const multiHopCases = [
    {
      label: "tahrir-boulevard -> talaat-diagonal -> ramses-diagonal -> ramses-north-arterial",
      start: egoStart,
      goal: city.pursuitExits.find((e) => e.id === "metro-exit-ramses-east"),
      diagonalCheck: [talaatDiag, ramsesDiag],
    },
    {
      label: "qasr-diagonal -> tahrir-boulevard -> bazaar-slash -> university-avenue",
      start: { ...SUV, ...roadPoseAt(qasrDiag, 70, 1), roadId: "qasr-diagonal" },
      goal: {
        ...roadPoseAt(city.drivingRoads.find((r) => r.id === "bazaar-slash"), 195, 1),
        roadId: "bazaar-slash",
      },
      diagonalCheck: [qasrDiag],
    },
    {
      label: "opera-avenue -> qasr-diagonal -> talaat-diagonal -> clot-bey-avenue",
      start: {
        ...SUV,
        x: -380 - 2.6,
        z: -40,
        heading: 0,
        roadId: "opera-avenue",
      },
      goal: { x: 85, z: clotBey.fixed + 2.6, heading: Math.PI / 2, roadId: "clot-bey-avenue" },
      diagonalCheck: [talaatDiag],
    },
  ];

  for (const { label, start, goal, diagonalCheck } of multiHopCases) {
    const rawPath = planDistrictRoute(city, start, goal);
    assert.ok(rawPath.length > 30, `${label}: planned multi-hop route`);
    assert.ok(
      diagonalCheck.some((diag) => rawPath.some((pt) => pointOnRoad(pt, [diag], 1.0))),
      `${label}: traverses diagonal boulevard`,
    );
    const frozen = Object.freeze(rawPath.map(Object.freeze));
    let body = { ...start, speed: 5 };
    let cursor = 0;
    for (let tick = 0; tick < 160 / STEP && distance(body, goal) > 0.9; tick++) {
      const cmd = followPath(body, frozen, cursor);
      cursor = cmd.cursor;
      cmd.targetSpeed = Math.min(cmd.targetSpeed, 9.5);
      const next = integrateVehicle(body, cmd, STEP);
      assert.ok(sweepSafe(body, next, city.statics, city.roads).safe, `${label}: sweepSafe @ ${tick}`);
      assert.ok(bodyOnRoad(next, city.roads, 0.12), `${label}: bodyOnRoad @ ${tick}`);
      body = next;
    }
    assert.ok(distance(body, goal) <= 0.9, `${label}: arrived within 0.9m`);
  }

  // Crowd hotspots & pedestrian spawns (~45% hotspot concentration, >=1.35m spacing, live crossing wave).
  assert.ok(city.hotspots.crowds.length >= 3);
  const centralCrowd = city.hotspots.crowds[0];
  assert.equal(centralCrowd.id, "tahrir-midan-crowd");
  const aheadDist = centralCrowd.x - city.playerStart.x;
  assert.ok(aheadDist >= 60 && aheadDist <= 120, `centralCrowd aheadDist=${aheadDist}`);

  assert.equal(city.pedestrianSpawns.length, GRAND_CITY_POPULATION_LIMITS.pedestrians);
  const inCrowd = (p) => city.hotspots.crowds.some((h) => distance(p, h) <= h.radiusM);
  const crowdShare =
    city.pedestrianSpawns.filter(inCrowd).length / city.pedestrianSpawns.length;
  assert.ok(crowdShare >= 0.40 && crowdShare <= 0.54, `crowdShare=${crowdShare}`);

  for (let i = 0; i < city.pedestrianSpawns.length; i++) {
    const p = city.pedestrianSpawns[i];
    const body = { type: "pedestrian", radius: 0.38, ...p };
    assert.ok(!city.statics.some((s) => overlaps(body, s, 0.12)));
    assert.ok(!trafficActors.some((c) => overlaps(body, c, 0.12)));
    for (let j = i + 1; j < city.pedestrianSpawns.length; j++) {
      assert.ok(distance(p, city.pedestrianSpawns[j]) >= 1.35);
    }
  }

  // Live crowd wave check: guarded car yields & clears >=35m with 0 hits; traffic trips route cleanly.
  const rng = new Random("grand-v5-crowd");
  const tahrir = city.drivingRoads.find((r) => r.id === "tahrir-boulevard");
  const walkers = city.pedestrianSpawns
    .slice(0, GRAND_CITY_POPULATION_DEFAULTS.pedestrians)
    .map((sp, i) => {
      const person = {
        id: `person-${i}`,
        type: "pedestrian",
        kind: "man-jacket",
        ...sp,
        road: city.drivingRoads.find((r) => r.id === sp.roadId),
        speed: 0,
        walkSpeed: rng.range(1.1, 1.65),
        phase: rng.next(),
        distance: 0,
        wait: 0,
        reason: "walking",
        target: null,
        pause: 0,
        crossing: false,
        motionMode: "ambient",
      };
      person.body = createPedestrianBody(person);
      person.radius = person.body.radiusM;
      return person;
    });

  const guardedCar = { ...SUV, ...city.playerStart, speed: 9.0 };
  const simWorld = {
    environment: "metro",
    tick: 0,
    rng,
    district: city,
    roads: city.roads,
    drivingRoads: city.drivingRoads,
    statics: city.statics,
    player: guardedCar,
    actors: [guardedCar, ...trafficActors.slice(0, 12), ...walkers],
    districtBehavior: createDistrictBehaviorState(),
    nextWalk: (p) => nextDistrictWalk(simWorld, p),
  };
  simWorld.actorIndex = new SpatialIndex(simWorld.actors);
  simWorld.staticIndex = new SpatialIndex(simWorld.statics);

  for (const car of trafficActors.slice(0, 12)) {
    assert.ok(planDistrictTrafficTrip(simWorld, car, 0).length > 10);
  }
  for (const w of walkers) {
    initializeDistrictActor(simWorld, w);
    assert.equal(nextDistrictWalk(simWorld, w), true);
  }

  const crossingSeen = new Set();
  let pedHits = 0;
  let yieldedTicks = 0;
  for (let tick = 1; tick <= Math.round(16 / STEP); tick++) {
    simWorld.tick = tick;
    const nextX = guardedCar.x + guardedCar.speed * STEP;
    const candidateCar = { ...guardedCar, x: nextX };
    const nearWalkers = walkers.filter((w) => distance(w, candidateCar) < 9);
    const clearAhead =
      sweepSafe(guardedCar, candidateCar, nearWalkers, city.roads).safe &&
      !nearWalkers.some((w) => w.x > guardedCar.x && w.x < guardedCar.x + 7.5 && Math.abs(w.z - guardedCar.z) < 2.1);
    if (clearAhead) {
      guardedCar.x = nextX;
      guardedCar.speed = Math.min(9.5, guardedCar.speed + 4 * STEP);
    } else {
      guardedCar.speed = 0;
      yieldedTicks++;
    }
    simWorld.actorIndex = new SpatialIndex(simWorld.actors);
    for (const w of walkers) {
      const next = stepDistrictPedestrian(simWorld, w);
      Object.assign(w, next, { distance: w.distance + distance(w, next) });
      if (pointOnRoad(w, [tahrir])) crossingSeen.add(w.id);
      if (overlaps(guardedCar, w, 0)) pedHits++;
    }
  }
  assert.ok(crossingSeen.size >= 4, `crossingSeen=${crossingSeen.size}`);
  assert.ok(yieldedTicks > 0, "SUV genuinely yields to crossing wave");
  assert.equal(pedHits, 0);
  assert.ok(guardedCar.x - city.playerStart.x >= 35);
});
