import { STEP } from "../core/config.js";
import { angleDelta } from "../core/geometry.js";
import { gtaVelocity } from "../core/pursuit-gta.js";
import { forecastPursuitSurface } from "../signal_processing/pursuit-scanner.js";

const copy = value => value == null ? null : { ...value };
const isContact = event => event.type === "patrol_collision" || event.type === "static_or_civilian_hit";
const reasons = { "road-boundary": "ROAD_BOUNDARY", "no-route": "NO_ROUTE", "curb-blocked": "CURB_BLOCKED",
  "curb-solid": "CURB_BLOCKED", "curb-clearance": "CURB_BLOCKED", "curb-pedestrian": "CURB_BLOCKED" };

function motion(body) {
  const velocity = gtaVelocity(body);
  return { xM: body.x, zM: body.z, headingRad: body.heading, speedMps: body.speed,
    vxMps: velocity.x, vzMps: velocity.z, steerRad: body.steer, yawRateRadS: body.gtaYawRate ?? null };
}

function nearbyPolice(world) {
  const { player, pursuit } = world;
  return [...pursuit.patrols].filter(patrol => patrol.aiState !== "WRECKED" &&
    Math.hypot(patrol.x - player.x, patrol.z - player.z) <= 65)
    .map(patrol => ({ actorId: patrol.id, ...motion(patrol) }));
}

export function startPursuitDecision(world, { source, policyId = null, status = null, requested = null,
  shieldReason = null, submitted = requested, planner = null, fault = null, inferenceMs = null, paused = false,
  cameraBrake = null } = {}) {
  const { pursuit, player } = world;
  const scan = pursuit.gta?.scan;
  const threats = Array.isArray(scan?.tracks) ? scan.tracks
    .filter(track => typeof track?.kind === "string" && track.kind !== "static")
    .slice(0, 16).map(track => ({ ...track, forecast: forecastPursuitSurface(track) })) : [];
  const sampleTick = Number.isSafeInteger(scan?.tick) ? scan.tick : null;
  const returns = Array.isArray(scan?.rays) ? scan.rays.flatMap((ray, i) =>
    ray && ray.kind !== "none" && Number.isFinite(ray.rangeM) ? [[i, ray.kind, ray.rangeM]] : []) : [];
  const route = pursuit.route;
  return { tick: world.tick, timeS: world.tick * STEP, recordedAt: new Date().toISOString(),
    phase: pursuit.phase, paused, source, policyId, status,
    requestedAction: copy(requested), shield: shieldReason ? { reason: shieldReason, action: copy(submitted) } : null,
    submittedAction: copy(submitted), ...(cameraBrake && { cameraBrake }), planner, fault, inferenceMs, ego: motion(player),
    route: route ? { id: route.id, path: route.path?.map(({ x, z }) => [x, z]) ?? [] } : null,
    escapeTarget: copy(pursuit.gta?.publicRouteGoal ?? route?.destination),
    observation: { tick: sampleTick, ageTicks: sampleTick === null ? null : world.tick - sampleTick, threats, returns,
      nearestTtcS: threats.reduce((ttc, track) => track.ageS === 0 && track.motionKnown && Number.isFinite(track.ttcS)
        ? Math.min(ttc ?? Infinity, track.ttcS) : ttc, null) },
    worldReference: { police: nearbyPolice(world), tracking: pursuit.response?.dispatch?.state ?? null,
      health: player.health ?? null }, events: [], guardRestrictions: [] };
}

export function observePursuitDecision(world, decision) {
  const { pursuit, player } = world;
  const guard = reasons[player.reason] ? player.reason : pursuit.metrics.guard;
  if (guard && guard !== "clear" && !decision.guardRestrictions.some(value => value.reason === guard))
    decision.guardRestrictions.push({ tick: world.tick, reason: guard, actorId: player.blockedBy ?? null });
  for (const event of pursuit.stepEvents ?? []) {
    if (isContact(event) || event.type === "near_miss" || event.type === "ambient_collision")
      decision.events.push({ ...event });
  }
}

