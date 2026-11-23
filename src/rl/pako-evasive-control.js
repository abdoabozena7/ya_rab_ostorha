import { STEP, VEHICLE, clamp } from "../core/config.js";
import { angleDelta, bodyOnRoad, corners, distance, overlaps, pointOnRoad, roadRect } from "../core/geometry.js";
import { PURSUIT_STOP, validatePursuitAction } from "../core/pursuit-controls.js";
import { nearestPathPoint, vehicleProbe } from "../core/vehicle.js";
import { PLAYER_VEHICLE } from "../core/vehicle-spec.js";
import {
  PURSUIT_SCAN_RAYS,
  PURSUIT_SCAN_RANGE_M,
  PURSUIT_SCAN_TICKS,
  forecastPursuitSurface,
} from "../signal_processing/pursuit-scanner.js";
import { CLEARANCE_ROUTE_CONTEXT, dispatchRouteGuide } from "./pursuit-route-context.js";
import { guardDispatchAction, requireDispatchScan } from "./pursuit-shield.js";

export const PAKO_EVASIVE_CONTROL = "pako-evasive-v2";

const ANGLE_STEP = (2 * Math.PI) / PURSUIT_SCAN_RAYS;
const CONE_RAD = (18 * Math.PI) / 180;
const CENTER_CONE_RAD = (6.5 * Math.PI) / 180;
const ACTION_TICKS_FORWARD = 12;
const ACTION_TICKS_REVERSE = 10;
const ACTION_TICKS_REVERSE_SHORT = 6;
const MAX_STOP_TICKS = 110;
const RAY_MARGIN_M = 0.12;
const PED_RAY_RANGE_M = 18;
const PED_RAY_CORNER_MARGIN_M = 0.95;
const PED_TRACK_ACTION_MARGIN_M = 1.15;
const PED_TRACK_STOP_MARGIN_M = 0.90;
const VEH_TRACK_ACTION_MARGIN_M = 0.32;
const VEH_TRACK_STOP_MARGIN_M = 0.20;
const VISUAL_PERSON_MARGIN_M = 1.10;
const STATIC_ASPHALT_GAP_M = 0.14;
const STATIC_CURB_GAP_M = 0.16;

const FORWARD_STEERS = Object.freeze([-1.0, -0.95, -0.72, -0.48, -0.25, 0, 0.25, 0.48, 0.72, 0.95, 1.0]);
const CONTROLLED_FAST_STEERS = Object.freeze([-1.0, -0.72, -0.25, 0, 0.25, 0.72, 1.0]);
const AUX_STEERS = Object.freeze([-1.0, -0.62, -0.22, 0, 0.22, 0.62, 1.0]);
const REVERSE_STEERS = Object.freeze([-1.0, -0.75, -0.4, 0, 0.4, 0.75, 1.0]);

const SUPPORT_ROAD = Object.freeze({ supported: true, usesCurb: false });
const SUPPORT_CURB = Object.freeze({ supported: true, usesCurb: true });
const SUPPORT_NONE = Object.freeze({ supported: false, usesCurb: false });
const _localCornerX = new Float64Array(4);
const _localCornerZ = new Float64Array(4);
const _sweepProbe = { x: 0, z: 0, heading: 0, type: "vehicle", radius: 0, length: 0, width: 0 };
const _rayResult = { ok: true, reason: null, clearance: 0 };
const _sweepResult = { ok: true, reason: null, usesCurb: false, endUsesCurb: false };
const _localBox = { x: 0, z: 0, heading: 0, width: 0, length: 0 };
const _corridorSupportProbe = { x: 0, z: 0, heading: 0, width: 0, length: 0, type: "vehicle" };
const _corridorStaticProbe = { x: 0, z: 0, heading: 0, width: 0, length: 0, type: "vehicle" };
const CORRIDOR_PROBE_DISTS = Object.freeze([2.8, 5.2, 8.0, 11.5, 15.5, 20.0, 25.0, 30.0, 35.0]);
const BLOCKED_ZONE_TTL_TICKS = 240;
const BLOCKED_ZONE_RADIUS_M = 9.0;
const BLOCKED_ZONE_ANGLE_RAD = (42 * Math.PI) / 180;
const VISITED_CELL_SIZE_M = 28;
const VISITED_CELL_LIMIT = 36;
const REVISIT_MIN_AGE_TICKS = Math.round(4.5 / STEP);
const STRAIGHT_DEADBAND_STEER_RAD = 0.035;
const STRAIGHT_ALIGN_RAD = (3 * Math.PI) / 180;
const routeArcCache = new WeakMap();
const GTA_SLIP_DECAY = Math.exp(-3.8 * STEP);
const GTA_YAW_DECAY = Math.exp(-3 * STEP);
let _scratchSurfaceA = new Float64Array(256);
let _scratchSurfaceB = new Float64Array(256);
let _scratchTrackA = new Float64Array(64);
let _scratchTrackB = new Float64Array(64);

function stepPursuitPoseInto(pose, out, action, dt, spec, maxSpeedCmd, maxSpeedPlant, curbCap) {
  const cmdSteer = action.steer * spec.maxSteer;
  const reverseLimit = spec.reverseSpeed ?? VEHICLE.reverseSpeed;
  let cmdTargetSpeed = 0;
  let braking = spec.braking;
  const speed0 = pose.speed;
  if (action.brake > 0) {
    braking = spec.braking * action.brake;
  } else {
    const limit = action.gear > 0 ? maxSpeedCmd : reverseLimit;
    const accelCmd = spec.acceleration * action.throttle;
    cmdTargetSpeed =
      action.throttle === 0
        ? Math.sign(speed0) * Math.max(0, Math.abs(speed0) - 0.18 * dt)
        : action.gear * clamp(speed0 * action.gear + accelCmd * dt, accelCmd * dt, limit);
    if (curbCap > 0) cmdTargetSpeed = clamp(cmdTargetSpeed, -curbCap, curbCap);
  }
  const steer =
    pose.steer +
    clamp(
      clamp(cmdSteer, -spec.maxSteer, spec.maxSteer) - pose.steer,
      -spec.steerRate * dt,
      spec.steerRate * dt,
    );
  const requested = clamp(cmdTargetSpeed, -reverseLimit, maxSpeedPlant);
  const reversing = speed0 * requested < 0;
  const target = reversing ? 0 : requested;
  const slowing = Math.abs(target) < Math.abs(speed0) || reversing;
  const maxDv = (slowing ? braking : spec.acceleration) * dt;
  const speed = speed0 + clamp(target - speed0, -maxDv, maxDv);
  const average = (speed + speed0) * 0.5;
  const tangent = Math.tan(steer);
  const beta = Math.atan(0.5 * tangent);
  const yawRate = (average / spec.wheelbase) * Math.cos(beta) * tangent;
  const middle = pose.heading + yawRate * dt * 0.5 + beta;
  let nx = pose.x + Math.sin(middle) * average * dt;
  let nz = pose.z + Math.cos(middle) * average * dt;
  let nh = pose.heading + yawRate * dt;
  const slip = pose.gtaSlipMps * GTA_SLIP_DECAY;
  const yaw = pose.gtaYawRate * GTA_YAW_DECAY;
  nx += Math.cos(nh) * slip * STEP;
  nz -= Math.sin(nh) * slip * STEP;
  nh += yaw * STEP;
  out.x = nx;
  out.z = nz;
  out.heading = nh;
  out.steer = steer;
  out.speed = speed;
  out.gtaSlipMps = slip;
  out.gtaYawRate = yaw;
  return out;
}

const BEAMS = Object.freeze(
  Array.from({ length: PURSUIT_SCAN_RAYS }, (_, i) =>
    Object.freeze([Math.sin(i * ANGLE_STEP), Math.cos(i * ANGLE_STEP)]),
  ),
);

const escapeStates = new WeakMap();

function makeAction(steer, throttle, brake, gear) {
  return validatePursuitAction({
    steer: steer === 0 ? 0 : clamp(steer, -1, 1),
    throttle: throttle === 0 ? 0 : clamp(throttle, 0, 1),
    brake: brake === 0 ? 0 : clamp(brake, 0, 1),
    gear: gear < 0 ? -1 : 1,
  });
}

function pointOnCurbSiteXY(px, pz, s) {
  if (px < s.minX || px > s.maxX || pz < s.minZ || pz > s.maxZ) return false;
  if (s.axis === "diag") {
    const dx = px - s.x1;
    const dz = pz - s.z1;
    const along = dx * s.ux + dz * s.uz;
    if (along < s.alongMin || along > s.alongMax) return false;
    const leftOffset = -dx * s.uz + dz * s.ux;
    return leftOffset >= s.crossLo && leftOffset <= s.crossHi;
  }
  return true;
}

function pointOnCurbXY(px, pz, curb) {
  if (!curb) return false;
  if (Array.isArray(curb.courtyards)) {
    for (let i = 0; i < curb.courtyards.length; i++) {
      const c = curb.courtyards[i];
      if (px >= c.minX && px <= c.maxX && pz >= c.minZ && pz <= c.maxZ) return true;
    }
  }
  if (Array.isArray(curb.sites)) {
    for (let i = 0; i < curb.sites.length; i++) {
      if (pointOnCurbSiteXY(px, pz, curb.sites[i])) return true;
    }
    return false;
  }
  if (Array.isArray(curb.courtyards)) return false;
  return pointOnCurbSiteXY(px, pz, curb);
}

function pointOnCurb(p, curb) {
  return pointOnCurbXY(p.x, p.z, curb);
}

function pointInRects(px, pz, rects, pad = 0) {
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i];
    if (px >= r.minX - pad && px <= r.maxX + pad && pz >= r.minZ - pad && pz <= r.maxZ + pad) return true;
  }
  return false;
}

function pointOnDiagRoads(px, pz, diagRoads, useMargin = false, pad = 0) {
  if (!diagRoads?.length) return false;
  for (let i = 0; i < diagRoads.length; i++) {
    const d = diagRoads[i];
    if (d.minX !== undefined && (px < d.minX - pad || px > d.maxX + pad || pz < d.minZ - pad || pz > d.maxZ + pad)) {
      continue;
    }
    const baseH = useMargin
      ? (d.halfWMargin ?? Math.max(0, d.width * 0.5 - 0.08))
      : (d.halfW0 ?? d.width * 0.5);
    const h = baseH + pad;
    if (h <= 0) continue;
    const dx = px - d.x1;
    const dz = pz - d.z1;
    const along = dx * d.ux + dz * d.uz;
    if (along < -h || along > d.length + h) continue;
    if (Math.abs(-dx * d.uz + dz * d.ux) <= h) return true;
  }
  return false;
}

function pointOnRoadRects(px, pz, rects, diagRoads = rects?.diagRoads, useMargin = false, pad = 0) {
  if (rects?.length && pointInRects(px, pz, rects, pad)) return true;
  return pointOnDiagRoads(px, pz, diagRoads, useMargin, pad);
}

function poseInSingleRoadRectCoords(x0, z0, x1, z1, x2, z2, x3, z3, roadRects) {
  for (let i = 0; i < roadRects.length; i++) {
    const r = roadRects[i];
    if (r.axis === "diag") continue;
    if (
      x0 >= r.minX && x0 <= r.maxX && z0 >= r.minZ && z0 <= r.maxZ &&
      x1 >= r.minX && x1 <= r.maxX && z1 >= r.minZ && z1 <= r.maxZ &&
      x2 >= r.minX && x2 <= r.maxX && z2 >= r.minZ && z2 <= r.maxZ &&
      x3 >= r.minX && x3 <= r.maxX && z3 >= r.minZ && z3 <= r.maxZ
    ) {
      return true;
    }
  }
  return false;
}

function poseInSingleDiagRoadCoords(x0, z0, x1, z1, x2, z2, x3, z3, diagRoads) {
  if (!diagRoads?.length) return false;
  for (let i = 0; i < diagRoads.length; i++) {
    const d = diagRoads[i];
    if (d.axis !== undefined && d.axis !== "diag") continue;
    const h = d.halfWMargin ?? Math.max(0, d.width * 0.5 - 0.08);
    if (h <= 0) continue;
    if (d.minX !== undefined && (x0 < d.minX || x0 > d.maxX || z0 < d.minZ || z0 > d.maxZ)) continue;
    const maxAlong = d.length + h;
    const dx0 = x0 - d.x1, dz0 = z0 - d.z1, a0 = dx0 * d.ux + dz0 * d.uz;
    if (a0 < -h || a0 > maxAlong || Math.abs(-dx0 * d.uz + dz0 * d.ux) > h) continue;
    const dx1 = x1 - d.x1, dz1 = z1 - d.z1, a1 = dx1 * d.ux + dz1 * d.uz;
    if (a1 < -h || a1 > maxAlong || Math.abs(-dx1 * d.uz + dz1 * d.ux) > h) continue;
    const dx2 = x2 - d.x1, dz2 = z2 - d.z1, a2 = dx2 * d.ux + dz2 * d.uz;
    if (a2 < -h || a2 > maxAlong || Math.abs(-dx2 * d.uz + dz2 * d.ux) > h) continue;
    const dx3 = x3 - d.x1, dz3 = z3 - d.z1, a3 = dx3 * d.ux + dz3 * d.uz;
    if (a3 < -h || a3 > maxAlong || Math.abs(-dx3 * d.uz + dz3 * d.ux) > h) continue;
    return true;
  }
  return false;
}

export function poseInSingleRoadRect(pose, roadRects, diagRoads = roadRects?.diagRoads) {
  if (!roadRects?.length && !diagRoads?.length) return false;
  const h = pose.heading ?? 0;
  const s = Math.sin(h);
  const c = Math.cos(h);
  const l = (pose.length ?? 0) * 0.5;
  const w = (pose.width ?? 0) * 0.5;
  const px = pose.x;
  const pz = pose.z;
  const cw = c * w;
  const sw = s * w;
  const sl = s * l;
  const cl = c * l;
  const x0 = px - cw - sl, z0 = pz + sw - cl;
  const x1 = px + cw - sl, z1 = pz - sw - cl;
  const x2 = px + cw + sl, z2 = pz - sw + cl;
  const x3 = px - cw + sl, z3 = pz + sw + cl;
  if (roadRects?.length && poseInSingleRoadRectCoords(x0, z0, x1, z1, x2, z2, x3, z3, roadRects)) return true;
  const effectiveDiag = diagRoads ?? (roadRects?.some((r) => r.axis === "diag") ? roadRects : null);
  return poseInSingleDiagRoadCoords(x0, z0, x1, z1, x2, z2, x3, z3, effectiveDiag);
}

function poseOnRoadFast(pose, roads, roadRects = null, diagRoads = roadRects?.diagRoads) {
  if (!roads?.length) return false;
  const h = pose.heading ?? 0;
  const s = Math.sin(h);
  const c = Math.cos(h);
  const l = (pose.length ?? 0) * 0.5;
  const w = (pose.width ?? 0) * 0.5;
  const px = pose.x;
  const pz = pose.z;
  const cw = c * w;
  const sw = s * w;
  const sl = s * l;
  const cl = c * l;
  const x0 = px - cw - sl, z0 = pz + sw - cl;
  const x1 = px + cw - sl, z1 = pz - sw - cl;
  const x2 = px + cw + sl, z2 = pz - sw + cl;
  const x3 = px - cw + sl, z3 = pz + sw + cl;
  if (!roadRects) {
    if (poseInSingleDiagRoadCoords(x0, z0, x1, z1, x2, z2, x3, z3, roads)) return true;
    return bodyOnRoad(pose, roads);
  }
  if (poseInSingleRoadRectCoords(x0, z0, x1, z1, x2, z2, x3, z3, roadRects)) return true;
  if (poseInSingleDiagRoadCoords(x0, z0, x1, z1, x2, z2, x3, z3, diagRoads)) return true;
  if (
    !pointOnRoadRects(x0, z0, roadRects, diagRoads, true, 0.001) ||
    !pointOnRoadRects(x1, z1, roadRects, diagRoads, true, 0.001) ||
    !pointOnRoadRects(x2, z2, roadRects, diagRoads, true, 0.001) ||
    !pointOnRoadRects(x3, z3, roadRects, diagRoads, true, 0.001)
  ) {
    return false;
  }
  return bodyOnRoad(pose, roads);
}

export function poseOnRoadOrCurb(
  pose,
  roads,
  curb,
  roadRects = null,
  pointRoadRects = null,
  diagRoads = roadRects?.diagRoads ?? pointRoadRects?.diagRoads,
) {
  const hasRoads = Boolean(roads?.length);
  const h = pose.heading ?? 0;
  const s = Math.sin(h);
  const c = Math.cos(h);
  const l = (pose.length ?? 0) * 0.5;
  const w = (pose.width ?? 0) * 0.5;
  const px = pose.x;
  const pz = pose.z;
  const cw = c * w;
  const sw = s * w;
  const sl = s * l;
  const cl = c * l;
  const x0 = px - cw - sl, z0 = pz + sw - cl;
  const x1 = px + cw - sl, z1 = pz - sw - cl;
  const x2 = px + cw + sl, z2 = pz - sw + cl;
  const x3 = px - cw + sl, z3 = pz + sw + cl;

  const hasUnindexedDiag = Boolean(roadRects && !diagRoads && hasRoads && roads.some((r) => r.axis === "diag"));
  if (!roadRects || !pointRoadRects || hasUnindexedDiag) {
    if (hasRoads && (poseInSingleDiagRoadCoords(x0, z0, x1, z1, x2, z2, x3, z3, roads) || bodyOnRoad(pose, roads))) {
      return SUPPORT_ROAD;
    }
    if (!curb) return SUPPORT_NONE;
    if (
      Array.isArray(curb.courtyards) &&
      poseInSingleRoadRectCoords(x0, z0, x1, z1, x2, z2, x3, z3, curb.courtyards)
    ) {
      return SUPPORT_CURB;
    }
    const pts = corners(pose);
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      if (!(hasRoads && pointOnRoad(p, roads)) && !pointOnCurbXY(p.x, p.z, curb))
        return SUPPORT_NONE;
    }
    return SUPPORT_CURB;
  }

  if (
    hasRoads &&
    (poseInSingleRoadRectCoords(x0, z0, x1, z1, x2, z2, x3, z3, roadRects) ||
      poseInSingleDiagRoadCoords(x0, z0, x1, z1, x2, z2, x3, z3, diagRoads))
  ) {
    return SUPPORT_ROAD;
  }

  const allInRoadRects =
    hasRoads &&
    pointOnRoadRects(x0, z0, roadRects, diagRoads, true, 0.001) &&
    pointOnRoadRects(x1, z1, roadRects, diagRoads, true, 0.001) &&
    pointOnRoadRects(x2, z2, roadRects, diagRoads, true, 0.001) &&
    pointOnRoadRects(x3, z3, roadRects, diagRoads, true, 0.001);

  if (allInRoadRects && bodyOnRoad(pose, roads)) {
    return SUPPORT_ROAD;
  }

  if (!curb) {
    return SUPPORT_NONE;
  }

  if (
    Array.isArray(curb.courtyards) &&
    poseInSingleRoadRectCoords(x0, z0, x1, z1, x2, z2, x3, z3, curb.courtyards)
  ) {
    return SUPPORT_CURB;
  }

  if (
    (!(hasRoads && pointOnRoadRects(x0, z0, pointRoadRects, diagRoads, false, 0)) && !pointOnCurbXY(x0, z0, curb)) ||
    (!(hasRoads && pointOnRoadRects(x1, z1, pointRoadRects, diagRoads, false, 0)) && !pointOnCurbXY(x1, z1, curb)) ||
    (!(hasRoads && pointOnRoadRects(x2, z2, pointRoadRects, diagRoads, false, 0)) && !pointOnCurbXY(x2, z2, curb)) ||
    (!(hasRoads && pointOnRoadRects(x3, z3, pointRoadRects, diagRoads, false, 0)) && !pointOnCurbXY(x3, z3, curb))
  ) {
    return SUPPORT_NONE;
  }

  return SUPPORT_CURB;
}

function pointToBoxDistance(px, pz, box) {
  const dx = px - box.x;
  const dz = pz - box.z;
  const c = Math.cos(box.heading ?? 0);
  const s = Math.sin(box.heading ?? 0);
  const localRight = Math.abs(dx * c - dz * s) - box.width / 2;
  const localForward = Math.abs(dx * s + dz * c) - box.length / 2;
  if (localRight <= 0 && localForward <= 0) return Math.max(localRight, localForward);
  return Math.hypot(Math.max(0, localRight), Math.max(0, localForward));
}

const localGeometryCache = new WeakMap();

function filterLocalGeometry(world, player) {
  if (world && typeof world === "object") {
    const cached = localGeometryCache.get(world);
    if (
      cached &&
      cached.roadsRef === world.roads &&
      cached.staticsRef === world.statics &&
      cached.staticsLen === (world.statics?.length ?? 0) &&
      cached.curbRef === (world.pursuit?.gta?.curb ?? null) &&
      Math.hypot(player.x - cached.x, player.z - cached.z) < 12
    ) {
      return cached.geo;
    }
  }
  const reach = 92;
  const minX = player.x - reach;
  const maxX = player.x + reach;
  const minZ = player.z - reach;
  const maxZ = player.z + reach;

  const roads = [];
  const roadRects = [];
  const pointRoadRects = [];
  const diagRoads = [];
  const rawRoads = world.roads ?? [];
  for (let i = 0; i < rawRoads.length; i++) {
    const road = rawRoads[i];
    const r0 = roadRect(road, 0);
    if (r0.maxX >= minX && r0.minX <= maxX && r0.maxZ >= minZ && r0.minZ <= maxZ) {
      roads.push(road);
      if (road.axis === "diag") {
        diagRoads.push({
          id: road.id,
          axis: "diag",
          x1: road.x1,
          z1: road.z1,
          ux: road.ux,
          uz: road.uz,
          length: road.length,
          width: road.width,
          halfW0: road.width * 0.5,
          halfWMargin: Math.max(0, road.width * 0.5 - 0.08),
          minX: r0.minX,
          maxX: r0.maxX,
          minZ: r0.minZ,
          maxZ: r0.maxZ,
        });
      } else {
        pointRoadRects.push(r0);
        roadRects.push(roadRect(road, 0.08));
      }
    }
  }
  roadRects.diagRoads = diagRoads;
  pointRoadRects.diagRoads = diagRoads;

  const statics = [];
  const rawStatics = world.statics ?? [];
  for (let i = 0; i < rawStatics.length; i++) {
    const body = rawStatics[i];
    const isPed = body.type === "pedestrian";
    const half = isPed
      ? (body.radius ?? 0.4)
      : Math.hypot(body.width ?? 0, body.length ?? 0) * 0.5;
    if (
      body.x + half >= minX &&
      body.x - half <= maxX &&
      body.z + half >= minZ &&
      body.z - half <= maxZ
    ) {
      const sh = body.heading ?? 0;
      const sc = Math.abs(Math.cos(sh));
      const ss = Math.abs(Math.sin(sh));
      const sw = isPed ? (body.radius ?? 0.4) : Math.abs(body.width ?? 0) * 0.5;
      const sl = isPed ? (body.radius ?? 0.4) : Math.abs(body.length ?? 0) * 0.5;
      const extX = isPed ? sw : sw * sc + sl * ss;
      const extZ = isPed ? sl : sw * ss + sl * sc;
      statics.push({
        body,
        aabbMinX: body.x - extX,
        aabbMaxX: body.x + extX,
        aabbMinZ: body.z - extZ,
        aabbMaxZ: body.z + extZ,
        nearStart: overlaps(player, body, STATIC_CURB_GAP_M),
      });
    }
  }

  const rawCurb = world.pursuit?.gta?.curb ?? null;
  let curb = null;
  if (rawCurb) {
    const hasSites = Array.isArray(rawCurb.sites);
    const hasCourtyards = Array.isArray(rawCurb.courtyards);
    if (hasSites || hasCourtyards) {
      const sites = hasSites
        ? rawCurb.sites.filter(
            (s) => s.maxX >= minX && s.minX <= maxX && s.maxZ >= minZ && s.minZ <= maxZ,
          )
        : [];
      const courtyards = hasCourtyards
        ? rawCurb.courtyards.filter(
            (c) => c.maxX >= minX && c.minX <= maxX && c.maxZ >= minZ && c.minZ <= maxZ,
          )
        : undefined;
      if (sites.length > 0 || (courtyards && courtyards.length > 0)) {
        curb = courtyards !== undefined ? { ...rawCurb, sites, courtyards } : { ...rawCurb, sites };
      }
    } else if (
      rawCurb.maxX >= minX &&
      rawCurb.minX <= maxX &&
      rawCurb.maxZ >= minZ &&
      rawCurb.minZ <= maxZ
    ) {
      curb = rawCurb;
    }
  }

  const geo = { roads, roadRects, pointRoadRects, diagRoads, statics, curb, rawCurb };
  if (world && typeof world === "object") {
    localGeometryCache.set(world, {
      roadsRef: world.roads,
      staticsRef: world.statics,
      staticsLen: rawStatics.length,
      curbRef: rawCurb,
      x: player.x,
      z: player.z,
      geo,
    });
  }
  return geo;
}

function extractVisualForecastPoints(visualState, start) {
  if (!visualState?.available || !Array.isArray(visualState.forecasts)) return [];
  const points = [];
  const c = Math.cos(start.heading);
  const s = Math.sin(start.heading);
  for (const item of visualState.forecasts) {
    if (!item || (item.label && item.label !== "person")) continue;
    if (item.qualified === false) continue;
    if (Array.isArray(item.points)) {
      for (const pt of item.points) {
        const ahead = pt?.secondsAhead ?? 0;
        const x = pt?.x ?? pt?.xM;
        const z = pt?.z ?? pt?.zM;
        if (ahead <= 1.0 + 1e-6 && Number.isFinite(x) && Number.isFinite(z))
          points.push({ x, z });
      }
      continue;
    }
    const directX = item.x ?? item.xM;
    const directZ = item.z ?? item.zM;
    if (Number.isFinite(directX) && Number.isFinite(directZ)) {
      if ((item.secondsAhead ?? 0) <= 1.0 + 1e-6) points.push({ x: directX, z: directZ });
      continue;
    }
    if (item.qualified === true && Number.isFinite(item.lateralM) && Number.isFinite(item.longitudinalM)) {
      const vLat = Number.isFinite(item.lateralSpeedMps) ? item.lateralSpeedMps : 0;
      const vLon = Number.isFinite(item.forwardSpeedMps) ? item.forwardSpeedMps : 0;
      for (const t of [0, 0.5, 1.0]) {
        const r = item.lateralM + vLat * t;
        const f = item.longitudinalM + vLon * t;
        points.push({ x: start.x + r * c + f * s, z: start.z - r * s + f * c });
      }
    }
  }
  return points;
}

function hasCameraCrossingConflict(visualState) {
  if (!visualState?.available) return false;
  if (visualState.decision?.available === true && visualState.decision.brake === true) return true;
  if (Array.isArray(visualState.forecasts)) {
    return visualState.forecasts.some(
      (f) => f && f.label === "person" && f.qualified === true && f.conflict === true,
    );
  }
  return false;
}

