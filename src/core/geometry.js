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
  const pa = corners(a, gap / 2),
    pb = corners(b, gap / 2);
  const ah = a.heading ?? 0, bh = b.heading ?? 0;
  return !separates(pa, pb, ah + 0) && !separates(pa, pb, ah + Math.PI / 2) &&
    !separates(pa, pb, bh + 0) && !separates(pa, pb, bh + Math.PI / 2);
}
export function roadRect(road, margin = 0) {
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
export function pointOnRoad(p, roads, margin = 0) {
  const x = p.x, z = p.z;
  for (const road of roads) {
    const h = road.width / 2 - margin;
    const along = road.axis === "z" ? z : x;
    const lateral = road.axis === "z" ? x : z;
    if (lateral >= road.fixed - h && lateral <= road.fixed + h &&
        along >= road.min - h && along <= road.max + h) return true;
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
// Subtract the road rectangles from the complete oriented body polygon.
// Checking only a centre or four corners can miss a curb under the body.
export function bodyOnRoad(body, roads, margin = 0.08) {
  let uncovered = [corners(body)];
  const radius = Math.hypot(body.length, body.width) / 2;
  for (const road of roads) {
    const r = roadRect(road, margin);
    if (
      body.x + radius < r.minX ||
      body.x - radius > r.maxX ||
      body.z + radius < r.minZ ||
      body.z - radius > r.maxZ
    )
      continue;
    const remaining = [];
    for (let polygon of uncovered) {
      if (polygon.every((p) =>
        p.x >= r.minX && p.x <= r.maxX && p.z >= r.minZ && p.z <= r.maxZ)) continue;
      for (const [axis, value, sign] of [
        ["x", r.minX, 1],
        ["x", r.maxX, -1],
        ["z", r.minZ, 1],
        ["z", r.maxZ, -1],
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
