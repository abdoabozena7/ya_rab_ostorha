import { STEP, VEHICLE, clamp } from "../config.js";
import { angleDelta, bodyOnRoad, overlaps } from "../geometry.js";
import { integrateVehicle, nearestPathPoint, vehicleProbe } from "../vehicle.js";
import { KING_LONG_MICROBUS, KING_LONG_MICROBUS_ID } from "../vehicle-spec.js";
import { coordsOn, idealPathSpeed, zoneAheadM } from "../lane-geometry.js";
import { HORIZON_S, TIMES } from "./perception.js";

const driverStates = new WeakMap();

// One fixed-shape record per actor keeps every access monomorphic.
function createDriverState() {
  return {
    offset: 0, commandOffset: 0, factor: 1, speedTarget: null, lastEvalTick: -99, lastSwitchTick: -99,
    calm: 0, stallTicks: 0, moveUntilTick: -1, slow: null, pass: null, reaction: "cruising", threat: null,
    cache: null, emergencyTick: -999, brakeTtcS: Infinity, clear: false, lastResults: null, contactT: Infinity,
    routeTick: -99, goalCursor: 0, lockTick: -99, jamId: null, jamTick: -Infinity, rerouteTick: -999,
    zoneTick: -99, zoneAhead: null, zoneIgnoreUntil: -1, gateWaitTicks: 0, lastStepTick: -Infinity,
  };
}

export function driverStateOf(player) {
  let state = driverStates.get(player);
  if (!state) {
    state = createDriverState();
    driverStates.set(player, state);
  }
  return state;
}

export const resetDriverState = (player) => { driverStates.delete(player); };
export const driverResultsOf = (player) => driverStates.get(player)?.lastResults ?? null;

export const signed = (v) => `${v > 0 ? "+" : ""}${v.toFixed(1)}`;

/* --------------------------------------------------------------- steering */

const aimScratch = { steer: 0, cursor: 0 };

export function aimSteer(body, path, cursor, offset, out = aimScratch) {
  if (!path || path.length < 2) {
    out.steer = 0;
    out.cursor = cursor;
    return out;
  }
  const wheelbase = body.spec?.wheelbase ?? VEHICLE.wheelbase;
  const axleCenterZ = body.vehicleModel === KING_LONG_MICROBUS_ID ? KING_LONG_MICROBUS.axleCenterZM : 0;
  const rearAxle = wheelbase / 2 - axleCenterZ;
  const x = body.x - Math.sin(body.heading) * rearAxle;
  const z = body.z - Math.cos(body.heading) * rearAxle;
  const nearest = nearestPathPoint(path, x, z, cursor);
  const speed = Math.abs(body.speed ?? 0);
  const lookahead = offset === 0 ? 2 + speed * 0.18 : Math.max(2 + speed * 0.18, 5 + speed * 0.3);
  let target = nearest;
  let length = 0;
  while (target < path.length - 1 && length < lookahead) {
    length += Math.hypot(path[target + 1].x - path[target].x, path[target + 1].z - path[target].z);
    target++;
  }
  let ax = path[target].x;
  let az = path[target].z;
  if (offset !== 0) {
    const from = path[Math.max(0, target - 3)];
    const phi = Math.atan2(ax - from.x, az - from.z);
    ax += offset * Math.cos(phi);
    az -= offset * Math.sin(phi);
  }
  const alpha = angleDelta(Math.atan2(ax - x, az - z), body.heading);
  const dist = Math.max(1, Math.hypot(ax - x, az - z));
  out.steer = Math.atan2(2 * wheelbase * Math.sin(alpha), dist);
  out.cursor = nearest;
  return out;
}

// Speed the route itself allows at a path index (bends, junction turns, arrival), cached per evaluation.
function routeSpeedProfile(player) {
  const cache = new Map();
  const path = player.path;
  return (cursor) => {
    let v = cache.get(cursor);
    if (v === undefined) {
      const at = path[Math.min(cursor, path.length - 1)];
      v = idealPathSpeed({ x: at.x, z: at.z, heading: player.heading, speed: player.speed, spec: player.spec,
        vehicleModel: player.vehicleModel, maxSpeed: player.maxSpeed }, path, cursor);
      cache.set(cursor, v);
    }
    return v;
  };
}

/* ---------------------------------------------------------------- rollout */

