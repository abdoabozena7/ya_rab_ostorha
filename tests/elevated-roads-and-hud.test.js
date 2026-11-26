import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { makeDiagonalRoad, roadPointAt } from "../src/core/geometry.js";
import { createUnifiedCity } from "../src/core/unified-city.js";
import { createVehicleState } from "../src/core/vehicle-state.js";
import {
  MARKING_TOP_OFFSET_M,
  PAVEMENT_TOP_OFFSET_M,
  RETAINING_BASE_Y_M,
  ROAD_TOP_OFFSET_M,
  buildElevatedRoadMeshes,
  buildTerrainRoadParts,
} from "../src/render/elevated-roads.js";
import {
  describeRoadSurface,
  mountVehiclePanel,
} from "../src/ui/vehicle-panel.js";
import { mountPursuitPanel } from "../src/ui/pursuit-panel.js";

function makeHillWorld(elevationAt) {
  const orthoZ = {
    id: "mokattam-spine-z",
    axis: "z",
    fixed: 12,
    min: -220,
    max: 220,
    width: 14,
    laneOffsetM: 2.7,
    speedLimitMps: 10,
    flow: 0,
    zone: "avenue",
    marking: "center",
  };
  const orthoX = {
    id: "citadel-cross-x",
    axis: "x",
    fixed: -10,
    min: -220,
    max: 220,
    width: 13,
    laneOffsetM: 2.6,
    speedLimitMps: 9.5,
    flow: 0,
    zone: "avenue",
    marking: "center",
  };
  const diagAve = makeDiagonalRoad({
    id: "flyover-diag-avenue",
    x1: -180,
    z1: -150,
    x2: 200,
    z2: 140,
    width: 14,
    laneOffsetM: 2.7,
    speedLimitMps: 10.5,
    zone: "avenue",
    marking: "center",
  });
  const drivingRoads = [orthoZ, orthoX, diagAve];
  return {
    environment: "metro",
    config: { cityVersion: 5 },
    roads: drivingRoads,
    drivingRoads,
    elevationAt,
    orthoZ,
    orthoX,
    diagAve,
  };
}

class DomElement {
  constructor(tagName, document) {
    this.tagName = tagName.toUpperCase();
    this.document = document;
    this.ownerDocument = document;
    this.children = [];
    this.parentNode = null;
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
    this._className = "";
    const self = this;
    this.classList = {
      set: new Set(),
      sync() {
        self._className = [...this.set].join(" ");
      },
      add(...tokens) {
        for (const t of tokens) if (t) this.set.add(t);
        this.sync();
      },
      remove(...tokens) {
        for (const t of tokens) this.set.delete(t);
        this.sync();
      },
      toggle(token, force) {
        const next = force === undefined ? !this.set.has(token) : Boolean(force);
        if (next) this.set.add(token);
        else this.set.delete(token);
        this.sync();
        return next;
      },
      contains(token) {
        return this.set.has(token);
      },
    };
  }
  get className() {
    return this._className;
  }
  set className(v) {
    this._className = String(v);
    this.classList.set = new Set(this._className.split(/\s+/).filter(Boolean));
  }
  get parentElement() {
    return this.parentNode;
  }
  get lastElementChild() {
    return this.children.at(-1) ?? null;
  }
  get previousElementSibling() {
    if (!this.parentNode) return null;
    const idx = this.parentNode.children.indexOf(this);
    return idx > 0 ? this.parentNode.children[idx - 1] : null;
  }
  detach(child) {
    if (child.parentNode) {
      child.parentNode.children = child.parentNode.children.filter(
        (c) => c !== child,
      );
      child.parentNode = null;
    }
  }
  append(...children) {
    for (const child of children) {
      this.detach(child);
      child.parentNode = this;
      this.children.push(child);
    }
    if (this.tagName === "SELECT" && !this.value) {
      this.value = this.children[0]?.value ?? "";
    }
  }
  prepend(...children) {
    for (const child of children) {
      this.detach(child);
      child.parentNode = this;
    }
    this.children.unshift(...children);
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
  replaceChildren(...nodes) {
    for (const c of this.children) c.parentNode = null;
    this.children = [];
    this.value = "";
    this.append(...nodes);
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }
  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }
  removeAttribute(name) {
    this.attributes.delete(name);
  }
  addEventListener(type, callback) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(callback);
  }
  removeEventListener(type, callback) {
    this.listeners.get(type)?.delete(callback);
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
    this.detach(this);
  }
}

