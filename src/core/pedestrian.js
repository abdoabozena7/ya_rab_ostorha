import { STEP, PEOPLE_MODELS, clamp } from "./config.js";
import { distance, angleDelta, pointOnRoad, roadPointAt, roadProject, roadRect } from "./geometry.js";
import { canLeaveWalkMargin, walkingWaypoint, walkSegmentBlocker } from "./walk-route.js";
import { createPedestrianBody } from "./pedestrian-body.js";
const WALK_TURNS = [0, -0.5, 0.5, -1, 1, -1.6, 1.6, -2.2, 2.2, Math.PI];
const pose = (road, along, side, offset) => roadPointAt(road, along, side * offset);
const FAR_PED_LOD_DIST_SQ = 95 * 95;
const ROAD_GRID_CELL = 40;
const EMPTY_ROADS = Object.freeze([]);
const roadSpatialGridCache = new WeakMap();
const distantPedNearbyCache = new WeakMap();
const pedStaticNearbyCache = new WeakMap();
const distantPedLodCache = new WeakMap();
const crowdAheadRouteMap = new WeakMap();

function localRoadsNear(roads, p) {
  if (!Array.isArray(roads) || roads.length <= 16) return roads;
  let grid = roadSpatialGridCache.get(roads);
  if (!grid || grid.len !== roads.length) {
    const map = new Map();
    for (let i = 0; i < roads.length; i++) {
      const r = roads[i];
      if (!r) continue;
      const rect = roadRect(r, -4);
      const x0 = Math.floor(rect.minX / ROAD_GRID_CELL);
      const x1 = Math.floor(rect.maxX / ROAD_GRID_CELL);
      const z0 = Math.floor(rect.minZ / ROAD_GRID_CELL);
      const z1 = Math.floor(rect.maxZ / ROAD_GRID_CELL);
      for (let cx = x0; cx <= x1; cx++) {
        for (let cz = z0; cz <= z1; cz++) {
          const key = (cx << 16) ^ (cz & 0xffff);
          let bucket = map.get(key);
          if (!bucket) {
            bucket = [];
            map.set(key, bucket);
          }
          bucket.push(r);
        }
      }
    }
    grid = { len: roads.length, map };
    roadSpatialGridCache.set(roads, grid);
  }
  const cx = Math.floor(p.x / ROAD_GRID_CELL);
  const cz = Math.floor(p.z / ROAD_GRID_CELL);
  return grid.map.get((cx << 16) ^ (cz & 0xffff)) ?? EMPTY_ROADS;
}

function hashPedestrianStride(id) {
  const s = String(id ?? "");
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h & 3;
}

export function createPedestrian(options = {}) {
  const {
    id = "person-0",
    kind = PEOPLE_MODELS[0],
    x = 0,
    z = 0,
    along = 0,
    side = 1,
    roadId = null,
    heading = 0,
    walkwayId = null,
    roadPreference = "avenue",
    road = null,
    speed = 0,
    walkSpeed = 1.35,
    phase = 0,
    reason = "walking",
    target = null,
    pause = 0,
    crossing = false,
    motionMode = "ambient",
    motionTimeS = 0,
  } = options;
  const person = {
    id,
    type: "pedestrian",
    kind,
    x,
    z,
    along,
    side,
    roadId,
    heading,
    walkwayId,
    roadPreference,
    road,
    speed,
    walkSpeed,
    phase,
    distance: 0,
    wait: 0,
    reason,
    target,
    pause,
    crossing,
    motionMode,
  };
  person.body = createPedestrianBody(person);
  person.radius = person.body.radiusM;
  person.motionTimeS = motionTimeS;
  person.accelerationMps2 = 0;
  return person;
}

export function registerCrowdAheadRoute(person, waypoints, initialIndex = 1) {
  if (!person?.body || !Array.isArray(waypoints) || waypoints.length < 2) return;
  const idx = ((initialIndex % waypoints.length) + waypoints.length) % waypoints.length;
  const wp = waypoints[idx];
  person.target = { x: wp.x, z: wp.z };
  person.crossing = Boolean(wp.crossing);
  person.pause = 0;
  if (person.walkRoute) person.walkRoute = [person.target];
  crowdAheadRouteMap.set(person.body, { waypoints, index: idx });
}

export function isCrowdAheadPedestrian(person) {
  return Boolean(person?.body && crowdAheadRouteMap.has(person.body));
}

