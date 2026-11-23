import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { angleDelta, distance } from "../src/core/geometry.js";
import { CIVILIAN_TIMED_YIELD } from "../src/core/pursuit-gta.js";
import { MEASURED_QUEUE_DETOUR } from "../src/rl/pako-measured-detour.js";
import { dispatchRouteGuide } from "../src/rl/pursuit-route-context.js";
import { isDispatchIncident, resetPursuitEpisode } from "../src/rl/pursuit-rollouts.js";
import { requireDispatchScan } from "../src/rl/pursuit-shield.js";
import { prior } from "./pako-connected-window.mjs";
import { followConnectedReference } from "./pako-reference-route.mjs";

const output = process.env.PROVE_IT_OUTPUT_DIR;
assert.ok(output, "Use a fresh PROVE_IT_OUTPUT_DIR");
const curriculum = JSON.parse(readFileSync(new URL("../config/pursuit-rl-city-route-development.json", import.meta.url)));
const stage = { ...curriculum.stages.find(s => s.id === "city-clearance"), episodeSeconds: 120,
  queueDetour: MEASURED_QUEUE_DETOUR, civilianCrossingPreview: CIVILIAN_TIMED_YIELD };
const episodes = join(output, "episodes.jsonl");
writeFileSync(episodes, "", { flag: "wx" });

const dwellTicks = 72, admissionM = 12;
function observeResume(ego, route, scan, dwell) {
  if (!route || dwell < dwellTicks || scan.tick < 0) return null;
  const front = [scan.rays.at(-3), scan.rays.at(-2), scan.rays.at(-1), ...scan.rays.slice(0, 4)];
  const nearestRayM = Math.min(...front.map(ray => ray.rangeM));
  if (nearestRayM < admissionM || scan.tracks.some(track =>
    track.forwardM > 0 && track.forwardM < admissionM && Math.abs(track.rightM) < 2.1)) return null;
  const { path } = route, axle = ego.spec.wheelbase / 2;
  const rear = { x: ego.x - Math.sin(ego.heading) * axle, z: ego.z - Math.cos(ego.heading) * axle };
  const cursor = path.reduce((best, p, i) => distance(rear, p) < distance(rear, path[best]) ? i : best, 0);
  if (cursor === path.length - 1 || distance(rear, path[cursor]) > 1.5) return null;
  const here = path[cursor], ahead = path[cursor + 1], aim = Math.atan2(ahead.x - here.x, ahead.z - here.z);
  if (Math.abs(angleDelta(aim, ego.heading)) > .22) return null;
  let remainingM = 0;
  for (let i = cursor; i < path.length - 1; i++) remainingM += distance(path[i], path[i + 1]);
  if (remainingM < 8 || remainingM > 24) return null;
  return { path, cursor, scanTick: scan.tick, nearestRayM, remainingM, dwell };
}

function trial(seed, active) {
  const { env, initial } = resetPursuitEpisode(stage, seed), { world } = env, { player, pursuit } = world;
  const ambient = world.actors.filter(actor => actor !== player && !pursuit.patrols.has(actor));
  assert.deepEqual([ambient.filter(a => a.type === "vehicle").length, ambient.filter(a => a.type === "pedestrian").length],
    [stage.traffic, stage.pedestrians]);
  const motion = createHash("sha256"), trace = [], incidents = [], moving = new Set();
  const pose = () => [world.tick, player.x, player.z, player.speed, player.heading];
  let obs = initial.obs, admission = null, cursor = 0, dwell = 0, denied = 0, exposedPatrol = null, priorVeto = null;
  const step = world.step.bind(world);
  world.step = () => {
    step();
    denied += Number(pursuit.metrics.guard === "road-boundary");
    for (const patrol of pursuit.patrols) if (patrol.health > 0 && patrol.speed > 3 && patrol.distance > 8) moving.add(patrol);
  };
  while (pursuit.phase === "running") {
    const from = pose(), distanceM = player.distance, policy = prior.action(obs);
    const scan = requireDispatchScan(world), stationary = Math.abs(player.speed) < .05;
    const front = scan.rays[0];
    if (stationary && dwell >= dwellTicks && front.kind === "police" && front.rangeM < 4)
      exposedPatrol ??= { pose: from, rangeM: front.rangeM, requested: policy, tick: scan.tick };
    if (active && !admission && stationary && policy.brake > 0 && !priorVeto) {
      const choice = observeResume(player, dispatchRouteGuide(world, stage.observation), scan, dwell);
      if (choice) {
        admission = { ...choice, pose: from, beforeM: distanceM, policy };
        cursor = choice.cursor;
      }
    }
    // The latch only submits the mapped proposal; the original guard still arbitrates each decision.
    const using = admission ? followConnectedReference(player, admission.path, cursor) : { action: policy, cursor };
    cursor = using.cursor;
    const { info, obs: updated } = env.step(using.action);
    obs = updated;
    const to = pose();
    motion.update(JSON.stringify([...to, info.appliedCommand]));
    dwell = Math.abs(player.speed) < .05 && player.distance - distanceM < .005
      ? dwell + to[0] - from[0] : 0;
    priorVeto = info.shield.reason;
    if (world.tick % 36 === 6 || admission || pursuit.phase !== "running")
      trace.push({ from, to, policy, asked: using.action, applied: info.appliedCommand, shield: info.shield, dwell });
    incidents.push(...info.events.filter(isDispatchIncident));
    assert.ok(ambient.every(actor => world.actors.includes(actor)));
  }
  const people = incidents.filter(event => event.type === "ambient_collision" &&
    [event.first, event.second].some(actor => actor.type === "pedestrian"));
  const ego = incidents.filter(event => event.fresh && ["patrol_collision", "static_or_civilian_hit"].includes(event.type));
  const outcome = { seed, arm: active ? "observed-resume" : "stock", phase: pursuit.phase, ticks: world.tick, denied,
    pedestrianImpacts: people.length, egoContacts: pursuit.metrics.collisions, movingPatrols: moving.size,
    clean: pursuit.phase === "escaped" && pursuit.response.dispatch.escapeEligible && !people.length &&
      !ego.length && !pursuit.metrics.collisions && !denied && moving.size > 0,
    distanceM: admission ? player.distance - admission.beforeM : 0, exposedPatrol,
    admission: admission && { ...admission, path: undefined }, acceptedMotion: motion.digest("hex") };
  console.log(JSON.stringify(outcome));
  appendFileSync(episodes, JSON.stringify({ outcome, trace, incidents }) + "\n");
  return outcome;
}

const [late, blocked] = curriculum.validationSeeds.map(seed => ({ stock: trial(seed, false), active: trial(seed, true) }));
const blockedUnchanged = blocked.active.acceptedMotion === blocked.stock.acceptedMotion &&
  !blocked.active.admission && Boolean(blocked.active.exposedPatrol) && blocked.stock.phase === "timeout";
const passed = blockedUnchanged && late.stock.phase === "timeout" && late.active.clean &&
  late.active.distanceM >= 10 && late.active.admission?.dwell >= dwellTicks && late.active.movingPatrols > 0;
writeFileSync(join(output, "observed-resume.json"), JSON.stringify({ passed, blockedUnchanged, late, blocked,
  scope: "Scripted observed near-end resumption, exact frozen actor and unchanged independent guard. No deployment or learning claim." }, null, 2) + "\n", { flag: "wx" });
assert.ok(passed, "The actual observed resume did not recover the late full terminal while preserving the blocked control");
