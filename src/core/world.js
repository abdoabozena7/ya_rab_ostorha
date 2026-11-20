import { nextWalk, pedestrianMotion } from "./pedestrian.js";
import { createPedestrianBody, setPedestrianMotionMode } from "./pedestrian-body.js";
import { safeSpeed } from "./traffic-control.js";
import {
  updateJunctions,
  junctionGroups,
  insideJunction,
} from "./junctions.js";
import {
  STEP,
  VERSION,
  VEHICLE,
  PEOPLE_MODELS,
  settings,
  districtOptions,
  clamp,
} from "./config.js";
import { Random } from "./random.js";
import {
  angleDelta,
  distance,
  bodyOnRoad,
  overlaps,
  pointOnRoad,
  sweepSafe,
} from "./geometry.js";
import {
  createRoadGraph,
  planNavigation,
  junctionPressure,
  LANE_OFFSET,
} from "./navigation.js";
import { integrateVehicle, followPath, resolveVehicleContact } from "./vehicle.js";
import { createVehicleState, advanceVehicleState } from "./vehicle-state.js";
import { PLAYER_VEHICLE } from "./vehicle-spec.js";
import { roadLayout } from "./roads.js";
import { cityFootprints } from "./scenery.js";
import { SpatialIndex } from "./spatial-index.js";
import { triggerScenario, updateScenarios } from "./scenarios.js";
import { parkingBays, planArrival } from "./arrival.js";
import { policySpeed, validatePolicy } from "./policy.js";
import { trafficQueueStats } from "./queue-metrics.js";
import { signalSpeedLimit } from "./signals.js";
import { VisualCrossingPredictor } from "./visual-prediction.js";
import { createVisionScenario, advanceVisionActor } from "./vision-scenarios.js";
import { createEgyptDistrict } from "./egypt-district.js";
import { createUnifiedCity, METRO_POPULATION_LIMITS,
  RUSH_CITY_POPULATION_DEFAULTS, RUSH_CITY_POPULATION_LIMITS } from "./unified-city.js";
import { advanceCityEncounters, capCityEncounter, createCityEncounters } from "./city-encounters.js";
import { planDistrictRoute } from "./district-navigation.js";
import {
  createDistrictBehaviorState, initializeDistrictActor, nextDistrictWalk,
  stepDistrictPedestrian, updateDistrictTraffic, districtTrafficCommand,
  districtBehaviorDiagnostics, isPackPursuit, planDistrictTrafficTrip, usesRushPace,
} from "./district-behavior.js";
import { createDistrictCase, advanceDistrictCase } from "./district-scenarios.js";
import { createPursuitState, populatePursuit, stepPursuit, pursuitSnapshot,
  beginStreetPursuit, endStreetPursuit, startPackDrill, stepPackReview } from "./pursuit-world.js";
import { canEndSurvival, isCityHunt, isSurvival, survivalGhostPair } from "./pursuit-survival.js";
import { createPackLearner, starterPackPolicy, validatePackPolicy } from "./pack-driving.js";
import { PURSUIT_STOP, validatePursuitAction } from "./pursuit-controls.js";
import {
  observePursuit, selectPursuitRoute, selectStreetPursuitRoute,
  createArcadeLearner, decidePursuit, validatePursuitPolicy, PURSUIT_DECISION_TICKS,
} from "./pursuit-policy.js";
import {
  createDistrictSpeedState, decideDistrictVisualSpeed, mappedDistrictSpeed,
  composeDistrictSpeed, attributeDistrictApplied,
} from "./visual-speed-policy.js";
import {
  measureVehicleSensors,
  RangeSignalProcessor,
} from "../signal_processing/range-sensors.js";

export const LAB_ROADS = [
  ...[-20, 20].map((fixed) => ({
    axis: "z",
    fixed,
    min: -40,
    max: 40,
    width: 10,
  })),
  ...[-40, 0, 40].map((fixed) => ({
    axis: "x",
    fixed,
    min: -20,
    max: 20,
    width: 10,
  })),
];
const vehicleStart = { x: 20 - LANE_OFFSET, z: -25, heading: 0 };
export const VEHICLE_TEST_BARRIER = Object.freeze({
  id: "vehicle-impact-barrier",
  type: "static",
  kind: "barrier",
  x: vehicleStart.x,
  z: -8.6,
  heading: 0,
  width: 3.6,
  length: 0.8,
  height: 0.9,
});
const carKinds = ["sedan", "taxi", "suv", "van", "tuktuk", "tuktuk"];
const pose = (road, along, side = 1, offset = LANE_OFFSET) =>
  road.axis === "z"
    ? {
        x: road.fixed - side * offset,
        z: along,
        heading: side === 1 ? 0 : Math.PI,
      }
    : {
        x: along,
        z: road.fixed + side * offset,
        heading: side === 1 ? Math.PI / 2 : -Math.PI / 2,
      };
const copyPose = (a) => ({
  id: a.id,
  type: a.type,
  x: a.x,
  z: a.z,
  heading: a.heading,
  speed: a.speed,
  length: a.length,
  width: a.width,
  radius: a.radius,
});
function freezePath(path) {
  if (!Object.isFrozen(path)) {
    path.forEach(Object.freeze);
    Object.freeze(path);
  }
}

