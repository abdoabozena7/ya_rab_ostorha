import { STEP } from "../core/config.js";
import { getVehicleMounts, mountToWorld } from "../core/vehicle-spec.js";

export const PURSUIT_SCAN_RAYS = 72;
export const PURSUIT_SCAN_RANGE_M = 48;
export const PURSUIT_SCAN_TICKS = 6;
export const PURSUIT_TRACK_TTL_S = .5;

const RAY_STEP = 2 * Math.PI / PURSUIT_SCAN_RAYS;
const PED_RAYS_PER_PRIMARY = 10;
const PED_RAYS = PURSUIT_SCAN_RAYS * PED_RAYS_PER_PRIMARY;
const PED_RAY_STEP = RAY_STEP / PED_RAYS_PER_PRIMARY;
const TRACK_TTL_TICKS = Math.round(PURSUIT_TRACK_TTL_S / STEP);
const MAX_TTC_S = 6;
const EPS = 1e-9;
const zeroSmall = n => Math.abs(n) < EPS ? 0 : n;
const direction = angle => ({
  right: zeroSmall(Math.sin(angle)),
  forward: zeroSmall(Math.cos(angle)),
});
const beams = Array.from({ length: PURSUIT_SCAN_RAYS }, (_, i) => direction(i * RAY_STEP));
const pedBeams = Array.from({ length: PED_RAYS }, (_, i) =>
  i % PED_RAYS_PER_PRIMARY ? direction(i * PED_RAY_STEP) : beams[i / PED_RAYS_PER_PRIMARY]);
const priority = { none: 0, civilian: 1, pedestrian: 2, police: 3, static: 4 };

function candidates(world, heading, origin = world.player) {
  const { player } = world, c = Math.cos(heading), s = Math.sin(heading);
  const shapes = [];
  function add(body, kind) {
    if (body === player) return;
    const dx = body.x - origin.x, dz = body.z - origin.z;
    const right = dx * c - dz * s, forward = dx * s + dz * c;
    const circle = kind === "pedestrian";
    const w = body.width / 2, l = body.length / 2;
    if (!circle && !(w > 0 && l > 0)) return;
    const radius = circle ? body.radius : Math.hypot(w, l);
    if (!Number.isFinite(radius) || !(radius > 0) ||
        !(Math.hypot(dx, dz) <= PURSUIT_SCAN_RANGE_M + radius + EPS)) return;
    if (circle) {
      shapes.push({ kind, radius, right, forward });
    } else {
      const angle = (body.heading ?? 0) - heading;
      if (!Number.isFinite(angle)) return;
      const cos = Math.cos(angle), sin = Math.sin(angle);
      shapes.push({ kind, w, l, cos, sin,
        x: -right * cos + forward * sin, z: -right * sin - forward * cos });
    }
  }
  for (const body of world.statics) add(body, "static");
  for (const body of world.actors) {
    if (body.type === "pedestrian" || body.type === "static") add(body, body.type);
    else if (body.type === "vehicle")
      add(body, body.pursuitRole === "police" ? "police" : "civilian");
  }
  return shapes;
}

function circleHit({ right, forward, radius }, r, f) {
  const cross = right * f - forward * r;
  if (Math.abs(cross) > radius + EPS) return Infinity;
  const projection = right * r + forward * f;
  const chord = Math.sqrt(Math.max(0, radius * radius - cross * cross));
  return projection + chord < 0 ? Infinity : Math.max(0, projection - chord);
}

function boxHit({ x, z, w, l, cos, sin }, r, f, far) {
  const dx = r * cos - f * sin, dz = r * sin + f * cos;
  let near = 0;
  if (Math.abs(dx) < EPS) {
    if (Math.abs(x) > w + EPS) return Infinity;
  } else {
    const a = (-w - x) / dx, b = (w - x) / dx;
    near = Math.max(near, Math.min(a, b));
    far = Math.min(far, Math.max(a, b));
    if (near > far + EPS) return Infinity;
  }
  if (Math.abs(dz) < EPS) {
    if (Math.abs(z) > l + EPS) return Infinity;
  } else {
    const a = (-l - z) / dz, b = (l - z) / dz;
    near = Math.max(near, Math.min(a, b));
    far = Math.min(far, Math.max(a, b));
  }
  return near <= far + EPS ? near : Infinity;
}

