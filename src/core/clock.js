import { STEP } from "./config.js";
export class FixedClock {
  constructor() {
    this.accumulator = 0;
    this.discardedSeconds = 0;
  }
  advance(seconds, step) {
    if (!Number.isFinite(seconds) || seconds < 0) return 0;
    this.discardedSeconds += Math.max(0, seconds - 0.25);
    this.accumulator += Math.min(seconds, 0.25);
    let count = 0;
    while (this.accumulator + 1e-10 >= STEP) {
      step();
      this.accumulator -= STEP;
      count++;
    }
    return count;
  }
  get alpha() {
    return Math.max(0, this.accumulator / STEP);
  }
}
