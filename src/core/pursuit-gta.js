import { STEP, VEHICLE, clamp } from "./config.js";
import { angleDelta, distance, overlaps, pointOnRoad, sweepSafe } from "./geometry.js";
import {
  AGGRESSIVE_CHASE_PRESENCE, aggressivePatrolPace, isAggressiveChase,
} from "./pako-aggressive-police.js";
import { METRO_CITY_CURBS, METRO_CURB_SUPPORT, sweepSafeWithCurbs } from "./pako-curb.js";
import { PATROL_CHAIN_YIELD, PATROL_LATERAL_YIELD } from "./pako-patrol-yield.js";
import {
  TACTICAL_PURSUIT_MODE, canPatrolUseCurbPrivilege, isTacticalPursuit,
  selectTacticalSearchTarget, tacticalPatrolSpec,
} from "./pako-tactical-police.js";
import {
  DEFAULT_SURVEILLANCE_ZONES, DISPATCH_RULESET, createDispatchResponse, isDispatchTracked,
  resolveSurveillanceZones, updateDispatchEscape,
} from "./pursuit-dispatch.js";
import { PLAYER_VEHICLE } from "./vehicle-spec.js";
import { followPath, integrateVehicle, vehicleProbe } from "./vehicle.js";

export const GtaChaseConfig = Object.freeze({
  wantedLevelStart: 1, wantedLevelMax: 5, maxActivePatrols: 12, npcSpeedMultiplier: 1,
  enablePitManeuver: true, enableRamming: true, enableRoadblocks: true, enableSwat: true,
  playerMaxHealth: 100, episodeMaxSeconds: 120, minSpawnRadius: 16, wreckSeconds: 8,
});

