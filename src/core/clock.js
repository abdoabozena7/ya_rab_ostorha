import { STEP } from "./config.js";
export class FixedClock {
  constructor() {
    this.accumulator = 0;
    this.discardedSeconds = 0;
  }
  advance(seconds, step, maxSteps = Infinity) {
    if (!Number.isFinite(seconds) || seconds < 0) return 0;
    const supplied = Math.min(seconds, 0.25);
    this.discardedSeconds += seconds - supplied;
    this.accumulator += supplied;
    if (Number.isFinite(maxSteps) && this.accumulator > .25) {
      this.discardedSeconds += this.accumulator - .25;
      this.accumulator = .25;
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
