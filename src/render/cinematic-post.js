import * as THREE from "three";

export const DEFAULT_CINEMATIC_GRADE = Object.freeze({
  exposure: 0.82,
  contrast: 1.26,
  shadowToe: 0.085,
  highlightShoulder: 0.90,
  saturation: 0.62,
  shadowTint: Object.freeze([0.075, 0.102, 0.138]),
  highlightTint: Object.freeze([0.93, 0.88, 0.79]),
  vignette: 0.34,
  grain: 0.014,
  maxSpeedStreak: 0.022,
  maxChromaticFringe: 0.0026,
});

export const CITY_CLEAR_CINEMATIC_GRADE = Object.freeze({
  exposure: 1.12,
  contrast: 1.13,
  shadowToe: 0.020,
  highlightShoulder: 0.62,
  saturation: 0.78,
  warmSplit: 0.08,
  coolShadows: 0.06,
  shadowTint: Object.freeze([0.095, 0.112, 0.136]),
  highlightTint: Object.freeze([0.97, 0.94, 0.88]),
  vignette: 0.18,
  grain: 0.009,
  maxSpeedStreak: 0.020,
  maxChromaticFringe: 0.0022,
});

const LUMA_R = 0.2126;
const LUMA_G = 0.7152;
const LUMA_B = 0.0722;

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return value < min ? min : value > max ? max : value;
}

function mix(a, b, t) {
  return a + (b - a) * t;
}

function smoothstep(edge0, edge1, x) {
  const span = edge1 - edge0;
  if (Math.abs(span) <= 1e-8) return x >= edge1 ? 1 : 0;
  const t = clamp((x - edge0) / span, 0, 1);
  return t * t * (3 - 2 * t);
}

function sanitizeTint(tint, fallback) {
  if (!Array.isArray(tint) || tint.length < 3) return fallback;
  return [
    clamp(Number(tint[0]), 0, 2),
    clamp(Number(tint[1]), 0, 2),
    clamp(Number(tint[2]), 0, 2),
  ];
}

function resolveGradeConfig(config = DEFAULT_CINEMATIC_GRADE) {
  if (!config || config === DEFAULT_CINEMATIC_GRADE) return DEFAULT_CINEMATIC_GRADE;
  return {
    exposure: clamp(config.exposure ?? DEFAULT_CINEMATIC_GRADE.exposure, 0, 4),
    contrast: clamp(config.contrast ?? DEFAULT_CINEMATIC_GRADE.contrast, 0.5, 3),
    shadowToe: clamp(config.shadowToe ?? DEFAULT_CINEMATIC_GRADE.shadowToe, 0, 0.5),
    highlightShoulder: clamp(
      config.highlightShoulder ?? DEFAULT_CINEMATIC_GRADE.highlightShoulder,
      0,
      2,
    ),
    saturation: clamp(config.saturation ?? DEFAULT_CINEMATIC_GRADE.saturation, 0, 2),
    shadowTint: sanitizeTint(config.shadowTint, DEFAULT_CINEMATIC_GRADE.shadowTint),
    highlightTint: sanitizeTint(config.highlightTint, DEFAULT_CINEMATIC_GRADE.highlightTint),
    vignette: clamp(config.vignette ?? DEFAULT_CINEMATIC_GRADE.vignette, 0, 1),
    grain: clamp(config.grain ?? DEFAULT_CINEMATIC_GRADE.grain, 0, 0.25),
    maxSpeedStreak: clamp(
      config.maxSpeedStreak ?? DEFAULT_CINEMATIC_GRADE.maxSpeedStreak,
      0,
      0.2,
    ),
    maxChromaticFringe: clamp(
      config.maxChromaticFringe ?? DEFAULT_CINEMATIC_GRADE.maxChromaticFringe,
      0,
      0.05,
    ),
  };
}

function hash12(x, y) {
  let px = (x * 0.1031) % 1;
  let py = (y * 0.1031) % 1;
  let pz = px;
  if (px < 0) px += 1;
  if (py < 0) py += 1;
  if (pz < 0) pz += 1;
  const d = px * (py + 33.33) + py * (pz + 33.33) + pz * (px + 33.33);
  px += d;
  py += d;
  pz += d;
  const f = ((px + py) * pz) % 1;
  return f < 0 ? f + 1 : f;
}