function vehiclePanelFixture(t) {
  const savedDocument = globalThis.document;
  const doc = new DomElement("document", null);
  doc.document = doc;
  doc.createElement = (tag) => new DomElement(tag, doc);
  doc.body = doc.createElement("body");
  doc.append(doc.body);
  globalThis.document = doc;

  const toolbar = doc.createElement("nav");
  doc.body.append(toolbar);
  const panel = mountVehiclePanel({
    toolbar,
    onAction: () => ({ ok: true }),
  });
  const find = (pred, root = doc) =>
    pred(root)
      ? root
      : root.children.map((c) => find(pred, c)).find(Boolean);
  const byId = (id) => find((el) => el.id === id);

  t.after(() => {
    panel.dispose();
    if (savedDocument === undefined) delete globalThis.document;
    else globalThis.document = savedDocument;
  });

  return {
    panel,
    byId,
    state: {
      world: { environment: "metro", sensors: { rawM: [12, 14, 9.5, 18, 35] } },
      actor: {
        id: "player",
        type: "vehicle",
        x: 0,
        z: 0,
        heading: 0,
        length: 4.2,
        width: 1.85,
        speed: 8,
        vehicle: createVehicleState(),
      },
      rig: { root: {}, diagnostics: { ready: true } },
      mode: "chase",
      cutaway: false,
      sensors: false,
      sensorCamera: "front",
    },
  };
}

