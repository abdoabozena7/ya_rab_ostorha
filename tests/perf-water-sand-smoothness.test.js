import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";
import * as THREE from "three";
import {
  createCityTerrain,
  pointInShapedSurfaceZone,
  pointInWaterPuddle,
  sampleCitySurface,
} from "../src/core/city-surfaces.js";
import { createUnifiedCity } from "../src/core/unified-city.js";
import {
  buildPuddlePolygon,
  createStreetSurfacesView,
  resolveZoneSurfaceAt,
} from "../src/render/street-surfaces-view.js";

function bruteForceReferenceSurfaceAt(terrain, x, z) {
  if (!terrain || !Number.isFinite(x) || !Number.isFinite(z)) return "asphalt";
  const puddles = terrain.waterPuddles ?? [];
  for (let i = 0; i < puddles.length; i++) {
    if (pointInWaterPuddle(x, z, puddles[i], i, 0)) return "water";
  }
  if (Array.isArray(terrain.sandZones)) {
    for (let i = 0; i < terrain.sandZones.length; i++) {
      if (pointInShapedSurfaceZone(x, z, terrain.sandZones[i])) return "sand";
    }
  }
  if (Array.isArray(terrain.cobbleZones)) {
    for (let i = 0; i < terrain.cobbleZones.length; i++) {
      if (pointInShapedSurfaceZone(x, z, terrain.cobbleZones[i])) return "cobble";
    }
  }
  return "asphalt";
}

