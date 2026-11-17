const MAX_AGE_MS = 750;
const FRAME_KEYS = ["schema", "streamId", "frameId", "simulationTimeS", "camera", "ego", "imageJpegBase64"];
const RESULT_KEYS = [
  "streamId", "frameId", "simulationTimeS", "camera", "ego", "width", "height",
  "latencyMs", "model", "detections", "observations", "status",
];
const VISUAL_KEYS = [
  "source", "streamId", "status", "available", "availability", "frameId", "ageMs",
  "model", "latencyMs", "detections", "projectedDetections", "unprojectableDetections",
  "tracks", "forecasts", "decision",
];
const TRACK_KEYS = [
  "id", "source", "streamId", "label", "confidence", "frameId", "firstSeenS", "lastSeenS",
  "observations", "spanS", "position", "velocity", "uncertaintyM", "velocityUncertaintyMps",
  "reliable", "box", "history", "holdUntilS", "holdSpeedMps", "lastConflictS", "conflictFrameId",
  "conflictCrossingTimeS", "ageMs", "positionCovarianceM2", "velocityCovarianceM2S2",
  "regressionResidualCovarianceM2", "stopEpisode",
];
const finite = Number.isFinite;
const token = (value) => typeof value === "string" && value.trim().length > 0 && value.length <= 200;
const point = (value) => value && finite(value.x) && finite(value.z);
const plainKeys = (value, keys) => value && typeof value === "object" && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
  Reflect.ownKeys(value).every((key) => keys.includes(key) &&
    !Object.getOwnPropertyDescriptor(value, key).get && !Object.getOwnPropertyDescriptor(value, key).set);
const equal = (a, b) => finite(a) && finite(b) && Math.abs(a - b) <= 1e-8;

function cameraValid(camera) {
  return plainKeys(camera, ["width", "height", "fovYDeg", "position", "headingRad", "groundY"]) &&
    Number.isSafeInteger(camera.width) && camera.width >= 160 && camera.width <= 1920 &&
    Number.isSafeInteger(camera.height) && camera.height >= 90 && camera.height <= 1080 &&
    finite(camera.fovYDeg) && camera.fovYDeg >= 20 && camera.fovYDeg <= 140 &&
    plainKeys(camera.position, ["x", "y", "z"]) && point(camera.position) &&
    finite(camera.position.y) && finite(camera.headingRad) && finite(camera.groundY) &&
    camera.position.y - camera.groundY >= 0.2 && camera.position.y - camera.groundY <= 8;
}

export function cameraFrameKey(frame) {
  return token(frame?.streamId) && Number.isSafeInteger(frame?.frameId) && frame.frameId >= 0
    ? `${frame.streamId.length}:${frame.streamId}:${frame.frameId}` : null;
}

function frameValid(frame) {
  return plainKeys(frame, FRAME_KEYS) && frame.schema === 1 && cameraFrameKey(frame) !== null &&
    finite(frame.simulationTimeS) && frame.simulationTimeS >= 0 && cameraValid(frame.camera) &&
    typeof frame.imageJpegBase64 === "string" && frame.imageJpegBase64.startsWith("/9j/") &&
    frame.imageJpegBase64.length <= 8 * 1024 * 1024;
}

function sameCamera(a, b) {
  return cameraValid(a) && cameraValid(b) &&
    ["width", "height", "fovYDeg", "headingRad", "groundY"].every((key) => equal(a[key], b[key])) &&
    ["x", "y", "z"].every((key) => equal(a.position[key], b.position[key]));
}

function sameEgo(a, b) {
  const keys = ["x", "z", "headingRad", "speedMps", "lengthM", "widthM"];
  return plainKeys(a, keys) && plainKeys(b, keys) && keys.every((key) => equal(a[key], b[key]));
}

function modelValid(model) {
  return plainKeys(model, ["id", "method", "provider", "weightsSha256"]) &&
    ["id", "method", "provider"].every((key) => token(model[key])) &&
    (model.weightsSha256 === null || /^[a-f0-9]{64}$/i.test(model.weightsSha256 ?? ""));
}

function detectionValid(detection, width, height) {
  return plainKeys(detection, ["box", "label", "confidence", "trackHint"]) &&
    ["person", "vehicle", "motion"].includes(detection.label) &&
    finite(detection.confidence) && detection.confidence >= 0 && detection.confidence <= 1 &&
    Array.isArray(detection.box) && detection.box.length === 4 &&
    detection.box.every((value, i) => finite(value) && value >= 0 && value <= (i % 2 ? height : width)) &&
    detection.box[0] < detection.box[2] && detection.box[1] < detection.box[3];
}

