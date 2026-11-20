import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as THREE from "three";
import { roadRect } from "../src/core/geometry.js";
import { createUnifiedCity } from "../src/core/unified-city.js";
import { createEgyptStreetLayer } from "../src/render/egypt-streets.js";

const BASE_Y = 0.12;
const EPS = 0.00005;

function makeLayer(t, world) {
  const layer = createEgyptStreetLayer(world);
  t.after(() => layer.dispose());
  layer.root.updateMatrixWorld(true);
  return layer;
}

function geometryHash(root) {
  const hash = createHash("sha256");
  for (const mesh of root.children) {
    hash.update(mesh.name);
    for (const [name, { array }] of Object.entries(mesh.geometry.attributes)) {
      hash.update(name);
      hash.update(Buffer.from(array.buffer, array.byteOffset, array.byteLength));
    }
  }
  return hash.digest("hex");
}

function fitsRegisteredBodies(layer, statics) {
  const buildings = statics.filter((site) => site.kind === "building");
  const byId = new Map(buildings.map((site) => [site.id, site]));
  assert.deepEqual(new Set(layer.diagnostics.siteIds), new Set(byId.keys()));
  assert.equal(layer.diagnostics.siteIds.length, byId.size);
  const measured = new Map();
  for (const id of layer.diagnostics.siteIds) {
    const body = byId.get(id);
    measured.set(id, {
      body, c: Math.cos(body.heading ?? 0), s: Math.sin(body.heading ?? 0),
      min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity], floorY: 0,
    });
  }
  for (const mesh of layer.root.children) {
    const { position, siteIndex, featureIndex } = mesh.geometry.attributes;
    for (let i = 0; i < position.count; i++) {
      const index = siteIndex.getX(i);
      if (index < 0) continue;
      const id = layer.diagnostics.siteIds[index], entry = measured.get(id);
      assert.ok(entry, `Unknown site index ${index}`);
      const { body, c, s, min, max } = entry;
      const x = position.getX(i) - body.x, z = position.getZ(i) - body.z, y = position.getY(i) - BASE_Y;
      const v = [c * x - s * z, y, s * x + c * z];
      for (let axis = 0; axis < 3; axis++) {
        min[axis] = Math.min(min[axis], v[axis]);
        max[axis] = Math.max(max[axis], v[axis]);
      }
      if (layer.diagnostics.featureNames[featureIndex.getX(i)] === "window")
        entry.floorY = Math.max(entry.floorY, y);
    }
  }
  for (const [id, { body, min, max, floorY }] of measured) {
    const expected = [body.width / 2, body.height, body.length / 2];
    for (let axis = 0; axis < 3; axis++) {
      assert.ok(Math.abs(min[axis] - (axis === 1 ? 0 : -expected[axis])) < EPS, `${id} min ${axis}: ${min}`);
      assert.ok(Math.abs(max[axis] - expected[axis]) < EPS, `${id} max ${axis}: ${max}`);
    }
    assert.ok(floorY > body.height * 0.75, `${id} fills its height with floors, not just a tall roof ornament`);
  }
}

function cameraAt(position, target, aspect) {
  const camera = new THREE.PerspectiveCamera(62, aspect, 0.08, 250);
  camera.position.set(...position);
  camera.lookAt(...target);
  camera.updateMatrixWorld(true);
  return camera;
}

