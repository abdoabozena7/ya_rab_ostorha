import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { clamp } from "../src/core/config.js";
import { planDistrictRoute } from "../src/core/district-navigation.js";
import { districtRoadPose } from "../src/core/egypt-district.js";
import { angleDelta, bodyOnRoad, distance, overlaps } from "../src/core/geometry.js";
import { PURSUIT_STOP } from "../src/core/pursuit-controls.js";
import { SpatialIndex } from "../src/core/spatial-index.js";
import { CLEAN_ESCAPE_REWARD, GtaPursuitEnv } from "../src/rl/gta-pursuit-env.js";
import { measureConnectedEndpoint } from "../src/rl/pako-curve-observation.js";
import { applyFrozenDispatchAction } from "../src/rl/pursuit-controller.js";
import { freezePursuitPolicy } from "../src/rl/pursuit-ppo.js";
import { dispatchRouteGuide } from "../src/rl/pursuit-route-context.js";
import { PursuitScanner } from "../src/signal_processing/pursuit-scanner.js";
import { followConnectedReference, makeParallelPath } from "./pako-reference-route.mjs";

const bytes = readFileSync(new URL(
  "../.runtime-proof/pursuit-rl-dense-learning-20261120/corrective-trial-20261120-221352/checkpoint-1.json",
  import.meta.url));
const sha256 = createHash("sha256").update(bytes).digest("hex");
assert.equal(sha256, "854b284350457717cd2c299a0dc86604f2600ed989c1c9aac7ff497d0e5181e3");
const policy = freezePursuitPolicy(JSON.parse(bytes));

