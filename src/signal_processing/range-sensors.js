// Ten mounted virtual beams; the legacy filtered API retains its five fronts.
// Inputs are simulation geometry, not camera detections or hardware sensors.
import {
  getVehicleMounts,
  mountToWorld,
  PLAYER_VEHICLE,
} from "../core/vehicle-spec.js";

export const SENSOR_ANGLES_DEG = Object.freeze(
  getVehicleMounts().ranges.map((mount) => mount.angleDeg),
);
export const SENSOR_MAX_M = PLAYER_VEHICLE.maxRangeM;

function circleHit(origin, ray, body) {
  const dx = body.x - origin.x;
  const dz = body.z - origin.z;
  const projection = dx * ray.x + dz * ray.z;
  const radius = body.radius;
  const sideSquared = dx * dx + dz * dz - projection * projection;
  if (sideSquared > radius * radius) return Infinity;
  const halfChord = Math.sqrt(Math.max(0, radius * radius - sideSquared));
  const near = projection - halfChord;
  return projection + halfChord < 0 ? Infinity : Math.max(0, near);
}

function boxHit(origin, ray, body) {
  const angle = body.heading ?? 0;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const dx = origin.x - body.x;
  const dz = origin.z - body.z;
  const local = { x: dx * c - dz * s, z: dx * s + dz * c };
  const direction = { x: ray.x * c - ray.z * s, z: ray.x * s + ray.z * c };
  let near = -Infinity;
  let far = Infinity;
  for (const [axis, extent] of [
    ["x", body.width / 2],
    ["z", body.length / 2],
  ]) {
    if (Math.abs(direction[axis]) < 1e-9) {
      if (Math.abs(local[axis]) > extent) return Infinity;
      continue;
    }
    const a = (-extent - local[axis]) / direction[axis];
    const b = (extent - local[axis]) / direction[axis];
    near = Math.max(near, Math.min(a, b));
    far = Math.min(far, Math.max(a, b));
    if (near > far) return Infinity;
  }
  return far < 0 ? Infinity : Math.max(0, near);
}

export function measureVehicleSensors(world, car) {
  const local = getVehicleMounts(car);
  const worldMount = (mount) => ({
    ...mount,
    position: mountToWorld(car, mount.position),
  });
  const cameras = local.cameras.map((mount) => ({
    ...worldMount(mount),
    headingRad: (car.heading ?? 0) + mount.angleDeg * Math.PI / 180,
  }));
  const mounts = {
    ranges: local.ranges.map(worldMount),
    auxiliary: local.auxiliary.map(worldMount),
    camera: cameras[0],
    cameras,
    telemetry: worldMount(local.telemetry),
  };
  const proximityMounts = [...mounts.ranges, ...mounts.auxiliary];
  const mountReach = Math.max(
    ...[...local.ranges, ...local.auxiliary].map(
      (mount) => Math.hypot(mount.position.x, mount.position.z),
    ),
  );
  const obstacles = [...(world.actors ?? []), ...(world.statics ?? [])].filter((body) => {
    if (body === car || (car.id !== undefined && body.id === car.id)) return false;
    const radius =
      body.type === "pedestrian"
        ? body.radius
        : Math.hypot(body.width, body.length) / 2;
    return (
      Number.isFinite(radius) &&
      radius > 0 &&
      Number.isFinite(body.x) &&
      Number.isFinite(body.z) &&
      Math.hypot(body.x - car.x, body.z - car.z) <= SENSOR_MAX_M + mountReach + radius
    );
  });
  const rays = proximityMounts.map((mount) => {
    const origin = { ...mount.position };
    const angle = (car.heading ?? 0) + (mount.angleDeg * Math.PI) / 180;
    const ray = { x: Math.sin(angle), z: Math.cos(angle) };
    let nearest = SENSOR_MAX_M;
    let hitId = null;
    for (const body of obstacles) {
      const bottom = PLAYER_VEHICLE.roadHeightM + (body.y ?? 0);
      if (
        Number.isFinite(body.height) &&
        (origin.y < bottom || origin.y > bottom + body.height)
      )
        continue;
      const hit =
        body.type === "pedestrian"
          ? circleHit(origin, ray, body)
          : boxHit(origin, ray, body);
      if (hit <= nearest && (hitId === null || hit < nearest)) {
        nearest = hit;
        hitId = body.id ?? null;
      }
    }
    return {
      id: mount.id,
      angleDeg: mount.angleDeg,
      origin,
      end: {
        x: origin.x + ray.x * nearest,
        y: origin.y,
        z: origin.z + ray.z * nearest,
      },
      hitId,
      rangeM: nearest,
    };
  });
  return {
    rawM: rays.slice(0, SENSOR_ANGLES_DEG.length).map(
      (ray) => Math.round(ray.rangeM * 100) / 100,
    ),
    auxiliary: rays.slice(SENSOR_ANGLES_DEG.length),
    mounts,
    rays,
  };
}

export function measureRanges(world, car) {
  return measureVehicleSensors(world, car).rawM;
}

export class RangeSignalProcessor {
  constructor() {
    this.history = [];
    this.filtered = null;
  }

  update(raw) {
    if (
      raw.length !== SENSOR_ANGLES_DEG.length ||
      raw.some((n) => !Number.isFinite(n) || n < 0 || n > SENSOR_MAX_M)
    )
      throw new Error("Invalid proximity sample");
    this.history.push([...raw]);
    if (this.history.length > 3) this.history.shift();
    const median = raw.map(
      (_, index) =>
        [...this.history.map((sample) => sample[index])].sort((a, b) => a - b)[
          Math.floor(this.history.length / 2)
        ],
    );
    this.filtered = this.filtered
      ? median.map(
          (value, index) =>
            Math.round((this.filtered[index] * 0.55 + value * 0.45) * 100) /
            100,
        )
      : median;
    return {
      source: "simulated-geometry",
      anglesDeg: SENSOR_ANGLES_DEG,
      maxRangeM: SENSOR_MAX_M,
      rawM: [...raw],
      filteredM: [...this.filtered],
    };
  }
}
