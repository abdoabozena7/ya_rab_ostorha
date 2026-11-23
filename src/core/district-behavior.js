import { STEP, VEHICLE, clamp } from "./config.js";
import {
  angleDelta,
  bodyOnRoad,
  distance,
  isDiagonalRoad,
  makeDiagonalRoad,
  overlaps,
  roadFrame,
  roadIntersection,
  roadPointAt,
  roadProject,
} from "./geometry.js";
import { pedestrianMotion } from "./pedestrian.js";
import { canLeaveWalkMargin, planWalk, walkSegmentClear } from "./walk-route.js";
import {
  hasImmutablePathPoints, integrateVehicle, markImmutablePath, nearestPathPoint, vehicleProbe,
} from "./vehicle.js";
import { planDistrictRoute } from "./district-navigation.js";
import { SpatialIndex } from "./spatial-index.js";

const HISTORY_LIMIT = 96;
const WALK_TARGET_GAP = 0.12;
const PROFILE = Object.freeze({
  cautious: { headwayS: 2.2, speedFactor: 0.88 },
  ordinary: { headwayS: 1.6, speedFactor: 1 },
  assertive: { headwayS: 1, speedFactor: 1 },
});
const HUMAN_PATTERNS = [
  "diagonal", "hesitant", "retreat", "emergence", "stationary", "parallel", "crossing",
];
const zoneGeometryCache = new WeakMap();
const adjoiningJunctionResources = new WeakMap();
const pathGeometryCache = new WeakMap();
const isDistrict = (world) => world.environment === "egypt" || world.environment === "metro";
const now = (world) => world.tick * STEP;
const along = (walkway, point) => walkway.axis === "diag"
  ? (point.x - walkway.x1) * walkway.ux + (point.z - walkway.z1) * walkway.uz
  : point[walkway.axis === "z" ? "z" : "x"];
const walkPose = (walkway, position) => walkway.axis === "diag"
  ? { x: walkway.x1 + walkway.ux * position, z: walkway.z1 + walkway.uz * position }
  : walkway.axis === "z"
    ? { x: walkway.fixed, z: position }
    : { x: position, z: walkway.fixed };

export function avenueCrossings(road, roads) {
  if (road.zone !== "avenue") return [];
  const fa = isDiagonalRoad(road) ? roadFrame(road) : null;
  return [...new Set(roads.flatMap(other => {
    if (other === road) return [];
    if (!isDiagonalRoad(road) && !isDiagonalRoad(other)) {
      if (other.axis === road.axis ||
          road.fixed < other.min || road.fixed > other.max ||
          other.fixed < road.min || other.fixed > road.max) return [];
      const offset = other.width / 2 + 2.4;
      return [other.fixed - offset, other.fixed + offset];
    }
    const hit = roadIntersection(road, other, 0.5);
    if (!hit) return [];
    const rFrame = fa ?? roadFrame(road), oFrame = roadFrame(other);
    const sinAngle = Math.max(0.35, Math.abs(-rFrame.ux * oFrame.uz + rFrame.uz * oFrame.ux));
    const cosAngle = Math.abs(rFrame.ux * oFrame.ux + rFrame.uz * oFrame.uz);
    const offset = (other.width / 2 + (road.width / 2) * cosAngle) / sinAngle + 2.4;
    return [hit.alongA - offset, hit.alongA + offset];
  }).filter(pos => pos > road.min + 8 && pos < road.max - 8))];
}
function zoneGeometry(zone) {
  let geometry = zoneGeometryCache.get(zone);
  if (!geometry || geometry.id !== zone.id ||
      !Object.is(geometry.minX, zone.minX) || !Object.is(geometry.maxX, zone.maxX) ||
      !Object.is(geometry.minZ, zone.minZ) || !Object.is(geometry.maxZ, zone.maxZ)) {
    geometry = {
      id: zone.id, minX: zone.minX, maxX: zone.maxX, minZ: zone.minZ, maxZ: zone.maxZ,
      body: {
        id: zone.id, type: "static", heading: 0,
        x: (zone.minX + zone.maxX) / 2, z: (zone.minZ + zone.maxZ) / 2,
        width: zone.maxX - zone.minX, length: zone.maxZ - zone.minZ,
      },
    };
    zoneGeometryCache.set(zone, geometry);
  }
  return geometry;
}

function occupies(car, zone, gap = 0.12, geometry = zoneGeometry(zone)) {
  // This L1 enclosure contains both gap-expanded SAT rectangles at every yaw.
  const reach = (Math.abs(car.length) + Math.abs(car.width)) / 2 + Math.abs(gap) * 2;
  if (car.x + reach < geometry.minX || car.x - reach > geometry.maxX ||
      car.z + reach < geometry.minZ || car.z - reach > geometry.maxZ) return false;
  return overlaps(car, geometry.body, gap);
}
function outsideApproach(car, zone, range) {
  const dx = Math.max(zone.minX - car.x, 0, car.x - zone.maxX);
  const dz = Math.max(zone.minZ - car.z, 0, car.z - zone.maxZ);
  return dx > range || dz > range || Math.hypot(dx, dz) > range;
}
// Planned tangents omit the follower's turn swing; manual corridors use the plant.
const queueClearance = (world, car, zone) => 0.55 +
  (zone.kind === "junction" && car.path?.length > 1 &&
    !(car === world.player && world.mode === "manual") ? car.width : 0);

export function createDistrictBehaviorState() {
  return {
    reservations: {}, queues: {}, approaches: {}, holds: {}, observedPedestrians: {},
    nextTicket: 1, lastTick: -1,
    metrics: {
      grants: 0, releases: 0, occupiedRetentions: 0, eligibleBypasses: 0,
      exitStorageHolds: 0, entryQueueHolds: 0, peakWaitS: 0, replans: 0, reroutes: 0,
      blockingCycles: 0, peakBlockingCycles: 0,
      pedestrianDecisions: 0, acceptedPedestrianDistanceM: 0,
    },
    events: [],
  };
}

function stateFor(world) {
  return world.districtBehavior ??= createDistrictBehaviorState();
}

function event(world, actor, kind, trigger, details = {}) {
  const state = stateFor(world);
  state.events.push({
    tick: world.tick, timeS: now(world), actorId: actor?.id ?? null,
    kind, trigger, ...details,
  });
  if (state.events.length > HISTORY_LIMIT)
    state.events.splice(0, state.events.length - HISTORY_LIMIT);
}

export function initializeDistrictActor(world, actor) {
  if (!isDistrict(world) || actor.district) return actor;
  const choice = world.rng.next();
  if (actor.type === "vehicle") {
    const profile = choice < 0.28 ? "cautious" : choice < 0.8 ? "ordinary" : "assertive";
    actor.district = {
      profile, headwayS: PROFILE[profile].headwayS,
      nextLoadingDistanceM: (actor.distance ?? 0) + world.rng.range(38, 72),
      loadingDurationS: world.rng.range(0.7, 1.8),
      loadingUntilTick: null, reroutedTicket: null,
      ...(actor === world.player && (!world.districtCase || world.districtCase.allowReroute)
        ? { allowReroute: true } : {}),
    };
  } else if (actor.type === "pedestrian") {
    const pattern = HUMAN_PATTERNS[Math.min(HUMAN_PATTERNS.length - 1,
      Math.floor(choice * HUMAN_PATTERNS.length))];
    actor.district = {
      pattern, yieldAtCurb: !["diagonal", "emergence", "retreat"].includes(pattern),
      decision: 0, stage: "ready", holdAtTarget: false,
      observedDistanceM: actor.distance ?? 0,
    };
  }
  return actor;
}

function closestWalkway(world, person) {
  const walkways = world.district?.walkways ?? [];
  let closest = null, best = Infinity;
  for (const walkway of walkways) {
    const position = clamp(along(walkway, person), walkway.min, walkway.max);
    const score = distance(person, walkPose(walkway, position));
    if (score < best) {
      best = score;
      closest = walkway;
    }
  }
  return closest;
}

function clearWalkTarget(world, person, target) {
  const stopped = (world.actors ?? []).filter((actor) =>
    actor.type === "vehicle" && Math.abs(actor.speed) < 0.8);
  return walkSegmentClear(person, target, target,
    (world.statics ?? []).concat(stopped), 0.12);
}

function clearWalkLeg(world, person, target) {
  return clearWalkTarget(world, person, target) &&
    walkSegmentClear(person, person, target, world.statics ?? [], 0.12);
}

