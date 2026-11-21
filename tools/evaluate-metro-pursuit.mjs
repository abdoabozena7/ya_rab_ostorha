import { createHash } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { freezePursuitPolicy, PursuitPpo } from "../src/rl/pursuit-ppo.js";
import { isDispatchIncident, runPursuitEpisode } from "../src/rl/pursuit-rollouts.js";
import { cityRouteCurriculum, curriculum, routeCurriculum, scripted } from "./train-metro-pursuit.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const protocolPath = "config/pursuit-rl-acceptance-protocol.json";
const protocolBytes = await readFile(join(root, protocolPath));
const protocol = JSON.parse(protocolBytes);
const knownSeeds = new Set([curriculum, routeCurriculum, cityRouteCurriculum]
  .flatMap(manifest => [...manifest.trainingSeeds, ...manifest.validationSeeds]));
const fingerprint = bytes => createHash("sha256").update(bytes).digest("hex");
const protocolSha256 = fingerprint(protocolBytes);
const benchmarkInputs = [
  protocolPath, "config/pursuit-rl-development.json", "config/pursuit-rl-route-development.json",
  "config/pursuit-rl-city-route-development.json", "package.json", "package-lock.json",
  "tools/evaluate-metro-pursuit.mjs", "tools/train-metro-pursuit.mjs", "tools/metro-route-demonstrations.mjs",
];

async function sourceIdentity() {
  const tree = await readdir(join(root, "src"), { recursive: true, withFileTypes: true });
  const paths = benchmarkInputs.concat(tree.filter(entry => entry.isFile()).map(entry => {
    const directory = entry.parentPath.slice(root.length).replaceAll("\\", "/");
    return `${directory}/${entry.name}`;
  })).sort();
  const files = Object.fromEntries(await Promise.all(paths.map(async path =>
    [path, fingerprint(await readFile(join(root, path)))])));
  return { sha256: fingerprint(JSON.stringify(files)), files };
}

function populationAudit({ traffic, pedestrians }) {
  const evidence = { initial: null, last: null, originalIds: [], samples: 0, peakPatrols: 0, retained: false };
  let original;
  return { evidence, sample(world) {
    const present = new Set(), counts = { traffic: 0, pedestrians: 0 };
    for (const actor of world.actors) {
      if (actor === world.player || world.pursuit.patrols.has(actor)) continue;
      if (actor.type === "vehicle") counts.traffic++;
      else if (actor.type === "pedestrian") counts.pedestrians++;
      else continue;
      present.add(actor);
    }
    if (!original) {
      original = new Map([...present].map(actor => [actor, { id: actor.id, type: actor.type }]));
      evidence.initial = counts;
      evidence.originalIds = [...original.values()].map(actor => actor.id).sort();
    }
    evidence.last = counts;
    evidence.samples++;
    evidence.peakPatrols = Math.max(evidence.peakPatrols, world.pursuit.patrols.size);
    const missingIds = [], changedIds = [], addedIds = [];
    for (const [actor, { id, type }] of original) {
      if (!present.has(actor)) missingIds.push(id);
      else if (actor.id !== id || actor.type !== type) changedIds.push(id);
    }
    for (const actor of present) if (!original.has(actor)) addedIds.push(actor.id);
    evidence.retained = counts.traffic === traffic && counts.pedestrians === pedestrians &&
      present.size === counts.traffic + counts.pedestrians && new Set(evidence.originalIds).size === original.size &&
      missingIds.length === 0 && changedIds.length === 0 && addedIds.length === 0;
    if (!evidence.retained) {
      evidence.mismatch = { tick: world.tick, missingIds, changedIds, addedIds };
      throw new Error(`Metro ambient population or actor identity changed at tick ${world.tick}`);
    }
  } };
}

