import test from "node:test";
import assert from "node:assert/strict";
import { mountPeoplePanel } from "../src/ui/people-panel.js";

class Element {
  constructor(tag, document) {
    this.tagName = tag.toUpperCase(); this.document = document; this.children = [];
    this.dataset = {}; this.attributes = new Map(); this.listeners = new Map();
    this.textContent = ""; this.hidden = false; this.disabled = false; this.value = "";
  }
  get lastElementChild() { return this.children.at(-1); }
  append(...children) {
    for (const child of children) { child.parentNode = this; this.children.push(child); }
    if (this.tagName === "SELECT" && !this.value) this.value = this.children[0]?.value ?? "";
  }
  replaceChildren(...children) { this.children = []; this.value = ""; this.append(...children); }
  setAttribute(key, value) { this.attributes.set(key, String(value)); }
  getAttribute(key) { return this.attributes.get(key) ?? null; }
  addEventListener(type, callback) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(callback);
  }
  removeEventListener(type, callback) { this.listeners.get(type)?.delete(callback); }
  contains(element) { return this === element || this.children.some((child) => child.contains(element)); }
  focus() { this.document.activeElement = this; }
  fire(type, details = {}) {
    if (this.disabled) return;
    const event = { type, target: this, preventDefault() {}, ...details };
    for (let element = this; element; element = element.parentNode)
      for (const listener of element.listeners.get(type) ?? []) listener(event);
  }
  remove() {
    if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((child) => child !== this);
    this.parentNode = null;
  }
}
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
function state() {
  const body = {
    heightM: 1.74, widthM: 0.48, depthM: 0.29, massKg: 70, radiusM: 0.26,
    walkSpeedMps: 1.2, jogSpeedMps: 2.8, maxAccelerationMps2: 1.5,
    maxDecelerationMps2: 2.4, maxTurnRateRadS: 2,
  };
  return {
    environment: "city", selectedId: "person-1", focused: false, paused: false,
    people: [
      { id: "person-1", kind: "locally-installed-model", body, x: 2, z: 8, heading: Math.PI / 2,
        speed: 0.65, accelerationMps2: 1.4, distance: 3.25, reason: "walking", motionMode: "ambient" },
      { id: "person-2", kind: "second-model", body: { ...body, heightM: 1.82 }, x: 5, z: 6, heading: 0,
        speed: 0, accelerationMps2: -0.5, distance: 7.5, reason: "person-ahead", motionMode: "stop" },
    ],
  };
}
function fixture(t, action = () => ({ ok: true })) {
  const previous = globalThis.document;
  const document = new Element("document"); document.document = document;
  document.createElement = (tag) => new Element(tag, document);
  document.body = document.createElement("body"); document.append(document.body);
  globalThis.document = document;
  const navigation = document.createElement("nav"), incumbent = document.createElement("button");
  navigation.append(incumbent); document.body.append(navigation);
  const actions = [];
  const panel = mountPeoplePanel({ navigation, onAction: (name, value) => {
    actions.push([name, value]); return action(name, value);
  } });
  const find = (id, element = document) => element.id === id ? element
    : element.children.map((child) => find(id, child)).find(Boolean);
  t.after(() => {
    panel.dispose();
    if (previous === undefined) delete globalThis.document; else globalThis.document = previous;
  });
  return { panel, navigation, incumbent, document, actions, byId: find };
}

test("the public People panel labels truth separately and displays supplied actual body/motion measurements", (t) => {
  const f = fixture(t), supplied = state(), original = structuredClone(supplied);
  f.panel.update(supplied); f.byId("peopleToggleBtn").fire("click");
  assert.match(f.byId("peopleReferenceBoundary").textContent, /World reference.*not camera perception/);
  assert.match(f.byId("peopleSpeed").textContent, /0.65 m\/s.*2.3 km\/h/);
  assert.equal(f.byId("peopleAcceleration").textContent, "1.40 m/s²");
  assert.equal(f.byId("peopleTravel").textContent, "3.25 m");
  assert.equal(f.byId("peopleBodyDimensions").textContent, "1.74 × 0.48 × 0.29 m");
  assert.equal(f.byId("peopleBodyMass").textContent, "70.0 kg");
  assert.equal(f.byId("peopleBodyTurn").textContent, "2.00 rad/s");
  assert.deepEqual(supplied, original, "inspection does not mutate or derive a hidden motion target");
  assert.deepEqual(f.actions, []);
});

