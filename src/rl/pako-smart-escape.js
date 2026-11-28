import { STEP, VEHICLE, clamp } from "../core/config.js";
import { planDistrictRoute } from "../core/district-navigation.js";
import { SOLID_PROP_KINDS } from "../core/driver/perception.js";
import { angleDelta, bodyOnRoad, distance, overlaps, roadFrame, roadPoseAt } from "../core/geometry.js";
import { METRO_CITY_CURBS, isPoseSupportedWithCurbs } from "../core/pako-curb.js";
import { pursuitCommand } from "../core/pursuit-controls.js";
import { integrateVehicle, vehicleProbe } from "../core/vehicle.js";
import { CLEARANCE_ROUTE_CONTEXT, dispatchRouteGuide } from "./pursuit-route-context.js";
import { forecastPursuitSurface, PURSUIT_SCAN_RAYS, PURSUIT_SCAN_TICKS }
  from "../signal_processing/pursuit-scanner.js";
import { planPakoEvasiveAction } from "./pako-evasive-control.js";
import { guardDispatchAction, requireDispatchScan } from "./pursuit-shield.js";

export const SMART_ESCAPE_CONTROL = "pako-smart-escape-v3";
const memories = new WeakMap();
const RAY_STEP = (Math.PI * 2) / PURSUIT_SCAN_RAYS;

function stripNitro(action) {
  if (!action || !Object.prototype.hasOwnProperty.call(action, "nitro")) return action;
  return { steer: action.steer, throttle: action.throttle, brake: action.brake, gear: action.gear };
}

function initRolloutPose(player) {
  return {
    ...vehicleProbe(player, player.speed),
    spec: player.spec,
    maxSpeed: player.maxSpeed,
    gtaSlipMps: player.gtaSlipMps ?? 0,
    gtaYawRate: player.gtaYawRate ?? 0,
  };
}

function stepPoseWithSlip(pose, action, dt) {
  const next = { ...pose, ...integrateVehicle(pose, pursuitCommand(pose, action, dt), dt) };
  const slip0 = pose.gtaSlipMps ?? 0;
  const yaw0 = pose.gtaYawRate ?? 0;
  if (Math.abs(slip0) > 1e-4 || Math.abs(yaw0) > 1e-4) {
    const slip = slip0 * Math.exp(-3.8 * dt);
    const yaw = yaw0 * Math.exp(-3 * dt);
    const avgSlip = (slip0 + slip) * 0.5;
    const avgYaw = (yaw0 + yaw) * 0.5;
    next.x += Math.cos(next.heading) * avgSlip * dt;
    next.z -= Math.sin(next.heading) * avgSlip * dt;
    next.heading += avgYaw * dt;
    next.gtaSlipMps = slip;
    next.gtaYawRate = yaw;
  } else {
    next.gtaSlipMps = 0;
    next.gtaYawRate = 0;
  }
  return next;
}

function computeSightSpeedCap(player, frontSightM) {
  const braking = Math.max(4.0, player.spec?.braking ?? VEHICLE.braking);
  const maxSpeed = player.maxSpeed ?? 28;
  // 3. Ensure a comfortable stopping sightline cap for heavy vehicles (King Long braking 6.4 m/s^2)
  // while keeping agile SUVs fast on open avenues.
  const heavy = braking < 7.0;
  const tReact = heavy ? 0.44 : 0.31;
  const visM = Math.max(8.0, Math.min(frontSightM, 48) - (heavy ? 5.5 : 4.0));
  const effBrake = heavy ? braking * 0.85 : braking;
  const cap = Math.sqrt(2 * effBrake * visM + (effBrake * tReact) ** 2) - effBrake * tReact;
  return Math.min(maxSpeed, Math.max(10.0, cap));
}

function measuredThreats(scan, ego) {
  const sin = Math.sin(ego.heading), cos = Math.cos(ego.heading);
  return scan.tracks.filter(t => t.kind === "police" && t.ageS <= .3).map(t => ({
    x: ego.x + t.rightM * cos + t.forwardM * sin,
    z: ego.z - t.rightM * sin + t.forwardM * cos,
    rightM: t.rightM,
    forwardM: t.forwardM,
  }));
}

