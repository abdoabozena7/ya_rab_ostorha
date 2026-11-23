import { Random } from "../core/random.js";
import { createPedestrianBody } from "../core/pedestrian-body.js";
import { bodyOnRoad, overlaps } from "../core/geometry.js";

const courses = {
  "train-civic": ["civic-avenue", 1, "station-avenue", 1],
  "train-gateway": ["gateway-avenue", 1, "station-avenue", -1],
  "train-tahrir": ["tahrir-boulevard", 1, "gateway-avenue", 1],
  "validate-university": ["university-avenue", 1, "civic-avenue", -1],
  "validate-station": ["station-avenue", -1, "civic-avenue", -1],
};

export const PAKO_JUNCTION_TRAIN = Object.freeze(
  Object.keys(courses).filter(id => id.startsWith("train-")).map(id => `pako-junction-${id}`));
export const PAKO_JUNCTION_VALIDATE = Object.freeze(
  Object.keys(courses).filter(id => id.startsWith("validate-")).map(id => `pako-junction-${id}`));
const vector = (road, d) => road.axis === "x" ? { x: d, z: 0 } : { x: 0, z: d };
const translate = (p, vector, n) => ({ x: p.x + vector.x * n, z: p.z + vector.z * n });

export function stagePakoJunction(world, id) {
  const key = id.slice("pako-junction-".length);
  if (!Object.hasOwn(courses, key)) throw new RangeError("Unknown PAKO junction workload");
  const [entryId, entryDirection, exitId, exitDirection] = courses[key];
  const entry = world.drivingRoads.find(road => road.id === entryId);
  const exit = world.drivingRoads.find(road => road.id === exitId);
  if (!entry || !exit || entry.axis === exit.axis ||
      (entry.flow && entry.flow !== entryDirection) || (exit.flow && exit.flow !== exitDirection))
    throw new Error("The PAKO junction has no connected directed roads");
  const node = entry.axis === "x" ? { x: exit.fixed, z: entry.fixed } : { x: entry.fixed, z: exit.fixed };
  if (node[entry.axis] < entry.min || node[entry.axis] > entry.max ||
      node[exit.axis] < exit.min || node[exit.axis] > exit.max)
    throw new Error("The registered streets no longer intersect");
  const along = vector(entry, entryDirection), onward = vector(exit, exitDirection);
  const heading = Math.atan2(along.x, along.z), exitHeading = Math.atan2(onward.x, onward.z);
  const turn = along.z * onward.x - along.x * onward.z;
  const rng = new Random(`${world.config.seed}:${id}:approach-v1`);
  const lane = translate(node, onward, entry.laneOffsetM);
  const pose = { ...translate(lane, along, -7 + rng.range(-.28, .28)), heading, speed: rng.range(4.45, 4.75) };
  const patrolStart = { ...translate(pose, along, -15.5 + rng.range(-.3, .3)), heading, speed: rng.range(6.8, 7.2) };
  const destination = Object.freeze({ ...translate(translate(node, along, -exit.laneOffsetM), onward, 36),
    roadId: exit.id, id: `${id}-exit` });
  const walker = { id: `${id}-walker`, type: "pedestrian", kind: "man-polo",
    ...translate(translate(pose, along, 16.5), onward, .17), heading: 0, speed: 0,
    walkSpeed: 1.55, phase: .5, pause: 30, crossing: false, road: entry, distance: 0, wait: 0,
    reason: "waiting", motionTimeS: 0, accelerationMps2: 0, district: { caseId: id, holdAtTarget: true } };
  walker.body = createPedestrianBody(walker);
  walker.radius = walker.body.radiusM;
  walker.height = walker.body.heightM;
  walker.target = { x: walker.x, z: walker.z };
  const ego = { ...world.player, ...pose };
  if (!bodyOnRoad(ego, [entry]) || !bodyOnRoad(walker, [entry]) ||
      !world.free(walker, .12) || overlaps(ego, walker, .12) ||
      world.actors.concat(world.statics).some(other => other !== world.player && overlaps(ego, other, .12)))
    throw new Error("The staged approach or walker has no clear registered footprint");
  Object.assign(world.player, pose);
  world.actors.push(walker);
  return Object.freeze({ id, roadId: entryId, exitRoadId: exitId, walkerId: walker.id,
    patrolStart: Object.freeze(patrolStart), goal: destination, node: Object.freeze(node),
    along: Object.freeze(along), onward: Object.freeze(onward), heading, exitHeading, exitLaneM: exit.laneOffsetM, turn });
}
