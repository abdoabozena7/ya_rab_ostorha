import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { RGBELoader } from "three/addons/loaders/RGBELoader.js";
import { clone } from "three/addons/utils/SkeletonUtils.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import {
  angleDelta, interpolate, isDiagonalRoad, pointOnRoad, roadFrame, roadRect,
} from "../core/geometry.js";
import { avenueCrossings } from "../core/district-behavior.js";
import { addPlaceSigns } from "./place-signs.js";
import { createPlayerVehicle } from "./player-vehicle.js";
import { createEgyptStreetLayer, usesCityV4StreetFinish } from "./egypt-streets.js";
import { createPedestrianRig } from "./pedestrian-rig.js";
import { createDistrictProps } from "./district-props.js";
import { createPursuitView } from "./pursuit-view.js";
import { applyPedestrianImpact } from "./pedestrian-impact.js";
import { createUnifiedTrafficModel, disposeUnifiedTrafficModel } from "./unified-traffic-model.js";

const templates = new Map(),
  loader = new GLTFLoader();
const textureLoader = new THREE.TextureLoader();
const CITY_V4_SURFACE = {
  // The baked asphalt is ochre-biased. Correct its albedo, not the sun or the plaster.
  road: { base: 0x43484a, mapTint: 0xadc9ef, relief: .18 },
  pavement: { base: 0xa2a39b, mapTint: 0xcad1da, relief: .20 },
  ground: 0x7d7a70,
};
let streetLighting;
const trafficColors = [
  0x88969a, 0xa84a39, 0xb0b5ac, 0x455b76, 0x8f7458, 0x62766a,
];
const METRO_NEAR_M = 42, METRO_RELEASE_M = 51;
const CURB_WHEEL_PIVOTS = {
  frontLeft: "wheel-front-left", frontRight: "wheel-front-right",
  rearLeft: "wheel-rear-left", rearRight: "wheel-rear-right",
};
const METRO_TRAFFIC = {
  // Height and greenhouse proportions. A single opaque mesh per family stands
  // in for the actual fitted shell and wheels only at street distance.
  sedan: [1.47, .83, .51, .01, .57],
  taxi: [1.57, .86, .59, -.035, .55],
  suv: [1.84, .88, .70, -.07, .60],
  van: [2.05, .91, .87, -.05, .51],
  tuktuk: [1.79, .84, .64, -.14, .42],
};
const proxyKind = (actor) => actor.type === "pedestrian" ? "pedestrian"
  : Object.hasOwn(METRO_TRAFFIC, actor.kind) ? actor.kind : "sedan";
const metroPalette = (kind) => kind === "taxi" ? [0xddd0ac, 0xd5c49e, 0xe4dbba]
  : kind === "tuktuk" ? [0xbb9142, 0x547868, 0x974d38]
    : [0x788f98, 0x9b5140, 0xb9b5a2, 0x48677f, 0x8c7358, 0x66796b];
const metroPalettes = Object.fromEntries(Object.keys(METRO_TRAFFIC).map(kind => [kind, metroPalette(kind)]));
const paintIndex = (actor, colors) =>
  Math.min(colors.length - 1, Math.max(0, Math.floor((Number.isFinite(actor.phase) ? actor.phase : 0) * colors.length)));

function actorProxyGeometry(kind) {
  const parts = [];
  function add(geometry, tint) {
    const { r, g, b } = new THREE.Color(tint), count = geometry.attributes.position.count;
    const colors = new Float32Array(count * 3);
    for (let i = 0; i < colors.length; i += 3) {
      colors[i] = r; colors[i + 1] = g; colors[i + 2] = b;
    }
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    parts.push(geometry);
  }
  function cube(w, h, l, x, y, z, tint, taper = 1) {
    const geometry = new THREE.BoxGeometry(w, h, l);
    if (taper < 1) {
      const position = geometry.attributes.position;
      for (let i = 0; i < position.count; i++) if (position.getY(i) > 0) {
        position.setX(i, position.getX(i) * taper);
        position.setZ(i, position.getZ(i) * taper);
      }
      geometry.computeVertexNormals();
    }
    add(geometry.translate(x, y, z), tint);
  }
  if (kind === "pedestrian") {
    cube(.82, .36, .82, 0, .60, 0, 0x9ba5a0, .88);
    add(new THREE.SphereGeometry(1, 6, 4).scale(.25, .085, .30).translate(0, .90, .015), 0xd0a887);
    for (const side of [-1, 1]) {
      cube(.29, .45, .55, side * .18, .228, 0, 0x555a59);
      cube(.17, .30, .45, side * .43, .565, 0, 0xa4a69a);
    }
  } else {
    const [, roofWidth, roofDepth, roofZ, belt] = METRO_TRAFFIC[kind === "patrol" ? "sedan" : kind];
    const tuk = kind === "tuktuk";
    cube(tuk ? .90 : 1, belt - .18, 1, 0, (belt + .18) / 2, 0, 0xffffff, tuk ? .89 : .96);
    cube(roofWidth, .94 - belt, roofDepth, 0, (belt + .94) / 2, roofZ, 0x647671,
      kind === "van" ? .93 : .81);
    cube(roofWidth * .84, .06, roofDepth * .84, 0, .97, roofZ, tuk ? 0x454947 : 0xe0ded2);
    if (kind === "patrol") {
      cube(.65, .045, .12, 0, 1.02, roofZ, 0x343936);
      cube(.29, .06, .11, -.154, 1.06, roofZ, 0x54a7ff);
      cube(.29, .06, .11, .154, 1.06, roofZ, 0xff6358);
    }
    for (const axle of [-.31, .31])
      for (const side of tuk && axle > 0 ? [0] : [-1, 1])
        add(new THREE.CylinderGeometry(1, 1, 1, 6).rotateZ(Math.PI / 2)
          .scale(.13, .17, .063).translate(side * .42, .17, axle), 0x343936);
  }
  const geometry = mergeGeometries(parts);
  for (const part of parts) part.dispose();
  return geometry;
}

export class MetroSilhouettes {
  constructor(scene, { markPatrols = false } = {}) {
    this.scene = scene;
    this.markPatrols = markPatrols;
    this.groups = new Map();
    this.material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .96 });
    this.material.name = "metro-distance-silhouettes";
    this.pose = new THREE.Object3D();
    this.color = new THREE.Color();
  }
  geometry(kind) {
    let group = this.groups.get(kind);
    if (!group) this.groups.set(kind, group = { geometry: actorProxyGeometry(kind), count: 0 });
    return group;
  }
  begin() {
    for (const group of this.groups.values()) group.count = 0;
  }
  put(actor, x, y, z, heading) {
    const kind = this.markPatrols && actor.pursuitRole === "police" ? "patrol" : proxyKind(actor);
    const group = this.geometry(kind), slot = group.count++;
    const width = kind === "pedestrian" ? actor.body?.widthM ?? .51 : actor.width;
    const height = kind === "pedestrian" ? actor.body?.heightM ?? 1.78
      : actor.height ?? (METRO_TRAFFIC[kind] ?? METRO_TRAFFIC.sedan)[0];
    const length = kind === "pedestrian" ? actor.body?.depthM ?? .32 : actor.length;
    const margin = Math.max(width, height, length);
    if (!group.mesh || slot >= group.mesh.instanceMatrix.count) {
      const old = group.mesh;
      const mesh = new THREE.InstancedMesh(group.geometry, this.material, Math.max(8, (old?.instanceMatrix.count ?? 0) * 2));
      mesh.name = `metro-silhouettes-${kind}`;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = mesh.matrixWorldAutoUpdate = false;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.boundingSphere = new THREE.Sphere();
      group.mesh = mesh;
      mesh.setColorAt(0, this.color);
      mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
      if (old) {
        mesh.instanceMatrix.array.set(old.instanceMatrix.array);
        mesh.instanceColor.array.set(old.instanceColor.array);
        old.removeFromParent();
        old.dispose();
      }
      this.scene.add(mesh);
    }
    if (!slot) {
      group.minX = group.maxX = x;
      group.minY = group.maxY = y;
      group.minZ = group.maxZ = z;
      group.margin = margin;
    } else {
      group.minX = Math.min(group.minX, x); group.maxX = Math.max(group.maxX, x);
      group.minY = Math.min(group.minY, y); group.maxY = Math.max(group.maxY, y);
      group.minZ = Math.min(group.minZ, z); group.maxZ = Math.max(group.maxZ, z);
      group.margin = Math.max(group.margin, margin);
    }
    const { pose } = this;
    pose.position.set(x, y, z);
    pose.rotation.y = heading;
    pose.scale.set(width, height, length);
    pose.updateMatrix();
    const colors = metroPalettes[kind];
    const tint = actor.pursuitRole === "police" ? 0xc3d0dc : colors ? colors[paintIndex(actor, colors)]
      : actor.kind?.endsWith("-jacket") ? 0xc9c9b8 : 0xeaddc7;
    group.mesh.setMatrixAt(slot, pose.matrix);
    group.mesh.setColorAt(slot, this.color.setHex(tint));
  }
  end() {
    for (const { mesh, count, minX, maxX, minY, maxY, minZ, maxZ, margin } of this.groups.values()) {
      if (!mesh) continue;
      mesh.count = count;
      if (!count) continue;
      mesh.instanceMatrix.updateRange.count = count * 16;
      mesh.instanceMatrix.needsUpdate = true;
      mesh.instanceColor.updateRange.count = count * 3;
      mesh.instanceColor.needsUpdate = true;
      mesh.boundingSphere.center.set((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2);
      mesh.boundingSphere.radius = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) / 2 + margin;
    }
  }
  dispose() {
    for (const { mesh, geometry } of this.groups.values()) {
      mesh?.removeFromParent();
      mesh?.dispose();
      geometry.dispose();
    }
    this.groups.clear();
    this.material.dispose();
  }
}