function forwardPoliceBlocker(scan) {
  return scan?.tracks
    ?.filter(t => t.kind === "police" && t.ageS <= .3 &&
      t.forwardM > 8 && t.forwardM < 65 && Math.abs(t.rightM) < 6)
    .sort((a, b) => a.forwardM - b.forwardM)[0] ?? null;
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
  const blocker = player.vehicleModel === "king-long-microbus" ? null : forwardPoliceBlocker(scan);
  const norm = Math.hypot(awayX, awayZ);
  let hx = norm > .001 ? awayX / norm : Math.sin(player.heading);
  let hz = norm > .001 ? awayZ / norm : Math.cos(player.heading);
  if (blocker) {
    const turnSide = Math.abs(blocker.rightM) > 0.8 ? -Math.sign(blocker.rightM) : 1;
    hx = Math.cos(player.heading) * turnSide;
    hz = -Math.sin(player.heading) * turnSide;
  }
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
      const dx = pose.x - player.x, dz = pose.z - player.z;
      const advance = dx * hx + dz * hz;
      const headingDelta = Math.abs(angleDelta(pose.heading, player.heading));
      const headingCost = headingDelta * 8;
      const egoForward = dx * Math.sin(player.heading) + dz * Math.cos(player.heading);
      const corridorTurnScore = blocker && egoForward > 20
        ? headingDelta < 0.48 ? -180 : headingDelta > 0.78 && headingDelta < 2.36 ? 82 : 0
        : 0;
      candidates.push({ ...pose, roadId: road.id,
        score: advance * 1.6 - Math.abs(d - 190) * 1.9 - headingCost + corridorTurnScore });
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

function boxGapToPoint(pose, px, pz, halfW, halfL) {
  const dx = px - pose.x, dz = pz - pose.z;
  const c = Math.cos(pose.heading), s = Math.sin(pose.heading);
  const right = Math.abs(dx * c - dz * s) - halfW;
  const forward = Math.abs(dx * s + dz * c) - halfL;
  if (right <= 0 && forward <= 0) return Math.max(right, forward);
  return Math.hypot(Math.max(0, right), Math.max(0, forward));
}

function stepRolloutAction(baseAction, startHeading, poseHeading, t, speed = 0, laneChangeTaper = false) {
  if (baseAction.gear !== 1 || Math.abs(baseAction.steer) <= 0.04) return baseAction;
  const turned = Math.abs(angleDelta(poseHeading, startHeading));
  const absSpeed = Math.abs(speed);
  if (laneChangeTaper && absSpeed > 11 && Math.abs(baseAction.steer) <= 0.55) {
    const turnOutT = clamp(0.65 - absSpeed * 0.012, 0.32, 0.56);
    const turnCap = clamp(0.42 - absSpeed * 0.008, 0.20, 0.36);
    let scale = 1;
    if (t > turnOutT) scale = Math.min(scale, Math.max(0, 1 - (t - turnOutT) / 0.28));
    if (turned > turnCap) scale = Math.min(scale, Math.max(0, 1 - (turned - turnCap) / 0.16));
    if (scale >= 0.999) return baseAction;
    return { ...baseAction, steer: baseAction.steer * scale };
  }
  if (Math.abs(baseAction.steer) <= 0.12) return baseAction;
  let scale = 1;
  if (t > 0.72) scale = Math.min(scale, Math.max(0, 1 - (t - 0.72) / 0.45));
  if (turned > 0.5) scale = Math.min(scale, Math.max(0, 1 - (turned - 0.5) / 0.35));
  if (scale >= 0.999) return baseAction;
  return { ...baseAction, steer: baseAction.steer * scale };
}

function collectObstacleModel(player, scan) {
  const sin = Math.sin(player.heading), cos = Math.cos(player.heading);
  const halfW = (player.width ?? VEHICLE.width) / 2;
  const halfL = (player.length ?? VEHICLE.length) / 2;
  const tracks = [];
  const forwardRayPoints = [];
  const rearRayPoints = [];
  const policeThreats = [];
  let pedCaution = false;
  let nearestForwardPed = null;
  let frontLeftClear = 0, frontRightClear = 0;
  let frontSightM = 48;

  for (const t of scan.tracks) {
    if (t.ageS > 0.35) continue;
    const x = player.x + t.rightM * cos + t.forwardM * sin;
    const z = player.z - t.rightM * sin + t.forwardM * cos;
    const motion = observedMotion(t, player);
    const speedMps = Math.hypot(motion.x, motion.z);
    const ux = speedMps > 0.2 ? motion.x / speedMps : 0;
    const uz = speedMps > 0.2 ? motion.z / speedMps : 0;
    const lateralSpeedMps = Math.abs(motion.x * cos - motion.z * sin);
    const egoForwardMotionMps = motion.x * sin + motion.z * cos;
    const oncoming = t.kind !== "pedestrian" && t.kind !== "static" &&
      t.motionKnown && egoForwardMotionMps < -1.8;
    const startGap = boxGapToPoint(player, x, z, halfW, halfL);
    const entry = {
      track: t, kind: t.kind, x, z, motion, speedMps, ux, uz, lateralSpeedMps,
      oncoming, rightM: t.rightM, forwardM: t.forwardM, startGap,
      sinEgo: sin, cosEgo: cos,
      allowance: Math.min(0.65, t.positionAllowanceM ?? 0.15),
    };
    tracks.push(entry);
    if (t.kind === "police" && t.ageS <= 0.3) {
      policeThreats.push({ x, z, rightM: t.rightM, forwardM: t.forwardM });
    }
    if (t.kind === "pedestrian") {
      const dist = Math.hypot(t.rightM, t.forwardM);
      if (dist <= 18 || (t.forwardM >= -2.5 && t.forwardM <= 34 && Math.abs(t.rightM) <= halfW + 6.0)) {
        pedCaution = true;
      }
      if (t.forwardM > -0.5 && t.forwardM <= 34 && Math.abs(t.rightM) <= halfW + 2.6) {
        if (!nearestForwardPed || t.forwardM < nearestForwardPed.forwardM) {
          nearestForwardPed = entry;
        }
      }
    }
  }

  const nRays = scan.rays.length;
  for (let i = 0; i < nRays; i++) {
    const ray = scan.rays[i];
    const angle = i * RAY_STEP;
    const signedAngle = angle > Math.PI ? angle - Math.PI * 2 : angle;
    const clampedRange = Math.min(ray.rangeM, 38);
    if (signedAngle > 0.18 && signedAngle < 1.25) {
      frontRightClear += ray.kind === "pedestrian" ? Math.min(clampedRange, 6) * 0.4 : clampedRange;
    } else if (signedAngle < -0.18 && signedAngle > -1.25) {
      frontLeftClear += ray.kind === "pedestrian" ? Math.min(clampedRange, 6) * 0.4 : clampedRange;
    }
    if (ray.kind === "none") continue;
    const sinA = Math.sin(angle), cosA = Math.cos(angle);
    const rightM = ray.rangeM * sinA, forwardM = ray.rangeM * cosA;
    if (forwardM > 0 && Math.abs(rightM) <= halfW + 1.0 && ray.rangeM < frontSightM) {
      frontSightM = ray.rangeM;
    }
    if (ray.kind === "pedestrian") {
      if (ray.rangeM <= 24 || (forwardM >= -2 && forwardM <= 34 && Math.abs(rightM) <= halfW + 5.5)) {
        pedCaution = true;
      }
      if (forwardM > 0 && forwardM <= 34 && Math.abs(rightM) <= halfW + 2.5) {
        if (!nearestForwardPed || forwardM < nearestForwardPed.forwardM) {
          nearestForwardPed = { kind: "pedestrian", rightM, forwardM,
            x: player.x + rightM * cos + forwardM * sin,
            z: player.z - rightM * sin + forwardM * cos, motion: { x: 0, z: 0 } };
        }
      }
    }
    if (ray.rangeM > 40) continue;
    const x = player.x + rightM * cos + forwardM * sin;
    const z = player.z - rightM * sin + forwardM * cos;
    const pt = {
      kind: ray.kind, rightM, forwardM, rangeM: ray.rangeM, x, z,
      startGap: boxGapToPoint(player, x, z, halfW, halfL),
    };
    if (forwardM >= -3.5) forwardRayPoints.push(pt);
    if (forwardM <= 0.8 && ray.rangeM <= 18) rearRayPoints.push(pt);
  }

  return {
    tracks, forwardRayPoints, rearRayPoints, policeThreats,
    pedCaution, nearestForwardPed, frontLeftClear, frontRightClear,
    frontSightM, sightSpeedCap: computeSightSpeedCap(player, frontSightM),
    halfW, halfL,
  };
}

function trackGapAtTime(pose, tr, t, halfW, halfL) {
  const px = tr.x + tr.motion.x * t;
  const pz = tr.z + tr.motion.z * t;
  let gap = boxGapToPoint(pose, px, pz, halfW, halfL);
  // A moving vehicle track is a single surface point on a ~4.5 m body; expand along its velocity vector
  // when moving fast laterally, crossing, or oncoming so we never try to thread through its unseen chassis.
  if (tr.kind !== "pedestrian" && tr.kind !== "static") {
    if (tr.speedMps > 1.8) {
      const ext = tr.oncoming ? 2.5 : (tr.lateralSpeedMps > 1.5 ? 2.25 : 1.55);
      gap = Math.min(
        gap,
        boxGapToPoint(pose, px + tr.ux * ext, pz + tr.uz * ext, halfW, halfL),
        boxGapToPoint(pose, px - tr.ux * ext, pz - tr.uz * ext, halfW, halfL),
      );
    } else if (!tr.track?.motionKnown && tr.forwardM > 0 && tr.forwardM < 24 &&
        Math.abs(tr.rightM) <= halfW + 3.2 && t > 0) {
      // Newly acquired dynamic vehicle tracks in our forward corridor have motionKnown=false for one scan;
      // guard against assuming an oncoming vehicle in our lane is stationary.
      const closeDist = Math.min(6.5 * t, 8.0);
      gap = Math.min(
        gap,
        boxGapToPoint(pose, tr.x - tr.sinEgo * closeDist, tr.z - tr.cosEgo * closeDist, halfW, halfL),
      );
    }
  }
  return gap;
}

// Scanner returns are surfaces, not privileged actor centres or scripted paths.
export function predictEscapeConflict(player, scan, action) {
  if (action.gear !== 1 || (player.speed < .4 && action.throttle <= .05)) return null;
  const speed = Math.abs(player.speed);
  const braking = Math.max(4.0, player.spec?.braking ?? VEHICLE.braking);
  const horizon = clamp(speed / braking + 1.4, 1.5, 4.5);
  const sin = Math.sin(player.heading), cos = Math.cos(player.heading);
  const halfW = (player.width ?? VEHICLE.width) / 2;
  const halfL = (player.length ?? VEHICLE.length) / 2;
  const points = scan.tracks.filter(t => t.ageS <= .3 && t.forwardM > -3).map(t => {
    const motion = observedMotion(t, player);
    const speedMps = Math.hypot(motion.x, motion.z);
    const x = player.x + t.rightM * cos + t.forwardM * sin;
    const z = player.z - t.rightM * sin + t.forwardM * cos;
    return {
      track: t, kind: t.kind, motion, speedMps,
      ux: speedMps > 0.2 ? motion.x / speedMps : 0,
      uz: speedMps > 0.2 ? motion.z / speedMps : 0,
      lateralSpeedMps: Math.abs(motion.x * cos - motion.z * sin),
      oncoming: t.kind !== "pedestrian" && t.kind !== "static" &&
        t.motionKnown && (motion.x * sin + motion.z * cos) < -1.8,
      forwardM: t.forwardM, sinEgo: sin, cosEgo: cos,
      startGap: boxGapToPoint(player, x, z, halfW, halfL),
      x, z,
    };
  });
  if (!points.length) return null;
  let pose = initRolloutPose(player);
  const cleanAction = stripNitro(action);
  for (let t = .1; t <= horizon + 1e-6; t += .1) {
    const stepAct = stepRolloutAction(cleanAction, player.heading, pose.heading, t, pose.speed);
    pose = stepPoseWithSlip(pose, stepAct, .1);
    for (const point of points) {
      const { track } = point;
      const gap = trackGapAtTime(pose, point, t, halfW, halfL);
      const margin = (track.kind === "pedestrian" ? .85 : .55) +
        Math.min(.65, track.positionAllowanceM ?? .15);
      if (gap < margin) {
        // Do not flag an obstacle strictly behind/beside us when we are pulling cleanly away from it.
        if (track.kind !== "pedestrian" && point.forwardM <= halfL * 0.4 &&
            gap >= point.startGap - 0.02 && gap >= 0.14) {
          continue;
        }
        return { seconds: Number(t.toFixed(2)), kind: track.kind,
          trackId: track.trackId, motionKnown: track.motionKnown };
      }
    }
  }
  return null;
}

export function smartRouteAction(world, frontSightM = 48) {
  const { player } = world;
  const path = dispatchRouteGuide(world, CLEARANCE_ROUTE_CONTEXT)?.path;
  if (!path || path.length < 3) return null;
  let nearest = 0, nearestM = Infinity;
  for (let i = 0; i < path.length; i++) {
    const d = distance(player, path[i]);
    if (d < nearestM) { nearest = i; nearestM = d; }
  }
  if (nearestM > 5.5 || player.speed < -.15) return null;
  const speed = Math.max(0, player.speed);
  const lookahead = clamp(5.5 + speed * .52, 5.5, 18);
  let target = nearest, along = 0;
  const braking = Math.max(4.0, player.spec?.braking ?? VEHICLE.braking);
  // Never cruise faster than the vehicle can stop within observed sensor sightline.
  const maxSpeed = player.maxSpeed ?? 28;
  let curveTargetSpeed = maxSpeed;
  let targetSpeed = computeSightSpeedCap(player, frontSightM);
  const gripLat = Math.min(5.2, (player.spec?.tireGripMps2 ?? VEHICLE.tireGripMps2 ?? 7.5) * 0.68);
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
    const curveSpeed = Math.sqrt(gripLat / Math.max(.001, curvature));
    const approachCurve = Math.sqrt(curveSpeed ** 2 + 2 * braking * Math.max(0, along - 9));
    curveTargetSpeed = Math.min(curveTargetSpeed, approachCurve);
    targetSpeed = Math.min(targetSpeed, approachCurve);
  }
  target = Math.min(path.length - 1, Math.max(nearest + 1, target));
  const targetM = Math.max(2, distance(player, path[target]));
  const targetHeading = Math.atan2(path[target].x - player.x, path[target].z - player.z);
  const error = angleDelta(targetHeading, player.heading);
  if (Math.abs(error) > 1.35) return null;
  const steering = Math.atan2(2 * (player.spec?.wheelbase ?? VEHICLE.wheelbase) * Math.sin(error), targetM);
  const steer = clamp(steering / (player.spec?.maxSteer ?? VEHICLE.maxSteer), -1, 1);

  let throttle = 0, brake = 0;
  if (speed <= targetSpeed + 0.35) {
    throttle = speed < targetSpeed - 0.6
      ? 1
      : clamp((targetSpeed - speed + 0.35) / 2.2, 0.35, 1);
  } else if (speed > targetSpeed + 3.4) {
    brake = clamp((speed - targetSpeed - 3.0) / 6.0, 0.12, 0.75);
  }
  return {
    action: { steer, gear: 1, throttle, brake },
    targetSpeedMps: targetSpeed,
    curveTargetSpeedMps: curveTargetSpeed,
    targetHeading,
    remainingPathPoints: path.length - nearest,
    routeErrorM: nearestM,
  };
}

