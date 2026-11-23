import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mountPursuitStrobe } from "../src/ui/pursuit-strobe.js";
import { mountPursuitPanel } from "../src/ui/pursuit-panel.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

class MockClassList {
  constructor(owner) {
    this.owner = owner;
    this.set = new Set();
  }
  syncFromString(value) {
    this.set = new Set(String(value || "").split(/\s+/).filter(Boolean));
  }
  syncToOwner() {
    this.owner._className = [...this.set].join(" ");
  }
  add(...tokens) {
    for (const token of tokens) if (token) this.set.add(token);
    this.syncToOwner();
  }
  remove(...tokens) {
    for (const token of tokens) this.set.delete(token);
    this.syncToOwner();
  }
  toggle(token, force) {
    const next = force === undefined ? !this.set.has(token) : Boolean(force);
    if (next) this.set.add(token);
    else this.set.delete(token);
    this.syncToOwner();
    return next;
  }
  contains(token) {
    return this.set.has(token);
  }
}

class MockStyleDeclaration {
  constructor() {
    this.props = new Map();
  }
  setProperty(name, value) {
    this.props.set(name, String(value));
  }
  getPropertyValue(name) {
    return this.props.get(name) ?? "";
  }
}

class MockElement {
  constructor(tag, ownerDocument) {
    this.tagName = tag.toUpperCase();
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.parentNode = null;
    this.id = "";
    this._className = "";
    this.classList = new MockClassList(this);
    this.style = new MockStyleDeclaration();
    this.dataset = {};
    this.attributes = new Map();
    this.listeners = new Map();
    this._text = "";
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.open = false;
    this.value = "";
    this.type = "";
  }
  get className() {
    return this._className;
  }
  set className(value) {
    this._className = String(value);
    this.classList.syncFromString(this._className);
  }
  get textContent() {
    if (this.children.length === 0) return this._text;
    return this.children.map((child) => child.textContent).join("");
  }
  set textContent(value) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    this._text = String(value ?? "");
  }
  get parentElement() {
    return this.parentNode;
  }
  get lastElementChild() {
    return this.children.at(-1) ?? null;
  }
  get previousElementSibling() {
    if (!this.parentNode) return null;
    const index = this.parentNode.children.indexOf(this);
    return index > 0 ? this.parentNode.children[index - 1] : null;
  }
  detach(child) {
    if (child.parentNode) {
      child.parentNode.children = child.parentNode.children.filter((item) => item !== child);
      child.parentNode = null;
    }
  }
  append(...nodes) {
    for (const child of nodes) {
      this.detach(child);
      child.parentNode = this;
      this.children.push(child);
    }
    if (this.tagName === "SELECT" && !this.value) this.value = this.children[0]?.value ?? "";
  }
  appendChild(node) {
    this.append(node);
    return node;
  }
  prepend(...nodes) {
    const inserted = [];
    for (const child of nodes) {
      this.detach(child);
      child.parentNode = this;
      inserted.push(child);
    }
    this.children.unshift(...inserted);
  }
  insertBefore(node, reference) {
    this.detach(node);
    node.parentNode = this;
    const index = reference ? this.children.indexOf(reference) : -1;
    if (index === -1) this.children.push(node);
    else this.children.splice(index, 0, node);
    return node;
  }
  before(...nodes) {
    if (!this.parentNode) return;
    for (const node of nodes) this.parentNode.insertBefore(node, this);
  }
  replaceChildren(...nodes) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    this.value = "";
    this.append(...nodes);
  }
  remove() {
    this.detach(this);
  }
  setAttribute(key, value) {
    this.attributes.set(key, String(value));
  }
  getAttribute(key) {
    return this.attributes.get(key) ?? null;
  }
  removeAttribute(key) {
    this.attributes.delete(key);
  }
  addEventListener(type, callback) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(callback);
  }
  removeEventListener(type, callback) {
    this.listeners.get(type)?.delete(callback);
  }
  findById(id) {
    if (this.id === id) return this;
    for (const child of this.children) {
      const found = child.findById(id);
      if (found) return found;
    }
    return null;
  }
}

