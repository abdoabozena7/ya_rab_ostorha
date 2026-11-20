import { decideVisualBrake } from "./visual-prediction.js";
import { bodyPathAllowsLateralMotion } from "./body-path-evidence.js";

const MAX_AGE_MS = 750;
const RELEASE_MPS2 = 2.4;
const ORDINARY_DECEL_MPS2 = 2;
const MAX_VISUAL_DECEL_MPS2 = 7;
const EPS = 1e-8;
const finite = Number.isFinite;
const STATES = ["clear", "caution", "slow", "stop", "unavailable"];
const SNAPSHOT_KEYS = [
  "source", "streamId", "status", "available", "availability", "frameId", "ageMs",
  "model", "latencyMs", "detections", "projectedDetections", "unprojectableDetections",
  "tracks", "forecasts", "decision",
];
const FORECAST_KEYS = [
  "trackId", "label", "confidence", "lateralM", "longitudinalM", "lateralSpeedMps",
  "forwardSpeedMps", "lateralPositionUncertaintyM", "longitudinalPositionUncertaintyM",
  "lateralVelocityUncertaintyMps", "longitudinalVelocityUncertaintyMps",
  "lateralOccupancyS", "longitudinalArrivalS", "arrivalQualified", "uncertaintyM",
  "crossingTimeS", "clearanceTimeS", "egoArrivalTimeS", "conflictTimeS", "conflict",
  "qualified", "held", "reason",
];
const DECISION_KEYS = [
  "source", "available", "brake", "targetSpeedMps", "reason", "trackId",
  "confidence", "crossingTimeS", "ageMs", "evidenceFrameId",
];
const VISUAL_KEYS = [
  "source", "available", "state", "targetSpeedMps", "reason", "streamId",
  "frameId", "ageMs", "evidenceTrackId", "nextState", "decelerationMps2",
];
const MAP_KEYS = [
  "source", "available", "state", "reason", "targetSpeedMps", "zoneId", "distanceM",
];
const STATE_KEYS = [
  "state", "capMps", "sinceS", "evidenceKey", "recoveryFrames", "lastFrameId",
  "lastTimeS", "streamId", "recoverySinceS", "supportTimeS", "stopTrackId",
  "mapCapMps", "composedCapMps", "evidenceTrackId", "visualDecelerationMps2",
];

function plain(value, keys, name) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
    throw new TypeError(`${name} must be a plain object`);
  for (const key of Reflect.ownKeys(value)) {
    if (!keys.includes(key)) throw new TypeError(`${name}: unknown field ${String(key)}`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor.get || descriptor.set) throw new TypeError(`${name}: accessors are not data`);
  }
}
function bounded(value, min, max, name) {
  if (!finite(value) || value < min || value > max)
    throw new TypeError(`${name} must be finite within ${min}..${max}`);
}
function token(value, name) {
  if (typeof value !== "string" || !value.trim() || value.length > 200)
    throw new TypeError(`${name} must be a bounded nonempty string`);
}
function nullableNumber(value, min, max, name) {
  if (value !== null) bounded(value, min, max, name);
}
function optionalDeceleration(value, key, name) {
  if (Object.prototype.hasOwnProperty.call(value, key))
    nullableNumber(value[key], ORDINARY_DECEL_MPS2, MAX_VISUAL_DECEL_MPS2, `${name}.${key}`);
}
function validateState(value) {
  plain(value, STATE_KEYS, "district speed state");
  optionalDeceleration(value, "visualDecelerationMps2", "state");
  if (!STATES.includes(value.state)) throw new TypeError("Unknown district speed state");
  for (const key of ["capMps", "mapCapMps", "composedCapMps"])
    nullableNumber(value[key], 0, 55, `state.${key}`);
  for (const key of ["sinceS", "lastTimeS", "recoverySinceS", "supportTimeS"])
    nullableNumber(value[key], 0, 1e9, `state.${key}`);
  nullableNumber(value.lastFrameId, 0, Number.MAX_SAFE_INTEGER, "state.lastFrameId");
  if (value.lastFrameId !== null && !Number.isSafeInteger(value.lastFrameId))
    throw new TypeError("State frame identity must be an integer");
  bounded(value.recoveryFrames, 0, 2, "state.recoveryFrames");
  if (!Number.isInteger(value.recoveryFrames)) throw new TypeError("Invalid recovery frame count");
  for (const key of ["streamId", "stopTrackId", "evidenceTrackId"])
    if (value[key] !== null) token(value[key], `state.${key}`);
  if (value.evidenceKey !== null &&
      (typeof value.evidenceKey !== "string" || value.evidenceKey.length > 400))
    throw new TypeError("Invalid state evidence identity");
}

export function createDistrictSpeedState() {
  return {
    state: "clear", capMps: null, sinceS: null, evidenceKey: null,
    recoveryFrames: 0, lastFrameId: null, lastTimeS: null, streamId: null,
    recoverySinceS: null, supportTimeS: null, stopTrackId: null,
    mapCapMps: null, composedCapMps: null, evidenceTrackId: null, visualDecelerationMps2: null,
  };
}

