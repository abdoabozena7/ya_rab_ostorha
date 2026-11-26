import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import {
  applyTrafficCrashDamage,
  createUnifiedTrafficModel,
  disposeUnifiedTrafficModel,
} from "../src/render/unified-traffic-model.js";
import { createPursuitView } from "../src/render/pursuit-view.js";
import { CRASH_PART_KINDS, createCrashEffects } from "../src/render/crash-effects.js";

function hexMatchesVertices(geometry, targetHex, predicate = () => true) {
  const pos = geometry.attributes.position;
  const col = geometry.attributes.color;
  const target = new THREE.Color(targetHex);
  let matches = 0;
  for (let i = 0; i < pos.count; i++) {
    const dr = Math.abs(col.getX(i) - target.r);
    const dg = Math.abs(col.getY(i) - target.g);
    const db = Math.abs(col.getZ(i) - target.b);
    if (dr < 1e-3 && dg < 1e-3 && db < 1e-3 && predicate(pos.getX(i), pos.getY(i), pos.getZ(i))) {
      matches++;
    }
  }
  return matches;
}

test("upgraded traffic car exterior details preserve single-shell draw budget, wheel invariants, and police twoToneShell", (t) => {
  for (const kind of ["sedan", "taxi", "suv", "van"]) {
    const width = 1.85, length = 4.2;
    const { root, wheels } = createUnifiedTrafficModel({ kind, width, length, phase: 0.2 });
    t.after(() => disposeUnifiedTrafficModel(root));

    const meshChildren = root.children.filter((c) => c.isMesh);
    assert.equal(meshChildren.length, 5, `${kind} keeps 1 shell + 4 wheel meshes`);
    assert.equal(wheels.length, 4);

    const shell = root.getObjectByName("traffic-shell");
    assert.ok(shell?.isMesh);
    assert.equal(shell.geometry.index, null, "traffic-shell stays non-indexed for twoToneShell");
    assert.ok(shell.geometry.attributes.position);
    assert.ok(shell.geometry.attributes.normal);
    assert.ok(shell.geometry.attributes.color);

    // Front license plate (0xd4cbb0) at +Z nose & rear license plate at -Z tail
    assert.ok(
      hexMatchesVertices(shell.geometry, 0xd4cbb0, (_x, _y, z) => z > length * 0.45) >= 6,
      `${kind} has a front license plate`,
    );
    assert.ok(
      hexMatchesVertices(shell.geometry, 0xd4cbb0, (_x, _y, z) => z < -length * 0.45) >= 6,
      `${kind} retains its rear license plate`,
    );

    // Rear exhaust tailpipe (0x757d78) under rear valance
    assert.ok(
      hexMatchesVertices(shell.geometry, 0x757d78, (_x, _y, z) => z < -length * 0.44) >= 15,
      `${kind} has a 3D rear exhaust tailpipe`,
    );

    // Sculpted left & right side mirrors with rear-facing reflective glass (0x8fa6ad)
    assert.ok(
      hexMatchesVertices(shell.geometry, 0x8fa6ad, (x) => x < -width * 0.44) >= 6,
      `${kind} has left side mirror glass`,
    );
    assert.ok(
      hexMatchesVertices(shell.geometry, 0x8fa6ad, (x) => x > width * 0.44) >= 6,
      `${kind} has right side mirror glass`,
    );

    // Front lower air-dam recess (0x1e2323) and splitter/wiper trim (0x242929)
    assert.ok(
      hexMatchesVertices(shell.geometry, 0x1e2323, (_x, _y, z) => z > length * 0.45) >= 12,
      `${kind} has a recessed front lower air-dam`,
    );
    assert.ok(
      hexMatchesVertices(shell.geometry, 0x242929, (_x, y, z) => z > 0 && y > 0.65) >= 12,
      `${kind} has windshield wiper strip facets`,
    );
  }

  // Police patrol twoToneShell compatibility check (activated when pursuit.response is present)
  const scene = new THREE.Scene();
  const patrolActor = { id: "patrol-test", pursuitRole: "police", type: "vehicle", kind: "sedan", width: 1.85, length: 4.35 };
  const world = { actors: [patrolActor], pursuit: { phase: "running", response: {} }, tick: 0 };
  const pursuitView = createPursuitView(scene, world);
  const { root: visual } = createUnifiedTrafficModel(patrolActor);
  const holder = new THREE.Group();
  holder.add(visual);
  scene.add(holder);
  const pristineShellGeo = visual.getObjectByName("traffic-shell").geometry;
  pursuitView.attach({ root: holder, visual }, patrolActor);
  pursuitView.update();
  const paintedShellGeo = visual.getObjectByName("traffic-shell").geometry;
  assert.equal(paintedShellGeo !== pristineShellGeo, true, "twoToneShell painted police cruiser shell cleanly");
  assert.equal(paintedShellGeo.index, null);
  // Verify applyTrafficCrashDamage also crumples twoToneShell police cruisers and restores livery on reset
  assert.equal(applyTrafficCrashDamage(visual, { wrecked: true }), true);
  assert.equal(visual.getObjectByName("traffic-shell").geometry !== paintedShellGeo, true);
  assert.equal(applyTrafficCrashDamage(visual, { front: 0, rear: 0, left: 0, right: 0, wrecked: false }), true);
  assert.equal(visual.getObjectByName("traffic-shell").geometry === paintedShellGeo, true);
  pursuitView.dispose();
  disposeUnifiedTrafficModel(visual);
});

