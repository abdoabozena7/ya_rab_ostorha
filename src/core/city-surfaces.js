import { clamp } from "./config.js";

const HALF_PI = Math.PI / 2;
const CELL_SIZE_M = 32;
const INV_CELL_SIZE = 1 / CELL_SIZE_M;

const DIAG_TALAAT = Math.atan2(298, 238 - (-112 - 4750 / 29));
const DIAG_BAZAAR = Math.atan2(124 - 300, 90 - -112);
const DIAG_CITADEL = Math.atan2(420 - -96, -112 - -420);

export const SURFACE_SPECS = Object.freeze({
  asphalt: Object.freeze({
    kind: "asphalt",
    label: "Asphalt",
    gripMultiplier: 1.0,
    rollingDragMps2: 0.0,
    hydroDragCoeff: 0.0,
    roughnessAmp: 0.002,
    roughnessFreq: 6.0,
  }),
  cobble: Object.freeze({
    kind: "cobble",
    label: "Cobblestone & curb",
    gripMultiplier: 0.87,
    rollingDragMps2: 0.36,
    hydroDragCoeff: 0.0,
    roughnessAmp: 0.018,
    roughnessFreq: 19.0,
  }),
  sand: Object.freeze({
    kind: "sand",
    label: "Sandy street",
    gripMultiplier: 0.62,
    rollingDragMps2: 2.45,
    hydroDragCoeff: 0.012,
    roughnessAmp: 0.025,
    roughnessFreq: 8.5,
  }),
  water: Object.freeze({
    kind: "water",
    label: "Standing water",
    gripMultiplier: 0.52,
    rollingDragMps2: 0.78,
    hydroDragCoeff: 0.052,
    roughnessAmp: 0.007,
    roughnessFreq: 11.0,
  }),
});

const DEFAULT_HILLS = Object.freeze([
  {
    id: "tahrir-overpass-ramp",
    label: "Tahrir Overpass Ramp",
    x: 24,
    z: -112,
    rx: 92,
    rz: 46,
    angle: 0,
    heightM: 3.2,
  },
  {
    id: "citadel-ridge",
    label: "Citadel & Mokattam Ridge",
    x: 355,
    z: -210,
    rx: 165,
    rz: 190,
    angle: -0.45,
    heightM: 4.4,
  },
  {
    id: "ramses-flyover",
    label: "Ramses Flyover",
    x: 88,
    z: 238,
    rx: 105,
    rz: 52,
    angle: 0.55,
    heightM: 2.9,
  },
  {
    id: "nile-corniche-rise",
    label: "Nile Corniche Rise",
    x: -278,
    z: 65,
    rx: 54,
    rz: 110,
    angle: 0,
    heightM: 2.4,
  },
  {
    id: "garden-city-knoll",
    label: "Garden City Knoll",
    x: -215,
    z: -312,
    rx: 95,
    rz: 58,
    angle: 0,
    heightM: 2.3,
  },
  {
    id: "opera-approach-ramp",
    label: "Opera Approach Ramp",
    x: -380,
    z: -165,
    rx: 44,
    rz: 52,
    angle: 0,
    heightM: 2.5,
  },
  {
    id: "azhar-bazaar-rise",
    label: "Al-Azhar & Bazaar Rise",
    x: 188,
    z: 28,
    rx: 54,
    rz: 88,
    angle: 0,
    heightM: 2.6,
  },
  {
    id: "qasr-nile-embankment",
    label: "Qasr El-Nil Embankment",
    x: -435,
    z: 114,
    rx: 68,
    rz: 82,
    angle: -0.68,
    heightM: 2.7,
  },
]);

