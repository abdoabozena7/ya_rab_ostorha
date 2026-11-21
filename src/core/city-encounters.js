import { STEP } from "./config.js";
import { avenueCrossings } from "./district-behavior.js";
import { angleDelta, bodyOnRoad, distance, pointOnRoad } from "./geometry.js";
import { Random } from "./random.js";
import { SpatialIndex } from "./spatial-index.js";
import { walkSegmentClear } from "./walk-route.js";
import { DISPATCH_RULESET } from "./pursuit-dispatch.js";

export const CITY_ENCOUNTERS = Object.freeze([
  "curb-pickup", "traffic-wave", "side-street-tuktuk", "curb-crossing", "roadworks",
]);
const seconds = value => Math.round(value / STEP);
const span = (road, point) => road.axis === "z" ? point.z : point.x;
const cross = (road, point) => road.axis === "z" ? point.x : point.z;
const place = (road, along, across) => road.axis === "z"
  ? { x: across, z: along } : { x: along, z: across };
const longitudinal = (body, point) => (point.x - body.x) * Math.sin(body.heading) +
  (point.z - body.z) * Math.cos(body.heading);
const lateral = (body, point) => Math.abs((point.x - body.x) * Math.cos(body.heading) -
  (point.z - body.z) * Math.sin(body.heading));

export function createCityEncounters(config) {
  const rng = new Random(`${config.seed}:city-encounters-v1`);
  return {
    rng, nextTick: seconds(config.scenarioInterval * rng.range(.75, 1.2)),
    active: [], events: [], capByActor: new Map(), lastStarted: new Map(), serial: 0, lastKind: null,
  };
}

function log(world, event, phase, extra = {}) {
  const state = world.cityEncounters;
  state.events.push({
    id: event.id, kind: event.kind, phase, tick: world.tick,
    actorId: event.actor?.id ?? event.barrier?.id ?? null,
    roadId: event.road?.id ?? null, x: event.start.x, z: event.start.z, ...extra,
  });
  if (state.events.length > 32) state.events.shift();
  if (phase === "applied") world.metrics.scenarios++;
}

function nearZone(world, point, margin = 1) {
  return world.district.conflictZones.some(zone =>
    point.x >= zone.minX - margin && point.x <= zone.maxX + margin &&
    point.z >= zone.minZ - margin && point.z <= zone.maxZ + margin);
}

function laneAt(world, actor) {
  return world.drivingRoads.find(road =>
    span(road, actor) >= road.min && span(road, actor) <= road.max &&
    Math.abs(cross(road, actor) - road.fixed) < road.width / 2 &&
    Math.abs(Math.sin(actor.heading - (road.axis === "z" ? 0 : Math.PI / 2))) < .45);
}

function ordered(rng, candidates) {
  return candidates.map(candidate => ({ candidate, order: rng.next() }))
    .sort((a, b) => a.order - b.order).map(result => result.candidate);
}

function vehicleEvent(kind, world, lead, road, follower = null) {
  const now = world.tick, rng = world.cityEncounters.rng;
  const hold = kind === "side-street-tuktuk" ? rng.range(.65, 1.4)
    : rng.range(2.4, 3.8) + world.config.difficulty * .18;
  const landing = kind === "traffic-wave" ? rng.range(.45, 1.35) : 0;
  return {
    actor: lead, road, follower, landing, start: { x: lead.x, z: lead.z },
    leadSpeed: lead.speed, followerSpeed: follower?.speed ?? 0,
    leadMin: lead.speed,
    followerMin: follower?.speed ?? 0, capUntil: now + seconds(hold),
    endTick: now + seconds(hold + 7),
  };
}

function chooseVehicle(kind, world, nearby) {
  const { player, cityEncounters: state } = world;
  const playerRoad = kind === "side-street-tuktuk" ? laneAt(world, player) : null;
  if (kind === "side-street-tuktuk" && !playerRoad) return null;
  const civilians = nearby.filter(actor => actor !== player && actor.type === "vehicle" &&
    actor.pursuitRole !== "police" && actor.path.length > actor.cursor + 3);
  for (const actor of ordered(state.rng, civilians)) {
    if (state.capByActor.has(actor.id) || actor.speed < (kind === "side-street-tuktuk" ? .75 : 1.8)) continue;
    const road = laneAt(world, actor), forward = longitudinal(player, actor);
    if (!road) continue;
    if (kind === "curb-pickup") {
      if (!["van", "taxi"].includes(actor.kind) || forward < 6 ||
          nearZone(world, actor, 4) || road.width < 5.5) continue;
      return vehicleEvent(kind, world, actor, road);
    }
    if (kind === "traffic-wave") {
      if (road.zone !== "avenue" || forward < 7 || nearZone(world, actor, 4)) continue;
      const follower = civilians.concat(player).find(other => other !== actor && other.speed > 1.3 &&
        longitudinal(actor, other) < -5 && longitudinal(actor, other) > -25 &&
        lateral(actor, other) < 1.6 && Math.abs(angleDelta(actor.heading, other.heading)) < .32);
      if (follower) return vehicleEvent(kind, world, actor, road, follower);
    } else if (kind === "side-street-tuktuk") {
      if (actor.kind !== "tuktuk" || road.axis === playerRoad.axis ||
          forward < -3 || nearZone(world, actor)) continue;
      const join = world.junctions.find(node =>
        longitudinal(actor, node) > 5 && longitudinal(actor, node) < 19 &&
        lateral(actor, node) < road.width / 2 && longitudinal(player, node) > 5 &&
        longitudinal(player, node) < 37 && lateral(player, node) < playerRoad.width / 2);
      if (join && actor.path.slice(actor.cursor, actor.cursor + 65).some(point => distance(join, point) < 4))
        return { ...vehicleEvent(kind, world, actor, road), join };
    }
  }
  return null;
}

