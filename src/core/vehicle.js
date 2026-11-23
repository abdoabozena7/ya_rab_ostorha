import { STEP, VEHICLE, clamp } from "./config.js";
import { angleDelta, corners, distance, interpolate, overlaps } from "./geometry.js";
import { PLAYER_VEHICLE } from "./vehicle-spec.js";
const approach = (a, b, amount) => a + clamp(b - a, -amount, amount);
const fixedPathGeometry = new WeakMap();
const immutablePaths = new WeakSet();
const contactSlide = new WeakMap();

export function copyVehicleMotion(source, target) {
  if (contactSlide.has(source)) contactSlide.set(target, contactSlide.get(source));
  else contactSlide.delete(target);
  return target;
}

export function clearVehicleMotion(body) {
  contactSlide.delete(body);
}

export function vehicleVelocity(body) {
  const s = Math.sin(body.heading ?? 0), c = Math.cos(body.heading ?? 0);
  const lateral = contactSlide.get(body) ?? 0;
  return { x: s * (body.speed ?? 0) + c * lateral,
    z: c * (body.speed ?? 0) - s * lateral };
}

export function markImmutablePath(path) {
  for (let i = 0; i < path.length; i++) Object.freeze(path[i]);
  Object.freeze(path);
  immutablePaths.add(path);
  return path;
}

export function hasImmutablePathPoints(path) {
  if (immutablePaths.has(path)) return true;
  if (!Object.isFrozen(path)) return false;
  // A frozen array can still contain mutable points or accessor properties.
  for (let i = 0; i < path.length; i++) {
    const entry = Object.getOwnPropertyDescriptor(path, i);
    if (!entry || !Object.hasOwn(entry, "value") || !Object.isFrozen(entry.value))
      return false;
    const x = Object.getOwnPropertyDescriptor(entry.value, "x");
    const z = Object.getOwnPropertyDescriptor(entry.value, "z");
    if (typeof x?.value !== "number" || typeof z?.value !== "number") return false;
  }
  immutablePaths.add(path);
  return true;
}

function immutablePathGeometry(path) {
  const cached = fixedPathGeometry.get(path);
  if (cached) return cached;
  if (!hasImmutablePathPoints(path)) return null;
  const lengths = new Float64Array(path.length - 1);
  const headings = new Float64Array(lengths.length);
  const bends = new Float64Array(lengths.length);
  const upcoming = [];
  for (let i = 0; i < path.length - 1; i++) {
    const dx = path[i + 1].x - path[i].x, dz = path[i + 1].z - path[i].z;
    lengths[i] = Math.hypot(dx, dz);
    headings[i] = Math.atan2(dx, dz);
  }
  for (let i = 1; i < path.length - 1; i++)
    bends[i] = Math.abs(angleDelta(headings[i], headings[i - 1])) / Math.max(.1, lengths[i - 1]);
  const geometry = { lengths, bends, upcoming };
  fixedPathGeometry.set(path, geometry);
  return geometry;
}
// A probe needs the plant inputs and footprint, not its actor's whole route
// and history. A caller can advance this private pose in place.
export function vehicleProbe(body, speed) {
  return copyVehicleMotion(body, { x: body.x, z: body.z, heading: body.heading, speed, steer: body.steer,
    maxSpeed: body.maxSpeed, spec: body.spec, type: body.type,
    length: body.length, width: body.width, radius: body.radius,
    ...(body.arcadeSlip ? { arcadeSlip: body.arcadeSlip } : {}),
    ...(body.realisticDynamics !== undefined ? { realisticDynamics: body.realisticDynamics } : {}),
    ...(body.chaseSlipRad !== undefined ? { chaseSlipRad: body.chaseSlipRad } : {}) });
}

