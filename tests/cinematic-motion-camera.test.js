import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { SpatialIndex } from "../src/core/spatial-index.js";
import { createVehicleState } from "../src/core/vehicle-state.js";
import { createPlayerVehicle } from "../src/render/player-vehicle.js";
import { createPursuitCamera } from "../src/render/pursuit-camera.js";

const close = (actual, expected, tolerance = 1e-6) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `expected ${actual} to be within ${tolerance} of ${expected}`,
  );

function makeCamera(aspect = 16 / 9) {
  return new THREE.PerspectiveCamera(62, aspect, 0.1, 600);
}

function makeActor() {
  return {
    id: "player",
    type: "vehicle",
    x: 0,
    z: 0,
    heading: 0,
    distance: 0,
    length: 4.2,
    width: 1.85,
    speed: 0,
    vehicle: createVehicleState(),
  };
}

test("cinematicMotion: false preserves legacy static 62 deg FOV, upright camera.up, and zero cinematic offsets", () => {
  for (const cameraStyle of ["follow", "auto"]) {
    const camera = makeCamera();
    const ctrl = createPursuitCamera();
    const pos = new THREE.Vector3(0, 0.12, 0);
    let heading = 0;

    ctrl.update(camera, {
      position: pos,
      heading,
      speedMps: 14,
      streetWidthM: 14,
      deltaS: 1 / 60,
      snap: true,
      cameraStyle,
    });

    for (let tick = 0; tick < 45; tick++) {
      heading += 0.012;
      pos.x += Math.sin(heading) * 14 / 60;
      pos.z += Math.cos(heading) * 14 / 60;
      ctrl.update(camera, {
        position: pos,
        heading,
        speedMps: 14,
        streetWidthM: 14,
        deltaS: 1 / 60,
        cameraStyle,
        cinematicMotion: false,
        accelMps2: -6.5,
        slipRad: -0.35,
        surfaceRoughness: 0.9,
        impactPulse: 1.0,
      });
    }

    assert.equal(camera.fov, 62, `${cameraStyle} keeps static 62 deg FOV when cinematicMotion is false`);
    assert.deepEqual(camera.up.toArray(), [0, 1, 0], `${cameraStyle} keeps upright camera.up`);
    const diag = ctrl.diagnostics();
    assert.equal(diag.fov, 62);
    assert.equal(diag.rollRad, 0);
    assert.equal(diag.accelLagM, 0);
    assert.equal(diag.lateralSwingM, 0);
    assert.equal(diag.shakeAmpM, 0);
  }
});

