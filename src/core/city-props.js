import { isDiagonalRoad, overlaps, roadFrame, roadPointAt, roadRect } from "./geometry.js";
import { SpatialIndex } from "./spatial-index.js";

export const CITY_PROP_PROFILE = "solid-city-props-v1";

function hash2D(x, y, seed = 0) {
  let h = Math.imul(x ^ Math.imul(seed, 0x9e3779b9), 0x85ebca6b);
  h = Math.imul(h ^ Math.imul(y, 0xc2b2ae35), 0x27d4eb2f);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  return (h >>> 0) / 4294967295;
}

function roadEnvelope(road) {
  if (isDiagonalRoad(road)) {
    const f = roadFrame(road);
    return { x: (f.x1 + f.x2) / 2, z: (f.z1 + f.z2) / 2,
      width: road.width, length: f.length + road.width, heading: f.heading, roadRef: road };
  }
  const r = roadRect(road, 0);
  return { x: (r.minX + r.maxX) / 2, z: (r.minZ + r.maxZ) / 2,
    width: r.maxX - r.minX, length: r.maxZ - r.minZ, heading: 0, roadRef: road };
}

function withinRoad(x, z, road, width = 0, end = 0) {
  const half = road.width / 2 + width, allowance = road.width / 2 + end;
  if (isDiagonalRoad(road)) {
    const f = roadFrame(road), dx = x - f.x1, dz = z - f.z1;
    const along = dx * f.ux + dz * f.uz;
    return along >= -allowance && along <= f.length + allowance &&
      Math.abs(-dx * f.uz + dz * f.ux) <= half;
  }
  const fixed = road.axis === "z" ? x : z, along = road.axis === "z" ? z : x;
  return Math.abs(fixed - road.fixed) <= half &&
    along >= road.min - allowance && along <= road.max + allowance;
}

// The original street-surface placement algorithm, shared with physical ownership.
// Lamps are placed first because their exclusion zones determine tree positions.
export function collectCityStreetProps(world) {
  const roads = world.roads ?? world.drivingRoads ?? [];
  const statics = (world.statics ?? []).filter(s => s.kind !== "city-tree");
  const staticIndex = new SpatialIndex(statics, 40);
  const staticReach = statics.reduce((m, s) => Math.max(m, Math.hypot(s.width, s.length) / 2), 24);
  const envelopes = roads.map(roadEnvelope), roadIndex = new SpatialIndex(envelopes, 64);
  const roadReach = envelopes.reduce((m, s) => Math.max(m, Math.hypot(s.width, s.length) / 2), 60);
  const crossings = [];
  for (const w of world.walkways ?? []) {
    if (!w.crosswalk && !w.doorway) continue;
    if (isDiagonalRoad(w)) {
      const f = roadFrame(w);
      crossings.push({ x: f.x1, z: f.z1 }, { x: (f.x1 + f.x2) / 2, z: (f.z1 + f.z2) / 2 },
        { x: f.x2, z: f.z2 });
    } else for (const along of [w.min, (w.min + w.max) / 2, w.max])
      crossings.push(w.axis === "z" ? { x: w.fixed, z: along } : { x: along, z: w.fixed });
  }
  const placed = new SpatialIndex([], 16), result = { lamps: [], trees: [], furniture: [] };
  const candidates = roads.filter(r => r && !r.parkingBay && !r.supportApron && r.width >= 6);
  const clear = (road, p, heading, ground, radial, roadClear, gap) => {
    const reach = Math.max(ground * Math.SQRT2, radial);
    const probe = { ...p, width: reach * 2, length: reach * 2, heading };
    for (const env of roadIndex.near(probe, roadReach + reach + 8)) {
      const r = env.roadRef;
      if (overlaps(probe, env, .12)) return false;
      if (r === road) {
        if (withinRoad(p.x, p.z, r, reach + .08)) return false;
      } else {
        const extra = r.parkingBay || r.supportApron
          ? Math.max(3.2, reach + .5) : Math.max(roadClear, reach + .5);
        if (withinRoad(p.x, p.z, r, extra, extra)) return false;
      }
    }
    if (staticIndex.near(probe, staticReach + reach + 2).some(s => overlaps(probe, s, .25))) return false;
    if (crossings.some(c => Math.hypot(p.x - c.x, p.z - c.z) < 3.4)) return false;
    return !placed.near(probe, gap + 1).some(s => Math.hypot(p.x - s.x, p.z - s.z) < gap);
  };
  for (const kind of ["lamps", "trees", "furniture"]) {
    candidates.forEach((road, roadIndex) => {
      if (kind === "lamps" && !(road.zone === "avenue" || (!road.sideStreet && road.width >= 9.5))) return;
      const f = roadFrame(road);
      if (f.length < (kind === "lamps" ? 28 : kind === "trees" ? 30 : 32)) return;
      for (const side of [-1, 1]) {
        const start = kind === "lamps" ? (side > 0 ? 16 : 38)
          : kind === "trees" ? (side > 0 ? 27 : 20) : (side > 0 ? 21 : 33);
        const spacing = kind === "lamps" ? 44 : kind === "trees" ? 38 : 46;
        const end = kind === "lamps" ? 14 : kind === "trees" ? 15 : 16;
        let slot = 0;
        for (let along = f.minAlong + start; along <= f.maxAlong - end; along += spacing) {
          const p = roadPointAt(road, along, side * (road.width / 2 + (kind === "furniture" ? 2.65 : 1.55)));
          const heading = f.heading + (side < 0 ? Math.PI : 0);
          const scale = kind === "trees" ? .88 + .16 * hash2D(slot++, roadIndex, 0x8123) : 1;
          const args = kind === "lamps" ? [.25, .35, 4.2, 4.2]
            : kind === "trees" ? [.46 * scale, 1.24 * scale, 4.5, 4.8] : [.5, .58, 4.5, 4.4];
          if (!clear(road, p, heading, ...args)) continue;
          const entry = { x: p.x, y: .07 + (world.terrainElevationAt?.(p.x, p.z) ?? 0),
            z: p.z, heading, scale };
          result[kind].push(entry);
          placed.add(entry);
        }
      }
    });
  }
  return result;
}