export function simulate(ctx, offset, factor) {
  const { player, path, cursor0, vCruise, obstacles, roads, lane, roadMargin } = ctx;
  const crossLane = Boolean(lane) && lane.road.width >= ctx.laneCrossMinWidthM;
  const probe = vehicleProbe(player, player.speed);
  const cmd = { steer: 0, targetSpeed: factor * vCruise };
  const aim = { steer: 0, cursor: cursor0 };
  let cursor = cursor0;
  let prevT = 0;
  let travelled = 0;
  const result = {
    offset, factor, valid: true, hardT: Infinity, offRoadT: Infinity, soft: 0, soft1: 0, cross: 0, travelled: 0,
    softT: Infinity, softThreat: -1, hardThreat: -1, minGap: 2.6, steerSum: 0, cost: 0, boxed: false,
  };
  for (let k = 0; k < TIMES.length; k++) {
    const t = TIMES[k];
    const dt = t - prevT;
    prevT = t;
    aimSteer(probe, path, cursor, offset, aim);
    cursor = aim.cursor;
    // A route that ends inside the horizon is a finished plan, not an obstacle.
    if (ctx.stopAtRouteEnd && cursor >= path.length - 1) break;
    cmd.steer = aim.steer;
    if (ctx.routeSpeedAt) cmd.targetSpeed = Math.min(factor * vCruise, ctx.routeSpeedAt(cursor));
    const x0 = probe.x;
    const z0 = probe.z;
    integrateVehicle(probe, cmd, dt, probe);
    travelled += Math.hypot(probe.x - x0, probe.z - z0);
    result.steerSum += Math.abs(probe.steer);
    if (!bodyOnRoad(probe, roads, roadMargin)) {
      result.valid = false;
      result.offRoadT = t;
      break;
    }
    // Brushing past something at a crawl is far less risky than at speed.
    const weight = (1.35 - 0.7 * (t / HORIZON_S)) * clamp(0.3 + probe.speed / 8, 0.3, 1.3);
    if (crossLane && Math.abs(angleDelta(probe.heading, lane.laneHeading)) < 0.5) {
      const c = coordsOn(lane.road, lane.d, probe);
      // Straddling the centre line puts the car in the oncoming lane: legal only as a last resort.
      if (c.lat + (probe.width ?? 1.85) / 2 > -0.1 && c.lat < lane.halfW) result.cross += weight;
    }
    for (let i = 0; i < obstacles.length; i++) {
      const o = obstacles[i];
      const pose = o.pose;
      pose.x = o.px[k];
      pose.z = o.pz[k];
      pose.heading = o.ph[k];
      if (overlaps(probe, pose, o.hard)) {
        if (t < result.hardT) { result.hardT = t; result.hardThreat = i; }
        result.valid = false;
        result.minGap = 0;
        break;
      }
      if (overlaps(probe, pose, o.gaps.soft1)) {
        result.soft += weight;
        result.soft1 += weight;
        result.minGap = Math.min(result.minGap, o.gaps.soft1);
        if (t < result.softT) { result.softT = t; result.softThreat = i; }
      } else if (overlaps(probe, pose, o.gaps.soft2)) {
        result.soft += 0.12 * weight;
        result.minGap = Math.min(result.minGap, o.gaps.soft2);
      }
    }
    if (!result.valid) break;
  }
  result.travelled = travelled;
  return result;
}

// Stopping short of a wreck or a kerbside parked car is safe but never gets past it: measure how
// far each lateral offset can travel before it meets something that is not going to move away.
export function blockedDistance(ctx, offset) {
  const { player, path, cursor0, obstacles, roads, roadMargin, blockLookaheadM } = ctx;
  const holds = obstacles.filter((o) => !o.isPed && (o.kind === "static" || o.speed < 0.6));
  if (!holds.length) return { distanceM: Infinity, obstacle: null };
  const probe = vehicleProbe(player, clamp(Math.max(player.speed, 4), 4, 9));
  const cmd = { steer: 0, targetSpeed: probe.speed };
  const aim = { steer: 0, cursor: cursor0 };
  let travelled = 0;
  for (let k = 0; k < 30 && travelled < blockLookaheadM; k++) {
    aimSteer(probe, path, aim.cursor, offset, aim);
    if (ctx.stopAtRouteEnd && aim.cursor >= path.length - 1) break;
    cmd.steer = aim.steer;
    cmd.targetSpeed = ctx.routeSpeedAt ? Math.min(probe.speed, ctx.routeSpeedAt(aim.cursor)) : probe.speed;
    const x0 = probe.x;
    const z0 = probe.z;
    integrateVehicle(probe, cmd, 0.25, probe);
    travelled += Math.hypot(probe.x - x0, probe.z - z0);
    if (!bodyOnRoad(probe, roads, roadMargin)) return { distanceM: travelled, obstacle: null };
    for (let i = 0; i < holds.length; i++) {
      const o = holds[i];
      o.pose.x = o.source.x;
      o.pose.z = o.source.z;
      o.pose.heading = o.source.heading ?? 0;
      if (overlaps(probe, o.pose, 0.35)) return { distanceM: travelled, obstacle: o };
    }
  }
  return { distanceM: Infinity, obstacle: null };
}