function lineConnection(a, b) {
  if (a.axis !== "diag" && b.axis !== "diag") {
    if (a.axis === b.axis) return null;
    const vertical = a.axis === "z" ? a : b, horizontal = a.axis === "x" ? a : b;
    const point = { x: vertical.fixed, z: horizontal.fixed };
    return point.z >= vertical.min && point.z <= vertical.max &&
      point.x >= horizontal.min && point.x <= horizontal.max ? point : null;
  }
  const hit = roadIntersection(a, b, 0.5);
  if (!hit) return null;
  return hit.alongA >= a.min - 0.5 && hit.alongA <= a.max + 0.5 &&
    hit.alongB >= b.min - 0.5 && hit.alongB <= b.max + 0.5
    ? { x: hit.x, z: hit.z } : null;
}

/** Targets belong to declared walklines, never a width-derived phantom sidewalk. */
export function nextDistrictWalk(world, person) {
  if (!isDistrict(world)) return false;
  initializeDistrictActor(world, person);
  const state = person.district;
  if (state.caseId) return false;
  const walkway = closestWalkway(world, person);
  if (!walkway) {
    person.target = { x: person.x, z: person.z };
    person.pause = 1;
    state.stage = "no-walkway";
    return false;
  }
  const inset = person.radius + 0.12;
  const lower = walkway.min + inset, upper = walkway.max - inset;
  if (lower > upper) return false;
  const position = clamp(along(walkway, person), lower, upper);
  person.walkDirection ??= person.phase < 0.5 ? -1 : 1;
  if (position < lower + 2) person.walkDirection = 1;
  if (position > upper - 2) person.walkDirection = -1;
  const draw = world.rng.next();
  let pattern = HUMAN_PATTERNS[Math.min(HUMAN_PATTERNS.length - 1,
    Math.floor(draw * HUMAN_PATTERNS.length))];
  const stride = world.rng.range(6, 14);
  const holdS = world.rng.range(0.45, 1.15);
  const street = world.environment === "metro"
    ? world.district.drivingRoads.find(road => road.id === walkway.roadId) : null;
  const avenue = street?.zone === "avenue";
  const crossing = avenue ? avenueCrossings(street, world.district.drivingRoads)
    .map(value => walkway.axis === "diag" ? along(walkway, roadPointAt(street, value, 0)) : value)
    .filter(value => Math.abs(value - position) < 1.6 && value >= lower && value <= upper)
    .sort((a, b) => Math.abs(a - position) - Math.abs(b - position))[0] : undefined;
  const crossPos = crossing ?? position;
  const crossOrigin = walkPose(walkway, crossPos);
  const opposite = (world.district.walkways ?? []).filter((line) => {
    if (line.roadId !== walkway.roadId || line.axis !== walkway.axis ||
        line.side === walkway.side || (avenue && crossing === undefined)) return false;
    const separated = walkway.axis === "diag"
      ? distance(walkPose(line, clamp(along(line, crossOrigin), line.min, line.max)), crossOrigin) > 0.5
      : Math.abs(line.fixed - walkway.fixed) > 0.5;
    if (!separated) return false;
    const lineAlong = walkway.axis === "diag" ? along(line, crossOrigin) : crossPos;
    return lineAlong >= line.min + inset && lineAlong <= line.max - inset;
  });
  let selected = walkway, target = null, declaredRoute = null;
  if (pattern === "emergence" || position < lower + 2 || position > upper - 2) {
    const connections = (world.district.walkways ?? []).flatMap((line) => {
      if (line.id === walkway.id) return [];
      const joint = lineConnection(walkway, line);
      if (!joint || !clearWalkLeg(world, person, joint)) return [];
      const from = along(line, joint);
      const direction = line.max - from >= from - line.min ? 1 : -1;
      const point = walkPose(line, clamp(from + stride * direction,
        line.min + inset, line.max - inset));
      return distance(joint, point) > 0.6 && clearWalkTarget(world, person, point) &&
        walkSegmentClear(person, joint, point, world.statics ?? [], 0.12)
        ? [{ line, joint, point }] : [];
    });
    if (connections.length) {
      const connection = world.rng.pick(connections);
      selected = connection.line;
      target = connection.point;
      declaredRoute = [connection.joint, target];
    }
  }
  if (!target && !["parallel", "stationary"].includes(pattern) && opposite.length) {
    selected = world.rng.pick(opposite);
    if (avenue) pattern = "crossing";
    const shift = pattern === "diagonal" ? person.walkDirection * world.rng.range(2, 4) : 0;
    const baseSelectedAlong = walkway.axis === "diag" ? along(selected, crossOrigin) : crossPos;
    const candidate = walkPose(selected,
      clamp(baseSelectedAlong + shift, selected.min + inset, selected.max - inset));
    if (clearWalkLeg(world, person, candidate)) {
      target = candidate;
      if (avenue) declaredRoute = [walkPose(walkway, crossing), candidate];
    }
  }
  if (!target) {
    pattern = pattern === "stationary" ? pattern : "parallel";
    selected = walkway;
    // Both stride directions are legal catalogue choices; a blocked doorway
    // cannot make the walker select an obstacle corner as its destination.
    for (const multiplier of [1, -1, 0.5, -0.5]) {
      const candidate = walkPose(walkway,
        clamp(position + stride * person.walkDirection * multiplier, lower, upper));
      if (distance(person, candidate) > 0.5 && clearWalkLeg(world, person, candidate)) {
        target = candidate;
        if (multiplier < 0) person.walkDirection *= -1;
        break;
      }
    }
  }
  if (!target) {
    const candidate = walkPose(walkway, position);
    target = clearWalkTarget(world, person, candidate)
      ? candidate : { x: person.x, z: person.z };
    pattern = "stationary";
  }
  Object.assign(state, {
    pattern, walkwayId: walkway.id, targetWalkwayId: selected.id,
    decision: (state.decision ?? 0) + 1,
    stage: pattern === "emergence" ? "await-approach" : "moving",
    origin: { x: person.x, z: person.z }, destination: { ...target },
    startedTick: world.tick, startedDistanceM: person.distance ?? 0,
    holdS, reactionDone: false, holdAtTarget: false, routeConstrained: true,
    yieldAtCurb: !["diagonal", "emergence", "retreat"].includes(pattern),
  });
  person.walkRoute = declaredRoute;
  person.walkGoal = declaredRoute ? `${target.x},${target.z}` : null;
  person.walkPlanTick = world.tick;
  person.target = target;
  person.crossing = selected.axis === walkway.axis && selected.side !== walkway.side;
  person.side = walkway.side;
  person.along = position;
  const targetRoad = (world.district.drivingRoads ?? []).find((road) => road.id === selected.roadId);
  if (targetRoad) person.road = targetRoad;
  person.pause = pattern === "stationary" ? holdS + 0.8 : 0;
  if (pattern === "stationary" || pattern === "emergence") {
    state.holdUntilTick = world.tick + Math.ceil(
      (pattern === "stationary" ? holdS + 0.8 : 4) / STEP);
    if (pattern === "stationary") person.target = { x: person.x, z: person.z };
  }
  stateFor(world).metrics.pedestrianDecisions++;
  event(world, person, "walk-decision", person.distance > 0 ? "accepted-waypoint" : "authored-start", {
    pattern, walkwayId: walkway.id, targetWalkwayId: selected.id,
  });
  return true;
}

function approachingVehicle(world, person, range = 15) {
  let nearest = null, best = range;
  for (const car of world.actors ?? []) {
    if (car.type !== "vehicle" || car.speed < 0.35) continue;
    const dx = person.x - car.x, dz = person.z - car.z;
    if (Math.abs(dx) > best || Math.abs(dz) > best) continue;
    const d = Math.hypot(dx, dz);
    if (d >= best) continue;
    const s = Math.sin(car.heading), c = Math.cos(car.heading);
    const forward = dx * s + dz * c;
    const lateral = Math.abs(dx * c - dz * s);
    if (forward > -car.length / 2 && lateral < 7 && d < best) {
      best = d;
      nearest = car;
    }
  }
  return nearest ? { triggerActorId: nearest.id, distanceM: best, speedMps: nearest.speed } : null;
}