function validateSnapshot(visual, nowS, ego) {
  plain(visual, SNAPSHOT_KEYS, "visual snapshot");
  if (visual.source !== "visual-prediction") throw new TypeError("Expected pixel predictor snapshot");
  if (visual.streamId !== null) token(visual.streamId, "visual.streamId");
  nullableNumber(visual.frameId, 0, Number.MAX_SAFE_INTEGER, "visual.frameId");
  if (visual.frameId !== null && !Number.isSafeInteger(visual.frameId))
    throw new TypeError("Visual frame identity must be an integer");
  nullableNumber(visual.ageMs, 0, 1e12, "visual.ageMs");
  if (typeof visual.available !== "boolean" ||
      !["ready", "unavailable", "stale", "error"].includes(visual.status))
    throw new TypeError("Invalid visual availability");
  if (visual.availability !== undefined) {
    plain(visual.availability, ["status", "available", "error"], "visual availability");
    if (!["ready", "unavailable", "stale", "error"].includes(visual.availability.status) ||
        typeof visual.availability.available !== "boolean" ||
        (visual.availability.error !== null && typeof visual.availability.error !== "string"))
      throw new TypeError("Invalid nested visual availability");
  }
  if (visual.model !== null && visual.model !== undefined) {
    plain(visual.model, ["id", "method", "provider", "weightsSha256"], "visual model");
    for (const key of ["id", "method", "provider"]) token(visual.model[key], `visual model.${key}`);
    if (visual.model.weightsSha256 !== null && !/^[a-f0-9]{64}$/i.test(visual.model.weightsSha256 ?? ""))
      throw new TypeError("Invalid visual model identity");
  }
  for (const key of ["detections", "projectedDetections", "unprojectableDetections"]) {
    if (visual[key] !== undefined) {
      bounded(visual[key], 0, 128, `visual.${key}`);
      if (!Number.isInteger(visual[key])) throw new TypeError("Detection counts must be integers");
    }
  }
  if (visual.latencyMs !== null && visual.latencyMs !== undefined)
    bounded(visual.latencyMs, 0, 60000, "visual.latencyMs");
  if (visual.decision !== undefined) {
    plain(visual.decision, DECISION_KEYS, "visual decision");
    if (visual.decision.source !== "visual-prediction" ||
        typeof visual.decision.available !== "boolean" || typeof visual.decision.brake !== "boolean")
      throw new TypeError("Invalid original visual decision");
    token(visual.decision.reason, "visual decision reason");
    if (visual.decision.trackId !== null) token(visual.decision.trackId, "visual decision track");
    for (const key of ["targetSpeedMps", "crossingTimeS", "ageMs", "evidenceFrameId"])
      nullableNumber(visual.decision[key], 0, 1e12, `visual decision.${key}`);
    bounded(visual.decision.confidence, 0, 1, "visual decision confidence");
  }
  if (!Array.isArray(visual.forecasts) || visual.forecasts.length > 24)
    throw new TypeError("Visual forecasts must be bounded");
  for (const forecast of visual.forecasts) {
    plain(forecast, FORECAST_KEYS, "visual forecast");
    for (const key of ["trackId", "reason"]) token(forecast[key], `forecast.${key}`);
    if (!["person", "motion", "vehicle"].includes(forecast.label))
      throw new TypeError("Invalid visual forecast class");
    for (const key of ["arrivalQualified", "conflict", "qualified", "held"])
      if (typeof forecast[key] !== "boolean") throw new TypeError("Invalid forecast qualification");
    for (const key of FORECAST_KEYS.filter((key) =>
      !["trackId", "label", "reason", "arrivalQualified", "conflict", "qualified", "held",
        "lateralOccupancyS", "longitudinalArrivalS"].includes(key)))
      nullableNumber(forecast[key], -1e12, 1e12, `forecast.${key}`);
    if (forecast.longitudinalArrivalS !== null && forecast.longitudinalArrivalS !== undefined) {
      plain(forecast.longitudinalArrivalS,
        ["earliestEntryS", "latestEntryS", "earliestExitS", "latestExitS"], "visual arrival");
      for (const value of Object.values(forecast.longitudinalArrivalS))
        nullableNumber(value, 0, 6, "visual arrival time");
    }
    if (forecast.lateralOccupancyS !== null && forecast.lateralOccupancyS !== undefined) {
      if (!Array.isArray(forecast.lateralOccupancyS) || forecast.lateralOccupancyS.length !== 2)
        throw new TypeError("Visual occupancy must be an interval");
      forecast.lateralOccupancyS.forEach((v) => bounded(v, 0, 6, "visual occupancy"));
    }
  }
  // Reuse the original strict nested track/episode/odometry validator and hard-stop rule.
  const brake = decideVisualBrake({ tracks: visual.tracks, nowS, ego });
  const frameTimeS = finite(visual.ageMs) ? nowS - visual.ageMs / 1000 : null;
  const coherent = visual.frameId !== null && visual.streamId !== null &&
    frameTimeS !== null && frameTimeS >= -EPS &&
    visual.model !== null && visual.model !== undefined &&
    finite(visual.latencyMs) && visual.latencyMs <= MAX_AGE_MS &&
    visual.tracks.every((track) => track.streamId === visual.streamId &&
      track.frameId <= visual.frameId &&
      track.lastSeenS <= frameTimeS + EPS &&
      (track.frameId !== visual.frameId || Math.abs(track.lastSeenS - frameTimeS) <= EPS));
  return { brake, frameTimeS, coherent };
}

