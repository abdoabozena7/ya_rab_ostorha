import { STEP } from "../core/config.js";
import { angleDelta, corners, sweepSafe } from "../core/geometry.js";
import { PURSUIT_STOP, pursuitCommand, validatePursuitAction } from "../core/pursuit-controls.js";
import { DISPATCH_RULESET } from "../core/pursuit-dispatch.js";
import { gtaVelocity, integrateGtaSlip } from "../core/pursuit-gta.js";
import { integrateVehicle, vehicleProbe } from "../core/vehicle.js";
import { PURSUIT_SCAN_RAYS, PURSUIT_SCAN_TICKS } from "../signal_processing/pursuit-scanner.js";
import { guardDispatchAction, requireDispatchScan } from "./pursuit-shield.js";

const angleStep = 2 * Math.PI / PURSUIT_SCAN_RAYS;
const beams = Array.from({ length: PURSUIT_SCAN_RAYS }, (_, i) =>
  [Math.sin(i * angleStep), Math.cos(i * angleStep)]);
const holdTicks = 45, stopTicks = 60;
const footprintPadM = .08, returnPadM = .12;
const alternatives = [
  ["straight", 0], ["steer-right", -.78], ["steer-left", .78],
];
// These are uncertainty allowances around a measured surface, not actor sizes or poses.
const envelopes = { pedestrian: [.7, 4], civilian: [5.5, 30], police: [5.5, 38] };
// Occlusion must cover the SWAT diagonal and maximum Dispatch pace, including contact speed and slip.
const stalePoliceEnvelope = [5.8, 55];
const reverseRuns = new WeakMap();

function observedSpace(scan, player) {
  const s = Math.sin(player.heading), c = Math.cos(player.heading);
  const velocity = gtaVelocity(player);
  const tracks = [];
  for (const track of scan.tracks) {
    if (track.kind === "static") continue;
    const [reachM, speedAllowance] = track.ageS > 0 && track.kind === "police"
      ? stalePoliceEnvelope : envelopes[track.kind];
    if (track.ageS > 0) {
      const { observedXM, observedZM, observedTick, positionAllowanceM } = track;
      if (![observedXM, observedZM, positionAllowanceM].every(Number.isFinite) || positionAllowanceM <= 0 ||
          !Number.isSafeInteger(observedTick) || observedTick < 0 || observedTick >= scan.tick ||
          Math.abs((scan.tick - observedTick) * STEP - track.ageS) > 1e-8)
        return null;
      // An occluded surface can be anywhere within reach of its last measurement.
      // Re-anchor to current odometry; do not extrapolate an old relative velocity.
      const dx = observedXM - player.x, dz = observedZM - player.z;
      const right = dx * c - dz * s, forward = dx * s + dz * c;
      if (!Number.isFinite(Math.hypot(right, forward))) return null;
      tracks.push({ right, forward, stale: true, known: false, vr: 0, vf: 0,
        reachM: reachM + positionAllowanceM + speedAllowance * track.ageS, growthMps: speedAllowance });
      continue;
    }
    const bearingStep = track.kind === "pedestrian" ? angleStep / 10 : angleStep;
    const range = Math.hypot(track.rightM, track.forwardM);
    const vr = track.rightMps + velocity.x * c - velocity.z * s;
    const vf = track.forwardMps + velocity.x * s + velocity.z * c;
    const known = track.motionKnown && Math.hypot(vr, vf) <= speedAllowance;
    tracks.push({
      right: track.rightM, forward: track.forwardM, known,
      vr: known ? vr : 0, vf: known ? vf : 0,
      reachM: reachM + range * bearingStep,
      growthMps: known ? 1 + range * bearingStep / (STEP * PURSUIT_SCAN_TICKS) : speedAllowance,
    });
  }
  return {
    sectors: scan.rays.map((ray, i) =>
      Math.min(ray.rangeM, scan.rays[(i + 1) % PURSUIT_SCAN_RAYS].rangeM) - returnPadM),
    tracks,
  };
}

