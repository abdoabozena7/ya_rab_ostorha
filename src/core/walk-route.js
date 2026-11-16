import { corners, distance, overlaps } from "./geometry.js";

function pointSegment(p, a, b) {
  const dx = b.x - a.x,
    dz = b.z - a.z;
  const t = Math.max(
    0,
    Math.min(
      1,
      ((p.x - a.x) * dx + (p.z - a.z) * dz) / (dx * dx + dz * dz || 1),
    ),
  );
  return Math.hypot(p.x - a.x - dx * t, p.z - a.z - dz * t);
}

// Exact continuous segment clearance for a walking circle. The renderer and
// frame rate are irrelevant. This also catches grazing contacts near the start.
export function walkSegmentClear(person, a, b, obstacles, gap = 0.16) {
  for (const item of obstacles) {
    if (item.id === person.id) continue;
    if (item.type === "pedestrian") {
      if (pointSegment(item, a, b) < person.radius + item.radius + gap)
        return false;
      continue;
    }
    const c = Math.cos(item.heading ?? 0),
      s = Math.sin(item.heading ?? 0);
    const local = (p) => ({
      x: (p.x - item.x) * c - (p.z - item.z) * s,
      z: (p.x - item.x) * s + (p.z - item.z) * c,
    });
    const start = local(a),
      end = local(b),
      hw = item.width / 2,
      hl = item.length / 2;
    let low = 0,
      high = 1;
    for (const [axis, half] of [
      ["x", hw],
      ["z", hl],
    ]) {
      const delta = end[axis] - start[axis];
      if (Math.abs(delta) < 1e-10) {
        if (Math.abs(start[axis]) > half) {
          low = 2;
          break;
        }
      } else {
        const t1 = (-half - start[axis]) / delta,
          t2 = (half - start[axis]) / delta;
        low = Math.max(low, Math.min(t1, t2));
        high = Math.min(high, Math.max(t1, t2));
      }
    }
    if (low <= high) return false;
    const pointRect = (p) =>
      Math.hypot(
        Math.max(0, Math.abs(p.x) - hw),
        Math.max(0, Math.abs(p.z) - hl),
      );
    let clearance = Math.min(pointRect(start), pointRect(end));
    for (const x of [-hw, hw])
      for (const z of [-hl, hl])
        clearance = Math.min(clearance, pointSegment({ x, z }, start, end));
    if (clearance < person.radius + gap - 1e-7) return false;
  }
  return true;
}

export function planWalk(person, target, obstacles) {
  if (walkSegmentClear(person, person, target, obstacles)) return [target];
  const nodes = [person, target];
  for (const body of obstacles) {
    if (body.type === "pedestrian") continue;
    for (const point of corners(body, person.radius + 0.28))
      if (!obstacles.some((a) => overlaps({ ...person, ...point }, a, 0.16)))
        nodes.push(point);
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
        !walkSegmentClear(person, nodes[current], nodes[next], obstacles)
      )
        continue;
      costs[next] = cost;
      parents[next] = current;
      open.add(next);
    }
  }
  return [];
}

export function walkingWaypoint(world, person, nearby) {
  const obstacles = nearby.filter(
    (a) => a.type !== "pedestrian" && (a.speed ?? 0) < 0.8,
  );
  // A curb point occupied by a stopped car is not a usable destination. Choose
  // another point along that same curb; never teleport the walker or the car.
  if (
    obstacles.some((a) => overlaps({ ...person, ...person.target }, a, 0.2))
  ) {
    for (const offset of [1.5, -1.5, 3, -3, 5, -5]) {
      const target = { ...person.target };
      target[person.road.axis === "z" ? "z" : "x"] += offset;
      if (!obstacles.some((a) => overlaps({ ...person, ...target }, a, 0.3))) {
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
