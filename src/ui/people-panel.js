const MODES = [["ambient", "Ambient route"], ["walk", "Walk"], ["jog", "Jog"], ["stop", "Stop"]];
const finite = Number.isFinite;
const readable = (value) => typeof value === "string" && value.trim()
  ? value.replaceAll("-", " ") : "Unavailable";
const measurement = (value, units, precision = 2) =>
  finite(value) ? `${value.toFixed(precision)} ${units}` : "Unavailable";
function node(tag, className = "", content) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (content !== undefined) element.textContent = content;
  return element;
}
function text(element, value) {
  if (element.textContent !== value) element.textContent = value;
}

export function mountPeoplePanel({ navigation, onAction } = {}) {
  if (!navigation?.append || typeof onAction !== "function")
    throw new TypeError("People controls require navigation and an action callback");
  const cleanups = [];
  let latest = {}, disposed = false, operation = 0, busyAction = null, optionsKey = null;
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
  const toggle = button("peopleToggleBtn", "People");
  toggle.setAttribute("aria-controls", "peoplePanel");
  toggle.setAttribute("aria-expanded", "false");
  navigation.append(toggle);
  const panel = node("section", "people-panel");
  panel.id = "peoplePanel";
  panel.hidden = true;
  panel.setAttribute("aria-labelledby", "peoplePanelTitle");
  const header = node("div", "people-panel-head");
  const heading = node("h2", "", "People");
  heading.id = "peoplePanelTitle";
  const closeButton = button("peopleCloseBtn", "Close");
  closeButton.setAttribute("aria-label", "Close people controls and return to vehicle view");
  header.append(heading, closeButton);
  const boundary = node("p", "people-boundary", "World reference · not camera perception");
  boundary.id = "peopleReferenceBoundary";
  const note = node("p", "people-note",
    "Actual game body dimensions and accepted motion are unavailable.");
  note.id = "peopleBodySummary";
  const status = node("p", "people-status", "No people available in this world.");
  status.id = "peopleStatus";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const selectRow = node("label", "people-select");
  const select = node("select");
  select.id = "peopleSelect";
  selectRow.append(node("span", "", "Person · World actor ID"), select);
  listen(select, "change", () => dispatch("select", select.value, select));
  const viewActions = node("div", "people-view-actions");
  const focus = button("peopleFocusBtn", "Follow person");
  listen(focus, "click", () => dispatch("focus", selected()?.id, focus));
  const vehicle = button("peopleVehicleViewBtn", "Vehicle view", "vehicle-view");
  viewActions.append(focus, vehicle);
  const modeRow = node("label", "people-select");
  const mode = node("select");
  mode.id = "peopleMotionMode";
  for (const [value, name] of MODES) {
    const option = node("option", "", name);
    option.value = value;
    mode.append(option);
  }
  modeRow.append(node("span", "", "Requested motion · bounded game movement"), mode);
  listen(mode, "change", () => dispatch("motion", { id: selected()?.id, mode: mode.value }, mode));
  const modeNote = node("p", "people-note");
  modeNote.id = "peopleMotionNote";
  const readings = node("dl", "people-readings");
  const values = {};
  for (const [key, label] of [
    ["actor", "World actor / model"], ["speed", "Actual speed"], ["acceleration", "Actual acceleration"],
    ["travel", "Accepted travel"], ["position", "World position"], ["heading", "World heading"],
    ["reason", "Current movement cause"],
  ]) {
    const value = node("dd", "", "Unavailable");
    value.id = `people${key[0].toUpperCase()}${key.slice(1)}`;
    values[key] = value;
    readings.append(node("dt", "", label), value);
  }
  const bodyDetail = node("details", "people-body");
  bodyDetail.open = true;
  bodyDetail.append(node("summary", "", "Body dimensions and motion bounds"));
  const bodyReadings = node("dl", "people-readings");
  const bodyValues = {};
  for (const [key, label] of [
    ["dimensions", "Height × width × depth"], ["mass", "Game mass parameter"],
    ["radius", "Collision radius"], ["walk", "Walk / jog request"],
    ["acceleration", "Accel / decel bound"], ["turn", "Ordinary turn bound"],
  ]) {
    const value = node("dd", "", "Unavailable");
    value.id = `peopleBody${key[0].toUpperCase()}${key.slice(1)}`;
    bodyValues[key] = value;
    bodyReadings.append(node("dt", "", label), value);
  }
  bodyDetail.append(bodyReadings);
  const error = node("p", "people-error");
  error.id = "peopleActionError";
  error.hidden = true;
  error.setAttribute("role", "alert");
  const limits = node("p", "people-note",
    "Grounded kinematic game humans, not validated biomechanics, force dynamics or ragdoll injury simulation. The nonpenetrating safety guard may stop immediately.");
  const help = node("p", "people-help",
    "Following changes only the display camera; front RGB inference stays on the SUV. Close / Esc returns to the vehicle.");
  panel.append(header, boundary, note, status, selectRow, viewActions, modeRow,
    modeNote, readings, bodyDetail, error, limits, help);
  document.body.append(panel);

  function people() {
    return Array.isArray(latest.people) ? latest.people.filter((person) =>
      person && typeof person.id === "string" && person.id.trim()) : [];
  }
  function selected() {
    const entries = people();
    return entries.find((person) => person.id === latest.selectedId) ??
      entries.find((person) => person.id === select.value) ?? entries[0] ?? null;
  }
  function showError(reason) {
    if (disposed) return;
    text(error, typeof reason === "string" && reason.trim()
      ? reason : "People action was not acknowledged. Select a current person and try again.");
    error.hidden = false;
  }
  function finishClose(restoreFocus) {
    panel.hidden = true;
    toggle.setAttribute("aria-expanded", "false");
    if (restoreFocus) toggle.focus();
  }
  function acknowledge(result, ticket, onSuccess) {
    if (disposed || ticket !== operation) return;
    busyAction = null;
    if (result?.ok !== true) showError(result?.error);
    else onSuccess?.();
    update(latest);
  }
  function dispatch(action, value, control, onSuccess) {
    if (disposed || control.disabled) return;
    if (["select", "focus"].includes(action) &&
        !people().some((person) => person.id === value)) return;
    if (action === "motion" && (!selected() || latest.environment === "vision" ||
        !MODES.some(([name]) => name === value?.mode))) return;
    const ticket = ++operation;
    busyAction = action;
    error.hidden = true;
    try {
      const result = onAction(action, value);
      if (result?.then) {
        update(latest);
        Promise.resolve(result)
          .then((ack) => acknowledge(ack, ticket, onSuccess))
          .catch((failure) => {
            if (disposed || ticket !== operation) return;
            busyAction = null;
            showError(failure?.message);
            update(latest);
          });
      } else acknowledge(result, ticket, onSuccess);
    } catch (failure) {
      if (ticket !== operation) return;
      busyAction = null;
      showError(failure?.message);
      update(latest);
    }
  }
  function close(restoreFocus = true) {
    if (disposed || panel.hidden) return;
    if (latest.focused || busyAction === "focus")
      dispatch("vehicle-view", undefined, closeButton, () => finishClose(restoreFocus));
    else finishClose(restoreFocus);
  }
  listen(toggle, "click", () => {
    if (!panel.hidden) return close();
    panel.hidden = false;
    toggle.setAttribute("aria-expanded", "true");
    update(latest);
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
  function disable(control, unavailable, reason) {
    control.disabled = Boolean(unavailable);
    control.setAttribute("aria-disabled", String(control.disabled));
    control.title = control.disabled ? reason : "";
  }
  function update(state = {}) {
    if (disposed) return;
    latest = state;
    const entries = people();
    const signature = JSON.stringify(entries.map((person) => [person.id, person.kind]));
    if (signature !== optionsKey) {
      const previous = select.value;
      const options = entries.map((person) => {
        const option = node("option", "", `${person.id} · ${readable(person.kind)}`);
        option.value = person.id;
        return option;
      });
      if (!options.length) {
        const option = node("option", "", "No people in this world");
        option.value = "";
        options.push(option);
      }
      select.replaceChildren(...options);
      if (entries.some((person) => person.id === previous)) select.value = previous;
      optionsKey = signature;
    }
    const person = selected(), inFixture = state.environment === "vision";
    if (person && busyAction !== "select") select.value = person.id;
    mode.value = MODES.some(([name]) => name === person?.motionMode) ? person.motionMode : "ambient";
    disable(select, !entries.length || busyAction !== null, "Wait for the action, or return to vehicle view.");
    disable(focus, !person || busyAction !== null, "Select a current person before following.");
    disable(vehicle, !state.focused && busyAction !== "focus", "The vehicle view is already active.");
    disable(mode, !person || inFixture || busyAction !== null, inFixture
      ? "Fixed Vision fixture: ordinary motion controls are disabled to preserve its deterministic trajectory."
      : "Select a current person and wait for pending actions.");
    mode.setAttribute("aria-busy", String(busyAction === "motion"));
    focus.setAttribute("aria-busy", String(busyAction === "focus"));
    const context = `${readable(state.environment)} · ${state.paused ? "paused" : "running"}`;
    text(status, busyAction ? `World reference · ${readable(busyAction)} pending…`
      : !entries.length ? `World reference · ${context} · no people. Return to the city or increase the pedestrian setting.`
        : state.focused ? `World reference · ${context} · following ${person?.id ?? "a removed person"}.`
          : `World reference · ${context} · vehicle view. Select and follow a person to inspect the body.`);
    status.dataset.state = !entries.length ? "empty" : state.focused ? "following" : "ready";
    text(modeNote, inFixture
      ? "Fixed Vision fixture · motion controls are locked; its established pixel experiment is unchanged."
      : "A request, not an instant speed change. Ambient resumes the existing route; actual readings below follow accepted motion.");
    text(values.actor, person ? `${person.id} / ${readable(person.kind)}` : "No selected person");
    text(values.speed, measurement(person?.speed, "m/s") +
      (finite(person?.speed) ? ` · ${(person.speed * 3.6).toFixed(1)} km/h` : ""));
    text(values.acceleration, measurement(person?.accelerationMps2, "m/s²"));
    text(values.travel, measurement(person?.distance, "m"));
    text(values.position, person && finite(person.x) && finite(person.z)
      ? `X ${person.x.toFixed(2)} m · Z ${person.z.toFixed(2)} m` : "Unavailable");
    text(values.heading, finite(person?.heading)
      ? `${person.heading.toFixed(3)} rad · ${(person.heading * 180 / Math.PI).toFixed(1)}°` : "Unavailable");
    text(values.reason, readable(person?.reason));
    const body = person?.body;
    text(note, body && [body.heightM, body.widthM, body.depthM].every(finite)
      ? `Body ${body.heightM.toFixed(2)} × ${body.widthM.toFixed(2)} × ${body.depthM.toFixed(2)} m · ` +
        `actual speed ${measurement(person.speed, "m/s")}. World reference only.`
      : "Actual game body dimensions are unavailable. World actor values are not camera estimates.");
    text(bodyValues.dimensions, body && [body.heightM, body.widthM, body.depthM].every(finite)
      ? `${body.heightM.toFixed(2)} × ${body.widthM.toFixed(2)} × ${body.depthM.toFixed(2)} m` : "Unavailable");
    text(bodyValues.mass, measurement(body?.massKg, "kg", 1));
    text(bodyValues.radius, measurement(body?.radiusM, "m"));
    text(bodyValues.walk, body && [body.walkSpeedMps, body.jogSpeedMps].every(finite)
      ? `${body.walkSpeedMps.toFixed(2)} / ${body.jogSpeedMps.toFixed(2)} m/s` : "Unavailable");
    text(bodyValues.acceleration, body && [body.maxAccelerationMps2, body.maxDecelerationMps2].every(finite)
      ? `${body.maxAccelerationMps2.toFixed(2)} / ${body.maxDecelerationMps2.toFixed(2)} m/s²` : "Unavailable");
    text(bodyValues.turn, measurement(body?.maxTurnRateRadS, "rad/s"));
  }
  update();
  return {
    update, close,
    dispose() {
      if (disposed) return;
      if (latest.focused || busyAction === "focus") {
        try {
          const result = onAction("vehicle-view");
          if (result?.then) Promise.resolve(result).catch(() => {});
        } catch { /* The coordinator also owns final display-camera cleanup. */ }
      }
      disposed = true;
      operation++;
      cleanups.forEach((cleanup) => cleanup());
      panel.remove();
      toggle.remove();
    },
  };
}
