import { STEP, VEHICLE, clamp } from "../core/config.js";
import { planDistrictRoute } from "../core/district-navigation.js";
import { angleDelta, bodyOnRoad, distance, overlaps, roadFrame, roadPoseAt } from "../core/geometry.js";
import { pursuitCommand } from "../core/pursuit-controls.js";
import { integrateVehicle, vehicleProbe } from "../core/vehicle.js";
import { CLEARANCE_ROUTE_CONTEXT, dispatchRouteGuide } from "./pursuit-route-context.js";
import { forecastPursuitSurface, PURSUIT_SCAN_TICKS } from "../signal_processing/pursuit-scanner.js";
import { planPakoEvasiveAction } from "./pako-evasive-control.js";
import { guardDispatchAction, requireDispatchScan } from "./pursuit-shield.js";

export const SMART_ESCAPE_CONTROL = "pako-smart-escape-v3";
const memories = new WeakMap();

function measuredThreats(scan, ego) {
  const sin = Math.sin(ego.heading), cos = Math.cos(ego.heading);
  return scan.tracks.filter(t => t.kind === "police" && t.ageS <= .3).map(t => ({
    x: ego.x + t.rightM * cos + t.forwardM * sin,
    z: ego.z - t.rightM * sin + t.forwardM * cos,
  }));
}