test("buildTerrainRoadParts conforms orthogonal and diagonal roads, sidewalks, lane markings, and retaining walls over a +3.2 m hill", () => {
  // Smooth 3.2 m hill centered at (18, -8) with radius 62 m (zero beyond 115 m so flat stretches also get tested)
  const hillCenter = { x: 18, z: -8 };
  const hillRadius = 92;
  const elevationAt = (x, z) => {
    const r = Math.hypot(x - hillCenter.x, z - hillCenter.z);
    if (r >= hillRadius) return 0;
    const t = r / hillRadius;
    const smooth = 0.5 * (1 + Math.cos(Math.PI * t));
    return 3.2 * smooth;
  };

  const world = makeHillWorld(elevationAt);
  const parts = buildTerrainRoadParts(
    world.roads,
    world.drivingRoads,
    elevationAt,
    { metro: true, cityStreetFinish: true },
  );

  assert.equal(parts.roadParts.length, 3);
  assert.equal(parts.pavementParts.length, 3);
  assert.ok(parts.markingParts.length > 20, "expected center dashes and crosswalk stripes");
  assert.ok(parts.retainingParts.length >= 3, "expected bridge/ramp retaining walls on >= 1.15 m crest");

  // Validate attributes & indexed consistency on every individual part
  for (const [label, group, expectColor] of [
    ["pavement", parts.pavementParts, false],
    ["road", parts.roadParts, false],
    ["markings", parts.markingParts, true],
    ["retaining", parts.retainingParts, false],
  ]) {
    for (const geom of group) {
      assert.ok(geom.index !== null, `${label} part must be indexed`);
      const pos = geom.getAttribute("position");
      const norm = geom.getAttribute("normal");
      const uv = geom.getAttribute("uv");
      assert.ok(pos && pos.count > 0, `${label} position attribute`);
      assert.ok(norm && norm.count === pos.count, `${label} normal attribute`);
      assert.ok(uv && uv.count === pos.count, `${label} uv attribute`);
      if (expectColor) {
        const col = geom.getAttribute("color");
        assert.ok(col && col.count === pos.count, "marking color attribute");
      }
      assert.ok(pos.array.every(Number.isFinite), `${label} positions finite`);
      assert.ok(norm.array.every(Number.isFinite), `${label} normals finite`);
      assert.ok(uv.array.every(Number.isFinite), `${label} uvs finite`);
    }
  }

  // Merge every group cleanly with mergeGeometries (and verify pavement+retaining can merge too)
  const mergedPavement = mergeGeometries(parts.pavementParts);
  const mergedRoad = mergeGeometries(parts.roadParts);
  const mergedMarkings = mergeGeometries(parts.markingParts);
  const mergedRetaining = mergeGeometries(parts.retainingParts);
  const mergedConcreteAll = mergeGeometries([
    ...parts.pavementParts,
    ...parts.retainingParts,
  ]);
  assert.ok(mergedPavement && mergedRoad && mergedMarkings && mergedRetaining && mergedConcreteAll);

  const pavementMesh = new THREE.Mesh(mergedPavement, new THREE.MeshStandardMaterial());
  const roadMesh = new THREE.Mesh(mergedRoad, new THREE.MeshStandardMaterial());
  const markingsMesh = new THREE.Mesh(mergedMarkings, new THREE.MeshStandardMaterial());
  const retainingMesh = new THREE.Mesh(mergedRetaining, new THREE.MeshStandardMaterial());
  for (const m of [pavementMesh, roadMesh, markingsMesh, retainingMesh]) {
    m.updateMatrixWorld(true);
  }

  const raycaster = new THREE.Raycaster();
  const down = new THREE.Vector3(0, -1, 0);

  const assertRoadAndSidewalkAt = (road, alongList, label) => {
    let sawCrest = false;
    const roadNormAttr = mergedRoad.getAttribute("normal");
    const paveNormAttr = mergedPavement.getAttribute("normal");

    for (const along of alongList) {
      for (const latOffset of [-road.width * 0.32, 0, road.width * 0.32]) {
        const pt = roadPointAt(road, along, latOffset);
        const elev = elevationAt(pt.x, pt.z);
        if (elev > 2.9) sawCrest = true;

        raycaster.set(new THREE.Vector3(pt.x, 25, pt.z), down);
        const hit = raycaster.intersectObject(roadMesh, false)[0];
        assert.ok(hit, `${label} road raycast hit at along=${along}, lat=${latOffset}`);
        const expectedY = ROAD_TOP_OFFSET_M + elev;
        assert.ok(
          Math.abs(hit.point.y - expectedY) <= 0.03,
          `${label} road y=${hit.point.y.toFixed(4)} vs expected ${expectedY.toFixed(4)} (diff=${Math.abs(hit.point.y - expectedY).toFixed(4)})`,
        );
        assert.ok(hit.face.normal.y > 0.85, `${label} face normal.y=${hit.face.normal.y}`);
        for (const vIdx of [hit.face.a, hit.face.b, hit.face.c]) {
          assert.ok(
            roadNormAttr.getY(vIdx) > 0.85,
            `${label} vertex normal.y=${roadNormAttr.getY(vIdx)}`,
          );
        }
        assert.ok(
          Math.abs(hit.uv.x - pt.x / 2.5) < 0.02 &&
            Math.abs(hit.uv.y - pt.z / 2.5) < 0.02,
          `${label} world-metre UV (${hit.uv.x}, ${hit.uv.y}) should match (${pt.x / 2.5}, ${pt.z / 2.5})`,
        );
      }

      // Check sidewalk outside all intersecting roads
      for (const side of [-1, 1]) {
        const sw = roadPointAt(road, along, side * (road.width / 2 + 1.35));
        // Skip if this sidewalk point happens to fall on another crossing road's asphalt
        raycaster.set(new THREE.Vector3(sw.x, 25, sw.z), down);
        if (raycaster.intersectObject(roadMesh, false).length > 0) continue;

        const swHit = raycaster.intersectObject(pavementMesh, false)[0];
        assert.ok(swHit, `${label} sidewalk hit at along=${along}, side=${side}`);
        const expectedSwY = PAVEMENT_TOP_OFFSET_M + elevationAt(sw.x, sw.z);
        assert.ok(
          Math.abs(swHit.point.y - expectedSwY) <= 0.03,
          `${label} sidewalk y=${swHit.point.y.toFixed(4)} vs expected ${expectedSwY.toFixed(4)}`,
        );
        assert.ok(swHit.face.normal.y > 0.85, `${label} sidewalk face normal.y=${swHit.face.normal.y}`);
        for (const vIdx of [swHit.face.a, swHit.face.b, swHit.face.c]) {
          assert.ok(
            paveNormAttr.getY(vIdx) > 0.85,
            `${label} sidewalk vertex normal.y=${paveNormAttr.getY(vIdx)}`,
          );
        }
        assert.ok(
          Math.abs(swHit.uv.x - sw.x / 1.8) < 0.02 &&
            Math.abs(swHit.uv.y - sw.z / 1.8) < 0.02,
          `${label} sidewalk world-metre UV`,
        );
      }
    }
    assert.equal(sawCrest, true, `${label} samples must traverse the +3.2 m hill crest`);
  };

  assertRoadAndSidewalkAt(
    world.orthoZ,
    [-190, -120, -65, -35, -18, -8, 5, 22, 50, 95, 175],
    "orthoZ",
  );
  assertRoadAndSidewalkAt(
    world.orthoX,
    [-185, -110, -50, -15, 5, 18, 35, 65, 120, 185],
    "orthoX",
  );
  assertRoadAndSidewalkAt(
    world.diagAve,
    [20, 85, 145, 195, 225, 248, 275, 315, 370, 440],
    "diagAve",
  );

  // Verify every lane marking vertex & centroid sits cleanly above the asphalt mesh (zero buried dashes!)
  let pitchedMarkings = 0;
  for (const markGeom of parts.markingParts) {
    const mPos = markGeom.getAttribute("position");
    const mNorm = markGeom.getAttribute("normal");
    let minVy = Infinity;
    let maxVy = -Infinity;
    let sumX = 0;
    let sumZ = 0;
    for (let i = 0; i < mPos.count; i++) {
      const vx = mPos.getX(i);
      const vy = mPos.getY(i);
      const vz = mPos.getZ(i);
      minVy = Math.min(minVy, vy);
      maxVy = Math.max(maxVy, vy);
      sumX += vx;
      sumZ += vz;
      assert.ok(mNorm.getY(i) > 0.85, `marking normal.y=${mNorm.getY(i)}`);

      raycaster.set(new THREE.Vector3(vx, 25, vz), down);
      const asphaltHit = raycaster.intersectObject(roadMesh, false)[0];
      assert.ok(asphaltHit, "marking vertex must lie over asphalt");
      const clearance = vy - asphaltHit.point.y;
      assert.ok(
        clearance >= 0.002 && clearance <= 0.025,
        `marking vertex clearance=${clearance.toFixed(5)}m must stay cleanly above asphalt without floating`,
      );
    }
    if (maxVy - minVy > 0.05) {
      pitchedMarkings++;
      // Verify midpoint raycast onto mergedMarkings is also above mergedRoad!
      const cx = sumX / mPos.count;
      const cz = sumZ / mPos.count;
      raycaster.set(new THREE.Vector3(cx, 25, cz), down);
      const mHit = raycaster.intersectObject(markingsMesh, false)[0];
      const rHit = raycaster.intersectObject(roadMesh, false)[0];
      if (mHit && rHit) {
        assert.ok(
          mHit.point.y > rHit.point.y + 0.002 &&
            mHit.point.y < rHit.point.y + 0.02,
          `sloped marking midpoint must raycast above asphalt (${mHit.point.y} vs ${rHit.point.y})`,
        );
      }
    }
  }
  assert.ok(pitchedMarkings >= 6, `expected sloped dashes pitched along hill grade, got ${pitchedMarkings}`);

  // Verify bridge/ramp retaining walls where elev >= 1.2 m extend down to y = -0.06
  mergedRetaining.computeBoundingBox();
  assert.ok(
    Math.abs(mergedRetaining.boundingBox.min.y - RETAINING_BASE_Y_M) < 1e-5,
    `retaining walls must reach base y=${RETAINING_BASE_Y_M}, got ${mergedRetaining.boundingBox.min.y}`,
  );
  assert.ok(
    mergedRetaining.boundingBox.max.y > 2.8,
    `retaining walls must rise under the +3.2 m crest, got max.y=${mergedRetaining.boundingBox.max.y}`,
  );

  // Horizontal side raycast at mid-height (y = 0.8 m) against orthoZ where elev(12, -8) ~ 3.18 m >= 1.2 m
  const crestZ = -40; // away from orthoX intersection at z = -10, elev(12, -40) ~ 2.49 m >= 1.2 m
  assert.ok(elevationAt(12, crestZ) >= 1.2);
  raycaster.set(
    new THREE.Vector3(12 + 25, 0.8, crestZ),
    new THREE.Vector3(-1, 0, 0),
  );
  const wallHit = raycaster.intersectObject(retainingMesh, false)[0];
  assert.ok(wallHit, "horizontal raycast must strike concrete retaining embankment wall where elev >= 1.2 m");
  assert.ok(wallHit.point.x > 12 + world.orthoZ.width / 2 + 2.2);

  for (const g of [
    ...parts.pavementParts,
    ...parts.roadParts,
    ...parts.markingParts,
    ...parts.retainingParts,
    mergedPavement,
    mergedRoad,
    mergedMarkings,
    mergedRetaining,
    mergedConcreteAll,
  ]) {
    g.dispose();
  }
});