function copyWalker(person) {
  return {
    ...person, target: person.target ? { ...person.target } : { x: person.x, z: person.z },
    walkRoute: person.walkRoute?.map((point) => ({ ...point })) ?? null,
    district: {
      ...person.district,
      origin: person.district?.origin ? { ...person.district.origin } : null,
      destination: person.district?.destination ? { ...person.district.destination } : null,
    },
  };
}

function prepareWalkRoute(world, person) {
  const key = `${person.target.x},${person.target.z}`;
  if (person.walkGoal !== key || !person.walkRoute ||
      world.tick >= (person.walkPlanTick ?? 0) + 90) {
    const nearby = world.actorIndex.near(person, 28);
    const obstacles = nearby.filter((actor) =>
      actor.id !== person.id && actor.type !== "pedestrian" && Math.abs(actor.speed ?? 0) < 0.8)
      .concat(world.staticIndex.near(person, 34));
    // Conservative planning boxes give a stopped peer detour nodes; physical
    // walking and World's guard still use the actual circular human bodies.
    for (const actor of nearby)
      if (actor.id !== person.id && actor.type === "pedestrian" &&
          actor.speed < 0.1 && actor.wait >= 1)
        obstacles.push({
          id: actor.id, type: "static", x: actor.x, z: actor.z, heading: 0,
          width: actor.radius * 2, length: actor.radius * 2,
        });
    const first = person.walkRoute?.[0];
    const allowMarginExit = canLeaveWalkMargin(world, person);
    if (person.walkGoal !== key || !first ||
        !walkSegmentClear(person, person, first, obstacles, 0.12, allowMarginExit))
      person.walkRoute = planWalk(person, person.target, obstacles, allowMarginExit);
    person.walkGoal = key;
    person.walkPlanTick = world.tick;
  }
  while (person.walkRoute.length > 1 && distance(person, person.walkRoute[0]) < 0.25)
    person.walkRoute.shift();
}

function isStoppedVehicle(actor) {
  return actor.type === "vehicle" && Math.abs(actor.speed) < 0.8;
}

function findWalkTargetBlocker(actors, target) {
  return actors.find(actor => isStoppedVehicle(actor) && overlaps(target, actor, WALK_TARGET_GAP));
}

// Only use this index during simultaneous proposals, before any body moves.
export function createWalkTargetQuery(actors) {
  const parked = new SpatialIndex();
  let maxRadius = 0;
  for (let order = 0; order < actors.length; order++) {
    const actor = actors[order];
    if (!isStoppedVehicle(actor)) continue;
    maxRadius = Math.max(maxRadius, Math.hypot(actor.length, actor.width) / 2);
    parked.add({ x: actor.x, z: actor.z, actor, order });
  }
  return target => {
    const reach = target.radius + maxRadius + WALK_TARGET_GAP;
    if (!Number.isFinite(reach) || !Number.isFinite(target.x) || !Number.isFinite(target.z))
      return findWalkTargetBlocker(actors, target);
    let first;
    for (const candidate of parked.near(target, reach)) {
      if ((!first || candidate.order < first.order) &&
          overlaps(target, candidate.actor, WALK_TARGET_GAP)) first = candidate;
    }
    return first?.actor;
  };
}

/** Uses the ordinary articulated body's acceleration, turning and continuous guard. */
export function stepDistrictPedestrian(world, person, targetBlocker) {
  if (!isDistrict(world)) return pedestrianMotion(world, person);
  initializeDistrictActor(world, person);
  const working = copyWalker(person), state = working.district;
  const behavior = stateFor(world), observations = behavior.observedPedestrians;
  const acceptedDistance = Math.max(0,
    (person.distance ?? 0) - (observations[person.id] ?? person.distance ?? 0));
  behavior.metrics.acceptedPedestrianDistanceM += acceptedDistance;
  observations[person.id] = person.distance ?? 0;
  state.observedDistanceM = person.distance ?? 0;
  if (!state.caseId && !person.target) nextDistrictWalk(world, working);
  if (!state.caseId && world.tick >= (state.targetRetryTick ?? 0)) {
    const target = { type: "pedestrian", radius: working.radius,
      x: working.target.x, z: working.target.z };
    const blocker = targetBlocker ? targetBlocker(target) : findWalkTargetBlocker(world.actors, target);
    if (blocker) {
      state.targetRetryTick = world.tick + 90;
      event(world, person, "walk-retarget", "occupied-catalog-target", { blockedBy: blocker.id });
      nextDistrictWalk(world, working);
    } else if ((world.config?.cityVersion ?? 0) >= 5 && distance(working, working.target) > 6) {
      state.targetRetryTick = world.tick + 12;
    }
  }
  const progressed = (person.distance ?? 0) - (state.startedDistanceM ?? 0);
  let vehicle, approachChecked = false;
  let hold = false;
  if (!state.caseId && state.stage === "await-approach") {
    vehicle = approachingVehicle(world, working);
    approachChecked = true;
    hold = !vehicle && world.tick < state.holdUntilTick;
    if (!hold) {
      state.stage = "moving";
      working.pause = 0;
      event(world, person, "emergence", vehicle ? "vehicle-approach" : "bounded-idle-release",
        vehicle ?? {});
    }
  }
  if (!state.caseId && state.pattern === "stationary" && world.tick < state.holdUntilTick)
    hold = true;
  if (!state.caseId && state.pattern === "stationary" && world.tick >= state.holdUntilTick) {
    event(world, person, "resume", "bounded-curb-hold-complete");
    nextDistrictWalk(world, working);
  }
  if (!state.caseId && !state.reactionDone && progressed > 0.55 &&
      (state.pattern === "hesitant" || state.pattern === "retreat")) {
    if (!approachChecked) vehicle = approachingVehicle(world, working);
    if (vehicle) {
      state.reactionDone = true;
      state.holdUntilTick = world.tick + Math.ceil(state.holdS / STEP);
      state.stage = state.pattern === "retreat" ? "retreating" : "hesitating";
      if (state.pattern === "retreat") {
        working.target = { ...state.origin };
        working.walkRoute = null;
        working.crossing = false;
        state.holdAtTarget = true;
      }
      event(world, person, state.stage, "vehicle-approach-after-entry", {
        ...vehicle, acceptedProgressM: progressed,
      });
    }
  }
  if (!state.caseId && state.stage === "hesitating") {
    hold = world.tick < state.holdUntilTick;
    if (!hold) {
      state.stage = "moving";
      event(world, person, "resume", "bounded-hesitation-complete");
    }
  }
  if (!state.caseId && state.stage === "retreating" &&
      distance(working, state.origin) < 0.3 && working.speed < 0.08) {
    state.stage = "moving";
    state.holdAtTarget = false;
    working.target = { ...state.destination };
    working.walkRoute = null;
    working.crossing = true;
    event(world, person, "resume", "accepted-retreat-arrival");
  }
  const requestedMode = working.motionMode;
  if (hold) working.motionMode = "stop";
  if (state.routeConstrained) prepareWalkRoute(world, working);
  const proposal = pedestrianMotion(world, working, true);
  proposal.motionMode = requestedMode;
  if (hold && proposal.reason !== "blocked") proposal.reason = `district-${state.stage}`;
  else if (!state.caseId && proposal.reason === "walking" && state.pattern === "parallel")
    proposal.reason = "district-parallel";
  return proposal;
}

function activeVehicle(world, car) {
  if (car === world.player && world.mode === "manual")
    return Math.abs(world.input?.targetSpeed ?? 0) > 0.01 || Math.abs(car.speed) > 0.05;
  return (car.path?.length ?? 0) > 1 || Math.abs(car.speed) > 0.05;
}

function pathGeometry(path) {
  let geometry = pathGeometryCache.get(path);
  if (geometry?.immutable) return geometry;
  let valid = geometry?.points.length === path.length;
  for (let i = 0; valid && i < path.length; i++)
    valid = Object.is(path[i].x, geometry.points[i].x) &&
      Object.is(path[i].z, geometry.points[i].z);
  const immutable = hasImmutablePathPoints(path);
  if (valid) {
    geometry.immutable = immutable;
    return geometry;
  }
  const points = immutable ? path : path.map((point) => ({ x: point.x, z: point.z }));
  const next = new Int32Array(points.length).fill(-1);
  const lengths = new Float64Array(points.length), samples = new Array(points.length);
  for (let i = 0; i < points.length - 1; i++)
    for (let j = i + 1; j < points.length; j++) {
      const segment = distance(points[i], points[j]);
      if (segment < 0.03) continue;
      next[i] = j;
      lengths[i] = segment;
      samples[i] = {
        x: points[j].x, z: points[j].z,
        heading: Math.atan2(points[j].x - points[i].x, points[j].z - points[i].z),
      };
      break;
    }
  geometry = { immutable, points, next, lengths, samples, zones: new WeakMap() };
  pathGeometryCache.set(path, geometry);
  return geometry;
}

