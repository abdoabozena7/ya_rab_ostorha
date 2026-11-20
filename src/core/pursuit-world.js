import { PEOPLE_MODELS, STEP, VEHICLE, clamp } from "./config.js";
import { arcadePatrolLimit, initializeDistrictActor, isPackPursuit, isRushPack, rushRoadLimit, usesRushPace } from "./district-behavior.js";
import { planDistrictRoute } from "./district-navigation.js";
import { createPackDrill, PACK_DRILLS } from "./pack-drills.js";
import { packApproach, packRamAim, packSpawnBias, packTactic } from "./pack-patrol.js";
import { packCommand, PACK_PENALTIES, pedestrianImpactCost } from "./pack-driving.js";
import { districtRoadPose } from "./egypt-district.js";
import {
  angleDelta, bodyOnRoad, corners, distance, interpolate, overlaps,
  pointOnRoad, roadRect, sweepSafe,
} from "./geometry.js";
import { createRoadGraph, lanePath, planNavigation, LANE_OFFSET } from "./navigation.js";
import { createPedestrianBody } from "./pedestrian-body.js";
import { pedestrianMotion } from "./pedestrian.js";
import { pursuitCommand, validatePursuitAction } from "./pursuit-controls.js";
import { createPursuitResponse, pursuitResponseSnapshot, updatePursuitResponse } from "./pursuit-response.js";
import {
  SURVIVAL_REVIEW_TICKS, createSurvival, emitSurvival, isCityHunt, isSurvival, releaseSurvival,
  survivalGhostPair, survivalSnapshot, updateSurvivalBeforeMotion, updateSurvivalAfterMotion,
} from "./pursuit-survival.js";
import { Random } from "./random.js";
import { SpatialIndex } from "./spatial-index.js";
import { followPath, integrateVehicle, vehicleProbe } from "./vehicle.js";
import { PLAYER_VEHICLE } from "./vehicle-spec.js";
import { advanceVehicleState } from "./vehicle-state.js";

const TIERS = [
  { police: 1, traffic: 3, pedestrians: 1, durationS: 38 },
  { police: 4, traffic: 5, pedestrians: 2, durationS: 41 },
  { police: 5, traffic: 7, pedestrians: 3, durationS: 44 },
  { police: 6, traffic: 9, pedestrians: 4, durationS: 47 },
];
const CASE_IDS = new Set([
  "ambient", "short-route-open", "short-route-closes-or-becomes-risky",
  "rear-close-forward-clear", "rear-close-front-blocked-side-clear",
  "reverse-then-side", "incoming-left-or-right", "front-obstruction-with-rear-traffic",
  "pedestrian-priority-no-safe-exit", "legal-gap-and-rejected-cut",
  "curb-bypass-and-return", "boxed-in-multi-threat", "occluded-stale-and-recovery",
]);
const CAR_KINDS = ["sedan", "taxi", "suv", "van", "tuktuk"];
const MAX_EVENTS = 48;
const STREET_DEPLOY_RANGE_M = 52;
const RUSH_TACTICS = ["tail", "flank", "intercept", "tail", "flank", "intercept", "tail", "flank", "tail", "intercept"];
const RUSH_WAVES = [[4, 6], [5, 7], [6, 9], [7, 10]];
const ARCADE_WAVES = [[5, 14], [7, 18], [9, 22], [11, 26]];
const headingTo = (a, b) => Math.atan2(b.x - a.x, b.z - a.z);
const ticks = (seconds) => Math.round(seconds / STEP);
const ARCADE_BACKUP_TICKS = ticks(3);
const PACK_REVIEW_TICKS = ticks(1.65);
const road = (axis, fixed, min, max, width) => ({ axis, fixed, min, max, width });
const pose = (x, z, heading = 0, speed = 0) => ({ x, z, heading, speed });
const exit = (id, x, z) => ({ id, x, z });
const barrier = (id, x, z, width, length = 0.8, heading = 0, height = 0.95) =>
  ({ id, type: "static", kind: "barrier", x, z, heading, width, length, height });
const vehicle = (id, position, behaviour, cruise) => ({ id, position, behaviour, cruise });

function grid() {
  return [
    road("z", 0, -56, 60, 12),
    road("z", -22, -32, 42, 10), road("z", 22, -32, 42, 10),
    ...[-32, -8, 22, 42].map((z) => road("x", z, -22, 22, z === -8 ? 12 : 10)),
  ];
}

function streetSolids(rng) {
  const sites = [];
  for (const side of [-1, 1]) {
    const name = side < 0 ? "west" : "east";
    const place = (id, kind, x, z, width, length, height, heading = 0) =>
      sites.push({ id: `pursuit-${name}-${id}`, type: "static", kind, x: side * x, z, width, length, height, heading });
    // Leave the entire carriageway and its sidewalk clear, including the
    // expanded ends of the transverse road rectangles.
    for (const [id, z, depth, minHeight, maxHeight] of [
      ["entry", -43.5, 8.6, 3.6, 5.2], ["south", -20.6, 7.8, 4.5, 7.2],
      ["centre", 7.3, 10.1, 5.2, 8.4], ["north", 32, 5.4, 3.2, 5.8],
    ]) {
      place(`building-${id}`, "building", 11.85 + rng.range(-0.2, 0.3),
        z + rng.range(-0.4, 0.4), rng.range(5.7, 6.5), depth,
        rng.range(minHeight, maxHeight));
    }
    place("building-edge", "building", 34.8, side < 0 ? -9.0 : 19.5,
      rng.range(7.7, 8.5), 10.5, rng.range(4.5, 7.0));
    place("entry-wall", "wall", 7.9, -42, 0.48, 4.8, 1.1);
    place("edge-wall", "wall", 30.1, side < 0 ? 8.8 : -8.8, 0.52, 8.0, 1.25);
    place("entry-parked", "parked-vehicle", 8.45, -51.8, 1.78, 4.18, 1.43,
      side < 0 ? 0 : Math.PI);
    sites.at(-1).vehicleKind = side < 0 ? "taxi" : "sedan";
    place("edge-parked", "parked-vehicle", 29.5, -22.4, 1.88, 4.48, 1.85, Math.PI);
    sites.at(-1).vehicleKind = "van";
  }
  return sites;
}

function layout(caseId, rng) {
  const sign = rng.next() < 0.5 ? -1 : 1;
  const drivingRoads = grid();
  const statics = [];
  const shoulders = [];
  const cars = [], people = [];
  const scene = {
    drivingRoads, shoulders, statics, cars, people,
    playerStart: pose(-LANE_OFFSET, -39),
    exits: [exit("north", -LANE_OFFSET, 54)],
    closure: null,
  };
  const setPlayer = (x, z, speed = 0) => { scene.playerStart = pose(x, z, 0, speed); };
  const tail = (x, z, speed) =>
    cars.push(vehicle("police-tail-1", pose(x, z, 0, speed), "tail", 9.5));
  const cross = (x, z, speed, tactic = "flank", cruise = 8.6) =>
    cars.push(vehicle(`police-${tactic}-1`, pose(x, z, -Math.sign(x) * Math.PI / 2, speed), tactic, cruise));
  const stop = (id, x, z) => cars.push(vehicle(id, pose(x, z), "parked", 0));
  switch (caseId) {
    case "ambient":
      scene.playerStart.z += rng.range(-1.3, 1.3);
      scene.exits.push(exit("west", -22 - LANE_OFFSET, 36), exit("east", 22 - LANE_OFFSET, 36));
      break;
    case "short-route-open":
    case "short-route-closes-or-becomes-risky":
      setPlayer(-LANE_OFFSET, -36);
      cars.push(vehicle("civilian-bypass", pose(sign * 22 - LANE_OFFSET, -18, 0, 3.2), "lane", 4.5));
      if (caseId === "short-route-closes-or-becomes-risky") {
        scene.closure = {
          at: ticks(rng.range(2.1, 2.8)),
          body: barrier("pursuit-short-closure", 0, 8 + rng.range(-0.4, 0.4), 12.1),
        };
      }
      break;
    case "rear-close-forward-clear":
      setPlayer(sign * LANE_OFFSET, -27, 3.4);
      tail(sign * LANE_OFFSET, -35.6, 6.4);
      break;
    case "rear-close-front-blocked-side-clear":
      setPlayer(sign * 1.65, -18.5, 1.4);
      tail(sign * 1.65, -32, 6.1);
      stop("civilian-front", sign * 1.65, -9.2);
      statics.push(barrier("pursuit-side-block", sign * 4.5, -12.7, 2.7, 5.5));
      break;
    case "reverse-then-side":
      scene.drivingRoads = [
        road("z", 0, -20, 12, 5.4),
        road("x", -9, -33, 33, 9.4),
        road("z", sign * 33, -9, 14, 8),
      ];
      setPlayer(0, -0.5);
      statics.push(barrier("pursuit-bay-end", 0, 2.45, 5.6));
      cross(-sign * 31, -9, 2.0, "flank", 4.3);
      scene.exits = [exit("side", sign * 30, -9)];
      break;
    case "incoming-left-or-right":
      setPlayer(0, -8.5, 1.0);
      cross(sign * 15, -8.5, 6.4);
      break;
    case "front-obstruction-with-rear-traffic":
      setPlayer(sign * 1.65, -18.5, 3);
      cars.push(
        vehicle("civilian-oncoming", pose(sign * 1.65, -1.6, Math.PI, 5.3), "lane", 6),
        vehicle("civilian-behind", pose(sign * 1.65, -28.3, 0, 5.5), "lane", 6.8),
      );
      break;
    case "pedestrian-priority-no-safe-exit":
      scene.drivingRoads = [road("z", 0, -24, 24, 4.6)];
      setPlayer(0, -4.5);
      tail(0, -13.6, 5.4);
      people.push({ id: "walker-crossing", road: 0, along: -0.35, side: sign, pause: 0, started: true });
      scene.exits = [exit("ahead", 0, 18)];
      break;
    case "legal-gap-and-rejected-cut":
      setPlayer(sign * 1.65, -29, 4.3);
      cars.push(
        vehicle("civilian-lead", pose(sign * 1.65, -19.3, 0, 2.1), "lane", 3.5),
        vehicle("civilian-gap-ahead", pose(-sign * 1.65, -11.2, 0, 5.5), "lane", 5.5),
        vehicle("civilian-gap-behind", pose(-sign * 1.65, -34.2, 0, 4.8), "lane", 6.5),
      );
      break;
    case "curb-bypass-and-return":
      scene.drivingRoads = [road("z", 0, -29, 34, 7.5)];
      shoulders.push({
        ...road("z", sign * 5, -23.5, 15.5, 3.45),
        pursuitShoulder: true, supportHeightM: 0.14,
      });
      setPlayer(sign * 1.3, -23);
      statics.push(barrier("pursuit-curb-closure", 0, 0, 7.15));
      scene.exits = [exit("re-entry", 0, 25)];
      break;
    case "boxed-in-multi-threat":
      setPlayer(0, -8.5, 0.8);
      tail(0, -21.5, 6.4);
      cross(sign * 17.5, -8, 6.1);
      cross(-sign * 19, -10.4, 5.8, "intercept");
      stop("civilian-box-front", 0, -0.8);
      people.push({ id: "walker-crossing", road: 0, along: 1.9, side: sign, pause: 0.3 });
      break;
    case "occluded-stale-and-recovery":
      setPlayer(0, -14.3, 1.4);
      statics.push(barrier("pursuit-opaque-screen", sign * 5.7, -12.9, 3.4, 1.7, 0, 2.3));
      cross(sign * 16, -10, 4.6);
      break;
  }
  return scene;
}

function validateLevel(level) {
  if (!Number.isInteger(level) || level < 1 || level > TIERS.length)
    throw new RangeError("Pursuit level must be an integer from 1 to 4");
}

function pursuitMetrics() {
  return {
    survivalS: 0, distanceM: 0, collisions: 0, pedestrianCollisions: 0,
    nearCollisions: 0, escape: false, impact: null, trafficCollisions: 0,
    guard: "clear", requestedAction: null, supportHeightM: 0,
    maxSupportHeightM: 0, shoulderEntries: 0, shoulderExits: 0, capturePressureS: 0,
  };
}

function initializePack(state, phase = "ready") {
  state.variant = "pack";
  state.response = createPursuitResponse();
  state.patrols ??= new Set();
  state.wantedLevel = state.level;
  state.driver = "planner";
  state.phase = phase;
  Object.assign(state.metrics, {
    policeContacts: 0, penalty: 0, terminalCause: null,
    pedestrianStatus: null, firstYieldTick: null, firstClearTick: null,
    surroundSectors: 0,
  });
  return state;
}

