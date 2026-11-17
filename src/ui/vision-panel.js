import { VISION_CASES } from "../core/vision-scenarios.js";

const MODES = [
  ["vision-first", "Vision-first + safety"],
  ["sensors-only", "Sensors-only comparison"],
];
const finite = (value) => Number.isFinite(value);
const readable = (value) => typeof value === "string" ? value.replaceAll("-", " ") : "Unavailable";

function node(tag, className = "", content) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (content !== undefined) element.textContent = content;
  return element;
}
function text(element, content) {
  if (element.textContent !== content) element.textContent = content;
}

export function mountVisionPanel({ toolbar, onAction }) {
  if (!toolbar?.append || typeof onAction !== "function")
    throw new TypeError("Vision controls require a toolbar and an action callback");
  const cleanups = [], pending = new Set();
  let latest = {}, disposed = false;
  const listen = (element, type, listener) => {
    element.addEventListener(type, listener);
    cleanups.push(() => element.removeEventListener(type, listener));
  };
  const button = (id, label, action) => {
    const element = node("button", "", label);
    element.id = id;
    element.type = "button";
    if (action) listen(element, "click", () => dispatch(action, undefined, element));
    return element;
  };
  const toggleButton = button("visionToggleBtn", "Vision");
  toggleButton.setAttribute("aria-controls", "visionPanel");
  toggleButton.setAttribute("aria-expanded", "false");
  toolbar.append(toggleButton);

  const panel = node("section", "vision-panel");
  panel.id = "visionPanel";
  panel.hidden = true;
  panel.setAttribute("aria-labelledby", "visionPanelTitle");
  const header = node("div", "vision-panel-head");
  const heading = node("h2", "", "Vision");
  heading.id = "visionPanelTitle";
  const closeButton = button("visionCloseBtn", "Close");
  closeButton.setAttribute("aria-label", "Close vision controls");
  header.append(heading, closeButton);
  const description = node("p", "vision-note",
    "Front-camera crossing forecast. Geometry safety stays on in both modes.");
  const status = node("p", "vision-status", "Awaiting a front-camera observation.");
  status.id = "visionAvailability";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const controls = node("div", "vision-controls");
  function select(id, label, values, action) {
    const row = node("label", "vision-select");
    const input = node("select");
    input.id = id;
    for (const [value, name] of values) {
      const option = node("option", "", name);
      option.value = value;
      input.append(option);
    }
    row.append(node("span", "", label), input);
    listen(input, "change", () => dispatch(action, input.value, input));
    controls.append(row);
    return input;
  }
  const caseSelect = select("visionCase", "Scene",
    VISION_CASES.map((item) => [item.id, item.label]), "case");
  const modeSelect = select("visionMode", "Driver", MODES, "mode");
  const caseNote = node("p", "vision-note");
  caseNote.id = "visionCaseNote";
  const actions = node("div", "vision-actions");
  const runButton = button("visionRunBtn", "Run scene", "run");
  const resetButton = button("visionResetBtn", "Reset scene", "reset");
  runButton.setAttribute("aria-describedby", "visionAvailability");
  actions.append(runButton, resetButton);
  const returnButton = button("visionReturnBtn", "Return to city", "return-city");

  const readings = node("dl", "vision-readings");
  const values = {};
  for (const [key, label] of [
    ["camera", "Input"], ["model", "Model"], ["method", "Method / provider"],
    ["latency", "Inference"], ["age", "Frame / age"], ["tracks", "Observed tracks"],
    ["forecast", "Future conflict"], ["decision", "Visual cap"], ["applied", "Applied cause"],
    ["proximity", "Front proximity"],
  ]) {
    const value = node("dd", "", "Unavailable");
    value.id = key === "tracks" ? "visionTrackCount" : `vision${key[0].toUpperCase()}${key.slice(1)}`;
    values[key] = value;
    readings.append(node("dt", "", label), value);
  }
  const detail = node("details", "vision-detail");
  detail.append(node("summary", "", "Track evidence and comparison"));
  const trackList = node("ul", "vision-track-list");
  trackList.id = "visionTracks";
  const comparison = node("p", "vision-comparison",
    "No paired run recorded. Run the same scene in each mode.");
  comparison.id = "visionComparison";
  const caution = node("p", "vision-note",
    "A constant-velocity estimate, not knowledge of intent. Unidentified motion stays ambiguous; no track is not proof of a clear road.");
  detail.append(trackList, comparison, caution);
  const error = node("p", "vision-error");
  error.id = "visionActionError";
  error.hidden = true;
  error.setAttribute("role", "alert");
  const help = node("p", "vision-help", "Space takes manual control. Reset retries the visual stream.");
  panel.append(header, description, status, controls, caseNote, actions, returnButton,
    readings, detail, error, help);
  document.body.append(panel);

  function showError(reason) {
    text(error, typeof reason === "string" && reason.trim()
      ? reason : "Vision action failed. Reset the scene or return to city.");
    error.hidden = false;
  }
  function acknowledge(result, control) {
    if (disposed) return;
    if (result?.ok !== true) {
      showError(result?.error || "That action was not acknowledged. Try Reset scene or Return to city.");
      if (control === caseSelect && VISION_CASES.some((item) => item.id === latest.caseId))
        caseSelect.value = latest.caseId;
      if (control === modeSelect && MODES.some(([id]) => id === latest.mode))
        modeSelect.value = latest.mode;
      update(latest);
    } else error.hidden = true;
  }
  function dispatch(action, value, control) {
    if (disposed || control.disabled || pending.has(control)) return;
    try {
      const result = onAction(action, value);
      if (result?.then) {
        pending.add(control);
        control.setAttribute("aria-busy", "true");
        update(latest);
        Promise.resolve(result)
          .then((ack) => acknowledge(ack, control))
          .catch((failure) => {
            if (!disposed) showError(failure?.message);
          })
          .finally(() => {
            pending.delete(control);
            control.removeAttribute("aria-busy");
            if (!disposed) {
              update(latest);
              if (!panel.hidden && document.activeElement === document.body && !control.disabled)
                control.focus();
            }
          });
      } else acknowledge(result, control);
    } catch (failure) {
      showError(failure?.message);
      update(latest);
    }
  }
  function close(restoreFocus = true) {
    if (disposed) return;
    const wasOpen = !panel.hidden;
    panel.hidden = true;
    toggleButton.setAttribute("aria-expanded", "false");
    if (restoreFocus && wasOpen) toggleButton.focus();
  }
  listen(toggleButton, "click", () => {
    if (!panel.hidden) {
      close();
      return;
    }
    panel.hidden = false;
    toggleButton.setAttribute("aria-expanded", "true");
    if (latest.world?.environment !== "vision")
      dispatch("enter", caseSelect.value, toggleButton);
  });
  listen(closeButton, "click", () => close());
  listen(document, "keydown", (event) => {
    if (event.key === "Escape" && !panel.hidden) {
      close();
      event.preventDefault();
    }
  });
  listen(toolbar, "click", (event) => {
    if (!toggleButton.contains(event.target)) close(false);
  });
  function disable(control, unavailable, reason) {
    control.disabled = unavailable || pending.has(control);
    control.setAttribute("aria-disabled", String(control.disabled));
    control.title = control.disabled ? reason : "";
  }
  function update(state = {}) {
    if (disposed) return;
    latest = state;
    const { world, vision, availability, mode, caseId, running, comparison: pair } = state;
    const inVision = world?.environment === "vision";
    const busy = Boolean(running);
    const selectedCase = VISION_CASES.find((item) => item.id === caseId) ??
      VISION_CASES.find((item) => item.id === caseSelect.value) ?? VISION_CASES[0];
    if (document.activeElement !== caseSelect && !pending.has(caseSelect))
      caseSelect.value = selectedCase.id;
    if (MODES.some(([id]) => id === mode) &&
        document.activeElement !== modeSelect && !pending.has(modeSelect))
      modeSelect.value = mode;
    text(caseNote, selectedCase.description);
    disable(runButton, !inVision || busy,
      busy ? "The current scene is running. Reset to run it again." : "Open Vision to enter the separate scene.");
    disable(resetButton, !inVision, "Reset is available inside the separate visual scene.");
    disable(returnButton, !inVision, "You are already in the city.");
    disable(caseSelect, busy, "Reset the running scene before changing its case.");
    disable(modeSelect, busy, "Reset the running scene before changing its driver.");
    const suppliedStatus = typeof availability === "string" ? availability : availability?.status;
    const statusName = ["error", "disabled", "loading", "stale", "unavailable"].includes(suppliedStatus)
      ? suppliedStatus : vision?.status ?? suppliedStatus ?? "unavailable";
    const fault = availability?.error || vision?.availability?.error;
    const received = vision?.source === "visual-prediction" && vision.available === true &&
      Number.isSafeInteger(vision.frameId) && finite(vision.ageMs) && vision.ageMs <= 750 &&
      statusName === "ready" && availability?.available !== false && !fault;
    text(status, statusName === "error" || fault
      ? `Perception unavailable: ${fault || "camera processing failed"}. Reset to retry.`
      : statusName === "stale" ? "Visual evidence is stale. No valid visual-first decision."
        : statusName === "loading" ? "Loading the installed detector. No visual decision yet."
          : statusName === "disabled" ? "Perception is disabled. Geometry safety remains separate."
            : !received ? "Awaiting a matching front-camera observation. Reset to retry."
              : busy ? "Scene running with current front-camera observations."
                : "Front-camera observation received. Run when ready.");
    status.dataset.state = received && statusName === "ready" && !fault ? "ready" : statusName;
    const model = vision?.model ?? availability?.model;
    const decision = vision?.decision;
    text(values.camera, received
      ? `Physical front RGB · ${vision.detections ?? 0} detector ${vision.detections === 1 ? "box" : "boxes"}`
      : "Physical front RGB · no current evidence");
    text(values.model, model?.id || "Not loaded");
    text(values.method, model ? `${model.method || "Unknown"} / ${model.provider || "Unknown"}` : "Unavailable");
    text(values.latency, finite(vision?.latencyMs) ? `${vision.latencyMs.toFixed(0)} ms` : "Not measured");
    text(values.age, Number.isSafeInteger(vision?.frameId) && finite(vision?.ageMs)
      ? `#${vision.frameId} · ${vision.ageMs.toFixed(0)} ms` : "No matched frame");
    const tracks = Array.isArray(vision?.tracks) ? vision.tracks : [];
    text(values.tracks, `${tracks.length} · ${tracks.filter((track) => track.label === "person").length} semantic person`);
    const conflicts = received && Array.isArray(vision?.forecasts)
      ? vision.forecasts.filter((item) => item.conflict === true) : [];
    const next = conflicts.find((item) => finite(item.crossingTimeS));
    text(values.forecast, next
      ? `Lane entry ~${next.crossingTimeS.toFixed(1)} s · score ${(next.confidence * 100).toFixed(0)}%`
      : received ? "No qualified conflict forecast" : "Unavailable");
    text(values.decision, !received || !decision?.available
      ? `Unavailable · ${readable(decision?.reason)}`
      : decision.brake && mode === "sensors-only" ? `Observe only · ${readable(decision.reason)}`
        : decision.brake ? `Stop requested · ${readable(decision.reason)}`
        : `No visual cap · ${readable(decision.reason)}`);
    values.decision.dataset.brake = String(Boolean(received && decision?.available &&
      decision.brake && mode !== "sensors-only"));
    text(values.applied, world?.player ? readable(world.player.reason) : "Controller unavailable");
    const ranges = world?.sensors?.filteredM;
    const validRanges = Array.isArray(ranges) ? ranges.filter(finite) : [];
    text(values.proximity, validRanges.length
      ? `${Math.min(...validRanges).toFixed(1)} m · separate geometry`
      : "Unavailable · separate geometry");
    const entries = tracks.slice(0, 3).map((track) => {
      const speed = track.velocity
        ? Math.hypot(track.velocity.x, track.velocity.z) : null;
      return `${track.id} · ${track.label === "motion" ? "ambiguous motion" : track.label} · ` +
        `${track.observations ?? 0} observations · ${finite(speed) ? speed.toFixed(2) : "—"} m/s · ` +
        `uncertainty ${finite(track.uncertaintyM) ? track.uncertaintyM.toFixed(2) : "—"} m`;
    });
    const lines = entries.length ? entries : ["No projected visual tracks."];
    while (trackList.children.length > lines.length) trackList.lastElementChild.remove();
    lines.forEach((line, i) => {
      if (!trackList.children[i]) trackList.append(node("li"));
      text(trackList.children[i], line);
    });
    const visualTime = pair?.visionBrakeTimeS;
    const reactiveTime = pair?.reactiveBrakeTimeS;
    text(comparison, finite(visualTime) && finite(reactiveTime)
      ? `Recorded onset: vision ${visualTime.toFixed(2)} s; sensors-only ${reactiveTime.toFixed(2)} s. ` +
        `Difference ${(reactiveTime - visualTime).toFixed(2)} s.`
      : finite(visualTime) || finite(reactiveTime)
        ? `Recorded onset: ${finite(visualTime) ? `vision ${visualTime.toFixed(2)} s` : `sensors-only ${reactiveTime.toFixed(2)} s`}. ` +
          "Paired run not recorded."
        : "No paired run recorded. Run the same scene in each mode.");
  }
  update();
  return {
    update,
    close,
    dispose() {
      if (disposed) return;
      close();
      disposed = true;
      cleanups.forEach((cleanup) => cleanup());
      pending.clear();
      panel.remove();
      toggleButton.remove();
    },
  };
}