function footprintFlags(path, car, zone, geometry) {
  let cached = path.zones.get(zone);
  if (!cached || cached.geometry !== geometry) {
    cached = { geometry, shapes: new Map() };
    path.zones.set(zone, cached);
  }
  const key = `${car.length}:${car.width}`;
  if (!cached.shapes.has(key)) {
    if (cached.shapes.size >= 8) cached.shapes.clear();
    cached.shapes.set(key, new Uint8Array(path.points.length));
  }
  return cached.shapes.get(key);
}

function forwardPath(world, car, horizonM = 110) {
  const result = [{ x: car.x, z: car.z, heading: car.heading }];
  const distances = [0];
  const fromIndices = [-1];
  let geometry = null, tail = -1;
  const manual = car === world.player && world.mode === "manual";
  if (manual) {
    const sign = (world.input?.targetSpeed ?? car.speed) < 0 ? -1 : 1;
    const probe = vehicleProbe(car, sign * Math.max(1.2, Math.abs(car.speed)));
    const command = { targetSpeed: probe.speed, steer: world.input?.steer ?? 0 };
    let travelled = 0;
    for (let i = 0; i < 500 && travelled < 90; i++) {
      const x = probe.x, z = probe.z;
      command.targetSpeed = probe.speed;
      integrateVehicle(probe, command, Math.min(0.16, 0.3 / Math.abs(probe.speed)), probe);
      travelled += Math.hypot(x - probe.x, z - probe.z);
      result.push({ x: probe.x, z: probe.z, heading: probe.heading });
      distances.push(travelled);
    }
  } else if (car.path?.length > 1) {
    geometry = pathGeometry(car.path);
    const cursor = car.cursor ?? 0;
    const nearest = nearestPathPoint(car.path, car.x, car.z, cursor, Math.max(0, cursor - 2));
    for (let i = nearest; i < car.path.length && horizonM > 0; i++) {
      const point = geometry.points[i];
      if (i === nearest && (point.x - car.x) * Math.sin(car.heading) +
          (point.z - car.z) * Math.cos(car.heading) < -0.05) continue;
      const segment = distance(car, point);
      if (segment < 0.03) continue;
      result.push({
        x: point.x, z: point.z,
        heading: Math.atan2(point.x - car.x, point.z - car.z),
      });
      distances.push(0 + segment);
      fromIndices.push(-1);
      tail = i;
      break;
    }
  } else {
    const sign = car.speed < 0 ? -1 : 1;
    const s = Math.sin(car.heading), c = Math.cos(car.heading);
    for (let d = 0.5; d <= 90; d += 0.5) {
      result.push({
        x: car.x + s * d * sign,
        z: car.z + c * d * sign,
        heading: car.heading,
      });
      distances.push(d);
    }
  }
  return { points: result, distances, geometry, fromIndices, tail, horizonM };
}

// Most zones only need the approach prefix. Extend it on demand, in the same
// addition order, and share it with the other zones for this car and tick.
function extendTrajectory(path) {
  const from = path.tail;
  if (from < 0 || path.geometry.next[from] < 0) return false;
  const distances = path.distances, travelled = distances[distances.length - 1];
  if (!(travelled < path.horizonM)) return false;
  distances.push(travelled + path.geometry.lengths[from]);
  path.points.push(path.geometry.samples[from]);
  path.fromIndices.push(from);
  path.tail = path.geometry.next[from];
  return true;
}

function trajectoryLength(path) {
  while (extendTrajectory(path)) {}
  return path.distances.at(-1);
}

function routeThroughZone(car, zone, path, geometry = zoneGeometry(zone), approachM = Infinity) {
  let entryM = Infinity, exitedAtM = null, entryCount = 0;
  const exitSamples = [];
  const flags = path.geometry ? footprintFlags(path.geometry, car, zone, geometry) : null;
  const occupied = occupies(car, zone, 0.12, geometry);
  const pose = { type: car.type, length: car.length, width: car.width,
    x: car.x, z: car.z, heading: car.heading };
  let entered = occupied;
  if (entered) entryM = 0;
  for (let i = 0; i < path.points.length || extendTrajectory(path); i++) {
    const point = path.points[i], from = path.fromIndices[i] ?? -1;
    const alongM = path.distances[i];
    if (!entered && alongM > approachM) return null;
    let inside;
    if (i === 0) inside = occupied;
    else if (from >= 0 && flags?.[from]) inside = flags[from] === 2;
    else {
      pose.x = point.x;
      pose.z = point.z;
      pose.heading = point.heading;
      inside = occupies(pose, zone, 0.12, geometry);
      if (from >= 0 && flags) flags[from] = inside ? 2 : 1;
    }
    if (inside && entryM === Infinity) {
      entryM = alongM;
      entered = true;
    }
    if (!entered) entryCount++;
    if (entered && !inside && alongM > entryM) {
      exitedAtM ??= alongM;
      exitSamples.push({ type: car.type, length: car.length, width: car.width,
        x: point.x, z: point.z, heading: point.heading, alongM });
      if (alongM - exitedAtM >= car.length + 0.5) break;
    }
  }
  if (!entered && entryM > approachM) return null;
  return {
    distanceM: entryM,
    exitDistanceM: exitedAtM ?? Infinity,
    hasExit: exitedAtM !== null && exitSamples.length > 0 &&
      exitSamples.at(-1).alongM - exitedAtM >= car.length + 0.35,
    entryCount, entryPath: path, exitSamples,
  };
}

function approachBlocker(world, car, route) {
  const vehicles = world.actors.filter((actor) =>
    actor.id !== car.id && actor.type === "vehicle");
  for (let i = 0; i < route.entryCount; i++) {
    const point = route.entryPath.points[i];
    const pose = { type: "vehicle", length: car.length, width: car.width, ...point };
    const blocker = vehicles.find((other) => overlaps(pose, other, 0.12));
    if (blocker) return blocker.id;
  }
  return null;
}

function storageBlocker(world, car, route, zone) {
  if (!route.hasExit) return zone.id;
  const obstacles = (world.actors ?? []).filter((actor) => actor.id !== car.id)
    .concat(world.statics ?? []);
  for (const pose of route.exitSamples) {
    if (!bodyOnRoad(pose, world.roads, 0.12)) return zone.id;
    const blocker = obstacles.find((other) => overlaps(pose, other, 0.12));
    if (blocker) return blocker.id;
  }
  return null;
}

export function onRoadLimit(world, car) {
  let limit = Infinity, roadId = null, width = 0;
  for (const road of world.district?.drivingRoads ?? world.drivingRoads ?? []) {
    const proj = roadProject(road, car);
    if (proj.along < road.min - 0.2 || proj.along > road.max + 0.2 || proj.absLateral > road.width / 2)
      continue;
    const { heading } = roadFrame(road);
    const aligned = Math.min(Math.abs(angleDelta(car.heading, heading)),
      Math.abs(angleDelta(car.heading, heading + Math.PI))) < 0.8;
    if (!aligned) continue;
    if (Number.isFinite(road.speedLimitMps) && road.speedLimitMps < limit) {
      limit = Math.max(0, road.speedLimitMps);
      roadId = road.id;
      width = road.width;
    }
  }
  return { limit, roadId, width };
}

export function rushRoadLimit(road, police = false) {
  // Only the authored broad, high-speed avenues get an arcade pace.
  return road.width >= 12 && road.limit >= 9 ? road.limit + (police ? 5 : 3.2) : road.limit;
}

export const isPackPursuit = variant => variant === "pack" || variant === "hunt" || variant === "survival";
export const isRushPack = variant => isPackPursuit(variant) || variant === "arcade";
export const usesRushPace = variant => variant === "rush" || variant === "cinematic" || isRushPack(variant);

export function arcadePatrolLimit(road) {
  return rushRoadLimit(road) + (road.width >= 12 ? 6.5 : 4.5);
}