export function advanceCrowdAheadWaypoint(person, route = person?.body ? crowdAheadRouteMap.get(person.body) : null) {
  if (!person || !route || !Array.isArray(route.waypoints) || route.waypoints.length < 2) return false;
  route.index = (route.index + 1) % route.waypoints.length;
  const wp = route.waypoints[route.index];
  person.target = { x: wp.x, z: wp.z };
  person.crossing = Boolean(wp.crossing);
  person.pause = 0;
  if (person.walkRoute) person.walkRoute = [person.target];
  return true;
}

export function nextWalk(world, person) {
  if (advanceCrowdAheadWaypoint(person)) return;
  person.walkRoute = null;
  const road = person.road;
  person.walkDirection ??= person.phase < 0.5 ? -1 : 1;
  const crossing = world.rng.next() < 0.15 + world.config.chaos * 0.3;
  if (crossing) {
    person.target = pose(
      road,
      person.along,
      -person.side,
      road.width / 2 + 1.25,
    );
    person.crossing = true;
    person.pause = world.rng.range(0.4, 1.4);
  } else {
    const pad = Math.min(6, (road.max - road.min) * 0.25);
    const min = road.min + pad,
      max = road.max - pad;
    if (
      (person.walkDirection > 0 && max - person.along < 5) ||
      (person.walkDirection < 0 && person.along - min < 5)
    )
      person.walkDirection *= -1;
    const stride = world.rng.range(18, 42);
    let next = clamp(person.along + stride * person.walkDirection, min, max);
    if (Math.abs(next - person.along) < 3) {
      person.walkDirection *= -1;
      next = clamp(person.along + stride * person.walkDirection, min, max);
    }
    person.target = pose(road, next, person.side, road.width / 2 + 1.25);
    person.crossing = false;
    person.pause = world.rng.next() < 0.1 ? world.rng.range(0.4, 1.2) : 0;
  }
}

function nearbyBodies(world, p, allowFarCache = false) {
  const cacheKey = p.body ?? p;
  const canCache = allowFarCache || (
    (world.config?.cityVersion ?? 0) >= 5 &&
    world.environment === "metro" &&
    world.player != null &&
    (p.x - world.player.x) ** 2 + (p.z - world.player.z) ** 2 > FAR_PED_LOD_DIST_SQ
  );
  if (canCache) {
    const cached = distantPedNearbyCache.get(cacheKey);
    if (cached && cached.until > world.tick) return cached.nearby;
  }
  const nearby = world.actorIndex.near(p, 28);
  const self = nearby.indexOf(p);
  if (self !== -1) nearby.splice(self, 1);
  if (self === -1 && p.id) {
    const byId = nearby.findIndex((a) => a.id === p.id);
    if (byId !== -1) nearby.splice(byId, 1);
  }
  let localStatics;
  if ((world.config?.cityVersion ?? 0) >= 5 && world.environment === "metro") {
    let stEntry = pedStaticNearbyCache.get(cacheKey);
    if (
      !stEntry ||
      stEntry.staticIndex !== world.staticIndex ||
      (p.x - stEntry.x) ** 2 + (p.z - stEntry.z) ** 2 > 4.0
    ) {
      stEntry = {
        staticIndex: world.staticIndex,
        x: p.x,
        z: p.z,
        statics: world.staticIndex.near(p, 34),
      };
      pedStaticNearbyCache.set(cacheKey, stEntry);
    }
    localStatics = stEntry.statics;
  } else {
    localStatics = world.staticIndex.near(p, 34);
  }
  for (let i = 0; i < localStatics.length; i++) nearby.push(localStatics[i]);
  if (canCache) {
    distantPedNearbyCache.set(cacheKey, { nearby, until: world.tick + 4 });
  }
  return nearby;
}

function move(world, p, body, heading, targetSpeed, reason, nearby, district, reuseProposal) {
  const speed = clamp(
    targetSpeed,
    Math.max(0, p.speed - body.maxDecelerationMps2 * STEP),
    p.speed + body.maxAccelerationMps2 * STEP,
  );
  const x = p.x + Math.sin(heading) * speed * STEP;
  const z = p.z + Math.cos(heading) * speed * STEP;
  const oldSpeed = p.speed;
  const turnRateRadS = angleDelta(heading, p.heading) / STEP;
  // Match World's reserved-body guard; an occupied step is the only instant stop.
  const blocker = speed > 0
    ? walkSegmentBlocker(p, p, { x, z }, nearby ?? nearbyBodies(world, p), 0.12, canLeaveWalkMargin(world, p))
    : null;
  const next = reuseProposal ? p : { ...p };
  if (!blocker) {
    next.x = x;
    next.z = z;
  }
  next.heading = heading;
  next.speed = blocker ? 0 : speed;
  next.accelerationMps2 = blocker ? -oldSpeed / STEP : (speed - oldSpeed) / STEP;
  next.turnRateRadS = turnRateRadS;
  next.reason = blocker ? "blocked" : reason;
  if (district) next.blockedBy = blocker?.id ?? null;
  return next;
}

