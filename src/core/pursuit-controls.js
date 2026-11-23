import { STEP, VEHICLE, clamp } from "./config.js";

export const PURSUIT_STOP = Object.freeze({ steer: 0, throttle: 0, brake: 1, gear: 1 });

export function validatePursuitAction(action) {
  if (!action || Object.getPrototypeOf(action) !== Object.prototype ||
      Object.keys(action).length !== 4 ||
      ![action.steer, action.throttle, action.brake].every(Number.isFinite) ||
      Math.abs(action.steer) > 1 || action.throttle < 0 || action.throttle > 1 ||
      action.brake < 0 || action.brake > 1 || ![1, -1].includes(action.gear))
    throw new RangeError("Pursuit action needs normalized steering, throttle and brake, and gear 1 or -1");
  return action;
}

export function pursuitCommand(body, action, dt = STEP) {
  const maxSteer = body.spec?.maxSteer ?? VEHICLE.maxSteer;
  const steer = action.steer * maxSteer;
  if (action.brake > 0) return {
    steer, targetSpeed: 0,
    decelerationMps2: (body.spec?.braking ?? VEHICLE.braking) * action.brake,
  };
  const speed = body.speed ?? 0;
  const limit = action.gear > 0 ? body.maxSpeed ?? 9.72 : (body.spec?.reverseSpeed ?? VEHICLE.reverseSpeed);
  const acceleration = (body.spec?.acceleration ?? VEHICLE.acceleration) * action.throttle;
  const targetSpeed = action.throttle === 0
    ? Math.sign(speed) * Math.max(0, Math.abs(speed) - 0.18 * dt)
    : action.gear * clamp(speed * action.gear + acceleration * dt, acceleration * dt, limit);
  return { steer, targetSpeed };
}