const freshImpact = () => ({ hits: 0, damage: 0, lastTick: -1, directionX: 0, directionZ: 1 });

export function registerCityProps(world) {
  if (world.config.cityPropProfile !== CITY_PROP_PROFILE) return [];
  const placements = collectCityStreetProps(world);
  const trees = placements.trees.map((p, index) => ({
    ...p, id: `city-tree-${index}`, type: "static", kind: "city-tree",
    width: .41 * p.scale, length: .41 * p.scale, height: 5.52 * p.scale,
    propImpact: freshImpact(),
  }));
  for (const site of world.statics)
    if (site.kind === "market-stall") site.propImpact = freshImpact();
  world.statics.push(...trees);
  world.cityStreetProps = placements;
  return trees;
}

export function recordCityPropImpact(world, obstacle, contact) {
  if (!obstacle?.propImpact || !contact || contact.closingSpeedMps < .35) return false;
  const state = obstacle.propImpact;
  if (state.hits > 0 && state.lastTick >= world.tick - 8) return false;
  state.hits++;
  state.damage = Math.min(1, state.damage + Math.min(.65, contact.closingSpeedMps / 22));
  state.lastTick = world.tick;
  state.directionX = contact.normal.x;
  state.directionZ = contact.normal.z;
  return true;
}

export function cityPropVisualState(world, site) {
  const state = site.propImpact ?? freshImpact();
  const elapsed = Math.max(0, (world.tick - state.lastTick) / 60);
  const bend = site.kind === "city-tree"
    ? Math.min(.24, state.damage * .18 + Math.sin(elapsed * 8) * Math.exp(-elapsed * 2) * state.damage * .1)
    : 0;
  return { damage: state.damage, bendX: state.directionZ * bend || 0,
    bendZ: -state.directionX * bend || 0, crush: site.kind === "market-stall" ? state.damage * .42 : 0 };
}

// Lower trunk / kiosk plinth never changes its horizontal footprint.
export function resetCityPropImpacts(world) {
  for (const site of world.statics) if (site.propImpact) Object.assign(site.propImpact, freshImpact());
}

export function cityPropImpactTargets(world) {
  return world.statics.filter(s => s.propImpact).map(s => ({
    id: s.id, kind: s.kind, x: s.x, z: s.z, width: s.width, length: s.length,
    heading: s.heading, visual: cityPropVisualState(world, s),
  }));
}