test("32m spatial surface cell index matches brute-force surface oracle 100% across Grand Metro zones, cell seams, and alternate-terrain fallback", (t) => {
  const terrain = createCityTerrain();
  // Add an overlapping water-over-sand-over-cobble fixture right across a 32m cell seam (x = 64, z = 64)
  const customTerrain = {
    hills: terrain.hills,
    waterPuddles: [
      ...terrain.waterPuddles,
      { id: "seam-puddle", kind: "water", x: 64.0, z: 64.0, heading: 0.42, halfWidth: 3.4, halfLength: 6.2 },
    ],
    sandZones: [
      ...terrain.sandZones,
      { id: "seam-sand", kind: "sand", x: 64.0, z: 64.0, heading: -0.35, halfWidth: 5.5, halfLength: 11.0 },
    ],
    cobbleZones: [
      ...terrain.cobbleZones,
      { id: "seam-cobble", kind: "cobble", x: 64.0, z: 64.0, heading: 0.78, halfWidth: 7.0, halfLength: 14.0 },
    ],
  };

  const scene = new THREE.Scene();
  const world = {
    environment: "metro",
    config: { cityVersion: 5 },
    roads: [],
    statics: [],
    terrain: customTerrain,
  };
  const view = createStreetSurfacesView(scene, world);
  t.after(() => view.dispose());

  let totalSamples = 0;
  const counts = { water: 0, sand: 0, cobble: 0, asphalt: 0 };

  const allZones = [
    ...customTerrain.waterPuddles,
    ...customTerrain.sandZones,
    ...customTerrain.cobbleZones,
  ];
  for (const zObj of allZones) {
    const spanX = Math.max(zObj.halfWidth ?? 4, zObj.halfLength ?? 8) + 2;
    for (let ox = -spanX; ox <= spanX; ox += 1.75) {
      for (let oz = -spanX; oz <= spanX; oz += 1.75) {
        const sx = zObj.x + ox;
        const sz = zObj.z + oz;
        const expected = bruteForceReferenceSurfaceAt(customTerrain, sx, sz);
        const cachedFallback = resolveZoneSurfaceAt(customTerrain, sx, sz);
        const indexed = view.resolveSurfaceAt(sx, sz, world);
        assert.equal(cachedFallback, expected, `resolveZoneSurfaceAt mismatch at (${sx}, ${sz})`);
        assert.equal(indexed, expected, `spatial cell index mismatch at (${sx}, ${sz})`);
        counts[indexed]++;
        totalSamples++;
      }
    }
  }

  // Explicitly probe exact 32m cell boundaries around (64, 64)
  for (const eps of [-1e-4, 0, 1e-4]) {
    for (const d of [-6, -2, 0, 2, 6]) {
      const sx = 64 + eps;
      const sz = 64 + d;
      const expected = bruteForceReferenceSurfaceAt(customTerrain, sx, sz);
      assert.equal(view.resolveSurfaceAt(sx, sz, world), expected);
      totalSamples++;
    }
  }

  assert.ok(totalSamples >= 5000, `expected >= 5000 parity samples, ran ${totalSamples}`);
  assert.ok(counts.water >= 50 && counts.sand >= 200 && counts.cobble >= 200 && counts.asphalt >= 500);

  // Verify fallback when update() receives a different liveWorld.terrain instance
  const otherWorld = {
    environment: "metro",
    config: { cityVersion: 5 },
    terrain: {
      hills: [],
      waterPuddles: [{ id: "alt-puddle", kind: "water", x: 12, z: -18, heading: 0, halfWidth: 3.5, halfLength: 6.0 }],
      sandZones: [],
      cobbleZones: [],
    },
    player: { id: "player", x: 12, z: -18, heading: 0, speed: 11, width: 1.85, length: 4.2 },
    actors: [],
  };
  assert.equal(view.resolveSurfaceAt(12, -18, otherWorld), "water");
  view.update(otherWorld, 1 / 60);
  assert.ok(view.diagnostics().activeWaterSplashes >= 4, "alternate liveWorld.terrain falls back cleanly and emits splashes");

  // Verify in-place mutation & append on customTerrain invalidate stale cell cache immediately
  const mutSand = customTerrain.sandZones[0];
  const prevSx = mutSand.x;
  const prevSz = mutSand.z;
  mutSand.x = -388;
  mutSand.z = -388;
  assert.equal(view.resolveSurfaceAt(-388, -388, world), bruteForceReferenceSurfaceAt(customTerrain, -388, -388));
  assert.equal(view.resolveSurfaceAt(prevSx, prevSz, world), bruteForceReferenceSurfaceAt(customTerrain, prevSx, prevSz));
  customTerrain.sandZones.push({ id: "appended-view-sand", x: 388, z: -388, heading: 0, halfWidth: 5, halfLength: 8 });
  assert.equal(view.resolveSurfaceAt(388, -388, world), "sand");

  // Verify synthetic puddle explicit organicSeed is preserved at build time AND invalidates on organicSeed mutation!
  const seedWorld = {
    environment: "metro",
    config: { cityVersion: 5 },
    roads: [],
    statics: [],
    terrain: {
      hills: [],
      waterPuddles: [{ id: "syn-seed-puddle", kind: "water", x: 50, z: 50, heading: 0, halfWidth: 10, halfLength: 10, organicSeed: 12345 }],
      sandZones: [],
      cobbleZones: [],
    },
    player: { id: "player", x: 50, z: 50, heading: 0, speed: 0, width: 1.85, length: 4.2 },
    actors: [],
  };
  const seedView = createStreetSurfacesView(new THREE.Scene(), seedWorld);
  t.after(() => seedView.dispose());
  for (let deg = 0; deg < 360; deg += 15) {
    const ang = (deg * Math.PI) / 180;
    const px = 50 + Math.sin(ang) * 9.0;
    const pz = 50 + Math.cos(ang) * 9.0;
    assert.equal(seedView.resolveSurfaceAt(px, pz, seedWorld), bruteForceReferenceSurfaceAt(seedWorld.terrain, px, pz));
  }
  seedWorld.terrain.waterPuddles[0].organicSeed = 987654;
  for (let deg = 0; deg < 360; deg += 15) {
    const ang = (deg * Math.PI) / 180;
    const px = 50 + Math.sin(ang) * 9.0;
    const pz = 50 + Math.cos(ang) * 9.0;
    assert.equal(seedView.resolveSurfaceAt(px, pz, seedWorld), bruteForceReferenceSurfaceAt(seedWorld.terrain, px, pz));
  }
  // Also verify rotating a compiled puddle keeps streetSurfaces.resolveSurfaceAt & sampleCitySurface 100% synchronized
  const compiledRotTerrain = createCityTerrain([], {
    waterPuddles: [{ id: "compiled-rot-puddle", x: 0, z: 0, heading: 0, halfWidth: 2.5, halfLength: 12.0, organicSeed: 123 }],
    sandZones: [],
    cobbleZones: [],
  });
  const rotWorld = {
    environment: "metro",
    config: { cityVersion: 5 },
    roads: [],
    statics: [],
    terrain: compiledRotTerrain,
    player: { id: "player", x: 0, z: 0, heading: 0, speed: 0, width: 1.85, length: 4.2 },
    actors: [],
  };
  const rotView = createStreetSurfacesView(new THREE.Scene(), rotWorld);
  t.after(() => rotView.dispose());
  assert.equal(rotView.resolveSurfaceAt(0, 8, rotWorld), "water");
  assert.equal(rotView.resolveSurfaceAt(8, 0, rotWorld), "asphalt");
  compiledRotTerrain.waterPuddles[0].heading = Math.PI / 2;
  assert.equal(rotView.resolveSurfaceAt(8, 0, rotWorld), "water");
  assert.equal(rotView.resolveSurfaceAt(0, 8, rotWorld), "asphalt");
  compiledRotTerrain.waterPuddles[0].id = "renamed-compiled-rot-puddle";
  assert.equal(compiledRotTerrain.waterPuddles[0].organicSeed, 123);
  assert.equal(rotView.resolveSurfaceAt(8, 0, rotWorld), "water");

  // Verify default Tahrir sand ellipse corner (-96.77, -115.27) agrees across physics and streetSurfaces.resolveSurfaceAt
  const defaultWorld = {
    environment: "metro",
    config: { cityVersion: 5 },
    roads: [],
    statics: [],
    terrain,
    player: { id: "player", x: 0, z: 0, heading: 0, speed: 0, width: 1.85, length: 4.2 },
    actors: [],
  };
  const defaultView = createStreetSurfacesView(new THREE.Scene(), defaultWorld);
  t.after(() => defaultView.dispose());
  assert.equal(sampleCitySurface(terrain, -96.77, -115.27).surfaceKind, "asphalt");
  assert.equal(defaultView.resolveSurfaceAt(-96.77, -115.27, defaultWorld), "asphalt");

  // Verify explicit organicSeed is used in BOTH buildPuddlePolygon AND the rendered street-water-puddles THREE.Mesh geometry, AND rotating the puddle updates the rendered water mesh!
  const polySeed123 = buildPuddlePolygon({ id: "same-id", x: 0, z: 0, heading: 0, halfWidth: 3, halfLength: 12, organicSeed: 123 }, 0, 1.0, 20);
  const polyDefault = buildPuddlePolygon({ id: "same-id", x: 0, z: 0, heading: 0, halfWidth: 3, halfLength: 12 }, 0, 1.0, 20);
  assert.notDeepEqual(polySeed123, polyDefault, "buildPuddlePolygon honors explicit organicSeed");

  const meshWorldA = {
    environment: "metro",
    config: { cityVersion: 5 },
    roads: [],
    statics: [],
    terrain: createCityTerrain([], {
      waterPuddles: [{ id: "mesh-seed-test", x: 0, z: 0, heading: 0, halfWidth: 2.5, halfLength: 12.0, organicSeed: 123 }],
      sandZones: [],
      cobbleZones: [],
    }),
    player: { id: "player", x: 0, z: 0, heading: 0, speed: 0, width: 1.85, length: 4.2 },
    actors: [],
  };
  const meshWorldB = {
    environment: "metro",
    config: { cityVersion: 5 },
    roads: [],
    statics: [],
    terrain: createCityTerrain([], {
      waterPuddles: [{ id: "mesh-seed-test", x: 0, z: 0, heading: 0, halfWidth: 2.5, halfLength: 12.0 }],
      sandZones: [],
      cobbleZones: [],
    }),
    player: { id: "player", x: 0, z: 0, heading: 0, speed: 0, width: 1.85, length: 4.2 },
    actors: [],
  };
  const meshViewA = createStreetSurfacesView(new THREE.Scene(), meshWorldA);
  const meshViewB = createStreetSurfacesView(new THREE.Scene(), meshWorldB);
  t.after(() => {
    meshViewA.dispose();
    meshViewB.dispose();
  });
  const waterMeshA = meshViewA.root.getObjectByName("street-water-puddles");
  const waterMeshB = meshViewB.root.getObjectByName("street-water-puddles");
  assert.notDeepEqual(
    waterMeshA.geometry.attributes.position.array,
    waterMeshB.geometry.attributes.position.array,
    "rendered water mesh vertices honor explicit organicSeed",
  );
  // Initial heading = 0 -> elongated along Z (maxZ > 9, maxX < 4)
  waterMeshA.geometry.computeBoundingBox();
  assert.ok(waterMeshA.geometry.boundingBox.max.z > 9 && waterMeshA.geometry.boundingBox.max.x < 4);
  // Rotate compiled puddle in place by 90 deg and call update -> rendered water mesh updates to X-elongated (maxX > 9, maxZ < 4)!
  meshWorldA.terrain.waterPuddles[0].heading = Math.PI / 2;
  meshViewA.update(meshWorldA, 1 / 60);
  waterMeshA.geometry.computeBoundingBox();
  assert.ok(
    waterMeshA.geometry.boundingBox.max.x > 9 && waterMeshA.geometry.boundingBox.max.z < 4,
    `rotated puddle water mesh boundingBox must update to X-elongated, got max=(${waterMeshA.geometry.boundingBox.max.x}, ${waterMeshA.geometry.boundingBox.max.z})`,
  );

  // Verify (1) { width: 20, length: 20 } puddle agrees across physics, view lookup & mesh;
  // (2) exact unshaped edge (52, 0) on halfWidth=2 raw sand at x=50 is "asphalt" in resolveZoneSurfaceAt & view;
  // (3) ellipse sand AND cobble meshes keep 100% of vertices inside (lx/hw)^2 + (lz/hl)^2 <= 1 and rebuild on rotation;
  // (4) initially empty terrain lazily activates when runtime zones are pushed!
  assert.equal(resolveZoneSurfaceAt({ waterPuddles: [], sandZones: [{ id: "raw-edge", x: 50, z: 0, halfWidth: 2, halfLength: 4 }], cobbleZones: [] }, 52, 0), "asphalt");
  assert.equal(resolveZoneSurfaceAt({ waterPuddles: [{ id: "wl", x: 0, z: 0, width: 20, length: 20 }], sandZones: [], cobbleZones: [] }, 6.5, 0), "water");

  const shapeMeshWorld = {
    environment: "metro",
    config: { cityVersion: 5 },
    roads: [],
    statics: [],
    terrain: createCityTerrain([], {
      waterPuddles: [],
      sandZones: [{ id: "ell-sand", shape: "ellipse", x: 0, z: 0, heading: 0, halfWidth: 8, halfLength: 10 }],
      cobbleZones: [{ id: "ell-cobble", shape: "ellipse", x: 40, z: 0, heading: 0, halfWidth: 4, halfLength: 12 }],
    }),
    player: { id: "player", x: 0, z: 0, heading: 0, speed: 0, width: 1.85, length: 4.2 },
    actors: [],
  };
  const shapeMeshView = createStreetSurfacesView(new THREE.Scene(), shapeMeshWorld);
  t.after(() => shapeMeshView.dispose());
  assert.equal(sampleCitySurface(shapeMeshWorld.terrain, -7.23, -8.33).surfaceKind, "asphalt");
  assert.equal(shapeMeshView.resolveSurfaceAt(-7.23, -8.33, shapeMeshWorld), "asphalt");
  const sandMesh = shapeMeshView.root.getObjectByName("street-sand-zones");
  const cobbleMesh = shapeMeshView.root.getObjectByName("street-cobble-zones");
  const sPos = sandMesh.geometry.attributes.position;
  for (let i = 0; i < sPos.count; i++) {
    const nx = sPos.getX(i) / 8;
    const nz = sPos.getZ(i) / 10;
    assert.ok(nx * nx + nz * nz <= 1.0001, `ellipse sand mesh vertex (${sPos.getX(i)}, ${sPos.getZ(i)}) must stay inside ellipse`);
  }
  const cPos = cobbleMesh.geometry.attributes.position;
  for (let i = 0; i < cPos.count; i++) {
    const nx = (cPos.getX(i) - 40) / 4;
    const nz = cPos.getZ(i) / 12;
    assert.ok(nx * nx + nz * nz <= 1.0001, `ellipse cobble mesh vertex (${cPos.getX(i)}, ${cPos.getZ(i)}) must stay inside ellipse`);
  }
  // Rotate both sand and cobble zones by 90 deg and verify both rendered 3D meshes rebuild!
  shapeMeshWorld.terrain.sandZones[0].halfWidth = 3;
  shapeMeshWorld.terrain.sandZones[0].halfLength = 14;
  shapeMeshWorld.terrain.sandZones[0].heading = Math.PI / 2;
  shapeMeshWorld.terrain.cobbleZones[0].heading = Math.PI / 2;
  shapeMeshView.update(shapeMeshWorld, 1 / 60);
  sandMesh.geometry.computeBoundingBox();
  cobbleMesh.geometry.computeBoundingBox();
  assert.ok(sandMesh.geometry.boundingBox.max.x > 11 && sandMesh.geometry.boundingBox.max.z < 4, "rotated sand mesh rebuilt");
  assert.ok(cobbleMesh.geometry.boundingBox.max.x > 49 && cobbleMesh.geometry.boundingBox.max.z < 5, "rotated cobble mesh rebuilt");

  // Empty-to-populated runtime terrain promotion
  const emptyTerrainWorld = {
    environment: "metro",
    config: { cityVersion: 5 },
    roads: [],
    statics: [],
    terrain: { hills: [], waterPuddles: [], sandZones: [], cobbleZones: [] },
    player: { id: "player", x: 0, z: 0, heading: 0, speed: 12, width: 1.85, length: 4.2 },
    actors: [],
  };
  const emptyView = createStreetSurfacesView(new THREE.Scene(), emptyTerrainWorld);
  t.after(() => emptyView.dispose());
  assert.equal(emptyView.diagnostics().active, false);
  emptyTerrainWorld.terrain.sandZones.push({ id: "late-sand", shape: "strip", x: 0, z: 0, heading: 0, halfWidth: 6, halfLength: 14 });
  emptyView.update(emptyTerrainWorld, 1 / 60);
  assert.equal(emptyView.diagnostics().active, true, "initially empty view lazily activates when zones are added");
  assert.equal(emptyView.resolveSurfaceAt(0, 0, emptyTerrainWorld), "sand");
  assert.ok(emptyView.root.getObjectByName("street-sand-zones"), "late sand mesh mounted");
  assert.ok(emptyView.diagnostics().activeSandDust > 0, "late sand zone emits sand dust");
});