function resultValid(result) {
  return plainKeys(result, RESULT_KEYS) && result.status === "ready" && cameraFrameKey(result) !== null &&
    finite(result.simulationTimeS) && cameraValid(result.camera) && modelValid(result.model) &&
    result.width === result.camera.width && result.height === result.camera.height &&
    finite(result.latencyMs) && result.latencyMs >= 0 && result.latencyMs <= 60000 &&
    Array.isArray(result.detections) && result.detections.length <= 128 &&
    result.detections.every((detection) => detectionValid(detection, result.width, result.height));
}

// This boundary deliberately has no World/actor/target or supplied future-path input.
export function pairCameraEvidence({ frame = null, result = null, visual = null, availability = {}, enabled = false } = {}) {
  const rawAvailable = Boolean(frameValid(frame));
  const pair = {
    key: rawAvailable ? cameraFrameKey(frame) : null,
    frame: rawAvailable ? frame : null, result: null, visual: null,
    rawAvailable, canAnalyze: false, motionAvailable: false, ageMs: null,
    status: "unavailable", reason: "Front RGB unavailable. Open the camera again to retry.",
  };
  const reject = (status, reason) => ({ ...pair, status, reason });
  const status = typeof availability === "string" ? availability : availability?.status;
  if (status === "error" || availability?.error)
    return reject("error", `Camera evidence unavailable: ${availability?.error || "detector failed"}. Stop, then Retry detector.`);
  if (status === "loading" || status === "starting")
    return reject("starting", "Starting the installed detector · raw RGB is not yet analysed.");
  if (status === "unavailable")
    return reject("unavailable", "Local detector unavailable · Retry detector, or continue driving without it.");
  if (!enabled)
    return reject("off", rawAvailable
      ? "Detector off · raw front RGB is unanalysed. Start the installed detector explicitly."
      : "Detector off · waiting for raw front RGB. No model is started by opening this screen.");
  if (availability?.source && availability.source !== "camera-pixels")
    return reject("mismatch", "Camera source mismatch · no neural overlay is shown.");
  if (status === "stale")
    return reject("stale", "Camera evidence is stale · boxes and motion estimates are withheld.");
  if (status === "disabled")
    return reject("off", "Detector stopped · raw RGB is unanalysed.");
  if (status !== "ready" || availability?.available === false)
    return reject("unavailable", "Local detector unavailable · Retry detector, or continue driving without it.");
  if (!rawAvailable)
    return reject("unavailable", "The exact analysed JPEG is unavailable · no overlay is shown.");
  if (!result)
    return reject("waiting", "Raw front RGB · waiting for an analysed frame. No overlay is shown.");
  if (!resultValid(result))
    return reject("error", "Invalid pixel-detector result · no overlay is shown. Stop, then Retry detector.");
  if (cameraFrameKey(result) !== pair.key || !equal(result.simulationTimeS, frame.simulationTimeS) ||
      !sameCamera(frame.camera, result.camera) || !sameEgo(frame.ego, result.ego))
    return reject("mismatch", "Frame / stream / calibration mismatch · raw preview only; no overlay is shown.");
  pair.result = result;
  if (visual) {
    if (!plainKeys(visual, VISUAL_KEYS) || visual.source !== "visual-prediction" ||
        visual.streamId !== result.streamId || visual.frameId !== result.frameId)
      return reject("mismatch", "Motion evidence does not match this camera frame · no overlay is shown.");
    if (!finite(visual.ageMs) || visual.ageMs < 0 || visual.ageMs > MAX_AGE_MS ||
        visual.status === "stale")
      return reject("stale", "Camera evidence is stale or its age is unknown · no overlay is shown.");
    if (visual.status !== "ready" || visual.available !== true || visual.availability?.error)
      return reject("unavailable", "Motion observations are unavailable · no overlay is shown.");
    if (!modelValid(visual.model) ||
        ["id", "method", "provider", "weightsSha256"].some((key) => visual.model[key] !== result.model[key]))
      return reject("mismatch", "Model evidence mismatch · no overlay is shown.");
    pair.visual = visual;
    pair.ageMs = visual.ageMs;
    pair.motionAvailable = true;
  }
  return {
    ...pair, canAnalyze: true, status: "matched",
    reason: visual ? "Exact front-camera frame · detector boxes and image-derived motion."
      : "Exact front-camera frame · detector boxes; fitted motion unavailable.",
  };
}

