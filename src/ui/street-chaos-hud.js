const INTENSITY_LABELS = Object.freeze({
  normal: "Normal",
  rush: "Rush Hour",
  max: "Cairo Max",
});
const HAZARD_LABELS = Object.freeze({
  ghorz: "Ghorz cut-in",
  "lane-change": "Lane cut",
  accident: "Accident ahead",
});
const REACTIONS = Object.freeze({
  cruising: ["Cruising", "safe"],
  "evasive-shift": ["Evasive Shift", "evasive"],
  "accident-bypass": ["Accident Bypass", "evasive"],
  "defensive-brake": ["Defensive Brake", "brake"],
  "defensive-yield": ["Yielding", "brake"],
  "junction-hold": ["Junction Hold", "caution"],
  "no-route": ["Rerouting", "caution"],
  "emergency-brake": ["Emergency Brake", "emergency"],
});
const NOTICE_DEFAULTS = Object.freeze({
  pending: "Waiting for clear straight road\u2026",
  rejected: "Accident already active",
  expired: "Try on a wide road away from a junction",
});

const token = (value, fallback = "") =>
  String(value ?? fallback).trim().toLowerCase().replaceAll("_", "-");

export function formatCairoChaosHud(snapshot = null) {
  const state = snapshot && typeof snapshot === "object" ? snapshot : {};
  const active = Boolean(state.active);
  const intensity = Object.hasOwn(INTENSITY_LABELS, state.intensity) ? state.intensity : "rush";
  const driverMode = state.driverMode === "manual" ? "manual" : "auto";
  const hazardRaw = state.activeHazard;
  const hazardKind = token(hazardRaw && typeof hazardRaw === "object"
    ? hazardRaw.kind ?? hazardRaw.type ?? hazardRaw.state : hazardRaw);
  const hazardLabel = HAZARD_LABELS[hazardKind] ?? (hazardKind ? "Traffic hazard" : "Road watch");
  const raw = state.egoReaction;
  const reactionKind = driverMode === "manual" ? "manual" : token(raw && typeof raw === "object"
    ? (raw.reaction ?? raw.kind ?? raw.type ?? raw.state) : raw, "cruising");
  const [reactionLabel, reactionTone] = driverMode === "manual"
    ? ["Manual control", "neutral"]
    : REACTIONS[reactionKind] ?? REACTIONS.cruising;
  const reactionDetail = driverMode === "manual"
    ? "Manual control"
    : String(raw?.reasonDetail ?? reactionLabel);
  const request = state.request && typeof state.request === "object" ? state.request : null;
  const noticeStatus = token(request?.status ?? request?.phase);
  const noticeActive = Object.hasOwn(NOTICE_DEFAULTS, noticeStatus);
  const rawNotice = noticeActive
    ? String(request?.message ?? request?.reasonDetail ?? request?.reason ?? "")
    : "";
  const cleanNotice = rawNotice.replace(/\b(?:street-chaos|chaos)-event-\d+\b/gi, "")
    .replace(/[|:?-]\s*$/, "").replace(/\s{2,}/g, " ").trim();
  const noticeText = noticeActive ? cleanNotice || NOTICE_DEFAULTS[noticeStatus] : "";
  const metrics = state.metrics ?? {};
  const truckCount = Number.isFinite(state.truckCount) ? state.truckCount : 0;
  const avoided = Number.isFinite(metrics.nearMissesAvoided) ? metrics.nearMissesAvoided : 0;
  const contacts = Number.isFinite(metrics.collisions) ? metrics.collisions : 0;
  return {
    active,
    intensity,
    intensityLabel: INTENSITY_LABELS[intensity],
    driverMode,
    driverLabel: driverMode === "manual" ? "Manual" : "Defensive AI",
    hazardKind,
    hazardLabel,
    hazardActive: Boolean(hazardKind),
    reactionKind,
    reactionLabel,
    reactionTone,
    reactionDetail,
    noticeActive,
    noticeStatus,
    noticeText,
    noticeKey: noticeActive ? `${request?.id ?? "request"}|${noticeStatus}|${noticeText}` : "",
    statsText: `Trucks ${truckCount} \u00b7 Avoided ${avoided} \u00b7 Contacts ${contacts}`,
  };
}

const setText = (element, value) => {
  const text = String(value);
  if (element && element.textContent !== text) element.textContent = text;
};
const setAttr = (element, name, value) => {
  const text = String(value);
  if (element && element.getAttribute?.(name) !== text) element.setAttribute(name, text);
};
const setClass = (element, value) => {
  if (element && element.className !== value) element.className = value;
};
const setHidden = (element, value) => {
  const hidden = Boolean(value);
  if (element && element.hidden !== hidden) element.hidden = hidden;
};

export function mountStreetChaosHud(elements, handlers = {}) {
  if (!elements) throw new TypeError("mountStreetChaosHud requires HUD elements.");
  const e = elements;
  const now = typeof handlers.now === "function" ? handlers.now : () => performance.now();
  let current = formatCairoChaosHud(null);
  let noticeKey = "", noticeUntil = 0;

  if (e.intensity) e.intensity.onchange = event => handlers.onIntensity?.(event.currentTarget.value);
  if (e.driver) e.driver.onclick = () => handlers.onDriverMode?.(current.driverMode === "manual" ? "auto" : "manual");
  if (e.ghorz) e.ghorz.onclick = () => handlers.onEvent?.("ghorz");
  if (e.lane) e.lane.onclick = () => handlers.onEvent?.("lane-change");
  if (e.accident) e.accident.onclick = () => handlers.onEvent?.("accident");
  if (e.stop) e.stop.onclick = () => handlers.onStop?.();

  function update(snapshot = null) {
    const next = formatCairoChaosHud(snapshot);
    current = next;
    setHidden(e.bar, !next.active);
    setAttr(e.button, "aria-expanded", next.active);
    setAttr(e.driver, "aria-pressed", next.driverMode === "manual");
    setAttr(e.reaction, "title", next.reactionDetail);
    setAttr(e.reaction, "aria-label", next.reactionDetail);
    if (e.intensity && e.intensity.value !== next.intensity) e.intensity.value = next.intensity;
    if (e.bar?.dataset && e.bar.dataset.intensity !== next.intensity) e.bar.dataset.intensity = next.intensity;
    setText(e.driver, next.driverLabel);
    setText(e.hazard, next.hazardLabel);
    setText(e.reaction, next.reactionLabel);
    setText(e.stats, next.statsText);
    setClass(e.hazard, `chaos-status chaos-status--hazard${next.hazardActive ? " is-active" : ""}`);
    setClass(e.reaction, `chaos-status chaos-status--reaction chaos-status--${next.reactionTone}`);
    if (!next.noticeActive) {
      noticeKey = "";
      noticeUntil = 0;
      setHidden(e.notice, true);
    } else {
      if (next.noticeKey !== noticeKey) {
        noticeKey = next.noticeKey;
        noticeUntil = now() + 4000;
      }
      const visible = now() < noticeUntil;
      setHidden(e.notice, !visible);
      if (visible) {
        setText(e.notice, next.noticeText);
        setClass(e.notice, `chaos-notice chaos-notice--${next.noticeStatus}`);
      }
    }
    return next;
  }

  update(null);
  return { update, format: () => current };
}