function buildScanModel(scan, start) {
  const startBox = { x: 0, z: 0, heading: 0, width: start.width, length: start.length };
  const w0 = start.width / 2;
  const l0 = start.length / 2;

  const surfacePoints = [];
  const hitPoints = [];
  const rayPoints = new Array(PURSUIT_SCAN_RAYS);
  const pedRays = [];
  const effectiveBeamLimit = new Float64Array(PURSUIT_SCAN_RAYS);
  const sectorConnected = new Uint8Array(PURSUIT_SCAN_RAYS);

  for (let i = 0; i < PURSUIT_SCAN_RAYS; i++) {
    const ray = scan.rays[i];
    const [bx, bz] = BEAMS[i];
    const farX = Math.abs(bx) < 1e-9 ? Infinity : w0 / Math.abs(bx);
    const farZ = Math.abs(bz) < 1e-9 ? Infinity : l0 / Math.abs(bz);
    const sFar = Math.min(farX, farZ);

    const rx = bx * ray.rangeM;
    const rz = bz * ray.rangeM;
    if (ray.kind === "none") {
      rayPoints[i] = null;
    } else {
      const initialBoxDist = pointToBoxDistance(rx, rz, startBox);
      const pt = { x: rx, z: rz, kind: ray.kind, rangeM: ray.rangeM, initialBoxDist };
      rayPoints[i] = pt;
      hitPoints.push(pt);
      surfacePoints.push(pt);
    }

    if (ray.kind === "pedestrian" && ray.rangeM <= PED_RAY_RANGE_M) {
      pedRays.push({ x: rx, z: rz, rangeM: ray.rangeM });
    }

    if (ray.kind !== "pedestrian" && ray.rangeM - sFar < RAY_MARGIN_M) {
      effectiveBeamLimit[i] = Math.max(0, ray.rangeM - 0.004);
    } else {
      effectiveBeamLimit[i] = ray.rangeM - RAY_MARGIN_M;
    }
  }

  for (let i = 0; i < PURSUIT_SCAN_RAYS; i++) {
    const nextIdx = (i + 1) % PURSUIT_SCAN_RAYS;
    const pA = rayPoints[i];
    const pB = rayPoints[nextIdx];
    if (pA && pB && Math.abs(pA.rangeM - pB.rangeM) <= 2.5) {
      sectorConnected[i] = 1;
    }
  }

  // Propagate minimum initialBoxDist across connected non-pedestrian ray runs so a flanking
  // vehicle 0.05 m alongside ego does not demand 0.12 m further along the same side face.
  const rayRunMinDist = new Float64Array(PURSUIT_SCAN_RAYS);
  for (let i = 0; i < PURSUIT_SCAN_RAYS; i++) {
    rayRunMinDist[i] = rayPoints[i] ? rayPoints[i].initialBoxDist : PURSUIT_SCAN_RANGE_M;
  }
  for (let pass = 0; pass < 12; pass++) {
    for (let i = 0; i < PURSUIT_SCAN_RAYS; i++) {
      if (!sectorConnected[i]) continue;
      const nextIdx = (i + 1) % PURSUIT_SCAN_RAYS;
      const pA = rayPoints[i];
      const pB = rayPoints[nextIdx];
      if (!pA || !pB || pA.kind === "pedestrian" || pB.kind === "pedestrian") continue;
      const shared = Math.min(rayRunMinDist[i], rayRunMinDist[nextIdx]);
      rayRunMinDist[i] = shared;
      rayRunMinDist[nextIdx] = shared;
    }
  }

  const closeNonPedBeam = new Uint8Array(PURSUIT_SCAN_RAYS);
  for (let i = 0; i < PURSUIT_SCAN_RAYS; i++) {
    const ray = scan.rays[i];
    const pt = rayPoints[i];
    if (pt && pt.kind !== "pedestrian") {
      pt.faceMinDist = rayRunMinDist[i];
      closeNonPedBeam[i] = (pt.faceMinDist ?? pt.initialBoxDist) < RAY_MARGIN_M ? 1 : 0;
      const reqRayMargin =
        pt.faceMinDist < RAY_MARGIN_M
          ? Math.max(0.004, Math.min(RAY_MARGIN_M, pt.faceMinDist - 0.015))
          : RAY_MARGIN_M;
      effectiveBeamLimit[i] = Math.max(0, ray.rangeM - reqRayMargin);
    }
  }

  for (let i = 0; i < PURSUIT_SCAN_RAYS; i++) {
    if (!sectorConnected[i]) continue;
    const nextIdx = (i + 1) % PURSUIT_SCAN_RAYS;
    const pA = rayPoints[i];
    const pB = rayPoints[nextIdx];
    const mx = 0.5 * (pA.x + pB.x);
    const mz = 0.5 * (pA.z + pB.z);
    const isPed = pA.kind === "pedestrian" || pB.kind === "pedestrian";
    const initD = pointToBoxDistance(mx, mz, startBox);
    surfacePoints.push({
      x: mx,
      z: mz,
      kind: isPed ? "pedestrian" : pA.kind,
      rangeM: Math.hypot(mx, mz),
      initialBoxDist: initD,
      faceMinDist: isPed ? initD : Math.min(initD, pA.faceMinDist ?? initD, pB.faceMinDist ?? initD),
    });
  }
  const c0 = Math.cos(start.heading);
  const s0 = Math.sin(start.heading);
  const elapsedS = PURSUIT_SCAN_TICKS * STEP;
  const freshTracks = [];
  for (const track of scan.tracks) {
    if (track.ageS !== 0 || track.kind === "static") continue;
    const rangeM = Math.hypot(track.rightM, track.forwardM);
    let vx = 0;
    let vz = 0;
    let forecastConfirmed = false;

    if (track.motionKnown) {
      if (track.kind === "pedestrian") {
        vx = track.rightMps + (start.gtaSlipMps ?? 0);
        vz = track.forwardMps + start.speed;
        const sampleWidth = Math.max(0.03, rangeM * (ANGLE_STEP / 10));
        if (Math.abs(vx) * elapsedS <= sampleWidth) vx = 0;
        if (Math.abs(vz) * elapsedS <= sampleWidth) vz = 0;
        if (Math.hypot(vx, vz) > 4.5) {
          vx = 0;
          vz = 0;
        } else {
          forecastConfirmed = true;
        }
      } else {
        const forecast = forecastPursuitSurface(track);
        if (forecast.status === "constant-velocity" && forecast.points.length > 0) {
          const pt = forecast.points[0];
          const dtF = pt.secondsAhead;
          const worldVx = (pt.xM - track.observedXM) / dtF;
          const worldVz = (pt.zM - track.observedZM) / dtF;
          vx = worldVx * c0 - worldVz * s0;
          vz = worldVx * s0 + worldVz * c0;
          const quantSpeed = Math.max(0.15, rangeM * ANGLE_STEP) / elapsedS;
          if (Math.hypot(vx, vz) <= quantSpeed * 0.85) {
            vx = 0;
            vz = 0;
          } else {
            forecastConfirmed = true;
          }
        } else {
          vx = track.rightMps + (start.gtaSlipMps ?? 0);
          vz = track.forwardMps + start.speed;
          const sampleWidth = Math.max(0.18, rangeM * ANGLE_STEP * 1.15);
          if (Math.abs(vx) * elapsedS <= sampleWidth) vx = 0;
          if (Math.abs(vz) * elapsedS <= sampleWidth) vz = 0;
          const maxSpeed = track.kind === "police" ? 36 : 26;
          if (Math.hypot(vx, vz) > maxSpeed) {
            vx = 0;
            vz = 0;
          }
        }
      }
    }
    const closingMps =
      track.motionKnown && rangeM > 1e-3
        ? -(track.rightM * track.rightMps + track.forwardM * track.forwardMps) / rangeM
        : 0;
    freshTracks.push({
      kind: track.kind,
      rightM: track.rightM,
      forwardM: track.forwardM,
      vx,
      vz,
      closingMps,
      forecastConfirmed,
      motionKnown: track.motionKnown,
      rangeM,
      initialGap: pointToBoxDistance(track.rightM, track.forwardM, startBox),
    });
  }

  let minConnectedBeamLimit = PURSUIT_SCAN_RANGE_M;
  for (let i = 0; i < PURSUIT_SCAN_RAYS; i++) {
    if (!sectorConnected[i]) continue;
    const nextIdx = (i + 1) % PURSUIT_SCAN_RAYS;
    const pA = rayPoints[i];
    const pB = rayPoints[nextIdx];
    const closeNonPed =
      pA.kind !== "pedestrian" &&
      pB.kind !== "pedestrian" &&
      ((pA.faceMinDist ?? pA.initialBoxDist) < RAY_MARGIN_M ||
        (pB.faceMinDist ?? pB.initialBoxDist) < RAY_MARGIN_M);
    if (!closeNonPed) {
      const lim = Math.min(effectiveBeamLimit[i], effectiveBeamLimit[nextIdx]);
      if (lim < minConnectedBeamLimit) minConnectedBeamLimit = lim;
    }
  }

  return {
    egoHeading: start.heading ?? 0,
    rays: scan.rays,
    rayPoints,
    hitPoints,
    surfacePoints,
    pedRays,
    effectiveBeamLimit,
    closeNonPedBeam,
    sectorConnected,
    minConnectedBeamLimit,
    freshTracks,
  };
}

function normalizeBearing(angle) {
  let a = angle % (2 * Math.PI);
  if (a > Math.PI) a -= 2 * Math.PI;
  else if (a <= -Math.PI) a += 2 * Math.PI;
  return a;
}

export function detectClosingPursuersFromScan(scanModel, egoHeading = scanModel?.egoHeading ?? 0) {
  if (!scanModel) {
    return {
      active: false,
      count: 0,
      nearestM: Infinity,
      dominantWorldBearing: null,
      rearPursuer: false,
    };
  }

  const contacts = [];
  const tracks = scanModel.freshTracks ?? scanModel.tracks ?? [];
  for (let i = 0; i < tracks.length; i++) {
    const tr = tracks[i];
    if (!tr || tr.kind !== "police") continue;
    if (tr.ageS !== undefined && tr.ageS > 0) continue;
    const rangeM = Number.isFinite(tr.rangeM) ? tr.rangeM : Math.hypot(tr.rightM, tr.forwardM);
    if (!Number.isFinite(rangeM) || rangeM < 1e-4 || rangeM > 38.0) continue;
    const closingSpeed = Number.isFinite(tr.closingMps)
      ? tr.closingMps
      : Number.isFinite(tr.closingSpeed)
        ? tr.closingSpeed
        : tr.motionKnown && Number.isFinite(tr.rightMps) && Number.isFinite(tr.forwardMps)
          ? -(tr.rightM * tr.rightMps + tr.forwardM * tr.forwardMps) / rangeM
          : 0;
    const rearOrFlank = tr.forwardM <= 8.0;
    const threatening = rearOrFlank
      ? !tr.motionKnown || closingSpeed > -1.5
      : closingSpeed > 1.0;
    if (!threatening) continue;
    const localAngle = Math.atan2(tr.rightM, tr.forwardM);
    contacts.push({
      rightM: tr.rightM,
      forwardM: tr.forwardM,
      rangeM,
      closingSpeed,
      localAngle,
      worldBearing: normalizeBearing(egoHeading + localAngle),
      rear: tr.forwardM <= 4.0,
    });
  }

  const rays = scanModel.rays;
  if (Array.isArray(rays) && rays.length === PURSUIT_SCAN_RAYS) {
    let runBestIdx = -1;
    let runBestRange = Infinity;
    const flushRayCluster = () => {
      if (runBestIdx < 0) return;
      const [bx, bz] = BEAMS[runBestIdx];
      const rx = bx * runBestRange;
      const fz = bz * runBestRange;
      if (fz <= 8.0) {
        let alreadyCovered = false;
        for (let k = 0; k < contacts.length; k++) {
          if (Math.hypot(rx - contacts[k].rightM, fz - contacts[k].forwardM) <= 3.8) {
            alreadyCovered = true;
            break;
          }
        }
        if (!alreadyCovered) {
          const localAngle = Math.atan2(rx, fz);
          contacts.push({
            rightM: rx,
            forwardM: fz,
            rangeM: runBestRange,
            closingSpeed: 0,
            localAngle,
            worldBearing: normalizeBearing(egoHeading + localAngle),
            rear: fz <= 4.0,
          });
        }
      }
      runBestIdx = -1;
      runBestRange = Infinity;
    };

    for (let i = 0; i < PURSUIT_SCAN_RAYS; i++) {
      const ray = rays[i];
      if (ray && ray.kind === "police" && ray.rangeM <= 38.0) {
        if (ray.rangeM < runBestRange) {
          runBestRange = ray.rangeM;
          runBestIdx = i;
        }
      } else {
        flushRayCluster();
      }
    }
    flushRayCluster();
  }

  if (contacts.length === 0) {
    return {
      active: false,
      count: 0,
      nearestM: Infinity,
      dominantWorldBearing: null,
      rearPursuer: false,
    };
  }

  let nearestM = Infinity;
  let rearPursuer = false;
  let sumSin = 0;
  let sumCos = 0;
  let totalWeight = 0;
  let topWeight = -Infinity;
  let topBearing = contacts[0].worldBearing;

  for (let i = 0; i < contacts.length; i++) {
    const c = contacts[i];
    if (c.rangeM < nearestM) nearestM = c.rangeM;
    if (c.rear) rearPursuer = true;
    const weight =
      (1 / Math.max(4.0, c.rangeM)) *
      (c.rear ? 1.55 : 1.0) *
      (1 + 0.14 * Math.max(0, c.closingSpeed));
    sumSin += weight * Math.sin(c.worldBearing);
    sumCos += weight * Math.cos(c.worldBearing);
    totalWeight += weight;
    if (weight > topWeight) {
      topWeight = weight;
      topBearing = c.worldBearing;
    }
  }

  const dominantWorldBearing =
    Math.hypot(sumSin, sumCos) >= 0.35 * totalWeight
      ? Math.atan2(sumSin, sumCos)
      : topBearing;

  return {
    active: true,
    count: contacts.length,
    nearestM,
    dominantWorldBearing,
    rearPursuer,
  };
}

export function segmentIntersectsOrientedBox(ax, az, bx, bz, box, pad = 0) {
  const hw = (box.width ?? 0) * 0.5 + pad;
  const hl = (box.length ?? 0) * 0.5 + pad;
  if (hw <= 0 || hl <= 0) return false;
  const c = Math.cos(box.heading ?? 0);
  const s = Math.sin(box.heading ?? 0);
  const dax = ax - box.x;
  const daz = az - box.z;
  const dbx = bx - box.x;
  const dbz = bz - box.z;
  const r0 = dax * c - daz * s;
  const f0 = dax * s + daz * c;
  const dr = dbx * c - dbz * s - r0;
  const df = dbx * s + dbz * c - f0;

  let tMin = 0;
  let tMax = 1;
  if (Math.abs(dr) < 1e-9) {
    if (Math.abs(r0) > hw) return false;
  } else {
    const t1 = (-hw - r0) / dr;
    const t2 = (hw - r0) / dr;
    tMin = Math.max(tMin, t1 < t2 ? t1 : t2);
    tMax = Math.min(tMax, t1 > t2 ? t1 : t2);
    if (tMin > tMax) return false;
  }
  if (Math.abs(df) < 1e-9) {
    if (Math.abs(f0) > hl) return false;
  } else {
    const t1 = (-hl - f0) / df;
    const t2 = (hl - f0) / df;
    tMin = Math.max(tMin, t1 < t2 ? t1 : t2);
    tMax = Math.min(tMax, t1 > t2 ? t1 : t2);
    if (tMin > tMax) return false;
  }
  return true;
}

function collectNearbyLosBuildings(localGeometry, player) {
  const out = [];
  const statics = localGeometry?.statics ?? [];
  for (let i = 0; i < statics.length; i++) {
    const body = statics[i].body ?? statics[i];
    if (!body || body.kind !== "building") continue;
    if (Math.hypot(body.x - player.x, body.z - player.z) <= 65.0) {
      out.push(body);
    }
  }
  return out;
}

function minBoxGapToStatics(pose, statics, searchCapM = 4.0) {
  if (!statics?.length) return searchCapM;
  const h = pose.heading ?? 0;
  const c = Math.cos(h);
  const s = Math.sin(h);
  const ac = Math.abs(c);
  const as = Math.abs(s);
  const hw = (pose.width ?? PLAYER_VEHICLE.widthM) * 0.5;
  const hl = (pose.length ?? PLAYER_VEHICLE.lengthM) * 0.5;
  const extX = hw * ac + hl * as + searchCapM;
  const extZ = hw * as + hl * ac + searchCapM;
  const px = pose.x;
  const pz = pose.z;
  const cw = c * hw;
  const sw = s * hw;
  const sl = s * hl;
  const cl = c * hl;
  const ax0 = px - cw - sl, az0 = pz + sw - cl;
  const ax1 = px + cw - sl, az1 = pz - sw - cl;
  const ax2 = px + cw + sl, az2 = pz - sw + cl;
  const ax3 = px - cw + sl, az3 = pz + sw + cl;

  let minGap = searchCapM;
  for (let i = 0; i < statics.length; i++) {
    const entry = statics[i];
    if (
      entry.aabbMinX !== undefined &&
      (px + extX < entry.aabbMinX ||
        px - extX > entry.aabbMaxX ||
        pz + extZ < entry.aabbMinZ ||
        pz - extZ > entry.aabbMaxZ)
    ) {
      continue;
    }
    const st = entry.body ?? entry;
    if (!st) continue;
    if (st.type === "pedestrian") {
      const d = pointToBoxDistPrecomputed(st.x, st.z, px, pz, c, s, hw, hl) - (st.radius ?? 0.4);
      if (d < minGap) minGap = d;
      continue;
    }
    const sc = Math.cos(st.heading ?? 0);
    const ss = Math.sin(st.heading ?? 0);
    const shw = (st.width ?? 0) * 0.5;
    const shl = (st.length ?? 0) * 0.5;
    if (shw <= 0 || shl <= 0) continue;
    let d = pointToBoxDistPrecomputed(ax0, az0, st.x, st.z, sc, ss, shw, shl);
    d = Math.min(d, pointToBoxDistPrecomputed(ax1, az1, st.x, st.z, sc, ss, shw, shl));
    d = Math.min(d, pointToBoxDistPrecomputed(ax2, az2, st.x, st.z, sc, ss, shw, shl));
    d = Math.min(d, pointToBoxDistPrecomputed(ax3, az3, st.x, st.z, sc, ss, shw, shl));
    if (d <= 0) return 0;
    const scw = sc * shw, ssw = ss * shw, ssl = ss * shl, scl = sc * shl;
    d = Math.min(d, pointToBoxDistPrecomputed(st.x - scw - ssl, st.z + ssw - scl, px, pz, c, s, hw, hl));
    d = Math.min(d, pointToBoxDistPrecomputed(st.x + scw - ssl, st.z - ssw - scl, px, pz, c, s, hw, hl));
    d = Math.min(d, pointToBoxDistPrecomputed(st.x + scw + ssl, st.z - ssw + scl, px, pz, c, s, hw, hl));
    d = Math.min(d, pointToBoxDistPrecomputed(st.x - scw + ssl, st.z + ssw + scl, px, pz, c, s, hw, hl));
    if (d <= 0) return 0;
    if (d < minGap) minGap = d;
  }
  return minGap;
}

function inspectPedestrianProximity(start, scanModel, visualPoints) {
  let nearestM = Infinity;
  let nearestForwardCorridorM = Infinity;
  const hw = (start.width ?? PLAYER_VEHICLE.widthM) * 0.5;
  const hl = (start.length ?? PLAYER_VEHICLE.lengthM) * 0.5;
  const considerLocal = (rx, fz) => {
    const gap = Math.max(0, pointToBoxDistPrecomputed(rx, fz, 0, 0, 1, 0, hw, hl));
    if (gap < nearestM) nearestM = gap;
    if (fz >= -0.6 && Math.abs(rx) <= hw + 1.65 && gap < nearestForwardCorridorM) {
      nearestForwardCorridorM = gap;
    }
  };
  for (let i = 0; i < scanModel.pedRays.length; i++) {
    considerLocal(scanModel.pedRays[i].x, scanModel.pedRays[i].z);
  }
  for (let i = 0; i < scanModel.hitPoints.length; i++) {
    const pt = scanModel.hitPoints[i];
    if (pt.kind === "pedestrian") considerLocal(pt.x, pt.z);
  }
  for (let i = 0; i < scanModel.freshTracks.length; i++) {
    const tr = scanModel.freshTracks[i];
    if (tr.kind !== "pedestrian") continue;
    considerLocal(tr.rightM, tr.forwardM);
    if (tr.motionKnown) {
      considerLocal(tr.rightM + tr.vx * 0.6, tr.forwardM + tr.vz * 0.6);
    }
  }
  if (visualPoints?.length) {
    const c0 = Math.cos(start.heading);
    const s0 = Math.sin(start.heading);
    for (let i = 0; i < visualPoints.length; i++) {
      const dx = visualPoints[i].x - start.x;
      const dz = visualPoints[i].z - start.z;
      considerLocal(dx * c0 - dz * s0, dx * s0 + dz * c0);
    }
  }
  return { nearestM, nearestForwardCorridorM };
}

const LOS_CLEAR_PROBE_DISTS = Object.freeze([2.5, 5.5, 8.5, 11.5, 14.5, 18.0]);
const _losSupportProbe = { x: 0, z: 0, heading: 0, width: 0, length: 0, type: "vehicle" };
const _losStaticProbe = { x: 0, z: 0, heading: 0, width: 0, length: 0, type: "vehicle" };

function evaluateLosEscapeRay(
  originX,
  originZ,
  escapeHeading,
  player,
  localGeometry,
  scanModel,
  visualPoints,
  allowCurb,
) {
  const { roads, roadRects, pointRoadRects, statics } = localGeometry;
  const curb = allowCurb ? localGeometry.curb : null;
  const sinH = Math.sin(escapeHeading);
  const cosH = Math.cos(escapeHeading);
  const cos0 = Math.cos(player.heading);
  const sin0 = Math.sin(player.heading);
  const relH = angleDelta(escapeHeading, player.heading);
  const lpc = Math.cos(relH);
  const lps = Math.sin(relH);
  const width = player.width ?? PLAYER_VEHICLE.widthM;
  const length = player.length ?? PLAYER_VEHICLE.lengthM;
  const halfW = width * 0.5 + 0.22;
  const halfL = length * 0.5;
  const pedSafeMargin = 1.85;

  _losSupportProbe.width = width;
  _losSupportProbe.length = length;
  _losSupportProbe.type = player.type ?? "vehicle";
  _losSupportProbe.heading = escapeHeading;

  _losStaticProbe.width = width + 0.44;
  _losStaticProbe.length = length;
  _losStaticProbe.type = player.type ?? "vehicle";
  _losStaticProbe.heading = escapeHeading;

  // Check pedestrian hazard around origin first.
  const odx = originX - player.x;
  const odz = originZ - player.z;
  const olx = odx * cos0 - odz * sin0;
  const olz = odx * sin0 + odz * cos0;
  for (let i = 0; i < scanModel.pedRays.length; i++) {
    const pr = scanModel.pedRays[i];
    if (pointToBoxDistPrecomputed(pr.x, pr.z, olx, olz, lpc, lps, halfW, halfL) < pedSafeMargin) {
      return { clearForwardM: 0, pedHazard: true, reachesDifferentCorridor: false };
    }
  }
  for (let i = 0; i < scanModel.freshTracks.length; i++) {
    const tr = scanModel.freshTracks[i];
    if (tr.kind !== "pedestrian") continue;
    if (pointToBoxDistPrecomputed(tr.rightM, tr.forwardM, olx, olz, lpc, lps, halfW, halfL) < pedSafeMargin) {
      return { clearForwardM: 0, pedHazard: true, reachesDifferentCorridor: false };
    }
  }

  let clearForwardM = 0;
  let pedHazard = false;
  let reachesOffRoadOrCross = false;

  for (let idx = 0; idx < LOS_CLEAR_PROBE_DISTS.length; idx++) {
    const d = LOS_CLEAR_PROBE_DISTS[idx];
    const px = originX + sinH * d;
    const pz = originZ + cosH * d;
    _losSupportProbe.x = px;
    _losSupportProbe.z = pz;
    const support = poseOnRoadOrCurb(_losSupportProbe, roads, curb, roadRects, pointRoadRects);
    if (!support.supported) break;

    _losStaticProbe.x = px;
    _losStaticProbe.z = pz;
    if (poseHitsStaticsFast(_losStaticProbe, statics, STATIC_CURB_GAP_M)) break;

    const dx = px - player.x;
    const dz = pz - player.z;
    const lbx = dx * cos0 - dz * sin0;
    const lbz = dx * sin0 + dz * cos0;
    const distFromStart = Math.hypot(lbx, lbz);
    const maxPedCheck = Math.hypot(halfW, halfL) + pedSafeMargin + 0.5;

    for (let i = 0; i < scanModel.pedRays.length; i++) {
      const pr = scanModel.pedRays[i];
      if (pointToBoxDistPrecomputed(pr.x, pr.z, lbx, lbz, lpc, lps, halfW, halfL) < pedSafeMargin) {
        pedHazard = true;
        break;
      }
    }
    if (pedHazard) break;

    let rayBlocked = false;
    const hitPts = scanModel.hitPoints;
    for (let i = 0; i < hitPts.length; i++) {
      const pt = hitPts[i];
      if (Math.abs(pt.rangeM - distFromStart) > maxPedCheck) continue;
      if (pt.kind === "pedestrian") {
        if (pointToBoxDistPrecomputed(pt.x, pt.z, lbx, lbz, lpc, lps, halfW, halfL) < pedSafeMargin) {
          pedHazard = true;
          break;
        }
      } else if (pointToBoxDistPrecomputed(pt.x, pt.z, lbx, lbz, lpc, lps, halfW, halfL) < 0.24) {
        rayBlocked = true;
        break;
      }
    }
    if (pedHazard || rayBlocked) break;

    let trackBlocked = false;
    const tracks = scanModel.freshTracks;
    for (let i = 0; i < tracks.length; i++) {
      const tr = tracks[i];
      if (tr.kind === "pedestrian") {
        if (pointToBoxDistPrecomputed(tr.rightM, tr.forwardM, lbx, lbz, lpc, lps, halfW, halfL) < pedSafeMargin) {
          pedHazard = true;
          break;
        }
        if (tr.motionKnown) {
          for (const tProj of [0.5, 1.0]) {
            if (
              pointToBoxDistPrecomputed(
                tr.rightM + tr.vx * tProj,
                tr.forwardM + tr.vz * tProj,
                lbx,
                lbz,
                lpc,
                lps,
                halfW,
                halfL,
              ) < pedSafeMargin
            ) {
              pedHazard = true;
              break;
            }
          }
          if (pedHazard) break;
        }
      } else {
        const isRearFollower = tr.forwardM < -1.0 && tr.vz > 0;
        if (isRearFollower) continue;
        if (pointToBoxDistPrecomputed(tr.rightM, tr.forwardM, lbx, lbz, lpc, lps, halfW, halfL) < 0.26) {
          trackBlocked = true;
          break;
        }
      }
    }
    if (pedHazard || trackBlocked) break;

    if (visualPoints?.length) {
      for (let i = 0; i < visualPoints.length; i++) {
        if (pointToBoxDistance(visualPoints[i].x, visualPoints[i].z, _losSupportProbe) < pedSafeMargin) {
          pedHazard = true;
          break;
        }
      }
      if (pedHazard) break;
    }

    clearForwardM = d;
    if (support.usesCurb || Math.abs(lbx) >= 6.5) {
      reachesOffRoadOrCross = true;
    }
  }

  return { clearForwardM, pedHazard, reachesDifferentCorridor: reachesOffRoadOrCross };
}

function hasPedestrianNearPose(pose, player, scanModel, visualPoints, pedSafeMargin = 2.35) {
  const cos0 = Math.cos(player.heading);
  const sin0 = Math.sin(player.heading);
  const dx = pose.x - player.x;
  const dz = pose.z - player.z;
  const lbx = dx * cos0 - dz * sin0;
  const lbz = dx * sin0 + dz * cos0;
  const relH = angleDelta(pose.heading, player.heading);
  const lpc = Math.cos(relH);
  const lps = Math.sin(relH);
  const halfW = (player.width ?? PLAYER_VEHICLE.widthM) * 0.5 + 0.22;
  const halfL = (player.length ?? PLAYER_VEHICLE.lengthM) * 0.5;

  for (let i = 0; i < scanModel.pedRays.length; i++) {
    const pr = scanModel.pedRays[i];
    if (pointToBoxDistPrecomputed(pr.x, pr.z, lbx, lbz, lpc, lps, halfW, halfL) < pedSafeMargin) return true;
  }
  for (let i = 0; i < scanModel.hitPoints.length; i++) {
    const pt = scanModel.hitPoints[i];
    if (pt.kind !== "pedestrian") continue;
    if (pointToBoxDistPrecomputed(pt.x, pt.z, lbx, lbz, lpc, lps, halfW, halfL) < pedSafeMargin) return true;
  }
  for (let i = 0; i < scanModel.freshTracks.length; i++) {
    const tr = scanModel.freshTracks[i];
    if (tr.kind !== "pedestrian") continue;
    if (pointToBoxDistPrecomputed(tr.rightM, tr.forwardM, lbx, lbz, lpc, lps, halfW, halfL) < pedSafeMargin) return true;
    if (tr.motionKnown) {
      for (const tProj of [0.5, 1.0]) {
        if (
          pointToBoxDistPrecomputed(
            tr.rightM + tr.vx * tProj,
            tr.forwardM + tr.vz * tProj,
            lbx,
            lbz,
            lpc,
            lps,
            halfW,
            halfL,
          ) < pedSafeMargin
        ) {
          return true;
        }
      }
    }
  }
  if (visualPoints?.length) {
    const probe = {
      x: pose.x,
      z: pose.z,
      heading: pose.heading,
      width: (player.width ?? PLAYER_VEHICLE.widthM) + 0.44,
      length: player.length ?? PLAYER_VEHICLE.lengthM,
    };
    for (let i = 0; i < visualPoints.length; i++) {
      if (pointToBoxDistance(visualPoints[i].x, visualPoints[i].z, probe) < pedSafeMargin) return true;
    }
  }
  return false;
}