function chooseCrossing(world, nearby) {
  const { cityEncounters: state, district, player } = world;
  for (const actor of ordered(state.rng, nearby.filter(actor => actor.type === "pedestrian"))) {
    if (actor.crossing || actor.motionMode !== "ambient" || longitudinal(player, actor) < 2 ||
        state.active.some(event => event.actor === actor) || pointOnRoad(actor, world.roads)) continue;
    const line = district.walkways.find(walkway => !walkway.doorway &&
      Math.abs(cross(walkway, actor) - walkway.fixed) < .8 &&
      span(walkway, actor) > walkway.min + .8 && span(walkway, actor) < walkway.max - .8);
    if (!line) continue;
    const road = district.drivingRoads.find(road => road.id === line.roadId);
    const opposite = district.walkways.find(other => !other.doorway && other.roadId === line.roadId &&
      other.side !== line.side && other.axis === line.axis);
    if (!road || !opposite) continue;
    const at = span(line, actor);
    const along = road.zone === "avenue" ? avenueCrossings(road, world.drivingRoads)
      .sort((a, b) => Math.abs(at - a) - Math.abs(at - b))[0] : at + state.rng.range(-1, 1);
    if (!Number.isFinite(along) || Math.abs(along - at) > 3 || along < line.min + .6 ||
        along > line.max - .6 || along < opposite.min + .6 || along > opposite.max - .6) continue;
    const curb = place(line, along, line.fixed), target = place(opposite, along, opposite.fixed);
    if (!walkSegmentClear(actor, actor, curb, world.statics, .12) ||
        !walkSegmentClear(actor, curb, target, world.statics, .12)) continue;
    return { actor, road, target, curb, originLine: line, targetLine: opposite,
      start: { x: actor.x, z: actor.z }, initialDistance: actor.distance,
      endTick: world.tick + seconds(Math.max(13, distance(curb, target) / .95 + 5)) };
  }
  return null;
}

function chooseRoadworks(world) {
  const { player, cityEncounters: state } = world;
  const road = laneAt(world, player);
  if (!road || road.width < 5.5) return null;
  const yaw = road.axis === "z" ? 0 : Math.PI / 2;
  const ahead = angleDelta(player.heading, yaw);
  const direction = Math.cos(ahead) > 0 ? 1 : -1;
  const minimum = 17 + Math.abs(player.speed) * .55 + player.speed ** 2 / 7;
  for (const offset of ordered(state.rng, [0, 3, 6, 9, 12])) {
    const along = span(road, player) + direction * (minimum + offset);
    if (along < road.min + 5 || along > road.max - 5) continue;
    const centre = cross(road, player);
    const side = Math.sign(centre - road.fixed) || direction;
    const position = place(road, along, road.fixed + side *
      Math.min(road.width / 2 - 1.2, Math.max(Math.abs(centre - road.fixed), road.laneOffsetM) + .6));
    const barrier = { ...position, id: `metro-roadworks-${state.serial + 1}`,
      kind: "barrier", type: "static", width: 2, length: .62, height: .86, heading: yaw,
      cityEncounter: "roadworks" };
    if (nearZone(world, position, 2.8) || !bodyOnRoad(barrier, world.roads) ||
        !world.free(barrier, 2.5)) continue;
    return { barrier, road, start: position, endTick: world.tick + seconds(state.rng.range(4.5, 6.5)) };
  }
  return null;
}

function refreshStatics(world) {
  world.staticIndex = new SpatialIndex(world.statics);
}

function admit(world, kind, event) {
  const state = world.cityEncounters;
  Object.assign(event, { id: ++state.serial, kind, applied: false, revealed: false });
  state.lastKind = kind;
  state.lastStarted.set(kind, world.tick);
  state.active.push(event);
  log(world, event, "started");
  if (event.barrier) {
    if (world.statics === world.district.statics) world.statics = world.statics.slice();
    world.statics.push(event.barrier);
    refreshStatics(world);
    event.applied = true;
    log(world, event, "applied");
  } else if (event.target) {
    const { actor, road, curb, target, originLine, targetLine } = event;
    actor.target = target;
    actor.road = road;
    actor.pause = state.rng.range(.35, .9);
    actor.crossing = true;
    actor.side = originLine.side;
    actor.walkRoute = [curb, target];
    actor.walkGoal = `${target.x},${target.z}`;
    actor.walkPlanTick = world.tick;
    Object.assign(actor.district, {
      stage: "moving", pattern: "crossing", origin: { ...event.start }, destination: { ...target },
      routeConstrained: true, yieldAtCurb: true, holdAtTarget: false,
      targetRetryTick: event.endTick,
      startedTick: world.tick, startedDistanceM: actor.distance,
      walkwayId: originLine.id, targetWalkwayId: targetLine.id,
    });
  } else state.capByActor.set(event.actor.id, event);
}