class MetroTrafficModels {
  constructor() {
    this.entries = new Map();
  }
  acquire(actor) {
    const kind = proxyKind(actor), colors = metroPalettes[kind];
    const key = `${kind}:${actor.width}:${actor.length}:${actor.height ?? ""}:${paintIndex(actor, colors)}`;
    let entry = this.entries.get(key);
    if (!entry) {
      const { root, wheels } = createUnifiedTrafficModel(actor);
      entry = { root, wheels, refs: 0 };
    }
    entry.refs++;
    this.entries.delete(key);
    this.entries.set(key, entry);
    const visual = entry.root.clone();
    for (const part of visual.children) delete part.userData.owned;
    const wheels = entry.wheels.map(wheel => ({ ...wheel, part: visual.getObjectByName(wheel.part.name) }));
    return { visual, wheels, entry };
  }
  release(entry) {
    entry.refs--;
    const idle = [...this.entries].filter(([, value]) => value.refs === 0);
    // Keep a small reusable set across boundary crossings, never one model per distant actor.
    while (idle.length > 4) {
      const [key, old] = idle.shift();
      this.entries.delete(key);
      disposeUnifiedTrafficModel(old.root);
    }
  }
  dispose() {
    for (const entry of this.entries.values()) disposeUnifiedTrafficModel(entry.root);
    this.entries.clear();
  }
}

function animateWheels(record, actor) {
  for (const wheel of record.wheels) {
    wheel.part.quaternion.copy(wheel.quaternion);
    if (wheel.front) wheel.part.rotateY(actor.steer ?? 0);
    wheel.part.rotateX(actor.distance / wheel.radius);
  }
}

function distanceToAnchors2(x, z, anchors) {
  let distance = Infinity;
  for (const point of anchors) distance = Math.min(distance, (x - point.x) ** 2 + (z - point.z) ** 2);
  return distance;
}

function containsXZ(rect, x, z) {
  return rect.minX <= x && x <= rect.maxX && rect.minZ <= z && z <= rect.maxZ;
}

function diagRoadInfo(road) {
  const dx = road.x2 - road.x1, dz = road.z2 - road.z1;
  const length = road.length ?? (Math.hypot(dx, dz) || 0);
  const ux = road.ux ?? (length > 0 ? dx / length : 0);
  const uz = road.uz ?? (length > 0 ? dz / length : 1);
  const heading = road.heading ?? Math.atan2(ux, uz);
  return { length, ux, uz, heading, mx: (road.x1 + road.x2) / 2, mz: (road.z1 + road.z2) / 2 };
}

function pointOnDiagRoad(p, road, margin = 0) {
  const { length, ux, uz } = diagRoadInfo(road);
  const h = road.width / 2 - margin;
  if (h <= 0) return false;
  const dx = p.x - road.x1, dz = p.z - road.z1;
  const along = dx * ux + dz * uz;
  if (along < -h || along > length + h) return false;
  return Math.abs(dx * uz - dz * ux) <= h;
}

function pointOnAnyRoad(p, roads, margin = 0) {
  for (const road of roads) {
    if (isDiagonalRoad(road)) {
      if (pointOnRoad(p, [road], margin) || pointOnDiagRoad(p, road, margin)) return true;
    } else if (pointOnRoad(p, [road], margin)) {
      return true;
    }
  }
  return false;
}

function diagAvenueCrossings(road, candidateRoads, allRoads = candidateRoads) {
  if (road.zone !== "avenue" || road.parkingBay) return [];
  const { length, ux, uz } = diagRoadInfo(road);
  const otherDriving = (candidateRoads ?? []).filter(other =>
    other !== road && !other.parkingBay && !other.supportApron);
  const blockers = (allRoads ?? []).filter(other =>
    other !== road && (!other.parkingBay || other.supportApron));
  const raw = [];
  for (const other of otherDriving) {
    const f = isDiagonalRoad(other)
      ? (() => { const d = diagRoadInfo(other); return { x1: other.x1, z1: other.z1, ux: d.ux, uz: d.uz, length: d.length }; })()
      : roadFrame(other);
    const det = -ux * f.uz + uz * f.ux;
    if (Math.abs(det) < 0.12) continue;
    const dx = f.x1 - road.x1, dz = f.z1 - road.z1;
    const t = (-f.uz * dx + f.ux * dz) / det;
    const u = (-uz * dx + ux * dz) / det;
    if (t < -other.width / 2 || t > length + other.width / 2 ||
        u < -road.width / 2 || u > f.length + road.width / 2) continue;
    const offset = Math.max(11.5, (other.width / 2 + (road.width / 2) * Math.abs(ux * f.ux + uz * f.uz)) / Math.abs(det) + 2.4);
    raw.push(t - offset, t + offset);
  }
  raw.sort((a, b) => a - b);
  const crossings = [];
  for (const along of raw) {
    if (along <= 8 || along >= length - 8) continue;
    if (crossings.some(prev => Math.abs(prev - along) < 4.5)) continue;
    const p = { x: road.x1 + ux * along, z: road.z1 + uz * along };
    if (pointOnAnyRoad(p, blockers, -1.0)) continue;
    crossings.push(along);
  }
  return crossings;
}

function disposeSkeletons(visual) {
  const skeletons = new Set();
  visual?.traverse(part => { if (part.isSkinnedMesh) skeletons.add(part.skeleton); });
  for (const skeleton of skeletons) skeleton.dispose();
}

function actorAsset(actor, environment) {
  if (actor.type === "pedestrian")
    return `/assets/models/people/${actor.kind}.glb`;
  if (actor.kind === "tuktuk")
    return "/assets/models/tuktuks/auto-rickshaw.glb";
  const car = {
    sedan: actor.phase < 0.5 ? "traffic-saloon" : "traffic-hatchback",
    taxi: "traffic-saloon",
    suv: "traffic-crossover",
    van: "traffic-minivan",
  }[actor.kind];
  return `/assets/models/vehicles/${car ?? actor.kind}.glb`;
}
function asset(url) {
  if (!templates.has(url)) templates.set(url, loader.loadAsync(url));
  return templates.get(url);
}
const material = (color) =>
  new THREE.MeshStandardMaterial({ color, roughness: 0.9 });
function box(parent, width, height, length, color, x = 0, y = 0, z = 0) {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(width, height, length),
    material(color),
  );
  mesh.position.set(x, y + height / 2, z);
  mesh.userData.owned = true;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}
