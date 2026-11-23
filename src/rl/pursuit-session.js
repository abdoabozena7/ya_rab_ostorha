import { STEP } from "../core/config.js";
import { Random } from "../core/random.js";
import { createActorRecorder } from "./pursuit-actor-recording.js";
import { PURSUIT_SCAN_TICKS } from "../signal_processing/pursuit-scanner.js";
import { freezePursuitPolicy, PursuitPpo } from "./pursuit-ppo.js";
import { beginPursuitEpisode, joinPursuitRollout, planPursuitRollout, pursuitStageVariants } from "./pursuit-rollouts.js";

const MAX_PATH_SAMPLES = 128;
const MAX_COLLISION_MARKERS = 32;
const PROGRESS_INTERVAL_MS = 250;
const policySeed = "metro-dispatch-development";

export function createPursuitSession(options, { manifest, stage, curriculumSha256, recordActorMotion }, post) {
  const { sessionId, mode, checkpoint, maxEpisodes, maxSeconds, speed, worlds = 1 } = options;
  if ((typeof sessionId !== "string" || !sessionId.length || sessionId.length > 120) &&
      !Number.isSafeInteger(sessionId))
    throw new TypeError("A session needs an ID.");
  if (mode !== "train" && mode !== "evaluate") throw new RangeError("Choose train or evaluate.");
  if (speed !== "normal" && speed !== "fast") throw new RangeError("Choose normal or fast session speed.");
  if (!Number.isInteger(worlds) || worlds < 1 || worlds > 4)
    throw new RangeError("Choose an integer from 1 to 4 independent worlds.");
  if (!Number.isSafeInteger(maxEpisodes) || maxEpisodes < 1 || maxEpisodes > 10_000 ||
      !Number.isFinite(maxSeconds) || maxSeconds <= 0 || maxSeconds > 86_400)
    throw new RangeError("Choose a positive episode and time budget (at most 10,000 episodes and 86,400 seconds).");
  const training = mode === "train", variants = pursuitStageVariants(stage);
  const selectedSeeds = training ? manifest.trainingSeeds : manifest.validationSeeds;
  const seeds = worlds === 1 ? selectedSeeds : [...new Set(selectedSeeds)];
  if (!variants.length || !seeds?.length || (!training && seeds.some(seed => manifest.trainingSeeds.includes(seed))))
    throw new Error("The Lab workload needs scenarios and separate development evaluation seeds.");
  if (checkpoint != null && (checkpoint.development?.curriculumSha256 !== curriculumSha256 ||
      checkpoint.development?.stage !== stage.id))
    throw new Error("Resume or evaluate with a checkpoint from the same Lab workload and curriculum.");
  if (checkpoint != null && checkpoint.development?.rewardProfile !== stage.rewardProfile)
    throw new Error("Resume or evaluate with the checkpoint's reward profile.");
  if (training && checkpoint && (checkpoint.development.worlds ?? 1) !== worlds)
    throw new Error("Resume with the same number of worlds used to train this checkpoint.");
  if (!training && !checkpoint) throw new Error("Frozen evaluation requires a trained PPO checkpoint.");
  const model = training ? new PursuitPpo(policySeed, checkpoint ?? null, stage.observation) : null;
  const frozen = training ? null : freezePursuitPolicy(checkpoint);
  const { algorithm, observation, seed: networkSeed, updates, transitions, optimizerSteps } = checkpoint ?? model.checkpoint();
  const identity = { algorithm, observation, seed: networkSeed, updates, transitions, optimizerSteps };
  if (observation !== (stage.observation ?? "dispatch-scan-v3"))
    throw new Error("Resume requires the checkpoint observation for this workload.");

  // Evaluation runs only the declared validation seeds, even if spare slots exist.
  const width = training ? worlds : Math.min(worlds, seeds.length);
  const batchSize = worlds * variants.length, budgetMs = maxSeconds * 1000;
  const decisionMs = STEP * PURSUIT_SCAN_TICKS * 1000, normal = speed === "normal";
  const active = [];
  let status = "ready", startedAt, activeMs = 0, timer = null, progressAt = 0;
  let safe = checkpoint ?? null, batch = null, allocated = 0, episodes = 0, lastEpisode;
  let actorRecording;
  const outcomes = { cleanEscapes: 0, escapedWithContact: 0, captured: 0, crashed: 0, timeout: 0,
    contacts: 0, pedestrianContacts: 0, ambientPedestrianContacts: 0 };
  const now = () => performance.now();
  const elapsed = () => activeMs + (status === "running" ? now() - startedAt : 0);
  const expired = () => elapsed() >= budgetMs;

  function report({ includeEpisode, includeCheckpoint, reason, error } = {}) {
    const { updates, transitions, optimizerSteps } = safe ?? identity;
    const activeEpisodes = active.map(({ label, tick }) => ({ ...label, ticks: tick }))
      .sort((a, b) => a.index - b.index);
    const recording = includeEpisode && actorRecording;
    if (recording) actorRecording = undefined;
    post({ type: "session", sessionId, status, mode, episodes, updates, transitions, optimizerSteps,
      outcomes: { ...outcomes },
      worlds, activeWorlds: activeEpisodes.length, activeEpisodes,
      ...(stage.rewardProfile && { rewardProfile: stage.rewardProfile }),
      ...(activeEpisodes.length && { activeEpisode: activeEpisodes[0] }),
      ...(includeEpisode && lastEpisode && { lastEpisode }),
      ...(recording && { actorRecording: recording }),
      ...(includeCheckpoint && safe && { checkpoint: safe }),
      ...(reason && { reason }), ...(error && { error }) }, recording ? recording.frames.map(frame => frame.poses.buffer) : []);
  }

  function finish(outcome, reason, error) {
    clearTimeout(timer);
    timer = null;
    status = outcome;
    active.length = 0;
    batch = null;
    report({ includeEpisode: true, includeCheckpoint: true, reason, error });
  }

  function schedule(delay = 0) {
    if (status !== "running" || timer !== null) return;
    timer = setTimeout(advance, Math.ceil(Math.min(delay, Math.max(0, budgetMs - elapsed()))));
  }

  function planBatch() {
    if (worlds === 1) return { legacy: planPursuitRollout(model, seeds), next: 0, completed: 0, results: [] };
    const start = (model.updates % seeds.length) * batchSize;
    const reserved = new Set([...seeds, ...(manifest.validationSeeds ?? [])]);
    const episodeSeeds = Array.from({ length: batchSize }, (_, order) => {
      const seed = seeds[(start + order) % seeds.length];
      // Some development manifests have fewer seeds than the requested width.
      // Preserve their exact seeds first, then use a separate, explicit training fork.
      if (order < seeds.length) return seed;
      for (let suffix = 0; ; suffix++) {
        const fork = `pako-training-world-${order + 1}-${suffix}:${seed}`.slice(0, 64);
        if (!reserved.has(fork)) {
          reserved.add(fork);
          return fork;
        }
      }
    });
    return { episodeSeeds, next: 0, completed: 0, results: [] };
  }

  function startEpisode() {
    const order = training ? batch.next++ : allocated;
    const lane = order % width;
    const variant = variants[Math.floor(order / width) % variants.length];
    const seed = training ? (batch.legacy?.seed ?? batch.episodeSeeds[order])
      : seeds[(Math.floor(order / (width * variants.length)) * width + lane) % seeds.length];
    const rngSeed = training && worlds > 1 ? `${model.seed}:batched-rollout:${worlds}:${model.updates}:${order}` : null;
    const rng = rngSeed && new Random(rngSeed);
    const select = training ? (batch.legacy?.select ?? (obs => model.sample(obs, rng))) : frozen.action;
    const collisionMarkers = [], recorder = recordActorMotion ? createActorRecorder() : null;
    const cursor = beginPursuitEpisode(variant, seed, select, {
      collect: training, observeWorld: recorder?.capture,
      observeStep: ([poseTick, x, z], events) => {
        for (const event of events) {
          if (collisionMarkers.length >= MAX_COLLISION_MARKERS) break;
          if (event.fresh && (event.type === "patrol_collision" || event.type === "static_or_civilian_hit")) {
            // No impact pose is exported by the plant. These are accepted decision-end coordinates.
            collisionMarkers.push({ tick: event.tick, poseTick, x, z, kind: event.kind ?? event.unitType ?? event.type });
          }
        }
      },
    });
    const index = ++allocated;
    const { algorithm, observation, seed: networkSeed, updates, transitions, optimizerSteps } = safe ?? identity;
    const label = { id: `${sessionId}:${index}`, index, seed, stage: stage.id, curriculumSha256,
      worldIndex: lane + 1, ...(rngSeed && { rngSeed }),
      ...(variant.scenario && { scenario: variant.scenario }),
      policy: { algorithm, observation, seed: networkSeed, updates, transitions, optimizerSteps,
        selection: training ? "sampled" : "frozen" } };
    const decisionCount = Math.ceil(variant.episodeSeconds / (STEP * PURSUIT_SCAN_TICKS));
    const sampleTicks = Math.max(1, Math.ceil(decisionCount / (MAX_PATH_SAMPLES - 2))) * PURSUIT_SCAN_TICKS;
    const pose = cursor.pose();
    active.push({ cursor, label, order, tick: pose[0], trajectory: [pose], sampleTicks, collisionMarkers, recorder,
      due: normal ? elapsed() + decisionMs : 0 });
    if (active.length === 1) progressAt = now();
    report();
  }

  function advance() {
    timer = null;
    if (status !== "running") return;
    try {
      if (expired()) return finish("completed", "time-budget");
      if (batch?.completed === batchSize) {
        // One bounded optimizer update, never a partial workload or a checkpoint mid-update.
        const { rollout, bootstrap } = joinPursuitRollout(model, batch.legacy?.seed ?? batch.episodeSeeds[0], batch.results);
        model.update(rollout, bootstrap);
        const updated = { ...model.checkpoint(), development: { curriculumSha256, stage: stage.id,
          ...(stage.rewardProfile && { rewardProfile: stage.rewardProfile }),
          ...(worlds > 1 && { worlds }) } };
        if (expired()) return finish("completed", "time-budget");
        safe = updated;
        batch = null;
        if (episodes >= maxEpisodes) return finish("completed", "episode-budget");
        report({ includeCheckpoint: true });
        return schedule();
      }
      if (training && !batch) batch = planBatch();
      const next = training ? batch.next : allocated;
      // Run one wave per variant, interleaving its independently seeded Worlds.
      // Don't refill a finished lane with another variant while its peer is still active.
      if (allocated < maxEpisodes && (!training || next < batchSize) && (!active.length || next % width !== 0)) {
        startEpisode();
        return schedule();
      }

      const start = elapsed(), current = active[0];
      if (!current) return finish("completed", "episode-budget");
      if (current.due > start) return schedule(current.due - start);
      active.shift();
      const fromTick = current.tick, result = current.cursor.advance();
      const pose = current.cursor.pose();
      current.tick = pose[0];
      if (result || (current.tick % current.sampleTicks === 0 && current.trajectory.length < MAX_PATH_SAMPLES - 1))
        current.trajectory.push(pose);
      if (result) {
        const { phase, ticks, reward, rewardProfile, collisions, distanceM } = result.metrics;
        const { pursuitQualified, pedestrianImpacts, ambientPedestrianImpacts } = result.metrics;
        if (phase === "escaped" && pursuitQualified) outcomes[collisions ? "escapedWithContact" : "cleanEscapes"]++;
        if (phase === "busted") outcomes.captured++;
        if (phase === "wrecked") outcomes.crashed++;
        if (phase === "timeout") outcomes.timeout++;
        outcomes.contacts += collisions;
        outcomes.pedestrianContacts += pedestrianImpacts;
        outcomes.ambientPedestrianContacts += ambientPedestrianImpacts;
        lastEpisode = { ...current.label, phase, ticks, reward, rewardProfile, collisions, distanceM,
          pursuitQualified, pedestrianImpacts, ambientPedestrianImpacts,
          traceSource: "actual", trajectory: current.trajectory,
          ...(current.collisionMarkers.length && { collisionMarkers: current.collisionMarkers }) };
        actorRecording = current.recorder?.recording;
        episodes++;
        if (training) {
          // GAE order follows allocation, even if the shortest episode finishes first.
          batch.results[current.order] = result;
          batch.completed++;
        }
        if (expired()) return finish("completed", "time-budget");
        // An episode budget may end in the middle of a multi-variant workload.
        // Observed episodes remain reportable, but only a full batch can update PPO.
        if (episodes >= maxEpisodes && (!training || batch.completed !== batchSize))
          return finish("completed", "episode-budget");
        report({ includeEpisode: true });
        return schedule();
      }
      current.due = normal ? start + (pose[0] - fromTick) * STEP * 1000 : 0;
      active.push(current);
      if (now() - progressAt >= PROGRESS_INTERVAL_MS) {
        progressAt = now();
        report();
      }
      schedule(Math.max(0, active[0].due - elapsed()));
    } catch (error) {
      finish("fault", undefined, error.message);
    }
  }

  return {
    start() {
      if (status !== "ready") return;
      startedAt = now();
      status = "running";
      report();
      schedule();
    },
    control(action) {
      if (!["running", "paused"].includes(status)) return;
      if (action === "stop") return finish("stopped", "user-stop");
      if (action === "pause" && status === "running") {
        if (expired()) return finish("completed", "time-budget");
        activeMs = elapsed();
        status = "paused";
        clearTimeout(timer);
        timer = null;
        report({ includeCheckpoint: true });
      } else if (action === "resume" && status === "paused") {
        startedAt = now();
        status = "running";
        report();
        schedule();
      }
    },
  };
}
