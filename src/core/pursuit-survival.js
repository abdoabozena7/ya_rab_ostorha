import { STEP, clamp } from "./config.js";
import { bodyOnRoad, distance, overlaps, pointOnRoad } from "./geometry.js";

const ticks = (seconds) => Math.round(seconds / STEP);
const POWERS = ["giant", "mine", "ghost", "pulse"];
export const SURVIVAL_REVIEW_TICKS = ticks(.46);
export const isSurvival = variant => variant === "survival";
export const isCityHunt = variant => variant === "hunt" || isSurvival(variant);

export function createSurvival(player, tick) {
  return {
    footprint: { length: player.length, width: player.width },
    active: null, held: null, pickup: null, devices: [], wrecks: new Map(), pendingWrecks: new Map(),
    effects: [], nextEffect: 0, nextPower: 0, nextPickupTick: tick, spawnCount: 0, heavyCount: 0,
    fireQueued: false, lastSolid: null,
  };
}

export function emitSurvival(world, type, at, kind, extra) {
  const { survival } = world.pursuit;
  survival.effects.push({ id: ++survival.nextEffect, tick: world.tick, x: at.x, z: at.z,
    type, kind, ...extra });
  if (survival.effects.length > 48) survival.effects.shift();
}

const token = (x, z, radius) => ({ type: "pedestrian", x, z, radius });

function isPhaseable(body) {
  return body.type === "vehicle" || body.kind === "barrier" || body.kind === "parked-vehicle";
}

export function survivalGhostPair(world, a, b) {
  if (world.pursuit?.survival?.active?.kind !== "ghost") return false;
  const { player } = world;
  return a === player ? isPhaseable(b) : b === player && isPhaseable(a);
}

function fits(world, candidate, ignore = () => false) {
  return bodyOnRoad(candidate, world.roads) &&
    !world.statics.some(body => !ignore(body) && overlaps(candidate, body)) &&
    !world.actors.some(body => body !== world.player && !ignore(body) && overlaps(candidate, body));
}

function playerPose({ x, z, heading }) { return { x, z, heading }; }

export function canEndSurvival(world) {
  const { survival } = world.pursuit;
  return survival.active?.kind !== "ghost" ||
    fits(world, world.player, actor => world.pursuit.patrols.has(actor) || survival.wrecks.has(actor));
}

// A terminal contact can occur while phasing through a second object. Restore
// solidity at a checked nearby point only in that case, never at the City spawn.
export function releaseSurvival(world) {
  const { player, pursuit } = world, { survival } = pursuit;
  if (survival.active?.kind === "ghost" && !canEndSurvival(world)) {
    const ignore = actor => pursuit.patrols.has(actor) || survival.wrecks.has(actor);
    const origin = playerPose(player);
    const choices = survival.lastSolid ? [survival.lastSolid] : [];
    for (const metres of [1, 2, 3.5, 5, 7.5, 10, 14]) for (let i = 0; i < 12; i++) {
      const bearing = player.heading + i * Math.PI / 6;
      choices.push({ ...origin, x: origin.x + Math.sin(bearing) * metres, z: origin.z + Math.cos(bearing) * metres });
    }
    const clear = choices.find(pose => fits(world, { ...player, ...pose }, ignore));
    if (!clear) return false;
    Object.assign(player, clear, { previous: { ...player.previous, ...clear }, speed: 0, arcadeSlip: 0 });
  }
  Object.assign(player, survival.footprint, { arcadeSlip: 0 });
  survival.active = survival.held = survival.pickup = null;
  survival.devices.length = 0;
  survival.fireQueued = false;
  return true;
}

export function updateSurvivalBeforeMotion(world) {
  const { pursuit: s, player, tick } = world, a = s.survival;
  for (const [body, until] of a.wrecks) {
    if (tick < until && distance(body, player) < 70) continue;
    removeActor(world, body);
    a.wrecks.delete(body);
  }
  const power = a.active;
  if (power && tick >= power.until && (power.kind !== "ghost" || fits(world, player))) {
    Object.assign(player, a.footprint);
    a.active = null;
  }
  if (!a.fireQueued) return;
  a.fireQueued = false;
  if (!a.held) return;
  const kind = a.held, behind = kind === "mine", heading = player.heading;
  const offset = (behind ? -1 : 1) * (player.length / 2 + .75);
  const x = player.x + Math.sin(heading) * offset, z = player.z + Math.cos(heading) * offset;
  a.held = null;
  a.devices.push({ id: a.nextEffect + 1, kind, x, z, heading,
    armedAt: tick + (behind ? ticks(.25) : 0), until: tick + ticks(behind ? 3.6 : .65) });
  emitSurvival(world, "use", { x, z }, kind);
}

function removeActor(world, actor) {
  const index = world.actors.indexOf(actor);
  if (index >= 0) world.actors.splice(index, 1);
}

