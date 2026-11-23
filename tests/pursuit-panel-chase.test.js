import test from "node:test";
import assert from "node:assert/strict";
import { mountPursuitPanel } from "../src/ui/pursuit-panel.js";

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

class MockElement {
  constructor(tag, ownerDocument) {
    this.tagName = tag.toUpperCase();
    this.ownerDocument = ownerDocument;
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
  click() {
    if (this.disabled) return;
    const event = { type: "click", target: this, preventDefault() {} };
    for (const listener of this.listeners.get("click") ?? []) listener(event);
  }
}

function createFixture(t, overrides = {}) {
  const doc = {
    createElement(tag) {
      return new MockElement(tag, doc);
    },
  };
  const container = doc.createElement("div");
  const driverModes = [];
  const panel = mountPursuitPanel({
    container,
    onRun: () => true,
    onRestart: () => true,
    onLevel: () => true,
    onDriverMode: (mode) => driverModes.push(mode),
    ...overrides,
  });
  const byId = (id, root = container) => {
    if (root.id === id) return root;
    for (const child of root.children) {
      const found = byId(id, child);
      if (found) return found;
    }
    return null;
  };
  t.after(() => panel.close());
  return { panel, container, byId, driverModes };
}

test("ready Chase defaults to RL AI when checkpoint is ready, shows PPO summary, and toggles driver mode", (t) => {
  const { panel, byId, driverModes } = createFixture(t);
  panel.update({
    phase: "ready",
    street: true,
    cinematic: true,
    pako: true,
    checkpointReady: true,
    ppoSummary: "48 updates · 28k steps · ε = 0.20",
    level: 3,
    metrics: {},
  });

  for (const id of [
    "pursuitPanel", "pursuitTitle", "pursuitScene", "pursuitPhase", "pursuitHeat",
    "pursuitWanted", "pursuitUnitCount", "pursuitLevel", "pursuitRunBtn", "pursuitRestartBtn",
    "pako-training", "pakoCheckpointChoice", "pursuitCheckpoint", "pursuitCheckpointStatus",
    "pursuitLearning", "pursuitTime", "pursuitBest", "pursuitStyle",
    "pakoDriverToggle", "pakoDriverRl", "pakoDriverManual",
  ]) {
    assert.ok(byId(id), `expected #${id} to exist`);
  }

  const toggle = byId("pakoDriverToggle");
  const rlBtn = byId("pakoDriverRl");
  const manualBtn = byId("pakoDriverManual");
  const levelLabel = byId("pursuitLevel").parentElement;

  assert.equal(byId("pursuitTitle").textContent, "Chase");
  assert.equal(toggle.hidden, false);
  assert.equal(toggle.getAttribute("role"), "group");
  assert.equal(toggle.getAttribute("aria-label"), "Chase driver");
  assert.equal(toggle.parentElement, levelLabel.parentElement);
  assert.equal(
    toggle.parentElement.children.indexOf(toggle) < toggle.parentElement.children.indexOf(levelLabel),
    true,
    "driver toggle should appear inside controls before levelLabel",
  );
  assert.equal(rlBtn.textContent, "RL AI");
  assert.equal(manualBtn.textContent, "Manual");
  assert.equal(rlBtn.getAttribute("aria-pressed"), "true");
  assert.equal(manualBtn.getAttribute("aria-pressed"), "false");
  assert.equal(rlBtn.disabled, false);
  assert.equal(manualBtn.disabled, false);
  assert.equal(
    byId("pursuitScene").textContent,
    "RL PPO drives (48 updates · 28k steps · ε = 0.20).",
  );

  manualBtn.click();
  assert.deepEqual(driverModes, ["manual"]);

  panel.update({
    phase: "ready",
    street: true,
    cinematic: true,
    pako: true,
    pakoDriverMode: "manual",
    checkpointReady: true,
    ppoSummary: "48 updates · 28k steps · ε = 0.20",
    level: 3,
    metrics: {},
  });
  assert.equal(rlBtn.getAttribute("aria-pressed"), "false");
  assert.equal(manualBtn.getAttribute("aria-pressed"), "true");
  assert.equal(
    byId("pursuitScene").textContent,
    "You drive · Switch to RL AI or load a PPO checkpoint.",
  );

  rlBtn.click();
  assert.deepEqual(driverModes, ["manual", "rl"]);

  panel.update({
    phase: "ready",
    street: true,
    cinematic: true,
    pako: true,
    checkpointReady: false,
    level: 2,
    metrics: {},
  });
  assert.equal(rlBtn.disabled, true);
  assert.equal(rlBtn.getAttribute("aria-pressed"), "false");
  assert.equal(manualBtn.getAttribute("aria-pressed"), "true");
  assert.equal(
    byId("pursuitScene").textContent,
    "You drive · Switch to RL AI or load a PPO checkpoint.",
  );
  rlBtn.click();
  assert.deepEqual(driverModes, ["manual", "rl"]);
});

test("custom imported checkpoint shows Development checkpoint when ready and PPO test when running", (t) => {
  const { panel, byId } = createFixture(t);
  panel.update({
    phase: "ready",
    street: true,
    cinematic: true,
    pako: true,
    checkpointReady: true,
    customCheckpoint: true,
    pakoAvailable: false,
    ppoSummary: "12 updates · 6k steps · ε = 0.20",
    metrics: {},
  });

  assert.match(byId("pursuitScene").textContent, /development checkpoint/i);
  assert.equal(
    byId("pursuitScene").textContent,
    "PPO test · Development checkpoint (12 updates · 6k steps · ε = 0.20), not release-verified.",
  );

  panel.update({
    phase: "ready",
    street: true,
    cinematic: true,
    pako: true,
    checkpointReady: true,
    customCheckpoint: true,
    terrain: { active: true },
    metrics: {},
  });
  assert.equal(
    byId("pursuitScene").textContent,
    "Surveyed curb · Return to pavement before ending the chase.",
  );

  panel.update({
    phase: "running",
    street: true,
    cinematic: true,
    variant: "gta",
    pako: true,
    customCheckpoint: true,
    pakoAvailable: false,
    wantedLevel: 3,
    patrolStatus: { active: 4, nearestM: 24.6 },
    frozenDriver: { status: "active" },
    metrics: { survivalS: 7.4, collisions: 0 },
  });
  assert.equal(byId("pakoDriverToggle").hidden, true);
  assert.match(byId("pursuitLearning").textContent, /^PPO test · /);
  assert.equal(byId("pursuitLearning").textContent, "PPO test · Escaping police · I takes over");
});

test("running pako chase renders patrol count + nearest distance and distinct RL maneuver states", (t) => {
  const { panel, byId } = createFixture(t);
  const baseRunning = {
    phase: "running",
    street: true,
    cinematic: true,
    variant: "gta",
    pako: true,
    wantedLevel: 5,
    patrolStatus: { active: 10, nearestM: 16.4 },
    metrics: { survivalS: 14.2, collisions: 1 },
  };

  panel.update({
    ...baseRunning,
    frozenDriver: {
      status: "active",
      cameraBrake: { actorId: "person-7" },
      shieldReason: "front-sector",
      lastDecision: { planner: { reason: "PREDICTIVE_CURB_BYPASS" }, submitted: { gear: -1 } },
    },
  });
  assert.equal(byId("pursuitHeat").hidden, false);
  assert.equal(byId("pursuitWanted").getAttribute("aria-label"), "Wanted level 5 of 5");
  assert.equal(byId("pursuitUnitCount").textContent, "10 patrols · 16 m");
  assert.equal(byId("pursuitLearning").hidden, false);
  assert.equal(byId("pursuitLearning").textContent, "RL PPO · Camera forecast: braking for person");

  panel.update({
    ...baseRunning,
    patrolStatus: { active: 1, nearestM: 8.6 },
    frozenDriver: {
      status: "active",
      lastDecision: { planner: { reason: "PREDICTIVE_CURB_BYPASS" }, submitted: { gear: 1 } },
    },
  });
  assert.equal(byId("pursuitUnitCount").textContent, "1 patrol · 9 m");
  assert.equal(byId("pursuitLearning").textContent, "RL PPO · Climbing clear curb to evade");

  panel.update({
    ...baseRunning,
    gta: { curbSupport: { active: true, version: "metro-city-curbs-v2" }, playerHealth: 90, playerMaxHealth: 100 },
    frozenDriver: { status: "active", lastDecision: { submitted: { gear: 1 } } },
  });
  assert.equal(byId("pursuitLearning").textContent, "RL PPO · Climbing clear curb to evade");
  assert.equal(byId("pursuitRestartBtn").disabled, false);
  assert.equal(byId("pursuitRestartBtn").textContent, "End chase");

  panel.update({
    ...baseRunning,
    gta: { curbSupport: { active: true, version: "metro-city-curbs-v2" }, playerHealth: 90, playerMaxHealth: 100 },
    frozenDriver: { status: "active", lastDecision: { planner: { reason: "PREDICTIVE_CURB_BYPASS", maneuver: "alley-shortcut" }, submitted: { gear: 1 } } },
  });
  assert.equal(byId("pursuitLearning").textContent, "RL PPO · Cutting through alley");

  panel.update({
    ...baseRunning,
    gta: { curbSupport: { active: true, version: "metro-city-curbs-v2" }, playerHealth: 90, playerMaxHealth: 100 },
    frozenDriver: { status: "active", lastDecision: { planner: { reason: "PREDICTIVE_REVERSE_ESCAPE" }, submitted: { gear: -1 } } },
  });
  assert.equal(byId("pursuitLearning").textContent, "RL PPO · Reversing & turning out");

  panel.update({
    ...baseRunning,
    frozenDriver: {
      status: "active",
      lastDecision: { planner: { reason: "PREDICTIVE_REVERSE_ESCAPE" }, submitted: { gear: 1 } },
    },
  });
  assert.equal(byId("pursuitLearning").textContent, "RL PPO · Reversing & turning out");

  panel.update({
    ...baseRunning,
    frozenDriver: {
      status: "active",
      lastDecision: { planner: null, submitted: { gear: -1 } },
    },
  });
  assert.equal(byId("pursuitLearning").textContent, "RL PPO · Reversing & turning out");

  for (const reason of ["PREDICTIVE_EVADE_LANE", "PREDICTIVE_RECOVERY", "PREDICTIVE_QUEUE"]) {
    panel.update({
      ...baseRunning,
      frozenDriver: {
        status: "active",
        lastDecision: { planner: { reason }, submitted: { gear: 1 } },
      },
    });
    assert.equal(byId("pursuitLearning").textContent, "RL PPO · Changing path around obstacle");
  }

  panel.update({
    ...baseRunning,
    pakoAvailable: true,
    frozenDriver: {
      status: "active",
      shieldReason: "patrol-close-ahead",
      lastDecision: { submitted: { gear: 1 } },
    },
  });
  assert.equal(
    byId("pursuitLearning").textContent,
    "Verified PPO · Range safety yield: patrol-close-ahead",
  );
});

test("legacy pursuit modes keep driver toggle hidden and preserve existing unit count formatting", (t) => {
  const { panel, byId } = createFixture(t);
  for (const cityPursuitStyle of ["survival", "gta", "dispatch", "dispatch-ppo"]) {
    panel.update({
      phase: "ready",
      street: true,
      cinematic: true,
      pako: false,
      cityPursuitStyle,
      checkpointReady: true,
      metrics: {},
    });
    assert.equal(byId("pakoDriverToggle").hidden, true, `expected toggle hidden for ${cityPursuitStyle}`);
    assert.equal(byId("pursuitStyle").parentElement.hidden, false);
  }

  panel.update({
    phase: "running",
    pack: true,
    packLab: true,
    cinematic: true,
    wantedLevel: 2,
    patrolStatus: { active: 4, nearestM: 12, sectors: 3 },
    metrics: {},
  });
  assert.equal(byId("pursuitTitle").textContent, "Pursuit Lab");
  assert.equal(byId("pakoDriverToggle").hidden, true);
  assert.equal(byId("pursuitUnitCount").textContent, "4 patrols · 3/4 sides");
});
