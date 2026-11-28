import * as THREE from "three";
import {
  isDiagonalRoad,
  overlaps,
  roadFrame,
  roadIntersection,
  roadPointAt,
  roadRect,
} from "../core/geometry.js";
import { SpatialIndex } from "../core/spatial-index.js";
import { PLAYER_VEHICLE } from "../core/vehicle-spec.js";
import {
  pointInShapedSurfaceZone,
  pointInWaterPuddle,
  puddleOrganicScale,
  resolveSurfaceZoneHalfExtents,
} from "../core/city-surfaces.js";

const TEX_SIZE = 256;
const FX_TEX_SIZE = 128;
const TRACK_TEX_SIZE = 64;
const ROAD_TEX_SIZE = 512;
const LAMP_POOL_TEX_SIZE = 64;
const TAU = Math.PI * 2;

const WATER_CORE_Y = 0.120;
const WATER_HALO_Y = 0.1185;
const WET_TRACK_BASE_Y = 0.1192;
const SAND_BASE_Y = 0.119;
const SAND_RUT_OFFSET_Y = 0.022;
const COBBLE_BASE_Y = 0.118;
const MANHOLE_BASE_Y = 0.1188;
const SKID_BASE_Y = 0.1186;
const LAMP_POOL_Y = 0.123;
const SIDEWALK_PROP_Y = 0.07;

const PROP_SIDEWALK_OFFSET_M = 1.55;
const FURNITURE_SIDEWALK_OFFSET_M = 2.65;
const LAMP_SPACING_M = 44;
const TREE_SPACING_M = 38;
const FURNITURE_SPACING_M = 46;
const MANHOLE_SPACING_M = 76;
const TAR_CRACK_SPACING_M = 56;

const MAX_WATER_RIPPLES = 72;
const MAX_WATER_SPLASHES = 140;
const MAX_WET_TRACK_SEGMENTS = 260;
const MAX_SAND_RUT_SEGMENTS = 320;
const MAX_SAND_DUST = 120;
const MAX_SAND_GRIT = 96;

const WET_TIRE_CARRY_M = 15.0;
const WET_TRACK_HALF_WIDTH_M = 0.135;
const SAND_RUT_HALF_WIDTH_M = 0.132;

const GRAVITY_MPS2 = 9.81;
const WATER_MIN_SPEED_MPS = 2.2;
const SAND_MIN_SPEED_MPS = 2.0;
const SAND_RUT_MIN_SPEED_MPS = 0.6;
const PARKED_SPEED_MPS = 0.5;
const NEARBY_FX_RADIUS_M = 55;
const SURFACE_CELL_SIZE_M = 32;
const INV_SURFACE_CELL_SIZE_M = 1 / SURFACE_CELL_SIZE_M;
const PROP_STREAM_MIN_MOVE_SQ = 3.5 * 3.5;

const compiledZoneExtentsCache = new WeakMap();

function surfaceCellKey(cx, cz) {
  return ((cx + 32768) << 16) | ((cz + 32768) & 0xffff);
}

function flagInstancedAttrDirty(attr, activeInstances) {
  const floatCount = Math.max(0, activeInstances) * attr.itemSize;
  if (typeof attr.clearUpdateRanges === "function" && typeof attr.addUpdateRange === "function") {
    attr.clearUpdateRanges();
    if (floatCount > 0) {
      attr.addUpdateRange(0, floatCount);
    }
  } else if (attr.updateRange) {
    attr.updateRange.offset = 0;
    attr.updateRange.count =
      floatCount > 0
        ? attr.updateRange.count > floatCount
          ? attr.updateRange.count
          : floatCount
        : -1;
  }
  attr.needsUpdate = true;
}

function clamp(v, lo, hi) {
  return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : lo;
}

function smoothstep(edge0, edge1, x) {
  const t = clamp((x - edge0) / (edge1 - edge0 || 1), 0, 1);
  return t * t * (3 - 2 * t);
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function hash2D(x, y, seed = 0) {
  let h = Math.imul(x ^ Math.imul(seed, 0x9e3779b9), 0x85ebca6b);
  h = Math.imul(h ^ Math.imul(y, 0xc2b2ae35), 0x27d4eb2f);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  return (h >>> 0) / 4294967295;
}

function hashString(str) {
  let h = 2166136261;
  const s = String(str ?? "");
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  }
  return h >>> 0;
}

function periodicNoise(px, py, period, seed, size = TEX_SIZE) {
  const mask = period - 1;
  const u = (px / size) * period;
  const v = (py / size) * period;
  const ix0 = Math.floor(u) & mask;
  const iy0 = Math.floor(v) & mask;
  const ix1 = (ix0 + 1) & mask;
  const iy1 = (iy0 + 1) & mask;
  const fx = u - Math.floor(u);
  const fy = v - Math.floor(v);
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const n00 = hash2D(ix0, iy0, seed);
  const n10 = hash2D(ix1, iy0, seed);
  const n01 = hash2D(ix0, iy1, seed);
  const n11 = hash2D(ix1, iy1, seed);
  return lerp(lerp(n00, n10, sx), lerp(n01, n11, sx), sy);
}

function periodicFbm(px, py, basePeriod, octaves, seed, size = TEX_SIZE) {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let period = basePeriod;
  for (let o = 0; o < octaves; o++) {
    sum += amp * periodicNoise(px, py, period, seed + o * 1013, size);
    norm += amp;
    amp *= 0.5;
    period <<= 1;
  }
  return sum / (norm || 1);
}

function makeDataTexture(
  data,
  name,
  srgb = false,
  size = TEX_SIZE,
  anisotropy = 1,
  wrap = THREE.RepeatWrapping,
) {
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.name = name;
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = wrap;
  tex.wrapT = wrap;
  tex.anisotropy = anisotropy;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

export function createCinematicRoadTextures() {
  const S = ROAD_TEX_SIZE;
  const count = S * S * 4;

  const roadColor = new Uint8Array(count);
  const roadBump = new Uint8Array(count);
  const roadRough = new Uint8Array(count);

  const paveColor = new Uint8Array(count);
  const paveBump = new Uint8Array(count);
  const paveRough = new Uint8Array(count);

  // 1. 512x512 Dark Weathered Cairo Bitumen Asphalt (neutral dark charcoal-basalt + warm dust specks)
  for (let y = 0; y < S; y++) {
    const uRowOffset = y * S;
    for (let x = 0; x < S; x++) {
      const idx = (uRowOffset + x) * 4;
      const uNorm = x / S;

      const grain1 = hash2D(x, y, 0x1a73);
      const coarseChip = periodicNoise(x, y, 256, 0x3c95, S);
      const macroFbm = periodicFbm(x, y, 4, 4, 0x4da6, S);
      const mesoFbm = periodicFbm(x, y, 16, 3, 0x5eb7, S);
      const dustFbm = periodicFbm(x, y, 8, 3, 0x6fc8, S);

      // Symmetric longitudinal tire-wear polish bands around uNorm = 0.27 and 0.73
      const rutWobble = (periodicNoise(x, y, 4, 0x7119, S) - 0.5) * 0.022;
      const dA = (uNorm - (0.27 + rutWobble)) / 0.095;
      const dB = (uNorm - (0.73 - rutWobble)) / 0.095;
      const rutMod = 0.74 + 0.26 * periodicNoise(x, y, 8, 0x722a, S);
      const rutPolish = clamp((Math.exp(-dA * dA) + Math.exp(-dB * dB)) * rutMod, 0, 1);

      // Subtle lane-center oil-drip darkening
      const dCenter = (uNorm - 0.50) / 0.072;
      const oilPatch = smoothstep(0.60, 0.78, periodicFbm(x, y, 4, 3, 0x833b, S));
      const oilDrip = Math.exp(-dCenter * dCenter) * oilPatch;

      // Domain-warped irregular dark tar-sealed crack veins (#14171a)
      const warpX = (periodicFbm(x, y, 4, 3, 0x944c, S) - 0.5) * 64;
      const warpY = (periodicFbm(x, y, 4, 3, 0xa55d, S) - 0.5) * 64;
      const crackField = periodicFbm(x + warpX, y + warpY, 4, 3, 0xb66e, S);
      const crackRegion = smoothstep(0.50, 0.66, periodicFbm(x, y, 2, 2, 0xc77f, S));
      const crackDist = Math.abs(crackField - 0.50);
      const tarBand = (1 - smoothstep(0.004, 0.015, crackDist)) * crackRegion;
      const crackCore = (1 - smoothstep(0.0015, 0.006, crackDist)) * crackRegion;

      const agg = clamp(0.42 * macroFbm + 0.28 * mesoFbm + 0.30 * coarseChip, 0, 1);
      let r = lerp(46, 68, agg);
      let g = lerp(48, 70, agg);
      let b = lerp(50, 71, agg);

      const speckWeight = (1 - 0.45 * rutPolish) * (1 - 0.85 * tarBand);
      if (grain1 > 0.945) {
        r += 15 * speckWeight;
        g += 14 * speckWeight;
        b += 12 * speckWeight;
      } else if (grain1 < 0.075) {
        r -= 9 * speckWeight;
        g -= 9 * speckWeight;
        b -= 9 * speckWeight;
      } else {
        const delta = (grain1 - 0.5) * 10 * speckWeight;
        r += delta;
        g += delta;
        b += delta;
      }

      // Subtle warm Cairo dust specks in road pores (keeps neutral charcoal with zero blue bias)
      const dustMask = smoothstep(0.56, 0.82, dustFbm) * (1 - 0.65 * rutPolish) * (1 - tarBand);
      const dustFleck = grain1 > 0.89 ? dustMask * 5 : 0;
      r += dustMask * 6.5 + dustFleck;
      g += dustMask * 4.8 + dustFleck * 0.8;
      b += dustMask * 1.8 + dustFleck * 0.35;

      const wearShade = (1 - 0.13 * rutPolish) * (1 - 0.16 * oilDrip);
      r = lerp(r * wearShade, 0x14, tarBand * 0.92);
      g = lerp(g * wearShade, 0x17, tarBand * 0.92);
      b = lerp(b * wearShade, 0x1a, tarBand * 0.92);

      roadColor[idx] = Math.round(clamp(r, 16, 82));
      roadColor[idx + 1] = Math.round(clamp(g, 18, 82));
      roadColor[idx + 2] = Math.round(clamp(b, 19, 82));
      roadColor[idx + 3] = 255;

      let aggHeight =
        0.52 +
        (grain1 - 0.5) * 0.34 +
        (coarseChip - 0.5) * 0.22 +
        (mesoFbm - 0.5) * 0.14;
      aggHeight = lerp(aggHeight, 0.50 + (grain1 - 0.5) * 0.16, rutPolish * 0.55);
      const bumpH = clamp(lerp(aggHeight, 0.10, crackCore * 0.92), 0, 1);
      const bByte = Math.round(bumpH * 255);
      roadBump[idx] = bByte;
      roadBump[idx + 1] = bByte;
      roadBump[idx + 2] = bByte;
      roadBump[idx + 3] = 255;

      const coarseRough = lerp(0.91, 0.98, 0.60 * grain1 + 0.40 * mesoFbm);
      let rough = lerp(coarseRough, 0.70, clamp(rutPolish * 0.88, 0, 1));
      rough = lerp(rough, 0.66, clamp(tarBand * 0.92 + oilDrip * 0.65, 0, 1));
      const rByte = Math.round(clamp(rough, 0.58, 0.99) * 255);
      roadRough[idx] = rByte;
      roadRough[idx + 1] = rByte;
      roadRough[idx + 2] = rByte;
      roadRough[idx + 3] = 255;
    }
  }

  // 2. 512x512 Authentic Cairo 4x4 Scored Concrete & Interlocking Sidewalk Tiles (#66625a..#7f7a6f)
  const tileSpan = S / 4; // 128 px per ~45x45 cm concrete flag
  const jointHalfW = 2.1;
  const bevelEnd = 5.6;

  for (let y = 0; y < S; y++) {
    const rowOffset = y * S;
    for (let x = 0; x < S; x++) {
      const idx = (rowOffset + x) * 4;
      const wobbleX = (periodicNoise(x, y, 32, 0xd112, S) - 0.5) * 0.82;
      const wobbleY = (periodicNoise(x, y, 32, 0xd223, S) - 0.5) * 0.82;
      const wx = ((x + wobbleX) % S + S) % S;
      const wy = ((y + wobbleY) % S + S) % S;

      const tileCol = Math.floor(wx / tileSpan) & 3;
      const tileRow = Math.floor(wy / tileSpan) & 3;
      const lx = wx - tileCol * tileSpan;
      const ly = wy - tileRow * tileSpan;
      const edgeDist = Math.min(lx, tileSpan - lx, ly, tileSpan - ly);

      const tileShade = hash2D(tileCol, tileRow, 0xe334);
      const tileWarmth = hash2D(tileCol, tileRow, 0xe445);
      const grimeFbm = periodicFbm(x, y, 4, 4, 0xf778, S);
      const stoneMicro = periodicFbm(x, y, 32, 3, 0xf889, S);
      const stoneGrit = hash2D(x, y, 0xf99a);
      const grime = smoothstep(0.45, 0.85, grimeFbm);

      // Diagonal hairline corner crack on ~18% of tiles (3 of 16 flags, away from tile center)
      let cornerCrack = 0;
      if (((tileCol * 3 + tileRow * 5) & 15) < 3) {
        const cx = (tileCol & 1) ? tileSpan - lx : lx;
        const cy = (tileRow & 1) ? tileSpan - ly : ly;
        if (cx < 44 && cy < 44) {
          const cWarp = (periodicNoise(x, y, 32, 0xe667, S) - 0.5) * 6.5;
          cornerCrack = 1 - smoothstep(0.45, 1.65, Math.abs(cx + cy + cWarp - 36));
        }
      }

      if (edgeDist < jointHalfW) {
        // Deep recessed dark mortar joint (#3a3833)
        const jMix = clamp(edgeDist / jointHalfW, 0, 1);
        const mBlend = 0.62 * jMix + 0.38 * stoneGrit;
        paveColor[idx] = Math.round(lerp(50, 62, mBlend));
        paveColor[idx + 1] = Math.round(lerp(48, 59, mBlend));
        paveColor[idx + 2] = Math.round(lerp(43, 53, mBlend));
        paveColor[idx + 3] = 255;

        const jHeight = lerp(0.12, 0.18, 0.65 * jMix + 0.35 * stoneGrit);
        const jb = Math.round(jHeight * 255);
        paveBump[idx] = jb;
        paveBump[idx + 1] = jb;
        paveBump[idx + 2] = jb;
        paveBump[idx + 3] = 255;

        const jr = Math.round(lerp(0.95, 0.99, stoneGrit) * 255);
        paveRough[idx] = jr;
        paveRough[idx + 1] = jr;
        paveRough[idx + 2] = jr;
        paveRough[idx + 3] = 255;
      } else {
        // Beveled tile edge (0.55) rising onto weathered Cairo stone face (0.78..0.92)
        const bevelT = smoothstep(jointHalfW, bevelEnd, edgeDist);
        const stoneMix = clamp(
          0.52 * tileShade + 0.30 * stoneMicro + 0.18 * stoneGrit - 0.22 * grime,
          0,
          1,
        );
        const warmShift = (tileWarmth - 0.5) * 5;
        const chamferShade = lerp(0.84, 1.0, bevelT);
        const crestCatch = 3.5 * Math.exp(-(((edgeDist - 5.2) / 1.4) ** 2));

        let pr = (lerp(0x66, 0x7f, stoneMix) + warmShift) * chamferShade + crestCatch;
        let pg = (lerp(0x62, 0x7a, stoneMix) + warmShift * 0.7) * chamferShade + crestCatch * 0.95;
        let pb = (lerp(0x5a, 0x6f, stoneMix) + warmShift * 0.3) * chamferShade + crestCatch * 0.88;

        pr = lerp(pr, 0x3c, cornerCrack * 0.85);
        pg = lerp(pg, 0x39, cornerCrack * 0.85);
        pb = lerp(pb, 0x33, cornerCrack * 0.85);

        paveColor[idx] = Math.round(clamp(pr, 56, 142));
        paveColor[idx + 1] = Math.round(clamp(pg, 53, 136));
        paveColor[idx + 2] = Math.round(clamp(pb, 48, 125));
        paveColor[idx + 3] = 255;

        const faceHeight = clamp(
          0.81 + 0.09 * stoneMicro + (stoneGrit - 0.5) * 0.06 + (tileShade - 0.5) * 0.04,
          0.78,
          0.92,
        );
        let pHeight = lerp(0.55, faceHeight, bevelT);
        pHeight = lerp(pHeight, 0.26, cornerCrack * 0.90);
        const pbByte = Math.round(clamp(pHeight, 0, 1) * 255);
        paveBump[idx] = pbByte;
        paveBump[idx + 1] = pbByte;
        paveBump[idx + 2] = pbByte;
        paveBump[idx + 3] = 255;

        const pRough = clamp(
          lerp(0.88, 0.98, 0.45 * grime + 0.35 * stoneGrit + 0.20 * (1 - stoneMicro)),
          0.88,
          0.98,
        );
        const prByte = Math.round(pRough * 255);
        paveRough[idx] = prByte;
        paveRough[idx + 1] = prByte;
        paveRough[idx + 2] = prByte;
        paveRough[idx + 3] = 255;
      }
    }
  }

  const road = {
    map: makeDataTexture(roadColor, "cinematic-road-albedo", true, S, 8),
    bumpMap: makeDataTexture(roadBump, "cinematic-road-bump", false, S, 8),
    roughnessMap: makeDataTexture(roadRough, "cinematic-road-roughness", false, S, 8),
  };

  const pavement = {
    map: makeDataTexture(paveColor, "cinematic-pavement-albedo", true, S, 8),
    bumpMap: makeDataTexture(paveBump, "cinematic-pavement-bump", false, S, 8),
    roughnessMap: makeDataTexture(paveRough, "cinematic-pavement-roughness", false, S, 8),
  };

  const textures = [
    road.map,
    road.bumpMap,
    road.roughnessMap,
    pavement.map,
    pavement.bumpMap,
    pavement.roughnessMap,
  ];

  let disposed = false;
  return {
    road,
    pavement,
    textures,
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const tex of textures) tex.dispose();
    },
  };
}

function createLampPoolGlowTexture(trackTex) {
  const S = LAMP_POOL_TEX_SIZE;
  const data = new Uint8Array(S * S * 4);
  const half = (S - 1) * 0.5;

  for (let y = 0; y < S; y++) {
    const ny = (y - half) / half; // [-1, 1] along boulevard twin-lantern axis
    for (let x = 0; x < S; x++) {
      const nx = (x - half) / half; // [-1, 1] across sidewalk -> curb -> asphalt
      const idx = (y * S + x) * 4;

      const rad = Math.hypot(nx, ny);
      // Soft radial falloff strictly reaching 0 before UV border so zero quad edge ever appears
      const edgeMask = smoothstep(0.98, 0.05, rad);
      // Twin-lantern warm tungsten core with gentle dual-arm elongation
      const twinA = Math.hypot(nx * 1.02, (ny - 0.16) * 1.10);
      const twinB = Math.hypot(nx * 1.02, (ny + 0.16) * 1.10);
      const core = clamp(
        0.58 * Math.exp(-twinA * twinA * 2.6) +
          0.58 * Math.exp(-twinB * twinB * 2.6),
        0,
        1,
      );
      const intensity =
        rad >= 0.98 ? 0 : clamp(Math.pow(edgeMask, 1.3) * (0.54 + 0.60 * core), 0, 1);

      data[idx] = intensity === 0 ? 0 : Math.round(lerp(248, 255, core));
      data[idx + 1] = intensity === 0 ? 0 : Math.round(lerp(198, 232, core));
      data[idx + 2] = intensity === 0 ? 0 : Math.round(lerp(126, 170, core));
      data[idx + 3] = Math.round(intensity * 255);
    }
  }

  return trackTex(
    makeDataTexture(
      data,
      "street-lamp-pool-glow",
      true,
      S,
      2,
      THREE.ClampToEdgeWrapping,
    ),
  );
}

function createWaterTextures(trackTex) {
  const count = TEX_SIZE * TEX_SIZE * 4;
  const colorData = new Uint8Array(count);
  const bumpData = new Uint8Array(count);
  const roughData = new Uint8Array(count);

  for (let y = 0; y < TEX_SIZE; y++) {
    for (let x = 0; x < TEX_SIZE; x++) {
      const idx = (y * TEX_SIZE + x) * 4;
      const depthFbm = periodicFbm(x, y, 4, 4, 0x1041);
      const fineFbm = periodicFbm(x, y, 16, 3, 0x2277);
      const warpB = periodicNoise(x, y, 32, 0x3399);
      const wave = clamp(0.54 * fineFbm + 0.28 * warpB + 0.18 * depthFbm, 0, 1);

      // Deep dark rainwater absorption over dark bitumen (#101922 .. #1f2e3b)
      const mix = clamp(depthFbm * 0.70 + wave * 0.30, 0, 1);
      colorData[idx] = Math.round(lerp(0x10, 0x1f, mix));
      colorData[idx + 1] = Math.round(lerp(0x19, 0x2e, mix));
      colorData[idx + 2] = Math.round(lerp(0x22, 0x3b, mix));
      colorData[idx + 3] = 255;

      const bumpByte = Math.round(wave * 255);
      bumpData[idx] = bumpByte;
      bumpData[idx + 1] = bumpByte;
      bumpData[idx + 2] = bumpByte;
      bumpData[idx + 3] = 255;

      const roughByte = Math.round(lerp(192, 255, Math.abs(wave - 0.5) * 1.35 + 0.12 * warpB));
      roughData[idx] = roughByte;
      roughData[idx + 1] = roughByte;
      roughData[idx + 2] = roughByte;
      roughData[idx + 3] = 255;
    }
  }

  return {
    map: trackTex(makeDataTexture(colorData, "street-water-albedo", true)),
    bumpMap: trackTex(makeDataTexture(bumpData, "street-water-bump", false)),
    roughnessMap: trackTex(makeDataTexture(roughData, "street-water-roughness", false)),
  };
}

function createWaterRippleTexture(trackTex) {
  const S = FX_TEX_SIZE;
  const data = new Uint8Array(S * S * 4);
  const half = (S - 1) * 0.5;

  for (let y = 0; y < S; y++) {
    const ny = (y - half) / half;
    const isBorderY = y === 0 || y === S - 1;
    for (let x = 0; x < S; x++) {
      const nx = (x - half) / half;
      const idx = (y * S + x) * 4;
      const isBorder = isBorderY || x === 0 || x === S - 1;
      const rad = Math.hypot(nx, ny);

      const wobble = (periodicFbm(x, y, 8, 3, 0x51a3, S) - 0.5) * 0.065;
      const rWob = rad + wobble * smoothstep(0.16, 0.42, rad);

      // 3D refractive water wave: shaded inner trough + sunlit sky-glint crest (no flat white outlines)
      const outerCrest = Math.exp(-(((rWob - 0.70) / 0.115) ** 2));
      const outerTrough = Math.exp(-(((rWob - 0.58) / 0.095) ** 2));
      const innerCrest = 0.62 * Math.exp(-(((rWob - 0.41) / 0.105) ** 2));
      const innerCut = smoothstep(0.16, 0.30, rad);
      const outerCut = 1 - smoothstep(0.76, 0.90, rad);

      const waveEnv = clamp((outerCrest + outerTrough * 0.75 + innerCrest) * innerCut * outerCut * 0.78, 0, 1);
      const ringVal = isBorder || rad < 0.14 || rad >= 0.90 ? 0 : waveEnv;

      const shade = clamp(0.5 + (outerCrest + innerCrest * 0.8 - outerTrough * 0.95) * 0.65, 0, 1);
      data[idx] = Math.round(lerp(0x0c, 0x9c, shade));
      data[idx + 1] = Math.round(lerp(0x18, 0xc2, shade));
      data[idx + 2] = Math.round(lerp(0x26, 0xe2, shade));
      data[idx + 3] = Math.round(ringVal * 255);
    }
  }

  return trackTex(
    makeDataTexture(data, "street-water-ripple-rings", true, S, 2, THREE.ClampToEdgeWrapping),
  );
}

function createWaterSprayMistTexture(trackTex) {
  const S = FX_TEX_SIZE;
  const data = new Uint8Array(S * S * 4);
  const half = (S - 1) * 0.5;

  for (let y = 0; y < S; y++) {
    const ny = (y - half) / half;
    const isBorderY = y === 0 || y === S - 1;
    for (let x = 0; x < S; x++) {
      const nx = (x - half) / half;
      const idx = (y * S + x) * 4;
      const isBorder = isBorderY || x === 0 || x === S - 1;
      const rad = Math.hypot(nx, ny);

      const warpX = (periodicFbm(x, y, 4, 3, 0x6111, S) - 0.5) * 18;
      const warpY = (periodicFbm(x, y, 4, 3, 0x6222, S) - 0.5) * 18;
      // Directional radial water-sheet fan + discrete liquid droplet flecks (reads as liquid splash, not round smoke!)
      const angle = Math.atan2(ny + 0.35, nx);
      const rayStreaks = 0.5 + 0.5 * Math.sin(angle * 19.0 + periodicFbm(x, y, 8, 2, 0x6333, S) * 4.2);
      const droplets = smoothstep(0.58, 0.88, periodicNoise(x * 1.8 + warpX * 0.4, y * 1.8 + warpY * 0.4, 32, 0x6444, S));
      const sheet = periodicFbm(x + warpX, y + warpY, 8, 3, 0x6555, S);

      const radialMask = 1 - smoothstep(0.16, 0.84, rad);
      const borderGuard = 1 - smoothstep(0.80, 0.90, rad);
      const splashStructure = clamp(0.46 * rayStreaks * sheet + 0.58 * droplets - 0.08, 0, 1);
      const alpha = isBorder || rad >= 0.90
        ? 0
        : clamp(radialMask * borderGuard * splashStructure * 0.94, 0, 1);

      const tone = clamp(0.45 * rayStreaks + 0.55 * droplets, 0, 1);
      data[idx] = Math.round(lerp(0xa8, 0xe4, tone));
      data[idx + 1] = Math.round(lerp(0xc8, 0xf2, tone));
      data[idx + 2] = Math.round(lerp(0xe2, 0xff, tone));
      data[idx + 3] = Math.round(alpha * 255);
    }
  }

  return trackTex(
    makeDataTexture(data, "street-water-spray-fbm", true, S, 2, THREE.ClampToEdgeWrapping),
  );
}

