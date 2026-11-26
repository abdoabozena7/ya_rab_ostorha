import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { isDiagonalRoad, pointOnRoad, roadFrame } from "../core/geometry.js";
import { avenueCrossings } from "../core/district-behavior.js";

export const ROAD_TOP_OFFSET_M = 0.115;
export const ROAD_BOTTOM_OFFSET_M = 0.055;
export const PAVEMENT_TOP_OFFSET_M = 0.07;
export const PAVEMENT_SIDEWALK_MARGIN_M = 2.5;
export const MARKING_TOP_OFFSET_M = 0.1205;
export const RETAINING_BASE_Y_M = -0.06;
export const RETAINING_MIN_ELEV_M = 1.15;
export const ROAD_TILE_METRES = 2.5;
export const PAVEMENT_TILE_METRES = 1.8;

const CITY_V4_SURFACE_BASE = Object.freeze({
  road: 0x43484a,
  pavement: 0xa2a39b,
  retaining: 0x9c9a90,
});

function evalCompiledHills(hills, x, z) {
  if (!Array.isArray(hills) || !hills.length || !Number.isFinite(x) || !Number.isFinite(z)) {
    return 0;
  }
  let elevationM = 0;
  for (let i = 0; i < hills.length; i++) {
    const hill = hills[i];
    const dx = x - hill.x;
    if (hill.boundX !== undefined && (dx <= -hill.boundX || dx >= hill.boundX)) continue;
    const dz = z - hill.z;
    if (hill.boundZ !== undefined && (dz <= -hill.boundZ || dz >= hill.boundZ)) continue;
    const cos = hill.cos ?? Math.cos(hill.angle ?? 0);
    const sin = hill.sin ?? Math.sin(hill.angle ?? 0);
    const invRx2 = hill.invRx2 ?? 1 / Math.max(1, (hill.rx ?? 50) ** 2);
    const invRz2 = hill.invRz2 ?? 1 / Math.max(1, (hill.rz ?? 50) ** 2);
    const lx = dx * cos + dz * sin;
    const lz = -dx * sin + dz * cos;
    const u = lx * lx * invRx2 + lz * lz * invRz2;
    if (u < 1) {
      const om = 1 - u;
      elevationM += (hill.heightM ?? 0) * om * om * om;
    }
  }
  return elevationM > 0 ? elevationM : 0;
}

export function resolveElevationFn(worldOrFn, options = {}) {
  const candidate =
    (typeof options?.elevationAt === "function" && options.elevationAt) ||
    (typeof worldOrFn === "function" && worldOrFn) ||
    (typeof worldOrFn?.elevationAt === "function" &&
      ((x, z) => worldOrFn.elevationAt(x, z))) ||
    (typeof worldOrFn?.groundElevationAt === "function" &&
      ((x, z) => worldOrFn.groundElevationAt(x, z))) ||
    (typeof worldOrFn?.terrainElevation === "function" &&
      ((x, z) => worldOrFn.terrainElevation(x, z))) ||
    (typeof worldOrFn?.terrain?.elevationAt === "function" &&
      ((x, z) => worldOrFn.terrain.elevationAt(x, z))) ||
    (typeof worldOrFn?.citySurfaces?.elevationAt === "function" &&
      ((x, z) => worldOrFn.citySurfaces.elevationAt(x, z))) ||
    (typeof worldOrFn?.city?.elevationAt === "function" &&
      ((x, z) => worldOrFn.city.elevationAt(x, z))) ||
    null;
  if (candidate) {
    return (x, z) => {
      const v = candidate(x, z);
      return Number.isFinite(v) ? v : 0;
    };
  }
  const terrainHills =
    options?.terrain?.hills ??
    worldOrFn?.terrain?.hills ??
    worldOrFn?.cityTerrain?.hills ??
    worldOrFn?.citySurfaces?.hills ??
    null;
  if (Array.isArray(terrainHills) && terrainHills.length > 0) {
    return (x, z) => evalCompiledHills(terrainHills, x, z);
  }
  return () => 0;
}

function extractRoadBasis(road) {
  if (isDiagonalRoad(road)) {
    const x2 = road.x2 ?? road.x1 + (road.ux ?? 0) * (road.length ?? 0);
    const z2 = road.z2 ?? road.z1 + (road.uz ?? 1) * (road.length ?? 0);
    const dx = x2 - road.x1;
    const dz = z2 - road.z1;
    const rawLen = road.length ?? Math.hypot(dx, dz);
    const length = Number.isFinite(rawLen) && rawLen > 0 ? rawLen : 0;
    let ux = road.ux ?? (length > 0 ? dx / length : 0);
    let uz = road.uz ?? (length > 0 ? dz / length : 1);
    const norm = Math.hypot(ux, uz) || 1;
    ux /= norm;
    uz /= norm;
    return {
      x1: road.x1,
      z1: road.z1,
      ux,
      uz,
      vx: uz,
      vz: -ux,
      length,
      heading: road.heading ?? Math.atan2(ux, uz),
      sOrigin: 0,
    };
  }
  if (road.axis === "z") {
    return {
      x1: road.fixed,
      z1: road.min,
      ux: 0,
      uz: 1,
      vx: 1,
      vz: 0,
      length: Math.max(0, road.max - road.min),
      heading: 0,
      sOrigin: road.min,
    };
  }
  return {
    x1: road.min,
    z1: road.fixed,
    ux: 1,
    uz: 0,
    vx: 0,
    vz: -1,
    length: Math.max(0, road.max - road.min),
    heading: Math.PI / 2,
    sOrigin: road.min,
  };
}

function pointOnDiagRoadLocal(p, road, margin = 0) {
  const basis = extractRoadBasis(road);
  const h = road.width / 2 - margin;
  if (h <= 0) return false;
  const dx = p.x - basis.x1;
  const dz = p.z - basis.z1;
  const along = dx * basis.ux + dz * basis.uz;
  if (along < -h || along > basis.length + h) return false;
  return Math.abs(dx * basis.vx + dz * basis.vz) <= h;
}

