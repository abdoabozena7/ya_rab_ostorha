import {
  angleDelta, bodyOnRoad, distance, isDiagonalRoad, overlaps, roadIntersection, roadPointAt,
} from "./geometry.js";
import { SpatialIndex } from "./spatial-index.js";

const RADIUS_M = 3.8;
const SAMPLE_M = 0.35;
const EXIT_COMPENSATION_M = 0.5;
const RECOVERY_M = 8;
const MAX_ROAD_GRAPHS = 32;
const roadGraphCache = new Map();
const roadTurnGeomCache = new Map();
const roadTurnStaticOkCache = new Map();
const frozenRoadsSigCache = new WeakMap();
const staticIndexCache = new WeakMap();
const f64Buf = new Float64Array(1);
const i32Buf = new Int32Array(f64Buf.buffer);
let staticVersionSeq = 0;

const STATIC_CELL_M = 24;
const STATIC_INV_CELL = 1 / STATIC_CELL_M;
const STATIC_PAD_M = 4.0;
const LINK_CELL_M = 32;
const LINK_INV_CELL = 1 / LINK_CELL_M;
const LINK_PAD_M = 12.0;

const EMPTY_STATIC_ENTRY = Object.freeze({
  index: null,
  cells: null,
  reach: 0,
  len: 0,
  first: null,
  last: null,
  sum1: 0,
  sum2: 0,
  version: 0,
});

const key = (p) => `${p.x.toFixed(5)},${p.z.toFixed(5)}`;
const dot = (a, b) => a.x * b.x + a.z * b.z;
const shift = (p, direction, amount) => ({
  x: p.x + direction.x * amount, z: p.z + direction.z * amount,
});
const heading = (v) => Math.atan2(v.x, v.z);

function mixInt(h, v) {
  return Math.imul(h ^ v, 0x01000193) >>> 0;
}

function mixStr(h, str) {
  if (!str) return mixInt(h, 0);
  let out = mixInt(h, str.length);
  for (let i = 0; i < str.length; i++) out = mixInt(out, str.charCodeAt(i));
  return out;
}

function mixNum(h, num) {
  if (num === undefined) return mixInt(h, 0x7ff00001);
  f64Buf[0] = num;
  return mixInt(mixInt(h, i32Buf[0]), i32Buf[1]);
}

function roadsSignature(roads) {
  if (!roads || !roads.length) return "0:0:0";
  if (Object.isFrozen(roads)) {
    const hit = frozenRoadsSigCache.get(roads);
    if (hit !== undefined) return hit;
  }
  let h1 = 0x811c9dc5, h2 = 0x9e3779b9;
  let allFrozen = Object.isFrozen(roads);
  const len = roads.length;
  for (let i = 0; i < len; i++) {
    const r = roads[i];
    if (allFrozen && (!r || !Object.isFrozen(r))) allFrozen = false;
    h1 = mixStr(h1, r.id);
    h2 = mixStr(h2, r.axis);
    h1 = mixNum(h1, r.fixed);
    h2 = mixNum(h2, r.min);
    h1 = mixNum(h1, r.max);
    h2 = mixNum(h2, r.x1);
    h1 = mixNum(h1, r.z1);
    h2 = mixNum(h2, r.x2);
    h1 = mixNum(h1, r.z2);
    h2 = mixNum(h2, r.width);
    h1 = mixNum(h1, r.flow ?? 0);
    h2 = mixNum(h2, r.laneOffsetM ?? 0);
    const flags = (r.parkingBay ? 1 : 0) | (r.supportApron ? 2 : 0);
    h1 = mixInt(h1, flags);
    h2 = mixInt(h2, flags ^ i);
  }
  const sig = `${len}:${h1}:${h2}`;
  if (allFrozen) frozenRoadsSigCache.set(roads, sig);
  return sig;
}