function surfaceGeometry(rect, height, bottom, tileMetres) {
  const width = rect.maxX - rect.minX,
    length = rect.maxZ - rect.minZ,
    centerX = (rect.minX + rect.maxX) / 2,
    centerZ = (rect.minZ + rect.maxZ) / 2,
    geometry = new THREE.BoxGeometry(width, height, length),
    positions = geometry.getAttribute("position"),
    uv = geometry.getAttribute("uv");
  // BoxGeometry's +Y face is vertices 8–11. World-space UVs make overlapping
  // street rectangles sample the same texels at intersections.
  for (let i = 8; i < 12; i++)
    uv.setXY(
      i,
      (centerX + positions.getX(i)) / tileMetres,
      (centerZ + positions.getZ(i)) / tileMetres,
    );
  geometry.translate(centerX, bottom + height / 2, centerZ);
  return geometry;
}
function orientedSurfaceGeometry(width, length, height, bottom, centerX, centerZ, heading, tileMetres) {
  const geometry = new THREE.BoxGeometry(width, height, length);
  geometry.rotateY(heading);
  geometry.translate(centerX, bottom + height / 2, centerZ);
  const positions = geometry.getAttribute("position"),
    uv = geometry.getAttribute("uv");
  for (let i = 8; i < 12; i++)
    uv.setXY(i, positions.getX(i) / tileMetres, positions.getZ(i) / tileMetres);
  return geometry;
}
function mergedSurface(scene, geometries, color) {
  const geometry = mergeGeometries(geometries);
  for (const part of geometries) part.dispose();
  if (!geometry) throw new Error("Unable to assemble the road surface");
  const mesh = new THREE.Mesh(geometry, material(color));
  mesh.userData.owned = true;
  mesh.receiveShadow = true;
  scene.add(mesh);
  return mesh;
}
function wornPaint(width, length, x, z, heading = 0) {
  const wear = (Math.abs(Math.floor(x * 13 + z * 17)) % 9) / 8;
  const h = width / 2, l = length / 2, notch = .09 + wear * .16;
  const shape = new THREE.Shape();
  shape.moveTo(-h + width * notch, -l);
  shape.lineTo(h, -l + length * .045);
  shape.lineTo(h, l - length * notch);
  shape.lineTo(h - width * .10, l);
  shape.lineTo(-h, l);
  shape.lineTo(-h, -l + length * .06);
  const geometry = new THREE.ShapeGeometry(shape).rotateX(-Math.PI / 2);
  if (heading) geometry.rotateY(heading);
  geometry.translate(x, .12, z);
  const tint = new THREE.Color(0xd0c8b6).multiplyScalar(.69 + wear * .31);
  const colors = new Float32Array(geometry.attributes.position.count * 3);
  for (let n = 0; n < colors.length; n += 3) tint.toArray(colors, n);
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  return geometry;
}
function fit(template, width, length, height = Infinity, matchHull = false) {
  const visual = clone(template);
  // Bone matrices must be current before computing skinned bounds. Mesh nodes
  // can precede their armature in the GLB traversal order.
  visual.updateMatrixWorld(true);
  visual.traverse((part) => {
    if (part.isSkinnedMesh) {
      part.skeleton.update();
      part.computeBoundingBox();
    }
  });
  const bounds = new THREE.Box3().setFromObject(visual),
    size = bounds.getSize(new THREE.Vector3());
  const scale = Math.min(width / size.x, length / size.z, height / size.y);
  visual.scale.multiplyScalar(scale);
  visual.updateMatrixWorld(true);
  const scaled = new THREE.Box3().setFromObject(visual);
  if (matchHull) {
    visual.scale.z *= length / scaled.getSize(new THREE.Vector3()).z;
    visual.updateMatrixWorld(true);
    scaled.setFromObject(visual);
  }
  const center = scaled.getCenter(new THREE.Vector3());
  visual.position.add(new THREE.Vector3(-center.x, -scaled.min.y, -center.z));
  visual.traverse((part) => {
    if (part.isMesh) {
      part.castShadow = true;
      part.receiveShadow = true;
    }
  });
  return visual;
}

export class TrafficBatches {
  constructor(scene, capacity = 72 * 8) {
    this.scene = scene;
    this.capacity = capacity;
    this.groups = new Map();
    this.entries = [];
    this.parts = new Set();
    this.mergedBodies = [];
    this.bodyGeometries = new Map();
    this.sphere = new THREE.Sphere();
    this.matrix = new THREE.Matrix4();
    this.disposed = false;
  }
  eligible(part) {
    return part.isMesh && !part.isSkinnedMesh && !part.isInstancedMesh
      && !part.children.length && !Array.isArray(part.material)
      && !part.material.transparent && part.material.name !== "glass"
      && !(part.material.transmission > 0) && !part.morphTargetInfluences
      && !part.geometry.hasAttribute("tangent") && part.visible && !this.parts.has(part);
  }
  frameFor(record, part) {
    for (let parent = part; parent && parent !== record.visual; parent = parent.parent)
      if (record.wheels?.some((wheel) => wheel.part === parent)) return record.visual;
    return this.scene;
  }
  mergeBodies(record) {
    const groups = new Map();
    record.visual.traverse((part) => {
      if (!this.eligible(part) || this.frameFor(record, part) !== this.scene
          || part.geometry.groups.length || part.geometry.drawRange.start !== 0
          || part.geometry.drawRange.count !== Infinity
          || Object.keys(part.geometry.attributes).length !== 2
          || !["position", "normal"].every((name) => part.geometry.attributes[name]?.itemSize === 3)) return;
      const matrix = new THREE.Matrix4();
      for (let parent = part; parent && parent !== record.visual; parent = parent.parent) {
        if (!parent.visible) return;
        if (parent.matrixAutoUpdate) parent.updateMatrix();
        matrix.premultiply(parent.matrix);
      }
      if (matrix.determinant() <= 0) return;
      const { uuid, ...properties } = part.material.toJSON();
      const schema = Object.entries(part.geometry.attributes).sort(([a], [b]) => a.localeCompare(b)).map(([name, attribute]) =>
        [name, attribute.itemSize, attribute.normalized, attribute.array.constructor.name]);
      const key = JSON.stringify([properties, schema, !!part.geometry.index, part.castShadow,
        part.receiveShadow, part.renderOrder, part.layers.mask, part.frustumCulled]);
      let group = groups.get(key);
      if (!group) groups.set(key, group = []);
      group.push({ part, matrix });
    });
    for (const sources of groups.values()) {
      if (sources.length < 2) continue;
      const key = JSON.stringify(sources.map(({ part, matrix }) => [part.geometry.uuid, matrix.elements]));
      let geometry = this.bodyGeometries.get(key);
      if (!geometry) {
        const parts = sources.map(({ part, matrix }) => {
          const geometry = new THREE.BufferGeometry();
          for (const name of ["position", "normal"]) {
            const source = part.geometry.attributes[name], values = new Float32Array(source.count * 3);
            for (let i = 0; i < source.count; i++) {
              values[i * 3] = source.getX(i);
              values[i * 3 + 1] = source.getY(i);
              values[i * 3 + 2] = source.getZ(i);
            }
            geometry.setAttribute(name, new THREE.BufferAttribute(values, 3));
          }
          if (part.geometry.index) geometry.setIndex(part.geometry.index.clone());
          return geometry.applyMatrix4(matrix);
        });
        geometry = mergeGeometries(parts);
        parts.forEach((part) => part.dispose());
        if (!geometry) throw new Error("Unable to merge exact district traffic body geometry.");
        this.bodyGeometries.set(key, geometry);
      }
      const { part } = sources[0], mesh = new THREE.Mesh(geometry, part.material);
      mesh.name = "district-exact-traffic-body";
      mesh.castShadow = part.castShadow;
      mesh.receiveShadow = part.receiveShadow;
      mesh.renderOrder = part.renderOrder;
      mesh.layers.mask = part.layers.mask;
      mesh.frustumCulled = part.frustumCulled;
      record.visual.add(mesh);
      sources.forEach(({ part }) => { part.visible = false; });
      this.mergedBodies.push({ mesh, sources: sources.map(({ part }) => part) });
    }
  }
  add(record) {
    if (this.disposed) throw new Error("Cannot add traffic to a disposed batch.");
    this.mergeBodies(record);
    record.visual.traverse((part) => {
      if (!this.eligible(part)) return;
      // Keep the fit scale in the mesh normal matrix, not a sheared wheel instance.
      const frame = this.frameFor(record, part);
      const key = `${part.geometry.uuid}:${part.material.userData.trafficPaletteKey ?? part.material.uuid}` +
        `:${part.castShadow}:${part.receiveShadow}:${part.renderOrder}:${part.layers.mask}:${part.frustumCulled}`;
      this.entries.push({ part, record, frame, key });
      this.parts.add(part);
      part.visible = false;
    });
  }
  update() {
    if (this.disposed) return;
    const buckets = new Map(), inverses = new Map();
    for (const entry of this.entries) {
      const { part, frame } = entry;
      let visible = true;
      for (let parent = part.parent; parent; parent = parent.parent)
        if (!parent.visible && !this.parts.has(parent)) { visible = false; break; }
      if (!visible) continue;
      let inverse = inverses.get(frame);
      if (!inverse) {
        inverse = frame.matrixWorld.clone().invert();
        inverses.set(frame, inverse);
      }
      this.matrix.multiplyMatrices(inverse, part.matrixWorld);
      const e = this.matrix.elements,
        xx = e[0] ** 2 + e[1] ** 2 + e[2] ** 2,
        yy = e[4] ** 2 + e[5] ** 2 + e[6] ** 2,
        zz = e[8] ** 2 + e[9] ** 2 + e[10] ** 2,
        xy = e[0] * e[4] + e[1] * e[5] + e[2] * e[6],
        xz = e[0] * e[8] + e[1] * e[9] + e[2] * e[10],
        yz = e[4] * e[8] + e[5] * e[9] + e[6] * e[10];
      if (this.matrix.determinant() <= 0 ||
          Math.abs(xy) > 1e-7 * Math.sqrt(xx * yy) ||
          Math.abs(xz) > 1e-7 * Math.sqrt(xx * zz) ||
          Math.abs(yz) > 1e-7 * Math.sqrt(yy * zz)) {
        part.visible = true;
        continue;
      }
      part.visible = false;
      if (!part.geometry.boundingSphere) part.geometry.computeBoundingSphere();
      this.sphere.copy(part.geometry.boundingSphere).applyMatrix4(part.matrixWorld);
      const cell = frame === this.scene
        ? `${Math.floor(this.sphere.center.x / 8)}:${Math.floor(this.sphere.center.z / 8)}`
        : frame.uuid;
      const key = `${entry.key}:${cell}`;
      let bucket = buckets.get(key);
      if (!bucket) buckets.set(key, bucket = []);
      bucket.push(entry);
    }
    for (const [key, { mesh }] of this.groups)
      if (!buckets.has(key)) {
        mesh.removeFromParent();
        mesh.dispose();
        this.groups.delete(key);
      }
    for (const [key, entries] of buckets) {
      if (entries.length > this.capacity) throw new Error("District render batch capacity exceeded.");
      const { part, frame } = entries[0];
      let group = this.groups.get(key);
      if (!group || group.mesh.instanceMatrix.count < entries.length) {
        group?.mesh.removeFromParent();
        group?.mesh.dispose();
        const capacity = Math.min(this.capacity, 2 ** Math.ceil(Math.log2(entries.length)));
        const mesh = new THREE.InstancedMesh(part.geometry, part.material, capacity);
        mesh.name = "district-exact-traffic-batch";
        mesh.castShadow = part.castShadow;
        mesh.receiveShadow = part.receiveShadow;
        mesh.renderOrder = part.renderOrder;
        mesh.layers.mask = part.layers.mask;
        mesh.frustumCulled = part.frustumCulled;
        mesh.matrixAutoUpdate = false;
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        frame.add(mesh);
        group = { mesh, entries };
        this.groups.set(key, group);
      }
      const { mesh } = group;
      group.entries = entries;
      mesh.matrixWorld.copy(frame.matrixWorld);
      entries.forEach(({ part }, index) => {
        this.matrix.multiplyMatrices(inverses.get(frame), part.matrixWorld);
        mesh.setMatrixAt(index, this.matrix);
      });
      mesh.count = entries.length;
      mesh.instanceMatrix.updateRange.count = entries.length * 16;
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
    }
  }
  diagnostics() {
    return { batches: this.groups.size,
      originalSubmissions: this.entries.length +
        this.mergedBodies.reduce((sum, body) => sum + body.sources.length - 1, 0),
      submittedInstances: [...this.groups.values()].reduce((sum, group) => sum + group.mesh.count, 0),
      allocatedInstances: [...this.groups.values()].reduce((sum, group) => sum + group.mesh.instanceMatrix.count, 0),
      mergedBodies: this.mergedBodies.length,
      ownedBodyGeometries: this.bodyGeometries.size,
      disposed: this.disposed };
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const { part } of this.entries) part.visible = true;
    for (const { mesh } of this.groups.values()) {
      mesh.removeFromParent();
      mesh.dispose();
    }
    for (const { mesh, sources } of this.mergedBodies) {
      mesh.removeFromParent();
      sources.forEach((part) => { part.visible = true; });
    }
    for (const geometry of this.bodyGeometries.values()) geometry.dispose();
    this.groups.clear();
    this.entries.length = 0;
    this.parts.clear();
    this.mergedBodies.length = 0;
    this.bodyGeometries.clear();
  }
}