function supportAge(nowS, times, ages = []) {
  return Math.max(...times.map((time) => (nowS - time) * 1000), ...ages);
}
function recentMotion(track, nowS, ego) {
  // Two points can bootstrap caution, but must not outvote available corroboration.
  for (let count = Math.max(2, Math.min(3, track.history.length)); count <= track.history.length; count++) {
    const samples = track.history.slice(-count);
    const span = samples.at(-1).simulationTimeS - samples[0].simulationTimeS;
    if (span > MAX_AGE_MS / 1000 + EPS) break;
    if (count >= 3 && span < 0.2 - EPS) continue;
    const motion = fitRecentMotion(track, samples, nowS, ego);
    if (motion && Math.abs(motion.lateralMps) - motion.lateralVelocityErrorMps >= 0.2)
      return motion;
  }
  return null;
}
function fitRecentMotion(track, samples, nowS, ego) {
  if (samples.length < 2) return null;
  const first = samples[0], last = samples.at(-1), span = last.simulationTimeS - first.simulationTimeS;
  if (span < 0.1 - EPS) return null;
  const vx = (last.position.x - first.position.x) / span;
  const vz = (last.position.z - first.position.z) / span;
  const c = Math.cos(ego.headingRad), s = Math.sin(ego.headingRad);
  let residual = 0, lateralResidual = 0, forwardResidual = 0;
  for (const sample of samples) {
    const t = sample.simulationTimeS - first.simulationTimeS;
    const dx = sample.position.x - first.position.x - vx * t;
    const dz = sample.position.z - first.position.z - vz * t;
    residual = Math.max(residual, Math.hypot(dx, dz));
    lateralResidual = Math.max(lateralResidual, Math.abs(dx * c - dz * s));
    forwardResidual = Math.max(forwardResidual, Math.abs(dx * s + dz * c));
  }
  if (Math.hypot(vx, vz) > 4 || residual > 0.35) return null;
  const ageS = Math.max(0, nowS - last.simulationTimeS);
  const dx = last.position.x + vx * ageS - ego.x;
  const dz = last.position.z + vz * ageS - ego.z;
  const covariance = track.positionCovarianceM2;
  const lateralPositionErrorM = Math.sqrt(Math.max(0,
    c * c * covariance.xx - 2 * c * s * covariance.xz + s * s * covariance.zz));
  const forwardPositionErrorM = Math.sqrt(Math.max(0,
    s * s * covariance.xx + 2 * c * s * covariance.xz + c * c * covariance.zz));
  // Two samples fit perfectly even when their measured position intervals overlap.
  const velocityErrorMps = Math.max(0.1 + 2 * residual / span, 2 * lateralPositionErrorM / span);
  return {
    lateralM: dx * c - dz * s, forwardM: dx * s + dz * c,
    lateralMps: vx * c - vz * s, forwardMps: vx * s + vz * c,
    lateralVelocityErrorMps: Math.max(0.1 + 2 * lateralResidual / span, 2 * lateralPositionErrorM / span),
    forwardVelocityErrorMps: Math.max(0.1 + 2 * forwardResidual / span, 2 * forwardPositionErrorM / span),
    velocityErrorMps, positionErrorM: track.uncertaintyM + ageS * velocityErrorMps,
    supportTimeS: first.simulationTimeS,
    ageMs: supportAge(nowS, samples.map((p) => p.simulationTimeS), [track.ageMs]),
  };
}

function cityApproach(track, motion, nowS, ego, requestedSpeedMps, currentFrameId) {
  if (track.frameId !== currentFrameId || track.history.length < 3 ||
      nowS - motion.supportTimeS > MAX_AGE_MS / 1000 + EPS ||
      track.lastSeenS - motion.supportTimeS < .2 - EPS) return null;
  const { lateralM, forwardM, lateralMps, forwardMps,
    lateralVelocityErrorMps, forwardVelocityErrorMps, positionErrorM } = motion;
  const laneHalf = ego.widthM / 2 + .35;
  const toward = -Math.sign(lateralM) * lateralMps;
  const closing = ego.speedMps - forwardMps;
  if (toward - lateralVelocityErrorMps < .2 || lateralVelocityErrorMps > .65 ||
      closing - forwardVelocityErrorMps < .2 || Math.abs(lateralM) <= laneHalf) return null;
  const gap = forwardM - ego.lengthM / 2 - .35;
  const entry = (Math.abs(lateralM) - laneHalf) / toward;
  const exit = (Math.abs(lateralM) + laneHalf) / toward;
  const arrival = gap / closing;
  const egoExit = (forwardM + ego.lengthM / 2 + .35) / closing;
  // Use nominal overlap for caution only. The stricter sustained stop still
  // requires the independent visual-brake forecast's bounded conflict test.
  if (gap <= 0 || arrival > 6 || entry > 4 || egoExit < entry - .2 ||
      arrival > exit + .35) return null;
  const clearRoom = Math.max(0, gap - Math.min(3, positionErrorM) - 3.5);
  const targetSpeedMps = Math.min(requestedSpeedMps, Math.max(1.5, Math.min(
    Math.sqrt(2 * ORDINARY_DECEL_MPS2 * clearRoom),
    clearRoom / Math.max(1, exit + .4),
  )));
  if (targetSpeedMps >= Math.min(ego.speedMps, requestedSpeedMps) - .08) return null;
  return {
    ...motion, track,
    state: "slow", reason: "observed-approach-slow", targetSpeedMps,
    decelerationMps2: Math.min(MAX_VISUAL_DECEL_MPS2, Math.max(ORDINARY_DECEL_MPS2,
      (ego.speedMps ** 2 - targetSpeedMps ** 2) / Math.max(1, 2 * clearRoom))),
  };
}

