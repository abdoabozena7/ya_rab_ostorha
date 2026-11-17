import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { WorldView } from "../src/render/world-view.js";

function roadView(roads) {
  const view = { world: { roads }, scene: new THREE.Scene(),
    surfaces: { road: [], pavement: [] } };
  WorldView.prototype.buildRoads.call(view);
  return view;
}

function vertices(geometry) {
  const positions = geometry.getAttribute("position");
  return Array.from({ length: positions.count }, (_, i) =>
    [positions.getX(i), positions.getY(i), positions.getZ(i)]
      .map((value) => Math.round(value * 100000) / 100000).join(",")).sort();
}

function dispose(view) {
  for (const mesh of view.scene.children) {
    mesh.geometry.dispose();
    mesh.material.dispose();
  }
}

test("batched lane paint preserves every box face and crossing gap without per-dash draws", () => {
  const view = roadView([
    { axis: "z", fixed: 0, min: -18, max: 18, width: 10 },
    { axis: "x", fixed: 0, min: -18, max: 18, width: 10 },
  ]);
  const reference = [];
  try {
    for (const center of [-14, 13]) {
      reference.push(new THREE.BoxGeometry(0.11, 0.005, 2.8).translate(0, 0.1205, center));
      reference.push(new THREE.BoxGeometry(2.8, 0.005, 0.11).translate(center, 0.1205, 0));
    }
    const markings = view.scene.children.filter((mesh) =>
      !view.surfaces.road.includes(mesh) && !view.surfaces.pavement.includes(mesh));
    assert.equal(markings.length, 1, "Unchanged paint must be submitted as one batch");
    assert.equal(view.scene.children.length, 3);
    assert.deepEqual(vertices(markings[0].geometry), reference.flatMap(vertices).sort());
    assert.equal(markings[0].geometry.getIndex().count, 4 * 36);
    assert.equal(markings[0].castShadow, true);
    assert.equal(markings[0].receiveShadow, true);
  } finally {
    reference.forEach((geometry) => geometry.dispose());
    dispose(view);
  }
});

test("parking bays and side streets do not acquire paint from an empty batch", () => {
  const view = roadView([
    { axis: "z", fixed: 0, min: -18, max: 18, width: 4, parkingBay: true },
    { axis: "x", fixed: 0, min: -18, max: 18, width: 6, sideStreet: true },
  ]);
  try {
    assert.equal(view.scene.children.length, 2);
    assert.equal(view.surfaces.road.length, 1);
    assert.equal(view.surfaces.pavement.length, 1);
  } finally {
    dispose(view);
  }
});
