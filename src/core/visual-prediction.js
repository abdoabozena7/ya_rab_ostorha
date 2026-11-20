import { VEHICLE } from "./config.js";
import { bodyPathAllowsLateralMotion } from "./body-path-evidence.js";

const SOURCE = "visual-prediction";
const PIXELS = "camera-pixels";
const MAX_AGE_S = 0.75;
const HORIZON_S = 6;
const HOLD_S = 0.35;
const MAX_TRACKS = 24;
const MAX_HISTORY = 12;
const MAX_WALK_SPEED = 4;
const STOP_SPEED_MPS = 0.05;
const PERSON_CONFIDENCE = 0.55;
const MOTION_CONFIDENCE = 0.65;
const LABELS = ["person", "motion", "vehicle"];
const RESULT_KEYS = [
  "streamId", "frameId", "simulationTimeS", "camera", "ego", "width",
  "height", "latencyMs", "model", "detections", "observations", "status",
];
const TRACK_KEYS = [
  "id", "source", "streamId", "label", "confidence", "frameId",
  "firstSeenS", "lastSeenS", "observations", "spanS", "position",
  "velocity", "uncertaintyM", "velocityUncertaintyMps", "reliable",
  "box", "history", "holdUntilS", "holdSpeedMps", "lastConflictS",
  "conflictFrameId", "conflictCrossingTimeS", "ageMs",
  "positionCovarianceM2", "velocityCovarianceM2S2", "regressionResidualCovarianceM2",
  "stopEpisode",
];
const EPISODE_KEYS = [
  "source", "trackId", "streamId", "phase", "originFrameId", "originTimeS",
  "originConfidence", "requestedAtS", "referenceEgo", "referenceSpeedMps",
  "lowestSpeedMps", "lastProgressSpeedMps", "lastProgressAtS", "brakingObservedAtS",
  "stoppedAtS", "stopDeadlineS", "clearanceDeadlineS", "lastSupportFrameId",
  "lastSupportTimeS", "clearFrameId", "clearedAtS", "expiryReason",
];
const clamp = (n, low, high) => Math.min(high, Math.max(low, n));

function imageOverlap(a, b) {
  const width = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const height = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const intersection = width * height;
  return intersection / ((a[2] - a[0]) * (a[3] - a[1]) +
    (b[2] - b[0]) * (b[3] - b[1]) - intersection);
}

function object(value, keys, name) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
    throw new TypeError(`${name} must be a plain object`);
  for (const key of Reflect.ownKeys(value)) {
    if (!keys.includes(key))
      throw new TypeError(`${name}: unknown field ${String(key)}`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor.get || descriptor.set)
      throw new TypeError(`${name}: accessors are not observation data`);
  }
}
function number(value, min, max, name, integer = false) {
  if (!Number.isFinite(value) || value < min || value > max ||
      (integer && !Number.isSafeInteger(value)))
    throw new TypeError(`${name} is outside its finite bounds`);
}
function token(value, name, max = 80) {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new TypeError(`${name} must be a nonempty string of at most ${max} characters`);
}
function point(value, name) {
  object(value, ["x", "z"], name);
  number(value.x, -100000, 100000, `${name}.x`);
  number(value.z, -100000, 100000, `${name}.z`);
}
function odometry(ego) {
  object(ego, ["x", "z", "headingRad", "speedMps", "lengthM", "widthM"], "ego");
  point({ x: ego.x, z: ego.z }, "ego position");
  number(ego.headingRad, -100000, 100000, "ego.headingRad");
  number(ego.speedMps, -55, 55, "ego.speedMps");
  number(ego.lengthM, 1, 10, "ego.lengthM");
  number(ego.widthM, 0.5, 4, "ego.widthM");
}
function calibration(camera) {
  object(camera, ["width", "height", "fovYDeg", "position", "headingRad", "groundY"], "camera");
  number(camera.width, 160, 1920, "camera.width", true);
  number(camera.height, 90, 1080, "camera.height", true);
  number(camera.fovYDeg, 20, 140, "camera.fovYDeg");
  object(camera.position, ["x", "y", "z"], "camera.position");
  for (const key of ["x", "y", "z"])
    number(camera.position[key], -100000, 100000, `camera.position.${key}`);
  number(camera.headingRad, -100000, 100000, "camera.headingRad");
  number(camera.groundY, -100, 100, "camera.groundY");
  number(camera.position.y - camera.groundY, 0.2, 8, "camera height above ground");
}
function box(value, width, height) {
  if (!Array.isArray(value) || value.length !== 4)
    throw new TypeError("box must contain four pixel coordinates");
  value.forEach((v, i) => number(v, 0, i % 2 ? height : width, "box coordinate"));
  if (value[0] >= value[2] || value[1] >= value[3])
    throw new TypeError("box must have positive pixel area");
}
function qualityMetadata(value, depth = 0) {
  if (depth > 4) throw new TypeError("observations quality metadata is too deep");
  if (typeof value === "number") number(value, -1e9, 1e9, "observation quality");
  else if (typeof value === "string") {
    if (value.length > 256) throw new TypeError("observation quality text is too long");
  } else if (value != null && typeof value === "object") {
    const keys = Reflect.ownKeys(value);
    if (keys.length > 64) throw new TypeError("observation quality metadata is too large");
    for (const key of keys) {
      if (typeof key !== "string" ||
          /actor|world|future|scenario|case.?id|intent|ground.?truth|hit.?id|script|path|target/i.test(key))
        throw new TypeError(`observations: forbidden truth field ${String(key)}`);
      qualityMetadata(value[key], depth + 1);
    }
  } else if (value != null && typeof value !== "boolean")
    throw new TypeError("observations must contain only serializable pixel quality metadata");
}
function resultData(result) {
  object(result, RESULT_KEYS, "result");
  token(result.streamId, "streamId");
  number(result.frameId, 0, Number.MAX_SAFE_INTEGER, "frameId", true);
  number(result.simulationTimeS, 0, 1e9, "simulationTimeS");
  if (result.status !== "ready") throw new TypeError("result is not a ready pixel observation");
  calibration(result.camera);
  odometry(result.ego);
  if (result.width !== result.camera.width || result.height !== result.camera.height)
    throw new TypeError("result dimensions must match the captured camera");
  number(result.latencyMs, 0, 60000, "latencyMs");
  object(result.model, ["id", "method", "provider", "weightsSha256"], "model");
  for (const key of ["id", "method", "provider"]) token(result.model[key], `model.${key}`, 200);
  if (result.model.weightsSha256 !== null &&
      !/^[a-f0-9]{64}$/i.test(result.model.weightsSha256 ?? ""))
    throw new TypeError("model.weightsSha256 must be null or an actual SHA-256");
  if (!Array.isArray(result.detections) || result.detections.length > 128)
    throw new TypeError("detections must be a bounded array");
  for (const detection of result.detections) {
    object(detection, ["box", "label", "confidence", "trackHint"], "detection");
    box(detection.box, result.width, result.height);
    if (!LABELS.includes(detection.label)) throw new TypeError("unsupported detector label");
    number(detection.confidence, 0, 1, "detection.confidence");
    if (detection.trackHint !== undefined) token(detection.trackHint, "trackHint");
  }
  if (result.observations !== undefined) {
    if (!Array.isArray(result.observations) || result.observations.length > 64)
      throw new TypeError("observations must be a bounded pixel-quality array");
    qualityMetadata(result.observations);
  }
}