export const GTA_MAX_SPEED = 28;
export const GTA_PIN_SECONDS = 2.2;
export const CIVILIAN_MOTION_PREVIEW = "visible-motion-v2";
export const CIVILIAN_TIMED_YIELD = "timed-stop-reserve-v4";
export const PATROL_TRAFFIC_PREVIEW = "visible-traffic-v1";
export const DISPATCH_DAMAGE_FEEDBACK = "accepted-contact-v1";
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
const DISPATCH_LIGHT_PACE = Object.freeze({
  patrol: Object.freeze({ speed: 31.6, acceleration: 4.5 }),
  interceptor: Object.freeze({ speed: 33, acceleration: 5.2 }),
});
const DISPATCH_LIGHT_CAP = 34.1;
const PURSUIT_LATERAL_ACCEL = 6;
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
    if (!Object.hasOwn(GtaChaseConfig, key) &&
        !["ruleset", "surveillanceZones", "civilianCrossingPreview", "patrolTrafficPreview", "damageFeedback", "curbSupport",
          "patrolChainYield", "chasePresence", "tacticalPursuit"].includes(key))
      throw new TypeError(`Unknown GTA chase config field: ${key}`);
  const config = { ...GtaChaseConfig, wantedLevelStart: level, ...options };
  if (Object.hasOwn(config, "ruleset") && config.ruleset !== "legacy" && config.ruleset !== DISPATCH_RULESET)
    throw new RangeError("Unknown GTA chase ruleset");
  if (config.ruleset === DISPATCH_RULESET) {
    config.surveillanceZones = Object.hasOwn(config, "surveillanceZones")
      ? resolveSurveillanceZones(config.surveillanceZones) : DEFAULT_SURVEILLANCE_ZONES;
  } else if (Object.hasOwn(config, "surveillanceZones"))
    throw new TypeError(`surveillanceZones requires ruleset "${DISPATCH_RULESET}"`);
  if (Object.hasOwn(config, "civilianCrossingPreview") &&
      (config.ruleset !== DISPATCH_RULESET || (typeof config.civilianCrossingPreview !== "boolean" &&
        ![CIVILIAN_MOTION_PREVIEW, CIVILIAN_TIMED_YIELD].includes(config.civilianCrossingPreview))))
    throw new TypeError(`civilianCrossingPreview requires a boolean, "${CIVILIAN_MOTION_PREVIEW}" or "${CIVILIAN_TIMED_YIELD}" and ruleset "${DISPATCH_RULESET}"`);
  if (Object.hasOwn(config, "patrolTrafficPreview") &&
      (config.ruleset !== DISPATCH_RULESET || config.patrolTrafficPreview !== PATROL_TRAFFIC_PREVIEW))
    throw new TypeError(`patrolTrafficPreview requires "${PATROL_TRAFFIC_PREVIEW}" and ruleset "${DISPATCH_RULESET}"`);
  if (Object.hasOwn(config, "damageFeedback") &&
      (config.ruleset !== DISPATCH_RULESET || config.damageFeedback !== DISPATCH_DAMAGE_FEEDBACK))
    throw new TypeError(`damageFeedback requires "${DISPATCH_DAMAGE_FEEDBACK}" and ruleset "${DISPATCH_RULESET}"`);
  if (Object.hasOwn(config, "curbSupport") &&
      (config.ruleset !== DISPATCH_RULESET || ![METRO_CURB_SUPPORT, METRO_CITY_CURBS].includes(config.curbSupport)))
    throw new TypeError(`curbSupport requires "${METRO_CURB_SUPPORT}" or "${METRO_CITY_CURBS}" and ruleset "${DISPATCH_RULESET}"`);
  if (Object.hasOwn(config, "chasePresence") &&
      (config.ruleset !== DISPATCH_RULESET || config.chasePresence !== AGGRESSIVE_CHASE_PRESENCE))
    throw new TypeError(`chasePresence requires "${AGGRESSIVE_CHASE_PRESENCE}" and ruleset "${DISPATCH_RULESET}"`);
  if (Object.hasOwn(config, "tacticalPursuit") &&
      (config.ruleset !== DISPATCH_RULESET || config.tacticalPursuit !== TACTICAL_PURSUIT_MODE))
    throw new TypeError(`tacticalPursuit requires "${TACTICAL_PURSUIT_MODE}" and ruleset "${DISPATCH_RULESET}"`);
  if (Object.hasOwn(config, "patrolChainYield") &&
      (config.ruleset !== DISPATCH_RULESET || ![PATROL_CHAIN_YIELD, PATROL_LATERAL_YIELD].includes(config.patrolChainYield)))
    throw new TypeError(`patrolChainYield requires "${PATROL_CHAIN_YIELD}" or "${PATROL_LATERAL_YIELD}" and ruleset "${DISPATCH_RULESET}"`);
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
  const dispatch = config.ruleset === DISPATCH_RULESET;
  state.wantedLevel = config.wantedLevelStart;
  state.stepEvents = [];
  state.gta = {
    config, normalMaxSpeed: player.maxSpeed, serial: 0, pinnedTicks: 0,
    fadeStars: dispatch ? state.wantedLevel : 0, lostTicks: 0,
    roadblock: null, heat: 0, nextDispatchTick: 0, nextRoadblockTick: 0, nextSquadTick: 0,
  };
  if (dispatch) state.response.dispatch = createDispatchResponse();
}

export function initializeGtaDurability(actor, maxHealth, massKg) {
  Object.assign(actor, { health: maxHealth, maxHealth, gtaMassKg: massKg, gtaSlipMps: 0, gtaYawRate: 0 });
}

export function initializeGtaPatrol(car, unitType, state) {
  const profile = GTA_PATROL_PROFILES[unitType];
  const { config } = state.gta;
  const tactical = isTacticalPursuit(state);
  const faster = config.ruleset === DISPATCH_RULESET && DISPATCH_LIGHT_PACE[unitType];
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
  if (tactical) {
    const spec = tacticalPatrolSpec(unitType, state.wantedLevel, config.npcSpeedMultiplier);
    car.spec = {
      acceleration: spec.acceleration,
      braking: spec.braking,
      steerRate: spec.steerRate,
      wheelbase: spec.wheelbase,
      reverseSpeed: spec.reverseSpeed,
      realisticDynamics: true,
    };
    car.maxSpeed = spec.maxSpeed;
  } else {
    car.spec = { acceleration: faster?.acceleration ?? profile.acceleration, steerRate: profile.steerRate,
      wheelbase: unitType === "swat" ? 3.15 : VEHICLE.wheelbase };
    car.maxSpeed = faster ? Math.min(DISPATCH_LIGHT_CAP, faster.speed * config.npcSpeedMultiplier)
      : profile.speed * config.npcSpeedMultiplier;
  }
  car.gtaAI = { order: state.gta.serial, nextPlan: tactical ? (state.gta.serial % 12) : 0, stuckTicks: 0, behindTicks: 0 };
  initializeGtaDurability(car, profile.health, profile.mass);
}

