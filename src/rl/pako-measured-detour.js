import { STEP, clamp } from "../core/config.js";
import { angleDelta, bodyOnRoad, sweepSafe } from "../core/geometry.js";
import { PURSUIT_STOP, pursuitCommand } from "../core/pursuit-controls.js";
import { DISPATCH_RULESET } from "../core/pursuit-dispatch.js";
import { integrateGtaSlip } from "../core/pursuit-gta.js";
import { integrateVehicle, vehicleProbe } from "../core/vehicle.js";
import { PURSUIT_SCAN_RANGE_M, PURSUIT_SCAN_TICKS } from "../signal_processing/pursuit-scanner.js";
import { requireDispatchScan } from "./pursuit-shield.js";

export const MEASURED_QUEUE_DETOUR = "measured-queue-detour-v1";
export const MEASURED_QUEUE_CORRIDOR = "measured-queue-corridor-v1";
const sessions = new WeakMap();

function approach(roads, ego) {
  for (const road of roads) {
    if (road.flow || road.parkingBay || road.supportApron || road.width < 11.5 || !(road.laneOffsetM > 2))
      continue;
    const along = road.axis, across = along === "x" ? "z" : "x";
    const forward = along === "x" ? Math.sin(ego.heading) : Math.cos(ego.heading);
    const sign = Math.sign(forward), right = along === "x" ? -sign : sign;
    const heading = along === "x" ? sign * Math.PI / 2 : sign > 0 ? 0 : Math.PI;
    const home = road.fixed - right * road.laneOffsetM;
    const pass = road.fixed + right * (road.laneOffsetM - .25);
    const remainingM = sign > 0 ? road.max - ego[along] : ego[along] - road.min;
    if (remainingM < 20 || Math.abs(ego[across] - home) > 1 || Math.abs(angleDelta(ego.heading, heading)) > .16 ||
        !bodyOnRoad(ego, [road])) continue;
    // A lead waiting inside a crossing is not a stationary lane obstruction.
    // Do not commit to the adjacent lane from the shared junction footprint.
    if (roads.some(other => other.axis !== along && !other.parkingBay && !other.supportApron &&
        other.fixed >= road.min && other.fixed <= road.max && road.fixed >= other.min && road.fixed <= other.max &&
        Math.abs(ego[along] - other.fixed) <= other.width / 2 + ego.length / 2 + 2)) continue;
    return { road, along, across, sign, right, heading, home, pass };
  }
  return null;
}

function observedLane(scan, ego, route, target) {
  const { across, along, sign } = route;
  return scan.tracks.filter(track => track.kind !== "static").map(track => {
    const x = track.observedXM, z = track.observedZM;
    const cross = across === "x" ? x : z, longitudinal = along === "x" ? x : z;
    const speed = along === "x" ? track.estimatedXMps : track.estimatedZMps;
    const crossSpeed = across === "x" ? track.estimatedXMps : track.estimatedZMps;
    return { track, cross, dx: Math.abs(cross - target), ahead: (longitudinal - ego[along]) * sign,
      speed: Number.isFinite(speed) ? speed * sign : null, crossSpeed };
  }).filter(row => Number.isFinite(row.dx) && Number.isFinite(row.ahead));
}

function laneConflict(rows, ego, aheadM, behindM) {
  return rows.some(({ track, dx, ahead, speed, crossSpeed }) => {
    const pad = Math.min(.85, track.positionAllowanceM ?? .5) + track.ageS * 2;
    const width = ego.width / 2 + .66 + pad;
    const approaching = track.motionKnown && speed < -.5;
    const reach = aheadM + (approaching ? Math.min(23, -speed * 1.45) : 0);
    const lateralReach = Number.isFinite(crossSpeed) ? Math.min(1.4, Math.abs(crossSpeed) * .4) : .25;
    return dx <= width + lateralReach && ahead > -behindM && ahead < reach;
  });
}

// This is a veto on observed occupation, not a claim that occluded space is empty.
export function queuePassingConflict(scan, ego, heading, targetM, lookaheadM) {
  const s = Math.sin(heading), c = Math.cos(heading);
  for (const track of scan.tracks) {
    if (track.kind === "static") continue;
    const dx = track.observedXM - ego.x, dz = track.observedZM - ego.z;
    const along = dx * s + dz * c, cross = dx * c - dz * s;
    if (![along, cross, track.positionAllowanceM].every(Number.isFinite) || track.positionAllowanceM <= 0 ||
        (track.motionKnown && ![track.estimatedXMps, track.estimatedZMps].every(Number.isFinite)))
      return "unresolved-corridor";
    const speed = track.motionKnown ? track.estimatedXMps * s + track.estimatedZMps * c : 0;
    const reachM = Math.min(PURSUIT_SCAN_RANGE_M, lookaheadM + Math.max(0, -speed) * 2);
    const allowanceM = Math.min(.9, track.positionAllowanceM) + track.ageS * 2;
    if (along > -1 && along < reachM && Math.abs(cross - targetM) <= ego.width / 2 + .725 + allowanceM)
      return "observed-corridor";
  }
  return null;
}

