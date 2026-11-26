import { STEP, VEHICLE } from "../core/config.js";
import { bodyOnRoad, sweepSafe } from "../core/geometry.js";
import { METRO_CITY_CURBS, isPoseSupportedWithCurbs, sweepSafeWithCurbs } from "../core/pako-curb.js";
import { integrateVehicle, vehicleProbe } from "../core/vehicle.js";
import { integrateGtaSlip } from "../core/pursuit-gta.js";
import { pursuitCommand } from "../core/pursuit-controls.js";
import { PURSUIT_SCAN_RAYS, PURSUIT_SCAN_RANGE_M, PURSUIT_SCAN_TICKS, PURSUIT_TRACK_TTL_S }
  from "../signal_processing/pursuit-scanner.js";

const kinds = new Set(["static", "civilian", "pedestrian", "police"]);
const verifiedFrames = new WeakSet();
const trafficHistory = new WeakMap();
const angleStep = Math.PI * 2 / PURSUIT_SCAN_RAYS;
const LOCAL_NITRO_SPEC = Object.freeze({
  speedMultiplier: 1.34,
  accelMultiplier: 1.72,
  maxBoostSpeedMps: 38.5,
  minEngageCharge: 0.18,
});

function stripNitro(action) {
  if (!action || !Object.prototype.hasOwnProperty.call(action, "nitro")) return action;
  const { steer, throttle, brake, gear } = action;
  return { steer, throttle, brake, gear };
}

function boostAwarePursuitCommand(pose, action, dt = STEP) {
  const base4 = stripNitro(action);
  if ((action?.nitro ?? 0) >= 0.5 && base4.brake === 0 && base4.gear === 1 && base4.throttle > 0) {
    const baseMaxSpeed = pose.maxSpeed ?? 9.72;
    const boostedMaxSpeed = Math.min(
      LOCAL_NITRO_SPEC.maxBoostSpeedMps,
      baseMaxSpeed * LOCAL_NITRO_SPEC.speedMultiplier,
    );
    const baseAccel = pose.spec?.acceleration ?? VEHICLE.acceleration;
    const boostedPose = {
      ...pose,
      maxSpeed: boostedMaxSpeed,
      spec: { ...(pose.spec ?? VEHICLE), acceleration: baseAccel * LOCAL_NITRO_SPEC.accelMultiplier },
    };
    return pursuitCommand(boostedPose, base4, dt);
  }
  return pursuitCommand(pose, base4, dt);
}

