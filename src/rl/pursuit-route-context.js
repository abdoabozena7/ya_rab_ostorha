import {
  angleDelta,
  bodyOnRoad,
  distance,
  isDiagonalRoad,
  overlaps,
  roadFrame,
  roadIntersection,
  roadPoseAt,
  roadProject,
} from "../core/geometry.js";
import { districtRoadPose } from "../core/egypt-district.js";
import { planDistrictRoute } from "../core/district-navigation.js";
import { nearestPathPoint } from "../core/vehicle.js";
import { VEHICLE, clamp } from "../core/config.js";

export const LEGACY_ROUTE_CONTEXT = "dispatch-route-v1";
export const CLEARANCE_ROUTE_CONTEXT = "dispatch-route-v2";
export const CLEARANCE_CORRIDOR = "clearance-corridor-v1";
const guides = new Map([LEGACY_ROUTE_CONTEXT, CLEARANCE_ROUTE_CONTEXT, CLEARANCE_CORRIDOR]
  .map(version => [version, new WeakMap()]));
export const ROUTE_NAVIGATION_FIELDS = Object.freeze([
  "available", "nearRight", "nearForward", "laterRight", "laterForward",
  "headingSin", "headingCos", "curveAhead", "remaining",
]);
const GOAL_PROBE = Object.freeze({ type: "vehicle", width: VEHICLE.width, length: VEHICLE.length });

function poseOnRoad(road, along, direction) {
  return isDiagonalRoad(road)
    ? roadPoseAt(road, along, direction)
    : districtRoadPose(road, along, direction);
}

function hasExtendedTopology(district, zones) {
  return Boolean(
    district.grand ||
    (Array.isArray(zones) && zones.length > 3) ||
    (Array.isArray(district.drivingRoads) && district.drivingRoads.some(isDiagonalRoad))
  );
}

function goalPoseClear(district, pose) {
  const probe = { ...GOAL_PROBE, x: pose.x, z: pose.z, heading: pose.heading };
  if (Array.isArray(district.roads) && district.roads.length && !bodyOnRoad(probe, district.roads, 0.12))
    return false;
  if (Array.isArray(district.statics) && district.statics.some(other => overlaps(probe, other, 0.12)))
    return false;
  return true;
}

function curbRejoinPose(district, player, allowOffCurbSnap = false) {
  if ((!player?.curbSupportId && !allowOffCurbSnap) || !Array.isArray(district.drivingRoads)) return null;
  const sin = Math.sin(player.heading ?? 0), cos = Math.cos(player.heading ?? 0);
  const maxHeadingDiff = allowOffCurbSnap ? 1.15 : 0.85;
  let best = null, bestDist = Infinity;
  for (const road of district.drivingRoads) {
    if (road.parkingBay || road.supportApron) continue;
    const f = roadFrame(road);
    if (f.length < 8) continue;
    const proj = roadProject(road, player);
    if (proj.along < f.minAlong - 4 || proj.along > f.maxAlong + 4) continue;
    if (proj.absLateral > road.width / 2 + 4.5) continue;
    const align = f.ux * sin + f.uz * cos;
    const side = road.flow || (align >= 0 ? 1 : -1);
    const along = clamp(proj.along, f.minAlong + 3, f.maxAlong - 3);
    const candidate = poseOnRoad(road, along, side);
    if (Math.abs(angleDelta(candidate.heading, player.heading ?? candidate.heading)) > maxHeadingDiff) continue;
    const d = distance(player, candidate);
    if (d < bestDist && goalPoseClear(district, candidate)) {
      bestDist = d;
      best = { ...player, x: candidate.x, z: candidate.z, heading: candidate.heading };
    }
  }
  return best;
}

function planPublicRoute(district, player, goal, allowOffCurbSnap = false) {
  const playerBody =
    Number.isFinite(player?.width) && Number.isFinite(player?.length)
      ? player
      : { ...GOAL_PROBE, ...player, heading: player?.heading ?? 0 };
  const direct = planDistrictRoute(district, playerBody, goal);
  if (direct.length >= 3) return direct;
  const rejoin = curbRejoinPose(district, playerBody, allowOffCurbSnap);
  if (!rejoin) return direct;
  const rejoined = planDistrictRoute(district, rejoin, goal);
  if (rejoined.length < 3) return direct;
  return [{ x: playerBody.x, z: playerBody.z }, ...rejoined];
}

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

