import { STEP, VEHICLE, clamp } from "./config.js";
import { angleDelta, bodyOnRoad, distance, interpolate, overlaps, roadRect, sweepSafe } from "./geometry.js";
import { createRoadGraph, planNavigation } from "./navigation.js";
import { planDistrictRoute } from "./district-navigation.js";
import { isPackPursuit, onRoadLimit, rushRoadLimit } from "./district-behavior.js";
import { followPath, integrateVehicle } from "./vehicle.js";
import { pursuitCommand, PURSUIT_STOP } from "./pursuit-controls.js";
import { PACK_ACTIONS as PURSUIT_ACTIONS, packCommand } from "./pack-driving.js";
import { Random } from "./random.js";

export const PURSUIT_POLICY_VERSION = 2;
export { PURSUIT_ACTIONS };
export const PURSUIT_DECISION_TICKS = 12;

const RANGE = 42;
const graphCache = new WeakMap();
const cutStreetProfiles = new WeakMap();
const boxRadius = (body) => body.radius ?? Math.hypot(body.width ?? 0, body.length ?? 0) / 2;
const projection = (point, ego) => {
  const dx = point.x - ego.x, dz = point.z - ego.z;
  const s = Math.sin(ego.heading), c = Math.cos(ego.heading);
  return { lateral: dx * c - dz * s, forward: dx * s + dz * c };
};

function lineIntersects(a, b, body, pad = 0) {
  const c = Math.cos(body.heading ?? 0), s = Math.sin(body.heading ?? 0);
  let low = 0, high = 1;
  const axes = [
    [a.x * c - a.z * s - (body.x * c - body.z * s), (b.x - a.x) * c - (b.z - a.z) * s,
      (body.width ?? (body.radius ?? 0) * 2) / 2 + pad],
    [a.x * s + a.z * c - (body.x * s + body.z * c), (b.x - a.x) * s + (b.z - a.z) * c,
      (body.length ?? (body.radius ?? 0) * 2) / 2 + pad],
  ];
  for (const [offset, delta, half] of axes) {
    if (Math.abs(delta) < 1e-8) {
      if (Math.abs(offset) > half) return false;
      continue;
    }
    const t1 = (-half - offset) / delta, t2 = (half - offset) / delta;
    low = Math.max(low, Math.min(t1, t2));
    high = Math.min(high, Math.max(t1, t2));
    if (low >= high) return false;
  }
  return low < 0.99 && high > 0.01;
}

function visible(ego, target, occluders) {
  const dx = target.x - ego.x, dz = target.z - ego.z, d = Math.hypot(dx, dz);
  if (d <= boxRadius(target) || d === 0) return true;
  const side = boxRadius(target) * 0.48;
  return [-side, 0, side].some((offset) => {
    const point = { x: target.x + offset * dz / d, z: target.z - offset * dx / d };
    return !occluders.some((body) => body !== target && lineIntersects(ego, point, body));
  });
}

const shape = (body) => ({
  id: body.id, type: body.type, kind: body.kind, x: body.x, z: body.z,
  heading: body.heading ?? 0, width: body.width, length: body.length, radius: body.radius,
});

/** Separate simulated ranging, not input to the RGB detector or its predictor. */
export function observePursuit(world) {
  const ego = world.player, nowS = world.tick * STEP;
  const local = [...world.actors.filter((actor) => actor !== ego), ...world.statics]
    .filter((actor) => distance(ego, actor) - boxRadius(actor) <= RANGE)
    .sort((a, b) => distance(ego, a) - distance(ego, b) || a.id.localeCompare(b.id));
  const solid = local.filter((actor) => actor.type !== "pedestrian");
  const last = world.pursuit.sightings ?? new Map(), next = new Map(), entities = [], unknown = [];
  const missing = (before) => {
    const ageS = nowS - before.timeS;
    next.set(before.id, { ...before, missing: true });
    unknown.push({ id: before.id, ageS, lastSeen: shape(before),
      bearingRad: Math.atan2(before.x - ego.x, before.z - ego.z) });
  };
  for (const actor of local) {
    if (!visible(ego, actor, solid)) {
      const before = last.get(actor.id);
      if (before && nowS - before.timeS <= .6) missing(before);
      continue;
    }
    const prior = last.get(actor.id), dt = nowS - (prior?.timeS ?? nowS);
    const continuous = prior && !prior.missing && dt <= .6;
    const resolved = continuous && dt >= .08;
    const vx = resolved ? (actor.x - prior.x) / dt : continuous ? prior.vx : 0;
    const vz = resolved ? (actor.z - prior.z) / dt : continuous ? prior.vz : 0;
    const measured = { ...shape(actor), ...projection(actor, ego), vx, vz, timeS: nowS,
      rangeM: distance(ego, actor), ageS: 0, motionKnown: Boolean(resolved || (continuous && prior.motionKnown)),
      police: actor.pursuitRole === "police", source: "virtual-ranging" };
    next.set(actor.id, continuous && dt > 0 && dt < .08 ? prior : measured);
    entities.push(measured);
  }
  // Memory is allowed for availability, never as a fresh hidden pose.
  for (const [id, before] of last)
    if (!next.has(id) && nowS - before.timeS <= .6) missing(before);
  world.pursuit.sightings = next;
  const fixed = world.statics.filter((body) => body.kind === "building" || body.kind === "wall");
  const obstacles = [...fixed.map(shape), ...entities.filter((body) =>
    body.type === "static" && body.kind !== "building" && body.kind !== "wall")];
  return {
    ego: { ...shape(ego), speed: ego.speed, steer: ego.steer, maxSpeed: ego.maxSpeed, spec: { ...ego.spec } },
    timeS: nowS, entities, unknown, obstacles, source: "virtual-ranging",
    drivingRoads: world.drivingRoads, roads: world.roads, exits: world.pursuit.exits,
    ...(isPackPursuit(world.pursuit.variant) ? { pack: true } : {}),
    ...(["hunt", "survival"].includes(world.pursuit.variant) ? { hunt: true, recovery: world.pursuit.recovery } : {}),
  };
}

