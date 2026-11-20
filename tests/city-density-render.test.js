import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { World } from "../src/core/world.js";
import { createUnifiedCity } from "../src/core/unified-city.js";
import { createEgyptStreetLayer } from "../src/render/egypt-streets.js";
import { createPursuitView } from "../src/render/pursuit-view.js";
import { createUnifiedTrafficModel, disposeUnifiedTrafficModel } from "../src/render/unified-traffic-model.js";
import { WorldView } from "../src/render/world-view.js";

const isSkyline = mesh => mesh.name.endsWith("-skyline");
const isDetail = mesh => /-(facades|structure)$/.test(mesh.name);
const poseDistance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const ray = new THREE.Raycaster();

function observeSites(layer, predicate = () => true) {
  const found = new Set();
  for (const mesh of layer.root.children.filter(predicate))
    for (const index of mesh.geometry.getAttribute("siteIndex").array) if (index >= 0)
      found.add(layer.diagnostics.siteIds[index]);
  return found;
}

function hullDistance(site, point) {
  const dx = point.x - site.x, dz = point.z - site.z;
  const c = Math.cos(site.heading ?? 0), s = Math.sin(site.heading ?? 0);
  return Math.hypot(Math.max(0, Math.abs(dx * c - dz * s) - site.width / 2),
    Math.max(0, Math.abs(dx * s + dz * c) - site.length / 2));
}

function meshDigest(layer, onlySite) {
  const hash = createHash("sha256");
  for (const mesh of layer.root.children) {
    if (!isDetail(mesh)) continue;
    const { siteIndex, ...attributes } = mesh.geometry.attributes;
    const values = [];
    for (let i = 0; i < siteIndex.count; i++) {
      if (layer.diagnostics.siteIds[siteIndex.getX(i)] !== onlySite) continue;
      for (const { array, itemSize } of Object.values(attributes))
        for (let n = 0; n < itemSize; n++) values.push(array[i * itemSize + n]);
    }
    if (values.length) hash.update(Buffer.from(new Float32Array(values).buffer));
  }
  return hash.digest("hex");
}

function skylineDigest(layer) {
  const hash = createHash("sha256");
  for (const mesh of layer.root.children.filter(isSkyline)) {
    hash.update(mesh.name);
    for (const { array } of Object.values(mesh.geometry.attributes))
      hash.update(Buffer.from(array.buffer, array.byteOffset, array.byteLength));
  }
  return hash.digest("hex");
}

test("metro streams exact near façades, keeps every remote hull, and disposes detailed GPU geometry on travel", (t) => {
  const map = createUnifiedCity(), world = { ...map, environment: "metro" };
  const stream = createEgyptStreetLayer(world, { streamDetails: true }), full = createEgyptStreetLayer(world);
  t.after(() => { stream.dispose(); full.dispose(); });
  const buildings = world.statics.filter(site => site.kind === "building");
  const allIds = new Set(buildings.map(site => site.id)), start = world.playerStart;
  assert.equal(stream.diagnostics.residentCells, 0);
  assert.ok(stream.root.children.every(mesh => !isDetail(mesh)), "distant detail buffers must not be allocated then hidden");
  assert.deepEqual(observeSites(stream, isSkyline), allIds);
  assert.ok(stream.diagnostics.triangles < full.diagnostics.triangles / 5);
  assert.equal(skylineDigest(stream), "22aff5ca5c7b73283b0d1d4a69c610b1108a6a810578532b596e0e320d72d53d",
    "the close-up pass must leave the measured checkpoint's skyline buffers byte-for-byte unchanged");
  // Pre-detail checkpoint: 122,764 total architecture triangles and 64 draws.
  assert.equal(full.diagnostics.drawCalls, 64);
  assert.ok(full.diagnostics.triangles <= 122_764 * 1.05, "close-up architecture adds at most 5% triangles");
  for (const name of ["egypt-painted-curb", "egypt-asphalt-repairs"])
    assert.deepEqual(stream.root.getObjectByName(name).geometry.attributes.position.array,
      full.root.getObjectByName(name).geometry.attributes.position.array);

  const nearest = buildings.toSorted((a, b) => hullDistance(a, start) - hullDistance(b, start))[0];
  const floor = new THREE.Vector3(nearest.x, 1, nearest.z);
  ray.set(new THREE.Vector3(start.x, 1, start.z), floor.clone().sub(new THREE.Vector3(start.x, 1, start.z)).normalize());
  assert.ok(ray.intersectObjects(stream.root.children.filter(isSkyline)).length > 0, "skyline is opaque world geometry");
  const startProxy = stream.root.children.find(mesh => isSkyline(mesh) &&
    mesh.geometry.attributes.siteIndex.array.includes(stream.diagnostics.siteIds.indexOf(nearest.id)));
  const sharedMaterial = startProxy.material;
  let earlyDisposal = 0;
  sharedMaterial.addEventListener("dispose", () => earlyDisposal++);

  stream.updateResidency([start]);
  const near = observeSites(stream, isDetail);
  assert.ok(near.has(nearest.id));
  for (const site of buildings)
    if (hullDistance(site, start) <= 42) assert.ok(near.has(site.id), `${site.id} inside camera safety disk`);
  assert.equal(meshDigest(stream, nearest.id), meshDigest(full, nearest.id), "near materials/vertices retain the actual authored detail");
  assert.equal(startProxy.parent, null, "proxy must not cover the recessed detailed facade");
  assert.deepEqual(observeSites(stream), allIds);
  assert.ok(stream.diagnostics.residentCells < stream.diagnostics.totalCells / 3);

  const outgoing = stream.root.children.filter(mesh => isDetail(mesh) && mesh.geometry.attributes.siteIndex.array
    .includes(stream.diagnostics.siteIds.indexOf(nearest.id)));
  const releases = new Map(outgoing.map(mesh => [mesh.geometry, 0]));
  for (const geometry of releases.keys())
    geometry.addEventListener("dispose", () => releases.set(geometry, releases.get(geometry) + 1));
  const alley = map.drivingRoads.find(road => road.id === "alley-west");
  const next = { x: alley.fixed, z: (alley.min + alley.max) / 2 };
  assert.ok(poseDistance(next, start) > 85);
  stream.updateResidency([next]);
  assert.ok(outgoing.every(mesh => mesh.parent === null));
  assert.ok([...releases.values()].every(count => count === 1), "eviction must dispose, not hold an invisible detailed batch");
  assert.equal(startProxy.parent, stream.root, "the same proxy covers the evicted footprint immediately");
  assert.equal(earlyDisposal, 0, "the shared material and atlas survive cell eviction");
  assert.deepEqual(observeSites(stream), allIds);
  const alleyDetail = observeSites(stream, isDetail);
  const within = buildings.filter(site => hullDistance(site, next) <= 42);
  assert.ok(within.length > 0 && within.every(site => alleyDetail.has(site.id)));
  assert.equal(stream.diagnostics.resources.liveGeometries,
    stream.diagnostics.totalCells + 2 + stream.root.children.filter(isDetail).length);
  stream.dispose();
  assert.equal(earlyDisposal, 1);
  assert.ok([...releases.values()].every(count => count === 1));
  assert.equal(stream.diagnostics.resources.liveGeometries, 0);
});

