import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { createCityTerrain, sampleCitySurface } from "../src/core/city-surfaces.js";
import { isDiagonalRoad, overlaps, pointOnRoad, roadFrame, roadRect } from "../src/core/geometry.js";
import { createUnifiedCity } from "../src/core/unified-city.js";
import {
  buildPuddlePolygon,
  createCinematicRoadTextures,
  createStreetSurfacesView,
  pointInsidePolygonWithClearance,
} from "../src/render/street-surfaces-view.js";

function sampleZonesFromCity(city) {
  return {
    hills: [
      { id: "citadel-rise", x: 180, z: -180, radiusX: 120, radiusZ: 110, heightM: 6.5 },
    ],
    waterPuddles: [
      { id: "puddle-tahrir-1", kind: "water", x: -210, z: -112, heading: Math.PI / 2, halfWidth: 2.8, halfLength: 4.6, depthM: 0.035 },
      { id: "puddle-corniche-2", kind: "water", x: -278, z: -40, heading: 0, halfWidth: 3.1, halfLength: 5.2, depthM: 0.04 },
    ],
    sandZones: [
      { id: "sand-citadel-1", kind: "sand", x: 300, z: -210, heading: 0, halfWidth: 4.4, halfLength: 9.0, depthM: 0.03 },
      { id: "sand-qasr-diag", kind: "sand", x: -340, z: 32, heading: 0.84, halfWidth: 4.2, halfLength: 8.5, depthM: 0.03 },
    ],
    cobbleZones: [
      { id: "cobble-khan-1", kind: "cobble", x: 124, z: 36, heading: 0, halfWidth: 5.2, halfLength: 14.0, depthM: 0.01 },
      { id: "cobble-bazaar-2", kind: "cobble", x: 212, z: -11, heading: -0.72, halfWidth: 4.6, halfLength: 12.0, depthM: 0.01 },
    ],
  };
}

function textureHasSpatialVariation(tex) {
  assert.ok(tex?.isDataTexture, `${tex?.name ?? "texture"} must be a THREE.DataTexture`);
  assert.equal(tex.image.width, 256);
  assert.equal(tex.image.height, 256);
  assert.equal(tex.wrapS, THREE.RepeatWrapping);
  assert.equal(tex.wrapT, THREE.RepeatWrapping);
  const data = tex.image.data;
  assert.ok(data instanceof Uint8Array && data.length === 256 * 256 * 4);
  let minR = 255;
  let maxR = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] < minR) minR = data[i];
    if (data[i] > maxR) maxR = data[i];
  }
  return maxR - minR >= 8;
}

function countRenderables(object) {
  let meshes = 0;
  object.traverse((node) => {
    if (node.isMesh || node.isInstancedMesh) meshes++;
  });
  return meshes;
}

function roadCarriagewayBody(road) {
  if (isDiagonalRoad(road)) {
    const f = roadFrame(road);
    return {
      x: (f.x1 + f.x2) * 0.5,
      z: (f.z1 + f.z2) * 0.5,
      width: road.width,
      length: f.length + road.width,
      heading: f.heading,
    };
  }
  const r = roadRect(road, 0);
  return {
    x: (r.minX + r.maxX) * 0.5,
    z: (r.minZ + r.maxZ) * 0.5,
    width: r.maxX - r.minX,
    length: r.maxZ - r.minZ,
    heading: 0,
  };
}

test("gracefully handles null or empty world.terrain with an inactive 0-mesh layer", () => {
  for (const terrain of [null, undefined, {}, { hills: [], waterPuddles: [], sandZones: [], cobbleZones: [] }]) {
    const scene = new THREE.Scene();
    const view = createStreetSurfacesView(scene, { environment: "metro", config: { cityVersion: 5 }, terrain });
    assert.equal(view.root.name, "street-surfaces-layer");
    assert.equal(view.fxGroup.name, "street-surface-fx");
    assert.equal(view.root.parent, scene);
    assert.equal(countRenderables(view.root), 0);

    const diag = view.diagnostics();
    assert.equal(diag.active, false);
    assert.equal(diag.drawCalls, 0);
    assert.equal(diag.waterPuddleCount, 0);
    assert.equal(diag.sandZoneCount, 0);
    assert.equal(diag.cobbleZoneCount, 0);
    assert.equal(diag.streetLampCount, 0);
    assert.equal(diag.streetTreeCount, 0);
    assert.equal(diag.furnitureCount, 0);

    view.update({ terrain }, 1 / 60);
    view.reset();
    view.dispose();
    view.dispose();
    assert.equal(view.root.parent, null);
  }
});