function blockingCycles(cars) {
  const stopped = new Map(cars.filter((car) =>
    Math.abs(car.speed) < 0.15 && car.wait >= 5).map((car) => [car.id, car]));
  const examined = new Set();
  let count = 0;
  for (const id of stopped.keys()) {
    const chain = new Set();
    let current = id;
    while (stopped.has(current) && !examined.has(current) && !chain.has(current)) {
      chain.add(current);
      current = stopped.get(current).blockedBy;
    }
    if (chain.has(current)) count++;
    for (const visited of chain) examined.add(visited);
  }
  return count;
}

function withoutQueuedDeparture(world, route) {
  const exit = route?.exitSamples[0];
  if (!exit) return null;
  const district = world.district;
  const road = district.drivingRoads.find((item) => item.id === onRoadLimit(world, exit).roadId);
  if (!road) return null;
  const frame = roadFrame(road);
  const sign = (Math.sin(exit.heading) * frame.ux + Math.cos(exit.heading) * frame.uz) > 0 ? 1 : -1;
  if (road.flow && road.flow !== sign) return null;
  const cuts = new Set([road.min, road.max]);
  for (const other of district.drivingRoads) {
    if (other === road) continue;
    if (!isDiagonalRoad(road) && !isDiagonalRoad(other)) {
      if (other.axis !== road.axis && other.fixed >= road.min && other.fixed <= road.max &&
          road.fixed >= other.min && road.fixed <= other.max)
        cuts.add(other.fixed);
    } else {
      const hit = roadIntersection(road, other, 0.5);
      if (hit) cuts.add(Math.max(road.min, Math.min(road.max, hit.alongA)));
    }
  }
  const alongVal = roadProject(road, exit).along, sorted = [...cuts].sort((a, b) => a - b);
  const index = sorted.findIndex((value, i) => i + 1 < sorted.length &&
    alongVal >= value && alongVal <= sorted[i + 1]);
  if (index < 0) return null;
  const min = sorted[index], max = sorted[index + 1], pieces = [];
  const subPiece = (subMin, subMax, flowOverride = road.flow) => {
    if (!isDiagonalRoad(road)) return { ...road, min: subMin, max: subMax, flow: flowOverride };
    const p1 = roadPointAt(road, subMin, 0), p2 = roadPointAt(road, subMax, 0);
    return makeDiagonalRoad({ ...road, x1: p1.x, z1: p1.z, x2: p2.x, z2: p2.z, flow: flowOverride });
  };
  if (road.min < min) pieces.push(subPiece(road.min, min));
  if (!road.flow) pieces.push(subPiece(min, max, -sign));
  if (max < road.max) pieces.push(subPiece(max, road.max));
  // Restrict only this search's existing directed link; the physical map stays unchanged.
  return { ...district, drivingRoads: district.drivingRoads.flatMap((item) => item === road ? pieces : [item]) };
}

function plannedPassageVisits(car, path, zone, cursor = 0) {
  const reach = car.length / 2;
  let visits = 0, inside = false;
  for (let i = cursor; i < path.length; i++) {
    const point = path[i];
    const next = point.x >= zone.minX - reach && point.x <= zone.maxX + reach &&
      point.z >= zone.minZ - reach && point.z <= zone.maxZ + reach;
    if (next && !inside) visits++;
    inside = next;
  }
  return visits;
}

export function planDistrictTrafficTrip(world, car, start) {
  const { district, actors } = world;
  const congested = district.conflictZones.filter((zone) => zone.kind === "single-lane" &&
    actors.filter((actor) => actor !== car && actor.type === "vehicle" &&
      plannedPassageVisits(actor, actor.path ?? [], zone, actor.cursor)).length >= 2);
  const goals = district.trafficGoals;
  let fallback = [];
  const maxTrials = (world.config?.cityVersion ?? 0) >= 5 ? Math.min(goals.length, 4) : goals.length;
  for (let i = 0; i < maxTrials; i++) {
    const goal = goals[(start + i) % goals.length];
    if (distance(car, goal) < 12) continue;
    const path = planDistrictRoute(district, car, goal, actors);
    if (path.length <= 10) continue;
    if (!congested.some((zone) => plannedPassageVisits(car, path, zone))) return markImmutablePath(path);
    if (!fallback.length) fallback = path;
  }
  return fallback.length ? markImmutablePath(fallback) : fallback;
}

function replanQueuedVehicle(world, car, zone, queuedRoute, waitS = 0) {
  if (car.district.caseId && !car.district.allowReroute) return false;
  // A different internal road cannot bypass an occupied atomic resource.
  // Replan for a blocked exit, not merely to spend the same wait on a longer trip.
  if (!queuedRoute || !storageBlocker(world, car, queuedRoute, zone)) return false;
  const end = car.path?.at(-1), before = car.path?.at(-2);
  const goal = car.goal ?? car.parking ?? car.district.goal ?? (end && before ? {
    x: end.x, z: end.z,
    heading: Math.atan2(end.x - before.x, end.z - before.z),
  } : null);
  if (!goal) return false;
  const remaining = car.parking ? trajectoryLength(forwardPath(world, car, Infinity)) : null;
  const district = world.district;
  const roads = district.drivingRoads.filter((road) => {
    if (zone.kind !== "single-lane" || road.flow || (road.laneOffsetM ?? 0) !== 0)
      return true;
    if (isDiagonalRoad(road)) {
      return road.x1 < zone.minX || road.x1 > zone.maxX ||
        road.x2 < zone.minX || road.x2 > zone.maxX ||
        road.z1 < zone.minZ || road.z1 > zone.maxZ ||
        road.z2 < zone.minZ || road.z2 > zone.maxZ;
    }
    return road.axis === "z"
      ? road.fixed < zone.minX || road.fixed > zone.maxX ||
        road.min < zone.minZ || road.max > zone.maxZ
      : road.fixed < zone.minZ || road.fixed > zone.maxZ ||
        road.min < zone.minX || road.max > zone.maxX;
  });
  // Avoid the occupied single-lane link, not its registered turning support.
  // Replanning a queue is still the same trip, never a new random destination.
  const profiles = roads.length < district.drivingRoads.length
    ? [{ ...district, drivingRoads: roads }, district] : [district];
  if (queuedRoute && storageBlocker(world, car, queuedRoute, zone)) {
    const alternative = withoutQueuedDeparture(world, queuedRoute);
    if (alternative) profiles.push(alternative);
  }
  for (const profile of profiles) {
    const path = planDistrictRoute(profile, car, goal, world.actors);
    if (path.length <= 10 || !routeChanged(car.path, path)) continue;
    // Both mouths share one lease. Circling around the alley can add a
    // second visit to the same queue, even when it avoids the narrow link.
    if (zone.kind === "single-lane" &&
        plannedPassageVisits(car, path, zone) >
          plannedPassageVisits(car, car.path, car.cursor)) continue;
    const proposed = { ...car, path, cursor: 0 };
    const trajectory = forwardPath(world, proposed, car.parking ? Infinity : 110);
    if (car.parking) {
      const speedBound = Math.min(car.maxSpeed ?? 0, onRoadLimit(world, car).limit);
      // A precise arrival should not buy more extra driving than its observed delay.
      if (trajectoryLength(trajectory) - remaining > Math.max(0, waitS) * speedBound + 1e-6)
        continue;
    }
    const exit = routeThroughZone(proposed, zone, trajectory);
    if (storageBlocker(world, car, exit, zone)) continue;
    car.path = path;
    car.cursor = 0;
    return true;
  }
  return false;
}

function routeChanged(before, after) {
  for (let i = 0; i < after.length; i += 8)
    if (!before.some((point) =>
      (point.x - after[i].x) ** 2 + (point.z - after[i].z) ** 2 <= 1))
      return true;
  return false;
}

function distanceInsideZone(path, zone) {
  while (extendTrajectory(path)) {}
  let total = 0;
  for (let i = 1; i < path.points.length; i++) {
    const a = path.points[i - 1], b = path.points[i];
    let enter = 0, leave = 1;
    for (const [axis, min, max] of [["x", zone.minX, zone.maxX], ["z", zone.minZ, zone.maxZ]]) {
      const delta = b[axis] - a[axis];
      if (Math.abs(delta) < 1e-8) {
        if (a[axis] < min || a[axis] > max) { enter = 2; break; }
      } else {
        const low = (min - a[axis]) / delta, high = (max - a[axis]) / delta;
        enter = Math.max(enter, Math.min(low, high));
        leave = Math.min(leave, Math.max(low, high));
      }
    }
    total += Math.max(0, leave - enter) * distance(a, b);
  }
  return total;
}