export function computeLosBreakBonus({
  player,
  actionPose = null,
  endPose,
  action = null,
  spec = null,
  pursuerPressure,
  localGeometry,
  scanModel,
  visualPoints = [],
  allowCurb = true,
  alleyGuide = null,
  hasCrossRoadAhead = false,
  losBuildings = null,
}) {
  if (!pursuerPressure?.active || !Number.isFinite(pursuerPressure.dominantWorldBearing)) return 0;
  if (!player || !endPose || !localGeometry || !scanModel) return 0;
  if (action && (action.gear !== 1 || action.brake > 0.5)) return 0;

  const baseTurnDelta = angleDelta(endPose.heading, player.heading);
  const baseTurnMag = Math.abs(baseTurnDelta);
  if (action && Math.abs(action.steer) < 0.35 && baseTurnMag < 0.42) return 0;

  if (actionPose && hasPedestrianNearPose(actionPose, player, scanModel, visualPoints, 2.45)) return 0;
  if (hasPedestrianNearPose(endPose, player, scanModel, visualPoints, 2.45)) return 0;
  const midTurnPose = {
    x: 0.5 * (player.x + endPose.x),
    z: 0.5 * (player.z + endPose.z),
    heading: player.heading + 0.5 * baseTurnDelta,
  };
  if (hasPedestrianNearPose(midTurnPose, player, scanModel, visualPoints, 2.35)) return 0;

  const buildings = losBuildings ?? collectNearbyLosBuildings(localGeometry, player);
  const pursuerDist = Math.max(pursuerPressure.nearestM ?? 18, 18.0);
  const pursuerApprox = {
    x: player.x + Math.sin(pursuerPressure.dominantWorldBearing) * pursuerDist,
    z: player.z + Math.cos(pursuerPressure.dominantWorldBearing) * pursuerDist,
  };
  const pCos = Math.cos(player.heading);
  const pSin = Math.sin(player.heading);

  const scoreEscapeCandidate = (esc10X, esc10Z, esc14X, esc14Z, finalHeading, clearM, usedOffRoad) => {
    if (clearM < 14.0) return 0;
    const turnMagnitude = Math.max(baseTurnMag, Math.abs(angleDelta(finalHeading, player.heading)));
    const latOffset14 = Math.abs((esc14X - player.x) * pCos - (esc14Z - player.z) * pSin);
    if (latOffset14 < 4.5 && turnMagnitude < 0.42) return 0;

    let occludedByBuilding = false;
    if (buildings.length > 0 && (turnMagnitude >= 0.28 || latOffset14 >= 4.5)) {
      for (let bIdx = 0; bIdx < buildings.length; bIdx++) {
        const bldg = buildings[bIdx];
        if (segmentIntersectsOrientedBox(pursuerApprox.x, pursuerApprox.z, player.x, player.z, bldg, 0)) {
          continue;
        }
        if (
          segmentIntersectsOrientedBox(pursuerApprox.x, pursuerApprox.z, esc10X, esc10Z, bldg, 0.05) ||
          segmentIntersectsOrientedBox(pursuerApprox.x, pursuerApprox.z, esc14X, esc14Z, bldg, 0.05)
        ) {
          occludedByBuilding = true;
          break;
        }
      }
    }

    const reachesDifferentCorridor = usedOffRoad || latOffset14 >= 6.0;
    const turnsAway =
      turnMagnitude >= 0.42 &&
      reachesDifferentCorridor &&
      (occludedByBuilding || hasCrossRoadAhead || Boolean(alleyGuide) || latOffset14 >= 7.5);

    if (!occludedByBuilding && !turnsAway) return 0;

    const commitProgress = clamp((baseTurnMag - 0.25) / 0.55, 0, 1);
    let bonus = 0;
    if (occludedByBuilding && turnMagnitude >= 0.42) {
      bonus =
        15.8 +
        (pursuerPressure.rearPursuer ? 2.4 : 1.0) +
        (clearM >= 17.5 ? 1.6 : 0.5) +
        1.2 * clamp((turnMagnitude - 0.42) / 0.65, 0, 1) +
        1.0 * commitProgress;
    } else if (occludedByBuilding) {
      bonus =
        13.0 +
        (pursuerPressure.rearPursuer ? 2.0 : 0.8) +
        (clearM >= 17.5 ? 1.4 : 0.4) +
        0.8 * commitProgress;
    } else {
      bonus =
        9.2 +
        (pursuerPressure.rearPursuer ? 1.8 : 0.5) +
        (clearM >= 17.5 ? 1.2 : 0) +
        1.0 * clamp((turnMagnitude - 0.42) / 0.65, 0, 1) +
        0.8 * commitProgress;
    }
    return clamp(bonus, 9.0, 22.0);
  };

  // Direct ray check from endPose (also supports synthetic direct unit-test calls without action).
  let bestBonus = 0;
  const directCheck = evaluateLosEscapeRay(
    endPose.x,
    endPose.z,
    endPose.heading,
    player,
    localGeometry,
    scanModel,
    visualPoints,
    allowCurb,
  );
  if (directCheck.pedHazard) return 0;
  if (directCheck.clearForwardM >= 14.0) {
    bestBonus = scoreEscapeCandidate(
      endPose.x + Math.sin(endPose.heading) * 10.0,
      endPose.z + Math.cos(endPose.heading) * 10.0,
      endPose.x + Math.sin(endPose.heading) * 14.0,
      endPose.z + Math.cos(endPose.heading) * 14.0,
      endPose.heading,
      directCheck.clearForwardM,
      directCheck.reachesDifferentCorridor,
    );
  }

  if (!action || Math.abs(action.steer) < 0.35) return bestBonus;

  // Kinematic corner-completion rollout from actionPose/endPose so candidate must physically make the corner
  // without clipping curbs, buildings, traffic, or coming within 2.45 m of any pedestrian!
  const resolvedSpec = spec ?? (player.spec == null ? VEHICLE : { ...VEHICLE, ...player.spec });
  const curb = allowCurb ? localGeometry.curb : null;
  const width = player.width ?? PLAYER_VEHICLE.widthM;
  const length = player.length ?? PLAYER_VEHICLE.lengthM;
  const halfW = width * 0.5 + 0.20;
  const halfL = length * 0.5;
  const cos0 = pCos;
  const sin0 = pSin;
  const turnSign = Math.sign(action.steer);

  const seedPose = actionPose ?? endPose;
  let sim = {
    x: seedPose.x,
    z: seedPose.z,
    heading: seedPose.heading,
    steer: seedPose.steer ?? action.steer * resolvedSpec.maxSteer,
    speed: Math.max(seedPose.speed ?? player.speed ?? 6.5, 6.5),
    gtaSlipMps: 0,
    gtaYawRate: 0,
    width,
    length,
    type: player.type ?? "vehicle",
  };
  if (Math.abs(action.steer ?? 0) < 0.16 && !alleyGuide) {
    return bestBonus;
  }

  let simBuf = { ...sim };
  const stepDt = 6 * STEP;
  const rollMaxSpeed = curb ? 13.2 : Math.max(sim.speed, 13.5);
  let arcDistM = Math.hypot(sim.x - player.x, sim.z - player.z);
  let usedOffRoad = false;
  let esc10X = sim.x;
  let esc10Z = sim.z;
  let reached10 = false;
  let esc14X = sim.x;
  let esc14Z = sim.z;
  let reached14 = false;

  for (let step = 1; step <= 11; step++) {
    let steerCmd = action.steer;
    if (alleyGuide && Math.abs(angleDelta(alleyGuide.targetHeading, player.heading)) >= 0.42) {
      const err = angleDelta(alleyGuide.targetHeading, sim.heading);
      if (Math.abs(err) <= 0.75) steerCmd = clamp(err * 2.2, -1, 1);
    } else if (localGeometry.roads?.length) {
      const hintH = sim.heading + turnSign * 0.35;
      const roadH = nearestLocalRoadHeading(sim, hintH, localGeometry.roads);
      const roadDeltaFromStart = angleDelta(roadH, player.heading);
      if (Math.abs(roadDeltaFromStart) >= 0.42 && roadDeltaFromStart * turnSign > 0) {
        const err = angleDelta(roadH, sim.heading);
        if (Math.abs(err) <= 0.75) steerCmd = clamp(err * 2.4, -1, 1);
      }
    }

    const stepAct = { steer: steerCmd, throttle: 0.75, brake: 0, gear: 1 };
    const next = stepPursuitPoseInto(
      sim,
      simBuf,
      stepAct,
      stepDt,
      resolvedSpec,
      rollMaxSpeed,
      rollMaxSpeed,
      curb ? 13.2 : 0,
    );
    next.width = width;
    next.length = length;
    next.type = sim.type;

    const support = poseOnRoadOrCurb(
      next,
      localGeometry.roads,
      curb,
      localGeometry.roadRects,
      localGeometry.pointRoadRects,
    );
    if (!support.supported) break;
    if (support.usesCurb) usedOffRoad = true;
    if (poseHitsStaticsFast(next, localGeometry.statics, STATIC_CURB_GAP_M)) break;
    if (hasPedestrianNearPose(next, player, scanModel, visualPoints, 2.45)) return 0;

    const dx = next.x - player.x;
    const dz = next.z - player.z;
    const lbx = dx * cos0 - dz * sin0;
    const lbz = dx * sin0 + dz * cos0;
    const relH = angleDelta(next.heading, player.heading);
    const lpc = Math.cos(relH);
    const lps = Math.sin(relH);

    let obstacleHit = false;
    for (let i = 0; i < scanModel.hitPoints.length; i++) {
      const pt = scanModel.hitPoints[i];
      if (pt.kind === "pedestrian") continue;
      if (Math.abs(pt.x - lbx) > 3.6 || Math.abs(pt.z - lbz) > 3.6) continue;
      if (pointToBoxDistPrecomputed(pt.x, pt.z, lbx, lbz, lpc, lps, halfW, halfL) < 0.22) {
        obstacleHit = true;
        break;
      }
    }
    if (obstacleHit) break;
    for (let i = 0; i < scanModel.freshTracks.length; i++) {
      const tr = scanModel.freshTracks[i];
      if (tr.kind === "pedestrian") continue;
      if (tr.forwardM < -1.0 && tr.vz > 0) continue;
      if (Math.abs(tr.rightM - lbx) > 3.6 || Math.abs(tr.forwardM - lbz) > 3.6) continue;
      if (pointToBoxDistPrecomputed(tr.rightM, tr.forwardM, lbx, lbz, lpc, lps, halfW, halfL) < 0.24) {
        obstacleHit = true;
        break;
      }
    }
    if (obstacleHit) break;

    arcDistM += Math.hypot(next.x - sim.x, next.z - sim.z);
    simBuf = sim;
    sim = next;

    if (!reached10 && arcDistM >= 11.5) {
      esc10X = sim.x;
      esc10Z = sim.z;
      reached10 = true;
    }
    if (!reached14 && arcDistM >= 15.5) {
      esc14X = sim.x;
      esc14Z = sim.z;
      reached14 = true;
    }
    if (arcDistM >= 19.5) break;
  }

  if (reached14) {
    const rolloutBonus = scoreEscapeCandidate(
      esc10X,
      esc10Z,
      esc14X,
      esc14Z,
      sim.heading,
      arcDistM - 1.5,
      usedOffRoad,
    );
    if (rolloutBonus > bestBonus) bestBonus = rolloutBonus;
  }

  return bestBonus;
}

function pointToBoxDistPrecomputed(px, pz, bx, bz, c, s, halfW, halfL) {
  const dx = px - bx;
  const dz = pz - bz;
  const localRight = Math.abs(dx * c - dz * s) - halfW;
  const localForward = Math.abs(dx * s + dz * c) - halfL;
  if (localRight <= 0 && localForward <= 0) return localRight > localForward ? localRight : localForward;
  if (localRight <= 0) return localForward;
  if (localForward <= 0) return localRight;
  return Math.hypot(localRight, localForward);
}

function checkRayClearance(
  local,
  scanModel,
  inActionWindow,
  prevSurfaceDists,
  sheddingOppositeSpeed = false,
  checkDrivenBumper = false,
  gear = 1,
) {
  let minClearance = 3.05;
  const c = Math.cos(local.heading);
  const s = Math.sin(local.heading);
  const w = local.width * 0.5;
  const l = local.length * 0.5;
  const lx = local.x;
  const lz = local.z;
  const cw = c * w;
  const sw = s * w;
  const sl = s * l;
  const cl = c * l;
  _localCornerX[0] = lx - cw - sl; _localCornerZ[0] = lz + sw - cl;
  _localCornerX[1] = lx + cw - sl; _localCornerZ[1] = lz - sw - cl;
  _localCornerX[2] = lx + cw + sl; _localCornerZ[2] = lz - sw + cl;
  _localCornerX[3] = lx - cw + sl; _localCornerZ[3] = lz + sw + cl;

  const bodyDiagHalf = Math.hypot(w, l);
  const maxFarPossible = Math.hypot(lx, lz) + bodyDiagHalf;

  if (scanModel.minConnectedBeamLimit - maxFarPossible < minClearance) {
    for (let cIdx = 0; cIdx < 4; cIdx++) {
      const px = _localCornerX[cIdx];
      const pz = _localCornerZ[cIdx];
      const dist = Math.hypot(px, pz);
      let angle = Math.atan2(px, pz);
      if (angle < 0) angle += 2 * Math.PI;
      const scaled = angle / ANGLE_STEP;
      const sector = Math.floor(scaled) % PURSUIT_SCAN_RAYS;
      if (scanModel.sectorConnected[sector]) {
        const nextSec = (sector + 1) % PURSUIT_SCAN_RAYS;
        const pA = scanModel.rayPoints[sector];
        const pB = scanModel.rayPoints[nextSec];
        const closeNonPed =
          pA.kind !== "pedestrian" &&
          pB.kind !== "pedestrian" &&
          ((pA.faceMinDist ?? pA.initialBoxDist) < RAY_MARGIN_M ||
            (pB.faceMinDist ?? pB.initialBoxDist) < RAY_MARGIN_M);
        if (!closeNonPed) {
          const frac = scaled - Math.floor(scaled);
          const limit =
            (1 - frac) * scanModel.effectiveBeamLimit[sector] +
            frac * scanModel.effectiveBeamLimit[nextSec];
          const gap = limit - dist;
          if (gap <= 0) {
            _rayResult.ok = false;
            _rayResult.reason = "scan-clearance";
            _rayResult.clearance = gap;
            return _rayResult;
          }
          if (gap < minClearance) minClearance = gap;
        }
      }
    }
  }

  const r0 = -lx * c + lz * s;
  const f0 = -lx * s - lz * c;

  for (let i = 0; i < PURSUIT_SCAN_RAYS; i++) {
    if (scanModel.closeNonPedBeam[i]) continue;
    const limitI = scanModel.effectiveBeamLimit[i];
    if (limitI - maxFarPossible >= minClearance) continue;
    const [bx, bz] = BEAMS[i];
    if (Math.abs(lx * bz - lz * bx) > bodyDiagHalf || lx * bx + lz * bz < -bodyDiagHalf) continue;
    const dr = bx * c - bz * s;
    const df = bx * s + bz * c;
    if (!((Math.abs(dr) < 1e-9 && Math.abs(r0) > w) || (Math.abs(df) < 1e-9 && Math.abs(f0) > l))) {
      let near = 0;
      let far = Infinity;
      if (Math.abs(dr) >= 1e-9) {
        const a = (-w - r0) / dr;
        const b = (w - r0) / dr;
        near = Math.max(near, a < b ? a : b);
        far = Math.min(far, a > b ? a : b);
      }
      if (Math.abs(df) >= 1e-9) {
        const a = (-l - f0) / df;
        const b = (l - f0) / df;
        near = Math.max(near, a < b ? a : b);
        far = Math.min(far, a > b ? a : b);
      }
      if (far >= near) {
        const gap = limitI - far;
        if (gap <= 0) {
          _rayResult.ok = false;
          _rayResult.reason = "scan-clearance";
          _rayResult.clearance = gap;
          return _rayResult;
        }
        if (gap < minClearance) minClearance = gap;
      }
    }
  }

  const surfacePts = scanModel.surfacePoints;
  const pruneRange = maxFarPossible + RAY_MARGIN_M;
  for (let i = 0; i < surfacePts.length; i++) {
    const pt = surfacePts[i];
    const faceBaseDist = pt.faceMinDist ?? pt.initialBoxDist;
    if (pt.kind !== "pedestrian" && faceBaseDist < RAY_MARGIN_M) {
      const boxDist = pointToBoxDistPrecomputed(pt.x, pt.z, lx, lz, c, s, w, l);
      const startD = pt.initialBoxDist;
      const baseD = startD < faceBaseDist ? startD : faceBaseDist;
      const prevDist = prevSurfaceDists ? prevSurfaceDists[i] : startD;
      let stepOk;
      if (sheddingOppositeSpeed) {
        stepOk = boxDist >= baseD - 0.012;
      } else if (baseD > 0.0005 && prevDist <= 0) {
        stepOk = boxDist >= prevDist - 1e-6;
      } else if (baseD > 0.0005) {
        const allowedFloor = Math.max(0, baseD - 0.012);
        stepOk = boxDist > 0 && (boxDist >= prevDist - 0.004 || boxDist >= allowedFloor);
      } else {
        const allowedFloor = baseD - 0.002;
        stepOk = boxDist >= allowedFloor;
      }
      if (stepOk && checkDrivenBumper && startD < 0.04 && Math.abs(pt.x) <= w - 0.08) {
        const onDrivenBumper = gear > 0 ? pt.z >= l - 0.04 : pt.z <= -l + 0.04;
        if (onDrivenBumper && boxDist < startD - 1e-5) {
          stepOk = false;
        }
      }
      if (!stepOk) {
        _rayResult.ok = false;
        _rayResult.reason = "scan-clearance";
        _rayResult.clearance = boxDist - RAY_MARGIN_M;
        return _rayResult;
      }
      if (prevSurfaceDists) prevSurfaceDists[i] = boxDist;
      const clampedClear = boxDist > 0.01 ? boxDist : 0.01;
      if (clampedClear < minClearance) minClearance = clampedClear;
    } else {
      const lowerGap = pt.rangeM - pruneRange;
      if (lowerGap > 0 && lowerGap >= minClearance) continue;
      const boxDist = pointToBoxDistPrecomputed(pt.x, pt.z, lx, lz, c, s, w, l);
      const gap = boxDist - RAY_MARGIN_M;
      if (gap <= 0) {
        _rayResult.ok = false;
        _rayResult.reason = "scan-clearance";
        _rayResult.clearance = gap;
        return _rayResult;
      }
      if (gap < minClearance) minClearance = gap;
    }
  }

  for (let i = 0; i < scanModel.pedRays.length; i++) {
    const ped = scanModel.pedRays[i];
    for (let cIdx = 0; cIdx < 4; cIdx++) {
      const cornerGap = Math.hypot(_localCornerX[cIdx] - ped.x, _localCornerZ[cIdx] - ped.z) - PED_RAY_CORNER_MARGIN_M;
      if (cornerGap < 0) {
        _rayResult.ok = false;
        _rayResult.reason = "pedestrian-ray-clearance";
        _rayResult.clearance = cornerGap;
        return _rayResult;
      }
      if (cornerGap < minClearance) minClearance = cornerGap;
    }
    const bodyMargin = inActionWindow ? PED_RAY_CORNER_MARGIN_M : PED_TRACK_STOP_MARGIN_M;
    const bodyGap = pointToBoxDistPrecomputed(ped.x, ped.z, lx, lz, c, s, w, l) - bodyMargin;
    if (bodyGap < 0) {
      _rayResult.ok = false;
      _rayResult.reason = "pedestrian-ray-clearance";
      _rayResult.clearance = bodyGap;
      return _rayResult;
    }
    if (bodyGap < minClearance) minClearance = bodyGap;
  }

  _rayResult.ok = true;
  _rayResult.reason = null;
  _rayResult.clearance = minClearance;
  return _rayResult;
}

function sweepSegmentSupportAndStatics(
  from,
  to,
  roads,
  curb,
  statics,
  stepSizeM = 0.12,
  roadRects = null,
  pointRoadRects = null,
) {
  const turn = angleDelta(to.heading, from.heading);
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const span = distance(from, to) + (Math.abs(turn) * Math.hypot(to.length, to.width)) * 0.5;
  const steps = Math.max(1, Math.ceil(span / stepSizeM));
  const probe = _sweepProbe;
  probe.type = to.type;
  probe.radius = to.radius;
  probe.length = to.length;
  probe.width = to.width;
  const pw = to.type === "pedestrian" ? Math.abs(to.radius ?? 0) : Math.abs(to.width ?? 0) * 0.5;
  const pl = to.type === "pedestrian" ? Math.abs(to.radius ?? 0) : Math.abs(to.length ?? 0) * 0.5;
  let usesCurb = false;
  let endUsesCurb = false;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    probe.x = from.x + dx * t;
    probe.z = from.z + dz * t;
    probe.heading = from.heading + turn * t;
    const support = poseOnRoadOrCurb(probe, roads, curb, roadRects, pointRoadRects);
    if (!support.supported) {
      _sweepResult.ok = false;
      _sweepResult.reason = "road-boundary";
      _sweepResult.usesCurb = usesCurb;
      _sweepResult.endUsesCurb = false;
      return _sweepResult;
    }
    usesCurb ||= support.usesCurb;
    endUsesCurb = support.usesCurb;
    if (!statics.length) continue;
    const staticGap = support.usesCurb ? STATIC_CURB_GAP_M : STATIC_ASPHALT_GAP_M;
    const pc = Math.abs(Math.cos(probe.heading));
    const ps = Math.abs(Math.sin(probe.heading));
    const pExtX = pw * pc + pl * ps + staticGap + 1e-5;
    const pExtZ = pw * ps + pl * pc + staticGap + 1e-5;
    for (let j = 0; j < statics.length; j++) {
      const entry = statics[j];
      if (
        entry.aabbMinX !== undefined &&
        (probe.x + pExtX < entry.aabbMinX ||
          probe.x - pExtX > entry.aabbMaxX ||
          probe.z + pExtZ < entry.aabbMinZ ||
          probe.z - pExtZ > entry.aabbMaxZ)
      ) {
        continue;
      }
      const st = entry.body ?? entry;
      if (entry.nearStart) {
        if (overlaps(probe, st, 0.005)) {
          _sweepResult.ok = false;
          _sweepResult.reason = "static-clearance";
          _sweepResult.usesCurb = usesCurb;
          _sweepResult.endUsesCurb = endUsesCurb;
          return _sweepResult;
        }
        if (overlaps(probe, st, staticGap) && distance(probe, st) < distance(from, st) - 0.004) {
          _sweepResult.ok = false;
          _sweepResult.reason = "static-clearance";
          _sweepResult.usesCurb = usesCurb;
          _sweepResult.endUsesCurb = endUsesCurb;
          return _sweepResult;
        }
      } else if (overlaps(probe, st, staticGap)) {
        _sweepResult.ok = false;
        _sweepResult.reason = "static-clearance";
        _sweepResult.usesCurb = usesCurb;
        _sweepResult.endUsesCurb = endUsesCurb;
        return _sweepResult;
      }
    }
  }
  _sweepResult.ok = true;
  _sweepResult.reason = null;
  _sweepResult.usesCurb = usesCurb;
  _sweepResult.endUsesCurb = endUsesCurb;
  return _sweepResult;
}

function lowSpeedForwardRolloutBlocked(
  ctx,
  action,
  actionPose,
  allowCurb,
  prevRayBoxDists,
  prevTrackDists,
  minRolloutSpeed = 2.8,
) {
  const { start, cos0, sin0, localGeometry, scanModel, visualPoints } = ctx;
  if (action.gear !== 1 || action.brake > 0 || Math.abs(start.speed) > 2.5) return false;
  const frontMin = Math.min(scanModel.rays[71].rangeM, scanModel.rays[0].rangeM, scanModel.rays[1].rangeM);
  if (frontMin > 4.6) return false;

  const curb = allowCurb ? localGeometry.curb : null;
  const spec = ctx.spec;
  const maxSpeedCmd = start.maxSpeed ?? 9.72;
  const maxSpeedPlant = start.maxSpeed ?? 13.89;
  let pose = {
    x: actionPose.x,
    z: actionPose.z,
    heading: actionPose.heading,
    steer: actionPose.steer,
    speed: Math.max(actionPose.speed, minRolloutSpeed),
    spec,
    gtaSlipMps: actionPose.gtaSlipMps ?? 0,
    gtaYawRate: actionPose.gtaYawRate ?? 0,
    type: start.type,
    radius: start.radius,
    length: start.length,
    width: start.width,
  };
  let nextBuf = { ...pose };
  const nSurf = scanModel.surfacePoints.length;
  if (_scratchSurfaceB.length < nSurf) _scratchSurfaceB = new Float64Array(nSurf + 64);
  for (let i = 0; i < nSurf; i++) _scratchSurfaceB[i] = prevRayBoxDists[i];
  const nTrk = scanModel.freshTracks.length;
  if (_scratchTrackB.length < nTrk) _scratchTrackB = new Float64Array(nTrk + 32);
  for (let i = 0; i < nTrk; i++) _scratchTrackB[i] = prevTrackDists[i];

  for (let step = 1; step <= 14; step++) {
    const next = stepPursuitPoseInto(pose, nextBuf, action, 2 * STEP, spec, maxSpeedCmd, maxSpeedPlant, 0);

    const swept = sweepSegmentSupportAndStatics(
      pose,
      next,
      localGeometry.roads,
      curb,
      localGeometry.statics,
      0.12,
      localGeometry.roadRects,
      localGeometry.pointRoadRects,
    );
    if (!swept.ok) return true;

    const dx = next.x - start.x;
    const dz = next.z - start.z;
    _localBox.x = dx * cos0 - dz * sin0;
    _localBox.z = dx * sin0 + dz * cos0;
    _localBox.heading = next.heading - start.heading;
    _localBox.width = next.width;
    _localBox.length = next.length;

    if (!checkRayClearance(_localBox, scanModel, true, _scratchSurfaceB).ok) return true;

    const lc = Math.cos(_localBox.heading);
    const ls = Math.sin(_localBox.heading);
    const hw = _localBox.width * 0.5;
    const hl = _localBox.length * 0.5;
    for (let i = 0; i < nTrk; i++) {
      const tr = scanModel.freshTracks[i];
      const boxDist = pointToBoxDistPrecomputed(tr.rightM, tr.forwardM, _localBox.x, _localBox.z, lc, ls, hw, hl);
      const reqMargin = tr.kind === "pedestrian" ? PED_TRACK_ACTION_MARGIN_M : VEH_TRACK_STOP_MARGIN_M;
      if (tr.kind !== "pedestrian" && tr.initialGap < reqMargin) {
        const startGap = tr.initialGap;
        const prevDist = _scratchTrackB[i];
        const stepOk =
          startGap > 0.0005
            ? boxDist > 0 && boxDist >= Math.max(0, Math.min(prevDist - 0.004, startGap - 0.005))
            : boxDist >= Math.max(startGap - 0.002, Math.min(prevDist - 0.004, startGap - 0.002));
        if (!stepOk) return true;
      } else if (boxDist < reqMargin) {
        return true;
      }
      _scratchTrackB[i] = boxDist;
    }

    for (let i = 0; i < visualPoints.length; i++) {
      if (pointToBoxDistance(visualPoints[i].x, visualPoints[i].z, next) < VISUAL_PERSON_MARGIN_M) return true;
    }

    nextBuf = pose;
    pose = next;
  }
  return false;
}

function coneStats(scanModel, startHeading, targetHeading, halfWidthM = 1.30) {
  let weightedSum = 0;
  let weightTotal = 0;
  let centerMin = PURSUIT_SCAN_RANGE_M;
  let nearCorridorMin = PURSUIT_SCAN_RANGE_M;
  let peakConeM = 0;
  const relAngle = angleDelta(targetHeading, startHeading);
  const c = Math.cos(relAngle);
  const s = Math.sin(relAngle);
  const twoPi = 2 * Math.PI;
  const invCone = 1 / (CONE_RAD + 1e-6);

  for (let i = 0; i < PURSUIT_SCAN_RAYS; i++) {
    const ray = scanModel.rays[i];
    let diff = i * ANGLE_STEP - relAngle;
    if (diff > Math.PI) diff -= twoPi;
    else if (diff < -Math.PI) diff += twoPi;
    const delta = diff < 0 ? -diff : diff;
    if (delta <= CONE_RAD) {
      const weight = 1 - delta * invCone;
      weightedSum += ray.rangeM * weight;
      weightTotal += weight;
      if (ray.rangeM > peakConeM) peakConeM = ray.rangeM;
    }
    if (delta <= CENTER_CONE_RAD && ray.rangeM < centerMin) {
      centerMin = ray.rangeM;
    }
    const pt = scanModel.rayPoints[i];
    if (pt) {
      const right = pt.x * c - pt.z * s;
      const forward = pt.x * s + pt.z * c;
      if (forward > 0.5 && forward <= 16.5 && Math.abs(right) <= halfWidthM && forward < nearCorridorMin) {
        nearCorridorMin = forward;
      }
    }
  }
  const meanM = weightTotal > 0 ? weightedSum / weightTotal : 0;
  const passableM = nearCorridorMin < 16.5 ? nearCorridorMin : Math.max(centerMin, 0.7 * peakConeM + 0.3 * meanM);
  return {
    meanM,
    centerMinM: centerMin,
    corridorMinM: nearCorridorMin,
    peakConeM,
    blendedM: 0.42 * meanM + 0.58 * passableM,
  };
}

function lookaheadApproachesCurb(pose, heading, roads, curb, pointRoadRects = null) {
  if (!curb || !roads?.length) return false;
  const s = Math.sin(heading);
  const c = Math.cos(heading);
  for (const distM of [3.5, 6.5, 10, 14]) {
    const px = pose.x + s * distM;
    const pz = pose.z + c * distM;
    const onRd = pointRoadRects
      ? pointOnRoadRects(px, pz, pointRoadRects, pointRoadRects.diagRoads, false, 0)
      : pointOnRoad({ x: px, z: pz }, roads);
    if (!onRd && pointOnCurbXY(px, pz, curb)) return true;
  }
  return false;
}

function forwardCorridorClearance(start, action, scanModel, roads, roadRects = null, statics = null) {
  const maxSteer = start.spec?.maxSteer ?? VEHICLE.maxSteer;
  const aimOffset = action.steer * maxSteer * 0.5;
  const aimHeading = start.heading + aimOffset;
  const c = Math.cos(aimOffset);
  const s = Math.sin(aimOffset);
  const halfCorridor = start.width / 2 + 0.45;
  let clearM = PURSUIT_SCAN_RANGE_M;

  if (roads?.length || statics?.length) {
    const worldSin = Math.sin(aimHeading);
    const worldCos = Math.cos(aimHeading);
    for (let d = 4; d <= 20; d += 2.5) {
      const probe = {
        x: start.x + worldSin * d,
        z: start.z + worldCos * d,
        heading: aimHeading,
        width: start.width,
        length: start.length,
        type: start.type,
      };
      if (
        (roads?.length && !poseOnRoadFast(probe, roads, roadRects)) ||
        (statics?.length && poseHitsStaticsFast(probe, statics, STATIC_ASPHALT_GAP_M))
      ) {
        clearM = Math.min(clearM, d);
        break;
      }
    }
  }

  for (let i = 0; i < PURSUIT_SCAN_RAYS; i++) {
    const ray = scanModel.rays[i];
    if (ray.kind === "none") continue;
    const pt = scanModel.rayPoints[i];
    const right = pt.x * c - pt.z * s;
    const forward = pt.x * s + pt.z * c;
    if (forward > 0 && Math.abs(right) <= halfCorridor) {
      clearM = Math.min(clearM, forward);
    }
  }

  for (const track of scanModel.freshTracks) {
    const right = track.rightM * c - track.forwardM * s;
    const forward = track.rightM * s + track.forwardM * c;
    if (forward <= 0 || Math.abs(right) > halfCorridor + (track.kind === "pedestrian" ? 0.55 : 0.2)) continue;
    const pullingAway = track.motionKnown && track.vz >= start.speed - 0.35 && forward >= 12;
    if (!pullingAway) clearM = Math.min(clearM, forward);
  }

  return clearM;
}

