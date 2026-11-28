import { angleDelta } from "../geometry.js";
import { followPath } from "../vehicle.js";
import { playerVehicleDimensions } from "../vehicle-spec.js";
import { planDistrictRoute } from "../district-navigation.js";
import { coordsOn, laneFrame, straightLanePath } from "../lane-geometry.js";
import { perceiveCorridor } from "./perception.js";
import {
  driverResultsOf, driverStateOf, planTrajectory, resetDriverState, signed,
} from "./trajectory-planner.js";
import { applySafetyShield } from "./safety-shield.js";

// A driver idle for this long (manual driving, a pursuit, no route) restarts from a calm state.
const STALE_STATE_TICKS = 120;

/* ------------------------------------------------------------------ route */

function wideRoadIds(world) {
  const cache = world._defensiveWideRoads;
  if (cache?.source === world.district.drivingRoads) return cache.ids;
  const ids = new Set(world.district.drivingRoads
    .filter((road) => road.width >= 10 && !road.parkingBay && !road.supportApron).map((road) => road.id));
  world._defensiveWideRoads = { source: world.district.drivingRoads, ids };
  return ids;
}

function cruiseGoals(world, player, sideways = false) {
  const ids = wideRoadIds(world);
  const hx = Math.sin(player.heading);
  const hz = Math.cos(player.heading);
  const scored = [];
  for (const goal of world.district.trafficGoals) {
    if (!ids.has(goal.roadId)) continue;
    const dx = goal.x - player.x;
    const dz = goal.z - player.z;
    const ahead = dx * hx + dz * hz;
    const dist = Math.hypot(dx, dz);
    // A detour around a jam may turn off the avenue, so it also considers goals beside the car.
    if (ahead < (sideways ? 15 : 70) || dist > 520) continue;
    const bend = Math.abs(angleDelta(goal.heading, player.heading));
    const lateral = Math.abs(dx * hz - dz * hx);
    const score = sideways ? bend * 12 + Math.abs(dist - 200) * 0.2 : lateral * 1.2 + bend * 55 + Math.abs(dist - 260) * 0.12;
    scored.push({ goal, score });
  }
  scored.sort((a, b) => a.score - b.score);
  return scored.slice(0, 8).map((row) => row.goal);
}

// At most limit goals are planned per call so a failing search can never stall a tick.
function planCruiseRoute(world, player, { avoid = null, limit = 2, start = 0 } = {}) {
  const frame = laneFrame(world, player, { maxPsi: 1.0 });
  let body = player;
  if (frame && Math.abs(frame.lat + frame.laneOffset) > 0.3) {
    // Re-anchor on the lane centre so a route planned mid-dodge never inherits the dodge.
    const ahead = 6;
    const along = frame.d * (frame.s + ahead);
    const left = frame.d * frame.laneOffset;
    const road = frame.road;
    const point = road.axis === "z" ? { x: road.fixed - left, z: along }
      : road.axis === "x" ? { x: along, z: road.fixed + left }
        : { x: road.x1 + along * road.ux - left * road.uz, z: road.z1 + along * road.uz + left * road.ux };
    body = { ...player, x: point.x, z: point.z, heading: frame.laneHeading };
  }
  const goals = cruiseGoals(world, player, Boolean(avoid));
  for (let i = 0; i < Math.min(limit, goals.length); i++) {
    const path = planDistrictRoute(world.district, body, goals[(start + i) % goals.length], world.actors);
    if (path.length <= 20) continue;
    if (avoid && path.slice(0, 220).some((p) => Math.hypot(p.x - avoid.x, p.z - avoid.z) < 6)) continue;
    return path;
  }
  return [];
}

// When no junction-to-junction route exists, keep driving the current lane rather than stopping.
function laneKeepPath(world, player) {
  const frame = laneFrame(world, player, { maxPsi: 1.0 });
  if (!frame) return [];
  const room = frame.d > 0 ? frame.road.max - frame.along : frame.along - frame.road.min;
  return straightLanePath(frame, frame.s + 4, -frame.laneOffset, Math.min(160, room - 24));
}

