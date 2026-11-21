import { districtRoadPose } from "../core/egypt-district.js";
import { bodyOnRoad, overlaps } from "../core/geometry.js";
import { planDistrictRoute } from "../core/district-navigation.js";
import { Random } from "../core/random.js";

const sites = Object.freeze({
  "civic-souq": ["civic-avenue", "souq-collector", 1, 1, 6.7],
  "gateway-station": ["gateway-avenue", "station-avenue", 1, -1, 7.35],
  "gateway-university": ["university-avenue", "gateway-avenue", 1, -1, 7.0],
  "corniche-station": ["corniche-avenue", "station-avenue", 1, 1, 7.7],
  "civic-university": ["civic-avenue", "university-avenue", 1, -1, 8.6],
});

export function stagePocketCourse(world, id) {
  const [, name, mode] = /^pocket-([a-z-]+):(open|boxed)$/.exec(id) ?? [];
  if (!Object.hasOwn(sites, name) || world.tick !== 0 || world.environment !== "metro" || world.pursuit)
    throw new RangeError("Unknown or late Metro pocket course");
  const [approachId, exitId, input, output, approachM] = sites[name];
  const { player, district } = world;
  const approach = world.drivingRoads.find(road => road.id === approachId);
  const exit = world.drivingRoads.find(road => road.id === exitId);
  if (!approach || !exit || approach.axis === exit.axis) throw new Error("Missing pocket junction");
  const center = approach.axis === "z" ? { x: approach.fixed, z: exit.fixed } : { x: exit.fixed, z: approach.fixed };
  const rng = new Random(`${world.config.seed}:${name}:pocket-v1`);
  const start = districtRoadPose(approach, exit.fixed - input * (approachM + rng.range(-.16, .16)), input);
  const speed = rng.range(3.1, 3.5);
  const goal = { ...districtRoadPose(exit, approach.fixed + 33 * output, output), roadId: exit.id,
    id: `${name}-pocket-goal` };
  const ego = { ...player, ...start, speed };
  const path = planDistrictRoute(district, ego, goal);
  if (!bodyOnRoad(ego, world.roads) || path.length < 20 || path.length > 200 ||
      world.statics.concat(world.actors).some(body => body !== player && overlaps(body, ego, .12)))
    throw new Error(`No checked pocket approach to ${name}`);

  const halfX = approach.axis === "x" ? 11.5 : 8.2, halfZ = approach.axis === "z" ? 11.5 : 8.2;
  const thickness = .70;
  const sides = [["x", -1], ["x", 1], ["z", -1], ["z", 1]];
  const wall = ([axis, sign]) => ({
    id: `metro-lab-${name}-wall-${axis}-${sign}`, type: "static", kind: "barrier", height: .85,
    x: center.x + (axis === "x" ? sign * (halfX + thickness / 2) : 0),
    z: center.z + (axis === "z" ? sign * (halfZ + thickness / 2) : 0),
    heading: 0, width: axis === "x" ? thickness : 2 * (halfX + thickness),
    length: axis === "z" ? thickness : 2 * (halfZ + thickness),
  });
  const gate = wall([exit.axis, output]);
  // Only omit the gate at reset. Keep all walls in the actual static collision/scan index, not the public route map.
  const walls = sides.map(wall).filter(body => mode === "boxed" || body.id !== gate.id);
  if (walls.some(body => overlaps(body, ego, .12) ||
      world.actors.some(other => other !== player && overlaps(body, other, .12))))
    throw new Error(`The pocket wall at ${name} intersects a starting body`);
  Object.assign(player, start, { speed });
  world.statics = world.statics.concat(walls);
  const patrolStart = { ...districtRoadPose(exit, approach.fixed + 45 * output, output), speed: 4.5 };
  return Object.freeze({ id, name, mode, goal: Object.freeze(goal), roadId: exit.id, barrierId: gate.id,
    patrolStart: Object.freeze(patrolStart), wallIds: Object.freeze(walls.map(body => body.id)),
    axis: exit.axis, sign: output, exitPlane: center[exit.axis] + output * ((exit.axis === "x" ? halfX : halfZ) + thickness),
    heading: goal.heading, center: Object.freeze(center), halfX, halfZ });
}
