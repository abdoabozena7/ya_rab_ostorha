import { STEP, VEHICLE } from "../core/config.js";
import { sweepSafe } from "../core/geometry.js";
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
    throw new Error("Pursuit brake guard needs a current scan");
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

function stoppingSweep(world, scan, requested, reaction, reach, includeTraffic) {
  const { player } = world;
  const returns = [];
  for (const [i, ray] of scan.rays.entries()) {
    if (ray.kind === "none" || (ray.kind !== "static" && !includeTraffic) ||
        ray.rangeM > reach + player.length + 2) continue;
    const heading = player.heading + i * angleStep;
    returns.push({ type: "pedestrian", radius: .10 + ray.rangeM * Math.sin(angleStep / 2) +
      (ray.kind === "static" ? 0 : .18),
      x: player.x + Math.sin(heading) * ray.rangeM, z: player.z + Math.cos(heading) * ray.rangeM });
  }
  const brake = { ...requested, throttle: 0, brake: 1 };
  const delayTicks = Math.ceil(reaction / STEP);
  let pose = { ...vehicleProbe(player, player.speed), gtaSlipMps: player.gtaSlipMps, gtaYawRate: player.gtaYawRate };
  for (let i = 0; i < 180; i++) {
    const action = i < delayTicks ? requested : brake;
    const next = integrateVehicle(pose, pursuitCommand(pose, action), STEP);
    integrateGtaSlip(pose, next);
    if (!sweepSafe(pose, next, returns, world.roads).safe) return false;
    if (i >= delayTicks && Math.abs(next.speed) < .02 && Math.abs(next.gtaSlipMps) < .02) return true;
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
  const checkTurn = ageTicks === 0 && world.roads && Math.abs(requested.steer) >= .10;
  const pedestrianNear = scan.tracks.some(track => track.kind === "pedestrian" &&
    Math.hypot(track.rightM, track.forwardM) < reach + 4);
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
    const admitSweep = track.kind === "civilian" && freshMotion && nearLoading(index, vx, vz);
    if (inside(track.rightM, track.forwardM, (.18 + 1.2 * track.ageS) * Number(pedestrian || track.ageS > 0))) {
      if (!admitSweep) return stop(track.kind);
      sweepReason = "civilian";
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
        sweepReason = "civilian";
      }
    }
  }
  for (let i = 0; i < scan.rays.length; i++) {
    const { rangeM, kind } = scan.rays[i];
    if (kind === "none") continue;
    const angle = i * angleStep;
    if (!inside(rangeM * Math.sin(angle), rangeM * Math.cos(angle), kind === "pedestrian" ? .2 : 0)) continue;
    if (kind !== "static") {
      if (!nearLoading(i)) return stop(kind);
      sweepReason = "civilian";
    } else sweepReason ??= "static";
  }
  if (sweepReason && (!checkTurn || !stoppingSweep(world, scan, requested, reaction, reach, sweepReason === "civilian")))
    return stop(sweepReason);
  return { action: requested, reason: null };
}
