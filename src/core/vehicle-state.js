import { clamp } from "./config.js";
import { angleDelta } from "./geometry.js";
import { KING_LONG_MICROBUS, playerVehicleDimensions, staticVehicleWheelLoadN } from "./vehicle-spec.js";
import {
  WHEEL_SCRUB_MODE,
  cloneWheelInteractionState,
  computeWheelInteractionState,
  createDefaultWheelInteractionState,
} from "./wheel-interaction-physics.js";

const wheelNames = ["frontLeft", "frontRight", "rearLeft", "rearRight"];
const damageSides = ["front", "rear", "left", "right"];
const glassPartIds = [
  "headlampLeft",
  "headlampRight",
  "windshield",
  "tailLampLeft",
  "tailLampRight",
];
const tau = Math.PI * 2;

export const VEHICLE_PART_IDS = Object.freeze([
  "hood",
  "frontBumper",
  "grille",
  "headlampLeft",
  "headlampRight",
  "windshield",
  "mirrorLeft",
  "mirrorRight",
  "doorLeft",
  "doorRight",
  "rearBumper",
  "rearHatch",
  "spareCarrier",
  "tailLampLeft",
  "tailLampRight",
  "exhaust",
  "radiator",
]);

const PART_LABELS = Object.freeze({
  hood: "Hood",
  frontBumper: "Front bumper",
  grille: "Grille",
  headlampLeft: "Left headlamp",
  headlampRight: "Right headlamp",
  windshield: "Windshield",
  mirrorLeft: "Left mirror",
  mirrorRight: "Right mirror",
  doorLeft: "Left door",
  doorRight: "Right door",
  rearBumper: "Rear bumper",
  rearHatch: "Rear hatch",
  spareCarrier: "Spare carrier",
  tailLampLeft: "Left tail lamp",
  tailLampRight: "Right tail lamp",
  exhaust: "Exhaust",
  radiator: "Radiator",
});

export function createPartDamageState() {
  return {
    hood: { damage: 0, state: "intact", unlatched: false, detached: false },
    frontBumper: {
      damage: 0,
      state: "intact",
      unclippedLeft: false,
      unclippedRight: false,
      detached: false,
    },
    grille: { damage: 0, state: "intact", cracked: false, detached: false },
    headlampLeft: { damage: 0, state: "intact", cracked: false, shattered: false },
    headlampRight: { damage: 0, state: "intact", cracked: false, shattered: false },
    windshield: { damage: 0, state: "intact", cracked: false, shattered: false },
    mirrorLeft: { damage: 0, state: "intact", dangling: false, detached: false },
    mirrorRight: { damage: 0, state: "intact", dangling: false, detached: false },
    doorLeft: { damage: 0, state: "intact", ajar: false, claddingLoose: false },
    doorRight: { damage: 0, state: "intact", ajar: false, claddingLoose: false },
    rearBumper: {
      damage: 0,
      state: "intact",
      unclippedLeft: false,
      unclippedRight: false,
      detached: false,
    },
    rearHatch: { damage: 0, state: "intact", ajar: false, glassCracked: false },
    spareCarrier: { damage: 0, state: "intact", tilted: false, detached: false },
    tailLampLeft: { damage: 0, state: "intact", cracked: false, shattered: false },
    tailLampRight: { damage: 0, state: "intact", cracked: false, shattered: false },
    exhaust: { damage: 0, state: "intact", sagging: false, detached: false },
    radiator: { damage: 0, state: "intact", leaking: false },
  };
}

function cloneParts(parts) {
  const fresh = createPartDamageState();
  if (!parts || typeof parts !== "object") return fresh;
  for (const id of VEHICLE_PART_IDS) {
    if (parts[id] && typeof parts[id] === "object") {
      fresh[id] = { ...fresh[id], ...parts[id] };
    }
  }
  return fresh;
}

function cloneLastImpact(lastImpact) {
  if (!lastImpact) return null;
  return {
    ...lastImpact,
    ...(Array.isArray(lastImpact.brokenParts)
      ? { brokenParts: [...lastImpact.brokenParts] }
      : {}),
    ...(Array.isArray(lastImpact.detachedParts)
      ? { detachedParts: [...lastImpact.detachedParts] }
      : {}),
  };
}

