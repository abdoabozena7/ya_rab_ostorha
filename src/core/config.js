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
export function districtOptions(input = {}) {
  const districtVersion = input.districtVersion ?? 1;
  const districtCase = input.districtCase ?? "ambient";
  if (districtVersion !== 1)
    throw new Error("Unsupported Egyptian district layout version");
  if (typeof districtCase !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(districtCase))
    throw new Error("District encounter must have a valid explicit identifier");
  return { districtVersion, districtCase };
}
export function settings(input = {}, metroLimits = null) {
  const number = (key, min, max, integer = false) => {
    const fallback = metroLimits && key === "traffic" ? 36 :
      metroLimits && key === "pedestrians" ? 48 : DEFAULTS[key];
    const n = Number(input[key] ?? fallback);
    const value = clamp(Number.isFinite(n) ? n : fallback, min, max);
    return integer ? Math.round(value) : value;
  };
  return {
    seed: String(input.seed ?? DEFAULTS.seed).slice(0, 64),
    traffic: number("traffic", 0, metroLimits?.traffic ?? 72, true),
    pedestrians: number("pedestrians", 0, metroLimits?.pedestrians ?? 96, true),
    chaos: number("chaos", 0, 1),
    speedLimit: number("speedLimit", 15, 50),
    difficulty: number("difficulty", 1, 5, true),
    scenarioInterval: number("scenarioInterval", 2, 20),
  };
}
