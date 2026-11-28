import { isCrowdAheadPedestrian, nextWalk, pedestrianMotion } from "./pedestrian.js";
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
import { integrateVehicle, followPath, resolveVehicleContact, copyVehicleMotion, clearVehicleMotion, vehicleVelocity } from "./vehicle.js";
import { createVehicleState, advanceVehicleState } from "./vehicle-state.js";
import {
  JETOUR_T2_ID, KING_LONG_MICROBUS, KING_LONG_MICROBUS_ID, PLAYER_VEHICLE, playerVehicleDimensions,
} from "./vehicle-spec.js";
import { roadLayout } from "./roads.js";
import { cityFootprints } from "./scenery.js";
import { SpatialIndex } from "./spatial-index.js";
import { CITY_PROP_PROFILE, registerCityProps, recordCityPropImpact } from "./city-props.js";
import { triggerScenario, updateScenarios } from "./scenarios.js";
import { parkingBays, planArrival } from "./arrival.js";
import { policySpeed, validatePolicy } from "./policy.js";
import { trafficQueueStats } from "./queue-metrics.js";
import { signalSpeedLimit } from "./signals.js";
import { VisualCrossingPredictor } from "./visual-prediction.js";
import { createVisionScenario, advanceVisionActor } from "./vision-scenarios.js";
import { createEgyptDistrict } from "./egypt-district.js";
import {
  createUnifiedCity,
  GRAND_CITY_POPULATION_DEFAULTS,
  GRAND_CITY_POPULATION_LIMITS,
  METRO_POPULATION_LIMITS,
  RUSH_CITY_POPULATION_DEFAULTS,
  RUSH_CITY_POPULATION_LIMITS,
} from "./unified-city.js";
import { advanceCityEncounters, capCityEncounter, createCityEncounters } from "./city-encounters.js";
import { planDistrictRoute } from "./district-navigation.js";
import {
  createDistrictBehaviorState, initializeDistrictActor, nextDistrictWalk,
  createWalkTargetQuery, stepDistrictPedestrian, updateDistrictTraffic, districtTrafficCommand,
  districtBehaviorDiagnostics, isPackPursuit, planDistrictTrafficTrip, usesRushPace,
} from "./district-behavior.js";
import { createDistrictCase, advanceDistrictCase } from "./district-scenarios.js";
import { createPursuitState, populatePursuit, stepPursuit, pursuitSnapshot,
  beginStreetPursuit, endStreetPursuit, startPackDrill, stepPackReview,
  recordActorVisualCrash, spawnCrowdAhead, getCrowdAheadCount, syncPursuitStatus } from "./pursuit-world.js";
import {
  beginStreetChaos, endStreetChaos, setStreetChaosDriver, stepStreetChaos, streetChaosActorNeedsCommand,
  streetChaosSnapshot, streetChaosTrafficCommand, triggerStreetChaosEvent,
} from "./street-chaos.js";
import { defensiveAutoCommand } from "./defensive-driver.js";
import { CITY_CRUISE_STRATEGY } from "./driver/strategies.js";
import { stepUnifiedDriver } from "./driver/unified-driver.js";
import {
  METRO_CITY_CURBS,
  acceptCurbPose,
  surveyMetroCurb,
  sweepSafeWithCurbs,
} from "./pako-curb.js";
import {
  WHEEL_SCRUB_MODE,
  computeCurbWheelScrub,
  consumeActorPendingLongDv,
  getActorImpactReaction,
  recordActorImpactReaction,
  stepActorImpactReaction,
} from "./wheel-interaction-physics.js";
import { createCityTerrain, sampleCitySurface, terrainElevationAt } from "./city-surfaces.js";
import { canEndSurvival, isCityHunt, isSurvival, survivalGhostPair } from "./pursuit-survival.js";
import { createPackLearner, starterPackPolicy, validatePackPolicy } from "./pack-driving.js";
import {
  PURSUIT_STOP,
  buildNitroBoostPose,
  isNitroEngaged,
  nitroBoostLimits,
  pursuitCommand,
  stepNitroTank,
  validatePursuitAction,
} from "./pursuit-controls.js";
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
  kind: a.kind,
  vehicleKind: a.vehicleKind,
  spec: a.spec,
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

const manualControlMap = new WeakMap();
const driveNitroMap = new WeakMap();
const distantStaticClearCache = new WeakMap();
const distantWorldVehicleCmdCache = new WeakMap();
const vehicleSingleRoadCache = new WeakMap();
const worldRoadGridCache = new WeakMap();

const isPlayerVehicleModel = (model) => model === JETOUR_T2_ID || model === KING_LONG_MICROBUS_ID;

function cityPlayerSpec(config, model) {
  if (model === KING_LONG_MICROBUS_ID) {
    const van = KING_LONG_MICROBUS;
    return {
      wheelbase: van.wheelbaseM, maxSteer: van.maxSteerRad, steerRate: van.steerRateRadS,
      acceleration: van.accelerationMps2, braking: van.brakingMps2, reverseSpeed: van.reverseSpeedMps,
      realisticDynamics: true, tireGripMps2: van.tireGripMps2,
      contactResponse: "inelastic-slide-v1", massKg: van.massKg,
      ...(config.interactionProfile === WHEEL_SCRUB_MODE ? { wheelInteractionPhysics: WHEEL_SCRUB_MODE } : {}),
    };
  }
  return {
    wheelbase: PLAYER_VEHICLE.wheelbaseM,
    maxSteer: PLAYER_VEHICLE.maxSteerRad,
    ...(config.vehicleDynamics === "city-realism-v1" ? {
      realisticDynamics: true, tireGripMps2: 8,
      contactResponse: "inelastic-slide-v1", massKg: PLAYER_VEHICLE.massKg,
      ...(config.interactionProfile === WHEEL_SCRUB_MODE ? { wheelInteractionPhysics: WHEEL_SCRUB_MODE } : {}),
    } : {}),
  };
}

function localVehicleRoads(roads, body) {
  if (!Array.isArray(roads) || roads.length <= 16) return roads;
  let grid = worldRoadGridCache.get(roads);
  const CELL = 48;
  if (!grid || grid.len !== roads.length) {
    const map = new Map();
    for (let i = 0; i < roads.length; i++) {
      const r = roads[i];
      if (!r) continue;
      let minX, maxX, minZ, maxZ;
      const pad = (r.width ?? 14) * 0.5 + 10;
      if (r.axis === "z") {
        minX = r.fixed - pad;
        maxX = r.fixed + pad;
        minZ = r.min - pad;
        maxZ = r.max + pad;
      } else if (r.axis === "x") {
        minX = r.min - pad;
        maxX = r.max + pad;
        minZ = r.fixed - pad;
        maxZ = r.fixed + pad;
      } else if (r.axis === "diag") {
        const rx2 = r.x2 ?? r.x1 + r.ux * r.length;
        const rz2 = r.z2 ?? r.z1 + r.uz * r.length;
        minX = Math.min(r.x1, rx2) - pad;
        maxX = Math.max(r.x1, rx2) + pad;
        minZ = Math.min(r.z1, rz2) - pad;
        maxZ = Math.max(r.z1, rz2) + pad;
      } else {
        continue;
      }
      const x0 = Math.floor(minX / CELL);
      const x1 = Math.floor(maxX / CELL);
      const z0 = Math.floor(minZ / CELL);
      const z1 = Math.floor(maxZ / CELL);
      for (let cx = x0; cx <= x1; cx++) {
        for (let cz = z0; cz <= z1; cz++) {
          const key = (cx << 16) ^ (cz & 0xffff);
          let bucket = map.get(key);
          if (!bucket) {
            bucket = [];
            map.set(key, bucket);
          }
          bucket.push(r);
        }
      }
    }
    grid = { len: roads.length, map };
    worldRoadGridCache.set(roads, grid);
  }
  const cx = Math.floor(body.x / CELL);
  const cz = Math.floor(body.z / CELL);
  return grid.map.get((cx << 16) ^ (cz & 0xffff)) ?? roads;
}

function bodyInsideSingleRoadFast(body, road) {
  if (!road) return false;
  const h = (road.width ?? 0) * 0.5;
  if (h <= 0) return false;
  const heading = body.heading ?? 0;
  const s = Math.sin(heading);
  const c = Math.cos(heading);
  const hw = (body.width ?? VEHICLE.width) * 0.5;
  const hl = (body.length ?? VEHICLE.length) * 0.5;
  const cw = Math.abs(c) * hw + Math.abs(s) * hl;
  const sw = Math.abs(s) * hw + Math.abs(c) * hl;
  if (road.axis === "z") {
    return (
      body.x - cw >= road.fixed - h &&
      body.x + cw <= road.fixed + h &&
      body.z - sw >= road.min - h &&
      body.z + sw <= road.max + h
    );
  }
  if (road.axis === "x") {
    return (
      body.x - cw >= road.min - h &&
      body.x + cw <= road.max + h &&
      body.z - sw >= road.fixed - h &&
      body.z + sw <= road.fixed + h
    );
  }
  if (road.axis === "diag") {
    const ux = road.ux;
    const uz = road.uz;
    const dx = body.x - road.x1;
    const dz = body.z - road.z1;
    const along = dx * ux + dz * uz;
    const lat = Math.abs(-dx * uz + dz * ux);
    const r = Math.hypot(hw, hl);
    return along - r >= -h && along + r <= road.length + h && lat + r <= h;
  }
  return false;
}