function gradedCandidate(track, nowS, ego, requestedSpeedMps, forecast, currentFrameId, cityLead) {
  if (track.confidence < (track.label === "motion" ? 0.7 : 0.6)) return null;
  if (track.label === "vehicle") {
    // View caution is about current presence, not a velocity estimate.
    if (track.frameId !== currentFrameId || track.history.length < 2) return null;
    const observed = track.history.at(-1), c = Math.cos(ego.headingRad), s = Math.sin(ego.headingRad);
    const dx = observed.position.x - ego.x, dz = observed.position.z - ego.z;
    const side = Math.abs(dx * c - dz * s), forwardM = dx * s + dz * c;
    if (side < ego.widthM / 2 || side > ego.widthM / 2 + 1.8 ||
        forwardM <= ego.lengthM / 2 || forwardM > 14) return null;
    return {
      track, state: "caution", reason: "observed-vehicle-view-caution",
      supportTimeS: observed.simulationTimeS,
      ageMs: supportAge(nowS, [observed.simulationTimeS], [track.ageMs]),
      targetSpeedMps: Math.min(requestedSpeedMps, Math.max(1.5, requestedSpeedMps * 0.9)),
    };
  }
  if (!track.reliable) return null;
  const motion = recentMotion(track, nowS, ego);
  if (!motion) return null;
  const { lateralM, forwardM, lateralMps, forwardMps, velocityErrorMps } = motion;
  if (forwardM <= ego.lengthM / 2 || forwardM > 30) return null;
  if (!bodyPathAllowsLateralMotion(track, motion, ego)) return null;
  if (cityLead) return cityApproach(track, motion, nowS, ego, requestedSpeedMps, currentFrameId);
  if (Math.abs(lateralMps) - motion.lateralVelocityErrorMps < 0.2 || lateralM * lateralMps >= 0)
    return null;
  const laneHalf = ego.widthM / 2 + 0.35;
  const entryS = Math.max(0, (Math.abs(lateralM) - laneHalf) / Math.abs(lateralMps));
  const exitS = (Math.abs(lateralM) + laneHalf) / Math.abs(lateralMps);
  const closingMps = ego.speedMps - forwardMps;
  if (closingMps - motion.forwardVelocityErrorMps <= 0.2 || entryS > 6) return null;
  const gapM = forwardM - ego.lengthM / 2 - 0.35;
  const egoEntryS = Math.max(0, gapM / closingMps);
  const egoExitS = (forwardM + ego.lengthM / 2 + 0.35) / closingMps;
  if (egoEntryS > exitS + 0.25 || egoExitS < entryS - 0.25 || egoEntryS > 6) return null;
  const close = entryS < 1.4 || gapM < ego.speedMps ** 2 / 4 + ego.speedMps * 0.9 + 1.5;
  const availableTimeS = Math.max(0, (Math.abs(lateralM) - laneHalf - motion.positionErrorM) /
    (Math.abs(lateralMps) + velocityErrorMps));
  const availableDistanceM = Math.max(0, gapM - motion.positionErrorM);
  // v/a and v²/(2a) reserve ordinary stopping time and distance; only the qualified rule demands zero.
  const stoppingCapMps = Math.min(Math.max(0, ego.speedMps),
    ORDINARY_DECEL_MPS2 * availableTimeS,
    Math.sqrt(2 * ORDINARY_DECEL_MPS2 * availableDistanceM));
  const targetSpeedMps = Math.min(requestedSpeedMps, Math.max(1.5, stoppingCapMps));
  const selectedSamples = track.history.filter((sample) =>
    sample.simulationTimeS >= motion.supportTimeS - EPS);
  const corroboration = selectedSamples.length >= 3 ? motion
    : fitRecentMotion(track, track.history.slice(-3), nowS, ego);
  const c = Math.cos(ego.headingRad), s = Math.sin(ego.headingRad);
  const fittedLateralMps = track.velocity.x * c - track.velocity.z * s;
  const fittedLateralErrorMps = 0.05 + Math.sqrt(Math.max(0,
    c * c * track.velocityCovarianceM2S2.xx - 2 * c * s * track.velocityCovarianceM2S2.xz +
    s * s * track.velocityCovarianceM2S2.zz));
  let decelerationMps2, supportTimeS = motion.supportTimeS, ageMs = motion.ageMs;
  if (track.observations >= 3 && track.frameId === currentFrameId && targetSpeedMps > 0 &&
      targetSpeedMps < Math.min(requestedSpeedMps, ego.speedMps) - EPS &&
      Math.abs(fittedLateralMps) > fittedLateralErrorMps && fittedLateralMps * lateralMps > 0 &&
      finite(forecast?.confidence) && forecast.confidence <= 1 &&
      forecast.confidence >= (track.label === "motion" ? 0.65 : 0.55) &&
      corroboration && track.lastSeenS - corroboration.supportTimeS >= 0.2 - EPS &&
      corroboration.ageMs <= MAX_AGE_MS + EPS &&
      Math.abs(corroboration.lateralMps) - corroboration.lateralVelocityErrorMps >= 0.2 &&
      corroboration.lateralMps * lateralMps > 0 &&
      corroboration.lateralM * corroboration.lateralMps < 0 &&
      ego.speedMps - corroboration.forwardMps - corroboration.forwardVelocityErrorMps > 0.2) {
    // Reserve stopping time/distance without ever lowering the positive graded target to zero.
    const needed = Math.min(MAX_VISUAL_DECEL_MPS2, Math.max(ORDINARY_DECEL_MPS2,
      ego.speedMps / Math.max(EPS, availableTimeS),
      ego.speedMps ** 2 / (2 * Math.max(EPS, availableDistanceM))));
    if (needed > ORDINARY_DECEL_MPS2 + EPS) {
      decelerationMps2 = needed;
      supportTimeS = Math.min(supportTimeS, corroboration.supportTimeS);
      ageMs = Math.max(ageMs, corroboration.ageMs);
    }
  }
  return {
    ...motion, track, supportTimeS, ageMs, decelerationMps2, state: close ? "slow" : "caution",
    reason: close ? "observed-approach-slow" : "observed-approach-caution",
    targetSpeedMps,
  };
}

