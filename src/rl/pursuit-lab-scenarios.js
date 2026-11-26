import { createPedestrianBody } from "../core/pedestrian-body.js";
import { initializeDistrictActor } from "../core/district-behavior.js";
import { planDistrictRoute } from "../core/district-navigation.js";
import { districtRoadPose } from "../core/egypt-district.js";
import { bodyOnRoad, overlaps } from "../core/geometry.js";
import { Random } from "../core/random.js";
import { walkSegmentClear } from "../core/walk-route.js";
import { stagePocketCourse } from "./pursuit-pocket-scenario.js";
import { stageReverseCourse } from "./pursuit-reverse-scenario.js";
import { stagePakoJunction } from "./pako-junction-course.js";
import { stageSmartEscapeScenario } from "./smart-escape-scenarios.js";

const crossingCases = Object.freeze({ L09: 1, L10: -1, L12: 1, "L12-control": 1 });
const turnCases = Object.freeze({ "tail-civic-eastbound": 1, "tail-civic-westbound": -1 });
const approachCases = Object.freeze({ L01: 1, "L01-control": 0, L03: 2, "L03-control": 2 });

function approachCourse(world, id) {
  const road = world.drivingRoads.find(road => road.id === "university-avenue");
  const ego = districtRoadPose(road, -218, 1);
  const body = { ...world.player, ...ego };
  if (!bodyOnRoad(body, [road]) || world.statics.concat(world.actors)
    .some(other => other !== world.player && overlaps(other, body, .15)))
    throw new Error("The lab approach has no physically clear SUV berth");
  const patrolStarts = [];
  if (approachCases[id] > 0)
    patrolStarts.push(Object.freeze({ ...districtRoadPose(road, -249, 1), speed: 10 }));
  if (approachCases[id] === 2) {
    const opposing = id === "L03";
    const where = districtRoadPose(road, opposing ? -181 : -261, opposing ? -1 : 1);
    patrolStarts.push(Object.freeze({ ...where, ...(opposing ? { z: ego.z } : {}), speed: 8 }));
  }
  Object.assign(world.player, ego, { speed: 6 });
  return Object.freeze({ id, roadId: road.id, patrolStarts: Object.freeze(patrolStarts) });
}

function frontRearCourse(world) {
  const avenue = world.drivingRoads.find(road => road.id === "tahrir-boulevard");
  const { player } = world, pose = { x: -245, z: avenue.fixed, heading: Math.PI / 2, speed: 5.5 };
  const barrier = { id: "metro-lab-L13-barrier", type: "static", kind: "barrier", x: -236, z: pose.z,
    heading: pose.heading, width: 2, length: .7, height: .8 };
  const probe = { ...player, ...pose };
  if (!bodyOnRoad(probe, [avenue]) || !bodyOnRoad(barrier, [avenue]) || !world.free(barrier, .1) ||
      world.statics.concat(world.actors).some(body => body !== player && overlaps(body, probe, .12)))
    throw new Error("The lab front/rear approach is not clear at reset");
  Object.assign(player, pose);
  world.statics = world.statics.concat(barrier);
  return Object.freeze({ id: "L13", roadId: avenue.id, barrierId: barrier.id,
    patrolStart: Object.freeze({ x: pose.x - 26, z: pose.z, heading: pose.heading, speed: 7 }) });
}

function turnCourse(world, id, sign) {
  const avenue = world.drivingRoads.find(road => road.id === "tahrir-boulevard");
  const cross = world.drivingRoads.find(road => road.id === "civic-avenue");
  const rng = new Random(`${world.config.seed}:${id}:turn-v1`);
  const start = sign > 0 ? -241 : -140;
  const target = { ...districtRoadPose(cross, 62, 1), roadId: cross.id, id: "civic-north-lab-goal" };
  const where = districtRoadPose(avenue, start + rng.range(-.16, .16), sign);
  const speed = sign > 0 ? rng.range(14.5, 15.1) : rng.range(13.9, 14.1);
  const patrolStart = { ...districtRoadPose(avenue, sign > 0 ? -271 : -90, sign), speed: 8 };
  const [minX, maxX] = sign > 0 ? [-277, -178] : [-191, -73];
  if (!bodyOnRoad({ ...world.player, ...where }, [avenue]) ||
      world.actors.some(actor => actor !== world.player && overlaps({ ...world.player, ...where }, actor, .15)))
    throw new Error("The lab turn approach has no physically clear berth");
  Object.assign(world.player, where, { speed });
  return Object.freeze({ id, roadId: avenue.id, goal: Object.freeze(target), patrolStart: Object.freeze(patrolStart),
    zones: [{ id: "civic-approach-lab", minX, maxX, minZ: -122, maxZ: -68 }] });
}

