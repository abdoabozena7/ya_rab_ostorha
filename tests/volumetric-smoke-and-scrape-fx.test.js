import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import {
  CRASH_PART_KINDS,
  createCrashEffects,
  createVolumetricSmokeTexture,
} from "../src/render/crash-effects.js";

test("crash-smoke-plumes uses PlaneGeometry volumetric FBM DataTexture with zero-alpha border and 3D self-shadowed cloud relief", () => {
  const scene = new THREE.Scene();
  const fx = createCrashEffects(scene);
  const layer = scene.getObjectByName("crash-effects-layer");
  assert.ok(layer, "crash-effects-layer attached");
  assert.equal(CRASH_PART_KINDS.length, 8);

  const smokeMesh = layer.getObjectByName("crash-smoke-plumes");
  assert.ok(smokeMesh?.isInstancedMesh, "crash-smoke-plumes is a single InstancedMesh");
  assert.equal(smokeMesh.geometry.type, "PlaneGeometry", "replaced flat IcosahedronGeometry with PlaneGeometry");
  assert.notEqual(smokeMesh.geometry.type, "IcosahedronGeometry");
  assert.equal(smokeMesh.instanceMatrix.count, 220, "220-puff single-draw-call instanced pool");

  const diag = fx.diagnostics();
  assert.equal(diag.smokeGeometryType, "PlaneGeometry");
  assert.equal(diag.smokeIsVolumetricBillboard, true);
  assert.equal(diag.hasSmokeFbmTexture, true);
  assert.equal(diag.hasPerInstanceSmokeAlpha, true);

  const alphaAttr = smokeMesh.geometry.getAttribute("aSmokeAlpha");
  assert.ok(alphaAttr?.isInstancedBufferAttribute, "aSmokeAlpha is an InstancedBufferAttribute");
  assert.equal(alphaAttr.itemSize, 1);
  assert.equal(alphaAttr.count, 220);

  const tex = smokeMesh.material.map;
  assert.ok(tex?.isDataTexture, "smoke material map is a procedural DataTexture");
  assert.equal(tex.image.width, 256);
  assert.equal(tex.image.height, 256);

  const data = tex.image.data;
  const S = 256;

  // 1. Every perimeter texel MUST have alpha === 0 so quad borders never show hard edges
  for (let i = 0; i < S; i++) {
    const topAlpha = data[((S - 1) * S + i) * 4 + 3];
    const botAlpha = data[(0 * S + i) * 4 + 3];
    const leftAlpha = data[(i * S + 0) * 4 + 3];
    const rightAlpha = data[(i * S + (S - 1)) * 4 + 3];
    assert.equal(topAlpha, 0, `top border texel ${i} has alpha 0`);
    assert.equal(botAlpha, 0, `bottom border texel ${i} has alpha 0`);
    assert.equal(leftAlpha, 0, `left border texel ${i} has alpha 0`);
    assert.equal(rightAlpha, 0, `right border texel ${i} has alpha 0`);
  }

  // 2. Interior texels must have rich non-uniform organic FBM cloud alpha + 3D RGB self-shadowing
  let maxInteriorAlpha = 0;
  let wispyCount = 0;
  let minCloudLuma = 255;
  let maxCloudLuma = 0;
  const ringAlphas = [];

  for (let py = 32; py < S - 32; py++) {
    for (let px = 32; px < S - 32; px++) {
      const off = (py * S + px) * 4;
      const r = data[off];
      const g = data[off + 1];
      const b = data[off + 2];
      const a = data[off + 3];
      if (a > maxInteriorAlpha) maxInteriorAlpha = a;
      if (a >= 12 && a <= 150) wispyCount++;
      if (a > 40) {
        const luma = (r + g + b) / 3;
        minCloudLuma = Math.min(minCloudLuma, luma);
        maxCloudLuma = Math.max(maxCloudLuma, luma);
      }
      const dist = Math.hypot((px + 0.5) / S - 0.5, (py + 0.5) / S - 0.5);
      if (dist > 0.16 && dist < 0.24) ringAlphas.push(a);
    }
  }

  const ringMean = ringAlphas.reduce((s, v) => s + v, 0) / ringAlphas.length;
  const ringStd = Math.sqrt(
    ringAlphas.reduce((s, v) => s + (v - ringMean) ** 2, 0) / ringAlphas.length,
  );
  assert.ok(maxInteriorAlpha >= 175, `dense FBM cloud core reaches strong alpha (${maxInteriorAlpha})`);
  assert.ok(wispyCount >= 4000, `broad wispy FBM tendrils taper smoothly (${wispyCount} texels)`);
  assert.ok(ringStd > 12, `angular/radial FBM cloud ring is organically non-uniform (std=${ringStd.toFixed(2)})`);
  assert.ok(maxCloudLuma - minCloudLuma >= 35, `3D volumetric self-shadowing contrast in RGB (${minCloudLuma.toFixed(1)}..${maxCloudLuma.toFixed(1)})`);

  // 3. Verify onBeforeCompile injects aSmokeAlpha cleanly into Three's basic shader
  const mockShader = {
    vertexShader: THREE.ShaderLib.basic.vertexShader,
    fragmentShader: THREE.ShaderLib.basic.fragmentShader,
    uniforms: {},
  };
  smokeMesh.material.onBeforeCompile(mockShader);
  assert.ok(mockShader.vertexShader.includes("attribute float aSmokeAlpha;"));
  assert.ok(mockShader.fragmentShader.includes("diffuseColor.a *= clamp(vSmokeAlpha, 0.0, 1.0);"));

  // Standalone texture helper also produces valid 256x256 DataTexture
  const standalone = createVolumetricSmokeTexture();
  assert.equal(standalone.image.width, 256);
  standalone.dispose();

  // Verify dispose cleans up smokeTexture + geometries + materials exactly once
  let texDisposed = 0;
  tex.addEventListener("dispose", () => texDisposed++);
  fx.dispose();
  fx.dispose();
  assert.equal(texDisposed, 1, "volumetric FBM DataTexture disposed once on fx.dispose()");
});

