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
  roadPoseAt,
  roadProject,
} from "./geometry.js";
import { isPoseSupportedWithCurbs } from "./pako-curb.js";
import { integrateVehicle, vehicleProbe } from "./vehicle.js";

export const TACTICAL_PURSUIT_MODE = "gta-tactical-v1";

const SQUAD_BY_STAR = Object.freeze([0, 4, 6, 8, 11, 14]);
const SEARCH_FAN_ANGLES = Object.freeze([0, 0.58, -0.58, 1.15, -1.15, 1.75, -1.75, Math.PI]);
const OVERTAKE_STEER_OFFSETS = Object.freeze([0.09, -0.09, 0.15, -0.15, 0.22, -0.22, 0.38, -0.38, 0.55, -0.55]);
const LOOKAHEAD_DISTANCES = Object.freeze([8, 18, 30]);

const staticReachCache = new WeakMap();

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

export function tacticalPatrolSpec(unitType, wantedLevel = 3, npcSpeedMultiplier = 1) {
  const level = clamp(Math.round(wantedLevel || 1), 1, 5);
  const mult = Number.isFinite(npcSpeedMultiplier) && npcSpeedMultiplier > 0 ? npcSpeedMultiplier : 1;

  if (unitType === "interceptor") {
    return {
      maxSpeed: (35.5 + 0.5 * level) * mult,
      acceleration: 8.8,
      braking: 11.4,
      steerRate: 2.75,
      wheelbase: VEHICLE.wheelbase,
      reverseSpeed: 7.5,
    };
  }
  if (unitType === "swat") {
    return {
      maxSpeed: (28.8 + 0.4 * level) * mult,
      acceleration: 6.4,
      braking: 10.0,
      steerRate: 1.95,
      wheelbase: 3.15,
      reverseSpeed: 6.2,
    };
  }
  return {
    maxSpeed: (33.1 + 0.45 * level) * mult,
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
  const drivableRoads = rawRoads.filter((r) => r && !r.parkingBay && !r.supportApron);
  const roads = drivableRoads.length > 0 ? drivableRoads : rawRoads;
  if (roads.length === 0) {
    return { x: aim.x, z: aim.z, snapped: false, roadId: null };
  }

  const carWidth = car?.width ?? 1.9;
  const carLength = car?.length ?? 4.5;
  const standardRoads = roads.filter((r) => r.axis != null || isDiagonalRoad(r));
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

export function tacticalTrafficOvertake(world, car, baseSteer, desiredSpeed) {
  if (!world || !car || !Number.isFinite(desiredSpeed) || desiredSpeed <= 0) return null;

  const dt = 0.14;
  const substeps = 8;
  const maxSteer = car.spec?.maxSteer ?? VEHICLE.maxSteer;
  const base = clamp(Number.isFinite(baseSteer) ? baseSteer : 0, -maxSteer, maxSteer);
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

  if (forwardBlockers.length === 0) return null;

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
        const movedObs = obs.type === "static" ? obs : advanceActorPose(obs, elapsed);
        if (gapBetween(baseProbe, obs) <= 0.62 || gapBetween(baseProbe, movedObs) <= 0.62) {
          blockerFound = true;
          break;
        }
      }
    }
  }

  if (!blockerFound) return null;

  const nearbyStatics = queryNearbyStatics(world, car, searchRadius);
  const candidateStatics = [];
  for (let i = 0; i < nearbyStatics.length; i++) {
    const st = nearbyStatics[i];
    if (!st) continue;
    const stRadius = Math.hypot(st.width ?? 0, st.length ?? 0) * 0.5;
    if (Math.hypot(st.x - car.x, st.z - car.z) - stRadius <= forwardRange + 8) {
      candidateStatics.push(st);
    }
  }

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

  return best
    ? { steer: best.steer, targetSpeed: best.targetSpeed, reason: "tactical-overtake" }
    : null;
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