export class WorldView {
  get playerRig() {
    return this.roots.get("player")?.vehicleRig ?? null;
  }
  constructor(world, { loadAsset = asset } = {}) {
    this.world = world;
    this.roots = new Map();
    this.barriers = new Map();
    this.signals = [];
    this.status = { loaded: 0, failed: [] };
    this.surfaces = { road: [], pavement: [] };
    this.disposed = false;
    const scene = (this.scene = new THREE.Scene());
    this.metro = world.environment === "metro";
    this.cityStreetFinish = usesCityV4StreetFinish(world);
    if (this.metro) {
      this.loadAsset = loadAsset;
      this.metroSilhouettes = new MetroSilhouettes(scene);
      this.metroModels = new MetroTrafficModels();
      this.metroParked = [];
      this.metroStalls = [];
      this.metroAssets = new Map();
      this.metroAnchors = [];
      this.metroLead = new THREE.Vector3();
      this.metroPending = [];
      this.metroTrafficKinds = new Set();
      this.metroFrame = this.metroPresented = this.metroProxyActors = 0;
      this.metroAlpha = 1;
      this.metroGroundRoads = world.roads;
      const orthoRoads = (world.roads ?? []).filter(road => road.axis !== "diag");
      this.metroDiagRoads = (world.roads ?? []).filter(road => road.axis === "diag");
      this.metroAsphalt = orthoRoads.map(road => roadRect(road));
      this.metroPavement = orthoRoads.map(road => roadRect(road, -2.5));
    }
    this.pursuitView = world.pursuit || this.metro ? createPursuitView(scene, world) : null;
    this.drillPatrolModels = world.pursuit?.packLab ? new MetroTrafficModels() : null;
    this.trafficBatches = world.environment === "egypt" ? new TrafficBatches(scene) : null;
    const grandCity = (world.config?.cityVersion ?? 0) >= 5;
    scene.background = new THREE.Color(0xd8cab8);
    scene.fog = grandCity
      ? new THREE.Fog(0xd8cab8, 120, 460)
      : new THREE.Fog(0xd8cab8, 90, 280);
    if (world.environment === "city" || world.environment === "egypt" || this.metro) {
      streetLighting ??= new RGBELoader().loadAsync(
        "/assets/lighting/urban_alley_01_1k.hdr",
      );
      streetLighting
        .then((texture) => {
          if (this.disposed) return;
          texture.mapping = THREE.EquirectangularReflectionMapping;
          scene.environment = texture;
        })
        .catch(() => this.status.failed.push("street-lighting"));
    }
    this.hemiLight = new THREE.HemisphereLight(0x9dc3e6, 0x8d6e4e, 0.78);
    scene.add(this.hemiLight);
    const sun = new THREE.DirectionalLight(0xffdfad, 2.05);
    sun.position.set(-88, 92, -58);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = sun.shadow.camera.bottom = -85;
    sun.shadow.camera.right = sun.shadow.camera.top = 85;
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 290;
    sun.shadow.bias = -0.0005;
    sun.shadow.normalBias = 0.04;
    scene.add(sun, sun.target);
    this.sun = sun;
    const rimLight = new THREE.DirectionalLight(0x7faad9, 0.38);
    rimLight.position.set(75, 55, 65);
    rimLight.castShadow = false;
    scene.add(rimLight);
    this.rimLight = rimLight;
    this._sunAnchorX = NaN;
    this._sunAnchorZ = NaN;
    this.updateSunShadowAnchor(world.player?.x ?? 0, world.player?.z ?? 0);
    this.egyptStreets = createEgyptStreetLayer(world, { streamDetails: this.metro });
    scene.add(this.egyptStreets.root);
    let groundWidth = 650, groundDepth = 650, groundX = 0, groundZ = 0;
    if (grandCity) {
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (const road of world.roads ?? []) {
        const r = isDiagonalRoad(road)
          ? (() => {
              const { length, ux, uz, mx, mz } = diagRoadInfo(road);
              const h = road.width / 2 + 2.5, halfLen = length / 2 + h;
              const extX = Math.abs(ux) * halfLen + Math.abs(uz) * h;
              const extZ = Math.abs(uz) * halfLen + Math.abs(ux) * h;
              return { minX: mx - extX, maxX: mx + extX, minZ: mz - extZ, maxZ: mz + extZ };
            })()
          : roadRect(road, -2.5);
        minX = Math.min(minX, r.minX); maxX = Math.max(maxX, r.maxX);
        minZ = Math.min(minZ, r.minZ); maxZ = Math.max(maxZ, r.maxZ);
      }
      if (Number.isFinite(minX)) {
        groundX = (minX + maxX) / 2;
        groundZ = (minZ + maxZ) / 2;
        groundWidth = Math.max(2600, maxX - minX + 800);
        groundDepth = Math.max(2600, maxZ - minZ + 800);
      } else {
        groundWidth = groundDepth = 2600;
      }
    }
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(groundWidth, groundDepth),
      material(this.cityStreetFinish ? CITY_V4_SURFACE.ground : world.environment === "lab" ? 0xaaa99d : 0xb1a18a),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.userData.owned = true;
    ground.position.set(groundX, -0.05, groundZ);
    ground.receiveShadow = true;
    scene.add(ground);
    this.buildRoads();
    if (world.environment === "city" || world.environment === "egypt" || world.pursuit || this.metro)
      this.loadSurfaces();
    if (world.environment === "city") addPlaceSigns(THREE, scene, world);
    this.buildStatics();
    if (world.environment === "egypt") {
      this.districtProps = createDistrictProps(world, { loadAsset: asset, fit, assetFor: actorAsset });
      scene.add(this.districtProps.root);
    }
    if (!world.pursuit && !this.metro) this.buildSignals();
    if (this.metro) {
      // Roads and ground have no changing transforms; only the moving roots
      // and the lights need an updated matrix tree for each camera pass.
      this.metroPlaybackBackdrop = new Set(scene.children.filter(child => child.name !== "pursuit-layer"));
      scene.updateMatrixWorld(true);
      scene.matrixAutoUpdate = false;
      for (const child of scene.children)
        if (child.isMesh || child === this.egyptStreets.root)
          child.matrixAutoUpdate = child.matrixWorldAutoUpdate = false;
      this.addActor(world.player);
    } else {
      for (const actor of world.actors) this.addActor(actor);
    }
    this.route = new THREE.Line(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({
        color: 0x63e5be,
        transparent: true,
        opacity: 0.85,
      }),
    );
    this.route.frustumCulled = false;
    this.route.userData.owned = true;
    scene.add(this.route);
    this.routeRevision = -1;
  }
  buildRoads() {
    const { roads } = this.world;
    const pavementParts = [],
      roadParts = [],
      markingParts = [];
    const mark = (width, length, x, z, heading = 0) => {
      if (this.cityStreetFinish) return wornPaint(width, length, x, z, heading);
      const g = new THREE.BoxGeometry(width, .005, length);
      if (heading) g.rotateY(heading);
      return g.translate(x, .1205, z);
    };
    // Sidewalk slabs first, then asphalt. The same expanded rectangles are
    // used in bodyOnRoad(), including the ends where roads meet.
    for (const road of roads) {
      if (road.axis === "diag") {
        const { length, heading, mx, mz } = diagRoadInfo(road);
        pavementParts.push(orientedSurfaceGeometry(
          road.width + 5.0, length + road.width + 5.0, 0.1, -0.03, mx, mz, heading, 1.8,
        ));
      } else {
        const r = roadRect(road, -2.5);
        pavementParts.push(surfaceGeometry(r, 0.1, -0.03, 1.8));
      }
    }
    this.surfaces.pavement.push(
      mergedSurface(this.scene, pavementParts, this.cityStreetFinish ? CITY_V4_SURFACE.pavement.base : 0xc1b9a5),
    );
    for (const road of roads) {
      if (road.axis === "diag") {
        const { length, ux, uz, heading, mx, mz } = diagRoadInfo(road);
        roadParts.push(orientedSurfaceGeometry(
          road.width, length + road.width, 0.06, 0.055, mx, mz, heading, 2.5,
        ));
        const crossings = this.metro ? diagAvenueCrossings(road, this.world.drivingRoads ?? roads, roads) : [];
        for (const along of crossings) {
          for (let offset = -road.width / 2 + .75; offset < road.width / 2 - .3; offset += .95) {
            const bx = road.x1 + ux * along + uz * offset;
            const bz = road.z1 + uz * along - ux * offset;
            markingParts.push(mark(.48, 2.2, bx, bz, heading));
          }
        }
        if (road.marking === "center" && !road.sideStreet && !road.parkingBay) {
          const otherRoads = roads.filter((other) => other !== road && (!other.parkingBay || other.supportApron));
          for (let n = 4; n < length - 4; n += 9) {
            const p = { x: road.x1 + ux * n, z: road.z1 + uz * n };
            if (pointOnAnyRoad(p, otherRoads, -2) || crossings.some(along => Math.abs(along - n) < 3.5))
              continue;
            markingParts.push(mark(0.12, 2.8, p.x, p.z, heading));
          }
        }
        continue;
      }
      const r = roadRect(road);
      roadParts.push(surfaceGeometry(r, 0.06, 0.055, 2.5));
      const crossings = this.metro ? avenueCrossings(road, this.world.drivingRoads) : [];
      for (const along of crossings) {
        const vertical = road.axis === "z";
        for (let offset = -road.width / 2 + .75; offset < road.width / 2 - .3; offset += .95) {
          markingParts.push(mark(vertical ? .48 : 2.2, vertical ? 2.2 : .48,
            vertical ? road.fixed + offset : along, vertical ? along : road.fixed + offset));
        }
      }
      for (let n = road.min + 4; !road.parkingBay && n < road.max; n += 9) {
        const p =
          road.axis === "z" ? { x: road.fixed, z: n } : { x: n, z: road.fixed };
        const crossing = roads.some(
          (other) => other.axis !== road.axis && pointOnAnyRoad(p, [other], -2),
        );
        if (crossing || crossings.some(along => Math.abs(along - n) < 3) ||
            road.sideStreet || road.parkingBay || road.marking === "none"
            || ((this.world.environment === "egypt" || this.metro) && road.marking !== "center")) continue;
        const width = road.axis === "z" ? 0.11 : 2.8,
          length = road.axis === "z" ? 2.8 : 0.11;
        markingParts.push(mark(width, length, p.x, p.z));
      }
    }
    this.surfaces.road.push(mergedSurface(this.scene, roadParts, this.cityStreetFinish ? CITY_V4_SURFACE.road.base : 0x484b49));
    if (markingParts.length) {
      const paint = mergedSurface(this.scene, markingParts, this.cityStreetFinish ? 0xffffff : 0xcec7ac);
      paint.name = "road-markings";
      if (this.cityStreetFinish) paint.material.vertexColors = true;
      else paint.castShadow = true;
    }
  }
  async loadSurfaces() {
    const base = "/assets/textures/roads/";
    try {
      const [road, roadNormal, pavement, pavementNormal] = await Promise.all([
        textureLoader.loadAsync(base + "asphalt_07_diff_1k.jpg"),
        textureLoader.loadAsync(base + "asphalt_07_nor_gl_1k.jpg"),
        textureLoader.loadAsync(base + "concrete_pavement_02_diff_1k.jpg"),
        textureLoader.loadAsync(base + "concrete_pavement_02_nor_gl_1k.jpg"),
      ]);
      const decorate = (meshes, colorMap, normalMap, finish) => {
        colorMap.colorSpace = THREE.SRGBColorSpace;
        for (const texture of [colorMap, normalMap]) {
          texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
          texture.anisotropy = 8;
        }
        for (const mesh of meshes) {
          mesh.material.color.setHex(finish?.mapTint ?? 0xffffff);
          mesh.material.map = colorMap;
          mesh.material.normalMap = normalMap;
          mesh.material.normalScale.setScalar(finish?.relief ?? .20);
          mesh.material.roughness = finish ? .98 : .95;
          mesh.material.needsUpdate = true;
        }
      };
      if (this.disposed) {
        for (const texture of [road, roadNormal, pavement, pavementNormal])
          texture.dispose();
        return;
      }
      const finish = this.cityStreetFinish ? CITY_V4_SURFACE : null;
      decorate(this.surfaces.road, road, roadNormal, finish?.road);
      decorate(this.surfaces.pavement, pavement, pavementNormal, finish?.pavement);
    } catch {
      this.status.failed.push("road-surfaces");
    }
  }
  buildStatics() {
    const names = [
      "building-a",
      "building-c",
      "building-h",
      "building-skyscraper-a",
    ];
    this.world.statics.forEach((site, i) => {
      const parked = this.pursuitView && site.kind === "parked-vehicle";
      if (site.kind === "place-sign" || site.kind === "barrier" || (!parked && site.kind === "parked-vehicle")
          || (site.kind === "building" && ["city", "vision", "egypt", "metro"].includes(this.world.environment))) return;
      if (this.metro && parked) {
        this.metroParked.push({ site: { ...site, kind: site.vehicleKind, phase: (i * .23) % 1 } });
        return;
      }
      const group = new THREE.Group();
      group.position.set(site.x, 0.12, site.z);
      if (this.pursuitView) {
        group.name = site.id;
        group.rotation.y = site.heading ?? 0;
      }
      this.scene.add(group);
      if (this.pursuitView && site.kind === "wall") {
        const cap = Math.min(.13, site.height / 4);
        box(group, site.width, site.height - cap, site.length, 0x9e8d77);
        box(group, site.width, cap, site.length, 0xb5a991, 0, site.height - cap, 0);
        return;
      }
      const stall = site.kind === "market-stall";
      const fallback = box(
        group,
        site.width,
        site.height,
        site.length,
        stall ? 0x916c45 : [0xac9b84, 0x998775, 0xc1b198, 0x9e9c8c][i % 4],
      );
      if (this.metro && stall) {
        this.metroStalls.push({ site, group, fallback });
        group.updateMatrixWorld(true);
        group.matrixAutoUpdate = group.matrixWorldAutoUpdate = false;
        return;
      }
      const name = stall ? "market-produce" : names[i % names.length];
      const url = parked
        ? actorAsset({ type: "vehicle", kind: site.vehicleKind, phase: 0 }, "pursuit")
        : stall
        ? "/assets/models/props/market-produce.glb"
        : `/assets/models/buildings/${name}.glb`;
      asset(url)
        .then((gltf) => {
          if (this.disposed) return;
          const visual = fit(gltf.scene, site.width, site.length, site.height, Boolean(parked));
          group.add(visual);
          fallback.visible = false;
          this.status.loaded++;
          if (!this.pursuitView && !stall && i % 5 === 0) {
            asset("/assets/models/props/roof-water-tank.glb")
              .then((tank) => {
                if (this.disposed) return;
                const roof =
                  new THREE.Box3().setFromObject(visual).max.y -
                  group.position.y;
                const roofTank = fit(tank.scene, 1.7, 1.8, 2.9);
                roofTank.position.set(1.55, roof + 0.04, -1.35);
                group.add(roofTank);
                this.status.loaded++;
              })
              .catch(() => this.status.failed.push("roof-water-tank"));
          }
        })
        .catch(() => this.status.failed.push(name));
    });
  }
  buildSignals() {
    if (this.world.environment === "egypt") return;
    for (const node of this.world.junctions) {
      if (Math.abs(node.x) % 50 !== 0 || Math.abs(node.z) % 20 !== 0) continue;
      for (const vertical of [true, false]) {
        const root = new THREE.Group();
        root.position.set(node.x + 6, 0.15, node.z + (vertical ? -6 : 6));
        this.scene.add(root);
        box(root, 0.12, 3.4, 0.12, 0x555b56);
        box(root, 0.5, 1.15, 0.45, 0x272e2b, 0, 2.8, 0);
        const lights = [];
        for (let i = 0; i < 3; i++) {
          const lamp = new THREE.Mesh(
            new THREE.SphereGeometry(0.13, 8, 6),
            new THREE.MeshBasicMaterial({ color: 0x242b25 }),
          );
          lamp.position.set(0, 3.65 - i * 0.3, -0.24);
          lamp.userData.owned = true;
          root.add(lamp);
          lights.push(lamp);
        }
        this.signals.push({ vertical, lights });
      }
    }
  }
  addActor(actor) {
    const root = new THREE.Group();
    this.scene.add(root);
    const record = { root, actor, visual: null, wheels: [] };
    this.roots.set(actor.id, record);
    this.pursuitView?.attach(record, actor);
    const person = actor.type === "pedestrian";
    const fallback = new THREE.Group();
    root.add(fallback);
    record.fallback = fallback;
    if (actor.id === "player") {
      record.vehicleRig = createPlayerVehicle(null, actor);
      record.visual = record.vehicleRig.root;
      root.add(record.visual);
      fallback.visible = false;
      this.status.loaded++;
      return;
    }
    if (this.drillPatrolModels && actor.pursuitRole === "police") {
      Object.assign(record, this.drillPatrolModels.acquire(actor));
      root.add(record.visual);
      fallback.visible = false;
      this.status.loaded++;
      return;
    }
    if (person) {
      box(fallback, 0.4, 0.6, 0.23, 0x52685b, 0, 0.83);
      box(fallback, 0.22, 0.26, 0.22, 0xb27c5c, 0, 1.43);
      for (const side of [-1, 1]) {
        box(fallback, 0.14, 0.8, 0.18, 0x444a4d, side * 0.13, 0.05);
        box(fallback, 0.11, 0.55, 0.14, 0x52685b, side * 0.29, 0.85);
      }
    } else {
      box(
        fallback,
        actor.width,
        0.6,
        actor.length,
        actor.id === "player" ? 0x688b7a : 0x747d82,
        0,
        0.3,
      );
      box(
        fallback,
        actor.width * 0.8,
        0.65,
        actor.length * 0.5,
        0x414b50,
        0,
        0.9,
      );
    }
    const url = actorAsset(actor, this.world.environment);
    asset(url)
      .then((gltf) => {
        if (this.disposed) return;
        const visual = fit(
          gltf.scene,
          person ? Infinity : actor.width,
          person ? Infinity : actor.length,
          person ? actor.body?.heightM ?? 1.78 : 2.3,
          !person && actor.kind !== "tuktuk",
        );
        if (!person)
          visual.traverse((part) => {
            if (part.isMesh && part.material.name === "paint") {
              const originalMaterial = part.material;
              part.material = part.material.clone();
              part.userData.ownedMaterial = true;
              part.material.color.setHex(
                actor.kind === "taxi"
                  ? 0xc8a04a
                  : trafficColors[
                      Math.floor(actor.phase * trafficColors.length)
                    ],
              );
              part.material.userData.trafficPaletteKey =
                `${originalMaterial.uuid}:${part.material.color.getHex()}`;
            }
          });
        root.add(visual);
        fallback.visible = false;
        record.visual = visual;
        this.status.loaded++;
        if (person) {
          record.pedestrianRig = createPedestrianRig(visual, gltf.animations, actor);
        } else {
          visual.traverse((part) => {
            if (/^wheel-(front|rear)-(left|right)$/.test(part.name))
              record.wheels.push({
                part,
                front: part.name.includes("front"),
                quaternion: part.quaternion.clone(),
                radius: Math.max(
                  0.15,
                  new THREE.Box3()
                    .setFromObject(part)
                    .getSize(new THREE.Vector3()).y / 2,
                ),
              });
          });
          this.trafficBatches?.add(record);
        }
      })
      .catch(() => this.status.failed.push(actor.kind));
  }
  metroAsset(url, name) {
    let source = this.metroAssets.get(url);
    if (!source) {
      this.metroAssets.set(url, source = {});
      Promise.resolve().then(() => !this.disposed && this.loadAsset(url)).then(gltf => {
        if (this.disposed || !gltf) return;
        source.gltf = gltf;
        this.status.loaded++;
      }).catch(() => {
        if (this.disposed) return;
        source.failed = true;
        this.status.failed.push(name);
      });
    }
    return source;
  }
  addMetroActor(actor) {
    const root = new THREE.Group();
    const record = { root, actor, visual: null, wheels: [] };
    if (actor.type === "pedestrian") {
      const { geometry } = this.metroSilhouettes.geometry("pedestrian");
      record.fallback = new THREE.Mesh(geometry, this.metroSilhouettes.material);
      record.fallback.scale.set(actor.body?.widthM ?? .51, actor.body?.heightM ?? 1.78, actor.body?.depthM ?? .32);
      record.fallback.receiveShadow = true;
      root.add(record.fallback);
    } else {
      Object.assign(record, this.metroModels.acquire(actor));
      root.add(record.visual);
      this.pursuitView?.attach(record, actor);
    }
    this.scene.add(root);
    this.roots.set(actor.id, record);
    return record;
  }
  removeMetroActor(id, record) {
    record.pedestrianRig?.dispose();
    disposeSkeletons(record.visual);
    if (record.entry) {
      // Pursuit accessories can remember a previous source until the actor
      // returns. Don't leave that detached group holding the old meshes.
      record.visual.clear();
      this.metroModels.release(record.entry);
    }
    record.root.removeFromParent().clear();
    record.pedestrianRig = record.visual = record.fallback = record.entry = null;
    record.wheels.length = 0;
    this.roots.delete(id);
  }
  metroGroundHeight(x, z) {
    if (this.metroGroundRoads !== this.world.roads) {
      this.metroGroundRoads = this.world.roads;
      const orthoRoads = this.world.roads.filter(road => road.axis !== "diag");
      this.metroDiagRoads = this.world.roads.filter(road => road.axis === "diag");
      this.metroAsphalt = orthoRoads.map(road => roadRect(road));
      this.metroPavement = orthoRoads.map(road => roadRect(road, -2.5));
    }
    for (const road of this.metroAsphalt) if (containsXZ(road, x, z)) return .115;
    if (this.metroDiagRoads.length && pointOnAnyRoad({ x, z }, this.metroDiagRoads, 0)) return .115;
    for (const road of this.metroPavement) if (containsXZ(road, x, z)) return .07;
    if (this.metroDiagRoads.length && pointOnAnyRoad({ x, z }, this.metroDiagRoads, -2.5)) return .07;
    return -.05;
  }
  updateSunShadowAnchor(anchorX, anchorZ) {
    if (!this.sun || !Number.isFinite(anchorX) || !Number.isFinite(anchorZ)) return;
    const sx = Math.round(anchorX / 2) * 2;
    const sz = Math.round(anchorZ / 2) * 2;
    if (sx === this._sunAnchorX && sz === this._sunAnchorZ) return;
    this._sunAnchorX = sx;
    this._sunAnchorZ = sz;
    this.sun.target.position.set(sx, 0, sz);
    this.sun.position.set(sx - 88, 92, sz - 58);
    this.sun.updateMatrixWorld(true);
    this.sun.target.updateMatrixWorld(true);
  }
  syncMetroPlayer(alpha) {
    const { world } = this, actor = world.player, record = this.roots.get(actor.id);
    const t = Number.isFinite(alpha) ? THREE.MathUtils.clamp(alpha, 0, 1) : 1;
    this.metroAlpha = t;
    const prev = actor.previous && Math.hypot(actor.x - actor.previous.x, actor.z - actor.previous.z) < 12
      ? actor.previous
      : actor;
    const ix = THREE.MathUtils.lerp(prev.x, actor.x, t);
    const iz = THREE.MathUtils.lerp(prev.z, actor.z, t);
    const iy = .12 + (world.pursuit?.phase === "running"
      ? THREE.MathUtils.lerp(prev.y ?? 0, actor.y ?? 0, t)
      : 0);
    const iHeading = (prev.heading ?? 0) + angleDelta(actor.heading ?? 0, prev.heading ?? 0) * t;
    record.root.position.set(ix, iy, iz);
    record.root.rotation.y = iHeading;
    this.updateSunShadowAnchor(ix, iz);
    this.pursuitView?.appearance(record.root, world);
    const terrain = actor.vehicle?.suspension?.terrainOffsetsM;
    if (terrain || record.curbWheels) {
      record.curbWheels ??= Object.entries(CURB_WHEEL_PIVOTS).map(([key, name]) => {
        const pivot = record.vehicleRig.root.getObjectByName(name);
        return { key, pivot, baseY: pivot.position.y };
      });
      for (const { key, pivot, baseY } of record.curbWheels)
        pivot.position.y = baseY + (terrain?.[key] ?? 0);
      if (!terrain) record.curbWheels = null;
    }
    record.vehicleRig.update(actor, world.sensors, t);
    const focused = this.focusedPersonId && world.actors.find(a => a.id === this.focusedPersonId && a.type === "pedestrian");
    this.metroFocus = focused ? this.roots.get(focused.id) ?? this.addMetroActor(focused) : null;
    if (focused) {
      const previous = focused.previous ?? focused;
      const x = THREE.MathUtils.lerp(previous.x, focused.x, t), z = THREE.MathUtils.lerp(previous.z, focused.z, t);
      this.metroFocus.root.position.set(x, this.metroGroundHeight(x, z), z);
    }
    return record.root;
  }
  prepareMetro(cameras) {
    const { world, metroAnchors: anchors, metroLead: lead, metroAlpha: alpha } = this;
    const player = world.player;
    const playerRoot = this.roots.get(player.id)?.root;
    const playerAnchor = playerRoot ? playerRoot.position : player;
    const playerHeading = playerRoot ? playerRoot.rotation.y : (player.heading ?? 0);
    anchors.length = 0;
    anchors.push(playerAnchor);
    if (this.metroFocus) anchors.push(this.metroFocus.root.position);
    for (const camera of cameras)
      if (camera) anchors.push(camera.position);
    // At the avenue limit this prepares roughly one second of travel, but
    // never lets the approximate lead replace the real camera safety disk.
    const advance = THREE.MathUtils.clamp((player.speed ?? 0) * .85, -13, 13);
    lead.set(playerAnchor.x + Math.sin(playerHeading) * advance, 0, playerAnchor.z + Math.cos(playerHeading) * advance);
    this.egyptStreets.updateResidency?.(anchors, lead);
    const frame = ++this.metroFrame, pending = this.metroPending;
    const pursuit = world.pursuit?.phase === "running";
    this.metroSilhouettes.begin();
    this.metroTrafficKinds.clear();
    this.metroPresented = 1; // The always-present original player rig.
    this.metroProxyActors = 0;
    pending.length = 0;
    for (const actor of world.actors) {
      if (actor === player) continue;
      const person = actor.type === "pedestrian";
      const previous = actor.previous && Math.hypot(actor.x - actor.previous.x, actor.z - actor.previous.z) < 12
        ? actor.previous
        : actor;
      const x = THREE.MathUtils.lerp(previous.x, actor.x, alpha);
      const z = THREE.MathUtils.lerp(previous.z, actor.z, alpha);
      const y = person
        ? this.metroGroundHeight(x, z)
        : .12 + (pursuit ? THREE.MathUtils.lerp(previous.y ?? 0, actor.y ?? 0, alpha) : 0);
      const heading = (previous.heading ?? 0) + angleDelta(actor.heading ?? 0, previous.heading ?? 0) * alpha;
      const pinned = person && (actor.id === this.focusedPersonId || actor.id === this.selectedPersonId);
      let record = this.roots.get(actor.id);
      const reach = (record ? METRO_RELEASE_M : METRO_NEAR_M) + (person ? .3 : actor.length * .5);
      const distance2 = distanceToAnchors2(x, z, anchors);
      if (pinned || distance2 <= reach * reach) {
        record ??= this.addMetroActor(actor);
        record.frame = frame;
        record.actor = actor;
        record.root.position.set(x, y, z);
        record.root.rotation.y = heading;
        if (!person) {
          animateWheels(record, actor);
          const yawDelta = angleDelta(actor.heading ?? 0, previous.heading ?? 0);
          const latG = THREE.MathUtils.clamp((actor.speed ?? 0) * yawDelta * 60, -9, 9);
          const accelG = THREE.MathUtils.clamp(((actor.speed ?? 0) - (previous.speed ?? actor.speed ?? 0)) * 60, -10, 10);
          const maxRoll = actor.pursuitRole === "police" ? 0.065 : 0.052;
          const targetRoll = THREE.MathUtils.clamp((latG / 9) * maxRoll, -0.065, 0.065);
          const targetPitch = THREE.MathUtils.clamp((-accelG / 10) * 0.048, -0.048, 0.048);
          const suspBlend = record.suspTick === undefined ? 0.35 : record.suspTick === world.tick ? 0.14 : 0.26;
          record.suspTick = world.tick;
          record.rollRad = THREE.MathUtils.lerp(record.rollRad ?? 0, targetRoll, suspBlend);
          record.pitchRad = THREE.MathUtils.lerp(record.pitchRad ?? 0, targetPitch, suspBlend);
          if (Math.abs(record.rollRad) < 1e-5) record.rollRad = 0;
          if (Math.abs(record.pitchRad) < 1e-5) record.pitchRad = 0;
          if (record.visual) {
            record.visual.rotation.z = record.rollRad;
            record.visual.rotation.x = record.pitchRad;
          }
        } else if (!record.pedestrianRig) {
          const source = this.metroAsset(actorAsset(actor), actor.kind);
          if (source.gltf && !source.failed)
            pending.push({ record, source, priority: pinned ? -1 : distance2 });
        } else if (record.poseTick !== world.tick || record.poseAlpha !== alpha) {
          record.pedestrianRig.update(actor, alpha);
          record.poseTick = world.tick;
          record.poseAlpha = alpha;
        }
        if (person && (actor.impact || record.root.userData.pedestrianImpactPose))
          applyPedestrianImpact(record.root, actor, world.tick, alpha);
      } else {
        this.metroSilhouettes.put(actor, x, y, z, heading);
        this.metroProxyActors++;
      }
      if (!person && actor.pursuitRole !== "police") this.metroTrafficKinds.add(proxyKind(actor));
      this.metroPresented++;
    }
    // One new skin/animation mixer per frame; a People selection jumps the
    // queue. The fitted silhouette stays present until the rig is ready.
    pending.sort((a, b) => a.priority - b.priority);
    if (pending.length) this.finishMetroPerson(pending[0], alpha);
    pending.length = 0;
    for (const [id, record] of this.roots)
      if (id !== player.id && record.frame !== frame) this.removeMetroActor(id, record);
    this.prepareMetroProps(anchors);
    this.metroSilhouettes.end();
    this.pursuitView?.update(world, alpha);
    this.scene.matrixWorldAutoUpdate = false;
    this.scene.updateMatrixWorld();
  }
  finishMetroPerson({ record, source }, alpha) {
    const { actor } = record;
    let visual, rig;
    try {
      visual = fit(source.gltf.scene, Infinity, Infinity, actor.body?.heightM ?? 1.78);
      record.root.add(visual);
      rig = createPedestrianRig(visual, source.gltf.animations, actor);
      rig.update(actor, alpha);
      record.pedestrianRig = rig;
      record.visual = visual;
      record.poseTick = this.world.tick;
      record.poseAlpha = alpha;
      record.fallback.removeFromParent();
    } catch {
      rig?.dispose();
      visual?.removeFromParent();
      disposeSkeletons(visual);
      source.failed = true;
      this.status.failed.push(actor.kind);
    }
  }
  prepareMetroProps(anchors) {
    for (const prop of this.metroParked) {
      const { site } = prop;
      const reach = (prop.root ? METRO_RELEASE_M : METRO_NEAR_M) + site.length / 2;
      if (distanceToAnchors2(site.x, site.z, anchors) <= reach * reach) {
        if (prop.root) continue;
        const { visual: root, entry } = this.metroModels.acquire(site);
        prop.root = root;
        prop.entry = entry;
        root.position.set(site.x, .12, site.z);
        root.rotation.y = site.heading ?? 0;
        this.scene.add(root);
        root.updateMatrixWorld(true);
        root.matrixAutoUpdate = root.matrixWorldAutoUpdate = false;
      } else {
        if (prop.root) {
          prop.root.removeFromParent();
          this.metroModels.release(prop.entry);
          prop.root = prop.entry = null;
        }
        this.metroSilhouettes.put(site, site.x, .12, site.z, site.heading ?? 0);
      }
    }
    for (const prop of this.metroStalls) {
      const { site, group, fallback } = prop;
      const reach = (prop.visual ? METRO_RELEASE_M : METRO_NEAR_M) + site.length / 2;
      if (distanceToAnchors2(site.x, site.z, anchors) <= reach * reach) {
        const { gltf } = this.metroAsset("/assets/models/props/market-produce.glb", "market-produce");
        if (!prop.visual && gltf) {
          prop.visual = fit(gltf.scene, site.width, site.length, site.height);
          group.add(prop.visual);
          prop.visual.updateMatrixWorld(true);
          fallback.visible = false;
        }
      } else if (prop.visual) {
        prop.visual.removeFromParent();
        disposeSkeletons(prop.visual);
        prop.visual = null;
        fallback.visible = true;
      }
    }
  }
  actorDiagnostics() {
    const totalActors = this.world.actors.length;
    const availableActors = this.disposed ? 0 : this.metro ? this.metroPresented : this.roots.size;
    const trafficModels = this.metro ? [...this.metroTrafficKinds].sort() : [];
    const detailedTrafficModels = new Set();
    let detailedActors = 0, pendingPeople = 0;
    for (const { actor, visual, wheels, pedestrianRig } of this.roots.values()) {
      if (visual) detailedActors++;
      if (actor.type === "pedestrian" && !pedestrianRig) pendingPeople++;
      if (wheels.length && actor !== this.world.player && actor.pursuitRole !== "police")
        detailedTrafficModels.add(actor.kind);
    }
    return {
      ready: Boolean(this.playerRig?.diagnostics.ready) && availableActors === totalActors,
      totalActors, availableActors, detailedActors, pendingPeople,
      proxyActors: this.metro && !this.disposed ? this.metroProxyActors + pendingPeople : 0,
      sharedTrafficTemplates: this.metroModels?.entries.size ?? 0,
      trafficModels: this.metro ? trafficModels : [...detailedTrafficModels].sort(),
      detailedTrafficModels: [...detailedTrafficModels].sort(),
      focusedPersonReady: Boolean(this.focusedPersonId && this.roots.get(this.focusedPersonId)?.pedestrianRig),
    };
  }
  pedestrianGroundHeight(position) {
    if (this.world.environment === "vision") return 0.12;
    if (pointOnAnyRoad(position, this.world.roads, 0)) return 0.115;
    return pointOnAnyRoad(position, this.world.roads, -2.5) ? 0.07 : -0.05;
  }
  sync(alpha) {
    const world = this.world;
    if (this.metro) {
      const player = this.syncMetroPlayer(alpha);
      this.syncRoute();
      this.aimSun(player);
      return player;
    }
    for (const barrier of world.statics.filter((a) => !this.pursuitView && a.kind === "barrier")) {
      if (this.barriers.has(barrier.id)) continue;
      const root = new THREE.Group();
      root.position.set(barrier.x, 0.12, barrier.z);
      root.rotation.y = barrier.heading;
      box(root, barrier.width, 0.2, barrier.length, 0xb87b3f, 0, 0.55);
      for (const side of [-1, 1])
        box(root, 0.15, 0.8, 0.55, 0x8c8e7e, side * 0.9, 0);
      this.barriers.set(barrier.id, root);
      this.scene.add(root);
    }
    for (const [id, root] of this.barriers)
      if (!world.statics.some((a) => a.id === id)) {
        this.scene.remove(root);
        root.traverse((m) => {
          if (m.isMesh) {
            m.geometry.dispose();
            m.material.dispose();
          }
        });
        this.barriers.delete(id);
      }
    const t = Number.isFinite(alpha) ? THREE.MathUtils.clamp(alpha, 0, 1) : 1;
    for (const actor of world.actors) {
      if (!this.roots.has(actor.id)) this.addActor(actor);
      const record = this.roots.get(actor.id);
      const prev = actor.previous && Math.hypot(actor.x - actor.previous.x, actor.z - actor.previous.z) < 12
        ? actor.previous
        : actor;
      const p = interpolate(prev, actor, t);
      record.root.position.set(p.x, actor.type === "pedestrian" ? this.pedestrianGroundHeight(p) : 0.12, p.z);
      record.root.rotation.y = p.heading;
      const distanceFromPlayer = Math.hypot(
          p.x - world.player.x,
          p.z - world.player.z,
        ),
        detailed =
          actor === world.player || actor.id === this.focusedPersonId ||
          distanceFromPlayer < (actor.type === "pedestrian" ? 42 : 68);
      record.root.visible = actor === world.player || actor.id === this.focusedPersonId || distanceFromPlayer < 135;
      if (record.visual) {
        record.visual.visible = detailed;
        record.fallback.visible = !detailed;
      }
      record.vehicleRig?.update(actor, world.sensors, t);
      if (detailed) animateWheels(record, actor);
      if (record.pedestrianRig && detailed) record.pedestrianRig.update(actor, t);
      if (actor.type === "pedestrian" && (actor.impact || record.root.userData.pedestrianImpactPose))
        applyPedestrianImpact(record.root, actor, world.tick, t);
    }
    this.syncRoute();
    const phase = (world.tick / 60) % 24;
    for (const signal of this.signals) {
      const green = signal.vertical ? phase < 10 : phase >= 12 && phase < 22;
      const yellow = signal.vertical ? phase >= 10 && phase < 12 : phase >= 22;
      signal.lights.forEach((lamp, i) =>
        lamp.material.color.setHex(
          i === 0 && !green && !yellow
            ? 0xe16353
            : i === 1 && yellow
              ? 0xf3c46b
              : i === 2 && green
                ? 0x70c697
                : 0x242b25,
        ),
      );
    }
    const player = this.roots.get("player").root;
    this.aimSun(player);
    this.pursuitView?.update(world, t);
    return player;
  }
  syncRoute() {
    const world = this.world;
    if (this.routeRevision === world.routeRevision) return;
    this.routeRevision = world.routeRevision;
    this.route.geometry.dispose();
    this.route.geometry = new THREE.BufferGeometry().setFromPoints(
      world.player.path.map((p) => new THREE.Vector3(p.x, 0.14, p.z)),
    );
  }
  aimSun(player) {
    this.updateSunShadowAnchor(player.position.x, player.position.z);
  }
  prepareFrame({ cameras = [] } = {}) {
    if (this.metro) return this.prepareMetro(cameras);
    if (this.world.environment === "egypt") this.scene.matrixWorldAutoUpdate = false;
    this.scene.updateMatrixWorld();
    this.trafficBatches?.update();
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.trafficBatches?.dispose();
    this.districtProps?.dispose();
    this.pursuitView?.dispose();
    this.drillPatrolModels?.dispose();
    this.scene.remove(this.egyptStreets.root);
    this.egyptStreets.dispose();
    if (this.metro) {
      this.sun.shadow.dispose();
      for (const [id, record] of this.roots)
        if (id !== this.world.player.id) this.removeMetroActor(id, record);
      for (const prop of this.metroStalls) disposeSkeletons(prop.visual);
      this.metroModels.dispose();
      this.metroSilhouettes.dispose();
      this.metroAssets.clear();
      this.metroParked.length = this.metroStalls.length = this.metroPending.length = this.metroAnchors.length = 0;
      this.metroTrafficKinds.clear();
      this.metroFocus = null;
    }
    for (const record of this.roots.values()) {
      record.pedestrianRig?.dispose();
      if (record.vehicleRig) {
        record.root.remove(record.vehicleRig.root);
        record.vehicleRig.dispose();
      }
    }
    const skeletons = new Set();
    const textures = new Set();
    this.scene.traverse((part) => {
      if (part.isSkinnedMesh) skeletons.add(part.skeleton);
      if (part.userData.ownedMaterial) part.material.dispose();
      if (!part.userData.owned) return;
      part.geometry?.dispose();
      for (const mat of Array.isArray(part.material)
        ? part.material
        : [part.material]) {
        for (const texture of [mat?.map, mat?.normalMap])
          if (texture && !textures.has(texture)) {
            textures.add(texture);
            texture.dispose();
          }
        mat?.dispose();
      }
    });
    for (const skeleton of skeletons) skeleton.dispose();
    this.scene.clear();
    this.roots.clear();
  }
}
