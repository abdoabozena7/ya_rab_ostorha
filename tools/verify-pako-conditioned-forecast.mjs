import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { gtaLocal } from "../src/core/pursuit-gta.js";
import { GtaPursuitEnv } from "../src/rl/gta-pursuit-env.js";
import { PAKO_JUNCTION_TRAIN, PAKO_JUNCTION_VALIDATE } from "../src/rl/pako-junction-course.js";
import { createForecastInputs, fitSurfaceResponse, predictSurfaceResponse }
  from "../src/signal_processing/pako-conditioned-forecast.js";

const control = (throttle, steer = 0, brake = 0) => ({ gear: 1, throttle, steer, brake });
const candidateIds = ["straight", "pace-up", "brake", "alternate-early", "alternate-late"];
const novelIds = ["alternate-then-yield", "short-opposite-curve"];
const models = ["cv", "independent", "conditioned"];
const output = process.env.PROVE_IT_OUTPUT_DIR;
assert.ok(output, "Write the prediction comparison to a new development directory");

function sequence(branch, side) {
  return Array.from({ length: 50 }, (_, i) => {
    if (branch === "straight") return control(.45);
    if (branch === "pace-up") return control(.95);
    if (branch === "brake") return control(0, 0, 1);
    if (branch === "short-opposite-curve") return control(.7, i > 2 && i < 10 ? -side * .52 : 0);
    if (branch === "alternate-then-yield" && i >= 18) return control(0, 0, .7);
    const turnAt = branch === "alternate-early" ? 3 : 7;
    return control(.85, i < turnAt ? 0 : i < turnAt + 10 ? side * .86
      : i < turnAt + 16 ? side * -.35 : 0);
  });
}

function sampleCourse(scenario, seed, branch) {
  const env = new GtaPursuitEnv();
  const { info } = env.reset({ scenario, seed, traffic: 0, pedestrians: 0, shield: true,
    config: { ruleset: "dispatch-v1", maxActivePatrols: 1, wantedLevelMax: 1, episodeMaxSeconds: 7, enableRoadblocks: false } });
  const { world } = env;
  const [patrol] = world.pursuit.patrols;
  for (let i = 0; i < 2; i++) env.step(control(.55));
  const { player, tick } = world;
  const track = world.pursuit.gta.scan.tracks.find(track => track.kind === "police" && track.motionKnown && !track.ageS);
  assert.ok(track && patrol, "At the shared branching tick, a real patrol track must have resolved motion");
  const ego = { ...player }, actions = sequence(branch, info.scenario.turn);
  const inputs = createForecastInputs(ego, track, actions);
  assert.ok(inputs?.length && !createForecastInputs(ego, { ...track, ageS: .1 }, actions));
  // Ground truth only for evaluation: carry the same initial surface point with the actual target.
  const anchor = gtaLocal(patrol, { x: track.observedXM, z: track.observedZM });
  const surface = () => gtaLocal(ego, {
    x: patrol.x + Math.cos(patrol.heading) * anchor.right + Math.sin(patrol.heading) * anchor.forward,
    z: patrol.z - Math.sin(patrol.heading) * anchor.right + Math.cos(patrol.heading) * anchor.forward,
  });
  const rows = [], contacts = [];
  for (const action of actions) {
    const state = env.step(action);
    const input = inputs.find(item => item.tick === world.tick - tick);
    if (input) {
      const { right, forward } = surface();
      rows.push({ input, actual: [right, forward], ego: [player.x, player.z], actualPatrol: [patrol.x, patrol.z] });
    }
    contacts.push(...state.info.events.filter(event => event.fresh && (event.type === "patrol_collision" ||
      event.type === "static_or_civilian_hit")));
    if (state.terminated || state.truncated) break;
  }
  return { scenario, seed, branch, initial: [tick, ego.x, ego.z, ego.heading, track.observedXM, track.observedZM,
    track.estimatedXMps, track.estimatedZMps], contacts, rows };
}