function pointOnAnyRoad(p, roads, margin = 0) {
  for (let i = 0; i < roads.length; i++) {
    const road = roads[i];
    if (isDiagonalRoad(road)) {
      if (pointOnRoad(p, [road], margin) || pointOnDiagRoadLocal(p, road, margin)) {
        return true;
      }
    } else if (pointOnRoad(p, [road], margin)) {
      return true;
    }
  }
  return false;
}

function diagAvenueCrossings(road, candidateRoads, allRoads = candidateRoads) {
  if (road.zone !== "avenue" || road.parkingBay) return [];
  const { length, ux, uz } = extractRoadBasis(road);
  const otherDriving = (candidateRoads ?? []).filter(
    (other) => other !== road && !other.parkingBay && !other.supportApron,
  );
  const blockers = (allRoads ?? []).filter(
    (other) => other !== road && (!other.parkingBay || other.supportApron),
  );
  const raw = [];
  for (const other of otherDriving) {
    const f = isDiagonalRoad(other)
      ? extractRoadBasis(other)
      : roadFrame(other);
    const det = -ux * f.uz + uz * f.ux;
    if (Math.abs(det) < 0.12) continue;
    const dx = f.x1 - road.x1;
    const dz = f.z1 - road.z1;
    const t = (-f.uz * dx + f.ux * dz) / det;
    const u = (-uz * dx + ux * dz) / det;
    if (
      t < -other.width / 2 ||
      t > length + other.width / 2 ||
      u < -road.width / 2 ||
      u > f.length + road.width / 2
    ) {
      continue;
    }
    const offset = Math.max(
      11.5,
      (other.width / 2 + (road.width / 2) * Math.abs(ux * f.ux + uz * f.uz)) /
        Math.abs(det) +
        2.4,
    );
    raw.push(t - offset, t + offset);
  }
  raw.sort((a, b) => a - b);
  const crossings = [];
  for (const along of raw) {
    if (along <= 8 || along >= length - 8) continue;
    if (crossings.some((prev) => Math.abs(prev - along) < 4.5)) continue;
    const p = { x: road.x1 + ux * along, z: road.z1 + uz * along };
    if (pointOnAnyRoad(p, blockers, -1.0)) continue;
    crossings.push(along);
  }
  return crossings;
}

function sampleBasisElev(basis, s, t, elev) {
  const x = basis.x1 + basis.ux * s + basis.vx * t;
  const z = basis.z1 + basis.uz * s + basis.vz * t;
  return elev(x, z);
}

function maxMidSagitta(basis, s0, s1, halfW, elev) {
  const sm = 0.5 * (s0 + s1);
  let maxErr = 0;
  for (const t of [-halfW, 0, halfW]) {
    const e0 = sampleBasisElev(basis, s0, t, elev);
    const e1 = sampleBasisElev(basis, s1, t, elev);
    const em = sampleBasisElev(basis, sm, t, elev);
    const err = Math.abs(em - 0.5 * (e0 + e1));
    if (err > maxErr) maxErr = err;
  }
  return maxErr;
}

function buildAdaptiveSGrid(basis, sMin, sMax, halfW, elev, options) {
  const totalSpan = Math.max(0.01, sMax - sMin);
  const flatStepM = Math.max(6, options?.flatStepM ?? 18);
  const slopedStepM = Math.max(2, options?.slopedStepM ?? 5.0);
  const sagittaTolM = Math.max(0.002, options?.sagittaTolM ?? 0.007);
  const probeCount = Math.max(1, Math.ceil(totalSpan / slopedStepM));
  const probes = new Float64Array(probeCount + 1);
  for (let k = 0; k <= probeCount; k++) {
    probes[k] = k === probeCount ? sMax : sMin + (totalSpan * k) / probeCount;
  }

  const stationElevated = new Uint8Array(probeCount + 1);
  let anyTerrain = false;
  let minElev = Infinity;
  let maxElev = -Infinity;

  for (let k = 0; k <= probeCount; k++) {
    const s = probes[k];
    const eL = sampleBasisElev(basis, s, -halfW, elev);
    const eC = sampleBasisElev(basis, s, 0, elev);
    const eR = sampleBasisElev(basis, s, halfW, elev);
    minElev = Math.min(minElev, eL, eC, eR);
    maxElev = Math.max(maxElev, eL, eC, eR);
    if (Math.abs(eL) > 1e-5 || Math.abs(eC) > 1e-5 || Math.abs(eR) > 1e-5) {
      stationElevated[k] = 1;
      anyTerrain = true;
    }
  }

  const intervalActive = new Uint8Array(probeCount);
  for (let k = 0; k < probeCount; k++) {
    if (stationElevated[k] || stationElevated[k + 1]) {
      intervalActive[k] = 1;
      continue;
    }
    const sm = 0.5 * (probes[k] + probes[k + 1]);
    const eL = sampleBasisElev(basis, sm, -halfW, elev);
    const eC = sampleBasisElev(basis, sm, 0, elev);
    const eR = sampleBasisElev(basis, sm, halfW, elev);
    minElev = Math.min(minElev, eL, eC, eR);
    maxElev = Math.max(maxElev, eL, eC, eR);
    if (Math.abs(eL) > 1e-5 || Math.abs(eC) > 1e-5 || Math.abs(eR) > 1e-5) {
      intervalActive[k] = 1;
      anyTerrain = true;
    }
  }

  if (!anyTerrain) {
    const flatCount = Math.max(1, Math.ceil(totalSpan / flatStepM));
    const sValues = new Float64Array(flatCount + 1);
    for (let i = 0; i <= flatCount; i++) {
      sValues[i] = i === flatCount ? sMax : sMin + (totalSpan * i) / flatCount;
    }
    return { sValues, anyTerrain: false, minElev: 0, maxElev: 0 };
  }

  const expanded = new Uint8Array(probeCount);
  for (let k = 0; k < probeCount; k++) {
    if (
      intervalActive[k] ||
      (k > 0 && intervalActive[k - 1]) ||
      (k + 1 < probeCount && intervalActive[k + 1])
    ) {
      expanded[k] = 1;
    }
  }

  const sList = [sMin];
  const pushRefined = (a, b, depth) => {
    const span = b - a;
    if (depth < 2 && span > 2.1 && maxMidSagitta(basis, a, b, halfW, elev) > sagittaTolM) {
      const mid = 0.5 * (a + b);
      pushRefined(a, mid, depth + 1);
      pushRefined(mid, b, depth + 1);
      return;
    }
    sList.push(b);
  };

  let k = 0;
  while (k < probeCount) {
    if (!expanded[k]) {
      const startS = probes[k];
      let endK = k + 1;
      while (
        endK < probeCount &&
        !expanded[endK] &&
        probes[endK + 1] - startS <= flatStepM + 1e-6
      ) {
        endK++;
      }
      sList.push(probes[endK]);
      k = endK;
    } else {
      pushRefined(probes[k], probes[k + 1], 0);
      k++;
    }
  }

  return {
    sValues: Float64Array.from(sList),
    anyTerrain: true,
    minElev,
    maxElev,
  };
}

