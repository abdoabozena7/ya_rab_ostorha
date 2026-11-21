import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { freezePursuitPolicy, PursuitPpo } from "../src/rl/pursuit-ppo.js";
import { collectPursuitRollout, runPursuitEpisode, pursuitStageVariants } from "../src/rl/pursuit-rollouts.js";
import { routeDemonstration } from "./metro-route-demonstrations.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const curriculumText = await readFile(join(root, "config", "pursuit-rl-development.json"), "utf8");
export const curriculum = JSON.parse(curriculumText);
const routeText = await readFile(join(root, "config", "pursuit-rl-route-development.json"), "utf8");
export const routeCurriculum = JSON.parse(routeText);
const cityRouteText = await readFile(join(root, "config", "pursuit-rl-city-route-development.json"), "utf8");
export const cityRouteCurriculum = JSON.parse(cityRouteText);
const manifests = [curriculum, routeCurriculum, cityRouteCurriculum];
const manifestSource = new Map([[curriculum, curriculumText], [routeCurriculum, routeText], [cityRouteCurriculum, cityRouteText]]);
const digest = value => createHash("sha256").update(value).digest("hex");
const trainingSeeds = new Set(manifests.flatMap(manifest => manifest.trainingSeeds));
const validationSeeds = manifests.flatMap(manifest => manifest.validationSeeds);
if (new Set(validationSeeds).size !== validationSeeds.length || validationSeeds.some(seed => trainingSeeds.has(seed)))
  throw new Error("Development training and validation seeds overlap");

export const scripted = () => ({ steer: 0, throttle: .65, brake: 0, gear: 1 });

function traced(run) {
  const trajectory = createHash("sha256");
  const result = run(step => trajectory.update(JSON.stringify(step)));
  result.metrics.trajectorySha256 = trajectory.digest("hex");
  return result;
}

export function runEpisode(stage, seed, select) {
  return traced(trace => runPursuitEpisode(stage, seed, select, false, trace));
}

export function collectUpdate(model, stage, manifest = curriculum) {
  return traced(trace => collectPursuitRollout(model, stage, manifest.trainingSeeds, trace));
}

async function main() {
  const { values } = parseArgs({ options: {
    output: { type: "string" }, stage: { type: "string", default: "maneuver" },
    updates: { type: "string", default: "1" }, resume: { type: "string" }, "warm-start": { type: "string", default: "0" },
  } });
  const count = Number(values.updates), epochs = Number(values["warm-start"]);
  const stages = manifests.flatMap(manifest => manifest.stages);
  const manifest = manifests.find(group => group.stages.some(row => row.id === values.stage));
  const stage = manifest?.stages.find(row => row.id === values.stage);
  if (!values.output || !stage || !Number.isSafeInteger(count) || count < 0 || count > 16 ||
      (count === 0 && !values.resume && !epochs) || !Number.isSafeInteger(epochs) ||
      epochs < 0 || epochs > 80 ||
      (epochs && (values.resume || (stage.id !== "junction-escape" && !stage.demonstrationSpeedMps))))
    throw new Error(`Usage: node tools/train-metro-pursuit.mjs --output NEW_DIRECTORY [--stage ${stages.map(stage => stage.id).join("|")}] [--updates 1..16] [--resume CHECKPOINT | --warm-start EPOCHS]; 0 updates evaluates a checkpoint or warm start.`);
  const curriculumId = digest(JSON.stringify(manifest));
  const out = resolve(values.output);
  const previousData = values.resume ? await readFile(resolve(values.resume), "utf8") : null;
  const previous = previousData && JSON.parse(previousData);
  if (previous && ![curriculumId, digest(manifestSource.get(manifest))]
    .includes(previous.development?.curriculumSha256))
    throw new Error("Resume requires the same development curriculum");
  const model = new PursuitPpo("metro-dispatch-development", previous, stage.observation);
  if (model.observation !== (stage.observation ?? "dispatch-scan-v3"))
    throw new Error("Checkpoint observation does not match the selected workload");
  const untrained = new PursuitPpo(model.seed, null, model.observation);
  await mkdir(dirname(out), { recursive: true });
  await mkdir(out);
  const history = [];
  let sha256 = previousData ? digest(previousData) : null;
  let warm = null, warmMetrics = null;
  if (epochs) {
    const demos = pursuitStageVariants(stage).flatMap(variant => manifest.trainingSeeds.flatMap(seed =>
      [false, true].map(perturb => routeDemonstration(variant, seed, perturb))));
    const measured = demos.filter(demo => demo.metrics.phase === "escaped" && demo.metrics.collisions === 0);
    if (!measured.length) throw new Error("Warm start needs actual successful training-only trajectories");
    const losses = model.warmStart(measured.flatMap(demo => demo.samples), epochs);
    const checkpoint = { ...model.checkpoint(), development: { curriculumSha256: curriculumId, stage: stage.id } };
    warm = new PursuitPpo(model.seed, checkpoint);
    const data = JSON.stringify(checkpoint) + "\n";
    await writeFile(join(out, "warm-start.json"), data, { flag: "wx" });
    sha256 = digest(data);
    warmMetrics = { sha256, losses, attempted: demos.map(demo => demo.metrics),
      acceptedDemonstrations: measured.length, samples: checkpoint.demonstrations };
  }
  for (let i = 0; i < count; i++) {
    const { rollout, metrics, bootstrap } = collectUpdate(model, stage, manifest);
    const update = model.update(rollout, bootstrap);
    const checkpoint = { ...model.checkpoint(), development: { curriculumSha256: curriculumId, stage: stage.id } };
    const name = `checkpoint-${String(model.updates).padStart(4, "0")}.json`;
    const data = JSON.stringify(checkpoint) + "\n";
    await writeFile(join(out, name), data, { flag: "wx" });
    sha256 = digest(data);
    const row = { ...update, metrics, checkpoint: name, sha256 };
    history.push(row);
    console.log(JSON.stringify({ kind: "update", ...row }));
  }
  const frozen = model.updates ? freezePursuitPolicy(model.checkpoint()) : null;
  const evaluation = pursuitStageVariants(stage).flatMap(variant => manifest.validationSeeds.map(seed => ({
    seed, scenario: variant.scenario,
    trained: runEpisode(variant, seed, frozen ? frozen.action : obs => model.action(obs)).metrics,
    untrained: runEpisode(variant, seed, obs => untrained.action(obs)).metrics,
    scripted: runEpisode(variant, seed, scripted).metrics,
    ...(warm && frozen ? { warmStart: runEpisode(variant, seed, obs => warm.action(obs)).metrics } : {}),
    ...((variant.scenarios && variant.observation === "dispatch-route-v1") || variant.demonstrationSpeedMps
      ? { routeFollower: routeDemonstration(variant, seed).metrics } : {}),
  })));
  await writeFile(join(out, "metrics.json"), JSON.stringify({
    purpose: "development-only; not untouched holdouts or City promotion", curriculumSha256: curriculumId,
    sha256, stage: stage.id, model: { algorithm: model.checkpoint().algorithm, observation: model.observation,
      transitions: model.transitions, updates: model.updates, demonstrations: model.demonstrations },
    warmStart: warmMetrics, history, evaluation,
  }, null, 2), { flag: "wx" });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
