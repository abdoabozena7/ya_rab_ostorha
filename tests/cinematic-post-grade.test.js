import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import {
  DEFAULT_CINEMATIC_GRADE,
  evaluateCinematicGradePixel,
  createCinematicPost,
} from "../src/render/cinematic-post.js";

function luma([r, g, b]) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function hsvSaturation([r, g, b]) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max <= 1e-7 ? 0 : (max - min) / max;
}

function createStubRenderer({
  isWebGL2 = true,
  width = 1280,
  height = 720,
  pixelRatio = 1,
  outputColorSpace = THREE.SRGBColorSpace,
  sceneDrawCalls = 42,
  sceneTriangles = 18400,
} = {}) {
  let currentTarget = null;
  const calls = [];
  const info = {
    autoReset: true,
    render: { calls: 0, triangles: 0 },
  };

  const renderer = {
    capabilities: { isWebGL2 },
    outputColorSpace,
    toneMapping: THREE.ACESFilmicToneMapping,
    toneMappingExposure: 1.04,
    autoClear: true,
    info,
    getSize(out) {
      out.set(width, height);
      return out;
    },
    getPixelRatio() {
      return pixelRatio;
    },
    getRenderTarget() {
      return currentTarget;
    },
    setRenderTarget(target) {
      currentTarget = target;
      calls.push({ op: "setRenderTarget", target });
    },
    render(scene, camera) {
      const isPostPass = scene?.name === "cinematic-post-scene";
      if (info.autoReset) {
        info.render.calls = 0;
        info.render.triangles = 0;
      }
      if (isPostPass) {
        info.render.calls += 1;
        info.render.triangles += 1;
      } else {
        info.render.calls += sceneDrawCalls;
        info.render.triangles += sceneTriangles;
      }
      calls.push({
        op: "render",
        scene,
        sceneName: scene?.name ?? "scene",
        isPostPass,
        target: currentTarget,
        autoClear: renderer.autoClear,
        camera,
      });
    },
    calls,
  };

  return renderer;
}

test("DEFAULT_CINEMATIC_GRADE is frozen and matches film-grade specification", () => {
  assert.equal(Object.isFrozen(DEFAULT_CINEMATIC_GRADE), true);
  assert.equal(Object.isFrozen(DEFAULT_CINEMATIC_GRADE.shadowTint), true);
  assert.equal(Object.isFrozen(DEFAULT_CINEMATIC_GRADE.highlightTint), true);

  assert.equal(DEFAULT_CINEMATIC_GRADE.exposure, 0.82);
  assert.equal(DEFAULT_CINEMATIC_GRADE.contrast, 1.26);
  assert.equal(DEFAULT_CINEMATIC_GRADE.shadowToe, 0.085);
  assert.equal(DEFAULT_CINEMATIC_GRADE.highlightShoulder, 0.90);
  assert.equal(DEFAULT_CINEMATIC_GRADE.saturation, 0.62);
  assert.deepEqual(DEFAULT_CINEMATIC_GRADE.shadowTint, [0.075, 0.102, 0.138]);
  assert.deepEqual(DEFAULT_CINEMATIC_GRADE.highlightTint, [0.93, 0.88, 0.79]);
  assert.equal(DEFAULT_CINEMATIC_GRADE.vignette, 0.34);
  assert.equal(DEFAULT_CINEMATIC_GRADE.grain, 0.014);
  assert.equal(DEFAULT_CINEMATIC_GRADE.maxSpeedStreak, 0.022);
  assert.equal(DEFAULT_CINEMATIC_GRADE.maxChromaticFringe, 0.0026);
});

test("evaluateCinematicGradePixel darkens washed-out midday colors (>=22% luma drop) and mutes saturation (>=28% HSV drop, muting loud greens)", () => {
  const middayStone = [0.82, 0.78, 0.71];
  const loudFoliage = [0.55, 0.72, 0.45];

  const gradedStone = evaluateCinematicGradePixel(middayStone, [0.5, 0.5]);
  const gradedFoliage = evaluateCinematicGradePixel(loudFoliage, [0.5, 0.5]);

  const stoneLumaDrop = 1 - luma(gradedStone) / luma(middayStone);
  const foliageLumaDrop = 1 - luma(gradedFoliage) / luma(loudFoliage);
  assert.ok(
    stoneLumaDrop >= 0.22,
    `expected sunlit stone luma to drop >= 22%, got ${(stoneLumaDrop * 100).toFixed(2)}%`,
  );
  assert.ok(
    foliageLumaDrop >= 0.22,
    `expected loud foliage luma to drop >= 22%, got ${(foliageLumaDrop * 100).toFixed(2)}%`,
  );

  const stoneSatDrop = 1 - hsvSaturation(gradedStone) / hsvSaturation(middayStone);
  const foliageSatDrop = 1 - hsvSaturation(gradedFoliage) / hsvSaturation(loudFoliage);
  assert.ok(
    stoneSatDrop >= 0.28,
    `expected sunlit stone HSV saturation to drop >= 28%, got ${(stoneSatDrop * 100).toFixed(2)}%`,
  );
  assert.ok(
    foliageSatDrop >= 0.28,
    `expected loud foliage HSV saturation to drop >= 28%, got ${(foliageSatDrop * 100).toFixed(2)}%`,
  );
  assert.ok(
    foliageSatDrop > stoneSatDrop,
    `expected loud greens (${(foliageSatDrop * 100).toFixed(2)}%) to be muted more aggressively than stone (${(stoneSatDrop * 100).toFixed(2)}%)`,
  );
});