export function createPursuitState(options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options))
    throw new TypeError("Pursuit options must be an object");
  const pack = isPackPursuit(options.pursuitVariant);
  const { pursuitLevel: level = 1, pursuitCase: caseId = pack ? "pack-dodge" : "ambient" } = options;
  validateLevel(level);
  if (pack ? !PACK_DRILLS.some(drill => drill.id === caseId) : !CASE_IDS.has(caseId))
    throw new RangeError("Unknown pursuit case");
  const seed = String(options.seed ?? "cairo-42").slice(0, 64);
  const rng = new Random(`${seed}:pursuit-world-v1`);
  const scene = pack ? createPackDrill(caseId, seed) : layout(caseId, rng);
  if (caseId === "ambient") {
    // Keep architectural variation separate from traffic and event draws.
    scene.statics.push(...streetSolids(new Random(`${seed}:pursuit-streets-v1`)));
  }
  const state = {
    level, caseId, phase: "ready",
    drivingRoads: scene.drivingRoads, roads: [...scene.drivingRoads, ...scene.shoulders],
    statics: scene.statics, playerStart: scene.playerStart, exits: scene.exits,
    events: [], action: null, decision: null, startedTick: null,
    metrics: pursuitMetrics(),
    rng, scene, graph: createRoadGraph(scene.drivingRoads),
    support: scene.shoulders.map((r) => ({ ...roadRect(r), height: r.supportHeightM })),
    nextEventTick: ticks(rng.range(2.4, 4.2)), eventKinds: [], eventSerial: 0,
    closures: new Map(), contacts: new Set(), near: new Set(), navGraph: null,
    junctions: scene.drivingRoads.filter((r) => r.axis === "x").flatMap((a) =>
      scene.drivingRoads.filter((r) => r.axis === "z" &&
        r.fixed >= a.min && r.fixed <= a.max && a.fixed >= r.min && a.fixed <= r.max)
        .map((r) => ({ x: r.fixed, z: a.fixed }))),
  };
  if (!pack) return state;
  state.packLab = true;
  state.targetPatrols = scene.cars.filter(car => RUSH_TACTICS.includes(car.behaviour)).length;
  initializePack(state);
  if (options.pursuitVariant === "hunt") {
    state.variant = "hunt";
    Object.assign(state.metrics, { pedestrianCost: 0, pedestrianDanger: 0 });
  }
  if (!state.targetPatrols) state.wantedLevel = 0;
  return state;
}