/** Predictor snapshots and captured own odometry only; never accepts a World or map. */
export function decideDistrictVisualSpeed(input = {}) {
  plain(input, ["visual", "ego", "requestedSpeedMps", "nowS", "visionRequired", "previousState", "cityLead"],
    "district visual input");
  const { visual = null, ego, requestedSpeedMps, nowS, visionRequired,
    previousState = createDistrictSpeedState(), cityLead = false } = input;
  bounded(nowS, 0, 1e9, "nowS");
  bounded(requestedSpeedMps, 0, 55, "requestedSpeedMps");
  if (typeof visionRequired !== "boolean") throw new TypeError("visionRequired must be explicit");
  if (typeof cityLead !== "boolean") throw new TypeError("City lead must be a boolean");
  validateState(previousState);
  if (previousState.lastTimeS !== null && nowS < previousState.lastTimeS - EPS)
    throw new TypeError("District visual time cannot go backwards");
  const checked = visual === null
    ? { brake: decideVisualBrake({ tracks: [], nowS, ego }), frameTimeS: null, coherent: false }
    : validateSnapshot(visual, nowS, ego);
  const next = { ...previousState, lastTimeS: nowS };
  const result = {
    source: "camera-pixels", available: false, state: "unavailable", targetSpeedMps: null,
    reason: "camera-evidence-unavailable", streamId: visual?.streamId ?? null,
    frameId: visual?.frameId ?? null, ageMs: visual?.ageMs ?? null, evidenceTrackId: null,
  };
  const finish = () => {
    if (next.state !== result.state || next.sinceS === null) next.sinceS = nowS;
    next.state = result.state;
    next.evidenceTrackId = result.evidenceTrackId;
    if (!result.available || !["caution", "slow"].includes(result.state) ||
        result.targetSpeedMps === null || result.targetSpeedMps < 1.5 - EPS)
      delete result.decelerationMps2;
    next.visualDecelerationMps2 = result.decelerationMps2 ?? null;
    return { ...result, nextState: next };
  };
  if (!visionRequired) {
    Object.assign(next, { capMps: null, recoveryFrames: 0, recoverySinceS: null,
      evidenceKey: null, supportTimeS: null, stopTrackId: null,
      streamId: result.streamId, lastFrameId: result.frameId });
    result.reason = "camera-policy-not-requested";
    return finish();
  }
  const unavailable = (reason, ageMs = result.ageMs) => {
    Object.assign(result, { reason, ageMs, targetSpeedMps: 0 });
    Object.assign(next, { capMps: 0, recoveryFrames: 0, recoverySinceS: null,
      streamId: result.streamId, lastFrameId: result.frameId });
    return finish();
  };
  if (!visual) return unavailable("camera-evidence-unavailable", null);
  if (!checked.coherent) return unavailable("camera-evidence-mismatch", null);
  if (visual.status !== "ready" || !visual.available ||
      visual.availability?.available === false || visual.availability?.error ||
      (visual.availability !== undefined && visual.availability.status !== "ready") ||
      !finite(visual.ageMs) || visual.ageMs > MAX_AGE_MS + EPS)
    return unavailable("camera-evidence-unavailable");

  const key = `${visual.streamId.length}:${visual.streamId}:${visual.frameId}`;
  const sameStream = previousState.streamId === visual.streamId;
  if (sameStream && previousState.lastFrameId !== null && visual.frameId < previousState.lastFrameId)
    return unavailable("camera-frame-out-of-order");
  const track = visual.tracks.find((item) => item.id === checked.brake.trackId);
  const priorStop = previousState.stopTrackId && sameStream
    ? visual.tracks.find((item) => item.id === previousState.stopTrackId) : null;
  const clearance = priorStop?.stopEpisode?.phase === "cleared" &&
    nowS - priorStop.lastSeenS <= MAX_AGE_MS / 1000 + EPS;
  let supportTimeS = checked.frameTimeS;
  if (checked.brake.available && checked.brake.brake && track) {
    const evidence = track.history.find((p) => p.frameId === checked.brake.evidenceFrameId);
    const times = [track.lastSeenS, evidence?.simulationTimeS ?? track.lastSeenS];
    if (track.stopEpisode && ["stopping", "awaiting-clearance"].includes(track.stopEpisode.phase))
      times.push(track.stopEpisode.lastSupportTimeS);
    else times.push(...track.history.slice(-3).map((p) => p.simulationTimeS));
    result.ageMs = supportAge(nowS, times, [visual.ageMs, track.ageMs, checked.brake.ageMs]);
    result.evidenceTrackId = track.id;
    if (result.ageMs > MAX_AGE_MS + EPS)
      return unavailable("camera-support-stale", result.ageMs);
    Object.assign(result, { available: true, state: "stop", targetSpeedMps: 0,
      reason: checked.brake.reason });
    Object.assign(next, { capMps: 0, evidenceKey: key, supportTimeS: Math.min(...times),
      stopTrackId: track.id, recoveryFrames: 0, recoverySinceS: null,
      lastFrameId: visual.frameId, streamId: visual.streamId });
    return finish();
  }
  if (previousState.stopTrackId && !clearance) {
    result.evidenceTrackId = previousState.stopTrackId;
    const ageMs = priorStop ? supportAge(nowS, [priorStop.lastSeenS], [visual.ageMs, priorStop.ageMs])
      : previousState.supportTimeS === null ? null : (nowS - previousState.supportTimeS) * 1000;
    return unavailable("awaiting-fresh-visual-clearance", ageMs);
  }
  next.stopTrackId = null;
  const candidates = visual.tracks.map((item) =>
    gradedCandidate(item, nowS, ego, requestedSpeedMps,
      visual.forecasts.find((forecast) => forecast.trackId === item.id && forecast.label === item.label),
      visual.frameId, cityLead)).filter(Boolean)
    .sort((a, b) => a.targetSpeedMps - b.targetSpeedMps || a.track.id.localeCompare(b.track.id));
  const candidate = candidates[0];
  if (candidate) {
    result.ageMs = Math.max(visual.ageMs, candidate.ageMs);
    result.evidenceTrackId = candidate.track.id;
    if (previousState.evidenceKey === key && previousState.evidenceTrackId === candidate.track.id &&
        previousState.visualDecelerationMps2 != null && previousState.supportTimeS !== null)
      result.ageMs = Math.max(result.ageMs, (nowS - previousState.supportTimeS) * 1000);
    if (result.ageMs > MAX_AGE_MS + EPS)
      return unavailable("camera-support-stale", result.ageMs);
    supportTimeS = Math.min(supportTimeS, candidate.supportTimeS);
    if (previousState.evidenceKey === key && previousState.evidenceTrackId === candidate.track.id &&
        previousState.visualDecelerationMps2 != null && previousState.supportTimeS !== null)
      supportTimeS = Math.min(supportTimeS, previousState.supportTimeS);
  }
  const newFrame = !sameStream || previousState.lastFrameId === null ||
    visual.frameId > previousState.lastFrameId;
  if (previousState.state === "unavailable" || (!sameStream && previousState.streamId !== null)) {
    const count = sameStream ? previousState.recoveryFrames : 0;
    next.recoverySinceS = count ? previousState.recoverySinceS : checked.frameTimeS;
    next.recoveryFrames = Math.min(2, count + (newFrame ? 1 : 0));
    if (next.recoveryFrames < 2 ||
        checked.frameTimeS - next.recoverySinceS < 0.1 - EPS) {
      Object.assign(result, { reason: "camera-recovering", targetSpeedMps: 0 });
      Object.assign(next, { capMps: 0, evidenceKey: key, supportTimeS,
        streamId: visual.streamId, lastFrameId: visual.frameId });
      return finish();
    }
  }
  const desired = candidate?.targetSpeedMps ?? requestedSpeedMps;
  let cap = desired;
  let holding = false;
  if (previousState.capMps !== null && cap > previousState.capMps) {
    const sameEvidenceHold = previousState.evidenceKey === key &&
      ["caution", "slow"].includes(previousState.state);
    holding = sameEvidenceHold;
    const difference = cap - previousState.capMps;
    const elapsed = previousState.lastTimeS === null ? 0 : nowS - previousState.lastTimeS;
    cap = sameEvidenceHold || (candidate && difference <= 0.3)
      ? previousState.capMps : Math.min(cap, previousState.capMps + RELEASE_MPS2 * elapsed);
  }
  if (holding && previousState.supportTimeS !== null) {
    result.evidenceTrackId ??= previousState.evidenceTrackId;
    supportTimeS = Math.min(supportTimeS, previousState.supportTimeS);
    result.ageMs = Math.max(result.ageMs, (nowS - supportTimeS) * 1000);
    if (result.ageMs > MAX_AGE_MS + EPS)
      return unavailable("camera-support-stale", result.ageMs);
  }
  Object.assign(result, { available: true, state: holding ? previousState.state : candidate?.state ?? "clear",
    targetSpeedMps: candidate || cap < requestedSpeedMps - EPS ? cap : null,
    reason: holding ? "camera-evidence-hold" : candidate?.reason ?? (cap < requestedSpeedMps - EPS
      ? "camera-cap-release" : "no-observed-crossing-conflict") });
  if (candidate?.decelerationMps2 !== undefined)
    result.decelerationMps2 = candidate.decelerationMps2;
  if (holding && result.evidenceTrackId !== null &&
      previousState.evidenceTrackId === result.evidenceTrackId &&
      previousState.visualDecelerationMps2 != null)
    result.decelerationMps2 = Math.max(result.decelerationMps2 ?? ORDINARY_DECEL_MPS2,
      previousState.visualDecelerationMps2);
  Object.assign(next, { capMps: result.targetSpeedMps, supportTimeS, evidenceKey: key,
    recoveryFrames: 2, recoverySinceS: null, lastFrameId: visual.frameId, streamId: visual.streamId });
  return finish();
}

