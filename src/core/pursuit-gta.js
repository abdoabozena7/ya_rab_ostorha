import { STEP, VEHICLE, clamp } from "./config.js";
import { angleDelta, distance, pointOnRoad } from "./geometry.js";
import { PLAYER_VEHICLE } from "./vehicle-spec.js";
import { followPath } from "./vehicle.js";

export const GtaChaseConfig = Object.freeze({
  wantedLevelStart: 1, wantedLevelMax: 5, maxActivePatrols: 12, npcSpeedMultiplier: 1,
  enablePitManeuver: true, enableRamming: true, enableRoadblocks: true, enableSwat: true,
  playerMaxHealth: 100, episodeMaxSeconds: 120, minSpawnRadius: 16, wreckSeconds: 8,
});

export const GTA_MAX_SPEED = 28;
export const GTA_PIN_SECONDS = 2.2;
export const GTA_UNIT_TYPES = Object.freeze(["patrol", "interceptor", "swat"]);
export const GTA_AI_STATES = Object.freeze([
  "APPROACH", "PURSUIT", "FLANK", "PIT_MANEUVER", "RAM", "BLOCK_INTERCEPT",
  "ROADBLOCK", "SEARCH", "RECOVER", "WRECKED",
]);
export const GTA_PATROL_PROFILES = Object.freeze({
  patrol: Object.freeze({ kind: "sedan", mass: 1750, health: 85, speed: 20, acceleration: 3.1, steerRate: .95 }),
  interceptor: Object.freeze({ kind: "suv", mass: 1650, health: 78, speed: 25, acceleration: 4.2, steerRate: 1.2 }),
  swat: Object.freeze({ kind: "van", mass: 4200, health: 165, speed: 16, acceleration: 2.55, steerRate: .68 }),
});
const PIN_TICKS = Math.round(GTA_PIN_SECONDS / STEP);
const FADE_TICKS = Math.round(2.4 / STEP);
const LOST_GRACE_TICKS = Math.round(3 / STEP);
const GTA_SLIP_LIMIT = 11;
const GTA_YAW_LIMIT = 4;
const STUCK_TICKS = Math.round(1.4 / STEP), RECOVER_TICKS = Math.round(.9 / STEP);
const headingTo = (from, to) => Math.atan2(to.x - from.x, to.z - from.z);

export function resolveGtaChaseConfig(options = {}, level = GtaChaseConfig.wantedLevelStart) {
  if (!options || Object.getPrototypeOf(options) !== Object.prototype)
    throw new TypeError("GTA chase config must be a plain object");
  for (const key of Object.keys(options))
    if (!Object.hasOwn(GtaChaseConfig, key)) throw new TypeError(`Unknown GTA chase config field: ${key}`);
  const config = { ...GtaChaseConfig, wantedLevelStart: level, ...options };
  for (const key of ["wantedLevelStart", "wantedLevelMax", "maxActivePatrols"]) {
    const min = key === "maxActivePatrols" ? 0 : 1, max = key === "maxActivePatrols" ? 32 : 5;
    if (!Number.isInteger(config[key]) || config[key] < min || config[key] > max)
      throw new RangeError(`${key} must be an integer between ${min} and ${max}`);
  }
  if (config.wantedLevelStart > config.wantedLevelMax)
    throw new RangeError("wantedLevelStart must not exceed wantedLevelMax");
  for (const [key, max] of [
    ["npcSpeedMultiplier", 3], ["playerMaxHealth", 1e6], ["episodeMaxSeconds", 86400],
    ["minSpawnRadius", 45], ["wreckSeconds", 120],
  ])
    if (!Number.isFinite(config[key]) || config[key] <= 0 || config[key] > max)
      throw new RangeError(`${key} must be positive and at most ${max}`);
  for (const key of ["enablePitManeuver", "enableRamming", "enableRoadblocks", "enableSwat"])
    if (typeof config[key] !== "boolean") throw new TypeError(`${key} must be a boolean`);
  return Object.freeze(config);
}

export function initializeGtaPursuit(state, player, config) {
  state.wantedLevel = config.wantedLevelStart;
  state.stepEvents = [];
  state.gta = {
    config, normalMaxSpeed: player.maxSpeed, serial: 0, pinnedTicks: 0, fadeStars: 0, lostTicks: 0,
    roadblock: null, heat: 0, nextDispatchTick: 0, nextRoadblockTick: 0, nextSquadTick: 0,
  };
}

export function initializeGtaDurability(actor, maxHealth, massKg) {
  Object.assign(actor, { health: maxHealth, maxHealth, gtaMassKg: massKg, gtaSlipMps: 0, gtaYawRate: 0 });
}