function createDom() {
  const doc = {
    body: null,
    createElement(tag) {
      return new MockElement(tag, doc);
    },
    getElementById(id) {
      return doc.body?.findById(id) ?? null;
    },
  };
  doc.body = doc.createElement("body");
  return doc;
}

test("mountPursuitStrobe stays hidden and off when chase is idle, disabled, stopped, or escaped", (t) => {
  const doc = createDom();
  const strobe = mountPursuitStrobe({ container: doc.body, doc });
  t.after(() => strobe.destroy());

  assert.equal(strobe.element.id, "pursuitStrobe");
  assert.equal(strobe.element.classList.contains("pursuit-strobe"), true);
  assert.equal(strobe.element.getAttribute("aria-hidden"), "true");
  assert.equal(strobe.element.hidden, true);
  assert.equal(strobe.element.dataset.mode, "off");
  assert.equal(strobe.element.children.length, 3);
  assert.equal(strobe.element.children[0].classList.contains("pursuit-strobe__red"), true);
  assert.equal(strobe.element.children[1].classList.contains("pursuit-strobe__blue"), true);
  assert.equal(strobe.element.children[2].classList.contains("pursuit-strobe__ambient"), true);

  for (const inactiveState of [
    null,
    undefined,
    {},
    { enabled: false, phase: "active", wantedLevel: 4 },
    { enabled: true, phase: "ready", wantedLevel: 3 },
    { enabled: true, phase: "stopped", wantedLevel: 2 },
    { enabled: true, phase: "escaped", wantedLevel: 0 },
    { enabled: true, phase: "escaped", wantedLevel: 2 },
    { enabled: true, phase: "active", wantedLevel: 0 },
  ]) {
    const result = strobe.update(inactiveState);
    assert.deepEqual(result, { mode: "off", intensity: 0, cycleMs: 0, blurPx: 0 });
    assert.equal(strobe.element.hidden, true);
    assert.equal(strobe.element.dataset.mode, "off");
    assert.equal(strobe.element.style.getPropertyValue("--strobe-intensity"), "0");
    assert.equal(strobe.element.style.getPropertyValue("--strobe-blur-px"), "0px");
  }

  // Re-mounting onto the same container reuses #pursuitStrobe cleanly without duplicating layers.
  const reused = mountPursuitStrobe({ container: doc.body, doc });
  assert.equal(reused.element, strobe.element);
  assert.equal(reused.element.children.length, 3);
});

