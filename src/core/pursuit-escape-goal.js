import { VEHICLE, clamp } from "./config.js";
import { planDistrictRoute } from "./district-navigation.js";
import { districtRoadPose } from "./egypt-district.js";
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
} from "./geometry.js";
import { Random } from "./random.js";
import { SpatialIndex } from "./spatial-index.js";
import { PLAYER_VEHICLE } from "./vehicle-spec.js";

const GOAL_PROBE = Object.freeze({
  type: "vehicle",
  width: PLAYER_VEHICLE.widthM ?? VEHICLE.width,
  length: PLAYER_VEHICLE.lengthM ?? VEHICLE.length,
});

const OCTANT_NAMES = Object.freeze([
  "North",
  "Northeast",
  "East",
  "Southeast",
  "South",
  "Southwest",
  "West",
  "Northwest",
]);

const ROAD_SECTOR_TITLES = Object.freeze({
  "nile-west-boulevard": "Zamalek Causeway",
  "opera-avenue": "Opera Boulevard",
  "corniche-avenue": "Corniche Sector",
  "civic-avenue": "Civic Boulevard",
  "gateway-avenue": "Ramses Gateway",
  "azhar-avenue": "Azhar Boulevard",
  "abbassia-avenue": "Abbassia Sector",
  "citadel-east-ring": "Citadel Sector",
  "south-ring-arterial": "Ring Sector",
  "garden-city-avenue": "Maadi & Garden Sector",
  "tahrir-boulevard": "Giza & Tahrir Approach",
  "station-avenue": "Station Promenade",
  "university-avenue": "University Boulevard",
  "clot-bey-avenue": "Clot Bey Sector",
  "ramses-north-arterial": "Ramses Sector",
  "qasr-diagonal": "Qasr El-Nil Causeway",
  "talaat-diagonal": "Talaat Harb Boulevard",
  "ramses-diagonal": "Ramses Diagonal",
  "citadel-diagonal": "Citadel Approach",
  "bazaar-slash": "Khan Bazaar Sector",
});

const DEFAULT_OCTANT_TITLES = Object.freeze([
  "Corniche Sector",
  "Citadel Sector",
  "Opera Boulevard",
  "Maadi Sector",
  "Ring Sector",
  "Giza Approach",
  "Zamalek Causeway",
  "Ramses Sector",
]);

const escapeCandidateCache = new WeakMap();
const recentLegHistory = new WeakMap();

function poseOnRoad(road, along, direction) {
  return isDiagonalRoad(road)
    ? roadPoseAt(road, along, direction)
    : districtRoadPose(road, along, direction);
}

function computeDistrictBounds(drivingRoads) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const road of drivingRoads) {
    if (!road || road.parkingBay || road.supportApron) continue;
    if (isDiagonalRoad(road)) {
      minX = Math.min(minX, road.x1, road.x2);
      maxX = Math.max(maxX, road.x1, road.x2);
      minZ = Math.min(minZ, road.z1, road.z2);
      maxZ = Math.max(maxZ, road.z1, road.z2);
    } else if (road.axis === "x") {
      minX = Math.min(minX, road.min);
      maxX = Math.max(maxX, road.max);
      minZ = Math.min(minZ, road.fixed);
      maxZ = Math.max(maxZ, road.fixed);
    } else {
      minX = Math.min(minX, road.fixed);
      maxX = Math.max(maxX, road.fixed);
      minZ = Math.min(minZ, road.min);
      maxZ = Math.max(maxZ, road.max);
    }
  }
  if (!Number.isFinite(minX)) {
    return { minX: -200, maxX: 200, minZ: -200, maxZ: 200, midX: 0, midZ: 0, diagSpan: 565 };
  }
  const midX = (minX + maxX) * 0.5;
  const midZ = (minZ + maxZ) * 0.5;
  const diagSpan = Math.hypot(Math.max(1, maxX - minX), Math.max(1, maxZ - minZ));
  return { minX, maxX, minZ, maxZ, midX, midZ, diagSpan };
}