function poseSupported(world, pose) {
  const roads = world.roads ?? world.district?.roads;
  if (!roads || !roads.length) return { supported: true, onAsphalt: true };
  const onAsphalt = bodyOnRoad(pose, roads);
  if (onAsphalt) return { supported: true, onAsphalt: true };
  const curb = world.pursuit?.gta?.curb;
  if (curb?.mode === METRO_CITY_CURBS && isPoseSupportedWithCurbs(curb, roads, pose)) {
    return { supported: true, onAsphalt: false };
  }
  return { supported: false, onAsphalt: false };
}

function nominalPedestrianClearance(player, model, action) {
  if (!model.nearestForwardPed) return Infinity;
  const { halfW, halfL } = model;
  const speed = Math.max(0, player.speed);
  const braking = Math.max(4.0, player.spec?.braking ?? VEHICLE.braking);
  const horizon = clamp(Math.max(speed, 4) / braking + 1.4, 1.8, 3.2);
  let pose = initRolloutPose(player);
  const clean = stripNitro(action);
  let minPed = Infinity;
  for (let t = 0.15; t <= horizon + 1e-6; t += 0.15) {
    const stepAct = stepRolloutAction(clean, player.heading, pose.heading, t, pose.speed);
    pose = stepPoseWithSlip(pose, stepAct, 0.15);
    for (const tr of model.tracks) {
      if (tr.kind !== "pedestrian" || tr.forwardM < -1) continue;
      const d = boxGapToPoint(pose, tr.x + tr.motion.x * t, tr.z + tr.motion.z * t, halfW, halfL);
      if (d < minPed) minPed = d;
    }
    for (const pt of model.forwardRayPoints) {
      if (pt.kind !== "pedestrian") continue;
      const d = boxGapToPoint(pose, pt.x, pt.z, halfW, halfL);
      if (d < minPed) minPed = d;
    }
  }
  return minPed;
}

