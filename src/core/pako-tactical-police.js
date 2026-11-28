import { VEHICLE, clamp } from "./config.js";
import {
  angleDelta,
  bodyOnRoad,
  corners,
  distance,
  isDiagonalRoad,
  overlaps,
  pointOnRoad,
  roadFrame,
  roadIntersection,
  roadPoseAt,
  roadProject,
} from "./geometry.js";
import { isPoseSupportedWithCurbs } from "./pako-curb.js";
import { integrateVehicle, vehicleProbe } from "./vehicle.js";

export const TACTICAL_PURSUIT_MODE = "gta-tactical-v1";
export const CITY_FAIR_POLICE = "city-fair-v1";
export const CITY_FAIR_POLICE_SPEED_MPS = 28;

export function isFairCityPolice(state) {
  return (state?.gta?.config ?? state)?.policeFairness === CITY_FAIR_POLICE;
}

const SQUAD_BY_STAR = Object.freeze([0, 4, 6, 8, 11, 14]);
const SEARCH_FAN_ANGLES = Object.freeze([0, 0.58, -0.58, 1.15, -1.15, 1.75, -1.75, Math.PI]);
const OVERTAKE_STEER_OFFSETS = Object.freeze([0.08, -0.08, 0.15, -0.15, 0.24, -0.24, 0.38, -0.38, 0.54, -0.54, 0.68, -0.68]);
const LOOKAHEAD_DISTANCES = Object.freeze([8, 18, 30]);

const staticReachCache = new WeakMap();
const tacticalRoadListCache = new WeakMap();

function getCachedTacticalRoadLists(rawRoads) {
  if (!Array.isArray(rawRoads) || rawRoads.length === 0) {
    return { roads: [], standardRoads: [] };
  }
  let cached = tacticalRoadListCache.get(rawRoads);
  const len = rawRoads.length;
  const first = rawRoads[0];
  const last = rawRoads[len - 1];
  if (!cached || cached.len !== len || cached.first !== first || cached.last !== last) {
    const drivableRoads = rawRoads.filter((r) => r && !r.parkingBay && !r.supportApron);
    const roads = drivableRoads.length > 0 ? drivableRoads : rawRoads;
    const standardRoads = roads.filter((r) => r.axis != null || isDiagonalRoad(r));
    cached = { len, first, last, roads, standardRoads };
    tacticalRoadListCache.set(rawRoads, cached);
  }
  return cached;
}
const roadJunctionCache = new WeakMap();

function headingTo(from, to) {
  return Math.atan2(to.x - from.x, to.z - from.z);
}

function isPedestrian(actor) {
  return actor?.type === "pedestrian" || actor?.kind === "pedestrian";
}

function getStaticMeta(statics) {
  if (!Array.isArray(statics) || statics.length === 0) {
    return { reach: 0, hasParkedVehicles: false };
  }
  const cached = staticReachCache.get(statics);
  if (cached && cached.len === statics.length) return cached;
  let reach = 0;
  let hasParkedVehicles = false;
  for (let i = 0; i < statics.length; i++) {
    const s = statics[i];
    const r = Math.hypot(s?.width ?? 0, s?.length ?? 0) * 0.5;
    if (r > reach) reach = r;
    if (s?.kind === "parked-vehicle") hasParkedVehicles = true;
  }
  const entry = { len: statics.length, reach, hasParkedVehicles };
  staticReachCache.set(statics, entry);
  return entry;
}

function queryNearbyStatics(world, origin, radius) {
  if (world?.staticIndex) {
    return world.staticIndex.near(origin, radius + getStaticMeta(world.statics).reach);
  }
  return world?.statics ?? [];
}

function queryNearbyActors(world, origin, radius) {
  if (world?.actorIndex) {
    return world.actorIndex.near(origin, radius);
  }
  return world?.actors ?? [];
}

function normalizeRect(body, fallbackWidth = VEHICLE.width, fallbackLength = VEHICLE.length) {
  if (body.width != null && body.length != null && body.type !== "pedestrian") return body;
  const diameter = Number.isFinite(body.radius) ? body.radius * 2 : null;
  return {
    x: body.x,
    z: body.z,
    heading: body.heading ?? 0,
    width: body.width ?? diameter ?? fallbackWidth,
    length: body.length ?? diameter ?? fallbackLength,
  };
}

function pointSegmentDistance(p, a, b) {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len2 = dx * dx + dz * dz;
  const t = len2 > 0 ? clamp(((p.x - a.x) * dx + (p.z - a.z) * dz) / len2, 0, 1) : 0;
  return Math.hypot(p.x - (a.x + dx * t), p.z - (a.z + dz * t));
}

function boxToCircleGap(rect, circle) {
  const h = rect.heading ?? 0;
  const dx = circle.x - rect.x;
  const dz = circle.z - rect.z;
  const c = Math.cos(h);
  const s = Math.sin(h);
  const halfW = (rect.width ?? VEHICLE.width) * 0.5;
  const halfL = (rect.length ?? VEHICLE.length) * 0.5;
  const localRight = Math.abs(dx * c - dz * s) - halfW;
  const localForward = Math.abs(dx * s + dz * c) - halfL;
  const boxDist =
    localRight <= 0 && localForward <= 0
      ? Math.max(localRight, localForward)
      : Math.hypot(Math.max(0, localRight), Math.max(0, localForward));
  const radius = Number.isFinite(circle.radius)
    ? circle.radius
    : Math.max(circle.width ?? 0.6, circle.length ?? 0.6) * 0.5;
  return boxDist - radius;
}

function gapBetween(probe, other) {
  if (isPedestrian(other) || (Number.isFinite(other.radius) && other.width == null && other.length == null)) {
    return boxToCircleGap(probe, other);
  }
  const rectA = normalizeRect(probe, 1.9, 4.5);
  const rectB = normalizeRect(other);
  const rA = Math.hypot(rectA.width, rectA.length) * 0.5;
  const rB = Math.hypot(rectB.width, rectB.length) * 0.5;
  const minPossibleGap = Math.hypot(rectA.x - rectB.x, rectA.z - rectB.z) - rA - rB;
  if (minPossibleGap > 1.6) return minPossibleGap;
  if (overlaps(rectA, rectB, 0)) return 0;
  const pa = corners(rectA);
  const pb = corners(rectB);
  let best = Infinity;
  for (let i = 0; i < 4; i++) {
    const a1 = pa[i];
    const a2 = pa[(i + 1) & 3];
    const b1 = pb[i];
    const b2 = pb[(i + 1) & 3];
    for (let j = 0; j < 4; j++) {
      const d1 = pointSegmentDistance(pa[j], b1, b2);
      const d2 = pointSegmentDistance(pb[j], a1, a2);
      if (d1 < best) best = d1;
      if (d2 < best) best = d2;
    }
  }
  return best;
}