export function runReverseTrial({ name, evasion, boxed = false, takeover = false, reference = false, laneOffsetM = null, effort = .55,
  seed = "pako-frozen-reverse-transfer-01", frontGapM = 3.15, onward = null, terminalRun = false, motor = null }) {
  const windowTicks = terminalRun ? 7200 : 900;
  const scenario = boxed ? "L07-blocked" : "L07";
  const env = new GtaPursuitEnv();
  const initial = env.reset({ seed, scenario, traffic: 0, pedestrians: 0,
    observation: policy.observation, shield: true, ...(motor && { rewardProfile: CLEAN_ESCAPE_REWARD }),
    config: { ruleset: "dispatch-v1", maxActivePatrols: 1, wantedLevelMax: 1 } });
  const { world } = env, { player, pursuit } = world, [patrol] = pursuit.patrols;
  const { roadId, exitRoadId, barrierId } = initial.info.scenario;
  const entry = world.drivingRoads.find(road => road.id === roadId);
  const exit = world.drivingRoads.find(road => road.id === exitRoadId);
  const station = terminalRun && world.drivingRoads.find(road => road.id === "station-avenue");
  const front = world.statics.find(body => body.id === barrierId);
  const solid = [...world.statics];
  const start = { x: player.x, z: player.z, heading: player.heading };
  front.x = start.x + frontGapM;
  assert.ok(bodyOnRoad(front, [entry], 0) && !overlaps(player, front, .1));
  world.staticIndex = new SpatialIndex(world.statics);
  pursuit.gta.scanner = new PursuitScanner();
  pursuit.gta.scan = pursuit.gta.scanner.sample(world);

  const prefix = createHash("sha256"), positions = createHash("sha256");
  const motion = [], rewardTerms = { progress: 0, time: 0, instability: 0, safety: 0, capture: 0, outcome: 0 };
  let switchAt = null, path = null, cursor = 0, activeDecision = null, acceptedMotorDecisions = 0;
  const forwardReference = { observation: policy.observation, action: () => {
    const aligned = Math.abs(angleDelta(0, player.heading)) < .35;
    if (terminalRun && !switchAt && aligned && player.speed > .25 &&
        player.z - entry.fixed >= 14 && bodyOnRoad(player, [exit])) {
      if (onward) {
        let mapped;
        if (onward.side) mapped = makeParallelPath(world.district, player, exit, station, onward.side);
        else {
          const road = world.district.drivingRoads.find(road => road.id === onward.roadId);
          const publicGoal = { ...districtRoadPose(road, onward.along, 1), roadId: road.id };
          mapped = planDistrictRoute(world.district, player, publicGoal);
        }
        if (mapped.length >= 3) path = Object.freeze(mapped.map(Object.freeze));
      }
      switchAt = { tick: world.tick, pathAdmitted: !!path, ego: [player.x, player.z, player.heading, player.speed] };
    }
    if (path) {
      const result = followConnectedReference(player, path, cursor);
      cursor = result.cursor;
      if (!motor) return result.action;
      const obs = measureConnectedEndpoint(world, path);
      const choice = motor(obs, result.action);
      activeDecision = { ...choice, tick: world.tick, obs, reward: 0 };
      motion.push(activeDecision);
      return choice.action;
    }
    if (switchAt && onward) return PURSUIT_STOP;
    const desired = laneOffsetM === null || !aligned ? 0 :
      Math.atan2(exit.fixed + laneOffsetM - player.x, 5 + Math.max(0, player.speed) * .35);
    return { gear: 1, brake: 0, throttle: aligned ? effort : .55,
      steer: aligned ? clamp(1.5 * angleDelta(desired, player.heading), -.72, .72) : 0 };
  } };
  const driver = { status: "active", policy: reference ? forwardReference : policy,
    sha256: reference ? null : sha256, decisions: 0,
    lastTick: -1, evasion };
  const contacts = [], ambientContacts = [], trace = [], maneuvers = new Set();
  let setbackM = 0, yaw = 0, entryState = null, denied = 0, lost = false, stoppedAt = null;
  let minPatrolGapM = Infinity, lastMotionAt = null;
  for (let i = 0; i < windowTicks && pursuit.phase === "running"; i++) {
    lost ||= !pursuit.patrols.has(patrol) || patrol.health <= 0 || !world.actors.includes(patrol);
    if (takeover && setbackM >= .22 && stoppedAt === null) {
      stoppedAt = world.tick;
      driver.status = "manual";
      world.command({ type: "pursuit-drive", action: PURSUIT_STOP }, false);
    } else applyFrozenDispatchAction(world, driver);
    const { requested, submitted, planner, shieldReason } = driver.lastDecision ?? {};
    const scan = world.tick % 6 === 0 ? {
      tick: pursuit.gta.scan.tick,
      actors: pursuit.gta.scan.tracks.filter(track => track.kind !== "static"),
    } : null;
    for (const candidate of planner?.candidates ?? []) if (candidate.selected) maneuvers.add(candidate.name);
    const beforeSteer = player.steer, beforeDistance = player.distance, hadEntered = Boolean(entryState);
    world.step();
    if (motor) {
      for (const key of Object.keys(rewardTerms)) rewardTerms[key] = 0;
      env.scoreDispatchTick(rewardTerms, beforeSteer, pursuit.stepEvents);
      if (activeDecision) {
        activeDecision.reward += Object.values(rewardTerms).reduce((sum, value) => sum + value, 0);
        if (activeDecision.tick === world.tick - 1 && hadEntered && player.distance > beforeDistance && player.speed > .25 &&
            requested.gear === 1 && requested.throttle > 0 && !shieldReason &&
            JSON.stringify(requested) === JSON.stringify(submitted))
          acceptedMotorDecisions++;
      }
    }
    lost ||= pursuit.phase === "running" && (!pursuit.patrols.has(patrol) || !world.actors.includes(patrol)) || patrol.health <= 0;
    denied += Number(pursuit.metrics.guard === "road-boundary");
    if (!terminalRun || !entryState) {
      setbackM = Math.max(setbackM, start.x - player.x);
      if (player.speed < -.04) yaw = Math.max(yaw, Math.abs(angleDelta(player.heading, start.heading)));
    }
    if (!entryState && player.z - entry.fixed >= 16 && player.speed > .25 && bodyOnRoad(player, [exit]))
      entryState = { tick: world.tick, distanceM: player.distance };
    const fresh = pursuit.stepEvents.filter(event => event.fresh &&
      (event.type === "patrol_collision" || event.type === "static_or_civilian_hit"));
    contacts.push(...fresh);
    ambientContacts.push(...pursuit.stepEvents.filter(event => event.type === "ambient_collision"));
    assert.ok(solid.every(body => world.statics.includes(body)));
    const ego = [player.x, player.z, player.heading, player.speed], tail = [patrol.x, patrol.z, patrol.speed];
    minPatrolGapM = Math.min(minPatrolGapM, distance(player, patrol));
    if (Math.abs(player.speed) >= .25) lastMotionAt = world.tick;
    if (terminalRun) {
      const accepted = JSON.stringify([world.tick, ego, tail]);
      if (!switchAt) prefix.update(accepted);
      positions.update(accepted);
    }
    if (scan || fresh.length || pursuit.phase !== "running") trace.push({ tick: world.tick, ego, tail,
      requested, submitted, shieldReason, planner,
      observed: scan,
      route: dispatchRouteGuide(world, policy.observation)?.id ?? null,
      ...(terminalRun && { tracking: pursuit.response.dispatch.state, patrolState: patrol.aiState }),
      acceptedCommand: pursuit.appliedCommand, guard: pursuit.metrics.guard });
  }
  const distanceAfterEntry = entryState ? player.distance - entryState.distanceM : 0;
  const qualified = pursuit.response.dispatch.escapeEligible;
  const outcome = terminalRun ? pursuit.phase === "escaped" && qualified : world.tick === windowTicks;
  const passed = Boolean(outcome && setbackM >= 5 && yaw >= 1.1 && entryState &&
    distanceAfterEntry >= 10 && patrol.distance >= 7 && !denied && !lost && !contacts.length && !ambientContacts.length);
  const summary = { name, scenario, evasion, reference, laneOffsetM, effort, status: driver.status, decisions: driver.decisions, phase: pursuit.phase,
    ticks: world.tick, passed, entryState, setbackM, yaw, distanceAfterEntry, denied, lost, patrolM: patrol.distance,
    stoppedAt, maneuvers: [...maneuvers], contacts, ambientContacts, trace,
    ...(terminalRun && { seed, frontGapM, qualified, switchAt, onward, path, prefix: prefix.digest("hex"),
      positions: positions.digest("hex"), lastMotionAt, minPatrolGapM, ...(motor && { acceptedMotorDecisions }) }) };
  if (!motor) return summary;
  return { summary, motion, lastObservation: path && summary.phase === "timeout" ? measureConnectedEndpoint(world, path) : null };
}