function facadeWitnesses(layer, site, featureName, eye, firstBayOnly = true) {
  const meshes = layer.root.children.filter(isDetail);
  const featureId = layer.diagnostics.featureNames.indexOf(featureName);
  const siteId = layer.diagnostics.siteIds.indexOf(site.id);
  const point = new THREE.Vector3(), vertex = new THREE.Vector3(), direction = new THREE.Vector3();
  const witnesses = [];
  for (const mesh of meshes) {
    const { position, siteIndex, featureIndex, color } = mesh.geometry.attributes;
    for (let i = 0; i < position.count; i += 3) {
      if (siteIndex.getX(i) !== siteId || featureIndex.getX(i) !== featureId) continue;
      point.fromBufferAttribute(position, i)
        .add(vertex.fromBufferAttribute(position, i + 1)).add(vertex.fromBufferAttribute(position, i + 2))
        .multiplyScalar(1 / 3);
      if (firstBayOnly && point.x > site.x) continue;
      ray.set(eye, direction.subVectors(point, eye).normalize());
      const [hit] = ray.intersectObjects(meshes, false);
      if (!hit || hit.point.distanceToSquared(point) > .00001) continue;
      witnesses.push({ point: hit.point, normal: hit.face.normal, color: [color.getX(i), color.getY(i), color.getZ(i)] });
    }
  }
  return witnesses;
}

