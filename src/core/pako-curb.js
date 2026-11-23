import { STEP, VEHICLE, clamp } from "./config.js";
import {
  angleDelta, bodyOnRoad, corners, distance, interpolate, overlaps, pointOnRoad, roadRect,
} from "./geometry.js";
import { PLAYER_VEHICLE } from "./vehicle-spec.js";

export const METRO_CURB_SUPPORT = "metro-survey-v1";
export const METRO_CITY_CURBS = "metro-city-curbs-v2";
const MAX_PACE = 2.8;
const MAX_YAW_V1 = .35;
const BRAKE_WINDOW = .8;
const CITY_MAX_PACE = 14.0;
const CITY_MAX_YAW = 3.6;
const CITY_BRAKE_WINDOW = 0.95;
const ASPHALT_Y = .115, GUTTER_Y = .1165, STREET_LIP_Y = .125, TOE_Y = .0715, SIDEWALK_Y = .07, LIP_Y = .175;
const COURT_Y = -.05;
// The original SUV's centre spine bottoms at .22 m; reserve .07 for travel
// and .01 for load/measurement error. No obstacle is exempted from contacts.
const CLEARANCE = .14;
const WHEELS = [
  ["frontLeft", -1, 1], ["frontRight", 1, 1],
  ["rearLeft", -1, -1], ["rearRight", 1, -1],
];
const CURB_CELL_M = 24;
const CURB_INV_CELL = 1 / CURB_CELL_M;
const curbGridCache = new WeakMap();
const scratchPoint = { x: 0, z: 0 };
const scratchCorners = [{ x: 0, z: 0 }, { x: 0, z: 0 }, { x: 0, z: 0 }, { x: 0, z: 0 }];

function fillScratchCorners(pose, s, c) {
  const hw = (pose.width ?? 0) / 2, hl = (pose.length ?? 0) / 2;
  const cw = c * hw, sw = s * hw, cl = s * hl, sl = c * hl;
  const x = pose.x, z = pose.z;
  scratchCorners[0].x = x - cw - cl; scratchCorners[0].z = z + sw - sl;
  scratchCorners[1].x = x + cw - cl; scratchCorners[1].z = z - sw - sl;
  scratchCorners[2].x = x + cw + cl; scratchCorners[2].z = z - sw + sl;
  scratchCorners[3].x = x - cw + cl; scratchCorners[3].z = z + sw + sl;
  return scratchCorners;
}

const curbCellKey = (cx, cz) => (cx << 16) ^ (cz & 0xffff);

function insertGridRect(map, item, minX, maxX, minZ, maxZ) {
  const cx0 = Math.floor(minX * CURB_INV_CELL);
  const cx1 = Math.floor(maxX * CURB_INV_CELL);
  const cz0 = Math.floor(minZ * CURB_INV_CELL);
  const cz1 = Math.floor(maxZ * CURB_INV_CELL);
  for (let cx = cx0; cx <= cx1; cx++) {
    const hi = cx << 16;
    for (let cz = cz0; cz <= cz1; cz++) {
      const k = hi ^ (cz & 0xffff);
      let bucket = map.get(k);
      if (bucket) bucket.push(item);
      else map.set(k, [item]);
    }
  }
}

function buildCurbGrid(curb) {
  const sites = curb.sites ?? [];
  const courtyards = curb.courtyards ?? [];
  const baseSiteCells = new Map();
  const site3Cells = new Map();
  const site12Cells = new Map();
  const courtCells = new Map();
  const court12Cells = new Map();
  const siteIndex = new Map();
  const siteById = new Map();
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;

  for (let i = 0; i < sites.length; i++) {
    const s = sites[i];
    siteIndex.set(s, i);
    if (s.id) siteById.set(s.id, s);
    const sMinX = s.axis === "z" ? Math.min(s.minX, s.edge) : s.minX;
    const sMaxX = s.axis === "z" ? Math.max(s.maxX, s.edge) : s.maxX;
    const sMinZ = s.axis === "x" ? Math.min(s.minZ, s.edge) : s.minZ;
    const sMaxZ = s.axis === "x" ? Math.max(s.maxZ, s.edge) : s.maxZ;
    if (sMinX - 12.5 < minX) minX = sMinX - 12.5;
    if (sMaxX + 12.5 > maxX) maxX = sMaxX + 12.5;
    if (sMinZ - 12.5 < minZ) minZ = sMinZ - 12.5;
    if (sMaxZ + 12.5 > maxZ) maxZ = sMaxZ + 12.5;
    insertGridRect(baseSiteCells, s, sMinX, sMaxX, sMinZ, sMaxZ);
    insertGridRect(site3Cells, s, sMinX - 3, sMaxX + 3, sMinZ - 3, sMaxZ + 3);
    insertGridRect(site12Cells, s, sMinX - 12.01, sMaxX + 12.01, sMinZ - 12.01, sMaxZ + 12.01);
  }

  for (let i = 0; i < courtyards.length; i++) {
    const c = courtyards[i];
    if (c.minX - 12.5 < minX) minX = c.minX - 12.5;
    if (c.maxX + 12.5 > maxX) maxX = c.maxX + 12.5;
    if (c.minZ - 12.5 < minZ) minZ = c.minZ - 12.5;
    if (c.maxZ + 12.5 > maxZ) maxZ = c.maxZ + 12.5;
    insertGridRect(courtCells, c, c.minX, c.maxX, c.minZ, c.maxZ);
    insertGridRect(court12Cells, c, c.minX - 12.01, c.maxX + 12.01, c.minZ - 12.01, c.maxZ + 12.01);
  }

  const grid = {
    sitesRef: curb.sites,
    sitesLen: sites.length,
    courtsRef: curb.courtyards,
    courtsLen: courtyards.length,
    baseSiteCells,
    site3Cells,
    site12Cells,
    courtCells,
    court12Cells,
    siteIndex,
    siteById,
    minX,
    maxX,
    minZ,
    maxZ,
  };
  curbGridCache.set(curb, grid);
  return grid;
}

function getCurbGrid(curb) {
  const cached = curbGridCache.get(curb);
  if (cached &&
      cached.sitesRef === curb.sites &&
      cached.sitesLen === (curb.sites ? curb.sites.length : 0) &&
      cached.courtsRef === curb.courtyards &&
      cached.courtsLen === (curb.courtyards ? curb.courtyards.length : 0)) {
    return cached;
  }
  return buildCurbGrid(curb);
}

function lookupCell(grid, map, x, z) {
  if (x < grid.minX || x > grid.maxX || z < grid.minZ || z > grid.maxZ) return undefined;
  return map.get(curbCellKey(Math.floor(x * CURB_INV_CELL), Math.floor(z * CURB_INV_CELL)));
}

function staticBox(site) {
  const c = Math.abs(Math.cos(site.heading ?? 0)), s = Math.abs(Math.sin(site.heading ?? 0));
  const width = site.width ?? (site.radius ?? 0) * 2;
  const length = site.length ?? (site.radius ?? 0) * 2;
  const x = (width * c + length * s) / 2, z = (width * s + length * c) / 2;
  return { minX: site.x - x, maxX: site.x + x, minZ: site.z - z, maxZ: site.z + z };
}

