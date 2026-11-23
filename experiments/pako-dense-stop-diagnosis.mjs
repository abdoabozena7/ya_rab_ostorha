import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { clamp, STEP, VEHICLE } from "../src/core/config.js";
import { angleDelta, bodyOnRoad, distance, sweepSafe } from "../src/core/geometry.js";
import { CIVILIAN_TIMED_YIELD } from "../src/core/pursuit-gta.js";
import { MEASURED_QUEUE_DETOUR, queuePassingConflict } from "../src/rl/pako-measured-detour.js";
import { PursuitDecisionTrace } from "../src/rl/pursuit-diagnostics.js";
import { isDispatchIncident, resetPursuitEpisode } from "../src/rl/pursuit-rollouts.js";
import { requireDispatchScan } from "../src/rl/pursuit-shield.js";
import { PURSUIT_SCAN_RAYS, PURSUIT_SCAN_TICKS } from "../src/signal_processing/pursuit-scanner.js";
import { prior } from "./pako-connected-window.mjs";
import { followConnectedReference } from "./pako-reference-route.mjs";

const out = process.env.PROVE_IT_OUTPUT_DIR;
assert.ok(out, "Use a fresh PROVE_IT_OUTPUT_DIR");
const curriculum = JSON.parse(readFileSync(new URL("../config/pursuit-rl-city-route-development.json", import.meta.url)));
const stage = { ...curriculum.stages.find(row => row.id === "city-clearance-dense"), episodeSeconds: 120,
  queueDetour: MEASURED_QUEUE_DETOUR };
const seed = "city-route-dev-eval-01";
assert.ok(curriculum.validationSeeds.includes(seed));
const policyId = "854b284350457717cd2c299a0dc86604f2600ed989c1c9aac7ff497d0e5181e3";
const expectedMotion = { stock: "01e23d405634d8c0abd7967df4c14efc77888cd6e6a8a2ba43fe60576ab0d8ee",
  preview: "7207d61c50002f4ec89bf36ec4b6337dbfc865b89c2128560165134df3b49f71" };
const write = (name, data) => writeFileSync(join(out, name), data, { flag: "wx" });
const result = (name, data) => write(name, JSON.stringify(data, null, 2) + "\n");
const alive = unit => unit.health > 0 && unit.aiState !== "WRECKED";
const add = (counts, key, ticks) => { counts[key] = (counts[key] ?? 0) + ticks; };

function classification(decision) {
  if (decision.shield) return `range-guard:${decision.shield.reason}`;
  return decision.stopReason;
}

function corridorReturns(decision) {
  return decision.observation.returns.flatMap(([i, kind, rangeM]) => {
    const angle = i * 2 * Math.PI / PURSUIT_SCAN_RAYS;
    const rightM = rangeM * Math.sin(angle), forwardM = rangeM * Math.cos(angle);
    return forwardM > 0 && forwardM < 12 && Math.abs(rightM) < 1.6
      ? [{ i, kind, rangeM, rightM, forwardM }] : [];
  });
}

function measuredQueueLead(world, road, requested, minGap, maxGap) {
  const { player: ego } = world, scan = requireDispatchScan(world);
  const laneX = road.fixed - road.laneOffsetM;
  if (scan.tick !== world.tick || requested.gear !== 1 || requested.brake > 0 || requested.throttle < .55 ||
      Math.abs(requested.steer) > .18 || Math.abs(angleDelta(0, ego.heading)) > .16 ||
      Math.abs(ego.x - laneX) > 1 || !bodyOnRoad(ego, [road]) ||
      world.drivingRoads.some(other => other.axis === "x" && !other.parkingBay && !other.supportApron &&
        road.fixed >= other.min && road.fixed <= other.max &&
        Math.abs(ego.z - other.fixed) <= other.width / 2 + ego.length / 2 + 2)) return null;
  return scan.tracks.filter(track => track.kind === "civilian" && track.ageS === 0 && track.motionKnown &&
    Math.abs(track.observedXM - laneX) < 1.4 && Math.abs(track.estimatedXMps) <= .65 &&
    track.estimatedZMps >= -.25 && track.estimatedZMps <= 1.4 && ego.speed - track.estimatedZMps >= .5)
    .map(track => ({ track, gapM: track.observedZM - ego.z }))
    .filter(row => row.gapM >= minGap && row.gapM <= maxGap).sort((a, b) => a.gapM - b.gapM)[0] ?? null;
}