function generate(scenarios, split, seeds) {
  return scenarios.flatMap((scenario, index) => seeds.flatMap(suffix => {
    const seed = `pako-forecast-${split}-${index}-${suffix}`;
    const branches = split === "train" ? candidateIds : candidateIds.concat(novelIds);
    const group = branches.map(branch => sampleCourse(scenario, seed, branch));
    assert.ok(group.every(arm => JSON.stringify(arm.initial) === JSON.stringify(group[0].initial)),
      "Paired candidates must branch from the same accepted state and scan");
    return group;
  }));
}

const training = generate(PAKO_JUNCTION_TRAIN, "train", ["a", "b", "c", "d"]);
const evalArms = generate(PAKO_JUNCTION_VALIDATE, "eval", ["p", "q", "r", "s"]);
assert.ok(evalArms.every(row => training.every(train => train.seed !== row.seed && train.scenario !== row.scenario)));
const model = fitSurfaceResponse(training.flatMap(row => row.rows));
const comparisons = evalArms.map(arm => ({ ...arm, rows: arm.rows.map(row => {
  const horizon = model.find(horizon => horizon.tick === row.input.tick);
  const forecasts = Object.fromEntries(models.map(key => {
    const position = predictSurfaceResponse(horizon, row.input, key);
    return [key, { position, errorM: Math.hypot(...position.map((value, i) => value - row.actual[i])),
      allowanceM: horizon.calibrationM[key] }];
  }));
  return { ...row, forecasts };
}) }));
const rows = comparisons.flatMap(arm => arm.rows);
const tables = model.map(({ tick }) => {
  const sample = rows.filter(row => row.input.tick === tick);
  assert.ok(sample.length > 0);
  return { seconds: tick / 60, n: sample.length, retainedOf: comparisons.length,
    ...Object.fromEntries(models.map(key => [key, {
      meanM: sample.reduce((sum, row) => sum + row.forecasts[key].errorM, 0) / sample.length,
      withinTraining90Pct: sample.filter(row => row.forecasts[key].errorM <= row.forecasts[key].allowanceM).length / sample.length,
    }])) };
});
const captured = [0, 1].map(index => comparisons.filter(arm => arm.seed.endsWith("-p"))
  .filter(arm => arm.scenario === PAKO_JUNCTION_VALIDATE[index]));
for (const group of captured) {
  const left = group.find(arm => arm.branch === "alternate-early").rows.at(-1);
  const right = group.find(arm => arm.branch === "brake").rows.at(-1);
  assert.ok(left.input.tick === right.input.tick && left.input.conditioned.some((x, i) =>
    x !== right.input.conditioned[i]), "The intended ego branch must reach the conditional model");
}
const means = Object.fromEntries(models.map(key => [key, rows.reduce((s, row) => s + row.forecasts[key].errorM, 0) / rows.length]));
const result = { schema: "pako-conditioned-development-v1", trainingCount: training.length, validationCount: evalArms.length,
  means, tables, model, comparisons, training };
const novel = comparisons.filter(arm => novelIds.includes(arm.branch)).flatMap(arm => arm.rows);
result.novelControlMeanM = Object.fromEntries(models.map(key =>
  [key, novel.reduce((sum, row) => sum + row.forecasts[key].errorM, 0) / novel.length]));
writeFileSync(join(output, "conditioned-forecast.json"), JSON.stringify(result, null, 2), { flag: "wx" });
const grouped = new Map();
for (const row of comparisons) {
  if (row.rows.length < 2) continue;
  const name = row.seed.replaceAll("-", " ");
  if (!grouped.has(name)) grouped.set(name, []);
  grouped.get(name).push({ name: row.branch.replaceAll("-", " "),
    actual: row.rows.map(row => [row.input.tick / 60, ...row.actual]),
    predicted: row.rows.map(row => [row.input.tick / 60, ...row.forecasts.conditioned.position]) });
}
writeFileSync(join(output, "forecast-overlay.json"), JSON.stringify({ schema: "pako-forecast-comparison-v1",
  cases: [...grouped].filter(([, branches]) => branches.length > 1).map(([name, branches]) => ({ name, branches })) }),
{ flag: "wx" });
console.log(JSON.stringify({ trainingArms: training.length, validationArms: evalArms.length, means,
  unseenControls: result.novelControlMeanM, tables }));
