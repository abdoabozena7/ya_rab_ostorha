import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { TrafficBatches, WorldView } from "../src/render/world-view.js";

function assertMatrix(actual, expected) {
  actual.elements.forEach((value, i) =>
    assert.ok(Math.abs(value - expected.elements[i]) < 1e-5, `matrix component ${i}`));
}

function materialState(material) {
  const { uuid, ...state } = material.toJSON();
  return state;
}

function assertInstances(batches) {
  const instance = new THREE.Matrix4(), world = new THREE.Matrix4();
  for (const { mesh, entries } of batches.groups.values()) {
    assert.equal(mesh.count, entries.length);
    for (let i = 0; i < entries.length; i++) {
      const { part } = entries[i];
      assert.equal(mesh.geometry, part.geometry, "Authored geometry/attributes remain shared and unchanged.");
      mesh.getMatrixAt(i, instance);
      world.multiplyMatrices(mesh.matrixWorld, instance);
      assertMatrix(world, part.matrixWorld);
      const originalNormal = new THREE.Vector3(.2, .7, .4).normalize();
      const expectedNormal = originalNormal.clone()
        .applyMatrix3(new THREE.Matrix3().getNormalMatrix(part.matrixWorld)).normalize();
      const e = instance.elements;
      const actualNormal = originalNormal.clone().divide(new THREE.Vector3(
        e[0] ** 2 + e[1] ** 2 + e[2] ** 2,
        e[4] ** 2 + e[5] ** 2 + e[6] ** 2,
        e[8] ** 2 + e[9] ** 2 + e[10] ** 2,
      )).applyMatrix3(new THREE.Matrix3().setFromMatrix4(instance))
        .applyMatrix3(new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld)).normalize();
      assert.ok(actualNormal.distanceTo(expectedNormal) < 1e-6,
        "r152 instance and mesh normal matrices must preserve original lighting/reflections.");
    }
  }
}

