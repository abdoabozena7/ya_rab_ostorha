import { bodyOnRoad, distance, overlaps, roadRect } from "./geometry.js";

const HALF_PI = Math.PI / 2;
const road = (id, axis, fixed, min, max, width, laneOffsetM, extra = {}) => ({
  id, axis, fixed, min, max, width, laneOffsetM, flow: 0,
  speedLimitMps: 5.5, marking: "none", sideStreet: true, ...extra,
});

export function districtRoadPose(street, along, side = 1) {
  if (![-1, 1].includes(side)) throw new RangeError("District road side must be -1 or 1");
  if (street.flow && arguments.length >= 3 && side !== street.flow)
    throw new RangeError(`Wrong-way pose on ${street.id}`);
  side = street.flow || side;
  if (!Number.isFinite(along) || along < street.min || along > street.max)
    throw new RangeError(`Pose is outside ${street.id}`);
  const offset = street.laneOffsetM ?? 0;
  return street.axis === "z"
    ? { x: street.fixed - side * offset, z: along, heading: side === 1 ? 0 : Math.PI }
    : { x: along, z: street.fixed + side * offset, heading: side * HALF_PI };
}

function crossings(streets) {
  const nodes = [];
  for (let i = 0; i < streets.length; i++) {
    const a = streets[i];
    for (const b of streets.slice(i + 1)) {
      if (a.axis === b.axis) continue;
      const vertical = a.axis === "z" ? a : b, horizontal = a.axis === "x" ? a : b;
      if (horizontal.fixed < vertical.min || horizontal.fixed > vertical.max
          || vertical.fixed < horizontal.min || vertical.fixed > horizontal.max) continue;
      if (!nodes.some((p) => p.x === vertical.fixed && p.z === horizontal.fixed))
        nodes.push({ x: vertical.fixed, z: horizontal.fixed });
    }
  }
  return nodes;
}

function buildingPlots(roads) {
  const plots = [];
  const add = (x, z, width, length, height) => plots.push({ x, z, width, length, height });
  [-49, -35, -21, -6, 10, 26, 42, 56].forEach((x, i) =>
    add(x, -52.5, i % 2 ? 11 : 12, 8, 11 + i % 4 * 2.6));
  [-44, -29, -14, 2, 17, 33, 49].forEach((x, i) =>
    add(x, 48.5, 11 + i % 2, 8, 11 + (i + 2) % 4 * 2.6));
  [-32, -17, 12, 28].forEach((z, i) => {
    add(-56.5, z, 8, 11, 12 + i % 3 * 2.6);
    add(64.5, z, 8, 11, 11 + (i + 1) % 4 * 2.6);
  });
  add(-34, -30, 10, 9, 15.6);
  add(-34, -9.8, 10, 7, 13);
  add(-34, -18.5, 10, 10, 18.2);
  add(-20.8, -29, 12.8, 8.6, 15.6);
  add(-20.8, -15.55, 12.8, 13.7, 18.2);
  add(-3.2, -29, 12.8, 8.6, 13);
  add(-3.2, -10.1, 12.8, 2.8, 10.4);
  add(1, -18.5, 8, 7, 13);
  for (const [x, width] of [[12, 12], [27, 12], [42, 11]]) {
    add(x, -30, width, 10, 11 + (x % 3) * 2.6);
    add(x, -15, width, 13, 15.6);
  }
  for (const [x, width] of [[-34, 10], [-20, 12], [-5, 12]]) {
    add(x, 11, width, 10, 13);
    add(x, 26, width, 10, 15.6);
  }
  add(10.4, 19, 14.2, 17, 15.6);
  add(28, 19, 11, 17, 18.2);
  for (const z of [11, 26]) add(42, z, 11, 10, z === 11 ? 15.6 : 11);
  const exclusions = roads.map((r) => {
    const b = roadRect(r);
    return { x: (b.minX + b.maxX) / 2, z: (b.minZ + b.maxZ) / 2,
      width: b.maxX - b.minX, length: b.maxZ - b.minZ, heading: 0 };
  });
  return plots.map((plot, i) => ({
    id: `district-building-${i}`, type: "static", kind: "building", heading: 0, ...plot,
  })).filter((plot) => !exclusions.some((r) => overlaps(plot, r, 0.3)));
}