test("flat elevationAt = () => 0 keeps road top at 0.115 and sidewalk top at 0.07 within 1e-6 and emits zero retaining walls", (t) => {
  const world = makeHillWorld(() => 0);
  const scene = new THREE.Scene();
  const surfaces = { road: [], pavement: [] };
  const built = buildElevatedRoadMeshes(world, { scene, surfaces });
  t.after(() => built.dispose());

  assert.ok(built.roadMesh && built.pavementMesh && built.markingsMesh);
  assert.equal(built.retainingMesh, null, "flat terrain must not emit retaining walls");
  assert.equal(built.diagnostics.retainingCount, 0);
  assert.equal(surfaces.road.length, 1);
  assert.equal(surfaces.pavement.length, 1);
  // Flat stretches use coarse ~18m subdivision, keeping triangle count tiny
  assert.ok(
    built.diagnostics.triangles < 1200,
    `expected compact flat triangle count, got ${built.diagnostics.triangles}`,
  );

  scene.updateMatrixWorld(true);
  const raycaster = new THREE.Raycaster();
  const down = new THREE.Vector3(0, -1, 0);

  for (const [road, along] of [
    [world.orthoZ, 80],
    [world.orthoX, -90],
    [world.diagAve, 110],
  ]) {
    const onRoad = roadPointAt(road, along, 1.8);
    raycaster.set(new THREE.Vector3(onRoad.x, 10, onRoad.z), down);
    const roadHit = raycaster.intersectObject(built.roadMesh, false)[0];
    assert.ok(roadHit);
    assert.ok(
      Math.abs(roadHit.point.y - 0.115) < 1e-6,
      `${road.id} flat road y=${roadHit.point.y} must be 0.115 within 1e-6`,
    );
    assert.ok(roadHit.face.normal.y > 0.999999);

    const onSidewalk = roadPointAt(road, along, road.width / 2 + 1.4);
    raycaster.set(new THREE.Vector3(onSidewalk.x, 10, onSidewalk.z), down);
    const swHit = raycaster.intersectObject(built.pavementMesh, false)[0];
    assert.ok(swHit);
    assert.ok(
      Math.abs(swHit.point.y - 0.07) < 1e-6,
      `${road.id} flat sidewalk y=${swHit.point.y} must be 0.07 within 1e-6`,
    );
    assert.ok(swHit.face.normal.y > 0.999999);
  }

  // Verify markings on flat road sit at MARKING_TOP_OFFSET_M (0.1205) within 1e-6
  const mPos = built.markingsMesh.geometry.getAttribute("position");
  for (let i = 0; i < mPos.count; i++) {
    assert.ok(Math.abs(mPos.getY(i) - MARKING_TOP_OFFSET_M) < 1e-6);
  }
});