function roadCrossingAlongs(road, drivingRoads) {
  const cuts = [];
  for (const other of drivingRoads) {
    if (other === road || other.id === road.id || other.parkingBay || other.supportApron) continue;
    const hit = roadIntersection(road, other, 0.5);
    if (hit) cuts.push(hit.alongA);
  }
  return cuts;
}

function clearanceGoals(district, zones) {
  const goals = [];
  if (!hasExtendedTopology(district, zones)) {
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

  const drivingRoads = district.drivingRoads ?? [];
  const cutsByRoad = new Map(drivingRoads.map(road => [road.id, roadCrossingAlongs(road, drivingRoads)]));
  const fallbackGoals = [];

  for (const road of drivingRoads) {
    if (road.parkingBay || road.supportApron) continue;
    const f = roadFrame(road);
    if (f.length < 24) continue;
    const cuts = cutsByRoad.get(road.id) ?? [];
    const hasCuts = cuts.length > 0;
    const firstCut = hasCuts ? Math.min(...cuts) : f.minAlong;
    const lastCut = hasCuts ? Math.max(...cuts) : f.maxAlong;

    for (const direction of road.flow ? [road.flow] : [-1, 1]) {
      const minAlong = direction > 0 ? f.minAlong + 12 : Math.max(f.minAlong + 12, firstCut + 18);
      const maxAlong = direction > 0 ? Math.min(f.maxAlong - 12, lastCut - 18) : f.maxAlong - 12;

      if (hasCuts && maxAlong >= minAlong) {
        for (const offset of [0, 8, 16]) {
          const along = direction > 0 ? maxAlong - offset : minAlong + offset;
          if (along < minAlong || along > maxAlong) continue;
          if (cuts.some(cut => Math.abs(cut - along) < 16)) continue;
          const pose = poseOnRoad(road, along, direction);
          if (clearanceFromZones(pose, zones) >= 38 && goalPoseClear(district, pose)) {
            goals.push({ ...pose, roadId: road.id, id: `clearance:${road.id}:${direction}` });
            break;
          }
        }
        const span = maxAlong - minAlong;
        if (span >= 120) {
          const innerSpan = span - 72;
          const count = Math.max(1, Math.floor(innerSpan / 140) + 1);
          for (let i = 0; i < count; i++) {
            const frac = count === 1 ? 0.5 : i / (count - 1);
            const along = minAlong + 36 + innerSpan * frac;
            if (cuts.some(cut => Math.abs(cut - along) < 18)) continue;
            const pose = poseOnRoad(road, along, direction);
            if (clearanceFromZones(pose, zones) < 38 || !goalPoseClear(district, pose)) continue;
            if (goals.some(existing => existing.roadId === road.id &&
                Math.abs(angleDelta(existing.heading, pose.heading)) < 0.2 &&
                distance(existing, pose) < 36)) continue;
            goals.push({
              ...pose,
              roadId: road.id,
              id: `clearance:${road.id}:${direction}:${Math.round(along)}`,
            });
          }
        }
      }

      for (const inset of [12, 20, 28]) {
        if (f.length < inset * 2) continue;
        const along = direction > 0 ? f.maxAlong - inset : f.minAlong + inset;
        const pose = poseOnRoad(road, along, direction);
        if (clearanceFromZones(pose, zones) >= 38 && goalPoseClear(district, pose)) {
          fallbackGoals.push({ ...pose, roadId: road.id, id: `clearance:${road.id}:${direction}` });
          break;
        }
      }
    }
  }

  for (const exit of district.pursuitExits ?? []) {
    if (clearanceFromZones(exit, zones) < 38 || !goalPoseClear(district, exit)) continue;
    if (goals.some(existing => distance(existing, exit) < 24)) continue;
    const road = drivingRoads.find(r => r.id === exit.roadId);
    if (road) {
      const cuts = cutsByRoad.get(road.id) ?? [];
      if (cuts.length > 0) {
        const rf = roadFrame(road);
        const proj = roadProject(road, exit);
        const align = rf.ux * Math.sin(exit.heading ?? 0) + rf.uz * Math.cos(exit.heading ?? 0);
        const hasExitTurnAhead = align >= 0
          ? proj.along <= Math.max(...cuts) - 18
          : proj.along >= Math.min(...cuts) + 18;
        if (!hasExitTurnAhead) {
          fallbackGoals.push(exit);
          continue;
        }
      }
    }
    goals.push(exit);
  }
  return goals.length ? goals : fallbackGoals;
}

function corridorGuide(district, player, zones, goals) {
  let best = null;
  for (const goal of [...goals, ...(district.pursuitExits ?? []).filter(goal => isOutside(goal, zones))]) {
    const path = planPublicRoute(district, player, goal);
    if (path.length < 3) continue;
    // Leaving coverage briefly is not useful. Measure only the final contiguous
    // outside segment, which can run parallel to the edge of a zone.
    const lastCovered = path.findLastIndex(point => !isOutside(point, zones));
    const origin = path[lastCovered] ?? player;
    let lengthM = 0, earliestM = Infinity;
    for (let i = 1; i < path.length; i++) {
      lengthM += distance(path[i - 1], path[i]);
      if (earliestM === Infinity && i > lastCovered &&
          distance(origin, path[i]) >= 38 && distance(player, path[i]) >= 45) earliestM = lengthM;
    }
    if (earliestM === Infinity) continue;
    const rank = best ? earliestM - best.earliestM || lengthM - best.lengthM || goal.id.localeCompare(best.id) : -1;
    if (rank < 0) best = { id: goal.id, path, lengthM, earliestM };
  }
  if (best) best.path = Object.freeze(best.path.map(point => Object.freeze(point)));
  return best;
}

function selectBestRouteGuide(district, player, candidates, maxCheck, options = {}) {
  const { preferFar = false, allowOffCurbSnap = false } = options;
  const ordered = [...candidates].sort((a, b) => {
    if (!preferFar) {
      return distance(a, player) - distance(b, player) || a.id.localeCompare(b.id);
    }
    const da = distance(a, player);
    const db = distance(b, player);
    const farA = da >= 320 ? 1 : 0;
    const farB = db >= 320 ? 1 : 0;
    if (farA !== farB) return farB - farA;
    if (farA && farB) {
      const sweetA = Math.abs(da - 560);
      const sweetB = Math.abs(db - 560);
      if (Math.abs(sweetA - sweetB) > 1e-6) return sweetA - sweetB;
    }
    return db - da || a.id.localeCompare(b.id);
  });
  const checkSlice = slice => {
    let best = null;
    let bestRank = -Infinity;
    // Only permanent map geometry; never incorporate live actors or temporary blockers.
    for (const goal of slice) {
      const path = planPublicRoute(district, player, goal, allowOffCurbSnap);
      if (path.length < 3) continue;
      const across = path.reduce((total, point, i) => i ? total + distance(path[i - 1], point) : 0, 0);
      if (!preferFar) {
        if (!best || across < best.lengthM) best = {
          id: goal.id, path: Object.freeze(path.map(point => Object.freeze(point))), lengthM: across,
        };
      } else {
        const directM = distance(goal, player);
        const rank = (directM >= 320 ? 1000 : 0) + Math.min(directM, 760) - across * 0.16;
        if (!best || rank > bestRank) {
          bestRank = rank;
          best = {
            id: goal.id, path: Object.freeze(path.map(point => Object.freeze(point))), lengthM: across,
          };
        }
      }
    }
    return best;
  };
  const primary = checkSlice(ordered.slice(0, maxCheck));
  if (primary || ordered.length <= maxCheck) return primary;
  const secondary = checkSlice(ordered.slice(maxCheck, maxCheck * 2));
  if (secondary || !preferFar || ordered.length <= maxCheck * 2) return secondary;
  return checkSlice(ordered.slice(maxCheck * 2, maxCheck * 3));
}

export function dispatchRouteGuide(world, version = LEGACY_ROUTE_CONTEXT, routeMode) {
  if (routeMode !== undefined && (routeMode !== CLEARANCE_CORRIDOR || version !== CLEARANCE_ROUTE_CONTEXT))
    throw new RangeError("Clearance corridor requires the Metro v2 route observation");
  const { district, player, pursuit } = world;
  if (!district || !pursuit?.gta) return null;
  const extended = version === CLEARANCE_ROUTE_CONTEXT;
  if (!extended && version !== LEGACY_ROUTE_CONTEXT) throw new RangeError("Unknown Metro route context");
  const { surveillanceZones = [] } = pursuit.gta.config ?? {};
  const extendedTopology = hasExtendedTopology(district, surveillanceZones) ||
    (world.config?.cityVersion ?? 0) >= 5;
  const explicit = pursuit.gta.publicRouteGoal ?? pursuit.gta.escapeGoal ?? null;
  const explicitGoalId = explicit ? (explicit.id ?? `${explicit.x}:${explicit.z}`) : null;
  const explicitGoalKey = explicit
    ? `${explicitGoalId}:${explicit.x}:${explicit.z}:${explicit.leg ?? 0}`
    : null;
  const cache = guides.get(routeMode ?? version);
  let cached = cache.get(pursuit);
  if (cached && cached.goalKey !== explicitGoalKey) {
    cached = undefined;
  }

  if (explicit && cached?.guide) {
    const canReplanExplicit = Boolean(pursuit.gta.escapeGoal || extended);
    const offExplicitPath =
      canReplanExplicit && cached.guide.path.every(p => distance(player, p) > 22);
    if (!offExplicitPath || world.tick < (cached.offPathRetryAt ?? 0)) {
      return cached.guide;
    }
    const replanned = selectBestRouteGuide(district, player, [explicit], 1, {
      preferFar: false,
      allowOffCurbSnap: Boolean(pursuit.gta.escapeGoal || extendedTopology),
    });
    if (replanned) {
      cache.set(pursuit, {
        guide: replanned,
        retryAt: world.tick + 48,
        offPathRetryAt: world.tick + 48,
        visited: cached.visited ?? new Set(),
        goalId: explicitGoalId,
        goalKey: explicitGoalKey,
      });
      return replanned;
    }
    cached.offPathRetryAt = world.tick + 48;
    return cached.guide;
  }

  const dynamicLoop = extended && !explicit && (
    pursuit.gta.config?.curbSupport === "metro-city-curbs-v2" ||
    extendedTopology
  );
  const end = cached?.guide?.path.at(-1);
  const nearEnd = Boolean(dynamicLoop && end && distance(player, end) < 18);
  if (cached && !nearEnd && world.tick < cached.retryAt) return cached.guide;
  if (cached?.guide && !dynamicLoop) return cached.guide;
  const visited = cached?.visited ?? new Set();
  if (cached?.guide && dynamicLoop) {
    const offPathThreshold = extendedTopology ? 22 : 18;
    const offPath = !nearEnd && cached.guide.path.every(p => distance(player, p) > offPathThreshold);
    if (!nearEnd && !offPath) {
      cached.retryAt = world.tick + 30;
      return cached.guide;
    }
    if (nearEnd) visited.add(cached.guide.id);
  }
  const allCandidates = explicit ? [explicit] :
    (extended ? clearanceGoals(district, surveillanceZones) :
      (district.pursuitExits ?? []).filter(goal => isOutside(goal, surveillanceZones)));
  let candidates = allCandidates;
  const preferFarDynamic = Boolean(dynamicLoop && !explicit && extendedTopology);
  if (dynamicLoop && !explicit) {
    let freshGoals = allCandidates.filter(goal => !visited.has(goal.id) && distance(goal, player) >= 48);
    if (!freshGoals.length) {
      visited.clear();
      if (nearEnd && cached?.guide?.id) visited.add(cached.guide.id);
      freshGoals = allCandidates.filter(goal => !visited.has(goal.id) && distance(goal, player) >= 48);
      if (!freshGoals.length)
        freshGoals = allCandidates.filter(goal => distance(goal, player) >= 48);
    }
    if (freshGoals.length) candidates = freshGoals;
  }
  if (routeMode === CLEARANCE_CORRIDOR && !explicit) {
    const guide = corridorGuide(district, player, surveillanceZones, candidates);
    if (guide) {
      cache.set(pursuit, {
        guide,
        retryAt: world.tick + 30,
        offPathRetryAt: 0,
        visited,
        goalId: explicitGoalId,
        goalKey: explicitGoalKey,
      });
      return guide;
    }
  }
  const maxCheck = extended ? (extendedTopology ? 12 : 8) : 5;
  const selectOpts = {
    preferFar: preferFarDynamic,
    allowOffCurbSnap: Boolean(pursuit.gta.escapeGoal || (explicit && extendedTopology)),
  };
  let best = selectBestRouteGuide(district, player, candidates, maxCheck, selectOpts);
  if (!best && dynamicLoop && !explicit && candidates !== allCandidates) {
    visited.clear();
    if (nearEnd && cached?.guide?.id) visited.add(cached.guide.id);
    const fallback = allCandidates.filter(goal => !visited.has(goal.id) && distance(goal, player) >= 48);
    best = selectBestRouteGuide(district, player, fallback.length ? fallback : allCandidates, maxCheck, selectOpts);
  }
  // A transient heading mismatch must not suppress cues for the rest of the chase.
  cache.set(pursuit, {
    guide: best,
    retryAt: world.tick + 30,
    offPathRetryAt: 0,
    visited,
    goalId: explicitGoalId,
    goalKey: explicitGoalKey,
  });
  return best;
}

export function sampleRouteNavigation(world, version, routeMode) {
  const guide = dispatchRouteGuide(world, version, routeMode);
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
