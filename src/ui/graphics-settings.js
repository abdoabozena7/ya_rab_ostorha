export const GRAPHICS_STORAGE_KEY = "ya-rab-metro-graphics-v1";

const balanced = Object.freeze({
  renderScale: 100,
  reflections: "environment",
  detail: "fine",
  color: "natural",
  exposure: 100,
  lensEffects: false,
  edgeSmoothing: false,
});
const presets = Object.freeze({
  performance: Object.freeze({ ...balanced, renderScale: 67, detail: "standard" }),
  balanced,
  ultra: Object.freeze({ ...balanced, renderScale: 125, reflections: "live", edgeSmoothing: true }),
});

export function graphicsPreset(preset, lowPower) {
  if (preset === "auto") {
    return { ...balanced, preset, renderScale: lowPower ? 83 : balanced.renderScale };
  }
  if (!Object.hasOwn(presets, preset)) throw new RangeError(`Unknown graphics preset: ${preset}`);
  return { ...presets[preset], preset };
}

function isIntegerInRange(value, min, max) {
  return Number.isInteger(value) && value >= min && value <= max;
}

export function decodeGraphicsSettings(raw, lowPower) {
  if (raw === null) return graphicsPreset("auto", lowPower);
  const saved = JSON.parse(raw);
  if (!saved || typeof saved !== "object" || typeof saved.preset !== "string") {
    throw new TypeError("Invalid graphics settings");
  }
  if (saved.preset !== "custom") return graphicsPreset(saved.preset, lowPower);
  const { preset, renderScale, reflections, detail, color, exposure, lensEffects, edgeSmoothing = false } = saved;
  if (!isIntegerInRange(renderScale, 50, 150) || !isIntegerInRange(exposure, 70, 130) ||
      !["environment", "live"].includes(reflections) || !["standard", "fine"].includes(detail) ||
      !["natural", "cinematic"].includes(color) || typeof lensEffects !== "boolean" ||
      typeof edgeSmoothing !== "boolean") {
    throw new RangeError("Invalid custom graphics settings");
  }
  return { preset, renderScale, reflections, detail, color, exposure, lensEffects, edgeSmoothing };
}

export function mountGraphicsSettings(doc, { lowPower, supportsLiveReflections, onChange }) {
  const byId = id => doc.getElementById(id);
  const root = byId("graphicsSettings");
  const quality = byId("graphicsPreset");
  const renderScale = byId("graphicsScale");
  const reflections = byId("graphicsReflections");
  const detail = byId("graphicsDetail");
  const color = byId("graphicsColor");
  const exposure = byId("graphicsExposure");
  const lensEffects = byId("graphicsLens");
  const edgeSmoothing = byId("graphicsEdgeSmoothing");
  const status = byId("graphicsStatus");
  const note = byId("graphicsReflectionNote");
  const reflectionOption = reflections.querySelector('option[value="live"]');
  reflectionOption.disabled = !supportsLiveReflections;
  note.hidden = supportsLiveReflections;
  let settings = graphicsPreset("auto", lowPower);
  let raw = null;
  let canSave = true;
  try {
    raw = doc.defaultView.localStorage.getItem(GRAPHICS_STORAGE_KEY);
  } catch (error) {
    if (!(error instanceof doc.defaultView.DOMException) || error.name !== "SecurityError") throw error;
    canSave = false;
    status.textContent = "Graphics storage is unavailable. Changes apply for this visit.";
  }
  if (raw !== null) {
    try {
      settings = decodeGraphicsSettings(raw, lowPower);
    } catch (error) {
      if (!(error instanceof SyntaxError || error instanceof TypeError || error instanceof RangeError)) throw error;
      status.textContent = "Saved graphics settings were invalid. Using Auto.";
    }
  }

  function sync() {
    quality.value = settings.preset;
    byId("graphicsSummaryValue").textContent = quality.selectedOptions[0].textContent;
    renderScale.value = settings.renderScale;
    byId("graphicsScaleValue").textContent = `${settings.renderScale}%`;
    reflections.value = supportsLiveReflections ? settings.reflections : "environment";
    detail.value = settings.detail;
    color.value = settings.color;
    exposure.value = settings.exposure;
    byId("graphicsExposureValue").textContent = `${settings.exposure}%`;
    lensEffects.checked = settings.lensEffects;
    edgeSmoothing.checked = settings.edgeSmoothing;
  }

  function save() {
    if (!canSave) return;
    try {
      const saved = settings.preset === "custom" ? settings : { preset: settings.preset };
      doc.defaultView.localStorage.setItem(GRAPHICS_STORAGE_KEY, JSON.stringify(saved));
      status.textContent = "";
    } catch (error) {
      if (!(error instanceof doc.defaultView.DOMException) ||
          !["SecurityError", "QuotaExceededError"].includes(error.name)) throw error;
      status.textContent = "Graphics storage is unavailable. Changes apply for this visit.";
    }
  }

  function apply(next, persist) {
    const previous = settings;
    settings = next;
    sync();
    onChange(settings, previous);
    if (persist) save();
  }
  function edit(name, value, persist = true) {
    if (settings[name] !== value) apply({ ...settings, preset: "custom", [name]: value }, persist);
  }

  quality.addEventListener("change", () => apply(graphicsPreset(quality.value, lowPower), true));
  for (const [field, input] of [["reflections", reflections], ["detail", detail], ["color", color]]) {
    input.addEventListener("change", () => edit(field, input.value));
  }
  for (const [field, input] of [["renderScale", renderScale], ["exposure", exposure]]) {
    input.addEventListener("input", () => edit(field, input.valueAsNumber, false));
    input.addEventListener("change", () => {
      edit(field, input.valueAsNumber, false);
      save();
    });
  }
  lensEffects.addEventListener("change", () => edit("lensEffects", lensEffects.checked));
  edgeSmoothing.addEventListener("change", () => edit("edgeSmoothing", edgeSmoothing.checked));
  byId("graphicsReset").addEventListener("click", () => apply(graphicsPreset("auto", lowPower), true));
  sync();

  return {
    get value() { return settings; },
    show(visible) { root.hidden = !visible; },
  };
}
