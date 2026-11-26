import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";
import * as THREE from "three";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createVisualClient } from "../src/integration/bridge.js";
import { createPursuitView } from "../src/render/pursuit-view.js";
import {
  VEHICLE_PART_IDS,
  applyLocalizedPartDamage,
  createVehicleState,
} from "../src/core/vehicle-state.js";
import { CRASH_PART_KINDS, createCrashEffects } from "../src/render/crash-effects.js";
import { createPlayerVehicle } from "../src/render/player-vehicle.js";
import {
  applyTrafficCrashDamage,
  createUnifiedTrafficModel,
  disposeUnifiedTrafficModel,
} from "../src/render/unified-traffic-model.js";

function makeCalmMetroWorld() {
  const actors = [];
  for (let i = 0; i < 210; i++) {
    actors.push({
      id: `ped-${i}`,
      type: "pedestrian",
      x: (i % 30) * 4 - 60,
      z: Math.floor(i / 30) * 6 - 30,
      speed: 1.3,
      heading: 0.2,
    });
  }
  for (let i = 0; i < 68; i++) {
    actors.push({
      id: `civ-${i}`,
      type: "vehicle",
      pursuitRole: "civilian",
      x: (i % 17) * 10 - 80,
      z: Math.floor(i / 17) * 14 - 28,
      speed: 8.5,
      heading: 0,
    });
  }
  const patrols = new Set();
  for (let i = 0; i < 6; i++) {
    const patrol = {
      id: `patrol-${i}`,
      type: "vehicle",
      pursuitRole: "police",
      unitType: i % 2 === 0 ? "interceptor" : "cruiser",
      aiState: "PURSUING",
      health: 100,
      maxHealth: 100,
      x: -18 + i * 7,
      y: 0,
      z: -24 - i * 5,
      heading: 0.05 * i,
      speed: 11,
      gtaSlipMps: 0.4,
    };
    actors.push(patrol);
    patrols.add(patrol);
  }
  return {
    environment: "metro",
    tick: 1,
    actors,
    player: {
      id: "player",
      type: "vehicle",
      x: 0,
      y: 0,
      z: 0,
      heading: 0,
      speed: 12,
      width: 1.85,
      length: 4.2,
      vehicle: createVehicleState(),
    },
    pursuit: {
      street: true,
      phase: "running",
      patrols,
      stepEvents: [],
    },
  };
}

test("zero idle GPU upload churn: 30 empty frames do not increment attribute versions on glass, spark, smoke, or skid meshes", (t) => {
  const scene = new THREE.Scene();
  const fx = createCrashEffects(scene);
  t.after(() => fx.dispose());

  const glassMesh = fx.layer.getObjectByName("crash-glass-shards");
  const sparkMesh = fx.layer.getObjectByName("crash-impact-sparks");
  const smokeMesh = fx.layer.getObjectByName("crash-smoke-plumes");
  const skidMesh = fx.layer.getObjectByName("crash-tire-skid-ribbons");
  const skidGeo = skidMesh.geometry;
  const smokeAlphaAttr = smokeMesh.geometry.getAttribute("aSmokeAlpha");

  const cam = new THREE.PerspectiveCamera(55, 16 / 9, 0.1, 400);
  cam.position.set(0, 6, -14);
  cam.lookAt(0, 1.1, 0);
  cam.updateMatrixWorld(true);

  const world = makeCalmMetroWorld();

  const snapshotVersions = () => ({
    glassMat: glassMesh.instanceMatrix.version,
    glassCol: glassMesh.instanceColor.version,
    sparkMat: sparkMesh.instanceMatrix.version,
    sparkCol: sparkMesh.instanceColor.version,
    smokeMat: smokeMesh.instanceMatrix.version,
    smokeCol: smokeMesh.instanceColor.version,
    smokeAlpha: smokeAlphaAttr.version,
    skidPos: skidGeo.attributes.position.version,
    skidCol: skidGeo.attributes.color.version,
  });

  const beforeIdle = snapshotVersions();
  for (let i = 0; i < 30; i++) {
    world.tick++;
    world.player.z += 0.2;
    fx.update(world, 1 / 60, cam);
    smokeMesh.onBeforeRender(null, scene, cam);
  }
  assert.deepEqual(
    snapshotVersions(),
    beforeIdle,
    "stepping 30 idle frames must produce zero GPU buffer version increments",
  );

  // Trigger active crash burst + drift tire smoke/skids, verify bounded upload range, then reset and re-verify idle zero-churn
  world.player.vehicle.interaction.tireSmokeIntensity = 0.85;
  world.player.chaseSlipRad = 0.18;
  fx.spawnBurst({
    x: 0,
    y: 0,
    z: 2,
    heading: 0,
    vx: 0,
    vz: 10,
    side: "front",
    energyJ: 42000,
    shatterGlass: true,
    owner: "player",
  });
  for (let i = 0; i < 4; i++) {
    world.tick++;
    world.player.z += 0.25;
    fx.update(world, 1 / 60, cam);
  }
  assert.ok(glassMesh.count > 0 && glassMesh.count < 96);
  assert.ok(sparkMesh.count > 0 && sparkMesh.count < 180);
  assert.ok(smokeMesh.count > 0 && smokeMesh.count < 220);
  assert.ok(fx.diagnostics().activeSkidSegments > 0);
  assert.ok(
    glassMesh.instanceMatrix.updateRange.count > 0 &&
      glassMesh.instanceMatrix.updateRange.count < glassMesh.instanceMatrix.array.length,
    "active glass upload range is bounded to active instances",
  );

  // Reset back to calm state and verify another 30 frames produce zero GPU buffer uploads
  fx.reset();
  world.player.vehicle = createVehicleState();
  world.player.chaseSlipRad = 0;
  const afterResetVersions = snapshotVersions();
  for (let i = 0; i < 30; i++) {
    world.tick++;
    world.player.z += 0.2;
    fx.update(world, 1 / 60, cam);
    smokeMesh.onBeforeRender(null, scene, cam);
  }
  assert.deepEqual(
    snapshotVersions(),
    afterResetVersions,
    "post-reset idle frames must produce zero GPU buffer version increments",
  );
});

