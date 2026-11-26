import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { STEP } from "../src/core/config.js";
import {
  createCityTerrain,
  hashPuddleId,
  pointInWaterPuddle,
  puddleOrganicScale,
  querySurfaceKindFast,
  sampleCitySurface,
} from "../src/core/city-surfaces.js";
import { AGGRESSIVE_CHASE_PRESENCE } from "../src/core/pako-aggressive-police.js";
import { METRO_CITY_CURBS } from "../src/core/pako-curb.js";
import { getVehicleMounts, mountToWorld } from "../src/core/vehicle-spec.js";
import { World } from "../src/core/world.js";
import {
  PURSUIT_LONG_RANGE_M,
  PURSUIT_SCAN_RANGE_M,
  PURSUIT_SCAN_RAYS,
  PURSUIT_SCAN_TICKS,
  PURSUIT_TRACK_TTL_S,
  PursuitScanner,
  forecastPursuitSurface,
  samplePursuitCornerRays,
} from "../src/signal_processing/pursuit-scanner.js";

// ============================================================================
// Explicit unprefiltered reference raycaster & surface oracle
// ============================================================================

const REF_EPS = 1e-9;
const REF_RAY_STEP = (2 * Math.PI) / PURSUIT_SCAN_RAYS;
const REF_PED_RAYS_PER_PRIMARY = 10;
const REF_PED_RAYS = PURSUIT_SCAN_RAYS * REF_PED_RAYS_PER_PRIMARY;
const REF_PED_RAY_STEP = REF_RAY_STEP / REF_PED_RAYS_PER_PRIMARY;
const REF_TRACK_TTL_TICKS = Math.round(PURSUIT_TRACK_TTL_S / STEP);
const REF_MAX_TTC_S = 6;
const REF_LONG_OFFSETS = Object.freeze([-1.55, -1.03, -0.52, 0, 0.52, 1.03, 1.55]);
const REF_NARROW_OFFSET = Object.freeze([0]);
const REF_PRIORITY = { none: 0, civilian: 1, pedestrian: 2, police: 3, static: 4 };

const refZeroSmall = (n) => (Math.abs(n) < REF_EPS ? 0 : n);
const refDirection = (angle) => ({
  right: refZeroSmall(Math.sin(angle)),
  forward: refZeroSmall(Math.cos(angle)),
});
const refBeams = Array.from({ length: PURSUIT_SCAN_RAYS }, (_, i) => refDirection(i * REF_RAY_STEP));
const refPedBeams = Array.from({ length: REF_PED_RAYS }, (_, i) =>
  i % REF_PED_RAYS_PER_PRIMARY ? refDirection(i * REF_PED_RAY_STEP) : refBeams[i / REF_PED_RAYS_PER_PRIMARY],
);
const refCornerBeams = Object.freeze(
  Object.fromEntries(
    [
      ["left-outer", -1],
      ["right-outer", 1],
    ].map(([id, side]) => [
      id,
      Array.from({ length: 12 }, (_, i) => {
        const angleRad = (side * (i + 1) * REF_RAY_STEP) / 4;
        return { angleRad, ...refDirection(angleRad) };
      }),
    ]),
  ),
);

function refCandidates(world, heading, maxRangeM, origin = world.player, requireForward = false) {
  const { player } = world;
  const c = Math.cos(heading);
  const s = Math.sin(heading);
  const shapes = [];
  function add(body, kind) {
    if (body === player) return;
    const dx = body.x - origin.x;
    const dz = body.z - origin.z;
    const right = dx * c - dz * s;
    const forward = dx * s + dz * c;
    const circle = kind === "pedestrian";
    const w = body.width / 2;
    const l = body.length / 2;
    if (!circle && !(w > 0 && l > 0)) return;
    const radius = circle ? body.radius : Math.hypot(w, l);
    if (!Number.isFinite(radius) || !(radius > 0) || !(Math.hypot(dx, dz) <= maxRangeM + radius + REF_EPS)) {
      return;
    }
    if (requireForward && forward + radius < -REF_EPS) return;
    if (circle) {
      shapes.push({ kind, radius, right, forward });
    } else {
      const angle = (body.heading ?? 0) - heading;
      if (!Number.isFinite(angle)) return;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      shapes.push({
        kind,
        w,
        l,
        cos,
        sin,
        x: -right * cos + forward * sin,
        z: -right * sin - forward * cos,
      });
    }
  }
  for (const body of world.statics) add(body, "static");
  for (const body of world.actors) {
    if (body.type === "pedestrian" || body.type === "static") add(body, body.type);
    else if (body.type === "vehicle") add(body, body.pursuitRole === "police" ? "police" : "civilian");
  }
  return shapes;
}

function refCircleHit({ right, forward, radius }, r, f) {
  const cross = right * f - forward * r;
  if (Math.abs(cross) > radius + REF_EPS) return Infinity;
  const projection = right * r + forward * f;
  const chord = Math.sqrt(Math.max(0, radius * radius - cross * cross));
  return projection + chord < 0 ? Infinity : Math.max(0, projection - chord);
}

function refBoxHit({ x, z, w, l, cos, sin }, r, f, far) {
  const dx = r * cos - f * sin;
  const dz = r * sin + f * cos;
  let near = 0;
  if (Math.abs(dx) < REF_EPS) {
    if (Math.abs(x) > w + REF_EPS) return Infinity;
  } else {
    const a = (-w - x) / dx;
    const b = (w - x) / dx;
    near = Math.max(near, Math.min(a, b));
    far = Math.min(far, Math.max(a, b));
    if (near > far + REF_EPS) return Infinity;
  }
  if (Math.abs(dz) < REF_EPS) {
    if (Math.abs(z) > l + REF_EPS) return Infinity;
  } else {
    const a = (-l - z) / dz;
    const b = (l - z) / dz;
    near = Math.max(near, Math.min(a, b));
    far = Math.min(far, Math.max(a, b));
  }
  return near <= far + REF_EPS ? near : Infinity;
}

function refFirstReturn(shapes, { right, forward }) {
  let rangeM = PURSUIT_SCAN_RANGE_M;
  let kind = "none";
  for (const body of shapes) {
    const hit =
      body.kind === "pedestrian"
        ? refCircleHit(body, right, forward)
        : refBoxHit(body, right, forward, rangeM);
    if (hit > PURSUIT_SCAN_RANGE_M + REF_EPS) continue;
    const measured = Math.min(hit, PURSUIT_SCAN_RANGE_M);
    if (measured < rangeM || (measured === rangeM && REF_PRIORITY[body.kind] > REF_PRIORITY[kind])) {
      rangeM = measured;
      kind = body.kind;
    }
  }
  return { rangeM, kind };
}

function refSampleForwardLongRange(world, heading) {
  const shapes = refCandidates(world, heading, PURSUIT_LONG_RANGE_M + 4, world.player, true);
  const offsets = world?.pursuit?.frozenDriver?._faultNarrowCenterBeamOnly
    ? REF_NARROW_OFFSET
    : REF_LONG_OFFSETS;
  let minCorridorM = PURSUIT_LONG_RANGE_M;
  let pedestrianAheadM = null;
  const beamRanges = [];
  for (let i = 0; i < offsets.length; i++) {
    const offsetRightM = offsets[i];
    let rangeM = PURSUIT_LONG_RANGE_M;
    let kind = "none";
    for (const body of shapes) {
      const hit =
        body.kind === "pedestrian"
          ? refCircleHit(
              { right: body.right - offsetRightM, forward: body.forward, radius: body.radius },
              0,
              1,
            )
          : refBoxHit(
              {
                w: body.w,
                l: body.l,
                cos: body.cos,
                sin: body.sin,
                x: body.x + offsetRightM * body.cos,
                z: body.z + offsetRightM * body.sin,
              },
              0,
              1,
              rangeM,
            );
      if (hit > PURSUIT_LONG_RANGE_M + REF_EPS) continue;
      const measured = Math.min(hit, PURSUIT_LONG_RANGE_M);
      if (measured < rangeM || (measured === rangeM && REF_PRIORITY[body.kind] > REF_PRIORITY[kind])) {
        rangeM = measured;
        kind = body.kind;
      }
    }
    const fwdM = rangeM;
    beamRanges.push(Object.freeze({ offsetRightM, rangeM, forwardM: fwdM, kind }));
    if (kind !== "none" && fwdM < minCorridorM) minCorridorM = fwdM;
    if (kind === "pedestrian" && (pedestrianAheadM === null || fwdM < pedestrianAheadM)) {
      pedestrianAheadM = fwdM;
    }
  }
  return Object.freeze({
    maxRangeM: PURSUIT_LONG_RANGE_M,
    corridorHalfWidthM: offsets.length === 1 ? 0 : 1.55,
    minCorridorM,
    pedestrianAheadM,
    beams: Object.freeze(beamRanges),
  });
}

