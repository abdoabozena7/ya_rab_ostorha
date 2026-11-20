import { angleDelta, bodyOnRoad, distance, overlaps } from "./geometry.js";
import { SpatialIndex } from "./spatial-index.js";

const RADIUS_M = 3.8;
const SAMPLE_M = 0.35;
const EXIT_COMPENSATION_M = 0.5;
const RECOVERY_M = 8;
const geometryCache = new WeakMap();
const key = (p) => `${p.x.toFixed(5)},${p.z.toFixed(5)}`;
const dot = (a, b) => a.x * b.x + a.z * b.z;
const shift = (p, direction, amount) => ({
  x: p.x + direction.x * amount, z: p.z + direction.z * amount,
});
const heading = (v) => Math.atan2(v.x, v.z);

function graphFor(district, body) {
  const signature = JSON.stringify([district.drivingRoads, district.roads, district.statics]);
  let cached = geometryCache.get(district);
  if (!cached || cached.signature !== signature) {
    cached = { signature, shapes: new Map() };
    geometryCache.set(district, cached);
  }
  const shapeKey = `${body.length}:${body.width}`;
  if (cached.shapes.has(shapeKey)) return cached.shapes.get(shapeKey);
  const roads = district.drivingRoads.filter((r) =>
    !r.parkingBay && !r.supportApron && r.width >= body.width + 0.24);
  const nodes = new Map(), links = [];
  const put = (p) => {
    const id = key(p);
    if (!nodes.has(id)) nodes.set(id, { ...p, id, incoming: [], outgoing: [] });
    return nodes.get(id);
  };
  for (const road of roads) {
    const cuts = new Set([road.min, road.max]);
    for (const other of roads) {
      if (road.axis === other.axis) continue;
      if (other.fixed >= road.min && other.fixed <= road.max
          && road.fixed >= other.min && road.fixed <= other.max) cuts.add(other.fixed);
    }
    const along = [...cuts].sort((a, b) => a - b);
    const at = (value) => put(road.axis === "z"
      ? { x: road.fixed, z: value } : { x: value, z: road.fixed });
    for (let i = 1; i < along.length; i++) {
      const a = at(along[i - 1]), b = at(along[i]);
      for (const sign of road.flow ? [road.flow] : [1, -1]) {
        const from = sign === 1 ? a : b, to = sign === 1 ? b : a;
        const length = distance(from, to);
        const direction = { x: (to.x - from.x) / length, z: (to.z - from.z) / length };
        const normal = { x: -direction.z, z: direction.x };
        const link = {
          id: `${road.id}:${sign}:${from.id}>${to.id}`, road, sign, from, to,
          length, direction, normal, offset: road.laneOffsetM ?? 0,
          heading: heading(direction), turnCache: new Map(),
        };
        links.push(link); from.outgoing.push(link); to.incoming.push(link);
      }
    }
  }
  const graph = { nodes, links };
  if (cached.shapes.size >= 8) cached.shapes.clear();
  cached.shapes.set(shapeKey, graph);
  return graph;
}

function laneAt(link, along) {
  return shift(shift(link.from, link.direction, along), link.normal, link.offset);
}

function append(path, point) {
  const from = path.at(-1);
  if (!from) { path.push({ x: point.x, z: point.z }); return; }
  const length = distance(from, point);
  if (length < 1e-8) return;
  const count = Math.ceil(length / SAMPLE_M);
  for (let i = 1; i <= count; i++) path.push({
    x: from.x + (point.x - from.x) * i / count,
    z: from.z + (point.z - from.z) * i / count,
  });
}

function turnBetween(incoming, outgoing) {
  const bend = angleDelta(outgoing.heading, incoming.heading);
  if (Math.abs(bend) > Math.PI * 0.75) return null;
  if (Math.abs(bend) < 0.01) {
    if (incoming.road.id !== outgoing.road.id) return null;
    const point = laneAt(incoming, incoming.length);
    return { start: point, end: point, points: [point], bend, inset: 0, outset: 0 };
  }
  const inLane = laneAt(incoming, incoming.length), outLane = laneAt(outgoing, 0);
  const intersection = incoming.road.axis === "z"
    ? { x: inLane.x, z: outLane.z } : { x: outLane.x, z: inLane.z };
  const start = shift(intersection, incoming.direction, -RADIUS_M);
  const end = shift(intersection, outgoing.direction, RADIUS_M);
  const center = shift(start, outgoing.direction, RADIUS_M);
  const first = Math.atan2(start.z - center.z, start.x - center.x);
  const last = Math.atan2(end.z - center.z, end.x - center.x);
  const arc = angleDelta(last, first);
  const points = [];
  const steps = Math.ceil(Math.abs(arc) * RADIUS_M / SAMPLE_M);
  // The unchanged rear-axle follower otherwise swings the body outside the exit.
  const inside = -Math.sign(bend) * EXIT_COMPENSATION_M;
  for (let i = 0; i <= steps; i++) {
    const a = first + arc * i / steps;
    const t = i / steps, correction = inside * t * t * (3 - 2 * t);
    points.push({ x: center.x + Math.cos(a) * RADIUS_M + outgoing.normal.x * correction,
      z: center.z + Math.sin(a) * RADIUS_M + outgoing.normal.z * correction,
      heading: incoming.heading + bend * i / steps });
  }
  return {
    start, end: shift(end, outgoing.normal, inside), points, bend,
    recovery: shift(end, outgoing.direction, RECOVERY_M),
    inset: dot({ x: inLane.x - start.x, z: inLane.z - start.z }, incoming.direction),
    outset: dot({ x: end.x - outLane.x, z: end.z - outLane.z }, outgoing.direction),
  };
}

