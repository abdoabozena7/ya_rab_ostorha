import { Group, MathUtils, Vector3 } from "three";

const LEAN_TICKS = 7;
const DOWN_TICKS = 25;
const HOLD_TICKS = 105;
const END_TICKS = 132;
const ROAD_CLEARANCE_M = 0.006;
const views = new WeakMap();

function impactView(root) {
  let view = views.get(root);
  if (!view) {
    view = { pivot: new Group(), vertex: new Vector3(), meshes: [], children: -1 };
    views.set(root, view);
    root.add(view.pivot);
  }
  const { pivot, meshes } = view;
  const changed = root.children.length > 1 || pivot.children.length !== view.children;
  if (changed) {
    // Keep the visual's local transform so its gait still grounds in parent space.
    for (let i = root.children.length - 1; i >= 0; i--) {
      const child = root.children[i];
      if (child !== pivot) pivot.add(child);
    }
    meshes.length = 0;
    pivot.traverse((part) => {
      if (part.isMesh && part.geometry?.attributes.position) meshes.push(part);
    });
    view.children = pivot.children.length;
  }
  return view;
}

function clearView(root) {
  const view = views.get(root);
  if (!view) return;
  const { pivot } = view;
  while (pivot.children.length) root.add(pivot.children[0]);
  root.remove(pivot);
  views.delete(root);
}

function groundVisual(root, view, tilt) {
  const { pivot, vertex, meshes } = view;
  pivot.position.y = 0;
  root.updateWorldMatrix(true, false);
  pivot.updateMatrixWorld(true);
  const groundY = root.matrixWorld.elements[13];
  let lowY = Infinity;
  for (const mesh of meshes) {
    let node = mesh;
    while (node && node !== pivot && node.visible) node = node.parent;
    if (node !== pivot) continue;
    // Bind-pose bounds miss the ankle after gait and the near-horizontal tilt.
    const count = mesh.geometry.attributes.position.count;
    for (let i = 0; i < count; i++) {
      mesh.getVertexPosition(i, vertex).applyMatrix4(mesh.matrixWorld);
      if (vertex.y < lowY) lowY = vertex.y;
    }
  }
  const clearance = ROAD_CLEARANCE_M * MathUtils.smoothstep(tilt, 0, 0.25);
  pivot.position.y = Math.max(0, groundY + clearance - lowY);
  if (pivot.position.y) pivot.updateMatrixWorld(true);
  return pivot.position.y;
}

/** Tilt and ground only the displayed body after gait; leave its actor root untouched. */
export function applyPedestrianImpact(root, actor, tick, alpha = 1) {
  const impact = actor?.impact;
  const elapsed = Number.isFinite(impact?.tick)
    ? tick + (Number.isFinite(alpha) ? MathUtils.clamp(alpha, 0, 1) : 1) - impact.tick : NaN;
  const { userData } = root;
  if (!Number.isFinite(impact?.heading) || !Number.isFinite(elapsed) || elapsed < 0 || elapsed >= END_TICKS) {
    if (userData.pedestrianImpactPose) {
      clearView(root);
      delete userData.pedestrianImpactPose;
    }
    return;
  }

  const pace = MathUtils.smoothstep(Number.isFinite(impact.closingSpeedMps) ? impact.closingSpeedMps : 0, 0, 9);
  const lean = MathUtils.lerp(0.28, 0.46, pace) * MathUtils.smoothstep(elapsed, 0, LEAN_TICKS);
  const fall = MathUtils.smoothstep(elapsed, LEAN_TICKS, DOWN_TICKS);
  const release = MathUtils.smoothstep(elapsed, HOLD_TICKS, END_TICKS);
  const tilt = MathUtils.lerp(lean, MathUtils.lerp(1.38, 1.48, pace), fall) * (1 - release);
  const direction = impact.heading - root.rotation.y;
  const reach = Math.sin(tilt);
  // With yaw applied first, local pitch/roll point the tilt along the impact heading.
  const pitch = Math.atan2(reach * Math.cos(direction), Math.cos(tilt));
  const roll = -Math.asin(reach * Math.sin(direction));
  const view = impactView(root);
  view.pivot.rotation.set(pitch, 0, roll, "YXZ");
  const pose = userData.pedestrianImpactPose ??= {};
  pose.tick = impact.tick;
  pose.elapsedTicks = elapsed;
  pose.tiltRad = tilt;
  pose.groundLiftM = groundVisual(root, view, tilt);
}
