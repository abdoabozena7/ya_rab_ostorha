import { VEHICLE } from "./config.js";
import { createEgyptDistrict, districtRoadPose } from "./egypt-district.js";
import {
  bodyOnRoad,
  distance,
  isDiagonalRoad,
  makeDiagonalRoad,
  overlaps,
  roadFrame,
  roadIntersection,
  roadPointAt,
  roadPoseAt,
  roadRect,
} from "./geometry.js";
import { PLACES } from "./places.js";
import { SpatialIndex } from "./spatial-index.js";
import { PLAYER_VEHICLE } from "./vehicle-spec.js";

const HALF_PI = Math.PI / 2;
const GATE_X = -96;
const SOUTH_LINK_X = -32;
const SOUTH_LINK = "bab-el-louk-link";
const START_ROAD = "tahrir-boulevard";
const CAR = { type: "vehicle", width: VEHICLE.width, length: VEHICLE.length };
const WALKER = { type: "pedestrian", radius: 0.38 };
const LEGACY_POPULATION_LIMITS = { traffic: 72, pedestrians: 96 };
export const METRO_POPULATION_LIMITS = Object.freeze({ traffic: 96, pedestrians: 120 });
export const RUSH_CITY_POPULATION_LIMITS = Object.freeze({ traffic: 96, pedestrians: 144 });
// Higher ambient car counts can gridlock the narrow neighborhood connector.
export const RUSH_CITY_POPULATION_DEFAULTS = Object.freeze({ traffic: 36, pedestrians: 80 });
export const GRAND_CITY_POPULATION_LIMITS = Object.freeze({ traffic: 140, pedestrians: 220 });
export const GRAND_CITY_POPULATION_DEFAULTS = Object.freeze({ traffic: 68, pedestrians: 135 });

const avenue = (id, axis, fixed, min, max, width, laneOffsetM, speedLimitMps) => ({
  id, axis, fixed, min, max, width, laneOffsetM, speedLimitMps, flow: 0,
  zone: "avenue", marking: "center",
});
const local = (id, axis, fixed, min, max, width, laneOffsetM, speedLimitMps) => ({
  ...avenue(id, axis, fixed, min, max, width, laneOffsetM, speedLimitMps),
  zone: "neighborhood", marking: "none", sideStreet: true,
});
const lane = (road, along, side = 1) => ({
  ...districtRoadPose(road, along, side), roadId: road.id,
});
const box = ({ minX, maxX, minZ, maxZ }) => ({
  x: (minX + maxX) / 2, z: (minZ + maxZ) / 2, width: maxX - minX,
  length: maxZ - minZ, heading: 0,
});
const sidewalkPreference = (road) => road.zone === "avenue" ? "avenue" : "market";
const position = (line, along) => line.axis === "z"
  ? { x: line.fixed, z: along } : { x: along, z: line.fixed };
const crossing = (a, b) => a.axis !== b.axis && a.fixed >= b.min && a.fixed <= b.max
  && b.fixed >= a.min && b.fixed <= a.max;

function avenueNetwork() {
  return [
    avenue("corniche-avenue", "z", -278, -112, 90, 14, 2.7, 10.5),
    avenue("civic-avenue", "z", -183, -112, 90, 12, 2.5, 9.5),
    avenue("gateway-avenue", "z", GATE_X, -112, 90, 12, 2.5, 9),
    avenue(START_ROAD, "x", -112, -278, SOUTH_LINK_X, 14, 2.7, 10.5),
    avenue("station-avenue", "x", -75, -278, GATE_X, 12, 2.5, 9.5),
    local("souq-collector", "x", 8, -278, GATE_X, 10, 2.2, 6.5),
    avenue("university-avenue", "x", 90, -278, GATE_X, 12, 2.5, 9.5),
    local(SOUTH_LINK, "z", SOUTH_LINK_X, -112, -42, 8.6, 2, 6.5),
  ];
}

function newJunctionAprons(added, drivingRoads) {
  const junctions = new Map(), newIds = new Set(added.map((road) => road.id));
  for (const vertical of drivingRoads.filter((road) => road.axis === "z"))
    for (const horizontal of drivingRoads.filter((road) => road.axis === "x")) {
      if ((!newIds.has(vertical.id) && !newIds.has(horizontal.id))
          || !crossing(vertical, horizontal)) continue;
      const { fixed: x } = vertical, { fixed: z } = horizontal;
      junctions.set(`${x}:${z}`, {
        id: `metro-mouth-${x}-${z}`, axis: "z", fixed: x, min: z, max: z,
        width: 16, laneOffsetM: 0, flow: 0, speedLimitMps: 4.5,
        zone: vertical.zone === "avenue" || horizontal.zone === "avenue" ? "avenue" : "neighborhood",
        marking: "none", parkingBay: true, supportApron: true,
        junctionX: x, junctionZ: z,
      });
    }
  return [...junctions.values()];
}

function newWalkways(frontages) {
  return frontages.flatMap((street) => [-1, 1].map((side) => ({
    id: `${street.id}-metro-walk-${side}`, roadId: street.id, axis: street.axis,
    fixed: street.fixed + (street.axis === "z" ? -side : side) * (street.width / 2 + 1.65),
    min: street.min + 7, max: street.max - 7, side, shared: false,
    roadPreference: sidewalkPreference(street),
  })));
}

function newBuildings(frontages, roads, walkways, original) {
  const reserved = [
    ...roads.map((road) => box(roadRect(road))),
    ...walkways.map((line) => box(roadRect({ ...line, width: 1.7 }))),
    ...original,
  ];
  const buildings = [];
  for (const [index, street] of frontages.entries()) {
    const architecture = street.zone === "avenue" ? "boulevard" : "neighborhood";
    for (const side of [-1, 1])
      for (let i = 0, along = street.min + 22 + (side + 1) * 2;
        along <= street.max - 12; i++, along += 32) {
        const style = (i * 3 + index + (side > 0 ? 2 : 0)) % 5;
        const width = [16, 20, 23, 18, 22][style];
        const length = [14, 17, 15, 19, 16][style];
        const fixed = street.fixed + side * (street.width / 2 + 3.4 + length / 2);
        const site = {
          ...position({ ...street, fixed }, along),
          id: `${street.id}-frontage-${side}-${i}`, type: "static", kind: "building",
          architecture, width, length,
          height: architecture === "boulevard" ? [23, 28, 19, 33, 25][style]
            : [11, 16, 12, 18, 14][style],
          heading: street.axis === "z" ? -side * HALF_PI : side === 1 ? Math.PI : 0,
        };
        if (!reserved.some((other) => overlaps(site, other, 0.35))) {
          buildings.push(site);
          reserved.push(site);
        }
      }
  }
  return buildings;
}

function streetSpans(road, streets) {
  const cuts = [...new Set([road.min, road.max,
    ...streets.filter((other) => crossing(road, other)).map((other) => other.fixed),
  ])].sort((a, b) => a - b);
  return cuts.slice(1).map((max, i) => ({ road, min: cuts[i], max }));
}

function interleave(groups) {
  const results = [];
  for (let index = 0; index < Math.max(...groups.map((group) => group.length)); index++)
    for (const group of groups)
      if (index < group.length) results.push(group[index]);
  return results;
}

function spreadByRoad(poses) {
  const groups = new Map();
  for (const pose of poses) {
    if (!groups.has(pose.roadId)) groups.set(pose.roadId, []);
    groups.get(pose.roadId).push(pose);
  }
  return interleave([...groups.values()]);
}