function cameraFrustum(camera) {
  camera.updateMatrixWorld(true);
  return new THREE.Frustum().setFromProjectionMatrix(
    new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
}

function submittedInstances(batches, frustum) {
  return [...batches.groups.values()].reduce((sum, { mesh }) =>
    sum + ((!mesh.frustumCulled || frustum.intersectsObject(mesh)) ? mesh.count : 0), 0);
}

function assertMergedBodies(batches) {
  const expected = new THREE.Vector3(), actual = new THREE.Vector3();
  for (const { mesh, sources } of batches.mergedBodies) {
    const position = mesh.geometry.attributes.position, normal = mesh.geometry.attributes.normal;
    const mergedNormal = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
    let offset = 0;
    for (const part of sources) {
      assert.deepEqual(materialState(mesh.material), materialState(part.material));
      assert.equal(mesh.castShadow, part.castShadow);
      assert.equal(mesh.receiveShadow, part.receiveShadow);
      assert.equal(mesh.renderOrder, part.renderOrder);
      assert.equal(mesh.layers.mask, part.layers.mask);
      const sourcePosition = part.geometry.attributes.position, sourceNormal = part.geometry.attributes.normal;
      const sourceMatrix = new THREE.Matrix3().getNormalMatrix(part.matrixWorld);
      for (let i = 0; i < sourcePosition.count; i++) {
        expected.fromBufferAttribute(sourcePosition, i).applyMatrix4(part.matrixWorld);
        actual.fromBufferAttribute(position, offset + i).applyMatrix4(mesh.matrixWorld);
        assert.ok(actual.distanceTo(expected) < 1e-5, "Every merged body vertex must retain its world position.");
        expected.fromBufferAttribute(sourceNormal, i).applyMatrix3(sourceMatrix).normalize();
        actual.fromBufferAttribute(normal, offset + i).applyMatrix3(mergedNormal).normalize();
        assert.ok(actual.distanceTo(expected) < 1e-6, "Every merged body vertex must retain its lighting normal.");
      }
      offset += sourcePosition.count;
    }
    assert.equal(position.count, offset, "No body triangle may be removed, duplicated or approximated.");
  }
}

test("district batching preserves every opaque traffic part and exact moving wheel transform", () => {
  const scene = new THREE.Scene(), batches = new TrafficBatches(scene);
  const geometry = new THREE.BoxGeometry(1, .6, 2);
  const paint = new THREE.MeshStandardMaterial({ color: 0x455b76 });
  const glass = new THREE.MeshStandardMaterial({ transparent: true, opacity: .4 });
  const records = [];
  for (let i = 0; i < 28; i++) {
    const root = new THREE.Group(), visual = new THREE.Group(), wheel = new THREE.Group();
    root.position.set(i * 3, .12, i % 4);
    root.rotation.y = i * .1;
    wheel.position.set(.5, .3, 1);
    wheel.rotation.x = i * .2;
    const chassis = new THREE.Mesh(geometry, paint);
    const tire = new THREE.Mesh(geometry, paint);
    const window = new THREE.Mesh(geometry, glass);
    wheel.add(tire); visual.add(chassis, wheel, window); root.add(visual); scene.add(root);
    const record = { root, visual, wheel, wheels: [{ part: wheel }], chassis, tire, window };
    records.push(record); batches.add(record);
  }
  scene.updateMatrixWorld(true); batches.update();
  assert.ok(batches.diagnostics().batches > 1, "Distant vehicles cannot share one unculled batch.");
  assert.equal(batches.diagnostics().originalSubmissions, 56);
  assert.equal(batches.diagnostics().submittedInstances, 56);
  assert.ok(batches.diagnostics().allocatedInstances <= 112,
    "Sparse groups cannot upload hundreds of unused matrices per actor.");
  assert.ok(records.every((record) => record.window.visible), "Transparent ordering stays per vehicle.");
  assertInstances(batches);
  records[1].wheel.rotation.x += .7;
  records[2].visual.visible = false;
  scene.updateMatrixWorld(true); batches.update();
  assertInstances(batches);
  assert.equal(batches.diagnostics().submittedInstances, 54,
    "Hidden actors must not inflate bounds or submit zero-scale instances.");
  let geometryDisposals = 0, materialDisposals = 0;
  geometry.addEventListener("dispose", () => geometryDisposals++);
  paint.addEventListener("dispose", () => materialDisposals++);
  batches.dispose(); batches.dispose();
  assert.equal(geometryDisposals, 0);
  assert.equal(materialDisposals, 0);
  assert.ok(records.every((record) => record.chassis.visible && record.tire.visible));
  geometry.dispose(); paint.dispose(); glass.dispose();
});

test("spatial batches cull off-camera traffic independently while retaining every light-space caster", () => {
  const scene = new THREE.Scene(), batches = new TrafficBatches(scene);
  const geometry = new THREE.BoxGeometry(1, 1, 2), material = new THREE.MeshStandardMaterial();
  const records = [];
  for (const x of [0, -70, 70]) {
    const root = new THREE.Group(), visual = new THREE.Group(), part = new THREE.Mesh(geometry, material);
    root.position.set(x, .12, 20);
    part.castShadow = part.receiveShadow = true;
    visual.add(part); root.add(visual); scene.add(root);
    const record = { root, visual, part, wheels: [] };
    records.push(record); batches.add(record);
  }
  scene.updateMatrixWorld(true); batches.update();
  const camera = new THREE.PerspectiveCamera(40, 1, .1, 100);
  camera.position.set(0, 2, 0); camera.lookAt(0, 0, 20);
  const lightCamera = new THREE.OrthographicCamera(-100, 100, 100, -100, 1, 200);
  lightCamera.position.set(0, 100, 0); lightCamera.lookAt(0, 0, 0);
  assert.equal(submittedInstances(batches, cameraFrustum(camera)), 1,
    "A distant light-space caster must not inflate the color-camera submission.");
  assert.equal(submittedInstances(batches, cameraFrustum(lightCamera)), 3,
    "Camera culling must never remove off-camera shadow casters.");
  assert.ok([...batches.groups.values()].every(({ mesh }) =>
    mesh.frustumCulled && mesh.castShadow && mesh.receiveShadow));
  camera.position.x = 70; camera.lookAt(70, 0, 20);
  assert.equal(submittedInstances(batches, cameraFrustum(camera)), 1,
    "Each camera uses its own frustum without mutating/uploading instance data during rendering.");
  records[2].root.position.x = 0;
  records[1].visual.visible = false;
  scene.updateMatrixWorld(true); batches.update();
  camera.position.x = 0; camera.lookAt(0, 0, 20);
  assert.equal(submittedInstances(batches, cameraFrustum(camera)), 2, "Moving groups need current bounds.");
  assert.equal(submittedInstances(batches, cameraFrustum(lightCamera)), 2);
  assert.equal(batches.diagnostics().batches, 1, "Empty cells must release their instance resources.");
  batches.dispose(); geometry.dispose(); material.dispose();
});

test("nonuniform fitted wheels preserve normals and unsupported reflected/sheared parts stay original", () => {
  const scene = new THREE.Scene(), batches = new TrafficBatches(scene);
  const root = new THREE.Group(), visual = new THREE.Group(), wheel = new THREE.Group();
  const geometry = new THREE.BoxGeometry(.4, .8, .8), material = new THREE.MeshStandardMaterial();
  root.rotation.y = .3; visual.scale.set(.7, .7, 1.1); wheel.rotation.x = .63;
  const tire = new THREE.Mesh(geometry, material), reflected = new THREE.Mesh(geometry, material),
    sheared = new THREE.Mesh(geometry, material);
  reflected.scale.x = -1;
  sheared.rotation.x = .47;
  wheel.add(tire); visual.add(wheel, reflected, sheared); root.add(visual); scene.add(root);
  const record = { root, visual, wheels: [{ part: wheel }] };
  batches.add(record); scene.updateMatrixWorld(true); batches.update();
  assertInstances(batches);
  assert.equal(reflected.visible, true, "Three.js instances cannot preserve a negative determinant.");
  assert.equal(sheared.visible, true, "Unsupported instance shear must retain the original renderer.");
  assert.equal(batches.diagnostics().submittedInstances, 1);
  root.scale.set(1.3, .9, .8); root.rotation.z = .4; wheel.rotation.y = .2;
  scene.updateMatrixWorld(true); batches.update();
  assertInstances(batches);
  batches.dispose(); geometry.dispose(); material.dispose();
});

test("installed traffic GLBs keep all triangles, palette materials and animated wheel vertex/normal transforms", async () => {
  const scene = new THREE.Scene(), batches = new TrafficBatches(scene);
  const geometryResources = new Set(), materialResources = new Set();
  const sourceParts = [], cachedMaterials = new Map(), geometryBytes = new Map();
  let originalParts = 0;
  for (const name of ["traffic-saloon", "traffic-hatchback", "traffic-crossover", "traffic-minivan"]) {
    const bytes = readFileSync(resolve("assets", "models", "vehicles", `${name}.glb`));
    const gltf = await new GLTFLoader().parseAsync(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), "");
    gltf.scene.traverse((part) => {
      if (!part.isMesh) return;
      geometryResources.add(part.geometry); materialResources.add(part.material);
      geometryBytes.set(part.geometry, Object.entries(part.geometry.attributes).map(([name, attribute]) =>
        [name, new Uint8Array(attribute.array.buffer, attribute.array.byteOffset, attribute.array.byteLength).slice()]));
      cachedMaterials.set(part.material, JSON.stringify(part.material.toJSON()));
    });
    for (let i = 0; i < 2; i++) {
      const root = new THREE.Group(), visual = gltf.scene.clone(true), wheels = [];
      root.position.set(i * 3, .12, originalParts / 4); root.rotation.y = .3;
      visual.scale.set(.7, .7, .87);
      visual.traverse((part) => {
        if (/^wheel-(front|rear)-(left|right)$/.test(part.name)) {
          wheels.push({ part }); part.rotateY(.17); part.rotateX(.47);
        }
        if (!part.isMesh) return;
        originalParts++;
        sourceParts.push(part);
        if (part.material.name === "paint") {
          const cached = part.material;
          part.material = cached.clone(); part.material.color.setHex(0x455b76);
          part.material.userData.trafficPaletteKey = `${cached.uuid}:455b76`;
          materialResources.add(part.material);
        }
        part.castShadow = part.receiveShadow = true;
      });
      root.add(visual); scene.add(root); batches.add({ root, visual, wheels });
    }
  }
  scene.updateMatrixWorld(true); batches.update();
  assert.equal(originalParts, 200);
  const directParts = sourceParts.filter((part) => part.visible);
  assert.equal(directParts.length, 8);
  assert.ok(directParts.every((part) => part.material.name === "glass"),
    "The installed opaque glass must also retain its original per-car submission.");
  assert.equal(batches.diagnostics().originalSubmissions + directParts.length, originalParts);
  assert.equal(batches.diagnostics().originalSubmissions - batches.diagnostics().submittedInstances, 24,
    "Eight actual vehicles must each replace four identical-material body paint primitives with one.");
  assert.equal(batches.mergedBodies.length, 8);
  assert.equal(batches.bodyGeometries.size, 4, "Clones reuse exact body geometry without sharing owned material disposal.");
  assert.ok(batches.mergedBodies.every((body) => body.sources.length === 4 && body.mesh.material.name === "paint"));
  assertMergedBodies(batches);
  assertInstances(batches);
  for (const { mesh, entries } of batches.groups.values()) {
    for (const { part } of entries) {
      assert.deepEqual(materialState(mesh.material), materialState(part.material));
      assert.equal(mesh.castShadow, part.castShadow);
      assert.equal(mesh.receiveShadow, part.receiveShadow);
    }
  }
  scene.children.filter((root) => root.isGroup).forEach((root) => {
    root.rotation.y += .4;
    root.position.x += .3;
  });
  scene.updateMatrixWorld(true); batches.update();
  assertMergedBodies(batches);
  assertInstances(batches);
  let ownedDisposals = 0, cachedDisposals = 0;
  batches.bodyGeometries.forEach((geometry) => geometry.addEventListener("dispose", () => ownedDisposals++));
  geometryResources.forEach((geometry) => geometry.addEventListener("dispose", () => cachedDisposals++));
  cachedMaterials.forEach((json, material) => material.addEventListener("dispose", () => cachedDisposals++));
  batches.dispose(); batches.dispose();
  assert.equal(ownedDisposals, 4);
  assert.equal(cachedDisposals, 0);
  assert.ok(sourceParts.every((part) => part.visible), "Disposal must restore every original body and wheel part.");
  for (const [geometry, attributes] of geometryBytes)
    for (const [name, bytes] of attributes) {
      const attribute = geometry.attributes[name];
      assert.deepEqual(new Uint8Array(attribute.array.buffer, attribute.array.byteOffset, attribute.array.byteLength), bytes,
        "Merging must never mutate cached GLB attribute bytes.");
    }
  for (const [material, json] of cachedMaterials)
    assert.equal(JSON.stringify(material.toJSON()), json, "Cached source GLB colors must not change.");
  geometryResources.forEach((geometry) => geometry.dispose());
  materialResources.forEach((material) => material.dispose());
});

