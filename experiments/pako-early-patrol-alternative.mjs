import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CIVILIAN_TIMED_YIELD } from "../src/core/pursuit-gta.js";
import { MEASURED_QUEUE_DETOUR } from "../src/rl/pako-measured-detour.js";
import { isDispatchIncident, resetPursuitEpisode } from "../src/rl/pursuit-rollouts.js";
import { requireDispatchScan } from "../src/rl/pursuit-shield.js";
import { prior } from "./pako-connected-window.mjs";
import { followConnectedReference, makeParallelPath } from "./pako-reference-route.mjs";

const output = process.env.PROVE_IT_OUTPUT_DIR;
assert.ok(output, "Use a fresh PROVE_IT_OUTPUT_DIR");
const curriculum = JSON.parse(readFileSync(new URL("../config/pursuit-rl-city-route-development.json", import.meta.url)));
const stage = { ...curriculum.stages.find(row => row.id === "city-clearance"), episodeSeconds: 120,
  queueDetour: MEASURED_QUEUE_DETOUR, civilianCrossingPreview: CIVILIAN_TIMED_YIELD };
const seed = "city-route-dev-eval-01";
assert.ok(curriculum.validationSeeds.includes(seed));
const cases = [
  { arm: "stock" },
  { arm: "earlier-east", handoffTick: 1050, side: 1 },
  { arm: "earlier-west", handoffTick: 1050, side: -1 },
  { arm: "later-east", handoffTick: 1086, side: 1 },
];
const switchTicks = new Set(cases.map(row => row.handoffTick).filter(Number.isInteger));
const write = (name, data) => writeFileSync(join(output, name), JSON.stringify(data, null, 2) + "\n", { flag: "wx" });
write("protocol.json", { seed, stage, cases, horizonTicks: 7200,
  scope: "Same-state game reference. The two switch times were measured in a prior untouched stock trace; they are fixture inputs, not a released control rule." });
const episodes = join(output, "episodes.jsonl");
writeFileSync(episodes, "", { flag: "wx" });

function trial({ arm, handoffTick, side }) {
  const { env, initial } = resetPursuitEpisode(stage, seed), { world } = env, { pursuit, player } = world;
  const ambient = world.actors.filter(a => a !== player && !pursuit.patrols.has(a));
  assert.deepEqual([ambient.filter(a => a.type === "vehicle").length, ambient.filter(a => a.type === "pedestrian").length],
    [stage.traffic, stage.pedestrians]);
  const road = world.district.drivingRoads.find(r => r.id === "civic-avenue");
  const junction = world.district.drivingRoads.find(r => r.id === "station-avenue");
  assert.ok(road?.axis === "z" && junction?.axis === "x");
  const pose = () => [world.tick, player.x, player.z, player.speed, player.heading];
  const motion = createHash("sha256"), anchors = {}, trace = [], incidents = [], movingPatrols = new Set();
  let obs = initial.obs, handoff = null, path = null, cursor = 0, denied = 0, heldAt = null, pastJunction = null;
  const step = world.step.bind(world);
  world.step = () => {
    step();
    denied += Number(pursuit.metrics.guard === "road-boundary");
    for (const patrol of pursuit.patrols)
      if (patrol.health > 0 && patrol.speed > 3 && patrol.distance > 8) movingPatrols.add(patrol);
  };
  while (pursuit.phase === "running") {
    const from = pose(), policy = prior.action(obs), scan = requireDispatchScan(world);
    const front = [scan.rays.at(-1), ...scan.rays.slice(0, 3)];
    if (switchTicks.has(world.tick)) {
      const anchor = { pose: from, scanTick: scan.tick, front, hash: motion.copy().digest("hex") };
      anchors[world.tick] = anchor;
      if (world.tick === handoffTick) {
        assert.equal(scan.tick, world.tick);
        assert.ok(front.some(ray => ray.kind === "police" && ray.rangeM >= 10 && ray.rangeM <= 25),
          "The mapped proposal must be after a real near-route police return");
        const planned = makeParallelPath(world.district, player, road, junction, side);
        if (planned.length > 2) path = Object.freeze(planned.map(Object.freeze));
        handoff = { ...anchor, admittedMap: Boolean(path), plannedSamples: planned.length, side, distanceM: player.distance };
      }
    }
    const chosen = path ? followConnectedReference(player, path, cursor) : { action: policy, cursor };
    cursor = chosen.cursor;
    const { info, obs: next } = env.step(chosen.action);
    obs = next;
    motion.update(JSON.stringify([...pose(), info.appliedCommand]));
    if (info.shield.reason === "police" && Math.abs(player.speed) < .05 && front[1].rangeM < 3.25)
      heldAt ??= { pose: pose(), measuredM: front[1].rangeM };
    if (handoff && player.z > junction.fixed + 8) pastJunction ??= pose();
    incidents.push(...info.events.filter(isDispatchIncident));
    if (world.tick % 36 === 6 || pursuit.phase !== "running")
      trace.push({ from, to: pose(), requested: chosen.action, shield: info.shield, applied: info.appliedCommand });
    assert.ok(ambient.every(actor => world.actors.includes(actor)));
  }
  const people = incidents.filter(event => event.type === "ambient_collision" &&
    [event.first, event.second].some(actor => actor.type === "pedestrian"));
  const hits = incidents.filter(event => event.fresh && ["patrol_collision", "static_or_civilian_hit"].includes(event.type));
  const outcome = { arm, phase: pursuit.phase, ticks: world.tick, denied, egoContacts: pursuit.metrics.collisions,
    pedestrianImpacts: people.length, movingPatrols: movingPatrols.size, handoff, heldAt, pastJunction, firstHit: hits[0] ?? null,
    onwardM: handoff ? player.distance - handoff.distanceM : 0,
    clean: Boolean(pursuit.phase === "escaped" && pursuit.response.dispatch.escapeEligible && handoff?.admittedMap && pastJunction &&
      !denied && pursuit.metrics.collisions === 0 && !hits.length && !people.length && movingPatrols.size > 0),
    hash: motion.digest("hex"), anchors };
  console.log(JSON.stringify(outcome));
  appendFileSync(episodes, JSON.stringify({ outcome, trace, incidents }) + "\n");
  return outcome;
}

const [stock, ...alternatives] = cases.map(trial);
const matched = alternatives.every((row, i) => {
  const anchor = stock.anchors[cases[i + 1].handoffTick];
  return row.handoff?.hash === anchor.hash && JSON.stringify(row.handoff?.pose) === JSON.stringify(anchor.pose);
});
const passed = matched && stock.phase === "timeout" && stock.ticks === 7200 &&
  stock.heldAt?.measuredM < 3.25 && alternatives.some(row => row.clean);
write("early-alternative.json", { passed, matched, stock, alternatives });
assert.ok(passed, "No fully clean guarded terminal from the tested earlier mapped continuations");