test("applyTrafficCrashDamage crumples front/rear/sides, darkens wrecked cruisers, skips unchanged signatures, restores pristine, and disposes cleanly", () => {
  const width = 1.85, length = 4.2;
  const { root } = createUnifiedTrafficModel({ kind: "sedan", width, length, phase: 0.1 });
  const shell = root.getObjectByName("traffic-shell");
  const pristineGeo = shell.geometry;
  const pristinePos = Float32Array.from(pristineGeo.attributes.position.array);
  const pristineCol = Float32Array.from(pristineGeo.attributes.color.array);

  // Zero-damage on pristine car is a zero-op
  assert.equal(applyTrafficCrashDamage(root, { front: 0, rear: 0, left: 0, right: 0, wrecked: false }), false);
  assert.equal(shell.geometry === pristineGeo, true);

  // Front + rear + left + right crash deformation
  assert.equal(applyTrafficCrashDamage(root, { front: 0.9, rear: 0.85, left: 0.8, right: 0.75 }), true);
  const damagedGeo = shell.geometry;
  assert.equal(damagedGeo !== pristineGeo, true);
  assert.equal(shell.userData.pristineGeometry === pristineGeo, true);

  // Repeated identical quantized signature is a zero-op
  assert.equal(applyTrafficCrashDamage(root, { front: 0.901, rear: 0.849, left: 0.8, right: 0.75 }), false);
  assert.equal(shell.geometry === damagedGeo, true);

  pristineGeo.computeBoundingBox();
  const { min, max } = pristineGeo.boundingBox;
  const h = max.y - min.y;
  const cz = (min.z + max.z) / 2;

  const dstPos = damagedGeo.attributes.position;
  let minNoseDz = 0;
  let maxHoodDy = 0;
  let minFrontBumperDy = 0;
  let maxRearDz = 0;
  let minRearBumperDy = 0;
  let maxLeftInwardDx = 0;
  let minRightInwardDx = 0;

  for (let i = 0; i < dstPos.count; i++) {
    const x0 = pristinePos[i * 3], y0 = pristinePos[i * 3 + 1], z0 = pristinePos[i * 3 + 2];
    const dx = dstPos.getX(i) - x0;
    const dy = dstPos.getY(i) - y0;
    const dz = dstPos.getZ(i) - z0;
    const zn = (z0 - cz) / length;
    const yn = (y0 - min.y) / h;
    if (zn > 0.44) minNoseDz = Math.min(minNoseDz, dz);
    if (zn >= 0.22 && zn <= 0.42 && yn > 0.42 && Math.abs(x0) < width * 0.48) maxHoodDy = Math.max(maxHoodDy, dy);
    if (zn > 0.44 && yn < 0.25 && Math.abs(x0) > width * 0.28) minFrontBumperDy = Math.min(minFrontBumperDy, dy);
    if (zn < -0.44) maxRearDz = Math.max(maxRearDz, dz);
    if (zn < -0.44 && yn < 0.25 && Math.abs(x0) > width * 0.28) minRearBumperDy = Math.min(minRearBumperDy, dy);
    if (x0 < -width * 0.42 && Math.abs(zn) < 0.2) maxLeftInwardDx = Math.max(maxLeftInwardDx, dx);
    if (x0 > width * 0.42 && Math.abs(zn) < 0.2) minRightInwardDx = Math.min(minRightInwardDx, dx);
  }

  assert.ok(minNoseDz < -0.18, `front nose crumpled inward (${minNoseDz})`);
  assert.ok(maxHoodDy > 0.05, `hood tented upward (${maxHoodDy})`);
  assert.ok(minFrontBumperDy < -0.03, `front bumper corner sagged (${minFrontBumperDy})`);
  assert.ok(maxRearDz > 0.14, `rear trunk crumpled inward (${maxRearDz})`);
  assert.ok(minRearBumperDy < -0.025, `rear bumper corner sagged (${minRearBumperDy})`);
  assert.ok(maxLeftInwardDx > 0.06, `left doors pushed inward (${maxLeftInwardDx})`);
  assert.ok(minRightInwardDx < -0.05, `right doors pushed inward (${minRightInwardDx})`);

  // Wrecked state applies heavy crumple + scorched hood darkening (~0.45x color)
  assert.equal(applyTrafficCrashDamage(root, { wrecked: true }), true);
  const dstCol = shell.geometry.attributes.color;
  let checkedHoodVerts = 0;
  for (let i = 0; i < dstPos.count; i++) {
    const x0 = pristinePos[i * 3], y0 = pristinePos[i * 3 + 1], z0 = pristinePos[i * 3 + 2];
    const zn = (z0 - cz) / length;
    const yn = (y0 - min.y) / h;
    if (zn > 0.24 && zn < 0.44 && yn > 0.40 && Math.abs(x0) < width * 0.48 && pristineCol[i * 3] > 0.12) {
      const ratio = dstCol.getX(i) / pristineCol[i * 3];
      assert.ok(ratio <= 0.48, `wrecked hood vertex darkened to ~0.45x (${ratio})`);
      checkedHoodVerts++;
    }
  }
  assert.ok(checkedHoodVerts > 0, "verified scorched hood vertices");

  // Resetting to 0 restores pristine geometry and retains pooled damaged clone for zero-VBO-thrash reuse
  let damagedDisposed = 0;
  damagedGeo.addEventListener("dispose", () => damagedDisposed++);
  assert.equal(applyTrafficCrashDamage(root, { front: 0, rear: 0, left: 0, right: 0, wrecked: false }), true);
  assert.equal(shell.geometry === pristineGeo, true);
  assert.equal(damagedDisposed, 0);
  assert.deepEqual(shell.geometry.attributes.position.array, pristinePos);

  // Re-damage reuses the pooled BufferGeometry and disposeUnifiedTrafficModel disposes both buffers once
  assert.equal(applyTrafficCrashDamage(root, { front: 0.65 }), true);
  const secondDamagedGeo = shell.geometry;
  assert.equal(secondDamagedGeo === damagedGeo, true);
  let secondDamagedDisposed = 0;
  let pristineDisposed = 0;
  secondDamagedGeo.addEventListener("dispose", () => secondDamagedDisposed++);
  pristineGeo.addEventListener("dispose", () => pristineDisposed++);

  disposeUnifiedTrafficModel(root);
  disposeUnifiedTrafficModel(root);
  assert.equal(secondDamagedDisposed, 1);
  assert.equal(pristineDisposed, 1);
});