function threatInfo(obstacles, baseline) {
  const idx = baseline.hardThreat >= 0 ? baseline.hardThreat : baseline.softThreat;
  if (idx < 0) return null;
  const o = obstacles[idx];
  let kind = o.kind;
  if (kind === "vehicle" && o.cutIn) kind = "cut-in";
  // ttcS is a real time to contact only; lateral squeeze time is reported separately.
  return { id: o.id, kind, ttcS: baseline.hardT, squeezeS: baseline.softT, wreck: Boolean(o.wreck), passing: o.passing };
}

function holdThreat(block, strategy) {
  const o = block.obstacle;
  if (!o || !Number.isFinite(block.distanceM) || block.distanceM > strategy.blockLookaheadM) return null;
  return { id: o.id, kind: o.kind, ttcS: Infinity, wreck: Boolean(o.wreck), distanceM: block.distanceM };
}

/* ----------------------------------------------------- slow-leader pass */

function trackSlowLeader(world, player, strategy, state, obstacles, vNominal, lane, hold) {
  if (hold || !lane || lane.road.width < strategy.passMinRoadWidthM || vNominal < 4) { state.slow = null; return null; }
  const ego = player.length ?? 4.2;
  let leader = null;
  for (const o of obstacles) {
    if (o.isPed || o.kind === "static" || o.wreck || o.oncoming) continue;
    const gap = o.forward - (ego + (o.source.length ?? 4.2)) / 2;
    if (o.forward <= 0 || gap > 26 || Math.abs(o.lateral) > 1.6) continue;
    if (Math.abs(angleDelta(o.source.heading, player.heading)) > 0.15) continue;
    if (o.speed < 0.8 || o.speed >= 0.65 * vNominal) continue;
    if (!leader || o.forward < leader.forward) leader = o;
  }
  if (!leader) { state.slow = null; return null; }
  if (state.slow?.id !== leader.id) state.slow = { id: leader.id, since: world.tick };
  return world.tick - state.slow.since >= strategy.slowLeaderTicks ? leader : null;
}

// A clean corridor beside the leader, through the oncoming lane when the kerb side is too narrow.
function planPass(world, player, leader, ctx, lane, vNominal) {
  const width = player.width ?? 1.85;
  const leaderLat = coordsOn(lane.road, lane.d, leader.source).lat;
  const target = leaderLat + (width + (leader.source.width ?? 1.85)) / 2 + 1.1;
  if (target + width / 2 > 1.8) return null;
  const offset = target + lane.laneOffset;
  const rel = Math.max(0.5, vNominal - leader.speed);
  const gap = leader.forward - ((player.length ?? 4.2) + (leader.source.length ?? 4.2)) / 2;
  const passTime = (gap + (leader.source.length ?? 4.2) + (player.length ?? 4.2) + 4) / rel;
  const passDist = passTime * vNominal;
  if (passDist + 20 > 62 || zoneAheadM(world, lane, lane.s) < passDist + 12) return null;
  for (const o of ctx.obstacles) {
    if (!o.oncoming || o.isPed) continue;
    if (o.forward > 0 && o.forward - o.speed * passTime < passDist + 20) return null;
  }
  const trial = simulate(ctx, offset, 1);
  if (!trial.valid || trial.soft1 > 0) return null;
  const block = blockedDistance(ctx, offset);
  if (block.distanceM < passDist) return null;
  return { id: leader.id, offset, startTick: world.tick, passDist };
}

