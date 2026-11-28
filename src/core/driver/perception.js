import { STEP, clamp } from "../config.js";
import { angleDelta, overlaps, pointOnRoad } from "../geometry.js";
import { onRoadLimit } from "../district-behavior.js";
import { laneFrame } from "../lane-geometry.js";

const FINE_DT = 0.1;
const FINE_STEPS = 22;
const COARSE_DT = 0.25;
const COARSE_STEPS = 12;
const PEDESTRIAN_HORIZON_S = 2.4;
const SIDEWALK_HORIZON_S = 0.7;
const ZONE_LOOKAHEAD_M = 75;
const ZONE_ENTRY_HORIZON_S = 2.2;

export const DEFAULT_GAPS = Object.freeze({
  vehicle: Object.freeze({ hard: 0.30, soft1: 0.8, soft2: 1.6 }),
  // A walker on the roadway or stepping toward it keeps the full safety margin.
  pedestrian: Object.freeze({ hard: 1.15, soft1: 1.5, soft2: 2.0 }),
  // A walker staying on the pavement only needs tight kerbside clearance.
  sidewalk: Object.freeze({ hard: 0.55, soft1: 0.85, soft2: 1.1 }),
  static: Object.freeze({ hard: 0.30, soft1: 0.6, soft2: 1.1 }),
  // A faster car overtaking alongside is expected to be close; only genuinely tight gaps count.
  passing: Object.freeze({ hard: 0.30, soft1: 0.45, soft2: 0.9 }),
  // A wreck leaves a roadway only a little wider than the car; threading it slowly at half a metre is the plan.
  wreck: Object.freeze({ hard: 0.30, soft1: 0.5, soft2: 1.0 }),
});

export const TIMES = (() => {
  const times = [];
  let t = 0;
  for (let i = 0; i < FINE_STEPS; i++) times.push(t += FINE_DT);
  for (let i = 0; i < COARSE_STEPS; i++) times.push(t += COARSE_DT);
  return Object.freeze(times);
})();
export const HORIZON_S = TIMES.at(-1);

// Fixed props a car can never drive through: lamp posts, bollards/furniture and tree trunks.
export const SOLID_PROP_KINDS = Object.freeze(["city-lamp", "city-furniture", "city-tree"]);

/* -------------------------------------------------------------- obstacles */

function observedKinematics(actor) {
  const prev = actor.previous;
  const speed = Math.max(actor.speed ?? 0, 0);
  let omega = 0;
  let accel = 0;
  if (prev && Number.isFinite(prev.heading)) {
    omega = clamp(angleDelta(actor.heading, prev.heading) / STEP, -0.9, 0.9);
    accel = clamp((speed - Math.max(prev.speed ?? speed, 0)) / STEP, -8, 4);
  }
  return { speed, omega, accel };
}

function predictVehicle(actor, obstacle) {
  const { speed, omega, accel } = observedKinematics(actor);
  const braking = accel < -1.5;
  let x = actor.x;
  let z = actor.z;
  let prevT = 0;
  for (let k = 0; k < TIMES.length; k++) {
    const t = TIMES[k];
    const dt = t - prevT;
    const v = braking ? Math.max(0, speed + accel * (t - dt / 2)) : speed;
    const heading = actor.heading + omega * 0.8 * (1 - Math.exp(-(t - dt / 2) / 0.8));
    x += Math.sin(heading) * v * dt;
    z += Math.cos(heading) * v * dt;
    obstacle.px[k] = x;
    obstacle.pz[k] = z;
    obstacle.ph[k] = actor.heading + omega * 0.8 * (1 - Math.exp(-t / 0.8));
    prevT = t;
  }
  return { speed, omega };
}

// A walker on the roadway, crossing, or facing it close enough to step in keeps the full safety margin;
// one strolling along the pavement is not a reason to swerve or stop.
function walkerHeadsForRoadway(world, actor, speed) {
  if (actor.crossing || pointOnRoad(actor, world.roads, 0)) return true;
  const hx = Math.sin(actor.heading ?? 0);
  const hz = Math.cos(actor.heading ?? 0);
  const reach = Math.max(1.8, speed * PEDESTRIAN_HORIZON_S);
  for (let d = 0.6; d <= reach + 1e-6; d += 0.6)
    if (pointOnRoad({ x: actor.x + hx * d, z: actor.z + hz * d }, world.roads, 0)) return true;
  return speed < 0.3 && pointOnRoad(actor, world.roads, -0.4);
}