function project(detection, camera) {
  const focal = camera.height / (2 * Math.tan(camera.fovYDeg * Math.PI / 360));
  const belowHorizon = detection.box[3] - camera.height / 2;
  if (belowHorizon < 2 || detection.box[3] >= camera.height - 1) return null;
  const depth = (camera.position.y - camera.groundY) * focal / belowHorizon;
  if (depth < 0.5 || depth > 60) return null;
  const side = ((detection.box[0] + detection.box[2]) / 2 - camera.width / 2) * depth / focal;
  const sine = Math.sin(camera.headingRad), cosine = Math.cos(camera.headingRad);
  const offsetX = sine * depth - cosine * side, offsetZ = cosine * depth + sine * side;
  const duX = -cosine * depth / focal, duZ = sine * depth / focal;
  const dvX = -offsetX / belowHorizon, dvZ = -offsetZ / belowHorizon;
  const projectionCovarianceM2 = {
    xx: 0.25 * (duX * duX + dvX * dvX),
    xz: 0.25 * (duX * duZ + dvX * dvZ),
    zz: 0.25 * (duZ * duZ + dvZ * dvZ),
  };
  // A Three.js camera looking +Z with +Y up has image-right along world -X.
  return {
    x: camera.position.x + offsetX,
    z: camera.position.z + offsetZ,
    projectionCovarianceM2,
    sigmaM: Math.max(0.08, Math.sqrt(projectionCovarianceM2.xx + projectionCovarianceM2.zz)),
  };
}
function fit(history) {
  const last = history.at(-1);
  const meanT = history.reduce((sum, p) => sum + p.timeS - last.timeS, 0) / history.length;
  const meanX = history.reduce((sum, p) => sum + p.x, 0) / history.length;
  const meanZ = history.reduce((sum, p) => sum + p.z, 0) / history.length;
  let variance = 0, covX = 0, covZ = 0;
  for (const p of history) {
    const dt = p.timeS - last.timeS - meanT;
    variance += dt * dt;
    covX += dt * (p.x - meanX);
    covZ += dt * (p.z - meanZ);
  }
  const rawX = variance > 1e-8 ? covX / variance : 0;
  const rawZ = variance > 1e-8 ? covZ / variance : 0;
  const rawSpeed = Math.hypot(rawX, rawZ);
  const scale = rawSpeed > MAX_WALK_SPEED ? MAX_WALK_SPEED / rawSpeed : 1;
  const x = meanX - rawX * meanT, z = meanZ - rawZ * meanT;
  let residualXX = 0, residualXZ = 0, residualZZ = 0;
  for (const p of history) {
    const dx = p.x - x - rawX * (p.timeS - last.timeS);
    const dz = p.z - z - rawZ * (p.timeS - last.timeS);
    residualXX += dx * dx;
    residualXZ += dx * dz;
    residualZZ += dz * dz;
  }
  const residual = Math.sqrt((residualXX + residualZZ) / history.length);
  const degrees = Math.max(1, history.length - 2);
  const regressionResidualCovarianceM2 = {
    xx: residualXX / degrees, xz: residualXZ / degrees, zz: residualZZ / degrees,
  };
  const velocityFactor = variance > 1e-8 ? 1 / variance : 0;
  const positionFactor = 1 / history.length + meanT * meanT * velocityFactor;
  const positionCovarianceM2 = {}, velocityCovarianceM2S2 = {};
  // Temporal residuals already include observed pixel jitter. Projection sets
  // absolute localization uncertainty; adding it to velocity again double-counts it.
  for (const key of ["xx", "xz", "zz"]) {
    positionCovarianceM2[key] = last.projectionCovarianceM2[key] +
      positionFactor * regressionResidualCovarianceM2[key];
    velocityCovarianceM2S2[key] = velocityFactor * regressionResidualCovarianceM2[key];
  }
  const spanS = last.timeS - history[0].timeS;
  return {
    position: { x, z },
    velocity: { x: rawX * scale, z: rawZ * scale },
    spanS,
    uncertaintyM: clamp(last.sigmaM + residual * 2, 0.08, 10),
    velocityUncertaintyMps: clamp(0.05 + residual * 2 / Math.max(0.2, spanS), 0.05, 8),
    positionCovarianceM2, velocityCovarianceM2S2, regressionResidualCovarianceM2,
    reliable: rawSpeed <= MAX_WALK_SPEED && residual <= 0.8,
  };
}
function validateCovariance(value, name) {
  object(value, ["xx", "xz", "zz"], name);
  number(value.xx, 0, 1e15, `${name}.xx`);
  number(value.zz, 0, 1e15, `${name}.zz`);
  number(value.xz, -1e15, 1e15, `${name}.xz`);
  const bound = Math.sqrt(value.xx * value.zz);
  if (Math.abs(value.xz) > bound + 1e-9 * Math.max(1, bound))
    throw new TypeError(`${name} must be a positive-semidefinite covariance`);
}
function copyEpisode(value) {
  return value ? { ...value, referenceEgo: { ...value.referenceEgo } } : null;
}
function validateEpisode(value, track) {
  if (value === null) return;
  object(value, EPISODE_KEYS, "stop episode");
  if (value.source !== SOURCE || value.trackId !== track.id || value.streamId !== track.streamId)
    throw new TypeError("stop episode must retain its qualified visual track/stream identity");
  if (!["stopping", "awaiting-clearance", "cleared", "expired"].includes(value.phase))
    throw new TypeError("unknown stop episode phase");
  odometry(value.referenceEgo);
  number(value.referenceSpeedMps, 0.2, 55, "episode reference speed");
  if (value.referenceSpeedMps !== value.referenceEgo.speedMps)
    throw new TypeError("episode reference speed must be captured own odometry");
  number(value.originConfidence, track.label === "motion" ? 0.65 : 0.55, 1, "episode origin confidence");
  number(value.originFrameId, 0, track.frameId, "episode origin frame", true);
  number(value.originTimeS, 0, track.lastSeenS, "episode origin time");
  number(value.requestedAtS, value.originTimeS, 1e9, "episode request time");
  for (const key of ["lowestSpeedMps", "lastProgressSpeedMps"])
    number(value[key], 0, value.referenceSpeedMps, `episode.${key}`);
  const maximumDeadline = value.requestedAtS + HORIZON_S +
    value.referenceSpeedMps / VEHICLE.braking + MAX_AGE_S;
  number(value.clearanceDeadlineS, value.requestedAtS, maximumDeadline + 1e-8, "episode clearance deadline");
  number(value.stopDeadlineS, value.requestedAtS, value.clearanceDeadlineS, "episode stop deadline");
  number(value.lastProgressAtS, value.requestedAtS, 1e9, "episode last progress time");
  number(value.lastSupportFrameId, value.originFrameId, track.frameId, "episode support frame", true);
  number(value.lastSupportTimeS, value.originTimeS, track.lastSeenS, "episode support time");
  for (const key of ["brakingObservedAtS", "stoppedAtS", "clearedAtS"])
    if (value[key] !== null) number(value[key], value.requestedAtS, 1e9, `episode.${key}`);
  if (value.clearFrameId !== null)
    number(value.clearFrameId, value.originFrameId, track.frameId, "episode clear frame", true);
  if (value.expiryReason !== null) token(value.expiryReason, "episode expiry reason");
}
function publicTrack(track, nowS, ego, freshMotionSupport = false) {
  let history = track.history;
  if (freshMotionSupport) {
    // Keep old samples for association, not for an actionable motion fit.
    const first = history.findIndex((sample) => nowS - sample.timeS <= MAX_AGE_S + 1e-8);
    history = history.slice(first < 0 ? -1 : first);
  }
  const result = {
    id: track.id, source: PIXELS, streamId: track.streamId,
    label: track.label, confidence: track.confidence, frameId: track.frameId,
    firstSeenS: history[0].timeS, lastSeenS: track.lastSeenS,
    observations: history.length, ...fit(history),
    box: [...track.box],
    history: history.map((p) => ({
      frameId: p.frameId, simulationTimeS: p.timeS, position: { x: p.x, z: p.z },
    })),
    holdUntilS: track.holdUntilS, holdSpeedMps: track.holdSpeedMps,
    lastConflictS: track.lastConflictS, conflictFrameId: track.conflictFrameId,
    conflictCrossingTimeS: track.conflictCrossingTimeS,
    ageMs: Math.max(0, (nowS - track.lastSeenS) * 1000),
    stopEpisode: copyEpisode(track.stopEpisode),
  };
  if (freshMotionSupport && track.label !== "vehicle" && result.reliable &&
      history.length >= 3 && history.length < track.history.length &&
      (!track.stopEpisode || track.stopEpisode.phase === "cleared")) {
    // Older evidence can veto a transient box sway, but cannot start or clear a stop.
    const reference = { ...fit(track.history), history: result.history, lastSeenS: track.lastSeenS };
    const c = Math.cos(ego.headingRad), s = Math.sin(ego.headingRad);
    const lateral = ({ x, z }) => x * c - z * s;
    const error = (covariance) => Math.sqrt(Math.max(0,
      c * c * covariance.xx - 2 * c * s * covariance.xz + s * s * covariance.zz));
    const lateralMps = lateral(result.velocity), direction = Math.sign(lateralMps);
    const oldDirectionMps = direction * lateral(reference.velocity) -
      (0.05 + error(reference.velocityCovarianceM2S2));
    const observedShiftM = direction * (lateral(history.at(-1)) - lateral(history[0]));
    const resolvedShiftM = observedShiftM - 2 * error(result.positionCovarianceM2);
    // An apparent change of direction needs displacement beyond the existing person margin.
    result.reliable = (!reference.reliable || oldDirectionMps >= 0.2 || resolvedShiftM > 0.35) &&
      bodyPathAllowsLateralMotion(reference, { lateralMps, supportTimeS: result.firstSeenS }, ego);
  }
  return result;
}
function validateTrack(track) {
  object(track, TRACK_KEYS, "visual track");
  if (track.source !== PIXELS) throw new TypeError("visual tracks require camera-pixels provenance");
  token(track.id, "visual track id");
  token(track.streamId, "visual track stream");
  if (!LABELS.includes(track.label)) throw new TypeError("unsupported visual track label");
  for (const key of ["position", "velocity"]) point(track[key], `track.${key}`);
  number(track.confidence, 0, 1, "track.confidence");
  number(track.observations, 1, MAX_HISTORY, "track.observations", true);
  number(track.firstSeenS, 0, 1e9, "track.firstSeenS");
  number(track.lastSeenS, track.firstSeenS, 1e9, "track.lastSeenS");
  number(track.spanS, 0, 2, "track.spanS");
  number(track.frameId, 0, Number.MAX_SAFE_INTEGER, "track.frameId", true);
  number(track.uncertaintyM, 0, 10, "track.uncertaintyM");
  number(track.velocityUncertaintyMps, 0, 8, "track.velocityUncertaintyMps");
  for (const key of ["positionCovarianceM2", "velocityCovarianceM2S2", "regressionResidualCovarianceM2"])
    validateCovariance(track[key], key);
  validateEpisode(track.stopEpisode, track);
  number(track.holdSpeedMps, 0, 55, "track.holdSpeedMps");
  for (const key of ["holdUntilS", "lastConflictS", "conflictCrossingTimeS"])
    if (track[key] !== null) number(track[key], 0, 1e9, `track.${key}`);
  if (track.conflictFrameId !== null)
    number(track.conflictFrameId, 0, Number.MAX_SAFE_INTEGER, "track.conflictFrameId", true);
  if (typeof track.reliable !== "boolean") throw new TypeError("track reliability is missing");
  box(track.box, 1920, 1080);
  number(track.ageMs, 0, 1e12, "track.ageMs");
  if (!Array.isArray(track.history) || track.history.length !== track.observations)
    throw new TypeError("track history must match its actual observation count");
  let priorTime = -1, priorFrame = -1;
  for (const sample of track.history) {
    object(sample, ["frameId", "simulationTimeS", "position"], "track history sample");
    point(sample.position, "track history position");
    number(sample.frameId, 0, Number.MAX_SAFE_INTEGER, "history frameId", true);
    number(sample.simulationTimeS, 0, 1e9, "history simulationTimeS");
    if (sample.frameId <= priorFrame || sample.simulationTimeS <= priorTime)
      throw new TypeError("track history must contain distinct ordered observations");
    priorTime = sample.simulationTimeS;
    priorFrame = sample.frameId;
  }
  if (Math.abs(track.history[0].simulationTimeS - track.firstSeenS) > 1e-8 ||
      Math.abs(priorTime - track.lastSeenS) > 1e-8 ||
      priorFrame !== track.frameId ||
      Math.abs(track.lastSeenS - track.firstSeenS - track.spanS) > 1e-8)
    throw new TypeError("track history identity/span does not match the observed evidence");
}
function interval(position, velocity, halfExtent) {
  if (Math.abs(velocity) < 1e-8)
    return Math.abs(position) <= halfExtent ? [0, HORIZON_S] : null;
  const a = (-halfExtent - position) / velocity, b = (halfExtent - position) / velocity;
  const enter = Math.max(0, Math.min(a, b)), leave = Math.min(HORIZON_S, Math.max(a, b));
  return leave >= enter ? [enter, leave] : null;
}
function directionalSigma(matrix, x, z) {
  return Math.sqrt(Math.max(0, x * x * matrix.xx + 2 * x * z * matrix.xz + z * z * matrix.zz));
}
function occupiedInterval(position, velocity, halfExtent, positionError, velocityError) {
  let enter = 0, leave = HORIZON_S;
  // Every bounded lateral trajectory must lie in the corridor during this interval.
  for (const [offset, rate] of [
    [position, velocity + velocityError], [-position, -velocity + velocityError],
  ]) {
    const remaining = halfExtent - positionError - offset;
    if (Math.abs(rate) < 1e-8) {
      if (remaining < 0) return null;
    } else if (rate > 0) leave = Math.min(leave, remaining / rate);
    else enter = Math.max(enter, remaining / rate);
  }
  return leave >= enter ? [enter, leave] : null;
}
function forecast(track, nowS, ego) {
  const ageS = nowS - track.lastSeenS;
  const c = Math.cos(ego.headingRad), s = Math.sin(ego.headingRad);
  const dx = track.position.x + track.velocity.x * Math.max(0, ageS) - ego.x;
  const dz = track.position.z + track.velocity.z * Math.max(0, ageS) - ego.z;
  const lateralM = dx * c - dz * s, longitudinalM = dx * s + dz * c;
  const lateralSpeedMps = track.velocity.x * c - track.velocity.z * s;
  const forwardSpeedMps = track.velocity.x * s + track.velocity.z * c;
  const lateralVelocityUncertaintyMps = 0.05 + directionalSigma(track.velocityCovarianceM2S2, c, -s);
  const longitudinalVelocityUncertaintyMps = 0.05 + directionalSigma(track.velocityCovarianceM2S2, s, c);
  const lateralPositionUncertaintyM = Math.max(0.08,
    directionalSigma(track.positionCovarianceM2, c, -s)) +
    Math.max(0, ageS) * lateralVelocityUncertaintyMps;
  const longitudinalPositionUncertaintyM = Math.max(0.08,
    directionalSigma(track.positionCovarianceM2, s, c)) +
    Math.max(0, ageS) * longitudinalVelocityUncertaintyMps;
  const confidence = track.confidence *
    clamp(1 - lateralVelocityUncertaintyMps / 0.9, 0.35, 1) *
    clamp(1 - lateralPositionUncertaintyM / 8, 0.35, 1);
  const held = track.lastConflictS !== null && track.holdUntilS !== null &&
    nowS >= track.lastConflictS && nowS <= track.holdUntilS + 1e-8 &&
    track.holdUntilS - track.lastConflictS <= HOLD_S + 1e-8;
  const laneHalf = ego.widthM / 2 + 0.35;
  const band = laneHalf + Math.min(lateralPositionUncertaintyM, 0.65);
  const prediction = {
    trackId: track.id, label: track.label, confidence,
    lateralM, longitudinalM, lateralSpeedMps, forwardSpeedMps,
    lateralPositionUncertaintyM, longitudinalPositionUncertaintyM,
    lateralVelocityUncertaintyMps, longitudinalVelocityUncertaintyMps,
    lateralOccupancyS: null, longitudinalArrivalS: null, arrivalQualified: false,
    uncertaintyM: track.uncertaintyM, crossingTimeS: null,
    clearanceTimeS: null, egoArrivalTimeS: null, conflictTimeS: null,
    conflict: false, qualified: false, held, reason: "insufficient-history",
  };
  const reject = (reason) => ({ ...prediction, reason });
  if (ageS < -1e-8) return reject("future-observation");
  if (ageS > MAX_AGE_S + 1e-8) return reject("stale-observation");
  if (track.label === "vehicle") return reject("not-a-crossing-class");
  if (track.observations < 3 || track.spanS + 1e-8 < 0.2) return prediction;
  if (!track.reliable || Math.hypot(track.velocity.x, track.velocity.z) > MAX_WALK_SPEED ||
      track.uncertaintyM > 2.5 || lateralVelocityUncertaintyMps > 0.65)
    return reject("uncertain-visual-track");
  if (confidence < (track.label === "motion" ? MOTION_CONFIDENCE : PERSON_CONFIDENCE))
    return reject("low-visual-confidence");
  prediction.qualified = true;
  if (Math.abs(lateralSpeedMps) - lateralVelocityUncertaintyMps < 0.2)
    return reject("no-confident-lateral-motion");
  if (!(lateralM * lateralSpeedMps < 0 || (held && Math.abs(lateralM) <= band)))
    return reject("moving-away-from-lane");
  if (longitudinalM < -ego.lengthM / 2 - 0.35) return reject("behind-ego");
  const possibleLateral = interval(lateralM, lateralSpeedMps, band);
  if (!possibleLateral) return reject("outside-forecast-horizon");
  const lateral = occupiedInterval(lateralM, lateralSpeedMps, laneHalf,
    lateralPositionUncertaintyM, lateralVelocityUncertaintyMps);
  if (!lateral) return { ...reject("uncertain-lane-occupancy"), qualified: false };
  prediction.lateralOccupancyS = lateral;
  prediction.crossingTimeS = clamp((Math.abs(lateralM) - laneHalf) /
    Math.abs(lateralSpeedMps), 0, HORIZON_S);
  prediction.clearanceTimeS = lateral[1];
  const speed = Math.max(0, ego.speedMps, held ? track.holdSpeedMps : 0);
  if (speed < 0.2) return reject("ego-not-approaching");
  prediction.egoArrivalTimeS = clamp(longitudinalM / speed, 0, HORIZON_S);
  const closing = speed - forwardSpeedMps;
  const closingLow = closing - longitudinalVelocityUncertaintyMps;
  const closingHigh = closing + longitudinalVelocityUncertaintyMps;
  if (closingHigh <= 0.2) return reject("no-temporal-lane-conflict");
  if (closingLow <= 0.2)
    return { ...reject("uncertain-longitudinal-arrival"), qualified: false };
  const halfLength = ego.lengthM / 2 + 0.35;
  const near = longitudinalM - longitudinalPositionUncertaintyM;
  const far = longitudinalM + longitudinalPositionUncertaintyM;
  const earliestEntry = Math.max(0, (near - halfLength) / closingHigh);
  const latestEntry = Math.max(0, (far - halfLength) / closingLow);
  const earliestExit = Math.max(0, (near + halfLength) / closingHigh);
  const latestExit = Math.max(0, (far + halfLength) / closingLow);
  const withinHorizon = (time) => time <= HORIZON_S ? time : null;
  prediction.longitudinalArrivalS = {
    earliestEntryS: withinHorizon(earliestEntry), latestEntryS: withinHorizon(latestEntry),
    earliestExitS: withinHorizon(earliestExit), latestExitS: withinHorizon(latestExit),
  };
  if (earliestEntry > lateral[1] + 0.25 || latestExit < lateral[0] - 0.25)
    return reject("no-temporal-lane-conflict");
  // Overlap must survive every bounded longitudinal position/speed, not just
  // a nominal arrival or any one convenient corner of its uncertainty range.
  if (latestEntry > HORIZON_S || latestEntry > lateral[1] + 0.25 ||
      earliestExit < lateral[0] - 0.25 || earliestExit <= 0)
    return { ...reject("uncertain-longitudinal-arrival"), qualified: false };
  prediction.arrivalQualified = true;
  prediction.conflict = true;
  prediction.conflictTimeS = Math.max(lateral[0], latestEntry);
  prediction.reason = track.label === "person"
    ? "observed-person-crossing-conflict" : "observed-motion-crossing-conflict";
  return prediction;
}
function decision(reason, available = false, track = null, nowS = 0) {
  return {
    source: SOURCE, available, brake: false, targetSpeedMps: null,
    reason, trackId: null, confidence: 0, crossingTimeS: null,
    ageMs: track ? Math.max(0, (nowS - track.lastSeenS) * 1000) : null,
    evidenceFrameId: track?.frameId ?? null,
  };
}
function beginStopEpisode(track, prediction, nowS, ego) {
  const referenceSpeedMps = ego.speedMps;
  const stoppingS = referenceSpeedMps / VEHICLE.braking;
  const clearanceS = Math.min(HORIZON_S,
    (Math.abs(prediction.lateralM) + ego.widthM / 2 + 0.35 +
      prediction.lateralPositionUncertaintyM) /
    Math.max(0.2, Math.abs(prediction.lateralSpeedMps) - prediction.lateralVelocityUncertaintyMps));
  return {
    source: SOURCE, trackId: track.id, streamId: track.streamId, phase: "stopping",
    originFrameId: track.frameId, originTimeS: track.lastSeenS,
    originConfidence: prediction.confidence, requestedAtS: nowS,
    referenceEgo: { ...ego }, referenceSpeedMps,
    lowestSpeedMps: referenceSpeedMps, lastProgressSpeedMps: referenceSpeedMps,
    lastProgressAtS: nowS, brakingObservedAtS: null, stoppedAtS: null,
    stopDeadlineS: nowS + stoppingS + MAX_AGE_S,
    clearanceDeadlineS: nowS + clearanceS + stoppingS + MAX_AGE_S,
    lastSupportFrameId: track.frameId, lastSupportTimeS: track.lastSeenS,
    clearFrameId: null, clearedAtS: null, expiryReason: null,
  };
}
function observedClearance(track, episode, nowS, ego) {
  if (nowS - track.lastSeenS > MAX_AGE_S || nowS < track.lastSeenS ||
      track.history.length < 3 || !track.reliable || track.uncertaintyM > 2.5)
    return false;
  const reference = { ...episode.referenceEgo, speedMps: ego.speedMps };
  const visible = forecast(track, nowS, reference);
  if (visible.confidence < (track.label === "motion" ? MOTION_CONFIDENCE : PERSON_CONFIDENCE) ||
      visible.lateralVelocityUncertaintyMps > 0.65)
    return false;
  const recent = track.history.slice(-3);
  if (recent[2].simulationTimeS - recent[0].simulationTimeS + 1e-8 < 0.2) return false;
  const side = Math.sign(visible.lateralM), half = reference.widthM / 2 + 0.35;
  const c = Math.cos(reference.headingRad), s = Math.sin(reference.headingRad);
  if (!side || recent.some(({ position }) => side *
      ((position.x - reference.x) * c - (position.z - reference.z) * s) -
      visible.lateralPositionUncertaintyM <= half))
    return false;
  const away = side * visible.lateralSpeedMps - visible.lateralVelocityUncertaintyMps >= 0.2;
  const stationaryClear = Math.abs(visible.lateralSpeedMps) + visible.lateralVelocityUncertaintyMps <= 0.2;
  return away || stationaryClear;
}
function advanceStopEpisode(track, nowS, ego, usable = true, allowLateClearance = false) {
  const episode = copyEpisode(track.stopEpisode);
  if (!episode || episode.phase === "cleared") return episode;
  const speed = Math.abs(ego.speedMps);
  if (episode.phase === "expired") {
    // Expiry ends the old authorization, not the ability to see new clearance.
    const oldestClearanceS = track.history.at(-3)?.simulationTimeS;
    if (allowLateClearance && usable && episode.stoppedAtS !== null && speed < STOP_SPEED_MPS &&
        track.frameId > episode.lastSupportFrameId && track.lastSeenS > episode.lastSupportTimeS &&
        nowS - oldestClearanceS <= MAX_AGE_S + 1e-8 && observedClearance(track, episode, nowS, ego)) {
      episode.phase = "cleared";
      episode.clearFrameId = track.frameId;
      episode.clearedAtS = nowS;
    }
    return episode;
  }
  episode.lowestSpeedMps = Math.min(episode.lowestSpeedMps, speed);
  if (episode.lastProgressSpeedMps - episode.lowestSpeedMps >= STOP_SPEED_MPS) {
    episode.lastProgressAtS = nowS;
    episode.lastProgressSpeedMps = episode.lowestSpeedMps;
    episode.brakingObservedAtS ??= nowS;
  }
  if (episode.brakingObservedAtS !== null && nowS > episode.requestedAtS) {
    const observedDeceleration = (episode.referenceSpeedMps - episode.lowestSpeedMps) /
      (nowS - episode.requestedAtS);
    if (observedDeceleration > 0) episode.stopDeadlineS = Math.min(episode.clearanceDeadlineS,
      episode.requestedAtS + episode.referenceSpeedMps /
        Math.min(VEHICLE.braking, observedDeceleration) + MAX_AGE_S);
  }
  if (speed < STOP_SPEED_MPS) {
    episode.stoppedAtS ??= nowS;
    episode.phase = "awaiting-clearance";
  }
  const stopped = episode.stoppedAtS !== null;
  const noProgress = !stopped && nowS - episode.lastProgressAtS > MAX_AGE_S;
  if (nowS > episode.clearanceDeadlineS || (!stopped && nowS > episode.stopDeadlineS) || noProgress) {
    episode.phase = "expired";
    episode.expiryReason = noProgress ? "visual-stop-no-braking-progress" : "visual-stop-episode-expired";
    return episode;
  }
  const fresh = usable && nowS >= track.lastSeenS && nowS - track.lastSeenS <= MAX_AGE_S;
  if (fresh) {
    episode.lastSupportFrameId = track.frameId;
    episode.lastSupportTimeS = track.lastSeenS;
    if (stopped && observedClearance(track, episode, nowS, ego)) {
      episode.phase = "cleared";
      episode.clearFrameId = track.frameId;
      episode.clearedAtS = nowS;
    }
  }
  return episode;
}
function stopEpisodeDecision(track, prediction, nowS, ego) {
  if (!track.stopEpisode) return null;
  const episode = advanceStopEpisode(track, nowS, ego);
  if (nowS < track.lastSeenS || nowS - track.lastSeenS > MAX_AGE_S)
    return decision("stale-stop-observation", false, track, nowS);
  if (episode.phase === "expired")
    return decision(episode.expiryReason, false, track, nowS);
  if (episode.phase === "cleared") {
    if (episode.clearFrameId === track.frameId && observedClearance(track, episode, nowS, ego))
      return decision("visual-clearance-confirmed", true, track, nowS);
    return null;
  }
  // This is completion of an earlier qualified action, not a reclassification
  // of today's uncertain observation as a new confident crossing forecast.
  return {
    ...decision(prediction.conflict ? prediction.reason : episode.stoppedAtS === null
      ? "committed-visual-stop" : "awaiting-visual-clearance", true, track, nowS),
    brake: true, targetSpeedMps: 0, trackId: track.id, confidence: prediction.confidence,
    crossingTimeS: prediction.conflict ? prediction.crossingTimeS : null,
  };
}

