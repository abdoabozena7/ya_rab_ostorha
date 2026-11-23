import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { STEP } from "../src/core/config.js";
import { angleDelta, distance } from "../src/core/geometry.js";
import { CLEAN_ESCAPE_REWARD } from "../src/rl/gta-pursuit-env.js";
import { PURSUIT_TRACK_TTL_S } from "../src/signal_processing/pursuit-scanner.js";
import { fit, run } from "./pako-connected-window.mjs";

const fitSite = fit.find(site => site.entry === "station-avenue");
export const fitStarts = [
  { offsetM: -1.15, speedMps: 5.3, lateralM: -.23, decisionZ: -21 },
  { offsetM: -.45, speedMps: 5.45, lateralM: -.1, decisionZ: -20 },
];
export const obstructions = {
  clear: null,
  civic: { road: "civic-avenue", sign: 1, along: 16.5, length: 1.1, width: 3.2 },
  souq: { road: "souq-collector", sign: -1, along: -191.8, length: 1.1, width: 2.5 },
};

function projectScan(ego, scan) {
  return scan.rays.flatMap(({ rangeM, kind }, i) => {
    if (kind !== "static") return [];
    const angle = ego.heading + i * 2 * Math.PI / scan.rays.length;
    return [{ ray: i, rangeM, seenTick: scan.tick,
      x: ego.x + rangeM * Math.sin(angle), z: ego.z + rangeM * Math.cos(angle) }];
  });
}

function corridorReturns(ego, path, surfaces, padM = .12) {
  const rear = { x: ego.x - ego.wheelbase / 2 * Math.sin(ego.heading), z: ego.z - ego.wheelbase / 2 * Math.cos(ego.heading) };
  const nearest = path.reduce((k, point, i) => distance(point, rear) < distance(path[k], rear) ? i : k, 0);
  let along = 0;
  const hits = new Map();
  for (let i = nearest + 1; i < path.length && along < 45; i++) {
    const a = path[i - 1], b = path[i], length = distance(a, b);
    const sx = (b.x - a.x) / length, sz = (b.z - a.z) / length;
    along += length;
    for (const point of surfaces) {
      if (hits.has(point.ray)) continue;
      const dx = point.x - b.x, dz = point.z - b.z;
      const forward = dx * sx + dz * sz - ego.wheelbase / 2;
      if (Math.abs(forward) <= ego.length / 2 && Math.abs(dx * sz - dz * sx) <= ego.width / 2 + padM)
        hits.set(point.ray, { ...point, alongM: along });
    }
  }
  return [...hits.values()];
}

export function measureChoice(ego, scan, paths) {
  return matchChoiceSurfaces(ego, paths, projectScan(ego, scan), .12);
}

export const matchChoiceSurfaces = (ego, paths, surfaces, padM) =>
  paths.map(path => corridorReturns(ego, path, surfaces, padM));

function observeRouteEvidence() {
  const last = [];
  return (ego, scan, paths) => {
    const latest = measureChoice(ego, scan, paths);
    const recent = latest.map((hits, index) => {
      if (hits.length) return (last[index] = hits);
      const prior = last[index];
      // Recheck a real world-space return against the route still ahead. Never refresh its time.
      return prior && (scan.tick - prior[0].seenTick) * STEP < PURSUIT_TRACK_TTL_S
        ? corridorReturns(ego, paths[index], prior) : [];
    });
    return { latest, recent };
  };
}

export function evaluateChoice(start, obstruction, select, arm, seed, extra = {}) {
  const observe = observeRouteEvidence();
  return run(fitSite, { ...start, path: 0, arm, seed, rewardProfile: CLEAN_ESCAPE_REWARD,
    onward: { obstruction, select(ego, scan, paths) {
      if (Math.abs(angleDelta(ego.heading, 0)) >= .2) return null;
      const { latest, recent } = observe(ego, scan, paths);
      if (ego.z < start.decisionZ) return null;
      return { ...select({ returns: recent, latest, ego, scan }), heard: recent, latest };
    } }, ...extra });
}

export const measured = ({ returns }) => ({ index: Number(returns[0].length > 0 && returns[1].length === 0) });

function main() {
  const output = process.env.PROVE_IT_OUTPUT_DIR;
  assert.ok(output, "Use a fresh PROVE_IT_OUTPUT_DIR");
  const write = (name, value) => writeFileSync(join(output, name), JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
  write("protocol.json", { fitStarts, obstructions, routes: [fitSite.direct, fitSite.connected],
    evidence: "Compare first-return static endpoints against the next 45 m of each public path. At the post-turn decision, retain a positive static return for at most the scan track TTL if it still lies on the route ahead.",
    oracle: "Full guarded escape, live intact patrol, both paths clear the first turn with an identical tick-level accepted prefix.",
    scope: "Local scripted fit feasibility, no new weights or City runtime behavior." });

  const pairs = fitStarts.flatMap((start, i) => Object.entries(obstructions).map(([layout, obstacle]) => {
    const seed = `pako-onward-discrimination-fit-01:${i}:${layout}`;
    const arms = [["direct", () => ({ index: 0 })], ["connected", () => ({ index: 1 })], ["measured", measured]]
      .map(([arm, choose]) => evaluateChoice(start, obstacle, choose, arm, seed));
    const matched = arms.every(row => row.selection?.tick > row.cleared?.tick &&
      row.selection.tick === row.selection.scanTick && row.cleared.tick === arms[0].cleared.tick &&
      row.approach === arms[0].approach && row.obstructionIntact && row.alive);
    const [direct, connected, chosen] = arms;
    const expected = layout === "civic" ? 1 : 0;
    const correct = layout === "clear" ? direct.full && connected.full && chosen.full
      : arms[expected].full && !arms[1 - expected].full && chosen.full && chosen.selection?.index === expected &&
        chosen.selection.heard[1 - expected].length > 0 && chosen.selection.heard[expected].length === 0;
    console.log(JSON.stringify({ layout, i, matched, correct, arms: arms.map(row => ({
      arm: row.arm, full: row.full, phase: row.phase, ticks: row.ticks, decision: row.selection?.tick,
      chosen: row.selection?.index, returns: row.selection?.heard.map(hits => hits.length),
      cleared: row.cleared?.tick, firstContact: row.contacts[0]?.tick, denied: row.denied })) }));
    return { layout, i, matched, correct, arms };
  }));
  const qualified = pairs.filter(pair => pair.correct && pair.matched);
  const qualifiedPairs = qualified.filter(pair => pair.layout !== "clear").length;
  const matchedPrefix = pairs.every(pair => pair.matched);
  const selectionPassed = matchedPrefix && Object.keys(obstructions).every(layout => qualified.some(pair => pair.layout === layout));
  write("onward-choice.json", { selectionPassed, matchedPrefix, qualifiedPairs, pairs });
  assert.ok(selectionPassed, "No matched two-sided post-turn choice that achieves full clean physical escape");
}

if (fileURLToPath(import.meta.url).toLowerCase() === process.argv[1]?.toLowerCase()) main();