function getCachedPathArc(path) {
  let cumArc = routeArcCache.get(path);
  if (cumArc && cumArc.length === path.length) return cumArc;
  cumArc = new Float64Array(path.length);
  for (let i = 1; i < path.length; i++) {
    cumArc[i] = cumArc[i - 1] + distance(path[i - 1], path[i]);
  }
  routeArcCache.set(path, cumArc);
  return cumArc;
}

function buildFarEscapeRouteContext(world, start) {
  const gta = world?.pursuit?.gta;
  if (!world?.district || !gta) return null;
  const escapeGoal = gta.escapeGoal ?? gta.publicRouteGoal ?? null;
  const hasExplicitEscapeGoal = Boolean(gta.escapeGoal);
  const canQueryRoute = Boolean(
    escapeGoal ||
      Array.isArray(gta.config?.surveillanceZones) ||
      world.district.grand ||
      (world.config?.cityVersion ?? 0) >= 5,
  );
  if (!canQueryRoute) return null;

  let guide = null;
  try {
    guide = dispatchRouteGuide(world, CLEARANCE_ROUTE_CONTEXT);
  } catch {
    guide = null;
  }
  const path = guide?.path;
  if (!Array.isArray(path) || path.length < 2) {
    if (!escapeGoal) return null;
    const distGoal = distance(start, escapeGoal);
    return {
      guide: null,
      path: null,
      cumArc: null,
      escapeGoal,
      hasExplicitEscapeGoal,
      nearHeading: distGoal > 1.5 ? Math.atan2(escapeGoal.x - start.x, escapeGoal.z - start.z) : null,
      lookahead35Heading: distGoal > 2.0 ? Math.atan2(escapeGoal.x - start.x, escapeGoal.z - start.z) : null,
      goalDistFromStartM: distGoal,
      routeEndPoint: escapeGoal,
      startArc: 0,
      scanLo: 0,
      scanHi: 0,
      turnAhead: false,
    };
  }

  const cumArc = getCachedPathArc(path);
  let coarseIdx = 0;
  let bestDistSq = Infinity;
  const stepScan = path.length > 160 ? 4 : 1;
  for (let i = 0; i < path.length; i += stepScan) {
    const dSq = (path[i].x - start.x) ** 2 + (path[i].z - start.z) ** 2;
    if (dSq < bestDistSq) {
      bestDistSq = dSq;
      coarseIdx = i;
    }
  }
  const fineLo = Math.max(0, coarseIdx - stepScan * 2);
  const fineHi = Math.min(path.length - 1, coarseIdx + stepScan * 2);
  let seedIdx = coarseIdx;
  for (let i = fineLo; i <= fineHi; i++) {
    const dSq = (path[i].x - start.x) ** 2 + (path[i].z - start.z) ** 2;
    if (dSq < bestDistSq) {
      bestDistSq = dSq;
      seedIdx = i;
    }
  }
  const nearestIdx = nearestPathPoint(path, start.x, start.z, seedIdx);
  const startArc = cumArc[nearestIdx];
  const distToPathM = Math.hypot(path[nearestIdx].x - start.x, path[nearestIdx].z - start.z);

  let idx14 = nearestIdx;
  while (idx14 < path.length - 1 && cumArc[idx14] - startArc < 14.0) idx14++;
  let idx26 = idx14;
  while (idx26 < path.length - 1 && cumArc[idx26] - startArc < 26.0) idx26++;
  let idx35 = idx26;
  while (idx35 < path.length - 1 && cumArc[idx35] - startArc < 35.0) idx35++;

  const pt14 = path[idx14];
  const dx14 = pt14.x - start.x;
  const dz14 = pt14.z - start.z;
  const nearHeading = Math.hypot(dx14, dz14) > 1.5 ? Math.atan2(dx14, dz14) : null;

  const pt35 = path[idx35];
  const dx35 = pt35.x - start.x;
  const dz35 = pt35.z - start.z;
  const lookahead35Heading =
    Math.hypot(dx35, dz35) > 2.0 ? Math.atan2(dx35, dz35) : nearHeading;

  let maxPathBendRad = 0;
  if (nearestIdx < path.length - 2 && idx26 > nearestIdx + 1) {
    const seg0Next = Math.min(path.length - 1, nearestIdx + 2);
    const h0 = Math.atan2(path[seg0Next].x - path[nearestIdx].x, path[seg0Next].z - path[nearestIdx].z);
    const segMidPrev = Math.max(0, idx14 - 1);
    const h14 = Math.atan2(path[idx14].x - path[segMidPrev].x, path[idx14].z - path[segMidPrev].z);
    const seg26Prev = Math.max(0, idx26 - 1);
    const h26 = Math.atan2(path[idx26].x - path[seg26Prev].x, path[idx26].z - path[seg26Prev].z);
    maxPathBendRad = Math.max(Math.abs(angleDelta(h14, h0)), Math.abs(angleDelta(h26, h0)));
  }

  const nearTurnErr = nearHeading !== null ? Math.abs(angleDelta(nearHeading, start.heading)) : 0;
  const farTurnErr = lookahead35Heading !== null ? Math.abs(angleDelta(lookahead35Heading, start.heading)) : 0;
  const turnImminent = distToPathM <= 18.0 && (nearTurnErr >= 0.20 || maxPathBendRad >= 0.38 && nearTurnErr >= 0.12);
  const turnPreparing = distToPathM <= 18.0 && !turnImminent && (maxPathBendRad >= 0.35 || farTurnErr >= 0.35);
  const turnAhead = turnImminent;

  const routeEndPoint = escapeGoal ?? path[path.length - 1];
  const goalDistFromStartM = routeEndPoint ? distance(start, routeEndPoint) : 0;

  return {
    guide,
    path,
    cumArc,
    escapeGoal,
    hasExplicitEscapeGoal,
    nearHeading,
    lookahead35Heading,
    nearTurnErr,
    farTurnErr,
    turnImminent,
    turnPreparing,
    goalDistFromStartM,
    routeEndPoint,
    startArc,
    distToPathM,
    nearestIdx,
    scanLo: Math.max(0, nearestIdx - 24),
    scanHi: Math.min(path.length - 1, nearestIdx + 140),
    turnAhead,
  };
}

function cellKeyForXY(x, z) {
  return `${Math.floor(x / VISITED_CELL_SIZE_M)}:${Math.floor(z / VISITED_CELL_SIZE_M)}`;
}

function countOldCellVisits(cellKey, visitedCells, tick) {
  if (!visitedCells?.length) return 0;
  let visits = 0;
  for (let i = 0; i < visitedCells.length; i++) {
    const entry = visitedCells[i];
    if (entry.key !== cellKey) continue;
    if (tick - entry.lastTick <= REVISIT_MIN_AGE_TICKS) {
      return 0;
    }
    visits++;
  }
  return visits;
}

export function computeCellRevisitPenalty(endPose, lookaheadHeading, visitedCells, tick, checkLookahead = true) {
  if (!visitedCells?.length || !endPose) return 0;
  const endKey = cellKeyForXY(endPose.x, endPose.z);
  let maxVisits = countOldCellVisits(endKey, visitedCells, tick);
  if (checkLookahead && Number.isFinite(lookaheadHeading)) {
    const aheadX = endPose.x + Math.sin(lookaheadHeading) * 11.0;
    const aheadZ = endPose.z + Math.cos(lookaheadHeading) * 11.0;
    const aheadKey = cellKeyForXY(aheadX, aheadZ);
    if (aheadKey !== endKey) {
      const aheadVisits = countOldCellVisits(aheadKey, visitedCells, tick);
      if (aheadVisits > maxVisits) maxVisits = aheadVisits;
    }
  }
  if (maxVisits <= 0) return 0;
  return -Math.min(30, 12 * maxVisits);
}

export function computeFarEscapeBonus({
  endPose,
  lookaheadHeading,
  referenceHeading = null,
  hasCrossRoadAhead = false,
  usesCurb = false,
  startOnRoad = true,
  roadAheadBlocked = false,
  action,
  farRouteCtx,
  pursuerPressure = null,
  suppressFullAlign = false,
}) {
  if (!farRouteCtx || !endPose || !action) return 0;
  if (action.gear !== 1 || action.brake >= 0.65) return 0;
  if (usesCurb && startOnRoad && !roadAheadBlocked && !suppressFullAlign) {
    return farRouteCtx.hasExplicitEscapeGoal ? -6.0 : 0;
  }

  const guideAlignHeading =
    farRouteCtx.turnPreparing && farRouteCtx.nearHeading !== null
      ? farRouteCtx.nearHeading
      : farRouteCtx.turnImminent && farRouteCtx.nearHeading !== null && !hasCrossRoadAhead
        ? farRouteCtx.nearHeading
        : (farRouteCtx.lookahead35Heading ?? farRouteCtx.nearHeading);

  if (Number.isFinite(referenceHeading) && guideAlignHeading !== null) {
    const refDelta = Math.abs(angleDelta(guideAlignHeading, referenceHeading));
    if (refDelta > Math.PI * 0.58) return 0;
    if (!hasCrossRoadAhead && refDelta > 0.52 && (farRouteCtx.distToPathM ?? 0) > 7.5) return 0;
  }

  let routeAdvanceTerm = 0;
  const { path, cumArc } = farRouteCtx;
  if (path && cumArc && (farRouteCtx.distToPathM ?? 0) <= 14.0) {
    let bestIdx = farRouteCtx.nearestIdx;
    let bestSq = Infinity;
    for (let i = farRouteCtx.scanLo; i <= farRouteCtx.scanHi; i++) {
      const dx = path[i].x - endPose.x;
      const dz = path[i].z - endPose.z;
      const dSq = dx * dx + dz * dz;
      if (dSq < bestSq) {
        bestSq = dSq;
        bestIdx = i;
      }
    }
    const distFromPathM = Math.sqrt(bestSq);
    const offCorridorPenalty = Math.max(0, distFromPathM - 4.2) * 1.35;
    const rawAdvanceM = cumArc[bestIdx] - farRouteCtx.startArc - offCorridorPenalty;
    routeAdvanceTerm = clamp(rawAdvanceM * 0.55, -5.0, 14.0);
  }

  let goalApproachTerm = 0;
  if (farRouteCtx.routeEndPoint && farRouteCtx.goalDistFromStartM > 1.0 && !farRouteCtx.turnPreparing) {
    const goalApproachM = farRouteCtx.goalDistFromStartM - distance(endPose, farRouteCtx.routeEndPoint);
    goalApproachTerm = clamp(goalApproachM * 0.28, -3.5, 8.0);
  }

  let lookaheadAlignTerm = 0;
  if (guideAlignHeading !== null && Number.isFinite(lookaheadHeading)) {
    const alignWeight = suppressFullAlign ? 1.8 : 5.0;
    const alignCos = Math.cos(angleDelta(lookaheadHeading, guideAlignHeading));
    lookaheadAlignTerm = clamp(alignWeight * alignCos, -2.5, alignWeight);
  }

  const total = routeAdvanceTerm + goalApproachTerm + lookaheadAlignTerm;
  if (pursuerPressure?.active && (pursuerPressure.nearestM ?? Infinity) <= 30.0) {
    return total * 0.16;
  }
  return total;
}

function computeMinForwardObstacleTtc(start, scanModel) {
  let minTtc = Infinity;
  const fwdSpeed = Math.max(1.0, Math.abs(start.speed));
  const halfCorridorW = (start.width ?? PLAYER_VEHICLE.widthM) * 0.5 + 0.85;
  const halfL = (start.length ?? PLAYER_VEHICLE.lengthM) * 0.5;

  for (let i = 0; i < PURSUIT_SCAN_RAYS; i++) {
    const pt = scanModel.rayPoints[i];
    if (!pt || pt.z <= 0 || Math.abs(pt.x) > halfCorridorW) continue;
    const gapM = Math.max(0, pt.z - halfL);
    const ttc = gapM / fwdSpeed;
    if (ttc < minTtc) minTtc = ttc;
  }
  for (let i = 0; i < scanModel.freshTracks.length; i++) {
    const tr = scanModel.freshTracks[i];
    if (tr.forwardM <= 0 || Math.abs(tr.rightM) > halfCorridorW + 0.25) continue;
    const relClose = Math.max(0.5, start.speed - (tr.motionKnown ? tr.vz : 0));
    const gapM = Math.max(0, tr.forwardM - halfL);
    const ttc = gapM / relClose;
    if (ttc < minTtc) minTtc = ttc;
  }
  return minTtc;
}

function findActiveCurbSite(pose, curb) {
  if (!curb) return null;
  if (!Array.isArray(curb.sites)) return Array.isArray(curb.courtyards) ? null : curb;
  const pts = corners(pose);
  for (let i = 0; i < curb.sites.length; i++) {
    const s = curb.sites[i];
    if (pts.some((p) => pointOnCurbSiteXY(p.x, p.z, s))) return s;
  }
  return null;
}

function snapAxisHeading(heading) {
  const sx = Math.sin(heading);
  const cz = Math.cos(heading);
  if (Math.abs(sx) >= Math.abs(cz)) return sx >= 0 ? Math.PI / 2 : -Math.PI / 2;
  return cz >= 0 ? 0 : Math.PI;
}

export function nearestLocalRoadHeading(pose, referenceHeading, roadsOrLocalGeometry) {
  const roads = Array.isArray(roadsOrLocalGeometry)
    ? roadsOrLocalGeometry
    : roadsOrLocalGeometry?.roads;
  if (!roads?.length) return snapAxisHeading(referenceHeading);

  const maxAlignRad = (55 * Math.PI) / 180;
  let bestContaining = null;
  let bestContainingCost = Infinity;
  let bestNearby = null;
  let bestNearbyCost = Infinity;

  for (let i = 0; i < roads.length; i++) {
    const r = roads[i];
    if (!r || r.parkingBay || r.supportApron) continue;
    const baseHeading =
      r.axis === "diag"
        ? (r.heading ?? Math.atan2(r.ux, r.uz))
        : r.axis === "x"
          ? Math.PI * 0.5
          : 0;
    const revHeading = Math.atan2(-Math.sin(baseHeading), -Math.cos(baseHeading));
    const dFwd = Math.abs(angleDelta(baseHeading, referenceHeading));
    const dRev = Math.abs(angleDelta(revHeading, referenceHeading));
    const angErr = dFwd <= dRev ? dFwd : dRev;
    if (angErr > maxAlignRad) continue;
    const tangentHeading = dFwd <= dRev ? baseHeading : revHeading;

    let lat = 0;
    let alongExcess = 0;
    if (r.axis === "diag") {
      const dx = pose.x - r.x1;
      const dz = pose.z - r.z1;
      const along = dx * r.ux + dz * r.uz;
      lat = Math.abs(-dx * r.uz + dz * r.ux);
      alongExcess = along < 0 ? -along : along > r.length ? along - r.length : 0;
    } else if (r.axis === "x") {
      lat = Math.abs(pose.z - r.fixed);
      alongExcess = pose.x < r.min ? r.min - pose.x : pose.x > r.max ? pose.x - r.max : 0;
    } else {
      lat = Math.abs(pose.x - r.fixed);
      alongExcess = pose.z < r.min ? r.min - pose.z : pose.z > r.max ? pose.z - r.max : 0;
    }

    const hw = (r.width ?? 8) * 0.5;
    const latExcess = Math.max(0, lat - hw);
    const edgeDist = Math.hypot(alongExcess, latExcess);
    if (edgeDist > 18.0) continue;

    if (lat <= hw + 2.6 && alongExcess <= hw + 1.0) {
      const cost = angErr * 8.0 + edgeDist * 0.5 + (lat / Math.max(1, hw)) * 0.2;
      if (cost < bestContainingCost) {
        bestContainingCost = cost;
        bestContaining = tangentHeading;
      }
    } else {
      const cost = edgeDist + angErr * 4.0;
      if (cost < bestNearbyCost) {
        bestNearbyCost = cost;
        bestNearby = tangentHeading;
      }
    }
  }

  return bestContaining ?? bestNearby ?? snapAxisHeading(referenceHeading);
}

function poseHitsStaticsFast(probe, statics, gap) {
  if (!statics.length) return false;
  const pc = Math.abs(Math.cos(probe.heading ?? 0));
  const ps = Math.abs(Math.sin(probe.heading ?? 0));
  const pw = (probe.width ?? 0) * 0.5;
  const pl = (probe.length ?? 0) * 0.5;
  const pExtX = pw * pc + pl * ps + gap + 1e-5;
  const pExtZ = pw * ps + pl * pc + gap + 1e-5;
  for (let i = 0; i < statics.length; i++) {
    const entry = statics[i];
    if (
      entry.aabbMinX !== undefined &&
      (probe.x + pExtX < entry.aabbMinX ||
        probe.x - pExtX > entry.aabbMaxX ||
        probe.z + pExtZ < entry.aabbMinZ ||
        probe.z - pExtZ > entry.aabbMaxZ)
    ) {
      continue;
    }
    if (overlaps(probe, entry.body ?? entry, gap)) return true;
  }
  return false;
}

function analyzeAsphaltAhead(originPose, egoOrigin, referenceHeading, localGeometry, scanModel) {
  const { roads, roadRects, statics } = localGeometry;
  if (!roads.length) {
    return {
      allBlocked: false,
      ownCorridorBlocked: false,
      nearestOpenShiftM: Infinity,
      nearestFullLaneShiftM: Infinity,
      oncomingClearCount: 0,
    };
  }
  const roadHeading = nearestLocalRoadHeading(originPose, referenceHeading, roads);
  const sin = Math.sin(roadHeading);
  const cos = Math.cos(roadHeading);
  const cos0 = Math.cos(egoOrigin.heading);
  const sin0 = Math.sin(egoOrigin.heading);
  const localHeading = angleDelta(roadHeading, egoOrigin.heading);
  const lpc = Math.cos(localHeading);
  const lps = Math.sin(localHeading);
  const halfW = egoOrigin.width * 0.5;
  const halfL = egoOrigin.length * 0.5;

  const offsets = [-5.2, -3.8, -2.4, -1.2, 0, 1.2, 2.4, 3.8, 5.2];
  let anyOpen = false;
  let ownHalfOpen = false;
  let leftOpen = false;
  let rightOpen = false;
  let nearestOpenShiftM = Infinity;
  let nearestFullLaneShiftM = Infinity;
  let oncomingClearCount = 0;

  for (const lat of offsets) {
    const maxDistM = Math.abs(lat) <= 2.0 ? 18.0 : 20.5;
    let laneOpen = true;
    for (let distM = 2.6; distM <= maxDistM; distM += 2.0) {
      const px = originPose.x + sin * distM + cos * lat;
      const pz = originPose.z + cos * distM - sin * lat;
      const probe = {
        x: px,
        z: pz,
        heading: roadHeading,
        width: egoOrigin.width,
        length: egoOrigin.length,
        type: egoOrigin.type,
      };
      if (!poseOnRoadFast(probe, roads, roadRects) || poseHitsStaticsFast(probe, statics, STATIC_ASPHALT_GAP_M)) {
        laneOpen = false;
        break;
      }
      const dx = px - egoOrigin.x;
      const dz = pz - egoOrigin.z;
      const lbx = dx * cos0 - dz * sin0;
      const lbz = dx * sin0 + dz * cos0;
      let hitRay = false;
      for (let i = 0; i < scanModel.hitPoints.length; i++) {
        const pt = scanModel.hitPoints[i];
        const margin = pt.kind === "pedestrian" ? PED_RAY_CORNER_MARGIN_M : 0.24;
        if (pointToBoxDistPrecomputed(pt.x, pt.z, lbx, lbz, lpc, lps, halfW, halfL) < margin) {
          hitRay = true;
          break;
        }
      }
      if (hitRay) {
        laneOpen = false;
        break;
      }
      let hitTrack = false;
      for (let i = 0; i < scanModel.freshTracks.length; i++) {
        const tr = scanModel.freshTracks[i];
        const req = tr.kind === "pedestrian" ? PED_TRACK_ACTION_MARGIN_M : VEH_TRACK_ACTION_MARGIN_M + 0.85;
        if (pointToBoxDistPrecomputed(tr.rightM, tr.forwardM, lbx, lbz, lpc, lps, halfW, halfL) < req) {
          hitTrack = true;
          break;
        }
      }
      if (hitTrack) {
        laneOpen = false;
        break;
      }
    }
    if (laneOpen) {
      anyOpen = true;
      nearestOpenShiftM = Math.min(nearestOpenShiftM, Math.abs(lat));
      if (Math.abs(lat) <= 2.0) ownHalfOpen = true;
      else {
        oncomingClearCount++;
        if (Math.abs(lat) >= 3.5) nearestFullLaneShiftM = Math.min(nearestFullLaneShiftM, Math.abs(lat));
        if (lat < -2.0) leftOpen = true;
        if (lat > 2.0) rightOpen = true;
      }
    }
  }

  return {
    allBlocked: !anyOpen,
    ownCorridorBlocked: !ownHalfOpen,
    leftOpen,
    rightOpen,
    nearestOpenShiftM,
    nearestFullLaneShiftM,
    oncomingClearCount,
  };
}

function isHeadingBlockedInMemory(pose, heading, blockedZones, tick) {
  if (!blockedZones?.length) return false;
  for (let i = 0; i < blockedZones.length; i++) {
    const bz = blockedZones[i];
    if (bz.untilTick <= tick) continue;
    if (Math.hypot(pose.x - bz.x, pose.z - bz.z) <= BLOCKED_ZONE_RADIUS_M) {
      const lim = bz.halfAngle ?? BLOCKED_ZONE_ANGLE_RAD;
      if (Math.abs(angleDelta(heading, bz.heading)) <= lim) return true;
    }
  }
  return false;
}

function recordBlockedZone(blockedZones, x, z, heading, untilTick, halfAngle = BLOCKED_ZONE_ANGLE_RAD) {
  for (let i = 0; i < blockedZones.length; i++) {
    const bz = blockedZones[i];
    if (Math.hypot(x - bz.x, z - bz.z) <= 3.5 && Math.abs(angleDelta(heading, bz.heading)) <= 0.45) {
      bz.x = x;
      bz.z = z;
      bz.heading = heading;
      bz.untilTick = Math.max(bz.untilTick, untilTick);
      bz.halfAngle = Math.max(bz.halfAngle ?? 0, halfAngle);
      return;
    }
  }
  blockedZones.push({ x, z, heading, untilTick, halfAngle });
  while (blockedZones.length > 4) blockedZones.shift();
}

function probeCorridorClearance(
  start,
  heading,
  maxDistM,
  localGeometry,
  scanModel,
  visualPoints,
  originOverride = null,
  startOnRoad = true,
) {
  const { roads, curb, roadRects, pointRoadRects, statics } = localGeometry;
  const origin = originOverride ?? start;
  const sinH = Math.sin(heading);
  const cosH = Math.cos(heading);
  const cos0 = Math.cos(start.heading);
  const sin0 = Math.sin(start.heading);
  const relH = angleDelta(heading, start.heading);
  const lpc = Math.cos(relH);
  const lps = Math.sin(relH);
  const corridorWidth = start.width + 0.50;
  const corridorHalfW = corridorWidth * 0.5;
  const baseHalfL = start.length * 0.5;

  _corridorSupportProbe.width = start.width;
  _corridorSupportProbe.length = start.length;
  _corridorSupportProbe.type = start.type;
  _corridorSupportProbe.heading = heading;

  _corridorStaticProbe.width = corridorWidth;
  _corridorStaticProbe.type = start.type;
  _corridorStaticProbe.heading = heading;

  let clearDistM = 0;
  let usesOffRoad = !startOnRoad;
  let enteredCurbEarly = !startOnRoad;
  let reachesRoadBeyondOffRoad = false;

  for (let sIdx = 0; sIdx < CORRIDOR_PROBE_DISTS.length; sIdx++) {
    const d = CORRIDOR_PROBE_DISTS[sIdx];
    if (d > maxDistM + 1e-6) break;
    const px = origin.x + sinH * d;
    const pz = origin.z + cosH * d;
    const halfLStep = d >= 20 ? Math.max(baseHalfL, 2.6) : baseHalfL;

    _corridorSupportProbe.x = px;
    _corridorSupportProbe.z = pz;
    const support = poseOnRoadOrCurb(_corridorSupportProbe, roads, curb, roadRects, pointRoadRects);
    if (!support.supported) break;

    _corridorStaticProbe.x = px;
    _corridorStaticProbe.z = pz;
    _corridorStaticProbe.length = halfLStep * 2;
    if (poseHitsStaticsFast(_corridorStaticProbe, statics, STATIC_CURB_GAP_M)) break;

    const dx = px - start.x;
    const dz = pz - start.z;
    const lbx = dx * cos0 - dz * sin0;
    const lbz = dx * sin0 + dz * cos0;
    const distFromStart = Math.hypot(lbx, lbz);
    const maxReach = Math.hypot(corridorHalfW, halfLStep) + PED_TRACK_ACTION_MARGIN_M;

    let blocked = false;
    const hitPts = scanModel.hitPoints;
    for (let i = 0; i < hitPts.length; i++) {
      const pt = hitPts[i];
      if (Math.abs(pt.rangeM - distFromStart) > maxReach) continue;
      const reqMargin = pt.kind === "pedestrian" ? PED_TRACK_ACTION_MARGIN_M : 0.22;
      if (pointToBoxDistPrecomputed(pt.x, pt.z, lbx, lbz, lpc, lps, corridorHalfW, halfLStep) < reqMargin) {
        blocked = true;
        break;
      }
    }
    if (blocked) break;

    const tracks = scanModel.freshTracks;
    for (let i = 0; i < tracks.length; i++) {
      const tr = tracks[i];
      const reqMargin = tr.kind === "pedestrian" ? PED_TRACK_ACTION_MARGIN_M : 0.22;
      if (pointToBoxDistPrecomputed(tr.rightM, tr.forwardM, lbx, lbz, lpc, lps, corridorHalfW, halfLStep) < reqMargin) {
        blocked = true;
        break;
      }
      if (tr.kind === "pedestrian" && tr.motionKnown) {
        const tProj = Math.min(1.0, d / Math.max(4.0, Math.abs(start.speed) + 3.0));
        if (
          pointToBoxDistPrecomputed(
            tr.rightM + tr.vx * tProj,
            tr.forwardM + tr.vz * tProj,
            lbx,
            lbz,
            lpc,
            lps,
            corridorHalfW,
            halfLStep,
          ) < PED_TRACK_ACTION_MARGIN_M
        ) {
          blocked = true;
          break;
        }
      }
    }
    if (blocked) break;

    for (let i = 0; i < visualPoints.length; i++) {
      if (pointToBoxDistance(visualPoints[i].x, visualPoints[i].z, _corridorSupportProbe) < VISUAL_PERSON_MARGIN_M) {
        blocked = true;
        break;
      }
    }
    if (blocked) break;

    clearDistM = d;
    if (support.usesCurb) {
      usesOffRoad = true;
      if (d <= 12.0) enteredCurbEarly = true;
    }
    const centerOnRoad =
      pointRoadRects.length > 0 || localGeometry.diagRoads?.length > 0
        ? pointOnRoadRects(px, pz, pointRoadRects, localGeometry.diagRoads, false, 0)
        : roads.length > 0 && pointOnRoad({ x: px, z: pz }, roads);
    if (centerOnRoad && ((!startOnRoad && d >= 5.2) || (enteredCurbEarly && d >= 12.0))) {
      reachesRoadBeyondOffRoad = true;
    }
  }

  return { clearDistM, usesOffRoad, reachesRoadBeyondOffRoad };
}

