import { STEP, VEHICLE } from "./config.js";
import { overlaps } from "./geometry.js";
import { gtaLineClear } from "./pursuit-response.js";
import { integrateVehicle, vehicleProbe } from "./vehicle.js";

const STRIDE = 3 * STEP;
const REACTION_S = .18;

export function timedCivilianYield(world, car, command) {
  if (command.targetSpeed <= 0 || car.speed < 0) return command;
  const braking = car.spec?.braking ?? VEHICLE.braking;
  const acceleration = car.spec?.acceleration ?? VEHICLE.acceleration;
  const projectedPace = Math.max(car.speed, Math.min(command.targetSpeed, car.speed + acceleration * REACTION_S));
  const horizon = REACTION_S + projectedPace / braking;
  const stopM = projectedPace * REACTION_S + projectedPace ** 2 / (2 * braking);
  const reach = Math.hypot(car.width, car.length) / 2 + stopM + 4.5 * horizon + .4;
  const walkers = [];
  for (const person of world.actorIndex.near(car, reach)) {
    if (person.type !== "pedestrian") continue;
    const dx = person.x - car.x, dz = person.z - car.z, gap = Math.hypot(dx, dz);
    if (gap > reach) continue;
    walkers.push({ person, dx, dz, gap, vx: Math.sin(person.heading) * person.speed,
      vz: Math.cos(person.heading) * person.speed, occluded: false });
  }
  if (!walkers.length) return command;

  const probe = vehicleProbe(car, car.speed);
  const brake = { ...command, targetSpeed: 0, decelerationMps2: braking };
  const point = { type: "pedestrian", x: 0, z: 0, radius: 0 };
  for (let time = 0; time < horizon;) {
    // Keep the original action when it leaves a clear, time-matched stopping path.
    const reacting = time < REACTION_S;
    const next = Math.min(time + STRIDE, reacting ? REACTION_S : horizon), dt = next - time;
    integrateVehicle(probe, reacting ? command : brake, dt, probe);
    time = next;
    for (const walker of walkers) {
      if (walker.occluded) continue;
      const { person, vx, vz, dx, dz, gap } = walker;
      point.x = person.x + vx * time;
      point.z = person.z + vz * time;
      point.radius = person.radius;
      // Bound the motion between samples, not the entire walker path at every instant.
      const margin = .08 + dt * .5 * (projectedPace + person.speed);
      if (!overlaps(probe, point, margin)) continue;
      if (gtaLineClear(world, car, dx, dz, gap))
        return { ...brake, reason: "pedestrian-yield", blockedBy: person.id };
      walker.occluded = true;
    }
  }
  return command;
}