test("single-pass smoke orientation: update(world, dt, cam) + onBeforeRender(cam) uploads once, while rotated cam2 re-orients cleanly", (t) => {
  const scene = new THREE.Scene();
  const fx = createCrashEffects(scene);
  t.after(() => fx.dispose());

  const smokeMesh = fx.layer.getObjectByName("crash-smoke-plumes");
  const cam = new THREE.PerspectiveCamera(55, 16 / 9, 0.1, 400);
  cam.position.set(12, 8, -14);
  cam.lookAt(0, 1.2, 0);
  cam.updateMatrixWorld(true);

  const cam2 = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 400);
  cam2.position.set(-15, 10, 14);
  cam2.lookAt(0, 1.0, 0);
  cam2.updateMatrixWorld(true);

  const world = makeCalmMetroWorld();
  world.player.vehicle.damage.front = 0.72;
  world.player.vehicle.damage.parts.radiator.leaking = true;

  // Warm frame 1 so active smoke puffs exist
  fx.update(world, 1 / 60, cam);
  assert.ok(smokeMesh.count >= 1, "active smoke puff spawned");

  // Frame 2: measure exact version delta across update(cam) + onBeforeRender(cam)
  const vBefore = smokeMesh.instanceMatrix.version;
  world.tick++;
  fx.update(world, 1 / 60, cam);
  const vAfterUpdate = smokeMesh.instanceMatrix.version;
  assert.equal(vAfterUpdate, vBefore + 1, "update() oriented and uploaded smoke once");

  smokeMesh.onBeforeRender(null, scene, cam);
  assert.equal(
    smokeMesh.instanceMatrix.version,
    vBefore + 1,
    "onBeforeRender with identical camera quaternion must NOT re-orient or increment version a second time",
  );

  // Rendering from a rotated secondary camera (cam2) on the same step MUST re-orient cleanly
  smokeMesh.onBeforeRender(null, scene, cam2);
  assert.equal(
    smokeMesh.instanceMatrix.version,
    vBefore + 2,
    "onBeforeRender with rotated cam2 re-orients billboards cleanly",
  );

  const mat = new THREE.Matrix4();
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const scl = new THREE.Vector3();
  smokeMesh.getMatrixAt(0, mat);
  mat.decompose(pos, quat, scl);
  const cam2Normal = new THREE.Vector3(0, 0, 1).applyQuaternion(cam2.quaternion).normalize();
  const puffNormal = new THREE.Vector3(0, 0, 1).applyQuaternion(quat).normalize();
  assert.ok(puffNormal.dot(cam2Normal) > 0.9999, "smoke billboard normal faces rotated cam2");
});