const movedActorScratch = {
  x: 0,
  z: 0,
  heading: 0,
  width: undefined,
  length: undefined,
  radius: undefined,
  type: undefined,
  kind: undefined,
};

function advanceActorPose(actor, dt) {
  if (!dt) return actor;
  const vx = Number.isFinite(actor.vx)
    ? actor.vx
    : Number.isFinite(actor.speed) && actor.speed !== 0
      ? Math.sin(actor.heading ?? 0) * actor.speed
      : 0;
  const vz = Number.isFinite(actor.vz)
    ? actor.vz
    : Number.isFinite(actor.speed) && actor.speed !== 0
      ? Math.cos(actor.heading ?? 0) * actor.speed
      : 0;
  if (vx === 0 && vz === 0) return actor;
  movedActorScratch.x = actor.x + vx * dt;
  movedActorScratch.z = actor.z + vz * dt;
  movedActorScratch.heading = actor.heading ?? 0;
  movedActorScratch.width = actor.width;
  movedActorScratch.length = actor.length;
  movedActorScratch.radius = actor.radius;
  movedActorScratch.type = actor.type;
  movedActorScratch.kind = actor.kind;
  return movedActorScratch;
}

function roadAxisVectors(road) {
  if (road?.start && road?.end && road.axis == null) {
    const dx = road.end.x - road.start.x;
    const dz = road.end.z - road.start.z;
    const len = Math.hypot(dx, dz) || 1;
    const ux = dx / len;
    const uz = dz / len;
    return {
      x1: road.start.x,
      z1: road.start.z,
      ux,
      uz,
      heading: Math.atan2(ux, uz),
      minAlong: 0,
      maxAlong: len,
    };
  }
  return roadFrame(road);
}

function snapPoseOnRoad(road, point, side = 1, carWidth = 1.9, carLength = 4.5) {
  const frame = roadAxisVectors(road);
  const pad = Math.min(carLength * 0.5 + 0.35, Math.max(0, (frame.maxAlong - frame.minAlong) * 0.45));
  const lo = frame.minAlong + pad;
  const hi = frame.maxAlong - pad;

  if (road?.start && road?.end && road.axis == null) {
    const dx = point.x - frame.x1;
    const dz = point.z - frame.z1;
    const along = clamp(dx * frame.ux + dz * frame.uz, lo, hi);
    const s = road.flow || side;
    const useOffset = (road.width ?? 8) >= carWidth + 0.3 + 2 * Math.abs(road.laneOffsetM ?? 0);
    const offset = useOffset ? s * (road.laneOffsetM ?? 0) : 0;
    const centerX = frame.x1 + along * frame.ux;
    const centerZ = frame.z1 + along * frame.uz;
    return {
      x: centerX - offset * frame.uz,
      z: centerZ + offset * frame.ux,
      centerX,
      centerZ,
      heading: s >= 0 ? frame.heading : Math.atan2(-frame.ux, -frame.uz),
      along,
    };
  }

  const proj = roadProject(road, point);
  const along = clamp(proj.along, lo, hi);
  const useOffset = (road.width ?? 8) >= carWidth + 0.3 + 2 * Math.abs(road.laneOffsetM ?? 0);
  const snapped = roadPoseAt(road, along, side, useOffset ? null : 0);
  const center = roadPoseAt(road, along, 1, 0);
  return {
    x: snapped.x,
    z: snapped.z,
    centerX: center.x,
    centerZ: center.z,
    heading: snapped.heading,
    along,
  };
}

function makeSimProbe(car, speed, capSpeed) {
  const probe = vehicleProbe(car, speed);
  probe.heading = car.heading ?? 0;
  probe.steer = car.steer ?? 0;
  probe.width = car.width ?? 1.9;
  probe.length = car.length ?? 4.5;
  probe.maxSpeed = car.maxSpeed ?? Math.max(capSpeed, speed, 38);
  return probe;
}

export function isTacticalPursuit(pursuitOrConfig) {
  return (
    pursuitOrConfig?.tacticalPursuit === TACTICAL_PURSUIT_MODE ||
    pursuitOrConfig?.gta?.config?.tacticalPursuit === TACTICAL_PURSUIT_MODE
  );
}

export function tacticalSquadCap(wantedLevel, maxActivePatrols = 14) {
  const star = clamp(Math.round(wantedLevel || 1), 1, 5);
  const cap = Number.isFinite(maxActivePatrols) ? Math.max(0, maxActivePatrols) : 14;
  return Math.min(cap, SQUAD_BY_STAR[star]);
}

export function tacticalPatrolSpec(unitType, wantedLevel = 3, npcSpeedMultiplier = 1, fairness) {
  const level = clamp(Math.round(wantedLevel || 1), 1, 5);
  const mult = Number.isFinite(npcSpeedMultiplier) && npcSpeedMultiplier > 0 ? npcSpeedMultiplier : 1;

  if (unitType === "interceptor") {
    return {
      maxSpeed: Math.min((35.5 + 0.5 * level) * mult, fairness === CITY_FAIR_POLICE ? CITY_FAIR_POLICE_SPEED_MPS : Infinity),
      acceleration: 8.8,
      braking: 11.4,
      steerRate: 2.75,
      wheelbase: VEHICLE.wheelbase,
      reverseSpeed: 7.5,
    };
  }
  if (unitType === "swat") {
    return {
      maxSpeed: Math.min((28.8 + 0.4 * level) * mult, fairness === CITY_FAIR_POLICE ? CITY_FAIR_POLICE_SPEED_MPS : Infinity),
      acceleration: 6.4,
      braking: 10.0,
      steerRate: 1.95,
      wheelbase: 3.15,
      reverseSpeed: 6.2,
    };
  }
  return {
    maxSpeed: Math.min((33.1 + 0.45 * level) * mult, fairness === CITY_FAIR_POLICE ? CITY_FAIR_POLICE_SPEED_MPS : Infinity),
    acceleration: 7.6,
    braking: 10.6,
    steerRate: 2.45,
    wheelbase: VEHICLE.wheelbase,
    reverseSpeed: 7.0,
  };
}