export function maintainPass(world, player, strategy, state, obstacles, ctx, vNominal, lane, hold) {
  const active = state.pass;
  if (active) {
    const o = obstacles.find((candidate) => candidate.id === active.id);
    const cleared = !o || o.forward < -((player.length ?? 4.2) + (o.source.length ?? 4.2)) / 2 - 1.5;
    if (cleared || world.tick - active.startTick > 1500 || hold) { state.pass = null; state.slow = null; return null; }
    const trial = simulate(ctx, active.offset, 1);
    if (!trial.valid) { state.pass = null; state.slow = null; return null; }
    active.leaderSpeed = o.speed;
    active.gapM = o.forward - ((player.length ?? 4.2) + (o.source.length ?? 4.2)) / 2;
    return trial;
  }
  const leader = trackSlowLeader(world, player, strategy, state, obstacles, vNominal, lane, hold);
  if (!leader) return null;
  const plan = planPass(world, player, leader, ctx, lane, vNominal);
  if (!plan) return null;
  state.pass = plan;
  return simulate(ctx, plan.offset, 1);
}

/* ------------------------------------------------------ speed controller */

// Deceleration the speed target may demand: gentle unless contact is imminent, then as hard as needed.
function brakeRate(strategy, speed, ttcS, emergency) {
  if (emergency && ttcS < 0.5) return Infinity;
  if (!(ttcS < 2.8)) return strategy.comfortDecelMps2;
  const need = (1.15 * speed) / (2 * Math.max(ttcS, 0.3));
  if (ttcS < strategy.imminentContactS) return clamp(Math.max(3.4, need), 3.4, 6);
  return clamp(need, strategy.comfortDecelMps2, 3.4);
}

// Within the arrival radius the lateral choices narrow with the remaining distance, so the car settles on the spot.
function allowedOffsets(player, strategy) {
  const radius = strategy.parkingArrivalRadiusM;
  const offsets = strategy.offsetsM;
  if (!radius || !player.parking) return offsets;
  const dist = Math.hypot(player.parking.x - player.x, player.parking.z - player.z);
  if (dist >= radius) return offsets;
  const reach = Math.max(...offsets.map(Math.abs)) * (dist / radius);
  return offsets.filter((offset) => Math.abs(offset) <= reach);
}

// Dodging a walker needs room, not drama: at low speed or close to a junction a wide swerve would leave
// the car skewed at the stop line, so pedestrian-only threats keep the sidestep small.
function pedestrianOnlyThreat(player, threat, obstacles) {
  if (threat?.kind !== "pedestrian") return false;
  const hx = Math.sin(player.heading);
  const hz = Math.cos(player.heading);
  return !obstacles.some((o) => {
    if (o.isPed) return false;
    const dx = o.source.x - player.x;
    const dz = o.source.z - player.z;
    const forward = dx * hx + dz * hz;
    return forward > -2 && forward < 35 && Math.abs(dx * hz - dz * hx) < 4;
  });
}

function cappedForPedestrians(world, player, strategy, perception, threat, offsets) {
  const cap = strategy.pedestrianOffsetCapM;
  if (!cap || !pedestrianOnlyThreat(player, threat, perception.obstacles)) return offsets;
  const lane = perception.lane;
  const nearJunction = (perception.gate && perception.gate.distanceM < strategy.pedestrianCapJunctionM) ||
    (lane && zoneAheadM(world, lane, lane.s) < strategy.pedestrianCapJunctionM);
  if (!nearJunction && (player.speed ?? 0) >= strategy.pedestrianCapSpeedMps) return offsets;
  return offsets.filter((offset) => Math.abs(offset) <= cap);
}

function nearParking(player, strategy) {
  const radius = strategy.parkingArrivalRadiusM;
  return Boolean(radius) && Boolean(player.parking) &&
    Math.hypot(player.parking.x - player.x, player.parking.z - player.z) < radius;
}

// Wanted pace before any hazard: path curvature, road limit, vehicle cap, junction gate and the base command.
function cruiseSpeed(player, strategy, perception, baseCommand, state) {
  const { gate, hold, road } = perception;
  let nominal = Math.min(idealPathSpeed(player, player.path, player.cursor ?? 0), road.limit, player.maxSpeed);
  // The base command slows a car that sits off its line; a deliberate sidestep must not inherit that.
  if (strategy.honorBaseSpeed && Math.abs(state.commandOffset) < 0.3 && Number.isFinite(baseCommand.targetSpeed)) nominal = Math.min(nominal, Math.max(0, baseCommand.targetSpeed));
  let raw = nominal;
  if (gate) {
    // A junction ticket holds the car at its stop line; foresight/approach gates only ease down to a gentle roll.
    const taper = Math.sqrt(2 * strategy.junctionTaperMps2 * Math.max(0, gate.distanceM - (gate.stopBeforeM ?? 0.55)));
    raw = Math.min(raw, gate === hold ? taper : Math.max(1.8, taper));
  }
  return { nominal, cruise: Number.isFinite(raw) ? Math.max(raw, 0) : player.maxSpeed };
}

