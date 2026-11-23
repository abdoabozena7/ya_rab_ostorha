import { pairCameraEvidence, projectPixelTrack } from "./camera-evidence.js";
import { forecastPursuitSurface, PURSUIT_SCAN_TICKS } from "../signal_processing/pursuit-scanner.js";

const hues = { static: "#657870", civilian: "#b2d0c6", police: "#ff8f86", pedestrian: "#ffca83" };
const labels = { matched: "Camera recognition live", off: "Detector off", waiting: "Waiting for recognition",
  stale: "Camera result expired", starting: "Starting detector", mismatch: "Image does not match result",
  unavailable: "Detector unavailable", error: "Detector error" };
const text = (node, value) => { if (node.textContent !== value) node.textContent = value; };
const freshScan = (scan, tick) => scan && tick >= scan.tick && tick - scan.tick < PURSUIT_SCAN_TICKS;

export function pedestrianForecasts({ scan, tick, pair }) {
  const camera = (pair?.visual?.tracks ?? []).flatMap(track => {
    if (track.label !== "person") return [];
    const fitted = projectPixelTrack(track, pair);
    if (!fitted?.predicted.length) return [];
    const { x, z } = track.position, { x: vx, z: vz } = track.velocity;
    return [{ id: `camera:${track.id}`, source: "camera", heading: Math.atan2(vx, vz),
      points: [0, .5, 1, 2].map(secondsAhead => ({ x: x + vx * secondsAhead, z: z + vz * secondsAhead, secondsAhead })) }];
  });
  const sensor = !freshScan(scan, tick) ? [] : scan.tracks.flatMap(track => {
    if (track.kind !== "pedestrian" || track.ageS !== 0 || !track.motionKnown) return [];
    const { observedXM: x, observedZM: z, estimatedXMps: vx, estimatedZMps: vz } = track;
    const speed = Math.hypot(vx, vz);
    if (!(speed >= .25 && speed <= 4) || camera.some(({ points: [at] }) => Math.hypot(at.x - x, at.z - z) < 1.05)) return [];
    const points = forecastPursuitSurface(track).points
      .filter(({ secondsAhead, allowanceM }) => [.5, 1, 2].includes(secondsAhead) && allowanceM < 2.2)
      .map(({ xM, zM, secondsAhead }) => ({ x: xM, z: zM, secondsAhead }));
    return points.length ? [{ id: `range:${track.trackId}`, source: "sensor", heading: Math.atan2(vx, vz),
      points: [{ x, z, secondsAhead: 0 }, ...points] }] : [];
  });
  return [...camera, ...sensor].slice(0, 6);
}

