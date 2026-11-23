const EPS = 1e-7;
export const CIRCULAR_CONTACT_TOLERANCE_M = 1e-7;
export const distance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
export const angleDelta = (a, b) =>
  Math.atan2(Math.sin(a - b), Math.cos(a - b));
function corner(x, z, s, c, w, l, sx, sz) {
  return { x: x + c * w * sx + s * l * sz, z: z + -s * w * sx + c * l * sz };
}
export function corners(body, gap = 0) {
  const s = Math.sin(body.heading ?? 0), c = Math.cos(body.heading ?? 0);
  const l = (body.length ?? 0) / 2 + gap,
    w = (body.width ?? 0) / 2 + gap;
  const x = body.x, z = body.z;
  return [
    corner(x, z, s, c, w, l, -1, -1),
    corner(x, z, s, c, w, l, 1, -1),
    corner(x, z, s, c, w, l, 1, 1),
    corner(x, z, s, c, w, l, -1, 1),
  ];
}
function separates(pa, pb, heading) {
  const x = Math.sin(heading), z = Math.cos(heading);
  let minA = Infinity, maxA = -Infinity, minB = Infinity, maxB = -Infinity;
  for (let i = 0; i < 4; i++) {
    const a = pa[i].x * x + pa[i].z * z;
    const b = pb[i].x * x + pb[i].z * z;
    minA = Math.min(minA, a);
    maxA = Math.max(maxA, a);
    minB = Math.min(minB, b);
    maxB = Math.max(maxB, b);
  }
  return maxA <= minB + EPS || maxB <= minA + EPS;
}
export function overlaps(a, b, gap = 0) {
  const ac = a.type === "pedestrian",
    bc = b.type === "pedestrian";
  const dx = a.x - b.x, dz = a.z - b.z;
  // Only rule out distant pairs before the original radial and footprint tests.
  const reach = (ac ? Math.abs(a.radius) : (Math.abs(a.length) + Math.abs(a.width)) / 2) +
    (bc ? Math.abs(b.radius) : (Math.abs(b.length) + Math.abs(b.width)) / 2) + Math.abs(gap);
  const bound = reach + EPS + reach * Number.EPSILON * 4;
  if (Math.abs(dx) > bound || Math.abs(dz) > bound) return false;
  const ra = ac ? a.radius : Math.hypot(a.length, a.width) / 2;
  const rb = bc ? b.radius : Math.hypot(b.length, b.width) / 2;
  const separation = Math.hypot(dx, dz);
  if (separation >= ra + rb + gap) return false;
  if (ac && bc) return separation < ra + rb + gap - CIRCULAR_CONTACT_TOLERANCE_M;
  if (ac || bc) {
    const circle = ac ? a : b,
      rect = ac ? b : a,
      h = rect.heading ?? 0;
    const dx = circle.x - rect.x,
      dz = circle.z - rect.z;
    const localX = dx * Math.cos(h) - dz * Math.sin(h),
      localZ = dx * Math.sin(h) + dz * Math.cos(h);
    const ex = Math.max(0, Math.abs(localX) - rect.width / 2),
      ez = Math.max(0, Math.abs(localZ) - rect.length / 2);
    return Math.hypot(ex, ez) < circle.radius + gap - CIRCULAR_CONTACT_TOLERANCE_M;
  }
  const ah = a.heading ?? 0, bh = b.heading ?? 0;
  const sa = ah === 0 ? 0 : Math.sin(ah), ca = ah === 0 ? 1 : Math.cos(ah);
  const sb = bh === 0 ? 0 : Math.sin(bh), cb = bh === 0 ? 1 : Math.cos(bh);
  const halfGap = gap * 0.5;
  const wa = Math.abs((a.width ?? 0) * 0.5 + halfGap), la = Math.abs((a.length ?? 0) * 0.5 + halfGap);
  const wb = Math.abs((b.width ?? 0) * 0.5 + halfGap), lb = Math.abs((b.length ?? 0) * 0.5 + halfGap);
  const dot = Math.abs(sa * sb + ca * cb);
  const cross = Math.abs(sa * cb - ca * sb);
  if (Math.abs(dx * sa + dz * ca) >= la + wb * cross + lb * dot - EPS) return false;
  if (Math.abs(dx * ca - dz * sa) >= wa + wb * dot + lb * cross - EPS) return false;
  if (Math.abs(dx * sb + dz * cb) >= lb + wa * cross + la * dot - EPS) return false;
  if (Math.abs(dx * cb - dz * sb) >= wb + wa * dot + la * cross - EPS) return false;
  return true;
}
export const isDiagonalRoad = (road) => road?.axis === "diag";
export function makeDiagonalRoad({
  id,
  x1,
  z1,
  x2,
  z2,
  width,
  laneOffsetM = 0,
  speedLimitMps = 9.5,
  flow = 0,
  zone = "avenue",
  marking = "center",
  sideStreet = false,
  ...extra
}) {
  const dx = x2 - x1,
    dz = z2 - z1,
    length = Math.hypot(dx, dz),
    ux = dx / length,
    uz = dz / length,
    nx = uz,
    nz = -ux,
    heading = Math.atan2(ux, uz);
  return {
    id,
    axis: "diag",
    x1,
    z1,
    x2,
    z2,
    length,
    ux,
    uz,
    nx,
    nz,
    heading,
    min: 0,
    max: length,
    fixed: 0,
    width,
    laneOffsetM,
    speedLimitMps,
    flow,
    zone,
    marking,
    sideStreet,
    ...extra,
  };
}
export function roadFrame(road) {
  if (road.axis === "z") {
    return {
      x1: road.fixed,
      z1: road.min,
      x2: road.fixed,
      z2: road.max,
      ux: 0,
      uz: 1,
      length: road.max - road.min,
      heading: 0,
      minAlong: road.min,
      maxAlong: road.max,
    };
  }
  if (road.axis === "x") {
    return {
      x1: road.min,
      z1: road.fixed,
      x2: road.max,
      z2: road.fixed,
      ux: 1,
      uz: 0,
      length: road.max - road.min,
      heading: Math.PI / 2,
      minAlong: road.min,
      maxAlong: road.max,
    };
  }
  return {
    x1: road.x1,
    z1: road.z1,
    x2: road.x2 ?? road.x1 + road.ux * road.length,
    z2: road.z2 ?? road.z1 + road.uz * road.length,
    ux: road.ux,
    uz: road.uz,
    length: road.length,
    heading: road.heading ?? Math.atan2(road.ux, road.uz),
    minAlong: 0,
    maxAlong: road.length,
  };
}
export function roadPointAt(road, along, leftOffset = 0) {
  if (road.axis === "z") return { x: leftOffset ? road.fixed - leftOffset : road.fixed, z: along };
  if (road.axis === "x") return { x: along, z: leftOffset ? road.fixed + leftOffset : road.fixed };
  return {
    x: road.x1 + along * road.ux - leftOffset * road.uz,
    z: road.z1 + along * road.uz + leftOffset * road.ux,
  };
}
export function roadProject(road, p) {
  if (road.axis === "z") {
    const leftOffset = road.fixed - p.x;
    return { along: p.z, leftOffset, absLateral: Math.abs(leftOffset) };
  }
  if (road.axis === "x") {
    const leftOffset = p.z - road.fixed;
    return { along: p.x, leftOffset, absLateral: Math.abs(leftOffset) };
  }
  const dx = p.x - road.x1,
    dz = p.z - road.z1,
    along = dx * road.ux + dz * road.uz,
    leftOffset = -dx * road.uz + dz * road.ux;
  return { along, leftOffset, absLateral: Math.abs(leftOffset) };
}
export function roadPoseAt(road, along, side = 1, customOffset = null) {
  const s = road.flow || side;
  const offset = customOffset !== null ? customOffset : s * (road.laneOffsetM ?? 0);
  const f = roadFrame(road);
  const pt = roadPointAt(road, along, offset);
  const heading = s >= 0 ? f.heading : Math.atan2(-f.ux, -f.uz);
  return { x: pt.x, z: pt.z, heading };
}
export function roadIntersection(a, b, endPad = 0.5) {
  if (!isDiagonalRoad(a) && !isDiagonalRoad(b)) {
    if (a.axis === b.axis) return null;
    const vert = a.axis === "z" ? a : b,
      horiz = a.axis === "z" ? b : a;
    if (
      vert.fixed < horiz.min - endPad ||
      vert.fixed > horiz.max + endPad ||
      horiz.fixed < vert.min - endPad ||
      horiz.fixed > vert.max + endPad
    )
      return null;
    return {
      x: vert.fixed,
      z: horiz.fixed,
      alongA: a.axis === "z" ? horiz.fixed : vert.fixed,
      alongB: b.axis === "z" ? horiz.fixed : vert.fixed,
    };
  }
  const fa = roadFrame(a),
    fb = roadFrame(b);
  const det = -fa.ux * fb.uz + fa.uz * fb.ux;
  if (Math.abs(det) < 0.08) return null;
  const dx = fb.x1 - fa.x1,
    dz = fb.z1 - fa.z1;
  const t = (-fb.uz * dx + fb.ux * dz) / det;
  const u = (-fa.uz * dx + fa.ux * dz) / det;
  if (t < -endPad || t > fa.length + endPad || u < -endPad || u > fb.length + endPad)
    return null;
  return {
    x: fa.x1 + t * fa.ux,
    z: fa.z1 + t * fa.uz,
    alongA: isDiagonalRoad(a) ? t : fa.minAlong + t,
    alongB: isDiagonalRoad(b) ? u : fb.minAlong + u,
  };
}
const frozenRoadRectCache = new WeakMap();
const roadsGridCache = new WeakMap();
const SQRT2 = Math.SQRT2;
const ROAD_GRID_CELL = 32;
const ROAD_GRID_INV = 1 / ROAD_GRID_CELL;
const ROAD_GRID_PAD = 7.0;