/** Authoritative, DOM-free simulation. Only step() commits movement. */
export class World {
  constructor(options = {}, environment = "city") {
    const cityVersion = environment === "metro" ? options.cityVersion ?? 2 : null;
    const rush = cityVersion === 4;
    this.config = settings(rush ? { ...RUSH_CITY_POPULATION_DEFAULTS, speedLimit: 48, ...options } : options,
      rush ? RUSH_CITY_POPULATION_LIMITS : cityVersion === 3 ? METRO_POPULATION_LIMITS : null);
    this.environment = environment;
    this.pursuit = environment === "pursuit" ? createPursuitState(options) : null;
    if (this.pursuit) Object.assign(this.config, {
      pursuitLevel: this.pursuit.level, pursuitCase: this.pursuit.caseId,
      ...(this.pursuit.packLab ? { pursuitVariant: this.pursuit.variant } : {}),
    });
    if (environment === "egypt") Object.assign(this.config, districtOptions(options));
    this.district = environment === "metro" ? { ...createUnifiedCity({ dense: cityVersion >= 3, rush }), metro: true } :
      environment === "egypt" ? createEgyptDistrict() : null;
    this.districtCase = environment === "egypt"
      ? createDistrictCase(this.district, this.config.districtCase, this.config.seed) : null;
    if (this.district) {
      if (environment === "metro") {
        if (![1, 2, 3, 4].includes(cityVersion))
          throw new Error("Unsupported city layout version");
        this.config.cityVersion = cityVersion;
        if (cityVersion >= 2) this.cityEncounters = createCityEncounters(this.config);
      } else this.config.districtVersion = this.district.version;
      this.districtBehavior = createDistrictBehaviorState();
      this.districtSpeedState = createDistrictSpeedState();
    }
    const visualScene = environment === "vision"
      ? createVisionScenario(options.visionCase ?? "cross-left") : null;
    if (visualScene) this.config.visionCase = visualScene.id;
    this.visualPredictor = new VisualCrossingPredictor({
      allowLateClearance: this.district !== null,
      freshMotionSupport: this.district !== null,
    });
    this.visualMode = environment === "metro" ? "sensors-only" : "vision-first";
    this.visualDecision = null;
    this.visionLab = visualScene ? {
      caseId: visualScene.id, phase: "ready", startedTick: null,
      goalZ: visualScene.goalZ, requestedSpeedMps: visualScene.requestedSpeedMps,
      firstVisualBrakeS: null, firstReactiveBrakeS: null,
      firstSensorTriggerS: null, firstLaneEntryS: null,
      completedAtS: null, minimumClearanceM: null,
    } : null;
    this.rng = new Random(`${this.config.seed}:${environment}`);
    this.drivingRoads =
      this.pursuit?.drivingRoads ?? this.district?.drivingRoads ?? visualScene?.roads ?? (environment === "lab" || environment === "vehicle"
        ? LAB_ROADS
        : roadLayout(100).roads);
    this.graph = createRoadGraph(this.drivingRoads);
    this.junctions = [...this.graph.values()].filter(
      (n) => n.edges.length >= 3,
    );
    // A two-edge right-angle corner is also a conflict area. The lab has
    // several at road ends; without a reservation, crossing cars can both
    // yield forever while their predicted paths intersect.
    const corners = (
      environment === "lab" || environment === "vehicle"
        ? [...this.graph.values()]
        : []
    ).filter((n) => {
      if (n.edges.length !== 2) return false;
      const a = this.graph.get(n.edges[0]),
        b = this.graph.get(n.edges[1]);
      return (
        Math.abs((a.x - n.x) * (b.z - n.z) - (a.z - n.z) * (b.x - n.x)) > 0.01
      );
    });
    this.junctionGroups = this.district || this.pursuit ? [] : junctionGroups([...this.junctions, ...corners]);
    this.parkingBays =
      environment === "city"
        ? parkingBays(this.graph, this.junctionGroups, this.drivingRoads)
        : [];
    this.roads = this.pursuit?.roads ?? this.district?.roads ?? [...this.drivingRoads, ...this.parkingBays];
    this.tick = 0;
    this.events = [];
    this.mode = "manual";
    this.policy = null;
    this.input = { targetSpeed: 0, steer: 0 };
    this.destination = null;
    this.routeRevision = 0;
    this.statics = [];
    this.actors = [];
    this.junctionOwners = new Map();
    this.statics = this.pursuit?.statics ?? this.district?.statics ?? visualScene?.statics ?? (
      environment === "city"
        ? cityFootprints(this.roads)
        : environment === "vehicle"
          ? [{ ...VEHICLE_TEST_BARRIER }]
          : []);
    this.staticIndex = new SpatialIndex(this.statics);
    this.metrics = {
      distance: 0,
      interventions: 0,
      completedTrips: 0,
      trafficTrips: 0,
      waitSeconds: 0,
      scenarios: 0,
      trafficStoppedOver5: 0,
      trafficStoppedOver20: 0,
      longestCurrentTrafficWait: 0,
      peakTrafficWait: 0,
      trafficBlockingCycles: 0,
    };
    this.scenario = null;
    this.vehicleTest =
      environment === "vehicle"
        ? {
            phase: "ready",
            barrierId: VEHICLE_TEST_BARRIER.id,
            maxSpeedMps: 5,
            maxTicks: 8 * 60,
            startedTick: null,
            contactTick: null,
            impact: null,
            error: null,
          }
        : null;
    const startingBay =
      environment === "city"
        ? this.parkingBays.find(
            (bay) =>
              bay.axis === "z" &&
              bay.side === -1 &&
              bay.nodeKey === "20.0000,-40.0000" &&
              bay.min <= -40 &&
              bay.max >= -40,
          )
        : null;
    if (environment === "city" && !startingBay)
      throw new Error("City starting parking bay is missing");
    this.player = this.makeVehicle("player", "sedan", this.pursuit?.playerStart ?? this.districtCase?.playerStart
      ?? this.district?.playerStart ?? visualScene?.playerStart ?? {
      // The city starts in a marked shoulder bay. An idle player in the
      // northbound lane used to block an entire traffic queue before input.
      x: startingBay?.fixed ?? 20 - LANE_OFFSET,
      z: environment === "city" ? -40 : -25,
      heading: 0,
    });
    this.actors.push(this.player);
    if (this.pursuit) {
      populatePursuit(this);
    } else if (this.district) {
      this.populateDistrict();
    } else if (visualScene) {
      this.actors.push(...structuredClone(visualScene.people));
      this.capacity = { traffic: 0, pedestrians: visualScene.people.length };
    } else if (environment === "vehicle")
      this.capacity = { traffic: 0, pedestrians: 0 };
    else this.populate();
    for (const actor of this.actors) {
      if (actor.type !== "pedestrian") continue;
      actor.body ??= createPedestrianBody(actor);
      if (visualScene) actor.body = { ...actor.body, heightM: 1.78, radiusM: actor.radius };
      actor.motionMode ??= "ambient";
      actor.motionTimeS = 0;
      actor.accelerationMps2 = 0;
    }
    this.sensorProcessor = new RangeSignalProcessor();
    this.updateSensors();
  }
  makeVehicle(id, kind, position) {
    const tuk = kind === "tuktuk";
    return {
      id,
      type: "vehicle",
      kind,
      ...position,
      speed: 0,
      steer: 0,
      length: id === "player" ? PLAYER_VEHICLE.lengthM : tuk ? 2.9 : VEHICLE.length,
      width: id === "player" ? PLAYER_VEHICLE.widthM : tuk ? 1.5 : VEHICLE.width,
      spec:
        id === "player"
          ? {
              wheelbase: PLAYER_VEHICLE.wheelbaseM,
              maxSteer: PLAYER_VEHICLE.maxSteerRad,
            }
          : tuk ? { wheelbase: 1.9 } : null,
      maxSpeed: (this.config.speedLimit / 3.6) * (tuk ? 0.7 : 1),
      path: [],
      cursor: 0,
      distance: 0,
      wait: 0,
      reason: "ready",
      phase: this.rng.next(),
      reckless: id !== "player" && this.rng.next() < this.config.chaos,
      ...(id === "player"
        ? { height: PLAYER_VEHICLE.heightM, vehicle: createVehicleState() }
        : {}),
    };
  }
  updateSensors(filter = true) {
    const geometry = measureVehicleSensors(this, this.player);
    const previous = this.player.previous;
    this.sensors = {
      ...(filter ? this.sensorProcessor.update(geometry.rawM) : this.sensors),
      ...geometry,
      imu: {
        source: "simulated-vehicle-state",
        positionM: { ...geometry.mounts.telemetry.position },
        headingRad: this.player.heading,
        speedMps: this.player.speed,
        yawRateRadS: previous
          ? angleDelta(this.player.heading, previous.heading) / STEP
          : 0,
        longitudinalAccelerationMps2: previous
          ? (this.player.speed - previous.speed) / STEP
          : 0,
      },
    };
  }
  free(body, gap = 1) {
    return (
      !this.actors.some((a) => overlaps(body, a, gap)) &&
      !this.statics.some((a) => overlaps(body, a, gap))
    );
  }
  populate() {
    for (
      let i = 0, attempts = 0;
      i < this.config.traffic && attempts < 3000;
      attempts++
    ) {
      const road = this.rng.pick(this.drivingRoads),
        along = this.rng.range(road.min + 7, road.max - 7),
        side = this.rng.next() < 0.5 ? -1 : 1;
      const car = this.makeVehicle(
        `traffic-${i}`,
        this.rng.pick(carKinds),
        pose(road, along, side),
      );
      if (
        distance(car, this.player) < 14 ||
        !this.free(car, 4) ||
        !bodyOnRoad(car, this.roads)
      )
        continue;
      // Start outside a junction; the first planned edge follows the lane heading.
      if (this.junctionGroups.some((j) => insideJunction(car, j, 1))) continue;
      this.assignTrafficRoute(car);
      if (!car.path.length) continue;
      this.actors.push(car);
      i++;
    }
    for (
      let i = 0, attempts = 0;
      i < this.config.pedestrians && attempts < 2500;
      attempts++
    ) {
      const road = this.rng.pick(this.drivingRoads),
        side = this.rng.next() < 0.5 ? -1 : 1;
      const along = this.rng.range(road.min + 7, road.max - 7),
        offset = road.width / 2 + 1.25;
      const p = {
        id: `person-${i}`,
        type: "pedestrian",
        kind: PEOPLE_MODELS[i % PEOPLE_MODELS.length],
        ...pose(road, along, side, offset),
        radius: 0.34,
        speed: 0,
        walkSpeed: this.rng.range(1.1, 1.65),
        phase: this.rng.next(),
        distance: 0,
        wait: 0,
        reason: "walking",
        road,
        side,
        along,
        target: null,
        pause: 0,
        crossing: false,
      };
      p.body = createPedestrianBody(p);
      p.radius = p.body.radiusM;
      p.motionMode = "ambient";
      if (!this.free(p, 0.7) || pointOnRoad(p, this.roads)) continue;
      this.nextWalk(p);
      this.actors.push(p);
      i++;
    }
    this.capacity = {
      traffic: this.actors.filter(
        (a) => a.type === "vehicle" && a !== this.player,
      ).length,
      pedestrians: this.actors.filter((a) => a.type === "pedestrian").length,
    };
  }
  populateDistrict() {
    const district = this.district;
    const encounter = this.districtCase;
    if (encounter && encounter.id !== "ambient") {
      encounter.phase = "ready";
      encounter.startedTick = null;
      encounter.firstVisualBrakeS = null;
      encounter.firstReactiveBrakeS = null;
      encounter.firstLaneEntryS = null;
      encounter.completedAtS = null;
      if (!Number.isFinite(encounter.requestedSpeedMps) || encounter.requestedSpeedMps <= 0
          || encounter.requestedSpeedMps > 8)
        throw new Error("District encounter has no bounded requested speed.");
      for (const data of encounter.traffic ?? []) {
        const car = this.makeVehicle(data.id, data.kind ?? "sedan", data);
        if (!data.goal) throw new Error(`District encounter traffic ${data.id} has no declared goal.`);
        car.path = planDistrictRoute(district, car, data.goal, this.actors);
        if (!car.path.length) throw new Error(`District encounter traffic ${data.id} has no legal route.`);
        car.parking = { ...data.goal };
        car.districtTripCompleted = false;
        initializeDistrictActor(this, car);
        this.actors.push(car);
      }
      this.actors.push(...structuredClone(encounter.people ?? []));
      this.capacity = { traffic: (encounter.traffic ?? []).length, pedestrians: (encounter.people ?? []).length };
      return;
    }
    if (this.config.traffic > district.trafficSpawns.length
        || this.config.pedestrians > district.pedestrianSpawns.length)
      throw new Error("The requested population exceeds this district's registered spawn capacity.");
    for (let i = 0; i < this.config.traffic; i++) {
      const car = this.makeVehicle(`traffic-${i}`, carKinds[i % carKinds.length], district.trafficSpawns[i]);
      if (!this.free(car, 0.12) || !bodyOnRoad(car, this.roads))
        throw new Error(`District vehicle spawn ${i} is not physically clear.`);
      initializeDistrictActor(this, car);
      this.actors.push(car);
    }
    for (const car of this.actors.filter((actor) => actor !== this.player))
      if (!this.assignTrafficRoute(car)) throw new Error(`No district continuation for ${car.id}.`);
    for (let i = 0; i < this.config.pedestrians; i++) {
      const spawn = district.pedestrianSpawns[i];
      const road = district.drivingRoads.find((item) => item.id === spawn.roadId);
      if (!road) throw new Error(`District person spawn ${i} has no registered road.`);
      const person = {
        id: `person-${i}`, type: "pedestrian", kind: PEOPLE_MODELS[i % PEOPLE_MODELS.length],
        ...spawn, road, speed: 0, walkSpeed: this.rng.range(1.1, 1.65), phase: this.rng.next(),
        distance: 0, wait: 0, reason: "walking", target: null, pause: 0, crossing: false,
        motionMode: "ambient",
      };
      person.body = createPedestrianBody(person);
      person.radius = person.body.radiusM;
      if (!this.free(person, 0.12)) throw new Error(`District person spawn ${i} is not clear.`);
      initializeDistrictActor(this, person);
      this.nextWalk(person);
      this.actors.push(person);
    }
    this.capacity = { traffic: this.config.traffic, pedestrians: this.config.pedestrians };
  }
  assignTrafficRoute(car) {
    if (this.district) {
      const goals = this.district.trafficGoals;
      const start = Math.floor(this.rng.next() * goals.length);
      car.path = planDistrictTrafficTrip(this, car, start);
      car.cursor = 0;
      return car.path.length > 10;
    }
    const pressure = this.trafficPressure();
    for (let trial = 0; trial < 14; trial++) {
      const goal = this.rng.pick(this.junctions);
      if (!goal || distance(car, goal) < 22) continue;
      const path = planNavigation(this.graph, car, goal, this.actors, pressure);
      if (path.length > 10) {
        const end = path.at(-1),
          before = path.at(-2),
          heading = Math.atan2(end.x - before.x, end.z - before.z);
        const canContinue = goal.edges.some((key) => {
          const next = this.graph.get(key);
          return (
            Math.abs(
              angleDelta(Math.atan2(next.x - goal.x, next.z - goal.z), heading),
            ) < 0.1
          );
        });
        if (!canContinue) continue;
        const arrivalGroup = this.junctionGroups.find((group) =>
          insideJunction(goal, group),
        );
        // NPC trips finish beyond the intersection, leaving room to select a
        // new route without changing a reservation while still inside it.
        let tail = { ...end },
          valid = true;
        while (arrivalGroup && insideJunction(tail, arrivalGroup, 3)) {
          tail = {
            x: tail.x + Math.sin(heading) * 0.65,
            z: tail.z + Math.cos(heading) * 0.65,
          };
          if (!bodyOnRoad({ ...car, ...tail, heading }, this.roads)) {
            valid = false;
            break;
          }
          path.push(tail);
        }
        if (!valid) continue;
        car.path = path;
        car.cursor = 0;
        return true;
      }
    }
    car.path = [];
    return false;
  }
  trafficPressure() {
    if (this.pressureTick !== this.tick) {
      this.pressureTick = this.tick;
      this.pressure = junctionPressure(this.junctionGroups, this.actors);
    }
    return this.pressure;
  }
  nextWalk(person) {
    return this.district ? nextDistrictWalk(this, person) : nextWalk(this, person);
  }
  command(command, record = true) {
    if (command.type === "street-pursuit-start" || command.type === "street-pursuit-stop") {
      if (this.environment !== "metro") throw new Error("Street pursuit is only available in City");
      if (command.type === "street-pursuit-start") {
        if (this.pursuit?.phase === "running") throw new Error("A street pursuit is already running");
        const pack = isPackPursuit(command.variant);
        const training = pack && !isSurvival(command.variant);
        validatePracticeCommand(command, training || command.variant === "arcade", training);
        const resumeMode = this.mode;
        const resumeTrip = resumeMode === "auto" && Boolean(this.destination) && this.player.path.length > 1;
        beginStreetPursuit(this, command.level, command.variant);
        const { pursuit } = this;
        if (pack) this.configurePackDriver(command);
        else if (command.learn) pursuit.learner = this.arcadeLearner ??= createArcadeLearner(this.config.seed);
        pursuit.resumeMode = resumeMode;
        pursuit.resumeTrip = resumeTrip;
        const outsideStartBlock = pursuit.exits.filter(exit =>
          distance(exit, this.player) >= 30 + pursuit.level * 6);
        if (outsideStartBlock.length) pursuit.exits = outsideStartBlock;
        this.player.path = [];
        this.player.parking = null;
        this.player.cursor = 0;
        this.routeRevision++;
        this.mode = "auto";
      } else {
        if (this.pursuit?.phase !== "running" && !this.pursuit?.reviewUntilTick)
          throw new Error("No running street pursuit");
        if (this.pursuit.survival && !canEndSurvival(this))
          throw new Error("Move clear of the obstacle before ending Ghost mode.");
        this.pursuit.learner?.interrupt();
        endStreetPursuit(this);
        this.resumeStreetDrive();
      }
      if (record) this.events.push({ tick: this.tick, command: structuredClone(command) });
      return true;
    }
    if (command.type === "pursuit-use") {
      if (this.pursuit?.phase !== "running" || !this.pursuit.survival?.held || this.pursuit.survival.fireQueued)
        return false;
      this.pursuit.survival.fireQueued = true;
      if (record) this.events.push({ tick: this.tick, command: { type: "pursuit-use" } });
      return true;
    }
    if (["pursuit-run", "pursuit-drive", "pursuit-policy"].includes(command.type)) {
      if (!this.pursuit) throw new Error("Pursuit controls are only available in the pursuit mode");
      if (this.environment === "metro" &&
          (command.type !== "pursuit-drive" || this.pursuit.phase !== "running"))
        throw new Error("Use City street pursuit controls for this event");
      if (command.type === "pursuit-run") {
        if (this.pursuit.phase !== "ready") throw new Error("Reset the pursuit before starting a new run");
        validatePracticeCommand(command, this.pursuit.packLab, this.pursuit.packLab);
        if (this.pursuit.packLab) {
          this.configurePackDriver(command);
          startPackDrill(this);
        }
        this.pursuit.phase = "running";
      } else if (command.type === "pursuit-drive") {
        this.pursuit.manualAction = { ...validatePursuitAction(command.action) };
      } else {
        this.pursuit.policy = command.weights === null ? null : structuredClone(validatePursuitPolicy(command.weights));
        this.pursuit.nextDecisionTick = 0;
      }
      if (record) this.events.push({ tick: this.tick, command: structuredClone(command) });
      return true;
    }
    if (command.type === "district-run") {
      if (!this.districtCase || this.districtCase.id === "ambient" || this.districtCase.phase !== "ready")
        throw new Error("Select and reset a district encounter before running it.");
      const path = planDistrictRoute(this.district, this.player, this.districtCase.goal, this.actors);
      if (!path.length) throw new Error("The district encounter goal is not reachable.");
      this.player.path = path;
      this.player.cursor = 0;
      this.player.parking = { ...this.districtCase.goal };
      this.destination = { ...this.districtCase.goal, name: "District encounter" };
      this.districtCase.phase = "running";
      this.districtCase.startedTick = this.tick;
      this.mode = "auto";
      if (record) this.events.push({ tick: this.tick, command: structuredClone(command) });
      return true;
    }
    if (command.type === "pedestrian-motion") {
      if (!["city", "lab", "egypt", "metro"].includes(this.environment)
          || (this.districtCase && this.districtCase.id !== "ambient"))
        throw new Error("Human motion controls are unavailable in fixed Vision and vehicle fixtures.");
      if (Object.keys(command).some((key) => !["type", "id", "mode"].includes(key)))
        throw new Error("Human motion accepts only a person ID and an explicit motion mode.");
      const person = this.actors.find((actor) => actor.id === command.id && actor.type === "pedestrian");
      if (!person) throw new Error("The requested person is not in this world.");
      if (!setPedestrianMotionMode(person, command.mode))
        throw new Error("Choose ambient, walk, jog or stop for an ordinary person.");
      if (record) this.events.push({ tick: this.tick, command: structuredClone(command) });
      return true;
    }
    if (command.type === "visual-observation") {
      this.visualPredictor.observe(structuredClone(command.result));
      if (record) this.events.push({ tick: this.tick, command: structuredClone(command) });
      return true;
    }
    if (command.type === "visual-reset") {
      this.visualPredictor.reset(command.streamId);
      if (record) this.events.push({ tick: this.tick, command: structuredClone(command) });
      return true;
    }
    if (command.type === "visual-mode") {
      if (!["vision-first", "sensors-only"].includes(command.mode))
        throw new Error("Unknown visual driving mode");
      this.visualMode = command.mode;
      if (record) this.events.push({ tick: this.tick, command: structuredClone(command) });
      return true;
    }
    if (command.type === "vision-run") {
      if (!this.visionLab || this.visionLab.phase !== "ready") return false;
      this.visionLab.phase = "running";
      this.visionLab.startedTick = this.tick;
      this.input = { targetSpeed: this.visionLab.requestedSpeedMps, steer: 0 };
      if (record) this.events.push({ tick: this.tick, command: structuredClone(command) });
      return true;
    }
    if (command.type === "vehicle-test") {
      if (
        this.environment !== "vehicle" ||
        command.operation !== "run" ||
        this.vehicleTest.phase !== "ready"
      )
        return false;
      if (record)
        this.events.push({ tick: this.tick, command: structuredClone(command) });
      if (
        Math.abs(this.player.speed) > 0.01 ||
        Math.abs(this.player.steer) > 0.01 ||
        distance(this.player, vehicleStart) > 0.05 ||
        Math.abs(angleDelta(this.player.heading, vehicleStart.heading)) > 0.01 ||
        this.player.vehicle.damage.total > 0
      ) {
        this.vehicleTest.error = "Stop and reset the car at the marked start before running";
        return false;
      }
      this.mode = "manual";
      this.input = { targetSpeed: 0, steer: 0 };
      this.player.path = [];
      this.player.parking = null;
      this.player.cursor = 0;
      this.destination = null;
      this.routeRevision++;
      Object.assign(this.vehicleTest, {
        phase: "running",
        startedTick: this.tick,
        error: null,
      });
      return true;
    }
    if (
      this.vehicleTest?.phase === "running" &&
      ["drive", "mode", "destination", "scenario"].includes(command.type)
    )
      return false;
    if (this.environment === "metro" && (this.pursuit?.phase === "running" || this.pursuit?.reviewUntilTick) &&
        command.type === "destination")
      return false;
    if (command.type === "policy" && command.weights)
      validatePolicy(command.weights);
    if (record)
      this.events.push({ tick: this.tick, command: structuredClone(command) });
    if (command.type === "drive")
      this.input = {
        targetSpeed: clamp(
          Number(command.targetSpeed) || 0,
          -2.5,
          this.player.maxSpeed,
        ),
        steer: clamp(
          Number(command.steer) || 0,
          -VEHICLE.maxSteer,
          VEHICLE.maxSteer,
        ),
      };
    if (command.type === "mode")
      this.mode = command.mode === "auto" ? "auto" : "manual";
    if (command.type === "policy") {
      this.policy = command.weights ? validatePolicy(command.weights) : null;
      return true;
    }
    if (command.type === "stop") {
      if (this.vehicleTest?.phase === "running") {
        this.vehicleTest.phase = "ready";
        this.vehicleTest.error = "Test stopped; reset the car before another run";
      }
      if (this.visionLab && this.visionLab.phase !== "complete") {
        this.visionLab.error = "Driver stopped this bounded test. Reset to run again.";
        if (this.player.speed === 0) this.visionLab.phase = "complete";
      }
      this.mode = "manual";
      this.input = { targetSpeed: 0, steer: 0 };
      this.player.path = [];
      this.player.parking = null;
      this.player.cursor = 0;
      this.destination = null;
      this.routeRevision++;
    }
    if (command.type === "scenario") return triggerScenario(this, command.kind);
    if (
      command.type === "destination" &&
      Number.isFinite(command.place?.x) &&
      Number.isFinite(command.place?.z)
    ) {
      const arrival =
        this.environment === "city" ? planArrival(this, command.place) : null;
      const path =
        arrival?.path ??
        (this.district
          ? planDistrictRoute(this.district, this.player, command.place, this.actors)
          : this.environment === "lab"
          ? planNavigation(this.graph, this.player, command.place, this.actors)
          : []);
      if (path.length) {
        this.destination = { ...command.place };
        this.player.path = path;
        this.player.parking = this.district ? { ...command.place } : arrival?.parking ?? null;
        this.player.cursor = 0;
        this.mode = "auto";
        this.routeRevision++;
        return true;
      }
      this.player.reason = "no-route";
      return false;
    }
    return true;
  }
  // Predict vehicles in the intended corridor, rather than braking for an
  // inflated circle around everything, including traffic in the opposite lane.
  safeSpeed(car, command, usePlannedPath = true) {
    return safeSpeed(this, car, command, usePlannedPath);
  }
  pedestrianMotion(p) {
    return pedestrianMotion(this, p);
  }
  districtDrivingCommand(actor, requested, ownMotion, nowS, usePlannedPath = true) {
    const behavior = capCityEncounter(this, actor, districtTrafficCommand(this, actor, requested));
    const previousState = this.districtSpeedState;
    const predictive = actor === this.player && this.mode === "auto";
    const composed = predictive ? composeDistrictSpeed(behavior, {
      visual: decideDistrictVisualSpeed({
        visual: this.visualState, ego: ownMotion, requestedSpeedMps: Math.max(0, behavior.targetSpeed),
        nowS, visionRequired: this.visualMode === "vision-first", previousState,
        cityLead: this.config.cityVersion >= 3,
      }),
      map: mappedDistrictSpeed({ zones: this.district.cautionZones, ego: ownMotion }),
      dt: STEP, previousState,
    }) : behavior;
    if (predictive) this.districtSpeedState = composed.nextState;
    const safe = this.safeSpeed(actor, composed, usePlannedPath);
    const command = attributeDistrictApplied({ requested, behavior, composed, safe });
    actor.districtSources = command.districtSources;
    if (actor === this.player && this.districtCase && this.districtCase.id !== "ambient") {
      if (safe.targetSpeed < composed.targetSpeed - 0.05 && this.districtCase.firstReactiveBrakeS === null)
        this.districtCase.firstReactiveBrakeS = nowS;
      if (["camera-pixels", "both"].includes(command.districtSources?.appliedSource)
          && command.targetSpeed === 0 && this.districtCase.firstVisualBrakeS === null)
        this.districtCase.firstVisualBrakeS = nowS;
    }
    return command;
  }
  resumeStreetDrive() {
    this.mode = this.pursuit.resumeMode;
    this.input = { targetSpeed: 0, steer: 0 };
    const goal = this.destination;
    const path = goal && this.pursuit.resumeTrip
      ? planDistrictRoute(this.district, this.player, goal, this.actors) : [];
    this.player.path = path;
    this.player.cursor = 0;
    this.player.parking = path.length ? { ...goal } : null;
    this.pursuit.tripResumed = path.length > 0;
    this.routeRevision++;
    if (this.pursuit.resumeTrip && !path.length) this.player.reason = "no-route";
  }
  configurePackDriver(command) {
    const pursuit = this.pursuit;
    const checkpoint = command.checkpoint ?? (isCityHunt(pursuit.variant) ? starterPackPolicy() : null);
    if (command.learn) {
      pursuit.driver = "training";
      pursuit.learner = createPackLearner(this.config.seed, checkpoint, true);
    } else if (checkpoint) {
      pursuit.driver = command.checkpoint ? command.localPolicy === true ? "local-policy" : "lab-policy" : "starter";
      pursuit.learner = createPackLearner(this.config.seed, checkpoint, false);
    }
  }
  followTrafficTrip(actor) {
    if (!actor.path.length && this.tick % 120 === 0) this.assignTrafficRoute(actor);
    freezePath(actor.path);
    let command = followPath(actor, actor.path, actor.cursor);
    actor.cursor = command.cursor;
    if (actor.path.length && command.remaining < 1.5) {
      this.metrics.trafficTrips++;
      this.assignTrafficRoute(actor);
      freezePath(actor.path);
      command = followPath(actor, actor.path, 0);
    }
    return command;
  }
  stepPursuitMode(ownMotion = null, nowS = null) {
    const pursuit = this.pursuit;
    const street = this.environment === "metro";
    const learner = pursuit.learner;
    let action = pursuit.manualAction ?? PURSUIT_STOP;
    if (this.mode === "auto") {
      if (!pursuit.decision || this.tick >= (pursuit.nextDecisionTick ?? 0)) {
        const observed = observePursuit(this);
        if (street) observed.street = true;
        if (pursuit.response) observed.cinematic = true;
        if (pursuit.variant === "arcade") observed.arcade = true;
        if (isPackPursuit(pursuit.variant)) observed.pack = true;
        if (street && usesRushPace(pursuit.variant)) observed.rush = true;
        if (this.tick >= (pursuit.nextRouteTick ?? 0)) {
          const previous = pursuit.route;
          pursuit.route = street ? selectStreetPursuitRoute(observed, this.district, previous) :
            selectPursuitRoute(observed, previous);
          if (previous?.id !== pursuit.route?.id) pursuit.routeChanges = (pursuit.routeChanges ?? 0) + 1;
          this.player.path = pursuit.route?.path ?? [];
          this.routeRevision++;
          pursuit.nextRouteTick = this.tick + (observed.rush ? 42 : street ? 60 : 36);
        }
        pursuit.decision = decidePursuit(observed, pursuit.route, learner?.weights ?? pursuit.policy,
          learner?.choose ?? pursuit.trainingChoice);
        if (isCityHunt(pursuit.variant)) pursuit.recovery = pursuit.decision.recovery ?? null;
        learner?.record(pursuit.decision, pursuit.metrics);
        pursuit.nextDecisionTick = this.tick + PURSUIT_DECISION_TICKS;
      }
      action = pursuit.decision.action;
    } else {
      pursuit.decision = null;
      if (isCityHunt(pursuit.variant)) pursuit.recovery = null;
      learner?.interrupt();
      if (pursuit.survival && !action.brake && action.gear === 1)
        action = { ...action, throttle: 1 };
    }
    if (!street) {
      stepPursuit(this, action);
      if (pursuit.phase !== "running") learner?.finish(pursuit.metrics, pursuit.phase);
      return;
    }
    if (!usesRushPace(pursuit.variant)) this.actorIndex = new SpatialIndex(this.actors);
    updateDistrictTraffic(this);
    stepPursuit(this, action, {
      pedestrianMotion: actor => stepDistrictPedestrian(this, actor),
      vehicleCommand: (actor, requested) => actor.pursuitRole === "police"
        ? districtTrafficCommand(this, actor, requested)
        : this.districtDrivingCommand(actor, requested ?? this.followTrafficTrip(actor),
            ownMotion, nowS, actor !== this.player),
    });
    if (pursuit.phase !== "running") {
      learner?.finish(pursuit.metrics, pursuit.phase);
      if (!pursuit.reviewUntilTick) this.resumeStreetDrive();
    }
  }
  step() {
    if (stepPackReview(this)) return;
    if (this.environment === "pursuit" && this.pursuit.phase !== "running") return;
    if (this.visionLab && this.visionLab.phase !== "running") return;
    if (this.districtCase && this.districtCase.id !== "ambient" && this.districtCase.phase !== "running") return;
    const nowS = this.tick * STEP;
    const ownMotion = {
      x: this.player.x, z: this.player.z, headingRad: this.player.heading,
      speedMps: this.player.speed, lengthM: this.player.length, widthM: this.player.width,
    };
    this.visualState = this.visualPredictor.snapshot(nowS, ownMotion);
    this.visualDecision = this.visualState.decision;
    if (this.cityEncounters) advanceCityEncounters(this);
    if (this.pursuit?.phase === "running") {
      this.stepPursuitMode(ownMotion, nowS);
      return;
    }
    if (this.district) updateDistrictTraffic(this);
    if (this.environment !== "vehicle") updateScenarios(this);
    this.actorIndex = new SpatialIndex(this.actors);
    this.updateJunctions();
    // Old poses are reserved until the tick ends. An accepted move can never
    // tunnel through the position another actor occupied at the start of a tick.
    const reserved = new SpatialIndex(this.actors.map(copyPose));
    for (const actor of this.actors) {
      actor.previous = copyPose(actor);
      let next;
      let appliedCommand;
      let contact = null;
      let controlledTest =
        actor === this.player && this.vehicleTest?.phase === "running";
      if (
        controlledTest &&
        this.tick - this.vehicleTest.startedTick >= this.vehicleTest.maxTicks
      ) {
        this.vehicleTest.phase = "ready";
        this.vehicleTest.error = "Contact was not reached within the bounded test; reset the car";
        this.input = { targetSpeed: 0, steer: 0 };
        controlledTest = false;
      }
      const physicalBarrier =
        actor === this.player &&
        this.environment === "vehicle" &&
        (controlledTest || this.vehicleTest.phase === "contact");
      if (actor.type === "pedestrian") next = this.district
        ? this.districtCase && this.districtCase.id !== "ambient"
          ? advanceDistrictCase(this, actor) : stepDistrictPedestrian(this, actor)
        : this.visionLab
        ? advanceVisionActor(actor, STEP, {
            timeS: (this.tick - this.visionLab.startedTick) * STEP,
            tick: this.tick,
          })
        : this.pedestrianMotion(actor);
      else {
        let command;
        if (controlledTest)
          command = {
            targetSpeed: this.vehicleTest.maxSpeedMps,
            steer: 0,
            reason: "vehicle-test",
            blockedBy: null,
          };
        else if (actor === this.player && this.mode === "manual")
          command = { ...this.input };
        else {
          if (
            !actor.path.length &&
            actor !== this.player &&
            !(this.districtCase && this.districtCase.id !== "ambient") &&
            this.tick % 120 === 0
          )
            this.assignTrafficRoute(actor);
          if (this.district) freezePath(actor.path);
          command = followPath(actor, actor.path, actor.cursor);
          actor.cursor = command.cursor;
          if (actor.parking && (!this.district || (distance(actor, actor.parking) < 14
              && Math.abs(angleDelta(actor.heading, actor.parking.heading)) < 0.35))) {
            const toStop =
              (actor.parking.x - actor.x) * Math.sin(actor.parking.heading) +
              (actor.parking.z - actor.z) * Math.cos(actor.parking.heading);
            command.targetSpeed = Math.min(
              command.targetSpeed,
              toStop < 26 ? 2.5 : actor.maxSpeed,
              Math.sqrt(Math.max(0, toStop - 0.25) * 3.2),
            );
          }
          if (
            actor.path.length &&
            (actor.parking
              ? Math.abs(actor.speed) < 0.05 &&
                distance(actor, actor.parking) < 0.8 &&
                (!this.district || Math.abs(angleDelta(actor.heading, actor.parking.heading)) <= 0.2)
              : command.remaining < 1.5)
          ) {
            if (actor === this.player) {
              actor.path = [];
              this.metrics.completedTrips++;
              this.routeRevision++;
              command.targetSpeed = 0;
              actor.reason = "arrived";
            } else {
              this.metrics.trafficTrips++;
              if (this.districtCase && this.districtCase.id !== "ambient") {
                actor.path = [];
                actor.districtTripCompleted = true;
                command.targetSpeed = 0;
              } else {
                this.assignTrafficRoute(actor);
                command = followPath(actor, actor.path, 0);
              }
            }
          }
        }
        if (
          actor === this.player &&
          this.mode === "auto" &&
          command.targetSpeed > 0
        )
          command.targetSpeed = policySpeed(this, actor, command.targetSpeed);
        if (actor === this.player && this.districtCase && this.districtCase.id !== "ambient")
          command.targetSpeed = this.districtCase.error ? 0
            : Math.min(command.targetSpeed, this.districtCase.requestedSpeedMps);
        if (this.district) command = this.districtDrivingCommand(actor, command, ownMotion, nowS);
        else {
        const predictedBrake = !controlledTest && actor === this.player
          && this.visualMode === "vision-first"
          && this.visualDecision?.available === true
          && this.visualDecision.brake === true;
        const reactiveCommand = controlledTest ? command : this.safeSpeed(actor, command);
        if (actor === this.player && this.visionLab
            && reactiveCommand.targetSpeed < command.targetSpeed - 0.1
            && this.visionLab.firstReactiveBrakeS === null)
          this.visionLab.firstReactiveBrakeS = nowS;
        const appliedVisualBrake = predictedBrake && reactiveCommand.targetSpeed > 0;
        command = appliedVisualBrake
          ? { ...reactiveCommand, targetSpeed: 0, reason: "visual-prediction" }
          : reactiveCommand;
        if (appliedVisualBrake && this.visionLab?.firstVisualBrakeS === null)
          this.visionLab.firstVisualBrakeS = nowS;
        }
        appliedCommand = command;
        next = integrateVehicle(actor, command, STEP);
        next.reason =
          actor === this.player &&
          !actor.path.length &&
          this.destination &&
          this.metrics.completedTrips
            ? "arrived"
            : command.reason;
        next.blockedBy = command.blockedBy;
      }
      if (physicalBarrier) {
        const barrier = this.statics.find(
          (body) => body.id === this.vehicleTest.barrierId,
        );
        if (barrier) {
          contact = resolveVehicleContact(actor, next, barrier, STEP);
          if (contact) next = contact.body;
        }
      }
      const nearby = reserved
        .near(actor, 8)
        .filter((a) => a.id !== actor.id)
        .concat(this.staticIndex.near(actor, 11))
        .filter(
          (a) => !physicalBarrier || a.id !== this.vehicleTest.barrierId,
        );
      const guard = sweepSafe(
        actor,
        next,
        nearby,
        actor.type === "vehicle" ? this.roads : null,
      );
      if (!guard.safe) {
        contact = null;
        // Stopping is the sole fallback. No positional correction or in-place yaw.
        next = {
          ...actor,
          heading: actor.type === "pedestrian" ? next.heading : actor.heading,
          speed: 0,
          steer: next.steer ?? actor.steer,
          reason: guard.reason,
          blockedBy: guard.actor,
        };
        if (actor === this.player && actor.reason !== guard.reason)
          this.metrics.interventions++;
        if (this.district && actor.districtSources)
          next.districtSources = { ...actor.districtSources, finalMps: 0, appliedSource: "physical-guard" };
      }
      if (actor === this.player) {
        next.vehicle = advanceVehicleState(actor, next, appliedCommand, STEP, {
          tick: this.tick,
          contact,
        });
        if (contact) {
          this.vehicleTest.phase = "contact";
          this.vehicleTest.contactTick = this.tick;
          this.vehicleTest.impact = {
            ...next.vehicle.damage.lastImpact,
            hitId: contact.hitId,
          };
          this.input = { targetSpeed: 0, steer: 0 };
        }
      }
      const moved = distance(actor, next);
      if (actor.type === "pedestrian") {
        next.accelerationMps2 = (next.speed - actor.speed) / STEP;
        next.motionTimeS = (this.tick + 1) * STEP;
      }
      const oldPrevious = actor.previous;
      Object.assign(actor, next, {
        previous: oldPrevious,
        distance: actor.distance + moved,
        wait: moved < 0.001 ? actor.wait + STEP : 0,
      });
      reserved.add(copyPose(actor));
      if (actor === this.player) {
        this.metrics.distance += moved;
        if (moved < 0.001 && this.mode === "auto" && actor.path.length)
          this.metrics.waitSeconds += STEP;
      }
    }
    this.updateSensors(this.tick % 6 === 0);
    Object.assign(
      this.metrics,
      trafficQueueStats(
        this.actors,
        (actor) => signalSpeedLimit(this, actor) === Infinity,
      ),
    );
    this.metrics.peakTrafficWait = Math.max(
      this.metrics.peakTrafficWait,
      this.metrics.longestCurrentTrafficWait,
    );
    this.tick++;
    if (this.districtCase && this.districtCase.id !== "ambient") {
      const state = this.districtCase;
      const elapsedS = (this.tick - state.startedTick) * STEP;
      const start = state.playerStart;
      if (state.firstLaneEntryS === null && this.actors.some((actor) =>
        actor.type === "pedestrian" && Math.abs(
          (actor.x - start.x) * Math.cos(start.heading) -
          (actor.z - start.z) * Math.sin(start.heading)) <= this.player.width / 2 + actor.radius))
        state.firstLaneEntryS = elapsedS;
      if (this.destination && !this.player.path.length && this.player.speed === 0
          && distance(this.player, state.goal) <= 0.8
          && this.actors.filter((actor) => actor.type === "vehicle" && actor !== this.player)
            .every((actor) => actor.districtTripCompleted)) {
        state.phase = "complete";
        state.completedAtS = elapsedS;
      }
      if (elapsedS > 90 && state.phase !== "complete") {
        state.error = "The district encounter did not reach its declared goal.";
        this.input = { targetSpeed: 0, steer: 0 };
      }
    }
    if (this.visionLab) {
      const state = this.visionLab;
      const timeS = this.tick * STEP;
      if (state.firstSensorTriggerS === null && this.sensors.rawM.some((range) => range <= 5))
        state.firstSensorTriggerS = timeS;
      if (state.firstLaneEntryS === null && this.actors.some((actor) =>
        actor.type === "pedestrian" && Math.abs(actor.x) < this.player.width / 2 + actor.radius))
        state.firstLaneEntryS = timeS;
      if (timeS >= 24 && this.player.z < state.goalZ)
        state.error = "The bounded case timed out before reaching its goal.";
      if (this.player.z >= state.goalZ || state.error)
        this.input = { targetSpeed: 0, steer: 0 };
      if ((this.player.z >= state.goalZ || state.error) && this.player.speed === 0) {
        state.phase = "complete";
        state.completedAtS = timeS;
      }
    }
  }
  updateJunctions() {
    return updateJunctions(this);
  }
  audit() {
    const errors = [];
    const ghost = this.pursuit?.survival?.active?.kind === "ghost";
    for (let i = 0; i < this.actors.length; i++) {
      const actor = this.actors[i];
      if (
        ![actor.x, actor.z, actor.heading, actor.speed].every(Number.isFinite)
      )
        errors.push(`non-finite:${actor.id}`);
      if (actor.type === "vehicle" && !bodyOnRoad(actor, this.roads))
        errors.push(`off-road:${actor.id}`);
      for (const other of [...this.actors.slice(i + 1), ...this.statics])
        if (!(ghost && survivalGhostPair(this, actor, other)) && overlaps(actor, other))
          errors.push(`overlap:${actor.id}:${other.id}`);
    }
    return errors;
  }
  snapshot() {
    return {
      version: VERSION,
      environment: this.environment,
      config: this.config,
      tick: this.tick,
      mode: this.mode,
      policy: this.policy?.id ?? null,
      destination: this.destination,
      rng: this.rng.state,
      metrics: { ...this.metrics },
      scenario: this.scenario,
      vehicleTest: this.vehicleTest ? structuredClone(this.vehicleTest) : null,
      sensors: this.sensors,
      visualMode: this.visualMode,
      visualState: this.visualState ? structuredClone(this.visualState) : null,
      visionLab: this.visionLab ? structuredClone(this.visionLab) : null,
      ...(this.pursuit ? { pursuit: pursuitSnapshot(this) } : {}),
      ...(this.cityEncounters ? { cityEncounters: {
        nextTick: this.cityEncounters.nextTick, rng: this.cityEncounters.rng.state,
        events: this.cityEncounters.events.map(event => ({ ...event })),
      } } : {}),
      ...(this.district ? {
        district: { id: this.district.id, version: this.district.version,
          case: this.districtCase ? structuredClone(this.districtCase) : null,
          speedState: structuredClone(this.districtSpeedState),
          behavior: districtBehaviorDiagnostics(this) },
      } : {}),
      statics: this.statics.map((a) => ({ ...a })),
      actors: this.actors.map((a) => ({
        id: a.id,
        type: a.type,
        x: a.x,
        z: a.z,
        heading: a.heading,
        speed: a.speed,
        steer: a.steer ?? 0,
        distance: a.distance,
        reason: a.reason,
        cursor: a.cursor ?? 0,
        ...(this.pursuit && a.pursuitRole ? { pursuitRole: a.pursuitRole, policeTactic: a.policeTactic } : {}),
        ...(a.vehicle ? { vehicle: structuredClone(a.vehicle) } : {}),
        ...(this.district && a.districtSources ? { districtSources: structuredClone(a.districtSources) } : {}),
        ...(a.type === "pedestrian" ? {
          body: structuredClone(a.body), motionMode: a.motionMode,
          accelerationMps2: a.accelerationMps2, motionTimeS: a.motionTimeS,
          ...(a.impact ? { impact: { ...a.impact } } : {}),
        } : {}),
      })),
    };
  }