function evaluateFilmicToneScalar(v, cfg) {
  const x = Math.max(0, v * cfg.exposure);
  const xc = clamp(x, 0, 1);

  const pivot = 0.42;
  const gamma = Math.max(0.5, 1 + (cfg.contrast - 1) * 2.35);
  const up = Math.pow(Math.max(xc, 1e-5) / pivot, gamma);
  const dn = Math.pow(Math.max(1 - xc, 1e-5) / (1 - pivot), gamma);
  let curved = xc <= 0 ? 0 : xc >= 1 ? 1 : (pivot * up) / Math.max(pivot * up + (1 - pivot) * dn, 1e-6);
  if (x > 1) curved += x - 1;

  if (cfg.shadowToe > 0) {
    const toeMask = 1 - smoothstep(0.0, 0.42, curved);
    const crushed = (curved * curved) / Math.max(curved + cfg.shadowToe, 1e-5);
    curved = mix(curved, crushed, toeMask * 0.72);
  }

  if (cfg.highlightShoulder > 0) {
    curved = curved / (1 + curved * cfg.highlightShoulder * 0.37);
  }

  return clamp(curved, 0, 1);
}

function softShoulderChannel(c, highlightShoulder) {
  const ex = Math.max(c - 0.78, 0);
  const shK = Math.max(0.2, highlightShoulder) * 2.2;
  return Math.min(c, 0.78) + (0.22 * ex * shK) / (1 + ex * shK);
}

/**
 * Pure CPU reference implementation of the single-pass cinematic color grade.
 * Matches the GLSL fragment shader math on 0..1 sRGB inputs -> 0..1 sRGB outputs.
 */
export function evaluateCinematicGradePixel(
  rgb,
  uv = [0.5, 0.5],
  state = {},
  config = DEFAULT_CINEMATIC_GRADE,
) {
  const src = Array.isArray(rgb) ? rgb : [0, 0, 0];
  let r = clamp(Number(src[0]), 0, 1);
  let g = clamp(Number(src[1]), 0, 1);
  let b = clamp(Number(src[2]), 0, 1);

  if (state && state.enabled === false) {
    return [r, g, b];
  }

  const cfg = resolveGradeConfig(config);

  // 1. Selective saturation: mute washed pastels/greens while keeping emergency strobes & warm practicals
  const Y = LUMA_R * r + LUMA_G * g + LUMA_B * b;
  const redBlueAccent = clamp(Math.max(r - g, b - g) * 1.6, 0.0, 1.0);
  const greenExcess = clamp(g - Math.max(r, b) * 0.85, 0.0, 1.0);
  const effSat = clamp(cfg.saturation + 0.22 * redBlueAccent - 0.18 * greenExcess, 0.35, 0.92);
  r = mix(Y, r, effSat);
  g = mix(Y, g, effSat);
  b = mix(Y, b, effSat);

  // 2. Moody cinema exposure + S-curve around 0.42 + shadow toe + soft highlight shoulder
  const peak = Math.max(r, g, b);
  const toneIn = mix(Y, peak, 0.50 * redBlueAccent);
  const gain = toneIn > 1e-5 ? evaluateFilmicToneScalar(toneIn, cfg) / toneIn : 0;
  r *= gain;
  g *= gain;
  b *= gain;

  // 3. Split-toning: cool charcoal-slate shadows + gentle warm silver-tungsten highlights
  const Y1 = clamp(LUMA_R * r + LUMA_G * g + LUMA_B * b, 0, 1);
  const shadowWeight = (1 - Y1) * (1 - Y1) * 0.22;
  const hiMask = smoothstep(0.45, 0.95, Y1) * 0.12;
  r = mix(r, cfg.shadowTint[0], shadowWeight) * mix(1, cfg.highlightTint[0], hiMask);
  g = mix(g, cfg.shadowTint[1], shadowWeight) * mix(1, cfg.highlightTint[1], hiMask);
  b = mix(b, cfg.shadowTint[2], shadowWeight) * mix(1, cfg.highlightTint[2], hiMask);

  r = softShoulderChannel(r, cfg.highlightShoulder);
  g = softShoulderChannel(g, cfg.highlightShoulder);
  b = softShoulderChannel(b, cfg.highlightShoulder);

  // 4. Anamorphic oval optical lens vignette
  const u = Array.isArray(uv) && Number.isFinite(uv[0]) ? uv[0] : 0.5;
  const v = Array.isArray(uv) && Number.isFinite(uv[1]) ? uv[1] : 0.5;
  const dx = (u - 0.5) * 1.12 * 2.0;
  const dy = (v - 0.5) * 0.94 * 2.0;
  const vig = 1.0 - cfg.vignette * smoothstep(0.38, 1.38, Math.hypot(dx, dy));
  r *= vig;
  g *= vig;
  b *= vig;

  // 5. Optional deterministic 35mm micro-grain when an explicit animation timestamp is provided
  const reducedMotion = Boolean(state?.reducedMotion);
  if (!reducedMotion && cfg.grain > 0 && Number.isFinite(state?.timeS)) {
    const t = ((state.timeS % 120) + 120) % 120;
    const n = hash12(u * 1920 + t * 71.7, v * 1080 + t * 37.3) - 0.5;
    const envelope = smoothstep(0.01, 0.20, Y1) * (1 - 0.30 * Y1);
    const delta = n * cfg.grain * envelope;
    r += delta;
    g += delta;
    b += delta;
  }

  return [clamp(r, 0, 1), clamp(g, 0, 1), clamp(b, 0, 1)];
}

