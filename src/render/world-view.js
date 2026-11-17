import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { RGBELoader } from "three/addons/loaders/RGBELoader.js";
import { clone } from "three/addons/utils/SkeletonUtils.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { interpolate, roadRect, pointOnRoad } from "../core/geometry.js";
import { addPlaceSigns } from "./place-signs.js";
import { createPlayerVehicle } from "./player-vehicle.js";
import { createEgyptStreetLayer } from "./egypt-streets.js";
import { createPedestrianRig } from "./pedestrian-rig.js";

const templates = new Map(),
  loader = new GLTFLoader();
const textureLoader = new THREE.TextureLoader();
let streetLighting;
const trafficColors = [
  0x88969a, 0xa84a39, 0xb0b5ac, 0x455b76, 0x8f7458, 0x62766a,
];
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

export class WorldView {
  get playerRig() {
    return this.roots.get("player")?.vehicleRig ?? null;
  }
  constructor(world) {
    this.world = world;
    this.roots = new Map();
    this.barriers = new Map();
    this.status = { loaded: 0, failed: [] };
    this.surfaces = { road: [], pavement: [] };
    this.disposed = false;
    const scene = (this.scene = new THREE.Scene());
    scene.background = new THREE.Color(0xcbd2cd);
    scene.fog = new THREE.Fog(0xcbd2cd, 90, 280);
    if (world.environment === "city") {
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
    scene.add(new THREE.HemisphereLight(0xdce7eb, 0x8f7b60, 0.65));
    const sun = new THREE.DirectionalLight(0xffe6c7, 1.4);
    sun.position.set(-65, 100, -45);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = sun.shadow.camera.bottom = -65;
    sun.shadow.camera.right = sun.shadow.camera.top = 65;
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 230;
    sun.shadow.bias = -0.0005;
    sun.shadow.normalBias = 0.04;
    scene.add(sun, sun.target);
    this.sun = sun;
    this.egyptStreets = createEgyptStreetLayer(world);
    scene.add(this.egyptStreets.root);
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(650, 650),
      material(world.environment === "lab" ? 0xaaa99d : 0xb1a18a),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.userData.owned = true;
    ground.position.y = -0.05;
    ground.receiveShadow = true;
    scene.add(ground);
    this.buildRoads();
    if (world.environment === "city") this.loadSurfaces();
    if (world.environment === "city") addPlaceSigns(THREE, scene, world);
    this.buildStatics();
    this.buildSignals();
    for (const actor of world.actors) this.addActor(actor);
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
    // Sidewalk slabs first, then asphalt. The same expanded rectangles are
    // used in bodyOnRoad(), including the ends where roads meet.
    for (const road of roads) {
      const r = roadRect(road, -2.5);
      pavementParts.push(surfaceGeometry(r, 0.1, -0.03, 1.8));
    }
    this.surfaces.pavement.push(
      mergedSurface(this.scene, pavementParts, 0xc1b9a5),
    );
    for (const road of roads) {
      const r = roadRect(road);
      roadParts.push(surfaceGeometry(r, 0.06, 0.055, 2.5));
      for (let n = road.min + 4; !road.parkingBay && n < road.max; n += 9) {
        const p =
          road.axis === "z" ? { x: road.fixed, z: n } : { x: n, z: road.fixed };
        const crossing = roads.some(
          (other) => other.axis !== road.axis && pointOnRoad(p, [other], -2),
        );
        if (crossing || road.sideStreet || road.parkingBay) continue;
        const width = road.axis === "z" ? 0.11 : 2.8,
          length = road.axis === "z" ? 2.8 : 0.11;
        markingParts.push(new THREE.BoxGeometry(width, 0.005, length)
          .translate(p.x, 0.1205, p.z));
      }
    }
    this.surfaces.road.push(mergedSurface(this.scene, roadParts, 0x484b49));
    if (markingParts.length)
      mergedSurface(this.scene, markingParts, 0xcec7ac).castShadow = true;
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
      const decorate = (meshes, colorMap, normalMap) => {
        colorMap.colorSpace = THREE.SRGBColorSpace;
        for (const texture of [colorMap, normalMap]) {
          texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
          texture.anisotropy = 8;
        }
        for (const mesh of meshes) {
          mesh.material.color.setHex(0xffffff);
          mesh.material.map = colorMap;
          mesh.material.normalMap = normalMap;
          mesh.material.normalScale.set(0.2, 0.2);
          mesh.material.roughness = 0.95;
          mesh.material.needsUpdate = true;
        }
      };
      if (this.disposed) {
        for (const texture of [road, roadNormal, pavement, pavementNormal])
          texture.dispose();
        return;
      }
      decorate(this.surfaces.road, road, roadNormal);
      decorate(this.surfaces.pavement, pavement, pavementNormal);
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
      if (site.kind === "place-sign" || site.kind === "barrier"
          || (site.kind === "building" && ["city", "vision"].includes(this.world.environment))) return;
      const group = new THREE.Group();
      group.position.set(site.x, 0.12, site.z);
      this.scene.add(group);
      const stall = site.kind === "market-stall";
      const fallback = box(
        group,
        site.width,
        site.height,
        site.length,
        stall ? 0x916c45 : [0xac9b84, 0x998775, 0xc1b198, 0x9e9c8c][i % 4],
      );
      const name = stall ? "market-produce" : names[i % names.length];
      const url = stall
        ? "/assets/models/props/market-produce.glb"
        : `/assets/models/buildings/${name}.glb`;
      asset(url)
        .then((gltf) => {
          if (this.disposed) return;
          const visual = fit(gltf.scene, site.width, site.length, site.height);
          group.add(visual);
          fallback.visible = false;
          this.status.loaded++;
          if (!stall && i % 5 === 0) {
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
    this.signals = [];
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
              part.material = part.material.clone();
              part.userData.ownedMaterial = true;
              part.material.color.setHex(
                actor.kind === "taxi"
                  ? 0xc8a04a
                  : trafficColors[
                      Math.floor(actor.phase * trafficColors.length)
                    ],
              );
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
        }
      })
      .catch(() => this.status.failed.push(actor.kind));
  }
  pedestrianGroundHeight(position) {
    if (this.world.environment === "vision") return 0.12;
    if (pointOnRoad(position, this.world.roads)) return 0.115;
    return pointOnRoad(position, this.world.roads, -2.5) ? 0.07 : -0.05;
  }
  sync(alpha) {
    const world = this.world;
    for (const barrier of world.statics.filter((a) => a.kind === "barrier")) {
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
    for (const actor of world.actors) {
      if (!this.roots.has(actor.id)) this.addActor(actor);
      const record = this.roots.get(actor.id),
        p = actor === world.player ? actor : interpolate(actor.previous ?? actor, actor, alpha);
      record.root.position.set(p.x,
        actor.type === "pedestrian" ? this.pedestrianGroundHeight(p) : 0.12, p.z);
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
      record.vehicleRig?.update(actor, world.sensors, alpha);
      if (detailed)
        for (const wheel of record.wheels) {
          wheel.part.quaternion.copy(wheel.quaternion);
          if (wheel.front) wheel.part.rotateY(actor.steer ?? 0);
          wheel.part.rotateX(actor.distance / wheel.radius);
        }
      if (record.pedestrianRig && detailed) record.pedestrianRig.update(actor, alpha);
    }
    if (this.routeRevision !== world.routeRevision) {
      this.routeRevision = world.routeRevision;
      this.route.geometry.dispose();
      this.route.geometry = new THREE.BufferGeometry().setFromPoints(
        world.player.path.map((p) => new THREE.Vector3(p.x, 0.14, p.z)),
      );
    }
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
    this.sun.position.set(player.position.x - 65, 100, player.position.z - 45);
    this.sun.target.position.copy(player.position);
    return player;
  }
  dispose() {
    this.disposed = true;
    this.scene.remove(this.egyptStreets.root);
    this.egyptStreets.dispose();
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