function evaluateForwardCandidate(world, scan, model, candidate, ctx) {
  if (guardDispatchAction(world, candidate).reason) return null;
  if (predictEscapeConflict(world.player, scan, candidate)) return null;

  const { player } = world;
  const { halfW, halfL } = model;
  const speed = Math.max(0, player.speed);
  const braking = Math.max(4.0, player.spec?.braking ?? VEHICLE.braking);
  const horizon = speed < 1.4 ? 1.05 : clamp(speed / braking + 1.0, 1.45, 3.6);
  const dt = 0.14;
  const highSpeedPad = speed > 12 ? 0.14 : 0;
  let pose = initRolloutPose(player);
  let minPed = Infinity, minVeh = Infinity, minStatic = Infinity;
  let curbSteps = 0, unsupportedSteps = 0;

  for (let t = dt; t <= horizon + 1e-6; t += dt) {
    const stepAct = stepRolloutAction(candidate, player.heading, pose.heading, t, pose.speed, true);
    pose = stepPoseWithSlip(pose, stepAct, dt);

    const sup = poseSupported(world, pose);
    if (!sup.supported) {
      unsupportedSteps++;
      if (ctx.startSupported || unsupportedSteps > 1) return null;
    } else if (!sup.onAsphalt) {
      curbSteps++;
    }

    for (const item of ctx.nearStatics ?? []) {
      const margin = item.pole ? (sup.onAsphalt ? 0.46 : 0.66) : (sup.onAsphalt ? 0.24 : 0.38);
      if (!overlaps(pose, item.body, margin)) continue;
      const movingAway = item.overlappingAtStart && distance(pose, item.body) >= item.startDistanceM + 0.04;
      if (!movingAway) return null;
    }

    for (const tr of model.tracks) {
      if (tr.forwardM < -2.5) continue;
      const gap = trackGapAtTime(pose, tr, t, halfW, halfL);
      const pullingAway = tr.kind !== "pedestrian" && tr.forwardM <= halfL * 0.4 &&
        gap >= tr.startGap - 0.02 && gap >= 0.14;
      if (tr.kind === "pedestrian") {
        if (gap < minPed) minPed = gap;
        if (gap < 0.96 + tr.allowance * 0.5) return null;
      } else if (tr.kind === "static") {
        if (gap < minStatic) minStatic = gap;
        if (!pullingAway && gap < 0.48 + highSpeedPad) return null;
      } else {
        if (gap < minVeh) minVeh = gap;
        const oncomingPad = tr.oncoming ? 0.45 : 0;
        const vehMin = (tr.lateralSpeedMps > 1.5 ? 0.90 : 0.46) + highSpeedPad + oncomingPad + tr.allowance * 0.3;
        if (!pullingAway && gap < vehMin) return null;
      }
    }

    for (const pt of model.forwardRayPoints) {
      const gap = boxGapToPoint(pose, pt.x, pt.z, halfW, halfL);
      const pullingAway = pt.kind !== "pedestrian" && pt.forwardM <= halfL * 0.4 &&
        gap >= pt.startGap - 0.02 && gap >= 0.14;
      if (pt.kind === "pedestrian") {
        if (gap < minPed) minPed = gap;
        if (gap < 0.98) return null;
      } else if (pt.kind === "static") {
        if (gap < minStatic) minStatic = gap;
        if (!pullingAway && gap < 0.44 + highSpeedPad) return null;
      } else {
        if (gap < minVeh) minVeh = gap;
        if (!pullingAway && gap < 0.38 + highSpeedPad) return null;
      }
    }
  }

  const endDx = pose.x - player.x, endDz = pose.z - player.z;
  const prefSin = Math.sin(ctx.desiredHeading), prefCos = Math.cos(ctx.desiredHeading);
  const progress = endDx * prefSin + endDz * prefCos;

  let policeAwayBonus = 0;
  for (const threat of model.policeThreats) {
    const beforeD = Math.hypot(player.x - threat.x, player.z - threat.z);
    const afterD = Math.hypot(pose.x - threat.x, pose.z - threat.z);
    if (beforeD < 35) policeAwayBonus += (afterD - beforeD) * 0.45;
  }

  const pedBerth = Number.isFinite(minPed)
    ? Math.min(minPed, 3.6) * 5.8 - (minPed < 2.2 ? (2.2 - minPed) * 14.0 : 0)
    : 12.0;
  const vehBerth = Number.isFinite(minVeh) ? Math.min(minVeh, 3.0) * 2.6 : 6.0;
  const staticBerth = Number.isFinite(minStatic) ? Math.min(minStatic, 2.5) * 2.0 : 4.0;
  const steerContinuity = -Math.abs(candidate.steer - ctx.lastSteer) * 2.6;
  const routeBias = -Math.abs(candidate.steer - ctx.nominalSteer) * 1.1;
  const sideBonus = ctx.evadeSide !== 0 && Math.abs(candidate.steer - ctx.nominalSteer) > 0.1
    ? (Math.sign(candidate.steer - ctx.nominalSteer) === ctx.evadeSide ? 2.4 : -2.6)
    : 0;
  const pedSideBonus = model.nearestForwardPed && Math.abs(candidate.steer) > 0.08
    ? (Math.sign(candidate.steer) === -(Math.sign(model.nearestForwardPed.rightM) || (ctx.evadeSide || -1)) ? 1.8 : -0.6)
    : 0;
  const poleHazardNearby = (ctx.nearStatics ?? []).some(item => item.pole && item.startDistanceM < 28);
  const endAsphaltBonus = poseSupported(world, pose).onAsphalt ? (poleHazardNearby ? 4.2 : 1.5) : 0;

  const score =
    pedBerth +
    vehBerth +
    staticBerth +
    progress * 1.45 +
    policeAwayBonus +
    candidate.throttle * 4.2 +
    Math.max(0, pose.speed) * 0.35 +
    steerContinuity +
    routeBias +
    sideBonus +
    pedSideBonus +
    endAsphaltBonus -
    curbSteps * (poleHazardNearby ? 2.35 : 1.4);

  return {
    action: candidate,
    score,
    minPedClearance: minPed,
    minVehClearance: minVeh,
    minStaticClearance: minStatic,
    progress,
    travelM: Math.hypot(endDx, endDz),
    endSpeed: pose.speed,
  };
}

function searchPoweredEvasiveCorridor(world, scan, model, nominalSteer, ctx) {
  const { player } = world;
  const speed = Math.max(0, player.speed);
  const maxSteer = player.spec?.maxSteer ?? VEHICLE.maxSteer;
  const wheelbase = player.spec?.wheelbase ?? VEHICLE.wheelbase;
  const gripLat = Math.min(5.6, (player.spec?.tireGripMps2 ?? VEHICLE.tireGripMps2 ?? 7.5) * 0.74);

  const hasCurbSupport = world.pursuit?.gta?.curb?.mode === METRO_CITY_CURBS;
  const hasCrossing = model.tracks.some(
    tr => tr.kind !== "static" && tr.kind !== "pedestrian" && tr.lateralSpeedMps > 1.5 &&
      tr.forwardM > -1 && tr.forwardM < 30,
  );
  const offsets = speed > 14
    ? [0, -0.07, 0.07, -0.14, 0.14, -0.24, 0.24, -0.40, 0.40, -0.60, 0.60, -0.84, 0.84]
    : (!hasCurbSupport && !hasCrossing && speed > 4)
      ? [0, -0.07, 0.07, -0.14, 0.14, -0.26, 0.26, -0.42, 0.42, -0.64, 0.64, -0.86, 0.86]
      : [0, -0.14, 0.14, -0.28, 0.28, -0.44, 0.44, -0.64, 0.64, -0.86, 0.86];
  const steers = [];
  const addSteer = s => {
    const c = clamp(s, -1, 1);
    if (!steers.some(prev => Math.abs(prev - c) < 0.035)) steers.push(c);
  };
  for (const off of offsets) addSteer(nominalSteer + off);
  addSteer(ctx.lastSteer);
  if (speed < 4) {
    addSteer(-1);
    addSteer(1);
  }

  let best = null;
  const sightCap = model.sightSpeedCap;
  for (const steer of steers) {
    const absSteer = Math.abs(steer);
    const curvature = Math.abs(Math.tan(steer * maxSteer)) / Math.max(1.5, wheelbase);
    const safeTurnSpeed = Math.min(
      sightCap,
      curvature > 0.005 ? Math.sqrt(gripLat / curvature) : (player.maxSpeed ?? 28),
    );
    let primaryThrottle = absSteer <= 0.3 ? 1.0 : absSteer <= 0.6 ? 0.82 : 0.65;
    if (speed > safeTurnSpeed + 0.6) primaryThrottle = 0.22;
    if (speed > safeTurnSpeed + 1.6) primaryThrottle = 0;

    const throttles = speed < 2.2
      ? [primaryThrottle, 0.55, 0.35]
      : primaryThrottle > 0.55
        ? [primaryThrottle, 0.48, 0]
        : primaryThrottle > 0
          ? [primaryThrottle, 0]
          : [0];

    for (const throttle of throttles) {
      const cand = { steer, gear: 1, throttle, brake: 0 };
      const evaluated = evaluateForwardCandidate(world, scan, model, cand, ctx);
      if (evaluated) {
        evaluated.safeTurnSpeed = safeTurnSpeed;
        if (!best || evaluated.score > best.score) best = evaluated;
        break;
      }
    }
  }
  return best;
}