function divertCongestedCirculation(world, car, approachZone, approachPath) {
  const state = stateFor(world);
  if (car === world.player || car.parking || car.district.caseId ||
      occupies(car, approachZone) ||
      state.reservations[approachZone.id]?.ownerId === car.id ||
      world.tick < (car.district.nextCongestionPlanTick ?? 0)) return false;
  for (const zone of world.district.conflictZones) {
    if (zone.kind !== "single-lane") continue;
    const demand = world.actors.filter((actor) => actor !== car && actor.type === "vehicle" &&
      (occupies(actor, zone) || state.approaches[actor.id]?.zoneId === zone.id)).length;
    const queued = (state.queues[zone.id] ?? []).some((entry) => entry.waitS > 6 &&
      state.approaches[entry.actorId]?.zoneId === zone.id);
    if (demand < 2 && !queued) continue;
    const near = routeThroughZone(car, zone, approachPath);
    if (!near.hasExit) continue;
    const roads = world.district.drivingRoads.filter((road) => {
      if (road.flow || (road.laneOffsetM ?? 0) !== 0) return true;
      const contained = isDiagonalRoad(road)
        ? road.x1 >= zone.minX && road.x1 <= zone.maxX &&
          road.x2 >= zone.minX && road.x2 <= zone.maxX &&
          road.z1 >= zone.minZ && road.z1 <= zone.maxZ &&
          road.z2 >= zone.minZ && road.z2 <= zone.maxZ
        : road.axis === "z"
          ? road.fixed >= zone.minX && road.fixed <= zone.maxX &&
            road.min >= zone.minZ && road.max <= zone.maxZ
          : road.fixed >= zone.minZ && road.fixed <= zone.maxZ &&
            road.min >= zone.minX && road.max <= zone.maxX;
      if (!contained) return true;
      return !car.path.slice(Math.max(0, car.cursor - 2)).some((point) => {
        const proj = roadProject(road, point);
        return proj.along > road.min + car.length && proj.along < road.max - car.length &&
          proj.absLateral < (isDiagonalRoad(road) ? 1e-3 : 1e-4);
      });
    });
    if (roads.length === world.district.drivingRoads.length) continue;
    if ((world.config?.cityVersion ?? 0) >= 5 && world.pursuit?.gta?.config?.tacticalPursuit === "gta-tactical-v1") {
      if (world._routePlanTick === world.tick && world._routePlanCount >= 2) return false;
      if (world._routePlanTick !== world.tick) {
        world._routePlanTick = world.tick;
        world._routePlanCount = 0;
      }
      world._routePlanCount++;
    }
    car.district.nextCongestionPlanTick = world.tick + Math.ceil(6 / STEP);
    const end = car.path.at(-1), before = car.path.at(-2);
    const goal = car.goal ?? car.district.goal ?? {
      ...end, heading: Math.atan2(end.x - before.x, end.z - before.z),
    };
    const path = planDistrictRoute({ ...world.district, drivingRoads: roads }, car, goal, world.actors);
    if (path.length <= 10 || !routeChanged(car.path, path)) continue;
    const proposed = { ...car, path, cursor: 0 }, future = forwardPath(world, proposed, Infinity);
    const exit = routeThroughZone(proposed, approachZone, future);
    if (!Number.isFinite(exit.distanceM) || storageBlocker(world, car, exit, approachZone)) continue;
    const oldTransitM = distanceInsideZone(forwardPath(world, car, Infinity), zone);
    const newTransitM = distanceInsideZone(future, zone);
    if (newTransitM + car.length >= oldTransitM) continue;
    car.path = markImmutablePath(path);
    car.cursor = 0;
    state.metrics.replans++;
    state.metrics.reroutes++;
    event(world, car, "traffic-reroute", "observed-downstream-resource-queue", {
      zoneId: approachZone.id, congestedZoneId: zone.id, oldTransitM, newTransitM,
      routeChanged: true,
    });
    return true;
  }
  return false;
}

function trafficApproach(world, car, zoneRows, paths, routes) {
  let closest = null;
  const active = activeVehicle(world, car);
  let path;
  for (const { zone, geometry } of zoneRows) {
    if ((!active || outsideApproach(car, zone, Math.max(zone.approachM, car.length + 1)
          + car.length + 3)) && !occupies(car, zone, 0.12, geometry)) continue;
    if (active && !path) {
      path = forwardPath(world, car);
      paths.set(car.id, path);
    }
    const threshold = Math.max(zone.approachM, car.length + 1, car.speed ** 2 / (2 * 3.5) + 2);
    const route = active ? routeThroughZone(car, zone, path, geometry, threshold)
      : { distanceM: 0, hasExit: false, exitSamples: [], entryCount: 0 };
    if (!route) continue;
    routes.set(`${zone.id}:${car.id}`, route);
    if (!closest || route.distanceM < closest.distanceM)
      closest = { zoneId: zone.id, distanceM: route.distanceM };
  }
  return closest;
}

function trafficResources(world) {
  const zones = world.district?.conflictZones;
  if (!zones || !(world.config?.cityVersion >= 4)) return zones ?? [];
  if (adjoiningJunctionResources.has(zones)) return adjoiningJunctionResources.get(zones);
  const resources = zones.slice();
  for (let i = 0; i < resources.length; i++) {
    let a = resources[i];
    if (a.kind !== "junction") continue;
    for (let j = i + 1; j < resources.length; j++) {
      const b = resources[j];
      if (b.kind !== "junction") continue;
      const x = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);
      const z = Math.min(a.maxZ, b.maxZ) - Math.max(a.minZ, b.minZ);
      // When the mouths share a car-width boundary there is no exit storage
      // between them. Individual grants can leave two turning cars nose to nose.
      if (!((x === 0 && z >= VEHICLE.length) || (z === 0 && x >= VEHICLE.length))) continue;
      a = resources[i] = { ...a, id: `${a.id}+${b.id}`, approachM: Math.max(a.approachM, b.approachM),
        minX: Math.min(a.minX, b.minX), maxX: Math.max(a.maxX, b.maxX),
        minZ: Math.min(a.minZ, b.minZ), maxZ: Math.max(a.maxZ, b.maxZ) };
      resources.splice(j--, 1);
    }
  }
  adjoiningJunctionResources.set(zones, resources);
  return resources;
}

const zoneRowGridCache = new WeakMap();
const ZONE_GRID_M = 48;

function getIndexedZoneRows(zones) {
  let cached = zoneRowGridCache.get(zones);
  if (
    cached &&
    cached.len === zones.length &&
    zones.every((z, i) => {
      const r = cached.rows[i];
      return (
        r.zone === z &&
        r.geometry.id === z.id &&
        Object.is(r.geometry.minX, z.minX) &&
        Object.is(r.geometry.maxX, z.maxX) &&
        Object.is(r.geometry.minZ, z.minZ) &&
        Object.is(r.geometry.maxZ, z.maxZ) &&
        Object.is(r.approachM, z.approachM)
      );
    })
  ) {
    return cached;
  }
  const rows = zones.map((zone) => ({ zone, geometry: zoneGeometry(zone), approachM: zone.approachM }));
  const cells = new Map();
  let maxApproachM = 18;
  for (const row of rows) {
    const { zone } = row;
    maxApproachM = Math.max(maxApproachM, zone.approachM ?? 0);
    const x0 = Math.floor(zone.minX / ZONE_GRID_M), x1 = Math.floor(zone.maxX / ZONE_GRID_M);
    const z0 = Math.floor(zone.minZ / ZONE_GRID_M), z1 = Math.floor(zone.maxZ / ZONE_GRID_M);
    for (let x = x0; x <= x1; x++) {
      for (let z = z0; z <= z1; z++) {
        const key = (x << 16) ^ (z & 0xffff);
        let bucket = cells.get(key);
        if (!bucket) cells.set(key, bucket = []);
        bucket.push(row);
      }
    }
  }
  cached = { len: zones.length, rows, cells, maxApproachM };
  zoneRowGridCache.set(zones, cached);
  return cached;
}