test("builds genuine 256x256 PBR DataTextures, Schlick-Fresnel puddle optics, 3D sand drifts, puddle halos, and <= 18 total draw calls", (t) => {
  const city = createUnifiedCity({ dense: true, rush: true, grand: true });
  const scene = new THREE.Scene();
  const world = {
    environment: "metro",
    config: { cityVersion: 5 },
    roads: city.roads,
    drivingRoads: city.drivingRoads,
    statics: city.statics,
    walkways: city.walkways,
    terrain: sampleZonesFromCity(city),
    terrainElevationAt: () => 0,
  };

  const view = createStreetSurfacesView(scene, world);
  t.after(() => view.dispose());

  const diag = view.diagnostics();
  assert.equal(diag.active, true);
  assert.equal(diag.waterPuddleCount, 2);
  assert.equal(diag.sandZoneCount, 2);
  assert.equal(diag.cobbleZoneCount, 2);
  assert.equal(diag.hasWaterBumpMap, true);
  assert.equal(diag.hasSandBumpMap, true);
  assert.equal(diag.hasCobbleBumpMap, true);
  assert.equal(diag.hasFresnelWaterShader, true);
  assert.equal(diag.billboardSprayAndDust, true);
  assert.ok(diag.waterRoughness <= 0.08, `waterRoughness (${diag.waterRoughness}) must be <= 0.08`);
  assert.ok(diag.waterBaseOpacity <= 0.60, `waterBaseOpacity (${diag.waterBaseOpacity}) must be <= 0.60`);
  assert.ok(
    diag.waterEnvMapIntensity <= 0.85,
    `waterEnvMapIntensity (${diag.waterEnvMapIntensity}) must be <= 0.85`,
  );
  assert.ok(diag.sandRoughness >= 0.90, `sandRoughness (${diag.sandRoughness}) must be >= 0.90`);

  const actualMeshCount = countRenderables(view.root);
  assert.equal(diag.drawCalls, actualMeshCount);
  assert.ok(diag.drawCalls <= 18, `total draw calls (${diag.drawCalls}) must be <= 18`);

  const waterMesh = view.root.getObjectByName("street-water-puddles");
  const haloMesh = view.root.getObjectByName("street-water-halos");
  const sandMesh = view.root.getObjectByName("street-sand-zones");
  const cobbleMesh = view.root.getObjectByName("street-cobble-zones");
  assert.ok(waterMesh?.isMesh && haloMesh?.isMesh && sandMesh?.isMesh && cobbleMesh?.isMesh);

  for (const mesh of [waterMesh, haloMesh, sandMesh, cobbleMesh]) {
    assert.equal(mesh.matrixAutoUpdate, false);
    assert.equal(mesh.receiveShadow, true);
    assert.equal(mesh.castShadow, false);
  }

  for (const [label, mat] of [
    ["water", waterMesh.material],
    ["sand", sandMesh.material],
    ["cobble", cobbleMesh.material],
  ]) {
    assert.equal(mat.map.colorSpace, THREE.SRGBColorSpace, `${label} albedo uses SRGBColorSpace`);
    assert.ok(textureHasSpatialVariation(mat.map), `${label} albedo has genuine procedural variation`);
    assert.ok(textureHasSpatialVariation(mat.bumpMap), `${label} bumpMap has genuine procedural relief`);
    assert.ok(textureHasSpatialVariation(mat.roughnessMap), `${label} roughnessMap has genuine variation`);
  }

  // Verify Schlick-Fresnel puddle optics & live wind micro-ripple uWaveTime shader hook
  assert.ok(waterMesh.material.metalness <= 0.1, "dielectric rainwater puddle avoids liquid-metal banding");
  assert.ok(waterMesh.material.opacity <= 0.60, "semi-transparent normal-incidence rainwater opacity <= 0.60");
  assert.ok(waterMesh.material.envMapIntensity <= 0.85, "overhead sky envMapIntensity capped <= 0.85");
  assert.equal(waterMesh.material.customProgramCacheKey(), "fresnel-puddle-v1");
  assert.equal(typeof waterMesh.material.onBeforeCompile, "function");

  const mockPuddleShader = {
    uniforms: {},
    vertexShader: THREE.ShaderLib.standard.vertexShader,
    fragmentShader: THREE.ShaderLib.standard.fragmentShader,
  };
  waterMesh.material.onBeforeCompile(mockPuddleShader);
  assert.ok(mockPuddleShader.uniforms.uWaveTime, "onBeforeCompile binds uWaveTime uniform");
  assert.equal(mockPuddleShader.uniforms.uWaveTime.value, 0);
  assert.match(mockPuddleShader.vertexShader, /varying vec2 vPuddleWorldUv;/);
  assert.match(mockPuddleShader.fragmentShader, /uniform float uWaveTime;/);
  assert.match(mockPuddleShader.fragmentShader, /pow\(\s*1\.0\s*-\s*puddleNdotV,\s*5\.0\s*\)/);
  assert.match(mockPuddleShader.fragmentShader, /mix\(\s*0\.56,\s*0\.88,\s*puddleFresnel\s*\)/);

  view.update(world, 0.05);
  assert.ok(
    Math.abs(mockPuddleShader.uniforms.uWaveTime.value - 0.05) < 1e-6,
    `uWaveTime advances on update() (got ${mockPuddleShader.uniforms.uWaveTime.value})`,
  );
  view.update(world, 0.05);
  assert.ok(
    Math.abs(mockPuddleShader.uniforms.uWaveTime.value - 0.10) < 1e-6,
    `uWaveTime accumulates across frames (got ${mockPuddleShader.uniforms.uWaveTime.value})`,
  );

  assert.equal(haloMesh.material.roughness, 0.82);
  assert.equal(haloMesh.material.polygonOffset, true);
  assert.equal(waterMesh.material.polygonOffset, true);

  // Verify wet-asphalt halo sits 1.5 mm below glossy puddle core on flat ground
  const coreY = waterMesh.geometry.attributes.position.getY(0);
  const haloY = haloMesh.geometry.attributes.position.getY(0);
  assert.ok(Math.abs((coreY - haloY) - 0.0015) < 1e-5, `halo sits 1.5 mm below puddle (${coreY} vs ${haloY})`);

  // Verify subdivided sand zones have raised 3D shoulder mounds (+0.015 m .. +0.035 m) and tapered 0.119 edges
  const sandPos = sandMesh.geometry.attributes.position;
  assert.equal(sandMesh.material.transparent, true, "sand zones alpha-feather smoothly onto asphalt");
  assert.equal(sandMesh.geometry.attributes.color.itemSize, 4);
  assert.equal(sandPos.count, 2 * 8 * 12 * 6);
  let minSandY = Infinity;
  let maxSandY = -Infinity;
  for (let i = 0; i < sandPos.count; i++) {
    const y = sandPos.getY(i);
    if (y < minSandY) minSandY = y;
    if (y > maxSandY) maxSandY = y;
  }
  assert.ok(Math.abs(minSandY - 0.119) < 1e-5, `sand perimeter tapers cleanly to 0.119 (${minSandY})`);
  const moundRise = maxSandY - 0.119;
  assert.ok(
    moundRise >= 0.015 && moundRise <= 0.036,
    `3D drifted sand mound rise (${moundRise.toFixed(4)} m) sits in +0.015..+0.035 m range`,
  );
});

