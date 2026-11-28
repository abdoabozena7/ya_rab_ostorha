import { STEP, VEHICLE, clamp } from "./config.js";
import { Random } from "./random.js";
import { angleDelta, bodyOnRoad, overlaps, roadFrame } from "./geometry.js";
import {
  coordsOn, idealPathSpeed, lanePoint, laneFrame, normalizeAngle, straightLanePath, zoneAheadM,
} from "./lane-geometry.js";
import { SpatialIndex } from "./spatial-index.js";
import { getPatrolVisualDamage, recordActorVisualCrash } from "./pursuit-world.js";

// Re-exported so existing street-chaos importers keep working.
export { coordsOn, idealPathSpeed, laneFrame, lanePoint, straightLanePath, zoneAheadM };

export const STREET_CHAOS_VERSION = "cairo-traffic-v1";
export const CHAOS_INTENSITIES = Object.freeze(["normal", "rush", "max"]);
export const CHAOS_EVENT_KINDS = Object.freeze(["ghorz", "lane-change", "accident"]);

export const TRUCK_SPEC = Object.freeze({
  kind: "truck",
  lengthM: 8.2,
  widthM: 2.45,
  heightM: 3.35,
  wheelbaseM: 4.9,
  massKg: 14500,
  maxSteerRad: 0.40,
  steerRateRadS: 0.48,
  accelerationMps2: 1.15,
  brakingMps2: 4.1,
  tireGripMps2: 5.2,
  reverseSpeedMps: 2.0,
  maxSpeedFactor: 0.76,
});

const classRow = (row) => Object.freeze(row);
export const VEHICLE_CLASS_DYNAMICS = Object.freeze({
  // Light and nimble: darts into gaps and hugs the kerb.
  tuktuk: classRow({
    massKg: 420, wheelbase: 1.9, maxSteer: 0.72, steerRate: 2.1, acceleration: 3.1, braking: 6.2,
    tireGripMps2: 6.4, speedFactor: 1, offLaneTendency: 0.85, cutInAggression: 0.8, lateralAccelMps2: 4.6,
  }),
  // Agile weavers and late lane cutters.
  sedan: classRow({
    massKg: 1350, wheelbase: 2.6, maxSteer: 0.62, steerRate: 1.55, acceleration: 3.0, braking: 7.4,
    tireGripMps2: 8, speedFactor: 1.12, offLaneTendency: 0.5, cutInAggression: 0.9, lateralAccelMps2: 5,
  }),
  taxi: classRow({
    massKg: 1350, wheelbase: 2.6, maxSteer: 0.62, steerRate: 1.55, acceleration: 3.0, braking: 7.4,
    tireGripMps2: 8, speedFactor: 1.12, offLaneTendency: 0.6, cutInAggression: 1, lateralAccelMps2: 5,
  }),
  // Assertive lane bullies.
  suv: classRow({
    massKg: 1950, wheelbase: 2.8, maxSteer: 0.56, steerRate: 1.25, acceleration: 2.6, braking: 6.8,
    tireGripMps2: 7.6, speedFactor: 1.04, offLaneTendency: 0.4, cutInAggression: 0.75, lateralAccelMps2: 4.2,
  }),
  // Microbuses sweep wide and straddle lanes.
  van: classRow({
    massKg: 2300, wheelbase: 3.2, maxSteer: 0.52, steerRate: 1.05, acceleration: 2.0, braking: 5.9,
    tireGripMps2: 6.6, speedFactor: 0.96, offLaneTendency: 0.7, cutInAggression: 0.5, lateralAccelMps2: 3.6,
  }),
  // Heavy freight: sluggish, wide arcs, long stopping distance.
  truck: classRow({
    massKg: TRUCK_SPEC.massKg, wheelbase: TRUCK_SPEC.wheelbaseM, maxSteer: TRUCK_SPEC.maxSteerRad,
    steerRate: TRUCK_SPEC.steerRateRadS, acceleration: TRUCK_SPEC.accelerationMps2,
    braking: TRUCK_SPEC.brakingMps2, tireGripMps2: TRUCK_SPEC.tireGripMps2,
    speedFactor: TRUCK_SPEC.maxSpeedFactor, offLaneTendency: 0.3, cutInAggression: 0.15,
    lateralAccelMps2: 2.2,
  }),
});

const INTENSITY = Object.freeze({
  normal: { trucks: 4, nearTrucks: 2, offLane: 0.35, interval: [15, 22], accidentCooldownS: 55, maxActive: 1 },
  rush: { trucks: 5, nearTrucks: 3, offLane: 0.5, interval: [9, 15], accidentCooldownS: 38, maxActive: 2 },
  max: { trucks: 6, nearTrucks: 3, offLane: 0.7, interval: [6, 10], accidentCooldownS: 26, maxActive: 3 },
});

const EVENT_LABEL = Object.freeze({
  ghorz: "Ghorz cut-in",
  "lane-change": "Sudden lane change",
  accident: "Accident ahead",
});
const TICKS = (seconds) => Math.round(seconds / STEP);
const RECENT_LIMIT = 12;
const NEAR_COMMAND_M = 115;

const originals = new WeakMap();
const traits = new WeakMap();
const maneuvers = new WeakMap();

export function classOfVehicle(actor) {
  return VEHICLE_CLASS_DYNAMICS[actor?.kind] ? actor.kind : "sedan";
}

// City routes are planned for ~3.6 m junction arcs; ambient cars keep enough lock to follow them.
export const PLANNED_TURN_RADIUS_M = 3.6;

export function classSpec(kind, realistic = false) {
  const row = VEHICLE_CLASS_DYNAMICS[kind] ?? VEHICLE_CLASS_DYNAMICS.sedan;
  const routeLock = kind === "truck" ? 0 : Math.atan(row.wheelbase / PLANNED_TURN_RADIUS_M);
  return {
    wheelbase: row.wheelbase, maxSteer: Math.max(row.maxSteer, routeLock), steerRate: row.steerRate,
    acceleration: row.acceleration, braking: row.braking, reverseSpeed: kind === "truck" ? 2.0 : 2.5,
    tireGripMps2: row.tireGripMps2, massKg: row.massKg, realisticDynamics: realistic,
  };
}

function truckSpec() {
  return {
    realisticDynamics: true, wheelbase: TRUCK_SPEC.wheelbaseM, maxSteer: TRUCK_SPEC.maxSteerRad,
    steerRate: TRUCK_SPEC.steerRateRadS, acceleration: TRUCK_SPEC.accelerationMps2,
    braking: TRUCK_SPEC.brakingMps2, tireGripMps2: TRUCK_SPEC.tireGripMps2,
    massKg: TRUCK_SPEC.massKg, reverseSpeed: TRUCK_SPEC.reverseSpeedMps,
  };
}



export function bodyExtentsOnLane(frame, body) {
  const c = coordsOn(frame.road, frame.d, body);
  const rel = (body.heading ?? 0) - frame.laneHeading;
  const sn = Math.abs(Math.sin(rel));
  const cs = Math.abs(Math.cos(rel));
  const isPed = body.type === "pedestrian";
  const length = isPed ? (body.radius ?? 0.4) * 2 : body.length ?? 4.2;
  const width = isPed ? length : body.width ?? 1.85;
  const hs = cs * length / 2 + sn * width / 2;
  const hl = sn * length / 2 + cs * width / 2;
  return { s: c.s, lat: c.lat, sMin: c.s - hs, sMax: c.s + hs, latMin: c.lat - hl, latMax: c.lat + hl };
}


function aheadRoomM(frame) {
  return frame.d > 0 ? frame.road.max - frame.along : frame.along - frame.road.min;
}

/* ------------------------------------------------------------------ slots */

function inJunctionZone(world, body, margin) {
  const zones = world.district?.conflictZones;
  if (!zones) return false;
  const reach = Math.hypot(body.length ?? 4.2, body.width ?? 1.85) / 2 + margin;
  for (let i = 0; i < zones.length; i++) {
    const z = zones[i];
    if (body.x > z.minX - reach && body.x < z.maxX + reach && body.z > z.minZ - reach && body.z < z.maxZ + reach)
      return true;
  }
  return false;
}

function slotReason(world, body, { actorGap = 2.4, staticGap = 0.5, minPlayerDistance = 16, zoneMargin = 4,
  roadMargin = 0.3, ignore = null } = {}) {
  if (!bodyOnRoad(body, world.roads, roadMargin)) return "off-road";
  if (zoneMargin >= 0 && inJunctionZone(world, body, zoneMargin)) return "junction";
  const player = world.player;
  if (Math.hypot(body.x - player.x, body.z - player.z) < minPlayerDistance) return "near-player";
  if (overlaps(body, player, actorGap)) return "near-player";
  for (let i = 0; i < world.actors.length; i++) {
    const other = world.actors[i];
    if (other === ignore) continue;
    if (overlaps(body, other, other.type === "pedestrian" ? 0.1 : actorGap)) return other.type === "pedestrian" ? "pedestrian" : "traffic";
  }
  const statics = world.staticIndex.near(body, 14);
  for (let i = 0; i < statics.length; i++) if (overlaps(body, statics[i], staticGap)) return "statics";
  return null;
}

const slotFree = (world, body, options) => slotReason(world, body, options) === null;
function regionClear(world, frame, sMin, sMax, latMin, latMax, ignore = []) {
  for (const actor of world.actors) {
    if (actor === world.player || actor.type === "pedestrian" || ignore.includes(actor)) continue;
    const e = bodyExtentsOnLane(frame, actor);
    if (e.sMax > sMin && e.sMin < sMax && e.latMax > latMin && e.latMin < latMax) return false;
  }
  return true;
}

function staticsClear(world, frame, sMin, sMax, latMin, latMax) {
  const mid = lanePoint(frame.road, frame.d, (sMin + sMax) / 2, (latMin + latMax) / 2);
  const near = world.staticIndex.near(mid, (sMax - sMin) / 2 + 30);
  for (let i = 0; i < near.length; i++) {
    const e = bodyExtentsOnLane(frame, near[i]);
    if (e.sMax > sMin && e.sMin < sMax && e.latMax > latMin && e.latMin < latMax) return false;
  }
  return true;
}


function setActors(world, actors) {
  world.actors = actors;
  world.actorIndex = new SpatialIndex(world.actors);
  world._queueActorsSourceLen = -1;
}

function addActor(world, actor) {
  world.actors.push(actor);
  world.actorIndex = new SpatialIndex(world.actors);
  world._queueActorsSourceLen = -1;
}

function removeActors(world, predicate) {
  if (!world.actors.some(predicate)) return 0;
  const before = world.actors.length;
  setActors(world, world.actors.filter((actor) => !predicate(actor)));
  return before - world.actors.length;
}

/* ------------------------------------------------------------------ state */

function activeState(world) {
  const state = world.streetChaos;
  return state?.active ? state : null;
}

// While an accident is ahead the Defensive AI keeps to its avenue instead of turning off before the wreck.
export function accidentRouteLock(world, ego = world.player) {
  const state = world.streetChaos?.active ? world.streetChaos : null;
  if (!state) return null;
  const acc = state.accident;
  if (!acc) {
    // A requested accident that has no site yet: go straight while rolling on an open stretch, never locking into a road end or jam.
    if (!state.pending.some((entry) => entry.kind === "accident")) return null;
    if ((world.districtBehavior?.holds?.[ego.id]?.waitS ?? 0) > 6) return null;
    const frame = laneFrame(world, ego, { minWidth: 9.5 });
    if (!frame || aheadRoomM(frame) < 95) return null;
    return { road: frame.road, d: frame.d, halfW: frame.halfW, laneOffset: frame.laneOffset, laneHeading: frame.laneHeading, sEgo: frame.s, sLimit: frame.s + 140 };
  }
  const here = coordsOn(acc.road, acc.d, ego);
  if (Math.abs(here.lat) > acc.halfW || Math.abs(angleDelta(ego.heading, acc.laneHeading)) > 0.8) return null;
  if (here.s > acc.sMax + 8) return null;
  return { road: acc.road, d: acc.d, halfW: acc.halfW, laneOffset: acc.laneOffset, laneHeading: acc.laneHeading, sEgo: here.s, sLimit: acc.sMax + 10 };
}