function populateTraffic(city, widerSpans, originalSpawns, target) {
  const vehicles = [], conflictBodies = city.conflictZones.map(box);
  const positions = [0.5, 0.28, 0.72, 0.15, 0.85];
  const candidates = positions.flatMap((fraction) => [-1, 1].flatMap((side) =>
    widerSpans.flatMap(({ road, min, max }, index) => {
      const sign = index % 2 ? -side : side;
      // Keep the new driver's entry lane open on the first block, not the opposite lane.
      if (road.id === START_ROAD && min < city.playerStart.x && sign === 1) return [];
      return [lane(road, min + fraction * (max - min), sign)];
    })));
  const avenueIds = new Set(city.drivingRoads.filter((road) => road.zone === "avenue").map((road) => road.id));
  const avenues = candidates.filter((pose) => avenueIds.has(pose.roadId));
  const local = candidates.filter((pose) => !avenueIds.has(pose.roadId));
  const inherited = spreadByRoad(originalSpawns);
  const groups = [
    avenues.filter((_, i) => i % 4 === 0), avenues.filter((_, i) => i % 4 === 1),
    interleave([local, inherited]),
    avenues.filter((_, i) => i % 4 === 2), avenues.filter((_, i) => i % 4 === 3),
  ];
  for (const pose of interleave(groups)) {
    const body = { ...CAR, ...pose };
    if (distance(pose, city.playerStart) < 14 || !bodyOnRoad(body, city.roads, 0.12)
        || city.statics.some((other) => overlaps(body, other, 0.12))
        || conflictBodies.some((other) => overlaps(body, other, 0.45))
        || vehicles.some((other) => overlaps(body, { ...CAR, ...other }, 0.8)
          || (pose.roadId === other.roadId && pose.heading === other.heading && distance(pose, other) < 12)))
      continue;
    vehicles.push(pose);
    if (vehicles.length === target) break;
  }
  return vehicles;
}

function populateWalkers(city, original, addedWalkways, target) {
  const avenues = addedWalkways.filter((line) => line.roadPreference === "avenue");
  const local = addedWalkways.filter((line) => line.roadPreference === "market");
  const addedSpawns = (lines) => Array.from({ length: 16 }, (_, round) =>
    lines.map((line, i) => {
      // Disperse the first pass along the whole street, not just near the first corner.
      const fraction = ((round * 7 + i * 5 + 2) % 17 + 0.5) / 17;
      const along = line.min + 1 + fraction * (line.max - line.min - 2);
      return {
        ...position(line, along), along, side: line.side, roadId: line.roadId,
        heading: line.axis === "z" ? 0 : HALF_PI, walkwayId: line.id,
        roadPreference: line.roadPreference,
      };
    })).flat();
  const locals = addedSpawns(local), boulevard = addedSpawns(avenues);
  const old = spreadByRoad(original).map((pose) => ({ ...pose, roadPreference: "market" }));
  const candidates = interleave([
    boulevard.filter((_, i) => i % 2 === 0), old,
    boulevard.filter((_, i) => i % 2 !== 0), locals,
  ]);
  const vehicles = city.trafficSpawns.map((spawn) => ({ ...CAR, ...spawn }));
  const player = { ...CAR, ...city.playerStart, length: PLAYER_VEHICLE.lengthM, width: PLAYER_VEHICLE.widthM };
  const pavement = target > METRO_POPULATION_LIMITS.pedestrians
    ? city.roads.map((road) => ({ ...box(roadRect(road)), id: road.id })) : [];
  const pedestrians = [];
  for (const pose of candidates) {
    const body = { ...WALKER, ...pose };
    if (city.statics.some((other) => overlaps(body, other, 0.12))
        || overlaps(body, player, 0.12) || vehicles.some((other) => overlaps(body, other, 0.12))
        || pedestrians.some((other) => distance(pose, other) < 1.4)) continue;
    // Keep the entire v3 prefix. New residents start off the roadway unless
    // their walkline explicitly shares that street (never an intersecting lane or apron).
    if (pedestrians.length >= METRO_POPULATION_LIMITS.pedestrians) {
      const line = city.walkways.find(({ id }) => id === pose.walkwayId);
      if (pavement.some((road) => (!line.shared || road.id !== line.roadId)
          && overlaps(body, road, 0.12))) continue;
    }
    pedestrians.push(pose);
    if (pedestrians.length === target) break;
  }
  return pedestrians;
}

const PARKED_SPECS = [
  { vehicleKind: "sedan", width: 1.84, length: 4.30, height: 1.48 },
  { vehicleKind: "suv", width: 1.92, length: 4.62, height: 1.82 },
  { vehicleKind: "van", width: 1.94, length: 4.72, height: 1.94 },
  { vehicleKind: "taxi", width: 1.83, length: 4.24, height: 1.54 },
  { vehicleKind: "pickup", width: 1.92, length: 4.66, height: 1.78 },
  { vehicleKind: "tuktuk", width: 1.82, length: 4.16, height: 1.72 },
];

const GRAND_SURVEILLANCE_ZONES = [
  { id: "tahrir-plaza", minX: -305, maxX: -140, minZ: -165, maxZ: -45 },
  { id: "qasr-west", minX: -415, maxX: -245, minZ: -60, maxZ: 125 },
  { id: "talaat-corridor", minX: -205, maxX: -65, minZ: -125, maxZ: 115 },
  { id: "historic-quarter", minX: -80, maxX: 75, minZ: -70, maxZ: 60 },
  { id: "khan-bazaar", minX: 70, maxX: 315, minZ: -135, maxZ: 115 },
  { id: "ramses-approach", minX: -115, maxX: 215, minZ: 75, maxZ: 255 },
  { id: "garden-south", minX: -295, maxX: -20, minZ: -295, maxZ: -150 },
  { id: "citadel-approach", minX: 40, maxX: 320, minZ: -295, maxZ: -115 },
];

const normalizeAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

const grandLane = (road, along, side = 1) => ({
  ...(isDiagonalRoad(road) ? roadPoseAt(road, along, side) : districtRoadPose(road, along, side)),
  roadId: road.id,
});

function orientedRoadBody(road, extraWidth = 0) {
  if (isDiagonalRoad(road)) {
    return {
      id: road.id,
      type: "static",
      x: (road.x1 + road.x2) / 2,
      z: (road.z1 + road.z2) / 2,
      width: road.width + extraWidth * 2,
      length: road.length + road.width + extraWidth * 2,
      heading: road.heading,
    };
  }
  return { id: road.id, type: "static", ...box(roadRect(road, -extraWidth)) };
}

function orientedWalkwayBody(line) {
  if (isDiagonalRoad(line)) {
    return {
      id: line.id,
      type: "static",
      x: line.x1 + (line.ux * line.length) / 2,
      z: line.z1 + (line.uz * line.length) / 2,
      width: 1.8,
      length: line.length + 0.6,
      heading: Math.atan2(line.ux, line.uz),
    };
  }
  return { id: line.id, type: "static", ...box(roadRect({ ...line, width: 1.8 })) };
}