function checkTerminalReferences(output) {
  const windowTicks = 7200;
  const run = options => runReverseTrial({ ...options, terminalRun: true });
  const starts = [
    { seed: "pako-frozen-reverse-transfer-01", frontGapM: 3.15 },
    { seed: "pako-fit-reverse-terminal-02", frontGapM: 3.08 },
  ];
  const cases = starts.map(start => {
    const routes = [
      { name: "continue-straight" },
      { name: "civic-north", onward: { roadId: "civic-avenue", along: 76 } },
      { name: "station-to-corniche", onward: { roadId: "corniche-avenue", along: 76 } },
      { name: "station-to-gateway", onward: { roadId: "gateway-avenue", along: 64 } },
      { name: "civic-parallel-east", onward: { side: 1 } },
      { name: "civic-parallel-west", onward: { side: -1 } },
    ].map(route => run({ ...start, ...route, evasion: true, reference: true }));
    const controls = [run({ ...start, name: "exact-frozen", evasion: true }),
      run({ ...start, name: "boxed", boxed: true, evasion: true, reference: true })];
    const sharedApproach = routes.every(row => row.switchAt?.tick === routes[0].switchAt?.tick && row.prefix === routes[0].prefix);
    const candidates = routes.filter(row => row.passed && row.switchAt?.pathAdmitted);
    const valid = sharedApproach && candidates.length > 0 && controls.every(row => !row.passed) &&
      !controls[1].entryState && controls[1].setbackM < .25;
    for (const { name, switchAt, phase, qualified, entryState, setbackM, yaw, ticks, lastMotionAt, distanceAfterEntry,
      patrolM, lost, denied, contacts, passed } of [...routes, ...controls])
      console.log(JSON.stringify({ start, name, switchAt, phase, qualified, entryState, setbackM, yaw, ticks, lastMotionAt,
        distanceAfterEntry, patrolM, lost, denied, firstContact: contacts[0]?.tick, hits: contacts.length, passed }));
    return { start, routes, controls, sharedApproach, valid };
  });
  const qualifiedStarts = cases.filter(row => row.valid).length, passed = qualifiedStarts === starts.length;
  writeFileSync(join(output, "reverse-terminal.json"), JSON.stringify({ passed, qualifiedStarts, windowTicks, sha256,
    scope: "Scripted post-reverse full Metro references, with exact frozen and boxed controls. Not evaluated as learned.", cases },
  null, 2) + "\n", { flag: "wx" });
  assert.ok(passed, "Neither a turn label nor the original short reverse window qualifies as a game escape");
}

function checkFrozenReverse(output) {
  const windowTicks = 900;
  const arms = [
    { name: "guard-only", evasion: false },
    { name: "bounded-v1", evasion: true },
    { name: "blocked", evasion: true, boxed: true },
    { name: "takeover", evasion: true, takeover: true },
    { name: "scripted-reference", evasion: true, reference: true },
  ].map(runReverseTrial);
  const feasibility = process.argv.includes("--feasibility") ? [-4.1, -2.5, 0, 2.5, 4.1].flatMap(laneOffsetM =>
    [.55, .9].map(effort => runReverseTrial({ name: `lane-${laneOffsetM}-effort-${effort}`, evasion: true,
      reference: true, laneOffsetM, effort }))) : [];
  const [guardOnly, candidate, boxed, takeover] = arms;
  const learnedForward = candidate.trace.filter(row => candidate.entryState && row.tick > candidate.entryState.tick && row.ego[3] > .25 &&
    row.planner == null && row.requested?.throttle > 0 &&
    JSON.stringify(row.requested) === JSON.stringify(row.submitted)).length;
  const passed = candidate.passed && learnedForward >= 20 && !guardOnly.passed &&
    !boxed.passed && boxed.setbackM < .25 && !boxed.contacts.length && takeover.stoppedAt != null &&
    !takeover.entryState && takeover.trace.filter(row => row.tick > takeover.stoppedAt + 6)
      .every(row => row.acceptedCommand.targetSpeed === 0);
  const report = { scope: "Controlled local Metro reverse course, not general Max or release proof",
    sha256, node: process.version, windowTicks, learnedForward, passed, arms, feasibility };
  writeFileSync(join(output, "frozen-reverse.json"), JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  for (const { trace: _trace, ...row } of [...arms, ...feasibility]) console.log(JSON.stringify(row));
  assert.ok(passed, "The real frozen driver did not back out, turn and continue cleanly on the connected road");
}

if (fileURLToPath(import.meta.url).toLowerCase() === process.argv[1]?.toLowerCase()) {
  const output = process.env.PROVE_IT_OUTPUT_DIR;
  assert.ok(output);
  if (process.argv.includes("--terminal")) checkTerminalReferences(output);
  else checkFrozenReverse(output);
}