function chooseBestBrakingSteer(world, model, preferredSteer, lastSteer, brakeAmount) {
  const { player } = world;
  const { halfW, halfL } = model;
  const candidates = [
    preferredSteer, lastSteer, 0,
    -0.08, 0.08, -0.16, 0.16, -0.30, 0.30, -0.52, 0.52, -0.80, 0.80, -1, 1,
  ];
  const startSup = poseSupported(world, player).supported;
  let best = null;
  for (const rawSteer of candidates) {
    const steer = clamp(rawSteer, -1, 1);
    const baseAct = { steer, gear: 1, throttle: 0, brake: brakeAmount };
    let pose = initRolloutPose(player);
    let minPed = Infinity, minOther = Infinity, unsupportedSteps = 0;
    for (let step = 0; step < 22; step++) {
      const t = (step + 1) * 0.12;
      const act = stepRolloutAction(baseAct, player.heading, pose.heading, t, pose.speed, true);
      pose = stepPoseWithSlip(pose, act, 0.12);
      if (startSup && !poseSupported(world, pose).supported) {
        unsupportedSteps++;
        if (unsupportedSteps > 1) break;
      }
      for (const tr of model.tracks) {
        if (tr.forwardM < -1) continue;
        const gap = trackGapAtTime(pose, tr, t, halfW, halfL);
        if (tr.kind === "pedestrian") minPed = Math.min(minPed, gap);
        else minOther = Math.min(minOther, gap);
      }
      for (const pt of model.forwardRayPoints) {
        const gap = boxGapToPoint(pose, pt.x, pt.z, halfW, halfL);
        if (pt.kind === "pedestrian") minPed = Math.min(minPed, gap);
        else minOther = Math.min(minOther, gap);
      }
      if (Math.abs(pose.speed) < 0.08) break;
    }
    if (unsupportedSteps > 1) continue;
    const pedScore = Math.min(minPed, 3.0) * 6.0 - (minPed < 0.9 ? (0.9 - minPed) * 120.0 : 0);
    const otherScore = Math.min(minOther, 2.5) * 3.0 - (minOther < 0.4 ? (0.4 - minOther) * 65.0 : 0);
    const score = pedScore + otherScore - unsupportedSteps * 4.0 - Math.abs(steer - lastSteer) * 0.35;
    if (!best || score > best.score) {
      best = { steer, score, minPed, minOther };
    }
  }
  return best ?? { steer: preferredSteer, score: 0, minPed: Infinity, minOther: Infinity };
}

function evaluateReverseCandidate(world, model, cand) {
  const { player } = world;
  const { halfW, halfL } = model;
  if (guardDispatchAction(world, cand).reason) return null;
  const startSup = poseSupported(world, player).supported;
  const statics = world.staticIndex?.near
    ? world.staticIndex.near(player, 14)
    : (world.statics ?? []).filter(s => distance(player, s) <= 14);
  const nearStatics = statics.map(s => ({
    s,
    startDist: distance(player, s),
    closeAtStart: overlaps(player, s, 0.24),
  }));
  let pose = initRolloutPose(player);
  let minRear = Infinity, minPed = Infinity;
  for (let step = 0; step < 10; step++) {
    const t = (step + 1) * 0.12;
    const stepAct = step < 7 ? cand : { steer: cand.steer, gear: -1, throttle: 0, brake: 1 };
    pose = stepPoseWithSlip(pose, stepAct, 0.12);
    if (startSup && !poseSupported(world, pose).supported) return null;
    for (const item of nearStatics) {
      if (item.closeAtStart) {
        if (overlaps(pose, item.s, 0.02) && distance(pose, item.s) < item.startDist - 0.01) return null;
      } else if (overlaps(pose, item.s, 0.18)) {
        return null;
      }
    }
    for (const tr of model.tracks) {
      const gap = trackGapAtTime(pose, tr, t, halfW, halfL);
      const backingAway = tr.forwardM > 0 && gap >= tr.startGap - 0.01;
      if (tr.kind === "pedestrian") {
        minPed = Math.min(minPed, gap);
        if (!(tr.forwardM > halfL * 0.8 && gap >= tr.startGap + 0.02 && gap >= 0.60) && gap < 1.20) {
          return null;
        }
      } else {
        minRear = Math.min(minRear, gap);
        const minReq = tr.kind === "police" ? 0.95 : 0.65;
        if (!(backingAway && gap >= Math.min(0.08, tr.startGap - 0.005)) && gap < minReq) {
          return null;
        }
      }
    }
    for (const pt of model.rearRayPoints) {
      const gap = boxGapToPoint(pose, pt.x, pt.z, halfW, halfL);
      const backingAway = pt.forwardM > 0 && gap >= pt.startGap - 0.01;
      if (pt.kind === "pedestrian") {
        minPed = Math.min(minPed, gap);
        if (!(pt.forwardM > halfL * 0.8 && gap >= pt.startGap + 0.02 && gap >= 0.60) && gap < 1.20) {
          return null;
        }
      } else {
        minRear = Math.min(minRear, gap);
        const minReq = pt.kind === "police" ? 0.85 : 0.58;
        if (!(backingAway && gap >= Math.min(0.08, pt.startGap - 0.005)) && gap < minReq) {
          return null;
        }
      }
    }
  }
  const travelM = distance(player, pose);
  return { action: cand, minRear, minPed, travelM };
}

function searchReversePivot(world, model) {
  const openLeft = model.frontLeftClear >= model.frontRightClear;
  const preferredSign = openLeft ? 1 : -1;
  const steerOrder = [
    preferredSign * 1.0, preferredSign * 0.70, preferredSign * 0.35, 0,
    -preferredSign * 0.35, -preferredSign * 0.70, -preferredSign * 1.0,
  ];

  let best = null;
  for (const steer of steerOrder) {
    for (const throttle of [0.78, 0.50]) {
      const evaluated = evaluateReverseCandidate(world, model, { steer, gear: -1, throttle, brake: 0 });
      if (!evaluated) continue;
      const alignBonus = Math.sign(steer) === preferredSign ? 0.9 : 0;
      const score = evaluated.travelM * 2.4 + Math.min(evaluated.minRear, 4.0) * 2.5 +
        Math.min(evaluated.minPed, 3.0) * 3.0 + alignBonus;
      if (!best || score > best.score) best = { action: evaluated.action, score };
      break;
    }
  }
  return best;
}

function coastStaysSupported(world, cand, steps = 7) {
  const { player } = world;
  if (!poseSupported(world, player).supported) return true;
  let pose = initRolloutPose(player);
  for (let i = 0; i < steps; i++) {
    pose = stepPoseWithSlip(pose, cand, 0.12);
    if (!poseSupported(world, pose).supported) return false;
  }
  return true;
}