function roadWorldPolygon(road) {
  if (road.axis === "diag") {
    const h = road.width / 2;
    const ux = road.ux, uz = road.uz, x1 = road.x1, z1 = road.z1, b = road.length + h;
    return [
      { x: x1 - h * ux + h * uz, z: z1 - h * uz - h * ux },
      { x: x1 + b * ux + h * uz, z: z1 + b * uz - h * ux },
      { x: x1 + b * ux - h * uz, z: z1 + b * uz + h * ux },
      { x: x1 - h * ux - h * uz, z: z1 - h * uz + h * ux },
    ];
  }
  const r = roadRect(road);
  return [
    { x: r.minX, z: r.minZ },
    { x: r.maxX, z: r.minZ },
    { x: r.maxX, z: r.maxZ },
    { x: r.minX, z: r.maxZ },
  ];
}

function staticWorldPolygon(site) {
  const width = site.width ?? (site.radius ?? 0) * 2;
  const length = site.length ?? (site.radius ?? 0) * 2;
  return corners({ x: site.x, z: site.z, heading: site.heading ?? 0, width, length });
}

function clipPolyHalfV(pts, boundary, sign) {
  const out = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    const da = (a.v - boundary) * sign, db = (b.v - boundary) * sign;
    if (da >= 0) out.push(a);
    if ((da >= 0) !== (db >= 0)) {
      const t = da / (da - db);
      out.push({ u: a.u + (b.u - a.u) * t, v: boundary });
    }
  }
  return out;
}

function polySliceAtV(pts, vLine) {
  let uLo = Infinity, uHi = -Infinity, hit = false;
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    if (Math.abs(a.v - vLine) <= 1e-6) {
      uLo = Math.min(uLo, a.u);
      uHi = Math.max(uHi, a.u);
      hit = true;
    }
    if ((a.v < vLine && b.v > vLine) || (a.v > vLine && b.v < vLine)) {
      const u = a.u + (b.u - a.u) * ((vLine - a.v) / (b.v - a.v));
      uLo = Math.min(uLo, u);
      uHi = Math.max(uHi, u);
      hit = true;
    }
  }
  return hit ? [uLo, uHi] : null;
}

function projectWorldPolyUV(worldPts, road) {
  if (road.axis === "diag") {
    const ux = road.ux, uz = road.uz, x1 = road.x1, z1 = road.z1;
    return worldPts.map(p => {
      const dx = p.x - x1, dz = p.z - z1;
      return { u: dx * ux + dz * uz, v: -dx * uz + dz * ux };
    });
  }
  return road.axis === "x"
    ? worldPts.map(p => ({ u: p.x, v: p.z }))
    : worldPts.map(p => ({ u: p.z, v: p.x }));
}

function polyBandUInterval(uvPts, bandLo, bandHi) {
  let minV = Infinity, maxV = -Infinity;
  for (let i = 0; i < uvPts.length; i++) {
    const v = uvPts[i].v;
    if (v < minV) minV = v;
    if (v > maxV) maxV = v;
  }
  if (maxV < bandLo || minV > bandHi) return null;
  const c1 = clipPolyHalfV(uvPts, bandLo, 1);
  if (!c1.length) return null;
  const c2 = clipPolyHalfV(c1, bandHi, -1);
  if (!c2.length) return null;
  let uLo = Infinity, uHi = -Infinity;
  for (let i = 0; i < c2.length; i++) {
    const u = c2[i].u;
    if (u < uLo) uLo = u;
    if (u > uHi) uHi = u;
  }
  return [uLo, uHi];
}

