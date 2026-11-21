import { clamp } from "../src/core/config.js";
import { followPath } from "../src/core/vehicle.js";
import { Random } from "../src/core/random.js";
import { dispatchRouteGuide } from "../src/rl/pursuit-route-context.js";
import { resetPursuitEpisode } from "../src/rl/pursuit-rollouts.js";

// Training-only demonstrations. The browser never imports this controller.
export function routeDemonstration(stage, seed, perturb = false) {
  const { env, initial } = resetPursuitEpisode(stage, seed), { world } = env;
  const { player } = world, guide = dispatchRouteGuide(world, stage.observation);
  if (!guide) throw new Error("No public Metro path for this demonstration");
  const rng = new Random(`${seed}:${stage.scenario}:perturbation`), samples = [];
  let { obs } = initial, cursor = 0, reward = 0, result, peaks = 0, disturbance = 0;
  do {
    const command = followPath(player, guide.path, cursor);
    cursor = command.cursor;
    const target = Math.min(stage.demonstrationSpeedMps ?? 16, command.targetSpeed);
    const brake = clamp((player.speed - target) / 2.5, 0, 1);
    const action = { steer: clamp(command.steer / player.spec.maxSteer, -1, 1),
      throttle: brake ? 0 : clamp((target - player.speed) / 1.8, 0, 1), brake, gear: 1 };
    if (samples.length % 4 === 0) disturbance = perturb ? rng.range(-.055, .055) : 0;
    const requested = { ...action, steer: clamp(action.steer + disturbance, -1, 1) };
    samples.push({ obs, action });
    result = env.step(requested);
    reward += result.reward;
    obs = result.obs;
    peaks = Math.max(peaks, Math.abs(action.steer));
  } while (!result.terminated && !result.truncated);
  return {
    samples, metrics: { seed, scenario: stage.scenario, phase: world.pursuit.phase, ticks: world.tick,
      distanceM: world.pursuit.metrics.distanceM, collisions: world.pursuit.metrics.collisions,
      maxSteer: peaks, reward },
  };
}
