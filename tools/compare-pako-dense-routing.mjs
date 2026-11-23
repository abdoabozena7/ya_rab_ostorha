import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { clamp } from "../src/core/config.js";
import { districtRoadPose } from "../src/core/egypt-district.js";
import { angleDelta, bodyOnRoad, distance } from "../src/core/geometry.js";
import { planDistrictRoute } from "../src/core/district-navigation.js";
import { freezePursuitPolicy } from "../src/rl/pursuit-ppo.js";
import { isDispatchIncident, resetPursuitEpisode } from "../src/rl/pursuit-rollouts.js";
import { getDispatchObservation } from "../src/rl/gta-pursuit-env.js";
import { MEASURED_QUEUE_CORRIDOR, MEASURED_QUEUE_DETOUR } from "../src/rl/pako-measured-detour.js";
import { CLEARANCE_CORRIDOR, dispatchRouteGuide } from "../src/rl/pursuit-route-context.js";

const output = process.env.PROVE_IT_OUTPUT_DIR;
assert.ok(output, "Run through the sealed collector or set a fresh PROVE_IT_OUTPUT_DIR");
const read = path => readFileSync(new URL(path, import.meta.url));
const bytes = read("../.runtime-proof/pursuit-rl-dense-learning-20261120/corrective-trial-20261120-221352/checkpoint-1.json");
const checkpoint = createHash("sha256").update(bytes).digest("hex");
assert.equal(checkpoint, "854b284350457717cd2c299a0dc86604f2600ed989c1c9aac7ff497d0e5181e3");
const historical = JSON.parse(read("../.runtime-proof/pako-queue-learning-20261121/current-dense-preservation-01/current-dense.json"));
const early = JSON.parse(read("../.runtime-proof/pako-chase-safety-20261121/queue-early-east-lane.json"));
const curriculum = JSON.parse(read("../config/pursuit-rl-city-route-development.json"));
const policy = freezePursuitPolicy(JSON.parse(bytes));
const denseSeed = "city-route-dev-eval-01";
const dense = { ...curriculum.stages.find(s => s.id === "city-clearance-dense"), episodeSeconds: 120 };
assert.equal(early.seed, denseSeed);
const write = (name, value) => writeFileSync(join(output, name), value, { flag: "wx" });

