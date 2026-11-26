export const JETOUR_T2_ID = "jetour-t2";
export const KING_LONG_MICROBUS_ID = "king-long-microbus";

export const PLAYER_VEHICLE = Object.freeze({
  lengthM: 4.2,
  widthM: 1.85,
  heightM: 1.82,
  wheelbaseM: 2.6,
  trackM: 1.55,
  wheelRadiusM: 0.35,
  massKg: 1800,
  steeringRatio: 14.5,
  maxSteerRad: 0.62,
  maxRangeM: 35,
  roadHeightM: 0.12,
  centerOfMassHeightM: 0.68,
  suspensionTravelM: 0.07,
});

// Approximate dimensions and handling for the game, not manufacturer data.
export const KING_LONG_MICROBUS = Object.freeze({
  lengthM: 4.84,
  widthM: 1.70,
  heightM: 2.02,
  wheelbaseM: 2.57,
  trackM: 1.45,
  wheelRadiusM: 0.315,
  wheelWidthM: 0.195,
  axleCenterZM: 0.27,
  massKg: 2250,
  steeringRatio: 18,
  maxSteerRad: 0.51,
  maxRangeM: 35,
  roadHeightM: 0.12,
  centerOfMassHeightM: 0.91,
  suspensionTravelM: 0.085,
  curbClearanceM: 0.13,
  frontWeightFraction: 0.46,
  rollGradient: 0.0205,
  rollLimitRad: 0.12,
  accelerationMps2: 1.8,
  brakingMps2: 5.6,
  steerRateRadS: 0.72,
  reverseSpeedMps: 1.95,
  maxSpeedMps: 12.5,
  tireGripMps2: 7,
  chaseAccelerationMps2: 4.5,
  chaseSteerRateRadS: 1.15,
  chaseReverseSpeedMps: 3.1,
  chaseMaxSpeedMps: 25,
  nitroAccelerationMultiplier: 1.3,
});

export function playerVehicleDimensions(body) {
  return body?.vehicleModel === KING_LONG_MICROBUS_ID ? KING_LONG_MICROBUS : PLAYER_VEHICLE;
}

export function staticVehicleWheelLoadN(dimensions, front) {
  const frontFraction = dimensions.frontWeightFraction ?? 0.5;
  return dimensions.massKg * 9.81 * (front ? frontFraction : 1 - frontFraction) / 2;
}

const rangeLayout = [
  ["left-outer", -70, -0.76],
  ["left-inner", -35, -0.43],
  ["center", 0, 0],
  ["right-inner", 35, 0.43],
  ["right-outer", 70, 0.76],
];
const dimension = (value, fallback) =>
  Number.isFinite(value) && value > 0 ? value : fallback;

/** Mount positions are road-local metres, independent of chassis load motion. */
export function getVehicleMounts(body = {}) {
  const scale = body.giantScale ?? 1;
  const dimensions = playerVehicleDimensions(body);
  const microbus = dimensions === KING_LONG_MICROBUS;
  const length = dimension(body.length, dimensions.lengthM) / scale;
  const width = dimension(body.width, dimensions.widthM) / scale;
  const camera = {
    id: "front-camera",
    angleDeg: 0,
    position: microbus ? { x: 0, y: 1.67, z: 1.67 } : { x: 0, y: 1.46, z: 0.72 },
  };
  const mounts = {
    ranges: rangeLayout.map(([id, angleDeg, x]) => ({
      id,
      angleDeg,
      position: {
        x: (x * width) / PLAYER_VEHICLE.widthM,
        y: 0.54,
        z: length / 2 + 0.04,
      },
    })),
    auxiliary: [
      ...[
        ["rear-left", -145, -0.66],
        ["rear-center", 180, 0],
        ["rear-right", 145, 0.66],
      ].map(([id, angleDeg, x]) => ({
        id,
        angleDeg,
        position: {
          x: (x * width) / PLAYER_VEHICLE.widthM,
          y: 0.58,
          z: -length / 2 - 0.04,
        },
      })),
      {
        id: "side-left",
        angleDeg: -90,
        position: { x: -width / 2 - 0.03, y: 0.64, z: 0.15 },
      },
      {
        id: "side-right",
        angleDeg: 90,
        position: { x: width / 2 + 0.03, y: 0.64, z: 0.15 },
      },
    ],
    camera,
    cameras: [
      camera,
      {
        id: "rear-camera",
        angleDeg: 180,
        position: { x: 0, y: microbus ? 1.50 : 1.3, z: -length / 2 - 0.035 },
      },
    ],
    telemetry: {
      id: "roof-imu-gnss",
      position: { x: 0, y: microbus ? 2.05 : 1.88, z: -0.15 },
    },
  };
  if (scale !== 1) {
    for (const { position: p } of [...mounts.ranges, ...mounts.auxiliary, ...mounts.cameras, mounts.telemetry]) {
      p.x *= scale;
      p.y *= scale;
      p.z *= scale;
    }
  }
  return mounts;
}

export function mountToWorld(body, position) {
  const c = Math.cos(body.heading ?? 0);
  const s = Math.sin(body.heading ?? 0);
  return {
    x: body.x + position.x * c + position.z * s,
    y: playerVehicleDimensions(body).roadHeightM + (body.y ?? 0) + position.y,
    z: body.z - position.x * s + position.z * c,
  };
}