function drawRange(ctx, scan) {
  const { width, height } = ctx.canvas, size = Math.min(width, height), center = width / 2, y = height / 2;
  const radius = size * .451, scale = radius / 48;
  ctx.fillStyle = "#14251f";
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = "#3e584f";
  ctx.lineWidth = 1;
  for (const m of [12, 24, 36, 48]) {
    ctx.beginPath();
    ctx.arc(center, y, m * scale, 0, Math.PI * 2);
    ctx.stroke();
  }
  if (scan) {
    ctx.fillStyle = "#304d3e";
    ctx.beginPath();
    for (const [i, ray] of scan.rays.entries()) {
      const angle = i * 2 * Math.PI / scan.rays.length, extent = ray.rangeM * scale;
      ctx[i ? "lineTo" : "moveTo"](center + Math.sin(angle) * extent, y - Math.cos(angle) * extent);
    }
    ctx.closePath();
    ctx.fill();
    for (const [i, ray] of scan.rays.entries()) {
      if (ray.kind === "none") continue;
      const angle = i * 2 * Math.PI / scan.rays.length, extent = ray.rangeM * scale;
      ctx.fillStyle = hues[ray.kind] ?? hues.static;
      ctx.beginPath();
      ctx.arc(center + Math.sin(angle) * extent, y - Math.cos(angle) * extent, ray.kind === "pedestrian" ? 3.3 : 2.4, 0, Math.PI * 2);
      ctx.fill();
    }
    // Fine pedestrian beams can resolve people between the primary range rays.
    ctx.fillStyle = hues.pedestrian;
    for (const track of scan.tracks) {
      if (track.kind !== "pedestrian" || track.ageS !== 0) continue;
      ctx.beginPath();
      ctx.arc(center + track.rightM * scale, y - track.forwardM * scale, 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.fillStyle = "#edf3e9";
  ctx.beginPath();
  ctx.moveTo(center, y - 8);
  ctx.lineTo(center + 5, y + 5);
  ctx.lineTo(center - 5, y + 5);
  ctx.closePath();
  ctx.fill();
  ctx.font = "13px system-ui";
  ctx.fillStyle = "#c1d3c8";
  ctx.fillText("48 m", 9, height - 8);
  ctx.fillText("Front", center - 16, 15);
}

export function mountCityPerception(get, { onVisibility, onDetector }) {
  const panel = get("driveSense"), toggle = get("driveSenseBtn"), detector = get("driveSenseDetector");
  const image = get("driveSenseImage"), camera = image.getContext("2d"), range = get("driveSenseMap").getContext("2d");
  const empty = get("driveSenseEmpty"), status = get("driveSenseRecognition");
  let key = null, rendered = null, generation = 0, drawingScan, busy = false;
  let report = null;
  function clearImage(message) {
    camera.clearRect(0, 0, image.width, image.height);
    image.hidden = true;
    delete image.dataset.frameId;
    delete image.dataset.streamId;
    rendered = null;
    empty.hidden = false;
    text(empty, message);
  }
  function show(value) {
    if (value === !panel.hidden) return;
    panel.hidden = !value;
    toggle.setAttribute("aria-expanded", String(value));
    if (!value) {
      generation++;
      key = drawingScan = report = null;
      clearImage("Waiting for front RGB…");
    }
    onVisibility(value);
  }
  toggle.onclick = () => show(panel.hidden);
  get("driveSenseClose").onclick = () => { show(false); toggle.focus(); };
  detector.onclick = async () => {
    busy = detector.disabled = true;
    const error = get("driveSenseError");
    error.hidden = true;
    try {
      const result = await onDetector();
      if (!result?.ok) throw new Error(result?.error || "Camera could not change state.");
    } catch (failure) {
      text(error, failure.message);
      error.hidden = false;
    } finally {
      busy = detector.disabled = false;
    }
  };

  function update({ scan, tick, evidence }) {
    if (panel.hidden) return [];
    const sensed = freshScan(scan, tick) ? scan : null;
    if (sensed !== drawingScan) {
      drawRange(range, sensed);
      drawingScan = sensed;
    }
    text(get("driveSenseRangeStatus"), sensed ? "Current virtual range returns" : "Waiting for a current scan");
    const ageS = evidence.frame ? tick / 60 - evidence.frame.simulationTimeS : 0;
    const pair = pairCameraEvidence(ageS > .75 || ageS < -.00001
      ? { ...evidence, availability: { status: "stale" } } : evidence);
    const people = pair.result?.detections.filter(detection => detection.label === "person").length ?? 0;
    const vehicles = pair.result?.detections.filter(detection => detection.label === "vehicle").length ?? 0;
    const recognition = `${people} ${people === 1 ? "person" : "people"} · ${vehicles} ${vehicles === 1 ? "vehicle" : "vehicles"}`;
    const state = labels[pair.status] ?? "Waiting for front camera";
    text(status, pair.canAnalyze
      ? rendered?.key === pair.key && rendered.analyzed ? recognition : "Matching camera image…"
      : state);
    text(detector, evidence.enabled ? "Stop detector" : "Start detector");
    detector.disabled = busy;
    if ((!pair.canAnalyze && rendered?.analyzed) || pair.status === "stale") clearImage(state);
    const nextKey = pair.key && `${pair.key}:${pair.status}`;
    if (key !== nextKey) {
      key = nextKey;
      const current = ++generation;
      if (!pair.rawAvailable || pair.status === "stale") clearImage(state);
      else {
        const next = new Image();
        next.src = `data:image/jpeg;base64,${pair.frame.imageJpegBase64}`;
        next.decode().then(() => {
          if (generation !== current || panel.hidden) return;
          image.width = pair.frame.camera.width;
          image.height = pair.frame.camera.height;
          camera.drawImage(next, 0, 0, image.width, image.height);
          for (const detection of pair.result?.detections ?? []) {
            const [x1, y1, x2, y2] = detection.box;
            const label = detection.label === "person" ? "Person" : detection.label === "vehicle" ? "Vehicle" : "Motion";
            const labelY = Math.max(21, y1);
            camera.strokeStyle = detection.label === "person" ? "#ffca83" : "#9ee4ce";
            camera.lineWidth = 3;
            camera.strokeRect(x1, y1, x2 - x1, y2 - y1);
            camera.font = "21px system-ui";
            camera.fillStyle = "#14251f";
            camera.fillRect(x1, labelY - 21, camera.measureText(label).width + 12, 23);
            camera.fillStyle = camera.strokeStyle;
            camera.fillText(label, x1 + 5, labelY - 3);
          }
          image.hidden = false;
          empty.hidden = true;
          image.dataset.frameId = String(pair.frame.frameId);
          image.dataset.streamId = pair.frame.streamId;
          rendered = { key: pair.key, analyzed: pair.canAnalyze };
          if (pair.canAnalyze) text(status, recognition);
        }).catch(() => {
          if (generation === current) clearImage("Front RGB could not be decoded.");
        });
      }
    }
    const forecasts = pedestrianForecasts({ scan: sensed, tick, pair });
    report = { rangeTick: sensed?.tick ?? null, camera: pair.status, cameraFrame: pair.result?.frameId ?? null,
      cameraSource: pair.result?.model.id ?? null, people, vehicles,
      forecasts: forecasts.map(({ id, source, points }) => ({ id, source, points })) };
    return forecasts;
  }
  return { show, update, get open() { return !panel.hidden; }, get report() { return report; } };
}
