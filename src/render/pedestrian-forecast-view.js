import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

const TRACKS = 6, GHOSTS = 3, DOTS = 24;
const TINT = { sensor: 0xf6b567, camera: 0x7cdecf };
const GROUND_Y = .136; // Clear the City's pavement and road paint without a height query.
const DOT_SPACING = .34, MIN_SEPARATION = .24;
const ignoreRaycast = () => {};

function figureGeometry() {
  const pieces = [];
  const start = new THREE.Vector3(), end = new THREE.Vector3(), axis = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0), turn = new THREE.Quaternion();
  function add(geometry, shade) {
    const normals = geometry.attributes.normal;
    const colors = new Float32Array(normals.count * 3);
    for (let i = 0; i < normals.count; i++) {
      const value = shade * (.86 + .14 * Math.max(0, normals.getY(i)));
      colors.fill(value, i * 3, i * 3 + 3);
    }
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    pieces.push(geometry);
  }
  function limb(a, b, fromRadius, toRadius, shade) {
    start.fromArray(a);
    end.fromArray(b);
    const length = axis.subVectors(end, start).length();
    turn.setFromUnitVectors(up, axis.multiplyScalar(1 / length));
    start.lerp(end, .5);
    add(new THREE.CylinderGeometry(toRadius, fromRadius, length, 5)
      .applyQuaternion(turn).translate(start.x, start.y, start.z), shade);
  }

  // A metre-scale step facing local +Z, with a head, shoulders and separated feet.
  add(new THREE.CylinderGeometry(1, .74, .48, 6).scale(.235, 1, .145).translate(0, 1.16, 0), 1);
  add(new THREE.CylinderGeometry(1, .9, .15, 6).scale(.16, 1, .12).translate(0, .86, 0), .78);
  add(new THREE.CylinderGeometry(.055, .065, .11, 6).translate(0, 1.44, .02), .78);
  add(new THREE.SphereGeometry(1, 8, 4).scale(.105, .13, .115).translate(0, 1.575, .027), 1);
  for (const side of [-1, 1]) {
    const stride = -side, footY = stride > 0 ? .04 : .12;
    const elbow = [side * .256, 1.08, -stride * .11];
    const knee = [side * .122, .458, stride * .145];
    limb([side * .207, 1.342, 0], elbow, .068, .051, .91);
    limb(elbow, [side * .263, .885, -stride * .20], .054, .037, .79);
    limb([side * .096, .846, 0], knee, .085, .061, .77);
    limb(knee, [side * .127, footY + .017, stride * .235], .064, .044, .82);
    add(new THREE.BoxGeometry(.107, .08, .222).translate(side * .127, footY, stride * .235 + .04), .74);
  }
  const figure = mergeGeometries(pieces);
  for (const piece of pieces) piece.dispose();
  return figure;
}

const coordinate = value => typeof value === "number" && Number.isFinite(Math.fround(value));
const distance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const near = (a, b) => b && distance(a, b) < MIN_SEPARATION;
const byTime = (a, b) => a.secondsAhead - b.secondsAhead;

function readPath(points, path) {
  path.length = 0;
  if (!Array.isArray(points)) return;
  let ordered = true;
  for (const point of points) {
    if (!coordinate(point?.x) || !coordinate(point.z) ||
        !Number.isFinite(point.secondsAhead) || point.secondsAhead < 0) continue;
    if (path.length && byTime(point, path[path.length - 1]) < 0) ordered = false;
    path.push(point);
  }
  if (!ordered) path.sort(byTime);
  let count = 0;
  for (const point of path)
    if (!count || point.secondsAhead > path[count - 1].secondsAhead) path[count++] = point;
  path.length = count;
}

function selectPoses(path, poses) {
  poses.length = 0;
  const anchor = path[0]?.secondsAhead === 0 ? path[0] : null;
  const first = path.findIndex(point => point.secondsAhead > 0 && !near(point, anchor));
  if (first === -1) return;
  poses.push(path[first]);
  // Keep the reach of the forecast; look for a distinct sample near its midpoint.
  let last = path.length - 1;
  while (last > first && (near(path[last], anchor) || near(path[last], path[first]))) last--;
  if (last === first) return;
  const midpoint = path[first].secondsAhead + (path[last].secondsAhead - path[first].secondsAhead) / 2;
  let middle, timeError = Infinity;
  for (let i = first + 1; i < last; i++) {
    const point = path[i], error = Math.abs(point.secondsAhead - midpoint);
    if (error < timeError && !near(point, anchor) && !near(point, path[first]) && !near(point, path[last])) {
      middle = point;
      timeError = error;
    }
  }
  if (middle) poses.push(middle);
  poses.push(path[last]);
}

function samePath(previous, path) {
  return previous.length === path.length && path.every((point, i) => {
    const old = previous[i];
    return old.x === point.x && old.z === point.z && old.secondsAhead === point.secondsAhead;
  });
}