export function tacticalPatrolPace(pursuit, car, reportSpeed = 0, range = 30) {
  const level = clamp(pursuit?.wantedLevel ?? 3, 1, 5);
  const top = car?.maxSpeed ?? (33.5 + 0.45 * level);
  const spd = Number.isFinite(reportSpeed) ? Math.abs(reportSpeed) : 0;

  if (range > 26) return top;
  if (range > 11) {
    return clamp(Math.max(spd + 6.5 + 0.6 * level, top * 0.9), 22, top);
  }
  if (car?.squadRole === "BLOCK" || car?.aiState === "INTERCEPT" || car?.aiState === "BLOCK_INTERCEPT") {
    return clamp(Math.max(spd + 4.5, 20), 16, top);
  }
  return clamp(Math.max(spd + 5.2, 21), 17, top);
}

export function tacticalSurgePace(pursuit, car, reportSpeed = 0, range = 30, headingError = 0) {
  const base = tacticalPatrolPace(pursuit, car, reportSpeed, range);
  const top = car?.maxSpeed ?? base;
  const straightAligned = Math.abs(headingError) < 0.14 && Math.abs(car?.steer ?? 0) < 0.10;
  if (car?.unitType === "interceptor" && straightAligned && range > 8.5) {
    return top;
  }
  if (straightAligned && range > 16) {
    return top;
  }
  return base;
}

function getWorldJunctions(world) {
  if (Array.isArray(world?.pursuit?.junctions) && world.pursuit.junctions.length > 0) {
    return world.pursuit.junctions;
  }
  const roads = world?.drivingRoads;
  if (!Array.isArray(roads) || roads.length === 0) return [];
  const cached = roadJunctionCache.get(roads);
  if (cached && cached.len === roads.length) return cached.junctions;
  const nonApron = roads.filter((r) => r && !r.supportApron && !r.parkingBay);
  const junctions = [];
  for (let i = 0; i < nonApron.length; i++) {
    for (let j = i + 1; j < nonApron.length; j++) {
      const hit = roadIntersection(nonApron[i], nonApron[j], 0.5);
      if (hit && !junctions.some((p) => Math.hypot(p.x - hit.x, p.z - hit.z) < 0.8)) {
        junctions.push({ x: hit.x, z: hit.z });
      }
    }
  }
  roadJunctionCache.set(roads, { len: roads.length, junctions });
  return junctions;
}

/**
 * Multi-role tactical pursuit target coordination when legal contact is active (unitsInContact > 0).
 * Never reads world.player directly — strictly projects from the legal sighting report!
 */