test("places instanced Cairo lamps, trees, and furniture across Grand Metro v5 with zero road carriageway or building overlaps", (t) => {
  const city = createUnifiedCity({ dense: true, rush: true, grand: true });
  const scene = new THREE.Scene();
  const world = {
    environment: "metro",
    config: { cityVersion: 5 },
    roads: city.roads,
    drivingRoads: city.drivingRoads,
    statics: city.statics,
    walkways: city.walkways,
    terrain: sampleZonesFromCity(city),
    terrainElevationAt: () => 0,
  };

  const view = createStreetSurfacesView(scene, world);
  t.after(() => view.dispose());

  const diag = view.diagnostics();
  assert.ok(diag.streetLampCount >= 40, `expected >= 40 street lamps, got ${diag.streetLampCount}`);
  assert.ok(diag.streetTreeCount >= 40, `expected >= 40 street trees, got ${diag.streetTreeCount}`);
  assert.ok(diag.furnitureCount >= 25, `expected >= 25 furniture clusters, got ${diag.furnitureCount}`);

  const propMeshes = [];
  view.root.traverse((node) => {
    if (node.isInstancedMesh && node.parent === view.root) {
      propMeshes.push(node);
    }
  });
  assert.ok(propMeshes.length <= 5, `prop InstancedMesh draw calls (${propMeshes.length}) must be <= 5`);

  const lampHeads = view.root.getObjectByName("street-lamp-heads-instanced");
  assert.ok(lampHeads?.isInstancedMesh);
  assert.equal(lampHeads.material.color.getHex(), 0xffe6b8);
  assert.equal(lampHeads.material.emissive.getHex(), 0xffb85c);
  assert.equal(lampHeads.material.emissiveIntensity, 1.25);

  const buildings = city.statics.filter((s) => s.kind === "building");
  const allStatics = city.statics;
  const roadBodies = city.roads.map(roadCarriagewayBody);
  const mat4 = new THREE.Matrix4();
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const scl = new THREE.Vector3();
  const euler = new THREE.Euler();

  for (const mesh of propMeshes) {
    assert.ok(mesh.count > 0);
    mesh.geometry.computeBoundingBox();
    const bb = mesh.geometry.boundingBox;
    const geoWidth = bb.max.x - bb.min.x;
    const geoLength = bb.max.z - bb.min.z;

    for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, mat4);
      mat4.decompose(pos, quat, scl);
      euler.setFromQuaternion(quat, "YXZ");

      // Must never lie on any road carriageway (road.width / 2)
      assert.equal(
        pointOnRoad({ x: pos.x, z: pos.z }, city.roads, 0),
        false,
        `${mesh.name}[${i}] at (${pos.x.toFixed(2)}, ${pos.z.toFixed(2)}) overlaps road carriageway`,
      );

      const propBody = {
        x: pos.x,
        z: pos.z,
        width: geoWidth * scl.x,
        length: geoLength * scl.z,
        heading: euler.y,
      };
      for (const rb of roadBodies) {
        assert.equal(
          overlaps(propBody, rb, 0),
          false,
          `${mesh.name}[${i}] 3D footprint overlaps road carriageway`,
        );
      }

      for (const b of buildings) {
        assert.equal(
          overlaps(propBody, b, 0),
          false,
          `${mesh.name}[${i}] overlaps building ${b.id}`,
        );
      }

      for (const s of allStatics) {
        if (s.kind === "building") continue;
        assert.equal(
          overlaps(propBody, s, 0),
          false,
          `${mesh.name}[${i}] overlaps static ${s.kind} (${s.id})`,
        );
      }
    }
  }
});

