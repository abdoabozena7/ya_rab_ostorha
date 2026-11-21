import { STEP, clamp } from "../core/config.js";
import { GTA_AI_STATES, GTA_MAX_SPEED, GTA_PIN_SECONDS, GTA_UNIT_TYPES, gtaLocal,
  gtaVelocity, resolveGtaChaseConfig } from "../core/pursuit-gta.js";
import { getVehicleMounts, PLAYER_VEHICLE } from "../core/vehicle-spec.js";
import { World } from "../core/world.js";
import { bodyOnRoad, distance, overlaps } from "../core/geometry.js";
import { updatePursuitResponse } from "../core/pursuit-response.js";
import { SpatialIndex } from "../core/spatial-index.js";
import { guardDispatchAction, requireDispatchScan } from "./pursuit-shield.js";
import { stagePursuitLabScenario } from "./pursuit-lab-scenarios.js";
import { CLEARANCE_ROUTE_CONTEXT, LEGACY_ROUTE_CONTEXT, ROUTE_NAVIGATION_FIELDS,
  sampleRouteNavigation } from "./pursuit-route-context.js";
import { PursuitScanner, PURSUIT_SCAN_RAYS, PURSUIT_SCAN_RANGE_M, PURSUIT_SCAN_TICKS, PURSUIT_TRACK_TTL_S }
  from "../signal_processing/pursuit-scanner.js";
import { SENSOR_MAX_M } from "../signal_processing/range-sensors.js";

export { GtaChaseConfig } from "../core/pursuit-gta.js";

const K = 8, M = 4;
const UNIT_TYPES = Object.freeze([...GTA_UNIT_TYPES, "wrecked"]);
const mounts = getVehicleMounts();
const egoFields = Object.freeze(["speed", "steer", "lateralSlip", "yawRate", "health", "wanted", "pinned", "lineOfSight", "cooldown"]);
const rayFields = Object.freeze(mounts.ranges.concat(mounts.auxiliary).map(mount => mount.id));
const patrolFields = Object.freeze(["dx", "dy", "dvx", "dvy", "headingSin", "headingCos", "health",
  ...UNIT_TYPES, "fsmState"]);
const hazardFields = Object.freeze(["dx", "dy", "relativeSpeed", "footprintRadius"]);
const rayOffset = egoFields.length, patrolOffset = rayOffset + rayFields.length;
const hazardOffset = patrolOffset + K * patrolFields.length;
const scales = Object.freeze({ speedMps: GTA_MAX_SPEED, steerRad: PLAYER_VEHICLE.maxSteerRad,
  slipMps: 11, yawRadS: 4, offsetM: 65, relativeSpeedMps: 60, radiusM: 5, rayM: SENSOR_MAX_M });
const block = (offset, count, fields) => Object.freeze({ offset, count, stride: fields.length, fields });

export const GTA_OBSERVATION_SCHEMA = Object.freeze({
  source: "virtual/privileged simulation state", dtype: "Float32Array",
  frame: "ego-local: x right, y forward", length: hazardOffset + M * hazardFields.length,
  ego: block(0, 1, egoFields), rays: block(rayOffset, 1, rayFields),
  patrols: block(patrolOffset, K, patrolFields), hazards: block(hazardOffset, M, hazardFields),
  scales, fsmStates: GTA_AI_STATES,
  fsmEncoding: "(zero-based index + 1) / state count; 0 is padding",
});

const scanKinds = Object.freeze(["static", "civilian", "pedestrian", "police"]);
const scanEgo = Object.freeze(["speed", "steer", "lateralSlip", "yawRate", "health", "frameAge"]);
const scanRays = Object.freeze(["range", ...scanKinds]);
const scanTracks = Object.freeze(["present", ...scanKinds, "right", "forward", "rightMps", "forwardMps",
  "age", "motionKnown", "ttcKnown", "ttc"]);
const scanTrackOffset = scanEgo.length + PURSUIT_SCAN_RAYS * scanRays.length;
const scanTrackCount = 16;
const QUALIFIED_REWARD = "qualified-progress-v2";
const PRACTICE_REWARD = "maneuver-practice-v1";