function roadStopEnvelope(ego, road, action) {
  let current = { ...vehicleProbe(ego, ego.speed), gtaSlipMps: ego.gtaSlipMps, gtaYawRate: ego.gtaYawRate };
  const brake = { ...action, throttle: 0, brake: 1 };
  // A decision lasts one scan period; also require a supported stop if the next
  // scan vetoes it. Traffic is checked separately by the independent guard.
  for (let i = 0; i < 60; i++) {
    const next = integrateVehicle(current, pursuitCommand(current, i < PURSUIT_SCAN_TICKS ? action : brake), STEP);
    integrateGtaSlip(current, next);
    if (!sweepSafe(current, next, [], [road]).safe) return false;
    if (i >= PURSUIT_SCAN_TICKS && Math.abs(next.speed) < .02) return true;
    current = next;
  }
  return false;
}

export const planMeasuredQueueCorridor = (world, requested) => planMeasuredQueueDetour(world, requested, true);

export function planMeasuredQueueDetour(world, requested, useCorridor = false) {
  const { player: ego, pursuit, tick } = world;
  const unchanged = { action: requested, reason: null, candidates: [] };
  if (pursuit?.phase !== "running" || pursuit.gta?.config?.ruleset !== DISPATCH_RULESET ||
      pursuit.gta.scan?.tick !== tick) return unchanged;
  const scan = requireDispatchScan(world);
  let run = sessions.get(pursuit);
  if (run?.done) return unchanged;
  const result = (phase, action, rejectReason = null) => ({
    action, reason: "PREDICTIVE_QUEUE", queue: {
      phase, roadId: run?.route.road.id, leadId: run?.leadId, returnCause: run?.returnCause ?? null,
    },
    candidates: [{ name: phase, action, feasible: rejectReason === null, rejectReason }],
  });
  if (!run) {
    if (requested.brake > 0 || requested.gear !== 1 || requested.throttle < .55 || Math.abs(requested.steer) > .18 ||
        ego.speed < 1 || ego.speed > 2.5 || Math.abs(ego.gtaSlipMps) > .2 || Math.abs(ego.gtaYawRate) > .2)
      return unchanged;
    const route = approach(world.drivingRoads, ego);
    if (!route) return unchanged;
    const lead = observedLane(scan, ego, route, route.home).find(({ track, dx, ahead, speed, crossSpeed }) =>
      track.kind === "civilian" && track.ageS === 0 && track.motionKnown && dx < 1.4 &&
      ahead >= 3.3 && ahead <= 6 && speed !== null && speed >= -.25 && speed <= 1.4 &&
      ego.speed - speed >= .5 && Math.abs(crossSpeed) <= .65);
    if (!lead || laneConflict(observedLane(scan, ego, route, route.pass), ego, 13, 4)) return unchanged;
    if (useCorridor) {
      const targetM = (route.pass - ego[route.across]) * route.right;
      const conflict = queuePassingConflict(scan, ego, route.heading, targetM, lead.ahead + 20);
      if (conflict) return {
        action: requested, reason: "PREDICTIVE_QUEUE",
        queue: { phase: "declined", roadId: route.road.id, leadId: lead.track.trackId, returnCause: null },
        candidates: [{ name: "passing-corridor", feasible: false, rejectReason: conflict }],
      };
    }
    run = { route, tick, leadId: lead.track.trackId, phase: "pass", done: false };
    sessions.set(pursuit, run);
  } else if (requested.brake >= .85) {
    run.done = true;
    return unchanged;
  }
  const { route } = run;
  const home = observedLane(scan, ego, route, route.home);
  if (run.phase === "pass") {
    const lead = home.find(row => row.track.trackId === run.leadId && row.track.ageS === 0 && row.dx < 1.5);
    const passed = lead && lead.ahead < -3 && Math.abs(ego[route.across] - route.home) > 2.5;
    const released = lead?.track.motionKnown && lead.speed >= 4.2 && lead.ahead > 9;
    if ((passed || released) && !laneConflict(home, ego, 9, 3)) {
      run.phase = "return";
      run.returnCause = passed ? "lead-behind" : "lead-moving-away";
      run.returnTick = tick;
      run.reattachmentM = 0;
      run.returnPose = { x: ego.x, z: ego.z };
    }
  }
  const returning = run.phase === "return", target = returning ? route.home : route.pass;
  const error = (target - ego[route.across]) * route.right;
  if (returning && Math.abs(error) <= .35 && Math.abs(angleDelta(ego.heading, route.heading)) <= .13) {
    run.done = true;
    return result("returned", requested);
  }
  if (returning) {
    run.reattachmentM += Math.hypot(ego.x - run.returnPose.x, ego.z - run.returnPose.z);
    run.returnPose = { x: ego.x, z: ego.z };
  }
  // Yielding uses time but not the distance needed to align with the home lane.
  if (returning ? run.reattachmentM > 25 || tick - run.returnTick > 1200 : tick - run.tick > 1200) {
    run.done = true;
    return result("expired", requested, "maneuver-budget");
  }
  const lane = returning ? home : observedLane(scan, ego, route, target);
  if (laneConflict(lane, ego, returning ? 6 : 7, 2.6)) return result("yield", PURSUIT_STOP, "observed-traffic");
  const desired = route.heading + Math.atan2(error, 6);
  const action = { gear: 1, steer: clamp(1.6 * angleDelta(desired, ego.heading), -.9, .9),
    brake: ego.speed > 3.4 ? .75 : 0, throttle: ego.speed < 3.15 ? .65 : 0 };
  return roadStopEnvelope(ego, route.road, action)
    ? result(run.phase, action) : result("yield", PURSUIT_STOP, "unsupported-stop");
}