function routeCost(path, observed) {
  let value = 0;
  const relevant = observed.entities.filter(actor => actor.forward > -3 ||
    Math.abs(actor.lateral) > actor.width);
  for (let i = 1; i < path.length; i++) {
    const ds = distance(path[i - 1], path[i]);
    value += ds;
    for (const actor of relevant) {
      if (Math.abs(actor.x - path[i].x) >= 7 || Math.abs(actor.z - path[i].z) >= 7) continue;
      const d = distance(actor, path[i]);
      if (d < 7) value += ds * (1 - d / 7) * (actor.police ? 2 : 0.45);
    }
  }
  return value;
}

function shoulderRoute(observed, exit, shoulder) {
  const ego = observed.ego, axis = shoulder.axis, across = axis === "z" ? "x" : "z";
  const sign = Math.sign(exit[axis] - ego[axis]);
  const travel = (exit[axis] - ego[axis]) * sign;
  const direction = axis === "z" ? Math.cos(ego.heading) : Math.sin(ego.heading);
  if (travel < 16 || direction * sign < .45) return null;
  const rampM = Math.max(2 * ego.length, Math.abs(shoulder.fixed - ego[across]) * 2.4);
  const near = (sign > 0 ? shoulder.min : shoulder.max) - ego[axis];
  const far = (sign > 0 ? shoulder.max : shoulder.min) - ego[axis];
  const take = Math.max(0, near * sign);
  const leave = Math.min(travel, far * sign);
  if (leave - take < rampM * 2 + ego.length) return null;
  const blend = (t) => t * t * (3 - 2 * t);
  const path = [];
  for (let meter = 0; meter < travel + .001; meter += .45) {
    const along = Math.min(meter, travel);
    const a = blend(clamp((along - take) / rampM, 0, 1));
    const b = blend(clamp((along - leave + rampM) / rampM, 0, 1));
    path.push({ [axis]: ego[axis] + along * sign,
      [across]: (ego[across] * (1 - a) + shoulder.fixed * a) * (1 - b) + exit[across] * b });
  }
  if (distance(path.at(-1), exit) > 1e-8) path.push({ x: exit.x, z: exit.z });
  for (let index = 1; index < path.length; index++) {
    const previous = path[index - 1], point = path[index];
    const pose = { ...ego, ...point, heading: Math.atan2(point.x - previous.x, point.z - previous.z) };
    if (!bodyOnRoad(pose, observed.roads, .12) ||
        observed.obstacles.some((body) => overlaps(pose, body, .12))) return null;
  }
  return { id: exit.id, exit, path, cost: routeCost(path, observed) + 2, shoulder: true };
}

export function selectPursuitRoute(observed, previous = null) {
  let graph = graphCache.get(observed.drivingRoads);
  if (!graph) {
    graph = createRoadGraph(observed.drivingRoads);
    graphCache.set(observed.drivingRoads, graph);
  }
  if (!graph.size) return null;
  const { ego, entities, obstacles } = observed;
  const barriers = obstacles.filter((body) => body.kind !== "building" && body.kind !== "wall");
  const filtered = !barriers.length ? graph : new Map([...graph].map(([key, node]) => [
    key, { ...node, edges: node.edges.filter((edge) =>
      !barriers.some((body) => lineIntersects(node, graph.get(edge), body, ego.width / 2))) },
  ]));
  const cars = entities.filter((body) => body.type === "vehicle" &&
    (body.forward > -3 || Math.abs(body.lateral) > ego.width));
  const pressure = new Map();
  for (const [key, node] of filtered) {
    let penalty = 0;
    for (const car of cars) if (car.police) {
      const d = distance(node, { x: car.x + car.vx * 1.5, z: car.z + car.vz * 1.5 });
      penalty += Math.max(0, 10 - d) * 1.3;
    }
    if (penalty) pressure.set(key, penalty);
  }
  const crossesBarrier = (path) => barriers.some((body) => path.some((point, index) => index > 0 &&
    lineIntersects(path[index - 1], point, body, ego.width / 2 + .12)));
  if (previous?.recovery && !crossesBarrier(previous.path)) {
    const { entry, approach, heading } = previous.recovery;
    const pastEntry = (ego.x - entry.x) * Math.sin(approach) + (ego.z - entry.z) * Math.cos(approach) <= .8;
    if (Math.abs(angleDelta(heading, ego.heading)) > .28) return {
      ...previous, recovery: { ...previous.recovery, turning: previous.recovery.turning || pastEntry },
    };
  }
  const options = observed.exits.flatMap((exit) => {
    let path;
    if (distance(ego, exit) < 8 && !barriers.some((body) => lineIntersects(ego, exit, body, ego.width / 2)))
      path = [{ x: ego.x, z: ego.z }, { x: exit.x, z: exit.z }];
    else path = planNavigation(filtered, ego, exit, cars, pressure, Math.PI / 2 + .08);
    if (path.length < 2) return [];
    if (crossesBarrier(path)) return [];
    return [{ id: exit.id, exit, path, cost: routeCost(path, observed) }];
  });
  for (const shoulder of observed.roads.filter(road => road.pursuitShoulder))
    for (const exit of observed.exits) {
      const path = shoulderRoute(observed, exit, shoulder);
      if (path) options.push(path);
    }
  options.sort((a, b) => a.cost - b.cost || a.id.localeCompare(b.id));
  if (previous?.path.length > 2 && !previous.recovery) {
    const best = options[0];
    let nearest = 0;
    for (let i = 1; i < previous.path.length; i++)
      if (distance(ego, previous.path[i]) < distance(ego, previous.path[nearest])) nearest = i;
    const path = previous.path.slice(Math.max(0, nearest - 1));
    const ahead = path.find(point => distance(point, ego) > 4);
    if (ahead && projection(ahead, ego).forward > -2 &&
        distance(ego, previous.path[nearest]) < 4 && !crossesBarrier(path)) {
      const cost = routeCost(path, observed);
      if (!best || cost <= best.cost + 8)
        return { ...previous, path, cost };
    }
  }
  return options[0] ?? reverseConnector(observed, filtered, cars, pressure, crossesBarrier);
}