function buildTValues(halfW, strips) {
  const count = Math.max(1, strips);
  const tValues = new Float64Array(count + 1);
  const width = halfW * 2;
  for (let j = 0; j <= count; j++) {
    tValues[j] = j === count ? halfW : -halfW + (width * j) / count;
  }
  return tValues;
}

function createIndexBuffer(indices, vertexCount) {
  const ArrayCtor = vertexCount > 65535 ? Uint32Array : Uint16Array;
  return new THREE.BufferAttribute(ArrayCtor.from(indices), 1);
}

function buildRibbonSlabGeometry({
  basis,
  sValues,
  tValues,
  topOffset,
  bottomFn,
  elev,
  tileMetres,
}) {
  const nS = sValues.length;
  const nT = tValues.length;
  const topVertCount = nS * nT;
  const sideVertCount = 2 * nS;
  const capVertCount = 2 * nT;
  const totalVerts = topVertCount + 2 * sideVertCount + 2 * capVertCount;
  const totalIndices =
    6 * (nS - 1) * (nT - 1) + 12 * (nS - 1) + 12 * (nT - 1);

  const positions = new Float32Array(totalVerts * 3);
  const uvs = new Float32Array(totalVerts * 2);
  const indices =
    totalVerts > 65535
      ? new Uint32Array(totalIndices)
      : new Uint16Array(totalIndices);

  const wxGrid = new Float64Array(topVertCount);
  const wzGrid = new Float64Array(topVertCount);
  const eGrid = new Float64Array(topVertCount);
  const yTopGrid = new Float64Array(topVertCount);

  let vCursor = 0;
  let iCursor = 0;

  const writeVertex = (x, y, z, u, v) => {
    const vIdx = vCursor++;
    const p3 = vIdx * 3;
    const u2 = vIdx * 2;
    positions[p3] = x;
    positions[p3 + 1] = y;
    positions[p3 + 2] = z;
    uvs[u2] = u;
    uvs[u2 + 1] = v;
    return vIdx;
  };

  // 1. Top surface grid (isolated from vertical skirts so top normals stay pure)
  for (let i = 0; i < nS; i++) {
    const s = sValues[i];
    for (let j = 0; j < nT; j++) {
      const t = tValues[j];
      const idx = i * nT + j;
      const wx = basis.x1 + basis.ux * s + basis.vx * t;
      const wz = basis.z1 + basis.uz * s + basis.vz * t;
      const e = elev(wx, wz);
      const yTop = topOffset + e;
      wxGrid[idx] = wx;
      wzGrid[idx] = wz;
      eGrid[idx] = e;
      yTopGrid[idx] = yTop;
      writeVertex(wx, yTop, wz, wx / tileMetres, wz / tileMetres);
    }
  }

  for (let i = 0; i < nS - 1; i++) {
    const row0 = i * nT;
    const row1 = (i + 1) * nT;
    for (let j = 0; j < nT - 1; j++) {
      const v00 = row0 + j;
      const v10 = row1 + j;
      const v01 = row0 + j + 1;
      const v11 = row1 + j + 1;
      indices[iCursor++] = v00;
      indices[iCursor++] = v10;
      indices[iCursor++] = v11;
      indices[iCursor++] = v00;
      indices[iCursor++] = v11;
      indices[iCursor++] = v01;
    }
  }

  // 2. Right side skirt (j = nT - 1, outward +V)
  const rightBase = vCursor;
  for (let i = 0; i < nS; i++) {
    const idx = i * nT + (nT - 1);
    const wx = wxGrid[idx];
    const wz = wzGrid[idx];
    const yTop = yTopGrid[idx];
    const yBot = bottomFn(eGrid[idx], yTop);
    const u = sValues[i] / tileMetres;
    writeVertex(wx, yTop, wz, u, yTop / tileMetres);
    writeVertex(wx, yBot, wz, u, yBot / tileMetres);
  }
  for (let i = 0; i < nS - 1; i++) {
    const top0 = rightBase + i * 2;
    const bot0 = top0 + 1;
    const top1 = top0 + 2;
    const bot1 = top0 + 3;
    indices[iCursor++] = top0;
    indices[iCursor++] = top1;
    indices[iCursor++] = bot1;
    indices[iCursor++] = top0;
    indices[iCursor++] = bot1;
    indices[iCursor++] = bot0;
  }

  // 3. Left side skirt (j = 0, outward -V)
  const leftBase = vCursor;
  for (let i = 0; i < nS; i++) {
    const idx = i * nT;
    const wx = wxGrid[idx];
    const wz = wzGrid[idx];
    const yTop = yTopGrid[idx];
    const yBot = bottomFn(eGrid[idx], yTop);
    const u = sValues[i] / tileMetres;
    writeVertex(wx, yTop, wz, u, yTop / tileMetres);
    writeVertex(wx, yBot, wz, u, yBot / tileMetres);
  }
  for (let i = 0; i < nS - 1; i++) {
    const top0 = leftBase + i * 2;
    const bot0 = top0 + 1;
    const top1 = top0 + 2;
    const bot1 = top0 + 3;
    indices[iCursor++] = top0;
    indices[iCursor++] = bot1;
    indices[iCursor++] = top1;
    indices[iCursor++] = top0;
    indices[iCursor++] = bot0;
    indices[iCursor++] = bot1;
  }

  // 4. Front end cap (i = nS - 1, outward +U)
  const frontBase = vCursor;
  for (let j = 0; j < nT; j++) {
    const idx = (nS - 1) * nT + j;
    const wx = wxGrid[idx];
    const wz = wzGrid[idx];
    const yTop = yTopGrid[idx];
    const yBot = bottomFn(eGrid[idx], yTop);
    const u = tValues[j] / tileMetres;
    writeVertex(wx, yTop, wz, u, yTop / tileMetres);
    writeVertex(wx, yBot, wz, u, yBot / tileMetres);
  }
  for (let j = 0; j < nT - 1; j++) {
    const top0 = frontBase + j * 2;
    const bot0 = top0 + 1;
    const top1 = top0 + 2;
    const bot1 = top0 + 3;
    indices[iCursor++] = top0;
    indices[iCursor++] = bot0;
    indices[iCursor++] = bot1;
    indices[iCursor++] = top0;
    indices[iCursor++] = bot1;
    indices[iCursor++] = top1;
  }

  // 5. Back end cap (i = 0, outward -U)
  const backBase = vCursor;
  for (let j = 0; j < nT; j++) {
    const idx = j;
    const wx = wxGrid[idx];
    const wz = wzGrid[idx];
    const yTop = yTopGrid[idx];
    const yBot = bottomFn(eGrid[idx], yTop);
    const u = tValues[j] / tileMetres;
    writeVertex(wx, yTop, wz, u, yTop / tileMetres);
    writeVertex(wx, yBot, wz, u, yBot / tileMetres);
  }
  for (let j = 0; j < nT - 1; j++) {
    const top0 = backBase + j * 2;
    const bot0 = top0 + 1;
    const top1 = top0 + 2;
    const bot1 = top0 + 3;
    indices[iCursor++] = top0;
    indices[iCursor++] = top1;
    indices[iCursor++] = bot1;
    indices[iCursor++] = top0;
    indices[iCursor++] = bot1;
    indices[iCursor++] = bot0;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeVertexNormals();

  return {
    geometry,
    eGrid,
    triangles: indices.length / 3,
  };
}

function findIntervalIndex(values, target) {
  let lo = 0;
  let hi = values.length - 2;
  if (target <= values[0]) return 0;
  if (target >= values[hi + 1]) return hi;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (target < values[mid]) hi = mid - 1;
    else if (target > values[mid + 1]) lo = mid + 1;
    else return mid;
  }
  return Math.max(0, Math.min(values.length - 2, lo));
}