const DEFAULT_WATER_PUDDLES = Object.freeze([
  {
    id: "tahrir-west-puddle",
    kind: "water",
    shape: "ellipse",
    roadId: "tahrir-boulevard",
    x: -156,
    z: -109.2,
    heading: HALF_PI,
    halfWidth: 2.7,
    halfLength: 7.6,
    depthM: 0.035,
    intensity: 0.95,
  },
  {
    id: "tahrir-gutter-puddle",
    kind: "water",
    shape: "ellipse",
    roadId: "tahrir-boulevard",
    x: -142,
    z: -114.6,
    heading: HALF_PI,
    halfWidth: 3.2,
    halfLength: 8.0,
    depthM: 0.03,
    intensity: 0.9,
  },
  {
    id: "tahrir-ramp-west-basin",
    kind: "water",
    shape: "ellipse",
    roadId: "tahrir-boulevard",
    x: -74,
    z: -113.2,
    heading: HALF_PI,
    halfWidth: 4.1,
    halfLength: 10.5,
    depthM: 0.04,
    intensity: 0.94,
  },
  {
    id: "tahrir-ramp-east-basin",
    kind: "water",
    shape: "ellipse",
    roadId: "tahrir-boulevard",
    x: 122,
    z: -109.8,
    heading: HALF_PI,
    halfWidth: 4.0,
    halfLength: 10.0,
    depthM: 0.038,
    intensity: 0.92,
  },
  {
    id: "corniche-south-puddle",
    kind: "water",
    shape: "ellipse",
    roadId: "corniche-avenue",
    x: -275.4,
    z: -198,
    heading: 0,
    halfWidth: 3.9,
    halfLength: 11.0,
    depthM: 0.036,
    intensity: 0.92,
  },
  {
    id: "corniche-north-basin",
    kind: "water",
    shape: "strip",
    roadId: "corniche-avenue",
    x: -280.6,
    z: 184,
    heading: 0,
    halfWidth: 3.6,
    halfLength: 14.0,
    depthM: 0.042,
    intensity: 0.96,
  },
  {
    id: "civic-mid-puddle",
    kind: "water",
    shape: "ellipse",
    roadId: "civic-avenue",
    x: -180.6,
    z: -34,
    heading: 0,
    halfWidth: 3.5,
    halfLength: 9.2,
    depthM: 0.032,
    intensity: 0.88,
  },
  {
    id: "civic-hospital-puddle",
    kind: "water",
    shape: "ellipse",
    roadId: "civic-avenue",
    x: -185.2,
    z: 146,
    heading: 0,
    halfWidth: 3.7,
    halfLength: 10.4,
    depthM: 0.035,
    intensity: 0.9,
  },
  {
    id: "station-west-puddle",
    kind: "water",
    shape: "ellipse",
    roadId: "station-avenue",
    x: -242,
    z: -72.8,
    heading: HALF_PI,
    halfWidth: 3.6,
    halfLength: 9.8,
    depthM: 0.034,
    intensity: 0.91,
  },
  {
    id: "station-east-puddle",
    kind: "water",
    shape: "strip",
    roadId: "station-avenue",
    x: -138,
    z: -77.2,
    heading: HALF_PI,
    halfWidth: 3.4,
    halfLength: 11.5,
    depthM: 0.033,
    intensity: 0.89,
  },
  {
    id: "university-west-puddle",
    kind: "water",
    shape: "ellipse",
    roadId: "university-avenue",
    x: -332,
    z: 92.2,
    heading: HALF_PI,
    halfWidth: 3.8,
    halfLength: 10.6,
    depthM: 0.036,
    intensity: 0.92,
  },
  {
    id: "university-central-puddle",
    kind: "water",
    shape: "ellipse",
    roadId: "university-avenue",
    x: -44,
    z: 87.6,
    heading: HALF_PI,
    halfWidth: 3.6,
    halfLength: 9.4,
    depthM: 0.031,
    intensity: 0.87,
  },
  {
    id: "gateway-south-puddle",
    kind: "water",
    shape: "ellipse",
    roadId: "gateway-avenue",
    x: -93.6,
    z: -246,
    heading: 0,
    halfWidth: 3.5,
    halfLength: 9.6,
    depthM: 0.034,
    intensity: 0.9,
  },
  {
    id: "gateway-station-basin",
    kind: "water",
    shape: "strip",
    roadId: "gateway-avenue",
    x: -98.4,
    z: 162,
    heading: 0,
    halfWidth: 3.7,
    halfLength: 12.5,
    depthM: 0.039,
    intensity: 0.93,
  },
  {
    id: "clot-bey-west-puddle",
    kind: "water",
    shape: "ellipse",
    roadId: "clot-bey-avenue",
    x: -148,
    z: 240.3,
    heading: HALF_PI,
    halfWidth: 3.7,
    halfLength: 10.8,
    depthM: 0.035,
    intensity: 0.9,
  },
  {
    id: "clot-bey-flyover-basin",
    kind: "water",
    shape: "strip",
    roadId: "clot-bey-avenue",
    x: -22,
    z: 235.6,
    heading: HALF_PI,
    halfWidth: 3.9,
    halfLength: 13.0,
    depthM: 0.041,
    intensity: 0.95,
  },
  {
    id: "opera-ramp-basin",
    kind: "water",
    shape: "ellipse",
    roadId: "opera-avenue",
    x: -377.5,
    z: -226,
    heading: 0,
    halfWidth: 3.6,
    halfLength: 10.2,
    depthM: 0.037,
    intensity: 0.91,
  },
  {
    id: "garden-city-basin",
    kind: "water",
    shape: "ellipse",
    roadId: "garden-city-avenue",
    x: -108,
    z: -314.2,
    heading: HALF_PI,
    halfWidth: 3.8,
    halfLength: 10.4,
    depthM: 0.035,
    intensity: 0.9,
  },
  {
    id: "nile-west-embankment-puddle",
    kind: "water",
    shape: "strip",
    roadId: "nile-west-boulevard",
    x: -517.4,
    z: -38,
    heading: 0,
    halfWidth: 3.8,
    halfLength: 13.5,
    depthM: 0.04,
    intensity: 0.94,
  },
  {
    id: "ramses-north-curb-puddle",
    kind: "water",
    shape: "ellipse",
    roadId: "ramses-north-arterial",
    x: 156,
    z: 357.4,
    heading: HALF_PI,
    halfWidth: 4.0,
    halfLength: 11.2,
    depthM: 0.036,
    intensity: 0.91,
  },
]);

const DEFAULT_SAND_ZONES = Object.freeze([
  {
    id: "tahrir-sand-drift",
    kind: "sand",
    shape: "ellipse",
    roadId: "tahrir-boulevard",
    x: -108,
    z: -110.2,
    heading: HALF_PI + 0.08,
    halfWidth: 5.2,
    halfLength: 14.5,
    depthM: 0.04,
    intensity: 0.92,
  },
  {
    id: "souq-west-sand-stretch",
    kind: "sand",
    shape: "strip",
    roadId: "souq-collector",
    x: -228,
    z: 8,
    heading: HALF_PI,
    halfWidth: 5.1,
    halfLength: 32.0,
    depthM: 0.045,
    intensity: 0.95,
  },
  {
    id: "souq-east-sand-stretch",
    kind: "sand",
    shape: "strip",
    roadId: "souq-collector",
    x: -165,
    z: 8,
    heading: HALF_PI,
    halfWidth: 5.1,
    halfLength: 31.0,
    depthM: 0.042,
    intensity: 0.93,
  },
  {
    id: "hussein-west-sand-stretch",
    kind: "sand",
    shape: "strip",
    roadId: "hussein-collector",
    x: 210,
    z: 158,
    heading: HALF_PI,
    halfWidth: 4.9,
    halfLength: 60.0,
    depthM: 0.046,
    intensity: 0.95,
  },
  {
    id: "hussein-east-sand-stretch",
    kind: "sand",
    shape: "strip",
    roadId: "hussein-collector",
    x: 330,
    z: 158,
    heading: HALF_PI,
    halfWidth: 4.9,
    halfLength: 60.0,
    depthM: 0.05,
    intensity: 0.97,
  },
  {
    id: "bazaar-slash-south-sand",
    kind: "sand",
    shape: "strip",
    roadId: "bazaar-slash",
    x: 256,
    z: -61.5,
    heading: DIAG_BAZAAR,
    halfWidth: 4.4,
    halfLength: 38.0,
    depthM: 0.044,
    intensity: 0.94,
  },
  {
    id: "bazaar-slash-north-sand",
    kind: "sand",
    shape: "strip",
    roadId: "bazaar-slash",
    x: 176.8,
    z: 29.4,
    heading: DIAG_BAZAAR,
    halfWidth: 4.4,
    halfLength: 36.0,
    depthM: 0.042,
    intensity: 0.92,
  },
  {
    id: "citadel-east-south-sand",
    kind: "sand",
    shape: "strip",
    roadId: "citadel-east-ring",
    x: 420,
    z: -290,
    heading: 0,
    halfWidth: 6.2,
    halfLength: 58.0,
    depthM: 0.055,
    intensity: 0.98,
  },
  {
    id: "citadel-east-mid-sand",
    kind: "sand",
    shape: "strip",
    roadId: "citadel-east-ring",
    x: 420,
    z: -24,
    heading: 0,
    halfWidth: 6.0,
    halfLength: 52.0,
    depthM: 0.05,
    intensity: 0.96,
  },
  {
    id: "citadel-east-north-sand",
    kind: "sand",
    shape: "strip",
    roadId: "citadel-east-ring",
    x: 420,
    z: 245,
    heading: 0,
    halfWidth: 6.2,
    halfLength: 56.0,
    depthM: 0.052,
    intensity: 0.97,
  },
  {
    id: "south-ring-west-drift",
    kind: "sand",
    shape: "strip",
    roadId: "south-ring-arterial",
    x: -335,
    z: -420,
    heading: HALF_PI,
    halfWidth: 6.0,
    halfLength: 48.0,
    depthM: 0.048,
    intensity: 0.94,
  },
  {
    id: "south-ring-central-drift",
    kind: "sand",
    shape: "ellipse",
    roadId: "south-ring-arterial",
    x: 42,
    z: -418.8,
    heading: HALF_PI - 0.06,
    halfWidth: 5.6,
    halfLength: 34.0,
    depthM: 0.045,
    intensity: 0.92,
  },
  {
    id: "south-ring-east-drift",
    kind: "sand",
    shape: "strip",
    roadId: "south-ring-arterial",
    x: 315,
    z: -420,
    heading: HALF_PI,
    halfWidth: 6.2,
    halfLength: 54.0,
    depthM: 0.054,
    intensity: 0.97,
  },
  {
    id: "citadel-diag-ridge-drift",
    kind: "sand",
    shape: "strip",
    roadId: "citadel-diagonal",
    x: 265.2,
    z: -204.4,
    heading: DIAG_CITADEL,
    halfWidth: 5.6,
    halfLength: 44.0,
    depthM: 0.047,
    intensity: 0.95,
  },
  {
    id: "abbassia-desert-drift",
    kind: "sand",
    shape: "ellipse",
    roadId: "abbassia-avenue",
    x: 301.2,
    z: -265,
    heading: 0.06,
    halfWidth: 5.4,
    halfLength: 28.0,
    depthM: 0.043,
    intensity: 0.91,
  },
  {
    id: "ramses-east-sand-drift",
    kind: "sand",
    shape: "strip",
    roadId: "ramses-north-arterial",
    x: 348,
    z: 360,
    heading: HALF_PI,
    halfWidth: 5.8,
    halfLength: 42.0,
    depthM: 0.046,
    intensity: 0.93,
  },
]);