export function initializeGtaPatrol(car, unitType, state) {
  const profile = GTA_PATROL_PROFILES[unitType];
  car.unitType = unitType;
  car.aiState = "APPROACH";
  car.squadRole = "SUPPORT";
  car.pursuitRole = "police";
  car.reckless = false;
  car.height = unitType === "swat" ? 2.1 : 1.5;
  if (unitType === "swat") {
    car.length = 5.2;
    car.width = 2.1;
  }
  car.spec = { acceleration: profile.acceleration, steerRate: profile.steerRate,
    wheelbase: unitType === "swat" ? 3.15 : VEHICLE.wheelbase };
  car.maxSpeed = profile.speed * state.gta.config.npcSpeedMultiplier;
  car.gtaAI = { order: state.gta.serial, nextPlan: 0, stuckTicks: 0, behindTicks: 0 };
  initializeGtaDurability(car, profile.health, profile.mass);
}

export function gtaOffset(from, forward, right = 0) {
  const sin = Math.sin(from.heading), cos = Math.cos(from.heading);
  return { x: from.x + forward * sin + right * cos, z: from.z + forward * cos - right * sin };
}

export function gtaLocal(from, to) {
  const dx = to.x - from.x, dz = to.z - from.z, sin = Math.sin(from.heading), cos = Math.cos(from.heading);
  return { forward: dx * sin + dz * cos, right: dx * cos - dz * sin };
}

function directCommand(car, aim, pace, steerBias = 0) {
  const error = angleDelta(headingTo(car, aim), car.heading);
  const steer = clamp(error * .91 + steerBias, -VEHICLE.maxSteer, VEHICLE.maxSteer);
  const curvature = Math.abs(Math.tan(steer)) / car.spec.wheelbase;
  return { steer, targetSpeed: Math.min(car.maxSpeed, pace, Math.sqrt(6 / Math.max(.008, curvature))) };
}

export function trackGtaPatrolProgress(world, car, command, moved) {
  const ai = car.gtaAI;
  if (isGtaStationary(car) || car.aiState === "RECOVER") return;
  ai.stuckTicks = command.targetSpeed > .5 && moved / STEP < .5 ? ai.stuckTicks + 1 : 0;
  if (ai.stuckTicks <= STUCK_TICKS) return;
  ai.resumeState = car.aiState;
  ai.recoverUntil = world.tick + 1 + RECOVER_TICKS;
  ai.counterSteer = -.24 * (Math.sign(car.steer) || (ai.order % 2 ? 1 : -1));
  ai.stuckTicks = 0;
  ai.commitUntil = null;
  car.aiState = "RECOVER";
}

function routeCommand(world, car, aim, pace, planRoute, steerBias) {
  const ai = car.gtaAI;
  if (world.tick >= ai.nextPlan) {
    ai.nextPlan = world.tick + (car.path.length ? 48 : 65) + Math.floor(car.phase * 17);
    if (!planRoute(world, car, aim)) {
      car.path = [];
      car.cursor = 0;
    }
  }
  if (car.path.length > 1) {
    const command = followPath(car, car.path, car.cursor);
    car.cursor = command.cursor;
    if (command.remaining >= 1.5) return {
      steer: clamp(command.steer + steerBias, -VEHICLE.maxSteer, VEHICLE.maxSteer),
      targetSpeed: Math.min(pace, car.maxSpeed, Math.max(2, command.targetSpeed * 1.25)),
    };
    car.path = [];
    ai.nextPlan = world.tick + 1;
  }
  const next = gtaOffset(car, 3);
  const aligned = Math.abs(angleDelta(headingTo(car, aim), car.heading)) < 1;
  return pointOnRoad(next, world.drivingRoads) && aligned
    ? directCommand(car, aim, Math.min(3.2, pace), steerBias) : { steer: 0, targetSpeed: 0 };
}