test("recessed detail reads from the alley: warm bread, varied produce, and an open repair wheel", (t) => {
  const [bakery, grocer, repair] = ["bakery-0", "repair-0", "repair-3"].map((id, i) =>
    ({ id, kind: "building", x: (i - 1) * 16, z: -5.7, width: 12, length: 6, height: 15 }));
  const statics = [bakery, grocer, repair];
  const roads = [{ id: "alley", axis: "x", fixed: 0, min: -35, max: 35, width: 3.8, zone: "neighborhood" }];
  const layer = createEgyptStreetLayer({ environment: "metro", roads, statics }, { streamDetails: true });
  t.after(() => layer.dispose());
  const eye = site => new THREE.Vector3(site.x - 3.8, 1.65, 0);
  assert.equal(facadeWitnesses(layer, bakery, "bakery-display", eye(bakery)).length, 0);
  layer.updateResidency([{ x: 0, z: 0 }]);
  const bread = facadeWitnesses(layer, bakery, "bakery-display", eye(bakery));
  const bakedCaps = bread.filter(({ normal, color: [r, g, b] }) => normal.y > .80 && r > .64 && r > g && g > b);
  assert.ok(new Set(bakedCaps.map(({ color }) => color[0])).size >= 3, "three visible, warm flatbread caps");
  assert.ok(bread.some(({ normal }) => normal.z > .95), "a thick toasted edge, not bread-colored paint");

  const produce = facadeWitnesses(layer, grocer, "produce-crates", eye(grocer)).filter(({ normal }) => normal.y > .60);
  assert.ok(produce.some(({ color: [r, g, b] }) => r > 2 * g && g > b), "copper-red produce above the crate lip");
  assert.ok(produce.some(({ color: [r, g, b] }) => g > r && r > b), "green produce in a separate bin");
  assert.ok(new Set(produce.map(({ color }) => color[0])).size >= 4);

  const repairEye = eye(repair);
  const repairHits = facadeWitnesses(layer, repair, "repair-bay", repairEye);
  const tire = repairHits.filter(({ point, normal, color }) =>
    point.y > 1.2 && point.y < 1.65 && point.z > -3.60 && normal.z > .95 && Math.max(...color) < .12);
  assert.ok(tire.length >= 8, "visible annular tire facets, behind a partly open shutter");
  const center = new THREE.Box3().setFromPoints(tire.map(({ point }) => point)).getCenter(new THREE.Vector3());
  ray.set(repairEye, center.clone().sub(repairEye).normalize());
  const [throughHub] = ray.intersectObjects(layer.root.children.filter(isDetail), false);
  assert.ok(throughHub && throughHub.point.z < center.z - .055, "the circular center stays open to the recessed wall");
  assert.ok([...bread, ...produce, ...tire].every(({ point }) => point.z < -3.24),
    "merchandise remains inside the wall recess, not on the drivable lane");
});

test("City v4 adds real market frontage in resident cells, without new draws or hulls", (t) => {
  const map = createUnifiedCity({ rush: true });
  const world = { ...map, environment: "metro", config: { cityVersion: 4 } };
  const fixtures = createEgyptStreetLayer(world, { streamDetails: true });
  const previous = createEgyptStreetLayer({ ...world, config: { cityVersion: 3 } }, { streamDetails: true });
  t.after(() => { fixtures.dispose(); previous.dispose(); });
  const registry = JSON.stringify([world.roads, world.statics]);
  const sites = new Map(world.statics.map(site => [site.id, site]));
  const { diagnostics: now } = fixtures, { diagnostics: before } = previous;
  assert.equal(now.counts.marketStalls, 0);
  assert.equal(skylineDigest(fixtures), skylineDigest(previous));
  assert.equal(now.resources.liveGeometries, before.resources.liveGeometries);
  const permanentDelta = now.triangles - before.triangles;
  assert.ok(permanentDelta < 2_200, "the new pavement stays in two light permanent batches");
  const cafe = sites.get("tahrir-boulevard-frontage--1-1");
  const grocer = sites.get("district-building-26");
  const featureBuffers = () => fixtures.root.children.filter(isDetail);
  const visit = (...anchors) => {
    fixtures.updateResidency(anchors);
    previous.updateResidency(anchors);
    assert.deepEqual(observeSites(fixtures, isDetail), observeSites(previous, isDetail));
    assert.equal(now.drawCalls, before.drawCalls);
    assert.equal(now.resources.liveGeometries, before.resources.liveGeometries);
    assert.equal(now.resources.liveMaterials, before.resources.liveMaterials);
    assert.equal(now.resources.liveTextures, before.resources.liveTextures);
    assert.ok(now.counts.marketStalls > 0);
    assert.ok(now.triangles - permanentDelta <= before.triangles + now.counts.marketStalls * 175 + now.residentSites * 48,
      "bounded market geometry plus ground-floor finishes, only on resident sites");
    assert.ok(now.budget.withinBudget);

    const point = new THREE.Vector3();
    let marketVertices = 0;
    for (const mesh of featureBuffers()) {
      const { position, siteIndex, featureIndex, normal } = mesh.geometry.attributes;
      for (let i = 0; i < position.count; i++) {
        const feature = now.featureNames[featureIndex.getX(i)];
        const market = feature.startsWith("market-");
        if (!market && feature !== "masonry-dado" && feature !== "shop-kickplate") continue;
        if (market) marketVertices++;
        const site = sites.get(now.siteIds[siteIndex.getX(i)]);
        point.fromBufferAttribute(position, i);
        assert.ok(hullDistance(site, point) < .0001, `${site.id} moved the physical street edge`);
        assert.ok(point.y > 0.12 && point.y < (market ? 3.5 : 1), "a finish must read at street level");
        assert.ok(Math.hypot(normal.getX(i), normal.getY(i), normal.getZ(i)) > .99, "no collapsed frontage faces");
      }
    }
    assert.ok(marketVertices / 3 <= now.counts.marketStalls * 175, "preserve the original market mesh budget");
  };
  const chaseEye = new THREE.Vector3(cafe.x - 13, 3.8, map.playerStart.z);
  visit(map.playerStart, chaseEye);
  const folds = facadeWitnesses(fixtures, cafe, "market-awning", chaseEye, false);
  const fabric = folds.filter(({ normal }) => normal.y > .7);
  assert.ok(fabric.length >= 10 && new Set(fabric.map(({ color }) => color[0])).size >= 2,
    "striped cloth roof is visible above the service opening");
  assert.ok(folds.some(({ normal }) => normal.z > .95), "a folded valance is visible from street level");
  const tea = facadeWitnesses(fixtures, cafe, "market-tea", chaseEye, false);
  const urn = tea.filter(({ point, normal, color: [r, g, b] }) =>
    point.y > 1.45 && Math.abs(normal.y) < .01 && r > 2 * g && g > 2 * b);
  assert.ok(new Set(urn.map(({ normal }) => normal.x.toFixed(2))).size >= 3, "the tea urn has a rounded body");
  assert.equal(facadeWitnesses(previous, cafe, "market-tea", chaseEye, false).length, 0);
  const base = facadeWitnesses(fixtures, cafe, "masonry-dado", chaseEye, false);
  assert.ok(base.some(({ point, normal }) => normal.z > .95 && point.y > .45),
    "a stone course is visible from the street, not buried under a wall");
  assert.ok(facadeWitnesses(fixtures, cafe, "shop-kickplate", chaseEye, false).length > 0,
    "non-market shops have visible fitted material at the window base");

  const alley = map.drivingRoads.find(road => road.id === "alley-west");
  const frontEye = new THREE.Vector3(alley.fixed, 1.63, grocer.z - 3.5);
  visit(frontEye);
  const fruit = facadeWitnesses(fixtures, grocer, "market-produce", frontEye, false)
    .filter(({ normal }) => normal.y > .45);
  assert.ok(fruit.some(({ color: [r, g, b] }) => r > 2 * g && g > b));
  assert.ok(fruit.some(({ color: [r, g, b] }) => g > r && r > b));
  assert.equal(facadeWitnesses(fixtures, cafe, "market-tea", chaseEye, false).length, 0,
    "the first avenue cell no longer holds the new shop geometry");
  assert.deepEqual(observeSites(fixtures), observeSites(previous), "every original footprint is still presented");
  assert.equal(JSON.stringify([world.roads, world.statics]), registry);
});