/* -------------------------------------------------------------- the plan */

function planHold(world, player, state, hold, hooks) {
  // Waiting for a junction ticket: no wheel lock, no phantom threats, an honest report.
  state.offset = 0;
  state.factor = 1;
  state.calm = 0;
  state.pass = null;
  state.slow = null;
  state.clear = false;
  state.contactT = Infinity;
  state.reaction = "junction-hold";
  state.brakeTtcS = Infinity;
  state.threat = { id: hold.blockedBy, kind: "junction", ttcS: Infinity, wreck: false };
  state.cache = { candidates: 0, ttc: Infinity, minGap: 2.6, boxed: false };
  hooks.onHoldWait?.(hold);
  return {
    reaction: "junction-hold", threat: state.threat, ttcS: Infinity, offset: 0, minGap: 2.6, factor: 1,
    extra: { hold },
  };
}

function evaluate(world, player, strategy, perception, state, vCruise, vNominal) {
  const { gate, gateOnly, hold } = perception;
  state.lastEvalTick = world.tick;
  const { obstacles, lane } = perception.obstacles ? perception : perception.refresh();
  const ctx = {
    player, path: player.path, cursor0: player.cursor ?? 0, vCruise: Math.max(vCruise, 2), obstacles,
    roads: world.roads, lane, roadMargin: strategy.allowCurbClearance ? -0.2 : 0.1,
    blockLookaheadM: strategy.blockLookaheadM, stopAtRouteEnd: strategy.stopRolloutAtRouteEnd, laneCrossMinWidthM: strategy.laneCrossMinRoadWidthM,
    routeSpeedAt: strategy.followRouteSpeedProfile ? routeSpeedProfile(player) : null, proactive: false, blocked: null,
  };
  const baseline = simulate(ctx, 0, 1);
  const centreBlock = blockedDistance(ctx, 0);
  const clear = baseline.valid && baseline.soft1 === 0 && baseline.soft < 0.5 && centreBlock.distanceM > 30;
  const threat = threatInfo(obstacles, baseline) ?? holdThreat(centreBlock, strategy);
  ctx.proactive = Boolean(threat) && !threat.passing && strategy.proactiveKinds.includes(threat.kind);
  // After an emergency stop the speed ceiling climbs in stages, so braking never bounces on and off.
  const stages = strategy.releaseStages;
  const sinceBrake = world.tick - state.emergencyTick;
  const releaseCap = sinceBrake < stages.length * strategy.brakeHoldTicks
    ? stages[Math.floor(sinceBrake / strategy.brakeHoldTicks)] : 1;
  const hasParking = nearParking(player, strategy);
  let boxedTtc = Infinity;
  let chosen;
  let candidates = 1;
  let extra = null;
  const passTrial = strategy.allowSlowLeaderPass && !hasParking
    ? maintainPass(world, player, strategy, state, obstacles, ctx, vNominal, lane, hold) : null;
  if (passTrial) {
    chosen = passTrial;
    extra = { detail: `Overtaking slow ${state.slow ? "leader" : "traffic"} ${state.pass.id} via ${signed(passTrial.offset)} m` };
  } else if (clear) {
    state.calm++;
    const relaxed = state.offset === 0 || state.calm >= 6;
    if (relaxed) {
      chosen = releaseCap < 1 ? { ...baseline, factor: releaseCap } : baseline;
      if (state.offset !== 0) state.lastSwitchTick = world.tick;
    }
  } else state.calm = 0;
  if (!chosen) {
    const offsets = cappedForPedestrians(world, player, strategy, perception, threat, allowedOffsets(player, strategy));
    const results = [];
    for (const factor of strategy.speedFactors) {
      for (const offset of offsets) {
        results.push(offset === 0 && factor === 1 ? baseline : simulate(ctx, offset, factor));
      }
    }
    candidates = results.length;
    ctx.blocked = new Map(offsets.map((offset) => [offset, offset === 0 ? centreBlock : blockedDistance(ctx, offset)]));
    state.lastResults = results;
    const commit = { offset: state.offset, factor: state.factor };
    let valid = results.filter((r) => r.valid);
    // Sitting still beside a wreck is never the answer: after a short stall only moving plans compete.
    // The commitment lasts a few seconds so a crawl never flips back to standing still.
    if (state.stallTicks > 90) state.moveUntilTick = world.tick + 300;
    if (world.tick < state.moveUntilTick && valid.some((r) => r.factor > 0)) valid = valid.filter((r) => r.factor > 0);
    // A car merely overtaking alongside is no reason to stop dead.
    if (threat?.passing && baseline.hardT === Infinity && valid.some((r) => r.factor > 0.2))
      valid = valid.filter((r) => r.factor > 0.2);
    if (releaseCap < 1 && valid.some((r) => r.factor <= releaseCap)) valid = valid.filter((r) => r.factor <= releaseCap);
    let best = null;
    if (valid.length) {
      let bestCost = Infinity;
      for (const r of valid) {
        const c = strategy.scoreCandidate(r, ctx, commit);
        r.cost = c;
        if (c < bestCost) { bestCost = c; best = r; }
      }
      const current = valid.find((r) => r.offset === commit.offset && r.factor === commit.factor);
      const dwellOver = world.tick - state.lastSwitchTick >= strategy.minDwellTicks;
      if (current && best !== current && (!dwellOver || best.cost > current.cost - strategy.switchMargin)) best = current;
    } else {
      // Boxed in: delay the first overlap as long as possible with the least lateral drama.
      const timeOf = (r) => Math.min(r.hardT, r.offRoadT);
      best = results.reduce((a, b) => {
        const ta = timeOf(a);
        const tb = timeOf(b);
        if (tb > ta + 1e-6) return b;
        if (ta > tb + 1e-6) return a;
        return Math.abs(b.offset) < Math.abs(a.offset) ? b : a;
      });
      // Never snap back to the centre line for a single boxed tick when holding the line is as good.
      const held = state.offset !== 0 ? results.filter((r) => r.offset === state.offset) : [];
      if (held.length) {
        const keep = held.reduce((a, b) => (timeOf(b) > timeOf(a) ? b : a));
        if (timeOf(keep) >= timeOf(best) - 0.2) best = keep;
      }
      boxedTtc = timeOf(best);
      // Only a contact within ~1 s is an emergency; otherwise ease off and let the picture develop.
      best = boxedTtc < strategy.imminentContactS
        ? { ...best, factor: 0, boxed: true }
        : { ...best, factor: Math.min(best.factor, 0.3) };
    }
    chosen = best;
  }
  if (chosen.offset !== state.offset || chosen.factor !== state.factor) state.lastSwitchTick = world.tick;
  state.offset = chosen.offset;
  state.factor = chosen.factor;
  const hardT = baseline.hardT;
  let reaction = strategy.selectReaction({
    chosen, clear, threat, hardT, speed: player.speed ?? 0, passing: Boolean(state.pass),
    commandOffset: state.commandOffset,
  });
  let reported = threat;
  if (reaction === "cruising" && gateOnly && vCruise < 1 && (player.speed ?? 0) < 1) {
    // Held short of a busy junction by foresight alone: say so rather than claim to be cruising.
    reaction = "junction-hold";
    reported = { id: gate.zoneId ?? "junction", kind: "junction", ttcS: Infinity, wreck: false };
    extra = { detail: "Waiting at the junction line for traffic in the junction" };
  }
  if (reaction === "emergency-brake") state.emergencyTick = world.tick;
  // A valid sidestep has no contact of its own, so only the straight-ahead picture justifies hard braking.
  const dodging = Math.abs(chosen.offset) >= 0.6 && !chosen.boxed;
  state.brakeTtcS = Math.min(dodging ? Infinity : hardT, chosen.hardT ?? Infinity, boxedTtc);
  state.reaction = reaction;
  state.threat = reported;
  state.contactT = Math.min(chosen.hardT ?? Infinity, chosen.offRoadT ?? Infinity);
  state.clear = clear && !state.pass && releaseCap >= 1;
  state.cache = { candidates, ttc: hardT, minGap: chosen.minGap ?? baseline.minGap, boxed: Boolean(chosen.boxed) };
  return {
    reaction, threat: reported, ttcS: hardT, offset: state.offset, minGap: state.cache.minGap, factor: state.factor,
    extra,
  };
}