export function refreshTacticalPatrolSpecs(state) {
  if (!isTacticalPursuit(state)) return;
  const mult = state.gta.config.npcSpeedMultiplier;
  for (const car of state.patrols) {
    if (car.aiState === "WRECKED") continue;
    const spec = tacticalPatrolSpec(car.unitType, state.wantedLevel, mult);
    car.spec = { ...car.spec, acceleration: spec.acceleration, braking: spec.braking,
      steerRate: spec.steerRate, reverseSpeed: spec.reverseSpeed };
    car.maxSpeed = spec.maxSpeed;
  }
}

export function gtaOffset(from, forward, right = 0) {
  const sin = Math.sin(from.heading), cos = Math.cos(from.heading);
  return { x: from.x + forward * sin + right * cos, z: from.z + forward * cos - right * sin };
}

export function gtaLocal(from, to) {
  const dx = to.x - from.x, dz = to.z - from.z, sin = Math.sin(from.heading), cos = Math.cos(from.heading);
  return { forward: dx * sin + dz * cos, right: dx * cos - dz * sin };
}

function directCommand(car, aim, pace, steerBias = 0, dispatch = false, lateralAccel = PURSUIT_LATERAL_ACCEL) {
  const error = angleDelta(headingTo(car, aim), car.heading);
  const steer = clamp(error * .91 + steerBias, -VEHICLE.maxSteer, VEHICLE.maxSteer);
  const curvature = Math.abs(Math.tan(steer)) / car.spec.wheelbase;
  const curveSpeed = Math.sqrt(lateralAccel / (dispatch ? curvature : Math.max(.008, curvature)));
  return { steer, targetSpeed: Math.min(car.maxSpeed, pace, curveSpeed) };
}

function recoveryBlockers(world, car) {
  const { player, pursuit } = world;
  const localStatics = world.statics.filter(s => {
    const span = ((s.width ?? 0) + (s.length ?? 0)) * 0.5 + 9;
    return Math.abs(s.x - car.x) <= span && Math.abs(s.z - car.z) <= span;
  });
  const blockers = localStatics.concat(world.actorIndex.near(car, 9)
    .filter(body => body !== car && body !== player));
  if (isDispatchTracked(pursuit.response)) {
    blockers.push({ ...vehicleProbe(player, 0), ...pursuit.response.lastSeen });
  }
  return blockers;
}

function projectRecovery(world, car, command, steps, blockers) {
  const aggressive = isAggressiveChase(world.pursuit);
  const closeNonPed = aggressive
    ? blockers.filter(b => b.type !== "pedestrian" && overlaps(car, b, .15))
    : [];
  const strictBlockers = closeNonPed.length
    ? blockers.filter(b => !closeNonPed.includes(b))
    : blockers;
  const curbPrivilege = canPatrolUseCurbPrivilege(world, car);
  let pose = { ...vehicleProbe(car, car.speed), gtaSlipMps: car.gtaSlipMps, gtaYawRate: car.gtaYawRate };
  for (let i = 0; i < steps; i++) {
    const next = integrateVehicle(pose, command, STEP);
    integrateGtaSlip(pose, next);
    const supported = curbPrivilege
      ? sweepSafeWithCurbs(pose, next, strictBlockers, world.roads, world.pursuit.gta.curb).safe
      : sweepSafe(pose, next, strictBlockers, world.roads).safe;
    if (!supported) return null;
    for (const close of closeNonPed) {
      if (overlaps(next, close) || distance(next, close) < distance(pose, close) - .002)
        return null;
    }
    pose = next;
  }
  return pose;
}