export const DISPATCH_OBSERVATION_SCHEMA = Object.freeze({
  version: "dispatch-scan-v3", source: "virtual first-return geometry", dtype: "Float32Array",
  frame: "ego-local: x right, y forward; ray 0 forward, increasing clockwise",
  length: scanTrackOffset + scanTrackCount * scanTracks.length,
  ego: block(0, 1, scanEgo), rays: block(scanEgo.length, PURSUIT_SCAN_RAYS, scanRays),
  tracks: block(scanTrackOffset, scanTrackCount, scanTracks),
  scales: Object.freeze({ ...scales, offsetM: PURSUIT_SCAN_RANGE_M, rayM: PURSUIT_SCAN_RANGE_M,
    sampleTicks: PURSUIT_SCAN_TICKS, ageS: PURSUIT_TRACK_TTL_S, ttcS: 6 }),
});

export const ROUTE_OBSERVATION_SCHEMA = Object.freeze({
  ...DISPATCH_OBSERVATION_SCHEMA, version: LEGACY_ROUTE_CONTEXT,
  source: "virtual first-return geometry and public static Metro route cues",
  length: DISPATCH_OBSERVATION_SCHEMA.length + ROUTE_NAVIGATION_FIELDS.length,
  navigation: block(DISPATCH_OBSERVATION_SCHEMA.length, 1, ROUTE_NAVIGATION_FIELDS),
});

export const CLEARANCE_ROUTE_OBSERVATION_SCHEMA = Object.freeze({
  ...ROUTE_OBSERVATION_SCHEMA, version: CLEARANCE_ROUTE_CONTEXT,
  source: "virtual first-return geometry and public static Metro clearance-route cues",
});
const dispatchSchemas = new Map([DISPATCH_OBSERVATION_SCHEMA, ROUTE_OBSERVATION_SCHEMA,
  CLEARANCE_ROUTE_OBSERVATION_SCHEMA].map(schema => [schema.version, schema]));

const signed = (n, scale) => clamp(n / scale, -1, 1);
const unit = (n, scale) => clamp(n / scale, 0, 1);
const distanceSquared = (a, b) => (a.x - b.x) ** 2 + (a.z - b.z) ** 2;
const nearest = (bodies, ego) => bodies.sort((a, b) => distanceSquared(a, ego) - distanceSquared(b, ego));

export function getDispatchObservation(world, version = DISPATCH_OBSERVATION_SCHEMA.version) {
  const { player, sensors, pursuit, tick } = world;
  if (pursuit?.gta?.config.ruleset !== "dispatch-v1" || !pursuit.gta.scan)
    throw new Error("Dispatch observation requires a sampled dispatch-v1 chase");
  const scan = requireDispatchScan(world);
  const schema = dispatchSchemas.get(version);
  if (!schema) throw new RangeError("Unknown dispatch observation version");
  const { ego, rays, tracks, scales: s, length } = schema;
  const obs = new Float32Array(length);
  obs.set([
    signed(player.speed, s.speedMps), signed(player.steer, s.steerRad),
    signed(player.gtaSlipMps, s.slipMps), signed(sensors.imu.yawRateRadS, s.yawRadS),
    // Wanted decay is scored using hidden separation, so it remains UI/metrics only.
    unit(player.health, player.maxHealth),
    unit(tick - scan.tick, s.sampleTicks),
  ], ego.offset);
  for (const [i, ray] of scan.rays.entries()) {
    const offset = rays.offset + i * rays.stride;
    obs[offset] = unit(ray.rangeM, s.rayM);
    const kind = scanKinds.indexOf(ray.kind);
    if (kind >= 0) obs[offset + 1 + kind] = 1;
  }
  for (const [i, track] of scan.tracks.slice(0, tracks.count).entries()) {
    const ttcKnown = Number.isFinite(track.ttcS);
    obs.set([
      1, ...scanKinds.map(kind => Number(track.kind === kind)),
      signed(track.rightM, s.offsetM), signed(track.forwardM, s.offsetM),
      signed(track.rightMps, s.relativeSpeedMps), signed(track.forwardMps, s.relativeSpeedMps),
      unit(track.ageS, s.ageS), Number(track.motionKnown), Number(ttcKnown),
      ttcKnown ? unit(track.ttcS, s.ttcS) : 0,
    ], tracks.offset + i * tracks.stride);
  }
  if (schema.navigation) obs.set(sampleRouteNavigation(world, version), schema.navigation.offset);
  if (!obs.every(Number.isFinite)) throw new Error("Nonfinite dispatch observation");
  return obs;
}