function run(arm, stage = dense, seed = denseSeed) {
  assert.ok(curriculum.validationSeeds.includes(seed) && !curriculum.trainingSeeds.includes(seed));
  assert.equal(stage.observation, policy.observation);
  const queueDetour = arm === "passing-corridor" ? MEASURED_QUEUE_CORRIDOR
    : arm === "measured-detour" ? MEASURED_QUEUE_DETOUR : undefined;
  const { env } = resetPursuitEpisode({ ...stage, queueDetour }, seed);
  const { world } = env, { player, pursuit } = world;
  const road = id => world.drivingRoads.find(r => r.id === id);
  const civic = road("civic-avenue");
  const routeMode = arm === "corridor" ? CLEARANCE_CORRIDOR : undefined;
  const beforeGuideMs = performance.now();
  const guide = dispatchRouteGuide(world, policy.observation, routeMode);
  const routeMs = performance.now() - beforeGuideMs;
  const publicGuide = guide && { id: guide.id, path: guide.path, earliestM: guide.earliestM, lengthM: guide.lengthM };
  const endpoint = guide.path.at(-1);
  const ambient = world.actors.filter(actor => actor !== player && !pursuit.patrols.has(actor));
  assert.deepEqual(["vehicle", "pedestrian"].map(type => ambient.filter(a => a.type === type).length),
    [stage.traffic, stage.pedestrians]);
  const ids = [], changes = [];
  function route(roadId, along, direction) {
    const goal = { ...districtRoadPose(road(roadId), along, direction), roadId };
    const path = planDistrictRoute(world.district, player, goal);
    changes.push({ tick: world.tick, kind: "public-guide", goal, connected: path.length > 20 });
    if (path.length > 20) {
      // Diagnostic only: substitute map cues, not simulator state or live actors.
      guide.path = path;
      return true;
    }
    return false;
  }
  if (arm === "outer-route") route("corniche-avenue", 74, 1);
  const queueArm = ["queue-only", "queue-plus-exit", "lane-return"].includes(arm);
  let bypassStarted = null, bypassEnded = null, extended = false, crossedQueue = null;
  let returnStarted = null, returned = null;
  let activePatrolMax = 0, firstMissing = null, eligibleAt = null, lastTrackedAt = null;
  let sustainedFrom = null, roadDenials = 0;
  const queuePhases = {};
  let returnCause = null;
  const digest = createHash("sha256"), decisions = [], contacts = [];
  const advance = world.step.bind(world);
  world.step = () => {
    advance();
    roadDenials += Number(pursuit.metrics.guard === "road-boundary");
  };
  const started = performance.now();
  while (pursuit.phase === "running") {
    const original = policy.action(routeMode ? getDispatchObservation(world, policy.observation, routeMode) : env.getObservation());
    let action = original;
    if (queueArm) {
      if (!bypassStarted && world.tick === early.branch.pose[0] && bodyOnRoad(player, [civic])) {
        const pose = [world.tick, player.x, player.z, player.speed, player.heading];
        assert.deepEqual(pose, early.branch.pose);
        bypassStarted = world.tick;
        changes.push({ tick: world.tick, kind: "start-known-bypass" });
      }
      if (bypassStarted !== null && bypassEnded === null) {
        if (arm === "lane-return" && returnStarted === null && player.z > 4) {
          const scan = pursuit.gta.scan;
          const home = civic.fixed - civic.laneOffsetM;
          const lane = scan.tracks.filter(track => track.kind !== "static" &&
            Math.abs(track.observedXM - home) < 1.85);
          if (scan.tick === world.tick && lane.some(track => track.kind === "civilian" &&
              track.ageS === 0 && track.observedZM < player.z - 3) &&
              !lane.some(track => track.observedZM >= player.z - 3 && track.observedZM < player.z + 9)) {
            returnStarted = world.tick;
            changes.push({ tick: world.tick, kind: "measured-return-begin", tracks: lane });
          }
        }
        const returning = returnStarted !== null;
        const laneError = civic.fixed - civic.laneOffsetM - player.x;
        if (returning && Math.abs(laneError) <= .35 && Math.abs(angleDelta(player.heading, 0)) <= .13) {
          returned = world.tick;
          bypassEnded = world.tick;
        } else if ((!returning && player.z > 12) || world.tick - bypassStarted > (returning ? 1260 : 840)) {
          bypassEnded = world.tick;
        } else {
          const laneTarget = returning ? civic.fixed - civic.laneOffsetM : civic.fixed + 2.25;
          action = { gear: 1,
            steer: clamp(1.6 * angleDelta(Math.atan2(laneTarget - player.x, 6), player.heading), -.9, .9),
            brake: player.speed > 3.4 ? .75 : 0, throttle: player.speed < 3.15 ? .65 : 0 };
        }
      }
      if (bypassStarted !== null && player.z > 4) crossedQueue ??= world.tick;
      if (arm === "queue-plus-exit" && bypassEnded !== null && !extended && distance(player, endpoint) < 13) {
        extended = true;
        if (route("university-avenue", -236, -1)) action = policy.action(env.getObservation());
      }
    }
    const { info } = env.step(action);
    const queue = info.planner?.queue;
    if (queue?.phase && !Object.hasOwn(queuePhases, queue.phase)) queuePhases[queue.phase] = world.tick;
    if (queue?.phase === "returned") returnCause = queue.returnCause;
    const pose = [world.tick, player.x, player.z, player.heading, player.speed];
    digest.update(JSON.stringify(pose));
    contacts.push(...info.events.filter(isDispatchIncident));
    activePatrolMax = Math.max(activePatrolMax, pursuit.patrols.size);
    if (firstMissing === null) {
      const missing = ambient.filter(a => !world.actors.includes(a));
      if (missing.length) {
        firstMissing = world.tick;
        ids.push(...missing.map(a => a.id));
      }
    }
    const response = pursuit.response;
    if (response.dispatch.escapeEligible) eligibleAt ??= world.tick;
    lastTrackedAt = response.dispatch.lastReportTick;
    sustainedFrom = response.clearAtTick;
    decisions.push({ pose, action, original, applied: info.appliedCommand, shield: info.shield.reason,
      guard: pursuit.metrics.guard, state: response.dispatch.state, eligible: response.dispatch.escapeEligible,
      sustainedFrom, clearProgress: response.clearProgress, lastTrackedAt, ...(queue && { queue }) });
  }
  const egoContacts = contacts.filter(e => e.type === "patrol_collision" || e.type === "static_or_civilian_hit");
  const ambientPedestrian = contacts.filter(e => e.type === "ambient_collision" &&
    (e.first.type === "pedestrian" || e.second.type === "pedestrian")).length;
  const row = { arm, seed, stage: stage.id, phase: pursuit.phase, ticks: world.tick, collisions: pursuit.metrics.collisions,
    egoContacts: egoContacts.length, ambientPedestrian, eligibleAt, activePatrolMax, firstMissing, ids, roadDenials,
    sustainedFrom, lastTrackedAt, crossedQueue, bypassStarted, bypassEnded, returnStarted, returned, changes, queuePhases,
    returnCause,
    end: decisions.at(-1), wallSeconds: (performance.now() - started) / 1000,
    motionSha256: digest.digest("hex"), publicGuide, routeMs };
  write(`${stage.id}-${arm}.jsonl`, [...decisions.map(frame => JSON.stringify({ type: "decision", ...frame })),
    ...contacts.map(event => JSON.stringify({ type: "incident", event }))].join("\n") + "\n");
  console.log(JSON.stringify({ ...row, publicGuide: publicGuide && { ...publicGuide, path: undefined } }));
  return row;
}

