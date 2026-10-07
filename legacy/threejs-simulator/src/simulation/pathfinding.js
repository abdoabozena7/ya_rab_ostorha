// Road coordinates are generated more than once as the city expands. Build a
// unique graph here so route planning stays predictable and reasonably fast.
export function findRoute(roadNodes, startPosition, goalPosition) {
  const nodes = new Map();
  for (const { x, z } of roadNodes) nodes.set(`${x},${z}`, { x, z });
  const all = [...nodes.values()];
  if (!all.length) return [];

  const nearest = (position) => all.reduce((best, node) =>
    Math.hypot(node.x - position.x, node.z - position.z) <
    Math.hypot(best.x - position.x, best.z - position.z) ? node : best);
  const start = nearest(startPosition);
  const goal = nearest(goalPosition);
  const key = ({ x, z }) => `${x},${z}`;
  const heuristic = (node) => Math.abs(node.x - goal.x) + Math.abs(node.z - goal.z);
  const open = [start];
  const queued = new Set([key(start)]);
  const costs = new Map([[key(start), 0]]);
  const parents = new Map();

  while (open.length) {
    open.sort((a, b) => (costs.get(key(a)) + heuristic(a)) - (costs.get(key(b)) + heuristic(b)));
    const current = open.shift();
    queued.delete(key(current));
    if (current === goal) {
      const route = [];
      for (let node = current; node; node = parents.get(key(node))) {
        route.push({ x: node.x, z: node.z, g: costs.get(key(node)) });
      }
      return route.reverse();
    }
    for (const [dx, dz] of [[10, 0], [-10, 0], [0, 10], [0, -10]]) {
      const next = nodes.get(`${current.x + dx},${current.z + dz}`);
      if (!next) continue;
      const nextCost = costs.get(key(current)) + 10;
      if (nextCost >= (costs.get(key(next)) ?? Infinity)) continue;
      costs.set(key(next), nextCost);
      parents.set(key(next), current);
      if (!queued.has(key(next))) {
        open.push(next);
        queued.add(key(next));
      }
    }
  }
  return [];
}

// The car follows a lane offset from the road centre, while place markers sit
// on that centre. Arrival therefore needs room for the offset and waypoint gap.
export function hasArrived(position, destination) {
  return Math.hypot(position.x - destination.x, position.z - destination.z) < 8;
}