function synthesizeGuardConflict(model, guardReason, speed) {
  if (!guardReason) return null;
  let minForward = Infinity;
  for (const pt of model.forwardRayPoints) {
    if (pt.kind === guardReason && pt.forwardM > 0 && pt.rangeM < minForward) minForward = pt.rangeM;
  }
  for (const tr of model.tracks) {
    if (tr.kind === guardReason && tr.forwardM > 0 && tr.forwardM < minForward) minForward = tr.forwardM;
  }
  const seconds = Number(clamp(minForward / Math.max(2, speed), 0.2, 4.0).toFixed(2));
  return { seconds, kind: guardReason, trackId: null, motionKnown: false };
}

function smoothGasBrakeTransition(action, lastAction, speed, urgent) {
  if (!lastAction || action.gear !== lastAction.gear || action.gear !== 1) return action;
  // Smooth brake -> throttle release via brief light feathering to prevent harsh chatter.
  if (lastAction.brake > 0.15 && action.throttle > 0.15 && action.brake === 0) {
    return { ...stripNitro(action), throttle: 0.12, brake: 0 };
  }
  // Smooth throttle -> non-urgent brake transition via progressive light braking.
  if (!urgent && lastAction.throttle > 0.15 && action.brake > 0.15 && action.brake <= 0.45) {
    return { ...stripNitro(action), throttle: 0, brake: 0.12 };
  }
  return action;
}

function smoothSteerAction(world, scan, action, memory, emergency) {
  if (!memory.lastAction || action.gear !== memory.lastAction.gear) return action;
  const elapsed = Math.max(STEP, (world.tick - memory.tick) * STEP);
  const maxRate = emergency ? 4.0 : 2.4;
  const maxDelta = elapsed * maxRate;
  const steer = clamp(action.steer, memory.lastAction.steer - maxDelta, memory.lastAction.steer + maxDelta);
  if (Math.abs(steer - action.steer) < 1e-4) return action;
  const smooth = { ...action, steer };
  if (smooth.brake > 0) {
    return guardDispatchAction(world, smooth).reason ? action : smooth;
  }
  if (!predictEscapeConflict(world.player, scan, smooth) && !guardDispatchAction(world, smooth).reason) {
    return smooth;
  }
  return action;
}