function grandAvenueNetwork() {
  return [
    // North-South arterial & staggered collector corridors (x in [-520, +420])
    avenue("nile-west-boulevard", "z", -520, -420, 360, 14, 2.7, 11.0),
    avenue("opera-avenue", "z", -380, -420, 360, 13, 2.6, 10.0),
    avenue("corniche-avenue", "z", -278, -420, 360, 14, 2.7, 10.5),
    avenue("civic-avenue", "z", -183, -420, 360, 13, 2.6, 9.8),
    avenue("gateway-avenue", "z", GATE_X, -420, 360, 13, 2.6, 9.5),
    local(SOUTH_LINK, "z", SOUTH_LINK_X, -312, -42, 9.2, 2.0, 6.8),
    local("khan-market-street", "z", 124, -112, 238, 11.4, 2.2, 6.8),
    avenue("azhar-avenue", "z", 188, -420, 360, 13, 2.6, 9.8),
    avenue("abbassia-avenue", "z", 300, -420, 360, 13, 2.6, 10.0),
    avenue("citadel-east-ring", "z", 420, -420, 360, 14, 2.7, 11.0),

    // East-West arterial & staggered collector corridors (z in [-420, +360])
    avenue("south-ring-arterial", "x", -420, -520, 420, 14, 2.7, 11.0),
    avenue("garden-city-avenue", "x", -312, -520, 420, 13, 2.6, 9.8),
    local("qasr-el-aini-collector", "x", -186, -380, GATE_X, 10.6, 2.2, 7.2),
    avenue(START_ROAD, "x", -112, -520, 420, 14, 2.7, 10.5),
    avenue("station-avenue", "x", -75, -380, GATE_X, 12.6, 2.5, 9.5),
    local("souq-collector", "x", 8, -380, GATE_X, 11.4, 2.2, 6.8),
    avenue("university-avenue", "x", 90, -520, 420, 13, 2.6, 9.8),
    local("hussein-collector", "x", 158, 124, 420, 10.6, 2.2, 7.0),
    avenue("clot-bey-avenue", "x", 238, -520, 420, 13, 2.6, 10.0),
    avenue("ramses-north-arterial", "x", 360, -520, 420, 14, 2.7, 11.0),

    // Five true Cairo diagonal boulevards & market slash streets
    makeDiagonalRoad({
      id: "qasr-diagonal",
      x1: -520,
      z1: 190,
      x2: -183,
      z2: -112,
      width: 14,
      laneOffsetM: 2.7,
      speedLimitMps: 10.5,
      zone: "avenue",
      marking: "center",
    }),
    makeDiagonalRoad({
      id: "talaat-diagonal",
      x1: -278,
      z1: -112 - 4750 / 29,
      x2: 20,
      z2: 238,
      width: 13,
      laneOffsetM: 2.6,
      speedLimitMps: 9.5,
      zone: "avenue",
      marking: "center",
    }),
    makeDiagonalRoad({
      id: "ramses-diagonal",
      x1: -96,
      z1: 90,
      x2: 264,
      z2: 360,
      width: 13,
      laneOffsetM: 2.6,
      speedLimitMps: 10.0,
      zone: "avenue",
      marking: "center",
    }),
    makeDiagonalRoad({
      id: "bazaar-slash",
      x1: 300,
      z1: -112,
      x2: 124,
      z2: 90,
      width: 9.6,
      laneOffsetM: 2.1,
      speedLimitMps: 6.8,
      zone: "neighborhood",
      marking: "none",
      sideStreet: true,
    }),
    makeDiagonalRoad({
      id: "citadel-diagonal",
      x1: -96,
      z1: -420,
      x2: 420,
      z2: -112,
      width: 13.4,
      laneOffsetM: 2.6,
      speedLimitMps: 10.2,
      zone: "avenue",
      marking: "center",
    }),
  ];
}

function grandJunctionsAndAprons(added, drivingRoads) {
  const newIds = new Set(added.map((r) => r.id));
  const allJunctions = [];
  const apronNodes = [];

  for (let i = 0; i < drivingRoads.length; i++) {
    const a = drivingRoads[i];
    for (let j = i + 1; j < drivingRoads.length; j++) {
      const b = drivingRoads[j];
      const hit = roadIntersection(a, b, 0.5);
      if (!hit) continue;
      let shared = allJunctions.find((p) => Math.hypot(p.x - hit.x, p.z - hit.z) <= 0.65);
      if (!shared) {
        shared = { x: hit.x, z: hit.z, roadIds: new Set() };
        allJunctions.push(shared);
      }
      shared.roadIds.add(a.id);
      shared.roadIds.add(b.id);

      const isExtendedHistoric = hit.x < -58 || hit.x > 54;
      if (!newIds.has(a.id) && !newIds.has(b.id) && !isExtendedHistoric) continue;
      const diag = isDiagonalRoad(a) || isDiagonalRoad(b);
      const tahrirHub = Math.hypot(hit.x - -183, hit.z - -112) < 1.5;
      const width = tahrirHub ? 22 : diag ? 22 : 18;
      const zone = a.zone === "avenue" || b.zone === "avenue" ? "avenue" : "neighborhood";
      const existing = apronNodes.find((p) => Math.hypot(p.x - hit.x, p.z - hit.z) <= 0.65);
      if (existing) {
        existing.width = Math.max(existing.width, width);
        if (zone === "avenue") existing.zone = "avenue";
      } else {
        apronNodes.push({ x: hit.x, z: hit.z, width, zone });
      }
    }
  }

  const aprons = apronNodes.map((node, index) => ({
    id: `grand-mouth-${index}-${Math.round(node.x)}-${Math.round(node.z)}`,
    axis: "z",
    fixed: node.x,
    min: node.z,
    max: node.z,
    width: node.width,
    laneOffsetM: 0,
    flow: 0,
    speedLimitMps: 4.5,
    zone: node.zone,
    marking: "none",
    parkingBay: true,
    supportApron: true,
    junctionX: node.x,
    junctionZ: node.z,
  }));

  return { allJunctions, aprons };
}

function mergeGrandConflictZones(baseZones, aprons) {
  const zones = [
    ...baseZones.map((z) => ({ ...z })),
    ...aprons.map((road) => ({
      id: `${road.id}-conflict`,
      kind: "junction",
      ...roadRect(road),
      approachM: 8,
    })),
  ];
  let merged = true;
  while (merged) {
    merged = false;
    for (let i = 0; i < zones.length; i++) {
      const a = zones[i];
      if (a.kind !== "junction") continue;
      for (let j = i + 1; j < zones.length; j++) {
        const b = zones[j];
        if (b.kind !== "junction") continue;
        const gapX = Math.max(0, Math.max(a.minX, b.minX) - Math.min(a.maxX, b.maxX));
        const gapZ = Math.max(0, Math.max(a.minZ, b.minZ) - Math.min(a.maxZ, b.maxZ));
        if (Math.hypot(gapX, gapZ) > 5.2) continue;
        zones[i] = {
          ...a,
          id: a.id.length <= 48 ? `${a.id}+${b.id.slice(-8)}` : a.id,
          approachM: Math.max(a.approachM, b.approachM),
          minX: Math.min(a.minX, b.minX),
          maxX: Math.max(a.maxX, b.maxX),
          minZ: Math.min(a.minZ, b.minZ),
          maxZ: Math.max(a.maxZ, b.maxZ),
        };
        zones.splice(j--, 1);
        merged = true;
      }
    }
  }
  return zones;
}

function grandStreetWalkways(frontages) {
  const lines = [];
  for (const street of frontages) {
    const endInset = 7;
    const offset = street.width / 2 + 1.65;
    if (isDiagonalRoad(street)) {
      const len = street.length - endInset * 2;
      if (len < 12) continue;
      for (const side of [-1, 1]) {
        const p1 = roadPointAt(street, endInset, side * offset);
        const p2 = roadPointAt(street, street.length - endInset, side * offset);
        lines.push(makeDiagonalRoad({
          id: `${street.id}-metro-walk-${side}`,
          x1: p1.x,
          z1: p1.z,
          x2: p2.x,
          z2: p2.z,
          width: 1.7,
          roadId: street.id,
          side,
          shared: false,
          roadPreference: sidewalkPreference(street),
        }));
      }
      continue;
    }
    if (street.max - street.min < 18) continue;
    for (const side of [-1, 1]) {
      lines.push({
        id: `${street.id}-metro-walk-${side}`,
        roadId: street.id,
        axis: street.axis,
        fixed: street.fixed + (street.axis === "z" ? -side : side) * offset,
        min: street.min + endInset,
        max: street.max - endInset,
        side,
        shared: false,
        roadPreference: sidewalkPreference(street),
      });
    }
  }
  return lines;
}

