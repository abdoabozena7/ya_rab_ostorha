import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { decodeGraphicsSettings } from "../src/ui/graphics-settings.js";
import { createMetroPlanarReflections, pickReflectionPlane } from "../src/render/metro-planar-reflections.js";

test("saved Auto recalculates for the current GPU and custom settings retain independent overrides", () => {
  const savedAuto = JSON.stringify({ preset: "auto", renderScale: 125 });
  const desktop = decodeGraphicsSettings(savedAuto, false);
  const integrated = decodeGraphicsSettings(savedAuto, true);
  assert.ok(integrated.renderScale < desktop.renderScale);
  assert.notEqual(desktop.renderScale, 125);

  const custom = {
    preset: "custom", renderScale: 91, reflections: "live", color: "cinematic",
    detail: "fine", exposure: 78, lensEffects: true, edgeSmoothing: true,
  };
  assert.deepEqual(decodeGraphicsSettings(JSON.stringify(custom), false), custom);
  assert.throws(() => decodeGraphicsSettings(JSON.stringify({ ...custom, renderScale: 900 }), true), RangeError);
  assert.throws(() => decodeGraphicsSettings(JSON.stringify({ ...custom, reflections: "mirror-everything" }), false), RangeError);
  const { edgeSmoothing, ...oldCustom } = custom;
  assert.deepEqual(decodeGraphicsSettings(JSON.stringify(oldCustom), false), { ...oldCustom, edgeSmoothing: false });
  assert.throws(() => decodeGraphicsSettings(JSON.stringify({ ...custom, edgeSmoothing: "on" }), true), RangeError);
});

test("puddle selection skips planes outside the view and rejects water above the camera", () => {
  const camera = new THREE.PerspectiveCamera(54, 1.6, 0.1, 200);
  camera.position.set(0, 3, 0);
  camera.lookAt(0, 0, -16);
  camera.updateMatrixWorld();
  const frustum = new THREE.Frustum().setFromProjectionMatrix(
    new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
  );
  const sphere = new THREE.Sphere();
  const puddle = (x, y, z, radius) => ({ x, y, z, radius, area: Math.PI * radius ** 2 });
  const dominant = puddle(0, 0, -16, 5);
  const nearSmall = puddle(-2, 0, -12, 1.6);
  const behind = puddle(0, 0, 12, 9);
  const overhead = puddle(0, 3, -15, 8);
  const distant = puddle(0, 0, -100, 8);
  assert.equal(pickReflectionPlane([nearSmall, behind, dominant, overhead, distant], camera.position, frustum, sphere), dominant);
  assert.equal(pickReflectionPlane([behind, overhead, distant], camera.position, frustum, sphere), null);
});

function recordReflectionCaptures() {
  const rendered = [];
  let target = null;
  const noop = () => {};
  const reflections = createMetroPlanarReflections({
    xr: { enabled: false },
    shadowMap: { autoUpdate: false, needsUpdate: false },
    state: { buffers: { depth: { setMask: noop } } },
    getRenderTarget: () => target,
    setRenderTarget(value) { target = value; },
    getActiveCubeFace: () => 0,
    getActiveMipmapLevel: () => 0,
    getScissorTest: () => false,
    getViewport: noop, getScissor: noop, setViewport: noop, setScissor: noop, setScissorTest: noop,
    render(_scene, camera) {
      rendered.push({
        texture: target.texture,
        viewProjection: new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
      });
    },
  });
  return { reflections, rendered };
}

test("live reflection holds a near-tied elevation until a challenger leads or the incumbent leaves view", () => {
  const { reflections, rendered } = recordReflectionCaptures();
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 200);
  const scene = new THREE.Scene();
  const low = { id: "low", x: -2, y: 0, z: -12, radius: 2, area: 3 };
  // The raw score winner flips near x = 0.
  const high = { id: "high", x: 2, y: 0.24, z: -12, radius: 2, area: 3.379 };
  const captureAt = (x, time, lookX = x) => {
    camera.position.set(x, 2, 0);
    camera.lookAt(lookX, 2, -12);
    return reflections.capture(scene, camera, [low, high], time, []);
  };

  for (const [x, time] of [[-0.02, 0], [0.02, 16], [-0.02, 32], [0.02, 48]]) {
    assert.equal(captureAt(x, time).planeY, low.y);
  }
  assert.equal(rendered.length, 1);
  assert.equal(captureAt(4, 64).planeY, high.y);
  assert.equal(rendered.length, 2);
  assert.equal(captureAt(4, 80, -12).planeY, low.y);
  assert.equal(rendered.length, 3);
});

test("live reflection keeps the captured pair on a small change and refreshes it at camera snaps", () => {
  const { reflections, rendered } = recordReflectionCaptures();
  const camera = new THREE.PerspectiveCamera(62, 1, 0.1, 200);
  const scene = new THREE.Scene();
  const planes = [{ id: "wide", x: 0, y: 0.12, z: 0, radius: 24, area: 100 }];
  const capture = time => reflections.capture(scene, camera, planes, time, []);
  const assertPaired = (sample, point) => {
    const { texture, viewProjection } = rendered.at(-1);
    const ndc = point.clone().applyMatrix4(viewProjection);
    const uv = point.clone().applyMatrix4(sample.matrix);
    assert.equal(sample.texture, texture);
    assert.ok(Math.hypot(uv.x - (ndc.x * 0.5 + 0.5), uv.y - (ndc.y * 0.5 + 0.5)) < 1e-10);
  };
  camera.position.set(0, 2, 0);
  camera.lookAt(0, 2, -1);
  const original = capture(0).matrix.clone();
  camera.fov = 63;
  camera.updateProjectionMatrix();
  camera.lookAt(0.04, 2, -1);
  const held = capture(16);
  assert.equal(rendered.length, 1);
  assert.deepEqual(held.matrix.elements, original.elements);
  const forwardPoint = new THREE.Vector3(2, 0.12, -10);
  assertPaired(held, forwardPoint);

  camera.fov = 68;
  camera.updateProjectionMatrix();
  const zoomed = capture(32);
  assert.equal(rendered.length, 2);
  assertPaired(zoomed, forwardPoint);
  camera.lookAt(1, 2, 0);
  const turned = capture(48);
  assert.equal(rendered.length, 3);
  assertPaired(turned, new THREE.Vector3(10, 0.12, 2));
});