function makeWalkways(streets) {
  return streets.flatMap((street) => [-1, 1].map((side) => {
    const shared = street.width < 4;
    const offset = street.id === "alley-west" && side === -1 ? 1.2
      : street.id === "east-connector" && side === -1 ? 3.6
        : shared ? 1.75 : street.width / 2 + 1.15;
    return {
      id: `${street.id}-walk-${side}`, roadId: street.id, axis: street.axis,
      fixed: street.fixed + (street.axis === "z" ? -side : side) * offset,
      min: street.min + 7, max: street.max - 7, side, shared,
    };
  })).concat([
    { id: "van-doorway", roadId: "alley-west", axis: "x", fixed: -14.7,
      min: -10.8, max: -7.5, side: -1, shared: true, doorway: true },
    { id: "van-rear-walk", roadId: "alley-west", axis: "z", fixed: -7.5,
      min: -20.8, max: -14.7, side: -1, shared: true, doorway: true },
    { id: "west-doorway", roadId: "alley-west", axis: "x", fixed: -23,
      min: -15.1, max: -13.75, side: 1, shared: true, doorway: true },
    { id: "visible-crossing", roadId: "alley-west", axis: "x", fixed: -23,
      min: -14.7, max: -9.3, side: 1, shared: true, doorway: true },
    { id: "case-left-walk", roadId: "alley-west", axis: "x", fixed: -23.5,
      min: -14.7, max: -13.75, side: 1, shared: true, doorway: true },
    { id: "case-right-walk", roadId: "alley-west", axis: "z", fixed: -9.3,
      min: -23, max: -22, side: -1, shared: true, doorway: true },
  ]);
}

function makeCaseAnchors(district) {
  const start = { x: -12, z: -33, heading: 0 };
  const goal = { x: -12, z: -7, heading: 0, roadId: "alley-west" };
  const left = { x: -14.7, z: -23, heading: HALF_PI };
  const right = { x: -9.3, z: -23, heading: -HALF_PI };
  const hidden = { x: -7.5, z: -18.7, heading: -HALF_PI };
  // Walk around the van's far end while the front camera is still approaching.
  const emergence = { ...hidden, z: -16.8 };
  const emergenceTarget = { x: -13.75, z: -14.7 };
  const specs = [
    ["visible-left", left, right, 2, null],
    ["visible-right", right, left, 2, null],
    ["diagonal-hesitant", { ...left, z: -23.5 }, { ...right, z: -22 }, 2, null],
    ["partial-occluded-history", { ...hidden, z: -14.7 }, { x: -13.75, z: -14.7 }, 1, "same-occluder-empty"],
    ["fully-hidden-emergence", emergence, emergenceTarget, 0.5, "same-occluder-empty"],
    ["same-occluder-empty", emergence, emergenceTarget, 0.5, "fully-hidden-emergence"],
    ["stationary-curb", { x: -13.75, z: -18.7, heading: 0 },
      { x: -13.75, z: -18.7, heading: 0 }, 0, null],
    ["parallel-away", { x: -13.75, z: -20.5, heading: 0 },
      { x: -13.75, z: -9, heading: 0 }, 0, null],
    ["blind-corner-empty", hidden, left, 5, "fully-hidden-emergence"],
    ["two-car-narrow-passage", { x: 8, z: -1.4, heading: -HALF_PI },
      { x: 4, z: -40.5, heading: HALF_PI }, 0, null],
    ["queue-alternate-route", left, right, 0, null],
    ["camera-loss-recovery", left, right, 2, null],
  ];
  return specs.map(([id, actorStart, actorTarget, triggerEgoAlongM, emptyTwin]) => ({
    id, matrixCase: id, routeId: "bakery-via-west-alley", roadId: "alley-west",
    occluderId: "district-parked-van", playerStart: { ...start }, goal: { ...goal },
    actorStart: { ...actorStart }, actorTarget: { ...actorTarget },
    triggerEgoAlongM, emptyTwin, traffic: [],
    ...(id === "two-car-narrow-passage" ? {
      playerStart: { x: -32, z: -40.5, heading: HALF_PI },
      goal: { ...district.places[0] },
      waitingZoneId: "west-alley-passage",
      traffic: [{ id: "district-opposing-car", kind: "sedan",
        start: { ...actorStart, roadId: "market-local" },
        goal: { ...district.places[2] } }],
    } : id === "queue-alternate-route" ? {
      playerStart: { ...district.playerStart }, goal: { ...district.places[0] },
      traffic: [{ id: "district-loading-car", kind: "van",
        start: { x: -31, z: -40.5, heading: HALF_PI, roadId: "entry-local" },
        goal: { ...district.places[1] } }],
    } : {}),
  }));
}