function hasPedestrianNitroHazard(world, scan, reach) {
  const { player, visualState } = world;
  const halfW = (player.width ?? 1.85) * 0.5;
  const inHazardZone = (right, forward) => {
    if (!Number.isFinite(right) || !Number.isFinite(forward)) return false;
    if (Math.hypot(right, forward) <= Math.max(14.0, reach + 4)) return true;
    return (
      forward >= -1.0 &&
      forward <= 42.0 &&
      Math.abs(right) <= halfW + 4.8 + Math.max(0, forward) * 0.16
    );
  };

  for (let i = 0; i < scan.rays.length; i++) {
    const ray = scan.rays[i];
    if (ray.kind !== "pedestrian") continue;
    const angle = i * angleStep;
    if (inHazardZone(ray.rangeM * Math.sin(angle), ray.rangeM * Math.cos(angle))) return true;
  }
  for (const track of scan.tracks) {
    if (track.kind !== "pedestrian") continue;
    if (inHazardZone(track.rightM, track.forwardM)) return true;
    if (track.motionKnown && track.ageS === 0) {
      const vx = track.rightMps + (player.gtaSlipMps ?? 0);
      const vz = track.forwardMps + (player.speed ?? 0);
      if (Math.hypot(vx, vz) <= 5.5) {
        for (const t of [0.4, 0.9, 1.4]) {
          if (inHazardZone(track.rightM + vx * t, track.forwardM + vz * t)) return true;
        }
      }
    }
  }
  if (visualState && visualState.available !== false) {
    if (visualState.decision?.available === true && visualState.decision.brake === true) return true;
    const c0 = Math.cos(player.heading ?? 0);
    const s0 = Math.sin(player.heading ?? 0);
    if (Array.isArray(visualState.forecasts)) {
      for (const item of visualState.forecasts) {
        if (!item || (item.label && item.label !== "person") || item.qualified === false) continue;
        if (Array.isArray(item.points)) {
          for (const pt of item.points) {
            if ((pt?.secondsAhead ?? 0) > 1.6 + 1e-6) continue;
            const wx = pt?.x ?? pt?.xM;
            const wz = pt?.z ?? pt?.zM;
            if (Number.isFinite(wx) && Number.isFinite(wz)) {
              const dx = wx - player.x, dz = wz - player.z;
              if (inHazardZone(dx * c0 - dz * s0, dx * s0 + dz * c0)) return true;
            } else if (inHazardZone(pt?.rightM, pt?.forwardM)) return true;
          }
        }
        const wx = item.x ?? item.xM, wz = item.z ?? item.zM;
        if (Number.isFinite(wx) && Number.isFinite(wz)) {
          const dx = wx - player.x, dz = wz - player.z;
          if (inHazardZone(dx * c0 - dz * s0, dx * s0 + dz * c0)) return true;
        } else if (inHazardZone(item.lateralM ?? item.rightM, item.longitudinalM ?? item.forwardM)) {
          return true;
        }
      }
    }
    if (Array.isArray(visualState.tracks)) {
      for (const tr of visualState.tracks) {
        if (!tr || (tr.label && tr.label !== "person")) continue;
        const wx = tr.position?.x ?? tr.x ?? tr.xM;
        const wz = tr.position?.z ?? tr.z ?? tr.zM;
        if (Number.isFinite(wx) && Number.isFinite(wz)) {
          const dx = wx - player.x, dz = wz - player.z;
          if (inHazardZone(dx * c0 - dz * s0, dx * s0 + dz * c0)) return true;
        } else if (inHazardZone(tr.lateralM ?? tr.rightM, tr.longitudinalM ?? tr.forwardM)) {
          return true;
        }
      }
    }
  }
  return false;
}

export function requireDispatchScan({ pursuit, tick }) {
  const scan = pursuit?.gta?.scan;
  const ageTicks = tick - scan?.tick;
  if (!scan || !Number.isSafeInteger(scan.tick) || scan.tick < 0 ||
      !Number.isInteger(ageTicks) || ageTicks < 0 || ageTicks >= PURSUIT_SCAN_TICKS)
    throw Object.assign(new Error("Pursuit brake guard needs a current scan"), { code: "STALE_OBSERVATION" });
  if (!verifiedFrames.has(scan)) {
    if (!Object.isFrozen(scan) || !Array.isArray(scan.rays) || !Object.isFrozen(scan.rays) ||
        scan.rays.length !== PURSUIT_SCAN_RAYS || !Array.isArray(scan.tracks) || !Object.isFrozen(scan.tracks) ||
        scan.rays.some(ray => !ray || !Object.isFrozen(ray) ||
          (ray.kind !== "none" && !kinds.has(ray.kind)) ||
          !Number.isFinite(ray.rangeM) || ray.rangeM < 0 || ray.rangeM > PURSUIT_SCAN_RANGE_M) ||
        scan.tracks.some(track => !track || !Object.isFrozen(track) || !kinds.has(track.kind) ||
          ![track.rightM, track.forwardM, track.rightMps, track.forwardMps, track.ageS].every(Number.isFinite) ||
          track.ageS < 0 || track.ageS > PURSUIT_TRACK_TTL_S || typeof track.motionKnown !== "boolean" ||
          (track.ttcS !== null && (!Number.isFinite(track.ttcS) || track.ttcS < 0))))
      throw new Error("Malformed pursuit scan");
    verifiedFrames.add(scan);
  }
  return scan;
}

function nearObservedSegment(point, frame) {
  for (let i = 0; i < frame.length; i++) {
    const a = frame[i], b = frame[(i + 1) % frame.length];
    if (!a || !b) continue;
    const dx = b.x - a.x, dz = b.z - a.z, length = Math.hypot(dx, dz);
    if (length < .02 || length > .9) continue;
    const t = ((point.x - a.x) * dx + (point.z - a.z) * dz) / (length * length);
    if (t >= -.14 / length && t <= 1 + .14 / length &&
        Math.hypot(a.x + t * dx - point.x, a.z + t * dz - point.z) <= .075) return true;
  }
  return false;
}