function capQueueApproach(world, road, requested) {
  const ego = world.player, lead = measuredQueueLead(world, road, requested, 3.3, 16);
  if (!lead || (lead.gapM <= 6 && ego.speed <= 2.45)) return null;
  const aim = Math.sqrt(2.1 ** 2 + 4 * Math.max(0, lead.gapM - 6.15));
  const interval = PURSUIT_SCAN_TICKS * STEP;
  const acceleration = ego.spec?.acceleration ?? VEHICLE.acceleration;
  const braking = ego.spec?.braking ?? VEHICLE.braking;
  const throttle = clamp((aim - ego.speed) / (acceleration * interval), 0, requested.throttle);
  const brake = clamp((ego.speed - aim) / (braking * interval), 0, 1);
  if (brake === 0 && throttle === requested.throttle) return null;
  return { action: { ...requested, throttle, brake }, aim, lead };
}

function surveyedQueuePath(world, road, scan, lead) {
  const ego = world.player, axle = ego.spec.wheelbase / 2, targetX = road.fixed + road.laneOffsetM - .25;
  if (queuePassingConflict(scan, ego, 0, targetX - ego.x, lead.gapM + 9)) return null;
  const homeX = road.fixed - road.laneOffsetM;
  const startX = ego.x - Math.sin(ego.heading) * axle, startZ = ego.z - Math.cos(ego.heading) * axle;
  const entryM = lead.track.observedZM - 4 - startZ;
  const rejoinZ = lead.track.observedZM + 12;
  const endZ = rejoinZ + 20;
  if (endZ > road.max - 4 || entryM < 10) return null;
  const ease = t => .5 - .5 * Math.cos(Math.PI * clamp(t, 0, 1));
  const count = Math.ceil((endZ - startZ) / .30), path = [];
  const curvatureLimit = Math.tan((ego.spec.maxSteer ?? VEHICLE.maxSteer) - .10) / ego.spec.wheelbase;
  let lastBody = ego;
  for (let i = 0; i <= count; i++) {
    const z = startZ + (endZ - startZ) * i / count;
    const x = startX + (targetX - startX) * ease((z - startZ) / entryM) + (homeX - targetX) * ease((z - rejoinZ) / 20);
    const last = path.at(-1), heading = last ? Math.atan2(x - last.x, z - last.z) : 0;
    if (i > 1 && Math.abs(angleDelta(heading, lastBody.heading)) / distance({ x, z }, last) > curvatureLimit) return null;
    const body = { ...ego, x: x + Math.sin(heading) * axle, z: z + Math.cos(heading) * axle, heading };
    if (!sweepSafe(lastBody, body, world.district.statics, [road]).safe) return null;
    path.push({ x, z });
    lastBody = body;
  }
  const rayStep = 2 * Math.PI / PURSUIT_SCAN_RAYS;
  const entryWitness = [];
  for (const forward of [3, 5, 7, 9, 11]) {
    const point = path.find(p => p.z >= ego.z + forward);
    const rangeM = distance(ego, point);
    const index = Math.round(angleDelta(Math.atan2(point.x - ego.x, point.z - ego.z), ego.heading) / rayStep);
    const indices = [-1, 0, 1].map(delta => (index + delta + PURSUIT_SCAN_RAYS) % PURSUIT_SCAN_RAYS);
    const samples = indices.map(i => ({ i, ...scan.rays[i] }));
    if (samples.some(ray => ray.rangeM <= rangeM + 1.2)) return null;
    entryWitness.push({ point, rangeM, samples });
  }
  return { path, homeX, targetX, entryWitness, lead, scanTick: scan.tick };
}