test("cinematicMotion: true widens FOV with speed across follow and chasing, responds to longitudinal G-forces, and restores baseFov", () => {
  for (const cameraStyle of ["follow", "chasing"]) {
    const camera = makeCamera();
    const ctrl = createPursuitCamera();
    const pos = new THREE.Vector3(0, 0.12, 0);
    const dt = 1 / 60;

    // 1. Parked / crawl baseline
    ctrl.update(camera, {
      position: pos,
      heading: 0,
      speedMps: 0,
      streetWidthM: 14,
      deltaS: dt,
      snap: true,
      cameraStyle,
      cinematicMotion: true,
      accelMps2: 0,
    });
    const parkedFov = camera.fov;

    // 2. Steady high speed (16.5 m/s, zero acceleration)
    for (let i = 0; i < 90; i++) {
      pos.z += 16.5 * dt;
      ctrl.update(camera, {
        position: pos,
        heading: 0,
        speedMps: 16.5,
        streetWidthM: 14,
        deltaS: dt,
        cameraStyle,
        cinematicMotion: true,
        accelMps2: 0,
      });
    }
    const steadyFastFov = camera.fov;
    const steadyDist = camera.position.distanceTo(pos);
    assert.ok(
      steadyFastFov > parkedFov + 5.5,
      `${cameraStyle} widens FOV significantly at speed (${parkedFov} -> ${steadyFastFov})`,
    );
    assert.ok(
      Math.abs(ctrl.diagnostics().accelLagM) < 0.01,
      `${cameraStyle} accelLagM decays to ~0 at steady speed (${ctrl.diagnostics().accelLagM})`,
    );

    // 3. Hard throttle surge (accelMps2 = +6.5) pulls camera back and surges FOV wider
    for (let i = 0; i < 45; i++) {
      pos.z += 16.5 * dt;
      ctrl.update(camera, {
        position: pos,
        heading: 0,
        speedMps: 16.5,
        streetWidthM: 14,
        deltaS: dt,
        cameraStyle,
        cinematicMotion: true,
        accelMps2: 6.5,
      });
    }
    const accelDiag = ctrl.diagnostics();
    const accelDist = camera.position.distanceTo(pos);
    assert.ok(accelDiag.accelLagM > 0.65, `${cameraStyle} hard acceleration pulls boom back (${accelDiag.accelLagM})`);
    assert.ok(accelDist > steadyDist + 0.5, `${cameraStyle} physical eye pulls back under throttle G-force`);
    assert.ok(camera.fov > steadyFastFov + 0.9, `${cameraStyle} throttle surge adds extra FOV`);

    // 4. Hard braking (accelMps2 = -6.5 < -4) pushes camera in and compresses FOV
    for (let i = 0; i < 45; i++) {
      pos.z += 16.5 * dt;
      ctrl.update(camera, {
        position: pos,
        heading: 0,
        speedMps: 16.5,
        streetWidthM: 14,
        deltaS: dt,
        cameraStyle,
        cinematicMotion: true,
        accelMps2: -6.5,
      });
    }
    const brakeDiag = ctrl.diagnostics();
    const brakeDist = camera.position.distanceTo(pos);
    assert.ok(brakeDiag.accelLagM < -0.65, `${cameraStyle} hard braking surges camera forward (${brakeDiag.accelLagM})`);
    assert.ok(brakeDist < steadyDist - 0.5, `${cameraStyle} physical eye moves closer under braking`);
    assert.ok(camera.fov < steadyFastFov - 1.0, `${cameraStyle} hard braking compresses FOV`);

    // 5. Return to steady speed -> accelLagM decays cleanly back to ~0
    for (let i = 0; i < 90; i++) {
      pos.z += 16.5 * dt;
      ctrl.update(camera, {
        position: pos,
        heading: 0,
        speedMps: 16.5,
        streetWidthM: 14,
        deltaS: dt,
        cameraStyle,
        cinematicMotion: true,
        accelMps2: 0,
      });
    }
    assert.ok(Math.abs(ctrl.diagnostics().accelLagM) < 0.015);
  }

  // Finite-difference acceleration fallback (when accelMps2 is omitted) and clean baseFov restoration
  const fdCam = makeCamera();
  const fdCtrl = createPursuitCamera();
  const fdPos = new THREE.Vector3(0, 0.12, 0);
  const dt = 1 / 60;
  let speed = 2;
  fdCtrl.update(fdCam, {
    position: fdPos, heading: 0, speedMps: speed, streetWidthM: 14,
    deltaS: dt, snap: true, cameraStyle: "follow", cinematicMotion: true,
  });
  for (let i = 0; i < 45; i++) {
    speed += 5.5 * dt;
    fdPos.z += speed * dt;
    fdCtrl.update(fdCam, {
      position: fdPos, heading: 0, speedMps: speed, streetWidthM: 14,
      deltaS: dt, cameraStyle: "follow", cinematicMotion: true,
    });
  }
  assert.ok(fdCtrl.diagnostics().accelLagM > 0.35, "finite-difference acceleration drives positive accelLagM");

  // Disabling cinematicMotion in follow mode restores baseFov (62 deg)
  for (let i = 0; i < 90; i++) {
    fdPos.z += speed * dt;
    fdCtrl.update(fdCam, {
      position: fdPos, heading: 0, speedMps: speed, streetWidthM: 14,
      deltaS: dt, cameraStyle: "follow", cinematicMotion: false,
    });
  }
  assert.equal(fdCam.fov, 62, "turning off cinematicMotion cleanly restores baseFov");
});

