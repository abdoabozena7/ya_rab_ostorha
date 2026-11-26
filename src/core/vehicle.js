import { STEP, VEHICLE, clamp } from "./config.js";
import { angleDelta, corners, distance, interpolate, overlaps } from "./geometry.js";
import { KING_LONG_MICROBUS, KING_LONG_MICROBUS_ID, playerVehicleDimensions } from "./vehicle-spec.js";
import {
  WHEEL_SCRUB_MODE,
  applyScrapingContactResponse,
  copyContactSlide,
  deleteContactSlide,
  getContactSlide,
  registerContactContext,
  resolveObstacleContactMechanics,
  setContactSlide,
} from "./wheel-interaction-physics.js";
const approach = (a, b, amount) => a + clamp(b - a, -amount, amount);
const fixedPathGeometry = new WeakMap();
const immutablePaths = new WeakSet();

export function copyVehicleMotion(source, target) {
  return copyContactSlide(source, target);
}

export function clearVehicleMotion(body) {
  deleteContactSlide(body);
}

export function vehicleVelocity(body) {
  const s = Math.sin(body.heading ?? 0), c = Math.cos(body.heading ?? 0);
  const lateral = getContactSlide(body);
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
  const spec = body.spec && typeof body.spec === "object" && body.spec.wheelInteractionPhysics !== undefined
    ? body.spec
    : body.spec;
  return copyVehicleMotion(body, { x: body.x, z: body.z, heading: body.heading, speed, steer: body.steer,
    maxSpeed: body.maxSpeed, spec, type: body.type,
    length: body.length, width: body.width, radius: body.radius,
    ...(body.vehicleModel === KING_LONG_MICROBUS_ID ? { vehicleModel: body.vehicleModel } : {}),
    ...(body.arcadeSlip ? { arcadeSlip: body.arcadeSlip } : {}),
    ...(body.realisticDynamics !== undefined ? { realisticDynamics: body.realisticDynamics } : {}),
    ...(body.wheelInteractionPhysics !== undefined ? { wheelInteractionPhysics: body.wheelInteractionPhysics } : {}),
    ...(body.chaseSlipRad !== undefined ? { chaseSlipRad: body.chaseSlipRad } : {}) });
}