function firstReturn(shapes, { right, forward }) {
  let rangeM = PURSUIT_SCAN_RANGE_M, kind = "none";
  for (const body of shapes) {
    const hit = body.kind === "pedestrian"
      ? circleHit(body, right, forward) : boxHit(body, right, forward, rangeM);
    if (hit > PURSUIT_SCAN_RANGE_M + EPS) continue;
    const measured = Math.min(hit, PURSUIT_SCAN_RANGE_M);
    if (measured < rangeM || (measured === rangeM && priority[body.kind] > priority[kind])) {
      rangeM = measured;
      kind = body.kind;
    }
  }
  return { rangeM, kind };
}

const cornerBeams = Object.freeze(Object.fromEntries([["left-outer", -1], ["right-outer", 1]].map(([id, side]) =>
  [id, Array.from({ length: 12 }, (_, i) => {
    const angleRad = side * (i + 1) * RAY_STEP / 4;
    return { angleRad, ...direction(angleRad) };
  })])));

// Supplementary planar observation only; the primary scan and guard do not use it.
export function samplePursuitCornerRays(world) {
  const { tick, player } = world;
  const heading = player.heading ?? 0;
  if (!Number.isSafeInteger(tick) || tick < 0 || ![player.x, player.z, heading].every(Number.isFinite))
    throw new RangeError("Invalid pursuit corner sample");
  const c = Math.cos(heading), s = Math.sin(heading);
  const rays = getVehicleMounts(player).ranges.flatMap(mount => {
    const fan = cornerBeams[mount.id];
    if (!fan) return [];
    const { x, z } = mountToWorld(player, mount.position);
    const shapes = candidates(world, heading, { x, z });
    return fan.map(beam => {
      const { rangeM, kind } = firstReturn(shapes, beam);
      return Object.freeze({ mount: mount.id, angleRad: beam.angleRad, rangeM, kind, originX: x, originZ: z,
        x: x + rangeM * (beam.right * c + beam.forward * s),
        z: z + rangeM * (beam.forward * c - beam.right * s) });
    });
  });
  return Object.freeze({ tick, rays: Object.freeze(rays) });
}

function pedestrianReturns(shapes, rays) {
  let samples;
  for (const body of shapes) {
    if (body.kind !== "pedestrian") continue;
    samples ??= new Array(PED_RAYS);
    // The footprint schedules bins on a fixed grid, never an aim ray at
    // the actor center. Both primary and finer bins must win first return.
    const coverage = (body.radius + EPS) / Math.hypot(body.right, body.forward);
    const bearing = Math.atan2(body.right, body.forward);
    const half = Math.asin(Math.min(1, coverage));
    const first = coverage >= 1 ? 0 : Math.ceil((bearing - half) / PED_RAY_STEP - EPS);
    const last = coverage >= 1 ? PED_RAYS - 1 : Math.floor((bearing + half) / PED_RAY_STEP + EPS);
    for (let bin = first; bin <= last; bin++) {
      const i = (bin + PED_RAYS) % PED_RAYS;
      if (samples[i] !== undefined) continue;
      const hit = i % PED_RAYS_PER_PRIMARY
        ? firstReturn(shapes, pedBeams[i])
        : rays[i / PED_RAYS_PER_PRIMARY];
      samples[i] = hit.kind === "pedestrian" ? hit : null;
    }
  }
  return samples ?? [];
}

// Associate contiguous surface returns, not colliders. Each representative is
// an actual ray endpoint, even when a run crosses the wrap seam.
function surfaces(rays, directions, pedestrians, tick, heading) {
  const relevant = ray => ray && ray.kind !== "none" && (ray.kind === "pedestrian") === pedestrians;
  const connected = (a, b) => relevant(a) && a.kind === b?.kind && Math.abs(a.rangeM - b.rangeM) <= 2;
  const anchors = [];
  for (let i = 0; i < rays.length; i++) {
    if (!relevant(rays[i])) continue;
    const last = anchors.length - 1;
    if (i === 0 || !connected(rays[i - 1], rays[i])) anchors.push(i);
    else if (rays[i].rangeM < rays[anchors[last]].rangeM) anchors[last] = i;
  }
  if (anchors.length > 1 && connected(rays.at(-1), rays[0])) {
    const end = anchors.pop();
    if (rays[end].rangeM < rays[anchors[0]].rangeM) anchors[0] = end;
  }
  return anchors.map(i => {
    const { kind, rangeM } = rays[i], { right, forward } = directions[i];
    return { kind, rangeM, rightM: rangeM * right, forwardM: rangeM * forward, tick, heading };
  });
}

