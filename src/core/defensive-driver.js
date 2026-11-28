// Cairo Traffic entry point: a thin adapter over the shared Unified Driver stack (src/core/driver/).
import { CAIRO_DEFENSIVE_STRATEGY } from "./driver/strategies.js";
import { getUnifiedDriverResults, stepUnifiedDriver } from "./driver/unified-driver.js";

export const DEFENSIVE_OFFSETS_M = CAIRO_DEFENSIVE_STRATEGY.offsetsM;
export const DEFENSIVE_SPEED_FACTORS = CAIRO_DEFENSIVE_STRATEGY.speedFactors;

export const defensiveDriverResults = getUnifiedDriverResults;

export const defensiveAutoCommand = (world, player, baseCommand, options = {}) =>
  stepUnifiedDriver(world, player, baseCommand, CAIRO_DEFENSIVE_STRATEGY, options);
