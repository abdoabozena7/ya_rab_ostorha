import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as THREE from "three";
import { createEgyptStreetLayer } from "../src/render/egypt-streets.js";
import { cityFootprints } from "../src/core/scenery.js";
import { roadLayout } from "../src/core/roads.js";
import { createRoadGraph } from "../src/core/navigation.js";
import { parkingBays } from "../src/core/arrival.js";
import { junctionGroups } from "../src/core/junctions.js";
import { World } from "../src/core/world.js";

function city() {
  const drivingRoads = roadLayout(100).roads, graph = createRoadGraph(drivingRoads);
  const junctions = [...graph.values()].filter((node) => node.edges.length >= 3);
  const roads = [...drivingRoads, ...parkingBays(graph, junctionGroups(junctions), drivingRoads)];
  return { environment: "city", config: { seed: "cairo-42", traffic: 28, pedestrians: 32 },
    roads, statics: cityFootprints(roads), actors: [{ id: "untouched", x: 14.4, z: -40 }] };
}

function freeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}

function canvasAdapter(t) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document"), canvases = [];
  Object.defineProperty(globalThis, "document", {
    configurable: true, value: {
      createElement(tag) {
        assert.equal(tag, "canvas");
        const operations = [], context = {
          fillRect(...args) { operations.push(["rect", ...args, this.fillStyle]); },
          fillText(...args) {
            operations.push(["text", ...args, this.font, this.fillStyle, this.direction, this.textAlign]);
          },
        };
        const canvas = { width: 0, height: 0, operations,
          getContext(kind) { assert.equal(kind, "2d"); return context; } };
        canvases.push(canvas);
        return canvas;
      },
    },
  });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "document", previous);
    else delete globalThis.document;
  });
  return canvases;
}

function fixture(t, world = city()) {
  const layer = createEgyptStreetLayer(world);
  t.after(() => layer.dispose());
  return layer;
}

function geometryHash(root) {
  const hash = createHash("sha256");
  root.traverse((part) => {
    if (!part.isMesh) return;
    hash.update(part.name);
    for (const [name, attribute] of Object.entries(part.geometry.attributes)) {
      hash.update(name);
      hash.update(Buffer.from(attribute.array.buffer, attribute.array.byteOffset, attribute.array.byteLength));
    }
  });
  return hash.digest("hex");
}

function measuredResources(root) {
  const geometries = new Set(), materials = new Set(), textures = new Set();
  let draws = 0, triangles = 0;
  root.traverse((part) => {
    if (!part.isMesh) return;
    draws++;
    triangles += (part.geometry.index?.count ?? part.geometry.attributes.position.count) / 3;
    geometries.add(part.geometry);
    for (const material of Array.isArray(part.material) ? part.material : [part.material]) {
      materials.add(material);
      if (material.map) textures.add(material.map);
    }
  });
  return { geometries, materials, textures, draws, triangles };
}

test("the complete default district replaces every registered building, not stalls or signs, without mutating its world", (t) => {
  const world = new World(), before = JSON.stringify(world);
  const layer = fixture(t, freeze(world)), sourceIds = world.statics.filter((site) => site.kind === "building").map((site) => site.id).sort();
  assert.equal(world.config.traffic, 28);
  assert.equal(world.config.pedestrians, 32);
  assert.equal(sourceIds.length, 78);
  assert.deepEqual([...layer.diagnostics.siteIds].sort(), sourceIds);
  assert.equal(new Set(layer.diagnostics.siteIds).size, sourceIds.length);
  assert.equal(layer.diagnostics.sites.length, sourceIds.length);
  assert.equal(JSON.stringify(world), before);
  assert.equal(layer.root.parent, null);
  assert.ok(layer.diagnostics.sites.every((site) => site.upperFloors >= 2 && site.upperFloors <= 5));
  assert.equal(new Set(layer.diagnostics.sites.map((site) => site.style)).size, 4);
});

test("geometry and locally drawn Arabic/material atlas are deterministic even when input site/road order changes", (t) => {
  const canvases = canvasAdapter(t), world = city();
  const a = fixture(t, world);
  const b = fixture(t, { ...world, roads: [...world.roads].reverse(), statics: [...world.statics].reverse() });
  assert.equal(geometryHash(a.root), geometryHash(b.root));
  assert.deepEqual(a.diagnostics, b.diagnostics);
  assert.deepEqual(canvases[0].operations, canvases[1].operations);
  assert.equal(canvases.length, 2);
  assert.ok(canvases[0].operations.filter((operation) => operation[0] === "rect")
    .every((operation) => operation[3] >= 0 && operation[4] >= 0));
  const texts = canvases[0].operations.filter((operation) => operation[0] === "text");
  for (const label of ["بقالة", "صيدلية", "فرن بلدي", "ورشة", "قهوة"])
    assert.ok(texts.some((operation) => operation[1] === label && operation.includes("rtl")));
  const texture = [...measuredResources(a.root).textures][0];
  assert.ok(texture.isCanvasTexture);
  assert.equal(texture.image, canvases[0]);
  assert.equal(texture.colorSpace, THREE.SRGBColorSpace);
  assert.equal(texture.image.width, 2048);
  assert.equal(texture.image.height, 2048);
});