export function isStreetChaosAccidentActor(world, actor) {
  const state = world?.streetChaos;
  return Boolean(state?.active && actor && state.accidentActorIds.includes(actor.id));
}

const isChaosSpawn = (actor) => typeof actor.id === "string" &&
  (actor.id.startsWith("chaos-truck-") || actor.id.startsWith("chaos-event-"));

export function streetChaosActorNeedsCommand(world, actor) {
  const state = activeState(world);
  if (!state || actor.type !== "vehicle") return false;
  if (maneuvers.has(actor) || actor.kind === "truck" || isChaosSpawn(actor)) return true;
  const dx = actor.x - world.player.x;
  const dz = actor.z - world.player.z;
  return dx * dx + dz * dz <= 75 * 75;
}

function applyClassPhysics(actor) {
  if (originals.has(actor) || actor.type !== "vehicle" || actor.id === "player" || actor.pursuitRole) return;
  originals.set(actor, { spec: actor.spec, maxSpeed: actor.maxSpeed });
  if (actor.kind === "truck" && actor.spec?.massKg === TRUCK_SPEC.massKg) return;
  const cls = classOfVehicle(actor);
  actor.spec = classSpec(cls, false);
  actor.maxSpeed = actor.maxSpeed * VEHICLE_CLASS_DYNAMICS[cls].speedFactor;
}

function traitsOf(world, state, actor) {
  let t = traits.get(actor);
  if (t) return t;
  const rng = new Random(`${state.seed}:${actor.id}`);
  const cls = classOfVehicle(actor);
  const row = VEHICLE_CLASS_DYNAMICS[cls];
  const rate = INTENSITY[state.intensity].offLane * row.offLaneTendency;
  const offLane = rng.next() < rate;
  const magnitude = rng.range(0.7, 1.7) * (cls === "van" ? 1.15 : 1);
  t = {
    cls,
    offLaneOffsetM: offLane ? (rng.next() < 0.62 ? -magnitude : magnitude * 0.7) : 0,
    wanderAmpM: offLane ? rng.range(0.25, 0.6) : 0,
    wanderPeriodS: rng.range(6, 11),
    wanderPhase: rng.range(0, Math.PI * 2),
    bypass: null,
    creepUntil: 0,
  };
  traits.set(actor, t);
  return t;
}

/* ------------------------------------------------------------- spawn code */

function makeTruck(world, state, id, frame, s, speed, path, lat = -frame.laneOffset) {
  const pose = lanePoint(frame.road, frame.d, s, lat);
  const baseSpeed = world.config.speedLimit / 3.6;
  return {
    id, type: "vehicle", kind: "truck", x: pose.x, z: pose.z, heading: frame.laneHeading,
    speed, steer: 0, length: TRUCK_SPEC.lengthM, width: TRUCK_SPEC.widthM, spec: truckSpec(),
    maxSpeed: baseSpeed * TRUCK_SPEC.maxSpeedFactor, path, cursor: 0, distance: 0, wait: 0,
    reason: "ready", phase: state.rng.next(), reckless: false,
    height: TRUCK_SPEC.heightM, chaseSlipRad: 0,
    district: {
      profile: "cautious", headwayS: 2.6, nextLoadingDistanceM: Infinity, loadingDurationS: 1,
      loadingUntilTick: null, reroutedTicket: null,
    },
  };
}

// Trucks only ever see the wide avenues, so they can never wedge into a five-metre alley.
const truckViewCache = new WeakMap();
export function streetChaosTruckView(world) {
  const district = world.district;
  let view = truckViewCache.get(district);
  if (!view) {
    view = { ...district, drivingRoads: district.drivingRoads.filter((road) =>
      road.width >= 10 && !road.parkingBay && !road.supportApron) };
    truckViewCache.set(district, view);
  }
  return view;
}

function wideAvenues(world) {
  const all = streetChaosTruckView(world).drivingRoads.filter((road) => road.width >= 11);
  const avenues = all.filter((road) => road.zone === "avenue");
  return avenues.length ? avenues : all;
}

function trySpawnTruck(world, state, { near, minPlayerDistance = 16, minAheadM = 45 }) {
  const rng = state.rng;
  const ego = world.player;
  const egoFrame = laneFrame(world, ego, { minWidth: 11 });
  const roads = wideAvenues(world);
  if (!roads.length) return null;
  for (let attempt = 0; attempt < 90; attempt++) {
    let frame;
    let s;
    if (near && egoFrame) {
      frame = egoFrame;
      s = egoFrame.s + minAheadM + rng.range(0, 40) + attempt * 2.5;
    } else {
      const road = rng.pick(roads);
      const d = rng.next() < 0.5 ? 1 : -1;
      const f = roadFrame(road);
      const base = { road, d, laneOffset: road.laneOffsetM ?? 2.6, laneHeading: d > 0 ? f.heading : normalizeAngle(f.heading + Math.PI) };
      const here = coordsOn(road, d, ego);
      s = here.s + rng.range(-230, 230);
      frame = base;
    }
    const road = frame.road;
    const along = frame.d * s;
    if (along < road.min + 30 || along > road.max - 30) continue;
    const room = frame.d > 0 ? road.max - along : along - road.min;
    if (room < 110) continue;
    const p = lanePoint(road, frame.d, s, -frame.laneOffset);
    const body = { type: "vehicle", x: p.x, z: p.z, heading: frame.laneHeading,
      length: TRUCK_SPEC.lengthM, width: TRUCK_SPEC.widthM };
    if (!slotFree(world, body, { minPlayerDistance, actorGap: 3, zoneMargin: 6 })) continue;
    const path = straightLanePath(frame, s, -frame.laneOffset, Math.min(380, room - 14));
    if (!path.length) continue;
    const truck = makeTruck(world, state, `chaos-truck-${++state.serial.truck}`, frame, s, 5.5, path);
    originals.set(truck, { spec: truck.spec, maxSpeed: truck.maxSpeed });
    return truck;
  }
  return null;
}

// One freight truck shares the player's avenue within 24â€“60 m, checking forward static clearance so it keeps flowing instead of parking at a kerbside car.
function trySpawnCloseTruck(world, state) {
  const ego = world.player;
  const ef = laneFrame(world, ego, { minWidth: 11 });
  if (!ef) return null;
  const f = roadFrame(ef.road);
  const outerFreightLat = ef.halfW >= 6.6 ? -(ef.halfW - TRUCK_SPEC.widthM / 2 - 0.5) : null;
  const candidates = outerFreightLat !== null
    ? [[ef.d, outerFreightLat], [-ef.d, -ef.laneOffset]]
    : [[-ef.d, -ef.laneOffset], [ef.d, -ef.laneOffset]];
  for (const [d, lat] of candidates) {
    for (const ahead of [44, 48, 38, 52, 34, 56, 40, 30, 58, 27, 36, 46, 50, 32, 55]) {
      const along = ef.along + ef.d * ahead;
      const frame = {
        road: ef.road, d, laneOffset: ef.laneOffset,
        laneHeading: d > 0 ? f.heading : normalizeAngle(f.heading + Math.PI),
      };
      const s = d * along;
      const room = d > 0 ? ef.road.max - along : along - ef.road.min;
      if (along < ef.road.min + 20 || along > ef.road.max - 20 || room < 60) continue;
      const p = lanePoint(ef.road, d, s, lat);
      const body = { type: "vehicle", x: p.x, z: p.z, heading: frame.laneHeading, length: TRUCK_SPEC.lengthM, width: TRUCK_SPEC.widthM };
      if (!slotFree(world, body, { minPlayerDistance: 16, actorGap: 2.2, zoneMargin: 4 }) || !bodyOnRoad(body, world.roads, 0.15)) continue;
      const path = straightLanePath(frame, s, lat, Math.min(380, room - 14));
      if (!path.length) continue;
      const truck = makeTruck(world, state, `chaos-truck-${++state.serial.truck}`, frame, s, d === ef.d ? 6.2 : 5.5, path, lat);
      originals.set(truck, { spec: truck.spec, maxSpeed: truck.maxSpeed });
      return truck;
    }
  }
  return null;
}

function spawnChaosTrucks(world, state) {
  const cfg = INTENSITY[state.intensity];
  for (let i = 0; i < cfg.trucks; i++) {
    const truck = (i === cfg.trucks - 1 ? trySpawnCloseTruck(world, state) : null) ?? trySpawnTruck(world, state, { near: i < cfg.nearTrucks, minAheadM: 40 + i * 42 });
    if (!truck) continue;
    world.actors.push(truck);
    world.actorIndex = new SpatialIndex(world.actors);
    state.trucks.push(truck);
    traitsOf(world, state, truck);
  }
  world._queueActorsSourceLen = -1;
}

function makeEventVehicle(world, state, kind, frame, s, lat, speed, pathLenM) {
  const p = lanePoint(frame.road, frame.d, s, lat);
  const car = world.makeVehicle(`chaos-event-${++state.serial.temp}`, kind,
    { x: p.x, z: p.z, heading: frame.laneHeading }, state.rng);
  const cls = classOfVehicle(car);
  originals.set(car, { spec: car.spec, maxSpeed: car.maxSpeed });
  car.spec = classSpec(cls, false);
  car.maxSpeed = (world.config.speedLimit / 3.6) * (kind === "tuktuk" ? 0.7 : 1) * VEHICLE_CLASS_DYNAMICS[cls].speedFactor;
  car.speed = speed;
  car.reckless = false;
  car.path = straightLanePath(frame, s, lat, pathLenM);
  car.cursor = 0;
  car.district = {
    profile: "assertive", headwayS: 1, nextLoadingDistanceM: Infinity, loadingDurationS: 1,
    loadingUntilTick: null, reroutedTicket: null,
  };
  return car;
}

/* ----------------------------------------------------------- begin / end */

