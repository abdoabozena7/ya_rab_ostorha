import { angleDelta, distance } from "../core/geometry.js";
import { districtRoadPose } from "../core/egypt-district.js";
import { planDistrictRoute } from "../core/district-navigation.js";
import { nearestPathPoint } from "../core/vehicle.js";
import { clamp } from "../core/config.js";

export const LEGACY_ROUTE_CONTEXT = "dispatch-route-v1";
export const CLEARANCE_ROUTE_CONTEXT = "dispatch-route-v2";
const guides = new Map([[LEGACY_ROUTE_CONTEXT, new WeakMap()], [CLEARANCE_ROUTE_CONTEXT, new WeakMap()]]);
export const ROUTE_NAVIGATION_FIELDS = Object.freeze([
  "available", "nearRight", "nearForward", "laterRight", "laterForward",
  "headingSin", "headingCos", "curveAhead", "remaining",
]);

function isOutside(goal, zones) {
  return zones.every(zone => goal.x < zone.minX - 1 || goal.x > zone.maxX + 1 ||
    goal.z < zone.minZ - 1 || goal.z > zone.maxZ + 1);
}

function clearanceFromZones(point, zones) {
  let clearance = Infinity;
  for (const zone of zones) clearance = Math.min(clearance, Math.hypot(
    Math.max(0, zone.minX - point.x, point.x - zone.maxX),
    Math.max(0, zone.minZ - point.z, point.z - zone.maxZ),
  ));
  return clearance;
}

function clearanceGoals(district, zones) {
  const goals = [];
  for (const road of district.drivingRoads) {
    if (road.parkingBay || road.supportApron || road.max - road.min < 24) continue;
    for (const direction of road.flow ? [road.flow] : [-1, 1]) {
      const along = direction > 0 ? road.max - 12 : road.min + 12;
      const goal = { ...districtRoadPose(road, along, direction), roadId: road.id,
        id: `clearance:${road.id}:${direction}` };
      // Public coverage alone cannot tell the player whether police are near.
      // Leave space to continue after the edge rather than ending at the marker.
      if (clearanceFromZones(goal, zones) >= 38) goals.push(goal);
    }
  }
  return goals;
}

export function dispatchRouteGuide(world, version = LEGACY_ROUTE_CONTEXT) {
  const { district, player, pursuit } = world;
  if (!district || !pursuit?.gta) return null;
  const cache = guides.get(version);
  if (!cache) throw new RangeError("Unknown Metro route context");
  const cached = cache.get(pursuit);
  if (cached && (cached.guide || world.tick < cached.retryAt)) return cached.guide;
  const { surveillanceZones } = pursuit.gta.config;
  const extended = version === CLEARANCE_ROUTE_CONTEXT;
  const goals = pursuit.gta.publicRouteGoal ? [pursuit.gta.publicRouteGoal] :
    (extended ? clearanceGoals(district, surveillanceZones) :
      district.pursuitExits.filter(goal => isOutside(goal, surveillanceZones)))
      .sort((a, b) => distance(a, player) - distance(b, player) || a.id.localeCompare(b.id)).slice(0, extended ? 8 : 5);
  let best = null;
  // Only permanent map geometry; never incorporate live actors or temporary blockers.
  for (const goal of goals) {
    const path = planDistrictRoute(district, player, goal);
    if (path.length < 3) continue;
    const across = path.reduce((total, point, i) => i ? total + distance(path[i - 1], point) : 0, 0);
    if (!best || across < best.lengthM) best = {
      id: goal.id, path: Object.freeze(path.map(point => Object.freeze(point))), lengthM: across,
    };
  }
  // A transient heading mismatch must not suppress cues for the rest of the chase.
  cache.set(pursuit, { guide: best, retryAt: world.tick + 30 });
  return best;
}

export function sampleRouteNavigation(world, version) {
  const guide = dispatchRouteGuide(world, version);
  if (!guide) return new Float32Array(ROUTE_NAVIGATION_FIELDS.length);
  const { player } = world, { path } = guide;
  const sin = Math.sin(player.heading), cos = Math.cos(player.heading);
  const axle = (player.spec?.wheelbase ?? 2.6) / 2;
  const x = player.x - sin * axle, z = player.z - cos * axle;
  let index = 0, min = Infinity;
  for (let i = 0; i < path.length; i++) {
    const dist = (path[i].x - x) ** 2 + (path[i].z - z) ** 2;
    if (dist < min) {
      min = dist;
      index = i;
    }
  }
  const nearest = nearestPathPoint(path, x, z, index), limit = path.length - 1;
  const ahead = 2 + Math.abs(player.speed) * .18;
  let nearIndex = nearest, farIndex = nearest, arc = 0, remaining = 0, bend = 0;
  const heading = i => Math.atan2(path[i + 1].x - path[i].x, path[i + 1].z - path[i].z);
  for (let i = nearest; i < limit; i++) {
    remaining += distance(path[i], path[i + 1]);
    if (arc < ahead) nearIndex = i + 1;
    if (arc < ahead + 8) farIndex = i + 1;
    if (arc < 14 && i + 1 < limit)
      bend = Math.max(bend, Math.abs(angleDelta(heading(i + 1), heading(i))) / Math.max(1, arc + 1));
    arc = remaining;
  }
  const local = i => {
    const dx = path[i].x - x, dz = path[i].z - z;
    return [dx * cos - dz * sin, dx * sin + dz * cos];
  };
  const near = local(nearIndex), far = local(farIndex);
  const error = angleDelta(heading(Math.min(nearest, limit - 1)), player.heading);
  return Float32Array.of(1, clamp(near[0] / 6, -1, 1), clamp(near[1] / 12, -1, 1),
    clamp(far[0] / 14, -1, 1), clamp(far[1] / 24, -1, 1), Math.sin(error), Math.cos(error),
    clamp(bend * 5, 0, 1), clamp(remaining / 35, 0, 1));
}