function predictPedestrian(world, actor, obstacle, gaps) {
  const speed = Math.max(actor.speed ?? 0, 0);
  const sx = Math.sin(actor.heading ?? 0) * speed;
  const sz = Math.cos(actor.heading ?? 0) * speed;
  const roadway = walkerHeadsForRoadway(world, actor, speed);
  const horizon = roadway ? PEDESTRIAN_HORIZON_S : SIDEWALK_HORIZON_S;
  obstacle.gaps = roadway ? gaps.pedestrian : gaps.sidewalk;
  obstacle.roadway = roadway;
  for (let k = 0; k < TIMES.length; k++) {
    // A walker's intent is only trusted briefly; later poses are parked far away.
    const t = Math.min(TIMES[k], horizon);
    obstacle.px[k] = TIMES[k] > horizon ? 1e6 : actor.x + sx * t;
    obstacle.pz[k] = TIMES[k] > horizon ? 1e6 : actor.z + sz * t;
    obstacle.ph[k] = actor.heading ?? 0;
  }
}

function newObstacle(source, kind, gaps) {
  const isPed = source.type === "pedestrian";
  return {
    source, kind, id: source.id, isPed,
    pose: {
      type: isPed ? "pedestrian" : source.type === "static" ? "static" : "vehicle",
      x: source.x, z: source.z, heading: source.heading ?? 0, length: source.length, width: source.width,
      radius: source.radius,
    },
    px: new Float64Array(TIMES.length), pz: new Float64Array(TIMES.length), ph: new Float64Array(TIMES.length),
    gaps: gaps[isPed ? "pedestrian" : source.type === "static" ? "static" : "vehicle"],
    hard: 0, speed: 0, lateralClosing: 0, forward: 0, lateral: 0, passing: false, cutIn: false, oncoming: false,
    solid: false,
  };
}

export function gatherObstacles(world, player, gaps = DEFAULT_GAPS, isWreckActor = () => false) {
  const out = [];
  const hx = Math.sin(player.heading);
  const hz = Math.cos(player.heading);
  const near = world.actorIndex.near(player, 66);
  for (let i = 0; i < near.length; i++) {
    const actor = near[i];
    if (actor === player) continue;
    const dx = actor.x - player.x;
    const dz = actor.z - player.z;
    const forward = dx * hx + dz * hz;
    const lateral = dx * hz - dz * hx;
    if (actor.type === "pedestrian") {
      if (forward < -4 || forward > 42 || Math.abs(lateral) > 12) continue;
      const o = newObstacle(actor, "pedestrian", gaps);
      predictPedestrian(world, actor, o, gaps);
      out.push(o);
      continue;
    }
    if (actor.type !== "vehicle") continue;
    if (forward < -14 || forward > 66) continue;
    const o = newObstacle(actor, actor.kind === "truck" ? "truck" : "vehicle", gaps);
    const kin = predictVehicle(actor, o);
    o.speed = kin.speed;
    o.wreck = isWreckActor(world, actor);
    if (o.wreck) { o.kind = "accident"; o.gaps = gaps.wreck; }
    // Lateral closing speed toward the ego travel line, from the actor's own heading and speed.
    const rel = angleDelta(actor.heading, player.heading);
    const vLat = kin.speed * Math.sin(rel);
    o.lateralClosing = lateral > 0 ? -vLat : vLat;
    o.forward = forward;
    o.lateral = lateral;
    o.oncoming = Math.abs(rel) > 2.2;
    const length = player.length ?? 4.2;
    // Only same-direction traffic converging on the ego lane is a cut-in, never ±90° cross traffic.
    o.cutIn = Math.abs(rel) < 0.6 && forward >= -1.5 * length && forward <= 5 * length && o.lateralClosing > 0.8;
    o.passing = !o.wreck && Math.abs(rel) < 0.35 && forward < length / 2 && Math.abs(lateral) < 5;
    if (o.passing) o.gaps = gaps.passing;
    // A parallel car beside or behind the nose that is not drifting into the lane is no forward threat;
    // only actual contact still counts, so a real cut-in is caught the moment it starts closing.
    const bodyClear = Math.abs(lateral) - ((actor.width ?? 1.85) + (player.width ?? 1.85)) / 2;
    o.parallelRear = o.passing && Math.abs(rel) < 0.22 && forward < length * 0.5 && bodyClear >= 0.7 && o.lateralClosing <= 0.25;
    out.push(o);
  }
  const statics = world.staticIndex.near(player, 52);
  for (let i = 0; i < statics.length; i++) {
    const s = statics[i];
    const dx = s.x - player.x;
    const dz = s.z - player.z;
    const reach = Math.hypot(s.width ?? 0, s.length ?? 0) / 2;
    if (Math.hypot(dx, dz) - reach > 46) continue;
    const forward = dx * hx + dz * hz;
    if (forward + reach < -10 || Math.abs(dx * hz - dz * hx) - reach > 10) continue;
    const o = newObstacle(s, "static", gaps);
    o.solid = SOLID_PROP_KINDS.includes(s.kind);
    for (let k = 0; k < TIMES.length; k++) {
      o.px[k] = s.x;
      o.pz[k] = s.z;
      o.ph[k] = s.heading ?? 0;
    }
    out.push(o);
  }
  for (const o of out) {
    o.hard = o.gaps.hard;
    if (overlaps(player, o.source, o.gaps.hard) || o.parallelRear) o.hard = 0;
  }
  return out;
}