test("createCrashEffects spawns physical 3D tumbling car parts, bounces above asphalt, deduplicates latched impacts, emits steam/smoke, clears on Repair, handles patrol_wrecked, and disposes cleanly", () => {
  const scene = new THREE.Scene();
  const fx = createCrashEffects(scene);
  const layer = scene.getObjectByName("crash-effects-layer");
  assert.ok(layer, "crash-effects-layer mounted on scene");
  assert.equal(CRASH_PART_KINDS.length, 8);

  const world = {
    tick: 15,
    actors: [],
    player: {
      x: 10,
      y: 0,
      z: -20,
      heading: 0.4,
      speed: 13,
      width: 1.85,
      length: 4.2,
      vehicle: {
        damage: {
          front: 0.76,
          rear: 0,
          left: 0,
          right: 0,
          impactCount: 1,
          parts: { radiator: { leaking: true } },
          lastImpact: {
            side: "front",
            closingSpeedMps: 14.2,
            energyJ: 54000,
            tick: 15,
          },
        },
      },
    },
    pursuit: {
      stepEvents: [],
      patrols: new Set(),
    },
  };

  fx.update(world, 1 / 60);
  const afterImpact = fx.diagnostics();
  assert.equal(afterImpact.totalBurstsSpawned, 1);
  assert.ok(afterImpact.activeDebrisParts >= 4, "heavy impact detached multiple 3D car parts");
  assert.ok(afterImpact.activeGlassShards > 0, "shattered glass shards spawned");
  assert.ok(afterImpact.activeSparks > 0, "metallic impact sparks spawned");
  assert.ok(afterImpact.activeSmokePuffs > 0, "radiator steam / engine smoke puff emitted when front >= 0.45");
  for (const expectedPart of ["license-plate", "grille-slat", "bumper-corner", "side-mirror", "hood-panel"]) {
    assert.ok(afterImpact.spawnedPartKinds.includes(expectedPart), `spawned ${expectedPart}`);
  }

  // Calling update 30 times on the same latched lastImpact.tick (even while world.tick advances!)
  // MUST NOT spawn duplicate bursts, and debris MUST follow gravity + bounce at y >= 0.14.
  const debrisGroup = layer.getObjectByName("crash-debris-parts");
  const visibleMeshes = () => debrisGroup.children.filter((m) => m.visible);
  const initialPeakY = Math.max(...visibleMeshes().map((m) => m.position.y));

  let touchedAsphalt = false;
  for (let i = 0; i < 30; i++) {
    world.tick = 15 + (i > 10 ? i : 0);
    fx.update(world, 1 / 60);
    for (const mesh of visibleMeshes()) {
      assert.ok(mesh.position.y >= 0.14 - 1e-6, `debris stays on or above asphalt (${mesh.position.y})`);
      if (mesh.position.y <= 0.145) touchedAsphalt = true;
    }
  }
  assert.equal(fx.diagnostics().totalBurstsSpawned, 1, "no duplicate bursts on latched lastImpact.tick");

  // Step further so high-arc debris hits asphalt and bounces cleanly
  for (let i = 0; i < 60; i++) {
    fx.update(world, 1 / 60);
    for (const mesh of visibleMeshes()) {
      assert.ok(mesh.position.y >= 0.14 - 1e-6, "debris bounce never penetrates below y = 0.14");
      if (mesh.position.y <= 0.145) touchedAsphalt = true;
    }
  }
  assert.ok(initialPeakY > 0.4 && touchedAsphalt, "3D debris followed ballistic arc down to asphalt bounce");

  // Repair / Reset clears lingering player debris, sparks, glass, and smoke
  world.player.vehicle.damage = {
    front: 0,
    rear: 0,
    left: 0,
    right: 0,
    impactCount: 0,
    lastImpact: null,
  };
  fx.update(world, 1 / 60);
  const afterRepair = fx.diagnostics();
  assert.equal(afterRepair.activeDebrisParts, 0, "player debris cleared on Repair/Reset");
  assert.equal(afterRepair.activeGlassShards, 0);
  assert.equal(afterRepair.activeSparks, 0);
  assert.equal(afterRepair.activeSmokePuffs, 0);

  // Negative control: stale or low-speed patrol_collision does NOT spawn a burst
  const patrol = {
    id: "patrol-1",
    pursuitRole: "police",
    unitType: "interceptor",
    aiState: "PURSUING",
    health: 80,
    maxHealth: 100,
    x: 24,
    y: 0,
    z: -12,
    heading: -0.5,
    speed: 9,
  };
  world.actors.push(patrol);
  world.pursuit.patrols.add(patrol);
  world.tick = 60;
  world.pursuit.stepEvents = [
    { type: "patrol_collision", actorId: "patrol-1", fresh: false, closingSpeed: 8.0 },
    { type: "patrol_collision", actorId: "patrol-1", fresh: true, closingSpeed: 1.5 },
  ];
  fx.update(world, 1 / 60);
  assert.equal(fx.diagnostics().totalBurstsSpawned, 1, "non-fresh or low-speed patrol contacts ignored");

  // Positive patrol_wrecked event spawns shattered "lightbar-lens" + cruiser parts + smoke
  patrol.aiState = "WRECKED";
  patrol.health = 0;
  world.tick = 61;
  world.pursuit.stepEvents = [{ type: "patrol_wrecked", unitType: "interceptor", causedByPlayer: true }];
  fx.update(world, 1 / 60);
  const afterPatrolWreck = fx.diagnostics();
  assert.equal(afterPatrolWreck.totalBurstsSpawned, 2);
  assert.ok(afterPatrolWreck.spawnedPartKinds.includes("lightbar-lens"), "patrol_wrecked ejected lightbar-lens");
  assert.ok(afterPatrolWreck.activeDebrisParts >= 3);
  assert.ok(afterPatrolWreck.activeSmokePuffs >= 1, "wrecked police cruiser emits engine smoke");

  // Repeated update on same world.tick does NOT re-trigger stepEvents
  fx.update(world, 1 / 60);
  assert.equal(fx.diagnostics().totalBurstsSpawned, 2);

  // Direct spawnBurst exercises remaining part geometries ("spare-cover", "trim-cladding")
  fx.spawnBurst({
    x: 0, y: 0, z: 0, side: "rear", energyJ: 35000,
    parts: ["spare-cover", "trim-cladding"],
  });
  for (const kind of CRASH_PART_KINDS) {
    assert.ok(fx.diagnostics().spawnedPartKinds.includes(kind), `verified part kind ${kind}`);
  }

  // Track every GPU geometry and material in crash-effects-layer and verify clean single disposal
  const trackedResources = new Map();
  layer.traverse((obj) => {
    if (!obj.isMesh) return;
    for (const res of [obj.geometry, obj.material]) {
      if (!res || trackedResources.has(res)) continue;
      trackedResources.set(res, 0);
      res.addEventListener("dispose", () => trackedResources.set(res, trackedResources.get(res) + 1));
    }
  });
  assert.ok(trackedResources.size >= 10);

  fx.dispose();
  fx.dispose();
  assert.equal(layer.parent, null, "crash-effects-layer detached from scene");
  assert.ok(
    [...trackedResources.values()].every((count) => count === 1),
    "all GPU geometries and materials disposed exactly once",
  );
});