test("spawns 3-part water FX (ripples + FBM spray billboards + wet exit tracks) and 3-part sand FX (carved 4-wheel ruts + FBM dust + ballistic grit), with 0 emissions when parked", (t) => {
  const scene = new THREE.Scene();
  const world = {
    environment: "metro",
    config: { cityVersion: 5 },
    roads: [],
    statics: [],
    terrain: {
      hills: [],
      waterPuddles: [{ id: "p1", kind: "water", x: 0, z: 0, heading: 0, halfWidth: 4, halfLength: 8, depthM: 0.04 }],
      sandZones: [{ id: "s1", kind: "sand", x: 0, z: 40, heading: 0, halfWidth: 4, halfLength: 10, depthM: 0.03 }],
      cobbleZones: [],
    },
    player: {
      id: "player",
      x: 0,
      y: 0,
      z: 0,
      heading: 0,
      speed: 0,
      width: 1.85,
      length: 4.2,
      surfaceKind: "water",
    },
    actors: [],
  };

  const view = createStreetSurfacesView(scene, world);
  t.after(() => view.dispose());

  const rippleMesh = view.fxGroup.getObjectByName("street-water-ripples");
  const waterMesh = view.fxGroup.getObjectByName("street-water-splashes");
  const wetTrackMesh = view.fxGroup.getObjectByName("street-wet-tire-tracks");
  const sandRutMesh = view.fxGroup.getObjectByName("street-sand-tire-ruts");
  const sandMesh = view.fxGroup.getObjectByName("street-sand-dust");
  const gritMesh = view.fxGroup.getObjectByName("street-sand-grit");

  assert.ok(rippleMesh?.isInstancedMesh && waterMesh?.isInstancedMesh);
  assert.ok(sandMesh?.isInstancedMesh && gritMesh?.isInstancedMesh);
  assert.ok(wetTrackMesh?.isMesh && sandRutMesh?.isMesh);

  // Verify PlaneGeometry FBM billboards + per-instance aFxAlpha (zero SphereGeometry ping-pong balls!)
  view.fxGroup.traverse((node) => {
    if (node.isMesh || node.isInstancedMesh) {
      assert.notEqual(node.geometry.type, "SphereGeometry", `${node.name} must not use SphereGeometry`);
    }
  });
  for (const [label, im, cap] of [
    ["ripples", rippleMesh, 72],
    ["waterSplashes", waterMesh, 140],
    ["sandDust", sandMesh, 120],
    ["sandGrit", gritMesh, 96],
  ]) {
    assert.equal(im.geometry.type, "PlaneGeometry", `${label} uses PlaneGeometry`);
    assert.equal(im.instanceMatrix.count, cap);
    assert.ok(im.geometry.attributes.aFxAlpha instanceof THREE.InstancedBufferAttribute);
    assert.equal(im.geometry.attributes.aFxAlpha.count, cap);
    assert.equal(im.material.depthWrite, false);
    assert.equal(im.material.toneMapped, true);

    const mockFxShader = {
      uniforms: {},
      vertexShader: THREE.ShaderLib.basic.vertexShader,
      fragmentShader: THREE.ShaderLib.basic.fragmentShader,
    };
    im.material.onBeforeCompile(mockFxShader);
    assert.match(mockFxShader.vertexShader, /attribute float aFxAlpha;/);
    assert.match(mockFxShader.fragmentShader, /diffuseColor\.a \*= clamp\( vFxAlpha, 0\.0, 1\.0 \);/);
  }

  // Verify 128x128 FX DataTextures have alpha === 0 at borders (and ripple center)
  for (const [label, tex, checkHollowCenter] of [
    ["ripple", rippleMesh.material.map, true],
    ["spray", waterMesh.material.map, false],
    ["dust", sandMesh.material.map, false],
  ]) {
    assert.equal(tex.image.width, 128, `${label} texture is 128x128`);
    assert.equal(tex.image.height, 128, `${label} texture is 128x128`);
    const d = tex.image.data;
    for (let i = 0; i < 128; i++) {
      assert.equal(d[(0 * 128 + i) * 4 + 3], 0, `${label} top border alpha === 0`);
      assert.equal(d[(127 * 128 + i) * 4 + 3], 0, `${label} bottom border alpha === 0`);
      assert.equal(d[(i * 128 + 0) * 4 + 3], 0, `${label} left border alpha === 0`);
      assert.equal(d[(i * 128 + 127) * 4 + 3], 0, `${label} right border alpha === 0`);
    }
    if (checkHollowCenter) {
      assert.equal(d[(64 * 128 + 64) * 4 + 3], 0, "ripple center alpha === 0");
    }
  }

  assert.equal(waterMesh.material.color.getHex(), 0xffffff);
  assert.equal(waterMesh.material.side, THREE.DoubleSide);
  assert.equal(sandMesh.material.color.getHex(), 0xffffff);
  assert.equal(sandMesh.material.side, THREE.DoubleSide);

  // Negative control 1: parked (speed === 0) on water -> 0 ripples, 0 splashes, 0 wet tracks
  view.update(world, 1 / 60);
  assert.equal(view.diagnostics().activeWaterRipples, 0);
  assert.equal(view.diagnostics().activeWaterSplashes, 0);
  assert.equal(view.diagnostics().activeWetTrackSegments, 0);
  assert.equal(waterMesh.count, 0);
  assert.equal(rippleMesh.count, 0);

  // Negative control 2: parked (speed === 0) on sand -> 0 ruts, 0 dust, 0 grit
  world.player.surfaceKind = "sand";
  world.player.speed = 0;
  view.update(world, 1 / 60);
  assert.equal(view.diagnostics().activeSandRutSegments, 0);
  assert.equal(view.diagnostics().activeSandDust, 0);
  assert.equal(view.diagnostics().activeSandGrit, 0);
  assert.equal(sandMesh.count, 0);
  assert.equal(gritMesh.count, 0);

  // Positive 1: driving through "water" at 12 m/s spawns concentric ripples + FBM spray billboards oriented to camera
  const testCam = new THREE.PerspectiveCamera(55, 16 / 9, 0.1, 500);
  testCam.position.set(6, 4.5, -9);
  testCam.lookAt(0, 0.5, 0);
  testCam.updateMatrixWorld();

  world.player.surfaceKind = "water";
  world.player.speed = 12;
  view.update(world, 1 / 60, testCam);
  const waterDiag = view.diagnostics();
  assert.ok(waterDiag.activeWaterRipples >= 4, `expected >= 4 water ripples, got ${waterDiag.activeWaterRipples}`);
  assert.ok(waterDiag.activeWaterSplashes >= 4, `expected >= 4 water spray puffs, got ${waterDiag.activeWaterSplashes}`);
  assert.equal(rippleMesh.count, waterDiag.activeWaterRipples);
  assert.equal(waterMesh.count, waterDiag.activeWaterSplashes);

  // Verify spray billboard normal (+Z rotated by instance quaternion) faces parallel to camera +Z
  const mat4 = new THREE.Matrix4();
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const scl = new THREE.Vector3();
  waterMesh.getMatrixAt(0, mat4);
  mat4.decompose(pos, quat, scl);
  const billboardNormal = new THREE.Vector3(0, 0, 1).applyQuaternion(quat);
  const camNormal = new THREE.Vector3(0, 0, 1).applyQuaternion(testCam.quaternion);
  assert.ok(
    billboardNormal.distanceTo(camNormal) < 1e-4,
    "water spray billboard faces camera.quaternion cleanly",
  );

  // Verify ripple expands from ~0.32 m toward ~1.24 m while alpha stays subtle (<= 0.42) and fades to 0
  rippleMesh.getMatrixAt(0, mat4);
  mat4.decompose(pos, quat, scl);
  const initialRippleScale = scl.x;
  const initialRippleAlpha = rippleMesh.geometry.attributes.aFxAlpha.getX(0);
  assert.ok(initialRippleScale >= 0.26 && initialRippleScale < 0.65, `initial ripple scale ${initialRippleScale}`);
  assert.ok(initialRippleAlpha > 0.14 && initialRippleAlpha <= 0.42, `initial ripple alpha ${initialRippleAlpha}`);

  // Positive 2: driving out of the puddle onto dry asphalt stamps dark wet tire tracks immediately & tapers over 15 m
  world.player.surfaceKind = "asphalt";
  world.player.z += 12 * (1 / 60);
  view.update(world, 1 / 60, testCam);
  assert.ok(
    view.diagnostics().activeWetTrackSegments >= 4,
    "first frame exiting puddle onto dry asphalt immediately stamps 4-wheel wet tire tracks",
  );
  for (let step = 0; step < 7; step++) {
    world.player.z += 12 * (1 / 60);
    view.update(world, 1 / 60, testCam);
  }
  const wetExitDiag = view.diagnostics();
  assert.ok(
    wetExitDiag.activeWetTrackSegments >= 8,
    `exiting puddle onto asphalt stamps connected 4-wheel wet tire tracks (got ${wetExitDiag.activeWetTrackSegments})`,
  );
  const wetY = wetTrackMesh.geometry.attributes.position.getY(0);
  assert.ok(Math.abs(wetY - 0.1192) < 1e-4, `wet tire track sits at y=0.1192 (got ${wetY})`);

  // Stop car and verify ballistic gravity brings spray down and ripples fade out over 0.85 s
  world.player.speed = 0;
  let peakY = 0;
  let maxRippleScale = initialRippleScale;
  for (let step = 0; step < 60; step++) {
    for (let i = 0; i < waterMesh.count; i++) {
      waterMesh.getMatrixAt(i, mat4);
      pos.setFromMatrixPosition(mat4);
      if (pos.y > peakY) peakY = pos.y;
    }
    if (rippleMesh.count > 0) {
      rippleMesh.getMatrixAt(0, mat4);
      mat4.decompose(pos, quat, scl);
      if (scl.x > maxRippleScale) maxRippleScale = scl.x;
    }
    view.update(world, 1 / 60);
  }
  assert.ok(peakY > 0.25, `water spray followed upward rooster-tail arc (peakY=${peakY.toFixed(3)})`);
  assert.ok(maxRippleScale > 0.92 && maxRippleScale < 1.35, `water ripple expanded to realistic tire-wake scale (max=${maxRippleScale.toFixed(2)})`);
  assert.equal(view.diagnostics().activeWaterSplashes, 0, "water spray expired cleanly under gravity");
  assert.equal(view.diagnostics().activeWaterRipples, 0, "water ripples faded out cleanly after 0.85 s");

  // Resume driving > 16 m further on dry asphalt: wetTireRemainingM decays to 0 and stamping stops cleanly
  world.player.speed = 12;
  let prevWetSegs = view.diagnostics().activeWetTrackSegments;
  for (let step = 0; step < 90; step++) {
    world.player.z += 12 * (1 / 60);
    view.update(world, 1 / 60, testCam);
    prevWetSegs = view.diagnostics().activeWetTrackSegments;
  }
  world.player.z += 1.0;
  view.update(world, 1 / 60, testCam);
  assert.equal(
    view.diagnostics().activeWetTrackSegments,
    prevWetSegs,
    "wet tire track stamping stops once 15 m of water carry has dried off",
  );

  // Positive 3: driving through "sand" at 12 m/s stamps persistent 4-wheel carved ruts + FBM dust + ballistic sand grit
  world.player.z = 36;
  world.player.surfaceKind = "sand";
  world.player.speed = 12;
  world.player.steerAngle = 0.28;
  for (let step = 0; step < 6; step++) {
    world.player.z += 12 * (1 / 60);
    view.update(world, 1 / 60, testCam);
  }
  const sandDiag = view.diagnostics();
  assert.ok(sandDiag.activeSandRutSegments >= 8, `expected >= 8 carved sand rut segments, got ${sandDiag.activeSandRutSegments}`);
  assert.ok(sandDiag.activeSandDust >= 2, `expected >= 2 FBM sand dust billows, got ${sandDiag.activeSandDust}`);
  assert.ok(sandDiag.activeSandGrit >= 2, `expected >= 2 ballistic sand grit flecks, got ${sandDiag.activeSandGrit}`);
  assert.equal(sandMesh.count, sandDiag.activeSandDust);
  assert.equal(gritMesh.count, sandDiag.activeSandGrit);

  const rutY = sandRutMesh.geometry.attributes.position.getY(0);
  assert.ok(Math.abs(rutY - (0.119 + 0.022)) < 1e-4, `sand rut sits at SAND_BASE_Y + 0.022 (got ${rutY})`);

  // Stop car in sand: ballistic grit lands within <= 0.45 s while carved 4-wheel sand ruts remain persistent!
  const carvedRutsBeforeStop = sandDiag.activeSandRutSegments;
  world.player.speed = 0;
  for (let step = 0; step < 30; step++) {
    view.update(world, 1 / 60);
  }
  assert.equal(view.diagnostics().activeSandGrit, 0, "ballistic sand grit lands within <= 0.45 s");
  assert.equal(
    view.diagnostics().activeSandRutSegments,
    carvedRutsBeforeStop,
    "carved 4-wheel sand ruts persist in the sand after stopping",
  );

  // Distant vehicle (> 55 m) does not emit FX, while nearby patrol (<= 55 m) does
  view.reset();
  assert.equal(view.diagnostics().activeSandDust, 0);
  assert.equal(view.diagnostics().activeSandRutSegments, 0);
  assert.equal(view.diagnostics().activeWetTrackSegments, 0);
  world.player.speed = 0;
  world.player.surfaceKind = "asphalt";
  const farCar = { id: "far-car", type: "vehicle", x: 90, z: 36, speed: 14, surfaceKind: "water" };
  world.actors = [farCar];
  view.update(world, 1 / 60);
  assert.equal(view.diagnostics().activeWaterSplashes, 0, "distant car > 55 m emits 0 splashes");

  const nearPatrol = { id: "patrol-near", pursuitRole: "police", x: 18, z: 36, speed: 14, surfaceKind: "water" };
  world.actors = [nearPatrol];
  view.update(world, 1 / 60);
  assert.ok(view.diagnostics().activeWaterSplashes >= 4, "nearby patrol within 55 m emits water splashes");
  assert.ok(view.diagnostics().activeWaterRipples >= 4, "nearby patrol within 55 m emits water ripples");

  // Per-wheel boundary accuracy: straddling sand edge so ONLY right 2 wheels sit on sand stamps 2 sand ruts (NOT 4!)
  view.reset();
  world.actors = [];
  delete world.player.surfaceKind; // use live per-wheel terrain sampling!
  // s1 spans x in [-4, +4], z in [30, 50]; placing player at x = -4.0 heading 0 puts FR/RR at x = -3.17 (inside sand) and FL/RL at x = -4.83 (outside on dry asphalt!)
  world.player.x = -4.0;
  world.player.z = 35.0;
  world.player.heading = 0;
  world.player.speed = 9.0;
  view.update(world, 1 / 60, testCam);
  assert.equal(
    view.diagnostics().activeSandRutSegments,
    2,
    "straddling sand boundary stamps ruts ONLY for the 2 wheels inside sand (got 2, not 4)",
  );

  // Organic puddle footprint accuracy: physics sampleSurfaceAt AND visual splashes/ripples share ONE exact organic contour!
  view.reset();
  world.player.x = 3.92;
  world.player.z = 7.85;
  world.player.heading = 0.65;
  world.player.speed = 12.0;
  view.update(world, 1 / 60, testCam);
  const compiledTerrain = createCityTerrain([], world.terrain);
  assert.equal(sampleCitySurface(compiledTerrain, 3.92, 7.85).surfaceKind, "asphalt", "physics sampleCitySurface matches organic puddle contour (dry outside visible puddle)");
  assert.equal(view.diagnostics().activeWaterSplashes, 0, "wheels outside visible organic puddle contour emit 0 splashes");
  assert.equal(view.diagnostics().activeWaterRipples, 0, "wheels outside visible organic puddle contour emit 0 ripples");
});

