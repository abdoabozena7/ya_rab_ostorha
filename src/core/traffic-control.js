import { VEHICLE } from "./config.js";
import { overlaps } from "./geometry.js";
import { integrateVehicle, followPath, vehicleProbe } from "./vehicle.js";
import { junctionLimit } from "./junctions.js";
import { signalSpeedLimit } from "./signals.js";
import { isCityHunt, survivalGhostPair } from "./pursuit-survival.js";
const distantSafeCache = new WeakMap();

export function safeSpeed(world, car, command, usePlannedPath = true) {
  const district = world.environment === "egypt" || world.environment === "metro";
  let speed = command.targetSpeed,
    reason = district
      ? command.reason ?? (speed > 0 ? "driving" : "idle")
      : speed > 0 ? "driving" : "idle",
    blockedBy = district ? command.blockedBy ?? null : null;
  const softStop = district && speed === 0 && car.speed > 0 &&
    Number.isFinite(command.decelerationMps2) &&
    command.decelerationMps2 > 0 && command.decelerationMps2 < VEHICLE.braking;
  const survival = world.pursuit?.phase === "running" ? world.pursuit.survival : null;
  const manual = survival && car === world.player && world.mode === "manual" && speed >= 0;
  const giant = survival?.active?.kind === "giant" && car === world.player && speed >= 0;
  function danger(body) {
    if (body === car || (survival && survivalGhostPair(world, car, body))) return false;
    if ((manual || giant) && (body.pursuitWreck || world.pursuit.patrols.has(body))) return false;
    return !manual || body.type !== "static";
  }
  if (speed < 0 && car === world.player && world.pursuit?.phase === "running" && isCityHunt(world.pursuit.variant)) {
    const probe = vehicleProbe(car, -Math.max(1.2, -car.speed));
    const horizon = 1.1 + probe.speed ** 2 / (2 * VEHICLE.braking);
    const bodies = world.actorIndex.near(car, horizon + 6).concat(world.staticIndex.near(car, horizon + 14)).filter(danger);
    const backwards = { steer: command.steer, targetSpeed: probe.speed };
    for (let travel = 0; travel < horizon;) {
      const { x, z } = probe;
      integrateVehicle(probe, backwards, .10, probe);
      travel += Math.hypot(probe.x - x, probe.z - z);
      const blocker = bodies.find(body => overlaps(probe, body, .12) && !overlaps(car, body) &&
        Math.hypot(probe.x - body.x, probe.z - body.z) < Math.hypot(car.x - body.x, car.z - body.z));
      if (blocker) {
        return { ...command, targetSpeed: -Math.min(-speed, Math.sqrt(7 * Math.max(0, travel - .45))),
          reason: "yielding", blockedBy: blocker.id };
      }
    }
    return { ...command, reason: command.reason ?? "reversing" };
  }
  let physicalStop = false;
  if (speed <= 0 && !softStop) return { ...command, reason };
  const distantV5Traffic = (world.config?.cityVersion ?? 0) >= 5 &&
    world.pursuit?.gta?.config?.tacticalPursuit === "gta-tactical-v1" &&
    car !== world.player && !world.pursuit.patrols.has(car) &&
    Math.hypot(car.x - world.player.x, car.z - world.player.z) > 85;
  if (distantV5Traffic) {
    const entry = distantSafeCache.get(car);
    if (entry && entry.until > world.tick && Math.abs(entry.req - speed) < 0.4) {
      return {
        ...command,
        targetSpeed: Math.min(speed, entry.speed),
        reason: entry.reason,
        blockedBy: entry.blockedBy,
      };
    }
  }
  const probe = vehicleProbe(car, Math.max(1.2, Math.abs(car.speed)));
  const horizon = Math.max(
    5,
    (car.speed * car.speed) / (2 * VEHICLE.braking) + car.speed * 0.55 + 2,
  );
  let travelled = 0;
  const nearby = world.actorIndex
    .near(car, horizon + 8)
    .concat(world.staticIndex.near(car, horizon + 10)).filter(danger);
  let probeCursor = car.cursor;
  const probeCommand = { steer: 0, targetSpeed: 0, arcadeDrift: command.arcadeDrift };
  for (let i = 0; i < 45 && travelled < horizon; i++) {
    const prediction = usePlannedPath && car.path.length
      ? followPath(probe, car.path, probeCursor, true)
      : command;
    probeCursor = prediction.cursor ?? probeCursor;
    const x = probe.x, z = probe.z;
    probeCommand.steer = prediction.steer;
    probeCommand.targetSpeed = probe.speed;
    integrateVehicle(probe, probeCommand, 0.16, probe);
    travelled += Math.hypot(x - probe.x, z - probe.z);
    const blocker = nearby.find((a) => overlaps(probe, a, 0.3));
    if (blocker) {
      const limit = Math.sqrt(Math.max(0, travelled - 0.5) * 2 * 3.5);
      const softStoppingDistance = softStop
        ? car.speed ** 2 / (2 * command.decelerationMps2) + car.speed * 0.16 + 0.5 : 0;
      if (!district || limit < speed || (softStop && travelled <= softStoppingDistance)) {
        speed = Math.min(speed, limit);
        reason = "yielding";
        blockedBy = blocker.id;
        physicalStop = softStop;
      }
      break;
    }
  }
  const junction = junctionLimit(world, car);
  if (junction.limit < speed || (softStop && junction.limit < car.speed)) {
    speed = Math.min(speed, junction.limit);
    reason = "junction";
    blockedBy = junction.blockedBy;
    physicalStop = softStop;
  }
  // A stopped car relinquishes its junction reservation at a red light.
  const signalCap = signalSpeedLimit(world, car);
  if (
    signalCap < speed ||
    (signalCap < Infinity && reason === "junction" && speed < 0.15) ||
    (softStop && signalCap < car.speed)
  ) {
    speed = Math.min(speed, signalCap);
    reason = "red-light";
    blockedBy = null;
    physicalStop = softStop;
  }
  if (distantV5Traffic) {
    distantSafeCache.set(car, {
      until: world.tick + (reason === "driving" ? 4 : 1),
      req: command.targetSpeed,
      speed,
      reason,
      blockedBy,
    });
  }
  const result = { ...command, targetSpeed: speed, reason, blockedBy };
  if (district && (speed < command.targetSpeed || physicalStop))
    delete result.decelerationMps2;
  return result;
}