/** Privileged game geometry. Never use this as input to the RGB prediction path. */
export function getObservation(world) {
  const { player, pursuit, sensors } = world;
  if (!pursuit?.gta) throw new Error("GTA observation requires a GTA Chase");
  const obs = new Float32Array(GTA_OBSERVATION_SCHEMA.length);
  obs.set([
    signed(player.speed, scales.speedMps), signed(player.steer, scales.steerRad),
    signed(player.gtaSlipMps, scales.slipMps), signed(sensors.imu.yawRateRadS, scales.yawRadS),
    unit(player.health, player.maxHealth), unit(pursuit.wantedLevel, 5),
    unit(pursuit.metrics.capturePressureS, GTA_PIN_SECONDS),
    Number(pursuit.response.unitsInContact > 0), pursuit.response.clearProgress,
  ]);
  for (const [i, ray] of sensors.rays.entries()) obs[rayOffset + i] = unit(ray.rangeM, scales.rayM);
  const egoVelocity = gtaVelocity(player);
  const relativeVelocity = body => {
    const v = gtaVelocity(body);
    return gtaLocal({ x: egoVelocity.x, z: egoVelocity.z, heading: player.heading }, v);
  };
  const patrols = [...pursuit.patrols];
  // Keep the nearest active units first; wrecks may fill unused slots and
  // always remain eligible for the separate hazard block.
  const tracks = nearest(patrols.filter(body => body.aiState !== "WRECKED"), player)
    .concat(nearest(patrols.filter(body => body.aiState === "WRECKED"), player)).slice(0, K);
  for (const [i, body] of tracks.entries()) {
    const { right, forward } = gtaLocal(player, body), velocity = relativeVelocity(body);
    const heading = body.heading - player.heading;
    const type = body.aiState === "WRECKED" ? "wrecked" : body.unitType;
    obs.set([
      signed(right, scales.offsetM), signed(forward, scales.offsetM),
      signed(velocity.right, scales.relativeSpeedMps), signed(velocity.forward, scales.relativeSpeedMps),
      Math.sin(heading), Math.cos(heading), unit(body.health, body.maxHealth),
      ...UNIT_TYPES.map(unitType => Number(unitType === type)),
      (GTA_AI_STATES.indexOf(body.aiState) + 1) / GTA_AI_STATES.length,
    ], patrolOffset + i * patrolFields.length);
  }
  const hazards = nearest(world.actors.filter(body => body !== player &&
    (!pursuit.patrols.has(body) || body.gtaRoadblock || body.aiState === "WRECKED"))
    .concat([...pursuit.closures.keys()]), player).slice(0, M);
  for (const [i, body] of hazards.entries()) {
    const { right, forward } = gtaLocal(player, body);
    const radius = body.type === "pedestrian" ? body.radius : Math.hypot(body.length, body.width) / 2;
    obs.set([
      signed(right, scales.offsetM), signed(forward, scales.offsetM),
      signed(relativeVelocity(body).forward, scales.relativeSpeedMps), unit(radius, scales.radiusM),
    ], hazardOffset + i * hazardFields.length);
  }
  return obs;
}

function tickReward(world, moved, events) {
  let reward = .16 * STEP + .012 * moved;
  for (const event of events) {
    if (event.type === "patrol_collision") reward -= 3 * event.damageToPlayer / world.player.maxHealth;
    else if (event.type === "static_or_civilian_hit")
      reward -= 6 * event.damageToPlayer / world.player.maxHealth + (event.kind === "pedestrian" ? 2 : .1);
    else if (event.type === "near_miss") reward -= .015 * (1 - unit(event.minDist, .72));
    else if (event.type === "pinned_progress") reward -= .2 * STEP * event.ratio;
  }
  if (world.pursuit.phase === "escaped") reward += 5;
  else if (["wrecked", "busted"].includes(world.pursuit.phase)) reward -= 4;
  return reward;
}

function infoFor(world, requestedAction, events) {
  const { pursuit } = world;
  return {
    requestedAction, appliedCommand: pursuit.appliedCommand ? { ...pursuit.appliedCommand } : null,
    phase: pursuit.phase, wantedLevel: pursuit.wantedLevel, playerHealth: world.player.health,
    activePatrols: [...pursuit.patrols].filter(unit => unit.aiState !== "WRECKED").length,
    events, tick: world.tick,
    ...(pursuit.gta.config.ruleset === "dispatch-v1" ? {
      observationVersion: DISPATCH_OBSERVATION_SCHEMA.version, sampleTick: pursuit.gta.scan?.tick ?? null,
    } : {}),
  };
}