function narrowCourse(world, id) {
  const { player, district } = world;
  const alley = world.drivingRoads.find(road => road.id === "alley-west");
  const market = world.drivingRoads.find(road => road.id === "market-local");
  const mouth = world.roads.find(road => road.supportApron &&
    road.junctionX === alley?.fixed && road.junctionZ === alley?.max);
  if (!alley || !market || !mouth) throw new Error("Missing registered Metro alley mouth");
  const pose = { x: alley.fixed - 2.8, z: mouth.min, heading: Math.PI, speed: 0 };
  const ego = { ...player, ...pose };
  const oncoming = world.makeVehicle("metro-lab-L18-oncoming", "sedan",
    districtRoadPose(alley, -19.5, 1));
  const destination = { ...districtRoadPose(market, 35, 1), roadId: market.id };
  const closure = id === "L18-blocked" ? {
    id: "metro-lab-L18-closure", type: "static", kind: "barrier", height: .8,
    x: alley.fixed, z: -24, heading: 0, width: alley.width, length: .7,
  } : null;
  if (!bodyOnRoad(ego, world.roads) || !bodyOnRoad(oncoming, [alley]) ||
      !world.free(ego, .15) || !world.free(oncoming, .15) || overlaps(ego, oncoming, .15) ||
      (closure && (!bodyOnRoad(closure, [alley], 0) || !world.free(closure, .15) ||
        overlaps(closure, ego, .15) || overlaps(closure, oncoming, .15))))
    throw new Error("The lab narrow approach has no physically clear berth");
  oncoming.path = planDistrictRoute(district, oncoming, destination);
  if (oncoming.path.length < 3) throw new Error("No drivable civilian exit from the alley");
  initializeDistrictActor(world, oncoming);
  Object.assign(oncoming.district, { caseId: "L18", nextLoadingDistanceM: null });
  Object.assign(oncoming, { speed: 2.6, maxSpeed: 3.8 });
  Object.assign(player, pose);
  world.actors.push(oncoming);
  if (closure) world.statics = world.statics.concat(closure);
  return Object.freeze({ id, roadId: alley.id, oncomingId: oncoming.id, barrierId: closure?.id ?? null,
    patrolStart: Object.freeze({ ...districtRoadPose(market, 30, -1), speed: 3 }) });
}

export function stagePursuitLabScenario(world, id) {
  if (world.tick !== 0 || world.environment !== "metro" || world.pursuit)
    throw new RangeError("Unknown or late Metro pursuit Lab scenario");
  if (typeof id === "string" && id.startsWith("pako-junction-")) return stagePakoJunction(world, id);
  if (typeof id === "string" && id.startsWith("smart-")) return stageSmartEscapeScenario(world, id);
  if (typeof id === "string" && id.startsWith("pocket-")) return stagePocketCourse(world, id);
  if (Object.hasOwn(approachCases, id)) return approachCourse(world, id);
  if (id === "L07" || id === "L07-blocked") return stageReverseCourse(world, id);
  if (id === "L13") return frontRearCourse(world);
  if (id === "L18" || id === "L18-blocked") return narrowCourse(world, id);
  if (Object.hasOwn(turnCases, id)) return turnCourse(world, id, turnCases[id]);
  if (!Object.hasOwn(crossingCases, id)) throw new RangeError("Unknown or late Metro pursuit Lab scenario");
  const { player } = world;
  const road = world.drivingRoads.find(road => road.id === "tahrir-boulevard");
  if (!road || road.axis !== "x") throw new Error("Missing registered Lab approach");
  const layout = id === "L12-control" ? "L12" : id;
  const random = new Random(`${world.config.seed}:${layout}:crossing-v1`);
  const side = crossingCases[id], x = -207 + random.range(-.25, .25);
  const z = road.fixed + side * (road.width / 2 + .32);
  const target = { x, z: road.fixed - side * (road.width / 2 + .32) };
  const pose = { x: -245, z: road.fixed, heading: Math.PI / 2, speed: 8 };
  const setup = { ...player, ...pose };
  if (!bodyOnRoad(setup, [road]) || world.statics.some(body => overlaps(setup, body, .12)) ||
      world.actors.some(body => body !== player && overlaps(setup, body, .12)))
    throw new Error("Lab approach is not clear for the SUV");
  const person = {
    id: `metro-lab-${id}-walker`, type: "pedestrian", kind: "man-polo", x, z,
    heading: side === 1 ? Math.PI : 0, speed: 0, walkSpeed: 1.55, phase: .5,
    road, target, side, along: x, pause: .15, motionMode: "jog",
    crossing: true, distance: 0, wait: 0, reason: "waiting", motionTimeS: 0, accelerationMps2: 0,
    district: { caseId: id, routeConstrained: true, holdAtTarget: true, yieldAtCurb: false },
  };
  person.body = createPedestrianBody(person);
  person.radius = person.body.radiusM;
  person.height = person.body.heightM;
  if (!world.free(person, .12) || !walkSegmentClear(person, person, target, world.statics, .12))
    throw new Error("Lab crossing is obstructed at reset");
  Object.assign(player, pose);
  world.actors.push(person);
  return Object.freeze({ id, walkerId: person.id, roadId: road.id });
}