test("v4 surfaces keep their road heights, put street joins at scale, and do not repaint a legacy preset", async (t) => {
  // Node has no image decoder. Exercise WorldView's real material bindings
  // with the installed road inputs in place of decoded textures.
  const loadTexture = t.mock.method(THREE.TextureLoader.prototype, "loadAsync", async (path) => {
    const jpeg = readFileSync(new URL(`..${path}`, import.meta.url));
    assert.equal(jpeg.readUInt16BE(0), 0xffd8);
    const texture = new THREE.Texture();
    texture.name = path;
    return texture;
  });
  const world = new World({ traffic: 96, pedestrians: 144, cityVersion: 4 }, "metro");
  const legacy = new World({ traffic: 96, pedestrians: 144, cityVersion: 3 }, "metro");
  const now = new WorldView(world), old = new WorldView(legacy);
  t.after(() => { now.dispose(); old.dispose(); });
  await setImmediate();
  assert.equal(loadTexture.mock.callCount(), 8, "reuse the existing four surface textures per world");
  for (const group of ["road", "pavement"]) {
    assert.equal(now.surfaces[group].length, 1, "one merged draw per base surface");
    const material = now.surfaces[group][0].material;
    assert.ok(material.map?.name.endsWith("_diff_1k.jpg") && material.normalMap?.name.endsWith("_nor_gl_1k.jpg"));
    assert.equal(old.surfaces[group][0].material.color.getHex(), 0xffffff);
  }
  // Approximate RGB mean sampled from the installed asphalt's diffuse image,
  // before the sun, exposure and tonemapping (assert the tint, not frame colors).
  const dryAsphalt = new THREE.Color("rgb(86,74,63)");
  dryAsphalt.multiply(now.surfaces.road[0].material.color);
  const channels = dryAsphalt.toArray();
  assert.ok(Math.max(...channels) / Math.min(...channels) < 1.2 && dryAsphalt.b >= dryAsphalt.r);
  const roadPaint = now.scene.getObjectByName("road-markings"), previousPaint = old.scene.getObjectByName("road-markings");
  assert.ok(!roadPaint.castShadow && previousPaint.castShadow, "the paint is on the asphalt, not raised solid geometry");
  assert.ok(roadPaint.geometry.index.count < previousPaint.geometry.index.count);

  const { root, diagnostics } = now.egyptStreets;
  const overlays = root.children.filter(mesh => mesh.geometry.attributes.siteIndex.getX(0) === -1);
  assert.equal(overlays.length, 2);
  assert.ok(overlays.every(mesh => !mesh.castShadow && mesh.receiveShadow && mesh.material.fog));
  const at = (x, z, meshes) => {
    ray.set(new THREE.Vector3(x, 2, z), new THREE.Vector3(0, -1, 0));
    const [hit] = ray.intersectObjects(meshes, false);
    if (!hit) return null;
    const features = hit.object.geometry.getAttribute("featureIndex");
    return { y: hit.point.y, name: features ? diagnostics.featureNames[features.getX(hit.face.a)] : null };
  };
  const avenue = world.roads.find(road => road.id === "tahrir-boulevard");
  const edge = avenue.fixed - avenue.width / 2;
  const atHeight = (x, z, named, height) => {
    const hit = at(x, z, overlays);
    assert.equal(hit?.name, named, `visible ${named} at (${x}, ${z})`);
    assert.ok(Math.abs(hit.y - height) < .001, `${named} stays on its actual support surface`);
  };
  assert.ok(Math.abs(at(-254, -112, now.surfaces.road).y - .115) < 1e-5);
  assert.ok(Math.abs(at(-254, edge - 1.5, now.surfaces.pavement).y - .07) < 1e-5);
  atHeight(-254, edge + .39, "gutter", .1165);
  atHeight(-254, edge - .19, "curb", .175);
  atHeight(-254, edge - 2.85, "scored-forecourt", -.0485);
  assert.ok(at(-253.1, edge - 2.85, overlays).y < at(-254, edge - 2.85, overlays).y,
    "a slab joint separates the runs, rather than a larger raised footway");
  assert.equal(at(-183, edge + .39, overlays), null, "Tahrir's gutter terminates at the Civic junction apron");
  const drain = overlays.find(mesh => mesh.name === "egypt-asphalt-repairs");
  const { position, featureIndex } = drain.geometry.attributes;
  const drainFeature = diagnostics.featureNames.indexOf("drain-grate");
  const drainVertices = Array.from({ length: position.count }, (_, i) => i)
    .filter(i => featureIndex.getX(i) === drainFeature && Math.abs(position.getX(i) + 254) < 9
      && position.getZ(i) > edge && position.getZ(i) < edge + .56);
  assert.ok(drainVertices.length >= 24, "cast-iron grating is present in the starting block's gutter");
  assert.ok(drainVertices.every(i => position.getY(i) > .115 && position.getY(i) <= .12));
  assert.equal(old.egyptStreets.diagnostics.featureNames.includes("scored-forecourt"), false);
  t.diagnostic(`v4 road overlays: ${overlays.length} non-shadow draws, ${diagnostics.counts.drains} inlets, ` +
    `${diagnostics.counts.forecourtSlabs} slabs, ${diagnostics.counts.patches} on-road repairs`);
});

