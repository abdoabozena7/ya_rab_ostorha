import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { beginPursuitEpisode } from "../src/rl/pursuit-rollouts.js";
import { createPursuitSession } from "../src/rl/pursuit-session.js";
import { createActorRecorder, createActorPlayback } from "../src/rl/pursuit-actor-recording.js";

const manifest = JSON.parse(await readFile(new URL("../config/pursuit-rl-city-escape-focus.json", import.meta.url)));
const stage = { ...manifest.stages[2], episodeSeconds: 3 };

test("recording captures accepted actors and exact session parity", { timeout: 20_000 }, async () => {
  const options = { sessionId: "trace-parity", mode: "train", maxEpisodes: 1, maxSeconds: 12, speed: "fast" };
  function run(recordActorMotion) {
    return new Promise(resolve => {
      const recordings = [];
      const session = createPursuitSession(options, { manifest, stage, curriculumSha256: "parity", recordActorMotion },
        ({ actorRecording, ...message }, transfer) => {
          if (actorRecording) {
            recordings.push(structuredClone(actorRecording, { transfer }));
            assert.equal(actorRecording.frames[0].poses.byteLength, 0, "The completed payload was transferred");
          }
          if (["completed", "fault"].includes(message.status)) resolve({ message, recordings });
        });
      session.start();
    });
  }
  const recorded = await run(true);
  const plain = await run(false);
  assert.equal(recorded.message.status, "completed", recorded.message.error);
  assert.ok(recorded.message.checkpoint.updates > 0);
  assert.deepEqual(recorded.message, plain.message);
  assert.equal(recorded.recordings.length, 1);
  assert.equal(plain.recordings.length, 0);
  const [{ frames }] = recorded.recordings;
  assert.deepEqual(frames[0].ego, recorded.message.lastEpisode.trajectory[0]);
  assert.deepEqual(frames.at(-1).ego, recorded.message.lastEpisode.trajectory.at(-1));
});

test("time-aligned replay follows the independently observed Metro World instead of retaining despawned patrols", () => {
  const recorder = createActorRecorder(), observed = new Map();
  const episode = beginPursuitEpisode(stage, "actor-trace-development",
    () => ({ steer: 0, throttle: .4, brake: 0, gear: 1 }), {
    observeWorld(world) {
      const { tick, player } = world;
      observed.set(tick, {
        ego: [tick, player.x, player.z, player.speed, player.heading],
        actors: new Map(world.actors.filter(actor => actor !== player).map(
          actor => [actor.id, [actor.x, actor.z, actor.heading ?? 0].map(Math.fround)])),
      });
      recorder.capture(world);
    },
  });
  let result;
  do { result = episode.advance(); } while (!result);
  const replay = createActorPlayback(recorder.recording);
  for (const [tick, expected] of observed) {
    const sample = replay.sample(tick);
    assert.deepEqual(sample.pose, expected.ego);
    assert.deepEqual(new Map(sample.actors.map(actor => [actor.id, [actor.x, actor.z, actor.heading]])), expected.actors);
  }
  const first = replay.sample(0), next = replay.sample(replay.nextTick(0)), midpoint = replay.sample(3);
  const a = first.actors.find(actor => actor.type === "pedestrian");
  const b = next.actors.find(actor => actor.id === a.id);
  const middle = midpoint.actors.find(actor => actor.id === a.id);
  assert.ok(Math.hypot(a.x - b.x, a.z - b.z) > 0, "A real pedestrian moved between matched samples");
  assert.equal(middle.x, (a.x + b.x) / 2);
  assert.equal(middle.z, (a.z + b.z) / 2);
  const preTerminal = replay.sample(result.metrics.ticks - 1);
  const terminal = replay.sample(result.metrics.ticks);
  assert.ok(preTerminal.actors.some(actor => actor.pursuitRole === "police"));
  assert.ok(!terminal.actors.some(actor => actor.pursuitRole === "police"));
});