function chooseDispatchRecovery(world, car) {
  const blockers = recoveryBlockers(world, car);
  const aggressive = isAggressiveChase(world.pursuit);
  const speeds = aggressive ? [-3.8, -2.35, 2.8] : [2.8, -2.35];
  const steers = aggressive ? [0, -.65, .65, -.35, .35] : [0, -.5, .5];
  const nearPlayer = aggressive && distance(car, world.player) < 5.4;
  let best = null, bestScore = -Infinity;
  for (const targetSpeed of speeds) for (const steer of steers) {
    const command = { steer, targetSpeed, reason: "RECOVER" };
    const pose = projectRecovery(world, car, command, RECOVER_TICKS, blockers);
    if (!pose) continue;
    let alignment = 0;
    for (const road of world.drivingRoads) {
      if (road.parkingBay || road.supportApron || !pointOnRoad(pose, [road])) continue;
      const direction = road.axis === "x" ? Math.sin(pose.heading) : Math.cos(pose.heading);
      alignment = Math.max(alignment, road.flow ? direction * road.flow : Math.abs(direction));
    }
    const unpinBonus = nearPlayer ? (distance(pose, world.player) - distance(car, world.player)) * 2.5 : 0;
    // Prefer a small move that restores a forward road heading; the normal
    // pursuit planner chooses the route again after this bounded adjustment.
    const score = alignment * 4 + distance(car, pose) * .2 + unpinBonus + (targetSpeed > 0 && !nearPlayer ? .08 : 0);
    if (score > bestScore) { best = command; bestScore = score; }
  }
  return best;
}

function usesCheckedRecovery(pursuit) {
  return Boolean(pursuit.response.dispatch) && (pursuit.wantedLevel >= 3 || isAggressiveChase(pursuit));
}

export function trackGtaPatrolProgress(world, car, command, moved) {
  const ai = car.gtaAI;
  if (isGtaStationary(car) || car.aiState === "RECOVER") return;
  const { pursuit } = world;
  const aggressive = isAggressiveChase(pursuit);
  const checked = usesCheckedRecovery(pursuit);
  const noRoute = checked && command.needsTrackedRecovery && isDispatchTracked(pursuit.response);
  const stuckLimit = aggressive ? Math.round(.38 / STEP) : STUCK_TICKS;
  ai.stuckTicks = (command.targetSpeed > .5 || noRoute) && moved / STEP < .5 ? ai.stuckTicks + 1 : 0;
  if (ai.stuckTicks <= stuckLimit) return;
  ai.stuckTicks = 0;
  ai.checkedRecovery = checked ? chooseDispatchRecovery(world, car) : null;
  if (checked && !ai.checkedRecovery) return;
  ai.resumeState = car.aiState;
  ai.recoverUntil = world.tick + 1 + RECOVER_TICKS;
  ai.counterSteer = -.24 * (Math.sign(car.steer) || (ai.order % 2 ? 1 : -1));
  ai.commitUntil = null;
  car.aiState = "RECOVER";
}

function dispatchPathCommand(car, pace, steerBias, arrivalSpeed, lateralAccel = PURSUIT_LATERAL_ACCEL) {
  const { path } = car;
  const follow = followPath(car, path, car.cursor, true);
  const steer = clamp(follow.steer + steerBias, -VEHICLE.maxSteer, VEHICLE.maxSteer);
  const curvature = Math.abs(Math.tan(steer)) / car.spec.wheelbase;
  let targetSpeed = Math.min(car.maxSpeed, pace, Math.sqrt(lateralAccel / curvature));
  const braking = car.spec.braking ?? VEHICLE.braking;
  const margin = 2;
  const horizon = margin + targetSpeed ** 2 / (2 * braking);
  let remaining = 0;
  // Keep the plant's path steering, but plan pace in metres ahead of the car
  // rather than inheriting the civilian follower's straight-line speed ceiling.
  for (let i = follow.cursor; i < path.length - 1; i++) {
    const a = path[i], b = path[i + 1], dx = b.x - a.x, dz = b.z - a.z;
    const length = Math.hypot(dx, dz);
    if (!length) continue;
    const used = i === follow.cursor
      ? clamp(((car.x - a.x) * dx + (car.z - a.z) * dz) / length, 0, length) : 0;
    remaining += length - used;
    if (remaining > horizon) break;
    const c = path[i + 2];
    const available = 2 * braking * Math.max(0, remaining - margin);
    if (!c) {
      // Replanning to a moving report is not a request to stop at the old waypoint.
      targetSpeed = Math.min(targetSpeed, Math.sqrt(arrivalSpeed ** 2 + available));
    } else {
      const nextLength = distance(b, c);
      const bend = Math.abs(angleDelta(headingTo(b, c), headingTo(a, b))) /
        Math.max(.1, (length + nextLength) / 2);
      if (bend > .003)
        targetSpeed = Math.min(targetSpeed, Math.sqrt(lateralAccel / bend + available));
    }
  }
  return { cursor: follow.cursor, remaining, steer, targetSpeed };
}

