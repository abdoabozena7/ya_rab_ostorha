import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPursuitPanel,
  mountPursuitPanel,
  resolveNitroHudState,
} from "../src/ui/pursuit-panel.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

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
    this.width = "";
  }
  setProperty(name, value) {
    const str = String(value);
    this.props.set(name, str);
    if (name === "width") this.width = str;
  }
  getPropertyValue(name) {
    if (this.props.has(name)) return this.props.get(name);
    return name === "width" ? this.width : "";
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
    for (const child of nodes) {
      this.detach(child);
      child.parentNode = this;
    }
    this.children.unshift(...nodes);
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
    const str = String(value);
    this.attributes.set(key, str);
    if (key.startsWith("data-")) {
      const camel = key
        .slice(5)
        .replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
      this.dataset[camel] = str;
    }
  }
  getAttribute(key) {
    return this.attributes.get(key) ?? null;
  }
  removeAttribute(key) {
    this.attributes.delete(key);
    if (key.startsWith("data-")) {
      const camel = key
        .slice(5)
        .replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
      delete this.dataset[camel];
    }
  }
  addEventListener(type, callback) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(callback);
  }
  removeEventListener(type, callback) {
    this.listeners.get(type)?.delete(callback);
  }
  dispatchEvent(event) {
    const handlers = [...(this.listeners.get(event.type) ?? [])];
    for (const fn of handlers) fn(event);
    return true;
  }
  click() {
    if (this.disabled) return;
    this.dispatchEvent({ type: "click", target: this });
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

function createChaseDom({ withPrebuiltChaseBar = true } = {}) {
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
  const panelHost = doc.createElement("aside");
  panelHost.id = "pursuitPanelHost";
  panelHost.hidden = true;
  doc.body.append(panelHost);

  if (withPrebuiltChaseBar) {
    const chaseBar = doc.createElement("section");
    chaseBar.id = "chaseBar";
    chaseBar.className = "chase-bar";
    chaseBar.hidden = true;

    const chaseStars = doc.createElement("span");
    chaseStars.id = "chaseStars";
    chaseStars.className = "chase-bar__stars";
    chaseStars.textContent = "☆☆☆☆☆";

    const chaseStatusText = doc.createElement("span");
    chaseStatusText.id = "chaseStatusText";
    chaseStatusText.className = "chase-bar__status";
    chaseStatusText.textContent = "In pursuit";

    const chaseNitroMeter = doc.createElement("div");
    chaseNitroMeter.id = "chaseNitroMeter";
    chaseNitroMeter.className = "chase-nitro";
    chaseNitroMeter.setAttribute("data-nitro-state", "ready");

    const chaseNitroLabel = doc.createElement("span");
    chaseNitroLabel.id = "chaseNitroLabel";
    chaseNitroLabel.className = "chase-nitro__label";
    chaseNitroLabel.textContent = "NITRO";

    const track = doc.createElement("div");
    track.className = "chase-nitro__track";
    const chaseNitroFill = doc.createElement("div");
    chaseNitroFill.id = "chaseNitroFill";
    chaseNitroFill.className = "chase-nitro__fill";
    chaseNitroFill.setAttribute("role", "progressbar");
    chaseNitroFill.setAttribute("aria-valuemin", "0");
    chaseNitroFill.setAttribute("aria-valuemax", "100");
    chaseNitroFill.setAttribute("aria-valuenow", "100");
    chaseNitroFill.style.setProperty("width", "100%");
    track.append(chaseNitroFill);
    chaseNitroMeter.append(chaseNitroLabel, track);

    const spawnCrowdAheadBtn = doc.createElement("button");
    spawnCrowdAheadBtn.id = "spawnCrowdAheadBtn";
    spawnCrowdAheadBtn.className = "chase-bar__crowd-btn";
    spawnCrowdAheadBtn.type = "button";
    spawnCrowdAheadBtn.textContent = "+20 Pedestrians Ahead";

    const stopChaseBtn = doc.createElement("button");
    stopChaseBtn.id = "stopChaseBtn";
    stopChaseBtn.className = "chase-bar__stop-btn";
    stopChaseBtn.type = "button";
    stopChaseBtn.textContent = "End chase";

    chaseBar.append(
      chaseStars,
      chaseStatusText,
      chaseNitroMeter,
      spawnCrowdAheadBtn,
      stopChaseBtn,
    );
    doc.body.append(chaseBar);
  }

  const touchControls = doc.createElement("div");
  touchControls.id = "touchControls";
  const pursuitTouch = doc.createElement("div");
  pursuitTouch.id = "pursuitTouch";
  const touchNitro = doc.createElement("button");
  touchNitro.id = "touchNitro";
  touchNitro.type = "button";
  touchNitro.setAttribute("aria-label", "Nitro Boost");
  touchNitro.textContent = "NITRO";
  pursuitTouch.append(touchNitro);
  touchControls.append(pursuitTouch);
  doc.body.append(touchControls);

  return { doc, panelHost };
}

test("index.html includes #chaseBar crowd spawn button, Nitro meter progressbar, and #touchNitro in #touchControls", () => {
  const html = fs.readFileSync(path.join(repoRoot, "index.html"), "utf8");

  for (const requiredId of [
    "chaseBar",
    "chaseStars",
    "chaseStatusText",
    "chaseNitroMeter",
    "chaseNitroLabel",
    "chaseNitroFill",
    "spawnCrowdAheadBtn",
    "stopChaseBtn",
    "touchControls",
    "touchNitro",
  ]) {
    assert.match(
      html,
      new RegExp(`id="${requiredId}"`),
      `expected #${requiredId} in index.html`,
    );
  }

  // Verify #chaseBar horizontal strip ordering: stars -> status -> nitro -> crowd button -> stop button
  const chaseBarMatch = html.match(/<section[^>]*id="chaseBar"[\s\S]*?<\/section>/);
  assert.ok(chaseBarMatch, "expected <section id=\"chaseBar\">...</section> in index.html");
  const barHtml = chaseBarMatch[0];
  const idxStars = barHtml.indexOf('id="chaseStars"');
  const idxStatus = barHtml.indexOf('id="chaseStatusText"');
  const idxNitro = barHtml.indexOf('id="chaseNitroMeter"');
  const idxCrowd = barHtml.indexOf('id="spawnCrowdAheadBtn"');
  const idxStop = barHtml.indexOf('id="stopChaseBtn"');
  assert.ok(idxStars >= 0 && idxStars < idxStatus, "expected #chaseStars before #chaseStatusText");
  assert.ok(idxStatus < idxNitro, "expected #chaseStatusText before #chaseNitroMeter");
  assert.ok(idxNitro < idxCrowd, "expected #chaseNitroMeter before #spawnCrowdAheadBtn");
  assert.ok(idxCrowd < idxStop, "expected #spawnCrowdAheadBtn before #stopChaseBtn");

  // Verify exact crowd button accessibility & text
  assert.match(
    barHtml,
    /<button[^>]*id="spawnCrowdAheadBtn"[^>]*class="chase-bar__crowd-btn"[^>]*type="button"[^>]*title="Spawn 20 random walking pedestrians ahead of the car \(G\)"[^>]*aria-label="Spawn 20 walking pedestrians ahead"[^>]*>\+20 Pedestrians Ahead<\/button>/,
  );

  // Verify Nitro progressbar ARIA semantics
  assert.match(barHtml, /id="chaseNitroMeter"[^>]*data-nitro-state="ready"/);
  assert.match(barHtml, /id="chaseNitroLabel"[^>]*>NITRO<\/span>/);
  assert.match(barHtml, /id="chaseNitroFill"[\s\S]*?role="progressbar"/);
  assert.match(barHtml, /id="chaseNitroFill"[\s\S]*?aria-valuemin="0"/);
  assert.match(barHtml, /id="chaseNitroFill"[\s\S]*?aria-valuemax="100"/);
  assert.match(barHtml, /id="chaseNitroFill"[\s\S]*?aria-valuenow="100"/);

  // Verify #touchNitro inside #touchControls next to brake / throttle controls
  const touchMatch = html.match(/<div[^>]*id="touchControls"[\s\S]*?<\/div>\s*<\/div>/);
  assert.ok(touchMatch, "expected #touchControls block in index.html");
  assert.match(
    touchMatch[0],
    /<button[^>]*id="touchNitro"[^>]*type="button"[^>]*aria-label="Nitro Boost"[^>]*>NITRO<\/button>/,
  );
});

test("clicking #spawnCrowdAheadBtn fires onSpawnCrowdAhead({ count: 20 }) and shows 1.8s confirmation state", (t) => {
  const { doc, panelHost } = createChaseDom();
  let fakeNowMs = 10_000;
  const calls = [];
  let stopCalls = 0;

  const panel = createPursuitPanel({
    container: panelHost,
    doc,
    now: () => fakeNowMs,
    crowdSpawnFeedbackMs: 1800,
    onSpawnCrowdAhead: (payload) => {
      calls.push(payload);
    },
    onStopChase: () => {
      stopCalls += 1;
    },
  });
  t.after(() => panel.close());

  const chaseBar = doc.getElementById("chaseBar");
  const crowdBtn = doc.getElementById("spawnCrowdAheadBtn");
  const stopBtn = doc.getElementById("stopChaseBtn");

  assert.equal(chaseBar.hidden, true);
  assert.equal(crowdBtn.textContent, "+20 Pedestrians Ahead");
  assert.equal(crowdBtn.dataset.justSpawned, undefined);

  // Activate chase -> #chaseBar becomes visible
  panel.update({
    phase: "running",
    street: true,
    cinematic: true,
    pako: true,
    wantedLevel: 3,
    patrolStatus: { active: 3, nearestM: 28 },
    response: {
      stage: "contact",
      unitsInContact: 2,
      dispatch: { state: "VISUALLY_SPOTTED", coolingDown: false, zoneIds: [] },
    },
  });
  assert.equal(chaseBar.hidden, false);
  assert.equal(doc.getElementById("chaseStars").textContent, "★★★☆☆");

  // Click "+20 Pedestrians Ahead"
  crowdBtn.click();
  assert.deepEqual(calls, [{ count: 20 }]);
  assert.equal(crowdBtn.dataset.justSpawned, "true");
  assert.equal(crowdBtn.getAttribute("data-just-spawned"), "true");
  assert.equal(crowdBtn.textContent, "20 Walking Ahead!");

  // Mid-window 60 FPS HUD sync at +600ms preserves confirmation state
  fakeNowMs += 600;
  panel.render({
    pursuit: { phase: "running", wantedLevel: 3, crowdAheadCount: 20 },
    player: { nitroCharge: 0.9, nitroActive: false },
  });
  assert.equal(crowdBtn.dataset.justSpawned, "true");
  assert.equal(crowdBtn.textContent, "20 Walking Ahead!");

  // After 1.8s confirmation window expires, button transitions to active crowdAheadCount badge
  fakeNowMs += 1300;
  panel.render({
    pursuit: { phase: "running", wantedLevel: 3, crowdAheadCount: 14 },
    player: { nitroCharge: 0.9, nitroActive: false },
  });
  assert.equal(crowdBtn.dataset.justSpawned, undefined);
  assert.equal(crowdBtn.getAttribute("data-just-spawned"), null);
  assert.equal(crowdBtn.dataset.crowdCount, "14");
  assert.equal(crowdBtn.textContent, "+20 Pedestrians Ahead (14)");

  // Once crowd clears, button returns to default label
  panel.render({
    pursuit: { phase: "running", wantedLevel: 3, crowdAheadCount: 0 },
  });
  assert.equal(crowdBtn.dataset.crowdCount, undefined);
  assert.equal(crowdBtn.textContent, "+20 Pedestrians Ahead");

  // Clicking End chase calls onStopChase
  stopBtn.click();
  assert.equal(stopCalls, 1);
});

test("pursuitPanel updates #chaseNitroFill width/aria-valuenow and data-nitro-state across ready, boosting, ped-hold, and recharging", (t) => {
  const { doc, panelHost } = createChaseDom();
  const panel = createPursuitPanel({ container: panelHost, doc });
  t.after(() => panel.close());

  const nitroMeter = doc.getElementById("chaseNitroMeter");
  const nitroLabel = doc.getElementById("chaseNitroLabel");
  const nitroFill = doc.getElementById("chaseNitroFill");
  const touchNitro = doc.getElementById("touchNitro");

  // 1. Safe defaults when mock status omits all Nitro fields (never throws)
  panel.update({
    phase: "running",
    street: true,
    cinematic: true,
    pako: true,
    wantedLevel: 2,
  });
  assert.equal(nitroMeter.dataset.nitroState, "ready");
  assert.equal(nitroMeter.getAttribute("data-nitro-state"), "ready");
  assert.equal(nitroLabel.textContent, "NITRO");
  assert.equal(nitroFill.style.width, "100%");
  assert.equal(nitroFill.getAttribute("aria-valuenow"), "100");
  assert.equal(touchNitro.dataset.nitroState, "ready");
  assert.equal(touchNitro.getAttribute("aria-pressed"), "false");

  // 2. Ready state with partial charge (from pursuitStatus)
  panel.sync({
    phase: "running",
    wantedLevel: 2,
    nitroCharge: 0.78,
    nitroActive: false,
    nitroSuppressedByPedestrian: false,
  });
  assert.equal(nitroMeter.dataset.nitroState, "ready");
  assert.equal(nitroLabel.textContent, "NITRO");
  assert.equal(nitroFill.style.width, "78%");
  assert.equal(nitroFill.getAttribute("aria-valuenow"), "78");

  // 3. Boosting state (nitroActive: true)
  panel.sync({
    phase: "running",
    wantedLevel: 3,
    nitroCharge: 0.64,
    nitroActive: true,
    nitroSuppressedByPedestrian: false,
  });
  assert.equal(nitroMeter.dataset.nitroState, "boosting");
  assert.equal(nitroMeter.getAttribute("data-nitro-state"), "boosting");
  assert.equal(nitroLabel.textContent, "BOOST");
  assert.equal(nitroFill.style.width, "64%");
  assert.equal(nitroFill.getAttribute("aria-valuenow"), "64");
  assert.equal(touchNitro.dataset.nitroState, "boosting");
  assert.equal(touchNitro.getAttribute("aria-pressed"), "true");

  // 4. Pedestrian safety hold state (nitroSuppressedByPedestrian: true overrides boost)
  panel.render({
    pursuit: { phase: "running", wantedLevel: 3 },
    player: {
      nitroCharge: 0.82,
      nitroActive: true,
      nitroSuppressedByPedestrian: true,
    },
  });
  assert.equal(nitroMeter.dataset.nitroState, "ped-hold");
  assert.equal(nitroMeter.getAttribute("data-nitro-state"), "ped-hold");
  assert.equal(nitroLabel.textContent, "PED SAFE");
  assert.equal(nitroFill.style.width, "82%");
  assert.equal(nitroFill.getAttribute("aria-valuenow"), "82");
  assert.equal(touchNitro.dataset.nitroState, "ped-hold");
  assert.equal(touchNitro.getAttribute("aria-pressed"), "false");

  // 5. Recharging state when charge is low (nitroCharge: 0.10) read from worldState.player
  panel.render({
    player: {
      nitroCharge: 0.10,
      nitroActive: false,
      nitroSuppressedByPedestrian: false,
    },
  });
  assert.equal(nitroMeter.dataset.nitroState, "recharging");
  assert.equal(nitroMeter.getAttribute("data-nitro-state"), "recharging");
  assert.equal(nitroLabel.textContent, "NITRO");
  assert.equal(nitroFill.style.width, "10%");
  assert.equal(nitroFill.getAttribute("aria-valuenow"), "10");
});

test("mountPursuitPanel and standalone createPursuitPanel both sync #chaseBar cleanly", (t) => {
  // Standalone createPursuitPanel builds #chaseBar automatically if absent in DOM
  const { doc: bareDoc } = createChaseDom({ withPrebuiltChaseBar: false });
  const spawned = [];
  const standalone = createPursuitPanel({
    doc: bareDoc,
    onSpawnCrowdAhead: (arg) => spawned.push(arg),
  });
  t.after(() => standalone.destroy());

  assert.ok(bareDoc.getElementById("chaseBar"), "expected createPursuitPanel to ensure #chaseBar");
  bareDoc.getElementById("spawnCrowdAheadBtn").click();
  assert.deepEqual(spawned, [{ count: 20 }]);

  // Legacy mountPursuitPanel also wires pre-existing #chaseBar from index.html
  const { doc, panelHost } = createChaseDom({ withPrebuiltChaseBar: true });
  const legacyCalls = [];
  const mounted = mountPursuitPanel({
    container: panelHost,
    onRun: () => true,
    onRestart: () => true,
    onLevel: () => true,
    onSpawnCrowdAhead: (arg) => legacyCalls.push(arg),
  });
  t.after(() => mounted.close());

  mounted.update(
    { phase: "running", street: true, pako: true, wantedLevel: 4 },
    { player: { nitroCharge: 0.45, nitroActive: true } },
  );
  assert.equal(doc.getElementById("chaseBar").hidden, false);
  assert.equal(doc.getElementById("chaseNitroMeter").dataset.nitroState, "boosting");
  assert.equal(doc.getElementById("chaseNitroFill").style.width, "45%");
  doc.getElementById("spawnCrowdAheadBtn").click();
  assert.deepEqual(legacyCalls, [{ count: 20 }]);

  // Zero-spawn / blocked response never falsely reports "20 Walking Ahead!"
  let blockedNowMs = 1000;
  const { doc: blockedDoc } = createChaseDom({ withPrebuiltChaseBar: false });
  const blockedPanel = createPursuitPanel({
    doc: blockedDoc,
    now: () => blockedNowMs,
    crowdSpawnFeedbackMs: 1200,
    onSpawnCrowdAhead: () => ({ ok: false, spawned: 0, preservedPreviousCount: 20 }),
  });
  t.after(() => blockedPanel.destroy());
  blockedPanel.render({ pursuit: { phase: "running", wantedLevel: 5, crowdAheadCount: 20 } });
  const blockedBtn = blockedDoc.getElementById("spawnCrowdAheadBtn");
  blockedBtn.click();
  assert.equal(blockedBtn.dataset.justSpawned, undefined);
  assert.equal(blockedBtn.dataset.spawnBlocked, "true");
  assert.equal(blockedBtn.textContent, "No Open Road Ahead");
  blockedNowMs += 1300;
  blockedPanel.render({ pursuit: { phase: "running", wantedLevel: 5, crowdAheadCount: 20 } });
  assert.equal(blockedBtn.dataset.spawnBlocked, undefined);
  assert.equal(blockedBtn.textContent, "+20 Pedestrians Ahead (20)");
});

test("src/ui/pursuit.css styles #chaseBar horizontal HUD strip, all Nitro states, and crowd confirmation badge", () => {
  const css = fs.readFileSync(path.join(repoRoot, "src/ui/pursuit.css"), "utf8");

  assert.match(css, /\.chase-bar\s*\{[^}]*display:\s*flex/s);
  assert.match(css, /\.chase-bar\s*\{[^}]*flex-wrap:\s*nowrap/s);
  assert.match(css, /\.chase-bar\[hidden\]/);
  assert.match(css, /\.chase-nitro\[data-nitro-state="boosting"\]/);
  assert.match(css, /\.chase-nitro\[data-nitro-state="ped-hold"\]/);
  assert.match(css, /\.chase-nitro\[data-nitro-state="recharging"\]/);
  assert.match(css, /\.chase-bar__crowd-btn\[data-just-spawned="true"\]/);
  assert.match(css, /#pursuitTouch\s+#touchNitro/);
});