function cloneDamage(previousDamage) {
  const source = previousDamage ?? {};
  return {
    front: source.front ?? 0,
    rear: source.rear ?? 0,
    left: source.left ?? 0,
    right: source.right ?? 0,
    total: source.total ?? 0,
    impactCount: source.impactCount ?? 0,
    lastImpact: cloneLastImpact(source.lastImpact ?? null),
    brokenCount: source.brokenCount ?? 0,
    detachedCount: source.detachedCount ?? 0,
    parts: cloneParts(source.parts),
  };
}

export function createVehicleState(body) {
  const dimensions = playerVehicleDimensions(body);
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
      wheelNames.map((name) => [name, staticVehicleWheelLoadN(dimensions, name.startsWith("front"))]),
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
      brokenCount: 0,
      detachedCount: 0,
      parts: createPartDamageState(),
    },
    interaction: createDefaultWheelInteractionState(),
    nitroCharge: 1,
    nitroActive: false,
    nitroIntensity: 0,
    nitroSuppressedByPedestrian: false,
  };
}

export function cloneVehicleState(state) {
  if (!state || typeof state !== "object") return createVehicleState();
  const base = createVehicleState();
  const susp = state.suspension ?? base.suspension;
  return {
    wheelAngles: {
      frontLeft: state.wheelAngles?.frontLeft ?? 0,
      frontRight: state.wheelAngles?.frontRight ?? 0,
    },
    wheelSpinRad: state.wheelSpinRad ?? 0,
    steeringWheelRad: state.steeringWheelRad ?? 0,
    suspension: {
      pitchRad: susp.pitchRad ?? 0,
      rollRad: susp.rollRad ?? 0,
      heaveM: susp.heaveM ?? 0,
      pitchVelocityRadS: susp.pitchVelocityRadS ?? 0,
      rollVelocityRadS: susp.rollVelocityRadS ?? 0,
      heaveVelocityMps: susp.heaveVelocityMps ?? 0,
      wheelOffsetsM: Object.fromEntries(
        wheelNames.map((name) => [name, susp.wheelOffsetsM?.[name] ?? 0]),
      ),
      ...(susp.terrainOffsetsM !== undefined
        ? {
            terrainOffsetsM: susp.terrainOffsetsM
              ? { ...susp.terrainOffsetsM }
              : null,
          }
        : {}),
    },
    wheelLoadsN: Object.fromEntries(
      wheelNames.map((name) => [name, state.wheelLoadsN?.[name] ?? staticWheelLoad]),
    ),
    controls: {
      throttle: state.controls?.throttle ?? 0,
      brake: state.controls?.brake ?? 0,
      gear: state.controls?.gear ?? "N",
    },
    contact: state.contact
      ? {
          ...state.contact,
          ...(state.contact.normal ? { normal: { ...state.contact.normal } } : {}),
        }
      : null,
    damage: cloneDamage(state.damage),
    interaction: cloneWheelInteractionState(state.interaction),
    nitroCharge: Number.isFinite(state.nitroCharge) ? state.nitroCharge : 1,
    nitroActive: Boolean(state.nitroActive),
    nitroIntensity: Number.isFinite(state.nitroIntensity) ? state.nitroIntensity : 0,
    nitroSuppressedByPedestrian: Boolean(state.nitroSuppressedByPedestrian),
    ...(state.surface ? { surface: { ...state.surface } } : {}),
  };
}