function evaluateRoadSurfaceMeshElev(surface, x, z) {
  const { basis, halfW, sMin, sMax, sValues, tValues, eGrid } = surface;
  const dx = x - basis.x1;
  const dz = z - basis.z1;
  const s = dx * basis.ux + dz * basis.uz;
  const t = dx * basis.vx + dz * basis.vz;
  if (s < sMin - 1e-4 || s > sMax + 1e-4 || Math.abs(t) > halfW + 1e-4) {
    return null;
  }
  const sc = Math.max(sMin, Math.min(sMax, s));
  const tc = Math.max(-halfW, Math.min(halfW, t));
  const i = findIntervalIndex(sValues, sc);
  const j = findIntervalIndex(tValues, tc);
  const ds = sValues[i + 1] - sValues[i];
  const dt = tValues[j + 1] - tValues[j];
  const u = ds > 1e-9 ? (sc - sValues[i]) / ds : 0;
  const v = dt > 1e-9 ? (tc - tValues[j]) / dt : 0;

  const nT = tValues.length;
  const e00 = eGrid[i * nT + j];
  const e10 = eGrid[(i + 1) * nT + j];
  const e01 = eGrid[i * nT + j + 1];
  const e11 = eGrid[(i + 1) * nT + j + 1];

  // Exact match to the (v00, v10, v11) and (v00, v11, v01) triangulation
  if (u >= v) {
    return e00 + u * (e10 - e00) + v * (e11 - e10);
  }
  return e00 + u * (e11 - e01) + v * (e01 - e00);
}

