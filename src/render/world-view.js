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
import { createCityPropsView } from "./city-props-view.js";
import { CITY_PROP_PROFILE } from "../core/city-props.js";
import { createPedestrianBody } from "../core/pedestrian-body.js";
import { createPedestrianRig } from "./pedestrian-rig.js";
import { createDistrictProps } from "./district-props.js";
import { createPursuitView } from "./pursuit-view.js";
import { createCrashEffects } from "./crash-effects.js";
import { createCinematicRoadTextures, createStreetSurfacesView } from "./street-surfaces-view.js";
import { createMetroMaterialDetail } from "./metro-material-detail.js";
import { buildTerrainRoadParts } from "./elevated-roads.js";
import { terrainGradientAt } from "../core/city-surfaces.js";
import { getActorImpactReaction } from "../core/wheel-interaction-physics.js";
import { applyPedestrianImpact } from "./pedestrian-impact.js";
import { getPatrolVisualDamage } from "../core/pursuit-world.js";
import { applyTrafficCrashDamage, createUnifiedTrafficModel, disposeUnifiedTrafficModel } from "./unified-traffic-model.js";

const templates = new Map(),
  loader = new GLTFLoader();
const textureLoader = new THREE.TextureLoader();
const CITY_V4_SURFACE = {
  // The baked asphalt is ochre-biased. Correct its albedo, not the sun or the plaster.
  road: { base: 0x43484a, mapTint: 0xadc9ef, relief: .32 },
  pavement: { base: 0xa2a39b, mapTint: 0xcad1da, relief: .38 },
  ground: 0x7d7a70,
};
let streetLighting;
const trafficColors = [
  0x88969a, 0xa84a39, 0xb0b5ac, 0x455b76, 0x8f7458, 0x62766a,
];
const METRO_NEAR_M = 42, METRO_RELEASE_M = 51;
const METRO_PERSON_NEAR_M = 22, METRO_PERSON_RELEASE_M = 28;
export const PEDESTRIAN_ANIM_LOD_M = 75;
export const PEDESTRIAN_CULL_LOD_M = 135;
const PEDESTRIAN_ANIM_LOD_SQ = PEDESTRIAN_ANIM_LOD_M * PEDESTRIAN_ANIM_LOD_M;
const PEDESTRIAN_CULL_LOD_SQ = PEDESTRIAN_CULL_LOD_M * PEDESTRIAN_CULL_LOD_M;
const SUN_OFFSET = new THREE.Vector3(-88, 92, -58);
const SUN_RIGHT = new THREE.Vector3(58, 0, -88).normalize();
const SUN_UP = new THREE.Vector3().crossVectors(SUN_OFFSET.clone().normalize(), SUN_RIGHT).normalize();
const SUN_OFFSET_V5 = new THREE.Vector3(-114, 58, -70);
const SUN_RIGHT_V5 = new THREE.Vector3(70, 0, -114).normalize();
const SUN_UP_V5 = new THREE.Vector3().crossVectors(SUN_OFFSET_V5.clone().normalize(), SUN_RIGHT_V5).normalize();

function createCairoTwilightSkyDome(sunOffset) {
  const geo = new THREE.SphereGeometry(860, 28, 16);
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const sunDir = sunOffset.clone().normalize();
  const cNadir = new THREE.Color(0x2d3640);
  const cHorizon = new THREE.Color(0x8a8278);
  const cSunGlow = new THREE.Color(0xc89e74);
  const cMid = new THREE.Color(0x5e7388);
  const cZenith = new THREE.Color(0x41566e);
  const tmp = new THREE.Color();
  const dir = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    dir.set(pos.getX(i), pos.getY(i), pos.getZ(i)).normalize();
    const y = dir.y;
    if (y < 0) {
      tmp.copy(cHorizon).lerp(cNadir, Math.min(1, -y * 3.5));
    } else if (y < 0.24) {
      tmp.copy(cHorizon).lerp(cMid, THREE.MathUtils.smoothstep(y, 0, 0.24));
    } else {
      tmp.copy(cMid).lerp(cZenith, THREE.MathUtils.smoothstep(y, 0.24, 0.92));
    }
    const sunAlign = Math.max(0, dir.x * sunDir.x + dir.z * sunDir.z);
    const horizonBand = Math.exp(-(((y - 0.08) / 0.19) ** 2));
    const glow = Math.pow(sunAlign, 3.2) * horizonBand * 0.52;
    if (glow > 1e-4) tmp.lerp(cSunGlow, glow);
    colors[i * 3] = tmp.r;
    colors[i * 3 + 1] = tmp.g;
    colors[i * 3 + 2] = tmp.b;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  const mat = new THREE.MeshBasicMaterial({
    name: "cairo-twilight-sky-dome-mat",
    vertexColors: true,
    side: THREE.BackSide,
    fog: false,
    depthWrite: false,
  });
  const dome = new THREE.Mesh(geo, mat);
  dome.name = "cairo-twilight-sky-dome";
  dome.renderOrder = -10;
  dome.frustumCulled = false;
  dome.userData.owned = true;
  return dome;
}

function detailNoise(x, z) {
  let value = Math.imul(x ^ Math.imul(z, 9277), 1973);
  value = Math.imul(value ^ (value >>> 16), 2246822519);
  return ((value ^ (value >>> 13)) >>> 0) / 4294967295;
}

function surfaceRoughness(smooth, coarse) {
  const size = 128, data = new Uint8Array(size * size * 4);
  const noise = (x, z) => detailNoise(x & 7, z & 7);
  for (let z = 0; z < size; z++) for (let x = 0; x < size; x++) {
    const grain = detailNoise(x, z);
    const u = x / 16, v = z / 16, ix = Math.floor(u), iz = Math.floor(v);
    const fx = u - ix, fz = v - iz;
    const sx = fx * fx * (3 - 2 * fx), sz = fz * fz * (3 - 2 * fz);
    const patches = THREE.MathUtils.lerp(
      THREE.MathUtils.lerp(noise(ix, iz), noise(ix + 1, iz), sx),
      THREE.MathUtils.lerp(noise(ix, iz + 1), noise(ix + 1, iz + 1), sx), sz);
    const value = Math.round(255 * THREE.MathUtils.lerp(smooth, coarse, .75 * patches + .25 * grain));
    const offset = (z * size + x) * 4;
    data[offset] = data[offset + 1] = data[offset + 2] = value;
    data[offset + 3] = 255;
  }
  const texture = new THREE.DataTexture(data, size, size);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

function facadeRelief() {
  const size = 512, tileSize = size / 4, data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const tile = Math.floor(y / tileSize) * 4 + Math.floor(x / tileSize);
    const u = x % tileSize, v = y % tileSize;
    const grain = detailNoise(u, v);
    let height = .5, roughness = .94;
    if ([0, 1, 2, 14, 15].includes(tile)) {
      height += (grain - .5) * .16;
      roughness = .86 + .14 * grain;
    } else if (tile === 3 || tile === 5) {
      const row = Math.floor(v / 7.5);
      const joint = v % 7.5 < .8 || (u + (row % 2) * 4.25) % 8.5 < .7;
      height = joint ? .28 : .68 + .08 * grain;
    } else if (tile === 4 || tile === 7) {
      height = (tile === 4 ? u % 8.75 : v % 4.5) < 1 ? .32 : .64;
      roughness = .7;
    } else if (tile === 6) {
      roughness = .32;
    }
    const offset = (y * size + x) * 4;
    data[offset] = Math.round(height * 255);
    data[offset + 1] = Math.round(roughness * 255);
    data[offset + 2] = 0;
    data[offset + 3] = 255;
  }
  const texture = new THREE.DataTexture(data, size, size);
  texture.name = "city-masonry-relief-and-roughness";
  texture.flipY = true;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  return texture;
}
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
  truck: [3.35, .96, .74, -.12, .44],
};
const proxyKind = (actor) => actor.type === "pedestrian" ? "pedestrian"
  : Object.hasOwn(METRO_TRAFFIC, actor.kind) ? actor.kind : "sedan";