function grandHotspotCrosswalks(roadById, allJunctions) {
  // Curb-to-curb crosswalk lines stop ~0.65m inside the parallel sidewalks so walkers
  // shuttle across the street in waves rather than permanently diverting away from the crossing.
  const specs = [
    // Crowd Hotspot 1: Tahrir Midan & East Boulevard (48-120m ahead of playerStart at x=-254)
    ["tahrir-midan-crowd", START_ROAD, -206.5],
    ["tahrir-midan-crowd", START_ROAD, -198.5],
    ["tahrir-midan-crowd", START_ROAD, -191.8],
    ["tahrir-midan-crowd", START_ROAD, -174.2],
    ["tahrir-midan-crowd", START_ROAD, -165.0],
    ["tahrir-midan-crowd", START_ROAD, -155.5],
    ["tahrir-midan-crowd", START_ROAD, -144.5],
    ["tahrir-midan-crowd", START_ROAD, -134.0],
    ["tahrir-midan-crowd", "civic-avenue", -126.5],
    ["tahrir-midan-crowd", "civic-avenue", -97.5],

    // Crowd Hotspot 2: Khan El-Khalili / Al-Azhar Bazaar
    ["khan-market-crowd", "khan-market-street", -18.0],
    ["khan-market-crowd", "khan-market-street", 14.0],
    ["khan-market-crowd", "khan-market-street", 56.0],
    ["khan-market-crowd", "khan-market-street", 74.0],
    ["khan-market-crowd", "azhar-avenue", -12.0],
    ["khan-market-crowd", "azhar-avenue", 44.0],
    ["khan-market-crowd", "azhar-avenue", 68.0],

    // Crowd Hotspot 3: Ramses / Gateway Station Promenade
    ["ramses-station-crowd", "gateway-avenue", 20.0],
    ["ramses-station-crowd", "gateway-avenue", 54.0],
    ["ramses-station-crowd", "gateway-avenue", 74.0],
    ["ramses-station-crowd", "university-avenue", -118.0],
    ["ramses-station-crowd", "university-avenue", -81.5],
    ["ramses-station-crowd", "souq-collector", -134.0],
  ];

  const crosswalks = [];
  for (const [hotspotId, roadId, alongPos] of specs) {
    const street = roadById.get(roadId);
    if (!street || isDiagonalRoad(street)) continue;
    const center = street.axis === "z"
      ? { x: street.fixed, z: alongPos }
      : { x: alongPos, z: street.fixed };
    if (allJunctions.some((j) => Math.hypot(j.x - center.x, j.z - center.z) < 11.5)) continue;
    const halfSpan = street.width / 2 + 1.02;
    crosswalks.push({
      id: `${hotspotId}-xwalk-${roadId}-${Math.round(alongPos)}`,
      hotspotId,
      roadId,
      axis: street.axis === "z" ? "x" : "z",
      fixed: alongPos,
      min: street.fixed - halfSpan,
      max: street.fixed + halfSpan,
      side: 1,
      shared: true,
      crosswalk: true,
      roadPreference: sidewalkPreference(street),
    });
  }
  return crosswalks;
}

function grandBuildings(frontages, roads, walkways, retainedStatics) {
  const reserved = [
    ...roads.map((road) => orientedRoadBody(road, 0)),
    ...walkways.map((line) => orientedWalkwayBody(line)),
    ...retainedStatics,
  ];
  const reservedIndex = new SpatialIndex(reserved, 40);
  const maxReservedReach = reserved.reduce(
    (m, r) => Math.max(m, Math.hypot(r.width ?? 0, r.length ?? 0) / 2),
    30,
  );
  const buildingIndex = new SpatialIndex([], 48);
  const buildings = [];

  const orderedFrontages = [
    ...frontages.filter((s) => isDiagonalRoad(s) && s.zone === "avenue"),
    ...frontages.filter((s) => !isDiagonalRoad(s) && s.zone === "avenue"),
    ...frontages.filter((s) => isDiagonalRoad(s) && s.zone !== "avenue"),
    ...frontages.filter((s) => !isDiagonalRoad(s) && s.zone !== "avenue"),
  ];

  const blvdWidths = [32, 36, 42, 46, 50, 38, 44, 54];
  const blvdLengths = [22, 24, 26, 28, 24, 30, 26, 22];
  const blvdHeights = [30, 36, 42, 48, 53, 33, 45, 56];

  const nbhdWidths = [24, 28, 31, 35, 38];
  const nbhdLengths = [18, 20, 22, 24, 26];
  const nbhdHeights = [19, 23, 27, 31, 34];

  const courtyardGaps = [10.0, 11.2, 12.4, 9.8, 11.8, 12.6];

  for (const [sIdx, street] of orderedFrontages.entries()) {
    const frame = roadFrame(street);
    const boulevard = street.zone === "avenue";
    const architecture = boulevard ? "boulevard" : "neighborhood";
    const setback = boulevard ? 4.0 : 3.7;

    for (const side of [-1, 1]) {
      let along = frame.minAlong + 16 + (side > 0 ? 3 : 0);
      let slot = 0;
      while (along <= frame.maxAlong - 16) {
        const hashIdx = (slot * 5 + sIdx * 3 + (side > 0 ? 2 : 0)) >>> 0;
        const width = boulevard
          ? blvdWidths[hashIdx % blvdWidths.length]
          : nbhdWidths[hashIdx % nbhdWidths.length];
        const length = boulevard
          ? blvdLengths[hashIdx % blvdLengths.length]
          : nbhdLengths[hashIdx % nbhdLengths.length];
        const height = boulevard
          ? blvdHeights[(hashIdx + slot) % blvdHeights.length]
          : nbhdHeights[(hashIdx + slot) % nbhdHeights.length];

        if (along + width / 2 > frame.maxAlong - 11) break;

        const centerAlong = along + width / 2;
        const lateral = side * (street.width / 2 + setback + length / 2);
        const pt = roadPointAt(street, centerAlong, lateral);
        const heading = normalizeAngle(frame.heading + side * HALF_PI);

        const site = {
          id: `${street.id}-grand-${side > 0 ? "p" : "n"}-${slot}`,
          type: "static",
          kind: "building",
          architecture,
          x: pt.x,
          z: pt.z,
          width,
          length,
          height,
          heading,
        };

        const siteRadius = Math.hypot(width, length) / 2;
        const nearReserved = reservedIndex.near(site, maxReservedReach + siteRadius + 2);
        const hitsRoadOrWalk = nearReserved.some((other) => overlaps(site, other, 0.65));
        if (hitsRoadOrWalk) {
          along += 9.5;
          continue;
        }
        const nearBuildings = buildingIndex.near(site, 36 + siteRadius);
        const hitsBuilding = nearBuildings.some((other) => overlaps(site, other, 6.2));
        if (hitsBuilding) {
          along += 9.5;
          continue;
        }

        buildings.push(site);
        buildingIndex.add(site);
        const gap = courtyardGaps[(hashIdx + slot) % courtyardGaps.length];
        along += width + gap;
        slot++;
      }
    }
  }
  return buildings;
}

function grandStreetSpans(road, drivingRoads) {
  const frame = roadFrame(road);
  const cuts = [frame.minAlong, frame.maxAlong];
  for (const other of drivingRoads) {
    if (other === road) continue;
    const hit = roadIntersection(road, other, 0.5);
    if (!hit) continue;
    cuts.push(Math.max(frame.minAlong, Math.min(frame.maxAlong, hit.alongA)));
  }
  const sorted = [...cuts]
    .sort((a, b) => a - b)
    .filter((v, i, arr) => i === 0 || v - arr[i - 1] > 0.5);
  const spans = [];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] - sorted[i - 1] >= 22) {
      spans.push({ road, min: sorted[i - 1], max: sorted[i] });
    }
  }
  return spans;
}