export function surveyMetroCurb(world, mode = METRO_CURB_SUPPORT) {
  if (mode === METRO_CURB_SUPPORT) {
    const road = world.roads.find(r => r.id === "tahrir-boulevard");
    if (world.environment !== "metro" || world.config.cityVersion !== 4 ||
        road?.axis !== "x" || road.zone !== "avenue" || road.fixed !== -112 ||
        road.width !== 14 || road.min > -249 || road.max < -206) return null;
    const { maxZ: edgeZ, minZ } = roadRect(road);
    // Only this mid-block, +z existing footway, away from the junction cuts
    // in buildV4StreetSurfaces. The City roads and route graph are not modified.
    const site = { id: "tahrir-positive-midblock", minX: -249, maxX: -206,
      minZ: minZ + .08, edgeZ, maxZ: roadRect(road, -2.5).maxZ - .12 };
    if (world.roads.some(other => {
      if (other === road) return false;
      const r = roadRect(other);
      return r.minX <= site.maxX && r.maxX >= site.minX && r.minZ <= site.maxZ && r.maxZ >= edgeZ;
    })) return null;
    return Object.freeze(site);
  }
  if (mode !== METRO_CITY_CURBS) return null;
  const cityVersion = world?.config?.cityVersion ?? 0;
  if (world?.environment !== "metro" || cityVersion < 4 || !Array.isArray(world.roads))
    return null;

  const nonBayRoads = world.roads.filter(r => !r.parkingBay).map(road => ({
    road,
    rect: roadRect(road),
    poly: roadWorldPolygon(road),
  }));
  const rawStatics = world.statics ?? [];
  const statics = rawStatics.map(staticBox);
  const staticPolys = cityVersion >= 5 || world.roads.some(r => r.axis === "diag")
    ? rawStatics.map(s => ({ aabb: staticBox(s), poly: staticWorldPolygon(s) }))
    : null;
  const sites = [];

  for (const road of world.roads) {
    if (road.parkingBay || road.supportApron) continue;
    if (road.axis === "diag") {
      const roadAabb = roadRect(road, -2.6);
      for (const side of [-1, 1]) {
        const edge = side * (road.width / 2);
        const innerCross = -side * (road.width / 2 - .08);
        const outerCross = edge + side * 2.38;
        const crossLo = Math.min(innerCross, outerCross);
        const crossHi = Math.max(innerCross, outerCross);
        const sidewalkLo = Math.min(edge, outerCross);
        const sidewalkHi = Math.max(edge, outerCross);
        const startPt = {
          x: road.x1 - outerCross * road.uz,
          z: road.z1 + outerCross * road.ux,
        };
        const endPt = {
          x: road.x1 + road.length * road.ux - outerCross * road.uz,
          z: road.z1 + road.length * road.uz + outerCross * road.ux,
        };
        const start = pointOnRoad(startPt, world.roads) ? 0 : 1.2;
        const end = pointOnRoad(endPt, world.roads) ? road.length : road.length - 1.2;
        if (end - start < 9.0) continue;

        const sidewalkEnterLo = Math.min(edge + .05 * side, outerCross);
        const sidewalkEnterHi = Math.max(edge + .05 * side, outerCross);
        const staticBandLo = Math.min(edge - .05 * side, edge + 2.53 * side);
        const staticBandHi = Math.max(edge - .05 * side, edge + 2.53 * side);
        const cuts = [];

        for (const { road: other, rect: r, poly } of nonBayRoads) {
          if (other === road) continue;
          if (r.maxX < roadAabb.minX || r.minX > roadAabb.maxX ||
              r.maxZ < roadAabb.minZ || r.minZ > roadAabb.maxZ) continue;
          const uv = projectWorldPolyUV(poly, road);
          const span = polyBandUInterval(uv, sidewalkEnterLo, sidewalkEnterHi);
          if (!span) continue;
          const innerSlice = polySliceAtV(uv, sidewalkLo + 1e-6);
          const outerSlice = polySliceAtV(uv, sidewalkHi - 1e-6);
          if (innerSlice && outerSlice) {
            const bothLo = Math.max(innerSlice[0], outerSlice[0]);
            const bothHi = Math.min(innerSlice[1], outerSlice[1]);
            if (bothHi - bothLo > .4) {
              cuts.push([bothLo + .12, bothHi - .12]);
              continue;
            }
          }
          cuts.push([span[0] - .30, span[1] + .30]);
        }

        if (staticPolys) {
          for (const { aabb, poly } of staticPolys) {
            if (aabb.maxX < roadAabb.minX || aabb.minX > roadAabb.maxX ||
                aabb.maxZ < roadAabb.minZ || aabb.minZ > roadAabb.maxZ) continue;
            const uv = projectWorldPolyUV(poly, road);
            const span = polyBandUInterval(uv, staticBandLo, staticBandHi);
            if (span) cuts.push([span[0] - .30, span[1] + .30]);
          }
        }

        cuts.sort((a, b) => a[0] - b[0]);
        const spans = [];
        let at = start;
        for (const [c0, c1] of cuts) {
          if (c1 <= at) continue;
          const stop = Math.min(end, c0);
          if (stop - at >= 9.0) spans.push([at, stop]);
          at = Math.max(at, c1);
          if (at >= end) break;
        }
        if (end - at >= 9.0) spans.push([at, end]);
        if (!spans.length) continue;

        const sideTag = side > 0 ? "pos" : "neg";
        const avenue = road.zone === "avenue";
        const ux = road.ux, uz = road.uz, x1 = road.x1, z1 = road.z1;
        for (let spanIndex = 0; spanIndex < spans.length; spanIndex++) {
          const [a, b] = spans[spanIndex];
          const p0x = x1 + a * ux - crossLo * uz, p0z = z1 + a * uz + crossLo * ux;
          const p1x = x1 + b * ux - crossLo * uz, p1z = z1 + b * uz + crossLo * ux;
          const p2x = x1 + b * ux - crossHi * uz, p2z = z1 + b * uz + crossHi * ux;
          const p3x = x1 + a * ux - crossHi * uz, p3z = z1 + a * uz + crossHi * ux;
          sites.push(Object.freeze({
            id: `${road.id}:${sideTag}:${spanIndex}`,
            roadId: road.id,
            axis: "diag",
            side,
            avenue,
            x1,
            z1,
            ux,
            uz,
            edge,
            alongMin: a,
            alongMax: b,
            crossLo,
            crossHi,
            minX: Math.min(p0x, p1x, p2x, p3x),
            maxX: Math.max(p0x, p1x, p2x, p3x),
            minZ: Math.min(p0z, p1z, p2z, p3z),
            maxZ: Math.max(p0z, p1z, p2z, p3z),
          }));
        }
      }
      continue;
    }

    const alongX = road.axis === "x";
    for (const side of [-1, 1]) {
      const edge = road.fixed + side * (road.width / 2);
      const innerCross = road.fixed - side * (road.width / 2 - .08);
      const outerCross = edge + side * 2.38;
      const crossLo = Math.min(innerCross, outerCross);
      const crossHi = Math.max(innerCross, outerCross);
      const sidewalkLo = Math.min(edge, outerCross);
      const sidewalkHi = Math.max(edge, outerCross);
      const startPt = alongX ? { x: road.min, z: outerCross } : { x: outerCross, z: road.min };
      const endPt = alongX ? { x: road.max, z: outerCross } : { x: outerCross, z: road.max };
      const start = pointOnRoad(startPt, world.roads) ? road.min : road.min + 1.2;
      const end = pointOnRoad(endPt, world.roads) ? road.max : road.max - 1.2;
      if (end - start < 9.0) continue;

      const sidewalkEnterLo = Math.min(edge + .05 * side, outerCross);
      const sidewalkEnterHi = Math.max(edge + .05 * side, outerCross);
      const staticBandLo = Math.min(edge - .05 * side, edge + 2.53 * side);
      const staticBandHi = Math.max(edge - .05 * side, edge + 2.53 * side);
      const cuts = [];
      for (const { road: other, rect: r, poly } of nonBayRoads) {
        if (other === road) continue;
        if (other.axis === "diag") {
          const crossMin = alongX ? r.minZ : r.minX;
          const crossMax = alongX ? r.maxZ : r.maxX;
          if (crossMin > sidewalkEnterHi || crossMax < sidewalkEnterLo) continue;
          const uv = projectWorldPolyUV(poly, road);
          const span = polyBandUInterval(uv, sidewalkEnterLo, sidewalkEnterHi);
          if (!span) continue;
          const innerSlice = polySliceAtV(uv, sidewalkLo + 1e-6);
          const outerSlice = polySliceAtV(uv, sidewalkHi - 1e-6);
          if (innerSlice && outerSlice) {
            const bothLo = Math.max(innerSlice[0], outerSlice[0]);
            const bothHi = Math.min(innerSlice[1], outerSlice[1]);
            if (bothHi - bothLo > .4) {
              cuts.push([bothLo + .12, bothHi - .12]);
              continue;
            }
          }
          cuts.push([span[0] - .30, span[1] + .30]);
          continue;
        }
        const crossMin = alongX ? r.minZ : r.minX;
        const crossMax = alongX ? r.maxZ : r.maxX;
        if (crossMin <= sidewalkEnterHi && crossMax >= sidewalkEnterLo) {
          const [rLo, rHi] = alongX ? [r.minX, r.maxX] : [r.minZ, r.maxZ];
          if (crossMin <= sidewalkLo + 1e-6 && crossMax >= sidewalkHi - 1e-6 && rHi - rLo > .4)
            cuts.push([rLo + .12, rHi - .12]);
          else
            cuts.push([rLo - .30, rHi + .30]);
        }
      }
      for (const b of statics) {
        const crossMin = alongX ? b.minZ : b.minX;
        const crossMax = alongX ? b.maxZ : b.maxX;
        if (crossMin <= staticBandHi && crossMax >= staticBandLo)
          cuts.push(alongX ? [b.minX - .30, b.maxX + .30] : [b.minZ - .30, b.maxZ + .30]);
      }
      cuts.sort((a, b) => a[0] - b[0]);
      const spans = [];
      let at = start;
      for (const [c0, c1] of cuts) {
        if (c1 <= at) continue;
        const stop = Math.min(end, c0);
        if (stop - at >= 9.0) spans.push([at, stop]);
        at = Math.max(at, c1);
        if (at >= end) break;
      }
      if (end - at >= 9.0) spans.push([at, end]);
      if (!spans.length) continue;

      const sideTag = side > 0 ? "pos" : "neg";
      const avenue = road.zone === "avenue";
      for (let spanIndex = 0; spanIndex < spans.length; spanIndex++) {
        const [a, b] = spans[spanIndex];
        sites.push(Object.freeze({
          id: `${road.id}:${sideTag}:${spanIndex}`,
          roadId: road.id,
          axis: road.axis,
          side,
          avenue,
          edge,
          minX: alongX ? a : crossLo,
          maxX: alongX ? b : crossHi,
          minZ: alongX ? crossLo : a,
          maxZ: alongX ? crossHi : b,
        }));
      }
    }
  }
  const courtyards = [];
  const pushCourtyard = (id, minX, maxX, minZ, maxZ) => {
    if (minX < maxX && minZ < maxZ)
      courtyards.push(Object.freeze({ id, minX, maxX, minZ, maxZ }));
  };
  if (cityVersion === 4) {
    const roadById = new Map();
    for (const r of world.roads) if (r?.id) roadById.set(r.id, r);
    const zRoad = id => { const r = roadById.get(id); return r?.axis === "z" ? r : null; };
    const xRoad = id => { const r = roadById.get(id); return r?.axis === "x" ? r : null; };
    const corniche = zRoad("corniche-avenue"), gateway = zRoad("gateway-avenue");
    const tahrir = xRoad("tahrir-boulevard"), university = xRoad("university-avenue");
    const southLink = zRoad("bab-el-louk-link"), school = xRoad("school-local");
    const entry = xRoad("entry-local"), westLocal = zRoad("west-local"), eastConn = zRoad("east-connector");
    if (corniche && gateway && tahrir && university)
      pushCourtyard("metro-avenue-blocks", corniche.fixed, gateway.fixed, tahrir.fixed, university.fixed);
    if (gateway && southLink && tahrir && school)
      pushCourtyard("metro-feeder-blocks", gateway.fixed, southLink.fixed, tahrir.fixed, school.fixed);
    if (westLocal && eastConn && entry && school)
      pushCourtyard("metro-district-blocks", westLocal.fixed, eastConn.fixed, entry.fixed, school.fixed);
  } else {
    const rawDriving = Array.isArray(world.drivingRoads) && world.drivingRoads.length
      ? world.drivingRoads
      : world.roads;
    const hullRoads = rawDriving.filter(r => r && !r.parkingBay && !r.supportApron);
    if (hullRoads.length >= 4 && hullRoads.some(r => r.axis === "x") && hullRoads.some(r => r.axis === "z")) {
      let minRoadX = Infinity, maxRoadX = -Infinity, minRoadZ = Infinity, maxRoadZ = -Infinity;
      for (const r of hullRoads) {
        if (r.axis === "z") {
          minRoadX = Math.min(minRoadX, r.fixed);
          maxRoadX = Math.max(maxRoadX, r.fixed);
          minRoadZ = Math.min(minRoadZ, r.min);
          maxRoadZ = Math.max(maxRoadZ, r.max);
        } else if (r.axis === "x") {
          minRoadX = Math.min(minRoadX, r.min);
          maxRoadX = Math.max(maxRoadX, r.max);
          minRoadZ = Math.min(minRoadZ, r.fixed);
          maxRoadZ = Math.max(maxRoadZ, r.fixed);
        } else if (r.axis === "diag") {
          minRoadX = Math.min(minRoadX, r.x1, r.x2);
          maxRoadX = Math.max(maxRoadX, r.x1, r.x2);
          minRoadZ = Math.min(minRoadZ, r.z1, r.z2);
          maxRoadZ = Math.max(maxRoadZ, r.z1, r.z2);
        }
      }
      pushCourtyard("metro-grand-blocks", minRoadX, maxRoadX, minRoadZ, maxRoadZ);
    }
  }

  if (!sites.length) return null;
  const result = Object.freeze({
    mode: METRO_CITY_CURBS,
    maxPace: CITY_MAX_PACE,
    maxYawRate: CITY_MAX_YAW,
    sites: Object.freeze(sites),
    courtyards: Object.freeze(courtyards),
  });
  getCurbGrid(result);
  return result;
}