const DEFAULT_COBBLE_ZONES = Object.freeze([
  {
    id: "khan-market-south-cobble",
    kind: "cobble",
    shape: "strip",
    roadId: "khan-market-street",
    x: 124,
    z: -52,
    heading: 0,
    halfWidth: 5.3,
    halfLength: 44.0,
    depthM: 0.015,
    intensity: 0.95,
  },
  {
    id: "khan-market-mid-cobble",
    kind: "cobble",
    shape: "strip",
    roadId: "khan-market-street",
    x: 124,
    z: 58,
    heading: 0,
    halfWidth: 5.3,
    halfLength: 48.0,
    depthM: 0.016,
    intensity: 0.96,
  },
  {
    id: "khan-market-north-cobble",
    kind: "cobble",
    shape: "strip",
    roadId: "khan-market-street",
    x: 124,
    z: 176,
    heading: 0,
    halfWidth: 5.3,
    halfLength: 42.0,
    depthM: 0.015,
    intensity: 0.94,
  },
  {
    id: "bab-el-louk-south-cobble",
    kind: "cobble",
    shape: "strip",
    roadId: "bab-el-louk-link",
    x: -32,
    z: -246,
    heading: 0,
    halfWidth: 4.3,
    halfLength: 46.0,
    depthM: 0.014,
    intensity: 0.92,
  },
  {
    id: "bab-el-louk-north-cobble",
    kind: "cobble",
    shape: "strip",
    roadId: "bab-el-louk-link",
    x: -32,
    z: -138,
    heading: 0,
    halfWidth: 4.3,
    halfLength: 42.0,
    depthM: 0.014,
    intensity: 0.93,
  },
  {
    id: "qasr-el-aini-west-cobble",
    kind: "cobble",
    shape: "strip",
    roadId: "qasr-el-aini-collector",
    x: -308,
    z: -186,
    heading: HALF_PI,
    halfWidth: 4.9,
    halfLength: 46.0,
    depthM: 0.014,
    intensity: 0.91,
  },
  {
    id: "qasr-el-aini-east-cobble",
    kind: "cobble",
    shape: "strip",
    roadId: "qasr-el-aini-collector",
    x: -162,
    z: -186,
    heading: HALF_PI,
    halfWidth: 4.9,
    halfLength: 44.0,
    depthM: 0.014,
    intensity: 0.92,
  },
  {
    id: "talaat-south-cobble",
    kind: "cobble",
    shape: "strip",
    roadId: "talaat-diagonal",
    x: -236.3,
    z: -203.9,
    heading: DIAG_TALAAT,
    halfWidth: 5.6,
    halfLength: 34.0,
    depthM: 0.015,
    intensity: 0.93,
  },
  {
    id: "talaat-midan-cobble",
    kind: "cobble",
    shape: "strip",
    roadId: "talaat-diagonal",
    x: -123.0,
    z: -8.6,
    heading: DIAG_TALAAT,
    halfWidth: 5.8,
    halfLength: 36.0,
    depthM: 0.015,
    intensity: 0.94,
  },
  {
    id: "azhar-mosque-cobble",
    kind: "cobble",
    shape: "strip",
    roadId: "azhar-avenue",
    x: 188,
    z: -56,
    heading: 0,
    halfWidth: 5.8,
    halfLength: 38.0,
    depthM: 0.015,
    intensity: 0.95,
  },
]);

function cellKey(cx, cz) {
  return ((cx + 32768) << 16) | ((cz + 32768) & 0xffff);
}

function smoothstep01(t) {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t * t * (3 - 2 * t);
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function compileHill(raw) {
  const angle = raw.angle ?? 0;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const rx = Math.max(1, raw.rx);
  const rz = Math.max(1, raw.rz);
  return {
    id: raw.id,
    label: raw.label ?? raw.id,
    x: raw.x,
    z: raw.z,
    rx,
    rz,
    angle,
    heightM: Math.max(0, raw.heightM),
    cos,
    sin,
    invRx2: 1 / (rx * rx),
    invRz2: 1 / (rz * rz),
    boundX: Math.hypot(rx * cos, rz * sin),
    boundZ: Math.hypot(rx * sin, rz * cos),
  };
}

export function hashPuddleId(str) {
  let h = 2166136261;
  const s = String(str ?? "");
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  }
  return h >>> 0;
}