function grandParkedVehicles(
  drivingRoads,
  roads,
  statics,
  crosswalks,
  allJunctions,
  playerStart,
  protectedGoals,
) {
  const parked = [];
  const pocketDefs = [
    {
      id: "tahrir-chicane-pocket",
      name: "جيب ركن التحرير",
      roadId: START_ROAD,
      x: -226,
      z: -112,
      radiusM: 92,
      minAlong: -360,
      maxAlong: -135,
      vehicleIds: [],
    },
    {
      id: "talaat-curb-pocket",
      name: "ركن طلعت حرب المائل",
      roadId: "talaat-diagonal",
      x: -135,
      z: -32,
      radiusM: 120,
      minAlong: 20,
      maxAlong: 480,
      vehicleIds: [],
    },
    {
      id: "qasr-boulevard-pocket",
      name: "ركن قصر النيل",
      roadId: "qasr-diagonal",
      x: -348,
      z: 36,
      radiusM: 125,
      minAlong: 20,
      maxAlong: 430,
      vehicleIds: [],
    },
    {
      id: "khan-bazaar-pocket",
      name: "ركن خان الخليلي",
      roadId: "khan-market-street",
      x: 124,
      z: 65,
      radiusM: 115,
      minAlong: -90,
      maxAlong: 215,
      vehicleIds: [],
    },
  ];

  const candidateRoadIds = [
    START_ROAD,
    "khan-market-street",
    "talaat-diagonal",
    "qasr-diagonal",
    "ramses-diagonal",
    "citadel-diagonal",
    "corniche-avenue",
    "civic-avenue",
    "gateway-avenue",
    "azhar-avenue",
    "souq-collector",
    "university-avenue",
    "abbassia-avenue",
    "opera-avenue",
  ];

  const crosswalkPoints = crosswalks.flatMap((cw) => [
    cw.axis === "z" ? { x: cw.fixed, z: cw.min } : { x: cw.min, z: cw.fixed },
    cw.axis === "z" ? { x: cw.fixed, z: (cw.min + cw.max) / 2 } : { x: (cw.min + cw.max) / 2, z: cw.fixed },
    cw.axis === "z" ? { x: cw.fixed, z: cw.max } : { x: cw.max, z: cw.fixed },
  ]);
  const suvProbe = {
    type: "vehicle",
    width: PLAYER_VEHICLE.widthM,
    length: PLAYER_VEHICLE.lengthM,
  };

  let specCounter = 0;
  const tryPlaceOnRoad = (road, along, side, minSameRoadGap) => {
    const wide = road.width >= 12.5;
    const spec = wide
      ? PARKED_SPECS[specCounter % PARKED_SPECS.length]
      : PARKED_SPECS[specCounter % 2 === 0 ? 0 : 3];
    const absLat = wide ? road.width / 2 - 1.14 : road.width / 2 - 1.07;
    const pose = isDiagonalRoad(road)
      ? roadPoseAt(road, along, side, side * absLat)
      : (() => {
        const pt = roadPointAt(road, along, side * absLat);
        const heading = road.axis === "z"
          ? (side === 1 ? 0 : Math.PI)
          : side * HALF_PI;
        return { x: pt.x, z: pt.z, heading };
      })();

    const candidate = {
      id: `grand-parked-${road.id}-${parked.length}`,
      type: "static",
      kind: "parked-vehicle",
      vehicleKind: spec.vehicleKind,
      x: pose.x,
      z: pose.z,
      heading: pose.heading,
      width: spec.width,
      length: spec.length,
      height: spec.height,
      roadId: road.id,
    };

    if (distance(candidate, playerStart) < 18) return false;
    if (allJunctions.some((j) => distance(candidate, j) < 25)) return false;
    if (crosswalkPoints.some((p) => distance(candidate, p) < 8.5)) return false;
    if (protectedGoals.some((g) => distance(candidate, g) < 12)) return false;
    if (!bodyOnRoad(candidate, [road], 0.14) || !bodyOnRoad(candidate, roads, 0.14)) return false;
    if (
      drivingRoads.some(
        (other) => other !== road && overlaps(candidate, orientedRoadBody(other, 1.2), 0.2),
      )
    ) {
      return false;
    }

    for (const delta of [-4, 0, 4]) {
      const checkAlong = Math.max(road.min + 4, Math.min(road.max - 4, along + delta));
      const lanePosA = grandLane(road, checkAlong, 1);
      const lanePosB = grandLane(road, checkAlong, -1);
      if (
        overlaps({ ...suvProbe, ...lanePosA }, candidate, 0.35) ||
        overlaps({ ...suvProbe, ...lanePosB }, candidate, 0.35)
      ) {
        return false;
      }
    }
    if (
      statics.some((s) => overlaps(candidate, s, 0.6)) ||
      parked.some(
        (p) =>
          overlaps(candidate, p, 1.2) ||
          (p.roadId === road.id && distance(p, candidate) < minSameRoadGap),
      )
    ) {
      return false;
    }

    parked.push(candidate);
    specCounter++;
    for (const pocket of pocketDefs) {
      if (pocket.roadId === road.id && distance(candidate, pocket) <= pocket.radiusM) {
        pocket.vehicleIds.push(candidate.id);
      }
    }
    return true;
  };

  // Phase 1: Seed dense staggered chicane pockets in each of the 4 featured hotspots.
  for (const pocket of pocketDefs) {
    const road = drivingRoads.find((r) => r.id === pocket.roadId);
    if (!road) continue;
    const spans = grandStreetSpans(road, drivingRoads);
    let toggle = 1;
    for (const span of spans) {
      if (span.max < pocket.minAlong || span.min > pocket.maxAlong) continue;
      for (let along = span.min + 26; along <= span.max - 26; along += 15.5) {
        if (pocket.vehicleIds.length >= 7) break;
        const side = toggle;
        toggle = -toggle;
        tryPlaceOnRoad(road, along, side, 12.5);
      }
    }
  }

  // Phase 2: Populate curbside parked vehicles across the wider boulevard & market network.
  for (const roadId of candidateRoadIds) {
    const road = drivingRoads.find((r) => r.id === roadId);
    if (!road || road.width < 10.6) continue;
    const spans = grandStreetSpans(road, drivingRoads);
    const wide = road.width >= 12.5;
    for (const [spanIdx, span] of spans.entries()) {
      if (span.max - span.min < 54) continue;
      let toggle = spanIdx % 2 === 0 ? 1 : -1;
      const stepM = wide ? 26 : 30;
      for (let along = span.min + 26; along <= span.max - 26; along += stepM) {
        if (parked.length >= 64) break;
        const side = toggle;
        toggle = -toggle;
        tryPlaceOnRoad(road, along, side, 13.5);
      }
      if (parked.length >= 64) break;
    }
    if (parked.length >= 64) break;
  }

  return {
    parked,
    pockets: pocketDefs.map(({ minAlong, maxAlong, ...rest }) => rest),
  };
}

function populateGrandTraffic(city, spans, originalSpawns, target) {
  const vehicles = [];
  const conflictBodies = city.conflictZones.map(box);
  const staticIndex = new SpatialIndex(city.statics, 36);
  const maxStaticReach = city.statics.reduce(
    (m, s) => Math.max(m, Math.hypot(s.width ?? 0, s.length ?? 0) / 2),
    20,
  );

  const fractions = [0.5, 0.28, 0.72, 0.16, 0.84, 0.39, 0.61];
  const rawCandidates = fractions.flatMap((fraction) =>
    [-1, 1].flatMap((side) =>
      spans.flatMap(({ road, min, max }, index) => {
        if (max - min < 26) return [];
        const sign = index % 2 ? -side : side;
        if (road.flow && sign !== road.flow) return [];
        const along = min + fraction * (max - min);
        if (road.id === START_ROAD && along < city.playerStart.x + 28 && sign === 1) return [];
        return [grandLane(road, along, sign)];
      }),
    ),
  );

  const trafficHotspots = city.hotspots.traffic;
  const inTrafficHotspot = (pose) =>
    trafficHotspots.some((h) => distance(pose, h) <= h.radiusM);

  const hotspotPoses = spreadByRoad(rawCandidates.filter(inTrafficHotspot));
  const diagIds = new Set(city.drivingRoads.filter(isDiagonalRoad).map((r) => r.id));
  const diagPoses = spreadByRoad(
    rawCandidates.filter((p) => !inTrafficHotspot(p) && diagIds.has(p.roadId)),
  );
  const avenueIds = new Set(
    city.drivingRoads.filter((r) => r.zone === "avenue" && !diagIds.has(r.id)).map((r) => r.id),
  );
  const avenuePoses = spreadByRoad(
    rawCandidates.filter((p) => !inTrafficHotspot(p) && avenueIds.has(p.roadId)),
  );
  const localPoses = spreadByRoad(
    rawCandidates.filter(
      (p) => !inTrafficHotspot(p) && !diagIds.has(p.roadId) && !avenueIds.has(p.roadId),
    ),
  );
  const inherited = spreadByRoad(originalSpawns);

  // Interleave ~42% traffic hotspot + diagonal poses with citywide avenues and neighborhood collectors.
  const ordered = interleave([
    hotspotPoses.filter((_, i) => i % 2 === 0),
    avenuePoses.filter((_, i) => i % 2 === 0),
    diagPoses,
    hotspotPoses.filter((_, i) => i % 2 === 1),
    avenuePoses.filter((_, i) => i % 2 === 1),
    interleave([localPoses, inherited]),
  ]);

  for (const pose of ordered) {
    const body = { ...CAR, ...pose };
    if (distance(pose, city.playerStart) < 16) continue;
    if (!bodyOnRoad(body, city.roads, 0.12)) continue;
    const nearStatics = staticIndex.near(pose, maxStaticReach + 4);
    if (nearStatics.some((other) => overlaps(body, other, 0.2))) continue;
    if (conflictBodies.some((other) => overlaps(body, other, 0.45))) continue;
    if (
      vehicles.some(
        (other) =>
          overlaps(body, { ...CAR, ...other }, 0.85) ||
          (pose.roadId === other.roadId &&
            Math.abs(normalizeAngle(pose.heading - other.heading)) < 0.25 &&
            distance(pose, other) < 12.5),
      )
    ) {
      continue;
    }
    vehicles.push(pose);
    if (vehicles.length === target) break;
  }
  return vehicles;
}