/** A geometric STATIC prior, not measured visibility or knowledge of a hidden pedestrian. */
export function mappedDistrictSpeed(input = {}) {
  plain(input, ["zones", "ego"], "mapped district input");
  const { zones, ego } = input;
  decideVisualBrake({ tracks: [], nowS: 0, ego });
  if (!Array.isArray(zones) || zones.length > 128) throw new TypeError("Static zones must be bounded");
  let selected = null;
  for (const zone of zones) {
    plain(zone, ["id", "x", "z", "heading", "approachM", "clearanceM",
      "visibilityDistanceM", "speedLimitMps"], "static caution zone");
    token(zone.id, "zone.id");
    for (const key of ["x", "z", "heading"]) bounded(zone[key], -100000, 100000, `zone.${key}`);
    bounded(zone.approachM, 0.01, 200, "zone.approachM");
    bounded(zone.clearanceM, 0, 30, "zone.clearanceM");
    bounded(zone.visibilityDistanceM, 0, 100, "zone.visibilityDistanceM");
    bounded(zone.speedLimitMps, 0.01, 55, "zone.speedLimitMps");
    const yaw = Math.atan2(Math.sin(ego.headingRad - zone.heading),
      Math.cos(ego.headingRad - zone.heading));
    if (Math.abs(yaw) > 0.7 + EPS) continue;
    const dx = zone.x - ego.x, dz = zone.z - ego.z;
    const distanceM = dx * Math.sin(zone.heading) + dz * Math.cos(zone.heading);
    const lateralM = dx * Math.cos(zone.heading) - dz * Math.sin(zone.heading);
    const approaching = distanceM > 0 && distanceM <= zone.approachM;
    const clearing = distanceM <= 0 && distanceM > -zone.clearanceM;
    if ((!approaching && !clearing) || Math.abs(lateralM) > 4 + EPS) continue;
    const cornerCap = Math.max(1.5, Math.min(zone.speedLimitMps,
      Math.sqrt(4 * Math.max(0, zone.visibilityDistanceM - ego.lengthM / 2 - 0.35))));
    const cap = Math.max(1.5, Math.min(zone.speedLimitMps,
      Math.sqrt(cornerCap ** 2 + 4 * Math.max(0, distanceM - zone.visibilityDistanceM))));
    const value = { source: "static-map", available: true, state: "caution",
      reason: "mapped-blind-corner", targetSpeedMps: cap, zoneId: zone.id, distanceM };
    if (!selected || cap < selected.targetSpeedMps ||
        (cap === selected.targetSpeedMps && zone.id < selected.zoneId)) selected = value;
  }
  return selected ?? { source: "static-map", available: true, state: "clear",
    reason: "outside-mapped-caution", targetSpeedMps: null, zoneId: null, distanceM: null };
}