export function integrateVehicle(body, command, dt, out = null) {
  if (!Number.isFinite(dt) || dt < 0)
    throw new RangeError("Vehicle integration needs a nonnegative step");
  const rawSpec = body.spec;
  const realistic = rawSpec?.realisticDynamics === true;
  const specBraking = rawSpec?.braking !== undefined ? rawSpec.braking : VEHICLE.braking;
  const specSteerRate = rawSpec?.steerRate !== undefined ? rawSpec.steerRate : VEHICLE.steerRate;
  const specMaxSteer = rawSpec?.maxSteer !== undefined ? rawSpec.maxSteer : VEHICLE.maxSteer;
  const specReverseSpeed = rawSpec?.reverseSpeed !== undefined ? rawSpec.reverseSpeed : VEHICLE.reverseSpeed;
  const specAcceleration = rawSpec?.acceleration !== undefined ? rawSpec.acceleration : VEHICLE.acceleration;
  const specWheelbase = rawSpec?.wheelbase !== undefined ? rawSpec.wheelbase : VEHICLE.wheelbase;
  const specTireGrip = rawSpec?.tireGripMps2 !== undefined ? rawSpec.tireGripMps2 : VEHICLE.tireGripMps2;
  const specContactResponse = rawSpec?.contactResponse !== undefined ? rawSpec.contactResponse : VEHICLE.contactResponse;
  const explicitDeceleration = Object.prototype.hasOwnProperty.call(command, "decelerationMps2");
  if (explicitDeceleration && (!Number.isFinite(specBraking) || specBraking <= 0 ||
      !Number.isFinite(command.decelerationMps2) ||
      command.decelerationMps2 <= 0 || command.decelerationMps2 > specBraking))
    throw new RangeError("Explicit vehicle deceleration must be finite, positive and at most spec.braking");
  const absSpeed = Math.abs(body.speed ?? 0);
  const effectiveSteerRate = realistic && absSpeed > 11
    ? specSteerRate * clamp(1.08 - 0.011 * Math.max(0, absSpeed - 11), 0.72, 1.0)
    : specSteerRate;
  const effectiveMaxSteer = realistic && absSpeed > 11
    ? specMaxSteer * clamp(1.0 - 0.009 * Math.max(0, absSpeed - 14), 0.74, 1.0)
    : specMaxSteer;
  const steer = approach(
    body.steer ?? 0,
    clamp(Number.isFinite(command.steer) ? command.steer : 0, -effectiveMaxSteer, effectiveMaxSteer),
    effectiveSteerRate * dt,
  );
  const rawSurface = realistic && command?.surface && typeof command.surface === "object"
    ? command.surface
    : null;
  const surfaceKind = rawSurface ? (rawSurface.surfaceKind ?? rawSurface.kind ?? "asphalt") : "asphalt";
  const surfGripMult = rawSurface
    ? clamp(Number.isFinite(rawSurface.gripMultiplier) ? rawSurface.gripMultiplier : 1, 0.3, 1.2)
    : 1;
  const surfGradeSin = rawSurface
    ? clamp(Number.isFinite(rawSurface.gradeSin) ? rawSurface.gradeSin : 0, -0.35, 0.35)
    : 0;
  const surfRollingDrag = rawSurface && Number.isFinite(rawSurface.rollingDragMps2)
    ? Math.max(0, rawSurface.rollingDragMps2)
    : 0;
  const surfHydroCoeff = rawSurface && Number.isFinite(rawSurface.hydroDragCoeff)
    ? Math.max(0, rawSurface.hydroDragCoeff)
    : 0;
  const hasActiveSurface = Boolean(
    rawSurface &&
      (surfGripMult !== 1 ||
        surfGradeSin !== 0 ||
        surfRollingDrag !== 0 ||
        surfHydroCoeff !== 0 ||
        surfaceKind === "water"),
  );

  const microbus = body.vehicleModel === KING_LONG_MICROBUS_ID;
  const allowSlopeOverspeed = !microbus && rawSpec?.hardSpeedCap !== true;
  const maxForwardSpeed = (body.maxSpeed ?? 13.89) * (allowSlopeOverspeed && hasActiveSurface && surfGradeSin < -0.02 ? 1.12 : 1.0);
  const requested = clamp(
    Number.isFinite(command.targetSpeed) ? command.targetSpeed : 0,
    -specReverseSpeed,
    maxForwardSpeed,
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
      : specBraking;
  const v0 = body.speed ?? 0;
  const reversing = v0 * requested < 0;
  const target = reversing ? 0 : requested;
  const slowing = Math.abs(target) < absSpeed || reversing;
  const rate = slowing ? braking : specAcceleration;
  const baseGrip = realistic
    ? Number.isFinite(specTireGrip) && specTireGrip > 0
      ? specTireGrip
      : hasActiveSurface
        ? 8
        : Infinity
    : Infinity;
  const grip = hasActiveSurface && Number.isFinite(baseGrip) ? baseGrip * surfGripMult : baseGrip;

  let speed;
  let tireLongitudinal = 0;
  if (!hasActiveSurface || dt === 0) {
    speed = approach(v0, target, Math.min(rate, grip) * dt);
    tireLongitudinal = dt > 0 ? Math.abs(speed - v0) / dt : 0;
  } else {
    const slopeAccel = -9.81 * surfGradeSin;
    const hydroDrag = surfHydroCoeff * absSpeed * absSpeed;
    if (command.coasting === true && !explicitDeceleration && Math.abs(requested) < 0.05) {
      const rollingWithGravity = slopeAccel !== 0 && v0 * slopeAccel >= 0;
      const baseCoast = rollingWithGravity
        ? 0.32 + 0.0025 * v0 * v0
        : absSpeed > 0.2
          ? 1.65 + 0.0018 * v0 * v0
          : 0.35;
      const coastDecel = baseCoast + surfRollingDrag + hydroDrag;
      if (absSpeed > 0) {
        const dragStep = approach(v0, 0, coastDecel * dt);
        if (dragStep === 0) {
          const gravExcess = Math.max(0, Math.abs(slopeAccel) - (0.32 + surfRollingDrag));
          speed = gravExcess > 0 ? Math.sign(slopeAccel) * gravExcess * dt : 0;
        } else {
          speed = dragStep + slopeAccel * dt;
        }
      } else {
        const gravExcess = Math.max(0, Math.abs(slopeAccel) - (0.32 + surfRollingDrag));
        speed = gravExcess > 0 ? Math.sign(slopeAccel) * gravExcess * dt : 0;
      }
      speed = clamp(speed, -specReverseSpeed, maxForwardSpeed);
      tireLongitudinal = 0;
    } else if (Math.abs(requested) < 1e-6) {
      const brakeCap = Math.min(braking, grip);
      const passiveAssist = Math.min(0.45, surfRollingDrag * 0.25 + hydroDrag * 0.02);
      if (absSpeed < 0.08 && Math.abs(surfGradeSin) < 0.25 && Math.abs(slopeAccel) <= brakeCap) {
        if (v0 === 0) {
          speed = 0;
        } else {
          const dir = Math.sign(v0);
          const netDecel = Math.max(0.5, brakeCap + passiveAssist - dir * slopeAccel);
          speed = approach(v0, 0, netDecel * dt);
        }
      } else if (absSpeed > 0) {
        const dir = Math.sign(v0);
        const netDecel = brakeCap + passiveAssist - dir * slopeAccel;
        if (netDecel >= 0) {
          speed = approach(v0, 0, netDecel * dt);
        } else {
          speed = clamp(v0 + dir * (-netDecel) * dt, -specReverseSpeed, maxForwardSpeed);
        }
      } else {
        const excess = Math.max(0, Math.abs(slopeAccel) - brakeCap);
        speed = excess > 0
          ? clamp(Math.sign(slopeAccel) * excess * dt, -specReverseSpeed, maxForwardSpeed)
          : 0;
      }
      tireLongitudinal = Math.min(grip, Math.abs(v0) > 0 ? Math.min(brakeCap, Math.abs(v0) / dt) : 0);
    } else if (slowing) {
      const dir = absSpeed > 0 ? Math.sign(v0) : Math.sign(requested);
      const brakeCap = Math.min(braking, grip);
      const passiveAssist = Math.min(0.45, surfRollingDrag * 0.25 + hydroDrag * 0.02);
      const netDecel = brakeCap + passiveAssist - dir * slopeAccel;
      if (netDecel >= 0) {
        speed = approach(v0, target, netDecel * dt);
      } else {
        speed = clamp(v0 + dir * (-netDecel) * dt, -specReverseSpeed, maxForwardSpeed);
      }
      tireLongitudinal = Math.min(grip, Math.min(brakeCap, Math.abs(target - v0) / dt));
    } else {
      const wantDir = Math.sign(requested);
      const driveCap = Math.min(specAcceleration, grip);
      const neededAccel = Math.abs(requested - v0) / dt;
      const driveDragFactor = 0.42 + 0.25 * clamp(absSpeed / 8, 0, 1);
      const resistDecel = surfRollingDrag * driveDragFactor + hydroDrag;
      const requiredDrive = Math.min(
        driveCap,
        neededAccel + resistDecel - Math.min(0, wantDir * slopeAccel),
      );
      const activeStep = v0 + wantDir * requiredDrive * dt + slopeAccel * dt;
      speed = clamp(approach(activeStep, 0, resistDecel * dt), -specReverseSpeed, maxForwardSpeed);
      tireLongitudinal = Math.min(requiredDrive, grip * 0.75);
    }
  }

  const average = (speed + v0) / 2;
  const tangent = Math.tan(steer);
  const rearAxleFraction = microbus ? 0.5 - KING_LONG_MICROBUS.axleCenterZM / specWheelbase : 0.5;
  let beta = Math.atan(rearAxleFraction * tangent);
  let yawRate = (average / specWheelbase) * Math.cos(beta) * tangent;
  const rawDemandedLat = Math.abs(average * yawRate);
  let lateralBudget = Infinity;
  if (realistic && Number.isFinite(grip) && grip > 0) {
    lateralBudget = Math.sqrt(Math.max(0, grip ** 2 - tireLongitudinal ** 2));
    if (rawDemandedLat > lateralBudget) {
      const scale = lateralBudget / rawDemandedLat;
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
    let targetChaseSlip = 0;
    if (!hasActiveSurface) {
      targetChaseSlip = Math.abs(latAccel) > 3.8 && average > 6
        ? clamp(-Math.sign(latAccel) * (Math.abs(latAccel) - 3.8) * 0.016, -0.14, 0.14)
        : 0;
    } else {
      const effectiveLat = Math.abs(latAccel) / surfGripMult;
      const slideOvershoot = Number.isFinite(lateralBudget) && rawDemandedLat > lateralBudget
        ? Math.min(3.6, (rawDemandedLat - lateralBudget) * Math.max(0, 1 - surfGripMult) * 0.65)
        : 0;
      const equivLat = effectiveLat + slideOvershoot;
      const slipBoost = surfaceKind === "water" ? 1.35 : 1.0;
      const maxSlip = surfaceKind === "water" ? 0.22 : surfGripMult < 0.95 ? 0.18 : 0.14;
      targetChaseSlip = equivLat > 3.8 && Math.abs(average) > 5.5 && latAccel !== 0
        ? clamp(-Math.sign(latAccel) * (equivLat - 3.8) * 0.016 * slipBoost, -maxSlip, maxSlip)
        : 0;
    }
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
  if (specContactResponse === "inelastic-slide-v1") {
    const oldSlide = getContactSlide(body);
    const slide = approach(oldSlide, 0, 3 * dt);
    result.x += Math.cos(midHeading) * (oldSlide + slide) * dt / 2;
    result.z -= Math.sin(midHeading) * (oldSlide + slide) * dt / 2;
    if (slide) setContactSlide(result, slide);
    else deleteContactSlide(result);
  }
  return result;
}

/** Actual zero-gap contact is separate from the ordinary 0.12 m safety guard. */
export function resolveVehicleContact(before, proposed, obstacle, dt = STEP) {
  if (!Number.isFinite(dt) || dt <= 0)
    throw new RangeError("Contact needs a positive step");
  if (overlaps(before, obstacle)) return null;
  const scrubEnabled =
    (before.spec?.wheelInteractionPhysics ?? before.wheelInteractionPhysics) === WHEEL_SCRUB_MODE;
  const obstacleSpeed = obstacle.speed ?? 0;
  const obsVx = Number.isFinite(obstacle.vx)
    ? obstacle.vx
    : Math.sin(obstacle.heading ?? 0) * obstacleSpeed;
  const obsVz = Number.isFinite(obstacle.vz)
    ? obstacle.vz
    : Math.cos(obstacle.heading ?? 0) * obstacleSpeed;
  const obsEnd =
    scrubEnabled && obstacle.type !== "static" && (Math.abs(obsVx) > 1e-9 || Math.abs(obsVz) > 1e-9)
      ? { ...obstacle, x: obstacle.x + obsVx * dt, z: obstacle.z + obsVz * dt }
      : obstacle;
  const obsTravel = obsEnd === obstacle ? 0 : Math.hypot(obsVx * dt, obsVz * dt);
  const travel =
    distance(before, proposed) +
    Math.abs(angleDelta(proposed.heading, before.heading)) *
      Math.hypot(before.length, before.width) / 2;
  if (travel + obsTravel < 1e-10) return null;
  const obsAt = (t) => (obsEnd === obstacle ? obstacle : interpolate(obstacle, obsEnd, t));
  const steps = Math.max(1, Math.ceil((travel + obsTravel) / 0.04));
  let low = 0;
  let high = null;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    if (overlaps(interpolate(before, proposed, t), obsAt(t))) {
      high = t;
      low = (i - 1) / steps;
      break;
    }
  }
  if (high === null) return null;
  for (let i = 0; i < 32; i++) {
    const middle = (low + high) / 2;
    if (overlaps(interpolate(before, proposed, middle), obsAt(middle))) high = middle;
    else low = middle;
  }
  const body = interpolate(before, proposed, low);
  const touchObstacle = obsAt(low);
  const a = corners(body);
  const b = corners(touchObstacle);
  let separation = -Infinity;
  let normal;
  for (const shape of [body, touchObstacle]) {
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
  const vx = (proposed.x - before.x) / dt - obsVx;
  const vz = (proposed.z - before.z) / dt - obsVz;
  const closingSpeedMps = Math.max(0, vx * normal.x + vz * normal.z);
  if (before.spec?.contactResponse === "inelastic-slide-v1") {
    const mass = Number.isFinite(before.spec.massKg) && before.spec.massKg > 0
      ? before.spec.massKg : playerVehicleDimensions(before).massKg;
    const contactMech = resolveObstacleContactMechanics(
      mass,
      obstacle,
      closingSpeedMps,
      scrubEnabled,
      dt,
    );
    const otherMass = contactMech.obsMassKg;
    const reducedMass = contactMech.reducedMassKg;
    const incoming = { x: (proposed.x - before.x) / dt, z: (proposed.z - before.z) / dt };
    // Unified 2-body + parked breakaway ground-stiction impulse!
    const normalDelta = contactMech.egoNormalDelta;
    const sharedNormalImpulseNs = contactMech.egoNormalImpulseNs;
    const actorNetNormalImpulseNs = contactMech.actorNetNormalImpulseNs;
    const velocity = { x: incoming.x - normal.x * normalDelta,
      z: incoming.z - normal.z * normalDelta };
    const incomingSpeed = Math.hypot(incoming.x, incoming.z);
    const maxNormalSpeed = scrubEnabled && (contactMech.obsMomentumShare > 0)
      ? Math.max(incomingSpeed, Math.hypot(velocity.x, velocity.z))
      : incomingSpeed;
    const outgoingSpeed = Math.hypot(velocity.x, velocity.z);
    if (outgoingSpeed > maxNormalSpeed && outgoingSpeed > 0) {
      velocity.x *= maxNormalSpeed / outgoingSpeed;
      velocity.z *= maxNormalSpeed / outgoingSpeed;
    }
    const remaining = dt * (1 - low);
    const slid = { ...body, x: body.x + velocity.x * remaining,
      z: body.z + velocity.z * remaining };
    const accepted = overlaps(slid, obstacle) || overlaps(slid, obsEnd) ? body : slid;
    const s = Math.sin(body.heading), c = Math.cos(body.heading);
    const response = { ...accepted, speed: velocity.x * s + velocity.z * c,
      reason: "vehicle-contact", blockedBy: obstacle.id };
    if (Math.abs(response.speed) < 1e-12) response.speed = 0;
    const slide = velocity.x * c - velocity.z * s;
    if (Math.abs(slide) > 1e-12) setContactSlide(response, slide);
    const baseResult = { body: response, hitId: obstacle.id, side, normal, closingSpeedMps,
      otherX: touchObstacle.x, otherZ: touchObstacle.z,
      energyJ: 0.5 * reducedMass * closingSpeedMps ** 2,
      sharedNormalImpulseNs,
      actorNetNormalImpulseNs,
      stictionBroken: contactMech.stictionBroken,
      egoMassKg: mass,
      otherMassKg: otherMass,
      contactFraction: low,
      proposedTravelM: distance(before, proposed),
      relativeTravelM: travel + obsTravel };
    registerContactContext(baseResult, {
      touchBody: body,
      incomingVelocity: incoming,
      baseVelocity: velocity,
      incomingSpeed: maxNormalSpeed,
      remainingDt: remaining,
    });
    if (scrubEnabled) {
      return applyScrapingContactResponse(before, baseResult, touchObstacle, dt);
    }
    return baseResult;
  }
  return {
    body: { ...body, speed: 0, reason: "vehicle-contact", blockedBy: obstacle.id },
    hitId: obstacle.id,
    side,
    normal,
    otherX: obstacle.x,
    otherZ: obstacle.z,
    closingSpeedMps,
    energyJ: 0.5 * playerVehicleDimensions(before).massKg * closingSpeedMps ** 2,
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
  const axleCenterZ = body.vehicleModel === KING_LONG_MICROBUS_ID ? KING_LONG_MICROBUS.axleCenterZM : 0;
  const rearAxleDistance = wheelbase / 2 - axleCenterZ;
  const x = body.x - Math.sin(body.heading) * rearAxleDistance;
  const z = body.z - Math.cos(body.heading) * rearAxleDistance;
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