export function admitMetroHoldout(manifest) {
  const required = protocol.levels.reduce((sum, level) => sum + level.episodes, 0);
  if (manifest?.schema !== 1 || manifest.mode !== protocol.mode || !Array.isArray(manifest.cases) || manifest.cases.length !== required)
    throw new Error(`Expected a frozen ${required}-episode Metro holdout manifest`);
  const seeds = new Set(), pattern = new RegExp(protocol.seedPattern);
  for (const row of manifest.cases) {
    if (!row || typeof row.seed !== "string" || knownSeeds.has(row.seed) || !pattern.test(row.seed) || seeds.has(row.seed))
      throw new Error("Holdout contains an invalid, repeated, or development seed");
    if (!protocol.levels.some(profile => profile.level === row.level) || !Object.hasOwn(protocol.population, row.density))
      throw new Error("Holdout case has an invalid level or population");
    seeds.add(row.seed);
  }
  for (const profile of protocol.levels) {
    const sameLevel = manifest.cases.filter(row => row.level === profile.level);
    if (sameLevel.length !== profile.episodes || sameLevel.filter(row => row.density === "dense").length !== profile.dense)
      throw new Error("Holdout does not match the predeclared level and density allocation");
  }
  return manifest.cases;
}

function interval(hits, n) {
  if (!n) return null;
  const rate = hits / n, z2 = 1.959963984540054 ** 2, denominator = 1 + z2 / n;
  const mid = (rate + z2 / (2 * n)) / denominator;
  const width = Math.sqrt((rate * (1 - rate) + z2 / (4 * n)) / n) * Math.sqrt(z2) / denominator;
  return { hits, n, rate, interval95: [Math.max(0, mid - width), Math.min(1, mid + width)] };
}

export function summarizeMetroArm(rows) {
  const failures = {};
  let escape = 0, cleanEscape = 0, contacts = 0, closePasses = 0, pedestrians = 0;
  let ambientContacts = 0, ambientPedestrianImpacts = 0;
  for (const row of rows) {
    if (row.error) {
      failures.error = (failures.error ?? 0) + 1;
      continue;
    }
    contacts += row.collisions;
    closePasses += row.nearMisses;
    pedestrians += row.pedestrianImpacts;
    ambientContacts += row.ambientCollisions ?? 0;
    ambientPedestrianImpacts += row.ambientPedestrianImpacts ?? 0;
    if (row.phase === "escaped" && row.pursuitQualified) {
      escape++;
      if (row.collisions === 0) cleanEscape++;
      else failures.escapeWithContact = (failures.escapeWithContact ?? 0) + 1;
    } else {
      const key = row.phase === "escaped" ? "unqualifiedEscape" : row.phase;
      failures[key] = (failures[key] ?? 0) + 1;
    }
  }
  return { legitimate: interval(escape, rows.length), collisionFree: interval(cleanEscape, rows.length),
    contacts, closePasses, pedestrians, ambientContacts, ambientPedestrianImpacts, failures };
}

export async function evaluateMetroPairing(checkpoint, cases, seconds, recordEpisode = () => {}) {
  const source = await sourceIdentity();
  const runtime = { node: process.version, v8: process.versions.v8, platform: process.platform, arch: process.arch };
  const frozen = freezePursuitPolicy(checkpoint);
  const untrained = new PursuitPpo(checkpoint.seed, null, checkpoint.observation);
  const controllers = { frozen: frozen.action, untrained: obs => untrained.action(obs), scripted };
  const results = [];
  for (const entry of cases) {
    const profile = protocol.levels.find(row => row.level === entry.level);
    const [traffic, pedestrians] = protocol.population[entry.density];
    const stage = { observation: frozen.observation, wantedLevel: profile.level, wantedLevelMax: profile.level,
      patrols: profile.patrols, traffic, pedestrians, episodeSeconds: seconds };
    const arms = {};
    for (const [name, select] of Object.entries(controllers)) {
      const incidents = [], motion = createHash("sha256"), population = populationAudit(stage);
      try {
        const result = runPursuitEpisode(stage, entry.seed, select, false, (row, events) => {
          if (!row.slice(0, 5).every(Number.isFinite)) throw new Error("Nonfinite accepted pose");
          motion.update(JSON.stringify(row));
          for (const event of events) if (isDispatchIncident(event)) incidents.push(event);
        }, population.sample);
        arms[name] = { ...result.metrics, digest: motion.digest("hex"), incidents, population: population.evidence };
      } catch (error) {
        arms[name] = { error: error.message, digest: motion.digest("hex"), incidents, population: population.evidence };
      }
      await recordEpisode({ ...entry, arm: name, sourceSha256: source.sha256, metrics: arms[name] });
    }
    results.push({ ...entry, arms });
  }
  const levels = protocol.levels.map(profile => {
    const byLevel = results.filter(row => row.level === profile.level);
    return { level: profile.level, ...Object.fromEntries(Object.keys(controllers)
      .map(arm => [arm, summarizeMetroArm(byLevel.map(row => row.arms[arm]))])) };
  });
  const sourceAfterSha256 = (await sourceIdentity()).sha256;
  return { levels, results, provenance: { runtime, protocolSha256, source, sourceAfterSha256,
    sourceStable: source.sha256 === sourceAfterSha256 && source.files[protocolPath] === protocolSha256 } };
}