test("the market-local arrival has clear sky and still shows the curb bevel at street height", (t) => {
  const map = createUnifiedCity({ rush: true });
  const layer = createEgyptStreetLayer({ ...map, environment: "metro", config: { cityVersion: 4 } },
    { streamDetails: true });
  t.after(() => layer.dispose());
  const curbs = layer.root.getObjectByName("egypt-painted-curb");
  // Fixed east-facing bakery arrival from QA's 1365×900 chase view.
  const camera = new THREE.PerspectiveCamera(62, 1365 / 900, .1, 500);
  camera.position.set(-6.75, 5.12, 1.4);
  camera.lookAt(8.75, 1.12, 1.4);
  camera.updateMatrixWorld(true);
  const skyHits = [[636, 140], [663, 239]].map(([x, y]) => {
    ray.setFromCamera(new THREE.Vector2((x + .5) / 1365 * 2 - 1, 1 - (y + .5) / 900 * 2), camera);
    return ray.intersectObject(curbs)[0]?.point.toArray() ?? null;
  });
  assert.deepEqual(skyHits, [null, null], "neither reported stroke should hit pavement geometry");
  const { min, max } = curbs.geometry.boundingBox;
  assert.ok(min.y >= -.05 && max.y <= .176, "all permanent edging stays between the earth and curb cap");
  ray.set(new THREE.Vector3(10, 2, 3.05), new THREE.Vector3(0, -1, 0));
  const [bevel] = ray.intersectObject(curbs);
  assert.ok(bevel && bevel.point.y > .085 && bevel.point.y < .115 && bevel.face.normal.y < .99,
    "the curb's sloped return still joins Market Street to its footway");
});