function updateTrace(trace, path, matrix) {
  let metres = 0;
  for (let i = 1; i < path.length; i++) metres += distance(path[i - 1], path[i]);
  trace.count = Math.max(1, Math.min(DOTS, Math.round(metres / DOT_SPACING)));
  let segment = 0, start = 0, end = 0;
  for (let i = 0; i < trace.count; i++) {
    const at = metres * (i + .5) / trace.count;
    while (end <= at && segment < path.length - 1) {
      start = end;
      end += distance(path[segment], path[segment + 1]);
      segment++;
    }
    const a = path[Math.max(0, segment - 1)], b = path[segment];
    const t = end > start ? (at - start) / (end - start) : 0;
    trace.setMatrixAt(i, matrix.makeTranslation(a.x + (b.x - a.x) * t, GROUND_Y, a.z + (b.z - a.z) * t));
  }
  trace.instanceMatrix.updateRange.count = trace.count * 16;
  trace.instanceMatrix.needsUpdate = true;
  trace.computeBoundingSphere();
}

export function createPedestrianForecastView() {
  const group = new THREE.Group();
  group.name = "pedestrian-forecast";
  const figure = figureGeometry();
  const dot = new THREE.CircleGeometry(.074, 6).rotateX(-Math.PI / 2);
  const materialOptions = { transparent: true, depthWrite: false, depthTest: true, toneMapped: false };
  const tracePaint = {
    sensor: new THREE.MeshBasicMaterial({ ...materialOptions, color: TINT.sensor, opacity: .46 }),
    camera: new THREE.MeshBasicMaterial({ ...materialOptions, color: TINT.camera, opacity: .46 }),
  };
  const slots = Array.from({ length: TRACKS }, () => {
    const root = new THREE.Group();
    const trace = new THREE.InstancedMesh(dot, tracePaint.sensor, DOTS);
    trace.name = "forecast-trace";
    trace.raycast = ignoreRaycast;
    trace.count = 0;
    trace.renderOrder = -1;
    trace.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const ghosts = Array.from({ length: GHOSTS }, () => {
      const mesh = new THREE.Mesh(figure, new THREE.MeshBasicMaterial({ ...materialOptions, vertexColors: true }));
      mesh.name = "forecast-silhouette";
      mesh.raycast = ignoreRaycast;
      mesh.matrixAutoUpdate = false;
      mesh.visible = false;
      return mesh;
    });
    root.add(trace, ...ghosts);
    return { root, trace, ghosts, previous: [], source: null, heading: 0 };
  });
  const path = [], poses = [], matrix = new THREE.Matrix4();
  let active = 0, disposed = false;

  function update(predictions) {
    if (disposed) return;
    let count = 0;
    if (Array.isArray(predictions)) for (const track of predictions) {
      if (typeof track?.id !== "string" ||
          (track.source !== "camera" && track.source !== "sensor") || !Number.isFinite(track.heading)) continue;
      readPath(track.points, path);
      const slot = slots[count];
      // Compare values, so fresh DTO copies and in-place updates both work.
      if (slot.source !== track.source || slot.heading !== track.heading || !samePath(slot.previous, path)) {
        selectPoses(path, poses);
        if (!poses.length) continue;
        for (let i = 0; i < GHOSTS; i++) {
          const ghost = slot.ghosts[i], point = poses[i];
          ghost.visible = Boolean(point);
          if (!point) continue;
          ghost.position.set(point.x, GROUND_Y, point.z);
          ghost.rotation.y = track.heading;
          ghost.updateMatrix();
          ghost.material.color.setHex(TINT[track.source]);
          ghost.material.opacity = .62 / (1 + .9 * point.secondsAhead);
        }
        slot.trace.material = tracePaint[track.source];
        updateTrace(slot.trace, path, matrix);
        for (let i = 0; i < path.length; i++) {
          const point = path[i], old = slot.previous[i] ?? (slot.previous[i] = {});
          old.x = point.x;
          old.z = point.z;
          old.secondsAhead = point.secondsAhead;
        }
        slot.previous.length = path.length;
        slot.source = track.source;
        slot.heading = track.heading;
      }
      // Leave group.visible to the caller (in particular during sensor passes).
      if (count >= active) group.add(slot.root);
      if (++count === TRACKS) break;
    }
    for (let i = count; i < active; i++) slots[i].root.removeFromParent();
    active = count;
    path.length = poses.length = 0;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    group.removeFromParent();
    group.clear();
    for (const { trace, ghosts, previous } of slots) {
      trace.dispose();
      for (const ghost of ghosts) ghost.material.dispose();
      previous.length = 0;
    }
    figure.dispose();
    dot.dispose();
    tracePaint.camera.dispose();
    tracePaint.sensor.dispose();
  }

  return { group, update, dispose };
}