test("terrainElevationAt lifts puddles, sand drifts, cobble meshes, street lamps, and splash/dust origins on sloped hills", (t) => {
  const makeHillWorld = (elevFn) => ({
    environment: "metro",
    config: { cityVersion: 5 },
    roads: [
      { id: "hill-avenue", axis: "x", fixed: 0, min: -60, max: 60, width: 12, zone: "avenue", marking: "center" },
    ],
    statics: [],
    terrain: {
      hills: [{ id: "h1", x: 0, z: 0, radiusX: 80, radiusZ: 80, heightM: 5 }],
      waterPuddles: [{ id: "wp", kind: "water", x: -15, z: 0, heading: Math.PI / 2, halfWidth: 2.5, halfLength: 4, depthM: 0.03 }],
      sandZones: [{ id: "sz", kind: "sand", x: 10, z: 0, heading: Math.PI / 2, halfWidth: 3.5, halfLength: 6, depthM: 0.03 }],
      cobbleZones: [{ id: "cz", kind: "cobble", x: 32, z: 0, heading: Math.PI / 2, halfWidth: 4.0, halfLength: 7, depthM: 0.01 }],
    },
    terrainElevationAt: elevFn,
    player: {
      id: "player",
      x: -15,
      y: 0,
      z: 0,
      heading: Math.PI / 2,
      speed: 12,
      width: 1.85,
      length: 4.2,
      surfaceKind: "water",
    },
  });

  const slopeFn = (x, z) => Math.max(0, 3.2 + 0.03 * x + 0.015 * z);

  const flatScene = new THREE.Scene();
  const elevatedScene = new THREE.Scene();
  const flatWorld = makeHillWorld(() => 0);
  const elevatedWorld = makeHillWorld(slopeFn);

  const flatView = createStreetSurfacesView(flatScene, flatWorld);
  const elevView = createStreetSurfacesView(elevatedScene, elevatedWorld);
  t.after(() => {
    flatView.dispose();
    elevView.dispose();
  });

  const avgY = (mesh) => {
    const pos = mesh.geometry.attributes.position;
    let sum = 0;
    for (let i = 0; i < pos.count; i++) sum += pos.getY(i);
    return sum / pos.count;
  };

  // 1. Puddles, halos, sand drifts, and cobble meshes are lifted by sloped terrainElevationAt
  for (const [name, expectedCenterX] of [
    ["street-water-puddles", -15],
    ["street-water-halos", -15],
    ["street-sand-zones", 10],
    ["street-cobble-zones", 32],
  ]) {
    const flatY = avgY(flatView.root.getObjectByName(name));
    const raisedY = avgY(elevView.root.getObjectByName(name));
    const expectedLift = slopeFn(expectedCenterX, 0);
    assert.ok(
      Math.abs((raisedY - flatY) - expectedLift) < 0.08,
      `${name} lifted by ~${expectedLift.toFixed(2)} m (got ${(raisedY - flatY).toFixed(3)} m)`,
    );
  }

  // 2. Street lamps & lamp heads are lifted to y = 0.07 + terrainElevationAt(x, z)
  const lampMesh = elevView.root.getObjectByName("street-lamps-instanced");
  const headMesh = elevView.root.getObjectByName("street-lamp-heads-instanced");
  assert.ok(lampMesh?.count > 0 && headMesh?.count === lampMesh.count);
  const mat4 = new THREE.Matrix4();
  const p = new THREE.Vector3();
  for (let i = 0; i < lampMesh.count; i++) {
    lampMesh.getMatrixAt(i, mat4);
    p.setFromMatrixPosition(mat4);
    const expectedY = 0.07 + slopeFn(p.x, p.z);
    assert.ok(
      Math.abs(p.y - expectedY) < 1e-5,
      `street lamp[${i}] y (${p.y}) matches 0.07 + elev (${expectedY})`,
    );
  }

  // 3. Water splash & ripple origins are lifted to match sloped terrain height
  flatView.update(flatWorld, 1 / 60);
  elevView.update(elevatedWorld, 1 / 60);
  const flatSplash = flatView.fxGroup.getObjectByName("street-water-splashes");
  const elevSplash = elevView.fxGroup.getObjectByName("street-water-splashes");
  assert.ok(flatSplash.count > 0 && elevSplash.count > 0);
  flatSplash.getMatrixAt(0, mat4);
  const flatSplashY = new THREE.Vector3().setFromMatrixPosition(mat4).y;
  elevSplash.getMatrixAt(0, mat4);
  const elevSplashPos = new THREE.Vector3().setFromMatrixPosition(mat4);
  assert.ok(
    elevSplashPos.y - flatSplashY > 2.4,
    `splash origin lifted onto hill (${elevSplashPos.y.toFixed(2)} vs ${flatSplashY.toFixed(2)})`,
  );

  // 4. Sand dust & carved sand rut origins are also lifted to match sloped terrain height
  flatWorld.player.x = 10;
  flatWorld.player.surfaceKind = "sand";
  elevatedWorld.player.x = 10;
  elevatedWorld.player.surfaceKind = "sand";
  flatView.update(flatWorld, 1 / 60);
  elevView.update(elevatedWorld, 1 / 60);
  const flatDust = flatView.fxGroup.getObjectByName("street-sand-dust");
  const elevDust = elevView.fxGroup.getObjectByName("street-sand-dust");
  assert.ok(flatDust.count > 0 && elevDust.count > 0);
  flatDust.getMatrixAt(0, mat4);
  const flatDustY = new THREE.Vector3().setFromMatrixPosition(mat4).y;
  elevDust.getMatrixAt(0, mat4);
  const elevDustPos = new THREE.Vector3().setFromMatrixPosition(mat4);
  assert.ok(
    elevDustPos.y - flatDustY > 3.1,
    `sand dust origin lifted onto hill (${elevDustPos.y.toFixed(2)} vs ${flatDustY.toFixed(2)})`,
  );

  const flatRutY = flatView.fxGroup.getObjectByName("street-sand-tire-ruts").geometry.attributes.position.getY(0);
  const elevRutY = elevView.fxGroup.getObjectByName("street-sand-tire-ruts").geometry.attributes.position.getY(0);
  assert.ok(elevRutY - flatRutY > 3.1, `carved sand rut lifted onto hill (${elevRutY.toFixed(2)} vs ${flatRutY.toFixed(2)})`);
});

