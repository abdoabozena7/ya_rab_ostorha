import { VEHICLE, clamp } from "./config.js";
import { angleDelta } from "./geometry.js";
const approach = (a, b, amount) => a + clamp(b - a, -amount, amount);
export function integrateVehicle(body, command, dt) {
  const spec = { ...VEHICLE, ...body.spec };
  const steer = approach(
    body.steer ?? 0,
    clamp(command.steer ?? 0, -spec.maxSteer, spec.maxSteer),
    spec.steerRate * dt,
  );
  const requested = clamp(
    command.targetSpeed ?? 0,
    -spec.reverseSpeed,
    body.maxSpeed ?? 13.89,
  );
  const reversing = (body.speed ?? 0) * requested < 0;
  const target = reversing ? 0 : requested;
  const slowing = Math.abs(target) < Math.abs(body.speed ?? 0) || reversing;
  const speed = approach(
    body.speed ?? 0,
    target,
    (slowing ? spec.braking : spec.acceleration) * dt,
  );
  const average = (speed + (body.speed ?? 0)) / 2;
  const beta = Math.atan(0.5 * Math.tan(steer));
  const yawRate = (average / spec.wheelbase) * Math.cos(beta) * Math.tan(steer);
  const middle = body.heading + (yawRate * dt) / 2 + beta;
  return {
    ...body,
    x: body.x + Math.sin(middle) * average * dt,
    z: body.z + Math.cos(middle) * average * dt,
    heading: body.heading + yawRate * dt,
    steer,
    speed,
  };
}
export function followPath(body, path, cursor = 0, steeringOnly = false) {
  if (path.length < 2)
    return { steer: 0, targetSpeed: 0, cursor, remaining: 0 };
  const wheelbase = body.spec?.wheelbase ?? VEHICLE.wheelbase;
  // Pure pursuit is derived at the rear axle, while the simulated pose is the
  // body centre. Using the centre here steers early and cuts the inner curb.
  const rear = {
    x: body.x - (Math.sin(body.heading) * wheelbase) / 2,
    z: body.z - (Math.cos(body.heading) * wheelbase) / 2,
  };
  let nearest = cursor,
    best = Infinity;
  for (
    let i = Math.max(0, cursor - 2);
    i < Math.min(path.length, cursor + 18);
    i++
  ) {
    const d = Math.hypot(path[i].x - rear.x, path[i].z - rear.z);
    if (d < best) {
      nearest = i;
      best = d;
    }
  }
  let target = nearest,
    length = 0;
  const lookahead = 2 + Math.abs(body.speed ?? 0) * 0.18;
  while (target < path.length - 1 && length < lookahead) {
    length += Math.hypot(
      path[target + 1].x - path[target].x,
      path[target + 1].z - path[target].z,
    );
    target++;
  }
  const point = path[target];
  const alpha = angleDelta(
    Math.atan2(point.x - rear.x, point.z - rear.z),
    body.heading,
  );
  const actualDistance = Math.max(
    1,
    Math.hypot(point.x - rear.x, point.z - rear.z),
  );
  const steer = Math.atan2(2 * wheelbase * Math.sin(alpha), actualDistance);
  if (steeringOnly) return { steer, cursor: nearest };
  let remaining = Math.hypot(
    path[nearest].x - body.x,
    path[nearest].z - body.z,
  );
  for (let i = nearest; i < path.length - 1; i++)
    remaining += Math.hypot(
      path[i + 1].x - path[i].x,
      path[i + 1].z - path[i].z,
    );
  const curvature = Math.abs(Math.tan(steer) / VEHICLE.wheelbase);
  const curveSpeed = Math.sqrt(2.5 / Math.max(0.008, curvature));
  let upcomingSpeed = body.maxSpeed,
    along = 0;
  for (let i = nearest + 1; i < path.length - 1 && along < 14; i++) {
    const a = path[i - 1],
      b = path[i],
      c = path[i + 1];
    const segment = Math.hypot(b.x - a.x, b.z - a.z);
    along += segment;
    const bend =
      Math.abs(
        angleDelta(
          Math.atan2(c.x - b.x, c.z - b.z),
          Math.atan2(b.x - a.x, b.z - a.z),
        ),
      ) / Math.max(0.1, segment);
    if (bend > 0.03)
      upcomingSpeed = Math.min(
        upcomingSpeed,
        Math.sqrt(2.1 / bend + 2 * 2.5 * Math.max(0, along - 2)),
      );
  }
  return {
    steer,
    targetSpeed: Math.min(
      body.maxSpeed,
      curveSpeed,
      upcomingSpeed,
      Math.sqrt(Math.max(0, remaining - 0.6) * 4),
    ),
    cursor: nearest,
    remaining,
  };
}
