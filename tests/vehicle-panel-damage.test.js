import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mountVehiclePanel } from "../src/ui/vehicle-panel.js";
import {
  applyLocalizedPartDamage,
  createVehicleState,
} from "../src/core/vehicle-state.js";

class Element {
  constructor(tagName, document) {
    this.tagName = tagName.toUpperCase();
    this.document = document;
    this.children = [];
    this.dataset = {};
    this.attributes = new Map();
    this.listeners = new Map();
    this.textContent = "";
    this.hidden = false;
    this.disabled = false;
  }
  append(...children) {
    for (const child of children) {
      child.parentNode = this;
      this.children.push(child);
    }
  }
  setAttribute(name, value) {
    this.attributes.set(name, value);
  }
  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }
  addEventListener(type, callback) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(callback);
  }
  removeEventListener(type, callback) {
    this.listeners.get(type)?.delete(callback);
  }
  fire(type, details = {}) {
    if (type === "click" && this.disabled) return;
    const event = { type, target: this, preventDefault() {}, ...details };
    for (let parent = this; parent; parent = parent.parentNode)
      for (const callback of parent.listeners.get(type) ?? []) callback(event);
  }
  contains(element) {
    return (
      this === element ||
      this.children.some((child) => child.contains(element))
    );
  }
  focus() {
    this.document.activeElement = this;
  }
  remove() {
    if (this.parentNode)
      this.parentNode.children = this.parentNode.children.filter(
        (child) => child !== this,
      );
    this.parentNode = null;
  }
}

const makeActor = () => ({
  id: "player",
  type: "vehicle",
  x: 0,
  z: 0,
  heading: 0,
  length: 4.2,
  width: 1.85,
  speed: 0,
  vehicle: createVehicleState(),
});

function panelFixture(t, action) {
  const savedDocument = globalThis.document;
  const document = new Element("document");
  document.document = document;
  document.createElement = (tag) => new Element(tag, document);
  document.body = document.createElement("body");
  document.append(document.body);
  globalThis.document = document;
  const toolbar = document.createElement("nav");
  document.body.append(toolbar);
  const calls = [];
  const panel = mountVehiclePanel({
    toolbar,
    onAction: (name, value) => {
      calls.push([name, value]);
      return action ? action(name, value) : { ok: true };
    },
  });
  const find = (predicate, parent = document) =>
    predicate(parent)
      ? parent
      : parent.children.map((child) => find(predicate, child)).find(Boolean);
  const byId = (id) => find((element) => element.id === id);
  t.after(() => {
    panel.dispose();
    if (savedDocument === undefined) delete globalThis.document;
    else globalThis.document = savedDocument;
  });
  return {
    panel,
    calls,
    document,
    toolbar,
    byId,
    find,
    state: {
      world: { environment: "metro", sensors: { rawM: [12, 14, 9.5, 18, 35] } },
      actor: makeActor(),
      rig: { root: {}, diagnostics: { ready: true } },
      mode: "chase",
      cutaway: false,
      sensors: false,
      sensorCamera: "front",
    },
  };
}

