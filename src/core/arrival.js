import { angleDelta, bodyOnRoad, distance, overlaps } from "./geometry.js";
import { insideJunction } from "./junctions.js";
import { LANE_OFFSET, planNavigation } from "./navigation.js";
import { PLACES } from "./places.js";

export function parkingBays(graph, junctionGroups, roads) {
  const bays = [],
    used = new Set();
  for (const place of PLACES) {
    let count = 0;
    for (const node of [...graph.values()].sort(
      (a, b) => distance(a, place) - distance(b, place),
    )) {
      if (distance(node, place) > 70 || count >= 16) break;
      if (junctionGroups.some((group) => insideJunction(node, group, 4)))
        continue;
      for (const road of roads) {
        if (road.width < 10) continue;
        const along = road.axis === "z" ? node.z : node.x;
        const cross = road.axis === "z" ? node.x : node.z;
        if (
          Math.abs(cross - road.fixed) > 0.01 ||
          along < road.min + 6 ||
          along > road.max - 6
        )
          continue;
        const marker = `${road.axis}:${road.fixed}:${along}`;
        if (used.has(marker)) break;
        used.add(marker);
        for (const side of [-1, 1])
          bays.push({
            axis: road.axis,
            fixed: road.fixed + side * 5.6,
            min: Math.max(road.min, along - 18),
            max: Math.min(road.max, along + 18),
            width: 2.2,
            parkingBay: true,
            nodeKey: node.key,
            side,
          });
        count++;
        break;
      }
    }
  }
  return bays;
}

// Stop on the right shoulder of a wide road near the destination. The narrow
// streets cannot fit a parked car beside a moving lane; never park on a curb.
export function planArrival(world, goal) {
  const car = world.player;
  const candidates = [...world.graph.values()]
    .filter(
      (node) =>
        !world.junctionGroups.some((group) => insideJunction(node, group, 4)),
    )
    .sort((a, b) => distance(a, goal) - distance(b, goal));
  for (const node of candidates) {
    if (distance(node, goal) > 70) break;
    const path = planNavigation(
      world.graph,
      car,
      node,
      world.actors,
      world.trafficPressure(),
    );
    if (path.length < 3) continue;
    const end = path.at(-1),
      before = path.at(-2);
    const heading = Math.atan2(end.x - before.x, end.z - before.z);
    const forward = { x: Math.sin(heading), z: Math.cos(heading) };
    const right = { x: -forward.z, z: forward.x };
    const road = world.drivingRoads.find(
      (r) =>
        r.width >= 10 &&
        Math.abs(angleDelta(heading, r.axis === "z" ? 0 : Math.PI / 2)) %
          Math.PI <
          0.01 &&
        Math.abs((r.axis === "z" ? node.x : node.z) - r.fixed) < 0.01 &&
        (r.axis === "z" ? node.z : node.x) > r.min + 4 &&
        (r.axis === "z" ? node.z : node.x) < r.max - 4,
    );
    if (!road) continue;
    const side = Math.sign(road.axis === "z" ? right.x : right.z);
    if (
      !world.parkingBays.some(
        (bay) =>
          bay.nodeKey === node.key &&
          bay.side === side &&
          bay.axis === road.axis &&
          Math.abs(bay.fixed - road.fixed - side * 5.6) < 0.01,
      )
    )
      continue;
    let start = path.length - 1;
    while (start > 0 && distance(path[start], end) < 16) start--;
    if (distance(path[start], end) < 16) continue;
    // The final approach must be straight before beginning the pull-over.
    if (
      path
        .slice(start)
        .some(
          (p) =>
            Math.abs((p.x - end.x) * right.x + (p.z - end.z) * right.z) > 0.02,
        )
    )
      continue;
    const shift = 4.9 - LANE_OFFSET;
    const parking = {
      x: end.x + right.x * shift + forward.x * 1.2,
      z: end.z + right.z * shift + forward.z * 1.2,
      heading,
    };
    if (
      world.actors.some(
        (a) => a !== car && overlaps({ ...car, ...parking }, a, 0.6),
      )
    )
      continue;
    const centers = path.map((p, i) => {
      if (i < start) return p;
      const t = Math.max(0, Math.min(1, (16 - distance(p, end)) / 12));
      const lateral = shift * t * t * (3 - 2 * t);
      return { x: p.x + right.x * lateral, z: p.z + right.z * lateral };
    });
    if (
      centers.slice(start).some((p, i, tail) => {
        const next = tail[Math.min(i + 1, tail.length - 1)];
        const yaw =
          i === tail.length - 1
            ? heading
            : Math.atan2(next.x - p.x, next.z - p.z);
        return !bodyOnRoad({ ...car, ...p, heading: yaw }, world.roads);
      })
    )
      continue;
    const route = centers.map((p, i) => {
      if (i < start || i === centers.length - 1) return p;
      const next = centers[i + 1];
      const yaw = Math.atan2(next.x - p.x, next.z - p.z);
      // The follower targets the rear axle. Compensate its lateral position so
      // the body centre, rather than the rear axle, follows the pull-over curve.
      const correction = Math.sin(angleDelta(yaw, heading)) * 1.3;
      return { x: p.x + right.x * correction, z: p.z + right.z * correction };
    });
    return { path: route, parking };
  }
  return null;
}
