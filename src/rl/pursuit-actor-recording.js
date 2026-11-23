import { angleDelta } from "../core/geometry.js";

const STRIDE = 5; // actor index, x, z, heading, elevation
const SCHEMA = "pako-accepted-actors-v1";
const lerp = (a, b, t) => a + (b - a) * t;

export function createActorRecorder() {
  const actors = [], frames = [], indices = new Map();
  return {
    recording: { schema: SCHEMA, actors, frames },
    capture(world) {
      const { player, tick } = world;
      const present = world.actors.filter(actor => actor !== player &&
        (actor.type === "vehicle" || actor.type === "pedestrian"));
      const poses = new Float32Array(present.length * STRIDE);
      for (const [i, actor] of present.entries()) {
        const { id, type, kind, width, height, length, body, pursuitRole, phase } = actor;
        if (!indices.has(id)) {
          indices.set(id, actors.length);
          actors.push({ id, type, kind, width, height, length, pursuitRole, phase,
            ...(body && { body: { widthM: body.widthM, heightM: body.heightM, depthM: body.depthM } }) });
        }
        const offset = i * STRIDE;
        poses[offset] = indices.get(id);
        poses[offset + 1] = actor.x;
        poses[offset + 2] = actor.z;
        poses[offset + 3] = actor.heading ?? 0;
        poses[offset + 4] = actor.y ?? 0;
      }
      frames.push({ ego: [tick, player.x, player.z, player.speed, player.heading], rise: player.y ?? 0, poses });
    },
  };
}

export function createActorPlayback({ schema, actors, frames }) {
  if (schema !== SCHEMA || !frames.length) throw new TypeError("Unsupported City actor recording.");
  const offsets = new Int32Array(actors.length);
  const last = frames.at(-1);

  return {
    nextTick(tick) { return frames.find(frame => frame.ego[0] > tick)?.ego[0] ?? last.ego[0]; },
    sample(tick) {
      tick = Math.max(frames[0].ego[0], Math.min(tick, last.ego[0]));
      let lo = 0, hi = frames.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >>> 1;
        if (frames[mid].ego[0] <= tick) lo = mid;
        else hi = mid - 1;
      }
      const start = frames[lo], end = frames[lo + 1];
      const a = start.ego, b = end?.ego;
      const t = end ? (tick - a[0]) / (b[0] - a[0]) : 0;
      const pose = t ? [tick, lerp(a[1], b[1], t), lerp(a[2], b[2], t),
        lerp(a[3], b[3], t), a[4] + angleDelta(b[4], a[4]) * t] : a;
      const rise = t ? lerp(start.rise, end.rise, t) : start.rise;
      const { poses } = start;
      if (t) {
        offsets.fill(-1);
        for (let i = 0; i < end.poses.length; i += STRIDE) offsets[end.poses[i]] = i;
      }
      const visible = [];
      for (let i = 0; i < poses.length; i += STRIDE) {
        const index = poses[i], next = t ? offsets[index] : -1;
        let x = poses[i + 1], z = poses[i + 2], heading = poses[i + 3], y = poses[i + 4];
        // An actor's membership changes only on a recorded frame, not between two samples.
        if (next >= 0) {
          x = lerp(x, end.poses[next + 1], t);
          z = lerp(z, end.poses[next + 2], t);
          heading += angleDelta(end.poses[next + 3], heading) * t;
          y = lerp(y, end.poses[next + 4], t);
        }
        visible.push({ ...actors[index], x, z, heading, y });
      }
      return { pose, rise, actors: visible };
    },
  };
}
