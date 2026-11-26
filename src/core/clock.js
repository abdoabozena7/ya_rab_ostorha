import { STEP } from "./config.js";
export class FixedClock {
  constructor({ maxBacklogSeconds = Infinity } = {}) {
    this.accumulator = 0;
    this.discardedSeconds = 0;
    this.maxBacklogSeconds = maxBacklogSeconds;
  }
  advance(seconds, step, maxSteps = Infinity) {
    if (!Number.isFinite(seconds) || seconds < 0) return 0;
    const cap = Number.isFinite(this.maxBacklogSeconds) && this.maxBacklogSeconds > 0
      ? this.maxBacklogSeconds
      : Infinity;
    const supplied = Math.min(seconds, cap);
    this.discardedSeconds += seconds - supplied;
    this.accumulator += supplied;
    if (Number.isFinite(cap) && this.accumulator > cap) {
      this.discardedSeconds += this.accumulator - cap;
      this.accumulator = cap;
    }
    let count = 0;
    while (count < maxSteps && this.accumulator + 1e-10 >= STEP) {
      step();
      this.accumulator -= STEP;
      count++;
    }
    return count;
  }
  get alpha() {
    return Math.min(1, Math.max(0, this.accumulator / STEP));
  }
}