test("the actual metro registry becomes full-scale matte buildings with bounded, cullable batches", (t) => {
  const map = createUnifiedCity(), world = { ...map, environment: "metro" };
  const before = JSON.stringify(world), layer = makeLayer(t, world), { diagnostics, root } = layer;
  assert.equal(JSON.stringify(world), before);
  fitsRegisteredBodies(layer, map.statics);
  const byId = new Map(map.statics.map((s) => [s.id, s]));
  const avenue = diagnostics.sites.filter((s) => s.architecture === "boulevard");
  const local = diagnostics.sites.filter((s) => s.architecture === "neighborhood");
  assert.equal(avenue.length + local.length, diagnostics.siteIds.length);
  assert.ok(avenue.length >= 5 && local.length >= 5);
  assert.ok(diagnostics.sites.every((s) => s.architecture === byId.get(s.id).architecture));
  assert.ok(avenue.every((s) => map.drivingRoads.find((r) => r.id === s.facingRoadId)?.zone === "avenue"));
  const mean = (sites, f) => sites.reduce((sum, s) => sum + f(s), 0) / sites.length;
  assert.ok(mean(avenue, (s) => s.roofY) > mean(local, (s) => s.roofY) * 1.4);
  assert.ok(mean(avenue, (s) => s.upperFloors) > mean(local, (s) => s.upperFloors) + 2);
  assert.ok(diagnostics.counts.awnings > local.length && diagnostics.counts.laundry > local.length);

  const meshes = root.children;
  const triangles = (parts) => parts.reduce((sum, mesh) => sum + mesh.geometry.attributes.position.count / 3, 0);
  assert.equal(diagnostics.drawCalls, meshes.length);
  assert.equal(diagnostics.triangles, triangles(meshes));
  assert.ok(diagnostics.budget.withinBudget && meshes.length <= 78 && triangles(meshes) <= 165000);
  assert.equal(new Set(meshes.map((mesh) => mesh.material)).size, 3);
  for (const mesh of meshes) {
    assert.ok(mesh.isMesh && mesh.frustumCulled && mesh.geometry.boundingSphere?.radius > 0);
    assert.ok(mesh.material.roughness >= 0.9 && mesh.material.metalness === 0);
  }
  const start = map.playerStart, alley = map.drivingRoads.find((road) => road.id === "alley-west");
  for (const [x, z, heading] of [
    [start.x, start.z, start.heading], [alley.fixed, (alley.min + alley.max) / 2, 0],
  ]) {
    for (const aspect of [1365 / 900, 900 / 650]) {
      const camera = cameraAt([x, 1.75, z], [x + Math.sin(heading) * 10, 1.75, z + Math.cos(heading) * 10], aspect);
      const view = new THREE.Frustum().setFromProjectionMatrix(
        new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
      const candidates = meshes.filter((mesh) => view.intersectsObject(mesh));
      assert.ok(candidates.some((mesh) => mesh.castShadow), "the driving camera still sees actual building batches");
      assert.ok(triangles(candidates) < triangles(meshes) * 0.79, "a street view can cull distant batches");
    }
  }
});

function streetHits(layer, camera, siteId) {
  const hits = [], ray = new THREE.Raycaster(), point = new THREE.Vector2();
  for (let x = -0.92; x <= 0.93; x += 0.07) {
    for (let y = -0.92; y <= 0.93; y += 0.07) {
      ray.setFromCamera(point.set(x, y), camera);
      const [hit] = ray.intersectObjects(layer.root.children, false);
      if (!hit) continue;
      const attributes = hit.object.geometry.attributes;
      if (layer.diagnostics.siteIds[attributes.siteIndex.getX(hit.face.a)] !== siteId) continue;
      hits.push({ point: hit.point, normal: hit.face.normal,
        kind: layer.diagnostics.featureNames[attributes.featureIndex.getX(hit.face.a)] });
    }
  }
  return hits;
}

function storefrontDepth(hits, n) {
  const front = hits.filter(({ normal, point }) => n.dot(normal) > 0.98 && point.y > 0.8 && point.y < 1.95);
  const piers = front.filter((h) => h.kind === "masonry"), bays = front.filter((h) => h.kind === "shop");
  assert.ok(piers.length > 2 && bays.length > 2, "oblique street-eye rays must hit both piers and shop interiors");
  return Math.max(...piers.map(({ point }) => n.dot(point))) - Math.min(...bays.map(({ point }) => n.dot(point)));
}

test("oblique street-eye perspectives reach recessed shops, a real balcony, awning shade and a deeper avenue entrance", (t) => {
  const local = { id: "local-home", kind: "building", x: 0, z: -5.7,
    width: 10, length: 6, height: 15, heading: 0 };
  const avenue = { id: "avenue-hall", kind: "building", x: 76.4, z: 0,
    width: 16, length: 12, height: 28, heading: -Math.PI / 2, architecture: "boulevard" };
  const turn = { id: "rotated-house", kind: "building", x: -29, z: 25,
    width: 8, length: 12, height: 13, heading: Math.PI / 7 };
  const roads = [
    { id: "alley", axis: "x", fixed: 0, min: -35, max: 35, width: 3.8, zone: "neighborhood" },
    { id: "avenue", axis: "z", fixed: 60, min: -35, max: 35, width: 14, zone: "avenue" },
    { id: "parking-only", axis: "x", fixed: -9.5, min: -18, max: 17, width: 1, parkingBay: true },
  ];
  const world = { environment: "metro", roads, statics: [local, avenue, turn] };
  const layer = makeLayer(t, world);
  fitsRegisteredBodies(layer, world.statics);
  const localView = cameraAt([3.9, 1.72, 0], [local.x, 3.4, -2.7], 1365 / 900);
  const curbView = cameraAt([2.5, 1.72, -1.8], [local.x, 2.35, -2.7], 1365 / 900);
  const avenueView = cameraAt([60, 1.72, 9.5], [70.4, 5.2, 0], 900 / 650);
  const localHits = streetHits(layer, localView, local.id);
  const avenueHits = streetHits(layer, avenueView, avenue.id);
  const localDepth = storefrontDepth(localHits, new THREE.Vector3(0, 0, 1));
  const avenueDepth = storefrontDepth(avenueHits, new THREE.Vector3(-1, 0, 0));
  assert.ok(localDepth >= 0.29, `The shop is not just a texture plane: measured depth ${localDepth}`);
  assert.ok(avenueDepth >= localDepth + 0.16, `The avenue has deeper real bays: ${avenueDepth}`);
  assert.ok(localHits.some((h) => h.kind === "shop" && h.normal.y > 0.35 && h.normal.y < 0.995),
    "the middle of the lane sees the sloped canopy");
  assert.ok(streetHits(layer, curbView, local.id).some((h) => h.kind === "shop" && h.normal.y < -0.35 && h.normal.y > -0.995),
    "the curb near the shop sees the shaded underside of that canopy");
  assert.ok(localHits.some((h) => h.kind === "balcony" && h.point.z > -2.80 && h.point.y > 3.4),
    "the street view sees an upper balcony projecting to the hull");
  assert.ok(avenueHits.some((h) => h.kind === "window" && h.point.y > 7));
  assert.ok(!avenueHits.some((h) => h.kind === "balcony"), "ordered avenue frontage is not a scaled-up lane house");
  const record = layer.diagnostics.sites.find((s) => s.id === local.id);
  assert.equal(record.architecture, "neighborhood");
  assert.equal(record.facingRoadId, "alley", "a closer parking reservation does not become the main frontage");
  const reversed = makeLayer(t, { ...world, roads: roads.toReversed(), statics: world.statics.toReversed() });
  assert.equal(geometryHash(reversed.root), geometryHash(layer.root));
});

test("avenue stone edges sit outside actual road and junction volumes and leave the narrow lane flat", (t) => {
  const roads = [
    { id: "avenue", axis: "z", fixed: 0, min: -31, max: 31, width: 14, zone: "avenue" },
    { id: "local", axis: "x", fixed: 0, min: -30, max: 30, width: 3.8, zone: "neighborhood" },
    { id: "mouth", axis: "x", fixed: 22, min: -2, max: 10, width: 8, parkingBay: true, supportApron: true },
  ];
  const layer = makeLayer(t, { environment: "metro", roads, statics: [] });
  const curb = layer.root.getObjectByName("egypt-painted-curb").geometry.attributes.position;
  const bounds = roads.map((r) => roadRect(r));
  let stone = 0, paint = 0;
  for (let i = 0; i < curb.count; i += 3) {
    const indices = [i, i + 1, i + 2];
    if (indices.every((n) => Math.abs(curb.getY(n) - 0.08) < EPS)) { paint++; continue; }
    const xs = indices.map((n) => curb.getX(n)), zs = indices.map((n) => curb.getZ(n));
    const heights = indices.map((n) => curb.getY(n));
    assert.ok(indices.every((_, n) => Math.abs(xs[n]) > 7 && Math.abs(xs[n]) < 7.5
      && heights[n] >= 0.115 && heights[n] <= 0.18));
    for (const { minX, maxX, minZ, maxZ } of bounds)
      assert.ok(Math.max(...xs) <= minX || Math.min(...xs) >= maxX ||
        Math.max(...zs) <= minZ || Math.min(...zs) >= maxZ, "a stone strip must stop at every drivable crossing");
    stone++;
  }
  assert.ok(stone > 6 && paint > 6, "avenue stone and level lane paint are both present");
});

test("metro reuses one locally authored atlas per layer and disposes it and the batch geometries once", (t) => {
  const old = Object.getOwnPropertyDescriptor(globalThis, "document"), labels = [], canvases = [];
  Object.defineProperty(globalThis, "document", { configurable: true, value: {
    createElement(tag) {
      assert.equal(tag, "canvas");
      const ctx = { fillRect() {}, fillText(text) { labels.push(text); } };
      const canvas = { getContext(kind) { assert.equal(kind, "2d"); return ctx; } };
      canvases.push(canvas);
      return canvas;
    },
  } });
  t.after(() => {
    if (old) Object.defineProperty(globalThis, "document", old);
    else delete globalThis.document;
  });
  const statics = [-45, 70].map((x) => ({ id: `site-${x}`, x, z: 0, width: 11,
    length: 10, height: 19, kind: "building" }));
  const layer = makeLayer(t, { environment: "metro", statics, roads: [] });
  const textures = new Set(layer.root.children.map((mesh) => mesh.material.map).filter(Boolean));
  assert.equal(canvases.length, 1);
  assert.equal(textures.size, 1);
  const [texture] = textures;
  assert.ok(texture.isCanvasTexture && texture.image === canvases[0] && layer.diagnostics.textAtlasAvailable);
  assert.ok(labels.includes("بقالة") && labels.includes("فرن بلدي"));
  const geometries = layer.root.children.map((mesh) => mesh.geometry);
  const materials = new Set(layer.root.children.map((mesh) => mesh.material));
  const disposals = new Map([...geometries, ...materials, texture].map((resource) => [resource, 0]));
  for (const resource of disposals.keys())
    resource.addEventListener("dispose", () => disposals.set(resource, disposals.get(resource) + 1));
  layer.dispose();
  layer.dispose();
  assert.ok([...disposals.values()].every((count) => count === 1));
  assert.equal(layer.root.children.length, 0);
});

test("existing city, vision and district geometry is byte-for-byte unchanged and ignores metro tags", (t) => {
  const roads = [
    { id: "legacy-road", axis: "x", fixed: -3, min: -35, max: 35, width: 7, zone: "avenue" },
    { id: "legacy-side", axis: "z", fixed: 4, min: -30, max: 30, width: 6 },
  ];
  const statics = [
    { kind: "building", id: "legacy-east", x: 17, z: 8, width: 8, length: 10, height: 18.2,
      heading: Math.PI / 5, architecture: "boulevard" },
    { kind: "building", id: "legacy-west", x: -18, z: -13, width: 8, length: 9, height: 13, heading: 0 },
  ];
  for (const environment of ["city", "vision", "egypt"]) {
    const layer = makeLayer(t, { environment, roads, statics });
    assert.equal(geometryHash(layer.root), "11c62cf179b331cb03f57fa1e40eab08779221d4d3c3e5ffb9c98571f0891863");
    assert.equal(layer.diagnostics.budget.maxTriangles, 100000);
  }
  for (const environment of ["lab", "vehicle", "pursuit"]) {
    const layer = makeLayer(t, { environment, roads, statics });
    assert.equal(layer.diagnostics.active, false);
    assert.equal(layer.root.children.length, 0);
  }
});