function nearbyZoneRowsForCar(indexed, car) {
  if (indexed.rows.length <= 18) return indexed.rows;
  const len = Math.abs(car.length ?? 4.5), wid = Math.abs(car.width ?? 2.0);
  const reach = Math.max(indexed.maxApproachM, len + 1) + len + wid + 4;
  const x0 = Math.floor((car.x - reach) / ZONE_GRID_M), x1 = Math.floor((car.x + reach) / ZONE_GRID_M);
  const z0 = Math.floor((car.z - reach) / ZONE_GRID_M), z1 = Math.floor((car.z + reach) / ZONE_GRID_M);
  const seen = new Set(), out = [];
  for (let x = x0; x <= x1; x++) {
    for (let z = z0; z <= z1; z++) {
      const bucket = indexed.cells.get((x << 16) ^ (z & 0xffff));
      if (!bucket) continue;
      for (let i = 0; i < bucket.length; i++) {
        const row = bucket[i];
        if (!seen.has(row)) {
          seen.add(row);
          out.push(row);
        }
      }
    }
  }
  return out;
}

/** First-arrival tickets are per-world and never timed out while occupied. */
export function updateDistrictTraffic(world) {
  if (!isDistrict(world)) return;
  const state = stateFor(world);
  if (state.lastTick === world.tick) return;
  if ((world.config?.cityVersion ?? 0) >= 5 &&
      world.pursuit?.gta?.config?.tacticalPursuit === "gta-tactical-v1" &&
      state.lastTick === world.tick - 1 && (world.tick & 1) === 1) {
    return;
  }
  state.lastTick = world.tick;
  state.approaches = {};
  state.holds = {};
  const cars = world.actors.filter((actor) => actor.type === "vehicle");
  state.metrics.blockingCycles = blockingCycles(cars);
  state.metrics.peakBlockingCycles = Math.max(
    state.metrics.peakBlockingCycles, state.metrics.blockingCycles);
  const byId = new Map(cars.map((car) => [car.id, car]));
  const paths = new Map();
  const routes = new Map();
  const zones = trafficResources(world);
  const indexedZones = getIndexedZoneRows(zones);
  const zoneRows = indexedZones.rows;
  const occupantsByZone = new Map();
  for (const car of cars) {
    initializeDistrictActor(world, car);
    const localZoneRows = nearbyZoneRowsForCar(indexedZones, car);
    for (let i = 0; i < localZoneRows.length; i++) {
      const { zone, geometry } = localZoneRows[i];
      if (occupies(car, zone, 0.12, geometry)) {
        let list = occupantsByZone.get(zone.id);
        if (!list) occupantsByZone.set(zone.id, list = []);
        list.push(car);
      }
    }
    const closest = trafficApproach(world, car, localZoneRows, paths, routes);
    if (closest) state.approaches[car.id] = closest;
  }
  const approachesByZone = new Map();
  for (const car of cars) {
    const closest = state.approaches[car.id];
    const canDivert = !((world.config?.cityVersion ?? 0) >= 5 &&
      world.pursuit?.gta?.config?.tacticalPursuit === "gta-tactical-v1" &&
      world._routePlanTick === world.tick && world._routePlanCount >= 2);
    if (canDivert && closest && paths.has(car.id) && divertCongestedCirculation(world, car,
      zones.find((zone) => zone.id === closest.zoneId), paths.get(car.id))) {
      if ((world.config?.cityVersion ?? 0) >= 5 && world.pursuit?.gta?.config?.tacticalPursuit === "gta-tactical-v1") {
        if (world._routePlanTick !== world.tick) {
          world._routePlanTick = world.tick;
          world._routePlanCount = 0;
        }
        world._routePlanCount++;
      }
      paths.delete(car.id);
      const updated = trafficApproach(world, car, nearbyZoneRowsForCar(indexedZones, car), paths, routes);
      if (updated) state.approaches[car.id] = updated;
      else delete state.approaches[car.id];
    }
    const approach = state.approaches[car.id];
    if (approach) {
      const group = approachesByZone.get(approach.zoneId);
      if (group) group.push(car);
      else approachesByZone.set(approach.zoneId, [car]);
    }
  }
  for (const { zone } of zoneRows) {
    let reservation = state.reservations[zone.id];
    const occupants = occupantsByZone.get(zone.id) ?? [];
    if (reservation) {
      const owner = byId.get(reservation.ownerId);
      const occupied = owner && occupants.includes(owner);
      if (occupied) {
        reservation.entered = true;
        if (distance(owner, reservation.lastPose) > 0.08) {
          reservation.lastProgressTick = world.tick;
          reservation.lastPose = { x: owner.x, z: owner.z };
        }
        state.metrics.occupiedRetentions++;
      } else {
        const stillApproaching = owner && activeVehicle(world, owner) &&
          state.approaches[owner.id]?.zoneId === zone.id;
        const progressed = owner && distance(owner, reservation.lastPose) > 0.08;
        if (progressed) {
          reservation.lastPose = { x: owner.x, z: owner.z };
          reservation.lastProgressTick = world.tick;
        }
        if (!owner || reservation.entered || !stillApproaching ||
            world.tick - reservation.lastProgressTick > 6 / STEP) {
          event(world, owner, "resource-release",
            reservation.entered ? "whole-body-cleared" : "inactive-outside-resource",
            { zoneId: zone.id, ticket: reservation.ticket });
          delete state.reservations[zone.id];
          reservation = null;
          state.metrics.releases++;
        }
      }
    }
    // An actual occupant outranks a stale, unentered reservation, including
    // an idle manual player. No lease can make an occupied resource empty.
    if (occupants.length && (!reservation ||
        !occupants.some((car) => car.id === reservation.ownerId))) {
      const occupant = occupants[0];
      reservation = {
        ownerId: occupant.id, ticket: state.nextTicket++,
        sinceTick: world.tick, entered: true, lastProgressTick: world.tick,
        lastPose: { x: occupant.x, z: occupant.z },
      };
      state.reservations[zone.id] = reservation;
      event(world, occupant, "resource-occupancy", "actual-body-in-resource", { zoneId: zone.id });
    }
    const previousQueue = state.queues[zone.id] ?? [];
    const queue = [];
    for (const car of approachesByZone.get(zone.id) ?? []) {
      if (!activeVehicle(world, car) || reservation?.ownerId === car.id) continue;
      const earlier = previousQueue.find((entry) => entry.actorId === car.id);
      const entry = earlier ?? {
        actorId: car.id, ticket: state.nextTicket++, arrivedTick: world.tick,
        startDistanceM: car.distance ?? 0,
      };
      entry.waitS = (world.tick - entry.arrivedTick) * STEP;
      entry.progressM = Math.max(0, (car.distance ?? 0) - entry.startDistanceM);
      queue.push(entry);
      if (!earlier)
        event(world, car, "resource-arrival", "actual-path-approach", {
          zoneId: zone.id, ticket: entry.ticket,
          distanceM: state.approaches[car.id].distanceM,
        });
      state.metrics.peakWaitS = Math.max(state.metrics.peakWaitS, entry.waitS);
    }
    queue.sort((a, b) => {
      const arrival = a.arrivedTick - b.arrivedTick;
      if (arrival || zone.kind !== "single-lane") return arrival || a.ticket - b.ticket;
      // Simultaneous arrivals should not inherit an actor-array priority.
      const aExit = routes.get(`${zone.id}:${a.actorId}`).exitDistanceM;
      const bExit = routes.get(`${zone.id}:${b.actorId}`).exitDistanceM;
      if (Number.isFinite(aExit) && Number.isFinite(bExit)) {
        const clearance = Math.round(aExit * 1e6) - Math.round(bExit * 1e6);
        if (clearance) return clearance;
      }
      return a.ticket - b.ticket;
    });
    state.queues[zone.id] = queue;
    if (!reservation && !occupants.length && queue.length) {
      for (let index = 0; index < queue.length; index++) {
        const entry = queue[index], candidate = byId.get(entry.actorId);
        const route = routes.get(`${zone.id}:${candidate.id}`);
        const heldResource = Object.entries(state.reservations)
          .find(([, lease]) => lease.ownerId === candidate.id)?.[0];
        // A follower cannot bypass the held front ticket by reserving its lane.
        const entryBlocker = heldResource ? null : approachBlocker(world, candidate, route);
        const blocker = heldResource ?? entryBlocker ?? storageBlocker(world, candidate, route, zone);
        if (blocker) {
          if (entryBlocker) state.metrics.entryQueueHolds++;
          else state.metrics.exitStorageHolds++;
          state.holds[candidate.id] = {
            zoneId: zone.id, blockedBy: blocker,
            reason: entryBlocker ? "district-entry-queue" : "district-exit-storage",
            distanceM: state.approaches[candidate.id].distanceM,
            stopBeforeM: queueClearance(world, candidate, zone),
            ticket: entry.ticket, waitS: entry.waitS,
          };
          continue;
        }
        queue.splice(index, 1);
        reservation = {
          ownerId: candidate.id, ticket: entry.ticket, sinceTick: world.tick,
          entered: false, lastProgressTick: world.tick,
          lastPose: { x: candidate.x, z: candidate.z },
        };
        state.reservations[zone.id] = reservation;
        state.metrics.grants++;
        if (index > 0) state.metrics.eligibleBypasses++;
        event(world, candidate, "resource-grant", "first-eligible-ticket-and-clear-exit", {
          zoneId: zone.id, ticket: entry.ticket, waitS: entry.waitS,
          skippedBlockedTickets: index, arrivedTick: entry.arrivedTick,
          exitDistanceM: route.exitDistanceM,
        });
        break;
      }
    }
    for (const entry of queue) {
      const car = byId.get(entry.actorId);
      if (occupants.includes(car)) continue;
      state.holds[car.id] ??= {
        zoneId: zone.id, blockedBy: reservation?.ownerId ?? zone.id,
        reason: zone.kind === "single-lane" ? "district-single-lane" : "district-merge",
        distanceM: state.approaches[car.id].distanceM,
        stopBeforeM: queueClearance(world, car, zone),
        ticket: entry.ticket, waitS: entry.waitS,
      };
      if (entry.waitS > 6 &&
          (car !== world.player || (world.mode === "auto" && car.district.allowReroute === true)) &&
          (!car.district.caseId || car.district.allowReroute) &&
          car.district.reroutedTicket !== entry.ticket && car.speed < 0.08 &&
          world.tick >= (car.district.nextReplanTick ?? 0)) {
        car.district.nextReplanTick = world.tick + Math.ceil(6 / STEP);
        const previousPath = car.path;
        if (replanQueuedVehicle(world, car, zone, routes.get(`${zone.id}:${car.id}`), entry.waitS)) {
          car.district.reroutedTicket = entry.ticket;
          const changed = routeChanged(previousPath, car.path);
          state.metrics.replans++;
          if (changed) state.metrics.reroutes++;
          event(world, car, changed ? "traffic-reroute" : "traffic-replan", "accepted-queue-wait", {
            zoneId: zone.id, ticket: entry.ticket, waitS: entry.waitS,
            blockedBy: state.holds[car.id].blockedBy, routeChanged: changed,
          });
        }
      }
    }
  }
  for (const car of cars) {
    const profile = car.district;
    if (car === world.player || (profile.caseId && !profile.loadingEnabled)) continue;
    if (profile.loadingUntilTick !== null && world.tick >= profile.loadingUntilTick) {
      profile.loadingUntilTick = null;
      if (profile.loadingOnce) profile.nextLoadingDistanceM = null;
      else {
        profile.nextLoadingDistanceM = (car.distance ?? 0) + world.rng.range(38, 72);
        profile.loadingDurationS = world.rng.range(0.7, 1.8);
      }
      event(world, car, "loading-resume", "bounded-loading-complete");
    }
    if (profile.loadingUntilTick === null && Number.isFinite(profile.nextLoadingDistanceM) &&
        (car.distance ?? 0) >= profile.nextLoadingDistanceM &&
        !state.approaches[car.id] && onRoadLimit(world, car).width >= 5 &&
        !cars.some((other) => other !== car && distance(other, car) < 9)) {
      profile.loadingUntilTick = world.tick + Math.ceil(
        (profile.loadingDurationS + Math.abs(car.speed) / VEHICLE.braking) / STEP);
      event(world, car, "loading-hold", "actual-trip-distance-and-clear-road", {
        distanceM: car.distance, durationS: profile.loadingDurationS,
      });
    }
  }
}