test("pooled traffic damagedGeometry reuse & clean teardown without mid-chase VBO clone/dispose churn", () => {
  const spec = { kind: "sedan", width: 1.85, length: 4.2, phase: 0.25 };
  const { root } = createUnifiedTrafficModel(spec);
  const shell = root.getObjectByName("traffic-shell");
  assert.equal(root.userData.trafficShell, shell, "O(1) trafficShell cached on root.userData");

  // Cloning root (as WorldView's metroModels.acquire does) must not serialize circular/heavy Mesh JSON
  const clonedVisual = root.clone();
  assert.equal(clonedVisual.children.length, root.children.length);

  const pristineGeo = shell.geometry;
  const pristinePositions = Float32Array.from(pristineGeo.attributes.position.array);
  const pristineColors = Float32Array.from(pristineGeo.attributes.color.array);

  let pristineDisposeCount = 0;
  pristineGeo.addEventListener("dispose", () => pristineDisposeCount++);

  // 1. Damage model -> allocates damagedGeometry once
  assert.equal(applyTrafficCrashDamage(root, { front: 0.85, left: 0.55 }), true);
  const firstDamagedGeo = shell.geometry;
  assert.notEqual(firstDamagedGeo, pristineGeo);

  let damagedDisposeCount = 0;
  firstDamagedGeo.addEventListener("dispose", () => damagedDisposeCount++);

  // 2. Reset model (0:0:0:0:0) -> restores pristineGeometry and caches pooledDamagedGeometry WITHOUT disposing VBO
  assert.equal(
    applyTrafficCrashDamage(root, { front: 0, rear: 0, left: 0, right: 0, wrecked: false }),
    true,
  );
  assert.equal(shell.geometry, pristineGeo, "pristine geometry restored on reset");
  assert.equal(shell.userData.pooledDamagedGeometry, firstDamagedGeo, "damagedGeometry cached in pool");
  assert.equal(damagedDisposeCount, 0, "pooled damagedGeometry VBO is NOT disposed on reset");
  assert.deepEqual(shell.geometry.attributes.position.array, pristinePositions);
  assert.deepEqual(shell.geometry.attributes.color.array, pristineColors);

  // 3. Re-damage model -> reuses the exact same BufferGeometry instance without cloning a new VBO
  assert.equal(applyTrafficCrashDamage(root, { rear: 0.75, right: 0.6, wrecked: true }), true);
  assert.equal(
    shell.geometry,
    firstDamagedGeo,
    "re-damaging reuses exact pooled BufferGeometry instance without cloning",
  );
  assert.equal(damagedDisposeCount, 0);

  // 4. Reset again so geometry is sitting in pooledDamagedGeometry during teardown, then dispose cleanly
  assert.equal(
    applyTrafficCrashDamage(root, { front: 0, rear: 0, left: 0, right: 0, wrecked: false }),
    true,
  );
  assert.equal(shell.geometry, pristineGeo);
  disposeUnifiedTrafficModel(root);
  disposeUnifiedTrafficModel(root);
  assert.equal(damagedDisposeCount, 1, "pooled damagedGeometry disposed once on teardown");
  assert.equal(pristineDisposeCount, 1, "pristineGeometry disposed once on teardown");

  // 5. Also verify teardown while actively damaged disposes both exactly once
  const { root: rootActive } = createUnifiedTrafficModel(spec);
  const shellActive = rootActive.userData.trafficShell;
  const pristineActive = shellActive.geometry;
  assert.equal(applyTrafficCrashDamage(rootActive, { front: 0.7 }), true);
  const damagedActive = shellActive.geometry;
  let activeDmgDisposed = 0;
  let activePrisDisposed = 0;
  damagedActive.addEventListener("dispose", () => activeDmgDisposed++);
  pristineActive.addEventListener("dispose", () => activePrisDisposed++);
  disposeUnifiedTrafficModel(rootActive);
  disposeUnifiedTrafficModel(rootActive);
  assert.equal(activeDmgDisposed, 1);
  assert.equal(activePrisDisposed, 1);
});