// Intersect the padded footprint with each sector. A sector extends only to
// its shorter adjoining return; corners and edge crossings bound its farthest point.
function scanClearance(body, sectors) {
  let clearance = Infinity;
  for (const { x, z } of corners(body, footprintPadM)) {
    const angle = Math.atan2(x, z);
    const i = (Math.floor(angle / angleStep) + PURSUIT_SCAN_RAYS) % PURSUIT_SCAN_RAYS;
    clearance = Math.min(clearance, sectors[i] - Math.hypot(x, z));
  }
  const c = Math.cos(body.heading), s = Math.sin(body.heading);
  const w = body.width / 2 + footprintPadM, l = body.length / 2 + footprintPadM;
  const r = -body.x * c + body.z * s, f = -body.x * s - body.z * c;
  for (let i = 0; i < PURSUIT_SCAN_RAYS && clearance > 0; i++) {
    const [x, z] = beams[i];
    const dr = x * c - z * s, df = x * s + z * c;
    if ((Math.abs(dr) < 1e-9 && Math.abs(r) > w) ||
        (Math.abs(df) < 1e-9 && Math.abs(f) > l)) continue;
    let near = 0, far = Infinity;
    if (Math.abs(dr) >= 1e-9) {
      const a = (-w - r) / dr, b = (w - r) / dr;
      near = Math.max(near, Math.min(a, b));
      far = Math.min(far, Math.max(a, b));
    }
    if (Math.abs(df) >= 1e-9) {
      const a = (-l - f) / df, b = (l - f) / df;
      near = Math.max(near, Math.min(a, b));
      far = Math.min(far, Math.max(a, b));
    }
    if (far >= near)
      clearance = Math.min(clearance, Math.min(sectors[i], sectors[(i + PURSUIT_SCAN_RAYS - 1) %
        PURSUIT_SCAN_RAYS]) - far);
  }
  return clearance;
}

function evaluate(world, start, observed, action, movementTicks = holdTicks) {
  const { roads } = world;
  const cos = Math.cos(start.heading), sin = Math.sin(start.heading);
  const brake = { ...action, throttle: 0, brake: 1 };
  let pose = start, minClearanceM = Infinity, travelM = 0;
  for (let tick = 0; tick <= movementTicks + stopTicks; tick++) {
    if (tick > 0) {
      const next = integrateVehicle(pose, pursuitCommand(pose, tick <= movementTicks ? action : brake), STEP);
      integrateGtaSlip(pose, next);
      if (!sweepSafe(pose, next, [], roads).safe) return { rejectReason: "road-boundary" };
      if (tick <= movementTicks) travelM += Math.hypot(next.x - pose.x, next.z - pose.z);
      pose = next;
    }
    const dx = pose.x - start.x, dz = pose.z - start.z;
    const local = { x: dx * cos - dz * sin, z: dx * sin + dz * cos,
      heading: pose.heading - start.heading, width: pose.width, length: pose.length };
    const clearance = scanClearance(local, observed.sectors);
    if (clearance <= 0) return { rejectReason: "scan-clearance" };
    minClearanceM = Math.min(minClearanceM, clearance);
    const time = tick * STEP, c = Math.cos(local.heading), s = Math.sin(local.heading);
    for (const track of observed.tracks) {
      const rx = track.right + track.vr * time - local.x;
      const rz = track.forward + track.vf * time - local.z;
      const reach = track.reachM + track.growthMps * time + (track.known ? 2 * time ** 2 : 0);
      const right = Math.abs(rx * c - rz * s) - local.width / 2 - footprintPadM;
      const forward = Math.abs(rx * s + rz * c) - local.length / 2 - footprintPadM;
      const gap = Math.hypot(Math.max(0, right), Math.max(0, forward)) - reach;
      if (gap <= 0) return {
        rejectReason: track.stale ? "stale-track" : track.known ? "predicted-conflict" : "uncertain-motion",
      };
      minClearanceM = Math.min(minClearanceM, gap);
    }
    if (tick > movementTicks && Math.abs(pose.speed) < .02 &&
        Math.abs(pose.gtaSlipMps) < .02 && Math.abs(pose.gtaYawRate) < .02)
      return travelM >= (movementTicks === holdTicks ? .18 : .004)
        ? { rejectReason: null, minClearanceM } : { rejectReason: "insufficient-progress" };
  }
  return { rejectReason: "no-stopping-envelope" };
}

