const EPS = 1e-7;
export const distance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
export const angleDelta = (a, b) =>
  Math.atan2(Math.sin(a - b), Math.cos(a - b));
export function corners(body, gap = 0) {
  const f = { x: Math.sin(body.heading ?? 0), z: Math.cos(body.heading ?? 0) };
  const r = { x: f.z, z: -f.x };
  const l = (body.length ?? 0) / 2 + gap,
    w = (body.width ?? 0) / 2 + gap;
  return [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ].map(([sx, sz]) => ({
    x: body.x + r.x * w * sx + f.x * l * sz,
    z: body.z + r.z * w * sx + f.z * l * sz,
  }));
}
export function overlaps(a, b, gap = 0) {
  const ac = a.type === "pedestrian",
    bc = b.type === "pedestrian";
  const ra = ac ? a.radius : Math.hypot(a.length, a.width) / 2;
  const rb = bc ? b.radius : Math.hypot(b.length, b.width) / 2;
  if (distance(a, b) >= ra + rb + gap) return false;
  if (ac && bc) return distance(a, b) < ra + rb + gap - EPS;
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
    return Math.hypot(ex, ez) < circle.radius + gap - EPS;
  }
  const pa = corners(a, gap / 2),
    pb = corners(b, gap / 2);
  for (const body of [a, b])
    for (const offset of [0, Math.PI / 2]) {
      const x = Math.sin((body.heading ?? 0) + offset),
        z = Math.cos((body.heading ?? 0) + offset);
      const va = pa.map((p) => p.x * x + p.z * z),
        vb = pb.map((p) => p.x * x + p.z * z);
      if (
        Math.max(...va) <= Math.min(...vb) + EPS ||
        Math.max(...vb) <= Math.min(...va) + EPS
      )
        return false;
    }
  return true;
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
  return roads.some((r) => {
    const b = roadRect(r, margin);
    return p.x >= b.minX && p.x <= b.maxX && p.z >= b.minZ && p.z <= b.maxZ;
  });
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
export function interpolate(a, b, t) {
  return {
    ...b,
    x: a.x + (b.x - a.x) * t,
    z: a.z + (b.z - a.z) * t,
    heading: (a.heading ?? 0) + angleDelta(b.heading ?? 0, a.heading ?? 0) * t,
  };
}
export function sweepSafe(before, after, others, roads = null) {
  const travel =
    distance(before, after) +
    (Math.abs(angleDelta(after.heading ?? 0, before.heading ?? 0)) *
      Math.hypot(before.length ?? 1, before.width ?? 1)) /
      2;
  const steps = Math.max(1, Math.ceil(travel / 0.12));
  for (let i = 1; i <= steps; i++) {
    const pose = interpolate(before, after, i / steps);
    if (roads && !bodyOnRoad(pose, roads))
      return { safe: false, reason: "road-boundary" };
    for (const other of others)
      if (overlaps(pose, other, 0.12))
        return { safe: false, reason: "occupied", actor: other.id };
  }
  return { safe: true, reason: "clear" };
}
