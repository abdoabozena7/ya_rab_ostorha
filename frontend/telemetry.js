const n = (value, scale = 1) => Number.isFinite(value) ? (value * scale).toFixed(2) : 'unavailable';
const vec = value => value?.map(v => n(v)).join(' / ') || 'unavailable';

export function telemetryText(t, {latencyMs, sensorRates = {}, sensorErrors = {}, world = {}} = {}) {
  return [
    'VEHICLE · CARLA',
    `Speed ${n(t.speedMps, 3.6)} km/h · Longitudinal acceleration ${n(t.accelerationMps2)} m/s²`,
    `Steering input ${n(t.steeringInput)} (positive right; normalized input, not wheel angle)`,
    `Throttle ${n(t.throttle, 100)}% · Brake ${n(t.brake, 100)}%`,
    `Gear ${t.gear ?? 'unavailable'} · Reverse ${t.reverse ?? 'unavailable'} · Handbrake ${t.handbrake ?? 'unavailable'}`,
    `Position ${vec(t.positionWorldM)} m · Velocity ${vec(t.velocityWorldMps)} m/s`,
    `Angular velocity ${vec(t.angularVelocityWorldRadps)} rad/s`,
    'PHYSICS · LIMITATIONS',
    'RPM / wheel dynamics: native 0.9.16 API; mapping and validation pending',
    'Fuel / mechanical engine damage / suspension compression: unavailable',
    'Collision impulse: pending native collision-sensor validation',
    'SENSORS · NATIVE DATA ONLY',
    ...Object.entries({frontCamera: 'RGB', depth: 'Depth', radar: 'Radar', lidar: 'LiDAR', imu: 'IMU', gnss: 'GNSS', collision: 'Collision'})
      .map(([key, label]) => `${label}: ${n(sensorRates[key])} Hz${sensorErrors[key] ? ` · ERROR ${sensorErrors[key]}` : ''}`),
    'SIMULATION',
    `CARLA ${world.version ?? 'unavailable'} · API ${world.pythonApiVersion ?? 'unavailable'}`,
    `Map ${world.map ?? 'unavailable'} · Frame ${t.frame ?? 'unavailable'} · Time ${n(t.timestamp)} s`,
    `Fixed step ${n(world.fixedDeltaSeconds)} s · Synchronous ${world.synchronous ?? 'unavailable'}`,
    `Backend round trip ${n(latencyMs)} ms`,
    'Sensor frames keep their native IDs/timestamps; unmatched frames are not fused.',
  ].join('\n');
}