export function beginStreetChaos(world, options = {}) {
  if (world.environment !== "metro") throw new Error("Cairo Traffic is only available in City");
  if (world.pursuit?.phase === "running") throw new Error("End Chase before starting Cairo Traffic");
  const intensity = options.intensity ?? "rush";
  if (!CHAOS_INTENSITIES.includes(intensity)) throw new RangeError("Unknown Cairo Traffic intensity");
  const requestedDriver = options.driverMode ?? "auto";
  if (requestedDriver !== "auto" && requestedDriver !== "manual") throw new RangeError("Unknown Cairo Traffic driver mode");
  const existing = world.streetChaos;
  if (existing?.active) {
    existing.intensity = intensity;
    existing.driverMode = requestedDriver;
    world.mode = requestedDriver;
    return existing;
  }
  const seed = `${world.config.seed}:street-chaos:${world.tick}:${intensity}`;
  const cfg = INTENSITY[intensity];
  const rng = new Random(seed);
  const impacts = world.player.vehicle?.damage?.impactCount ?? 0;
  const state = {
    version: STREET_CHAOS_VERSION, active: true, intensity, driverMode: requestedDriver,
    disableDefensiveAvoidance: options.disableDefensiveAvoidance === true,
    previousMode: world.mode, startedTick: world.tick, seed, rng,
    nextEventTick: world.tick + TICKS(2.5 + rng.range(0, 1.5)), nextAccidentTick: world.tick + TICKS(42),
    serial: { event: 0, truck: 0, temp: 0, request: 0 }, events: [], recent: [], accident: null, accidentActorIds: [],
    trucks: [], cleanup: [], pending: [], crashed: new Set(), managed: new Set(), nearMiss: new Map(),
    metrics: {
      nearMissesAvoided: 0, collisions: 0, ghorzCount: 0, laneCutCount: 0, accidentCount: 0,
      offLaneActiveCount: 0, truckCount: 0, distanceM: 0, ticksActive: 0,
    },
    baseImpacts: impacts, lastImpacts: impacts, startDistance: world.player.distance ?? 0,
    egoReaction: null, lastFailure: null, nextRecycleTick: world.tick + TICKS(2), request: null, accidentRoles: {},
    saved: {
      path: world.player.path, cursor: world.player.cursor, parking: world.player.parking,
      allowReroute: world.player.district?.allowReroute,
    },
  };
  world.streetChaos = state;
  // Cairo routing belongs to the Defensive AI; the district queue must not swap the ego's path mid-queue.
  if (world.player.district) world.player.district.allowReroute = false;
  world.mode = requestedDriver === "manual" ? "manual" : "auto";
  for (const actor of world.actors) {
    if (actor.type !== "vehicle" || actor === world.player) continue;
    applyClassPhysics(actor);
    traitsOf(world, state, actor);
  }
  spawnChaosTrucks(world, state);
  state.metrics.truckCount = state.trucks.length;
  return state;
}

function clearVisualDamage(actor) {
  const entry = getPatrolVisualDamage(actor);
  if (entry) entry.front = entry.rear = entry.left = entry.right = 0;
}

export function endStreetChaos(world) {
  const state = world.streetChaos;
  if (!state?.active) return false;
  for (const actor of state.managed) maneuvers.delete(actor);
  state.managed.clear();
  for (const actor of state.crashed) clearVisualDamage(actor);
  state.crashed.clear();
  removeActors(world, isChaosSpawn);
  for (const actor of world.actors) {
    const saved = originals.get(actor);
    if (saved) {
      actor.spec = saved.spec;
      actor.maxSpeed = saved.maxSpeed;
      originals.delete(actor);
    }
    const t = traits.get(actor);
    if (t) t.bypass = null;
    if (actor.type === "vehicle" && actor !== world.player) clearVisualDamage(actor);
  }
  state.events = [];
  state.accident = null;
  state.accidentActorIds = [];
  state.trucks = [];
  state.cleanup = [];
  state.pending = [];
  state.egoReaction = null;
  state.request = null;
  state.accidentRoles = {};
  state.metrics.truckCount = 0;
  state.active = false;
  world.mode = state.previousMode === "auto" ? "auto" : "manual";
  const player = world.player;
  if (player.district) player.district.allowReroute = state.saved.allowReroute ?? true;
  if (world.mode === "manual") {
    player.path = [];
    player.cursor = 0;
    player.parking = null;
  } else {
    player.path = state.saved.path ?? [];
    player.cursor = state.saved.cursor ?? 0;
    player.parking = state.saved.parking ?? null;
  }
  world.routeRevision++;
  world.actorIndex = new SpatialIndex(world.actors);
  world._queueActorsSourceLen = -1;
  return true;
}

export function setStreetChaosDriver(world, mode) {
  const state = activeState(world);
  if (!state) throw new Error("Start Cairo Traffic first");
  if (mode !== "auto" && mode !== "manual") throw new RangeError("Unknown Cairo Traffic driver mode");
  state.driverMode = mode;
  world.mode = mode;
  if (mode === "manual") state.egoReaction = null;
  return state;
}

/* ----------------------------------------------------------------- events */

const describe = (rejected) => Object.entries(rejected).map(([k, v]) => k + ":" + v).join(", ");

const fail = (state, reason) => {
  state.lastFailure = reason;
  return null;
};

function egoFrameOf(world, minWidth = 9.5) {
  return laneFrame(world, world.player, { minWidth });
}

function registerManeuver(state, actor, man) {
  maneuvers.set(actor, man);
  state.managed.add(actor);
}

function newEvent(world, state, kind, actorIds, extra = {}) {
  const event = {
    id: `evt-${++state.serial.event}`, kind, label: EVENT_LABEL[kind], phase: "start",
    startTick: world.tick, endTick: null, outcome: null, actorIds, tempIds: [], ...extra,
  };
  state.events.push(event);
  if (kind === "ghorz") state.metrics.ghorzCount++;
  else if (kind === "lane-change") state.metrics.laneCutCount++;
  else state.metrics.accidentCount++;
  return event;
}

function actorById(world, id) {
  return world.actors.find((actor) => actor.id === id) ?? null;
}

// Temporary vehicles keep driving on afterwards: give them a straight lane-centre route to follow.
function rebaseOnLane(world, actor) {
  if (!actor) return;
  const frame = laneFrame(world, actor, { maxPsi: 1.0 });
  if (!frame) return;
  const room = frame.d > 0 ? frame.road.max - frame.along : frame.along - frame.road.min;
  const path = straightLanePath(frame, frame.s + 1, -frame.laneOffset, Math.min(260, room - 24));
  if (!path.length) return;
  actor.path = path;
  actor.cursor = 0;
}

function finishEvent(world, state, event, outcome) {
  if (event.endTick != null) return;
  event.phase = outcome === "completed" || outcome === "aborted" ? outcome : "done";
  event.outcome = outcome;
  event.endTick = world.tick;
  // A requested weave that had to give up (junction or traffic in the way) tries again on clearer road.
  const request = event.request;
  if (outcome === "aborted" && event.kind === "ghorz" && request && (request.retries ?? 0) < 2 && state.active) {
    request.retries = (request.retries ?? 0) + 1;
    state.pending.push({ kind: "ghorz", request, untilTick: world.tick + PENDING_WINDOW_TICKS, nextTick: world.tick + TICKS(2), reason: "ghorz: retrying" });
    state.request = { ...state.request, ...(state.request?.id === request.id ? { status: "pending", reason: friendlyReason("ghorz: retrying") } : {}) };
  }
  if (outcome === "no-impact" && event.kind === "accident" && request && (request.retries ?? 0) < 2 && state.active) {
    request.retries = (request.retries ?? 0) + 1;
    state.pending.push({ kind: "accident", request, untilTick: world.tick + PENDING_WINDOW_TICKS, nextTick: world.tick + TICKS(1), reason: "accident: retrying" });
    state.request = { ...state.request, ...(state.request?.id === request.id ? { status: "pending", reason: friendlyReason("accident: retrying") } : {}) };
  }
  for (const id of event.actorIds) {
    const actor = actorById(world, id);
    if (!actor) continue;
    maneuvers.delete(actor);
    state.managed.delete(actor);
  }
  for (const id of event.tempIds) {
    rebaseOnLane(world, actorById(world, id));
    state.cleanup.push({ id, afterTick: world.tick + TICKS(5), minDistanceM: 85 });
  }
  state.events = state.events.filter((candidate) => candidate !== event);
  state.recent.unshift({
    id: event.id, kind: event.kind, label: event.label, startTick: event.startTick,
    endTick: event.endTick, outcome, actorIds: [...event.actorIds],
  });
  if (state.recent.length > RECENT_LIMIT) state.recent.length = RECENT_LIMIT;
  if (event.kind === "accident") {
    state.accident = null;
    state.accidentActorIds = [];
  }
}

const MIN_PASS_MARGIN_M = 1.25;

// Wanted lateral margin is 1.25 m; it is clamped to the roadway and refused below 0.6 m.
function passLaneFor(ef, ego, actor, side = "outer") {
  const half = (actor.width ?? 1.85) / 2;
  const egoHalf = (ego.width ?? 1.85) / 2;
  const wanted = egoHalf + half + MIN_PASS_MARGIN_M;
  if (side === "outer") {
    const lat = Math.max(ef.lat - wanted, -(ef.halfW - half - 0.3));
    return ef.lat - lat >= egoHalf + half + 0.6 ? lat : null;
  }
  // Passing on the centre-line side may straddle the line by about a metre, as Cairo drivers do.
  const lat = Math.min(ef.lat + wanted, 1 - half);
  return lat - ef.lat >= egoHalf + half + 0.6 ? lat : null;
}

function pedestrianIn(world, frame, sMin, sMax, latMin, latMax) {
  // Walkers on the pavement beyond the kerb are no obstacle for a car on the roadway.
  latMin = Math.max(latMin, -(frame.halfW + 0.2));
  for (const actor of world.actors) {
    if (actor.type !== "pedestrian") continue;
    const e = bodyExtentsOnLane(frame, actor);
    if (e.sMax > sMin && e.sMin < sMax && e.latMax > latMin && e.latMin < latMax) return true;
  }
  return false;
}
// Choose the side with a clear lane for the whole pass: kerbside first, then the centre-line side.
function pickPassSide(world, ef, ego, actor, sStart, ignore = []) {
  const lookahead = world.mode === "auto" ? 58 : 32;
  for (const side of ["outer", "inner"]) {
    const lat = passLaneFor(ef, ego, actor, side);
    if (lat === null) continue;
    const reach = side === "outer" ? [lat - 1.2, lat + 1.2] : [lat - 1.2, 3.9];
    if (!staticsClear(world, ef, sStart - 3, ef.s + (world.mode === "auto" ? 42 : 24), lat - 1.2, lat + 1.2)) continue;
    if (!regionClear(world, ef, sStart - 3, ef.s + lookahead, reach[0], reach[1], ignore)) continue;
    return { side, lat };
  }
  return null;
}
function ghorzCandidate(world, ef) {
  const ego = world.player;
  let best = null;
  let bestScore = Infinity;
  for (const actor of world.actors) {
    if (actor === ego || actor.type !== "vehicle" || maneuvers.has(actor) || isChaosSpawn(actor)) continue;
    if (actor.kind !== "sedan" && actor.kind !== "taxi" && actor.kind !== "tuktuk") continue;
    if (actor.speed < 1) continue;
    const c = coordsOn(ef.road, ef.d, actor);
    const back = ef.s - c.s;
    if (back < 9 || back > 44 || c.lat > -0.4 || c.lat < -ef.halfW) continue;
    if (Math.abs(angleDelta(actor.heading, ef.laneHeading)) > 0.2) continue;
    if (!pickPassSide(world, ef, ego, actor, c.s, [actor])) continue;
    const score = Math.abs(back - 20) + Math.abs(c.lat - ef.lat) * 2;
    if (score < bestScore) { best = actor; bestScore = score; }
  }
  return best;
}