/** Pure decision over this module's observed, source-qualified track snapshots. */
export function decideVisualBrake(input = {}) {
  object(input, ["tracks", "nowS", "ego", "enabled"], "visual decision");
  const { tracks = [], nowS, ego, enabled = true } = input;
  number(nowS, 0, 1e9, "nowS");
  odometry(ego);
  if (typeof enabled !== "boolean") throw new TypeError("enabled must be boolean");
  if (!Array.isArray(tracks) || tracks.length > MAX_TRACKS)
    throw new TypeError("visual tracks must be bounded");
  tracks.forEach(validateTrack);
  if (!enabled) return decision("disabled");
  if (!tracks.length) return decision("no-visual-tracks");
  const predictions = tracks.map((track) => ({ track, value: forecast(track, nowS, ego) }));
  const episodes = predictions.map(({ track, value }) =>
    stopEpisodeDecision(track, value, nowS, ego)).filter(Boolean);
  const committed = episodes.find((value) => value.available && value.brake);
  if (committed) return committed;
  const candidates = predictions.filter(({ value }) => value.conflict)
    .sort((a, b) => a.value.conflictTimeS - b.value.conflictTimeS ||
      b.value.confidence - a.value.confidence);
  const held = predictions.find(({ track, value }) =>
    value.qualified && value.held && nowS - track.lastSeenS <= MAX_AGE_S);
  const selected = candidates[0] ?? held;
  if (selected) {
    const { track, value } = selected;
    return {
      ...decision(value.conflict ? value.reason : "release-hysteresis", true, track, nowS),
      brake: true, targetSpeedMps: 0, trackId: track.id,
      confidence: value.confidence,
      crossingTimeS: value.crossingTimeS ?? Math.max(0,
        (track.conflictCrossingTimeS ?? 0) - (nowS - track.lastConflictS)),
      evidenceFrameId: value.conflict ? track.frameId : track.conflictFrameId,
    };
  }
  if (episodes.length) return episodes[0];
  const latest = predictions.sort((a, b) => b.track.lastSeenS - a.track.lastSeenS)[0];
  return decision(latest.value.reason, latest.value.qualified, latest.track, nowS);
}