function measuredLoadingTraffic(world, scan) {
  if (world.tick !== scan.tick) return null;
  const { player, pursuit } = world;
  const old = trafficHistory.get(pursuit);
  if (old?.tick === scan.tick) return old;
  const frames = old?.tick === scan.tick - PURSUIT_SCAN_TICKS ? old.frames.slice(-2) : [];
  const points = scan.rays.map((ray, i) => {
    if (ray.kind !== "civilian" || ray.rangeM > 14) return null;
    const heading = player.heading + i * angleStep;
    return { x: player.x + Math.sin(heading) * ray.rangeM, z: player.z + Math.cos(heading) * ray.rangeM };
  });
  // Compare returns in a common odometry frame, not changing ray indices or
  // simulator vehicle centers. A changing or occluded face stays uncertain.
  const current = { tick: scan.tick, frames: [...frames, points], stable: i => {
    const point = points[i];
    return Boolean(point && frames.length === 2 && frames.every(frame => nearObservedSegment(point, frame)));
  } };
  trafficHistory.set(pursuit, current);
  return current;
}

function pointToBoxDistance(px, pz, box) {
  const dx = px - box.x, dz = pz - box.z;
  const c = Math.cos(box.heading ?? 0), s = Math.sin(box.heading ?? 0);
  const right = Math.abs(dx * c - dz * s) - box.width / 2;
  const forward = Math.abs(dx * s + dz * c) - box.length / 2;
  if (right <= 0 && forward <= 0) return Math.max(right, forward);
  return Math.hypot(Math.max(0, right), Math.max(0, forward));
}

const sweepReturnsCache = new WeakMap();

function getCachedSweepReturns(scan, player, startProbe, reach, includeTraffic, cityCurbs, ignorePedCollision) {
  let byKey = sweepReturnsCache.get(scan);
  if (!byKey) {
    byKey = new Map();
    sweepReturnsCache.set(scan, byKey);
  }
  const key = `${reach}:${includeTraffic ? 1 : 0}:${cityCurbs ? 1 : 0}:${ignorePedCollision ? 1 : 0}:${player.x}:${player.z}:${player.heading}`;
  let cached = byKey.get(key);
  if (cached) return cached;
  const returns = [];
  const alreadyClose = [];
  const halfSin = Math.sin(angleStep / 2);
  for (let i = 0; i < scan.rays.length; i++) {
    const ray = scan.rays[i];
    if (ray.kind === "none" || (ignorePedCollision && ray.kind === "pedestrian") || (ray.kind !== "static" && !includeTraffic) ||
        ray.rangeM > reach + player.length + 2) continue;
    const heading = player.heading + i * angleStep;
    const point = {
      type: "pedestrian",
      kind: ray.kind,
      radius: (cityCurbs ? (ray.kind === "pedestrian" ? .06 : .01) : .10) + ray.rangeM * halfSin +
        (ray.kind === "static" ? 0 : cityCurbs ? (ray.kind === "pedestrian" ? .28 : .01) : .18),
      x: player.x + Math.sin(heading) * ray.rangeM,
      z: player.z + Math.cos(heading) * ray.rangeM,
    };
    const startBoxDist = cityCurbs && ray.kind !== "pedestrian"
      ? pointToBoxDistance(point.x, point.z, startProbe)
      : Infinity;
    if (cityCurbs && ray.kind !== "pedestrian" && startBoxDist <= point.radius + .22) {
      alreadyClose.push({ point, startBoxDist });
    } else {
      returns.push(point);
    }
  }
  cached = { returns, alreadyClose };
  if (byKey.size >= 8) byKey.clear();
  byKey.set(key, cached);
  return cached;
}