test("near police use fitted, tick-driven rush lightbars without extra draws or light sources", (t) => {
  const scene = new THREE.Scene();
  const world = { actors: [], pursuit: { phase: "running" }, tick: 0 };
  const view = createPursuitView(scene, world);
  const make = (id, x, pursuitRole) => {
    const actor = { id, pursuitRole, type: "vehicle", kind: "sedan", width: 1.84, length: 4.45 };
    const { root: visual } = createUnifiedTrafficModel(actor);
    const root = new THREE.Group();
    root.position.set(x, .12, 0);
    root.add(visual);
    scene.add(root);
    world.actors.push(actor);
    view.attach({ root, visual }, actor);
    return { actor, root, visual, kit: scene.getObjectByName(`pursuit-patrol:${id}`) };
  };
  const a = make("patrol-0", 0, "police"), b = make("patrol-1", 6, "police");
  const civilian = make("ordinary-car", -6, "civilian");
  t.after(() => {
    view.dispose();
    for (const { visual } of [a, b, civilian]) disposeUnifiedTrafficModel(visual);
  });
  const lenses = kit => ["blue", "red"].map(side => kit.getObjectByName(`pursuit-lightbar-${side}`));
  const palette = kit => lenses(kit).map(lens => lens.material);
  const lit = kit => palette(kit).map(({ color }) => Math.max(color.r, color.g, color.b) > .85);
  const activeColors = new Set();
  assert.equal(civilian.kit, undefined);
  view.update();
  const legacy = palette(a.kit);
  world.tick = 24;
  view.update();
  assert.deepEqual(palette(a.kit), legacy);
  world.pursuit = { variant: "rush", phase: "ready" };
  view.update();
  assert.deepEqual(palette(a.kit), legacy);
  world.pursuit.phase = "running";
  world.tick = 0;
  view.update();
  const first = lit(a.kit);
  assert.equal(first.filter(Boolean).length, 1);
  assert.deepEqual(lit(b.kit), first.toReversed());
  for (const kit of [a.kit, b.kit]) for (const color of palette(kit)) activeColors.add(color);
  world.tick = 24;
  a.root.position.set(.5, .15, 3.32);
  a.root.rotation.y = Math.PI / 3;
  view.update();
  assert.deepEqual(a.kit.position.toArray(), a.root.position.toArray());
  assert.ok(a.kit.quaternion.angleTo(a.root.quaternion) < 1e-7);
  assert.deepEqual(lit(a.kit), first.toReversed(), "the two lens panels alternate");
  for (const kit of [a.kit, b.kit]) for (const color of palette(kit)) activeColors.add(color);
  assert.equal(activeColors.size, 4, "all cars share the two on/off lens pairs");
  assert.ok([...activeColors].every(material => material.isMeshBasicMaterial && !material.transparent));
  const fixedTick = palette(a.kit);
  view.update();
  assert.deepEqual(palette(a.kit), fixedTick, "a paused tick keeps the exact same visible color");

  scene.updateMatrixWorld(true);
  const housing = a.kit.children[0], center = housing.getWorldPosition(new THREE.Vector3());
  ray.set(center.clone().add(new THREE.Vector3(0, 1, 0)), new THREE.Vector3(0, -1, 0));
  const [roof] = ray.intersectObject(a.visual, true);
  assert.ok(roof && Math.abs(roof.point.y - (center.y - housing.scale.y / 2)) < .003,
    "housing sits on the authoritative moving procedural model's roof");
  for (const kit of [a.kit, b.kit]) {
    assert.equal(kit.children.length, 4, "housing, two lenses and existing door stripe only");
    assert.ok(lenses(kit).every(part => part.geometry === housing.geometry && part.position.y > housing.position.y));
  }
  const lights = [];
  scene.traverse(object => { if (object.isLight) lights.push(object); });
  assert.equal(lights.length, 0);

  b.root.removeFromParent();
  view.update();
  assert.equal(b.kit.visible, false, "an off-residency patrol has no visible floating lightbar");
  world.pursuit.phase = "captured";
  view.update();
  assert.deepEqual(palette(a.kit), legacy);
  world.actors = [civilian.actor];
  view.update();
  assert.equal(a.kit.parent, null);
  const released = new Set();
  for (const material of activeColors) material.addEventListener("dispose", () => released.add(material));
  view.dispose();
  assert.equal(released.size, 4);
});

test("camera coverage uses the footprint, with bounded look-ahead and no churn near the cutover", (t) => {
  const statics = [49, 88, 123, 167].map(x =>
    ({ id: `site-${x}`, x, z: 0, width: 10, length: 10, height: 15, kind: "building", heading: Math.PI / 4 }));
  const layer = createEgyptStreetLayer({ environment: "metro", roads: [], statics }, { streamDetails: true });
  t.after(() => layer.dispose());
  // The center is 49 m away but the rotated footprint is within the required disk.
  layer.updateResidency([{ x: 0, z: 0 }]);
  assert.deepEqual(observeSites(layer, isDetail), new Set(["site-49"]));
  layer.updateResidency([{ x: 13, z: 0 }], { x: 30, z: 0 });
  assert.deepEqual(observeSites(layer, isDetail), new Set(["site-49", "site-88"]), "look-ahead prewarms one optional cell");
  const warmIndex = layer.diagnostics.siteIds.indexOf("site-88");
  const prewarmed = layer.root.children.find(mesh => isDetail(mesh) &&
    mesh.geometry.attributes.siteIndex.array.includes(warmIndex));
  assert.ok(prewarmed);
  layer.updateResidency([{ x: 43, z: 0 }]);
  for (const x of [37, 46, 36, 44, 37]) layer.updateResidency([{ x, z: 0 }]);
  assert.ok(layer.root.children.includes(prewarmed));
  assert.equal(layer.diagnostics.cellsBuilt, 2);
  assert.equal(layer.diagnostics.cellsEvicted, 0);
  layer.updateResidency([{ x: 165, z: 0 }]);
  assert.ok(!layer.root.children.includes(prewarmed));
  assert.ok(!observeSites(layer, isDetail).has("site-49"));
  assert.deepEqual(observeSites(layer), new Set(statics.map(site => site.id)));
});