/** Targets use the last accepted sighting, not a reconstruction from rendered pixels. */
export function gtaPatrolCommand(world, car, planRoute, canDriveDirect, steerBias) {
  const { pursuit: s, tick } = world, { config } = s.gta, ai = car.gtaAI;
  if (car.aiState === "RECOVER") {
    if (tick < ai.recoverUntil) return { steer: ai.counterSteer, targetSpeed: -2.35, reason: "RECOVER" };
    car.aiState = ai.resumeState;
    car.path = [];
    ai.nextPlan = 0;
  }
  const seen = s.response.sightedBy.has(car);
  const report = s.response.lastSeen ?? s.playerStart;
  const range = distance(car, report), rel = gtaLocal(report, car);
  const pace = Math.min(car.maxSpeed, Math.max(5.5, Math.abs(report.speed) + 2.8 + range * .15) * config.npcSpeedMultiplier);
  let state, aim, command;
  if (!seen) {
    ai.commitUntil = null;
    state = s.gta.lostTicks >= 75 || range < 7 ? "SEARCH" : "APPROACH";
    const sector = (ai.order + Math.floor(s.gta.lostTicks / 210)) % 4;
    aim = state === "SEARCH" ? gtaOffset(report, sector < 2 ? 13 : -13, sector % 2 ? 9 : -9) : report;
  } else {
    const lead = clamp(report.speed * clamp(.35 + range * .015, .35, 1.1), -12, 12);
    state = "PURSUIT";
    aim = gtaOffset(report, lead);
    if (s.wantedLevel >= 3 && car.squadRole === "FLANKER") {
      state = "FLANK";
      aim = gtaOffset(report, lead + 2, car.squadSide * 4.2);
    } else if (s.wantedLevel >= 3 && car.squadRole === "INTERCEPTOR") {
      state = "BLOCK_INTERCEPT";
      aim = gtaOffset(report, clamp(lead + 12, 11, 23), car.squadSide * 2.6);
      if (rel.forward > 6 && distance(car, aim) < 5.5) {
        const inward = angleDelta(headingTo(car, report), car.heading);
        command = { steer: clamp(inward, -.55, .55), targetSpeed: distance(car, aim) < 2.8 ? 0 : 1.8 };
      }
    } else if (s.wantedLevel >= 3 && car.squadRole === "SUPPORT") {
      aim = gtaOffset(report, lead - (4 + ai.order % 4 * 3), (ai.order % 2 ? 1 : -1) * 2.5);
    }
    const pit = config.enablePitManeuver && s.wantedLevel >= 2 && car.unitType !== "swat" &&
      car.squadRole === "PRIMARY_CHASER" && report.speed > 2.8 &&
      rel.forward >= -4.5 && rel.forward < -.5 && Math.abs(rel.right) > 1.2 && Math.abs(rel.right) < 4.8 &&
      Math.abs(car.speed - report.speed) < 4.5 && Math.abs(angleDelta(report.heading, car.heading)) < .57;
    const ramAim = gtaOffset(report, clamp(report.speed * .28, -3, 5));
    const ram = config.enableRamming && s.wantedLevel >= 4 &&
      (car.unitType === "swat" || (s.wantedLevel === 5 && car.squadRole !== "PRIMARY_CHASER")) &&
      car.speed >= 5 && range <= 19 && rel.forward < 3 &&
      Math.abs(angleDelta(headingTo(car, ramAim), car.heading)) < .48 && canDriveDirect(world, car, ramAim, true);
    if (pit) {
      state = "PIT_MANEUVER";
      aim = gtaOffset(report, Math.max(2.5, report.speed * .48), Math.sign(rel.right) * .28);
      command = directCommand(car, aim, report.speed + 3);
    } else if (ai.commitUntil > tick || (ram && tick >= (ai.nextRam ?? 0))) {
      if (!(ai.commitUntil > tick)) {
        ai.commitUntil = tick + 38;
        ai.nextRam = tick + 105;
        ai.ramAim = ramAim;
      }
      if (canDriveDirect(world, car, ai.ramAim, true)) {
        state = "RAM";
        command = directCommand(car, ai.ramAim, car.maxSpeed);
      } else ai.commitUntil = null;
    }
    if (!command && canDriveDirect(world, car, aim)) {
      if (car.path.length) {
        car.path = [];
        car.cursor = 0;
        ai.nextPlan = 0;
      }
      command = directCommand(car, aim, pace, steerBias);
    }
  }
  if (!command) {
    if (ai.routeState !== state) {
      car.path = [];
      car.cursor = 0;
      ai.nextPlan = 0;
      ai.routeState = state;
    }
    command = routeCommand(world, car, aim, pace, planRoute, steerBias);
  }
  car.aiState = state;
  return { ...command, reason: state };
}

export function emitGtaEvent(world, type, fields) {
  const { pursuit } = world;
  pursuit.stepEvents.push({ type, tick: pursuit.gta.eventTick, ...fields });
}

export function integrateGtaSlip(actor, next) {
  const slip = actor.gtaSlipMps * Math.exp(-3.8 * STEP);
  const yaw = actor.gtaYawRate * Math.exp(-3 * STEP);
  next.x += Math.cos(next.heading) * slip * STEP;
  next.z -= Math.sin(next.heading) * slip * STEP;
  next.heading += yaw * STEP;
  next.gtaSlipMps = slip;
  next.gtaYawRate = yaw;
}