test("smoke puff expands monotonically without end-of-life shrinking while aSmokeAlpha ramps in and dissolves smoothly", () => {
  const scene = new THREE.Scene();
  const fx = createCrashEffects(scene);
  const smokeMesh = fx.layer.getObjectByName("crash-smoke-plumes");
  const alphaAttr = smokeMesh.geometry.getAttribute("aSmokeAlpha");

  const world = {
    tick: 1,
    actors: [],
    player: {
      x: 0,
      y: 0,
      z: 0,
      heading: 0,
      speed: 4,
      vehicle: {
        damage: {
          front: 0.78,
          impactCount: 0,
          parts: { radiator: { leaking: true } },
        },
      },
    },
  };

  // Emit initial engine smoke puff on frame 1
  fx.update(world, 1 / 60);
  assert.equal(fx.diagnostics().activeSmokePuffs, 1);

  // Stop further emissions (keep impactCount: 0 so clearPlayerDebris is not triggered)
  world.player.vehicle.damage.front = 0;
  world.player.vehicle.damage.parts.radiator.leaking = false;

  const scalesX = [];
  const scalesY = [];
  const alphas = [];
  const heights = [];
  const mat = new THREE.Matrix4();
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const scl = new THREE.Vector3();

  for (let step = 0; step < 140; step++) {
    if (fx.diagnostics().activeSmokePuffs === 0) break;
    smokeMesh.getMatrixAt(0, mat);
    mat.decompose(pos, quat, scl);
    scalesX.push(scl.x);
    scalesY.push(scl.y);
    alphas.push(alphaAttr.getX(0));
    heights.push(pos.y);
    fx.update(world, 1 / 60);
  }

  assert.ok(scalesX.length >= 55, `tracked full smoke puff lifetime (${scalesX.length} frames)`);
  assert.equal(fx.diagnostics().activeSmokePuffs, 0, "puff expired cleanly at end of ttl");

  // Scale MUST expand monotonically from startScale to endScale — never shrinks at end-of-life!
  for (let i = 1; i < scalesX.length; i++) {
    assert.ok(
      scalesX[i] >= scalesX[i - 1] - 1e-5,
      `puff X scale never shrinks at step ${i} (${scalesX[i - 1]} -> ${scalesX[i]})`,
    );
    assert.ok(
      scalesY[i] >= scalesY[i - 1] - 1e-5,
      `puff Y scale never shrinks at step ${i} (${scalesY[i - 1]} -> ${scalesY[i]})`,
    );
  }
  assert.ok(scalesX[0] >= 0.25 && scalesX[0] <= 0.70, `initial puff scale in expected range (${scalesX[0]})`);
  assert.ok(
    scalesX[scalesX.length - 1] >= 1.40,
    `final puff expanded to broad cloud (${scalesX[scalesX.length - 1]})`,
  );

  // Opacity ramps in from near-zero, peaks mid-early life, and dissolves smoothly to near-zero
  const peakAlpha = Math.max(...alphas);
  const firstAlpha = alphas[0];
  const lastAlpha = alphas[alphas.length - 1];
  assert.ok(firstAlpha > 0 && firstAlpha < peakAlpha * 0.5, `smooth ramp-in (${firstAlpha} < ${peakAlpha})`);
  assert.ok(peakAlpha >= 0.32, `reaches rich peak opacity (${peakAlpha})`);
  assert.ok(lastAlpha < 0.03, `dissolves into thin air before expiry (${lastAlpha})`);

  // Buoyancy lifts puff upward
  assert.ok(heights[heights.length - 1] > heights[0] + 0.8, "smoke puff rises buoyantly");

  fx.dispose();
});