function poseInSingleRoad(pose, roads, margin = .08) {
  if (!roads) return false;
  const h0 = pose.heading ?? 0;
  const s = Math.sin(h0), c = Math.cos(h0);
  const hw = (pose.width ?? 0) / 2, hl = (pose.length ?? 0) / 2;
  const cw = c * hw, sw = s * hw, cl = c * hl, sl = s * hl;
  const x = pose.x, z = pose.z;
  const x0 = x - cw - sl, z0 = z + sw - cl;
  const x1 = x + cw - sl, z1 = z - sw - cl;
  const x2 = x + cw + sl, z2 = z - sw + cl;
  const x3 = x - cw + sl, z3 = z + sw + cl;
  const minX = Math.min(x0, x1, x2, x3);
  const maxX = Math.max(x0, x1, x2, x3);
  const minZ = Math.min(z0, z1, z2, z3);
  const maxZ = Math.max(z0, z1, z2, z3);
  for (let i = 0; i < roads.length; i++) {
    const road = roads[i];
    const h = road.width / 2 - margin;
    if (h <= 0) continue;
    if (road.axis === "diag") {
      const ux = road.ux, uz = road.uz, rx1 = road.x1, rz1 = road.z1, maxAlong = road.length + h;
      const d0x = x0 - rx1, d0z = z0 - rz1, a0 = d0x * ux + d0z * uz;
      if (a0 < -h || a0 > maxAlong || Math.abs(-d0x * uz + d0z * ux) > h) continue;
      const d1x = x1 - rx1, d1z = z1 - rz1, a1 = d1x * ux + d1z * uz;
      if (a1 < -h || a1 > maxAlong || Math.abs(-d1x * uz + d1z * ux) > h) continue;
      const d2x = x2 - rx1, d2z = z2 - rz1, a2 = d2x * ux + d2z * uz;
      if (a2 < -h || a2 > maxAlong || Math.abs(-d2x * uz + d2z * ux) > h) continue;
      const d3x = x3 - rx1, d3z = z3 - rz1, a3 = d3x * ux + d3z * uz;
      if (a3 < -h || a3 > maxAlong || Math.abs(-d3x * uz + d3z * ux) > h) continue;
      return true;
    }
    if (road.axis === "z") {
      if (minX >= road.fixed - h && maxX <= road.fixed + h &&
          minZ >= road.min - h && maxZ <= road.max + h) return true;
    } else if (minX >= road.min - h && maxX <= road.max + h &&
               minZ >= road.fixed - h && maxZ <= road.fixed + h) {
      return true;
    }
  }
  return false;
}

const poseOnRoadFast = (pose, roads) =>
  Boolean(roads) && bodyOnRoad(pose, roads);

function pointInCitySite(px, pz, site) {
  if (px < site.minX || px > site.maxX || pz < site.minZ || pz > site.maxZ) return false;
  if (site.axis === "diag") {
    const dx = px - site.x1, dz = pz - site.z1;
    const along = dx * site.ux + dz * site.uz;
    if (along < site.alongMin || along > site.alongMax) return false;
    const leftOffset = -dx * site.uz + dz * site.ux;
    return leftOffset >= site.crossLo && leftOffset <= site.crossHi;
  }
  return true;
}

function siteOutwardM(px, pz, site) {
  if (site.axis === "diag") {
    const leftOffset = -(px - site.x1) * site.uz + (pz - site.z1) * site.ux;
    return (leftOffset - site.edge) * site.side;
  }
  return ((site.axis === "x" ? pz : px) - site.edge) * site.side;
}

const inRibbon = (site, pose) => corners(pose).every(p =>
  p.x >= site.minX && p.x <= site.maxX && p.z >= site.minZ && p.z <= site.maxZ);

function pointInCourtyardsGrid(x, z, grid) {
  const bucket = lookupCell(grid, grid.courtCells, x, z);
  if (!bucket) return false;
  for (let i = 0; i < bucket.length; i++) {
    const c = bucket[i];
    if (x >= c.minX && x <= c.maxX && z >= c.minZ && z <= c.maxZ) return true;
  }
  return false;
}