function streetProfile(district, barriers, obstacles) {
  if (!barriers.length) return district;
  const signature = JSON.stringify(obstacles.map(({ id, x, z, width, length, heading }) =>
    [id, x, z, width, length, heading]));
  let profiles = cutStreetProfiles.get(district);
  if (!profiles) {
    profiles = new Map();
    cutStreetProfiles.set(district, profiles);
  }
  if (profiles.has(signature)) return profiles.get(signature);
  const roads = district.drivingRoads.flatMap(road => {
    const cuts = barriers.filter(body => body.width >= road.width - .25 &&
      Math.abs((road.axis === "z" ? body.x : body.z) - road.fixed) < 1 &&
      Math.abs(Math.cos((body.heading ?? 0) - (road.axis === "z" ? 0 : Math.PI / 2))) > .9)
      .map(body => road.axis === "z" ? body.z : body.x)
      .filter(along => along > road.min && along < road.max).sort((a, b) => a - b);
    let min = road.min;
    const spans = [];
    for (const cut of cuts) {
      if (cut - 3 > min) spans.push({ ...road, min, max: cut - 3 });
      min = cut + 3;
    }
    if (road.max > min) spans.push(cuts.length ? { ...road, min } : road);
    return spans;
  });
  const profile = { ...district, drivingRoads: roads, statics: obstacles };
  if (profiles.size >= 4) profiles.delete(profiles.keys().next().value);
  profiles.set(signature, profile);
  return profile;
}

export function selectStreetPursuitRoute(observed, district, previous = null) {
  const { ego, exits, entities, obstacles } = observed;
  const barriers = obstacles.filter(body => body.kind === "barrier");
  const blocked = path => barriers.some(body => path.some((point, index) =>
    index > 0 && lineIntersects(path[index - 1], point, body, ego.width / 2 + .12)));
  if (previous?.path.length > 2) {
    let index = 0;
    for (let i = 1; i < previous.path.length; i++)
      if (distance(ego, previous.path[i]) < distance(ego, previous.path[index])) index = i;
    const remaining = previous.path.slice(Math.max(0, index - 3));
    const ahead = remaining.find(point => projection(point, ego).forward > 2);
    if (ahead && distance(ego, previous.path[index]) < 3 && !blocked(remaining))
      return { ...previous, path: remaining };
  }
  const profile = streetProfile(district, barriers, obstacles);
  const traffic = entities.filter(body => body.type === "vehicle");
  const options = exits.filter(exit => distance(exit, ego) > 8)
    .sort((a, b) => distance(a, ego) - distance(b, ego)).slice(0, 6);
  let best = null;
  for (const exit of options) {
    const path = planDistrictRoute(profile, ego, exit, traffic);
    if (path.length < 2 || blocked(path)) continue;
    const cost = routeCost(path, observed);
    if (!best || cost < best.cost)
      best = { id: exit.id, exit, path, cost };
  }
  return best;
}

const act = (steer, throttle, brake = 0, gear = 1) => ({ steer, throttle, brake, gear });

function reverseConnector(observed, graph, cars, pressure, crossesBarrier) {
  const { ego, drivingRoads, roads, exits, obstacles } = observed;
  const sideways = Math.abs(Math.cos(ego.heading)) > .72;
  const axis = sideways ? "x" : "z", across = sideways ? "z" : "x";
  const frontAxis = sideways ? Math.cos(ego.heading) : Math.sin(ego.heading);
  const options = [];
  for (const road of drivingRoads) {
    if (road.axis !== axis || ego[axis] < road.min || ego[axis] > road.max) continue;
    const entry = { ...ego, [across]: road.fixed - Math.sign(frontAxis) * 1.4 };
    const { forward } = projection(entry, ego);
    if (forward > -2 || forward < -16 || !bodyOnRoad(entry, roads, .12) ||
        obstacles.some(body => lineIntersects(ego, entry, body, ego.width / 2 + .12))) continue;
    for (const heading of sideways ? [-Math.PI / 2, Math.PI / 2] : [0, Math.PI]) {
      for (const exit of exits) {
        const path = planNavigation(graph, { ...ego, [across]: road.fixed, heading }, exit, cars, pressure);
        if (path.length < 2 || crossesBarrier(path)) continue;
        const cost = routeCost(path, observed) + 2 * distance(ego, entry);
        options.push({ id: exit.id, exit, path, cost, recovery: {
          entry: { x: entry.x, z: entry.z }, approach: ego.heading, heading, turning: false,
        } });
      }
    }
  }
  return options.sort((a, b) => a.cost - b.cost || a.id.localeCompare(b.id))[0] ?? null;
}

function retreatPoint(observed) {
  const { ego } = observed;
  const aligned = Math.abs(Math.cos(ego.heading)) > .72;
  const axis = aligned ? "x" : "z";
  return observed.drivingRoads.filter(road => road.axis === axis &&
    ego[axis] >= road.min + .5 && ego[axis] <= road.max - .5)
    .map(road => ({ ...ego, [axis === "x" ? "z" : "x"]: road.fixed }))
    .filter(point => {
      const { forward } = projection(point, ego);
      return forward < -1 && forward > -16 &&
        !observed.obstacles.some(body => lineIntersects(ego, point, body, ego.width / 2));
    })
    .sort((a, b) => distance(ego, a) - distance(ego, b))[0] ?? null;
}

