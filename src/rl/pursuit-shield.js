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

function stoppingSweep(world, scan, requested, reaction, reach, includeTraffic) {
  const { player } = world;
  const curb = world.pursuit?.gta?.curb;
  const cityCurbs = curb?.mode === METRO_CITY_CURBS;
  const startProbe = vehicleProbe(player, player.speed);
  const returns = [];
  const alreadyClose = [];
  for (const [i, ray] of scan.rays.entries()) {
    if (ray.kind === "none" || (ray.kind !== "static" && !includeTraffic) ||
        ray.rangeM > reach + player.length + 2) continue;
    const heading = player.heading + i * angleStep;
    const point = {
      type: "pedestrian",
      kind: ray.kind,
      radius: (cityCurbs ? (ray.kind === "pedestrian" ? .06 : .01) : .10) + ray.rangeM * Math.sin(angleStep / 2) +
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
  const brake = { ...requested, throttle: 0, brake: 1 };
  const delayTicks = Math.ceil(reaction / STEP);
  let pose = { ...startProbe, gtaSlipMps: player.gtaSlipMps, gtaYawRate: player.gtaYawRate };
  for (let ticksElapsed = 0; ticksElapsed < 180;) {
    const strideTicks = cityCurbs && ticksElapsed >= delayTicks + 4 ? 2 : 1;
    const dt = strideTicks * STEP;
    const action = ticksElapsed < delayTicks ? requested : brake;
    const next = integrateVehicle(pose, pursuitCommand(pose, action), dt);
    for (let k = 0; k < strideTicks; k++) integrateGtaSlip(k === 0 ? pose : next, next);
    ticksElapsed += strideTicks;
    if (cityCurbs) {
      if (!bodyOnRoad(next, world.roads) &&
          Math.hypot(next.speed, next.gtaSlipMps ?? 0) > curb.maxPace + 1e-6)
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

export function guardDispatchAction(world, requested) {
  const scan = requireDispatchScan(world);
  const { player, tick } = world;
  const ageTicks = tick - scan.tick;
  const evidence = measuredLoadingTraffic(world, scan);
  if (requested.brake === 1) return { action: requested, reason: null };
  const speed = Math.abs(player.speed), direction = speed > .1 ? Math.sign(player.speed) : requested.gear;
  const braking = player.spec?.braking ?? VEHICLE.braking;
  const reaction = (ageTicks + PURSUIT_SCAN_TICKS) * STEP + .12;
  const length = player.length / 2, width = player.width / 2;
  const reach = length + .65 + speed * reaction + speed * speed / (2 * braking);
  const horizon = Math.min(3, reaction + speed / braking);
  const sway = Math.abs(player.gtaSlipMps ?? 0) * reaction;
  const inside = (right, forward, pad = 0) => {
    const along = forward * direction;
    return along >= 0 && along <= reach + pad && Math.abs(right) <= width + .27 + sway + pad;
  };
  const stop = reason => ({ action: { ...requested, throttle: 0, brake: 1 }, reason });
  let sweepReason = null;
  const cityCurbs = world.pursuit?.gta?.curb?.mode === METRO_CITY_CURBS;
  const checkTurn = ageTicks === 0 && world.roads &&
    (Math.abs(requested.steer) >= .10 || cityCurbs);
  const pedestrianNear = scan.tracks.some(track => track.kind === "pedestrian" &&
    Math.hypot(track.rightM, track.forwardM) < reach + 4);
  // Pedestrians remain strictly excluded from admitSweep and ray bypasses below,
  // while also being checked in stoppingSweep's returns with full pedestrian margins.
  const curvedEvasion = cityCurbs && ageTicks === 0 && Boolean(world.roads);
  const nearLoading = (index, vx = 0, vz = 0) => {
    const ray = scan.rays[index];
    return checkTurn && !pedestrianNear && direction === 1 && requested.gear === 1 &&
      speed <= 8 && ray.kind === "civilian" && evidence?.stable(index) &&
      Math.abs(vz) <= .8 + ray.rangeM * .12 && Math.abs(vx) <= .7 + ray.rangeM * .55;
  };
  // A tracked crossing can enter the stopping space even when its current rays are clear of the SUV.
  for (const track of scan.tracks) {
    if (track.kind === "static") continue;
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
    if (kind === "none") continue;
    const angle = i * angleStep;
    if (!inside(rangeM * Math.sin(angle), rangeM * Math.cos(angle), kind === "pedestrian" ? .2 : 0)) continue;
    if (kind !== "static") {
      if (!(kind !== "pedestrian" && curvedEvasion) && !nearLoading(i)) return stop(kind);
      sweepReason = kind;
    } else sweepReason ??= "static";
  }
  const sweepReaction = cityCurbs && ageTicks === 0 && requested.gear === -1 && speed <= 2.2 && !pedestrianNear
    ? PURSUIT_SCAN_TICKS * STEP
    : reaction;
  if (sweepReason && (!checkTurn || !stoppingSweep(world, scan, requested, sweepReaction, reach, sweepReason !== "static")))
    return stop(sweepReason);
  return { action: requested, reason: null };
}

function chooseSafeBrakingAction(world, scan, baseAction) {
  const { player } = world;
  const curb = world.pursuit?.gta?.curb;
  if (curb?.mode !== METRO_CITY_CURBS || baseAction.brake < 1 || Math.abs(player.speed) <= 1.1 || !world.roads)
    return baseAction;

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
  if (!pedPoints.length) return baseAction;

  const candidates = [baseAction.steer, 0, -.45, .45, -.9, .9];
  let bestSteer = baseAction.steer;
  let bestScore = -Infinity;
  const startProbe = vehicleProbe(player, player.speed);

  for (let idx = 0; idx < candidates.length; idx++) {
    const steer = candidates[idx];
    const candidateAction = { ...baseAction, steer, throttle: 0, brake: 1 };
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
    if (idx === 0 && minPedGap >= 1.65) return baseAction;
    const score = minPedGap - .06 * Math.abs(steer - baseAction.steer);
    if (score > bestScore) {
      bestScore = score;
      bestSteer = steer;
    }
  }
  return bestSteer === baseAction.steer ? baseAction : { ...baseAction, steer: bestSteer, throttle: 0, brake: 1 };
}

export function selectDispatchMovement(world, requested, alternate = null) {
  const guarded = guardDispatchAction(world, requested);
  if (!alternate || world.pursuit.gta.scan.tick !== world.tick) return guarded;
  const scan = world.pursuit.gta.scan;
  const planner = alternate(world, requested);
  if (planner.reason === "PREDICTIVE_QUEUE") {
    const checked = guardDispatchAction(world, planner.action);
    return { ...checked, planner: checked.reason ? { ...planner, guardReason: checked.reason } : planner };
  }
  if (["PREDICTIVE_EVADE_LANE", "PREDICTIVE_CURB_BYPASS", "PREDICTIVE_REVERSE_ESCAPE"].includes(planner.reason)) {
    const checked = guardDispatchAction(world, planner.action);
    if (!checked.reason) return { action: checked.action, reason: null, planner };
    const safeBrake = chooseSafeBrakingAction(world, scan, { ...planner.action, throttle: 0, brake: 1 });
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
    return { action: planner.action, reason: "reverse clearance", planner };
  if (planner.reason === "SAFETY_INTERVENTION") {
    const safeBrake = chooseSafeBrakingAction(world, scan, planner.action);
    return { action: safeBrake, reason: guarded.reason ?? "safety-intervention", planner };
  }
  return planner.reason ? { ...guarded, planner } : guarded;
}