function observeEffect(world, event) {
  const { actor, follower, barrier, start, applied } = event;
  if (barrier) {
    if (!event.revealed) {
      const response = world.actors.find(actor => actor.blockedBy === barrier.id);
      if (response) {
        event.revealed = true;
        log(world, event, "response", { blockedId: response.id, speedMps: response.speed });
      }
    }
    return;
  }
  if (applied && !event.revealed && actor.type === "vehicle" &&
      world.tick >= event.capUntil && actor.speed > event.landing + .55) {
    event.revealed = true;
    log(world, event, "resumed", { speedMps: actor.speed });
  }
  if (applied && !event.revealed && event.target && distance(actor, event.target) < .6) {
    event.revealed = true;
    log(world, event, "response", { reachedOppositeSide: true });
  }
  if (!applied && actor.type === "vehicle") {
    event.leadMin = Math.min(event.leadMin, actor.speed);
    if (follower && follower.blockedBy === actor.id)
      event.followerMin = Math.min(event.followerMin, follower.speed);
  }
  if (applied) return;
  let effect;
  if (event.kind === "curb-pickup" && world.tick < event.capUntil && actor.speed < .25)
    effect = { speedBeforeMps: event.leadSpeed, speedMps: actor.speed };
  if (event.kind === "traffic-wave" && event.followerSpeed - event.followerMin > .32 &&
      event.leadSpeed - event.leadMin > .6)
    effect = { speedBeforeMps: event.leadSpeed, speedMps: event.leadMin,
      followerId: follower.id, followerDropMps: event.followerSpeed - event.followerMin };
  if (event.kind === "side-street-tuktuk" && event.leadSpeed - event.leadMin > .3 &&
      world.tick >= event.capUntil && distance(start, actor) > 3 &&
      distance(event.join, actor) < 5)
    effect = { movedM: distance(start, actor), speedBeforeMps: event.leadSpeed, lowMps: event.leadMin };
  if (event.kind === "curb-crossing" && actor.distance - event.initialDistance > 1 &&
      pointOnRoad(actor, [event.road]))
    effect = { movedM: actor.distance - event.initialDistance };
  if (effect) {
    event.applied = true;
    log(world, event, "applied", effect);
  }
}

export function advanceCityEncounters(world) {
  const state = world.cityEncounters;
  if (!state || world.config.chaos === 0) return;
  for (let i = state.active.length - 1; i >= 0; i--) {
    const event = state.active[i];
    observeEffect(world, event);
    if (world.tick < event.endTick) continue;
    state.active.splice(i, 1);
    if (event.actor) state.capByActor.delete(event.actor.id);
    if (event.barrier) {
      const index = world.statics.indexOf(event.barrier);
      if (index >= 0) {
        world.statics.splice(index, 1);
        if (world.statics.length === world.district.statics.length &&
            world.statics.every((body, index) => body === world.district.statics[index]))
          world.statics = world.district.statics;
        refreshStatics(world);
      }
    }
    log(world, event, event.applied ? (event.target && !event.revealed ? "ended" : "cleared") : "not-observed");
  }
  const pursuing = world.pursuit?.phase === "running";
  if (world.tick < state.nextTick || (pursuing && world.pursuit.gta?.config.ruleset !== DISPATCH_RULESET)) return;
  state.nextTick = world.tick + seconds(world.config.scenarioInterval * state.rng.range(.8, 1.25));
  if (Math.abs(world.player.speed) < .5 || state.active.length >= (world.config.difficulty >= 4 ? 3 : 1) ||
      state.rng.next() > world.config.chaos) return;
  const nearby = world.actorIndex.near(world.player, 46);
  for (const kind of ordered(state.rng, CITY_ENCOUNTERS)) {
    // Let Dispatch own new closures, while existing civilians remain active.
    if (pursuing && kind === "roadworks") continue;
    const cooldown = kind === "roadworks" ? 11 : 5;
    if (kind === state.lastKind || world.tick - (state.lastStarted.get(kind) ?? -Infinity) < seconds(cooldown) ||
        state.active.some(event => event.kind === kind)) continue;
    const event = kind === "roadworks" ? chooseRoadworks(world) :
      kind === "curb-crossing" ? chooseCrossing(world, nearby) : chooseVehicle(kind, world, nearby);
    if (!event) continue;
    admit(world, kind, event);
    return;
  }
}

export function capCityEncounter(world, actor, command) {
  const event = world.cityEncounters?.capByActor.get(actor.id);
  if (!event || world.tick >= event.capUntil || command.targetSpeed <= event.landing) return command;
  return { ...command, targetSpeed: event.landing, reason: event.kind, blockedBy: null };
}