// Use the original local GLB geometry, skins and clips. Node lacks the browser
// texture decoder, so strip only material image bindings in this offline proof.
async function localGLB(url) {
  const source = readFileSync(new URL(`..${url}`, import.meta.url));
  const jsonLength = source.readUInt32LE(12);
  const json = JSON.parse(source.subarray(20, 20 + jsonLength).toString());
  json.materials = json.materials.map(({ name }) => ({ name }));
  const text = Buffer.from(JSON.stringify(json)), padded = Buffer.alloc(Math.ceil(text.length / 4) * 4, 32);
  text.copy(padded);
  const binary = source.subarray(20 + jsonLength), out = Buffer.alloc(20 + padded.length + binary.length);
  source.copy(out, 0, 0, 20);
  out.writeUInt32LE(out.length, 8);
  out.writeUInt32LE(padded.length, 12);
  padded.copy(out, 20);
  binary.copy(out, 20 + padded.length);
  return new GLTFLoader().parseAsync(new Uint8Array(out).buffer, "");
}

function mounted(view, player, lens) {
  const { position, target } = view.playerRig.getCameraPose(lens);
  const camera = new THREE.PerspectiveCamera(76, 16 / 9, 0.1, 250);
  camera.position.copy(player.localToWorld(new THREE.Vector3(position.x, position.y, position.z)));
  camera.lookAt(player.localToWorld(new THREE.Vector3(target.x, target.y, target.z)));
  camera.updateMatrixWorld(true);
  return camera;
}

function rendersProxyAt(view, type, point) {
  const mesh = view.scene.getObjectByName(`metro-silhouettes-${type}`), instance = new THREE.Matrix4();
  for (let i = 0; i < (mesh?.count ?? 0); i++) {
    mesh.getMatrixAt(i, instance);
    if (Math.hypot(instance.elements[12] - point.x, instance.elements[14] - point.z) < 1e-5) return true;
  }
  return false;
}

