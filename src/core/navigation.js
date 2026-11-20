import { angleDelta, distance } from "./geometry.js";
export const LANE_OFFSET = 1.65;
const key = (p) => `${p.x.toFixed(4)},${p.z.toFixed(4)}`;
const direction = (a, b) => Math.atan2(b.x - a.x, b.z - a.z);
export function createRoadGraph(roads) {
  const nodes = new Map();
  const put = (p) => {
    const k = key(p);
    if (!nodes.has(k)) nodes.set(k, { ...p, key: k, edges: [] });
    return nodes.get(k);
  };
  for (const road of roads) {
    const values = new Set([road.min, road.max]);
    for (let n = road.min; n < road.max; n += 10) values.add(n);
    for (const other of roads) {
      if (other.axis === road.axis) continue;
      if (
        other.fixed >= road.min &&
        other.fixed <= road.max &&
        road.fixed >= other.min &&
        road.fixed <= other.max
      )
        values.add(other.fixed);
    }
    let previous = null;
    for (const value of [...values].sort((a, b) => a - b)) {
      const node = put(
        road.axis === "z"
          ? { x: road.fixed, z: value }
          : { x: value, z: road.fixed },
      );
      if (previous) {
        previous.edges.push(node.key);
        node.edges.push(previous.key);
      }
      previous = node;
    }
  }
  for (const node of nodes.values()) node.edges = [...new Set(node.edges)];
  return nodes;
}
export function junctionPressure(groups, actors) {
  const costs = new Map();
  for (const group of groups) {
    const queue = actors.filter(
      (actor) =>
        actor.type === "vehicle" &&
        actor.path?.length &&
        actor.queuedJunction === group.key &&
        actor.wait > 2,
    );
    if (!queue.length) continue;
    const longest = Math.max(...queue.map((actor) => actor.wait));
    const penalty = Math.min(120, queue.length * 5 + longest * 0.8);
    for (const node of group.members)
      costs.set(node.key, Math.max(costs.get(node.key) ?? 0, penalty));
  }
  return costs;
}
export function planNavigation(
  graph,
  body,
  goal,
  actors = [],
  pressure = null,
  initialTurnLimit = 0.5,
) {
  const all = [...graph.values()];
  const nearest = (p) =>
    all.reduce((a, b) => (distance(a, p) < distance(b, p) ? a : b));
  const start = nearest(body),
    end = nearest(goal);
  if (start === end && distance(body, goal) < 5) return [];
  const heading = Number.isFinite(body.heading) ? body.heading : 0;
  const initial = { node: start, heading, parent: null, cost: 0 };
  const open = [initial],
    best = new Map();
  let found = null;
  while (open.length) {
    open.sort(
      (a, b) =>
        a.cost + distance(a.node, end) - (b.cost + distance(b.node, end)),
    );
    const current = open.shift();
    if (current.node === end && current.parent) {
      found = current;
      break;
    }
    for (const edge of current.node.edges) {
      const next = graph.get(edge),
        h = direction(current.node, next);
      const turn = Math.abs(angleDelta(h, current.heading));
      if (turn > Math.PI * 0.75 || (!current.parent && turn > initialTurnLimit)) continue;
      const mid = {
        x: (current.node.x + next.x) / 2,
        z: (current.node.z + next.z) / 2,
      };
      const congestion = actors.filter(
        (actor) =>
          actor.id !== body.id &&
          actor.type !== "pedestrian" &&
          distance(actor, mid) < 8,
      ).length;
      const cost =
        current.cost +
        distance(current.node, next) * (1 + congestion * 0.8) +
        (pressure?.get(next.key) ?? 0) +
        (turn > 0.1 ? 3 : 0);
      const state = `${edge}:${Math.round(h * 100)}`;
      if (cost >= (best.get(state) ?? Infinity)) continue;
      best.set(state, cost);
      open.push({ node: next, heading: h, parent: current, cost });
    }
  }
  if (!found) return [];
  const points = [];
  for (let node = found; node; node = node.parent)
    points.push({ x: node.node.x, z: node.node.z });
  return lanePath(points.reverse());
}
export function lanePath(points, offset = LANE_OFFSET) {
  if (points.length < 2) return [];
  const turns = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    if (
      Math.abs(
        angleDelta(
          direction(points[i], points[i + 1]),
          direction(points[i - 1], points[i]),
        ),
      ) > 0.01
    )
      turns.push(points[i]);
  }
  turns.push(points.at(-1));
  const normals = [];
  for (let i = 0; i < turns.length - 1; i++) {
    const length = distance(turns[i], turns[i + 1]);
    normals.push({
      x: (turns[i + 1].x - turns[i].x) / length,
      z: (turns[i + 1].z - turns[i].z) / length,
    });
  }
  const shifted = turns.map((p, i) => {
    const a = normals[Math.max(0, i - 1)],
      b = normals[Math.min(i, normals.length - 1)];
    const count = i === 0 || i === turns.length - 1 ? 1 : 2;
    return {
      x: p.x - offset * (count === 1 ? b.z : a.z + b.z),
      z: p.z + offset * (count === 1 ? b.x : a.x + b.x),
    };
  });
  const path = [];
  const append = (p) => {
    const prev = path.at(-1);
    if (!prev) {
      path.push(p);
      return;
    }
    const length = distance(prev, p),
      count = Math.max(1, Math.ceil(length / 0.65));
    for (let i = 1; i <= count; i++)
      path.push({
        x: prev.x + ((p.x - prev.x) * i) / count,
        z: prev.z + ((p.z - prev.z) * i) / count,
      });
  };
  append(shifted[0]);
  for (let i = 1; i < shifted.length - 1; i++) {
    const p = shifted[i],
      a = normals[i - 1],
      b = normals[i];
    const radius = Math.min(
      4.2,
      distance(shifted[i - 1], p) * 0.45,
      distance(p, shifted[i + 1]) * 0.45,
    );
    const start = { x: p.x - a.x * radius, z: p.z - a.z * radius };
    const end = { x: p.x + b.x * radius, z: p.z + b.z * radius };
    const center = { x: start.x + b.x * radius, z: start.z + b.z * radius };
    append(start);
    const first = Math.atan2(start.z - center.z, start.x - center.x);
    const last = Math.atan2(end.z - center.z, end.x - center.x);
    const arc = angleDelta(last, first),
      steps = Math.ceil((radius * Math.abs(arc)) / 0.5);
    for (let j = 1; j <= steps; j++)
      append({
        x: center.x + Math.cos(first + (arc * j) / steps) * radius,
        z: center.z + Math.sin(first + (arc * j) / steps) * radius,
      });
  }
  append(shifted.at(-1));
  return path;
}