export function isGtaStationary(actor) {
  return actor.aiState === "WRECKED" || actor.aiState === "ROADBLOCK";
}

function mass(actor) {
  return actor.gtaMassKg ?? (actor.type === "static" ? Infinity : actor.type === "pedestrian"
    ? actor.body?.massKg ?? 75 : actor.kind === "tuktuk" ? 620 : 1450);
}

export function gtaVelocity(actor, heading = actor.heading) {
  const speed = actor.speed ?? 0, slip = actor.gtaSlipMps ?? 0;
  const s = Math.sin(heading ?? 0), c = Math.cos(heading ?? 0);
  return { x: s * speed + c * slip, z: c * speed - s * slip };
}

function velocityAtContact(motion, pose) {
  if (motion.impulse) return gtaVelocity(motion.impulse, pose.heading);
  if (motion.stop < 1 || isGtaStationary(motion.a)) return { x: 0, z: 0 };
  return gtaVelocity(motion.next, pose.heading);
}

function leverArm(pose, other) {
  const dx = other.x - pose.x, dz = other.z - pose.z;
  const sin = Math.sin(pose.heading), cos = Math.cos(pose.heading);
  return {
    lateral: clamp(dx * cos - dz * sin, -pose.width / 2, pose.width / 2),
    forward: clamp(dx * sin + dz * cos, -pose.length / 2, pose.length / 2),
  };
}

function shove(motion, pose, velocity, arm, nx, nz, delta, pit) {
  const actor = motion.a;
  if (isGtaStationary(actor)) return;
  const sin = Math.sin(pose.heading), cos = Math.cos(pose.heading);
  const forward = delta * (nx * sin + nz * cos), lateral = delta * (nx * cos - nz * sin);
  const spin = (arm.forward * lateral - arm.lateral * forward) / (actor.length ** 2 / 8);
  motion.impulse = {
    speed: clamp(velocity.x * sin + velocity.z * cos + forward, -(actor.spec?.reverseSpeed ?? VEHICLE.reverseSpeed) * 2, actor.maxSpeed + 5),
    gtaSlipMps: clamp(velocity.x * cos - velocity.z * sin + lateral, -GTA_SLIP_LIMIT, GTA_SLIP_LIMIT),
    gtaYawRate: clamp((motion.impulse?.gtaYawRate ?? motion.next.gtaYawRate ?? 0) +
      spin * (pit ? 2.6 : 1), -GTA_YAW_LIMIT, GTA_YAW_LIMIT),
  };
}

function damage(world, motion, other, closingSpeed, share) {
  const actor = motion.a;
  if (actor.health <= 0) return 0;
  const damage = Math.min(actor.health, Math.max(0, closingSpeed - .65) ** 1.45 * share * 1.55);
  actor.health -= damage;
  if (actor.health <= 0 && world.pursuit.patrols.has(actor)) {
    actor.aiState = "WRECKED";
    actor.wreckUntilTick = world.pursuit.gta.eventTick + Math.ceil(world.pursuit.gta.config.wreckSeconds / STEP);
    actor.path = [];
    actor.cursor = 0;
    motion.impulse = { speed: 0, gtaSlipMps: 0, gtaYawRate: 0 };
    emitGtaEvent(world, "patrol_wrecked", { unitType: actor.unitType, causedByPlayer: other === world.player });
    if (other === world.player) world.pursuit.gta.heat += 1;
  }
  return damage;
}

