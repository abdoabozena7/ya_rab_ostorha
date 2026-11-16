// Virtual five-beam proximity array. Inputs are simulation geometry, not camera
// detections. Sampling and filtering happen on fixed simulation ticks.
export const SENSOR_ANGLES_DEG = Object.freeze([-70, -35, 0, 35, 70]);
export const SENSOR_MAX_M = 35;

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

export function measureRanges(world, car) {
  const origin = {
    x: car.x + Math.sin(car.heading) * (car.length / 2 + 0.15),
    z: car.z + Math.cos(car.heading) * (car.length / 2 + 0.15),
  };
  const obstacles = [...world.actors, ...world.statics].filter((body) => {
    if (body === car) return false;
    return Math.hypot(body.x - origin.x, body.z - origin.z) < SENSOR_MAX_M + 15;
  });
  return SENSOR_ANGLES_DEG.map((degrees) => {
    const angle = car.heading + (degrees * Math.PI) / 180;
    const ray = { x: Math.sin(angle), z: Math.cos(angle) };
    let nearest = SENSOR_MAX_M;
    for (const body of obstacles) {
      const hit =
        body.type === "pedestrian"
          ? circleHit(origin, ray, body)
          : boxHit(origin, ray, body);
      nearest = Math.min(nearest, hit);
    }
    return Math.round(nearest * 100) / 100;
  });
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
