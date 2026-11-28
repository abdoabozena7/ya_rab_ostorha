import { VEHICLE } from "./config.js";
import { angleDelta, roadFrame, roadPointAt, roadProject } from "./geometry.js";
import { followPath, markImmutablePath, nearestPathPoint } from "./vehicle.js";
import { KING_LONG_MICROBUS, KING_LONG_MICROBUS_ID } from "./vehicle-spec.js";

// Pure road/lane geometry shared by Cairo Traffic and the Unified Driver (no street-chaos state).
const roadListCache = new WeakMap();

// Geometry-limited cruise speed, measured as if the car were perfectly on the route so a dodge
// (which makes the route follower want to steer hard back to the lane) never reads as a sharp curve.
export function idealPathSpeed(player, path, cursor) {
  if (!path || path.length < 2) return 0;
  const nearest = nearestPathPoint(path, player.x, player.z, cursor);
  const ahead = path[Math.min(path.length - 1, nearest + 3)];
  const here = path[nearest];
  const heading = Math.hypot(ahead.x - here.x, ahead.z - here.z) > 0.2
    ? Math.atan2(ahead.x - here.x, ahead.z - here.z) : player.heading;
  const wheelbase = player.spec?.wheelbase ?? VEHICLE.wheelbase;
  const axleCenterZ = player.vehicleModel === KING_LONG_MICROBUS_ID ? KING_LONG_MICROBUS.axleCenterZM : 0;
  const rear = wheelbase / 2 - axleCenterZ;
  const ideal = {
    x: here.x + Math.sin(heading) * rear, z: here.z + Math.cos(heading) * rear, heading,
    speed: player.speed, spec: player.spec, vehicleModel: player.vehicleModel, maxSpeed: player.maxSpeed,
  };
  return followPath(ideal, path, nearest).targetSpeed;
}

/* ------------------------------------------------------------------ lanes */

export const normalizeAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

function roadList(world) {
  const source = world.district?.drivingRoads ?? world.drivingRoads ?? [];
  let list = roadListCache.get(source);
  if (!list) {
    list = source.filter((road) => !road.parkingBay && !road.supportApron);
    roadListCache.set(source, list);
  }
  return list;
}

/**
 * Lane coordinates: `s` grows along the travel direction and `lat` grows toward the
 * steering-positive side, so the travel lane sits at `-laneOffsetM`, the oncoming
 * lane at `+laneOffsetM` and the kerb at `-halfW`.
 */
export function laneFrame(world, body, { minWidth = 0, maxPsi = 0.8 } = {}) {
  let best = null;
  let bestScore = Infinity;
  const roads = roadList(world);
  for (let i = 0; i < roads.length; i++) {
    const road = roads[i];
    if (road.width < minWidth) continue;
    const proj = roadProject(road, body);
    if (proj.along < road.min - 0.2 || proj.along > road.max + 0.2 || proj.absLateral > road.width / 2) continue;
    const frame = roadFrame(road);
    const forward = angleDelta(body.heading ?? 0, frame.heading);
    const d = Math.abs(forward) <= Math.PI / 2 ? 1 : -1;
    const psi = d > 0 ? forward : angleDelta(body.heading ?? 0, frame.heading + Math.PI);
    if (Math.abs(psi) > maxPsi) continue;
    const score = Math.abs(psi);
    if (score >= bestScore) continue;
    bestScore = score;
    best = {
      road, d, psi, along: proj.along, s: d * proj.along, lat: -d * proj.leftOffset,
      halfW: road.width / 2, laneOffset: road.laneOffsetM ?? 2.6,
      laneHeading: d > 0 ? frame.heading : normalizeAngle(frame.heading + Math.PI),
    };
  }
  return best;
}

export function coordsOn(road, d, point) {
  const proj = roadProject(road, point);
  return { s: d * proj.along, lat: -d * proj.leftOffset };
}

export function lanePoint(road, d, s, lat) {
  return roadPointAt(road, d * s, -d * lat);
}

export function straightLanePath(frame, s0, lat, lengthM, backM = 1) {
  const road = frame.road;
  const lo = road.min + 10;
  const hi = road.max - 10;
  const points = [];
  const total = Math.max(2, lengthM + backM);
  for (let k = 0; k * 0.5 <= total; k++) {
    const s = s0 - backM + k * 0.5;
    const along = frame.d * s;
    if (along < lo || along > hi) break;
    const p = lanePoint(road, frame.d, s, lat);
    points.push({ x: p.x, z: p.z });
  }
  return points.length > 4 ? markImmutablePath(points) : [];
}

// Distance from lane position `s` to the next junction/conflict box that crosses this carriageway.
export function zoneAheadM(world, frame, s) {
  const zones = world.district?.conflictZones;
  if (!zones) return Infinity;
  let best = Infinity;
  for (let i = 0; i < zones.length; i++) {
    const z = zones[i];
    let sMin = Infinity;
    let sMax = -Infinity;
    let latMin = Infinity;
    let latMax = -Infinity;
    for (let k = 0; k < 4; k++) {
      const c = coordsOn(frame.road, frame.d, { x: k & 1 ? z.maxX : z.minX, z: k & 2 ? z.maxZ : z.minZ });
      if (c.s < sMin) sMin = c.s;
      if (c.s > sMax) sMax = c.s;
      if (c.lat < latMin) latMin = c.lat;
      if (c.lat > latMax) latMax = c.lat;
    }
    if (latMax < -frame.halfW - 1 || latMin > 1 || sMax < s - 1) continue;
    best = Math.min(best, Math.max(0, sMin - s));
  }
  return best;
}
