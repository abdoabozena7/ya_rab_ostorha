import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { CRASH_PART_KINDS, createCrashEffects } from "../src/render/crash-effects.js";

test("createCrashEffects preserves all 3D breakable part debris kinds alongside volumetric FBM smoke billboards", (t) => {
  const scene = new THREE.Scene();
  const fx = createCrashEffects(scene);
  t.after(() => fx.dispose());

  assert.ok(CRASH_PART_KINDS.includes("hood-panel"));
  assert.ok(CRASH_PART_KINDS.includes("bumper-corner"));
  assert.ok(CRASH_PART_KINDS.includes("side-mirror"));
  assert.ok(CRASH_PART_KINDS.includes("spare-cover"));

  fx.spawnBurst({
    x: 4,
    y: 0.12,
    z: -6,
    heading: 0.3,
    vx: 2,
    vz: 8,
    side: "front",
    energyJ: 52000,
    parts: ["hood-panel", "bumper-corner", "license-plate"],
    shatterGlass: true,
    owner: "player",
  });

  const diag = fx.diagnostics();
  assert.equal(diag.activeDebris, 3);
  assert.ok(diag.activeGlass > 0);
  assert.ok(diag.activeSparks > 0);
  assert.equal(diag.smokeIsVolumetricBillboard, true);
  assert.equal(diag.hasSmokeFbmTexture, true);
  assert.equal(diag.hasPerInstanceSmokeAlpha, true);
});
