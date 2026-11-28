// SOLID Unified Driver: Perception -> Trajectory Planner -> Safety Shield, with pluggable Strategy policies.
export { DEFAULT_GAPS, HORIZON_S, SOLID_PROP_KINDS, TIMES, perceiveCorridor } from "./perception.js";
export {
  CAIRO_DEFENSIVE_STRATEGY, CITY_CRUISE_STRATEGY, PURSUIT_ESCAPE_CLEARANCES, PURSUIT_ESCAPE_STRATEGY,
  createDriverStrategy, weightedScorer,
} from "./strategies.js";
export { aimSteer, blockedDistance, planTrajectory, simulate } from "./trajectory-planner.js";
export { applySafetyShield } from "./safety-shield.js";
export { getUnifiedDriverResults, resetUnifiedDriverState, stepUnifiedDriver } from "./unified-driver.js";