/* ---------------------------------------------------- junction foresight */

// Another car is in the box, waiting at its edge, or will reach it within a couple of seconds. Cars behind
// the ego and the leader in the ego's own lane never count: the rollouts already handle those.
function claimsZone(player, car, zone, cx, cz) {
  const dx = Math.max(zone.minX - car.x, 0, car.x - zone.maxX);
  const dz = Math.max(zone.minZ - car.z, 0, car.z - zone.maxZ);
  const gap = Math.hypot(dx, dz);
  const length = player.length ?? 4.2;
  const rx = car.x - player.x;
  const rz = car.z - player.z;
  const forward = rx * Math.sin(player.heading) + rz * Math.cos(player.heading);
  if (forward < -length) return false;
  const lateral = Math.abs(rx * Math.cos(player.heading) - rz * Math.sin(player.heading));
  if (forward > 0 && lateral < 1.7 && Math.abs(angleDelta(car.heading, player.heading)) < 0.35 &&
      (car.speed ?? 0) > (player.speed ?? 0) - 1) return false;
  if (gap <= 1) return true;
  const speed = Math.max(car.speed ?? 0, 0);
  if (speed < 1.5) return gap <= 2;
  const toward = (cx - car.x) * Math.sin(car.heading) + (cz - car.z) * Math.cos(car.heading) > 0;
  return toward && gap <= 2 + speed * ZONE_ENTRY_HORIZON_S;
}