function walkwayPointAt(line, along) {
  if (isDiagonalRoad(line)) {
    return {
      x: line.x1 + line.ux * along,
      z: line.z1 + line.uz * along,
      heading: Math.atan2(line.ux, line.uz),
    };
  }
  return {
    ...(line.axis === "z" ? { x: line.fixed, z: along } : { x: along, z: line.fixed }),
    heading: line.axis === "z" ? 0 : HALF_PI,
  };
}

function populateGrandWalkers(city, originalSpawns, addedWalkways, crosswalks, target) {
  const crowdHotspots = city.hotspots.crowds;
  const inCrowdHotspot = (p) =>
    crowdHotspots.some((h) => distance(p, h) <= h.radiusM);

  // 1. Crosswalk curb-edge spawns: start cleanly on the sidewalk ends just outside road asphalt
  // so tick 0 has 0 road/vehicle overlaps and walkers immediately step across in natural waves.
  const crosswalkCandidates = [];
  for (const cw of crosswalks) {
    for (const end of ["min", "max"]) {
      const along = end === "min" ? cw.min + 0.44 : cw.max - 0.44;
      const pt = walkwayPointAt(cw, along);
      crosswalkCandidates.push({
        x: pt.x,
        z: pt.z,
        along,
        side: end === "min" ? -1 : 1,
        roadId: cw.roadId,
        heading: end === "min" ? pt.heading : normalizeAngle(pt.heading + Math.PI),
        walkwayId: cw.id,
        roadPreference: cw.roadPreference,
      });
    }
  }

  // 2. Dense hotspot sidewalk candidates vs general citywide sidewalk candidates.
  const hotspotWalkCandidates = [];
  const cityWalkCandidates = [];
  for (let round = 0; round < 28; round++) {
    for (const [i, line] of addedWalkways.entries()) {
      const span = line.max - line.min;
      if (span < 6) continue;
      const fraction = (((round * 11 + i * 7 + 3) % 29) + 0.5) / 29;
      const along = line.min + 1.2 + fraction * (span - 2.4);
      const pt = walkwayPointAt(line, along);
      const pose = {
        x: pt.x,
        z: pt.z,
        along,
        side: line.side,
        roadId: line.roadId,
        heading: pt.heading,
        walkwayId: line.id,
        roadPreference: line.roadPreference,
      };
      if (inCrowdHotspot(pose)) hotspotWalkCandidates.push(pose);
      else cityWalkCandidates.push(pose);
    }
  }

  const hotspotPool = [...crosswalkCandidates, ...hotspotWalkCandidates];
  const old = spreadByRoad(originalSpawns).map((pose) => ({ ...pose, roadPreference: "market" }));
  const nonHotspotPool = interleave([
    cityWalkCandidates.filter((p) => p.roadPreference === "avenue"),
    cityWalkCandidates.filter((p) => p.roadPreference === "market"),
    old,
  ]);

  const staticIndex = new SpatialIndex(city.statics, 36);
  const maxStaticReach = city.statics.reduce(
    (m, s) => Math.max(m, Math.hypot(s.width ?? 0, s.length ?? 0) / 2),
    20,
  );
  const vehicleBodies = city.trafficSpawns.map((spawn) => ({ ...CAR, ...spawn }));
  const vehicleIndex = new SpatialIndex(vehicleBodies, 16);
  const player = {
    ...CAR,
    ...city.playerStart,
    length: PLAYER_VEHICLE.lengthM,
    width: PLAYER_VEHICLE.widthM,
  };
  const roadBodies = city.roads.map((road) => orientedRoadBody(road, 0));
  const roadIndex = new SpatialIndex(roadBodies, 64);
  const maxRoadReach = roadBodies.reduce(
    (m, r) => Math.max(m, Math.hypot(r.width ?? 0, r.length ?? 0) / 2),
    60,
  );

  const pedestrians = [];
  const walkerIndex = new SpatialIndex([], 8);

  const tryAdmit = (pose) => {
    const body = { ...WALKER, ...pose };
    if (overlaps(body, player, 0.25)) return false;
    if (walkerIndex.near(pose, 2.2).some((other) => distance(pose, other) < 1.42)) return false;
    if (vehicleIndex.near(pose, 8).some((other) => overlaps(body, other, 0.2))) return false;
    if (staticIndex.near(pose, maxStaticReach + 3).some((other) => overlaps(body, other, 0.16))) {
      return false;
    }
    if (roadIndex.near(pose, maxRoadReach + 3).some((road) => overlaps(body, road, 0.12))) {
      return false;
    }
    pedestrians.push(pose);
    walkerIndex.add(pose);
    return true;
  };

  // Maintain ~47% hotspot share across every prefix (both default 135 and max 220).
  let hCursor = 0;
  let cCursor = 0;
  let hotspotCount = 0;
  while (pedestrians.length < target && (hCursor < hotspotPool.length || cCursor < nonHotspotPool.length)) {
    const wantHotspot =
      hCursor < hotspotPool.length &&
      (cCursor >= nonHotspotPool.length || hotspotCount / Math.max(1, pedestrians.length + 1) < 0.475);
    if (wantHotspot) {
      while (hCursor < hotspotPool.length) {
        if (tryAdmit(hotspotPool[hCursor++])) {
          hotspotCount++;
          break;
        }
      }
    } else {
      let placed = false;
      while (cCursor < nonHotspotPool.length) {
        const candidate = nonHotspotPool[cCursor++];
        if (tryAdmit(candidate)) {
          if (inCrowdHotspot(candidate)) hotspotCount++;
          placed = true;
          break;
        }
      }
      if (!placed && hCursor < hotspotPool.length && tryAdmit(hotspotPool[hCursor++])) {
        hotspotCount++;
      }
    }
  }
  return pedestrians;
}

const grandTemplateCache = new Map();

function tagTemplateArray(arr, key) {
  Object.defineProperty(arr, "templateKey", {
    value: key,
    enumerable: false,
    configurable: true,
  });
  return arr;
}

