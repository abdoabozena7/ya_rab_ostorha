import { JETOUR_T2_ID, KING_LONG_MICROBUS_ID } from "../core/vehicle-spec.js";

const VIEWS = [
  ["chase", "Chase"],
  ["cockpit", "Cockpit"],
  ["inspection", "Inspect"],
  ["running-gear", "Running gear"],
];
const PRISTINE_PARTS_TEXT = "All panels, lamps & mounts intact";
const DEFAULT_SURFACE_TEXT = "Surface: Asphalt · Grip 100% · Level grade";
const SURFACE_SPECS = Object.freeze({
  asphalt: { label: "Asphalt", defaultGripPct: 100, flatNote: "Level grade" },
  sand: { label: "Sandy street", defaultGripPct: 62, flatNote: "Sand drag" },
  water: { label: "Standing water", defaultGripPct: 52, flatNote: "Wet traction" },
  cobble: { label: "Cobblestone", defaultGripPct: 87, flatNote: "Stone rumble" },
});
const DAMAGE_SIDES = ["front", "rear", "left", "right"];
const INTACT_STATES = new Set([
  "intact",
  "ok",
  "pristine",
  "none",
  "healthy",
  "normal",
  "ready",
  "clean",
]);
const GENERIC_STATES = new Set(["damaged", "broken", "hit", "worn"]);
const FLAG_SEVERITY = [
  ["detached", "detached", 1.0],
  ["shattered", "shattered", 0.92],
  ["leaking", "leaking", 0.86],
  ["crushed", "crushed", 0.8],
  ["crumpled", "crumpled", 0.78],
  ["unclipped", "unclipped", 0.74],
  ["unclippedLeft", "unclipped", 0.74],
  ["unclippedRight", "unclipped", 0.74],
  ["dangling", "dangling", 0.72],
  ["ajar", "ajar", 0.68],
  ["unlatched", "unlatched", 0.65],
  ["cracked", "cracked", 0.6],
  ["glassCracked", "cracked", 0.6],
  ["sagging", "sagging", 0.55],
  ["claddingLoose", "loose", 0.52],
  ["tilted", "tilted", 0.5],
  ["bent", "bent", 0.46],
  ["buckled", "buckled", 0.45],
  ["dented", "dented", 0.35],
  ["scuffed", "scuffed", 0.2],
];
const CONDITION_WEIGHTS = new Map(
  FLAG_SEVERITY.map(([, label, weight]) => [label, weight]),
);
const PART_LABELS = {
  hood: "Hood",
  bonnet: "Hood",
  bumper: "Bumper",
  "front bumper": "Front bumper",
  "bumper front": "Front bumper",
  "rear bumper": "Rear bumper",
  "bumper rear": "Rear bumper",
  "front fascia": "Front fascia",
  fascia: "Front fascia",
  grille: "Grille",
  "grille lattice": "Grille",
  "front grille": "Grille",
  radiator: "Radiator",
  cooling: "Radiator",
  coolant: "Radiator",
  windshield: "Windshield",
  windscreen: "Windshield",
  "front glass": "Windshield",
  "rear window": "Rear window",
  "rear glass": "Rear window",
  "windshield wipers": "Wipers",
  wipers: "Wipers",
  "left headlamp": "L headlamp",
  "headlamp left": "L headlamp",
  "front left headlamp": "L headlamp",
  "left headlight": "L headlamp",
  "headlight left": "L headlamp",
  "headlamp well left": "L headlamp",
  "headlamp l": "L headlamp",
  "l headlamp": "L headlamp",
  "right headlamp": "R headlamp",
  "headlamp right": "R headlamp",
  "front right headlamp": "R headlamp",
  "right headlight": "R headlamp",
  "headlight right": "R headlamp",
  "headlamp well right": "R headlamp",
  "headlamp 1": "R headlamp",
  "headlamp r": "R headlamp",
  "r headlamp": "R headlamp",
  headlamp: "Headlamp",
  "left tail lamp": "L tail lamp",
  "tail lamp left": "L tail lamp",
  "left rear lamp": "L tail lamp",
  "rear lamp left": "L tail lamp",
  "left taillight": "L tail lamp",
  "taillight left": "L tail lamp",
  "rear lamp well left": "L tail lamp",
  "l tail lamp": "L tail lamp",
  "right tail lamp": "R tail lamp",
  "tail lamp right": "R tail lamp",
  "right rear lamp": "R tail lamp",
  "rear lamp right": "R tail lamp",
  "right taillight": "R tail lamp",
  "taillight right": "R tail lamp",
  "rear lamp 1": "R tail lamp",
  "rear lamp well right": "R tail lamp",
  "r tail lamp": "R tail lamp",
  "left mirror": "L mirror",
  "mirror left": "L mirror",
  "l mirror": "L mirror",
  "right mirror": "R mirror",
  "mirror right": "R mirror",
  "r mirror": "R mirror",
  "left fender": "L fender",
  "fender left": "L fender",
  "left front fender": "L fender",
  "front left fender": "L fender",
  "right fender": "R fender",
  "fender right": "R fender",
  "right front fender": "R fender",
  "front right fender": "R fender",
  "left quarter": "L quarter",
  "quarter left": "L quarter",
  "left rear quarter": "L quarter",
  "rear left quarter": "L quarter",
  "right quarter": "R quarter",
  "quarter right": "R quarter",
  "right rear quarter": "R quarter",
  "rear right quarter": "R quarter",
  "left door": "L door",
  "left doors": "L door",
  "door left": "L door",
  "doors left": "L door",
  "right door": "R door",
  "right doors": "R door",
  "door right": "R door",
  "doors right": "R door",
  "left front door": "L front door",
  "front left door": "L front door",
  "right front door": "R front door",
  "front right door": "R front door",
  "left rear door": "L rear door",
  "rear left door": "L rear door",
  "right rear door": "R rear door",
  "rear right door": "R rear door",
  "left window": "L window",
  "left front window": "L window",
  "front left window": "L window",
  "right window": "R window",
  "right front window": "R window",
  "front right window": "R window",
  "left rear window": "L rear window",
  "rear left window": "L rear window",
  "right rear window": "R rear window",
  "rear right window": "R rear window",
  "rear hatch": "Rear hatch",
  tailgate: "Rear hatch",
  trunk: "Rear hatch",
  hatch: "Rear hatch",
  spare: "Spare carrier",
  "rear spare": "Spare carrier",
  "spare carrier": "Spare carrier",
  "spare cover": "Spare carrier",
  "spare tire": "Spare carrier",
  "spare wheel": "Spare carrier",
  "front skid": "Skid plate",
  "skid plate": "Skid plate",
  "front plate": "Front plate",
  "license plate": "Front plate",
  roof: "Roof",
  "faceted roof": "Roof",
  "roof rail": "Roof rail",
  "roof rack": "Roof rack",
  exhaust: "Exhaust",
  engine: "Engine bay",
  "transverse powerunit": "Engine bay",
  powerunit: "Engine bay",
};
const BROKEN_SUFFIX_RE =
  /^(.+?)\s+(detached|shattered|leaking|crushed|crumpled|unclipped|dangling|ajar|unlatched|cracked|sagging|tilted|bent|buckled|dented|scuffed|broken|damaged)$/i;