async function main() {
  const { values } = parseArgs({ options: {
    checkpoint: { type: "string" }, candidateSha: { type: "string" },
    manifest: { type: "string" }, manifestSha: { type: "string" }, output: { type: "string" },
  } });
  if (![values.checkpoint, values.manifest, values.output].every(Boolean) ||
      ![values.candidateSha, values.manifestSha].every(s => /^[a-f0-9]{64}$/.test(s ?? "")))
    throw new Error("Supply --checkpoint, --candidateSha, --manifest, --manifestSha and a new --output directory");
  const candidate = await readFile(values.checkpoint);
  if (fingerprint(candidate) !== values.candidateSha) throw new Error("Checkpoint digest does not match the frozen candidate");
  const checkpoint = JSON.parse(candidate);
  freezePursuitPolicy(checkpoint);
  const manifest = await readFile(values.manifest);
  if (fingerprint(manifest) !== values.manifestSha) throw new Error("Holdout digest does not match the independently frozen manifest");
  const cases = admitMetroHoldout(JSON.parse(manifest));
  await mkdir(values.output);
  const receipt = join(values.output, "episodes.ndjson");
  const report = await evaluateMetroPairing(checkpoint, cases, protocol.episodeSeconds,
    row => appendFile(receipt, JSON.stringify(row) + "\n"));
  const escapeThresholdsMet = protocol.levels.every(profile => !profile.escapeThreshold ||
    report.levels.find(row => row.level === profile.level).frozen.legitimate.rate >= profile.escapeThreshold);
  const arms = ["frozen", "scripted", "untrained"];
  const errors = report.levels.reduce((total, row) => total + arms
    .reduce((n, arm) => n + (row[arm].failures.error ?? 0), 0), 0);
  const collisionFreeRates = Object.fromEntries(arms.map(arm => [arm,
    report.levels.reduce((total, row) => total + row[arm].collisionFree.hits, 0) / cases.length]));
  const collisionFreeGain = collisionFreeRates.frozen - Math.max(collisionFreeRates.scripted, collisionFreeRates.untrained);
  const collisionFreeGainMet = collisionFreeGain >= protocol.minimumCollisionFreeRateGain;
  const summary = { protocol, candidateSha: values.candidateSha, manifestSha: values.manifestSha,
    escapeThresholdsMet, collisionFreeRates, collisionFreeGain, collisionFreeGainMet, errors,
    levels: report.levels, provenance: report.provenance };
  await writeFile(join(values.output, "summary.json"), JSON.stringify(summary, null, 2), { flag: "wx" });
  console.log(JSON.stringify(summary, null, 2));
  if (!report.provenance.sourceStable)
    console.error("Metro evaluator sources changed during the benchmark; the result is not valid.");
  if (!escapeThresholdsMet || !collisionFreeGainMet || errors || !report.provenance.sourceStable) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
