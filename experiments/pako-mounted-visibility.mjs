import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { angleDelta, distance } from "../src/core/geometry.js";
import { PURSUIT_SCAN_TICKS, samplePursuitCornerRays } from "../src/signal_processing/pursuit-scanner.js";
import { evaluateChoice, fitStarts, matchChoiceSurfaces, measureChoice, obstructions } from "./pako-onward-choice.mjs";

const output = process.env.PROVE_IT_OUTPUT_DIR;
assert.ok(output, "Use a fresh PROVE_IT_OUTPUT_DIR");
const population = { traffic: 36, pedestrians: 80 };
const start = { ...fitStarts[0], offsetM: fitStarts[0].offsetM + 4 };
const cases = [
  { layout: "clear", mode: "corner", expected: 0 },
  { layout: "civic", mode: "center", expected: 0 },
  { layout: "civic", mode: "repeat-pair", expected: 0 },
  { layout: "civic", mode: "corner", expected: 1 },
];
const cautionMarginM = .725, faceToleranceM = .25;
const put = (name, data) => writeFileSync(join(output, name), JSON.stringify(data, null, 2) + "\n", { flag: "wx" });
put("protocol.json", { cases, population, start, cautionMarginM, faceToleranceM,
  scope: "Two known populated Metro regression starts, one healthy original patrol each. First returns alone supply the route cue; the shared follower, geometry and primary safety guard remain unchanged. No training or protected data.",
  oracle: "Confirm a positive two-corner observation with a fresh return on the next sample. A missing return never certifies clearance. Check the whole accepted chase and report ambient contacts separately." });

function runCase({ layout, mode, expected }) {
  const obstruction = obstructions[layout], seed = `pako-population-probe-01:36:${layout}`;
  const frames = [];
  let sample, previousPair, fork, decided = false;
  const result = evaluateChoice(start, obstruction, null, mode, seed, {
    population, recordReward: true,
    observe(world) {
      if (mode !== "center" && !decided && world.player.z >= start.decisionZ &&
          Math.abs(angleDelta(world.player.heading, 0)) < .2) sample = samplePursuitCornerRays(world);
    },
    onward: { obstruction, select(ego, scan, paths) {
      if (ego.z < start.decisionZ || Math.abs(angleDelta(ego.heading, 0)) >= .2) return null;
      const lane = paths[0].at(-1).x;
      fork ??= paths[1].find(point => point.z > start.decisionZ + 7 && Math.abs(point.x - lane) >= .08);
      assert.ok(fork, "The admitted public paths must diverge");
      const primary = measureChoice(ego, scan, paths);
      const returns = sample?.tick === scan.tick ? sample.rays.flatMap((ray, i) => ray.kind === "static"
        ? [{ ...ray, ray: i }] : []) : [];
      const [direct, alternate] = matchChoiceSurfaces(ego, paths, returns, cautionMarginM);
      const left = direct.filter(ray => ray.mount === "left-outer");
      let pair = null;
      for (const a of left) {
        const b = direct.find(ray => ray.mount === "right-outer" && Math.abs(a.alongM - ray.alongM) < 1 &&
          distance(a, ray) >= ego.width);
        if (b) { pair = [a, b]; break; }
      }
      const prior = previousPair?.tick === scan.tick - PURSUIT_SCAN_TICKS ? previousPair : null;
      // Keep the second edge unknown when it leaves view; do not fill in the shadow.
      const repeats = ray => prior.points.some(point =>
        point.mount === ray.mount && distance(point, ray) <= faceToleranceM);
      const witness = prior && (mode === "corner" ? direct.find(repeats) : pair?.every(repeats) && pair[0]);
      previousPair = pair ? { tick: scan.tick, points: pair } : null;
      const evidence = { tick: scan.tick, primary, pair, ...(witness && { repeatedFrom: prior, witness }) };
      frames.push(evidence);
      const change = Boolean((primary[0].length || witness) && !primary[1].length && !alternate.length);
      if (!change && fork.z - ego.z > Math.max(8, .8 * ego.speed)) return null;
      decided = true;
      return { index: Number(change), evidence, reason: change ? "observed-obstruction" : "commit-boundary" };
    } },
  });
  assert.deepEqual(result.population, { ...population, missing: 0 });
  assert.equal(result.selection?.index, expected);
  assert.ok(result.alive && result.obstructionIntact && result.selection.tick === result.selection.scanTick);
  assert.ok(result.selection.tick > result.cleared.tick);
  assert.ok(frames.every(frame => frame.primary.every(hits => !hits.length)));
  const attempts = { layout, mode, full: result.full, choice: result.selection.index, ticks: result.ticks, outcome: result.phase,
    egoContacts: result.collisions, roadDenials: result.denied, ambientContacts: result.ambientContacts.length,
    ambientPedestrianContacts: result.ambientContacts.filter(event =>
      [event.first, event.second].some(actor => actor.type === "pedestrian")).length,
    selection: result.selection };
  console.log(JSON.stringify(attempts));
  return { ...attempts, frames, result };
}

const rows = cases.map(runCase);
const [clear, center, strict, candidate] = rows;
const prefix = row => row.result.traces.filter(({ tick }) => tick <= candidate.selection.tick)
  .map(({ tick, ego, tail }) => [tick, ego, tail]);
const matchedPrefix = JSON.stringify(prefix(center)) === JSON.stringify(prefix(candidate)) &&
  JSON.stringify(prefix(strict)) === JSON.stringify(prefix(candidate));
const candidateClean = Number(clear.full) + Number(candidate.full);
const controlsClean = Number(clear.full) + Number(center.full);
const passed = matchedPrefix && candidateClean === 2 && controlsClean === 1 && !strict.full &&
  center.outcome === "timeout" && strict.outcome === "timeout" &&
  clear.egoContacts === 0 && candidate.egoContacts === 0 && clear.roadDenials === 0 && candidate.roadDenials === 0 &&
  Boolean(candidate.selection.evidence.witness && candidate.selection.evidence.repeatedFrom.points.length === 2);
put("mounted-visibility.json", { passed, candidateClean, controlsClean, matchedPrefix, rows });
assert.ok(passed, "Mounted corner evidence did not resolve the actual paired populated chase");