export function districtTrafficCommand(world, car, command) {
  if (!isDistrict(world)) return command;
  initializeDistrictActor(world, car);
  const result = { ...command };
  const originalSign = command.targetSpeed < 0 ? -1 : 1;
  let speed = Math.abs(command.targetSpeed);
  const cap = (limit, reason, blockedBy) => {
    if (!Number.isFinite(limit) || limit >= speed - 1e-8) return;
    speed = Math.max(0, limit);
    result.targetSpeed = originalSign * speed;
    result.reason = reason;
    result.blockedBy = blockedBy;
  };
  const road = onRoadLimit(world, car);
  const rush = world.pursuit?.phase === "running" && usesRushPace(world.pursuit.variant);
  const patrol = rush && car.pursuitRole === "police";
  const arcadePatrol = patrol && isRushPack(world.pursuit.variant);
  const survival = world.pursuit?.phase === "running" && world.pursuit.survival;
  const reversingHunt = originalSign < 0 && world.pursuit?.phase === "running" &&
    ["hunt", "survival"].includes(world.pursuit.variant) && (car === world.player || command.reason === "police-reposition");
  const response = patrol ? world.pursuit.response : null;
  cap(arcadePatrol ? arcadePatrolLimit(road)
    : rush && (patrol || car === world.player) ? rushRoadLimit(road, patrol) : road.limit,
    "district-road-limit", road.roadId);
  if (car !== world.player) {
    if (!patrol)
      cap((car.maxSpeed ?? speed) * (PROFILE[car.district.profile]?.speedFactor ?? 1),
        "district-profile", null);
    const s = Math.sin(car.heading), c = Math.cos(car.heading);
    const usualHeadway = car.district.headwayS ?? 1.6;
    for (const other of reversingHunt ? [] : world.actors) {
      if (other === car || other.type !== "vehicle") continue;
      if (arcadePatrol && (other === world.player || (survival && world.pursuit.patrols.has(other)))) continue;
      const target = response && other === world.player;
      // Physics still clips real contact. The patrol controller may not use
      // the hidden body's heading, lane position or speed as a pace cue.
      if (target && !response.sightedBy.has(car)) continue;
      const measured = target ? response.lastSeen : other;
      const dx = measured.x - car.x, dz = measured.z - car.z;
      const halfLength = (car.length + other.length) / 2;
      const side = (car.width + other.width) / 2 + 0.18;
      // Conservative enclosure of the exact 30 m forward-following corridor.
      const reach = 30 + Math.abs(halfLength) + Math.abs(side) + 1e-7;
      if (Math.abs(dx) > reach || Math.abs(dz) > reach ||
          Math.abs(angleDelta(car.heading, measured.heading)) > 0.65) continue;
      const forward = dx * s + dz * c;
      const lateral = Math.abs(dx * c - dz * s);
      const gap = forward - halfLength;
      if (forward <= 0 || lateral > side || gap > 30) continue;
      const headway = patrol ? (other === world.player ? 0.55 : 0.95) : usualHeadway;
      cap(Math.min(
        Math.max(0, measured.speed + (gap - 1.5 - Math.abs(car.speed) * headway) / headway),
        Math.sqrt(Math.max(0, measured.speed ** 2 + 2 * 3.5 * (gap - 1.5))),
      ), "district-following", other.id);
    }
    if (car.district.loadingUntilTick !== null &&
        world.tick < car.district.loadingUntilTick)
      cap(0, "district-loading", `loading:${car.id}`);
  }
  const hold = reversingHunt ? null : stateFor(world).holds[car.id];
  if (hold)
    cap(Math.sqrt(Math.max(0, hold.distanceM - (hold.stopBeforeM ?? 0.55)) * 2 * 3.5),
      hold.reason, hold.blockedBy);
  return result;
}

export function districtBehaviorDiagnostics(world) {
  if (!isDistrict(world)) return null;
  const state = stateFor(world);
  return structuredClone({
    source: "world-reference", perceptionInput: false,
    tick: world.tick, reservations: state.reservations,
    queues: state.queues, approaches: state.approaches, holds: state.holds,
    metrics: state.metrics, events: state.events,
    actors: world.actors.slice(0, 170).map((actor) => ({
      id: actor.id, type: actor.type,
      profile: actor.district?.profile ?? actor.district?.pattern ?? null,
      stage: actor.district?.stage ?? null,
      acceptedDistanceM: actor.distance, speedMps: actor.speed,
      reason: actor.reason, blockedBy: actor.blockedBy ?? null,
    })),
  });
}