test("mountVehiclePanel updates #carSurfaceStatus and data-surface across asphalt, sand, water, cobble, uphill +8.5%, and downhill -6.5%", (t) => {
  const f = vehiclePanelFixture(t);
  f.panel.update(f.state);

  const telemetry = f.byId("carTelemetry");
  const status = f.byId("carSurfaceStatus");
  assert.ok(status, "#carSurfaceStatus must exist inside Car panel");
  assert.equal(status.parentNode, telemetry);
  assert.equal(telemetry.children[2], status, "preserves IMU children[0] and GNSS children[1]");

  // 1. Default when actor.vehicle.surface is absent
  assert.equal(status.hidden, false);
  assert.equal(status.textContent, "Surface: Asphalt · Grip 100% · Level grade");
  assert.equal(status.getAttribute("data-surface"), "asphalt");
  assert.equal(status.dataset.surface, "asphalt");

  // 2. Explicit flat asphalt
  f.state.actor.vehicle.surface = { kind: "asphalt", grip: 1.0, gradePct: 0.4 };
  f.panel.update(f.state);
  assert.equal(status.textContent, "Surface: Asphalt · Grip 100% · Level grade");
  assert.equal(status.getAttribute("data-surface"), "asphalt");

  // 3. Sandy street
  f.state.actor.vehicle.surface = { kind: "sand", grip: 0.62, gradePct: 0 };
  f.panel.update(f.state);
  assert.equal(status.textContent, "Surface: Sandy street · Grip 62% · Sand drag");
  assert.equal(status.getAttribute("data-surface"), "sand");
  assert.equal(status.dataset.surface, "sand");

  // 4. Standing water puddle
  f.state.actor.vehicle.surface = { kind: "water", grip: 0.52, gradePct: -0.3 };
  f.panel.update(f.state);
  assert.equal(status.textContent, "Surface: Standing water · Grip 52% · Wet traction");
  assert.equal(status.getAttribute("data-surface"), "water");
  assert.equal(status.dataset.surface, "water");

  // 5. Cobblestone
  f.state.actor.vehicle.surface = { kind: "cobble", grip: 0.82, gradePct: 0.2 };
  f.panel.update(f.state);
  assert.equal(status.textContent, "Surface: Cobblestone · Grip 82% · Stone rumble");
  assert.equal(status.getAttribute("data-surface"), "cobble");
  assert.equal(status.dataset.surface, "cobble");

  // 6. Uphill +8.5%
  f.state.actor.vehicle.surface = { kind: "asphalt", grip: 1.0, gradePct: 8.5 };
  f.panel.update(f.state);
  assert.equal(status.textContent, "Surface: Asphalt · Grip 100% · Uphill +8.5%" );
  assert.equal(status.getAttribute("data-surface"), "asphalt");

  // 7. Downhill -6.5% (also verify rise/run grade ratio support)
  f.state.actor.vehicle.surface = { kind: "asphalt", grip: 1.0, grade: -0.065 };
  f.panel.update(f.state);
  assert.equal(status.textContent, "Surface: Asphalt · Grip 100% · Downhill -6.5%");
  assert.equal(status.getAttribute("data-surface"), "asphalt");

  // 8. State-level surface override & graceful recovery when surface is cleared
  f.state.actor.vehicle.surface = undefined;
  f.state.surface = { type: "cobblestone", gripPct: 80, slopePct: 8.4 };
  f.panel.update(f.state);
  assert.equal(status.textContent, "Surface: Cobblestone · Grip 80% · Uphill +8.4%");
  assert.equal(status.getAttribute("data-surface"), "cobble");

  delete f.state.surface;
  f.panel.update(f.state);
  assert.equal(status.textContent, "Surface: Asphalt · Grip 100% · Level grade");
  assert.equal(status.getAttribute("data-surface"), "asphalt");
  assert.equal(describeRoadSurface(null).text, "Surface: Asphalt · Grip 100% · Level grade");

  // 9. Exact vehicle-state / city-surfaces schema ({ surfaceKind, gripMultiplier, gradeSin })
  f.state.actor.vehicle.surface = {
    surfaceKind: "sand",
    gripMultiplier: 0.62,
    gradeSin: 0,
  };
  f.panel.update(f.state);
  assert.equal(status.textContent, "Surface: Sandy street · Grip 62% · Sand drag");
  assert.equal(status.getAttribute("data-surface"), "sand");

  f.state.actor.vehicle.surface = {
    kind: "water",
    gripMultiplier: 0.52,
    gradeSin: -0.065,
    gradePct: -6.5,
  };
  f.panel.update(f.state);
  assert.equal(status.textContent, "Surface: Standing water · Grip 52% · Downhill -6.5%");
  assert.equal(status.getAttribute("data-surface"), "water");
});