function octantIndex(x, z, midX, midZ) {
  const angle = Math.atan2(x - midX, z - midZ);
  const raw = Math.round(angle / (Math.PI / 4));
  return ((raw % 8) + 8) % 8;
}

function formatRoadTitle(roadId, octIdx) {
  if (roadId && ROAD_SECTOR_TITLES[roadId]) return ROAD_SECTOR_TITLES[roadId];
  if (!roadId || typeof roadId !== "string") return DEFAULT_OCTANT_TITLES[octIdx];
  const cleaned = roadId
    .replace(/^metro-exit-/, "")
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
  if (!cleaned) return DEFAULT_OCTANT_TITLES[octIdx];
  return /sector|boulevard|avenue|ring|approach|causeway|diagonal/i.test(cleaned)
    ? cleaned
    : `${cleaned} Sector`;
}

function buildSectorLabel(x, z, midX, midZ, roadId) {
  const octIdx = octantIndex(x, z, midX, midZ);
  const compass = OCTANT_NAMES[octIdx];
  const title = formatRoadTitle(roadId, octIdx);
  if (title.toLowerCase().startsWith(compass.toLowerCase())) return title;
  return `${compass} ${title}`;
}

function makeStaticChecker(district) {
  const statics = Array.isArray(district.statics) ? district.statics : [];
  if (!statics.length) {
    return () => false;
  }
  const index = new SpatialIndex(statics, 40);
  const maxReach = statics.reduce(
    (m, s) => Math.max(m, Math.hypot(s.width ?? (s.radius ?? 0) * 2, s.length ?? (s.radius ?? 0) * 2) * 0.5),
    16,
  );
  const probeReach = Math.hypot(GOAL_PROBE.width, GOAL_PROBE.length) * 0.5;
  return (probe, margin = 0.14) => {
    const nearby = index.near(probe, maxReach + probeReach + margin + 0.5);
    return nearby.some((other) => overlaps(probe, other, margin));
  };
}

export function goalPoseClear(district, pose, staticHits = null) {
  if (!district || !pose || !Number.isFinite(pose.x) || !Number.isFinite(pose.z)) return false;
  const probe = {
    ...GOAL_PROBE,
    x: pose.x,
    z: pose.z,
    heading: pose.heading ?? 0,
  };
  if (Array.isArray(district.roads) && district.roads.length && !bodyOnRoad(probe, district.roads, 0.12)) {
    return false;
  }
  if (staticHits) {
    return !staticHits(probe, 0.14);
  }
  if (Array.isArray(district.statics) && district.statics.some((other) => overlaps(probe, other, 0.14))) {
    return false;
  }
  return true;
}

function roadCrossingAlongs(road, drivingRoads) {
  const cuts = [];
  for (const other of drivingRoads) {
    if (!other || other === road || other.id === road.id || other.parkingBay || other.supportApron) continue;
    const hit = roadIntersection(road, other, 0.5);
    if (hit) cuts.push(hit.alongA);
  }
  return cuts.sort((a, b) => a - b);
}

function corridorClearOnRoad(district, road, along, direction, frame, staticHits) {
  for (const delta of [-4.5, 0, 4.5]) {
    const sampleAlong = clamp(along + delta, frame.minAlong + 3.5, frame.maxAlong - 3.5);
    const samplePose = poseOnRoad(road, sampleAlong, direction);
    if (!goalPoseClear(district, samplePose, staticHits)) return false;
  }
  return true;
}

