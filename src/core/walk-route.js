import { CIRCULAR_CONTACT_TOLERANCE_M, corners, distance, overlaps } from "./geometry.js";

function pointSegment(px, pz, ax, az, dx, dz, lengthSquared) {
  const t = Math.max(
    0,
    Math.min(1, ((px - ax) * dx + (pz - az) * dz) / lengthSquared),
  );
  return Math.hypot(px - ax - dx * t, pz - az - dz * t);
}

// Exact continuous segment clearance for a walking circle. The renderer and
// frame rate are irrelevant. This also catches grazing contacts near the start.
export function walkSegmentBlocker(person, a, b, obstacles, gap = 0.16, allowMarginExit = false) {
  const ax = a.x, az = a.z, bx = b.x, bz = b.z;
  const dx = bx - ax, dz = bz - az, lengthSquared = dx * dx + dz * dz || 1;
  const minX = Math.min(ax, bx), maxX = Math.max(ax, bx);
  const minZ = Math.min(az, bz), maxZ = Math.max(az, bz);
  const padding = person.radius + gap;
  // An actor may have moved into the extra padding since the last walk step.
  // Escape that margin only along a segment that never approaches the solid.
  const exitsMargin = (start, end, clearance, physical) =>
    allowMarginExit && clearance >= physical - CIRCULAR_CONTACT_TOLERANCE_M &&
      end > start + 1e-7 && clearance >= start - 1e-7;
  // An enclosure rejects distant bodies only; do not replace the strict
  // distance/slab tests or change which obstacle is considered first.
  for (const item of obstacles) {
    if (item.id === person.id) continue;
    const x = item.x, z = item.z;
    if (item.type === "pedestrian") {
      const clearance = person.radius + item.radius + gap;
      if (x < minX - clearance - 1e-7 || x > maxX + clearance + 1e-7 ||
          z < minZ - clearance - 1e-7 || z > maxZ + clearance + 1e-7) continue;
      const closest = pointSegment(x, z, ax, az, dx, dz, lengthSquared);
      if (closest < clearance && !exitsMargin(Math.hypot(ax - x, az - z),
        Math.hypot(bx - x, bz - z), closest, person.radius + item.radius)) return item;
      continue;
    }
    const hw = item.width / 2, hl = item.length / 2;
    const reach = Math.abs(hw) + Math.abs(hl) + Math.max(0, padding) + 1e-7;
    if (x < minX - reach || x > maxX + reach || z < minZ - reach || z > maxZ + reach)
      continue;
    const c = Math.cos(item.heading ?? 0),
      s = Math.sin(item.heading ?? 0);
    const sx = (ax - x) * c - (az - z) * s, sz = (ax - x) * s + (az - z) * c;
    const ex = (bx - x) * c - (bz - z) * s, ez = (bx - x) * s + (bz - z) * c;
    const lx = ex - sx, lz = ez - sz;
    let low = 0, high = 1;
    if (Math.abs(lx) < 1e-10) {
      if (Math.abs(sx) > hw) low = 2;
    } else {
      const t1 = (-hw - sx) / lx, t2 = (hw - sx) / lx;
      low = Math.max(low, Math.min(t1, t2));
      high = Math.min(high, Math.max(t1, t2));
    }
    if (Math.abs(lz) < 1e-10) {
      if (Math.abs(sz) > hl) low = 2;
    } else {
      const t1 = (-hl - sz) / lz, t2 = (hl - sz) / lz;
      low = Math.max(low, Math.min(t1, t2));
      high = Math.min(high, Math.max(t1, t2));
    }
    if (low <= high) return item;
    const rectStart = Math.hypot(Math.max(0, Math.abs(sx) - hw), Math.max(0, Math.abs(sz) - hl));
    const rectEnd = Math.hypot(Math.max(0, Math.abs(ex) - hw), Math.max(0, Math.abs(ez) - hl));
    const localLengthSquared = lx * lx + lz * lz || 1;
    const clearance = Math.min(rectStart, rectEnd,
      pointSegment(-hw, -hl, sx, sz, lx, lz, localLengthSquared),
      pointSegment(-hw, hl, sx, sz, lx, lz, localLengthSquared),
      pointSegment(hw, -hl, sx, sz, lx, lz, localLengthSquared),
      pointSegment(hw, hl, sx, sz, lx, lz, localLengthSquared));
    if (clearance < padding - 1e-7 && !exitsMargin(rectStart, rectEnd, clearance, person.radius))
      return item;
  }
  return null;
}