function stoppingSweep(world, scan, requested, reaction, reach, includeTraffic) {
  const { player } = world;
  const ignorePedCollision = Boolean(world?.pursuit?.frozenDriver?._faultIgnorePedestrianCollisionOnly);
  const curb = world.pursuit?.gta?.curb;
  const cityCurbs = curb?.mode === METRO_CITY_CURBS;
  const startProbe = vehicleProbe(player, player.speed);
  const { returns, alreadyClose } = getCachedSweepReturns(
    scan,
    player,
    startProbe,
    reach,
    includeTraffic,
    cityCurbs,
    ignorePedCollision,
  );
  const brake = { ...stripNitro(requested), throttle: 0, brake: 1 };
  const delayTicks = Math.ceil(reaction / STEP);
  const brakingDecel = Math.max(4, player.spec?.braking ?? VEHICLE.braking);
  const maxSweepTicks = Math.max(
    180,
    delayTicks + Math.ceil((Math.abs(player.speed ?? 0) + 12) / (brakingDecel * STEP)) + 20,
  );
  let pose = { ...startProbe, gtaSlipMps: player.gtaSlipMps, gtaYawRate: player.gtaYawRate };
  for (let ticksElapsed = 0; ticksElapsed < maxSweepTicks;) {
    const strideTicks = cityCurbs && ticksElapsed >= delayTicks + 4 ? 2 : 1;
    const dt = strideTicks * STEP;
    const action = ticksElapsed < delayTicks ? requested : brake;
    const next = integrateVehicle(pose, boostAwarePursuitCommand(pose, action, dt), dt);
    for (let k = 0; k < strideTicks; k++) integrateGtaSlip(k === 0 ? pose : next, next);
    ticksElapsed += strideTicks;
    if (cityCurbs) {
      if (Math.hypot(next.speed, next.gtaSlipMps ?? 0) > curb.maxPace + 1e-6 &&
          !bodyOnRoad(next, world.roads))
        return false;
      if (!sweepSafeWithCurbs(pose, next, returns, world.roads, curb).safe) return false;
      const sheddingOpposite = (player.speed ?? 0) * requested.gear < 0 && next.speed * (player.speed ?? 0) > 0;
      for (const item of alreadyClose) {
        const prevD = pointToBoxDistance(item.point.x, item.point.z, pose);
        const nextD = pointToBoxDistance(item.point.x, item.point.z, next);
        if (nextD < Math.min(0, item.startBoxDist) - .003) return false;
        if (!sheddingOpposite && nextD < prevD - .005 && nextD < item.startBoxDist - .006) return false;
      }
    } else if (!sweepSafe(pose, next, returns, world.roads).safe) return false;
    if (ticksElapsed >= delayTicks && Math.abs(next.speed) < .02 && Math.abs(next.gtaSlipMps) < .02) return true;
    pose = next;
  }
  return false;
}