function createWetTrackTexture(trackTex) {
  const S = TRACK_TEX_SIZE;
  const data = new Uint8Array(S * S * 4);

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const idx = (y * S + x) * 4;
      const u = x / (S - 1);
      const isEdge = x === 0 || x === S - 1;
      const edgeDist = Math.min(u, 1 - u);
      const shoulder = smoothstep(0.02, 0.18, edgeDist);

      // Three longitudinal tire drainage grooves + micro-asphalt pore variation
      const g1 = Math.exp(-(((u - 0.29) / 0.042) ** 2));
      const g2 = Math.exp(-(((u - 0.50) / 0.040) ** 2));
      const g3 = Math.exp(-(((u - 0.71) / 0.042) ** 2));
      const grooveCut = 1 - 0.52 * clamp(g1 + g2 + g3, 0, 1);
      const pore = 0.78 + 0.22 * periodicFbm(x, y, 8, 3, 0x6789, S);
      const blockRib = 0.90 + 0.10 * Math.sin((TAU * y * 6) / S + (u > 0.5 ? 0.9 : -0.9));

      const alpha = isEdge ? 0 : clamp(shoulder * grooveCut * pore * blockRib, 0, 1);
      const grit = hash2D(x, y, 0x679a);
      data[idx] = Math.round(lerp(0x0c, 0x14, grit));
      data[idx + 1] = Math.round(lerp(0x10, 0x19, grit));
      data[idx + 2] = Math.round(lerp(0x14, 0x1e, grit));
      data[idx + 3] = Math.round(alpha * 255);
    }
  }

  const tex = makeDataTexture(data, "street-wet-track-tread", true, S, 4, THREE.RepeatWrapping);
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.needsUpdate = true;
  return trackTex(tex);
}

function createSandRutTextures(trackTex) {
  const S = TRACK_TEX_SIZE;
  const colorData = new Uint8Array(S * S * 4);
  const bumpData = new Uint8Array(S * S * 4);

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const idx = (y * S + x) * 4;
      const u = x / (S - 1);
      const isEdge = x === 0 || x === S - 1;
      const edgeDist = Math.min(u, 1 - u);
      const outerFeather = smoothstep(0.02, 0.15, edgeDist);

      const centerDist = Math.abs(u - 0.5);
      // Deeply carved compressed inner tire trough (centerDist < 0.28) flanked by crisp sunlit displaced sand berms
      const troughMask = 1 - smoothstep(0.19, 0.30, centerDist);
      const ridgeCrest = Math.exp(-(((centerDist - 0.37) / 0.052) ** 2));

      // Diagonal SUV tire chevron tread lugs pressed into inner trough
      const chevronPhase = (TAU * (y * 6 + Math.abs(u - 0.5) * S * 1.5)) / S;
      const treadLug = 0.5 + 0.5 * Math.sin(chevronPhase);
      const grain = hash2D(x, y, 0x7331);
      const fbm = periodicFbm(x, y, 8, 3, 0x7332, S);

      // Natural shaded damp compressed sand trough (#564024) flanked by warm displaced golden-ochre berms (#af8e5a) — real sand, not black ink!
      const rimMix = clamp(ridgeCrest * 0.96 + (1 - troughMask) * 0.42, 0, 1);
      const baseR = lerp(0x56, 0xaf, rimMix);
      const baseG = lerp(0x40, 0x8e, rimMix);
      const baseB = lerp(0x24, 0x5a, rimMix);
      const lugShade = troughMask * (treadLug - 0.5) * 0.16 + (grain - 0.5) * 0.07;
      const r = clamp(baseR + lugShade * 28, 62, 192);
      const g = clamp(baseG + lugShade * 22, 46, 158);
      const b = clamp(baseB + lugShade * 14, 24, 108);

      const alpha = isEdge
        ? 0
        : clamp(outerFeather * (0.94 * troughMask + 0.78 * ridgeCrest + 0.14 * fbm), 0, 0.96);

      colorData[idx] = Math.round(r);
      colorData[idx + 1] = Math.round(g);
      colorData[idx + 2] = Math.round(b);
      colorData[idx + 3] = Math.round(alpha * 255);

      const bumpH = clamp(
        0.48 - 0.34 * troughMask + 0.14 * troughMask * treadLug + 0.42 * ridgeCrest + (grain - 0.5) * 0.08,
        0.05,
        0.98,
      );
      const bByte = Math.round(bumpH * 255);
      bumpData[idx] = bByte;
      bumpData[idx + 1] = bByte;
      bumpData[idx + 2] = bByte;
      bumpData[idx + 3] = 255;
    }
  }

  const map = makeDataTexture(colorData, "street-sand-rut-albedo", true, S, 4, THREE.RepeatWrapping);
  map.wrapS = THREE.ClampToEdgeWrapping;
  map.wrapT = THREE.RepeatWrapping;
  map.needsUpdate = true;

  const bumpMap = makeDataTexture(bumpData, "street-sand-rut-bump", false, S, 4, THREE.RepeatWrapping);
  bumpMap.wrapS = THREE.ClampToEdgeWrapping;
  bumpMap.wrapT = THREE.RepeatWrapping;
  bumpMap.needsUpdate = true;

  return {
    map: trackTex(map),
    bumpMap: trackTex(bumpMap),
  };
}

function createSandDustCloudTexture(trackTex) {
  const S = FX_TEX_SIZE;
  const data = new Uint8Array(S * S * 4);
  const half = (S - 1) * 0.5;

  for (let y = 0; y < S; y++) {
    const ny = (y - half) / half;
    const isBorderY = y === 0 || y === S - 1;
    for (let x = 0; x < S; x++) {
      const nx = (x - half) / half;
      const idx = (y * S + x) * 4;
      const isBorder = isBorderY || x === 0 || x === S - 1;
      const rad = Math.hypot(nx, ny);

      const warpX = (periodicFbm(x, y, 4, 3, 0x8111, S) - 0.5) * 30;
      const warpY = (periodicFbm(x, y, 4, 3, 0x8222, S) - 0.5) * 30;
      const billow = periodicFbm(x + warpX, y + warpY, 4, 4, 0x8333, S);
      const detail = periodicFbm(x * 1.4 - warpY, y * 1.4 + warpX, 8, 3, 0x8444, S);

      const organicEdge = 0.88 - 0.24 * (1 - billow);
      const radialMask = 1 - smoothstep(0.14, Math.max(0.32, organicEdge), rad);
      const borderGuard = 1 - smoothstep(0.82, 0.90, rad);
      const puffDensity = clamp((0.64 * billow + 0.36 * detail) * 1.24 - 0.12, 0, 1);

      const alpha = isBorder || rad >= 0.90
        ? 0
        : clamp(radialMask * borderGuard * puffDensity * 0.94, 0, 1);

      // 3D Beer-Lambert self-shadowed desert silt billows: sunlit crest (#f6e4c4) -> warm shaded belly (#7b5e3a)
      const verticalShade = clamp(-ny * 0.58 + 0.48, 0, 1);
      const sunLift = clamp(0.46 * billow + 0.22 * detail + 0.32 * verticalShade, 0, 1);
      data[idx] = Math.round(lerp(0x7b, 0xf6, sunLift));
      data[idx + 1] = Math.round(lerp(0x5e, 0xe4, sunLift));
      data[idx + 2] = Math.round(lerp(0x3a, 0xc4, sunLift));
      data[idx + 3] = Math.round(alpha * 255);
    }
  }

  return trackTex(
    makeDataTexture(data, "street-sand-dust-fbm", true, S, 2, THREE.ClampToEdgeWrapping),
  );
}

function createSandGritTexture(trackTex) {
  const S = TRACK_TEX_SIZE;
  const data = new Uint8Array(S * S * 4);
  const half = (S - 1) * 0.5;

  // 12 deterministic coarse sand / fine pebble grains inside UV disc
  const grains = [];
  for (let i = 0; i < 12; i++) {
    const ang = hash2D(i, 1, 0x9301) * TAU;
    const dist = 0.10 + 0.62 * Math.sqrt(hash2D(i, 2, 0x9302));
    grains.push({
      cx: Math.cos(ang) * dist,
      cy: Math.sin(ang) * dist,
      rx: 0.055 + 0.045 * hash2D(i, 3, 0x9303),
      ry: 0.042 + 0.038 * hash2D(i, 4, 0x9304),
      tone: hash2D(i, 5, 0x9305),
    });
  }

  for (let y = 0; y < S; y++) {
    const ny = (y - half) / half;
    const isBorderY = y === 0 || y === S - 1;
    for (let x = 0; x < S; x++) {
      const nx = (x - half) / half;
      const idx = (y * S + x) * 4;
      const isBorder = isBorderY || x === 0 || x === S - 1;
      const rad = Math.hypot(nx, ny);

      let maxGrain = 0;
      let grainTone = 0.5;
      if (!isBorder && rad < 0.88) {
        for (let g = 0; g < grains.length; g++) {
          const gr = grains[g];
          const d = Math.hypot((nx - gr.cx) / gr.rx, (ny - gr.cy) / gr.ry);
          const v = 1 - smoothstep(0.42, 1.0, d);
          if (v > maxGrain) {
            maxGrain = v;
            grainTone = gr.tone;
          }
        }
      }

      data[idx] = Math.round(lerp(0xb8, 0xea, grainTone));
      data[idx + 1] = Math.round(lerp(0x96, 0xcb, grainTone));
      data[idx + 2] = Math.round(lerp(0x64, 0x96, grainTone));
      data[idx + 3] = Math.round(clamp(maxGrain, 0, 1) * 255);
    }
  }

  return trackTex(
    makeDataTexture(data, "street-sand-grit-cluster", true, S, 2, THREE.ClampToEdgeWrapping),
  );
}

function createWaterHaloTextures(trackTex) {
  const count = TEX_SIZE * TEX_SIZE * 4;
  const colorData = new Uint8Array(count);
  const bumpData = new Uint8Array(count);
  const roughData = new Uint8Array(count);

  for (let y = 0; y < TEX_SIZE; y++) {
    for (let x = 0; x < TEX_SIZE; x++) {
      const idx = (y * TEX_SIZE + x) * 4;
      const patch = periodicFbm(x, y, 8, 3, 0x4512);
      const grit = hash2D(x, y, 0x4599);
      const tone = clamp(0.65 * patch + 0.35 * grit, 0, 1);

      colorData[idx] = Math.round(lerp(30, 44, tone));
      colorData[idx + 1] = Math.round(lerp(34, 48, tone));
      colorData[idx + 2] = Math.round(lerp(37, 51, tone));
      colorData[idx + 3] = 255;

      const b = Math.round(lerp(90, 210, grit * 0.65 + patch * 0.35));
      bumpData[idx] = b;
      bumpData[idx + 1] = b;
      bumpData[idx + 2] = b;
      bumpData[idx + 3] = 255;

      const r = Math.round(lerp(185, 255, patch));
      roughData[idx] = r;
      roughData[idx + 1] = r;
      roughData[idx + 2] = r;
      roughData[idx + 3] = 255;
    }
  }

  return {
    map: trackTex(makeDataTexture(colorData, "street-water-halo-albedo", true)),
    bumpMap: trackTex(makeDataTexture(bumpData, "street-water-halo-bump", false)),
    roughnessMap: trackTex(makeDataTexture(roughData, "street-water-halo-roughness", false)),
  };
}

function createSandTextures(trackTex) {
  const count = TEX_SIZE * TEX_SIZE * 4;
  const colorData = new Uint8Array(count);
  const bumpData = new Uint8Array(count);
  const roughData = new Uint8Array(count);

  for (let y = 0; y < TEX_SIZE; y++) {
    for (let x = 0; x < TEX_SIZE; x++) {
      const idx = (y * TEX_SIZE + x) * 4;
      const fbm = periodicFbm(x, y, 6, 4, 0x7711);
      const grain = hash2D(x, y, 0x7788);
      const uNorm = x / TEX_SIZE;

      // Eolian wind-blown desert ripples
      const rippleWave = 0.5 + 0.5 * Math.sin((TAU * (x * 7 + y * 2)) / TEX_SIZE + fbm * 2.6);
      const fineRipple = 0.5 + 0.5 * Math.sin((TAU * (x * 15 - y * 3)) / TEX_SIZE + fbm * 1.4);

      // Dual tire-track ruts with subtle tread chevron impressions
      const dRutA = (uNorm - 0.28) / 0.068;
      const dRutB = (uNorm - 0.72) / 0.068;
      const rutCore = Math.exp(-dRutA * dRutA) + Math.exp(-dRutB * dRutB);
      const rutShoulder =
        Math.exp(-(((Math.abs(uNorm - 0.28) - 0.085) / 0.04) ** 2)) +
        Math.exp(-(((Math.abs(uNorm - 0.72) - 0.085) / 0.04) ** 2));
      const tread = 0.5 + 0.5 * Math.sin((TAU * (y * 24 + (uNorm > 0.5 ? x : -x) * 4)) / TEX_SIZE);

      let r;
      let g;
      let b;
      if (grain > 0.968) {
        // Coarse dusk desert pebble speckle (~12% deeper)
        r = 91;
        g = 73;
        b = 49;
      } else if (grain < 0.024) {
        // Warm dusk quartz grain (~12% deeper)
        r = 162;
        g = 138;
        b = 99;
      } else {
        // Deepened warm Egyptian golden-ochre sand (#745d3c .. #967c53, ~12% deeper for moody dusk contrast)
        const sandMix = clamp(
          0.56 * rippleWave + 0.30 * fbm + 0.14 * grain - 0.26 * rutCore + 0.10 * rutShoulder,
          0,
          1,
        );
        r = Math.round(lerp(0x74, 0x96, sandMix));
        g = Math.round(lerp(0x5d, 0x7c, sandMix));
        b = Math.round(lerp(0x3c, 0x53, sandMix));
      }

      colorData[idx] = r;
      colorData[idx + 1] = g;
      colorData[idx + 2] = b;
      colorData[idx + 3] = 255;

      const relief = clamp(
        0.46 * rippleWave +
          0.14 * fineRipple +
          0.20 * grain +
          0.12 * fbm -
          0.26 * rutCore +
          0.10 * rutCore * tread +
          0.12 * rutShoulder,
        0,
        1,
      );
      const bumpByte = Math.round(relief * 255);
      bumpData[idx] = bumpByte;
      bumpData[idx + 1] = bumpByte;
      bumpData[idx + 2] = bumpByte;
      bumpData[idx + 3] = 255;

      const roughByte = Math.round(
        clamp(lerp(228, 255, 0.65 * grain + 0.35 * fbm) - rutCore * 16, 204, 255),
      );
      roughData[idx] = roughByte;
      roughData[idx + 1] = roughByte;
      roughData[idx + 2] = roughByte;
      roughData[idx + 3] = 255;
    }
  }

  return {
    map: trackTex(makeDataTexture(colorData, "street-sand-albedo", true)),
    bumpMap: trackTex(makeDataTexture(bumpData, "street-sand-bump", false)),
    roughnessMap: trackTex(makeDataTexture(roughData, "street-sand-roughness", false)),
  };
}

function createCobbleTextures(trackTex) {
  const count = TEX_SIZE * TEX_SIZE * 4;
  const colorData = new Uint8Array(count);
  const bumpData = new Uint8Array(count);
  const roughData = new Uint8Array(count);

  const courseH = 16;
  const stoneW = 32;
  const numRows = TEX_SIZE / courseH;
  const numCols = TEX_SIZE / stoneW;

  for (let y = 0; y < TEX_SIZE; y++) {
    for (let x = 0; x < TEX_SIZE; x++) {
      const idx = (y * TEX_SIZE + x) * 4;
      const micro = periodicFbm(x, y, 16, 3, 0x9101);
      const speckle = hash2D(x, y, 0x9183);

      const jitterX = (micro - 0.5) * 1.5;
      const jitterY = (periodicNoise(x, y, 16, 0x9222) - 0.5) * 1.2;
      const wy = (y + jitterY + TEX_SIZE) % TEX_SIZE;
      const row = Math.floor(wy / courseH) % numRows;
      const rowOffset = (row & 1) * (stoneW * 0.5);
      const wx = (x + rowOffset + jitterX + TEX_SIZE) % TEX_SIZE;
      const col = Math.floor(wx / stoneW) % numCols;

      const localX = wx % stoneW;
      const localY = wy % courseH;
      const edgeDist = Math.min(localX, stoneW - localX, localY, courseH - localY);

      const stoneTone = hash2D(col, row, 0x55aa);
      const stoneWarmth = hash2D(col, row, 0x66bb);

      if (edgeDist < 1.85) {
        // Recessed dark sandy-basalt mortar joint
        const jointShade = clamp(edgeDist / 1.85, 0, 1);
        const jr = Math.round(lerp(56, 78, jointShade * 0.7 + speckle * 0.3));
        const jg = Math.round(lerp(53, 74, jointShade * 0.7 + speckle * 0.3));
        const jb = Math.round(lerp(49, 68, jointShade * 0.7 + speckle * 0.3));
        colorData[idx] = jr;
        colorData[idx + 1] = jg;
        colorData[idx + 2] = jb;
        colorData[idx + 3] = 255;

        const bByte = Math.round(lerp(20, 68, jointShade));
        bumpData[idx] = bByte;
        bumpData[idx + 1] = bByte;
        bumpData[idx + 2] = bByte;
        bumpData[idx + 3] = 255;

        roughData[idx] = 255;
        roughData[idx + 1] = 255;
        roughData[idx + 2] = 255;
        roughData[idx + 3] = 255;
      } else {
        // Rounded dusk-weathered basalt-limestone crown (#6c675e .. #867e72)
        const crownRaw = clamp((edgeDist - 1.85) / 4.8, 0, 1);
        const crown = crownRaw * (2 - crownRaw);
        const mix = clamp(
          0.58 * stoneTone + 0.24 * micro + 0.18 * crown + (speckle - 0.5) * 0.12,
          0,
          1,
        );
        const warmBias = (stoneWarmth - 0.5) * 5;
        colorData[idx] = Math.round(clamp(lerp(0x6c, 0x86, mix) + warmBias, 92, 146));
        colorData[idx + 1] = Math.round(clamp(lerp(0x67, 0x7e, mix) + warmBias * 0.7, 88, 138));
        colorData[idx + 2] = Math.round(clamp(lerp(0x5e, 0x72, mix) + warmBias * 0.3, 80, 126));
        colorData[idx + 3] = 255;

        const heightVal = clamp(0.36 + 0.56 * crown + (micro - 0.5) * 0.12 + (speckle - 0.5) * 0.06, 0, 1);
        const bByte = Math.round(heightVal * 255);
        bumpData[idx] = bByte;
        bumpData[idx + 1] = bByte;
        bumpData[idx + 2] = bByte;
        bumpData[idx + 3] = 255;

        const rByte = Math.round(lerp(238, 194, crown * 0.75 + (1 - speckle) * 0.25));
        roughData[idx] = rByte;
        roughData[idx + 1] = rByte;
        roughData[idx + 2] = rByte;
        roughData[idx + 3] = 255;
      }
    }
  }

  return {
    map: trackTex(makeDataTexture(colorData, "street-cobble-albedo", true)),
    bumpMap: trackTex(makeDataTexture(bumpData, "street-cobble-bump", false)),
    roughnessMap: trackTex(makeDataTexture(roughData, "street-cobble-roughness", false)),
  };
}

function elevAt(world, x, z) {
  const fn =
    typeof world?.terrainElevationAt === "function"
      ? world.terrainElevationAt
      : typeof world?.elevationAt === "function"
        ? world.elevationAt
        : null;
  if (fn) {
    const e = fn.call(world, x, z);
    return Number.isFinite(e) && e > 0 ? e : 0;
  }
  return 0;
}

function zoneExtents(zone) {
  const x = zone?.x ?? 0;
  const z = zone?.z ?? 0;
  const { halfWidth, halfLength } = resolveSurfaceZoneHalfExtents(zone);
  const heading = Number.isFinite(zone?.heading) ? zone.heading : 0;
  const shape = zone?.shape;

  if (zone && typeof zone === "object") {
    const cached = compiledZoneExtentsCache.get(zone);
    if (
      cached &&
      cached.x === x &&
      cached.z === z &&
      cached.heading === heading &&
      cached.halfWidth === halfWidth &&
      cached.halfLength === halfLength &&
      cached.shape === shape
    ) {
      return cached;
    }
  }

  const cos = Math.cos(heading);
  const sin = Math.sin(heading);
  const boundX = Math.abs(cos) * halfWidth + Math.abs(sin) * halfLength;
  const boundZ = Math.abs(sin) * halfWidth + Math.abs(cos) * halfLength;
  const ext = {
    x,
    z,
    heading,
    shape,
    cos,
    sin,
    halfWidth,
    halfLength,
    _compiledHeading: heading,
    _compiledHW: halfWidth,
    _compiledHL: halfLength,
    boundX,
    boundZ,
  };
  if (zone && typeof zone === "object") {
    compiledZoneExtentsCache.set(zone, ext);
  }
  return ext;
}

function createSurfaceBatch(colorChannels = 3) {
  const positions = [];
  const normals = [];
  const uvs = [];
  const colors = [];

  function pushVertex(v) {
    positions.push(v.x, v.y, v.z);
    normals.push(v.nx ?? 0, v.ny ?? 1, v.nz ?? 0);
    uvs.push(v.u ?? 0, v.v ?? 0);
    if (colorChannels === 4) {
      colors.push(v.r ?? 1, v.g ?? 1, v.b ?? 1, v.a ?? 1);
    } else {
      colors.push(v.r ?? 1, v.g ?? 1, v.b ?? 1);
    }
  }

  function addTri(a, b, c) {
    pushVertex(a);
    pushVertex(b);
    pushVertex(c);
  }

  function addGrid(grid) {
    const rows = grid.length - 1;
    const cols = grid[0].length - 1;
    // Compute smooth world-space normals from grid neighbors (+Y up)
    for (let r = 0; r <= rows; r++) {
      const rPrev = Math.max(0, r - 1);
      const rNext = Math.min(rows, r + 1);
      for (let c = 0; c <= cols; c++) {
        const cPrev = Math.max(0, c - 1);
        const cNext = Math.min(cols, c + 1);
        const left = grid[r][cPrev];
        const right = grid[r][cNext];
        const back = grid[rPrev][c];
        const fwd = grid[rNext][c];
        const tx = right.x - left.x;
        const ty = right.y - left.y;
        const tz = right.z - left.z;
        const bx = fwd.x - back.x;
        const by = fwd.y - back.y;
        const bz = fwd.z - back.z;
        // cross(fwd - back, right - left) yields +Y normal
        let nx = by * tz - bz * ty;
        let ny = bz * tx - bx * tz;
        let nz = bx * ty - by * tx;
        if (ny < 0) {
          nx = -nx;
          ny = -ny;
          nz = -nz;
        }
        const len = Math.hypot(nx, ny, nz) || 1;
        grid[r][c].nx = nx / len;
        grid[r][c].ny = ny / len;
        grid[r][c].nz = nz / len;
      }
    }
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const p00 = grid[r][c];
        const p10 = grid[r][c + 1];
        const p01 = grid[r + 1][c];
        const p11 = grid[r + 1][c + 1];
        addTri(p00, p01, p11);
        addTri(p00, p11, p10);
      }
    }
  }

  function build() {
    if (positions.length === 0) return null;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
    geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
    geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, colorChannels));
    geo.computeBoundingBox();
    geo.computeBoundingSphere();
    return geo;
  }

  return { addTri, addGrid, build };
}

function buildWaterPuddleGeometries(puddles, world) {
  const coreBatch = createSurfaceBatch(4);
  const haloBatch = createSurfaceBatch(4);
  const segs = 20;
  const coreRings = [0.22, 0.45, 0.68, 0.86, 1.0];
  const haloRings = [0.84, 1.06, 1.28];

  for (let pIdx = 0; pIdx < puddles.length; pIdx++) {
    const zone = puddles[pIdx];
    if (!zone) continue;
    const ext = zoneExtents(zone);
    const seed = Number.isFinite(zone.organicSeed)
      ? zone.organicSeed
      : hashString(zone.id ?? `puddle-${pIdx}`);

    const makePoint = (lx, lz, baseH, r, g, b, a, tileScale) => {
      const wx = ext.x + lx * ext.cos + lz * ext.sin;
      const wz = ext.z - lx * ext.sin + lz * ext.cos;
      const wy = baseH + elevAt(world, wx, wz);
      // Finite-difference normal on terrain for accurate puddle reflection
      const ex = elevAt(world, wx + 0.35, wz) - elevAt(world, wx - 0.35, wz);
      const ez = elevAt(world, wx, wz + 0.35) - elevAt(world, wx, wz - 0.35);
      const nx = -ex / 0.7;
      const ny = 1;
      const nz = -ez / 0.7;
      const nLen = Math.hypot(nx, ny, nz) || 1;
      return {
        x: wx,
        y: wy,
        z: wz,
        nx: nx / nLen,
        ny: ny / nLen,
        nz: nz / nLen,
        u: wx / tileScale,
        v: wz / tileScale,
        r,
        g,
        b,
        a,
      };
    };

    const centerV = makePoint(0, 0, WATER_CORE_Y, 1, 1, 1, 1.0, 3.1);
    const lastRingIdx = coreRings.length - 1;
    const coreRingVerts = coreRings.map((rf, rIdx) => {
      const alpha = rIdx === lastRingIdx ? 0.0 : rIdx === lastRingIdx - 1 ? 0.78 : 0.98;
      const tint = rIdx === lastRingIdx ? 0.84 : 1.0;
      const ring = [];
      for (let s = 0; s <= segs; s++) {
        const ang = ((s % segs) * TAU) / segs;
        const lobe = puddleOrganicScale(ang, seed);
        const lx = Math.sin(ang) * ext.halfWidth * rf * lobe;
        const lz = Math.cos(ang) * ext.halfLength * rf * lobe;
        ring.push(makePoint(lx, lz, WATER_CORE_Y, tint, tint, tint, alpha, 3.1));
      }
      return ring;
    });

    // Inner fan
    for (let s = 0; s < segs; s++) {
      coreBatch.addTri(centerV, coreRingVerts[0][s], coreRingVerts[0][s + 1]);
    }
    // Outer concentric puddle rings
    for (let r = 0; r < coreRingVerts.length - 1; r++) {
      for (let s = 0; s < segs; s++) {
        const a0 = coreRingVerts[r][s];
        const a1 = coreRingVerts[r][s + 1];
        const b0 = coreRingVerts[r + 1][s];
        const b1 = coreRingVerts[r + 1][s + 1];
        coreBatch.addTri(a0, b0, b1);
        coreBatch.addTri(a0, b1, a1);
      }
    }

    // Darkened wet-asphalt bed & damp perimeter halo 1.5 mm below Fresnel puddle surface
    const haloCenterV = makePoint(0, 0, WATER_HALO_Y, 0.82, 0.85, 0.90, 0.90, 2.6);
    const haloRingVerts = haloRings.map((rf, rIdx) => {
      const alpha = rIdx === 0 ? 0.88 : rIdx === 1 ? 0.62 : 0.0;
      const tint = rIdx === 2 ? 1.0 : 0.88;
      const ring = [];
      for (let s = 0; s <= segs; s++) {
        const ang = ((s % segs) * TAU) / segs;
        const lobe = puddleOrganicScale(ang, seed);
        const extraM = rIdx === 2 ? 0.45 : rIdx === 1 ? 0.15 : 0;
        const lx = Math.sin(ang) * (ext.halfWidth * rf * lobe + extraM);
        const lz = Math.cos(ang) * (ext.halfLength * rf * lobe + extraM);
        ring.push(makePoint(lx, lz, WATER_HALO_Y, tint, tint, tint, alpha, 2.6));
      }
      return ring;
    });

    for (let s = 0; s < segs; s++) {
      haloBatch.addTri(haloCenterV, haloRingVerts[0][s], haloRingVerts[0][s + 1]);
    }
    for (let r = 0; r < haloRingVerts.length - 1; r++) {
      for (let s = 0; s < segs; s++) {
        const a0 = haloRingVerts[r][s];
        const a1 = haloRingVerts[r][s + 1];
        const b0 = haloRingVerts[r + 1][s];
        const b1 = haloRingVerts[r + 1][s + 1];
        haloBatch.addTri(a0, b0, b1);
        haloBatch.addTri(a0, b1, a1);
      }
    }
  }

  return {
    coreGeometry: coreBatch.build(),
    haloGeometry: haloBatch.build(),
  };
}