test("high-speed cornering banks horizon and swings into apex on wide avenues while clamping lateral swing in 3.8 m alleys", () => {
  const dt = 1 / 60;
  const speedMps = 14.5;
  const turnStep = 0.65 * dt;

  // Compare cinematic follow vs legacy follow on a wide 14 m avenue corner
  const cineCam = makeCamera();
  const legacyCam = makeCamera();
  const cineCtrl = createPursuitCamera();
  const legacyCtrl = createPursuitCamera();
  const pos = new THREE.Vector3(0, 0.12, 0);
  let heading = 0;

  cineCtrl.update(cineCam, {
    position: pos, heading, speedMps, streetWidthM: 14,
    deltaS: dt, snap: true, cameraStyle: "follow", cinematicMotion: true, surfaceRoughness: 0.08,
  });
  legacyCtrl.update(legacyCam, {
    position: pos, heading, speedMps, streetWidthM: 14,
    deltaS: dt, snap: true, cameraStyle: "follow", cinematicMotion: false,
  });

  for (let tick = 0; tick < 50; tick++) {
    heading += turnStep;
    pos.x += Math.sin(heading) * speedMps * dt;
    pos.z += Math.cos(heading) * speedMps * dt;
    cineCtrl.update(cineCam, {
      position: pos, heading, speedMps, streetWidthM: 14,
      deltaS: dt, cameraStyle: "follow", cinematicMotion: true, slipRad: -0.22, surfaceRoughness: 0.08,
    });
    legacyCtrl.update(legacyCam, {
      position: pos, heading, speedMps, streetWidthM: 14,
      deltaS: dt, cameraStyle: "follow", cinematicMotion: false,
    });
  }

  const diag = cineCtrl.diagnostics();
  assert.ok(
    Math.abs(diag.rollRad) >= 0.012 && Math.abs(diag.rollRad) <= 0.052,
    `expected horizon bank in [0.012, 0.052], got ${diag.rollRad}`,
  );
  close(cineCam.up.length(), 1, 1e-6);
  assert.ok(Math.abs(cineCam.up.x) > 0.01 || Math.abs(cineCam.up.z) > 0.01, "camera.up tilts around forward axis");
  assert.ok(Math.abs(diag.lateralSwingM) > 0.3, `expected lateral apex swing on 14 m avenue, got ${diag.lateralSwingM}`);
  assert.ok(cineCam.position.distanceTo(legacyCam.position) > 0.15, "cinematic lateral swing shifts camera shoulder");

  // Narrow 3.8 m alley clamps lateralSwingM strictly to 0
  const alleyCam = makeCamera();
  const alleyCtrl = createPursuitCamera();
  const alleyPos = new THREE.Vector3(0, 0.12, 0);
  alleyCtrl.update(alleyCam, {
    position: alleyPos,
    heading: 0,
    speedMps: 11,
    streetWidthM: 3.8,
    deltaS: dt,
    snap: true,
    cameraStyle: "follow",
    cinematicMotion: true,
    slipRad: -0.4,
  });
  for (let tick = 0; tick < 30; tick++) {
    alleyPos.z += 11 * dt;
    alleyCtrl.update(alleyCam, {
      position: alleyPos,
      heading: 0,
      speedMps: 11,
      streetWidthM: 3.8,
      deltaS: dt,
      cameraStyle: "follow",
      cinematicMotion: true,
      slipRad: -0.4,
    });
  }
  assert.equal(alleyCtrl.diagnostics().lateralSwingM, 0, "narrow 3.8 m alley must clamp lateralSwingM to 0");
  assert.ok(Math.abs(alleyCam.position.x - alleyPos.x) < 0.05, "camera stays centered between narrow alley walls");
});