test("S-curve contrast expands dynamic range, tints deep shadows cool (b > r), and stays strictly within [0, 1] without NaN", () => {
  const darkShadow = [0.14, 0.14, 0.15];
  const brightStone = [0.82, 0.79, 0.73];

  const outShadow = evaluateCinematicGradePixel(darkShadow, [0.5, 0.5]);
  const outStone = evaluateCinematicGradePixel(brightStone, [0.5, 0.5]);

  // Dynamic range expansion: contrast ratio & Michelson contrast increase sharply, and S-curve
  // expands separation relative to a flat contrast=1.0, shadowToe=0 exposure curve.
  const inRatio = luma(brightStone) / luma(darkShadow);
  const outRatio = luma(outStone) / luma(outShadow);
  assert.ok(
    outRatio > inRatio * 2.2,
    `expected dynamic range ratio to expand >2.2x (in=${inRatio.toFixed(2)}, out=${outRatio.toFixed(2)})`,
  );

  const flatCfg = { ...DEFAULT_CINEMATIC_GRADE, contrast: 1.0, shadowToe: 0 };
  const flatSpan =
    luma(evaluateCinematicGradePixel(brightStone, [0.5, 0.5], {}, flatCfg)) -
    luma(evaluateCinematicGradePixel(darkShadow, [0.5, 0.5], {}, flatCfg));
  const curvedSpan = luma(outStone) - luma(outShadow);
  assert.ok(
    curvedSpan > flatSpan,
    `expected S-curve + toe luma span (${curvedSpan.toFixed(4)}) to exceed flat exposure span (${flatSpan.toFixed(4)})`,
  );

  // Midtone distribution p95 - p10 expands in absolute luma while mean luma becomes moodier/darker
  const midSamples = Array.from({ length: 20 }, (_, i) => {
    const v = 0.28 + (i / 19) * 0.38;
    return [v, v, v];
  });
  const inMid = midSamples.map(luma);
  const outMid = midSamples.map((c) => luma(evaluateCinematicGradePixel(c, [0.5, 0.5])));
  const pct = (arr, q) => arr[Math.floor((arr.length - 1) * q)];
  const inP95P10 = pct(inMid, 0.95) - pct(inMid, 0.10);
  const outP95P10 = pct(outMid, 0.95) - pct(outMid, 0.10);
  const mean = (arr) => arr.reduce((sum, v) => sum + v, 0) / arr.length;
  assert.ok(
    outP95P10 > inP95P10,
    `expected midtone p95-p10 to expand (in=${inP95P10.toFixed(4)}, out=${outP95P10.toFixed(4)})`,
  );
  assert.ok(mean(outMid) < mean(inMid) * 0.75, "expected mean midtone luma to drop into dark cinema mood");

  // Deep shadow split-tone stays cool charcoal-slate (b > r)
  assert.ok(
    outShadow[2] > outShadow[0],
    `expected cool shadow split-tone (b=${outShadow[2].toFixed(4)} > r=${outShadow[0].toFixed(4)})`,
  );

  // Exhaustive [0..1]^3 lattice sweep + adversarial NaN/out-of-bounds inputs
  const steps = [0, 0.05, 0.14, 0.28, 0.42, 0.58, 0.76, 0.9, 1];
  for (const r of steps) {
    for (const g of steps) {
      for (const b of steps) {
        const out = evaluateCinematicGradePixel([r, g, b], [0.12, 0.88], { timeS: 2.4 });
        assert.equal(out.length, 3);
        for (const ch of out) {
          assert.equal(Number.isFinite(ch), true, `non-finite channel for [${r},${g},${b}]`);
          assert.ok(ch >= 0 && ch <= 1, `out-of-range channel ${ch} for [${r},${g},${b}]`);
        }
      }
    }
  }

  const sanitized = evaluateCinematicGradePixel([-0.5, 1.8, Number.NaN], [Number.NaN, 2.0]);
  for (const ch of sanitized) {
    assert.equal(Number.isFinite(ch), true);
    assert.ok(ch >= 0 && ch <= 1);
  }
});