export function planTacticalInterceptAim(world, car, report, slotIndex = 0) {
  const unitsInContact = world?.pursuit?.response?.unitsInContact ?? 0;
  const slot = Math.max(0, Math.trunc(slotIndex || 0));
  if (!report || !Number.isFinite(report.x) || !Number.isFinite(report.z)) {
    return {
      x: Number.isFinite(car?.x) ? car.x : 0,
      z: Number.isFinite(car?.z) ? car.z : 0,
      heading: Number.isFinite(car?.heading) ? car.heading : 0,
      roadId: car?.gtaAI?.beat?.roadId ?? null,
      role: "HOLD",
      horizonS: 0,
      junctionIntercept: false,
    };
  }
  if (unitsInContact <= 0) {
    const order = car?.gtaAI?.order ?? slot;
    return {
      ...selectTacticalSearchTarget(world, car, report, order),
      role: "SEARCH",
      horizonS: 0,
      junctionIntercept: false,
    };
  }

  const rawSpeed = Number.isFinite(report.speed) ? report.speed : 0;
  const vx = Number.isFinite(report.vx) ? report.vx : Math.sin(report.heading ?? 0) * rawSpeed;
  const vz = Number.isFinite(report.vz) ? report.vz : Math.cos(report.heading ?? 0) * rawSpeed;
  const velMag = Math.hypot(vx, vz);
  const heading = velMag > 0.8 ? Math.atan2(vx, vz) : (report.heading ?? 0);
  const fx = Math.sin(heading), fz = Math.cos(heading);
  const rx = Math.cos(heading), rz = -Math.sin(heading);
  const reportSpeed = Math.max(velMag, Math.abs(rawSpeed), 9.5);
  const range = car && Number.isFinite(car.x) && Number.isFinite(car.z) ? distance(car, report) : 24;

  if ((world?.pursuit?.wantedLevel ?? 1) < 3) {
    if (slot === 0) {
      const horizonS = clamp(0.34 + range * 0.015, 0.30, 1.08);
      const forwardM = clamp((velMag > 0.2 ? velMag : rawSpeed) * horizonS, -10, 19);
      const resolved = resolveTacticalRoadAim(world, car, {
        x: report.x + fx * forwardM,
        z: report.z + fz * forwardM,
        heading,
      }, { vx: fx * Math.max(velMag, 10), vz: fz * Math.max(velMag, 10) });
      return { x: resolved.x, z: resolved.z, heading: resolved.heading ?? heading,
        role: "LEAD", horizonS, junctionIntercept: false };
    }

    const horizonS = slot === 1
      ? clamp(1.65 + range * 0.006, 1.6, 2.15)
      : slot === 2
        ? clamp(2.15 + range * 0.008, 2.05, 2.6)
        : clamp(1.75 + (slot % 3) * 0.35, 1.6, 2.6);
    const projectedM = clamp(reportSpeed * horizonS, 15, 86);
    const projected = { x: report.x + fx * projectedM, z: report.z + fz * projectedM };
    const side = car?.squadSide || (slot % 2 === 1 ? 1 : -1);
    let junction = null, junctionScore = Infinity;
    const minForwardM = Math.max(11, reportSpeed * 0.85);
    const maxForwardM = Math.max(30, projectedM + 22);
    for (const candidate of getWorldJunctions(world)) {
      const dx = candidate.x - report.x, dz = candidate.z - report.z;
      const forwardM = dx * fx + dz * fz;
      if (forwardM < minForwardM || forwardM > maxForwardM) continue;
      const lateralM = Math.abs(dx * rx + dz * rz);
      if (lateralM > 16.5) continue;
      const score = Math.hypot(candidate.x - projected.x, candidate.z - projected.z) + lateralM * 0.65;
      if (score < junctionScore) { junctionScore = score; junction = candidate; }
    }
    let rawAim;
    if (junction) {
      rawAim = slot === 2 || car?.squadRole === "INTERCEPTOR"
        ? { x: junction.x + fx * 3.8 + rx * side * 2.8,
            z: junction.z + fz * 3.8 + rz * side * 2.8, heading }
        : { x: junction.x - fx * 2.6 + rx * side * 4.5,
            z: junction.z - fz * 2.6 + rz * side * 4.5, heading };
    } else {
      const lateralM = slot === 1 ? side * 4.3 : slot === 2 ? side * 3.4 : side * 4.8;
      rawAim = { x: projected.x + rx * lateralM, z: projected.z + rz * lateralM, heading };
    }
    const resolved = resolveTacticalRoadAim(world, car, rawAim, {
      vx: fx * reportSpeed, vz: fz * reportSpeed,
    });
    return { x: resolved.x, z: resolved.z, heading: resolved.heading ?? heading,
      role: slot === 1 ? "FLANK" : slot === 2 ? "CUTOFF" : "CONTAIN",
      horizonS, junctionIntercept: Boolean(junction) };
  }

  const resolve = (rawAim, role, horizonS, junctionIntercept = false) => {
    const resolved = resolveTacticalRoadAim(world, car, rawAim, {
      vx: fx * reportSpeed,
      vz: fz * reportSpeed,
    });
    return {
      x: resolved.x,
      z: resolved.z,
      heading: resolved.heading ?? heading,
      role,
      horizonS,
      junctionIntercept,
    };
  };

  if (slot === 0) {
    const horizonS = clamp(0.34 + range * 0.012, 0.30, 0.92);
    const forwardM = clamp(reportSpeed * horizonS, 6, 18);
    return resolve({
      x: report.x + fx * forwardM,
      z: report.z + fz * forwardM,
      heading,
    }, "LEAD", horizonS);
  }

  if (slot === 1 || slot === 2) {
    const side = slot === 1 ? -1 : 1;
    const forwardM = clamp(18 + range * 0.16 + (slot - 1) * 6, 18, 38);
    const lateralM = side * clamp(3.6 + range * 0.025, 3.8, 6.2);
    const fairCity = isFairCityPolice(world?.pursuit);
    const horizonS = fairCity
      ? clamp(forwardM / reportSpeed, 0.8, 2.1)
      : slot === 1
        ? clamp(1.65 + range * 0.006, 1.6, 2.15)
        : clamp(2.15 + range * 0.008, 2.05, 2.6);
    const rawAim = {
      x: report.x + fx * forwardM + rx * lateralM,
      z: report.z + fz * forwardM + rz * lateralM,
      heading: heading - side * 0.18,
      width: car?.width,
      length: car?.length,
    };
    const role = fairCity
      ? (slot === 1 ? "PINCER_LEFT" : "PINCER_RIGHT")
      : (slot === 1 ? "FLANK" : "CUTOFF");
    if (isTacticalPatrolPoseSupported(world, rawAim)) {
      return {
        x: rawAim.x,
        z: rawAim.z,
        heading: rawAim.heading,
        role,
        horizonS,
        junctionIntercept: false,
      };
    }
    return resolve(rawAim, role, horizonS);
  }

  const junctions = getWorldJunctions(world);
  const chooseJunction = (targetForwardM, minForwardM, maxForwardM, lateralCapM) => {
    let best = null, bestScore = Infinity;
    for (const junction of junctions) {
      const dx = junction.x - report.x, dz = junction.z - report.z;
      const forwardM = dx * fx + dz * fz;
      if (forwardM < minForwardM || forwardM > maxForwardM) continue;
      const lateralM = Math.abs(dx * rx + dz * rz);
      if (lateralM > lateralCapM) continue;
      const score = Math.abs(forwardM - targetForwardM) + lateralM * 0.7;
      if (score < bestScore) {
        bestScore = score;
        best = { ...junction, forwardM, lateralM };
      }
    }
    return best;
  };

  if (slot <= 5) {
    const horizonS = [0, 0, 0, 1.8, 2.45, 3.2][slot];
    const projectedM = clamp(reportSpeed * horizonS, 35, 95);
    const junction = chooseJunction(projectedM, 24, 105, 18);
    const side = slot === 3 ? 0 : slot === 4 ? -1 : 1;
    const rawAim = junction
      ? {
          x: junction.x + rx * side * 2.4,
          z: junction.z + rz * side * 2.4,
          heading,
        }
      : {
          x: report.x + fx * projectedM + rx * side * 4.5,
          z: report.z + fz * projectedM + rz * side * 4.5,
          heading,
        };
    const role = slot === 3 ? "CUTOFF_INTERCEPT" : slot === 4 ? "CROSS_AMBUSH_LEFT" : "CROSS_AMBUSH_RIGHT";
    return resolve(rawAim, role, horizonS, Boolean(junction));
  }

  const horizonS = clamp(2.2 + (slot % 4) * 0.24, 2.2, 3.0);
  const projectedM = clamp(reportSpeed * horizonS + 14, 40, 100);
  const side = slot % 2 ? -1 : 1;
  const lateralM = side * (7 + (slot % 3) * 2.5);
  const junction = chooseJunction(projectedM, 34, 112, 28);
  const rawAim = junction
    ? { x: junction.x + rx * lateralM * 0.35, z: junction.z + rz * lateralM * 0.35, heading }
    : {
        x: report.x + fx * projectedM + rx * lateralM,
        z: report.z + fz * projectedM + rz * lateralM,
        heading,
      };
  return resolve(rawAim, "FORWARD_CONTAIN", horizonS, Boolean(junction));
}

export function canPatrolUseCurbPrivilege(world, car) {
  return Boolean(
    isTacticalPursuit(world?.pursuit) &&
      world?.pursuit?.gta?.curb &&
      car?.gtaAI &&
      !car.gtaRoadblock &&
      car.aiState !== "WRECKED",
  );
}