export function puddleOrganicScale(angle, seed) {
  const p1 = (seed & 0xff) * 0.0245;
  const p2 = ((seed >>> 8) & 0xff) * 0.0245;
  const p3 = ((seed >>> 16) & 0xff) * 0.0245;
  return (
    0.88 +
    0.07 * Math.sin(angle * 2 + p1) +
    0.04 * Math.cos(angle * 3 - p2) +
    0.03 * Math.sin(angle * 5 + p3)
  );
}

export function resolveZoneHalfWidth(zone) {
  return Number.isFinite(zone?.halfWidth) && zone.halfWidth > 0
    ? Math.max(0.25, zone.halfWidth)
    : Number.isFinite(zone?.width) && zone.width > 0
      ? Math.max(0.25, zone.width * 0.5)
      : 3.0;
}

export function resolveZoneHalfLength(zone) {
  return Number.isFinite(zone?.halfLength) && zone.halfLength > 0
    ? Math.max(0.25, zone.halfLength)
    : Number.isFinite(zone?.length) && zone.length > 0
      ? Math.max(0.25, zone.length * 0.5)
      : 4.8;
}

export function resolveSurfaceZoneHalfExtents(zone) {
  return { halfWidth: resolveZoneHalfWidth(zone), halfLength: resolveZoneHalfLength(zone) };
}

export function pointInWaterPuddle(x, z, zone, pIdx = 0, marginM = 0) {
  if (!zone || !Number.isFinite(x) || !Number.isFinite(z)) return false;
  const heading = zone.heading ?? 0;
  const halfWidth = typeof zone._compiledHW === "number" && zone.halfWidth === zone._compiledHW
    ? zone._compiledHW
    : resolveZoneHalfWidth(zone);
  const halfLength = typeof zone._compiledHL === "number" && zone.halfLength === zone._compiledHL
    ? zone._compiledHL
    : resolveZoneHalfLength(zone);
  const precompValid =
    zone._compiledHeading === heading &&
    zone._compiledHW === halfWidth &&
    zone._compiledHL === halfLength;
  if (precompValid && Number.isFinite(zone.boundX) && Number.isFinite(zone.boundZ)) {
    const padB = Math.max(0, marginM) + 0.25;
    if (Math.abs(x - zone.x) > zone.boundX + padB || Math.abs(z - zone.z) > zone.boundZ + padB) {
      return false;
    }
  }
  const cos = precompValid && Number.isFinite(zone.cos) ? zone.cos : Math.cos(heading);
  const sin = precompValid && Number.isFinite(zone.sin) ? zone.sin : Math.sin(heading);
  const dx = x - zone.x;
  const dz = z - zone.z;
  const lx = dx * cos - dz * sin;
  const lz = dx * sin + dz * cos;
  const pad = Math.max(0, marginM) + 0.25;
  if (Math.abs(lx) > halfWidth + pad || Math.abs(lz) > halfLength + pad) {
    return false;
  }
  const seed = Number.isFinite(zone.organicSeed)
    ? zone.organicSeed
    : hashPuddleId(zone.id ?? `puddle-${pIdx}`);
  const angRaw = Math.atan2(lx / halfWidth, lz / halfLength);
  const ang = angRaw < 0 ? angRaw + Math.PI * 2 : angRaw;
  // Exact polar match to buildWaterPuddleGeometries (coreRings outer visible edge ~ 0.94 * puddleOrganicScale)
  const lobe = puddleOrganicScale(ang, seed) * 0.94;
  const rx = halfWidth * lobe + marginM;
  const rz = halfLength * lobe + marginM;
  if (rx <= 0.04 || rz <= 0.04) return false;
  const d2 = (lx / rx) ** 2 + (lz / rz) ** 2;
  return marginM > 0 ? d2 <= 1.0 : d2 < 1.0;
}

export function pointInShapedSurfaceZone(x, z, zone) {
  if (!zone || !Number.isFinite(x) || !Number.isFinite(z)) return false;
  const heading = Number.isFinite(zone.heading) ? zone.heading : 0;
  const halfWidth = typeof zone._compiledHW === "number" && zone.halfWidth === zone._compiledHW
    ? zone._compiledHW
    : resolveZoneHalfWidth(zone);
  const halfLength = typeof zone._compiledHL === "number" && zone.halfLength === zone._compiledHL
    ? zone._compiledHL
    : resolveZoneHalfLength(zone);
  const precompValid =
    zone._compiledHeading === heading &&
    zone._compiledHW === halfWidth &&
    zone._compiledHL === halfLength;
  const dx = x - (zone.x ?? 0);
  const dz = z - (zone.z ?? 0);
  if (precompValid && Number.isFinite(zone.boundX) && Number.isFinite(zone.boundZ)) {
    if (Math.abs(dx) >= zone.boundX || Math.abs(dz) >= zone.boundZ) return false;
  }
  const cos = precompValid && Number.isFinite(zone.cos) ? zone.cos : Math.cos(heading);
  const sin = precompValid && Number.isFinite(zone.sin) ? zone.sin : Math.sin(heading);
  const absX = Math.abs(dx * cos - dz * sin);
  const absZ = Math.abs(dx * sin + dz * cos);
  if (absX >= halfWidth || absZ >= halfLength) return false;
  const shape = zone.shape;
  if (shape === "strip") {
    const r = Math.min(halfWidth, halfLength) * 0.35;
    const qx = absX - (halfWidth - r);
    const qz = absZ - (halfLength - r);
    return !(qx > 0 && qz > 0 && qx * qx + qz * qz >= r * r);
  }
  if (shape === "ellipse") {
    const nx = absX / halfWidth;
    const nz = absZ / halfLength;
    return nx * nx + nz * nz < 1;
  }
  return true;
}

function compileZone(raw, index = 0, fallbackKind = undefined) {
  const heading = raw.heading ?? 0;
  const cos = Math.cos(heading);
  const sin = Math.sin(heading);
  const { halfWidth, halfLength } = resolveSurfaceZoneHalfExtents(raw);
  const boundX = Math.abs(cos) * halfWidth + Math.abs(sin) * halfLength;
  const boundZ = Math.abs(sin) * halfWidth + Math.abs(cos) * halfLength;
  const explicitSeed = Number.isFinite(raw.organicSeed);
  return {
    id: raw.id,
    kind: raw.kind ?? fallbackKind,
    shape: raw.shape ?? "ellipse",
    roadId: raw.roadId ?? null,
    x: raw.x,
    z: raw.z,
    heading,
    halfWidth,
    halfLength,
    depthM: Math.max(0, raw.depthM ?? 0.02),
    intensity: clamp(raw.intensity ?? 0.9, 0, 1),
    cos,
    sin,
    invHalfWidth: 1 / halfWidth,
    invHalfLength: 1 / halfLength,
    cornerRadius: Math.min(halfWidth, halfLength) * 0.35,
    featherM: Math.min(1.35, halfWidth * 0.28, halfLength * 0.24),
    organicSeed: explicitSeed ? raw.organicSeed : hashPuddleId(raw.id ?? `puddle-${index}`),
    _explicitSeed: explicitSeed,
    _compiledHeading: heading,
    _compiledHW: halfWidth,
    _compiledHL: halfLength,
    boundX,
    boundZ,
  };
}

