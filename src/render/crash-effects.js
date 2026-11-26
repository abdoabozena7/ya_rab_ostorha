import * as THREE from "three";

const MAX_DEBRIS_PARTS = 28;
const MAX_GLASS_SHARDS = 96;
const MAX_IMPACT_SPARKS = 180;
const MAX_SMOKE_PUFFS = 220;
const MAX_SKID_SEGMENTS = 360;
const SMOKE_TEX_SIZE = 256;

const GRAVITY_MPS2 = 9.81;
const DEBRIS_GROUND_Y = 0.14;
const GLASS_GROUND_Y = 0.128;
const SPARK_GROUND_Y = 0.125;
const SKID_GROUND_Y = 0.121;

const PLAYER_OLIVE_PAINT = 0x5d6d53;
const PATROL_NAVY_PAINT = 0x263e49;
const STEAM_COLOR_HEX = 0xeee6d8;
const ENGINE_SMOKE_HEX = 0xa88668;
const ENGINE_OIL_DARK_HEX = 0x6b5340;
const TIRE_SMOKE_WARM_HEX = 0xd2e2f2;
const TIRE_SMOKE_COOL_HEX = 0xbcd0e6;
const CURB_SCRUB_SMOKE_HEX = 0xe8e0d4;
const WALL_SCRAPE_SMOKE_HEX = 0xebf0f7;
const EXHAUST_WISP_HEX = 0xcfd4d8;
// Linear multiplier [1,1,1] paired with procedural vulcanized tire-tread + satin dusk rubber sheen DataTexture
const SKID_RUBBER_RGB = [1, 1, 1];

export const CRASH_PART_KINDS = Object.freeze([
  "bumper-corner",
  "hood-panel",
  "side-mirror",
  "license-plate",
  "grille-slat",
  "spare-cover",
  "lightbar-lens",
  "trim-cladding",
]);

const CANONICAL_PARTS = new Set(CRASH_PART_KINDS);

function clamp(v, lo, hi) {
  return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : lo;
}

function smoothstep(edge0, edge1, x) {
  const t = clamp((x - edge0) / ((edge1 - edge0) || 1), 0, 1);
  return t * t * (3 - 2 * t);
}