function cloneCityTemplate(template, cacheKey) {
  const copy = {
    ...template,
    drivingRoads: tagTemplateArray(template.drivingRoads.slice(), `${cacheKey}:drivingRoads`),
    roads: tagTemplateArray(template.roads.slice(), `${cacheKey}:roads`),
    statics: tagTemplateArray(template.statics.slice(), `${cacheKey}:statics`),
    places: template.places.slice(),
    playerStart: { ...template.playerStart },
    walkways: template.walkways.slice(),
    pursuitExits: template.pursuitExits.slice(),
    ...(template.surveillanceZones ? { surveillanceZones: template.surveillanceZones.slice() } : {}),
    ...(template.hotspots
      ? {
        hotspots: {
          crowds: template.hotspots.crowds.slice(),
          traffic: template.hotspots.traffic.slice(),
          parked: template.hotspots.parked.slice(),
        },
      }
      : {}),
    trafficGoals: template.trafficGoals.slice(),
    conflictZones: template.conflictZones.slice(),
    showcaseRoutes: template.showcaseRoutes.slice(),
    trafficSpawns: template.trafficSpawns.slice(),
    pedestrianSpawns: template.pedestrianSpawns.slice(),
  };
  if (template.cautionZones) copy.cautionZones = template.cautionZones.slice();
  if (template.caseAnchors) copy.caseAnchors = template.caseAnchors.slice();
  return copy;
}

function buildGrandCityBlueprint() {
  const district = createEgyptDistrict();
  const added = grandAvenueNetwork();
  const inherited = district.drivingRoads.map((road) => ({
    ...road,
    zone: "neighborhood",
    min: road.id === "school-local" ? GATE_X : road.min,
    max: road.id === "school-local" || road.id === "entry-local" ? 124 : road.max,
  }));
  // Place wide avenues & diagonals first so bodyOnRoad short-circuits on primary corridors.
  const drivingRoads = [...added, ...inherited];
  const roadById = new Map(drivingRoads.map((road) => [road.id, road]));

  const { allJunctions, aprons } = grandJunctionsAndAprons(added, drivingRoads);
  const roads = [
    ...drivingRoads,
    ...aprons,
    ...district.roads
      .filter((road) => road.supportApron)
      .map((road) => ({ ...road, zone: "neighborhood" })),
  ];

  const walkFrontages = [
    ...added,
    { ...roadById.get("school-local"), max: -54 },
    { ...roadById.get("school-local"), min: 62, max: 124 },
    { ...roadById.get("entry-local"), min: 62, max: 124 },
  ];
  const buildingFrontages = [
    ...walkFrontages,
    roadById.get("west-local"),
    roadById.get("east-connector"),
  ];
  const addedWalkways = grandStreetWalkways(walkFrontages);
  const crosswalks = grandHotspotCrosswalks(roadById, allJunctions);
  const walkways = [
    ...district.walkways.map((line) => ({ ...line, roadPreference: "market" })),
    ...addedWalkways,
    ...crosswalks,
  ];

  const newRoadBodies = [...added, ...aprons].map((road) => orientedRoadBody(road, 0));
  // Drop tiny 8x11m legacy district buildings so Grand Metro v5 has realistic metropolitan blocks.
  const retainedProps = district.statics.filter(
    (site) =>
      site.kind !== "building" &&
      !newRoadBodies.some((paved) => overlaps(site, paved, 0.35)),
  );
  const buildings = grandBuildings(buildingFrontages, roads, walkways, retainedProps);

  const playerStart = grandLane(roadById.get(START_ROAD), -254, 1);
  const cityAnchors = {
    downtown: [START_ROAD, -148, 1],
    market: ["souq-collector", -225, 1],
    station: ["station-avenue", -137, -1],
    hospital: ["civic-avenue", 56, 1],
    university: ["university-avenue", -126, 1],
    corniche: ["corniche-avenue", -48, -1],
  };
  const places = [
    ...district.places,
    ...PLACES.map(({ id, name }) => {
      const [roadId, along, side] = cityAnchors[id];
      return { id, name, ...grandLane(roadById.get(roadId), along, side) };
    }),
  ];

  const exitSites = [
    ["nile-north", "nile-west-boulevard", 295, 1],
    ["nile-south", "nile-west-boulevard", -335, -1],
    ["opera-north", "opera-avenue", 310, 1],
    ["opera-south", "opera-avenue", -355, -1],
    ["corniche-north", "corniche-avenue", 315, 1],
    ["corniche-south", "corniche-avenue", -355, -1],
    ["ramses-west", "ramses-north-arterial", -330, -1],
    ["ramses-central", "ramses-north-arterial", 42, 1],
    ["ramses-east", "ramses-north-arterial", 355, 1],
    ["citadel-north", "citadel-east-ring", 295, 1],
    ["citadel-central", "citadel-east-ring", 28, -1],
    ["citadel-south", "citadel-east-ring", -335, -1],
    ["south-ring-west", "south-ring-arterial", -335, -1],
    ["south-ring-central", "south-ring-arterial", 65, 1],
    ["south-ring-east", "south-ring-arterial", 355, 1],
    ["tahrir-far-west", START_ROAD, -465, -1],
    ["tahrir-far-east", START_ROAD, 372, 1],
    ["qasr-diag-mid", "qasr-diagonal", 95, -1],
    ["ramses-diag-outer", "ramses-diagonal", 385, 1],
    ["citadel-diag-outer", "citadel-diagonal", 525, 1],
  ];
  const pursuitExits = exitSites.map(([name, roadId, along, side]) => ({
    id: `metro-exit-${name}`,
    ...grandLane(roadById.get(roadId), along, side),
  }));

  const baseStatics = [...retainedProps, ...buildings];
  const { parked, pockets } = grandParkedVehicles(
    drivingRoads,
    roads,
    baseStatics,
    crosswalks,
    allJunctions,
    playerStart,
    [...places, ...pursuitExits],
  );
  const statics = [...baseStatics, ...parked];

  const hotspots = {
    crowds: [
      {
        id: "tahrir-midan-crowd",
        name: "ميدان التحرير",
        x: -172,
        z: -112,
        radiusM: 48,
        roadIds: [START_ROAD, "civic-avenue", "qasr-diagonal", "talaat-diagonal"],
        crosswalkIds: crosswalks
          .filter((cw) => cw.hotspotId === "tahrir-midan-crowd")
          .map((cw) => cw.id),
      },
      {
        id: "khan-market-crowd",
        name: "سوق خان الخليلي",
        x: 156,
        z: 36,
        radiusM: 56,
        roadIds: ["khan-market-street", "bazaar-slash", "azhar-avenue", "school-local"],
        crosswalkIds: crosswalks
          .filter((cw) => cw.hotspotId === "khan-market-crowd")
          .map((cw) => cw.id),
      },
      {
        id: "ramses-station-crowd",
        name: "ممشى محطة رمسيس",
        x: -96,
        z: 48,
        radiusM: 56,
        roadIds: ["gateway-avenue", "university-avenue", "souq-collector", "talaat-diagonal", "ramses-diagonal"],
        crosswalkIds: crosswalks
          .filter((cw) => cw.hotspotId === "ramses-station-crowd")
          .map((cw) => cw.id),
      },
    ],
    traffic: [
      {
        id: "tahrir-radial-convergence",
        name: "تقاطع التحرير الإشعاعي",
        x: -183,
        z: -112,
        radiusM: 82,
        roadIds: [START_ROAD, "civic-avenue", "qasr-diagonal", "talaat-diagonal"],
      },
      {
        id: "ramses-gateway-hub",
        name: "محور رمسيس والجامعة",
        x: -96,
        z: 90,
        radiusM: 82,
        roadIds: ["gateway-avenue", "university-avenue", "ramses-diagonal", "talaat-diagonal"],
      },
      {
        id: "azhar-bazaar-junction",
        name: "تقاطع الأزهر والقلعة",
        x: 188,
        z: -112,
        radiusM: 82,
        roadIds: [START_ROAD, "azhar-avenue", "bazaar-slash", "citadel-diagonal"],
      },
    ],
    parked: pockets,
  };

  const widerSpans = interleave(added.map((road) => grandStreetSpans(road, drivingRoads)));
  const bodyProbe = { type: "vehicle", width: PLAYER_VEHICLE.widthM, length: PLAYER_VEHICLE.lengthM };
  const widerGoals = widerSpans.flatMap(({ road, min, max }, index) => {
    if (max - min < 36) return [];
    const mid = (min + max) / 2;
    const preferredSide = road.flow ? road.flow : index % 2 === 0 ? 1 : -1;
    const goal = { id: `${road.id}-goal-${Math.round(mid)}-${preferredSide}`, ...grandLane(road, mid, preferredSide) };
    if (statics.some((s) => overlaps({ ...bodyProbe, ...goal }, s, 0.25))) return [];
    return [goal];
  });

  // Weight hotspot convergence goals twice so ambient trips actively converge across the 3 traffic hubs.
  const hotspotExtraGoals = widerGoals.filter((goal) =>
    hotspots.traffic.some((hub) => distance(goal, hub) <= hub.radiusM + 40),
  );

  const conflictZones = mergeGrandConflictZones(district.conflictZones, aprons);

  const city = {
    ...district,
    id: "unified-city-v5",
    templateKey: "grand-city-v5",
    version: 5,
    cityVersion: 5,
    rush: true,
    grand: true,
    drivingRoads,
    roads,
    statics,
    places,
    playerStart,
    walkways,
    pursuitExits,
    surveillanceZones: Object.freeze(
      GRAND_SURVEILLANCE_ZONES.map((z) => Object.freeze({ ...z })),
    ),
    hotspots,
    trafficGoals: [...district.trafficGoals, ...hotspotExtraGoals, ...widerGoals],
    conflictZones,
    showcaseRoutes: [
      {
        id: "boulevard-to-bakery",
        start: { ...playerStart },
        goal: { ...places[0] },
        mustUseRoadIds: [START_ROAD, "alley-west"],
      },
      ...district.showcaseRoutes,
    ],
  };

  city.trafficSpawns = populateGrandTraffic(
    city,
    widerSpans,
    district.trafficSpawns,
    GRAND_CITY_POPULATION_LIMITS.traffic,
  );
  city.pedestrianSpawns = populateGrandWalkers(
    city,
    district.pedestrianSpawns,
    addedWalkways,
    crosswalks,
    GRAND_CITY_POPULATION_LIMITS.pedestrians,
  );

  if (
    city.trafficSpawns.length < GRAND_CITY_POPULATION_LIMITS.traffic ||
    city.pedestrianSpawns.length < GRAND_CITY_POPULATION_LIMITS.pedestrians
  ) {
    throw new Error(
      `Insufficient Grand Metro v5 spawn capacity: ${city.trafficSpawns.length}/${city.pedestrianSpawns.length}`,
    );
  }
  return city;
}

