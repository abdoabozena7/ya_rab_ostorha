const VIEWS = [
  ["chase", "Chase"],
  ["cockpit", "Cockpit"],
  ["inspection", "Inspect"],
  ["running-gear", "Running gear"],
];
const finite = (value, fallback = 0) =>
  Number.isFinite(value) ? value : fallback;

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text != null) element.textContent = text;
  return element;
}

function text(element, value) {
  if (element.textContent !== value) element.textContent = value;
}

export function mountVehiclePanel({ toolbar, onAction }) {
  if (!toolbar?.append || typeof onAction !== "function")
    throw new TypeError("Car controls require a toolbar and an action callback");
  const cleanups = [];
  const pending = new Set();
  let disposed = false;
  let latest = {};
  const listen = (element, type, callback) => {
    element.addEventListener(type, callback);
    cleanups.push(() => element.removeEventListener(type, callback));
  };
  const button = (id, label, action, value) => {
    const result = node("button", "", label);
    result.type = "button";
    if (id) result.id = id;
    if (action)
      listen(result, "click", () => dispatch(action, value, result));
    return result;
  };
  const toggleButton = button("carToggleBtn", "Car");
  toggleButton.setAttribute("aria-controls", "carPanel");
  toggleButton.setAttribute("aria-expanded", "false");
  toolbar.append(toggleButton);

  const panel = node("section", "car-panel");
  panel.id = "carPanel";
  panel.hidden = true;
  panel.setAttribute("aria-labelledby", "carPanelTitle");
  const head = node("div", "car-panel-head");
  const heading = node("h2", "", "Car");
  heading.id = "carPanelTitle";
  const closeButton = button("carCloseBtn", "Close");
  closeButton.setAttribute("aria-label", "Close car controls");
  head.append(heading, closeButton);
  const description = node(
    "p",
    "car-panel-note",
    "Faceted SUV · left-hand cockpit",
  );
  const viewGroup = node("fieldset", "car-views");
  viewGroup.append(node("legend", "", "View"));
  const viewButtons = VIEWS.map(([value, label]) => {
    const control = button(null, label, "view", value);
    control.dataset.carView = value;
    control.setAttribute("aria-pressed", "false");
    viewGroup.append(control);
    return [value, control];
  });
  const driveInfo = node("dl", "car-readings");
  const speedValue = node("dd", "", "Waiting for car");
  const steeringValue = node("dd", "", "—");
  driveInfo.append(
    node("dt", "", "Speed / gear"),
    speedValue,
    node("dt", "", "Front steering"),
    steeringValue,
  );
  const options = node("div", "car-options");
  const checkbox = (id, label, action) => {
    const row = node("label", "car-option");
    const input = node("input");
    input.id = id;
    input.type = "checkbox";
    row.append(input, node("span", "", label));
    listen(input, "change", () => dispatch(action, input.checked, input));
    options.append(row);
    return input;
  };
  const cutawayInput = checkbox("carCutaway", "Body cutaway", "cutaway");
  const sensorsInput = checkbox(
    "carSensors",
    "Virtual range rays",
    "sensors",
  );
  const cameraLabel = node("label", "car-camera-select");
  cameraLabel.append(node("span", "", "Camera feed"));
  const cameraSelect = node("select");
  cameraSelect.id = "carSensorCamera";
  for (const [value, label] of [["front", "Front RGB"], ["rear", "Rear RGB"]]) {
    const option = node("option", "", label);
    option.value = value;
    cameraSelect.append(option);
  }
  cameraLabel.append(cameraSelect);
  listen(cameraSelect, "change", () =>
    dispatch("sensor-camera", cameraSelect.value, cameraSelect),
  );
  const sensorTitle = node(
    "p",
    "car-range-label",
    "Front ranges · virtual geometry · m",
  );
  const ranges = node("div", "car-ranges");
  ranges.setAttribute("aria-label", "Five virtual bumper ranges in metres");
  const rangeValues = [-70, -35, 0, 35, 70].map((angle) => {
    const entry = node("div");
    const value = node("strong", "", "—");
    entry.append(node("span", "", `${angle > 0 ? "+" : ""}${angle}°`), value);
    ranges.append(entry);
    return value;
  });
  const auxTitle = node("p", "car-range-label", "Rear / side · virtual geometry · m");
  const auxiliary = node("div", "car-ranges");
  auxiliary.id = "carAuxRanges";
  auxiliary.setAttribute("aria-label", "Five virtual rear and side ranges in metres");
  const auxiliaryValues = [
    ["rear-left", "Rear L"], ["rear-center", "Rear"], ["rear-right", "Rear R"],
    ["side-left", "Left"], ["side-right", "Right"],
  ].map(([id, label]) => {
    const entry = node("div");
    const value = node("strong", "", "—");
    value.dataset.carRange = id;
    entry.append(node("span", "", label), value);
    auxiliary.append(entry);
    return [id, value];
  });
  const telemetry = node("div", "car-telemetry");
  telemetry.id = "carTelemetry";
  const telemetryReading = node("p", "", "Virtual IMU / GNSS unavailable");
  const telemetryPosition = node("p");
  telemetry.append(telemetryReading, telemetryPosition);
  const impactSection = node("section", "car-impact");
  const impactHeading = node("h3", "", "Controlled impact bay");
  const impactStatus = node("p", "car-panel-note");
  impactStatus.id = "carTestStatus";
  const impactDetails = node("p", "car-contact-details");
  const bayButton = button(
    "carImpactBayBtn",
    "Open impact bay",
    "impact-bay",
  );
  const impactActions = node("div", "car-impact-actions");
  const runButton = button("carImpactRunBtn", "Run impact", "impact-run");
  const resetButton = button("carResetBtn", "Repair / reset", "reset-car");
  runButton.setAttribute("aria-describedby", "carTestStatus");
  resetButton.setAttribute("aria-describedby", "carTestStatus");
  const returnButton = button(
    "carReturnBtn",
    "Return to city",
    "return-city",
  );
  impactActions.append(runButton, resetButton);
  impactSection.append(
    impactHeading,
    impactStatus,
    impactDetails,
    bayButton,
    impactActions,
    returnButton,
  );
  const error = node("p", "car-error");
  error.id = "carActionError";
  error.hidden = true;
  error.setAttribute("role", "alert");
  const help = node(
    "p",
    "car-panel-help",
    "W A S D drive · Space brake · C camera",
  );
  panel.append(
    head,
    description,
    viewGroup,
    driveInfo,
    options,
    cameraLabel,
    sensorTitle,
    ranges,
    auxTitle,
    auxiliary,
    telemetry,
    impactSection,
    error,
    help,
  );
  document.body.append(panel);

  function showError(reason) {
    text(error, reason);
    error.hidden = false;
  }
  function applyResult(result) {
    if (disposed) return;
    if (result === false || result?.ok === false) {
      showError(result?.error || "That car action is unavailable. Try again.");
      update(latest);
    } else if (result?.ok !== true) {
      showError("The car action was not acknowledged. Please try again.");
      update(latest);
    }
  }
  function dispatch(action, value, control) {
    if (disposed || control.disabled || pending.has(control)) return;
    error.hidden = true;
    try {
      const result = onAction(action, value);
      if (result?.then) {
        pending.add(control);
        control.disabled = true;
        Promise.resolve(result)
          .then(applyResult)
          .catch((failure) => {
            if (!disposed)
              showError(failure?.message || "Car action failed. Try again.");
          })
          .finally(() => {
            pending.delete(control);
            if (!disposed) update(latest);
          });
      } else applyResult(result);
    } catch (failure) {
      showError(failure?.message || "Car action failed. Try again.");
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
    if (panel.hidden) {
      panel.hidden = false;
      toggleButton.setAttribute("aria-expanded", "true");
    } else close();
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

  function disabled(control, unavailable, reason) {
    control.disabled = unavailable || pending.has(control);
    control.title = control.disabled ? reason : "";
    control.setAttribute("aria-disabled", String(control.disabled));
  }
  function update(state = {}) {
    if (disposed) return;
    latest = state;
    const {
      world, actor, rig, mode = "chase", cutaway, sensors, sensorCamera = "front",
    } = state;
    const loaded = Boolean(rig?.root && rig?.diagnostics?.ready !== false);
    const inBay = world?.environment === "vehicle";
    const phase = world?.vehicleTest?.phase;
    const knownPhase = ["ready", "running", "contact"].includes(phase);
    const stopped = Math.abs(finite(actor?.speed)) < 0.15;
    const running = phase === "running";
    const vehicle = actor?.vehicle;
    const loadingReason = "The detailed car is still loading.";
    for (const [view, control] of viewButtons) {
      control.setAttribute("aria-pressed", String(mode === view));
      disabled(control, view !== "chase" && !loaded, loadingReason);
    }
    cutawayInput.checked = Boolean(cutaway);
    sensorsInput.checked = Boolean(sensors);
    disabled(cutawayInput, !loaded, loadingReason);
    disabled(sensorsInput, !loaded, loadingReason);
    cameraSelect.value = sensorCamera === "rear" ? "rear" : "front";
    disabled(cameraSelect, !loaded, loadingReason);
    const speed = finite(actor?.speed) * 3.6;
    const gear = vehicle?.controls?.gear ?? "—";
    text(
      speedValue,
      actor ? `${Math.abs(speed).toFixed(0)} km/h · ${gear}` : "Waiting for car",
    );
    const left = (finite(vehicle?.wheelAngles?.frontLeft) * 180) / Math.PI;
    const right = (finite(vehicle?.wheelAngles?.frontRight) * 180) / Math.PI;
    text(
      steeringValue,
      vehicle ? `${left.toFixed(1)}° / ${right.toFixed(1)}°` : "Waiting for rig",
    );
    for (let i = 0; i < rangeValues.length; i++) {
      const raw = world?.sensors?.rawM?.[i];
      text(rangeValues[i], Number.isFinite(raw) ? raw.toFixed(1) : "—");
    }
    for (const [id, element] of auxiliaryValues) {
      const range = world?.sensors?.auxiliary?.find((ray) => ray.id === id)?.rangeM;
      text(element, Number.isFinite(range) ? range.toFixed(1) : "—");
    }
    const imu = world?.sensors?.imu;
    const telemetryReady = imu?.source === "simulated-vehicle-state";
    text(
      telemetryReading,
      telemetryReady
        ? `Virtual IMU / GNSS · ${finite(imu.longitudinalAccelerationMps2).toFixed(1)} m/s² · ` +
          `${(finite(imu.yawRateRadS) * 180 / Math.PI).toFixed(1)}°/s`
        : "Virtual IMU / GNSS unavailable",
    );
    telemetryPosition.hidden = !telemetryReady;
    if (telemetryReady) {
      const p = imu.positionM ?? {};
      text(telemetryPosition,
        `X ${finite(p.x).toFixed(1)} · Y ${finite(p.y).toFixed(1)} · Z ${finite(p.z).toFixed(1)} m`);
    }
    bayButton.hidden = inBay;
    returnButton.hidden = !inBay;
    disabled(bayButton, !loaded, loadingReason);
    const runReason = !loaded
      ? loadingReason
      : !inBay
        ? "Open the separate impact bay first; the city is not a crash test."
        : !knownPhase
          ? "The impact fixture is unavailable. Return to city and reopen the bay."
        : phase !== "ready"
          ? running
            ? "The bounded contact run is in progress."
            : "Repair / reset the stopped car before another run."
          : "";
    disabled(
      runButton,
      !loaded || !inBay || phase !== "ready",
      runReason,
    );
    const resetReason = !inBay
      ? "Repair is only available in the separate impact bay."
      : !knownPhase
        ? "The impact fixture is unavailable. Return to city and reopen the bay."
      : running || !stopped
        ? "Stop the car before repairing it."
        : !loaded
          ? loadingReason
          : "";
    disabled(
      resetButton,
      !loaded || !inBay || !knownPhase || running || !stopped,
      resetReason,
    );
    disabled(returnButton, false, "");
    text(
      impactStatus,
      !inBay
        ? "A separate empty road. Your city is preserved."
        : !knownPhase
          ? "Impact fixture unavailable. Return to city and reopen the bay."
        : running
          ? "Driving to the fixed barrier · maximum 6 m/s."
          : phase === "contact"
            ? "Contact recorded. The stopped car is ready to inspect or repair."
            : "Ready · one real low-speed contact, no traffic or pedestrians.",
    );
    const damage = vehicle?.damage;
    const impact = damage?.lastImpact;
    impactDetails.hidden = !inBay || !impact;
    if (impact) {
      const side = impact.side || "body";
      const amount = Math.round(finite(damage?.[side]) * 100);
      text(
        impactDetails,
        `${side[0].toUpperCase()}${side.slice(1)} ${amount}% · ` +
          `${finite(impact.closingSpeedMps).toFixed(1)} m/s · ` +
          `${(finite(impact.energyJ) / 1000).toFixed(1)} kJ`,
      );
    }
    text(
      description,
      loaded
        ? "Faceted SUV · left-hand cockpit"
        : "Preparing the authored SUV…",
    );
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const cleanup of cleanups) cleanup();
    panel.remove();
    toggleButton.remove();
    pending.clear();
  }
  update();
  return { update, close: () => close(), dispose };
}