function wrapAngleDelta(nextRad, prevRad) {
  let d = (nextRad - prevRad) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  else if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

const NOISE_GRID = 256;
const NOISE_MASK = NOISE_GRID - 1;
const NOISE_LUT = (() => {
  const lut = new Float32Array(NOISE_GRID * NOISE_GRID);
  for (let y = 0; y < NOISE_GRID; y++) {
    for (let x = 0; x < NOISE_GRID; x++) {
      let h = Math.imul(x ^ Math.imul(y, 0x9e3779b9), 0x85ebca6b);
      h = Math.imul(h ^ (h >>> 15), 0xc2b2ae35);
      h ^= h >>> 13;
      lut[y * NOISE_GRID + x] = (h >>> 0) / 4294967295;
    }
  }
  return lut;
})();

function sampleLatticeNoise(x, y, seedOffset = 0) {
  const sx = x + seedOffset * 17.13;
  const sy = y + seedOffset * 31.71;
  const ix = Math.floor(sx);
  const iy = Math.floor(sy);
  const fx = sx - ix;
  const fy = sy - iy;
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const x0 = ix & NOISE_MASK;
  const x1 = (ix + 1) & NOISE_MASK;
  const y0 = (iy & NOISE_MASK) * NOISE_GRID;
  const y1 = ((iy + 1) & NOISE_MASK) * NOISE_GRID;
  const n00 = NOISE_LUT[y0 + x0];
  const n10 = NOISE_LUT[y0 + x1];
  const n01 = NOISE_LUT[y1 + x0];
  const n11 = NOISE_LUT[y1 + x1];
  const nx0 = n00 + (n10 - n00) * ux;
  const nx1 = n01 + (n11 - n01) * ux;
  return nx0 + (nx1 - nx0) * uy;
}

function fbm5(x, y, octaves = 5, seed = 0) {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let freq = 1;
  for (let o = 0; o < octaves; o++) {
    sum += amp * sampleLatticeNoise(x * freq, y * freq, seed + o * 7);
    norm += amp;
    amp *= 0.5;
    freq *= 2.03;
  }
  return sum / (norm || 1);
}

function billowTurbulence(x, y, octaves = 5, seed = 100) {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let freq = 1;
  for (let o = 0; o < octaves; o++) {
    const n = sampleLatticeNoise(x * freq, y * freq, seed + o * 11);
    const ridged = 1 - Math.abs(n * 2 - 1);
    sum += amp * (ridged * ridged);
    norm += amp;
    amp *= 0.52;
    freq *= 2.07;
  }
  return sum / (norm || 1);
}

export function createVolumetricSmokeTexture() {
  const S = SMOKE_TEX_SIZE;
  const total = S * S;
  const densityField = new Float32Array(total);
  const billowField = new Float32Array(total);
  const data = new Uint8Array(total * 4);

  for (let py = 0; py < S; py++) {
    const v = (py + 0.5) / S;
    const cy = (v - 0.5) * 2;
    for (let px = 0; px < S; px++) {
      const idx = py * S + px;
      const isBorderRing = px <= 2 || px >= S - 3 || py <= 2 || py >= S - 3;
      const u = (px + 0.5) / S;
      const cx = (u - 0.5) * 2;
      const r = Math.hypot(cx, cy);

      const qx = fbm5(u * 3.1 + 1.7, v * 3.1 + 9.2, 4, 3);
      const qy = fbm5(u * 3.1 + 8.3, v * 3.1 + 2.8, 4, 19);
      const wx = u * 3.75 + (qx - 0.5) * 1.68;
      const wy = v * 3.75 + (qy - 0.5) * 1.68;

      const warpedFbm = fbm5(wx + 4.1, wy + 7.6, 5, 37);
      const billow = billowTurbulence(wx * 1.28 + 13.4, wy * 1.28 + 5.9, 5, 73);
      const wisps = fbm5(wx * 2.65 - 6.2, wy * 2.65 + 11.1, 5, 131);
      billowField[idx] = billow;

      if (isBorderRing || r >= 0.92) {
        densityField[idx] = 0;
        continue;
      }

      const theta = Math.atan2(cy, cx);
      const lobeRadius = Math.min(
        0.86,
        0.69
          + 0.075 * Math.sin(theta * 3 + 0.65)
          + 0.055 * Math.cos(theta * 5 - 1.15)
          + 0.04 * Math.sin(theta * 7 + 2.05),
      );
      const normR = r / lobeRadius;
      const warpedR = normR - (warpedFbm - 0.48) * 0.34 - (wisps - 0.5) * 0.16;
      const silhouette = 1 - smoothstep(0.16, 0.94, warpedR);

      const uvMargin = Math.min(Math.min(u, 1 - u), Math.min(v, 1 - v));
      const edgeTaper = smoothstep(0.025, 0.14, uvMargin) * (1 - smoothstep(0.76, 0.91, r));

      const cloudStructure = clamp(0.50 * billow + 0.34 * warpedFbm + 0.16 * wisps, 0, 1);
      const eroded = smoothstep(
        0.22 - 0.12 * (1 - clamp(normR, 0, 1)),
        0.84,
        cloudStructure * (0.44 + 0.76 * silhouette),
      );
      const raw = clamp(silhouette * eroded * edgeTaper * 1.22, 0, 1);
      densityField[idx] = raw < 0.004 ? 0 : Math.pow(raw, 1.22);
    }
  }

  // Sun ray from upper-left (+Y is UV top on PlaneGeometry) for Beer-Lambert self-shadowing
  const sunDx = -0.56;
  const sunDy = 0.83;
  const marchSteps = [3, 7, 13, 21];

  for (let py = 0; py < S; py++) {
    const v = (py + 0.5) / S;
    const cy = (v - 0.5) * 2;
    for (let px = 0; px < S; px++) {
      const idx = py * S + px;
      const out = idx * 4;
      const u = (px + 0.5) / S;
      const cx = (u - 0.5) * 2;
      const r = Math.hypot(cx, cy);
      const density = densityField[idx];
      const billow = billowField[idx];

      let opticalDepth = 0;
      for (let m = 0; m < marchSteps.length; m++) {
        const sx = Math.round(px + sunDx * marchSteps[m]);
        const sy = Math.round(py + sunDy * marchSteps[m]);
        if (sx >= 0 && sx < S && sy >= 0 && sy < S) {
          opticalDepth += densityField[sy * S + sx] * (0.28 + m * 0.06);
        }
      }
      const transmittance = Math.exp(-opticalDepth * 1.32);

      const xL = Math.max(0, px - 2), xR = Math.min(S - 1, px + 2);
      const yD = Math.max(0, py - 2), yU = Math.min(S - 1, py + 2);
      const gradX = densityField[py * S + xL] - densityField[py * S + xR];
      const gradY = densityField[yD * S + px] - densityField[yU * S + px];
      const nLen = Math.hypot(gradX, gradY, 0.36) || 1;
      const nDotL = clamp(((gradX * sunDx + gradY * sunDy + 0.28) / nLen) * 0.5 + 0.5, 0, 1);

      const hemiTop = smoothstep(-0.85, 0.85, cy * 0.72 + clamp(r - 0.15, 0, 0.75) * 0.38);
      const litFactor = clamp(
        0.42 * transmittance + 0.26 * nDotL + 0.18 * hemiTop + 0.14 * billow,
        0,
        1,
      );

      // Lower/inner turbulent folds ~168, top/outer sunlit silver-white crown ~252
      const shade = 166 + litFactor * 87;
      data[out] = Math.round(clamp(shade + 1.5 * litFactor, 162, 254));
      data[out + 1] = Math.round(clamp(shade + 0.5 * litFactor, 162, 253));
      data[out + 2] = Math.round(clamp(shade + 1.8 * (1 - litFactor * 0.4), 164, 254));

      const isPerimeter = px === 0 || px === S - 1 || py === 0 || py === S - 1;
      data[out + 3] = isPerimeter ? 0 : Math.round(clamp(density * 255, 0, 255));
    }
  }

  const texture = new THREE.DataTexture(data, S, S, THREE.RGBAFormat);
  texture.name = "crash-volumetric-smoke-fbm";
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

function partFacets() {
  const positions = [];
  const colors = [];
  const palette = new Map();
  const colorOf = (hex) => {
    if (!palette.has(hex)) palette.set(hex, new THREE.Color(hex));
    return palette.get(hex);
  };
  return {
    face(pts, hex, flip = false) {
      const c = colorOf(hex);
      for (let i = 1; i < pts.length - 1; i++) {
        const tri = flip ? [pts[0], pts[i + 1], pts[i]] : [pts[0], pts[i], pts[i + 1]];
        for (const [x, y, z] of tri) {
          positions.push(x, y, z);
          colors.push(c.r, c.g, c.b);
        }
      }
    },
    box(cx, cy, cz, w, h, l, hex) {
      const a = cx - w / 2, b = cx + w / 2;
      const c = cy - h / 2, d = cy + h / 2;
      const e = cz - l / 2, g = cz + l / 2;
      const p = [
        [a, c, e], [b, c, e], [b, c, g], [a, c, g],
        [a, d, e], [b, d, e], [b, d, g], [a, d, g],
      ];
      for (const idx of [[0, 1, 2, 3], [4, 7, 6, 5], [0, 4, 5, 1], [1, 5, 6, 2], [2, 6, 7, 3], [3, 7, 4, 0]]) {
        this.face(idx.map((k) => p[k]), hex);
      }
    },
    build() {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
      geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
      geo.computeVertexNormals();
      geo.computeBoundingBox();
      geo.computeBoundingSphere();
      return geo;
    },
  };
}

function createPartGeometries() {
  const geometries = {};

  // 1. "bumper-corner": curved/beveled charcoal bumper wing fragment (0.46 x 0.18 x 0.24 m)
  {
    const f = partFacets();
    f.box(-0.04, 0, 0.055, 0.36, 0.17, 0.11, 0x2d3332);
    f.box(0.155, -0.005, -0.02, 0.14, 0.165, 0.20, 0x353b3a);
    f.box(0.19, 0.015, 0.04, 0.075, 0.055, 0.09, 0xd48b32);
    f.box(-0.05, -0.075, 0.07, 0.34, 0.03, 0.08, 0x202525);
    geometries["bumper-corner"] = f.build();
  }

  // 2. "hood-panel": crumpled olive/painted hood sheet (0.95 x 0.05 x 0.72 m)
  // Painted vertices use neutral near-white so slot material.color tints to vehicle paint.
  {
    const f = partFacets();
    const zRows = [-0.36, -0.12, 0.14, 0.36];
    const xCols = [-0.475, -0.18, 0.16, 0.475];
    const ridgeY = [
      [0.00, 0.012, 0.008, -0.004],
      [0.014, 0.034, 0.028, 0.010],
      [0.008, 0.026, 0.032, 0.006],
      [-0.012, 0.004, 0.006, -0.014],
    ];
    const thick = 0.022;
    for (let r = 0; r < zRows.length - 1; r++) {
      for (let c = 0; c < xCols.length - 1; c++) {
        const p00 = [xCols[c], ridgeY[r][c], zRows[r]];
        const p10 = [xCols[c + 1], ridgeY[r][c + 1], zRows[r]];
        const p11 = [xCols[c + 1], ridgeY[r + 1][c + 1], zRows[r + 1]];
        const p01 = [xCols[c], ridgeY[r + 1][c], zRows[r + 1]];
        const topTone = (r + c) % 2 === 0 ? 0xf6f8f4 : 0xdde2da;
        f.face([p00, p01, p11, p10], topTone);
        f.face(
          [p00, p10, p11, p01].map(([x, y, z]) => [x, y - thick, z]),
          0x3c423f,
        );
      }
    }
    geometries["hood-panel"] = f.build();
  }

  // 3. "side-mirror": mirror housing + stalk (0.16 x 0.12 x 0.15 m)
  {
    const f = partFacets();
    f.box(-0.048, -0.026, 0.015, 0.064, 0.028, 0.038, 0x333938);
    f.box(0.018, 0.008, 0.0, 0.115, 0.095, 0.11, 0xf2f4f0);
    f.box(0.018, 0.008, -0.056, 0.096, 0.074, 0.012, 0x9ab4bd);
    geometries["side-mirror"] = f.build();
  }

  // 4. "license-plate": rectangular plate (0.26 x 0.08 x 0.015 m)
  {
    const f = partFacets();
    f.box(0, 0, 0, 0.26, 0.08, 0.012, 0x2b3030);
    f.box(0, -0.006, 0.004, 0.244, 0.058, 0.010, 0xd4cbb0);
    f.box(0, 0.026, 0.004, 0.244, 0.016, 0.010, 0x39587a);
    geometries["license-plate"] = f.build();
  }

  // 5. "grille-slat": broken grille trim bar (0.38 x 0.12 x 0.03 m)
  {
    const f = partFacets();
    f.box(0, 0, -0.004, 0.38, 0.115, 0.018, 0x262b2b);
    f.box(-0.01, 0.026, 0.006, 0.35, 0.022, 0.018, 0x868f8a);
    f.box(0.01, -0.024, 0.006, 0.33, 0.022, 0.018, 0x868f8a);
    geometries["grille-slat"] = f.build();
  }

  // 6. "spare-cover": round spare tire cover disc (radius 0.24 m)
  {
    const f = partFacets();
    const steps = 14, rOuter = 0.24, rCap = 0.185, halfT = 0.052;
    for (let i = 0; i < steps; i++) {
      const a0 = (i * Math.PI * 2) / steps;
      const a1 = ((i + 1) * Math.PI * 2) / steps;
      const x0 = Math.cos(a0) * rOuter, y0 = Math.sin(a0) * rOuter;
      const x1 = Math.cos(a1) * rOuter, y1 = Math.sin(a1) * rOuter;
      const cx0 = Math.cos(a0) * rCap, cy0 = Math.sin(a0) * rCap;
      const cx1 = Math.cos(a1) * rCap, cy1 = Math.sin(a1) * rCap;
      f.face([[x0, y0, -halfT], [x1, y1, -halfT], [x1, y1, halfT], [x0, y0, halfT]], 0x282c2c);
      f.face([[x0, y0, halfT], [x1, y1, halfT], [cx1, cy1, halfT + 0.012], [cx0, cy0, halfT + 0.012]], 0x363c3b);
      f.face([[0, 0, halfT + 0.016], [cx0, cy0, halfT + 0.012], [cx1, cy1, halfT + 0.012]], 0xedf0ea);
      f.face([[0, 0, -halfT], [x1, y1, -halfT], [x0, y0, -halfT]], 0x242828);
    }
    geometries["spare-cover"] = f.build();
  }

  // 7. "lightbar-lens": translucent red/blue shattered police lightbar cap (0.28 x 0.07 x 0.12 m)
  {
    const f = partFacets();
    f.box(0, -0.022, 0, 0.27, 0.022, 0.115, 0x30383d);
    f.box(-0.01, 0.008, 0, 0.28, 0.052, 0.12, 0xffffff);
    geometries["lightbar-lens"] = f.build();
  }

  // 8. "trim-cladding": side door moulding strip (0.55 x 0.09 x 0.04 m)
  {
    const f = partFacets();
    f.box(0, 0, 0, 0.55, 0.09, 0.032, 0x343a39);
    f.box(0, 0.014, 0.014, 0.53, 0.022, 0.016, 0x7b837e);
    geometries["trim-cladding"] = f.build();
  }

  return geometries;
}

function createGlassShardGeometry() {
  const f = partFacets();
  const top = [[0, 0.006, 0.048], [-0.042, 0.006, -0.032], [0.038, 0.006, -0.024]];
  const bot = top.map(([x, , z]) => [x, -0.006, z]);
  f.face(top, 0xffffff);
  f.face([bot[0], bot[2], bot[1]], 0xe6f6ff);
  for (let i = 0; i < 3; i++) {
    const j = (i + 1) % 3;
    f.face([bot[i], bot[j], top[j], top[i]], 0xd4eefc);
  }
  return f.build();
}

function normalizePartKind(raw, side = "front") {
  if (!raw) return null;
  const name = typeof raw === "string" ? raw : (raw.kind ?? raw.part ?? raw.id ?? "");
  if (CANONICAL_PARTS.has(name)) return name;
  const lower = String(name).toLowerCase();
  if (lower.includes("lightbar") || lower.includes("siren")) return "lightbar-lens";
  if (lower.includes("hood") || lower.includes("bonnet")) return "hood-panel";
  if (lower.includes("mirror")) return "side-mirror";
  if (lower.includes("plate")) return "license-plate";
  if (lower.includes("grille") || lower.includes("radiator")) return "grille-slat";
  if (lower.includes("spare") || lower.includes("tailgate") || lower.includes("trunk") || lower.includes("hatch")) return "spare-cover";
  if (lower.includes("cladding") || lower.includes("trim") || lower.includes("door") || lower.includes("rocker") || lower.includes("sill")) {
    return "trim-cladding";
  }
  if (lower.includes("bumper") || lower.includes("fender") || lower.includes("quarter") || lower.includes("exhaust")) return "bumper-corner";
  if (side === "left" || side === "right") return "trim-cladding";
  return null;
}

function isGlassPartName(raw) {
  const name = typeof raw === "string" ? raw : (raw?.kind ?? raw?.part ?? raw?.id ?? "");
  return /glass|windshield|window|lamp|light|headlight|taillight/i.test(String(name));
}

function partLocalMount(kind, side, width = 1.85, length = 4.2, index = 0) {
  const halfW = width * 0.5;
  const halfL = length * 0.5;
  const lr = side === "left" ? -1 : side === "right" ? 1 : (index % 2 === 0 ? 1 : -1);
  switch (kind) {
    case "license-plate":
      return { x: 0, y: 0.48, z: side === "rear" ? -halfL - 0.04 : halfL + 0.04, outX: lr * 0.2, outZ: side === "rear" ? -1 : 1 };
    case "grille-slat":
      return { x: lr * 0.16, y: 0.78, z: halfL + 0.03, outX: lr * 0.35, outZ: 1 };
    case "bumper-corner":
      return {
        x: lr * (halfW - 0.14),
        y: 0.46,
        z: (side === "rear" ? -1 : 1) * (halfL - 0.08),
        outX: lr * 0.75,
        outZ: side === "rear" ? -0.85 : 0.85,
      };
    case "side-mirror":
      return { x: lr * (halfW + 0.02), y: 1.12, z: length * 0.16, outX: lr, outZ: 0.25 };
    case "hood-panel":
      return { x: 0, y: 1.04, z: length * 0.28, outX: lr * 0.22, outZ: 0.65 };
    case "spare-cover":
      return { x: 0.08, y: 0.96, z: -halfL - 0.06, outX: lr * 0.28, outZ: -1 };
    case "lightbar-lens":
      return { x: lr * 0.28, y: 1.56, z: -0.12, outX: lr * 0.7, outZ: 0.35 };
    case "trim-cladding":
    default:
      return { x: lr * (halfW + 0.01), y: 0.56, z: (index % 2 ? -0.25 : 0.22), outX: lr, outZ: 0.15 };
  }
}

const SINGULAR_WHOLE_PARTS = new Set(["hood-panel", "spare-cover", "side-mirror"]);

function derivePartsFromImpact(side, energyJ, damage = {}) {
  if (!(energyJ >= 18000)) return [];
  const p = damage?.parts;
  const hasCoreParts = Boolean(p && typeof p === "object" && p.hood && p.spareCarrier);
  if (side === "rear") {
    const out = ["license-plate", "bumper-corner"];
    const spareDetached = hasCoreParts
      ? Boolean(p.spareCarrier?.detached)
      : (energyJ >= 30000 || (damage.rear ?? 0) >= 0.55);
    if (spareDetached) out.push("spare-cover");
    return out;
  }
  if (side === "left" || side === "right") {
    const out = ["trim-cladding"];
    const mirrorDetached = hasCoreParts
      ? Boolean(side === "left" ? p.mirrorLeft?.detached : p.mirrorRight?.detached)
      : true;
    if (mirrorDetached) out.unshift("side-mirror");
    if (energyJ >= 22000) out.push("bumper-corner");
    return out;
  }
  const out = ["license-plate", "grille-slat", "bumper-corner"];
  const mirrorDetached = hasCoreParts
    ? Boolean(p.mirrorLeft?.detached || p.mirrorRight?.detached)
    : (energyJ >= 30000 || (damage.front ?? 0) >= 0.5);
  const hoodDetached = hasCoreParts
    ? Boolean(p.hood?.detached)
    : (energyJ >= 45000 || (damage.front ?? 0) >= 0.72);
  if (mirrorDetached) out.push("side-mirror");
  if (hoodDetached) out.push("hood-panel");
  return out;
}

const PAINTED_PARTS = new Set(["hood-panel", "side-mirror", "spare-cover"]);

export function createCrashEffects(scene) {
  const layer = new THREE.Group();
  layer.name = "crash-effects-layer";
  if (scene?.add) scene.add(layer);

  const ownedGeometries = new Set();
  const ownedMaterials = new Set();
  const ownedTextures = new Set();
  const trackGeo = (g) => { ownedGeometries.add(g); return g; };
  const trackMat = (m) => { ownedMaterials.add(m); return m; };
  const trackTex = (t) => { ownedTextures.add(t); return t; };

  const partGeometries = createPartGeometries();
  for (const geo of Object.values(partGeometries)) trackGeo(geo);

  const debrisGroup = new THREE.Group();
  debrisGroup.name = "crash-debris-parts";
  layer.add(debrisGroup);

  const debrisSlots = Array.from({ length: MAX_DEBRIS_PARTS }, (_, i) => {
    const material = trackMat(new THREE.MeshStandardMaterial({
      vertexColors: true,
      flatShading: true,
      roughness: 0.68,
      metalness: 0.14,
      transparent: true,
      opacity: 1,
    }));
    const mesh = new THREE.Mesh(partGeometries["bumper-corner"], material);
    mesh.name = `crash-debris-part-${i}`;
    mesh.visible = false;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    debrisGroup.add(mesh);
    return {
      active: false,
      kind: "bumper-corner",
      owner: "custom",
      mesh,
      material,
      x: 0, y: 0, z: 0,
      vx: 0, vy: 0, vz: 0,
      rx: 0, ry: 0, rz: 0,
      vrx: 0, vry: 0, vrz: 0,
      ageS: 0,
      ttlS: 5.5,
      groundY: DEBRIS_GROUND_Y,
      baseScale: 1,
      baseOpacity: 1,
    };
  });

  const makeInstancedPool = (geometry, material, capacity, name) => {
    const mesh = new THREE.InstancedMesh(trackGeo(geometry), trackMat(material), capacity);
    mesh.name = name;
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    layer.add(mesh);
    return mesh;
  };

  const glassMesh = makeInstancedPool(
    createGlassShardGeometry(),
    new THREE.MeshStandardMaterial({
      color: 0xbfdceb,
      vertexColors: true,
      flatShading: true,
      roughness: 0.16,
      metalness: 0.12,
      transparent: true,
      opacity: 0.8,
      side: THREE.DoubleSide,
    }),
    MAX_GLASS_SHARDS,
    "crash-glass-shards",
  );
  glassMesh.setColorAt(0, new THREE.Color(0xffffff));
  glassMesh.instanceColor.setUsage(THREE.DynamicDrawUsage);

  const sparkMesh = makeInstancedPool(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshBasicMaterial({
      color: 0xffffff,
      toneMapped: false,
      transparent: true,
      opacity: 1.0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
    MAX_IMPACT_SPARKS,
    "crash-impact-sparks",
  );
  sparkMesh.setColorAt(0, new THREE.Color(0xffffff));
  sparkMesh.instanceColor.setUsage(THREE.DynamicDrawUsage);

  // Persistent asphalt tire skid & scrub ribbon pool (1 draw call) with 3-groove satin rubber tread DataTexture
  const createTireSkidTreadTexture = () => {
    const S = 64;
    const data = new Uint8Array(S * S * 4);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const idx = (y * S + x) * 4;
        const u = x / (S - 1);
        const edgeDist = Math.min(u, 1 - u);
        const feather = smoothstep(0.01, 0.14, edgeDist);
        // Three deep vulcanized tread channels + four scuffed satin-rubber contact ribs
        const g1 = Math.exp(-(((u - 0.28) / 0.042) ** 2));
        const g2 = Math.exp(-(((u - 0.50) / 0.038) ** 2));
        const g3 = Math.exp(-(((u - 0.72) / 0.042) ** 2));
        const groove = clamp(g1 + g2 + g3, 0, 1);
        const grit = sampleLatticeNoise(x * 0.45, y * 0.32, 19);
        const sheen = (1 - groove * 0.85) * (0.72 + 0.28 * grit);
        // Deep vulcanized black rubber groove (#030406) + dark charcoal scuffed rubber rib (#20252c) — dark rubber, never bright lines!
        data[idx] = Math.round(3 + 30 * sheen);
        data[idx + 1] = Math.round(4 + 34 * sheen);
        data[idx + 2] = Math.round(6 + 38 * sheen);
        data[idx + 3] = x === 0 || x === S - 1 ? 0 : Math.round(clamp(feather * (0.98 - 0.22 * groove), 0, 1) * 255);
      }
    }
    const tex = new THREE.DataTexture(data, S, S, THREE.RGBAFormat);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    return tex;
  };
  const skidTreadTex = trackTex(createTireSkidTreadTexture());

  const skidGeo = trackGeo(new THREE.BufferGeometry());
  const skidPositions = new Float32Array(MAX_SKID_SEGMENTS * 4 * 3);
  const skidNormals = new Float32Array(MAX_SKID_SEGMENTS * 4 * 3);
  const skidUvs = new Float32Array(MAX_SKID_SEGMENTS * 4 * 2);
  const skidColors = new Float32Array(MAX_SKID_SEGMENTS * 4 * 4);
  const skidIndices = new Uint16Array(MAX_SKID_SEGMENTS * 6);
  for (let i = 0; i < MAX_SKID_SEGMENTS; i++) {
    const v = i * 4;
    const ii = i * 6;
    skidIndices[ii] = v;
    skidIndices[ii + 1] = v + 2;
    skidIndices[ii + 2] = v + 1;
    skidIndices[ii + 3] = v;
    skidIndices[ii + 4] = v + 3;
    skidIndices[ii + 5] = v + 2;
    for (let k = 0; k < 4; k++) {
      skidNormals[(v + k) * 3 + 1] = 1;
    }
    skidUvs[(v + 0) * 2] = 0; skidUvs[(v + 0) * 2 + 1] = 0;
    skidUvs[(v + 1) * 2] = 1; skidUvs[(v + 1) * 2 + 1] = 0;
    skidUvs[(v + 2) * 2] = 1; skidUvs[(v + 2) * 2 + 1] = 1;
    skidUvs[(v + 3) * 2] = 0; skidUvs[(v + 3) * 2 + 1] = 1;
  }
  const skidPosAttr = new THREE.BufferAttribute(skidPositions, 3);
  skidPosAttr.setUsage(THREE.DynamicDrawUsage);
  const skidColorAttr = new THREE.BufferAttribute(skidColors, 4);
  skidColorAttr.setUsage(THREE.DynamicDrawUsage);
  skidGeo.setAttribute("position", skidPosAttr);
  skidGeo.setAttribute("normal", new THREE.BufferAttribute(skidNormals, 3));
  skidGeo.setAttribute("uv", new THREE.BufferAttribute(skidUvs, 2));
  skidGeo.setAttribute("color", skidColorAttr);
  skidGeo.setIndex(new THREE.BufferAttribute(skidIndices, 1));
  skidGeo.setDrawRange(0, 0);

  const skidMaterial = trackMat(new THREE.MeshBasicMaterial({
    name: "crash-tire-skid-ribbons-mat",
    map: skidTreadTex,
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -3,
    side: THREE.DoubleSide,
    forceSinglePass: true,
  }));
  const skidMesh = new THREE.Mesh(skidGeo, skidMaterial);
  skidMesh.name = "crash-tire-skid-ribbons";
  skidMesh.frustumCulled = false;
  skidMesh.renderOrder = 2;
  layer.add(skidMesh);

  // Volumetric FBM cloud billboard smoke pool (1 draw call)
  const smokeTexture = trackTex(createVolumetricSmokeTexture());
  const smokeGeo = new THREE.PlaneGeometry(1, 1);
  const smokeAlphaArray = new Float32Array(MAX_SMOKE_PUFFS);
  const smokeAlphaAttr = new THREE.InstancedBufferAttribute(smokeAlphaArray, 1);
  smokeAlphaAttr.setUsage(THREE.DynamicDrawUsage);
  smokeGeo.setAttribute("aSmokeAlpha", smokeAlphaAttr);

  const smokeMaterial = new THREE.MeshBasicMaterial({
    name: "crash-volumetric-smoke-mat",
    color: 0xffffff,
    map: smokeTexture,
    transparent: true,
    opacity: 1,
    depthWrite: false,
    side: THREE.DoubleSide,
    forceSinglePass: true,
    fog: true,
  });
  smokeMaterial.customProgramCacheKey = () => "crash-volumetric-smoke-billboard-v1";
  smokeMaterial.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        [
          "#include <common>",
          "attribute float aSmokeAlpha;",
          "varying float vSmokeAlpha;",
          "varying float vSmokeWorldUp;",
        ].join("\n"),
      )
      .replace(
        "#include <project_vertex>",
        [
          "#include <project_vertex>",
          "vSmokeAlpha = aSmokeAlpha;",
          "#ifdef USE_INSTANCING",
          "  vec3 smokeCenterW = (modelMatrix * vec4(instanceMatrix[3].xyz, 1.0)).xyz;",
          "  vec3 smokeVertW = (modelMatrix * (instanceMatrix * vec4(transformed, 1.0))).xyz;",
          "  float smokeSpan = max(0.05, length(instanceMatrix[1].xyz));",
          "  vSmokeWorldUp = clamp((smokeVertW.y - smokeCenterW.y) / smokeSpan, -0.5, 0.5) + 0.5;",
          "#else",
          "  vSmokeWorldUp = uv.y;",
          "#endif",
        ].join("\n"),
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        [
          "#include <common>",
          "varying float vSmokeAlpha;",
          "varying float vSmokeWorldUp;",
        ].join("\n"),
      )
      .replace(
        "#include <color_fragment>",
        [
          "#include <color_fragment>",
          "float smokeHemi = mix(0.84, 1.08, smoothstep(0.0, 1.0, vSmokeWorldUp));",
          "diffuseColor.rgb *= smokeHemi;",
          "diffuseColor.a *= clamp(vSmokeAlpha, 0.0, 1.0);",
          "if (diffuseColor.a < 0.002) discard;",
        ].join("\n"),
      );
  };
  smokeMaterial.userData.smokeTexture = smokeTexture;
  smokeMaterial.userData.usesPerInstanceSmokeAlpha = true;

  const smokeMesh = makeInstancedPool(
    smokeGeo,
    smokeMaterial,
    MAX_SMOKE_PUFFS,
    "crash-smoke-plumes",
  );
  smokeMesh.renderOrder = 4;
  smokeMesh.instanceColor = new THREE.InstancedBufferAttribute(
    new Float32Array(MAX_SMOKE_PUFFS * 3),
    3,
  );
  smokeMesh.instanceColor.setUsage(THREE.DynamicDrawUsage);

  const glassMatrixArray = glassMesh.instanceMatrix.array;
  const glassColorArray = glassMesh.instanceColor.array;
  const sparkMatrixArray = sparkMesh.instanceMatrix.array;
  const sparkColorArray = sparkMesh.instanceColor.array;
  const smokeMatrixArray = smokeMesh.instanceMatrix.array;
  const smokeColorArray = smokeMesh.instanceColor.array;

  const glassSlots = Array.from({ length: MAX_GLASS_SHARDS }, () => ({
    active: false, owner: "custom",
    x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
    rx: 0, ry: 0, rz: 0, vrx: 0, vry: 0, vrz: 0,
    scale: 1, color: 0xffffff, cr: 1, cg: 1, cb: 1, ageS: 0, ttlS: 2.0,
  }));

  const sparkSlots = Array.from({ length: MAX_IMPACT_SPARKS }, () => ({
    active: false, owner: "custom",
    x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
    color: 0xffffff, cr: 1, cg: 1, cb: 1, ageS: 0, ttlS: 0.42,
  }));

  const smokeSlots = Array.from({ length: MAX_SMOKE_PUFFS }, () => ({
    active: false,
    owner: "custom",
    smokeKind: "engine",
    x: 0, y: 0, z: 0,
    vx: 0, vy: 0, vz: 0,
    targetVy: 1.15,
    ry: 0, vry: 0,
    rz: 0, vrz: 0,
    phase: 0,
    curlAmp: 0.35,
    curlDirX: 1,
    curlDirZ: 0,
    aspectX: 1,
    aspectY: 1,
    startScale: 0.34,
    endScale: 1.85,
    baseOpacity: 0.42,
    color: STEAM_COLOR_HEX,
    cr: 1,
    cg: 1,
    cb: 1,
    ageS: 0,
    ttlS: 1.25,
  }));

  const skidSlots = Array.from({ length: MAX_SKID_SEGMENTS }, () => ({
    active: false,
    owner: "player",
    x0: 0, y0: SKID_GROUND_Y, z0: 0,
    x1: 0, y1: SKID_GROUND_Y, z1: 0,
    width: 0.24,
    baseAlpha: 0.55,
    ageS: 0,
    ttlS: 9.5,
  }));

  let rngState = 0x6d2b79f5;
  const rand = () => {
    rngState = (rngState + 0x6d2b79f5) | 0;
    let t = Math.imul(rngState ^ (rngState >>> 15), 1 | rngState);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const randRange = (lo, hi) => lo + (hi - lo) * rand();

  const mat4Scratch = new THREE.Matrix4();
  const posScratch = new THREE.Vector3();
  const scaleScratch = new THREE.Vector3();
  const quatScratch = new THREE.Quaternion();
  const eulerScratch = new THREE.Euler();
  const tmpColor = new THREE.Color();
  const steamColor = new THREE.Color(STEAM_COLOR_HEX);
  const smokeColor = new THREE.Color(ENGINE_SMOKE_HEX);
  const tireWarmColor = new THREE.Color(TIRE_SMOKE_WARM_HEX);
  const tireCoolColor = new THREE.Color(TIRE_SMOKE_COOL_HEX);
  const sparkDir = new THREE.Vector3();
  const forwardAxis = new THREE.Vector3(0, 0, 1);
  const spinQuat = new THREE.Quaternion();

  let disposed = false;
  const cursors = {
    debris: 0,
    glass: 0,
    spark: 0,
    smoke: 0,
    skid: 0,
  };

  let prevGlassCount = 0;
  let prevSparkCount = 0;
  let prevSmokeCount = 0;
  let prevSkidCount = 0;

  let smokeStepId = 0;
  let lastOrientedSmokeStepId = -1;
  let lastSmokeHasCamQuat = false;
  let lastSmokeQuatX = 0;
  let lastSmokeQuatY = 0;
  let lastSmokeQuatZ = 0;
  let lastSmokeQuatW = 1;
  let lastSmokeCamX = NaN;
  let lastSmokeCamY = NaN;
  let lastSmokeCamZ = NaN;
  let skidStepId = 0;
  let lastSyncedSkidStepId = -1;
  let glassStepId = 0;
  let lastSyncedGlassStepId = -1;
  let sparkStepId = 0;
  let lastSyncedSparkStepId = -1;

  const policeActorsScratch = [];
  const policeSeenSet = new Set();
  const playerVelScratch = { vx: 0, vz: 0 };
  const actorVelScratch = { vx: 0, vz: 0 };
  const tireStateScratch = { intensity: 0, lockup: false };
  const prevPlayerPoseObj = { valid: false, x: 0, z: 0, heading: 0 };
  const scrapingScratch = {
    active: true,
    kind: "barrier",
    wheel: null,
    side: null,
    intensity: 0,
    tangentialSpeedMps: 0,
    worldX: 0,
    worldY: null,
    worldZ: 0,
    normalX: 0,
    normalZ: 0,
  };
  const scrapeOriginScratch = { x: 0, y: 0, z: 0 };
  const scrapeBackScratch = { x: 0, z: 0 };
  const scrapeNormScratch = { x: 0, z: 0 };
  const glassPalette = [0xffffff, 0xe4f7ff, 0xc9ecff].map((hex) => {
    const c = new THREE.Color(hex);
    return { hex, r: c.r, g: c.g, b: c.b };
  });
  const impactSparkPalette = [0xffffff, 0xffe4ad, 0xffbe73].map((hex) => {
    const c = new THREE.Color(hex);
    return { hex, r: c.r, g: c.g, b: c.b };
  });
  const scrapeSparkPalette = [0xffffff, 0xfff8dc, 0xffdf85, 0xffbe55].map((hex) => {
    const c = new THREE.Color(hex);
    return { hex, r: c.r, g: c.g, b: c.b };
  });

  let totalBurstsSpawned = 0;
  const spawnedKinds = new Set();

  let lastPlayerImpactKey = "none:0";
  let prevImpactCount = 0;
  let prevRawImpactCount = 0;
  let prevImpactTick = null;
  let lastStepEventsTick = null;
  let playerSmokeTimerS = 0;
  let playerTireSmokeTimerS = 0;
  let playerExhaustTimerS = 0;
  let repairedThisStep = false;
  let lastExplicitCamera = null;
  const patrolSmokeTimers = new Map();
  const patrolTireSmokeTimers = new Map();
  const skidTracks = new Map();

  function markAttrRangeDirty(attr, elementCount) {
    if (!attr) return;
    const clamped = Math.min(attr.array.length, Math.max(0, elementCount));
    if (typeof attr.clearUpdateRanges === "function") {
      attr.clearUpdateRanges();
      if (clamped > 0) attr.addUpdateRange(0, clamped);
    } else if (attr.updateRange) {
      attr.updateRange.offset = 0;
      attr.updateRange.count = clamped > 0 ? clamped : -1;
    }
    attr.needsUpdate = true;
  }

  function allocSlot(pool, cursorKey) {
    const len = pool.length;
    const start = cursors[cursorKey];
    for (let k = 0; k < len; k++) {
      const idx = (start + k) % len;
      if (!pool[idx].active) {
        cursors[cursorKey] = (idx + 1) % len;
        return pool[idx];
      }
    }
    const slot = pool[start];
    cursors[cursorKey] = (start + 1) % len;
    return slot;
  }

  function orientAndSyncSmokeMesh(camera = null) {
    const camQuat = camera?.quaternion ?? null;
    const camPos = camera?.position ?? null;
    const useCamSpaceCull = Boolean(
      camQuat && camPos && (camPos.x !== 0 || camPos.y !== 0 || camPos.z !== 0),
    );
    if (
      lastOrientedSmokeStepId === smokeStepId &&
      (camQuat
        ? (lastSmokeHasCamQuat &&
            Math.abs(camQuat.x - lastSmokeQuatX) <= 1e-6 &&
            Math.abs(camQuat.y - lastSmokeQuatY) <= 1e-6 &&
            Math.abs(camQuat.z - lastSmokeQuatZ) <= 1e-6 &&
            Math.abs(camQuat.w - lastSmokeQuatW) <= 1e-6 &&
            (!useCamSpaceCull ||
              (Math.abs(camPos.x - lastSmokeCamX) <= 0.04 &&
                Math.abs(camPos.y - lastSmokeCamY) <= 0.04 &&
                Math.abs(camPos.z - lastSmokeCamZ) <= 0.04)))
        : !lastSmokeHasCamQuat)
    ) {
      return;
    }

    let crx = 1, cry = 0, crz = 0;
    let cux = 0, cuy = 1, cuz = 0;
    let cfx = 0, cfy = 0, cfz = 1;
    if (camQuat) {
      const qx = camQuat.x, qy = camQuat.y, qz = camQuat.z, qw = camQuat.w;
      const x2 = qx + qx, y2 = qy + qy, z2 = qz + qz;
      const xx = qx * x2, xy = qx * y2, xz = qx * z2;
      const yy = qy * y2, yz = qy * z2, zz = qz * z2;
      const wx = qw * x2, wy = qw * y2, wz = qw * z2;
      crx = 1 - (yy + zz); cry = xy + wz; crz = xz - wy;
      cux = xy - wz; cuy = 1 - (xx + zz); cuz = yz + wx;
      cfx = xz + wy; cfy = yz - wx; cfz = 1 - (xx + yy);
    }

    let count = 0;
    for (let i = 0; i < MAX_SMOKE_PUFFS; i++) {
      const s = smokeSlots[i];
      if (!s.active) continue;
      const u = clamp(s.ageS / s.ttlS, 0, 1);
      const expandEase = 1 - Math.pow(1 - u, 2.2);
      let scale = s.startScale + (s.endScale - s.startScale) * expandEase;
      const fadeIn = smoothstep(0.0, 0.12, u);
      const fadeOut = Math.pow(Math.max(0, 1 - smoothstep(0.32, 1.0, u)), 1.35);
      let alpha = clamp(fadeIn * fadeOut * s.baseOpacity, 0, 1);
      if (useCamSpaceCull) {
        const dx = s.x - camPos.x;
        const dy = s.y - camPos.y;
        const dz = s.z - camPos.z;
        const alongForward = -(dx * cfx + dy * cfy + dz * cfz);
        if (alongForward < -scale * 0.65) continue;
        const distSq = dx * dx + dy * dy + dz * dz;
        if (distSq < 1.15 * 1.15) continue;
        if (distSq < 20.25) {
          const dist = Math.sqrt(distSq);
          scale = Math.min(scale, dist * 0.68);
          if (dist < 2.5) alpha *= smoothstep(1.15, 2.5, dist);
        }
      }

      const idx = count++;
      const sx = scale * s.aspectX;
      const sy = scale * s.aspectY;
      const mOff = idx * 16;
      if (camQuat) {
        const cosR = Math.cos(s.rz);
        const sinR = Math.sin(s.rz);
        smokeMatrixArray[mOff] = (crx * cosR + cux * sinR) * sx;
        smokeMatrixArray[mOff + 1] = (cry * cosR + cuy * sinR) * sx;
        smokeMatrixArray[mOff + 2] = (crz * cosR + cuz * sinR) * sx;
        smokeMatrixArray[mOff + 3] = 0;
        smokeMatrixArray[mOff + 4] = (cux * cosR - crx * sinR) * sy;
        smokeMatrixArray[mOff + 5] = (cuy * cosR - cry * sinR) * sy;
        smokeMatrixArray[mOff + 6] = (cuz * cosR - crz * sinR) * sy;
        smokeMatrixArray[mOff + 7] = 0;
        smokeMatrixArray[mOff + 8] = cfx * scale;
        smokeMatrixArray[mOff + 9] = cfy * scale;
        smokeMatrixArray[mOff + 10] = cfz * scale;
        smokeMatrixArray[mOff + 11] = 0;
        smokeMatrixArray[mOff + 12] = s.x;
        smokeMatrixArray[mOff + 13] = s.y;
        smokeMatrixArray[mOff + 14] = s.z;
        smokeMatrixArray[mOff + 15] = 1;
      } else {
        posScratch.set(s.x, s.y, s.z);
        eulerScratch.set(0, s.ry, s.rz);
        quatScratch.setFromEuler(eulerScratch);
        scaleScratch.set(sx, sy, scale);
        mat4Scratch.compose(posScratch, quatScratch, scaleScratch);
        mat4Scratch.toArray(smokeMatrixArray, mOff);
      }

      const c3 = idx * 3;
      smokeColorArray[c3] = s.cr;
      smokeColorArray[c3 + 1] = s.cg;
      smokeColorArray[c3 + 2] = s.cb;
      smokeAlphaArray[idx] = alpha;
    }
    smokeMesh.count = count;
    if (count > 0 || prevSmokeCount > 0) {
      const dirtySmoke = Math.max(count, prevSmokeCount);
      if (count < prevSmokeCount) {
        smokeAlphaArray.fill(0, count, prevSmokeCount);
      }
      markAttrRangeDirty(smokeMesh.instanceMatrix, dirtySmoke * 16);
      if (smokeMesh.instanceColor) markAttrRangeDirty(smokeMesh.instanceColor, dirtySmoke * 3);
      markAttrRangeDirty(smokeAlphaAttr, dirtySmoke);
    }
    prevSmokeCount = count;
    lastOrientedSmokeStepId = smokeStepId;
    if (camQuat) {
      lastSmokeHasCamQuat = true;
      lastSmokeQuatX = camQuat.x;
      lastSmokeQuatY = camQuat.y;
      lastSmokeQuatZ = camQuat.z;
      lastSmokeQuatW = camQuat.w;
      if (camPos) {
        lastSmokeCamX = camPos.x;
        lastSmokeCamY = camPos.y;
        lastSmokeCamZ = camPos.z;
      }
    } else {
      lastSmokeHasCamQuat = false;
    }
  }

  smokeMesh.onBeforeRender = (_renderer, _scene, renderCamera) => {
    if (disposed || !renderCamera?.quaternion || smokeMesh.count === 0) return;
    const rq = renderCamera.quaternion;
    if (
      lastOrientedSmokeStepId === smokeStepId &&
      lastSmokeHasCamQuat &&
      Math.abs(rq.x - lastSmokeQuatX) <= 1e-6 &&
      Math.abs(rq.y - lastSmokeQuatY) <= 1e-6 &&
      Math.abs(rq.z - lastSmokeQuatZ) <= 1e-6 &&
      Math.abs(rq.w - lastSmokeQuatW) <= 1e-6
    ) {
      return;
    }
    orientAndSyncSmokeMesh(renderCamera);
  };

  function spawnDebrisPart(kind, poseSpec) {
    const validKind = CANONICAL_PARTS.has(kind) ? kind : "bumper-corner";
    const slot = allocSlot(debrisSlots, "debris");

    slot.active = true;
    slot.kind = validKind;
    slot.owner = poseSpec.owner ?? "custom";
    slot.mesh.geometry = partGeometries[validKind];
    slot.mesh.visible = true;

    slot.x = poseSpec.x;
    slot.y = Math.max(DEBRIS_GROUND_Y + 0.05, poseSpec.y);
    slot.z = poseSpec.z;
    slot.vx = poseSpec.vx;
    slot.vy = poseSpec.vy;
    slot.vz = poseSpec.vz;
    slot.rx = randRange(-0.35, 0.35);
    slot.ry = poseSpec.heading ?? 0;
    slot.rz = randRange(-0.35, 0.35);
    slot.vrx = randRange(-7.5, 7.5);
    slot.vry = randRange(-6.2, 6.2);
    slot.vrz = randRange(-7.5, 7.5);
    slot.ageS = 0;
    slot.ttlS = 5.5;
    slot.groundY = DEBRIS_GROUND_Y + Math.max(0, poseSpec.baseElev ?? 0);
    slot.baseScale = 1;

    if (validKind === "lightbar-lens") {
      const lensHex = rand() < 0.5 ? 0xff2e4c : 0x3b9eff;
      slot.material.color.setHex(lensHex);
      slot.material.emissive.setHex(lensHex);
      slot.material.emissiveIntensity = 0.45;
      slot.baseOpacity = 0.82;
    } else if (PAINTED_PARTS.has(validKind)) {
      slot.material.color.setHex(poseSpec.color ?? PLAYER_OLIVE_PAINT);
      slot.material.emissive.setHex(0x000000);
      slot.material.emissiveIntensity = 0;
      slot.baseOpacity = 1;
    } else {
      slot.material.color.setHex(0xffffff);
      slot.material.emissive.setHex(0x000000);
      slot.material.emissiveIntensity = 0;
      slot.baseOpacity = 1;
    }
    slot.material.opacity = slot.baseOpacity;
    slot.mesh.position.set(slot.x, slot.y, slot.z);
    slot.mesh.rotation.set(slot.rx, slot.ry, slot.rz);
    slot.mesh.scale.setScalar(1);

    spawnedKinds.add(validKind);
  }

  function spawnGlassShards(origin, baseVel, count, owner) {
    if (count > 0) glassStepId++;
    for (let i = 0; i < count; i++) {
      const slot = allocSlot(glassSlots, "glass");
      const angle = randRange(0, Math.PI * 2);
      const speed = randRange(1.8, 6.4);
      const pal = glassPalette[i % glassPalette.length];
      slot.active = true;
      slot.owner = owner;
      slot.x = origin.x + randRange(-0.42, 0.42);
      slot.y = Math.max(GLASS_GROUND_Y + 0.08, origin.y + randRange(-0.1, 0.28));
      slot.z = origin.z + randRange(-0.42, 0.42);
      slot.vx = baseVel.x * 0.55 + Math.sin(angle) * speed;
      slot.vy = randRange(1.6, 4.6);
      slot.vz = baseVel.z * 0.55 + Math.cos(angle) * speed;
      slot.rx = randRange(0, Math.PI * 2);
      slot.ry = randRange(0, Math.PI * 2);
      slot.rz = randRange(0, Math.PI * 2);
      slot.vrx = randRange(-14, 14);
      slot.vry = randRange(-14, 14);
      slot.vrz = randRange(-14, 14);
      slot.scale = randRange(0.75, 1.45);
      slot.color = pal.hex;
      slot.cr = pal.r;
      slot.cg = pal.g;
      slot.cb = pal.b;
      slot.ageS = 0;
      slot.ttlS = randRange(1.6, 2.5);
    }
  }

  function spawnImpactSparks(origin, baseVel, normalDir, count, owner) {
    if (count > 0) sparkStepId++;
    const baseYaw = Math.atan2(normalDir.x, normalDir.z);
    for (let i = 0; i < count; i++) {
      const slot = allocSlot(sparkSlots, "spark");
      const tangentYaw = baseYaw + (rand() < 0.5 ? 1 : -1) * randRange(0.7, 2.1);
      const burstSpeed = randRange(4.2, 11.4);
      const pal = impactSparkPalette[i % impactSparkPalette.length];
      slot.active = true;
      slot.owner = owner;
      slot.x = origin.x + randRange(-0.28, 0.28);
      slot.y = Math.max(SPARK_GROUND_Y + 0.12, origin.y + randRange(-0.08, 0.22));
      slot.z = origin.z + randRange(-0.28, 0.28);
      slot.vx = baseVel.x * 0.4 + Math.sin(tangentYaw) * burstSpeed;
      slot.vy = randRange(1.4, 4.9);
      slot.vz = baseVel.z * 0.4 + Math.cos(tangentYaw) * burstSpeed;
      slot.color = pal.hex;
      slot.cr = pal.r;
      slot.cg = pal.g;
      slot.cb = pal.b;
      slot.ageS = 0;
      slot.ttlS = randRange(0.32, 0.55);
    }
  }

  function spawnScrapeSparks(origin, tangentBackDir, normalDir, speedMps, intensity, count, owner = "player") {
    if (count > 0) sparkStepId++;
    const baseJet = clamp(4.2 + speedMps * 0.56, 4.6, 13.8) * (0.78 + 0.45 * intensity);
    for (let i = 0; i < count; i++) {
      const slot = allocSlot(sparkSlots, "spark");
      const spread = randRange(-0.36, 0.36);
      const cosS = Math.cos(spread);
      const sinS = Math.sin(spread);
      const tx = tangentBackDir.x * cosS - tangentBackDir.z * sinS;
      const tz = tangentBackDir.x * sinS + tangentBackDir.z * cosS;
      // normalDir points outward away from the obstacle into the open street gap!
      const gapOffset = randRange(0.08, 0.30);
      const outPush = randRange(0.75, 2.35);
      const jet = baseJet * randRange(0.78, 1.28);
      const pal = scrapeSparkPalette[i % scrapeSparkPalette.length];
      slot.active = true;
      slot.owner = owner;
      slot.x = origin.x + normalDir.x * gapOffset + randRange(-0.08, 0.08);
      slot.y = Math.max(SPARK_GROUND_Y + 0.18, origin.y + randRange(0.04, 0.30));
      slot.z = origin.z + normalDir.z * gapOffset + randRange(-0.08, 0.08);
      slot.vx = tx * jet + normalDir.x * outPush;
      slot.vy = randRange(1.85, 4.85) * (0.75 + 0.45 * intensity);
      slot.vz = tz * jet + normalDir.z * outPush;
      slot.color = pal.hex;
      slot.cr = pal.r;
      slot.cg = pal.g;
      slot.cb = pal.b;
      slot.ageS = 0;
      slot.ttlS = randRange(0.30, 0.54);
    }
  }

  function spawnSmokePuff(
    x,
    y,
    z,
    colorHex,
    owner = "player",
    options = {},
  ) {
    const slot = allocSlot(smokeSlots, "smoke");
    smokeStepId++;
    const emitterVx = Number.isFinite(options.emitterVx) ? options.emitterVx : 0;
    const emitterVz = Number.isFinite(options.emitterVz) ? options.emitterVz : 0;
    const extraVx = Number.isFinite(options.extraVx) ? options.extraVx : randRange(-0.42, 0.42);
    const extraVz = Number.isFinite(options.extraVz) ? options.extraVz : randRange(-0.42, 0.42);
    const jitterXZ = Number.isFinite(options.jitterXZ) ? options.jitterXZ : 0.14;
    const curlAngle = randRange(0, Math.PI * 2);

    slot.active = true;
    slot.owner = owner;
    slot.smokeKind = options.smokeKind ?? "engine";
    slot.x = x + randRange(-jitterXZ, jitterXZ);
    slot.y = y + randRange(-0.03, 0.07);
    slot.z = z + randRange(-jitterXZ, jitterXZ);
    slot.vx = 0.28 * emitterVx + extraVx;
    slot.vz = 0.28 * emitterVz + extraVz;
    slot.targetVy = Number.isFinite(options.targetVy) ? options.targetVy : randRange(0.95, 1.62);
    slot.vy = Number.isFinite(options.initialVy) ? options.initialVy : slot.targetVy * randRange(0.45, 0.78);
    slot.ry = randRange(0, Math.PI * 2);
    slot.vry = randRange(-0.85, 0.85);
    slot.rz = randRange(0, Math.PI * 2);
    slot.vrz = Number.isFinite(options.vrz) ? options.vrz : randRange(-0.95, 0.95);
    slot.phase = randRange(0, Math.PI * 2);
    slot.curlAmp = Number.isFinite(options.curlAmp) ? options.curlAmp : randRange(0.28, 0.62);
    slot.curlDirX = Math.cos(curlAngle);
    slot.curlDirZ = Math.sin(curlAngle);
    slot.aspectX = randRange(0.94, 1.08);
    slot.aspectY = randRange(0.92, 1.06);
    slot.startScale = Number.isFinite(options.startScale) ? options.startScale : randRange(0.30, 0.50);
    slot.endScale = Number.isFinite(options.endScale) ? options.endScale : randRange(1.55, 2.70);
    slot.baseOpacity = Number.isFinite(options.baseOpacity) ? options.baseOpacity : 0.44;
    slot.color = colorHex;
    tmpColor.setHex(colorHex);
    slot.cr = tmpColor.r;
    slot.cg = tmpColor.g;
    slot.cb = tmpColor.b;
    slot.ageS = 0;
    slot.ttlS = Number.isFinite(options.ttlS) ? options.ttlS : randRange(1.10, 1.65);
    return slot;
  }

  function pushSkidSegment(world, x0, z0, x1, z1, width = 0.24, baseAlpha = 0.55, owner = "player") {
    const dx = x1 - x0;
    const dz = z1 - z0;
    if (Math.hypot(dx, dz) < 0.04) return;
    const slot = allocSlot(skidSlots, "skid");
    skidStepId++;
    slot.active = true;
    slot.owner = owner;
    slot.x0 = x0;
    slot.y0 = SKID_GROUND_Y + worldElevAt(world, x0, z0);
    slot.z0 = z0;
    slot.x1 = x1;
    slot.y1 = SKID_GROUND_Y + worldElevAt(world, x1, z1);
    slot.z1 = z1;
    slot.width = width;
    slot.baseAlpha = clamp(baseAlpha, 0.08, 0.719);
    slot.ageS = 0;
    slot.ttlS = 9.5;
  }

  function stampWheelSkid(world, trackKey, wx, wz, vx, vz, dt, width = 0.24, baseAlpha = 0.55, owner = "player") {
    const speed = Math.hypot(vx, vz);
    let track = skidTracks.get(trackKey);
    if (!track) {
      track = { lastX: wx, lastZ: wz, ageSinceStampS: 0, stationaryCooldownS: 0, initialized: false };
      skidTracks.set(trackKey, track);
    }

    if (!track.initialized || track.ageSinceStampS > 0.16) {
      track.initialized = true;
      track.lastX = wx;
      track.lastZ = wz;
      track.ageSinceStampS = 0;
      track.stationaryCooldownS = 0.06;
      if (speed > 0.8) {
        const len = clamp(speed * Math.max(dt, 1 / 60) * 1.35, 0.20, 0.52);
        const dirX = vx / speed;
        const dirZ = vz / speed;
        pushSkidSegment(world, wx - dirX * len, wz - dirZ * len, wx, wz, width, baseAlpha, owner);
      }
      return;
    }

    track.ageSinceStampS = 0;
    const moved = Math.hypot(wx - track.lastX, wz - track.lastZ);
    if (moved >= 0.14 && moved <= 3.2) {
      pushSkidSegment(world, track.lastX, track.lastZ, wx, wz, width, baseAlpha, owner);
      track.lastX = wx;
      track.lastZ = wz;
      track.stationaryCooldownS = 0.06;
    } else if (moved > 3.2) {
      track.lastX = wx;
      track.lastZ = wz;
    } else if (moved < 0.02 && speed > 1.2) {
      track.stationaryCooldownS -= dt;
      if (track.stationaryCooldownS <= 0) {
        track.stationaryCooldownS = 0.065;
        const len = clamp(speed * Math.max(dt, 1 / 60) * 1.2, 0.20, 0.46);
        const dirX = vx / speed;
        const dirZ = vz / speed;
        pushSkidSegment(world, wx - dirX * len * 0.5, wz - dirZ * len * 0.5, wx + dirX * len * 0.5, wz + dirZ * len * 0.5, width, baseAlpha, owner);
      }
    }
  }

  function syncSkidMesh() {
    if (lastSyncedSkidStepId === skidStepId) return;
    lastSyncedSkidStepId = skidStepId;
    let activeCount = 0;
    const [rr, rg, rb] = SKID_RUBBER_RGB;
    for (const s of skidSlots) {
      if (!s.active) continue;
      const dx = s.x1 - s.x0;
      const dz = s.z1 - s.z0;
      const len = Math.hypot(dx, dz);
      if (len < 1e-4) continue;

      const u = clamp(s.ageS / s.ttlS, 0, 1);
      const alpha = clamp(s.baseAlpha * (1 - smoothstep(0.42, 1.0, u)), 0, 1);
      if (alpha <= 0.004) continue;

      const halfW = s.width * 0.5;
      const rx = (dz / len) * halfW;
      const rz = (-dx / len) * halfW;

      const vBase = activeCount * 4;
      const pOff = vBase * 3;
      const cOff = vBase * 4;

      skidPositions[pOff] = s.x0 - rx;
      skidPositions[pOff + 1] = s.y0;
      skidPositions[pOff + 2] = s.z0 - rz;

      skidPositions[pOff + 3] = s.x0 + rx;
      skidPositions[pOff + 4] = s.y0;
      skidPositions[pOff + 5] = s.z0 + rz;

      skidPositions[pOff + 6] = s.x1 + rx;
      skidPositions[pOff + 7] = s.y1;
      skidPositions[pOff + 8] = s.z1 + rz;

      skidPositions[pOff + 9] = s.x1 - rx;
      skidPositions[pOff + 10] = s.y1;
      skidPositions[pOff + 11] = s.z1 - rz;

      for (let k = 0; k < 4; k++) {
        const ci = cOff + k * 4;
        skidColors[ci] = rr;
        skidColors[ci + 1] = rg;
        skidColors[ci + 2] = rb;
        skidColors[ci + 3] = alpha;
      }
      activeCount++;
    }
    skidGeo.setDrawRange(0, activeCount * 6);
    if (activeCount > 0 || prevSkidCount > 0) {
      const dirtyVerts = Math.max(activeCount, prevSkidCount) * 4;
      markAttrRangeDirty(skidPosAttr, dirtyVerts * 3);
      markAttrRangeDirty(skidColorAttr, dirtyVerts * 4);
    }
    prevSkidCount = activeCount;
  }

  function syncInstancedMeshes(camera = lastExplicitCamera) {
    if (lastSyncedGlassStepId !== glassStepId) {
      lastSyncedGlassStepId = glassStepId;
      let glassCount = 0;
      for (let i = 0; i < MAX_GLASS_SHARDS; i++) {
        const s = glassSlots[i];
        if (!s.active) continue;
        const rem = s.ttlS - s.ageS;
        const fade = rem < 0.45 ? Math.max(0.05, rem / 0.45) : 1;
        posScratch.set(s.x, s.y, s.z);
        eulerScratch.set(s.rx, s.ry, s.rz);
        quatScratch.setFromEuler(eulerScratch);
        scaleScratch.setScalar(s.scale * fade);
        mat4Scratch.compose(posScratch, quatScratch, scaleScratch);
        const idx = glassCount++;
        mat4Scratch.toArray(glassMatrixArray, idx * 16);
        const gc3 = idx * 3;
        glassColorArray[gc3] = s.cr;
        glassColorArray[gc3 + 1] = s.cg;
        glassColorArray[gc3 + 2] = s.cb;
      }
      glassMesh.count = glassCount;
      if (glassCount > 0 || prevGlassCount > 0) {
        const dirtyGlass = Math.max(glassCount, prevGlassCount);
        markAttrRangeDirty(glassMesh.instanceMatrix, dirtyGlass * 16);
        if (glassMesh.instanceColor) markAttrRangeDirty(glassMesh.instanceColor, dirtyGlass * 3);
      }
      prevGlassCount = glassCount;
    }

    if (lastSyncedSparkStepId !== sparkStepId) {
      lastSyncedSparkStepId = sparkStepId;
      let sparkCount = 0;
      for (let i = 0; i < MAX_IMPACT_SPARKS; i++) {
        const s = sparkSlots[i];
        if (!s.active) continue;
        const u = clamp(s.ageS / s.ttlS, 0, 1);
        const speed = Math.hypot(s.vx, s.vy, s.vz);
        const thickness = Math.max(0.022, 0.048 * (1 - u * 0.58));
        const length = Math.max(0.14, Math.min(0.62, 0.18 + speed * 0.036) * (1 - u * 0.45));
        const idx = sparkCount++;
        const mOff = idx * 16;
        if (speed > 1e-4) {
          const invSpd = 1 / speed;
          const fx = s.vx * invSpd;
          const fy = s.vy * invSpd;
          const fz = s.vz * invSpd;
          if (fz > -0.99999) {
            const k = 1 / (1 + fz);
            sparkMatrixArray[mOff] = (1 - fx * fx * k) * thickness;
            sparkMatrixArray[mOff + 1] = (-fx * fy * k) * thickness;
            sparkMatrixArray[mOff + 2] = -fx * thickness;
            sparkMatrixArray[mOff + 3] = 0;
            sparkMatrixArray[mOff + 4] = (-fx * fy * k) * thickness;
            sparkMatrixArray[mOff + 5] = (1 - fy * fy * k) * thickness;
            sparkMatrixArray[mOff + 6] = -fy * thickness;
            sparkMatrixArray[mOff + 7] = 0;
          } else {
            sparkMatrixArray[mOff] = -thickness;
            sparkMatrixArray[mOff + 1] = 0;
            sparkMatrixArray[mOff + 2] = 0;
            sparkMatrixArray[mOff + 3] = 0;
            sparkMatrixArray[mOff + 4] = 0;
            sparkMatrixArray[mOff + 5] = thickness;
            sparkMatrixArray[mOff + 6] = 0;
            sparkMatrixArray[mOff + 7] = 0;
          }
          sparkMatrixArray[mOff + 8] = fx * length;
          sparkMatrixArray[mOff + 9] = fy * length;
          sparkMatrixArray[mOff + 10] = fz * length;
          sparkMatrixArray[mOff + 11] = 0;
        } else {
          sparkMatrixArray[mOff] = thickness;
          sparkMatrixArray[mOff + 1] = 0;
          sparkMatrixArray[mOff + 2] = 0;
          sparkMatrixArray[mOff + 3] = 0;
          sparkMatrixArray[mOff + 4] = 0;
          sparkMatrixArray[mOff + 5] = thickness;
          sparkMatrixArray[mOff + 6] = 0;
          sparkMatrixArray[mOff + 7] = 0;
          sparkMatrixArray[mOff + 8] = 0;
          sparkMatrixArray[mOff + 9] = 0;
          sparkMatrixArray[mOff + 10] = length;
          sparkMatrixArray[mOff + 11] = 0;
        }
        sparkMatrixArray[mOff + 12] = s.x;
        sparkMatrixArray[mOff + 13] = s.y;
        sparkMatrixArray[mOff + 14] = s.z;
        sparkMatrixArray[mOff + 15] = 1;
        const sc3 = idx * 3;
        sparkColorArray[sc3] = s.cr;
        sparkColorArray[sc3 + 1] = s.cg;
        sparkColorArray[sc3 + 2] = s.cb;
      }
      sparkMesh.count = sparkCount;
      if (sparkCount > 0 || prevSparkCount > 0) {
        const dirtySparks = Math.max(sparkCount, prevSparkCount);
        markAttrRangeDirty(sparkMesh.instanceMatrix, dirtySparks * 16);
        if (sparkMesh.instanceColor) markAttrRangeDirty(sparkMesh.instanceColor, dirtySparks * 3);
      }
      prevSparkCount = sparkCount;
    }

    orientAndSyncSmokeMesh(camera);
    syncSkidMesh();
  }

  function spawnBurst({
    x = 0,
    y = 0,
    z = 0,
    heading = 0,
    vx = 0,
    vz = 0,
    width = 1.85,
    length = 4.2,
    side = "front",
    energyJ = 24000,
    parts,
    color = PLAYER_OLIVE_PAINT,
    shatterGlass = true,
    owner = "custom",
  } = {}) {
    if (disposed) return;
    totalBurstsSpawned++;

    const sin = Math.sin(heading);
    const cos = Math.cos(heading);
    const toWorld = (lx, lz) => ({
      x: x + lx * cos + lz * sin,
      z: z - lx * sin + lz * cos,
    });

    const sideLocal = side === "rear"
      ? { lx: 0, lz: -length * 0.5, nx: 0, nz: -1 }
      : side === "left"
        ? { lx: -width * 0.5, lz: 0, nx: -1, nz: 0 }
        : side === "right"
          ? { lx: width * 0.5, lz: 0, nx: 1, nz: 0 }
          : { lx: 0, lz: length * 0.5, nx: 0, nz: 1 };

    const impactWorld = toWorld(sideLocal.lx, sideLocal.lz);
    const normalWorld = {
      x: sideLocal.nx * cos + sideLocal.nz * sin,
      z: -sideLocal.nx * sin + sideLocal.nz * cos,
    };
    const origin = { x: impactWorld.x, y: y + 0.62, z: impactWorld.z };
    const baseVel = { x: vx, z: vz };

    const intensity = clamp(energyJ / 36000, 0.25, 1.5);
    const sparkCount = Math.round(10 + 16 * intensity);
    spawnImpactSparks(origin, baseVel, normalWorld, sparkCount, owner);

    if (shatterGlass) {
      const shardCount = Math.round(8 + 14 * intensity);
      spawnGlassShards({ x: origin.x, y: y + 0.86, z: origin.z }, baseVel, shardCount, owner);
    }

    const chosenParts = Array.isArray(parts)
      ? parts.map((p) => normalizePartKind(p, side)).filter(Boolean)
      : derivePartsFromImpact(side, energyJ);

    const impulseMag = clamp(2.6 + Math.sqrt(Math.max(0, energyJ)) * 0.018, 2.6, 8.2);
    chosenParts.forEach((kind, idx) => {
      const mount = partLocalMount(kind, side, width, length, idx);
      const wp = toWorld(mount.x, mount.z);
      const outW = {
        x: mount.outX * cos + mount.outZ * sin,
        z: -mount.outX * sin + mount.outZ * cos,
      };
      const outLen = Math.hypot(outW.x, outW.z) || 1;
      const jitterYaw = randRange(-0.42, 0.42);
      const dirX = (outW.x / outLen) * Math.cos(jitterYaw) - (outW.z / outLen) * Math.sin(jitterYaw);
      const dirZ = (outW.x / outLen) * Math.sin(jitterYaw) + (outW.z / outLen) * Math.cos(jitterYaw);
      const speed = impulseMag * randRange(0.78, 1.24);
      spawnDebrisPart(kind, {
        owner,
        color,
        heading,
        x: wp.x,
        y: y + mount.y,
        baseElev: y,
        z: wp.z,
        vx: vx * 0.65 + dirX * speed,
        vy: randRange(2.3, 5.1) * clamp(intensity, 0.65, 1.25),
        vz: vz * 0.65 + dirZ * speed,
      });
    });

    syncInstancedMeshes();
  }

  function clearPlayerDebris() {
    for (const slot of debrisSlots) {
      if (slot.active && slot.owner === "player") {
        slot.active = false;
        slot.mesh.visible = false;
      }
    }
    for (const slot of glassSlots) {
      if (slot.active && slot.owner === "player") slot.active = false;
    }
    for (const slot of sparkSlots) {
      if (slot.active && slot.owner === "player") slot.active = false;
    }
    for (const slot of smokeSlots) {
      if (slot.active && slot.owner === "player") slot.active = false;
    }
    for (const slot of skidSlots) {
      if (slot.active && slot.owner === "player") slot.active = false;
    }
    for (const key of skidTracks.keys()) {
      if (String(key).startsWith("player:")) skidTracks.delete(key);
    }
    playerSmokeTimerS = 0;
    playerTireSmokeTimerS = 0;
    playerExhaustTimerS = 0;
    smokeStepId++;
    skidStepId++;
    glassStepId++;
    sparkStepId++;
    syncInstancedMeshes();
  }

  function reset() {
    for (const slot of debrisSlots) {
      slot.active = false;
      slot.mesh.visible = false;
    }
    for (const slot of glassSlots) slot.active = false;
    for (const slot of sparkSlots) slot.active = false;
    for (const slot of smokeSlots) slot.active = false;
    for (const slot of skidSlots) slot.active = false;
    glassMesh.count = 0;
    sparkMesh.count = 0;
    smokeMesh.count = 0;
    skidGeo.setDrawRange(0, 0);
    if (prevGlassCount > 0) {
      markAttrRangeDirty(glassMesh.instanceMatrix, prevGlassCount * 16);
      if (glassMesh.instanceColor) markAttrRangeDirty(glassMesh.instanceColor, prevGlassCount * 3);
    }
    if (prevSparkCount > 0) {
      markAttrRangeDirty(sparkMesh.instanceMatrix, prevSparkCount * 16);
      if (sparkMesh.instanceColor) markAttrRangeDirty(sparkMesh.instanceColor, prevSparkCount * 3);
    }
    if (prevSmokeCount > 0) {
      smokeAlphaArray.fill(0, 0, prevSmokeCount);
      markAttrRangeDirty(smokeMesh.instanceMatrix, prevSmokeCount * 16);
      if (smokeMesh.instanceColor) markAttrRangeDirty(smokeMesh.instanceColor, prevSmokeCount * 3);
      markAttrRangeDirty(smokeAlphaAttr, prevSmokeCount);
    } else {
      smokeAlphaArray.fill(0);
    }
    if (prevSkidCount > 0) {
      const dirtyVerts = prevSkidCount * 4;
      markAttrRangeDirty(skidPosAttr, dirtyVerts * 3);
      markAttrRangeDirty(skidColorAttr, dirtyVerts * 4);
    }
    prevGlassCount = 0;
    prevSparkCount = 0;
    prevSmokeCount = 0;
    prevSkidCount = 0;
    smokeStepId++;
    lastOrientedSmokeStepId = -1;
    lastSmokeHasCamQuat = false;
    skidStepId++;
    lastSyncedSkidStepId = -1;
    glassStepId++;
    lastSyncedGlassStepId = -1;
    sparkStepId++;
    lastSyncedSparkStepId = -1;
    cursors.debris = 0;
    cursors.glass = 0;
    cursors.spark = 0;
    cursors.smoke = 0;
    cursors.skid = 0;
    totalBurstsSpawned = 0;
    spawnedKinds.clear();
    lastPlayerImpactKey = "none:0";
    prevImpactCount = 0;
    prevRawImpactCount = 0;
    prevImpactTick = null;
    lastStepEventsTick = null;
    playerSmokeTimerS = 0;
    playerTireSmokeTimerS = 0;
    playerExhaustTimerS = 0;
    prevPlayerPoseObj.valid = false;
    repairedThisStep = false;
    lastExplicitCamera = null;
    patrolSmokeTimers.clear();
    patrolTireSmokeTimers.clear();
    skidTracks.clear();
  }

  function actorWorldVelocity(actor, out = actorVelScratch) {
    if (Number.isFinite(actor?.vx) && Number.isFinite(actor?.vz)) {
      out.vx = actor.vx;
      out.vz = actor.vz;
      return out;
    }
    const h = actor?.heading ?? 0;
    const speed = actor?.speed ?? 0;
    const slip = actor?.gtaSlipMps ?? 0;
    const sinH = Math.sin(h);
    const cosH = Math.cos(h);
    out.vx = sinH * speed + cosH * slip;
    out.vz = cosH * speed - sinH * slip;
    return out;
  }

  function collectPoliceActors(world) {
    policeActorsScratch.length = 0;
    policeSeenSet.clear();
    const patrols = world?.pursuit?.patrols;
    const hasPatrolSet = patrols instanceof Set;
    if (hasPatrolSet && world?.pursuit?.street) {
      for (const a of patrols) {
        if (!a || policeSeenSet.has(a)) continue;
        policeSeenSet.add(a);
        policeActorsScratch.push(a);
      }
      return policeActorsScratch;
    }
    const actors = world?.actors;
    if (Array.isArray(actors)) {
      for (let i = 0, n = actors.length; i < n; i++) {
        const a = actors[i];
        if (!a) continue;
        if (a.pursuitRole !== "police" && !a.unitType && !(hasPatrolSet && patrols.has(a))) continue;
        if (policeSeenSet.has(a)) continue;
        policeSeenSet.add(a);
        policeActorsScratch.push(a);
      }
    }
    if (patrols && typeof patrols[Symbol.iterator] === "function") {
      for (const a of patrols) {
        if (!a || policeSeenSet.has(a)) continue;
        policeSeenSet.add(a);
        policeActorsScratch.push(a);
      }
    }
    return policeActorsScratch;
  }

  const worldElevAt = (world, x, z) =>
    typeof world?.terrainElevationAt === "function" && Number.isFinite(x) && Number.isFinite(z)
      ? world.terrainElevationAt(x, z)
      : 0;

  function resolvePatrolEventPose(world, event, policeActors) {
    if (Number.isFinite(event?.x) && Number.isFinite(event?.z)) {
      const h = event.heading ?? 0;
      const spd = event.speed ?? 0;
      return {
        x: event.x,
        y: (event.y ?? 0) + worldElevAt(world, event.x, event.z),
        z: event.z,
        heading: h,
        vx: event.vx ?? Math.sin(h) * spd,
        vz: event.vz ?? Math.cos(h) * spd,
        width: event.width ?? 1.85,
        length: event.length ?? 4.35,
      };
    }
    const directActor = event?.patrol ?? event?.actor;
    if (directActor && Number.isFinite(directActor.x) && Number.isFinite(directActor.z)) {
      const { vx, vz } = actorWorldVelocity(directActor);
      return {
        x: directActor.x,
        y: (directActor.y ?? 0) + worldElevAt(world, directActor.x, directActor.z),
        z: directActor.z,
        heading: directActor.heading ?? 0,
        vx,
        vz,
        width: directActor.width ?? 1.85,
        length: directActor.length ?? 4.35,
      };
    }
    const targetId = event?.actorId ?? event?.patrolId ?? event?.id;
    let match = targetId != null ? policeActors.find((a) => a.id === targetId) : null;
    if (!match && event?.type === "patrol_wrecked") {
      match = policeActors.find((a) => a.aiState === "WRECKED" && (!event.unitType || a.unitType === event.unitType))
        ?? policeActors.find((a) => a.aiState === "WRECKED");
    }
    if (!match && policeActors.length > 0) {
      const px = world?.player?.x ?? 0, pz = world?.player?.z ?? 0;
      match = policeActors.reduce((best, cur) => {
        const dCur = Math.hypot((cur.x ?? 0) - px, (cur.z ?? 0) - pz);
        const dBest = Math.hypot((best.x ?? 0) - px, (best.z ?? 0) - pz);
        return dCur < dBest ? cur : best;
      });
    }
    const fallback = match ?? world?.player;
    if (!fallback) return { x: 0, y: 0, z: 0, heading: 0, vx: 0, vz: 0, width: 1.85, length: 4.35 };
    const { vx, vz } = actorWorldVelocity(fallback);
    const fx = fallback.x ?? 0, fz = fallback.z ?? 0;
    return {
      x: fx,
      y: (fallback.y ?? 0) + worldElevAt(world, fx, fz),
      z: fz,
      heading: fallback.heading ?? 0,
      vx,
      vz,
      width: fallback.width ?? 1.85,
      length: fallback.length ?? 4.35,
    };
  }

  function observePlayerImpacts(world) {
    const player = world?.player;
    const damage = player?.vehicle?.damage;
    if (!player || !damage) return;

    const rawImpactCount = Number.isFinite(damage.impactCount) ? damage.impactCount : 0;
    if ((prevRawImpactCount > 0 && rawImpactCount === 0) || (prevImpactCount > 0 && rawImpactCount === 0 && !damage.lastImpact)) {
      clearPlayerDebris();
      repairedThisStep = true;
      prevImpactCount = 0;
      prevRawImpactCount = 0;
      prevImpactTick = null;
      lastPlayerImpactKey = "none:0";
      return;
    }

    const lastImpact = damage.lastImpact;
    const effImpactCount = rawImpactCount > 0 ? rawImpactCount : (lastImpact ? 1 : 0);
    const impactTick = lastImpact?.tick ?? "none";
    const impactKey = `${impactTick}:${effImpactCount}`;

    const isFresh = effImpactCount > 0
      && impactKey !== lastPlayerImpactKey
      && (effImpactCount > prevImpactCount || (lastImpact?.tick != null && lastImpact.tick !== prevImpactTick));

    if (!isFresh) return;

    prevImpactCount = effImpactCount;
    prevRawImpactCount = rawImpactCount;
    prevImpactTick = lastImpact?.tick ?? null;
    lastPlayerImpactKey = impactKey;

    const side = lastImpact?.side ?? "front";
    const closingSpeedMps = Math.max(0, lastImpact?.closingSpeedMps ?? 0);
    const energyJ = Math.max(0, lastImpact?.energyJ ?? (0.5 * 1800 * closingSpeedMps * closingSpeedMps));

    const rawDetached = Array.isArray(lastImpact?.detachedParts) ? lastImpact.detachedParts : [];
    const rawBroken = Array.isArray(lastImpact?.brokenParts) ? lastImpact.brokenParts : [];
    const hasCoreParts = Boolean(
      Array.isArray(lastImpact?.detachedParts) ||
      (damage.parts && typeof damage.parts === "object" && damage.parts.hood && damage.parts.spareCarrier),
    );
    const includeBroken = lastImpact?.detachedParts === undefined || energyJ >= 14000 || closingSpeedMps >= 4.5;

    const mappedParts = [];
    let brokenLampOrGlass = Boolean(lastImpact?.shatteredGlass);
    for (const item of [...rawDetached, ...rawBroken]) {
      if (isGlassPartName(item) && (Boolean(lastImpact?.shatteredGlass) || closingSpeedMps >= 3.5 || rawDetached.includes(item))) {
        brokenLampOrGlass = true;
      }
    }
    for (const item of rawDetached) {
      const canonical = normalizePartKind(item, side);
      if (canonical && !mappedParts.includes(canonical)) mappedParts.push(canonical);
    }
    if (includeBroken) {
      for (const item of rawBroken) {
        const canonical = normalizePartKind(item, side);
        if (!canonical || mappedParts.includes(canonical)) continue;
        // Never spawn a unique whole assembly (hood, spare wheel cover, side mirror)
        // when that assembly did not actually detach from the SUV!
        if (hasCoreParts && SINGULAR_WHOLE_PARTS.has(canonical)) continue;
        mappedParts.push(canonical);
      }
      if (
        hasCoreParts &&
        (closingSpeedMps >= 7.5 || energyJ >= 36000) &&
        !mappedParts.includes("license-plate") &&
        (side === "front" || side === "rear")
      ) {
        mappedParts.push("license-plate");
      }
    }

    const partsObj = damage.parts;
    if (partsObj && typeof partsObj === "object") {
      for (const [key, state] of Object.entries(partsObj)) {
        if (state && (state.shattered || state.detached) && isGlassPartName(key)) {
          brokenLampOrGlass = true;
        }
      }
    }

    const partsToSpawn = mappedParts.length > 0
      ? mappedParts
      : derivePartsFromImpact(side, energyJ, damage);

    const shatterGlass = closingSpeedMps >= 3.5 || brokenLampOrGlass;
    const { vx, vz } = actorWorldVelocity(player);

    const px = player.x ?? 0, pz = player.z ?? 0;
    spawnBurst({
      x: px,
      y: (player.y ?? 0) + worldElevAt(world, px, pz),
      z: pz,
      heading: player.heading ?? 0,
      vx,
      vz,
      width: player.width ?? 1.85,
      length: player.length ?? 4.2,
      side,
      energyJ: Math.max(energyJ, closingSpeedMps >= 3.5 ? 12000 : 6000),
      parts: partsToSpawn,
      color: player.paintColor ?? PLAYER_OLIVE_PAINT,
      shatterGlass,
      owner: "player",
    });
  }

  function observePursuitEvents(world, policeActors) {
    const events = world?.pursuit?.stepEvents;
    if (!Array.isArray(events) || events.length === 0) return;

    const stepTick = Number.isFinite(world?.tick)
      ? world.tick
      : (Number.isFinite(world?.pursuit?.gta?.eventTick) ? world.pursuit.gta.eventTick : null);

    if (stepTick !== null && stepTick === lastStepEventsTick) return;
    if (stepTick !== null) lastStepEventsTick = stepTick;

    for (const event of events) {
      if (!event) continue;
      if (event.type === "patrol_wrecked") {
        const pose = resolvePatrolEventPose(world, event, policeActors);
        spawnBurst({
          ...pose,
          side: "front",
          energyJ: event.energyJ ?? 48000,
          parts: ["bumper-corner", "lightbar-lens", "license-plate"],
          color: PATROL_NAVY_PAINT,
          shatterGlass: true,
          owner: "patrol",
        });
      } else if (
        event.type === "patrol_collision"
        && event.fresh === true
        && (event.closingSpeed ?? event.closingSpeedMps ?? 0) >= 2.5
      ) {
        const speed = event.closingSpeed ?? event.closingSpeedMps ?? 2.5;
        const energyJ = event.energyJ ?? Math.max(12000, 950 * speed * speed);
        const pose = resolvePatrolEventPose(world, event, policeActors);
        const parts = speed >= 5.5 || energyJ >= 22000
          ? ["bumper-corner", "lightbar-lens", "license-plate"]
          : ["license-plate", "bumper-corner"];
        spawnBurst({
          ...pose,
          side: event.isPit ? "left" : "front",
          energyJ,
          parts,
          color: PATROL_NAVY_PAINT,
          shatterGlass: true,
          owner: "patrol",
        });
      }
    }
  }

  function resolveActorSurfaceKind(world, actor) {
    if (!actor) return "asphalt";
    const vehSurf = actor.vehicle?.surface;
    if (vehSurf && typeof vehSurf === "object") {
      const k = vehSurf.kind ?? vehSurf.surfaceKind;
      if (typeof k === "string" && k) return k;
    }
    const inter = actor.vehicle?.interaction ?? actor.interaction;
    if (inter && typeof inter === "object") {
      const k = inter.surfaceKind ?? (typeof inter.surface === "string" ? inter.surface : inter.surface?.kind);
      if (typeof k === "string" && k) return k;
    }
    if (typeof actor.surfaceKind === "string" && actor.surfaceKind) return actor.surfaceKind;
    if (typeof actor.surface === "string" && actor.surface) return actor.surface;
    if (actor.surface && typeof actor.surface === "object") {
      const k = actor.surface.surfaceKind ?? actor.surface.kind;
      if (typeof k === "string" && k) return k;
    }
    if (typeof world?.surfaceAt === "function" && Number.isFinite(actor.x) && Number.isFinite(actor.z)) {
      const ws = world.surfaceAt(actor.x, actor.z);
      const k = ws?.surfaceKind ?? ws?.kind;
      if (typeof k === "string" && k) return k;
    }
    return "asphalt";
  }

  function resolvePlayerScraping(player, vx, vz, absSpeed) {
    const rawScraping = player?.vehicle?.interaction?.scraping ?? player?.interaction?.scraping;
    const px = player?.x ?? 0;
    const pz = player?.z ?? 0;
    const h = player?.heading ?? 0;
    const sinH = Math.sin(h);
    const cosH = Math.cos(h);
    const halfW = (player?.width ?? 1.85) * 0.5;
    const halfL = (player?.length ?? 4.2) * 0.5;

    if (rawScraping && typeof rawScraping === "object") {
      if (!rawScraping.active) return null;
      const intensity = Number.isFinite(rawScraping.intensity) ? clamp(rawScraping.intensity, 0, 1.5) : 0;
      const explicitTang =
        rawScraping.tangentialSpeedMps ?? rawScraping.speedMps ?? rawScraping.slideSpeedMps;
      const tangSpeed = Number.isFinite(explicitTang)
        ? Math.abs(explicitTang)
        : Math.max(absSpeed, Math.hypot(vx, vz));
      if (!(intensity > 0.08 && tangSpeed > 1.2)) return null;
      const wheelTag = String(rawScraping.wheel ?? rawScraping.side ?? "right");
      const lowerTag = wheelTag.toLowerCase();
      const sideX = lowerTag.includes("left") ? -halfW : lowerTag.includes("right") ? halfW : 0;
      const sideZ = lowerTag.includes("front") ? halfL * 0.65 : lowerTag.includes("rear") ? -halfL * 0.65 : 0;
      const fallbackWx = px + sideX * cosH + sideZ * sinH;
      const fallbackWz = pz - sideX * sinH + sideZ * cosH;
      const rawNx = Number.isFinite(rawScraping.normalX)
        ? rawScraping.normalX
        : Number.isFinite(rawScraping.nx)
          ? rawScraping.nx
          : Number.isFinite(rawScraping.normal?.x)
            ? rawScraping.normal.x
            : -cosH;
      const rawNz = Number.isFinite(rawScraping.normalZ)
        ? rawScraping.normalZ
        : Number.isFinite(rawScraping.nz)
          ? rawScraping.nz
          : Number.isFinite(rawScraping.normal?.z)
            ? rawScraping.normal.z
            : sinH;
      const nLen = Math.hypot(rawNx, rawNz) || 1;
      const pt = rawScraping.point;
      scrapingScratch.active = true;
      scrapingScratch.kind = String(rawScraping.kind ?? rawScraping.obstacleKind ?? rawScraping.targetKind ?? "barrier").toLowerCase();
      scrapingScratch.wheel = rawScraping.wheel ?? null;
      scrapingScratch.side = rawScraping.side ?? null;
      scrapingScratch.intensity = intensity;
      scrapingScratch.tangentialSpeedMps = tangSpeed;
      scrapingScratch.worldX = Number.isFinite(rawScraping.worldX)
        ? rawScraping.worldX
        : Number.isFinite(rawScraping.x)
          ? rawScraping.x
          : Number.isFinite(rawScraping.contactX)
            ? rawScraping.contactX
            : Number.isFinite(pt?.x)
              ? pt.x
              : fallbackWx;
      scrapingScratch.worldY = Number.isFinite(rawScraping.worldY)
        ? rawScraping.worldY
        : Number.isFinite(pt?.y)
          ? pt.y
          : null;
      scrapingScratch.worldZ = Number.isFinite(rawScraping.worldZ)
        ? rawScraping.worldZ
        : Number.isFinite(rawScraping.z)
          ? rawScraping.z
          : Number.isFinite(rawScraping.contactZ)
            ? rawScraping.contactZ
            : Number.isFinite(pt?.z)
              ? pt.z
              : fallbackWz;
      scrapingScratch.normalX = rawNx / nLen;
      scrapingScratch.normalZ = rawNz / nLen;
      return scrapingScratch;
    }

    // Fallback 1: sustained tangential sliding along player.vehicle.contact
    const contact = player?.vehicle?.contact;
    if (contact && absSpeed > 1.4) {
      const rawNx = Number.isFinite(contact.normal?.x) ? contact.normal.x : -cosH;
      const rawNz = Number.isFinite(contact.normal?.z) ? contact.normal.z : sinH;
      const nLen = Math.hypot(rawNx, rawNz) || 1;
      const nx = rawNx / nLen;
      const nz = rawNz / nLen;
      const vDotN = vx * nx + vz * nz;
      const tvx = vx - vDotN * nx;
      const tvz = vz - vDotN * nz;
      const tangSpeed = Math.hypot(tvx, tvz);
      if (tangSpeed > 1.35) {
        const rightX = cosH;
        const rightZ = -sinH;
        const sideSign = (-nx * rightX + -nz * rightZ) >= 0 ? 1 : -1;
        const hitStr = String(contact.hitId ?? "").toLowerCase();
        const kind = hitStr.includes("curb")
          ? "curb"
          : (hitStr.includes("veh") || hitStr.includes("patrol") || hitStr.includes("traffic"))
            ? "vehicle"
            : "barrier";
        scrapingScratch.active = true;
        scrapingScratch.kind = kind;
        scrapingScratch.wheel = null;
        scrapingScratch.side = null;
        scrapingScratch.intensity = clamp(tangSpeed / 11, 0.16, 0.95);
        scrapingScratch.tangentialSpeedMps = tangSpeed;
        scrapingScratch.worldX = px + sideSign * halfW * rightX;
        scrapingScratch.worldY = null;
        scrapingScratch.worldZ = pz + sideSign * halfW * rightZ;
        scrapingScratch.normalX = nx;
        scrapingScratch.normalZ = nz;
        return scrapingScratch;
      }
    }

    // Fallback 2: shallow curb graze when player.curbSupportId is active
    if (player?.curbSupportId && absSpeed > 2.2) {
      const sideSign = (player.steer ?? 0) < -0.02 ? -1 : 1;
      const rightX = cosH;
      const rightZ = -sinH;
      scrapingScratch.active = true;
      scrapingScratch.kind = "curb";
      scrapingScratch.wheel = null;
      scrapingScratch.side = null;
      scrapingScratch.intensity = clamp((absSpeed - 1.8) / 12, 0.14, 0.72);
      scrapingScratch.tangentialSpeedMps = absSpeed;
      scrapingScratch.worldX = px + sideSign * (halfW * 0.88) * rightX - sinH * 0.25;
      scrapingScratch.worldY = null;
      scrapingScratch.worldZ = pz + sideSign * (halfW * 0.88) * rightZ - cosH * 0.25;
      scrapingScratch.normalX = -sideSign * rightX;
      scrapingScratch.normalZ = -sideSign * rightZ;
      return scrapingScratch;
    }

    return null;
  }

  function resolvePlayerTireSmokeState(player, absSpeed, yawRate, surfaceKind) {
    if (!player || surfaceKind === "water" || surfaceKind === "sand") {
      tireStateScratch.intensity = 0;
      tireStateScratch.lockup = false;
      return tireStateScratch;
    }
    const inter = player.vehicle?.interaction ?? player.interaction ?? null;
    const explicitSmoke = Math.max(
      Number.isFinite(inter?.tireSmokeIntensity) ? inter.tireSmokeIntensity : 0,
      typeof inter?.tireSmoke === "number"
        ? inter.tireSmoke
        : (Number.isFinite(inter?.tireSmoke?.intensity) ? inter.tireSmoke.intensity : 0),
      Number.isFinite(inter?.skidIntensity) ? inter.skidIntensity : 0,
      Number.isFinite(player.vehicle?.tireSmokeIntensity) ? player.vehicle.tireSmokeIntensity : 0,
      Number.isFinite(player.tireSmokeIntensity) ? player.tireSmokeIntensity : 0,
    );

    const inContactOrScrape = Boolean(inter?.scraping?.active || player.vehicle?.contact);
    const brake = player.vehicle?.controls?.brake ?? 0;
    const wLocks = inter?.wheels
      ? Math.max(
          inter.wheels.frontLeft?.brakeLockSlip ?? 0,
          inter.wheels.frontRight?.brakeLockSlip ?? 0,
          inter.wheels.rearLeft?.brakeLockSlip ?? 0,
          inter.wheels.rearRight?.brakeLockSlip ?? 0,
        )
      : 0;
    const hardBrakeLockup = Boolean(inter?.brakeLockup) ||
      (inter ? (!player.vehicle?.contact && wLocks > 0.35 && absSpeed > 7.5)
             : (!player.vehicle?.contact && brake > 0.5 && absSpeed > 7.5));
    const lockupScore = hardBrakeLockup
      ? clamp(0.32 + (absSpeed - 7.5) * 0.075, 0.32, 0.88)
      : 0;

    // During an active wheel/body scrape or contact without hard brake lockup, suppress inferred
    // symmetric rear drift smoke so smoke emits strictly from the localized scraping wheel/patch!
    if (inContactOrScrape && !hardBrakeLockup) {
      tireStateScratch.intensity = clamp(explicitSmoke, 0, 1);
      tireStateScratch.lockup = false;
      return tireStateScratch;
    }

    const interLatSlip = Number.isFinite(inter?.lateralSlipMps) && Math.abs(inter.lateralSlipMps) > 1.8
      ? clamp((Math.abs(inter.lateralSlipMps) - 1.8) / 4.2, 0, 1)
      : 0;
    const interSlipRatio = Number.isFinite(inter?.slipRatio) && Math.abs(inter.slipRatio) > 0.22
      ? clamp((Math.abs(inter.slipRatio) - 0.22) / 0.55, 0, 1)
      : 0;

    const rawSlip = Math.max(
      Math.abs(player.chaseSlip ?? 0),
      Math.abs(player.chaseSlipRad ?? 0),
      Math.abs(player.arcadeSlip ?? 0),
    );
    let kinematicSlip = 0;
    if (rawSlip >= 1.5) {
      kinematicSlip = clamp((rawSlip - 1.5) / 4.0, 0.18, 1);
    } else if (absSpeed > 4.5 && rawSlip > 0.055) {
      kinematicSlip = clamp((rawSlip * absSpeed - 0.52) / 2.1, 0, 1);
    }

    const gtaSlip = Math.abs(player.gtaSlipMps ?? 0);
    const gtaSlipScore = gtaSlip > 1.8 && absSpeed > 4.0
      ? clamp((gtaSlip - 1.8) / 4.0, 0, 1)
      : 0;

    // When authoritative per-wheel physics (`inter.wheels`) is active, respect its exact tireSmokeIntensity
    // instead of letting variable-rAF-dt finite-difference yaw rates fabricate drift smoke on gentle turns!
    const hasAuthoritativeWheelPhysics = Boolean(
      inter?.wheels && typeof inter.tireSmokeIntensity === "number",
    );
    if (hasAuthoritativeWheelPhysics) {
      tireStateScratch.intensity = clamp(Math.max(explicitSmoke, gtaSlipScore, lockupScore), 0, 1);
      tireStateScratch.lockup = hardBrakeLockup;
      return tireStateScratch;
    }

    const latAccel = Math.abs(absSpeed * yawRate);
    const yawSlipScore = absSpeed > 6.0 && latAccel > 5.8
      ? clamp((latAccel - 5.8) / 4.5, 0, 1)
      : 0;

    tireStateScratch.intensity = clamp(
      Math.max(explicitSmoke, interLatSlip, interSlipRatio, kinematicSlip, gtaSlipScore, yawSlipScore, lockupScore),
      0,
      1,
    );
    tireStateScratch.lockup = hardBrakeLockup;
    return tireStateScratch;
  }

  function emitContinuousSmoke(world, policeActors, dt) {
    for (const track of skidTracks.values()) {
      track.ageSinceStampS += dt;
    }

    const player = world?.player;
    if (player && !repairedThisStep) {
      const px = player.x ?? 0;
      const py = player.y ?? 0;
      const pz = player.z ?? 0;
      const h = player.heading ?? 0;
      const sinH = Math.sin(h);
      const cosH = Math.cos(h);
      const pVel = actorWorldVelocity(player, playerVelScratch);
      const vx = pVel.vx;
      const vz = pVel.vz;
      const speedVec = Math.hypot(vx, vz);
      const absSpeed = Math.max(Math.abs(player.speed ?? 0), speedVec);

      let derivedYawRate = 0;
      if (prevPlayerPoseObj.valid && Math.hypot(px - prevPlayerPoseObj.x, pz - prevPlayerPoseObj.z) < 8) {
        derivedYawRate = Math.abs(wrapAngleDelta(h, prevPlayerPoseObj.heading)) / Math.max(dt, 1e-4);
      }
      prevPlayerPoseObj.valid = true;
      prevPlayerPoseObj.x = px;
      prevPlayerPoseObj.z = pz;
      prevPlayerPoseObj.heading = h;
      const yawRate = Number.isFinite(player.yawRate)
        ? Math.abs(player.yawRate)
        : Number.isFinite(player.yawRateRadS)
          ? Math.abs(player.yawRateRadS)
          : Number.isFinite(player.gtaYawRate)
            ? Math.abs(player.gtaYawRate)
            : derivedYawRate;

      const surfaceKind = resolveActorSurfaceKind(world, player);
      const drySurface = surfaceKind !== "water" && surfaceKind !== "sand";
      const width = player.width ?? 1.85;
      const length = player.length ?? 4.2;
      const halfTrack = width * 0.42;
      const rearAxleZ = -length * 0.31;
      const frontAxleZ = length * 0.31;

      const wheelWorld = (latX, longZ) => ({
        x: px + latX * cosH + longZ * sinH,
        z: pz - latX * sinH + longZ * cosH,
      });

      // (A) Damaged Engine Steam & Dark Oily Smoke
      const damage = player.vehicle?.damage;
      const frontDamage = damage?.front ?? 0;
      const radiatorLeaking = Boolean(damage?.parts?.radiator?.leaking);
      if (radiatorLeaking || frontDamage >= 0.38) {
        playerSmokeTimerS -= dt;
        if (playerSmokeTimerS <= 0) {
          playerSmokeTimerS = frontDamage >= 0.65 ? 0.044 : 0.068;
          const hoodOffX = (rand() < 0.5 ? -1 : 1) * randRange(0.08, 0.34);
          const hoodOffZ = length * randRange(0.28, 0.40);
          const hp = wheelWorld(hoodOffX, hoodOffZ);
          const hy = py + worldElevAt(world, hp.x, hp.z) + (frontDamage >= 0.65 ? 1.18 : 0.96);
          const oilRatio = clamp((frontDamage - 0.45) / 0.25, 0, 1);
          const puffHex = frontDamage >= 0.65
            ? (rand() < 0.55 ? ENGINE_SMOKE_HEX : ENGINE_OIL_DARK_HEX)
            : tmpColor.copy(steamColor).lerp(smokeColor, oilRatio).getHex();
          spawnSmokePuff(hp.x, hy, hp.z, puffHex, "player", {
            smokeKind: "engine",
            emitterVx: vx * 0.16,
            emitterVz: vz * 0.16,
            extraVx: -sinH * randRange(0.75, 1.55) + cosH * hoodOffX * 1.2 + randRange(-0.28, 0.28),
            extraVz: -cosH * randRange(0.75, 1.55) - sinH * hoodOffX * 1.2 + randRange(-0.28, 0.28),
            targetVy: frontDamage >= 0.65 ? randRange(1.65, 2.35) : randRange(1.10, 1.65),
            initialVy: frontDamage >= 0.65 ? randRange(0.65, 1.15) : randRange(0.45, 0.80),
            startScale: frontDamage >= 0.65 ? randRange(0.36, 0.52) : randRange(0.28, 0.44),
            endScale: frontDamage >= 0.65 ? randRange(1.55, 2.25) : randRange(1.35, 2.05),
            baseOpacity: frontDamage >= 0.65 ? 0.62 : 0.44,
            ttlS: randRange(1.10, 1.58),
          });
        }
      } else {
        playerSmokeTimerS = 0;
      }

      // (B) Real-Time Tire Burnout / Drift / Hard-Brake Lockup Smoke + Skid Ribbons
      const tireState = resolvePlayerTireSmokeState(player, absSpeed, yawRate, surfaceKind);
      if (tireState.intensity > 0.08) {
        const rearL = wheelWorld(-halfTrack, rearAxleZ);
        const rearR = wheelWorld(halfTrack, rearAxleZ);
        const skidVx = speedVec > 0.2 ? vx : sinH * Math.max(1.6, absSpeed);
        const skidVz = speedVec > 0.2 ? vz : cosH * Math.max(1.6, absSpeed);
        const skidAlpha = clamp(0.62 + 0.34 * tireState.intensity, 0.58, 0.94);

        stampWheelSkid(world, "player:RL", rearL.x, rearL.z, skidVx, skidVz, dt, 0.27, skidAlpha, "player");
        stampWheelSkid(world, "player:RR", rearR.x, rearR.z, skidVx, skidVz, dt, 0.27, skidAlpha, "player");
        if (tireState.lockup) {
          const frontL = wheelWorld(-halfTrack, frontAxleZ);
          const frontR = wheelWorld(halfTrack, frontAxleZ);
          stampWheelSkid(world, "player:FL", frontL.x, frontL.z, skidVx, skidVz, dt, 0.23, skidAlpha * 0.92, "player");
          stampWheelSkid(world, "player:FR", frontR.x, frontR.z, skidVx, skidVz, dt, 0.23, skidAlpha * 0.92, "player");
        }

        playerTireSmokeTimerS -= dt;
        if (playerTireSmokeTimerS <= 0) {
          playerTireSmokeTimerS = clamp(0.056 - 0.028 * tireState.intensity, 0.024, 0.058);
          for (const [sideSign, wp] of [[-1, rearL], [1, rearR]]) {
            const groundY = py + worldElevAt(world, wp.x, wp.z);
            const tintHex = tmpColor.copy(tireWarmColor).lerp(tireCoolColor, rand()).getHex();
            const outLat = sideSign * (0.45 + 0.72 * tireState.intensity);
            spawnSmokePuff(wp.x, groundY + 0.18, wp.z, tintHex, "player", {
              smokeKind: "tire",
              emitterVx: vx,
              emitterVz: vz,
              extraVx: -sinH * randRange(0.55, 1.35) + cosH * outLat + randRange(-0.22, 0.22),
              extraVz: -cosH * randRange(0.55, 1.35) - sinH * outLat + randRange(-0.22, 0.22),
              targetVy: randRange(0.65, 1.02),
              initialVy: randRange(0.22, 0.48),
              startScale: 0.34,
              endScale: randRange(1.65, 2.05),
              baseOpacity: clamp(0.26 + 0.22 * tireState.intensity, 0.26, 0.46),
              ttlS: randRange(0.95, 1.45),
              jitterXZ: 0.10,
            });
          }
        }
      } else {
        playerTireSmokeTimerS = 0;
      }

      // (C) Continuous Wheel & Body Scraping Sparks + Friction Smoke
      const scraping = resolvePlayerScraping(player, vx, vz, absSpeed);
      if (scraping) {
        const sx = scraping.worldX;
        const sz = scraping.worldZ;
        const groundY = py + worldElevAt(world, sx, sz);
        const sy = scraping.worldY ?? (groundY + (scraping.kind === "curb" ? 0.22 : 0.44));
        const nx = scraping.normalX;
        const nz = scraping.normalZ;

        // Backward tangent along the wall/curb relative to vehicle travel
        const vDotN = vx * nx + vz * nz;
        let backX = -(vx - vDotN * nx);
        let backZ = -(vz - vDotN * nz);
        let backLen = Math.hypot(backX, backZ);
        if (backLen < 1e-3) {
          backX = -sinH;
          backZ = -cosH;
          backLen = 1;
        }
        backX /= backLen;
        backZ /= backLen;

        const isCurb = scraping.kind === "curb";
        const emitRimOrBodySparks = !isCurb || scraping.tangentialSpeedMps > 7.5;
        if (emitRimOrBodySparks) {
          const sparkCount = Math.max(4, Math.round(5 + 8 * clamp(scraping.intensity, 0, 1)));
          scrapeOriginScratch.x = sx;
          scrapeOriginScratch.y = sy;
          scrapeOriginScratch.z = sz;
          scrapeBackScratch.x = backX;
          scrapeBackScratch.z = backZ;
          scrapeNormScratch.x = nx;
          scrapeNormScratch.z = nz;
          spawnScrapeSparks(
            scrapeOriginScratch,
            scrapeBackScratch,
            scrapeNormScratch,
            scraping.tangentialSpeedMps,
            scraping.intensity,
            sparkCount,
            "player",
          );
        }

        const wheelKey = String(scraping.wheel ?? "");
        const lowerWheelKey = wheelKey.toLowerCase();
        const scrapeSideSign =
          lowerWheelKey.includes("left") || scraping.side === "left"
            ? -1
            : lowerWheelKey.includes("right") || scraping.side === "right"
              ? 1
              : (sx - px) * cosH - (sz - pz) * sinH >= 0 ? 1 : -1;
        const scrapeFrontWheel = wheelWorld(scrapeSideSign * halfTrack, frontAxleZ);
        const scrapeRearWheel = wheelWorld(scrapeSideSign * halfTrack, rearAxleZ);
        const isRearWheel = lowerWheelKey.includes("rear") || scraping.side === "rear";
        const activeScrapeWheel = isRearWheel ? scrapeRearWheel : scrapeFrontWheel;

        const scrubHex = isCurb ? CURB_SCRUB_SMOKE_HEX : WALL_SCRAPE_SMOKE_HEX;
        // Anchor scrape friction smoke at the actual scraping wheel & contact patch (never jumping rear -> front!)
        spawnSmokePuff(
          activeScrapeWheel.x + nx * 0.24,
          groundY + 0.26,
          activeScrapeWheel.z + nz * 0.24,
          TIRE_SMOKE_WARM_HEX,
          "player",
          {
            smokeKind: "scrape",
            emitterVx: vx * 0.08,
            emitterVz: vz * 0.08,
            extraVx: backX * randRange(0.85, 1.75) + nx * randRange(0.75, 1.55),
            extraVz: backZ * randRange(0.85, 1.75) + nz * randRange(0.75, 1.55),
            targetVy: randRange(0.75, 1.25),
            initialVy: randRange(0.30, 0.60),
            startScale: randRange(0.36, 0.52),
            endScale: randRange(1.55, 2.25),
            baseOpacity: clamp(0.62 + 0.18 * scraping.intensity, 0.56, 0.82),
            ttlS: randRange(0.85, 1.35),
            jitterXZ: 0.06,
          },
        );
        spawnSmokePuff(sx + nx * 0.26, groundY + 0.36, sz + nz * 0.26, scrubHex, "player", {
          smokeKind: "scrape",
          emitterVx: vx * 0.08,
          emitterVz: vz * 0.08,
          extraVx: backX * randRange(0.95, 1.95) + nx * randRange(0.85, 1.65),
          extraVz: backZ * randRange(0.95, 1.95) + nz * randRange(0.85, 1.65),
          targetVy: randRange(0.95, 1.55),
          initialVy: randRange(0.38, 0.72),
          startScale: randRange(0.38, 0.54),
          endScale: randRange(1.65, 2.35),
          baseOpacity: clamp(0.58 + 0.18 * scraping.intensity, 0.54, 0.80),
          ttlS: randRange(0.90, 1.40),
          jitterXZ: 0.08,
        });

        if (drySurface && (isCurb || scraping.intensity > 0.18)) {
          const scrubVelX = -backX * Math.max(2.0, scraping.tangentialSpeedMps);
          const scrubVelZ = -backZ * Math.max(2.0, scraping.tangentialSpeedMps);
          const scrubAlpha = clamp(0.68 + 0.18 * scraping.intensity, 0.64, 0.88);
          const specificWheelId =
            wheelKey.length > 0
              ? wheelKey
              : `${scrapeSideSign > 0 ? "right" : "left"}${isRearWheel ? "Rear" : "Front"}`;
          stampWheelSkid(
            world,
            `player:scrape:${isCurb ? "curb" : specificWheelId}`,
            activeScrapeWheel.x,
            activeScrapeWheel.z,
            scrubVelX,
            scrubVelZ,
            dt,
            0.30,
            scrubAlpha,
            "player",
          );
        }
      }

      // (D) Subtle Hard-Throttle Exhaust Tailpipe Wisps
      const throttle = player.vehicle?.controls?.throttle ?? 0;
      if (throttle > 0.5 && absSpeed > 1.0 && absSpeed < 14) {
        playerExhaustTimerS -= dt;
        if (playerExhaustTimerS <= 0) {
          playerExhaustTimerS = 0.085;
          const tp = wheelWorld(-width * 0.30, -length * 0.50 - 0.06);
          const ty = py + worldElevAt(world, tp.x, tp.z) + 0.34;
          spawnSmokePuff(tp.x, ty, tp.z, EXHAUST_WISP_HEX, "player", {
            smokeKind: "exhaust",
            emitterVx: vx,
            emitterVz: vz,
            extraVx: -sinH * randRange(1.6, 2.6) + randRange(-0.16, 0.16),
            extraVz: -cosH * randRange(1.6, 2.6) + randRange(-0.16, 0.16),
            targetVy: randRange(0.50, 0.82),
            initialVy: randRange(0.10, 0.28),
            startScale: 0.14,
            endScale: 0.65,
            baseOpacity: 0.16,
            ttlS: randRange(0.42, 0.62),
            jitterXZ: 0.04,
          });
        }
      } else {
        playerExhaustTimerS = 0;
      }
    } else if (!player) {
      playerSmokeTimerS = 0;
      playerTireSmokeTimerS = 0;
      playerExhaustTimerS = 0;
      prevPlayerPoseObj.valid = false;
    }

    // Police Cruisers: Damaged/Wrecked Engine Smoke + High-Slip Pursuit Drift Tire Smoke
    for (const actor of policeActors) {
      const key = actor.id ?? actor;
      const h = actor.heading ?? 0;
      const sinH = Math.sin(h);
      const cosH = Math.cos(h);
      const { vx, vz } = actorWorldVelocity(actor);
      const ax = actor.x ?? 0;
      const ay = actor.y ?? 0;
      const az = actor.z ?? 0;

      const maxH = Number.isFinite(actor.maxHealth) && actor.maxHealth > 0 ? actor.maxHealth : 100;
      const healthRatio = Number.isFinite(actor.health) ? actor.health / maxH : 1;
      const wrecked = actor.aiState === "WRECKED";
      if (wrecked || healthRatio < 0.55) {
        const nextTimer = (patrolSmokeTimers.get(key) ?? 0) - dt;
        if (nextTimer <= 0) {
          patrolSmokeTimers.set(key, wrecked ? 0.052 : 0.082);
          const hx = ax + sinH * 1.35 + randRange(-0.2, 0.2);
          const hz = az + cosH * 1.35 + randRange(-0.2, 0.2);
          const hy = ay + worldElevAt(world, hx, hz) + 0.92;
          spawnSmokePuff(hx, hy, hz, wrecked ? ENGINE_SMOKE_HEX : STEAM_COLOR_HEX, "patrol", {
            smokeKind: "engine",
            emitterVx: vx,
            emitterVz: vz,
            extraVx: -sinH * 0.45 + randRange(-0.32, 0.32),
            extraVz: -cosH * 0.45 + randRange(-0.32, 0.32),
            targetVy: randRange(1.05, 1.62),
            startScale: randRange(0.32, 0.52),
            endScale: randRange(1.65, 2.80),
            baseOpacity: wrecked ? 0.52 : 0.38,
            ttlS: randRange(1.15, 1.65),
          });
        } else {
          patrolSmokeTimers.set(key, nextTimer);
        }
      }

      const patrolSlip = Math.abs(actor.gtaSlipMps ?? 0);
      const patrolSpeed = Math.abs(actor.speed ?? 0);
      const patrolSurf = resolveActorSurfaceKind(world, actor);
      if (!wrecked && patrolSlip > 2.6 && patrolSpeed > 7 && patrolSurf !== "water" && patrolSurf !== "sand") {
        const slipNorm = clamp((patrolSlip - 2.6) / 4.2, 0.18, 1);
        const halfT = (actor.width ?? 1.85) * 0.42;
        const rearZ = -(actor.length ?? 4.35) * 0.31;
        for (const [tag, sideSign] of [["RL", -1], ["RR", 1]]) {
          const wx = ax + sideSign * halfT * cosH + rearZ * sinH;
          const wz = az - sideSign * halfT * sinH + rearZ * cosH;
          stampWheelSkid(world, `patrol:${String(key)}:${tag}`, wx, wz, vx, vz, dt, 0.23, 0.42, "patrol");
        }

        const tireTimer = (patrolTireSmokeTimers.get(key) ?? 0) - dt;
        if (tireTimer <= 0) {
          patrolTireSmokeTimers.set(key, 0.048);
          for (const sideSign of [-1, 1]) {
            const wx = ax + sideSign * halfT * cosH + rearZ * sinH;
            const wz = az - sideSign * halfT * sinH + rearZ * cosH;
            const wy = ay + worldElevAt(world, wx, wz) + 0.18;
            const tintHex = tmpColor.copy(tireWarmColor).lerp(tireCoolColor, rand()).getHex();
            spawnSmokePuff(wx, wy, wz, tintHex, "patrol", {
              smokeKind: "tire",
              emitterVx: vx,
              emitterVz: vz,
              extraVx: -sinH * 0.8 + sideSign * cosH * (0.4 + 0.5 * slipNorm),
              extraVz: -cosH * 0.8 - sideSign * sinH * (0.4 + 0.5 * slipNorm),
              targetVy: randRange(0.65, 0.98),
              initialVy: randRange(0.22, 0.45),
              startScale: 0.34,
              endScale: 1.85,
              baseOpacity: 0.38,
              ttlS: randRange(0.92, 1.35),
              jitterXZ: 0.09,
            });
          }
        } else {
          patrolTireSmokeTimers.set(key, tireTimer);
        }
      }
    }
  }

  function stepKinematics(world, dt) {
    const elevFn = typeof world?.terrainElevationAt === "function" ? world.terrainElevationAt : null;
    const debrisFriction = Math.exp(-3.2 * dt);
    for (let i = 0; i < MAX_DEBRIS_PARTS; i++) {
      const s = debrisSlots[i];
      if (!s.active) continue;
      s.ageS += dt;
      if (s.ageS >= s.ttlS) {
        s.active = false;
        s.mesh.visible = false;
        continue;
      }
      s.vy -= GRAVITY_MPS2 * dt;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.z += s.vz * dt;
      s.rx += s.vrx * dt;
      s.ry += s.vry * dt;
      s.rz += s.vrz * dt;

      const elev = elevFn ? world.terrainElevationAt(s.x, s.z) : 0;
      const debrisFloorY = Math.max(s.groundY, DEBRIS_GROUND_Y + elev);
      if (s.y <= debrisFloorY) {
        s.y = debrisFloorY;
        const bounceVy = Math.abs(s.vy) * 0.34;
        s.vy = bounceVy < 0.45 ? 0 : bounceVy;
        s.vx *= debrisFriction;
        s.vz *= debrisFriction;
        s.vrx *= 0.72;
        s.vry *= 0.72;
        s.vrz *= 0.72;
      }

      const rem = s.ttlS - s.ageS;
      const fade = rem < 0.8 ? Math.max(0, rem / 0.8) : 1;
      s.mesh.position.set(s.x, s.y, s.z);
      s.mesh.rotation.set(s.rx, s.ry, s.rz);
      s.mesh.scale.setScalar(s.baseScale * (0.35 + 0.65 * fade));
      s.material.opacity = s.baseOpacity * fade;
    }

    const glassFriction = Math.exp(-2.4 * dt);
    for (let i = 0; i < MAX_GLASS_SHARDS; i++) {
      const s = glassSlots[i];
      if (!s.active) continue;
      s.ageS += dt;
      if (s.ageS >= s.ttlS) {
        s.active = false;
        continue;
      }
      s.vy -= GRAVITY_MPS2 * dt;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.z += s.vz * dt;
      s.rx += s.vrx * dt;
      s.ry += s.vry * dt;
      s.rz += s.vrz * dt;
      const glassFloorY = GLASS_GROUND_Y + (elevFn ? world.terrainElevationAt(s.x, s.z) : 0);
      if (s.y <= glassFloorY) {
        s.y = glassFloorY;
        const bounceVy = Math.abs(s.vy) * 0.48;
        s.vy = bounceVy < 0.32 ? 0 : bounceVy;
        s.vx *= glassFriction;
        s.vz *= glassFriction;
        s.vrx *= 0.78;
        s.vry *= 0.78;
        s.vrz *= 0.78;
      }
    }

    for (let i = 0; i < MAX_IMPACT_SPARKS; i++) {
      const s = sparkSlots[i];
      if (!s.active) continue;
      s.ageS += dt;
      if (s.ageS >= s.ttlS) {
        s.active = false;
        continue;
      }
      s.vy -= GRAVITY_MPS2 * dt;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.z += s.vz * dt;
      const sparkFloorY = SPARK_GROUND_Y + (elevFn ? world.terrainElevationAt(s.x, s.z) : 0);
      if (s.y <= sparkFloorY) {
        s.y = sparkFloorY;
        s.vy = Math.abs(s.vy) * 0.42;
        s.vx *= 0.82;
        s.vz *= 0.82;
      }
    }

    const smokeHorizDrag = Math.exp(-1.9 * dt);
    const smokeBuoyBlend = 1 - Math.exp(-2.8 * dt);
    for (let i = 0; i < MAX_SMOKE_PUFFS; i++) {
      const s = smokeSlots[i];
      if (!s.active) continue;
      s.ageS += dt;
      if (s.ageS >= s.ttlS) {
        s.active = false;
        continue;
      }
      s.vx *= smokeHorizDrag;
      s.vz *= smokeHorizDrag;
      s.vy += (s.targetVy - s.vy) * smokeBuoyBlend;
      const curlA = Math.sin(s.ageS * 3.1 + s.phase) * s.curlAmp;
      const curlB = Math.cos(s.ageS * 2.25 + s.phase * 1.37) * s.curlAmp * 0.62;
      s.x += (s.vx + s.curlDirX * curlA - s.curlDirZ * curlB) * dt;
      s.y += s.vy * dt;
      s.z += (s.vz + s.curlDirZ * curlA + s.curlDirX * curlB) * dt;
      const minSmokeY = 0.16 + (elevFn ? world.terrainElevationAt(s.x, s.z) : 0);
      if (s.y < minSmokeY) {
        s.y = minSmokeY;
        if (s.vy < 0) s.vy = 0;
      }
      s.ry += s.vry * dt;
      s.rz += s.vrz * dt;
    }

    for (let i = 0; i < MAX_SKID_SEGMENTS; i++) {
      const s = skidSlots[i];
      if (!s.active) continue;
      s.ageS += dt;
      if (s.ageS >= s.ttlS) {
        s.active = false;
      }
    }

    if (prevGlassCount > 0) glassStepId++;
    if (prevSparkCount > 0) sparkStepId++;
    if (prevSmokeCount > 0) smokeStepId++;
    if (prevSkidCount > 0) skidStepId++;
    syncInstancedMeshes(lastExplicitCamera);
  }

  function update(world, dt = 1 / 60, camera = null) {
    if (disposed) return;
    lastExplicitCamera = camera ?? null;
    if (dt === 0) {
      syncInstancedMeshes(lastExplicitCamera);
      return;
    }
    repairedThisStep = false;
    const stepDt = Number.isFinite(dt) && dt > 0 ? Math.min(dt, 0.1) : 1 / 60;
    const policeActors = collectPoliceActors(world);
    observePlayerImpacts(world);
    observePursuitEvents(world, policeActors);
    emitContinuousSmoke(world, policeActors, stepDt);
    stepKinematics(world, stepDt);
  }

  function diagnostics() {
    let activeDebrisParts = 0;
    let activeGlassShards = 0;
    let activeSparks = 0;
    let activeSmokePuffs = 0;
    let activeTireSmoke = 0;
    let activeDriftTireSmoke = 0;
    let activeScrapeSmoke = 0;
    let activeSkidSegments = 0;
    const activeSmokePositions = [];
    for (const s of debrisSlots) if (s.active) activeDebrisParts++;
    for (const s of glassSlots) if (s.active) activeGlassShards++;
    for (const s of sparkSlots) if (s.active) activeSparks++;
    for (const s of smokeSlots) {
      if (!s.active) continue;
      activeSmokePuffs++;
      if (s.smokeKind === "tire") activeDriftTireSmoke++;
      if (s.smokeKind === "scrape") activeScrapeSmoke++;
      if (s.smokeKind === "tire" || s.smokeKind === "scrape") activeTireSmoke++;
      activeSmokePositions.push({
        x: Number(s.x.toFixed(3)),
        y: Number(s.y.toFixed(3)),
        z: Number(s.z.toFixed(3)),
        kind: s.smokeKind,
      });
    }
    for (const s of skidSlots) if (s.active) activeSkidSegments++;
    const kinds = [...spawnedKinds];
    return {
      activeDebrisParts,
      activeGlassShards,
      activeSparks,
      activeSmokePuffs,
      activeDebris: activeDebrisParts,
      activeGlass: activeGlassShards,
      activeSmoke: activeSmokePuffs,
      totalBurstsSpawned,
      spawnedPartKinds: kinds,
      partKinds: kinds,
      smokeGeometryType: smokeMesh.geometry.type,
      smokeIsVolumetricBillboard: smokeMesh.geometry?.type === "PlaneGeometry",
      hasSmokeFbmTexture: Boolean(smokeTexture?.isDataTexture && smokeMesh.material.map === smokeTexture),
      hasPerInstanceSmokeAlpha: Boolean(smokeMesh.geometry.getAttribute("aSmokeAlpha")?.isInstancedBufferAttribute),
      activeTireSmoke,
      activeDriftTireSmoke,
      activeScrapeSmoke,
      activeSmokePositions,
      activeSkidSegments,
    };
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    reset();
    for (const geo of ownedGeometries) geo.dispose();
    for (const mat of ownedMaterials) mat.dispose();
    for (const tex of ownedTextures) tex.dispose();
    glassMesh.dispose();
    sparkMesh.dispose();
    smokeMesh.dispose();
    ownedGeometries.clear();
    ownedMaterials.clear();
    ownedTextures.clear();
    layer.removeFromParent();
    layer.clear();
  }

  return {
    layer,
    update,
    spawnBurst,
    clearPlayerDebris,
    reset,
    dispose,
    diagnostics,
  };
}