function evaluateGuardCandidate(world, scan, ageTicks, evidence, candidate) {
  const { player } = world;
  const speed = Math.abs(player.speed), direction = speed > .1 ? Math.sign(player.speed) : candidate.gear;
  const braking = player.spec?.braking ?? VEHICLE.braking;
  const reaction = (ageTicks + PURSUIT_SCAN_TICKS) * STEP + .12;
  const length = player.length / 2, width = player.width / 2;
  const boosted = (candidate.nitro ?? 0) >= 0.5 && candidate.brake === 0 && candidate.gear === 1 && candidate.throttle > 0;
  const boostAccel = (player.spec?.acceleration ?? VEHICLE.acceleration) * LOCAL_NITRO_SPEC.accelMultiplier * candidate.throttle;
  const postReactionSpeed = boosted
    ? Math.min(LOCAL_NITRO_SPEC.maxBoostSpeedMps, speed + boostAccel * reaction)
    : speed;
  const reach = boosted
    ? length + .65 + 0.5 * (speed + postReactionSpeed) * reaction + (postReactionSpeed * postReactionSpeed) / (2 * braking)
    : length + .65 + speed * reaction + speed * speed / (2 * braking);
  const horizon = Math.min(3, reaction + postReactionSpeed / braking);
  const sway = Math.abs(player.gtaSlipMps ?? 0) * reaction;
  const inside = (right, forward, pad = 0) => {
    const along = forward * direction;
    return along >= 0 && along <= reach + pad && Math.abs(right) <= width + .27 + sway + pad;
  };
  const stop = reason => ({ action: { ...stripNitro(candidate), throttle: 0, brake: 1 }, reason });
  let sweepReason = null;
  const ignorePedCollision = Boolean(world?.pursuit?.frozenDriver?._faultIgnorePedestrianCollisionOnly);
  const cityCurbs = world.pursuit?.gta?.curb?.mode === METRO_CITY_CURBS;
  const checkTurn = ageTicks === 0 && world.roads &&
    (Math.abs(candidate.steer) >= .10 || cityCurbs);
  const pedestrianNear = !ignorePedCollision && scan.tracks.some(track => track.kind === "pedestrian" &&
    Math.hypot(track.rightM, track.forwardM) < reach + 4);
  // Pedestrians remain strictly excluded from admitSweep and ray bypasses below,
  // while also being checked in stoppingSweep's returns with full pedestrian margins.
  const curvedEvasion = cityCurbs && ageTicks === 0 && Boolean(world.roads);
  const nearLoading = (index, vx = 0, vz = 0) => {
    const ray = scan.rays[index];
    return checkTurn && !pedestrianNear && direction === 1 && candidate.gear === 1 &&
      speed <= 8 && ray.kind === "civilian" && evidence?.stable(index) &&
      Math.abs(vz) <= .8 + ray.rangeM * .12 && Math.abs(vx) <= .7 + ray.rangeM * .55;
  };
  // A tracked crossing can enter the stopping space even when its current rays are clear of the SUV.
  for (const track of scan.tracks) {
    if (track.kind === "static" || (ignorePedCollision && track.kind === "pedestrian")) continue;
    const pedestrian = track.kind === "pedestrian";
    const freshMotion = track.motionKnown && track.ageS === 0;
    let vx = track.rightMps + (player.gtaSlipMps ?? 0);
    const vz = track.forwardMps + player.speed;
    const index = (Math.round(Math.atan2(track.rightM, track.forwardM) / angleStep) +
      PURSUIT_SCAN_RAYS) % PURSUIT_SCAN_RAYS;
    const admitSweep = (!pedestrian && curvedEvasion) ||
      (track.kind === "civilian" && freshMotion && nearLoading(index, vx, vz));
    if (inside(track.rightM, track.forwardM, (.18 + 1.2 * track.ageS) * Number(pedestrian || track.ageS > 0))) {
      if (!admitSweep) return stop(track.kind);
      sweepReason = track.kind;
    }
    if (!freshMotion) continue;
    // Let a closing follower stay a rear threat. Projecting it through the
    // SUV against a stationary origin would command braking into its path.
    if (!pedestrian && direction * track.forwardM < 0 && direction * vz > 0) continue;
    if (pedestrian) {
      // Changing the selected 0.5-degree ray can move a stationary return
      // laterally. Only extrapolate when motion exceeds that sample error.
      const sampleWidth = Math.hypot(track.rightM, track.forwardM) * .01;
      if (Math.abs(vx) * PURSUIT_SCAN_TICKS * STEP <= sampleWidth) vx = 0;
    }
    for (const fraction of [.25, .5, .75, 1]) {
      const t = horizon * fraction;
      if (inside(track.rightM + vx * t, track.forwardM + vz * t, pedestrian ? .4 : .15)) {
        if (!admitSweep) return stop(track.kind);
        sweepReason = track.kind;
      }
    }
  }
  for (let i = 0; i < scan.rays.length; i++) {
    const { rangeM, kind } = scan.rays[i];
    if (kind === "none" || (ignorePedCollision && kind === "pedestrian")) continue;
    const angle = i * angleStep;
    if (!inside(rangeM * Math.sin(angle), rangeM * Math.cos(angle), kind === "pedestrian" ? .2 : 0)) continue;
    if (kind !== "static") {
      if (!(kind !== "pedestrian" && curvedEvasion) && !nearLoading(i)) return stop(kind);
      sweepReason = kind;
    } else sweepReason ??= "static";
  }
  const sweepReaction = cityCurbs && ageTicks === 0 && candidate.gear === -1 && speed <= 2.2 && !pedestrianNear
    ? PURSUIT_SCAN_TICKS * STEP
    : reaction;
  if (sweepReason && (!checkTurn || !stoppingSweep(world, scan, candidate, sweepReaction, reach, sweepReason !== "static")))
    return stop(sweepReason);
  return { action: candidate, reason: null };
}