function refSampleCornerRays(world) {
  const { tick, player } = world;
  const heading = player.heading ?? 0;
  const c = Math.cos(heading);
  const s = Math.sin(heading);
  const rays = getVehicleMounts(player).ranges.flatMap((mount) => {
    const fan = refCornerBeams[mount.id];
    if (!fan) return [];
    const { x, z } = mountToWorld(player, mount.position);
    const shapes = refCandidates(world, heading, PURSUIT_SCAN_RANGE_M, { x, z }, false);
    return fan.map((beam) => {
      const { rangeM, kind } = refFirstReturn(shapes, beam);
      return Object.freeze({
        mount: mount.id,
        angleRad: beam.angleRad,
        rangeM,
        kind,
        originX: x,
        originZ: z,
        x: x + rangeM * (beam.right * c + beam.forward * s),
        z: z + rangeM * (beam.forward * c - beam.right * s),
      });
    });
  });
  return Object.freeze({ tick, rays: Object.freeze(rays) });
}

class ReferencePursuitScanner {
  #world;
  #frame;
  #history = [];
  #nextTrack = 0;
  #forecastMotion = new WeakMap();

  sample(world) {
    const { tick, player } = world;
    if (world !== this.#world || tick < this.#frame?.tick) {
      this.#world = world;
      this.#frame = undefined;
      this.#history = [];
      this.#nextTrack = 0;
    }
    if (this.#frame && tick - this.#frame.tick < PURSUIT_SCAN_TICKS) return this.#frame;
    const heading = player.heading ?? 0;
    const shapes = refCandidates(world, heading, PURSUIT_SCAN_RANGE_M);
    const rays = Object.freeze(refBeams.map((beam) => Object.freeze(refFirstReturn(shapes, beam))));

    let pedSamples;
    for (const body of shapes) {
      if (body.kind !== "pedestrian") continue;
      pedSamples ??= new Array(REF_PED_RAYS);
      const coverage = (body.radius + REF_EPS) / Math.hypot(body.right, body.forward);
      const bearing = Math.atan2(body.right, body.forward);
      const half = Math.asin(Math.min(1, coverage));
      const first = coverage >= 1 ? 0 : Math.ceil((bearing - half) / REF_PED_RAY_STEP - REF_EPS);
      const last = coverage >= 1 ? REF_PED_RAYS - 1 : Math.floor((bearing + half) / REF_PED_RAY_STEP + REF_EPS);
      for (let bin = first; bin <= last; bin++) {
        const i = (bin + REF_PED_RAYS) % REF_PED_RAYS;
        if (pedSamples[i] !== undefined) continue;
        const hit =
          i % REF_PED_RAYS_PER_PRIMARY
            ? refFirstReturn(shapes, refPedBeams[i])
            : rays[i / REF_PED_RAYS_PER_PRIMARY];
        pedSamples[i] = hit.kind === "pedestrian" ? hit : null;
      }
    }

    const extractSurfaces = (rList, dirs, peds) => {
      const relevant = (ray) => ray && ray.kind !== "none" && (ray.kind === "pedestrian") === peds;
      const connected = (a, b) => relevant(a) && a.kind === b?.kind && Math.abs(a.rangeM - b.rangeM) <= 2;
      const anchors = [];
      for (let i = 0; i < rList.length; i++) {
        if (!relevant(rList[i])) continue;
        const last = anchors.length - 1;
        if (i === 0 || !connected(rList[i - 1], rList[i])) anchors.push(i);
        else if (rList[i].rangeM < rList[anchors[last]].rangeM) anchors[last] = i;
      }
      if (anchors.length > 1 && connected(rList.at(-1), rList[0])) {
        const end = anchors.pop();
        if (rList[end].rangeM < rList[anchors[0]].rangeM) anchors[0] = end;
      }
      return anchors.map((i) => {
        const { kind, rangeM } = rList[i];
        const { right, forward } = dirs[i];
        return { kind, rangeM, rightM: rangeM * right, forwardM: rangeM * forward, tick, heading };
      });
    };

    const current = extractSurfaces(rays, refBeams, false)
      .concat(extractSurfaces(pedSamples ?? [], refPedBeams, true))
      .sort((a, b) => a.rangeM - b.rangeM);
    const previous = this.#history.filter((point) => tick - point.tick < REF_TRACK_TTL_TICKS);

    const makeOpts = (n) => Array.from({ length: n }, () => ({ index: -1, distance: Infinity, second: Infinity }));
    const offer = (best, index, distance) => {
      if (distance < best.distance) {
        best.second = best.distance;
        best.distance = distance;
        best.index = index;
      } else if (distance < best.second) best.second = distance;
    };
    const from = makeOpts(current.length);
    const to = makeOpts(previous.length);
    const aligned = previous.map((point) => {
      const angle = heading - point.heading;
      const c = Math.cos(angle);
      const s = Math.sin(angle);
      return {
        rightM: point.rightM * c - point.forwardM * s,
        forwardM: point.rightM * s + point.forwardM * c,
      };
    });
    for (const [i, point] of current.entries()) {
      for (const [j, old] of previous.entries()) {
        if (point.kind !== old.kind) continue;
        const d = Math.hypot(point.rightM - aligned[j].rightM, point.forwardM - aligned[j].forwardM);
        const spacing = point.kind === "pedestrian" ? REF_PED_RAY_STEP : REF_RAY_STEP;
        if (d > 75 * STEP * PURSUIT_SCAN_TICKS + point.rangeM * spacing) continue;
        offer(from[i], j, d);
        offer(to[j], i, d);
      }
    }
    const matches = from.map(({ index, distance, second }, i) => {
      if (index < 0 || to[index].index !== i || second - distance < 0.5 || to[index].second - distance < 0.5) {
        return null;
      }
      return { index, ...aligned[index] };
    });

    const c = Math.cos(heading);
    const s = Math.sin(heading);
    current.forEach((point, i) => {
      point.trackId = matches[i] ? previous[matches[i].index].trackId : ++this.#nextTrack;
      point.worldX = player.x + point.rightM * c + point.forwardM * s;
      point.worldZ = player.z - point.rightM * s + point.forwardM * c;
    });
    const matched = new Set(matches.flatMap((m) => (m ? [m.index] : [])));
    const stale = previous
      .filter((_, i) => !matched.has(i))
      .sort((a, b) => b.tick - a.tick || a.rangeM - b.rangeM);

    const buildTrack = (point, match) => {
      const { kind, rightM, forwardM, rangeM } = point;
      const motionKnown =
        match !== null && tick === point.tick && point.tick - previous[match.index].tick === PURSUIT_SCAN_TICKS;
      const old = motionKnown ? previous[match.index] : null;
      let rightMps = 0;
      let forwardMps = 0;
      let ttcS = null;
      if (motionKnown) {
        const elapsed = PURSUIT_SCAN_TICKS * STEP;
        rightMps = (rightM - match.rightM) / elapsed;
        forwardMps = (forwardM - match.forwardM) / elapsed;
        const closing = rangeM > 0 ? -(rightM * rightMps + forwardM * forwardMps) / rangeM : 0;
        if (closing > REF_EPS) ttcS = Math.min(REF_MAX_TTC_S, rangeM / closing);
      }
      const angularStep = kind === "pedestrian" ? REF_PED_RAY_STEP : REF_RAY_STEP;
      const positionAllowanceM = Math.max(0.1, rangeM * Math.sin(angularStep / 2));
      const elapsedS = PURSUIT_SCAN_TICKS * STEP;
      const estimatedXMps = old ? (point.worldX - old.worldX) / elapsedS : null;
      const estimatedZMps = old ? (point.worldZ - old.worldZ) / elapsedS : null;
      const result = Object.freeze({
        trackId: point.trackId,
        kind,
        rightM,
        forwardM,
        rightMps,
        forwardMps,
        ageS: (tick - point.tick) * STEP,
        motionKnown,
        ttcS,
        observedTick: point.tick,
        observedXM: point.worldX,
        observedZM: point.worldZ,
        estimatedXMps,
        estimatedZMps,
        positionAllowanceM,
      });
      if (old && (kind === "civilian" || kind === "police")) {
        const preceding = old.surfaceMotion;
        point.surfaceMotion = { x: estimatedXMps, z: estimatedZMps, allowanceM: positionAllowanceM };
        const tolerance = preceding
          ? Math.min(4, 1.1 + (0.5 * (positionAllowanceM + preceding.allowanceM)) / elapsedS)
          : 0;
        if (preceding && Math.hypot(estimatedXMps - preceding.x, estimatedZMps - preceding.z) <= tolerance) {
          this.#forecastMotion.set(result, {
            x: (estimatedXMps + preceding.x) / 2,
            z: (estimatedZMps + preceding.z) / 2,
          });
        }
      }
      return result;
    };