function buildStaticEntry(statics, sum1, sum2) {
  const len = statics.length;
  let reach = 0;
  const cells = new Map();
  for (let i = 0; i < len; i++) {
    const b = statics[i];
    let halfX, halfZ, r;
    if (b.type === "pedestrian") {
      r = halfX = halfZ = b.radius ?? 0;
    } else {
      const w = b.width ?? (b.radius ?? 0) * 2;
      const l = b.length ?? (b.radius ?? 0) * 2;
      const c = Math.abs(Math.cos(b.heading ?? 0));
      const s = Math.abs(Math.sin(b.heading ?? 0));
      halfX = (w * c + l * s) * 0.5;
      halfZ = (w * s + l * c) * 0.5;
      r = Math.max(b.radius ?? 0, Math.hypot(w, l) * 0.5);
    }
    if (r > reach) reach = r;
    const cx0 = Math.floor((b.x - halfX - STATIC_PAD_M) * STATIC_INV_CELL);
    const cx1 = Math.floor((b.x + halfX + STATIC_PAD_M) * STATIC_INV_CELL);
    const cz0 = Math.floor((b.z - halfZ - STATIC_PAD_M) * STATIC_INV_CELL);
    const cz1 = Math.floor((b.z + halfZ + STATIC_PAD_M) * STATIC_INV_CELL);
    for (let cx = cx0; cx <= cx1; cx++) {
      const hi = cx << 16;
      for (let cz = cz0; cz <= cz1; cz++) {
        const k = hi ^ (cz & 0xffff);
        let bucket = cells.get(k);
        if (bucket) bucket.push(b);
        else cells.set(k, [b]);
      }
    }
  }
  const cellSize = Math.max(12, Math.min(40, Math.ceil(reach) || 12));
  const entry = {
    index: new SpatialIndex(statics, cellSize),
    cells,
    reach,
    len,
    first: statics[0],
    last: statics[len - 1],
    sum1,
    sum2,
    version: ++staticVersionSeq,
  };
  staticIndexCache.set(statics, entry);
  return entry;
}

function verifyStaticEntry(statics) {
  if (!statics || !statics.length) return EMPTY_STATIC_ENTRY;
  const len = statics.length;
  let sum1 = len, sum2 = 0;
  for (let i = 0; i < len; i++) {
    const s = statics[i];
    const v = (s.x || 0) * 1.000003 + (s.z || 0) * 2.000007 +
      (s.width || 0) * 3.000013 + (s.length || 0) * 5.000017 +
      (s.heading || 0) * 7.000019 + (s.radius || 0) * 11.000023;
    sum1 += v;
    sum2 += v * (i + 1);
  }
  const cached = staticIndexCache.get(statics);
  if (cached &&
      cached.len === len &&
      cached.first === statics[0] &&
      cached.last === statics[len - 1] &&
      cached.sum1 === sum1 &&
      cached.sum2 === sum2) {
    return cached;
  }
  return buildStaticEntry(statics, sum1, sum2);
}

function lookupStaticEntryFast(statics) {
  if (!statics || !statics.length) return EMPTY_STATIC_ENTRY;
  const len = statics.length;
  const cached = staticIndexCache.get(statics);
  if (cached &&
      cached.len === len &&
      cached.first === statics[0] &&
      cached.last === statics[len - 1]) {
    return cached;
  }
  return verifyStaticEntry(statics);
}