test("all 169 live actors are represented without eager roots; a remote People view never replaces player RGB residency", async (t) => {
  const world = new World({ traffic: 72, pedestrians: 96 }, "metro");
  const loads = new Map();
  const view = new WorldView(world, { loadAsset(url) {
    if (!loads.has(url)) loads.set(url, { count: 0, promise: localGLB(url) });
    const load = loads.get(url);
    load.count++;
    return load.promise;
  } });
  t.after(() => view.dispose());
  const actors = world.actors.slice(), snapshot = JSON.stringify(world.snapshot());
  const far = actors.filter(actor => actor.type === "pedestrian")
    .toSorted((a, b) => poseDistance(b, world.player) - poseDistance(a, world.player))[0];
  const farCar = actors.find(actor => actor.type === "vehicle" && poseDistance(actor, world.player) > 125);
  assert.ok(farCar && poseDistance(far, world.player) > 125);
  assert.equal(view.roots.size, 1);
  assert.equal(view.actorDiagnostics().ready, false);
  const display = new THREE.PerspectiveCamera();
  const draw = (follow = false) => {
    const player = view.sync(0.5);
    const front = mounted(view, player, "sensor"), rear = mounted(view, player, "sensor-rear");
    const target = follow ? view.roots.get(far.id).root.position : player.position;
    display.position.copy(target).add(new THREE.Vector3(3.2, 1.8, -4.2));
    display.lookAt(target.x, target.y + .9, target.z);
    view.prepareFrame({ cameras: [display, front, rear] });
    return { front, rear };
  };
  const { front, rear } = draw();
  const first = view.actorDiagnostics();
  assert.equal(first.ready, true);
  assert.equal(first.totalActors, 169);
  assert.equal(first.availableActors, 169);
  assert.equal(first.detailedActors + first.proxyActors, 169);
  assert.deepEqual(first.trafficModels, ["sedan", "suv", "taxi", "tuktuk", "van"]);
  assert.ok(first.detailedTrafficModels.length < first.trafficModels.length);
  assert.ok(view.roots.size < 30);
  assert.ok(!view.roots.has(far.id) && !view.roots.has(farCar.id));
  assert.ok(rendersProxyAt(view, "pedestrian", far) && rendersProxyAt(view, farCar.kind, farCar));

  const nearBuildings = world.statics.filter(site => site.kind === "building" &&
    [front.position, rear.position].some(camera => hullDistance(site, camera) <= 42));
  const remoteBuildings = world.statics.filter(site => site.kind === "building" && hullDistance(site, far) <= 42);
  assert.ok(nearBuildings.length > 0 && remoteBuildings.length > 0);
  const available = () => observeSites(view.egyptStreets, isDetail);
  assert.ok(remoteBuildings.every(site => !available().has(site.id)));
  view.selectedPersonId = far.id;
  draw();
  assert.ok(view.roots.has(far.id), "selection primes the actual actor without moving any cameras");
  assert.ok(remoteBuildings.every(site => !available().has(site.id)));
  view.focusedPersonId = far.id;
  const focused = draw(true);
  const farRoot = view.roots.get(far.id).root;
  assert.ok(farRoot.children.some(part => part.isMesh), "a body is present before async detail finishes");
  assert.ok(remoteBuildings.every(site => available().has(site.id)));
  assert.ok(nearBuildings.every(site => available().has(site.id)), "both original RGB lenses retain nearby scenery");
  assert.deepEqual(focused.front.position.toArray(), front.position.toArray());
  assert.deepEqual(focused.rear.position.toArray(), rear.position.toArray());
  assert.ok(front.getWorldDirection(new THREE.Vector3()).dot(rear.getWorldDirection(new THREE.Vector3())) < -.99);
  assert.ok(!rendersProxyAt(view, "pedestrian", far), "one body, not two overlapping LODs");

  await Promise.resolve();
  await Promise.all([...loads.values()].map(load => load.promise));
  await setImmediate();
  draw(true);
  const record = view.roots.get(far.id), rig = record.pedestrianRig;
  assert.ok(view.actorDiagnostics().focusedPersonReady && rig.diagnostics().bones > 70,
    JSON.stringify({ actor: far.kind, failed: view.status.failed, presented: view.actorDiagnostics() }));
  assert.equal(rig.diagnostics().actorId, far.id);
  const part = record.visual.getObjectsByProperty("isSkinnedMesh", true)[0];
  assert.ok(part);
  part.skeleton.computeBoneTexture();
  let disposed = 0;
  part.skeleton.boneTexture.addEventListener("dispose", () => disposed++);
  view.focusedPersonId = view.selectedPersonId = null;
  draw();
  assert.equal(disposed, 1);
  assert.equal(farRoot.parent, null);
  assert.ok(rendersProxyAt(view, "pedestrian", far));
  view.focusedPersonId = far.id;
  draw(true);
  assert.ok(view.roots.get(far.id).pedestrianRig && view.roots.get(far.id).pedestrianRig !== rig);
  assert.ok([...loads.values()].every(load => load.count === 1), "resident rigs reuse the same immutable installed assets");
  assert.equal(JSON.stringify(world.snapshot()), snapshot);
  assert.ok(actors.every((actor, index) => world.actors[index] === actor));
  t.diagnostic(`${first.availableActors} actors represented, ${first.detailedActors} detailed before human GLBs resolve`);
});

test("the latest camera can promote exact vehicle wheels while unneeded traffic uses pooled silhouettes", (t) => {
  const world = new World({ traffic: 72, pedestrians: 96 }, "metro");
  const view = new WorldView(world);
  t.after(() => view.dispose());
  const distant = world.actors.filter(actor => actor.kind === "taxi" && poseDistance(actor, world.player) > 85);
  const group = actor => `${actor.width}:${actor.length}:${actor.height}:${Math.floor(actor.phase * 3)}`;
  const first = distant.find(a => distant.some(b => a !== b && group(a) === group(b)));
  assert.ok(first, "seeded world needs two distant identical taxi models");
  const second = distant.find(actor => actor !== first && group(actor) === group(first));
  view.sync(1);
  view.prepareFrame();
  assert.ok(!view.roots.has(first.id) && !view.roots.has(second.id));
  const taxiProxy = view.scene.getObjectByName("metro-silhouettes-taxi");
  assert.ok(taxiProxy.isInstancedMesh && rendersProxyAt(view, "taxi", first));

  const firstCamera = new THREE.PerspectiveCamera(), nextCamera = new THREE.PerspectiveCamera();
  firstCamera.position.set(first.x, 1.5, first.z);
  nextCamera.position.set(second.x, 1.5, second.z);
  first.steer = .27;
  first.distance = 1.31;
  view.prepareFrame({ cameras: [firstCamera, nextCamera] });
  const a = view.roots.get(first.id), b = view.roots.get(second.id);
  assert.ok(a.visual && b.visual && !rendersProxyAt(view, "taxi", first));
  const shell = record => record.visual.getObjectByName("traffic-shell").geometry;
  assert.equal(shell(a), shell(b), "equal procedural fits reuse the same GPU geometry");
  const wheel = a.wheels.find(w => w.front), expected = wheel.quaternion.clone()
    .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), first.steer))
    .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), first.distance / wheel.radius));
  assert.ok(wheel.part.quaternion.angleTo(expected) < 1e-7);

  view.prepareFrame();
  assert.equal(a.root.parent, null);
  assert.ok(rendersProxyAt(view, "taxi", first));
  assert.equal(view.scene.getObjectByName("metro-silhouettes-taxi"), taxiProxy);
  assert.equal(world.actors.length, 169);
});