function buildConformedMarking({
  roadSurface,
  allRoadSurfaces,
  sCenter,
  tCenter,
  markWidth,
  markLength,
  elev,
  cityStreetFinish,
}) {
  const { basis, sValues } = roadSurface;
  const sStart = sCenter - markLength / 2;
  const sEnd = sCenter + markLength / 2;
  const halfW = markWidth / 2;

  const sSet = [sStart, sEnd];
  const subSegments = 4;
  for (let k = 1; k < subSegments; k++) {
    sSet.push(sStart + (markLength * k) / subSegments);
  }
  for (let i = 0; i < sValues.length; i++) {
    const sv = sValues[i];
    if (sv > sStart + 0.04 && sv < sEnd - 0.04) sSet.push(sv);
  }
  sSet.sort((a, b) => a - b);
  const markS = [sSet[0]];
  for (let i = 1; i < sSet.length; i++) {
    if (sSet[i] - markS[markS.length - 1] > 0.03) markS.push(sSet[i]);
  }
  markS[markS.length - 1] = sEnd;

  const surfaceElevAt = (wx, wz) => {
    let best = elev(wx, wz);
    const own = evaluateRoadSurfaceMeshElev(roadSurface, wx, wz);
    if (own !== null && own > best) best = own;
    for (let i = 0; i < allRoadSurfaces.length; i++) {
      const other = allRoadSurfaces[i];
      if (other === roadSurface) continue;
      if (
        wx < other.minX ||
        wx > other.maxX ||
        wz < other.minZ ||
        wz > other.maxZ
      ) {
        continue;
      }
      const ov = evaluateRoadSurfaceMeshElev(other, wx, wz);
      if (ov !== null && ov > best) best = ov;
    }
    return best;
  };

  if (!cityStreetFinish) {
    const markT = Float64Array.from([tCenter - halfW, tCenter + halfW]);
    const { geometry } = buildRibbonSlabGeometry({
      basis,
      sValues: Float64Array.from(markS),
      tValues: markT,
      topOffset: MARKING_TOP_OFFSET_M + 0.0025,
      bottomFn: (e) => MARKING_TOP_OFFSET_M - 0.0025 + e,
      elev: surfaceElevAt,
      tileMetres: 1.0,
    });
    return geometry;
  }

  const cx = basis.x1 + basis.ux * sCenter + basis.vx * tCenter;
  const cz = basis.z1 + basis.uz * sCenter + basis.vz * tCenter;
  const wear = (Math.abs(Math.floor(cx * 13 + cz * 17)) % 9) / 8;
  const notch = 0.09 + wear * 0.16;
  const tint = new THREE.Color(0xd0c8b6).multiplyScalar(0.69 + wear * 0.31);

  const nRows = markS.length;
  const vertCount = nRows * 2;
  const positions = new Float32Array(vertCount * 3);
  const uvs = new Float32Array(vertCount * 2);
  const colors = new Float32Array(vertCount * 3);
  const indices = new Uint16Array((nRows - 1) * 6);

  for (let i = 0; i < nRows; i++) {
    const sBase = markS[i];
    const isFirst = i === 0;
    const isLast = i === nRows - 1;
    const tLeft =
      tCenter - halfW + (isFirst ? markWidth * notch * 0.45 : 0);
    const tRight =
      tCenter + halfW - (isLast ? markWidth * notch * 0.45 : 0);
    const sLeft = sBase + (isFirst ? markLength * 0.025 : 0);
    const sRight = sBase - (isLast ? markLength * 0.025 : 0);

    const lx = basis.x1 + basis.ux * sLeft + basis.vx * tLeft;
    const lz = basis.z1 + basis.uz * sLeft + basis.vz * tLeft;
    const ly = MARKING_TOP_OFFSET_M + surfaceElevAt(lx, lz);

    const rx = basis.x1 + basis.ux * sRight + basis.vx * tRight;
    const rz = basis.z1 + basis.uz * sRight + basis.vz * tRight;
    const ry = MARKING_TOP_OFFSET_M + surfaceElevAt(rx, rz);

    const vL = i * 2;
    const vR = vL + 1;
    positions[vL * 3] = lx;
    positions[vL * 3 + 1] = ly;
    positions[vL * 3 + 2] = lz;
    uvs[vL * 2] = lx;
    uvs[vL * 2 + 1] = lz;
    colors[vL * 3] = tint.r;
    colors[vL * 3 + 1] = tint.g;
    colors[vL * 3 + 2] = tint.b;

    positions[vR * 3] = rx;
    positions[vR * 3 + 1] = ry;
    positions[vR * 3 + 2] = rz;
    uvs[vR * 2] = rx;
    uvs[vR * 2 + 1] = rz;
    colors[vR * 3] = tint.r;
    colors[vR * 3 + 1] = tint.g;
    colors[vR * 3 + 2] = tint.b;
  }

  let idx = 0;
  for (let i = 0; i < nRows - 1; i++) {
    const v00 = i * 2;
    const v01 = v00 + 1;
    const v10 = v00 + 2;
    const v11 = v00 + 3;
    indices[idx++] = v00;
    indices[idx++] = v10;
    indices[idx++] = v11;
    indices[idx++] = v00;
    indices[idx++] = v11;
    indices[idx++] = v01;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeVertexNormals();
  return geometry;
}

function buildRetainingSpanGeometry({
  basis,
  sValues,
  eGrid,
  nT,
  iStart,
  iEnd,
  pavementHalfW,
  tileMetres,
}) {
  const positions = [];
  const uvs = [];
  const indices = [];
  let vCount = 0;

  const addVert = (x, y, z, u, v) => {
    positions.push(x, y, z);
    uvs.push(u, v);
    return vCount++;
  };
  const addQuad = (a, b, c, d) => {
    indices.push(a, b, c, a, c, d);
  };

  const count = iEnd - iStart + 1;
  const rightTop = new Int32Array(count);
  const rightBot = new Int32Array(count);
  const leftTop = new Int32Array(count);
  const leftBot = new Int32Array(count);

  const topInsetW = Math.max(0.5, pavementHalfW - 0.16);
  const batterAt = (e) =>
    pavementHalfW + 0.08 + Math.min(0.34, Math.max(0, e) * 0.07);
  const topYAt = (e) =>
    Math.max(RETAINING_BASE_Y_M + 0.08, PAVEMENT_TOP_OFFSET_M + e - 0.11);

  // Right battered embankment wall (+V outward)
  for (let k = 0; k < count; k++) {
    const i = iStart + k;
    const s = sValues[i];
    const eR = eGrid[i * nT + (nT - 1)];
    const yT = topYAt(eR);
    const tB = batterAt(eR);
    const xT = basis.x1 + basis.ux * s + basis.vx * topInsetW;
    const zT = basis.z1 + basis.uz * s + basis.vz * topInsetW;
    const xB = basis.x1 + basis.ux * s + basis.vx * tB;
    const zB = basis.z1 + basis.uz * s + basis.vz * tB;
    const u = s / tileMetres;
    rightTop[k] = addVert(xT, yT, zT, u, yT / tileMetres);
    rightBot[k] = addVert(
      xB,
      RETAINING_BASE_Y_M,
      zB,
      u,
      RETAINING_BASE_Y_M / tileMetres,
    );
  }
  for (let k = 0; k < count - 1; k++) {
    addQuad(rightTop[k], rightTop[k + 1], rightBot[k + 1], rightBot[k]);
  }

  // Left battered embankment wall (-V outward)
  for (let k = 0; k < count; k++) {
    const i = iStart + k;
    const s = sValues[i];
    const eL = eGrid[i * nT];
    const yT = topYAt(eL);
    const tB = batterAt(eL);
    const xT = basis.x1 + basis.ux * s - basis.vx * topInsetW;
    const zT = basis.z1 + basis.uz * s - basis.vz * topInsetW;
    const xB = basis.x1 + basis.ux * s - basis.vx * tB;
    const zB = basis.z1 + basis.uz * s - basis.vz * tB;
    const u = s / tileMetres;
    leftTop[k] = addVert(xT, yT, zT, u, yT / tileMetres);
    leftBot[k] = addVert(
      xB,
      RETAINING_BASE_Y_M,
      zB,
      u,
      RETAINING_BASE_Y_M / tileMetres,
    );
  }
  for (let k = 0; k < count - 1; k++) {
    addQuad(leftTop[k], leftBot[k], leftBot[k + 1], leftTop[k + 1]);
  }

  // End bulkheads closing start (-U) and finish (+U) of the embankment span
  for (const [k, forward] of [
    [0, false],
    [count - 1, true],
  ]) {
    const i = iStart + k;
    const s = sValues[i];
    const eL = eGrid[i * nT];
    const eR = eGrid[i * nT + (nT - 1)];
    const yTL = topYAt(eL);
    const yTR = topYAt(eR);
    const tBL = batterAt(eL);
    const tBR = batterAt(eR);

    const lxT = basis.x1 + basis.ux * s - basis.vx * topInsetW;
    const lzT = basis.z1 + basis.uz * s - basis.vz * topInsetW;
    const rxT = basis.x1 + basis.ux * s + basis.vx * topInsetW;
    const rzT = basis.z1 + basis.uz * s + basis.vz * topInsetW;
    const lxB = basis.x1 + basis.ux * s - basis.vx * tBL;
    const lzB = basis.z1 + basis.uz * s - basis.vz * tBL;
    const rxB = basis.x1 + basis.ux * s + basis.vx * tBR;
    const rzB = basis.z1 + basis.uz * s + basis.vz * tBR;

    const vLT = addVert(lxT, yTL, lzT, -topInsetW / tileMetres, yTL / tileMetres);
    const vRT = addVert(rxT, yTR, rzT, topInsetW / tileMetres, yTR / tileMetres);
    const vLB = addVert(
      lxB,
      RETAINING_BASE_Y_M,
      lzB,
      -tBL / tileMetres,
      RETAINING_BASE_Y_M / tileMetres,
    );
    const vRB = addVert(
      rxB,
      RETAINING_BASE_Y_M,
      rzB,
      tBR / tileMetres,
      RETAINING_BASE_Y_M / tileMetres,
    );
    if (forward) addQuad(vLT, vLB, vRB, vRT);
    else addQuad(vLT, vRT, vRB, vLB);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.BufferAttribute(Float32Array.from(positions), 3),
  );
  geometry.setAttribute(
    "uv",
    new THREE.BufferAttribute(Float32Array.from(uvs), 2),
  );
  geometry.setIndex(createIndexBuffer(indices, vCount));
  geometry.computeVertexNormals();
  return { geometry, triangles: indices.length / 3 };
}

function buildButtressPierGeometry({
  basis,
  sCenter,
  pierLength,
  pavementHalfW,
  topElev,
  tileMetres,
}) {
  const halfLen = pierLength / 2;
  const sVals = Float64Array.from([sCenter - halfLen, sCenter + halfLen]);
  const outerW = pavementHalfW + 0.24 + Math.min(0.28, topElev * 0.06);
  const tVals = Float64Array.from([-outerW, outerW]);
  const topY = Math.max(
    RETAINING_BASE_Y_M + 0.12,
    PAVEMENT_TOP_OFFSET_M + topElev - 0.15,
  );
  return buildRibbonSlabGeometry({
    basis,
    sValues: sVals,
    tValues: tVals,
    topOffset: topY,
    bottomFn: () => RETAINING_BASE_Y_M,
    elev: () => 0,
    tileMetres,
  });
}

function computeSurfaceBounds(basis, sMin, sMax, halfW) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const s of [sMin, sMax]) {
    for (const t of [-halfW, halfW]) {
      const x = basis.x1 + basis.ux * s + basis.vx * t;
      const z = basis.z1 + basis.uz * s + basis.vz * t;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
  }
  return { minX, maxX, minZ, maxZ };
}