function shuffled(rng, values) {
  const result = values.slice();
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(rng.next() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function isFree(world, shape, gap = 0.24) {
  return !world.actors.some((a) => overlaps(a, shape, gap)) &&
    !world.statics.some((a) => overlaps(a, shape, gap));
}

function setPursuitDrive(a, data, kind) {
  const police = ["tail", "flank", "intercept"].includes(data.behaviour);
  a.pursuitRole = police ? "police" : "civilian";
  if (police) a.policeTactic = data.behaviour;
  a.speed = Math.min(data.position.speed, a.maxSpeed);
  a.y = a.supportHeightM = 0;
  a.height ??= kind === "van" ? 2.05 : 1.5;
  a.pursuitDrive = {
    pattern: data.behaviour, cruise: Math.min(a.maxSpeed, data.cruise),
    paceMps: Infinity, paceUntil: 0, nextPlan: 0, target: null,
    laneBiasM: 0, laneUntil: 0, laneProbeAt: 0,
  };
}

function addVehicle(world, data, kind = "sedan") {
  const a = world.makeVehicle(data.id, kind, data.position);
  if (!bodyOnRoad(a, world.drivingRoads) || !isFree(world, a)) return null;
  setPursuitDrive(a, data, kind);
  if (data.path) a.path = data.path;
  if (data.behaviour === "lane" && !data.path) {
    const p = a.pursuitDrive.target = { x: a.x, z: a.z };
    for (let n = 1; n <= 100; n++) {
      const next = {
        ...a, x: a.x + n * Math.sin(a.heading), z: a.z + n * Math.cos(a.heading),
      };
      if (!bodyOnRoad(next, world.drivingRoads)) break;
      p.x = next.x;
      p.z = next.z;
    }
  }
  a.previous = copyPose(a);
  world.actors.push(a);
  return a;
}

function sidewalkPose(r, along, side) {
  const lateral = side * (r.width / 2 + 0.9);
  return r.axis === "z" ? { x: r.fixed - lateral, z: along } : { x: along, z: r.fixed + lateral };
}

function addPerson(world, data) {
  const { rng } = world.pursuit;
  const r = world.drivingRoads[data.road];
  const start = sidewalkPose(r, data.along, data.side);
  if (data.started) {
    // At the approach to the lane, not occupying the ego's initial shape.
    if (r.axis === "z") start.x = r.fixed - data.side * (r.width / 2 - 0.4);
    else start.z = r.fixed + data.side * (r.width / 2 - 0.4);
  }
  const target = sidewalkPose(r, data.along, -data.side);
  const p = {
    id: data.id, type: "pedestrian", kind: rng.pick(PEOPLE_MODELS),
    ...start, heading: headingTo(start, target), target, road: r, side: data.side,
    speed: 0, walkSpeed: rng.range(1.05, 2.0), phase: rng.next(),
    crossing: true, along: data.along, pause: data.pause, distance: 0, wait: 0,
    reason: "ready", motionMode: "ambient", motionTimeS: 0, accelerationMps2: 0,
  };
  if (world.pursuit.packLab) {
    if (data.pose) Object.assign(p, data.pose);
    if (data.target) p.target = { ...data.target };
    if (Number.isFinite(data.walkSpeed)) p.walkSpeed = data.walkSpeed;
  }
  p.body = createPedestrianBody(p);
  p.radius = p.body.radiusM;
  p.height = p.body.heightM;
  if (!isFree(world, p)) return false;
  p.previous = copyPose(p);
  world.actors.push(p);
  return true;
}

function spawnPolice(world, count) {
  const { rng, level } = world.pursuit;
  const side = rng.next() < 0.5 ? -1 : 1;
  const start = world.player;
  const spread = level - 1;
  const innerFlankZ = level > 2 ? -8 : -32;
  const outerFlankZ = level > 2 ? 22 : -8;
  const positions = [
    ["tail", start.x + rng.range(-0.55, 0.55), start.z - rng.range(10.5 + spread * 1.95, 15.5 + spread * 0.88), 0],
    ["flank", side * rng.range(12 + spread * 1.8, 22), innerFlankZ + side * 0.9, -side * Math.PI / 2],
    ["intercept", rng.range(0.35, 2.5), rng.range(13 + spread * 2.6, 23 + spread * 3.4), Math.PI],
    ["flank", -side * rng.range(14 + spread * 1.2, 22), outerFlankZ - side * 1.3, side * Math.PI / 2],
    ["tail", -side * 22 + LANE_OFFSET, rng.range(-17, -6), Math.PI],
    ["intercept", side * 22 + LANE_OFFSET, rng.range(17, 30), Math.PI],
  ];
  const counts = { tail: 0, flank: 0, intercept: 0 };
  for (const [tactic, x, z, heading] of positions.slice(0, count)) {
    const id = `police-${tactic}-${++counts[tactic]}`;
    const cruise = 6.9 + level * 0.6 + rng.range(-0.3, 0.5);
    let car = null;
    for (const offset of [0, -2.6, 2.6, -5.2, 5.2]) {
      const p = pose(x + Math.sin(heading) * offset, z + Math.cos(heading) * offset,
        heading, rng.range(2.7, 4.2) + level * 0.35);
      car = addVehicle(world, vehicle(id, p, tactic, cruise));
      if (car) break;
    }
    if (!car) throw new Error(`No clean pursuit spawn for ${id}`);
  }
}

const square = (a, b, low, high) =>
  [{ x: a, z: low }, { x: a, z: high }, { x: b, z: high }, { x: b, z: low }];

function spawnCivilians(world, count) {
  const { rng } = world.pursuit;
  const rings = [square(0, 22, -32, 42), square(0, -22, -32, 42), square(-22, 22, -32, 42),
    square(0, 22, -8, 22), square(0, -22, -8, 22), square(-22, 22, -8, 42)];
  const slots = rings.flatMap((ring) => [ring, ring.slice().reverse()].flatMap((ordered) =>
    ordered.map((_, i) => [...ordered.slice(i), ...ordered.slice(0, i)])));
  const orderedSlots = shuffled(rng, slots);
  for (let i = 0; i < count; i++) {
    const kind = rng.pick(CAR_KINDS);
    const cruise = i === 0 ? rng.range(3.2, 4.6) : rng.range(4.3, 8.5);
    let car = null;
    for (const ring of i === 0 ? [rings[0], ...orderedSlots] : orderedSlots) {
      const [a, b] = ring;
      const heading = headingTo(a, b);
      const t = i === 0 && ring === rings[0] ? rng.range(0.15, 0.25) : rng.range(0.24, 0.74);
      const start = {
        x: a.x + (b.x - a.x) * t,
        z: a.z + (b.z - a.z) * t,
      };
      const offset = LANE_OFFSET + rng.range(-0.22, 0.22);
      const p = pose(start.x - offset * Math.cos(heading), start.z + offset * Math.sin(heading),
        heading, cruise * rng.range(0.55, 0.86));
      if (distance(p, world.player) < 11) continue;
      const loop = [...ring.slice(1), ring[0]];
      const path = lanePath([start, ...loop, ...loop, ...loop, ...loop], offset);
      car = addVehicle(world, { ...vehicle(`civilian-${i + 1}`, p, "lane", cruise), path }, kind);
      if (car) break;
    }
    if (!car) throw new Error(`No clean pursuit spawn for civilian-${i + 1}`);
  }
}

function spawnPeople(world, count) {
  const { rng } = world.pursuit;
  for (let i = 0; i < count; i++) {
    let placed = false;
    for (let attempt = 0; attempt < 36 && !placed; attempt++) {
      const roadIndex = i === 0 ? 0 : Math.floor(rng.next() * world.drivingRoads.length);
      const r = world.drivingRoads[roadIndex];
      placed = addPerson(world, {
        id: `walker-${i + 1}`, road: roadIndex, side: rng.next() < 0.5 ? -1 : 1,
        along: i === 0 ? rng.range(-22, -15) : rng.range(r.min + 5, r.max - 5),
        pause: rng.range(0.1, 1.25), started: i === 0,
      });
    }
    if (!placed) throw new Error(`No clean pursuit spawn for walker-${i + 1}`);
  }
}

export function populatePursuit(world) {
  const state = world.pursuit;
  const { player } = world;
  if (!bodyOnRoad(player, state.roads) ||
      state.statics.some((body) => overlaps(player, body, 0.24)))
    throw new Error("Pursuit player start is not clear and supported");
  player.speed = Math.min(player.maxSpeed, state.playerStart.speed);
  player.y = player.supportHeightM = heightOnSupport(state, player);
  player.previous = copyPose(player);
  if (state.caseId === "ambient") {
    const tier = TIERS[state.level - 1];
    spawnPolice(world, tier.police);
    spawnCivilians(world, tier.traffic);
    spawnPeople(world, tier.pedestrians);
  } else {
    for (const data of state.scene.cars)
      if (!addVehicle(world, data)) throw new Error(`No clean pursuit spawn for ${data.id}`);
    for (const data of state.scene.people)
      if (!addPerson(world, data)) throw new Error(`No clean pursuit spawn for ${data.id}`);
  }
  world.capacity = {
    traffic: world.actors.filter((a) => a.type === "vehicle" && a !== player).length,
    pedestrians: world.actors.filter((a) => a.type === "pedestrian").length,
  };
  world.actorIndex = new SpatialIndex(world.actors);
  world.staticIndex = new SpatialIndex(world.statics);
  world.mode = "auto";
  if (state.packLab) {
    for (const actor of world.actors) {
      if (actor.pursuitRole !== "police") continue;
      actor.pursuitDrive.packOrder = state.patrols.size;
      state.patrols.add(actor);
    }
    state.lanes = streetLanes(world.drivingRoads, player);
    state.patrolMap = { roads: world.roads, drivingRoads: world.drivingRoads, statics: world.statics };
  }
}

function lanePoint(lane, along) {
  return { ...districtRoadPose(lane.road, clamp(along, lane.low, lane.high), lane.sign),
    roadId: lane.road.id };
}

function streetLanes(roads, car) {
  const pad = car.length / 2 + 0.3;
  return roads.filter((r) => !r.parkingBay && !r.supportApron && r.max - r.min > pad * 2 &&
      r.width / 2 >= Math.abs(r.laneOffsetM ?? 0) + car.width / 2 + 0.12)
    .flatMap((road) => (road.flow ? [road.flow] : [1, -1]).map((sign) => ({
      road, sign, low: road.min + pad, high: road.max - pad,
    })));
}

function packDeploymentLanes(lanes, car) {
  return lanes.concat(lanes.flatMap(lane => {
    const offset = lane.road.width / 2 - car.width / 2 - .55;
    return !lane.road.flow && offset > (lane.road.laneOffsetM ?? 0) + 1.45
      ? [{ ...lane, road: { ...lane.road, laneOffsetM: offset }, outside: true }] : [];
  }));
}

function deploymentSlots(state, ego, tactic, minRange = 13) {
  const sin = Math.sin(ego.heading), cos = Math.cos(ego.heading);
  const slots = [];
  for (const lane of state.lanes) {
    const along = ego[lane.road.axis];
    const low = Math.max(lane.low, along - STREET_DEPLOY_RANGE_M);
    const high = Math.min(lane.high, along + STREET_DEPLOY_RANGE_M);
    for (let at = low; at <= high; at += 3.5) {
      const position = lanePoint(lane, at);
      const range = distance(ego, position);
      if (range < minRange || range > STREET_DEPLOY_RANGE_M) continue;
      const front = (position.x - ego.x) * sin + (position.z - ego.z) * cos;
      const alignment = Math.cos(angleDelta(position.heading, ego.heading));
      const approach = tactic === "tail" ? Math.max(0, front) + 7 * (1 - alignment)
        : tactic === "intercept" ? Math.max(0, -front) + 4 * (1 + alignment)
        : 7 * Math.abs(alignment);
      slots.push({ lane, position, score: Math.abs(range - 18) + approach });
    }
  }
  return slots.sort((a, b) => a.score - b.score);
}

function setStreetPatrolPath(state, car, aim, fallback = null) {
  const goals = state.lanes.map((lane) => lanePoint(lane, aim[lane.road.axis]));
  goals.sort((a, b) => distance(a, aim) - distance(b, aim));
  const nearbyGoals = goals.slice(0, fallback ? 3 : 4);
  if (fallback) nearbyGoals.push(fallback);
  for (const goal of nearbyGoals) {
    const path = planDistrictRoute(state.patrolMap, car, goal);
    if (path.length < 3) continue;
    const length = path.reduce((total, point, i) => i ? total + distance(path[i - 1], point) : 0, 0);
    if (length > Math.max(30, distance(car, goal) * 2.5 + 15)) continue;
    for (const point of path) Object.freeze(point);
    car.path = Object.freeze(path);
    car.cursor = 0;
    car.pursuitDrive.target = goal;
    return true;
  }
  return false;
}

function patrolReach(lane, car) {
  return (lane.sign > 0 ? lane.high - car[lane.road.axis] : car[lane.road.axis] - lane.low);
}

function huntSector(point, report) {
  return Math.round(angleDelta(headingTo(report, point), report.heading) / (Math.PI / 2)) & 3;
}

function huntApproachPoints(world, state, car, report) {
  const occupied = [0, 0, 0, 0], taken = [];
  for (const unit of state.patrols) {
    if (unit === car) continue;
    if (distance(unit, report) < 19) occupied[huntSector(unit, report)] += 1;
    const goal = unit.pursuitDrive.approach;
    if (goal && distance(goal, report) < 31) {
      occupied[huntSector(goal, report)] += .6;
      taken.push(goal);
    }
  }
  const lead = clamp(report.speed * .65, -5, 8);
  const ahead = { x: report.x + Math.sin(report.heading) * lead, z: report.z + Math.cos(report.heading) * lead };
  const groups = [[], [], [], []];
  for (const lane of state.lanes) {
    for (const inset of [8, 15, 23]) {
      const pose = lanePoint(lane, ahead[lane.road.axis] - lane.sign * inset);
      const gap = distance(pose, report);
      if (gap < 6 || gap > 32 || distance(car, pose) < 5 ||
          Math.abs(angleDelta(headingTo(pose, ahead), pose.heading)) > 1.15) continue;
      const side = huntSector(pose, report);
      const crowd = Math.min(3, occupied[side]) * 15 + taken.filter(goal => distance(goal, pose) < 7).length * 9;
      const score = Math.abs(gap - 13) + distance(car, pose) * .45 + crowd;
      const options = groups[side];
      if (!options.some(option => distance(option.pose, pose) < 1))
        options.push({ pose, score });
    }
  }
  for (const options of groups) options.sort((a, b) => a.score - b.score);
  const traffic = world.actorIndex.near(car, 65).filter(actor => actor !== world.player && actor !== car);
  return { goals: groups.flatMap(options => options.slice(0, 2)).sort((a, b) => a.score - b.score), traffic };
}

function planRushPatrol(world, state, car, lane = null, player = world.player, search = false) {
  const { pattern } = car.pursuitDrive;
  const lead = search ? 0 : isRushPack(state.variant)
    ? (pattern === "tail" ? 9 : pattern === "flank" ? 5 : 13) + clamp(player.speed * .7, -2, 10)
    : (pattern === "tail" ? 15 : pattern === "flank" ? 10 : 24) + clamp(player.speed * 1.3, -3, 18);
  const pack = isPackPursuit(state.variant);
  const aim = pack && !search ? packApproach({
    car, report: player, order: car.pursuitDrive.packOrder, street: state.street === true,
    tick: world.tick, startedTick: state.startedTick ?? world.tick, clear: state.response.sightedBy.has(car),
  }) : { x: player.x + Math.sin(player.heading) * lead, z: player.z + Math.cos(player.heading) * lead };
  state.patrolMap.statics = world.statics;
  let goals = state.lanes.map((candidate) => {
    const pose = lanePoint(candidate, aim[candidate.road.axis]);
    const alignment = Math.cos(angleDelta(pose.heading, pack ? headingTo(pose, player) : player.heading));
    const score = distance(pose, aim) + (1 - alignment) * (pack ? 4 : 7)
      + (patrolReach(candidate, pose) < 3 ? 5 : 0);
    return { pose, score, candidate };
  }).sort((a, b) => a.score - b.score).slice(0, search ? 2 : 4);
  const hunt = isCityHunt(state.variant) && !search && !lane && state.response.lastSeen;
  const approaches = hunt && huntApproachPoints(world, state, car, player);
  if (approaches) goals = approaches.goals.slice(0, 4).concat(goals.slice(0, 2));
  if (search) {
    // If the report's exact street point cannot be reached, check an
    // approach and a continuation on that same street, not the live SUV.
    const nearest = goals[0];
    if (nearest) for (const offset of [-14, 14]) {
      const { pose, candidate } = nearest;
      const alternative = lanePoint(candidate, pose[candidate.road.axis] + candidate.sign * offset);
      if (distance(alternative, pose) >= 6 && distance(alternative, player) <= 23)
        goals.push({ pose: alternative });
    }
  }
  if (lane && patrolReach(lane, car) >= 8)
    goals.push({ pose: lanePoint(lane, car[lane.road.axis] + lane.sign * 21) });
  for (const { pose } of goals) {
    if (distance(car, pose) < 7) continue;
    const path = planDistrictRoute(state.patrolMap, car, pose, approaches?.traffic);
    if (path.length < 3) continue;
    let length = 0;
    for (let i = 1; i < path.length; i++) length += distance(path[i - 1], path[i]);
    if (length > Math.max(32, distance(car, pose) * (hunt ? 2.7 : 2.2) + (hunt ? 28 : 13))) continue;
    for (const point of path) Object.freeze(point);
    car.path = Object.freeze(path);
    car.cursor = 0;
    car.pursuitDrive.target = pose;
    if (isCityHunt(state.variant)) {
      const before = car.pursuitDrive.approach;
      car.pursuitDrive.approach = hunt ? pose : null;
      if (hunt && before && distance(before, pose) > 5 &&
          (before.roadId !== pose.roadId || huntSector(before, player) !== huntSector(pose, player)))
        state.metrics.patrolReassignments = (state.metrics.patrolReassignments ?? 0) + 1;
    }
    return true;
  }
  return false;
}

function rushDispatch(world, state, count, player = world.player) {
  const arcade = isRushPack(state.variant);
  const pack = isPackPursuit(state.variant);
  const opening = arcade && world.pursuit !== state;
  const survival = state.survival;
  const sin = Math.sin(player.heading), cos = Math.cos(player.heading);
  const close = world.actors.filter(other => distance(player, other) < STREET_DEPLOY_RANGE_M + 17);
  const dispatched = [];
  for (let i = 0; i < count; i++) {
    const order = survival ? survival.spawnCount : state.patrols.size;
    const time = (world.tick - state.startedTick) * STEP;
    const heavy = survival && time >= 13 && (!survival.heavyCount || order % 5 === 4);
    const kind = heavy ? "van" : "sedan";
    const pattern = heavy ? "intercept" : pack ? packTactic(order) : RUSH_TACTICS[order % RUSH_TACTICS.length];
    const id = `street-pursuit-${state.run}-patrol-${order + 1}`;
    const car = world.makeVehicle(id, kind, { x: player.x, z: player.z, heading: player.heading });
    if (!state.lanes.length) state.lanes = streetLanes(world.drivingRoads, car);
    if (heavy) Object.assign(car, { width: 2.26, length: 5.55, height: 2.62 });
    const fronts = pack ? [...state.patrols].map(car => ({
      forward: (car.x - player.x) * sin + (car.z - player.z) * cos,
      lateral: (car.x - player.x) * cos - (car.z - player.z) * sin,
    })) : null;
    const lanes = pack ? packDeploymentLanes(state.lanes, car) : state.lanes;
    const slots = deploymentSlots({ lanes }, player, pattern, pack && opening ? 7 : 13).flatMap(({ lane, position }) => {
      const dx = position.x - player.x, dz = position.z - player.z;
      const range = Math.hypot(dx, dz), forward = dx * sin + dz * cos;
      const lateral = dx * cos - dz * sin;
      const alignment = Math.cos(angleDelta(position.heading, player.heading));
      if (survival && (range < (opening ? 21 : 18) || (heavy && lane.road.width < 6.8))) return [];
      if (range < (pack && opening && Math.abs(lateral) >= 2.45 ? 7 : pack ? 14 : 18) ||
          patrolReach(lane, position) < 10 ||
          (forward > 0 && forward < 37 && Math.abs(lateral) < 3)) return [];
      if (pack) {
        if (survival) {
          const preferred = opening ? (order === 0 ? 2 : 1) : order % 4;
          const step = (huntSector(position, player) - preferred + 4) % 4;
          const score = Math.abs(range - (opening ? 29 : 32)) + Math.min(step, 4 - step) * 13 +
            (opening && forward > 0 ? 8 : 0);
          return [{ lane, position, stance: false, score }];
        }
        const stance = opening && order < 4 && Math.abs(lateral) > 2.45 && Math.abs(lateral) <= 11 &&
          Math.abs(forward) < 15;
        const score = packSpawnBias({ order, forward, lateral, range, alignment, opening, fronts });
        return [{ lane, position, stance, score: score - (stance && order !== 0 ? 13 : 0) }];
      }
      if (opening && alignment < -.85 && forward > 0 && range < 49 && Math.abs(lateral) < 7)
        return [];
      const side = (arcade ? order : i) % 2 ? -1 : 1;
      const desired = arcade ? (pattern === "tail" ? 30 + (order % 4) * 4 : 36)
        : order >= 7 ? 35 : pattern === "tail" ? 24 + order * 1.5 : 28;
      const approach = pattern === "tail"
        ? Math.max(0, forward + 5) * 1.8 + (1 - alignment) * 21 + Math.abs(lateral) * .32
        : pattern === "flank"
          ? Math.abs(alignment) * 9 + Math.max(0, -side * lateral) * .45
          : Math.max(0, -forward) * 1.25 + 4 * (alignment + 1);
      return [{ lane, position, score: Math.abs(range - desired) + approach }];
    }).sort((a, b) => a.score - b.score);
    let placed = false, tried = 0;
    for (const { lane, position, stance } of slots) {
      Object.assign(car, position);
      if (!bodyOnRoad(car, world.drivingRoads, .12) ||
          close.some(other => overlaps(car, other, pack ? .65 : 2)) ||
          [...state.patrols].some(other => overlaps(car, other, pack ? 1.4 : 3.6)) ||
          world.statics.some(other => overlaps(car, other, .45))) continue;
      const road = { width: lane.road.width, limit: lane.road.speedLimitMps };
      const pace = arcade ? arcadePatrolLimit(road) : rushRoadLimit(road, true);
      const end = { ...car, ...lanePoint(lane, position[lane.road.axis] + lane.sign * 7) };
      if (!sweepSafe(car, end, close.concat([...state.patrols], world.statics), world.drivingRoads).safe) continue;
      car.maxSpeed = arcade ? 22.5 + state.level * .65 : 14.6 + state.level * .25;
      if (survival) car.pursuitUnit = heavy ? "heavy" : time >= 5 && order % 3 !== 2 ? "interceptor" : "cruiser";
      if (arcade) car.spec = { ...car.spec, acceleration: heavy ? 5.1 : 6.4, braking: 9, steerRate: heavy ? 1.65 : 2.2,
        ...(heavy ? { wheelbase: 3.2 } : {}) };
      // The starting road may end right behind the SUV. Give the first close
      // rear unit a rolling launch instead of making contact before steering is possible.
      const shortLaunch = opening && distance(car, player) < 32 &&
        (car.x - player.x) * sin + (car.z - player.z) * cos < -8 &&
        Math.abs(angleDelta(car.heading, player.heading)) < .3;
      const packOpening = pack && opening && distance(car, player) <= 29 && !survival;
      setPursuitDrive(car, { position: { speed: Math.min(packOpening ? 3.4 : shortLaunch ? 5 : arcade ? 9 : 7.5, pace * .62) },
        behaviour: pattern, cruise: car.maxSpeed }, kind);
      if (shortLaunch) car.pursuitDrive.launchUntil = world.tick + ARCADE_BACKUP_TICKS;
      if (pack) car.pursuitDrive.packOrder = order;
      if (stance || packOpening && lane.outside) {
        // Wing units first compress the open lanes; direct attacks resume after the rolling approach.
        const along = position[lane.road.axis];
        car.path = Object.freeze(Array.from({ length: 11 }, (_, i) =>
          Object.freeze(lanePoint(lane, along + i * lane.sign))));
        car.pursuitDrive.target = car.path.at(-1);
      } else if (!planRushPatrol(world, state, car, lane, player)) {
        if (++tried >= 16) break;
        continue;
      }
      car.phase = state.rng.next();
      car.reckless = false;
      initializeDistrictActor({ environment: world.environment, rng: state.rng }, car);
      car.district.nextLoadingDistanceM = Infinity;
      car.pursuitDrive.nextPlan = world.tick + ticks(pack ? .3 + .4 * car.phase : .75 + .6 * car.phase);
      if (packOpening) {
        car.pursuitDrive.openingUntil = world.tick + ticks(2.6 + (order % 3) * .32);
        car.pursuitDrive.nextPlan = car.pursuitDrive.openingUntil;
      }
      car.previous = copyPose(car);
      state.patrols.add(car);
      if (survival) {
        survival.spawnCount++;
        if (heavy) survival.heavyCount++;
      }
      dispatched.push(car);
      placed = true;
      break;
    }
    if (!placed) break;
  }
  world.actors.push(...dispatched);
  if (world.pursuit === state)
    for (const car of dispatched) {
      logEvent(world, "reinforcement", car, car.id);
      if (survival) emitSurvival(world, "dispatch", car, car.pursuitUnit,
        { actorId: car.id, sector: huntSector(car, player) });
    }
  return dispatched.length;
}

/** Deploy without replacing the city or touching its ongoing trip. */
export function beginStreetPursuit(world, level = 1, variant = "legacy") {
  validateLevel(level);
  if (!["legacy", "rush", "cinematic", "arcade", "pack", "hunt", "survival"].includes(variant))
    throw new Error("Unsupported street pursuit variant");
  if (world.environment !== "metro" || !world.district?.pursuitExits?.length)
    throw new Error("Street pursuit requires a metro district with pursuit exits");
  if (world.pursuit?.phase === "running") throw new Error("Street pursuit is already running");
  if (world.pursuit?.reviewUntilTick > world.tick) throw new Error("Let the impact review finish first");
  const { player } = world;
  if (!bodyOnRoad(player, world.roads)) throw new Error("No safe street pursuit deployment");

  const occupiedIds = [...world.actors, ...world.statics].map((body) => body.id);
  let run = (world.pursuit?.run ?? 0) + 1;
  while (occupiedIds.some((id) => id.startsWith(`street-pursuit-${run}-`))) run++;
  const rush = usesRushPace(variant);
  const arcade = isRushPack(variant), pack = isPackPursuit(variant);
  const rng = new Random(`${world.config.seed}:street-pursuit-${arcade ? variant : rush ? "rush" : "v1"}:${world.tick}:${run}:${level}`);
  const state = {
    street: true, run, level, caseId: "street", phase: "running",
    playerStart: copyPose(player), exits: world.district.pursuitExits.map((exit) => ({ ...exit })),
    events: [], action: null, appliedCommand: null, decision: null,
    startedTick: world.tick, endedTick: null, metrics: pursuitMetrics(),
    rng, patrols: new Set(), closures: new Map(), contacts: new Set(), near: new Set(),
    nextEventTick: ticks(rng.range(2.4, 4.2)), eventKinds: [], eventSerial: 0,
    patrolMap: { roads: world.roads, drivingRoads: world.drivingRoads, statics: world.statics },
    lanes: [], junctions: world.drivingRoads.filter((r) => r.axis === "x" && !r.supportApron).flatMap((a) =>
      world.drivingRoads.filter((r) => r.axis === "z" && !r.supportApron &&
        r.fixed >= a.min && r.fixed <= a.max && a.fixed >= r.min && a.fixed <= r.max)
        .map((r) => ({ x: r.fixed, z: a.fixed }))),
  };
  const tactics = ["tail", "flank", "intercept", "flank", "tail", "intercept"];
  const ambientRandomState = world.rng.state;
  try {
    if (rush) {
      const [initial, target] = (arcade ? ARCADE_WAVES : RUSH_WAVES)[level - 1];
      state.variant = variant;
      if (pack) {
        initializePack(state, "running");
        state.variant = variant;
        if (isCityHunt(variant)) Object.assign(state.metrics, { pedestrianCost: 0, pedestrianDanger: 0 });
      }
      else if (arcade || variant === "cinematic") state.response = createPursuitResponse();
      state.targetPatrols = target;
      state.nextDispatchTick = world.tick + (arcade ? ARCADE_BACKUP_TICKS : ticks(rng.range(2.4, 3.1)));
      if (arcade) state.wantedLevel = level;
      if (isSurvival(variant)) {
        state.survival = createSurvival(player, world.tick);
        state.wantedLevel = 1;
        state.manualAction = { steer: 0, throttle: 1, brake: 0, gear: 1 };
        state.nextDispatchTick = world.tick + ticks(2.4);
      }
      // Let the first backup wave enter before adding a new obstacle.
      // Ordinary traffic, including its own encounters, is live throughout.
      state.nextEventTick = ticks(rng.range(5.2, 5.8));
      state.patrolMap.metro = true;
      rushDispatch(world, state, state.survival ? 2 : initial, state.response ? state.playerStart : player);
      if (!state.patrols.size) throw new Error("No safe street pursuit deployment");
    } else for (const [i, behaviour] of tactics.slice(0, TIERS[level - 1].police).entries()) {
      const id = `street-pursuit-${run}-patrol-${i + 1}`;
      const car = world.makeVehicle(id, "sedan", { x: player.x, z: player.z, heading: player.heading });
      if (!i) state.lanes = streetLanes(world.drivingRoads, car);
      let found = false;
      for (const { lane, position } of deploymentSlots(state, player, behaviour)) {
        const { x, z, heading } = position;
        Object.assign(car, { x, z, heading });
        if (!isFree(world, car, 0.65) || !bodyOnRoad(car, world.drivingRoads) ||
            [...state.patrols].some((other) => overlaps(car, other, 0.65))) continue;
        const cruise = 6.9 + level * 0.6 + rng.range(-0.3, 0.5);
        const speed = Math.min(2.5, (lane.road.speedLimitMps ?? cruise) * 0.5);
        setPursuitDrive(car, { position: { speed }, behaviour, cruise }, "sedan");
        const fallback = lanePoint(lane, position[lane.road.axis] + lane.sign * 16);
        if (!setStreetPatrolPath(state, car, player, fallback)) continue;
        car.phase = rng.next();
        car.reckless = false;
        // Keep patrol profiles on the episode RNG even when the ordinary
        // district hooks initialize and update reservations for the same cars.
        initializeDistrictActor({ environment: world.environment, rng }, car);
        car.district.nextLoadingDistanceM = Infinity;
        car.pursuitDrive.nextPlan = world.tick + 26 + Math.floor(car.phase * 17);
        car.previous = copyPose(car);
        state.patrols.add(car);
        found = true;
        break;
      }
      if (!found) throw new Error(`No safe street pursuit deployment for patrol ${i + 1}`);
    }
  } finally {
    world.rng.state = ambientRandomState;
  }
  if (!rush) world.actors.push(...state.patrols);
  world.actorIndex = new SpatialIndex(world.actors);
  world.pursuit = state;
  if (state.response) {
    updatePursuitResponse(world, true);
    for (const patrol of state.patrols) patrol.pursuitDrive.tracking = state.response.sightedBy.has(patrol);
  }
  logEvent(world, "start", player);
  return state;
}

function releaseStreetStatics(world) {
  const state = world.pursuit;
  const { staticOverlay } = state;
  if (!staticOverlay || state.closures.size) return;
  const { live, permanent } = staticOverlay;
  if (world.statics === live && live.length === permanent.length &&
      live.every((body, i) => body === permanent[i])) world.statics = permanent;
  state.staticOverlay = null;
  state.patrolMap.statics = world.statics;
}

function cleanupStreetPursuit(world) {
  const state = world.pursuit;
  if (state.survival && !releaseSurvival(world)) return false;
  // Ownership is by object identity, not role, id prefix, or array position.
  for (let i = world.actors.length - 1; i >= 0; i--)
    if (state.patrols.has(world.actors[i]) || state.survival?.wrecks.has(world.actors[i])) world.actors.splice(i, 1);
  for (let i = world.statics.length - 1; i >= 0; i--)
    if (state.closures.has(world.statics[i])) world.statics.splice(i, 1);
  state.patrols.clear();
  state.survival?.wrecks.clear();
  state.closures.clear();
  releaseStreetStatics(world);
  state.contacts.clear();
  state.near.clear();
  state.sightings?.clear();
  if (state.response) {
    state.response.sightedBy.clear();
    state.response.closePatrols.clear();
    state.response.unitsInContact = 0;
  }
  if (isRushPack(state.variant)) state.wantedLevel = 0;
  state.reviewUntilTick = null;
  if (state.endedTick == null) {
    state.endedTick = world.tick;
    logEvent(world, state.phase, world.player);
  }
  world.actorIndex = new SpatialIndex(world.actors);
  world.staticIndex = new SpatialIndex(world.statics);
  return true;
}

/** Preserve terminal results so callers can show the outcome as city play continues. */
export function endStreetPursuit(world) {
  const state = world.pursuit;
  if (state?.street && (state.phase === "running" || state.reviewUntilTick)) {
    if (state.phase === "running") state.phase = "stopped";
    cleanupStreetPursuit(world);
    world.updateSensors(false);
  }
  return state?.street ? state : null;
}

export function startPackDrill(world) {
  const state = world.pursuit;
  state.startedTick = world.tick;
  updatePursuitResponse(world, true);
  logEvent(world, "start", world.player);
}

export function stepPackReview(world) {
  const state = world.pursuit;
  if (!isPackPursuit(state?.variant) || !state.reviewUntilTick) return false;
  if (++world.tick >= state.reviewUntilTick) {
    if (state.street) {
      if (cleanupStreetPursuit(world)) world.resumeStreetDrive();
      else state.reviewUntilTick = world.tick + 1;
    } else state.reviewUntilTick = null;
  }
  return true;
}

function copyPose(a) {
  return {
    id: a.id, type: a.type, x: a.x, z: a.z, y: a.y ?? 0, heading: a.heading,
    speed: a.speed ?? 0, length: a.length, width: a.width, radius: a.radius,
  };
}

function heightOnSupport(state, a) {
  if (!state.support.length) return 0;
  const reach = (a.spec?.wheelbase ?? VEHICLE.wheelbase) / 2;
  const track = a.id === "player" ? PLAYER_VEHICLE.trackM : a.width * 0.83;
  const cos = Math.cos(a.heading), sin = Math.sin(a.heading);
  let support = 0;
  for (const side of [-1, 1]) for (const end of [-1, 1]) {
    const x = a.x + side * track * cos / 2 + end * reach * sin;
    const z = a.z - side * track * sin / 2 + end * reach * cos;
    let height = 0;
    for (const r of state.support) {
      const inside = Math.min(x - r.minX, r.maxX - x, z - r.minZ, r.maxZ - z);
      height = Math.max(height, clamp(inside / 0.65, 0, 1) * r.height);
    }
    support += height / 4;
  }
  return support;
}

function logEvent(world, kind, point, actorId, tick = world.tick) {
  const state = world.pursuit;
  state.events.push({
    id: `${state.street ? `street-pursuit-${state.run}` : "pursuit"}-event-${++state.eventSerial}`,
    kind, tick, x: point.x, z: point.z,
    ...(actorId ? { actorId } : {}),
  });
  if (state.events.length > MAX_EVENTS) state.events.shift();
}

function registerBarrier(world, body, kind, removeAt = Infinity) {
  if (!isFree(world, body, 0.4)) return false;
  const state = world.pursuit;
  if (state.street && world.statics === world.district.statics) {
    // Keep temporary obstacles out of permanent district and camera map data.
    const permanent = world.statics;
    state.staticOverlay = { permanent, live: permanent.slice() };
    world.statics = state.staticOverlay.live;
  }
  world.statics.push(body);
  state.closures.set(body, removeAt);
  state.navGraph = null;
  world.staticIndex = new SpatialIndex(world.statics);
  logEvent(world, kind, body, body.id);
  return true;
}

function chooseBarrier(world, kind, player = world.player) {
  const { rng, eventSerial, street, run, variant } = world.pursuit;
  const candidates = [];
  for (const r of world.drivingRoads) {
    if (street && (r.supportApron || r.parkingBay)) continue;
    for (let n = r.min + 8; n <= r.max - 6; n += 7) {
      const along = n + rng.range(-1.1, 1.1);
      const offset = kind === "roadblock" && !street ? (rng.next() < 0.5 ? -1.65 : 1.65) : 0;
      const point = street && kind === "roadblock"
        ? districtRoadPose(r, along, r.flow || (rng.next() < 0.5 ? -1 : 1))
        : r.axis === "z"
        ? { x: r.fixed + offset, z: along }
        : { x: along, z: r.fixed + offset };
      const d = distance(point, player);
      if (d < (street ? 12 : 7) || d > 45 ||
          world.drivingRoads.some((other) => other.axis !== r.axis && pointOnRoad(point, [other], -2.0)) ||
          world.pursuit.exits.some((goal) => distance(point, goal) < 6))
        continue;
      const forward = Math.sin(player.heading) * (point.x - player.x) +
        Math.cos(player.heading) * (point.z - player.z);
      if (usesRushPace(variant)) {
        const speed = Math.abs(player.speed);
        const reactionRoom = player.length + speed * .55 + speed ** 2 / (2 * 4.2);
        if (d < Math.max(17, reactionRoom)) continue;
        // A whole-road closure ahead needs a usable branch before it, not
        // an instantaneous dead end on a long, uninterrupted avenue.
        if (kind === "closure" && forward > 0 && pointOnRoad(player, [r], 0)) {
          const own = player[r.axis], low = Math.min(own, along) + 7, high = Math.max(own, along) - 6;
          if (!world.drivingRoads.some(other => other.axis !== r.axis && !other.supportApron &&
              other.width >= player.width + .4 && other.fixed >= low && other.fixed <= high &&
              r.fixed >= other.min && r.fixed <= other.max)) continue;
        }
      }
      const width = kind === "closure" ? r.width + (street ? 0 : 0.15)
        : street ? Math.min(3.2, r.width - 2 * Math.abs(r.laneOffsetM ?? 0)) : 3.2;
      const prefix = street ? `street-pursuit-${run}` : "pursuit";
      const body = barrier(`${prefix}-${kind}-${eventSerial + 1}`, point.x, point.z,
        width, 0.8, r.axis === "x" ? Math.PI / 2 : 0);
      candidates.push({ body, score: rng.next() * 36 + Math.abs(d - 19) + (forward < -2 ? 11 : 0) });
    }
  }
  candidates.sort((a, b) => a.score - b.score);
  return candidates.find(({ body }) => isFree(world, body, 0.4))?.body;
}

function updateEvents(world) {
  const s = world.pursuit;
  const elapsed = world.tick - s.startedTick, r = s.response;
  if (isRushPack(s.variant)) {
    if (s.packLab) return;
    if (world.tick >= s.nextDispatchTick) {
      if (s.survival) {
        const timeS = elapsed * STEP;
        s.nextDispatchTick = world.tick + ticks(timeS < 5 ? 2.4 : Math.max(1.05, 2.05 - timeS * .036));
        if (r.unitsInContact || (r.stage === "search" && r.lostAtTick !== null &&
            world.tick - r.lostAtTick <= ticks(2.5))) {
          const room = Math.min(s.targetPatrols, 4 + Math.floor(timeS / 3) * 2) - s.patrols.size;
          const seed = world.rng.state;
          try {
            const count = room > 0 ? rushDispatch(world, s, Math.min(timeS < 6 ? 1 : 2, room),
              r.lastSeen ?? s.playerStart) : 0;
            if (count && r.unitsInContact) s.wantedLevel = Math.min(5, 1 + Math.floor(s.survival.spawnCount / 3));
          } finally {
            world.rng.state = seed;
          }
        }
        return;
      }
      s.nextDispatchTick += ARCADE_BACKUP_TICKS;
      // Respond to a confirmed radio position, never a hidden live pose.
      if (r.unitsInContact && s.patrols.size < s.targetPatrols) {
        const ambientSeed = world.rng.state;
        try {
          if (rushDispatch(world, s, 1, r.lastSeen)) s.wantedLevel = Math.min(5, s.wantedLevel + 1);
        } finally {
          world.rng.state = ambientSeed;
        }
      }
    }
    return;
  }
  const confirmed = r?.unitsInContact > 0 && r.pressure >= .20;
  // The only assignment without a positive sighting is the initial callout.
  // Once a report exists, losing sight suspends all new pursuit-owned hazards.
  const dispatchAt = r ? confirmed ? r.lastSeen :
    !r.lastSeen && elapsed <= ticks(3.2) ? s.playerStart : null : world.player;
  if (usesRushPace(s.variant) && dispatchAt && s.patrols.size < s.targetPatrols &&
      world.tick >= s.nextDispatchTick) {
    const ambientSeed = world.rng.state;
    try {
      rushDispatch(world, s, Math.min(2, s.targetPatrols - s.patrols.size), dispatchAt);
    } finally {
      world.rng.state = ambientSeed;
    }
    s.nextDispatchTick = world.tick + ticks(s.rng.range(.85, 1.25));
  }
  for (const [body, expires] of s.closures) {
    if (world.tick < expires) continue;
    const index = world.statics.indexOf(body);
    if (index >= 0) world.statics.splice(index, 1);
    s.closures.delete(body);
    s.navGraph = null;
    if (s.street) releaseStreetStatics(world);
    world.staticIndex = new SpatialIndex(world.statics);
    logEvent(world, "reopen", body, body.id);
  }
  if (s.scene?.closure && elapsed >= s.scene.closure.at &&
      registerBarrier(world, s.scene.closure.body, "closure")) s.scene.closure = null;
  if ((!s.street && s.caseId !== "ambient") || elapsed < s.nextEventTick || (r && !confirmed)) return;
  const { rng } = s;
  if (!s.eventKinds.length)
    s.eventKinds.push(...shuffled(rng, s.street ? ["closure", "roadblock"] : ["closure", "roadblock", "congestion"]));
  const kind = s.eventKinds[0];
  let applied = false;
  if (kind === "congestion") {
    const cars = world.actors.filter((a) => a.pursuitRole === "civilian" &&
      a.pursuitDrive.paceUntil <= world.tick);
    const ordered = shuffled(rng, cars).sort((a, b) =>
      Number(distance(world.player, b) < 38) - Number(distance(world.player, a) < 38));
    if (ordered.length) {
      const car = ordered[0];
      car.pursuitDrive.paceMps = rng.range(0.55, 1.65);
      car.pursuitDrive.paceUntil = world.tick + ticks(rng.range(3.2, 6.0));
      logEvent(world, "congestion", car, car.id);
      applied = true;
    }
  } else if (s.closures.size < 2) {
    const position = r && { ...r.lastSeen, width: world.player.width, length: world.player.length };
    const body = chooseBarrier(world, kind, position ?? undefined);
    if (body) applied = registerBarrier(world, body, kind, world.tick + ticks(rng.range(5.5, 9.0)));
  }
  if (applied) s.eventKinds.shift();
  s.nextEventTick = elapsed + ticks(applied ? rng.range(3.2, 5.7) - (s.level - 1) * 0.24 : 0.65);
}

function safeRoadTarget(point, roads) {
  if (pointOnRoad(point, roads, 1.35)) return point;
  let target = null;
  for (const r of roads) {
    const p = r.axis === "z"
      ? { x: r.fixed, z: clamp(point.z, r.min, r.max) }
      : { x: clamp(point.x, r.min, r.max), z: r.fixed };
    if (!target || distance(point, p) < distance(point, target)) target = p;
  }
  return target;
}

function navigableGraph(world) {
  const s = world.pursuit;
  if (s.navGraph) return s.navGraph;
  s.navGraph = new Map(Array.from(s.graph, ([key, node]) => [key, {
    ...node, edges: node.edges.filter((edge) => {
      const end = s.graph.get(edge);
      const heading = headingTo(node, end);
      for (let i = 0, count = Math.ceil(distance(node, end)); i <= count; i++) {
        const probe = { ...interpolate(node, end, i / count), heading, width: 1.8, length: 1 };
        if (world.statics.some((body) => overlaps(probe, body, 0.12))) return false;
      }
      return true;
    }),
  }]));
  return s.navGraph;
}

function straightApproach(world, a, target) {
  const heading = headingTo(a, target);
  if (Math.abs(angleDelta(heading, a.heading)) > 1.18) return false;
  for (let i = 1; i <= 8; i++) {
    const probe = { ...a, ...interpolate(a, target, i / 8), heading };
    if (!pointOnRoad(probe, world.drivingRoads, 1.2) ||
        world.statics.some((body) => overlaps(probe, body, 0.2))) return false;
  }
  return true;
}

function replanPolice(world, a) {
  const { player: ego, pursuit: s } = world, drive = a.pursuitDrive;
  if (usesRushPace(s.variant)) {
    const segment = a.path[Math.min(a.cursor + 13, a.path.length - 1)];
    const error = segment && Math.abs(angleDelta(headingTo(a, segment), a.heading));
    // Let the checked exit line carry a turning car back into a lane before reattaching.
    if (s.response) {
      const sighted = s.response.sightedBy.has(a);
      const report = s.response.lastSeen ?? s.playerStart;
      const pack = isPackPursuit(s.variant);
      const searching = isRushPack(s.variant) ? s.response.unitsInContact === 0 : !sighted;
      const lost = drive.tracking && !sighted;
      const inSearch = searching && drive.searchReport && distance(report, drive.searchReport) < 6 &&
        world.staticIndex === drive.searchMap && a.path.length > 1 &&
        distance(a, a.path.at(-1)) > 6 && a.wait < .6;
      const hunt = isCityHunt(s.variant);
      if (!inSearch && (lost || !segment || error < .65 || a.wait > .6)) {
        const found = s.packLab && !searching ? true : planRushPatrol(world, s, a, null, report, searching);
        if (!found && (lost || (hunt && a.wait > .8))) {
          a.path = [];
          a.cursor = 0;
          drive.target = null;
        }
        drive.searchReport = searching ? report : null;
        drive.searchMap = searching ? world.staticIndex : null;
        drive.tracking = sighted;
      }
    } else if (!segment || error < .65 || a.wait > .6) planRushPatrol(world, s, a);
    drive.nextPlan = world.tick + ticks(isPackPursuit(s.variant) ? .48 + a.phase * .45 : .83 + a.phase * .52);
    return;
  }
  const dx = Math.sin(ego.heading), dz = Math.cos(ego.heading);
  const ahead = (metres) => ({ x: ego.x + dx * metres, z: ego.z + dz * metres });
  const speed = ego.speed;
  let target = ahead(speed * 0.6);
  if (drive.pattern === "intercept") target = ahead(clamp(7 + speed * 2.5, 3, 24));
  if (drive.pattern === "flank") {
    const projected = ahead(clamp(5 + speed * 1.4, 3, 16));
    target = s.junctions.reduce((best, point) => {
      const score = (p) => distance(p, projected) + 0.42 * distance(a, p);
      return !best || score(point) < score(best) ? point : best;
    }, null) ?? projected;
  }
  if (drive.pattern === "intercept" && distance(a, ego) < 10 &&
      Math.cos(angleDelta(a.heading, ego.heading)) < -0.5) target = ahead(speed * 0.3);
  if (s.street) {
    s.patrolMap.statics = world.statics;
    // Attach back to a legal lane after a turn; if already mid-turn, retain
    // the checked path rather than cutting across the block to the new aim.
    setStreetPatrolPath(s, a, target);
    drive.nextPlan = world.tick + 60 + Math.floor(a.phase * 24);
    return;
  }
  target = safeRoadTarget(target, world.drivingRoads);
  const direct = distance(a, target) < 1 || straightApproach(world, a, target);
  a.path = direct ? [] : planNavigation(navigableGraph(world), a, target);
  a.cursor = 0;
  drive.target = target;
  drive.nextPlan = world.tick + 26 + Math.floor(a.phase * 17);
}

function steerToward(a, target) {
  const axle = (a.spec?.wheelbase ?? VEHICLE.wheelbase);
  const rear = {
    x: a.x - Math.sin(a.heading) * axle / 2,
    z: a.z - Math.cos(a.heading) * axle / 2,
  };
  const alpha = angleDelta(headingTo(rear, target), a.heading);
  return Math.atan2(2 * axle * Math.sin(alpha), Math.max(1, distance(rear, target)));
}

function frontHazards(world, a, targetSpeed) {
  const sin = Math.sin(a.heading), cos = Math.cos(a.heading);
  const { variant, response } = world.pursuit;
  const police = a.pursuitRole === "police";
  let cap = targetSpeed, lead = null, blockedBy = null;
  for (const b of world.actorIndex.near(a, 21).concat(world.staticIndex.near(a, 23))) {
    if (b === a) continue;
    const target = b === world.player && police;
    if (target && isRushPack(variant)) continue;
    if (police && world.pursuit.survival && world.pursuit.patrols.has(b)) continue;
    if (target && !(response ? response.sightedBy.has(a) : variant === "rush")) continue;
    const measured = target && response ? response.lastSeen : b;
    const dx = measured.x - a.x, dz = measured.z - a.z;
    const front = dx * sin + dz * cos, side = dx * cos - dz * sin;
    const otherTurn = angleDelta(measured.heading ?? 0, a.heading);
    const otherAlong = Math.cos(otherTurn) * (measured.speed ?? 0);
    const otherLateral = Math.sin(otherTurn) * (measured.speed ?? 0);
    const across = extent(b, cos, -sin);
    const lane = a.width / 2 + across + 0.32;
    const crossingAt = Math.abs(side) > lane && side * otherLateral < 0
      ? (Math.abs(side) - lane) / Math.abs(otherLateral) : 0;
    if (front < 0.1 || (Math.abs(side) > lane && !(crossingAt > 0 && crossingAt < 1.4)))
      continue;
    const gap = front - a.length / 2 - extent(b, sin, cos);
    if (crossingAt && gap > Math.max(3, a.speed) * (crossingAt + 1.1)) continue;
    const floor = b.type === "pedestrian" ? 1.7 : b === world.player && usesRushPace(variant) ? 1.4 : 0.8;
    const desired = Math.max(0, otherAlong + (gap - floor) / (b.type === "pedestrian" ? 2 : 1.35));
    if (desired < cap) {
      cap = desired;
      blockedBy = b.id;
      lead = b.type === "vehicle" && !crossingAt && Math.abs(otherTurn) < 0.45 && gap < 12 ? b : null;
    }
  }
  return { cap, lead, blockedBy };
}

function ramApproach(world, car) {
  const state = world.pursuit, { sightedBy, lastSeen } = state.response;
  if (!sightedBy.has(car)) return null;
  const range = distance(car, lastSeen);
  if (range > 32) return null;
  const lead = lastSeen.speed * clamp(range / (car.speed + 14), 0, .65);
  const projected = { x: lastSeen.x + Math.sin(lastSeen.heading) * lead,
    z: lastSeen.z + Math.cos(lastSeen.heading) * lead };
  const pack = isPackPursuit(state.variant);
  if (pack && world.tick < car.pursuitDrive.openingUntil) return null;
  const packAim = pack ? packRamAim({ car, report: lastSeen, order: car.pursuitDrive.packOrder,
    tick: world.tick, startedTick: state.startedTick }) : null;
  const targets = pack ? packAim ? [packAim] : [] : lead ? [projected, lastSeen] : [lastSeen];
  for (const aim of targets) {
    const heading = headingTo(car, aim);
    if (Math.abs(angleDelta(heading, car.heading)) > (pack ? .9 : .58)) continue;
    const step = Math.min(1, 12 / Math.max(1, distance(car, aim))) / 3;
    if ([1, 2, 3].every(i => bodyOnRoad({ ...car, ...interpolate(car, aim, i * step), heading },
      world.drivingRoads, .12))) return { steer: steerToward(car, aim), speed: packAim?.speed ?? Infinity };
  }
  return null;
}

function repositionHuntPatrol(world, car) {
  const { pursuit } = world, { response } = pursuit;
  const sighted = response.sightedBy.has(car);
  if (car.wait < .7 && car.speed >= 0) return null;
  const nearby = world.actorIndex.near(car, 10)
    .filter(actor => actor !== car && (actor !== world.player || sighted))
    .concat(world.staticIndex.near(car, 22));
  const target = response.lastSeen ?? pursuit.playerStart;
  const facing = Math.sign(angleDelta(headingTo(car, target), car.heading));
  for (const steer of [-facing * .5, 0, facing * .5]) {
    const command = { steer, targetSpeed: -1.8, reason: "police-reposition" };
    let pose = car;
    for (let i = 0; i < 8; i++) {
      const next = integrateVehicle(pose, command, .125);
      if (!sweepSafe(pose, next, nearby, world.drivingRoads).safe) break;
      pose = next;
    }
    if (distance(pose, car) > .85) return command;
  }
  return null;
}

function shiftedTarget(a, path, shift) {
  const start = path[a.cursor], end = path[Math.min(path.length - 1, a.cursor + 11)];
  if (!start || !end || distance(start, end) < 1.8) return null;
  const heading = headingTo(start, end);
  if (Math.abs(angleDelta(heading, a.heading)) > 0.31) return null;
  return { x: end.x + Math.cos(heading) * shift, z: end.z - Math.sin(heading) * shift, heading };
}

function updateLane(world, a, lead) {
  const drive = a.pursuitDrive, now = world.tick;
  if (now >= drive.laneUntil) drive.laneBiasM = 0;
  if (!lead || now < drive.laneProbeAt || drive.laneBiasM) return;
  drive.laneProbeAt = now + 30;
  const close = world.actorIndex.near(a, 18).filter((b) => b !== a)
    .concat(world.staticIndex.near(a, 19));
  const side = a.phase < 0.5 ? -1 : 1;
  for (const shift of [side * 2.85, -side * 2.85]) {
    const target = shiftedTarget(a, a.path, shift);
    if (!target) continue;
    const next = { ...a, ...target };
    if (sweepSafe(a, next, close, world.drivingRoads).safe) {
      drive.laneBiasM = shift;
      drive.laneUntil = now + ticks(2.6);
      return;
    }
  }
}

function patrolHasSupport(world, patrol) {
  // Keep the existing pressure when another unit can join the capture.
  return world.actorIndex.near(world.player, 11.2)
    .some((a) => a !== patrol && a.pursuitRole === "police");
}

function patrolReassessment(world, a) {
  const { player: ego, tick } = world, drive = a.pursuitDrive;
  const reaction = drive.reaction;
  if (!reaction) return null;
  const sin = Math.sin(a.heading), cos = Math.cos(a.heading);
  const dx = ego.x - a.x, dz = ego.z - a.z;
  const ahead = dx * sin + dz * cos;
  const gap = ahead - a.length / 2 - extent(ego, sin, cos);
  const aligned = ahead > a.length / 2 &&
    Math.abs(dx * cos - dz * sin) < a.width / 2 + extent(ego, cos, -sin) + 0.8;
  if (patrolHasSupport(world, a) || !aligned || gap > 4.2) {
    drive.reaction = null;
    drive.nextPlan = tick;
    return null;
  }
  const hold = { steer: 0, targetSpeed: 0, reason: "patrol-reassess" };
  if (tick < reaction.settleUntil) return hold;
  const retreat = 1.35 - distance(a, reaction);
  if (tick < reaction.backUntil && gap < 2.05 && retreat > 0) {
    const body = {
      ...a, x: a.x - sin * retreat, z: a.z - cos * retreat,
    };
    // The ego is ahead at the tangent; the exact contact solver still checks
    // both real trajectories. Predictive braking checks the space behind us.
    const obstacles = world.actorIndex.near(a, 9).filter((b) => b !== a && b !== ego)
      .concat(world.staticIndex.near(a, 11));
    const clear = sweepSafe(a, body, obstacles, world.drivingRoads);
    if (!clear.safe) return { ...hold, blockedBy: clear.actor ?? null };
    return {
      steer: 0, targetSpeed: -Math.min(1.3, Math.sqrt(4 * retreat)), reason: "patrol-backoff",
    };
  }
  if (a.speed < 0) return hold;
  // Follow at standoff until normal pursuit can reacquire, rather than
  // accelerating into a stationary bumper again after the brief retreat.
  const aheadSpeed = ego.speed * Math.cos(angleDelta(ego.heading, a.heading));
  const threat = frontHazards(world, a, clamp(aheadSpeed + (gap - 1.12) / 1.3, 0, drive.cruise));
  return { steer: steerToward(a, ego), targetSpeed: threat.cap, blockedBy: threat.blockedBy, reason: hold.reason };
}

function npcCommand(world, a) {
  const drive = a.pursuitDrive;
  if (!drive || drive.pattern === "parked") return { steer: 0, targetSpeed: 0, reason: "holding" };
  const police = a.pursuitRole === "police";
  const response = world.pursuit.response;
  const pack = police && isPackPursuit(world.pursuit.variant);
  const arcade = police && isRushPack(world.pursuit.variant);
  const reaction = police && !world.pursuit.street && patrolReassessment(world, a);
  if (reaction) return reaction;
  if (police && (world.tick >= drive.nextPlan || (drive.tracking && !response?.sightedBy.has(a))))
    replanPolice(world, a);
  let steer, speed;
  const ram = arcade ? ramApproach(world, a) : null;
  if (ram) {
    steer = ram.steer;
    const curvature = Math.abs(Math.tan(steer)) / VEHICLE.wheelbase;
    speed = Math.min(drive.cruise, ram.speed, Math.sqrt((pack ? 5.2 : 4.2) / Math.max(.006, curvature)));
  } else if (a.path.length > 1) {
    const path = followPath(a, a.path, a.cursor);
    a.cursor = path.cursor;
    steer = path.steer;
    speed = Math.min(drive.cruise, path.targetSpeed * (arcade ? 1.22 : 1));
  } else {
    if (response && police) {
      if (isCityHunt(world.pursuit.variant) && world.pursuit.street) {
        const reposition = repositionHuntPatrol(world, a);
        if (reposition) return reposition;
      }
      if (pack && world.pursuit.packLab && response.sightedBy.has(a)) {
        const target = response.lastSeen;
        const heading = headingTo(a, target);
        return { steer: steerToward(a, target), targetSpeed: Math.min(drive.cruise, 4.5),
          reason: Math.abs(angleDelta(heading, a.heading)) > .9 ? "police-turn" : "police-pack" };
      }
      return { steer: 0, targetSpeed: 0, reason: "patrol-reassess" };
    }
    const target = drive.target;
    steer = steerToward(a, target);
    const remaining = distance(a, target);
    const error = Math.abs(angleDelta(headingTo(a, target), a.heading));
    speed = Math.min(drive.cruise, 7.5 / (1 + Math.abs(steer)), Math.sqrt(5 * Math.max(0, remaining - 0.75)));
    if (error > 1.4) speed = Math.min(speed, 1.4);
    if (police && drive.pattern === "tail" && error < 0.8) {
      speed = Math.min(drive.cruise, Math.max(speed, Math.abs(world.player.speed) + 1.7));
    }
  }
  if (world.tick < drive.launchUntil) speed = Math.min(speed, 5);
  if (world.tick < drive.openingUntil) speed = Math.min(speed, 4.6);
  if (world.tick < drive.paceUntil) speed = Math.min(speed, drive.paceMps);
  const threat = frontHazards(world, a, speed);
  if (!police && a.path.length > 1) {
    updateLane(world, a, threat.lead);
    const target = drive.laneBiasM && shiftedTarget(a, a.path, drive.laneBiasM);
    if (target) steer = steerToward(a, target);
  }
  return {
    steer, targetSpeed: threat.cap, blockedBy: threat.blockedBy,
    reason: threat.cap < speed - 0.1 ? "yielding" :
      world.tick < drive.paceUntil ? "congested" :
      ram ? "police-ram" :
        police ? `police-${drive.pattern}` : drive.laneBiasM ? "lane-change" : "traffic",
  };
}

function shapeRadius(a) {
  return a.type === "pedestrian" ? a.radius : Math.hypot(a.length, a.width) / 2;
}

// Projection half-extent on the contact normal, valid for a person circle or
// an oriented rectangular body. The speed estimate includes tip rotation.
function extent(a, x, z) {
  if (a.type === "pedestrian") return a.radius;
  const cos = Math.cos(a.heading ?? 0), sin = Math.sin(a.heading ?? 0);
  return Math.abs(x * sin + z * cos) * a.length / 2 +
    Math.abs(x * cos - z * sin) * a.width / 2;
}

function travel(before, after) {
  return distance(before, after) + Math.abs(angleDelta(after.heading, before.heading)) * shapeRadius(before);
}

function poseAt(p, t) {
  if (t <= 0) return p.a;
  if (!p.travel) return p.next;
  const time = Math.min(t, p.stop);
  return time === 1 ? p.next : interpolate(p.a, p.next, time);
}

function findContact(a, b, since) {
  if ((a.stop <= since || !a.travel) && (b.stop <= since || !b.travel)) return null;
  const maxTravel = a.travel + b.travel;
  if (distance(a.a, b.a) > a.radius + b.radius + maxTravel) return null;
  const occupied = (t) => overlaps(poseAt(a, t), poseAt(b, t));
  const steps = Math.max(1, Math.ceil(maxTravel * (1 - since) / 0.035));
  for (let i = 1; i <= steps; i++) {
    let high = since + (1 - since) * i / steps;
    if (!occupied(high)) continue;
    let low = since + (1 - since) * (i - 1) / steps;
    for (let j = 0; j < 28; j++) {
      const mid = (low + high) / 2;
      if (occupied(mid)) high = mid;
      else low = mid;
    }
    return { a, b, time: low, overlapAt: high };
  }
  return null;
}

function normalAt(a, b) {
  const dx = b.x - a.x, dz = b.z - a.z;
  const axes = [];
  for (const actor of [a, b]) {
    if (actor.type === "pedestrian") continue;
    axes.push(actor.heading, actor.heading + Math.PI / 2);
    if ([a, b].some((body) => body.type === "pedestrian"))
      axes.push(...corners(actor).map((p) => headingTo(p, actor === a ? b : a)));
  }
  if (!axes.length) axes.push(Math.atan2(dx, dz));
  let normal = null, bestGap = -Infinity;
  for (const h of axes) {
    const x = Math.sin(h), z = Math.cos(h);
    const separation = dx * x + dz * z;
    const gap = Math.abs(separation) - extent(a, x, z) - extent(b, x, z);
    if (gap > bestGap) {
      const sign = separation < 0 ? -1 : 1;
      bestGap = gap;
      normal = { x: x * sign, z: z * sign };
    }
  }
  return normal;
}

function closingSpeed(a, b, t, normal) {
  const earlier = Math.max(0, t - 0.1);
  const gap = (at) => {
    const p = poseAt(a, at), q = poseAt(b, at);
    const { x, z } = normal;
    return (q.x - p.x) * x + (q.z - p.z) * z - extent(p, x, z) - extent(q, x, z);
  };
  return (gap(earlier) - gap(t)) / (Math.max(1e-8, t - earlier) * STEP);
}

function contactImpact(ego, other, time, overlapAt, tick) {
  const a = poseAt(ego, time), b = poseAt(other, time), normal = normalAt(a, b);
  const front = normal.x * Math.sin(a.heading) + normal.z * Math.cos(a.heading);
  const right = normal.x * Math.cos(a.heading) - normal.z * Math.sin(a.heading);
  const side = Math.abs(front) >= Math.abs(right)
    ? front > 0 ? "front" : "rear"
    : right > 0 ? "right" : "left";
  const closingSpeedMps = Math.max(0, closingSpeed(ego, other, overlapAt, normal));
  const mass = PLAYER_VEHICLE.massKg;
  const otherMass = b.type === "pedestrian" ? other.a.body?.massKg ?? 75 :
    b.type === "vehicle" ? b.kind === "tuktuk" ? 620 : 1450 : Infinity;
  const effectiveMass = b.type === "static" ? mass : mass * otherMass / (mass + otherMass);
  const energyJ = 0.5 * effectiveMass * closingSpeedMps ** 2;
  return { actorId: b.id, side, closingSpeedMps, energyJ, severity: clamp(energyJ / 42000, 0, 1), tick, x: a.x, z: a.z };
}

const pairId = (a, b) => [a.id, b.id].sort().join(":");

function streetContactPairs(moving, solid) {
  const cells = new Map(), cellSize = 8;
  const bounds = (body) => {
    // travel includes translation and corner rotation, even when contact later stops it.
    const reach = body.radius + body.travel + .24;
    return [Math.floor((body.a.x - reach) / cellSize), Math.floor((body.a.x + reach) / cellSize),
      Math.floor((body.a.z - reach) / cellSize), Math.floor((body.a.z + reach) / cellSize)];
  };
  const bodies = moving.concat(solid);
  const spans = bodies.map(bounds);
  for (let i = 0; i < bodies.length; i++) {
    const [left, right, bottom, top] = spans[i];
    for (let x = left; x <= right; x++) for (let z = bottom; z <= top; z++) {
      const key = `${x},${z}`;
      const bucket = cells.get(key);
      if (bucket) bucket.push(i);
      else cells.set(key, [i]);
    }
  }
  const pairs = [];
  for (let i = 0; i < moving.length; i++) {
    const [left, right, bottom, top] = spans[i];
    const a = bodies[i], candidates = new Set();
    for (let x = left; x <= right; x++) for (let z = bottom; z <= top; z++)
      for (const j of cells.get(`${x},${z}`) ?? [])
        if (j > i) candidates.add(j);
    for (const j of [...candidates].sort((a, b) => a - b)) {
      const b = bodies[j];
      if (distance(a.a, b.a) <= a.radius + b.radius + a.travel + b.travel + .24)
        pairs.push([a, b]);
    }
  }
  return pairs;
}

function resolveContacts(world, moving, solid) {
  const s = world.pursuit, pairs = s.street ? streetContactPairs(moving, solid) : [];
  if (!s.street) for (const [i, a] of moving.entries()) {
    for (const b of [...moving.slice(i + 1), ...solid]) {
      if (distance(a.a, b.a) <= a.radius + b.radius + a.travel + b.travel + 0.24)
        pairs.push([a, b]);
    }
  }
  let since = 0, playerHit = null;
  // Stop both participants at the first contact, then test the rest of the
  // tick against those stopped poses. Actors never pass through an old/new swap.
  for (let n = 0; n < moving.length; n++) {
    let hit = null;
    for (const [a, b] of pairs) {
      if (a.erased || b.erased || survivalGhostPair(world, a.a, b.a)) continue;
      const found = findContact(a, b, since);
      if (found && (!hit || found.time < hit.time)) hit = found;
    }
    if (!hit) break;
    const { a, b, time, overlapAt } = hit;
    const key = pairId(a.a, b.a);
    if (a.a === world.player || b.a === world.player) {
      const [ego, other] = a.a === world.player ? [a, b] : [b, a];
      if (s.survival?.active?.kind === "giant" && (s.patrols.has(other.a) || s.survival.wrecks.has(other.a))) {
        other.stop = time;
        other.erased = true;
        s.survival.pendingWrecks.set(other.a, { reason: "giant", erased: true });
        continue;
      }
      const impact = contactImpact(ego, other, time, overlapAt, world.tick + 1);
      if (!playerHit || impact.severity > playerHit.severity) playerHit = impact;
      if (!s.contacts.has(key)) {
        const pack = isPackPursuit(s.variant), pedestrian = other.a.type === "pedestrian";
        if (!pack || !s.metrics.terminalCause || (pedestrian && s.metrics.terminalCause !== "pedestrian-impact"))
          s.metrics.impact = impact;
        s.metrics.collisions++;
        if (pedestrian) s.metrics.pedestrianCollisions++;
        if (pack) {
          if (pedestrian) {
            const person = poseAt(other, time), origin = poseAt(ego, time);
            other.a.impact = { tick: impact.tick, heading: headingTo(origin, person),
              closingSpeedMps: impact.closingSpeedMps, sourceId: world.player.id };
            s.metrics.pedestrianStatus = "impact";
            s.metrics.terminalCause = "pedestrian-impact";
            const cost = isCityHunt(s.variant) ? pedestrianImpactCost(impact.closingSpeedMps) : PACK_PENALTIES.pedestrian;
            s.metrics.penalty -= cost;
            if (isCityHunt(s.variant)) s.metrics.pedestrianCost += cost;
          } else if (s.patrols.has(other.a)) {
            s.metrics.policeContacts++;
            s.metrics.terminalCause ??= "police-touch";
            s.metrics.penalty -= PACK_PENALTIES.police;
          } else if (s.survival) {
            s.metrics.terminalCause ??= s.survival.wrecks.has(other.a) ? "police-wreck" :
              other.a.type === "static" ? "street-obstacle" : "traffic-contact";
            s.metrics.penalty -= PACK_PENALTIES.police;
          }
        }
        if (s.survival && s.metrics.terminalCause && !s.survival.contactAt) {
          const body = poseAt(ego, time);
          const normal = normalAt(body, poseAt(other, time));
          const reach = extent(body, normal.x, normal.z) + .08;
          s.survival.contactAt = { x: body.x + normal.x * reach, z: body.z + normal.z * reach };
        }
        logEvent(world, "impact", impact, impact.actorId, impact.tick);
        const patrol = other.a;
        if (!s.street && impact.side === "rear" && impact.closingSpeedMps > 0.2 && patrol.pursuitRole === "police" &&
            patrol.speed > 0.2 && other.stop > time && !patrolHasSupport(world, patrol)) {
          const hitPose = poseAt(other, time);
          patrol.pursuitDrive.reaction = {
            x: hitPose.x, z: hitPose.z, settleUntil: impact.tick + ticks(0.16), backUntil: impact.tick + ticks(1.7),
          };
        }
      }
    } else if (!s.contacts.has(key)) {
      s.metrics.trafficCollisions++;
      if (s.survival) {
        const normal = normalAt(poseAt(a, time), poseAt(b, time));
        if (closingSpeed(a, b, overlapAt, normal) >= 2.6) {
          for (const [current, other] of [[a, b], [b, a]]) if (s.patrols.has(current.a))
            s.survival.pendingWrecks.set(current.a, { reason: s.patrols.has(other.a) ? "patrol" : other.a.kind ?? "contact" });
        }
      }
    }
    s.contacts.add(key);
    if (a.travel && a.stop > time) {
      a.stop = time;
      a.hit = b.a.id;
    }
    if (b.travel && b.stop > time) {
      b.stop = time;
      b.hit = a.a.id;
    }
    // A held ego may be struck by a moving body; preserve its contact reason.
    if (a.a.type !== "static" && !a.hit) a.hit = b.a.id;
    if (b.a.type !== "static" && !b.hit) b.hit = a.a.id;
    since = time;
  }
  return playerHit;
}

function updateClearance(world, playerMotion, bodies) {
  const s = world.pursuit, near = new Set(), touching = new Set();
  const ego = poseAt(playerMotion, 1);
  for (const body of bodies) {
    if (s.street && distance(ego, body.a) >
        playerMotion.radius + body.radius + body.travel + .72) continue;
    const other = poseAt(body, 1);
    if (other.id === ego.id || body.erased || survivalGhostPair(world, world.player, body.a)) continue;
    const key = pairId(ego, other);
    if (overlaps(ego, other, 0.25)) touching.add(key);
    if (s.contacts.has(key) || !overlaps(ego, other, 0.72)) continue;
    const normal = normalAt(ego, other);
    near.add(key);
    if (!s.near.has(key) && closingSpeed(playerMotion, body, 1, normal) > 0.6) {
      s.metrics.nearCollisions++;
      logEvent(world, "near", ego, other.id, world.tick + 1);
    }
  }
  // Non-ego latches clear only after the actual pair separates.
  for (const key of s.contacts) {
    if (touching.has(key)) continue;
    const [a, b] = key.split(":");
    const p = bodies.find((body) => body.a.id === a), q = bodies.find((body) => body.a.id === b);
    if (!p || !q || !overlaps(poseAt(p, 1), poseAt(q, 1), 0.25)) s.contacts.delete(key);
  }
  s.near = near;
}

function motionPlan(world, actor, action, streetHooks) {
  let next, command, guard = "clear";
  if (actor.type === "pedestrian")
    next = streetHooks ? streetHooks.pedestrianMotion(actor) : pedestrianMotion(world, actor);
  else {
    const pack = isPackPursuit(world.pursuit.variant);
    const survival = world.pursuit.survival;
    if (survival?.wrecks.has(actor)) return { a: actor, next: actor, command: { steer: 0, targetSpeed: 0 },
      guard, travel: 0, radius: shapeRadius(actor), stop: 0, hit: null };
    command = actor === world.player ? (pack ? packCommand : pursuitCommand)(actor, action, STEP) :
      !streetHooks || world.pursuit.patrols.has(actor) ? npcCommand(world, actor) : null;
    if (survival && actor === world.player && world.mode === "manual") command.arcadeDrift = true;
    if (streetHooks) command = streetHooks.vehicleCommand(actor, command);
    else if (pack && actor === world.player) command = world.safeSpeed(actor, command, false);
    // The swept solver uses the body shape, not its path, profile and history.
    const pose = usesRushPace(world.pursuit.variant) ? Object.assign(vehicleProbe(actor, actor.speed), {
      id: actor.id, kind: actor.kind, y: actor.y, supportHeightM: actor.supportHeightM,
    }) : null;
    next = integrateVehicle(actor, command, STEP, pose);
    next.reason = command.reason ?? "driving";
    next.blockedBy = command.blockedBy ?? null;
    const roads = streetHooks || actor === world.player ? world.roads : world.drivingRoads;
    if (travel(actor, next) > 0 && !sweepSafe(actor, next, [], roads).safe) {
      guard = "road-boundary";
      next = { ...actor, speed: 0, steer: next.steer, reason: guard, blockedBy: null };
    }
  }
  return { a: actor, next, command, guard, travel: travel(actor, next), radius: shapeRadius(actor), stop: 1, hit: null };
}

function approachingPedestrianDanger(world, car) {
  const speed = Math.abs(car.speed);
  if (speed < 1.4 || speed < Math.abs(car.previous.speed) - .01) return 0;
  const direction = Math.sign(car.speed);
  const sin = Math.sin(car.heading), cos = Math.cos(car.heading);
  const brakingRoom = .8 + speed * .24 + speed ** 2 / 11;
  let danger = 0;
  for (const person of world.actorIndex.near(car, car.length / 2 + brakingRoom + 2)) {
    if (person.type !== "pedestrian") continue;
    const dx = person.x - car.x, dz = person.z - car.z;
    const gap = (dx * sin + dz * cos) * direction - car.length / 2 - person.radius;
    if (gap < -.15 || gap > brakingRoom) continue;
    const side = dx * cos - dz * sin;
    const lateralPace = Math.sin(person.heading - car.heading) * person.speed;
    const predictedSide = side + lateralPace * Math.min(.9, Math.max(0, gap / speed));
    if (side * predictedSide > 0 &&
        Math.min(Math.abs(side), Math.abs(predictedSide)) > car.width / 2 + person.radius + .22) continue;
    danger = Math.max(danger, 1 - Math.max(0, gap) / brakingRoom);
  }
  return danger * STEP;
}

function updatePhase(world, moved, playerHit) {
  const { player: ego, pursuit: s } = world, m = s.metrics;
  const r = s.response;
  if (r) {
    const event = updatePursuitResponse(world);
    if (event) logEvent(world, event, r.lastSeen ?? s.playerStart);
  }
  if (isPackPursuit(s.variant)) {
    const nearSectors = new Set();
    for (const car of r.sightedBy) if (distance(car, ego) <= 22) {
      const angle = angleDelta(headingTo(ego, car), ego.heading);
      nearSectors.add(Math.round(angle / (Math.PI / 2)) & 3);
    }
    m.surroundSectors = nearSectors.size;
    if (m.terminalCause) {
      s.phase = "crashed";
      return;
    }
  }
  const sectors = new Set();
  for (const a of r?.closePatrols ?? world.actors) {
    if (!r && ((s.street ? !s.patrols.has(a) : a.pursuitRole !== "police") || distance(a, ego) >= 7.2)) continue;
    const angle = angleDelta(headingTo(ego, a), ego.heading) + Math.PI;
    sectors.add(Math.floor((angle + Math.PI / 6) / (Math.PI / 3)) % 6);
  }
  let surrounded = false;
  for (const a of sectors) for (const b of sectors) {
    const separation = Math.abs(a - b);
    if (separation >= 2 && separation <= 4) surrounded = true;
  }
  m.capturePressureS = Math.abs(ego.speed) < 0.8 && surrounded
    ? m.capturePressureS + STEP : Math.max(0, m.capturePressureS - STEP * 2);
  if (m.pedestrianCollisions || (playerHit && playerHit.severity >= 0.44)) {
    s.phase = "crashed";
  } else if (m.capturePressureS >= 2.1) {
    s.phase = "captured";
  } else if (r && !s.packLab ? r.clearProgress >= 1 : moved > 0.001 && m.distanceM >= 8 && distance(ego, s.playerStart) >= 6 &&
      s.exits.some((point) => distance(ego, point) <= 2.6 &&
        (!s.street || Math.abs(angleDelta(ego.heading, point.heading)) <= 0.55))) {
    m.escape = true;
    s.phase = "escaped";
  } else if (!s.survival && m.survivalS >= (s.packLab ? 22 : TIERS[s.level - 1].durationS + (r ? 32 : 0))) {
    s.phase = "timeout";
  }
}

export function stepPursuit(world, action, streetHooks = null) {
  const { player, pursuit: s } = world;
  if (s?.phase !== "running") return;
  const requested = { ...validatePursuitAction(action) };
  if (!s.street) streetHooks = null;
  else if (typeof streetHooks?.vehicleCommand !== "function" ||
      typeof streetHooks?.pedestrianMotion !== "function")
    throw new TypeError("Street pursuit requires city vehicleCommand and pedestrianMotion hooks");
  s.startedTick ??= world.tick;
  if (s.survival) updateSurvivalBeforeMotion(world);
  updateEvents(world);
  world.actorIndex = new SpatialIndex(world.actors);
  for (const a of world.actors) a.previous = copyPose(a);
  const plans = world.actors.map((a) => motionPlan(world, a, requested, streetHooks));
  const ego = plans.find((p) => p.a === player);
  const solids = world.statics.map((a) => ({ a, next: a, travel: 0, stop: 0, radius: shapeRadius(a) }));
  const impact = resolveContacts(world, plans, solids);
  updateClearance(world, ego, [...plans, ...solids]);
  const m = s.metrics;
  if (isPackPursuit(s.variant) && m.pedestrianStatus !== "impact") {
    const blocker = ego.command.blockedBy && world.actorIndex.near(player, 24).find(actor =>
      actor.type === "pedestrian" && actor.id === ego.command.blockedBy);
    if (blocker && ego.command.reason === "yielding") {
      s.yieldingFor = blocker;
      m.pedestrianStatus = "yielding";
      m.firstYieldTick ??= world.tick + 1;
    } else if (s.yieldingFor && ego.stop === 1 && ego.next.speed > .5) {
      const walking = plans.find(plan => plan.a === s.yieldingFor);
      if (walking) {
        const person = poseAt(walking, 1), { x, z, heading } = ego.next;
        const cos = Math.cos(heading), sin = Math.sin(heading);
        const dx = person.x - x, dz = person.z - z;
        const side = dx * cos - dz * sin;
        const walkingSide = (person.x - walking.a.x) * cos - (person.z - walking.a.z) * sin;
        const behind = dx * sin + dz * cos < -player.length / 2 - person.radius;
        const leavingCorridor = Math.abs(side) > player.width / 2 + person.radius + .25 &&
          side * walkingSide >= -1e-5;
        if (behind || leavingCorridor) {
          s.yieldingFor = null;
          m.pedestrianStatus = "clear";
          m.firstClearTick ??= world.tick + 1;
        }
      }
    }
  }
  m.guard = impact ? "contact" : ego.guard;
  m.requestedAction = requested;
  s.action = ego.guard === "road-boundary" ? { ...requested, throttle: 0, brake: 1 } : requested;
  let moved = 0;
  for (const p of plans) {
    const a = p.a, accepted = poseAt(p, 1);
    const next = usesRushPace(s.variant) && p.a !== accepted ? accepted : { ...accepted };
    const acceptedDistance = distance(a, next);
    if (p.hit) Object.assign(next, { speed: 0, reason: "contact", blockedBy: p.hit });
    if (a.type === "pedestrian") {
      next.accelerationMps2 = (next.speed - a.speed) / STEP;
      next.motionTimeS = (world.tick + 1) * STEP;
    } else if (!s.street) {
      next.y = next.supportHeightM = heightOnSupport(s, next);
    }
    if (s.street && a.type === "vehicle") {
      const sources = p.command.districtSources ?? a.districtSources;
      if (sources) next.districtSources = p.hit || p.guard !== "clear"
        ? { ...sources, finalMps: 0, appliedSource: "physical-guard" }
        : sources;
    }
    if (a === player) {
      moved = acceptedDistance;
      const blocked = ego.guard === "road-boundary";
      const applied = !blocked ? p.command : s.street
        ? { ...p.command, targetSpeed: 0, reason: p.guard }
        : pursuitCommand(a, s.action, STEP);
      if (s.street || s.packLab) s.appliedCommand = { steer: applied.steer, targetSpeed: applied.targetSpeed,
        reason: applied.reason ?? null, blockedBy: applied.blockedBy ?? null,
        ...(applied.decelerationMps2 === undefined ? {} : { decelerationMps2: applied.decelerationMps2 }) };
      next.vehicle = advanceVehicleState(a, next, applied, STEP, {
          tick: world.tick + 1,
          contact: impact ? { ...impact, hitId: impact.actorId, proposedTravelM: distance(a, p.next) } : null,
        });
      const height = next.supportHeightM ?? 0;
      if (m.supportHeightM < 0.045 && height >= 0.045) m.shoulderEntries++;
      if (m.supportHeightM >= 0.045 && height < 0.045) m.shoulderExits++;
      m.supportHeightM = height;
      m.maxSupportHeightM = Math.max(m.maxSupportHeightM, height);
      if (blocked && a.reason !== "road-boundary") world.metrics.interventions++;
    }
    Object.assign(a, next, {
      distance: a.distance + acceptedDistance,
      wait: acceptedDistance < 0.001 ? a.wait + STEP : 0,
    });
  }
  world.tick++;
  world.metrics.distance += moved;
  if (moved < 0.001 && world.mode === "auto" && (!s.street || player.path.length))
    world.metrics.waitSeconds += STEP;
  m.distanceM += moved;
  if (isCityHunt(s.variant) && moved > .002 && !impact)
    m.pedestrianDanger += approachingPedestrianDanger(world, player);
  m.survivalS = (world.tick - s.startedTick) * STEP;
  if (s.survival) {
    if (m.terminalCause && impact) emitSurvival(world, "impact", s.survival.contactAt ?? impact, m.terminalCause);
    updateSurvivalAfterMotion(world);
  }
  updatePhase(world, moved, impact);
  if (isPackPursuit(s.variant) && (s.phase === "crashed" || s.phase === "captured")) {
    s.reviewUntilTick = world.tick + (s.survival ? SURVIVAL_REVIEW_TICKS : PACK_REVIEW_TICKS);
    s.endedTick = world.tick;
    logEvent(world, s.phase, player);
    for (const a of world.actors) a.previous = copyPose(a);
    world.actorIndex = new SpatialIndex(world.actors);
  } else if (s.street && s.phase !== "running") cleanupStreetPursuit(world);
  else world.actorIndex = new SpatialIndex(world.actors);
  world.updateSensors(world.tick % 6 === 0);
  if (s.street) return { distanceM: moved, impact };
}

function boundedDecision(value, depth = 0) {
  if (typeof value === "string") return value.slice(0, 300);
  if (value === null || typeof value === "boolean" || Number.isFinite(value)) return value;
  if (!value || typeof value !== "object" || depth >= 6) return null;
  if (Array.isArray(value)) return value.slice(0, 64).map((v) => boundedDecision(v, depth + 1));
  return Object.fromEntries(Object.entries(value).slice(0, 32)
    .map(([key, v]) => [key, boundedDecision(v, depth + 1)]));
}

export function pursuitSnapshot(world) {
  const s = world.pursuit;
  return {
    level: s.level, caseId: s.caseId, phase: s.phase,
    events: s.events.map((e) => ({ ...e })), metrics: structuredClone(s.metrics),
    action: s.action ? { ...s.action } : null,
    decision: boundedDecision(s.decision), exits: s.exits.map((e) => ({ ...e })),
    ...(usesRushPace(s.variant) ? { variant: s.variant, targetPatrols: s.targetPatrols } : {}),
    ...(isRushPack(s.variant) ? { wantedLevel: s.wantedLevel, learning: s.learner?.snapshot() ?? null } : {}),
    ...(isPackPursuit(s.variant) ? { pack: true, packLab: s.packLab === true, driver: s.driver,
      review: s.reviewUntilTick > world.tick } : {}),
    ...(s.response ? { response: pursuitResponseSnapshot(s.response) } : {}),
    ...(s.survival ? { survival: survivalSnapshot(s, world.tick) } : {}),
    ...(s.street ? { street: true, startedTick: s.startedTick, endedTick: s.endedTick,
      appliedCommand: s.appliedCommand ? { ...s.appliedCommand } : null } : {}),
  };
}
