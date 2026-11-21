import curriculum from "../../config/pursuit-rl-development.json";
import routeCurriculum from "../../config/pursuit-rl-route-development.json";
import cityRouteCurriculum from "../../config/pursuit-rl-city-route-development.json";
import { PursuitPpo } from "./pursuit-ppo.js";
import { collectPursuitRollout } from "./pursuit-rollouts.js";

let commissioned = false;
self.onmessage = async ({ data }) => {
  if (commissioned) return;
  commissioned = true;
  try {
    const manifest = [curriculum, routeCurriculum, cityRouteCurriculum]
      .find(group => group.stages.some(row => row.id === data.stage));
    const stage = manifest?.stages.find(row => row.id === data.stage);
    if (!stage) throw new RangeError("Choose a Lab workload.");
    const bytes = new TextEncoder().encode(JSON.stringify(manifest));
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    const curriculumSha256 = [...hash].map(n => n.toString(16).padStart(2, "0")).join("");
    if (data.checkpoint && data.checkpoint.development?.curriculumSha256 !== curriculumSha256)
      throw new Error("Resume requires the same Lab scenarios and scoring.");
    const model = new PursuitPpo("metro-dispatch-development", data.checkpoint ?? null, stage.observation);
    if (model.observation !== (stage.observation ?? "dispatch-scan-v3"))
      throw new Error("Resume requires the checkpoint observation for this workload.");
    const { rollout, bootstrap, metrics } = collectPursuitRollout(model, stage, manifest.trainingSeeds);
    model.update(rollout, bootstrap);
    self.postMessage({ checkpoint: { ...model.checkpoint(), development: { curriculumSha256, stage: stage.id } }, metrics });
  } catch (error) {
    self.postMessage({ error: error.message });
  }
};
