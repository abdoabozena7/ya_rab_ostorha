import { clamp, VEHICLE } from "../core/config.js";
import { angleDelta } from "../core/geometry.js";
import { requireDispatchScan } from "./pursuit-shield.js";

const motionFields = [
  "speed", "steer", "slip", "yaw",
  "frontRange", "crossingRange", "rearRange", "rearClosure", "rearTtc",
];
const routeFields = [
  "crossTrack", "alignment", "nearRight", "nearForward",
  "turnNear", "turnFar", "curveRange", "curveLoad", "remaining",
];
export const PAKO_CURVE_OBSERVATION = Object.freeze({
  version: "pako-connected-curve-v1", length: motionFields.length + routeFields.length, researchOnly: true,
  researchAdapter: "connected curve",
  source: "public pavement route, ego odometry and first-return scan",
  navigation: Object.freeze({ offset: motionFields.length, fields: Object.freeze(routeFields) }),
  fields: Object.freeze([...motionFields, ...routeFields]),
});
const endFields = ["finishM", "stoppingReserveM"];
export const PAKO_ENDPOINT_OBSERVATION = Object.freeze({
  ...PAKO_CURVE_OBSERVATION,
  version: "pako-connected-endpoint-v1",
  researchAdapter: "connected endpoint",
  length: PAKO_CURVE_OBSERVATION.length + endFields.length,
  fields: Object.freeze([...PAKO_CURVE_OBSERVATION.fields, ...endFields]),
  navigation: Object.freeze({ offset: motionFields.length, fields: Object.freeze([...routeFields, ...endFields]) }),
});

const signed = (value, scale) => clamp(value / scale, -1, 1);
const unit = (value, scale) => clamp(value / scale, 0, 1);
const geometry = new WeakMap();

function routeGeometry(path) {
  if (!Array.isArray(path) || path.length < 3) throw new TypeError("A connected curve needs a public route");
  const saved = geometry.get(path);
  if (saved) return saved;
  const segments = [], stations = [0];
  for (let i = 1; i < path.length; i++) {
    const from = path[i - 1], to = path[i];
    const dx = to.x - from.x, dz = to.z - from.z, length = Math.hypot(dx, dz);
    if (!Number.isFinite(length) || length <= 1e-6)
      throw new RangeError("A connected curve requires finite, distinct route points");
    segments.push({ x: from.x, z: from.z, dx, dz, length, heading: Math.atan2(dx, dz) });
    stations.push(stations.at(-1) + length);
  }
  const graph = { segments, stations, length: stations.at(-1) };
  if (Object.isFrozen(path) && path.every(Object.isFrozen)) geometry.set(path, graph);
  return graph;
}

function at(graph, arc, hint) {
  const amount = Math.min(arc, graph.length);
  const { segments, stations } = graph;
  while (hint < segments.length - 1 && stations[hint + 1] < amount) hint++;
  const { x, z, heading, dx, dz, length } = segments[hint];
  const fraction = (amount - stations[hint]) / length;
  return { x: x + dx * fraction, z: z + dz * fraction, heading };
}

function measureRoute(world, path, endpoint) {
  const scan = requireDispatchScan(world);
  const { player: ego } = world;
  const graph = routeGeometry(path), { segments, stations } = graph;
  const sx = Math.sin(ego.heading), sz = Math.cos(ego.heading), axle = ego.spec.wheelbase / 2;
  const x = ego.x - sx * axle, z = ego.z - sz * axle;
  if (![x, z, ego.speed, ego.steer, ego.gtaSlipMps, ego.gtaYawRate].every(Number.isFinite) ||
      !Number.isFinite(ego.spec.maxSteer) || ego.spec.maxSteer <= 0)
    throw new RangeError("A connected curve needs finite vehicle odometry");
  let best = Infinity, k, along, lateral;
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const { dx, dz, length } = segment;
    const ox = x - segment.x, oz = z - segment.z;
    const where = clamp((ox * dx + oz * dz) / (length * length), 0, 1);
    const ex = ox - where * dx, ez = oz - where * dz;
    const score = ex * ex + ez * ez + .8 * (1 - Math.cos(ego.heading - segment.heading));
    if (score >= best) continue;
    best = score;
    k = i;
    along = stations[i] + where * length;
    lateral = (-ex * dz + ez * dx) / length;
  }
  const near = at(graph, along + 2.2 + Math.max(0, ego.speed) * .16, k);
  const mid = at(graph, along + 5, k), far = at(graph, along + 12, k);
  const base = segments[k].heading;
  const rx = near.x - x, rz = near.z - z;
  let first = 18, peak = 0;
  for (let i = k + 1; i < segments.length && stations[i] - along < 18; i++) {
    const bend = Math.abs(angleDelta(segments[i].heading, segments[i - 1].heading));
    const curvature = bend / ((segments[i].length + segments[i - 1].length) / 2);
    if (curvature < .065) continue;
    first = Math.min(first, stations[i] - along);
    peak = Math.max(peak, Math.min(.32, curvature));
  }
  const rear = scan.tracks.find(track => track.kind === "police" && track.ageS === 0 &&
    track.forwardM < 0 && Math.abs(track.rightM) < 3.5);
  const crossing = scan.tracks.find(track => track.kind === "pedestrian" && track.ageS === 0 &&
    track.forwardM > 0 && Math.abs(track.rightM) < 5);
  const rayRange = indices => Math.min(...indices.map(i => scan.rays[i].rangeM));
  const obs = Float32Array.of(
    signed(ego.speed, 24), signed(ego.steer, ego.spec.maxSteer),
    signed(ego.gtaSlipMps, 4), signed(ego.gtaYawRate, 3),
    unit(rayRange([71, 0, 1]), 28), crossing ? unit(Math.hypot(crossing.rightM, crossing.forwardM), 24) : 1,
    unit(rayRange([35, 36, 37]), 32), rear?.motionKnown ? signed(rear.forwardMps, 14) : 0,
    rear?.ttcS == null ? 1 : unit(rear.ttcS, 6),
    signed(lateral, 3), signed(angleDelta(base, ego.heading), 1.5),
    signed(rx * sz - rz * sx, 5), signed(rx * sx + rz * sz, 8),
    signed(angleDelta(mid.heading, base), Math.PI / 2), signed(angleDelta(far.heading, base), Math.PI / 2),
    unit(first, 18), unit(ego.speed ** 2 * peak, 28), unit(graph.length - along, 45),
  );
  if (!endpoint) return obs;
  const final = segments.at(-1), end = path.at(-1);
  const past = k === segments.length - 1 && along >= graph.length - 1e-7 ?
    Math.max(0, ((x - end.x) * final.dx + (z - end.z) * final.dz) / final.length) : 0;
  const finishM = graph.length - along - past - axle;
  const braking = ego.spec.braking ?? VEHICLE.braking;
  if (!Number.isFinite(braking) || braking <= 0) throw new RangeError("A connected endpoint needs finite braking capacity");
  const speed = Math.max(0, ego.speed);
  const stopM = .2 * speed + speed ** 2 / (2 * .72 * braking);
  return Float32Array.of(...obs, signed(finishM, 40), signed(finishM - stopM, 30));
}

export const measureConnectedCurve = (world, path) => measureRoute(world, path, false);
export const measureConnectedEndpoint = (world, path) => measureRoute(world, path, true);
