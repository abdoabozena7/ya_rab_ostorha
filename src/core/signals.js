import { STEP } from "./config.js";

export function signalSpeedLimit(world, car) {
  if (car.reckless) return Infinity;
  let limit = Infinity;
  for (const junction of world.junctions) {
    if (Math.abs(junction.x) % 50 !== 0 || Math.abs(junction.z) % 20 !== 0)
      continue;
    const dx = junction.x - car.x,
      dz = junction.z - car.z;
    const forward = dx * Math.sin(car.heading) + dz * Math.cos(car.heading);
    const lateral = Math.abs(
      dx * Math.cos(car.heading) - dz * Math.sin(car.heading),
    );
    if (forward < 6 || forward > 24 || lateral > 3.7) continue;
    const vertical = Math.abs(Math.cos(car.heading)) > 0.75;
    const phase = (world.tick * STEP) % 24;
    const green = vertical ? phase < 10 : phase >= 12 && phase < 22;
    if (!green)
      limit = Math.min(limit, Math.sqrt(Math.max(0, forward - 7) * 5));
  }
  return limit;
}