// A wreck ahead on this avenue: keep the route straight along it until the wreck is behind.
function keepAvenueForAccident(world, player, lock) {
  const path = player.path;
  if (path?.length > 1) {
    for (let i = player.cursor ?? 0; i < path.length; i++) {
      const c = coordsOn(lock.road, lock.d, path[i]);
      if (c.s > lock.sLimit) return false;
      if (Math.abs(c.lat) > lock.halfW + 0.5) break;
      if (i === path.length - 1) return false;
    }
  }
  const room = lock.d > 0 ? lock.road.max - (lock.d * lock.sEgo) : lock.d * lock.sEgo - lock.road.min;
  const frame = { road: lock.road, d: lock.d };
  const fresh = straightLanePath(frame, lock.sEgo + 3, -lock.laneOffset, Math.min(220, room - 24));
  if (fresh.length < 2) return false;
  player.path = fresh;
  player.cursor = 0;
  world.routeRevision++;
  return true;
}

function maintainRoute(world, player, strategy, base, state) {
  const lock = strategy.getRouteLock(world, player);
  if (lock && world.tick - state.lockTick >= 12) {
    state.lockTick = world.tick;
    if (keepAvenueForAccident(world, player, lock)) return player.path;
  }
  const remaining = player.path.length > 1 ? base.remaining ?? 0 : 0;
  const mustPlan = player.path.length < 2 || remaining < 18;
  const shouldPlan = mustPlan || (remaining < 60 && Math.abs(state.offset) < 0.3 && state.reaction === "cruising");
  if (!shouldPlan || world.tick - state.routeTick < (mustPlan ? 8 : 24)) return null;
  state.routeTick = world.tick;
  state.goalCursor += 2;
  let path = lock ? [] : planCruiseRoute(world, player, { limit: 2, start: state.goalCursor - 2 });
  if (!path.length && player.path.length < 2) path = laneKeepPath(world, player);
  if (!path.length) return null;
  player.path = path;
  player.cursor = 0;
  world.routeRevision++;
  return path;
}

// Waiting a long time behind a jam: look for a way around it (cruising strategies only).
function rerouteAtHold(world, player, strategy, state, hold) {
  // The ticket holder changes as the queue drains; remember the car that really blocks the exit.
  if (hold.reason === "district-exit-storage" || hold.reason === "district-entry-queue") { state.jamId = hold.blockedBy; state.jamTick = world.tick; }
  if ((hold.waitS ?? 0) > 8 && world.tick - state.rerouteTick > 360 && strategy.allowRerouteAtHold(world, player, hold)) {
    state.rerouteTick = world.tick;
    const jamId = world.tick - (state.jamTick ?? -Infinity) < 900 ? state.jamId : hold.blockedBy;
    const jam = world.actors.find((actor) => actor.id === jamId);
    if (jam) {
      const path = planCruiseRoute(world, player, { avoid: jam, limit: 4 });
      if (path.length) { player.path = path; player.cursor = 0; world.routeRevision++; }
    }
  }
}

/* -------------------------------------------------------------- telemetry */

function holdDetail(hold) {
  const who = typeof hold.blockedBy === "string" ? ` for ${hold.blockedBy}` : "";
  return `Waiting at the junction line (${hold.reason})${who}, ${Math.round(hold.waitS ?? 0)} s`;
}

function detailText(reaction, threat, offset, factor, extra) {
  const who = threat ? `${threat.kind} ${threat.id}` : "traffic";
  if (reaction === "junction-hold") return extra?.detail ?? "Waiting at the junction line";
  if (reaction === "no-route") return "No route ahead; holding the lane";
  if (reaction === "accident-bypass") return `Shifting ${signed(offset)} m around ${who}`;
  if (reaction === "evasive-shift") return extra?.detail ?? `Shifting ${signed(offset)} m away from ${who}`;
  if (reaction === "defensive-yield") return `Easing to ${Math.round(factor * 100)}% speed for ${who}`;
  if (reaction === "emergency-brake") return `Emergency braking for ${who}`;
  return "Corridor clear";
}