test("frame preparation updates accepted poses before instances and owns scene matrices only in Egypt", () => {
  const scene = new THREE.Scene(), trafficBatches = new TrafficBatches(scene);
  const root = new THREE.Group(), visual = new THREE.Group();
  const geometry = new THREE.BoxGeometry(1, 1, 2), material = new THREE.MeshStandardMaterial();
  const part = new THREE.Mesh(geometry, material);
  visual.add(part); root.add(visual); scene.add(root);
  root.position.set(1, .12, 20);
  trafficBatches.add({ root, visual, wheels: [] });
  const view = { world: { environment: "egypt" }, scene, trafficBatches };
  WorldView.prototype.prepareFrame.call(view);
  assert.equal(scene.matrixWorldAutoUpdate, false);
  assertInstances(trafficBatches);
  const previous = part.matrixWorld.clone();
  root.position.x += .3; root.rotation.y = .4;
  WorldView.prototype.prepareFrame.call(view);
  assert.notDeepEqual(part.matrixWorld.elements, previous.elements);
  assertInstances(trafficBatches);
  const city = { world: { environment: "city" }, scene: new THREE.Scene(), trafficBatches: null };
  const cityRoot = new THREE.Object3D(); city.scene.add(cityRoot); cityRoot.position.x = 7;
  WorldView.prototype.prepareFrame.call(city);
  assert.equal(cityRoot.matrixWorld.elements[12], 7);
  assert.equal(city.scene.matrixWorldAutoUpdate, true, "Existing renderer-owned non-Egypt scenes remain unchanged.");
  trafficBatches.dispose(); geometry.dispose(); material.dispose();
});
