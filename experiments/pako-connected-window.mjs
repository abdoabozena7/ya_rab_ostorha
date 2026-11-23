import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { initializeDistrictActor } from "../src/core/district-behavior.js";
import { planDistrictRoute } from "../src/core/district-navigation.js";
import { districtRoadPose } from "../src/core/egypt-district.js";
import { angleDelta, bodyOnRoad, corners, distance, overlaps, sweepSafe } from "../src/core/geometry.js";
import { PURSUIT_STOP } from "../src/core/pursuit-controls.js";
import { createDispatchResponse } from "../src/core/pursuit-dispatch.js";
import { updatePursuitResponse } from "../src/core/pursuit-response.js";
import { SpatialIndex } from "../src/core/spatial-index.js";
import { GtaPursuitEnv } from "../src/rl/gta-pursuit-env.js";
import { freezePursuitPolicy } from "../src/rl/pursuit-ppo.js";
import { requireDispatchScan } from "../src/rl/pursuit-shield.js";
import { PursuitScanner } from "../src/signal_processing/pursuit-scanner.js";
import { followConnectedReference, referenceTune as tune } from "./pako-reference-route.mjs";

export { followConnectedReference };

const out = process.env.PROVE_IT_OUTPUT_DIR;
const priorBytes = readFileSync(new URL(
  "../.runtime-proof/pursuit-rl-dense-learning-20261120/corrective-trial-20261120-221352/checkpoint-1.json", import.meta.url));
const sha256 = input => createHash("sha256").update(input).digest("hex");
const modelSha = sha256(priorBytes);
assert.equal(modelSha, "854b284350457717cd2c299a0dc86604f2600ed989c1c9aac7ff497d0e5181e3");
export const priorCheckpoint = JSON.parse(priorBytes);
export const prior = freezePursuitPolicy(priorCheckpoint);
export const fit = [
  { entry: "station-avenue", start: -206, sign: 1, branch: "civic-avenue", branchSign: 1, lead: -168,
    direct: ["civic-avenue", 76, 1], connected: ["corniche-avenue", 76, 1] },
  { entry: "tahrir-boulevard", start: -159, sign: -1, branch: "civic-avenue", branchSign: 1, lead: -203,
    direct: ["civic-avenue", 76, 1], connected: ["corniche-avenue", 76, 1], approachPath: 0 },
  { entry: "gateway-avenue", start: -48, sign: 1, branch: "souq-collector", branchSign: -1, lead: 23,
    direct: ["gateway-avenue", 76, 1], connected: ["corniche-avenue", 76, 1] },
  { entry: "souq-collector", start: -207, sign: 1, branch: "civic-avenue", branchSign: 1, lead: -165,
    direct: ["civic-avenue", 76, 1], connected: ["gateway-avenue", 76, 1], approachPath: 0 },
  { entry: "civic-avenue", start: -90, sign: 1, branch: "station-avenue", branchSign: -1, lead: -54,
    direct: ["station-avenue", -264, -1], connected: ["corniche-avenue", 76, 1], approachPath: 0 },
];
const maxTicks = 7200, retainTicks = 120, retainTravelM = 10;
const moving = { steer: 0, gear: 1, brake: 0, throttle: .85 };
const alternatives = [
  { arm: "direct", path: 0 }, { arm: "connected", path: 1 },
  { arm: "arc-5.6", path: 1, radius: 5.6 }, { arm: "arc-7", path: 1, radius: 7 },
  { arm: "arc-8.4", path: 1, radius: 8.4 },
];
const specification = { node: process.version, modelSha, maxTicks, retainTicks, retainTravelM, fit,
  scope: "Distinct disposable fit starts on the original Metro roads. Only setup/scoring reads truth.",
  cause: "Tests wider supported turn arcs to preserve speed through the same first junction and its continuation.",
  alternatives, guard: true };
// The staged public destination must be set before the route encoder's first lookup.
class StagedRouteEnv extends GtaPursuitEnv {
  initialized = false;

  getObservation() {
    return this.initialized ? super.getObservation() : null;
  }
}