function routeCommand(body, route) {
  if (!route?.path.length) return act(0, .74);
  if (route.recovery) {
    const { entry, approach, heading, turning } = route.recovery;
    const dx = body.x - entry.x, dz = body.z - entry.z;
    if (!turning && dx * Math.sin(approach) + dz * Math.cos(approach) > .8) {
      const error = angleDelta(Math.atan2(dx, dz), body.heading);
      return act(clamp(-1.6 * error, -.65, .65), .96, 0, -1);
    }
    const error = angleDelta(heading, body.heading);
    if (Math.abs(error) > .17) {
      const steer = clamp(error * 2.5, -1, 1);
      return body.speed > 3.3 ? act(steer, 0, .36) : act(steer, .84);
    }
  }
  let cursor = 0;
  for (let i = 1; i < route.path.length; i++)
    if (distance(body, route.path[i]) < distance(body, route.path[cursor])) cursor = i;
  let { steer, targetSpeed } = followPath(body, route.path, cursor);
  const start = route.path[cursor];
  if (!route.shoulder && body.speed > 2.5 && distance(body, start) > .65) {
    const mergeLead = 6 + body.speed * .8;
    let tail = cursor;
    while (tail + 1 < route.path.length && distance(start, route.path[tail]) < mergeLead) tail++;
    const end = route.path[tail];
    const heading = Math.atan2(end.x - start.x, end.z - start.z);
    if (distance(start, end) >= mergeLead && Math.abs(angleDelta(heading, body.heading)) < .32 &&
        route.path.slice(cursor + 1, tail).every(point => Math.abs(projection(point, { ...start, heading }).lateral) < .24)) {
      const desired = Math.atan2(end.x - body.x, end.z - body.z);
      steer = clamp(angleDelta(desired, body.heading) * .64, -.23, .23);
      targetSpeed = body.maxSpeed;
    }
  }
  const normalized = clamp(steer / (body.spec?.maxSteer ?? VEHICLE.maxSteer), -1, 1);
  const overshoot = body.speed - targetSpeed;
  if (overshoot > .3) return act(normalized, 0, clamp(overshoot * .4, .18, .8));
  return act(normalized, clamp((targetSpeed - body.speed) * .65, .05, .96));
}

function buildCandidates(follow) {
  const steer = follow.steer;
  return [
    follow, act(0, 1),
    act(-.58, .78), act(.58, .78), act(-1, .52), act(1, .52),
    act(steer, 0, .35), PURSUIT_STOP,
    act(-.85, .72, 0, -1), act(.85, .72, 0, -1), act(0, .65, 0, -1),
    act(steer, .42), act(-.75, .36), act(.75, .36),
  ];
}

function alongRoute(body, path) {
  let distanceM = Infinity, progressM = 0, accumulatedM = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i];
    const x = b.x - a.x, z = b.z - a.z, length = Math.hypot(x, z);
    if (!length) continue;
    const ratio = clamp(((body.x - a.x) * x + (body.z - a.z) * z) / (length * length), 0, 1);
    const offset = Math.hypot(body.x - a.x - x * ratio, body.z - a.z - z * ratio);
    if (offset < distanceM) {
      distanceM = offset;
      progressM = accumulatedM + ratio * length;
    }
    accumulatedM += length;
  }
  return { distanceM, progressM };
}

const PACK_SAMPLE_TICKS = 6;
const PACK_SAMPLE_S = PACK_SAMPLE_TICKS * STEP;
const ROLLOUT_SAMPLES = 18;

function packRolloutScene(observed, samples = ROLLOUT_SAMPLES) {
  const { ego } = observed;
  const reach = samples * PACK_SAMPLE_S * Math.max(ego.maxSpeed ?? 9.72, Math.abs(ego.speed),
    ego.spec?.reverseSpeed ?? VEHICLE.reverseSpeed) + boxRadius(ego) + 2;
  const localRoad = (road) => {
    const r = roadRect(road);
    return r.minX <= ego.x + reach && r.maxX >= ego.x - reach &&
      r.minZ <= ego.z + reach && r.maxZ >= ego.z - reach;
  };
  const movers = observed.entities.filter(actor => actor.type !== "static");
  const forecasts = Array.from({ length: samples }, (_, index) => {
    const timeS = (index + 1) * PACK_SAMPLE_S, leadS = Math.min(timeS, 1.4);
    const intervalS = leadS - Math.min(index * PACK_SAMPLE_S, 1.4);
    return movers.map(actor => {
      const vx = actor.motionKnown ? actor.vx : 0, vz = actor.motionKnown ? actor.vz : 0;
      return {
        body: { ...actor, x: actor.x + vx * leadS, z: actor.z + vz * leadS },
        dx: vx * intervalS, dz: vz * intervalS, travel: Math.hypot(vx, vz) * intervalS,
        radius: boxRadius(actor), uncertainty: actor.motionKnown ? .15 + timeS * .16 : .36 + timeS * .27,
      };
    });
  });
  return {
    movers, forecasts, roads: observed.roads.filter(localRoad),
    roadLimits: { drivingRoads: observed.drivingRoads.filter(localRoad) },
    polys: observed.obstacles.filter(body => distance(body, ego) < reach + boxRadius(body)),
  };
}