function startGhorz(world, state) {
  const ego = world.player;
  if (world.mode === "auto" && (ego.speed ?? 0) < 1.4) return fail(state, "ghorz: waiting for car to pick up speed");
  const ef = egoFrameOf(world);
  if (!ef) return fail(state, "ghorz: player is not on a wide avenue");
  // The weaver needs room to overtake, cut in and settle before the next junction.
  const runway = clamp((ego.speed ?? 0) * 3.6 + 10, 30, 52);
  if (zoneAheadM(world, ef, ef.s) < runway) return fail(state, `ghorz: junction too close ahead (${Math.round(zoneAheadM(world, ef, ef.s))} m < ${Math.round(runway)} m)`);
  let weaver = ghorzCandidate(world, ef);
  const adopted = Boolean(weaver);
  let passSide = adopted ? pickPassSide(world, ef, ego, weaver, coordsOn(ef.road, ef.d, weaver).s, [weaver])?.side ?? "outer" : "outer";
  if (!weaver) {
    // A tuktuk tops out near 35 km/h, so it can only out-run a crawling ego.
    const kinds = (ego.speed ?? 0) > 6 ? ["taxi", "sedan"] : ["taxi", "sedan", "tuktuk"];
    const kind = state.rng.pick(kinds);
    const speed = clamp((ego.speed ?? 0) + 3, 4, 12);
    const width = kind === "tuktuk" ? 1.5 : 1.85;
    const length = kind === "tuktuk" ? 2.9 : 4.2;
    const slotNotes = {};
    for (const [back, zoneMargin] of [[14, 3], [16, 3], [12, 3], [11, 3], [22, 3], [28, 3], [10, 0.5], [9.5, 0.5]]) {
      const s = ef.s - back;
      if (aheadRoomM(ef) < Math.max(48, runway) || (ef.d > 0 ? ef.along - ef.road.min : ef.road.max - ef.along) < back + 6) { slotNotes.room = (slotNotes.room ?? 0) + 1; continue; }
      const pass = pickPassSide(world, ef, ego, { width }, s);
      if (!pass) { slotNotes.pass = (slotNotes.pass ?? 0) + 1; continue; }
      if (pedestrianIn(world, ef, s - 3, ef.s + 28, pass.lat - 1.4, pass.lat + 1.4)) { slotNotes.ped = (slotNotes.ped ?? 0) + 1; continue; }
      const p = lanePoint(ef.road, ef.d, s, pass.lat);
      const body = { type: "vehicle", x: p.x, z: p.z, heading: ef.laneHeading, length, width };
      const why = slotReason(world, body, { minPlayerDistance: 9.4, actorGap: 1.6, zoneMargin });
      if (why) { slotNotes[why] = (slotNotes[why] ?? 0) + 1; continue; }
      weaver = makeEventVehicle(world, state, kind, ef, s, pass.lat, speed, 320);
      passSide = pass.side;
      break;
    }
    if (!weaver) return fail(state, `ghorz: no clear slot behind the player (${describe(slotNotes)})`);
    addActor(world, weaver);
  }
  const aggression = VEHICLE_CLASS_DYNAMICS[classOfVehicle(weaver)].cutInAggression;
  const event = newEvent(world, state, "ghorz", [weaver.id], { adopted, phase: "approach" });
  if (!adopted) event.tempIds.push(weaver.id);
  applyClassPhysics(weaver);
  registerManeuver(state, weaver, {
    event, kind: "ghorz", role: "weaver", phase: "approach", startTick: world.tick, phaseTick: world.tick,
    cutGapM: state.rng.range(3, 5), surgeMps: state.rng.range(4.2, 5), aggression, retried: false, cutCompleted: false,
    done: false, side: passSide, cutLat: 0, lastPass: null, stallTicks: 0, zoneTick: -99, zoneAheadM: Infinity,
  });
  return event;
}

function laneChangeCandidate(world, ef) {
  const ego = world.player;
  let best = null;
  let bestScore = Infinity;
  for (const actor of world.actors) {
    if (actor === ego || actor.type !== "vehicle" || maneuvers.has(actor) || isChaosSpawn(actor)) continue;
    if (!["taxi", "van", "suv", "sedan"].includes(actor.kind) || actor.speed < 2) continue;
    const c = coordsOn(ef.road, ef.d, actor);
    const ahead = c.s - ef.s;
    const apart = Math.abs(c.lat - ef.lat);
    if (ahead < 8 || ahead > 28 || apart < 1.9 || apart > 5 || c.lat > -0.4 || c.lat < -ef.halfW) continue;
    if (zoneAheadM(world, ef, c.s) < 26) continue;
    if (Math.abs(angleDelta(actor.heading, ef.laneHeading)) > 0.12) continue;
    const score = Math.abs(ahead - 17) + apart;
    if (score < bestScore) { best = actor; bestScore = score; }
  }
  return best;
}

function startLaneChange(world, state) {
  const ego = world.player;
  const ef = egoFrameOf(world);
  if (!ef) return fail(state, "lane-change: player is not on a wide avenue");
  let cutter = laneChangeCandidate(world, ef);
  const adopted = Boolean(cutter);
  if (!cutter) {
    const kind = state.rng.pick(["taxi", "van", "suv", "sedan"]);
    const width = 1.85;
    const sep = (ego.width ?? 1.85) / 2 + width / 2 + 0.7;
    // Kerb side first; the centre-line side may straddle the line by about a metre.
    const sides = [ef.lat - sep, ef.lat + sep].filter((lat) => lat - width / 2 - 0.3 >= -ef.halfW && lat + width / 2 <= 1.05);
    const speed = clamp((ego.speed ?? 0) * 0.96, 4, 11);
    const rejected = { sides: sides.length };
    const note = (key) => { rejected[key] = (rejected[key] ?? 0) + 1; };
    for (const ahead of [21, 16, 26, 12, 19]) {
      for (const lat of sides) {
        const s = ef.s + ahead;
        const p = lanePoint(ef.road, ef.d, s, lat);
        const body = { type: "vehicle", x: p.x, z: p.z, heading: ef.laneHeading, length: 4.2, width };
        const why = slotReason(world, body, { minPlayerDistance: 9, actorGap: 1.6, zoneMargin: 3 });
        if (why) { note(why); continue; }
        if (!staticsClear(world, ef, ef.s, s + 16, Math.min(lat, ef.lat) - 1.2, Math.max(lat, ef.lat) + 1.2)) { note("lane-statics"); continue; }
        if (lat > ef.lat && !regionClear(world, ef, s - 6, s + 26, lat - 1.2, 3.9)) { note("oncoming"); continue; }
        if (aheadRoomM(ef) < ahead + 90) { note("road-end"); continue; }
        if (zoneAheadM(world, ef, s) < 26) { note("junction"); continue; }
        cutter = makeEventVehicle(world, state, kind, ef, s, lat, speed, 300);
        break;
      }
      if (cutter) break;
    }
    if (!cutter) return fail(state, `lane-change: no clear slot ahead of the player (${describe(rejected)})`);
    addActor(world, cutter);
  }
  const event = newEvent(world, state, "lane-change", [cutter.id], { adopted, phase: "hold" });
  if (!adopted) event.tempIds.push(cutter.id);
  applyClassPhysics(cutter);
  registerManeuver(state, cutter, {
    event, kind: "lane-change", role: "cutter", phase: "hold", startTick: world.tick, phaseTick: world.tick,
    holdTicks: TICKS(state.rng.range(0.5, 1.1)), originLat: coordsOn(ef.road, ef.d, cutter).lat,
    done: false, cutCompleted: false, cutLat: 0, zoneTick: -99, zoneAheadM: Infinity,
  });
  return event;
}

const ACCIDENT_AHEAD_M = Object.freeze(Array.from({ length: 27 }, (_, i) => 28 + i).sort((a, b) => Math.abs(a - 40) - Math.abs(b - 40)));
const WRECK_CLEARANCE_M = 3.45;
const WRECK_HALF_EXTENT_M = 1.4;

function startAccident(world, state) {
  const ego = world.player;
  const ef = egoFrameOf(world, 12.4);
  if (!ef) return fail(state, "accident: player is not on a wide avenue");
  if (state.accident) return fail(state, "accident: one is already active");
  const egoZoneAhead = zoneAheadM(world, ef, ef.s);
  const kinds = ["taxi", "sedan", "suv", "van"];
  const leadKind = state.rng.pick(kinds);
  const followKind = state.rng.pick(kinds);
  const lead = { length: 4.2, width: 1.85 };
  const room = aheadRoomM(ef);
  const speedL = state.rng.range(8.2, 9.2);
  const speedF = speedL + 1.4;
  const reactS = state.rng.range(0.34, 0.46);
  // Size the opening gap so the late car is short of stopping room by a metre or so: a real, modest impact.
  const brakeL = VEHICLE_CLASS_DYNAMICS[leadKind].braking;
  const brakeF = VEHICLE_CLASS_DYNAMICS[followKind].braking;
  const needed = speedF * reactS + speedF * speedF / (2 * brakeF) - speedL * speedL / (2 * brakeL);
  const gapM = Math.max(2.0, needed - state.rng.range(1.7, 2.3));
  const wreckLat = {
    // The wreck sits toward the centre line and the bypass runs along the kerb side, or the reverse.
    // The skid pulls the lead about 0.35 m toward the centre line, so start that much further out.
    inner: -(ef.halfW - WRECK_CLEARANCE_M - WRECK_HALF_EXTENT_M) - 0.35,
    // Outer: near the kerb side (1.0 m skid guard keeps lead strictly on-road) so inner bypass stays >= 3.4 m wide.
    outer: -(ef.halfW - 2.35),
  };
  const levels = [
    { zoneMargin: 10, approachM: 28 }, { zoneMargin: 6, approachM: 28 }, { zoneMargin: 3, approachM: 28 }, { zoneMargin: 0.5, approachM: 28 },
  ];
  let site = null;
  const rejected = { room: 0 };
  search: for (const level of levels) {
    for (const variant of ["inner", "outer"]) {
      const latW = wreckLat[variant];
      for (const ahead of ACCIDENT_AHEAD_M) {
        const sL = ef.s + ahead;
        const sF = sL - (lead.length / 2 + 2.1 + gapM);
        if (room < ahead + 34) { rejected.room++; continue; }
        // No junction between the player and the wreck: the player cannot turn off before reaching it,
        // and traffic queued behind it cannot choke a junction exit.
        if (egoZoneAhead < ahead + 9) { rejected.junction_between = (rejected.junction_between ?? 0) + 1; continue; }
        const pl = lanePoint(ef.road, ef.d, sL, latW);
        const pf = lanePoint(ef.road, ef.d, sF, latW);
        const bodyL = { type: "vehicle", x: pl.x, z: pl.z, heading: ef.laneHeading, length: 4.2, width: 1.85 };
        const bodyF = { type: "vehicle", x: pf.x, z: pf.z, heading: ef.laneHeading, length: 4.2, width: 1.85 };
        const opts = { minPlayerDistance: 22, actorGap: 1.4, zoneMargin: level.zoneMargin, roadMargin: 0.2 };
        const why = slotReason(world, bodyL, opts) ?? slotReason(world, bodyF, opts);
        if (why) { rejected[why] = (rejected[why] ?? 0) + 1; continue; }
        // The braking lead rolls on several metres before it stops; keep the final wreck out of junctions too.
        const pr = lanePoint(ef.road, ef.d, sL + 7, latW);
        if (inJunctionZone(world, { x: pr.x, z: pr.z, length: 4.2, width: 1.85 }, level.zoneMargin)) { rejected.wreck_junction = (rejected.wreck_junction ?? 0) + 1; continue; }
        if (pedestrianIn(world, ef, sF - 4, sL + 10, latW - 1.3, latW + 1.3)) { rejected.pedestrian = (rejected.pedestrian ?? 0) + 1; continue; }
        const truckInCorridor = state.trucks.some((truck) => {
          const tc = coordsOn(ef.road, ef.d, truck);
          return tc.s > ef.s - 2 && tc.s < sL + 12 && tc.lat < -0.2 && tc.lat > -ef.halfW - 0.5;
        });
        if (truckInCorridor) { rejected.truck = (rejected.truck ?? 0) + 1; continue; }
        if (!regionClear(world, ef, sF - 4, sL + 7, -ef.halfW, -0.2)) { rejected.region = (rejected.region ?? 0) + 1; continue; }
        // The wreck itself and the whole bypass side must be free of kerbside parked cars and props.
        const bypassBand = variant === "inner" ? [-ef.halfW, latW - 1.2] : [latW + 1.2, -0.2];
        if (!staticsClear(world, ef, sF - 1, sL + 9, latW - 1.6, latW + 1.6)
            || !staticsClear(world, ef, sF - level.approachM, sL + 12, bypassBand[0], bypassBand[1])) { rejected.wreck_statics = (rejected.wreck_statics ?? 0) + 1; continue; }
        site = { sL, sF, latW, variant };
        break search;
      }
    }
  }  if (site) {
    const { sL, sF, latW, variant } = site;
    const leadCar = makeEventVehicle(world, state, leadKind, ef, sL, latW, speedL, 260);
    const followCar = makeEventVehicle(world, state, followKind, ef, sF, latW, speedF, 260);
    addActor(world, leadCar);
    addActor(world, followCar);
    const event = newEvent(world, state, "accident", [leadCar.id, followCar.id], { phase: "braking", impactTick: null });
    event.tempIds.push(leadCar.id, followCar.id);
    state.accident = {
      eventId: event.id, variant, road: ef.road, d: ef.d, latW, halfW: ef.halfW, laneHeading: ef.laneHeading,
      laneOffset: ef.laneOffset, frame: ef, sMin: sL - 3, sMax: sL + 8, latMin: latW - 1.5, latMax: latW + 1.5,
      formed: false, clearTick: null, leadId: leadCar.id, followId: followCar.id,
    };
    registerManeuver(state, leadCar, {
      event, kind: "accident", role: "lead", phase: "brake", startTick: world.tick, phaseTick: world.tick,
      latW, skewTarget: state.rng.range(0.31, 0.42), skewSign: variant === "inner" ? 1 : -1, done: false,
    });
    registerManeuver(state, followCar, {
      event, kind: "accident", role: "follower", phase: "unaware", startTick: world.tick, phaseTick: world.tick,
      reactTicks: TICKS(reactS), latW, cruiseSpeed: speedF, done: false,
    });
    return event;
  }
  return fail(state, `accident: no clear stretch ahead of the player (${Object.entries(rejected).map(([k, v]) => k + ":" + v).join(", ")})`);
}

