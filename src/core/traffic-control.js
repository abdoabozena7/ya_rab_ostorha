import { VEHICLE } from "./config.js";
import { distance, overlaps } from "./geometry.js";
import { integrateVehicle, followPath } from "./vehicle.js";
import { junctionLimit } from "./junctions.js";
import { signalSpeedLimit } from "./signals.js";
export function safeSpeed(world, car, command) {
  let speed = command.targetSpeed,
    reason = speed > 0 ? "driving" : "idle",
    blockedBy = null;
  if (speed <= 0) return { ...command, reason };
  let probe = { ...car, speed: Math.max(1.2, Math.abs(car.speed)) };
  const horizon = Math.max(
    5,
    (car.speed * car.speed) / (2 * VEHICLE.braking) + car.speed * 0.55 + 2,
  );
  let travelled = 0;
  const nearby = world.actorIndex
    .near(car, horizon + 8)
    .filter((a) => a !== car)
    .concat(world.staticIndex.near(car, horizon + 10));
  let probeCursor = car.cursor;
  for (let i = 0; i < 45 && travelled < horizon; i++) {
    const prediction = car.path.length
      ? followPath(probe, car.path, probeCursor, true)
      : command;
    probeCursor = prediction.cursor ?? probeCursor;
    const next = integrateVehicle(
      probe,
      { steer: prediction.steer, targetSpeed: probe.speed },
      0.16,
    );
    travelled += distance(probe, next);
    probe = next;
    const blocker = nearby.find((a) => overlaps(probe, a, 0.3));
    if (blocker) {
      speed = Math.min(
        speed,
        Math.sqrt(Math.max(0, travelled - 0.5) * 2 * 3.5),
      );
      reason = "yielding";
      blockedBy = blocker.id;
      break;
    }
  }
  const junction = junctionLimit(world, car);
  if (junction.limit < speed) {
    speed = junction.limit;
    reason = "junction";
    blockedBy = junction.blockedBy;
  }
  // A stopped car relinquishes its junction reservation at a red light.
  const signalCap = signalSpeedLimit(world, car);
  if (
    signalCap < speed ||
    (signalCap < Infinity && reason === "junction" && speed < 0.15)
  ) {
    speed = Math.min(speed, signalCap);
    reason = "red-light";
    blockedBy = null;
  }
  return { ...command, targetSpeed: speed, reason, blockedBy };
}