function routeCommand(world, car, aim, pace, planRoute, steerBias, dispatchArrivalSpeed = null, tracked = false) {
  const ai = car.gtaAI;
  const tactical = isTacticalPursuit(world.pursuit);
  const lateralAccel = tactical ? 8.8 : PURSUIT_LATERAL_ACCEL;
  const fastReplan = tactical && (world.pursuit.response?.sightedBy?.has(car) || distance(car, aim) < 68);
  if (world.tick >= ai.nextPlan) {
    const gta = world.pursuit.gta;
    if (tactical && world._routePlanTick === world.tick && world._routePlanCount >= 2) {
      ai.nextPlan = world.tick + 1 + (ai.order % 4);
    } else {
      if (tactical) {
        if (world._routePlanTick !== world.tick) {
          world._routePlanTick = world.tick;
          world._routePlanCount = 0;
        }
        world._routePlanCount++;
      }
      ai.nextPlan = world.tick + (tactical
        ? (car.path.length ? (fastReplan ? 22 : 48) : 24) + Math.floor(car.phase * 12)
        : (car.path.length ? 48 : 65) + Math.floor(car.phase * 17));
      if (!planRoute(world, car, aim)) {
        car.path = [];
        car.cursor = 0;
      }
    }
  }
  if (car.path.length > 1) {
    if (dispatchArrivalSpeed !== null) {
      const { cursor, remaining, steer, targetSpeed } = dispatchPathCommand(car, pace, steerBias, dispatchArrivalSpeed, lateralAccel);
      car.cursor = cursor;
      if (remaining >= 1.5) return { steer, targetSpeed };
    } else {
      const command = followPath(car, car.path, car.cursor);
      car.cursor = command.cursor;
      if (command.remaining >= 1.5) return {
        steer: clamp(command.steer + steerBias, -VEHICLE.maxSteer, VEHICLE.maxSteer),
        targetSpeed: Math.min(pace, car.maxSpeed, Math.max(2, command.targetSpeed * 1.25)),
      };
    }
    car.path = [];
    ai.nextPlan = world.tick + 1;
  }
  const next = gtaOffset(car, 3);
  const aligned = Math.abs(angleDelta(headingTo(car, aim), car.heading)) < 1;
  return pointOnRoad(next, world.drivingRoads) && aligned
    ? directCommand(car, aim, Math.min(tactical ? 12 : 3.2, pace), steerBias, dispatchArrivalSpeed !== null, lateralAccel)
    : { steer: 0, targetSpeed: 0, ...(dispatchArrivalSpeed !== null && tracked ? { needsTrackedRecovery: true } : {}) };
}

