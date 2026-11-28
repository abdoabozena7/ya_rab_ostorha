import * as THREE from "three";
import { Reflector } from "three/addons/objects/Reflector.js";

const CAPTURE_INTERVAL_MS = 84;
const MAX_CAPTURE_EDGE = 640;
const MAX_PUDDLE_DISTANCE_M = 64;
const PLANE_SWITCH_SCORE_RATIO = 1.15;
const MAX_CAPTURE_SCALE_DRIFT = 0.10;

export function pickReflectionPlane(planes, eye, frustum, sphere, incumbent = null) {
  let best = null, bestScore = 0, incumbentScore = 0;
  for (const plane of planes) {
    const height = eye.y - plane.y;
    if (height <= 0.08) continue;
    sphere.center.set(plane.x, plane.y, plane.z);
    sphere.radius = plane.radius;
    const distanceSq = eye.distanceToSquared(sphere.center);
    if (distanceSq > (MAX_PUDDLE_DISTANCE_M + plane.radius) ** 2 ||
        !frustum.intersectsSphere(sphere)) continue;
    const score = plane.area * Math.min(height / Math.sqrt(distanceSq), 1) / Math.max(distanceSq, 1);
    if (plane === incumbent) incumbentScore = score;
    if (score <= bestScore) continue;
    best = plane;
    bestScore = score;
  }
  return incumbentScore > 0 && bestScore <= incumbentScore * PLANE_SWITCH_SCORE_RATIO ? incumbent : best;
}

export function createMetroPlanarReflections(renderer) {
  const frustum = new THREE.Frustum();
  const sphere = new THREE.Sphere();
  const viewProjection = new THREE.Matrix4();
  const inversePlane = new THREE.Matrix4();
  const eye = new THREE.Vector3();
  const captureEye = new THREE.Vector3();
  const heading = new THREE.Quaternion();
  const captureHeading = new THREE.Quaternion();
  const viewport = new THREE.Vector4();
  const scissor = new THREE.Vector4();
  const sample = {
    texture: null, matrix: new THREE.Matrix4(), texelSize: new THREE.Vector2(),
    planeY: 0,
  };
  let reflector, lastScene, lastPlane, capturedAt = -Infinity;
  let captureProjectionScale = 0;
  let captures = 0;

  function clear() {
    lastScene = lastPlane = null;
  }

  function capture(scene, camera, planes, timeMs, excluded) {
    camera.updateMatrixWorld();
    viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(viewProjection);
    eye.setFromMatrixPosition(camera.matrixWorld);
    const plane = pickReflectionPlane(planes, eye, frustum, sphere, scene === lastScene ? lastPlane : null);
    if (!plane) {
      clear();
      return null;
    }

    heading.setFromRotationMatrix(camera.matrixWorld);
    const projectionScale = camera.projectionMatrix.elements[5]; // Vertical scale, unaffected by near/far.
    const width = Math.max(1, Math.round(MAX_CAPTURE_EDGE * Math.min(camera.aspect, 1)));
    const height = Math.max(1, Math.round(MAX_CAPTURE_EDGE / Math.max(camera.aspect, 1)));
    if (!reflector) {
      reflector = new Reflector(new THREE.BufferGeometry(), { clipBias: 0.0005, multisample: 0 });
      reflector.rotation.x = -Math.PI / 2;
    }
    const target = reflector.getRenderTarget();
    const resized = target.width !== width || target.height !== height;
    if (!resized && scene === lastScene && plane === lastPlane && timeMs - capturedAt < CAPTURE_INTERVAL_MS &&
        eye.distanceToSquared(captureEye) < 4 && heading.angleTo(captureHeading) < 0.13 &&
        Math.abs(projectionScale - captureProjectionScale) < captureProjectionScale * MAX_CAPTURE_SCALE_DRIFT) return sample;

    if (resized) target.setSize(width, height);
    reflector.position.y = plane.y;
    reflector.updateMatrixWorld();
    const hidden = excluded.filter(object => object?.visible);
    const previous = {
      target: renderer.getRenderTarget(),
      cubeFace: renderer.getActiveCubeFace(),
      mipLevel: renderer.getActiveMipmapLevel(),
      toneMapping: renderer.toneMapping,
      outputColorSpace: renderer.outputColorSpace,
      xr: renderer.xr.enabled,
      shadowAutoUpdate: renderer.shadowMap.autoUpdate,
      shadowNeedsUpdate: renderer.shadowMap.needsUpdate,
      scissorTest: renderer.getScissorTest(),
    };
    renderer.getViewport(viewport);
    renderer.getScissor(scissor);
    for (const object of hidden) object.visible = false;
    renderer.shadowMap.needsUpdate = false;
    try {
      reflector.onBeforeRender(renderer, scene, camera);
    } finally {
      for (const object of hidden) object.visible = true;
      renderer.toneMapping = previous.toneMapping;
      renderer.outputColorSpace = previous.outputColorSpace;
      renderer.xr.enabled = previous.xr;
      renderer.shadowMap.autoUpdate = previous.shadowAutoUpdate;
      renderer.shadowMap.needsUpdate = previous.shadowNeedsUpdate;
      renderer.setRenderTarget(previous.target, previous.cubeFace, previous.mipLevel);
      if (!previous.target) {
        renderer.setViewport(viewport);
        renderer.setScissor(scissor);
        renderer.setScissorTest(previous.scissorTest);
      }
    }

    sample.texture = target.texture;
    // The Three reflector provides a local-to-texture transform. The pooled
    // puddle mesh needs world-to-texture coordinates instead.
    inversePlane.copy(reflector.matrixWorld).invert();
    sample.matrix.multiplyMatrices(reflector.material.uniforms.textureMatrix.value, inversePlane);
    sample.texelSize.set(1 / width, 1 / height);
    sample.planeY = plane.y;
    lastScene = scene;
    lastPlane = plane;
    captureEye.copy(eye);
    captureHeading.copy(heading);
    captureProjectionScale = projectionScale;
    capturedAt = timeMs;
    captures++;
    return sample;
  }

  return {
    capture,
    clear,
    diagnostics() {
      const target = reflector?.getRenderTarget();
      return { captures, puddle: lastPlane?.id ?? null, width: target?.width ?? 0, height: target?.height ?? 0 };
    },
  };
}
