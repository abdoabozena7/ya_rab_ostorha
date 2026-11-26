import { STEP } from "../core/config.js";
import { distance } from "../core/geometry.js";
import { PURSUIT_SCAN_TICKS } from "../signal_processing/pursuit-scanner.js";
import { resetPursuitEpisode } from "./pursuit-rollouts.js";
import { SMART_ESCAPE_CONTROL } from "./pako-smart-escape.js";

// A bounded engine trial, not training or a learned-checkpoint evaluation.
export function runSmartEscapeTrial({ seed, scenario, seconds = 8,
  controller = SMART_ESCAPE_CONTROL, traffic = 0, pedestrians = 0, patrols = 0, policy = null } = {}) {
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 120)
    throw new RangeError("Smart escape trials require 0 < seconds <= 120");
  const { env } = resetPursuitEpisode({ scenario, cityVersion: 5, traffic, pedestrians,
    episodeSeconds: Math.min(120, seconds + 1), wantedLevel: 1, wantedLevelMax: 1, patrols,
    observation: policy?.observation ?? "dispatch-route-v2", tacticalPursuit: "gta-tactical-v1",
    policeFairness: "city-fair-v1", evasiveControl: controller }, seed);
  const world = env.world, start = { x: world.player.x, z: world.player.z };
  const originalActors = new Set(world.actors.filter(a => !world.pursuit.patrols.has(a)));
  const contacts = [], decisions = [], goals = new Set(), pursuitSamples = [];
  const limit = Math.ceil(seconds / (STEP * PURSUIT_SCAN_TICKS));
  let anticipatoryBrakes = 0, nitroDecisions = 0, pedestrianNitroViolations = 0;
  let progressAt60sM = null;
  for (let n = 0; n < limit && world.pursuit.phase === "running"; n++) {
    const requested = policy ? policy.action(env.getObservation())
      : { steer: 0, throttle: .8, brake: 0, gear: 1 };
    const result = env.step(requested, PURSUIT_SCAN_TICKS);
    if (progressAt60sM === null && world.tick * STEP >= 60)
      progressAt60sM = world.pursuit.metrics.distanceM;
    const planner = result.info.planner;
    anticipatoryBrakes += Number(planner?.reason === "PREDICTIVE_TRAFFIC_BRAKE");
    const boosted = Boolean(world.pursuit.manualAction?.nitro);
    nitroDecisions += Number(boosted);
    pedestrianNitroViolations += Number(boosted && planner?.nitroSuppressedByPedestrian);
    if (planner?.escapeDestination) goals.add(planner.escapeDestination.id);
    for (const event of result.info.events)
      if (event.fresh && ["static_or_civilian_hit", "patrol_collision"].includes(event.type))
        contacts.push(event);
    decisions.push({ tick: world.tick, x: world.player.x, z: world.player.z,
      speed: world.player.speed, heading: world.player.heading,
      requested, action: world.pursuit.manualAction, reason: planner?.reason ?? null,
      maneuver: planner?.maneuver ?? null, routeTracking: planner?.routeTracking ?? null,
      conflict: planner?.predictedConflict ?? null });
    if (n % 100 === 0 || world.pursuit.phase !== "running") {
      const { response, gta } = world.pursuit;
      pursuitSamples.push({ tick: world.tick, x: world.player.x, z: world.player.z,
        speed: world.player.speed, wanted: world.pursuit.wantedLevel,
        unitsInContact: response.unitsInContact, lastReportTick: response.lastSeen?.tick,
        lastReportX: response.lastSeen?.x, lastReportZ: response.lastSeen?.z,
        nearestPatrolM: response.nearestPatrolM, lostTicks: gta.lostTicks,
        dispatch: { ...response.dispatch }, goal: planner?.escapeDestination });
    }
  }
  const { metrics } = world.pursuit;
  return { kind: "deterministic-controller-engine-trial", learnedCheckpoint: false,
    actionSource: policy ? "frozen-ppo" : "neutral-forward",
    seed, scenario, controller, ticks: world.tick, phase: world.pursuit.phase,
    distanceM: metrics.distanceM, displacementM: distance(start, world.player), progressAt60sM,
    contacts: metrics.collisions, pedestrianContacts: metrics.pedestrianCollisions,
    originalActorsRetained: [...originalActors].every(a => world.actors.includes(a)),
    anticipatoryBrakes, nitroDecisions, pedestrianNitroViolations,
    destinationCount: goals.size, contactEvents: contacts, decisions, pursuitSamples,
    qualifiedEscape: world.pursuit.phase === "escaped" &&
      world.pursuit.response.dispatch?.escapeEligible === true };
}