function waterReflectionPlanes(puddles, world) {
  const planes = [];
  for (const zone of puddles) {
    if (!Number.isFinite(zone?.x) || !Number.isFinite(zone?.z)) continue;
    const { x, z, cos, sin, halfWidth, halfLength } = zoneExtents(zone);
    const level = elevAt(world, x, z);
    const samples = [
      [x + cos * halfWidth, z - sin * halfWidth], [x - cos * halfWidth, z + sin * halfWidth],
      [x + sin * halfLength, z + cos * halfLength], [x - sin * halfLength, z - cos * halfLength],
    ];
    if (samples.some(([cx, cz]) => Math.abs(elevAt(world, cx, cz) - level) > 0.075)) continue;
    planes.push({
      id: zone.id, x, z, y: level + WATER_CORE_Y,
      radius: 1.25 * Math.hypot(halfWidth, halfLength),
      area: Math.PI * halfWidth * halfLength,
    });
  }
  return planes;
}

function shapeZoneGridPoint(uNorm, vNorm, ext, fadeBand = 0.30) {
  if (ext.shape === "ellipse") {
    // Fernández-Guasti squircle-to-ellipse disc mapping: every vertex obeys (lx/hw)^2 + (lz/hl)^2 <= 1!
    const ex = uNorm * Math.sqrt(Math.max(0, 1 - 0.5 * vNorm * vNorm));
    const ez = vNorm * Math.sqrt(Math.max(0, 1 - 0.5 * uNorm * uNorm));
    const rad = Math.hypot(ex, ez);
    const edgeFade = smoothstep(0, fadeBand, Math.max(0, 1 - rad));
    return { lx: ex * ext.halfWidth, lz: ez * ext.halfLength, edgeFade };
  }
  let lx = uNorm * ext.halfWidth;
  let lz = vNorm * ext.halfLength;
  if (ext.shape === "strip") {
    const r = Math.min(ext.halfWidth, ext.halfLength) * 0.35;
    const absX = Math.abs(lx);
    const absZ = Math.abs(lz);
    const qx = absX - (ext.halfWidth - r);
    const qz = absZ - (ext.halfLength - r);
    if (qx > 0 && qz > 0) {
      const distCorner = Math.hypot(qx, qz);
      if (distCorner > r && distCorner > 1e-9) {
        const s = r / distCorner;
        lx = Math.sign(lx) * (ext.halfWidth - r + qx * s);
        lz = Math.sign(lz) * (ext.halfLength - r + qz * s);
      }
      const cornerFade = smoothstep(0, fadeBand, Math.max(0, 1 - Math.min(1, distCorner / Math.max(1e-6, r))));
      return { lx, lz, edgeFade: cornerFade };
    }
  }
  const endFade = smoothstep(0, fadeBand, 1 - Math.abs(vNorm));
  const sideFade = smoothstep(0, fadeBand, 1 - Math.abs(uNorm));
  return { lx, lz, edgeFade: sideFade * endFade };
}

function buildSandZonesGeometry(sandZones, world) {
  const batch = createSurfaceBatch(4);
  const cols = 8;

  for (let zIdx = 0; zIdx < sandZones.length; zIdx++) {
    const zone = sandZones[zIdx];
    if (!zone) continue;
    const ext = zoneExtents(zone);
    const rows = ext.halfLength > 12 ? Math.max(12, Math.ceil((ext.halfLength * 2) / 2.2)) : 12;
    const seed = hashString(zone.id ?? `sand-${zIdx}`);
    const phase = (seed & 0xff) * 0.0245;

    const grid = [];
    for (let r = 0; r <= rows; r++) {
      const vNorm = (r / rows) * 2 - 1; // [-1, 1] along length
      const rowVerts = [];
      for (let c = 0; c <= cols; c++) {
        const uNorm = (c / cols) * 2 - 1; // [-1, 1] across width
        const shaped = shapeZoneGridPoint(uNorm, vNorm, ext, 0.34);
        const edgeFade = shaped.edgeFade;

        // Inward-only wind-blown contour scallop so vertices NEVER protrude outside the zone's physics boundary!
        const inwardScallop =
          1 -
          (1 - edgeFade) *
            0.06 *
            (0.5 + 0.5 * Math.sin(vNorm * Math.PI * 2.5 + uNorm * 1.7 + phase));
        const lx = shaped.lx * inwardScallop;
        const lz = shaped.lz * inwardScallop;

        const wx = ext.x + lx * ext.cos + lz * ext.sin;
        const wz = ext.z - lx * ext.sin + lz * ext.cos;

        // 3D drifted sand mounds (+0.015 m .. +0.035 m near shoulders, tapered to 0 at edges)
        const absU = Math.abs(uNorm);
        const shoulderRidge = Math.exp(-(((absU - 0.62) / 0.24) ** 2));
        const centerSheet = 0.55 * (1 - 0.32 * Math.exp(-(((absU - 0.28) / 0.14) ** 2)));
        const duneWave = 0.80 + 0.20 * Math.sin(vNorm * Math.PI * 3.0 + phase + uNorm * 0.8);
        const moundH = edgeFade * (0.018 * centerSheet + 0.025 * shoulderRidge) * duneWave;

        const wy = SAND_BASE_Y + elevAt(world, wx, wz) + moundH;
        const shade = lerp(0.76, 0.95, clamp(edgeFade * 0.7 + shoulderRidge * 0.3, 0, 1));

        rowVerts.push({
          x: wx,
          y: wy,
          z: wz,
          u: (lx + ext.halfWidth) / 2.2,
          v: (lz + ext.halfLength) / 2.2,
          r: shade,
          g: shade * 0.98,
          b: shade * 0.93,
          a: clamp(edgeFade * 1.08, 0, 1),
        });
      }
      grid.push(rowVerts);
    }
    batch.addGrid(grid);
  }

  return batch.build();
}

function buildCobbleZonesGeometry(cobbleZones, world) {
  const batch = createSurfaceBatch(4);
  const cols = 6;

  for (let zIdx = 0; zIdx < cobbleZones.length; zIdx++) {
    const zone = cobbleZones[zIdx];
    if (!zone) continue;
    const ext = zoneExtents(zone);
    const rows = ext.halfLength > 12 ? Math.max(10, Math.ceil((ext.halfLength * 2) / 2.0)) : 10;

    const grid = [];
    for (let r = 0; r <= rows; r++) {
      const vNorm = (r / rows) * 2 - 1;
      const rowVerts = [];
      for (let c = 0; c <= cols; c++) {
        const uNorm = (c / cols) * 2 - 1;
        const shaped = shapeZoneGridPoint(uNorm, vNorm, ext, 0.24);
        const edgeFade = shaped.edgeFade;
        const crown = edgeFade * 0.004 * (1 - uNorm * uNorm * 0.6);

        const lx = shaped.lx;
        const lz = shaped.lz;
        const wx = ext.x + lx * ext.cos + lz * ext.sin;
        const wz = ext.z - lx * ext.sin + lz * ext.cos;
        const wy = COBBLE_BASE_Y + elevAt(world, wx, wz) + crown;
        const borderTint = lerp(0.84, 0.98, edgeFade);

        rowVerts.push({
          x: wx,
          y: wy,
          z: wz,
          u: (lx + ext.halfWidth) / 1.6,
          v: (lz + ext.halfLength) / 1.6,
          r: borderTint,
          g: borderTint,
          b: borderTint,
          a: clamp(edgeFade * 1.12, 0, 1),
        });
      }
      grid.push(rowVerts);
    }
    batch.addGrid(grid);
  }

  return batch.build();
}

export function buildPuddlePolygon(zone, pIdx = 0, ringFactor = 1.0, segs = 20) {
  if (!zone) return new Float64Array(0);
  const ext = zoneExtents(zone);
  const seed = Number.isFinite(zone.organicSeed)
    ? zone.organicSeed
    : hashString(zone.id ?? `puddle-${pIdx}`);
  const poly = new Float64Array(segs * 2);
  for (let s = 0; s < segs; s++) {
    const ang = (s * TAU) / segs;
    const lobe = puddleOrganicScale(ang, seed);
    const lx = Math.sin(ang) * ext.halfWidth * ringFactor * lobe;
    const lz = Math.cos(ang) * ext.halfLength * ringFactor * lobe;
    poly[s * 2] = ext.x + lx * ext.cos + lz * ext.sin;
    poly[s * 2 + 1] = ext.z - lx * ext.sin + lz * ext.cos;
  }
  return poly;
}

export function pointInsidePolygonWithClearance(x, z, poly, clearanceM = 0) {
  const n = poly ? poly.length >> 1 : 0;
  if (n < 3 || !Number.isFinite(x) || !Number.isFinite(z)) return false;
  let inside = false;
  const c = Math.max(0, clearanceM);
  const minDistSq = c * c;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const ax = poly[j * 2];
    const az = poly[j * 2 + 1];
    const bx = poly[i * 2];
    const bz = poly[i * 2 + 1];
    if ((bz > z) !== (az > z) && x < ((ax - bx) * (z - bz)) / (az - bz) + bx) {
      inside = !inside;
    }
    if (minDistSq > 0) {
      const abx = bx - ax;
      const abz = bz - az;
      const lenSq = abx * abx + abz * abz;
      const t = lenSq > 1e-12 ? clamp(((x - ax) * abx + (z - az) * abz) / lenSq, 0, 1) : 0;
      const px = ax + abx * t;
      const pz = az + abz * t;
      const dSq = (x - px) * (x - px) + (z - pz) * (z - pz);
      if (dSq < minDistSq) return false;
    }
  }
  return inside;
}

function compilePuddlePolygonEntry(zone, pIdx = 0, ringFactor = 0.92, segs = 20) {
  const poly = buildPuddlePolygon(zone, pIdx, ringFactor, segs);
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < poly.length; i += 2) {
    const px = poly[i];
    const pz = poly[i + 1];
    if (px < minX) minX = px;
    if (px > maxX) maxX = px;
    if (pz < minZ) minZ = pz;
    if (pz > maxZ) maxZ = pz;
  }
  return { poly, minX, maxX, minZ, maxZ };
}

function pointInPuddlePolygonsWithClearance(x, z, puddlePolys, clearanceM = 0) {
  if (!Array.isArray(puddlePolys) || puddlePolys.length === 0) return false;
  const c = Math.max(0, clearanceM);
  for (let i = 0; i < puddlePolys.length; i++) {
    const entry = puddlePolys[i];
    if (!entry) continue;
    if (entry.poly) {
      if (
        x < entry.minX + c - 1e-9 ||
        x > entry.maxX - c + 1e-9 ||
        z < entry.minZ + c - 1e-9 ||
        z > entry.maxZ - c + 1e-9
      ) {
        continue;
      }
      if (pointInsidePolygonWithClearance(x, z, entry.poly, clearanceM)) return true;
    } else if (pointInsidePolygonWithClearance(x, z, entry, clearanceM)) {
      return true;
    }
  }
  return false;
}

function pointInWaterPuddleList(x, z, puddles, marginM = 0) {
  if (!Array.isArray(puddles) || puddles.length === 0) return false;
  const extraPad = (Math.max(0, marginM) + 0.3) * Math.SQRT2;
  for (let i = 0; i < puddles.length; i++) {
    const zObj = puddles[i];
    if (!zObj) continue;
    const ext = zoneExtents(zObj);
    if (
      Math.abs(x - ext.x) > ext.boundX + extraPad ||
      Math.abs(z - ext.z) > ext.boundZ + extraPad
    ) {
      continue;
    }
    if (pointInWaterPuddle(x, z, zObj, i, marginM)) return true;
  }
  return false;
}

function pointInZoneList(x, z, zones, marginM = 0) {
  if (!Array.isArray(zones) || zones.length === 0) return false;
  const aabbPad = marginM > 0 ? marginM * Math.SQRT2 + 1e-6 : 1e-9;
  for (let i = 0; i < zones.length; i++) {
    const zObj = zones[i];
    if (!zObj) continue;
    const ext = zoneExtents(zObj);
    const dx = x - ext.x;
    if (Math.abs(dx) > ext.boundX + aabbPad) continue;
    const dz = z - ext.z;
    if (Math.abs(dz) > ext.boundZ + aabbPad) continue;
    const lx = dx * ext.cos - dz * ext.sin;
    const lz = dx * ext.sin + dz * ext.cos;
    if (Math.abs(lx) <= ext.halfWidth + marginM && Math.abs(lz) <= ext.halfLength + marginM) {
      return true;
    }
  }
  return false;
}