function run(arm, preview, { reserve = false, geometry = false, prefix = null } = {}) {
  const { env, initial } = resetPursuitEpisode({ ...stage, civilianCrossingPreview: preview }, seed);
  const { world } = env, { player, pursuit } = world;
  const population = world.actors.filter(actor => actor !== player && !pursuit.patrols.has(actor));
  assert.deepEqual([population.filter(a => a.type === "vehicle").length, population.filter(a => a.type === "pedestrian").length],
    [stage.traffic, stage.pedestrians]);
  assert.equal(pursuit.gta.config.civilianCrossingPreview, preview);
  const originalPatrols = [...pursuit.patrols];
  const stillRunningOriginal = new Set(originalPatrols);
  const trace = env.decisionTrace = new PursuitDecisionTrace(`${seed}:${arm}`);
  const motion = createHash("sha256"), incidents = [], stops = [];
  const road = (reserve || geometry) && world.drivingRoads.find(row => row.id === "civic-avenue");
  assert.ok(!(reserve || geometry) || road?.axis === "z");
  let firstCap = null, firstPass = null, cappedDecisions = 0;
  let previousLead = null, route = null, rejoined = null, cursor = 0, unsupported = 0;
  let observedQueueYield = null, queueStopTicks = 0, mislabeledQueueTicks = 0;
  let obs = initial.obs, dwell = null, minHealthy = originalPatrols.length, roadDenials = 0;
  const step = world.step.bind(world);
  world.step = () => {
    step();
    roadDenials += Number(pursuit.metrics.guard === "road-boundary");
    if (route && !rejoined && !bodyOnRoad(player, [road])) unsupported++;
    if (pursuit.phase !== "running") return;
    const active = [...pursuit.patrols].filter(alive);
    minHealthy = Math.min(minHealthy, active.length);
    for (const original of stillRunningOriginal) if (!active.includes(original)) stillRunningOriginal.delete(original);
  };
  while (pursuit.phase === "running") {
    const requested = prior.action(obs);
    if (geometry && !route && !firstPass) {
      const lead = player.speed >= 2.4 && player.speed <= 6.3
        ? measuredQueueLead(world, road, requested, 14, 19) : null;
      if (lead && previousLead?.id === lead.track.trackId && previousLead.tick === world.tick - PURSUIT_SCAN_TICKS) {
        const scan = requireDispatchScan(world);
        const supported = surveyedQueuePath(world, road, scan, lead);
        if (supported) route = { ...supported, tick: world.tick, distanceM: player.distance, previousLead,
          hash: motion.copy().digest("hex") };
      }
      previousLead = lead ? { id: lead.track.trackId, tick: world.tick, gapM: lead.gapM } : null;
    }
    if (route && !rejoined && player.z >= route.path.at(-1).z - 3.5 &&
        Math.abs(player.x - route.homeX) < .65 && Math.abs(angleDelta(player.heading, 0)) < .17)
      rejoined = { tick: world.tick, xM: player.x, zM: player.z, travelledM: player.distance - route.distanceM };
    const following = route && !rejoined ? followConnectedReference(player, route.path, cursor) : null;
    let pathAction;
    if (following) {
      cursor = following.cursor;
      const pace = 4.6;
      const acceleration = player.spec?.acceleration ?? VEHICLE.acceleration;
      const interval = PURSUIT_SCAN_TICKS * STEP;
      pathAction = { ...following.action,
        throttle: clamp((pace - player.speed) / (acceleration * interval), 0, following.action.throttle),
        brake: Math.max(following.action.brake, clamp((player.speed - pace) / 2.4, 0, 1)) };
      if (pathAction.brake > 0) pathAction.throttle = 0;
    }
    const limited = reserve && !firstPass && capQueueApproach(world, road, requested);
    if (prefix || limited) {
      const hash = motion.copy().digest("hex");
      if (prefix) prefix.set(world.tick, hash);
      if (limited) {
        firstCap ??= { tick: world.tick, scanTick: pursuit.gta.scan.tick, hash, requested, ...limited };
        cappedDecisions++;
      }
    }
    const { obs: next, info } = env.step(pathAction ?? limited?.action ?? requested, PURSUIT_SCAN_TICKS,
      { source: pathAction || limited ? "reference" : "policy", policyId });
    obs = next;
    motion.update(JSON.stringify([world.tick, player.x, player.z, player.speed, player.heading, info.appliedCommand]));
    assert.ok(population.every(actor => world.actors.includes(actor)));
    const row = trace.latest, cause = classification(row);
    assert.equal(row.tick, row.observation.tick, "Missing current real sample at decision");
    if (!firstPass && info.planner?.queue?.phase === "pass") {
      const lead = row.observation.threats.find(track => track.trackId === info.planner.queue.leadId);
      firstPass = { tick: row.tick, scanTick: row.observation.tick, pose: row.ego, lead,
        gapM: lead ? lead.observedZM - row.ego.zM : null, shield: info.shield };
    }
    incidents.push(...info.events.filter(isDispatchIncident));
    if (row.endPhase !== "running" || Math.abs(row.ego.speedMps) >= .05 ||
        Math.abs(row.acceptedEgo.speedMps) >= .05 || row.acceptedDisplacementM >= .005) {
      dwell = null;
      continue;
    }
    if (!dwell) {
      dwell = { start: row.tick, end: row.tick, pose: row.ego, seconds: 0, causes: {}, frontSamples: {}, first: {} };
      stops.push(dwell);
    }
    const ticks = row.endTick - row.tick;
    dwell.end = row.endTick;
    dwell.seconds += row.durationS;
    const label = cause ?? "unclassified";
    add(dwell.causes, label, ticks);
    const returns = corridorReturns(row);
    for (const kind of new Set(returns.map(point => point.kind))) add(dwell.frontSamples, kind, 1);
    const evidence = { tick: row.tick, scanTick: row.observation.tick, returned: returns,
      asked: row.requestedAction, submitted: row.submittedAction, applied: row.appliedCommand };
    dwell.first[label] ??= evidence;
    if (row.planner?.queue?.phase === "yield" && !row.shield && !row.guardRestrictions.length &&
        row.requestedAction.brake < 1 && row.submittedAction.brake === 1 && row.appliedCommand?.targetSpeed === 0) {
      queueStopTicks += ticks;
      if (row.stopReason !== "QUEUE_YIELD") mislabeledQueueTicks += ticks;
      if (row.requestedAction.throttle > 0 && returns.some(sample => sample.kind === "civilian"))
        observedQueueYield ??= { label: row.stopReason, ...evidence };
    }
  }
  write(`${arm}.jsonl`, trace.toJSONL());
  result(`${arm}-incidents.json`, incidents);
  const hash = motion.digest("hex");
  const output = { arm, phase: pursuit.phase, ticks: world.tick, hash, decisions: trace.size,
    firstCap, firstPass, cappedDecisions,
    route: route && { ...route, path: undefined, samples: route.path.length }, rejoined, unsupported,
    observedQueueYield, queueStopTicks, mislabeledQueueTicks,
    final: [player.x, player.z, player.speed, player.heading], roadDenials, minHealthy,
    openingHealthyThroughRunning: stillRunningOriginal.size, opening: originalPatrols.length,
    physicsQualified: pursuit.response.dispatch.escapeEligible === true,
    egoContacts: pursuit.metrics.collisions,
    ambientPedestrianContacts: incidents.filter(event => event.type === "ambient_collision" &&
      [event.first, event.second].some(actor => actor.type === "pedestrian")).length,
    sustained: stops.filter(run => run.end - run.start >= 120).map(run => {
      const [dominant, ticks] = Object.entries(run.causes).sort((a, b) => b[1] - a[1])[0];
      return { ...run, dominant, fraction: ticks / (run.end - run.start) };
    }) };
  console.log(JSON.stringify({ ...output, sustained: output.sustained.map(
    ({ start, end, dominant, causes }) => ({ start, end, dominant, causes })) }));
  return output;
}