const PENDING_WINDOW_TICKS = TICKS(30);

// Human-readable HUD text; the raw diagnostic string stays available as debugReason.
function friendlyReason(raw) {
  if (!raw) return null;
  if (raw.includes("already active")) return "Accident already active";
  if (raw.includes("not on a wide avenue")) return "Drive onto a wide avenue first";
  if (raw.includes("junction too close")) return "Waiting for clear straight road ahead";
  if (raw.startsWith("ghorz")) return "Waiting for a clear gap beside the car";
  if (raw.startsWith("lane-change")) return "Waiting for a clear gap ahead";
  if (raw.startsWith("accident")) return "Waiting for a clear stretch of road ahead";
  return "Waiting for clear road";
}

function setRequest(state, request, status, raw, tick, untilTick = null) {
  state.request = {
    id: request.id, kind: request.kind, status, reason: friendlyReason(raw), debugReason: raw ?? null,
    atTick: request.atTick ?? tick, untilTick,
  };
}

export function triggerStreetChaosEvent(world, kind) {
  const state = activeState(world);
  if (!state) throw new Error("Start Cairo Traffic first");
  if (!CHAOS_EVENT_KINDS.includes(kind)) throw new RangeError("Unknown Cairo Traffic event");
  state.lastFailure = null;
  const request = { id: `req-${++state.serial.request}`, kind, atTick: world.tick };
  if (kind === "accident" && (state.accident || state.pending.some((entry) => entry.kind === "accident"))) {
    setRequest(state, request, "rejected", "Accident already active", world.tick);
    return null;
  }
  const event = startEvent(world, state, kind);
  if (event) {
    event.request = request;
    setRequest(state, request, "started", null, world.tick);
    return eventSummary(world, event);
  }
  // A walker, a junction or a kerbside car can block the only feasible slot; keep trying for a while.
  const until = world.tick + PENDING_WINDOW_TICKS;
  const entry = state.pending.find((candidate) => candidate.kind === kind);
  if (entry) {
    // A repeated request restarts the window under its own id.
    Object.assign(entry, { request, untilTick: until, nextTick: world.tick + 6, reason: state.lastFailure });
  } else state.pending.push({ kind, request, untilTick: until, nextTick: world.tick + 6, reason: state.lastFailure });
  setRequest(state, request, "pending", state.lastFailure, world.tick, until);
  return { id: null, kind, label: EVENT_LABEL[kind], phase: "pending", startTick: world.tick, actorIds: [], adopted: false, pending: true };
}

function startEvent(world, state, kind) {
  return kind === "ghorz" ? startGhorz(world, state)
    : kind === "lane-change" ? startLaneChange(world, state) : startAccident(world, state);
}

function retryPending(world, state) {
  if (!state.pending.length) return;
  const ego = world.player;
  // The countdown only runs while the ego is actually driving, not queued at a junction line.
  const parked = ((ego.speed ?? 0) < 0.5 && Boolean(world.districtBehavior?.holds?.[ego.id])) || (ego.speed ?? 0) < 2.5;
  state.pending = state.pending.filter((entry) => {
    if (parked) entry.untilTick++;
    if (world.tick < entry.nextTick) return true;
    entry.nextTick = world.tick + 6;
    state.lastFailure = null;
    // Only the newest request owns the HUD line; older ones still retry silently.
    const current = state.request?.id === entry.request.id;
    const started = startEvent(world, state, entry.kind);
    if (started) started.request = entry.request;
    if (started) {
      if (current) setRequest(state, entry.request, "started", null, world.tick);
      return false;
    }
    entry.reason = state.lastFailure;
    if (world.tick >= entry.untilTick) {
      if (current) setRequest(state, entry.request, "expired", entry.reason, world.tick);
      return false;
    }
    if (current) setRequest(state, entry.request, "pending", entry.reason, world.tick, entry.untilTick);
    return true;
  });
}
function eventSummary(world, event) {
  const ids = event.actorIds;
  return {
    id: event.id, kind: event.kind, label: event.label, phase: event.phase, startTick: event.startTick,
    actorIds: [...ids], adopted: event.adopted ?? false,
  };
}

/* ------------------------------------------------------------ maneuvers */

function latSteer(actor, frame, latTarget, { maxPsi = 0.2, lookahead } = {}) {
  const wheelbase = actor.spec?.wheelbase ?? VEHICLE.wheelbase;
  const v = Math.max(actor.speed ?? 0, 0);
  const L = lookahead ?? clamp(4 + 0.55 * v, 5, 12);
  const err = latTarget - frame.lat;
  const psiDes = clamp(Math.atan2(err, L), -maxPsi, maxPsi);
  const alpha = psiDes - frame.psi;
  let steer = Math.atan2(2 * wheelbase * Math.sin(alpha), L);
  const aLat = VEHICLE_CLASS_DYNAMICS[classOfVehicle(actor)].lateralAccelMps2;
  const limit = Math.atan(aLat * wheelbase / Math.max(v * v, 4));
  return clamp(steer, -limit, limit);
}

function chaosCommand(base, steer, targetSpeed, reason, pipeline, usePlannedPath = false) {
  return {
    ...base, steer, targetSpeed: Math.max(0, targetSpeed), reason, blockedBy: null,
    chaosPipeline: pipeline, usePlannedPath,
  };
}

function egoOn(frame, ego) {
  const c = coordsOn(frame.road, frame.d, ego);
  const aligned = Math.abs(angleDelta(ego.heading, frame.laneHeading)) < 0.9;
  const onRoad = Math.abs(c.lat) <= frame.halfW + 0.5;
  return { ...c, aligned, onRoad, v: Math.max(ego.speed ?? 0, 0) };
}

function setPhase(man, phase, tick) {
  man.phase = phase;
  man.phaseTick = tick;
  man.event.phase = phase;
}

function driveWeaver(world, state, actor, man, base) {
  const ego = world.player;
  const wf = laneFrame(world, actor, { maxPsi: 1.0 });
  if (!wf || (world.tick - man.startTick) > TICKS(26)) { man.done = true; return null; }
  const e = egoOn(wf, ego);
  const tick = world.tick;
  if ((!e.aligned || !e.onRoad) && man.phase !== "rejoin") setPhase(man, "rejoin", tick);
  if (tick - man.zoneTick >= 5) {
    man.zoneTick = tick;
    man.zoneAheadM = zoneAheadM(world, wf, wf.s);
  }
  const passing = man.phase === "approach" || man.phase === "abort";
  // A weaver never starts a cut right before a junction; it eases back into traffic instead.
  if (man.zoneAheadM < 9 && passing) setPhase(man, "rejoin", tick);
  // Stalled by something on the way (a walker, a parked car): give up gracefully rather than linger.
  man.stallTicks = actor.speed < 0.8 && passing ? man.stallTicks + 1 : 0;
  if (man.stallTicks > TICKS(2.5)) setPhase(man, "rejoin", tick);
  const bumperGap = (wf.s - (actor.length ?? 4.2) / 2) - (e.s + (ego.length ?? 4.2) / 2);
  const latPass = passLaneFor({ lat: e.lat, halfW: wf.halfW }, ego, actor, man.side) ?? man.lastPass ?? wf.lat;
  man.lastPass = latPass;
  const laneCenter = -wf.laneOffset;
  const maxSpeed = actor.maxSpeed;
  let latTarget = latPass;
  let speed = Math.min(maxSpeed, Math.max(e.v + man.surgeMps, 6));
  let maxPsi = 0.16;
  switch (man.phase) {
    case "approach": {
      if (bumperGap >= man.cutGapM && man.zoneAheadM >= 14) {
        // The cut lane is fixed at entry so a defensive shift by the ego cannot make the cut chase a ghost.
        man.cutLat = clamp(e.lat, -(wf.halfW - (actor.width ?? 1.85) / 2 - 0.3), -0.3 - (actor.width ?? 1.85) / 2);
        setPhase(man, "cut", tick);
      } else if (tick - man.startTick > TICKS(13)) setPhase(man, "rejoin", tick);
      break;
    }
    case "cut":
    case "settle": {
      latTarget = man.cutLat;
      maxPsi = 0.3 * (0.6 + 0.4 * man.aggression);
      const lateralGap = Math.abs(wf.lat - man.cutLat);
      const sideBySide = ((actor.width ?? 1.85) + (ego.width ?? 1.85)) / 2 + 0.6;
      const closeAhead = bumperGap < 2 && Math.abs(wf.lat - e.lat) < sideBySide + 0.3;
      if (man.phase === "cut" && closeAhead && !man.cutCompleted) {
        setPhase(man, "abort", tick);
        latTarget = latPass;
        break;
      }
      speed = Math.max(e.v + 1.2, Math.min(speed, maxSpeed * 0.95));
      if (man.phase === "cut" && lateralGap < 0.45 && Math.abs(wf.psi) < 0.1) {
        man.cutCompleted = true;
        setPhase(man, "settle", tick);
      }
      if (man.phase === "settle") {
        // Ease into a 2.5â€“4.5 m bumper gap ahead of the ego, never tighter.
        speed = e.v + clamp((bumperGap - 3.5) * 0.7, -2.5, 2.5);
        if (bumperGap < 3) speed = Math.max(speed, e.v + 1.5);
        if (tick - man.phaseTick > TICKS(2.6)) setPhase(man, "rejoin", tick);
      }
      break;
    }
    case "abort": {
      latTarget = latPass;
      speed = Math.min(maxSpeed, e.v + 4.5);
      if (Math.abs(wf.lat - latPass) < 0.8 || bumperGap > 6.5) {
        if (!man.retried) {
          man.retried = true;
          man.cutGapM += 2;
          setPhase(man, "approach", tick);
        } else setPhase(man, "rejoin", tick);
      }
      break;
    }
    default: {
      latTarget = laneCenter;
      speed = Math.min(maxSpeed, Math.max(e.v, 5));
      if (e.aligned && bumperGap < 8 && bumperGap > -6 && Math.abs(wf.lat - e.lat) < 2.8) speed = Math.max(e.v + 0.3, speed * 0.8);
      if (Math.abs(wf.lat - laneCenter) < 0.45 && Math.abs(wf.psi) < 0.07) man.done = true;
      maxPsi = 0.14;
    }
  }
  const steer = latSteer(actor, wf, latTarget, { maxPsi });
  const settled = man.phase === "settle" || man.phase === "rejoin";
  return chaosCommand(base, steer, speed, `ghorz-${man.phase}`, settled ? "district" : "safe");
}