export function selectSensorEscapeGoal(world, scan, previous = null) {
  const { player, district } = world;
  if (!district) return null;
  const threats = measuredThreats(scan, player);
  let awayX = 0, awayZ = 0;
  for (const threat of threats) {
    const d = Math.max(5, distance(player, threat));
    awayX += (player.x - threat.x) / (d * d);
    awayZ += (player.z - threat.z) / (d * d);
  }
  const norm = Math.hypot(awayX, awayZ);
  const hx = norm > .001 ? awayX / norm : Math.sin(player.heading);
  const hz = norm > .001 ? awayZ / norm : Math.cos(player.heading);
  const candidates = [];
  for (const road of world.drivingRoads ?? district.drivingRoads ?? []) {
    if (road.parkingBay || road.supportApron) continue;
    const frame = roadFrame(road);
    for (const fraction of [.2, .5, .8]) for (const sign of road.flow ? [road.flow] : [1, -1]) {
      const pose = roadPoseAt(road, frame.minAlong + frame.length * fraction, sign);
      const d = distance(player, pose);
      if (d < 80 || d > 480 || previous && distance(previous, pose) < 35) continue;
      const body = { ...player, ...pose };
      if (!bodyOnRoad(body, district.roads) ||
          (district.statics ?? []).some(s => overlaps(body, s, .4))) continue;
      const advance = (pose.x - player.x) * hx + (pose.z - player.z) * hz;
      const headingCost = Math.abs(angleDelta(pose.heading, player.heading)) * 8;
      candidates.push({ ...pose, roadId: road.id,
        score: advance * 1.6 - Math.abs(d - 190) * 1.9 - headingCost });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  for (const candidate of candidates.slice(0, 24)) {
    const path = planDistrictRoute(district, player, candidate);
    if (path.length < 2 || distance(path.at(-1), candidate) > 8) continue;
    const lengthM = path.reduce((s, p, i) => s + (i ? distance(path[i - 1], p) : 0), 0);
    if (lengthM > distance(player, candidate) * 3 + 50) continue;
    return Object.freeze({ x: candidate.x, z: candidate.z, heading: candidate.heading,
      roadId: candidate.roadId, id: `sensor-escape:${world.tick}:${candidate.roadId}`,
      sensorPlanned: true, selectedTick: world.tick, routeLengthM: lengthM,
      observedThreats: threats.length });
  }
  return null;
}

function observedMotion(track, ego) {
  if (!track.motionKnown) return { x: 0, z: 0 };
  const forecast = forecastPursuitSurface(track);
  if (forecast.status === "constant-velocity" && forecast.points.length) {
    const p = forecast.points[0];
    return { x: (p.xM - track.observedXM) / p.secondsAhead,
      z: (p.zM - track.observedZM) / p.secondsAhead };
  }
  const right = track.rightMps + (ego.gtaSlipMps ?? 0);
  const forward = track.forwardMps + ego.speed;
  const sin = Math.sin(ego.heading), cos = Math.cos(ego.heading);
  const motion = { x: right * cos + forward * sin, z: -right * sin + forward * cos };
  return Math.hypot(motion.x, motion.z) > (track.kind === "pedestrian" ? 4.5 : 45)
    ? { x: 0, z: 0 } : motion;
}

// Scanner returns are surfaces, not privileged actor centres or scripted paths.
export function predictEscapeConflict(player, scan, action) {
  if (action.gear !== 1 || player.speed < .4) return null;
  const speed = Math.abs(player.speed);
  const braking = player.spec?.braking ?? VEHICLE.braking;
  const horizon = clamp(speed / braking + 1.4, 1.5, 4.5);
  const sin = Math.sin(player.heading), cos = Math.cos(player.heading);
  const points = scan.tracks.filter(t => t.ageS <= .3 && t.forwardM > -3).map(t => ({
    track: t, motion: observedMotion(t, player),
    x: player.x + t.rightM * cos + t.forwardM * sin,
    z: player.z - t.rightM * sin + t.forwardM * cos,
  }));
  let pose = { ...vehicleProbe(player, player.speed), spec: player.spec, maxSpeed: player.maxSpeed };
  for (let t = .1; t <= horizon; t += .1) {
    pose = { ...pose, ...integrateVehicle(pose, pursuitCommand(pose, action, .1), .1) };
    const c = Math.cos(pose.heading), s = Math.sin(pose.heading);
    for (const point of points) {
      const { track, motion } = point;
      const dx = point.x + motion.x * t - pose.x;
      const dz = point.z + motion.z * t - pose.z;
      const right = Math.abs(dx * c - dz * s) - player.width / 2;
      const forward = Math.abs(dx * s + dz * c) - player.length / 2;
      const gap = Math.hypot(Math.max(0, right), Math.max(0, forward));
      const margin = (track.kind === "pedestrian" ? .85 : .55) +
        Math.min(.65, track.positionAllowanceM ?? .15);
      if (gap < margin) return { seconds: Number(t.toFixed(2)), kind: track.kind,
        trackId: track.trackId, motionKnown: track.motionKnown };
    }
  }
  return null;
}

export function smartRouteAction(world) {
  const { player } = world;
  const path = dispatchRouteGuide(world, CLEARANCE_ROUTE_CONTEXT)?.path;
  if (!path || path.length < 3) return null;
  let nearest = 0, nearestM = Infinity;
  for (let i = 0; i < path.length; i++) {
    const d = distance(player, path[i]);
    if (d < nearestM) { nearest = i; nearestM = d; }
  }
  if (nearestM > 3 || player.speed < -.1) return null;
  const speed = Math.max(0, player.speed);
  const lookahead = clamp(5 + speed * .5, 5, 17);
  let target = nearest, along = 0;
  let targetSpeed = player.maxSpeed ?? 28;
  const braking = player.spec?.braking ?? VEHICLE.braking;
  for (let i = nearest + 1; i < path.length && along < 70; i++) {
    along += distance(path[i - 1], path[i]);
    if (along < 70) {
      const pose = { ...player, x: path[i].x, z: path[i].z,
        heading: Math.atan2(path[i].x - path[i - 1].x, path[i].z - path[i - 1].z) };
      if ((world.statics ?? []).some(body => overlaps(pose, body, .3))) return null;
    }
    if (along < lookahead) target = i;
    const before = path[Math.max(nearest, i - 4)], after = path[Math.min(path.length - 1, i + 4)];
    const left = distance(before, path[i]), right = distance(path[i], after);
    if (left < 1 || right < 1) continue;
    const first = Math.atan2(path[i].x - before.x, path[i].z - before.z);
    const second = Math.atan2(after.x - path[i].x, after.z - path[i].z);
    const curvature = Math.abs(angleDelta(second, first)) / ((left + right) / 2);
    const curveSpeed = Math.sqrt(4.5 / Math.max(.001, curvature));
    targetSpeed = Math.min(targetSpeed, Math.sqrt(curveSpeed ** 2 +
      2 * braking * Math.max(0, along - 9)));
  }
  target = Math.min(path.length - 1, Math.max(nearest + 1, target));
  const targetM = Math.max(2, distance(player, path[target]));
  const error = angleDelta(Math.atan2(path[target].x - player.x, path[target].z - player.z), player.heading);
  if (Math.abs(error) > 1.15) return null;
  const steering = Math.atan2(2 * (player.spec?.wheelbase ?? VEHICLE.wheelbase) * Math.sin(error), targetM);
  const steer = clamp(steering / (player.spec?.maxSteer ?? VEHICLE.maxSteer), -1, 1);
  const brake = speed > targetSpeed + .6 ? clamp((speed - targetSpeed) / 3, .15, 1) : 0;
  return { action: { steer, gear: 1, throttle: brake ? 0 : clamp((targetSpeed - speed) / 3, .25, 1), brake },
    targetSpeedMps: targetSpeed, remainingPathPoints: path.length - nearest, routeErrorM: nearestM };
}

export function planSmartEscapeAction(world, requestedAction) {
  const scan = requireDispatchScan(world);
  const key = world.pursuit ?? world.player;
  let memory = memories.get(key);
  if (!memory || world.tick < memory.tick) {
    memory = { tick: world.tick, goal: null, bestDistanceM: Infinity,
      progressTick: world.tick, lastAction: null, brakeUntil: -1, brakeConflict: null };
    memories.set(key, memory);
  }
  const remaining = memory.goal ? distance(world.player, memory.goal) : Infinity;
  if (remaining < memory.bestDistanceM - 4) {
    memory.bestDistanceM = remaining;
    memory.progressTick = world.tick;
  }
  if (!memory.goal || remaining < 18 || world.tick - memory.progressTick > Math.round(14 / STEP)) {
    const goal = selectSensorEscapeGoal(world, scan, memory.goal);
    if (goal) {
      memory.goal = goal;
      memory.bestDistanceM = distance(world.player, goal);
      memory.progressTick = world.tick;
    }
  }
  if (memory.goal && world.pursuit?.gta) world.pursuit.gta.escapeGoal = memory.goal;
  const planned = planPakoEvasiveAction(world, requestedAction);
  let action = planned.action;
  const route = smartRouteAction(world);
  if (route && planned.action.gear === 1 && planned.action.brake === 0 &&
      planned.reason !== "SAFETY_INTERVENTION" && !guardDispatchAction(world, route.action).reason &&
      !predictEscapeConflict(world.player, scan, route.action)) {
    action = { ...route.action };
    if (planned.action.nitro && route.targetSpeedMps >= (world.player.maxSpeed ?? 28) - .5 &&
        Math.abs(action.steer) < .15 && !planned.nitroSuppressedByPedestrian)
      action.nitro = planned.action.nitro;
  }
  const conflict = predictEscapeConflict(world.player, scan, action);
  if (conflict) {
    memory.brakeUntil = world.tick + Math.round(.9 / STEP);
    memory.brakeConflict = conflict;
  }
  const yielding = conflict || (world.tick < memory.brakeUntil && world.player.speed > .2
    ? memory.brakeConflict : null);
  if (yielding) {
    const braking = world.player.spec?.braking ?? VEHICLE.braking;
    const needed = world.player.speed / Math.max(.25, yielding.seconds - .45);
    action = { steer: action.steer, gear: 1, throttle: 0,
      brake: clamp(needed / braking, .25, 1) };
  } else if (memory.lastAction && action.gear === memory.lastAction.gear && action.brake === 0) {
    const elapsed = Math.max(STEP, (world.tick - memory.tick) * STEP);
    const steer = clamp(action.steer, memory.lastAction.steer - elapsed * 1.8,
      memory.lastAction.steer + elapsed * 1.8);
    const smooth = { ...action, steer };
    if (!predictEscapeConflict(world.player, scan, smooth) && !guardDispatchAction(world, smooth).reason)
      action = smooth;
  }
  const checked = guardDispatchAction(world, action);
  memory.lastAction = checked.action;
  memory.tick = world.tick;
  return { ...planned, controller: SMART_ESCAPE_CONTROL, action: checked.action,
    reason: yielding ? "PREDICTIVE_TRAFFIC_BRAKE" : checked.reason ?? planned.reason,
    maneuver: yielding ? "anticipatory-yield" : planned.maneuver,
    nitroSuppressedByPedestrian: planned.nitroSuppressedByPedestrian || yielding?.kind === "pedestrian",
    escapeDestination: memory.goal, predictedConflict: conflict, routeTracking: route };
}