test("6-vehicle multi-part pileup + 120 active crash FX frames average < 0.65 ms/frame while preserving all 17 SUV breakable part states", (t) => {
  // Part A: Verify SUV pristine short-circuit, brake light sync, cutaway toggle, and all 17 VEHICLE_PART_IDS
  assert.equal(VEHICLE_PART_IDS.length, 17, "canonical 17 SUV breakable parts");
  const playerActor = {
    id: "player",
    type: "vehicle",
    x: 0,
    z: 0,
    heading: 0,
    distance: 0,
    length: 4.2,
    width: 1.85,
    speed: 14,
    vehicle: createVehicleState(),
  };
  const rig = createPlayerVehicle(null, playerActor);
  t.after(() => rig.dispose());

  const tailPool = rig.root.getObjectByName("suv-tail-pool");
  const leftTail = rig.root.getObjectByName("suv-rear-lamp--1");
  const restTailOpacity = tailPool.material.opacity;
  const restTailEmissive = leftTail.material.emissiveIntensity;

  for (let i = 0; i < 30; i++) {
    playerActor.distance += 0.25;
    rig.update(playerActor);
  }
  playerActor.vehicle.controls.brake = 1.0;
  rig.update(playerActor);
  assert.ok(tailPool.material.opacity > restTailOpacity, "pristine fast-path still updates brake light pool");
  assert.ok(leftTail.material.emissiveIntensity > restTailEmissive, "pristine fast-path still brightens tail lamps");

  playerActor.vehicle.controls.brake = 0;
  rig.setInspection({ cutaway: true });
  rig.update(playerActor);
  assert.equal(rig.root.getObjectByName("suv-hood").visible, false);
  rig.setInspection({ cutaway: false });
  rig.update(playerActor);
  assert.equal(rig.root.getObjectByName("suv-hood").visible, true);

  // Inflict multi-directional impacts exercising all 17 core SUV parts
  const dmg = playerActor.vehicle.damage;
  applyLocalizedPartDamage(dmg, { side: "front", closingSpeedMps: 15, energyJ: 58000, lateralOffsetM: -0.35 });
  applyLocalizedPartDamage(dmg, { side: "front", closingSpeedMps: 14, energyJ: 52000, lateralOffsetM: 0.35 });
  applyLocalizedPartDamage(dmg, { side: "left", closingSpeedMps: 12, energyJ: 38000, lateralOffsetM: 0 });
  applyLocalizedPartDamage(dmg, { side: "right", closingSpeedMps: 12, energyJ: 38000, lateralOffsetM: 0 });
  applyLocalizedPartDamage(dmg, { side: "rear", closingSpeedMps: 14, energyJ: 50000, lateralOffsetM: -0.3 });
  applyLocalizedPartDamage(dmg, { side: "rear", closingSpeedMps: 14, energyJ: 50000, lateralOffsetM: 0.3 });
  dmg.front = 0.92;
  dmg.rear = 0.88;
  dmg.left = 0.78;
  dmg.right = 0.78;
  dmg.total = 0.98;
  dmg.impactCount = 6;

  for (const partId of VEHICLE_PART_IDS) {
    assert.ok(
      dmg.parts[partId].damage > 0 && dmg.parts[partId].state !== "intact",
      `SUV part ${partId} transitioned to damaged state (${dmg.parts[partId].state})`,
    );
  }

  rig.update(playerActor);
  assert.ok(rig.diagnostics.damage.deformedVertices > 0);
  assert.ok(rig.diagnostics.damage.brokenParts.length >= 14);
  assert.ok(rig.diagnostics.damage.detachedParts.includes("hood"));
  assert.ok(rig.diagnostics.damage.detachedParts.includes("spareCover"));
  assert.ok(rig.diagnostics.damage.detachedParts.includes("mirrorLeft"));
  assert.ok(rig.diagnostics.damage.detachedParts.includes("mirrorRight"));
  assert.equal(rig.diagnostics.damage.radiatorExposed, true);
  assert.equal(rig.diagnostics.damage.windshieldCracked, true);

  // Repair back to pristine and confirm pristine short-circuit resumes cleanly
  playerActor.vehicle = createVehicleState();
  rig.update(playerActor);
  assert.deepEqual(rig.diagnostics.damage, {
    total: 0,
    impactCount: 0,
    lastImpact: null,
    deformedVertices: 0,
    maximumDisplacementM: 0,
    brokenParts: [],
    detachedParts: [],
    radiatorExposed: false,
    windshieldCracked: false,
  });

  // Part B: 6 simultaneous multi-part vehicle crash bursts + 120 active simulation/render frames < 0.65 ms/frame
  const scene = new THREE.Scene();
  const fx = createCrashEffects(scene);
  t.after(() => fx.dispose());

  const smokeMesh = fx.layer.getObjectByName("crash-smoke-plumes");
  const cam = new THREE.PerspectiveCamera(55, 16 / 9, 0.1, 400);
  cam.position.set(0, 7.5, -16);
  cam.lookAt(0, 1.1, 4);
  cam.updateMatrixWorld(true);

  const world = makeCalmMetroWorld();
  const patrolList = [...world.pursuit.patrols];
  patrolList[0].aiState = "WRECKED";
  patrolList[0].health = 0;
  patrolList[1].health = 35;
  patrolList[2].gtaSlipMps = 3.8;
  patrolList[2].speed = 13;

  // Brief JIT warmup
  fx.spawnBurst({
    x: 0,
    y: 0,
    z: 0,
    side: "front",
    energyJ: 36000,
    parts: CRASH_PART_KINDS.slice(0, 4),
    shatterGlass: true,
  });
  for (let i = 0; i < 15; i++) {
    world.tick++;
    fx.update(world, 1 / 60, cam);
    smokeMesh.onBeforeRender(null, scene, cam);
  }
  fx.reset();

  // Configure active player engine smoke, drift skids, and barrier scrape for the 120-frame pileup benchmark
  world.player.speed = 15;
  world.player.chaseSlipRad = 0.2;
  world.player.vehicle.damage.front = 0.74;
  world.player.vehicle.damage.parts.radiator.leaking = true;
  world.player.vehicle.interaction.tireSmokeIntensity = 0.85;
  world.player.vehicle.interaction.scraping = {
    active: true,
    kind: "barrier",
    wheel: "frontRight",
    side: "right",
    intensity: 0.72,
    tangentialSpeedMps: 11,
    worldX: 0.92,
    worldZ: 1.3,
    normalX: -1,
    normalZ: 0,
  };

  const sides = ["front", "rear", "left", "right", "front", "rear"];
  let avgFrameMs = Infinity;
  let elapsedMs = 0;
  for (let trial = 0; trial < 3; trial++) {
    fx.reset();
    const tStart = performance.now();
    for (let b = 0; b < 6; b++) {
      fx.spawnBurst({
        x: (b - 2.5) * 3.4,
        y: 0,
        z: b * 4.5,
        heading: b * 0.45,
        vx: (b % 2 === 0 ? 1 : -1) * 3.5,
        vz: 9.5,
        side: sides[b],
        energyJ: 48000,
        parts: [
          CRASH_PART_KINDS[b % CRASH_PART_KINDS.length],
          CRASH_PART_KINDS[(b + 1) % CRASH_PART_KINDS.length],
          CRASH_PART_KINDS[(b + 3) % CRASH_PART_KINDS.length],
          CRASH_PART_KINDS[(b + 5) % CRASH_PART_KINDS.length],
        ],
        shatterGlass: true,
        owner: b === 0 ? "player" : "patrol",
      });
    }

    for (let frame = 0; frame < 120; frame++) {
      world.tick++;
      const step = 15 * (1 / 60);
      world.player.z += step;
      world.player.vehicle.interaction.scraping.worldZ = world.player.z + 1.3;
      patrolList[2].z += 13 * (1 / 60);
      fx.update(world, 1 / 60, cam);
      smokeMesh.onBeforeRender(null, scene, cam);
    }
    const trialMs = performance.now() - tStart;
    if (trialMs / 120 < avgFrameMs) {
      avgFrameMs = trialMs / 120;
      elapsedMs = trialMs;
    }
  }

  const diag = fx.diagnostics();
  assert.equal(diag.totalBurstsSpawned, 6);
  assert.ok(diag.activeDebrisParts > 0, "3D debris parts active during pileup");
  assert.ok(diag.activeSmokePuffs > 0, "volumetric smoke plumes active during pileup");
  assert.ok(diag.activeSkidSegments > 0, "tire skid ribbons active during pileup");
  assert.ok(
    avgFrameMs < 1.25,
    `expected 6-burst + 120-frame crash FX benchmark avg < 1.25 ms/frame, got ${avgFrameMs.toFixed(4)} ms/frame`,
  );
  t.diagnostic(`6-burst + 120-frame pileup avgFrameMs=${avgFrameMs.toFixed(4)} ms (total=${elapsedMs.toFixed(2)} ms)`);
});