test("tilted PerspectiveCamera passed to fx.update orients smoke billboards to face camera while rotating in-plane", () => {
  const scene = new THREE.Scene();
  const fx = createCrashEffects(scene);
  const smokeMesh = fx.layer.getObjectByName("crash-smoke-plumes");

  const camera = new THREE.PerspectiveCamera(55, 16 / 9, 0.1, 400);
  camera.position.set(16, 13, -9);
  camera.lookAt(0, 1.2, 0);
  camera.updateMatrixWorld(true);

  const world = {
    tick: 1,
    actors: [],
    player: {
      x: 0,
      y: 0,
      z: 0,
      heading: 0.3,
      speed: 5,
      vehicle: {
        damage: { front: 0.65, impactCount: 0, parts: { radiator: { leaking: true } } },
      },
    },
  };

  fx.update(world, 1 / 60, camera);
  world.player.vehicle.damage.front = 0;
  world.player.vehicle.damage.parts.radiator.leaking = false;

  const camNormal = new THREE.Vector3(0, 0, 1).applyQuaternion(camera.quaternion).normalize();
  const camRight = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion).normalize();
  const camUp = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion).normalize();

  const mat = new THREE.Matrix4();
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const scl = new THREE.Vector3();

  const inPlaneAngles = [];
  for (let i = 0; i < 12; i++) {
    smokeMesh.getMatrixAt(0, mat);
    mat.decompose(pos, quat, scl);
    const puffNormal = new THREE.Vector3(0, 0, 1).applyQuaternion(quat).normalize();
    const puffRight = new THREE.Vector3(1, 0, 0).applyQuaternion(quat).normalize();

    assert.ok(
      puffNormal.dot(camNormal) > 0.9999,
      `billboard +Z normal faces tilted camera (dot=${puffNormal.dot(camNormal)})`,
    );
    assert.ok(
      Math.abs(puffRight.dot(camNormal)) < 1e-5,
      "billboard tangent lies strictly in camera plane",
    );

    const angle = Math.atan2(puffRight.dot(camUp), puffRight.dot(camRight));
    inPlaneAngles.push(angle);
    fx.update(world, 1 / 30, camera);
  }

  const angleSpan = Math.max(...inPlaneAngles) - Math.min(...inPlaneAngles);
  assert.ok(angleSpan > 0.01, `billboard curls/rotates in camera plane over time (span=${angleSpan})`);

  // Also verify onBeforeRender auto-orients smoke billboards when update(world, dt) is called without camera
  const secondCam = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 400);
  secondCam.position.set(-12, 9, 15);
  secondCam.lookAt(0, 1, 0);
  secondCam.updateMatrixWorld(true);
  fx.update(world, 1 / 60); // camera omitted
  smokeMesh.onBeforeRender(null, scene, secondCam);
  smokeMesh.getMatrixAt(0, mat);
  mat.decompose(pos, quat, scl);
  const secondNormal = new THREE.Vector3(0, 0, 1).applyQuaternion(secondCam.quaternion).normalize();
  const renderedNormal = new THREE.Vector3(0, 0, 1).applyQuaternion(quat).normalize();
  assert.ok(renderedNormal.dot(secondNormal) > 0.9999, "onBeforeRender aligns billboards to active renderCamera");

  fx.dispose();
});