export class GtaPursuitEnv {
  static observationSchema = GTA_OBSERVATION_SCHEMA;

  get observationSchema() {
    return this.schema ?? GTA_OBSERVATION_SCHEMA;
  }

  reset({ seed, config, traffic, pedestrians, shield = false, scenario, observation, practiceProgress = false } = {}) {
    const options = resolveGtaChaseConfig(config);
    for (const [density, max, label] of [[traffic, 96, "traffic"], [pedestrians, 144, "pedestrians"]])
      if (density !== undefined && (!Number.isInteger(density) || density < 0 || density > max))
        throw new RangeError(`Invalid Metro ${label} count`);
    if (typeof shield !== "boolean" || (shield && options.ruleset !== "dispatch-v1"))
      throw new TypeError("Brake shield is only available for dispatch-v1");
    if (typeof practiceProgress !== "boolean")
      throw new TypeError("practiceProgress must be a boolean");
    if (practiceProgress && (options.ruleset !== "dispatch-v1" || options.maxActivePatrols !== 0))
      throw new TypeError("Progress practice is only available in no-patrol Dispatch drills");
    if (scenario !== undefined && (options.ruleset !== "dispatch-v1" ||
        (scenario === "L12" && options.maxActivePatrols < 1) ||
        (scenario === "L12-control" && options.maxActivePatrols !== 0)))
      throw new TypeError("Dispatch Lab scenario requires compatible pursuit settings");
    const schema = observation === undefined ? DISPATCH_OBSERVATION_SCHEMA : dispatchSchemas.get(observation);
    if (observation !== undefined && (options.ruleset !== "dispatch-v1" || !schema))
      throw new RangeError("Invalid observation for this pursuit ruleset");
    const world = new World({ cityVersion: 4, seed, ...(traffic === undefined ? {} : { traffic }),
      ...(pedestrians === undefined ? {} : { pedestrians }) }, "metro");
    const staged = scenario === undefined ? null : stagePursuitLabScenario(world, scenario);
    if (staged?.barrierId) world.staticIndex = new SpatialIndex(world.statics);
    const runConfig = staged?.zones ? { ...options, surveillanceZones: staged.zones } : options;
    if (staged?.patrolStart && options.maxActivePatrols > 1)
      throw new RangeError("A controlled tail approach supports at most one patrol");
    if (staged?.patrolStarts && options.maxActivePatrols !== staged.patrolStarts.length)
      throw new RangeError(`The lab approach fixture requires ${staged.patrolStarts.length} patrols`);
    world.command({ type: "street-pursuit-start", variant: "gta", level: options.wantedLevelStart, config: runConfig }, false);
    if (staged?.goal) world.pursuit.gta.publicRouteGoal = staged.goal;
    const starts = staged?.patrolStarts ?? (staged?.patrolStart ? [staged.patrolStart] : null);
    if (starts) {
      const { pursuit } = world;
      const units = [...pursuit.patrols];
      if (staged.patrolStarts && units.length !== starts.length)
        throw new Error("The lab approach could not deploy all required patrols");
      if (units.length) {
        const proposed = units.map((unit, i) => ({ ...unit, ...starts[i] }));
        const obstacles = world.statics.concat(world.actors.filter(actor => !pursuit.patrols.has(actor)));
        if (proposed.some((pose, i) => !bodyOnRoad(pose, world.drivingRoads) ||
            obstacles.some(actor => overlaps(actor, pose, .15)) ||
            proposed.slice(0, i).some(other => overlaps(other, pose, .15))))
          throw new Error("The staged patrol has no physically clear berth");
        units.forEach((unit, i) => Object.assign(unit, starts[i]));
        world.actorIndex = new SpatialIndex(world.actors);
      }
      updatePursuitResponse(world, true);
      pursuit.gta.scanner = new PursuitScanner();
      pursuit.gta.scan = pursuit.gta.scanner.sample(world);
    }
    this.world = world;
    this.schema = options.ruleset === "dispatch-v1" ? schema : GTA_OBSERVATION_SCHEMA;
    this.furthestM = 0;
    this.shield = shield;
    this.rewardProfile = practiceProgress ? PRACTICE_REWARD : QUALIFIED_REWARD;
    const info = infoFor(world, null, []);
    if (options.ruleset === "dispatch-v1") info.rewardProfile = this.rewardProfile;
    if (schema.navigation) info.observationVersion = schema.version;
    if (staged) info.scenario = staged;
    return { obs: this.getObservation(), info };
  }

