import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { createUnifiedCity } from "../src/core/unified-city.js";
import { PLAYER_VEHICLE } from "../src/core/vehicle-spec.js";
import { createPursuitCamera } from "../src/render/pursuit-camera.js";
import { WorldView } from "../src/render/world-view.js";

function makeGrandCityFixture(extraActors = []) {
  const grandMap = createUnifiedCity({ grand: true });
  const player = {
    id: "player",
    type: "vehicle",
    kind: "suv",
    ...grandMap.playerStart,
    y: 0,
    speed: 9.5,
    width: PLAYER_VEHICLE.widthM,
    length: PLAYER_VEHICLE.lengthM,
    height: PLAYER_VEHICLE.heightM,
    path: [grandMap.playerStart],
  };
  const world = {
    ...grandMap,
    environment: "metro",
    config: { cityVersion: 5 },
    actors: [player, ...extraActors],
    player,
    sensors: {},
    routeRevision: 0,
    tick: 0,
    pursuit: null,
  };
  return { world, player };
}

test("syncMetroPlayer(alpha) interpolates sub-frame pose smoothly and snaps cleanly on >=20m teleports", (t) => {
  const { world, player } = makeGrandCityFixture();
  const view = new WorldView(world);
  t.after(() => view.dispose());

  world.pursuit = { phase: "running" };
  player.previous = { x: 10, z: 20, y: 0.04, heading: 0 };
  player.x = 14;
  player.z = 28;
  player.y = 0.12;
  player.heading = 0.4;

  const rootHalf = view.sync(0.5);
  assert.ok(Math.abs(rootHalf.position.x - 12) < 1e-6, `expected x=12, got ${rootHalf.position.x}`);
  assert.ok(Math.abs(rootHalf.position.z - 24) < 1e-6, `expected z=24, got ${rootHalf.position.z}`);
  assert.ok(Math.abs(rootHalf.position.y - 0.20) < 1e-6, `expected y=0.20, got ${rootHalf.position.y}`);
  assert.ok(Math.abs(rootHalf.rotation.y - 0.2) < 1e-6, `expected heading=0.2, got ${rootHalf.rotation.y}`);

  // Shortest-arc heading wrap across +/-PI boundary
  player.previous = { x: 14, z: 28, y: 0, heading: Math.PI - 0.1 };
  player.x = 16;
  player.z = 30;
  player.y = 0;
  player.heading = -Math.PI + 0.1;
  const rootWrap = view.sync(0.5);
  assert.ok(Math.abs(Math.abs(rootWrap.rotation.y) - Math.PI) < 1e-6,
    `expected shortest-arc wrap near PI, got ${rootWrap.rotation.y}`);

  // Negative control: >=20m teleport snaps cleanly to (actor.x, actor.z) without smearing
  player.previous = { x: 16, z: 30, y: 0, heading: 0 };
  player.x = 46;
  player.z = 70;
  player.heading = 1.25;
  const rootSnap = view.sync(0.5);
  assert.equal(rootSnap.position.x, 46);
  assert.equal(rootSnap.position.z, 70);
  assert.ok(Math.abs(rootSnap.rotation.y - 1.25) < 1e-6);
});

test("Grand Metro City v5 uses golden-hour cinema lighting and texel-snapped player-following 2048 sun shadows", (t) => {
  const { world, player } = makeGrandCityFixture();
  const view = new WorldView(world);
  t.after(() => view.dispose());

  // Golden-hour atmosphere, hemisphere sky/sandstone fill, warm sun, and zero-shadow cool rim light
  assert.equal(view.scene.background.getHex(), 0xd8cab8);
  assert.equal(view.scene.fog.color.getHex(), 0xd8cab8);
  assert.equal(view.hemiLight.color.getHex(), 0x9dc3e6);
  assert.equal(view.hemiLight.groundColor.getHex(), 0x8d6e4e);
  assert.equal(view.sun.color.getHex(), 0xffdfad);
  assert.ok(view.sun.intensity > 2.0);
  assert.equal(view.sun.shadow.mapSize.x, 2048);
  assert.equal(view.sun.shadow.mapSize.y, 2048);
  assert.equal(view.sun.shadow.camera.left, -85);
  assert.equal(view.sun.shadow.camera.right, 85);
  assert.equal(view.sun.shadow.camera.far, 290);
  assert.ok(view.rimLight?.isDirectionalLight);
  assert.equal(view.rimLight.castShadow, false);
  assert.equal(view.rimLight.color.getHex(), 0x7faad9);

  // Move player far from origin to (340, -260) in Grand Metro City v5
  player.previous = null;
  player.x = 340;
  player.z = -260;
  view.sync(1);

  const distToPlayer = Math.hypot(
    view.sun.target.position.x - 340,
    view.sun.target.position.z - (-260),
  );
  assert.ok(distToPlayer <= 2.0, `sun target must follow within 2m of (340, -260), got dist=${distToPlayer}`);
  assert.equal(view.sun.position.x, view.sun.target.position.x - 88);
  assert.equal(view.sun.position.y, 92);
  assert.equal(view.sun.position.z, view.sun.target.position.z - 58);

  // Sub-step motion inside the 2m snap cell keeps shadow anchor rock-steady (zero texel shimmer)
  const anchorBefore = view.sun.target.position.clone();
  player.previous = { x: 340, z: -260, heading: 0 };
  player.x = 340.7;
  player.z = -259.4;
  view.sync(0.5);
  assert.deepEqual(view.sun.target.position.toArray(), anchorBefore.toArray());
});