export function buildCityEscapeCandidates(district) {
  if (!district || !Array.isArray(district.drivingRoads) || district.drivingRoads.length === 0) {
    return Object.freeze([]);
  }
  const staticsLen = district.statics?.length ?? 0;
  const exitsLen = district.pursuitExits?.length ?? 0;
  const cached = escapeCandidateCache.get(district);
  if (
    cached &&
    cached.drivingRoadsRef === district.drivingRoads &&
    cached.staticsLen === staticsLen &&
    cached.exitsLen === exitsLen
  ) {
    return cached.candidates;
  }

  const drivingRoads = district.drivingRoads.filter(
    (r) => r && !r.parkingBay && !r.supportApron && (r.width ?? 8) >= GOAL_PROBE.width + 0.24,
  );
  if (!drivingRoads.length) return Object.freeze([]);

  const bounds = computeDistrictBounds(drivingRoads);
  const { midX, midZ, diagSpan } = bounds;
  const halfDiag = Math.max(1, diagSpan * 0.5);
  const staticHits = makeStaticChecker(district);
  const roadById = new Map(drivingRoads.map((r) => [r.id, r]));
  const cutsByRoad = new Map(drivingRoads.map((r) => [r.id, roadCrossingAlongs(r, drivingRoads)]));

  const rawCandidates = [];
  const pushCandidate = (id, pose, road, bonus = 0) => {
    if (!Number.isFinite(pose.x) || !Number.isFinite(pose.z) || !Number.isFinite(pose.heading)) return;
    const octant = octantIndex(pose.x, pose.z, midX, midZ);
    const radialNorm = Math.hypot(pose.x - midX, pose.z - midZ) / halfDiag;
    const isAvenue = road?.zone === "avenue" || (road?.width ?? 0) >= 12;
    const isDiag = Boolean(road && isDiagonalRoad(road));
    const rank = radialNorm + (isAvenue ? 0.22 : 0) + (isDiag ? 0.14 : 0) + bonus;
    rawCandidates.push({
      id,
      label: buildSectorLabel(pose.x, pose.z, midX, midZ, road?.id ?? pose.roadId),
      x: pose.x,
      z: pose.z,
      heading: pose.heading,
      roadId: road?.id ?? pose.roadId,
      octant,
      rank,
    });
  };

  for (const exit of district.pursuitExits ?? []) {
    const road = roadById.get(exit.roadId);
    if (!road) continue;
    const f = roadFrame(road);
    const proj = roadProject(road, exit);
    const cuts = cutsByRoad.get(road.id) ?? [];
    const align = f.ux * Math.sin(exit.heading ?? 0) + f.uz * Math.cos(exit.heading ?? 0);
    const dir = road.flow || (align >= 0 ? 1 : -1);
    if (cuts.length > 0) {
      const hasForwardExit =
        dir > 0 ? proj.along <= cuts[cuts.length - 1] - 12 : proj.along >= cuts[0] + 12;
      if (!hasForwardExit) continue;
    }
    if (corridorClearOnRoad(district, road, proj.along, dir, f, staticHits)) {
      const cleanPose = poseOnRoad(road, clamp(proj.along, f.minAlong + 10, f.maxAlong - 10), dir);
      pushCandidate(exit.id ?? `exit:${road.id}:${Math.round(proj.along)}`, cleanPose, road, 0.12);
    }
  }

  for (const road of drivingRoads) {
    const f = roadFrame(road);
    if (f.length < 28) continue;
    const cuts = cutsByRoad.get(road.id) ?? [];
    const stops = [f.minAlong, ...cuts.map((c) => clamp(c, f.minAlong, f.maxAlong)), f.maxAlong]
      .sort((a, b) => a - b)
      .filter((v, i, arr) => i === 0 || v - arr[i - 1] > 1.0);

    for (let sIdx = 1; sIdx < stops.length; sIdx++) {
      const a = stops[sIdx - 1];
      const b = stops[sIdx];
      const spanLen = b - a;
      if (spanLen < 26) continue;
      const margin = Math.min(16, spanLen * 0.28);
      const lo = a + margin;
      const hi = b - margin;
      if (hi < lo) continue;

      const fractions = spanLen >= 110 ? [0.22, 0.5, 0.78] : spanLen >= 58 ? [0.35, 0.65] : [0.5];
      for (const frac of fractions) {
        const along = lo + (hi - lo) * frac;
        for (const direction of road.flow ? [road.flow] : [1, -1]) {
          if (cuts.length > 0) {
            const hasIntersectionAhead =
              direction > 0 ? along <= cuts[cuts.length - 1] - 12 : along >= cuts[0] + 12;
            if (!hasIntersectionAhead) continue;
          } else {
            const rem = direction > 0 ? f.maxAlong - along : along - f.minAlong;
            if (rem < 14) continue;
          }
          if (!corridorClearOnRoad(district, road, along, direction, f, staticHits)) continue;
          const pose = poseOnRoad(road, along, direction);
          const id = `escape:${road.id}:${direction > 0 ? "p" : "n"}:${Math.round(along)}`;
          pushCandidate(id, pose, road, 0);
        }
      }
    }
  }

  const byOctant = Array.from({ length: 8 }, () => []);
  for (const cand of rawCandidates) {
    byOctant[cand.octant].push(cand);
  }
  for (const bucket of byOctant) {
    bucket.sort((a, b) => b.rank - a.rank || a.id.localeCompare(b.id));
  }

  const selected = [];
  const maxCandidates = 34;
  const minTarget = 16;
  const baseSpacing = clamp(diagSpan * 0.08, 22, 92);

  const runSelectionPass = (spacingM) => {
    const cursors = new Int32Array(8);
    let progressed = true;
    while (progressed && selected.length < maxCandidates) {
      progressed = false;
      for (let oct = 0; oct < 8 && selected.length < maxCandidates; oct++) {
        const bucket = byOctant[oct];
        while (cursors[oct] < bucket.length) {
          const cand = bucket[cursors[oct]++];
          if (selected.some((s) => s.id === cand.id)) continue;
          const tooClose = selected.some((s) => {
            const d = distance(s, cand);
            if (d < spacingM) return true;
            if (
              s.roadId === cand.roadId &&
              Math.abs(angleDelta(s.heading, cand.heading)) < 0.25 &&
              d < spacingM * 1.25
            ) {
              return true;
            }
            return false;
          });
          if (tooClose) continue;
          selected.push(
            Object.freeze({
              id: cand.id,
              label: cand.label,
              x: cand.x,
              z: cand.z,
              heading: cand.heading,
              roadId: cand.roadId,
            }),
          );
          progressed = true;
          break;
        }
      }
    }
  };

  runSelectionPass(baseSpacing);
  if (selected.length < minTarget && rawCandidates.length > selected.length) {
    runSelectionPass(Math.max(14, baseSpacing * 0.52));
  }
  if (selected.length < minTarget && rawCandidates.length > selected.length) {
    runSelectionPass(8);
  }

  const frozen = Object.freeze(selected);
  escapeCandidateCache.set(district, {
    drivingRoadsRef: district.drivingRoads,
    staticsLen,
    exitsLen,
    bounds,
    staticHits,
    candidates: frozen,
  });
  return frozen;
}

