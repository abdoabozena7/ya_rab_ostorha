import { angleDelta, distance, overlaps } from "./geometry.js";
import { signalSpeedLimit } from "./signals.js";

// Junctions less than 24 m apart have no room to queue a full vehicle between
// their stop lines. Reserve them as one area to avoid circular hold-and-wait.
export function junctionGroups(junctions) {
  const remaining = new Set(junctions),
    groups = [];
  while (remaining.size) {
    const members = [remaining.values().next().value];
    remaining.delete(members[0]);
    for (let i = 0; i < members.length; i++)
      for (const node of remaining) {
        if (distance(members[i], node) < 24) {
          members.push(node);
          remaining.delete(node);
        }
      }
    groups.push({
      key: members
        .map((n) => n.key)
        .sort()
        .join("|"),
      members,
      minX: Math.min(...members.map((n) => n.x)) - 8.4,
      maxX: Math.max(...members.map((n) => n.x)) + 8.4,
      minZ: Math.min(...members.map((n) => n.z)) - 8.4,
      maxZ: Math.max(...members.map((n) => n.z)) + 8.4,
    });
  }
  return groups;
}
export function insideJunction(car, group, margin = 0) {
  return (
    car.x >= group.minX - margin &&
    car.x <= group.maxX + margin &&
    car.z >= group.minZ - margin &&
    car.z <= group.maxZ + margin
  );
}
function entryDistance(car, group) {
  let near = 0,
    far = Infinity;
  for (const [axis, velocity, min, max] of [
    ["x", Math.sin(car.heading), group.minX, group.maxX],
    ["z", Math.cos(car.heading), group.minZ, group.maxZ],
  ]) {
    if (Math.abs(velocity) < 1e-6) {
      if (car[axis] < min || car[axis] > max) return Infinity;
    } else {
      const a = (min - car[axis]) / velocity,
        b = (max - car[axis]) / velocity;
      near = Math.max(near, Math.min(a, b));
      far = Math.min(far, Math.max(a, b));
    }
  }
  return near <= far && far >= 0 ? near : Infinity;
}
function corridor(world, car, group) {
  world.junctionCorridors ??= new Map();
  const key = `${group.key}:${car.id}`;
  const cached = world.junctionCorridors.get(key);
  if (cached?.path === car.path) return cached.samples;
  const samples = [];
  const path = car.path.length
    ? car.path.slice(Math.max(0, car.cursor - 2))
    : Array.from({ length: 45 }, (_, i) => ({
        x: car.x + Math.sin(car.heading) * i * 2,
        z: car.z + Math.cos(car.heading) * i * 2,
      }));
  let entered = false,
    last = null;
  for (let i = 0; i < path.length; i++) {
    const point = path[i];
    if (!insideJunction(point, group, 3)) {
      if (entered) break;
      else continue;
    }
    entered = true;
    if (last && distance(last, point) < 1.5 && i < path.length - 1) continue;
    const next = path[Math.min(i + 1, path.length - 1)],
      before = path[Math.max(0, i - 1)];
    const heading = Math.atan2(next.x - before.x, next.z - before.z);
    samples.push({
      type: "vehicle",
      ...point,
      heading,
      width: car.width + 0.35,
      length: car.length + 2,
    });
    last = point;
  }
  world.junctionCorridors.set(key, { path: car.path, samples });
  return samples;
}
const conflictCache = new WeakMap();
function conflicts(a, b) {
  let cache = conflictCache.get(a);
  if (!cache) {
    cache = new WeakMap();
    conflictCache.set(a, cache);
  }
  if (!cache.has(b))
    cache.set(
      b,
      a.some((p) => b.some((q) => overlaps(p, q))),
    );
  return cache.get(b);
}
function sameLane(a, b) {
  const dx = b.x - a.x,
    dz = b.z - a.z;
  return (
    Math.abs(angleDelta(a.heading, b.heading)) < 0.16 &&
    Math.abs(dx * Math.cos(a.heading) - dz * Math.sin(a.heading)) < 1.25
  );
}
function aheadOfQueuedOwner(car, owner, group) {
  if (insideJunction(owner, group)) return false;
  const heading = Math.round(owner.heading / (Math.PI / 2)) * (Math.PI / 2),
    dx = car.x - owner.x,
    dz = car.z - owner.z;
  return (
    Math.abs(angleDelta(car.heading, owner.heading)) < 0.4 &&
    Math.abs(angleDelta(car.heading, heading)) < 0.4 &&
    Math.abs(angleDelta(owner.heading, heading)) < 0.4 &&
    Math.abs(dx * Math.cos(heading) - dz * Math.sin(heading)) < 1.25 &&
    dx * Math.sin(heading) + dz * Math.cos(heading) > 2
  );
}
export function junctionLimit(world, car) {
  let limit = Infinity,
    blockedBy = null;
  for (const group of world.junctionGroups) {
    const owners = world.junctionOwners.get(group.key) ?? [];
    if (owners.some((owner) => owner.id === car.id)) continue;
    const entry = entryDistance(car, group);
    if (entry > 24) continue;
    const speed = Math.sqrt(Math.max(0, entry - 0.3) * 4);
    if (speed < limit) {
      limit = speed;
      blockedBy = owners[0]?.id ?? null;
    }
  }
  return { limit, blockedBy };
}
export function updateJunctions(world) {
  const cars = world.actors.filter((a) => a.type === "vehicle"),
    approaches = new Map();
  for (const car of cars) {
    let closest = null,
      best = 24;
    for (const group of world.junctionGroups) {
      const d = entryDistance(car, group);
      if (d < best) {
        closest = group;
        best = d;
      }
    }
    if (car.queuedJunction !== closest?.key) {
      car.queuedJunction = closest?.key ?? null;
      car.junctionArrival = world.tick;
    }
    if (closest) approaches.set(car.id, { group: closest, distance: best });
  }
  for (const group of world.junctionGroups) {
    const owners = world.junctionOwners.get(group.key) ?? [];
    const retained = owners.filter((owner) => {
      const car = cars.find((a) => a.id === owner.id);
      if (!car) return false;
      if (insideJunction(car, group)) owner.entered = true;
      const cleared =
        owner.entered && !insideJunction(car, group, car.length / 2 + 0.15);
      const parked =
        !car.path.length ||
        (car.speed < 0.05 && signalSpeedLimit(world, car) < Infinity) ||
        (car === world.player &&
          world.mode === "manual" &&
          world.input.targetSpeed === 0 &&
          car.speed === 0);
      const retain =
        !cleared &&
        !parked &&
        (owner.entered || entryDistance(car, group) < 26);
      if (!retain) world.junctionCorridors?.delete(`${group.key}:${car.id}`);
      return retain;
    });
    if (retained.length) world.junctionOwners.set(group.key, retained);
    else world.junctionOwners.delete(group.key);
  }
  const holding = new Set(
    [...world.junctionOwners.values()].flat().map((o) => o.id),
  );
  for (const group of world.junctionGroups) {
    const owners = world.junctionOwners.get(group.key) ?? [];
    const candidates = cars.filter(
      (a) =>
        !holding.has(a.id) &&
        (a.path.length ||
          (a === world.player && world.input.targetSpeed > 0)) &&
        approaches.get(a.id)?.group === group &&
        signalSpeedLimit(world, a) === Infinity,
    );
    const fronts = new Map();
    for (const candidate of candidates) {
      const direction =
        ((Math.round(candidate.heading / (Math.PI / 2)) % 4) + 4) % 4;
      const lane = Math.round(
        (direction % 2 === 0 ? candidate.x : candidate.z) / 10,
      );
      const approachKey = `${direction}:${lane}`;
      const prior = fronts.get(approachKey);
      if (
        !prior ||
        approaches.get(candidate.id).distance <
          approaches.get(prior.id).distance
      )
        fronts.set(approachKey, candidate);
    }
    const waiting = [...fronts.values()].sort(
      (a, b) =>
        a.junctionArrival - b.junctionArrival || a.id.localeCompare(b.id),
    );
    const earlier = [];
    for (const car of waiting) {
      const path = corridor(world, car, group);
      // A trip may end shortly before this group. Do not grant a reservation
      // for that old route: the next trip can turn across an existing owner.
      if (!path.length) continue;
      const blocked =
        owners.some((o) => {
          const owner = cars.find((a) => a.id === o.id);
          return (
            !sameLane(car, owner) &&
            !aheadOfQueuedOwner(car, owner, group) &&
            conflicts(path, corridor(world, owner, group))
          );
        }) ||
        earlier.some(
          (entry) => !sameLane(car, entry.car) && conflicts(path, entry.path),
        );
      // An older conflicting approach retains its place in the queue, even
      // when another direction currently holds the reservation.
      earlier.push({ car, path });
      if (blocked) continue;
      owners.push({
        id: car.id,
        entered: insideJunction(car, group),
        since: world.tick,
      });
      holding.add(car.id);
    }
    if (owners.length) world.junctionOwners.set(group.key, owners);
  }
}