test("emergency police strobe reds and blues retain higher relative chroma than muted pastel walls and foliage", () => {
  const strobeRed = [0.95, 0.15, 0.12];
  const strobeBlue = [0.12, 0.35, 0.98];
  const pastelWall = [0.82, 0.78, 0.71];
  const foliage = [0.55, 0.72, 0.45];

  const retainedRatio = (rgb) =>
    hsvSaturation(evaluateCinematicGradePixel(rgb, [0.5, 0.5])) / hsvSaturation(rgb);

  const redRetention = retainedRatio(strobeRed);
  const blueRetention = retainedRatio(strobeBlue);
  const wallRetention = retainedRatio(pastelWall);
  const foliageRetention = retainedRatio(foliage);

  assert.ok(
    redRetention > 0.85 && redRetention > wallRetention + 0.18 && redRetention > foliageRetention + 0.22,
    `expected police red chroma retention (${redRetention.toFixed(3)}) to exceed wall (${wallRetention.toFixed(3)}) and foliage (${foliageRetention.toFixed(3)})`,
  );
  assert.ok(
    blueRetention > 0.85 && blueRetention > wallRetention + 0.18 && blueRetention > foliageRetention + 0.22,
    `expected police blue chroma retention (${blueRetention.toFixed(3)}) to exceed wall (${wallRetention.toFixed(3)}) and foliage (${foliageRetention.toFixed(3)})`,
  );
});

test("anamorphic optical vignette darkens corner uv=[0.04, 0.04] by >=20% compared to center uv=[0.5, 0.5]", () => {
  const sample = [0.72, 0.70, 0.66];
  const center = evaluateCinematicGradePixel(sample, [0.5, 0.5]);
  const corner = evaluateCinematicGradePixel(sample, [0.04, 0.04]);

  const cornerDarkening = 1 - luma(corner) / luma(center);
  assert.ok(
    cornerDarkening >= 0.20,
    `expected corner vignette darkening >= 20%, got ${(cornerDarkening * 100).toFixed(2)}%`,
  );

  // Anamorphic oval aspect check: horizontal edge [0.05, 0.5] darkens slightly more than vertical edge [0.5, 0.05]
  const leftEdge = evaluateCinematicGradePixel(sample, [0.05, 0.5]);
  const bottomEdge = evaluateCinematicGradePixel(sample, [0.5, 0.05]);
  assert.ok(
    luma(leftEdge) < luma(bottomEdge),
    "expected anamorphic horizontal vignette weighting (1.12) to darken slightly more than vertical (0.94)",
  );
});