// The shared swept solver still owns accepted positions. Only GTA bodies
// retain the impulse velocity for the next fixed step.
export function applyGtaContact(world, a, b, pa, pb, normal, sweptClosing, fresh) {
  const { player, pursuit } = world;
  const ownedA = a.a === player || pursuit.patrols.has(a.a);
  const ownedB = b.a === player || pursuit.patrols.has(b.a);
  if (!ownedA && !ownedB) return;
  const va = velocityAtContact(a, pa), vb = velocityAtContact(b, pb);
  const { x, z } = normal;
  const closingSpeed = Math.max(0, sweptClosing, (va.x - vb.x) * x + (va.z - vb.z) * z);
  const other = a.a === player ? b.a : b.a === player ? a.a : null;
  const patrol = other && pursuit.patrols.has(other);
  const egoPose = a.a === player ? pa : pb, otherPose = a.a === player ? pb : pa;
  const egoArm = other ? leverArm(egoPose, otherPose) : null;
  const isPit = Boolean(patrol && other.aiState === "PIT_MANEUVER" && pursuit.gta.config.enablePitManeuver &&
    closingSpeed > .65 && egoArm.forward < -egoPose.length * .14 &&
    Math.abs(x * Math.cos(egoPose.heading) - z * Math.sin(egoPose.heading)) > .65);
  const ma = mass(a.a), mb = mass(b.a);
  const shareA = Number.isFinite(mb) ? mb / (ma + mb) : 1;
  const shareB = Number.isFinite(ma) ? ma / (ma + mb) : 1;
  const invA = isGtaStationary(a.a) ? 0 : 1 / ma, invB = isGtaStationary(b.a) ? 0 : 1 / mb;
  if (closingSpeed > 0 && invA + invB > 0) {
    const impulse = Math.min(42, closingSpeed) * (isPit ? 1.38 : 1.17) / (invA + invB);
    if (ownedA) shove(a, pa, va, leverArm(pa, pb), x, z, -impulse * invA, isPit && a.a === player);
    if (ownedB) shove(b, pb, vb, leverArm(pb, pa), x, z, impulse * invB, isPit && b.a === player);
  }
  const damageA = ownedA ? damage(world, a, b.a, closingSpeed, shareA) : 0;
  const damageB = ownedB ? damage(world, b, a.a, closingSpeed, shareB) : 0;
  if (!other || !(fresh || damageA > 0 || damageB > 0)) return;
  if (fresh && other.gtaRoadblock && closingSpeed > 1) pursuit.gta.heat += .55;
  const damageToPlayer = a.a === player ? damageA : damageB;
  if (patrol) emitGtaEvent(world, "patrol_collision", {
    unitType: other.unitType, closingSpeed, damageToPlayer,
    damageToPatrol: a.a === player ? damageB : damageA, isPit,
  });
  else emitGtaEvent(world, "static_or_civilian_hit", {
    kind: other.gtaRoadblock ? "roadblock" : other.type === "pedestrian" ? "pedestrian" : other.kind ?? other.type,
    closingSpeed, damageToPlayer,
  });
}

export function updateGtaPhase(world) {
  const { player, pursuit: s } = world, { gta, response, metrics } = s;
  const nearby = [...response.closePatrols].filter(unit => unit.aiState !== "WRECKED");
  const boxed = nearby.some((a, i) => nearby.slice(i + 1).some(b => {
    const dot = (a.x - player.x) * (b.x - player.x) + (a.z - player.z) * (b.z - player.z);
    return dot <= .5 * distance(a, player) * distance(b, player);
  }));
  gta.pinnedTicks = Math.hypot(player.speed, player.gtaSlipMps) < .8 && boxed
    ? Math.min(PIN_TICKS, gta.pinnedTicks + 1) : 0;
  metrics.capturePressureS = gta.pinnedTicks * STEP;
  emitGtaEvent(world, "pinned_progress", { ratio: gta.pinnedTicks / PIN_TICKS });

  const from = s.wantedLevel;
  if (response.unitsInContact) gta.heat += STEP / (13 + (from - 1) * 2);
  if (gta.heat >= 1 && from < gta.config.wantedLevelMax) {
    s.wantedLevel++;
    gta.heat -= 1;
    gta.lostTicks = 0;
    gta.fadeStars = s.wantedLevel;
    gta.nextDispatchTick = Math.min(gta.nextDispatchTick, world.tick);
    gta.nextRoadblockTick = Math.min(gta.nextRoadblockTick, world.tick);
  }
  if (s.wantedLevel === gta.config.wantedLevelMax) gta.heat = 0;
  if (response.unitsInContact) {
    gta.lostTicks = 0;
    gta.fadeStars = s.wantedLevel;
    response.clearProgress = 0;
  } else {
    gta.lostTicks++;
    const fading = Math.max(0, gta.lostTicks - LOST_GRACE_TICKS);
    if (fading) {
      s.wantedLevel = Math.max(0, gta.fadeStars - Math.floor(fading / FADE_TICKS));
      response.stage = "clearing";
      if (s.wantedLevel < from) gta.heat = 0;
    } else response.stage = "search";
    response.clearProgress = clamp(fading / (FADE_TICKS * Math.max(1, gta.fadeStars)), 0, 1);
  }
  if (s.wantedLevel !== from) emitGtaEvent(world, "wanted_changed", { from, to: s.wantedLevel });
  if (player.health <= 0) s.phase = "wrecked";
  else if (gta.pinnedTicks >= PIN_TICKS) s.phase = "busted";
  else if (s.wantedLevel === 0) {
    s.phase = "escaped";
    metrics.escape = true;
  } else if (metrics.survivalS >= gta.config.episodeMaxSeconds) s.phase = "timeout";
}
