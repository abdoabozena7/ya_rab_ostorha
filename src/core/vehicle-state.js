import { clamp } from "./config.js";
import { angleDelta } from "./geometry.js";
import { PLAYER_VEHICLE } from "./vehicle-spec.js";

const wheelNames = ["frontLeft", "frontRight", "rearLeft", "rearRight"];
const damageSides = ["front", "rear", "left", "right"];
const staticWheelLoad = (PLAYER_VEHICLE.massKg * 9.81) / 4;
const tau = Math.PI * 2;

export function createVehicleState() {
  return {
    wheelAngles: { frontLeft: 0, frontRight: 0 },
    wheelSpinRad: 0,
    steeringWheelRad: 0,
    suspension: {
      pitchRad: 0,
      rollRad: 0,
      heaveM: 0,
      pitchVelocityRadS: 0,
      rollVelocityRadS: 0,
      heaveVelocityMps: 0,
      wheelOffsetsM: Object.fromEntries(wheelNames.map((name) => [name, 0])),
    },
    wheelLoadsN: Object.fromEntries(
      wheelNames.map((name) => [name, staticWheelLoad]),
    ),
    controls: { throttle: 0, brake: 0, gear: "N" },
    contact: null,
    damage: {
      front: 0,
      rear: 0,
      left: 0,
      right: 0,
      total: 0,
      impactCount: 0,
      lastImpact: null,
    },
  };
}

function wheelAngles(steer) {
  if (Math.abs(steer) < 1e-10) return { frontLeft: 0, frontRight: 0 };
  const sign = Math.sign(steer);
  const radius = PLAYER_VEHICLE.wheelbaseM / Math.tan(Math.abs(steer));
  const inner = Math.atan(
    PLAYER_VEHICLE.wheelbaseM / (radius - PLAYER_VEHICLE.trackM / 2),
  );
  const outer = Math.atan(
    PLAYER_VEHICLE.wheelbaseM / (radius + PLAYER_VEHICLE.trackM / 2),
  );
  return sign > 0
    ? { frontLeft: outer, frontRight: inner }
    : { frontLeft: -inner, frontRight: -outer };
}

function spring(value, velocity, target, frequency, limit, dt) {
  const displacement = value - target;
  const coefficient = velocity + frequency * displacement;
  const decay = Math.exp(-frequency * dt);
  const raw = target + (displacement + coefficient * dt) * decay;
  const result = clamp(raw, -limit, limit);
  const speed =
    result === raw ? (velocity - frequency * coefficient * dt) * decay : 0;
  return {
    value: Math.abs(result) < 1e-12 ? 0 : result,
    velocity: Math.abs(speed) < 1e-12 ? 0 : speed,
  };
}

function dent(damage, side, closingSpeedMps, energyJ, tick) {
  damage[side] = clamp(damage[side] + energyJ / 45000, 0, 1);
  damage.total = 1 - damageSides.reduce((p, part) => p * (1 - damage[part]), 1);
  damage.impactCount++;
  damage.lastImpact = { side, closingSpeedMps, energyJ, tick };
}