function zoneBlendWeight(zone, x, z) {
  const dx = x - zone.x;
  if (dx <= -zone.boundX || dx >= zone.boundX) return 0;
  const dz = z - zone.z;
  if (dz <= -zone.boundZ || dz >= zone.boundZ) return 0;

  const localX = dx * zone.cos - dz * zone.sin;
  const localZ = dx * zone.sin + dz * zone.cos;

  if (zone.kind === "water") {
    const angRaw = Math.atan2(localX * zone.invHalfWidth, localZ * zone.invHalfLength);
    const ang = angRaw < 0 ? angRaw + Math.PI * 2 : angRaw;
    const lobe = Math.max(0.15, puddleOrganicScale(ang, zone.organicSeed) * 0.94);
    const nx = (localX * zone.invHalfWidth) / lobe;
    const nz = (localZ * zone.invHalfLength) / lobe;
    const d2 = nx * nx + nz * nz;
    if (d2 >= 1) return 0;
    return smoothstep01((1 - Math.sqrt(d2)) / 0.24);
  }

  if (zone.shape === "strip") {
    const absX = Math.abs(localX);
    const absZ = Math.abs(localZ);
    if (absX >= zone.halfWidth || absZ >= zone.halfLength) return 0;
    const r = zone.cornerRadius;
    const qx = absX - (zone.halfWidth - r);
    const qz = absZ - (zone.halfLength - r);
    let marginM;
    if (qx > 0 && qz > 0) {
      const distCorner = Math.hypot(qx, qz);
      if (distCorner >= r) return 0;
      marginM = r - distCorner;
    } else {
      marginM = Math.min(zone.halfWidth - absX, zone.halfLength - absZ);
    }
    return smoothstep01(marginM / Math.max(0.15, zone.featherM));
  }

  if (zone.shape !== "ellipse") {
    const absX = Math.abs(localX);
    const absZ = Math.abs(localZ);
    if (absX >= zone.halfWidth || absZ >= zone.halfLength) return 0;
    const marginM = Math.min(zone.halfWidth - absX, zone.halfLength - absZ);
    return Math.max(1e-4, smoothstep01(marginM / Math.max(0.15, zone.featherM)));
  }

  const nx = localX * zone.invHalfWidth;
  const nz = localZ * zone.invHalfLength;
  const d2 = nx * nx + nz * nz;
  if (d2 >= 1) return 0;
  const dNorm = Math.sqrt(d2);
  return smoothstep01((1 - dNorm) / 0.24);
}

export function createCityTerrain(roads = [], options = {}) {
  const hillDefs = Array.isArray(options.hills) ? options.hills : DEFAULT_HILLS;
  const puddleDefs = Array.isArray(options.waterPuddles)
    ? options.waterPuddles
    : DEFAULT_WATER_PUDDLES;
  const sandDefs = Array.isArray(options.sandZones) ? options.sandZones : DEFAULT_SAND_ZONES;
  const cobbleDefs = Array.isArray(options.cobbleZones)
    ? options.cobbleZones
    : DEFAULT_COBBLE_ZONES;

  const hills = hillDefs.map(compileHill);
  const waterPuddles = puddleDefs.map((z, i) => compileZone(z, i, "water"));
  const sandZones = sandDefs.map((z, i) => compileZone(z, i, "sand"));
  const cobbleZones = cobbleDefs.map((z, i) => compileZone(z, i, "cobble"));
  const zones = [...waterPuddles, ...sandZones, ...cobbleZones];

  const grid = new Map();
  for (let i = 0; i < zones.length; i++) {
    const zone = zones[i];
    const minCx = Math.floor((zone.x - zone.boundX - 1e-6) * INV_CELL_SIZE);
    const maxCx = Math.floor((zone.x + zone.boundX + 1e-6) * INV_CELL_SIZE);
    const minCz = Math.floor((zone.z - zone.boundZ - 1e-6) * INV_CELL_SIZE);
    const maxCz = Math.floor((zone.z + zone.boundZ + 1e-6) * INV_CELL_SIZE);
    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cz = minCz; cz <= maxCz; cz++) {
        const key = cellKey(cx, cz);
        let bucket = grid.get(key);
        if (!bucket) {
          bucket = [];
          grid.set(key, bucket);
        }
        bucket.push(zone);
      }
    }
  }

  let maxElevationM = 0;
  for (let i = 0; i < hills.length; i++) {
    const h = hills[i];
    let peakHere = 0;
    for (let j = 0; j < hills.length; j++) {
      const other = hills[j];
      const dx = h.x - other.x;
      const dz = h.z - other.z;
      const lx = dx * other.cos + dz * other.sin;
      const lz = -dx * other.sin + dz * other.cos;
      const u = lx * lx * other.invRx2 + lz * lz * other.invRz2;
      if (u < 1) {
        const w = 1 - u;
        peakHere += other.heightM * w * w * w;
      }
    }
    if (peakHere > maxElevationM) maxElevationM = peakHere;
  }

  const terrainObj = {
    cellSizeM: CELL_SIZE_M,
    roadCount: Array.isArray(roads) ? roads.length : 0,
    hills,
    waterPuddles,
    sandZones,
    cobbleZones,
    zones,
    grid,
    maxElevationM,
    maxElevation: maxElevationM,
  };
  seedSurfaceGridCache(terrainObj, grid);
  return terrainObj;
}

export function terrainElevationAt(terrain, x, z) {
  if (!terrain || !Number.isFinite(x) || !Number.isFinite(z)) return 0;
  const hills = terrain.hills;
  if (!hills || hills.length === 0) return 0;

  let elevationM = 0;
  for (let i = 0; i < hills.length; i++) {
    const hill = hills[i];
    const dx = x - hill.x;
    if (dx <= -hill.boundX || dx >= hill.boundX) continue;
    const dz = z - hill.z;
    if (dz <= -hill.boundZ || dz >= hill.boundZ) continue;

    const lx = dx * hill.cos + dz * hill.sin;
    const lz = -dx * hill.sin + dz * hill.cos;
    const u = lx * lx * hill.invRx2 + lz * lz * hill.invRz2;
    if (u < 1) {
      const om = 1 - u;
      elevationM += hill.heightM * om * om * om;
    }
  }
  return elevationM > 0 ? elevationM : 0;
}