test("mountPursuitPanel keeps surface readout hidden by default and shows notable surface/grade telemetry cleanly", (t) => {
  const doc = {
    createElement(tag) {
      return new DomElement(tag, doc);
    },
  };
  const container = doc.createElement("div");
  const panel = mountPursuitPanel({
    container,
    onRun: () => true,
    onRestart: () => true,
    onLevel: () => true,
  });
  t.after(() => panel.close());

  const byId = (id, root = container) =>
    root.id === id
      ? root
      : root.children.map((c) => byId(id, c)).find(Boolean) ?? null;

  panel.update({
    phase: "running",
    street: true,
    cinematic: true,
    variant: "gta",
    wantedLevel: 3,
    speedMps: 14,
    patrolStatus: { active: 3, nearestM: 24 },
    gta: { playerHealth: 95, playerMaxHealth: 100 },
    metrics: {},
  });
  const liveSurface = byId("pursuitSurfaceStatus");
  assert.ok(liveSurface);
  assert.equal(liveSurface.hidden, true);

  panel.update({
    phase: "running",
    street: true,
    cinematic: true,
    variant: "gta",
    wantedLevel: 3,
    speedMps: 14,
    patrolStatus: { active: 3, nearestM: 24 },
    gta: { playerHealth: 95, playerMaxHealth: 100 },
    surface: { kind: "sand", grip: 0.62, gradePct: 8.4 },
    metrics: {},
  });
  assert.equal(liveSurface.hidden, false);
  assert.equal(liveSurface.getAttribute("data-surface"), "sand");
  assert.equal(liveSurface.textContent, "Sandy street · Grip 62% · Uphill +8.4%");
});

