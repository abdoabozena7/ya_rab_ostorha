export function passesCityDensity(sample, pedestrians = 96) {
  return sample.fps >= 25 && sample.ticksPerSecond >= 50 &&
    sample.frameMs.p95 <= 65 && sample.frameMs.p99 <= 110 &&
    sample.ending.population === pedestrians;
}