// The first conflict zone on the planned route that another car owns or sits in. The district ticket queue
// only notices an approach a braking distance away, so the car reads the junction early and glides to its line.
export function contestedZoneAhead(world, player) {
  const zones = world.district?.conflictZones;
  const behavior = world.districtBehavior;
  const path = player.path;
  if (!zones?.length || !behavior || !path || path.length < 2) return null;
  const pad = (player.length ?? 4.2) / 2 + 0.3;
  const owners = new Map();
  for (const [key, lease] of Object.entries(behavior.reservations ?? {}))
    for (const id of key.split("+")) owners.set(id, lease.ownerId);
  const reach = ZONE_LOOKAHEAD_M + 14;
  const near = zones.filter((z) => z.maxX > player.x - reach && z.minX < player.x + reach &&
    z.maxZ > player.z - reach && z.minZ < player.z + reach);
  if (!near.length) return null;
  const inside = (z, x, z2, margin) => x >= z.minX - margin && x <= z.maxX + margin && z2 >= z.minZ - margin && z2 <= z.maxZ + margin;
  const seen = new Set();
  for (const z of near) if (inside(z, player.x, player.z, 0)) seen.add(z);
  let dist = 0;
  let prevX = player.x;
  let prevZ = player.z;
  for (let i = player.cursor ?? 0; i < path.length && dist < ZONE_LOOKAHEAD_M; i++) {
    const p = path[i];
    dist += Math.hypot(p.x - prevX, p.z - prevZ);
    prevX = p.x;
    prevZ = p.z;
    for (const z of near) {
      if (seen.has(z) || !inside(z, p.x, p.z, pad)) continue;
      seen.add(z);
      const owner = owners.get(z.id);
      let busy = owner !== undefined && owner !== player.id;
      if (!busy) {
        const cx = (z.minX + z.maxX) / 2;
        const cz = (z.minZ + z.maxZ) / 2;
        const others = world.actorIndex.near({ x: cx, z: cz }, Math.hypot(z.maxX - z.minX, z.maxZ - z.minZ) / 2 + 14 + 2.2 * 16);
        busy = others.some((a) => a !== player && a.type === "vehicle" && claimsZone(player, a, z, cx, cz));
      }
      if (busy) {
        return {
          distanceM: dist, zoneId: z.id,
          stopBeforeM: 0.85 + (z.kind === "junction" ? player.width ?? 1.9 : 0),
        };
      }
    }
  }
  return null;
}

/* ------------------------------------------------------------- perception */

// Junction hold/approach/contested-zone sensing. `memory` carries the throttled zone scan between ticks.
function senseJunction(world, player, strategy, memory) {
  const behavior = world.districtBehavior;
  const hold = strategy.obeyJunctionHolds ? behavior?.holds?.[player.id] : undefined;
  const approach = strategy.obeyJunctionHolds ? behavior?.approaches?.[player.id] : undefined;
  // A junction another car owns is approached as gently as a hold, long before the ticket queue stops us.
  const busyApproach = approach && !hold && (behavior.reservations?.[approach.zoneId]?.ownerId ?? player.id) !== player.id
    ? approach : null;
  if (strategy.obeyJunctionHolds && world.tick - memory.zoneTick >= strategy.evalEveryTicks) {
    memory.zoneTick = world.tick;
    memory.zoneAhead = contestedZoneAhead(world, player);
    if (memory.zoneAhead) memory.zoneAhead.odometerM = player.distance ?? 0;
  }
  const zoneAhead = strategy.obeyJunctionHolds && memory.zoneAhead && !hold && world.tick >= memory.zoneIgnoreUntil
    ? { distanceM: memory.zoneAhead.distanceM - ((player.distance ?? 0) - memory.zoneAhead.odometerM),
      stopBeforeM: memory.zoneAhead.stopBeforeM, zoneId: memory.zoneAhead.zoneId } : null;
  const gate = hold ?? busyApproach ?? (zoneAhead && zoneAhead.distanceM > 0 ? zoneAhead : null);
  return { hold, busyApproach, gate, gateOnly: Boolean(gate) && gate !== hold && gate !== busyApproach };
}

// Obstacles with their predicted poses plus the lane frame, gathered on the planner's evaluation ticks.
export function perceiveObstacles(world, player, strategy) {
  return {
    obstacles: gatherObstacles(world, player, strategy.gaps ?? DEFAULT_GAPS, strategy.isWreckActor),
    lane: laneFrame(world, player, { maxPsi: 0.6 }),
  };
}

// The unified corridor picture: junction gate + road limit every tick, obstacles and lane when requested.
export function perceiveCorridor(world, player, strategy, memory = { zoneTick: -99, zoneAhead: null, zoneIgnoreUntil: -1 },
  { obstacles = true } = {}) {
  const junction = senseJunction(world, player, strategy, memory);
  const perception = {
    ...junction, road: onRoadLimit(world, player), roads: world.roads, obstacles: null, lane: null,
    // Lets the planner pay for obstacle gathering only on the ticks it actually evaluates.
    refresh: () => Object.assign(perception, perceiveObstacles(world, player, strategy)),
  };
  if (obstacles) perception.refresh();
  return perception;
}