const options = n => Array.from({ length: n }, () => ({
  index: -1, distance: Infinity, second: Infinity,
}));

function offer(best, index, distance) {
  if (distance < best.distance) {
    best.second = best.distance;
    best.distance = distance;
    best.index = index;
  } else if (distance < best.second) best.second = distance;
}

function correspond(current, previous, heading) {
  const from = options(current.length), to = options(previous.length);
  const aligned = previous.map(point => {
    // Rotate the previous relative vector into the current axes before
    // differencing; the relative displacement still includes ego translation.
    const angle = heading - point.heading, c = Math.cos(angle), s = Math.sin(angle);
    return { rightM: point.rightM * c - point.forwardM * s,
      forwardM: point.rightM * s + point.forwardM * c };
  });
  for (const [i, point] of current.entries()) {
    for (const [j, old] of previous.entries()) {
      if (point.kind !== old.kind) continue;
      const d = Math.hypot(point.rightM - aligned[j].rightM, point.forwardM - aligned[j].forwardM);
      // Allow rapid closure plus one beam of angular quantization, but do
      // not infer continuous motion through a missed or ambiguous match.
      const spacing = point.kind === "pedestrian" ? PED_RAY_STEP : RAY_STEP;
      if (d > 75 * STEP * PURSUIT_SCAN_TICKS + point.rangeM * spacing) continue;
      offer(from[i], j, d);
      offer(to[j], i, d);
    }
  }
  return from.map(({ index, distance, second }, i) => {
    if (index < 0 || to[index].index !== i ||
        second - distance < .5 || to[index].second - distance < .5) return null;
    return { index, ...aligned[index] };
  });
}

const vehicleForecastMotion = new WeakMap();

function track(point, tick, match, previous) {
  const { kind, rightM, forwardM, rangeM } = point;
  const motionKnown = match !== null && tick === point.tick &&
    point.tick - previous[match.index].tick === PURSUIT_SCAN_TICKS;
  const old = motionKnown ? previous[match.index] : null;
  let rightMps = 0, forwardMps = 0, ttcS = null;
  if (motionKnown) {
    const elapsed = PURSUIT_SCAN_TICKS * STEP;
    rightMps = (rightM - match.rightM) / elapsed;
    forwardMps = (forwardM - match.forwardM) / elapsed;
    const closing = rangeM > 0 ? -(rightM * rightMps + forwardM * forwardMps) / rangeM : 0;
    // Radial time-to-contact at measured closure, saturated at the
    // observation horizon. It does not predict a future swept collision.
    if (closing > EPS) ttcS = Math.min(MAX_TTC_S, rangeM / closing);
  }
  const angularStep = kind === "pedestrian" ? PED_RAY_STEP : RAY_STEP;
  // Result is a measured surface point, not the object's center. This is a
  // quantization allowance; face changes and misassociation can exceed it.
  const positionAllowanceM = Math.max(.1, rangeM * Math.sin(angularStep / 2));
  const elapsedS = PURSUIT_SCAN_TICKS * STEP;
  const estimatedXMps = old ? (point.worldX - old.worldX) / elapsedS : null;
  const estimatedZMps = old ? (point.worldZ - old.worldZ) / elapsedS : null;
  const result = Object.freeze({
    trackId: point.trackId, kind, rightM, forwardM, rightMps, forwardMps,
    ageS: (tick - point.tick) * STEP, motionKnown, ttcS,
    observedTick: point.tick, observedXM: point.worldX, observedZM: point.worldZ,
    estimatedXMps, estimatedZMps, positionAllowanceM,
  });
  if (old && (kind === "civilian" || kind === "police")) {
    const preceding = old.surfaceMotion;
    point.surfaceMotion = { x: estimatedXMps, z: estimatedZMps, allowanceM: positionAllowanceM };
    // A matched track can move its representative return to a different vehicle face.
    const tolerance = preceding ? Math.min(4, 1.1 + .5 * (positionAllowanceM + preceding.allowanceM) / elapsedS) : 0;
    if (preceding && Math.hypot(estimatedXMps - preceding.x, estimatedZMps - preceding.z) <= tolerance)
      vehicleForecastMotion.set(result, { x: (estimatedXMps + preceding.x) / 2, z: (estimatedZMps + preceding.z) / 2 });
  }
  return result;
}

