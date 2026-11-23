import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CIVILIAN_TIMED_YIELD } from "../src/core/pursuit-gta.js";
import { MEASURED_QUEUE_DETOUR } from "../src/rl/pako-measured-detour.js";
import { isDispatchIncident, runPursuitEpisode } from "../src/rl/pursuit-rollouts.js";
import { prior } from "./pako-connected-window.mjs";
import { evaluateChoice, fitStarts, obstructions } from "./pako-onward-choice.mjs";

const output = process.env.PROVE_IT_OUTPUT_DIR;
assert.ok(output, "Use a fresh PROVE_IT_OUTPUT_DIR");
const [mode] = process.argv.slice(2);
assert.ok(mode === "--local" || mode === "--transfer", "Choose --local or --transfer");
const write = (name, report) => writeFileSync(join(output, name), JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
const isPerson = event => event.type === "ambient_collision" &&
  [event.first, event.second].some(actor => actor.type === "pedestrian");
const isEgoImpact = event => event.fresh && ["patrol_collision", "static_or_civilian_hit"].includes(event.type);

function local() {
  const seed = "pako-population-probe-01:36:civic", population = { traffic: 36, pedestrians: 80 };
  const start = { ...fitStarts[0], offsetM: fitStarts[0].offsetM + 4 };
  const switchTick = 522, choice = 1;
  write("protocol.json", { seed, start, population, switchTick, choice,
    scope: "Original accepted mounted-scan episode; keep its recorded action at the fork fixed to isolate the simulated NPC change." });
  const rows = [undefined, CIVILIAN_TIMED_YIELD].map(civilianCrossingPreview => {
    const first = { yield: null };
    let attached = false;
    const arm = civilianCrossingPreview ?? "stock";
    const result = evaluateChoice(start, obstructions.civic, null, arm, seed, {
      population, civilianCrossingPreview, recordReward: true,
      observe(world) {
        if (attached) return;
        attached = true;
        const { pursuit } = world;
        const civilians = world.actors.filter(a => a.type === "vehicle" && a !== world.player && !pursuit.patrols.has(a));
        const step = world.step.bind(world);
        world.step = () => {
          step();
          if (first.yield) return;
          const car = civilians.find(a => a.reason === "pedestrian-yield" && a.speed < a.previous.speed);
          if (car) first.yield = { tick: world.tick, id: car.id, person: car.blockedBy,
            beforeMps: car.previous.speed, afterMps: car.speed };
        };
      },
      onward: { obstruction: obstructions.civic, select: (_ego, scan) =>
        scan.tick === switchTick ? { index: choice } : null },
    });
    assert.deepEqual(result.population, { ...population, missing: 0 });
    const people = result.ambientContacts.filter(isPerson);
    const summary = { arm, phase: result.phase, ticks: result.ticks, clean: result.full, egoContacts: result.contacts.length,
      people: people.length, roadDenials: result.denied, patrolRetained: result.alive, patrolM: result.patrolM,
      first: first.yield, positionSha256: result.positions };
    console.log(JSON.stringify(summary));
    return { summary, people, result };
  });
  const [stock, preview] = rows;
  const stockPeople = stock.people.length, previewPeople = preview.people.length;
  const passed = stock.summary.clean && stock.summary.positionSha256 ===
    "42a51c0e4c6f74eba096d8f39e7837d83a98c8c5c5d28f9ee30f6e4844ac07db" &&
    JSON.stringify(stock.people.map(event => event.tick)) === "[177,2133,3095]" &&
    preview.summary.clean && previewPeople === 0 && Boolean(preview.summary.first) && preview.summary.first.tick < 177;
  write("timed-yield.json", { passed, stockPeople, previewPeople, rows });
  assert.ok(passed, "The actual guarded terminal and original three-contact witness did not agree");
}

function transfer() {
  const curriculum = JSON.parse(readFileSync(new URL("../config/pursuit-rl-city-route-development.json", import.meta.url)));
  const cases = curriculum.stages.flatMap(stage => curriculum.validationSeeds.map(seed => ({ stage, seed })));
  const expected = [[3487, 0], [3836, 1], [5248, 2], [4446, 0]];
  assert.equal(cases.length, expected.length);
  write("protocol.json", { cases, expected, scope: "Four unchanged development starts, actual terminal outcomes, no protected data.",
    samePolicy: "854b284350457717cd2c299a0dc86604f2600ed989c1c9aac7ff497d0e5181e3",
    sameAssist: MEASURED_QUEUE_DETOUR, episodeSeconds: 120, preview: CIVILIAN_TIMED_YIELD });
  const episodes = join(output, "episodes.jsonl");
  writeFileSync(episodes, "", { flag: "wx" });

  function trial(stage, seed, civilianCrossingPreview) {
    let originals, retained = true, denied = 0, peakPatrols = 0, decision = 0;
    const incidents = [], poses = [], moving = new Set(), motion = createHash("sha256");
    const { metrics } = runPursuitEpisode({ ...stage, episodeSeconds: 120, queueDetour: MEASURED_QUEUE_DETOUR,
      civilianCrossingPreview }, seed, prior.action, false, (pose, events) => {
      motion.update(JSON.stringify(pose));
      if (++decision % 6 === 1) poses.push(pose);
      incidents.push(...events.filter(isDispatchIncident));
    }, world => {
      const { pursuit } = world;
      assert.equal(pursuit.gta.config.civilianCrossingPreview, civilianCrossingPreview);
      if (!originals) {
        originals = world.actors.filter(actor => actor !== world.player && !pursuit.patrols.has(actor));
        assert.deepEqual([originals.filter(actor => actor.type === "vehicle").length,
          originals.filter(actor => actor.type === "pedestrian").length], [stage.traffic, stage.pedestrians]);
        const step = world.step.bind(world);
        world.step = () => { step(); denied += Number(pursuit.metrics.guard === "road-boundary"); };
      }
      retained &&= originals.every(actor => world.actors.includes(actor));
      const active = [...pursuit.patrols].filter(patrol => patrol.health > 0);
      peakPatrols = Math.max(peakPatrols, active.length);
      for (const patrol of active) if (patrol.speed > 3 && patrol.distance > 8) moving.add(patrol);
    });
    const people = incidents.filter(isPerson), ego = incidents.filter(isEgoImpact);
    const summary = { stage: stage.id, seed, profile: civilianCrossingPreview ?? "stock", phase: metrics.phase,
      ticks: metrics.ticks, people: people.length, ego: metrics.collisions, firstEgo: ego[0] ?? null, retained,
      denied, peakPatrols, movingPatrols: moving.size, positionSha256: motion.digest("hex"),
      clean: metrics.phase === "escaped" && metrics.pursuitQualified && !denied && !ego.length &&
        metrics.collisions === 0 && retained && moving.size > 0 };
    console.log(JSON.stringify(summary));
    appendFileSync(episodes, JSON.stringify({ summary, poses, people, incidents }) + "\n");
    return summary;
  }

  const rows = cases.map(({ stage, seed }, index) => {
    const stock = trial(stage, seed), preview = trial(stage, seed, CIVILIAN_TIMED_YIELD);
    const stockExact = stock.clean && stock.ticks === expected[index][0] && stock.people === expected[index][1];
    return { stock, preview, stockExact };
  });
  const previewClean = rows.filter(row => row.preview.clean).length;
  const stockPeople = rows.reduce((total, row) => total + row.stock.people, 0);
  const previewPeople = rows.reduce((total, row) => total + row.preview.people, 0);
  const passed = previewClean === cases.length && previewPeople < stockPeople &&
    rows.every(row => row.stockExact && row.preview.people <= row.stock.people);
  write("timed-yield.json", { passed, previewClean, stockPeople, previewPeople, rows });
  assert.ok(passed, "The candidate failed to retain four clean development escapes while reducing physical pedestrian contacts");
}

if (mode === "--local") local();
else transfer();