function driveCutter(world, state, actor, man, base) {
  const ego = world.player;
  const wf = laneFrame(world, actor, { maxPsi: 1.0 });
  if (!wf || (world.tick - man.startTick) > TICKS(22)) { man.done = true; return null; }
  const e = egoOn(wf, ego);
  const tick = world.tick;
  if ((!e.aligned || !e.onRoad) && man.phase !== "rejoin") setPhase(man, "rejoin", tick);
  const aheadGap = wf.s - e.s - ((actor.length ?? 4.2) + (ego.length ?? 4.2)) / 2;
  const laneCenter = -wf.laneOffset;
  let latTarget = wf.lat;
  let speed = Math.max(Math.min(actor.maxSpeed, Math.max(e.v * 0.97, 4)), 3);
  let maxPsi = 0.12;
  switch (man.phase) {
    case "hold":
      latTarget = man.originLat;
      if (tick - man.phaseTick >= man.holdTicks) {
        man.cutLat = clamp(e.lat, -(wf.halfW - (actor.width ?? 1.85) / 2 - 0.3), -0.3 - (actor.width ?? 1.85) / 2);
        setPhase(man, "cut", tick);
      }
      break;
    case "cut":
    case "settle": {
      latTarget = man.cutLat;
      maxPsi = 0.26;
      if (Math.abs(wf.lat - man.cutLat) < 0.55 && Math.abs(wf.psi) < 0.1 && man.phase === "cut") {
        man.cutCompleted = true;
        setPhase(man, "settle", tick);
      }
      if (man.phase === "settle") {
        speed = aheadGap > 6 ? Math.max(e.v - 1.8, 3) : e.v;
        if (tick - man.phaseTick > TICKS(2.4)) setPhase(man, "rejoin", tick);
      }
      break;
    }
    default:
      latTarget = laneCenter;
      speed = Math.max(Math.min(actor.maxSpeed, e.v), 3);
      if (Math.abs(wf.lat - laneCenter) < 0.45 && Math.abs(wf.psi) < 0.07) man.done = true;
  }
  const steer = latSteer(actor, wf, latTarget, { maxPsi });
  return chaosCommand(base, steer, speed, `lane-change-${man.phase}`, "district");
}
function driveAccidentLead(world, state, actor, man, base) {
  const wf = state.accident?.frame ? laneFrame(world, actor, { maxPsi: 1.2 }) : null;
  if (!wf) return chaosCommand(base, 0, 0, "accident-wreck", "direct");
  if (man.phase === "wreck") return chaosCommand(base, 0, 0, "accident-wreck", "direct");
  const v = Math.max(actor.speed, 0);
  let steer = latSteer(actor, wf, man.latW, { maxPsi: 0.12 });
  if (v < 7.4) {
    const psi = wf.psi * man.skewSign;
    steer = clamp(2.6 * (man.skewTarget - psi), -0.5, 0.5) * man.skewSign;
    if (psi > man.skewTarget) steer = 0;
    // A skid toward the kerb stops well short of the road edge.
    if (man.skewSign < 0 && bodyExtentsOnLane(wf, actor).latMin < -(wf.halfW - 0.72)) steer = Math.max(steer, 0);
  }
  if (v < 0.05 && man.phase === "brake") { man.phase = "wreck"; man.phaseTick = world.tick; }
  return chaosCommand(base, steer, 0, "accident-brake", "direct");
}

function driveAccidentFollower(world, state, actor, man, base) {
  const wf = laneFrame(world, actor, { maxPsi: 1.2 });
  if (!wf) return chaosCommand(base, 0, 0, "accident-wreck", "direct");
  if (man.phase === "wreck") return chaosCommand(base, 0, 0, "accident-wreck", "direct");
  const lead = state.accident?.leadId ? actorById(world, state.accident.leadId) : null;
  const targetLat = lead ? coordsOn(wf.road, wf.d, lead).lat : man.latW;
  const steer = latSteer(actor, wf, targetLat, { maxPsi: 0.14 });
  if (man.phase === "unaware") {
    const gap = lead && state.accident?.frame
      ? bodyExtentsOnLane(state.accident.frame, lead).sMin - bodyExtentsOnLane(state.accident.frame, actor).sMax
      : Infinity;
    if (world.tick - man.startTick >= man.reactTicks || gap < 2.2) {
      man.phase = "brake";
      man.phaseTick = world.tick;
    } else return chaosCommand(base, steer, man.cruiseSpeed, "accident-late", "direct");
  }
  return chaosCommand(base, steer, 0, "accident-brake", "direct");
}

// Cleared wrecks touch each other, which the ordinary 0.3 m yield check would never let move: creep apart first.
function driveLimp(world, state, actor, man, base) {
  if (world.tick - man.startTick > TICKS(12)) { man.done = true; return null; }
  const gap = Math.hypot(actor.x - man.other.x, actor.z - man.other.z) - ((actor.length ?? 4.2) + (man.other.length ?? 4.2)) / 2;
  const speed = man.leader || gap > 3 ? 3.5 : 0;
  return chaosCommand(base, base.steer, speed, "accident-clearing", "direct", true);
}

function runManeuver(world, state, actor, man, base) {
  if (man.done) {
    maneuvers.delete(actor);
    state.managed.delete(actor);
    return null;
  }
  if (man.role === "limp") return driveLimp(world, state, actor, man, base);
  if (man.role === "weaver") return driveWeaver(world, state, actor, man, base);
  if (man.role === "cutter") return driveCutter(world, state, actor, man, base);
  if (man.role === "lead") return driveAccidentLead(world, state, actor, man, base);
  if (man.role === "follower") return driveAccidentFollower(world, state, actor, man, base);
  return null;
}

/* --------------------------------------------- ambient traffic behaviour */

function pathStraightAhead(actor, frame) {
  const path = actor.path;
  if (!path || path.length < 60) return false;
  const c = actor.cursor ?? 0;
  const i0 = Math.min(path.length - 1, c);
  const i1 = Math.min(path.length - 1, c + 36);
  const i2 = Math.min(path.length - 1, c + 70);
  if (i2 - i0 < 60) return false;
  const h1 = Math.atan2(path[i1].x - path[i0].x, path[i1].z - path[i0].z);
  const h2 = Math.atan2(path[i2].x - path[i1].x, path[i2].z - path[i1].z);
  return Math.abs(angleDelta(h1, h2)) < 0.035 && Math.abs(angleDelta(h1, frame.laneHeading)) < 0.07;
}

function accidentBypass(world, state, actor, frame, base) {
  const acc = state.accident;
  if (!acc?.formed || frame.road !== acc.road || frame.d !== acc.d) return null;
  const width = actor.width ?? 1.85;
  const length = actor.length ?? 4.2;
  const t = traitsOf(world, state, actor);
  const gap = acc.sMin - (frame.s + length / 2);
  const passedBy = frame.s - length / 2 - acc.sMax;
  const bandMax = frame.lat + width / 2 + 0.2;
  const bandMin = frame.lat - width / 2 - 0.2;
  const conflict = bandMax > acc.latMin - 0.9 && bandMin < acc.latMax + 0.9;
  if (passedBy > 2 && t.bypass) {
    t.bypass = { phase: "rejoin" };
  } else if (!t.bypass && gap < 72 && gap > -2 && conflict) {
    t.bypass = { phase: "pass" };
  }
  if (!t.bypass) return null;
  if (t.bypass.phase === "rejoin") {
    const center = -frame.laneOffset;
    if (Math.abs(frame.lat - center) < 0.5 && Math.abs(frame.psi) < 0.08) { t.bypass = null; return null; }
    return chaosCommand(base, latSteer(actor, frame, center, { maxPsi: 0.14 }), Math.min(idealPathSpeed(actor, actor.path, actor.cursor ?? 0), 8),
      "accident-rejoin", "district");
  }
  const margin = width > 2.2 ? 0.72 : 0.95;
  const outer = acc.latMin - margin - width / 2;
  const inner = acc.latMax + margin + width / 2;
  const outerOk = outer - width / 2 >= -(frame.halfW - (width > 2.2 ? 0.12 : 0.35));
  const innerLimit = width > 2.2 && frame.halfW >= 5.5 && regionClear(world, frame, acc.sMin - 12, acc.sMax + 35, 0, 3.6, [actor])
    ? 1.95 : -0.3;
  const innerOk = inner + width / 2 <= innerLimit;
  let speed = idealPathSpeed(actor, actor.path, actor.cursor ?? 0);
  let target = null;
  if (outerOk && innerOk) target = Math.abs(outer - frame.lat) <= Math.abs(inner - frame.lat) ? outer : inner;
  else if (outerOk) target = outer;
  else if (innerOk) target = inner;
  if (target === null) {
    speed = Math.min(speed, Math.sqrt(2 * 3 * Math.max(0, gap - 6)));
    return chaosCommand(base, base.steer, speed, "accident-yield", "district", true);
  }
  if (gap < 34) speed = Math.min(speed, Math.max(2.6, Math.sqrt(2 * 3 * Math.max(0, gap - 2)) + 1.2));
  return chaosCommand(base, latSteer(actor, frame, target, { maxPsi: 0.2 }), speed, "accident-bypass", "district");
}

function offLaneDrive(world, state, actor, frame, base) {
  const t = traitsOf(world, state, actor);
  if (!t.offLaneOffsetM) return null;
  if (Math.abs(base.steer) > 0.07 || Math.abs(frame.psi) > 0.18 || !pathStraightAhead(actor, frame)) return null;
  const width = actor.width ?? 1.85;
  const wander = t.wanderAmpM * Math.sin(world.tick * STEP * 2 * Math.PI / t.wanderPeriodS + t.wanderPhase);
  let target = -frame.laneOffset + t.offLaneOffsetM + wander;
  target = Math.max(target, -(frame.halfW - width / 2 - 0.4));
  target = Math.min(target, -(width / 2 + 0.3));
  return { ...base, steer: latSteer(actor, frame, target, { maxPsi: 0.1 }),
    targetSpeed: Math.min(idealPathSpeed(actor, actor.path, actor.cursor ?? 0), base.targetSpeed > 0 ? Infinity : 0) };
}