test("mountPursuitStrobe transitions hot -> searching -> cooling -> hot with cinematic blur progression, intensity, and cadence", (t) => {
  const doc = createDom();
  const strobe = mountPursuitStrobe({ container: doc.body, doc });
  t.after(() => strobe.destroy());

  // 1. Hot pursuit in visual contact (52px optical blur)
  const hot = strobe.update({
    enabled: true,
    phase: "active",
    wantedLevel: 3,
    patrolStatus: { active: 3, nearestM: 18 },
    response: {
      stage: "contact",
      unitsInContact: 2,
      dispatch: { state: "VISUALLY_SPOTTED" },
    },
  });
  assert.equal(hot.mode, "hot");
  assert.equal(hot.blurPx, 52);
  assert.equal(hot.blurPx >= 48, true, `expected hot blurPx >= 48, got ${hot.blurPx}`);
  assert.equal(hot.intensity >= 0.55, true, `expected hot intensity >= 0.55, got ${hot.intensity}`);
  assert.equal(hot.cycleMs <= 520, true, `expected hot cycle <= 520ms, got ${hot.cycleMs}`);
  assert.equal(strobe.element.hidden, false);
  assert.equal(strobe.element.dataset.mode, "hot");
  assert.equal(strobe.element.dataset.wanted, "3");
  assert.equal(strobe.element.style.getPropertyValue("--strobe-intensity"), hot.intensity.toFixed(3));
  assert.equal(strobe.element.style.getPropertyValue("--strobe-cycle-ms"), `${hot.cycleMs}ms`);
  assert.equal(strobe.element.style.getPropertyValue("--strobe-blur-px"), "52px");

  // 2. Out of sight -> immediately calms to searching with wider 68px diffused glow
  const searching = strobe.update({
    enabled: true,
    phase: "active",
    wantedLevel: 3,
    patrolStatus: { active: 3, nearestM: 64 },
    response: {
      stage: "search",
      unitsInContact: 0,
      dispatch: { state: "SEARCHING", coolingDown: false },
    },
  });
  assert.equal(searching.mode, "searching");
  assert.equal(searching.blurPx, 68);
  assert.equal(searching.blurPx > hot.blurPx, true);
  assert.equal(searching.intensity < hot.intensity, true);
  assert.equal(searching.intensity <= 0.38, true, `expected searching intensity <= 0.38, got ${searching.intensity}`);
  assert.equal(searching.cycleMs >= 1000, true, `expected searching cycle >= 1000ms, got ${searching.cycleMs}`);
  assert.equal(strobe.element.dataset.mode, "searching");
  assert.equal(strobe.element.style.getPropertyValue("--strobe-blur-px"), "68px");

  // 3. Cooling down -> fades gently with ultra-soft 78px atmospheric blur as stars decay
  const cooling = strobe.update({
    enabled: true,
    phase: "active",
    wantedLevel: 2,
    response: {
      stage: "clearing",
      unitsInContact: 0,
      clearProgress: 0.45,
      dispatch: { state: "COOLING_DOWN", coolingDown: true, hiddenInCover: true, nextStarDropS: 2.1 },
    },
  });
  assert.equal(cooling.mode, "cooling");
  assert.equal(cooling.blurPx, 78);
  assert.equal(cooling.blurPx > searching.blurPx, true);
  assert.equal(cooling.intensity < searching.intensity, true);
  assert.equal(cooling.intensity <= 0.18, true, `expected cooling intensity <= 0.18, got ${cooling.intensity}`);
  assert.equal(cooling.cycleMs >= 1500, true);
  assert.equal(strobe.element.dataset.mode, "cooling");
  assert.equal(strobe.element.dataset.wanted, "2");
  assert.equal(strobe.element.style.getPropertyValue("--strobe-blur-px"), "78px");

  // 4. Re-spotted -> returns to hot pursuit (52px blur)
  const respotted = strobe.update({
    enabled: true,
    phase: "active",
    wantedLevel: 2,
    patrolStatus: { active: 2, nearestM: 14 },
    response: {
      stage: "contact",
      unitsInContact: 1,
      dispatch: { state: "VISUALLY_SPOTTED", coolingDown: false },
    },
  });
  assert.equal(respotted.mode, "hot");
  assert.equal(respotted.blurPx, 52);
  assert.equal(respotted.intensity >= 0.55, true);
  assert.equal(respotted.cycleMs <= 520, true);
  assert.equal(strobe.element.dataset.mode, "hot");
  assert.equal(strobe.element.style.getPropertyValue("--strobe-blur-px"), "52px");

  // Respects explicit finite response.strobeIntensity override and phase === "running" snapshots
  const customIntensity = strobe.update({
    phase: "running",
    wantedLevel: 4,
    response: {
      unitsInContact: 1,
      strobeIntensity: 0.845,
      dispatch: { state: "VISUALLY_SPOTTED" },
    },
  });
  assert.equal(customIntensity.mode, "hot");
  assert.equal(customIntensity.intensity, 0.845);
  assert.equal(customIntensity.blurPx, 52);

  // Escaped turns strobe completely off
  const escaped = strobe.update({
    enabled: true,
    phase: "escaped",
    wantedLevel: 0,
  });
  assert.equal(escaped.mode, "off");
  assert.equal(escaped.blurPx, 0);
  assert.equal(strobe.element.hidden, true);
  assert.equal(strobe.element.style.getPropertyValue("--strobe-blur-px"), "0px");
});