const VERTEX_SHADER = /* glsl */ `
varying vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const FRAGMENT_SHADER = /* glsl */ `
uniform sampler2D tDiffuse;
uniform float uExposure;
uniform float uContrast;
uniform float uShadowToe;
uniform float uHighlightShoulder;
uniform float uSaturation;
uniform vec3 uShadowTint;
uniform vec3 uHighlightTint;
uniform float uVignette;
uniform float uGrain;
uniform float uStreak;
uniform float uFringe;
uniform vec2 uCenter;
uniform float uTime;
uniform float uLinearInput;

varying vec2 vUv;

const vec3 LUMA_WEIGHTS = vec3(0.2126, 0.7152, 0.0722);

vec3 linearToSrgbSafe(vec3 c) {
  vec3 safe = max(c, vec3(0.0));
  vec3 safeHi = max(safe, vec3(0.0031308));
  vec3 hi = pow(safeHi, vec3(1.0 / 2.4)) * 1.055 - vec3(0.055);
  vec3 lo = safe * 12.92;
  return clamp(mix(hi, lo, vec3(lessThanEqual(safe, vec3(0.0031308)))), 0.0, 1.0);
}

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float evaluateFilmicToneScalar(float v) {
  float x = max(0.0, v * uExposure);
  float xc = clamp(x, 0.0, 1.0);

  const float pivot = 0.42;
  float gamma = max(0.5, 1.0 + (uContrast - 1.0) * 2.35);
  float up = pow(max(xc, 1e-5) / pivot, gamma);
  float dn = pow(max(1.0 - xc, 1e-5) / (1.0 - pivot), gamma);
  float curved = (xc <= 0.0)
    ? 0.0
    : ((xc >= 1.0) ? 1.0 : (pivot * up) / max(pivot * up + (1.0 - pivot) * dn, 1e-6));
  if (x > 1.0) curved += (x - 1.0);

  if (uShadowToe > 0.0) {
    float toeMask = 1.0 - smoothstep(0.0, 0.42, curved);
    float crushed = (curved * curved) / max(curved + uShadowToe, 1e-5);
    curved = mix(curved, crushed, toeMask * 0.72);
  }

  if (uHighlightShoulder > 0.0) {
    curved = curved / (1.0 + curved * uHighlightShoulder * 0.37);
  }

  return clamp(curved, 0.0, 1.0);
}

vec3 sampleSceneRadial(vec2 uv) {
  vec2 radialVec = uCenter - uv;
  float radialDist = length(radialVec);
  float edgeWeight = smoothstep(0.30, 0.96, radialDist);
  float streakAmt = uStreak * edgeWeight;
  float fringeAmt = uFringe * edgeWeight;

  if (streakAmt <= 1e-5 && fringeAmt <= 1e-5) {
    return texture2D(tDiffuse, uv).rgb;
  }

  vec2 dir = radialDist > 1e-5 ? (radialVec / radialDist) : vec2(0.0);
  vec2 fringeShift = dir * fringeAmt;

  // 5-tap peripheral radial zoom streak toward dynamic vanishing center + subtle R/B dispersion
  vec2 uv0 = clamp(uv, 0.001, 0.999);
  vec2 uv1 = clamp(uv + dir * (streakAmt * 0.25), 0.001, 0.999);
  vec2 uv2 = clamp(uv + dir * (streakAmt * 0.50), 0.001, 0.999);
  vec2 uv3 = clamp(uv + dir * (streakAmt * 0.75), 0.001, 0.999);
  vec2 uv4 = clamp(uv + dir * streakAmt, 0.001, 0.999);

  float r0 = texture2D(tDiffuse, clamp(uv0 + fringeShift, 0.001, 0.999)).r;
  float g0 = texture2D(tDiffuse, uv0).g;
  float b0 = texture2D(tDiffuse, clamp(uv0 - fringeShift, 0.001, 0.999)).b;
  vec3 c0 = vec3(r0, g0, b0);

  vec3 c1 = texture2D(tDiffuse, uv1).rgb;
  vec3 c2 = texture2D(tDiffuse, uv2).rgb;
  vec3 c3 = texture2D(tDiffuse, uv3).rgb;
  vec3 c4 = texture2D(tDiffuse, uv4).rgb;

  return c0 * 0.30 + c1 * 0.24 + c2 * 0.20 + c3 * 0.15 + c4 * 0.11;
}