test("preserves exact wheel water/sand FX parity and isolates wetPosStore/sandPosStore across simultaneous vehicles without scratch cross-contamination", (t) => {
  const scene = new THREE.Scene();
  const world = {
    environment: "metro",
    config: { cityVersion: 5 },
    roads: [],
    statics: [],
    terrain: {
      hills: [],
      waterPuddles: [
        { id: "p-left", kind: "water", x: -10, z: 0, heading: 0, halfWidth: 4.5, halfLength: 7.0, depthM: 0.04 },
        { id: "p-right", kind: "water", x: 10, z: 0, heading: 0, halfWidth: 4.5, halfLength: 7.0, depthM: 0.04 },
      ],
      sandZones: [
        { id: "s-left", kind: "sand", x: -10, z: 32, heading: 0, halfWidth: 4.5, halfLength: 10.0, depthM: 0.03 },
        { id: "s-right", kind: "sand", x: 10, z: 32, heading: 0, halfWidth: 4.5, halfLength: 10.0, depthM: 0.03 },
      ],
      cobbleZones: [],
    },
    player: { id: "car-left", type: "vehicle", x: -10, z: -2, heading: 0, speed: 12, width: 1.85, length: 4.2 },
    actors: [
      { id: "car-right", type: "vehicle", x: 10, z: -2, heading: 0, speed: 12, width: 1.85, length: 4.2 },
    ],
  };

  const cam = new THREE.PerspectiveCamera(58, 16 / 9, 0.1, 500);
  cam.position.set(0, 8, -16);
  cam.lookAt(0, 0, 10);
  cam.updateMatrixWorld();

  const view = createStreetSurfacesView(scene, world);
  t.after(() => view.dispose());

  // 1. Drive both vehicles through their parallel water puddles, then out onto dry asphalt (z = 6..15)
  let peakWaterRipples = 0;
  let peakWaterSplashes = 0;
  for (let step = 0; step < 85; step++) {
    world.player.z += 12 * (1 / 60);
    world.actors[0].z += 12 * (1 / 60);
    view.update(world, 1 / 60, cam);
    const stepDiag = view.diagnostics();
    if (stepDiag.activeWaterRipples > peakWaterRipples) peakWaterRipples = stepDiag.activeWaterRipples;
    if (stepDiag.activeWaterSplashes > peakWaterSplashes) peakWaterSplashes = stepDiag.activeWaterSplashes;
  }
  const afterWaterDiag = view.diagnostics();
  assert.ok(peakWaterRipples >= 8, `emits expanding concentric water ripples (peak=${peakWaterRipples})`);
  assert.ok(peakWaterSplashes >= 12, `emits FBM water spray billboards while in puddle (peak=${peakWaterSplashes})`);
  assert.ok(afterWaterDiag.activeWetTrackSegments >= 16, "both cars stamp wet exit tire tracks onto dry asphalt");

  // Verify NO wet tire track quad stretches 20m across the street between car-left (x=-10) and car-right (x=+10)!
  const wetPos = view.wetTireTracks.geometry.attributes.position;
  const wetDrawVerts = view.wetTireTracks.geometry.drawRange.count;
  assert.ok(wetDrawVerts >= 16 * 6);
  for (let v = 0; v < wetDrawVerts; v += 6) {
    let minX = Infinity;
    let maxX = -Infinity;
    for (let k = 0; k < 6; k++) {
      const vx = wetPos.getX(v + k);
      if (vx < minX) minX = vx;
      if (vx > maxX) maxX = vx;
    }
    assert.ok(
      maxX - minX < 1.2,
      `wet tire track quad at vertex ${v} spanned ${(maxX - minX).toFixed(2)} m (wheelScratch leak!)`,
    );
  }

  // 2. Drive both vehicles into their parallel sand zones (z = 26..38)
  world.player.z = 25;
  world.actors[0].z = 25;
  for (let step = 0; step < 50; step++) {
    world.player.z += 12 * (1 / 60);
    world.actors[0].z += 12 * (1 / 60);
    view.update(world, 1 / 60, cam);
  }
  const afterSandDiag = view.diagnostics();
  assert.ok(afterSandDiag.activeSandRutSegments >= 24, "both cars carve persistent 4-wheel sand ruts");
  assert.ok(afterSandDiag.activeSandDust > 0, "both cars emit FBM sand dust clouds");
  assert.ok(afterSandDiag.activeSandGrit > 0, "both cars emit ballistic sand grit");

  const rutPos = view.sandTireRuts.geometry.attributes.position;
  const rutDrawVerts = view.sandTireRuts.geometry.drawRange.count;
  for (let v = 0; v < rutDrawVerts; v += 6) {
    let minX = Infinity;
    let maxX = -Infinity;
    for (let k = 0; k < 6; k++) {
      const vx = rutPos.getX(v + k);
      if (vx < minX) minX = vx;
      if (vx > maxX) maxX = vx;
    }
    assert.ok(
      maxX - minX < 1.2,
      `sand rut quad at vertex ${v} spanned ${(maxX - minX).toFixed(2)} m (wheelScratch leak!)`,
    );
  }
});