if (process.argv[2] === "--queue-path") {
  const prefix = new Map(), preview = run("preview", CIVILIAN_TIMED_YIELD, { prefix });
  const path = run("path", CIVILIAN_TIMED_YIELD, { geometry: true });
  const baselineExact = preview.phase === "timeout" && preview.ticks === 7200 && preview.hash === expectedMotion.preview;
  const entry = path.route;
  const matchedPrefix = Boolean(entry && entry.scanTick === entry.tick && entry.previousLead.tick === entry.tick - PURSUIT_SCAN_TICKS &&
    entry.lead.track.ageS === 0 && prefix.get(entry.tick) === entry.hash);
  const entryGapM = entry?.lead.gapM ?? null;
  const passed = baselineExact && matchedPrefix && entryGapM >= 12 && entry.entryWitness.length === 5 &&
    path.rejoined?.travelledM >= 20 && path.phase === "escaped" && path.physicsQualified &&
    path.opening === 10 && path.openingHealthyThroughRunning === path.opening && path.egoContacts === 0 &&
    path.ambientPedestrianContacts === 0 && path.roadDenials === 0 && path.unsupported === 0;
  result("queue-path.json", { seed, stage, baselineExact, matchedPrefix, entryGapM, passed, preview, path,
    scope: "Range-supported and geometrically swept reference, not a trained policy. No change to game guard or actor state." });
  assert.ok(passed, "The measured earlier geometric proposal did not pass the full Max gate");
} else if (process.argv[2] === "--queue-reserve") {
  const prefix = new Map(), preview = run("preview", CIVILIAN_TIMED_YIELD, { prefix });
  const reserve = run("reserve", CIVILIAN_TIMED_YIELD, { reserve: true });
  const baselineExact = preview.phase === "timeout" && preview.ticks === 7200 && preview.hash === expectedMotion.preview;
  const onset = reserve.firstCap;
  const matchedPrefix = Boolean(onset && onset.tick === onset.scanTick && onset.lead.track.ageS === 0 &&
    onset.lead.gapM > 6 && prefix.get(onset.tick) === onset.hash);
  const passEarlierM = preview.firstPass?.gapM != null && reserve.firstPass?.gapM != null
    ? reserve.firstPass.gapM - preview.firstPass.gapM : null;
  const passed = baselineExact && matchedPrefix && passEarlierM >= 1 && reserve.phase === "escaped" &&
    reserve.physicsQualified && reserve.opening === 10 && reserve.openingHealthyThroughRunning === reserve.opening &&
    reserve.egoContacts === 0 && reserve.ambientPedestrianContacts === 0 && reserve.roadDenials === 0;
  result("queue-reserve.json", { seed, stage, baselineExact, matchedPrefix, passEarlierM, passed, preview, reserve,
    scope: "Same timed NPC preview and existing guard/queue planner. Only the longitudinal request is capped based on a measured civilian lead." });
  assert.ok(passed, "Earlier observed pace did not produce the required clean full Max escape");
} else {
  const verifyLabels = process.argv[2] === "--queue-label";
  assert.ok(verifyLabels || process.argv.length === 2, "Use --queue-label, --queue-reserve, --queue-path or no options");
  const stock = run("stock", undefined), preview = run("preview", CIVILIAN_TIMED_YIELD);
  const exactTransferReplay = stock.phase === "escaped" && stock.ticks === 4446 && preview.phase === "timeout" &&
    preview.ticks === 7200 && stock.hash === expectedMotion.stock && preview.hash === expectedMotion.preview;
  const diagnosed = preview.sustained.some(run => run.pose.zM < stock.final[1] - 10 &&
    !["UNKNOWN", "unclassified"].includes(run.dominant) && run.fraction > .5);
  result("dense-stop.json", { seed, stage, exactTransferReplay, diagnosed, stock, preview,
    scope: "Noninterfering diagnostics of a known full-density pair. Contacts and requests remain recorded regardless of terminal." });
  assert.ok(exactTransferReplay && diagnosed, "Dense paired trace did not reproduce or did not distinguish its stationary window");
  if (verifyLabels) assert.ok(preview.observedQueueYield?.label === "QUEUE_YIELD" &&
    preview.queueStopTicks >= 162 && preview.mislabeledQueueTicks === 0, "The canonical trace mislabels the actual queue brake");
}