test("surface roughness and impactPulse drive bounded lens micro-vibration without pushing camera.position into walls", () => {
  const dt = 1 / 60;
  const pos = new THREE.Vector3(0, 0.12, 0);

  const smoothCam = makeCamera();
  const roughCam = makeCamera();
  const smoothCtrl = createPursuitCamera();
  const roughCtrl = createPursuitCamera();

  smoothCtrl.update(smoothCam, {
    position: pos, heading: 0, speedMps: 15, streetWidthM: 14,
    deltaS: dt, snap: true, cinematicMotion: true, surfaceRoughness: 0.08,
  });
  roughCtrl.update(roughCam, {
    position: pos, heading: 0, speedMps: 15, streetWidthM: 14,
    deltaS: dt, snap: true, cinematicMotion: true, surfaceRoughness: 1.0,
  });

  const smoothAmp = smoothCtrl.diagnostics().shakeAmpM;
  const roughAmp = roughCtrl.diagnostics().shakeAmpM;
  assert.ok(smoothAmp > 0 && smoothAmp < 0.01, `smooth road micro-vibration bounded (${smoothAmp})`);
  assert.ok(roughAmp > smoothAmp * 2.5 && roughAmp <= 0.025, `rough road amplifies vibration (${roughAmp})`);

  // Impact pulse spikes shakeAmpM and decays cleanly
  roughCtrl.update(roughCam, {
    position: pos, heading: 0, speedMps: 15, streetWidthM: 14,
    deltaS: dt, cinematicMotion: true, surfaceRoughness: 0.2, impactPulse: 1.0,
  });
  const impactPeak = roughCtrl.diagnostics().shakeAmpM;
  assert.ok(impactPeak > 0.05 && impactPeak < 0.09, `impactPulse produces bounded spike (${impactPeak})`);
  for (let i = 0; i < 60; i++) {
    roughCtrl.update(roughCam, {
      position: pos, heading: 0, speedMps: 15, streetWidthM: 14,
      deltaS: dt, cinematicMotion: true, surfaceRoughness: 0.2, impactPulse: 0,
    });
  }
  assert.ok(roughCtrl.diagnostics().shakeAmpM < 0.015, "impactShake damps back down after contact");

  // Tight corridor + rear wall collision guard under combined G-force lag, swing, roughness, and impactPulse
  const walls = [
    { id: "rear-wall", kind: "building", x: 0, z: -4.8, y: 0.12, width: 12, length: 1.6, height: 18, heading: 0 },
    { id: "left-wall", kind: "building", x: -3.2, z: 0, y: 0.12, width: 1.6, length: 24, height: 18, heading: 0 },
    { id: "right-wall", kind: "building", x: 3.2, z: 0, y: 0.12, width: 1.6, length: 24, height: 18, heading: 0 },
  ];
  const staticIndex = new SpatialIndex(walls);
  const insideAnyWall = (p) => walls.some((w) =>
    Math.abs(p.x - w.x) < w.width / 2 + 0.35 &&
    Math.abs(p.z - w.z) < w.length / 2 + 0.35 &&
    p.y < w.y + w.height,
  );

  const guardedCam = makeCamera();
  const guardedCtrl = createPursuitCamera();
  const carPos = new THREE.Vector3(0, 0.12, 0);
  guardedCtrl.update(guardedCam, {
    position: carPos, heading: 0, speedMps: 14, streetWidthM: 12,
    staticIndex, deltaS: dt, snap: true, cameraStyle: "chasing",
    cinematicMotion: true, accelMps2: 9, slipRad: -0.55, surfaceRoughness: 1.0, impactPulse: 1.0,
  });
  assert.equal(insideAnyWall(guardedCam.position), false, "snap eye stays clear of walls");

  for (let tick = 0; tick < 60; tick++) {
    const heading = Math.sin(tick * 0.15) * 0.28;
    guardedCtrl.update(guardedCam, {
      position: carPos, heading, speedMps: 14, streetWidthM: 12,
      staticIndex, deltaS: dt, cameraStyle: "chasing",
      cinematicMotion: true, accelMps2: 9, slipRad: -0.55, surfaceRoughness: 1.0, impactPulse: 1.0,
    });
    assert.equal(insideAnyWall(guardedCam.position), false, `camera.position clears all walls at tick ${tick}`);
  }
});