function relativeLuminance(hex) {
  const clean = hex.replace("#", "");
  const channels = [0, 2, 4].map((idx) => {
    const srgb = Number.parseInt(clean.slice(idx, idx + 2), 16) / 255;
    return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(fgHex, bgHex) {
  const l1 = relativeLuminance(fgHex);
  const l2 = relativeLuminance(bgHex);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

test("carPartDamage reports intact components when pristine and real damaged parts in both Metro City and Impact Bay", (t) => {
  const f = panelFixture(t);
  f.state.actor.vehicle.damage.parts = {
    hood: { damage: 0, state: "intact", unlatched: false, detached: false },
    leftHeadlamp: { damage: 0, state: "intact", shattered: false },
    radiator: { damage: 0, state: "intact", leaking: false },
  };
  f.panel.update(f.state);

  const heading = f.find(
    (el) => el.tagName === "H3" && el.textContent === "Body & parts",
  );
  assert.ok(heading, "Body & parts heading should exist in carPanel");
  const readout = f.byId("carPartDamage");
  assert.ok(readout, "#carPartDamage readout should exist");
  assert.equal(readout.className, "car-part-damage");
  assert.equal(readout.hidden, false);
  assert.equal(readout.textContent, "All panels, lamps & mounts intact");
  assert.equal(readout.getAttribute("data-damaged"), "false");
  assert.equal(readout.dataset.damaged, "false");

  // City street-pursuit crash damage
  f.state.world.environment = "metro";
  f.state.actor.vehicle.damage = {
    ...f.state.actor.vehicle.damage,
    front: 0.88,
    total: 0.88,
    parts: {
      hood: { damage: 0.94, state: "unlatched", unlatched: true, detached: true },
      leftHeadlamp: { damage: 0.86, shattered: true },
      radiator: { damage: 0.78, leaking: true },
      windshield: { damage: 0, state: "intact", cracked: false },
    },
  };
  f.panel.update(f.state);
  assert.equal(readout.hidden, false);
  assert.equal(readout.getAttribute("data-damaged"), "true");
  assert.equal(
    readout.textContent,
    "Hood detached · L headlamp shattered · Radiator leaking",
  );

  // Impact Bay heavy crash with >4 damaged parts shows count, top 4 by severity, and overflow
  f.state.world.environment = "vehicle";
  f.state.world.vehicleTest = { phase: "contact", maxSpeedMps: 50 / 3.6 };
  f.state.actor.vehicle.damage = {
    front: 0.96,
    rear: 0,
    left: 0.35,
    right: 0.2,
    total: 0.97,
    parts: {
      leftFender: { damage: 0.32, state: "dented" },
      windshield: { damage: 0.58, cracked: true },
      hood: { damage: 0.76, unlatched: true },
      bumper: { damage: 0.72, state: "unclipped", sagging: true },
      radiator: { damage: 0.81, leaking: true },
      leftHeadlamp: { damage: 0.91, shattered: true },
    },
  };
  f.panel.update(f.state);
  assert.equal(readout.hidden, false);
  assert.equal(readout.getAttribute("data-damaged"), "true");
  assert.equal(
    readout.textContent,
    "6 parts damaged · L headlamp shattered · Radiator leaking · Bumper unclipped · Hood unlatched · +2 more",
  );

  // Repair / reset restores pristine readout
  f.state.actor.vehicle = createVehicleState();
  f.panel.update(f.state);
  assert.equal(readout.textContent, "All panels, lamps & mounts intact");
  assert.equal(readout.getAttribute("data-damaged"), "false");
});

test("carPartDamage falls back to rig brokenParts and legacy side percentages truthfully", (t) => {
  const f = panelFixture(t);

  // Fallback to rig.diagnostics.damage.brokenParts when vehicle.damage.parts is absent
  f.state.actor.vehicle.damage = {
    front: 0.7,
    rear: 0,
    left: 0.4,
    right: 0,
    total: 0.82,
    impactCount: 1,
    lastImpact: null,
  };
  f.state.rig.diagnostics.damage = {
    brokenParts: ["Hood detached", "Windshield cracked", "L mirror detached"],
  };
  f.panel.update(f.state);
  const readout = f.byId("carPartDamage");
  assert.equal(readout.getAttribute("data-damaged"), "true");
  assert.match(readout.textContent, /Hood detached/);
  assert.match(readout.textContent, /L mirror detached/);
  assert.match(readout.textContent, /Windshield cracked/);

  // Legacy minimal fixture with only side dent percentages
  f.state.rig.diagnostics.damage = { total: 0.5 };
  f.state.actor.vehicle.damage = {
    front: 0.5,
    rear: 0,
    left: 0,
    right: 0,
    total: 0.5,
    impactCount: 1,
    lastImpact: null,
  };
  f.panel.update(f.state);
  assert.equal(readout.getAttribute("data-damaged"), "true");
  assert.equal(readout.textContent, "Front body dented (50%)");
});

test("carHeavyImpactBtn dispatches heavy-impact-run, enforces bay/run boundaries, and preserves 6 m/s impact-run", (t) => {
  const f = panelFixture(t);
  f.panel.update(f.state);

  const lowRun = f.byId("carImpactRunBtn");
  const heavyRun = f.byId("carHeavyImpactBtn");
  const reset = f.byId("carResetBtn");
  const status = f.byId("carTestStatus");

  assert.ok(heavyRun, "#carHeavyImpactBtn should be mounted");
  assert.equal(heavyRun.textContent, "Heavy crash (50 km/h)");
  assert.equal(lowRun.textContent, "Run impact");

  // Disabled outside Impact Bay
  assert.equal(heavyRun.disabled, true);
  assert.match(heavyRun.title, /separate impact bay/);
  heavyRun.fire("click");
  assert.equal(f.calls.length, 0);

  // Disabled in Impact Bay while rig is still loading
  f.state.world.environment = "vehicle";
  f.state.world.vehicleTest = { phase: "ready", maxSpeedMps: 6 };
  f.state.rig = null;
  f.panel.update(f.state);
  assert.equal(heavyRun.disabled, true);

  // Enabled when rig is ready and bay phase is ready
  f.state.rig = { root: {}, diagnostics: { ready: true } };
  f.panel.update(f.state);
  assert.equal(heavyRun.disabled, false);
  assert.equal(lowRun.disabled, false);

  // Clicking heavyRun dispatches ["heavy-impact-run", undefined]
  heavyRun.fire("click");
  assert.deepEqual(f.calls.at(-1), ["heavy-impact-run", undefined]);

  // During a heavy crash run (> 8 m/s), status reflects 50 km/h and buttons disable
  f.state.world.vehicleTest = { phase: "running", maxSpeedMps: 50 / 3.6 };
  f.state.actor.speed = 11.5;
  f.panel.update(f.state);
  assert.equal(heavyRun.disabled, true);
  assert.equal(lowRun.disabled, true);
  assert.equal(reset.disabled, true);
  assert.equal(
    status.textContent,
    "Driving to the fixed barrier · heavy crash 50 km/h.",
  );

  // Low-speed run (<= 8 m/s) keeps exact incumbent status text
  f.state.world.vehicleTest = { phase: "running", maxSpeedMps: 6 };
  f.panel.update(f.state);
  assert.equal(
    status.textContent,
    "Driving to the fixed barrier · maximum 6 m/s.",
  );

  // Stopped after contact: run buttons remain disabled until Repair / reset
  f.state.world.vehicleTest = { phase: "contact", maxSpeedMps: 50 / 3.6 };
  f.state.actor.speed = 0;
  f.panel.update(f.state);
  assert.equal(heavyRun.disabled, true);
  assert.equal(lowRun.disabled, true);
  assert.equal(reset.disabled, false);

  reset.fire("click");
  assert.deepEqual(f.calls.at(-1), ["reset-car", undefined]);

  // Re-enabled after reset to ready; incumbent Run impact still dispatches ["impact-run", undefined]
  f.state.world.vehicleTest = { phase: "ready", maxSpeedMps: 6 };
  f.panel.update(f.state);
  assert.equal(heavyRun.disabled, false);
  assert.equal(lowRun.disabled, false);
  lowRun.fire("click");
  assert.deepEqual(f.calls.at(-1), ["impact-run", undefined]);
});

test("vehicle.css styles car-part-damage and heavy crash controls with >= 7:1 AAA contrast", () => {
  const css = readFileSync(
    new URL("../src/ui/vehicle.css", import.meta.url),
    "utf8",
  );
  assert.match(css, /\.car-part-damage\s*\{/);
  assert.match(css, /\.car-part-damage\[data-damaged="true"\]\s*\{/);
  assert.match(css, /\.car-impact-actions\s*\{[^}]*repeat\(auto-fit/);
  assert.ok(
    contrastRatio("#eef2e9", "#212d27") >= 7,
    "Intact readout contrast must be >= 7:1",
  );
  assert.ok(
    contrastRatio("#f3c396", "#2b211d") >= 7,
    "Damaged readout contrast must be >= 7:1",
  );
  assert.ok(
    contrastRatio("#f3c396", "#362821") >= 7,
    "Heavy crash button contrast must be >= 7:1",
  );
});

test("carPartDamage integrates with live createVehicleState + applyLocalizedPartDamage frontal heavy crash", (t) => {
  const f = panelFixture(t);
  f.panel.update(f.state);
  const readout = f.byId("carPartDamage");
  assert.equal(readout.textContent, "All panels, lamps & mounts intact");

  applyLocalizedPartDamage(f.state.actor.vehicle.damage, {
    side: "front",
    closingSpeedMps: 50 / 3.6,
    energyJ: 55000,
    lateralOffsetM: -0.35,
  });
  f.state.actor.vehicle.damage.front = 1;
  f.state.actor.vehicle.damage.total = 1;
  f.panel.update(f.state);

  assert.equal(readout.getAttribute("data-damaged"), "true");
  assert.equal(
    readout.textContent,
    "7 parts damaged · Grille detached · Hood detached · L headlamp shattered · Front bumper crushed · +3 more",
  );
});
