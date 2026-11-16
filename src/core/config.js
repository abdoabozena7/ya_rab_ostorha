export const STEP = 1 / 60;
export const VERSION = "2.0.0";
export const PEOPLE_MODELS = Object.freeze([
  "man-polo",
  "woman-shirt",
  "man-jacket",
  "woman-jacket",
]);
export const DEFAULTS = Object.freeze({
  seed: "cairo-42",
  traffic: 28,
  pedestrians: 32,
  chaos: 0.4,
  speedLimit: 35,
  difficulty: 2,
  scenarioInterval: 7,
});
export const VEHICLE = Object.freeze({
  length: 4.2,
  width: 1.85,
  wheelbase: 2.6,
  maxSteer: 0.62,
  steerRate: 0.9,
  acceleration: 2.4,
  braking: 7,
  reverseSpeed: 2.5,
});
export const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
export function settings(input = {}) {
  const number = (key, min, max, integer = false) => {
    const n = Number(input[key] ?? DEFAULTS[key]);
    const value = clamp(Number.isFinite(n) ? n : DEFAULTS[key], min, max);
    return integer ? Math.round(value) : value;
  };
  return {
    seed: String(input.seed ?? DEFAULTS.seed).slice(0, 64),
    traffic: number("traffic", 0, 72, true),
    pedestrians: number("pedestrians", 0, 96, true),
    chaos: number("chaos", 0, 1),
    speedLimit: number("speedLimit", 15, 50),
    difficulty: number("difficulty", 1, 5, true),
    scenarioInterval: number("scenarioInterval", 2, 20),
  };
}