/** Targets use the last accepted sighting, not a reconstruction from rendered pixels. */
export function gtaPatrolCommand(world, car, planRoute, canDriveDirect, steerBias) {
  const { pursuit: s, tick } = world, { config } = s.gta, ai = car.gtaAI;
  const tactical = isTacticalPursuit(s);
  const lateralAccel = tactical ? 8.8 : PURSUIT_LATERAL_ACCEL;
  if (car.aiState === "RECOVER") {
    if (tick < ai.recoverUntil) {
      if (!ai.checkedRecovery) return { steer: ai.counterSteer, targetSpeed: -2.35, reason: "RECOVER" };
      return projectRecovery(world, car, ai.checkedRecovery, 6, recoveryBlockers(world, car))
        ? ai.checkedRecovery : { steer: 0, targetSpeed: 0, reason: "RECOVER" };
    }
    car.aiState = ai.resumeState;
    ai.checkedRecovery = null;
    car.path = [];
    ai.nextPlan = 0;
  }
  const seen = s.response.sightedBy.has(car);
  const dispatch = Boolean(s.response.dispatch);
  const tracked = dispatch ? isDispatchTracked(s.response) : seen;
  if (dispatch && !s.response.lastSeen) {
    ai.commitUntil = null;
    car.aiState = "SEARCH";
    return { steer: 0, targetSpeed: 0, reason: "SEARCH" };
  }
  const report = s.response.lastSeen ?? s.playerStart;
  const range = distance(car, report), rel = gtaLocal(report, car);
  const reportSpeed = Math.abs(report.speed);
  const pace = (isAggressiveChase(s) || tactical) && tracked
    ? aggressivePatrolPace(s, car, reportSpeed, range)
    : tactical && !tracked
      ? Math.min(car.maxSpeed, 25.5 * config.npcSpeedMultiplier)
      : Math.min(car.maxSpeed, Math.max(5.5,
        (dispatch && tracked ? reportSpeed * 1.14 : reportSpeed) + 2.8 + range * .15) * config.npcSpeedMultiplier);
  let state, aim, command;
  if (!seen) ai.commitUntil = null;
  if (!tracked) {
    const searching = dispatch ? s.response.dispatch.state !== "LAST_KNOWN" : s.gta.lostTicks >= 75;
    state = searching || range < 7 ? "SEARCH" : "APPROACH";
    if (tactical && state === "SEARCH" && s.response.lastSeen) {
      aim = selectTacticalSearchTarget(world, car, report, ai.order);
    } else {
      const sector = (ai.order + Math.floor(s.gta.lostTicks / 210)) % 4;
      aim = state === "SEARCH" ? gtaOffset(report, sector < 2 ? 13 : -13, sector % 2 ? 9 : -9) : report;
    }
  } else {
    const lead = tactical
      ? clamp(report.speed * clamp(.40 + range * .017, .38, 1.32), -14, 22)
      : clamp(report.speed * clamp(.35 + range * .015, .35, 1.1), -12, 12);
    const roleMinStar = tactical ? 2 : 3;
    state = "PURSUIT";
    aim = gtaOffset(report, lead);
    if (s.wantedLevel >= roleMinStar && car.squadRole === "FLANKER") {
      state = "FLANK";
      aim = gtaOffset(report, lead + 2, car.squadSide * 4.2);
    } else if (s.wantedLevel >= roleMinStar && car.squadRole === "INTERCEPTOR") {
      state = "BLOCK_INTERCEPT";
      aim = gtaOffset(report, clamp(lead + 12, 11, 24), car.squadSide * 2.6);
      if (rel.forward > 6 && distance(car, aim) < 5.5) {
        const inward = angleDelta(headingTo(car, report), car.heading);
        command = { steer: clamp(inward, -.55, .55), targetSpeed: distance(car, aim) < 2.8 ? 0 : 1.8 };
      }
    } else if (s.wantedLevel >= roleMinStar && car.squadRole === "SUPPORT") {
      aim = gtaOffset(report, lead - (4 + ai.order % 4 * 3), (ai.order % 2 ? 1 : -1) * 2.5);
    }
    const pit = seen && config.enablePitManeuver && s.wantedLevel >= 2 && car.unitType !== "swat" &&
      car.squadRole === "PRIMARY_CHASER" && report.speed > 2.8 &&
      rel.forward >= -4.5 && rel.forward < -.5 && Math.abs(rel.right) > 1.2 && Math.abs(rel.right) < 4.8 &&
      Math.abs(car.speed - report.speed) < (tactical ? 6.5 : 4.5) && Math.abs(angleDelta(report.heading, car.heading)) < .57;
    const ramAim = gtaOffset(report, clamp(report.speed * .28, -3, 5));
    const ram = seen && config.enableRamming && s.wantedLevel >= (tactical ? 3 : 4) &&
      (car.unitType === "swat" || (s.wantedLevel >= (tactical ? 4 : 5) && car.squadRole !== "PRIMARY_CHASER")) &&
      car.speed >= 5 && range <= 19 && rel.forward < 3 &&
      Math.abs(angleDelta(headingTo(car, ramAim), car.heading)) < .48 && canDriveDirect(world, car, ramAim, true);
    if (pit) {
      state = "PIT_MANEUVER";
      aim = gtaOffset(report, Math.max(2.5, report.speed * .48), Math.sign(rel.right) * .28);
      command = directCommand(car, aim, report.speed + 4, 0, dispatch, lateralAccel);
    } else if (seen && (ai.commitUntil > tick || (ram && tick >= (ai.nextRam ?? 0)))) {
      if (!(ai.commitUntil > tick)) {
        ai.commitUntil = tick + 38;
        ai.nextRam = tick + 105;
        ai.ramAim = ramAim;
      }
      if (canDriveDirect(world, car, ai.ramAim, true)) {
        state = "RAM";
        command = directCommand(car, ai.ramAim, car.maxSpeed, 0, dispatch, lateralAccel);
      } else ai.commitUntil = null;
    }
    if (!command && canDriveDirect(world, car, aim)) {
      if (car.path.length) {
        car.path = [];
        car.cursor = 0;
        ai.nextPlan = 0;
      }
      command = directCommand(car, aim, pace, steerBias, dispatch, lateralAccel);
    }
  }
  if (!command) {
    if (ai.routeState !== state) {
      car.path = [];
      car.cursor = 0;
      ai.nextPlan = 0;
      ai.routeState = state;
    }
    command = routeCommand(world, car, aim, pace, planRoute, steerBias,
      dispatch ? (tracked ? Math.max(reportSpeed, tactical ? 18 : 0) : (tactical ? 14 : 0)) : null, tracked);
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

export function gtaRearPushSpeed(patrol, lead, closingSpeed) {
  const patrolMass = mass(patrol), leadMass = mass(lead);
  // Match the rear, non-PIT impulse without applying contact.
  return Math.min(42, closingSpeed) * 1.17 * patrolMass / (patrolMass + leadMass);
}

function contactEvidence(a, b, closingSpeed) {
  const inverseMass = 1 / mass(a) + 1 / mass(b);
  const energyJ = inverseMass > 0 ? .5 * closingSpeed ** 2 / inverseMass : 0;
  return { energyJ, severity: clamp(energyJ / 42000, 0, 1) };
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

/** Predict the push without applying it to either simulated body. */
export function gtaPreviewLateralPush(patrol, lead, normal) {
  if (Math.abs(normal.x * Math.cos(lead.heading) - normal.z * Math.sin(lead.heading)) <= .65) return null;
  const approach = gtaVelocity(patrol), brake = gtaVelocity(lead);
  const closing = (approach.x - brake.x) * normal.x + (approach.z - brake.z) * normal.z;
  if (closing <= 0) return null;
  const preview = { a: lead, next: lead };
  shove(preview, lead, brake, leverArm(lead, patrol), normal.x, normal.z, gtaRearPushSpeed(patrol, lead, closing), false);
  return preview.impulse;
}

function damage(world, motion, other, closingSpeed, share) {
  const actor = motion.a;
  if (actor.health <= 0) return 0;
  const scale = isAggressiveChase(world.pursuit) && actor === world.player ? .32 : 1;
  const damage = Math.min(actor.health, Math.max(0, closingSpeed - .65) ** 1.45 * share * 1.55 * scale);
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
  const dispatch = Boolean(pursuit.response.dispatch);
  const ownedA = a.a === player || pursuit.patrols.has(a.a);
  const ownedB = b.a === player || pursuit.patrols.has(b.a);
  if (!ownedA && !ownedB && (!dispatch || !fresh)) return;
  const va = velocityAtContact(a, pa), vb = velocityAtContact(b, pb);
  const { x, z } = normal;
  const closingSpeed = Math.max(0, sweptClosing, (va.x - vb.x) * x + (va.z - vb.z) * z);
  const other = a.a === player ? b.a : b.a === player ? a.a : null;
  if (!other && dispatch && fresh) {
    const describe = body => ({ id: body.id, type: body.type,
      kind: body.unitType ?? body.kind ?? body.type, patrol: pursuit.patrols.has(body) });
    emitGtaEvent(world, "ambient_collision", {
      first: describe(a.a), second: describe(b.a), closingSpeed,
      ...contactEvidence(a.a, b.a, closingSpeed),
    });
  }
  if (!ownedA && !ownedB) return;
  const patrol = other && pursuit.patrols.has(other);
  const egoPose = a.a === player ? pa : pb, otherPose = a.a === player ? pb : pa;
  const egoArm = other ? leverArm(egoPose, otherPose) : null;
  const isPit = Boolean(patrol && other.aiState === "PIT_MANEUVER" && pursuit.gta.config.enablePitManeuver &&
    (!pursuit.response.dispatch || pursuit.response.sightedBy.has(other)) &&
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
  const evidence = dispatch ? { actorId: other.id, actorType: other.type, fresh,
    ...contactEvidence(player, other, closingSpeed) } : {};
  if (patrol) emitGtaEvent(world, "patrol_collision", {
    unitType: other.unitType, closingSpeed, damageToPlayer,
    damageToPatrol: a.a === player ? damageB : damageA, isPit, ...evidence,
  });
  else emitGtaEvent(world, "static_or_civilian_hit", {
    kind: other.gtaRoadblock ? "roadblock" : other.type === "pedestrian" ? "pedestrian" : other.kind ?? other.type,
    closingSpeed, damageToPlayer, ...evidence,
  });
}

export function updateGtaPhase(world) {
  const { player, pursuit: s } = world, { gta, response, metrics } = s;
  const nearby = [...response.closePatrols].filter(unit => unit.aiState !== "WRECKED");
  const boxed = nearby.some((a, i) => nearby.slice(i + 1).some(b => {
    const dot = (a.x - player.x) * (b.x - player.x) + (a.z - player.z) * (b.z - player.z);
    return dot <= .5 * distance(a, player) * distance(b, player);
  }));
  const aggressive = isAggressiveChase(s);
  const pinLimit = aggressive ? Math.round(4.0 / STEP) : PIN_TICKS;
  if (aggressive) {
    const closeUnit = nearby.some(unit => distance(unit, player) <= 7.5);
    const heldStill = (player.wait ?? 0) >= .25 ||
      (Math.hypot(player.speed, player.gtaSlipMps) < .28 && Math.abs(player.gtaYawRate ?? 0) < .16 && !player.curbSupportId);
    if (heldStill && (boxed || (closeUnit && (player.wait ?? 0) >= .65))) {
      gta.pinnedTicks = Math.min(pinLimit, gta.pinnedTicks + 1);
    } else {
      const decay = (player.wait ?? 0) === 0 && Math.hypot(player.speed, player.gtaSlipMps) >= .6 ? 4 : 1;
      gta.pinnedTicks = Math.max(0, gta.pinnedTicks - decay);
    }
  } else {
    const pinStationary = Math.hypot(player.speed, player.gtaSlipMps) < .8;
    gta.pinnedTicks = pinStationary && boxed
      ? Math.min(pinLimit, gta.pinnedTicks + 1) : 0;
  }
  metrics.capturePressureS = gta.pinnedTicks * STEP;
  emitGtaEvent(world, "pinned_progress", { ratio: gta.pinnedTicks / pinLimit });

  const from = s.wantedLevel, dispatch = response.dispatch;
  const tactical = isTacticalPursuit(s);
  const tracked = dispatch ? isDispatchTracked(response) : response.unitsInContact;
  if (dispatch && tracked) s.wantedLevel = gta.fadeStars;
  if (tracked) gta.heat += STEP / ((tactical ? 9.5 : 13) + (s.wantedLevel - 1) * 2);
  if ((!dispatch || tracked) && gta.heat >= 1 && s.wantedLevel < gta.config.wantedLevelMax) {
    s.wantedLevel++;
    gta.heat -= 1;
    gta.lostTicks = 0;
    gta.fadeStars = s.wantedLevel;
    gta.nextDispatchTick = Math.min(gta.nextDispatchTick, world.tick);
    gta.nextRoadblockTick = Math.min(gta.nextRoadblockTick, world.tick);
    if (tactical) refreshTacticalPatrolSpecs(s);
  }
  if (s.wantedLevel === gta.config.wantedLevelMax) gta.heat = 0;
  if (dispatch) updateDispatchEscape(world, tracked);
  else if (response.unitsInContact) {
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
  if (s.wantedLevel !== from) {
    if (tactical) refreshTacticalPatrolSpecs(s);
    if (!s.stepEvents.some(e => e.type === "wanted_changed"))
      emitGtaEvent(world, "wanted_changed", { from, to: s.wantedLevel });
  }
  if (player.health <= 0) s.phase = "wrecked";
  else if (gta.pinnedTicks >= pinLimit) s.phase = "busted";
  else if (s.wantedLevel === 0) {
    s.phase = "escaped";
    metrics.escape = true;
    if (dispatch) dispatch.state = "ESCAPED";
  } else if (metrics.survivalS >= gta.config.episodeMaxSeconds) s.phase = "timeout";
}