test("selection, follow, walk/jog/stop/ambient and vehicle controls emit only the declared coordinator actions", (t) => {
  const f = fixture(t), supplied = state();
  f.panel.update(supplied); f.byId("peopleToggleBtn").fire("click");
  const select = f.byId("peopleSelect");
  select.value = "person-2"; select.fire("change");
  assert.deepEqual(f.actions.at(-1), ["select", "person-2"]);
  supplied.selectedId = "person-2";
  f.panel.update(supplied);
  f.byId("peopleFocusBtn").fire("click");
  assert.deepEqual(f.actions.at(-1), ["focus", "person-2"]);
  for (const mode of ["walk", "jog", "stop", "ambient"]) {
    const input = f.byId("peopleMotionMode");
    input.value = mode; input.fire("change");
    assert.deepEqual(f.actions.at(-1), ["motion", { id: "person-2", mode }]);
  }
  supplied.focused = true; f.panel.update(supplied);
  f.byId("peopleVehicleViewBtn").fire("click");
  assert.deepEqual(f.actions.at(-1), ["vehicle-view", undefined]);
  assert.equal(f.byId("peopleBodyDimensions").textContent, "1.82 × 0.48 × 0.29 m");
});

test("empty/reset state clears stale body data; fixed Vision fixtures cannot dispatch ordinary motion", (t) => {
  const f = fixture(t), supplied = state();
  f.panel.update(supplied);
  f.panel.update({ ...supplied, environment: "vision" });
  assert.equal(f.byId("peopleMotionMode").disabled, true);
  assert.match(f.byId("peopleMotionNote").textContent, /Fixed Vision fixture.*locked/);
  const count = f.actions.length;
  f.byId("peopleMotionMode").value = "jog"; f.byId("peopleMotionMode").fire("change");
  assert.equal(f.actions.length, count);
  f.panel.update({ environment: "city", people: [], selectedId: null, focused: false, paused: true });
  for (const id of ["peopleSelect", "peopleFocusBtn", "peopleMotionMode"])
    assert.equal(f.byId(id).disabled, true);
  assert.match(f.byId("peopleStatus").textContent, /no people.*city|no people.*pedestrian/i);
  assert.equal(f.byId("peopleBodyDimensions").textContent, "Unavailable");
  assert.equal(f.byId("peopleSpeed").textContent, "Unavailable");
  f.panel.update(state());
  assert.equal(f.byId("peopleMotionMode").disabled, false);
  assert.equal(f.byId("peopleSelect").value, "person-1");
});

test("failed asynchronous selection is visible and restores the authoritative selection without inventing motion", async (t) => {
  let reject;
  const f = fixture(t, () => new Promise((_resolve, fail) => { reject = fail; }));
  f.panel.update(state()); f.byId("peopleToggleBtn").fire("click");
  const select = f.byId("peopleSelect");
  select.value = "person-2"; select.fire("change");
  assert.equal(select.disabled, true);
  reject(new Error("Person left this world")); await flush();
  assert.equal(select.disabled, false);
  assert.equal(select.value, "person-1");
  assert.match(f.byId("peopleActionError").textContent, /Person left this world/);
  assert.equal(f.byId("peopleActionError").hidden, false);
});

test("closing a followed person acknowledges vehicle recovery before hiding, handles failure, then restores focus", (t) => {
  let accepted = false;
  const f = fixture(t, () => accepted ? { ok: true } : { ok: false, error: "Vehicle camera unavailable; retry." });
  f.panel.update({ ...state(), focused: true });
  f.byId("peopleToggleBtn").fire("click");
  f.byId("peopleCloseBtn").fire("click");
  assert.equal(f.byId("peoplePanel").hidden, false);
  assert.match(f.byId("peopleActionError").textContent, /Vehicle camera unavailable/);
  accepted = true;
  f.document.fire("keydown", { key: "Escape" });
  assert.equal(f.byId("peoplePanel").hidden, true);
  assert.equal(f.document.activeElement, f.byId("peopleToggleBtn"));
  assert.deepEqual(f.actions.at(-1), ["vehicle-view", undefined]);
});

test("removed selections, missing measurements and repeated disposal leave no stale controls/listeners", (t) => {
  const f = fixture(t), supplied = state();
  supplied.selectedId = "removed-person";
  supplied.people = [{ id: "survivor", kind: "installed", motionMode: "ambient" }];
  f.panel.update(supplied);
  assert.equal(f.byId("peopleSelect").value, "survivor");
  assert.equal(f.byId("peopleBodyMass").textContent, "Unavailable");
  assert.equal(f.byId("peopleAcceleration").textContent, "Unavailable");
  const toggle = f.byId("peopleToggleBtn"), count = f.actions.length;
  f.panel.dispose(); f.panel.dispose();
  toggle.fire("click");
  assert.equal(f.byId("peoplePanel"), undefined);
  assert.equal(f.actions.length, count);
  assert.equal(f.navigation.children[0], f.incumbent);
});
