// Keep the existing per-tick agent/safety units consistent at any display FPS.
export const STEP_SECONDS = 1 / 60;
export const SPEED_TO_KMH = 60 * 3.6;

export function createFixedStep(step = STEP_SECONDS, maxSteps = 6) {
  let accumulator = 0;
  return {
    advance(elapsed, update) {
      accumulator += Math.min(Math.max(0, elapsed), step * maxSteps);
      let steps = 0;
      while (accumulator + 1e-10 >= step && steps < maxSteps) {
        update(step);
        accumulator -= step;
        steps++;
      }
      return steps;
    },
    reset() { accumulator = 0; },
  };
}