export function buildTerrainRoadParts(
  roadsInput,
  drivingRoadsInput = null,
  elevationAtInput = null,
  optionsInput = {},
) {
  let roads = roadsInput;
  let drivingRoads = drivingRoadsInput;
  let elevationAt = elevationAtInput;
  let options = optionsInput ?? {};

  if (!Array.isArray(roads) && roads && typeof roads === "object") {
    const world = roads;
    options =
      drivingRoads && typeof drivingRoads === "object" && !Array.isArray(drivingRoads)
        ? drivingRoads
        : options;
    roads = world.roads ?? [];
    drivingRoads = world.drivingRoads ?? roads;
    elevationAt = resolveElevationFn(world, options);
  } else if (typeof drivingRoads === "function") {
    options =
      elevationAt && typeof elevationAt === "object" ? elevationAt : options;
    elevationAt = drivingRoads;
    drivingRoads = roads;
  }

  roads = Array.isArray(roads) ? roads : [];
  drivingRoads = Array.isArray(drivingRoads) ? drivingRoads : roads;
  const elev = resolveElevationFn(elevationAt, options);

  const metro = options.metro ?? true;
  const environment = options.environment ?? (metro ? "metro" : "city");
  const cityStreetFinish = options.cityStreetFinish ?? true;
  const retainingThresholdM =
    options.retainingThresholdM ?? RETAINING_MIN_ELEV_M;

  const pavementParts = [];
  const roadParts = [];
  const markingParts = [];
  const retainingParts = [];
  const roadSurfaces = [];

  let totalTriangles = 0;
  let roadSegments = 0;
  let pavementSegments = 0;

  // 1. Build adaptive 3D sidewalk / pavement slabs + Cairo overpass retaining walls
  for (const road of roads) {
    const basis = extractRoadBasis(road);
    const pavementHalfW = road.width / 2 + PAVEMENT_SIDEWALK_MARGIN_M;
    const sMin = -pavementHalfW;
    const sMax = basis.length + pavementHalfW;
    const sGrid = buildAdaptiveSGrid(
      basis,
      sMin,
      sMax,
      pavementHalfW,
      elev,
      options,
    );
    const lateralStrips = !sGrid.anyTerrain
      ? 1
      : pavementHalfW * 2 >= 15
        ? 4
        : 3;
    const tValues = buildTValues(pavementHalfW, lateralStrips);

    const minBaseSkirtY = -0.08 + Math.min(0, sGrid.minElev);
    const pavementSlab = buildRibbonSlabGeometry({
      basis,
      sValues: sGrid.sValues,
      tValues,
      topOffset: PAVEMENT_TOP_OFFSET_M,
      bottomFn: (e) =>
        e >= retainingThresholdM + 0.1
          ? e - 0.24
          : Math.min(minBaseSkirtY, e - 0.16),
      elev,
      tileMetres: PAVEMENT_TILE_METRES,
    });
    pavementParts.push(pavementSlab.geometry);
    pavementSegments += sGrid.sValues.length - 1;
    totalTriangles += pavementSlab.triangles;

    // Emit retaining embankment side aprons + flyover piers when rising >= 1.15 m
    if (sGrid.maxElev >= retainingThresholdM) {
      const nS = sGrid.sValues.length;
      const nT = tValues.length;
      let seg = 0;
      while (seg < nS - 1) {
        const segMax = (idx) =>
          Math.max(
            pavementSlab.eGrid[idx * nT],
            pavementSlab.eGrid[idx * nT + (nT - 1)],
            pavementSlab.eGrid[(idx + 1) * nT],
            pavementSlab.eGrid[(idx + 1) * nT + (nT - 1)],
          );
        if (segMax(seg) < retainingThresholdM) {
          seg++;
          continue;
        }
        const spanStart = seg;
        while (seg + 1 < nS - 1 && segMax(seg + 1) >= retainingThresholdM) {
          seg++;
        }
        const spanEnd = seg + 1;
        const wall = buildRetainingSpanGeometry({
          basis,
          sValues: sGrid.sValues,
          eGrid: pavementSlab.eGrid,
          nT,
          iStart: spanStart,
          iEnd: spanEnd,
          pavementHalfW,
          tileMetres: PAVEMENT_TILE_METRES,
        });
        retainingParts.push(wall.geometry);
        totalTriangles += wall.triangles;

        // Concrete flyover piers spaced every ~16 m along elevated stretches
        const sSpanStart = sGrid.sValues[spanStart];
        const sSpanEnd = sGrid.sValues[spanEnd];
        const spanLen = sSpanEnd - sSpanStart;
        if (spanLen >= 4.0) {
          const otherRoads = roads.filter((other) => other !== road);
          const pierStep = 16;
          const firstPier =
            spanLen < pierStep ? 0.5 * (sSpanStart + sSpanEnd) : sSpanStart + 6;
          for (let sp = firstPier; sp <= sSpanEnd - 2.0; sp += pierStep) {
            const eL = sampleBasisElev(basis, sp, -pavementHalfW, elev);
            const eR = sampleBasisElev(basis, sp, pavementHalfW, elev);
            const pierElev = Math.min(eL, eR);
            if (pierElev < retainingThresholdM + 0.15) continue;
            const px = basis.x1 + basis.ux * sp;
            const pz = basis.z1 + basis.uz * sp;
            if (otherRoads.length && pointOnAnyRoad({ x: px, z: pz }, otherRoads, -2.0)) {
              continue;
            }
            const pier = buildButtressPierGeometry({
              basis,
              sCenter: sp,
              pierLength: 1.35,
              pavementHalfW,
              topElev: pierElev,
              tileMetres: PAVEMENT_TILE_METRES,
            });
            retainingParts.push(pier.geometry);
            totalTriangles += pier.triangles;
            if (spanLen < pierStep) break;
          }
        }
        seg++;
      }
    }
  }

  // 2. Build adaptive 3D asphalt road slabs (with cross-camber strips on avenues)
  for (const road of roads) {
    const basis = extractRoadBasis(road);
    const halfW = road.width / 2;
    const sMin = -halfW;
    const sMax = basis.length + halfW;
    const sGrid = buildAdaptiveSGrid(basis, sMin, sMax, halfW, elev, options);
    const lateralStrips = !sGrid.anyTerrain
      ? 1
      : road.width >= 11
        ? 3
        : road.width >= 5.5
          ? 2
          : 1;
    const tValues = buildTValues(halfW, lateralStrips);

    const roadSlab = buildRibbonSlabGeometry({
      basis,
      sValues: sGrid.sValues,
      tValues,
      topOffset: ROAD_TOP_OFFSET_M,
      bottomFn: (e) => ROAD_BOTTOM_OFFSET_M + e,
      elev,
      tileMetres: ROAD_TILE_METRES,
    });
    roadParts.push(roadSlab.geometry);
    roadSegments += sGrid.sValues.length - 1;
    totalTriangles += roadSlab.triangles;

    const bounds = computeSurfaceBounds(basis, sMin, sMax, halfW);
    roadSurfaces.push({
      road,
      basis,
      halfW,
      sMin,
      sMax,
      sValues: sGrid.sValues,
      tValues,
      eGrid: roadSlab.eGrid,
      ...bounds,
    });
  }

  // 3. Build slope-conformed lane markings & zebra crosswalks (0.1205 + elev)
  for (let rIdx = 0; rIdx < roadSurfaces.length; rIdx++) {
    const roadSurface = roadSurfaces[rIdx];
    const { road, basis } = roadSurface;

    if (isDiagonalRoad(road)) {
      const crossings = metro
        ? diagAvenueCrossings(road, drivingRoads, roads)
        : [];
      for (const along of crossings) {
        for (
          let offset = -road.width / 2 + 0.75;
          offset < road.width / 2 - 0.3;
          offset += 0.95
        ) {
          markingParts.push(
            buildConformedMarking({
              roadSurface,
              allRoadSurfaces: roadSurfaces,
              sCenter: along,
              tCenter: offset,
              markWidth: 0.48,
              markLength: 2.2,
              elev,
              cityStreetFinish,
            }),
          );
        }
      }
      if (road.marking === "center" && !road.sideStreet && !road.parkingBay) {
        const otherRoads = roads.filter(
          (other) => other !== road && (!other.parkingBay || other.supportApron),
        );
        for (let n = 4; n < basis.length - 4; n += 9) {
          const p = {
            x: basis.x1 + basis.ux * n,
            z: basis.z1 + basis.uz * n,
          };
          if (
            pointOnAnyRoad(p, otherRoads, -2) ||
            crossings.some((along) => Math.abs(along - n) < 3.5)
          ) {
            continue;
          }
          markingParts.push(
            buildConformedMarking({
              roadSurface,
              allRoadSurfaces: roadSurfaces,
              sCenter: n,
              tCenter: 0,
              markWidth: 0.12,
              markLength: 2.8,
              elev,
              cityStreetFinish,
            }),
          );
        }
      }
      continue;
    }

    const crossings = metro ? avenueCrossings(road, drivingRoads) : [];
    const vertical = road.axis === "z";
    for (const along of crossings) {
      const sCenter = along - basis.sOrigin;
      for (
        let offset = -road.width / 2 + 0.75;
        offset < road.width / 2 - 0.3;
        offset += 0.95
      ) {
        const tCenter = vertical ? offset : -offset;
        markingParts.push(
          buildConformedMarking({
            roadSurface,
            allRoadSurfaces: roadSurfaces,
            sCenter,
            tCenter,
            markWidth: 0.48,
            markLength: 2.2,
            elev,
            cityStreetFinish,
          }),
        );
      }
    }

    for (let n = road.min + 4; !road.parkingBay && n < road.max; n += 9) {
      const p = vertical ? { x: road.fixed, z: n } : { x: n, z: road.fixed };
      const crossing = roads.some(
        (other) => other.axis !== road.axis && pointOnAnyRoad(p, [other], -2),
      );
      if (
        crossing ||
        crossings.some((along) => Math.abs(along - n) < 3) ||
        road.sideStreet ||
        road.parkingBay ||
        road.marking === "none" ||
        ((environment === "egypt" || metro) && road.marking !== "center")
      ) {
        continue;
      }
      markingParts.push(
        buildConformedMarking({
          roadSurface,
          allRoadSurfaces: roadSurfaces,
          sCenter: n - basis.sOrigin,
          tCenter: 0,
          markWidth: 0.11,
          markLength: 2.8,
          elev,
          cityStreetFinish,
        }),
      );
    }
  }

  const sampleRoadElevationAt = (x, z) => {
    let best = null;
    for (let i = 0; i < roadSurfaces.length; i++) {
      const surf = roadSurfaces[i];
      if (x < surf.minX || x > surf.maxX || z < surf.minZ || z > surf.maxZ) {
        continue;
      }
      const v = evaluateRoadSurfaceMeshElev(surf, x, z);
      if (v !== null && (best === null || v > best)) best = v;
    }
    return best ?? elev(x, z);
  };

  return {
    pavementParts,
    roadParts,
    markingParts,
    retainingParts,
    roadSurfaces,
    sampleRoadElevationAt,
    diagnostics: {
      roadCount: roads.length,
      roadSegments,
      pavementSegments,
      markingCount: markingParts.length,
      retainingCount: retainingParts.length,
      triangles: totalTriangles,
    },
  };
}