export function disableSurvivalPatrol(world, body, reason, erased = false) {
  const { pursuit, tick } = world, { survival: a } = pursuit;
  const active = pursuit.patrols.delete(body);
  if (!active && !a.wrecks.has(body)) return;
  if (erased) {
    a.wrecks.delete(body);
    removeActor(world, body);
  } else {
    a.wrecks.set(body, tick + ticks(4.5));
    body.pursuitWreck = true;
    body.speed = 0;
    body.path = [];
    body.cursor = 0;
    body.reason = "wreck";
  }
  emitSurvival(world, "wreck", body, body.pursuitUnit ?? "cruiser", { reason, actorId: body.id });
}

function useDevices(world) {
  const { pursuit, tick } = world, { survival: a } = pursuit;
  for (let i = a.devices.length - 1; i >= 0; i--) {
    const device = a.devices[i], pulse = device.kind === "pulse";
    if (tick >= device.until) {
      a.devices.splice(i, 1);
      continue;
    }
    if (tick < device.armedAt) continue;
    const x = device.x, z = device.z;
    const distanceM = pulse ? 31 * STEP : 0;
    let hit = null, blocked = false;
    for (const fraction of pulse ? [0, .5, 1] : [1]) {
      device.x = x + Math.sin(device.heading) * distanceM * fraction;
      device.z = z + Math.cos(device.heading) * distanceM * fraction;
      const shape = token(device.x, device.z, pulse ? .52 : 1.6);
      blocked = pulse && (!pointOnRoad(shape, world.roads, .18) ||
        world.staticIndex.near(shape, 16).some(body => overlaps(shape, body)));
      if (blocked) break;
      for (const car of pursuit.patrols) if (overlaps(shape, car)) { hit = car; break; }
      if (hit) break;
    }
    if (hit) disableSurvivalPatrol(world, hit, device.kind);
    if (hit || blocked) {
      a.devices.splice(i, 1);
      emitSurvival(world, "burst", device, device.kind);
    }
  }
}

function dropPickup(world) {
  const { tick, player, pursuit: s } = world, a = s.survival;
  if (a.pickup && (tick >= a.pickup.until || distance(player, a.pickup) > 40)) {
    a.pickup = null;
    a.nextPickupTick = tick + ticks(1.5);
  }
  if (a.pickup || tick < a.nextPickupTick) return;
  const sx = Math.sin(player.heading), sz = Math.cos(player.heading);
  const ahead = d => ({ x: player.x + sx * d, z: player.z + sz * d, heading: player.heading });
  const free = p => {
    const shape = token(p.x, p.z, 1.05);
    return bodyOnRoad({ ...p, width: 2.15, length: 1.8 }, world.drivingRoads) &&
      !world.statics.some(body => overlaps(shape, body, .25)) &&
      !world.actors.some(body => overlaps(shape, body, .8));
  };
  const straight = [12, 16, 9, 20].map(ahead);
  const path = player.path.slice(player.cursor).filter(p => distance(p, player) >= 8 &&
    distance(p, player) <= 23 && (p.x - player.x) * sx + (p.z - player.z) * sz > 3);
  const spot = straight.find(free) ?? path.find(free);
  if (spot) a.pickup = { x: spot.x, z: spot.z, kind: POWERS[a.nextPower++ % POWERS.length], until: tick + ticks(11) };
  else a.nextPickupTick = tick + ticks(.75);
}

export function updateSurvivalAfterMotion(world) {
  const { player, pursuit: s, tick } = world, a = s.survival;
  for (const [actor, crash] of a.pendingWrecks) disableSurvivalPatrol(world, actor, crash.reason, crash.erased);
  a.pendingWrecks.clear();
  if (s.metrics.terminalCause) return;
  useDevices(world);
  const pickup = a.pickup;
  if (pickup && overlaps(player, token(pickup.x, pickup.z, .9))) {
    const { kind } = pickup, charge = kind === "mine" || kind === "pulse";
    const giant = { ...player, length: a.footprint.length * 1.45, width: a.footprint.width * 1.45 };
    if (!(charge && a.held) && !(kind === "giant" && !fits(world, giant)) &&
        !(a.active?.kind === "ghost" && kind === "giant" && !fits(world, player))) {
      if (charge) a.held = kind;
      else {
        a.active = { kind, until: tick + ticks(kind === "ghost" ? 4.25 : 3.55) };
        const { length, width } = kind === "giant" ? giant : a.footprint;
        Object.assign(player, { length, width });
      }
      emitSurvival(world, "pickup", pickup, kind);
      a.pickup = null;
      a.nextPickupTick = tick + ticks(2.6);
    }
  }
  if (a.active?.kind === "ghost" && fits(world, player)) a.lastSolid = playerPose(player);
  dropPickup(world);
}

export function survivalSnapshot(state, tick) {
  const a = state.survival;
  return {
    active: a.active && { kind: a.active.kind, timeLeftS: Math.max(0, (a.active.until - tick) * STEP) },
    held: a.held, spawned: a.spawnCount, wrecks: a.wrecks.size, heavy: a.heavyCount,
    impact: state.metrics.terminalCause, review: state.reviewUntilTick > tick,
  };
}