test("3D police siren bounce lights, soft roof halos, and cruiser cornering body roll activate in chase and reset cleanly", (t) => {
  const patrol = {
    id: "patrol-alpha",
    pursuitRole: "police",
    type: "vehicle",
    kind: "sedan",
    x: 0,
    z: 0,
    y: 0,
    heading: 0.09,
    speed: 9.4,
    steer: 0.32,
    distance: 4.2,
    width: 1.88,
    length: 4.55,
    height: 1.52,
    previous: {
      x: -0.1,
      z: -0.16,
      y: 0,
      heading: 0,
      speed: 11.8,
    },
  };
  const { world, player } = makeGrandCityFixture([patrol]);
  player.x = 100;
  player.z = -80;
  player.previous = { x: 100, z: -80.2, heading: 0 };
  // Place patrol 16m behind player on the avenue
  patrol.x = player.x;
  patrol.z = player.z - 16;
  patrol.previous.x = patrol.x - 0.08;
  patrol.previous.z = patrol.z - 0.16;

  const view = new WorldView(world);
  t.after(() => view.dispose());

  // Both zero-shadow PointLights are pre-mounted at init so shaders compile once with zero runtime hitches
  const redLight = view.scene.getObjectByName("pursuit-bounce-red");
  const blueLight = view.scene.getObjectByName("pursuit-bounce-blue");
  assert.ok(redLight?.isPointLight && blueLight?.isPointLight, "pre-allocated PointLights mounted in scene");
  assert.equal(redLight.castShadow, false);
  assert.equal(blueLight.castShadow, false);
  assert.equal(view.pursuitView.diagnostics().bounceLightsActive, false);

  // Start active chase and run prepareMetro
  world.pursuit = { phase: "running", response: {} };
  world.tick = 4; // First peak of double-flash police strobe
  const cam = new THREE.PerspectiveCamera(62, 16 / 9, 0.1, 600);
  cam.position.set(player.x, 5.5, player.z - 10);

  view.sync(1);
  view.prepareMetro([cam]);

  const diagPeak = view.pursuitView.diagnostics();
  assert.equal(diagPeak.bounceLightsActive, true);
  assert.equal(diagPeak.activePatrolHalos, 1);
  const peakMax = Math.max(diagPeak.redIntensity, diagPeak.blueIntensity);
  assert.ok(peakMax >= 14 && peakMax <= 22,
    `expected near-range (<25m) strobe peak in 14..22, got ${peakMax}`);
  assert.ok(Math.abs(redLight.position.y - (0.12 + 2.35)) < 0.05,
    `bounce light sits ~2.35m above cruiser roof (${redLight.position.y})`);

  // Verify additive soft 3D halo sprites on cruiser roof
  const haloGroup = view.scene.getObjectByName("pursuit-lightbar-halos");
  const visibleHalos = haloGroup.children.filter((s) => s.isSprite && s.visible);
  assert.equal(visibleHalos.length, 2);
  for (const sprite of visibleHalos) {
    assert.equal(sprite.material.blending, THREE.AdditiveBlending);
    assert.equal(sprite.material.depthWrite, false);
    assert.equal(sprite.material.toneMapped, false);
  }

  // Advance half-cycle (20 ticks) so opposite red/blue bank dominates
  world.tick = 24;
  view.sync(1);
  view.prepareMetro([cam]);
  const diagFlip = view.pursuitView.diagnostics();
  assert.equal(diagFlip.bounceLightsActive, true);
  assert.notEqual(
    diagPeak.redIntensity > diagPeak.blueIntensity,
    diagFlip.redIntensity > diagFlip.blueIntensity,
    "police strobe alternates red and blue dominance across half-cycles",
  );

  // Verify physical cornering body roll & brake dive on the resident police cruiser
  const patrolRecord = view.roots.get(patrol.id);
  assert.ok(patrolRecord?.visual, "patrol promoted to detailed resident 3D rig");
  assert.ok(
    Math.abs(patrolRecord.visual.rotation.z) > 0.008 &&
    Math.abs(patrolRecord.visual.rotation.z) <= 0.065,
    `expected cruiser cornering body roll within (0.008, 0.065], got ${patrolRecord.visual.rotation.z}`,
  );
  assert.ok(
    patrolRecord.visual.rotation.x > 0.005 &&
    patrolRecord.visual.rotation.x <= 0.048,
    `expected cruiser brake dive pitch within (0.005, 0.048], got ${patrolRecord.visual.rotation.x}`,
  );

  // Negative control 1: patrol beyond 48m disables bounce lights cleanly
  patrol.z = player.z - 60;
  patrol.previous.z = patrol.z;
  world.tick = 25;
  view.sync(1);
  view.prepareMetro([cam]);
  assert.equal(view.pursuitView.diagnostics().bounceLightsActive, false);
  assert.equal(redLight.intensity, 0);
  assert.equal(blueLight.intensity, 0);

  // Bring patrol back to 14m, then stop pursuit -> intensities & halos reset to 0
  patrol.z = player.z - 14;
  patrol.previous.z = patrol.z;
  world.tick = 26;
  view.sync(1);
  view.prepareMetro([cam]);
  assert.equal(view.pursuitView.diagnostics().bounceLightsActive, true);

  world.pursuit.phase = "stopped";
  world.tick = 27;
  view.sync(1);
  view.prepareMetro([cam]);
  const diagStopped = view.pursuitView.diagnostics();
  assert.equal(diagStopped.bounceLightsActive, false);
  assert.equal(diagStopped.redIntensity, 0);
  assert.equal(diagStopped.blueIntensity, 0);
  assert.equal(diagStopped.activePatrolHalos, 0);
  assert.equal(redLight.castShadow, false);
  assert.equal(blueLight.castShadow, false);
});

