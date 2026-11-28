import { PEOPLE_MODELS, STEP, VEHICLE, clamp } from "./config.js";
import { sampleCitySurface } from "./city-surfaces.js";
import { recordCityPropImpact } from "./city-props.js";
import { arcadePatrolLimit, initializeDistrictActor, isPackPursuit, isRushPack, rushRoadLimit, usesRushPace } from "./district-behavior.js";
import { planDistrictRoute } from "./district-navigation.js";
import { createPackDrill, PACK_DRILLS } from "./pack-drills.js";
import { assignGtaSquad, gtaSpacingSteer, packApproach, packRamAim, packSpawnBias, packTactic } from "./pack-patrol.js";
import { packCommand, PACK_PENALTIES, pedestrianImpactCost } from "./pack-driving.js";
import { districtRoadPose } from "./egypt-district.js";
import {
  angleDelta, bodyOnRoad, corners, distance, interpolate, isDiagonalRoad, overlaps,
  pointOnRoad, roadFrame, roadIntersection, roadPointAt, roadPoseAt, roadProject, roadRect, sweepSafe,
} from "./geometry.js";
import { createRoadGraph, lanePath, planNavigation, LANE_OFFSET } from "./navigation.js";
import { createPedestrianBody } from "./pedestrian-body.js";
import { createPedestrian, isCrowdAheadPedestrian, pedestrianMotion, registerCrowdAheadRoute } from "./pedestrian.js";
import {
  NITRO_SPEC,
  buildNitroBoostPose,
  isNitroEngaged,
  pursuitCommand,
  stepNitroTank,
  validatePursuitAction,
} from "./pursuit-controls.js";
import { isDispatchTracked } from "./pursuit-dispatch.js";
import { timedCivilianYield } from "./pako-civilian-yield.js";
import {
  aggressiveDeploymentBounds, aggressiveInitialSpeed, isAggressiveChase,
  recycleTrailingChasePatrols, scoreAggressiveDeploymentSlots,
} from "./pako-aggressive-police.js";
import {
  METRO_CITY_CURBS, acceptCurbPose, curbClearance, curbCommand, nearCurb, surveyMetroCurb, sweepSafeWithCurbs,
} from "./pako-curb.js";
import { patrolChainYield, patrolLateralYield, PATROL_LATERAL_YIELD } from "./pako-patrol-yield.js";
import {
  CITY_FAIR_POLICE, canDrivePrivilegedDirect, canPatrolUseCurbPrivilege, isFairCityPolice, isTacticalPursuit,
  planTacticalInterceptAim, resolveTacticalRoadAim, tacticalSquadCap, tacticalTrafficOvertake,
} from "./pako-tactical-police.js";
import {
  advanceEscapeGoalIfReached, escapeGoalSnapshot, selectFarEscapeGoal,
} from "./pursuit-escape-goal.js";
import { dispatchJunctionStillRelevant, dispatchRoadblockDetour, selectDispatchJunction } from "./dispatch-junctions.js";
import {
  CIVILIAN_TIMED_YIELD, DISPATCH_DAMAGE_FEEDBACK, GTA_MAX_SPEED, GTA_PATROL_PROFILES, GTA_PIN_SECONDS,
  applyGtaContact, clearCivilianGtaSlips, consumeGtaPlayerScrape, emitGtaEvent, gtaLocal, gtaOffset, gtaPatrolCommand, gtaPreviewLateralPush, gtaRearPushSpeed,
  hasCivilianGtaSlip, initializeGtaDurability, initializeGtaPatrol, initializeGtaPursuit, integrateCivilianGtaSlip, integrateGtaSlip, isGtaStationary,
  resolveGtaChaseConfig, setCivilianGtaImpulse, trackGtaPatrolProgress, updateGtaPhase,
} from "./pursuit-gta.js";
import {
  WHEEL_SCRUB_MODE,
  computeCurbWheelScrub,
  stepActorImpactReaction,
} from "./wheel-interaction-physics.js";
import { createPursuitResponse, gtaDeploymentHidden, gtaInSight, gtaLineClear, pursuitResponseSnapshot,
  updatePursuitResponse } from "./pursuit-response.js";
import {
  SURVIVAL_REVIEW_TICKS, createSurvival, emitSurvival, isCityHunt, isSurvival, releaseSurvival,
  survivalGhostPair, survivalSnapshot, updateSurvivalBeforeMotion, updateSurvivalAfterMotion,
} from "./pursuit-survival.js";
import { Random } from "./random.js";
import { SpatialIndex } from "./spatial-index.js";
import {
  followPath,
  integrateVehicle,
  markImmutablePath,
  vehicleProbe,
  clearVehicleMotion,
  copyVehicleMotion,
} from "./vehicle.js";
import { KING_LONG_MICROBUS, playerVehicleDimensions } from "./vehicle-spec.js";
import { advanceVehicleState } from "./vehicle-state.js";
import { PursuitScanner, PURSUIT_SCAN_TICKS } from "../signal_processing/pursuit-scanner.js";

export { GtaChaseConfig } from "./pursuit-gta.js";

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
    status: {
      phase: "ready",
      variant: options.pursuitVariant ?? "legacy",
      wantedLevel: level,
      nitroCharge: 1,
      nitroActive: false,
      nitroIntensity: 0,
      nitroSuppressedByPedestrian: false,
      crowdAheadCount: 0,
    },
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
  if (isDiagonalRoad(r)) return roadPointAt(r, along, lateral);
  return r.axis === "z" ? { x: r.fixed - lateral, z: along } : { x: along, z: r.fixed + lateral };
}

