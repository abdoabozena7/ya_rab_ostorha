import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PATROL_TRAFFIC_PREVIEW } from "../src/core/pursuit-gta.js";
import { resetPursuitEpisode } from "../src/rl/pursuit-rollouts.js";
import { freezePursuitPolicy } from "../src/rl/pursuit-ppo.js";
import { CLEARANCE_ROUTE_OBSERVATION_SCHEMA as schema } from "../src/rl/gta-pursuit-env.js";

const output = process.env.PROVE_IT_OUTPUT_DIR;
assert.ok(output);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
async function read(path, sha) {
  const bytes = await readFile(new URL(path, import.meta.url));
  assert.equal(hash(bytes), sha);
  return JSON.parse(bytes);
}
const history = await read("../.runtime-proof/pursuit-rl-threat-development-20261121/retention-20261121-054914/retention.json",
  "76a6c7d09cb78f4b9efb70fcf863541b0f4be300d1d5d9f492c177dbc259aad3");
const retained = await read("../.runtime-proof/pursuit-rl-patrol-traffic-20261121/retention/runs/retention/20261121T044237-4572f57970/patrol-retention.json",
  "859ab566ff4dc04574539aa6e57eb774d38f5d9b791814b15ffd42a58860c065");
const frozen = freezePursuitPolicy(await read(
  "../.runtime-proof/pursuit-rl-dense-learning-20261120/corrective-trial-20261120-221352/checkpoint-1.json",
  "854b284350457717cd2c299a0dc86604f2600ed989c1c9aac7ff497d0e5181e3"));
const horizon = 2400;
const report = { scope: "full-density Metro prefixes; no tuning or held-out cases", horizon,
  runtime: process.version, v8: process.versions.v8, cases: [] };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const pose = ({ x, z, heading, speed }) => [x, z, heading, speed];
const visible = obs => {
  const { rays, scales } = schema, result = [];
  for (let i = -3; i <= 3; i++) {
    const at = rays.offset + (i + rays.count) % rays.count * rays.stride;
    const ray = obs.subarray(at, at + rays.stride);
    const kind = ray.findIndex((x, j) => x && j > 0);
    if (kind > 0) result.push([i * 5, ray[0] * scales.rayM, rays.fields[kind]]);
  }
  return result;
};

function trial(entry, profile, requested) {
  const [traffic, pedestrians] = entry.level === 3 ? [36, 80] : [96, 144];
  const { env, initial } = resetPursuitEpisode({ traffic, pedestrians, observation: schema.version,
    wantedLevel: entry.level, wantedLevelMax: entry.level, patrols: entry.level === 3 ? 7 : 12,
    episodeSeconds: 120, patrolTrafficPreview: profile }, entry.seed);
  const { world } = env, { pursuit, player } = world;
  const original = new Map(world.actors.filter(a => a !== player && !pursuit.patrols.has(a)).map(a => [a, [a.id, a.type]]));
  assert.equal(original.size, traffic + pedestrians);
  let firstYield = null, roadDenials = 0, qualifiedAt = null, obs = initial.obs;
  const worldStep = world.step.bind(world), ticks = [], decisions = [], incidents = [];
  world.step = () => {
    worldStep();
    if (pursuit.appliedCommand?.reason === "road-boundary") roadDenials++;
    if (pursuit.response.dispatch.escapeEligible) qualifiedAt ??= world.tick;
    const units = [...pursuit.patrols];
    if (!firstYield) for (const unit of units) {
      if (unit.reason === "traffic-yield" && unit.speed < unit.previous.speed) {
        firstYield = { tick: world.tick, unit: unit.id, blocker: unit.blockedBy, speedMps: unit.speed };
        break;
      }
    }
    ticks.push({ tick: world.tick, ego: pose(player),
      patrol: hash(JSON.stringify(units.map(unit => [unit.id, ...pose(unit)]))),
      ambient: hash(JSON.stringify([...original.keys()].map(pose))),
      denial: pursuit.appliedCommand?.reason === "road-boundary" });
  };
  while (world.tick < horizon && pursuit.phase === "running") {
    const tick = world.tick, predicted = frozen.action(obs), action = requested ? requested[decisions.length].action : predicted;
    const front = visible(obs);
    const sha = hash(Buffer.from(obs.buffer, obs.byteOffset, obs.byteLength));
    const result = env.step(action);
    const { info } = result;
    const present = new Set(world.actors.filter(actor => actor !== player && !pursuit.patrols.has(actor)));
    assert.equal(present.size, original.size);
    for (const actor of present) assert.deepEqual(original.get(actor), [actor.id, actor.type], "Retain each ambient body");
    decisions.push({ tick, action, predicted, observation: sha, front, guard: info.shield.reason,
      applied: info.appliedCommand, accepted: pose(player), tracked: pursuit.response.dispatch.state });
    incidents.push(...info.events.filter(event => ["near_miss", "ambient_collision", "patrol_collision", "static_or_civilian_hit"]
      .includes(event.type)));
    obs = result.obs;
  }
  return { firstYield, decisions, ticks, incidents, roadDenials, qualifiedAt, progressM: player.distance,
    phase: pursuit.phase, endTick: world.tick };
}