export function terrainGradientAt(terrain, x, z, out = null) {
  const result = out ?? { elevationM: 0, dhdx: 0, dhdz: 0 };
  result.elevationM = 0;
  result.dhdx = 0;
  result.dhdz = 0;

  if (!terrain || !Number.isFinite(x) || !Number.isFinite(z)) return result;
  const hills = terrain.hills;
  if (!hills || hills.length === 0) return result;

  let elevationM = 0;
  let dhdx = 0;
  let dhdz = 0;

  for (let i = 0; i < hills.length; i++) {
    const hill = hills[i];
    const dx = x - hill.x;
    if (dx <= -hill.boundX || dx >= hill.boundX) continue;
    const dz = z - hill.z;
    if (dz <= -hill.boundZ || dz >= hill.boundZ) continue;

    const lx = dx * hill.cos + dz * hill.sin;
    const lz = -dx * hill.sin + dz * hill.cos;
    const u = lx * lx * hill.invRx2 + lz * lz * hill.invRz2;
    if (u < 1) {
      const om = 1 - u;
      const om2 = om * om;
      elevationM += hill.heightM * om2 * om;
      const factor = -6 * hill.heightM * om2;
      const dhdlx = factor * lx * hill.invRx2;
      const dhdlz = factor * lz * hill.invRz2;
      dhdx += dhdlx * hill.cos - dhdlz * hill.sin;
      dhdz += dhdlx * hill.sin + dhdlz * hill.cos;
    }
  }

  result.elevationM = elevationM > 0 ? elevationM : 0;
  result.dhdx = dhdx;
  result.dhdz = dhdz;
  return result;
}

export function sampleCitySurface(terrain, x, z, heading = 0, out = null) {
  const result = out ?? {};
  const asphalt = SURFACE_SPECS.asphalt;

  if (!terrain || !Number.isFinite(x) || !Number.isFinite(z)) {
    result.surfaceKind = "asphalt";
    result.gripMultiplier = asphalt.gripMultiplier;
    result.rollingDragMps2 = asphalt.rollingDragMps2;
    result.hydroDragCoeff = asphalt.hydroDragCoeff;
    result.roughnessAmp = asphalt.roughnessAmp;
    result.roughnessFreq = asphalt.roughnessFreq;
    result.elevationM = 0;
    result.dhdx = 0;
    result.dhdz = 0;
    result.gradeSin = 0;
    result.camberSin = 0;
    result.gradePct = 0;
    result.waterDepthM = 0;
    result.sandDepthM = 0;
    result.zoneId = null;
    return result;
  }

  let elevationM = 0;
  let dhdx = 0;
  let dhdz = 0;
  const hills = terrain.hills;
  if (hills) {
    for (let i = 0; i < hills.length; i++) {
      const hill = hills[i];
      const dx = x - hill.x;
      if (dx <= -hill.boundX || dx >= hill.boundX) continue;
      const dz = z - hill.z;
      if (dz <= -hill.boundZ || dz >= hill.boundZ) continue;

      const lx = dx * hill.cos + dz * hill.sin;
      const lz = -dx * hill.sin + dz * hill.cos;
      const u = lx * lx * hill.invRx2 + lz * lz * hill.invRz2;
      if (u < 1) {
        const om = 1 - u;
        const om2 = om * om;
        elevationM += hill.heightM * om2 * om;
        const factor = -6 * hill.heightM * om2;
        const dhdlx = factor * lx * hill.invRx2;
        const dhdlz = factor * lz * hill.invRz2;
        dhdx += dhdlx * hill.cos - dhdlz * hill.sin;
        dhdz += dhdlx * hill.sin + dhdlz * hill.cos;
      }
    }
  }
  if (elevationM < 0) elevationM = 0;

  const h = Number.isFinite(heading) ? heading : 0;
  let gradeSin = 0;
  let camberSin = 0;
  if (dhdx !== 0 || dhdz !== 0) {
    const sh = Math.sin(h);
    const ch = Math.cos(h);
    const slopeFwd = dhdx * sh + dhdz * ch;
    const slopeRight = dhdx * ch - dhdz * sh;
    gradeSin = slopeFwd / Math.hypot(1, slopeFwd);
    camberSin = slopeRight / Math.hypot(1, slopeRight);
  }

  let wWater = 0;
  let wSand = 0;
  let wCobble = 0;
  let maxWaterDepth = 0;
  let maxSandDepth = 0;
  let waterZoneId = null;
  let sandZoneId = null;
  let cobbleZoneId = null;

  const cx = Math.floor(x * INV_CELL_SIZE);
  const cz = Math.floor(z * INV_CELL_SIZE);
  const bucket = getOrBuildSurfaceGrid(terrain).get(cellKey(cx, cz));
  if (bucket) {
    for (let i = 0; i < bucket.length; i++) {
      const zone = bucket[i];
      const w = zoneBlendWeight(zone, x, z);
      if (w <= 0) continue;
      if (zone.kind === "water") {
        if (w > wWater) {
          wWater = w;
          waterZoneId = zone.id;
        }
        const depth = zone.depthM * w;
        if (depth > maxWaterDepth) maxWaterDepth = depth;
      } else if (zone.kind === "sand") {
        if (w > wSand) {
          wSand = w;
          sandZoneId = zone.id;
        }
        const depth = zone.depthM * w;
        if (depth > maxSandDepth) maxSandDepth = depth;
      } else if (zone.kind === "cobble") {
        if (w > wCobble) {
          wCobble = w;
          cobbleZoneId = zone.id;
        }
      }
    }
  }

  let gripMultiplier = asphalt.gripMultiplier;
  let rollingDragMps2 = asphalt.rollingDragMps2;
  let hydroDragCoeff = asphalt.hydroDragCoeff;
  let roughnessAmp = asphalt.roughnessAmp;
  let roughnessFreq = asphalt.roughnessFreq;
  let surfaceKind = "asphalt";
  let zoneId = null;

  if (wCobble > 0) {
    const cobble = SURFACE_SPECS.cobble;
    gripMultiplier = lerp(gripMultiplier, cobble.gripMultiplier, wCobble);
    rollingDragMps2 = lerp(rollingDragMps2, cobble.rollingDragMps2, wCobble);
    hydroDragCoeff = lerp(hydroDragCoeff, cobble.hydroDragCoeff, wCobble);
    roughnessAmp = lerp(roughnessAmp, cobble.roughnessAmp, wCobble);
    roughnessFreq = lerp(roughnessFreq, cobble.roughnessFreq, wCobble);
    surfaceKind = "cobble";
    zoneId = cobbleZoneId;
  }
  if (wSand > 0) {
    const sand = SURFACE_SPECS.sand;
    gripMultiplier = lerp(gripMultiplier, sand.gripMultiplier, wSand);
    rollingDragMps2 = lerp(rollingDragMps2, sand.rollingDragMps2, wSand);
    hydroDragCoeff = lerp(hydroDragCoeff, sand.hydroDragCoeff, wSand);
    roughnessAmp = lerp(roughnessAmp, sand.roughnessAmp, wSand);
    roughnessFreq = lerp(roughnessFreq, sand.roughnessFreq, wSand);
    surfaceKind = "sand";
    zoneId = sandZoneId;
  }
  if (wWater > 0) {
    const water = SURFACE_SPECS.water;
    gripMultiplier = lerp(gripMultiplier, water.gripMultiplier, wWater);
    rollingDragMps2 = lerp(rollingDragMps2, water.rollingDragMps2, wWater);
    hydroDragCoeff = lerp(hydroDragCoeff, water.hydroDragCoeff, wWater);
    roughnessAmp = lerp(roughnessAmp, water.roughnessAmp, wWater);
    roughnessFreq = lerp(roughnessFreq, water.roughnessFreq, wWater);
    surfaceKind = "water";
    zoneId = waterZoneId;
  }

  result.surfaceKind = surfaceKind;
  result.gripMultiplier = gripMultiplier;
  result.rollingDragMps2 = rollingDragMps2;
  result.hydroDragCoeff = hydroDragCoeff;
  result.roughnessAmp = roughnessAmp;
  result.roughnessFreq = roughnessFreq;
  result.elevationM = elevationM;
  result.dhdx = dhdx;
  result.dhdz = dhdz;
  result.gradeSin = gradeSin;
  result.camberSin = camberSin;
  result.gradePct = gradeSin * 100;
  result.waterDepthM = maxWaterDepth;
  result.sandDepthM = maxSandDepth;
  result.zoneId = zoneId;
  return result;
}