export function integrateVehicle(body, command, dt, out = null) {
  if (!Number.isFinite(dt) || dt < 0)
    throw new RangeError("Vehicle integration needs a nonnegative step");
  const spec = body.spec == null ? VEHICLE : { ...VEHICLE, ...body.spec };
  const realistic = spec.realisticDynamics === true;
  const explicitDeceleration = Object.prototype.hasOwnProperty.call(command, "decelerationMps2");
  if (explicitDeceleration && (!Number.isFinite(spec.braking) || spec.braking <= 0 ||
      !Number.isFinite(command.decelerationMps2) ||
      command.decelerationMps2 <= 0 || command.decelerationMps2 > spec.braking))
    throw new RangeError("Explicit vehicle deceleration must be finite, positive and at most spec.braking");
  const absSpeed = Math.abs(body.speed ?? 0);
  const effectiveSteerRate = realistic && absSpeed > 11
    ? spec.steerRate * clamp(1.08 - 0.011 * Math.max(0, absSpeed - 11), 0.72, 1.0)
    : spec.steerRate;
  const effectiveMaxSteer = realistic && absSpeed > 11
    ? spec.maxSteer * clamp(1.0 - 0.009 * Math.max(0, absSpeed - 14), 0.74, 1.0)
    : spec.maxSteer;
  const steer = approach(
    body.steer ?? 0,
    clamp(Number.isFinite(command.steer) ? command.steer : 0, -effectiveMaxSteer, effectiveMaxSteer),
    effectiveSteerRate * dt,
  );
  const requested = clamp(
    Number.isFinite(command.targetSpeed) ? command.targetSpeed : 0,
    -spec.reverseSpeed,
    body.maxSpeed ?? 13.89,
  );
  const coastingDrag = realistic &&
    command.coasting === true &&
    !explicitDeceleration &&
    Math.abs(requested) < 0.05 &&
    absSpeed > 0.2;
  const braking = explicitDeceleration
    ? command.decelerationMps2
    : coastingDrag
      ? 1.65 + 0.0018 * (body.speed ?? 0) ** 2
      : spec.braking;
  const reversing = (body.speed ?? 0) * requested < 0;
  const target = reversing ? 0 : requested;
  const slowing = Math.abs(target) < absSpeed || reversing;
  const rate = slowing ? braking : spec.acceleration;
  const grip = realistic && Number.isFinite(spec.tireGripMps2) && spec.tireGripMps2 > 0
    ? spec.tireGripMps2 : Infinity;
  const speed = approach(
    body.speed ?? 0,
    target,
    Math.min(rate, grip) * dt,
  );
  const average = (speed + (body.speed ?? 0)) / 2;
  const tangent = Math.tan(steer);
  let beta = Math.atan(0.5 * tangent);
  let yawRate = (average / spec.wheelbase) * Math.cos(beta) * tangent;
  if (realistic && Number.isFinite(spec.tireGripMps2) && spec.tireGripMps2 > 0) {
    const longitudinal = dt > 0 ? Math.abs(speed - (body.speed ?? 0)) / dt : 0;
    const lateralBudget = Math.sqrt(Math.max(0, spec.tireGripMps2 ** 2 - longitudinal ** 2));
    const demanded = Math.abs(average * yawRate);
    if (demanded > lateralBudget) {
      const scale = lateralBudget / demanded;
      yawRate *= scale;
      beta = Math.atan(Math.tan(beta) * scale);
    }
  }
  const drift = command.arcadeDrift === true && average > 0;
  const slip = drift
    ? (body.arcadeSlip ?? 0) + (clamp(-yawRate * speed * .036, -.32, .32) - (body.arcadeSlip ?? 0)) * (1 - Math.exp(-7 * dt))
    : 0;
  let nextChaseSlip = 0;
  if (realistic) {
    const latAccel = average * yawRate;
    const targetChaseSlip = Math.abs(latAccel) > 3.8 && average > 6
      ? clamp(-Math.sign(latAccel) * (Math.abs(latAccel) - 3.8) * 0.016, -0.14, 0.14)
      : 0;
    const prevChaseSlip = body.chaseSlipRad ?? 0;
    const rawChaseSlip = prevChaseSlip + (targetChaseSlip - prevChaseSlip) * (1 - Math.exp(-8.5 * dt));
    nextChaseSlip = Math.abs(rawChaseSlip) < 1e-12 ? 0 : rawChaseSlip;
  }
  const middle = realistic
    ? body.heading + (yawRate * dt) / 2 + beta + slip + nextChaseSlip
    : body.heading + (yawRate * dt) / 2 + beta + slip;
  const midHeading = body.heading + yawRate * dt / 2;
  const result = out ?? { ...body };
  result.x = body.x + Math.sin(middle) * average * dt;
  result.z = body.z + Math.cos(middle) * average * dt;
  result.heading = body.heading + yawRate * dt;
  result.steer = steer;
  result.speed = speed;
  if (drift || body.arcadeSlip !== undefined) result.arcadeSlip = slip;
  if (realistic) result.chaseSlipRad = nextChaseSlip;
  if (spec.contactResponse === "inelastic-slide-v1") {
    const oldSlide = contactSlide.get(body) ?? 0;
    const slide = approach(oldSlide, 0, 3 * dt);
    result.x += Math.cos(midHeading) * (oldSlide + slide) * dt / 2;
    result.z -= Math.sin(midHeading) * (oldSlide + slide) * dt / 2;
    if (slide) contactSlide.set(result, slide);
    else contactSlide.delete(result);
  }
  return result;
}

