import { clamp } from "../src/core/config.js";
import { distance, sweepSafe } from "../src/core/geometry.js";
import { followPath } from "../src/core/vehicle.js";

export const referenceTune = Object.freeze({ speed: 21, curved: 9, gain: 1.75 });

export function followConnectedReference(ego, path, cursor, radius) {
  const command = followPath(ego, path, cursor);
  const steer = clamp(command.steer / ego.spec.maxSteer, -.99, .99);
  const { speed, curved, gain } = referenceTune;
  const aim = Math.min(speed, command.targetSpeed * (radius ? 1.95 : gain),
    Math.abs(steer) > (radius ? .25 : .35) ? radius ? Math.sqrt(6.5 * radius) : curved : speed,
    Math.sqrt(9 * Math.max(0, distance(ego, path.at(-1)) - 1.7)));
  const brake = ego.speed > aim + .25 ? clamp((ego.speed - aim) / 2.4, 0, 1) : 0;
  return { cursor: command.cursor, action: { steer, gear: 1, brake,
    throttle: brake ? 0 : clamp((aim - ego.speed) * .7, 0, .95) } };
}

export function makeParallelPath(district, ego, road, junction, direction) {
  const origin = ego.z - ego.spec.wheelbase / 2;
  const target = road.fixed + direction * (road.width / 2 - ego.width / 2 - .7);
  const end = road.max - 14;
  const smooth = value => .5 - .5 * Math.cos(Math.PI * clamp(value, 0, 1));
  const span = junction.fixed - 9 - origin;
  if (span < 10) return [];
  const samples = Math.ceil((end - origin) / .35);
  const path = [];
  let body = ego;
  for (let i = 0; i <= samples; i++) {
    const z = origin + (end - origin) * i / samples;
    const entry = smooth((z - origin) / span), leave = smooth((z - junction.fixed - 8) / 22);
    const x = ego.x + entry * (target - ego.x) + leave * (road.fixed - road.laneOffsetM - target);
    if (i) {
      const prev = path.at(-1), heading = Math.atan2(x - prev.x, z - prev.z);
      const pose = { ...body, heading, x: x + Math.sin(heading) * ego.spec.wheelbase / 2,
        z: z + Math.cos(heading) * ego.spec.wheelbase / 2 };
      if (!sweepSafe(body, pose, district.statics, district.roads).safe) return [];
      body = pose;
    }
    path.push({ x, z });
  }
  return path;
}