test("pursuit-panel renders GTA star-by-star cooldown spans while preserving exact wanted.textContent and cover/search guidance", (t) => {
  const doc = createDom();
  const host = doc.createElement("aside");
  doc.body.append(host);
  const panel = mountPursuitPanel({
    container: host,
    onRun: () => true,
    onRestart: () => true,
    onLevel: () => true,
  });
  t.after(() => panel.close());

  // 1. Visually spotted (3 stars, none cooling)
  panel.update({
    phase: "running",
    street: true,
    cinematic: true,
    variant: "gta",
    pako: true,
    wantedLevel: 3,
    patrolStatus: { active: 3, nearestM: 22.4 },
    response: {
      stage: "contact",
      unitsInContact: 2,
      dispatch: { state: "VISUALLY_SPOTTED", coolingDown: false, zoneIds: [] },
    },
    frozenDriver: { status: "active" },
    metrics: { survivalS: 6.2, collisions: 0 },
  });

  const wanted = host.findById("pursuitWanted");
  const phase = host.findById("pursuitPhase");
  const scene = host.findById("pursuitScene");
  const units = host.findById("pursuitUnitCount");
  const learning = host.findById("pursuitLearning");

  assert.equal(wanted.textContent, "★★★☆☆");
  assert.equal(wanted.dataset.cooling, "false");
  assert.equal(wanted.children.length, 5);
  assert.equal(wanted.children[0].classList.contains("pursuit-star--active"), true);
  assert.equal(wanted.children[1].classList.contains("pursuit-star--active"), true);
  assert.equal(wanted.children[2].classList.contains("pursuit-star--active"), true);
  assert.equal(wanted.children[2].classList.contains("pursuit-star--cooling"), false);
  assert.equal(wanted.children[3].classList.contains("pursuit-star--empty"), true);
  assert.equal(wanted.children[4].classList.contains("pursuit-star--empty"), true);
  assert.equal(phase.textContent, "Spotted");
  assert.equal(units.textContent, "3 patrols · 22 m");

  // 2. Out of sight in SEARCHING (not yet far enough / not in cover)
  panel.update({
    phase: "running",
    street: true,
    cinematic: true,
    variant: "gta",
    pako: true,
    wantedLevel: 3,
    patrolStatus: { active: 3, nearestM: 68 },
    response: {
      stage: "search",
      unitsInContact: 0,
      dispatch: {
        state: "SEARCHING",
        coolingDown: false,
        minEscapeDistanceM: 95,
        zoneIds: [],
      },
    },
    frozenDriver: { status: "active" },
    metrics: { survivalS: 10.5, collisions: 0 },
  });

  assert.equal(phase.textContent, "Searching");
  assert.equal(wanted.textContent, "★★★☆☆");
  assert.equal(wanted.dataset.cooling, "false");
  assert.equal(scene.hidden, false);
  assert.equal(scene.textContent, "Out of sight · Need >95 m or alley cover");
  assert.match(learning.textContent, /Out of sight · Need >95 m or alley cover/);

  // 3. Cooling down while hidden in alley cover (3rd star pulses with .pursuit-star--cooling)
  panel.update({
    phase: "running",
    street: true,
    cinematic: true,
    variant: "gta",
    pako: true,
    wantedLevel: 3,
    patrolStatus: { active: 3, nearestM: 54 },
    response: {
      stage: "clearing",
      unitsInContact: 0,
      clearProgress: 0.25,
      dispatch: {
        state: "COOLING_DOWN",
        coolingDown: true,
        hiddenInCover: true,
        nextStarDropS: 2.4,
        zoneIds: [],
      },
    },
    frozenDriver: { status: "active" },
    metrics: { survivalS: 13.0, collisions: 0 },
  });

  assert.equal(wanted.textContent, "★★★☆☆");
  assert.equal(wanted.dataset.cooling, "true");
  assert.equal(wanted.children[0].classList.contains("pursuit-star--active"), true);
  assert.equal(wanted.children[1].classList.contains("pursuit-star--active"), true);
  assert.equal(wanted.children[2].classList.contains("pursuit-star--cooling"), true);
  assert.equal(wanted.children[3].classList.contains("pursuit-star--empty"), true);
  assert.equal(wanted.children[4].classList.contains("pursuit-star--empty"), true);
  assert.equal(phase.textContent, "Hidden · Losing stars");
  assert.equal(scene.hidden, false);
  assert.equal(scene.textContent, "Hidden in cover · -1★ in 2.4s");
  assert.match(learning.textContent, /-1★ in 2\.4s/);

  // 4. Star drops from 3 -> 2 in open-distance cooldown (now 2nd star is .pursuit-star--cooling)
  panel.update({
    phase: "running",
    street: true,
    cinematic: true,
    variant: "gta",
    pako: true,
    mode: "manual",
    wantedLevel: 2,
    patrolStatus: { active: 3, nearestM: 112 },
    response: {
      stage: "clearing",
      unitsInContact: 0,
      clearProgress: 0.6,
      dispatch: {
        state: "COOLING_DOWN",
        coolingDown: true,
        hiddenInCover: false,
        nextStarDropS: 1.8,
        zoneIds: [],
      },
    },
    metrics: { survivalS: 16.2, collisions: 0 },
  });

  assert.equal(wanted.textContent, "★★☆☆☆");
  assert.equal(wanted.dataset.cooling, "true");
  assert.equal(wanted.children[0].classList.contains("pursuit-star--active"), true);
  assert.equal(wanted.children[1].classList.contains("pursuit-star--cooling"), true);
  assert.equal(wanted.children[2].classList.contains("pursuit-star--empty"), true);
  assert.equal(phase.textContent, "Losing stars");
  assert.equal(scene.textContent, "Out of sight · -1★ in 1.8s");
  assert.equal(learning.textContent, "You're driving · Out of sight · -1★ in 1.8s");
});