const FORECAST_SECONDS = Object.freeze([.5, 1, 2, 3, 5]);

export function forecastPursuitSurface(track) {
  if (track.ageS > 0) return { status: "not-observed", points: [] };
  if (track.kind !== "static" && !track.motionKnown) return { status: "motion-unresolved", points: [] };
  const stationary = track.kind === "static";
  const vehicle = track.kind === "civilian" || track.kind === "police";
  const fit = vehicle ? vehicleForecastMotion.get(track) : null;
  const vx = stationary ? 0 : vehicle ? fit?.x : track.estimatedXMps;
  const vz = stationary ? 0 : vehicle ? fit?.z : track.estimatedZMps;
  if (![vx, vz, track.observedXM, track.observedZM, track.positionAllowanceM].every(Number.isFinite))
    return { status: "motion-unresolved", points: [] };
  const points = [];
  for (const secondsAhead of FORECAST_SECONDS) {
    const allowanceM = track.positionAllowanceM + (stationary ? 0 :
      secondsAhead * Math.max(.35, track.positionAllowanceM / (STEP * PURSUIT_SCAN_TICKS)) +
      secondsAhead ** 2 * (track.kind === "pedestrian" ? .55 : 1.2));
    if (allowanceM > 9) break;
    points.push({ secondsAhead, xM: track.observedXM + vx * secondsAhead,
      zM: track.observedZM + vz * secondsAhead, allowanceM });
  }
  return { status: points.length ? "constant-velocity" : "horizon-unresolved", points };
}

/** Chase-local virtual planar geometry, independent of mounted camera/ranges. */
export class PursuitScanner {
  #world;
  #frame;
  #history = [];
  #nextTrack = 0;

  sample(world) {
    const { tick, player } = world;
    if (!Number.isSafeInteger(tick) || tick < 0) throw new RangeError("Invalid pursuit sample tick");
    if (world !== this.#world || tick < this.#frame?.tick) {
      this.#world = world;
      this.#frame = undefined;
      this.#history = [];
      this.#nextTrack = 0;
    }
    if (this.#frame && tick - this.#frame.tick < PURSUIT_SCAN_TICKS) return this.#frame;
    const heading = player.heading ?? 0;
    if (![player.x, player.z, heading].every(Number.isFinite))
      throw new RangeError("Invalid pursuit sample pose");

    const shapes = candidates(world, heading);
    const rays = Object.freeze(beams.map(beam => Object.freeze(firstReturn(shapes, beam))));
    const current = surfaces(rays, beams, false, tick, heading)
      .concat(surfaces(pedestrianReturns(shapes, rays), pedBeams, true, tick, heading))
      .sort((a, b) => a.rangeM - b.rangeM);
    const previous = this.#history.filter(point => tick - point.tick < TRACK_TTL_TICKS);
    const matches = correspond(current, previous, heading);
    const c = Math.cos(heading), s = Math.sin(heading);
    current.forEach((point, i) => {
      point.trackId = matches[i] ? previous[matches[i].index].trackId : ++this.#nextTrack;
      point.worldX = player.x + point.rightM * c + point.forwardM * s;
      point.worldZ = player.z - point.rightM * s + point.forwardM * c;
    });
    const matched = new Set(matches.flatMap(match => match ? [match.index] : []));
    const stale = previous.filter((_, i) => !matched.has(i))
      .sort((a, b) => b.tick - a.tick || a.rangeM - b.rangeM);
    const tracks = current.map((point, i) => track(point, tick, matches[i], previous));
    // Keep last measured coordinates as uncertain history, never extrapolate.
    for (const point of stale) tracks.push(track(point, tick, null, previous));
    this.#history = current.concat(stale);
    this.#frame = Object.freeze({ tick, rays, tracks: Object.freeze(tracks) });
    return this.#frame;
  }
}
