import { initializeDistrictActor } from "../core/district-behavior.js";
import { planDistrictRoute } from "../core/district-navigation.js";
import { bodyOnRoad, overlaps, roadPoseAt } from "../core/geometry.js";
import { spawnCrowdAhead, DISPERSED_CROWD_LAYOUT } from "../core/pursuit-world.js";

export function stageSmartEscapeScenario(world, id) {
  const road = world.drivingRoads.find(r => r.id === "tahrir-boulevard");
  if (!road) throw new Error("Smart escape practice requires the existing City boulevard");
  const pose = { ...roadPoseAt(road, id === "smart-crossing-traffic" ? -220 : -300, 1), speed: 10 };
  const playerBody = { ...world.player, ...pose };
  if (!bodyOnRoad(playerBody, [road]) || world.statics.concat(world.actors)
    .some(a => a !== world.player && overlaps(playerBody, a, .15)))
    throw new Error("Smart escape practice has no clear player berth");
  Object.assign(world.player, pose);
  if (id === "smart-gap-crowd") {
    const result = spawnCrowdAhead(world, 20, { layout: DISPERSED_CROWD_LAYOUT });
    if (!result.ok) throw new Error("Smart escape crowd placement is blocked");
    return Object.freeze({ id, roadId: road.id, crowdIds: Object.freeze(result.ids) });
  }
  if (id === "smart-static-hazard") {
    const barrier = { id: "smart-practice-barrier", type: "static", kind: "barrier",
      x: pose.x + 33, z: pose.z, heading: pose.heading, width: 1.8, length: 1,
      height: 1.2 };
    if (!world.free(barrier, .2)) throw new Error("Smart escape static hazard placement is blocked");
    world.statics = world.statics.concat(barrier);
    return Object.freeze({ id, roadId: road.id, barrierId: barrier.id });
  }
  if (id !== "smart-crossing-traffic") throw new RangeError("Unknown smart escape scenario");
  const cross = world.drivingRoads.find(r => r.id === "civic-avenue");
  const car = world.makeVehicle("smart-practice-crossing-car", "sedan", roadPoseAt(cross, pose.z - 17, 1));
  const target = { ...roadPoseAt(cross, pose.z + 60, 1), roadId: cross.id };
  if (!world.free(car, .2)) throw new Error("Smart escape crossing traffic placement is blocked");
  initializeDistrictActor(world, car);
  car.path = planDistrictRoute(world.district, car, target);
  if (car.path.length < 2) throw new Error("Smart escape crossing traffic has no reachable route");
  Object.assign(car, { speed: 7, maxSpeed: 7, cursor: 0 });
  Object.assign(car.district, { caseId: id, holdAtTarget: true, nextLoadingDistanceM: Infinity });
  world.actors.push(car);
  return Object.freeze({ id, roadId: road.id, crossingCarId: car.id });
}