export function projectCameraPoint(position, camera) {
  if (!point(position) || !cameraValid(camera)) return null;
  const dx = position.x - camera.position.x, dz = position.z - camera.position.z;
  const sine = Math.sin(camera.headingRad), cosine = Math.cos(camera.headingRad);
  const depth = dx * sine + dz * cosine;
  if (depth <= 0.05) return null;
  const side = -dx * cosine + dz * sine;
  const focal = camera.height / (2 * Math.tan(camera.fovYDeg * Math.PI / 360));
  const x = camera.width / 2 + side * focal / depth;
  const y = camera.height / 2 + (camera.position.y - camera.groundY) * focal / depth;
  return finite(x) && finite(y) ? [x, y] : null;
}

export function projectPixelTrack(track, pair, { horizonS = 3 } = {}) {
  const result = pair?.result, camera = pair?.frame?.camera;
  if (!pair?.canAnalyze || !pair.motionAvailable || !result || !camera ||
      !plainKeys(track, TRACK_KEYS) || track.source !== "camera-pixels" || track.streamId !== result.streamId ||
      !token(track.id) || !["person", "vehicle", "motion"].includes(track.label) ||
      track.frameId !== result.frameId || !equal(track.lastSeenS, result.simulationTimeS) ||
      !finite(track.ageMs) || track.ageMs < 0 || track.ageMs > MAX_AGE_MS ||
      !Array.isArray(track.history) || !track.history.length || track.history.length > 12 ||
      track.history.length !== track.observations ||
      !plainKeys(track.position, ["x", "z"]) || !point(track.position) ||
      !plainKeys(track.velocity, ["x", "z"]) || !point(track.velocity) ||
      !finite(horizonS) || horizonS <= 0) return null;
  let time = -Infinity, frameId = -1;
  for (const sample of track.history) {
    if (!plainKeys(sample, ["frameId", "simulationTimeS", "position"]) ||
        !plainKeys(sample.position, ["x", "z"]) || !point(sample.position) ||
        !Number.isSafeInteger(sample.frameId) || sample.frameId <= frameId ||
        sample.frameId > result.frameId || !finite(sample.simulationTimeS) ||
        sample.simulationTimeS <= time || sample.simulationTimeS > result.simulationTimeS) return null;
    time = sample.simulationTimeS;
    frameId = sample.frameId;
  }
  if (frameId !== result.frameId || !equal(time, result.simulationTimeS)) return null;
  const observed = track.history.map((sample) => projectCameraPoint(sample.position, camera));
  const forecast = pair.visual.forecasts?.find((item) => item.trackId === track.id);
  const uncertain = forecast && /uncertain|insufficient|low-visual|future|stale/.test(forecast.reason);
  const fitted = track.reliable === true && track.observations >= 3 && track.spanS >= 0.2 - 1e-8 &&
    finite(track.uncertaintyM) && track.uncertaintyM <= 2.5 &&
    finite(track.velocityUncertaintyMps) && track.velocityUncertaintyMps >= 0 &&
    track.velocityUncertaintyMps <= 0.65 && Math.hypot(track.velocity.x, track.velocity.z) <= 4 && !uncertain;
  const duration = fitted ? Math.min(3, horizonS) : 0;
  const predicted = [];
  if (duration && Math.hypot(track.velocity.x, track.velocity.z) >= 0.05) {
    const steps = Math.ceil(duration / 0.25);
    for (let i = 0; i <= steps; i++) {
      const t = duration * i / steps;
      predicted.push(projectCameraPoint({
        x: track.position.x + track.velocity.x * t,
        z: track.position.z + track.velocity.z * t,
      }, camera));
    }
  }
  return {
    id: track.id, label: track.label, observed, predicted, horizonS: predicted.length ? duration : 0,
    speedMps: Math.hypot(track.velocity.x, track.velocity.z),
    uncertaintyM: track.uncertaintyM, velocityUncertaintyMps: track.velocityUncertaintyMps,
    reason: predicted.length ? "constant-velocity estimate" : uncertain || !fitted
      ? "Forecast unavailable · insufficient or uncertain motion" : "No fitted displacement",
  };
}