test("buildElevatedRoadMeshes scales across full Grand Metro City v5 with +4.2 m overpass hills, non-v4 finish, and idempotent disposal", () => {
  const grand = createUnifiedCity({ grand: true });
  const elevationAt = (x, z) => {
    const hillA = 4.2 * Math.exp(-((x - 80) ** 2 + (z + 60) ** 2) / (85 ** 2));
    const hillB = 2.6 * Math.exp(-((x + 190) ** 2 + (z - 140) ** 2) / (70 ** 2));
    const total = hillA + hillB;
    return total < 0.01 ? 0 : total;
  };
  const scene = new THREE.Scene();
  const surfaces = { road: [], pavement: [] };
  const built = buildElevatedRoadMeshes(
    { ...grand, environment: "metro", config: { cityVersion: 5 }, elevationAt },
    { scene, surfaces },
  );

  assert.ok(built.roadMesh && built.pavementMesh && built.markingsMesh && built.retainingMesh);
  assert.equal(surfaces.road.length, 1);
  assert.equal(surfaces.pavement.length, 2, "pavement + retaining walls registered for concrete texture decoration");
  assert.ok(
    built.diagnostics.triangles < 45000,
    `Grand Metro City road + retaining triangles should stay lean for 60 FPS, got ${built.diagnostics.triangles}`,
  );

  let geomDisposals = 0;
  let matDisposals = 0;
  for (const m of built.meshes) {
    m.geometry.addEventListener("dispose", () => geomDisposals++);
    m.material.addEventListener("dispose", () => matDisposals++);
  }
  const meshCount = built.meshes.length;
  built.dispose();
  built.dispose();
  assert.equal(geomDisposals, meshCount);
  assert.equal(matDisposals, meshCount);
  assert.equal(scene.children.length, 0);

  // Verify non-cityStreetFinish (3D Box-like markings without vertexColors) also merges cleanly
  const classicWorld = makeHillWorld((x, z) =>
    1.8 * Math.exp(-(x * x + z * z) / (55 ** 2)),
  );
  const classicBuilt = buildElevatedRoadMeshes(classicWorld, {
    cityStreetFinish: false,
    metro: false,
    environment: "city",
  });
  assert.ok(classicBuilt.markingsMesh);
  assert.equal(classicBuilt.markingsMesh.material.vertexColors, false);
  assert.equal(classicBuilt.markingsMesh.castShadow, true);
  classicBuilt.dispose();
});