    const tracks = current.map((point, i) => buildTrack(point, matches[i]));
    for (const point of stale) tracks.push(buildTrack(point, null));
    const longRangeForward = refSampleForwardLongRange(world, heading);
    this.#history = current.concat(stale);
    this.#frame = Object.freeze({ tick, rays, tracks: Object.freeze(tracks), longRangeForward });
    return this.#frame;
  }
}

function referencePointInWaterPuddle(x, z, zone, pIdx = 0, marginM = 0) {
  if (!zone || !Number.isFinite(x) || !Number.isFinite(z)) return false;
  const heading = zone.heading ?? 0;
  const cos = Math.cos(heading);
  const sin = Math.sin(heading);
  const halfWidth =
    Number.isFinite(zone.halfWidth) && zone.halfWidth > 0
      ? Math.max(0.25, zone.halfWidth)
      : Number.isFinite(zone.width) && zone.width > 0
        ? Math.max(0.25, zone.width * 0.5)
        : 3.0;
  const halfLength =
    Number.isFinite(zone.halfLength) && zone.halfLength > 0
      ? Math.max(0.25, zone.halfLength)
      : Number.isFinite(zone.length) && zone.length > 0
        ? Math.max(0.25, zone.length * 0.5)
        : 4.8;
  const dx = x - zone.x;
  const dz = z - zone.z;
  const lx = dx * cos - dz * sin;
  const lz = dx * sin + dz * cos;
  const pad = Math.max(0, marginM) + 0.25;
  if (Math.abs(lx) > halfWidth + pad || Math.abs(lz) > halfLength + pad) return false;
  const seed = Number.isFinite(zone.organicSeed)
    ? zone.organicSeed
    : hashPuddleId(zone.id ?? `puddle-${pIdx}`);
  const angRaw = Math.atan2(lx / halfWidth, lz / halfLength);
  const ang = angRaw < 0 ? angRaw + Math.PI * 2 : angRaw;
  const lobe = puddleOrganicScale(ang, seed) * 0.94;
  const rx = halfWidth * lobe + marginM;
  const rz = halfLength * lobe + marginM;
  if (rx <= 0.04 || rz <= 0.04) return false;
  const d2 = (lx / rx) ** 2 + (lz / rz) ** 2;
  return marginM > 0 ? d2 <= 1.0 : d2 < 1.0;
}

function referenceQuerySurfaceKind(terrain, x, z) {
  if (!terrain || !Number.isFinite(x) || !Number.isFinite(z)) return "asphalt";
  if (Array.isArray(terrain.waterPuddles)) {
    for (let i = 0; i < terrain.waterPuddles.length; i++) {
      if (referencePointInWaterPuddle(x, z, terrain.waterPuddles[i], i, 0)) return "water";
    }
  }
  const inShapedZones = (zones) => {
    if (!Array.isArray(zones)) return false;
    for (let i = 0; i < zones.length; i++) {
      const zObj = zones[i];
      if (!zObj) continue;
      const halfWidth =
        Number.isFinite(zObj.halfWidth) && zObj.halfWidth > 0
          ? zObj.halfWidth
          : Number.isFinite(zObj.width) && zObj.width > 0
            ? zObj.width * 0.5
            : 3.0;
      const halfLength =
        Number.isFinite(zObj.halfLength) && zObj.halfLength > 0
          ? zObj.halfLength
          : Number.isFinite(zObj.length) && zObj.length > 0
            ? zObj.length * 0.5
            : 4.8;
      const heading = Number.isFinite(zObj.heading) ? zObj.heading : 0;
      const cos = Math.cos(heading);
      const sin = Math.sin(heading);
      const dx = x - (zObj.x ?? 0);
      const dz = z - (zObj.z ?? 0);
      const absX = Math.abs(dx * cos - dz * sin);
      const absZ = Math.abs(dx * sin + dz * cos);
      const shape = zObj.shape;
      if (shape === "strip") {
        if (absX >= halfWidth || absZ >= halfLength) continue;
        const r = Math.min(halfWidth, halfLength) * 0.35;
        const qx = absX - (halfWidth - r);
        const qz = absZ - (halfLength - r);
        if (!(qx > 0 && qz > 0 && qx * qx + qz * qz >= r * r)) return true;
      } else if (shape === "ellipse") {
        if (absX >= halfWidth || absZ >= halfLength) continue;
        const nx = absX / halfWidth;
        const nz = absZ / halfLength;
        if (nx * nx + nz * nz < 1) return true;
      } else if (absX < halfWidth && absZ < halfLength) {
        return true;
      }
    }
    return false;
  };
  if (inShapedZones(terrain.sandZones)) return "sand";
  if (inShapedZones(terrain.cobbleZones)) return "cobble";
  return "asphalt";
}

// ============================================================================
// Tests
// ============================================================================

