import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { readFileSync } from "node:fs";
import {
  applyTrafficCrashDamage,
  createUnifiedTrafficModel,
  disposeUnifiedTrafficModel,
} from "../src/render/unified-traffic-model.js";
import { actorProxyGeometry, MetroSilhouettes, streetChaosAccidentDamage, WorldView } from "../src/render/world-view.js";
import { formatCairoChaosHud, mountStreetChaosHud } from "../src/ui/street-chaos-hud.js";

const TRUCK = { kind: "truck", width: 2.45, length: 8.2, height: 3.35, phase: .25 };
const near = (actual, expected, tolerance = 2e-5) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} should be within ${tolerance} of ${expected}`);


const tintKey = hex => {
  const color = new THREE.Color(hex);
  return [color.r, color.g, color.b].map(v => Math.round(v * 10000)).join(":");
};

function shellTriangles(geometry) {
  const position = geometry.getAttribute("position"), color = geometry.getAttribute("color");
  const result = [];
  for (let i = 0; i < position.count; i += 3) {
    const points = [0, 1, 2].map(j => new THREE.Vector3(position.getX(i + j), position.getY(i + j), position.getZ(i + j)));
    const normal = new THREE.Vector3().subVectors(points[1], points[0])
      .cross(new THREE.Vector3().subVectors(points[2], points[0])).normalize();
    const tint = [color.getX(i), color.getY(i), color.getZ(i)].map(v => Math.round(v * 10000)).join(":");
    result.push({ points, normal, tint, d: normal.dot(points[0]) });
  }
  return result;
}

function projected(triangle, drop) {
  return triangle.points.map(point => drop === 0 ? [point.y, point.z] : drop === 1 ? [point.x, point.z] : [point.x, point.y]);
}

function trianglesOverlap2d(a, b, epsilon = 1e-5) {
  for (const polygon of [a, b]) for (let i = 0; i < 3; i++) {
    const edge = [polygon[(i + 1) % 3][0] - polygon[i][0], polygon[(i + 1) % 3][1] - polygon[i][1]];
    const length = Math.hypot(...edge);
    if (length <= epsilon) continue;
    const axis = [-edge[1] / length, edge[0] / length];
    const extent = points => {
      const values = points.map(point => point[0] * axis[0] + point[1] * axis[1]);
      return [Math.min(...values), Math.max(...values)];
    };
    const [amin, amax] = extent(a), [bmin, bmax] = extent(b);
    if (Math.min(amax, bmax) - Math.max(amin, bmin) <= epsilon) return false;
  }
  return true;
}

function coplanarDifferentColorOverlaps(geometry) {
  const triangles = shellTriangles(geometry), planes = new Map(), overlaps = [];
  const rounded = value => Math.round(value * 10000);
  for (const triangle of triangles) {
    const key = [...triangle.normal.toArray().map(rounded), rounded(triangle.d)].join(":");
    const bucket = planes.get(key) ?? [];
    bucket.push(triangle);
    planes.set(key, bucket);
  }
  for (const bucket of planes.values()) for (let i = 0; i < bucket.length; i++) for (let j = i + 1; j < bucket.length; j++) {
    const a = bucket[i], b = bucket[j];
    if (a.tint === b.tint) continue;
    const abs = a.normal.toArray().map(Math.abs);
    const drop = abs.indexOf(Math.max(...abs));
    if (trianglesOverlap2d(projected(a, drop), projected(b, drop))) overlaps.push([a, b]);
  }
  return overlaps;
}

test("heavy freight truck uses one faceted shell, correct metre envelope, heavy axles and resettable damage", () => {
  const { root, wheels } = createUnifiedTrafficModel(TRUCK);
  const shell = root.getObjectByName("traffic-shell");
  const resources = new Set();
  const disposals = new Map();
  root.traverse(part => {
    if (!part.isMesh) return;
    for (const resource of [part.geometry, part.material]) {
      if (resources.has(resource)) continue;
      resources.add(resource);
      disposals.set(resource, 0);
      resource.addEventListener("dispose", () => disposals.set(resource, disposals.get(resource) + 1));
    }
  });
  assert.equal(root.name, "traffic-truck");
  assert.ok(shell?.isMesh);
  assert.equal(root.children.filter(part => part.name === "traffic-shell").length, 1);
  assert.ok(shell.geometry.attributes.position.count > 1000, "truck shell should contain non-trivial faceted detail");
  assert.equal(shell.material.transparent, false);
  assert.equal(shell.material.vertexColors, true);
  assert.equal(shell.castShadow, true);
  assert.equal(shell.receiveShadow, false);
  const size = new THREE.Box3().setFromObject(root, true).getSize(new THREE.Vector3());
  near(size.x, 2.45); near(size.y, 3.35); near(size.z, 8.2);
  const coplanar = coplanarDifferentColorOverlaps(shell.geometry);
  assert.equal(coplanar.length, 0,
    "differently coloured truck surfaces must not overlap on the same facing plane");
  const triangles = shellTriangles(shell.geometry);
  const shellWidth = TRUCK.width * (.5 / .509);
  const cabWallX = .47 * shellWidth, cabGlassX = .4735 * shellWidth;
  const sideGlass = triangles.filter(({ points, tint }) => {
    const center = points.reduce((sum, point) => sum.add(point), new THREE.Vector3()).multiplyScalar(1 / 3);
    return tint === tintKey(0x3d5359) && Math.abs(Math.abs(center.x) - cabGlassX) < .004 && center.z > TRUCK.length * .245 &&
      center.z < TRUCK.length * .420 && center.y > TRUCK.height * .545;
  });
  assert.equal(sideGlass.length, 4);
  assert.ok(sideGlass.every(({ points, normal }) => {
    const cx = points.reduce((sum, point) => sum + point.x, 0) / 3;
    return normal.x * Math.sign(cx) > .5 && Math.abs(Math.abs(cx) - cabWallX) < .02;
  }), "cab side glass must sit just proud of the wall with outward normals");
  const mirrorX = .5015 * shellWidth;
  const mirrorGlass = triangles.filter(({ points, tint }) => {
    const center = points.reduce((sum, point) => sum.add(point), new THREE.Vector3()).multiplyScalar(1 / 3);
    return tint === tintKey(0x8fa6ad) && Math.abs(Math.abs(center.x) - mirrorX) < .004 && center.y > TRUCK.height * .695 &&
      center.z > TRUCK.length * .389;
  });
  assert.equal(mirrorGlass.length, 4);
  assert.ok(mirrorGlass.every(({ points, normal }) => {
    const cx = points.reduce((sum, point) => sum + point.x, 0) / 3;
    return normal.x * Math.sign(cx) > .5;
  }), "mirror glass normals must face away from the truck");
  assert.equal(wheels.length, 4);
  assert.equal(wheels.filter(wheel => wheel.front).length, 2);
  assert.ok(wheels.filter(wheel => wheel.front).every(wheel => wheel.part.position.z > 0));
  assert.ok(wheels.filter(wheel => !wheel.front).every(wheel => wheel.part.position.z < 0));
  near(wheels.find(wheel => wheel.front).part.position.z, 8.2 * .34);
  near(wheels.find(wheel => !wheel.front).part.position.z, -8.2 * .30);
  assert.ok(wheels.every(wheel => wheel.radius > .42), "truck tires should read as heavy-duty wheels");

  const pristine = shell.geometry;
  const original = Array.from(pristine.attributes.position.array);
  assert.equal(applyTrafficCrashDamage(root, { front: .9, left: .55, wrecked: true }), true);
  assert.notEqual(shell.geometry, pristine);
  assert.notDeepEqual(Array.from(shell.geometry.attributes.position.array), original);
  assert.equal(applyTrafficCrashDamage(root, { front: 0, rear: 0, left: 0, right: 0, wrecked: false }), true);
  assert.equal(shell.geometry, pristine);
  assert.deepEqual(Array.from(shell.geometry.attributes.position.array), original);

  disposeUnifiedTrafficModel(root);
  disposeUnifiedTrafficModel(root);
  assert.equal(root.parent, null);
  assert.ok([...disposals.values()].every(count => count === 1), "owned geometry and materials dispose exactly once");
});

test("truck distance proxy and Metro silhouette batch build without sedan fallback", () => {
  const geometry = actorProxyGeometry("truck");
  try {
    geometry.computeBoundingBox();
    const size = geometry.boundingBox.getSize(new THREE.Vector3());
    near(size.x, 1);
    near(size.y, 1);
    near(size.z, 1);
    assert.ok(geometry.attributes.position.count > 100);
  } finally {
    geometry.dispose();
  }

  const scene = new THREE.Scene();
  const silhouettes = new MetroSilhouettes(scene);
  try {
    silhouettes.begin();
    silhouettes.put({ ...TRUCK, id: "truck-distance" }, 12, .12, -20, .4);
    silhouettes.end();
    const mesh = scene.getObjectByName("metro-silhouettes-truck");
    assert.ok(mesh?.isInstancedMesh);
    assert.equal(mesh.count, 1);
  } finally {
    silhouettes.dispose();
  }
});

test("wreck cues stay outside the body, use dark smoke, and damage lead/follower ends differently", () => {
  const scene = new THREE.Scene();
  const view = { world: { tick: 30, streetChaos: { accidentRoles: { wreck: { role: "lead", skewSign: -1 } } } },
    scene, crashEffects: {}, streetChaosFxLayer: WorldView.prototype.streetChaosFxLayer,
    ensureStreetChaosHazards: WorldView.prototype.ensureStreetChaosHazards };
  const record = { visual: new THREE.Group() };
  const actor = { ...TRUCK, id: "wreck" };
  WorldView.prototype.updateStreetChaosHazards.call(view, record, actor, 2, .12, 4, 0, 20 * 20);
  const corners = record.hazardFlasher.children.filter(child => child.name === "street-chaos-corner-flasher");
  assert.equal(corners.length, 4);
  assert.ok(corners.every(light => Math.abs(light.position.x) > TRUCK.width / 2 || Math.abs(light.position.z) > TRUCK.length / 2));
  assert.ok(record.hazardFlasher.getObjectByName("street-chaos-hazard-halo"));
  assert.ok(view.chaosHazardMaterial.emissiveIntensity >= 4);
  assert.equal(record.hazardFlasher.parent, view.crashEffects.layer);
  assert.equal(record.accidentSmoke.parent, view.crashEffects.layer);
  assert.equal(record.accidentSmoke.visible, true);
  assert.equal(record.accidentSmoke.children.length, 9);
  assert.ok(view.chaosSmokeMaterial.opacity >= .38);
  assert.equal(view.chaosSmokeMaterial.color.getHex(), 0x383d3b);
  WorldView.prototype.hideStreetChaosHazards.call(view, record);
  assert.equal(record.hazardFlasher.visible, false);
  assert.equal(record.accidentSmoke.visible, false);
  WorldView.prototype.clearStreetChaosHazards.call(view, record);
  assert.equal(view.crashEffects.layer.children.length, 0);

  const lead = { id: "lead" }, follower = { id: "follower" };
  const world = { streetChaos: { active: true, accidentActorIds: ["lead", "follower"], accidentRoles: {
    lead: { role: "lead", skewSign: -1 }, follower: { role: "follower", skewSign: 1 },
  } } };
  const leadDamage = streetChaosAccidentDamage(world, lead, { front: .9 });
  const followerDamage = streetChaosAccidentDamage(world, follower, { rear: .2 });
  assert.ok(leadDamage.rear >= .78 && leadDamage.left >= .62 && leadDamage.front <= .28);
  assert.ok(followerDamage.front >= .85 && followerDamage.right >= .62 && followerDamage.rear < .78);

  view.chaosHazardGeometry.dispose(); view.chaosHazardHaloGeometry.dispose(); view.chaosHazardMaterial.dispose();
  view.chaosSmokeGeometry.dispose(); view.chaosSmokeMaterial.dispose();
});

test("Cairo Traffic formatter reads live reaction objects, manual mode, and request notices", () => {
  const base = { active: true, intensity: "rush", driverMode: "auto", truckCount: 5,
    activeHazard: { kind: "ghorz" }, metrics: { nearMissesAvoided: 7, collisions: 1 } };
  const expected = new Map([
    ["defensive-yield", ["Yielding", "brake"]],
    ["junction-hold", ["Junction Hold", "caution"]],
    ["emergency-brake", ["Emergency Brake", "emergency"]],
    ["evasive-shift", ["Evasive Shift", "evasive"]],
    ["accident-bypass", ["Accident Bypass", "evasive"]],
  ]);
  for (const [reaction, [label, tone]] of expected) {
    const hud = formatCairoChaosHud({ ...base, egoReaction: { reaction, reasonDetail: `detail:${reaction}` } });
    assert.equal(hud.reactionKind, reaction);
    assert.equal(hud.reactionLabel, label);
    assert.equal(hud.reactionTone, tone);
    assert.equal(hud.reactionDetail, `detail:${reaction}`);
  }
  const stats = formatCairoChaosHud(base).statsText;
  assert.match(stats, /\u00b7/);
  assert.equal(stats.includes("?"), false);
  const sanitized = formatCairoChaosHud({ ...base, request: { status: "rejected", message: "No free lane ? chaos-event-12" } });
  assert.equal(sanitized.noticeText, "No free lane");
  const manual = formatCairoChaosHud({ ...base, driverMode: "manual", egoReaction: { reaction: "emergency-brake" } });
  assert.equal(manual.driverLabel, "Manual");
  assert.equal(manual.reactionLabel, "Manual control");
  assert.equal(manual.reactionTone, "neutral");
  assert.equal(formatCairoChaosHud({ ...base, request: { status: "pending" } }).noticeText, "Waiting for clear straight road\u2026");
  assert.equal(formatCairoChaosHud({ ...base, request: { status: "rejected" } }).noticeText, "Accident already active");
  assert.equal(formatCairoChaosHud({ ...base, request: { status: "expired" } }).noticeText, "Try on a wide road away from a junction");
  assert.equal(formatCairoChaosHud({ ...base, request: { status: "rejected", message: "No free lane" } }).noticeText, "No free lane");
});

function element(initial = "") {
  let text = initial, writes = 0;
  const attrs = new Map();
  return {
    hidden: false, value: "", className: "", dataset: {},
    get textContent() { return text; },
    set textContent(value) { text = value; writes++; },
    get writes() { return writes; },
    getAttribute(name) { return attrs.get(name) ?? null; },
    setAttribute(name, value) { attrs.set(name, String(value)); },
  };
}

test("mounted Cairo HUD updates controls once and avoids repeat DOM text writes", () => {
  const e = {
    button: element(), bar: element(), intensity: element(), driver: element(),
    hazard: element(), reaction: element(), stats: element(), notice: element(),
    ghorz: element(), lane: element(), accident: element(), stop: element(),
  };
  const events = [];
  let now = 100;
  const hud = mountStreetChaosHud(e, {
    now: () => now,
    onDriverMode: value => events.push(value), onEvent: value => events.push(value), onStop: () => events.push("stop"),
  });
  const state = { active: true, intensity: "max", driverMode: "manual", activeHazard: "accident",
    egoReaction: { reaction: "emergency-brake", reasonDetail: "Obstacle braking" },
    request: { id: 7, status: "pending" }, truckCount: 4, metrics: { nearMissesAvoided: 2, collisions: 0 } };
  hud.update(state);
  const writes = e.stats.writes + e.hazard.writes + e.reaction.writes + e.driver.writes;
  hud.update(state);
  assert.equal(e.stats.writes + e.hazard.writes + e.reaction.writes + e.driver.writes, writes);
  assert.equal(e.bar.hidden, false);
  assert.equal(e.button.getAttribute("aria-expanded"), "true");
  assert.equal(e.driver.getAttribute("aria-pressed"), "true");
  assert.equal(e.reaction.getAttribute("title"), "Manual control");
  assert.equal(e.notice.hidden, false);
  now += 4001;
  hud.update(state);
  assert.equal(e.notice.hidden, true);
  e.driver.onclick(); e.ghorz.onclick(); e.stop.onclick();
  assert.deepEqual(events, ["auto", "ghorz", "stop"]);
});



test("Cairo active layout separates status and mode highlights", () => {
  const css = readFileSync(new URL("../src/ui/styles.css", import.meta.url), "utf8");
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const main = readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
  assert.match(html, /id="chaosNotice"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(main, /classList\.toggle\("cairo-active", Boolean\(cairoState\?\.active\)\)/);
  assert.match(css, /body\.cairo-active #loadingStatus\s*\{\s*top:\s*150px/);
  assert.match(css, /@media \(max-width: 660px\)[\s\S]*body\.cairo-active #loadingStatus\s*\{\s*display:\s*none/);
  assert.match(css, /#cairoChaosBtn\[aria-expanded="true"\]/);
  assert.match(css, /body\.cairo-active #pakoBtn/);
});
