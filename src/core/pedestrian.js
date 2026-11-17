import { STEP, clamp } from "./config.js";
import { distance, angleDelta, pointOnRoad } from "./geometry.js";
import { walkingWaypoint, walkSegmentClear } from "./walk-route.js";
import { createPedestrianBody } from "./pedestrian-body.js";
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

function nearbyBodies(world, p) {
  return world.actorIndex
    .near(p, 28)
    .filter((a) => a !== p)
    .concat(world.staticIndex.near(p, 34));
}

function move(p, body, heading, targetSpeed, reason, nearby) {
  const speed = clamp(
    targetSpeed,
    Math.max(0, p.speed - body.maxDecelerationMps2 * STEP),
    p.speed + body.maxAccelerationMps2 * STEP,
  );
  const next = {
    ...p,
    x: p.x + Math.sin(heading) * speed * STEP,
    z: p.z + Math.cos(heading) * speed * STEP,
    heading,
    speed,
    accelerationMps2: (speed - p.speed) / STEP,
    turnRateRadS: angleDelta(heading, p.heading) / STEP,
    reason,
  };
  // Match World's reserved-body guard; an occupied step is the only instant stop.
  if (speed > 0 && !walkSegmentClear(p, p, next, nearby, 0.12)) {
    next.x = p.x;
    next.z = p.z;
    next.speed = 0;
    next.accelerationMps2 = -p.speed / STEP;
    next.reason = "blocked";
  }
  return next;
}

export function pedestrianMotion(world, p) {
  const body = p.body ??= createPedestrianBody(p);
  const stop = (reason) =>
    move(p, body, p.heading, 0, reason, nearbyBodies(world, p));
  if (p.motionMode === "stop")
    return stop(p.speed > 0 ? "stopping" : "stopped");
  if (p.pause > 0) {
    if (p.speed === 0) p.pause = Math.max(0, p.pause - STEP);
    return stop("waiting");
  }
  let remaining = distance(p, p.target);
  if (remaining < 0.22) {
    if (p.crossing) p.side = -p.side;
    p.along = p.road.axis === "z" ? p.z : p.x;
    world.nextWalk(p);
    if (p.pause > 0) return stop("waiting");
    // A waypoint is not a stop: carry the walking motion into the next leg.
    remaining = distance(p, p.target);
    if (remaining < 0.22) return stop("waiting");
  }
  // Check an approaching vehicle before entering the carriageway; once a
  // crossing has started, keep walking so the person can clear the lane.
  const approach = Math.min(
    remaining,
    Math.max(
      1,
      p.speed ** 2 / (2 * body.maxDecelerationMps2) +
        p.speed * STEP + p.radius + 0.1,
    ),
  );
  if (
    !pointOnRoad(p, world.roads) &&
    pointOnRoad(
      {
        ...p,
        x: p.x + (p.target.x - p.x) / remaining * approach,
        z: p.z + (p.target.z - p.z) / remaining * approach,
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
    if (danger) return stop("looking");
  }
  const nearby = nearbyBodies(world, p);
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
    clamp(
      angleDelta(targetHeading, p.heading),
      -body.maxTurnRateRadS * STEP,
      body.maxTurnRateRadS * STEP,
    );
  const turn = Math.abs(angleDelta(targetHeading, heading));
  const walkingSpeed = clamp(
    Number.isFinite(p.walkSpeed) ? p.walkSpeed : body.walkSpeedMps,
    0,
    3.2,
  );
  const requestedSpeed = p.motionMode === "jog"
    ? Math.max(walkingSpeed, body.jogSpeedMps) : walkingSpeed;
  const targetSpeed =
    best === Infinity
      ? 0
      : requestedSpeed * Math.max(0, Math.cos(turn)) ** 3;
  return move(
    p, body, heading, targetSpeed,
    best === Infinity ? "yielding" : p.crossing ? "crossing" : "walking",
    nearby,
  );
}