test("actual facade/roof vertices stay inside each oriented collision footprint and its height", (t) => {
  const world = city();
  const rotated = {
    id: "rotated-building", kind: "building", x: 114, z: -117,
    width: 8, length: 10, heading: Math.PI / 5, height: 16,
  };
  world.statics.push(rotated);
  const layer = fixture(t, freeze(world)), sites = new Map(world.statics.map((site) => [site.id, site]));
  const observed = new Set(), featureVertices = Array(8).fill(0);
  layer.root.traverse((part) => {
    if (!part.isMesh) return;
    const position = part.geometry.attributes.position, indices = part.geometry.attributes.siteIndex;
    const features = part.geometry.attributes.featureIndex;
    assert.equal(position.count, indices.count);
    for (let n = 0; n < position.count; n++) {
      const feature = features.getX(n);
      featureVertices[feature]++;
      const index = indices.getX(n);
      if (index < 0) continue;
      const site = sites.get(layer.diagnostics.siteIds[index]);
      assert.ok(site && site.kind === "building");
      observed.add(site.id);
      const dx = position.getX(n) - site.x, dz = position.getZ(n) - site.z;
      const x = dx * Math.cos(site.heading) - dz * Math.sin(site.heading);
      const z = dx * Math.sin(site.heading) + dz * Math.cos(site.heading);
      assert.ok(Math.abs(x) <= site.width / 2 + 0.00002, `${site.id} X ${x}`);
      assert.ok(Math.abs(z) <= site.length / 2 + 0.00002, `${site.id} Z ${z}`);
      assert.ok(position.getY(n) >= 0.12 - 0.00001);
      assert.ok(position.getY(n) <= 0.12 + site.height + 0.00001, `${site.id} height`);
    }
  });
  assert.equal(observed.size, 79);
  for (const [index, feature] of layer.diagnostics.featureNames.entries())
    assert.ok(featureVertices[index] > 0, `${feature} must be actual geometry`);
});

test("the complete district has bounded real geometry/draw resources and actual supporting roofs/facades", (t) => {
  canvasAdapter(t);
  const layer = fixture(t), measured = measuredResources(layer.root);
  assert.ok(measured.draws <= 45, `${measured.draws} district draws`);
  assert.ok(measured.triangles <= 100000, `${measured.triangles} district triangles`);
  assert.equal(layer.diagnostics.drawCalls, measured.draws);
  assert.equal(layer.diagnostics.triangles, measured.triangles);
  assert.ok(layer.diagnostics.budget.withinBudget);
  assert.equal(measured.materials.size, 3);
  assert.equal(measured.textures.size, 1);
  assert.ok([...measured.materials].every((material) => material.roughness >= 0.9 && material.metalness === 0));
  assert.ok(layer.diagnostics.counts.windows > 1500);
  assert.ok(layer.diagnostics.counts.balconies > 100);
  assert.ok(layer.diagnostics.counts.shops > 150);
  assert.ok(layer.diagnostics.counts.tanks > 30 && layer.diagnostics.counts.dishes > 30);
  assert.equal(layer.diagnostics.counts.airConditioners, 78);
  layer.root.updateMatrixWorld(true);
  for (const id of ["building-0", "building-1", "building-2", "building-3"]) {
    const record = layer.diagnostics.sites.find((site) => site.id === id);
    const site = city().statics.find((candidate) => candidate.id === id);
    const ray = new THREE.Raycaster(new THREE.Vector3(site.x, record.roofY + 0.2, site.z), new THREE.Vector3(0, -1, 0), 0, 0.3);
    assert.ok(ray.intersectObject(layer.root, true).length > 0, `${id} has a real supporting roof slab`);
    const face = record.primaryFace * Math.PI / 2, outward = new THREE.Vector3(Math.sin(face), 0, Math.cos(face));
    const origin = new THREE.Vector3(site.x, 3.8, site.z).addScaledVector(outward, 8);
    assert.ok(new THREE.Raycaster(origin, outward.clone().negate(), 0, 8)
      .intersectObject(layer.root, true).length > 0, `${id} facade is a closed actual surface`);
  }
});