test("pursuit-panel handles LAST_KNOWN custom minEscapeDistanceM, clearing stage fallback, and plain-property DOM stubs", (t) => {
  class PlainElement {
    constructor(tag, doc) {
      this.tagName = tag.toUpperCase();
      this.ownerDocument = doc;
      this.children = [];
      this.parentNode = null;
      this.id = "";
      this._className = "";
      this.classList = new MockClassList(this);
      this.dataset = {};
      this.attributes = new Map();
      this.listeners = new Map();
      this.textContent = "";
      this.hidden = false;
      this.disabled = false;
      this.value = "";
    }
    get className() { return this._className; }
    set className(v) { this._className = String(v); this.classList.syncFromString(this._className); }
    get parentElement() { return this.parentNode; }
    get lastElementChild() { return this.children.at(-1) ?? null; }
    get previousElementSibling() {
      if (!this.parentNode) return null;
      const idx = this.parentNode.children.indexOf(this);
      return idx > 0 ? this.parentNode.children[idx - 1] : null;
    }
    detach(child) {
      if (child.parentNode) {
        child.parentNode.children = child.parentNode.children.filter((c) => c !== child);
        child.parentNode = null;
      }
    }
    append(...nodes) {
      for (const n of nodes) { this.detach(n); n.parentNode = this; this.children.push(n); }
      if (this.tagName === "SELECT" && !this.value) this.value = this.children[0]?.value ?? "";
    }
    prepend(...nodes) {
      for (const n of nodes) { this.detach(n); n.parentNode = this; }
      this.children.unshift(...nodes);
    }
    insertBefore(node, ref) {
      this.detach(node);
      node.parentNode = this;
      const i = ref ? this.children.indexOf(ref) : -1;
      if (i === -1) this.children.push(node);
      else this.children.splice(i, 0, node);
      return node;
    }
    before(...nodes) {
      if (!this.parentNode) return;
      for (const n of nodes) this.parentNode.insertBefore(n, this);
    }
    remove() { this.detach(this); }
    setAttribute(k, v) { this.attributes.set(k, String(v)); }
    getAttribute(k) { return this.attributes.get(k) ?? null; }
    removeAttribute(k) { this.attributes.delete(k); }
    addEventListener() {}
    removeEventListener() {}
  }

  const doc = { createElement: (tag) => new PlainElement(tag, doc) };
  const container = doc.createElement("div");
  const panel = mountPursuitPanel({
    container,
    onRun: () => true,
    onRestart: () => true,
    onLevel: () => true,
  });
  t.after(() => panel.close());

  const byId = (id, root = container) => {
    if (root.id === id) return root;
    for (const c of root.children) {
      const f = byId(id, c);
      if (f) return f;
    }
    return null;
  };

  panel.update({
    phase: "running",
    street: true,
    cinematic: true,
    variant: "gta",
    wantedLevel: 5,
    response: {
      stage: "search",
      unitsInContact: 0,
      dispatch: { state: "LAST_KNOWN", minEscapeDistanceM: 110, zoneIds: [] },
    },
    metrics: {},
  });

  assert.equal(byId("pursuitWanted").textContent, "★★★★★");
  assert.equal(byId("pursuitWanted").dataset.cooling, "false");
  assert.equal(byId("pursuitPhase").textContent, "Last known");
  assert.equal(byId("pursuitScene").textContent, "Out of sight · Need >110 m or alley cover");

  panel.update({
    phase: "running",
    street: true,
    cinematic: true,
    wantedLevel: 4,
    response: { stage: "clearing", clearProgress: 0.5, unitsInContact: 0 },
    metrics: {},
  });

  assert.equal(byId("pursuitWanted").textContent, "★★★★☆");
  assert.equal(byId("pursuitWanted").dataset.cooling, "true");
  assert.equal(byId("pursuitWanted").children[3].classList.contains("pursuit-star--cooling"), true);
});

