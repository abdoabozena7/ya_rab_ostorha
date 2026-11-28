import { clamp } from "../config.js";
import { accidentRouteLock, isStreetChaosAccidentActor } from "../street-chaos.js";
import { DEFAULT_GAPS, HORIZON_S, SOLID_PROP_KINDS } from "./perception.js";

export const CAIRO_OFFSETS_M = Object.freeze([-3.2, -2.2, -1.4, -0.7, 0, 0.7, 1.4, 2.2, 3.2]);
export const CITY_OFFSETS_M = Object.freeze([-2.8, -2.0, -1.2, -0.6, 0, 0.6, 1.2, 2.0, 2.8]);
export const DEFAULT_SPEED_FACTORS = Object.freeze([1.0, 0.82, 0.64, 0.45, 0.25, 0.0]);

const CAIRO_WEIGHTS = Object.freeze({
  soft: 1.15, progress: 5.2, shiftMagnitude: 0.55, shiftChange: 0.45, shiftPositive: 0.6, lowSpeed: 0.6,
  blocked: 9, cross: 0.9, steer: 0.02, gentleFactor: 0.45, gentleBandM: Object.freeze([0.65, 1.45]),
});

// Cost of a candidate rollout; lower wins. A strategy can replace this wholesale via `scoreCandidate`.
export function weightedScorer(weights) {
  const [gentleLow, gentleHigh] = weights.gentleBandM;
  return function scoreCandidate(result, ctx, commit) {
    const lookahead = ctx.blockLookaheadM;
    const maxTravel = Math.max(1, ctx.vCruise * HORIZON_S);
    const progressLoss = (1 - clamp(result.travelled / maxTravel, 0, 1)) * weights.progress;
    const magnitude = Math.abs(result.offset);
    // A gentle early sidestep around something in the way beats riding up to it and braking.
    const gentle = ctx.proactive && magnitude >= gentleLow && magnitude <= gentleHigh ? weights.gentleFactor : 1;
    const shift = (magnitude * weights.shiftMagnitude + Math.abs(result.offset - commit.offset) * weights.shiftChange +
      Math.max(0, result.offset) * weights.shiftPositive) * gentle;
    const lowSpeed = (1 - result.factor) * weights.lowSpeed;
    const blocked = ctx.blocked.get(result.offset)?.distanceM ?? Infinity;
    const blockedPenalty = Number.isFinite(blocked) ? (1 - clamp(blocked / lookahead, 0, 1)) * weights.blocked : 0;
    return result.soft * weights.soft + progressLoss + shift + lowSpeed + blockedPenalty +
      result.cross * weights.cross + result.steerSum * weights.steer;
  };
}

// Names the manoeuvre the planner just chose: emergency braking needs a genuine contact within 1.2 s,
// never a mere lateral squeeze.
export function selectReaction({ chosen, clear, threat, hardT, speed, passing, commandOffset }) {
  const wreck = Boolean(threat?.wreck);
  if (speed > 1.2 && !threat?.passing &&
      (chosen.boxed || (chosen.factor <= 0.25 && hardT < 1.2 && Math.abs(chosen.offset) < 0.6))) return "emergency-brake";
  if (passing) return "evasive-shift";
  if (Math.abs(chosen.offset) >= 0.6 && !clear) return wreck ? "accident-bypass" : "evasive-shift";
  if (chosen.factor < 0.95 && !clear) return "defensive-yield";
  if (!clear && Math.abs(commandOffset) >= 0.6) return wreck ? "accident-bypass" : "evasive-shift";
  return "cruising";
}

const DEFAULTS = Object.freeze({
  id: "custom",
  maintainContinuousCruise: false,
  offsetsM: CAIRO_OFFSETS_M,
  speedFactors: DEFAULT_SPEED_FACTORS,
  gaps: DEFAULT_GAPS,
  allowSlowLeaderPass: true,
  slowLeaderTicks: 100,
  passMinRoadWidthM: 12,
  allowCurbClearance: false,
  obeyJunctionHolds: true,
  junctionTaperMps2: 1.9,
  comfortAccelMps2: 2.0,
  comfortDecelMps2: 2.2,
  offsetSlewMps: 2.6,
  minDwellTicks: 24,
  switchMargin: 0.75,
  evalEveryTicks: 3,
  blockLookaheadM: 42,
  brakeHoldTicks: 18,
  // Speed ceilings as a car recovers from an emergency stop: standstill, then 35 %, 65 %, full.
  releaseStages: Object.freeze([0, 0.35, 0.65, 1]),
  imminentContactS: 1.1,
  costWeights: CAIRO_WEIGHTS,
  proactiveKinds: Object.freeze(["vehicle", "truck", "cut-in", "accident"]),
  // Within this distance of player.parking the lateral offset tapers back to 0; null disables it.
  parkingArrivalRadiusM: null,
  // When set, a pedestrian-only threat limits the sidestep to this many metres below the speed or within the
  // junction distance given next to it.
  pedestrianOffsetCapM: null,
  pedestrianCapSpeedMps: 4.5,
  pedestrianCapJunctionM: 22,
  // Respect the speed the base (destination/policy) command already allows instead of re-deriving it.
  honorBaseSpeed: false,
  // Hand the untouched base command back whenever the corridor is clear and the car is on its line.
  transparentWhenClear: false,
  // Centre-line straddling is only penalised on roads at least this wide (narrow lanes have no oncoming side).
  laneCrossMinRoadWidthM: 0,
  // Rollouts slow for the route's own bends and junction turns instead of holding cruise speed through them.
  followRouteSpeedProfile: false,
  // Rollouts end where the route ends instead of treating the space beyond it as a hazard.
  stopRolloutAtRouteEnd: false,
  // Cap the target speed to what can still stop before a contact the chosen trajectory cannot avoid.
  enforceStoppingEnvelope: false,
  selectReaction,
  // Environment hooks: a mode that knows about wrecks or route locks injects them; the stack itself does not.
  isWreckActor: () => false,
  getRouteLock: () => null,
  allowRerouteAtHold: () => true,
});

