import { STEP, clamp } from "./config.js";
import { distance, angleDelta, pointOnRoad } from "./geometry.js";
import { walkingWaypoint, walkSegmentClear } from "./walk-route.js";
const pose = (road, along, side, offset) =>
  road.axis === "z"
    ? { x: road.fixed - side * offset, z: along }
    : { x: along, z: road.fixed + side * offset };
export function nextWalk(world, person) {
  person.walkRoute = null;
  const road = person.road;
  person.walkDirection ??= person.phase < 0.5 ? -1 : 1;
  const crossing = world.rng.next() < 0.15 + world.config.chaos * 0.3;
  if (crossing) {
    person.target = pose(
      road,
      person.along,
      -person.side,
      road.width / 2 + 1.25,
    );
    person.crossing = true;
    person.pause = world.rng.range(0.4, 1.4);
  } else {
    const min = road.min + 6,
      max = road.max - 6;
    if (
      (person.walkDirection > 0 && max - person.along < 5) ||
      (person.walkDirection < 0 && person.along - min < 5)
    )
      person.walkDirection *= -1;
    const stride = world.rng.range(18, 42);
    let next = clamp(person.along + stride * person.walkDirection, min, max);
    if (Math.abs(next - person.along) < 3) {
      person.walkDirection *= -1;
      next = clamp(person.along + stride * person.walkDirection, min, max);
    }
    person.target = pose(road, next, person.side, road.width / 2 + 1.25);
    person.crossing = false;
    person.pause = world.rng.next() < 0.1 ? world.rng.range(0.4, 1.2) : 0;
  }
}

export function pedestrianMotion(world, p) {
  if (p.pause > 0) {
    p.pause = Math.max(0, p.pause - STEP);
    return { ...p, speed: 0, reason: "waiting" };
  }
  let remaining = distance(p, p.target);
  if (remaining < 0.22) {
    if (p.crossing) p.side = -p.side;
    p.along = p.road.axis === "z" ? p.z : p.x;
    world.nextWalk(p);
    if (p.pause > 0) return { ...p, speed: 0, reason: "waiting" };
    // A waypoint is not a stop: carry the walking motion into the next leg.
    remaining = distance(p, p.target);
    if (remaining < 0.22) return { ...p, speed: 0, reason: "waiting" };
  }
  // Check an approaching vehicle before entering the carriageway; once a
  // crossing has started, keep walking so the person can clear the lane.
  if (
    !pointOnRoad(p, world.roads) &&
    pointOnRoad(
      {
        ...p,
        x: p.x + (p.target.x - p.x) / remaining,
        z: p.z + (p.target.z - p.z) / remaining,
      },
      world.roads,
    )
  ) {
    const danger = world.actors.some(
      (a) =>
        a.type === "vehicle" &&
        a.speed > 0.4 &&
        distance(p, a) < Math.max(5, a.speed * 2.2) &&
        (p.x - a.x) * Math.sin(a.heading) + (p.z - a.z) * Math.cos(a.heading) >
          -2,
    );
    if (danger) return { ...p, speed: 0, reason: "looking" };
  }
  const nearby = world.actorIndex
    .near(p, 28)
    .filter((a) => a !== p)
    .concat(world.staticIndex.near(p, 34));
  const waypoint = walkingWaypoint(world, p, nearby);
  const desired = Math.atan2(waypoint.x - p.x, waypoint.z - p.z);
  const close = nearby.filter(
    (a) => distance(a, p) < (a.type === "static" ? 10 : 5),
  );
  let targetHeading = desired,
    best = Infinity;
  // Walk round personal space using a consistent right-side preference. The
  // candidate score breaks the symmetric face-to-face pedestrian deadlock.
  for (const turn of [0, -0.5, 0.5, -1, 1, -1.6, 1.6, -2.2, 2.2, Math.PI]) {
    const heading = desired + turn;
    const probeLength = Math.min(0.95, distance(p, waypoint));
    const probe = {
      ...p,
      x: p.x + Math.sin(heading) * probeLength,
      z: p.z + Math.cos(heading) * probeLength,
    };
    if (!walkSegmentClear(p, p, probe, close, 0.12)) continue;
    const score =
      distance(probe, waypoint) +
      Math.abs(turn) * 0.08 +
      (turn > 0 ? 0.03 : 0) +
      Math.abs(angleDelta(heading, p.walkHeading ?? p.heading)) * 0.24;
    if (score < best) {
      best = score;
      targetHeading = heading;
    }
  }
  if (best !== Infinity) p.walkHeading = targetHeading;
  const heading =
    p.heading +
    clamp(angleDelta(targetHeading, p.heading), -3 * STEP, 3 * STEP);
  const turn = Math.abs(angleDelta(targetHeading, heading));
  const speed =
    best === Infinity
      ? 0
      : Math.min(p.walkSpeed, p.speed + 2.5 * STEP, remaining / STEP) *
        Math.max(0, Math.cos(turn)) ** 3;
  return {
    ...p,
    x: p.x + Math.sin(heading) * speed * STEP,
    z: p.z + Math.cos(heading) * speed * STEP,
    heading,
    speed,
    reason: p.crossing ? "crossing" : "walking",
  };
}