function curbOrNearestRejoinPose(district, playerBody, staticHits = null) {
  if (!Array.isArray(district.drivingRoads)) return null;
  const sin = Math.sin(playerBody.heading ?? 0);
  const cos = Math.cos(playerBody.heading ?? 0);
  const maxHeadingDelta = playerBody.curbSupportId ? 0.95 : 1.15;
  const maxLatExtra = playerBody.curbSupportId ? 5.0 : 4.5;
  let best = null;
  let bestCost = Infinity;

  for (const road of district.drivingRoads) {
    if (!road || road.parkingBay || road.supportApron) continue;
    const f = roadFrame(road);
    if (f.length < 8) continue;
    const proj = roadProject(road, playerBody);
    if (proj.along < f.minAlong - 5 || proj.along > f.maxAlong + 5) continue;
    if (proj.absLateral > road.width * 0.5 + maxLatExtra) continue;
    const align = f.ux * sin + f.uz * cos;
    const directions = road.flow ? [road.flow] : align >= 0 ? [1, -1] : [-1, 1];
    const along = clamp(proj.along, f.minAlong + 3.5, f.maxAlong - 3.5);
    for (const side of directions) {
      const candidate = poseOnRoad(road, along, side);
      const hErr = Math.abs(angleDelta(candidate.heading, playerBody.heading ?? candidate.heading));
      if (hErr > maxHeadingDelta) continue;
      const d = distance(playerBody, candidate);
      const cost = d + hErr * 3.0;
      if (cost < bestCost && goalPoseClear(district, candidate, staticHits)) {
        bestCost = cost;
        best = {
          ...playerBody,
          x: candidate.x,
          z: candidate.z,
          heading: candidate.heading,
        };
      }
    }
  }
  return best;
}