function pointInSitesGrid(x, z, grid) {
  const bucket = lookupCell(grid, grid.site3Cells, x, z);
  if (!bucket) return false;
  for (let i = 0; i < bucket.length; i++) {
    if (pointInCitySite(x, z, bucket[i])) return true;
  }
  return false;
}

function poseInSingleCourtyardGrid(pose, grid) {
  if (!grid.courtsLen) return false;
  const h0 = pose.heading ?? 0;
  const s = Math.sin(h0), c = Math.cos(h0);
  const hw = (pose.width ?? 0) / 2, hl = (pose.length ?? 0) / 2;
  const cw = c * hw, sw = s * hw, cl = c * hl, sl = s * hl;
  const x = pose.x, z = pose.z;
  const minX = Math.min(x - cw - sl, x + cw - sl, x + cw + sl, x - cw + sl);
  const maxX = Math.max(x - cw - sl, x + cw - sl, x + cw + sl, x - cw + sl);
  const minZ = Math.min(z + sw - cl, z - sw - cl, z - sw + cl, z + sw + cl);
  const maxZ = Math.max(z + sw - cl, z - sw - cl, z - sw + cl, z + sw + cl);
  const bucket = lookupCell(grid, grid.courtCells, minX, minZ);
  if (!bucket) return false;
  for (let i = 0; i < bucket.length; i++) {
    const r = bucket[i];
    if (minX >= r.minX && maxX <= r.maxX && minZ >= r.minZ && maxZ <= r.maxZ) return true;
  }
  return false;
}

function cornerSupported(px, pz, roads, grid) {
  if (roads) {
    scratchPoint.x = px;
    scratchPoint.z = pz;
    if (pointOnRoad(scratchPoint, roads)) return true;
  }
  return pointInCourtyardsGrid(px, pz, grid) || pointInSitesGrid(px, pz, grid);
}

export function isPoseSupportedWithCurbs(curb, roads, pose) {
  if (poseOnRoadFast(pose, roads)) return true;
  if (!curb) return false;
  if (!curb.sites) return inRibbon(curb, pose);
  const grid = getCurbGrid(curb);
  if (poseInSingleCourtyardGrid(pose, grid)) return true;
  const h0 = pose.heading ?? 0;
  const s = Math.sin(h0), c = Math.cos(h0);
  const hw = (pose.width ?? 0) / 2, hl = (pose.length ?? 0) / 2;
  const cw = c * hw, sw = s * hw, cl = c * hl, sl = s * hl;
  const x = pose.x, z = pose.z;
  return (
    cornerSupported(x - cw - sl, z + sw - cl, roads, grid) &&
    cornerSupported(x + cw - sl, z - sw - cl, roads, grid) &&
    cornerSupported(x + cw + sl, z - sw + cl, roads, grid) &&
    cornerSupported(x - cw + sl, z + sw + cl, roads, grid)
  );
}

export function sweepSafeWithCurbs(before, after, statics, roads, curb) {
  const heading = before.heading ?? 0;
  const turn = angleDelta(after.heading ?? 0, heading);
  const dx = after.x - before.x, dz = after.z - before.z;
  const travel = distance(before, after) +
    (Math.abs(turn) * Math.hypot(before.length ?? 1, before.width ?? 1)) / 2;
  const steps = Math.max(1, Math.ceil(travel / .12));
  const pose = {
    x: 0, z: 0, heading: 0,
    type: after.type ?? before.type,
    radius: after.radius ?? before.radius,
    length: after.length ?? before.length,
    width: after.width ?? before.width,
  };
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    pose.x = before.x + dx * t;
    pose.z = before.z + dz * t;
    pose.heading = heading + turn * t;
    if (!isPoseSupportedWithCurbs(curb, roads, pose))
      return { safe: false, reason: "road-boundary" };
    if (statics) {
      for (const other of statics)
        if (overlaps(pose, other, .12))
          return { safe: false, reason: "occupied", actor: other.id };
    }
  }
  return { safe: true, reason: "clear" };
}

function wheelSurface(out) {
  // Same section as the Metro v4 avenue strip: ramp, lip, ramp, low sidewalk, courtyard ramp.
  if (out <= 0) return ASPHALT_Y;
  if (out < .105) return GUTTER_Y + (LIP_Y - GUTTER_Y) * out / .105;
  if (out <= .27) return LIP_Y;
  if (out < .37) return LIP_Y + (TOE_Y - LIP_Y) * (out - .27) / .10;
  if (out <= 2.38) return SIDEWALK_Y;
  if (out >= 2.54) return COURT_Y;
  return SIDEWALK_Y + (COURT_Y - SIDEWALK_Y) * clamp((out - 2.38) / .16, 0, 1);
}

function streetWheelSurface(out) {
  if (out <= 0) return ASPHALT_Y;
  if (out < .105) return ASPHALT_Y + (STREET_LIP_Y - ASPHALT_Y) * out / .105;
  if (out <= .27) return STREET_LIP_Y;
  if (out < .37) return STREET_LIP_Y + (TOE_Y - STREET_LIP_Y) * (out - .27) / .10;
  if (out <= 2.38) return SIDEWALK_Y;
  if (out >= 2.54) return COURT_Y;
  return SIDEWALK_Y + (COURT_Y - SIDEWALK_Y) * clamp((out - 2.38) / .16, 0, 1);
}

function wheelHeights(site, body) {
  const { trackM, wheelbaseM } = PLAYER_VEHICLE;
  const c = Math.cos(body.heading), s = Math.sin(body.heading);
  return WHEELS.map(([, side, axle]) =>
    wheelSurface(body.z - side * trackM * s / 2 + axle * wheelbaseM * c / 2 - site.edgeZ) - ASPHALT_Y);
}

function pointRectDistance(x, z, rect) {
  const dx = x < rect.minX ? rect.minX - x : x > rect.maxX ? x - rect.maxX : 0;
  const dz = z < rect.minZ ? rect.minZ - z : z > rect.maxZ ? z - rect.maxZ : 0;
  return Math.hypot(dx, dz);
}

function pointSiteDistance(x, z, site) {
  if (site.axis === "diag") {
    const dx = x - site.x1, dz = z - site.z1;
    const along = dx * site.ux + dz * site.uz;
    const leftOffset = -dx * site.uz + dz * site.ux;
    const da = along < site.alongMin ? site.alongMin - along : along > site.alongMax ? along - site.alongMax : 0;
    const dc = leftOffset < site.crossLo ? site.crossLo - leftOffset : leftOffset > site.crossHi ? leftOffset - site.crossHi : 0;
    return Math.hypot(da, dc);
  }
  return pointRectDistance(x, z, site);
}