test("patches stay on asphalt and curb paint stops at road/bay intersections without raised lane obstacles", (t) => {
  const world = {
    environment: "vision", statics: [],
    roads: [
      { axis: "z", fixed: 0, min: -35, max: 35, width: 10 },
      { axis: "x", fixed: 0, min: -35, max: 35, width: 8 },
      { axis: "z", fixed: -6, min: 14, max: 22, width: 2, parkingBay: true },
    ],
  };
  const before = JSON.stringify(world), layer = fixture(t, freeze(world));
  assert.equal(JSON.stringify(world), before);
  assert.ok(layer.diagnostics.counts.patches > 0 && layer.diagnostics.counts.curbSegments > 0);
  const patch = layer.root.getObjectByName("egypt-asphalt-repairs").geometry.attributes.position;
  for (let n = 0; n < patch.count; n++) {
    const x = patch.getX(n), z = patch.getZ(n);
    assert.ok((Math.abs(x) < 5 && Math.abs(z) > 4) || (Math.abs(z) < 4 && Math.abs(x) > 5),
      `repair vertex ${x}, ${z} is not in the nonintersection asphalt`);
    assert.ok(Math.abs(patch.getY(n) - 0.124) < 1e-6);
  }
  const curb = layer.root.getObjectByName("egypt-painted-curb").geometry.attributes.position;
  for (let n = 0; n < curb.count; n++) {
    const x = curb.getX(n), z = curb.getZ(n);
    assert.ok(Math.abs(curb.getY(n) - 0.08) < 1e-6);
    assert.ok(!(Math.abs(x) < 5 && Math.abs(z) < 4), "paint must not cross a lane");
    assert.ok(!(x >= -7 && x <= -5 && z >= 13 && z <= 23), "parking bay cuts the painted curb");
    assert.ok((Math.abs(x) >= 5.08 && Math.abs(x) <= 5.38) ||
      (Math.abs(z) >= 4.08 && Math.abs(z) <= 4.38));
  }
  assert.ok(layer.root.children.every((part) => !part.castShadow));
});

test("each layer owns and disposes its geometries, shared materials and atlas exactly once", (t) => {
  canvasAdapter(t);
  const a = fixture(t), b = fixture(t), resources = measuredResources(a.root), other = measuredResources(b.root);
  assert.ok([...resources.geometries].every((geometry) => !other.geometries.has(geometry)));
  assert.ok([...resources.materials].every((material) => !other.materials.has(material)));
  assert.ok([...resources.textures].every((texture) => !other.textures.has(texture)));
  const events = new Map();
  for (const resource of [...resources.geometries, ...resources.materials, ...resources.textures]) {
    events.set(resource, 0);
    resource.addEventListener("dispose", () => events.set(resource, events.get(resource) + 1));
  }
  const parent = new THREE.Group();
  parent.add(a.root);
  a.dispose(); a.dispose();
  assert.equal(a.root.parent, null);
  assert.equal(parent.children.length, 0);
  assert.equal(a.root.children.length, 0);
  assert.ok(a.diagnostics.disposed);
  assert.ok([...events.values()].every((count) => count === 1));
  assert.deepEqual(
    [a.diagnostics.resources.liveGeometries, a.diagnostics.resources.liveMaterials, a.diagnostics.resources.liveTextures],
    [0, 0, 0],
  );
  assert.equal(b.diagnostics.disposed, false);
  assert.ok(b.root.children.length > 0);
});

test("non-city scopes are explicit empty layers and unavailable canvas is reported, not called rendered Arabic", (t) => {
  const canvases = canvasAdapter(t);
  for (const environment of ["lab", "vehicle", "other"]) {
    const layer = fixture(t, { ...city(), environment });
    assert.equal(layer.diagnostics.active, false);
    assert.equal(layer.root.children.length, 0);
    assert.deepEqual(layer.diagnostics.siteIds, []);
    assert.equal(layer.diagnostics.resources.materials, 0);
    assert.equal(layer.diagnostics.resources.textures, 0);
  }
  assert.equal(canvases.length, 0);
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: undefined });
  try {
    const layer = fixture(t);
    assert.equal(layer.diagnostics.textAtlasAvailable, false);
    assert.equal(measuredResources(layer.root).textures.size, 0);
    assert.equal(layer.diagnostics.siteIds.length, 78);
  } finally { Object.defineProperty(globalThis, "document", descriptor); }
});

test("the public factory performs no asset/network loads and missing sites do not invent new building collisions", (t) => {
  canvasAdapter(t);
  const originalFetch = globalThis.fetch;
  const textureLoad = THREE.TextureLoader.prototype.load, fileLoad = THREE.FileLoader.prototype.load;
  const forbidden = () => { throw new Error("Unexpected external resource load"); };
  globalThis.fetch = forbidden;
  THREE.TextureLoader.prototype.load = THREE.FileLoader.prototype.load = forbidden;
  t.after(() => {
    globalThis.fetch = originalFetch;
    THREE.TextureLoader.prototype.load = textureLoad;
    THREE.FileLoader.prototype.load = fileLoad;
  });
  const layer = fixture(t);
  assert.equal(layer.then, undefined);
  assert.equal(layer.diagnostics.textAtlasAvailable, true);
  const empty = fixture(t, { environment: "vision", roads: [], statics: [] });
  assert.equal(empty.root.children.length, 0);
  assert.equal(empty.diagnostics.resources.materials, 0);
  assert.equal(empty.diagnostics.siteIds.length, 0);
});