test("dispose() disposes every geometry, material, DataTexture, and InstancedMesh exactly once with 0 leaks", () => {
  const city = createUnifiedCity({ dense: true, rush: true, grand: true });
  const scene = new THREE.Scene();
  const world = {
    environment: "metro",
    config: { cityVersion: 5 },
    roads: city.roads,
    drivingRoads: city.drivingRoads,
    statics: city.statics,
    walkways: city.walkways,
    terrain: sampleZonesFromCity(city),
    terrainElevationAt: () => 0,
  };

  const view = createStreetSurfacesView(scene, world);

  const geometries = new Set();
  const materials = new Set();
  const textures = new Set();
  const instancedMeshes = new Set();

  view.root.traverse((node) => {
    if (node.isMesh || node.isInstancedMesh) {
      geometries.add(node.geometry);
      const mats = Array.isArray(node.material) ? node.material : [node.material];
      for (const m of mats) {
        materials.add(m);
        for (const key of ["map", "bumpMap", "roughnessMap", "normalMap"]) {
          if (m[key]) textures.add(m[key]);
        }
      }
    }
    if (node.isInstancedMesh) {
      instancedMeshes.add(node);
    }
  });

  assert.equal(geometries.size, 17, "17 unique geometries across static surfaces, props, lamp pools, and 6 FX layers");
  assert.equal(materials.size, 17, "17 unique materials across static surfaces, props, lamp pools, and 6 FX layers");
  assert.equal(
    textures.size,
    20,
    "4 PBR surface sets (12) + 1 lamp-pool + 4 FX DataTextures + 1 wet-track + 2 sand-rut = 20 DataTextures",
  );
  assert.equal(
    instancedMeshes.size,
    10,
    "5 prop InstancedMeshes + 1 lamp-pool InstancedMesh + 4 FX InstancedMeshes = 10",
  );

  const disposeCounts = new Map();
  const watch = (res) => {
    disposeCounts.set(res, 0);
    res.addEventListener("dispose", () => {
      disposeCounts.set(res, (disposeCounts.get(res) ?? 0) + 1);
    });
  };

  for (const g of geometries) watch(g);
  for (const m of materials) watch(m);
  for (const t of textures) watch(t);
  for (const im of instancedMeshes) watch(im);

  view.dispose();
  view.dispose(); // Idempotency check

  assert.equal(view.root.parent, null);
  for (const [res, count] of disposeCounts.entries()) {
    assert.equal(count, 1, `resource ${res.name || res.type || res.uuid} disposed ${count} times (expected 1)`);
  }
});