test("createPursuitCamera damps curb climbs, street-width drops, and live follow/chasing switches without single-frame jerks", () => {
  const camera = new THREE.PerspectiveCamera(62, 16 / 9, 0.1, 600);
  const ctrl = createPursuitCamera();
  const pos = new THREE.Vector3(0, 0.12, 0);
  const dirBefore = new THREE.Vector3();
  const dirAfter = new THREE.Vector3();

  ctrl.update(camera, {
    position: pos,
    heading: 0,
    speedMps: 11.5,
    streetWidthM: 14,
    deltaS: 1 / 60,
    snap: true,
    cameraStyle: "follow",
  });

  // 1. Live toggle from "follow" to "chasing" mid-drive (snap: false) must not snap lookAt or FOV in 1 frame
  const prevPos = camera.position.clone();
  const prevFov = camera.fov;
  camera.getWorldDirection(dirBefore);
  pos.z += 11.5 / 60;
  ctrl.update(camera, {
    position: pos,
    heading: 0.02,
    speedMps: 11.5,
    streetWidthM: 14,
    deltaS: 1 / 60,
    snap: false,
    cameraStyle: "chasing",
  });
  camera.getWorldDirection(dirAfter);
  assert.ok(camera.position.distanceTo(prevPos) < 1.8,
    `smooth single-frame eye transition (${camera.position.distanceTo(prevPos)})`);
  assert.ok(dirBefore.angleTo(dirAfter) < 0.08,
    `smooth single-frame lookAt transition without snap (${dirBefore.angleTo(dirAfter)} rad)`);
  assert.ok(camera.fov > prevFov && camera.fov - prevFov < 1.2,
    `FOV ramps smoothly on frame 1 (${prevFov} -> ${camera.fov})`);

  // 2. Sudden curb step (+0.15m y & streetWidthM=0 off-asphalt) damps smoothly without vertical or width snap
  for (let i = 0; i < 30; i++) {
    pos.z += 11.5 / 60;
    ctrl.update(camera, {
      position: pos,
      heading: 0.02,
      speedMps: 11.5,
      streetWidthM: 14,
      deltaS: 1 / 60,
      snap: false,
      cameraStyle: "chasing",
    });
  }
  const beforeCurbPos = camera.position.clone();
  camera.getWorldDirection(dirBefore);
  pos.y = 0.27; // 15cm curb step
  pos.z += 10.5 / 60;
  ctrl.update(camera, {
    position: pos,
    heading: 0.03,
    speedMps: 10.5,
    streetWidthM: 0, // Temporarily off-asphalt on sidewalk
    deltaS: 1 / 60,
    snap: false,
    cameraStyle: "chasing",
  });
  camera.getWorldDirection(dirAfter);
  assert.ok(Math.abs(camera.position.y - beforeCurbPos.y) < 0.08,
    `curb step vertical camera motion is damped (${camera.position.y - beforeCurbPos.y})`);
  assert.ok(dirBefore.angleTo(dirAfter) < 0.04,
    `curb step does not jerk camera pitch (${dirBefore.angleTo(dirAfter)} rad)`);
});