export function planPublicEscapeRoute(district, player, goal) {
  if (!district || !player || !goal) return [];
  const playerBody = {
    ...player,
    type: "vehicle",
    width: Number.isFinite(player.width) && player.width > 0 ? player.width : GOAL_PROBE.width,
    length: Number.isFinite(player.length) && player.length > 0 ? player.length : GOAL_PROBE.length,
    heading: Number.isFinite(player.heading) ? player.heading : 0,
  };
  if (!player.curbSupportId) {
    const direct = planDistrictRoute(district, playerBody, goal);
    if (direct.length >= 3) return direct;
  }
  const cached = escapeCandidateCache.get(district);
  const rejoin = curbOrNearestRejoinPose(district, playerBody, cached?.staticHits ?? null);
  if (!rejoin) {
    return player.curbSupportId ? planDistrictRoute(district, playerBody, goal) : [];
  }
  const rejoined = planDistrictRoute(district, rejoin, goal);
  if (rejoined.length < 3) {
    return player.curbSupportId ? planDistrictRoute(district, playerBody, goal) : [];
  }
  return [{ x: playerBody.x, z: playerBody.z }, ...rejoined];
}

export function selectFarEscapeGoal(world, options = {}) {
  const district = world?.district;
  const player = world?.player;
  if (!district || !player || !Number.isFinite(player.x) || !Number.isFinite(player.z)) {
    return null;
  }

  const candidates = buildCityEscapeCandidates(district);
  if (!candidates.length) return null;

  const isGrandV5 = Boolean((world?.config?.cityVersion ?? 0) >= 5 || district.grand);
  const minDistanceM = options.minDistanceM ?? (isGrandV5 ? 450 : 140);
  const leg = options.leg ?? 1;
  const excludeIds = new Set(options.excludeIds ?? []);

  const cached = escapeCandidateCache.get(district);
  const bounds = cached?.bounds ?? computeDistrictBounds(district.drivingRoads ?? []);
  const { midX, midZ } = bounds;

  const nonExcluded = candidates.filter((c) => !excludeIds.has(c.id));
  const usablePool = nonExcluded.length > 0 ? nonExcluded : candidates;
  const farCandidates = usablePool.filter((c) => distance(player, c) >= minDistanceM);
  const pool = farCandidates.length > 0 ? farCandidates : usablePool;

  const rngSeed =
    options.seed ??
    world?.pursuit?.rng?.state ??
    world?.config?.seed ??
    "far-escape-v1";
  const detRng = new Random(
    `${rngSeed}:leg-${leg}:tick-${world?.tick ?? 0}:${Math.round(player.x)}:${Math.round(player.z)}`,
  );

  const vpX = player.x - midX;
  const vpZ = player.z - midZ;
  const vpLen = Math.hypot(vpX, vpZ);
  const playerHeading = Number.isFinite(player.heading) ? player.heading : 0;

  const ranked = pool
    .map((cand) => {
      const distM = distance(player, cand);
      const vcX = cand.x - midX;
      const vcZ = cand.z - midZ;
      const vcLen = Math.hypot(vcX, vcZ);

      let oppositeScore = 0;
      if (vpLen > 35 && vcLen > 35) {
        const oppDot = -(vpX * vcX + vpZ * vcZ) / (vpLen * vcLen);
        oppositeScore = oppDot * 18.0;
      } else {
        oppositeScore = (vcLen / Math.max(1, isGrandV5 ? 450 : 160)) * 8.0;
      }

      let bandScore;
      if (farCandidates.length === 0) {
        bandScore = distM * 0.1;
      } else if (isGrandV5) {
        bandScore =
          distM >= 460 && distM <= 780
            ? 16.0 - Math.abs(distM - 620) * 0.02
            : distM > 780
              ? 12.5 - (distM - 780) * 0.014
              : 9.0;
      } else {
        bandScore = Math.min(16.0, distM * 0.05);
      }

      const bearing = Math.atan2(cand.x - player.x, cand.z - player.z);
      const hDiff = Math.abs(angleDelta(bearing, playerHeading));
      const alignScore = hDiff <= Math.PI * 0.7 ? 5.5 * Math.cos(hDiff * 0.65) : -4.5;
      const jitter = detRng.range(0, 4.0);

      return {
        cand,
        distM,
        score: oppositeScore + bandScore + alignScore + jitter,
      };
    })
    .sort((a, b) => b.score - a.score || b.distM - a.distM || a.cand.id.localeCompare(b.cand.id));

  let chosen = null;
  const topSlice = ranked.slice(0, 6);
  for (const item of topSlice) {
    if (planPublicEscapeRoute(district, player, item.cand).length >= 3) {
      chosen = item.cand;
      break;
    }
  }
  if (!chosen) {
    for (let i = 6; i < ranked.length; i++) {
      if (planPublicEscapeRoute(district, player, ranked[i].cand).length >= 3) {
        chosen = ranked[i].cand;
        break;
      }
    }
  }
  if (!chosen) {
    chosen = ranked[0].cand;
  }

  return Object.freeze({
    id: chosen.id,
    label: chosen.label,
    x: chosen.x,
    z: chosen.z,
    heading: chosen.heading,
    roadId: chosen.roadId,
    initialDistanceM: Number(distance(player, chosen).toFixed(1)),
    leg,
  });
}

