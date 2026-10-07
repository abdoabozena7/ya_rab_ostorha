// Frame identity only. This module never generates sensor measurements.
export function sensorFrameKey(metadata) {
  if (!metadata?.frameAvailable || !Number.isInteger(metadata.frame) || metadata.frame < 0 ||
      !Number.isFinite(metadata.timestamp) || metadata.timestamp < 0) return null;
  return JSON.stringify([metadata.frame, metadata.timestamp, metadata.asset?.path ?? null]);
}

export function matchesSensorResponse(metadata, headers) {
  if (sensorFrameKey(metadata) === null) return false;
  const frame = headers.get('X-Sensor-Frame'), timestamp = headers.get('X-Sensor-Time');
  if (frame === null || timestamp === null || frame.trim() === '' || timestamp.trim() === '') return false;
  return Number(frame) === metadata.frame && Number.isInteger(Number(frame)) &&
    Number.isFinite(Number(timestamp)) && Math.abs(Number(timestamp) - metadata.timestamp) <= 1e-6;
}