  replay() {
    return {
      version: VERSION,
      environment: this.environment,
      config: this.config,
      totalTicks: this.tick,
      events: structuredClone(this.events),
    };
  }
  static *reconstruct(data) {
    if (
      data?.version !== VERSION ||
      !["city", "lab", "vehicle", "vision", "egypt", "pursuit", "metro"].includes(data.environment) ||
      !Number.isSafeInteger(data.totalTicks) ||
      data.totalTicks < 0 ||
      data.totalTicks > 60 * 60 * 24 ||
      !Array.isArray(data.events)
    )
      throw new Error("Unsupported replay");
    let lastTick = -1;
    for (const event of data.events) {
      if (
        !Number.isSafeInteger(event.tick) ||
        event.tick < 0 ||
        event.tick < lastTick ||
        event.tick > data.totalTicks ||
        ![
          "drive",
          "mode",
          "destination",
          "scenario",
          "stop",
          "policy",
          "visual-observation",
          "visual-reset",
          "visual-mode",
          "vision-run",
          "vehicle-test",
          "pedestrian-motion",
          "district-run",
          "pursuit-run",
          "pursuit-drive",
          "pursuit-use",
          "pursuit-policy",
          "street-pursuit-start",
          "street-pursuit-stop",
        ].includes(event.command?.type) ||
        (event.command.type === "vehicle-test" &&
          (data.environment !== "vehicle" || event.command.operation !== "run"))
      )
        throw new Error("Invalid replay event");
      lastTick = event.tick;
    }
    const world = new World(data.config, data.environment);
    let index = 0;
    while (world.tick < data.totalTicks) {
      while (
        index < data.events.length &&
        data.events[index].tick === world.tick
      )
        world.command(data.events[index++].command);
      const beforeTick = world.tick;
      world.step();
      if (world.tick === beforeTick)
        throw new Error("Replay cannot advance a stopped scene without its recorded run event");
      if (world.tick % 120 === 0) yield world;
    }
    while (index < data.events.length && data.events[index].tick === world.tick)
      world.command(data.events[index++].command);
    return world;
  }
  static fromReplay(data) {
    const steps = World.reconstruct(data);
    let result = steps.next();
    while (!result.done) result = steps.next();
    return result.value;
  }
}

function validatePracticeCommand(command, canLearn, canLoad) {
  if (command.learn !== undefined && (!canLearn || typeof command.learn !== "boolean"))
    throw new TypeError("Practice needs a boolean option on a learning pursuit");
  if (command.checkpoint !== undefined) {
    if (!canLoad) throw new TypeError("A Lab checkpoint requires a pack pursuit");
    validatePackPolicy(command.checkpoint);
  }
}