test("1. PursuitScanner.sample and samplePursuitCornerRays preserve 100% bit-exact parity across 25 diverse Grand Metro v5 poses + unindexed runtime roadblocks", () => {
  const world = new World(
    { seed: "parity-metro-v5-20261125", cityVersion: 5, traffic: 68, pedestrians: 190 },
    "metro",
  );
  world.command({
    type: "street-pursuit-start",
    variant: "gta",
    config: {
      ruleset: "dispatch-v1",
      wantedLevelStart: 5,
      maxActivePatrols: 12,
      enableRoadblocks: false,
      curbSupport: METRO_CITY_CURBS,
      chasePresence: AGGRESSIVE_CHASE_PRESENCE,
    },
  });
  world.command({ type: "spawn-crowd-ahead", count: 20 });

  // Validation errors preserved identically
  assert.throws(() => new PursuitScanner().sample({ tick: -1, player: world.player }), RangeError);
  assert.throws(
    () => new PursuitScanner().sample({ tick: 0, player: { x: NaN, z: 0, heading: 0 } }),
    RangeError,
  );
  assert.throws(() => samplePursuitCornerRays({ tick: -1, player: world.player }), RangeError);

  const fastScanner = new PursuitScanner();
  const refScanner = new ReferencePursuitScanner();

  const diverseJumpPoses = [
    null, // ticks 0..5: natural spawn + pursuit + crowd ahead
    null,
    null,
    { x: -156, z: -109.2, heading: Math.PI / 2 }, // Tahrir Boulevard Eastbound
    null,
    null,
    { x: -278, z: 42, heading: 0.12 }, // Corniche Avenue Northbound
    null,
    { x: 124, z: 58, heading: -0.35 }, // Khan Market Cobble
    null,
    { x: 210, z: 158, heading: Math.PI / 2 - 0.18 }, // Hussein Collector Sand
    null,
    { x: -180, z: -96, heading: Math.atan2(298, 513.79) }, // Diagonal Talaat Harb
    null,
    { x: 205, z: -2, heading: Math.atan2(-176, 202) }, // Diagonal Bazaar Slash
    null,
    { x: 265, z: -204, heading: Math.atan2(516, 308) }, // Citadel Diagonal
    null,
    { x: -96, z: 162, heading: Math.PI }, // Gateway Avenue Southbound
    null,
    { x: 24, z: -112, heading: -Math.PI / 2 }, // Tahrir Overpass Crest
    null,
    { x: -332, z: 92.2, heading: 1.48 }, // University West
    null,
    { x: 348, z: 360, heading: -1.52 }, // Ramses North Arterial
  ];
  assert.equal(diverseJumpPoses.length, 25);

  let runtimeBarrierHits = 0;
  let totalKindHits = 0;
  let pedTrackCount = 0;

  for (let sampleIdx = 0; sampleIdx < 25; sampleIdx++) {
    for (let s = 0; s < PURSUIT_SCAN_TICKS; s++) world.step();

    const jump = diverseJumpPoses[sampleIdx];
    if (jump) {
      world.player.x = jump.x;
      world.player.z = jump.z;
      world.player.heading = jump.heading;
    }

    // Push dynamic runtime roadblock barriers directly to world.statics WITHOUT updating world.staticIndex
    if (sampleIdx % 4 === 1) {
      const h = world.player.heading ?? 0;
      const fwdDist = 18 + (sampleIdx % 5) * 6;
      const latOff = sampleIdx % 8 === 1 ? 0.6 : -1.45;
      world.statics.push({
        id: `runtime-unindexed-roadblock-${sampleIdx}`,
        type: "static",
        kind: "barrier",
        x: world.player.x + Math.sin(h) * fwdDist + Math.cos(h) * latOff,
        z: world.player.z + Math.cos(h) * fwdDist - Math.sin(h) * latOff,
        heading: h + 0.28,
        width: 4.4,
        length: 1.2,
        height: 1.1,
      });
    }

    // Exercise _faultNarrowCenterBeamOnly on sample 19 as well as full 7-beam corridor on all others
    if (sampleIdx === 19) {
      world.pursuit.frozenDriver = { _faultNarrowCenterBeamOnly: true };
    } else if (world.pursuit?.frozenDriver) {
      delete world.pursuit.frozenDriver;
    }

    const actual = fastScanner.sample(world);
    const expected = refScanner.sample(world);

    assert.equal(Object.isFrozen(actual), true);
    assert.equal(Object.isFrozen(actual.rays), true);
    assert.equal(Object.isFrozen(actual.tracks), true);
    assert.equal(Object.isFrozen(actual.longRangeForward), true);
    assert.equal(Object.isFrozen(actual.longRangeForward.beams), true);
    assert.equal(actual.tick, expected.tick);
    assert.equal(actual.rays.length, PURSUIT_SCAN_RAYS);

    for (let r = 0; r < PURSUIT_SCAN_RAYS; r++) {
      assert.equal(Object.isFrozen(actual.rays[r]), true);
      assert.equal(
        actual.rays[r].kind,
        expected.rays[r].kind,
        `ray[${r}].kind mismatch at sample ${sampleIdx}`,
      );
      assert.equal(
        Object.is(actual.rays[r].rangeM, expected.rays[r].rangeM),
        true,
        `ray[${r}].rangeM mismatch at sample ${sampleIdx}: ${actual.rays[r].rangeM} vs ${expected.rays[r].rangeM}`,
      );
      if (actual.rays[r].kind !== "none") totalKindHits++;
      if (actual.rays[r].kind === "static" && actual.rays[r].rangeM < 42) runtimeBarrierHits++;
    }

    // Long-range 104m corridor parity
    const actLR = actual.longRangeForward;
    const expLR = expected.longRangeForward;
    assert.equal(actLR.maxRangeM, expLR.maxRangeM);
    assert.equal(actLR.corridorHalfWidthM, expLR.corridorHalfWidthM);
    assert.equal(Object.is(actLR.minCorridorM, expLR.minCorridorM), true);
    assert.equal(Object.is(actLR.pedestrianAheadM, expLR.pedestrianAheadM), true);
    assert.equal(actLR.beams.length, expLR.beams.length);
    for (let b = 0; b < actLR.beams.length; b++) {
      assert.equal(Object.isFrozen(actLR.beams[b]), true);
      assert.equal(actLR.beams[b].kind, expLR.beams[b].kind);
      assert.equal(Object.is(actLR.beams[b].offsetRightM, expLR.beams[b].offsetRightM), true);
      assert.equal(Object.is(actLR.beams[b].rangeM, expLR.beams[b].rangeM), true);
      assert.equal(Object.is(actLR.beams[b].forwardM, expLR.beams[b].forwardM), true);
    }

    // Track & surface association parity (also exercises pedestrianReturns 720-bin fine grid)
    assert.deepStrictEqual(actual.tracks, expected.tracks);
    for (const tr of actual.tracks) {
      if (tr.kind === "pedestrian") pedTrackCount++;
      const fc = forecastPursuitSurface(tr);
      assert.ok(typeof fc.status === "string" && Array.isArray(fc.points));
    }

    // Corner rays parity
    const actualCorners = samplePursuitCornerRays(world);
    const expectedCorners = refSampleCornerRays(world);
    assert.equal(Object.isFrozen(actualCorners), true);
    assert.equal(Object.isFrozen(actualCorners.rays), true);
    assert.equal(actualCorners.tick, expectedCorners.tick);
    assert.equal(actualCorners.rays.length, expectedCorners.rays.length);
    assert.equal(actualCorners.rays.length, 24);
    for (let cIdx = 0; cIdx < actualCorners.rays.length; cIdx++) {
      const ac = actualCorners.rays[cIdx];
      const ec = expectedCorners.rays[cIdx];
      assert.equal(Object.isFrozen(ac), true);
      assert.equal(ac.mount, ec.mount);
      assert.equal(ac.kind, ec.kind);
      assert.equal(Object.is(ac.angleRad, ec.angleRad), true);
      assert.equal(Object.is(ac.rangeM, ec.rangeM), true);
      assert.equal(Object.is(ac.originX, ec.originX), true);
      assert.equal(Object.is(ac.originZ, ec.originZ), true);
      assert.equal(Object.is(ac.x, ec.x), true);
      assert.equal(Object.is(ac.z, ec.z), true);
    }
  }

  assert.ok(totalKindHits >= 400, `expected rich multi-kind hits across 25 scans, got ${totalKindHits}`);
  assert.ok(runtimeBarrierHits > 0, "expected unindexed runtime statics to be detected");
  assert.ok(pedTrackCount > 0, "expected pedestrian tracks across 25 scans");

  // Explicitly verify staticIndex.near() and actorIndex.near() spatial queries are invoked on a live World.step() state
  world.step();
  let staticNearCalls = 0;
  let actorNearCalls = 0;
  const origStaticNear = world.staticIndex.near.bind(world.staticIndex);
  const origActorNear = world.actorIndex.near.bind(world.actorIndex);
  world.staticIndex.near = (...args) => {
    staticNearCalls++;
    return origStaticNear(...args);
  };
  world.actorIndex.near = (...args) => {
    actorNearCalls++;
    return origActorNear(...args);
  };
  new PursuitScanner().sample(world);
  assert.ok(staticNearCalls >= 1, `expected staticIndex.near to be invoked by PursuitScanner, got ${staticNearCalls}`);
  assert.ok(actorNearCalls >= 1, `expected actorIndex.near to be invoked by PursuitScanner, got ${actorNearCalls}`);
  world.staticIndex.near = origStaticNear;
  world.actorIndex.near = origActorNear;

  // Regression A: same-length middle replacement in world.statics without rebuilding staticIndex
  const savedStatics = world.statics.slice();
  const midIdx = Math.floor(world.statics.length / 2);
  const p = world.player;
  const fwdX = Math.sin(p.heading);
  const fwdZ = Math.cos(p.heading);
  const midReplacementBarrier = {
    id: "mid-replace-barrier",
    type: "static",
    kind: "roadblock",
    x: p.x + fwdX * 9.0,
    z: p.z + fwdZ * 9.0,
    width: 6.0,
    length: 2.0,
    heading: p.heading,
  };
  world.statics[midIdx] = midReplacementBarrier;
  assert.equal(world.statics.length, savedStatics.length);
  const actualMidReplace = new PursuitScanner().sample(world);
  const expectedMidReplace = new ReferencePursuitScanner().sample(world);
  assert.deepStrictEqual(actualMidReplace.rays, expectedMidReplace.rays);
  assert.deepStrictEqual(actualMidReplace.longRangeForward, expectedMidReplace.longRangeForward);
  assert.equal(actualMidReplace.rays[0].kind, "static");
  assert.ok(actualMidReplace.rays[0].rangeM < 11.0, `expected <11m static hit, got ${actualMidReplace.rays[0].rangeM}`);

  // Regression B: removing an indexed static without rebuilding staticIndex produces zero phantom hits
  world.statics = savedStatics.slice();
  const indexedBarrier = {
    id: "indexed-then-removed-barrier",
    type: "static",
    kind: "roadblock",
    x: p.x + fwdX * 8.5,
    z: p.z + fwdZ * 8.5,
    width: 6.0,
    length: 2.0,
    heading: p.heading,
  };
  world.statics.push(indexedBarrier);
  world.staticIndex = new world.staticIndex.constructor(world.statics);
  assert.equal(new PursuitScanner().sample(world).rays[0].kind, "static");
  // Now remove indexedBarrier from world.statics WITHOUT rebuilding world.staticIndex
  world.statics.pop();
  const actualAfterRemove = new PursuitScanner().sample(world);
  const expectedAfterRemove = new ReferencePursuitScanner().sample(world);
  assert.deepStrictEqual(actualAfterRemove.rays, expectedAfterRemove.rays);
  assert.deepStrictEqual(actualAfterRemove.longRangeForward, expectedAfterRemove.longRangeForward);
  world.statics = savedStatics;
  world.staticIndex = new world.staticIndex.constructor(world.statics);

  // Regression C: mutating coordinates of an indexed static/actor without rebuilding index preserves 100% parity
  const movedStatic = world.statics[0];
  const origSx = movedStatic.x;
  const origSz = movedStatic.z;
  movedStatic.x = p.x + fwdX * 7.5;
  movedStatic.z = p.z + fwdZ * 7.5;
  const actualMovedStatic = new PursuitScanner().sample(world);
  const expectedMovedStatic = new ReferencePursuitScanner().sample(world);
  assert.deepStrictEqual(actualMovedStatic.rays, expectedMovedStatic.rays);
  assert.deepStrictEqual(actualMovedStatic.longRangeForward, expectedMovedStatic.longRangeForward);
  movedStatic.x = origSx;
  movedStatic.z = origSz;

  // Regression D: oversized 20m articulated bus at 55m (front bumper at 45m <= 48m) + actor replacement/removal
  const savedActors = world.actors.slice();
  const articulatedBus = {
    id: "articulated-bus-20m",
    type: "vehicle",
    x: p.x + fwdX * 55.0,
    z: p.z + fwdZ * 55.0,
    width: 3.0,
    length: 20.0,
    heading: p.heading,
  };
  world.actors.push(articulatedBus);
  world.actorIndex = new world.actorIndex.constructor(world.actors);
  const actualOversized = new PursuitScanner().sample(world);
  const expectedOversized = new ReferencePursuitScanner().sample(world);
  assert.deepStrictEqual(actualOversized.rays, expectedOversized.rays);
  assert.deepStrictEqual(actualOversized.longRangeForward, expectedOversized.longRangeForward);

  // Actor coordinate teleport without rebuilding actorIndex
  articulatedBus.x = p.x + fwdX * 14.0;
  articulatedBus.z = p.z + fwdZ * 14.0;
  const actualTeleportedActor = new PursuitScanner().sample(world);
  const expectedTeleportedActor = new ReferencePursuitScanner().sample(world);
  assert.deepStrictEqual(actualTeleportedActor.rays, expectedTeleportedActor.rays);
  assert.deepStrictEqual(actualTeleportedActor.longRangeForward, expectedTeleportedActor.longRangeForward);

  // Actor removal without rebuilding actorIndex
  world.actors.pop();
  const actualRemovedActor = new PursuitScanner().sample(world);
  const expectedRemovedActor = new ReferencePursuitScanner().sample(world);
  assert.deepStrictEqual(actualRemovedActor.rays, expectedRemovedActor.rays);
  assert.deepStrictEqual(actualRemovedActor.longRangeForward, expectedRemovedActor.longRangeForward);
  world.actors = savedActors;
  world.actorIndex = new world.actorIndex.constructor(world.actors);

  // Regression E: mutating width/length/radius of an ALREADY-INDEXED actor or static without rebuilding index preserves 100% parity!
  const growableVehicle = {
    id: "growable-vehicle-at-55m",
    type: "vehicle",
    x: p.x + fwdX * 55.0,
    z: p.z + fwdZ * 55.0,
    width: 2.0,
    length: 4.5,
    heading: p.heading,
  };
  world.actors.push(growableVehicle);
  world.actorIndex = new world.actorIndex.constructor(world.actors);
  // Enlarge length from 4.5m -> 22.0m IN PLACE without rebuilding actorIndex (front bumper now at 44m <= 48m!)
  growableVehicle.length = 22.0;
  const actualGrownActor = new PursuitScanner().sample(world);
  const expectedGrownActor = new ReferencePursuitScanner().sample(world);
  assert.deepStrictEqual(actualGrownActor.rays, expectedGrownActor.rays);
  assert.deepStrictEqual(actualGrownActor.longRangeForward, expectedGrownActor.longRangeForward);
  world.actors = savedActors;
  world.actorIndex = new world.actorIndex.constructor(world.actors);

  const growableStatic = {
    id: "growable-static-at-55m",
    type: "static",
    kind: "barrier",
    x: p.x + fwdX * 55.0,
    z: p.z + fwdZ * 55.0,
    width: 2.0,
    length: 4.0,
    heading: p.heading,
  };
  world.statics.push(growableStatic);
  world.staticIndex = new world.staticIndex.constructor(world.statics);
  // Enlarge length from 4.0m -> 22.0m IN PLACE without rebuilding staticIndex
  growableStatic.length = 22.0;
  const actualGrownStatic = new PursuitScanner().sample(world);
  const expectedGrownStatic = new ReferencePursuitScanner().sample(world);
  assert.deepStrictEqual(actualGrownStatic.rays, expectedGrownStatic.rays);
  assert.deepStrictEqual(actualGrownStatic.longRangeForward, expectedGrownStatic.longRangeForward);
  world.statics = savedStatics;
  world.staticIndex = new world.staticIndex.constructor(world.statics);

  // Regression F: mutating actor.type from "vehicle" to "pedestrian" IN PLACE without rebuilding actorIndex preserves 100% parity!
  world.statics = [];
  world.actors = [p];
  const morphedActor = {
    id: "morphed-vehicle-to-pedestrian",
    type: "vehicle",
    x: p.x + fwdX * 46.8,
    z: p.z + fwdZ * 46.8,
    width: 1.8,
    length: 0,
    radius: 1.8,
    heading: p.heading,
  };
  for (let padIdx = 0; padIdx < 35; padIdx++) {
    world.actors.push({
      id: `pad-veh-${padIdx}`,
      type: "vehicle",
      x: p.x - fwdX * (20 + padIdx * 3),
      z: p.z - fwdZ * (20 + padIdx * 3),
      width: 1.8,
      length: 4.2,
      heading: p.heading,
    });
  }
  world.actors.push(morphedActor);
  world.actorIndex = new world.actorIndex.constructor(world.actors);
  morphedActor.type = "pedestrian";
  const actualMorphedType = new PursuitScanner().sample(world);
  const expectedMorphedType = new ReferencePursuitScanner().sample(world);
  assert.deepStrictEqual(actualMorphedType.rays, expectedMorphedType.rays);
  assert.deepStrictEqual(actualMorphedType.longRangeForward, expectedMorphedType.longRangeForward);
  assert.equal(actualMorphedType.rays[0].kind, "pedestrian");
  world.statics = savedStatics;
  world.staticIndex = new world.staticIndex.constructor(world.statics);
  world.actors = savedActors;
  world.actorIndex = new world.actorIndex.constructor(world.actors);
});