function roadCellKey(cx, cz) {
  return (cx << 16) ^ (cz & 0xffff);
}

function buildRoadsGrid(roads) {
  const len = roads.length;
  const cells = new Map();
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < len; i++) {
    const r = computeRoadRect(roads[i], 0);
    const x0 = r.minX - ROAD_GRID_PAD, x1 = r.maxX + ROAD_GRID_PAD;
    const z0 = r.minZ - ROAD_GRID_PAD, z1 = r.maxZ + ROAD_GRID_PAD;
    if (x0 < minX) minX = x0;
    if (x1 > maxX) maxX = x1;
    if (z0 < minZ) minZ = z0;
    if (z1 > maxZ) maxZ = z1;
    const cx0 = Math.floor(x0 * ROAD_GRID_INV);
    const cx1 = Math.floor(x1 * ROAD_GRID_INV);
    const cz0 = Math.floor(z0 * ROAD_GRID_INV);
    const cz1 = Math.floor(z1 * ROAD_GRID_INV);
    for (let cx = cx0; cx <= cx1; cx++) {
      const hi = cx << 16;
      for (let cz = cz0; cz <= cz1; cz++) {
        const k = hi ^ (cz & 0xffff);
        let bucket = cells.get(k);
        if (bucket) bucket.push(roads[i]);
        else cells.set(k, [roads[i]]);
      }
    }
  }
  const first = roads[0], last = roads[len - 1], mid = roads[len >> 1];
  const grid = {
    cells,
    len,
    first,
    last,
    mid,
    w0: first.width,
    wL: last.width,
    wM: mid.width,
    f0: first.fixed,
    fL: last.fixed,
    minX,
    maxX,
    minZ,
    maxZ,
  };
  roadsGridCache.set(roads, grid);
  return grid;
}