const syntheticGridCache = new WeakMap();

function compileSyntheticLookupZone(raw, index, kind, prevId = undefined, prevSeed = undefined) {
  const heading = Number.isFinite(raw?.heading) ? raw.heading : 0;
  const cos = Math.cos(heading);
  const sin = Math.sin(heading);
  const { halfWidth, halfLength } = resolveSurfaceZoneHalfExtents(raw);
  const x = raw?.x ?? 0;
  const z = raw?.z ?? 0;
  const boundX = Math.abs(cos) * halfWidth + Math.abs(sin) * halfLength;
  const boundZ = Math.abs(sin) * halfWidth + Math.abs(cos) * halfLength;
  const rawSeed = raw?.organicSeed;
  const seedChangedExplicitly = prevSeed !== undefined && !Object.is(rawSeed, prevSeed);
  const idChanged = prevId !== undefined && raw?.id !== prevId;
  const autoDerivedFromId = raw?._explicitSeed === false;
  const explicitSeed = seedChangedExplicitly ? Number.isFinite(rawSeed) : (!autoDerivedFromId && Number.isFinite(rawSeed));
  const organicSeed =
    explicitSeed
      ? rawSeed
      : idChanged || !Number.isFinite(rawSeed)
        ? hashPuddleId(raw?.id ?? `puddle-${index}`)
        : rawSeed;
  return {
    id: raw?.id,
    kind,
    shape: raw?.shape,
    roadId: raw?.roadId ?? null,
    x,
    z,
    heading,
    halfWidth,
    halfLength,
    depthM: Math.max(0, raw?.depthM ?? 0.02),
    intensity: clamp(raw?.intensity ?? 0.9, 0, 1),
    cos,
    sin,
    invHalfWidth: 1 / halfWidth,
    invHalfLength: 1 / halfLength,
    cornerRadius: Math.min(halfWidth, halfLength) * 0.35,
    featherM: Math.min(1.35, halfWidth * 0.28, halfLength * 0.24),
    organicSeed,
    _explicitSeed: explicitSeed,
    _compiledHeading: heading,
    _compiledHW: halfWidth,
    _compiledHL: halfLength,
    boundX,
    boundZ,
  };
}

function snapshotZoneList(arr) {
  if (!Array.isArray(arr)) return null;
  const n = arr.length;
  const refs = arr.slice();
  const ids = new Array(n);
  const seeds = new Array(n);
  const shapes = new Array(n);
  const sx = new Float64Array(n);
  const sz = new Float64Array(n);
  const sh = new Float64Array(n);
  const sw = new Float64Array(n);
  const sl = new Float64Array(n);
  const sd = new Float64Array(n);
  let allCompiled = true;
  for (let i = 0; i < n; i++) {
    const z = refs[i];
    if (z) {
      if (
        typeof z.organicSeed !== "number" ||
        typeof z.invHalfWidth !== "number" ||
        !(typeof z.halfWidth === "number" && z.halfWidth >= 0.25) ||
        !(typeof z.halfLength === "number" && z.halfLength >= 0.25) ||
        typeof z.depthM !== "number"
      ) {
        allCompiled = false;
      }
      ids[i] = z.id;
      seeds[i] = z.organicSeed;
      shapes[i] = z.shape;
      sx[i] = z.x ?? 0;
      sz[i] = z.z ?? 0;
      sh[i] = z.heading ?? 0;
      sw[i] = resolveZoneHalfWidth(z);
      sl[i] = resolveZoneHalfLength(z);
      sd[i] = Math.max(0, z.depthM ?? 0.02);
    } else {
      allCompiled = false;
    }
  }
  return { arr, refs, ids, seeds, shapes, allCompiled, sx, sz, sh, sw, sl, sd };
}

function matchesCompiledZoneSnapshot(arr, snap) {
  const refs = snap.refs;
  const n = refs.length;
  if (arr.length !== n) return false;
  const { ids, seeds, shapes, sx, sz, sh, sw, sl, sd } = snap;
  for (let i = 0; i < n; i++) {
    const z = arr[i];
    if (
      z !== refs[i] ||
      z.x !== sx[i] ||
      z.z !== sz[i] ||
      z.heading !== sh[i] ||
      z.halfWidth !== sw[i] ||
      z.halfLength !== sl[i] ||
      z.depthM !== sd[i] ||
      z.shape !== shapes[i] ||
      z.id !== ids[i] ||
      z.organicSeed !== seeds[i]
    ) {
      return false;
    }
  }
  return true;
}

