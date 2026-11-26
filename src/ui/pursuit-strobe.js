const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const BLUR_BY_MODE = Object.freeze({
  off: 0,
  hot: 52,
  searching: 68,
  cooling: 78,
});

function findById(root, id) {
  if (!root) return null;
  if (root.id === id) return root;
  for (const child of root.children ?? []) {
    const found = findById(child, id);
    if (found) return found;
  }
  return null;
}

function ensureStyleStore(element) {
  if (element.style && typeof element.style.setProperty === "function") return element.style;
  const props = new Map();
  const style = element.style ?? {};
  style.setProperty = (name, value) => {
    props.set(name, String(value));
  };
  style.getPropertyValue = (name) => props.get(name) ?? "";
  element.style = style;
  return style;
}

function hasClass(element, className) {
  if (element.classList?.contains) return element.classList.contains(className);
  return String(element.className || "").split(/\s+/).includes(className);
}

function ensureLayer(doc, parent, className) {
  for (const child of parent.children ?? []) {
    if (hasClass(child, className)) return child;
  }
  const layer = doc.createElement("div");
  layer.className = className;
  if (typeof parent.append === "function") parent.append(layer);
  else parent.appendChild(layer);
  return layer;
}

export function mountPursuitStrobe(options = {}) {
  const doc = options.doc ?? options.container?.ownerDocument ?? globalThis.document;
  const container = options.container ?? doc?.body ?? null;
  if (!doc || !container) {
    throw new TypeError("mountPursuitStrobe requires a document and container.");
  }

  let element =
    doc.getElementById?.("pursuitStrobe") ??
    container.querySelector?.("#pursuitStrobe") ??
    findById(container, "pursuitStrobe");

  if (!element) {
    element = doc.createElement("div");
    element.id = "pursuitStrobe";
    element.className = "pursuit-strobe";
    if (typeof container.append === "function") container.append(element);
    else container.appendChild(element);
  } else if (!hasClass(element, "pursuit-strobe")) {
    element.className = [element.className, "pursuit-strobe"].filter(Boolean).join(" ");
  }

  ensureLayer(doc, element, "pursuit-strobe__red");
  ensureLayer(doc, element, "pursuit-strobe__blue");
  ensureLayer(doc, element, "pursuit-strobe__ambient");

  const style = ensureStyleStore(element);
  element.hidden = true;
  element.dataset.mode = "off";
  element.setAttribute("aria-hidden", "true");
  style.setProperty("--strobe-intensity", "0");
  style.setProperty("--strobe-blur-px", "0px");
  let prevHidden = true;
  let prevMode = "off";
  let prevWanted = "";
  let prevIntensityText = "0";
  let prevCycleText = "";
  let prevBlurText = "0px";

  function update(state = null) {
    const hasEnabled = Boolean(state && typeof state === "object" && "enabled" in state);
    const isEnabled = hasEnabled ? Boolean(state.enabled) : true;
    const isActivePhase = state?.phase === "active" || state?.phase === "running";
    const active = Boolean(state && isEnabled && isActivePhase && (state?.wantedLevel ?? 0) > 0);

    if (!active) {
      if (!prevHidden) {
        element.hidden = true;
        prevHidden = true;
      }
      if (prevMode !== "off") {
        element.dataset.mode = "off";
        prevMode = "off";
      }
      if (prevIntensityText !== "0") {
        style.setProperty("--strobe-intensity", "0");
        prevIntensityText = "0";
      }
      if (prevBlurText !== "0px") {
        style.setProperty("--strobe-blur-px", "0px");
        prevBlurText = "0px";
      }
      return { mode: "off", intensity: 0, cycleMs: 0, blurPx: 0 };
    }

    const wantedLevel = clamp(Math.floor(state.wantedLevel ?? 1), 1, 5);
    const dispatchState = state.response?.dispatch?.state ?? null;
    const coolingDown = Boolean(
      state.response?.dispatch?.coolingDown ||
      dispatchState === "COOLING_DOWN" ||
      state.response?.stage === "clearing",
    );
    const unitsInContact =
      state.response?.unitsInContact ?? (dispatchState === "VISUALLY_SPOTTED" ? 1 : 0);
    const inSight = unitsInContact > 0 && !coolingDown;

    const mode = inSight ? "hot" : coolingDown ? "cooling" : "searching";

    const nearestM = state.patrolStatus?.nearestM;
    const nearBoost = Number.isFinite(nearestM) && nearestM >= 0 && nearestM < 25 ? 0.12 : 0;
    const rawIntensity = Number.isFinite(state.response?.strobeIntensity)
      ? clamp(state.response.strobeIntensity, 0, 1)
      : mode === "hot"
        ? clamp(0.62 + 0.06 * wantedLevel + nearBoost, 0.60, 1.0)
        : mode === "searching"
          ? 0.28
          : clamp(0.14 * (1 - (state.response?.clearProgress ?? 0.3)), 0.06, 0.16);

    const cycleMs = mode === "hot"
      ? Math.round(560 - 48 * wantedLevel)
      : mode === "searching"
        ? 1150
        : 1650;

    const blurPx = BLUR_BY_MODE[mode];
    const intensityText = rawIntensity.toFixed(3);
    const wantedText = String(state.wantedLevel ?? 1);
    const cycleText = `${cycleMs}ms`;
    const blurText = `${blurPx}px`;
    if (prevHidden) {
      element.hidden = false;
      prevHidden = false;
    }
    if (prevMode !== mode) {
      element.dataset.mode = mode;
      prevMode = mode;
    }
    if (prevWanted !== wantedText) {
      element.dataset.wanted = wantedText;
      prevWanted = wantedText;
    }
    if (prevIntensityText !== intensityText) {
      style.setProperty("--strobe-intensity", intensityText);
      prevIntensityText = intensityText;
    }
    if (prevCycleText !== cycleText) {
      style.setProperty("--strobe-cycle-ms", cycleText);
      prevCycleText = cycleText;
    }
    if (prevBlurText !== blurText) {
      style.setProperty("--strobe-blur-px", blurText);
      prevBlurText = blurText;
    }

    return { mode, intensity: Number(intensityText), cycleMs, blurPx };
  }

  function destroy() {
    element.hidden = true;
    element.dataset.mode = "off";
    style.setProperty("--strobe-intensity", "0");
    style.setProperty("--strobe-blur-px", "0px");
    prevHidden = true;
    prevMode = "off";
    prevWanted = "";
    prevIntensityText = "0";
    prevCycleText = "";
    prevBlurText = "0px";
    element.remove?.();
  }

  return { element, update, destroy };
}