function advancePackRollout(observed, pack, pose, command) {
  let limit = Infinity;
  if (observed.street) {
    const road = onRoadLimit(pack.roadLimits, pose);
    limit = observed.rush ? rushRoadLimit(road) : road.limit;
  }
  // Integrate the same servo and vehicle plant at 60 Hz. Sweep each short
  // forecast slice; the actual world still resolves contacts at every tick.
  const next = { ...pose };
  for (let tick = 0; tick < PACK_SAMPLE_TICKS; tick++) {
    const requested = packCommand(next, command, STEP);
    requested.targetSpeed = Math.min(requested.targetSpeed, limit);
    integrateVehicle(next, requested, STEP, next);
  }
  return next;
}

function packSweepsInto(before, next, other, separates, uncertainty = .12) {
  const guarded = overlaps(next, other, uncertainty) || !sweepSafe(before, next, [other]).safe;
  if (!guarded) return false;
  if (!separates(next, other)) return true;
  // Let an already-close car move away from padding, not through the other footprint.
  const travel = distance(before, next) + Math.abs(angleDelta(next.heading, before.heading)) * boxRadius(next);
  const steps = Math.max(1, Math.ceil(travel / .035));
  for (let i = 1; i <= steps; i++) {
    if (overlaps(interpolate(before, next, i / steps), other)) return true;
  }
  return false;
}

function rollout(observed, action, route, index, retreat, pack = null, probe = null) {
  const { ego, obstacles } = observed;
  const roads = pack?.roads ?? observed.roads;
  const movers = pack?.movers ?? observed.entities.filter((actor) => actor.type !== "static");
  const start = ego;
  let pose = ego, score = 0, clearance = RANGE, failure = null, failureAtS = Infinity;
  let hardFailure = false, usablePose = ego, backedM = 0, forwardM = 0;
  const polys = pack?.polys ?? obstacles.filter((body) => distance(body, ego) < 28 + boxRadius(body));
  const dt = pack ? PACK_SAMPLE_S : .12;
  const intervals = probe?.samples ?? ROLLOUT_SAMPLES;
  const touching = new Map([...movers, ...polys].filter((body) => body.type !== "pedestrian" &&
    overlaps(ego, body, .36)).map((body) => [body.id, distance(ego, body)]));
  const separates = (next, other) => {
    if (!touching.has(other.id) || overlaps(next, other)) return false;
    const gap = distance(next, other);
    if (gap <= touching.get(other.id) + 1e-5) return false;
    touching.set(other.id, gap);
    return true;
  };
  const roadMargin = !pack && bodyOnRoad(ego, roads, .12) ? .12 : .08;
  const backingTarget = retreat || (!route?.recovery?.turning && route?.recovery?.entry);
  for (let step = 1; step <= intervals; step++) {
    const timeS = step * dt;
    const command = probe ? probe.command(pose, step) : index === 0
      ? pack && step * PACK_SAMPLE_TICKS <= PURSUIT_DECISION_TICKS ? action : routeCommand(pose, route)
      : index >= 11 && timeS >= .72 ? act(action.steer, 0, .7)
      : action.gear < 0 && timeS > .84 && !retreat ? act(-action.steer, .68)
      : (index === 2 || index === 3) && timeS > .84 && timeS < 1.56
        ? act(-action.steer * .7, action.throttle)
      : (index === 2 || index === 3) && timeS >= 1.56 ? act(0, action.throttle)
      : action;
    let next;
    if (pack) next = advancePackRollout(observed, pack, pose, command);
    else {
      const requested = pursuitCommand(pose, command, dt);
      if (observed.street) {
        const road = onRoadLimit(observed, pose);
        const limit = observed.rush ? rushRoadLimit(road) : road.limit;
        if (requested.targetSpeed > limit) requested.targetSpeed = limit;
      }
      next = integrateVehicle(pose, requested, dt);
    }
    if (!(pack ? sweepSafe(pose, next, [], roads).safe : bodyOnRoad(next, roads, roadMargin))) {
      failure ??= "road-edge"; failureAtS = Math.min(failureAtS, timeS); hardFailure = true; break;
    }
    const radius = pack ? boxRadius(next) : 0;
    const travel = pack ? distance(pose, next) + radius * Math.abs(next.heading - pose.heading) : 0;
    if (polys.some((body) => pack
      ? distance(next, body) <= radius + boxRadius(body) + travel + .12 &&
        packSweepsInto(pose, next, body, separates)
      : overlaps(next, body, .12) && !separates(next, body))) {
      failure ??= "obstacle"; failureAtS = Math.min(failureAtS, timeS); hardFailure = true; break;
    }
    if (observed.unknown.some(({ lastSeen, ageS }) => lastSeen &&
        distance(next, ego) > .1 && !overlaps(ego, lastSeen, .36) &&
        overlaps(next, lastSeen, .24 + Math.min(.8, ageS + timeS)))) {
      failure ??= "unknown"; failureAtS = Math.min(failureAtS, timeS); hardFailure = true; break;
    }
    for (let i = 0; i < movers.length; i++) {
      const actor = movers[i], forecast = pack?.forecasts[step - 1][i];
      const leadS = Math.min(timeS, 1.4);
      const other = forecast?.body ?? { ...actor, x: actor.x + actor.vx * leadS, z: actor.z + actor.vz * leadS };
      const gap = distance(next, other) - (pack ? radius : boxRadius(next)) - (forecast?.radius ?? boxRadius(other));
      clearance = Math.min(clearance, gap);
      const uncertainty = forecast?.uncertainty ?? (actor.motionKnown ? .15 + timeS * .16 : .36 + timeS * .27);
      // Express the relative sweep in the mover's end frame, including a held ego.
      const blocked = forecast ? gap < Math.max(uncertainty, travel + forecast.travel + .12) &&
        packSweepsInto({ ...pose, x: pose.x + forecast.dx, z: pose.z + forecast.dz }, next, other,
          separates, uncertainty) : gap < 1 && overlaps(next, other, uncertainty) && !separates(next, other);
      if (blocked) {
        const cause = actor.type === "pedestrian" ? "pedestrian" : actor.police ? "police" : "traffic";
        failure ??= cause;
        failureAtS = Math.min(failureAtS, timeS);
        if (cause === "pedestrian") {
          failure = cause;
          hardFailure = true;
        }
      }
      if (gap < 5) score -= Math.max(0, 5 - gap) * (actor.police ? pack ? .52 : .37 : .11);
    }
    if (hardFailure || (probe && failure)) break;
    if (probe) {
      if (next.speed < -.05) backedM += distance(pose, next);
      if (next.speed > .05) forwardM += distance(pose, next);
    }
    pose = next;
    if (!failure) usablePose = pose;
  }
  pose = usablePose;
  if (backingTarget) score += (distance(start, backingTarget) - distance(pose, backingTarget)) * 2.7;
  else if (route?.path.length > 1) {
    const a = alongRoute(start, route.path), b = alongRoute(pose, route.path);
    score += (b.progressM - a.progressM) * 1.65 - (b.distanceM - a.distanceM) * .9;
  } else if (observed.cinematic) {
    // At the end of a route hint, favour safe onward movement instead of
    // steering back toward the nearest (possibly already passed) marker.
    score += projection(pose, start).forward * 1.65;
  } else {
    const exit = observed.exits.reduce((nearest, point) =>
      !nearest || distance(point, ego) < distance(nearest, ego) ? point : nearest, null);
    if (exit) score += (distance(start, exit) - distance(pose, exit)) * 1.65;
  }
  if (route?.recovery) score += Math.max(0,
    Math.abs(angleDelta(route.recovery.heading, start.heading)) -
    Math.abs(angleDelta(route.recovery.heading, pose.heading)));
  for (const actor of movers.filter((body) => body.police && body.rangeM < 24)) {
    const timeS = Math.min(1.4, failureAtS);
    const projected = { x: actor.x + actor.vx * timeS, z: actor.z + actor.vz * timeS };
    score += (distance(pose, projected) - distance(start, actor)) * Math.max(0, 1 - actor.rangeM / 24) * 1.3;
  }
  score += distance(start, pose) * .17 - Math.abs(action.steer) * .28 -
    (action.gear < 0 ? 1.4 : 0) - (index === 7 ? 1.8 : 0);
  if (pack) {
    const normalized = (start.steer ?? 0) / (start.spec?.maxSteer ?? VEHICLE.maxSteer);
    score -= .75 * Math.abs(action.steer - normalized);
    score -= Math.max(0, 2 - clearance) * .95;
  }
  if (observed.unknown.length && Math.abs(pose.speed) > 3) score -= .8;
  return { index, action, score, failure, failureAtS, hardFailure, clearance, pose, backedM, forwardM };
}