test("2. querySurfaceKindFast and pointInWaterPuddle match reference geometry 100% across >= 500 grid, puddle-boundary, and synthetic plain terrain points", () => {
  const terrain = createCityTerrain();
  const samplePoints = [];

  // (a) 352 city-wide grid points including 32m spatial-cell seam coordinates
  for (let ix = 0; ix < 22; ix++) {
    for (let iz = 0; iz < 16; iz++) {
      const x = -512 + ix * 44 + (ix % 3 === 0 ? 0 : 7.35);
      const z = -416 + iz * 50 + (iz % 3 === 0 ? 0 : -5.6);
      samplePoints.push([x, z]);
    }
  }

  // (b) 198 precise puddle-boundary, dry-corner, sand, and cobble boundary probes
  for (let pIdx = 0; pIdx < terrain.waterPuddles.length; pIdx++) {
    const p = terrain.waterPuddles[pIdx];
    const seed = hashPuddleId(p.id ?? `puddle-${pIdx}`);
    // Center + 4 polar edge probes straddling exact organic contour + dry bounding-box corner
    samplePoints.push([p.x, p.z]);
    for (const [ang, scale] of [
      [0.35, 0.985],
      [0.35, 1.015],
      [2.15, 0.992],
      [4.75, 1.008],
    ]) {
      const lobe = puddleOrganicScale(ang, seed) * 0.94;
      const lx = Math.sin(ang) * p.halfWidth * lobe * scale;
      const lz = Math.cos(ang) * p.halfLength * lobe * scale;
      const wx = p.x + lx * p.cos + lz * p.sin;
      const wz = p.z - lx * p.sin + lz * p.cos;
      samplePoints.push([wx, wz]);
    }
    // Dry corner inside rotated rectangle [halfWidth, halfLength] but outside organic puddle ellipse
    const cornerLx = p.halfWidth * 0.97;
    const cornerLz = p.halfLength * 0.97;
    samplePoints.push([
      p.x + cornerLx * p.cos + cornerLz * p.sin,
      p.z - cornerLx * p.sin + cornerLz * p.cos,
    ]);
  }

  for (const zObj of [...terrain.sandZones, ...terrain.cobbleZones]) {
    samplePoints.push([zObj.x, zObj.z]);
    for (const s of [0.999, 1.001]) {
      const lx = zObj.halfWidth * s;
      const lz = zObj.halfLength * 0.5;
      samplePoints.push([
        zObj.x + lx * zObj.cos + lz * zObj.sin,
        zObj.z - lx * zObj.sin + lz * zObj.cos,
      ]);
    }
  }

  assert.ok(samplePoints.length >= 500, `expected >= 500 test points, got ${samplePoints.length}`);

  // Explicitly verify Tahrir sand ellipse corner (-96.77, -115.27) agrees 100% between physics and fast lookup!
  assert.equal(sampleCitySurface(terrain, -96.77, -115.27).surfaceKind, "asphalt");
  assert.equal(querySurfaceKindFast(terrain, -96.77, -115.27), "asphalt");

  const seenKinds = new Set();
  for (let i = 0; i < samplePoints.length; i++) {
    const [x, z] = samplePoints[i];
    const fast = querySurfaceKindFast(terrain, x, z);
    const phys = sampleCitySurface(terrain, x, z).surfaceKind;
    const ref = referenceQuerySurfaceKind(terrain, x, z);
    assert.equal(fast, ref, `querySurfaceKindFast mismatch at (${x}, ${z}): ${fast} vs ${ref}`);
    assert.equal(fast, phys, `physics vs fast surface mismatch at (${x}, ${z}): ${fast} vs ${phys}`);
    seenKinds.add(fast);

    // Also verify pointInWaterPuddle fast AABB pre-reject across margins 0, 0.85, and 2.4
    for (const marginM of [0, 0.85, 2.4]) {
      for (let p = 0; p < terrain.waterPuddles.length; p++) {
        const zPuddle = terrain.waterPuddles[p];
        assert.equal(
          pointInWaterPuddle(x, z, zPuddle, p, marginM),
          referencePointInWaterPuddle(x, z, zPuddle, p, marginM),
          `pointInWaterPuddle mismatch at (${x}, ${z}) puddle ${zPuddle.id} margin ${marginM}`,
        );
      }
    }
  }
  assert.deepStrictEqual(
    new Set(["asphalt", "water", "sand", "cobble"]),
    seenKinds,
    "500+ points must exercise all 4 surface kinds",
  );

  // (c) Synthetic plain terrain object WITHOUT prebuilt spatial grid, with frozen zones (verifies zero mutation)
  const plainTerrain = {
    waterPuddles: [
      Object.freeze({ id: "syn-water", x: 10, z: -20, heading: 0.65, halfWidth: 4.0, halfLength: 8.0 }),
    ],
    sandZones: [
      Object.freeze({ id: "syn-sand", x: 10, z: -20, heading: 0.65, halfWidth: 6.5, halfLength: 11.0 }),
      Object.freeze({ id: "syn-sand-diag", x: -85, z: 64, heading: -0.92, width: 9.0, length: 22.0 }),
    ],
    cobbleZones: [
      Object.freeze({ id: "syn-cobble", x: 10, z: -20, heading: 0.65, halfWidth: 9.0, halfLength: 14.0 }),
    ],
  };

  // Priority check: water > sand > cobble > asphalt + 120 grid points around synthetic zones
  assert.equal(querySurfaceKindFast(plainTerrain, 10, -20), "water");

  // (d) Dynamic in-place zone move, dimension expansion, & .push() append update BOTH querySurfaceKindFast AND sampleCitySurface (driving physics)!
  const dynTerrain = createCityTerrain();
  const movedSand = dynTerrain.sandZones[0];
  const origSandX = movedSand.x;
  const origSandZ = movedSand.z;
  movedSand.x = -395;
  movedSand.z = -395;
  assert.equal(querySurfaceKindFast(dynTerrain, -395, -395), referenceQuerySurfaceKind(dynTerrain, -395, -395));
  assert.equal(sampleCitySurface(dynTerrain, -395, -395).surfaceKind, "sand");
  assert.equal(querySurfaceKindFast(dynTerrain, origSandX, origSandZ), referenceQuerySurfaceKind(dynTerrain, origSandX, origSandZ));
  assert.equal(sampleCitySurface(dynTerrain, origSandX, origSandZ).surfaceKind, referenceQuerySurfaceKind(dynTerrain, origSandX, origSandZ));
  // Expand halfWidth in place from 5 -> 22m
  dynTerrain.sandZones.push({ id: "appended-sand", x: 398, z: -398, heading: 0, halfWidth: 5, halfLength: 8, shape: "strip" });
  assert.equal(querySurfaceKindFast(dynTerrain, 398, -398), "sand");
  assert.equal(sampleCitySurface(dynTerrain, 398, -398).surfaceKind, "sand");
  assert.equal(querySurfaceKindFast(dynTerrain, 412, -398), "asphalt");
  dynTerrain.sandZones.at(-1).halfWidth = 22;
  assert.equal(querySurfaceKindFast(dynTerrain, 412, -398), "sand");
  assert.equal(sampleCitySurface(dynTerrain, 412, -398).surfaceKind, "sand");

  // Rotate a compiled zone in place by 90 deg (heading mutation must recompute cos/sin, not reuse stale precompiled cos/sin!)
  const rotTerrain = createCityTerrain();
  const rotSand = rotTerrain.sandZones[0];
  rotSand.x = 0;
  rotSand.z = 0;
  rotSand.halfWidth = 3;
  rotSand.halfLength = 24;
  rotSand.heading = 0;
  assert.equal(querySurfaceKindFast(rotTerrain, 18, 0), "asphalt");
  assert.equal(querySurfaceKindFast(rotTerrain, 0, 18), "sand");
  rotSand.heading = Math.PI / 2;
  assert.equal(querySurfaceKindFast(rotTerrain, 18, 0), "sand");
  assert.equal(sampleCitySurface(rotTerrain, 18, 0).surfaceKind, "sand");
  assert.equal(querySurfaceKindFast(rotTerrain, 0, 18), referenceQuerySurfaceKind(rotTerrain, 0, 18));

  // Mutate shape ("ellipse" -> "strip") and depthM in place and verify sampleCitySurface reflects both immediately!
  const shapeTerrain = createCityTerrain();
  const shapeSand = shapeTerrain.sandZones[0];
  shapeSand.x = 100;
  shapeSand.z = 100;
  shapeSand.heading = 0;
  shapeSand.halfWidth = 10;
  shapeSand.halfLength = 10;
  shapeSand.shape = "ellipse";
  shapeSand.depthM = 0.02;
  // Corner (108.5, 108.5) has normalized radius sqrt(0.85^2 + 0.85^2) = 1.20 > 1 (outside ellipse, inside strip!)
  assert.equal(sampleCitySurface(shapeTerrain, 108.5, 108.5).surfaceKind, "asphalt");
  shapeSand.shape = "strip";
  shapeSand.depthM = 0.09;
  const cornerSample = sampleCitySurface(shapeTerrain, 108.5, 108.5);
  assert.equal(cornerSample.surfaceKind, "sand");
  assert.ok(sampleCitySurface(shapeTerrain, 100, 100).sandDepthM >= 0.085);

  // Mutate zone.id and zone.organicSeed in place on compiled terrain and verify both sampleCitySurface and querySurfaceKindFast reflect the new id & contour immediately!
  const seedTerrain = createCityTerrain();
  const seedPuddle = seedTerrain.waterPuddles[0];
  seedPuddle.x = 200;
  seedPuddle.z = 200;
  seedPuddle.heading = 0;
  seedPuddle.halfWidth = 10;
  seedPuddle.halfLength = 10;
  assert.equal(sampleCitySurface(seedTerrain, 200, 200).zoneId, seedPuddle.id);
  seedPuddle.id = "renamed-runtime-puddle";
  assert.equal(sampleCitySurface(seedTerrain, 200, 200).zoneId, "renamed-runtime-puddle");
  // Find a boundary point where changing organicSeed flips water <-> asphalt!
  let flippedContour = false;
  for (let sCandidate = 1; sCandidate <= 40 && !flippedContour; sCandidate++) {
    for (let deg = 0; deg < 360 && !flippedContour; deg += 15) {
      const ang = (deg * Math.PI) / 180;
      const lobeA = puddleOrganicScale(ang, seedPuddle.organicSeed) * 0.94;
      const lobeB = puddleOrganicScale(ang, sCandidate * 7919) * 0.94;
      if (Math.abs(lobeA - lobeB) > 0.06) {
        const midR = (lobeA + lobeB) * 0.5;
        const px = 200 + Math.sin(ang) * 10 * midR;
        const pz = 200 + Math.cos(ang) * 10 * midR;
        const beforeKind = querySurfaceKindFast(seedTerrain, px, pz);
        seedPuddle.organicSeed = sCandidate * 7919;
        const afterKind = querySurfaceKindFast(seedTerrain, px, pz);
        if (beforeKind !== afterKind) {
          flippedContour = true;
        }
      }
    }
  }
  assert.equal(flippedContour, true, "mutating puddle organicSeed in place updates water boundary contour");

  // Also verify rotating a compiled puddle keeps physics & pointInWaterPuddle 100% synchronized AND renaming a puddle with explicit organicSeed preserves its exact footprint!
  const rotPuddleTerrain = createCityTerrain([], {
    waterPuddles: [{ id: "explicit-seed-puddle", x: 0, z: 0, heading: 0, halfWidth: 2.5, halfLength: 12.0, organicSeed: 123 }],
    sandZones: [],
    cobbleZones: [],
  });
  const p0 = rotPuddleTerrain.waterPuddles[0];
  assert.equal(p0.organicSeed, 123);
  assert.equal(sampleCitySurface(rotPuddleTerrain, 0, 8).surfaceKind, "water");
  assert.equal(pointInWaterPuddle(0, 8, p0, 0, 0), true);
  assert.equal(pointInWaterPuddle(8, 0, p0, 0, 0), false);
  // Rotate compiled puddle by 90 deg in place -> BOTH sampleCitySurface AND pointInWaterPuddle agree on (8, 0) water and (0, 8) asphalt!
  p0.heading = Math.PI / 2;
  assert.equal(sampleCitySurface(rotPuddleTerrain, 8, 0).surfaceKind, "water");
  assert.equal(querySurfaceKindFast(rotPuddleTerrain, 8, 0), "water");
  assert.equal(pointInWaterPuddle(8, 0, p0, 0, 0), true);
  assert.equal(sampleCitySurface(rotPuddleTerrain, 0, 8).surfaceKind, "asphalt");
  assert.equal(querySurfaceKindFast(rotPuddleTerrain, 0, 8), "asphalt");
  assert.equal(pointInWaterPuddle(0, 8, p0, 0, 0), false);
  // Rename id while keeping explicit organicSeed: 123 -> footprint and organicSeed MUST NOT be overwritten by id hash!
  const contourBeforeRename = Array.from({ length: 24 }, (_, k) => {
    const a = (k * Math.PI * 2) / 24;
    return [querySurfaceKindFast(rotPuddleTerrain, Math.cos(a) * 9.5, Math.sin(a) * 2.1), sampleCitySurface(rotPuddleTerrain, Math.cos(a) * 9.5, Math.sin(a) * 2.1).surfaceKind];
  });
  p0.id = "renamed-explicit-seed-puddle";
  assert.equal(sampleCitySurface(rotPuddleTerrain, 8, 0).zoneId, "renamed-explicit-seed-puddle");
  assert.equal(p0.organicSeed, 123);
  const contourAfterRename = Array.from({ length: 24 }, (_, k) => {
    const a = (k * Math.PI * 2) / 24;
    return [querySurfaceKindFast(rotPuddleTerrain, Math.cos(a) * 9.5, Math.sin(a) * 2.1), sampleCitySurface(rotPuddleTerrain, Math.cos(a) * 9.5, Math.sin(a) * 2.1).surfaceKind];
  });
  assert.deepStrictEqual(contourAfterRename, contourBeforeRename);

  // Verify { width: 20, length: 20 } puddle & exact unshaped raw edge (2, 0) match across physics and fast query!
  const wlTerrain = {
    waterPuddles: [{ id: "wl-puddle", x: 0, z: 0, width: 20, length: 20 }],
    sandZones: [{ id: "raw-rect-sand", x: 50, z: 0, halfWidth: 2, halfLength: 4 }],
    cobbleZones: [],
  };
  assert.equal(pointInWaterPuddle(6.5, 0, wlTerrain.waterPuddles[0], 0, 0), true);
  assert.equal(querySurfaceKindFast(wlTerrain, 6.5, 0), "water");
  assert.equal(querySurfaceKindFast(wlTerrain, 52, 0), "asphalt");
  assert.equal(querySurfaceKindFast(wlTerrain, 51.999, 0), "sand");

  // Mutating width: 4 -> halfWidth: 4 on the same puddle object (resolved halfWidth 2 -> 4) MUST invalidate cache in BOTH sampleCitySurface & querySurfaceKindFast!
  const dimSwitchTerrain = {
    waterPuddles: [{ id: "dim-switch-puddle", x: 0, z: 0, width: 4, length: 12, organicSeed: 7 }],
    sandZones: [],
    cobbleZones: [],
  };
  assert.equal(sampleCitySurface(dimSwitchTerrain, 2.4, 0).surfaceKind, "asphalt");
  assert.equal(querySurfaceKindFast(dimSwitchTerrain, 2.4, 0), "asphalt");
  dimSwitchTerrain.waterPuddles[0].halfWidth = 4;
  assert.equal(pointInWaterPuddle(2.4, 0, dimSwitchTerrain.waterPuddles[0], 0, 0), true);
  assert.equal(sampleCitySurface(dimSwitchTerrain, 2.4, 0).surfaceKind, "water");
  assert.equal(querySurfaceKindFast(dimSwitchTerrain, 2.4, 0), "water");

  // Verify actual vehicle physics inside World responds to dynamically appended sand zone
  const wAsphalt = new World({ seed: "dyn-phys-sand", cityVersion: 5, traffic: 0, pedestrians: 0 }, "metro");
  const wSand = new World({ seed: "dyn-phys-sand", cityVersion: 5, traffic: 0, pedestrians: 0 }, "metro");
  for (const wTest of [wAsphalt, wSand]) {
    wTest.command({ type: "mode", mode: "manual" });
    wTest.command({ type: "drive", targetSpeed: 0, steer: 0 });
    wTest.player.x = -238;
    wTest.player.z = -109.5;
    wTest.player.heading = Math.PI / 2;
    wTest.player.speed = 14.0;
  }
  wSand.terrain.sandZones.push({
    id: "runtime-phys-sand",
    kind: "sand",
    shape: "strip",
    x: -228,
    z: -109.5,
    heading: Math.PI / 2,
    halfWidth: 8,
    halfLength: 28,
    depthM: 0.04,
  });
  for (let t = 0; t < 30; t++) {
    wAsphalt.step();
    wSand.step();
  }
  // Lower tire grip on sand reduces emergency braking deceleration, sliding significantly faster/further than dry asphalt
  assert.ok(
    wSand.player.speed > wAsphalt.player.speed + 0.5,
    `expected dynamically appended sand zone to reduce braking grip in actual vehicle physics (${wSand.player.speed} vs ${wAsphalt.player.speed})`,
  );
  for (let gx = -110; gx <= 40; gx += 7.5) {
    for (let gz = -45; gz <= 90; gz += 9.5) {
      assert.equal(
        querySurfaceKindFast(plainTerrain, gx, gz),
        referenceQuerySurfaceKind(plainTerrain, gx, gz),
        `plainTerrain mismatch at (${gx}, ${gz})`,
      );
    }
  }
  assert.equal(querySurfaceKindFast(null, 0, 0), "asphalt");
  assert.equal(querySurfaceKindFast(plainTerrain, NaN, 0), "asphalt");
  assert.equal(querySurfaceKindFast(plainTerrain, 0, Infinity), "asphalt");
});

