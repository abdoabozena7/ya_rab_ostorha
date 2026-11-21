import { GtaPursuitEnv } from "./gta-pursuit-env.js";
import { Random } from "../core/random.js";
import { PURSUIT_SCAN_TICKS } from "../signal_processing/pursuit-scanner.js";

export const isDispatchIncident = event => event.type === "patrol_collision" ||
  event.type === "static_or_civilian_hit" || event.type === "near_miss" || event.type === "ambient_collision";

export function resetPursuitEpisode(stage, seed) {
  const env = new GtaPursuitEnv();
  const initial = env.reset({ seed, traffic: stage.traffic, pedestrians: stage.pedestrians, shield: true,
    scenario: stage.scenario, observation: stage.observation, practiceProgress: stage.practiceProgress,
    config: { ruleset: "dispatch-v1", episodeMaxSeconds: stage.episodeSeconds,
      ...(stage.civilianCrossingPreview === undefined ? {} : { civilianCrossingPreview: stage.civilianCrossingPreview }),
      ...(stage.patrolTrafficPreview === undefined ? {} : { patrolTrafficPreview: stage.patrolTrafficPreview }),
      wantedLevelStart: stage.wantedLevel, wantedLevelMax: stage.wantedLevelMax ?? 5, maxActivePatrols: stage.patrols } });
  return { env, initial };
}

export function runPursuitEpisode(stage, seed, select, collect = false, observeStep = null, observeWorld = null) {
  const { env, initial } = resetPursuitEpisode(stage, seed);
  let { obs } = initial, result, reward = 0, firstAction, interventions = 0, ambientPedestrianImpacts = 0;
  const rollout = [], events = {}, rewardComponents = {};
  observeWorld?.(env.world);
  do {
    const decision = select(obs);
    const action = collect ? decision.action : decision;
    firstAction ??= action;
    result = env.step(action, PURSUIT_SCAN_TICKS);
    interventions += result.info.shield.interventions;
    for (const event of result.info.events) {
      if (event.type === "ambient_collision") {
        ambientPedestrianImpacts += Number(event.first.type === "pedestrian" || event.second.type === "pedestrian");
      } else if (isDispatchIncident(event)) {
        const key = event.kind ?? event.actorKind ?? event.type;
        const count = events[key] ??= { impacts: 0, nearMisses: 0, maxClosingMps: 0 };
        count[event.type === "near_miss" ? "nearMisses" : "impacts"]++;
        if (event.closingSpeed !== undefined) count.maxClosingMps = Math.max(count.maxClosingMps, event.closingSpeed);
      }
    }
    for (const [key, value] of Object.entries(result.info.rewardComponents))
      rewardComponents[key] = (rewardComponents[key] ?? 0) + value;
    reward += result.reward;
    if (collect) rollout.push({ obs, raw: decision.raw, value: decision.value, logp: decision.logp, reward: result.reward });
    obs = result.obs;
    if (observeStep) {
      const { x, z, speed, heading } = env.world.player;
      observeStep([env.world.tick, x, z, speed, heading, result.info.appliedCommand], result.info.events);
    }
    observeWorld?.(env.world);
  } while (!result.terminated && !result.truncated);
  const { pursuit } = env.world, { metrics } = pursuit;
  return { rollout, last: result, metrics: { seed, phase: pursuit.phase, ticks: env.world.tick,
    ...(initial.info.scenario ? { scenario: initial.info.scenario } : {}),
    reward, rewardComponents, rewardProfile: initial.info.rewardProfile,
    distanceM: metrics.distanceM, firstAction, collisions: metrics.collisions, interventions,
    pedestrianImpacts: metrics.pedestrianCollisions, nearMisses: metrics.nearCollisions, contacts: events,
    ambientCollisions: metrics.trafficCollisions, ambientPedestrianImpacts,
    pursuitQualified: pursuit.response.dispatch?.escapeEligible === true } };
}

export function collectPursuitRollout(model, stage, trainingSeeds, observeStep) {
  const variants = pursuitStageVariants(stage);
  const seed = trainingSeeds[model.updates % trainingSeeds.length];
  const rng = new Random(`${model.seed}:rollout:${model.updates}`);
  const episodes = variants.map(variant => {
    const episode = runPursuitEpisode(variant, seed, obs => model.sample(obs, rng), true, observeStep);
    return { ...episode, bootstrap: episode.last.terminated ? 0 : model.value(episode.last.obs) };
  });
  if (episodes.length === 1) return episodes[0];
  const rollout = episodes.flatMap(episode => {
    episode.rollout.at(-1).episodeBootstrap = episode.bootstrap;
    return episode.rollout;
  });
  return { rollout, bootstrap: 0, metrics: { seed, episodes: episodes.map(episode => episode.metrics) } };
}

export function pursuitStageVariants(stage) {
  // Curriculum drills without patrols explicitly score practice, not pursuit.
  const workload = stage.patrols === 0 ? { ...stage, practiceProgress: true } : stage;
  return workload.scenarios ? workload.scenarios.map(scenario => ({ ...workload, scenario })) : [workload];
}