function assembleMergedMesh(parts, color, { vertexColors = false, castShadow = false, name = "" } = {}) {
  if (!parts.length) return null;
  const merged = mergeGeometries(parts);
  for (const part of parts) part.dispose();
  if (!merged) throw new Error(`Unable to assemble merged surface${name ? ` (${name})` : ""}`);
  const mat = new THREE.MeshStandardMaterial({
    color,
    roughness: 0.9,
    vertexColors,
  });
  const mesh = new THREE.Mesh(merged, mat);
  if (name) mesh.name = name;
  mesh.userData.owned = true;
  mesh.receiveShadow = true;
  mesh.castShadow = castShadow;
  return mesh;
}

export function buildElevatedRoadMeshes(world, options = {}) {
  const roads = options.roads ?? world?.roads ?? [];
  const drivingRoads = options.drivingRoads ?? world?.drivingRoads ?? roads;
  const environment = options.environment ?? world?.environment ?? "metro";
  const metro = options.metro ?? environment === "metro";
  const cityStreetFinish =
    options.cityStreetFinish ??
    (environment === "metro" && (world?.config?.cityVersion ?? 5) >= 4);
  const elev = resolveElevationFn(world, options);

  const built = buildTerrainRoadParts(roads, drivingRoads, elev, {
    ...options,
    metro,
    environment,
    cityStreetFinish,
  });

  const pavementMesh = assembleMergedMesh(
    built.pavementParts,
    cityStreetFinish ? CITY_V4_SURFACE_BASE.pavement : 0xc1b9a5,
    { name: "road-pavement" },
  );
  const retainingMesh = assembleMergedMesh(
    built.retainingParts,
    cityStreetFinish ? CITY_V4_SURFACE_BASE.retaining : 0xb5ae9c,
    { castShadow: true, name: "road-retaining-walls" },
  );
  const roadMesh = assembleMergedMesh(
    built.roadParts,
    cityStreetFinish ? CITY_V4_SURFACE_BASE.road : 0x484b49,
    { name: "road-asphalt" },
  );
  const markingsMesh = assembleMergedMesh(
    built.markingParts,
    cityStreetFinish ? 0xffffff : 0xcec7ac,
    {
      vertexColors: cityStreetFinish,
      castShadow: !cityStreetFinish,
      name: "road-markings",
    },
  );

  const meshes = [pavementMesh, retainingMesh, roadMesh, markingsMesh].filter(
    Boolean,
  );
  if (options.scene) {
    for (const mesh of meshes) options.scene.add(mesh);
  }
  if (options.surfaces) {
    if (pavementMesh) options.surfaces.pavement?.push(pavementMesh);
    if (retainingMesh) options.surfaces.pavement?.push(retainingMesh);
    if (roadMesh) options.surfaces.road?.push(roadMesh);
  }

  let disposed = false;
  return {
    pavement: pavementMesh,
    road: roadMesh,
    markings: markingsMesh,
    retaining: retainingMesh,
    pavementMesh,
    roadMesh,
    markingsMesh,
    retainingMesh,
    meshes,
    sampleRoadElevationAt: built.sampleRoadElevationAt,
    diagnostics: built.diagnostics,
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const mesh of meshes) {
        mesh.removeFromParent();
        mesh.geometry.dispose();
        mesh.material.dispose();
      }
    },
  };
}
