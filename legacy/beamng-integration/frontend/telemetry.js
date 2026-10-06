const n=(value,scale=1)=>Number.isFinite(value)?(value*scale).toFixed(1):'unavailable';
export function telemetryText(t, {renderFPS,latencyMs,sensorRates={},sensorErrors={},remote=false}={}) {
  const wheels=Object.fromEntries((t.wheels??[]).map(w=>[w.name,w]));
  const order=['frontLeft','frontRight','rearLeft','rearRight'];
  const d=t.damage??{};
  return [
    'VEHICLE',`Speed ${n(t.speedMps,3.6)} km/h · Accel ${n(t.accelerationMps2)} m/s²`,
    `Road wheel steer ${n(t.steeringAngleRad,180/Math.PI)}° · Steering wheel ${n(t.steeringWheelAngleRad,180/Math.PI)}°`,
    `Throttle ${n(t.throttle,100)}% · Brake ${n(t.brake,100)}%`,
    `Gear ${t.gear??'unavailable'} · RPM ${n(t.engineRPM)} · Fuel ${n(t.fuelLevelL)} L`,
    ...(remote?[`Position ${(t.positionWorldM??[]).map(v=>n(v)).join(' / ')||'unavailable'} m`,
      `Velocity ${(t.velocityWorldMps??[]).map(v=>n(v)).join(' / ')||'unavailable'} m/s`,
      `Orientation: forward ${(t.forwardWorld??[]).map(v=>n(v)).join(' / ')||'unavailable'} · up ${(t.upWorld??[]).map(v=>n(v)).join(' / ')||'unavailable'}`]:[]),
    `Fuel flow ${n(t.instantConsumptionLph)} L/h · Range ${n(t.estimatedRangeKm)} km`,
    'PHYSICS', ...order.map(name=>`${name}: ${n(wheels[name]?.rpm)} RPM · Suspension ${n(wheels[name]?.suspensionCompressionM)} m`),
    'DAMAGE',`Engine ${n(d.engine)} · Body ${n(d.body)} · Transmission ${n(d.transmission)}`,
    `Wheels ${order.map(name=>n(d[name])).join(' / ')}`,
    ...(remote?[`BeamNG aggregate damage ${n(t.damageTotal)} (raw SDK units)`]:['Development collision estimates']),
    'SENSORS', ...(remote?Object.entries({frontCamera:'Camera',radarFront:'Radar',lidarRoof:'LiDAR',imu:'IMU',gps:'GPS'}).map(([key,label])=>`${label} poll Hz ${n(sensorRates[key])}${sensorErrors[key]?` · ERROR ${sensorErrors[key]}`:''}`):['Camera: browser scene view','Radar / LiDAR / IMU / GPS: unavailable']),
    'SIMULATION',`Time ${n(t.timestamp)} s · Physics tick ${t.physicsTick??'unavailable'}`,
    `Physics Hz ${remote?'unavailable':'60 (development step)'} · Render ${n(renderFPS)} FPS · RTT ${n(latencyMs)} ms`,
    t.lastCollision?`Last development impact ${n(t.lastCollision.impulseNs)} N·s · ${t.lastCollision.component}`:'Collision impulse unavailable',
  ].join('\n');
}