void main() {
  vec3 rawSample = sampleSceneRadial(vUv);
  vec3 col = uLinearInput > 0.5 ? linearToSrgbSafe(rawSample) : clamp(rawSample, 0.0, 1.0);
  // Preserve white-hot additive sparks (sRGB > 0.96) across film exposure & shoulder roll-off
  float incandescentSpark = smoothstep(0.96, 0.999, col.r) * smoothstep(0.86, 0.995, col.g);

  // 1. Selective saturation
  float Y = dot(col, LUMA_WEIGHTS);
  float redBlueAccent = clamp(max(col.r - col.g, col.b - col.g) * 1.6, 0.0, 1.0);
  float greenExcess = clamp(col.g - max(col.r, col.b) * 0.85, 0.0, 1.0);
  float effSat = clamp(uSaturation + 0.22 * redBlueAccent - 0.18 * greenExcess, 0.35, 0.92);
  col = mix(vec3(Y), col, effSat);

  // 2. Exposure + S-curve + shadow toe + highlight shoulder
  float peak = max(col.r, max(col.g, col.b));
  float toneIn = mix(Y, peak, 0.50 * redBlueAccent);
  float gain = toneIn > 1e-5 ? (evaluateFilmicToneScalar(toneIn) / toneIn) : 0.0;
  col *= gain;

  // 3. Split-toning + soft per-channel highlight shoulder guard
  float Y1 = clamp(dot(col, LUMA_WEIGHTS), 0.0, 1.0);
  float shadowWeight = (1.0 - Y1) * (1.0 - Y1) * 0.22;
  float hiMask = smoothstep(0.45, 0.95, Y1) * 0.12;
  col = mix(col, uShadowTint, shadowWeight) * mix(vec3(1.0), uHighlightTint, hiMask);

  vec3 ex = max(col - vec3(0.78), vec3(0.0));
  float shK = max(0.2, uHighlightShoulder) * 2.2;
  col = min(col, vec3(0.78)) + (0.22 * ex * shK) / (vec3(1.0) + ex * shK);

  // 4. Anamorphic oval vignette
  vec2 d = (vUv - 0.5) * vec2(1.12, 0.94) * 2.0;
  float vig = 1.0 - uVignette * smoothstep(0.38, 1.38, length(d));
  col *= vig;
  if (incandescentSpark > 0.001) {
    col = mix(col, vec3(1.0, 0.94, 0.76), incandescentSpark * 0.82);
  }

  // 5. Fine 35mm micro-grain (disabled when reducedMotion is active)
  if (uGrain > 0.0) {
    float t = mod(uTime, 120.0);
    float n = hash12(vUv * vec2(1920.0, 1080.0) + vec2(t * 71.7, t * 37.3)) - 0.5;
    float envelope = smoothstep(0.01, 0.20, Y1) * (1.0 - 0.30 * Y1);
    col += vec3(n * uGrain * envelope);
  }

  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;

/**
 * Single-pass, 1-triangle WebGL post-processing film grade & peripheral speed-streak compositor.
 *
 * Color-pipeline note for Three.js r152 (`WebGLRenderer` with `ACESFilmicToneMapping` and
 * `outputColorSpace = SRGBColorSpace`):
 * - Rendering `scene` into a `WebGLRenderTarget` runs `ACESFilmicToneMapping` on scene materials
 *   while outputting linear RGB (`LinearSRGBColorSpace`).
 * - With `colorSpace: SRGBColorSpace` on WebGL2, `target` allocates `SRGB8_ALPHA8` so MSAA resolve
 *   and 8-bit storage happen in perceptual sRGB without shadow banding, and `texture2D(tDiffuse)`
 *   hardware-decodes back to linear RGB (on WebGL1 `RGBA8` stores and samples linear RGB directly).
 * - Our fullscreen shader blends the 5-tap speed streak in linear light, converts once to sRGB via
 *   `linearToSrgbSafe`, applies the exact `0..1` sRGB film grade, and writes directly to the canvas
 *   with `material.toneMapped = false` (zero double-ACES and zero gamma wash-out/double-darkening).
 */
export function createCinematicPost(renderer, options = {}) {
  const gradeConfig = resolveGradeConfig(options.grade ?? options.config ?? options);
  const isWebGL2 = Boolean(renderer?.capabilities?.isWebGL2);
  const samples = isWebGL2 ? Math.max(0, Math.floor(options.samples ?? 4)) : 0;

  const sizeProbe = new THREE.Vector2(1, 1);
  if (typeof renderer?.getSize === "function") {
    renderer.getSize(sizeProbe);
  }
  const initialWidthCss = options.width ?? sizeProbe.x ?? 1;
  const initialHeightCss = options.height ?? sizeProbe.y ?? 1;
  const initialPixelRatio =
    options.pixelRatio ??
    (typeof renderer?.getPixelRatio === "function" ? renderer.getPixelRatio() : 1);

  let width = Math.max(1, Math.floor((Number(initialWidthCss) || 1) * (Number(initialPixelRatio) || 1)));
  let height = Math.max(1, Math.floor((Number(initialHeightCss) || 1) * (Number(initialPixelRatio) || 1)));

  const target = new THREE.WebGLRenderTarget(width, height, {
    samples,
    depthBuffer: true,
    stencilBuffer: false,
    colorSpace: THREE.SRGBColorSpace,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    generateMipmaps: false,
  });
  target.texture.name = "cinematic-post-tDiffuse";

  // Single oversized NDC triangle covering [-1, 1]^2 with 1 draw call, 1 triangle, 0 diagonal seam
  const quadGeometry = new THREE.BufferGeometry();
  quadGeometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3),
  );
  quadGeometry.setAttribute(
    "uv",
    new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2),
  );

  const outputColorSpace = renderer?.outputColorSpace ?? THREE.SRGBColorSpace;
  const uniforms = {
    tDiffuse: { value: target.texture },
    uExposure: { value: gradeConfig.exposure },
    uContrast: { value: gradeConfig.contrast },
    uShadowToe: { value: gradeConfig.shadowToe },
    uHighlightShoulder: { value: gradeConfig.highlightShoulder },
    uSaturation: { value: gradeConfig.saturation },
    uShadowTint: { value: new THREE.Vector3(...gradeConfig.shadowTint) },
    uHighlightTint: { value: new THREE.Vector3(...gradeConfig.highlightTint) },
    uVignette: { value: gradeConfig.vignette },
    uGrain: { value: gradeConfig.grain },
    uStreak: { value: 0 },
    uFringe: { value: 0 },
    uCenter: { value: new THREE.Vector2(0.5, 0.52) },
    uTime: { value: 0 },
    uLinearInput: { value: outputColorSpace === THREE.SRGBColorSpace ? 1.0 : 0.0 },
  };

  const material = new THREE.ShaderMaterial({
    name: "CinematicPostGradeMaterial",
    uniforms,
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    depthTest: false,
    depthWrite: false,
    blending: THREE.NoBlending,
    toneMapped: false,
    fog: false,
  });
  material.toneMapped = false;

  const postCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  postCamera.matrixAutoUpdate = false;
  postCamera.matrixWorldAutoUpdate = false;

  const quadMesh = new THREE.Mesh(quadGeometry, material);
  quadMesh.name = "cinematic-post-fullscreen-triangle";
  quadMesh.frustumCulled = false;
  quadMesh.matrixAutoUpdate = false;
  quadMesh.matrixWorldAutoUpdate = false;

  const postScene = new THREE.Scene();
  postScene.name = "cinematic-post-scene";
  postScene.matrixWorldAutoUpdate = false;
  postScene.add(quadMesh);

  const defaultEnabled = options.enabled !== undefined ? Boolean(options.enabled) : true;
  let enabled = defaultEnabled;
  let disposed = false;
  let sceneCalls = 0;
  let sceneTriangles = 0;
  let postCalls = enabled ? 1 : 0;
  let lastState = {
    speedNorm: 0,
    turnNorm: 0,
    impactPulse: 0,
    timeS: 0,
    reducedMotion: false,
    enabled,
  };

  function setSize(nextWidthCss, nextHeightCss, pixelRatio = 1) {
    if (disposed) return;
    const dpr = Number.isFinite(pixelRatio) && pixelRatio > 0 ? pixelRatio : 1;
    const nextW = Math.max(1, Math.floor((Number(nextWidthCss) || 1) * dpr));
    const nextH = Math.max(1, Math.floor((Number(nextHeightCss) || 1) * dpr));
    if (nextW === width && nextH === height) return;
    width = nextW;
    height = nextH;
    target.setSize(width, height);
    uniforms.tDiffuse.value = target.texture;
  }

  function measureSceneRender(scene, camera) {
    const renderInfo = renderer?.info?.render;
    const autoReset = renderer?.info ? renderer.info.autoReset !== false : true;
    const callsBefore = renderInfo?.calls ?? 0;
    const trisBefore = renderInfo?.triangles ?? 0;

    renderer.render(scene, camera);

    const callsAfter = renderer?.info?.render?.calls ?? 0;
    const trisAfter = renderer?.info?.render?.triangles ?? 0;
    sceneCalls = autoReset || callsAfter < callsBefore ? callsAfter : callsAfter - callsBefore;
    sceneTriangles = autoReset || trisAfter < trisBefore ? trisAfter : trisAfter - trisBefore;
  }

  function render(scene, camera, state = {}) {
    if (disposed) return;

    const nextEnabled = state.enabled !== undefined ? Boolean(state.enabled) : defaultEnabled;
    const reducedMotion = Boolean(state.reducedMotion);
    const speedNorm = clamp(Number.isFinite(state.speedNorm) ? state.speedNorm : 0, 0, 1);
    const turnNorm = clamp(Number.isFinite(state.turnNorm) ? state.turnNorm : 0, -1, 1);
    const impactPulse = clamp(Number.isFinite(state.impactPulse) ? state.impactPulse : 0, 0, 1);
    const timeS = Number.isFinite(state.timeS) ? state.timeS : 0;

    enabled = nextEnabled;
    lastState = {
      speedNorm,
      turnNorm,
      impactPulse,
      timeS,
      reducedMotion,
      enabled,
    };

    const speedRamp = smoothstep(0.18, 1.0, speedNorm);
    uniforms.uStreak.value = reducedMotion ? 0 : gradeConfig.maxSpeedStreak * speedRamp;
    uniforms.uGrain.value = reducedMotion ? 0 : gradeConfig.grain;
    uniforms.uFringe.value = reducedMotion
      ? 0
      : gradeConfig.maxChromaticFringe * clamp(speedNorm * 0.75 + impactPulse * 0.85, 0, 1.5);
    uniforms.uCenter.value.set(0.5 + turnNorm * 0.06, 0.52);
    uniforms.uTime.value = timeS;
    uniforms.uLinearInput.value =
      (renderer?.outputColorSpace ?? THREE.SRGBColorSpace) === THREE.SRGBColorSpace ? 1.0 : 0.0;

    if (!enabled) {
      postCalls = 0;
      renderer.setRenderTarget(null);
      measureSceneRender(scene, camera);
      return;
    }

    const prevAutoClear = renderer.autoClear;
    const hasInfo = Boolean(renderer.info);
    const prevInfoAutoReset = hasInfo ? renderer.info.autoReset : undefined;

    try {
      renderer.setRenderTarget(target);
      measureSceneRender(scene, camera);

      renderer.setRenderTarget(null);
      renderer.autoClear = false;
      if (hasInfo) renderer.info.autoReset = false;
      renderer.render(postScene, postCamera);
      postCalls = 1;
    } finally {
      renderer.autoClear = prevAutoClear;
      if (hasInfo) renderer.info.autoReset = prevInfoAutoReset;
      if (typeof renderer.getRenderTarget === "function" && renderer.getRenderTarget() !== null) {
        renderer.setRenderTarget(null);
      }
    }
  }

  function diagnostics() {
    return {
      enabled,
      disposed,
      width,
      height,
      samples,
      postCalls,
      sceneCalls,
      sceneTriangles,
      config: {
        ...gradeConfig,
        shadowTint: [...gradeConfig.shadowTint],
        highlightTint: [...gradeConfig.highlightTint],
      },
      lastState: { ...lastState },
    };
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    target.dispose();
    quadGeometry.dispose();
    material.dispose();
  }

  return {
    setSize,
    render,
    diagnostics,
    dispose,
    target,
    material,
    uniforms,
  };
}