function findAlleyShortcutGuide(
  start,
  referenceHeading,
  routeHeading,
  startOnRoad,
  curbBypassGuide,
  asphalt,
  localGeometry,
  scanModel,
  visualPoints,
  blockedZones,
  tick,
  crowdDivertUrgent = false,
  continuingAlley = false,
  pursuerPressure = null,
  hasCrossRoadAhead = false,
  losBuildings = null,
) {
  const { curb, pointRoadRects } = localGeometry;
  if (!curb?.courtyards?.length) return null;
  if (curbBypassGuide?.mandatoryRejoin) return null;

  const activeSite = findActiveCurbSite(start, curb);
  const inCourtyardNow = !startOnRoad && !activeSite && pointOnCurbXY(start.x, start.z, curb);
  let crossingSidewalkIntoAlley = continuingAlley && !startOnRoad;
  if (!startOnRoad && activeSite && !crossingSidewalkIntoAlley) {
    let siteAlign;
    if (activeSite.axis === "diag") {
      siteAlign = Math.abs(Math.sin(start.heading) * activeSite.ux + Math.cos(start.heading) * activeSite.uz);
    } else {
      const siteAlongX = activeSite.axis
        ? activeSite.axis === "x"
        : activeSite.maxX - activeSite.minX >= activeSite.maxZ - activeSite.minZ;
      siteAlign = Math.abs(siteAlongX ? Math.sin(start.heading) : Math.cos(start.heading));
    }
    crossingSidewalkIntoAlley = siteAlign < 0.72;
  }

  const streetAxisHeading = nearestLocalRoadHeading(start, referenceHeading, localGeometry.roads);
  const axisSin = Math.sin(streetAxisHeading);
  const axisCos = Math.cos(streetAxisHeading);
  const ahead14OnRoad =
    (pointRoadRects.length > 0 || localGeometry.diagRoads?.length > 0) &&
    pointOnRoadRects(
      start.x + axisSin * 14.0,
      start.z + axisCos * 14.0,
      pointRoadRects,
      localGeometry.diagRoads,
      false,
      0,
    );
  const frontConeMin = Math.min(
    scanModel.rays[70].rangeM,
    scanModel.rays[71].rangeM,
    scanModel.rays[0].rangeM,
    scanModel.rays[1].rangeM,
    scanModel.rays[2].rangeM,
  );
  const roadAheadBlockedOrEnding =
    crowdDivertUrgent ||
    asphalt.allBlocked ||
    !ahead14OnRoad ||
    (asphalt.ownCorridorBlocked && frontConeMin < 11.0);

  const losAlleyUrgent =
    Boolean(pursuerPressure?.active) &&
    Number.isFinite(pursuerPressure.dominantWorldBearing) &&
    !hasCrossRoadAhead &&
    !curbBypassGuide &&
    (pursuerPressure.rearPursuer || pursuerPressure.nearestM <= 30.0);
  const losAlleyOnly = !inCourtyardNow && !crossingSidewalkIntoAlley && !roadAheadBlockedOrEnding && losAlleyUrgent;

  if (!inCourtyardNow && !crossingSidewalkIntoAlley && !losAlleyOnly) {
    if (!roadAheadBlockedOrEnding) return null;
    const routeWantsCrossBlock =
      routeHeading !== null && Math.abs(angleDelta(routeHeading, streetAxisHeading)) >= 0.65;
    if (curbBypassGuide && !routeWantsCrossBlock) return null;
    if (!asphalt.allBlocked && ahead14OnRoad && !routeWantsCrossBlock && !crowdDivertUrgent) return null;
  }

  const buildings = losAlleyOnly ? (losBuildings ?? collectNearbyLosBuildings(localGeometry, start)) : null;
  const pursuerDist = losAlleyOnly ? Math.max(pursuerPressure.nearestM ?? 18, 18.0) : 0;
  const pursuerX = losAlleyOnly ? start.x + Math.sin(pursuerPressure.dominantWorldBearing) * pursuerDist : 0;
  const pursuerZ = losAlleyOnly ? start.z + Math.cos(pursuerPressure.dominantWorldBearing) * pursuerDist : 0;

  const maxScanRad = (115 * Math.PI) / 180;
  const stepRad = (10 * Math.PI) / 180;
  const candidates = [];
  for (let deg = -115; deg <= 115; deg += 10) {
    candidates.push(start.heading + (deg * Math.PI) / 180);
  }
  for (const cardinal of [0, Math.PI * 0.5, -Math.PI * 0.5, Math.PI]) {
    if (Math.abs(angleDelta(cardinal, start.heading)) <= maxScanRad + 0.05) {
      candidates.push(cardinal);
    }
  }
  if (routeHeading !== null && Math.abs(angleDelta(routeHeading, start.heading)) <= maxScanRad + 0.05) {
    candidates.push(routeHeading);
  }

  let best = null;
  for (let i = 0; i < candidates.length; i++) {
    const candHeading = candidates[i];
    if (isHeadingBlockedInMemory(start, candHeading, blockedZones, tick)) continue;
    if (losAlleyOnly && Math.abs(angleDelta(candHeading, streetAxisHeading)) < 0.48) continue;
    const probe = probeCorridorClearance(
      start,
      candHeading,
      35.0,
      localGeometry,
      scanModel,
      visualPoints,
      null,
      startOnRoad,
    );
    if (inCourtyardNow || crossingSidewalkIntoAlley) {
      if (probe.clearDistM < 11.5 && !probe.reachesRoadBeyondOffRoad) continue;
    } else if (losAlleyOnly) {
      if (!probe.usesOffRoad || probe.clearDistM < 15.5) continue;
      if (!probe.reachesRoadBeyondOffRoad && probe.clearDistM < 20.0) continue;
    } else {
      if (!probe.usesOffRoad || probe.clearDistM < 15.0) continue;
      if (!probe.reachesRoadBeyondOffRoad && probe.clearDistM < 22.0) continue;
    }

    let losShielded = false;
    if (losAlleyOnly) {
      const losRay = evaluateLosEscapeRay(
        start.x,
        start.z,
        candHeading,
        start,
        localGeometry,
        scanModel,
        visualPoints,
        true,
      );
      if (losRay.pedHazard || losRay.clearForwardM < 14.0) continue;
      const escX = start.x + Math.sin(candHeading) * 14.0;
      const escZ = start.z + Math.cos(candHeading) * 14.0;
      for (let bIdx = 0; bIdx < buildings.length; bIdx++) {
        const bldg = buildings[bIdx];
        if (segmentIntersectsOrientedBox(pursuerX, pursuerZ, start.x, start.z, bldg, 0)) continue;
        if (segmentIntersectsOrientedBox(pursuerX, pursuerZ, escX, escZ, bldg, 0.05)) {
          losShielded = true;
          break;
        }
      }
      if (!losShielded) continue;
    }

    const cone = coneStats(scanModel, start.heading, candHeading, start.width * 0.5 + 0.36);
    let score = 0.65 * probe.clearDistM + 0.25 * Math.min(30, cone.blendedM);
    if (probe.reachesRoadBeyondOffRoad) score += 10.0;
    if (probe.clearDistM >= 22.0) score += 3.0;
    if (losShielded) score += 14.0;
    score +=
      3.2 * Math.cos(angleDelta(candHeading, referenceHeading)) +
      1.8 * Math.cos(angleDelta(candHeading, start.heading));
    if (routeHeading !== null) {
      score += 4.5 * Math.cos(angleDelta(candHeading, routeHeading));
    }
    if (!best || score > best.score) {
      best = {
        heading: candHeading,
        clearDistM: probe.clearDistM,
        reachesRoadBeyondOffRoad: probe.reachesRoadBeyondOffRoad,
        losShielded,
        score,
        stepRad,
      };
    }
  }

  if (!best) return null;
  const targetHeading = best.heading;
  const guideHeading = start.heading + clamp(angleDelta(targetHeading, start.heading), -0.95, 0.95);
  const desiredSteer = clamp(angleDelta(guideHeading, start.heading) * 2.1, -1.0, 1.0);
  return {
    desiredSteer,
    guideHeading,
    targetHeading,
    clearDistM: best.clearDistM,
    reachesRoadBeyondOffRoad: best.reachesRoadBeyondOffRoad,
    losShielded: Boolean(best.losShielded),
    isAlley: true,
  };
}

function minSectorRange(scanModel, startIdx, endIdx) {
  let minR = PURSUIT_SCAN_RANGE_M;
  for (let i = startIdx; i <= endIdx; i++) {
    const r = scanModel.rays[i % PURSUIT_SCAN_RAYS].rangeM;
    if (r < minR) minR = r;
  }
  return minR;
}

function findOpenEscapeCorridor(
  start,
  routeHeading,
  startOnRoad,
  onCurbNow,
  pingPongOscillation,
  localGeometry,
  scanModel,
  visualPoints,
  blockedZones,
  tick,
) {
  const { roads, curb, roadRects, pointRoadRects, statics } = localGeometry;
  let rearMinRangeM = PURSUIT_SCAN_RANGE_M;
  for (let i = 34; i <= 38; i++) rearMinRangeM = Math.min(rearMinRangeM, scanModel.rays[i].rangeM);
  const rawBackupM = clamp(rearMinRangeM - start.length * 0.5 - 0.35, 0, 2.2);
  const sin0 = Math.sin(start.heading);
  const cos0 = Math.cos(start.heading);

  let pivotOrigin = start;
  for (const frac of [1.0, 0.5]) {
    const dBack = rawBackupM * frac;
    if (dBack < 0.25) break;
    const candidateOrigin = {
      x: start.x - sin0 * dBack,
      z: start.z - cos0 * dBack,
      heading: start.heading,
      width: start.width,
      length: start.length,
      type: start.type,
    };
    if (
      poseOnRoadOrCurb(candidateOrigin, roads, curb, roadRects, pointRoadRects).supported &&
      !poseHitsStaticsFast(candidateOrigin, statics, STATIC_CURB_GAP_M)
    ) {
      pivotOrigin = candidateOrigin;
      break;
    }
  }

  const asphaltFromPivot = analyzeAsphaltAhead(pivotOrigin, start, start.heading, localGeometry, scanModel);
  const rearRightClearM = minSectorRange(scanModel, 25, 34);
  const rearLeftClearM = minSectorRange(scanModel, 38, 47);
  const roadAxisHeading = nearestLocalRoadHeading(pivotOrigin, start.heading, roads);

  let bestHeading = start.heading + Math.PI * 0.5;
  let bestScore = -Infinity;

  for (let k = 0; k < 36; k++) {
    const candHeading = start.heading + (k * Math.PI) / 18;
    const probe = probeCorridorClearance(
      start,
      candHeading,
      30.0,
      localGeometry,
      scanModel,
      visualPoints,
      pivotOrigin,
      startOnRoad,
    );
    const cone = coneStats(scanModel, start.heading, candHeading, start.width * 0.5 + 0.36);

    let reachesRoadOrAlley = false;
    if (probe.reachesRoadBeyondOffRoad) {
      reachesRoadOrAlley = true;
    } else if (probe.clearDistM >= 11.5) {
      const checkD = Math.min(probe.clearDistM, 15.5);
      const rx = pivotOrigin.x + Math.sin(candHeading) * checkD;
      const rz = pivotOrigin.z + Math.cos(candHeading) * checkD;
      const onRd =
        pointRoadRects.length > 0 || localGeometry.diagRoads?.length > 0
          ? pointOnRoadRects(rx, rz, pointRoadRects, localGeometry.diagRoads, false, 0)
          : roads.length > 0 && pointOnRoad({ x: rx, z: rz }, roads);
      if (onRd || (probe.usesOffRoad && probe.clearDistM >= 15.5)) {
        reachesRoadOrAlley = true;
      }
    }

    let score = 0.72 * probe.clearDistM + 0.24 * Math.min(30, cone.blendedM);
    if (reachesRoadOrAlley) score += 10.0;
    if (isHeadingBlockedInMemory(start, candHeading, blockedZones, tick)) {
      score -= 25.0;
    }

    // Reward S-bypass into an open adjacent lane on the same street when only ego's lane is blocked.
    if (!pingPongOscillation && !asphaltFromPivot.allBlocked && probe.clearDistM >= 8.0) {
      const relToRoad = angleDelta(candHeading, roadAxisHeading);
      if (asphaltFromPivot.leftOpen && relToRoad <= -0.38 && relToRoad >= -0.95) {
        score += 18.0;
      }
      if (asphaltFromPivot.rightOpen && relToRoad >= 0.38 && relToRoad <= 0.95) {
        score += 18.0;
      }
    }

    const turnDelta = angleDelta(candHeading, start.heading);
    const turnNeeded = Math.abs(turnDelta);
    score -= 4.5 * (turnNeeded / Math.PI);

    const candTurnSign = Math.sign(turnDelta);
    if (candTurnSign !== 0) {
      if (turnNeeded > 1.25) {
        const midHeading = start.heading + candTurnSign * Math.min(0.85, turnNeeded * 0.55);
        const midProbe = probeCorridorClearance(
          start,
          midHeading,
          11.5,
          localGeometry,
          scanModel,
          visualPoints,
          pivotOrigin,
          startOnRoad,
        );
        if (midProbe.clearDistM < 8.0) {
          score -= 14.0;
        }
      }
      // turnSign > 0 (nose right) uses steer < 0 in reverse, swinging the tail left (sector 38..47);
      // turnSign < 0 (nose left) uses steer > 0 in reverse, swinging the tail right (sector 25..34).
      const tailSwingClearM = candTurnSign > 0 ? rearLeftClearM : rearRightClearM;
      score += 0.35 * Math.min(12.0, tailSwingClearM);
      if (tailSwingClearM < 4.8) score -= 7.5;
    }

    if (routeHeading !== null) {
      score += 4.0 * Math.cos(angleDelta(candHeading, routeHeading));
    }

    if (score > bestScore) {
      bestScore = score;
      bestHeading = candHeading;
    }
  }

  const turnSign =
    Math.sign(angleDelta(bestHeading, start.heading)) ||
    chooseReverseTurnSign(scanModel, routeHeading, start, roads, onCurbNow);

  return {
    targetHeading: bestHeading,
    turnSign,
    allForwardLanesBlocked: asphaltFromPivot.allBlocked,
  };
}

function findClearCurbBypassGuide(
  start,
  playerCurbSupportId,
  referenceHeading,
  localGeometry,
  scanModel,
  visualPoints,
  precomputedAsphalt = null,
) {
  const { curb, roads, roadRects, pointRoadRects, statics } = localGeometry;
  if (!curb) return null;
  if (Array.isArray(curb.sites) && curb.sites.length === 0) return null;
  const onCurbNow = (roads.length > 0 && !poseOnRoadFast(start, roads, roadRects)) || Boolean(playerCurbSupportId);
  const asphalt = precomputedAsphalt ?? analyzeAsphaltAhead(start, start, referenceHeading, localGeometry, scanModel);
  if (!onCurbNow && !asphalt.allBlocked && !asphalt.ownCorridorBlocked) return null;

  const sites = Array.isArray(curb.sites) ? curb.sites : Array.isArray(curb.courtyards) ? [] : [curb];
  const startPts = corners(start);
  const cos0 = Math.cos(start.heading);
  const sin0 = Math.sin(start.heading);
  const policeInOwnCorridor = scanModel.freshTracks.some(
    (tr) => tr.kind === "police" && tr.forwardM > 0 && tr.forwardM < 20 && Math.abs(tr.rightM) < 2.2,
  );
  let best = null;

  for (const site of sites) {
    const isDiag = site.axis === "diag";
    const alongX = !isDiag && (site.axis ? site.axis === "x" : site.maxX - site.minX >= site.maxZ - site.minZ);
    const axisForward = isDiag
      ? Math.sin(referenceHeading) * site.ux + Math.cos(referenceHeading) * site.uz
      : alongX
        ? Math.sin(referenceHeading)
        : Math.cos(referenceHeading);
    if (Math.abs(axisForward) < 0.65) continue;
    const forwardSign = Math.sign(axisForward) || 1;
    const axisHeading = isDiag
      ? Math.atan2(forwardSign * site.ux, forwardSign * site.uz)
      : alongX
        ? forwardSign * (Math.PI / 2)
        : forwardSign > 0
          ? 0
          : Math.PI;
    const side = site.side ?? 1;
    const edge = site.edge ?? site.edgeZ ?? (alongX ? site.minZ : site.minX);
    const ribbonCross = edge + side * 0.98;
    const siteAlongAt = (px, pz) =>
      isDiag ? (px - site.x1) * site.ux + (pz - site.z1) * site.uz : alongX ? px : pz;
    const siteCrossAt = (px, pz) =>
      isDiag ? -(px - site.x1) * site.uz + (pz - site.z1) * site.ux : alongX ? pz : px;
    const siteWorldX = (alongPos, crossPos) =>
      isDiag ? site.x1 + alongPos * site.ux - crossPos * site.uz : alongX ? alongPos : crossPos;
    const siteWorldZ = (alongPos, crossPos) =>
      isDiag ? site.z1 + alongPos * site.uz + crossPos * site.ux : alongX ? crossPos : alongPos;

    const startAlong = siteAlongAt(start.x, start.z);
    const startCross = siteCrossAt(start.x, start.z);
    const crossDist = Math.abs(startCross - ribbonCross);
    if (crossDist > 11.5) continue;

    const egoOnThisSite =
      onCurbNow &&
      ((playerCurbSupportId === site.id && crossDist <= 2.6) ||
        startPts.some(
          (p) => pointOnCurbSiteXY(p.x, p.z, site) && (siteCrossAt(p.x, p.z) - edge) * side > 0.02,
        ));

    // Proactive curb bypass when own [-2.6, +2.6] m corridor is blocked: only take an adjacent
    // near-side curb (crossDist <= 5.3 m) when it is closer or more open than crossing oncoming lanes.
    if (!onCurbNow && !asphalt.allBlocked) {
      const adjacentCurb = crossDist <= 5.3 || Math.abs(startCross - edge) <= 4.35;
      const effectiveShiftM = policeInOwnCorridor
        ? Math.min(asphalt.nearestFullLaneShiftM ?? Infinity, Math.max(asphalt.nearestOpenShiftM, 3.4))
        : asphalt.nearestOpenShiftM;
      const closerOrMoreOpen =
        crossDist <= effectiveShiftM + 1.55 || asphalt.oncomingClearCount <= 1;
      if (!adjacentCurb || !closerOrMoreOpen) continue;
    }

    const minAlong = isDiag ? site.alongMin : alongX ? site.minX : site.minZ;
    const maxAlong = isDiag ? site.alongMax : alongX ? site.maxX : site.maxZ;
    const remAlong = forwardSign > 0 ? maxAlong - startAlong : startAlong - minAlong;
    const mandatoryEndRejoin = egoOnThisSite && remAlong < 8.5 && remAlong > -2.5;

    if (!mandatoryEndRejoin) {
      if (remAlong < 5.0) continue;

      let clear = true;
      const entryDist = egoOnThisSite ? 1.8 : Math.max(2.5, Math.min(9, crossDist * 1.6));
      const desiredEnd = Math.min(22, entryDist + 12);
      const checkEnd = egoOnThisSite ? Math.min(desiredEnd, Math.max(entryDist, remAlong - 2.3)) : desiredEnd;
      for (let d = entryDist; d <= checkEnd; d += 1.8) {
        const alongPos = startAlong + forwardSign * d;
        if (alongPos < minAlong + 2.2 || alongPos > maxAlong - 2.2) {
          clear = false;
          break;
        }
        const wx = siteWorldX(alongPos, ribbonCross);
        const wz = siteWorldZ(alongPos, ribbonCross);
        const probe = {
          x: wx,
          z: wz,
          heading: axisHeading,
          width: start.width,
          length: start.length,
          type: start.type,
        };
        if (!poseOnRoadOrCurb(probe, roads, curb, roadRects, pointRoadRects).supported) {
          clear = false;
          break;
        }
        if (poseHitsStaticsFast(probe, statics, STATIC_CURB_GAP_M)) {
          clear = false;
          break;
        }
        const dx = wx - start.x;
        const dz = wz - start.z;
        const localProbe = {
          x: dx * cos0 - dz * sin0,
          z: dx * sin0 + dz * cos0,
          heading: angleDelta(axisHeading, start.heading),
          width: start.width,
          length: start.length,
        };
        for (let i = 0; i < PURSUIT_SCAN_RAYS; i++) {
          const pt = scanModel.rayPoints[i];
          if (!pt) continue;
          const margin = pt.kind === "pedestrian" ? PED_TRACK_ACTION_MARGIN_M : RAY_MARGIN_M + 0.08;
          if (pointToBoxDistance(pt.x, pt.z, localProbe) < margin) {
            clear = false;
            break;
          }
        }
        if (!clear) break;
        for (let i = 0; i < scanModel.pedRays.length; i++) {
          if (pointToBoxDistance(scanModel.pedRays[i].x, scanModel.pedRays[i].z, localProbe) < PED_TRACK_ACTION_MARGIN_M) {
            clear = false;
            break;
          }
        }
        if (!clear) break;
        for (let i = 0; i < scanModel.freshTracks.length; i++) {
          const tr = scanModel.freshTracks[i];
          const margin = tr.kind === "pedestrian" ? PED_TRACK_ACTION_MARGIN_M + 0.15 : VEH_TRACK_ACTION_MARGIN_M;
          if (pointToBoxDistance(tr.rightM, tr.forwardM, localProbe) < margin) {
            clear = false;
            break;
          }
        }
        if (!clear) break;
        if (visualPoints.some((vp) => pointToBoxDistance(vp.x, vp.z, probe) < VISUAL_PERSON_MARGIN_M)) {
          clear = false;
          break;
        }
      }
      if (!clear) continue;
    }

    // Check if asphalt ahead of current position is clear so we can rejoin (or mandatory rejoin at curb end)!
    const roadCenterCross = edge - side * 3.0;
    const nearLeadM = mandatoryEndRejoin ? Math.max(0.8, Math.min(2.0, remAlong * 0.35)) : 1.2;
    const farLeadM = mandatoryEndRejoin ? Math.max(2.6, Math.min(4.8, Math.max(2.6, remAlong))) : 4.5;
    const roadAheadAlong = startAlong + forwardSign * farLeadM;
    const rejoinStartProbe = {
      x: siteWorldX(startAlong + forwardSign * nearLeadM, roadCenterCross),
      z: siteWorldZ(startAlong + forwardSign * nearLeadM, roadCenterCross),
      heading: axisHeading,
      width: start.width,
      length: start.length,
      type: start.type,
    };
    const rejoinProbe = {
      x: siteWorldX(roadAheadAlong, roadCenterCross),
      z: siteWorldZ(roadAheadAlong, roadCenterCross),
      heading: axisHeading,
      width: start.width,
      length: start.length,
      type: start.type,
    };

    let mandatorySpotSafe = false;
    if (
      mandatoryEndRejoin &&
      poseOnRoadFast(rejoinProbe, roads, roadRects) &&
      !poseHitsStaticsFast(rejoinStartProbe, statics, STATIC_ASPHALT_GAP_M) &&
      !poseHitsStaticsFast(rejoinProbe, statics, STATIC_ASPHALT_GAP_M)
    ) {
      const rDx = rejoinProbe.x - start.x;
      const rDz = rejoinProbe.z - start.z;
      const localRejoin = {
        x: rDx * cos0 - rDz * sin0,
        z: rDz * cos0 + rDx * sin0,
        heading: angleDelta(axisHeading, start.heading),
        width: start.width,
        length: start.length,
      };
      const pedConflict =
        scanModel.pedRays.some((pr) => pointToBoxDistance(pr.x, pr.z, localRejoin) < PED_TRACK_ACTION_MARGIN_M) ||
        scanModel.freshTracks.some(
          (tr) => tr.kind === "pedestrian" && pointToBoxDistance(tr.rightM, tr.forwardM, localRejoin) < PED_TRACK_ACTION_MARGIN_M,
        ) ||
        visualPoints.some((vp) => pointToBoxDistance(vp.x, vp.z, rejoinProbe) < VISUAL_PERSON_MARGIN_M);
      const vehConflict =
        scanModel.rayPoints.some(
          (pt) => pt && pt.kind !== "pedestrian" && pointToBoxDistance(pt.x, pt.z, localRejoin) < RAY_MARGIN_M,
        ) ||
        scanModel.freshTracks.some(
          (tr) => tr.kind !== "pedestrian" && pointToBoxDistance(tr.rightM, tr.forwardM, localRejoin) < VEH_TRACK_STOP_MARGIN_M,
        );
      mandatorySpotSafe = !pedConflict && !vehConflict;
    }

    const probeSupportedAndClear = (alongPos, crossPos, probeHeading = axisHeading) => {
      const wx = siteWorldX(alongPos, crossPos);
      const wz = siteWorldZ(alongPos, crossPos);
      const probe = {
        x: wx,
        z: wz,
        heading: probeHeading,
        width: start.width,
        length: start.length,
        type: start.type,
      };
      const support = poseOnRoadOrCurb(probe, roads, curb, roadRects, pointRoadRects);
      if (!support.supported) return false;
      const staticGap = support.usesCurb ? STATIC_CURB_GAP_M : STATIC_ASPHALT_GAP_M;
      if (poseHitsStaticsFast(probe, statics, staticGap)) return false;
      const pDx = wx - start.x;
      const pDz = wz - start.z;
      const localProbe = {
        x: pDx * cos0 - pDz * sin0,
        z: pDx * sin0 + pDz * cos0,
        heading: angleDelta(probeHeading, start.heading),
        width: start.width,
        length: start.length,
      };
      for (let i = 0; i < PURSUIT_SCAN_RAYS; i++) {
        const pt = scanModel.rayPoints[i];
        if (!pt) continue;
        const margin = pt.kind === "pedestrian" ? PED_TRACK_ACTION_MARGIN_M : RAY_MARGIN_M + 0.04;
        if (pointToBoxDistance(pt.x, pt.z, localProbe) < margin) return false;
      }
      for (let i = 0; i < scanModel.pedRays.length; i++) {
        if (pointToBoxDistance(scanModel.pedRays[i].x, scanModel.pedRays[i].z, localProbe) < PED_TRACK_ACTION_MARGIN_M) {
          return false;
        }
      }
      for (let i = 0; i < scanModel.freshTracks.length; i++) {
        const tr = scanModel.freshTracks[i];
        const margin = tr.kind === "pedestrian" ? PED_TRACK_ACTION_MARGIN_M + 0.10 : VEH_TRACK_STOP_MARGIN_M;
        if (pointToBoxDistance(tr.rightM, tr.forwardM, localProbe) < margin) return false;
      }
      if (visualPoints.some((vp) => pointToBoxDistance(vp.x, vp.z, probe) < VISUAL_PERSON_MARGIN_M)) {
        return false;
      }
      return true;
    };

    let intersectionThroughCross = null;
    if (mandatoryEndRejoin && !mandatorySpotSafe) {
      const endAlong = forwardSign > 0 ? maxAlong : minAlong;
      for (const candidateCross of [ribbonCross, edge + side * 0.45, edge - side * 1.2]) {
        if (
          !probeSupportedAndClear(startAlong + forwardSign * 2.5, candidateCross) ||
          !probeSupportedAndClear(startAlong + forwardSign * 5.0, candidateCross)
        ) {
          continue;
        }
        const crossStreetOrBeyondOpen =
          remAlong <= 5.0 ||
          probeSupportedAndClear(endAlong + forwardSign * 2.2, candidateCross) ||
          probeSupportedAndClear(endAlong + forwardSign * 2.2, edge - side * 1.5) ||
          probeSupportedAndClear(startAlong + forwardSign * Math.min(7.5, Math.max(5.5, remAlong + 1.5)), roadCenterCross);
        if (crossStreetOrBeyondOpen) {
          intersectionThroughCross = candidateCross;
          break;
        }
      }
      if (intersectionThroughCross === null) continue;
    }

    const canRejoinNow =
      mandatorySpotSafe ||
      (onCurbNow &&
        intersectionThroughCross === null &&
        poseOnRoadFast(rejoinProbe, roads, roadRects) &&
        !poseHitsStaticsFast(rejoinStartProbe, statics, STATIC_ASPHALT_GAP_M + 0.3) &&
        !poseHitsStaticsFast(rejoinProbe, statics, STATIC_ASPHALT_GAP_M + 0.3) &&
        !analyzeAsphaltAhead(rejoinProbe, start, axisHeading, localGeometry, scanModel).ownCorridorBlocked);

    let targetCross = canRejoinNow ? roadCenterCross : ribbonCross;
    let rejoiningGuide = canRejoinNow;
    if (intersectionThroughCross !== null) {
      const beyondAlong = startAlong + forwardSign * Math.max(5.2, remAlong + 2.4);
      if (probeSupportedAndClear(startAlong + forwardSign * 4.6, edge - side * 1.6)) {
        targetCross = edge - side * 1.6;
        rejoiningGuide = true;
      } else if (probeSupportedAndClear(beyondAlong, roadCenterCross) || probeSupportedAndClear(beyondAlong, edge - side * 1.6)) {
        targetCross = intersectionThroughCross - side * 0.45;
      } else {
        targetCross = intersectionThroughCross;
      }
    }
    const lookaheadM =
      intersectionThroughCross !== null
        ? clamp(Math.abs(start.speed) * 0.62, 4.4, 5.8)
        : mandatoryEndRejoin
          ? clamp(Math.abs(start.speed) * 0.58, 2.6, 4.8)
          : clamp(Math.abs(start.speed) * 0.62, 3.4, 5.8);
    const targetAlong = startAlong + forwardSign * lookaheadM;
    const tx = siteWorldX(targetAlong, targetCross);
    const tz = siteWorldZ(targetAlong, targetCross);
    const rawHeading = Math.atan2(tx - start.x, tz - start.z);
    const maxLeadAngle = mandatoryEndRejoin ? 0.64 : 0.52;
    const guideHeading = axisHeading + clamp(angleDelta(rawHeading, axisHeading), -maxLeadAngle, maxLeadAngle);
    const desiredSteer = clamp(angleDelta(guideHeading, start.heading) * (mandatoryEndRejoin ? 2.5 : 2.2), -0.92, 0.92);

    if (!best || (mandatoryEndRejoin && !best.mandatoryRejoin) || crossDist < best.crossDist) {
      best = {
        site,
        crossDist,
        guideHeading,
        desiredSteer,
        axisHeading,
        targetCross,
        alongX,
        rejoining: rejoiningGuide,
        mandatoryRejoin: mandatoryEndRejoin,
      };
    }
  }

  return best;
}