function stage(site, blocked, { routeCue, index, seed: namedSeed, offsetM = 0, speedMps = 5.7, lateralM = 0,
  rewardProfile, onward, population, civilianCrossingPreview }) {
  const seed = namedSeed ?? `pako-connected-window-fit-01:${site.entry}`;
  const env = routeCue ? new StagedRouteEnv() : new GtaPursuitEnv();
  const { traffic = 0, pedestrians = 0 } = population ?? {};
  env.reset({ seed, traffic, pedestrians, observation: prior.observation, shield: true, rewardProfile,
    config: { ruleset: "dispatch-v1", maxActivePatrols: 1, wantedLevelMax: 1,
      ...(civilianCrossingPreview === undefined ? {} : { civilianCrossingPreview }) } });
  const { world } = env, { pursuit, player } = world, [patrol] = pursuit.patrols;
  const ambient = population && world.actors.filter(actor => actor !== player && !pursuit.patrols.has(actor));
  const roads = id => world.drivingRoads.find(road => road.id === id);
  const entry = roads(site.entry), branch = roads(site.branch);
  const position = site.start + offsetM * site.sign;
  const pose = districtRoadPose(entry, position, site.sign);
  if (lateralM !== 0) {
    pose.x += Math.cos(pose.heading) * lateralM;
    pose.z -= Math.sin(pose.heading) * lateralM;
  }
  Object.assign(player, pose, { speed: speedMps, previous: { ...pose, speed: speedMps } });
  pursuit.playerStart = { ...pose, speed: speedMps };
  const tail = districtRoadPose(entry, position - 22 * site.sign, site.sign);
  Object.assign(patrol, tail, { speed: 4.6, previous: { ...tail, speed: 4.6 } });
  const lead = world.makeVehicle("connected-window-lead", "sedan", districtRoadPose(entry, site.lead, site.sign));
  initializeDistrictActor(world, lead);
  lead.district.loadingUntilTick = maxTicks + 60;
  lead.district.nextLoadingDistanceM = null;
  world.actors.push(lead);
  const bodies = [player, patrol, lead];
  assert.ok(bodies.every((body, i) => bodyOnRoad(body, [entry]) &&
    bodies.slice(0, i).every(other => !overlaps(body, other, .12)) &&
    world.statics.every(other => !overlaps(body, other, .12))));
  const goals = ["direct", "connected"].map(name => {
    const [id, along, sign] = site[name];
    return { ...districtRoadPose(roads(id), along, sign), roadId: id };
  });
  if (routeCue) {
    pursuit.gta.publicRouteGoal = goals[index];
    env.initialized = true;
  }
  const paths = goals.map(goal => planDistrictRoute(world.district, player, goal));
  assert.ok(paths.every(path => path.length > 25), `No admitted mapped route from ${site.entry}`);
  const obstruction = onward?.obstruction;
  const obstructionRoad = obstruction ? roads(obstruction.road) : branch;
  const wall = obstruction ? { ...districtRoadPose(obstructionRoad, obstruction.along, obstruction.sign),
    id: "onward-choice-barrier", type: "static", length: obstruction.length, width: obstruction.width, height: .66 }
    : blocked && { ...districtRoadPose(branch, entry.fixed + 13 * site.branchSign, site.branchSign),
      [branch.axis === "x" ? "z" : "x"]: branch.fixed, id: "connected-window-barrier",
      type: "static", length: 1, width: branch.width - .35, height: .66 };
  if (wall) {
    assert.ok(bodyOnRoad(wall, [obstructionRoad]) && bodies.every(body => !overlaps(body, wall)) &&
      (!obstruction || world.statics.every(body => !overlaps(body, wall))), "Fixture barrier needs a clear supported berth");
    world.statics = [...world.statics, wall];
    world.staticIndex = new SpatialIndex(world.statics);
  }
  if (ambient) for (const body of [...bodies, ...(wall ? [wall] : [])]) {
    const occupant = ambient.find(other => overlaps(body, other, .12));
    if (occupant)
      throw Object.assign(new Error(`Staged ${body.id} has no clear berth near ${occupant.id}; ambient actors were not moved`),
        { code: "OCCUPIED_START" });
  }
  pursuit.response.dispatch = createDispatchResponse();
  pursuit.response.lastSeen = null;
  world.actorIndex = new SpatialIndex(world.actors);
  updatePursuitResponse(world, true);
  pursuit.gta.scanner = new PursuitScanner();
  pursuit.gta.scan = pursuit.gta.scanner.sample(world);
  return { env, world, pursuit, player, patrol, lead, paths, branch, entry, seed, wall, ambient };
}