export function walkSegmentClear(person, a, b, obstacles, gap = 0.16, allowMarginExit = false) {
  return walkSegmentBlocker(person, a, b, obstacles, gap, allowMarginExit) === null;
}

export function planWalk(person, target, obstacles, allowMarginExit = false) {
  if (walkSegmentClear(person, person, target, obstacles, 0.16, allowMarginExit)) return [target];
  const nodes = [person, target];
  for (const body of obstacles) {
    if (body.type === "pedestrian") continue;
    for (const point of corners(body, person.radius + 0.28)) {
      const pose = { type: person.type, radius: person.radius, heading: person.heading,
        length: person.length, width: person.width, x: point.x, z: point.z };
      if (!obstacles.some((a) => overlaps(pose, a, 0.16)))
        nodes.push(point);
    }
  }
  const costs = nodes.map(() => Infinity),
    parents = nodes.map(() => -1),
    open = new Set([0]);
  costs[0] = 0;
  while (open.size) {
    const current = [...open].sort(
      (a, b) =>
        costs[a] +
          distance(nodes[a], target) -
          costs[b] -
          distance(nodes[b], target) || a - b,
    )[0];
    open.delete(current);
    if (current === 1) {
      const route = [];
      for (let i = 1; i > 0; i = parents[i])
        route.unshift({ x: nodes[i].x, z: nodes[i].z });
      return route;
    }
    for (let next = 1; next < nodes.length; next++) {
      const cost = costs[current] + distance(nodes[current], nodes[next]);
      if (
        cost >= costs[next] ||
        !walkSegmentClear(person, nodes[current], nodes[next], obstacles, 0.16, current === 0 && allowMarginExit)
      )
        continue;
      costs[next] = cost;
      parents[next] = current;
      open.add(next);
    }
  }
  return [];
}

export function canLeaveWalkMargin(world, person) {
  return Boolean(world.pursuit?.response?.dispatch && person.district?.routeConstrained && !person.district?.caseId);
}

export function walkingWaypoint(world, person, nearby) {
  const obstacles = nearby.filter(
    (a) => a.type !== "pedestrian" && (a.speed ?? 0) < 0.8,
  );
  // A curb point occupied by a stopped car is not a usable destination. Choose
  // another point along that same curb; never teleport the walker or the car.
  const pose = { ...person, ...person.target };
  if (obstacles.some((a) => overlaps(pose, a, 0.2))) {
    for (const offset of [1.5, -1.5, 3, -3, 5, -5]) {
      const target = { ...person.target };
      if (person.road?.axis === "diag") {
        target.x += person.road.ux * offset;
        target.z += person.road.uz * offset;
      } else {
        target[person.road?.axis === "z" ? "z" : "x"] += offset;
      }
      pose.x = target.x;
      pose.z = target.z;
      if (!obstacles.some((a) => overlaps(pose, a, 0.3))) {
        person.target = target;
        person.walkRoute = null;
        break;
      }
    }
  }
  const goalKey = `${person.target.x},${person.target.z}`;
  if (
    person.walkGoal !== goalKey ||
    !person.walkRoute ||
    world.tick >= (person.walkPlanTick ?? 0) + 90
  ) {
    const previous = person.walkRoute?.[0];
    // Keep a viable detour until its corner is reached. Replanning each frame
    // can alternate two equally short routes and trap a person beside a car.
    if (
      person.walkGoal !== goalKey ||
      !previous ||
      !walkSegmentClear(person, person, previous, obstacles, 0.12)
    )
      person.walkRoute = planWalk(person, person.target, obstacles);
    person.walkGoal = goalKey;
    person.walkPlanTick = world.tick;
  }
  while (
    person.walkRoute.length > 1 &&
    distance(person, person.walkRoute[0]) < 0.25
  )
    person.walkRoute.shift();
  return person.walkRoute[0] ?? person.target;
}