function checkedRecovery(observed) {
  const { ego, timeS } = observed;
  const gearAction = plan => timeS < plan.turnAtS
    ? act(plan.backSteer, .95, 0, -1) : act(plan.turnSteer, .82);
  const indexFor = action => action.gear > 0 ? action.steer < 0 ? 4 : 5
    : action.steer < 0 ? 8 : action.steer > 0 ? 9 : 10;

  if (observed.recovery?.untilS > timeS) {
    const plan = observed.recovery, action = gearAction(plan);
    const samples = 7;
    const trial = rollout(observed, action, null, indexFor(action), null,
      packRolloutScene(observed, samples), { samples, command: () => action });
    if (!trial.failure) return { ...trial, recovery: plan };
    return null;
  }

  const scene = packRolloutScene(observed, 51);
  let best = null;
  for (const backSteps of [17, 23]) for (const turnSteer of [-1, 1]) {
    for (const backSteer of [0, -turnSteer * .8]) {
      const action = act(backSteer, .95, 0, -1), samples = backSteps + 28;
      const trial = rollout(observed, action, null, indexFor(action), null, scene,
        { samples, command: (_, step) => step <= backSteps ? action : act(turnSteer, .82) });
      if (trial.failure || trial.backedM < 1.5 || trial.forwardM < 2) continue;
      const yaw = Math.abs(angleDelta(trial.pose.heading, ego.heading));
      if (yaw < .54) continue;
      const value = trial.forwardM + 2 * yaw + Math.min(trial.clearance, 3) - backSteps * .04;
      if (!best || value > best.value) best = { ...trial, value, recovery: {
        backSteer, turnSteer, turnAtS: timeS + backSteps * PACK_SAMPLE_S,
        untilS: timeS + samples * PACK_SAMPLE_S,
      } };
    }
  }
  return best;
}

function checkedPrefix(observed, route, candidates) {
  const samples = Math.ceil((.55 + Math.abs(observed.ego.speed) / VEHICLE.braking) / PACK_SAMPLE_S);
  if (samples > ROLLOUT_SAMPLES) return null;
  const scene = packRolloutScene(observed, samples);
  let best = null;
  for (const candidate of candidates) {
    const { action, index } = candidate;
    if (!action.throttle || action.brake || candidate.failureAtS <= .65) continue;
    const trial = rollout(observed, action, route, index, null, scene,
      { samples, command: (_, step) => step <= 3 ? action : act(action.steer, 0, 1, action.gear) });
    if (trial.failure || distance(trial.pose, observed.ego) < .15 || Math.abs(trial.pose.speed) > .15) continue;
    const value = trial.score + Math.min(trial.clearance, 3) + .1 * distance(trial.pose, observed.ego);
    if (!best || value > best.value) best = { ...trial, value };
  }
  return best;
}

const sector = ({ lateral, forward }) =>
  Math.abs(lateral) > Math.abs(forward) ? lateral > 0 ? "right" : "left" : forward > 0 ? "front" : "rear";