function branchArc(world, ego, entry, branch, site, path, radius) {
  const incoming = entry.axis, outgoing = branch.axis;
  const siteCenter = districtRoadPose(branch, entry.fixed, site.branchSign);
  const centerline = { [incoming]: siteCenter[incoming], [outgoing]: ego[outgoing] };
  const tangentIn = { ...centerline, [incoming]: centerline[incoming] - site.sign * radius };
  const tangentOut = { ...centerline, [outgoing]: centerline[outgoing] + site.branchSign * radius };
  const center = { ...tangentIn, [outgoing]: tangentIn[outgoing] + site.branchSign * radius };
  const start = { ...ego, [incoming]: ego[incoming] - site.sign * ego.spec.wheelbase / 2 };
  if ((tangentIn[incoming] - start[incoming]) * site.sign < 2) return null;
  const joinAt = path.findIndex((point, index) => index > 0 &&
    Math.abs(point[incoming] - tangentOut[incoming]) < .15 &&
    (point[outgoing] - tangentOut[outgoing]) * site.branchSign >= 3 &&
    Math.abs(angleDelta(Math.atan2(point.x - path[index - 1].x, point.z - path[index - 1].z),
      siteCenter.heading)) < .15);
  if (joinAt < 0) return null;
  const arc = [];
  const line = (a, b) => {
    const n = Math.ceil(distance(a, b) / .35);
    for (let i = 1; i <= n; i++) arc.push({ x: a.x + (b.x - a.x) * i / n, z: a.z + (b.z - a.z) * i / n });
  };
  arc.push({ x: start.x, z: start.z });
  line(start, tangentIn);
  const startAngle = Math.atan2(tangentIn.z - center.z, tangentIn.x - center.x);
  const bend = angleDelta(Math.atan2(tangentOut.z - center.z, tangentOut.x - center.x), startAngle);
  const n = Math.ceil(radius * Math.abs(bend) / .35);
  for (let i = 1; i <= n; i++) {
    const angle = startAngle + bend * i / n;
    arc.push({ x: center.x + radius * Math.cos(angle), z: center.z + radius * Math.sin(angle) });
  }
  line(arc.at(-1), path[joinAt]);
  // Validate only published map geometry; live hazards remain with the range guard.
  let previous = ego;
  for (let i = 1; i < arc.length; i++) {
    const point = arc[i], before = arc[i - 1];
    const pose = { ...ego, ...point, heading: Math.atan2(point.x - before.x, point.z - before.z) };
    if (!sweepSafe(previous, pose, world.district.statics, world.district.roads).safe) return null;
    previous = pose;
  }
  return Object.freeze([...arc, ...path.slice(joinAt + 1)].map(point => Object.freeze(point)));
}

function branchObstruction(scan, ego, path, cursor) {
  const returns = scan.rays.flatMap(({ kind, rangeM }, i) => {
    if (kind !== "static" || rangeM > 30) return [];
    const angle = ego.heading + i * Math.PI * 2 / scan.rays.length;
    return [{ type: "pedestrian", radius: .16, x: ego.x + rangeM * Math.sin(angle),
      z: ego.z + rangeM * Math.cos(angle) }];
  });
  if (!returns.length) return null;
  let along = 0;
  for (let i = cursor + 1; i < path.length && along <= 24; i++) {
    const point = path[i], previous = path[i - 1];
    along += distance(previous, point);
    const heading = Math.atan2(point.x - previous.x, point.z - previous.z);
    const centerAhead = ego.spec.wheelbase / 2;
    const body = { type: ego.type, length: ego.length, width: ego.width, heading,
      x: point.x + Math.sin(heading) * centerAhead, z: point.z + Math.cos(heading) * centerAhead };
    if (returns.some(hit => overlaps(body, hit))) return along;
  }
  return null;
}