function reverseJunction(world, start, scan) {
  const alongX = Math.sin(start.heading), alongZ = Math.cos(start.heading);
  const axis = Math.abs(alongX) > Math.abs(alongZ) ? "x" : "z", side = axis === "x" ? "z" : "x";
  const direction = Math.sign(axis === "x" ? alongX : alongZ), roads = world.drivingRoads ?? [];
  if (Math.abs(axis === "x" ? alongZ : alongX) > .12) return null;
  const entry = roads.find(road => road.axis === axis && !road.parkingBay &&
    start[axis] >= road.min && start[axis] <= road.max && Math.abs(start[side] - road.fixed) < road.width / 2);
  if (!entry) return null;
  const rear = Math.min(...[35, 36, 37].map(i => scan.rays[i].rangeM));
  const goal = world.pursuit.gta.publicRouteGoal;
  const choices = [];
  for (const road of roads) {
    if (road.axis !== side || road.parkingBay || (goal && road.id !== goal.roadId) ||
        road.fixed < entry.min || road.fixed > entry.max || entry.fixed < road.min || entry.fixed > road.max) continue;
    const behind = (start[axis] - road.fixed) * direction;
    if (behind < 5 || behind > 11 || rear < behind + start.length / 2 + .5) continue;
    for (const sign of [-1, 1]) {
      const remaining = sign > 0 ? road.max - entry.fixed : entry.fixed - road.min;
      if (remaining < 14 || (road.flow && road.flow !== sign) ||
          (goal && Math.sign(goal[side] - entry.fixed) !== sign)) continue;
      const targetHeading = side === "x" ? sign * Math.PI / 2 : sign > 0 ? 0 : Math.PI;
      choices.push({ axis, direction, behind, targetHeading, id: road.id });
    }
  }
  return choices.sort((a, b) => a.behind - b.behind || a.id.localeCompare(b.id))[0] ?? null;
}

function reverseDecision(world, start, scan, candidates, run) {
  const settle = Math.abs(angleDelta(run.route.targetHeading, start.heading)) < .19 || run.stage === "settle";
  if (settle && Math.abs(start.speed) < .02) {
    run.finished = true;
    return null;
  }
  const before = (run.startAlong - start[run.route.axis]) * run.route.direction;
  if (before >= run.route.behind - 4.6) run.stage = "turn";
  if (settle) run.stage = "settle";
  const action = settle ? PURSUIT_STOP : { gear: -1, brake: 0, throttle: .65,
    steer: run.stage === "turn" ? -Math.sign(angleDelta(run.route.targetHeading, start.heading)) : 0 };
  const observed = observedSpace(scan, world.player);
  const assessed = guardDispatchAction(world, action);
  const verdict = world.tick - run.tick > 360 ? { rejectReason: "reverse-budget" }
    : settle ? { rejectReason: null }
      : assessed.reason ? { rejectReason: "guard-veto", guardReason: assessed.reason }
        : !observed ? { rejectReason: "stale-track-metadata" } :
          evaluate(world, start, observed, action, PURSUIT_SCAN_TICKS);
  const feasible = verdict.rejectReason === null;
  candidates.push({ name: settle ? "reverse-settle" : `reverse-${run.stage}`, roadId: run.route.id, action, feasible,
    ...verdict, ...(feasible ? { selected: true } : {}) });
  if (!feasible) run.finished = true;
  return { action: feasible ? action : PURSUIT_STOP,
    reason: feasible ? "PREDICTIVE_RECOVERY" : "PREDICTIVE_REVERSE_BLOCKED", candidates };
}