test("createCinematicRoadTextures() generates 512x512 neutral dark bitumen road and recessed-mortar Cairo sidewalk tile PBR sets with clean dispose()", () => {
  const pack = createCinematicRoadTextures();
  assert.equal(pack.textures.length, 6);

  for (const [label, set] of [
    ["road", pack.road],
    ["pavement", pack.pavement],
  ]) {
    for (const key of ["map", "bumpMap", "roughnessMap"]) {
      const tex = set[key];
      assert.ok(tex?.isDataTexture, `${label}.${key} must be a THREE.DataTexture`);
      assert.equal(tex.image.width, 512);
      assert.equal(tex.image.height, 512);
      assert.equal(tex.wrapS, THREE.RepeatWrapping);
      assert.equal(tex.wrapT, THREE.RepeatWrapping);
      assert.equal(tex.anisotropy, 8);
      assert.equal(tex.generateMipmaps, true);
      assert.equal(tex.image.data.length, 512 * 512 * 4);
    }
    assert.equal(set.map.colorSpace, THREE.SRGBColorSpace, `${label}.map must use SRGBColorSpace`);
  }

  // 1. Road albedo: dark neutral charcoal-bitumen (mean RGB < 0.24, |meanB - meanR| < 0.03 — zero blue tint!)
  const roadData = pack.road.map.image.data;
  const roadRough = pack.road.roughnessMap.image.data;
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  const pxCount = 512 * 512;
  let rutRoughSum = 0;
  let rutCount = 0;
  let shoulderRoughSum = 0;
  let shoulderCount = 0;

  for (let y = 0; y < 512; y++) {
    for (let x = 0; x < 512; x++) {
      const idx = (y * 512 + x) * 4;
      sumR += roadData[idx] / 255;
      sumG += roadData[idx + 1] / 255;
      sumB += roadData[idx + 2] / 255;
      const uNorm = x / 512;
      if (Math.abs(uNorm - 0.27) < 0.03 || Math.abs(uNorm - 0.73) < 0.03) {
        rutRoughSum += roadRough[idx] / 255;
        rutCount++;
      } else if (uNorm < 0.08 || uNorm > 0.92) {
        shoulderRoughSum += roadRough[idx] / 255;
        shoulderCount++;
      }
    }
  }

  const meanR = sumR / pxCount;
  const meanG = sumG / pxCount;
  const meanB = sumB / pxCount;
  const meanRoadRgb = (meanR + meanG + meanB) / 3;
  assert.ok(meanRoadRgb > 0.08 && meanRoadRgb < 0.24, `road mean RGB (${meanRoadRgb.toFixed(4)}) must be < 0.24`);
  assert.ok(
    Math.abs(meanB - meanR) < 0.03,
    `road |meanB - meanR| (${Math.abs(meanB - meanR).toFixed(4)}) must be < 0.03 (no blue tint)`,
  );
  assert.ok(
    rutRoughSum / rutCount < shoulderRoughSum / shoulderCount - 0.12,
    "polished longitudinal tire ruts have lower roughness than coarse aggregate shoulders",
  );

  // 2. Pavement: muted stone albedo (0.32..0.56) & recessed 4x4 mortar joints in bumpMap
  const paveData = pack.pavement.map.image.data;
  const paveBump = pack.pavement.bumpMap.image.data;
  let pSumR = 0;
  let pSumG = 0;
  let pSumB = 0;
  for (let i = 0; i < paveData.length; i += 4) {
    pSumR += paveData[i] / 255;
    pSumG += paveData[i + 1] / 255;
    pSumB += paveData[i + 2] / 255;
  }
  const meanPaveRgb = (pSumR + pSumG + pSumB) / (3 * pxCount);
  assert.ok(
    meanPaveRgb >= 0.32 && meanPaveRgb <= 0.56,
    `pavement mean RGB (${meanPaveRgb.toFixed(4)}) must lie in muted stone range 0.32..0.56`,
  );

  let jointBumpSum = 0;
  let jointSamples = 0;
  let centerBumpSum = 0;
  let centerSamples = 0;
  for (let tileRow = 0; tileRow < 4; tileRow++) {
    for (let tileCol = 0; tileCol < 4; tileCol++) {
      const jx = tileCol * 128;
      const jy = tileRow * 128 + 64;
      jointBumpSum += paveBump[(jy * 512 + jx) * 4] / 255;
      jointSamples++;

      const cx = tileCol * 128 + 64;
      const cy = tileRow * 128 + 64;
      centerBumpSum += paveBump[(cy * 512 + cx) * 4] / 255;
      centerSamples++;
    }
  }
  const meanJointBump = jointBumpSum / jointSamples;
  const meanCenterBump = centerBumpSum / centerSamples;
  assert.ok(
    meanJointBump < 0.28 && meanCenterBump > 0.72 && meanJointBump < meanCenterBump,
    `pavement mortar joints (${meanJointBump.toFixed(3)}) must be deeply recessed below tile centers (${meanCenterBump.toFixed(3)})`,
  );

  // 3. Idempotent dispose() disposes all 6 textures exactly once
  const counts = new Map();
  for (const tex of pack.textures) {
    counts.set(tex, 0);
    tex.addEventListener("dispose", () => {
      counts.set(tex, (counts.get(tex) ?? 0) + 1);
    });
  }
  pack.dispose();
  pack.dispose();
  for (const [tex, c] of counts.entries()) {
    assert.equal(c, 1, `${tex.name} disposed ${c} times (expected 1)`);
  }
});

