import { distance, bodyOnRoad, angleDelta } from "./geometry.js";
import { planNavigation } from "./navigation.js";
import { SpatialIndex } from "./spatial-index.js";

export const SCENARIOS = Object.freeze(["crossing", "side-traffic", "barrier"]);
export function triggerScenario(world, kind = world.rng.pick(SCENARIOS)) {
  if (world.environment !== "lab" || !SCENARIOS.includes(kind)) return false;
  const player = world.player;
  let changed = false;
  if (kind === "crossing") {
    const people = world.actors.filter(
      (a) => a.type === "pedestrian" && !a.crossing,
    );
    people.sort(
      (a, b) =>
        distance(a, player) - distance(b, player) || a.id.localeCompare(b.id),
    );
    const person = people[0];
    if (person) {
      const road = person.road,
        offset = road.width / 2 + 1.25;
      person.target =
        road.axis === "z"
          ? { x: road.fixed + person.side * offset, z: person.z }
          : { x: person.x, z: road.fixed - person.side * offset };
      person.crossing = true;
      person.pause = 0;
      person.walkSpeed = 1.35 + world.config.difficulty * 0.2;
      changed = true;
    }
  } else if (kind === "side-traffic") {
    const vehicles = world.actors.filter(
      (a) => a !== player && a.kind === "tuktuk" && distance(a, player) > 9,
    );
    vehicles.sort(
      (a, b) =>
        distance(a, player) - distance(b, player) || a.id.localeCompare(b.id),
    );
    for (const vehicle of vehicles) {
      const goals = [...world.junctions].sort(
        (a, b) => distance(a, player) - distance(b, player),
      );
      for (const goal of goals.slice(0, 3)) {
        const path = planNavigation(world.graph, vehicle, goal, world.actors);
        if (path.length < 12) continue;
        const last = path.at(-1),
          before = path.at(-2),
          heading = Math.atan2(last.x - before.x, last.z - before.z);
        if (
          !goal.edges.some((key) => {
            const p = world.graph.get(key);
            return (
              Math.abs(
                angleDelta(Math.atan2(p.x - goal.x, p.z - goal.z), heading),
              ) < 0.1
            );
          })
        )
          continue;
        vehicle.path = path;
        vehicle.cursor = 0;
        vehicle.reckless = true;
        changed = true;
        break;
      }
      if (changed) break;
    }
  } else {
    // Scenario barriers are injected ahead with an empty footprint, never on
    // top of an actor. They are scheduled events, not a collision correction.
    const candidates = player.path.filter(
      (p) => distance(p, player) > 16 && distance(p, player) < 24,
    );
    if (!candidates.length)
      candidates.push({
        x: player.x + Math.sin(player.heading) * 18,
        z: player.z + Math.cos(player.heading) * 18,
      });
    for (const point of candidates) {
      const barrier = {
        id: `barrier-${world.tick}`,
        type: "static",
        kind: "barrier",
        x: point.x,
        z: point.z,
        heading: player.heading,
        width: 2.3,
        length: 0.7,
        height: 0.9,
        expires: world.tick + Math.round((8 + world.rng.range(0, 5)) * 60),
      };
      if (!bodyOnRoad(barrier, world.roads) || !world.free(barrier, 4))
        continue;
      world.statics.push(barrier);
      world.staticIndex = new SpatialIndex(world.statics);
      changed = true;
      break;
    }
  }
  world.scenario = { kind, tick: world.tick, applied: changed };
  if (changed) world.metrics.scenarios++;
  return changed;
}
export function updateScenarios(world) {
  if (world.environment !== "lab") return;
  if (
    world.statics.some((item) => item.expires && item.expires <= world.tick)
  ) {
    world.statics = world.statics.filter(
      (item) => !item.expires || item.expires > world.tick,
    );
    world.staticIndex = new SpatialIndex(world.statics);
  }
  const interval = Math.round(world.config.scenarioInterval * 60);
  if (world.tick > 0 && world.tick % interval === 0) triggerScenario(world);
}
