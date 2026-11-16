// The policy may only lower the requested cruise speed. Junction, signal,
// collision and road-boundary guards run afterwards and remain authoritative.
export const POLICY_VERSION = 1;
export const SPEED_ACTIONS = Object.freeze([0.35, 0.6, 0.8, 1]);

export function policyObservation(world, car) {
  let nearest = Infinity;
  let kind = "clear";
  for (const actor of [...world.actors, ...world.statics]) {
    if (actor === car) continue;
    const dx = actor.x - car.x;
    const dz = actor.z - car.z;
    const ahead = dx * Math.sin(car.heading) + dz * Math.cos(car.heading);
    const side = Math.abs(
      dx * Math.cos(car.heading) - dz * Math.sin(car.heading),
    );
    if (ahead < -1 || ahead > 30 || side > 3.1 || ahead >= nearest) continue;
    nearest = ahead;
    kind = actor.type === "pedestrian" ? "person" : "obstacle";
  }
  const range =
    nearest < 7
      ? "near"
      : nearest < 16
        ? "middle"
        : nearest < 30
          ? "far"
          : "clear";
  const speed = car.speed < 2 ? "slow" : car.speed < 5 ? "medium" : "fast";
  return `${range}:${kind}:${speed}`;
}

export function validatePolicy(value) {
  if (
    value?.schemaVersion !== POLICY_VERSION ||
    value.algorithm !== "tabular-q-learning" ||
    !value.q ||
    typeof value.q !== "object" ||
    Array.isArray(value.q)
  )
    throw new Error("Unsupported policy weights");
  const entries = Object.entries(value.q);
  if (
    entries.length > 100 ||
    entries.some(
      ([key, row]) =>
        !/^(near|middle|far|clear):(clear|person|obstacle):(slow|medium|fast)$/.test(
          key,
        ) ||
        !Array.isArray(row) ||
        row.length !== SPEED_ACTIONS.length ||
        row.some((n) => !Number.isFinite(n) || Math.abs(n) > 1e6),
    )
  )
    throw new Error("Invalid policy weights");
  return value;
}

export function policyAction(weights, state) {
  const row = weights.q[state];
  if (!row) return SPEED_ACTIONS.length - 1;
  let selected = 0;
  for (let i = 1; i < row.length; i++) if (row[i] > row[selected]) selected = i;
  return selected;
}

export function policySpeed(world, car, requested) {
  if (world.policyActionOverride != null) {
    const i = world.policyActionOverride;
    if (Number.isInteger(i) && i >= 0 && i < SPEED_ACTIONS.length)
      return Math.min(requested, car.maxSpeed * SPEED_ACTIONS[i]);
  }
  if (!world.policy || car !== world.player || world.mode !== "auto")
    return requested;
  const action = policyAction(world.policy, policyObservation(world, car));
  return Math.min(requested, car.maxSpeed * SPEED_ACTIONS[action]);
}