/** Literal district geometry; changing a seed never moves a wall or a curb. */
export function createEgyptDistrict() {
  const drivingRoads = [
    road("entry-local", "x", -42, -58, 54, 6.4, 1.5),
    road("west-local", "z", -46, -42, 38, 6.2, 1.5),
    road("school-local", "x", 38, -46, 54, 6.2, 1.5),
    road("east-connector", "z", 54, -42, 38, 6.4, 1.5),
    road("market-local", "x", 0, -46, 54, 6, 1.4, { speedLimitMps: 4.5 }),
    road("alley-west", "z", -12, -42, 0, 3.8, 0, { speedLimitMps: 3.8 }),
    road("alley-east", "z", 20, 0, 38, 3.6, 0,
      { flow: 1, speedLimitMps: 3.5 }),
  ];
  const nodes = crossings(drivingRoads);
  const aprons = nodes.map((p, i) => {
    const inward = p.x === -12 ? (p.z === -42 ? 2.2 : -2.2)
      : p.x === 20 ? (p.z === 0 ? 2.2 : -2.2) : 0;
    return road(`turn-mouth-${i}`, "z", p.x, p.z + inward, p.z + inward, 12, 0, {
      parkingBay: true, supportApron: true, speedLimitMps: 4.5,
      junctionX: p.x, junctionZ: p.z,
    });
  });
  const roads = [...drivingRoads, ...aprons];
  const playerStart = { x: -56, z: -40.5, heading: HALF_PI, roadId: "entry-local" };
  const places = [
    { id: "district-bakery", name: "الفرن البلدي", x: 4, z: 1.4,
      heading: HALF_PI, roadId: "market-local" },
    { id: "district-school", name: "مدرسة الحي", x: 36, z: 39.5,
      heading: HALF_PI, roadId: "school-local" },
    { id: "district-workshop", name: "ورشة الحارة", x: 4, z: -40.5,
      heading: HALF_PI, roadId: "entry-local" },
  ];
  const statics = buildingPlots(roads);
  statics.push(
    { id: "district-parked-van", type: "static", kind: "parked-vehicle", vehicleKind: "van",
      x: -9.15, z: -18.7, heading: 0, width: 1.9, length: 4.6, height: 2.12 },
    { id: "district-parked-sedan", type: "static", kind: "parked-vehicle", vehicleKind: "sedan",
      x: 59.4, z: 12, heading: Math.PI, width: 1.85, length: 4.2, height: 1.48 },
    { id: "district-produce", type: "static", kind: "market-stall",
      x: -27.5, z: 5.8, heading: Math.PI, width: 2.5, length: 1.7, height: 2.3 },
  );
  const conflictZones = nodes.filter((p) => p.x !== -12).map((p, i) => ({
    id: `district-junction-${i}`, kind: "junction",
    ...roadRect(aprons.find((r) => r.junctionX === p.x && r.junctionZ === p.z)),
    approachM: 8,
  }));
  // There is no full-car exit storage between this passage and either mouth.
  // Reserve those genuinely connected conflicts together, not nearby blocks.
  conflictZones.push({
    id: "west-alley-passage", kind: "single-lane",
    minX: -18, maxX: -6, minZ: -48, maxZ: 6, approachM: 8,
    waitingSpots: [
      { x: -22, z: -40.5, heading: HALF_PI, approach: "south-west" },
      { x: -2, z: -43.5, heading: -HALF_PI, approach: "south-east" },
      { x: -22, z: 1.4, heading: HALF_PI, approach: "north-west" },
      { x: -2, z: -1.4, heading: -HALF_PI, approach: "north-east" },
    ],
  });
  const cautionZones = [
    { id: "van-frontage-north", x: -12, z: -17, heading: 0, approachM: 18,
      clearanceM: 6, visibilityDistanceM: 8, speedLimitMps: 3 },
    { id: "west-alley-north-mouth", x: -12, z: -1, heading: 0, approachM: 14,
      clearanceM: 5, visibilityDistanceM: 7, speedLimitMps: 3 },
    { id: "west-alley-south-mouth", x: -12, z: -41, heading: Math.PI, approachM: 14,
      clearanceM: 5, visibilityDistanceM: 7, speedLimitMps: 3 },
    { id: "school-alley-mouth", x: 20, z: 37, heading: 0, approachM: 14,
      clearanceM: 5, visibilityDistanceM: 7.5, speedLimitMps: 3 },
  ];
  const trafficGoals = [];
  for (const [id, positions] of [
    ["entry-local", [-31, 4, 35]], ["west-local", [-24, 19]],
    ["school-local", [-30, 3, 37]], ["east-connector", [-24, 19]],
    ["market-local", [-30, 4, 37]],
  ]) {
    const street = drivingRoads.find((r) => r.id === id);
    for (const along of positions)
      for (const side of [-1, 1])
        trafficGoals.push({ id: `${id}-goal-${along}-${side}`, roadId: id,
          ...districtRoadPose(street, along, side) });
  }
  const trafficSpawns = [];
  const shape = { type: "vehicle", length: 4.2, width: 1.85, heading: 0 };
  for (const id of ["entry-local", "school-local", "west-local", "east-connector", "market-local"]) {
    const street = drivingRoads.find((r) => r.id === id);
    for (let along = street.min + 12; along <= street.max - 11; along += 10)
      for (const side of [1, -1]) {
        const candidate = { ...districtRoadPose(street, along, side), roadId: id };
        const body = { ...shape, ...candidate };
        if (distance(candidate, playerStart) < 14 || !bodyOnRoad(body, roads, 0.12)
            || statics.some((s) => overlaps(body, s, 0.12))
            || trafficSpawns.some((s) => overlaps(body, { ...shape, ...s }, 0.8))
            || conflictZones.some((zone) => overlaps(body, {
              x: (zone.minX + zone.maxX) / 2, z: (zone.minZ + zone.maxZ) / 2,
              width: zone.maxX - zone.minX, length: zone.maxZ - zone.minZ, heading: 0,
            }, 0.3))) continue;
        trafficSpawns.push(candidate);
      }
  }
  const walkways = makeWalkways(drivingRoads);
  const pedestrianSpawns = [];
  for (let round = 0; round < 20; round++)
    for (const walkway of walkways.filter((w) => !w.doorway)) {
      const along = walkway.min + 1 + round * 7;
      if (along > walkway.max - 1) continue;
      const candidate = {
        x: walkway.axis === "z" ? walkway.fixed : along,
        z: walkway.axis === "x" ? walkway.fixed : along,
        heading: walkway.axis === "z" ? 0 : HALF_PI,
        roadId: walkway.roadId, walkwayId: walkway.id, side: walkway.side, along,
      };
      const body = { ...candidate, type: "pedestrian", radius: 0.38 };
      if (statics.some((s) => overlaps(body, s, 0.12))
          || overlaps(body, { ...shape, ...playerStart }, 0.12)
          || trafficSpawns.some((s) => overlaps(body, { ...shape, ...s }, 0.12))
          || pedestrianSpawns.some((s) => distance(s, body) < 1)) continue;
      pedestrianSpawns.push(candidate);
    }
  if (trafficSpawns.length < 28 || pedestrianSpawns.length < 32)
    throw new Error(`District authored capacity is too small: ${trafficSpawns.length}/${pedestrianSpawns.length}`);
  const showcaseRoutes = places.map((goal, i) => ({
    id: ["bakery-via-west-alley", "school-via-east-alley", "workshop-via-west-alley"][i],
    start: { ...(i ? places[i - 1] : playerStart) }, goal: { ...goal },
    mustUseRoadIds: [i === 1 ? "alley-east" : "alley-west"],
  }));
  const district = {
    id: "egypt-district-v1", version: 1, drivingRoads, roads, statics, places,
    playerStart, trafficSpawns, pedestrianSpawns, trafficGoals, walkways,
    conflictZones, cautionZones, showcaseRoutes,
  };
  district.caseAnchors = makeCaseAnchors(district);
  return district;
}