function cityWheelHeights(curb, roads, pose) {
  const grid = getCurbGrid(curb);
  const { trackM, wheelbaseM } = PLAYER_VEHICLE;
  const c = Math.cos(pose.heading), s = Math.sin(pose.heading);
  let activeSite = null, wheelInCourtyard = false;
  const heights = [0, 0, 0, 0];
  for (let w = 0; w < 4; w++) {
    const side = WHEELS[w][1], axle = WHEELS[w][2];
    const wx = pose.x + side * trackM * c / 2 + axle * wheelbaseM * s / 2;
    const wz = pose.z - side * trackM * s / 2 + axle * wheelbaseM * c / 2;
    if (roads) {
      scratchPoint.x = wx;
      scratchPoint.z = wz;
      if (pointOnRoad(scratchPoint, roads)) continue;
    }
    const inCourt = pointInCourtyardsGrid(wx, wz, grid);
    if (inCourt) wheelInCourtyard = true;
    const bucket = lookupCell(grid, grid.site3Cells, wx, wz);
    let site = null;
    if (bucket) {
      for (let i = 0; i < bucket.length; i++) {
        const candidate = bucket[i];
        const out = siteOutwardM(wx, wz, candidate);
        if (out <= 0) continue;
        if (pointInCitySite(wx, wz, candidate)) {
          site = candidate;
          break;
        }
        if (!inCourt || out >= 2.54) continue;
        if (candidate.axis === "diag") {
          const along = (wx - candidate.x1) * candidate.ux + (wz - candidate.z1) * candidate.uz;
          if (along >= candidate.alongMin && along <= candidate.alongMax) {
            site = candidate;
            break;
          }
        } else if (candidate.axis === "x"
          ? wx >= candidate.minX && wx <= candidate.maxX
          : wz >= candidate.minZ && wz <= candidate.maxZ) {
          site = candidate;
          break;
        }
      }
    }
    if (site) {
      activeSite ??= site;
      const out = siteOutwardM(wx, wz, site);
      heights[w] = (site.avenue ? wheelSurface(out) : streetWheelSurface(out)) - ASPHALT_Y;
    } else {
      heights[w] = inCourt ? COURT_Y - ASPHALT_Y : 0;
    }
  }
  if (!activeSite) {
    const pts = fillScratchCorners(pose, s, c);
    let bestPrimary = null, bestPrimaryIdx = Infinity;
    let bestFallback = null, bestFallbackIdx = Infinity;
    for (let k = 0; k < 4; k++) {
      const p = pts[k];
      const bucket = lookupCell(grid, grid.site3Cells, p.x, p.z);
      if (!bucket) continue;
      let offRoadChecked = false, offRoad = false;
      for (let i = 0; i < bucket.length; i++) {
        const candidate = bucket[i];
        if (!pointInCitySite(p.x, p.z, candidate)) continue;
        const idx = grid.siteIndex.get(candidate);
        if (idx < bestFallbackIdx) {
          bestFallbackIdx = idx;
          bestFallback = candidate;
        }
        if (idx < bestPrimaryIdx && siteOutwardM(p.x, p.z, candidate) > -.09) {
          if (!offRoadChecked) {
            offRoadChecked = true;
            offRoad = !roads || !pointOnRoad(p, roads, .08);
          }
          if (offRoad) {
            bestPrimaryIdx = idx;
            bestPrimary = candidate;
          }
        }
      }
    }
    activeSite = bestPrimary ?? bestFallback ?? null;
    if (!activeSite) {
      let cornerInCourtyard = wheelInCourtyard || pointInCourtyardsGrid(pose.x, pose.z, grid);
      if (!cornerInCourtyard) {
        for (let k = 0; k < 4; k++) {
          const p = pts[k];
          if (pointInCourtyardsGrid(p.x, p.z, grid) && (!roads || !pointOnRoad(p, roads))) {
            cornerInCourtyard = true;
            break;
          }
        }
      }
      if (cornerInCourtyard) {
        let nearestSite = null, bestDist = 12;
        const nearBucket = lookupCell(grid, grid.site12Cells, pose.x, pose.z);
        if (nearBucket) {
          for (let i = 0; i < nearBucket.length; i++) {
            const candidate = nearBucket[i];
            const d = pointSiteDistance(pose.x, pose.z, candidate);
            if (d <= bestDist) {
              bestDist = d;
              nearestSite = candidate;
            }
          }
        }
        return { heights, siteId: nearestSite?.id ?? "metro-courtyard" };
      }
      activeSite = curb.sites[0];
    }
  }
  return { heights, siteId: activeSite?.id ?? null };
}

export function acceptCurbPose(curb, roads, pose) {
  if (poseOnRoadFast(pose, roads)) {
    pose.y = pose.supportHeightM = 0;
    pose.curbSupportId = null;
    return null;
  }
  if (!curb) return null;
  let heights, siteId;
  if (curb.sites) {
    ({ heights, siteId } = cityWheelHeights(curb, roads, pose));
  } else {
    heights = wheelHeights(curb, pose);
    siteId = curb.id;
  }
  const h0 = heights[0], h1 = heights[1], h2 = heights[2], h3 = heights[3];
  const mean = (h0 + h1 + h2 + h3) / 4;
  // Keep even a single wheel on the lip within the original strut stroke.
  const stroke = PLAYER_VEHICLE.suspensionTravelM;
  const lo = Math.max(h0, h1, h2, h3) - stroke, hi = Math.min(h0, h1, h2, h3) + stroke;
  const support = curb.sites && lo > hi ? (lo + hi) / 2 : clamp(mean, lo, hi);
  pose.y = pose.supportHeightM = support;
  pose.curbSupportId = siteId;
  return {
    frontLeft: h0 - support,
    frontRight: h1 - support,
    rearLeft: h2 - support,
    rearRight: h3 - support,
  };
}

function nearCitySite(site, actor, radius, reach) {
  if (site.axis === "diag") {
    const pad = Math.max(radius, reach);
    if (actor.x < site.minX - pad || actor.x > site.maxX + pad ||
        actor.z < site.minZ - pad || actor.z > site.maxZ + pad) return false;
    const dx = actor.x - site.x1, dz = actor.z - site.z1;
    const along = dx * site.ux + dz * site.uz;
    if (along < site.alongMin - reach || along > site.alongMax + reach) return false;
    const leftOffset = -dx * site.uz + dz * site.ux;
    return site.side > 0
      ? leftOffset >= Math.max(site.crossLo, site.edge - reach) && leftOffset <= site.crossHi + radius
      : leftOffset <= Math.min(site.crossHi, site.edge + reach) && leftOffset >= site.crossLo - radius;
  }
  if (site.axis === "x") {
    if (actor.x < site.minX - reach || actor.x > site.maxX + reach) return false;
    return site.side > 0
      ? actor.z >= Math.max(site.minZ, site.edge - reach) && actor.z <= site.maxZ + radius
      : actor.z <= Math.min(site.maxZ, site.edge + reach) && actor.z >= site.minZ - radius;
  }
  if (actor.z < site.minZ - reach || actor.z > site.maxZ + reach) return false;
  return site.side > 0
    ? actor.x >= Math.max(site.minX, site.edge - reach) && actor.x <= site.maxX + radius
    : actor.x <= Math.min(site.maxX, site.edge + reach) && actor.x >= site.minX - radius;
}

