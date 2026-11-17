import { clamp } from "./config.js";

const profiles = Object.freeze({
  "man-polo": { height: 1.78, width: 0.3222, depth: 0.2136, mass: 76 },
  "man-jacket": { height: 1.8, width: 0.3385, depth: 0.2304, mass: 79 },
  "woman-shirt": { height: 1.66, width: 0.2693, depth: 0.2169, mass: 63 },
  "woman-jacket": { height: 1.69, width: 0.2723, depth: 0.2042, mass: 66 },
});
const modes = new Set(["ambient", "walk", "jog", "stop"]);
const finite = (value, fallback) =>
  Number.isFinite(value) ? value : fallback;

export function createPedestrianBody(actor = {}) {
  const person = actor ?? {};
  const kind = typeof person.kind === "string" ? person.kind : "";
  const female = /^(woman|female)-/.test(kind);
  const profile = Object.hasOwn(profiles, kind) ? profiles[kind] :
    profiles[female ? "woman-shirt" : "man-polo"];
  const variation = clamp(finite(person.phase, 0.5), 0, 1) - 0.5;
  const heightM = profile.height + variation * 0.14;
  const widthM = heightM * profile.width;
  const depthM = heightM * profile.depth;
  const walkSpeedMps = clamp(finite(person.walkSpeed, 1.35), 0.6, 2.4);
  return Object.freeze({
    heightM,
    widthM,
    depthM,
    massKg: profile.mass * (heightM / profile.height) ** 3,
    // The circle encloses the neutral clothed body, not an extended arm pose.
    radiusM: Math.max(0.3, Math.hypot(widthM, depthM) / 2),
    walkSpeedMps,
    jogSpeedMps: clamp(walkSpeedMps * 1.8, 2, 3.2),
    maxAccelerationMps2: 2.5,
    maxDecelerationMps2: 3.5,
    maxTurnRateRadS: 3,
  });
}

export function setPedestrianMotionMode(actor, mode) {
  if (
    !actor ||
    actor.type !== "pedestrian" ||
    actor.script?.type === "vision-linear" ||
    !modes.has(mode)
  )
    return false;
  actor.motionMode = mode;
  return true;
}