function observedPackThreats({ ego, entities }) {
  const sectors = new Set(), closingSectors = new Set();
  const vx = ego.speed * Math.sin(ego.heading), vz = ego.speed * Math.cos(ego.heading);
  let primary = "none", urgency = -Infinity, nearestM = Infinity;
  for (const actor of entities) {
    if (!actor.police || actor.rangeM > 22) continue;
    const side = sector(actor);
    const closing = actor.motionKnown
      ? ((vx - actor.vx) * (actor.x - ego.x) + (vz - actor.vz) * (actor.z - ego.z)) / Math.max(1, actor.rangeM)
      : 0;
    sectors.add(side);
    if (closing > .6) closingSectors.add(side);
    nearestM = Math.min(nearestM, actor.rangeM);
    const risk = (1 + Math.max(0, closing)) / Math.max(1, actor.rangeM - 3);
    if (risk > urgency) {
      urgency = risk;
      primary = side;
    }
  }
  return { primary, sectors: [...sectors], closingSectors: [...closingSectors],
    nearestM: Number.isFinite(nearestM) ? nearestM : null };
}

function packObservationKey(ego, candidates, threat) {
  const pace = ego.speed < -.15 ? "reverse" : ego.speed < 1.2 ? "slow" : "moving";
  const spread = clamp(threat.sectors.length - 1, 0, 2);
  const openings = candidates.filter(c => !c.failure && c.index < 6 && (c.action?.gear ?? 1) > 0).length;
  return `pack-v1:${threat.primary}:${spread}:${pace}:${openings === 0 ? 0 : openings < 3 ? 1 : 2}`;
}

export function pursuitObservationKey(observed, candidates = []) {
  if (observed.pack) return packObservationKey(observed.ego, candidates, observedPackThreats(observed));
  const { ego, entities } = observed;
  let mask = 0;
  for (const entity of entities) {
    if (entity.type === "static" || entity.rangeM > (entity.police ? 19 : 9)) continue;
    mask |= { front: 1, rear: 2, left: 4, right: 8 }[sector(entity)];
  }
  const pace = ego.speed < -0.15 ? "reverse" : ego.speed < 1.2 ? "slow" : ego.speed < 5 ? "cruise" : "fast";
  const crowd = Math.min(2, entities.filter((a) => a.type !== "static" && a.rangeM < 16).length);
  const openness = candidates.filter((candidate) => !candidate.failure && candidate.index < 6).length;
  const key = `${mask}:${pace}:${crowd}:${Math.min(3, openness)}`;
  if (!observed.arcade) return key;
  const vx = ego.speed * Math.sin(ego.heading), vz = ego.speed * Math.cos(ego.heading);
  let threat = "none", urgency = 0;
  for (const entity of entities) {
    if (!entity.police || !entity.motionKnown || entity.rangeM > 25) continue;
    const dx = entity.x - ego.x, dz = entity.z - ego.z;
    const range = Math.max(1, entity.rangeM);
    const closing = ((vx - entity.vx) * dx + (vz - entity.vz) * dz) / range;
    if (closing < 1 || closing / range <= urgency) continue;
    urgency = closing / range;
    threat = sector(entity);
  }
  return `${key}:${threat}`;
}

export function validatePursuitPolicy(weights) {
  if (!weights || weights.schemaVersion !== PURSUIT_POLICY_VERSION || weights.algorithm !== "tabular-q-learning" ||
      !Array.isArray(weights.actions) || weights.actions.length !== PURSUIT_ACTIONS.length ||
      weights.actions.some((value, i) => value !== PURSUIT_ACTIONS[i]) ||
      !Number.isSafeInteger(weights.episodes) || weights.episodes < 0 ||
      !weights.q || Object.getPrototypeOf(weights.q) !== Object.prototype)
    throw new Error("Unsupported pursuit policy");
  const rows = Object.entries(weights.q);
  if (rows.length > 768 || rows.some(([key, row]) =>
    !/^(?:\d|1[0-5]):(?:reverse|slow|cruise|fast):[0-2]:[0-3]$/.test(key) ||
    !Array.isArray(row) || row.length !== PURSUIT_ACTIONS.length ||
    row.some((value) => !Number.isFinite(value) || Math.abs(value) > 1e5)))
    throw new Error("Invalid pursuit policy weights");
  return weights;
}

export function decidePursuit(observed, route, weights = null, choose = null) {
  if (observed.street && route?.path.length > 80) route = { ...route, path: route.path.slice(0, 80) };
  const follow = routeCommand(observed.ego, route);
  const retreat = route || observed.street ? null : retreatPoint(observed);
  const pack = observed.pack ? packRolloutScene(observed) : null;
  const candidates = buildCandidates(follow).map((action, index) => rollout(observed, action, route, index, retreat, pack));
  if (pack) return decidePack(observed, candidates, route, weights, choose);
  const key = pursuitObservationKey(observed, candidates);
  const safe = candidates.filter((candidate) => !candidate.failure);
  const row = weights?.q[key];
  const rank = (candidate) => candidate.score + (candidate.index === 0 && route ? .5 : 0) +
    clamp(row?.[candidate.index] ?? 0, -4, 4);
  safe.sort((a, b) => rank(b) - rank(a) || a.index - b.index);
  const fallback = candidates[7];
  let selected = safe[0] ?? fallback;
  if (!safe.length && !fallback.hardFailure && fallback.failure) {
    const escape = candidates.filter((candidate) => !candidate.hardFailure &&
      candidate.failureAtS >= 0.6 && candidate.failureAtS > fallback.failureAtS &&
      candidate.index !== fallback.index && distance(observed.ego, candidate.pose) > .15)
      .sort((a, b) => b.failureAtS - a.failureAtS || b.score - a.score)[0];
    if (escape) selected = escape;
  }
  if (choose && safe.length) {
    const choice = choose(key, safe.map(r => r.index), selected.index);
    selected = safe.find((candidate) => candidate.index === choice) ?? selected;
  }
  return {
    action: selected.action, index: selected.index, name: PURSUIT_ACTIONS[selected.index], key,
    source: row && (!observed.arcade || safe.length) ? "learned-tactical" : "rollout", routeId: route?.id ?? null,
    clearanceM: selected.clearance, availableActions: safe.map((candidate) => candidate.index),
    threatSectors: [...new Set(observed.entities.filter((a) => a.type !== "static" &&
      a.rangeM < (a.police ? 20 : 10)).map(sector))],
    rejected: candidates.filter(c => c.failure).map(c => ({ action: PURSUIT_ACTIONS[c.index], reason: c.failure })),
  };
}