function poseInSingleRoadFast(pose, roads, margin = 0.25) {
  if (!Array.isArray(roads) || roads.length === 0) return false;
  const h0 = pose.heading ?? 0;
  const s = Math.sin(h0);
  const c = Math.cos(h0);
  const hw = (pose.width ?? VEHICLE.width) * 0.5;
  const hl = (pose.length ?? VEHICLE.length) * 0.5;
  const cw = c * hw;
  const sw = s * hw;
  const cl = c * hl;
  const sl = s * hl;
  const x = pose.x;
  const z = pose.z;
  const x0 = x - cw - sl, z0 = z + sw - cl;
  const x1 = x + cw - sl, z1 = z - sw - cl;
  const x2 = x + cw + sl, z2 = z - sw + cl;
  const x3 = x - cw + sl, z3 = z + sw + cl;
  const minX = Math.min(x0, x1, x2, x3);
  const maxX = Math.max(x0, x1, x2, x3);
  const minZ = Math.min(z0, z1, z2, z3);
  const maxZ = Math.max(z0, z1, z2, z3);

  for (let i = 0; i < roads.length; i++) {
    const road = roads[i];
    const h = (road.width ?? 0) * 0.5 - margin;
    if (h <= 0) continue;
    if (road.axis === "diag") {
      const ux = road.ux, uz = road.uz, rx1 = road.x1, rz1 = road.z1, maxAlong = road.length + h;
      const d0x = x0 - rx1, d0z = z0 - rz1, a0 = d0x * ux + d0z * uz;
      if (a0 < -h || a0 > maxAlong || Math.abs(-d0x * uz + d0z * ux) > h) continue;
      const d1x = x1 - rx1, d1z = z1 - rz1, a1 = d1x * ux + d1z * uz;
      if (a1 < -h || a1 > maxAlong || Math.abs(-d1x * uz + d1z * ux) > h) continue;
      const d2x = x2 - rx1, d2z = z2 - rz1, a2 = d2x * ux + d2z * uz;
      if (a2 < -h || a2 > maxAlong || Math.abs(-d2x * uz + d2z * ux) > h) continue;
      const d3x = x3 - rx1, d3z = z3 - rz1, a3 = d3x * ux + d3z * uz;
      if (a3 < -h || a3 > maxAlong || Math.abs(-d3x * uz + d3z * ux) > h) continue;
      return true;
    }
    if (road.axis === "z") {
      if (minX >= road.fixed - h && maxX <= road.fixed + h && minZ >= road.min - h && maxZ <= road.max + h) {
        return true;
      }
    } else if (road.axis === "x") {
      if (minX >= road.min - h && maxX <= road.max + h && minZ >= road.fixed - h && maxZ <= road.fixed + h) {
        return true;
      }
    }
  }
  return false;
}

function filterNearbyRoads(roads, origin, radius) {
  if (!Array.isArray(roads) || roads.length <= 4) return roads ?? [];
  const minX = origin.x - radius;
  const maxX = origin.x + radius;
  const minZ = origin.z - radius;
  const maxZ = origin.z + radius;
  const out = [];
  for (let i = 0; i < roads.length; i++) {
    const r = roads[i];
    if (!r) continue;
    const hw = (r.width ?? 14) * 0.5 + 4;
    if (r.axis === "z") {
      if (r.fixed + hw >= minX && r.fixed - hw <= maxX && r.max + hw >= minZ && r.min - hw <= maxZ) out.push(r);
    } else if (r.axis === "x") {
      if (r.max + hw >= minX && r.min - hw <= maxX && r.fixed + hw >= minZ && r.fixed - hw <= maxZ) out.push(r);
    } else if (r.axis === "diag") {
      const rx2 = r.x2 ?? r.x1 + r.ux * r.length;
      const rz2 = r.z2 ?? r.z1 + r.uz * r.length;
      if (
        Math.max(r.x1, rx2) + hw >= minX &&
        Math.min(r.x1, rx2) - hw <= maxX &&
        Math.max(r.z1, rz2) + hw >= minZ &&
        Math.min(r.z1, rz2) - hw <= maxZ
      ) {
        out.push(r);
      }
    } else {
      out.push(r);
    }
  }
  return out;
}

export function isTacticalPatrolPoseSupported(world, pose) {
  if (!world || !pose) return false;
  const body =
    pose.width != null && pose.length != null
      ? pose
      : {
          ...pose,
          heading: pose.heading ?? 0,
          width: pose.width ?? VEHICLE.width,
          length: pose.length ?? VEHICLE.length,
        };
  const drivingRoads = world.drivingRoads ?? world.roads;
  if (
    Array.isArray(drivingRoads) &&
    drivingRoads.length > 0 &&
    (poseInSingleRoadFast(body, drivingRoads, 0.25) || bodyOnRoad(body, drivingRoads, 0.25))
  ) {
    return true;
  }
  const curb = world.pursuit?.gta?.curb;
  const allRoads = world.roads ?? world.drivingRoads;
  return Boolean(curb && isPoseSupportedWithCurbs(curb, allRoads, body));
}

export function canDrivePrivilegedDirect(world, car, aim, options = {}) {
  if (!world || !car || !aim || car.gtaRoadblock || car.aiState === "WRECKED") return false;
  const opts = typeof options === "boolean" ? { avoidTraffic: options } : (options ?? {});
  const heading = headingTo(car, aim);
  if (Math.abs(angleDelta(heading, car.heading ?? 0)) > (opts.maxAngle ?? 1.26)) return false;

  const range = distance(car, aim);
  if (!Number.isFinite(range) || range < 0.45) return false;

  const horizon = Math.min(range, opts.maxHorizon ?? 26);
  const steps = Math.max(5, Math.ceil(horizon / 3.2));
  const dx = Math.sin(heading) * horizon;
  const dz = Math.cos(heading) * horizon;

  const rawNearbyStatics = queryNearbyStatics(world, car, horizon + 8);
  const nearbyStatics = rawNearbyStatics.filter(
    (st) =>
      st &&
      Math.hypot(st.x - car.x, st.z - car.z) - Math.hypot(st.width ?? 0, st.length ?? 0) * 0.5 <=
        horizon + 6,
  );
  const nearbyActors = queryNearbyActors(world, car, horizon + 8);
  const avoidTraffic = opts.avoidTraffic !== false;
  const width = car.width ?? 1.9;
  const length = car.length ?? 4.5;

  const probe = { x: 0, z: 0, heading, width, length };
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    probe.x = car.x + dx * t;
    probe.z = car.z + dz * t;

    if (!isTacticalPatrolPoseSupported(world, probe)) return false;

    for (let s = 0; s < nearbyStatics.length; s++) {
      if (overlaps(probe, normalizeRect(nearbyStatics[s]), 0.22)) return false;
    }

    for (let a = 0; a < nearbyActors.length; a++) {
      const other = nearbyActors[a];
      if (!other || other === car) continue;
      if (isPedestrian(other)) {
        if (gapBetween(probe, other) < 1.25) return false;
      } else if (avoidTraffic && other !== world.player && !other.wrecked) {
        if (overlaps(probe, normalizeRect(other), 0.16)) return false;
      }
    }
  }
  return true;
}