function graphFor(district, body) {
  const signature = roadsSignature(district.drivingRoads);
  let cached = roadGraphCache.get(signature);
  if (!cached) {
    if (roadGraphCache.size >= MAX_ROAD_GRAPHS) {
      roadGraphCache.delete(roadGraphCache.keys().next().value);
    }
    cached = { shapes: new Map() };
    roadGraphCache.set(signature, cached);
  }
  const staticEntry = verifyStaticEntry(district.statics);
  const roadsSig = district.roads === district.drivingRoads
    ? signature
    : roadsSignature(district.roads);
  const shapeKey = `${body.length}:${body.width}:${staticEntry.version}:${roadsSig}`;
  let graph = cached.shapes.get(shapeKey);
  if (graph) {
    cached.shapes.delete(shapeKey);
    cached.shapes.set(shapeKey, graph);
    return graph;
  }
  const roads = district.drivingRoads.filter((r) =>
    !r.parkingBay && !r.supportApron && r.width >= body.width + 0.24);
  const nodes = new Map(), links = [];
  const put = (p) => {
    const id = key(p);
    if (nodes.has(id)) return nodes.get(id);
    for (const existing of nodes.values()) {
      if (distance(existing, p) <= 0.35) return existing;
    }
    const node = { ...p, id, incoming: [], outgoing: [] };
    nodes.set(id, node);
    return node;
  };
  for (const road of roads) {
    const cuts = new Set([road.min, road.max]);
    for (const other of roads) {
      if (other === road) continue;
      const hit = roadIntersection(road, other, 0.5);
      if (!hit) continue;
      cuts.add(Math.max(road.min, Math.min(road.max, hit.alongA)));
    }
    const along = [...cuts]
      .sort((a, b) => a - b)
      .filter((v, i, arr) => i === 0 || v - arr[i - 1] > 0.35);
    const at = (value) => put(roadPointAt(road, value, 0));
    for (let i = 1; i < along.length; i++) {
      const a = at(along[i - 1]), b = at(along[i]);
      if (a === b) continue;
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
  const linkCells = new Map();
  for (let i = 0; i < links.length; i++) {
    const lk = links[i];
    const halfW = lk.road.width * 0.5 + Math.abs(lk.offset) + LINK_PAD_M;
    const minX = Math.min(lk.from.x, lk.to.x) - halfW;
    const maxX = Math.max(lk.from.x, lk.to.x) + halfW;
    const minZ = Math.min(lk.from.z, lk.to.z) - halfW;
    const maxZ = Math.max(lk.from.z, lk.to.z) + halfW;
    const cx0 = Math.floor(minX * LINK_INV_CELL);
    const cx1 = Math.floor(maxX * LINK_INV_CELL);
    const cz0 = Math.floor(minZ * LINK_INV_CELL);
    const cz1 = Math.floor(maxZ * LINK_INV_CELL);
    for (let cx = cx0; cx <= cx1; cx++) {
      const hi = cx << 16;
      for (let cz = cz0; cz <= cz1; cz++) {
        const k = hi ^ (cz & 0xffff);
        let bucket = linkCells.get(k);
        if (bucket) bucket.push(lk);
        else linkCells.set(k, [lk]);
      }
    }
  }
  graph = { nodes, links, linkCells, singleSegments: new Map(), staticVer: staticEntry.version, staticEntry, roadsSig };
  if (cached.shapes.size >= 12) cached.shapes.delete(cached.shapes.keys().next().value);
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
  const diagTurn = isDiagonalRoad(incoming.road) || isDiagonalRoad(outgoing.road);
  const bend = angleDelta(outgoing.heading, incoming.heading);
  if (Math.abs(bend) > Math.PI * (diagTurn ? 0.78 : 0.75)) return null;
  if (Math.abs(bend) < 0.04) {
    if (incoming.road.id !== outgoing.road.id && Math.abs(bend) >= 0.01) return null;
    const inEnd = laneAt(incoming, incoming.length), outStart = laneAt(outgoing, 0);
    if (distance(inEnd, outStart) <= 0.05) {
      return { start: inEnd, end: inEnd, points: [inEnd], bend, inset: 0, outset: 0 };
    }
    const bridge = Math.min(2.5, incoming.length * 0.25, outgoing.length * 0.25);
    const start = laneAt(incoming, incoming.length - bridge);
    const end = laneAt(outgoing, bridge);
    return { start, end, points: [start, end], bend, inset: bridge, outset: bridge };
  }
  const inLane = laneAt(incoming, incoming.length), outLane = laneAt(outgoing, 0);
  const orthogonalExact = !diagTurn && incoming.road.axis !== outgoing.road.axis &&
    Math.abs(Math.abs(bend) - Math.PI / 2) < 1e-7;
  let intersection, start, end, center;
  if (orthogonalExact) {
    intersection = incoming.road.axis === "z"
      ? { x: inLane.x, z: outLane.z } : { x: outLane.x, z: inLane.z };
    start = shift(intersection, incoming.direction, -RADIUS_M);
    end = shift(intersection, outgoing.direction, RADIUS_M);
    center = shift(start, outgoing.direction, RADIUS_M);
  } else {
    const det = -incoming.direction.x * outgoing.direction.z +
      incoming.direction.z * outgoing.direction.x;
    if (Math.abs(det) < 1e-6) return null;
    const dx = outLane.x - inLane.x, dz = outLane.z - inLane.z;
    const t = (-outgoing.direction.z * dx + outgoing.direction.x * dz) / det;
    intersection = shift(inLane, incoming.direction, t);
    const tangentDist = RADIUS_M * Math.tan(Math.abs(bend) / 2);
    start = shift(intersection, incoming.direction, -tangentDist);
    end = shift(intersection, outgoing.direction, tangentDist);
    center = shift(start, incoming.normal, -Math.sign(bend) * RADIUS_M);
  }
  const first = Math.atan2(start.z - center.z, start.x - center.x);
  const last = Math.atan2(end.z - center.z, end.x - center.x);
  const arc = angleDelta(last, first);
  const points = [];
  const steps = Math.max(1, Math.ceil(Math.abs(arc) * RADIUS_M / SAMPLE_M));
  // The unchanged rear-axle follower otherwise swings the body outside the exit.
  const insideScale = orthogonalExact ? 1 : Math.min(1, Math.abs(bend) / (Math.PI / 2));
  const inside = -Math.sign(bend) * EXIT_COMPENSATION_M * insideScale;
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

const _navPoseScratch = {
  type: "vehicle",
  x: 0,
  z: 0,
  heading: 0,
  width: 0,
  length: 0,
  radius: 0,
};

function clearStaticsOnly(entry, shape, point, yaw) {
  if (!entry || !entry.len) return true;
  _navPoseScratch.type = shape.type;
  _navPoseScratch.x = point.x;
  _navPoseScratch.z = point.z;
  _navPoseScratch.heading = yaw;
  _navPoseScratch.width = shape.width;
  _navPoseScratch.length = shape.length;
  _navPoseScratch.radius = shape.radius;
  const poseReach = shape.type === "pedestrian"
    ? (shape.radius ?? 0)
    : Math.hypot(shape.width ?? 0, shape.length ?? 0) * 0.5;
  if (poseReach + 0.12 <= STATIC_PAD_M) {
    const k = (Math.floor(point.x * STATIC_INV_CELL) << 16) ^ (Math.floor(point.z * STATIC_INV_CELL) & 0xffff);
    const bucket = entry.cells.get(k);
    if (!bucket) return true;
    for (let i = 0; i < bucket.length; i++) {
      if (overlaps(_navPoseScratch, bucket[i], 0.12)) return false;
    }
    return true;
  }
  const near = entry.index.near(_navPoseScratch, entry.reach + poseReach + 0.3);
  for (let i = 0; i < near.length; i++) {
    if (overlaps(_navPoseScratch, near[i], 0.12)) return false;
  }
  return true;
}

function clearRoadOnly(roads, shape, point, yaw) {
  _navPoseScratch.type = shape.type;
  _navPoseScratch.x = point.x;
  _navPoseScratch.z = point.z;
  _navPoseScratch.heading = yaw;
  _navPoseScratch.width = shape.width;
  _navPoseScratch.length = shape.length;
  _navPoseScratch.radius = shape.radius;
  return bodyOnRoad(_navPoseScratch, roads, 0.12);
}

function clearPose(district, shape, point, yaw) {
  if (!clearRoadOnly(district.roads, shape, point, yaw)) return false;
  const statics = district.statics;
  if (!statics || !statics.length) return true;
  return clearStaticsOnly(lookupStaticEntryFast(statics), shape, point, yaw);
}

function clearPath(district, body, path) {
  const entry = district.statics?.length ? lookupStaticEntryFast(district.statics) : null;
  for (let i = 1; i < path.length; i++) {
    const yaw = Math.atan2(path[i].x - path[i - 1].x, path[i].z - path[i - 1].z);
    if (!clearRoadOnly(district.roads, body, path[i], yaw)) return false;
    if (entry && !clearStaticsOnly(entry, body, path[i], yaw)) return false;
  }
  return true;
}

function allowedTurn(district, body, incoming, outgoing, roadsSigHint = null, staticEntryHint = null) {
  if (incoming.turnCache.has(outgoing.id)) return incoming.turnCache.get(outgoing.id);
  const rSig = roadsSigHint ?? roadsSignature(district.roads);
  const geomKey = `${rSig}:${body.type ?? "v"}:${body.length}:${body.width}:${body.radius ?? 0}:${incoming.id}->${outgoing.id}`;
  let baseGeom = roadTurnGeomCache.get(geomKey);
  if (baseGeom === undefined) {
    const turn = turnBetween(incoming, outgoing);
    const guide = [];
    let guideYaws = null;
    let roadValid = false;
    if (turn && turn.inset + 2.2 <= incoming.length && turn.outset + 2.2 <= outgoing.length) {
      append(guide, turn.start);
      for (const point of turn.points) append(guide, point);
      append(guide, turn.end);
      roadValid = turn.points.every((p) => clearRoadOnly(district.roads, body, p, p.heading ?? incoming.heading));
      if (roadValid) {
        guideYaws = new Float64Array(guide.length);
        for (let i = 1; i < guide.length; i++) {
          const yaw = Math.atan2(guide[i].x - guide[i - 1].x, guide[i].z - guide[i - 1].z);
          guideYaws[i] = yaw;
          if (!clearRoadOnly(district.roads, body, guide[i], yaw)) {
            roadValid = false;
            break;
          }
        }
      }
    }
    baseGeom = roadValid ? { turn, guide, guideYaws } : null;
    if (roadTurnGeomCache.size >= 4096) {
      roadTurnGeomCache.delete(roadTurnGeomCache.keys().next().value);
    }
    roadTurnGeomCache.set(geomKey, baseGeom);
  }
  if (!baseGeom) {
    incoming.turnCache.set(outgoing.id, null);
    return null;
  }
  const entry = staticEntryHint ?? (district.statics?.length ? lookupStaticEntryFast(district.statics) : null);
  if (entry && entry.len > 0) {
    const stKey = `${geomKey}#${entry.version}`;
    let stOk = roadTurnStaticOkCache.get(stKey);
    if (stOk === undefined) {
      stOk = true;
      const { turn, guide, guideYaws } = baseGeom;
      for (let i = 0; i < turn.points.length; i++) {
        const p = turn.points[i];
        if (!clearStaticsOnly(entry, body, p, p.heading ?? incoming.heading)) {
          stOk = false;
          break;
        }
      }
      if (stOk) {
        for (let i = 1; i < guide.length; i++) {
          if (!clearStaticsOnly(entry, body, guide[i], guideYaws[i])) {
            stOk = false;
            break;
          }
        }
      }
      if (roadTurnStaticOkCache.size >= 8192) {
        roadTurnStaticOkCache.delete(roadTurnStaticOkCache.keys().next().value);
      }
      roadTurnStaticOkCache.set(stKey, stOk);
    }
    if (!stOk) {
      incoming.turnCache.set(outgoing.id, null);
      return null;
    }
  }
  const resolvedTurn = {
    ...baseGeom.turn,
    guide: baseGeom.guide,
    heads: new Map(),
    bridges: new Map(),
    tails: new Map(),
  };
  incoming.turnCache.set(outgoing.id, resolvedTurn);
  return resolvedTurn;
}

function attachments(district, graph, pose, body, isGoal) {
  if (![pose.x, pose.z].every(Number.isFinite)
      || !clearPose(district, body, pose, pose.heading ?? body.heading ?? 0)) return [];
  const k = (Math.floor(pose.x * LINK_INV_CELL) << 16) ^ (Math.floor(pose.z * LINK_INV_CELL) & 0xffff);
  const candidates = graph.links.length > 16 ? (graph.linkCells.get(k) ?? []) : graph.links;
  const matches = [];
  for (let i = 0; i < candidates.length; i++) {
    const link = candidates[i];
    if (isGoal && pose.roadId && pose.roadId !== link.road.id) continue;
    const start = laneAt(link, 0);
    const dx = pose.x - start.x, dz = pose.z - start.z;
    const along = dx * link.direction.x + dz * link.direction.z;
    const lateral = Math.abs(dx * link.normal.x + dz * link.normal.z);
    const attachWidth = district.metro && !isGoal
      ? Math.max(.65, link.road.width / 2 - body.width / 2) : .65;
    if (along < -0.02 || along > link.length + 0.02 || lateral > attachWidth) continue;
    if (Number.isFinite(pose.heading)
        && Math.abs(angleDelta(pose.heading, link.heading)) > (isGoal ? 0.2 : 0.65)) continue;
    matches.push({ link, along: Math.max(0, Math.min(link.length, along)), lateral });
  }
  return matches.sort((a, b) => a.lateral - b.lateral);
}

function routePath(district, graph, body, goal, links, startAlong, endAlong) {
  const transitions = [];
  for (let i = 1; i < links.length; i++) {
    const turn = allowedTurn(district, body, links[i - 1], links[i], graph.roadsSig, graph.staticEntry);
    if (!turn) return [];
    transitions.push(turn);
  }
  if (transitions.length && links[0].length - startAlong < transitions[0].inset + 0.5)
    return [];
  if (transitions.length && endAlong < transitions.at(-1).outset + 1)
    return [];
  const wheelbase = body.spec?.wheelbase ?? 2.6;
  const rearStart = shift(body, { x: Math.sin(body.heading), z: Math.cos(body.heading) }, -wheelbase / 2);
  if (!transitions.length) {
    const singleKey = `${links[0].id}:${rearStart.x}:${rearStart.z}>${goal.x}:${goal.z}`;
    let single = graph.singleSegments.get(singleKey);
    if (single === undefined) {
      const raw = [];
      append(raw, rearStart);
      append(raw, goal);
      single = clearPath(district, body, raw) ? raw : null;
      if (graph.singleSegments.size >= 64) graph.singleSegments.clear();
      graph.singleSegments.set(singleKey, single);
    }
    return single ? single.map((p) => ({ x: p.x, z: p.z })) : [];
  }

  const firstTurn = transitions[0];
  const headKey = `${rearStart.x}:${rearStart.z}`;
  let headPart = firstTurn.heads.get(headKey);
  if (headPart === undefined) {
    const raw = [];
    append(raw, rearStart);
    append(raw, firstTurn.start);
    headPart = clearPath(district, body, raw) ? raw : null;
    if (firstTurn.heads.size >= 64) firstTurn.heads.clear();
    firstTurn.heads.set(headKey, headPart);
  }
  if (!headPart) return [];

  const segments = [headPart];
  let totalPoints = headPart.length;
  for (let i = 0; i < transitions.length; i++) {
    const turn = transitions[i], next = transitions[i + 1];
    segments.push(turn.guide);
    totalPoints += turn.guide.length - 1;
    const cache = next ? turn.bridges : turn.tails;
    const cacheKey = next ? `${links[i + 1].id}>${links[i + 2].id}`
      : `${goal.x}:${goal.z}:${goal.heading}`;
    let part = cache.get(cacheKey);
    if (part === undefined) {
      const candidate = [];
      append(candidate, turn.end);
      if (turn.recovery) {
        const available = next ? links[i + 1].length - next.inset - turn.outset
          : endAlong - turn.outset;
        const recoveryM = Math.min(RECOVERY_M, Math.max(0, available - 1));
        append(candidate, shift(laneAt(links[i + 1], turn.outset), links[i + 1].direction, recoveryM));
      }
      append(candidate, next ? next.start : goal);
      part = clearPath(district, body, candidate) ? candidate : null;
      if (cache.size >= 64) cache.clear();
      cache.set(cacheKey, part);
    }
    if (!part) return [];
    segments.push(part);
    totalPoints += part.length - 1;
  }

  const out = new Array(totalPoints);
  const firstPt = headPart[0];
  out[0] = { x: firstPt.x, z: firstPt.z };
  let writeIdx = 1;
  for (let sIdx = 0; sIdx < segments.length; sIdx++) {
    const seg = segments[sIdx];
    for (let i = 1; i < seg.length; i++) {
      const p = seg[i];
      out[writeIdx++] = { x: p.x, z: p.z };
    }
  }
  return out;
}

function stateLess(a, b) {
  if (a.cost !== b.cost) return a.cost < b.cost;
  return a.link.id < b.link.id;
}

function heapPush(heap, item) {
  let idx = heap.length;
  heap.push(item);
  while (idx > 0) {
    const parent = (idx - 1) >> 1;
    if (!stateLess(item, heap[parent])) break;
    heap[idx] = heap[parent];
    idx = parent;
  }
  heap[idx] = item;
}

function heapPop(heap) {
  const top = heap[0];
  const last = heap.pop();
  const n = heap.length;
  if (n > 0) {
    let idx = 0;
    while (true) {
      const left = (idx << 1) + 1;
      if (left >= n) break;
      const right = left + 1;
      const bestChild = right < n && stateLess(heap[right], heap[left]) ? right : left;
      if (!stateLess(heap[bestChild], last)) break;
      heap[idx] = heap[bestChild];
      idx = bestChild;
    }
    heap[idx] = last;
  }
  return top;
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
  const open = [];
  for (let i = 0; i < starts.length; i++) {
    heapPush(open, { link: starts[i].link, start: starts[i], parent: null, cost: 0 });
  }
  const best = new Map();
  // Actors do not move during a synchronous search. The same outgoing link
  // can be scored from several arrivals, but its traffic cost is identical.
  const occupancy = new Map();
  const vehicles = [];
  for (let aIdx = 0; aIdx < actors.length; aIdx++) {
    const actor = actors[aIdx];
    if (actor.type !== "pedestrian" && actor.id !== body.id) vehicles.push(actor);
  }
  while (open.length) {
    const current = heapPop(open);
    if (current.parent && current.cost > (best.get(current.link.id) ?? Infinity)) continue;
    const end = endByLink.get(current.link.id);
    if (end && (current.parent || end.along > current.start.along + 0.75)) {
      const links = [];
      for (let state = current; state; state = state.parent) links.push(state.link);
      const path = routePath(district, graph, body, goal, links.reverse(), current.start.along, end.along);
      if (path.length > 2) return path;
    }
    for (const next of current.link.to.outgoing) {
      const turn = allowedTurn(district, body, current.link, next, graph.roadsSig, graph.staticEntry);
      if (!turn || (!current.parent
          && current.link.length - current.start.along < turn.inset + 0.5)) continue;
      let occupied = occupancy.get(next);
      if (occupied === undefined) {
        occupied = 0;
        const midpoint = laneAt(next, next.length / 2);
        const mx = midpoint.x, mz = midpoint.z;
        for (let vIdx = 0; vIdx < vehicles.length; vIdx++) {
          const actor = vehicles[vIdx];
          if (Math.abs(actor.x - mx) < 9 && Math.abs(actor.z - mz) < 9 &&
              distance(actor, midpoint) < 9) occupied++;
        }
        occupancy.set(next, occupied);
      }
      const length = current.parent ? current.link.length : current.link.length - current.start.along;
      const cost = current.cost + length + Math.abs(turn.bend) * 1.8 + occupied * 9;
      if (cost >= (best.get(next.id) ?? Infinity)) continue;
      best.set(next.id, cost);
      heapPush(open, { link: next, start: current.start, parent: current, cost });
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
        const path = routePath(district, graph, { ...body, ...start }, goal,
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
