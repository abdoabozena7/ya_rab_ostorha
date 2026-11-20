const LEGACY_MAX_BYTES = 2_000_000;
const DISTRICT_MAX_BYTES = 16_000_000;
const replayLimit = (environment) =>
  ["egypt", "metro"].includes(environment) ? DISTRICT_MAX_BYTES : LEGACY_MAX_BYTES;

function requireReplaySize(size, limit) {
  if (size > limit) throw new RangeError("Replay file is too large");
}

export function createReplayBlob(replay) {
  const limit = replayLimit(replay.environment);
  const longForm = limit === DISTRICT_MAX_BYTES;
  const blob = new Blob([JSON.stringify(replay, null, longForm ? 0 : 2)], {
    type: "application/json",
  });
  if (longForm) requireReplaySize(blob.size, limit);
  return blob;
}

export async function readReplayFile(file) {
  requireReplaySize(file.size, DISTRICT_MAX_BYTES);
  const replay = JSON.parse(await file.text());
  requireReplaySize(file.size, replayLimit(replay?.environment));
  return replay;
}
