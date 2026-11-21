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
  const length = dimension(body.length, PLAYER_VEHICLE.lengthM) / scale;
  const width = dimension(body.width, PLAYER_VEHICLE.widthM) / scale;
  const camera = {
    id: "front-camera",
    angleDeg: 0,
    position: { x: 0, y: 1.46, z: 0.72 },
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
        position: { x: 0, y: 1.3, z: -length / 2 - 0.035 },
      },
    ],
    telemetry: {
      id: "roof-imu-gnss",
      position: { x: 0, y: 1.88, z: -0.15 },
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
    y: PLAYER_VEHICLE.roadHeightM + (body.y ?? 0) + position.y,
    z: body.z - position.x * s + position.z * c,
  };
}