function buildLegacyUnifiedCity({ dense = false, rush = false } = {}) {
  const district = createEgyptDistrict(), added = avenueNetwork();
  // The north join extends the existing street ID. The southern feeder joins
  // east of the outer neighborhood loop, making the west alley the direct route from Tahrir.
  const inherited = district.drivingRoads.map((road) => ({
    ...road, zone: "neighborhood", min: road.id === "school-local" ? GATE_X : road.min,
  }));
  const drivingRoads = [...inherited, ...added];
  const roadById = new Map(drivingRoads.map((road) => [road.id, road]));
  const aprons = newJunctionAprons(added, drivingRoads);
  const roads = [
    ...drivingRoads,
    ...district.roads.filter((road) => road.supportApron).map((road) => ({ ...road, zone: "neighborhood" })),
    ...aprons,
  ];
  const frontages = [...added, { ...roadById.get("school-local"), max: -64 }];
  const addedWalkways = newWalkways(frontages);
  const walkways = [
    ...district.walkways.map((line) => ({ ...line, roadPreference: "market" })), ...addedWalkways,
  ];
  const newPavement = [...added, ...aprons].map((road) => box(roadRect(road)));
  const oldStatics = district.statics.flatMap((site) => {
    if (site.kind !== "building") return [site];
    // Two perimeter plots give way to the new feeder; interior walls and occluders stay put.
    return newPavement.some((paved) => overlaps(site, paved, 0.35))
      ? [] : [{ ...site, architecture: "neighborhood" }];
  });
  const statics = [...oldStatics, ...newBuildings(frontages, roads, walkways, oldStatics)];
  const playerStart = lane(roadById.get(START_ROAD), -254);
  const cityAnchors = {
    downtown: [START_ROAD, -148, 1],
    market: ["souq-collector", -225, 1],
    station: ["station-avenue", -137, -1],
    hospital: ["civic-avenue", 56, 1],
    university: ["university-avenue", -126, 1],
    corniche: ["corniche-avenue", -34, -1],
  };
  const places = [...district.places, ...PLACES.map(({ id, name }) => {
    const [roadId, along, side] = cityAnchors[id];
    return { id, name, ...lane(roadById.get(roadId), along, side) };
  })];
  const widerSpans = interleave(added.map((road) => streetSpans(road, drivingRoads)));
  const widerGoals = widerSpans.flatMap(({ road, min, max }) => [-1, 1].map((side) => ({
    id: `${road.id}-goal-${min}-${side}`, ...lane(road, (min + max) / 2, side),
  })));
  const exitSites = [
    ["tahrir-east", START_ROAD, -209, 1], ["tahrir-west", START_ROAD, -217, -1],
    ["station-west", "station-avenue", -232, -1],
    ["south-link", SOUTH_LINK, -74, 1],
    ["gate-south", "gateway-avenue", -57, -1], ["gate-north", "gateway-avenue", 61, 1],
    ["riverside", "corniche-avenue", -26, 1], ["station", "station-avenue", -139, -1],
    ["east-local", "east-connector", 20, 1], ["school-side", "school-local", -30, -1],
    ["market-side", "market-local", 36, 1], ["workshops", "entry-local", 32, -1],
  ];
  const pursuitExits = exitSites.map(([name, roadId, along, side]) => ({
    id: `metro-exit-${name}`, ...lane(roadById.get(roadId), along, side),
  }));
  const city = {
    ...district, id: "unified-city-v1", version: 1, drivingRoads, roads, statics, places,
    ...(rush ? { rush: true } : {}),
    playerStart, walkways, pursuitExits, trafficGoals: [...district.trafficGoals, ...widerGoals],
    conflictZones: [...district.conflictZones, ...aprons.map((road) => ({
      id: `${road.id}-conflict`, kind: "junction", ...roadRect(road), approachM: 8,
    }))],
    showcaseRoutes: [{
      id: "boulevard-to-bakery", start: { ...playerStart }, goal: { ...places[0] },
      mustUseRoadIds: [START_ROAD, "alley-west"],
    }, ...district.showcaseRoutes],
  };
  // Both generators take a deterministic prefix; density extends the old spawn order.
  const capacity = rush ? RUSH_CITY_POPULATION_LIMITS
    : dense ? METRO_POPULATION_LIMITS : LEGACY_POPULATION_LIMITS;
  city.trafficSpawns = populateTraffic(city, widerSpans, district.trafficSpawns, capacity.traffic);
  city.pedestrianSpawns = populateWalkers(city, district.pedestrianSpawns, addedWalkways, capacity.pedestrians);
  if (city.trafficSpawns.length < capacity.traffic || city.pedestrianSpawns.length < capacity.pedestrians)
    throw new Error(`Insufficient metro spawn capacity: ${city.trafficSpawns.length}/${city.pedestrianSpawns.length}`);
  return city;
}

export function createUnifiedCity({ dense = false, rush = false, grand = false } = {}) {
  const cacheKey = `${Boolean(dense)}:${Boolean(rush)}:${Boolean(grand)}`;
  let template = grandTemplateCache.get(cacheKey);
  if (!template) {
    template = grand ? buildGrandCityBlueprint() : buildLegacyUnifiedCity({ dense, rush });
    grandTemplateCache.set(cacheKey, template);
  }
  const cloned = cloneCityTemplate(template, cacheKey);
  Object.defineProperty(cloned, "templateRef", { value: template, enumerable: false });
  return cloned;
}