function round4(value) {
  if (!Number.isFinite(value)) return 0;
  const rounded = Math.round(value * 10000) / 10000;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function addPartDamage(part, delta) {
  if (!Number.isFinite(delta) || delta <= 0) return;
  part.damage = clamp(part.damage + delta, 0, 1);
}

function derivePartState(part) {
  if (part.detached) return "detached";
  if (part.shattered) return "shattered";
  if (part.unlatched) return "unlatched";
  if (part.ajar) return "ajar";
  if (part.dangling) return "dangling";
  if ((part.unclippedLeft || part.unclippedRight) && part.damage >= 0.85) return "crushed";
  if (part.unclippedLeft || part.unclippedRight) return "unclipped";
  if (part.leaking) return "leaking";
  if (part.tilted) return "tilted";
  if (part.sagging) return "sagging";
  if (part.cracked || part.glassCracked) return "cracked";
  if (part.damage >= 0.05) return "dented";
  return "intact";
}

function updateHoodFlags(part) {
  if (part.damage >= 0.32) part.unlatched = true;
  if (part.damage >= 0.85) part.detached = true;
}

function updateBumperFlags(part, leftBias, rightBias) {
  if (part.damage >= 0.28 && leftBias >= 0.7) part.unclippedLeft = true;
  if (part.damage >= 0.28 && rightBias >= 0.7) part.unclippedRight = true;
}

function updateGrilleFlags(part) {
  if (part.damage >= 0.2) part.cracked = true;
  if (part.damage >= 0.78) part.detached = true;
}

function updateHeadlampFlags(part) {
  if (part.damage >= 0.2) part.cracked = true;
  if (part.damage >= 0.4) part.shattered = true;
}

function updateWindshieldFlags(part) {
  if (part.damage >= 0.24) part.cracked = true;
  if (part.damage >= 0.62) part.shattered = true;
}

function updateMirrorFlags(part) {
  if (part.damage >= 0.18) part.dangling = true;
  if (part.damage >= 0.48) part.detached = true;
}

function updateDoorFlags(part) {
  if (part.damage >= 0.34) part.ajar = true;
  if (part.damage >= 0.46) part.claddingLoose = true;
}

function updateRearHatchFlags(part) {
  if (part.damage >= 0.34) part.ajar = true;
  if (part.damage >= 0.26) part.glassCracked = true;
}

function updateSpareCarrierFlags(part) {
  if (part.damage >= 0.24) part.tilted = true;
  if (part.damage >= 0.68) part.detached = true;
}

function updateTailLampFlags(part) {
  if (part.damage >= 0.2) part.cracked = true;
  if (part.damage >= 0.38) part.shattered = true;
}

function updateExhaustFlags(part) {
  if (part.damage >= 0.26) part.sagging = true;
  if (part.damage >= 0.82) part.detached = true;
}

function updateRadiatorFlags(part) {
  if (part.damage >= 0.36) part.leaking = true;
}

function resolveImpactOffsets(impact = {}, after = null) {
  const dimensions = playerVehicleDimensions(after);
  const halfWidth = dimensions.widthM / 2;
  const halfLength = dimensions.lengthM / 2;
  const hasExplicitLat = Number.isFinite(impact.lateralOffsetM);
  const hasExplicitLong = Number.isFinite(impact.longitudinalOffsetM);
  let derivedLat = 0;
  let derivedLong = 0;

  if (
    (!hasExplicitLat || !hasExplicitLong) &&
    after &&
    Number.isFinite(impact.otherX) &&
    Number.isFinite(impact.otherZ) &&
    Number.isFinite(after.x) &&
    Number.isFinite(after.z)
  ) {
    const heading = Number.isFinite(after.heading) ? after.heading : 0;
    const s = Math.sin(heading);
    const c = Math.cos(heading);
    const dx = impact.otherX - after.x;
    const dz = impact.otherZ - after.z;
    derivedLat = clamp(dx * c - dz * s, -halfWidth, halfWidth);
    derivedLong = clamp(dx * s + dz * c, -halfLength, halfLength);
  } else if (
    (!hasExplicitLat || !hasExplicitLong) &&
    impact.normal &&
    Number.isFinite(impact.normal.x) &&
    Number.isFinite(impact.normal.z)
  ) {
    const heading = Number.isFinite(after?.heading) ? after.heading : 0;
    const s = Math.sin(heading);
    const c = Math.cos(heading);
    const nForward = impact.normal.x * s + impact.normal.z * c;
    const nRight = impact.normal.x * c - impact.normal.z * s;
    if (impact.side === "front" || impact.side === "rear") {
      derivedLat = clamp(nRight * halfWidth * Math.SQRT2, -halfWidth, halfWidth);
    } else if (impact.side === "left" || impact.side === "right") {
      derivedLong = clamp(nForward * halfLength * Math.SQRT2, -halfLength, halfLength);
    }
  }

  const lateralOffsetM = hasExplicitLat
    ? clamp(impact.lateralOffsetM, -halfWidth, halfWidth)
    : derivedLat;
  const longitudinalOffsetM = hasExplicitLong
    ? clamp(impact.longitudinalOffsetM, -halfLength, halfLength)
    : derivedLong;
  return {
    lateralOffsetM: Object.is(lateralOffsetM, -0) ? 0 : lateralOffsetM,
    longitudinalOffsetM: Object.is(longitudinalOffsetM, -0) ? 0 : longitudinalOffsetM,
  };
}

export function applyLocalizedPartDamage(damage, impact = {}, after = null) {
  if (!damage.parts) damage.parts = createPartDamageState();
  const parts = damage.parts;
  const prevState = {};
  const prevDetached = {};
  const prevShattered = {};
  for (const id of VEHICLE_PART_IDS) {
    prevState[id] = parts[id].state;
    prevDetached[id] = Boolean(parts[id].detached);
    prevShattered[id] = Boolean(parts[id].shattered);
  }

  const side = impact.side;
  const dimensions = playerVehicleDimensions(after);
  const energyJ = Number.isFinite(impact.energyJ) ? Math.max(0, impact.energyJ) : 0;
  const energyNorm = clamp(energyJ / 45000, 0, 1.8);
  const { lateralOffsetM, longitudinalOffsetM } = resolveImpactOffsets(impact, after);
  const latNorm = clamp(lateralOffsetM / (dimensions.widthM * 0.45), -1, 1);
  const leftBias = clamp(
    1 - Math.max(0, latNorm) * 0.72 + Math.max(0, -latNorm) * 0.45,
    0.25,
    1.45,
  );
  const rightBias = clamp(
    1 - Math.max(0, -latNorm) * 0.72 + Math.max(0, latNorm) * 0.45,
    0.25,
    1.45,
  );
  const centerBias = clamp(1.12 - Math.abs(latNorm) * 0.45, 0.55, 1.15);

  if (side === "front") {
    addPartDamage(parts.frontBumper, energyNorm * 0.95);
    updateBumperFlags(parts.frontBumper, leftBias, rightBias);

    addPartDamage(parts.grille, energyNorm * 0.88 * centerBias);
    updateGrilleFlags(parts.grille);

    addPartDamage(parts.hood, energyNorm * 0.85 * centerBias);
    updateHoodFlags(parts.hood);

    addPartDamage(parts.headlampLeft, energyNorm * 0.92 * leftBias);
    updateHeadlampFlags(parts.headlampLeft);

    addPartDamage(parts.headlampRight, energyNorm * 0.92 * rightBias);
    updateHeadlampFlags(parts.headlampRight);

    addPartDamage(parts.windshield, Math.max(0, energyNorm - 0.22) * 0.78);
    updateWindshieldFlags(parts.windshield);

    addPartDamage(parts.radiator, Math.max(0, energyNorm - 0.18) * 0.85 * centerBias);
    updateRadiatorFlags(parts.radiator);

    if (Math.abs(latNorm) > 0.45 && energyNorm > 0.35) {
      const cornerMirror = latNorm < 0 ? parts.mirrorLeft : parts.mirrorRight;
      addPartDamage(cornerMirror, 0.42 * energyNorm);
      updateMirrorFlags(cornerMirror);
    }
  } else if (side === "rear") {
    addPartDamage(parts.rearBumper, energyNorm * 0.95);
    updateBumperFlags(parts.rearBumper, leftBias, rightBias);

    addPartDamage(parts.rearHatch, energyNorm * 0.88 * centerBias);
    updateRearHatchFlags(parts.rearHatch);

    addPartDamage(parts.spareCarrier, energyNorm * 0.82 * centerBias);
    updateSpareCarrierFlags(parts.spareCarrier);

    addPartDamage(parts.tailLampLeft, energyNorm * 0.9 * leftBias);
    updateTailLampFlags(parts.tailLampLeft);

    addPartDamage(parts.tailLampRight, energyNorm * 0.9 * rightBias);
    updateTailLampFlags(parts.tailLampRight);

    addPartDamage(parts.exhaust, energyNorm * 0.76);
    updateExhaustFlags(parts.exhaust);
  } else if (side === "left" || side === "right") {
    const isLeft = side === "left";
    const door = isLeft ? parts.doorLeft : parts.doorRight;
    const mirror = isLeft ? parts.mirrorLeft : parts.mirrorRight;
    addPartDamage(door, energyNorm * 0.92);
    updateDoorFlags(door);

    addPartDamage(mirror, energyNorm * 1.05);
    updateMirrorFlags(mirror);

    const longNorm = clamp(
      longitudinalOffsetM / (dimensions.lengthM * 0.42),
      -1,
      1,
    );
    if (longNorm > 0.25) {
      const headlamp = isLeft ? parts.headlampLeft : parts.headlampRight;
      addPartDamage(headlamp, 0.55 * energyNorm);
      updateHeadlampFlags(headlamp);

      addPartDamage(parts.frontBumper, 0.55 * energyNorm);
      updateBumperFlags(parts.frontBumper, isLeft ? 1 : 0, isLeft ? 0 : 1);
    } else if (longNorm < -0.25) {
      const tailLamp = isLeft ? parts.tailLampLeft : parts.tailLampRight;
      addPartDamage(tailLamp, 0.55 * energyNorm);
      updateTailLampFlags(tailLamp);

      addPartDamage(parts.rearBumper, 0.55 * energyNorm);
      updateBumperFlags(parts.rearBumper, isLeft ? 1 : 0, isLeft ? 0 : 1);
    }

    if (energyNorm >= 0.65) {
      addPartDamage(parts.windshield, energyNorm * 0.42);
      updateWindshieldFlags(parts.windshield);
    }
  }

  const brokenParts = [];
  const detachedParts = [];
  let brokenCount = 0;
  let detachedCount = 0;
  let shatteredGlass = false;

  for (const id of VEHICLE_PART_IDS) {
    const part = parts[id];
    part.state = derivePartState(part);
    if (part.state !== "intact") brokenCount++;
    if (part.detached === true) detachedCount++;
    if (part.state !== prevState[id] && part.state !== "intact") {
      brokenParts.push(id);
    }
    if (!prevDetached[id] && part.detached === true) {
      detachedParts.push(id);
    }
  }
  for (const id of glassPartIds) {
    if (!prevShattered[id] && parts[id].shattered === true) {
      shatteredGlass = true;
    }
  }

  damage.brokenCount = brokenCount;
  damage.detachedCount = detachedCount;

  return {
    lateralOffsetM: round4(lateralOffsetM),
    longitudinalOffsetM: round4(longitudinalOffsetM),
    brokenParts,
    detachedParts,
    shatteredGlass,
  };
}

export function summarizeDamagedParts(damage) {
  const parts = damage?.parts;
  if (!parts || typeof parts !== "object") return [];
  const summary = [];
  for (const id of VEHICLE_PART_IDS) {
    const part = parts[id];
    if (!part || part.state === "intact") continue;
    const label = PART_LABELS[id] ?? id;
    summary.push(`${label} ${part.state}`);
  }
  return summary;
}

function wheelAngles(steer, dimensions) {
  if (Math.abs(steer) < 1e-10) return { frontLeft: 0, frontRight: 0 };
  const sign = Math.sign(steer);
  const radius = dimensions.wheelbaseM / Math.tan(Math.abs(steer));
  const inner = Math.atan(
    dimensions.wheelbaseM / (radius - dimensions.trackM / 2),
  );
  const outer = Math.atan(
    dimensions.wheelbaseM / (radius + dimensions.trackM / 2),
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

function dent(damage, impact, tick, after, mergeSameStep = false) {
  const { side, closingSpeedMps, energyJ } = impact;
  damage[side] = clamp(damage[side] + energyJ / 45000, 0, 1);
  damage.total = 1 - damageSides.reduce((p, part) => p * (1 - damage[part]), 1);
  damage.impactCount++;
  const prevStepImpact = mergeSameStep ? damage.lastImpact : null;
  const localized = applyLocalizedPartDamage(damage, impact, after);
  const brokenParts = prevStepImpact
    ? [...new Set([...prevStepImpact.brokenParts, ...localized.brokenParts])]
    : localized.brokenParts;
  const detachedParts = prevStepImpact
    ? [...new Set([...prevStepImpact.detachedParts, ...localized.detachedParts])]
    : localized.detachedParts;
  damage.lastImpact = {
    side,
    closingSpeedMps,
    energyJ,
    tick,
    lateralOffsetM: localized.lateralOffsetM,
    longitudinalOffsetM: localized.longitudinalOffsetM,
    brokenParts,
    detachedParts,
    shatteredGlass: Boolean(prevStepImpact?.shatteredGlass || localized.shatteredGlass),
  };
}

/** Called once, after World accepts a pose; safety probes never advance the rig. */
export function advanceVehicleState(
  before,
  after,
  command,
  dt,
  {
    tick = 0,
    contact = null,
    freshImpacts = null,
    contactSeparated = false,
    surface = null,
    curbScrub = null,
    scraping = null,
    driverCommand = null,
  } = {},
) {
  if (!Number.isFinite(dt) || dt <= 0)
    throw new RangeError("Vehicle state needs a positive fixed step");
  const dimensions = playerVehicleDimensions(before);
  const microbus = dimensions === KING_LONG_MICROBUS;
  const previous = before.vehicle ?? createVehicleState(before);
  const steer = clamp(after.steer ?? 0, -dimensions.maxSteerRad, dimensions.maxSteerRad);
  const yaw = angleDelta(after.heading, before.heading);
  const heading = before.heading + yaw / 2;
  const dx = after.x - before.x;
  const dz = after.z - before.z;
  const forwardTravel = dx * Math.sin(heading) + dz * Math.cos(heading);
  const signedTravel = Math.hypot(dx, dz) * Math.sign(forwardTravel);
  const speed = after.speed ?? 0;
  const oldSpeed = before.speed ?? 0;
  const averageSpeed = (speed + oldSpeed) / 2;
  const absSpeed = Math.abs(averageSpeed);
  const acceleration = clamp((speed - oldSpeed) / dt, -9, 9);
  const lateral = clamp((averageSpeed * yaw) / dt, -8, 8);
  const hasSurface = Boolean(surface && typeof surface === "object");
  const terrainDeltaY = hasSurface
    ? (Number.isFinite(surface.dhdx) ? surface.dhdx : 0) * dx +
      (Number.isFinite(surface.dhdz) ? surface.dhdz : 0) * dz
    : 0;
  const dy = (after.y ?? 0) - (before.y ?? 0) - terrainDeltaY;
  const hasCurbStep = Math.abs(dy) > 0.002;
  const stepRate = hasCurbStep ? dy / Math.max(dt, 1 / 60) : 0;
  const heaveImpulse = hasCurbStep ? -clamp(stepRate * 0.38, -0.45, 0.45) : 0;
  const forwardSign = forwardTravel < -1e-6 || (Math.abs(forwardTravel) <= 1e-6 && averageSpeed < 0) ? -1 : 1;
  const pitchImpulse = hasCurbStep ? -forwardSign * clamp(stepRate * 0.12, -0.18, 0.18) : 0;

  let surfaceHeaveImpulse = 0;
  let surfaceRollImpulse = 0;
  let surfacePitchImpulse = 0;
  let slopePitchBias = 0;
  let slopeRollBias = 0;
  let gradeLoadTransfer = 0;
  if (hasSurface) {
    const gradeSin = Number.isFinite(surface.gradeSin) ? clamp(surface.gradeSin, -0.35, 0.35) : 0;
    const camberSin = Number.isFinite(surface.camberSin) ? clamp(surface.camberSin, -0.35, 0.35) : 0;
    slopePitchBias = clamp(-gradeSin * 0.22, -0.04, 0.04);
    slopeRollBias = clamp(-camberSin * 0.14, -0.025, 0.025);
    gradeLoadTransfer =
      (dimensions.massKg * 9.81 * gradeSin * dimensions.centerOfMassHeightM) /
      (2 * dimensions.wheelbaseM);

    if (absSpeed > 0.4) {
      const roughAmp = Number.isFinite(surface.roughnessAmp) ? Math.max(0, surface.roughnessAmp) : 0;
      const roughFreq = Number.isFinite(surface.roughnessFreq) ? Math.max(0, surface.roughnessFreq) : 8;
      const roughScale = roughAmp * clamp(absSpeed / 10, 0, 1.3);
      const phase = (after.x ?? 0) * 1.7 + (after.z ?? 0) * 2.3 + tick * 0.45 * roughFreq * dt;
      surfaceHeaveImpulse += Math.sin(phase) * clamp(roughScale * 2.4, -0.12, 0.12);
      surfaceRollImpulse += Math.cos(phase * 1.37 + 0.6) * clamp(roughScale * 3.2, -0.16, 0.16);
      surfacePitchImpulse += Math.sin(phase * 0.83 - 0.4) * clamp(roughScale * 1.8, -0.1, 0.1);

      if (previous.surface && Number.isFinite(previous.surface.gradeSin)) {
        const dGrade = gradeSin - previous.surface.gradeSin;
        if (Math.abs(dGrade) > 1e-5) {
          surfaceHeaveImpulse += clamp(-dGrade * absSpeed * 0.35, -0.18, 0.18);
        }
      }
    }
  }

  const activeScrape =
    contact?.scraping ?? scraping ?? (curbScrub?.active ? curbScrub : null);
  const extraCurb =
    curbScrub?.active && curbScrub !== activeScrape ? curbScrub : null;
  const scrapePitchImpulse =
    (activeScrape?.active ? (activeScrape.pitchImpulse ?? 0) : 0) +
    (extraCurb ? (extraCurb.pitchImpulse ?? 0) : 0);
  const scrapeRollImpulse =
    (activeScrape?.active ? (activeScrape.rollImpulse ?? 0) : 0) +
    (extraCurb ? (extraCurb.rollImpulse ?? 0) : 0);
  const scrapeHeaveImpulse =
    (activeScrape?.active ? (activeScrape.heaveImpulse ?? 0) : 0) +
    (extraCurb ? (extraCurb.heaveImpulse ?? 0) : 0);
  const scrapeSteerKickRad =
    (activeScrape?.active ? (activeScrape.steerKickRad ?? 0) : 0) +
    (extraCurb ? (extraCurb.steerKickRad ?? 0) : 0);

  const load = previous.suspension;
  const pitch = spring(
    load.pitchRad,
    load.pitchVelocityRadS + pitchImpulse + surfacePitchImpulse + scrapePitchImpulse,
    clamp(-acceleration * 0.0095 + slopePitchBias, -0.068, 0.068),
    11,
    0.072,
    dt,
  );
  const rollLimit = dimensions.rollLimitRad ?? 0.082;
  const rollTargetLimit = microbus ? rollLimit - 0.004 : 0.078;
  const roll = spring(
    load.rollRad,
    load.rollVelocityRadS + surfaceRollImpulse + scrapeRollImpulse,
    clamp(lateral * (dimensions.rollGradient ?? 0.0115) + slopeRollBias, -rollTargetLimit, rollTargetLimit),
    microbus ? 8.5 : 10,
    rollLimit,
    dt,
  );
  const heave = spring(
    load.heaveM,
    load.heaveVelocityMps + heaveImpulse + surfaceHeaveImpulse + scrapeHeaveImpulse,
    contact ? -0.035 : -Math.min(0.018, Math.abs(acceleration) * 0.0012 + Math.abs(lateral) * 0.001),
    13,
    0.04,
    dt,
  );
  const wheelOffsetsM = {};
  const wheelLoadsN = {};
  const weight = dimensions.massKg * 9.81;
  const foreTransfer =
    (dimensions.massKg * acceleration * dimensions.centerOfMassHeightM) /
      (2 * dimensions.wheelbaseM) +
    gradeLoadTransfer;
  const sideTransfer =
    (dimensions.massKg * lateral * dimensions.centerOfMassHeightM) /
    (2 * dimensions.trackM);
  for (const name of wheelNames) {
    const front = name.startsWith("front");
    const left = name.endsWith("Left");
    const x = (left ? -1 : 1) * dimensions.trackM / 2;
    const z = (front ? 1 : -1) * dimensions.wheelbaseM / 2 + (dimensions.axleCenterZM ?? 0);
    // Strut travel relative to the loaded chassis, not tire motion into asphalt.
    wheelOffsetsM[name] = clamp(
      -heave.value + Math.sin(pitch.value) * z - Math.sin(roll.value) * x,
      -dimensions.suspensionTravelM,
      dimensions.suspensionTravelM,
    );
    wheelLoadsN[name] = Math.max(
      weight * 0.02,
      staticVehicleWheelLoadN(dimensions, front) + (front ? -foreTransfer : foreTransfer) + (left ? sideTransfer : -sideTransfer),
    );
  }
  const loadScale = weight / Object.values(wheelLoadsN).reduce((a, b) => a + b, 0);
  for (const name of wheelNames) wheelLoadsN[name] *= loadScale;

  const effectiveControlCmd = driverCommand ?? command;
  const requested = Number.isFinite(effectiveControlCmd.targetSpeed) ? effectiveControlCmd.targetSpeed : 0;
  const reversing = oldSpeed * requested < 0;
  const driverHoldingForward = Boolean(
    driverCommand && requested > 0.15 && oldSpeed >= -0.05 && !reversing,
  );
  const slowing = !driverHoldingForward && (Math.abs(requested) < Math.abs(oldSpeed) || reversing);
  const stoppedAtContact = Boolean(contact && Math.abs(speed) <= 0.25);
  const controls = {
    throttle: !stoppedAtContact && (driverHoldingForward || (!slowing && Math.abs(requested) > 0.05 && (Math.abs(requested) > Math.abs(oldSpeed) + 1e-8 || Boolean(contact)))) ? 1 : 0,
    brake: stoppedAtContact || (slowing && Math.abs(oldSpeed) > 1e-8) ? 1 : 0,
    gear: Math.abs(speed) > 1e-8 ? (speed > 0 ? "D" : "R") : requested === 0 ? "N" : requested > 0 ? "D" : "R",
  };
  let latchedContact = previous.contact;
  if (latchedContact) {
    const dx = after.x - latchedContact.x, dz = after.z - latchedContact.z;
    const released = before.spec?.contactResponse === "inelastic-slide-v1"
      ? contactSeparated
      : Math.hypot(dx, dz) > 0.25;
    if (released) latchedContact = null;
  }
  const damage = cloneDamage(previous.damage);
  // Dispatch has authoritative contact episodes, even when the ego proposed no travel.
  if (freshImpacts) {
    let appliedInStep = 0;
    for (const impact of freshImpacts) {
      if (impact.closingSpeedMps >= 0.35 && damageSides.includes(impact.side)) {
        dent(damage, impact, tick, after, appliedInStep > 0);
        appliedInStep++;
      }
    }
  }
  if (contact) {
    const closingSpeedMps = Math.max(0, contact.closingSpeedMps);
    const scrubEnabled =
      (before.spec?.wheelInteractionPhysics ?? before.wheelInteractionPhysics) === WHEEL_SCRUB_MODE;
    const hasMotion = scrubEnabled
      ? (contact.relativeTravelM ?? contact.proposedTravelM ?? 0) > 1e-8
      : Math.abs(oldSpeed) >= 0.15 && contact.proposedTravelM > 1e-8;
    if (
      !freshImpacts &&
      closingSpeedMps >= 0.35 &&
      hasMotion &&
      latchedContact?.hitId !== contact.hitId &&
      damageSides.includes(contact.side)
    ) {
      const energyJ = before.spec?.contactResponse === "inelastic-slide-v1"
        ? Math.max(0, Number.isFinite(contact.energyJ) ? contact.energyJ : 0)
        : 0.5 * dimensions.massKg * closingSpeedMps ** 2;
      dent(damage, { ...contact, closingSpeedMps, energyJ }, tick, after, false);
    }
    latchedContact = {
      hitId: contact.hitId,
      x: after.x,
      z: after.z,
      tick,
      ...(before.spec?.contactResponse === "inelastic-slide-v1"
        ? { normal: { ...contact.normal } } : {}),
    };
  }
  const suspension = {
    pitchRad: pitch.value,
    rollRad: roll.value,
    heaveM: heave.value,
    pitchVelocityRadS: pitch.velocity,
    rollVelocityRadS: roll.velocity,
    heaveVelocityMps: heave.velocity,
    wheelOffsetsM,
  };
  const interaction = computeWheelInteractionState(
    before,
    after,
    command,
    suspension,
    wheelLoadsN,
    { surface, contact, curbScrub, scraping, driverCommand, dt },
  );
  const rawSteeringWheelRad =
    steer * dimensions.steeringRatio +
    scrapeSteerKickRad * (dimensions.steeringRatio * 0.55);
  const steeringWheelRad = Object.is(rawSteeringWheelRad, -0) ? 0 : rawSteeringWheelRad;

  return {
    wheelAngles: wheelAngles(steer, dimensions),
    wheelSpinRad: (previous.wheelSpinRad + signedTravel / (dimensions.wheelRadiusM * (before.giantScale ?? 1))) % tau,
    steeringWheelRad,
    suspension,
    wheelLoadsN,
    controls,
    contact: latchedContact,
    damage,
    interaction,
    nitroCharge: Number.isFinite(after?.nitroCharge)
      ? after.nitroCharge
      : Number.isFinite(before?.nitroCharge)
        ? before.nitroCharge
        : (previous.nitroCharge ?? 1),
    nitroActive: Boolean(after?.nitroActive ?? before?.nitroActive ?? false),
    nitroIntensity: Number.isFinite(after?.nitroIntensity)
      ? after.nitroIntensity
      : Number.isFinite(before?.nitroIntensity)
        ? before.nitroIntensity
        : 0,
    nitroSuppressedByPedestrian: Boolean(
      after?.nitroSuppressedByPedestrian ?? before?.nitroSuppressedByPedestrian ?? false,
    ),
    ...(hasSurface
      ? {
          surface: {
            kind: surface.surfaceKind ?? surface.kind ?? "asphalt",
            gripMultiplier: round4(surface.gripMultiplier ?? 1),
            rollingDragMps2: round4(surface.rollingDragMps2 ?? 0),
            gradeSin: round4(surface.gradeSin ?? 0),
            gradePct: round4((surface.gradeSin ?? 0) * 100),
            camberSin: round4(surface.camberSin ?? 0),
            elevationM: round4(surface.elevationM ?? 0),
            waterDepthM: round4(surface.waterDepthM ?? 0),
            sandDepthM: round4(surface.sandDepthM ?? 0),
          },
        }
      : {}),
  };
}
