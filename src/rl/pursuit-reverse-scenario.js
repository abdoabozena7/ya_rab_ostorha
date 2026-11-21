import { districtRoadPose } from "../core/egypt-district.js";
import { bodyOnRoad, overlaps } from "../core/geometry.js";

const EAST = Math.PI / 2;
const RESET_GAP_M = .15;

/** Place the L07 comparison on Tahrir at the existing Civic Avenue junction. */
export function stageReverseCourse(world, id) {
  if ((id !== "L07" && id !== "L07-blocked") || world.environment !== "metro" ||
      world.tick !== 0 || world.pursuit)
    throw new RangeError("Unknown or late Metro reverse Lab scenario");

  const avenue = world.drivingRoads.find(road => road.id === "tahrir-boulevard");
  const exit = world.drivingRoads.find(road => road.id === "civic-avenue");
  const station = world.drivingRoads.find(road => road.id === "station-avenue");
  if (avenue?.axis !== "x" || exit?.axis !== "z" || station?.axis !== "x")
    throw new Error("Missing registered Metro reverse junction");

  const { player } = world;
  const pose = { x: exit.fixed + 7, z: avenue.fixed + 1, heading: EAST, speed: 0 };
  const ego = { ...player, ...pose };
  const occupied = world.statics.concat(world.actors.filter(actor => actor !== player));
  if (!bodyOnRoad(ego, [avenue]) || occupied.some(body => overlaps(body, ego, RESET_GAP_M)))
    throw new Error("Metro reverse start has no clear berth for the SUV");
  occupied.push(ego);

  const barrier = (position, x) => ({
    id: `metro-lab-L07-${position}-barrier`, type: "static", kind: "barrier",
    x, z: avenue.fixed, heading: EAST, width: avenue.width, length: .7, height: .8,
  });
  const front = barrier("front", pose.x + 8);
  const rear = id === "L07-blocked" ? barrier("rear", exit.fixed + 2) : null;
  const barriers = rear ? [front, rear] : [front];
  for (const body of barriers) {
    // A full-width collider meets the road edges. The moving SUV still uses its usual margin.
    if (!bodyOnRoad(body, [avenue], 0) || occupied.some(other => overlaps(body, other, RESET_GAP_M)))
      throw new Error(`Metro reverse barrier has no clear berth: ${body.id}`);
    occupied.push(body);
  }

  // Station's westbound lane gives the patrol a visible approach without driving it
  // into the opaque Tahrir barrier. Env checks the actual spawned patrol footprint.
  const patrolStart = Object.freeze({
    ...districtRoadPose(station, pose.x + 6, -1), speed: 5,
  });
  Object.assign(player, pose);
  world.statics = world.statics.concat(barriers);
  return Object.freeze({ id, roadId: avenue.id, exitRoadId: exit.id,
    barrierId: front.id, rearBarrierId: rear?.id ?? null, patrolStart });
}