test("pursuit-panel surfaces far escapeGoal destination cleanly during active Chase while preserving null/ready/escaped strings", (t) => {
  const doc = createDom();
  const host = doc.createElement("aside");
  doc.body.append(host);
  const panel = mountPursuitPanel({
    container: host,
    onRun: () => true,
    onRestart: () => true,
    onLevel: () => true,
  });
  t.after(() => panel.close());

  const scene = host.findById("pursuitScene");
  const learning = host.findById("pursuitLearning");

  // 1. Active Chase in sight with far escape sector
  panel.update({
    phase: "running",
    street: true,
    cinematic: true,
    variant: "gta",
    pako: true,
    wantedLevel: 4,
    escapeGoal: { label: "Northeast Citadel Sector", distanceM: 520.4, leg: 1 },
    patrolStatus: { active: 4, nearestM: 19.2 },
    response: {
      stage: "contact",
      unitsInContact: 2,
      dispatch: { state: "VISUALLY_SPOTTED", coolingDown: false, zoneIds: [] },
    },
    frozenDriver: { status: "active" },
    metrics: { survivalS: 5.0, collisions: 0 },
  });
  assert.equal(scene.hidden, false);
  assert.equal(scene.textContent, "Escape sector: Northeast Citadel Sector · 520 m");
  assert.equal(learning.textContent, "RL PPO · Escaping police · I takes over");

  // 2. Active Chase out of sight / cooling down combines star drop guidance + escape sector
  panel.update({
    phase: "running",
    street: true,
    cinematic: true,
    variant: "gta",
    pako: true,
    wantedLevel: 3,
    escapeGoal: { label: "Northeast Citadel Sector", distanceM: 348.7, leg: 1 },
    patrolStatus: { active: 3, nearestM: 108 },
    response: {
      stage: "clearing",
      unitsInContact: 0,
      clearProgress: 0.4,
      dispatch: {
        state: "COOLING_DOWN",
        coolingDown: true,
        hiddenInCover: false,
        nextStarDropS: 3.2,
        zoneIds: [],
      },
    },
    frozenDriver: { status: "active" },
    metrics: { survivalS: 14.0, collisions: 0 },
  });
  assert.equal(scene.hidden, false);
  assert.equal(
    scene.textContent,
    "Out of sight · -1★ in 3.2s · Escape sector: Northeast Citadel Sector · 349 m",
  );

  // 3. Metro Dispatch (non-pako showDispatch) also surfaces escapeGoal cleanly
  panel.update({
    phase: "running",
    street: true,
    cinematic: true,
    variant: "gta",
    pako: false,
    cityPursuitStyle: "dispatch",
    wantedLevel: 2,
    escapeGoal: { label: "South Harbor Terminus", distanceM: 640 },
    response: {
      stage: "contact",
      unitsInContact: 1,
      dispatch: { state: "VISUALLY_SPOTTED", coolingDown: false, zoneIds: [] },
    },
    metrics: { survivalS: 8.5, collisions: 0 },
  });
  assert.equal(
    scene.textContent,
    "One patrol has you in sight. · Escape sector: South Harbor Terminus · 640 m",
  );

  // 4. Null/absent escapeGoal and ready/escaped phases stay 100% unchanged
  panel.update({
    phase: "running",
    street: true,
    cinematic: true,
    variant: "gta",
    pako: true,
    wantedLevel: 3,
    escapeGoal: null,
    response: {
      stage: "contact",
      unitsInContact: 1,
      dispatch: { state: "VISUALLY_SPOTTED", coolingDown: false, zoneIds: [] },
    },
    frozenDriver: { status: "active" },
    metrics: { survivalS: 9.0, collisions: 0 },
  });
  assert.equal(scene.textContent, "");
  assert.equal(scene.hidden, true);

  panel.update({
    phase: "ready",
    street: true,
    cinematic: true,
    pako: true,
    checkpointReady: true,
    ppoSummary: "48 updates · 28k steps · ε = 0.20",
    escapeGoal: { label: "Northeast Citadel Sector", distanceM: 520 },
    metrics: {},
  });
  assert.equal(scene.textContent, "RL PPO drives (48 updates · 28k steps · ε = 0.20).");
});