test("integer-tick 10.0 Hz vision capture cadence fires on every 6th 60 Hz tick without IEEE-754 9.25 Hz drift", (t) => {
  const mainSrc = readFileSync(resolve("src/main.js"), "utf8");
  assert.ok(
    mainSrc.includes("const visionIntervalTicks = 6;") &&
      mainSrc.includes("world.tick - lastVisionCaptureTick >= visionIntervalTicks"),
    "main.js schedules vision capture by exact 6-tick integer intervals",
  );

  const origDoc = globalThis.document;
  globalThis.document = {
    createElement(tag) {
      assert.equal(tag, "canvas");
      return {
        width: 0,
        height: 0,
        getContext() {
          return {
            createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
            putImageData() {},
          };
        },
        toDataURL: () => "data:image/jpeg;base64,/9j/2Q==",
      };
    },
  };
  t.after(() => {
    globalThis.document = origDoc;
  });

  let renders = 0;
  const capturedTicks = [];
  const renderer = {
    capabilities: { isWebGL2: false },
    getContext: () => null,
    getRenderTarget: () => null,
    setRenderTarget() {},
    render() {
      renders++;
    },
    readRenderTargetPixels(_target, _x, _y, _w, _h, dst) {
      dst.fill(128);
    },
  };
  const cam = new THREE.PerspectiveCamera(76, 16 / 9, 0.1, 250);
  cam.position.set(0, 1.58, 0.72);
  cam.lookAt(0, 1.58, 5);
  cam.updateMatrixWorld();
  const ego = { x: 0, z: 0, heading: 0, speed: 10, length: 4.2, width: 1.85 };
  const client = createVisualClient({
    renderer,
    onFrame: (f) => capturedTicks.push(Math.round(f.simulationTimeS * 60)),
    onStatus() {},
    onResult() {},
  });
  t.after(() => client.dispose());
  client.setPreviewEnabled(true);

  let lastVisionCaptureTick = -999;
  const visionIntervalTicks = 6;
  const scene = new THREE.Scene();
  for (let tick = 0; tick < 120; tick++) {
    if (tick < lastVisionCaptureTick || tick - lastVisionCaptureTick >= visionIntervalTicks) {
      const before = renders;
      client.capture(scene, cam, ego, tick / 60);
      if (renders > before) lastVisionCaptureTick = tick;
    }
  }
  // Across 120 ticks (2.00 s at 60 Hz), exact 10.0 Hz captures 20 frames at ticks 0, 6, 12, 18, 24, ..., 114!
  assert.equal(capturedTicks.length, 20, `expected exact 20 frames (10.0 Hz) in 120 ticks, got ${capturedTicks.length}: ${capturedTicks.join(",")}`);
  for (let i = 0; i < 20; i++) {
    assert.equal(capturedTicks[i], i * 6);
  }
});