function assessTrajectory(ctx, action, allowCurb, options = null) {
  const { start, cos0, sin0, localGeometry, scanModel, visualPoints, requestedAction, routeHeading, startOnRoad } = ctx;
  const curb = allowCurb ? localGeometry.curb : null;
  const rawCurb = localGeometry.rawCurb;
  const hasCityCurb = Array.isArray(rawCurb?.sites) || Array.isArray(rawCurb?.courtyards);
  const curbMaxPace = rawCurb ? (rawCurb.maxPace ?? (hasCityCurb ? 14.0 : 2.8)) : 2.8;
  const curbMaxYaw = rawCurb ? (rawCurb.maxYawRate ?? (hasCityCurb ? 3.6 : 0.35)) : 0.35;

  const actionTicks =
    options?.actionTicks ?? (action.gear === -1 ? ACTION_TICKS_REVERSE : ACTION_TICKS_FORWARD);
  const brakeAction = { steer: action.steer, throttle: 0, brake: 1, gear: action.gear };

  const spec = ctx.spec;
  const maxSpeedCmd = start.maxSpeed ?? 9.72;
  const maxSpeedPlant = start.maxSpeed ?? 13.89;
  let pose = {
    x: start.x,
    z: start.z,
    heading: start.heading,
    steer: start.steer,
    speed: start.speed,
    spec,
    gtaSlipMps: start.gtaSlipMps ?? 0,
    gtaYawRate: start.gtaYawRate ?? 0,
    type: start.type,
    radius: start.radius,
    length: start.length,
    width: start.width,
  };
  let nextBuf = { ...pose };
  const lastCheckedPose = { ...pose };
  let actionPose = pose;
  let midActionPose = pose;
  let actionLocalX = 0;
  let actionLocalZ = 0;
  let usesCurb = false;
  let minClearanceM = Infinity;
  let minPedGapM = ctx.pedProximity?.nearestM ?? Infinity;
  let travelM = 0;
  let stopped = false;

  const midActionTick = Math.max(1, Math.floor(actionTicks * 0.5));
  const startPedInFront65 = (ctx.pedProximity?.nearestForwardCorridorM ?? Infinity) <= 6.5;

  const nSurf = scanModel.surfacePoints.length;
  if (_scratchSurfaceA.length < nSurf) _scratchSurfaceA = new Float64Array(nSurf + 64);
  const prevSurfaceDists = _scratchSurfaceA;
  for (let i = 0; i < nSurf; i++) {
    prevSurfaceDists[i] = scanModel.surfacePoints[i].initialBoxDist;
  }
  const nTrk = scanModel.freshTracks.length;
  if (_scratchTrackA.length < nTrk) _scratchTrackA = new Float64Array(nTrk + 32);
  const prevTrackDists = _scratchTrackA;
  for (let i = 0; i < nTrk; i++) {
    prevTrackDists[i] = scanModel.freshTracks[i].initialGap;
  }

  for (let tick = 1; tick <= actionTicks + MAX_STOP_TICKS; tick++) {
    const inActionWindow = tick <= actionTicks;
    const stepAction = inActionWindow ? action : brakeAction;
    let curbCap = 0;
    if (
      inActionWindow &&
      stepAction.brake === 0 &&
      curb &&
      (Boolean(ctx.playerCurbSupportId) || !poseOnRoadFast(pose, localGeometry.roads, localGeometry.roadRects)) &&
      Math.hypot(pose.speed, pose.gtaSlipMps) <= curbMaxPace + 1e-6
    ) {
      curbCap =
        startPedInFront65 && Math.hypot(pose.speed, pose.gtaSlipMps) <= 3.8
          ? Math.min(curbMaxPace, 3.4)
          : curbMaxPace;
    }

    const next = stepPursuitPoseInto(pose, nextBuf, stepAction, STEP, spec, maxSpeedCmd, maxSpeedPlant, curbCap);

    if (inActionWindow) travelM += Math.hypot(next.x - pose.x, next.z - pose.z);
    if (tick === midActionTick) midActionPose = { ...next };
    if (tick === actionTicks) actionPose = { ...next };

    const settled =
      !inActionWindow &&
      Math.abs(next.speed) < 0.03 &&
      Math.abs(next.gtaSlipMps) < 0.03;
    const shouldCheck = inActionWindow || settled || (tick - actionTicks) % 3 === 0 || tick === actionTicks + MAX_STOP_TICKS;

    if (shouldCheck) {
      const swept = sweepSegmentSupportAndStatics(
        lastCheckedPose,
        next,
        localGeometry.roads,
        curb,
        localGeometry.statics,
        inActionWindow ? 0.12 : 0.22,
        localGeometry.roadRects,
        localGeometry.pointRoadRects,
      );
      if (!swept.ok) return { feasible: false, rejectReason: swept.reason, usesCurb: usesCurb || swept.usesCurb };
      usesCurb ||= swept.usesCurb;

      if (swept.endUsesCurb && inActionWindow) {
        const pace = Math.hypot(next.speed, next.gtaSlipMps ?? 0);
        if (pace > curbMaxPace + 1e-6 || Math.abs(next.gtaYawRate ?? 0) > curbMaxYaw + 1e-6)
          return { feasible: false, rejectReason: "curb-speed", usesCurb: true };
      }

      const dx = next.x - start.x;
      const dz = next.z - start.z;
      _localBox.x = dx * cos0 - dz * sin0;
      _localBox.z = dx * sin0 + dz * cos0;
      _localBox.heading = next.heading - start.heading;
      _localBox.width = next.width;
      _localBox.length = next.length;
      if (tick === actionTicks) {
        actionLocalX = _localBox.x;
        actionLocalZ = _localBox.z;
      }

      const sheddingOppositeSpeed =
        start.speed * action.gear < 0 && (pose.speed * start.speed > 0 || next.speed * start.speed > 0);
      const rayCheck = checkRayClearance(
        _localBox,
        scanModel,
        inActionWindow,
        prevSurfaceDists,
        sheddingOppositeSpeed,
        tick === actionTicks,
        action.gear,
      );
      if (!rayCheck.ok) return { feasible: false, rejectReason: rayCheck.reason, usesCurb };
      if (rayCheck.clearance < minClearanceM) minClearanceM = rayCheck.clearance;

      const t = tick * STEP;
      const pedMargin = inActionWindow ? PED_TRACK_ACTION_MARGIN_M : PED_TRACK_STOP_MARGIN_M;
      const vehMargin = inActionWindow ? VEH_TRACK_ACTION_MARGIN_M : VEH_TRACK_STOP_MARGIN_M;
      const direction = action.gear;
      const lc = Math.cos(_localBox.heading);
      const ls = Math.sin(_localBox.heading);
      const hw = _localBox.width * 0.5;
      const hl = _localBox.length * 0.5;

      if (inActionWindow) {
        for (let i = 0; i < scanModel.pedRays.length; i++) {
          const pr = scanModel.pedRays[i];
          const pDist = pointToBoxDistPrecomputed(pr.x, pr.z, _localBox.x, _localBox.z, lc, ls, hw, hl);
          if (pDist < minPedGapM) minPedGapM = pDist;
        }
      }

      for (let i = 0; i < nTrk; i++) {
        const tr = scanModel.freshTracks[i];
        const alreadyCloseNonPed = tr.kind !== "pedestrian" && tr.initialGap < VEH_TRACK_ACTION_MARGIN_M;
        const isRearFollower = tr.kind !== "pedestrian" && direction * tr.forwardM < 0 && direction * tr.vz > 0;
        const suppressMotion = isRearFollower || alreadyCloseNonPed;
        const vxRel = suppressMotion ? 0 : tr.vx;
        const vzRel = suppressMotion ? 0 : tr.vz;
        const tProj = tr.kind === "pedestrian" ? t : Math.min(t, tr.forecastConfirmed ? 1.2 : 0.45);
        const tx = tr.rightM + vxRel * tProj;
        const tz = tr.forwardM + vzRel * tProj;
        const boxDist = pointToBoxDistPrecomputed(tx, tz, _localBox.x, _localBox.z, lc, ls, hw, hl);
        if (inActionWindow && tr.kind === "pedestrian" && boxDist < minPedGapM) {
          minPedGapM = boxDist;
        }

        const reqMargin = tr.kind === "pedestrian" ? pedMargin : vehMargin;
        if (tr.kind !== "pedestrian" && tr.initialGap < reqMargin) {
          const startGap = tr.initialGap;
          const prevDist = prevTrackDists[i];
          let stepOk;
          if (sheddingOppositeSpeed) {
            stepOk = boxDist >= startGap - 0.012;
          } else if (startGap > 0.0005 && prevDist <= 0) {
            stepOk = boxDist >= prevDist - 1e-6;
          } else if (startGap > 0.0005) {
            const floor = Math.max(0, Math.min(prevDist - 0.004, startGap - 0.005));
            stepOk = boxDist > 0 && boxDist >= floor;
          } else {
            const floor = Math.max(startGap - 0.002, Math.min(prevDist - 0.004, startGap - 0.002));
            stepOk = boxDist >= floor;
          }
          if (stepOk && tick === actionTicks && startGap < 0.04 && Math.abs(tr.rightM) <= start.width / 2 - 0.08) {
            const onDrivenBumper = direction > 0 ? tr.forwardM >= start.length / 2 - 0.04 : tr.forwardM <= -start.length / 2 + 0.04;
            if (onDrivenBumper && boxDist < startGap - 1e-5) {
              stepOk = false;
            }
          }
          if (!stepOk) {
            return { feasible: false, rejectReason: `${tr.kind}-clearance`, usesCurb };
          }
          prevTrackDists[i] = boxDist;
          const cl = boxDist > 0.01 ? boxDist : 0.01;
          if (cl < minClearanceM) minClearanceM = cl;
        } else {
          const gap = boxDist - reqMargin;
          if (gap < 0) return { feasible: false, rejectReason: `${tr.kind}-clearance`, usesCurb };
          prevTrackDists[i] = boxDist;
          if (gap < minClearanceM) minClearanceM = gap;
        }
      }

      for (let i = 0; i < visualPoints.length; i++) {
        const vp = visualPoints[i];
        const rawVDist = pointToBoxDistance(vp.x, vp.z, next);
        if (inActionWindow && rawVDist < minPedGapM) minPedGapM = rawVDist;
        const vGap = rawVDist - VISUAL_PERSON_MARGIN_M;
        if (vGap < 0) return { feasible: false, rejectReason: "visual-person-clearance", usesCurb };
        if (vGap < minClearanceM) minClearanceM = vGap;
      }

      lastCheckedPose.x = next.x;
      lastCheckedPose.z = next.z;
      lastCheckedPose.heading = next.heading;
    }

    nextBuf = pose;
    pose = next;
    if (settled) {
      stopped = true;
      break;
    }
  }

  if (!stopped) return { feasible: false, rejectReason: "no-stopping-envelope", usesCurb };
  if (
    lowSpeedForwardRolloutBlocked(
      ctx,
      action,
      actionPose,
      allowCurb,
      prevSurfaceDists,
      prevTrackDists,
      options?.minRolloutSpeed ?? 2.8,
    )
  )
    return { feasible: false, rejectReason: "blocked-front-arc", usesCurb };

  if (action.gear === -1) {
    let rearMin = PURSUIT_SCAN_RANGE_M;
    for (let i = 33; i <= 39; i++) rearMin = Math.min(rearMin, scanModel.rays[i].rangeM);
    const minRearGap = actionTicks < ACTION_TICKS_REVERSE ? 0.20 : 0.30;
    if (rearMin < start.length / 2 + minRearGap || (start.speed <= 0.05 && actionPose.speed > -0.04))
      return { feasible: false, rejectReason: "rear-blocked", usesCurb };
  }

  const maxSteer = start.spec?.maxSteer ?? VEHICLE.maxSteer;
  const forwardSpeed = Math.max(0, start.speed);
  const lowSpeedPreview =
    action.gear === 1
      ? (1 - Math.min(1, forwardSpeed / 3.5)) * action.steer * maxSteer * 0.65
      : 0;
  const lookaheadHeading =
    action.gear === 1
      ? actionPose.heading + clamp(angleDelta(pose.heading, actionPose.heading), -0.45, 0.45) + lowSpeedPreview
      : pose.heading;

  const cone = coneStats(scanModel, start.heading, lookaheadHeading, start.width / 2 + 0.36);
  const directConeM = options?.computeDirectCone
    ? coneStats(scanModel, start.heading, actionPose.heading, start.width / 2 + 0.36).meanM
    : cone.meanM;
  const alleyGuide = ctx.alleyShortcutGuide;
  const curbGuide = alleyGuide ? null : ctx.curbBypassGuide;
  const approachesCurb =
    action.gear === 1 &&
    (lookaheadApproachesCurb(actionPose, lookaheadHeading, localGeometry.roads, curb, localGeometry.pointRoadRects) ||
      Boolean(curbGuide && !curbGuide.rejoining) ||
      Boolean(alleyGuide));

  if (
    approachesCurb &&
    !usesCurb &&
    action.brake === 0 &&
    Math.hypot(actionPose.speed, actionPose.gtaSlipMps ?? 0) > curbMaxPace - 0.20
  ) {
    return { feasible: false, rejectReason: "curb-approach-speed", usesCurb: false };
  }

  let threatBonus = 0;
  const actionTime = actionTicks * STEP;
  for (let i = 0; i < scanModel.freshTracks.length; i++) {
    const tr = scanModel.freshTracks[i];
    if (tr.kind !== "police" && tr.kind !== "pedestrian") continue;
    if (tr.rangeM > 22 || tr.rangeM < 1e-3) continue;
    const isRearFollower = tr.kind !== "pedestrian" && action.gear * tr.forwardM < 0 && action.gear * tr.vz > 0;
    const tx = tr.rightM + (isRearFollower ? 0 : tr.vx * actionTime);
    const tz = tr.forwardM + (isRearFollower ? 0 : tr.vz * actionTime);
    const d1 = Math.hypot(tx - actionLocalX, tz - actionLocalZ);
    const weight = (tr.kind === "pedestrian" ? 2.4 : 1.6) * (1 - tr.rangeM / 24);
    threatBonus += weight * (d1 - tr.rangeM);
  }
  threatBonus = clamp(threatBonus, -3.5, 3.5);

  const referenceHeading =
    alleyGuide && !ctx.activeEscape ? alleyGuide.targetHeading : (ctx.referenceForwardHeading ?? start.heading);
  const routeDelta = routeHeading !== null ? Math.abs(angleDelta(routeHeading, referenceHeading)) : Infinity;
  const routeUsable =
    routeDelta <= Math.PI * 0.56 && (routeDelta <= 0.45 || ctx.hasCrossRoadAhead || Boolean(alleyGuide));
  const routeBonus =
    routeUsable ? 4.2 * Math.cos(angleDelta(lookaheadHeading, routeHeading)) : 0;
  const cosForward = Math.cos(angleDelta(lookaheadHeading, referenceHeading));
  const progressionBonus = 2.6 * cosForward - 8.5 * Math.max(0, -cosForward);
  const fidelityBonus = -0.8 * Math.abs(action.steer - requestedAction.steer);

  const wideOpenOffRoadBypass =
    usesCurb && !curbGuide && Boolean(ctx.roadAheadBlocked) && cone.corridorMinM >= 15.0;
  const suppressAsphaltBias = Boolean(alleyGuide) || wideOpenOffRoadBypass;

  const trafficOrPoliceAhead = scanModel.freshTracks.some(
    (t) =>
      (t.kind === "police" || t.kind === "civilian") &&
      t.forwardM > 0 &&
      t.forwardM < 18 &&
      Math.abs(t.rightM) < 3.2,
  );
  const baseCurbPenalty = trafficOrPoliceAhead ? -0.75 : -1.8;
  let curbOffset = suppressAsphaltBias
    ? 0
    : usesCurb
      ? baseCurbPenalty
      : approachesCurb && !curbGuide
        ? baseCurbPenalty * 0.5
        : 0;
  if (!suppressAsphaltBias && !startOnRoad && usesCurb) {
    if (poseOnRoadFast(pose, localGeometry.roads, localGeometry.roadRects)) curbOffset += Math.abs(baseCurbPenalty) * 0.75;
    if (poseOnRoadFast(actionPose, localGeometry.roads, localGeometry.roadRects)) curbOffset += Math.abs(baseCurbPenalty) * 0.25;
  }

  let minStaticGapM = 4.0;
  if (usesCurb || Boolean(alleyGuide) || Boolean(curbGuide) || !startOnRoad) {
    minStaticGapM = Math.min(
      minBoxGapToStatics(start, localGeometry.statics, 4.0),
      minBoxGapToStatics(midActionPose, localGeometry.statics, 4.0),
      minBoxGapToStatics(actionPose, localGeometry.statics, 4.0),
    );
  }
  const pedWithin65 = (ctx.pedProximity?.nearestM ?? Infinity) <= 6.5 || minPedGapM <= 6.5;
  const pedInFront65 = (ctx.pedProximity?.nearestForwardCorridorM ?? Infinity) <= 6.5 || minPedGapM <= 2.2;
  const wideClearCurbOrAlley =
    (Boolean(alleyGuide) || Boolean(ctx.pursuerPressure?.active)) &&
    !pedWithin65 &&
    minPedGapM >= 3.5 &&
    minStaticGapM >= 1.1;
  const curbSpeedCap = pedInFront65
    ? Math.min(curbMaxPace, 3.2)
    : pedWithin65
      ? Math.min(curbMaxPace, 5.6)
      : wideClearCurbOrAlley
        ? Math.min(curbMaxPace - 0.5, 13.2)
        : Math.min(curbMaxPace - 0.5, 7.4);

  let curbGuideBonus = 0;
  if (alleyGuide && action.gear === 1) {
    const steerDiff = Math.abs(action.steer - alleyGuide.desiredSteer);
    const alignBonus = 4.0 * Math.cos(angleDelta(lookaheadHeading, alleyGuide.guideHeading));
    const alleyPedCautionPenalty =
      pedWithin65 && actionPose.speed > curbSpeedCap && action.brake === 0
        ? (actionPose.speed - curbSpeedCap) * 3.4
        : 0;
    const alleyBriskPaceBonus =
      wideClearCurbOrAlley && action.brake === 0 ? 0.28 * Math.min(actionPose.speed, curbSpeedCap) : 0;
    curbGuideBonus = 16.0 - 14.0 * steerDiff + alignBonus + alleyBriskPaceBonus - alleyPedCautionPenalty;
  } else if (wideOpenOffRoadBypass && action.gear === 1) {
    curbGuideBonus = 6.0 + (wideClearCurbOrAlley && action.brake === 0 ? 0.24 * Math.min(actionPose.speed, curbSpeedCap) : 0);
  } else if (curbGuide && action.gear === 1) {
    const steerDiff = Math.abs(action.steer - curbGuide.desiredSteer);
    const gs = curbGuide.site;
    const actualCross =
      gs?.axis === "diag"
        ? -(actionPose.x - gs.x1) * gs.uz + (actionPose.z - gs.z1) * gs.ux
        : curbGuide.alongX
          ? actionPose.z
          : actionPose.x;
    const weight = curbGuide.mandatoryRejoin ? 24.0 : 18.0;
    const slope = curbGuide.mandatoryRejoin ? 20.0 : 16.0;
    const overCruisePenalty =
      !startOnRoad && !curbGuide.rejoining && actionPose.speed > curbSpeedCap && action.brake === 0
        ? (actionPose.speed - curbSpeedCap) * 2.8
        : 0;
    curbGuideBonus =
      weight - slope * steerDiff - 0.9 * Math.abs(actualCross - curbGuide.targetCross) - overCruisePenalty;
  } else if (usesCurb && curb && !poseOnRoadFast(pose, localGeometry.roads, localGeometry.roadRects)) {
    const site = findActiveCurbSite(actionPose, curb) ?? findActiveCurbSite(pose, curb);
    if (site) {
      const isDiag = site.axis === "diag";
      const alongX = !isDiag && (site.axis ? site.axis === "x" : site.maxX - site.minX >= site.maxZ - site.minZ);
      const side = site.side ?? 1;
      const edge = site.edge ?? site.edgeZ ?? (alongX ? site.minZ : site.minX);
      const idealCross = edge + side * 0.94;
      const actualCross = isDiag
        ? -(actionPose.x - site.x1) * site.uz + (actionPose.z - site.z1) * site.ux
        : alongX
          ? actionPose.z
          : actionPose.x;
      const axisDot = isDiag
        ? Math.sin(referenceHeading) * site.ux + Math.cos(referenceHeading) * site.uz
        : alongX
          ? Math.sin(referenceHeading)
          : Math.cos(referenceHeading);
      const forwardSign = Math.sign(axisDot) || 1;
      const axisHeading = isDiag
        ? Math.atan2(forwardSign * site.ux, forwardSign * site.uz)
        : alongX
          ? forwardSign * (Math.PI / 2)
          : forwardSign > 0
            ? 0
            : Math.PI;
      curbGuideBonus =
        -0.65 * Math.abs(actualCross - idealCross) +
        0.75 * Math.cos(angleDelta(lookaheadHeading, axisHeading));
    } else if (wideClearCurbOrAlley && action.gear === 1 && action.brake === 0) {
      curbGuideBonus = 0.25 * Math.min(actionPose.speed, curbSpeedCap);
    }
    if (pedWithin65 && action.gear === 1 && actionPose.speed > curbSpeedCap && action.brake === 0) {
      curbGuideBonus -= (actionPose.speed - curbSpeedCap) * 3.2;
    }
  }

  let roadStayBonus = 0;
  if (!suppressAsphaltBias && !usesCurb && !curbGuide && localGeometry.roads.length) {
    const ls = Math.sin(lookaheadHeading);
    const lc = Math.cos(lookaheadHeading);
    let stayDist = 18;
    for (let d = 5; d <= 18; d += 3.25) {
      const probe = {
        x: actionPose.x + ls * d,
        z: actionPose.z + lc * d,
        heading: lookaheadHeading,
        width: start.width,
        length: start.length,
        type: start.type,
      };
      if (
        !poseOnRoadFast(probe, localGeometry.roads, localGeometry.roadRects) ||
        poseHitsStaticsFast(probe, localGeometry.statics, STATIC_ASPHALT_GAP_M)
      ) {
        stayDist = d - 3.25;
        break;
      }
    }
    roadStayBonus = 0.22 * stayDist;
  }

  let escapeMemoryBonus = 0;
  if (action.gear === 1) {
    if (ctx.activeEscape) {
      escapeMemoryBonus += 12.0 * Math.cos(angleDelta(lookaheadHeading, ctx.activeEscape.targetHeading));
    }
    if (isHeadingBlockedInMemory(start, lookaheadHeading, ctx.blockedZones, ctx.tick)) {
      escapeMemoryBonus -= 18.0;
    }
  }

  const rawLosBreakBonus =
    action.gear === 1 && ctx.pursuerPressure?.active && travelM >= 0.25
      ? computeLosBreakBonus({
          player: start,
          actionPose,
          endPose: pose,
          action,
          spec,
          pursuerPressure: ctx.pursuerPressure,
          localGeometry,
          scanModel,
          visualPoints,
          allowCurb,
          alleyGuide,
          hasCrossRoadAhead: Boolean(ctx.hasCrossRoadAhead),
          losBuildings: ctx.losBuildings,
        })
      : 0;
  const losGoal = ctx.farRouteCtx?.escapeGoal;
  const losGoalAlign =
    losGoal && rawLosBreakBonus > 0
      ? Math.cos(angleDelta(lookaheadHeading, Math.atan2(losGoal.x - start.x, losGoal.z - start.z)))
      : 0;
  const losBreakBonus =
    rawLosBreakBonus > 0 && losGoal
      ? rawLosBreakBonus * (losGoalAlign >= -0.1 ? 1.15 : 0.35)
      : rawLosBreakBonus;

  const revisitPenalty =
    action.gear === 1 && !ctx.activeEscape
      ? computeCellRevisitPenalty(
          pose,
          lookaheadHeading,
          ctx.visitedCells,
          ctx.tick,
          travelM >= 0.4 && Boolean(ctx.hasCrossRoadAhead),
        )
      : 0;

  const farEscapeBonus =
    action.gear === 1 && !ctx.activeEscape && !ctx.crowdYieldActive && !ctx.inLosBreakCommit
      ? computeFarEscapeBonus({
          endPose: pose,
          lookaheadHeading,
          referenceHeading,
          hasCrossRoadAhead: Boolean(ctx.hasCrossRoadAhead),
          usesCurb,
          startOnRoad,
          roadAheadBlocked: Boolean(ctx.roadAheadBlocked),
          action,
          farRouteCtx: ctx.farRouteCtx,
          pursuerPressure: ctx.pursuerPressure,
          suppressFullAlign: Boolean(alleyGuide || curbGuide || ctx.asphaltAhead?.ownCorridorBlocked),
        })
      : 0;

  let smoothSteerBonus = 0;
  if (
    action.gear === 1 &&
    action.brake < 0.65 &&
    startOnRoad &&
    !usesCurb &&
    !curbGuide &&
    !alleyGuide &&
    !ctx.activeEscape &&
    !ctx.asphaltAhead?.ownCorridorBlocked &&
    !ctx.roadAheadBlocked &&
    (ctx.minObstacleTtc ?? Infinity) > 2.2 &&
    minPedGapM > 4.5 &&
    (ctx.pedProximity?.nearestM ?? Infinity) > 4.5
  ) {
    if (losBreakBonus < 8) {
      const continuityWeight = ctx.farRouteCtx?.turnAhead ? 0.75 : 2.4;
      smoothSteerBonus = -continuityWeight * Math.abs(action.steer - (ctx.prevSteerCmd ?? 0));
    } else if (ctx.inLosBreakCommit && ctx.lastLosBreakSign !== 0 && action.steer * ctx.lastLosBreakSign < 0) {
      smoothSteerBonus = -2.4 * Math.abs(action.steer - (ctx.prevSteerCmd ?? 0));
    }
  }

  const effectiveConeM =
    (routeUsable && ctx.hasCrossRoadAhead && routeDelta >= 0.30) || Boolean(ctx.farRouteCtx?.turnAhead)
      ? Math.min(cone.blendedM, 24) + 0.12 * Math.max(0, cone.blendedM - 24)
      : cone.blendedM;

  const paceBonus = 0.45 * travelM + 0.55 * (action.brake === 0 ? action.throttle : -action.brake);
  const score =
    0.36 * effectiveConeM +
    progressionBonus +
    routeBonus +
    farEscapeBonus +
    revisitPenalty +
    smoothSteerBonus +
    threatBonus +
    fidelityBonus +
    curbOffset +
    curbGuideBonus +
    roadStayBonus +
    escapeMemoryBonus +
    losBreakBonus +
    paceBonus;

  return {
    feasible: true,
    rejectReason: null,
    usesCurb,
    minClearanceM,
    minPedGapM,
    minStaticGapM,
    curbSpeedCap,
    losBreakBonus,
    farEscapeBonus,
    revisitPenalty,
    travelM,
    openConeM: cone.meanM,
    corridorMinM: cone.corridorMinM,
    directConeM,
    endPose: pose,
    endHeading: pose.heading,
    actionHeading: actionPose.heading,
    actionSpeed: actionPose.speed,
    score,
  };
}

function averageSectorRange(scanModel, startIdx, endIdx) {
  let sum = 0;
  let count = 0;
  for (let i = startIdx; i <= endIdx; i++) {
    sum += scanModel.rays[i % PURSUIT_SCAN_RAYS].rangeM;
    count++;
  }
  return count ? sum / count : 0;
}

function chooseReverseTurnSign(scanModel, routeHeading, start, roads, onCurbNow = false) {
  if (onCurbNow && roads?.length) {
    const c = Math.cos(start.heading);
    const s = Math.sin(start.heading);
    let rightRoad = 0;
    let leftRoad = 0;
    for (const d of [2.0, 3.8, 5.6]) {
      if (pointOnRoad({ x: start.x + c * d, z: start.z - s * d }, roads)) rightRoad++;
      if (pointOnRoad({ x: start.x - c * d, z: start.z + s * d }, roads)) leftRoad++;
    }
    if (rightRoad !== leftRoad) return rightRoad > leftRoad ? 1 : -1;
  }
  const rightOpen = averageSectorRange(scanModel, 4, 18);
  const leftOpen = averageSectorRange(scanModel, 54, 68);
  if (Math.abs(rightOpen - leftOpen) >= 0.75) return rightOpen >= leftOpen ? 1 : -1;
  if (roads?.length) {
    const c = Math.cos(start.heading);
    const s = Math.sin(start.heading);
    let rightRoad = 0;
    let leftRoad = 0;
    for (const d of [2.5, 4.5, 6.5]) {
      if (pointOnRoad({ x: start.x + c * d, z: start.z - s * d }, roads)) rightRoad++;
      if (pointOnRoad({ x: start.x - c * d, z: start.z + s * d }, roads)) leftRoad++;
    }
    if (rightRoad !== leftRoad) return rightRoad > leftRoad ? 1 : -1;
  }
  if (routeHeading !== null) {
    const delta = angleDelta(routeHeading, start.heading);
    if (Math.abs(delta) > 0.05) return delta > 0 ? 1 : -1;
  }
  return rightOpen >= leftOpen ? 1 : -1;
}

function bestDecelerationSteer(scanModel, start, requestedAction) {
  const maxSteer = start.spec?.maxSteer ?? VEHICLE.maxSteer;
  let bestSteer = 0;
  let bestScore = -Infinity;
  for (const steer of FORWARD_STEERS) {
    const heading = start.heading + steer * maxSteer * 1.1;
    const cone = coneStats(scanModel, start.heading, heading);
    let pedPenalty = 0;
    for (const tr of scanModel.freshTracks) {
      if (tr.kind !== "pedestrian" || tr.rangeM > 18) continue;
      const pedHeading = start.heading + Math.atan2(tr.rightM, tr.forwardM);
      if (Math.abs(angleDelta(heading, pedHeading)) < 0.45) pedPenalty += 30;
    }
    const score = cone.blendedM - pedPenalty - 0.8 * Math.abs(steer - requestedAction.steer);
    if (score > bestScore) {
      bestScore = score;
      bestSteer = steer;
    }
  }
  return bestSteer;
}

function analyzeRoadOpenIgnoringPedestrians(originPose, egoOrigin, roadHeading, localGeometry, scanModel) {
  const { roads, roadRects, statics } = localGeometry;
  if (!roads.length) return false;
  const sin = Math.sin(roadHeading);
  const cos = Math.cos(roadHeading);
  const cos0 = Math.cos(egoOrigin.heading);
  const sin0 = Math.sin(egoOrigin.heading);
  const localHeading = angleDelta(roadHeading, egoOrigin.heading);
  const lpc = Math.cos(localHeading);
  const lps = Math.sin(localHeading);
  const halfW = egoOrigin.width * 0.5;
  const halfL = egoOrigin.length * 0.5;
  const offsets = [-5.2, -3.8, -2.4, -1.2, 0, 1.2, 2.4, 3.8, 5.2];

  for (const lat of offsets) {
    const maxDistM = Math.abs(lat) <= 2.4 ? 18.0 : 20.5;
    let laneOpen = true;
    for (let distM = 2.6; distM <= maxDistM; distM += 2.0) {
      const px = originPose.x + sin * distM + cos * lat;
      const pz = originPose.z + cos * distM - sin * lat;
      const probe = {
        x: px,
        z: pz,
        heading: roadHeading,
        width: egoOrigin.width,
        length: egoOrigin.length,
        type: egoOrigin.type,
      };
      if (!poseOnRoadFast(probe, roads, roadRects) || poseHitsStaticsFast(probe, statics, STATIC_ASPHALT_GAP_M)) {
        laneOpen = false;
        break;
      }
      const dx = px - egoOrigin.x;
      const dz = pz - egoOrigin.z;
      const lbx = dx * cos0 - dz * sin0;
      const lbz = dx * sin0 + dz * cos0;
      for (let i = 0; i < scanModel.hitPoints.length; i++) {
        const pt = scanModel.hitPoints[i];
        if (pt.kind === "pedestrian") continue;
        if (pointToBoxDistPrecomputed(pt.x, pt.z, lbx, lbz, lpc, lps, halfW, halfL) < 0.24) {
          laneOpen = false;
          break;
        }
      }
      if (!laneOpen) break;
      for (let i = 0; i < scanModel.freshTracks.length; i++) {
        const tr = scanModel.freshTracks[i];
        if (tr.kind === "pedestrian") continue;
        if (
          pointToBoxDistPrecomputed(tr.rightM, tr.forwardM, lbx, lbz, lpc, lps, halfW, halfL) <
          VEH_TRACK_ACTION_MARGIN_M + 0.85
        ) {
          laneOpen = false;
          break;
        }
      }
      if (!laneOpen) break;
    }
    if (laneOpen) return true;
  }
  return false;
}