export function resolveTacticalRoadAim(world, car, aim, velocity = null) {
  if (!aim) return { x: 0, z: 0, snapped: false, roadId: null };
  const rawRoads = world?.drivingRoads ?? world?.roads ?? [];
  const { roads, standardRoads } = getCachedTacticalRoadLists(rawRoads);
  if (roads.length === 0) {
    return { x: aim.x, z: aim.z, snapped: false, roadId: null };
  }

  const carWidth = car?.width ?? 1.9;
  const carLength = car?.length ?? 4.5;
  const statics = world?.statics ?? [];

  const probe = {
    x: aim.x,
    z: aim.z,
    heading: aim.heading ?? 0,
    width: carWidth,
    length: carLength,
  };
  const nearAimStatics = queryNearbyStatics(world, aim, 12);
  if (
    standardRoads.length > 0 &&
    pointOnRoad(probe, standardRoads, 0.25) &&
    !nearAimStatics.some((st) => overlaps(probe, normalizeRect(st), 0.18))
  ) {
    return { x: aim.x, z: aim.z, snapped: false, roadId: null };
  }

  let vx = velocity?.vx ?? aim.vx;
  let vz = velocity?.vz ?? aim.vz;
  if (!Number.isFinite(vx) || !Number.isFinite(vz)) {
    if (Number.isFinite(aim.speed) && Number.isFinite(aim.heading)) {
      vx = Math.sin(aim.heading) * aim.speed;
      vz = Math.cos(aim.heading) * aim.speed;
    } else {
      vx = Number.isFinite(vx) ? vx : 0;
      vz = Number.isFinite(vz) ? vz : 0;
    }
  }
  const speed = Math.hypot(vx, vz);
  const ux = speed > 1.0 ? vx / speed : 0;
  const uz = speed > 1.0 ? vz / speed : 0;

  const samplePoints = [{ x: aim.x, z: aim.z }];
  if (speed > 1.0) {
    for (let i = 0; i < LOOKAHEAD_DISTANCES.length; i++) {
      const d = LOOKAHEAD_DISTANCES[i];
      samplePoints.push({ x: aim.x + ux * d, z: aim.z + uz * d });
    }
  }

  const hasCarPose = Boolean(car && Number.isFinite(car.x) && Number.isFinite(car.z));
  let best = null;
  let bestScore = Infinity;

  const isStaticClear = (candBox) => {
    const localStatics = world?.staticIndex ? queryNearbyStatics(world, candBox, 10) : statics;
    for (let i = 0; i < localStatics.length; i++) {
      if (overlaps(candBox, normalizeRect(localStatics[i]), 0.22)) return false;
    }
    return true;
  };

  for (let rIdx = 0; rIdx < roads.length; rIdx++) {
    const road = roads[rIdx];
    const sides = road.flow ? [road.flow] : [1, -1];

    for (let sIdx = 0; sIdx < samplePoints.length; sIdx++) {
      const sample = samplePoints[sIdx];
      for (let sideIdx = 0; sideIdx < sides.length; sideIdx++) {
        const side = sides[sideIdx];
        let cand = snapPoseOnRoad(road, sample, side, carWidth, carLength);
        if (bestScore < Infinity) {
          const rawDistAim = Math.hypot(aim.x - cand.centerX, aim.z - cand.centerZ);
          const rawDistCar = hasCarPose ? Math.hypot(car.x - cand.centerX, car.z - cand.centerZ) : 0;
          const minPossibleScore =
            Math.max(0, rawDistAim - 8.0) -
            (speed > 1.0 ? 14.35 : 0.35) +
            0.18 * Math.max(0, rawDistCar - 8.0);
          if (minPossibleScore >= bestScore) continue;
        }
        let candBox = {
          x: cand.x,
          z: cand.z,
          heading: cand.heading,
          width: carWidth,
          length: carLength,
        };
        if (!isStaticClear(candBox)) {
          const frame = roadAxisVectors(road);
          let cleared = null;
          for (const shiftAlong of [-8, 8]) {
            const shifted = snapPoseOnRoad(
              road,
              { x: sample.x + frame.ux * shiftAlong, z: sample.z + frame.uz * shiftAlong },
              side,
              carWidth,
              carLength,
            );
            const shiftedBox = {
              x: shifted.x,
              z: shifted.z,
              heading: shifted.heading,
              width: carWidth,
              length: carLength,
            };
            if (isStaticClear(shiftedBox)) {
              cleared = shifted;
              candBox = shiftedBox;
              break;
            }
          }
          if (!cleared) continue;
          cand = cleared;
        }

        const centerRef = { x: cand.centerX, z: cand.centerZ };
        const distAim = distance(aim, centerRef);
        const alignment =
          speed > 1.0 && distAim > 1e-6
            ? ((centerRef.x - aim.x) * ux + (centerRef.z - aim.z) * uz) / distAim
            : 0;
        const distCar = hasCarPose ? distance(car, centerRef) : 0;

        const laneHx = Math.sin(cand.heading);
        const laneHz = Math.cos(cand.heading);
        const alongVel = speed > 1.0 ? laneHx * ux + laneHz * uz : 0;
        let headingAlign = alongVel;
        if (Math.abs(alongVel) <= 0.35 && hasCarPose) {
          const apX = centerRef.x - car.x;
          const apZ = centerRef.z - car.z;
          const apLen = Math.hypot(apX, apZ);
          headingAlign = apLen > 1e-6 ? (laneHx * apX + laneHz * apZ) / apLen : 0;
        }

        const score = distAim - 14 * alignment + 0.18 * distCar - 0.35 * headingAlign;
        if (score < bestScore) {
          bestScore = score;
          best = {
            x: cand.x,
            z: cand.z,
            heading: cand.heading,
            roadId: road.id ?? null,
            snapped: true,
          };
        }
      }
    }
  }

  return best ?? { x: aim.x, z: aim.z, snapped: false, roadId: null };
}

const overtakeDecisionCache = new WeakMap();