function getRoadsBucket(roads, x, z) {
  const len = roads.length;
  let grid = roadsGridCache.get(roads);
  const first = roads[0], last = roads[len - 1], mid = roads[len >> 1];
  if (!grid ||
      grid.len !== len ||
      grid.first !== first ||
      grid.last !== last ||
      grid.mid !== mid ||
      grid.w0 !== first.width ||
      grid.wL !== last.width ||
      grid.wM !== mid.width ||
      grid.f0 !== first.fixed ||
      grid.fL !== last.fixed) {
    grid = buildRoadsGrid(roads);
  }
  if (x < grid.minX || x > grid.maxX || z < grid.minZ || z > grid.maxZ) return null;
  return grid.cells.get(roadCellKey(Math.floor(x * ROAD_GRID_INV), Math.floor(z * ROAD_GRID_INV))) ?? null;
}

function computeRoadRect(road, margin = 0) {
  if (isDiagonalRoad(road)) {
    const h = Math.max(0, road.width / 2 - margin);
    const x2 = road.x2 ?? road.x1 + road.ux * road.length,
      z2 = road.z2 ?? road.z1 + road.uz * road.length;
    const midX = (road.x1 + x2) / 2,
      midZ = (road.z1 + z2) / 2;
    const halfLen = road.length / 2 + h;
    const extX = Math.abs(road.ux) * halfLen + Math.abs(road.uz) * h;
    const extZ = Math.abs(road.uz) * halfLen + Math.abs(road.ux) * h;
    return {
      minX: midX - extX,
      maxX: midX + extX,
      minZ: midZ - extZ,
      maxZ: midZ + extZ,
    };
  }
  const h = road.width / 2 - margin;
  return road.axis === "z"
    ? {
        minX: road.fixed - h,
        maxX: road.fixed + h,
        minZ: road.min - h,
        maxZ: road.max + h,
      }
    : {
        minX: road.min - h,
        maxX: road.max + h,
        minZ: road.fixed - h,
        maxZ: road.fixed + h,
      };
}