const reproduced = row => ["phase", "ticks", "collisions", "ambientPedestrian", "motionSha256"]
  .every(key => row[key] === historical.actual[key]);
const clean = row => row.phase === "escaped" && row.eligibleAt !== null &&
  row.egoContacts === 0 && row.collisions === 0 && row.roadDenials === 0 && row.firstMissing === null;
const wins = (row, baseline) => clean(row) && row.ambientPedestrian <= baseline.ambientPedestrian;
if (process.argv.includes("--lane-return")) {
  const witness = run("lane-return");
  const pass = witness.returned !== null && wins(witness, historical.actual);
  write("comparison.json", JSON.stringify({ scope: "development maneuver, not learning or release",
    checkpoint, pass, witness }, null, 2) + "\n");
  assert.ok(pass, "The measured lane return did not meet the unchanged full-episode oracle");
} else if (process.argv.includes("--corridor") || process.argv.includes("--measured-detour") ||
    process.argv.includes("--passing-corridor") ||
    process.argv.includes("--detour-transfer")) {
  const standard = { ...curriculum.stages.find(s => s.id === "city-clearance"), episodeSeconds: 120 };
  const transfer = process.argv.includes("--detour-transfer");
  const arm = process.argv.includes("--corridor") ? "corridor"
    : process.argv.includes("--passing-corridor") ? "passing-corridor" : "measured-detour";
  const workload = transfer ? [[standard, "city-route-dev-eval-01"], [dense, "city-route-dev-eval-00"]]
    : [[dense, denseSeed], [standard, "city-route-dev-eval-00"]];
  const pairs = workload.map(([stage, seed]) =>
    ({ stage, seed, baseline: run("baseline", stage, seed), candidate: run(arm, stage, seed) }));
  const [high, mid] = pairs;
  const baselineExact = transfer ? null : reproduced(high.baseline);
  const returnVerified = !transfer && (arm === "corridor" ||
    (high.candidate.returnCause === "lead-behind" && Number.isSafeInteger(high.candidate.queuePhases.returned)));
  const pass = transfer ? pairs.every(pair => clean(pair.baseline) && wins(pair.candidate, pair.baseline))
    : baselineExact && returnVerified && wins(high.candidate, high.baseline) &&
      (!clean(mid.baseline) || wins(mid.candidate, mid.baseline));
  write("comparison.json", JSON.stringify({ scope: "development only; unchanged frozen policy",
    arm, checkpoint, baselineExact, returnVerified, pass, pairs }, null, 2) + "\n");
  assert.ok(pass, "The experimental controller did not meet the unchanged physical transfer criterion");
} else {
  const arms = ["baseline", "queue-only", "queue-plus-exit", "outer-route"].map(arm => run(arm));
  const baselineExact = reproduced(arms[0]);
  const winning = arms.slice(1).filter(row => wins(row, arms[0])).map(row => row.arm);
  const pass = baselineExact && winning.length > 0;
  write("comparison.json", JSON.stringify({ scope: "historical development seed; no learning", seed: denseSeed, stage: dense,
    checkpoint, reproduced: baselineExact, winning, pass, arms }, null, 2) + "\n");
  assert.ok(pass, "No guarded, contact-free, full-window improvement on the exact dense timeout");
}