const metroPalette = (kind) => kind === "taxi" ? [0xddd0ac, 0xd5c49e, 0xe4dbba]
  : kind === "tuktuk" ? [0xbb9142, 0x547868, 0x974d38]
    : kind === "truck" ? [0xe0ddd0, 0x4c6882, 0xb88649, 0x5d6e62, 0x9c4d3c]
      : [0x788f98, 0x9b5140, 0xb9b5a2, 0x48677f, 0x8c7358, 0x66796b];
const metroPalettes = Object.fromEntries(Object.keys(METRO_TRAFFIC).map(kind => [kind, metroPalette(kind)]));
const paintIndex = (actor, colors) =>
  Math.min(colors.length - 1, Math.max(0, Math.floor((Number.isFinite(actor.phase) ? actor.phase : 0) * colors.length)));

export function actorProxyGeometry(kind) {
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
  } else if (kind === "truck") {
    cube(1, .62, .72, 0, .69, -.14, 0xffffff);
    cube(.94, .65, .27, 0, .435, .355, 0xffffff, .96);
    cube(.82, .16, .015, 0, .625, .4925, 0x52666a);
    cube(.92, .07, .82, 0, .125, -.05, 0x2d3231);
    cube(.98, .065, .045, 0, .18, -.46, 0x68706c);
    for (const side of [-1, 1]) cube(.018, .09, .70, side * .488, .655, -.14, 0xc49b58);
    for (const axle of [-.30, .34])
      for (const side of [-1, 1])
        add(new THREE.CylinderGeometry(1, 1, 1, 8).rotateZ(Math.PI / 2)
          .scale(.145, .145, axle < 0 ? .095 : .072).translate(side * .405, .145, axle), 0x303432);
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

function isStreetChaosWreck(world, actor) {
  if (!world?.streetChaos?.active || !actor) return false;
  const ids = world.streetChaos.accidentActorIds;
  return Boolean(actor.chaosAccident || ids?.has?.(actor.id) || ids?.includes?.(actor.id));
}

function streetChaosAccidentRole(world, actor) {
  const roles = world?.streetChaos?.accidentRoles;
  return roles?.get?.(actor?.id) ?? roles?.[actor?.id] ?? null;
}

export function streetChaosAccidentDamage(world, actor, recordedDamage = null) {
  if (!isStreetChaosWreck(world, actor)) return recordedDamage;
  const role = streetChaosAccidentRole(world, actor);
  const damage = { ...(recordedDamage ?? {}), wrecked: true };
  if (role?.role === "lead") {
    damage.front = Math.min(damage.front ?? 0, .28);
    damage.rear = Math.max(damage.rear ?? 0, .78);
  } else {
    damage.front = Math.max(damage.front ?? 0, role?.role === "follower" ? .85 : .82);
  }
  const corner = role?.skewSign < 0 ? "left" : role?.skewSign > 0 ? "right" : null;
  if (corner) damage[corner] = Math.max(damage[corner] ?? 0, .62);
  return damage;
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
  // BoxGeometry's +Y face is vertices 8â€“11. World-space UVs make overlapping
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
const templateFitBounds = new WeakMap();
function fit(template, width, length, height = Infinity, matchHull = false) {
  let base = templateFitBounds.get(template);
  if (!base) {
    const probe = clone(template);
    probe.updateMatrixWorld(true);
    probe.traverse((part) => {
      if (part.isSkinnedMesh) {
        part.skeleton.update();
        part.computeBoundingBox();
      }
    });
    const bounds = new THREE.Box3().setFromObject(probe);
    const size = bounds.getSize(new THREE.Vector3());
    const center = bounds.getCenter(new THREE.Vector3());
    base = {
      sizeX: size.x,
      sizeY: size.y,
      sizeZ: size.z,
      centerX: center.x,
      centerZ: center.z,
      minY: bounds.min.y,
    };
    templateFitBounds.set(template, base);
    disposeSkeletons(probe);
  }
  const visual = clone(template);
  visual.userData.fitBase = base;
  const scale = Math.min(width / base.sizeX, length / base.sizeZ, height / base.sizeY);
  const scaleZ = matchHull ? length / base.sizeZ : scale;
  visual.scale.set(scale, scale, scaleZ);
  visual.position.set(-base.centerX * scale, -base.minY * scale, -base.centerZ * scaleZ);
  visual.updateMatrixWorld(true);
  visual.traverse((part) => {
    if (part.isMesh) {
      part.castShadow = !part.isSkinnedMesh;
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
    this.facadeRelief = this.cityStreetFinish ? facadeRelief() : null;
    this.reliefMaterials = new WeakSet();
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
      this.metroFrame = this.metroPresented = this.metroProxyActors = this.metroCulledPedestrians = 0;
      this.metroAlpha = 1;
      this.metroGroundRoads = world.roads;
      const orthoRoads = (world.roads ?? []).filter(road => road.axis !== "diag");
      this.metroDiagRoads = (world.roads ?? []).filter(road => road.axis === "diag");
      this.metroAsphalt = orthoRoads.map(road => roadRect(road));
      this.metroPavement = orthoRoads.map(road => roadRect(road, -2.5));
    }
    this.pursuitView = world.pursuit || this.metro ? createPursuitView(scene, world) : null;
    this.crashEffects = world.player ? createCrashEffects(scene) : null;
    this.streetSurfaces = null;
    this._gradScratch = { elevationM: 0, dhdx: 0, dhdz: 0 };
    this._lastCrashSimTime = null;
    this.drillPatrolModels = world.pursuit?.packLab ? new MetroTrafficModels() : null;
    this.trafficBatches = world.environment === "egypt" ? new TrafficBatches(scene) : null;
    const grandCity = (world.config?.cityVersion ?? 0) >= 5;
    this.grandCity = grandCity;
    this.metroMaterialDetail = this.metro && grandCity ? createMetroMaterialDetail() : null;
    this.sunOffset = grandCity ? SUN_OFFSET_V5 : SUN_OFFSET;
    this.sunRight = grandCity ? SUN_RIGHT_V5 : SUN_RIGHT;
    this.sunUp = grandCity ? SUN_UP_V5 : SUN_UP;
    this.cinematicRoadTextures = grandCity ? createCinematicRoadTextures() : null;
    this.skyDome = null;
    scene.background = new THREE.Color(grandCity ? 0x465668 : 0xd8cab8);
    scene.fog = grandCity
      ? new THREE.Fog(0x565f6a, 120, 460)
      : new THREE.Fog(0xd8cab8, 150, 420);
    if (grandCity) {
      this.skyDome = createCairoTwilightSkyDome(this.sunOffset);
      scene.add(this.skyDome);
    }
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
    this.hemiLight = grandCity
      ? new THREE.HemisphereLight(0x8ba3be, 0x564d42, 0.72)
      : new THREE.HemisphereLight(0x9dc3e6, 0x8d6e4e, 0.88);
    scene.add(this.hemiLight);
    const sun = new THREE.DirectionalLight(grandCity ? 0xffc68c : 0xffdfad, grandCity ? 3.10 : 2.55);
    sun.position.copy(this.sunOffset);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = sun.shadow.camera.bottom = -85;
    sun.shadow.camera.right = sun.shadow.camera.top = 85;
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = grandCity ? 310 : 290;
    sun.shadow.bias = -0.0005;
    sun.shadow.normalBias = 0.04;
    scene.add(sun, sun.target);
    this.sun = sun;
    const rimLight = new THREE.DirectionalLight(grandCity ? 0x6c8eb2 : 0x7faad9, grandCity ? 1.28 : 0.72);
    rimLight.position.set(grandCity ? 72 : 75, grandCity ? 54 : 55, grandCity ? -86 : 65);
    rimLight.castShadow = false;
    scene.add(rimLight);
    this.rimLight = rimLight;
    const streetFillLight = new THREE.DirectionalLight(0xffe2b8, grandCity ? 0.96 : 0.64);
    streetFillLight.name = "street-corridor-fill-light";
    streetFillLight.position.set(84, 68, 96);
    streetFillLight.castShadow = false;
    scene.add(streetFillLight, streetFillLight.target);
    this.streetFillLight = streetFillLight;
    const playerStreetLight = new THREE.PointLight(0xfff3dc, 3.8, 30, 1.25);
    playerStreetLight.name = "player-street-key-light";
    playerStreetLight.castShadow = false;
    scene.add(playerStreetLight);
    this.playerStreetLight = playerStreetLight;
    const playerSculptLight = new THREE.PointLight(0xeef6ff, 1.85, 16, 1.5);
    playerSculptLight.name = "player-sculpt-fill-light";
    playerSculptLight.castShadow = false;
    scene.add(playerSculptLight);
    this.playerSculptLight = playerSculptLight;
    this._sunAnchorX = NaN;
    this._sunAnchorZ = NaN;
    this.sunAnchor = new THREE.Vector3();
    const initPx = world.player?.x ?? 0;
    const initPz = world.player?.z ?? 0;
    const initElev = world.terrainElevationAt ? world.terrainElevationAt(initPx, initPz) : 0;
    this.updateSunShadowAnchor(initPx, initPz);
    this.updatePlayerLighting(initPx, 0.12 + initElev + (world.player?.y ?? 0), initPz, world.player?.heading ?? 0);
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
      material(grandCity ? 0x36342e : this.cityStreetFinish ? CITY_V4_SURFACE.ground : world.environment === "lab" ? 0xaaa99d : 0xb1a18a),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.userData.owned = true;
    ground.position.set(groundX, -0.05, groundZ);
    ground.receiveShadow = true;
    scene.add(ground);
    this.buildRoads();
    if (this.cinematicRoadTextures) this.applyCinematicRoadSurfaces();
    this.streetSurfaces = this.metro && world.terrain ? createStreetSurfacesView(scene, world) : null;
    this.cityProps = world.config?.cityPropProfile === CITY_PROP_PROFILE ? createCityPropsView(scene, world) : null;
    if (this.cityProps) {
      for (const name of ["street-trees-trunks-instanced", "street-trees-canopies-instanced"]) {
        const mesh = scene.getObjectByName(name);
        if (mesh) mesh.removeFromParent();
      }
    }
    if (!grandCity && (world.environment === "city" || world.environment === "egypt" || world.pursuit || this.metro))
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
      this.metroPlaybackBackdrop = new Set(scene.children.filter(child =>
        child.name !== "pursuit-layer" && child.name !== "crash-effects-layer"));
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
    if (typeof this.world.terrainElevationAt === "function") {
      const { pavementParts, roadParts, markingParts, retainingParts } = buildTerrainRoadParts(
        roads,
        this.world.drivingRoads ?? roads,
        this.world.terrainElevationAt,
        { metro: this.metro, environment: this.world.environment, cityStreetFinish: this.cityStreetFinish },
      );
      if (retainingParts.length) {
        const retaining = mergedSurface(this.scene, retainingParts, 0x9c988c);
        retaining.name = "road-retaining-walls";
        this.surfaces.pavement.push(retaining);
      }
      if (pavementParts.length) {
        this.surfaces.pavement.push(
          mergedSurface(this.scene, pavementParts, this.cityStreetFinish ? CITY_V4_SURFACE.pavement.base : 0xc1b9a5),
        );
      }
      if (roadParts.length) {
        this.surfaces.road.push(
          mergedSurface(this.scene, roadParts, this.cityStreetFinish ? CITY_V4_SURFACE.road.base : 0x484b49),
        );
      }
      if (markingParts.length) {
        const paint = mergedSurface(this.scene, markingParts, this.grandCity ? 0xb4ac9b : this.cityStreetFinish ? 0xffffff : 0xcec7ac);
        paint.name = "road-markings";
        if (this.cityStreetFinish) paint.material.vertexColors = true;
        else paint.castShadow = true;
      }
      return;
    }
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
      const paint = mergedSurface(this.scene, markingParts, this.grandCity ? 0xb4ac9b : this.cityStreetFinish ? 0xffffff : 0xcec7ac);
      paint.name = "road-markings";
      if (this.cityStreetFinish) paint.material.vertexColors = true;
      else paint.castShadow = true;
    }
  }
  applyCinematicRoadSurfaces() {
    const tex = this.cinematicRoadTextures;
    if (!tex) return;
    for (const mesh of this.surfaces.road) {
      mesh.material.color.setHex(0xffffff);
      mesh.material.map = tex.road.map;
      mesh.material.bumpMap = tex.road.bumpMap;
      mesh.material.bumpScale = 0.038;
      mesh.material.roughnessMap = tex.road.roughnessMap;
      mesh.material.roughness = 0.92;
      mesh.material.metalness = 0.04;
      mesh.material.envMapIntensity = 0.56;
      if (this.metroMaterialDetail) this.metroMaterialDetail.apply(mesh.material);
      else mesh.material.needsUpdate = true;
    }
    for (const mesh of this.surfaces.pavement) {
      const isRetaining = mesh.name === "road-retaining-walls";
      mesh.material.color.setHex(isRetaining ? 0x666259 : 0xffffff);
      mesh.material.map = isRetaining ? null : tex.pavement.map;
      mesh.material.bumpMap = tex.pavement.bumpMap;
      mesh.material.bumpScale = isRetaining ? 0.032 : 0.048;
      mesh.material.roughnessMap = tex.pavement.roughnessMap;
      mesh.material.roughness = 0.94;
      mesh.material.metalness = 0.02;
      mesh.material.envMapIntensity = 0.48;
      if (this.metroMaterialDetail) this.metroMaterialDetail.apply(mesh.material, isRetaining);
      else mesh.material.needsUpdate = true;
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
        const roughnessMap = finish
          ? surfaceRoughness(finish === CITY_V4_SURFACE.road ? .88 : .92, 1)
          : null;
        colorMap.colorSpace = THREE.SRGBColorSpace;
        for (const texture of [colorMap, normalMap]) {
          texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
          texture.anisotropy = 8;
        }
        for (const mesh of meshes) {
          mesh.material.color.setHex(finish?.mapTint ?? 0xffffff);
          mesh.material.map = colorMap;
          mesh.material.normalMap = normalMap;
          mesh.material.roughnessMap = roughnessMap;
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
      if (this.cityProps && site.propImpact) return;
      const parked = this.pursuitView && site.kind === "parked-vehicle";
      if (site.kind === "place-sign" || site.kind === "barrier" || (!parked && site.kind === "parked-vehicle")
          || (site.kind === "building" && ["city", "vision", "egypt", "metro"].includes(this.world.environment))) return;
      if (this.metro && parked) {
        this.metroParked.push({ origSite: site, site: { ...site, kind: site.vehicleKind, phase: (i * .23) % 1 } });
        return;
      }
      const group = new THREE.Group();
      const siteElev = this.world.terrainElevationAt ? this.world.terrainElevationAt(site.x, site.z) : 0;
      group.position.set(site.x, 0.12 + siteElev, site.z);
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
      this.syncPlayerRig(record, actor);
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
        source.name = name;
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
  streetChaosFxLayer() {
    if (!this.crashEffects) return null;
    if (!this.crashEffects.layer) {
      const layer = new THREE.Group();
      layer.name = "street-chaos-crash-effects";
      this.scene?.add(layer);
      this.crashEffects.layer = layer;
      this.ownsStreetChaosFxLayer = true;
    }
    return this.crashEffects.layer;
  }
  ensureStreetChaosHazards(record, actor) {
    const fxLayer = this.streetChaosFxLayer();
    if (!record.hazardFlasher) {
      this.chaosHazardGeometry ??= new THREE.SphereGeometry(.14, 8, 5);
      this.chaosHazardHaloGeometry ??= new THREE.SphereGeometry(.19, 9, 6);
      this.chaosHazardMaterial ??= new THREE.MeshStandardMaterial({
        color: 0xffb12d, emissive: 0xff7a0c, emissiveIntensity: 4.6,
        roughness: .32, metalness: 0,
      });
      const group = new THREE.Group();
      group.name = "street-chaos-hazard-flashers";
      const halfW = (actor.width ?? 1.9) / 2 + .06;
      const halfL = (actor.length ?? 4.4) / 2 + .05;
      const y = (actor.height ?? 1.5) * .55;
      for (const x of [-halfW, halfW]) for (const z of [-halfL, halfL]) {
        const lamp = new THREE.Mesh(this.chaosHazardGeometry, this.chaosHazardMaterial);
        lamp.name = "street-chaos-corner-flasher";
        lamp.position.set(x, y, z);
        group.add(lamp);
      }
      const halo = new THREE.Mesh(this.chaosHazardHaloGeometry, this.chaosHazardMaterial);
      halo.name = "street-chaos-hazard-halo";
      halo.position.set(0, (actor.height ?? 1.5) * .72, (actor.length ?? 4.4) * .24);
      group.add(halo);
      (fxLayer ?? record.visual).add(group);
      record.hazardFlasher = group;
    }
    if (!record.accidentSmoke) {
      this.chaosSmokeGeometry ??= new THREE.SphereGeometry(.5, 8, 6);
      this.chaosSmokeMaterial ??= new THREE.MeshBasicMaterial({
        color: 0x383d3b, transparent: true, opacity: .48,
        depthWrite: false, toneMapped: false,
      });
      const group = new THREE.Group();
      group.name = "street-chaos-wreck-smoke";
      for (let i = 0; i < 9; i++) {
        const puff = new THREE.Mesh(this.chaosSmokeGeometry, this.chaosSmokeMaterial);
        puff.name = "street-chaos-smoke-puff";
        group.add(puff);
      }
      (fxLayer ?? record.visual).add(group);
      record.accidentSmoke = group;
    }
  }
  updateStreetChaosHazards(record, actor, x, y, z, heading, distance2) {
    this.ensureStreetChaosHazards(record, actor);
    const role = streetChaosAccidentRole(this.world, actor);
    const idHash = String(actor.id ?? "").split("").reduce((sum, ch) => sum + ch.charCodeAt(0), 0);
    const phaseOffset = role?.role === "follower" ? 12 : role?.role === "lead" ? 0 : (idHash % 2) * 12;
    record.hazardFlasher.visible = (((this.world.tick ?? 0) + phaseOffset) % 24) < 12;
    const fxLayer = this.crashEffects?.layer;
    if (record.hazardFlasher.parent === fxLayer) {
      record.hazardFlasher.position.set(x, y, z);
      record.hazardFlasher.rotation.y = heading;
    }
    const smoke = record.accidentSmoke;
    if (!smoke) return;
    smoke.visible = distance2 <= 110 * 110;
    if (!smoke.visible) return;
    const front = (actor.length ?? 4.4) * .34;
    if (smoke.parent === fxLayer)
      smoke.position.set(x + Math.sin(heading) * front, y + .68, z + Math.cos(heading) * front);
    for (let i = 0; i < smoke.children.length; i++) {
      const puff = smoke.children[i];
      const phase = (((this.world.tick ?? 0) + i * 6) % 54) / 54;
      const scale = 1.4 + phase * .5;
      puff.position.set(Math.sin((phase + i) * 5.7) * .28, .18 + phase * 3.2,
        Math.cos((phase + i) * 4.9) * .22);
      puff.scale.set(scale, scale * 1.12, scale);
    }
  }
  hideStreetChaosHazards(record) {
    if (record.hazardFlasher) record.hazardFlasher.visible = false;
    if (record.accidentSmoke) record.accidentSmoke.visible = false;
  }
  clearStreetChaosHazards(record) {
    record.hazardFlasher?.removeFromParent();
    record.accidentSmoke?.removeFromParent();
    record.hazardFlasher = record.accidentSmoke = null;
  }
  removeMetroActor(id, record) {
    if (
      !this.disposed &&
      this.grandCity &&
      record.actor?.type === "pedestrian" &&
      record.pedestrianRig &&
      record.visual
    ) {
      this.metroPedestrianPool ??= new Map();
      this.metroPedestrianPoolCount ??= 0;
      if (this.metroPedestrianPoolCount < 96) {
        const key = actorAsset(record.actor);
        let list = this.metroPedestrianPool.get(key);
        if (!list) {
          list = [];
          this.metroPedestrianPool.set(key, list);
        }
        record.visual.removeFromParent();
        record.visual.rotation.set(0, 0, 0);
        record.visual.visible = true;
        list.push({ visual: record.visual, rig: record.pedestrianRig });
        this.metroPedestrianPoolCount++;
        record.pedestrianRig = record.visual = null;
      }
    }
    record.poseTick = record.poseAlpha = undefined;
    this.clearStreetChaosHazards(record);
    record.pedestrianRig?.dispose();
    disposeSkeletons(record.visual);
    if (record.entry) {
      applyTrafficCrashDamage(record.visual, { front: 0, rear: 0, left: 0, right: 0, wrecked: false });
      record.lastTrafficDmgKey = null;
      record.lastTrafficDmgVisual = null;
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
    const elev = this.world.terrainElevationAt ? this.world.terrainElevationAt(x, z) : 0;
    for (const road of this.metroAsphalt) if (containsXZ(road, x, z)) return .115 + elev;
    if (this.metroDiagRoads.length && pointOnAnyRoad({ x, z }, this.metroDiagRoads, 0)) return .115 + elev;
    for (const road of this.metroPavement) if (containsXZ(road, x, z)) return .07 + elev;
    if (this.metroDiagRoads.length && pointOnAnyRoad({ x, z }, this.metroDiagRoads, -2.5)) return .07 + elev;
    return -.05 + elev;
  }
  updateSunShadowAnchor(anchorX, anchorZ) {
    if (!this.sun || !Number.isFinite(anchorX) || !Number.isFinite(anchorZ)) return;
    if (this.skyDome) {
      this.skyDome.position.set(anchorX, 0, anchorZ);
      this.skyDome.updateMatrixWorld(true);
    }
    const sunRight = this.sunRight ?? SUN_RIGHT;
    const sunUp = this.sunUp ?? SUN_UP;
    const sunOffset = this.sunOffset ?? SUN_OFFSET;
    const shadow = this.sun.shadow;
    const texelX = (shadow.camera.right - shadow.camera.left) / shadow.mapSize.x;
    const texelY = (shadow.camera.top - shadow.camera.bottom) / shadow.mapSize.y;
    const lightX = anchorX * sunRight.x + anchorZ * sunRight.z;
    const lightY = anchorX * sunUp.x + anchorZ * sunUp.z;
    const sx = Math.round(lightX / texelX) * texelX;
    const sz = Math.round(lightY / texelY) * texelY;
    if (sx === this._sunAnchorX && sz === this._sunAnchorZ) return;
    this._sunAnchorX = sx;
    this._sunAnchorZ = sz;
    // Quantize in the light's image plane, not a 2 m world grid that jumps across texels.
    const determinant = sunRight.x * sunUp.z - sunRight.z * sunUp.x;
    this.sunAnchor.set((sx * sunUp.z - sz * sunRight.z) / determinant, 0,
      (sz * sunRight.x - sx * sunUp.x) / determinant);
    this.sun.target.position.copy(this.sunAnchor);
    this.sun.position.copy(this.sunAnchor).add(sunOffset);
    this.sun.updateMatrixWorld(true);
    this.sun.target.updateMatrixWorld(true);
  }
  updatePlayerLighting(px, py, pz, heading = 0) {
    if (!Number.isFinite(px) || !Number.isFinite(pz)) return;
    const safeY = Number.isFinite(py) ? py : 0.12;
    const h = Number.isFinite(heading) ? heading : 0;
    if (this.playerStreetLight) {
      this.playerStreetLight.position.set(px, safeY + 7.8, pz - 1.4);
      this.playerStreetLight.updateMatrixWorld(true);
    }
    if (this.playerSculptLight) {
      const sinH = Math.sin(h), cosH = Math.cos(h);
      this.playerSculptLight.position.set(
        px + sinH * 3.4 + cosH * 2.1,
        safeY + 2.35,
        pz + cosH * 3.4 - sinH * 2.1,
      );
      this.playerSculptLight.updateMatrixWorld(true);
    }
    if (this.streetFillLight) {
      this.streetFillLight.target.position.set(px, safeY, pz);
      this.streetFillLight.position.set(px + 84, safeY + 68, pz + 96);
      this.streetFillLight.updateMatrixWorld(true);
      this.streetFillLight.target.updateMatrixWorld(true);
    }
  }
  syncPlayerRig(record, actor) {
    if (record.vehicleRig && record.vehicleModel === actor.vehicleModel) return;
    const playerInit = this.metro || this.grandCity ? { ...actor, pearlClearcoat: true } : actor;
    const nextRig = createPlayerVehicle(null, playerInit);
    record.vehicleRig?.dispose();
    record.vehicleRig = nextRig;
    record.vehicleModel = actor.vehicleModel;
    record.visual = nextRig.root;
    record.curbWheels = null;
    record.root.add(record.visual);
  }
  syncMetroPlayer(alpha) {
    const { world } = this, actor = world.player, record = this.roots.get(actor.id);
    this.syncPlayerRig(record, actor);
    const t = Number.isFinite(alpha) ? THREE.MathUtils.clamp(alpha, 0, 1) : 1;
    this.metroAlpha = t;
    const prev = actor.previous && Math.hypot(actor.x - actor.previous.x, actor.z - actor.previous.z) < 12
      ? actor.previous
      : actor;
    const ix = THREE.MathUtils.lerp(prev.x, actor.x, t);
    const iz = THREE.MathUtils.lerp(prev.z, actor.z, t);
    const elev = world.terrainElevationAt ? world.terrainElevationAt(ix, iz) : 0;
    const iy = .12 + elev + (world.pursuit?.phase === "running" || actor.curbSupportId || prev.curbSupportId
      ? THREE.MathUtils.lerp(prev.y ?? 0, actor.y ?? 0, t)
      : 0);
    const iHeading = (prev.heading ?? 0) + angleDelta(actor.heading ?? 0, prev.heading ?? 0) * t;
    record.root.position.set(ix, iy, iz);
    if (world.terrain) {
      const grad = terrainGradientAt(world.terrain, ix, iz, this._gradScratch);
      const sH = Math.sin(iHeading), cH = Math.cos(iHeading);
      const gradeAlong = grad.dhdx * sH + grad.dhdz * cH;
      const camberAcross = grad.dhdx * cH - grad.dhdz * sH;
      record.root.rotation.order = "YXZ";
      record.root.rotation.set(-Math.atan(gradeAlong), iHeading, Math.atan(camberAcross));
    } else {
      record.root.rotation.y = iHeading;
    }
    this.updateSunShadowAnchor(ix, iz);
    this.updatePlayerLighting(ix, iy, iz, iHeading);
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
    const egChildren = this.egyptStreets.root.children;
    if (egChildren.length) {
      this.egyptStreets.root.updateMatrix();
      for (let cIdx = 0; cIdx < egChildren.length; cIdx++) {
        const blockGroup = egChildren[cIdx];
        if (!blockGroup || blockGroup.userData?._reliefChecked) continue;
        blockGroup.userData ??= {};
        blockGroup.userData._reliefChecked = true;
        if (this.facadeRelief) {
          blockGroup.traverse(part => {
            const material = part.material;
            if (material?.name !== "egypt-authored-facade-atlas" || this.reliefMaterials.has(material)) return;
            material.bumpMap = material.roughnessMap = this.facadeRelief;
            material.bumpScale = .035;
            if (this.metroMaterialDetail) this.metroMaterialDetail.apply(material, true);
            else material.needsUpdate = true;
            this.reliefMaterials.add(material);
          });
        }
        blockGroup.updateMatrixWorld(true);
        blockGroup.matrixAutoUpdate = false;
        blockGroup.matrixWorldAutoUpdate = false;
      }
    }
    const frame = ++this.metroFrame, pending = this.metroPending;
    const pursuit = world.pursuit?.phase === "running";
    this.metroSilhouettes.begin();
    this.metroTrafficKinds.clear();
    this.metroPresented = 1; // The always-present original player rig.
    this.metroProxyActors = 0;
    this.metroCulledPedestrians = 0;
    pending.length = 0;
    if (this.grandCity && this.metroPrimedActorsLen !== world.actors.length) {
      for (const actor of world.actors) {
        if (actor !== player && actor.type === "pedestrian") {
          this.metroAsset(actorAsset(actor), actor.kind);
        } else if (actor.pursuitRole === "police") {
          this.pursuitView?.prewarmActorShell?.(actor, this.metroModels);
        }
      }
      if (!this.metroPrimedActorsLen && this.metroStalls?.length) {
        this.metroAsset("/assets/models/props/market-produce.glb", "market-produce");
      }
      this.metroPrimedActorsLen = world.actors.length;
    }
    for (const actor of world.actors) {
      if (actor === player) continue;
      const person = actor.type === "pedestrian";
      const previous = actor.previous && Math.hypot(actor.x - actor.previous.x, actor.z - actor.previous.z) < 12
        ? actor.previous
        : actor;
      const x = THREE.MathUtils.lerp(previous.x, actor.x, alpha);
      const z = THREE.MathUtils.lerp(previous.z, actor.z, alpha);
      const pinned = person && (actor.id === this.focusedPersonId || actor.id === this.selectedPersonId);
      let record = this.roots.get(actor.id);
      const distance2 = distanceToAnchors2(x, z, anchors);
      if (person && this.grandCity && !pinned && distance2 > PEDESTRIAN_CULL_LOD_SQ) {
        if (record) record.root.visible = false;
        this.metroCulledPedestrians++;
        this.metroPresented++;
        continue;
      }
      const vElev = !person && world.terrainElevationAt ? world.terrainElevationAt(x, z) : 0;
      const y = person
        ? this.metroGroundHeight(x, z)
        : .12 + vElev + (pursuit ? THREE.MathUtils.lerp(previous.y ?? 0, actor.y ?? 0, alpha) : 0);
      const heading = (previous.heading ?? 0) + angleDelta(actor.heading ?? 0, previous.heading ?? 0) * alpha;
      const nearM = person ? METRO_PERSON_NEAR_M : METRO_NEAR_M;
      const releaseM = person ? METRO_PERSON_RELEASE_M : METRO_RELEASE_M;
      const chaosWreck = !person && isStreetChaosWreck(world, actor);
      const baseReach = (record ? releaseM : nearM) + (person ? .3 : actor.length * .5);
      const reach = chaosWreck ? Math.max(110, baseReach) : baseReach;
      if (pinned || distance2 <= reach * reach) {
        record ??= this.addMetroActor(actor);
        record.frame = frame;
        record.actor = actor;
        record.root.visible = true;
        record.root.position.set(x, y, z);
        if (!person && world.terrain) {
          const grad = terrainGradientAt(world.terrain, x, z, this._gradScratch);
          const sH = Math.sin(heading), cH = Math.cos(heading);
          const gradeAlong = grad.dhdx * sH + grad.dhdz * cH;
          const camberAcross = grad.dhdx * cH - grad.dhdz * sH;
          record.root.rotation.order = "YXZ";
          record.root.rotation.set(-Math.atan(gradeAlong), heading, Math.atan(camberAcross));
        } else {
          record.root.rotation.y = heading;
        }
        if (!person) {
          animateWheels(record, actor);
          const yawDelta = angleDelta(actor.heading ?? 0, previous.heading ?? 0);
          const latG = THREE.MathUtils.clamp((actor.speed ?? 0) * yawDelta * 60, -9, 9);
          const accelG = THREE.MathUtils.clamp(((actor.speed ?? 0) - (previous.speed ?? actor.speed ?? 0)) * 60, -10, 10);
          const maxRoll = actor.kind === "truck" ? 0.032 : actor.pursuitRole === "police" ? 0.065 : 0.052;
          const targetRoll = THREE.MathUtils.clamp((latG / 9) * maxRoll, -maxRoll, maxRoll);
          const targetPitch = THREE.MathUtils.clamp((-accelG / 10) * 0.048, -0.048, 0.048);
          const suspBlend = record.suspTick === undefined ? 0.35 : record.suspTick === world.tick ? 0.14 : 0.26;
          record.suspTick = world.tick;
          record.rollRad = THREE.MathUtils.lerp(record.rollRad ?? 0, targetRoll, suspBlend);
          record.pitchRad = THREE.MathUtils.lerp(record.pitchRad ?? 0, targetPitch, suspBlend);
          if (Math.abs(record.rollRad) < 1e-5) record.rollRad = 0;
          if (Math.abs(record.pitchRad) < 1e-5) record.pitchRad = 0;
          if (record.visual) {
            const impactRx = getActorImpactReaction(actor);
            record.visual.rotation.z = record.rollRad + impactRx.rollRad;
            record.visual.rotation.x = record.pitchRad + impactRx.pitchRad;
            record.visual.position.y = impactRx.heaveM;
            if (actor.pursuitRole !== "police") {
              const recordedDmg = getPatrolVisualDamage(actor);
              const trafficDmg = chaosWreck
                ? streetChaosAccidentDamage(world, actor, recordedDmg)
                : recordedDmg;
              if (trafficDmg) {
                const fQ = Math.round((trafficDmg.front ?? 0) * 1000);
                const rQ = Math.round((trafficDmg.rear ?? 0) * 1000);
                const lQ = Math.round((trafficDmg.left ?? 0) * 1000);
                const rtQ = Math.round((trafficDmg.right ?? 0) * 1000);
                const wQ = trafficDmg.wrecked ? 1 : 0;
                const dmgKey = `${fQ}|${rQ}|${lQ}|${rtQ}|${wQ}`;
                if (record.lastTrafficDmgKey !== dmgKey || record.lastTrafficDmgVisual !== record.visual) {
                  applyTrafficCrashDamage(record.visual, trafficDmg);
                  record.lastTrafficDmgKey = dmgKey;
                  record.lastTrafficDmgVisual = record.visual;
                }
              } else if (record.lastTrafficDmgKey) {
                applyTrafficCrashDamage(record.visual, { front: 0, rear: 0, left: 0, right: 0, wrecked: false });
                record.lastTrafficDmgKey = record.lastTrafficDmgVisual = null;
              }
              if (chaosWreck) this.updateStreetChaosHazards(record, actor, x, y, z, heading, distance2);
              else this.hideStreetChaosHazards(record);
            }
          }
        } else if (!record.pedestrianRig) {
          const source = this.metroAsset(actorAsset(actor), actor.kind);
          if (source.gltf && !source.failed)
            pending.push({ record, source, priority: pinned ? -1 : distance2 });
        } else if (
          (pinned || distance2 <= PEDESTRIAN_ANIM_LOD_SQ) &&
          (record.poseTick !== world.tick || record.poseAlpha !== alpha)
        ) {
          record.pedestrianRig.update(actor, alpha);
          record.poseTick = world.tick;
          record.poseAlpha = alpha;
        }
        if (person && (pinned || distance2 <= PEDESTRIAN_ANIM_LOD_SQ) && (actor.impact || record.root.userData.pedestrianImpactPose))
          applyPedestrianImpact(record.root, actor, world.tick, alpha);
      } else {
        this.metroSilhouettes.put(actor, x, y, z, heading);
        this.metroProxyActors++;
      }
      if (!person && actor.pursuitRole !== "police") this.metroTrafficKinds.add(proxyKind(actor));
      this.metroPresented++;
    }
    pending.sort((a, b) => a.priority - b.priority);
    let unpooledClones = 0;
    for (let pIdx = 0; pIdx < pending.length; pIdx++) {
      const item = pending[pIdx];
      const key = actorAsset(item.record.actor);
      const hasPooled = this.grandCity && (this.metroPedestrianPool?.get(key)?.length ?? 0) > 0;
      if (hasPooled) {
        this.finishMetroPerson(item, alpha);
      } else if (unpooledClones < 1) {
        this.finishMetroPerson(item, alpha);
        unpooledClones++;
      }
    }
    const hadUnpooledWork = unpooledClones > 0;
    pending.length = 0;
    if (this.grandCity) {
      for (const [url, source] of this.metroAssets) {
        if (!source?.gltf || (!url.includes("/people/") && !url.includes("market-produce"))) continue;
        this.metroSkinnedPrototypes ??= new Map();
        if (!this.metroSkinnedPrototypes.has(url)) {
          try {
            const proto = url.includes("market-produce")
              ? fit(source.gltf.scene, 2.2, 2.2, 1.8)
              : fit(source.gltf.scene, Infinity, Infinity, 1.78);
            this.metroSkinnedPrototypes.set(url, proto);
          } catch {
            this.metroSkinnedCompiled ??= new Set();
            this.metroSkinnedCompiled.add(url);
          }
        }
      }
    }
    if (this.grandCity && !hadUnpooledWork) {
      this.metroPedestrianPool ??= new Map();
      this.metroPedestrianPoolSeeded ??= new Set();
      this.metroPedestrianPoolCount ??= 0;
      let seededThisFrame = 0;
      for (const [url, source] of this.metroAssets) {
        if (seededThisFrame >= 3) break;
        if (!source?.gltf || !url.includes("/people/") || this.metroPedestrianPoolSeeded.has(url)) continue;
        let list = this.metroPedestrianPool.get(url);
        if (!list) {
          list = [];
          this.metroPedestrianPool.set(url, list);
        }
        if (list.length >= 3 || this.metroPedestrianPoolCount >= 96) {
          this.metroPedestrianPoolSeeded.add(url);
          continue;
        }
        const name = source.name ?? "casual_man";
        const dummyActor = { id: `pool-${name}`, type: "pedestrian", kind: name, speed: 1.2, phase: 0 };
        dummyActor.body = createPedestrianBody(dummyActor);
        try {
          const visual = fit(source.gltf.scene, Infinity, Infinity, dummyActor.body.heightM);
          const rig = createPedestrianRig(visual, source.gltf.animations, dummyActor);
          list.push({ visual, rig });
          this.metroPedestrianPoolCount++;
          seededThisFrame++;
          if (list.length >= 3 || this.metroPedestrianPoolCount >= 96) {
            this.metroPedestrianPoolSeeded.add(url);
          }
        } catch {
          this.metroSkinnedCompiled ??= new Set();
          this.metroSkinnedCompiled.add(url);
          this.metroPedestrianPoolSeeded.add(url);
        }
      }
    }
    for (const [id, record] of this.roots)
      if (id !== player.id && record.frame !== frame) this.removeMetroActor(id, record);
    this.prepareMetroProps(anchors);
    this.cityProps?.update(anchors);
    this.metroSilhouettes.end();
    this.pursuitView?.update(world, alpha);
    this.stepCrashEffects(alpha, cameras?.[0] ?? null);
    this.scene.matrixWorldAutoUpdate = false;
    this.scene.updateMatrixWorld();
  }
  stepCrashEffects(alpha = 1, camera = null) {
    if (!this.crashEffects && !this.streetSurfaces) return;
    const a = Number.isFinite(alpha) ? THREE.MathUtils.clamp(alpha, 0, 1) : 1;
    const simTime = ((this.world.tick ?? 0) + a) / 60;
    let dt = this._lastCrashSimTime === null ? 1 / 60 : simTime - this._lastCrashSimTime;
    this._lastCrashSimTime = simTime;
    if (!Number.isFinite(dt) || dt < 0) dt = 1 / 60;
    else if (dt > 0.05) dt = 0.05;
    this.crashEffects?.update(this.world, dt, camera);
    this.streetSurfaces?.update(this.world, dt, camera);
  }
  crashDiagnostics() {
    return this.crashEffects?.diagnostics?.() ?? null;
  }
  streetSurfaceDiagnostics() {
    return this.streetSurfaces?.diagnostics?.() ?? null;
  }
  pursuitDiagnostics() {
    return this.pursuitView?.diagnostics?.() ?? null;
  }
  atmosphereDiagnostics() {
    const roadMat = this.surfaces.road[0]?.material ?? null;
    const paveMesh = this.surfaces.pavement.find(m => m.name !== "road-retaining-walls") ?? this.surfaces.pavement[0];
    const paveMat = paveMesh?.material ?? null;
    const sunOff = this.sunOffset ?? SUN_OFFSET;
    const sunElevDeg = Math.atan2(sunOff.y, Math.hypot(sunOff.x, sunOff.z)) * (180 / Math.PI);
    return {
      grandCity: Boolean(this.grandCity),
      skyBackgroundHex: this.scene.background?.getHex?.() ?? null,
      fogColorHex: this.scene.fog?.color?.getHex?.() ?? null,
      hemiIntensity: this.hemiLight?.intensity ?? null,
      sunIntensity: this.sun?.intensity ?? null,
      rimIntensity: this.rimLight?.intensity ?? null,
      streetFillIntensity: this.streetFillLight?.intensity ?? null,
      playerStreetKeyIntensity: this.playerStreetLight?.intensity ?? null,
      sunElevationDeg: Number(sunElevDeg.toFixed(2)),
      hasSkyDome: Boolean(this.skyDome),
      hasCinematicRoadPbr: Boolean(this.cinematicRoadTextures && roadMat?.map && roadMat?.bumpMap && roadMat?.roughnessMap),
      hasCinematicSidewalkPbr: Boolean(this.cinematicRoadTextures && paveMat?.map && paveMat?.bumpMap && paveMat?.roughnessMap),
      roadColorHex: roadMat?.color?.getHex?.() ?? null,
      pavementColorHex: paveMat?.color?.getHex?.() ?? null,
    };
  }
  finishMetroPerson({ record, source }, alpha) {
    const { actor } = record;
    const height = actor.body?.heightM ?? 1.78;
    const key = actorAsset(actor);
    const pooledList = this.grandCity ? this.metroPedestrianPool?.get(key) : null;
    if (pooledList?.length) {
      const pooled = pooledList.pop();
      this.metroPedestrianPoolCount = Math.max(0, (this.metroPedestrianPoolCount ?? 1) - 1);
      pooled.visual.removeFromParent();
      pooled.visual.rotation.set(0, 0, 0);
      pooled.visual.visible = true;
      const base = pooled.visual.userData?.fitBase;
      if (base && base.sizeY > 0) {
        const scale = height / base.sizeY;
        pooled.visual.scale.set(scale, scale, scale);
        pooled.visual.position.set(-base.centerX * scale, -base.minY * scale, -base.centerZ * scale);
        pooled.visual.updateMatrixWorld(true);
      }
      record.root.add(pooled.visual);
      pooled.rig.update(actor, alpha);
      record.pedestrianRig = pooled.rig;
      record.visual = pooled.visual;
      record.poseTick = this.world.tick;
      record.poseAlpha = alpha;
      record.fallback?.removeFromParent();
      if (actor.impact || record.root.userData.pedestrianImpactPose)
        applyPedestrianImpact(record.root, actor, this.world.tick, alpha);
      return;
    }
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
      record.fallback?.removeFromParent();
      if (actor.impact || record.root.userData.pedestrianImpactPose)
        applyPedestrianImpact(record.root, actor, this.world.tick, alpha);
    } catch {
      rig?.dispose();
      visual?.removeFromParent();
      disposeSkeletons(visual);
      source.failed = true;
      this.status.failed.push(actor.kind);
    }
  }
  prepareMetroProps(anchors) {
    if (this.metroParkedWorldStatics !== this.world.statics) {
      this.metroParkedWorldStatics = this.world.statics;
      const byId = new Map();
      for (const s of this.world.statics) {
        if (s.kind === "parked-vehicle") byId.set(s.id, s);
      }
      for (const prop of this.metroParked) {
        const nextOrig = byId.get(prop.origSite?.id);
        if (nextOrig) prop.origSite = nextOrig;
        prop.wasJolted = false;
      }
    }
    for (const prop of this.metroParked) {
      const { site, origSite } = prop;
      const poseMoved = Boolean(
        origSite &&
          (site.x !== origSite.x ||
            site.z !== origSite.z ||
            site.heading !== origSite.heading),
      );
      if (poseMoved) {
        site.x = origSite.x;
        site.z = origSite.z;
        site.heading = origSite.heading;
      }
      const reach = (prop.root ? METRO_RELEASE_M : METRO_NEAR_M) + site.length / 2;
      if (distanceToAnchors2(site.x, site.z, anchors) <= reach * reach) {
        const pElev = this.world.terrainElevationAt ? this.world.terrainElevationAt(site.x, site.z) : 0;
        let basePitch = 0;
        let baseRoll = 0;
        const h = site.heading ?? 0;
        if (this.world.terrain) {
          const grad = terrainGradientAt(this.world.terrain, site.x, site.z, this._gradScratch);
          const sH = Math.sin(h), cH = Math.cos(h);
          basePitch = -Math.atan(grad.dhdx * sH + grad.dhdz * cH);
          baseRoll = Math.atan(grad.dhdx * cH - grad.dhdz * sH);
        }
        const newlyAcquired = !prop.root;
        if (newlyAcquired) {
          const { visual: root, entry } = this.metroModels.acquire(site);
          prop.root = root;
          prop.entry = entry;
          prop.baseY = .12 + pElev;
          prop.basePitch = basePitch;
          prop.baseRoll = baseRoll;
          root.position.set(site.x, prop.baseY, site.z);
          root.rotation.order = "YXZ";
          root.rotation.set(basePitch, h, baseRoll);
          this.scene.add(root);
          root.matrixAutoUpdate = root.matrixWorldAutoUpdate = false;
        } else if (poseMoved) {
          prop.baseY = .12 + pElev;
          prop.basePitch = basePitch;
          prop.baseRoll = baseRoll;
        }
        const parkedRx = origSite ? getActorImpactReaction(origSite) : null;
        const parkedDmg = origSite ? getPatrolVisualDamage(origSite) : null;
        if (newlyAcquired || poseMoved || parkedRx?.active || prop.wasJolted || (parkedDmg && !prop.dmgApplied)) {
          const rxRoll = parkedRx?.rollRad ?? 0;
          const rxPitch = parkedRx?.pitchRad ?? 0;
          const rxHeave = parkedRx?.heaveM ?? 0;
          prop.root.position.set(site.x, (prop.baseY ?? (.12 + pElev)) + rxHeave, site.z);
          prop.root.rotation.order = "YXZ";
          prop.root.rotation.set((prop.basePitch ?? basePitch) + rxPitch, h, (prop.baseRoll ?? baseRoll) + rxRoll);
          if (parkedDmg) {
            applyTrafficCrashDamage(prop.root, parkedDmg);
            prop.dmgApplied = true;
          }
          prop.root.updateMatrix();
          prop.root.updateMatrixWorld(true);
          prop.wasJolted = Boolean(parkedRx?.active);
        }
      } else {
        if (prop.root) {
          applyTrafficCrashDamage(prop.root, { front: 0, rear: 0, left: 0, right: 0, wrecked: false });
          prop.root.removeFromParent();
          this.metroModels.release(prop.entry);
          prop.root = prop.entry = null;
          prop.dmgApplied = false;
          prop.wasJolted = false;
        }
        const pElev = this.world.terrainElevationAt ? this.world.terrainElevationAt(site.x, site.z) : 0;
        this.metroSilhouettes.put(site, site.x, .12 + pElev, site.z, site.heading ?? 0);
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
    let unwarmedPeopleAssets = 0;
    let loadingPeopleAssets = 0;
    if (this.grandCity && this.metroAssets) {
      for (const [url, src] of this.metroAssets) {
        if ((url.includes("/people/") || url.includes("market-produce")) && !src?.failed) {
          if (!src?.gltf) loadingPeopleAssets++;
          if (!src?.gltf || !this.metroSkinnedCompiled?.has(url)) unwarmedPeopleAssets++;
        }
      }
    }
    return {
      ready: Boolean(this.playerRig?.diagnostics.ready) && availableActors === totalActors,
      totalActors, availableActors, detailedActors, pendingPeople, unwarmedPeopleAssets, loadingPeopleAssets,
      proxyActors: this.metro && !this.disposed ? this.metroProxyActors + (this.metroCulledPedestrians ?? 0) + pendingPeople : 0,
      culledPedestrians: this.metro && !this.disposed ? (this.metroCulledPedestrians ?? 0) : (this.nonMetroCulledPedestrians ?? 0),
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
  syncPedestrians(alpha = 1, activeCamera = null) {
    const world = this.world;
    const t = Number.isFinite(alpha) ? THREE.MathUtils.clamp(alpha, 0, 1) : 1;
    const refX = Number.isFinite(activeCamera?.position?.x) ? activeCamera.position.x : (world.player?.x ?? 0);
    const refZ = Number.isFinite(activeCamera?.position?.z) ? activeCamera.position.z : (world.player?.z ?? 0);
    const playerX = world.player?.x ?? refX;
    const playerZ = world.player?.z ?? refZ;
    let culled = 0;
    for (const actor of world.actors) {
      if (actor.type !== "pedestrian") continue;
      if (!this.roots.has(actor.id)) this.addActor(actor);
      const record = this.roots.get(actor.id);
      const prev = actor.previous && Math.hypot(actor.x - actor.previous.x, actor.z - actor.previous.z) < 12
        ? actor.previous
        : actor;
      const px = THREE.MathUtils.lerp(prev.x, actor.x, t);
      const pz = THREE.MathUtils.lerp(prev.z, actor.z, t);
      const pinned = actor.id === this.focusedPersonId || actor.id === this.selectedPersonId;
      const camDx = px - refX, camDz = pz - refZ;
      const plyDx = px - playerX, plyDz = pz - playerZ;
      const distSq = Math.min(camDx * camDx + camDz * camDz, plyDx * plyDx + plyDz * plyDz);
      if (!pinned && distSq > PEDESTRIAN_CULL_LOD_SQ) {
        record.root.visible = false;
        culled++;
        continue;
      }
      record.root.visible = true;
      const p = interpolate(prev, actor, t);
      record.root.position.set(p.x, this.pedestrianGroundHeight(p), p.z);
      record.root.rotation.y = p.heading;
      const detailedMesh = pinned || distSq < 42 * 42;
      if (record.visual) {
        record.visual.visible = detailedMesh;
        record.fallback.visible = !detailedMesh;
      }
      const animActive = pinned || distSq <= PEDESTRIAN_ANIM_LOD_SQ;
      if (record.pedestrianRig && animActive) {
        record.pedestrianRig.update(actor, t);
      }
      if (animActive && (actor.impact || record.root.userData.pedestrianImpactPose)) {
        applyPedestrianImpact(record.root, actor, world.tick, t);
      }
    }
    this.nonMetroCulledPedestrians = culled;
    return culled;
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
    this.syncPedestrians(t);
    for (const actor of world.actors) {
      if (actor.type === "pedestrian") continue;
      if (!this.roots.has(actor.id)) this.addActor(actor);
      const record = this.roots.get(actor.id);
      const prev = actor.previous && Math.hypot(actor.x - actor.previous.x, actor.z - actor.previous.z) < 12
        ? actor.previous
        : actor;
      const p = interpolate(prev, actor, t);
      record.root.position.set(p.x, 0.12, p.z);
      record.root.rotation.y = p.heading;
      const dx = p.x - world.player.x;
      const dz = p.z - world.player.z;
      const distSq = dx * dx + dz * dz;
      const detailed = actor === world.player || distSq < 68 * 68;
      record.root.visible = actor === world.player || distSq < PEDESTRIAN_CULL_LOD_SQ;
      if (record.visual) {
        record.visual.visible = detailed;
        record.fallback.visible = !detailed;
      }
      record.vehicleRig?.update(actor, world.sensors, t);
      if (detailed) animateWheels(record, actor);
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
    this.updatePlayerLighting(player.position.x, player.position.y, player.position.z, player.rotation.y);
    this.pursuitView?.update(world, t);
    this.stepCrashEffects(t);
    return player;
  }
  syncRoute() {
    const world = this.world;
    if (this.routeRevision === world.routeRevision) return;
    this.routeRevision = world.routeRevision;
    this.route.geometry.dispose();
    const elevAt = world.terrainElevationAt;
    const pts = [];
    const path = world.player.path;
    for (let i = 0; i < path.length; i++) {
      const p = path[i];
      if (i > 0 && elevAt) {
        const prev = path[i - 1];
        const segLen = Math.hypot(p.x - prev.x, p.z - prev.z);
        const steps = Math.min(24, Math.floor(segLen / 6));
        for (let k = 1; k < steps; k++) {
          const u = k / steps;
          const sx = prev.x + (p.x - prev.x) * u;
          const sz = prev.z + (p.z - prev.z) * u;
          pts.push(new THREE.Vector3(sx, 0.14 + elevAt(sx, sz), sz));
        }
      }
      pts.push(new THREE.Vector3(p.x, 0.14 + (elevAt ? elevAt(p.x, p.z) : 0), p.z));
    }
    this.route.geometry = new THREE.BufferGeometry().setFromPoints(pts);
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
    this.crashEffects?.dispose();
    this.streetSurfaces?.dispose();
    this.cityProps?.dispose();
    this.cinematicRoadTextures?.dispose();
    if (this.skyDome) {
      this.skyDome.geometry?.dispose();
      this.skyDome.material?.dispose();
      this.skyDome = null;
    }
    this.drillPatrolModels?.dispose();
    this.scene.remove(this.egyptStreets.root);
    this.egyptStreets.dispose();
    this.facadeRelief?.dispose();
    this.metroMaterialDetail?.dispose();
    if (this.metro) {
      this.sun.shadow.dispose();
      for (const [id, record] of this.roots)
        if (id !== this.world.player.id) this.removeMetroActor(id, record);
      for (const prop of this.metroStalls) disposeSkeletons(prop.visual);
      if (this.metroPedestrianPool) {
        for (const list of this.metroPedestrianPool.values()) {
          for (const item of list) {
            item.rig?.dispose();
            disposeSkeletons(item.visual);
          }
        }
        this.metroPedestrianPool.clear();
        this.metroPedestrianPoolCount = 0;
      }
      if (this.metroSkinnedPrototypes) {
        for (const proto of this.metroSkinnedPrototypes.values()) disposeSkeletons(proto);
        this.metroSkinnedPrototypes.clear();
      }
      this.chaosHazardGeometry?.dispose();
      this.chaosHazardHaloGeometry?.dispose();
      this.chaosHazardMaterial?.dispose();
      this.chaosSmokeGeometry?.dispose();
      this.chaosSmokeMaterial?.dispose();
      if (this.ownsStreetChaosFxLayer) this.crashEffects?.layer?.removeFromParent().clear();
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
        for (const texture of [mat?.map, mat?.normalMap, mat?.bumpMap, mat?.roughnessMap])
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
