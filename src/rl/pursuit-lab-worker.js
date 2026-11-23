import curriculum from "../../config/pursuit-rl-development.json";
import routeCurriculum from "../../config/pursuit-rl-route-development.json";
import cityRouteCurriculum from "../../config/pursuit-rl-city-route-development.json";
import chaseCurriculum from "../../config/pursuit-rl-city-escape-focus.json";
import { CLEAN_ESCAPE_REWARD } from "./gta-pursuit-env.js";
import { PursuitPpo } from "./pursuit-ppo.js";
import { collectPursuitRollout } from "./pursuit-rollouts.js";
import { createPursuitSession } from "./pursuit-session.js";

let commissioned = false;
let active = null;

async function workloadFor(stageId, checkpoint) {
  const manifest = [curriculum, routeCurriculum, cityRouteCurriculum, chaseCurriculum]
    .find(group => group.stages.some(row => row.id === stageId));
  const stage = manifest?.stages.find(row => row.id === stageId);
  if (!stage) throw new RangeError("Choose a Lab workload.");
  // Absence on a saved checkpoint means the original scoring, not the new default.
  const focused = manifest === chaseCurriculum;
  const rewardProfile = checkpoint == null && focused ? CLEAN_ESCAPE_REWARD : checkpoint?.development?.rewardProfile;
  if (rewardProfile !== undefined && (!focused || rewardProfile !== CLEAN_ESCAPE_REWARD))
    throw new RangeError("Checkpoint reward profile is not supported for this Lab workload.");
  const bytes = new TextEncoder().encode(JSON.stringify(manifest));
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const curriculumSha256 = [...hash].map(n => n.toString(16).padStart(2, "0")).join("");
  return { manifest, stage: rewardProfile ? { ...stage, rewardProfile } : stage, curriculumSha256, recordActorMotion: focused };
}

async function runLegacyUpdate(data) {
  try {
    const { manifest, stage, curriculumSha256 } = await workloadFor(data.stage, data.checkpoint);
    if (data.checkpoint && data.checkpoint.development?.curriculumSha256 !== curriculumSha256)
      throw new Error("Resume requires the same Lab scenarios and scoring.");
    const model = new PursuitPpo("metro-dispatch-development", data.checkpoint ?? null, stage.observation);
    if (model.observation !== (stage.observation ?? "dispatch-scan-v3"))
      throw new Error("Resume requires the checkpoint observation for this workload.");
    const { rollout, bootstrap, metrics } = collectPursuitRollout(model, stage, manifest.trainingSeeds);
    model.update(rollout, bootstrap);
    self.postMessage({ checkpoint: { ...model.checkpoint(), development: { curriculumSha256, stage: stage.id,
      ...(stage.rewardProfile && { rewardProfile: stage.rewardProfile }) } }, metrics });
  } catch (error) {
    self.postMessage({ error: error.message });
  }
}

async function runSession(data, request) {
  try {
    const workload = await workloadFor(data.stage, data.checkpoint);
    request.driver = createPursuitSession(data, workload, (message, transfer) => {
      if (message.status !== "running" && message.status !== "paused") active = null;
      self.postMessage(message, transfer);
    });
    request.driver.start();
    if (request.pendingAction) request.driver.control(request.pendingAction);
  } catch (error) {
    active = null;
    self.postMessage({ type: "session", sessionId: data.sessionId, mode: data.mode, status: "fault",
      episodes: 0, updates: 0, transitions: 0, optimizerSteps: 0, error: error.message });
  }
}

self.onmessage = ({ data }) => {
  if (data?.type === "session-control") {
    if (!active || (data.sessionId !== undefined && data.sessionId !== active.sessionId) ||
        !["pause", "resume", "stop"].includes(data.action)) return;
    if (active.driver) active.driver.control(data.action);
    // A control can arrive while hashing the manifest, before the first tick.
    else if (active.pendingAction !== "stop") active.pendingAction = data.action;
    return;
  }
  if (commissioned || active) return;
  if (data?.type === "session-start") {
    active = { sessionId: data.sessionId };
    return runSession(data, active);
  }
  if (data?.type !== undefined) return;
  commissioned = true;
  return runLegacyUpdate(data);
};