/** Actual zero-gap contact is separate from the ordinary 0.12 m safety guard. */
export function resolveVehicleContact(before, proposed, obstacle, dt = STEP) {
  if (!Number.isFinite(dt) || dt <= 0)
    throw new RangeError("Contact needs a positive step");
  if (overlaps(before, obstacle)) return null;
  const travel =
    distance(before, proposed) +
    Math.abs(angleDelta(proposed.heading, before.heading)) *
      Math.hypot(before.length, before.width) / 2;
  if (travel < 1e-10) return null;
  const steps = Math.max(1, Math.ceil(travel / 0.04));
  let low = 0;
  let high = null;
  for (let i = 1; i <= steps; i++) {
    if (overlaps(interpolate(before, proposed, i / steps), obstacle)) {
      high = i / steps;
      low = (i - 1) / steps;
      break;
    }
  }
  if (high === null) return null;
  for (let i = 0; i < 32; i++) {
    const middle = (low + high) / 2;
    if (overlaps(interpolate(before, proposed, middle), obstacle)) high = middle;
    else low = middle;
  }
  const body = interpolate(before, proposed, low);
  const a = corners(body);
  const b = corners(obstacle);
  let separation = -Infinity;
  let normal;
  for (const shape of [body, obstacle]) {
    for (const offset of [0, Math.PI / 2]) {
      const axis = {
        x: Math.sin((shape.heading ?? 0) + offset),
        z: Math.cos((shape.heading ?? 0) + offset),
      };
      const pa = a.map((p) => p.x * axis.x + p.z * axis.z);
      const pb = b.map((p) => p.x * axis.x + p.z * axis.z);
      const forwardGap = Math.min(...pb) - Math.max(...pa);
      const reverseGap = Math.min(...pa) - Math.max(...pb);
      const gap = Math.max(forwardGap, reverseGap);
      if (gap > separation) {
        separation = gap;
        const sign = forwardGap >= reverseGap ? 1 : -1;
        normal = { x: axis.x * sign, z: axis.z * sign };
      }
    }
  }
  const forward = normal.x * Math.sin(body.heading) + normal.z * Math.cos(body.heading);
  const right = normal.x * Math.cos(body.heading) - normal.z * Math.sin(body.heading);
  const side = Math.abs(forward) >= Math.abs(right)
    ? forward > 0 ? "front" : "rear"
    : right > 0 ? "right" : "left";
  const obstacleSpeed = obstacle.speed ?? 0;
  const vx = (proposed.x - before.x) / dt - Math.sin(obstacle.heading ?? 0) * obstacleSpeed;
  const vz = (proposed.z - before.z) / dt - Math.cos(obstacle.heading ?? 0) * obstacleSpeed;
  const closingSpeedMps = Math.max(0, vx * normal.x + vz * normal.z);
  if (before.spec?.contactResponse === "inelastic-slide-v1") {
    const incoming = { x: (proposed.x - before.x) / dt, z: (proposed.z - before.z) / dt };
    const velocity = { x: incoming.x - normal.x * closingSpeedMps,
      z: incoming.z - normal.z * closingSpeedMps };
    // Other City actors remain kinematic obstacles. A moving obstacle may
    // constrain velocity, but must not inject kinetic energy into the SUV.
    const incomingSpeed = Math.hypot(incoming.x, incoming.z);
    const outgoingSpeed = Math.hypot(velocity.x, velocity.z);
    if (outgoingSpeed > incomingSpeed) {
      velocity.x *= incomingSpeed / outgoingSpeed;
      velocity.z *= incomingSpeed / outgoingSpeed;
    }
    const remaining = dt * (1 - low);
    const slid = { ...body, x: body.x + velocity.x * remaining,
      z: body.z + velocity.z * remaining };
    const accepted = overlaps(slid, obstacle) ? body : slid;
    const s = Math.sin(body.heading), c = Math.cos(body.heading);
    const response = { ...accepted, speed: velocity.x * s + velocity.z * c,
      reason: "vehicle-contact", blockedBy: obstacle.id };
    if (Math.abs(response.speed) < 1e-12) response.speed = 0;
    const slide = velocity.x * c - velocity.z * s;
    if (Math.abs(slide) > 1e-12) contactSlide.set(response, slide);
    const mass = Number.isFinite(before.spec.massKg) && before.spec.massKg > 0
      ? before.spec.massKg : PLAYER_VEHICLE.massKg;
    const otherMass = obstacle.type === "static" ? Infinity
      : obstacle.spec?.massKg ?? (obstacle.kind === "tuktuk" ? 620 : 1450);
    const reducedMass = Number.isFinite(otherMass) && otherMass > 0
      ? mass * otherMass / (mass + otherMass) : mass;
    return { body: response, hitId: obstacle.id, side, normal, closingSpeedMps,
      energyJ: 0.5 * reducedMass * closingSpeedMps ** 2,
      contactFraction: low,
      proposedTravelM: distance(before, proposed) };
  }
  return {
    body: { ...body, speed: 0, reason: "vehicle-contact", blockedBy: obstacle.id },
    hitId: obstacle.id,
    side,
    normal,
    closingSpeedMps,
    energyJ: 0.5 * PLAYER_VEHICLE.massKg * closingSpeedMps ** 2,
    proposedTravelM: distance(before, proposed),
  };
}
// Axis differences only reject points that cannot beat the current minimum.
// The winner and ties still use the original hypot and first-sample order.
export function nearestPathPoint(path, x, z, cursor, fallback = cursor) {
  const end = Math.min(path.length, cursor + 18);
  let nearest = fallback,
    best = Infinity;
  for (let i = Math.max(0, cursor - 2); i < end; i++) {
    const dx = path[i].x - x, dz = path[i].z - z;
    if (Math.abs(dx) > best || Math.abs(dz) > best) continue;
    const d = Math.hypot(dx, dz);
    if (d < best) {
      nearest = i;
      best = d;
    }
  }
  return nearest;
}