test("high drift slip / tireSmokeIntensity spawns tire smoke and asphalt skid ribbons on dry roads, while water and sand suppress dry skids", () => {
  const scene = new THREE.Scene();
  const fx = createCrashEffects(scene);
  const skidMesh = fx.layer.getObjectByName("crash-tire-skid-ribbons");
  assert.ok(skidMesh?.isMesh, "crash-tire-skid-ribbons mesh mounted");
  assert.equal(skidMesh.material.polygonOffset, true);
  assert.equal(skidMesh.material.depthWrite, false);

  // 1. Positive case: dry asphalt drift + terrain elevation
  const dryWorld = {
    tick: 1,
    terrainElevationAt: (x, z) => 0.02 * x + 0.01 * z,
    actors: [],
    player: {
      x: 10,
      y: 0,
      z: 20,
      heading: 0.25,
      speed: 14,
      chaseSlipRad: 0.16,
      width: 1.85,
      length: 4.2,
      vehicle: {
        surface: { kind: "asphalt" },
        interaction: {
          tireSmokeIntensity: 0.88,
        },
        damage: { front: 0, impactCount: 0 },
      },
    },
  };

  for (let i = 0; i < 12; i++) {
    dryWorld.tick++;
    dryWorld.player.x += Math.sin(dryWorld.player.heading) * 14 * (1 / 60);
    dryWorld.player.z += Math.cos(dryWorld.player.heading) * 14 * (1 / 60);
    fx.update(dryWorld, 1 / 60);
  }

  const dryDiag = fx.diagnostics();
  assert.ok(dryDiag.activeTireSmoke >= 4, `dry drift spawned tire smoke puffs (${dryDiag.activeTireSmoke})`);
  assert.ok(dryDiag.activeSkidSegments >= 6, `dry drift stamped tire skid ribbons (${dryDiag.activeSkidSegments})`);
  assert.ok(skidMesh.geometry.drawRange.count >= 36, "skid ribbon drawRange populated");

  // Check skid vertex elevation & RGBA alpha
  const skidPos = skidMesh.geometry.getAttribute("position");
  const skidCol = skidMesh.geometry.getAttribute("color");
  assert.equal(skidCol.itemSize, 4, "skid color buffer has RGBA vertex alpha");
  const vx0 = skidPos.getX(0);
  const vy0 = skidPos.getY(0);
  const vz0 = skidPos.getZ(0);
  const expectedY = 0.121 + dryWorld.terrainElevationAt(vx0, vz0);
  assert.ok(Math.abs(vy0 - expectedY) < 0.02, `skid ribbon hugs sloped road height (${vy0} vs ${expectedY})`);
  assert.ok(skidCol.getW(0) > 0.2 && skidCol.getW(0) <= 0.72, `skid vertex alpha valid (${skidCol.getW(0)})`);

  // 2. Negative control: "water" surface suppresses dry rubber tire smoke and skid marks
  fx.reset();
  assert.equal(fx.diagnostics().activeSkidSegments, 0);
  assert.equal(fx.diagnostics().activeTireSmoke, 0);

  const wetWorld = {
    tick: 1,
    actors: [],
    player: {
      x: 0,
      y: 0,
      z: 0,
      heading: 0,
      speed: 15,
      chaseSlipRad: 0.2,
      vehicle: {
        surface: { kind: "water" },
        interaction: { tireSmokeIntensity: 0.95 },
        damage: { front: 0, impactCount: 0 },
      },
    },
  };
  for (let i = 0; i < 10; i++) {
    wetWorld.player.z += 0.25;
    fx.update(wetWorld, 1 / 60);
  }
  assert.equal(fx.diagnostics().activeTireSmoke, 0, "water surface suppresses dry rubber tire smoke");
  assert.equal(fx.diagnostics().activeSkidSegments, 0, "water surface suppresses dry rubber skid marks");

  // 3. Negative control: "sand" surface also suppresses dry rubber tire skids
  wetWorld.player.vehicle.surface.kind = "sand";
  for (let i = 0; i < 6; i++) {
    wetWorld.player.z += 0.25;
    fx.update(wetWorld, 1 / 60);
  }
  assert.equal(fx.diagnostics().activeTireSmoke, 0, "sand surface suppresses dry rubber tire smoke");
  assert.equal(fx.diagnostics().activeSkidSegments, 0, "sand surface suppresses dry rubber skid marks");

  // 4. Pursuing police cruiser drift fallback (gtaSlipMps > 2.6 && speed > 7)
  fx.reset();
  const patrol = {
    id: "patrol-drift-1",
    pursuitRole: "police",
    unitType: "interceptor",
    aiState: "PURSUING",
    health: 95,
    maxHealth: 100,
    x: -8,
    y: 0,
    z: 12,
    heading: -0.4,
    speed: 11,
    gtaSlipMps: 3.4,
  };
  const pursuitWorld = {
    tick: 1,
    actors: [patrol],
    player: { x: 0, y: 0, z: 0, heading: 0, speed: 5, vehicle: { damage: { front: 0, impactCount: 0 } } },
    pursuit: { patrols: new Set([patrol]), stepEvents: [] },
  };
  fx.update(pursuitWorld, 1 / 60);
  assert.ok(fx.diagnostics().activeTireSmoke >= 2, "drifting police cruiser emits tire smoke");
  assert.ok(fx.diagnostics().activeSkidSegments >= 2, "drifting police cruiser leaves asphalt skid marks");

  fx.dispose();
});

