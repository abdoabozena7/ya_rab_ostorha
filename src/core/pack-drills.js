import { Random } from "./random.js";
import { PLAYER_VEHICLE } from "./vehicle-spec.js";

export const PACK_DRILLS = Object.freeze([
  {
    id: "pack-dodge",
    label: "Thread the pack",
    description: "Three patrols close from the rear, side and front. Take the open arm of the junction.",
  },
  {
    id: "pack-touch",
    label: "Rear bumper touch",
    description: "The SUV starts still, with a slow patrol already close behind. See how a light bumper touch ends the run.",
  },
  {
    id: "pack-crossing",
    label: "Yield and resume",
    description: "Give the person already crossing space, then continue past the crossing.",
  },
  {
    id: "pack-person-impact",
    label: "Too close to stop",
    description: "The practice car starts rolling just before a close crosswalk conflict. Watch the real contact and its consequence.",
  },
].map(Object.freeze));

const road = (axis, fixed, min, max, width) => ({ axis, fixed, min, max, width });
const pose = (x, z, heading = 0, speed = 0) => ({ x, z, heading, speed });
const wall = (id, x, z) =>
  ({ id, type: "static", kind: "wall", x, z, heading: 0, width: .56, length: 8.2, height: 1.15 });

function patrol(id, x, z, heading, speed, behaviour, cruise) {
  return { id: `pack-patrol-${id}`, position: pose(x, z, heading, speed), behaviour, cruise };
}

function dodge(scene, rng, side, origin) {
  const start = scene.playerStart = pose(side * .48, origin - 4.1, 0, rng.range(3.75, 4.2));
  scene.drivingRoads.push(road("z", 0, origin - 36, origin + 43, 15.6),
    road("x", origin + 4.2, -40, 40, 21.2));
  scene.statics.push(wall("pack-corner-wall", -side * 10.1, origin + 21.2),
    wall("pack-entry-wall", side * 10.1, origin - 15.7));
  scene.exits.push({ id: "open-arm", x: side * 29, z: origin + 4.2 });
  scene.cars.push(
    patrol("rear", start.x + side * rng.range(.48, .82), start.z - rng.range(15, 16.4),
      0, rng.range(4.7, 5.3), "tail", 10.8),
    patrol("side", -side * rng.range(16.6, 18.1), start.z - rng.range(.55, .82),
      side * Math.PI / 2, rng.range(4.3, 5), "flank", 9.5),
    patrol("front", -side * rng.range(3.5, 4.3), start.z + rng.range(17.2, 18.8),
      Math.PI, rng.range(3.75, 4.4), "intercept", 8.9),
  );
}

function touch(scene, rng, side, origin) {
  const x = side * .53;
  scene.drivingRoads.push(road("z", 0, origin - 27, origin + 38, 7.6));
  scene.playerStart = pose(x, origin);
  scene.exits.push({ id: "ahead", x, z: origin + 26 });
  // The bumpers start apart, but a held SUV cannot match the patrol's pace
  // before the gap closes. A rolling SUV can still separate.
  const gap = rng.range(.31, .37);
  scene.cars.push(patrol("rear", x + side * rng.range(.04, .13),
    origin - PLAYER_VEHICLE.lengthM - gap, 0, rng.range(1.35, 1.54), "tail", rng.range(1.62, 1.78)));
}

function crossing(scene, rng, side, origin, close) {
  const width = 6.4, x = side * .32;
  const speed = close ? rng.range(5.2, 5.55) : rng.range(3.75, 4.1);
  const across = close ? rng.range(.82, 1.0) : rng.range(1.76, 1.89);
  const gap = close ? rng.range(.77, .92) : rng.range(6.0, 6.3);
  const along = origin + PLAYER_VEHICLE.lengthM / 2 + gap;
  scene.drivingRoads.push(road("z", 0, origin - 23, origin + 39, width));
  scene.playerStart = pose(x, origin, 0, speed);
  scene.exits.push({ id: "beyond-crossing", x, z: origin + 25 });
  // Start inside the carriageway, so the walker is already committed and
  // uses ordinary body acceleration and occupancy checks, not a timed script.
  scene.people.push({
    id: "pack-crossing-walker", road: 0, along, side, pause: 0, started: true,
    pose: { x: x - side * across, z: along, heading: side * Math.PI / 2 },
    walkSpeed: rng.range(1.65, 1.83),
    target: { x: side * (width / 2 + .98), z: along },
  });
}

export function createPackDrill(caseId, seed) {
  const rng = new Random(`${seed}:pack-drill-v1:${caseId}`);
  const side = rng.next() < .5 ? -1 : 1;
  const origin = rng.range(-.45, .45);
  const scene = { drivingRoads: [], shoulders: [], statics: [], playerStart: null,
    exits: [], cars: [], people: [], closure: null };
  switch (caseId) {
    case "pack-dodge":
      dodge(scene, rng, side, origin);
      break;
    case "pack-touch":
      touch(scene, rng, side, origin);
      break;
    case "pack-crossing":
    case "pack-person-impact":
      crossing(scene, rng, side, origin, caseId === "pack-person-impact");
      break;
    default:
      throw new RangeError(`Unknown pack drill: ${caseId}`);
  }
  return scene;
}