function buildManholesAndCracksGeometry(world, waterPuddles, sandZones, cobbleZones) {
  const rawRoads =
    Array.isArray(world?.drivingRoads) && world.drivingRoads.length > 0
      ? world.drivingRoads
      : Array.isArray(world?.roads)
        ? world.roads
        : [];
  const candidateRoads = rawRoads.filter(
    (r) => r && !r.parkingBay && !r.supportApron && (r.width ?? 0) >= 6.0,
  );
  if (candidateRoads.length === 0) {
    return { geometry: null, manholeCount: 0, manholeCenters: [] };
  }

  const batch = createSurfaceBatch(3);
  const colorTmp = new THREE.Color();
  const rgbOf = (hex, shade = 1) => {
    colorTmp.setHex(hex);
    return {
      r: clamp(colorTmp.r * shade, 0, 1),
      g: clamp(colorTmp.g * shade, 0, 1),
      b: clamp(colorTmp.b * shade, 0, 1),
    };
  };

  const makeTerrainVert = (wx, wz, baseH, rgb) => {
    const wy = baseH + elevAt(world, wx, wz);
    const ex = elevAt(world, wx + 0.35, wz) - elevAt(world, wx - 0.35, wz);
    const ez = elevAt(world, wx, wz + 0.35) - elevAt(world, wx, wz - 0.35);
    const nx = -ex / 0.7;
    const ny = 1;
    const nz = -ez / 0.7;
    const nLen = Math.hypot(nx, ny, nz) || 1;
    return {
      x: wx,
      y: wy,
      z: wz,
      nx: nx / nLen,
      ny: ny / nLen,
      nz: nz / nLen,
      u: 0,
      v: 0,
      r: rgb.r,
      g: rgb.g,
      b: rgb.b,
    };
  };

  const addRibbonSegment = (x0, z0, x1, z1, hw0, hw1, baseH, rgb0, rgb1 = rgb0) => {
    const dx = x1 - x0;
    const dz = z1 - z0;
    const len = Math.hypot(dx, dz);
    if (len < 1e-4) return;
    const rx = dz / len;
    const rz = -dx / len;
    const p0L = makeTerrainVert(x0 - rx * hw0, z0 - rz * hw0, baseH, rgb0);
    const p0R = makeTerrainVert(x0 + rx * hw0, z0 + rz * hw0, baseH, rgb0);
    const p1L = makeTerrainVert(x1 - rx * hw1, z1 - rz * hw1, baseH, rgb1);
    const p1R = makeTerrainVert(x1 + rx * hw1, z1 + rz * hw1, baseH, rgb1);
    batch.addTri(p0L, p1L, p1R);
    batch.addTri(p0L, p1R, p0R);
  };

  const addManholeDisc = (cx, cz, yaw, tone) => {
    const sides = 12;
    const concreteCol = rgbOf(0x4b4943, tone);
    const rimCol = rgbOf(0x1b1e20, tone);
    const grooveCol = rgbOf(0x121517, 1);
    const coverCol = rgbOf(0x2b3034, tone);
    const ribCol = rgbOf(0x3a4045, tone);

    const buildRing = (radius, baseH, col) => {
      const ring = [];
      for (let s = 0; s <= sides; s++) {
        const ang = yaw + ((s % sides) * TAU) / sides;
        ring.push(
          makeTerrainVert(cx + Math.sin(ang) * radius, cz + Math.cos(ang) * radius, baseH, col),
        );
      }
      return ring;
    };

    const stitchRing = (innerR, outerR) => {
      for (let s = 0; s < sides; s++) {
        const a0 = innerR[s];
        const a1 = innerR[s + 1];
        const b0 = outerR[s];
        const b1 = outerR[s + 1];
        batch.addTri(a0, b0, b1);
        batch.addTri(a0, b1, a1);
      }
    };

    // 1. Weathered concrete seating ring (r = 0.35 .. 0.44 m)
    const seatOuter = buildRing(0.44, MANHOLE_BASE_Y, concreteCol);
    const seatInner = buildRing(0.35, MANHOLE_BASE_Y + 0.0010, concreteCol);
    stitchRing(seatInner, seatOuter);

    // 2. Dark cast-iron outer frame rim (r = 0.305 .. 0.35 m)
    const rimOuter = buildRing(0.35, MANHOLE_BASE_Y + 0.0012, rimCol);
    const rimInner = buildRing(0.305, MANHOLE_BASE_Y + 0.0028, rimCol);
    stitchRing(rimInner, rimOuter);

    // 3. Recessed shadow gap around lid (r = 0.288 .. 0.305 m)
    const gapOuter = buildRing(0.305, MANHOLE_BASE_Y + 0.0006, grooveCol);
    const gapInner = buildRing(0.288, MANHOLE_BASE_Y + 0.0006, grooveCol);
    stitchRing(gapInner, gapOuter);

    // 4. Slightly raised dark cast-iron cover disc (r = 0 .. 0.288 m)
    const coverCenter = makeTerrainVert(cx, cz, MANHOLE_BASE_Y + 0.0036, coverCol);
    const coverOuter = buildRing(0.288, MANHOLE_BASE_Y + 0.0032, coverCol);
    for (let s = 0; s < sides; s++) {
      batch.addTri(coverCenter, coverOuter[s], coverOuter[s + 1]);
    }

    // 5. Inner concentric waffle rib ring + cross ribs (0x3a4045)
    const ribInner = buildRing(0.148, MANHOLE_BASE_Y + 0.0042, ribCol);
    const ribOuter = buildRing(0.188, MANHOLE_BASE_Y + 0.0042, ribCol);
    stitchRing(ribInner, ribOuter);

    for (let k = 0; k < 2; k++) {
      const a = yaw + k * (Math.PI * 0.5);
      const sx = Math.sin(a) * 0.265;
      const sz = Math.cos(a) * 0.265;
      addRibbonSegment(cx - sx, cz - sz, cx + sx, cz + sz, 0.019, 0.019, MANHOLE_BASE_Y + 0.0043, ribCol);
    }
  };

  const manholeCenters = [];
  const inWaterOrSand = (x, z, marginM) =>
    pointInZoneList(x, z, waterPuddles, marginM) || pointInZoneList(x, z, sandZones, marginM);

  // Pass A: Deterministic 3D Cast-Iron Manhole Covers (>= 40 across Grand Metro v5)
  for (let rIdx = 0; rIdx < candidateRoads.length; rIdx++) {
    const road = candidateRoads[rIdx];
    const frame = roadFrame(road);
    if (frame.length < 28) continue;
    const startOffset = 15 + (rIdx % 3) * 9;
    let slot = 0;
    for (let along = frame.minAlong + startOffset; along <= frame.maxAlong - 14; along += MANHOLE_SPACING_M) {
      const side = ((slot + rIdx) & 1) === 0 ? 1 : -1;
      const baseLat = clamp(road.width * 0.19, 1.0, 2.35);
      const lat = side * baseLat + (hash2D(slot, rIdx, 0x3177) - 0.5) * 0.34;
      const pt = roadPointAt(road, along, lat);
      const yaw = hash2D(slot, rIdx, 0x4288) * TAU;
      const tone = 0.91 + 0.15 * hash2D(slot, rIdx, 0x5399);
      slot++;

      if (inWaterOrSand(pt.x, pt.z, 0.85)) continue;

      let tooClose = false;
      for (let m = 0; m < manholeCenters.length; m++) {
        const prev = manholeCenters[m];
        if (Math.hypot(pt.x - prev.x, pt.z - prev.z) < 11.0) {
          tooClose = true;
          break;
        }
      }
      if (tooClose) continue;

      manholeCenters.push({ x: pt.x, z: pt.z });
      addManholeDisc(pt.x, pt.z, yaw, tone);
    }
  }

  // Pass B: Dark Glossy Asphalt Tar Crack Snakes (0x15181b)
  const tarRgb = rgbOf(0x15181b, 1.0);
  const tarTipRgb = rgbOf(0x1b1f23, 1.0);
  for (let rIdx = 0; rIdx < candidateRoads.length; rIdx++) {
    const road = candidateRoads[rIdx];
    const frame = roadFrame(road);
    if (frame.length < 30) continue;
    const startOffset = 23 + (rIdx % 4) * 7;
    let slot = 0;
    for (let along = frame.minAlong + startOffset; along <= frame.maxAlong - 15; along += TAR_CRACK_SPACING_M) {
      const roll = hash2D(slot, rIdx, 0x61a3);
      const latFrac = (hash2D(slot, rIdx, 0x62b4) - 0.5) * 0.66;
      const angleJitter = (hash2D(slot, rIdx, 0x63c5) - 0.5) * 1.85;
      const crackLen = 2.8 + 2.4 * hash2D(slot, rIdx, 0x64d6);
      slot++;
      if (roll > 0.74) continue;

      const anchor = roadPointAt(road, along, latFrac * road.width);
      if (
        inWaterOrSand(anchor.x, anchor.z, 1.4) ||
        pointInZoneList(anchor.x, anchor.z, cobbleZones, 0.8)
      ) {
        continue;
      }

      const dirAngle = frame.heading + angleJitter;
      const ux = Math.sin(dirAngle);
      const uz = Math.cos(dirAngle);
      const px = uz;
      const pz = -ux;
      const segs = 5;
      const pts = [];
      for (let s = 0; s <= segs; s++) {
        const t = s / segs - 0.5;
        const jag =
          s === 0 || s === segs
            ? 0
            : (hash2D(slot * 13 + s, rIdx, 0x65e7) - 0.5) * 0.42;
        const wx = anchor.x + ux * (t * crackLen) + px * jag;
        const wz = anchor.z + uz * (t * crackLen) + pz * jag;
        pts.push({ x: wx, z: wz });
      }
      for (let s = 0; s < segs; s++) {
        const hw0 = s === 0 ? 0.008 : s === 1 || s === segs - 1 ? 0.024 : 0.032;
        const hw1 = s + 1 === segs ? 0.008 : s + 1 === 1 || s + 1 === segs - 1 ? 0.024 : 0.032;
        addRibbonSegment(
          pts[s].x,
          pts[s].z,
          pts[s + 1].x,
          pts[s + 1].z,
          hw0,
          hw1,
          MANHOLE_BASE_Y,
          s === 0 ? tarTipRgb : tarRgb,
          s + 1 === segs ? tarTipRgb : tarRgb,
        );
      }

      // Secondary fork branch on half of crack veins
      if (roll < 0.36) {
        const mid = pts[2];
        const forkAng = dirAngle + (roll < 0.18 ? 0.78 : -0.78);
        const fx = mid.x + Math.sin(forkAng) * 1.15;
        const fz = mid.z + Math.cos(forkAng) * 1.15;
        addRibbonSegment(mid.x, mid.z, fx, fz, 0.022, 0.006, MANHOLE_BASE_Y, tarRgb, tarTipRgb);
      }
    }
  }

  // Pass C: Subtle Twin Dark Rubber Braking Tire-Skid Marks (0x181b1e) Approaching Junctions
  const skidCoreRgb = rgbOf(0x181b1e, 1.0);
  const skidFadeRgb = rgbOf(0x23272b, 1.0);
  const placedSkids = [];
  for (let i = 0; i < candidateRoads.length; i++) {
    const road = candidateRoads[i];
    if ((road.width ?? 0) < 8.5) continue;
    const frame = roadFrame(road);
    for (let j = 0; j < candidateRoads.length; j++) {
      if (i === j) continue;
      const other = candidateRoads[j];
      const inter = roadIntersection(road, other, 0.5);
      if (!inter) continue;

      for (const dirSign of [-1, 1]) {
        const pick = hash2D(i * 7 + (dirSign > 0 ? 1 : 0), j, 0x77d1);
        if (pick > 0.52) continue;

        const skidLen = 4.6 + 2.0 * hash2D(i, j * 3 + (dirSign > 0 ? 2 : 1), 0x78e2);
        const centerAlong = inter.alongA + dirSign * ((other.width ?? 8) * 0.5 + 6.2 + skidLen * 0.5);
        if (centerAlong - skidLen * 0.5 < frame.minAlong + 8 || centerAlong + skidLen * 0.5 > frame.maxAlong - 8) {
          continue;
        }

        const laneMag = road.laneOffsetM || road.width * 0.22;
        const laneLat = -dirSign * laneMag;
        const midPt = roadPointAt(road, centerAlong, laneLat);
        if (
          pointWithinRoadEnvelope(midPt.x, midPt.z, other, 1.5, 1.5) ||
          inWaterOrSand(midPt.x, midPt.z, 2.4) ||
          pointInZoneList(midPt.x, midPt.z, cobbleZones, 2.0)
        ) {
          continue;
        }

        let dup = false;
        for (let k = 0; k < placedSkids.length; k++) {
          if (Math.hypot(midPt.x - placedSkids[k].x, midPt.z - placedSkids[k].z) < 9.5) {
            dup = true;
            break;
          }
        }
        if (dup) continue;
        placedSkids.push(midPt);

        const yawSkew = (hash2D(i, j, 0x79f3) - 0.5) * 0.055;
        const skidHeading = frame.heading + yawSkew;
        const sux = Math.sin(skidHeading);
        const suz = Math.cos(skidHeading);
        const spx = suz;
        const spz = -sux;
        const halfTrack = 0.74;
        const subSegs = 4;

        for (const wheelSide of [-1, 1]) {
          const trackCenterX = midPt.x + spx * (wheelSide * halfTrack);
          const trackCenterZ = midPt.z + spz * (wheelSide * halfTrack);
          for (let s = 0; s < subSegs; s++) {
            const t0 = s / subSegs - 0.5;
            const t1 = (s + 1) / subSegs - 0.5;
            const x0 = trackCenterX + sux * (t0 * skidLen);
            const z0 = trackCenterZ + suz * (t0 * skidLen);
            const x1 = trackCenterX + sux * (t1 * skidLen);
            const z1 = trackCenterZ + suz * (t1 * skidLen);
            const hw0 = s === 0 ? 0.065 : 0.102;
            const hw1 = s + 1 === subSegs ? 0.075 : 0.102;
            const c0 = s === 0 ? skidFadeRgb : skidCoreRgb;
            const c1 = s + 1 === subSegs ? skidFadeRgb : skidCoreRgb;
            addRibbonSegment(x0, z0, x1, z1, hw0, hw1, SKID_BASE_Y, c0, c1);
          }
        }
      }
    }
  }

  return {
    geometry: batch.build(),
    manholeCount: manholeCenters.length,
    manholeCenters,
  };
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
      const a = cx - w / 2;
      const b = cx + w / 2;
      const c = cy - h / 2;
      const d = cy + h / 2;
      const e = cz - l / 2;
      const g = cz + l / 2;
      const p = [
        [a, c, e], [b, c, e], [b, c, g], [a, c, g],
        [a, d, e], [b, d, e], [b, d, g], [a, d, g],
      ];
      for (const idx of [
        [0, 1, 2, 3],
        [4, 7, 6, 5],
        [0, 4, 5, 1],
        [1, 5, 6, 2],
        [2, 6, 7, 3],
        [3, 7, 4, 0],
      ]) {
        this.face(idx.map((k) => p[k]), hex);
      }
    },
    frustumY(cx, cz, y0, y1, r0, r1, sides, hex, yawOffset = 0) {
      for (let i = 0; i < sides; i++) {
        const a0 = yawOffset + (i * TAU) / sides;
        const a1 = yawOffset + ((i + 1) * TAU) / sides;
        const s0 = Math.sin(a0);
        const c0 = Math.cos(a0);
        const s1 = Math.sin(a1);
        const c1 = Math.cos(a1);
        const p00 = [cx + s0 * r0, y0, cz + c0 * r0];
        const p10 = [cx + s1 * r0, y0, cz + c1 * r0];
        const p11 = [cx + s1 * r1, y1, cz + c1 * r1];
        const p01 = [cx + s0 * r1, y1, cz + c0 * r1];
        this.face([p00, p10, p11, p01], hex);
        if (r1 > 0.005) {
          this.face([[cx, y1, cz], p01, p11], hex);
        }
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

function createStreetLampPoleGeometry() {
  const f = partFacets();
  // Cast-iron Khedivial octagonal pedestal + brass collar + tapered shaft (~6.2 m)
  f.frustumY(0, 0, 0.0, 0.22, 0.22, 0.19, 8, 0x262b2d);
  f.frustumY(0, 0, 0.22, 0.68, 0.17, 0.13, 8, 0x2e3437);
  f.frustumY(0, 0, 0.68, 0.78, 0.145, 0.12, 8, 0x7c6d4d);
  f.frustumY(0, 0, 0.78, 3.40, 0.105, 0.078, 6, 0x31383b);
  f.frustumY(0, 0, 3.40, 5.55, 0.078, 0.056, 6, 0x31383b);
  f.frustumY(0, 0, 5.55, 6.22, 0.068, 0.022, 6, 0x7c6d4d);

  // Curved twin overhead luminaire arms branching along the boulevard (+Z / -Z)
  for (const dir of [-1, 1]) {
    f.box(0, 5.48, dir * 0.20, 0.06, 0.08, 0.36, 0x2b3134);
    f.box(0, 5.74, dir * 0.48, 0.055, 0.38, 0.30, 0x2b3134);
    f.box(0, 6.02, dir * 0.74, 0.055, 0.07, 0.34, 0x2b3134);
    // Decorative scroll brace
    f.box(0, 5.32, dir * 0.32, 0.04, 0.26, 0.24, 0x6c5f44);
    // Lantern roof hood
    f.frustumY(0, dir * 0.84, 5.96, 6.10, 0.19, 0.05, 6, 0x24292b);
  }
  return f.build();
}

function createStreetLampHeadsGeometry() {
  const f = partFacets();
  for (const dir of [-1, 1]) {
    f.frustumY(0, dir * 0.84, 5.66, 5.96, 0.11, 0.17, 6, 0xfff3d6);
    f.frustumY(0, dir * 0.84, 5.58, 5.66, 0.05, 0.11, 6, 0xffdf9e);
  }
  return f.build();
}

function createStreetTreeTrunkGeometry() {
  const f = partFacets();
  // Weathered Cairo limestone curb collar (0x7d7566, 1.12 x 1.12 m outer framing 1.04 x 1.04 m grate)
  const collarOuter = 1.12;
  const collarBeam = 0.06;
  const collarOffset = (collarOuter - collarBeam) * 0.5;
  f.box(0, 0.045, -collarOffset, collarOuter, 0.09, collarBeam, 0x7d7566);
  f.box(0, 0.045, collarOffset, collarOuter, 0.09, collarBeam, 0x7d7566);
  f.box(-collarOffset, 0.045, 0, collarBeam, 0.09, collarOuter - collarBeam * 2, 0x7d7566);
  f.box(collarOffset, 0.045, 0, collarBeam, 0.09, collarOuter - collarBeam * 2, 0x7d7566);

  // Recessed dark moist soil bed (0x261f18) beneath slotted grate
  f.box(0, 0.028, 0, 1.02, 0.056, 1.02, 0x261f18);

  // Slotted dark cast-iron sidewalk tree grate (1.04 x 1.04 m, 0x25292b)
  const grateSpan = 1.04;
  const barH = 0.022;
  const barY = 0.068;
  for (const pos of [-0.48, -0.34, -0.21, 0.21, 0.34, 0.48]) {
    f.box(0, barY, pos, grateSpan, barH, 0.036, 0x25292b);
    f.box(pos, barY, 0, 0.036, barH, grateSpan, 0x25292b);
  }
  // Inner cast-iron trunk guard ring
  f.frustumY(0, 0, 0.056, 0.088, 0.245, 0.235, 8, 0x25292b);

  // Fluted Cairo ficus / date-palm trunk rings in dusty muted bark tones
  const ringHeights = [0.06, 0.85, 1.60, 2.35, 3.10, 3.80, 4.35];
  const ringRadii = [0.205, 0.175, 0.155, 0.142, 0.132, 0.125, 0.15];
  for (let i = 0; i < ringHeights.length - 1; i++) {
    const hex = i % 2 === 0 ? 0x564333 : 0x473729;
    f.frustumY(0, 0, ringHeights[i], ringHeights[i + 1], ringRadii[i], ringRadii[i + 1], 7, hex, i * 0.22);
  }
  return f.build();
}

function createStreetTreeCanopyGeometry() {
  const f = partFacets();
  // Muted warm date clusters tucked beneath crown (0x8f6628)
  for (let i = 0; i < 4; i++) {
    const a = (i * TAU) / 4 + 0.4;
    f.frustumY(Math.sin(a) * 0.24, Math.cos(a) * 0.24, 3.92, 4.18, 0.09, 0.05, 5, 0x8f6628);
  }
  // Muted, dusty, cinematic Cairo olive/ficus crown tiers (within 1.24 m radius)
  f.frustumY(0, 0, 4.05, 4.65, 0.92, 1.18, 8, 0x2b3825, 0.15);
  f.frustumY(0, 0, 4.55, 5.18, 1.12, 0.82, 8, 0x34432d, 0.54);
  f.frustumY(0, 0, 5.08, 5.52, 0.72, 0.22, 7, 0x3e4f36, 0.28);

  const frondCount = 8;
  for (let i = 0; i < frondCount; i++) {
    const a = (i * TAU) / frondCount;
    const s = Math.sin(a);
    const c = Math.cos(a);
    const nx = c * 0.16;
    const nz = -s * 0.16;
    const base = [s * 0.18, 4.48, c * 0.18];
    const midL = [s * 0.76 - nx, 4.74, c * 0.76 - nz];
    const midR = [s * 0.76 + nx, 4.74, c * 0.76 + nz];
    const tip = [s * 1.22, 4.24, c * 1.22];
    const tone = i % 2 === 0 ? 0x31402b : 0x384931;
    f.face([base, midL, tip, midR], tone);
    f.face([base, midR, tip, midL], 0x253120);
  }
  return f.build();
}

function createStreetFurnitureGeometry() {
  const f = partFacets();
  // 1. Weathered muted traffic-ochre & charcoal Egyptian concrete bollard (-0.22, -0.34)
  const bx = -0.22;
  const bz = -0.34;
  const stripeY = [0.0, 0.16, 0.32, 0.48, 0.64, 0.80];
  for (let i = 0; i < stripeY.length - 1; i++) {
    const r0 = lerp(0.125, 0.105, i / 5);
    const r1 = lerp(0.125, 0.105, (i + 1) / 5);
    const hex = i % 2 === 0 ? 0x222629 : 0xa8842c;
    f.frustumY(bx, bz, stripeY[i], stripeY[i + 1], r0, r1, 8, hex);
  }
  f.frustumY(bx, bz, 0.80, 0.87, 0.105, 0.03, 8, 0x222629);

  // 2. Cairo sidewalk cafe bistro table + muted burgundy & aged-canvas parasol (+0.11, -0.04)
  const tx = 0.11;
  const tz = -0.04;
  f.frustumY(tx, tz, 0.0, 0.05, 0.17, 0.14, 6, 0x262b2d);
  f.frustumY(tx, tz, 0.05, 0.72, 0.032, 0.028, 6, 0x262b2d);
  f.frustumY(tx, tz, 0.72, 0.76, 0.29, 0.30, 8, 0xbab2a0);
  f.frustumY(tx, tz, 0.76, 2.04, 0.022, 0.020, 6, 0x5c503c);
  const parasolSides = 8;
  for (let i = 0; i < parasolSides; i++) {
    const a0 = (i * TAU) / parasolSides;
    const a1 = ((i + 1) * TAU) / parasolSides;
    const rOuter = 0.42;
    const pTop = [tx, 2.24, tz];
    const p0 = [tx + Math.sin(a0) * rOuter, 1.96, tz + Math.cos(a0) * rOuter];
    const p1 = [tx + Math.sin(a1) * rOuter, 1.96, tz + Math.cos(a1) * rOuter];
    const goreHex = i % 2 === 0 ? 0x783228 : 0xb5ab98;
    f.face([pTop, p0, p1], goreHex);
    f.face([pTop, p1, p0], 0x54231c);
  }

  // 3. Municipal sidewalk waste bin (+0.18, +0.38)
  const mx = 0.18;
  const mz = 0.38;
  f.frustumY(mx, mz, 0.0, 0.08, 0.13, 0.14, 7, 0x242827);
  f.frustumY(mx, mz, 0.08, 0.64, 0.142, 0.155, 7, 0x2e3d33);
  f.frustumY(mx, mz, 0.64, 0.69, 0.162, 0.158, 7, 0x7f6c43);
  f.frustumY(mx, mz, 0.69, 0.78, 0.15, 0.07, 7, 0x25322a);

  // 4. Egyptian roadside electrical/telecom feeder pillar (0.36 x 0.96 x 0.24 m, 0x565b5e / 0x363b3e / 0x9e7b32)
  const cx = -0.32;
  const cz = 0.30;
  // Dark concrete/iron plinth (y = 0 .. 0.12)
  f.box(cx, 0.06, cz, 0.25, 0.12, 0.37, 0x363b3e);
  // Weathered grey-steel cabinet body (0.24 x 0.80 x 0.36 m, y = 0.12 .. 0.92)
  f.box(cx, 0.52, cz, 0.24, 0.80, 0.36, 0x565b5e);
  // Overhanging rain-drip cap (y = 0.92 .. 0.96 -> total height 0.96 m)
  f.box(cx, 0.94, cz, 0.26, 0.04, 0.38, 0x454a4d);
  // Twin cabinet door center seam + louvered cooling vent slats (0x363b3e)
  f.box(cx + 0.123, 0.52, cz, 0.01, 0.72, 0.018, 0x363b3e);
  for (const vy of [0.24, 0.29, 0.34, 0.76, 0.81]) {
    f.box(cx + 0.123, vy, cz - 0.085, 0.012, 0.022, 0.12, 0x363b3e);
    f.box(cx + 0.123, vy, cz + 0.085, 0.012, 0.022, 0.12, 0x363b3e);
  }
  // Subtle faded high-voltage warning badge (0x9e7b32)
  f.box(cx + 0.124, 0.58, cz - 0.085, 0.012, 0.065, 0.065, 0x9e7b32);

  return f.build();
}

function orientedRoadEnvelope(road, extraMargin = 0) {
  if (isDiagonalRoad(road)) {
    const frame = roadFrame(road);
    return {
      x: (frame.x1 + frame.x2) * 0.5,
      z: (frame.z1 + frame.z2) * 0.5,
      width: road.width + extraMargin * 2,
      length: frame.length + road.width + extraMargin * 2,
      heading: frame.heading,
      roadRef: road,
    };
  }
  const r = roadRect(road, -extraMargin);
  return {
    x: (r.minX + r.maxX) * 0.5,
    z: (r.minZ + r.maxZ) * 0.5,
    width: r.maxX - r.minX,
    length: r.maxZ - r.minZ,
    heading: 0,
    roadRef: road,
  };
}

function pointWithinRoadEnvelope(x, z, road, extraWidthM = 0, extraEndM = 0) {
  const halfW = (road.width ?? 0) * 0.5 + extraWidthM;
  if (halfW <= 0) return false;
  if (isDiagonalRoad(road)) {
    const frame = roadFrame(road);
    const dx = x - frame.x1;
    const dz = z - frame.z1;
    const along = dx * frame.ux + dz * frame.uz;
    const endAllowance = (road.width ?? 0) * 0.5 + extraEndM;
    if (along < -endAllowance || along > frame.length + endAllowance) return false;
    const lat = Math.abs(-dx * frame.uz + dz * frame.ux);
    return lat <= halfW;
  }
  const endAllowance = (road.width ?? 0) * 0.5 + extraEndM;
  if (road.axis === "z") {
    return (
      Math.abs(x - road.fixed) <= halfW &&
      z >= road.min - endAllowance &&
      z <= road.max + endAllowance
    );
  }
  return (
    Math.abs(z - road.fixed) <= halfW &&
    x >= road.min - endAllowance &&
    x <= road.max + endAllowance
  );
}

function collectStreetPropPlacements(world) {
  const allRoads = Array.isArray(world?.roads)
    ? world.roads
    : (Array.isArray(world?.drivingRoads) ? world.drivingRoads : []);
  if (allRoads.length === 0) {
    return { lamps: [], trees: [], furniture: [] };
  }

  const statics = (world?.statics ?? []).map((s) => ({
    x: s.x ?? 0,
    z: s.z ?? 0,
    width: s.width ?? 2,
    length: s.length ?? 2,
    heading: s.heading ?? 0,
    kind: s.kind ?? "static",
  }));
  const staticIndex = new SpatialIndex(statics, 40);
  const maxStaticReach = statics.reduce(
    (m, s) => Math.max(m, Math.hypot(s.width, s.length) * 0.5),
    24,
  );

  const roadEnvelopes = allRoads.map((r) => orientedRoadEnvelope(r, 0));
  const roadIndex = new SpatialIndex(roadEnvelopes, 64);
  const maxRoadReach = roadEnvelopes.reduce(
    (m, r) => Math.max(m, Math.hypot(r.width, r.length) * 0.5),
    60,
  );

  const crosswalkPoints = [];
  for (const w of world?.walkways ?? []) {
    if (!w || (!w.crosswalk && !w.doorway)) continue;
    if (isDiagonalRoad(w)) {
      const f = roadFrame(w);
      crosswalkPoints.push(
        { x: f.x1, z: f.z1 },
        { x: (f.x1 + f.x2) * 0.5, z: (f.z1 + f.z2) * 0.5 },
        { x: f.x2, z: f.z2 },
      );
    } else if (w.axis === "z") {
      crosswalkPoints.push(
        { x: w.fixed, z: w.min },
        { x: w.fixed, z: (w.min + w.max) * 0.5 },
        { x: w.fixed, z: w.max },
      );
    } else {
      crosswalkPoints.push(
        { x: w.min, z: w.fixed },
        { x: (w.min + w.max) * 0.5, z: w.fixed },
        { x: w.max, z: w.fixed },
      );
    }
  }

  const placedIndex = new SpatialIndex([], 16);
  const lamps = [];
  const trees = [];
  const furniture = [];

  const canPlaceProp = (
    parentRoad,
    x,
    z,
    heading,
    groundHalfM,
    maxRadialM,
    minOtherRoadClearM,
    minPropGapM,
  ) => {
    const radialReach = Math.max(groundHalfM * Math.SQRT2, maxRadialM);
    const probe = { x, z, width: radialReach * 2, length: radialReach * 2, heading };

    // 1. Strictly clear of EVERY road carriageway (road.width / 2) and intersections
    const nearRoads = roadIndex.near(probe, maxRoadReach + radialReach + 8);
    for (let i = 0; i < nearRoads.length; i++) {
      const env = nearRoads[i];
      const r = env.roadRef;
      if (overlaps(probe, env, 0.12)) return false;
      if (r === parentRoad) {
        if (pointWithinRoadEnvelope(x, z, r, radialReach + 0.08, 0)) return false;
      } else {
        const extraClear = r.parkingBay || r.supportApron
          ? Math.max(3.2, radialReach + 0.5)
          : Math.max(minOtherRoadClearM, radialReach + 0.5);
        if (pointWithinRoadEnvelope(x, z, r, extraClear, extraClear)) return false;
      }
    }

    // 2. Strictly clear of EVERY world.statics footprint (buildings, parked-vehicle, market-stall)
    const nearStatics = staticIndex.near(probe, maxStaticReach + radialReach + 2);
    for (let i = 0; i < nearStatics.length; i++) {
      if (overlaps(probe, nearStatics[i], 0.25)) return false;
    }

    // 3. Keep crosswalk mouths unobstructed
    for (let i = 0; i < crosswalkPoints.length; i++) {
      const cw = crosswalkPoints[i];
      if (Math.hypot(x - cw.x, z - cw.z) < 3.4) return false;
    }

    // 4. Keep props spaced cleanly apart from one another
    const nearPlaced = placedIndex.near(probe, minPropGapM + 1);
    for (let i = 0; i < nearPlaced.length; i++) {
      const p = nearPlaced[i];
      if (Math.hypot(x - p.x, z - p.z) < minPropGapM) return false;
    }

    return true;
  };

  const candidateRoads = allRoads.filter(
    (r) => r && !r.parkingBay && !r.supportApron && (r.width ?? 0) >= 6.0,
  );

  // Pass 1: Cairo Boulevard Street Lamps (~44 m spacing along avenues / primary streets)
  for (let rIdx = 0; rIdx < candidateRoads.length; rIdx++) {
    const road = candidateRoads[rIdx];
    const isAvenue = road.zone === "avenue" || (!road.sideStreet && road.width >= 9.5);
    if (!isAvenue) continue;
    const frame = roadFrame(road);
    if (frame.length < 28) continue;
    const offset = road.width * 0.5 + PROP_SIDEWALK_OFFSET_M;

    for (const side of [-1, 1]) {
      const startOffset = side > 0 ? 16 : 38;
      for (let along = frame.minAlong + startOffset; along <= frame.maxAlong - 14; along += LAMP_SPACING_M) {
        const pt = roadPointAt(road, along, side * offset);
        const heading = frame.heading + (side < 0 ? Math.PI : 0);
        if (!canPlaceProp(road, pt.x, pt.z, heading, 0.25, 0.35, 4.2, 4.2)) continue;
        const entry = {
          x: pt.x,
          y: SIDEWALK_PROP_Y + elevAt(world, pt.x, pt.z),
          z: pt.z,
          heading,
          scale: 1,
        };
        lamps.push(entry);
        placedIndex.add(entry);
      }
    }
  }

  // Pass 2: Street Trees & Cairo Date Palms (~38 m spacing along sidewalks)
  for (let rIdx = 0; rIdx < candidateRoads.length; rIdx++) {
    const road = candidateRoads[rIdx];
    const frame = roadFrame(road);
    if (frame.length < 30) continue;
    const offset = road.width * 0.5 + PROP_SIDEWALK_OFFSET_M;

    for (const side of [-1, 1]) {
      const startOffset = side > 0 ? 27 : 20;
      let slot = 0;
      for (let along = frame.minAlong + startOffset; along <= frame.maxAlong - 15; along += TREE_SPACING_M) {
        const pt = roadPointAt(road, along, side * offset);
        const heading = frame.heading + (side < 0 ? Math.PI : 0);
        const scale = 0.88 + 0.16 * hash2D(slot, rIdx, 0x8123);
        slot++;
        // Stone curb aligns with sidewalk; canopy radius <= 1.22 * 1.04 = 1.27 m < 1.55 m offset
        if (!canPlaceProp(road, pt.x, pt.z, heading, 0.46 * scale, 1.24 * scale, 4.5, 4.8)) continue;
        const entry = {
          x: pt.x,
          y: SIDEWALK_PROP_Y + elevAt(world, pt.x, pt.z),
          z: pt.z,
          heading,
          scale,
        };
        trees.push(entry);
        placedIndex.add(entry);
      }
    }
  }

  // Pass 3: Sidewalk Street Furniture (bollards, cafe tables/parasols & bins clear of walk centerlines)
  for (let rIdx = 0; rIdx < candidateRoads.length; rIdx++) {
    const road = candidateRoads[rIdx];
    const frame = roadFrame(road);
    if (frame.length < 32) continue;
    const offset = road.width * 0.5 + FURNITURE_SIDEWALK_OFFSET_M;

    for (const side of [-1, 1]) {
      const startOffset = side > 0 ? 21 : 33;
      for (let along = frame.minAlong + startOffset; along <= frame.maxAlong - 16; along += FURNITURE_SPACING_M) {
        const pt = roadPointAt(road, along, side * offset);
        const heading = frame.heading + (side > 0 ? 0 : Math.PI);
        if (!canPlaceProp(road, pt.x, pt.z, heading, 0.50, 0.58, 4.5, 4.4)) continue;
        const entry = {
          x: pt.x,
          y: SIDEWALK_PROP_Y + elevAt(world, pt.x, pt.z),
          z: pt.z,
          heading,
          scale: 1,
        };
        furniture.push(entry);
        placedIndex.add(entry);
      }
    }
  }

  return { lamps, trees, furniture };
}

export function resolveZoneSurfaceAt(terrain, x, z) {
  if (!terrain || !Number.isFinite(x) || !Number.isFinite(z)) return "asphalt";
  // Share exact organic puddle & shaped-zone contours with driving physics!
  if (pointInWaterPuddleList(x, z, terrain.waterPuddles, 0)) return "water";
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

function resolveActorSurfaceKind(actor, world) {
  if (!actor) return "asphalt";
  const s0 = actor.surfaceKind;
  if (typeof s0 === "string" && s0.length > 0) return s0;
  const veh = actor.vehicle;
  const s1 = veh?.surfaceKind;
  if (typeof s1 === "string" && s1.length > 0) return s1;
  const surf = actor.surface;
  const s2 = surf?.surfaceKind;
  if (typeof s2 === "string" && s2.length > 0) return s2;
  const s3 = surf?.kind;
  if (typeof s3 === "string" && s3.length > 0) return s3;
  const vsurf = veh?.surface;
  const s4 = vsurf?.surfaceKind;
  if (typeof s4 === "string" && s4.length > 0) return s4;
  const s5 = vsurf?.kind;
  if (typeof s5 === "string" && s5.length > 0) return s5;
  return resolveZoneSurfaceAt(world?.terrain, actor.x, actor.z);
}

function resolveActorSpeed(actor) {
  if (Number.isFinite(actor?.speed)) return actor.speed;
  if (Number.isFinite(actor?.vehicle?.speed)) return actor.vehicle.speed;
  if (Number.isFinite(actor?.vx) && Number.isFinite(actor?.vz)) {
    return Math.hypot(actor.vx, actor.vz);
  }
  return 0;
}

function actorWheelBaseElevation(actor, world, wx, wz) {
  const terrainElev = elevAt(world, wx, wz);
  const actorY = Number.isFinite(actor?.y) && actor.y > 0 ? actor.y : 0;
  return typeof world?.terrainElevationAt === "function"
    ? Math.max(terrainElev, actorY)
    : actorY;
}

function attachFresnelPuddleShader(material) {
  const uniforms = {
    uWaveTime: { value: 0 },
    uPuddleLive: { value: 0 },
    tPuddleReflection: { value: null },
    uPuddleTextureMatrix: { value: new THREE.Matrix4() },
    uPuddleCaptureTexel: { value: new THREE.Vector2() },
    uPuddlePlaneHeight: { value: 0 },
  };
  material.customProgramCacheKey = () => "fresnel-puddle-live-v2";
  material.userData.uWaveTime = uniforms.uWaveTime;
  material.userData.uniforms = uniforms;
  material.userData.hasFresnelWaterShader = true;

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        "#include <common>\nvarying vec3 vPuddleWorldPosition;\nvarying float vPuddleCamDist;",
      )
      .replace(
        "#include <project_vertex>",
        "#include <project_vertex>\nvPuddleWorldPosition = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;\nvPuddleCamDist = length( mvPosition.xyz );",
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
        uniform float uWaveTime;
        uniform float uPuddleLive;
        uniform sampler2D tPuddleReflection;
        uniform mat4 uPuddleTextureMatrix;
        uniform vec2 uPuddleCaptureTexel;
        uniform float uPuddlePlaneHeight;
        varying vec3 vPuddleWorldPosition;
        varying float vPuddleCamDist;`,
      )
      .replace(
        "#include <normal_fragment_maps>",
        `#include <normal_fragment_maps>
        vec2 wWaveA = vPuddleWorldPosition.xz * 1.55 + vec2( uWaveTime * 0.24, uWaveTime * 0.16 );
        vec2 wWaveB = vPuddleWorldPosition.xz * 2.65 + vec2( -uWaveTime * 0.19, uWaveTime * 0.22 );
        float microDx = sin( wWaveA.x * 6.2831853 + cos( wWaveA.y * 4.712389 ) ) * 0.022
                      + cos( wWaveB.x * 6.2831853 - sin( wWaveB.y * 5.497787 ) ) * 0.017;
        float microDz = cos( wWaveA.y * 6.2831853 - sin( wWaveA.x * 4.712389 ) ) * 0.022
                      + sin( wWaveB.y * 6.2831853 + cos( wWaveB.x * 5.497787 ) ) * 0.017;
        normal = normalize( normal + mat3( viewMatrix ) * vec3( microDx, 0.0, microDz ) );`,
      )
      .replace(
        "#include <output_fragment>",
        `float puddleEdgeMask = clamp( diffuseColor.a / max( opacity, 0.001 ), 0.0, 1.0 );
        vec3 puddleViewDir = normalize( geometry.viewDir );
        float puddleNdotV = clamp( dot( normalize( geometry.normal ), puddleViewDir ), 0.0, 1.0 );
        float waveNdotV = clamp( dot( normalize( normal ), puddleViewDir ), 0.0, 1.0 );
        float puddleFresnel = 0.045 + 0.955 * pow( 1.0 - puddleNdotV, 5.0 );
        float nearSheenMask = 1.0 - smoothstep( 18.0, 58.0, vPuddleCamDist );
        float waveCrest = clamp( 0.48 + ( puddleNdotV - waveNdotV ) * 18.0, 0.0, 1.0 );
        // Natural dusk slate-sky radiance multiplied by physical Schlick Fresnel F(NdotV) over wet dark asphalt
        vec3 skyZenithHdr = mix( vec3( 0.20, 0.24, 0.29 ), vec3( 0.39, 0.45, 0.52 ), waveCrest );
        vec3 deepRainwaterAbsorption = vec3( 0.0080, 0.0100, 0.0130 );
        vec3 absorbedBed = mix( deepRainwaterAbsorption, totalDiffuse * 0.14, 0.22 ) * ( 1.0 - 0.78 * puddleFresnel );
        vec3 clampedEnvSpec = min( totalSpecular * mix( 0.32, 1.0, puddleFresnel ), vec3( 0.20, 0.23, 0.27 ) ) * mix( 0.22, 1.0, nearSheenMask );
        vec3 twilightFresnelTint = skyZenithHdr * puddleFresnel * mix( 0.20, 1.0, nearSheenMask );
        vec3 reflection = clampedEnvSpec + twilightFresnelTint;
        if ( uPuddleLive > 0.5 ) {
          float planeMatch = 1.0 - smoothstep( 0.025, 0.10, abs( vPuddleWorldPosition.y - uPuddlePlaneHeight ) );
          if ( planeMatch * nearSheenMask > 0.001 ) {
            vec3 planePoint = vec3( vPuddleWorldPosition.x, uPuddlePlaneHeight, vPuddleWorldPosition.z );
            vec4 stq = uPuddleTextureMatrix * vec4( planePoint, 1.0 );
            if ( stq.w > 0.0 ) {
              vec2 uv = stq.xy / stq.w + vec2( microDx, microDz ) * 0.12;
              vec2 border = min( uv, vec2( 1.0 ) - uv );
              float captureFade = smoothstep( 0.002, 0.035, min( border.x, border.y ) );
              if ( captureFade > 0.0 ) {
                vec2 tap = uPuddleCaptureTexel * ( 0.6 + 24.0 * roughnessFactor );
                vec3 mirror = texture2D( tPuddleReflection, uv ).rgb * 0.40;
                mirror += texture2D( tPuddleReflection, uv + vec2( tap.x, 0.0 ) ).rgb * 0.15;
                mirror += texture2D( tPuddleReflection, uv - vec2( tap.x, 0.0 ) ).rgb * 0.15;
                mirror += texture2D( tPuddleReflection, uv + vec2( 0.0, tap.y ) ).rgb * 0.15;
                mirror += texture2D( tPuddleReflection, uv - vec2( 0.0, tap.y ) ).rgb * 0.15;
                float waterFresnel = 0.0204 + 0.9796 * pow( 1.0 - waveNdotV, 5.0 );
                reflection = mix( reflection, mirror * waterFresnel + reflectedLight.directSpecular,
                  planeMatch * captureFade * nearSheenMask );
              }
            }
          }
        }
        outgoingLight = absorbedBed + reflection + totalEmissiveRadiance;
        diffuseColor.a = mix( 0.56, 0.88, puddleFresnel ) * puddleEdgeMask;
        #include <output_fragment>`,
      );
  };

  return uniforms;
}

function attachInstancedAlphaShader(material, cacheKey) {
  material.customProgramCacheKey = () => cacheKey;
  material.userData.instancedAlphaAttribute = "aFxAlpha";

  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        "#include <common>\nattribute float aFxAlpha;\nvarying float vFxAlpha;",
      )
      .replace(
        "#include <begin_vertex>",
        "#include <begin_vertex>\nvFxAlpha = aFxAlpha;",
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        "#include <common>\nvarying float vFxAlpha;",
      )
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
        diffuseColor.a *= clamp( vFxAlpha, 0.0, 1.0 );
        if ( diffuseColor.a < 0.003 ) discard;`,
      );
  };

  return material;
}

function createDynamicTrackRingBuffer({
  maxSegments,
  material,
  name,
  renderOrder,
  timedFade = false,
  trackGeo,
  trackMat,
  parentGroup,
}) {
  const vertCount = maxSegments * 6;
  const positions = new Float32Array(vertCount * 3);
  const normals = new Float32Array(vertCount * 3);
  const uvs = new Float32Array(vertCount * 2);
  const colors = new Float32Array(vertCount * 4);

  for (let i = 0; i < vertCount; i++) {
    normals[i * 3 + 1] = 1;
  }

  const geo = new THREE.BufferGeometry();
  const posAttr = new THREE.BufferAttribute(positions, 3);
  const normAttr = new THREE.BufferAttribute(normals, 3);
  const uvAttr = new THREE.BufferAttribute(uvs, 2);
  const colAttr = new THREE.BufferAttribute(colors, 4);
  posAttr.setUsage(THREE.DynamicDrawUsage);
  normAttr.setUsage(THREE.DynamicDrawUsage);
  uvAttr.setUsage(THREE.DynamicDrawUsage);
  colAttr.setUsage(THREE.DynamicDrawUsage);

  geo.setAttribute("position", posAttr);
  geo.setAttribute("normal", normAttr);
  geo.setAttribute("uv", uvAttr);
  geo.setAttribute("color", colAttr);
  geo.setDrawRange(0, 0);

  const mesh = new THREE.Mesh(trackGeo(geo), trackMat(material));
  mesh.name = name;
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  mesh.renderOrder = renderOrder;
  parentGroup.add(mesh);

  const segActive = new Uint8Array(maxSegments);
  const segAgeS = new Float32Array(maxSegments);
  const segMaxAgeS = new Float32Array(maxSegments);
  const segAlpha0 = new Float32Array(maxSegments);
  const segAlpha1 = new Float32Array(maxSegments);
  // Vertex alpha role per quad vertex: [0: p0L, 1: p1L, 2: p1R, 3: p0L, 4: p1R, 5: p0R]
  const isEnd1 = [0, 1, 1, 0, 1, 0];

  let cursor = 0;
  let activeCount = 0;
  let highWaterSlots = 0;
  let stampedDirty = false;
  const vTmp0L = { wx: 0, wy: 0, wz: 0, nx: 0, ny: 1, nz: 0 };
  const vTmp0R = { wx: 0, wy: 0, wz: 0, nx: 0, ny: 1, nz: 0 };
  const vTmp1L = { wx: 0, wy: 0, wz: 0, nx: 0, ny: 1, nz: 0 };
  const vTmp1R = { wx: 0, wy: 0, wz: 0, nx: 0, ny: 1, nz: 0 };

  function writeVert(vIdx, wx, wy, wz, nx, ny, nz, u, v, r, g, b, a) {
    const p3 = vIdx * 3;
    positions[p3] = wx;
    positions[p3 + 1] = wy;
    positions[p3 + 2] = wz;
    normals[p3] = nx;
    normals[p3 + 1] = ny;
    normals[p3 + 2] = nz;
    const u2 = vIdx * 2;
    uvs[u2] = u;
    uvs[u2 + 1] = v;
    const c4 = vIdx * 4;
    colors[c4] = r;
    colors[c4 + 1] = g;
    colors[c4 + 2] = b;
    colors[c4 + 3] = a;
  }

  function terrainVertex(out, liveWorld, wx, wz, baseH, extraLift = 0) {
    const hasElev =
      typeof liveWorld?.terrainElevationAt === "function" ||
      typeof liveWorld?.elevationAt === "function";
    if (!hasElev) {
      out.wx = wx;
      out.wy = baseH + extraLift;
      out.wz = wz;
      out.nx = 0;
      out.ny = 1;
      out.nz = 0;
      return out;
    }
    const wy = baseH + extraLift + elevAt(liveWorld, wx, wz);
    const ex = elevAt(liveWorld, wx + 0.35, wz) - elevAt(liveWorld, wx - 0.35, wz);
    const ez = elevAt(liveWorld, wx, wz + 0.35) - elevAt(liveWorld, wx, wz - 0.35);
    const nx = -ex / 0.7;
    const ny = 1;
    const nz = -ez / 0.7;
    const nLen = Math.hypot(nx, ny, nz) || 1;
    out.wx = wx;
    out.wy = wy;
    out.wz = wz;
    out.nx = nx / nLen;
    out.ny = ny / nLen;
    out.nz = nz / nLen;
    return out;
  }

  function stampSegment(
    x0,
    z0,
    x1,
    z1,
    halfWidth,
    baseHeight,
    v0,
    v1,
    a0,
    a1,
    maxAgeS,
    liveWorld,
  ) {
    const dx = x1 - x0;
    const dz = z1 - z0;
    const len = Math.hypot(dx, dz);
    if (len < 1e-4) return false;

    const rx = (dz / len) * halfWidth;
    const rz = (-dx / len) * halfWidth;

    const p0L = terrainVertex(vTmp0L, liveWorld, x0 - rx, z0 - rz, baseHeight, 0);
    const p0R = terrainVertex(vTmp0R, liveWorld, x0 + rx, z0 + rz, baseHeight, 0);
    const p1L = terrainVertex(vTmp1L, liveWorld, x1 - rx, z1 - rz, baseHeight, 0);
    const p1R = terrainVertex(vTmp1R, liveWorld, x1 + rx, z1 + rz, baseHeight, 0);

    const slot = cursor;
    cursor = (cursor + 1) % maxSegments;
    if (!segActive[slot]) {
      segActive[slot] = 1;
      activeCount++;
    }
    if (slot + 1 > highWaterSlots) {
      highWaterSlots = slot + 1;
    }

    segAgeS[slot] = 0;
    segMaxAgeS[slot] = maxAgeS;
    segAlpha0[slot] = a0;
    segAlpha1[slot] = a1;

    const vb = slot * 6;
    writeVert(vb + 0, p0L.wx, p0L.wy, p0L.wz, p0L.nx, p0L.ny, p0L.nz, 0, v0, 1, 1, 1, a0);
    writeVert(vb + 1, p1L.wx, p1L.wy, p1L.wz, p1L.nx, p1L.ny, p1L.nz, 0, v1, 1, 1, 1, a1);
    writeVert(vb + 2, p1R.wx, p1R.wy, p1R.wz, p1R.nx, p1R.ny, p1R.nz, 1, v1, 1, 1, 1, a1);
    writeVert(vb + 3, p0L.wx, p0L.wy, p0L.wz, p0L.nx, p0L.ny, p0L.nz, 0, v0, 1, 1, 1, a0);
    writeVert(vb + 4, p1R.wx, p1R.wy, p1R.wz, p1R.nx, p1R.ny, p1R.nz, 1, v1, 1, 1, 1, a1);
    writeVert(vb + 5, p0R.wx, p0R.wy, p0R.wz, p0R.nx, p1R.ny, p0R.nz, 1, v0, 1, 1, 1, a0);

    stampedDirty = true;
    return true;
  }

  function step(dt) {
    const hadStamp = stampedDirty;
    if (hadStamp) {
      stampedDirty = false;
      const drawVerts = highWaterSlots * 6;
      geo.setDrawRange(0, drawVerts);
      flagInstancedAttrDirty(posAttr, drawVerts);
      flagInstancedAttrDirty(normAttr, drawVerts);
      flagInstancedAttrDirty(uvAttr, drawVerts);
      flagInstancedAttrDirty(colAttr, drawVerts);
    }
    if (!timedFade || activeCount === 0) return;
    let colorDirty = false;
    let posDirty = false;
    const prevVerts = highWaterSlots * 6;
    for (let s = 0; s < highWaterSlots; s++) {
      if (!segActive[s]) continue;
      segAgeS[s] += dt;
      const ttl = segMaxAgeS[s] || 14;
      const vb = s * 6;
      if (segAgeS[s] >= ttl) {
        segActive[s] = 0;
        activeCount = Math.max(0, activeCount - 1);
        for (let k = 0; k < 6; k++) {
          const vIdx = vb + k;
          positions[vIdx * 3] = 0;
          positions[vIdx * 3 + 1] = 0;
          positions[vIdx * 3 + 2] = 0;
          colors[vIdx * 4 + 3] = 0;
        }
        posDirty = true;
        colorDirty = true;
      } else {
        const fade = 1 - smoothstep(0.45, 1.0, segAgeS[s] / ttl);
        for (let k = 0; k < 6; k++) {
          const baseA = isEnd1[k] ? segAlpha1[s] : segAlpha0[s];
          colors[(vb + k) * 4 + 3] = baseA * fade;
        }
        colorDirty = true;
      }
    }
    if (activeCount === 0) {
      highWaterSlots = 0;
      cursor = 0;
      geo.setDrawRange(0, 0);
    }
    if (posDirty && !hadStamp) flagInstancedAttrDirty(posAttr, prevVerts);
    if (colorDirty && !hadStamp) flagInstancedAttrDirty(colAttr, prevVerts);
  }

  function reset() {
    stampedDirty = false;
    if (activeCount === 0 && highWaterSlots === 0) return;
    const prevVerts = Math.max(1, highWaterSlots * 6);
    positions.fill(0, 0, prevVerts * 3);
    colors.fill(0, 0, prevVerts * 4);
    segActive.fill(0, 0, highWaterSlots);
    segAgeS.fill(0, 0, highWaterSlots);
    cursor = 0;
    activeCount = 0;
    highWaterSlots = 0;
    geo.setDrawRange(0, 0);
    flagInstancedAttrDirty(posAttr, prevVerts);
    flagInstancedAttrDirty(colAttr, prevVerts);
  }

  return {
    mesh,
    stampSegment,
    step,
    reset,
    getActiveCount: () => activeCount,
  };
}

function computeFourWheelPositions(actor, out = null) {
  const h = actor.heading ?? 0;
  const sin = Math.sin(h);
  const cos = Math.cos(h);
  const width = actor.width ?? PLAYER_VEHICLE.widthM;
  const length = actor.length ?? PLAYER_VEHICLE.lengthM;
  const halfTrack = width * 0.45;
  const halfWb = length * 0.31;
  const ax = actor.x ?? 0;
  const az = actor.z ?? 0;
  const tc = halfTrack * cos;
  const ts = halfTrack * sin;
  const ws = halfWb * sin;
  const wc = halfWb * cos;

  if (out) {
    out[0].x = ax - tc + ws;
    out[0].z = az + ts + wc;
    out[1].x = ax + tc + ws;
    out[1].z = az - ts + wc;
    out[2].x = ax - tc - ws;
    out[2].z = az + ts - wc;
    out[3].x = ax + tc - ws;
    out[3].z = az - ts - wc;
    return out;
  }

  return [
    { x: ax - tc + ws, z: az + ts + wc, side: -1, axle: 1 },
    { x: ax + tc + ws, z: az - ts + wc, side: 1, axle: 1 },
    { x: ax - tc - ws, z: az + ts - wc, side: -1, axle: -1 },
    { x: ax + tc - ws, z: az - ts - wc, side: 1, axle: -1 },
  ];
}

export function createStreetSurfacesView(scene, world, _mountTargets = null) {
  const root = _mountTargets?.root ?? new THREE.Group();
  root.name = "street-surfaces-layer";

  const fxGroup = _mountTargets?.fxGroup ?? new THREE.Group();
  fxGroup.name = "street-surface-fx";
  if (fxGroup.parent !== root) root.add(fxGroup);

  if (scene?.add && root.parent !== scene) scene.add(root);

  const terrain = world?.terrain && typeof world.terrain === "object" ? world.terrain : null;
  const waterPuddles = Array.isArray(terrain?.waterPuddles) ? terrain.waterPuddles : [];
  const waterPuddlePolys = waterPuddles.map((zone, pIdx) => compilePuddlePolygonEntry(zone, pIdx, 0.92, 20));
  const sandZones = Array.isArray(terrain?.sandZones) ? terrain.sandZones : [];
  const cobbleZones = Array.isArray(terrain?.cobbleZones) ? terrain.cobbleZones : [];
  const hills = Array.isArray(terrain?.hills) ? terrain.hills : [];
  const indexedWaterRef = terrain?.waterPuddles;
  const indexedSandRef = terrain?.sandZones;
  const indexedCobbleRef = terrain?.cobbleZones;
  const hasIndexedZones =
    waterPuddles.length > 0 || sandZones.length > 0 || cobbleZones.length > 0;

  const surfaceCellIndex = new Map();
  function rebuildSurfaceCellIndex(srcTerrain = terrain) {
    surfaceCellIndex.clear();
    if (!srcTerrain) return;
    const wZones = Array.isArray(srcTerrain.waterPuddles) ? srcTerrain.waterPuddles : [];
    const sZones = Array.isArray(srcTerrain.sandZones) ? srcTerrain.sandZones : [];
    const cZones = Array.isArray(srcTerrain.cobbleZones) ? srcTerrain.cobbleZones : [];
    if (wZones.length === 0 && sZones.length === 0 && cZones.length === 0) return;

    const ensureBucket = (cx, cz) => {
      const key = surfaceCellKey(cx, cz);
      let bucket = surfaceCellIndex.get(key);
      if (!bucket) {
        bucket = { puddles: [], sand: [], cobble: [] };
        surfaceCellIndex.set(key, bucket);
      }
      return bucket;
    };

    for (let pIdx = 0; pIdx < wZones.length; pIdx++) {
      const zone = wZones[pIdx];
      if (!zone || !Number.isFinite(zone.x) || !Number.isFinite(zone.z)) continue;
      const ext = zoneExtents(zone);
      const pHalfW = Math.max(0.25, ext.halfWidth) + 0.3;
      const pHalfL = Math.max(0.25, ext.halfLength) + 0.3;
      const boundX = Math.abs(ext.cos) * pHalfW + Math.abs(ext.sin) * pHalfL;
      const boundZ = Math.abs(ext.sin) * pHalfW + Math.abs(ext.cos) * pHalfL;
      const minX = ext.x - boundX;
      const maxX = ext.x + boundX;
      const minZ = ext.z - boundZ;
      const maxZ = ext.z + boundZ;
      const minCx = Math.floor(minX * INV_SURFACE_CELL_SIZE_M);
      const maxCx = Math.floor(maxX * INV_SURFACE_CELL_SIZE_M);
      const minCz = Math.floor(minZ * INV_SURFACE_CELL_SIZE_M);
      const maxCz = Math.floor(maxZ * INV_SURFACE_CELL_SIZE_M);
      if (
        !Number.isFinite(minCx) ||
        !Number.isFinite(maxCx) ||
        !Number.isFinite(minCz) ||
        !Number.isFinite(maxCz)
      ) {
        continue;
      }
      const heading = zone.heading ?? 0;
      const fastZone = {
        ...zone,
        cos: Math.cos(heading),
        sin: Math.sin(heading),
        _compiledHeading: heading,
        _compiledHW: Math.max(0.25, ext.halfWidth),
        _compiledHL: Math.max(0.25, ext.halfLength),
        boundX: ext.boundX,
        boundZ: ext.boundZ,
        organicSeed: Number.isFinite(zone.organicSeed)
          ? zone.organicSeed
          : hashString(zone.id ?? `puddle-${pIdx}`),
      };
      const puddleEntry = { zone, index: pIdx, fastZone, minX, maxX, minZ, maxZ };
      for (let cx = minCx; cx <= maxCx; cx++) {
        for (let cz = minCz; cz <= maxCz; cz++) {
          ensureBucket(cx, cz).puddles.push(puddleEntry);
        }
      }
    }

    const indexRectZones = (zones, field) => {
      for (let i = 0; i < zones.length; i++) {
        const zObj = zones[i];
        if (!zObj) continue;
        const ext = zoneExtents(zObj);
        const bx = ext.boundX + 1e-6;
        const bz = ext.boundZ + 1e-6;
        const minCx = Math.floor((ext.x - bx) * INV_SURFACE_CELL_SIZE_M);
        const maxCx = Math.floor((ext.x + bx) * INV_SURFACE_CELL_SIZE_M);
        const minCz = Math.floor((ext.z - bz) * INV_SURFACE_CELL_SIZE_M);
        const maxCz = Math.floor((ext.z + bz) * INV_SURFACE_CELL_SIZE_M);
        if (
          !Number.isFinite(minCx) ||
          !Number.isFinite(maxCx) ||
          !Number.isFinite(minCz) ||
          !Number.isFinite(maxCz)
        ) {
          continue;
        }
        for (let cx = minCx; cx <= maxCx; cx++) {
          for (let cz = minCz; cz <= maxCz; cz++) {
            ensureBucket(cx, cz)[field].push(ext);
          }
        }
      }
    };

    indexRectZones(sZones, "sand");
    indexRectZones(cZones, "cobble");
  }
  if (hasIndexedZones) {
    rebuildSurfaceCellIndex(terrain);
  }

  function lookupIndexedSurfaceAt(x, z) {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return "asphalt";
    const cx = Math.floor(x * INV_SURFACE_CELL_SIZE_M);
    const cz = Math.floor(z * INV_SURFACE_CELL_SIZE_M);
    const bucket = surfaceCellIndex.get(surfaceCellKey(cx, cz));
    if (!bucket) return "asphalt";

    const puddles = bucket.puddles;
    for (let i = 0; i < puddles.length; i++) {
      const p = puddles[i];
      if (x >= p.minX && x <= p.maxX && z >= p.minZ && z <= p.maxZ) {
        if (pointInWaterPuddle(x, z, p.fastZone, p.index, 0)) return "water";
      }
    }

    const sand = bucket.sand;
    for (let i = 0; i < sand.length; i++) {
      if (pointInShapedSurfaceZone(x, z, sand[i])) return "sand";
    }

    const cobble = bucket.cobble;
    for (let i = 0; i < cobble.length; i++) {
      if (pointInShapedSurfaceZone(x, z, cobble[i])) return "cobble";
    }

    return "asphalt";
  }

  const snapshotViewZones = (arr) => {
    if (!Array.isArray(arr)) return null;
    const n = arr.length;
    const refs = new Array(n);
    const ids = new Array(n);
    const seeds = new Array(n);
    const shapes = new Array(n);
    const vals = new Float64Array(n * 8);
    for (let i = 0; i < n; i++) {
      const z = arr[i];
      refs[i] = z;
      if (!z) continue;
      ids[i] = z.id;
      seeds[i] = z.organicSeed;
      shapes[i] = z.shape;
      const off = i * 8;
      vals[off] = z.x ?? 0;
      vals[off + 1] = z.z ?? 0;
      vals[off + 2] = z.heading ?? 0;
      vals[off + 3] = z.halfWidth ?? 0;
      vals[off + 4] = z.halfLength ?? 0;
      vals[off + 5] = z.width ?? 0;
      vals[off + 6] = z.length ?? 0;
      vals[off + 7] = z.depthM ?? 0.02;
    }
    return { arr, refs, ids, seeds, shapes, vals };
  };
  const matchesViewZoneSnap = (arr, snap) => {
    if (!Array.isArray(arr)) return snap === null;
    if (!snap || snap.arr !== arr) return false;
    const { refs, ids, seeds, shapes, vals } = snap;
    const n = refs.length;
    if (arr.length !== n) return false;
    for (let i = 0, off = 0; i < n; i++, off += 8) {
      const z = arr[i];
      if (z !== refs[i]) return false;
      if (!z) continue;
      if (
        z.id !== ids[i] ||
        z.organicSeed !== seeds[i] ||
        z.shape !== shapes[i] ||
        (z.x ?? 0) !== vals[off] ||
        (z.z ?? 0) !== vals[off + 1] ||
        (z.heading ?? 0) !== vals[off + 2] ||
        (z.halfWidth ?? 0) !== vals[off + 3] ||
        (z.halfLength ?? 0) !== vals[off + 4] ||
        (z.width ?? 0) !== vals[off + 5] ||
        (z.length ?? 0) !== vals[off + 6] ||
        (z.depthM ?? 0.02) !== vals[off + 7]
      ) {
        return false;
      }
    }
    return true;
  };
  let indexedWaterSnap = snapshotViewZones(terrain?.waterPuddles);
  let indexedSandSnap = snapshotViewZones(terrain?.sandZones);
  let indexedCobbleSnap = snapshotViewZones(terrain?.cobbleZones);
  let waterHaloSurfaceMesh = null;
  let waterCoreSurfaceMesh = null;
  let sandSurfaceMesh = null;
  let cobbleSurfaceMesh = null;
  let syncDynamicTerrainGeometries = () => {};

  function canUseIndexedTerrain(liveTerrain) {
    return (
      liveTerrain === terrain &&
      liveTerrain !== null &&
      matchesViewZoneSnap(liveTerrain.waterPuddles, indexedWaterSnap) &&
      matchesViewZoneSnap(liveTerrain.sandZones, indexedSandSnap) &&
      matchesViewZoneSnap(liveTerrain.cobbleZones, indexedCobbleSnap)
    );
  }

  let inUpdatePassValid = false;

  function resolveSurfaceAt(x, z, liveWorld = world) {
    const liveTerrain = liveWorld?.terrain;
    if (!liveTerrain || !Number.isFinite(x) || !Number.isFinite(z)) return "asphalt";
    if (inUpdatePassValid && liveTerrain === terrain) {
      return lookupIndexedSurfaceAt(x, z);
    }
    if (liveTerrain === terrain) {
      if (!canUseIndexedTerrain(liveTerrain)) {
        syncDynamicTerrainGeometries(liveWorld);
      }
      return lookupIndexedSurfaceAt(x, z);
    }
    return resolveZoneSurfaceAt(liveTerrain, x, z);
  }

  const active = Boolean(
    terrain &&
      (waterPuddles.length > 0 ||
        sandZones.length > 0 ||
        cobbleZones.length > 0 ||
        hills.length > 0),
  );

  const ownedGeometries = new Set();
  const ownedMaterials = new Set();
  const ownedTextures = new Set();
  const ownedInstancedMeshes = new Set();

  const trackGeo = (g) => {
    if (g) ownedGeometries.add(g);
    return g;
  };
  const trackMat = (m) => {
    if (m) ownedMaterials.add(m);
    return m;
  };
  const trackTex = (t) => {
    if (t) ownedTextures.add(t);
    return t;
  };
  const trackInstanced = (im) => {
    if (im) ownedInstancedMeshes.add(im);
    return im;
  };

  let disposed = false;

  if (!active) {
    let promoted = null;
    const terrainHasZones = (t) =>
      Boolean(
        t &&
          typeof t === "object" &&
          ((t.waterPuddles?.length ?? 0) > 0 ||
            (t.sandZones?.length ?? 0) > 0 ||
            (t.cobbleZones?.length ?? 0) > 0 ||
            (t.hills?.length ?? 0) > 0),
      );
    const maybePromote = (liveWorld = world) => {
      if (disposed || promoted) return promoted;
      const t = liveWorld?.terrain ?? terrain;
      if (!terrainHasZones(t)) return null;
      const hostWorld = liveWorld ?? world;
      promoted = createStreetSurfacesView(null, hostWorld, { root, fxGroup });
      return promoted;
    };
    return {
      root,
      group: root,
      fxGroup,
      get lampPoolsMesh() {
        return promoted?.lampPoolsMesh ?? null;
      },
      get lampBulbHalos() {
        return promoted?.lampBulbHalos ?? null;
      },
      get waterRipples() {
        return promoted?.waterRipples ?? null;
      },
      get waterSplashes() {
        return promoted?.waterSplashes ?? null;
      },
      get wetTireTracks() {
        return promoted?.wetTireTracks ?? null;
      },
      get sandTireRuts() {
        return promoted?.sandTireRuts ?? null;
      },
      get sandDust() {
        return promoted?.sandDust ?? null;
      },
      get sandGrit() {
        return promoted?.sandGrit ?? null;
      },
      get reflectionPlanes() {
        return promoted?.reflectionPlanes;
      },
      setLiveReflection(sample) {
        promoted?.setLiveReflection(sample);
      },
      resolveSurfaceAt(x, z, liveWorld = world) {
        const p = maybePromote(liveWorld);
        return p ? p.resolveSurfaceAt(x, z, liveWorld) : resolveSurfaceAt(x, z, liveWorld);
      },
      setSensorCleanMode(clean) {
        promoted?.setSensorCleanMode?.(clean);
      },
      setPreviewThumbnailMode(thumb) {
        promoted?.setPreviewThumbnailMode?.(thumb);
      },
      update(liveWorld = world, dt = 1 / 60, camera = null) {
        const p = maybePromote(liveWorld);
        if (p) p.update(liveWorld, dt, camera);
      },
      reset() {
        promoted?.reset?.();
      },
      diagnostics() {
        if (promoted) return promoted.diagnostics();
        return {
          active: false,
          drawCalls: 0,
          waterPuddleCount: 0,
          sandZoneCount: 0,
          cobbleZoneCount: 0,
          manholeCount: 0,
          lampPoolCount: 0,
          lampBulbHaloCount: 0,
          streetLampCount: 0,
          streetTreeCount: 0,
          furnitureCount: 0,
          propCounts: { lamps: 0, trees: 0, furniture: 0 },
          activeWaterSplashes: 0,
          activeWaterRipples: 0,
          activeWetTrackSegments: 0,
          activeSandRutSegments: 0,
          activeSandDust: 0,
          activeSandGrit: 0,
          waterRoughness: 0,
          waterBaseOpacity: 0,
          waterEnvMapIntensity: 0,
          hasFresnelWaterShader: false,
          billboardSprayAndDust: false,
          sandRoughness: 0,
          hasWaterBumpMap: false,
          hasSandBumpMap: false,
          hasCobbleBumpMap: false,
        };
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        if (promoted) {
          promoted.dispose();
          promoted = null;
          return;
        }
        fxGroup.clear();
        root.removeFromParent();
        root.clear();
      },
    };
  }

  // 1. Procedural 256x256 PBR DataTextures & Realistic Schlick-Fresnel Water Puddle Optics
  const waterMaps = createWaterTextures(trackTex);
  const waterMaterial = trackMat(
    new THREE.MeshStandardMaterial({
      name: "street-water-puddle-pbr",
      color: 0x9aaec0,
      map: waterMaps.map,
      bumpMap: waterMaps.bumpMap,
      bumpScale: 0.012,
      roughnessMap: waterMaps.roughnessMap,
      roughness: 0.045,
      metalness: 0.08,
      envMapIntensity: 0.56,
      vertexColors: true,
      transparent: true,
      opacity: 0.56,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    }),
  );
  const waterUniforms = attachFresnelPuddleShader(waterMaterial);
  let reflectionPlanes = waterReflectionPlanes(waterPuddles, world);

  function setLiveReflection(sample) {
    waterUniforms.uPuddleLive.value = sample ? 1 : 0;
    waterUniforms.tPuddleReflection.value = sample?.texture ?? null;
    if (!sample) return;
    waterUniforms.uPuddleTextureMatrix.value.copy(sample.matrix);
    waterUniforms.uPuddleCaptureTexel.value.copy(sample.texelSize);
    waterUniforms.uPuddlePlaneHeight.value = sample.planeY;
  }

  const haloMaps = createWaterHaloTextures(trackTex);
  const waterHaloMaterial = trackMat(
    new THREE.MeshStandardMaterial({
      name: "street-water-halo-pbr",
      color: 0x14191e,
      map: haloMaps.map,
      bumpMap: haloMaps.bumpMap,
      bumpScale: 0.014,
      roughnessMap: haloMaps.roughnessMap,
      roughness: 0.82,
      metalness: 0.0,
      envMapIntensity: 0.08,
      vertexColors: true,
      transparent: true,
      opacity: 0.58,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    }),
  );

  const sandMaps = createSandTextures(trackTex);
  const sandMaterial = trackMat(
    new THREE.MeshStandardMaterial({
      name: "street-sand-drift-pbr",
      color: 0xffffff,
      map: sandMaps.map,
      bumpMap: sandMaps.bumpMap,
      bumpScale: 0.065,
      roughnessMap: sandMaps.roughnessMap,
      roughness: 0.94,
      metalness: 0.0,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    }),
  );

  const cobbleMaps = createCobbleTextures(trackTex);
  const cobbleMaterial = trackMat(
    new THREE.MeshStandardMaterial({
      name: "street-cobblestone-pbr",
      color: 0xffffff,
      map: cobbleMaps.map,
      bumpMap: cobbleMaps.bumpMap,
      bumpScale: 0.048,
      roughnessMap: cobbleMaps.roughnessMap,
      roughness: 0.86,
      metalness: 0.04,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    }),
  );

  root.userData.materials = {
    water: waterMaterial,
    waterHalo: waterHaloMaterial,
    sand: sandMaterial,
    cobble: cobbleMaterial,
  };

  let drawCalls = 0;

  const addStaticSurfaceMesh = (geo, mat, name, renderOrder = 0) => {
    if (!geo) return null;
    const mesh = new THREE.Mesh(trackGeo(geo), mat);
    mesh.name = name;
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    mesh.renderOrder = renderOrder;
    mesh.updateMatrix();
    mesh.matrixAutoUpdate = false;
    root.add(mesh);
    drawCalls++;
    return mesh;
  };

  const replaceSurfaceMeshGeometry = (meshRef, nextGeo, mat, name, renderOrder = 0) => {
    if (meshRef) {
      const oldGeo = meshRef.geometry;
      if (oldGeo) {
        ownedGeometries.delete(oldGeo);
        oldGeo.dispose();
      }
      if (nextGeo) {
        meshRef.geometry = trackGeo(nextGeo);
        meshRef.visible = true;
      } else {
        meshRef.visible = false;
      }
      return meshRef;
    }
    return nextGeo ? addStaticSurfaceMesh(nextGeo, mat, name, renderOrder) : null;
  };

  if (waterPuddles.length > 0) {
    const { coreGeometry, haloGeometry } = buildWaterPuddleGeometries(waterPuddles, world);
    waterHaloSurfaceMesh = addStaticSurfaceMesh(haloGeometry, waterHaloMaterial, "street-water-halos", 1);
    waterCoreSurfaceMesh = addStaticSurfaceMesh(coreGeometry, waterMaterial, "street-water-puddles", 2);
  }
  if (sandZones.length > 0) {
    sandSurfaceMesh = addStaticSurfaceMesh(
      buildSandZonesGeometry(sandZones, world),
      sandMaterial,
      "street-sand-zones",
      0,
    );
  }
  if (cobbleZones.length > 0) {
    cobbleSurfaceMesh = addStaticSurfaceMesh(
      buildCobbleZonesGeometry(cobbleZones, world),
      cobbleMaterial,
      "street-cobble-zones",
      0,
    );
  }

  syncDynamicTerrainGeometries = (liveWorld = world) => {
    if (disposed || !terrain || liveWorld?.terrain !== terrain) return;
    const waterChanged = !matchesViewZoneSnap(terrain.waterPuddles, indexedWaterSnap);
    const sandChanged = !matchesViewZoneSnap(terrain.sandZones, indexedSandSnap);
    const cobbleChanged = !matchesViewZoneSnap(terrain.cobbleZones, indexedCobbleSnap);
    if (!waterChanged && !sandChanged && !cobbleChanged) return;
    if (waterChanged) {
      const wArr = Array.isArray(terrain.waterPuddles) ? terrain.waterPuddles : [];
      const { coreGeometry, haloGeometry } = wArr.length > 0
        ? buildWaterPuddleGeometries(wArr, liveWorld)
        : { coreGeometry: null, haloGeometry: null };
      waterHaloSurfaceMesh = replaceSurfaceMeshGeometry(waterHaloSurfaceMesh, haloGeometry, waterHaloMaterial, "street-water-halos", 1);
      waterCoreSurfaceMesh = replaceSurfaceMeshGeometry(waterCoreSurfaceMesh, coreGeometry, waterMaterial, "street-water-puddles", 2);
      reflectionPlanes = waterReflectionPlanes(wArr, liveWorld);
      indexedWaterSnap = snapshotViewZones(terrain.waterPuddles);
    }
    if (sandChanged) {
      const sArr = Array.isArray(terrain.sandZones) ? terrain.sandZones : [];
      const nextSandGeo = sArr.length > 0 ? buildSandZonesGeometry(sArr, liveWorld) : null;
      sandSurfaceMesh = replaceSurfaceMeshGeometry(sandSurfaceMesh, nextSandGeo, sandMaterial, "street-sand-zones", 0);
      indexedSandSnap = snapshotViewZones(terrain.sandZones);
    }
    if (cobbleChanged) {
      const cArr = Array.isArray(terrain.cobbleZones) ? terrain.cobbleZones : [];
      const nextCobbleGeo = cArr.length > 0 ? buildCobbleZonesGeometry(cArr, liveWorld) : null;
      cobbleSurfaceMesh = replaceSurfaceMeshGeometry(cobbleSurfaceMesh, nextCobbleGeo, cobbleMaterial, "street-cobble-zones", 0);
      indexedCobbleSnap = snapshotViewZones(terrain.cobbleZones);
    }
    rebuildSurfaceCellIndex(terrain);
  };

  // 1b. Batched 3D Cast-Iron Manhole Covers, Tar Cracks & Junction Skid Marks (1 draw call)
  const {
    geometry: manholesAndCracksGeo,
    manholeCount,
    manholeCenters,
  } = buildManholesAndCracksGeometry(world, waterPuddles, sandZones, cobbleZones);
  if (manholesAndCracksGeo) {
    const manholesMaterial = trackMat(
      new THREE.MeshStandardMaterial({
        name: "street-manholes-and-cracks-pbr",
        vertexColors: true,
        roughness: 0.58,
        metalness: 0.28,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -2,
      }),
    );
    root.userData.materials.manholesAndCracks = manholesMaterial;
    root.userData.manholeCenters = manholeCenters;
    addStaticSurfaceMesh(
      manholesAndCracksGeo,
      manholesMaterial,
      "street-manholes-and-cracks",
      0,
    );
  } else {
    root.userData.manholeCenters = [];
  }

  // 2. Instanced Cairo Street Props (<= 5 InstancedMesh draw calls) + Dusk Lamp Light Pools
  const dummy = new THREE.Object3D();
  const upAxis = new THREE.Vector3(0, 1, 0);
  const zAxis = new THREE.Vector3(0, 0, 1);
  const terrainNormal = new THREE.Vector3(0, 1, 0);
  const yawQuat = new THREE.Quaternion();
  const tiltQuat = new THREE.Quaternion();
  const billboardBaseQuat = new THREE.Quaternion();
  const rollQuat = new THREE.Quaternion();
  const propPlacements = collectStreetPropPlacements(world);

  const streamedPropBatches = [];
  let lastPropStreamX = NaN;
  let lastPropStreamZ = NaN;
  const PROP_STREAM_RADIUS_SQ = 62 * 62;

  const populateStaticInstanced = (geo, mat, entries, name, castShadow = true) => {
    if (entries.length === 0) return null;
    const mesh = trackInstanced(new THREE.InstancedMesh(trackGeo(geo), trackMat(mat), entries.length));
    mesh.name = name;
    mesh.castShadow = castShadow;
    mesh.receiveShadow = true;
    for (let i = 0; i < entries.length; i++) {
      const p = entries[i];
      dummy.position.set(p.x, p.y, p.z);
      dummy.rotation.set(0, p.heading, 0);
      dummy.scale.setScalar(p.scale ?? 1);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    }
    mesh.count = entries.length;
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingBox();
    mesh.computeBoundingSphere();
    mesh.updateMatrix();
    mesh.matrixAutoUpdate = false;
    root.add(mesh);
    drawCalls++;
    if (entries.length > 64) {
      streamedPropBatches.push({
        mesh,
        entries,
        fullMatrices: Float32Array.from(mesh.instanceMatrix.array),
        selectedIndices: new Int32Array(entries.length),
        selectedCount: -1,
        prevCount: entries.length,
      });
    }
    return mesh;
  };

  let lampPoolsMesh = null;
  let lampBulbHalos = null;

  if (propPlacements.lamps.length > 0) {
    populateStaticInstanced(
      createStreetLampPoleGeometry(),
      new THREE.MeshStandardMaterial({
        name: "street-lamps-iron-material",
        vertexColors: true,
        roughness: 0.46,
        metalness: 0.68,
      }),
      propPlacements.lamps,
      "street-lamps-instanced",
      true,
    );
    populateStaticInstanced(
      createStreetLampHeadsGeometry(),
      new THREE.MeshStandardMaterial({
        name: "street-lamp-heads-emissive-material",
        color: 0xffe6b8,
        vertexColors: true,
        emissive: 0xffb85c,
        emissiveIntensity: 1.25,
        roughness: 0.22,
        metalness: 0.05,
      }),
      propPlacements.lamps,
      "street-lamp-heads-instanced",
      false,
    );

    // Dusk Warm Streetlamp Ground Light Pools (1 InstancedMesh draw call in fxGroup for clean AI sensor hiding)
    const poolGeo = new THREE.PlaneGeometry(10.2, 12.8);
    poolGeo.rotateX(-Math.PI / 2);
    const lampPoolTex = createLampPoolGlowTexture(trackTex);
    const lampPoolMat = trackMat(
      new THREE.MeshBasicMaterial({
        name: "street-lamp-light-pools-material",
        map: lampPoolTex,
        color: 0xffc270,
        transparent: true,
        opacity: 0.34,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -3,
      }),
    );
    lampPoolsMesh = trackInstanced(
      new THREE.InstancedMesh(trackGeo(poolGeo), lampPoolMat, propPlacements.lamps.length),
    );
    lampPoolsMesh.name = "street-lamp-light-pools";
    lampPoolsMesh.castShadow = false;
    lampPoolsMesh.receiveShadow = false;
    lampPoolsMesh.renderOrder = 3;

    const bulbPositions = new Float32Array(propPlacements.lamps.length * 2 * 3);
    for (let i = 0; i < propPlacements.lamps.length; i++) {
      const p = propPlacements.lamps[i];
      const scale = p.scale ?? 1;
      const sinH = Math.sin(p.heading);
      const cosH = Math.cos(p.heading);
      // Warm twin lantern bulb halo coordinates aligned with +/-0.84 m luminaire arms
      for (let armIdx = 0; armIdx < 2; armIdx++) {
        const dir = armIdx === 0 ? -1 : 1;
        const bIdx = (i * 2 + armIdx) * 3;
        bulbPositions[bIdx] = p.x + sinH * (dir * 0.84 * scale);
        bulbPositions[bIdx + 1] = p.y + 5.78 * scale;
        bulbPositions[bIdx + 2] = p.z + cosH * (dir * 0.84 * scale);
      }

      // Shift 1.05 m toward the curb/road so warm golden-amber light spans sidewalk, curb edge, and driving lane
      const poolX = p.x + cosH * 1.05;
      const poolZ = p.z - sinH * 1.05;
      const centerElev = elevAt(world, poolX, poolZ);
      const ex = elevAt(world, poolX + 1.8, poolZ) - elevAt(world, poolX - 1.8, poolZ);
      const ez = elevAt(world, poolX, poolZ + 1.8) - elevAt(world, poolX, poolZ - 1.8);
      const gradX = ex / 3.6;
      const gradZ = ez / 3.6;
      terrainNormal.set(-gradX, 1, -gradZ).normalize();

      // Guard against concave slope transitions so outer quad corners never clip road mesh
      let sagittaLift = 0;
      for (const dx of [-3.2, 3.2]) {
        for (const dz of [-4.2, 4.2]) {
          const ce = elevAt(world, poolX + dx, poolZ + dz);
          const planeE = centerElev + gradX * dx + gradZ * dz;
          if (ce - planeE > sagittaLift) sagittaLift = ce - planeE;
        }
      }

      dummy.position.set(poolX, LAMP_POOL_Y + centerElev + sagittaLift, poolZ);
      yawQuat.setFromAxisAngle(upAxis, p.heading);
      tiltQuat.setFromUnitVectors(upAxis, terrainNormal);
      dummy.quaternion.multiplyQuaternions(tiltQuat, yawQuat);
      dummy.scale.setScalar(1);
      dummy.updateMatrix();
      lampPoolsMesh.setMatrixAt(i, dummy.matrix);
    }
    dummy.quaternion.identity();
    lampPoolsMesh.count = propPlacements.lamps.length;
    lampPoolsMesh.instanceMatrix.needsUpdate = true;
    lampPoolsMesh.computeBoundingBox();
    lampPoolsMesh.computeBoundingSphere();
    lampPoolsMesh.updateMatrix();
    lampPoolsMesh.matrixAutoUpdate = false;
    fxGroup.add(lampPoolsMesh);
    drawCalls++;
    if (propPlacements.lamps.length > 64) {
      streamedPropBatches.push({
        mesh: lampPoolsMesh,
        entries: propPlacements.lamps,
        fullMatrices: Float32Array.from(lampPoolsMesh.instanceMatrix.array),
        selectedIndices: new Int32Array(propPlacements.lamps.length),
        selectedCount: -1,
        prevCount: propPlacements.lamps.length,
      });
    }

    const bulbGeo = trackGeo(new THREE.BufferGeometry());
    bulbGeo.setAttribute("position", new THREE.BufferAttribute(bulbPositions, 3));
    bulbGeo.computeBoundingBox();
    bulbGeo.computeBoundingSphere();
    const bulbMat = trackMat(
      new THREE.PointsMaterial({
        name: "street-lamp-bulb-halos-material",
        map: lampPoolTex,
        color: 0xffd996,
        size: 2.35,
        sizeAttenuation: true,
        transparent: true,
        opacity: 0.76,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      }),
    );
    lampBulbHalos = new THREE.Points(bulbGeo, bulbMat);
    lampBulbHalos.name = "street-lamp-bulb-halos";
    lampBulbHalos.renderOrder = 3;
    lampBulbHalos.matrixAutoUpdate = false;
    fxGroup.add(lampBulbHalos);
  }

  if (propPlacements.trees.length > 0) {
    populateStaticInstanced(
      createStreetTreeTrunkGeometry(),
      new THREE.MeshStandardMaterial({
        name: "street-trees-trunks-material",
        vertexColors: true,
        roughness: 0.92,
        metalness: 0.0,
      }),
      propPlacements.trees,
      "street-trees-trunks-instanced",
      true,
    );
    populateStaticInstanced(
      createStreetTreeCanopyGeometry(),
      new THREE.MeshStandardMaterial({
        name: "street-trees-canopies-material",
        vertexColors: true,
        flatShading: true,
        roughness: 0.86,
        metalness: 0.0,
      }),
      propPlacements.trees,
      "street-trees-canopies-instanced",
      true,
    );
  }

  if (propPlacements.furniture.length > 0) {
    populateStaticInstanced(
      createStreetFurnitureGeometry(),
      new THREE.MeshStandardMaterial({
        name: "street-furniture-material",
        vertexColors: true,
        roughness: 0.78,
        metalness: 0.14,
      }),
      propPlacements.furniture,
      "street-furniture-instanced",
      true,
    );
  }

  // 3. Six-Layer Realistic Water & Sand Tire Interaction FX inside fxGroup ("street-surface-fx")
  const makeInstancedAlphaPool = (geo, mat, capacity, name, renderOrder = 4) => {
    const alphaArray = new Float32Array(capacity);
    const alphaAttr = new THREE.InstancedBufferAttribute(alphaArray, 1);
    alphaAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute("aFxAlpha", alphaAttr);

    const mesh = trackInstanced(new THREE.InstancedMesh(trackGeo(geo), trackMat(mat), capacity));
    mesh.name = name;
    mesh.count = 0;
    mesh.renderOrder = renderOrder;
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    fxGroup.add(mesh);
    drawCalls++;
    return { mesh, alphaArray, alphaAttr };
  };

  // 3A. Expanding Concentric Tire-Wake Water Ripples (street-water-ripples)
  const waterRippleGeo = new THREE.PlaneGeometry(1, 1);
  waterRippleGeo.rotateX(-Math.PI / 2);
  const waterRippleTex = createWaterRippleTexture(trackTex);
  const waterRippleMat = attachInstancedAlphaShader(
    new THREE.MeshBasicMaterial({
      name: "street-water-ripples-material",
      map: waterRippleTex,
      color: 0xffffff,
      transparent: true,
      opacity: 0.68,
      toneMapped: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -3,
    }),
    "fx-water-ripples-alpha-v1",
  );
  const {
    mesh: waterRippleMesh,
    alphaArray: rippleAlphas,
    alphaAttr: rippleAlphaAttr,
  } = makeInstancedAlphaPool(
    waterRippleGeo,
    waterRippleMat,
    MAX_WATER_RIPPLES,
    "street-water-ripples",
    3,
  );

  // 3B. Soft FBM Rooster-Tail Water Spray & Mist Billboards (street-water-splashes)
  const waterSprayTex = createWaterSprayMistTexture(trackTex);
  const waterSplashMat = attachInstancedAlphaShader(
    new THREE.MeshBasicMaterial({
      name: "street-water-splash-material",
      map: waterSprayTex,
      color: 0xffffff,
      transparent: true,
      opacity: 0.86,
      side: THREE.DoubleSide,
      toneMapped: true,
      depthWrite: false,
    }),
    "fx-water-spray-alpha-v1",
  );
  const {
    mesh: waterSplashMesh,
    alphaArray: splashAlphas,
    alphaAttr: splashAlphaAttr,
  } = makeInstancedAlphaPool(
    new THREE.PlaneGeometry(1, 1),
    waterSplashMat,
    MAX_WATER_SPLASHES,
    "street-water-splashes",
    4,
  );

  // 3C. Wet Glossy Tire Tracks Trailing onto Dry Asphalt (street-wet-tire-tracks)
  const wetTrackTex = createWetTrackTexture(trackTex);
  const wetTrackMaterial = new THREE.MeshStandardMaterial({
    name: "street-wet-tire-tracks-material",
    color: 0x161a1f,
    map: wetTrackTex,
    roughness: 0.24,
    metalness: 0.04,
    envMapIntensity: 0.42,
    vertexColors: true,
    transparent: true,
    opacity: 0.78,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  wetTrackMaterial.customProgramCacheKey = () => "fresnel-wet-track-v1";
  wetTrackMaterial.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <output_fragment>",
      `float wetNdotV = clamp( dot( normalize( geometry.normal ), normalize( geometry.viewDir ) ), 0.0, 1.0 );
      float wetFresnel = 0.04 + 0.96 * pow( 1.0 - wetNdotV, 5.0 );
      // Dark dampened bitumen tire stain with subtle low-sheen grazing glint (never bright specular laser streaks!)
      vec3 wetSpec = clamp( totalSpecular * 0.14, vec3( 0.0 ), vec3( 0.09 ) );
      vec3 wetSkyHdr = vec3( 0.08, 0.10, 0.13 );
      outgoingLight = mix( vec3( 0.004, 0.005, 0.007 ), wetSpec + wetSkyHdr * wetFresnel, 0.52 );
      #include <output_fragment>`,
    );
  };
  const wetTrackBuffer = createDynamicTrackRingBuffer({
    maxSegments: MAX_WET_TRACK_SEGMENTS,
    material: wetTrackMaterial,
    name: "street-wet-tire-tracks",
    renderOrder: 2,
    timedFade: true,
    trackGeo,
    trackMat,
    parentGroup: fxGroup,
  });
  drawCalls++;

  // 3D. Persistent Carved 4-Wheel Sand Ruts (street-sand-tire-ruts)
  const sandRutMaps = createSandRutTextures(trackTex);
  const sandRutMaterial = new THREE.MeshStandardMaterial({
    name: "street-sand-tire-ruts-material",
    color: 0xffffff,
    map: sandRutMaps.map,
    bumpMap: sandRutMaps.bumpMap,
    bumpScale: 0.048,
    roughness: 0.93,
    metalness: 0.0,
    vertexColors: true,
    transparent: true,
    opacity: 0.92,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -3,
    polygonOffsetUnits: -4,
  });
  const sandRutBuffer = createDynamicTrackRingBuffer({
    maxSegments: MAX_SAND_RUT_SEGMENTS,
    material: sandRutMaterial,
    name: "street-sand-tire-ruts",
    renderOrder: 2,
    timedFade: false,
    trackGeo,
    trackMat,
    parentGroup: fxGroup,
  });
  drawCalls++;

  // 3E. Soft Volumetric FBM Sand-Dust Cloud Billboards (street-sand-dust)
  const sandDustTex = createSandDustCloudTexture(trackTex);
  const sandDustMat = attachInstancedAlphaShader(
    new THREE.MeshBasicMaterial({
      name: "street-sand-dust-material",
      map: sandDustTex,
      color: 0xffffff,
      transparent: true,
      opacity: 0.92,
      side: THREE.DoubleSide,
      toneMapped: true,
      depthWrite: false,
    }),
    "fx-sand-dust-alpha-v1",
  );
  const {
    mesh: sandDustMesh,
    alphaArray: dustAlphas,
    alphaAttr: dustAlphaAttr,
  } = makeInstancedAlphaPool(
    new THREE.PlaneGeometry(1, 1),
    sandDustMat,
    MAX_SAND_DUST,
    "street-sand-dust",
    4,
  );

  // 3F. Fast Ballistic Coarse Sand Grit Spray (street-sand-grit)
  const sandGritTex = createSandGritTexture(trackTex);
  const sandGritMat = attachInstancedAlphaShader(
    new THREE.MeshBasicMaterial({
      name: "street-sand-grit-material",
      map: sandGritTex,
      color: 0xffffff,
      transparent: true,
      opacity: 0.96,
      side: THREE.DoubleSide,
      toneMapped: true,
      depthWrite: false,
    }),
    "fx-sand-grit-alpha-v1",
  );
  const {
    mesh: sandGritMesh,
    alphaArray: gritAlphas,
    alphaAttr: gritAlphaAttr,
  } = makeInstancedAlphaPool(
    new THREE.PlaneGeometry(1, 1),
    sandGritMat,
    MAX_SAND_GRIT,
    "street-sand-grit",
    4,
  );

  root.userData.materials.wetTireTracks = wetTrackMaterial;
  root.userData.materials.sandTireRuts = sandRutMaterial;

  const rippleSlots = Array.from({ length: MAX_WATER_RIPPLES }, () => ({
    active: false,
    x: 0, y: 0, z: 0,
    nx: 0, ny: 1, nz: 0,
    yaw: 0,
    startScale: 0.42,
    endScale: 2.65,
    peakAlpha: 0.55,
    ageS: 0,
    ttlS: 0.85,
  }));

  const waterSlots = Array.from({ length: MAX_WATER_SPLASHES }, () => ({
    active: false,
    x: 0, y: 0, z: 0,
    vx: 0, vy: 0, vz: 0,
    roll: 0, vroll: 0,
    startScale: 0.28,
    endScale: 0.82,
    peakAlpha: 0.82,
    groundY: WATER_CORE_Y,
    ageS: 0,
    ttlS: 0.50,
  }));

  const sandSlots = Array.from({ length: MAX_SAND_DUST }, () => ({
    active: false,
    x: 0, y: 0, z: 0,
    vx: 0, vy: 0, vz: 0,
    roll: 0, vroll: 0,
    curlPhase: 0,
    curlFreq: 3.0,
    curlAmp: 0.35,
    startScale: 0.40,
    endScale: 2.35,
    peakAlpha: 0.85,
    ageS: 0,
    ttlS: 1.35,
  }));

  const gritSlots = Array.from({ length: MAX_SAND_GRIT }, () => ({
    active: false,
    x: 0, y: 0, z: 0,
    vx: 0, vy: 0, vz: 0,
    roll: 0, vroll: 0,
    scale: 0.22,
    groundY: SAND_BASE_Y,
    ageS: 0,
    ttlS: 0.38,
  }));

  let rippleCursor = 0;
  let waterCursor = 0;
  let sandCursor = 0;
  let gritCursor = 0;
  let liveRippleCount = 0;
  let liveSplashCount = 0;
  let liveDustCount = 0;
  let liveGritCount = 0;
  let prevRippleCount = 0;
  let prevSplashCount = 0;
  let prevDustCount = 0;
  let prevGritCount = 0;
  let rngState = 0x51f3a9d7;
  const rand = () => {
    rngState = (rngState + 0x6d2b79f5) | 0;
    let t = Math.imul(rngState ^ (rngState >>> 15), 1 | rngState);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const randRange = (lo, hi) => lo + (hi - lo) * rand();

  const actorStates = new Map();
  const seenActors = new Set();
  const wheelScratch = [
    { x: 0, z: 0, side: -1, axle: 1 },
    { x: 0, z: 0, side: 1, axle: 1 },
    { x: 0, z: 0, side: -1, axle: -1 },
    { x: 0, z: 0, side: 1, axle: -1 },
  ];
  const waterWheelsScratch = [];
  const sandWheelsScratch = [];
  let hadExplicitCameraThisFrame = false;
  let autoOrientedCam = null;
  let fxStepCounter = 0;
  const pruneStaleActorState = (st, key) => {
    if (fxStepCounter - st.lastSeenStep > 600) {
      actorStates.delete(key);
    }
  };

  function getActorState(key) {
    let st = actorStates.get(key);
    if (!st) {
      st = {
        waterSprayTimer: 0,
        waterRippleTimer: 0,
        sandDustTimer: 0,
        sandGritTimer: 0,
        wetRemainingByWheel: [0, 0, 0, 0],
        lastWetWheelPos: [null, null, null, null],
        wetPosStore: [
          { x: 0, z: 0 },
          { x: 0, z: 0 },
          { x: 0, z: 0 },
          { x: 0, z: 0 },
        ],
        stampedDryByWheel: [false, false, false, false],
        lastSandWheelPos: [null, null, null, null],
        sandPosStore: [
          { x: 0, z: 0 },
          { x: 0, z: 0 },
          { x: 0, z: 0 },
          { x: 0, z: 0 },
        ],
        wetUvV: 0,
        sandUvV: 0,
        lastSeenStep: fxStepCounter,
      };
      actorStates.set(key, st);
    }
    st.lastSeenStep = fxStepCounter;
    return st;
  }

  function storeWetWheelPos(state, w, cw) {
    const dst = state.wetPosStore[w];
    dst.x = cw.x;
    dst.z = cw.z;
    state.lastWetWheelPos[w] = dst;
  }

  function storeSandWheelPos(state, w, cw) {
    const dst = state.sandPosStore[w];
    dst.x = cw.x;
    dst.z = cw.z;
    state.lastSandWheelPos[w] = dst;
  }

  function resolveWheelSurfaceKind(actor, wh, liveWorld) {
    if (typeof actor?.surfaceKind === "string" && actor.surfaceKind.length > 0) {
      return actor.surfaceKind;
    }
    const liveTerrain = liveWorld?.terrain;
    if (canUseIndexedTerrain(liveTerrain)) {
      if (hasIndexedZones) {
        return lookupIndexedSurfaceAt(wh.x, wh.z);
      }
      return resolveActorSurfaceKind(actor, liveWorld);
    }
    const hasZones =
      liveTerrain &&
      ((liveTerrain.waterPuddles?.length ?? 0) > 0 ||
        (liveTerrain.sandZones?.length ?? 0) > 0 ||
        (liveTerrain.cobbleZones?.length ?? 0) > 0);
    if (hasZones) {
      return resolveZoneSurfaceAt(liveTerrain, wh.x, wh.z);
    }
    return resolveActorSurfaceKind(actor, liveWorld);
  }

  function allocRippleSlot() {
    for (let n = 0; n < MAX_WATER_RIPPLES; n++) {
      const idx = (rippleCursor + n) % MAX_WATER_RIPPLES;
      const slot = rippleSlots[idx];
      if (!slot.active) {
        rippleCursor = (idx + 1) % MAX_WATER_RIPPLES;
        slot.active = true;
        liveRippleCount++;
        return slot;
      }
    }
    const slot = rippleSlots[rippleCursor];
    rippleCursor = (rippleCursor + 1) % MAX_WATER_RIPPLES;
    slot.active = true;
    return slot;
  }

  function allocWaterSlot() {
    for (let n = 0; n < MAX_WATER_SPLASHES; n++) {
      const idx = (waterCursor + n) % MAX_WATER_SPLASHES;
      const slot = waterSlots[idx];
      if (!slot.active) {
        waterCursor = (idx + 1) % MAX_WATER_SPLASHES;
        slot.active = true;
        liveSplashCount++;
        return slot;
      }
    }
    const slot = waterSlots[waterCursor];
    waterCursor = (waterCursor + 1) % MAX_WATER_SPLASHES;
    slot.active = true;
    return slot;
  }

  function allocSandSlot() {
    for (let n = 0; n < MAX_SAND_DUST; n++) {
      const idx = (sandCursor + n) % MAX_SAND_DUST;
      const slot = sandSlots[idx];
      if (!slot.active) {
        sandCursor = (idx + 1) % MAX_SAND_DUST;
        slot.active = true;
        liveDustCount++;
        return slot;
      }
    }
    const slot = sandSlots[sandCursor];
    sandCursor = (sandCursor + 1) % MAX_SAND_DUST;
    slot.active = true;
    return slot;
  }

  function allocGritSlot() {
    for (let n = 0; n < MAX_SAND_GRIT; n++) {
      const idx = (gritCursor + n) % MAX_SAND_GRIT;
      const slot = gritSlots[idx];
      if (!slot.active) {
        gritCursor = (idx + 1) % MAX_SAND_GRIT;
        slot.active = true;
        liveGritCount++;
        return slot;
      }
    }
    const slot = gritSlots[gritCursor];
    gritCursor = (gritCursor + 1) % MAX_SAND_GRIT;
    slot.active = true;
    return slot;
  }

  function emitVehicleWaterRipples(actor, liveWorld, speed, wheels) {
    const absSpeed = Math.abs(speed);
    const speedBoost = clamp(absSpeed / 12, 0.75, 1.12);
    const hasRealPuddles = waterPuddles.length > 0 && typeof actor?.surfaceKind !== "string";

    for (let w = 0; w < wheels.length; w++) {
      const wh = wheels[w];
      const rx = wh.x + randRange(-0.06, 0.06);
      const rz = wh.z + randRange(-0.06, 0.06);
      const aspectZ = randRange(0.82, 1.18);
      const endScale = randRange(0.92, 1.12) * clamp(speedBoost, 0.90, 1.04);
      // Conservatively test exact Euclidean distance against every edge of the 20-vertex rendered puddle polygon!
      const worstCaseRadiusM = 0.5 * endScale * Math.max(1.0, aspectZ) + 0.04;
      if (
        hasRealPuddles &&
        !pointInPuddlePolygonsWithClearance(rx, rz, waterPuddlePolys, worstCaseRadiusM)
      ) {
        continue;
      }
      const baseElev = actorWheelBaseElevation(actor, liveWorld, rx, rz);
      const ex = elevAt(liveWorld, rx + 0.4, rz) - elevAt(liveWorld, rx - 0.4, rz);
      const ez = elevAt(liveWorld, rx, rz + 0.4) - elevAt(liveWorld, rx, rz - 0.4);
      const nLen = Math.hypot(-ex / 0.8, 1, -ez / 0.8) || 1;

      const slot = allocRippleSlot();
      slot.active = true;
      slot.x = rx;
      slot.y = WATER_CORE_Y + 0.0025 + baseElev;
      slot.z = rz;
      slot.nx = (-ex / 0.8) / nLen;
      slot.ny = 1 / nLen;
      slot.nz = (-ez / 0.8) / nLen;
      slot.yaw = (actor.heading ?? 0) + randRange(-0.55, 0.55);
      slot.aspectZ = aspectZ;
      slot.startScale = randRange(0.28, 0.36);
      slot.endScale = endScale;
      slot.peakAlpha = randRange(0.22, 0.34);
      slot.ageS = 0;
      slot.ttlS = randRange(0.68, 0.82);
    }
  }

  function emitVehicleWaterSplash(actor, liveWorld, speed, wheels) {
    const absSpeed = Math.abs(speed);
    const sign = speed >= 0 ? 1 : -1;
    const h = actor.heading ?? 0;
    const sin = Math.sin(h);
    const cos = Math.cos(h);
    const speedFactor = clamp(absSpeed / 12, 0.55, 1.38);
    const puffsPerWheel = absSpeed >= 7 ? 3 : 2;

    const fwdVx = sin * speed;
    const fwdVz = cos * speed;

    // Only wheels actually contacting water throw ballistic droplet-sheet spray arches!
    for (let w = 0; w < wheels.length; w++) {
      const wh = wheels[w];
      const baseElev = actorWheelBaseElevation(actor, liveWorld, wh.x, wh.z);

      for (let k = 0; k < puffsPerWheel; k++) {
        const slot = allocWaterSlot();
        const outMag = randRange(1.55, 3.35) * speedFactor;
        const wakeBack = -sign * randRange(1.6, 3.6) * speedFactor;
        slot.active = true;
        slot.x = wh.x + wh.side * cos * 0.14 + randRange(-0.07, 0.07);
        slot.y = WATER_CORE_Y + 0.10 + baseElev + randRange(0, 0.10);
        slot.z = wh.z - wh.side * sin * 0.14 + randRange(-0.07, 0.07);
        slot.vx = fwdVx * 0.16 + wh.side * cos * outMag + sin * wakeBack + randRange(-0.30, 0.30);
        slot.vy = randRange(2.15, 4.10) * speedFactor;
        slot.vz = fwdVz * 0.16 - wh.side * sin * outMag + cos * wakeBack + randRange(-0.30, 0.30);
        slot.roll = randRange(-0.45, 0.45) + wh.side * 0.42;
        slot.vroll = wh.side * randRange(1.8, 3.8);
        slot.startScale = randRange(0.32, 0.48) * clamp(speedFactor, 0.90, 1.20);
        slot.endScale = randRange(0.92, 1.44) * clamp(speedFactor, 0.92, 1.28);
        slot.peakAlpha = clamp(0.82 + 0.16 * speedFactor, 0.78, 0.98);
        slot.groundY = WATER_CORE_Y + baseElev;
        slot.ageS = 0;
        slot.ttlS = randRange(0.36, 0.54);
      }
    }
  }

  function stampWetExitWheel(actor, state, liveWorld, speed, dt, w, cw) {
    const absSpeed = Math.abs(speed);
    const sign = speed >= 0 ? 1 : -1;
    const h = actor.heading ?? 0;
    const sin = Math.sin(h);
    const cos = Math.cos(h);
    const pw = state.lastWetWheelPos[w];
    const moveDist = pw ? Math.hypot(cw.x - pw.x, cw.z - pw.z) : 0;

    if (!pw || moveDist > 4.0 || (!state.stampedDryByWheel[w] && moveDist < 0.08)) {
      const segLen = clamp(Math.max(absSpeed * dt, 0.32), 0.28, 0.90);
      const wetness0 = clamp(state.wetRemainingByWheel[w] / WET_TIRE_CARRY_M, 0, 1);
      state.wetRemainingByWheel[w] = Math.max(0, state.wetRemainingByWheel[w] - segLen);
      const wetness1 = clamp(state.wetRemainingByWheel[w] / WET_TIRE_CARRY_M, 0, 1);
      const v0 = state.wetUvV;
      const v1 = v0 + segLen / 0.55;
      if (w === 0) state.wetUvV = v1;

      wetTrackBuffer.stampSegment(
        cw.x - sin * sign * segLen,
        cw.z - cos * sign * segLen,
        cw.x,
        cw.z,
        WET_TRACK_HALF_WIDTH_M,
        WET_TRACK_BASE_Y,
        v0,
        v1,
        0.90 * Math.pow(wetness0, 0.72),
        0.90 * Math.pow(wetness1, 0.72),
        14.0,
        liveWorld,
      );
      storeWetWheelPos(state, w, cw);
      state.stampedDryByWheel[w] = true;
      if (state.wetRemainingByWheel[w] <= 0) {
        state.lastWetWheelPos[w] = null;
        state.stampedDryByWheel[w] = false;
      }
      return;
    }

    const minSegDist = state.stampedDryByWheel[w] ? 0.28 : 0.08;
    if (moveDist >= minSegDist) {
      const wetness0 = clamp(state.wetRemainingByWheel[w] / WET_TIRE_CARRY_M, 0, 1);
      state.wetRemainingByWheel[w] = Math.max(0, state.wetRemainingByWheel[w] - moveDist);
      const wetness1 = clamp(state.wetRemainingByWheel[w] / WET_TIRE_CARRY_M, 0, 1);
      const v0 = state.wetUvV;
      const v1 = v0 + moveDist / 0.55;
      if (w === 0) state.wetUvV = v1;

      wetTrackBuffer.stampSegment(
        pw.x,
        pw.z,
        cw.x,
        cw.z,
        WET_TRACK_HALF_WIDTH_M,
        WET_TRACK_BASE_Y,
        v0,
        v1,
        0.90 * Math.pow(wetness0, 0.72),
        0.90 * Math.pow(wetness1, 0.72),
        14.0,
        liveWorld,
      );
      storeWetWheelPos(state, w, cw);
      state.stampedDryByWheel[w] = true;
      if (state.wetRemainingByWheel[w] <= 0) {
        state.lastWetWheelPos[w] = null;
        state.stampedDryByWheel[w] = false;
      }
    }
  }

  function stampSandSingleWheelRut(actor, state, liveWorld, speed, dt, w, cw) {
    const absSpeed = Math.abs(speed);
    const sign = speed >= 0 ? 1 : -1;
    const h = actor.heading ?? 0;
    const sin = Math.sin(h);
    const cos = Math.cos(h);
    const pw = state.lastSandWheelPos[w];
    const moveDist = pw ? Math.hypot(cw.x - pw.x, cw.z - pw.z) : 0;

    if (!pw || moveDist > 4.0) {
      const segLen = clamp(Math.max(absSpeed * dt, 0.34), 0.30, 0.95);
      const v0 = state.sandUvV;
      const v1 = v0 + segLen / 0.60;
      if (w === 0) state.sandUvV = v1;

      sandRutBuffer.stampSegment(
        cw.x - sin * sign * segLen,
        cw.z - cos * sign * segLen,
        cw.x,
        cw.z,
        SAND_RUT_HALF_WIDTH_M,
        SAND_BASE_Y + SAND_RUT_OFFSET_Y,
        v0,
        v1,
        0.55,
        0.94,
        0,
        liveWorld,
      );
      storeSandWheelPos(state, w, cw);
      return;
    }

    if (moveDist >= 0.24) {
      const v0 = state.sandUvV;
      const v1 = v0 + moveDist / 0.60;
      if (w === 0) state.sandUvV = v1;

      sandRutBuffer.stampSegment(
        pw.x,
        pw.z,
        cw.x,
        cw.z,
        SAND_RUT_HALF_WIDTH_M,
        SAND_BASE_Y + SAND_RUT_OFFSET_Y,
        v0,
        v1,
        0.94,
        0.94,
        0,
        liveWorld,
      );
      storeSandWheelPos(state, w, cw);
    }
  }

  function emitVehicleSandDust(actor, liveWorld, speed, sandWheels) {
    const absSpeed = Math.abs(speed);
    const sign = speed >= 0 ? 1 : -1;
    const h = actor.heading ?? 0;
    const sin = Math.sin(h);
    const cos = Math.cos(h);
    const slip = Math.abs(actor.gtaSlipMps ?? actor.vehicle?.lateralSpeedMps ?? 0);
    const steerMag = Math.abs(actor.steerAngle ?? actor.vehicle?.steerAngle ?? actor.steer ?? 0);
    const driftBoost = slip * 0.10 + steerMag * 0.55;
    const intensity = clamp(absSpeed / 12 + driftBoost, 0.68, 1.65);

    // Emit dust strictly from the individual wheels actually contacting sand!
    for (let i = 0; i < sandWheels.length; i++) {
      const wh = sandWheels[i];
      const isFront = wh.axle > 0;
      const side = wh.side;
      const count = isFront ? 1 : absSpeed >= 7 || driftBoost >= 0.22 ? 2 : 1;
      const baseElev = actorWheelBaseElevation(actor, liveWorld, wh.x, wh.z);

      for (let k = 0; k < count; k++) {
        const slot = allocSandSlot();
        const trailBack = -sign * randRange(isFront ? 0.9 : 1.8, isFront ? 1.9 : 3.8) * intensity;
        const outSpread = side * randRange(isFront ? 0.65 : 0.85, isFront ? 1.55 : 2.15) * intensity + randRange(-0.24, 0.24);
        slot.active = true;
        slot.x = wh.x + randRange(-0.16, 0.16);
        slot.y = SAND_BASE_Y + (isFront ? 0.18 : 0.30) + baseElev + randRange(0, 0.16);
        slot.z = wh.z + randRange(-0.16, 0.16);
        slot.vx = sin * trailBack + cos * outSpread;
        slot.vy = randRange(isFront ? 0.75 : 1.25, isFront ? 1.45 : 2.55) * clamp(intensity, 0.82, 1.38);
        slot.vz = cos * trailBack - sin * outSpread;
        slot.roll = randRange(0, TAU);
        slot.vroll = randRange(-1.8, 1.8);
        slot.curlPhase = randRange(0, TAU);
        slot.curlFreq = randRange(2.4, 4.2);
        slot.curlAmp = randRange(0.30, 0.72) * intensity;
        slot.startScale = randRange(isFront ? 0.32 : 0.40, isFront ? 0.42 : 0.52);
        slot.endScale = randRange(isFront ? 1.15 : 1.75, isFront ? 1.55 : 2.35) * clamp(intensity, 0.88, 1.14);
        slot.peakAlpha = clamp((isFront ? 0.36 : 0.48) + 0.12 * intensity, 0.34, 0.66);
        slot.ageS = 0;
        slot.ttlS = randRange(isFront ? 0.85 : 1.25, isFront ? 1.25 : 1.88);
      }
    }
  }

  function emitVehicleSandGrit(actor, liveWorld, speed, wheels) {
    const absSpeed = Math.abs(speed);
    const sign = speed >= 0 ? 1 : -1;
    const h = actor.heading ?? 0;
    const sin = Math.sin(h);
    const cos = Math.cos(h);
    const slip = Math.abs(actor.gtaSlipMps ?? actor.vehicle?.lateralSpeedMps ?? 0);
    const speedFactor = clamp(absSpeed / 12 + slip * 0.06, 0.65, 1.45);

    for (let w = 0; w < wheels.length; w++) {
      const wh = wheels[w];
      // Rear wheels throw primary roost, front wheels throw lighter grit
      if (wh.axle > 0 && rand() > 0.55) continue;
      const baseElev = actorWheelBaseElevation(actor, liveWorld, wh.x, wh.z);

      const slot = allocGritSlot();
      const kickBack = -sign * randRange(3.2, 6.4) * speedFactor;
      const kickSide = wh.side * randRange(0.35, 1.25) * speedFactor + randRange(-0.25, 0.25);
      slot.active = true;
      slot.x = wh.x + randRange(-0.08, 0.08);
      slot.y = SAND_BASE_Y + 0.07 + baseElev + randRange(0, 0.06);
      slot.z = wh.z + randRange(-0.08, 0.08);
      slot.vx = sin * kickBack + cos * kickSide;
      slot.vy = randRange(1.35, 2.55) * clamp(speedFactor, 0.80, 1.25);
      slot.vz = cos * kickBack - sin * kickSide;
      slot.roll = randRange(0, TAU);
      slot.vroll = randRange(-6.5, 6.5);
      slot.scale = randRange(0.18, 0.30) * clamp(speedFactor, 0.85, 1.15);
      slot.groundY = SAND_BASE_Y + 0.018 + baseElev;
      slot.ageS = 0;
      slot.ttlS = randRange(0.26, 0.44);
    }
  }

  function considerVehicleActor(actor, liveWorld, px, pz, hasPlayer, dt) {
    if (!actor || actor.type === "pedestrian") return;
    if (hasPlayer && actor !== liveWorld.player) {
      const dx = (actor.x ?? 0) - px;
      const dz = (actor.z ?? 0) - pz;
      if (dx * dx + dz * dz > NEARBY_FX_RADIUS_M * NEARBY_FX_RADIUS_M) return;
    }
    if (seenActors.has(actor)) return;
    seenActors.add(actor);

    const key = actor.id ?? actor;
    const state = getActorState(key);
    const speed = resolveActorSpeed(actor);
    const absSpeed = Math.abs(speed);

    if (absSpeed < PARKED_SPEED_MPS) {
      state.waterSprayTimer = 0;
      state.waterRippleTimer = 0;
      state.sandDustTimer = 0;
      state.sandGritTimer = 0;
      return;
    }

    const wheels = computeFourWheelPositions(actor, wheelScratch);
    waterWheelsScratch.length = 0;
    sandWheelsScratch.length = 0;

    for (let w = 0; w < 4; w++) {
      const wh = wheels[w];
      const wSurf = resolveWheelSurfaceKind(actor, wh, liveWorld);
      if (wSurf === "water") {
        waterWheelsScratch.push(wh);
        state.wetRemainingByWheel[w] = WET_TIRE_CARRY_M;
        storeWetWheelPos(state, w, wh);
        state.stampedDryByWheel[w] = false;
        state.lastSandWheelPos[w] = null;
      } else if (wSurf === "sand") {
        sandWheelsScratch.push(wh);
        state.wetRemainingByWheel[w] = 0;
        state.lastWetWheelPos[w] = null;
        state.stampedDryByWheel[w] = false;
        if (absSpeed > SAND_RUT_MIN_SPEED_MPS) {
          stampSandSingleWheelRut(actor, state, liveWorld, speed, dt, w, wh);
        }
      } else {
        state.lastSandWheelPos[w] = null;
        if (state.wetRemainingByWheel[w] > 0) {
          stampWetExitWheel(actor, state, liveWorld, speed, dt, w, wh);
        }
      }
    }

    if (waterWheelsScratch.length > 0 && absSpeed >= WATER_MIN_SPEED_MPS) {
      state.waterRippleTimer -= dt;
      if (state.waterRippleTimer <= 0) {
        emitVehicleWaterRipples(actor, liveWorld, speed, waterWheelsScratch);
        state.waterRippleTimer = clamp(0.135 - absSpeed * 0.0025, 0.088, 0.135);
      }
      state.waterSprayTimer -= dt;
      if (state.waterSprayTimer <= 0) {
        emitVehicleWaterSplash(actor, liveWorld, speed, waterWheelsScratch);
        state.waterSprayTimer = clamp(0.052 - absSpeed * 0.0014, 0.024, 0.052);
      }
    } else {
      state.waterRippleTimer = 0;
      state.waterSprayTimer = 0;
    }

    if (sandWheelsScratch.length > 0 && absSpeed >= SAND_MIN_SPEED_MPS) {
      state.sandDustTimer -= dt;
      if (state.sandDustTimer <= 0) {
        emitVehicleSandDust(actor, liveWorld, speed, sandWheelsScratch);
        state.sandDustTimer = clamp(0.060 - absSpeed * 0.0015, 0.028, 0.060);
      }
      state.sandGritTimer -= dt;
      if (state.sandGritTimer <= 0) {
        emitVehicleSandGrit(actor, liveWorld, speed, sandWheelsScratch);
        state.sandGritTimer = clamp(0.046 - absSpeed * 0.0012, 0.022, 0.046);
      }
    } else {
      state.sandDustTimer = 0;
      state.sandGritTimer = 0;
    }
  }

  function orientBillboardMeshes(cameraObj) {
    const anyLive = liveSplashCount > 0 || liveDustCount > 0 || liveGritCount > 0;
    let b0x = 1, b0y = 0, b0z = 0;
    let b1x = 0, b1y = 1, b1z = 0;
    let b2x = 0, b2y = 0, b2z = 1;
    if (anyLive && cameraObj?.quaternion) {
      billboardBaseQuat.copy(cameraObj.quaternion);
      const qx = billboardBaseQuat.x;
      const qy = billboardBaseQuat.y;
      const qz = billboardBaseQuat.z;
      const qw = billboardBaseQuat.w;
      const x2 = qx + qx;
      const y2 = qy + qy;
      const z2 = qz + qz;
      const xx = qx * x2;
      const xy = qx * y2;
      const xz = qx * z2;
      const yy = qy * y2;
      const yz = qy * z2;
      const zz = qz * z2;
      const wx = qw * x2;
      const wy = qw * y2;
      const wz = qw * z2;
      b0x = 1 - (yy + zz);
      b0y = xy + wz;
      b0z = xz - wy;
      b1x = xy - wz;
      b1y = 1 - (xx + zz);
      b1z = yz + wx;
      b2x = xz + wy;
      b2y = yz - wx;
      b2z = 1 - (xx + yy);
    }

    waterSplashMesh.count = 0;
    if (liveSplashCount > 0) {
      const splashMatArr = waterSplashMesh.instanceMatrix.array;
      for (let i = 0; i < waterSlots.length; i++) {
        const s = waterSlots[i];
        if (!s.active) continue;
        const u = clamp(s.ageS / s.ttlS, 0, 1);
        const scale = lerp(s.startScale, s.endScale, 1 - (1 - u) * (1 - u));
        const fadeIn = smoothstep(0, 0.10, u);
        const fadeOut = Math.pow(1 - u, 1.45);
        const alpha = clamp(s.peakAlpha * fadeIn * fadeOut, 0, 1);

        const cr = Math.cos(s.roll);
        const sr = Math.sin(s.roll);
        const sx = scale * 1.08;
        const sy = scale * 0.95;
        const idx = waterSplashMesh.count++;
        const off = idx * 16;
        splashMatArr[off + 0] = (b0x * cr + b1x * sr) * sx;
        splashMatArr[off + 1] = (b0y * cr + b1y * sr) * sx;
        splashMatArr[off + 2] = (b0z * cr + b1z * sr) * sx;
        splashMatArr[off + 3] = 0;
        splashMatArr[off + 4] = (-b0x * sr + b1x * cr) * sy;
        splashMatArr[off + 5] = (-b0y * sr + b1y * cr) * sy;
        splashMatArr[off + 6] = (-b0z * sr + b1z * cr) * sy;
        splashMatArr[off + 7] = 0;
        splashMatArr[off + 8] = b2x;
        splashMatArr[off + 9] = b2y;
        splashMatArr[off + 10] = b2z;
        splashMatArr[off + 11] = 0;
        splashMatArr[off + 12] = s.x;
        splashMatArr[off + 13] = s.y;
        splashMatArr[off + 14] = s.z;
        splashMatArr[off + 15] = 1;
        splashAlphas[idx] = alpha;
      }
    }
    if (waterSplashMesh.count > 0 || prevSplashCount > 0) {
      const span = Math.max(waterSplashMesh.count, prevSplashCount);
      for (let i = waterSplashMesh.count; i < span; i++) splashAlphas[i] = 0;
      flagInstancedAttrDirty(waterSplashMesh.instanceMatrix, span);
      flagInstancedAttrDirty(splashAlphaAttr, span);
      prevSplashCount = waterSplashMesh.count;
    }

    sandDustMesh.count = 0;
    if (liveDustCount > 0) {
      const dustMatArr = sandDustMesh.instanceMatrix.array;
      for (let i = 0; i < sandSlots.length; i++) {
        const s = sandSlots[i];
        if (!s.active) continue;
        const u = clamp(s.ageS / s.ttlS, 0, 1);
        const growT = 1 - Math.pow(1 - u, 2.2);
        const scale = lerp(s.startScale, s.endScale, growT);
        const fadeIn = smoothstep(0, 0.12, u);
        const fadeOut = Math.pow(1 - u, 1.35);
        const alpha = clamp(s.peakAlpha * fadeIn * fadeOut, 0, 1);

        const cr = Math.cos(s.roll);
        const sr = Math.sin(s.roll);
        const sx = scale * 1.10;
        const sy = scale * 0.92;
        const idx = sandDustMesh.count++;
        const off = idx * 16;
        dustMatArr[off + 0] = (b0x * cr + b1x * sr) * sx;
        dustMatArr[off + 1] = (b0y * cr + b1y * sr) * sx;
        dustMatArr[off + 2] = (b0z * cr + b1z * sr) * sx;
        dustMatArr[off + 3] = 0;
        dustMatArr[off + 4] = (-b0x * sr + b1x * cr) * sy;
        dustMatArr[off + 5] = (-b0y * sr + b1y * cr) * sy;
        dustMatArr[off + 6] = (-b0z * sr + b1z * cr) * sy;
        dustMatArr[off + 7] = 0;
        dustMatArr[off + 8] = b2x;
        dustMatArr[off + 9] = b2y;
        dustMatArr[off + 10] = b2z;
        dustMatArr[off + 11] = 0;
        dustMatArr[off + 12] = s.x;
        dustMatArr[off + 13] = s.y;
        dustMatArr[off + 14] = s.z;
        dustMatArr[off + 15] = 1;
        dustAlphas[idx] = alpha;
      }
    }
    if (sandDustMesh.count > 0 || prevDustCount > 0) {
      const span = Math.max(sandDustMesh.count, prevDustCount);
      for (let i = sandDustMesh.count; i < span; i++) dustAlphas[i] = 0;
      flagInstancedAttrDirty(sandDustMesh.instanceMatrix, span);
      flagInstancedAttrDirty(dustAlphaAttr, span);
      prevDustCount = sandDustMesh.count;
    }

    sandGritMesh.count = 0;
    if (liveGritCount > 0) {
      const gritMatArr = sandGritMesh.instanceMatrix.array;
      for (let i = 0; i < gritSlots.length; i++) {
        const s = gritSlots[i];
        if (!s.active) continue;
        const u = clamp(s.ageS / s.ttlS, 0, 1);
        const alpha = clamp(1 - smoothstep(0.55, 1.0, u), 0, 1);

        const cr = Math.cos(s.roll);
        const sr = Math.sin(s.roll);
        const sc = s.scale;
        const idx = sandGritMesh.count++;
        const off = idx * 16;
        gritMatArr[off + 0] = (b0x * cr + b1x * sr) * sc;
        gritMatArr[off + 1] = (b0y * cr + b1y * sr) * sc;
        gritMatArr[off + 2] = (b0z * cr + b1z * sr) * sc;
        gritMatArr[off + 3] = 0;
        gritMatArr[off + 4] = (-b0x * sr + b1x * cr) * sc;
        gritMatArr[off + 5] = (-b0y * sr + b1y * cr) * sc;
        gritMatArr[off + 6] = (-b0z * sr + b1z * cr) * sc;
        gritMatArr[off + 7] = 0;
        gritMatArr[off + 8] = b2x;
        gritMatArr[off + 9] = b2y;
        gritMatArr[off + 10] = b2z;
        gritMatArr[off + 11] = 0;
        gritMatArr[off + 12] = s.x;
        gritMatArr[off + 13] = s.y;
        gritMatArr[off + 14] = s.z;
        gritMatArr[off + 15] = 1;
        gritAlphas[idx] = alpha;
      }
    }
    if (sandGritMesh.count > 0 || prevGritCount > 0) {
      const span = Math.max(sandGritMesh.count, prevGritCount);
      for (let i = sandGritMesh.count; i < span; i++) gritAlphas[i] = 0;
      flagInstancedAttrDirty(sandGritMesh.instanceMatrix, span);
      flagInstancedAttrDirty(gritAlphaAttr, span);
      prevGritCount = sandGritMesh.count;
    }
  }

  function syncFxMeshes(cameraObj = null) {
    waterRippleMesh.count = 0;
    if (liveRippleCount > 0) {
      for (let i = 0; i < rippleSlots.length; i++) {
        const s = rippleSlots[i];
        if (!s.active) continue;
        const u = clamp(s.ageS / s.ttlS, 0, 1);
        const expandT = 1 - (1 - u) * (1 - u);
        const scale = lerp(s.startScale, s.endScale, expandT);
        const alpha = clamp(s.peakAlpha * Math.pow(1 - u, 1.30), 0, 0.60);

        terrainNormal.set(s.nx, s.ny, s.nz);
        yawQuat.setFromAxisAngle(upAxis, s.yaw);
        tiltQuat.setFromUnitVectors(upAxis, terrainNormal);
        dummy.quaternion.multiplyQuaternions(tiltQuat, yawQuat);
        dummy.position.set(s.x, s.y, s.z);
        dummy.scale.set(scale, 1, scale * (s.aspectZ ?? 1));
        dummy.updateMatrix();

        const idx = waterRippleMesh.count++;
        waterRippleMesh.setMatrixAt(idx, dummy.matrix);
        rippleAlphas[idx] = alpha;
      }
    }
    if (waterRippleMesh.count > 0 || prevRippleCount > 0) {
      const span = Math.max(waterRippleMesh.count, prevRippleCount);
      for (let i = waterRippleMesh.count; i < span; i++) rippleAlphas[i] = 0;
      flagInstancedAttrDirty(waterRippleMesh.instanceMatrix, span);
      flagInstancedAttrDirty(rippleAlphaAttr, span);
      prevRippleCount = waterRippleMesh.count;
    }

    orientBillboardMeshes(cameraObj);
  }

  // Ensure live WebGL rendering orients billboards to active render camera even when update() omits camera
  const autoBillboardHook = (_renderer, _scene, renderCam) => {
    if (
      !hadExplicitCameraThisFrame &&
      renderCam?.quaternion &&
      autoOrientedCam !== renderCam &&
      (liveSplashCount > 0 || liveDustCount > 0 || liveGritCount > 0)
    ) {
      autoOrientedCam = renderCam;
      orientBillboardMeshes(renderCam);
    }
  };
  waterSplashMesh.onBeforeRender = autoBillboardHook;
  sandDustMesh.onBeforeRender = autoBillboardHook;
  sandGritMesh.onBeforeRender = autoBillboardHook;

  function stepFxKinematics(liveWorld, dt, cameraObj) {
    const hasElev =
      typeof liveWorld?.terrainElevationAt === "function" ||
      typeof liveWorld?.elevationAt === "function";

    if (liveRippleCount > 0) {
      for (let i = 0; i < rippleSlots.length; i++) {
        const s = rippleSlots[i];
        if (!s.active) continue;
        s.ageS += dt;
        if (s.ageS >= s.ttlS) {
          s.active = false;
          liveRippleCount--;
        }
      }
    }

    if (liveSplashCount > 0) {
      const sprayDrag = Math.exp(-1.9 * dt);
      for (let i = 0; i < waterSlots.length; i++) {
        const s = waterSlots[i];
        if (!s.active) continue;
        s.ageS += dt;
        if (s.ageS >= s.ttlS) {
          s.active = false;
          liveSplashCount--;
          continue;
        }
        s.vy -= GRAVITY_MPS2 * 1.25 * dt;
        s.vx *= sprayDrag;
        s.vz *= sprayDrag;
        s.x += s.vx * dt;
        s.y += s.vy * dt;
        s.z += s.vz * dt;
        s.roll += s.vroll * dt;
        const floorY = hasElev
          ? Math.max(s.groundY, WATER_CORE_Y + elevAt(liveWorld, s.x, s.z))
          : Math.max(s.groundY, WATER_CORE_Y);
        if (s.y <= floorY && s.ageS > 0.05) {
          s.active = false;
          liveSplashCount--;
        }
      }
    }

    if (liveDustCount > 0) {
      const dustDrag = Math.exp(-1.55 * dt);
      const dustVertDrag = Math.exp(-0.95 * dt);
      for (let i = 0; i < sandSlots.length; i++) {
        const s = sandSlots[i];
        if (!s.active) continue;
        s.ageS += dt;
        if (s.ageS >= s.ttlS) {
          s.active = false;
          liveDustCount--;
          continue;
        }
        const curlX = Math.cos(s.curlPhase + s.ageS * s.curlFreq) * s.curlAmp;
        const curlZ = Math.sin(s.curlPhase + s.ageS * s.curlFreq) * s.curlAmp;
        s.x += (s.vx + curlX) * dt;
        s.y += s.vy * dt;
        s.z += (s.vz + curlZ) * dt;
        s.vx *= dustDrag;
        s.vz *= dustDrag;
        s.vy *= dustVertDrag;
        s.roll += s.vroll * dt;
        const minFloorY = hasElev
          ? SAND_BASE_Y + 0.08 + elevAt(liveWorld, s.x, s.z)
          : SAND_BASE_Y + 0.08;
        if (s.y < minFloorY) s.y = minFloorY;
      }
    }

    if (liveGritCount > 0) {
      for (let i = 0; i < gritSlots.length; i++) {
        const s = gritSlots[i];
        if (!s.active) continue;
        s.ageS += dt;
        if (s.ageS >= s.ttlS) {
          s.active = false;
          liveGritCount--;
          continue;
        }
        s.vy -= GRAVITY_MPS2 * 1.18 * dt;
        s.x += s.vx * dt;
        s.y += s.vy * dt;
        s.z += s.vz * dt;
        s.roll += s.vroll * dt;
        const floorY = hasElev
          ? Math.max(s.groundY, SAND_BASE_Y + 0.018 + elevAt(liveWorld, s.x, s.z))
          : Math.max(s.groundY, SAND_BASE_Y + 0.018);
        if (s.y <= floorY && s.ageS > 0.04) {
          s.active = false;
          liveGritCount--;
        }
      }
    }

    wetTrackBuffer.step(dt);
    sandRutBuffer.step(dt);
    syncFxMeshes(cameraObj);
  }

  function updateStreamedProps(cameraObj) {
    if (!cameraObj?.position || streamedPropBatches.length === 0) return;
    const cx = cameraObj.position.x;
    const cz = cameraObj.position.z;
    if (!Number.isFinite(cx) || !Number.isFinite(cz)) return;
    if (
      Number.isFinite(lastPropStreamX) &&
      (cx - lastPropStreamX) * (cx - lastPropStreamX) +
        (cz - lastPropStreamZ) * (cz - lastPropStreamZ) <
        PROP_STREAM_MIN_MOVE_SQ
    ) {
      return;
    }
    lastPropStreamX = cx;
    lastPropStreamZ = cz;
    for (let b = 0; b < streamedPropBatches.length; b++) {
      const batch = streamedPropBatches[b];
      const { mesh, entries, fullMatrices, selectedIndices } = batch;
      let count = 0;
      let sameSelection = batch.selectedCount >= 0;
      for (let i = 0; i < entries.length; i++) {
        const dx = entries[i].x - cx;
        const dz = entries[i].z - cz;
        if (dx * dx + dz * dz <= PROP_STREAM_RADIUS_SQ) {
          if (sameSelection && (count >= batch.selectedCount || selectedIndices[count] !== i)) {
            sameSelection = false;
          }
          selectedIndices[count++] = i;
        }
      }
      if (sameSelection && count === batch.selectedCount) {
        continue;
      }
      const dst = mesh.instanceMatrix.array;
      for (let c = 0; c < count; c++) {
        const srcOff = selectedIndices[c] * 16;
        const dstOff = c * 16;
        for (let k = 0; k < 16; k++) dst[dstOff + k] = fullMatrices[srcOff + k];
      }
      const prevStreamCount = batch.prevCount;
      batch.selectedCount = count;
      batch.prevCount = count;
      mesh.count = count;
      mesh.frustumCulled = false;
      if (count > 0 || prevStreamCount > 0) {
        flagInstancedAttrDirty(mesh.instanceMatrix, Math.max(count, prevStreamCount));
      }
    }
  }

  function update(liveWorld = world, dt = 1 / 60, camera = null) {
    if (disposed) return;
    const activeWorld = liveWorld ?? world;
    if (activeWorld?.terrain === terrain && !canUseIndexedTerrain(terrain)) {
      syncDynamicTerrainGeometries(activeWorld);
    }
    hadExplicitCameraThisFrame = Boolean(camera?.quaternion);
    autoOrientedCam = null;
    updateStreamedProps(camera);
    if (dt === 0) {
      orientBillboardMeshes(camera);
      return;
    }
    const stepDt = Number.isFinite(dt) && dt > 0 ? Math.min(dt, 0.1) : 1 / 60;
    fxStepCounter++;
    if (fxStepCounter % 240 === 0 && actorStates.size > 160) {
      actorStates.forEach(pruneStaleActorState);
    }

    waterUniforms.uWaveTime.value += stepDt;

    seenActors.clear();
    const player = activeWorld?.player;
    const hasPlayer = Boolean(player && Number.isFinite(player.x) && Number.isFinite(player.z));
    const px = hasPlayer ? player.x : 0;
    const pz = hasPlayer ? player.z : 0;

    inUpdatePassValid = activeWorld?.terrain === terrain && terrain !== null;
    try {
      if (player) {
        considerVehicleActor(player, activeWorld, px, pz, true, stepDt);
      }
      if (Array.isArray(activeWorld?.actors)) {
        for (let i = 0; i < activeWorld.actors.length; i++) {
          considerVehicleActor(activeWorld.actors[i], activeWorld, px, pz, hasPlayer, stepDt);
        }
      }
    } finally {
      inUpdatePassValid = false;
    }
    if (Array.isArray(activeWorld?.vehicles)) {
      for (let i = 0; i < activeWorld.vehicles.length; i++) {
        considerVehicleActor(activeWorld.vehicles[i], activeWorld, px, pz, hasPlayer, stepDt);
      }
    }
    const patrols = activeWorld?.pursuit?.patrols;
    if (patrols && typeof patrols[Symbol.iterator] === "function") {
      for (const patrol of patrols) {
        considerVehicleActor(patrol, activeWorld, px, pz, hasPlayer, stepDt);
      }
    }

    stepFxKinematics(activeWorld, stepDt, camera);
  }

  function reset() {
    if (disposed) return;
    waterUniforms.uWaveTime.value = 0;
    if (liveRippleCount > 0) {
      for (let i = 0; i < rippleSlots.length; i++) rippleSlots[i].active = false;
    }
    if (liveSplashCount > 0) {
      for (let i = 0; i < waterSlots.length; i++) waterSlots[i].active = false;
    }
    if (liveDustCount > 0) {
      for (let i = 0; i < sandSlots.length; i++) sandSlots[i].active = false;
    }
    if (liveGritCount > 0) {
      for (let i = 0; i < gritSlots.length; i++) gritSlots[i].active = false;
    }
    liveRippleCount = 0;
    liveSplashCount = 0;
    liveDustCount = 0;
    liveGritCount = 0;
    rippleCursor = 0;
    waterCursor = 0;
    sandCursor = 0;
    gritCursor = 0;

    const rSpan = Math.max(waterRippleMesh.count, prevRippleCount);
    const wSpan = Math.max(waterSplashMesh.count, prevSplashCount);
    const dSpan = Math.max(sandDustMesh.count, prevDustCount);
    const gSpan = Math.max(sandGritMesh.count, prevGritCount);
    waterRippleMesh.count = 0;
    waterSplashMesh.count = 0;
    sandDustMesh.count = 0;
    sandGritMesh.count = 0;
    prevRippleCount = 0;
    prevSplashCount = 0;
    prevDustCount = 0;
    prevGritCount = 0;

    if (rSpan > 0) {
      rippleAlphas.fill(0, 0, rSpan);
      flagInstancedAttrDirty(waterRippleMesh.instanceMatrix, rSpan);
      flagInstancedAttrDirty(rippleAlphaAttr, rSpan);
    }
    if (wSpan > 0) {
      splashAlphas.fill(0, 0, wSpan);
      flagInstancedAttrDirty(waterSplashMesh.instanceMatrix, wSpan);
      flagInstancedAttrDirty(splashAlphaAttr, wSpan);
    }
    if (dSpan > 0) {
      dustAlphas.fill(0, 0, dSpan);
      flagInstancedAttrDirty(sandDustMesh.instanceMatrix, dSpan);
      flagInstancedAttrDirty(dustAlphaAttr, dSpan);
    }
    if (gSpan > 0) {
      gritAlphas.fill(0, 0, gSpan);
      flagInstancedAttrDirty(sandGritMesh.instanceMatrix, gSpan);
      flagInstancedAttrDirty(gritAlphaAttr, gSpan);
    }

    wetTrackBuffer.reset();
    sandRutBuffer.reset();
    actorStates.clear();
    seenActors.clear();
    autoOrientedCam = null;
  }

  function setSensorCleanMode(clean) {
    if (disposed) return;
    const vis = !clean;
    fxGroup.visible = vis;
    if (lampPoolsMesh) lampPoolsMesh.visible = vis;
    if (lampBulbHalos) lampBulbHalos.visible = vis;
  }

  function setPreviewThumbnailMode(lite) {
    if (disposed) return;
    const vis = !lite;
    for (let b = 0; b < streamedPropBatches.length; b++) {
      streamedPropBatches[b].mesh.visible = vis;
    }
    if (lampBulbHalos) lampBulbHalos.visible = vis;
  }

  function diagnostics() {
    return {
      active: true,
      drawCalls,
      waterPuddleCount: waterPuddles.length,
      sandZoneCount: sandZones.length,
      cobbleZoneCount: cobbleZones.length,
      manholeCount,
      lampPoolCount: lampPoolsMesh ? lampPoolsMesh.count : 0,
      lampBulbHaloCount: lampBulbHalos ? lampBulbHalos.geometry.attributes.position.count : 0,
      streetLampCount: propPlacements.lamps.length,
      streetTreeCount: propPlacements.trees.length,
      furnitureCount: propPlacements.furniture.length,
      propCounts: {
        lamps: propPlacements.lamps.length,
        trees: propPlacements.trees.length,
        furniture: propPlacements.furniture.length,
      },
      activeWaterRipples: liveRippleCount,
      activeWaterSplashes: liveSplashCount,
      activeWetTrackSegments: wetTrackBuffer.getActiveCount(),
      activeSandRutSegments: sandRutBuffer.getActiveCount(),
      activeSandDust: liveDustCount,
      activeSandGrit: liveGritCount,
      waterRoughness: waterMaterial.roughness,
      waterBaseOpacity: waterMaterial.opacity,
      waterEnvMapIntensity: waterMaterial.envMapIntensity,
      hasFresnelWaterShader:
        typeof waterMaterial.onBeforeCompile === "function" &&
        String(waterMaterial.onBeforeCompile).includes("puddleFresnel") &&
        String(waterMaterial.onBeforeCompile).includes("5.0"),
      billboardSprayAndDust:
        waterSplashMesh.geometry?.type === "PlaneGeometry" &&
        sandDustMesh.geometry?.type === "PlaneGeometry",
      hasDynamicSandRuts: Boolean(sandRutBuffer.mesh?.visible && sandDustMesh.visible),
      sandRoughness: sandMaterial.roughness,
      hasWaterBumpMap: Boolean(waterMaterial.bumpMap?.isDataTexture),
      hasSandBumpMap: Boolean(sandMaterial.bumpMap?.isDataTexture),
      hasCobbleBumpMap: Boolean(cobbleMaterial.bumpMap?.isDataTexture),
    };
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    reset();
    for (const geo of ownedGeometries) geo.dispose();
    for (const mat of ownedMaterials) mat.dispose();
    for (const tex of ownedTextures) tex.dispose();
    for (const im of ownedInstancedMeshes) im.dispose();
    ownedGeometries.clear();
    ownedMaterials.clear();
    ownedTextures.clear();
    ownedInstancedMeshes.clear();
    fxGroup.clear();
    root.removeFromParent();
    root.clear();
  }

  return {
    root,
    group: root,
    fxGroup,
    lampPoolsMesh,
    lampBulbHalos,
    waterRipples: waterRippleMesh,
    waterSplashes: waterSplashMesh,
    wetTireTracks: wetTrackBuffer.mesh,
    sandTireRuts: sandRutBuffer.mesh,
    sandDust: sandDustMesh,
    sandGrit: sandGritMesh,
    get reflectionPlanes() { return reflectionPlanes; },
    setLiveReflection,
    resolveSurfaceAt,
    setSensorCleanMode,
    setPreviewThumbnailMode,
    update,
    diagnostics,
    reset,
    dispose,
  };
}