function matchesZoneListSnapshot(arr, snap) {
  if (!Array.isArray(arr)) return snap === null;
  if (!snap || snap.arr !== arr) return false;
  if (snap.allCompiled) return matchesCompiledZoneSnapshot(arr, snap);
  const refs = snap.refs;
  const n = refs.length;
  if (arr.length !== n) return false;
  const { ids, seeds, shapes, sx, sz, sh, sw, sl, sd } = snap;
  for (let i = 0; i < n; i++) {
    const z = arr[i];
    if (z !== refs[i]) return false;
    if (z) {
      if (
        z.id !== ids[i] ||
        !Object.is(z.organicSeed, seeds[i]) ||
        z.shape !== shapes[i] ||
        !Object.is(z.x ?? 0, sx[i]) ||
        !Object.is(z.z ?? 0, sz[i]) ||
        !Object.is(z.heading ?? 0, sh[i]) ||
        !Object.is(resolveZoneHalfWidth(z), sw[i]) ||
        !Object.is(resolveZoneHalfLength(z), sl[i]) ||
        !Object.is(Math.max(0, z.depthM ?? 0.02), sd[i])
      ) {
        return false;
      }
    }
  }
  return true;
}

let mruTerrain = null;
let mruRecord = null;

function seedSurfaceGridCache(terrain, grid) {
  const rec = {
    wSnap: snapshotZoneList(terrain.waterPuddles),
    sSnap: snapshotZoneList(terrain.sandZones),
    cSnap: snapshotZoneList(terrain.cobbleZones),
    grid,
  };
  syntheticGridCache.set(terrain, rec);
  mruTerrain = terrain;
  mruRecord = rec;
}

function getOrBuildSurfaceGrid(terrain) {
  const wArr = terrain.waterPuddles;
  const sArr = terrain.sandZones;
  const cArr = terrain.cobbleZones;

  let cached = terrain === mruTerrain ? mruRecord : syntheticGridCache.get(terrain);
  if (
    cached &&
    matchesZoneListSnapshot(wArr, cached.wSnap) &&
    matchesZoneListSnapshot(sArr, cached.sSnap) &&
    matchesZoneListSnapshot(cArr, cached.cSnap)
  ) {
    mruTerrain = terrain;
    mruRecord = cached;
    return cached.grid;
  }

  const wList = Array.isArray(wArr) ? wArr : null;
  const sList = Array.isArray(sArr) ? sArr : null;
  const cList = Array.isArray(cArr) ? cArr : null;
  const wLen = wList ? wList.length : 0;
  const sLen = sList ? sList.length : 0;
  const cLen = cList ? cList.length : 0;
  const grid = new Map();
  const insertZone = (zone) => {
    const minCx = Math.floor((zone.x - zone.boundX - 1e-6) * INV_CELL_SIZE);
    const maxCx = Math.floor((zone.x + zone.boundX + 1e-6) * INV_CELL_SIZE);
    const minCz = Math.floor((zone.z - zone.boundZ - 1e-6) * INV_CELL_SIZE);
    const maxCz = Math.floor((zone.z + zone.boundZ + 1e-6) * INV_CELL_SIZE);
    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cz = minCz; cz <= maxCz; cz++) {
        const key = cellKey(cx, cz);
        let bucket = grid.get(key);
        if (!bucket) {
          bucket = [];
          grid.set(key, bucket);
        }
        bucket.push(zone);
      }
    }
  };

  const prevWSnap = cached?.wSnap ?? null;
  const prevSSnap = cached?.sSnap ?? null;
  const prevCSnap = cached?.cSnap ?? null;
  const compileWithPrev = (raw, i, kind, prevSnap) => {
    const prevIdx = prevSnap && prevSnap.refs[i] === raw ? i : -1;
    const prevId = prevIdx >= 0 ? prevSnap.ids[prevIdx] : undefined;
    const prevSeed = prevIdx >= 0 ? prevSnap.seeds[prevIdx] : undefined;
    const compiled = compileSyntheticLookupZone(raw, i, kind, prevId, prevSeed);
    // Keep compiled raw.organicSeed synchronized ONLY when it was auto-derived from id (_explicitSeed === false)
    if (
      prevIdx >= 0 &&
      raw?._explicitSeed === false &&
      raw?.id !== prevId &&
      Object.is(raw?.organicSeed, prevSeed) &&
      typeof raw?.organicSeed === "number"
    ) {
      try {
        raw.organicSeed = compiled.organicSeed;
      } catch {
        // ignore frozen zone object
      }
    } else if (prevIdx >= 0 && !Object.is(raw?.organicSeed, prevSeed) && Number.isFinite(raw?.organicSeed)) {
      try {
        raw._explicitSeed = true;
      } catch {
        // ignore frozen zone object
      }
    }
    return compiled;
  };

  if (wList) {
    for (let i = 0; i < wLen; i++) {
      if (wList[i]) insertZone(compileWithPrev(wList[i], i, "water", prevWSnap));
    }
  }
  if (sList) {
    for (let i = 0; i < sLen; i++) {
      if (sList[i]) insertZone(compileWithPrev(sList[i], i, "sand", prevSSnap));
    }
  }
  if (cList) {
    for (let i = 0; i < cLen; i++) {
      if (cList[i]) insertZone(compileWithPrev(cList[i], i, "cobble", prevCSnap));
    }
  }

  cached = {
    wSnap: snapshotZoneList(wList),
    sSnap: snapshotZoneList(sList),
    cSnap: snapshotZoneList(cList),
    grid,
  };
  syntheticGridCache.set(terrain, cached);
  mruTerrain = terrain;
  mruRecord = cached;
  if (terrain.grid instanceof Map) {
    terrain.grid = grid;
  }
  return grid;
}

export function querySurfaceKindFast(terrain, x, z) {
  if (!terrain || !Number.isFinite(x) || !Number.isFinite(z)) return "asphalt";
  const grid = getOrBuildSurfaceGrid(terrain);
  const cx = Math.floor(x * INV_CELL_SIZE);
  const cz = Math.floor(z * INV_CELL_SIZE);
  const bucket = grid.get(cellKey(cx, cz));
  if (!bucket) return "asphalt";

  let hitSand = false;
  let hitCobble = false;
  for (let i = 0; i < bucket.length; i++) {
    const zone = bucket[i];
    const kind = zone.kind;
    if (kind === "water") {
      if (pointInWaterPuddle(x, z, zone, 0, 0)) return "water";
    } else if (kind === "sand") {
      if (!hitSand && pointInShapedSurfaceZone(x, z, zone)) hitSand = true;
    } else if (kind === "cobble") {
      if (!hitSand && !hitCobble && pointInShapedSurfaceZone(x, z, zone)) hitCobble = true;
    }
  }
  if (hitSand) return "sand";
  if (hitCobble) return "cobble";
  return "asphalt";
}