export function run(site, choice) {
  const { arm, radius, path: index = 1, demonstrate = false, choose, sample = false, routeCue = false,
    replaceWithReference = null, observe = null, rewardAdjustment = null, recordReward = false, onward } = choice;
  const blocked = arm === "blocked" || arm === "blocked-old";
  const { env, world, pursuit, player, patrol, lead, paths, branch, entry, seed, wall, ambient } =
    stage(site, blocked, { ...choice, index });
  const base = paths[radius || blocked ? site.approachPath ?? index : index];
  const options = onward && Object.freeze(paths.map(path => Object.freeze(path.map(Object.freeze))));
  let path = onward ? options[0] : radius ? branchArc(world, player, entry, branch, site, base, radius) :
    observe ? Object.freeze(base.map(point => Object.freeze(point))) : base;
  if (!path) return { arm, seed, entry: site.entry, full: false, skipped: "unsupported static geometry" };
  const traces = [], contacts = [], ambientContacts = [], guardReasons = {}, positions = createHash("sha256"), data = [];
  const rewardComponents = {};
  let cursor = 0, cleared = null, denied = 0, alive = true, minPatrolGapM = Infinity, terminal, closure = null;
  const prefix = onward && createHash("sha256");
  let selection = null;
  const original = world.step.bind(world);
  world.step = () => {
    alive &&= pursuit.patrols.has(patrol) && world.actors.includes(patrol);
    original();
    if (prefix && !selection) prefix.update(JSON.stringify([
      world.tick, player.x, player.z, player.heading, player.speed, patrol.x, patrol.z, patrol.speed,
    ]));
    if (pursuit.metrics.guard === "road-boundary") denied++;
    // The ordinary engine removes its own patrols only after a terminal result.
    alive &&= patrol.health > 0 && world.actors.includes(lead) && (!wall || world.statics.includes(wall)) &&
      (pursuit.phase !== "running" || pursuit.patrols.has(patrol) && world.actors.includes(patrol));
    minPatrolGapM = Math.min(minPatrolGapM, distance(player, patrol));
    const wholeBody = corners(player).every(point => (point[branch.axis] - entry.fixed) * site.branchSign > 10);
    if (!cleared && wholeBody && bodyOnRoad(player, [branch]))
      cleared = { tick: world.tick, distanceM: player.distance, patrolDistanceM: patrol.distance };
  };
  const observation = () => observe ? observe(world, path) : routeCue ? env.getObservation() : null;
  let obs = observation();
  let killedAt = null, addedReward = 0;
  do {
    if (onward && !selection) {
      const { x, z, heading, speed, length, width } = player;
      const ego = Object.freeze({ x, z, heading, speed, length, width, wheelbase: player.spec.wheelbase });
      const scan = requireDispatchScan(world);
      const selected = onward.select(ego, scan, options);
      if (selected !== null) {
        assert.ok(selected && Number.isInteger(selected.index) && options[selected.index], "Unknown onward route");
        selection = { ...selected, tick: world.tick, scanTick: scan.tick, ego, patrolM: patrol.distance };
        path = options[selected.index];
        // Both options originate on the common approach. The alternate may have different sample spacing.
        const rear = { x: x - ego.wheelbase / 2 * Math.sin(heading), z: z - ego.wheelbase / 2 * Math.cos(heading) };
        cursor = path.reduce((nearest, point, i) => distance(rear, point) < distance(rear, path[nearest]) ? i : nearest, 0);
      }
    }
    const decision = choose && choose(obs);
    let action = arm === "prior" ? prior.action(env.getObservation()) : arm === "hold" ? PURSUIT_STOP : moving;
    if (choose) {
      action = sample ? decision.action : decision;
      if (replaceWithReference) {
        const targets = followConnectedReference(player, path, cursor, radius);
        cursor = targets.cursor;
        if (replaceWithReference === "steer") action = { ...action, steer: targets.action.steer };
        else if (replaceWithReference === "pace") action = { ...targets.action, steer: action.steer };
      }
    } else if (!["hold", "straight", "prior"].includes(arm)) {
      const targets = followConnectedReference(player, path, cursor, radius);
      cursor = targets.cursor;
      action = targets.action;
      if (arm === "blocked" || arm === "connected-reserved") {
        const evidenceM = branchObstruction(pursuit.gta.scan, player, path, cursor);
        if (evidenceM !== null)
          closure ??= { tick: world.tick, distanceAlongM: evidenceM,
            speedMps: player.speed, rearGapM: distance(player, patrol) };
        if (closure) action = { ...PURSUIT_STOP, steer: action.steer };
      }
    }
    const deniedBefore = denied;
    terminal = env.step(action);
    if (recordReward) {
      for (const [key, component] of Object.entries(terminal.info.rewardComponents))
        rewardComponents[key] = (rewardComponents[key] ?? 0) + component;
    }
    const nextObs = observe ? observation() : routeCue ? terminal.obs : null;
    if (demonstrate) data.push({ obs, action });
    if (sample) {
      const adjustment = rewardAdjustment?.(nextObs, denied - deniedBefore) ?? 0;
      assert.ok(Number.isFinite(adjustment));
      addedReward += adjustment;
      data.push({ obs, raw: decision.raw, value: decision.value, logp: decision.logp, reward: terminal.reward + adjustment });
    }
    obs = nextObs;
    const reason = terminal.info.shield.reason;
    if (reason) guardReasons[reason] = (guardReasons[reason] ?? 0) + terminal.info.shield.interventions;
    const newContacts = terminal.info.events.filter(event => event.fresh &&
      (event.type === "patrol_collision" || event.type === "static_or_civilian_hit"));
    // Ambient events are emitted only on fresh contact and carry no `fresh` field.
    const ambientHits = terminal.info.events.filter(event => event.type === "ambient_collision");
    contacts.push(...newContacts);
    ambientContacts.push(...ambientHits);
    if (!alive) killedAt ??= world.tick;
    const ego = [player.x, player.z, player.heading, player.speed], tail = [patrol.x, patrol.z, patrol.speed];
    positions.update(JSON.stringify([world.tick, ego, tail]));
    if (world.tick % 30 === 0 || newContacts.length || ambientHits.length || pursuit.phase !== "running")
      traces.push({ tick: world.tick, ego, tail, action, reason, command: terminal.info.appliedCommand,
        tracking: pursuit.response.dispatch.state, guard: pursuit.metrics.guard });
  } while (!terminal.terminated && !terminal.truncated);
  const furtherM = cleared ? player.distance - cleared.distanceM : 0;
  const qualified = pursuit.response.dispatch.escapeEligible;
  const escaped = pursuit.phase === "escaped" && qualified && !denied && !contacts.length &&
    alive && patrol.distance >= 20;
  const full = Boolean(escaped && cleared && world.tick - cleared.tick >= retainTicks && furtherM >= retainTravelM);
  const summary = { arm, seed, entry: site.entry, goal: path.at(-1), full, escaped, ticks: world.tick, phase: pursuit.phase,
    qualified, alive, cleared, furtherM, patrolM: patrol.distance, minPatrolGapM, leadM: lead.distance,
    denied, guardReasons, contacts, ambientContacts, traces, closure, killedAt, positions: positions.digest("hex"),
    ...(onward && { selection, approach: prefix.digest("hex"), obstructionIntact: !wall || world.statics.includes(wall) }),
    ...(ambient && { population: { traffic: ambient.filter(actor => actor.type === "vehicle").length,
      pedestrians: ambient.filter(actor => actor.type === "pedestrian").length,
      missing: ambient.filter(actor => !world.actors.includes(actor)).length } }),
    ...(recordReward && { rewardComponents, rewardProfile: env.rewardProfile, collisions: pursuit.metrics.collisions }),
    ...(rewardAdjustment ? { addedReward } : {}) };
  return demonstrate || sample ? { summary, data, last: terminal, lastObservation: obs } : summary;
}