export function nearCurb(curb, actor) {
  if (!curb) return false;
  const radius = Math.hypot(actor.width, actor.length) / 2;
  const braking = actor.spec?.braking ?? VEHICLE.braking;
  if (!curb.sites) {
    const reach = radius + .5 + actor.speed ** 2 / (2 * braking);
    return actor.x >= curb.minX - reach && actor.x <= curb.maxX + reach &&
      actor.z >= Math.max(curb.minZ, curb.edgeZ - reach) && actor.z <= curb.maxZ + radius;
  }
  const grid = getCurbGrid(curb);
  if (actor.curbSupportId || pointInCourtyardsGrid(actor.x, actor.z, grid)) return true;
  const pace = effectivePace(actor);
  const reach = radius + .5 + pace ** 2 / (2 * braking);
  const pad = Math.max(radius, reach);
  if (pad <= 12) {
    const siteBucket = lookupCell(grid, pad <= 3 ? grid.site3Cells : grid.site12Cells, actor.x, actor.z);
    if (siteBucket) {
      for (let i = 0; i < siteBucket.length; i++) {
        if (nearCitySite(siteBucket[i], actor, radius, reach)) return true;
      }
    }
    const courtBucket = lookupCell(grid, grid.court12Cells, actor.x, actor.z);
    if (!courtBucket) return false;
    for (let i = 0; i < courtBucket.length; i++) {
      const c = courtBucket[i];
      if (actor.x >= c.minX - reach && actor.x <= c.maxX + reach &&
          actor.z >= c.minZ - reach && actor.z <= c.maxZ + reach) return true;
    }
    return false;
  }
  if (actor.x + pad < grid.minX || actor.x - pad > grid.maxX ||
      actor.z + pad < grid.minZ || actor.z - pad > grid.maxZ) return false;
  const cx0 = Math.floor((actor.x - pad) * CURB_INV_CELL);
  const cx1 = Math.floor((actor.x + pad) * CURB_INV_CELL);
  const cz0 = Math.floor((actor.z - pad) * CURB_INV_CELL);
  const cz1 = Math.floor((actor.z + pad) * CURB_INV_CELL);
  for (let cx = cx0; cx <= cx1; cx++) {
    const hi = cx << 16;
    for (let cz = cz0; cz <= cz1; cz++) {
      const k = hi ^ (cz & 0xffff);
      const siteBucket = grid.baseSiteCells.get(k);
      if (siteBucket) {
        for (let i = 0; i < siteBucket.length; i++) {
          if (nearCitySite(siteBucket[i], actor, radius, reach)) return true;
        }
      }
      const courtBucket = grid.courtCells.get(k);
      if (courtBucket) {
        for (let i = 0; i < courtBucket.length; i++) {
          const c = courtBucket[i];
          if (actor.x >= c.minX - reach && actor.x <= c.maxX + reach &&
              actor.z >= c.minZ - reach && actor.z <= c.maxZ + reach) return true;
        }
      }
    }
  }
  return false;
}

function sweep(from, to, visit, stepM = .05) {
  const span = distance(from, to) + Math.abs(angleDelta(to.heading, from.heading)) *
    Math.hypot(from.width, from.length) / 2;
  const steps = Math.max(1, Math.ceil(span / stepM));
  const probe = { ...to };
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    if (!visit(interpolate(from, to, t, probe), t)) return false;
  }
  return true;
}

const effectivePace = pose => Math.hypot(pose.speed, pose.gtaSlipMps ?? 0);
const brake = (command, actor) => ({ ...command, targetSpeed: 0,
  decelerationMps2: actor.spec?.braking ?? VEHICLE.braking });

// Only brake an on-road approach that cannot stop on pavement under its
// current steering. Parallel, wholly paved motion stays on the legacy path.
export function curbCommand(curb, roads, actor, command, next, project) {
  const v2 = Boolean(curb?.sites);
  const maxPace = v2 ? curb.maxPace : MAX_PACE;
  const supported = pose => v2 ? isPoseSupportedWithCurbs(curb, roads, pose) : inRibbon(curb, pose);
  const nextOnRoad = poseOnRoadFast(next, roads);
  if (actor.curbSupportId || (!nextOnRoad && supported(next))) {
    const targetSpeed = clamp(command.targetSpeed, -maxPace, maxPace);
    return targetSpeed === command.targetSpeed ? command : { ...command, targetSpeed, reason: "curb-speed-limit" };
  }
  if (effectivePace(next) <= maxPace) return command;
  const approachStep = v2 && !actor.curbSupportId && nextOnRoad ? .15 : .05;
  const stopping = brake(command, actor);
  let previous = next;
  while (Math.abs(previous.speed) > maxPace) {
    const end = project(previous, stopping);
    if (!sweep(previous, end, pose => poseOnRoadFast(pose, roads) || !supported(pose), approachStep))
      return { ...stopping, reason: "curb-approach-speed" };
    previous = end;
  }
  return command;
}

function pointSegmentDistance(p, a, b) {
  const dx = b.x - a.x, dz = b.z - a.z;
  const len2 = dx * dx + dz * dz;
  const t = len2 > 0 ? clamp(((p.x - a.x) * dx + (p.z - a.z) * dz) / len2, 0, 1) : 0;
  return Math.hypot(p.x - (a.x + dx * t), p.z - (a.z + dz * t));
}

function solidGap(pose, body) {
  if (overlaps(pose, body, 0)) return 0;
  const pa = corners(pose), pb = corners(body);
  let best = Infinity;
  for (let i = 0; i < 4; i++) {
    const a1 = pa[i], a2 = pa[(i + 1) & 3];
    const b1 = pb[i], b2 = pb[(i + 1) & 3];
    for (let j = 0; j < 4; j++)
      best = Math.min(best, pointSegmentDistance(pa[j], b1, b2), pointSegmentDistance(pb[j], a1, a2));
  }
  return best;
}

function pedestrianGap(rect, person) {
  const h = rect.heading ?? 0;
  const dx = person.x - rect.x, dz = person.z - rect.z;
  const localX = dx * Math.cos(h) - dz * Math.sin(h);
  const localZ = dx * Math.sin(h) + dz * Math.cos(h);
  const ex = Math.max(0, Math.abs(localX) - rect.width / 2);
  const ez = Math.max(0, Math.abs(localZ) - rect.length / 2);
  return Math.hypot(ex, ez) - person.radius;
}