function firstDiff(a, b, field) {
  const i = a.findIndex((row, j) => b[j] && !same(row[field], b[j][field]));
  return i < 0 ? null : { tick: a[i].tick, baseline: a[i][field], preview: b[i][field] };
}

function compare(baseline, other) {
  const limits = {};
  for (const field of ["patrol", "ambient", "ego"]) limits[field] = firstDiff(baseline.ticks, other.ticks, field);
  for (const field of ["observation", "action", "guard", "applied"]) limits[field] = firstDiff(baseline.decisions, other.decisions, field);
  return limits;
}

for (const index of [0, 2]) {
  const known = history.arms[index];
  const baseline = trial(known), learned = trial(known, PATROL_TRAFFIC_PREVIEW);
  const fixed = trial(known, PATROL_TRAFFIC_PREVIEW, baseline.decisions);
  const { firstYield } = retained.cases[index].preview;
  assert.deepEqual(learned.firstYield, { tick: firstYield.tick, unit: firstYield.id,
    blocker: firstYield.blocker, speedMps: firstYield.speedMps });
  assert.deepEqual(fixed.firstYield, learned.firstYield);
  const exact = known.after.trace.filter(row => row.tick > 0 && row.tick <= baseline.endTick).every(row =>
    same(baseline.ticks[row.tick - 1].ego, [row.x, row.z, row.heading, row.speed]));
  assert.ok(exact && baseline.firstYield === null, "Unversioned baseline poses must remain exact");
  assert.ok(fixed.decisions.every((row, i) => same(row.action, baseline.decisions[i].action)));
  const closedLoop = compare(baseline, learned), fixedRequest = compare(baseline, fixed);
  assert.ok(closedLoop.patrol && closedLoop.observation && closedLoop.action && closedLoop.ego && !fixedRequest.action);
  const small = ({ decisions, ticks, ...arm }) => ({ ...arm, snapshots: decisions.filter(row =>
    row.tick <= 120 || row.tick % 30 === 0 ||
    [closedLoop.guard?.tick, closedLoop.ego.tick, fixedRequest.guard?.tick, fixedRequest.ego?.tick]
      .some(tick => Math.abs(row.tick - tick) < 18)),
    firstRoadDenial: ticks.find(row => row.denial)?.tick ?? null });
  const brief = { level: known.level, seed: known.seed, closedLoop, fixedRequest };
  report.cases.push({ ...brief, baseline: small(baseline), learned: small(learned), fixed: small(fixed) });
  console.log(JSON.stringify({ ...brief,
    endpoints: [baseline, learned, fixed].map(row => [row.endTick, row.progressM, row.roadDenials,
      row.qualifiedAt, row.incidents.filter(event => event.type !== "near_miss").length]) }));
}
report.arms = report.cases.length * 3;
report.historyExact = true;
report.sameRequestsExact = true;
await writeFile(join(output, "patrol-divergence.json"), JSON.stringify(report), { flag: "wx" });