export function roadRect(road, margin = 0) {
  if (margin === 0 && road !== null && typeof road === "object" && Object.isFrozen(road)) {
    let cached = frozenRoadRectCache.get(road);
    if (!cached) {
      cached = Object.freeze(computeRoadRect(road, 0));
      frozenRoadRectCache.set(road, cached);
    }
    return cached;
  }
  return computeRoadRect(road, margin);
}
export function pointOnRoad(p, roads, margin = 0) {
  const x = p.x, z = p.z;
  let list = roads;
  if (Array.isArray(roads) && roads.length > 8 && margin >= -4.9 && Number.isFinite(x) && Number.isFinite(z)) {
    list = getRoadsBucket(roads, x, z);
    if (!list) return false;
  }
  for (let i = 0; i < list.length; i++) {
    const road = list[i];
    const h = road.width / 2 - margin;
    if (h <= 0) continue;
    if (isDiagonalRoad(road)) {
      if (Object.isFrozen(road)) {
        const r0 = roadRect(road, 0);
        const pad = margin < 0 ? -margin * SQRT2 : 0;
        if (x < r0.minX - pad || x > r0.maxX + pad || z < r0.minZ - pad || z > r0.maxZ + pad)
          continue;
      } else if (road.x2 !== undefined && road.z2 !== undefined) {
        const pad = h * SQRT2;
        const minX = (road.x1 < road.x2 ? road.x1 : road.x2) - pad;
        const maxX = (road.x1 > road.x2 ? road.x1 : road.x2) + pad;
        if (x < minX || x > maxX) continue;
        const minZ = (road.z1 < road.z2 ? road.z1 : road.z2) - pad;
        const maxZ = (road.z1 > road.z2 ? road.z1 : road.z2) + pad;
        if (z < minZ || z > maxZ) continue;
      }
      const dx = x - road.x1, dz = z - road.z1;
      const along = dx * road.ux + dz * road.uz;
      if (along < -h || along > road.length + h) continue;
      const lat = Math.abs(-dx * road.uz + dz * road.ux);
      if (lat <= h) return true;
      continue;
    }
    if (road.axis === "z") {
      if (x >= road.fixed - h && x <= road.fixed + h &&
          z >= road.min - h && z <= road.max + h) return true;
    } else if (z >= road.fixed - h && z <= road.fixed + h &&
               x >= road.min - h && x <= road.max + h) {
      return true;
    }
  }
  return false;
}
function area(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i],
      q = poly[(i + 1) % poly.length];
    a += p.x * q.z - q.x * p.z;
  }
  return Math.abs(a) / 2;
}
function split(poly, axis, value, sign) {
  const inside = [],
    outside = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i],
      b = poly[(i + 1) % poly.length];
    const da = (a[axis] - value) * sign,
      db = (b[axis] - value) * sign;
    (da >= 0 ? inside : outside).push(a);
    if (da >= 0 !== db >= 0) {
      const t = da / (da - db),
        p = { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
      inside.push(p);
      outside.push(p);
    }
  }
  return { inside, outside };
}
function splitHalfPlane(poly, nx, nz, minVal) {
  const inside = [],
    outside = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i],
      b = poly[(i + 1) % poly.length];
    const da = a.x * nx + a.z * nz - minVal,
      db = b.x * nx + b.z * nz - minVal;
    (da >= 0 ? inside : outside).push(a);
    if (da >= 0 !== db >= 0) {
      const t = da / (da - db),
        p = { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
      inside.push(p);
      outside.push(p);
    }
  }
  return { inside, outside };
}
function pointInRoadList(x, z, list, margin) {
  for (let i = 0; i < list.length; i++) {
    const road = list[i];
    const h = road.width / 2 - margin;
    if (h <= 0) continue;
    if (isDiagonalRoad(road)) {
      const dx = x - road.x1, dz = z - road.z1;
      const along = dx * road.ux + dz * road.uz;
      if (along < -h || along > road.length + h) continue;
      if (Math.abs(-dx * road.uz + dz * road.ux) <= h) return true;
      continue;
    }
    if (road.axis === "z") {
      if (x >= road.fixed - h && x <= road.fixed + h &&
          z >= road.min - h && z <= road.max + h) return true;
    } else if (z >= road.fixed - h && z <= road.fixed + h &&
               x >= road.min - h && x <= road.max + h) {
      return true;
    }
  }
  return false;
}

