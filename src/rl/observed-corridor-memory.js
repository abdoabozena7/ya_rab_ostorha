import { STEP } from "../core/config.js";
import { distance } from "../core/geometry.js";
import { PURSUIT_SCAN_TICKS } from "../signal_processing/pursuit-scanner.js";

const ticks = seconds => Math.round(seconds / STEP);
const HISTORY_TICKS = ticks(20);
const REVISIT_TICKS = ticks(7);
const RETREAT_TICKS = ticks(8);
const EXIT_DISTANCE_M = 17;

function observedBlocker(scan, player) {
  return scan.tracks.some(track => track.ageS === 0 && track.kind !== "pedestrian" &&
    track.forwardM > 0 && track.forwardM <= 13 && Math.abs(track.rightM) <= player.width / 2 + 2.8);
}

function returnPrefix(frames, player, entryTick) {
  const path = [{ x: player.x, z: player.z }];
  const sin = Math.sin(player.heading), cos = Math.cos(player.heading);
  let radius = 0;
  for (let i = frames.length - 1; i >= 0; i--) {
    const point = frames[i];
    if (point.tick > entryTick) continue;
    const d = distance(point, player);
    if (d < radius + 0.8) continue;
    if (path.length === 1 && (point.x - player.x) * sin + (point.z - player.z) * cos > -0.6 * d) continue;
    if (distance(point, path.at(-1)) > 4) continue;
    path.push(point);
    radius = d;
    if (radius >= EXIT_DISTANCE_M) return path;
  }
  return null;
}

export class ObservedCorridorMemory {
  frames = [];
  recovery = null;
  retreat = null;
  pocket = null;

  observe(player, scan, tick, goalId, recoveryTick) {
    const previous = this.frames.at(-1);
    if (scan.tick !== tick || previous?.tick >= tick) return;
    const frame = {
      x: player.x, z: player.z, tick,
      travel: previous ? previous.travel + distance(player, previous) : 0,
    };
    if (previous && (tick - previous.tick > 2 * PURSUIT_SCAN_TICKS || frame.travel - previous.travel > 5)) {
      this.frames = [];
      this.recovery = this.retreat = this.pocket = null;
      frame.travel = 0;
    }
    this.frames.push(frame);
    while (this.frames[0].tick < tick - HISTORY_TICKS) this.frames.shift();
    if (this.pocket && tick >= this.pocket.expires) this.pocket = null;
    if (this.retreat && (tick >= this.retreat.expires || distance(player, this.retreat.path.at(-1)) < 1.3)) {
      if (this.pocket) this.pocket.left = distance(player, this.pocket) >= 8;
      this.retreat = null;
    }
    if (!goalId || !Number.isSafeInteger(recoveryTick) || recoveryTick === this.recovery?.start) return;

    const prior = this.recovery;
    this.recovery = { ...frame, goalId, start: recoveryTick };
    if (this.retreat || this.pocket || !prior || prior.goalId !== goalId ||
        tick - prior.tick > REVISIT_TICKS || distance(player, prior) > 2.2 ||
        frame.travel - prior.travel < 0.6 || !observedBlocker(scan, player)) return;
    const path = returnPrefix(this.frames, player, prior.tick);
    if (!path) return;
    this.retreat = { path, cursor: 0, startedTick: tick, expires: tick + RETREAT_TICKS };
    this.pocket = { x: player.x, z: player.z, goalId, expires: tick + RETREAT_TICKS + REVISIT_TICKS, left: false };
  }

  target(player) {
    if (!this.retreat) return null;
    const { path } = this.retreat;
    let i = this.retreat.cursor;
    while (i + 1 < path.length && distance(player, path[i + 1]) < distance(player, path[i])) i++;
    this.retreat.cursor = i;
    let ahead = 0;
    for (let j = i + 1; j < path.length; j++) {
      ahead += distance(path[j - 1], path[j]);
      if (ahead >= 3.6) return path[j];
    }
    return path.at(-1);
  }
}