test("builds batched 3D cast-iron manholes & cracks, dusk streetlamp light pools, muted Cairo foliage, and clean sensor hiding within <= 18 draw calls", (t) => {
  const city = createUnifiedCity({ dense: true, rush: true, grand: true });
  const scene = new THREE.Scene();
  const zones = sampleZonesFromCity(city);
  const slopeFn = (x, z) => Math.max(0, 1.4 + 0.002 * x - 0.0015 * z);
  const world = {
    environment: "metro",
    config: { cityVersion: 5 },
    roads: city.roads,
    drivingRoads: city.drivingRoads,
    statics: city.statics,
    walkways: city.walkways,
    terrain: zones,
    terrainElevationAt: slopeFn,
  };

  const view = createStreetSurfacesView(scene, world);
  t.after(() => view.dispose());

  assert.equal(view.group, view.root);
  const diag = view.diagnostics();
  assert.ok(diag.drawCalls <= 18, `drawCalls (${diag.drawCalls}) must stay <= 18`);
  assert.ok(diag.manholeCount >= 35, `expected >= 35 manholes, got ${diag.manholeCount}`);
  assert.equal(diag.lampPoolCount, diag.propCounts.lamps);
  assert.equal(diag.lampPoolCount, diag.streetLampCount);
  assert.ok(diag.lampPoolCount >= 40);

  // 1. Batched 3D manholes & asphalt cracks mesh
  const manholeMesh = view.root.getObjectByName("street-manholes-and-cracks");
  assert.ok(manholeMesh?.isMesh, "street-manholes-and-cracks single static Mesh exists");
  assert.equal(manholeMesh.material.vertexColors, true);
  assert.equal(manholeMesh.material.roughness, 0.58);
  assert.equal(manholeMesh.material.metalness, 0.28);
  assert.equal(manholeMesh.material.polygonOffset, true);

  const centers = view.root.userData.manholeCenters;
  assert.equal(centers.length, diag.manholeCount);
  for (const c of centers) {
    for (const zObj of [...zones.waterPuddles, ...zones.sandZones]) {
      const cos = Math.cos(zObj.heading ?? 0);
      const sin = Math.sin(zObj.heading ?? 0);
      const dx = c.x - zObj.x;
      const dz = c.z - zObj.z;
      const lx = dx * cos - dz * sin;
      const lz = dx * sin + dz * cos;
      assert.equal(
        Math.abs(lx) <= zObj.halfWidth && Math.abs(lz) <= zObj.halfLength,
        false,
        `manhole at (${c.x.toFixed(1)}, ${c.z.toFixed(1)}) must skip ${zObj.id} core`,
      );
    }
  }

  // Verify manhole/crack vertices conform to sloped terrainElevationAt
  const mPos = manholeMesh.geometry.attributes.position;
  for (let i = 0; i < mPos.count; i += 29) {
    const vx = mPos.getX(i);
    const vy = mPos.getY(i);
    const vz = mPos.getZ(i);
    const expectedMin = 0.1185 + slopeFn(vx, vz);
    const expectedMax = 0.125 + slopeFn(vx, vz);
    assert.ok(
      vy >= expectedMin - 1e-4 && vy <= expectedMax + 1e-4,
      `manhole/crack vertex y (${vy.toFixed(4)}) conforms to 0.1188 + elev at (${vx.toFixed(1)}, ${vz.toFixed(1)})`,
    );
  }

  // 2. Dusk warm streetlamp light pools & sensor clean-mode hiding for all fxGroup layers
  const lampPools = view.root.getObjectByName("street-lamp-light-pools");
  assert.ok(lampPools?.isInstancedMesh);
  assert.equal(view.lampPoolsMesh, lampPools);
  assert.equal(lampPools.count, diag.propCounts.lamps);
  assert.equal(lampPools.material.blending, THREE.AdditiveBlending);
  assert.equal(lampPools.material.depthWrite, false);
  assert.equal(lampPools.material.toneMapped, false);
  assert.equal(lampPools.material.opacity, 0.34);
  assert.equal(lampPools.material.color.getHex(), 0xffc270);
  assert.equal(lampPools.material.map.image.width, 64);
  assert.equal(lampPools.material.map.image.height, 64);
  assert.equal(lampPools.material.map.image.data[3], 0, "corner texel alpha tapers cleanly to 0");

  for (const fxChild of [
    view.lampPoolsMesh,
    view.waterRipples,
    view.waterSplashes,
    view.wetTireTracks,
    view.sandTireRuts,
    view.sandDust,
    view.sandGrit,
  ]) {
    assert.equal(fxChild.parent, view.fxGroup, `${fxChild.name} lives inside fxGroup`);
  }

  view.setSensorCleanMode(true);
  assert.equal(view.fxGroup.visible, false);
  assert.equal(lampPools.visible, false);
  assert.equal(manholeMesh.visible, true, "physical manholes remain visible to AI camera");
  assert.equal(view.root.getObjectByName("street-water-puddles").visible, true);
  assert.equal(view.root.getObjectByName("street-sand-zones").visible, true);
  view.setSensorCleanMode(false);
  assert.equal(view.fxGroup.visible, true);
  assert.equal(lampPools.visible, true);

  // 3. Muted Cairo foliage colors (no toy-like bright greens)
  const canopyMesh = view.root.getObjectByName("street-trees-canopies-instanced");
  const cColors = canopyMesh.geometry.attributes.color;
  let maxGreen = 0;
  for (let i = 0; i < cColors.count; i++) {
    const r = cColors.getX(i);
    const g = cColors.getY(i);
    if (g > r && g > maxGreen) maxGreen = g;
  }
  assert.ok(maxGreen < 0.36, `muted Cairo olive/ficus canopy max green (${maxGreen.toFixed(3)}) stays subdued`);
});

test("pointInsidePolygonWithClearance enforces exact Euclidean clearance to all 20 rendered puddle polygon edges", () => {
  const terrain = createCityTerrain();
  const puddleIdx = terrain.waterPuddles.findIndex((p) => p.id === "university-central-puddle");
  assert.ok(puddleIdx >= 0, "university-central-puddle exists in city terrain");
  const puddle = terrain.waterPuddles[puddleIdx];
  const poly = buildPuddlePolygon(puddle, puddleIdx, 0.92, 20);
  const fullPoly = buildPuddlePolygon(puddle, puddleIdx, 1.0, 20);
  assert.equal(poly.length, 40);
  assert.equal(fullPoly.length, 40);

  // QA counterexample: (-37.15879, 88.48828) is only ~0.517 m from the 1.0 polygon edge (and outside/closer on the 0.92 production polygon)
  assert.equal(
    pointInsidePolygonWithClearance(-37.15879, 88.48828, poly, 0.54),
    false,
    "production 0.92 polygon rejects (-37.15879, 88.48828) for 0.54 m ripple extent",
  );
  assert.equal(
    pointInsidePolygonWithClearance(-37.15879, 88.48828, fullPoly, 0.54),
    false,
    "outer 1.0 polygon also rejects (-37.15879, 88.48828) whose Euclidean edge distance (~0.517 m) < 0.54 m",
  );
  // Deep puddle center has multi-meter clearance
  assert.equal(pointInsidePolygonWithClearance(puddle.x, puddle.z, poly, 0.72), true);

  // Exhaustive check across 2,000 grid samples: every accepted center is >= clearanceM from all 20 polygon edges
  const clearanceM = 0.64;
  let accepted = 0;
  for (let gx = -25; gx <= 25; gx++) {
    for (let gz = -25; gz <= 25; gz++) {
      const sx = puddle.x + gx * 0.35;
      const sz = puddle.z + gz * 0.35;
      if (!pointInsidePolygonWithClearance(sx, sz, poly, clearanceM)) continue;
      accepted++;
      for (let i = 0, j = 19; i < 20; j = i++) {
        const ax = poly[j * 2];
        const az = poly[j * 2 + 1];
        const bx = poly[i * 2];
        const bz = poly[i * 2 + 1];
        const abx = bx - ax;
        const abz = bz - az;
        const lenSq = abx * abx + abz * abz;
        const t = Math.max(0, Math.min(1, ((sx - ax) * abx + (sz - az) * abz) / lenSq));
        const dist = Math.hypot(sx - (ax + abx * t), sz - (az + abz * t));
        assert.ok(
          dist >= clearanceM - 1e-9,
          `accepted point (${sx.toFixed(2)}, ${sz.toFixed(2)}) had edge distance ${dist.toFixed(4)} < ${clearanceM}`,
        );
      }
    }
  }
  assert.ok(accepted >= 40, `expected >= 40 valid interior puddle points, got ${accepted}`);
});