export function planSmartEscapeAction(world, requestedAction) {
  const scan = requireDispatchScan(world);
  const { player } = world;
  const key = world.pursuit ?? player;
  let memory = memories.get(key);
  if (!memory || world.tick < memory.tick) {
    memory = {
      tick: world.tick,
      goal: null,
      bestDistanceM: Infinity,
      progressTick: world.tick,
      lastAction: null,
      brakeUntil: -1,
      brakeHoldUntil: -1,
      brakeConflict: null,
      evadeSide: 0,
      evadeUntil: -1,
      lowSpeedTicks: 0,
      reverseRecovery: null,
      reverseCooldownUntil: -1,
      corridorBlocked: false,
    };
    memories.set(key, memory);
  }

  const dtTicks = Math.max(1, world.tick - memory.tick);
  if (world.tick > 30 && Math.abs(player.speed) < 1.0) {
    memory.lowSpeedTicks += dtTicks;
  } else if (Math.abs(player.speed) >= 2.2) {
    memory.lowSpeedTicks = 0;
  }

  const remaining = memory.goal ? distance(player, memory.goal) : Infinity;
  if (remaining < memory.bestDistanceM - 4) {
    memory.bestDistanceM = remaining;
    memory.progressTick = world.tick;
  }
  const corridorBlocker = player.vehicleModel === "king-long-microbus" ? null : forwardPoliceBlocker(scan);
  const newlyBlockedCorridor = Boolean(corridorBlocker) && !memory.corridorBlocked;
  memory.corridorBlocked = Boolean(corridorBlocker);
  if (!memory.goal || remaining < 18 || newlyBlockedCorridor ||
      world.tick - memory.progressTick > Math.round(14 / STEP)) {
    const goal = selectSensorEscapeGoal(world, scan, memory.goal);
    if (goal) {
      memory.goal = goal;
      memory.bestDistanceM = distance(player, goal);
      memory.progressTick = world.tick;
    }
  }
  if (memory.goal && world.pursuit?.gta) world.pursuit.gta.escapeGoal = memory.goal;

  const model = collectObstacleModel(player, scan);
  const planned = planPakoEvasiveAction(world, requestedAction);
  const route = smartRouteAction(world, model.frontSightM);
  const closePolicePocket = !route && model.policeThreats.some(
    threat => Math.hypot(player.x - threat.x, player.z - threat.z) < 12,
  );
  const pedSuppressed = Boolean(planned.nitroSuppressedByPedestrian || model.pedCaution);

  const desiredHeading = route?.targetHeading ??
    (memory.goal ? Math.atan2(memory.goal.x - player.x, memory.goal.z - player.z) : player.heading);
  const lastSteer = memory.lastAction?.steer ?? (player.steer ?? 0) / (player.spec?.maxSteer ?? VEHICLE.maxSteer);
  const activeEvadeSide = world.tick < memory.evadeUntil ? memory.evadeSide : 0;
  const nearbyStatics = world.staticIndex?.near
    ? world.staticIndex.near(player, 54)
    : (world.statics ?? []).filter(s => distance(player, s) <= 54);
  const nearStatics = nearbyStatics.filter(
    s => SOLID_PROP_KINDS.includes(s.kind),
  ).map(s => ({
    body: s,
    pole: true,
    startDistanceM: distance(player, s),
    overlappingAtStart: overlaps(player, s, 0.18),
  }));
  const ctx = {
    desiredHeading,
    lastSteer,
    nominalSteer: route ? route.action.steer : planned.action.steer,
    evadeSide: activeEvadeSide,
    startSupported: poseSupported(world, player).supported,
    nearStatics,
  };

  // 1. Continue an active reverse-pivot recovery unless a clean forward exit has opened.
  if (memory.reverseRecovery) {
    const rev = memory.reverseRecovery;
    const revAge = world.tick - rev.startedTick;
    let exitForward = null;
    if (world.tick >= (rev.minExitTick ?? rev.startedTick + Math.round(0.35 / STEP))) {
      const cand = searchPoweredEvasiveCorridor(world, scan, model, ctx.nominalSteer, ctx);
      if (cand && cand.endSpeed > 1.2 && cand.travelM > 0.9 && cand.minVehClearance > 0.60 &&
          cand.minPedClearance > 1.35 && cand.minStaticClearance > 0.45) {
        exitForward = cand;
      }
    }
    let revCand = { steer: rev.steer, gear: -1, throttle: rev.throttle ?? 0.72, brake: 0 };
    let revStillSafe = Boolean(evaluateReverseCandidate(world, model, revCand));
    if (!revStillSafe && !exitForward && world.tick < rev.untilTick) {
      const altRev = searchReversePivot(world, model);
      if (altRev) {
        rev.steer = altRev.action.steer;
        rev.throttle = altRev.action.throttle;
        revCand = altRev.action;
        revStillSafe = true;
      }
    }
    if (exitForward || world.tick >= rev.untilTick || !revStillSafe) {
      memory.reverseRecovery = null;
      const cooldownS = exitForward ? 1.5 : (revAge < 18 ? 0.15 : 0.70);
      memory.reverseCooldownUntil = world.tick + Math.round(cooldownS / STEP);
      if (exitForward) {
        memory.lowSpeedTicks = 0;
        const finalAct = smoothSteerAction(world, scan, exitForward.action, memory, true);
        const checked = guardDispatchAction(world, finalAct);
        memory.lastAction = checked.action;
        memory.tick = world.tick;
        return {
          ...planned,
          controller: SMART_ESCAPE_CONTROL,
          action: checked.action,
          reason: checked.reason ?? "PREDICTIVE_EVADE_LANE",
          maneuver: "unstuck-forward-launch",
          nitroSuppressedByPedestrian: pedSuppressed,
          escapeDestination: memory.goal,
          predictedConflict: null,
          routeTracking: route,
        };
      }
    } else {
      const revChecked = guardDispatchAction(world, revCand);
      memory.lastAction = revChecked.action;
      memory.tick = world.tick;
      return {
        ...planned,
        controller: SMART_ESCAPE_CONTROL,
        action: revChecked.action,
        reason: "PREDICTIVE_REVERSE_ESCAPE",
        maneuver: "unstuck-reverse-pivot",
        nitroSuppressedByPedestrian: pedSuppressed,
        escapeDestination: memory.goal,
        predictedConflict: null,
        routeTracking: route,
      };
    }
  }

  const speed = Math.max(0, player.speed);
  const braking = Math.max(4.0, player.spec?.braking ?? VEHICLE.braking);

  // 2. Build nominal forward action (prefer smooth route tracking when available).
  let nominal = stripNitro(planned.action);
  let usingRoute = false;
  let allowNitro = Boolean(planned.action.nitro) && !pedSuppressed &&
    braking >= 7.0 && model.frontSightM >= 30;
  if (route && planned.reason !== "PREDICTIVE_REVERSE_ESCAPE") {
    nominal = { ...route.action };
    usingRoute = true;
    allowNitro = allowNitro &&
      route.action.brake === 0 &&
      route.curveTargetSpeedMps >= (player.maxSpeed ?? 28) - 2.0 &&
      Math.abs(route.action.steer) < 0.18;
    if (allowNitro) nominal = { ...nominal, throttle: 1 };
  } else if (planned.reason === "PREDICTIVE_REVERSE_ESCAPE" && !guardDispatchAction(world, nominal).reason) {
    allowNitro = false;
  }

  // Respect sensor sightline speed cap even when not using route tracking (except guard-verified nitro bursts).
  if (!allowNitro && nominal.gear === 1 && nominal.brake === 0 && speed > model.sightSpeedCap + 0.8) {
    nominal = { ...nominal, throttle: speed > model.sightSpeedCap + 1.8 ? 0 : Math.min(nominal.throttle, 0.25) };
  }

  const nominalConflict = nominal.gear === 1 ? predictEscapeConflict(player, scan, nominal) : null;
  const nominalGuard = guardDispatchAction(world, nominal);
  const nominalPedGap = nominal.gear === 1 ? nominalPedestrianClearance(player, model, nominal) : Infinity;
  const pedTooClose = nominalPedGap < 2.25;
  const wasBraking = Boolean(memory.lastAction && memory.lastAction.brake > 0.15);
  const needsCorridorSearch =
    nominal.gear !== 1 ||
    Boolean(nominalConflict) ||
    Boolean(nominalGuard.reason) ||
    pedTooClose ||
    nominal.brake > 0.05 ||
    planned.reason === "SAFETY_INTERVENTION" ||
    activeEvadeSide !== 0 ||
    wasBraking ||
    memory.lowSpeedTicks >= 18;

  let action = nominal;
  let reason = nominalGuard.reason ?? (usingRoute ? null : planned.reason);
  let maneuver = usingRoute ? "route-cruise" : planned.maneuver;
  let reportedConflict = nominalConflict;
  let emergencySteer = false;

  if (!needsCorridorSearch) {
    memory.brakeUntil = -1;
    memory.brakeHoldUntil = -1;
    memory.brakeConflict = null;
    if (allowNitro) action = { ...action, nitro: planned.action.nitro };
    action = smoothGasBrakeTransition(action, memory.lastAction, speed, false);
    action = smoothSteerAction(world, scan, action, memory, false);
  } else {
    const powered = searchPoweredEvasiveCorridor(world, scan, model, ctx.nominalSteer, ctx);

    // If we are stuck at low speed and forward only offers a tiny blocked creep, break out with reverse-pivot.
    const stuckWithPoorForward =
      world.tick >= memory.reverseCooldownUntil &&
      memory.lowSpeedTicks >= 30 &&
      (!powered || powered.travelM < 0.75);
    const reverseBreakout = stuckWithPoorForward ? searchReversePivot(world, model) : null;

    // Brief brake-hold hysteresis only while the nominal conflict is still active and
    // the alternate powered corridor is tight; never self-extend or lock into false braking.
    const holdBrakeBriefly = Boolean(
      wasBraking &&
      powered &&
      world.tick < memory.brakeHoldUntil &&
      nominalConflict &&
      speed > 2.0 &&
      (powered.minVehClearance < 0.72 || powered.minPedClearance < 1.45),
    );

    if (reverseBreakout) {
      memory.reverseRecovery = {
        steer: reverseBreakout.action.steer,
        throttle: reverseBreakout.action.throttle,
        startedTick: world.tick,
        minExitTick: world.tick + Math.round((closePolicePocket ? 2.2 : 0.35) / STEP),
        untilTick: world.tick + Math.round((closePolicePocket ? 3.2 : 0.75) / STEP),
      };
      memory.brakeUntil = -1;
      memory.brakeHoldUntil = -1;
      memory.brakeConflict = null;
      action = reverseBreakout.action;
      reason = "PREDICTIVE_REVERSE_ESCAPE";
      maneuver = "unstuck-reverse-pivot";
    } else if (powered && !holdBrakeBriefly) {
      const turnOverspeed = powered.safeTurnSpeed !== undefined && speed > powered.safeTurnSpeed + 1.4;
      const tightPedSqueeze = nominalConflict?.kind === "pedestrian" &&
        powered.minPedClearance < 1.9 && speed > 7.5;
      const needTurnInBrake = Boolean(
        nominalConflict &&
        nominalConflict.seconds >= 0.5 &&
        nominalConflict.seconds <= 2.35 &&
        (turnOverspeed || tightPedSqueeze),
      );

      if (needTurnInBrake) {
        const excess = Math.max(0.8, speed - (powered.safeTurnSpeed ?? 8.0));
        const trailBrake = clamp(excess / 6.5, 0.13, 0.36);
        action = { steer: powered.action.steer, gear: 1, throttle: 0, brake: trailBrake };
        action = smoothGasBrakeTransition(action, memory.lastAction, speed, nominalConflict.seconds < 1.15);
        if (action.brake > 0.15) {
          memory.brakeHoldUntil = Math.max(memory.brakeHoldUntil, world.tick + Math.round(0.18 / STEP));
        }
        reason = "PREDICTIVE_TRAFFIC_BRAKE";
        maneuver = "evasive-turn-in-brake";
        emergencySteer = true;
      } else {
        action = powered.action;
        if (allowNitro && !nominalConflict && !pedTooClose &&
            Math.abs(action.steer) < 0.15 && action.throttle >= 0.85 && action.brake === 0) {
          action = { ...action, nitro: planned.action.nitro };
        }
        action = smoothGasBrakeTransition(action, memory.lastAction, speed, false);
        reason = Math.abs(action.steer - ctx.nominalSteer) > 0.12
          ? "PREDICTIVE_EVADE_LANE"
          : (planned.reason === "SAFETY_INTERVENTION" ? "PREDICTIVE_EVADE_LANE" : (usingRoute ? null : planned.reason));
        maneuver = pedTooClose ? "early-pedestrian-bypass" : "powered-evade-corridor";
        emergencySteer = Boolean(nominalConflict || nominalGuard.reason);
        memory.brakeUntil = -1;
        memory.brakeHoldUntil = -1;
        memory.brakeConflict = null;
      }

      if (Math.abs(powered.action.steer - ctx.nominalSteer) > 0.12) {
        memory.evadeSide = Math.sign(powered.action.steer - ctx.nominalSteer);
        memory.evadeUntil = world.tick + Math.round(0.55 / STEP);
      } else if (!nominalConflict && !pedTooClose) {
        memory.evadeSide = 0;
        memory.evadeUntil = -1;
      }
      action = smoothSteerAction(world, scan, action, memory, emergencySteer);
    } else if (holdBrakeBriefly) {
      const needed = speed / Math.max(0.25, nominalConflict.seconds - 0.45);
      const brake = clamp(needed / braking, 0.22, 0.75);
      action = smoothSteerAction(world, scan, { steer: powered.action.steer, gear: 1, throttle: 0, brake }, memory, true);
      reason = "PREDICTIVE_TRAFFIC_BRAKE";
      maneuver = "anticipatory-yield";
    } else {
      // No safe powered forward corridor exists (or holding brake hysteresis).
      // Try reverse-pivot if wedged, else proportional brake.
      const shouldUnstuck =
        world.tick >= memory.reverseCooldownUntil &&
        (memory.lowSpeedTicks >= 18 ||
          (Math.abs(player.speed) < 0.65 && memory.lowSpeedTicks >= 12));
      const reversePivot = shouldUnstuck ? searchReversePivot(world, model) : null;

      if (reversePivot) {
        memory.reverseRecovery = {
          steer: reversePivot.action.steer,
          throttle: reversePivot.action.throttle,
          startedTick: world.tick,
          minExitTick: world.tick + Math.round((closePolicePocket ? 2.2 : 0.35) / STEP),
          untilTick: world.tick + Math.round((closePolicePocket ? 3.2 : 0.75) / STEP),
        };
        memory.brakeUntil = -1;
        memory.brakeHoldUntil = -1;
        memory.brakeConflict = null;
        action = reversePivot.action;
        reason = "PREDICTIVE_REVERSE_ESCAPE";
        maneuver = "unstuck-reverse-pivot";
      } else if (planned.reason === "PREDICTIVE_REVERSE_ESCAPE" && !nominalGuard.reason &&
          Boolean(searchReversePivot(world, model))) {
        memory.brakeUntil = -1;
        memory.brakeHoldUntil = -1;
        memory.brakeConflict = null;
        action = nominal;
        reason = "PREDICTIVE_REVERSE_ESCAPE";
        maneuver = planned.maneuver;
      } else {
        const planned4 = stripNitro(planned.action);
        const plannedSafeEscape =
          memory.lowSpeedTicks >= 18 &&
          planned4.brake === 0 &&
          planned4.throttle > 0.1 &&
          planned.reason !== "SAFETY_INTERVENTION" &&
          !guardDispatchAction(world, planned4).reason &&
          (planned4.gear === -1
            ? Boolean(evaluateReverseCandidate(world, model, planned4))
            : !predictEscapeConflict(player, scan, planned4));
        if (plannedSafeEscape) {
          memory.brakeUntil = -1;
          memory.brakeHoldUntil = -1;
          memory.brakeConflict = null;
          action = smoothGasBrakeTransition(planned4, memory.lastAction, speed, false);
          action = smoothSteerAction(world, scan, action, memory, true);
          reason = planned.reason ?? "PREDICTIVE_EVADE_LANE";
          maneuver = planned.maneuver ?? "evasive-fallback";
        } else {
        const guardConflict = nominalGuard.reason
          ? synthesizeGuardConflict(model, nominalGuard.reason, speed)
          : null;
        const bestConflict = nominalConflict || guardConflict;
        if (bestConflict) {
          memory.brakeUntil = world.tick + Math.round(0.24 / STEP);
          memory.brakeConflict = bestConflict;
        }
        const activeConflict = bestConflict ||
          (world.tick < memory.brakeUntil && speed > 0.35 ? memory.brakeConflict : null);
        reportedConflict = activeConflict;
        if (activeConflict) {
          const needed = speed / Math.max(0.25, activeConflict.seconds - 0.45);
          const brake = clamp(needed / braking, 0.25, 1);
          const chosenBrake = chooseBestBrakingSteer(world, model, ctx.nominalSteer, lastSteer, brake);
          let brakeAct = { steer: chosenBrake.steer, gear: 1, throttle: 0, brake };
          brakeAct = smoothGasBrakeTransition(
            brakeAct,
            memory.lastAction,
            speed,
            activeConflict.seconds <= 1.35 || brake > 0.45,
          );
          if (brakeAct.brake > 0.15) {
            memory.brakeHoldUntil = Math.max(memory.brakeHoldUntil, world.tick + Math.round(0.24 / STEP));
          }
          action = chosenBrake.minOther < 0.70 || chosenBrake.minPed < 1.10
            ? brakeAct
            : smoothSteerAction(world, scan, brakeAct, memory, true);
          reason = "PREDICTIVE_TRAFFIC_BRAKE";
          maneuver = "anticipatory-yield";
        } else if (nominal.gear === 1 && !nominalGuard.reason && !nominalConflict && model.frontSightM > 14 &&
            coastStaysSupported(world, { steer: nominal.steer, gear: 1, throttle: 0, brake: 0 })) {
          // Corridor search rejected aggressive steers (e.g. near a tight curb), but coasting stays on-road
          // and the road ahead is clear: coast smoothly instead of triggering a false hard brake.
          const coastAct = speed > 3.5
            ? { steer: nominal.steer, gear: 1, throttle: 0, brake: 0 }
            : (planned.action.gear === 1 && !guardDispatchAction(world, stripNitro(planned.action)).reason
              ? stripNitro(planned.action)
              : { steer: nominal.steer, gear: 1, throttle: 0, brake: 0 });
          action = smoothGasBrakeTransition(coastAct, memory.lastAction, speed, false);
          action = smoothSteerAction(world, scan, action, memory, false);
          reason = null;
          maneuver = "smooth-coast";
        } else {
          const brake = speed > 0.5 ? 0.65 : 1;
          const safeSteer = chooseBestBrakingSteer(world, model, ctx.nominalSteer, lastSteer, brake).steer;
          const closestKind = model.forwardRayPoints.reduce(
            (best, pt) => (pt.forwardM > 0 && pt.rangeM < best.rangeM ? pt : best),
            { kind: "static", rangeM: model.frontSightM },
          ).kind;
          reportedConflict = synthesizeGuardConflict(model, nominalGuard.reason ?? closestKind, speed);
          memory.brakeHoldUntil = Math.max(memory.brakeHoldUntil, world.tick + Math.round(0.24 / STEP));
          action = smoothSteerAction(world, scan, { steer: safeSteer, gear: 1, throttle: 0, brake }, memory, true);
          reason = nominalGuard.reason ?? "SAFETY_INTERVENTION";
          maneuver = "guarded-yield";
        }
        }
      }
    }
  }

  if (pedSuppressed || reportedConflict?.kind === "pedestrian") {
    action = stripNitro(action);
  }
  const checked = guardDispatchAction(world, action);
  if (checked.reason && !reportedConflict) {
    reportedConflict = synthesizeGuardConflict(model, checked.reason, speed);
  }
  memory.lastAction = checked.action;
  memory.tick = world.tick;
  return {
    ...planned,
    controller: SMART_ESCAPE_CONTROL,
    action: checked.action,
    reason: checked.reason ?? reason,
    maneuver,
    nitroSuppressedByPedestrian: pedSuppressed || reportedConflict?.kind === "pedestrian",
    escapeDestination: memory.goal,
    predictedConflict: reportedConflict,
    routeTracking: route,
  };
}