export function guardDispatchAction(world, requested) {
  const scan = requireDispatchScan(world);
  const { player, tick } = world;
  const ageTicks = tick - scan.tick;
  const evidence = measuredLoadingTraffic(world, scan);
  if (requested.brake === 1) return { action: stripNitro(requested), reason: null };

  const speed = Math.abs(player.speed ?? 0);
  const braking = player.spec?.braking ?? VEHICLE.braking;
  const reaction = (ageTicks + PURSUIT_SCAN_TICKS) * STEP + .12;
  const baseReach = (player.length ?? 4.2) / 2 + .65 + speed * reaction + speed * speed / (2 * braking);

  let candidate = requested;
  if ((candidate.nitro ?? 0) >= 0.5) {
    const minCharge = player.nitroActive ? 0.03 : LOCAL_NITRO_SPEC.minEngageCharge;
    const insufficientCharge = Number.isFinite(player.nitroCharge) && player.nitroCharge < minCharge;
    if (
      insufficientCharge ||
      (!world?.pursuit?.frozenDriver?._faultIgnorePedestrianNitroOnly &&
        hasPedestrianNitroHazard(world, scan, baseReach))
    ) {
      candidate = stripNitro(candidate);
    }
  }

  const verdict = evaluateGuardCandidate(world, scan, ageTicks, evidence, candidate);
  if (verdict.reason && (candidate.nitro ?? 0) >= 0.5) {
    // Smoothly shut off Nitro before slamming full brake when unboosted driving is still safe.
    const unboostedVerdict = evaluateGuardCandidate(world, scan, ageTicks, evidence, stripNitro(candidate));
    if (
      verdict.reason === "pedestrian" &&
      world?.pursuit?.frozenDriver?._faultIgnorePedestrianNitroOnly &&
      !unboostedVerdict.reason
    ) {
      return { action: candidate, reason: null };
    }
    if (!unboostedVerdict.reason) return unboostedVerdict;
    return unboostedVerdict;
  }
  return verdict;
}

function chooseSafeBrakingAction(world, scan, baseAction) {
  const cleanBase = stripNitro(baseAction);
  const { player } = world;
  const curb = world.pursuit?.gta?.curb;
  if (curb?.mode !== METRO_CITY_CURBS || cleanBase.brake < 1 || Math.abs(player.speed) <= 1.1 || !world.roads)
    return cleanBase;

  const pedPoints = [];
  const c0 = Math.cos(player.heading), s0 = Math.sin(player.heading);
  for (let i = 0; i < scan.rays.length; i++) {
    const ray = scan.rays[i];
    if (ray.kind !== "pedestrian" || ray.rangeM > 22) continue;
    const h = player.heading + i * angleStep;
    pedPoints.push({ x: player.x + Math.sin(h) * ray.rangeM, z: player.z + Math.cos(h) * ray.rangeM });
  }
  for (const track of scan.tracks) {
    if (track.kind !== "pedestrian" || Math.hypot(track.rightM, track.forwardM) > 22) continue;
    const wx = player.x + track.rightM * c0 + track.forwardM * s0;
    const wz = player.z - track.rightM * s0 + track.forwardM * c0;
    pedPoints.push({ x: wx, z: wz });
    if (track.motionKnown && track.ageS === 0) {
      const vxLocal = track.rightMps + (player.gtaSlipMps ?? 0);
      const vzLocal = track.forwardMps + player.speed;
      if (Math.hypot(vxLocal, vzLocal) <= 4.5) {
        for (const t of [.35, .7, 1.05]) {
          const rx = track.rightM + vxLocal * t, fz = track.forwardM + vzLocal * t;
          pedPoints.push({ x: player.x + rx * c0 + fz * s0, z: player.z - rx * s0 + fz * c0 });
        }
      }
    }
  }
  if (!pedPoints.length) return cleanBase;

  const candidates = [cleanBase.steer, 0, -.45, .45, -.9, .9];
  let bestSteer = cleanBase.steer;
  let bestScore = -Infinity;
  const startProbe = vehicleProbe(player, player.speed);

  for (let idx = 0; idx < candidates.length; idx++) {
    const steer = candidates[idx];
    const candidateAction = { ...cleanBase, steer, throttle: 0, brake: 1 };
    let pose = { ...startProbe, gtaSlipMps: player.gtaSlipMps ?? 0, gtaYawRate: player.gtaYawRate ?? 0 };
    let minPedGap = Infinity;
    let supportedAll = true;
    for (let step = 0; step < 96; step++) {
      const next = integrateVehicle(pose, pursuitCommand(pose, candidateAction), STEP);
      integrateGtaSlip(pose, next);
      if (!isPoseSupportedWithCurbs(curb, world.roads, next)) {
        supportedAll = false;
        break;
      }
      for (let p = 0; p < pedPoints.length; p++) {
        const d = pointToBoxDistance(pedPoints[p].x, pedPoints[p].z, next);
        if (d < minPedGap) minPedGap = d;
      }
      pose = next;
      if (Math.abs(pose.speed) < .03 && Math.abs(pose.gtaSlipMps ?? 0) < .03) break;
    }
    if (!supportedAll) continue;
    // If requested steer already clears all pedestrians by >= 1.65 m, keep it
    if (idx === 0 && minPedGap >= 1.65) return cleanBase;
    const score = minPedGap - .06 * Math.abs(steer - cleanBase.steer);
    if (score > bestScore) {
      bestScore = score;
      bestSteer = steer;
    }
  }
  return bestSteer === cleanBase.steer ? cleanBase : { ...cleanBase, steer: bestSteer, throttle: 0, brake: 1 };
}

