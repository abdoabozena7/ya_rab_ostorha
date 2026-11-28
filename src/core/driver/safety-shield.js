import { playerVehicleDimensions } from "../vehicle-spec.js";

const SHIELD_BRAKE_MPS2 = 6;
const SHIELD_STOP_MARGIN_M = 0.4;

// The last word on a plan: nothing the planner chose may outrun the distance left before a contact it
// could not steer out of (a solid pole, a walker on the roadway, a car, or the legal road edge).
function stoppingEnvelope(strategy, plan, speed) {
  if (!strategy.enforceStoppingEnvelope || !(plan.contactT < strategy.imminentContactS)) return Infinity;
  const room = Math.max(0, speed * plan.contactT - SHIELD_STOP_MARGIN_M);
  return Math.sqrt(2 * SHIELD_BRAKE_MPS2 * room);
}

// A car passing alongside that is not drifting into the lane is never grounds for an emergency stop.
function reportedReaction(plan) {
  if (plan.reaction === "emergency-brake" && plan.threat?.passing) return "defensive-yield";
  return plan.reaction;
}

export function applySafetyShield(world, player, perception, plan, strategy) {
  const dims = playerVehicleDimensions(player);
  if (plan.transparent) {
    return {
      steer: plan.steer, targetSpeed: plan.targetSpeed, reason: plan.baseReason ?? "driving", blockedBy: null,
      usePlannedPath: true,
      defensiveState: { reaction: "cruising", enabled: true, offsetM: 0, speedFactor: 1, dims },
    };
  }
  const reaction = reportedReaction(plan);
  const speed = Math.max(player.speed ?? 0, 0);
  const targetSpeed = Math.max(0, Math.min(plan.targetSpeed, stoppingEnvelope(strategy, plan, speed)));
  const quiet = reaction === "cruising";
  return {
    steer: plan.steer,
    targetSpeed,
    reason: quiet ? plan.baseReason ?? "driving" : reaction,
    blockedBy: quiet ? null : plan.threat?.id ?? null,
    usePlannedPath: !(reaction === "evasive-shift" || reaction === "accident-bypass" || plan.shifted || plan.displacedHold),
    defensiveState: {
      reaction, enabled: true, offsetM: plan.offset, speedFactor: plan.factor,
      threatId: plan.threat?.id ?? null, threatKind: plan.threat?.kind ?? null,
      ttcS: plan.ttcS ?? null, minClearanceM: plan.minClearanceM ?? null, dims,
    },
  };
}