export function followPath(body, path, cursor = 0, steeringOnly = false, maxRemaining = Infinity) {
  if (path.length < 2)
    return { steer: 0, targetSpeed: 0, cursor, remaining: 0 };
  const wheelbase = body.spec?.wheelbase ?? VEHICLE.wheelbase;
  const fixed = immutablePathGeometry(path);
  // Pure pursuit is derived at the rear axle, while the simulated pose is the
  // body centre. Using the centre here steers early and cuts the inner curb.
  const x = body.x - (Math.sin(body.heading) * wheelbase) / 2;
  const z = body.z - (Math.cos(body.heading) * wheelbase) / 2;
  const nearest = nearestPathPoint(path, x, z, cursor);
  let target = nearest,
    length = 0;
  const lookahead = 2 + Math.abs(body.speed ?? 0) * 0.18;
  while (target < path.length - 1 && length < lookahead) {
    length += fixed ? fixed.lengths[target] : Math.hypot(
      path[target + 1].x - path[target].x,
      path[target + 1].z - path[target].z,
    );
    target++;
  }
  const point = path[target];
  const alpha = angleDelta(
    Math.atan2(point.x - x, point.z - z),
    body.heading,
  );
  const actualDistance = Math.max(
    1,
    Math.hypot(point.x - x, point.z - z),
  );
  const steer = Math.atan2(2 * wheelbase * Math.sin(alpha), actualDistance);
  if (steeringOnly) return { steer, cursor: nearest };
  let remaining = Math.hypot(
    path[nearest].x - body.x,
    path[nearest].z - body.z,
  );
  // Do not subtract prefixes: adding the same segments to this live first
  // distance in order preserves even its last bits.
  if (fixed) {
    const lengths = fixed.lengths;
    for (let i = nearest; i < lengths.length && remaining < maxRemaining; i++) remaining += lengths[i];
  } else {
    for (let i = nearest; i < path.length - 1 && remaining < maxRemaining; i++) remaining += Math.hypot(
      path[i + 1].x - path[i].x,
      path[i + 1].z - path[i].z,
    );
  }
  const curvature = Math.abs(Math.tan(steer) / VEHICLE.wheelbase);
  const curveSpeed = Math.sqrt(2.5 / Math.max(0.008, curvature));
  let upcomingSpeed = fixed?.upcoming[nearest];
  if (upcomingSpeed === undefined) {
    upcomingSpeed = Infinity;
    let along = 0;
    for (let i = nearest + 1; i < path.length - 1 && along < 14; i++) {
      const a = path[i - 1], b = path[i], c = path[i + 1];
      const segment = fixed ? fixed.lengths[i - 1] : Math.hypot(b.x - a.x, b.z - a.z);
      along += segment;
      const bend = fixed ? fixed.bends[i] :
        Math.abs(angleDelta(
          Math.atan2(c.x - b.x, c.z - b.z),
          Math.atan2(b.x - a.x, b.z - a.z),
        )) / Math.max(0.1, segment);
      if (bend > 0.03)
        upcomingSpeed = Math.min(
          upcomingSpeed,
          Math.sqrt(2.1 / bend + 2 * 2.5 * Math.max(0, along - 2)),
        );
    }
    if (fixed) fixed.upcoming[nearest] = upcomingSpeed;
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
