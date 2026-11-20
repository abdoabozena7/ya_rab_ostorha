export function bodyPathAllowsLateralMotion(track, motion, ego) {
  const c = Math.cos(ego.headingRad), s = Math.sin(ego.headingRad);
  const lateralVariance = (matrix) => Math.max(0,
    c * c * matrix.xx - 2 * c * s * matrix.xz + s * s * matrix.zz);
  const forwardVariance = (matrix) => Math.max(0,
    s * s * matrix.xx + 2 * c * s * matrix.xz + c * c * matrix.zz);
  const lateralMps = track.velocity.x * c - track.velocity.z * s;
  const forwardMps = track.velocity.x * s + track.velocity.z * c;
  const lateralErrorMps = 0.05 + Math.sqrt(lateralVariance(track.velocityCovarianceM2S2));
  const forwardErrorMps = 0.05 + Math.sqrt(forwardVariance(track.velocityCovarianceM2S2));
  const forwardPositionErrorM = Math.sqrt(forwardVariance(track.positionCovarianceM2) +
    forwardVariance(track.regressionResidualCovarianceM2));
  if (!track.reliable || Math.abs(lateralMps) - lateralErrorMps >= 0.2 ||
      Math.abs(forwardMps) - forwardErrorMps <= 0.2 ||
      Math.abs(forwardMps) * track.spanS <= 2 * forwardPositionErrorM)
    return true;
  const positionVariance = lateralVariance(track.positionCovarianceM2) +
    lateralVariance(track.regressionResidualCovarianceM2);
  const velocityVariance = lateralVariance(track.velocityCovarianceM2S2);
  let firstOutsideS = track.lastSeenS;
  // A walking box can sway along a stable body path; a turn needs persistent measured departure.
  for (let i = track.history.length - 1; i >= 0; i--) {
    const sample = track.history[i];
    if (sample.simulationTimeS < motion.supportTimeS - 1e-8) break;
    const dt = sample.simulationTimeS - track.lastSeenS;
    const dx = sample.position.x - track.position.x - track.velocity.x * dt;
    const dz = sample.position.z - track.position.z - track.velocity.z * dt;
    const innovationM = dx * c - dz * s;
    const errorM = 2 * Math.sqrt(positionVariance + dt * dt * velocityVariance);
    if (innovationM * motion.lateralMps <= 0 || Math.abs(innovationM) <= errorM) break;
    firstOutsideS = sample.simulationTimeS;
  }
  return track.lastSeenS - firstOutsideS >= 0.1 - 1e-8;
}