function planAgainstRear(world, start, scan, requested) {
  if (requested.brake !== 1 || requested.throttle !== 0 || requested.gear !== 1 ||
      Math.abs(requested.steer) > .05 || Math.abs(start.steer) > .05 || start.speed < 0 ||
      start.speed > 1.5 || Math.abs(start.gtaSlipMps) > .05 || Math.abs(start.gtaYawRate) > .05 ||
      !world.roads?.length) return null;

  const previous = world.player.previous;
  if (!previous || ![previous.x, previous.z, previous.heading].every(Number.isFinite) ||
      Math.abs(angleDelta(start.heading, previous.heading)) > .003 ||
      Math.abs(start.speed - Math.hypot(start.x - previous.x, start.z - previous.z) / STEP) > .15)
    return null;

  // Only a resolved, centered rear police surface can displace a deliberate brake.
  // Treat every other current or occluded dynamic return as a reason to yield.
  const dynamic = scan.tracks.filter(track => track.kind !== "static");
  const [tail] = dynamic;
  const rearRay = scan.rays[PURSUIT_SCAN_RAYS / 2];
  if (dynamic.length !== 1 || tail.kind !== "police" || !tail.motionKnown || tail.ageS !== 0 ||
      rearRay.kind !== "police" || Math.abs(tail.rightM) > .35 || Math.abs(tail.rightMps) > .6 ||
      Math.abs(rearRay.rangeM + tail.forwardM) > .12 ||
      tail.forwardMps < 1 || tail.forwardMps > 6) return null;

  const action = { steer: 0, throttle: .65, brake: 0, gear: 1 };
  const candidate = verdict => ({ name: "rear-pressure-forward", action,
    feasible: verdict.rejectReason === null, ...verdict });
  const checked = guardDispatchAction(world, action);
  if (checked.reason) return candidate({ rejectReason: "guard-veto", guardReason: checked.reason });
  for (const [i, ray] of scan.rays.entries()) {
    const [r, f] = beams[i], forward = f * ray.rangeM;
    if (ray.kind === "civilian" || ray.kind === "pedestrian" || (ray.kind === "police" && f >= -.5) ||
        (forward >= 0 && forward < 6 && Math.abs(r * ray.rangeM) < start.width / 2 + .7))
      return candidate({ rejectReason: "front-clearance" });
  }

  const rearGap = -tail.forwardM - start.length / 2;
  const advanceMps = tail.forwardMps + start.speed;
  const travel = pose => (pose.x - start.x) * Math.sin(start.heading) +
    (pose.z - start.z) * Math.cos(start.heading);
  const next = (pose, control) => {
    const out = integrateVehicle(pose, pursuitCommand(pose, control), STEP);
    integrateGtaSlip(pose, out);
    return out;
  };
  let held = start, moving = start, heldMin = rearGap, movingMin = rearGap, nextGap;
  for (let tick = 1; tick <= holdTicks; tick++) {
    held = next(held, requested);
    moving = next(moving, action);
    const t = tick * STEP;
    heldMin = Math.min(heldMin, rearGap - advanceMps * t + travel(held));
    movingMin = Math.min(movingMin, rearGap - advanceMps * t + travel(moving));
    if (tick === PURSUIT_SCAN_TICKS)
      nextGap = rearGap - advanceMps * t + travel(moving) - .12 - 3 * t ** 2;
  }
  if (heldMin > 1.6 || movingMin - heldMin < .15 || nextGap < .2)
    return candidate({ rejectReason: "rear-advantage-unproven" });

  // The matching rear face is checked longitudinally for the committed slice.
  // Its current first returns still constrain the full front and stop sweep.
  const observed = observedSpace(scan, world.player);
  const verdict = evaluate(world, start, { ...observed, tracks: [] }, action);
  return candidate(verdict.rejectReason === null ?
    { ...verdict, minClearanceM: Math.min(verdict.minClearanceM, nextGap) } : verdict);
}

/**
 * Opt-in Dispatch development adapter. Apply only for one 6-tick decision.
 * All proposed movements already passed the independent Dispatch guard.
 */