// District walkers already tick against a private working copy.
export function pedestrianMotion(world, p, reuseProposal = false) {
  const district = world.environment === "egypt" || world.environment === "metro";
  const metro = world.environment === "metro";
  const body = p.body ??= createPedestrianBody(p);
  const crowdRoute = crowdAheadRouteMap.get(body) ?? null;
  if (crowdRoute && (!p.target || distance(p, p.target) < 0.65)) {
    advanceCrowdAheadWaypoint(p, crowdRoute);
  }
  const metroLod = metro && (world.config?.cityVersion ?? 0) >= 5 && world.player != null;
  const farFromPlayer = metroLod &&
    (p.x - world.player.x) ** 2 + (p.z - world.player.z) ** 2 > FAR_PED_LOD_DIST_SQ;
  let lod = null;
  if (farFromPlayer) {
    lod = distantPedLodCache.get(body);
    if (!lod) {
      lod = {
        stride: hashPedestrianStride(p.id),
        tick: -99,
        targetHeading: p.heading ?? 0,
        targetSpeed: 0,
        close: [],
        looking: false,
        reason: "walking",
      };
      distantPedLodCache.set(body, lod);
    }
  }
  const stop = (reason) =>
    move(world, p, body, p.heading, 0, reason, lod?.close ?? null, district, reuseProposal);
  if (p.motionMode === "stop")
    return stop(p.speed > 0 ? "stopping" : "stopped");
  if (p.pause > 0) {
    if (p.speed === 0) p.pause = Math.max(0, p.pause - STEP);
    return stop("waiting");
  }
  let remaining = distance(p, p.target);
  if (
    !crowdRoute &&
    district &&
    p.district?.holdAtTarget &&
    remaining < Math.max(
      0.22,
      p.speed ** 2 / (2 * body.maxDecelerationMps2) + p.speed * STEP + 0.04,
    )
  )
    return stop("district-target");
  if (remaining < 0.22) {
    if (crowdRoute) {
      advanceCrowdAheadWaypoint(p, crowdRoute);
    } else {
      if (p.crossing) p.side = -p.side;
      p.along = p.road ? roadProject(p.road, p).along : 0;
      world.nextWalk(p);
      if (p.pause > 0) return stop("waiting");
    }
    // A waypoint is not a stop: carry the walking motion into the next leg.
    remaining = distance(p, p.target);
    if (remaining < 0.22) return stop("waiting");
  }
  if (
    farFromPlayer &&
    ((world.tick + lod.stride) & 3) !== 0 &&
    world.tick - lod.tick <= 3 &&
    remaining > 1.2 &&
    p.reason !== "blocked"
  ) {
    if (lod.looking) return stop("looking");
    const heading =
      p.heading +
      clamp(
        angleDelta(lod.targetHeading, p.heading),
        -body.maxTurnRateRadS * STEP,
        body.maxTurnRateRadS * STEP,
      );
    return move(
      world,
      p,
      body,
      heading,
      lod.targetSpeed,
      lod.reason,
      lod.close,
      district,
      reuseProposal,
    );
  }
  // Check an approaching vehicle before entering the carriageway; once a
  // crossing has started, keep walking so the person can clear the lane.
  const curbTarget = metro && p.walkRoute?.[0] ? p.walkRoute[0] : p.target;
  const curbDistance = Math.max(0.001, curbTarget === p.target ? remaining : distance(p, curbTarget));
  const approach = Math.min(
    metro ? curbDistance : remaining,
    Math.max(
      1,
      p.speed ** 2 / (2 * body.maxDecelerationMps2) +
        p.speed * STEP + p.radius + 0.1,
    ),
  );
  const localRoads = metroLod ? localRoadsNear(world.roads, p) : world.roads;
  if (
    localRoads.length > 0 &&
    !(district && p.district?.yieldAtCurb === false) &&
    !pointOnRoad(p, localRoads) &&
    pointOnRoad(
      {
        x: p.x + (curbTarget.x - p.x) / (metro ? curbDistance : remaining) * approach,
        z: p.z + (curbTarget.z - p.z) / (metro ? curbDistance : remaining) * approach,
      },
      localRoads,
    )
  ) {
    const vehicleCandidates = metroLod && world.actorIndex
      ? world.actorIndex.near(p, 86)
      : world.actors;
    const danger = vehicleCandidates.some(
      (a) =>
        a.type === "vehicle" &&
        a.speed > 0.4 &&
        distance(p, a) < Math.max(5, a.speed * 2.2) &&
        (p.x - a.x) * Math.sin(a.heading) + (p.z - a.z) * Math.cos(a.heading) >
          -2,
    );
    if (danger) {
      if (lod) {
        lod.tick = world.tick;
        lod.looking = true;
      }
      return stop("looking");
    }
  }
  const nearby = nearbyBodies(world, p, farFromPlayer);
  const close = nearby.filter((a) => {
    const range = a.type === "static" ? 10 : 5;
    const dx = a.x - p.x, dz = a.z - p.z;
    return Math.abs(dx) <= range && Math.abs(dz) <= range && Math.hypot(dx, dz) < range;
  });
  const hasReusableRouteHead =
    Array.isArray(p.walkRoute) && p.walkRoute.length > 0 && distance(p, p.walkRoute[0]) > 0.65;
  const waypoint = crowdRoute
    ? p.target
    : (district && p.district?.routeConstrained && hasReusableRouteHead) ||
        (metroLod && close.length === 0 && hasReusableRouteHead)
      ? p.walkRoute[0]
      : walkingWaypoint(world, p, nearby);
  const desired = Math.atan2(waypoint.x - p.x, waypoint.z - p.z);
  let targetHeading = desired,
    best = Infinity;
  if (metroLod && close.length === 0 && hasReusableRouteHead) {
    best = 0;
    targetHeading = desired;
  } else {
    const probeLength = Math.min(0.95, distance(p, waypoint));
    const previousHeading = p.walkHeading ?? p.heading;
    const probe = { x: 0, z: 0 };
    const allowMarginExit = crowdRoute ? true : canLeaveWalkMargin(world, p);
    // Walk round personal space using a consistent right-side preference. The
    // candidate score breaks the symmetric face-to-face pedestrian deadlock.
    for (const turn of WALK_TURNS) {
      const heading = desired + turn;
      probe.x = p.x + Math.sin(heading) * probeLength;
      probe.z = p.z + Math.cos(heading) * probeLength;
      const partialScore = distance(probe, waypoint) + Math.abs(turn) * 0.08 +
        (turn > 0 ? 0.03 : 0);
      if (partialScore >= best) continue;
      const score = partialScore + Math.abs(angleDelta(heading, previousHeading)) * 0.24;
      if (score < best && !walkSegmentBlocker(p, p, probe, close, 0.12, allowMarginExit)) {
        best = score;
        targetHeading = heading;
      }
    }
  }
  if (best !== Infinity) p.walkHeading = targetHeading;
  const heading =
    p.heading +
    clamp(
      angleDelta(targetHeading, p.heading),
      -body.maxTurnRateRadS * STEP,
      body.maxTurnRateRadS * STEP,
    );
  const turn = Math.abs(angleDelta(targetHeading, heading));
  const walkingSpeed = clamp(
    Number.isFinite(p.walkSpeed) ? p.walkSpeed : body.walkSpeedMps,
    0,
    3.2,
  );
  const requestedSpeed = p.motionMode === "jog"
    ? Math.max(walkingSpeed, body.jogSpeedMps) : walkingSpeed;
  const targetSpeed =
    best === Infinity
      ? 0
      : requestedSpeed * Math.max(0, Math.cos(turn)) ** 3;
  const reason = best === Infinity ? "yielding" : p.crossing ? "crossing" : "walking";
  if (lod) {
    lod.tick = world.tick;
    lod.looking = false;
    lod.targetHeading = targetHeading;
    lod.targetSpeed = targetSpeed;
    lod.close = close;
    lod.reason = reason;
  }
  return move(
    world, p, body, heading, targetSpeed,
    reason,
    metroLod ? close : nearby,
    district,
    reuseProposal,
  );
}