// Two cars can each read the other as the blocker by a hair under the 0.3 m yield margin and wait
// forever. The lower id creeps on, with the physical 0.12 m contact guard still on duty.
function breakMutualYield(world, actor, base) {
  const t = traits.get(actor);
  if (t?.creepUntil > world.tick) return chaosCommand(base, base.steer, 1.6, "yield-deadlock-creep", "direct", true);
  if (actor.speed > 0.2 || actor.wait < 5 || actor.reason !== "yielding" || !actor.blockedBy) return null;
  const other = actorById(world, actor.blockedBy);
  if (!other || other.type !== "vehicle" || other.blockedBy !== actor.id || other.speed > 0.2 || actor.id > other.id) return null;
  if (t) t.creepUntil = world.tick + TICKS(2.5);
  return chaosCommand(base, base.steer, 1.6, "yield-deadlock-creep", "direct", true);
}

function heavyYield(world, actor, base) {
  // A truck never parks itself across a junction: inside the zone it clears out and lets the district logic judge.
  if (inJunctionZone(world, actor, 1.5)) return null;
  const comfort = 2.6;
  const s = Math.sin(actor.heading);
  const c = Math.cos(actor.heading);
  const others = world.actorIndex.near(actor, 85);
  let cap = Infinity;
  for (let i = 0; i < others.length; i++) {
    const other = others[i];
    if (other === actor) continue;
    const dx = other.x - actor.x;
    const dz = other.z - actor.z;
    const forward = dx * s + dz * c;
    let lateral = Math.abs(dx * c - dz * s);
    const radius = other.type === "pedestrian" ? (other.radius ?? 0.4) : (other.width ?? 1.85) / 2;
    if (other.type === "pedestrian" && forward > 0 && forward <= 60) {
      // A walker stepping into the lane counts where it will be when the truck arrives, not where it stands now.
      const walk = Math.max(other.speed ?? 0, 0);
      const sideVel = walk * (Math.sin(other.heading ?? 0) * c - Math.cos(other.heading ?? 0) * s);
      const arrivalS = Math.min(2.5, forward / Math.max(actor.speed ?? 0, 1.5));
      lateral = Math.min(lateral, Math.abs(dx * c - dz * s + sideVel * arrivalS));
    }
    if (forward <= 0 || forward > 60 || lateral > (actor.width ?? 2.45) / 2 + radius + 0.25) continue;
    const half = other.type === "pedestrian" ? radius : (other.length ?? 4.2) / 2;
    const gap = forward - (actor.length ?? 8.2) / 2 - half;
    const vOther = other.type === "pedestrian" ? 0 : Math.max(other.speed ?? 0, 0);
    const room = Math.sqrt(Math.max(0, vOther * vOther + 2 * comfort * Math.max(0, gap - 3.5)));
    // Some room left means a crawl, not a full stop for a walker that keeps strolling alongside.
    cap = Math.min(cap, gap > 3.5 ? Math.max(room, 1.2) : room);
  }
  if (cap >= base.targetSpeed) return null;
  return { ...base, targetSpeed: cap, reason: "truck-yield" };
}

// Distant freight trucks only follow the district logic, which watches walkers as they are now: a walker stepping
// into the lane beside a crosswalk gets a head start on the truck, so it stops short of the crossing line.
function walkerYield(world, actor, base) {
  const s = Math.sin(actor.heading);
  const c = Math.cos(actor.heading);
  const others = world.actorIndex.near(actor, 22);
  let cap = Infinity;
  for (let i = 0; i < others.length; i++) {
    const other = others[i];
    if (other.type !== "pedestrian") continue;
    const dx = other.x - actor.x;
    const dz = other.z - actor.z;
    const forward = dx * s + dz * c;
    if (forward <= 0 || forward > 20) continue;
    const walk = Math.max(other.speed ?? 0, 0);
    const sideVel = walk * (Math.sin(other.heading ?? 0) * c - Math.cos(other.heading ?? 0) * s);
    const arrivalS = Math.min(2.5, forward / Math.max(actor.speed ?? 0, 1.5));
    const lateral = Math.min(Math.abs(dx * c - dz * s), Math.abs(dx * c - dz * s + sideVel * arrivalS));
    if (lateral > (actor.width ?? 2.45) / 2 + (other.radius ?? 0.4) + 0.25) continue;
    const gap = forward - (actor.length ?? 8.2) / 2 - (other.radius ?? 0.4);
    cap = Math.min(cap, Math.sqrt(Math.max(0, 2 * 3 * (gap - 1.2))));
  }
  return cap < base.targetSpeed ? { ...base, targetSpeed: cap, reason: "truck-yield" } : null;
}

export function streetChaosTrafficCommand(world, actor, baseCommand) {
  const state = activeState(world);
  if (!state || actor === world.player || actor.type !== "vehicle") return baseCommand;
  const man = maneuvers.get(actor);
  if (man) {
    const result = runManeuver(world, state, actor, man, baseCommand);
    if (result) return result;
  }
  const ego = world.player;
  const dx = actor.x - ego.x;
  const dz = actor.z - ego.z;
  if (dx * dx + dz * dz > NEAR_COMMAND_M * NEAR_COMMAND_M)
    return actor.kind === "truck" && isChaosSpawn(actor) ? walkerYield(world, actor, baseCommand) ?? baseCommand : baseCommand;
  if (!originals.has(actor)) applyClassPhysics(actor);
  const frame = laneFrame(world, actor, { maxPsi: 0.5 });
  let command = baseCommand;
  let bypassing = false;
  if (frame) {
    const bypass = accidentBypass(world, state, actor, frame, command);
    if (bypass) {
      command = bypass;
      bypassing = true;
    } else {
      const off = offLaneDrive(world, state, actor, frame, command);
      if (off) command = off;
    }
  }
  if (actor.kind === "truck" && !bypassing) {
    const yielded = heavyYield(world, actor, command);
    if (yielded) command = yielded;
  }
  const creep = breakMutualYield(world, actor, baseCommand);
  return creep ?? command;
}

/* --------------------------------------------------------- step updates */

function formAccident(world, state, event, acc, lead, follow, leadMan, followMan, closing) {
  // Role-specific damage: the late car crumples its nose, the braking lead takes the hit on its tail.
  recordActorVisualCrash(follow, follow, lead, Math.max(closing, 5.5));
  recordActorVisualCrash(lead, lead, follow, Math.max(closing, 5));
  state.crashed.add(lead);
  state.crashed.add(follow);
  skewWreck(world, acc, follow, lead);
  state.accidentRoles = {
    [lead.id]: { role: "lead", skewSign: maneuvers.get(lead).skewSign },
    [follow.id]: { role: "follower", skewSign: -maneuvers.get(lead).skewSign },
  };
  leadMan.phase = "wreck";
  followMan.phase = "wreck";
  acc.formed = true;
  acc.impactTick = world.tick;
  event.phase = "wreck";
  event.impactTick = world.tick;
  state.accidentActorIds = [lead.id, follow.id];
}

function refreshAccident(world, state, event) {
  const acc = state.accident;
  if (!acc) return;
  const lead = actorById(world, acc.leadId);
  const follow = actorById(world, acc.followId);
  if (!lead || !follow) { finishEvent(world, state, event, "lost-actor"); return; }
  const leadMan = maneuvers.get(lead);
  const followMan = maneuvers.get(follow);
  if (!acc.formed) {
    const blocked = follow.reason === "occupied" && follow.blockedBy === lead.id;
    if (blocked && followMan && leadMan) {
      formAccident(world, state, event, acc, lead, follow, leadMan, followMan, Math.max(follow.previous?.speed ?? 0, 2.6));
    } else if (follow.speed < 0.05 && lead.speed < 0.05 && world.tick - event.startTick > TICKS(1)) {
      const gap = bodyExtentsOnLane(acc.frame, lead).sMin - bodyExtentsOnLane(acc.frame, follow).sMax;
      if (gap < 2.2 && followMan && leadMan) formAccident(world, state, event, acc, lead, follow, leadMan, followMan, 2.6);
      else if (world.tick - event.startTick > TICKS(6)) finishEvent(world, state, event, "no-impact");
    } else if (world.tick - event.startTick > TICKS(6)) {
      finishEvent(world, state, event, "no-impact");
    }
    return;
  }
  advanceSlew(world, acc);
  const lf = acc.frame;
  const a = bodyExtentsOnLane(lf, lead);
  const b = bodyExtentsOnLane(lf, follow);
  acc.sMin = Math.min(a.sMin, b.sMin);
  acc.sMax = Math.max(a.sMax, b.sMax);
  acc.latMin = Math.min(a.latMin, b.latMin);
  acc.latMax = Math.max(a.latMax, b.latMax);
  const e = egoOn(lf, world.player);
  const rearPastM = e.s - (world.player.length ?? 4.2) / 2 - acc.sMax;
  if (rearPastM > 1.5) acc.passed = true;
  const passed = rearPastM > 14;
  // The wreck lingers about 25 s of the ego actually rolling within 40 m of it (and 90 s at most), so a junction wait never hides it.
  if (world.player.speed >= 0.5 && Math.abs(e.s - (acc.sMin + acc.sMax) / 2) < 40) acc.nearTicks = (acc.nearTicks ?? 0) + 1;
  const timedOut = (acc.nearTicks ?? 0) > TICKS(25) || world.tick - acc.impactTick > TICKS(90);
  if (passed || timedOut) {
    finishEvent(world, state, event, passed || acc.passed ? "cleared-passed" : "cleared-timeout");
    for (const actor of [lead, follow]) {
      actor.speed = 0;
      actor.reason = "ready";
    }
    registerManeuver(state, lead, { event: null, kind: "accident", role: "limp", leader: true, other: follow, startTick: world.tick, done: false });
    registerManeuver(state, follow, { event: null, kind: "accident", role: "limp", leader: false, other: lead, startTick: world.tick, done: false });
  }
}

function skewWreck(world, acc, follow, lead) {
  // The late car slews against the lead's tail: its nose swings away from the centre line, its tail toward it,
  // and it slides at least 0.45 m sideways. Largest legible skew first, never into a body or off the road.
  const frame = acc.frame;
  const here = coordsOn(frame.road, frame.d, follow);
  const slide = acc.variant === "inner" ? 1 : -1;
  const sign = -slide;
  const leadExt = bodyExtentsOnLane(frame, lead);
  const tiers = [WRECK_CLEARANCE_M - 0.35, WRECK_CLEARANCE_M - 0.7];
  for (const needClear of tiers) for (const [yaw, shift] of [[0.40, 0.6], [0.34, 0.55], [0.3, 0.5], [0.25, 0.45]]) {
    const p = lanePoint(frame.road, frame.d, here.s, here.lat + slide * shift);
    const cand = { type: "vehicle", length: follow.length, width: follow.width, heading: normalizeAngle(frame.laneHeading + sign * yaw), x: p.x, z: p.z };
    // The roadway beside the wreck must stay at least ~3.1 m wide on the bypass side.
    const ext = bodyExtentsOnLane(frame, cand);
    const clear = acc.variant === "inner" ? Math.min(ext.latMin, leadExt.latMin) + frame.halfW : -0.2 - Math.max(ext.latMax, leadExt.latMax);
    if (clear < needClear) continue;
    if (overlaps(cand, lead, 0.05) || !bodyOnRoad(cand, world.roads, 0.12)) continue;
    if (world.actors.some((other) => other !== follow && other !== lead && overlaps(cand, other, 0.2))) continue;
    // The car slews into its final pose over a few ticks rather than jumping.
    acc.slew = { actor: follow, lead, from: { x: follow.x, z: follow.z, heading: follow.heading }, to: cand, tick: 0 };
    return;
  }
}

const SLEW_TICKS = 9;