export function selectDispatchMovement(world, requested, alternate = null) {
  const guarded = guardDispatchAction(world, requested);
  if (!alternate || world.pursuit.gta.scan.tick !== world.tick) return guarded;
  const scan = world.pursuit.gta.scan;
  const planner = alternate(world, requested);
  if (planner.controller === "pako-smart-escape-v3") {
    const checked = guardDispatchAction(world, planner.action);
    return { ...checked, planner: checked.reason ? { ...planner, guardReason: checked.reason } : planner };
  }
  if (planner.reason === "PREDICTIVE_QUEUE") {
    const checked = guardDispatchAction(world, planner.action);
    return { ...checked, planner: checked.reason ? { ...planner, guardReason: checked.reason } : planner };
  }
  if (["PREDICTIVE_EVADE_LANE", "PREDICTIVE_CURB_BYPASS", "PREDICTIVE_REVERSE_ESCAPE"].includes(planner.reason)) {
    const checked = guardDispatchAction(world, planner.action);
    if (!checked.reason) return { action: checked.action, reason: null, planner };
    const safeBrake = chooseSafeBrakingAction(world, scan, { ...stripNitro(planner.action), throttle: 0, brake: 1 });
    return {
      action: safeBrake,
      reason: checked.reason,
      planner: { ...planner, reason: "PREDICTIVE_VETO", guardReason: checked.reason },
    };
  }
  if (planner.reason === "PREDICTIVE_RECOVERY") {
    const checked = guardDispatchAction(world, planner.action);
    if (!checked.reason) return { action: checked.action, reason: null, planner };
    return { ...guarded, planner: { ...planner, reason: "PREDICTIVE_VETO", guardReason: checked.reason } };
  }
  if (planner.reason === "PREDICTIVE_REVERSE_BLOCKED")
    return { action: stripNitro(planner.action), reason: "reverse clearance", planner };
  if (planner.reason === "SAFETY_INTERVENTION") {
    const safeBrake = chooseSafeBrakingAction(world, scan, planner.action);
    return { action: safeBrake, reason: guarded.reason ?? "safety-intervention", planner };
  }
  if (!planner.reason) {
    if ((planner.action?.nitro ?? 0) >= 0.5 && !guarded.reason) {
      const checkedNitro = guardDispatchAction(world, planner.action);
      if (!checkedNitro.reason) return { action: checkedNitro.action, reason: null, planner };
    }
    if (planner.nitroSuppressedByPedestrian) {
      return { ...guarded, action: stripNitro(guarded.action), planner };
    }
    if ((guarded.action?.nitro ?? 0) >= 0.5 && !(planner.action?.nitro >= 0.5)) {
      return { ...guarded, action: stripNitro(guarded.action) };
    }
    return guarded;
  }
  return { ...guarded, planner };
}