export function tacticalTrafficOvertake(world, car, baseSteer, desiredSpeed) {
  if (!world || !car || !Number.isFinite(desiredSpeed) || desiredSpeed <= 0) return null;

  const maxSteer = car.spec?.maxSteer ?? VEHICLE.maxSteer;
  const base = clamp(Number.isFinite(baseSteer) ? baseSteer : 0, -maxSteer, maxSteer);

  if (Number.isSafeInteger(world.tick)) {
    const cached = overtakeDecisionCache.get(car);
    if (
      cached &&
      world.tick > cached.tick &&
      world.tick - cached.tick <= 3 &&
      cached.actorsLen === (world.actors?.length ?? 0) &&
      Math.abs(cached.base - base) <= 0.08
    ) {
      return cached.result;
    }
  }

  const saveOvertake = (result) => {
    if (Number.isSafeInteger(world.tick)) {
      overtakeDecisionCache.set(car, {
        tick: world.tick,
        actorsLen: world.actors?.length ?? 0,
        base,
        result,
      });
    }
    return result;
  };

  const dt = 0.14;
  const substeps = 8;
  const curSpeed = Number.isFinite(car.speed) ? car.speed : desiredSpeed;
  const checkSpeed = Math.max(desiredSpeed, curSpeed, 10);
  const forwardRange = Math.max(30, checkSpeed * 1.15);
  const width = car.width ?? 1.9;
  const length = car.length ?? 4.5;
  const heading0 = car.heading ?? 0;
  const sin0 = Math.sin(heading0);
  const cos0 = Math.cos(heading0);

  const searchRadius = forwardRange + 12;
  const nearbyActors = queryNearbyActors(world, car, searchRadius);

  const pedestrians = [];
  const vehicles = [];
  const forwardBlockers = [];

  for (let i = 0; i < nearbyActors.length; i++) {
    const actor = nearbyActors[i];
    if (!actor || actor === car) continue;
    if (isPedestrian(actor)) {
      pedestrians.push(actor);
      continue;
    }
    if (actor === world.player || actor.wrecked) continue;
    vehicles.push(actor);
    const dx = actor.x - car.x;
    const dz = actor.z - car.z;
    const fwd = dx * sin0 + dz * cos0;
    const lat = Math.abs(dx * cos0 - dz * sin0);
    if (fwd > -1.0 && fwd <= forwardRange + 4 && lat <= 11) {
      forwardBlockers.push(actor);
    }
  }

  const staticMeta = getStaticMeta(world.statics);
  if (staticMeta.hasParkedVehicles || !Array.isArray(world.statics)) {
    const parkedCandidates = world.staticIndex
      ? world.staticIndex.near(car, forwardRange + 8)
      : (world.statics ?? []);
    for (let i = 0; i < parkedCandidates.length; i++) {
      const st = parkedCandidates[i];
      if (st?.kind !== "parked-vehicle") continue;
      const dx = st.x - car.x;
      const dz = st.z - car.z;
      const fwd = dx * sin0 + dz * cos0;
      const lat = Math.abs(dx * cos0 - dz * sin0);
      if (fwd > -1.0 && fwd <= forwardRange + 4 && lat <= 11) {
        forwardBlockers.push(st);
      }
    }
  }

  const nearbyStatics = queryNearbyStatics(world, car, searchRadius);
  const candidateStatics = [];
  const cornerHazardStatics = [];
  for (let i = 0; i < nearbyStatics.length; i++) {
    const st = nearbyStatics[i];
    if (!st) continue;
    const stRadius = Math.hypot(st.width ?? 0, st.length ?? 0) * 0.5;
    const centerGap = Math.hypot(st.x - car.x, st.z - car.z) - stRadius;
    if (centerGap <= forwardRange + 8) {
      candidateStatics.push(st);
      if (st.kind !== "parked-vehicle" && centerGap <= 28) {
        const fwd = (st.x - car.x) * sin0 + (st.z - car.z) * cos0;
        if (fwd + stRadius > -1.0) cornerHazardStatics.push(st);
      }
    }
  }

  if (forwardBlockers.length === 0 && cornerHazardStatics.length === 0) return saveOvertake(null);

  const startBox = { x: car.x, z: car.z, heading: heading0, width, length };
  for (let p = 0; p < pedestrians.length; p++) {
    const ped = pedestrians[p];
    const fwd = (ped.x - car.x) * sin0 + (ped.z - car.z) * cos0;
    if (fwd > -1.0 && gapBetween(startBox, ped) < 1.45) return null;
  }

  // Simulate forward path along baseSteer with 1:1 integrateVehicle physics across 30m+ lookahead.
  const baseCheckSteps = Math.max(
    substeps,
    Math.min(11, Math.ceil(forwardRange / (Math.max(curSpeed, 11) * dt))),
  );
  const baseProbe = makeSimProbe(car, Math.max(curSpeed, 10), checkSpeed);
  const baseCmd = { steer: base, targetSpeed: checkSpeed };
  let blockerFound = false;

  for (let step = 1; step <= baseCheckSteps; step++) {
    integrateVehicle(baseProbe, baseCmd, dt, baseProbe);
    const elapsed = step * dt;

    for (let p = 0; p < pedestrians.length; p++) {
      const ped = pedestrians[p];
      if (gapBetween(baseProbe, ped) < 1.45 || gapBetween(baseProbe, advanceActorPose(ped, elapsed)) < 1.45) {
        return null;
      }
    }

    if (!blockerFound) {
      for (let b = 0; b < forwardBlockers.length; b++) {
        const obs = forwardBlockers[b];
        const stalled = obs.type === "static" || Math.abs(obs.speed ?? 0) < 1.5 || (obs.wait ?? 0) > 0.3;
        const triggerGap = stalled ? 0.92 : 0.62;
        const movedObs = obs.type === "static" ? obs : advanceActorPose(obs, elapsed);
        if (gapBetween(baseProbe, obs) <= triggerGap || gapBetween(baseProbe, movedObs) <= triggerGap) {
          blockerFound = true;
          break;
        }
      }
    }

    if (!blockerFound && step <= 7) {
      for (let c = 0; c < cornerHazardStatics.length; c++) {
        if (overlaps(baseProbe, normalizeRect(cornerHazardStatics[c]), 0.32)) {
          blockerFound = true;
          break;
        }
      }
    }
  }

  if (!blockerFound) return saveOvertake(null);

  const candidateSteers = [];
  const pushSteer = (val) => {
    const clamped = clamp(val, -maxSteer, maxSteer);
    if (Math.abs(clamped - base) < 0.03) return;
    if (!candidateSteers.some((existing) => Math.abs(existing - clamped) < 1e-4)) {
      candidateSteers.push(clamped);
    }
  };
  for (let i = 0; i < OVERTAKE_STEER_OFFSETS.length; i++) {
    pushSteer(base + OVERTAKE_STEER_OFFSETS[i]);
  }
  pushSteer(0);
  candidateSteers.sort((a, b) => Math.abs(a - base) - Math.abs(b - base));

  const rawSpeeds = [
    desiredSpeed,
    Math.max(14, desiredSpeed * 0.78),
    Math.max(10, desiredSpeed * 0.58),
  ];
  const candidateSpeeds = [];
  for (let i = 0; i < rawSpeeds.length; i++) {
    const sp = rawSpeeds[i];
    if (!candidateSpeeds.some((existing) => Math.abs(existing - sp) < 1e-3)) {
      candidateSpeeds.push(sp);
    }
  }

  const localDrivingRoads = filterNearbyRoads(world.drivingRoads ?? world.roads ?? [], car, forwardRange + 16);
  const localAllRoads =
    world.roads && world.roads !== world.drivingRoads
      ? filterNearbyRoads(world.roads, car, forwardRange + 16)
      : localDrivingRoads;
  const rawCurb = world.pursuit?.gta?.curb;
  const curbPad = forwardRange + 16;
  const curb =
    rawCurb?.sites && rawCurb.sites.length > 8
      ? {
          ...rawCurb,
          sites: rawCurb.sites.filter(
            (s) =>
              s.maxX >= car.x - curbPad &&
              s.minX <= car.x + curbPad &&
              s.maxZ >= car.z - curbPad &&
              s.minZ <= car.z + curbPad,
          ),
        }
      : rawCurb;
  let best = null;

  for (let vIdx = 0; vIdx < candidateSpeeds.length; vIdx++) {
    const candSpeed = candidateSpeeds[vIdx];
    if (best && best.allOnRoad && best.targetSpeed > candSpeed + 1e-6) break;

    for (let sIdx = 0; sIdx < candidateSteers.length; sIdx++) {
      const candSteer = candidateSteers[sIdx];
      const delta = Math.abs(candSteer - base);
      if (best && best.allOnRoad && Math.abs(best.targetSpeed - candSpeed) <= 1e-6 && delta >= best.delta - 1e-6) {
        break;
      }

      const probe = makeSimProbe(car, curSpeed, Math.max(desiredSpeed, candSpeed));
      const cmd = { steer: candSteer, targetSpeed: candSpeed };

      let clear = true;
      let allOnRoad = localDrivingRoads.length > 0;

      for (let step = 1; step <= substeps; step++) {
        cmd.steer =
          step <= 4
            ? candSteer
            : clamp(base - angleDelta(probe.heading, heading0) * 0.85, -maxSteer, maxSteer);
        integrateVehicle(probe, cmd, dt, probe);
        const elapsed = step * dt;

        const stepOnRoad =
          localDrivingRoads.length > 0 &&
          (poseInSingleRoadFast(probe, localDrivingRoads, 0.25) || bodyOnRoad(probe, localDrivingRoads, 0.25));
        if (!stepOnRoad) {
          allOnRoad = false;
          if (!(curb && isPoseSupportedWithCurbs(curb, localAllRoads, probe))) {
            clear = false;
            break;
          }
        }

        for (let i = 0; i < candidateStatics.length; i++) {
          const st = candidateStatics[i];
          if (st.kind === "parked-vehicle") {
            if (gapBetween(probe, st) < 0.42 || overlaps(probe, normalizeRect(st), 0.24)) {
              clear = false;
              break;
            }
          } else if (overlaps(probe, normalizeRect(st), 0.24)) {
            clear = false;
            break;
          }
        }
        if (!clear) break;

        for (let p = 0; p < pedestrians.length; p++) {
          const ped = pedestrians[p];
          if (
            gapBetween(probe, ped) < 1.45 ||
            gapBetween(probe, advanceActorPose(ped, elapsed)) < 1.45
          ) {
            clear = false;
            break;
          }
        }
        if (!clear) break;

        for (let v = 0; v < vehicles.length; v++) {
          const veh = vehicles[v];
          if (
            gapBetween(probe, veh) < 0.42 ||
            gapBetween(probe, advanceActorPose(veh, elapsed)) < 0.42
          ) {
            clear = false;
            break;
          }
        }
        if (!clear) break;
      }

      if (!clear) continue;

      const isBetter =
        !best ||
        (allOnRoad && !best.allOnRoad) ||
        (allOnRoad === best.allOnRoad &&
          (candSpeed > best.targetSpeed + 1e-6 ||
            (Math.abs(candSpeed - best.targetSpeed) <= 1e-6 && delta < best.delta - 1e-6)));

      if (isBetter) {
        best = { steer: candSteer, targetSpeed: candSpeed, delta, allOnRoad };
        if (allOnRoad && vIdx === 0) break;
      }
    }
  }

  return saveOvertake(
    best
      ? { steer: best.steer, targetSpeed: best.targetSpeed, reason: "tactical-overtake" }
      : null,
  );
}