export function createDriverStrategy(overrides = {}) {
  const merged = { ...DEFAULTS, ...overrides };
  merged.costWeights = Object.freeze({ ...CAIRO_WEIGHTS, ...(overrides.costWeights ?? {}) });
  if (!overrides.scoreCandidate) merged.scoreCandidate = weightedScorer(merged.costWeights);
  return Object.freeze(merged);
}

/* Cairo Traffic: the tuned defensive driver, route kept alive indefinitely. */
export const CAIRO_DEFENSIVE_STRATEGY = createDriverStrategy({
  id: "cairo-defensive",
  maintainContinuousCruise: true,
  isWreckActor: isStreetChaosAccidentActor,
  getRouteLock: accidentRouteLock,
  // A jam is waited out while an accident is being bypassed, unless only a requested accident is pending.
  allowRerouteAtHold: (world, player, hold) => !accidentRouteLock(world, player) ||
    (!world.streetChaos?.accident && (hold.waitS ?? 0) > 12),
});

/* Normal Metro v5 self driving: follows the chosen destination, steers gently around anything in the way
   and relaxes onto the parking spot on arrival. */
export const CITY_CRUISE_STRATEGY = createDriverStrategy({
  id: "city-cruise",
  maintainContinuousCruise: false,
  offsetsM: CITY_OFFSETS_M,
  speedFactors: DEFAULT_SPEED_FACTORS,
  allowSlowLeaderPass: true,
  passMinRoadWidthM: 11,
  allowCurbClearance: false,
  obeyJunctionHolds: true,
  junctionTaperMps2: 1.9,
  comfortAccelMps2: 2.0,
  comfortDecelMps2: 2.2,
  costWeights: {
    // Stay near the lane centre when clear, but sidestep 0.6-2.0 m early for parked cars, slow or stopped
    // vehicles, crossing pedestrians and lamp posts.
    shiftMagnitude: 0.5, shiftPositive: 0.35, gentleFactor: 0.4, gentleBandM: [0.6, 2.0], cross: 0.25,
  },
  // The route is already planned around kerbside props, so only real encroachment counts as a squeeze.
  gaps: {
    ...DEFAULT_GAPS,
    static: { hard: 0.30, soft1: 0.40, soft2: 0.60 },
    vehicle: { hard: 0.30, soft1: 0.60, soft2: 1.0 },
  },
  proactiveKinds: ["vehicle", "truck", "cut-in", "accident", "static", "pedestrian"],
  parkingArrivalRadiusM: 16,
  pedestrianOffsetCapM: 1.4,
  honorBaseSpeed: true,
  transparentWhenClear: true,
  laneCrossMinRoadWidthM: 11,
  followRouteSpeedProfile: true,
  stopRolloutAtRouteEnd: true,
  enforceStoppingEnvelope: true,
});

/* Shared clearances for pursuit consumers: the same stack with solid props and walkers kept at wide margins
   and no route of its own. */
export const PURSUIT_ESCAPE_STRATEGY = createDriverStrategy({
  id: "pursuit-escape",
  maintainContinuousCruise: false,
  allowSlowLeaderPass: false,
  proactiveKinds: ["vehicle", "truck", "cut-in", "accident", "static", "pedestrian"],
  honorBaseSpeed: true,
  followRouteSpeedProfile: true,
  enforceStoppingEnvelope: true,
});

export const PURSUIT_ESCAPE_CLEARANCES = Object.freeze({
  solidKinds: SOLID_PROP_KINDS,
  pedestrian: DEFAULT_GAPS.pedestrian,
  sidewalk: DEFAULT_GAPS.sidewalk,
  solid: DEFAULT_GAPS.static,
});