test("zero idle GPU upload churn on dry asphalt, bounded active updateRanges, and < 3.5m streamed prop skip", (t) => {
  const city = createUnifiedCity({ dense: true, rush: true, grand: true });
  const terrain = createCityTerrain(city.roads);
  const scene = new THREE.Scene();
  const world = {
    environment: "metro",
    config: { cityVersion: 5 },
    roads: city.roads,
    drivingRoads: city.drivingRoads,
    statics: city.statics,
    walkways: city.walkways,
    terrain,
    player: {
      id: "player",
      type: "vehicle",
      x: 0,
      z: 0,
      heading: 0,
      speed: 14,
      width: 1.85,
      length: 4.2,
      surfaceKind: "asphalt",
    },
    actors: [],
  };

  const cam = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 600);
  cam.position.set(0, 6, -12);
  cam.lookAt(0, 1, 0);
  cam.updateMatrixWorld();

  const view = createStreetSurfacesView(scene, world);
  t.after(() => view.dispose());

  // Prime streamed prop cull at initial camera pose
  view.update(world, 1 / 60, cam);

  const fxMeshes = [
    view.waterRipples,
    view.waterSplashes,
    view.sandDust,
    view.sandGrit,
  ];
  const initialMatrixVersions = fxMeshes.map((m) => m.instanceMatrix.version);
  const initialAlphaVersions = fxMeshes.map((m) => m.geometry.attributes.aFxAlpha.version);
  const lampMesh = view.root.getObjectByName("street-lamps-instanced");
  assert.ok(lampMesh?.isInstancedMesh);
  const lampVersionBeforeSmallMoves = lampMesh.instanceMatrix.version;

  // Step 30 frames on dry asphalt while nudging camera < 3.5 m total (2.4 m total)
  for (let frame = 0; frame < 30; frame++) {
    world.player.z += 0.08;
    cam.position.z += 0.08;
    view.update(world, 1 / 60, cam);
  }

  for (let i = 0; i < fxMeshes.length; i++) {
    assert.equal(
      fxMeshes[i].instanceMatrix.version,
      initialMatrixVersions[i],
      `${fxMeshes[i].name}.instanceMatrix.version must NOT increment on dry frames`,
    );
    assert.equal(
      fxMeshes[i].geometry.attributes.aFxAlpha.version,
      initialAlphaVersions[i],
      `${fxMeshes[i].name} aFxAlpha.version must NOT increment on dry frames`,
    );
  }
  assert.equal(
    lampMesh.instanceMatrix.version,
    lampVersionBeforeSmallMoves,
    "streamed static props must skip re-filtering/uploading when camera moved < 3.5 m",
  );

  // Trigger water splash & ripple burst, verify bounded updateRange, then let particles expire and verify idle churn returns to 0
  world.player.surfaceKind = "water";
  view.update(world, 1 / 60, cam);
  assert.ok(view.waterSplashes.count > 0 && view.waterSplashes.count < 40);
  assert.ok(view.waterSplashes.instanceMatrix.version > initialMatrixVersions[1]);
  if (view.waterSplashes.instanceMatrix.updateRange) {
    assert.equal(
      view.waterSplashes.instanceMatrix.updateRange.count,
      view.waterSplashes.count * 16,
      "uploads only active splash instance slice",
    );
  }

  // Stop vehicle on dry asphalt until all ripples & splashes expire
  world.player.surfaceKind = "asphalt";
  world.player.speed = 0;
  for (let frame = 0; frame < 70; frame++) {
    view.update(world, 1 / 60, cam);
  }
  assert.equal(view.waterRipples.count, 0);
  assert.equal(view.waterSplashes.count, 0);

  const settledVersions = fxMeshes.map((m) => m.instanceMatrix.version);
  for (let frame = 0; frame < 30; frame++) {
    view.update(world, 1 / 60, cam);
  }
  for (let i = 0; i < fxMeshes.length; i++) {
    assert.equal(
      fxMeshes[i].instanceMatrix.version,
      settledVersions[i],
      `${fxMeshes[i].name}.instanceMatrix.version stays flat after FX expire back to 0`,
    );
  }

  // Verify Three.js r160+ clearUpdateRanges / addUpdateRange path when present on attribute
  const recordedRanges = [];
  let clearCalls = 0;
  view.sandDust.instanceMatrix.clearUpdateRanges = () => {
    clearCalls++;
    recordedRanges.length = 0;
  };
  view.sandDust.instanceMatrix.addUpdateRange = (start, count) => {
    recordedRanges.push({ start, count });
  };
  world.player.surfaceKind = "sand";
  world.player.speed = 13;
  view.update(world, 1 / 60, cam);
  assert.ok(clearCalls >= 1 && recordedRanges.length === 1);
  assert.deepEqual(recordedRanges[0], {
    start: 0,
    count: view.sandDust.count * 16,
  });
  delete view.sandDust.instanceMatrix.clearUpdateRanges;
  delete view.sandDust.instanceMatrix.addUpdateRange;

  // Verify stale actorStates pruning (> 160 transient actors over > 600 steps) runs cleanly with zero errors
  world.player.surfaceKind = "asphalt";
  world.player.speed = 0;
  world.actors = Array.from({ length: 180 }, (_, idx) => ({
    id: `transient-car-${idx}`,
    type: "vehicle",
    x: 4,
    z: 4,
    heading: 0,
    speed: 8,
    surfaceKind: "asphalt",
  }));
  view.update(world, 1 / 60, cam);
  world.actors = [];
  for (let frame = 0; frame < 720; frame++) {
    view.update(world, 1 / 60, cam);
  }
});