export function selectTacticalSearchTarget(world, car, lastSeen, unitIndex = 0) {
  const safeSeen = lastSeen ?? { x: 0, z: 0, vx: 0, vz: 0, speed: 14, heading: 0, lastSeenTick: 0 };
  const seenTick = safeSeen.lastSeenTick ?? safeSeen.tick ?? 0;
  const elapsedS = clamp(((world?.tick ?? 0) - seenTick) / 60, 0, 10);

  const vx = safeSeen.vx ?? 0;
  const vz = safeSeen.vz ?? 0;
  const baseHeading = Math.hypot(vx, vz) > 1.0 ? Math.atan2(vx, vz) : (safeSeen.heading ?? 0);

  const fanIdx = ((Math.trunc(unitIndex || 0) % SEARCH_FAN_ANGLES.length) + SEARCH_FAN_ANGLES.length) % SEARCH_FAN_ANGLES.length;
  const fanOffset = SEARCH_FAN_ANGLES[fanIdx];
  const searchHeading = baseHeading + fanOffset;

  const radius = clamp(
    20 + Math.max(safeSeen.speed ?? 14, 12) * Math.min(elapsedS, 5.5) * 0.65,
    22,
    145,
  );

  const projectedPoint = {
    x: safeSeen.x + Math.sin(searchHeading) * radius,
    z: safeSeen.z + Math.cos(searchHeading) * radius,
    heading: searchHeading,
  };

  const resolved = resolveTacticalRoadAim(world, car, projectedPoint, {
    vx: Math.sin(searchHeading) * 10,
    vz: Math.cos(searchHeading) * 10,
  });

  let roadId = resolved.roadId ?? null;
  if (roadId === null) {
    const roads = (world?.drivingRoads ?? world?.roads ?? []).filter(
      (r) => r && !r.parkingBay && !r.supportApron && (r.axis != null || isDiagonalRoad(r)),
    );
    const hit = roads.find((r) => pointOnRoad(resolved, [r], 0.25));
    if (hit) roadId = hit.id ?? null;
  }

  return {
    x: resolved.x,
    z: resolved.z,
    heading: resolved.heading ?? searchHeading,
    roadId,
    radius,
    fanAngle: fanOffset,
  };
}