/** Authoritative, DOM-free simulation. Only step() commits movement. */
export class World {
  constructor(options = {}, environment = "city") {
    const cityVersion = environment === "metro" ? options.cityVersion ?? 2 : null;
    const rush = cityVersion >= 4;
    const grand = cityVersion === 5;
    const popDefaults = grand ? GRAND_CITY_POPULATION_DEFAULTS : rush ? RUSH_CITY_POPULATION_DEFAULTS : null;
    const popLimits = grand
      ? GRAND_CITY_POPULATION_LIMITS
      : rush
        ? RUSH_CITY_POPULATION_LIMITS
        : cityVersion === 3
          ? METRO_POPULATION_LIMITS
          : null;
    this.config = settings(
      popDefaults ? { ...popDefaults, speedLimit: grand ? 52 : 48, ...options } : options,
      popLimits,
    );
    if (grand) {
      if (options.cityPropProfile !== undefined && !["none", CITY_PROP_PROFILE].includes(options.cityPropProfile))
        throw new Error("Unsupported City prop profile");
      this.config.cityPropProfile = options.cityPropProfile ?? CITY_PROP_PROFILE;
      if (options.vehicleDynamics !== undefined &&
          !["legacy", "city-realism-v1"].includes(options.vehicleDynamics))
        throw new Error("Unsupported City vehicle dynamics profile");
      if (options.terrainProfile !== undefined &&
          !["flat", "cairo-surfaces-v1"].includes(options.terrainProfile))
        throw new Error("Unsupported City terrain profile");
      if (options.interactionProfile !== undefined &&
          !["none", WHEEL_SCRUB_MODE].includes(options.interactionProfile))
        throw new Error("Unsupported City interaction profile");
      if (options.vehicleDynamics !== "legacy")
        this.config.vehicleDynamics = "city-realism-v1";
      // Negative control: false drives the rigid centre line instead of the Unified Driver.
      if (options.unifiedDriver === false) this.config.unifiedDriver = false;
      if (this.config.vehicleDynamics === "city-realism-v1" && options.terrainProfile !== "flat")
        this.config.terrainProfile = "cairo-surfaces-v1";
      if (this.config.vehicleDynamics === "city-realism-v1" &&
          this.config.terrainProfile === "cairo-surfaces-v1" &&
          options.interactionProfile !== "none")
        this.config.interactionProfile = WHEEL_SCRUB_MODE;
    }
    this.environment = environment;
    this.pursuit = environment === "pursuit" ? createPursuitState(options) : null;
    if (this.pursuit) Object.assign(this.config, {
      pursuitLevel: this.pursuit.level, pursuitCase: this.pursuit.caseId,
      ...(this.pursuit.packLab ? { pursuitVariant: this.pursuit.variant } : {}),
    });
    if (environment === "egypt") Object.assign(this.config, districtOptions(options));
    const metroCity = environment === "metro" ? createUnifiedCity({ dense: cityVersion >= 3, rush, grand }) : null;
    this.district = metroCity ? { ...metroCity, metro: true } :
      environment === "egypt" ? createEgyptDistrict() : null;
    if (metroCity?.pedestrianSpawnPool)
      Object.defineProperty(this.district, "pedestrianSpawnPool", { value: metroCity.pedestrianSpawnPool });
    this.districtCase = environment === "egypt"
      ? createDistrictCase(this.district, this.config.districtCase, this.config.seed) : null;
    if (this.district) {
      if (environment === "metro") {
        if (![1, 2, 3, 4, 5].includes(cityVersion))
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
    this.terrain = grand && this.config.terrainProfile === "cairo-surfaces-v1"
      ? createCityTerrain(this.roads, { seed: this.config.seed })
      : null;
    this.terrainElevationAt = this.terrain
      ? (x, z) => terrainElevationAt(this.terrain, x, z)
      : null;
    registerCityProps(this);
    this.staticIndex = new SpatialIndex(this.statics);
    this.curbs = grand && this.config.interactionProfile === WHEEL_SCRUB_MODE
      ? surveyMetroCurb(this, METRO_CITY_CURBS)
      : null;
    this._activeJoltActors = new Set();
    this._surfaceScratch = {};
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
  makeVehicle(id, kind, position, rng = this.rng) {
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
      spec: id === "player" ? cityPlayerSpec(this.config) : tuk ? { wheelbase: 1.9 } : null,
      maxSpeed: (this.config.speedLimit / 3.6) * (tuk ? 0.7 : 1),
      path: [],
      cursor: 0,
      distance: 0,
      wait: 0,
      reason: "ready",
      phase: rng.next(),
      reckless: id !== "player" && rng.next() < this.config.chaos,
      ...(id === "player"
        ? {
            height: PLAYER_VEHICLE.heightM,
            vehicle: createVehicleState(),
            nitroCharge: 1,
            nitroActive: false,
            nitroIntensity: 0,
            nitroSuppressedByPedestrian: false,
            ...(this.config.vehicleDynamics === "city-realism-v1"
              ? { chaseSlipRad: 0 } : {}),
          }
        : {}),
    };
  }
  get crowdAheadCount() {
    return getCrowdAheadCount(this);
  }
  setManualControl(control = {}) {
    if (this.vehicleTest?.phase === "running") return false;
    const rawThrottle = Number(control?.throttle) || 0;
    const gear = control?.gear === -1 || (control?.gear === undefined && rawThrottle < 0) ? -1 : 1;
    const throttle = clamp(Math.abs(rawThrottle), 0, 1);
    const brake = clamp(Number(control?.brake) || 0, 0, 1);
    const steer = clamp(Number(control?.steer) || 0, -1, 1);
    const nitro = clamp(Number(control?.nitro) || 0, 0, 1);
    const normalized = { steer, throttle, brake, gear, nitro };
    this.mode = "manual";
    driveNitroMap.delete(this);
    manualControlMap.set(this, normalized);
    const preview = pursuitCommand(this.player, normalized, STEP);
    this.input = {
      targetSpeed: preview.targetSpeed,
      steer: preview.steer,
    };
    if (this.pursuit?.phase === "running") {
      this.pursuit.manualAction = { ...normalized };
    }
    return true;
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
    let sparePedestrianSpawn = district.pedestrianSpawns.length;
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
      if (!this.free(person, 0.12) && this.config.cityPropProfile === CITY_PROP_PROFILE) {
        const pool = district.pedestrianSpawnPool ?? [];
        while (sparePedestrianSpawn < pool.length) {
          const replacement = pool[sparePedestrianSpawn++];
          const replacementRoad = district.drivingRoads.find(item => item.id === replacement.roadId);
          if (!replacementRoad) continue;
          const candidate = { ...person, ...replacement, road: replacementRoad };
          if (!this.free(candidate, .12)) continue;
          Object.assign(person, replacement, { road: replacementRoad });
          break;
        }
      }
      if (!this.free(person, 0.12)) throw new Error(`District person spawn ${i} is not clear.`);
      initializeDistrictActor(this, person);
      this.nextWalk(person);
      this.actors.push(person);
    }
    this.capacity = { traffic: this.config.traffic, pedestrians: this.config.pedestrians };
  }
  assignTrafficRoute(car) {
    if (this.streetChaos?.active && car.kind === "truck" && car.id.startsWith("chaos-truck-")) {
      // Freight trucks keep to their straight avenue lane; they never wedge into side streets.
      car.path = [];
      car.cursor = 0;
      return false;
    }
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
  selectPlayerVehicle(model, record = true) {
    if (!isPlayerVehicleModel(model)) return { ok: false, error: "Unknown player vehicle." };
    if (this.environment !== "metro") return { ok: false, error: "Vehicle selection is only available in City." };
    const { player } = this;
    if ((player.vehicleModel ?? JETOUR_T2_ID) === model) return { ok: true, changed: false };
    if (this.pursuit?.phase === "running" || this.pursuit?.reviewUntilTick)
      return { ok: false, error: "End Chase and finish any impact review before changing vehicles." };

    const velocity = vehicleVelocity(player);
    const manual = manualControlMap.get(this);
    const busy = this.mode === "auto" ? player.path.length > 0
      : manual ? manual.throttle > 0 && manual.brake === 0 : this.input.targetSpeed !== 0;
    if (busy || Math.hypot(velocity.x, velocity.z, player.gtaSlipMps ?? 0) > 1e-4)
      return { ok: false, error: "Stop and idle the player vehicle before changing models." };

    const dimensions = playerVehicleDimensions({ vehicleModel: model });
    const footprint = { ...copyPose(player), length: dimensions.lengthM, width: dimensions.widthM };
    // At selection time check live bodies directly rather than accepting a stale index
    // or rejecting merely because the candidate is within the driving safety margin.
    if (this.statics.some((body) => overlaps(footprint, body)) ||
        this.actors.some((body) => body !== player && overlaps(footprint, body)))
      return { ok: false, error: "There is not enough clear space for the selected vehicle." };

    const microbus = model === KING_LONG_MICROBUS_ID;
    const cityLimit = this.config.speedLimit / 3.6;
    Object.assign(player, {
      length: dimensions.lengthM,
      width: dimensions.widthM,
      height: dimensions.heightM,
      spec: cityPlayerSpec(this.config, model),
      maxSpeed: microbus ? Math.min(cityLimit, dimensions.maxSpeedMps) : cityLimit,
      speed: 0,
      steer: 0,
      blockedBy: null,
      nitroActive: false,
      nitroIntensity: 0,
      nitroSuppressedByPedestrian: false,
      vehicle: { ...createVehicleState({ vehicleModel: model }), nitroCharge: player.nitroCharge },
    });
    if (microbus) player.vehicleModel = model;
    else delete player.vehicleModel;
    if (player.spec.realisticDynamics) player.chaseSlipRad = 0;
    else delete player.chaseSlipRad;
    clearVehicleMotion(player);
    player.previous = copyPose(player);
    vehicleSingleRoadCache.delete(player);
    distantStaticClearCache.delete(player);
    manualControlMap.delete(this);
    driveNitroMap.delete(this);
    this.input = { targetSpeed: 0, steer: 0 };
    if (player.path.length || player.parking || this.destination) {
      player.path = [];
      player.cursor = 0;
      player.parking = null;
      this.destination = null;
      this.routeRevision++;
    }

    this.districtSpeedState = createDistrictSpeedState();
    if (this.visualPredictor.streamId !== null) this.visualPredictor.reset(this.visualPredictor.streamId);
    this.visualDecision = this.visualState = null;
    this.sensorProcessor = new RangeSignalProcessor();
    this.actorIndex = new SpatialIndex(this.actors);
    this.updateSensors();
    if (record) this.events.push({ tick: this.tick, command: { type: "player-vehicle", model } });
    return { ok: true, changed: true };
  }
  command(command, record = true) {
    if (command.type === "player-vehicle") return this.selectPlayerVehicle(command.model, record);
    if (typeof command.type === "string" && command.type.startsWith("street-chaos-")) {
      if (this.environment !== "metro") throw new Error("Cairo Traffic is only available in City");
      let result = true;
      if (command.type === "street-chaos-start") {
        beginStreetChaos(this, command);
        if (this.mode === "auto") {
          manualControlMap.delete(this);
          driveNitroMap.delete(this);
        }
      } else if (command.type === "street-chaos-stop") {
        endStreetChaos(this);
        if (this.mode === "manual") {
          manualControlMap.delete(this);
          driveNitroMap.delete(this);
          this.input = { targetSpeed: 0, steer: 0 };
        }
      } else if (command.type === "street-chaos-event") {
        result = Boolean(triggerStreetChaosEvent(this, command.kind));
      } else if (command.type === "street-chaos-driver") {
        const mode = command.mode ?? command.driverMode ?? command.driver;
        setStreetChaosDriver(this, mode);
        if (mode === "auto") {
          manualControlMap.delete(this);
          driveNitroMap.delete(this);
        } else {
          manualControlMap.delete(this);
          driveNitroMap.delete(this);
          this.input = { targetSpeed: clamp(this.player.speed, 0, this.player.maxSpeed), steer: 0 };
        }
      } else throw new Error("Unknown Cairo Traffic command");
      if (record) this.events.push({ tick: this.tick, command: structuredClone(command) });
      return result;
    }
    if (command.type === "street-pursuit-start" || command.type === "street-pursuit-stop") {
      if (this.environment !== "metro") throw new Error("Street pursuit is only available in City");
      if (command.type === "street-pursuit-start") {
        if (this.streetChaos?.active) throw new Error("End Cairo Traffic before starting Chase");
        if (this.pursuit?.phase === "running") throw new Error("A street pursuit is already running");
        const pack = isPackPursuit(command.variant);
        const training = pack && !isSurvival(command.variant);
        validatePracticeCommand(command, training || command.variant === "arcade", training);
        const resumeMode = this.mode;
        const resumeTrip = resumeMode === "auto" && Boolean(this.destination) && this.player.path.length > 1;
        beginStreetPursuit(this, command.level, command.variant, command.config);
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
        this.mode = pursuit.gta ? "manual" : "auto";
      } else {
        if (this.pursuit?.phase !== "running" && !this.pursuit?.reviewUntilTick)
          throw new Error("No running street pursuit");
        if (this.pursuit.survival && !canEndSurvival(this))
          throw new Error("Move clear of the obstacle before ending Ghost mode.");
        this.pursuit.learner?.interrupt();
        endStreetPursuit(this);
        this.resumeStreetDrive();
      }
      if (record) {
        const config = this.pursuit?.gta?.config;
        const recorded = command.type === "street-pursuit-start" && config?.ruleset === "dispatch-v1"
          ? { ...command, config } : command;
        this.events.push({ tick: this.tick, command: structuredClone(recorded) });
      }
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
      if (this.environment !== "vehicle") return false;
      if (command.operation === "reset") {
        if (record)
          this.events.push({ tick: this.tick, command: structuredClone(command) });
        this.mode = "manual";
        this.input = { targetSpeed: 0, steer: 0 };
        Object.assign(this.player, {
          x: vehicleStart.x,
          z: vehicleStart.z,
          y: 0,
          heading: vehicleStart.heading,
          speed: 0,
          steer: 0,
          path: [],
          parking: null,
          cursor: 0,
          maxSpeed: this.config.speedLimit / 3.6,
          spec: {
            wheelbase: PLAYER_VEHICLE.wheelbaseM,
            maxSteer: PLAYER_VEHICLE.maxSteerRad,
            ...(this.config.vehicleDynamics === "city-realism-v1" ? {
              realisticDynamics: true, tireGripMps2: 8,
              contactResponse: "inelastic-slide-v1", massKg: PLAYER_VEHICLE.massKg,
              ...(this.config.interactionProfile === WHEEL_SCRUB_MODE
                ? { wheelInteractionPhysics: WHEEL_SCRUB_MODE }
                : {}),
            } : {}),
          },
          vehicle: createVehicleState(),
          nitroCharge: 1,
          nitroActive: false,
          nitroIntensity: 0,
          nitroSuppressedByPedestrian: false,
        });
        manualControlMap.delete(this);
        driveNitroMap.delete(this);
        delete this.player.previous;
        clearVehicleMotion(this.player);
        this.destination = null;
        this.routeRevision++;
        Object.assign(this.vehicleTest, {
          phase: "ready",
          maxSpeedMps: 5,
          startedTick: null,
          contactTick: null,
          impact: null,
          error: null,
        });
        this.updateSensors();
        return true;
      }
      if (
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
      const heavy = command.heavy === true;
      if (command.heavy !== undefined && typeof command.heavy !== "boolean") return false;
      this.mode = "manual";
      this.input = { targetSpeed: 0, steer: 0 };
      this.player.path = [];
      this.player.parking = null;
      this.player.cursor = 0;
      this.destination = null;
      this.routeRevision++;
      if (heavy) {
        this.player.maxSpeed = Math.max(this.player.maxSpeed, 15.5);
        this.player.spec = { ...this.player.spec, acceleration: 10.4 };
      }
      Object.assign(this.vehicleTest, {
        phase: "running",
        maxSpeedMps: heavy ? 15 : 5,
        startedTick: this.tick,
        error: null,
      });
      return true;
    }
    if (command.type === "spawn-crowd-ahead") {
      if (command.layout !== undefined && command.layout !== "dispersed-cohorts-v1")
        throw new Error("Unsupported crowd layout");
      if (["vision", "vehicle"].includes(this.environment)) return false;
      const count = clamp(
        Math.round(Number.isFinite(Number(command.count)) ? Number(command.count) : 20),
        1,
        40,
      );
      spawnCrowdAhead(this, count, { layout: command.layout });
      if (record) {
        this.events.push({ tick: this.tick, command: { type: "spawn-crowd-ahead", count,
          ...(command.layout === undefined ? {} : { layout: command.layout }) } });
      }
      return true;
    }
    if (command.type === "manual") {
      if (this.vehicleTest?.phase === "running") return false;
      this.setManualControl(command);
      if (record) {
        this.events.push({ tick: this.tick, command: structuredClone(command) });
      }
      return true;
    }
    if (
      this.vehicleTest?.phase === "running" &&
      ["drive", "mode", "destination", "scenario"].includes(command.type)
    )
      return false;
    if (this.environment === "metro" && (this.pursuit?.phase === "running" || this.pursuit?.reviewUntilTick) &&
        (command.type === "destination" || (command.type === "mode" && command.mode === "auto" &&
          this.player.vehicleModel === KING_LONG_MICROBUS_ID)))
      return false;
    if (command.type === "policy" && command.weights)
      validatePolicy(command.weights);
    if (record)
      this.events.push({ tick: this.tick, command: structuredClone(command) });
    if (command.type === "drive") {
      manualControlMap.delete(this);
      const rawTargetSpeed = Number(command.targetSpeed) || 0;
      const microbus = this.player.vehicleModel === KING_LONG_MICROBUS_ID;
      const clampedSteer = clamp(
        Number(command.steer) || 0,
        -(microbus ? this.player.spec.maxSteer : VEHICLE.maxSteer),
        microbus ? this.player.spec.maxSteer : VEHICLE.maxSteer,
      );
      if (command.nitro !== undefined) {
        const nitro = clamp(Number(command.nitro) || 0, 0, 1);
        const maxSteer = this.player.spec?.maxSteer ?? VEHICLE.maxSteer;
        driveNitroMap.set(this, {
          steer: clamp(clampedSteer / maxSteer, -1, 1),
          throttle: rawTargetSpeed > 0 ? 1 : 0,
          brake: 0,
          gear: rawTargetSpeed < 0 ? -1 : 1,
          nitro,
        });
      } else {
        driveNitroMap.delete(this);
      }
      this.input = {
        targetSpeed: clamp(
          rawTargetSpeed,
          microbus ? -this.player.spec.reverseSpeed : -2.5,
          this.player.maxSpeed,
        ),
        steer: clampedSteer,
      };
    }
    if (command.type === "mode") {
      this.mode = command.mode === "auto" ? "auto" : "manual";
      if (this.mode === "auto") {
        manualControlMap.delete(this);
        driveNitroMap.delete(this);
      }
    }
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
      manualControlMap.delete(this);
      driveNitroMap.delete(this);
      this.input = { targetSpeed: 0, steer: 0 };
      if (Math.abs(this.player.speed) < 1e-8) clearVehicleMotion(this.player);
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
    let safe = this.safeSpeed(actor, composed, usePlannedPath);
    if (actor === this.player && this.mode === "manual" &&
        this.statics.some(site => site.propImpact && site.id === safe.blockedBy))
      safe = composed;
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
    const remCap = (this.config.cityVersion ?? 0) >= 5 ? ((actor.maxSpeed ?? 15) ** 2) / 4 + 6 : Infinity;
    let command = followPath(actor, actor.path, actor.cursor, false, remCap);
    actor.cursor = command.cursor;
    if (actor.path.length && command.remaining < 1.5) {
      this.metrics.trafficTrips++;
      this.assignTrafficRoute(actor);
      freezePath(actor.path);
      command = followPath(actor, actor.path, 0, false, remCap);
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
        if (typeof pursuit.decision?.nitroSuppressedByPedestrian === "boolean") {
          this.player.nitroSuppressedByPedestrian = pursuit.decision.nitroSuppressedByPedestrian;
        }
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
    const metroV5PursuitLod = (this.config.cityVersion ?? 0) >= 5 && this.environment === "metro";
    updateDistrictTraffic(this);
    let query;
    // Build after any Dispatch squad changes, on the first target query of this tick.
    const targetBlocker = pursuit.response?.dispatch
      ? target => (query ??= createWalkTargetQuery(this.actors))(target)
      : undefined;
    const pxPursuit = this.player?.x ?? 0;
    const pzPursuit = this.player?.z ?? 0;
    stepPursuit(this, action, {
      pedestrianMotion: actor => {
        if (isCrowdAheadPedestrian(actor)) return pedestrianMotion(this, actor, true);
        if (metroV5PursuitLod) {
          const distSq = (actor.x - pxPursuit) ** 2 + (actor.z - pzPursuit) ** 2;
          if (distSq > 65 * 65 && actor.motionMode !== "stop") {
            const idStr = actor.id ?? "";
            const mask = distSq > 120 * 120 ? 7 : 3;
            if (((this.tick + (idStr.charCodeAt(idStr.length - 1) || 0)) & mask) !== 0) {
              if (actor.speed === 0) {
                return {
                  ...actor,
                  pause: (actor.pause ?? 0) > 0 ? Math.max(0, actor.pause - STEP) : 0,
                  accelerationMps2: 0,
                  turnRateRadS: 0,
                };
              }
              const walkRef = actor.walkRoute?.[0] ?? actor.target;
              if (walkRef && (actor.pause ?? 0) === 0 && actor.reason !== "blocked" &&
                  (walkRef.x - actor.x) ** 2 + (walkRef.z - actor.z) ** 2 > 0.64) {
                const desiredH = Math.atan2(walkRef.x - actor.x, walkRef.z - actor.z);
                const maxTurn = (actor.body?.maxTurnRateRadS ?? 4.2) * STEP;
                const nextH = actor.heading + clamp(angleDelta(desiredH, actor.heading), -maxTurn, maxTurn);
                const stepM = actor.speed * STEP;
                return {
                  ...actor,
                  x: actor.x + Math.sin(nextH) * stepM,
                  z: actor.z + Math.cos(nextH) * stepM,
                  heading: nextH,
                  accelerationMps2: 0,
                  turnRateRadS: angleDelta(nextH, actor.heading) / STEP,
                };
              }
            }
          }
        }
        return stepDistrictPedestrian(this, actor, targetBlocker);
      },
      vehicleCommand: (actor, requested) => pursuit.gta &&
          (pursuit.patrols.has(actor) || (actor === this.player && (this.mode === "manual" || pursuit.frozenDriver?.status === "active")))
        ? requested : actor.pursuitRole === "police"
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
    if (this.pursuit?.gta && this.pursuit.phase !== "running") this.pursuit.stepEvents.length = 0;
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
    if (this._activeJoltActors?.size) {
      let parkedDisplaced = false;
      const scrubEnabled = this.config?.interactionProfile === WHEEL_SCRUB_MODE;
      for (const jolted of this._activeJoltActors) {
        const res = stepActorImpactReaction(jolted, STEP);
        if (
          scrubEnabled &&
          jolted.kind === "parked-vehicle" &&
          res.stictionBroken &&
          (Math.abs(res.lateralPushMps) > 0.04 ||
            Math.abs(res.longitudinalPushMps) > 0.04 ||
            Math.abs(res.yawPushRadS) > 0.03)
        ) {
          // Above static breakaway (closing >= 1.35 m/s), parked vehicles skid & skew under Coulomb tire-ground friction!
          const nextH = (jolted.heading ?? 0) + res.yawPushRadS * STEP;
          const sH = Math.sin(nextH);
          const cH = Math.cos(nextH);
          const cand = {
            ...jolted,
            x: jolted.x + (cH * res.lateralPushMps + sH * res.longitudinalPushMps) * STEP,
            z: jolted.z + (-sH * res.lateralPushMps + cH * res.longitudinalPushMps) * STEP,
            heading: nextH,
          };
          const movesAwayOrClear =
            !overlaps(cand, this.player, 0.13) ||
            (distance(cand, this.player) >= distance(jolted, this.player) && !overlaps(cand, this.player, 0.01));
          const nearStatics = this.staticIndex.near(cand, 11);
          const clearStatics = !nearStatics.some((s) => s !== jolted && overlaps(cand, s));
          const clearActors = !this.actors.some((a) =>
            a !== this.player && overlaps(cand, a, a.type === "pedestrian" ? 0.35 : 0),
          );
          if (movesAwayOrClear && clearStatics && clearActors) {
            jolted.x = cand.x;
            jolted.z = cand.z;
            jolted.heading = cand.heading;
            parkedDisplaced = true;
          }
        }
        if (!res.active) this._activeJoltActors.delete(jolted);
      }
      if (parkedDisplaced) {
        this.staticIndex = new SpatialIndex(this.statics);
      }
    }
    if (this.cityEncounters) advanceCityEncounters(this);
    if (this.pursuit?.phase === "running") {
      this.stepPursuitMode(ownMotion, nowS);
      return;
    }
    const chaosOn = this.streetChaos?.active === true;
    if (chaosOn) stepStreetChaos(this);
    const metroV5 = this.environment === "metro" && (this.config?.cityVersion ?? 0) >= 5;
    const ambientMetroV5 = metroV5 && !(this.districtCase && this.districtCase.id !== "ambient");
    if (this.district && (!ambientMetroV5 || (this.tick & 3) === 0)) updateDistrictTraffic(this);
    if (this.environment !== "vehicle") updateScenarios(this);
    this.actorIndex = new SpatialIndex(this.actors);
    if (this.junctionGroups.length > 0) this.updateJunctions();
    const playerStartX = this.player.x;
    const playerStartZ = this.player.z;
    let walkQuery = null;
    const targetBlocker = ambientMetroV5
      ? (target) => (walkQuery ??= createWalkTargetQuery(this.actors))(target)
      : undefined;
    // Old poses are reserved until the tick ends. An accepted move can never
    // tunnel through the position another actor occupied at the start of a tick.
    let reservedInput;
    if (metroV5) {
      const pool = (this._reservedPosePool ??= []);
      const n = this.actors.length;
      while (pool.length < n) {
        pool.push({
          id: "",
          type: "",
          kind: undefined,
          vehicleKind: undefined,
          spec: null,
          x: 0,
          z: 0,
          heading: 0,
          speed: 0,
          length: undefined,
          width: undefined,
          radius: undefined,
        });
      }
      if (pool.length > n) pool.length = n;
      for (let i = 0; i < n; i++) {
        const src = this.actors[i];
        const dst = pool[i];
        dst.id = src.id;
        dst.type = src.type;
        dst.kind = src.kind;
        dst.vehicleKind = src.vehicleKind;
        dst.spec = src.spec;
        dst.x = src.x;
        dst.z = src.z;
        dst.heading = src.heading;
        dst.speed = src.speed;
        dst.length = src.length;
        dst.width = src.width;
        dst.radius = src.radius;
      }
      reservedInput = pool;
    } else {
      reservedInput = this.actors.map(copyPose);
    }
    const reserved = new SpatialIndex(reservedInput);
    for (let actorIdx = 0; actorIdx < this.actors.length; actorIdx++) {
      const actor = this.actors[actorIdx];
      if (metroV5 && actor !== this.player && actor.previous) {
        actor.previous.x = actor.x;
        actor.previous.z = actor.z;
        actor.previous.heading = actor.heading;
        actor.previous.speed = actor.speed;
      } else {
        actor.previous = copyPose(actor);
      }
      let next;
      let appliedCommand;
      let manualActionForNitro = null;
      let pedSuppressedNitro = false;
      let contact = null;
      const actorDistSq = ambientMetroV5 && actor !== this.player
        ? (actor.x - playerStartX) ** 2 + (actor.z - playerStartZ) ** 2
        : 0;
      const strideMask = actorDistSq > 135 * 135 ? 15 : actorDistSq > 80 * 80 ? 7 : 3;
      const nonStrideTick = ambientMetroV5 && ((this.tick + actorIdx) & strideMask) !== 0;
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
      if (actor.type === "pedestrian") {
        const farPedFast =
          nonStrideTick &&
          actorDistSq > 80 * 80 &&
          !isCrowdAheadPedestrian(actor) &&
          actor.motionMode !== "stop";
        if (farPedFast && actor.speed === 0) {
          if ((actor.pause ?? 0) > 0) {
            actor.pause = Math.max(0, actor.pause - STEP);
          }
          actor.accelerationMps2 = 0;
          actor.turnRateRadS = 0;
          actor.motionTimeS = (this.tick + 1) * STEP;
          actor.wait += STEP;
          continue;
        } else if (
          farPedFast &&
          actor.speed > 0 &&
          (actor.pause ?? 0) === 0 &&
          actor.target &&
          actor.reason !== "blocked"
        ) {
          const walkRef = actor.walkRoute?.[0] ?? actor.target;
          if ((walkRef.x - actor.x) ** 2 + (walkRef.z - actor.z) ** 2 > 0.64) {
            const desiredH = Math.atan2(walkRef.x - actor.x, walkRef.z - actor.z);
            const maxTurn = (actor.body?.maxTurnRateRadS ?? 4.2) * STEP;
            const nextH = actor.heading + clamp(angleDelta(desiredH, actor.heading), -maxTurn, maxTurn);
            const stepM = actor.speed * STEP;
            const candX = actor.x + Math.sin(nextH) * stepM;
            const candZ = actor.z + Math.cos(nextH) * stepM;
            const cacheKey = actor.body ?? actor;
            let stCache = distantStaticClearCache.get(cacheKey);
            if (
              !stCache ||
              stCache.staticIndex !== this.staticIndex ||
              (actor.x - stCache.x) ** 2 + (actor.z - stCache.z) ** 2 > 1.44
            ) {
              const probe = {
                type: "pedestrian",
                x: actor.x,
                z: actor.z,
                radius: (actor.radius ?? 0.38) + 1.38,
              };
              const candStatics = this.staticIndex.near(actor, 11);
              const closeStatics = [];
              for (let sIdx = 0; sIdx < candStatics.length; sIdx++) {
                if (overlaps(probe, candStatics[sIdx], 0.12)) {
                  closeStatics.push(candStatics[sIdx]);
                }
              }
              stCache = { staticIndex: this.staticIndex, x: actor.x, z: actor.z, statics: closeStatics };
              distantStaticClearCache.set(cacheKey, stCache);
            }
            const nearRes = reserved.near(actor, chaosOn ? 6.5 : 4);
            const rSelf = actor.radius ?? 0.38;
            let hasCloseBody = stCache.statics.length > 0;
            if (!hasCloseBody) {
              for (let rIdx = 0; rIdx < nearRes.length; rIdx++) {
                const other = nearRes[rIdx];
                if (other.id === actor.id) continue;
                const dx = other.x - candX;
                const dz = other.z - candZ;
                if (other.type === "pedestrian") {
                  const lim = rSelf + (other.radius ?? 0.38) + 0.13;
                  if (Math.abs(dx) <= lim && Math.abs(dz) <= lim && dx * dx + dz * dz <= lim * lim) {
                    hasCloseBody = true;
                    break;
                  }
                } else {
                  const vReach = chaosOn && other.length > 5.5 ? other.length * 0.5 + 1.55 : 3.65;
                  if (Math.abs(dx) <= vReach && Math.abs(dz) <= vReach) {
                    hasCloseBody = true;
                    break;
                  }
                }
              }
            }
            if (!hasCloseBody) {
              actor.turnRateRadS = angleDelta(nextH, actor.heading) / STEP;
              actor.heading = nextH;
              actor.x = candX;
              actor.z = candZ;
              actor.accelerationMps2 = 0;
              actor.motionTimeS = (this.tick + 1) * STEP;
              actor.distance += stepM;
              actor.wait = 0;
              reserved.add({
                id: actor.id,
                type: actor.type,
                x: candX,
                z: candZ,
                heading: nextH,
                radius: actor.radius,
              });
              continue;
            }
            next = {
              ...actor,
              x: candX,
              z: candZ,
              heading: nextH,
              accelerationMps2: 0,
              turnRateRadS: angleDelta(nextH, actor.heading) / STEP,
            };
          } else {
            next = stepDistrictPedestrian(this, actor, targetBlocker);
          }
        } else {
          next = isCrowdAheadPedestrian(actor)
            ? this.pedestrianMotion(actor)
            : this.district
              ? this.districtCase && this.districtCase.id !== "ambient"
                ? advanceDistrictCase(this, actor) : stepDistrictPedestrian(this, actor, targetBlocker)
              : this.visionLab
              ? advanceVisionActor(actor, STEP, {
                  timeS: (this.tick - this.visionLab.startedTick) * STEP,
                  tick: this.tick,
                })
              : this.pedestrianMotion(actor);
        }
      } else {
        const cachedCarEntry =
          nonStrideTick && actor !== this.player && actorDistSq > 95 * 95 &&
          !(chaosOn && streetChaosActorNeedsCommand(this, actor))
            ? distantWorldVehicleCmdCache.get(actor)
            : null;
        if (
          cachedCarEntry &&
          this.tick - cachedCarEntry.tick <= strideMask &&
          actor.reason !== "road-boundary" &&
          actor.districtSources?.appliedSource !== "physical-guard" &&
          actor.path.length > 2
        ) {
          appliedCommand = cachedCarEntry.cmd;
          if (actor.speed === 0 && appliedCommand.targetSpeed === 0) {
            actor.reason = appliedCommand.reason;
            actor.blockedBy = appliedCommand.blockedBy;
            actor.wait += STEP;
            continue;
          }
          next = integrateVehicle(actor, appliedCommand, STEP);
          next.reason = appliedCommand.reason;
          next.blockedBy = appliedCommand.blockedBy;
        } else {
        let command;
        const remCap = metroV5 && actor !== this.player
          ? ((actor.maxSpeed ?? 15) ** 2) / 4 + 6
          : Infinity;
        if (controlledTest)
          command = {
            targetSpeed: this.vehicleTest.maxSpeedMps,
            steer: 0,
            reason: "vehicle-test",
            blockedBy: null,
          };
        else if (actor === this.player && this.mode === "manual") {
          const explicitManual = manualControlMap.get(this);
          const driveNitro = driveNitroMap.get(this);
          if (explicitManual) {
            manualActionForNitro = explicitManual;
            command = pursuitCommand(actor, explicitManual, STEP);
          } else if (driveNitro) {
            manualActionForNitro = driveNitro;
            if ((driveNitro.nitro ?? 0) >= 0.5 && isNitroEngaged(actor, driveNitro) && this.input.targetSpeed > 0) {
              const boost = nitroBoostLimits(actor);
              command = {
                targetSpeed: boost.maxSpeed,
                steer: this.input.steer,
                ...boost,
              };
            } else {
              command = { ...this.input };
            }
          } else {
            command = { ...this.input };
          }
        } else {
          if (
            !actor.path.length &&
            actor !== this.player &&
            !(this.districtCase && this.districtCase.id !== "ambient") &&
            this.tick % 120 === 0
          )
            this.assignTrafficRoute(actor);
          if (this.district) freezePath(actor.path);
          command = followPath(actor, actor.path, actor.cursor, false, remCap);
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
                if (this.district) freezePath(actor.path);
                command = followPath(actor, actor.path, 0, false, remCap);
              }
            }
          }
        }
        const preTargetSpeed = actor === this.player ? command.targetSpeed : undefined;
        const preMaxSpeed = actor === this.player ? command.maxSpeed : undefined;
        const preAccelMult = actor === this.player ? command.accelMultiplier : undefined;
        if (
          actor === this.player &&
          this.mode === "auto" &&
          command.targetSpeed > 0
        )
          command.targetSpeed = policySpeed(this, actor, command.targetSpeed);
        if (actor === this.player && this.districtCase && this.districtCase.id !== "ambient")
          command.targetSpeed = this.districtCase.error ? 0
            : Math.min(command.targetSpeed, this.districtCase.requestedSpeedMps);
        let usePlannedPath = true;
        let chaosPipeline;
        if (chaosOn && actor.type === "vehicle") {
          if (actor === this.player) {
            if (this.mode === "auto" && !controlledTest) {
              const defensive = defensiveAutoCommand(this, actor, command,
                { disableDefensiveAvoidance: this.streetChaos.disableDefensiveAvoidance === true });
              command = {
                ...command, steer: defensive.steer, targetSpeed: defensive.targetSpeed,
                reason: defensive.reason, blockedBy: defensive.blockedBy,
                ...(defensive.cursor === undefined ? {} : { cursor: defensive.cursor }),
              };
              usePlannedPath = defensive.usePlannedPath !== false;
            }
          } else {
            command = streetChaosTrafficCommand(this, actor, command);
            if (command.chaosPipeline !== undefined || command.usePlannedPath !== undefined) {
              const { chaosPipeline: pipeline, usePlannedPath: planned, ...rest } = command;
              chaosPipeline = pipeline;
              usePlannedPath = planned !== false;
              command = rest;
            }
          }
        } else if (
          metroV5 && !this.pursuit && actor === this.player && this.mode === "auto" && !controlledTest &&
          this.config?.vehicleDynamics === "city-realism-v1" && this.config.unifiedDriver !== false &&
          !(this.districtCase && this.districtCase.id !== "ambient") && actor.path.length > 1
        ) {
          const unified = stepUnifiedDriver(this, actor, command, CITY_CRUISE_STRATEGY);
          command = {
            ...command, steer: unified.steer, targetSpeed: unified.targetSpeed,
            reason: unified.reason, blockedBy: unified.blockedBy,
          };
          usePlannedPath = unified.usePlannedPath !== false;
        }
        if (this.district) {
          if (chaosPipeline === "direct") command = { ...command, reason: command.reason ?? "driving", blockedBy: command.blockedBy ?? null };
          else if (chaosPipeline === "safe") command = this.safeSpeed(actor, command, false);
          else command = this.districtDrivingCommand(actor, command, ownMotion, nowS, usePlannedPath);
        }
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
        if (actor === this.player && preAccelMult > 1) {
          const blockedPed = command.blockedBy && this.actors.some(
            (b) => b.id === command.blockedBy && b.type === "pedestrian",
          );
          if (blockedPed) {
            pedSuppressedNitro = true;
            if (command.maxSpeed !== undefined || command.accelMultiplier !== undefined) {
              const { maxSpeed: _m, accelMultiplier: _a, ...rest } = command;
              command = rest;
            }
          } else if (command.targetSpeed > 0) {
            const appliedSrc = command.districtSources?.appliedSource;
            const safetyBraked = Boolean(
              appliedSrc === "reactive-safety" ||
              appliedSrc === "camera-pixels" ||
              appliedSrc === "both" ||
              command.reason === "visual-prediction" ||
              (command.blockedBy && (
                this.actors.some((b) => b.id === command.blockedBy) ||
                this.statics.some((s) => s.id === command.blockedBy)
              )),
            );
            command = {
              ...command,
              targetSpeed: safetyBraked ? command.targetSpeed : preTargetSpeed,
              maxSpeed: preMaxSpeed,
              accelMultiplier: preAccelMult,
            };
          }
        }
        if (this.terrain && actor === this.player) {
          const surface = sampleCitySurface(this.terrain, actor.x, actor.z, actor.heading, this._surfaceScratch);
          command = { ...command, surface };
        }
        appliedCommand = command;
        if (ambientMetroV5 && actor !== this.player) {
          distantWorldVehicleCmdCache.set(actor, { tick: this.tick, cmd: command });
        }
        const nitroPose = actor === this.player && !pedSuppressedNitro
          ? buildNitroBoostPose(actor, command, copyVehicleMotion)
          : null;
        next = integrateVehicle(nitroPose ?? actor, command, STEP);
        if (nitroPose) {
          next.maxSpeed = actor.maxSpeed;
          next.spec = actor.spec;
        }
        next.reason =
          actor === this.player &&
          !actor.path.length &&
          this.destination &&
          this.metrics.completedTrips
            ? "arrived"
            : command.reason;
        next.blockedBy = command.blockedBy;
        }
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
      let nearby;
      if (metroV5 && actor.type === "pedestrian") {
        const cacheKey = actor.body ?? actor;
        let stCache = distantStaticClearCache.get(cacheKey);
        if (
          !stCache ||
          stCache.staticIndex !== this.staticIndex ||
          (actor.x - stCache.x) ** 2 + (actor.z - stCache.z) ** 2 > 1.44
        ) {
          const probe = {
            type: "pedestrian",
            x: actor.x,
            z: actor.z,
            radius: (actor.radius ?? 0.38) + 1.38,
          };
          const candStatics = this.staticIndex.near(actor, 11);
          const closeStatics = [];
          for (let sIdx = 0; sIdx < candStatics.length; sIdx++) {
            if (overlaps(probe, candStatics[sIdx], 0.12)) {
              closeStatics.push(candStatics[sIdx]);
            }
          }
          stCache = {
            staticIndex: this.staticIndex,
            x: actor.x,
            z: actor.z,
            statics: closeStatics,
          };
          distantStaticClearCache.set(cacheKey, stCache);
        }
        const nearRes = reserved.near(actor, chaosOn ? 6.5 : 4);
        const rSelf = actor.radius ?? 0.38;
        nearby = [];
        for (let rIdx = 0; rIdx < nearRes.length; rIdx++) {
          const other = nearRes[rIdx];
          if (other.id === actor.id) continue;
          const dx = other.x - next.x;
          const dz = other.z - next.z;
          if (other.type === "pedestrian") {
            const lim = rSelf + (other.radius ?? 0.38) + 0.16;
            if (Math.abs(dx) <= lim && Math.abs(dz) <= lim && dx * dx + dz * dz <= lim * lim) {
              nearby.push(other);
            }
          } else {
            const vReach = chaosOn && other.length > 5.5 ? other.length * 0.5 + 1.55 : 3.65;
            if (Math.abs(dx) <= vReach && Math.abs(dz) <= vReach) {
              nearby.push(other);
            }
          }
        }
        for (let sIdx = 0; sIdx < stCache.statics.length; sIdx++) {
          nearby.push(stCache.statics[sIdx]);
        }
      } else if (metroV5 && actor !== this.player && actor.type === "vehicle") {
        let stCache = distantStaticClearCache.get(actor);
        const selfHalfDiag = Math.hypot(actor.width ?? 1.9, actor.length ?? 4.5) * 0.5;
        if (
          !stCache ||
          stCache.staticIndex !== this.staticIndex ||
          (actor.x - stCache.x) ** 2 + (actor.z - stCache.z) ** 2 > 1.44
        ) {
          const probe = {
            type: "pedestrian",
            x: actor.x,
            z: actor.z,
            radius: selfHalfDiag + 1.45,
          };
          const candStatics = this.staticIndex.near(actor, 11);
          const closeStatics = [];
          for (let sIdx = 0; sIdx < candStatics.length; sIdx++) {
            if (overlaps(probe, candStatics[sIdx], 0.14)) {
              closeStatics.push(candStatics[sIdx]);
            }
          }
          stCache = { staticIndex: this.staticIndex, x: actor.x, z: actor.z, statics: closeStatics };
          distantStaticClearCache.set(actor, stCache);
        }
        const nearRes = reserved.near(actor, chaosOn ? Math.max(8, selfHalfDiag + 6) : 6);
        nearby = [];
        for (let rIdx = 0; rIdx < nearRes.length; rIdx++) {
          const other = nearRes[rIdx];
          if (other.id === actor.id) continue;
          const dx = other.x - next.x;
          const dz = other.z - next.z;
          const lim = other.type === "pedestrian"
            ? selfHalfDiag + (other.radius ?? 0.38) + 0.35
            : chaosOn
              ? selfHalfDiag + Math.max(3.25, Math.hypot(other.width ?? 1.9, other.length ?? 4.5) * 0.5 + 0.5)
              : selfHalfDiag + 3.25;
          if (Math.abs(dx) <= lim && Math.abs(dz) <= lim && dx * dx + dz * dz <= lim * lim) {
            nearby.push(other);
          }
        }
        for (let sIdx = 0; sIdx < stCache.statics.length; sIdx++) {
          nearby.push(stCache.statics[sIdx]);
        }
      } else {
        nearby = reserved
          .near(actor, 8)
          .filter((a) => a.id !== actor.id)
          .concat(this.staticIndex.near(actor, 11))
          .filter(
            (a) => !physicalBarrier || a.id !== this.vehicleTest.barrierId,
          );
      }
      if (actor === this.player && actor.spec?.contactResponse === "inelastic-slide-v1") {
        let firstFraction = Infinity;
        let hitObstacle = null;
        for (const obstacle of nearby) {
          if (obstacle.type === "pedestrian") continue;
          const candidate = resolveVehicleContact(actor, next, obstacle, STEP);
          if (candidate) {
            if (candidate.contactFraction < firstFraction) {
              firstFraction = candidate.contactFraction;
              contact = candidate;
              hitObstacle = obstacle;
            }
          }
        }
        if (contact) {
          next = contact.body;
          const liveObstacle =
            hitObstacle && hitObstacle.type !== "static"
              ? this.actors.find((a) => a.id === hitObstacle.id) ?? hitObstacle
              : hitObstacle;
          recordCityPropImpact(this, liveObstacle, contact);
          if (
            liveObstacle &&
            (liveObstacle.type === "vehicle" || liveObstacle.kind === "parked-vehicle")
          ) {
            // contact.normal points from player toward liveObstacle (direction of push ON liveObstacle)
            const tSlipSign = Math.sign(contact.scraping?.tangentialSlipSignedMps ?? 1) || 1;
            const tx = contact.normal.z * tSlipSign;
            const tz = -contact.normal.x * tSlipSign;
            recordActorImpactReaction(liveObstacle, {
              normalX: contact.normal.x,
              normalZ: contact.normal.z,
              closingSpeedMps: contact.closingSpeedMps,
              tangentialSpeedMps: contact.scraping?.tangentialSpeedMps ?? 0,
              tangentialDirX: tx,
              tangentialDirZ: tz,
              sharedImpulse: contact.sharedImpulse ?? null,
              contactX: contact.scraping?.worldX ?? next.x,
              contactZ: contact.scraping?.worldZ ?? next.z,
              egoMassKg: playerVehicleDimensions(actor).massKg,
              tick: this.tick,
            });
            this._activeJoltActors?.add(liveObstacle);
          }
          if (
            liveObstacle &&
            (liveObstacle.type === "vehicle" || liveObstacle.kind === "parked-vehicle") &&
            (contact.closingSpeedMps >= 1.2 || (contact.scraping?.tangentialSpeedMps ?? 0) >= 3.2) &&
            actor.vehicle?.contact?.hitId !== contact.hitId
          ) {
            recordActorVisualCrash(
              liveObstacle,
              hitObstacle,
              next,
              Math.max(contact.closingSpeedMps, (contact.scraping?.tangentialSpeedMps ?? 0) * 0.35),
            );
          }
        }
      }
      const filteredNearby = (actor.type === "pedestrian" || (metroV5 && actor !== this.player && !actor.spec?.contactResponse)) && contact === null
        ? nearby
        : nearby.filter(a => {
        if (a.id === contact?.hitId) return false;
        if (actor.spec?.contactResponse === "inelastic-slide-v1" && a.type !== "pedestrian" &&
            overlaps(actor, a, .12) && distance(next, a) > distance(actor, a) + 1e-10 &&
            !overlaps(next, a)) return false;
        if (
          actor.spec?.contactResponse === "inelastic-slide-v1" &&
          actor.spec?.wheelInteractionPhysics === WHEEL_SCRUB_MODE &&
          a.type !== "pedestrian" &&
          (overlaps(actor, a, 0.12) || (this.mode === "manual" && overlaps(next, a, 0.12))) &&
          !overlaps(actor, a) &&
          !overlaps(next, a) &&
          resolveVehicleContact(actor, next, a, STEP) === null
        ) {
          return false;
        }
        const latched = actor.spec?.contactResponse === "inelastic-slide-v1"
          ? actor.vehicle?.contact : null;
        return !(a.id === latched?.hitId && latched.normal &&
          (next.x - actor.x) * latched.normal.x + (next.z - actor.z) * latched.normal.z <= 1e-10 &&
          !overlaps(next, a));
      });
      const allowCityCurb = Boolean(actor === this.player && this.curbs && this.mode === "manual" && !physicalBarrier);
      let guardRoads = actor.type === "vehicle" ? this.roads : null;
      const stationaryAmbientVehicle =
        metroV5 &&
        actor !== this.player &&
        actor.type === "vehicle" &&
        actor.x === next.x &&
        actor.z === next.z &&
        actor.heading === next.heading;
      if (metroV5 && !stationaryAmbientVehicle && actor !== this.player && actor.type === "vehicle") {
        let entry = vehicleSingleRoadCache.get(actor);
        if (entry?.road && bodyInsideSingleRoadFast(actor, entry.road) && bodyInsideSingleRoadFast(next, entry.road)) {
          guardRoads = entry.arr;
        } else if (!entry || this.tick >= entry.retryTick) {
          let matched = null;
          for (let rIdx = 0; rIdx < this.drivingRoads.length; rIdx++) {
            const r = this.drivingRoads[rIdx];
            if (bodyInsideSingleRoadFast(actor, r) && bodyInsideSingleRoadFast(next, r)) {
              matched = { road: r, arr: [r], retryTick: 0 };
              break;
            }
          }
          if (matched) {
            vehicleSingleRoadCache.set(actor, matched);
            guardRoads = matched.arr;
          } else {
            const localRoads = localVehicleRoads(this.roads, actor);
            vehicleSingleRoadCache.set(actor, { road: null, arr: localRoads, retryTick: this.tick + 4 });
            guardRoads = localRoads;
          }
        } else if (entry?.arr) {
          guardRoads = localVehicleRoads(this.roads, actor);
        }
      }
      const guard =
        stationaryAmbientVehicle ||
        (metroV5 && actor.type === "pedestrian" && filteredNearby.length === 0) ||
        (metroV5 && actor !== this.player && actor.type === "vehicle" && guardRoads?.length === 1 && filteredNearby.length === 0)
          ? { safe: true }
          : allowCityCurb
            ? sweepSafeWithCurbs(actor, next, filteredNearby, this.roads, this.curbs)
            : sweepSafe(
                actor,
                next,
                filteredNearby,
                guardRoads,
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
      if (
        actor !== this.player &&
        actor.type === "vehicle" &&
        this.config?.interactionProfile === WHEEL_SCRUB_MODE &&
        (!metroV5 || this._activeJoltActors?.has(actor))
      ) {
        const rx = getActorImpactReaction(actor);
        const instantDv = consumeActorPendingLongDv(actor);
        if (
          rx.active &&
          (Math.abs(instantDv) > 1e-5 ||
            Math.abs(rx.lateralPushMps) > 1e-4 ||
            Math.abs(rx.longitudinalPushMps) > 1e-4 ||
            Math.abs(rx.yawPushRadS) > 1e-4)
        ) {
          const basePose = guard.safe ? next : actor;
          const shovedHeading = basePose.heading + rx.yawPushRadS * STEP;
          const shS = Math.sin(shovedHeading);
          const shC = Math.cos(shovedHeading);
          const nextSpeedVal = clamp(
            (instantDv !== 0 ? (actor.speed ?? basePose.speed) + instantDv : basePose.speed),
            -Math.max(4, (actor.maxSpeed ?? 16) * 0.35),
            Math.max(actor.maxSpeed ?? 16, Math.abs(actor.speed ?? 0)) * 1.25,
          );
          const shovedCandidate = {
            ...basePose,
            x: basePose.x + shC * rx.lateralPushMps * STEP + shS * rx.longitudinalPushMps * STEP,
            z: basePose.z - shS * rx.lateralPushMps * STEP + shC * rx.longitudinalPushMps * STEP,
            heading: shovedHeading,
            speed: nextSpeedVal,
          };
          const nonTouchingNearby = filteredNearby.filter((a) => !overlaps(actor, a, 0.12));
          const zeroGapClear = !filteredNearby.some((a) =>
            overlaps(shovedCandidate, a, a.type === "pedestrian" ? 0.35 : 0),
          ) && !overlaps(shovedCandidate, this.player);
          if (
            zeroGapClear &&
            (!this.roads?.length || bodyOnRoad(shovedCandidate, this.roads)) &&
            sweepSafe(actor, shovedCandidate, nonTouchingNearby, this.roads).safe
          ) {
            next = shovedCandidate;
          }
        }
      }
      if (actor === this.player) {
        let terrainOffsets = null;
        let curbScrub = null;
        if (allowCityCurb && guard.safe) {
          terrainOffsets = acceptCurbPose(this.curbs, this.roads, next);
          curbScrub = computeCurbWheelScrub(actor, next, this.curbs, this.roads, STEP, {
            applyDeflection: !contact,
          });
          if (curbScrub.active && curbScrub.adjustedPose !== next) {
            const scrubGuard = sweepSafeWithCurbs(actor, curbScrub.adjustedPose, filteredNearby, this.roads, this.curbs);
            if (scrubGuard.safe) {
              next = curbScrub.adjustedPose;
              terrainOffsets = acceptCurbPose(this.curbs, this.roads, next);
            }
          }
        } else if (actor.curbSupportId && !this.pursuit) {
          next.y = next.supportHeightM = 0;
          next.curbSupportId = null;
        }
        const latchedId = actor.vehicle?.contact?.hitId;
        const latchedObstacle = latchedId ? nearby.find(a => a.id === latchedId) : null;
        // Keep numerical zero-gap scraping in one episode; leaving the actual
        // footprint (including a 2 mm contact band) permits a later new impact.
        const contactSeparated = actor.spec?.contactResponse === "inelastic-slide-v1" &&
          latchedId != null && contact?.hitId !== latchedId &&
          (!latchedObstacle || !overlaps(next, latchedObstacle, .002));
        const playerSurface = this.terrain
          ? sampleCitySurface(this.terrain, next.x, next.z, next.heading, this._surfaceScratch)
          : null;
        const needNitroStep = Boolean(
          manualActionForNitro ||
          actor.nitroCharge < 1 ||
          actor.nitroActive ||
          actor.nitroIntensity > 0,
        );
        if (needNitroStep && !controlledTest) {
          const baseSuppressed = Boolean(actor.nitroSuppressedByPedestrian);
          const stepSuppressed = Boolean(baseSuppressed || pedSuppressedNitro);
          next.nitroCharge = Number.isFinite(actor.nitroCharge) ? actor.nitroCharge : 1;
          next.nitroActive = Boolean(actor.nitroActive);
          next.nitroIntensity = Number.isFinite(actor.nitroIntensity) ? actor.nitroIntensity : 0;
          next.nitroSuppressedByPedestrian = stepSuppressed;
          const actionToStep = !guard.safe || contact
            ? { ...(manualActionForNitro ?? PURSUIT_STOP), throttle: 0, brake: 1 }
            : (manualActionForNitro ?? PURSUIT_STOP);
          stepNitroTank(next, actionToStep, STEP);
          next.nitroSuppressedByPedestrian = stepSuppressed;
        } else {
          next.nitroCharge = Number.isFinite(actor.nitroCharge) ? actor.nitroCharge : 1;
          next.nitroActive = false;
          next.nitroIntensity = Number.isFinite(actor.nitroIntensity) ? actor.nitroIntensity : 0;
          next.nitroSuppressedByPedestrian = Boolean(actor.nitroSuppressedByPedestrian);
        }
        next.vehicle = advanceVehicleState(actor, next, appliedCommand, STEP, {
          tick: this.tick,
          contact,
          contactSeparated,
          surface: playerSurface,
          curbScrub,
          scraping: contact?.scraping ?? null,
          driverCommand: this.mode === "manual" && !controlledTest ? this.input : null,
        });
        if (terrainOffsets) {
          const suspension = next.vehicle.suspension;
          const { wheelOffsetsM } = suspension;
          suspension.terrainOffsetsM = terrainOffsets;
          const limit = playerVehicleDimensions(actor).suspensionTravelM;
          for (const wheel of Object.keys(terrainOffsets))
            wheelOffsetsM[wheel] = clamp(wheelOffsetsM[wheel] + terrainOffsets[wheel], -limit, limit);
        }
        if (contact && physicalBarrier) {
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
      if (actor.type !== "pedestrian") copyVehicleMotion(next, actor);
      Object.assign(actor, next, {
        previous: oldPrevious,
        distance: actor.distance + moved,
        wait: moved < 0.001 ? actor.wait + STEP : 0,
      });
      if (moved > 0) reserved.add(
        metroV5
          ? {
              id: actor.id,
              type: actor.type,
              kind: actor.kind,
              vehicleKind: actor.vehicleKind,
              spec: actor.spec,
              x: actor.x,
              z: actor.z,
              heading: actor.heading,
              speed: actor.speed,
              length: actor.length,
              width: actor.width,
              radius: actor.radius,
            }
          : copyPose(actor),
      );
      if (actor === this.player) {
        this.metrics.distance += moved;
        if (moved < 0.001 && this.mode === "auto" && actor.path.length)
          this.metrics.waitSeconds += STEP;
      }
    }
    this.updateSensors(this.tick % 6 === 0);
    const hasSignals = this.junctionGroups.length > 0;
    let queueActors = this.actors;
    if (metroV5) {
      if (this._queueActorsSourceLen !== this.actors.length) {
        this._queueVehicleActors = this.actors.filter((a) => a.type === "vehicle");
        this._queueActorsSourceLen = this.actors.length;
      }
      queueActors = this._queueVehicleActors;
    }
    Object.assign(
      this.metrics,
      trafficQueueStats(
        queueActors,
        hasSignals ? (actor) => signalSpeedLimit(this, actor) === Infinity : () => true,
      ),
    );
    this.metrics.peakTrafficWait = Math.max(
      this.metrics.peakTrafficWait,
      this.metrics.longestCurrentTrafficWait,
    );
    this.tick++;
    if (this.pursuit) syncPursuitStatus(this);
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
  state() {
    const crowdAheadCount = getCrowdAheadCount(this);
    if (this.pursuit) syncPursuitStatus(this);
    return {
      tick: this.tick,
      mode: this.mode,
      environment: this.environment,
      crowdAheadCount,
      lastCrowdSpawn: this.lastCrowdSpawn ?? null,
      player: {
        id: this.player.id,
        type: this.player.type,
        ...(this.player.vehicleModel === KING_LONG_MICROBUS_ID ? { vehicleModel: this.player.vehicleModel } : {}),
        x: this.player.x,
        z: this.player.z,
        y: this.player.y ?? 0,
        heading: this.player.heading,
        speed: this.player.speed,
        steer: this.player.steer ?? 0,
        maxSpeed: this.player.maxSpeed,
        nitroCharge: this.player.nitroCharge,
        nitroActive: this.player.nitroActive,
        nitroIntensity: this.player.nitroIntensity,
        nitroSuppressedByPedestrian: this.player.nitroSuppressedByPedestrian,
        vehicle: this.player.vehicle ? structuredClone(this.player.vehicle) : null,
      },
      pursuit: this.pursuit
        ? {
            ...pursuitSnapshot(this),
            status: { ...this.pursuit.status },
          }
        : null,
      ...(this.streetChaos ? { streetChaos: streetChaosSnapshot(this) } : {}),
    };
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
        ...(a.vehicleModel === KING_LONG_MICROBUS_ID ? { vehicleModel: a.vehicleModel } : {}),
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
  static *reconstruct(data, shouldYield) {
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
          "player-vehicle",
          "pedestrian-motion",
          "district-run",
          "pursuit-run",
          "pursuit-drive",
          "pursuit-use",
          "pursuit-policy",
          "street-pursuit-start",
          "street-pursuit-stop",
          "spawn-crowd-ahead",
          "street-chaos-start",
          "street-chaos-stop",
          "street-chaos-event",
          "street-chaos-driver",
          "manual",
        ].includes(event.command?.type) ||
        (event.command.type === "vehicle-test" &&
          (data.environment !== "vehicle" ||
            !["run", "reset"].includes(event.command.operation) ||
            (event.command.heavy !== undefined && typeof event.command.heavy !== "boolean"))) ||
        (event.command.type === "player-vehicle" &&
          (data.environment !== "metro" || !isPlayerVehicleModel(event.command.model)))
      )
        throw new Error("Invalid replay event");
      lastTick = event.tick;
    }
    const options = data.environment === "metro" && data.config?.cityVersion === 5
      ? {
          ...data.config,
          ...(data.config.vehicleDynamics === undefined ? { vehicleDynamics: "legacy" } : {}),
          ...(data.config.terrainProfile === undefined ? { terrainProfile: "flat" } : {}),
          ...(data.config.interactionProfile === undefined ? { interactionProfile: "none" } : {}),
          ...(data.config.cityPropProfile === undefined ? { cityPropProfile: "none" } : {}),
        }
      : data.config;
    const world = new World(options, data.environment);
    const applyCommand = ({ command }) => {
      const result = world.command(command);
      if (command.type === "player-vehicle" && !result.changed)
        throw new Error(`Invalid replay vehicle swap: ${result.error ?? "model was already selected"}`);
    };
    let index = 0;
    while (world.tick < data.totalTicks) {
      while (
        index < data.events.length &&
        data.events[index].tick === world.tick
      )
        applyCommand(data.events[index++]);
      const beforeTick = world.tick;
      world.step();
      if (world.tick === beforeTick)
        throw new Error("Replay cannot advance a stopped scene without its recorded run event");
      if (world.tick % 120 === 0 || shouldYield?.()) yield world;
    }
    while (index < data.events.length && data.events[index].tick === world.tick)
      applyCommand(data.events[index++]);
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