function stopReason(decision, endPhase, after, displacementM) {
  const hit = decision.guardRestrictions.some(guard => guard.reason === "contact") || decision.events.some(isContact);
  if (endPhase === "busted" || endPhase === "captured") return "POLICE_PIN";
  if (endPhase === "timeout") return "EPISODE_TIMEOUT";
  if (endPhase === "wrecked" || endPhase === "crashed") return hit ? "COLLISION_RESPONSE" : "EPISODE_TERMINATED";
  if (endPhase !== "running") return "EPISODE_TERMINATED";
  if (decision.paused) return "USER_PAUSE";
  if (decision.fault) return decision.fault.code === "STALE_OBSERVATION" ? "STALE_OBSERVATION" : "CONTROLLER_FAULT";
  if (hit) return "COLLISION_RESPONSE";
  for (const guard of decision.guardRestrictions) if (reasons[guard.reason]) return reasons[guard.reason];
  if (decision.shield) return "SAFETY_INTERVENTION";
  if (decision.cameraBrake) return "CAMERA_FORECAST";
  if (decision.planner?.reason === "PREDICTIVE_QUEUE" && decision.planner.queue?.phase === "yield" &&
      decision.submittedAction?.brake === 1 && (decision.requestedAction?.brake ?? 1) < 1) return "QUEUE_YIELD";
  if (decision.source === "manual" && (decision.requestedAction?.brake > 0 ||
      (!decision.requestedAction?.throttle && Math.abs(after.speedMps) < .15))) return "MANUAL_INPUT";
  if (decision.source === "policy" && decision.requestedAction?.brake > 0 &&
      (decision.submittedAction?.brake ?? 0) > 0) return "POLICY_BRAKE";
  return displacementM <= .0001 && Math.hypot(after.vxMps, after.vzMps) < .15 ? "UNKNOWN" : null;
}

export function finishPursuitDecision(world, decision, { rewardComponents = null } = {}) {
  const { player, pursuit } = world;
  const after = motion(player);
  const displacementM = Math.hypot(after.xM - decision.ego.xM, after.zM - decision.ego.zM);
  const durationS = (world.tick - decision.tick) * STEP;
  const transitioned = pursuit.phase !== decision.phase;
  return { ...decision, endTick: world.tick, durationS, endPhase: pursuit.phase, acceptedEgo: after,
    acceptedDisplacementM: displacementM, accelerationMps2: durationS > 0 ? (after.speedMps - decision.ego.speedMps) / durationS : null,
    acceptedYawRateRadS: durationS > 0 ? angleDelta(after.headingRad, decision.ego.headingRad) / durationS : null,
    appliedAction: durationS > 0 ? copy(pursuit.action) : null,
    appliedCommand: durationS > 0 ? copy(pursuit.appliedCommand) : null,
    rewardComponents: copy(rewardComponents), capturePressureS: pursuit.metrics.capturePressureS ?? null,
    terminalCause: transitioned ? pursuit.metrics.terminalCause ?? pursuit.phase : null,
    stopReason: stopReason(decision, pursuit.phase, after, displacementM) };
}

export class PursuitDecisionTrace {
  #rows = [];
  #next = 0;
  constructor(episodeId, trainingSessionId = null) {
    this.episodeId = episodeId;
    this.trainingSessionId = trainingSessionId;
  }
  append(decision) {
    this.#rows[this.#next++ % 1800] = { schema: "pako-decisions-v1", episodeId: this.episodeId,
      trainingSessionId: this.trainingSessionId, sequence: this.#next, ...decision };
  }
  get latest() { return this.#rows[(this.#next - 1) % 1800] ?? null; }
  get size() { return this.#rows.length; }
  toJSONL() {
    const start = this.#next - this.#rows.length;
    return this.#rows.map((_, i) => JSON.stringify(this.#rows[(i + start) % 1800])).join("\n") + "\n";
  }
}