function sourceRecord(value, keys) {
  return value ? Object.fromEntries(keys.filter((key) => key !== "nextState" && key in value)
    .map((key) => [key, value[key]])) : null;
}
function validateCap(value, keys, source, name) {
  if (value === null) return;
  plain(value, keys, name);
  if (value.source !== source || !STATES.includes(value.state) || typeof value.available !== "boolean")
    throw new TypeError(`Invalid ${name} provenance/state`);
  nullableNumber(value.targetSpeedMps, 0, 55, `${name}.targetSpeedMps`);
  token(value.reason, `${name}.reason`);
  if (source === "camera-pixels") {
    optionalDeceleration(value, "decelerationMps2", "visual");
    if (value.streamId !== null) token(value.streamId, "visual cap stream");
    if (value.evidenceTrackId !== null) token(value.evidenceTrackId, "visual cap track");
    nullableNumber(value.frameId, 0, Number.MAX_SAFE_INTEGER, "visual cap frame");
    nullableNumber(value.ageMs, 0, 1e12, "visual cap age");
  } else {
    if (value.zoneId !== null) token(value.zoneId, "map cap zone");
    nullableNumber(value.distanceM, -1e6, 1e6, "map cap distance");
  }
}

export function composeDistrictSpeed(command, input = {}) {
  plain(input, ["visual", "map", "dt", "previousState"], "district composition");
  const { visual = null, map = null, dt, previousState = createDistrictSpeedState() } = input;
  bounded(command.targetSpeed, -55, 55, "command.targetSpeed");
  bounded(dt, 0, 1, "dt");
  validateState(previousState);
  validateCap(visual, VISUAL_KEYS, "camera-pixels", "visual cap");
  validateCap(map, MAP_KEYS, "static-map", "map cap");
  const nextState = { ...(visual?.nextState ?? previousState) };
  validateState(nextState);
  const visualCap = visual?.targetSpeedMps ?? Infinity;
  let mapCap = map?.targetSpeedMps ?? Infinity;
  if (previousState.mapCapMps !== null && mapCap > previousState.mapCapMps)
    mapCap = Math.min(mapCap, previousState.mapCapMps + RELEASE_MPS2 * dt);
  const requested = Math.max(0, command.targetSpeed);
  nextState.mapCapMps = finite(mapCap) && mapCap < 55 ? mapCap : null;
  const targetSpeed = command.targetSpeed < 0 ? command.targetSpeed
    : Math.min(requested, visualCap, mapCap);
  nextState.composedCapMps = Math.max(0, targetSpeed);
  const cameraBinds = command.targetSpeed >= 0 && visualCap < requested - EPS &&
    visualCap <= mapCap + EPS;
  const mapBinds = command.targetSpeed >= 0 && mapCap < requested - EPS &&
    mapCap <= visualCap + EPS;
  const supportedCameraResponse = cameraBinds && visual.available && visualCap >= 1.5 - EPS &&
    ["caution", "slow"].includes(visual.state) && visual.evidenceTrackId !== null &&
    visual.streamId !== null && Number.isSafeInteger(visual.frameId) &&
    finite(visual.ageMs) && visual.ageMs <= MAX_AGE_MS + EPS;
  nextState.visualDecelerationMps2 = supportedCameraResponse ? visual.decelerationMps2 ?? null : null;
  const appliedSource = cameraBinds && mapBinds ? "both" : cameraBinds ? "camera-pixels"
    : mapBinds ? "static-map" : "behavior";
  const mapRecord = sourceRecord(map, MAP_KEYS) ?? (finite(mapCap) ? {
    source: "static-map", available: false, state: "clear", reason: "mapped-caution-release",
    targetSpeedMps: mapCap, zoneId: null, distanceM: null,
  } : null);
  if (mapRecord && mapCap < Infinity) {
    mapRecord.targetSpeedMps = mapCap;
    if (map?.targetSpeedMps == null) mapRecord.reason = "mapped-caution-release";
  }
  const result = {
    ...command, targetSpeed, nextState,
    districtSources: { requestedMps: command.targetSpeed, behaviorMps: command.targetSpeed,
      visual: sourceRecord(visual, VISUAL_KEYS), map: mapRecord,
      composedMps: targetSpeed, finalMps: targetSpeed, appliedSource },
  };
  if (cameraBinds || mapBinds) {
    result.reason = cameraBinds && mapBinds ? "camera-and-mapped-caution"
      : cameraBinds ? visual.reason : mapRecord.reason;
    result.blockedBy = cameraBinds ? visual.evidenceTrackId : mapRecord.zoneId;
    if (targetSpeed > 0 || (cameraBinds && visual.state === "unavailable"))
      result.decelerationMps2 = supportedCameraResponse
        ? visual.decelerationMps2 ?? ORDINARY_DECEL_MPS2 : ORDINARY_DECEL_MPS2;
    else delete result.decelerationMps2;
  } else if (targetSpeed === 0) delete result.decelerationMps2;
  return result;
}