/** Only detector pixels, captured calibration/time, and own odometry enter here. */
export class VisualCrossingPredictor {
  constructor({ allowLateClearance = false, freshMotionSupport = false } = {}) {
    this.allowLateClearance = allowLateClearance;
    this.freshMotionSupport = freshMotionSupport;
    this.streamId = null;
    this.tracks = [];
    this.latest = null;
    this.error = null;
    this.nextId = 1;
    this.nowS = 0;
  }
  reset(streamId) {
    token(streamId, "streamId");
    this.streamId = streamId;
    this.tracks = [];
    this.latest = null;
    this.error = null;
    this.nextId = 1;
    this.nowS = 0;
  }
  observe(result) {
    try {
      resultData(result);
      if (!this.streamId || result.streamId !== this.streamId)
        throw new TypeError("result stream does not match the explicitly reset stream");
      if (this.latest && (result.frameId <= this.latest.frameId ||
          result.simulationTimeS <= this.latest.simulationTimeS))
        throw new TypeError("duplicate or out-of-order visual observation");
      if (this.nowS - result.simulationTimeS > MAX_AGE_S + 1e-8)
        throw new TypeError("visual result is already stale");
      if (result.latencyMs > MAX_AGE_S * 1000)
        throw new TypeError("visual inference result exceeds the stale latency bound");
      const timeS = result.simulationTimeS;
      this.tracks = this.tracks.filter((track) => timeS - track.lastSeenS <= 2);
      const projected = result.detections.map((detection) => ({
        detection, projected: project(detection, result.camera),
      })).filter((item) => item.projected);
      // Weak boxes remain raw/projected evidence, but cannot take part in actionable association.
      const observed = projected.filter(({ detection }) => detection.label === "vehicle" ||
        detection.confidence >= (detection.label === "motion" ? MOTION_CONFIDENCE : PERSON_CONFIDENCE));
      const pairs = [], imagePairs = [];
      observed.forEach((item, index) => {
        this.tracks.forEach((track) => {
          const age = timeS - track.lastSeenS;
          if (age > MAX_AGE_S || track.label !== item.detection.label) return;
          const estimate = fit(track.history);
          const distance = Math.hypot(
            item.projected.x - estimate.position.x - estimate.velocity.x * age,
            item.projected.z - estimate.position.z - estimate.velocity.z * age,
          );
          const gate = Math.min(3, 0.55 + MAX_WALK_SPEED * age +
            Math.min(estimate.uncertaintyM + item.projected.sigmaM, 1.5));
          if (distance <= gate) pairs.push({ index, track, distance });
          if (this.freshMotionSupport && track.label !== "vehicle" && !track.stopEpisode &&
              track.frameId === this.latest?.frameId && age <= 0.25 + 1e-8 &&
              imageOverlap(track.box, item.detection.box) >= 0.5) {
            const yaw = result.camera.headingRad;
            const dx = item.projected.x - estimate.position.x - estimate.velocity.x * age;
            const dz = item.projected.z - estimate.position.z - estimate.velocity.z * age;
            if (Math.abs(dx * Math.cos(yaw) - dz * Math.sin(yaw)) <= gate)
              imagePairs.push({ index, track });
          }
        });
      });
      pairs.sort((a, b) => a.distance - b.distance || a.index - b.index);
      const assignments = new Map(), used = new Set();
      for (const pair of pairs) {
        if (assignments.has(pair.index) || used.has(pair.track)) continue;
        assignments.set(pair.index, pair.track);
        used.add(pair.track);
      }
      for (const { index, track } of imagePairs) {
        if (assignments.has(index) || used.has(track) ||
            imagePairs.some((pair) => (pair.index === index) !== (pair.track === track))) continue;
        // A partly hidden footpoint can jump in depth. Keep the unambiguous
        // image identity, not the motion fit across that jump.
        track.history = [];
        assignments.set(index, track);
        used.add(track);
      }
      observed.forEach(({ detection, projected }, index) => {
        let track = assignments.get(index);
        if (!track) {
          if (this.tracks.length >= MAX_TRACKS) return;
          track = {
            id: `visual-${this.nextId++}`, streamId: this.streamId,
            label: detection.label, history: [], holdUntilS: null,
            holdSpeedMps: 0, lastConflictS: null, conflictFrameId: null,
            conflictCrossingTimeS: null,
            stopEpisode: null,
          };
          this.tracks.push(track);
        }
        track.history.push({ ...projected, timeS, frameId: result.frameId });
        track.history = track.history.filter((sample) => timeS - sample.timeS <= 1.5)
          .slice(-MAX_HISTORY);
        track.lastSeenS = timeS;
        track.frameId = result.frameId;
        track.box = [...detection.box];
        track.confidence = detection.confidence;
      });
      this.latest = {
        streamId: this.streamId, frameId: result.frameId, simulationTimeS: timeS,
        latencyMs: result.latencyMs, model: { ...result.model },
        detections: result.detections.length, projectedDetections: projected.length,
        unprojectableDetections: result.detections.length - projected.length,
      };
      this.error = null;
      return { accepted: true, streamId: this.streamId, frameId: result.frameId,
        projectedDetections: projected.length };
    } catch (failure) {
      this.error = failure.message;
      throw failure;
    }
  }
  snapshot(nowS, ego) {
    number(nowS, 0, 1e9, "nowS");
    odometry(ego);
    this.nowS = Math.max(this.nowS, nowS);
    const ageMs = this.latest ? (nowS - this.latest.simulationTimeS) * 1000 : null;
    const status = this.error ? "error" : !this.latest ? "unavailable"
      : ageMs < -1e-5 ? "error" : ageMs > MAX_AGE_S * 1000 + 1e-5 ? "stale" : "ready";
    const snapshotTracks = () => this.tracks.map((track) => publicTrack(track, nowS, ego, this.freshMotionSupport));
    let tracks = snapshotTracks();
    const available = status === "ready";
    for (const track of tracks) {
      if (!track.stopEpisode) continue;
      const internal = this.tracks.find((item) => item.id === track.id);
      internal.stopEpisode = advanceStopEpisode(track, nowS, ego, available, this.allowLateClearance);
    }
    tracks = snapshotTracks();
    let result = available ? decideVisualBrake({ tracks, nowS, ego, enabled: true })
      : decision(this.error ? "invalid-visual-result" : status === "stale"
        ? "stale-visual-result" : status === "error" ? "future-visual-result" : "no-visual-evidence");
    if (!available) {
      result.ageMs = ageMs === null ? null : Math.max(0, ageMs);
      result.evidenceFrameId = this.latest?.frameId ?? null;
    }
    if (result.brake && ["observed-person-crossing-conflict", "observed-motion-crossing-conflict"]
      .includes(result.reason)) {
      const track = this.tracks.find((item) => item.id === result.trackId);
      const observed = tracks.find((item) => item.id === result.trackId);
      if (ego.speedMps >= 0.2 && (!track.stopEpisode || track.stopEpisode.phase === "cleared"))
        track.stopEpisode = beginStopEpisode(observed, forecast(observed, nowS, ego), nowS, ego);
      if (track.conflictFrameId !== track.frameId) {
        const heldSpeed = track.holdUntilS !== null && nowS <= track.holdUntilS
          ? track.holdSpeedMps : 0;
        track.lastConflictS = track.lastSeenS;
        track.holdUntilS = track.lastSeenS + HOLD_S;
        track.holdSpeedMps = Math.max(heldSpeed, 0, ego.speedMps);
        track.conflictFrameId = track.frameId;
        track.conflictCrossingTimeS = result.crossingTimeS;
        tracks = snapshotTracks();
      }
    }
    return {
      source: SOURCE, streamId: this.streamId, status, available,
      availability: { status, available, error: this.error },
      frameId: this.latest?.frameId ?? null, ageMs: ageMs === null ? null : Math.max(0, ageMs),
      model: this.latest ? { ...this.latest.model } : null,
      latencyMs: this.latest?.latencyMs ?? null,
      detections: this.latest?.detections ?? 0,
      projectedDetections: this.latest?.projectedDetections ?? 0,
      unprojectableDetections: this.latest?.unprojectableDetections ?? 0,
      tracks,
      forecasts: available ? tracks.map((track) => forecast(track, nowS, ego)) : [],
      decision: result,
    };
  }
}