if (fileURLToPath(import.meta.url).toLowerCase() === process.argv[1]?.toLowerCase()) {
  assert.ok(out, "Use a fresh PROVE_IT_OUTPUT_DIR");
  writeFileSync(join(out, "protocol.json"), JSON.stringify(specification, null, 2) + "\n", { flag: "wx" });
  const cases = fit.map(site => {
    const arms = [...["hold", "straight", "prior"].map(arm => ({ arm })), ...alternatives,
      { arm: "connected-reserved", path: site.approachPath ?? 1 }, { arm: "blocked-old" }, { arm: "blocked" }]
      .map(choice => run(site, choice));
    console.log(JSON.stringify({ road: site.entry, arms: arms.map(row => ({
      arm: row.arm, escaped: row.escaped, full: row.full, ticks: row.ticks, branch: row.cleared?.tick,
      first: row.contacts?.[0]?.tick, denied: row.denied, patrolM: row.patrolM, guard: row.guardReasons,
      skipped: row.skipped, closure: row.closure?.tick })) }));
    return { site, arms };
  });
  const qualifying = cases.filter(({ arms }) => arms.some(row => alternatives.some(choice => choice.arm === row.arm) && row.full) &&
    arms.some(row => row.arm === "straight" && !row.full));
  const blocked = cases.every(({ arms }) => {
    const row = arms.find(run => run.arm === "blocked");
    return !row.full && row.contacts.every(event => event.actorId !== "connected-window-barrier");
  });
  const passed = qualifying.length >= 2 && blocked;
  writeFileSync(join(out, "connected-windows.json"), JSON.stringify({ specification, tune, qualifying: qualifying.map(row =>
    row.site.entry), blocked, passed, cases }, null, 2) + "\n", { flag: "wx" });
  assert.ok(passed, "The full-window reference did not reach the same guarded recovery criterion on two roads");
}