const finite = (value, fallback = 0) =>
  Number.isFinite(value) ? value : fallback;
const clamp01 = (value) => Math.max(0, Math.min(1, finite(value)));

function normalizePartKey(raw) {
  return String(raw ?? "")
    .trim()
    .replace(/^suv[-_\s]+/i, "")
    .replace(/--1\b/g, " left")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function formatPartName(rawKey, explicitLabel) {
  if (typeof explicitLabel === "string" && explicitLabel.trim()) {
    const mapped = PART_LABELS[normalizePartKey(explicitLabel)];
    return mapped || explicitLabel.trim();
  }
  const key = normalizePartKey(rawKey);
  if (!key) return "Body panel";
  if (PART_LABELS[key]) return PART_LABELS[key];
  if (key.startsWith("front left ")) return `FL ${key.slice(11)}`;
  if (key.startsWith("front right ")) return `FR ${key.slice(12)}`;
  if (key.startsWith("rear left ")) return `RL ${key.slice(10)}`;
  if (key.startsWith("rear right ")) return `RR ${key.slice(11)}`;
  if (key.startsWith("left ")) return `L ${key.slice(5)}`;
  if (key.startsWith("right ")) return `R ${key.slice(6)}`;
  return `${key[0].toUpperCase()}${key.slice(1)}`;
}

function describePartEntry(rawKey, entry) {
  if (entry == null || entry === false) return null;
  if (typeof entry === "number") {
    if (!Number.isFinite(entry) || entry < 0.05) return null;
    const amount = clamp01(entry);
    const condition =
      amount >= 0.75 ? "crushed" : amount >= 0.25 ? "dented" : "scuffed";
    return {
      label: formatPartName(rawKey),
      condition,
      severity: (CONDITION_WEIGHTS.get(condition) ?? 0.35) * 1.5 + amount,
    };
  }
  if (typeof entry === "string") {
    const rawState = entry.trim().toLowerCase();
    if (!rawState || INTACT_STATES.has(rawState)) return null;
    return {
      label: formatPartName(rawKey),
      condition: rawState,
      severity: (CONDITION_WEIGHTS.get(rawState) ?? 0.5) * 1.5 + 0.5,
    };
  }
  if (typeof entry !== "object") return null;
  const key = entry.id ?? entry.part ?? entry.key ?? entry.name ?? rawKey;
  const label = formatPartName(key, entry.label);
  const amount = clamp01(entry.damage ?? entry.amount ?? entry.severity);
  const rawState =
    typeof entry.state === "string"
      ? entry.state.trim().toLowerCase()
      : typeof entry.status === "string"
        ? entry.status.trim().toLowerCase()
        : "";
  const topFlag = FLAG_SEVERITY.find(([flag]) => entry[flag] === true);
  const hasState = Boolean(rawState && !INTACT_STATES.has(rawState));
  if (!topFlag && !hasState && amount < 0.05) return null;
  let condition;
  if (topFlag && topFlag[2] >= 0.85) {
    condition = topFlag[1];
  } else if (hasState && !GENERIC_STATES.has(rawState)) {
    const knownWeight = CONDITION_WEIGHTS.get(rawState);
    condition =
      knownWeight !== undefined && topFlag && topFlag[2] > knownWeight
        ? topFlag[1]
        : rawState;
  } else if (topFlag) {
    condition = topFlag[1];
  } else if (hasState) {
    condition = rawState;
  } else {
    condition =
      amount >= 0.75 ? "crushed" : amount >= 0.25 ? "dented" : "scuffed";
  }
  const weight = CONDITION_WEIGHTS.get(condition) ?? (hasState ? 0.52 : 0.3);
  return { label, condition, severity: weight * 1.5 + amount };
}

function addDamageItems(target, source) {
  if (!source || typeof source !== "object") return;
  const entries =
    source instanceof Map
      ? [...source.entries()]
      : Array.isArray(source)
        ? source.map((item, idx) => [idx, item])
        : Object.entries(source);
  for (const [key, value] of entries) {
    let described = null;
    if (Array.isArray(source) && typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed || INTACT_STATES.has(trimmed.toLowerCase())) continue;
      const match = BROKEN_SUFFIX_RE.exec(trimmed);
      if (match) {
        const condition = match[2].toLowerCase();
        described = {
          label: formatPartName(match[1]),
          condition,
          severity: (CONDITION_WEIGHTS.get(condition) ?? 0.5) * 1.5 + 0.5,
        };
      } else {
        described = {
          label: formatPartName(trimmed),
          condition: "damaged",
          severity: 0.75,
        };
      }
    } else {
      described = describePartEntry(key, value);
    }
    if (!described) continue;
    const id = described.label.toLowerCase();
    const existing = target.get(id);
    if (!existing || described.severity > existing.severity) {
      target.set(id, described);
    }
  }
}