// The immediate slice checks the actual independently planned walking/driving
// slice. From there, reserve each body's continued motion plus uncertainty over
// the short full-brake horizon. Ordinary Dispatch's contact solver still runs.
export function curbClearance(world, curb, ego, plans, project) {
  const { a: actor, next, command } = ego;
  if (!ego.travel) return null;
  const usesShoulder = actor.curbSupportId ||
    !sweep(actor, next, pose => poseOnRoadFast(pose, world.roads));
  if (!usesShoulder) return null;
  const v2 = Boolean(curb?.sites);
  const maxPace = v2 ? curb.maxPace : MAX_PACE;
  const maxYaw = v2 ? curb.maxYawRate : MAX_YAW_V1;
  const brakeWindow = v2 ? CITY_BRAKE_WINDOW : BRAKE_WINDOW;
  const supported = pose => v2
    ? isPoseSupportedWithCurbs(curb, world.roads, pose)
    : poseOnRoadFast(pose, world.roads) || inRibbon(curb, pose);
  if (!sweep(actor, next, supported))
    return { reason: "road-boundary" };
  if (Math.max(effectivePace(actor), effectivePace(next)) > maxPace + 1e-8 ||
      Math.max(Math.abs(actor.gtaYawRate ?? 0), Math.abs(next.gtaYawRate ?? 0)) > maxYaw)
    return { reason: "curb-speed" };
  if (actor.width !== PLAYER_VEHICLE.widthM || actor.length !== PLAYER_VEHICLE.lengthM ||
      (actor.spec?.wheelbase ?? VEHICLE.wheelbase) !== PLAYER_VEHICLE.wheelbaseM ||
      LIP_Y - SIDEWALK_Y >= CLEARANCE) return { reason: "curb-clearance" };

  const egoRadius = ego.radius ?? Math.hypot(actor.width, actor.length) / 2;
  if (!v2) {
    const movers = (plans ?? []).filter(p => p.a !== actor && distance(actor, p.a) <=
      egoRadius + p.radius + 1 + brakeWindow * (maxPace + p.travel / STEP));
    const solids = (world.statics ?? []).filter(body =>
      distance(actor, body) <= 6 + Math.hypot(body.width ?? 0, body.length ?? 0) / 2);
    let rejection = null;
    const stopping = brake(command, actor);
    let from = actor, to = next;
    for (let step = 0; step < Math.ceil(brakeWindow / STEP); step++) {
      const clear = sweep(from, to, (pose, t) => {
        if (!supported(pose)) {
          rejection = { reason: "road-boundary" };
          return false;
        }
        if (solids.some(body => {
          if (!overlaps(pose, body, .15)) return false;
          rejection = { reason: "curb-solid", blockedBy: body.id };
          return true;
        })) return false;
        for (const { a: body, next: planned } of movers) {
          const seconds = (step + t) * STEP;
          const sample = step ? {
            ...planned,
            x: planned.x + (planned.x - body.x) * (step + t - 1),
            z: planned.z + (planned.z - body.z) * (step + t - 1),
          } : interpolate(body, planned, t);
          const pedestrian = body.type === "pedestrian";
          const margin = pedestrian ? .35 + seconds * .55 : .18 + seconds * .65;
          if (overlaps(pose, sample, margin)) {
            rejection = { reason: pedestrian ? "curb-pedestrian" : "curb-solid", blockedBy: body.id };
            return false;
          }
        }
        return true;
      });
      if (!clear) return rejection;
      if (to.speed === 0 && Math.abs(to.gtaSlipMps ?? 0) < .025) return null;
      from = to;
      to = project(from, stopping);
    }
    return { reason: "curb-speed" };
  }

  const pedestrians = (plans ?? []).filter(p =>
    p.a !== actor && p.a?.type === "pedestrian" &&
    distance(actor, p.a) <= egoRadius + (p.radius ?? p.a.radius ?? .5) + 1 +
      brakeWindow * (maxPace + (p.travel ?? distance(p.a, p.next)) / STEP));
  const solidReach = egoRadius + 1 + brakeWindow * maxPace;
  const solids = (world.statics ?? []).filter(body =>
    distance(actor, body) <= solidReach + Math.hypot(body.width ?? 0, body.length ?? 0) / 2);
  const closeSolids = new Map();
  for (const body of solids) {
    if (overlaps(actor, body, .15)) closeSolids.set(body, solidGap(actor, body));
  }
  const closePedestrians = new Map();
  for (const { a: body } of pedestrians) {
    if (overlaps(actor, body, .48))
      closePedestrians.set(body, { dist: distance(actor, body), gap: pedestrianGap(actor, body) });
  }

  const checkPoseObstacles = (pose, step, t) => {
    if (!supported(pose)) return { reason: "road-boundary" };
    for (const body of solids) {
      const startGap = closeSolids.get(body);
      const blocked = startGap !== undefined
        ? overlaps(pose, body, .01) || solidGap(pose, body) < startGap - .003
        : overlaps(pose, body, .15);
      if (blocked) return { reason: "curb-solid", blockedBy: body.id };
    }
    const seconds = (step + t) * STEP;
    const margin = .48 + seconds * .65;
    for (const { a: body, next: planned } of pedestrians) {
      const sample = step ? {
        ...planned,
        x: planned.x + (planned.x - body.x) * (step + t - 1),
        z: planned.z + (planned.z - body.z) * (step + t - 1),
      } : interpolate(body, planned, t);
      const startPed = closePedestrians.get(body);
      const blocked = startPed !== undefined
        ? overlaps(pose, sample, .05) ||
          distance(pose, sample) <= startPed.dist ||
          pedestrianGap(pose, sample) <= startPed.gap
        : overlaps(pose, sample, margin);
      if (blocked) return { reason: "curb-pedestrian", blockedBy: body.id };
    }
    return null;
  };

  let immediateReject = null;
  if (!sweep(actor, next, (pose, t) => !(immediateReject = checkPoseObstacles(pose, 0, t))))
    return immediateReject;
  if (next.speed === 0 && Math.abs(next.gtaSlipMps ?? 0) < .025) return null;

  const maxSteps = Math.ceil(brakeWindow / STEP);
  const stopping = brake(command, actor);
  const checkBrakingTail = steerTarget => {
    const tailStop = steerTarget === stopping.steer ? stopping : { ...stopping, steer: steerTarget };
    let from = next, to = project(from, tailStop);
    for (let step = 1; step < maxSteps; step++) {
      let tailReject = null;
      if (!sweep(from, to, (pose, t) => !(tailReject = checkPoseObstacles(pose, step, t))))
        return tailReject;
      if (to.speed === 0 && Math.abs(to.gtaSlipMps ?? 0) < .025) return null;
      from = to;
      to = project(from, tailStop);
    }
    return null;
  };

  const primary = checkBrakingTail(stopping.steer);
  if (!primary || primary.reason === "curb-pedestrian") return primary;

  const grid = getCurbGrid(curb);
  const pts = corners(next);
  let site = actor.curbSupportId ? grid.siteById.get(actor.curbSupportId) ?? null : null;
  if (!site) {
    let bestIdx = Infinity;
    for (let k = 0; k < 4; k++) {
      const p = pts[k];
      const bucket = lookupCell(grid, grid.site3Cells, p.x, p.z);
      if (!bucket) continue;
      for (let i = 0; i < bucket.length; i++) {
        const candidate = bucket[i];
        const idx = grid.siteIndex.get(candidate);
        if (idx < bestIdx && pointInCitySite(p.x, p.z, candidate) && siteOutwardM(p.x, p.z, candidate) > -.09) {
          bestIdx = idx;
          site = candidate;
        }
      }
    }
  }
  if (!site) {
    if (Math.max(egoRadius, 2) <= 12) {
      const bucket = lookupCell(grid, grid.site12Cells, next.x, next.z);
      if (bucket) {
        for (let i = 0; i < bucket.length; i++) {
          if (nearCitySite(bucket[i], next, egoRadius, 2)) {
            site = bucket[i];
            break;
          }
        }
      }
    } else {
      site = curb.sites.find(s => nearCitySite(s, next, egoRadius, 2));
    }
  }
  const roadwardRight = site
    ? (site.axis === "diag"
      ? site.side * (site.uz * Math.cos(next.heading) + site.ux * Math.sin(next.heading))
      : (site.axis === "z" ? -site.side * Math.cos(next.heading) : site.side * Math.sin(next.heading)))
    : 0;
  const dirSign = (next.speed ?? actor.speed ?? 0) >= 0 ? 1 : -1;
  const roadSign = Math.sign(roadwardRight * dirSign);
  for (const altSteer of roadSign ? [0, roadSign * .28, roadSign * .55] : [0, .28, -.28]) {
    if (Math.abs(altSteer - (stopping.steer ?? 0)) < 1e-4) continue;
    if (!checkBrakingTail(altSteer)) return null;
  }
  return primary;
}