function detectCrowdContext(
  start,
  localRoadHeading,
  routeHeading,
  hasCrossRoadAhead,
  asphaltAhead,
  localGeometry,
  scanModel,
  visualPoints,
  visualState,
  escapeState,
  tick,
) {
  let nearestPoliceM = Infinity;
  let policeClosingClose = false;
  for (let i = 0; i < scanModel.freshTracks.length; i++) {
    const tr = scanModel.freshTracks[i];
    if (tr.kind !== "police") continue;
    if (tr.rangeM < nearestPoliceM) nearestPoliceM = tr.rangeM;
    if (tr.rangeM <= 9.5 && (!tr.motionKnown || tr.closingMps > 0.35 || tr.rangeM <= 7.0)) {
      policeClosingClose = true;
    }
  }
  for (let i = 0; i < PURSUIT_SCAN_RAYS; i++) {
    const pt = scanModel.rayPoints[i];
    if (!pt || pt.kind !== "police") continue;
    if (pt.rangeM < nearestPoliceM) nearestPoliceM = pt.rangeM;
    if (pt.rangeM <= 7.5) policeClosingClose = true;
  }

  let frontNonPedBumperM = PURSUIT_SCAN_RANGE_M;
  for (const idx of [70, 71, 0, 1, 2]) {
    const ray = scanModel.rays[idx];
    if (ray.kind !== "none" && ray.kind !== "pedestrian") {
      frontNonPedBumperM = Math.min(frontNonPedBumperM, ray.rangeM - start.length * 0.5);
    }
  }

  const pedClusters = [];
  let nearestPedForwardM = Infinity;
  const addCluster = (rx, fz, vx = 0) => {
    if (!Number.isFinite(rx) || !Number.isFinite(fz)) return;
    if (fz < -0.6 || fz > 14.0) return;
    if (Math.abs(rx) > 5.8 && Math.abs(rx + vx * 1.2) > 5.2) return;
    if (fz >= 0 && Math.abs(rx) <= 4.6 && fz < nearestPedForwardM) {
      nearestPedForwardM = fz;
    }
    for (let i = 0; i < pedClusters.length; i++) {
      if (Math.hypot(rx - pedClusters[i].rx, fz - pedClusters[i].fz) < 0.85) return;
    }
    pedClusters.push({ rx, fz, vx });
  };

  for (let i = 0; i < scanModel.freshTracks.length; i++) {
    const tr = scanModel.freshTracks[i];
    if (tr.kind === "pedestrian") addCluster(tr.rightM, tr.forwardM, tr.vx);
  }
  for (let i = 0; i < scanModel.pedRays.length; i++) {
    const pr = scanModel.pedRays[i];
    addCluster(pr.x, pr.z, 0);
  }
  if (visualPoints.length > 0) {
    const c0 = Math.cos(start.heading);
    const s0 = Math.sin(start.heading);
    if (Array.isArray(visualState?.forecasts)) {
      for (const item of visualState.forecasts) {
        if (!item || (item.label && item.label !== "person") || item.qualified === false) continue;
        if (Array.isArray(item.points) && item.points.length > 0) {
          const pt0 = item.points[0];
          const wx = pt0?.x ?? pt0?.xM;
          const wz = pt0?.z ?? pt0?.zM;
          if (Number.isFinite(wx) && Number.isFinite(wz)) {
            const dx = wx - start.x;
            const dz = wz - start.z;
            addCluster(dx * c0 - dz * s0, dx * s0 + dz * c0, 0);
          }
        } else if (Number.isFinite(item.lateralM) && Number.isFinite(item.longitudinalM)) {
          addCluster(item.lateralM, item.longitudinalM, Number.isFinite(item.lateralSpeedMps) ? item.lateralSpeedMps : 0);
        }
      }
    }
  }

  const openMainRoad =
    frontNonPedBumperM >= 2.2 &&
    (pedClusters.length >= 2 || (pedClusters.length >= 1 && tick <= (escapeState.crowdWaveUntilTick ?? -1))) &&
    (analyzeRoadOpenIgnoringPedestrians(start, start, localRoadHeading, localGeometry, scanModel) ||
      (hasCrossRoadAhead &&
        routeHeading !== null &&
        analyzeRoadOpenIgnoringPedestrians(start, start, routeHeading, localGeometry, scanModel)));

  if (openMainRoad && pedClusters.length >= 2) {
    escapeState.crowdWaveUntilTick = tick + 150;
  }

  const crowdBlockingCorridor =
    asphaltAhead.allBlocked || asphaltAhead.ownCorridorBlocked || nearestPedForwardM <= 12.5;
  const crowdAhead = Boolean(
    openMainRoad &&
      crowdBlockingCorridor &&
      (pedClusters.length >= 2 || (pedClusters.length >= 1 && tick <= (escapeState.crowdWaveUntilTick ?? -1))),
  );
  const crowdYieldActive = crowdAhead && !policeClosingClose && nearestPoliceM > 9.5;
  const crowdDivertUrgent = crowdAhead && (policeClosingClose || nearestPoliceM <= 9.5);

  return {
    crowdAhead,
    crowdYieldActive,
    crowdDivertUrgent,
    nearestPoliceM,
    nearestPedForwardM,
    pedCount: pedClusters.length,
    pedClusters,
  };
}

function bestCrowdWaitSteer(scanModel, visualPoints, start, localRoadHeading, localGeometry, requestedAction) {
  const maxSteer = start.spec?.maxSteer ?? VEHICLE.maxSteer;
  const waitSteers = [-0.72, -0.48, -0.25, 0, 0.25, 0.48, 0.72];
  const c0 = Math.cos(start.heading);
  const s0 = Math.sin(start.heading);
  let bestSteer = 0;
  let bestScore = -Infinity;

  for (const steer of waitSteers) {
    const aimHeading = start.heading + steer * maxSteer * 0.85;
    const rel = aimHeading - start.heading;
    const rc = Math.cos(rel);
    const rs = Math.sin(rel);
    const sinA = Math.sin(aimHeading);
    const cosA = Math.cos(aimHeading);

    let onRoadAhead = true;
    if (localGeometry.roads.length > 0) {
      for (const d of [4.5, 8.5]) {
        const probe = {
          x: start.x + sinA * d,
          z: start.z + cosA * d,
          heading: aimHeading,
          width: start.width,
          length: start.length,
          type: start.type,
        };
        if (
          !poseOnRoadFast(probe, localGeometry.roads, localGeometry.roadRects) ||
          poseHitsStaticsFast(probe, localGeometry.statics, STATIC_ASPHALT_GAP_M)
        ) {
          onRoadAhead = false;
          break;
        }
      }
    }
    if (!onRoadAhead && steer !== 0) continue;

    let minLatPedClear = 5.5;
    for (let i = 0; i < scanModel.freshTracks.length; i++) {
      const tr = scanModel.freshTracks[i];
      if (tr.kind !== "pedestrian" || tr.rangeM > 15) continue;
      for (const t of [0, 0.7]) {
        const px = tr.rightM + tr.vx * t;
        const pz = tr.forwardM + tr.vz * t;
        const f = px * rs + pz * rc;
        const r = Math.abs(px * rc - pz * rs);
        if (f > 0 && f <= 14.5) minLatPedClear = Math.min(minLatPedClear, r);
      }
    }
    for (let i = 0; i < scanModel.pedRays.length; i++) {
      const pr = scanModel.pedRays[i];
      const f = pr.x * rs + pr.z * rc;
      const r = Math.abs(pr.x * rc - pr.z * rs);
      if (f > 0 && f <= 14.5) minLatPedClear = Math.min(minLatPedClear, r);
    }
    for (let i = 0; i < visualPoints.length; i++) {
      const dx = visualPoints[i].x - start.x;
      const dz = visualPoints[i].z - start.z;
      const lx = dx * c0 - dz * s0;
      const lz = dx * s0 + dz * c0;
      const f = lx * rs + lz * rc;
      const r = Math.abs(lx * rc - lz * rs);
      if (f > 0 && f <= 14.5) minLatPedClear = Math.min(minLatPedClear, r);
    }

    const cone = coneStats(scanModel, start.heading, aimHeading);
    const roadAlign = Math.cos(angleDelta(aimHeading, localRoadHeading));
    const currentNormSteer = clamp(start.steer / Math.max(0.1, maxSteer), -1, 1);
    const score =
      (onRoadAhead ? 4.0 : -6.0) +
      2.6 * minLatPedClear +
      0.28 * cone.blendedM +
      2.4 * roadAlign -
      0.45 * Math.abs(steer - currentNormSteer) -
      0.20 * Math.abs(steer - requestedAction.steer);

    if (score > bestScore) {
      bestScore = score;
      bestSteer = steer;
    }
  }
  return bestSteer;
}