function publish(world, reaction, threat, ttc, offset, minGap, factor, extra = null) {
  const chaos = world.streetChaos;
  if (!chaos?.active) return;
  const round = (v, k) => Number.isFinite(v) ? Math.round(v * k) / k : null;
  chaos.egoReaction = {
    reaction, threatId: threat?.id ?? null, threatKind: threat?.kind ?? null,
    ttcS: round(ttc, 100),
    chosenOffsetM: Math.round(offset * 10) / 10, minClearanceM: Math.round(minGap * 100) / 100,
    reasonDetail: detailText(reaction, threat, offset, factor, extra),
    ...(Number.isFinite(threat?.squeezeS) ? { squeezeS: round(threat.squeezeS, 100) } : {}),
    ...(extra?.holdReason ? { holdReason: extra.holdReason, waitS: extra.waitS } : {}),
  };
}

function publishReport(world, report) {
  if (!report) return;
  const hold = report.extra?.hold;
  if (hold) {
    publish(world, "junction-hold", report.threat, Infinity, 0, 2.6, 1,
      { detail: holdDetail(hold), holdReason: hold.reason, waitS: Math.round((hold.waitS ?? 0) * 10) / 10 });
    return;
  }
  publish(world, report.reaction, report.threat, report.ttcS, report.offset, report.minGap, report.factor, report.extra);
}

/* ------------------------------------------------------------ orchestrator */

export const resetUnifiedDriverState = resetDriverState;
export const getUnifiedDriverResults = driverResultsOf;

// route -> perception -> trajectory planner -> safety shield, with the mode supplied as a strategy.
export function stepUnifiedDriver(world, player, baseCommand, strategy, options = {}) {
  let state = driverStateOf(player);
  if (world.tick - state.lastStepTick > STALE_STATE_TICKS) {
    resetDriverState(player);
    state = driverStateOf(player);
  }
  state.lastStepTick = world.tick;
  const disabled = options.disableLateralAvoidance === true || options.disableDefensiveAvoidance === true;
  const routed = strategy.maintainContinuousCruise ? maintainRoute(world, player, strategy, baseCommand, state) : null;
  let base = baseCommand;
  if (routed) base = { ...baseCommand, ...followPath(player, player.path, 0) };
  const perception = perceiveCorridor(world, player, strategy, state, { obstacles: false });
  // Foresight may only slow the car, never pin it: when the district itself sets no hold, waiting is cut short.
  state.gateWaitTicks = perception.gateOnly && (player.speed ?? 0) < 0.3 ? state.gateWaitTicks + 1 : 0;
  if (state.gateWaitTicks > 90) {
    state.zoneIgnoreUntil = world.tick + 360;
    state.gateWaitTicks = 0;
  }
  if (!player.path || player.path.length < 2) {
    state.speedTarget = null;
    state.reaction = "no-route";
    publish(world, "no-route", null, Infinity, 0, 2.6, 0);
    return {
      steer: 0, targetSpeed: 0, reason: "no-route", blockedBy: null, usePlannedPath: true,
      defensiveState: { reaction: "no-route", enabled: !disabled, offsetM: 0, speedFactor: 0,
        dims: playerVehicleDimensions(player) },
    };
  }
  if (disabled) {
    return {
      steer: base.steer, targetSpeed: base.targetSpeed,
      reason: base.reason ?? "driving", blockedBy: null, usePlannedPath: true,
      defensiveState: { reaction: "cruising", enabled: false, offsetM: 0, speedFactor: 1,
        dims: playerVehicleDimensions(player) },
    };
  }
  const hooks = strategy.maintainContinuousCruise ? { onHoldWait: (hold) => rerouteAtHold(world, player, strategy, state, hold) } : {};
  const plan = planTrajectory(world, player, perception, strategy, state, base, hooks);
  plan.baseReason = base.reason;
  publishReport(world, plan.report);
  return applySafetyShield(world, player, perception, plan, strategy);
}