function decidePack(observed, candidates, route, weights, choose) {
  const packThreat = observedPackThreats(observed);
  const key = packObservationKey(observed.ego, candidates, packThreat);
  const planRank = candidate => candidate.score + (candidate.index === 0 && route ? .5 : 0);
  const safe = candidates.filter(c => !c.failure).sort((a, b) => planRank(b) - planRank(a) || a.index - b.index);
  const safeForward = observed.hunt && safe.some(c => c.action.gear > 0 && c.action.throttle &&
    projection(c.pose, observed.ego).forward > 1.4);
  const stalled = Math.abs(observed.ego.speed) < 1.15 && !safeForward;
  const continuing = observed.recovery?.untilS > observed.timeS;
  const recover = observed.hunt && (continuing || stalled) &&
    checkedRecovery(observed);
  const prefix = observed.hunt && !recover && !safe.some(c => c.action.throttle) &&
    checkedPrefix(observed, route, candidates);
  const maneuver = recover || prefix;
  if (maneuver) return {
    action: maneuver.action, index: maneuver.index, name: PURSUIT_ACTIONS[maneuver.index], key,
    source: recover ? "escape-search" : "checked-prefix", routeId: route?.id ?? null,
    recovery: recover?.recovery ?? null, clearanceM: maneuver.clearance,
    availableActions: [maneuver.index], threatSectors: packThreat.sectors,
    rejected: candidates.filter(c => c.failure).map(c => ({ action: PURSUIT_ACTIONS[c.index], reason: c.failure })),
  };
  const baseline = safe[0] ?? candidates[7];
  const row = weights?.q?.[key];
  const policyLookup = Boolean(row && safe.length);
  let learned = baseline;
  if (policyLookup) {
    const rank = candidate => planRank(candidate) + clamp((row[candidate.index] ?? 0) * .55, -3, 3);
    for (const candidate of safe) {
      if (planRank(baseline) - planRank(candidate) > 3) break;
      if (rank(candidate) > rank(learned)) learned = candidate;
    }
  }
  const availableActions = safe.map(c => c.index);
  const explorationIndex = choose && safe.length ? choose(key, availableActions.slice(), learned.index) : learned.index;
  const selected = safe.find(c => c.index === explorationIndex) ?? learned;
  const rankChanged = learned.index !== baseline.index;
  const explored = selected.index !== learned.index;
  return {
    action: selected.action, index: selected.index, name: PURSUIT_ACTIONS[selected.index], key,
    source: explored ? "exploration" : policyLookup ? "learned-tactical" : "rollout", routeId: route?.id ?? null,
    baselineIndex: baseline.index, learnedIndex: policyLookup ? learned.index : null, rankChanged,
    changed: rankChanged && !explored, policyLookup, explored, forcedHold: !safe.length,
    clearanceM: selected.clearance, availableActions, packThreat, threatSectors: packThreat.sectors,
    rejected: candidates.filter(c => c.failure).map(c => ({ action: PURSUIT_ACTIONS[c.index], reason: c.failure })),
  };
}

export function createArcadeLearner(seed) {
  const rng = new Random(`${seed}:arcade-learning-v1`);
  const weights = { q: Object.create(null) };
  let prior = null, updates = 0, explored = 0;

  function learn(metrics, next, outcome) {
    if (!prior) return;
    const { key, index, before } = prior;
    const progress = metrics.distanceM - before.distanceM;
    const reward = .25 * Math.min(progress, 2) + (progress < .05 ? -.12 : .04)
      - 12 * (metrics.collisions - before.collisions)
      - 25 * (metrics.pedestrianCollisions - before.pedestrianCollisions)
      - .6 * (metrics.nearCollisions - before.nearCollisions)
      + (outcome === "escaped" ? 14 : outcome === "crashed" || outcome === "captured" ? -12 : 0);
    const future = next?.availableActions.length
      ? Math.max(...next.availableActions.map(index => weights.q[next.key]?.[index] ?? 0)) : 0;
    const row = weights.q[key] ??= PURSUIT_ACTIONS.map(() => 0);
    row[index] = clamp(row[index] + .24 * (reward + .9 * future - row[index]), -4, 4);
    updates++;
  }

  return {
    weights,
    choose(_key, safe, best) {
      if (safe.length < 2 || rng.next() >= .16) return best;
      explored++;
      return rng.pick(safe.filter(index => index !== best));
    },
    record(decision, metrics) {
      learn(metrics, decision);
      // Do not attribute an unchecked emergency fallback or manual drive to the learned policy.
      prior = decision.availableActions.includes(decision.index) ? {
        key: decision.key, index: decision.index,
        before: { distanceM: metrics.distanceM, collisions: metrics.collisions,
          pedestrianCollisions: metrics.pedestrianCollisions, nearCollisions: metrics.nearCollisions },
      } : null;
    },
    finish(metrics, outcome) {
      learn(metrics, null, outcome);
      prior = null;
    },
    interrupt() { prior = null; },
    snapshot() { return { updates, explored, states: Object.keys(weights.q).length }; },
  };
}
