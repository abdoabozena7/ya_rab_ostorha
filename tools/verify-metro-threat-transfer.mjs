import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CLEARANCE_ROUTE_OBSERVATION_SCHEMA as schema } from "../src/rl/gta-pursuit-env.js";
import { run } from "./train-metro-lateral-development.mjs";
import { createFrozenThreatDriver, createThreatContext, loadThreatPrior } from "./train-metro-threat-development.mjs";

const output = process.env.PROVE_IT_OUTPUT_DIR;
assert.ok(output, "Set a new proof output directory");
const envelope = new URL("../.runtime-proof/pursuit-rl-threat-envelope-20261121/revision-2/runs/learning/20261121T040230-bed272cab7/", import.meta.url);
const predecessor = new URL("../.runtime-proof/pursuit-rl-threat-development-20261121/runs/fit/20261121T034335-0ae6dd5f61/threat-context-checkpoint.json", import.meta.url);
const digest = data => createHash("sha256").update(data).digest("hex");

async function load(url, expected) {
  const bytes = await readFile(url);
  assert.equal(digest(bytes), expected, `Changed preserved input: ${url.pathname}`);
  return JSON.parse(bytes);
}

function visiblePatrols(obs) {
  const { tracks, scales } = schema;
  const visible = [];
  for (let i = 0; i < tracks.count; i++) {
    const [present, , , , police, right, forward, rightRate, forwardRate, age, motionKnown, ttcKnown, ttc] =
      obs.subarray(tracks.offset + i * tracks.stride, tracks.offset + (i + 1) * tracks.stride);
    if (present && police) visible.push({ rightM: right * scales.offsetM, forwardM: forward * scales.offsetM,
      rightMps: motionKnown ? rightRate * scales.relativeSpeedMps : null,
      forwardMps: motionKnown ? forwardRate * scales.relativeSpeedMps : null,
      ageS: age * scales.ageS, ttcS: ttcKnown ? ttc * scales.ttcS : null });
  }
  return visible;
}

function replay(site, expected, select) {
  const { samples, summary, motionAudit } = run(site, "combined", select, expected.plan, expected.tick, true);
  assert.deepEqual(summary, Object.fromEntries(Object.entries(expected).filter(([key]) => key !== "stats")),
    "Instrumented run must retain the entire measured trace and score");
  assert.equal(samples.length, motionAudit.length);
  const observe = createThreatContext();
  let entry;
  const decisions = samples.map(({ obs, action }, i) => {
    const state = motionAudit[i];
    assert.equal(state.tick + 6, summary.trace[i + 2].tick);
    const features = observe(obs);
    if (features) entry ??= state;
    return { ...state, inputSha256: digest(Buffer.from(obs.buffer)), action, visiblePatrols: visiblePatrols(obs),
      estimate: features ? { headingRad: features[3] * .8, lateralM: features[4] * 8, forwardM: features[5] * 35,
        fixedRearClosingMps: features[9] * 8 } : null,
      acceptedSinceEntry: features ? { headingRad: state.headingRad - entry.headingRad,
        lateralM: state.lateralM - entry.lateralM, forwardM: state.forwardM - entry.forwardM } : null };
  });
  const firstDenial = decisions.find(row => row.firstDenialTick !== null)?.firstDenialTick ?? null;
  const beforeDenial = decisions.filter(row => row.estimate && (firstDenial === null || row.tick < firstDenial));
  const maxError = key => Math.max(...beforeDenial.map(row => Math.abs(row.estimate[key] - row.acceptedSinceEntry[key])));
  const byOnset = decisions.find(row => row.firstDenialTick !== null);
  assert.ok(beforeDenial.length > 15);
  return { exact: true, decisions, firstDenial, clearanceTick: summary.firstClearTick,
    roadBoundaryTicks: summary.roadBoundaryTicks, postClearAdvanceM: summary.postClearAdvanceM,
    freshRearHits: summary.incidents.filter(event => event.type === "patrol_collision" && event.fresh),
    peakPreDenialError: { headingRad: maxError("headingRad"), lateralM: maxError("lateralM"), forwardM: maxError("forwardM") },
    onset: byOnset ? { tick: byOnset.tick, rightMarginM: byOnset.rightMarginM, headingRad: byOnset.headingRad,
      wheelSteerRad: byOnset.steerRad, requestedSteer: byOnset.action.steer, tailForwardM: byOnset.tailForwardM,
      visiblePatrols: byOnset.visiblePatrols } : null };
}

const old = await load(new URL("threat-envelope.json", envelope), "2d2f8417050624cb792fed9d575fea0860e30237ee800d56219a0a3e827eee60");
const saved = await load(new URL("threat-envelope-checkpoint.json", envelope), "ffdcf6bb0323c33ac6640e547a0cc6031e565f21af8d8422bfc98f4475ae3985");
const previous = await load(predecessor, old.previousSha256);
const prior = await loadThreatPrior();
const cases = [];
for (const [i, row] of old.validation.entries()) {
  const teacher = replay(row.site, old.controls[i].reference, () => assert.fail("The reference became a learner"));
  const oldDriver = createFrozenThreatDriver(prior, previous);
  const warmDriver = createFrozenThreatDriver(prior, saved, "warm");
  const rejectedDriver = createFrozenThreatDriver(prior, saved);
  const priorArm = replay(row.site, row.previous, oldDriver.select);
  const warm = replay(row.site, row.warm, warmDriver.select);
  const frozen = replay(row.site, row.frozen, rejectedDriver.select);
  assert.deepEqual(oldDriver.stats, row.previous.stats);
  assert.deepEqual(warmDriver.stats, row.warm.stats);
  assert.deepEqual(rejectedDriver.stats, row.frozen.stats);
  assert.equal(teacher.decisions[0].inputSha256, frozen.decisions[0].inputSha256);
  assert.ok(teacher.postClearAdvanceM > frozen.postClearAdvanceM && teacher.firstDenial === null);
  assert.ok(frozen.firstDenial > frozen.clearanceTick);
  cases.push({ site: row.site, teacher, prior: priorArm, warm, frozen });
}
const report = { scope: "original wider Metro development; scorer-only physical state", node: process.version,
  unchangedArms: cases.flatMap(({ teacher, prior, warm, frozen }) => [teacher, prior, warm, frozen])
    .filter(arm => arm.exact).length,
  failedArms: cases.filter(row => row.frozen.firstDenial !== null).length,
  freshRearHits: cases.reduce((sum, row) => sum + row.frozen.freshRearHits.length, 0),
  referenceDenials: cases.reduce((sum, row) => sum + row.teacher.roadBoundaryTicks, 0), cases };
await writeFile(join(output, "threat-transfer.json"), JSON.stringify(report), { flag: "wx" });
assert.deepEqual(cases.map(row => row.frozen.roadBoundaryTicks), [31, 24, 34, 58]);
for (const { site, teacher, frozen } of cases) {
  console.log(JSON.stringify({ road: site[0], speed: site[3], teacherPeakError: teacher.peakPreDenialError,
    peakError: frozen.peakPreDenialError, onset: frozen.onset, firstDenial: frozen.firstDenial,
    rearHits: frozen.freshRearHits.map(({ tick, closingSpeed }) => ({ tick, closingSpeed })) }));
}