function clearPose(district, shape, point, yaw) {
  const pose = { ...shape, ...point, heading: yaw };
  if (district.metro) {
    const cached = geometryCache.get(district);
    if (cached && !cached.staticIndex) {
      cached.staticIndex = new SpatialIndex(district.statics);
      cached.staticReach = district.statics.reduce((max, body) =>
        Math.max(max, Math.hypot(body.width ?? 0, body.length ?? 0) / 2), 0);
    }
    if (cached) {
      return bodyOnRoad(pose, district.roads, .12) &&
        !cached.staticIndex.near(pose, cached.staticReach + Math.hypot(pose.width, pose.length) / 2 + .3)
          .some(other => overlaps(pose, other, .12));
    }
  }
  return bodyOnRoad(pose, district.roads, 0.12)
    && !district.statics.some((other) => overlaps(pose, other, 0.12));
}

function clearPath(district, body, path) {
  for (let i = 1; i < path.length; i++) {
    const yaw = Math.atan2(path[i].x - path[i - 1].x, path[i].z - path[i - 1].z);
    if (!clearPose(district, body, path[i], yaw)) return false;
  }
  return true;
}

function allowedTurn(district, body, incoming, outgoing) {
  if (incoming.turnCache.has(outgoing.id)) return incoming.turnCache.get(outgoing.id);
  const turn = turnBetween(incoming, outgoing);
  const guide = [];
  if (turn) {
    append(guide, turn.start);
    for (const point of turn.points) append(guide, point);
    append(guide, turn.end);
  }
  const valid = turn && turn.inset + 2.2 <= incoming.length && turn.outset + 2.2 <= outgoing.length
    && turn.points.every((p) => clearPose(district, body, p, p.heading ?? incoming.heading))
    && clearPath(district, body, guide);
  if (valid) Object.assign(turn, { guide, bridges: new Map(), tails: new Map() });
  incoming.turnCache.set(outgoing.id, valid ? turn : null);
  return valid ? turn : null;
}

function attachments(district, graph, pose, body, isGoal) {
  if (![pose.x, pose.z].every(Number.isFinite)
      || !clearPose(district, body, pose, pose.heading ?? body.heading ?? 0)) return [];
  const matches = [];
  for (const link of graph.links) {
    if (isGoal && pose.roadId && pose.roadId !== link.road.id) continue;
    const start = laneAt(link, 0);
    const along = dot({ x: pose.x - start.x, z: pose.z - start.z }, link.direction);
    const lateral = Math.abs(dot({ x: pose.x - start.x, z: pose.z - start.z }, link.normal));
    const attachWidth = district.metro && !isGoal
      ? Math.max(.65, link.road.width / 2 - body.width / 2) : .65;
    if (along < -0.02 || along > link.length + 0.02 || lateral > attachWidth) continue;
    if (Number.isFinite(pose.heading)
        && Math.abs(angleDelta(pose.heading, link.heading)) > (isGoal ? 0.2 : 0.65)) continue;
    matches.push({ link, along: Math.max(0, Math.min(link.length, along)), lateral });
  }
  return matches.sort((a, b) => a.lateral - b.lateral);
}