// Subtract the road rectangles from the complete oriented body polygon.
// Checking only a centre or four corners can miss a curb under the body.
export function bodyOnRoad(body, roads, margin = 0.08) {
  const s = Math.sin(body.heading ?? 0), c = Math.cos(body.heading ?? 0);
  const l = (body.length ?? 0) / 2, w = (body.width ?? 0) / 2;
  const cw = c * w, sw = s * w, cl = s * l, sl = c * l;
  const bx = body.x, bz = body.z;
  const x0 = bx - cw - cl, z0 = bz + sw - sl;
  const x1 = bx + cw - cl, z1 = bz - sw - sl;
  const x2 = bx + cw + cl, z2 = bz - sw + sl;
  const x3 = bx - cw + cl, z3 = bz + sw + sl;
  const bMinX = Math.min(x0, x1, x2, x3);
  const bMaxX = Math.max(x0, x1, x2, x3);
  const bMinZ = Math.min(z0, z1, z2, z3);
  const bMaxZ = Math.max(z0, z1, z2, z3);
  const halfSpan = Math.max(bMaxX - bx, bMaxZ - bz) + (margin < 0 ? -margin * SQRT2 : 0);
  let list = roads;
  if (Array.isArray(roads) && roads.length > 8 && halfSpan <= ROAD_GRID_PAD && Number.isFinite(bx) && Number.isFinite(bz)) {
    list = getRoadsBucket(roads, bx, bz);
    if (!list) return Math.abs((body.length ?? 0) * (body.width ?? 0)) < EPS;
  }
  let cornersChecked = w < 0.01 || l < 0.01;
  const cornerMargin = margin - 0.002;
  let uncovered = null;

  for (let rIdx = 0; rIdx < list.length; rIdx++) {
    const road = list[rIdx];
    const h = road.width / 2 - margin;
    if (h <= 0) continue;
    if (isDiagonalRoad(road)) {
      const ux = road.ux, uz = road.uz;
      const x2r = road.x2 ?? road.x1 + ux * road.length;
      const z2r = road.z2 ?? road.z1 + uz * road.length;
      const midX = (road.x1 + x2r) * 0.5, midZ = (road.z1 + z2r) * 0.5;
      const halfLen = road.length * 0.5 + h;
      const extX = Math.abs(ux) * halfLen + Math.abs(uz) * h;
      const extZ = Math.abs(uz) * halfLen + Math.abs(ux) * h;
      if (bMaxX < midX - extX || bMinX > midX + extX ||
          bMaxZ < midZ - extZ || bMinZ > midZ + extZ) continue;

      const rx1 = road.x1, rz1 = road.z1, maxAlong = road.length + h;
      if (uncovered === null) {
        const d0x = x0 - rx1, d0z = z0 - rz1, a0 = d0x * ux + d0z * uz, l0 = -d0x * uz + d0z * ux;
        const d1x = x1 - rx1, d1z = z1 - rz1, a1 = d1x * ux + d1z * uz, l1 = -d1x * uz + d1z * ux;
        const d2x = x2 - rx1, d2z = z2 - rz1, a2 = d2x * ux + d2z * uz, l2 = -d2x * uz + d2z * ux;
        const d3x = x3 - rx1, d3z = z3 - rz1, a3 = d3x * ux + d3z * uz, l3 = -d3x * uz + d3z * ux;
        if (a0 >= -h && a0 <= maxAlong && Math.abs(l0) <= h &&
            a1 >= -h && a1 <= maxAlong && Math.abs(l1) <= h &&
            a2 >= -h && a2 <= maxAlong && Math.abs(l2) <= h &&
            a3 >= -h && a3 <= maxAlong && Math.abs(l3) <= h) return true;
        if ((a0 <= -h && a1 <= -h && a2 <= -h && a3 <= -h) ||
            (a0 >= maxAlong && a1 >= maxAlong && a2 >= maxAlong && a3 >= maxAlong) ||
            (l0 <= -h && l1 <= -h && l2 <= -h && l3 <= -h) ||
            (l0 >= h && l1 >= h && l2 >= h && l3 >= h)) continue;
        if (!cornersChecked) {
          if (!pointInRoadList(x0, z0, list, cornerMargin) ||
              !pointInRoadList(x1, z1, list, cornerMargin) ||
              !pointInRoadList(x2, z2, list, cornerMargin) ||
              !pointInRoadList(x3, z3, list, cornerMargin)) return false;
          cornersChecked = true;
        }
        uncovered = [[
          { x: x0, z: z0 }, { x: x1, z: z1 }, { x: x2, z: z2 }, { x: x3, z: z3 },
        ]];
      }

      const u0 = rx1 * ux + rz1 * uz;
      const lat0 = -rx1 * uz + rz1 * ux;
      const p0Min = u0 - h, p1Min = -(u0 + maxAlong), p2Min = lat0 - h, p3Min = -lat0 - h;
      const remaining = [];
      for (let pIdx = 0; pIdx < uncovered.length; pIdx++) {
        let polygon = uncovered[pIdx];
        let allIn = true;
        let out0 = true, out1 = true, out2 = true, out3 = true;
        for (let k = 0; k < polygon.length; k++) {
          const p = polygon[k];
          const u = p.x * ux + p.z * uz;
          const lat = -p.x * uz + p.z * ux;
          if (u < p0Min) allIn = false; else if (u > p0Min) out0 = false;
          if (-u < p1Min) allIn = false; else if (-u > p1Min) out1 = false;
          if (lat < p2Min) allIn = false; else if (lat > p2Min) out2 = false;
          if (-lat < p3Min) allIn = false; else if (-lat > p3Min) out3 = false;
        }
        if (allIn) continue;
        if (out0 || out1 || out2 || out3) {
          remaining.push(polygon);
          continue;
        }
        const planes = [
          [ux, uz, p0Min],
          [-ux, -uz, p1Min],
          [-uz, ux, p2Min],
          [uz, -ux, p3Min],
        ];
        for (let q = 0; q < 4; q++) {
          if (polygon.length < 3) break;
          const [nx, nz, minVal] = planes[q];
          const parts = splitHalfPlane(polygon, nx, nz, minVal);
          if (parts.outside.length >= 3 && area(parts.outside) > EPS)
            remaining.push(parts.outside);
          polygon = parts.inside;
        }
      }
      uncovered = remaining;
      if (!uncovered.length) return true;
      continue;
    }

    const rMinX = road.axis === "z" ? road.fixed - h : road.min - h;
    const rMaxX = road.axis === "z" ? road.fixed + h : road.max + h;
    if (bMaxX < rMinX || bMinX > rMaxX) continue;
    const rMinZ = road.axis === "z" ? road.min - h : road.fixed - h;
    const rMaxZ = road.axis === "z" ? road.max + h : road.fixed + h;
    if (bMaxZ < rMinZ || bMinZ > rMaxZ) continue;

    if (uncovered === null) {
      if (bMinX >= rMinX && bMaxX <= rMaxX && bMinZ >= rMinZ && bMaxZ <= rMaxZ) return true;
      if (!cornersChecked) {
        if (!pointInRoadList(x0, z0, list, cornerMargin) ||
            !pointInRoadList(x1, z1, list, cornerMargin) ||
            !pointInRoadList(x2, z2, list, cornerMargin) ||
            !pointInRoadList(x3, z3, list, cornerMargin)) return false;
        cornersChecked = true;
      }
      uncovered = [[
        { x: x0, z: z0 }, { x: x1, z: z1 }, { x: x2, z: z2 }, { x: x3, z: z3 },
      ]];
    }

    const remaining = [];
    for (let pIdx = 0; pIdx < uncovered.length; pIdx++) {
      let polygon = uncovered[pIdx];
      let allIn = true;
      let pMinX = Infinity, pMaxX = -Infinity, pMinZ = Infinity, pMaxZ = -Infinity;
      for (let k = 0; k < polygon.length; k++) {
        const p = polygon[k];
        if (p.x < pMinX) pMinX = p.x;
        if (p.x > pMaxX) pMaxX = p.x;
        if (p.z < pMinZ) pMinZ = p.z;
        if (p.z > pMaxZ) pMaxZ = p.z;
        if (p.x < rMinX || p.x > rMaxX || p.z < rMinZ || p.z > rMaxZ) allIn = false;
      }
      if (allIn) continue;
      if (pMaxX <= rMinX || pMinX >= rMaxX || pMaxZ <= rMinZ || pMinZ >= rMaxZ) {
        remaining.push(polygon);
        continue;
      }
      for (const [axis, value, sign] of [
        ["x", rMinX, 1],
        ["x", rMaxX, -1],
        ["z", rMinZ, 1],
        ["z", rMaxZ, -1],
      ]) {
        if (polygon.length < 3) break;
        const parts = split(polygon, axis, value, sign);
        if (parts.outside.length >= 3 && area(parts.outside) > EPS)
          remaining.push(parts.outside);
        polygon = parts.inside;
      }
    }
    uncovered = remaining;
    if (!uncovered.length) return true;
  }
  if (uncovered === null) return Math.abs((body.length ?? 0) * (body.width ?? 0)) < EPS;
  return uncovered.reduce((sum, p) => sum + area(p), 0) < EPS;
}
export function interpolate(a, b, t, pose = { ...b }) {
  pose.x = a.x + (b.x - a.x) * t;
  pose.z = a.z + (b.z - a.z) * t;
  pose.heading = (a.heading ?? 0) + angleDelta(b.heading ?? 0, a.heading ?? 0) * t;
  return pose;
}
export function sweepSafe(before, after, others, roads = null) {
  const heading = before.heading ?? 0;
  const turn = angleDelta(after.heading ?? 0, heading);
  const dx = after.x - before.x, dz = after.z - before.z;
  const travel =
    distance(before, after) +
    (Math.abs(turn) * Math.hypot(before.length ?? 1, before.width ?? 1)) /
      2;
  const steps = Math.max(1, Math.ceil(travel / 0.12));
  const pose = { x: 0, z: 0, heading: 0, type: after.type,
    radius: after.radius, length: after.length, width: after.width };
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    pose.x = before.x + dx * t;
    pose.z = before.z + dz * t;
    pose.heading = heading + turn * t;
    if (roads && !bodyOnRoad(pose, roads))
      return { safe: false, reason: "road-boundary" };
    for (const other of others)
      if (overlaps(pose, other, 0.12))
        return { safe: false, reason: "occupied", actor: other.id };
  }
  return { safe: true, reason: "clear" };
}