test("multi-vehicle water+sand stress benchmark: 120 frames with 24 nearby vehicles averages < 0.75 ms per streetSurfaces.update()", (t) => {
  const scene = new THREE.Scene();
  // Place realistic water puddles and sand zones inside the 55m nearby FX radius around player (0, 0)
  const terrain = {
    hills: [],
    waterPuddles: [
      { id: "bench-puddle-0", kind: "water", x: -16, z: -10, heading: 0, halfWidth: 5.0, halfLength: 18.0, depthM: 0.04 },
      { id: "bench-puddle-1", kind: "water", x: -6, z: -10, heading: 0.15, halfWidth: 5.0, halfLength: 18.0, depthM: 0.04 },
      { id: "bench-puddle-2", kind: "water", x: 6, z: -10, heading: -0.15, halfWidth: 5.0, halfLength: 18.0, depthM: 0.04 },
    ],
    sandZones: [
      { id: "bench-sand-0", kind: "sand", x: -16, z: 16, heading: 0, halfWidth: 5.5, halfLength: 20.0, depthM: 0.04 },
      { id: "bench-sand-1", kind: "sand", x: 0, z: 16, heading: 0.2, halfWidth: 5.5, halfLength: 20.0, depthM: 0.04 },
      { id: "bench-sand-2", kind: "sand", x: 16, z: 16, heading: -0.2, halfWidth: 5.5, halfLength: 20.0, depthM: 0.04 },
    ],
    cobbleZones: [
      { id: "bench-cobble-0", kind: "cobble", x: 0, z: -34, heading: Math.PI / 2, halfWidth: 5.0, halfLength: 22.0, depthM: 0.015 },
    ],
  };

  const vehicles = [];
  // 12 vehicles driving back-and-forth through water puddles & wet exit asphalt
  for (let i = 0; i < 12; i++) {
    const laneX = i < 4 ? -16 : i < 8 ? -6 : 6;
    const slotZ = -22 + (i % 4) * 6.0;
    vehicles.push({
      id: `water-car-${i}`,
      type: "vehicle",
      x: laneX + ((i % 2) - 0.5) * 1.4,
      z: slotZ,
      heading: 0,
      speed: 11.5 + (i % 3) * 1.5,
      steerAngle: 0.08,
      width: 1.85,
      length: 4.3,
    });
  }
  // 12 vehicles driving through sand zones carving 4-wheel ruts + dust + grit
  for (let i = 0; i < 12; i++) {
    const laneX = i < 4 ? -16 : i < 8 ? 0 : 16;
    const slotZ = 4 + (i % 4) * 5.5;
    vehicles.push({
      id: `sand-car-${i}`,
      type: "vehicle",
      x: laneX + ((i % 2) - 0.5) * 1.5,
      z: slotZ,
      heading: 0,
      speed: 12.0 + (i % 3) * 1.2,
      steerAngle: 0.22,
      gtaSlipMps: 2.4,
      width: 1.85,
      length: 4.3,
    });
  }

  const player = vehicles[0];
  const world = {
    environment: "metro",
    config: { cityVersion: 5 },
    roads: [],
    statics: [],
    terrain,
    player,
    actors: vehicles,
  };

  const cam = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 500);
  cam.position.set(0, 14, -28);
  cam.lookAt(0, 0, 4);
  cam.updateMatrixWorld();

  const view = createStreetSurfacesView(scene, world);
  t.after(() => view.dispose());

  const dt = 1 / 60;
  // Short 10-frame warmup so V8 compiles hot paths cleanly before timed 120-frame window
  for (let w = 0; w < 10; w++) {
    view.update(world, dt, cam);
  }
  view.reset();

  let avgMs = Infinity;
  for (let trial = 0; trial < 3; trial++) {
    view.reset();
    let totalUpdateMs = 0;
    for (let frame = 0; frame < 120; frame++) {
      for (let i = 0; i < 12; i++) {
        const vc = vehicles[i];
        vc.z += vc.speed * dt;
        if (vc.z > 8) vc.z = -24;
      }
      for (let i = 12; i < 24; i++) {
        const vc = vehicles[i];
        vc.z += vc.speed * dt;
        if (vc.z > 32) vc.z = 2;
      }
      player.x = 0;
      player.z = 0;
      cam.position.x = Math.sin(frame * 0.05) * 4;
      cam.position.z = -28 + Math.cos(frame * 0.05) * 4;
      cam.lookAt(0, 0, 4);
      cam.updateMatrixWorld();

      const t0 = performance.now();
      view.update(world, dt, cam);
      totalUpdateMs += performance.now() - t0;
    }
    avgMs = Math.min(avgMs, totalUpdateMs / 120);
  }
  const diag = view.diagnostics();
  assert.ok(diag.activeWaterSplashes > 0, "water splashes active during 24-car benchmark");
  assert.ok(diag.activeWaterRipples > 0, "water ripples active during 24-car benchmark");
  assert.ok(diag.activeWetTrackSegments > 0, "wet exit tracks stamped during 24-car benchmark");
  assert.ok(diag.activeSandRutSegments > 0, "sand ruts carved during 24-car benchmark");
  assert.ok(diag.activeSandDust > 0, "sand dust active during 24-car benchmark");
  assert.ok(diag.activeSandGrit > 0, "sand grit active during 24-car benchmark");
  assert.ok(
    avgMs < 0.75,
    `expected 24-vehicle water+sand streetSurfaces.update() avg < 0.75 ms, got ${avgMs.toFixed(4)} ms`,
  );
});