test("3. Performance benchmark: 60 PursuitScanner.sample calls average < 0.85 ms (210 peds + 68 traffic + 14 patrols) and 10,000 querySurfaceKindFast calls finish in < 8 ms", () => {
  const world = new World(
    { seed: "bench-ultra-smooth-20261125", cityVersion: 5, traffic: 68, pedestrians: 210 },
    "metro",
  );
  world.command({
    type: "street-pursuit-start",
    variant: "gta",
    config: {
      ruleset: "dispatch-v1",
      wantedLevelStart: 5,
      maxActivePatrols: 14,
      enableRoadblocks: false,
      curbSupport: METRO_CITY_CURBS,
      chasePresence: AGGRESSIVE_CHASE_PRESENCE,
    },
  });
  for (let i = 0; i < 18; i++) world.step();

  const patrolCount = world.actors.filter((a) => a.pursuitRole === "police").length;
  const trafficCount = world.actors.filter((a) => a.type === "vehicle" && a.pursuitRole !== "police" && a !== world.player).length;
  const pedCount = world.actors.filter((a) => a.type === "pedestrian").length;
  assert.equal(patrolCount, 14, `expected 14 active police patrols, got ${patrolCount}`);
  assert.equal(trafficCount, 68, `expected 68 civilian traffic vehicles, got ${trafficCount}`);
  assert.equal(pedCount, 210, `expected 210 pedestrians, got ${pedCount}`);

  // Also spawn +20 dense crowd ahead so pedestrian fine-beam raycasting is heavily loaded
  world.command({ type: "spawn-crowd-ahead", count: 20 });

  const scanner = new PursuitScanner();
  // Warm up V8 JIT
  for (let w = 0; w < 12; w++) {
    world.tick += PURSUIT_SCAN_TICKS;
    scanner.sample(world);
  }

  let rayChecksum = 0;
  let avgScanMs = Infinity;
  for (let trial = 0; trial < 3; trial++) {
    const tScan0 = performance.now();
    for (let i = 0; i < 60; i++) {
      world.tick += PURSUIT_SCAN_TICKS;
      world.player.heading = (world.player.heading ?? 0) + 0.035;
      const frame = scanner.sample(world);
      rayChecksum += frame.rays[0].rangeM + frame.longRangeForward.minCorridorM + frame.tracks.length;
    }
    avgScanMs = Math.min(avgScanMs, (performance.now() - tScan0) / 60);
  }

  assert.ok(Number.isFinite(rayChecksum) && rayChecksum > 0);
  assert.ok(
    avgScanMs < 0.85,
    `expected avg PursuitScanner.sample < 0.85 ms across 60 scans, got ${avgScanMs.toFixed(4)} ms`,
  );

  // Warm up querySurfaceKindFast
  const terrain = world.terrain;
  for (let w = 0; w < 300; w++) {
    querySurfaceKindFast(terrain, -220 + w * 1.5, -112 + (w % 17) * 3);
  }

  let nonAsphaltCount = 0;
  let totalSurfMs = Infinity;
  for (let trial = 0; trial < 3; trial++) {
    nonAsphaltCount = 0;
    const tSurf0 = performance.now();
    for (let i = 0; i < 10000; i++) {
      const qx = -500 + ((i * 37) % 920);
      const qz = -410 + ((i * 53) % 760);
      if (querySurfaceKindFast(terrain, qx, qz) !== "asphalt") nonAsphaltCount++;
    }
    totalSurfMs = Math.min(totalSurfMs, performance.now() - tSurf0);
  }
  const surf10kMs = totalSurfMs;

  assert.ok(nonAsphaltCount > 100, `expected queries to hit surface zones, got ${nonAsphaltCount}`);
  assert.ok(
    surf10kMs < 8,
    `expected 10,000 querySurfaceKindFast calls < 8 ms, got ${surf10kMs.toFixed(4)} ms`,
  );
});