export function planPakoEvasiveAction(world, requestedAction) {
  validatePursuitAction(requestedAction);
  if (world.pursuit?.phase && world.pursuit.phase !== "running") {
    return {
      action: makeAction(requestedAction.steer, requestedAction.throttle, requestedAction.brake, requestedAction.gear),
      reason: null,
      maneuver: "policy-direct",
      candidates: [],
    };
  }

  const scan = requireDispatchScan(world);
  const { player } = world;
  const start = {
    ...vehicleProbe(player, player.speed ?? 0),
    width: player.width ?? PLAYER_VEHICLE.widthM,
    length: player.length ?? PLAYER_VEHICLE.lengthM,
    steer: player.steer ?? 0,
    gtaSlipMps: player.gtaSlipMps ?? 0,
    gtaYawRate: player.gtaYawRate ?? 0,
  };

  if (
    ![
      start.x,
      start.z,
      start.heading,
      start.speed,
      start.steer,
      start.width,
      start.length,
      start.gtaSlipMps,
      start.gtaYawRate,
    ].every(Number.isFinite)
  ) {
    return {
      action: { ...PURSUIT_STOP },
      reason: "SAFETY_INTERVENTION",
      maneuver: "invalid-odometry",
      candidates: [],
    };
  }

  const localGeometry = filterLocalGeometry(world, start);
  const scanModel = buildScanModel(scan, start);
  const visualPoints = extractVisualForecastPoints(world.visualState, start);
  const cameraConflict = hasCameraCrossingConflict(world.visualState);
  const farRouteCtx = buildFarEscapeRouteContext(world, start);
  const routeHeading = farRouteCtx?.nearHeading ?? null;
  const startOnRoad =
    localGeometry.roads.length > 0 && poseOnRoadFast(start, localGeometry.roads, localGeometry.roadRects);

  const stateKey = world.pursuit;
  let escapeState = stateKey ? escapeStates.get(stateKey) : null;
  if (!escapeState) {
    const existingMem = world.pursuit?.gta?._evasiveMemory;
    escapeState = {
      history: [],
      blockedZones: [],
      visitedCells: Array.isArray(existingMem?.visitedCells) ? existingMem.visitedCells : [],
      prevSteerCmd: null,
      active: null,
      noForwardStreak: 0,
      lastStreakTick: -1,
      cooldownUntilTick: 0,
      lastKTurnX: NaN,
      lastKTurnZ: NaN,
      lastKTurnTick: -9999,
      crowdWaveUntilTick: -1,
      lastCrowdYieldTick: -9999,
      lastAlleyShortcutTick: -9999,
      lastLosBreakTick: -9999,
      lastLosBreakSign: 0,
    };
    if (stateKey) escapeStates.set(stateKey, escapeState);
  }
  if (world.pursuit?.gta && Object.isExtensible(world.pursuit.gta)) {
    if (!world.pursuit.gta._evasiveMemory) {
      world.pursuit.gta._evasiveMemory = {
        visitedCells: escapeState.visitedCells,
        cellSizeM: VISITED_CELL_SIZE_M,
      };
    } else if (Array.isArray(world.pursuit.gta._evasiveMemory.visitedCells)) {
      escapeState.visitedCells = world.pursuit.gta._evasiveMemory.visitedCells;
    }
  }

  const lastHist = escapeState.history.length > 0 ? escapeState.history[escapeState.history.length - 1] : null;
  if (
    lastHist &&
    (world.tick < lastHist.tick ||
      world.tick - lastHist.tick > 120 ||
      Math.hypot(start.x - lastHist.x, start.z - lastHist.z) > 25)
  ) {
    escapeState.history.length = 0;
    escapeState.blockedZones.length = 0;
    escapeState.visitedCells.length = 0;
    escapeState.prevSteerCmd = null;
    escapeState.active = null;
    escapeState.noForwardStreak = 0;
    escapeState.lastStreakTick = -1;
    escapeState.cooldownUntilTick = 0;
    escapeState.lastKTurnX = NaN;
    escapeState.lastKTurnZ = NaN;
    escapeState.lastKTurnTick = -9999;
    escapeState.crowdWaveUntilTick = -1;
    escapeState.lastCrowdYieldTick = -9999;
    escapeState.lastAlleyShortcutTick = -9999;
    escapeState.lastLosBreakTick = -9999;
    escapeState.lastLosBreakSign = 0;
  } else if (escapeState.blockedZones.length > 0) {
    escapeState.blockedZones = escapeState.blockedZones.filter((bz) => bz.untilTick > world.tick);
  }

  const currentCellKey = cellKeyForXY(start.x, start.z);
  const vCells = escapeState.visitedCells;
  if (vCells.length === 0 || vCells[vCells.length - 1].key !== currentCellKey) {
    vCells.push({ key: currentCellKey, enteredTick: world.tick, lastTick: world.tick });
    while (vCells.length > VISITED_CELL_LIMIT) vCells.shift();
  } else {
    vCells[vCells.length - 1].lastTick = world.tick;
  }

  const transitionToForwardCommit = (esc) => {
    esc.phase = "forward-commit";
    esc.phaseStartTick = world.tick;
    esc.forwardMovingStartTick = start.speed >= -0.05 ? world.tick : null;
    esc.lastTick = world.tick;
    escapeState.history.length = 0;
    escapeState.cooldownUntilTick = world.tick + 180;
    escapeState.lastKTurnX = start.x;
    escapeState.lastKTurnZ = start.z;
    escapeState.lastKTurnTick = world.tick;
    escapeState.noForwardStreak = 0;
  };

  const recordDecisionAndReturn = (result) => {
    const isCrowdHold = result.maneuver === "crowd-wait" || result.maneuver === "crowd-creep";
    if (isCrowdHold) escapeState.lastCrowdYieldTick = world.tick;
    if (result.maneuver === "alley-shortcut") escapeState.lastAlleyShortcutTick = world.tick;
    if (result.tacticalTag === "los-break") {
      escapeState.lastLosBreakTick = world.tick;
      if (Math.abs(result.action.steer) >= 0.25) {
        escapeState.lastLosBreakSign = Math.sign(result.action.steer);
      }
    }
    escapeState.prevSteerCmd = result.action.steer;
    const hist = escapeState.history;
    const prev = hist.length > 0 ? hist[hist.length - 1] : null;
    if (!prev || world.tick - prev.tick >= PURSUIT_SCAN_TICKS) {
      hist.push({ tick: world.tick, x: start.x, z: start.z, gear: result.action.gear, crowdHold: isCrowdHold });
      if (hist.length > 24) hist.shift();
    } else if (prev.tick === world.tick) {
      prev.x = start.x;
      prev.z = start.z;
      prev.gear = result.action.gear;
      prev.crowdHold = isCrowdHold;
    }
    return result;
  };

  let activeEscape = escapeState.active;
  if (activeEscape) {
    if (world.tick < activeEscape.lastTick || world.tick - activeEscape.lastTick > 36) {
      escapeState.active = null;
      activeEscape = null;
    } else if (activeEscape.phase === "reverse") {
      activeEscape.reverseMovingStartTick ??= start.speed <= 0.05 ? world.tick : null;
      if (world.tick - activeEscape.phaseStartTick >= 84) {
        transitionToForwardCommit(activeEscape);
      }
    }
    if (activeEscape?.phase === "forward-commit") {
      if (activeEscape.forwardMovingStartTick === null && start.speed >= -0.05) {
        activeEscape.forwardMovingStartTick = world.tick;
        escapeState.history.length = 0;
        escapeState.cooldownUntilTick = Math.max(escapeState.cooldownUntilTick, world.tick + 180);
      }
      const totalCommitTicks = world.tick - activeEscape.phaseStartTick;
      const forwardMovingTicks =
        activeEscape.forwardMovingStartTick !== null
          ? world.tick - activeEscape.forwardMovingStartTick
          : 0;
      const distFromOrigin = Math.hypot(start.x - activeEscape.originX, start.z - activeEscape.originZ);
      if (
        (activeEscape.forwardMovingStartTick !== null && forwardMovingTicks >= 54) ||
        totalCommitTicks >= 96 ||
        distFromOrigin >= 9.5
      ) {
        escapeState.active = null;
        activeEscape = null;
        escapeState.noForwardStreak = 0;
      }
    }
  }

  const inCooldown = world.tick < (escapeState.cooldownUntilTick ?? 0);
  let netDisp15 = Infinity;
  let pathDist15 = 0;
  let netDisp10 = Infinity;
  let gearFlips = 0;
  const histLen = escapeState.history.length;
  if (histLen >= 14) {
    const idx15 = Math.max(0, histLen - 14);
    const hOld15 = escapeState.history[idx15];
    if (world.tick - hOld15.tick >= 72) {
      netDisp15 = Math.hypot(start.x - hOld15.x, start.z - hOld15.z);
      for (let i = idx15 + 1; i < histLen; i++) {
        pathDist15 += Math.hypot(
          escapeState.history[i].x - escapeState.history[i - 1].x,
          escapeState.history[i].z - escapeState.history[i - 1].z,
        );
      }
      pathDist15 += Math.hypot(start.x - escapeState.history[histLen - 1].x, start.z - escapeState.history[histLen - 1].z);
    }
  }
  if (histLen >= 9) {
    const hOld10 = escapeState.history[Math.max(0, histLen - 9)];
    if (world.tick - hOld10.tick >= 48) {
      netDisp10 = Math.hypot(start.x - hOld10.x, start.z - hOld10.z);
    }
  }
  if (histLen >= 2) {
    const recentStart = Math.max(0, histLen - 20);
    for (let i = recentStart + 1; i < histLen; i++) {
      if (escapeState.history[i].gear !== escapeState.history[i - 1].gear) gearFlips++;
    }
  }
  let crowdHoldCount15 = 0;
  if (histLen >= 14) {
    const idx15 = Math.max(0, histLen - 14);
    for (let i = idx15; i < histLen; i++) {
      if (escapeState.history[i].crowdHold) crowdHoldCount15++;
    }
  }

  const referenceForwardHeading = activeEscape ? activeEscape.targetHeading : start.heading;
  const localRoadHeading = nearestLocalRoadHeading(start, referenceForwardHeading, localGeometry.roads);
  const uxFwd = Math.sin(localRoadHeading);
  const uzFwd = Math.cos(localRoadHeading);
  const minCrossAngleRad = (22 * Math.PI) / 180;
  const hasCrossRoadAhead = (world.drivingRoads ?? localGeometry.roads).some((r) => {
    if (!r || r.parkingBay || r.supportApron) return false;
    const rux = r.axis === "diag" ? r.ux : r.axis === "x" ? 1 : 0;
    const ruz = r.axis === "diag" ? r.uz : r.axis === "x" ? 0 : 1;
    const rHeading =
      r.axis === "diag" ? (r.heading ?? Math.atan2(rux, ruz)) : r.axis === "x" ? Math.PI * 0.5 : 0;
    const acuteDiff = Math.min(
      Math.abs(angleDelta(rHeading, localRoadHeading)),
      Math.abs(angleDelta(rHeading + Math.PI, localRoadHeading)),
    );
    if (acuteDiff < minCrossAngleRad) return false;
    const det = -uxFwd * ruz + uzFwd * rux;
    if (Math.abs(det) < 0.15) return false;
    const rx0 = r.axis === "diag" ? r.x1 : r.axis === "x" ? r.min : r.fixed;
    const rz0 = r.axis === "diag" ? r.z1 : r.axis === "x" ? r.fixed : r.min;
    const rLen = r.axis === "diag" ? r.length : r.max - r.min;
    const dx = rx0 - start.x;
    const dz = rz0 - start.z;
    const distAlong = (-ruz * dx + rux * dz) / det;
    const alongR = (-uzFwd * dx + uxFwd * dz) / det;
    return distAlong >= -6 && distAlong <= 24 && alongR >= -8 && alongR <= rLen + 8;
  });

  const onCurbNow = !startOnRoad || Boolean(player.curbSupportId);
  const pursuerPressure = detectClosingPursuersFromScan(scanModel, start.heading);
  const losBuildings = pursuerPressure.active ? collectNearbyLosBuildings(localGeometry, start) : [];
  const pedProximity = inspectPedestrianProximity(start, scanModel, visualPoints);
  const asphaltAhead = analyzeAsphaltAhead(start, start, referenceForwardHeading, localGeometry, scanModel);
  const crowdCtx = detectCrowdContext(
    start,
    localRoadHeading,
    routeHeading,
    hasCrossRoadAhead,
    asphaltAhead,
    localGeometry,
    scanModel,
    visualPoints,
    world.visualState,
    escapeState,
    world.tick,
  );
  const crowdYieldActive = crowdCtx.crowdYieldActive;
  const recentlyCrowdYielded =
    crowdCtx.nearestPoliceM > 9.5 &&
    (crowdYieldActive ||
      world.tick - (escapeState.lastCrowdYieldTick ?? -9999) <= 48 ||
      crowdHoldCount15 >= 4);

  const rawPingPongOscillation =
    !inCooldown &&
    start.speed <= 1.35 &&
    ((gearFlips >= 3 && netDisp15 < 5.5) ||
      (gearFlips >= 2 && histLen >= 9 && netDisp10 < 5.0 && (Math.abs(start.speed) < 1.2 || pathDist15 > netDisp15 + 0.8)) ||
      (!recentlyCrowdYielded &&
        histLen >= 14 &&
        netDisp15 < 3.2 &&
        Math.abs(start.speed) < 1.35 &&
        (pathDist15 > netDisp15 + 0.9 || (player.wait ?? 0) >= 0.35 || gearFlips >= 1)));

  const suppressCurbForCrowdWait = crowdYieldActive && startOnRoad && !player.curbSupportId;
  const curbBypassGuide = suppressCurbForCrowdWait
    ? null
    : findClearCurbBypassGuide(
        start,
        player.curbSupportId ?? null,
        referenceForwardHeading,
        localGeometry,
        scanModel,
        visualPoints,
        asphaltAhead,
      );
  const continuingAlley = world.tick - (escapeState.lastAlleyShortcutTick ?? -9999) <= 24;
  const alleyShortcutGuide = suppressCurbForCrowdWait
    ? null
    : findAlleyShortcutGuide(
        start,
        referenceForwardHeading,
        routeHeading,
        startOnRoad,
        curbBypassGuide,
        asphaltAhead,
        localGeometry,
        scanModel,
        visualPoints,
        escapeState.blockedZones,
        world.tick,
        crowdCtx.crowdDivertUrgent,
        continuingAlley,
        pursuerPressure,
        hasCrossRoadAhead,
        losBuildings,
      );
  const frontConeMinM = Math.min(
    scanModel.rays[70].rangeM,
    scanModel.rays[71].rangeM,
    scanModel.rays[0].rangeM,
    scanModel.rays[1].rangeM,
    scanModel.rays[2].rangeM,
  );
  const frontBumperRangeM = frontConeMinM - start.length * 0.5;
  const roadAheadBlocked = asphaltAhead.allBlocked || frontConeMinM < 11.0;

  const resolvedSpec = start.spec == null ? VEHICLE : { ...VEHICLE, ...start.spec };
  const requestedAimHeading = start.heading + requestedAction.steer * resolvedSpec.maxSteer * 0.5;
  const requestedBlockedByMemory = isHeadingBlockedInMemory(
    start,
    requestedAimHeading,
    escapeState.blockedZones,
    world.tick,
  );

  const minObstacleTtc = computeMinForwardObstacleTtc(start, scanModel);
  const prevSteerCmd =
    escapeState.prevSteerCmd ??
    clamp((start.steer ?? 0) / Math.max(0.1, resolvedSpec.maxSteer), -1, 1);

  const smoothDeadbandAction = (act) => {
    if (
      act.gear === 1 &&
      act.steer !== 0 &&
      Math.abs(act.steer * resolvedSpec.maxSteer) < STRAIGHT_DEADBAND_STEER_RAD &&
      startOnRoad &&
      !player.curbSupportId &&
      !activeEscape &&
      !curbBypassGuide &&
      !alleyShortcutGuide &&
      !asphaltAhead.ownCorridorBlocked &&
      !roadAheadBlocked &&
      minObstacleTtc > 2.2 &&
      pedProximity.nearestM > 4.5 &&
      !pursuerPressure.active &&
      !farRouteCtx?.turnAhead &&
      Math.abs(angleDelta(start.heading, localRoadHeading)) <= STRAIGHT_ALIGN_RAD &&
      (routeHeading === null || Math.abs(angleDelta(routeHeading, localRoadHeading)) <= 0.16)
    ) {
      return makeAction(0, act.throttle, act.brake, act.gear);
    }
    return act;
  };

  const inLosBreakCommit = world.tick - (escapeState.lastLosBreakTick ?? -9999) <= 90;

  const ctx = {
    start,
    spec: resolvedSpec,
    cos0: Math.cos(start.heading),
    sin0: Math.sin(start.heading),
    localGeometry,
    scanModel,
    visualPoints,
    requestedAction,
    routeHeading,
    farRouteCtx,
    inLosBreakCommit,
    lastLosBreakSign: escapeState.lastLosBreakSign ?? 0,
    visitedCells: escapeState.visitedCells,
    minObstacleTtc,
    prevSteerCmd,
    asphaltAhead,
    crowdYieldActive,
    startOnRoad,
    playerCurbSupportId: player.curbSupportId ?? null,
    referenceForwardHeading,
    localRoadHeading,
    hasCrossRoadAhead,
    curbBypassGuide,
    alleyShortcutGuide,
    roadAheadBlocked,
    activeEscape,
    blockedZones: escapeState.blockedZones,
    pursuerPressure,
    losBuildings,
    pedProximity,
    tick: world.tick,
  };

  const checkLosBreakOpportunity =
    pursuerPressure.active &&
    (hasCrossRoadAhead || Boolean(alleyShortcutGuide) || Boolean(localGeometry.curb?.courtyards?.length));
  const farRouteTurnUrgent = Boolean(
    farRouteCtx?.hasExplicitEscapeGoal &&
      ((farRouteCtx.turnImminent &&
        Math.abs(
          angleDelta(
            farRouteCtx.nearHeading ?? farRouteCtx.lookahead35Heading ?? start.heading,
            requestedAimHeading,
          ),
        ) >= 0.18) ||
        (farRouteCtx.turnPreparing && Math.abs(start.speed) > 12.8)),
  );
  let directPassThroughAction = null;

  if (
    !activeEscape &&
    !rawPingPongOscillation &&
    !requestedBlockedByMemory &&
    !curbBypassGuide &&
    !alleyShortcutGuide &&
    !farRouteTurnUrgent &&
    requestedAction.gear === 1 &&
    requestedAction.brake === 0 &&
    requestedAction.throttle >= 0.35 &&
    !player.curbSupportId &&
    startOnRoad &&
    !cameraConflict &&
    (player.wait ?? 0) < 0.35 &&
    guardDispatchAction(world, requestedAction).reason === null
  ) {
    const direct = assessTrajectory(ctx, requestedAction, false, { computeDirectCone: true });
    const corridorM = forwardCorridorClearance(
      start,
      requestedAction,
      scanModel,
      localGeometry.roads,
      localGeometry.roadRects,
      localGeometry.statics,
    );
    const requiredCorridorM = Math.max(12, Math.abs(start.speed) * 2.5 + start.length / 2);
    const requiredRoadM = Math.min(18, Math.max(11, Math.abs(start.speed) * 1.9));
    const roadClearEnough = corridorM >= Math.min(requiredCorridorM, requiredRoadM) &&
      (corridorM >= requiredCorridorM || forwardCorridorClearance(start, requestedAction, scanModel, null, null, localGeometry.statics) >= requiredCorridorM && corridorM >= requiredRoadM);
    const stalled = direct.feasible && (direct.actionSpeed < 0.12 && Math.abs(start.speed) < 0.12 || direct.travelM < 0.02);
    const directRevisitsLoop = Boolean(direct.feasible && (direct.revisitPenalty ?? 0) < 0);
    if (direct.feasible && direct.directConeM >= 12 && roadClearEnough && !stalled && !directRevisitsLoop) {
      const cleanDirect = smoothDeadbandAction(
        makeAction(
          requestedAction.steer,
          requestedAction.throttle,
          requestedAction.brake,
          requestedAction.gear,
        ),
      );
      if (!checkLosBreakOpportunity) {
        return recordDecisionAndReturn({
          action: cleanDirect,
          reason: null,
          maneuver: "policy-direct",
          mode: "policy-direct",
          tacticalTag: null,
          candidates: [],
        });
      }
      directPassThroughAction = cleanDirect;
    }
  }

  const candidates = [];
  const allowCurb = Boolean(localGeometry.curb) && !suppressCurbForCrowdWait;
  const rawCurb = localGeometry.rawCurb;
  const cityCurbsMode = rawCurb?.mode === "metro-city-curbs-v2";
  const hasCityCurb = Array.isArray(rawCurb?.sites) || Array.isArray(rawCurb?.courtyards);
  const curbMaxPace = rawCurb ? (rawCurb.maxPace ?? (hasCityCurb ? 14.0 : 2.8)) : 14.0;
  const commitAimErr = activeEscape ? Math.abs(angleDelta(activeEscape.targetHeading, start.heading)) : 0;
  const fastThrottle =
    activeEscape?.phase === "forward-commit" && commitAimErr <= 0.95
      ? 1.0
      : clamp(Math.max(0.78, requestedAction.throttle), 0, 1);

  let bestForward = null;
  const forwardFeasible = [];
  const evaluateForwardProfile = (profileName, throttle, brake, steers, options = null) => {
    for (const steer of steers) {
      const action = makeAction(steer, throttle, brake, 1);
      const verdict = assessTrajectory(ctx, action, allowCurb, options);
      const losBreakBonus = verdict.losBreakBonus ?? 0;
      const candidate = {
        name: `${profileName}:${steer}`,
        action,
        feasible: verdict.feasible,
        usesCurb: Boolean(verdict.usesCurb),
        rejectReason: verdict.rejectReason,
        openConeM: verdict.openConeM ?? 0,
        corridorMinM: verdict.corridorMinM ?? 0,
        actionHeading: verdict.actionHeading ?? start.heading,
        minClearanceM: verdict.minClearanceM ?? null,
        losBreakBonus,
        tacticalTag: losBreakBonus >= 8 ? "los-break" : null,
        score: verdict.score ?? -Infinity,
      };
      candidates.push(candidate);
      if (candidate.feasible) {
        forwardFeasible.push(candidate);
      }
    }
  };

  const resolveShieldSafeForward = () => {
    if (!forwardFeasible.length) return null;
    forwardFeasible.sort((a, b) => b.score - a.score);
    if (!cityCurbsMode && !crowdYieldActive) return forwardFeasible[0];
    for (let i = 0; i < forwardFeasible.length; i++) {
      const cand = forwardFeasible[i];
      if (cand._shieldChecked === undefined) {
        cand._shieldChecked = guardDispatchAction(world, cand.action).reason === null;
        if (!cand._shieldChecked) {
          cand.feasible = false;
          cand.rejectReason = "shield-veto";
        }
      }
      if (cand._shieldChecked) return cand;
    }
    return null;
  };

  let fastSteers = FORWARD_STEERS;
  if (
    startOnRoad &&
    !asphaltAhead.ownCorridorBlocked &&
    !curbBypassGuide &&
    !alleyShortcutGuide &&
    !farRouteCtx?.turnAhead &&
    minObstacleTtc > 2.2
  ) {
    const straightRef =
      routeHeading !== null && Math.abs(angleDelta(routeHeading, localRoadHeading)) <= 0.18
        ? routeHeading
        : localRoadHeading;
    const hErr = angleDelta(straightRef, start.heading);
    if (Math.abs(hErr) > STRAIGHT_ALIGN_RAD && Math.abs(hErr) <= 0.32) {
      const trimSteer = Number(clamp(hErr * 1.35, -0.14, 0.14).toFixed(3));
      if (Math.abs(trimSteer * resolvedSpec.maxSteer) >= STRAIGHT_DEADBAND_STEER_RAD) {
        fastSteers = [...FORWARD_STEERS, trimSteer];
      }
    }
  }
  evaluateForwardProfile("fast", fastThrottle, 0, fastSteers);
  bestForward = resolveShieldSafeForward();
  const controlledSteers =
    !checkLosBreakOpportunity && !farRouteTurnUrgent && bestForward && bestForward.corridorMinM >= 6.5
      ? CONTROLLED_FAST_STEERS
      : FORWARD_STEERS;
  evaluateForwardProfile("controlled", 0.48, 0, controlledSteers);
  bestForward = resolveShieldSafeForward();

  const needRouteCornerBrake =
    Boolean(
      farRouteCtx?.hasExplicitEscapeGoal &&
        (farRouteCtx.turnImminent || farRouteCtx.turnPreparing),
    ) && Math.abs(start.speed) > 11.2;
  if (
    (checkLosBreakOpportunity &&
      Math.abs(start.speed) > 13.5 &&
      (!bestForward || (bestForward.losBreakBonus ?? 0) < 8)) ||
    needRouteCornerBrake
  ) {
    evaluateForwardProfile("corner-brake", 0, 0.45, FORWARD_STEERS);
    bestForward = resolveShieldSafeForward();
  }

  if (
    crowdYieldActive &&
    !bestForward &&
    !cameraConflict &&
    Math.abs(start.speed) <= 2.4 &&
    crowdCtx.nearestPedForwardM >= 4.0
  ) {
    evaluateForwardProfile("crowd-creep", 0.20, 0, FORWARD_STEERS, { minRolloutSpeed: 0.85 });
    bestForward = resolveShieldSafeForward();
  }

  const startPace = Math.hypot(start.speed, start.gtaSlipMps);
  const pedNearCurb = pedProximity.nearestM <= 6.5;
  const briskAlleyCruise =
    (Boolean(alleyShortcutGuide) || pursuerPressure.active) &&
    !pedNearCurb &&
    minBoxGapToStatics(start, localGeometry.statics, 2.0) >= 1.1;
  if (
    rawCurb &&
    (onCurbNow || Boolean(curbBypassGuide) || Boolean(alleyShortcutGuide) || !bestForward) &&
    (startPace > curbMaxPace - 2.2 ||
      (pedNearCurb && (onCurbNow || Boolean(alleyShortcutGuide)) && Math.abs(start.speed) > 3.6) ||
      (!briskAlleyCruise && onCurbNow && Math.abs(start.speed) > 6.4) ||
      (curbBypassGuide?.mandatoryRejoin && Math.abs(start.speed) > 3.8))
  ) {
    const trimSteers = alleyShortcutGuide ? FORWARD_STEERS : AUX_STEERS;
    evaluateForwardProfile("curb-trim", 0, 0.15, trimSteers);
    bestForward = resolveShieldSafeForward();
    if (!bestForward || startPace > curbMaxPace - 0.5 || (pedNearCurb && Math.abs(start.speed) > 5.8)) {
      evaluateForwardProfile("curb-pace", 0, 0.45, trimSteers);
      bestForward = resolveShieldSafeForward();
    }
  }

  let unstickEvaluated = false;
  const evaluateUnstickPivot = () => {
    if (!crowdYieldActive && !unstickEvaluated && !bestForward && Math.abs(start.speed) <= 2.2) {
      unstickEvaluated = true;
      evaluateForwardProfile("unstick-pivot", 0.26, 0, FORWARD_STEERS, { minRolloutSpeed: 1.35 });
      bestForward = resolveShieldSafeForward();
    }
  };

  const evaluateBestReverse = (targetHeading, preferredTurnSign) => {
    const rearCenterClearM = averageSectorRange(scanModel, 26, 46);
    let rearMinRangeM = PURSUIT_SCAN_RANGE_M;
    for (let i = 33; i <= 39; i++) rearMinRangeM = Math.min(rearMinRangeM, scanModel.rays[i].rangeM);
    const rearSpaceTight = rearMinRangeM - start.length / 2 < 2.8;
    const prevAimErr = Math.abs(angleDelta(targetHeading, start.heading));
    const steerGain = prevAimErr > 0.25 ? 11.5 : 4.0 * (prevAimErr / 0.25);
    const reverseFeasible = [];

    const scoreReverseVerdict = (steer, verdict) => {
      if (!verdict.feasible) return -Infinity;
      const nextAimErr = Math.abs(angleDelta(targetHeading, verdict.endHeading));
      const aimProgress = prevAimErr - nextAimErr;
      const steerTurnAlign = -steer * preferredTurnSign;
      return (
        steerGain * steerTurnAlign +
        22.0 * aimProgress +
        0.35 * verdict.travelM +
        0.22 * rearCenterClearM +
        (verdict.usesCurb ? -1.4 : 0) +
        0.5 * Math.min(3, verdict.minClearanceM)
      );
    };

    const revThrottle = start.speed <= -4.2 ? 0.35 : 0.95;
    for (const steer of REVERSE_STEERS) {
      const fastAction = makeAction(steer, revThrottle, 0, -1);
      const fastVerdict = assessTrajectory(ctx, fastAction, allowCurb);
      if (fastVerdict.feasible) {
        const cand = {
          name: `reverse:${steer}`,
          action: fastAction,
          feasible: true,
          usesCurb: Boolean(fastVerdict.usesCurb),
          rejectReason: null,
          openConeM: fastVerdict.openConeM ?? 0,
          minClearanceM: fastVerdict.minClearanceM ?? null,
          score: scoreReverseVerdict(steer, fastVerdict),
        };
        candidates.push(cand);
        reverseFeasible.push(cand);
      } else {
        candidates.push({
          name: `reverse:${steer}`,
          action: fastAction,
          feasible: false,
          usesCurb: Boolean(fastVerdict.usesCurb),
          rejectReason: fastVerdict.rejectReason,
          openConeM: 0,
          minClearanceM: null,
          score: -Infinity,
        });
      }

      if (!fastVerdict.feasible || rearSpaceTight || Math.abs(start.speed) <= 1.2) {
        const shortAction = makeAction(steer, 0.55, 0, -1);
        const shortVerdict = assessTrajectory(ctx, shortAction, allowCurb, {
          actionTicks: ACTION_TICKS_REVERSE_SHORT,
        });
        if (shortVerdict.feasible) {
          const shortCand = {
            name: `reverse-short:${steer}`,
            action: shortAction,
            feasible: true,
            usesCurb: Boolean(shortVerdict.usesCurb),
            rejectReason: null,
            openConeM: shortVerdict.openConeM ?? 0,
            minClearanceM: shortVerdict.minClearanceM ?? null,
            score: scoreReverseVerdict(steer, shortVerdict) - 0.15,
          };
          candidates.push(shortCand);
          reverseFeasible.push(shortCand);
        }
      }
    }

    reverseFeasible.sort((a, b) => b.score - a.score);
    if (!cityCurbsMode) return reverseFeasible[0] ?? null;
    for (let i = 0; i < reverseFeasible.length; i++) {
      const cand = reverseFeasible[i];
      if (guardDispatchAction(world, cand.action).reason === null) {
        return cand;
      }
      cand.feasible = false;
      cand.rejectReason = "shield-veto";
    }
    return null;
  };

  const predictReverseStopPose = (turnSign) => {
    if (start.speed >= -0.35) return null;
    const stopAction = makeAction(-turnSign, 0, 1, -1);
    const maxSpeedCmd = start.maxSpeed ?? 9.72;
    const maxSpeedPlant = start.maxSpeed ?? 13.89;
    let p = {
      x: start.x,
      z: start.z,
      heading: start.heading,
      steer: start.steer,
      speed: start.speed,
      spec: resolvedSpec,
      gtaSlipMps: start.gtaSlipMps ?? 0,
      gtaYawRate: start.gtaYawRate ?? 0,
      type: start.type,
      radius: start.radius,
      length: start.length,
      width: start.width,
    };
    let buf = { ...p };
    const curb = allowCurb ? localGeometry.curb : null;
    for (let step = 1; step <= 36; step++) {
      const next = stepPursuitPoseInto(p, buf, stopAction, STEP, resolvedSpec, maxSpeedCmd, maxSpeedPlant, 0);
      if (
        !sweepSegmentSupportAndStatics(
          p,
          next,
          localGeometry.roads,
          curb,
          localGeometry.statics,
          0.16,
          localGeometry.roadRects,
          localGeometry.pointRoadRects,
        ).ok
      ) {
        return null;
      }
      buf = p;
      p = next;
      if (Math.abs(p.speed) < 0.05) break;
    }
    return p;
  };

  if (activeEscape?.phase === "reverse") {
    activeEscape.reverseMovingStartTick ??= start.speed <= 0.05 ? world.tick : null;
    const totalRevTicks = world.tick - activeEscape.phaseStartTick;
    const elapsedRev =
      activeEscape.reverseMovingStartTick !== null
        ? world.tick - activeEscape.reverseMovingStartTick
        : 0;
    const backedDistM = Math.hypot(start.x - activeEscape.originX, start.z - activeEscape.originZ);
    const rotatedRad = Math.abs(angleDelta(start.heading, activeEscape.originHeading));
    const aimErrorRad = Math.abs(angleDelta(activeEscape.targetHeading, start.heading));
    const originFrontGapM = activeEscape.originFrontGapM ?? 2.0;
    const hasTurnClearance = originFrontGapM + backedDistM >= 3.4 || backedDistM >= 2.2;

    if (elapsedRev >= 30 && backedDistM < 0.12 && Math.abs(start.speed) < 0.08 && !bestForward) {
      escapeState.active = null;
      activeEscape = null;
      escapeState.cooldownUntilTick = world.tick + 120;
      escapeState.noForwardStreak = 0;
      return recordDecisionAndReturn({
        action: makeAction(0, 0, 1, 1),
        reason: "SAFETY_INTERVENTION",
        maneuver: "boxed-stop",
        candidates,
      });
    }

    const readyEarly =
      Boolean(bestForward) &&
      activeEscape.reverseMovingStartTick !== null &&
      elapsedRev >= 22 &&
      hasTurnClearance &&
      (backedDistM >= 1.8 || rotatedRad >= 0.35 || (backedDistM >= 1.4 && aimErrorRad <= 0.55)) &&
      bestForward.corridorMinM >= 8.5;
    const readyMax = Boolean(bestForward) && (elapsedRev >= 72 || totalRevTicks >= 78);

    let readyViaReverseStop = false;
    if (
      !readyEarly &&
      !readyMax &&
      activeEscape.reverseMovingStartTick !== null &&
      elapsedRev >= 22 &&
      start.speed <= -1.8
    ) {
      const stopPose = predictReverseStopPose(activeEscape.turnSign);
      if (stopPose) {
        const stopBackedM = Math.hypot(stopPose.x - activeEscape.originX, stopPose.z - activeEscape.originZ);
        const stopRotatedRad = Math.abs(angleDelta(stopPose.heading, activeEscape.originHeading));
        const stopAimErr = Math.abs(angleDelta(activeEscape.targetHeading, stopPose.heading));
        const stopHasTurnClearance = originFrontGapM + stopBackedM >= 3.4 || stopBackedM >= 2.4;
        const leadHeading =
          stopPose.heading +
          clamp(angleDelta(activeEscape.targetHeading, stopPose.heading), -0.55, 0.55);
        const nearLeadProbe = probeCorridorClearance(
          start,
          leadHeading,
          5.2,
          localGeometry,
          scanModel,
          visualPoints,
          stopPose,
          startOnRoad,
        );
        const targetExitProbe = probeCorridorClearance(
          start,
          activeEscape.targetHeading,
          15.5,
          localGeometry,
          scanModel,
          visualPoints,
          stopPose,
          startOnRoad,
        );
        if (
          stopHasTurnClearance &&
          (stopBackedM >= 1.8 || stopRotatedRad >= 0.36 || (stopBackedM >= 1.5 && stopAimErr <= 0.55)) &&
          nearLeadProbe.clearDistM >= 5.2 &&
          targetExitProbe.clearDistM >= 11.5
        ) {
          readyViaReverseStop = true;
        }
      }
    }

    if (readyEarly || readyMax || (readyViaReverseStop && bestForward)) {
      transitionToForwardCommit(activeEscape);
    } else if (readyViaReverseStop) {
      transitionToForwardCommit(activeEscape);
      return recordDecisionAndReturn({
        action: makeAction(-activeEscape.turnSign, 0, 1, 1),
        reason: "SAFETY_INTERVENTION",
        maneuver: "decelerate-to-evade",
        candidates,
      });
    } else {
      const bestReverse = evaluateBestReverse(activeEscape.targetHeading, activeEscape.turnSign);
      if (bestReverse) {
        bestReverse.selected = true;
        activeEscape.lastTick = world.tick;
        return recordDecisionAndReturn({
          action: bestReverse.action,
          reason: "PREDICTIVE_REVERSE_ESCAPE",
          maneuver: "reverse-turn",
          candidates,
        });
      }
      // Rear space ran out after backing up: transition into forward-commit rather than dropping targetHeading!
      evaluateUnstickPivot();
      if (bestForward) {
        transitionToForwardCommit(activeEscape);
      } else if (start.speed < -0.35) {
        transitionToForwardCommit(activeEscape);
        return recordDecisionAndReturn({
          action: makeAction(-activeEscape.turnSign, 0, 1, 1),
          reason: "SAFETY_INTERVENTION",
          maneuver: "decelerate-to-evade",
          candidates,
        });
      } else {
        escapeState.active = null;
        activeEscape = null;
      }
    }
  }

  if (activeEscape?.phase === "forward-commit") {
    activeEscape.lastTick = world.tick;
    if (start.speed < -1.5) {
      const counterSteerAction = makeAction(-activeEscape.turnSign, 1.0, 0, 1);
      const counterVerdict = assessTrajectory(ctx, counterSteerAction, allowCurb);
      if (
        counterVerdict.feasible &&
        (!cityCurbsMode || guardDispatchAction(world, counterSteerAction).reason === null)
      ) {
        escapeState.noForwardStreak = 0;
        return recordDecisionAndReturn({
          action: counterSteerAction,
          reason: "PREDICTIVE_EVADE_LANE",
          maneuver: counterSteerAction.steer > 0 ? "evade-left" : "evade-right",
          candidates,
        });
      }
    }
    if (
      bestForward &&
      commitAimErr <= 0.85 &&
      bestForward.corridorMinM >= 10.5 &&
      bestForward.action.brake === 0 &&
      bestForward.action.throttle < 1.0
    ) {
      const punchAction = makeAction(bestForward.action.steer, 1.0, 0, 1);
      const punchVerdict = assessTrajectory(ctx, punchAction, allowCurb);
      if (
        punchVerdict.feasible &&
        (!cityCurbsMode || guardDispatchAction(world, punchAction).reason === null)
      ) {
        bestForward = {
          ...bestForward,
          name: `commit-punch:${punchAction.steer}`,
          action: punchAction,
          usesCurb: Boolean(punchVerdict.usesCurb),
          actionHeading: punchVerdict.actionHeading ?? start.heading,
          corridorMinM: punchVerdict.corridorMinM ?? bestForward.corridorMinM,
          openConeM: punchVerdict.openConeM ?? bestForward.openConeM,
        };
      }
    }
    evaluateUnstickPivot();
    if (bestForward) {
      escapeState.noForwardStreak = 0;
    } else if (start.speed < -0.35) {
      return recordDecisionAndReturn({
        action: makeAction(-activeEscape.turnSign, 0, 1, 1),
        reason: "SAFETY_INTERVENTION",
        maneuver: "decelerate-to-evade",
        candidates,
      });
    } else {
      if (escapeState.lastStreakTick !== world.tick) {
        escapeState.noForwardStreak = (escapeState.noForwardStreak ?? 0) + 1;
        escapeState.lastStreakTick = world.tick;
      }
      if (escapeState.noForwardStreak < 2) {
        const holdSteer = clamp(angleDelta(activeEscape.targetHeading, start.heading) * 1.8, -1, 1);
        return recordDecisionAndReturn({
          action: makeAction(holdSteer, 0, 1, 1),
          reason: "SAFETY_INTERVENTION",
          maneuver: "decelerate-to-evade",
          candidates,
        });
      }
      escapeState.active = null;
      activeEscape = null;
      escapeState.noForwardStreak = 0;
    }
  }

  if (!activeEscape && start.speed <= 1.35) {
    const nearRecentKTurn =
      Number.isFinite(escapeState.lastKTurnX) &&
      world.tick - escapeState.lastKTurnTick < 390 &&
      Math.hypot(start.x - escapeState.lastKTurnX, start.z - escapeState.lastKTurnZ) < 4.2;
    if (inCooldown || nearRecentKTurn) {
      evaluateUnstickPivot();
    }
    const movingForwardClear = Boolean(
      bestForward && bestForward.corridorMinM >= 7.5 && start.speed >= 0.55,
    );
    let rearMinForRepeatM = PURSUIT_SCAN_RANGE_M;
    for (let i = 33; i <= 39; i++) rearMinForRepeatM = Math.min(rearMinForRepeatM, scanModel.rays[i].rangeM);
    const rearGapForRepeatM = rearMinForRepeatM - start.length * 0.5;

    let shouldStartReverse = false;
    let triggeredByOscillation = false;

    if (nearRecentKTurn) {
      shouldStartReverse =
        !bestForward &&
        Math.abs(start.speed) <= 0.35 &&
        ((rearGapForRepeatM >= 2.8 && (player.wait ?? 0) >= 2.4) ||
          (rearGapForRepeatM >= 1.8 && (player.wait ?? 0) >= 4.2));
    } else if (inCooldown) {
      shouldStartReverse =
        !bestForward && Math.abs(start.speed) <= 0.35 && (player.wait ?? 0) >= 0.55;
    } else {
      const frontHitStall =
        Math.abs(start.speed) <= 1.35 &&
        ((frontBumperRangeM < 1.35 && (!bestForward || bestForward.corridorMinM < 5.5)) ||
          (frontBumperRangeM < 2.65 && (!bestForward || bestForward.corridorMinM < 5.8)));
      const stuckOnCurb =
        !movingForwardClear &&
        onCurbNow &&
        (player.wait ?? 0) >= 0.45 &&
        Math.abs(start.speed) <= 1.35 &&
        (!bestForward || bestForward.openConeM < 7.0 || bestForward.corridorMinM < 6.0);
      const stalledInTightCorridor =
        !movingForwardClear &&
        (player.wait ?? 0) >= 0.40 &&
        Math.abs(start.speed) <= 1.35 &&
        (!bestForward || bestForward.corridorMinM < 4.5);
      triggeredByOscillation = !movingForwardClear && rawPingPongOscillation;
      shouldStartReverse =
        frontHitStall ||
        triggeredByOscillation ||
        stuckOnCurb ||
        stalledInTightCorridor ||
        (!bestForward && Math.abs(start.speed) <= 1.35);
    }

    if (crowdYieldActive && crowdCtx.nearestPoliceM > 9.5) {
      shouldStartReverse = false;
    }

    if (shouldStartReverse) {
      const tentativeHalfAngle =
        asphaltAhead.allBlocked || triggeredByOscillation ? BLOCKED_ZONE_ANGLE_RAD : (20 * Math.PI) / 180;
      const tempBlocked = [
        ...escapeState.blockedZones,
        {
          x: start.x,
          z: start.z,
          heading: start.heading,
          untilTick: world.tick + BLOCKED_ZONE_TTL_TICKS,
          halfAngle: tentativeHalfAngle,
        },
      ];
      const escapePlan = findOpenEscapeCorridor(
        start,
        routeHeading,
        startOnRoad,
        onCurbNow,
        triggeredByOscillation,
        localGeometry,
        scanModel,
        visualPoints,
        tempBlocked,
        world.tick,
      );
      const bestReverse = evaluateBestReverse(escapePlan.targetHeading, escapePlan.turnSign);
      if (bestReverse) {
        bestReverse.selected = true;
        const zoneHalfAngle =
          escapePlan.allForwardLanesBlocked || triggeredByOscillation
            ? BLOCKED_ZONE_ANGLE_RAD
            : (20 * Math.PI) / 180;
        recordBlockedZone(
          escapeState.blockedZones,
          start.x,
          start.z,
          start.heading,
          world.tick + BLOCKED_ZONE_TTL_TICKS,
          zoneHalfAngle,
        );
        escapeState.active = {
          phase: "reverse",
          startTick: world.tick,
          phaseStartTick: world.tick,
          reverseMovingStartTick: start.speed <= 0.05 ? world.tick : null,
          forwardMovingStartTick: null,
          lastTick: world.tick,
          targetHeading: escapePlan.targetHeading,
          turnSign: escapePlan.turnSign,
          originX: start.x,
          originZ: start.z,
          originHeading: start.heading,
          originFrontGapM: Math.max(0, frontBumperRangeM),
        };
        escapeState.noForwardStreak = 0;
        return recordDecisionAndReturn({
          action: bestReverse.action,
          reason: "PREDICTIVE_REVERSE_ESCAPE",
          maneuver: "reverse-turn",
          candidates,
        });
      }
    }
  }

  evaluateUnstickPivot();

  if (
    directPassThroughAction &&
    !alleyShortcutGuide &&
    !curbBypassGuide &&
    (!bestForward || (bestForward.losBreakBonus ?? 0) < 8)
  ) {
    return recordDecisionAndReturn({
      action: directPassThroughAction,
      reason: null,
      maneuver: "policy-direct",
      mode: "policy-direct",
      tacticalTag: null,
      candidates: [],
    });
  }

  if (bestForward) {
    bestForward.selected = true;
    if (bestForward.name.startsWith("crowd-creep:")) {
      return recordDecisionAndReturn({
        action: bestForward.action,
        reason: "PREDICTIVE_EVADE_LANE",
        maneuver: "crowd-creep",
        mode: "crowd-creep",
        tacticalTag: null,
        candidates,
      });
    }
    const activeCurbSiteNow = findActiveCurbSite(start, localGeometry.curb);
    const inCourtyardNow =
      !startOnRoad &&
      !activeCurbSiteNow &&
      Boolean(localGeometry.curb?.courtyards?.length) &&
      pointOnCurbXY(start.x, start.z, localGeometry.curb);
    const guidedIntoAlley = Boolean(
      alleyShortcutGuide &&
        (Math.abs(bestForward.action.steer - alleyShortcutGuide.desiredSteer) <= 0.45 ||
          Math.abs(angleDelta(bestForward.actionHeading, alleyShortcutGuide.guideHeading)) <= 0.55 ||
          inCourtyardNow),
    );
    const wideOpenCourtyardEntry =
      !alleyShortcutGuide &&
      !curbBypassGuide &&
      Boolean(localGeometry.curb?.courtyards?.length) &&
      (inCourtyardNow || (bestForward.usesCurb && roadAheadBlocked && bestForward.corridorMinM >= 15.0));
    const isAlleyShortcut = guidedIntoAlley || wideOpenCourtyardEntry;
    const guidedOntoCurb = Boolean(
      curbBypassGuide &&
        !curbBypassGuide.rejoining &&
        Math.abs(bestForward.action.steer - curbBypassGuide.desiredSteer) <= 0.35,
    );
    const usesCurbBypass =
      isAlleyShortcut || bestForward.usesCurb || Boolean(player.curbSupportId) || !startOnRoad || guidedOntoCurb;
    const reason = usesCurbBypass ? "PREDICTIVE_CURB_BYPASS" : "PREDICTIVE_EVADE_LANE";
    const maneuver = isAlleyShortcut
      ? "alley-shortcut"
      : usesCurbBypass
        ? "curb-bypass"
        : Math.abs(bestForward.action.steer) > 0.2
          ? bestForward.action.steer > 0
            ? "evade-left"
            : "evade-right"
          : "evade-forward";
    const isLosBreak = (bestForward.losBreakBonus ?? 0) >= 8;
    const tacticalTag = isLosBreak ? "los-break" : null;
    const mode = isLosBreak ? "los-break" : maneuver;
    const outAction = isLosBreak || usesCurbBypass ? bestForward.action : smoothDeadbandAction(bestForward.action);
    return recordDecisionAndReturn({
      action: outAction,
      reason,
      maneuver,
      mode,
      tacticalTag,
      losBreakBonus: bestForward.losBreakBonus ?? 0,
      candidates,
    });
  }

  if (crowdYieldActive && crowdCtx.nearestPoliceM > 9.5) {
    const gapSteer = bestCrowdWaitSteer(
      scanModel,
      visualPoints,
      start,
      localRoadHeading,
      localGeometry,
      requestedAction,
    );
    const rawWait = makeAction(gapSteer, 0, 0.65, 1);
    const waitGuard = guardDispatchAction(world, rawWait);
    const waitAction = waitGuard.reason === null ? rawWait : makeAction(gapSteer, 0, 1, 1);
    candidates.push({
      name: `crowd-wait:${gapSteer}`,
      action: waitAction,
      feasible: true,
      selected: true,
      usesCurb: false,
      rejectReason: null,
      openConeM: 0,
      corridorMinM: 0,
      actionHeading: start.heading,
      minClearanceM: null,
      score: 0,
    });
    return recordDecisionAndReturn({
      action: waitAction,
      reason: "PREDICTIVE_QUEUE",
      maneuver: "crowd-wait",
      mode: "crowd-wait",
      tacticalTag: null,
      queue: { phase: "yield" },
      candidates,
    });
  }

  if (Math.abs(start.speed) > 1.35) {
    const openSectorSteer = bestDecelerationSteer(scanModel, start, requestedAction);
    return recordDecisionAndReturn({
      action: makeAction(openSectorSteer, 0, 1, 1),
      reason: "SAFETY_INTERVENTION",
      maneuver: "decelerate-to-evade",
      mode: "decelerate-to-evade",
      tacticalTag: null,
      candidates,
    });
  }

  return recordDecisionAndReturn({
    action: makeAction(0, 0, 1, 1),
    reason: "SAFETY_INTERVENTION",
    maneuver: "boxed-stop",
    mode: "boxed-stop",
    tacticalTag: null,
    candidates,
  });
}

export const choosePakoEvasiveAction = planPakoEvasiveAction;