function summarizePartDamage(vehicle, rig) {
  const damage = vehicle?.damage;
  const rigDamage = rig?.diagnostics?.damage;
  const collected = new Map();
  addDamageItems(collected, damage?.parts);
  if (collected.size === 0) {
    addDamageItems(collected, rigDamage?.parts);
    addDamageItems(collected, rigDamage?.brokenParts);
  }
  const items = [...collected.values()].sort((a, b) => b.severity - a.severity);
  const brokenCount = Math.max(
    0,
    Math.round(finite(damage?.brokenCount ?? rigDamage?.brokenCount)),
  );
  const detachedCount = Math.max(
    0,
    Math.round(finite(damage?.detachedCount ?? rigDamage?.detachedCount)),
  );
  if (items.length > 0) {
    const totalCount = Math.max(items.length, brokenCount);
    const shown = items
      .slice(0, 4)
      .map((item) => `${item.label} ${item.condition}`);
    const extra = totalCount - shown.length;
    const summary =
      totalCount >= 4
        ? `${totalCount} parts damaged · ${shown.join(" · ")}${extra > 0 ? ` · +${extra} more` : ""}`
        : shown.join(" · ");
    return { damaged: true, text: summary };
  }
  if (brokenCount > 0 || detachedCount > 0) {
    const totalCount = Math.max(brokenCount, detachedCount);
    const noun = totalCount === 1 ? "part" : "parts";
    return {
      damaged: true,
      text:
        detachedCount > 0
          ? `${totalCount} ${noun} damaged · ${detachedCount} detached`
          : `${totalCount} ${noun} damaged`,
    };
  }
  const dentedSides = DAMAGE_SIDES.map((side) => [
    side,
    Math.round(clamp01(damage?.[side]) * 100),
  ])
    .filter(([, pct]) => pct >= 1)
    .sort((a, b) => b[1] - a[1]);
  if (dentedSides.length > 0) {
    return {
      damaged: true,
      text: dentedSides
        .map(
          ([side, pct]) =>
            `${side[0].toUpperCase()}${side.slice(1)} body dented (${pct}%)`,
        )
        .join(" · "),
    };
  }
  const totalPct = Math.round(clamp01(damage?.total) * 100);
  if (totalPct >= 1) {
    return { damaged: true, text: `Body dented (${totalPct}%)` };
  }
  return { damaged: false, text: PRISTINE_PARTS_TEXT };
}