function addPerson(world, data) {
  const { rng } = world.pursuit;
  const r = world.drivingRoads[data.road];
  const start = sidewalkPose(r, data.along, data.side);
  if (data.started) {
    // At the approach to the lane, not occupying the ego's initial shape.
    if (isDiagonalRoad(r)) {
      const inner = roadPointAt(r, data.along, data.side * (r.width / 2 - 0.4));
      start.x = inner.x;
      start.z = inner.z;
    } else if (r.axis === "z") start.x = r.fixed - data.side * (r.width / 2 - 0.4);
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
  syncPursuitStatus(world, state);
}

const roadAlong = (road, point) => isDiagonalRoad(road) ? roadProject(road, point).along : point[road.axis];

function lanePoint(lane, along) {
  const clamped = clamp(along, lane.low, lane.high);
  if (isDiagonalRoad(lane.road)) {
    return { ...roadPoseAt(lane.road, clamped, lane.sign), roadId: lane.road.id };
  }
  return { ...districtRoadPose(lane.road, clamped, lane.sign),
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

function deploymentSlots(state, ego, tactic, minRange = 13, maxRange = STREET_DEPLOY_RANGE_M) {
  const sin = Math.sin(ego.heading), cos = Math.cos(ego.heading);
  const slots = [];
  for (const lane of state.lanes) {
    const along = roadAlong(lane.road, ego);
    const low = Math.max(lane.low, along - maxRange);
    const high = Math.min(lane.high, along + maxRange);
    for (let at = low; at <= high; at += 3.5) {
      const position = lanePoint(lane, at);
      const range = distance(ego, position);
      if (range < minRange || range > maxRange) continue;
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

function setStreetPatrolPath(state, car, aim, fallback = null, lanes = state.lanes) {
  const goals = lanes.map((lane) => lanePoint(lane, roadAlong(lane.road, aim)));
  goals.sort((a, b) => distance(a, aim) - distance(b, aim));
  const maxGoals = isTacticalPursuit(state) ? 2 : (fallback ? 3 : 4);
  const nearbyGoals = goals.slice(0, maxGoals);
  if (fallback) nearbyGoals.push(fallback);
  for (const goal of nearbyGoals) {
    const path = planDistrictRoute(state.patrolMap, car, goal);
    if (path.length < 3) continue;
    const length = path.reduce((total, point, i) => i ? total + distance(path[i - 1], point) : 0, 0);
    if (length > Math.max(30, distance(car, goal) * 2.5 + 15)) continue;
    for (const point of path) Object.freeze(point);
    car.path = Object.freeze(path);
    car.cursor = 0;
    if (car.pursuitDrive) car.pursuitDrive.target = goal;
    return true;
  }
  return false;
}

function patrolReach(lane, car) {
  const along = roadAlong(lane.road, car);
  return (lane.sign > 0 ? lane.high - along : along - lane.low);
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
    const aheadAlong = roadAlong(lane.road, ahead);
    for (const inset of [8, 15, 23]) {
      const pose = lanePoint(lane, aheadAlong - lane.sign * inset);
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
    const pose = lanePoint(candidate, roadAlong(candidate.road, aim));
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
      const alternative = lanePoint(candidate, roadAlong(candidate.road, pose) + candidate.sign * offset);
      if (distance(alternative, pose) >= 6 && distance(alternative, player) <= 23)
        goals.push({ pose: alternative });
    }
  }
  if (lane && patrolReach(lane, car) >= 8)
    goals.push({ pose: lanePoint(lane, roadAlong(lane.road, car) + lane.sign * 21) });
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

function newGtaPatrol(world, state, unitType) {
  const id = `street-pursuit-${state.run}-gta-${++state.gta.serial}`;
  const { x, z, heading } = world.player;
  const car = world.makeVehicle(id, GTA_PATROL_PROFILES[unitType].kind, { x, z, heading }, state.rng);
  initializeGtaPatrol(car, unitType, state);
  car.gtaAI.lanes = streetLanes(world.drivingRoads, car);
  return car;
}

function registerGtaPatrol(world, state, car) {
  initializeDistrictActor({ environment: world.environment, rng: state.rng }, car);
  car.district.nextLoadingDistanceM = Infinity;
  car.previous = copyPose(car);
  state.patrols.add(car);
  world.actors.push(car);
  if (world.pursuit === state) logEvent(world, "reinforcement", car, car.id);
  return car;
}

function visibleGtaDeployment(world, state, position) {
  const initialCallout = world.pursuit !== state && state.patrols.size === 0;
  const verifiedOpeningVanguard =
    world.tick === state.startedTick &&
    (state.response?.unitsInContact ?? 0) > 0;
  if (state.gta.config.ruleset !== "dispatch-v1" || initialCallout || verifiedOpeningVanguard) return false;
  if (isTacticalPursuit(state)) {
    return distance(world.player, position) < 26 ||
      (distance(world.player, position) < 55 && !gtaDeploymentHidden(world, world.player, position));
  }
  if (isAggressiveChase(state)) return distance(world.player, position) < 18;
  return !gtaDeploymentHidden(world, world.player, position);
}

function openingTravel(speed, acceleration, cap) {
  const seconds = 4;
  const limitedSpeed = clamp(speed, 0, cap);
  const accelerating = Math.min(seconds, (cap - limitedSpeed) / acceleration);
  return limitedSpeed * accelerating + acceleration * accelerating ** 2 / 2 +
    cap * (seconds - accelerating);
}

function deployGtaPatrol(world, state, tactic, unitType, forwardOnly = false) {
  if (isFairCityPolice(state)) {
    // Fair patrol identities are created once, before the pursuit becomes live. They are never
    // replaced later; only their fixed opening beats are chosen more tactically here.
    if (world.pursuit === state) return null;
    const car = newGtaPatrol(world, state, unitType);
    const lanes = car.gtaAI.lanes.filter(lane => lane.high - lane.low >= 45);
    const player = world.player;
    const setOpeningBeat = lane => {
      const a = lanePoint(lane, lane.low + 8);
      const b = lanePoint(lane, lane.high - 8);
      car.gtaAI.beat = { roadId: lane.road.id, a, b, target: lane.sign > 0 ? b : a };
      car.aiState = "PATROL";
      car.speed = aggressiveInitialSpeed(car, true, state.wantedLevel);
      return registerGtaPatrol(world, state, car);
    };

    if (isAggressiveChase(state) && state.wantedLevel >= 3 &&
        (state.gta.pressure || playerVehicleDimensions(player) !== KING_LONG_MICROBUS)) {
      const bounds = aggressiveDeploymentBounds(state, true);
      const slots = deploymentSlots({ lanes }, player, tactic, bounds.minRange, bounds.maxRange);
      scoreAggressiveDeploymentSlots(world, state, car, player, slots, tactic, true, forwardOnly);
      for (const { lane, position, score } of slots) {
        if (!Number.isFinite(score)) break;
        if (state.gta.pressure) {
          const rel = gtaLocal(player, position);
          const opposing = Math.cos(angleDelta(position.heading, player.heading)) < -.65;
          if (opposing && rel.forward > 0 && rel.forward < 54 && Math.abs(rel.right) < 3) continue;
        }
        Object.assign(car, position);
        if (!isFree(world, car, .65) || !bodyOnRoad(car, world.drivingRoads) ||
            [...state.patrols].some(other => distance(other, car) < 17.5) ||
            (state.patrols.size < 2 && !gtaInSight({ ...world, pursuit: state }, car, player))) continue;
        return setOpeningBeat(lane);
      }
    }

    const openingBeat = car.gtaAI.order === 1
      ? lanes.find(lane => lane.road.id === "tahrir-boulevard" && lane.sign === 1) : null;
    for (let n = 0; n < lanes.length; n++) {
      const lane = n === 0 && openingBeat ? openingBeat : lanes[(car.gtaAI.order * 17 + n) % lanes.length];
      for (const fraction of lane === openingBeat ? [.23, .35, .65] : [.35, .65, .5]) {
        const position = lanePoint(lane, lane.low + (lane.high - lane.low) * fraction);
        Object.assign(car, position);
        if (!isFree(world, car, 1) || !bodyOnRoad(car, world.drivingRoads) ||
            [...state.patrols].some(other => distance(other, car) < 17.5)) continue;
        return setOpeningBeat(lane);
      }
    }
    return null;
  }
  const initialAmbientBeatUnit =
    world.pursuit !== state &&
    state.patrols.size === 0 &&
    (state.response?.unitsInContact ?? 0) === 0;
  if (
    isTacticalPursuit(state) &&
    !initialAmbientBeatUnit &&
    (!isDispatchTracked(state.response) || (state.response?.unitsInContact ?? 0) === 0)
  )
    return null;
  const car = newGtaPatrol(world, state, unitType);
  const player = world.player;
  const opening =
    state.gta.config.ruleset === "dispatch-v1" &&
    (world.pursuit !== state ||
      (world.tick === state.startedTick &&
        (state.response?.unitsInContact ?? 0) > 0));
  const distantBeatPatrol = initialAmbientBeatUnit && isTacticalPursuit(state);
  if (isAggressiveChase(state)) {
    const bounds = aggressiveDeploymentBounds(state, opening);
    const rangesToTry = distantBeatPatrol
      ? [{ minRange: Math.max(bounds.minRange, 66.5), maxRange: 109.5, requireSight: true }]
      : [bounds];
    for (const { minRange, maxRange, requireSight } of rangesToTry) {
      const slots = deploymentSlots({ lanes: car.gtaAI.lanes }, player, tactic, minRange, maxRange);
      scoreAggressiveDeploymentSlots(world, state, car, player, slots, tactic, opening, forwardOnly);
      for (const { position, score } of slots) {
        if (!Number.isFinite(score)) break;
        Object.assign(car, position);
        if (
          visibleGtaDeployment(world, state, car) ||
          !isFree(world, car, .65) ||
          !bodyOnRoad(car, world.drivingRoads) ||
          (requireSight && !gtaInSight({ ...world, pursuit: state }, car, player))
        )
          continue;
        car.speed = aggressiveInitialSpeed(car, opening, state.wantedLevel);
        return registerGtaPatrol(world, state, car);
      }
    }
    return null;
  }
  // The old 18 m preferred slot can put a fast interceptor into a stationary
  // player's bumper before the car has reached a junction or maneuvering speed.
  const berth = opening ? Math.min(46, 35 + .55 * Math.abs(player.speed)) : 0;
  const slots = deploymentSlots(
    { lanes: car.gtaAI.lanes },
    player,
    tactic,
    distantBeatPatrol ? Math.max(66.5, state.gta.config.minSpawnRadius, berth) : Math.max(state.gta.config.minSpawnRadius, berth),
    distantBeatPatrol ? 109.5 : opening ? 66 : STREET_DEPLOY_RANGE_M,
  );
  const others = [...state.patrols];
  const openingRoad = opening && ((!others.length && tactic === "tail") || state.wantedLevel >= 4) &&
    world.drivingRoads.find(road => !road.parkingBay && !road.supportApron &&
      Math.abs(Math.cos(angleDelta(roadFrame(road).heading, player.heading))) > .707 &&
      pointOnRoad(player, [road]));
  const approach = openingRoad && !others.length && tactic === "tail";
  const reactionRoom = openingRoad && state.wantedLevel >= 4 &&
    openingTravel(player.speed, player.spec?.acceleration ?? VEHICLE.acceleration, GTA_MAX_SPEED) +
    (player.length + car.length) / 2;
  const approachTravel = reactionRoom ? openingTravel(2, car.spec.acceleration, car.maxSpeed) : 0;
  for (const slot of slots) {
    const { forward, right } = gtaLocal(player, slot.position);
    if (forwardOnly && forward <= 0) { slot.score = Infinity; continue; }
    if (forwardOnly) slot.score += 10 * (1 - Math.cos(angleDelta(slot.position.heading, player.heading)));
    if (tactic === "flank") {
      const side = car.gtaAI.order % 2 ? -1 : 1;
      slot.score += .3 * Math.abs(forward) + (right * side < 0 ? 13 : 0);
    }
    if (reactionRoom && forward > 0 && slot.lane.road.id === openingRoad.id) {
      const opposing = -Math.cos(angleDelta(slot.position.heading, player.heading));
      // Do not open with a head-on unit already inside the launch reaction window.
      if (opposing > .5 && forward < reactionRoom + approachTravel * opposing) {
        slot.score = Infinity;
        continue;
      }
    }
    if (approach) {
      const { road, sign } = slot.lane;
      const sameLane = road.id === openingRoad.id && forward < 0 && Math.abs(right) < 3 &&
        Math.abs(angleDelta(slot.position.heading, player.heading)) < .4;
      let joinsBehind = false;
      if (road.id !== openingRoad.id && forward < 0) {
        const hit = roadIntersection(road, openingRoad, 0.5);
        if (hit) joinsBehind = (hit.alongA - roadAlong(road, slot.position)) * sign > 0;
      }
      if (!sameLane && !joinsBehind) slot.score += 45;
    }
    for (const other of others) slot.score += Math.max(0, 13 - distance(other, slot.position)) * .9;
  }
  slots.sort((a, b) => a.score - b.score);
  for (const { position, score } of slots) {
    if (!Number.isFinite(score)) break;
    Object.assign(car, position);
    if (visibleGtaDeployment(world, state, car) ||
        !isFree(world, car, .65) ||
        !bodyOnRoad(car, world.drivingRoads) ||
        (distantBeatPatrol && (distance(player, car) < 66.5 || !gtaInSight({ ...world, pursuit: state }, car, player)))) continue;
    car.speed = Math.min(2, car.maxSpeed);
    return registerGtaPatrol(world, state, car);
  }
  return null;
}

function gtaPatrolCount(state) {
  let count = 0;
  for (const unit of state.patrols) if (unit.aiState !== "WRECKED") count++;
  return count;
}

function gtaPatrolTarget(state) {
  const { maxActivePatrols } = state.gta.config;
  if (isTacticalPursuit(state)) return tacticalSquadCap(state.wantedLevel, maxActivePatrols);
  return Math.min(maxActivePatrols, [0, 3, 5, 7, 9, maxActivePatrols][state.wantedLevel]);
}

function fillGtaPatrols(world, state, count) {
  const target = gtaPatrolTarget(state), star = state.wantedLevel;
  const squad = [...state.patrols].filter(unit => unit.aiState !== "WRECKED");
  const fast = squad.filter(unit => unit.unitType === "interceptor").length;
  const heavy = squad.filter(unit => unit.unitType === "swat").length;
  let fastNeeded = star >= 3 ? Math.max(0, Math.min(star - 1, Math.floor(target / 2)) - fast) : 0;
  let heavyNeeded = state.gta.config.enableSwat && star >= 4
    ? Math.max(0, Math.min(star - 3, Math.floor(target / 3)) - heavy) : 0;
  for (let i = 0; i < count; i++) {
    const unitType = heavyNeeded > 0 ? "swat" : fastNeeded > 0 ? "interceptor" : "patrol";
    const tactic = RUSH_TACTICS[(squad.length + i) % RUSH_TACTICS.length];
    const spawned = deployGtaPatrol(world, state, tactic, unitType) ??
      (unitType !== "patrol" ? deployGtaPatrol(world, state, tactic, "patrol") : null);
    if (spawned?.unitType === "swat") heavyNeeded--;
    if (spawned?.unitType === "interceptor") fastNeeded--;
  }
}

function removeGtaPatrol(world, state, car) {
  state.patrols.delete(car);
  state.response?.sightedBy.delete(car);
  state.response?.closePatrols.delete(car);
  const index = world.actors.indexOf(car);
  if (index >= 0) world.actors.splice(index, 1);
}

function gtaRoadblocksEnabled(state) {
  return !state.gta.pressure && state.wantedLevel >= 3 && state.gta.config.enableRoadblocks && gtaPatrolTarget(state) >= 3;
}

function placeGtaRoadblock(world) {
  const { pursuit: s, player, tick } = world, { gta } = s;
  if (!gtaRoadblocksEnabled(s) || gta.roadblock || tick < gta.nextRoadblockTick) return;
  const coordinated = gta.config.ruleset === "dispatch-v1";
  const report = coordinated ? s.response.lastSeen : player;
  if (coordinated && (tick === s.startedTick || !isDispatchTracked(s.response) ||
      report?.tick !== tick || report.speed < 3)) return;
  gta.nextRoadblockTick = tick + ticks(1.1);
  const needed = Math.max(0, gtaPatrolCount(s) + 2 - gtaPatrolTarget(s));
  if (needed && coordinated) return;
  const spare = [...s.patrols].filter(car => !isGtaStationary(car) && !s.response.sightedBy.has(car) &&
      distance(player, car) > gta.config.minSpawnRadius + 5)
    .sort((a, b) => distance(player, b) - distance(player, a)).slice(0, needed);
  if (spare.length !== needed) return;
  const cars = [newGtaPatrol(world, s, "patrol"), newGtaPatrol(world, s,
    gta.config.enableSwat && s.wantedLevel >= 4 ? "swat" : "patrol")];
  const barrier = { id: `street-pursuit-${s.run}-gta-barrier-${gta.serial}`, type: "static", kind: "barrier",
    width: 1.35, length: s.wantedLevel >= 4 ? .95 : .65, height: .75, gtaRoadblock: true };
  const shapes = [...cars, barrier];
  const sin = Math.sin(report.heading), cos = Math.cos(report.heading);
  const avenues = world.drivingRoads.filter(road => road.width >= 12 && !road.parkingBay && !road.supportApron)
    .map(road => {
      const f = roadFrame(road), proj = roadProject(road, report);
      return { road, align: f.ux * sin + f.uz * cos, away: proj.absLateral, reportAlong: proj.along };
    })
    .filter(({ road, align, away }) => coordinated ? Math.abs(align) > .86 && away < road.width / 2
      : Math.abs(align) > .62 && away < 18)
    .sort((a, b) => a.away - b.away);
  const spacing = gta.rngSide ??= s.rng.next() < .5 ? 1 : -1;
  const occupied = coordinated ? [...s.closures.keys(), ...world.actors.filter(actor => actor !== player)] : [];
  let detourChecks = 0;
  const maxDetourChecks = isTacticalPursuit(s) ? 2 : Infinity;
  for (const { road, align, reportAlong } of avenues) {
    if (detourChecks >= maxDetourChecks) break;
    const sign = Math.sign(align);
    if (road.flow && road.flow !== sign) continue;
    const maxFront = gta.config.minSpawnRadius + (coordinated ? 58 : 34);
    for (let front = gta.config.minSpawnRadius + 9; front <= maxFront; front += 4) {
      if (detourChecks >= maxDetourChecks) break;
      const along = reportAlong + sign * front;
      if (along < road.min + 5 || along > road.max - 5) continue;
      const center = isDiagonalRoad(road)
        ? roadPoseAt(road, along, sign, 0)
        : districtRoadPose({ ...road, laneOffsetM: 0 }, along, sign);
      Object.assign(cars[0], gtaOffset(center, 0, -spacing * 3.1), { heading: center.heading + spacing * .72 });
      Object.assign(cars[1], gtaOffset(center, 1.9, spacing * 3.1), { heading: center.heading - spacing * .74 });
      Object.assign(barrier, gtaOffset(center, -1.6), { heading: center.heading, roadId: road.id });
      if (shapes.some((body, i) => visibleGtaDeployment(world, s, body) || distance(player, body) <= gta.config.minSpawnRadius ||
        gtaLocal(player, body).forward <= 0 || !bodyOnRoad(body, [road]) || !isFree(world, body, .5) ||
        shapes.slice(i + 1).some(other => overlaps(body, other, .5)))) continue;
      detourChecks++;
      const detour = coordinated ? dispatchRoadblockDetour(s.patrolMap,
        { ...vehicleProbe(player, report.speed), ...report }, road, sign, along,
        [...occupied, ...shapes]) : null;
      if (coordinated && !detour) continue;
      const expires = tick + ticks([0, 0, 0, 14, 11, 8][s.wantedLevel]);
      if (!registerBarrier(world, barrier, "roadblock", expires)) continue;
      for (const old of spare) removeGtaPatrol(world, s, old);
      for (const car of cars) {
        Object.assign(car, { gtaRoadblock: true, aiState: "ROADBLOCK", squadRole: "ROADBLOCK", speed: 0 });
        registerGtaPatrol(world, s, car);
      }
      gta.roadblock = { cars, barrier, expires, ...(detour ? { detour } : {}) };
      gta.nextRoadblockTick = expires;
      return;
    }
  }
}

function updateCityPackPressure(world, reassign) {
  const { pursuit: s, tick } = world, { pressure } = s.gta;
  if (!pressure) return;
  const { unitsInContact, lastSeen, sightedBy } = s.response;
  if (!unitsInContact || lastSeen?.tick !== tick || s.wantedLevel < 4) {
    pressure.contactTicks = pressure.stage = 0;
    pressure.relays.clear();
    return;
  }
  pressure.contactTicks++;
  const stage = s.wantedLevel === 5 && pressure.contactTicks >= ticks(5) ? 2 :
    pressure.contactTicks >= ticks(1.25) ? 1 : 0;
  if (!reassign && stage === pressure.stage) return;
  pressure.stage = stage;
  const { relays } = pressure;
  relays.clear();
  if (!stage) return;

  const candidates = [...s.patrols].filter(unit => !sightedBy.has(unit) && !isGtaStationary(unit) &&
    unit.aiState !== "RECOVER" && distance(unit, lastSeen) <= 120);
  // Use cars already on roads around the report, spread across different approach slots.
  candidates.sort((a, b) => distance(a, lastSeen) - distance(b, lastSeen) || a.gtaAI.order - b.gtaAI.order);
  const slots = [4, 5, 3, 6];
  for (const slot of slots.slice(0, stage * 2)) {
    const side = slot === 4 || slot === 6 ? -1 : 1;
    const match = candidates.findIndex(unit => gtaLocal(lastSeen, unit).right * side > 0);
    const [unit] = candidates.splice(Math.max(0, match), 1);
    if (!unit) break;
    const aim = planTacticalInterceptAim(world, unit, lastSeen, slot);
    relays.set(unit, aim);
  }
}

function maintainGtaSquad(world) {
  const { pursuit: s, tick, player } = world, { gta } = s;
  if (isFairCityPolice(s)) {
    const reassign = tick >= gta.nextSquadTick && Boolean(s.response.lastSeen);
    if (reassign) {
      assignGtaSquad(s.patrols, s.response.lastSeen);
      gta.nextSquadTick = tick + ticks(.5);
    }
    updateCityPackPressure(world, reassign);
    return;
  }
  const coordinated = gta.config.ruleset === "dispatch-v1";
  for (const car of s.patrols) if (car.wreckUntilTick <= tick) removeGtaPatrol(world, s, car);
  if (gta.roadblock?.expires <= tick) {
    const { cars, barrier } = gta.roadblock;
    for (const car of cars) if (car.aiState !== "WRECKED") removeGtaPatrol(world, s, car);
    const index = world.statics.indexOf(barrier);
    if (index >= 0) world.statics.splice(index, 1);
    s.closures.delete(barrier);
    releaseStreetStatics(world);
    s.patrolMap.statics = world.statics;
    world.staticIndex = new SpatialIndex(world.statics);
    gta.roadblock = null;
  }
  const tacticalNoContact = isTacticalPursuit(s) && (s.response?.unitsInContact ?? 0) === 0;
  if (isAggressiveChase(s) && !tacticalNoContact) {
    recycleTrailingChasePatrols(
      world,
      (tactic, unitType, forwardOnly) => deployGtaPatrol(world, s, tactic, unitType, forwardOnly),
      old => removeGtaPatrol(world, s, old),
    );
  } else if (!coordinated && !tacticalNoContact) for (const car of [...s.patrols]) {
    if (isGtaStationary(car)) continue;
    const ai = car.gtaAI;
    ai.behindTicks = !s.response.sightedBy.has(car) && distance(car, player) > 95 && gtaLocal(player, car).forward < 0
      ? ai.behindTicks + 1 : 0;
    if (ai.behindTicks <= ticks(6) || tick < (ai.nextRecycle ?? 0)) continue;
    ai.nextRecycle = tick + ticks(.75);
    const replacement = deployGtaPatrol(world, s, "intercept", car.unitType, true);
    if (replacement) removeGtaPatrol(world, s, car);
  }
  if (!tacticalNoContact && (coordinated ? isDispatchTracked(s.response) : s.response.sightedBy.size)) {
    placeGtaRoadblock(world);
    // Reserve roadblock berths while the opening squad is still converging.
    const reserve = coordinated && !isAggressiveChase(s) && !gta.roadblock && gtaRoadblocksEnabled(s) &&
      tick - s.startedTick < ticks(12) ? 2 : 0;
    const deficit = gtaPatrolTarget(s) - reserve - gtaPatrolCount(s);
    if (deficit > 0 && tick >= gta.nextDispatchTick) {
      fillGtaPatrols(world, s, Math.min(deficit, 2));
      gta.nextDispatchTick = tick + ticks(1.2);
    }
  }
  if (tick >= gta.nextSquadTick) {
    if (!coordinated || s.response.lastSeen)
      assignGtaSquad(s.patrols, s.response.lastSeen ?? s.playerStart);
    gta.nextSquadTick = tick + ticks(.5);
  }
}

/** Deploy without replacing the city or touching its ongoing trip. */
const streetCitySpecs = new WeakMap();

export function beginStreetPursuit(world, level = 1, variant = "legacy", config) {
  if (variant !== "gta" && config)
    for (const name of ["curbSupport", "patrolChainYield", "chasePresence", "tacticalPursuit", "cityPackPressure", "routeMemory"])
      if (Object.hasOwn(config, name)) throw new TypeError(`${name} is only available in Metro Dispatch`);
  const rawGtaConfig = variant === "gta"
    ? (config?.ruleset === "dispatch-v1" &&
        !Object.hasOwn(config, "surveillanceZones") &&
        Array.isArray(world.district?.surveillanceZones)
        ? { ...config, surveillanceZones: world.district.surveillanceZones }
        : config)
    : null;
  const gtaConfig = rawGtaConfig !== null ? resolveGtaChaseConfig(rawGtaConfig, level) : null;
  if (gtaConfig) level = gtaConfig.wantedLevelStart;
  else validateLevel(level);
  if (!["legacy", "rush", "cinematic", "arcade", "pack", "hunt", "survival", "gta"].includes(variant))
    throw new Error("Unsupported street pursuit variant");
  if (world.environment !== "metro" || !world.district?.pursuitExits?.length)
    throw new Error("Street pursuit requires a metro district with pursuit exits");
  if (gtaConfig && (world.config.cityVersion ?? 0) < 4)
    throw new Error("GTA Chase requires Metro City v4");
  if (gtaConfig?.cityPackPressure && (world.config.cityVersion ?? 0) < 5)
    throw new Error("City pack pressure requires Grand Metro City v5");
  if (world.pursuit?.phase === "running") throw new Error("Street pursuit is already running");
  if (world.pursuit?.reviewUntilTick > world.tick) throw new Error("Let the impact review finish first");
  const { player } = world;
  const dimensions = playerVehicleDimensions(player);
  const microbus = dimensions === KING_LONG_MICROBUS;
  if (microbus && (gtaConfig?.ruleset !== "dispatch-v1" || gtaConfig.policeFairness !== CITY_FAIR_POLICE))
    throw new Error("The King Long microbus supports only standard manual City Chase.");
  const citySpec = player.spec;
  if (!bodyOnRoad(player, world.roads)) throw new Error("No safe street pursuit deployment");
  const curb = gtaConfig?.curbSupport ? surveyMetroCurb(world, gtaConfig.curbSupport) : null;
  if (gtaConfig?.curbSupport && !curb) throw new Error("No matching surveyed Metro curb");

  const occupiedIds = [...world.actors, ...world.statics].map((body) => body.id);
  let run = (world.pursuit?.run ?? 0) + 1;
  while (occupiedIds.some((id) => id.startsWith(`street-pursuit-${run}-`))) run++;
  const rush = usesRushPace(variant);
  const arcade = isRushPack(variant), pack = isPackPursuit(variant);
  const rng = new Random(`${world.config.seed}:street-pursuit-${gtaConfig || arcade ? variant : rush ? "rush" : "v1"}:${world.tick}:${run}:${level}`);
  const state = {
    street: true, run, level, caseId: "street", phase: "running",
    playerStart: copyPose(player), exits: world.district.pursuitExits.map((exit) => ({ ...exit })),
    events: [], action: null, appliedCommand: null, decision: null,
    startedTick: world.tick, endedTick: null, metrics: pursuitMetrics(),
    rng, patrols: new Set(), closures: new Map(), contacts: new Set(), near: new Set(),
    nextEventTick: ticks(rng.range(2.4, 4.2)), eventKinds: [], eventSerial: 0,
    patrolMap: { roads: world.roads, drivingRoads: world.drivingRoads, statics: world.statics },
    lanes: [], junctions: (() => {
      const nonApron = world.drivingRoads.filter((r) => !r.supportApron && !r.parkingBay);
      if (!nonApron.some(isDiagonalRoad)) {
        return nonApron.filter((r) => r.axis === "x").flatMap((a) =>
          nonApron.filter((r) => r.axis === "z" &&
            r.fixed >= a.min && r.fixed <= a.max && a.fixed >= r.min && a.fixed <= r.max)
            .map((r) => ({ x: r.fixed, z: a.fixed })));
      }
      const list = [];
      for (let i = 0; i < nonApron.length; i++) {
        for (let j = i + 1; j < nonApron.length; j++) {
          const hit = roadIntersection(nonApron[i], nonApron[j], 0.5);
          if (hit && !list.some((p) => Math.hypot(p.x - hit.x, p.z - hit.z) < 0.6))
            list.push({ x: hit.x, z: hit.z });
        }
      }
      return list;
    })(),
  };
  const tactics = ["tail", "flank", "intercept", "flank", "tail", "intercept"];
  const ambientRandomState = world.rng.state;
  try {
    if (gtaConfig) {
      state.variant = "gta";
      state.response = createPursuitResponse();
      state.patrolMap.metro = true;
      initializeGtaPursuit(state, player, gtaConfig);
      if (curb) state.gta.curb = curb;
      state.gta.fadeStars = level;
      const count = gtaPatrolTarget(state);
      const initialCap = isFairCityPolice(state) ? count : isTacticalPursuit(state)
        ? Math.min(1, count)
        : Math.max(0, count - (!isAggressiveChase(state) && gtaRoadblocksEnabled(state) ? 2 : 0));
      fillGtaPatrols(world, state, initialCap);
      if (count && !state.patrols.size) throw new Error("No safe GTA patrol deployment");
      initializeGtaDurability(player, isAggressiveChase(state) ? Math.max(gtaConfig.playerMaxHealth, 180) : gtaConfig.playerMaxHealth, dimensions.massKg);
      if (microbus) {
        player.spec = { ...player.spec,
          acceleration: dimensions.chaseAccelerationMps2,
          steerRate: dimensions.chaseSteerRateRadS,
          reverseSpeed: dimensions.chaseReverseSpeedMps,
        };
        player.maxSpeed = dimensions.chaseMaxSpeedMps;
        player.wait = 0;
      } else if (isAggressiveChase(state)) {
        state.gta.normalSpec = player.spec;
        player.spec = {
          ...player.spec,
          acceleration: 6.8,
          braking: 9.6,
          steerRate: 2.35,
          reverseSpeed: 7.2,
          ...(isTacticalPursuit(state) ? { realisticDynamics: true } : {}),
        };
        player.maxSpeed = 32;
        player.wait = 0;
      } else {
        player.maxSpeed = GTA_MAX_SPEED;
      }
      if (isTacticalPursuit(state) && !state.gta.publicRouteGoal) {
        state.gta.escapeGoal = selectFarEscapeGoal({ ...world, pursuit: state });
      }
      player.path = [];
      player.parking = null;
      player.cursor = 0;
    } else if (rush) {
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
        state.survival = createSurvival(player, world.tick, config?.giantPhysics);
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
  if (!rush && !gtaConfig) world.actors.push(...state.patrols);
  world.actorIndex = new SpatialIndex(world.actors);
  world.pursuit = state;
  if (state.response) {
    updatePursuitResponse(world, true);
    if (!state.gta) for (const patrol of state.patrols)
      patrol.pursuitDrive.tracking = state.response.sightedBy.has(patrol);
  }
  if (state.gta) {
    placeGtaRoadblock(world);
    const reserve = state.gta.config.ruleset === "dispatch-v1" && gtaRoadblocksEnabled(state) ? 2 : 0;
    const openingTarget = isTacticalPursuit(state)
      ? Math.min(4, gtaPatrolTarget(state))
      : gtaPatrolTarget(state) - reserve;
    fillGtaPatrols(world, state, Math.max(0, openingTarget - gtaPatrolCount(state)));
    world.actorIndex = new SpatialIndex(world.actors);
    if (state.response) updatePursuitResponse(world, true);
  }
  if (state.gta) {
    world.updateSensors(false);
    if (state.gta.config.ruleset === "dispatch-v1") {
      state.gta.scanner = new PursuitScanner();
      state.gta.scan = state.gta.scanner.sample(world);
    }
  }
  if (citySpec?.contactResponse === "inelastic-slide-v1") {
    streetCitySpecs.set(state, citySpec);
    player.spec = { ...player.spec };
    if (!microbus) {
      if (isTacticalPursuit(state)) {
        // Fresh profiled tactical runs retain bounded tire grip without reducing
        // the braking authority used by their existing safety predictions.
        player.spec.tireGripMps2 = Math.max(citySpec.tireGripMps2, player.spec.braking ?? VEHICLE.braking);
      } else delete player.spec.tireGripMps2;
      delete player.spec.massKg;
      if (!isTacticalPursuit(state)) delete player.spec.realisticDynamics;
    }
    // Pursuit's shared multi-body swept/impulse solver owns collisions, health,
    // and curb interactions; do not layer City's one-sided contact solver on it.
    delete player.spec.contactResponse;
    clearVehicleMotion(player);
  }
  logEvent(world, "start", player);
  syncPursuitStatus(world, state);
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
  if (state.gta) {
    world.player.maxSpeed = state.gta.normalMaxSpeed;
    if (Object.hasOwn(state.gta, "normalSpec")) world.player.spec = state.gta.normalSpec;
    world.player.gtaSlipMps = world.player.gtaYawRate = world.player.chaseSlipRad = 0;
    clearCivilianGtaSlips(world.actors);
    state.gta.roadblock = null;
    if (state.gta.pressure) {
      state.gta.pressure.contactTicks = state.gta.pressure.stage = 0;
      state.gta.pressure.relays.clear();
    }
  }
  if (streetCitySpecs.has(state)) {
    world.player.spec = streetCitySpecs.get(state);
    clearVehicleMotion(world.player);
  }
  world.player.nitroActive = false;
  state.reviewUntilTick = null;
  if (state.endedTick == null) {
    state.endedTick = world.tick;
    logEvent(world, state.phase, world.player);
  }
  world.actorIndex = new SpatialIndex(world.actors);
  world.staticIndex = new SpatialIndex(world.statics);
  syncPursuitStatus(world, state);
  return true;
}

function returnEgoFromCityCurb(world, state) {
  const ego = world.player;
  const freeOnRemainingWorld = (candidate, gap) =>
    !world.actors.some(a => a !== ego && !state.patrols.has(a) && !state.survival?.wrecks.has(a) && overlaps(a, candidate, gap)) &&
    !world.statics.some(st => !state.closures.has(st) && overlaps(st, candidate, gap));

  if (bodyOnRoad(ego, world.roads) && freeOnRemainingWorld(ego, 0)) {
    ego.y = ego.supportHeightM = 0;
    ego.curbSupportId = null;
    if (ego.vehicle?.suspension) ego.vehicle.suspension.terrainOffsetsM = null;
    return true;
  }

  const site = state.gta?.curb?.sites?.find(item => item.id === ego.curbSupportId);
  const primaryRoad = site && world.drivingRoads.find(item => item.id === site.roadId);
  const roadDistSq = road => {
    const proj = roadProject(road, ego);
    const clampedAlong = clamp(proj.along, road.min, road.max);
    return (proj.along - clampedAlong) ** 2 + proj.leftOffset ** 2;
  };
  const sortedOtherRoads = world.drivingRoads
    .filter(r => r !== primaryRoad && !r.parkingBay && !r.supportApron)
    .sort((a, b) => roadDistSq(a) - roadDistSq(b));
  const candidateRoads = [
    ...(primaryRoad ? [primaryRoad] : []),
    ...sortedOtherRoads,
  ];

  const applyPose = candidate => {
    ego.x = candidate.x;
    ego.z = candidate.z;
    ego.heading = candidate.heading;
    ego.speed = 0;
    ego.gtaSlipMps = 0;
    ego.gtaYawRate = 0;
    ego.y = ego.supportHeightM = 0;
    ego.curbSupportId = null;
    ego.previous = copyPose(ego);
    if (ego.vehicle?.suspension) ego.vehicle.suspension.terrainOffsetsM = null;
  };

  for (const gap of [.15, .04]) {
    for (const road of candidateRoads) {
      const f = roadFrame(road);
      const proj = roadProject(road, ego);
      const dotFwd = Math.sin(ego.heading) * f.ux + Math.cos(ego.heading) * f.uz;
      const aligned = dotFwd >= 0 ? f.heading : Math.atan2(-f.ux, -f.uz);
      const sideSign = road === primaryRoad && site?.side ? site.side : 1;
      const edgeLat = Math.max(0, road.width / 2 - ego.width / 2 - .45);
      const midLat = edgeLat * .55;
      const latOffsets = [sideSign * edgeLat, sideSign * midLat, 0, -sideSign * midLat, -sideSign * edgeLat];
      const baseAlong = clamp(proj.along, road.min + 2.6, road.max - 2.6);
      const alongShifts = road === primaryRoad ? [0, 3, -3, 6, -6, 10, -10, 16, -16, 24, -24] : [0, 5, -5, 12, -12];
      for (const heading of [ego.heading, aligned, aligned + Math.PI]) {
        for (const dAlong of alongShifts) {
          const along = clamp(baseAlong + dAlong, road.min + 2.6, road.max - 2.6);
          for (const lat of latOffsets) {
            const pt = roadPointAt(road, along, lat);
            const candidate = {
              ...ego,
              x: pt.x,
              z: pt.z,
              heading,
            };
            if (bodyOnRoad(candidate, world.roads) && freeOnRemainingWorld(candidate, gap)) {
              applyPose(candidate);
              return true;
            }
          }
        }
      }
    }
  }
  return false;
}

/** Preserve terminal results so callers can show the outcome as city play continues. */
export function endStreetPursuit(world) {
  const state = world.pursuit;
  if (state?.street && (state.phase === "running" || state.reviewUntilTick)) {
    if (state.gta?.curb && world.player.curbSupportId) {
      if (state.gta.curb.mode !== METRO_CITY_CURBS)
        throw new Error("Return to the roadway before ending Metro Dispatch.");
      if (!returnEgoFromCityCurb(world, state))
        throw new Error("Move clear of traffic before ending Chase.");
    }
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
      const restoreMounts = Boolean(world.player.giantScale);
      if (cleanupStreetPursuit(world)) {
        world.resumeStreetDrive();
        if (restoreMounts) world.updateSensors(false);
      }
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
  const dimensions = a.id === "player" ? playerVehicleDimensions(a) : null;
  const track = dimensions?.trackM ?? a.width * 0.83;
  const axleCenterZ = dimensions?.axleCenterZM ?? 0;
  const cos = Math.cos(a.heading), sin = Math.sin(a.heading);
  let support = 0;
  for (const side of [-1, 1]) for (const end of [-1, 1]) {
    const x = a.x + side * track * cos / 2 + (end * reach + axleCenterZ) * sin;
    const z = a.z - side * track * sin / 2 + (end * reach + axleCenterZ) * cos;
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
    if (state.gta) state.patrolMap.statics = world.statics;
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
        ? (isDiagonalRoad(r)
            ? roadPoseAt(r, along, r.flow || (rng.next() < 0.5 ? -1 : 1))
            : districtRoadPose(r, along, r.flow || (rng.next() < 0.5 ? -1 : 1)))
        : isDiagonalRoad(r)
          ? roadPointAt(r, along, offset)
          : r.axis === "z"
            ? { x: r.fixed + offset, z: along }
            : { x: along, z: r.fixed + offset };
      const d = distance(point, player);
      if (d < (street ? 12 : 7) || d > 45 ||
          world.drivingRoads.some((other) => other !== r && (other.axis !== r.axis || isDiagonalRoad(r)) && pointOnRoad(point, [other], -2.0)) ||
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
          const own = roadAlong(r, player), low = Math.min(own, along) + 7, high = Math.max(own, along) - 6;
          if (!world.drivingRoads.some(other => other !== r && !other.supportApron &&
              other.width >= player.width + .4 &&
              (() => { const hit = roadIntersection(r, other, 0.5); return Boolean(hit && hit.alongA >= low && hit.alongA <= high); })())) continue;
        }
      }
      const width = kind === "closure" ? r.width + (street ? 0 : 0.15)
        : street ? Math.min(3.2, r.width - 2 * Math.abs(r.laneOffsetM ?? 0)) : 3.2;
      const prefix = street ? `street-pursuit-${run}` : "pursuit";
      const body = barrier(`${prefix}-${kind}-${eventSerial + 1}`, point.x, point.z,
        width, 0.8, roadFrame(r).heading);
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
    const p = isDiagonalRoad(r)
      ? roadPointAt(r, clamp(roadProject(r, point).along, r.min, r.max), 0)
      : r.axis === "z"
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

  function gtaStreetRoute(world, car, aim) {
    const target = isTacticalPursuit(world.pursuit)
      ? resolveTacticalRoadAim(world, car, aim, world.pursuit.response?.lastSeen)
      : aim;
    return setStreetPatrolPath(world.pursuit, car, target, null, car.gtaAI.lanes);
  }

  function gtaJunctionCommand(world, car) {
    const { pursuit: s } = world, ai = car.gtaAI;
    const tactical = isTacticalPursuit(s);
    if (!isDispatchTracked(s.response) || s.wantedLevel < (tactical ? 2 : 3) ||
        (s.gta.pressure && !s.response.sightedBy.has(car)) ||
        !["INTERCEPTOR", "FLANKER"].includes(car.squadRole) || car.aiState === "RECOVER" ||
        (ai.commitUntil ?? 0) > world.tick) {
      ai.junctionRoute = null;
      return null;
    }
    const role = car.squadRole === "INTERCEPTOR" ? "BLOCK_INTERCEPT" : "FLANK";
    if (ai.junctionRoute && (ai.junctionRoute.role !== role || world.tick >= ai.junctionRoute.expires ||
        !dispatchJunctionStillRelevant(ai.junctionRoute, s.response.lastSeen)))
      ai.junctionRoute = null;
    if (!ai.junctionRoute && world.tick >= (ai.nextJointCheck ?? 0)) {
      if (tactical && world._routePlanTick === world.tick && world._routePlanCount >= 2) {
        ai.nextJointCheck = world.tick + 1 + (ai.order % 4);
      } else {
        ai.nextJointCheck = world.tick + ticks(tactical ? .38 : .35);
        const target = selectDispatchJunction(world.drivingRoads, car, s.response.lastSeen);
        if (target) {
          if (tactical) {
            if (world._routePlanTick !== world.tick) {
              world._routePlanTick = world.tick;
              world._routePlanCount = 0;
            }
            world._routePlanCount++;
          }
          const path = planDistrictRoute(s.patrolMap, car, target.goal);
          if (path.length > 2)
            ai.junctionRoute = { ...target, path: markImmutablePath(path), cursor: 0,
              expires: world.tick + ticks(Math.max(target.entryEta, target.egoEta) + 1.65) };
        }
      }
    }
    const route = ai.junctionRoute;
    if (!route) return null;
    const { steer, targetSpeed, remaining, cursor } = followPath(car, route.path, route.cursor);
    route.cursor = cursor;
    if (remaining < 2) return null;
    car.aiState = route.role;
    const speedCap = tactical ? Math.min(car.maxSpeed, Math.max(24, targetSpeed * 2.15)) : Math.min(12.5, targetSpeed);
    return { steer, targetSpeed: speedCap, reason: route.role };
  }

  function gtaDirectApproach(world, car, aim, requireClearLane = false) {
    if (canPatrolUseCurbPrivilege(world, car)) {
      return canDrivePrivilegedDirect(world, car, aim, { avoidTraffic: true, maxHorizon: 28 });
    }
    const heading = headingTo(car, aim);
    if (Math.abs(angleDelta(heading, car.heading)) > 1.04) return false;
    const range = distance(car, aim);
    if (range < .45) return false;
    // Sight already checked the reported point for static occlusion. This
    // shorter corridor also checks the lead/offset against drivable geometry.
    const horizon = Math.min(range, 18);
    const dx = Math.sin(heading) * horizon, dz = Math.cos(heading) * horizon;
    const blockers = requireClearLane ? world.actorIndex.near(car, horizon + 4)
      .filter(other => other !== car && other !== world.player) : [];
    for (let i = 1; i <= 5; i++) {
      const probe = { ...vehicleProbe(car, car.speed), x: car.x + dx * i / 5, z: car.z + dz * i / 5, heading };
      if (!pointOnRoad(probe, world.drivingRoads, .75) || blockers.some(other => overlaps(probe, other, .14))) return false;
    }
    return gtaLineClear(world, car, dx, dz, horizon);
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

function travel(before, after, radius = shapeRadius(before)) {
  return distance(before, after) + Math.abs(angleDelta(after.heading, before.heading)) * radius;
}

function poseAt(p, t, footprint) {
  if (t <= 0) return p.a;
  if (!p.travel) return p.next;
  const time = Math.min(t, p.stop);
  if (time === 1) return p.next;
  if (footprint) {
    footprint.type = p.next.type;
    footprint.width = p.next.width;
    footprint.length = p.next.length;
    footprint.radius = p.next.radius;
  }
  return interpolate(p.a, p.next, time, footprint);
}

function findContact(a, b, since, probes) {
  if ((a.stop <= since || !a.travel) && (b.stop <= since || !b.travel)) return null;
  const maxTravel = a.travel + b.travel;
  if (distance(a.a, b.a) > a.radius + b.radius + maxTravel) return null;
  const occupied = (t) => overlaps(poseAt(a, t, probes?.[0]), poseAt(b, t, probes?.[1]));
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
  const mass = playerVehicleDimensions(ego.a).massKg;
  const otherMass = b.type === "pedestrian" ? other.a.body?.massKg ?? 75 :
    b.type === "vehicle" ? b.kind === "tuktuk" ? 620 : 1450 : Infinity;
  const effectiveMass = b.type === "static" ? mass : mass * otherMass / (mass + otherMass);
  const energyJ = 0.5 * effectiveMass * closingSpeedMps ** 2;
  return { actorId: b.id, side, closingSpeedMps, energyJ, severity: clamp(energyJ / 42000, 0, 1), tick, x: a.x, z: a.z };
}

const pairId = (a, b) => [a.id, b.id].sort().join(":");
const CONTACT_CELL_M = 8;
const staticContactGrids = new WeakMap();
const distantActorCmdCache = new WeakMap();
const patrolVisualCrashMap = new WeakMap();
const impactGeometryMap = new WeakMap();

export function getPatrolVisualDamage(actor) {
  return actor ? patrolVisualCrashMap.get(actor) ?? null : null;
}

export function recordActorVisualCrash(actor, actorPose, otherPose, closingSpeedMps) {
  if (!actor || !(closingSpeedMps >= 1.2)) return;
  const delta = clamp((closingSpeedMps - 0.8) / 14, 0.08, 0.92);
  const rel = gtaLocal(actorPose, otherPose);
  const side = Math.abs(rel.forward) >= Math.abs(rel.right) * 1.05
    ? (rel.forward >= 0 ? "front" : "rear")
    : (rel.right >= 0 ? "right" : "left");
  let entry = patrolVisualCrashMap.get(actor);
  if (!entry) {
    entry = { front: 0, rear: 0, left: 0, right: 0 };
    patrolVisualCrashMap.set(actor, entry);
  }
  entry[side] = clamp(entry[side] + delta, 0, 1);
}

function recordPatrolVisualCrash(patrol, patrolPose, otherPose, healthLost) {
  if (!(healthLost > 0.2)) return;
  const maxHealth = patrol.maxHealth || 85;
  const delta = clamp((healthLost / maxHealth) * 1.45, 0, 1);
  const rel = gtaLocal(patrolPose, otherPose);
  const side = Math.abs(rel.forward) >= Math.abs(rel.right) * 1.05
    ? (rel.forward >= 0 ? "front" : "rear")
    : (rel.right >= 0 ? "right" : "left");
  let entry = patrolVisualCrashMap.get(patrol);
  if (!entry) {
    entry = { front: 0, rear: 0, left: 0, right: 0 };
    patrolVisualCrashMap.set(patrol, entry);
  }
  entry[side] = clamp(entry[side] + delta, 0, 1);
}
const contactOrder = (a, b) => a - b;

function sweptContactBoundsInto({ a, next, radius }, out, offset) {
  let x, z;
  if (a.type === "pedestrian") {
    x = z = .24 + radius;
  } else {
    const h = a.heading ?? 0;
    const sin = Math.abs(Math.sin(h)), cos = Math.abs(Math.cos(h));
    const dh = next.heading ?? 0;
    const rawDiff = dh - h;
    const absTurn = rawDiff > -Math.PI && rawDiff <= Math.PI
      ? Math.abs(rawDiff)
      : Math.abs(angleDelta(dh, h));
    const pad = .24 + radius * absTurn;
    x = pad + (a.width * cos + a.length * sin) / 2;
    z = pad + (a.length * cos + a.width * sin) / 2;
  }
  out[offset] = Math.min(a.x, next.x) - x;
  out[offset + 1] = Math.max(a.x, next.x) + x;
  out[offset + 2] = Math.min(a.z, next.z) - z;
  out[offset + 3] = Math.max(a.z, next.z) + z;
}

function sweptContactBounds(plan) {
  const out = [0, 0, 0, 0];
  sweptContactBoundsInto(plan, out, 0);
  return out;
}

function contactCellSpan(box) {
  return box.map(edge => Math.floor(edge / CONTACT_CELL_M));
}

function indexContactSpan(cells, [left, right, bottom, top], i) {
  for (let x = left; x <= right; x++) {
    let row = cells.get(x);
    if (!row) cells.set(x, row = new Map());
    for (let z = bottom; z <= top; z++) {
      const bucket = row.get(z);
      if (bucket) bucket.push(i);
      else row.set(z, [i]);
    }
  }
}

function staticContactPlan(a) {
  return { a, next: a, travel: 0, stop: 0, radius: shapeRadius(a) };
}

function dispatchStaticContacts(world) {
  const { statics } = world;
  const last = staticContactGrids.get(world);
  // Check the geometry as well as identity: a World fixture can edit a solid
  // in place without replacing its array or rebuilding its sight index.
  if (last?.entries.length === statics.length && statics.every((a, i) => {
    const p = last.entries[i];
    return a.type === "static" && p.a === a && p.x === a.x && p.z === a.z &&
      p.heading === a.heading && p.width === a.width && p.length === a.length;
  })) return last;
  if (statics.some(a => a.type !== "static")) return null;
  const plans = statics.map(staticContactPlan);
  const bounds = plans.map(sweptContactBounds), cells = new Map();
  for (let i = 0; i < bounds.length; i++) indexContactSpan(cells, contactCellSpan(bounds[i]), i);
  const entries = statics.map(({ x, z, heading, width, length }, i) =>
    ({ a: statics[i], x, z, heading, width, length }));
  const next = { plans, bounds, cells, entries };
  staticContactGrids.set(world, next);
  return next;
}

const _contactPool = {
  cells: new Map(),
  usedKeys: [],
  bounds: new Float64Array(2048),
  spans: new Int32Array(2048),
  marked: new Uint32Array(4096),
};

function dispatchStreetContactPairs(moving, solids) {
  const n = moving.length, total = n + solids.plans.length;
  if (_contactPool.bounds.length < n * 4) {
    _contactPool.bounds = new Float64Array(n * 8);
    _contactPool.spans = new Int32Array(n * 8);
  }
  if (_contactPool.marked.length < total) {
    _contactPool.marked = new Uint32Array(total * 2);
  } else {
    _contactPool.marked.fill(0, 0, total);
  }
  const { cells, usedKeys, bounds, spans, marked } = _contactPool;
  for (let u = 0; u < usedKeys.length; u++) cells.get(usedKeys[u]).length = 0;
  usedKeys.length = 0;

  for (let i = 0; i < n; i++) {
    const o = i * 4;
    sweptContactBoundsInto(moving[i], bounds, o);
    const left = Math.floor(bounds[o] / CONTACT_CELL_M), right = Math.floor(bounds[o + 1] / CONTACT_CELL_M);
    const bottom = Math.floor(bounds[o + 2] / CONTACT_CELL_M), top = Math.floor(bounds[o + 3] / CONTACT_CELL_M);
    spans[o] = left; spans[o + 1] = right; spans[o + 2] = bottom; spans[o + 3] = top;
    for (let x = left; x <= right; x++) {
      const hi = x << 16;
      for (let z = bottom; z <= top; z++) {
        const key = hi ^ (z & 0xffff);
        let bucket = cells.get(key);
        if (!bucket) {
          bucket = [i];
          cells.set(key, bucket);
          usedKeys.push(key);
        } else {
          if (bucket.length === 0) usedKeys.push(key);
          bucket.push(i);
        }
      }
    }
  }

  const pairs = [], candidates = [];
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const left = spans[o], right = spans[o + 1], bottom = spans[o + 2], top = spans[o + 3];
    const own0 = bounds[o], own1 = bounds[o + 1], own2 = bounds[o + 2], own3 = bounds[o + 3];
    const a = moving[i], stamp = i + 1;
    candidates.length = 0;
    for (let x = left; x <= right; x++) {
      const hi = x << 16;
      const staticRow = a.travel ? solids.cells.get(x) : undefined;
      for (let z = bottom; z <= top; z++) {
        const local = cells.get(hi ^ (z & 0xffff));
        if (local) for (let k = 0; k < local.length; k++) {
          const j = local[k];
          if (j > i && marked[j] !== stamp) {
            marked[j] = stamp;
            candidates.push(j);
          }
        }
        const fixed = staticRow?.get(z);
        if (fixed) for (let k = 0; k < fixed.length; k++) {
          const j = n + fixed[k];
          if (marked[j] !== stamp) {
            marked[j] = stamp;
            candidates.push(j);
          }
        }
      }
    }
    const cLen = candidates.length;
    if (cLen === 0) continue;
    if (cLen === 2) {
      if (candidates[0] > candidates[1]) {
        const tmp = candidates[0];
        candidates[0] = candidates[1];
        candidates[1] = tmp;
      }
    } else if (cLen > 2) {
      if (cLen <= 12) {
        for (let aIdx = 1; aIdx < cLen; aIdx++) {
          const val = candidates[aIdx];
          let bIdx = aIdx - 1;
          while (bIdx >= 0 && candidates[bIdx] > val) {
            candidates[bIdx + 1] = candidates[bIdx];
            bIdx--;
          }
          candidates[bIdx + 1] = val;
        }
      } else {
        candidates.sort(contactOrder);
      }
    }
    for (let c = 0; c < cLen; c++) {
      const j = candidates[c];
      const b = j < n ? moving[j] : solids.plans[j - n];
      if (!a.travel && !b.travel) continue;
      if (j < n) {
        const jo = j * 4;
        if (own0 > bounds[jo + 1] || own1 < bounds[jo] || own2 > bounds[jo + 3] || own3 < bounds[jo + 2]) continue;
      } else {
        const other = solids.bounds[j - n];
        if (own0 > other[1] || own1 < other[0] || own2 > other[3] || own3 < other[2]) continue;
      }
      if (distance(a.a, b.a) <= a.radius + b.radius + a.travel + b.travel + .24) pairs.push([a, b]);
    }
  }
  return pairs;
}

function streetContactPairs(moving, solid, dispatch) {
  const cells = new Map(), cellSize = CONTACT_CELL_M;
  const bounds = (body) => {
    // travel includes translation and corner rotation, even when contact later stops it.
    const reach = body.radius + body.travel + .24;
    return [Math.floor((body.a.x - reach) / cellSize), Math.floor((body.a.x + reach) / cellSize),
      Math.floor((body.a.z - reach) / cellSize), Math.floor((body.a.z + reach) / cellSize)];
  };
  const bodies = moving.concat(solid);
  const swept = dispatch ? bodies.map(sweptContactBounds) : null;
  const spans = swept ? swept.map(box => box.map(edge => Math.floor(edge / cellSize))) : bodies.map(bounds);
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
      if (swept) {
        const [minX, maxX, minZ, maxZ] = swept[i], other = swept[j];
        if (minX > other[1] || maxX < other[0] || minZ > other[3] || maxZ < other[2]) continue;
      }
      if (distance(a.a, b.a) <= a.radius + b.radius + a.travel + b.travel + .24)
        pairs.push([a, b]);
    }
  }
  return pairs;
}

function resolveContacts(world, moving, solid, staticGrid, freshImpacts) {
  const s = world.pursuit, pairs = staticGrid ? dispatchStreetContactPairs(moving, staticGrid) :
    s.street ? streetContactPairs(moving, solid, s.response?.dispatch) : [];
  const gtaPairs = s.gta ? new Set() : null;
  // Only transient boolean overlap tests use these probes. Contact responses and accepted poses still use full bodies.
  const probes = s.response?.dispatch ? [{}, {}] : null;
  if (!s.street) for (const [i, a] of moving.entries()) {
    for (const b of [...moving.slice(i + 1), ...solid]) {
      if (distance(a.a, b.a) <= a.radius + b.radius + a.travel + b.travel + 0.24)
        pairs.push([a, b]);
    }
  }
  let since = 0, playerHit = null, playerHitGeometry = null;
  const noContact = new Uint8Array(pairs.length);
  // Stop both participants at the first contact, then test the rest of the
  // tick against those stopped poses. Actors never pass through an old/new swap.
  for (let n = 0; n < moving.length; n++) {
    let hit = null;
    for (let pIdx = 0; pIdx < pairs.length; pIdx++) {
      if (noContact[pIdx]) continue;
      const [a, b] = pairs[pIdx];
      if (a.erased || b.erased || survivalGhostPair(world, a.a, b.a)) continue;
      if (!staticGrid && gtaPairs?.has(pairId(a.a, b.a))) continue;
      const found = findContact(a, b, since, probes);
      if (!found) {
        noContact[pIdx] = 1;
        continue;
      }
      if ((!hit || found.time < hit.time) &&
          (!staticGrid || !gtaPairs?.size || !gtaPairs.has(pairId(a.a, b.a)))) hit = found;
    }
    if (!hit) break;
    const hitA = hit.a, hitB = hit.b;
    for (let pIdx = 0; pIdx < pairs.length; pIdx++) {
      if (!noContact[pIdx]) continue;
      const [pa, pb] = pairs[pIdx];
      if (pa === hitA || pa === hitB || pb === hitA || pb === hitB) noContact[pIdx] = 0;
    }
    const { a, b, time, overlapAt } = hit;
    const key = pairId(a.a, b.a);
    const fresh = !s.contacts.has(key);
    const paHit = poseAt(a, time), pbHit = poseAt(b, time);
    const normalHit = normalAt(paHit, pbHit);
    const hitClosingMps = closingSpeed(a, b, overlapAt, normalHit);
    if (gtaPairs) {
      gtaPairs.add(key);
      const hA = a.a.health ?? 0, hB = b.a.health ?? 0;
      applyGtaContact(world, a, b, paHit, pbHit, normalHit, hitClosingMps, fresh);
      if (s.patrols.has(a.a) && a.a.health < hA) recordPatrolVisualCrash(a.a, paHit, pbHit, hA - a.a.health);
      if (s.patrols.has(b.a) && b.a.health < hB) recordPatrolVisualCrash(b.a, pbHit, paHit, hB - b.a.health);
    }
    if (fresh && hitClosingMps >= 1.2) {
      if (a.a.type === "vehicle" && a.a !== world.player && a.a.pursuitRole !== "police" && !s.patrols?.has?.(a.a)) {
        recordActorVisualCrash(a.a, paHit, pbHit, hitClosingMps);
      }
      if (b.a.type === "vehicle" && b.a !== world.player && b.a.pursuitRole !== "police" && !s.patrols?.has?.(b.a)) {
        recordActorVisualCrash(b.a, pbHit, paHit, hitClosingMps);
      }
    }
    if (a.a === world.player || b.a === world.player) {
      const [ego, other] = a.a === world.player ? [a, b] : [b, a];
      if (s.survival?.active?.kind === "giant" && (s.patrols.has(other.a) || s.survival.wrecks.has(other.a))) {
        other.stop = time;
        other.erased = true;
        s.survival.pendingWrecks.set(other.a, { reason: "giant", erased: true });
        continue;
      }
      const impact = contactImpact(ego, other, time, overlapAt, world.tick + 1);
      const egoPoseAt = poseAt(ego, time), otherPoseAt = poseAt(other, time);
      const hitGeom = { otherX: otherPoseAt.x, otherZ: otherPoseAt.z, normal: normalAt(egoPoseAt, otherPoseAt) };
      if (fresh) recordCityPropImpact(world, other.a, {
        closingSpeedMps: hitClosingMps, normal: hitGeom.normal,
      });
      if (!playerHit || impact.severity > playerHit.severity) {
        playerHit = impact;
        playerHitGeometry = hitGeom;
      }
      if (fresh) {
        freshImpacts?.push({ ...impact, ...hitGeom });
        const pack = isPackPursuit(s.variant), pedestrian = other.a.type === "pedestrian";
        if (!pack || !s.metrics.terminalCause || (pedestrian && s.metrics.terminalCause !== "pedestrian-impact"))
          s.metrics.impact = impact;
        s.metrics.collisions++;
        if (pedestrian) s.metrics.pedestrianCollisions++;
        if (s.gta?.pressure && !s.patrols.has(other.a) &&
            (other.a.type === "vehicle" || other.a.kind === "parked-vehicle"))
          s.metrics.civilianVehicleContacts++;
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
    } else if (fresh) {
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
    const allowRetreat = isAggressiveChase(s) && a.a.type === "vehicle" && b.a.type === "vehicle";
    const paAt = allowRetreat ? poseAt(a, time) : null;
    const pbAt = allowRetreat ? poseAt(b, time) : null;
    const aEnd = allowRetreat && a.travel && a.stop > time ? poseAt(a, a.stop) : null;
    const bEnd = allowRetreat && b.travel && b.stop > time ? poseAt(b, b.stop) : null;
    const aClearsStoppedB = Boolean(aEnd &&
      !overlaps(poseAt(a, (time + a.stop) / 2), pbAt) &&
      !overlaps(aEnd, pbAt) &&
      distance(aEnd, pbAt) >= distance(paAt, pbAt) - 1e-5);
    const bClearsStoppedA = Boolean(!aClearsStoppedB && bEnd &&
      !overlaps(poseAt(b, (time + b.stop) / 2), paAt) &&
      !overlaps(bEnd, paAt) &&
      distance(bEnd, paAt) >= distance(pbAt, paAt) - 1e-5);
    if (a.travel && a.stop > time && !aClearsStoppedB) {
      a.stop = time;
      a.hit = b.a.id;
    }
    if (b.travel && b.stop > time && !bClearsStoppedA) {
      b.stop = time;
      b.hit = a.a.id;
    }
    // A held ego may be struck by a moving body; preserve its contact reason.
    if (a.a.type !== "static" && !a.hit && !aClearsStoppedB) a.hit = b.a.id;
    if (b.a.type !== "static" && !b.hit && !bClearsStoppedA) b.hit = a.a.id;
    since = time;
  }
  if (playerHit && playerHitGeometry) impactGeometryMap.set(playerHit, playerHitGeometry);
  return playerHit;
}

function slideAlongFixedProp(world, plans) {
  const ego = plans.find(p => p.a === world.player);
  if (!ego?.impulse || !world.statics.some(s => s.id === ego.hit && s.propImpact)) return;
  const contact = poseAt(ego, 1);
  const sin = Math.sin(contact.heading), cos = Math.cos(contact.heading);
  const vx = sin * ego.impulse.speed + cos * ego.impulse.gtaSlipMps;
  const vz = cos * ego.impulse.speed - sin * ego.impulse.gtaSlipMps;
  const duration = (1 - ego.stop) * STEP;
  if (Math.hypot(vx, vz) * duration < 1e-5) return;
  const end = { ...contact, x: contact.x + vx * duration, z: contact.z + vz * duration };
  const supported = world.pursuit.gta.curb
    ? sweepSafeWithCurbs(contact, end, [], world.roads, world.pursuit.gta.curb).safe
    : sweepSafe(contact, end, [], world.roads).safe;
  if (!supported) return;
  const steps = Math.max(1, Math.ceil(distance(contact, end) / .025));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const probe = interpolate(contact, end, t);
    if (world.statics.some(s => overlaps(probe, s)) ||
        plans.some(p => p !== ego && overlaps(probe, poseAt(p, ego.stop + (1 - ego.stop) * t))))
      return;
  }
  ego.next = end;
  ego.stop = 1;
  ego.travel = travel(ego.a, end, ego.radius);
}

function updateClearance(world, playerMotion, plans, solids = []) {
  const s = world.pursuit, near = new Set(), touching = new Set();
  const ego = poseAt(playerMotion, 1);
  const checkList = list => {
    for (let i = 0; i < list.length; i++) {
      const body = list[i];
      if (s.street) {
        const lim = playerMotion.radius + body.radius + body.travel + .72;
        if (Math.abs(ego.x - body.a.x) > lim || Math.abs(ego.z - body.a.z) > lim || distance(ego, body.a) > lim) continue;
      }
      const other = poseAt(body, 1);
      if (other.id === ego.id || body.erased || survivalGhostPair(world, world.player, body.a)) continue;
      const key = pairId(ego, other);
      if (overlaps(ego, other, 0.25)) touching.add(key);
      if (s.contacts.has(key) || !overlaps(ego, other, 0.72)) continue;
      const normal = normalAt(ego, other);
      const minDist = s.gta ? Math.max(0, (other.x - ego.x) * normal.x + (other.z - ego.z) * normal.z -
        extent(ego, normal.x, normal.z) - extent(other, normal.x, normal.z)) : 0;
      const approach = s.gta ? (distance(poseAt(playerMotion, .9), poseAt(body, .9)) - distance(ego, other)) / (.1 * STEP)
        : closingSpeed(playerMotion, body, 1, normal);
      const entered = !s.near.has(key) && approach > .6 && (!s.gta || minDist <= .72);
      if (!s.gta || entered || s.near.has(key)) near.add(key);
      if (entered) {
        s.metrics.nearCollisions++;
        logEvent(world, "near", ego, other.id, world.tick + 1);
        if (s.gta) emitGtaEvent(world, "near_miss", {
          actorKind: body.a.aiState === "WRECKED" ? "wrecked" : body.a.unitType ??
            (other.gtaRoadblock ? "roadblock" : other.kind ?? other.type),
          minDist, ...(s.response.dispatch ? { actorId: body.a.id, actorType: body.a.type, approachMps: approach } : {}),
        });
      }
    }
  };
  checkList(plans);
  checkList(solids);
  if (s.contacts.size > 0) {
    let byId = null;
    for (const key of s.contacts) {
      if (touching.has(key)) continue;
      if (!byId) {
        byId = new Map();
        for (let i = 0; i < plans.length; i++) byId.set(plans[i].a.id, plans[i]);
        for (let i = 0; i < solids.length; i++) byId.set(solids[i].a.id, solids[i]);
      }
      const sep = key.indexOf(":");
      const p = byId.get(key.slice(0, sep)), q = byId.get(key.slice(sep + 1));
      if (!p || !q || !overlaps(poseAt(p, 1), poseAt(q, 1), 0.25)) s.contacts.delete(key);
    }
  }
  s.near = near;
}

function projectGtaVehicle(actor, command) {
  const next = integrateVehicle(actor, command, STEP);
  integrateGtaSlip(actor, next);
  return next;
}

const previewLateralPush = (patrol, lead) => gtaPreviewLateralPush(patrol, lead, normalAt(patrol, lead));

function motionPlan(world, actor, action, streetHooks) {
  let next, command, sweptTravel, curb, guard = "clear";
  const radius = shapeRadius(actor);
  if (actor.type === "pedestrian")
    next = streetHooks ? streetHooks.pedestrianMotion(actor) : pedestrianMotion(world, actor);
  else {
    const pack = isPackPursuit(world.pursuit.variant);
    const survival = world.pursuit.survival;
    const gta = world.pursuit.gta && (actor === world.player || world.pursuit.patrols.has(actor));
    if (survival?.wrecks.has(actor) || (gta && isGtaStationary(actor))) return { a: actor, next: actor,
      command: { steer: 0, targetSpeed: 0 },
      guard, travel: 0, radius, stop: 0, hit: null };
    const nitroAllowed = actor === world.player && (
      Boolean(world.pursuit.street && world.pursuit.variant && world.pursuit.variant !== "legacy") ||
      Object.prototype.hasOwnProperty.call(action, "nitro")
    );
    const playerAction = actor === world.player && !nitroAllowed && Object.prototype.hasOwnProperty.call(action, "nitro")
      ? { steer: action.steer, throttle: action.throttle, brake: action.brake, gear: action.gear }
      : action;
    command = actor === world.player ? (pack ? packCommand : pursuitCommand)(actor, playerAction, STEP) :
      gta ? (world.pursuit.response.dispatch && gtaJunctionCommand(world, actor)) ||
        gtaPatrolCommand(world, actor, gtaStreetRoute, gtaDirectApproach, gtaSpacingSteer(actor, world.pursuit.patrols)) :
      !streetHooks || world.pursuit.patrols.has(actor) ? npcCommand(world, actor) : null;
    if (
      actor === world.player &&
      pack &&
      nitroAllowed &&
      (playerAction.nitro ?? 0) >= 0.5 &&
      isNitroEngaged(actor, playerAction) &&
      command.targetSpeed > 0
    ) {
      const boostedMaxSpeed = Math.min(
        NITRO_SPEC.maxBoostSpeedMps,
        (actor.maxSpeed ?? 9.72) * NITRO_SPEC.speedMultiplier,
      );
      command = {
        ...command,
        targetSpeed: boostedMaxSpeed,
        maxSpeed: boostedMaxSpeed,
        accelMultiplier: NITRO_SPEC.accelMultiplier,
      };
    }
    const nitroMaxSpeed = actor === world.player ? command.maxSpeed : undefined;
    const nitroAccelMult = actor === world.player ? command.accelMultiplier : undefined;
    if (survival && actor === world.player && world.mode === "manual") command.arcadeDrift = true;
    if (streetHooks) command = streetHooks.vehicleCommand(actor, command);
    else if (pack && actor === world.player) command = world.safeSpeed(actor, command, false);
    let pedSuppressedNitro = false;
    if (actor === world.player && nitroAccelMult > 1) {
      const blockedPed = command.blockedBy && world.actors.some(
        (b) => b.id === command.blockedBy && b.type === "pedestrian",
      );
      if (blockedPed) {
        pedSuppressedNitro = true;
        if (command.maxSpeed !== undefined || command.accelMultiplier !== undefined) {
          const { maxSpeed: _m, accelMultiplier: _a, ...rest } = command;
          command = rest;
        }
      } else if (command.targetSpeed > 0 && command.accelMultiplier === undefined) {
        command = {
          ...command,
          maxSpeed: nitroMaxSpeed,
          accelMultiplier: nitroAccelMult,
        };
      }
    }
    if (actor !== world.player && world.pursuit.response?.dispatch) {
      const preview = !gta && world.pursuit.gta.config.civilianCrossingPreview;
      if (preview === CIVILIAN_TIMED_YIELD) command = timedCivilianYield(world, actor, command);
      else if (gta || preview) command = dispatchPedestrianYield(world, actor, command, preview);
      if (gta && isTacticalPursuit(world.pursuit) && command.reason !== "pedestrian-yield" && command.targetSpeed > 0) {
        const ai = actor.gtaAI;
        let overtake = null;
        if (ai && ai.overtakeUntilTick > world.tick && ai.cachedOvertake) {
          overtake = ai.cachedOvertake;
        } else {
          overtake = tacticalTrafficOvertake(world, actor, command.steer, command.targetSpeed);
          if (ai) {
            ai.cachedOvertake = overtake;
            ai.overtakeUntilTick = world.tick + (overtake ? 3 : 2);
          }
        }
        if (overtake) command = dispatchPedestrianYield(world, actor, overtake, false);
      }
      if (gta && world.pursuit.gta.config.patrolTrafficPreview && command.reason !== "tactical-overtake")
        command = dispatchPatrolTrafficYield(world, actor, command);
      if (gta && world.pursuit.gta.config.patrolChainYield && world.pursuit.response.sightedBy.has(actor)) {
        const lead = world.player, relative = gtaLocal(actor, lead);
        const longitudinal = patrolChainYield(world, actor, command, lead, relative, gtaRearPushSpeed);
        command = longitudinal === command && world.pursuit.gta.config.patrolChainYield === PATROL_LATERAL_YIELD
          ? patrolLateralYield(world, actor, command, lead, relative, projectGtaVehicle, previewLateralPush)
          : longitudinal;
      }
      if (gta && isFairCityPolice(world.pursuit) && world.pursuit.response.sightedBy.has(actor)) {
        const report = world.pursuit.response.lastSeen;
        if (report) {
          const egoDimensions = playerVehicleDimensions(world.player);
          const relative = gtaLocal(actor, report);
          const fairApproachWidth = (actor.width + egoDimensions.widthM) / 2 +
            4.5 + Math.max(0, actor.speed) * 0.08;
          if (relative.forward > 0 && Math.abs(relative.right) < fairApproachWidth) {
            const braking = actor.spec?.braking ?? VEHICLE.braking;
            const leadSpeed = Math.max(0, (report.vx ?? 0) * Math.sin(actor.heading) +
              (report.vz ?? 0) * Math.cos(actor.heading));
            const gap = relative.forward - (actor.length + egoDimensions.lengthM) / 2;
            const desiredGap = 5.5 + Math.max(0, actor.speed) * 0.42;
            const room = Math.max(0, gap - desiredGap);
            const compressed = Math.max(0, desiredGap - gap);
            const safeLeadSpeed = Math.max(0, leadSpeed - compressed * 1.35);
            const pace = Math.sqrt(safeLeadSpeed * safeLeadSpeed + 2 * braking * room);
            if (pace < command.targetSpeed) command = { ...command, targetSpeed: pace,
              decelerationMps2: braking, reason: "fair-follow" };
          }
        }
      }
    }
    // The swept solver uses the body shape, not its path, profile and history.
    const pose = usesRushPace(world.pursuit.variant) ? Object.assign(vehicleProbe(actor, actor.speed), {
      id: actor.id, kind: actor.kind, y: actor.y, supportHeightM: actor.supportHeightM,
    }) : null;
    if (world.terrain && (actor === world.player || gta)) {
      const surface = sampleCitySurface(world.terrain, actor.x, actor.z, actor.heading);
      command = { ...command, surface };
    }
    const nitroPose = actor === world.player && !pedSuppressedNitro
      ? buildNitroBoostPose(actor, command, copyVehicleMotion)
      : null;
    next = integrateVehicle(nitroPose ?? actor, command, STEP, pose);
    if (nitroPose) {
      next.maxSpeed = actor.maxSpeed;
      next.spec = actor.spec;
    }
    if (pedSuppressedNitro) command = { ...command, _pedSuppressedNitro: true };
    if (gta) integrateGtaSlip(actor, next);
    else if (world.config?.interactionProfile === WHEEL_SCRUB_MODE && actor.type === "vehicle") {
      integrateCivilianGtaSlip(actor, next);
    }
    const site = world.pursuit.gta?.curb;
    const curbActor = actor === world.player || canPatrolUseCurbPrivilege(world, actor);
    if (curbActor && site && nearCurb(site, actor)) {
      curb = site;
      const limited = curbCommand(site, world.roads, actor, command, next, projectGtaVehicle);
      if (limited !== command) next = projectGtaVehicle(actor, command = limited);
    }
    next.reason = command.reason ?? "driving";
    next.blockedBy = command.blockedBy ?? null;
    const roads = streetHooks || actor === world.player ? world.roads : world.drivingRoads;
    sweptTravel = travel(actor, next, radius);
    const boundarySafe = !curb
      ? sweepSafe(actor, next, [], roads).safe
      : actor === world.player || sweepSafeWithCurbs(actor, next, [], world.roads, curb).safe;
    if (sweptTravel > 0 && !boundarySafe) {
      guard = "road-boundary";
      sweptTravel = 0;
      next = { ...actor, speed: 0, steer: next.steer, reason: guard, blockedBy: null,
        ...(gta ? { gtaSlipMps: 0, gtaYawRate: 0 } : {}) };
    }
  }
  return { a: actor, next, command, guard, travel: sweptTravel ?? travel(actor, next, radius), radius, stop: 1, hit: null,
    ...(curb ? { curb } : {}) };
}

function dispatchPedestrianYield(world, car, command, civilianPreview) {
  const { targetSpeed } = command;
  if (!targetSpeed || (civilianPreview && targetSpeed < 0)) return command;
  const tactical = isTacticalPursuit(world.pursuit);
  const braking = car.spec?.braking ?? VEHICLE.braking;
  const deceleration = tactical ? Math.min(braking, 9.5) : Math.min(braking, 6);
  const speed = Math.abs(car.speed) + .12 * (car.spec?.acceleration ?? VEHICLE.acceleration);
  const reach = car.length / 2 + speed * .12 + speed ** 2 / (2 * deceleration) + 2.5;
  // Archived boolean previews only see authored crossings. Moving people
  // may enter the lane from a connected walkline without that flag.
  const walkers = world.actorIndex.near(car, reach).filter(body => body.type === "pedestrian" &&
    (!tactical || targetSpeed < 0 || gtaLocal(car, body).forward >= -2) &&
    (!civilianPreview || (body.speed > .2 && (civilianPreview !== true || body.crossing))) &&
    gtaLineClear(world, car, body.x - car.x, body.z - car.z, distance(car, body)));
  if (!walkers.length) return command;

  const stride = .1, horizon = .2 + speed / deceleration;
  const probe = vehicleProbe(car, car.speed);
  const slow = { steer: command.steer, targetSpeed: 0, decelerationMps2: deceleration };
  const possible = { type: "pedestrian", radius: 0, x: 0, z: 0 };
  for (let t = stride; t <= horizon; t += stride) {
    integrateVehicle(probe, t <= .12 ? command : slow, stride, probe);
    for (const person of walkers) {
      if (Math.abs(person.x - probe.x) > 7.5 || Math.abs(person.z - probe.z) > 7.5) continue;
      const time = Math.min(t, 1.2);
      const dx = Math.sin(person.heading) * person.speed * time;
      const dz = Math.cos(person.heading) * person.speed * time;
      possible.radius = person.radius;
      // Check the start and the segment the pedestrian can enter before the stop.
      for (const fraction of [0, .5, 1]) {
        possible.x = person.x + fraction * dx;
        possible.z = person.z + fraction * dz;
        if (overlaps(probe, possible, .42))
          return { ...command, targetSpeed: 0, reason: "pedestrian-yield", blockedBy: person.id };
      }
    }
  }
  return command;
}

function dispatchPatrolTrafficYield(world, car, command) {
  if (command.targetSpeed <= 0 || car.speed < 0) return command;
  const { pursuit } = world, braking = car.spec?.braking ?? VEHICLE.braking;
  const tactical = isTacticalPursuit(pursuit);
  const reactionTicks = tactical ? 9 : 21, reactionS = reactionTicks * STEP;
  const speed = Math.max(car.speed, Math.min(command.targetSpeed,
    car.speed + reactionS * (car.spec?.acceleration ?? VEHICLE.acceleration)));
  const reach = speed * reactionS + speed ** 2 / (2 * braking) + Math.abs(car.gtaSlipMps) / 3 + 10;
  const blockers = [];
  for (const other of world.actorIndex.near(car, reach)) {
    if (other === world.player || other.type !== "vehicle" || pursuit.patrols.has(other)) continue;
    const rel = gtaLocal(car, other);
    if (rel.forward <= 0 || (tactical && Math.abs(command.steer) < 0.12 && Math.abs(rel.right) > 18) ||
        !gtaLineClear(world, car, other.x - car.x, other.z - car.z, distance(car, other))) continue;
    blockers.push({ body: other, dx: Math.sin(other.heading) * other.speed,
      dz: Math.cos(other.heading) * other.speed, pose: vehicleProbe(other, other.speed) });
  }
  if (!blockers.length) return command;
  const clearanceM = .55;
  const stepTicks = tactical ? 3 : 1, dt = stepTicks * STEP;
  const project = (steer, delay, roads) => {
    const brake = { steer, targetSpeed: 0 };
    const limit = Math.ceil((delay + Math.ceil(speed / (braking * STEP)) + 6) / stepTicks);
    const delaySteps = Math.ceil(delay / stepTicks);
    let pose = { ...vehicleProbe(car, car.speed), gtaYawRate: car.gtaYawRate, gtaSlipMps: car.gtaSlipMps };
    let next = { ...pose };
    for (let i = 0; i < limit; i++) {
      integrateVehicle(pose, i < delaySteps ? command : brake, dt, next);
      if (stepTicks === 1) integrateGtaSlip(pose, next);
      else {
        for (let k = 0; k < stepTicks; k++) integrateGtaSlip(k === 0 ? pose : next, next);
      }
      if (roads && !sweepSafe(pose, next, [], roads).safe) return { tick: i * stepTicks };
      // Only extrapolate observed motion for a bounded interval; do not use the traffic route.
      const time = Math.min(.65, (i + 1) * dt);
      for (const { body, dx, dz, pose: other } of blockers) {
        other.x = body.x + dx * time;
        other.z = body.z + dz * time;
        if (Math.abs(other.x - next.x) > 7 || Math.abs(other.z - next.z) > 7) continue;
        if (overlaps(next, other, clearanceM)) return { body, tick: i * stepTicks };
      }
      if (i >= delaySteps && next.speed <= 0 && Math.abs(next.gtaSlipMps) < .02 && Math.abs(next.gtaYawRate) < .02) return null;
      [pose, next] = [next, pose];
    }
    return null;
  };
  const conflict = project(command.steer, reactionTicks);
  if (!conflict) return command;
  // Braking on its own preserves the conflicting turn. Prefer a supported
  // stopping path, without moving the vehicle or weakening the swept solver.
  const sides = gtaLocal(car, conflict.body).right < 0 ? 1 : -1;
  let best = { steer: command.steer, safeTicks: -1 };
  for (const steer of [command.steer, 0, sides * .2, -sides * .2]) {
    const blocked = project(steer, 0, world.roads);
    if (!blocked) { best = { steer, safeTicks: Infinity }; break; }
    if (blocked.tick > best.safeTicks) best = { steer, safeTicks: blocked.tick };
  }
  return { ...command, steer: best.steer, targetSpeed: 0, reason: "traffic-yield", blockedBy: conflict.body.id };
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
  if (r && !s.gta?.curbExitPhase) {
    const event = updatePursuitResponse(world);
    if (event) logEvent(world, event, r.lastSeen ?? s.playerStart);
  }
  if (s.gta) {
    // Terminal results must not hand an off-road body back to the ordinary
    // road-only World. Latch the result and let the driver physically return.
    const cityCurbs = s.gta.curb?.mode === METRO_CITY_CURBS;
    if (s.gta.curbExitPhase) {
      if (cityCurbs && s.gta.curbExitPhase === "busted" && Math.hypot(ego.speed, ego.gtaSlipMps ?? 0) >= .8) {
        s.gta.curbExitPhase = null;
        s.gta.curbExitTick = null;
        s.gta.pinnedTicks = 0;
        s.metrics.capturePressureS = 0;
      } else if (!ego.curbSupportId || (cityCurbs && world.tick - (s.gta.curbExitTick ?? world.tick) >=
          (s.gta.curbExitPhase === "escaped" && isTacticalPursuit(s) ? 12 :
            s.gta.curbExitPhase === "busted" && (ego.wait ?? 0) >= .5 ? 36 : 180))) {
        if (ego.curbSupportId) {
          if (!returnEgoFromCityCurb(world, s)) return;
          s.metrics.shoulderExits++;
        }
        s.phase = s.gta.curbExitPhase;
        s.metrics.escape = s.phase === "escaped";
        if (s.metrics.escape) s.response.dispatch.state = "ESCAPED";
        s.gta.curbExitPhase = null;
        s.gta.curbExitTick = null;
      }
    } else {
      const dispatchState = s.gta.curb && ego.curbSupportId ? s.response.dispatch.state : null;
      updateGtaPhase(world);
      if (dispatchState !== null && s.phase !== "running") {
        s.gta.curbExitPhase = s.phase;
        s.gta.curbExitTick = world.tick;
        s.phase = "running";
        s.metrics.escape = false;
        s.response.dispatch.state = dispatchState;
      }
    }
    return;
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
  const actorsBeforeSquad = world.actors.length;
  const firstBefore = world.actors[0], lastBefore = world.actors[actorsBeforeSquad - 1];
  if (s.gta) {
    s.stepEvents.length = 0;
    s.gta.eventTick = world.tick + 1;
    if (!s.gta.curbExitPhase) {
      maintainGtaSquad(world);
      if (s.gta.escapeGoal && !s.gta.escapeGoal.sensorPlanned) advanceEscapeGoalIfReached(world);
    }
  }
  if (s.survival) updateSurvivalBeforeMotion(world);
  if (!s.gta) updateEvents(world);
  world.actorIndex = new SpatialIndex(world.actors);
  const tacticalV5 =
    isTacticalPursuit(s) &&
    (world.config?.cityVersion ?? 0) >= 5 &&
    (world.actors?.length ?? 0) >= 220;
  const px = player.x, pz = player.z;
  for (let i = 0; i < world.actors.length; i++) {
    const a = world.actors[i];
    if (tacticalV5 && a !== player && a.previous) {
      a.previous.x = a.x;
      a.previous.z = a.z;
      a.previous.heading = a.heading;
      a.previous.speed = a.speed;
      a.previous.y = a.y;
    } else {
      a.previous = copyPose(a);
    }
  }
  const plans = world.actors.map((a, idx) => {
    const inPatrols = Boolean(s.patrols?.has?.(a));
    if (tacticalV5 && a !== player && !inPatrols && !hasCivilianGtaSlip(a) && !isCrowdAheadPedestrian(a)) {
      const dx = a.x - px, dz = a.z - pz;
      const distSq = dx * dx + dz * dz;
      const lodDistSq = a.type === "pedestrian" ? 65 * 65 : 72 * 72;
      if (distSq > lodDistSq) {
        const strideMask = distSq > 120 * 120 ? 7 : 3;
        if (((world.tick + idx) & strideMask) !== 0) {
          const cached = distantActorCmdCache.get(a);
          if (cached && world.tick - cached.tick <= strideMask) {
            if (a.type === "pedestrian") {
              if (a.speed === 0 && (a.pause ?? 0) > STEP) {
                const next = { ...a, pause: Math.max(0, a.pause - STEP) };
                const rad = shapeRadius(a);
                return { a, next, command: null, guard: "clear", travel: 0, radius: rad, stop: 1, hit: null };
              }
              const goal = a.target ?? a.walkGoal;
              if (a.speed > 0 && (a.pause ?? 0) === 0 && goal &&
                  (goal.x - a.x) ** 2 + (goal.z - a.z) ** 2 > 4.84) {
                const next = {
                  ...a,
                  x: a.x + Math.sin(a.heading) * a.speed * STEP,
                  z: a.z + Math.cos(a.heading) * a.speed * STEP,
                  accelerationMps2: 0,
                  turnRateRadS: 0,
                };
                const rad = shapeRadius(a);
                return { a, next, command: null, guard: "clear", travel: travel(a, next, rad), radius: rad, stop: 1, hit: null };
              }
            }
            if (a.type === "vehicle" && cached.cmd) {
              const cmd = cached.cmd;
              const rad = shapeRadius(a);
              let next = integrateVehicle(a, cmd, STEP, Object.assign(vehicleProbe(a, a.speed), {
                id: a.id, kind: a.kind, y: a.y, supportHeightM: a.supportHeightM,
              }));
              next.reason = cmd.reason ?? "driving";
              next.blockedBy = cmd.blockedBy ?? null;
              let swept = travel(a, next, rad), guard = "clear";
              const onOwnRoad = a.road && bodyOnRoad(next, [a.road]);
              if (swept > 0 && !onOwnRoad && !sweepSafe(a, next, [], world.roads).safe) {
                guard = "road-boundary";
                swept = 0;
                next = { ...a, speed: 0, steer: next.steer, reason: guard, blockedBy: null };
              }
              return { a, next, command: cmd, guard, travel: swept, radius: rad, stop: 1, hit: null };
            }
          }
        }
      }
    }
    const plan = motionPlan(world, a, requested, streetHooks);
    if (tacticalV5 && a !== player) {
      distantActorCmdCache.set(a, { tick: world.tick, cmd: plan.command });
    }
    return plan;
  });
  const ego = plans.find((p) => p.a === player);
  if (ego.curb) {
    // Reactive props are physical solids handled by the swept contact solver.
    // Keep predictive curb/pedestrian support checks, without a zero-speed
    // teleport in front of the prop that would swallow its actual impact.
    const clearanceWorld = world.statics.some(body => body.propImpact)
      ? { ...world, statics: world.statics.filter(body => !body.propImpact) } : world;
    const nearReactiveProp = world.statics.some(body => {
      if (!body.propImpact) return false;
      const { forward, right } = gtaLocal(player, body);
      return forward > -player.length / 2 && forward < 8 + Math.abs(player.speed) * .3 &&
        Math.abs(right) < player.width / 2 + Math.hypot(body.width, body.length) / 2 + .3;
    });
    const clearanceCurb = nearReactiveProp
      ? { ...ego.curb, maxPace: Math.max(ego.curb.maxPace,
        Math.hypot(player.speed, player.gtaSlipMps ?? 0),
        Math.hypot(ego.next.speed, ego.next.gtaSlipMps ?? 0)) + .001 }
      : ego.curb;
    const immediateContactWorld = nearReactiveProp ? { ...clearanceWorld, statics: [] } : clearanceWorld;
    const rejected = curbClearance(immediateContactWorld, clearanceCurb, ego, plans, projectGtaVehicle);
    if (rejected) {
      const { reason, blockedBy = null } = rejected;
      ego.guard = reason;
      ego.command = { ...ego.command, targetSpeed: 0, reason, blockedBy,
        decelerationMps2: player.spec?.braking ?? VEHICLE.braking };
      const brakingPose = projectGtaVehicle(player, ego.command);
      const braking = { ...ego, next: brakingPose, travel: travel(player, brakingPose, ego.radius) };
      if ((reason === "curb-pedestrian" || reason === "curb-solid") &&
          !curbClearance(immediateContactWorld, clearanceCurb, braking, plans, projectGtaVehicle)) {
        ego.next = { ...brakingPose, reason, blockedBy };
        ego.travel = braking.travel;
      } else {
        ego.travel = 0;
        ego.next = { ...player, speed: 0, steer: ego.next.steer, reason, blockedBy,
          gtaSlipMps: 0, gtaYawRate: 0 };
      }
    }
  }
  const staticGrid = s.street && s.response?.dispatch && dispatchStaticContacts(world);
  const solids = staticGrid?.plans ?? world.statics.map(staticContactPlan);
  const freshImpacts = s.gta?.config.damageFeedback === DISPATCH_DAMAGE_FEEDBACK ? [] : null;
  const impact = resolveContacts(world, plans, solids, staticGrid, freshImpacts);
  if (s.gta) slideAlongFixedProp(world, plans);
  updateClearance(world, ego, plans, solids);
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
  const gtaPlayerScrape = consumeGtaPlayerScrape(s);
  const reuseAcceptedPose = Boolean(s.response?.dispatch) || usesRushPace(s.variant);
  for (const p of plans) {
    const a = p.a, accepted = poseAt(p, 1);
    const next = reuseAcceptedPose && a !== accepted ? accepted : { ...accepted };
    const acceptedDistance = distance(a, next);
    const gtaBody = s.gta && (a === player || s.patrols.has(a));
    const civilianTwoBody =
      !gtaBody &&
      s.gta &&
      world.config?.interactionProfile === WHEEL_SCRUB_MODE &&
      a.type === "vehicle" &&
      Boolean(p.impulse);
    if (p.hit) {
      if (gtaBody) {
        Object.assign(next, p.impulse, { reason: "contact", blockedBy: p.hit });
      } else if (civilianTwoBody) {
        next.speed = p.impulse.speed;
        setCivilianGtaImpulse(a, p.impulse);
        next.reason = "contact";
        next.blockedBy = p.hit;
      } else {
        Object.assign(next, { speed: 0, reason: "contact", blockedBy: p.hit });
      }
    }
    if (gtaBody) {
      next.health = a.health;
      next.aiState = a.aiState;
      if (a.aiState === "WRECKED") Object.assign(next, { path: a.path, cursor: 0,
        wreckUntilTick: a.wreckUntilTick, speed: 0, gtaSlipMps: 0, gtaYawRate: 0, reason: "WRECKED" });
    }
    let terrainOffsets;
    if (a.type === "pedestrian") {
      next.accelerationMps2 = (next.speed - a.speed) / STEP;
      next.motionTimeS = (world.tick + 1) * STEP;
    } else if (!s.street) {
      next.y = next.supportHeightM = heightOnSupport(s, next);
    } else if ((a === player || canPatrolUseCurbPrivilege(world, a)) && (p.curb || a.curbSupportId)) {
      terrainOffsets = acceptCurbPose(s.gta.curb, world.roads, next);
    }
    if (s.gta && a === player && world.mode === "manual") next.districtSources = null;
    else if (s.street && a.type === "vehicle") {
      const sources = p.command.districtSources ?? a.districtSources;
      if (sources) next.districtSources = p.hit || p.guard !== "clear"
        ? { ...sources, finalMps: (gtaBody || civilianTwoBody) ? Math.abs(next.speed) : 0, appliedSource: "physical-guard" }
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
      const playerSurface = world.terrain
        ? sampleCitySurface(world.terrain, next.x, next.z, next.heading)
        : null;
      const nitroAllowed = Boolean(s.street && s.variant && s.variant !== "legacy") ||
        Object.prototype.hasOwnProperty.call(requested, "nitro");
      if (nitroAllowed) {
        const baseSuppressed = Boolean(a.nitroSuppressedByPedestrian);
        const stepSuppressed = Boolean(baseSuppressed || p.command?._pedSuppressedNitro);
        next.nitroCharge = Number.isFinite(a.nitroCharge) ? a.nitroCharge : 1;
        next.nitroActive = Boolean(a.nitroActive);
        next.nitroIntensity = Number.isFinite(a.nitroIntensity) ? a.nitroIntensity : 0;
        next.nitroSuppressedByPedestrian = stepSuppressed;
        stepNitroTank(next, s.action, STEP);
        next.nitroSuppressedByPedestrian = stepSuppressed;
      } else {
        next.nitroCharge = Number.isFinite(a.nitroCharge) ? a.nitroCharge : 1;
        next.nitroActive = false;
        next.nitroIntensity = Number.isFinite(a.nitroIntensity) ? a.nitroIntensity : 0;
        next.nitroSuppressedByPedestrian = Boolean(a.nitroSuppressedByPedestrian);
      }
      let curbScrub = null;
      if (world.config?.interactionProfile === WHEEL_SCRUB_MODE && s.gta?.curb) {
        const manualCurbDeflect = world.mode === "manual" && !s.frozenDriver && !p.hit;
        curbScrub = computeCurbWheelScrub(a, next, s.gta.curb, world.roads, STEP, {
          applyDeflection: manualCurbDeflect,
        });
        if (manualCurbDeflect && curbScrub.active && curbScrub.adjustedPose !== next) {
          const safeScrub = sweepSafeWithCurbs(a, curbScrub.adjustedPose, null, world.roads, s.gta.curb);
          if (safeScrub.safe) {
            Object.assign(next, curbScrub.adjustedPose);
            terrainOffsets = acceptCurbPose(s.gta.curb, world.roads, next);
          }
        }
      }
      next.vehicle = advanceVehicleState(a, next, applied, STEP, {
          tick: world.tick + 1,
          contact: impact
            ? { ...impact, ...(impactGeometryMap.get(impact) ?? {}), hitId: impact.actorId, proposedTravelM: distance(a, p.next) }
            : null,
          freshImpacts,
          surface: playerSurface,
          curbScrub,
          scraping: gtaPlayerScrape,
        });
      if (impact && next.vehicle.contact) {
        const geometry = impactGeometryMap.get(impact);
        if (geometry?.normal) next.vehicle.contact.normal = { ...geometry.normal };
      }
      if (terrainOffsets) {
        const suspension = next.vehicle.suspension;
        const { wheelOffsetsM } = suspension;
        suspension.terrainOffsetsM = terrainOffsets;
        const limit = playerVehicleDimensions(a).suspensionTravelM;
        for (const wheel of Object.keys(terrainOffsets))
          wheelOffsetsM[wheel] = clamp(wheelOffsetsM[wheel] + terrainOffsets[wheel], -limit, limit);
      }
      const height = next.supportHeightM ?? 0;
      if (s.gta?.curb) {
        if (!a.curbSupportId && next.curbSupportId) m.shoulderEntries++;
        if (a.curbSupportId && !next.curbSupportId) m.shoulderExits++;
      } else {
        if (m.supportHeightM < 0.045 && height >= 0.045) m.shoulderEntries++;
        if (m.supportHeightM >= 0.045 && height < 0.045) m.shoulderExits++;
      }
      m.supportHeightM = height;
      m.maxSupportHeightM = Math.max(m.maxSupportHeightM, height);
      if (blocked && a.reason !== "road-boundary") world.metrics.interventions++;
    }
    Object.assign(a, next, {
      distance: a.distance + acceptedDistance,
      wait: acceptedDistance < 0.001 ? a.wait + STEP : 0,
    });
    if (gtaBody && a !== player) trackGtaPatrolProgress(world, a, p.command, acceptedDistance);
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
  if (s.gta?.scanner && (world.tick - s.startedTick) % PURSUIT_SCAN_TICKS === 0)
    s.gta.scan = s.gta.scanner.sample(world);
  if (isPackPursuit(s.variant) && (s.phase === "crashed" || s.phase === "captured")) {
    s.reviewUntilTick = world.tick + (s.survival ? SURVIVAL_REVIEW_TICKS : PACK_REVIEW_TICKS);
    s.endedTick = world.tick;
    logEvent(world, s.phase, player);
    for (const a of world.actors) a.previous = copyPose(a);
    world.actorIndex = new SpatialIndex(world.actors);
  } else if (s.street && s.phase !== "running") cleanupStreetPursuit(world);
  else world.actorIndex = new SpatialIndex(world.actors);
  syncPursuitStatus(world, s);
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
  const liveRadio = s.gta?.pressure && s.response.unitsInContact > 0 &&
    s.response.lastSeen?.tick === world.tick;
  return {
    level: s.level, caseId: s.caseId, phase: s.phase,
    events: s.events.map((e) => ({ ...e })), metrics: structuredClone(s.metrics),
    action: s.action ? { ...s.action } : null,
    decision: boundedDecision(s.decision), exits: s.exits.map((e) => ({ ...e })),
    ...(usesRushPace(s.variant) ? { variant: s.variant, targetPatrols: s.targetPatrols } : {}),
    ...(s.gta ? { variant: "gta", wantedLevel: s.wantedLevel,
      ...(s.gta.escapeGoal ? { escapeGoal: escapeGoalSnapshot(world) } : {}),
      gta: {
      playerHealth: world.player.health, playerMaxHealth: world.player.maxHealth,
      activePatrols: [...s.patrols].filter(unit => unit.aiState !== "WRECKED").length,
      pinnedRatio: s.gta.pinnedTicks * STEP / GTA_PIN_SECONDS,
      ...(s.gta.pressure ? { packPressure: {
        stage: liveRadio ? s.gta.pressure.stage : 0,
        radioUnits: liveRadio ? [...s.patrols].filter(unit => unit.aiState === "RADIO_SUPPORT").length : 0,
      } } : {}),
      ...(s.gta.curb ? { curbSupport: {
        version: s.gta.config.curbSupport, site: world.player.curbSupportId ?? s.gta.curb.id ?? s.gta.curb.mode ?? null,
        active: Boolean(world.player.curbSupportId), pendingOutcome: s.gta.curbExitPhase ?? null,
      } } : {}),
    } } : {}),
    ...(isRushPack(s.variant) ? { wantedLevel: s.wantedLevel, learning: s.learner?.snapshot() ?? null } : {}),
    ...(isPackPursuit(s.variant) ? { pack: true, packLab: s.packLab === true, driver: s.driver,
      review: s.reviewUntilTick > world.tick } : {}),
    ...(s.response ? { response: pursuitResponseSnapshot(s.response) } : {}),
    ...(s.survival ? { survival: survivalSnapshot(s, world.tick) } : {}),
    ...(s.street ? { street: true, startedTick: s.startedTick, endedTick: s.endedTick,
      appliedCommand: s.appliedCommand ? { ...s.appliedCommand } : null } : {}),
  };
}

const crowdAheadRegistry = new WeakMap();

export function getCrowdAheadCount(world) {
  const entry = world ? crowdAheadRegistry.get(world) : null;
  if (!entry || entry.activeIds.size === 0) return 0;
  const actors = world.actors ?? [];
  if (entry.lastActorsLen !== actors.length) {
    const stillPresent = new Set();
    for (let i = 0; i < actors.length; i++) {
      const id = actors[i]?.id;
      if (id && entry.activeIds.has(id)) stillPresent.add(id);
    }
    entry.activeIds = stillPresent;
    entry.lastActorsLen = actors.length;
  }
  return entry.activeIds.size;
}

export function syncPursuitStatus(world, state = world?.pursuit) {
  if (!state) return null;
  const player = world?.player;
  const crowdAheadCount = world ? getCrowdAheadCount(world) : 0;
  const status = state.status ?? (state.status = {
    phase: state.phase,
    variant: state.variant ?? "legacy",
    wantedLevel: state.wantedLevel ?? state.level,
    nitroCharge: 1,
    nitroActive: false,
    nitroIntensity: 0,
    nitroSuppressedByPedestrian: false,
    crowdAheadCount: 0,
  });
  status.phase = state.phase;
  status.variant = state.variant ?? "legacy";
  status.wantedLevel = state.wantedLevel ?? state.level;
  status.nitroCharge = Number.isFinite(player?.nitroCharge) ? player.nitroCharge : 1;
  status.nitroActive = Boolean(player?.nitroActive);
  status.nitroIntensity = Number.isFinite(player?.nitroIntensity) ? player.nitroIntensity : 0;
  status.nitroSuppressedByPedestrian = Boolean(player?.nitroSuppressedByPedestrian);
  status.crowdAheadCount = crowdAheadCount;
  return status;
}

export function scanPursuitWorld(world) {
  const s = world?.pursuit;
  if (!s?.gta || s.phase !== "running") return null;
  s.gta.scanner = new PursuitScanner();
  const scan = s.gta.scanner.sample(world);
  s.gta.scan = scan;
  return scan;
}

export const DISPERSED_CROWD_LAYOUT = "dispersed-cohorts-v1";

export function spawnCrowdAhead(world, rawCount = 20, options = {}) {
  const dispersed = options.layout === DISPERSED_CROWD_LAYOUT || isFairCityPolice(world.pursuit);
  const targetCount = clamp(
    Math.round(Number.isFinite(Number(rawCount)) ? Number(rawCount) : 20),
    1,
    40,
  );
  const player = world.player;
  let entry = crowdAheadRegistry.get(world);
  if (!entry) {
    entry = { waveSerial: 0, activeIds: new Set(), lastActorsLen: 0 };
    crowdAheadRegistry.set(world, entry);
  }
  const prevActiveIds = new Set(entry.activeIds);

  const wave = entry.waveSerial + 1;
  const rng = new Random(
    `${world.config?.seed ?? "city"}:crowd-ahead:${world.tick}:${wave}:${Math.round(player.x * 100)}:${Math.round(player.z * 100)}`,
  );
  let fx = Math.sin(player.heading ?? 0);
  let fz = Math.cos(player.heading ?? 0);
  const drivableRoads = (world.drivingRoads ?? world.roads ?? []).filter(
    (r) => r && !r.parkingBay && !r.supportApron,
  );
  const allRoads = world.roads ?? drivableRoads;

  let baseRoad = drivableRoads[0] ?? allRoads[0] ?? null;
  let bestRoadScore = -Infinity;
  for (let i = 0; i < drivableRoads.length; i++) {
    const r = drivableRoads[i];
    const frame = roadFrame(r);
    const proj = roadProject(r, player);
    const outsideAlong = Math.max(0, frame.minAlong - proj.along, proj.along - frame.maxAlong);
    const onCorridor = outsideAlong <= r.width * 0.75 && proj.absLateral <= r.width * 0.75;
    const align = Math.abs(fx * frame.ux + fz * frame.uz);
    const score = (onCorridor ? 100 : 0) + align * 20 - proj.absLateral - outsideAlong * 0.5;
    if (score > bestRoadScore) {
      bestRoadScore = score;
      baseRoad = r;
    }
  }

  const baseFrame = baseRoad ? roadFrame(baseRoad) : null;
  const baseProj = baseRoad ? roadProject(baseRoad, player) : null;
  const baseSign = baseFrame
    ? (fx * baseFrame.ux + fz * baseFrame.uz >= 0 ? 1 : -1)
    : 1;
  if (dispersed && baseFrame) {
    fx = baseFrame.ux * baseSign;
    fz = baseFrame.uz * baseSign;
  }
  const startAlong = baseFrame
    ? clamp(baseProj.along, baseFrame.minAlong, baseFrame.maxAlong)
    : 0;
  const availAhead = baseFrame
    ? (baseSign > 0 ? baseFrame.maxAlong - startAlong : startAlong - baseFrame.minAlong)
    : 0;

  const turnBranches = [];
  if (baseRoad && availAhead < 43) {
    for (let i = 0; i < drivableRoads.length; i++) {
      const other = drivableRoads[i];
      if (other === baseRoad) continue;
      const hit = roadIntersection(baseRoad, other, 1.5);
      if (!hit) continue;
      const distToJunc = (hit.alongA - startAlong) * baseSign;
      if (distToJunc < -2 || distToJunc > 43) continue;
      const oFrame = roadFrame(other);
      const signs = other.flow ? [other.flow] : [1, -1];
      for (const sgn of signs) {
        const branchAvail = sgn > 0 ? oFrame.maxAlong - hit.alongB : hit.alongB - oFrame.minAlong;
        if (branchAvail >= 8) {
          turnBranches.push({
            road: other,
            frame: oFrame,
            hitAlongB: hit.alongB,
            sign: sgn,
            distToJunc: Math.max(0, distToJunc),
            avail: branchAvail,
          });
        }
      }
    }
  }

  const vehicleObstacles = [];
  const existingPedestrians = [];
  for (let i = 0; i < world.actors.length; i++) {
    const a = world.actors[i];
    if (a.type === "vehicle") vehicleObstacles.push(a);
    else if (a.type === "pedestrian" && (dispersed || !prevActiveIds.has(a.id))) existingPedestrians.push(a);
  }
  const solidBuildings = [];
  for (let i = 0; i < world.statics.length; i++) {
    const st = world.statics[i];
    if (st.kind === "parked-vehicle") vehicleObstacles.push(st);
    else solidBuildings.push(st);
  }

  const isSurfaceAndStaticClear = (x, z, pad = 0.28) => {
    const pt = { x, z };
    if (allRoads.length > 0 && !pointOnRoad(pt, allRoads, -1.55)) return false;
    const probe = { type: "pedestrian", radius: 0.38, x, z };
    for (let i = 0; i < solidBuildings.length; i++) {
      const st = solidBuildings[i];
      const maxSpan = ((st.width ?? 0) + (st.length ?? 0)) * 0.5 + 2.0;
      if (Math.abs(st.x - x) > maxSpan || Math.abs(st.z - z) > maxSpan) continue;
      if (overlaps(probe, st, pad)) return false;
    }
    for (let i = 0; i < vehicleObstacles.length; i++) {
      const v = vehicleObstacles[i];
      if (v === player) continue;
      if (Math.abs(v.x - x) > 8 || Math.abs(v.z - z) > 8) continue;
      if (overlaps(probe, v, 0.25)) return false;
    }
    return true;
  };

  const isSpawnClear = (x, z) => {
    const pt = { x, z };
    if (distance(pt, player) < 18.5) return false;
    if (!isSurfaceAndStaticClear(x, z, 0.30)) return false;
    const probe = { type: "pedestrian", radius: 0.38, x, z };
    for (let i = 0; i < vehicleObstacles.length; i++) {
      const v = vehicleObstacles[i];
      if (distance(pt, v) < 2.2 || overlaps(probe, v, 0.45)) return false;
    }
    for (let i = 0; i < existingPedestrians.length; i++) {
      if (distance(pt, existingPedestrians[i]) < 1.06) return false;
    }
    return true;
  };

  // Longitudinal cohorts alternate sidewalks while retaining a vehicle-width centre gap.
  let negOffsetBlockers = 0;
  let posOffsetBlockers = 0;
  for (const obs of [...vehicleObstacles, ...solidBuildings]) {
    if (obs === player) continue;
    const dx = obs.x - player.x;
    const dz = obs.z - player.z;
    const fwd = dx * fx + dz * fz;
    if (fwd < 8 || fwd > 52) continue;
    const offset = baseRoad ? roadProject(baseRoad, obs).leftOffset : -dx * fz + dz * fx;
    if (Math.abs(offset) <= 9.5) {
      const oncoming =
        obs.type === "vehicle" &&
        fx * Math.sin(obs.heading ?? 0) + fz * Math.cos(obs.heading ?? 0) < -0.3;
      const weight = oncoming ? 3 : 1;
      if (offset < 0) negOffsetBlockers += weight;
      else posOffsetBlockers += weight;
    }
  }
  const openBypassOffsetSign =
    negOffsetBlockers !== posOffsetBlockers
      ? negOffsetBlockers < posOffsetBlockers
        ? -1
        : 1
      : rng.next() < 0.5
        ? 1
        : -1;
  const sampleCrowdLat = (halfW, walkerIdx = 99, attempt = 0) => {
    if (dispersed) {
      const side = openBypassOffsetSign * (Math.floor(walkerIdx / 5) % 2 ? -1 : 1);
      return side * rng.range(2.35, Math.max(2.35, halfW - 1.65));
    }
    const outerCrowdLim = halfW + 1.15;
    const innerBypassEdge = Math.max(-1.2, Math.min(2.4, halfW - 3.6));
    const crowdMin = openBypassOffsetSign > 0 ? -outerCrowdLim : -innerBypassEdge;
    const crowdMax = openBypassOffsetSign > 0 ? innerBypassEdge : outerCrowdLim;
    if (walkerIdx < 3 && attempt < 16) {
      const playerBaseLat = baseRoad ? roadProject(baseRoad, player).leftOffset : 0;
      const anchor = clamp(playerBaseLat, crowdMin + .25, crowdMax - .25);
      return clamp(anchor + rng.range(-.45, .45), crowdMin, crowdMax);
    }
    return rng.range(crowdMin, crowdMax);
  };

  const sampleCorridorPose = (corridorDistM, branchChoice, walkerIdx = 99, attempt = 0) => {
    if (baseRoad && corridorDistM <= availAhead - 1.2) {
      const along = clamp(startAlong + baseSign * corridorDistM, baseFrame.minAlong + 1.2, baseFrame.maxAlong - 1.2);
      const halfW = (baseRoad.width ?? 10) * 0.5;
      const lat = sampleCrowdLat(halfW, walkerIdx, attempt);
      const pt = roadPointAt(baseRoad, along, lat);
      return {
        x: pt.x,
        z: pt.z,
        along,
        lat,
        side: lat >= 0 ? 1 : -1,
        road: baseRoad,
        frame: baseFrame,
        dirSign: baseSign,
        onStraightCorridor: true,
        corridorDistM,
      };
    }
    if (turnBranches.length > 0) {
      const branch = turnBranches[branchChoice % turnBranches.length];
      const rem = Math.max(2.0, corridorDistM - branch.distToJunc);
      const along = clamp(
        branch.hitAlongB + branch.sign * Math.min(rem, branch.avail - 1.5),
        branch.frame.minAlong + 1.2,
        branch.frame.maxAlong - 1.2,
      );
      const halfW = (branch.road.width ?? 10) * 0.5;
      const lat = dispersed ? sampleCrowdLat(halfW, walkerIdx, attempt) : sampleCrowdLat(halfW);
      const pt = roadPointAt(branch.road, along, lat);
      return {
        x: pt.x,
        z: pt.z,
        along,
        lat,
        side: lat >= 0 ? 1 : -1,
        road: branch.road,
        frame: branch.frame,
        dirSign: branch.sign,
        onStraightCorridor: false,
        corridorDistM,
      };
    }
    const rx = dispersed ? fz : Math.cos(player.heading ?? 0);
    const rz = dispersed ? -fx : -Math.sin(player.heading ?? 0);
    const halfW = (baseRoad?.width ?? 10) * 0.5;
    const lat = rng.range(-halfW - 1.0, halfW + 1.0);
    return {
      x: player.x + fx * corridorDistM + rx * lat,
      z: player.z + fz * corridorDistM + rz * lat,
      along: startAlong + baseSign * corridorDistM,
      lat,
      side: lat >= 0 ? 1 : -1,
      road: baseRoad,
      frame: baseFrame,
      dirSign: baseSign,
      onStraightCorridor: true,
      corridorDistM,
    };
  };

  const buildWaypointsFor = (cand, index) => {
    const waypoints = [{ x: cand.x, z: cand.z, crossing: index % 2 === 0 }];
    const segRoad = cand.road;
    const segFrame = cand.frame;
    const halfW = (segRoad?.width ?? 10) * 0.5;
    const isCrossing = index >= 3 && index % 2 === 0;

    const cohortSide = cand.lat >= 0 ? 1 : -1;
    const innerEdge = Math.max(-1.2, Math.min(2.4, halfW - 3.6));
    const minCrowdLat = dispersed ? (cohortSide > 0 ? 2.35 : -halfW + 1.65)
      : openBypassOffsetSign > 0 ? -halfW - 1.2 : -innerEdge;
    const maxCrowdLat = dispersed ? (cohortSide > 0 ? halfW - 1.65 : -2.35)
      : openBypassOffsetSign > 0 ? innerEdge : halfW + 1.2;
    const tryAddPoint = (dAlong, targetLat, crossingFlag) => {
      const clampedLat = clamp(targetLat, minCrowdLat, maxCrowdLat);
      if (minCrowdLat > maxCrowdLat) return false;
      if (dispersed) dAlong = clamp(dAlong, -4, 4);
      let pt;
      if (segRoad && segFrame) {
        const a = clamp(cand.along + dAlong, segFrame.minAlong + 1.4, segFrame.maxAlong - 1.4);
        pt = roadPointAt(segRoad, a, clampedLat);
      } else {
        const rx = dispersed ? fz : Math.cos(player.heading ?? 0);
        const rz = dispersed ? -fx : -Math.sin(player.heading ?? 0);
        pt = {
          x: cand.x + fx * dAlong + rx * (clampedLat - cand.lat),
          z: cand.z + fz * dAlong + rz * (clampedLat - cand.lat),
        };
      }
      if (!isSurfaceAndStaticClear(pt.x, pt.z, 0.25)) return false;
      if (waypoints.some((w) => distance(w, pt) < 3.0)) return false;
      waypoints.push({ x: pt.x, z: pt.z, crossing: crossingFlag });
      return true;
    };

    if (isCrossing) {
      const oppSign = cand.lat >= 0 ? -1 : 1;
      const lat1 = oppSign * rng.range(Math.max(1.8, halfW * 0.55), halfW + 1.15);
      const d1 = rng.range(-5.5, 5.5);
      tryAddPoint(d1, lat1, true);
      tryAddPoint(d1 + (rng.next() < 0.5 ? 1 : -1) * rng.range(6.0, 12.0), lat1 * rng.range(0.65, 1.0), false);
      tryAddPoint(rng.range(-4.5, 4.5), -lat1 * rng.range(0.4, 0.95), true);
    } else {
      const walkSign = rng.next() < 0.5 ? 1 : -1;
      const d1 = walkSign * rng.range(8.0, 15.0);
      const l1 = clamp(cand.lat + rng.range(-3.6, 3.6), -halfW - 1.15, halfW + 1.15);
      tryAddPoint(d1, l1, Math.abs(l1 - cand.lat) > 2.2);
      const d2 = walkSign * rng.range(3.5, 10.5);
      const l2 = clamp(-cand.lat * 0.6 + rng.range(-2.8, 2.8), -halfW - 1.15, halfW + 1.15);
      tryAddPoint(d2, l2, true);
      tryAddPoint(-walkSign * rng.range(5.0, 11.0), cand.lat + rng.range(-1.8, 1.8), false);
    }

    if (waypoints.length < 2) {
      for (const dAlong of [7, -7, 11, -11, 4.5, -4.5]) {
        for (const tLat of [0, -halfW * 0.75, halfW * 0.75, -halfW - 0.9, halfW + 0.9]) {
          if (tryAddPoint(dAlong, tLat, Math.abs(tLat - cand.lat) > 2.0) && waypoints.length >= 3) break;
        }
        if (waypoints.length >= 3) break;
      }
    }
    return waypoints;
  };

  const ids = [];
  const stagedPeople = [];
  let minForwardM = Infinity;
  let maxForwardM = -Infinity;
  let maxAbsLateralM = 0;
  const MAX_CROWD_LATERAL_M = 16.0;
  const rxPlayer = dispersed ? fz : Math.cos(player.heading ?? 0);
  const rzPlayer = dispersed ? -fx : -Math.sin(player.heading ?? 0);

  const maxForwardMForWave = dispersed ? 32 + 20 * (Math.ceil(targetCount / 5) - 1) : 41.8;
  const forwardBandSegs = [];
  for (let rIdx = 0; rIdx < drivableRoads.length; rIdx++) {
    const r = drivableRoads[rIdx];
    const rf = roadFrame(r);
    const steps = Math.max(8, Math.ceil(rf.length / 6));
    for (let s = 0; s <= steps; s++) {
      const a = rf.minAlong + (rf.length * s) / steps;
      const pt = roadPointAt(r, a, 0);
      const fwd = (pt.x - player.x) * fx + (pt.z - player.z) * fz;
      const lat = Math.abs((pt.x - player.x) * rxPlayer + (pt.z - player.z) * rzPlayer);
      if (fwd >= 22.2 && fwd <= maxForwardMForWave && lat <= MAX_CROWD_LATERAL_M + 4.0) {
        forwardBandSegs.push({ road: r, frame: rf, along: a });
      }
    }
  }

  for (let i = 0; i < targetCount; i++) {
    const bandLo = dispersed ? 22.2 + 20 * Math.floor(i / 5) : 22.2 + (16.2 * i) / targetCount;
    const bandHi = dispersed ? bandLo + 9.2 : 22.2 + (16.2 * (i + 1)) / targetCount;
    let chosen = null;
    let chosenWaypoints = null;
    let chosenForwardM = 0;
    let chosenAbsLateralM = 0;

    for (let attempt = 0; attempt < 360; attempt++) {
      const corridorDistM = dispersed || attempt < 32 ? rng.range(bandLo, bandHi) : rng.range(22.2, 41.6);
      let cand;
      if (attempt < 64) {
        cand = sampleCorridorPose(corridorDistM, i + attempt, i, attempt);
      } else if (attempt < 190 || forwardBandSegs.length === 0) {
        const latSpan = attempt < 130 ? 10.5 : MAX_CROWD_LATERAL_M;
        const lat = rng.range(-latSpan, latSpan);
        const tx = player.x + fx * corridorDistM + rxPlayer * lat;
        const tz = player.z + fz * corridorDistM + rzPlayer * lat;
        let nearRoad = baseRoad;
        let nearFrame = baseFrame;
        let nearAlong = startAlong + baseSign * corridorDistM;
        let nearLat = lat;
        for (let rIdx = 0; rIdx < drivableRoads.length; rIdx++) {
          const r = drivableRoads[rIdx];
          if (pointOnRoad({ x: tx, z: tz }, [r], -1.45)) {
            nearRoad = r;
            nearFrame = roadFrame(r);
            const pr = roadProject(r, { x: tx, z: tz });
            nearAlong = pr.along;
            nearLat = pr.leftOffset;
            break;
          }
        }
        cand = {
          x: tx,
          z: tz,
          along: nearAlong,
          lat: nearLat,
          side: nearLat >= 0 ? 1 : -1,
          road: nearRoad,
          frame: nearFrame,
          dirSign: baseSign,
          onStraightCorridor: true,
          corridorDistM,
        };
      } else {
        const seg = forwardBandSegs[(i * 13 + attempt) % forwardBandSegs.length];
        const halfW = (seg.road.width ?? 10) * 0.5;
        const along = clamp(seg.along + rng.range(-3.5, 3.5), seg.frame.minAlong + 1.2, seg.frame.maxAlong - 1.2);
        const lat = rng.range(-halfW - 1.1, halfW + 1.1);
        const pt = roadPointAt(seg.road, along, lat);
        cand = {
          x: pt.x,
          z: pt.z,
          along,
          lat,
          side: lat >= 0 ? 1 : -1,
          road: seg.road,
          frame: seg.frame,
          dirSign: 1,
          onStraightCorridor: false,
          corridorDistM,
        };
      }
      const rawFwd = (cand.x - player.x) * fx + (cand.z - player.z) * fz;
      const rawAbsLat = Math.abs((cand.x - player.x) * rxPlayer + (cand.z - player.z) * rzPlayer);
      const euclidM = Math.hypot(cand.x - player.x, cand.z - player.z);
      if (
        rawFwd < (dispersed ? bandLo - .2 : 22) ||
        rawFwd > (dispersed ? bandHi + .2 : 42) ||
        rawAbsLat > MAX_CROWD_LATERAL_M ||
        euclidM < 22.0 ||
        euclidM > (dispersed ? maxForwardMForWave + 5 : 46) ||
        (dispersed && (!cand.road || Math.abs(cand.lat) < 2.35 ||
          Math.abs(cand.lat) > (cand.road.width ?? 10) / 2 - 1.55))
      )
        continue;
      if (!isSpawnClear(cand.x, cand.z)) continue;
      const wps = buildWaypointsFor(cand, i);
      if (wps.length < 2) continue;
      chosen = cand;
      chosenWaypoints = wps;
      chosenForwardM = rawFwd;
      chosenAbsLateralM = rawAbsLat;
      break;
    }

    if (!chosen) continue;

    const id = `crowd-ahead-${wave}-${ids.length + 1}`;
    const walkSpeed = rng.range(1.18, 1.76);
    const firstWp = chosenWaypoints[1];
    const initHeading = Math.atan2(firstWp.x - chosen.x, firstWp.z - chosen.z);
    const initSpeed = rng.range(0.92, Math.min(1.42, walkSpeed));
    const nearestWalkwayId = world.district?.walkways?.find((w) => w.roadId === chosen.road?.id)?.id ?? null;

    const person = createPedestrian({
      id,
      kind: PEOPLE_MODELS[(wave * 7 + i) % PEOPLE_MODELS.length],
      x: chosen.x,
      z: chosen.z,
      along: chosen.along,
      side: chosen.side,
      roadId: chosen.road?.id ?? null,
      heading: initHeading,
      walkwayId: nearestWalkwayId,
      roadPreference: chosen.road?.zone === "avenue" ? "avenue" : "market",
      road: chosen.road,
      speed: initSpeed,
      walkSpeed,
      phase: rng.next(),
      reason: firstWp.crossing ? "crossing" : "walking",
      target: { x: firstWp.x, z: firstWp.z },
      pause: 0,
      crossing: Boolean(firstWp.crossing),
      motionMode: "ambient",
      motionTimeS: world.tick * STEP,
    });

    if (world.district) {
      initializeDistrictActor(world, person);
      person.district.holdAtTarget = false;
      person.district.yieldAtCurb = false;
      person.district.routeConstrained = true;
      person.walkDirection = 1;
      person.walkGoal = { x: firstWp.x, z: firstWp.z };
      person.walkPlanTick = world.tick;
      person.walkRoute = [{ x: firstWp.x, z: firstWp.z }];
    }
    registerCrowdAheadRoute(person, chosenWaypoints, 1);
    person.previous = copyPose(person);

    stagedPeople.push(person);
    existingPedestrians.push(person);
    ids.push(id);
    if (chosenForwardM < minForwardM) minForwardM = chosenForwardM;
    if (chosenForwardM > maxForwardM) maxForwardM = chosenForwardM;
    if (chosenAbsLateralM > maxAbsLateralM) maxAbsLateralM = chosenAbsLateralM;
  }

  if (stagedPeople.length < targetCount) {
    const failedSummary = {
      ok: false,
      reason: "no-reachable-road-in-forward-corridor",
      tick: world.tick,
      spawned: 0,
      nearestForwardM: null,
      farthestForwardM: null,
      maxAbsLateralM: null,
      corridorUx: baseFrame ? baseFrame.ux * baseSign : fx,
      corridorUz: baseFrame ? baseFrame.uz * baseSign : fz,
      ids: [],
      preservedPreviousCount: prevActiveIds.size,
    };
    world.lastCrowdSpawn = failedSummary;
    syncPursuitStatus(world);
    return failedSummary;
  }

  entry.waveSerial = wave;
  if (!dispersed && prevActiveIds.size > 0) {
    for (let i = world.actors.length - 1; i >= 0; i--) {
      if (prevActiveIds.has(world.actors[i].id)) world.actors.splice(i, 1);
    }
    if (world.pursuit?.yieldingFor && prevActiveIds.has(world.pursuit.yieldingFor.id))
      world.pursuit.yieldingFor = null;
    entry.activeIds.clear();
  }
  for (let i = 0; i < stagedPeople.length; i++) {
    world.actors.push(stagedPeople[i]);
    entry.activeIds.add(stagedPeople[i].id);
  }

  entry.lastActorsLen = world.actors.length;
  world.actorIndex = new SpatialIndex(world.actors);
  world.updateSensors(false);
  if (world.pursuit?.gta && world.pursuit.phase === "running") {
    const freshScan = scanPursuitWorld(world);
    const hasForwardScannedPed =
      Boolean(
        freshScan?.rays?.some(
          (r, rIdx) => (rIdx <= 8 || rIdx >= 64) && r.kind === "pedestrian" && r.rangeM <= 42,
        ),
      ) ||
      Boolean(
        freshScan?.tracks?.some(
          (t) =>
            t.kind === "pedestrian" &&
            t.forwardM >= -1.0 &&
            t.forwardM <= 42.0 &&
            Math.abs(t.rightM) <= (player.width ?? 2.0) * 0.5 + 5.5,
        ),
      );
    if (hasForwardScannedPed && !world.pursuit?.frozenDriver?._faultIgnorePedestrianNitroOnly) {
      player.nitroActive = false;
      player.nitroSuppressedByPedestrian = true;
      if (world.pursuit.manualAction?.nitro) {
        const { steer, throttle, brake, gear } = world.pursuit.manualAction;
        world.pursuit.manualAction = { steer, throttle, brake, gear };
      }
    }
  }

  const summary = {
    ok: true,
    ...(dispersed ? { layout: DISPERSED_CROWD_LAYOUT, retainedPreviousCount: prevActiveIds.size,
      clearCentreWidthM: 3.94, cohortSpacingM: 20 } : {}),
    tick: world.tick,
    spawned: ids.length,
    nearestForwardM: ids.length > 0 ? minForwardM : null,
    farthestForwardM: ids.length > 0 ? maxForwardM : null,
    maxAbsLateralM: ids.length > 0 ? maxAbsLateralM : null,
    corridorUx: baseFrame ? baseFrame.ux * baseSign : fx,
    corridorUz: baseFrame ? baseFrame.uz * baseSign : fz,
    ids: [...ids],
  };
  world.lastCrowdSpawn = summary;
  syncPursuitStatus(world);
  return summary;
}