  getObservation() {
    if (!this.world) throw new Error("Reset the GTA environment before reading observations");
    return this.observationSchema === GTA_OBSERVATION_SCHEMA ? getObservation(this.world) :
      getDispatchObservation(this.world, this.observationSchema.version);
  }

  step(action, actionRepeat = 6) {
    const { world } = this;
    if (world?.pursuit.phase !== "running") throw new Error("Reset the GTA environment before stepping");
    if (!Number.isSafeInteger(actionRepeat) || actionRepeat < 1)
      throw new RangeError("actionRepeat must be a positive integer");
    world.command({ type: "pursuit-drive", action }, false);
    const requestedAction = { ...world.pursuit.manualAction }, events = [];
    const dispatch = this.observationSchema !== GTA_OBSERVATION_SCHEMA;
    const rewardComponents = dispatch ? { progress: 0, time: 0, instability: 0, safety: 0, capture: 0, outcome: 0 } : null;
    let shieldTick = null, shieldReason = null, interventions = 0;
    let reward = 0;
    for (let i = 0; i < actionRepeat && world.pursuit.phase === "running"; i++) {
      if (this.shield && shieldTick !== requireDispatchScan(world).tick) {
        const { action: safe, reason } = guardDispatchAction(world, requestedAction);
        world.command({ type: "pursuit-drive", action: safe }, false);
        shieldTick = world.pursuit.gta.scan.tick;
        shieldReason = reason;
        if (reason) interventions++;
      }
      const before = world.pursuit.metrics.distanceM;
      const beforeSteer = world.player.steer;
      world.step();
      const stepEvents = world.pursuit.stepEvents;
      if (dispatch) this.scoreDispatchTick(rewardComponents, beforeSteer, stepEvents);
      else reward += tickReward(world, world.pursuit.metrics.distanceM - before, stepEvents);
      for (const event of stepEvents) events.push({ ...event });
    }
    const { phase } = world.pursuit;
    const info = infoFor(world, requestedAction, events);
    if (dispatch) {
      reward = Object.values(rewardComponents).reduce((sum, component) => sum + component, 0);
      info.rewardComponents = rewardComponents;
      info.rewardProfile = this.rewardProfile;
      info.observationVersion = this.schema.version;
      if (this.shield) info.shield = { reason: shieldReason, interventions };
    }
    return {
      obs: this.getObservation(), reward, terminated: ["escaped", "wrecked", "busted"].includes(phase),
      truncated: phase === "timeout", info,
    };
  }

  scoreDispatchTick(reward, beforeSteer, events) {
    const { player, pursuit } = this.world;
    // Advance the watermark even before qualifying so earlier travel is never paid retroactively.
    const separation = Math.min(100, distance(player, pursuit.playerStart));
    if (this.rewardProfile === PRACTICE_REWARD || pursuit.response.dispatch.escapeEligible)
      reward.progress += .06 * Math.max(0, separation - this.furthestM);
    this.furthestM = Math.max(this.furthestM, separation);
    reward.time -= .04 * STEP;
    reward.instability -= .025 * Math.abs(player.steer - beforeSteer);
    for (const event of events) {
      if (event.type === "patrol_collision") reward.safety -= 1 + 4 * event.damageToPlayer / player.maxHealth;
      else if (event.type === "static_or_civilian_hit")
        reward.safety -= (event.kind === "pedestrian" ? 24 : 3) + 8 * event.damageToPlayer / player.maxHealth;
      else if (event.type === "ambient_collision" && this.rewardProfile === QUALIFIED_REWARD) {
        const { first, second } = event;
        const pedestrian = first.type === "pedestrian" || second.type === "pedestrian";
        const civilianVehicle = (first.type === "vehicle" && !first.patrol) ||
          (second.type === "vehicle" && !second.patrol);
        if (pedestrian || civilianVehicle) reward.safety -= (pedestrian ? 24 : 3) + 8 * event.severity;
      }
      else if (event.type === "near_miss") reward.safety -= .12 * (1 - unit(event.minDist, .72));
      else if (event.type === "pinned_progress") reward.capture -= .2 * STEP * event.ratio;
    }
    if (pursuit.phase === "escaped") reward.outcome += 12;
    else if (pursuit.phase === "busted" || pursuit.phase === "wrecked") reward.outcome -= 8;
    // A time limit truncates a rollout, not the plant's return. The continuing
    // time cost already makes waiting unprofitable; the trainer bootstraps here.
  }
}