function normalizeSurfaceKind(raw) {
  const token = String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-");
  if (!token) return "asphalt";
  if (token.includes("sand") || token.includes("dust")) return "sand";
  if (
    token.includes("water") ||
    token.includes("puddle") ||
    token.includes("wet") ||
    token.includes("flood")
  ) {
    return "water";
  }
  if (
    token.includes("cobble") ||
    token.includes("stone") ||
    token.includes("paver") ||
    token.includes("brick")
  ) {
    return "cobble";
  }
  return "asphalt";
}

export function describeRoadSurface(rawSurface, actor = null) {
  const src =
    rawSurface !== undefined
      ? rawSurface
      : actor?.vehicle?.surface ?? actor?.surface ?? null;
  const rawKind =
    typeof src === "string"
      ? src
      : src?.kind ??
        src?.surfaceKind ??
        src?.type ??
        src?.surface ??
        src?.id ??
        src?.name ??
        "asphalt";
  const surface = normalizeSurfaceKind(rawKind);
  const spec = SURFACE_SPECS[surface] ?? SURFACE_SPECS.asphalt;

  let gripPct = spec.defaultGripPct;
  if (src && typeof src === "object") {
    if (Number.isFinite(src.gripPct)) {
      gripPct = Math.round(Math.max(0, Math.min(150, src.gripPct)));
    } else {
      const rawGrip =
        src.grip ??
        src.gripMultiplier ??
        src.gripFactor ??
        src.traction ??
        src.friction ??
        src.mu;
      if (Number.isFinite(rawGrip)) {
        gripPct = Math.round(
          Math.max(0, rawGrip > 1.5 ? rawGrip : rawGrip * 100),
        );
      }
    }
  }

  let gradePct = 0;
  if (src && typeof src === "object") {
    if (Number.isFinite(src.gradePct)) {
      gradePct = src.gradePct;
    } else if (Number.isFinite(src.slopePct)) {
      gradePct = src.slopePct;
    } else if (Number.isFinite(src.gradeSin)) {
      gradePct = src.gradeSin * 100;
    } else if (Number.isFinite(src.pitchRad)) {
      gradePct = Math.tan(src.pitchRad) * 100;
    } else if (Number.isFinite(src.slopeRad)) {
      gradePct = Math.tan(src.slopeRad) * 100;
    } else if (Number.isFinite(src.grade)) {
      gradePct =
        Math.abs(src.grade) > 0 && Math.abs(src.grade) <= 0.65
          ? src.grade * 100
          : src.grade;
    } else if (Number.isFinite(src.slope)) {
      gradePct =
        Math.abs(src.slope) > 0 && Math.abs(src.slope) <= 0.65
          ? src.slope * 100
          : src.slope;
    } else if (Number.isFinite(actor?.gradePct)) {
      gradePct = actor.gradePct;
    }
  } else if (Number.isFinite(actor?.gradePct)) {
    gradePct = actor.gradePct;
  }

  const sloped = Math.abs(gradePct) >= 1.0;
  const gradeNote = sloped
    ? gradePct > 0
      ? `Uphill +${gradePct.toFixed(1)}%`
      : `Downhill -${Math.abs(gradePct).toFixed(1)}%`
    : spec.flatNote;
  const fullText = `Surface: ${spec.label} · Grip ${gripPct}% · ${gradeNote}`;
  const compactText = sloped
    ? `${spec.label} · Grip ${gripPct}% · ${gradeNote}`
    : `${spec.label} · Grip ${gripPct}%`;

  return {
    surface,
    label: spec.label,
    gripPct,
    gradePct,
    gradeNote,
    text: fullText,
    compactText,
    isNotable: surface !== "asphalt" || gripPct <= 95 || sloped,
  };
}

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
  const vehicleLabel = node("label", "car-camera-select");
  vehicleLabel.append(node("span", "", "Player vehicle"));
  const vehicleSelect = node("select");
  vehicleSelect.id = "playerVehicleSelect";
  vehicleSelect.setAttribute("aria-describedby", "playerVehicleHint");
  for (const [value, label] of [[JETOUR_T2_ID, "Jetour T2 · SUV"], [KING_LONG_MICROBUS_ID, "King Long · Microbus"]]) {
    const option = node("option", "", label);
    option.value = value;
    vehicleSelect.append(option);
  }
  vehicleLabel.append(vehicleSelect);
  const vehicleHint = node("p", "car-panel-note");
  vehicleHint.id = "playerVehicleHint";
  listen(vehicleSelect, "change", () =>
    dispatch("player-vehicle", vehicleSelect.value, vehicleSelect));
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
  const surfaceStatus = node("p", "car-surface-status", DEFAULT_SURFACE_TEXT);
  surfaceStatus.id = "carSurfaceStatus";
  surfaceStatus.dataset.surface = "asphalt";
  surfaceStatus.setAttribute("data-surface", "asphalt");
  telemetry.append(telemetryReading, telemetryPosition, surfaceStatus);
  const damageSection = node("section", "car-damage-status");
  const damageHeading = node("h3", "", "Body & parts");
  const partDamage = node("p", "car-part-damage", PRISTINE_PARTS_TEXT);
  partDamage.id = "carPartDamage";
  partDamage.dataset.damaged = "false";
  partDamage.setAttribute("data-damaged", "false");
  damageSection.append(damageHeading, partDamage);
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
  const heavyRunButton = button(
    "carHeavyImpactBtn",
    "Heavy crash (50 km/h)",
    "heavy-impact-run",
  );
  const resetButton = button("carResetBtn", "Repair / reset", "reset-car");
  runButton.setAttribute("aria-describedby", "carTestStatus");
  heavyRunButton.setAttribute("aria-describedby", "carTestStatus");
  resetButton.setAttribute("aria-describedby", "carTestStatus");
  const returnButton = button(
    "carReturnBtn",
    "Return to city",
    "return-city",
  );
  impactActions.append(runButton, heavyRunButton, resetButton);
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
    vehicleLabel,
    vehicleHint,
    error,
    viewGroup,
    driveInfo,
    options,
    cameraLabel,
    sensorTitle,
    ranges,
    auxTitle,
    auxiliary,
    telemetry,
    damageSection,
    impactSection,
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
    error.hidden = true;
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
    const inMetro = world?.environment === "metro";
    const onMicrobus = actor?.vehicleModel === KING_LONG_MICROBUS_ID;
    const pursuitActive = world?.pursuit?.phase === "running" || Boolean(world?.pursuit?.reviewUntilTick);
    vehicleLabel.hidden = vehicleHint.hidden = !inMetro;
    vehicleSelect.value = onMicrobus ? KING_LONG_MICROBUS_ID : JETOUR_T2_ID;
    disabled(vehicleSelect, !loaded || !inMetro || pursuitActive,
      pursuitActive ? "End Chase before changing vehicle." : loadingReason);
    text(vehicleHint, pursuitActive ? "End Chase before changing vehicles."
      : stopped ? "Switch vehicles in place on a clear street." : "Stop in a clear spot before switching.");
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
    const surfaceReport = describeRoadSurface(
      state.surface ?? vehicle?.surface ?? actor?.surface ?? world?.surface,
      actor,
    );
    surfaceStatus.dataset.surface = surfaceReport.surface;
    surfaceStatus.setAttribute("data-surface", surfaceReport.surface);
    text(surfaceStatus, surfaceReport.text);
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
    disabled(
      heavyRunButton,
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
    const heavyRun = running && finite(world?.vehicleTest?.maxSpeedMps) > 8;
    text(
      impactStatus,
      !inBay
        ? "A separate empty road. Your city is preserved."
        : !knownPhase
          ? "Impact fixture unavailable. Return to city and reopen the bay."
        : running
          ? heavyRun
            ? "Driving to the fixed barrier · heavy crash 50 km/h."
            : "Driving to the fixed barrier · maximum 6 m/s."
          : phase === "contact"
            ? "Contact recorded. The stopped car is ready to inspect or repair."
            : "Ready · one real low-speed contact, no traffic or pedestrians.",
    );
    const partReport = summarizePartDamage(vehicle, rig);
    const damagedFlag = String(partReport.damaged);
    partDamage.dataset.damaged = damagedFlag;
    partDamage.setAttribute("data-damaged", damagedFlag);
    text(partDamage, partReport.text);
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
        ? onMicrobus ? "King Long microbus · left-hand cockpit" : "Faceted SUV · left-hand cockpit"
        : "Preparing the player vehicle…",
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