/** Called only AFTER safeSpeed; this describes the command actually sent to the plant. */
export function attributeDistrictApplied({ requested, behavior, composed, safe }) {
  for (const [name, command] of Object.entries({ requested, behavior, composed, safe }))
    bounded(command?.targetSpeed, -55, 55, `${name}.targetSpeed`);
  const physicalReduction = safe.targetSpeed < composed.targetSpeed - EPS;
  const guardBinds = safe.targetSpeed < composed.targetSpeed - 0.05;
  const guardStop = safe.targetSpeed === 0 && typeof safe.reason === "string" &&
    safe.reason !== composed.reason && !["idle", "driving"].includes(safe.reason);
  let appliedSource = composed.districtSources?.appliedSource ?? "requested";
  if (guardBinds || guardStop) appliedSource = "physical-guard";
  else if (!["camera-pixels", "static-map", "both"].includes(appliedSource))
    appliedSource = behavior.targetSpeed < requested.targetSpeed - EPS ? "behavior" : "requested";
  const result = {
    ...composed, ...safe,
    districtSources: { ...composed.districtSources, requestedMps: requested.targetSpeed,
      behaviorMps: behavior.targetSpeed, composedMps: composed.targetSpeed,
      finalMps: safe.targetSpeed, appliedSource },
  };
  if (!physicalReduction && !guardStop) {
    result.reason = composed.reason ?? safe.reason;
    result.blockedBy = composed.blockedBy === undefined ? safe.blockedBy : composed.blockedBy;
  }
  if (physicalReduction || guardStop || (safe.targetSpeed === 0 &&
      (appliedSource !== "camera-pixels" || composed.districtSources?.visual?.state !== "unavailable")))
    delete result.decelerationMps2;
  return result;
}