test("styles.css layers blurred cinematic .pursuit-strobe lens wash above 3D canvas and below HUD with reduced-motion fallback", () => {
  const css = fs.readFileSync(path.resolve(__dirname, "../src/ui/styles.css"), "utf8");
  assert.match(css, /\.pursuit-strobe\s*\{[^}]*position:\s*fixed/s);
  assert.match(css, /\.pursuit-strobe\s*\{[^}]*pointer-events:\s*none/s);
  assert.match(css, /\.pursuit-strobe\s*\{[^}]*z-index:\s*1\b/s);
  assert.match(css, /\.pursuit-strobe\s*\{[^}]*transition:\s*opacity\s+480ms\s+cubic-bezier\(0\.22,\s*1,\s*0\.36,\s*1\)/s);
  assert.match(
    css,
    /\.pursuit-strobe__red,\s*\.pursuit-strobe__blue,\s*\.pursuit-strobe__ambient\s*\{[^}]*inset:\s*-12%[^}]*filter:\s*blur\(var\(--strobe-blur-px,\s*54px\)\)[^}]*mix-blend-mode:\s*screen/s,
  );
  assert.match(
    css,
    /\.pursuit-strobe\[data-mode="cooling"\][^{]*\{[^}]*filter:\s*blur\(var\(--strobe-blur-px,\s*78px\)\)\s*saturate\(0\.82\)/s,
  );
  assert.match(css, /@keyframes\s+pursuitStrobeRed\b[\s\S]*?14%[\s\S]*?21%[\s\S]*?32%[\s\S]*?scale3d\(1\.04,\s*1\.02,\s*1\)/);
  assert.match(css, /@keyframes\s+pursuitStrobeBlue\b[\s\S]*?64%[\s\S]*?71%[\s\S]*?82%[\s\S]*?scale3d\(1\.04,\s*1\.02,\s*1\)/);
  assert.match(css, /@keyframes\s+pursuitStrobeAmbient\b/);
  assert.match(css, /\.pursuit-star--cooling\b/);
  assert.match(
    css,
    /@media\s*\(\s*prefers-reduced-motion:\s*reduce\s*\)\s*\{[\s\S]*?\.pursuit-strobe__red,\s*\.pursuit-strobe__blue,\s*\.pursuit-strobe__ambient\s*\{[^}]*animation:\s*none\s*!important/s,
  );
});