test("createCinematicPost manages renderTarget, uniforms, reducedMotion, enabled:false bypass, diagnostics, and idempotent dispose", () => {
  const renderer = createStubRenderer({
    isWebGL2: true,
    width: 1280,
    height: 720,
    pixelRatio: 1.5,
    sceneDrawCalls: 58,
    sceneTriangles: 24600,
  });

  const post = createCinematicPost(renderer);
  const scene = new THREE.Scene();
  scene.name = "metro-city-scene";
  const camera = new THREE.PerspectiveCamera(62, 16 / 9, 0.1, 950);

  // Initial WebGL2 target & single fullscreen triangle check
  const initDiag = post.diagnostics();
  assert.equal(initDiag.width, 1920);
  assert.equal(initDiag.height, 1080);
  assert.equal(initDiag.samples, 4);
  assert.equal(initDiag.enabled, true);
  assert.equal(initDiag.disposed, false);
  assert.equal(post.target.texture.colorSpace, THREE.SRGBColorSpace);
  assert.equal(post.material.toneMapped, false);
  assert.equal(post.material.depthTest, false);
  assert.equal(post.material.depthWrite, false);

  // Verify every uniform referenced in fragmentShader is bound on post.uniforms
  const declaredUniforms = [...post.material.fragmentShader.matchAll(/uniform\s+\w+\s+(\w+)\s*;/g)].map(
    (m) => m[1],
  );
  assert.ok(declaredUniforms.length >= 12);
  for (const name of declaredUniforms) {
    assert.ok(name in post.uniforms, `missing uniform binding for ${name}`);
  }
  assert.match(post.material.fragmentShader, /smoothstep\(0\.30,\s*0\.96,\s*radialDist\)/);

  // Resize updates dimensions only when changed
  let targetDisposeCount = 0;
  post.target.addEventListener("dispose", () => {
    targetDisposeCount += 1;
  });
  post.setSize(1280, 720, 1.5); // unchanged -> no re-allocation
  assert.equal(targetDisposeCount, 0);
  post.setSize(1600, 900, 1.25); // 2000 x 1125
  assert.equal(targetDisposeCount, 1);
  assert.equal(post.diagnostics().width, 2000);
  assert.equal(post.diagnostics().height, 1125);

  // Active high-speed render updates uniforms, preserves autoClear, and records telemetry
  renderer.calls.length = 0;
  post.render(scene, camera, {
    speedNorm: 0.92,
    turnNorm: -0.5,
    impactPulse: 0.4,
    timeS: 12.5,
    reducedMotion: false,
    enabled: true,
  });

  assert.equal(renderer.autoClear, true, "renderer.autoClear must be restored after post render");
  assert.equal(renderer.getRenderTarget(), null, "renderTarget must be restored to null");
  assert.ok(post.uniforms.uStreak.value > 0.015, `expected active uStreak > 0.015, got ${post.uniforms.uStreak.value}`);
  assert.equal(post.uniforms.uGrain.value, DEFAULT_CINEMATIC_GRADE.grain);
  assert.ok(post.uniforms.uFringe.value > 0);
  assert.ok(Math.abs(post.uniforms.uCenter.value.x - (0.5 - 0.5 * 0.06)) < 1e-6);
  assert.ok(Math.abs(post.uniforms.uCenter.value.y - 0.52) < 1e-6);
  assert.equal(post.uniforms.uTime.value, 12.5);

  const activeDiag = post.diagnostics();
  assert.equal(activeDiag.postCalls, 1);
  assert.equal(activeDiag.sceneCalls, 58);
  assert.equal(activeDiag.sceneTriangles, 24600);
  assert.equal(renderer.info.render.calls, 59, "scene calls + 1 post triangle draw call preserved in renderer.info");
  assert.equal(renderer.info.render.triangles, 24601);

  const renderOps = renderer.calls.filter((c) => c.op === "render");
  assert.equal(renderOps.length, 2);
  assert.equal(renderOps[0].target, post.target);
  assert.equal(renderOps[0].isPostPass, false);
  assert.equal(renderOps[1].target, null);
  assert.equal(renderOps[1].isPostPass, true);
  const postMesh = renderOps[1].scene.children[0];
  assert.equal(postMesh.frustumCulled, false);
  assert.deepEqual(
    Array.from(postMesh.geometry.getAttribute("position").array),
    [-1, -1, 0, 3, -1, 0, -1, 3, 0],
  );
  assert.deepEqual(
    Array.from(postMesh.geometry.getAttribute("uv").array),
    [0, 0, 2, 0, 0, 2],
  );
  assert.equal(renderOps[1].camera.isOrthographicCamera, true);
  assert.equal(renderOps[1].camera.left, -1);
  assert.equal(renderOps[1].camera.right, 1);
  assert.equal(renderOps[1].camera.top, 1);
  assert.equal(renderOps[1].camera.bottom, -1);

  // reducedMotion zeroes uStreak and uGrain (and CPU grain)
  post.render(scene, camera, {
    speedNorm: 1.0,
    turnNorm: 0.25,
    impactPulse: 1.0,
    timeS: 13.0,
    reducedMotion: true,
    enabled: true,
  });
  assert.equal(post.uniforms.uStreak.value, 0);
  assert.equal(post.uniforms.uGrain.value, 0);
  assert.equal(post.uniforms.uFringe.value, 0);
  assert.deepEqual(
    evaluateCinematicGradePixel([0.5, 0.5, 0.5], [0.33, 0.67], { timeS: 4.2, reducedMotion: true }),
    evaluateCinematicGradePixel([0.5, 0.5, 0.5], [0.33, 0.67]),
  );

  // enabled: false bypasses offscreen target and fullscreen post pass
  renderer.calls.length = 0;
  post.render(scene, camera, { enabled: false, speedNorm: 0.8 });
  const bypassRenders = renderer.calls.filter((c) => c.op === "render");
  assert.equal(bypassRenders.length, 1);
  assert.equal(bypassRenders[0].target, null);
  assert.equal(bypassRenders[0].isPostPass, false);
  assert.equal(post.diagnostics().enabled, false);
  assert.equal(post.diagnostics().postCalls, 0);

  // WebGL1 fallback uses samples: 0
  const webgl1Post = createCinematicPost(createStubRenderer({ isWebGL2: false }));
  assert.equal(webgl1Post.diagnostics().samples, 0);
  webgl1Post.dispose();

  // Idempotent dispose cleans up target, geometry, and material exactly once
  let materialDisposed = 0;
  post.material.addEventListener("dispose", () => {
    materialDisposed += 1;
  });
  const prevTargetDisposes = targetDisposeCount;
  post.dispose();
  post.dispose();
  assert.equal(post.diagnostics().disposed, true);
  assert.equal(materialDisposed, 1);
  assert.equal(targetDisposeCount, prevTargetDisposes + 1);
});