/** Called once, after World accepts a pose; safety probes never advance the rig. */
export function advanceVehicleState(
  before,
  after,
  command,
  dt,
  { tick = 0, contact = null, freshImpacts = null } = {},
) {
  if (!Number.isFinite(dt) || dt <= 0)
    throw new RangeError("Vehicle state needs a positive fixed step");
  const previous = before.vehicle ?? createVehicleState();
  const steer = clamp(after.steer ?? 0, -PLAYER_VEHICLE.maxSteerRad, PLAYER_VEHICLE.maxSteerRad);
  const yaw = angleDelta(after.heading, before.heading);
  const heading = before.heading + yaw / 2;
  const dx = after.x - before.x;
  const dz = after.z - before.z;
  const forwardTravel = dx * Math.sin(heading) + dz * Math.cos(heading);
  const signedTravel = Math.hypot(dx, dz) * Math.sign(forwardTravel);
  const speed = after.speed ?? 0;
  const oldSpeed = before.speed ?? 0;
  const averageSpeed = (speed + oldSpeed) / 2;
  const acceleration = clamp((speed - oldSpeed) / dt, -9, 9);
  const lateral = clamp((averageSpeed * yaw) / dt, -8, 8);
  const dy = (after.y ?? 0) - (before.y ?? 0);
  const hasCurbStep = Math.abs(dy) > 0.002;
  const stepRate = hasCurbStep ? dy / Math.max(dt, 1 / 60) : 0;
  const heaveImpulse = hasCurbStep ? -clamp(stepRate * 0.38, -0.45, 0.45) : 0;
  const forwardSign = forwardTravel < -1e-6 || (Math.abs(forwardTravel) <= 1e-6 && averageSpeed < 0) ? -1 : 1;
  const pitchImpulse = hasCurbStep ? -forwardSign * clamp(stepRate * 0.12, -0.18, 0.18) : 0;
  const load = previous.suspension;
  const pitch = spring(
    load.pitchRad,
    load.pitchVelocityRadS + pitchImpulse,
    clamp(-acceleration * 0.0095, -0.068, 0.068),
    11,
    0.072,
    dt,
  );
  const roll = spring(
    load.rollRad,
    load.rollVelocityRadS,
    clamp(lateral * 0.0115, -0.078, 0.078),
    10,
    0.082,
    dt,
  );
  const heave = spring(
    load.heaveM,
    load.heaveVelocityMps + heaveImpulse,
    contact ? -0.035 : -Math.min(0.018, Math.abs(acceleration) * 0.0012 + Math.abs(lateral) * 0.001),
    13,
    0.04,
    dt,
  );
  const wheelOffsetsM = {};
  const wheelLoadsN = {};
  const weight = PLAYER_VEHICLE.massKg * 9.81;
  const foreTransfer =
    (PLAYER_VEHICLE.massKg * acceleration * PLAYER_VEHICLE.centerOfMassHeightM) /
    (2 * PLAYER_VEHICLE.wheelbaseM);
  const sideTransfer =
    (PLAYER_VEHICLE.massKg * lateral * PLAYER_VEHICLE.centerOfMassHeightM) /
    (2 * PLAYER_VEHICLE.trackM);
  for (const name of wheelNames) {
    const front = name.startsWith("front");
    const left = name.endsWith("Left");
    const x = (left ? -1 : 1) * PLAYER_VEHICLE.trackM / 2;
    const z = (front ? 1 : -1) * PLAYER_VEHICLE.wheelbaseM / 2;
    // Strut travel relative to the loaded chassis, not tire motion into asphalt.
    wheelOffsetsM[name] = clamp(
      -heave.value + Math.sin(pitch.value) * z - Math.sin(roll.value) * x,
      -PLAYER_VEHICLE.suspensionTravelM,
      PLAYER_VEHICLE.suspensionTravelM,
    );
    wheelLoadsN[name] = Math.max(
      weight * 0.02,
      staticWheelLoad + (front ? -foreTransfer : foreTransfer) + (left ? sideTransfer : -sideTransfer),
    );
  }
  const loadScale = weight / Object.values(wheelLoadsN).reduce((a, b) => a + b, 0);
  for (const name of wheelNames) wheelLoadsN[name] *= loadScale;

  const requested = Number.isFinite(command.targetSpeed) ? command.targetSpeed : 0;
  const reversing = oldSpeed * requested < 0;
  const slowing = Math.abs(requested) < Math.abs(oldSpeed) || reversing;
  const controls = {
    throttle: !contact && !slowing && Math.abs(requested) > Math.abs(oldSpeed) + 1e-8 ? 1 : 0,
    brake: contact || (slowing && Math.abs(oldSpeed) > 1e-8) ? 1 : 0,
    gear: Math.abs(speed) > 1e-8 ? (speed > 0 ? "D" : "R") : requested === 0 ? "N" : requested > 0 ? "D" : "R",
  };
  let latchedContact = previous.contact;
  if (
    latchedContact &&
    Math.hypot(after.x - latchedContact.x, after.z - latchedContact.z) > 0.25
  )
    latchedContact = null;
  const damage = { ...previous.damage };
  // Dispatch has authoritative contact episodes, even when the ego proposed no travel.
  if (freshImpacts) {
    for (const { side, closingSpeedMps, energyJ } of freshImpacts) {
      if (closingSpeedMps >= 0.35) dent(damage, side, closingSpeedMps, energyJ, tick);
    }
  }
  if (contact) {
    const closingSpeedMps = Math.max(0, contact.closingSpeedMps);
    if (
      !freshImpacts &&
      closingSpeedMps >= 0.35 &&
      Math.abs(oldSpeed) >= 0.15 &&
      contact.proposedTravelM > 1e-8 &&
      latchedContact?.hitId !== contact.hitId &&
      damageSides.includes(contact.side)
    ) {
      const energyJ = 0.5 * PLAYER_VEHICLE.massKg * closingSpeedMps ** 2;
      dent(damage, contact.side, closingSpeedMps, energyJ, tick);
    }
    latchedContact = {
      hitId: contact.hitId,
      x: after.x,
      z: after.z,
      tick,
    };
  }
  return {
    wheelAngles: wheelAngles(steer),
    wheelSpinRad: (previous.wheelSpinRad + signedTravel / (PLAYER_VEHICLE.wheelRadiusM * (before.giantScale ?? 1))) % tau,
    steeringWheelRad: steer * PLAYER_VEHICLE.steeringRatio,
    suspension: {
      pitchRad: pitch.value,
      rollRad: roll.value,
      heaveM: heave.value,
      pitchVelocityRadS: pitch.velocity,
      rollVelocityRadS: roll.velocity,
      heaveVelocityMps: heave.velocity,
      wheelOffsetsM,
    },
    wheelLoadsN,
    controls,
    contact: latchedContact,
    damage,
  };
}