export function advanceEscapeGoalIfReached(world, reachRadiusM = 38) {
  const goal = world?.pursuit?.gta?.escapeGoal;
  if (!goal) return null;
  if (!world.player || distance(world.player, goal) > reachRadiusM) {
    return goal;
  }
  const keyObj = world.pursuit;
  let seen = keyObj ? recentLegHistory.get(keyObj) : null;
  if (!seen) {
    seen = [];
    if (keyObj) recentLegHistory.set(keyObj, seen);
  }
  if (!seen.includes(goal.id)) {
    seen.push(goal.id);
    if (seen.length > 6) seen.shift();
  }
  const nextGoal = selectFarEscapeGoal(world, {
    excludeIds: seen.length ? seen : [goal.id],
    leg: (goal.leg ?? 1) + 1,
  });
  if (nextGoal) {
    world.pursuit.gta.escapeGoal = nextGoal;
  }
  return world.pursuit.gta.escapeGoal;
}

export function escapeGoalSnapshot(world) {
  const goal = world?.pursuit?.gta?.escapeGoal;
  if (!goal || !world?.player) return null;
  return {
    id: goal.id,
    label: goal.label,
    x: goal.x,
    z: goal.z,
    roadId: goal.roadId,
    leg: goal.leg ?? 1,
    distanceM: Math.round(distance(world.player, goal)),
    initialDistanceM: goal.initialDistanceM,
  };
}