function routePath(district, body, goal, links, startAlong, endAlong) {
  const transitions = [];
  for (let i = 1; i < links.length; i++) {
    const turn = allowedTurn(district, body, links[i - 1], links[i]);
    if (!turn) return [];
    transitions.push(turn);
  }
  if (transitions.length && links[0].length - startAlong < transitions[0].inset + 0.5)
    return [];
  if (transitions.length && endAlong < transitions.at(-1).outset + 1)
    return [];
  const path = [];
  const wheelbase = body.spec?.wheelbase ?? 2.6;
  append(path, shift(body, { x: Math.sin(body.heading), z: Math.cos(body.heading) }, -wheelbase / 2));
  if (!transitions.length) {
    append(path, goal);
    return clearPath(district, body, path) ? path : [];
  }
  append(path, transitions[0].start);
  if (!clearPath(district, body, path)) return [];
  const join = (part) => {
    for (let i = 1; i < part.length; i++) path.push(part[i]);
  };
  for (let i = 0; i < transitions.length; i++) {
    const turn = transitions[i], next = transitions[i + 1];
    join(turn.guide);
    const cache = next ? turn.bridges : turn.tails;
    const cacheKey = next ? `${links[i + 1].id}>${links[i + 2].id}`
      : `${goal.x}:${goal.z}:${goal.heading}`;
    if (!cache.has(cacheKey)) {
      const part = [];
      append(part, turn.end);
      if (turn.recovery) {
        const available = next ? links[i + 1].length - next.inset - turn.outset
          : endAlong - turn.outset;
        const recoveryM = Math.min(RECOVERY_M, Math.max(0, available - 1));
        append(part, shift(laneAt(links[i + 1], turn.outset), links[i + 1].direction, recoveryM));
      }
      append(part, next ? next.start : goal);
      if (cache.size >= 64) cache.clear();
      cache.set(cacheKey, clearPath(district, body, part) ? part : null);
    }
    const part = cache.get(cacheKey);
    if (!part) return [];
    join(part);
  }
  return path.map((p) => ({ x: p.x, z: p.z }));
}

/**
 * Directed lane search with full-size turns. Support rectangles provide
 * physical turning room only; they never create a route across a courtyard.
 */
export function planDistrictRoute(district, body, goal, actors = []) {
  if (!district || !body || !goal || !Number.isFinite(body.heading)
      || !Number.isFinite(body.width) || !Number.isFinite(body.length)) return [];
  const graph = graphFor(district, body);
  const starts = attachments(district, graph, body, body, false);
  const ends = attachments(district, graph, goal, body, true);
  if (!starts.length || !ends.length) return [];
  const endByLink = new Map(ends.map((end) => [end.link.id, end]));
  const open = starts.map((start) => ({
    link: start.link, start, parent: null, cost: 0,
  }));
  const best = new Map();
  // Actors do not move during a synchronous search. The same outgoing link
  // can be scored from several arrivals, but its traffic cost is identical.
  const occupancy = new Map();
  while (open.length) {
    open.sort((a, b) => a.cost - b.cost || a.link.id.localeCompare(b.link.id));
    const current = open.shift();
    const end = endByLink.get(current.link.id);
    if (end && (current.parent || end.along > current.start.along + 0.75)) {
      const links = [];
      for (let state = current; state; state = state.parent) links.push(state.link);
      const path = routePath(district, body, goal, links.reverse(), current.start.along, end.along);
      if (path.length > 2) return path;
    }
    for (const next of current.link.to.outgoing) {
      const turn = allowedTurn(district, body, current.link, next);
      if (!turn || (!current.parent
          && current.link.length - current.start.along < turn.inset + 0.5)) continue;
      let occupied = occupancy.get(next);
      if (occupied === undefined) {
        occupied = 0;
        const midpoint = laneAt(next, next.length / 2);
        for (const actor of actors)
          if (actor.id !== body.id && actor.type !== "pedestrian" &&
              distance(actor, midpoint) < 9) occupied++;
        occupancy.set(next, occupied);
      }
      const length = current.parent ? current.link.length : current.link.length - current.start.along;
      const cost = current.cost + length + Math.abs(turn.bend) * 1.8 + occupied * 9;
      if (cost >= (best.get(next.id) ?? Infinity)) continue;
      best.set(next.id, cost);
      open.push({ link: next, start: current.start, parent: current, cost });
    }
  }
  return [];
}

/** Enumerates precisely the planner's admitted directed junction movements. */
export function districtTurnPaths(district, body) {
  const graph = graphFor(district, body), result = [];
  for (const node of graph.nodes.values())
    for (const incoming of node.incoming)
      for (const outgoing of node.outgoing) {
        const turn = allowedTurn(district, body, incoming, outgoing);
        if (!turn) continue;
        const before = Math.min(12, incoming.length - 2.2);
        const after = Math.min(12, outgoing.length - 2.2);
        const start = { ...laneAt(incoming, incoming.length - before), heading: incoming.heading };
        const goal = { ...laneAt(outgoing, after), heading: outgoing.heading, roadId: outgoing.road.id };
        const path = routePath(district, { ...body, ...start }, goal,
          [incoming, outgoing], incoming.length - before, after);
        if (path.length) result.push({
          id: `${node.id}:${incoming.road.id}:${incoming.sign}>${outgoing.road.id}:${outgoing.sign}`,
          junction: { x: node.x, z: node.z }, incomingRoadId: incoming.road.id,
          outgoingRoadId: outgoing.road.id, incomingSign: incoming.sign,
          outgoingSign: outgoing.sign, bend: turn.bend, start, goal, path,
        });
      }
  return result;
}
