import { VEHICLE } from "./config.js";
import { createEgyptDistrict, districtRoadPose } from "./egypt-district.js";
import { bodyOnRoad, distance, overlaps, roadRect } from "./geometry.js";
import { PLACES } from "./places.js";
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

export function createUnifiedCity({ dense = false, rush = false } = {}) {
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