test("sustained barrier/curb scraping continuously emits tangential grinding sparks and friction smoke every frame, plus subtle throttle exhaust wisps", () => {
  const scene = new THREE.Scene();
  const fx = createCrashEffects(scene);

  const world = {
    tick: 1,
    actors: [],
    player: {
      x: 4,
      y: 0,
      z: 10,
      heading: 0,
      speed: 9,
      width: 1.85,
      length: 4.2,
      vehicle: {
        controls: { throttle: 0, brake: 0 },
        interaction: {
          scraping: {
            active: true,
            kind: "barrier",
            intensity: 0.8,
            tangentialSpeedMps: 9,
            worldX: 4.92,
            worldZ: 10,
            normalX: -1,
            normalZ: 0,
          },
        },
        damage: { front: 0, impactCount: 0 },
      },
    },
  };

  let prevSparks = 0;
  let prevTireSmoke = 0;
  for (let frame = 0; frame < 8; frame++) {
    world.tick++;
    world.player.z += 9 * (1 / 60);
    world.player.vehicle.interaction.scraping.worldZ = world.player.z;
    fx.update(world, 1 / 60);

    const diag = fx.diagnostics();
    assert.ok(
      diag.activeSparks > prevSparks,
      `frame ${frame + 1} emitted fresh grinding sparks (${prevSparks} -> ${diag.activeSparks})`,
    );
    assert.ok(
      diag.activeTireSmoke > prevTireSmoke,
      `frame ${frame + 1} emitted fresh scrape friction smoke (${prevTireSmoke} -> ${diag.activeTireSmoke})`,
    );
    prevSparks = diag.activeSparks;
    prevTireSmoke = diag.activeTireSmoke;
  }

  // Verify low-speed curb rub spawns dusty rubber smoke WITHOUT metal sparks, while >7.5 m/s curb rub adds rim sparks
  fx.reset();
  world.player.speed = 4.2;
  world.player.vehicle.interaction.scraping = {
    active: true,
    kind: "curb",
    intensity: 0.55,
    tangentialSpeedMps: 4.2,
    worldX: 4.92,
    worldZ: world.player.z,
    normalX: -1,
    normalZ: 0,
  };
  fx.update(world, 1 / 60);
  assert.equal(fx.diagnostics().activeSparks, 0, "moderate curb scrub produces rubber smoke without metal sparks");
  assert.ok(fx.diagnostics().activeTireSmoke >= 1, "moderate curb scrub emits dusty rubber scrub smoke");

  world.player.speed = 9.2;
  world.player.vehicle.interaction.scraping.tangentialSpeedMps = 9.2;
  fx.update(world, 1 / 60);
  assert.ok(fx.diagnostics().activeSparks >= 1, "high-speed curb graze (>7.5 m/s) emits rim grinding sparks");

  // Negative control: co-moving door rub at 11 m/s road speed with tiny 0.03 m/s relative slip emits 0 sparks and 0 friction smoke!
  fx.reset();
  world.player.speed = 11.0;
  world.player.vehicle.interaction.scraping = {
    active: true,
    kind: "vehicle",
    intensity: 0.25,
    tangentialSpeedMps: 0.03,
    worldX: 4.92,
    worldZ: world.player.z,
    normalX: -1,
    normalZ: 0,
  };
  fx.update(world, 1 / 60);
  assert.equal(fx.diagnostics().activeSparks, 0, "0.03 m/s relative tangential slip emits 0 false sparks even at 11 m/s road speed");
  assert.equal(fx.diagnostics().activeTireSmoke, 0, "0.03 m/s relative tangential slip emits 0 false friction smoke");

  // Verify all 4 contact wheels (frontLeft, frontRight, rearLeft, rearRight) emit BOTH skid AND smoke puffs strictly on their actual axle & side (0 opposite-side or symmetric drift puffs)!
  const skidPosAttr = fx.layer.getObjectByName("crash-tire-skid-ribbons").geometry.getAttribute("position");
  for (const [wheelName, expectLeft, expectRear] of [
    ["frontLeft", true, false],
    ["frontRight", false, false],
    ["rearLeft", true, true],
    ["rearRight", false, true],
  ]) {
    fx.reset();
    world.player.x = 0;
    world.player.z = 0;
    world.player.heading = 0;
    world.player.speed = 10.0;
    world.player.chaseSlip = 0.28; // Even with non-zero body slip during contact, symmetric rear drift smoke must stay suppressed!
    world.player.vehicle.controls = { throttle: 0, brake: 0 };
    world.player.vehicle.interaction.tireSmokeIntensity = 0;
    world.player.vehicle.interaction.scraping = {
      active: true,
      kind: "barrier",
      wheel: wheelName,
      side: expectLeft ? "left" : "right",
      intensity: 0.75,
      tangentialSpeedMps: 10.0,
      worldX: expectLeft ? -0.9 : 0.9,
      worldZ: expectRear ? -1.3 : 1.3,
      normalX: expectLeft ? 1 : -1,
      normalZ: 0,
    };
    for (let step = 0; step < 4; step++) fx.update(world, 1 / 60);
    const dWheel = fx.diagnostics();
    assert.equal(dWheel.activeDriftTireSmoke, 0, `${wheelName} scrape suppresses unintended symmetric rear drift smoke`);
    assert.ok(dWheel.activeScrapeSmoke >= 2, `${wheelName} scrape emits localized scrape smoke puffs`);
    for (const puff of dWheel.activeSmokePositions) {
      if (puff.kind !== "scrape" && puff.kind !== "tire") continue;
      assert.ok(
        expectLeft ? puff.x < -0.25 : puff.x > 0.25,
        `${wheelName} smoke puff at x=${puff.x} stays strictly on ${expectLeft ? "left (-X)" : "right (+X)"} side (0 opposite-side puffs)`,
      );
      assert.ok(
        expectRear ? puff.z < -0.45 : puff.z > 0.45,
        `${wheelName} smoke puff at z=${puff.z} stays strictly on ${expectRear ? "rear (-Z)" : "front (+Z)"} axle`,
      );
    }
    const sx0 = (skidPosAttr.getX(0) + skidPosAttr.getX(1)) * 0.5;
    const sz0 = (skidPosAttr.getZ(0) + skidPosAttr.getZ(2)) * 0.5;
    assert.ok(
      expectLeft ? sx0 < -0.5 : sx0 > 0.5,
      `${wheelName} scrape stamps on ${expectLeft ? "left (-X)" : "right (+X)"} side (got x=${sx0.toFixed(2)})`,
    );
    assert.ok(
      expectRear ? sz0 < -0.8 : sz0 > 0.8,
      `${wheelName} scrape stamps on ${expectRear ? "rear (-Z)" : "front (+Z)"} axle (got z=${sz0.toFixed(2)})`,
    );
  }
  world.player.chaseSlip = 0;

  // Authoritative wheel-physics state with tireSmokeIntensity === 0 must NOT emit false drift smoke on gentle turns
  fx.reset();
  world.player.x = 0;
  world.player.z = 0;
  world.player.heading = 0;
  world.player.speed = 9.0;
  world.player.chaseSlipRad = 0.065;
  world.player.vehicle.interaction = {
    tireSmokeIntensity: 0,
    wheels: {
      frontLeft: { brakeLockSlip: 0 },
      frontRight: { brakeLockSlip: 0 },
      rearLeft: { brakeLockSlip: 0 },
      rearRight: { brakeLockSlip: 0 },
    },
    scraping: { active: false },
  };
  for (let i = 0; i < 6; i++) {
    world.player.heading += 0.025; // multi-step heading advance in one render dt
    world.player.z += 0.30;
    fx.update(world, [], 1 / 60);
  }
  assert.equal(
    fx.diagnostics().activeDriftTireSmoke,
    0,
    "authoritative wheel-physics tireSmokeIntensity === 0 must prevent variable-dt false drift smoke",
  );

  // Verify subtle hard-throttle exhaust wisps at rear-left tailpipe
  fx.reset();
  world.player.speed = 5.5;
  world.player.vehicle.interaction.scraping = { active: false, intensity: 0 };
  world.player.vehicle.controls = { throttle: 0.9, brake: 0 };
  fx.update(world, 1 / 60);
  const exhaustDiag = fx.diagnostics();
  assert.equal(exhaustDiag.activeSmokePuffs, 1, "hard throttle emitted subtle exhaust tailpipe wisp");
  assert.equal(exhaustDiag.activeTireSmoke, 0, "exhaust wisp is not miscounted as tire smoke");

  // Clean single disposal across all meshes in layer (including skidMesh and smokeMesh)
  const tracked = new Map();
  fx.layer.traverse((obj) => {
    if (!obj.isMesh) return;
    for (const res of [obj.geometry, obj.material]) {
      if (!res || tracked.has(res)) continue;
      tracked.set(res, 0);
      res.addEventListener("dispose", () => tracked.set(res, tracked.get(res) + 1));
    }
  });
  fx.dispose();
  fx.dispose();
  assert.ok([...tracked.values()].every((c) => c === 1), "every geometry and material disposed once");
});
