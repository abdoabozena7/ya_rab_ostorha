import { STEP, clamp } from "../core/config.js";
import { GTA_AI_STATES, GTA_MAX_SPEED, GTA_PIN_SECONDS, GTA_UNIT_TYPES, gtaLocal,
  gtaVelocity, resolveGtaChaseConfig } from "../core/pursuit-gta.js";
import { getVehicleMounts, PLAYER_VEHICLE } from "../core/vehicle-spec.js";
import { World } from "../core/world.js";
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

const signed = (n, scale) => clamp(n / scale, -1, 1);
const unit = (n, scale) => clamp(n / scale, 0, 1);
const distanceSquared = (a, b) => (a.x - b.x) ** 2 + (a.z - b.z) ** 2;
const nearest = (bodies, ego) => bodies.sort((a, b) => distanceSquared(a, ego) - distanceSquared(b, ego));

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
  };
}

export class GtaPursuitEnv {
  static observationSchema = GTA_OBSERVATION_SCHEMA;

  reset({ seed, config } = {}) {
    const options = resolveGtaChaseConfig(config);
    const world = new World({ cityVersion: 4, seed }, "metro");
    world.command({ type: "street-pursuit-start", variant: "gta", level: options.wantedLevelStart, config: options }, false);
    this.world = world;
    return { obs: this.getObservation(), info: infoFor(world, null, []) };
  }

  getObservation() {
    if (!this.world) throw new Error("Reset the GTA environment before reading observations");
    return getObservation(this.world);
  }

  step(action, actionRepeat = 6) {
    const { world } = this;
    if (world?.pursuit.phase !== "running") throw new Error("Reset the GTA environment before stepping");
    if (!Number.isSafeInteger(actionRepeat) || actionRepeat < 1)
      throw new RangeError("actionRepeat must be a positive integer");
    world.command({ type: "pursuit-drive", action }, false);
    const requestedAction = { ...world.pursuit.manualAction }, events = [];
    let reward = 0;
    for (let i = 0; i < actionRepeat && world.pursuit.phase === "running"; i++) {
      const before = world.pursuit.metrics.distanceM;
      world.step();
      const stepEvents = world.pursuit.stepEvents;
      reward += tickReward(world, world.pursuit.metrics.distanceM - before, stepEvents);
      for (const event of stepEvents) events.push({ ...event });
    }
    const { phase } = world.pursuit;
    return {
      obs: this.getObservation(), reward, terminated: ["escaped", "wrecked", "busted"].includes(phase),
      truncated: phase === "timeout", info: infoFor(world, requestedAction, events),
    };
  }
}