test("createPlayerVehicle interpolates sub-frame alpha, modulates suv-road-light-pools on braking/damage/cutaway, and disposes cleanly", () => {
  const actor = makeActor();
  const rig = createPlayerVehicle(null, actor);

  // 1. Sub-frame alpha = 0.5 interpolation of suspension weight transfer & rolling/steering hardware
  const prevState = createVehicleState();
  prevState.suspension.heaveM = -0.02;
  prevState.suspension.pitchRad = -0.04;
  prevState.suspension.rollRad = 0.02;
  prevState.wheelSpinRad = 0.4;
  prevState.wheelAngles = { frontLeft: 0.1, frontRight: 0.12 };
  actor.previous = { vehicle: prevState };

  actor.vehicle.suspension.heaveM = 0.04;
  actor.vehicle.suspension.pitchRad = 0.08;
  actor.vehicle.suspension.rollRad = -0.06;
  actor.vehicle.wheelSpinRad = 1.2;
  actor.vehicle.wheelAngles = { frontLeft: 0.3, frontRight: 0.36 };

  rig.update(actor, null, 0.5);
  const chassis = rig.root.getObjectByName("player-chassis");
  const flPivot = rig.root.getObjectByName("wheel-front-left");
  const flSpin = rig.root.getObjectByName("wheel-front-left-spin");

  close(chassis.position.y, 0.01);
  close(chassis.rotation.x, 0.02);
  close(chassis.rotation.z, -0.02);
  close(flSpin.rotation.x, 0.8);
  close(flPivot.rotation.y, 0.2);
  close(rig.diagnostics.alpha, 0.5);

  // Expressive extended clamp bounds (+/-0.115 rad pitch/roll, +/-0.055 m heave) & >= PI spin jump guard
  actor.previous.vehicle.wheelSpinRad = 0.1;
  actor.vehicle.wheelSpinRad = 4.0;
  actor.previous.vehicle.suspension.pitchRad = 0.15;
  actor.vehicle.suspension.pitchRad = 0.15;
  actor.previous.vehicle.suspension.heaveM = -0.08;
  actor.vehicle.suspension.heaveM = -0.08;
  rig.update(actor, null, 0.5);
  close(flSpin.rotation.x, 4.0);
  close(chassis.rotation.x, 0.115);
  close(chassis.position.y, -0.055);

  // 2. Dusk practical road light pools ("suv-road-light-pools")
  const pools = rig.root.getObjectByName("suv-road-light-pools");
  const leftPool = rig.root.getObjectByName("suv-headlamp-pool-left");
  const rightPool = rig.root.getObjectByName("suv-headlamp-pool-right");
  const tailPool = rig.root.getObjectByName("suv-tail-pool");
  const leftLamp = rig.root.getObjectByName("suv-headlamp--1-0.895");

  assert.ok(pools && leftPool && rightPool && tailPool, "road light pool group and beams exist");
  close(pools.position.y, 0.022);
  assert.equal(pools.renderOrder, 2);
  assert.equal(leftPool.material.blending, THREE.AdditiveBlending);
  assert.equal(leftPool.material.depthWrite, false);
  assert.equal(leftPool.material.toneMapped, false);
  assert.ok(leftPool.material.map?.isDataTexture, "uses procedural 64x64 DataTexture");
  assert.equal(leftPool.material.map.image.width, 64);
  assert.equal(leftPool.material.map.image.height, 64);
  assert.ok(leftLamp.material.emissiveIntensity >= 0.85, "intact headlamp lens shines crisply at dusk");

  // Pristine unbraked intensities
  actor.previous = null;
  actor.vehicle = createVehicleState();
  rig.update(actor);
  assert.equal(pools.visible, true);
  close(leftPool.material.opacity, 0.24);
  close(rightPool.material.opacity, 0.24);
  close(tailPool.material.opacity, 0.08);

  // Braking surges rear ruby road glow
  actor.vehicle.controls.brake = 0.85;
  rig.update(actor);
  close(tailPool.material.opacity, 0.16 + 0.85 * 0.28);

  // Shattered left headlamp kills left beam; cracked right headlamp dims right beam; shattered tail lamps dim/kill rear glow
  actor.vehicle.damage = {
    ...actor.vehicle.damage,
    front: 0.5,
    rear: 0.6,
    total: 0.75,
    impactCount: 2,
    parts: {
      headlampLeft: "shattered",
      headlampRight: "cracked",
      tailLampLeft: "shattered",
      tailLampRight: "intact",
    },
  };
  rig.update(actor);
  assert.equal(leftPool.visible, false);
  assert.equal(leftPool.material.opacity, 0);
  assert.equal(rightPool.visible, true);
  close(rightPool.material.opacity, 0.09);
  close(tailPool.material.opacity, (0.16 + 0.85 * 0.28) * 0.5);

  actor.vehicle.damage.parts.tailLampRight = "shattered";
  rig.update(actor);
  assert.equal(tailPool.visible, false);
  assert.equal(tailPool.material.opacity, 0);

  // Restore right tail lamp so cutaway visibility toggle on active pools is verified too
  actor.vehicle.damage.parts.tailLampRight = "intact";
  rig.update(actor);
  assert.equal(tailPool.visible, true);

  // Cutaway hides and restores suv-road-light-pools
  rig.setInspection({ cutaway: true });
  assert.equal(pools.visible, false);
  rig.setInspection({ cutaway: false });
  assert.equal(pools.visible, true);

  // 3. Idempotent disposal cleans up every geometry, material, and procedural DataTexture once
  const tracked = new Set([leftPool.material.map]);
  rig.root.traverse((part) => {
    if (part.geometry) tracked.add(part.geometry);
    if (part.material) tracked.add(part.material);
  });
  const counts = new Map([...tracked].map((r) => [r, 0]));
  for (const res of tracked) {
    res.addEventListener("dispose", () => counts.set(res, counts.get(res) + 1));
  }
  rig.dispose();
  rig.dispose();
  assert.ok([...counts.values()].every((c) => c === 1), "all geometries, materials, and DataTexture dispose once");
});