export function planDispatchEvasion(world, requestedAction) {
  const result = (action, reason, candidates = []) => ({ action, reason, candidates });
  if (world.pursuit?.phase !== "running" || world.pursuit.gta?.config?.ruleset !== DISPATCH_RULESET)
    return result(requestedAction, null);
  validatePursuitAction(requestedAction);
  if (world.pursuit.gta.scan?.tick !== world.tick) return result(PURSUIT_STOP, "STALE_OBSERVATION");
  let scan;
  try {
    scan = requireDispatchScan(world);
  } catch {
    return result(PURSUIT_STOP, "INVALID_OBSERVATION");
  }

  const { player, roads } = world;
  const start = { ...vehicleProbe(player, player.speed),
    gtaSlipMps: player.gtaSlipMps, gtaYawRate: player.gtaYawRate };
  if (![start.x, start.z, start.heading, start.speed, start.steer, start.width, start.length,
    start.gtaSlipMps, start.gtaYawRate].every(Number.isFinite))
    return result(PURSUIT_STOP, "INVALID_ODOMETRY");
  const guarded = guardDispatchAction(world, requestedAction);
  const reverse = reverseRuns.get(world.pursuit);
  if (reverse && !reverse.finished) {
    if (requestedAction.brake > 0) {
      reverse.finished = true;
      return result(guarded.action, "PREDICTIVE_REVERSE_CANCELLED");
    }
    const continuing = reverseDecision(world, start, scan, [], reverse);
    if (continuing) return continuing;
  }
  if (!guarded.reason) {
    const rear = planAgainstRear(world, start, scan, requestedAction);
    if (rear?.feasible) {
      rear.selected = true;
      return result(rear.action, "PREDICTIVE_RECOVERY", [rear]);
    }
    return result(requestedAction, null, rear ? [rear] : []);
  }

  const candidates = [{ name: "policy", action: requestedAction, feasible: false,
    rejectReason: "guard-veto", guardReason: guarded.reason }];
  if (requestedAction.brake > 0 || requestedAction.throttle === 0 ||
      Math.abs(start.speed) > 2.5 || Math.abs(start.gtaSlipMps) > .35 || Math.abs(start.gtaYawRate) > .35 ||
      !roads?.length)
    return result(guarded.action, "SAFETY_INTERVENTION", candidates);

  const observed = observedSpace(scan, player);
  let selected = null;
  for (const [name, steer] of alternatives) {
    const action = { ...requestedAction, steer, throttle: Math.min(requestedAction.throttle, .65) };
    const checked = guardDispatchAction(world, action);
    const verdict = checked.reason ? { rejectReason: "guard-veto", guardReason: checked.reason } :
      !observed ? { rejectReason: "stale-track-metadata" } : evaluate(world, start, observed, action);
    const candidate = { name, action, feasible: verdict.rejectReason === null, ...verdict };
    candidates.push(candidate);
    // Stable ties preserve the closest steer to the request.
    if (candidate.feasible && (!selected || candidate.minClearanceM > selected.minClearanceM + 1e-6 ||
        (Math.abs(candidate.minClearanceM - selected.minClearanceM) <= 1e-6 &&
         Math.abs(steer - requestedAction.steer) < Math.abs(selected.action.steer - requestedAction.steer))))
      selected = candidate;
  }
  if (!selected) {
    if (!reverse && guarded.reason === "static" && requestedAction.gear === 1 &&
        Math.abs(start.speed) <= .1 && world.player.wait >= .33) {
      const route = reverseJunction(world, start, scan);
      if (route) {
        const stage = { route, tick: world.tick, startAlong: start[route.axis], stage: "straight", finished: false };
        reverseRuns.set(world.pursuit, stage);
        return reverseDecision(world, start, scan, candidates, stage) ?? result(guarded.action, "PREDICTIVE_NO_SUPPORTED_EXIT", candidates);
      }
    }
    return result(guarded.action, "PREDICTIVE_NO_SUPPORTED_EXIT", candidates);
  }
  selected.selected = true;
  return result(selected.action, "PREDICTIVE_RECOVERY", candidates);
}

