import { cameraFrameKey, pairCameraEvidence, projectPixelTrack } from "./camera-evidence.js";

const finite = Number.isFinite;
const now = () => globalThis.performance?.now() ?? Date.now();
const readable = (value) => typeof value === "string" && value.trim()
  ? value.replaceAll("-", " ") : "Unavailable";
function node(tag, className = "", content) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (content !== undefined) element.textContent = content;
  return element;
}
function text(element, value) {
  if (element.textContent !== value) element.textContent = value;
}

export function mountCameraScreen({ navigation, onAction, onVisibilityChange } = {}) {
  if (!navigation?.append || typeof onAction !== "function" ||
      (onVisibilityChange !== undefined && typeof onVisibilityChange !== "function"))
    throw new TypeError("Camera screen requires navigation and action callbacks");
  const cleanups = [];
  const receipts = new Map();
  let latest = {}, disposed = false, generation = 0, actionGeneration = 0;
  let busyAction = null, suppressAnalysis = false, previouslyEnabled = false;
  let decoded = null, decodingKey = null, decodedKey = null, decodedSource = null;
  let currentPair = null, committed = null, paintKey = null, receivedAt = null, expiryTimer = null;
  let simulationStream = null, simulationNowS = null;
  let decodeFailure = null, imageError = false;
  const listen = (element, type, listener) => {
    element.addEventListener(type, listener);
    cleanups.push(() => element.removeEventListener(type, listener));
  };
  const button = (id, label, action) => {
    const element = node("button", "", label);
    element.id = id;
    element.type = "button";
    if (action) listen(element, "click", () => dispatch(action, element));
    return element;
  };
  const toggle = button("cameraScreenToggleBtn", "Camera");
  toggle.setAttribute("aria-controls", "cameraScreen");
  toggle.setAttribute("aria-expanded", "false");
  navigation.append(toggle);
  const panel = node("section", "camera-screen");
  panel.id = "cameraScreen";
  panel.hidden = true;
  panel.setAttribute("aria-labelledby", "cameraScreenTitle");
  const header = node("header", "camera-screen-head");
  const heading = node("h2", "", "Front camera");
  heading.id = "cameraScreenTitle";
  const controls = node("div", "camera-screen-actions");
  const start = button("cameraPerceptionStartBtn", "Start detector", "start");
  const stop = button("cameraPerceptionStopBtn", "Stop detector", "stop");
  const lab = button("cameraOpenVisionBtn", "Vision lab", "vision-lab");
  const closeButton = button("cameraScreenCloseBtn", "Close");
  closeButton.setAttribute("aria-label", "Close camera and return to driving view");
  controls.append(start, stop, lab, closeButton);
  header.append(heading, controls);
  const status = node("p", "camera-screen-status", "Detector off · waiting for front RGB.");
  status.id = "cameraScreenStatus";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const images = node("div", "camera-screen-images");
  function imagePane(id, title, description) {
    const figure = node("figure", "camera-screen-image");
    const caption = node("figcaption", "", title);
    const host = node("div", "camera-screen-image-host");
    const canvas = node("canvas");
    canvas.id = id;
    canvas.width = 640;
    canvas.height = 360;
    canvas.hidden = true;
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", description);
    const empty = node("p", "camera-screen-empty", "Waiting for front RGB.");
    host.append(canvas, empty);
    figure.append(caption, host);
    images.append(figure);
    return { canvas, empty, caption, context: canvas.getContext("2d") };
  }
  const raw = imagePane("cameraRawCanvas", "Raw front RGB",
    "Actual rendered vehicle front camera, before annotations");
  const analysis = imagePane("cameraAnalysisCanvas", "Exact-frame evidence",
    "The identical decoded front-camera JPEG with pixel-detector evidence");
  const legend = node("p", "camera-screen-legend",
    "Boxes: detector score, not intent probability · solid: observed ground-plane estimates · dashed: fitted motion, up to 3 s");
  const identity = node("p", "camera-screen-meta", "Source: rendered game front RGB · no matched frame.");
  identity.id = "cameraFrameIdentity";
  const timing = node("p", "camera-screen-meta");
  timing.id = "cameraFrameTiming";
  const recognition = node("p", "camera-screen-recognition");
  recognition.id = "cameraRecognition";
  const applied = node("p", "camera-screen-applied");
  applied.id = "cameraAppliedReason";
  const detail = node("details", "camera-screen-detail");
  detail.append(node("summary", "", "Detection and motion evidence"));
  const detectionList = node("ul", "camera-screen-evidence-list");
  detectionList.id = "cameraDetectionList";
  const motionList = node("ul", "camera-screen-evidence-list");
  motionList.id = "cameraMotionList";
  const limits = node("p", "camera-screen-note",
    "Only camera pixels, calibration and own-vehicle odometry inform these estimates. No text reader is active; OCR and human intention are not inferred. No detection is not proof of a clear road.");
  detail.append(detectionList, motionList, limits);
  const error = node("p", "camera-screen-error");
  error.id = "cameraScreenError";
  error.hidden = true;
  error.setAttribute("role", "alert");
  const help = node("p", "camera-screen-help",
    "Opening this screen does not start a model. Close / Esc returns to driving. W A S D drive · Space brake.");
  panel.append(header, status, error, applied, images, legend, identity, timing, recognition, detail, help);
  document.body.append(panel);

  function showError(reason) {
    if (disposed) return;
    const message = typeof reason === "string" && reason.trim()
      ? reason : "Camera action was not acknowledged. Stop, then Retry detector.";
    text(error, message);
    error.hidden = false;
    toggle.title = message;
  }
  function notifyVisibility(visible) {
    const failed = (failure) => {
      showError(failure?.message || failure?.error || "Camera view change failed. Close or reopen to retry.");
      if (!visible && !disposed) {
        panel.hidden = false;
        toggle.setAttribute("aria-expanded", "true");
        render(latest);
        closeButton.focus();
      }
    };
    const acknowledge = (result) => {
      if (result === false || result?.ok === false) failed(result);
    };
    try {
      const result = onVisibilityChange?.(visible);
      if (result?.then) Promise.resolve(result).then(acknowledge).catch(failed);
      else acknowledge(result);
    } catch (failure) { failed(failure); }
  }
  function clearImages() {
    for (const pane of [raw, analysis]) {
      pane.context?.clearRect(0, 0, pane.canvas.width, pane.canvas.height);
      pane.canvas.hidden = true;
      pane.empty.hidden = false;
      delete pane.canvas.dataset.streamId;
      delete pane.canvas.dataset.frameId;
    }
    paintKey = null;
    committed = null;
    describeFrame(null);
  }
  function invalidate() {
    generation++;
    decodingKey = decodedKey = decodedSource = decoded = null;
    decodeFailure = null;
    clearTimeout(expiryTimer);
    expiryTimer = null;
    clearImages();
  }
  async function dispatch(action, control) {
    if (disposed || control.disabled) return;
    const operation = ++actionGeneration;
    busyAction = action;
    error.hidden = true;
    toggle.title = "";
    if (action === "stop") {
      suppressAnalysis = true;
      invalidate();
    } else if (action === "start") {
      suppressAnalysis = false;
      invalidate();
    }
    render(latest);
    try {
      const result = await onAction(action);
      if (disposed || operation !== actionGeneration) return;
      if (result?.ok !== true) showError(result?.error);
    } catch (failure) {
      if (operation === actionGeneration) showError(failure?.message);
    } finally {
      if (!disposed && operation === actionGeneration) {
        busyAction = null;
        render(latest);
      }
    }
  }
  function close(restoreFocus = true) {
    if (disposed || panel.hidden) return;
    panel.hidden = true;
    toggle.setAttribute("aria-expanded", "false");
    invalidate();
    notifyVisibility(false);
    if (restoreFocus) toggle.focus();
  }
  listen(toggle, "click", () => {
    if (!panel.hidden) return close();
    panel.hidden = false;
    toggle.setAttribute("aria-expanded", "true");
    notifyVisibility(true);
    render(latest);
    closeButton.focus();
  });
  listen(closeButton, "click", () => close());
  listen(document, "keydown", (event) => {
    if (event.key === "Escape" && !panel.hidden) {
      close();
      event.preventDefault();
    }
  });
  listen(navigation, "click", (event) => {
    if (!toggle.contains(event.target)) close(false);
  });
  function list(element, lines) {
    while (element.children.length > lines.length) element.lastElementChild.remove();
    lines.forEach((line, i) => {
      if (!element.children[i]) element.append(node("li"));
      text(element.children[i], line);
    });
  }
  function drawLine(context, points, dashed, color) {
    context.strokeStyle = color;
    context.lineWidth = 2.5;
    context.setLineDash(dashed ? [8, 6] : []);
    context.beginPath();
    let begun = false;
    for (const position of points) {
      if (!position) { begun = false; continue; }
      if (begun) context.lineTo(...position);
      else context.moveTo(...position);
      begun = true;
    }
    context.stroke();
    context.setLineDash([]);
  }
  function paint() {
    const pair = currentPair;
    if (disposed || panel.hidden || !decoded || decodedKey !== pair?.key ||
        decodedSource !== pair.frame.imageJpegBase64) return;
    const signature = `${pair.key}:${pair.canAnalyze}:${pair.motionAvailable}:${pair.result?.model?.id}`;
    if (signature === paintKey && committed?.pair.frame.imageJpegBase64 === decodedSource) return;
    const { width, height } = pair.frame.camera;
    for (const pane of [raw, analysis]) {
      if (pane.canvas.width !== width) pane.canvas.width = width;
      if (pane.canvas.height !== height) pane.canvas.height = height;
      pane.context?.clearRect(0, 0, width, height);
    }
    raw.context?.drawImage(decoded, 0, 0, width, height);
    if (pair.canAnalyze && analysis.context) {
      const context = analysis.context;
      context.drawImage(decoded, 0, 0, width, height);
      context.save();
      context.beginPath();
      context.rect(0, 0, width, height);
      context.clip();
      for (const track of (pair.visual?.tracks ?? []).slice(0, 24)) {
        const projected = projectPixelTrack(track, pair);
        if (!projected) continue;
        drawLine(context, projected.observed, false, "#a6edbc");
        drawLine(context, projected.predicted, true, "#f4c38d");
      }
      context.setLineDash([]);
      for (const detection of pair.result.detections) {
        const [x1, y1, x2, y2] = detection.box;
        const color = detection.label === "person" ? "#f4c38d" : "#a6edbc";
        context.strokeStyle = color;
        context.lineWidth = 2;
        context.strokeRect(x1, y1, x2 - x1, y2 - y1);
        const label = `${detection.label} · score ${detection.confidence.toFixed(2)}`;
        context.font = "13px Tahoma, Arial, sans-serif";
        const labelWidth = Math.min(width, context.measureText(label).width + 10);
        const left = Math.max(0, Math.min(x1, width - labelWidth));
        const top = Math.max(0, y1 - 22);
        context.fillStyle = "#18241df5";
        context.fillRect(left, top, labelWidth, 22);
        context.fillStyle = color;
        context.fillText(label, left + 5, top + 16);
      }
      context.restore();
    }
    describeFrame(pair, receivedAt);
    raw.canvas.dataset.streamId = pair.frame.streamId;
    raw.canvas.dataset.frameId = String(pair.frame.frameId);
    if (pair.canAnalyze) {
      analysis.canvas.dataset.streamId = pair.result.streamId;
      analysis.canvas.dataset.frameId = String(pair.result.frameId);
    } else {
      delete analysis.canvas.dataset.streamId;
      delete analysis.canvas.dataset.frameId;
    }
    raw.canvas.hidden = false;
    raw.empty.hidden = true;
    analysis.canvas.hidden = !pair.canAnalyze;
    analysis.empty.hidden = pair.canAnalyze;
    committed = { pair, receivedAt };
    paintKey = signature;
  }
  function decode(pair) {
    const source = pair.frame.imageJpegBase64;
    if (decodeFailure?.key === pair.key && decodeFailure.source === source) return;
    if (decodedKey === pair.key && decodedSource === source) { paint(); return; }
    const key = `${generation}:${pair.key}`;
    if (decodingKey === key) return;
    const ticket = ++generation;
    decodingKey = `${ticket}:${pair.key}`;
    if (!committed) text(raw.empty, "Decoding the actual front-camera JPEG…");
    const image = new Image();
    image.decoding = "async";
    const ready = typeof image.decode === "function"
      ? () => image.decode()
      : () => new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = () => reject(new Error("JPEG decode failed"));
      });
    let completed;
    if (typeof image.decode === "function") {
      image.src = `data:image/jpeg;base64,${source}`;
      completed = Promise.resolve().then(ready);
    } else {
      completed = ready();
      image.src = `data:image/jpeg;base64,${source}`;
    }
    Promise.resolve(completed).then(() => {
      if (disposed || panel.hidden || ticket !== generation || currentPair?.key !== pair.key ||
          currentPair.frame?.imageJpegBase64 !== source) return;
      if (image.naturalWidth !== pair.frame.camera.width || image.naturalHeight !== pair.frame.camera.height)
        throw new Error("Decoded JPEG dimensions do not match the captured camera");
      decoded = image;
      decodedKey = pair.key;
      decodedSource = source;
      decodingKey = null;
      if (imageError) {
        error.hidden = true;
        toggle.title = "";
        imageError = false;
      }
      render(latest);
    }).catch((failure) => {
      if (disposed || ticket !== generation) return;
      decodingKey = null;
      decodeFailure = { key: pair.key, source, message: failure?.message };
      clearImages();
      text(raw.empty, "Front RGB could not decode. Close and reopen the camera to retry.");
      text(analysis.empty, "No decoded, matching camera evidence.");
      text(status, "Camera image unavailable · close and reopen to retry.");
      status.dataset.state = "error";
      showError(failure?.message);
      imageError = true;
    });
  }
  function simulationAge(pair) {
    if (!finite(pair?.ageMs)) return null;
    return simulationStream === pair.frame.streamId && finite(simulationNowS)
      ? Math.max(pair.ageMs, (simulationNowS - pair.frame.simulationTimeS) * 1000)
      : pair.ageMs;
  }
  function fresh(bundle) {
    if (!bundle?.pair.canAnalyze || !finite(bundle.receivedAt)) return false;
    const ageMs = simulationAge(bundle.pair), wallAgeMs = now() - bundle.receivedAt;
    return wallAgeMs >= 0 && wallAgeMs < 750 &&
      (ageMs === null || (ageMs >= 0 && ageMs < 750));
  }
  function scheduleExpiry() {
    clearTimeout(expiryTimer);
    expiryTimer = null;
    const deadlines = [];
    if (currentPair?.canAnalyze && finite(receivedAt)) deadlines.push(receivedAt + 750);
    if (committed?.pair.canAnalyze) deadlines.push(committed.receivedAt + 750);
    if (deadlines.length) expiryTimer = setTimeout(() => {
      expiryTimer = null;
      render(latest);
    }, Math.max(0, Math.min(...deadlines) - now()));
  }
  function describeFrame(pair, receipt = null) {
    text(raw.caption, pair?.canAnalyze ? "Raw RGB · exact analysed frame" : "Raw front RGB · unanalysed preview");
    text(analysis.caption, pair?.canAnalyze ? "Same JPEG · pixel-derived evidence" : "Analysed view · unavailable");
    const frame = pair?.frame, result = pair?.canAnalyze ? pair.result : null;
    const ageMs = simulationAge(pair);
    text(identity, frame
      ? `Source: rendered game front RGB · stream ${frame.streamId} · frame #${frame.frameId} · t ${frame.simulationTimeS.toFixed(3)} s` +
        (result ? ` · ${result.model.id} / ${result.model.method} / ${result.model.provider}` : " · unanalysed")
      : "Source: rendered game front RGB · exact image unavailable.");
    text(timing, result
      ? `NN inference ${result.latencyMs.toFixed(1)} ms · HTTP transport not separately measured · ` +
        `simulation age ${finite(ageMs) ? `${ageMs.toFixed(0)} ms` : "unavailable"} · ` +
        `${Math.max(0, now() - receipt).toFixed(0)} ms since result receipt`
      : "Inference unavailable for this image · transport is not inference time.");
    text(recognition, result ? result.detections.length
      ? `${result.detections.length} detector ${result.detections.length === 1 ? "box" : "boxes"} · scores are uncalibrated. No OCR is active.`
      : "No detector boxes in this image. This is not proof of a clear road; no OCR is active."
      : "Recognition and future motion are unavailable for this preview.");
    list(detectionList, result
      ? result.detections.slice(0, 16).map((detection) =>
        `${detection.label} · score ${detection.confidence.toFixed(2)} (uncalibrated) · box ${detection.box.map((v) => v.toFixed(0)).join(", ")}`)
        .concat(result.detections.length > 16 ? [`${result.detections.length - 16} more boxes are visible in the image.`] : [])
      : ["No current exact-frame detections."]);
    const projected = pair?.motionAvailable
      ? (pair.visual.tracks ?? []).slice(0, 24).map((track) => projectPixelTrack(track, pair)).filter(Boolean) : [];
    list(motionList, projected.length ? projected.map((track) =>
      `${track.id} · ${track.label} · fitted ${track.speedMps.toFixed(2)} m/s · ` +
      `position uncertainty ${finite(track.uncertaintyM) ? track.uncertaintyM.toFixed(2) : "unavailable"} m · ` +
      (track.horizonS ? `${track.horizonS.toFixed(1)} s constant-velocity estimate; not intent` : track.reason))
      : ["Fitted motion unavailable: no fresh, matching observed history."]);
  }
  function render(state) {
    if (disposed || panel.hidden) return;
    let pair = pairCameraEvidence({
      frame: state.frame, result: state.result, visual: state.visual,
      availability: state.availability, enabled: state.enabled && !suppressAnalysis,
    });
    if (busyAction === "start" || busyAction === "stop") pair = {
      ...pair, canAnalyze: false, motionAvailable: false,
      status: busyAction === "start" ? "starting" : "off",
    };
    if (decodeFailure?.key === pair.key && decodeFailure.source === pair.frame?.imageJpegBase64)
      pair = {
        ...pair, canAnalyze: false, motionAvailable: false, status: "error",
        reason: "Camera image could not decode · close and reopen to retry.",
      };
    const resultKey = cameraFrameKey(state.result);
    if (resultKey && !receipts.has(resultKey)) {
      receipts.set(resultKey, now());
      if (receipts.size > 24) receipts.delete(receipts.keys().next().value);
    }
    receivedAt = receipts.get(resultKey) ?? null;
    if (pair.canAnalyze && finite(pair.ageMs)) {
      const nextSimulationNowS = pair.frame.simulationTimeS + pair.ageMs / 1000;
      simulationNowS = simulationStream === pair.frame.streamId
        ? Math.max(simulationNowS, nextSimulationNowS) : nextSimulationNowS;
      simulationStream = pair.frame.streamId;
    }
    if (pair.canAnalyze && !fresh({ pair, receivedAt })) pair = {
      ...pair, canAnalyze: false, motionAvailable: false, status: "stale",
      reason: "No new detector result for 750 ms · stale boxes and motion estimates are withheld.",
    };
    currentPair = pair;
    const unavailable = ["error", "unavailable"].includes(pair.status);
    text(start, busyAction === "start" ? "Starting…" : unavailable ? "Retry detector" : "Start detector");
    start.disabled = busyAction !== null ||
      Boolean(state.enabled && !suppressAnalysis && !["error", "unavailable", "off"].includes(pair.status));
    stop.disabled = busyAction === "stop" || (!state.enabled && busyAction !== "start");
    lab.disabled = busyAction !== null;
    start.setAttribute("aria-busy", String(busyAction === "start"));
    stop.setAttribute("aria-busy", String(busyAction === "stop"));
    text(analysis.empty, pair.status === "mismatch" ? "No matching frame. Old boxes are not drawn on new pixels."
      : pair.status === "stale" ? "Stale evidence withheld. Waiting for a fresh matching frame."
        : "No analysed image. Raw preview is not recognition.");
    text(applied, `Applied now (current controller, not an image label): ${readable(state.applied?.reason)}` +
      (finite(state.ego?.speedMps) ? ` · vehicle ${state.ego.speedMps.toFixed(2)} m/s` : ""));
    const samePixels = committed?.pair.key === pair.key &&
      committed?.pair.frame.imageJpegBase64 === pair.frame?.imageJpegBase64;
    const retainComplete = pair.canAnalyze && finite(pair.ageMs) && committed?.pair.canAnalyze &&
      committed.pair.frame.streamId === pair.frame.streamId && fresh(committed);
    const retainRaw = pair.rawAvailable && pair.status === "off" && !pair.canAnalyze &&
      committed?.pair.status === "off" && !committed.pair.canAnalyze &&
      committed.pair.frame.streamId === pair.frame.streamId;
    if (committed && !retainComplete && !retainRaw &&
        !(samePixels && !committed.pair.canAnalyze && !pair.canAnalyze)) clearImages();
    if (pair.rawAvailable) decode(pair);
    else {
      invalidate();
      text(raw.empty, "Front RGB unavailable. Close and reopen to retry the preview.");
    }
    describeFrame(committed?.pair ?? null, committed?.receivedAt);
    text(status, busyAction === "stop" ? "Stopping detector · annotations withheld."
      : busyAction === "start" ? "Starting the installed detector · raw preview is unanalysed."
        : pair.canAnalyze && !committed?.pair.canAnalyze ? "Decoding exact camera evidence · no completed analysed image yet."
          : committed?.pair.canAnalyze && committed.pair.key !== pair.key
            ? `Showing exact frame #${committed.pair.frame.frameId} · decoding the next matching JPEG.`
            : retainRaw && committed.pair.key !== pair.key
              ? `Detector off · showing unanalysed frame #${committed.pair.frame.frameId} while the next raw JPEG decodes.`
            : pair.reason);
    status.dataset.state = pair.canAnalyze && !committed?.pair.canAnalyze ? "waiting" : pair.status;
    scheduleExpiry();
  }
  function update(state = {}) {
    if (disposed) return;
    if (Boolean(state.enabled) !== previouslyEnabled) {
      invalidate();
      if (state.enabled && busyAction !== "stop") suppressAnalysis = false;
      previouslyEnabled = Boolean(state.enabled);
    }
    latest = state;
    render(state);
  }
  update();
  return {
    update, close,
    dispose() {
      if (disposed) return;
      close();
      disposed = true;
      actionGeneration++;
      invalidate();
      cleanups.forEach((cleanup) => cleanup());
      panel.remove();
      toggle.remove();
    },
  };
}
