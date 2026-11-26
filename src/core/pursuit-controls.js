import { STEP, VEHICLE, clamp } from "./config.js";
import { KING_LONG_MICROBUS, KING_LONG_MICROBUS_ID } from "./vehicle-spec.js";

export const PURSUIT_STOP = Object.freeze({ steer: 0, throttle: 0, brake: 1, gear: 1 });

export const NITRO_SPEC = Object.freeze({
  durationS: 4.6,
  rechargePerS: 0.16,
  minEngageCharge: 0.18,
  speedMultiplier: 1.34,
  accelMultiplier: 1.72,
  maxBoostSpeedMps: 38.5,
});

export function nitroBoostLimits(body) {
  const baseMaxSpeed = body.maxSpeed ?? 9.72;
  return body.vehicleModel === KING_LONG_MICROBUS_ID
    ? { maxSpeed: baseMaxSpeed, accelMultiplier: KING_LONG_MICROBUS.nitroAccelerationMultiplier }
    : {
        maxSpeed: Math.min(NITRO_SPEC.maxBoostSpeedMps, baseMaxSpeed * NITRO_SPEC.speedMultiplier),
        accelMultiplier: NITRO_SPEC.accelMultiplier,
      };
}

export function validatePursuitAction(action) {
  if (!action || Object.getPrototypeOf(action) !== Object.prototype)
    throw new RangeError("Pursuit action needs normalized steering, throttle and brake, and gear 1 or -1");
  const keys = Object.keys(action);
  const hasNitro = Object.prototype.hasOwnProperty.call(action, "nitro");
  if (
    keys.length !== (hasNitro ? 5 : 4) ||
    ![action.steer, action.throttle, action.brake].every(Number.isFinite) ||
    Math.abs(action.steer) > 1 || action.throttle < 0 || action.throttle > 1 ||
    action.brake < 0 || action.brake > 1 || ![1, -1].includes(action.gear) ||
    (hasNitro && (typeof action.nitro !== "number" || !Number.isFinite(action.nitro) || action.nitro < 0 || action.nitro > 1))
  )
    throw new RangeError("Pursuit action needs normalized steering, throttle and brake, and gear 1 or -1");
  return action;
}

export function isNitroEngaged(pose, action) {
  const charge = Number.isFinite(pose?.nitroCharge) ? pose.nitroCharge : 1;
  const canEngage = pose?.nitroActive ? charge > 0.01 : charge >= NITRO_SPEC.minEngageCharge;
  return Boolean(
    canEngage &&
    charge > 0.01 &&
    (action?.nitro ?? 0) >= 0.5 &&
    (action?.gear ?? 1) === 1 &&
    (action?.throttle ?? 0) > 0.2 &&
    (action?.brake ?? 0) === 0 &&
    (pose?.speed ?? 0) >= -0.5 &&
    !pose?.nitroSuppressedByPedestrian,
  );
}

export function stepNitroTank(player, action, dt = STEP) {
  if (!player || typeof player !== "object") return false;
  const prevCharge = Number.isFinite(player.nitroCharge) ? player.nitroCharge : 1;
  const prevActive = Boolean(player.nitroActive);
  const prevIntensity = Number.isFinite(player.nitroIntensity) ? player.nitroIntensity : 0;
  const suppressed = Boolean(player.nitroSuppressedByPedestrian);
  const canEngage = prevActive
    ? prevCharge > 0.01
    : prevCharge >= NITRO_SPEC.minEngageCharge;
  const engaged = Boolean(
    canEngage &&
    prevCharge > 0.01 &&
    (action?.nitro ?? 0) >= 0.5 &&
    (action?.gear ?? 1) === 1 &&
    (action?.throttle ?? 0) > 0.2 &&
    (action?.brake ?? 0) === 0 &&
    (player.speed ?? 0) >= -0.5 &&
    !suppressed,
  );
  if (engaged) {
    player.nitroCharge = Math.max(0, prevCharge - dt / NITRO_SPEC.durationS);
    player.nitroActive = player.nitroCharge > 0;
    player.nitroIntensity = Math.min(1, prevIntensity + dt * 9.0);
  } else {
    player.nitroCharge = Math.min(1, prevCharge + dt * NITRO_SPEC.rechargePerS);
    player.nitroActive = false;
    player.nitroIntensity = Math.max(0, prevIntensity - dt * 6.5);
  }
  player.nitroSuppressedByPedestrian = suppressed;
  return player.nitroActive;
}

export function buildNitroBoostPose(actor, command, copyMotion = null) {
  if (!command || !(command.accelMultiplier > 1) || !Number.isFinite(command.maxSpeed)) {
    return null;
  }
  const baseSpec = actor.spec ?? null;
  const baseAccel = baseSpec?.acceleration ?? VEHICLE.acceleration;
  const boostedAccel = baseAccel * command.accelMultiplier;
  const rawGrip = baseSpec?.tireGripMps2;
  const boostedSpec = {
    ...(baseSpec ?? {}),
    acceleration: boostedAccel,
    ...(actor.vehicleModel !== KING_LONG_MICROBUS_ID && Number.isFinite(rawGrip)
      ? { tireGripMps2: Math.max(rawGrip, boostedAccel) } : {}),
  };
  const boosted = {
    ...actor,
    maxSpeed: command.maxSpeed,
    spec: boostedSpec,
  };
  if (typeof copyMotion === "function") copyMotion(actor, boosted);
  return boosted;
}

export function pursuitCommand(body, action, dt = STEP) {
  const maxSteer = body.spec?.maxSteer ?? VEHICLE.maxSteer;
  const steer = action.steer * maxSteer;
  if (action.brake > 0) return {
    steer, targetSpeed: 0,
    decelerationMps2: (body.spec?.braking ?? VEHICLE.braking) * action.brake,
  };
  const speed = body.speed ?? 0;
  if ((action?.nitro ?? 0) >= 0.5 && isNitroEngaged(body, action)) {
    const boost = nitroBoostLimits(body);
    const baseAccel = body.spec?.acceleration ?? VEHICLE.acceleration;
    const acceleration = baseAccel * boost.accelMultiplier * action.throttle;
    const targetSpeed = action.gear * clamp(
      speed * action.gear + acceleration * dt,
      acceleration * dt,
      boost.maxSpeed,
    );
    return {
      steer,
      targetSpeed,
      ...boost,
    };
  }
  const limit = action.gear > 0 ? body.maxSpeed ?? 9.72 : (body.spec?.reverseSpeed ?? VEHICLE.reverseSpeed);
  const acceleration = (body.spec?.acceleration ?? VEHICLE.acceleration) * action.throttle;
  const targetSpeed = action.throttle === 0
    ? Math.sign(speed) * Math.max(0, Math.abs(speed) - 0.18 * dt)
    : action.gear * clamp(speed * action.gear + acceleration * dt, acceleration * dt, limit);
  return { steer, targetSpeed };
}