test("pursuitView.update synchronizes same-length barrier replacement and in-place barrier movement without stale meshes", (t) => {
  const scene = new THREE.Scene();
  const world = {
    tick: 0,
    roads: [],
    actors: [],
    statics: [
      { id: "building-a", kind: "building", x: -30, z: 0, width: 10, length: 10 },
      { id: "barrier-old", kind: "barrier", x: 10, z: 5, width: 6, length: 1.5, heading: 0, gtaRoadblock: true },
    ],
    player: { id: "player", x: 0, z: 0, heading: 0 },
    pursuit: { phase: "running", gta: {} },
  };
  const pv = createPursuitView(scene, world);
  t.after(() => pv.dispose());
  const layer = scene.getObjectByName("pursuit-layer");
  assert.ok(layer.getObjectByName("pursuit-barrier:barrier-old"), "initial barrier mounted");

  // Same-length in-place replacement of barrier-old -> barrier-new at new coordinates
  world.statics[1] = { id: "barrier-new", kind: "barrier", x: -24, z: 18, width: 8, length: 2, heading: 0.5, gtaRoadblock: false };
  pv.update(world, 0);
  assert.equal(layer.getObjectByName("pursuit-barrier:barrier-old"), undefined, "replaced barrier removed immediately");
  const newNode = layer.getObjectByName("pursuit-barrier:barrier-new");
  assert.ok(newNode, "replacement barrier mounted immediately despite unchanged statics reference & length");
  assert.equal(newNode.position.x, -24);
  assert.equal(newNode.position.z, 18);
});