// Plans one tick of driving: where to aim (lateral offset on the route) and how fast to go.
export function planTrajectory(world, player, perception, strategy, state, baseCommand, hooks = {}) {
  const { gate, hold } = perception;
  const { nominal: vNominal, cruise: vCruise } = cruiseSpeed(player, strategy, perception, baseCommand, state);
  const atHold = Boolean(hold) && (vCruise < 0.5 || (player.speed ?? 0) < 0.5);
  state.stallTicks = (player.speed ?? 0) < 0.3 && !atHold ? state.stallTicks + 1 : 0;
  let report = null;
  if (atHold) report = planHold(world, player, state, hold, hooks);
  else if (world.tick - state.lastEvalTick >= strategy.evalEveryTicks)
    report = evaluate(world, player, strategy, perception, state, vCruise, vNominal);

  // Clear road and on its line: the base command is already the best plan, so hand it back untouched.
  if (strategy.transparentWhenClear && state.clear && !gate && state.reaction === "cruising" && !state.pass &&
      state.offset === 0 && state.factor === 1 && Math.abs(state.commandOffset) < 0.02) {
    state.commandOffset = 0;
    state.speedTarget = null;
    return { transparent: true, report, reaction: "cruising", threat: null, steer: baseCommand.steer, targetSpeed: baseCommand.targetSpeed };
  }

  const emergency = state.reaction === "emergency-brake";
  // Slew the lateral target so the car never snaps between lanes.
  const step = strategy.offsetSlewMps * STEP;
  state.commandOffset += clamp(state.offset - state.commandOffset, -step, step);
  const steerOut = aimSteer(player, player.path, player.cursor ?? 0, state.commandOffset, { steer: 0, cursor: 0 });
  let desired = vCruise * state.factor;
  // Never close on the truck until the car has actually slid into the passing lane.
  const pass = state.pass;
  if (pass && pass.gapM > -1 && Math.abs(state.commandOffset - pass.offset) > 0.35)
    desired = Math.min(desired, Math.max((pass.leaderSpeed ?? 0) + 0.4, 1.5));
  const current = Math.max(player.speed ?? 0, 0);
  if (state.speedTarget === null) state.speedTarget = current;
  if (!emergency && desired > 0.5 && Math.abs(desired - state.speedTarget) < 0.3) {
    // Within a hair of the wanted pace: hold it rather than twitching the throttle and brake.
  } else if (desired > state.speedTarget) {
    state.speedTarget = Math.min(desired, Math.max(current, state.speedTarget) + strategy.comfortAccelMps2 * STEP);
  } else {
    // Braking is progressive: comfortable unless contact is genuinely close.
    const rate = brakeRate(strategy, current, state.brakeTtcS, emergency);
    state.speedTarget = Number.isFinite(rate)
      ? Math.max(desired, Math.min(state.speedTarget, current + 1) - rate * STEP) : desired;
  }
  const reaction = state.reaction;
  const shifted = Math.abs(state.commandOffset) >= 0.4 && reaction !== "junction-hold";
  // Parked off its line at a junction (after a sidestep) the car holds the wheel straight, so the safety
  // probe does not swing the nose back across the traffic it just passed and pin it there.
  let displacedHold = false;
  if (reaction === "junction-hold") {
    const at = nearestPathPoint(player.path, player.x, player.z, player.cursor ?? 0);
    const here = player.path[at];
    const ahead = player.path[Math.min(player.path.length - 1, at + 4)];
    const skew = ahead === here ? 0 : Math.abs(angleDelta(player.heading, Math.atan2(ahead.x - here.x, ahead.z - here.z)));
    displacedHold = Math.hypot(here.x - player.x, here.z - player.z) > 1.2 || skew > 0.25;
  }
  return {
    transparent: false, report, reaction, threat: state.threat,
    steer: displacedHold ? 0 : steerOut.steer, targetSpeed: Math.max(0, state.speedTarget),
    shifted, displacedHold, offset: state.offset, factor: state.factor,
    ttcS: state.cache?.ttc ?? null, minClearanceM: state.cache?.minGap ?? null,
    contactT: state.contactT,
  };
}