function advanceSlew(world, acc) {
  const slew = acc.slew;
  if (!slew) return;
  const k = ++slew.tick / SLEW_TICKS;
  const { actor, lead, from, to } = slew;
  const cand = {
    type: "vehicle", length: actor.length, width: actor.width,
    x: from.x + (to.x - from.x) * k, z: from.z + (to.z - from.z) * k,
    heading: from.heading + angleDelta(to.heading, from.heading) * k,
  };
  if (!overlaps(cand, lead, 0.02) && bodyOnRoad(cand, world.roads, 0.1)) {
    actor.x = cand.x;
    actor.z = cand.z;
    actor.heading = cand.heading;
  }
  if (slew.tick >= SLEW_TICKS) acc.slew = null;
}
function updateEvent(world, state, event) {
  if (event.kind === "accident") { refreshAccident(world, state, event); return; }
  const actor = actorById(world, event.actorIds[0]);
  const man = actor ? maneuvers.get(actor) : null;
  if (!actor || !man) { finishEvent(world, state, event, "lost-actor"); return; }
  if (man.done) finishEvent(world, state, event, man.cutCompleted ? "completed" : "aborted");
}

function trackEgo(world, state) {
  const ego = world.player;
  const impacts = ego.vehicle?.damage?.impactCount ?? 0;
  if (impacts > state.lastImpacts) {
    state.metrics.collisions += impacts - state.lastImpacts;
    state.lastImpacts = impacts;
  }
  state.metrics.distanceM = Math.max(0, (ego.distance ?? 0) - state.startDistance);
  for (const other of world.actors) {
    if (other === ego || other.type !== "vehicle" || Math.abs(other.x - ego.x) > 14 || Math.abs(other.z - ego.z) > 14) continue;
    if (!(isChaosSpawn(other) || maneuvers.has(other))) continue;
    let entry = state.nearMiss.get(other.id);
    const close = overlaps(ego, other, 1.4);
    if (close && !entry) state.nearMiss.set(other.id, { impacts, minGap: true });
    else if (!close && entry && !overlaps(ego, other, 3.2)) {
      if (impacts === entry.impacts) state.metrics.nearMissesAvoided++;
      state.nearMiss.delete(other.id);
    }
  }
}

function processCleanup(world, state) {
  if (!state.cleanup.length) return;
  const ego = world.player;
  const remove = new Set();
  state.cleanup = state.cleanup.filter((entry) => {
    const actor = actorById(world, entry.id);
    if (!actor) return false;
    if (world.tick < entry.afterTick) return true;
    const far = Math.hypot(actor.x - ego.x, actor.z - ego.z) >= entry.minDistanceM;
    const stuckAway = world.tick > entry.afterTick + TICKS(70);
    if (far || stuckAway && Math.hypot(actor.x - ego.x, actor.z - ego.z) > 40) {
      remove.add(actor);
      return false;
    }
    return true;
  });
  if (remove.size) {
    removeActors(world, (actor) => remove.has(actor));
    for (const actor of remove) { originals.delete(actor); maneuvers.delete(actor); state.managed.delete(actor); }
  }
}

function recycleTrucks(world, state) {
  if (world.tick < state.nextRecycleTick) return;
  state.nextRecycleTick = world.tick + TICKS(1);
  const ego = world.player;
  for (const truck of [...state.trucks]) {
    const far = Math.hypot(truck.x - ego.x, truck.z - ego.z);
    const idle = !truck.path.length || (truck.wait > 8 && far > 70);
    const finished = idle || (truck.path.length > 1 && (truck.cursor ?? 0) > truck.path.length - 40);
    if (far < 105 || !finished) continue;
    const replacement = trySpawnTruck(world, state, { near: far > 160, minPlayerDistance: 95, minAheadM: 110 });
    if (!replacement) continue;
    removeActors(world, (actor) => actor === truck);
    originals.delete(truck);
    world.actors.push(replacement);
    world.actorIndex = new SpatialIndex(world.actors);
    traitsOf(world, state, replacement);
    state.trucks[state.trucks.indexOf(truck)] = replacement;
  }
}

// District replanning can hand a freight truck a turn it cannot physically make (the wheel locks and the cab
// leaves the carriageway); it goes back to its straight avenue lane instead.
function pathTurnsTooSharply(path, cursor) {
  let travelled = 0;
  let spanStart = Math.max(0, cursor - 1);
  let prevHeading = null;
  for (let i = spanStart + 1; i < path.length && travelled < 130; i++) {
    const dx = path[i].x - path[spanStart].x;
    const dz = path[i].z - path[spanStart].z;
    const span = Math.hypot(dx, dz);
    if (span < 6) continue;
    travelled += span;
    const heading = Math.atan2(dx, dz);
    if (prevHeading !== null && Math.abs(angleDelta(heading, prevHeading)) > 0.3) return true;
    prevHeading = heading;
    spanStart = i;
  }
  return false;
}

function keepTrucksStraight(world, state) {
  if (world.tick & 7) return;
  for (const truck of state.trucks) {
    const path = truck.path;
    if (!path || path.length < 12 || !pathTurnsTooSharply(path, truck.cursor ?? 0)) continue;
    const frame = laneFrame(world, truck, { minWidth: 10, maxPsi: 0.9 });
    if (!frame || aheadRoomM(frame) < 50) continue;
    const lat = clamp(coordsOn(frame.road, frame.d, truck).lat, -(frame.halfW - 2), -1.8);
    const fresh = straightLanePath(frame, frame.s + 3, lat, Math.min(380, aheadRoomM(frame) - 14));
    if (!fresh.length) continue;
    truck.path = fresh;
    truck.cursor = 0;
    world.routeRevision++;
  }
}

// A stopped car ahead means a queue: trouble spawned in front of the ego would only wedge into it.
function queueAheadOfEgo(world) {
  const ego = world.player;
  const s = Math.sin(ego.heading);
  const c = Math.cos(ego.heading);
  for (const actor of world.actors) {
    if (actor === ego || actor.type !== "vehicle" || (actor.speed ?? 0) >= 1.2) continue;
    const dx = actor.x - ego.x;
    const dz = actor.z - ego.z;
    const forward = dx * s + dz * c;
    if (forward > 4 && forward < 70 && Math.abs(dx * c - dz * s) < 6 && Math.abs(angleDelta(actor.heading, ego.heading)) < 0.6)
      return true;
  }
  return false;
}

function schedule(world, state) {
  if (world.tick < state.nextEventTick) return;
  const cfg = INTENSITY[state.intensity];
  if (state.events.length >= cfg.maxActive || state.accident) { state.nextEventTick = world.tick + TICKS(1.5); return; }
  // Spontaneous trouble only starts while the ego is actually rolling, never on top of a junction queue.
  if ((world.player.speed ?? 0) < 1.8 || world.districtBehavior?.holds?.[world.player.id] || queueAheadOfEgo(world)) { state.nextEventTick = world.tick + TICKS(1.5); return; }
  const ef = egoFrameOf(world, 10);
  if (!ef) { state.nextEventTick = world.tick + TICKS(1.2); return; }
  const roll = state.rng.next();
  let kind = roll < 0.45 ? "ghorz" : roll < 0.8 ? "lane-change" : "accident";
  if (kind === "accident" && (state.accident || world.tick < state.nextAccidentTick || ef.road.width < 12.4)) {
    kind = roll < 0.62 ? "ghorz" : "lane-change";
  }
  if (state.events.some((event) => event.kind === kind)) kind = kind === "ghorz" ? "lane-change" : "ghorz";
  const event = kind === "ghorz" ? startGhorz(world, state)
    : kind === "lane-change" ? startLaneChange(world, state) : startAccident(world, state);
  if (event && kind === "accident")
    state.nextAccidentTick = world.tick + TICKS(cfg.accidentCooldownS);
  const [lo, hi] = cfg.interval;
  state.nextEventTick = world.tick + TICKS(event ? state.rng.range(lo, hi) : 1.5);
}

export function stepStreetChaos(world) {
  const state = activeState(world);
  if (!state) return;
  state.metrics.ticksActive++;
  if (world.mode === "manual") state.egoReaction = null;
  trackEgo(world, state);
  for (const event of [...state.events]) updateEvent(world, state, event);
  processCleanup(world, state);
  recycleTrucks(world, state);
  keepTrucksStraight(world, state);
  retryPending(world, state);
  schedule(world, state);
  if ((world.tick & 15) === 0) {
    const ego = world.player;
    let count = 0;
    for (const actor of world.actors) {
      if (actor.type !== "vehicle" || actor === ego) continue;
      const t = traits.get(actor);
      if (t?.offLaneOffsetM && (actor.x - ego.x) ** 2 + (actor.z - ego.z) ** 2 < 120 * 120) count++;
    }
    state.metrics.offLaneActiveCount = count;
  }
}

/* -------------------------------------------------------------- snapshot */

function activeHazardOf(world, state) {
  const ego = world.player;
  let best = null;
  let bestDistance = Infinity;
  for (const event of state.events) {
    const actors = event.actorIds.map((id) => actorById(world, id)).filter(Boolean);
    if (!actors.length) continue;
    const distanceM = Math.min(...actors.map((a) => Math.hypot(a.x - ego.x, a.z - ego.z)));
    if (distanceM < bestDistance) {
      bestDistance = distanceM;
      best = { kind: event.kind, label: event.label, actorIds: [...event.actorIds], distanceM: Math.round(distanceM * 10) / 10 };
    }
  }
  return best;
}

export function streetChaosSnapshot(world) {
  const state = world.streetChaos;
  if (!state) {
    return {
      active: false, version: STREET_CHAOS_VERSION, intensity: "rush", driverMode: "auto", truckCount: 0,
      offLaneCount: 0, accidentActorIds: [], activeHazard: null, egoReaction: null, activeEvents: [],
      recentEvents: [], request: null, accidentRoles: {}, metrics: { nearMissesAvoided: 0, collisions: 0, ghorzCount: 0, laneCutCount: 0,
        accidentCount: 0, distanceM: 0, ticksActive: 0 },
    };
  }
  const active = state.active;
  const m = state.metrics;
  return {
    active,
    version: STREET_CHAOS_VERSION,
    intensity: state.intensity,
    driverMode: state.driverMode,
    truckCount: active ? state.trucks.length : 0,
    offLaneCount: active ? m.offLaneActiveCount : 0,
    accidentActorIds: active ? [...state.accidentActorIds] : [],
    activeHazard: active ? activeHazardOf(world, state) : null,
    egoReaction: active && state.egoReaction ? { ...state.egoReaction } : null,
    activeEvents: active ? state.events.map((event) => ({
      id: event.id, kind: event.kind, label: event.label, phase: event.phase,
      startTick: event.startTick, actorIds: [...event.actorIds],
    })) : [],
    recentEvents: state.recent.map((event) => ({ ...event, actorIds: [...event.actorIds] })),
    accidentRoles: active ? Object.fromEntries(Object.entries(state.accidentRoles).map(([id, r]) => [id, { ...r }])) : {},
    request: state.request ? {
      id: state.request.id, kind: state.request.kind, status: state.request.status, reason: state.request.reason,
      debugReason: state.request.debugReason, atTick: state.request.atTick,
      remainingS: state.request.status === "pending" && state.request.untilTick != null
        ? Math.max(0, Math.round((state.request.untilTick - world.tick) * STEP * 10) / 10) : 0,
    } : null,
    metrics: {
      nearMissesAvoided: m.nearMissesAvoided, collisions: m.collisions, ghorzCount: m.ghorzCount,
      laneCutCount: m.laneCutCount, accidentCount: m.accidentCount, distanceM: Math.round(m.distanceM * 10) / 10,
      ticksActive: m.ticksActive,
    },
  };
}
