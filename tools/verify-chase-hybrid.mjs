import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const { THREEJS_URL: base, PROVE_IT_OUTPUT_DIR: output } = process.env;
const checkpoint = fileURLToPath(new URL(
  "../.runtime-proof/pursuit-rl-dense-learning-20261120/corrective-trial-20261120-221352/checkpoint-1.json", import.meta.url));
const checkpointSha256 = createHash("sha256").update(await readFile(checkpoint)).digest("hex");
assert.equal(checkpointSha256, "854b284350457717cd2c299a0dc86604f2600ed989c1c9aac7ff497d0e5181e3");
const browser = await chromium.launch({ headless: false, args: ["--force-device-scale-factor=1"] });
const page = await browser.newPage({ viewport: { width: 1365, height: 900 } });
page.setDefaultTimeout(14000);
const id = name => page.locator(`#${name}`);
const wait = (fn, arg, timeout = 16000) => page.waitForFunction(fn, arg, { timeout });
const report = { pass: false, checkpointSha256, scope: "Controlled live pedestrian approaches in Metro, not release validation",
  errors: [], repeatedErrors: {}, cases: [] };
page.on("pageerror", error => {
  if (!Object.hasOwn(report.repeatedErrors, error.message)) report.errors.push(error.stack ?? error.message);
  report.repeatedErrors[error.message] = (report.repeatedErrors[error.message] ?? 0) + 1;
});
page.on("response", response => {
  if (response.status() >= 400) report.errors.push(`${response.status()} ${response.url()}`);
});

async function drive({ name, kind, camera, patrolProfile = null, fixedStart = null }) {
  await page.goto(base);
  await wait(() => window.sim?.view.actorDiagnostics().ready);
  await id("pauseBtn").click();
  await page.evaluate(({ kind, patrolProfile, fixedStart }) => {
    const sim = window.sim;
    sim.reset({ seed: "metro-hybrid-arbitration-01", traffic: 0, pedestrians: 1, chaos: 0, cityVersion: 4 });
    const { world } = sim, { player: ego } = world;
    const person = world.actors.find(actor => actor.type === "pedestrian");
    const road = world.drivingRoads.find(road => road.id === "tahrir-boulevard");
    const x = ego.x + 11.4, z = ego.z + 2.85;
    const target = kind === "parallel" ? { x: x + 10, z } : { x, z: ego.z - 4.2 };
    Object.assign(person, { kind: "man-polo", x, z, target, road, heading: kind === "parallel" ? Math.PI / 2 : Math.PI,
      speed: 0, walkSpeed: 1.28, crossing: kind === "crossing", pause: 0, walkRoute: [target],
      walkGoal: `${target.x},${target.z}`, walkPlanTick: 0, motionMode: "stop",
      district: { ...person.district, caseId: "hybrid-control-fixture", stage: "moving",
        routeConstrained: true, holdAtTarget: true, yieldAtCurb: false, origin: { x, z } } });
    person.previous = { ...person };
    world.updateSensors();
    if (patrolProfile) {
      const command = world.command;
      world.command = function (event) {
        if (event.type !== "street-pursuit-start") return command.call(this, event);
        this.command = command;
        return command.call(this, { ...event, config: { ...event.config, patrolChainYield: patrolProfile } });
      };
    }
    const data = { world, ego, person, homeZ: ego.z, rows: [], evidence: [], incidents: [], rangeFrames: [],
      step: world.step.bind(world) };
    if (fixedStart !== null) {
      // Keep the City physics clock paired despite asynchronous detector startup.
      data.preludeTick = fixedStart - 34;
      world.step = () => { if (world.tick < data.preludeTick) data.step(); };
    }
    window.__hybrid = data;
  }, { kind, patrolProfile, fixedStart });
  await id("pakoBtn").click();
  await id("pursuitLevel").selectOption("1");
  await id("pakoCheckpointChoice").locator("summary").click();
  await id("pursuitCheckpoint").setInputFiles(checkpoint);
  await wait(() => document.getElementById("pursuitScene").textContent.includes("Development checkpoint"));
  await id("driveSenseBtn").click();
  await id("driveSenseDetector").click();
  await id("pauseBtn").click();
  await wait(() => window.sim.cityPerception?.camera === "matched" && window.sim.cityPerception.people > 0, null, 29000);
  if (fixedStart !== null) await wait(() => window.__hybrid.world.tick === window.__hybrid.preludeTick);
  await page.evaluate(() => {
    const data = window.__hybrid, { world, person } = data;
    person.motionMode = "ambient";
    data.startTick = world.tick + 34;
    // Finish staging at the same accepted step even if a browser frame advances several ticks.
    world.step = () => { if (world.tick < data.startTick) data.step(); };
  });
  await wait(() => window.__hybrid.world.tick === window.__hybrid.startTick);
  await id("pauseBtn").click();
  if (!camera) {
    await id("driveSenseDetector").click();
    await wait(() => window.sim.cityPerception?.camera === "off");
  }
  const initial = await page.evaluate(() => {
    const data = window.__hybrid, { world, ego, person, homeZ } = data;
    ego.speed = 5.6;
    let lastRangeFrame = window.sim.cityPerception;
    world.step = () => {
      const run = world.pursuit;
      const active = run?.phase === "running";
      const speedBefore = ego.speed, tick = world.tick;
      const visual = world.visualState, driver = run?.frozenDriver;
      const causal = driver?.cameraBrake;
      const decision = driver?.lastDecision;
      data.step();
      if (!active || data.rows.length >= 480) return;
      const perception = window.sim.cityPerception;
      if (perception !== lastRangeFrame && perception) {
        data.rangeFrames.push({ tick, displayed: perception.rangeTick, physicsScan: run.gta.scan.tick });
        lastRangeFrame = perception;
      }
      const livePatrols = [...run.patrols].filter(p => p.aiState !== "WRECKED");
      const row = { tick: world.tick, t: world.tick - run.startedTick, phase: run.phase,
        ego: [ego.x, ego.z, ego.speed, ego.heading], walker: [person.x, person.z, person.speed],
        speedBefore, brake: decision?.submitted?.brake ?? null, requested: decision?.requested ?? null,
        guard: run.metrics.guard, shield: driver?.shieldReason ?? null, camera: causal ?? null,
        applied: run.appliedCommand ?? null, decisions: driver?.decisions ?? 0, patrols: livePatrols.length,
        lateralSlipMps: ego.gtaSlipMps,
        yieldingPatrols: livePatrols.filter(patrol => patrol.reason === "indirect-pedestrian-yield").map(patrol => patrol.id),
        visual: visual?.available ? { streamId: visual.streamId, frameId: visual.frameId, ageMs: visual.ageMs,
          reason: visual.decision?.reason, forecasts: visual.forecasts?.map(f => [f.label, f.trackId, f.reason]) } : null,
        gap: person.x - ego.x - ego.length / 2 - person.radius,
        inLane: Math.abs(person.z - homeZ) <= ego.width / 2 + person.radius };
      if (causal && (!data.evidence.length || data.evidence.at(-1).frameId !== causal.frameId)) {
        const result = window.sim.cameraResult(causal.streamId, causal.frameId);
        const frame = window.sim.cameraFrame(causal.streamId, causal.frameId);
        if (result && frame) data.evidence.push({ frameId: result.frameId, streamId: result.streamId,
          decisionTick: tick, sameFrame: result.frameId === frame.frameId && result.streamId === frame.streamId &&
            result.simulationTimeS === frame.simulationTimeS,
          detections: result.detections, jpeg: frame.imageJpegBase64, model: result.model.id });
      }
      data.rows.push(row);
      data.incidents.push(...run.stepEvents.filter(event =>
        ["patrol_collision", "static_or_civilian_hit", "ambient_collision"].includes(event.type)));
    };
    return { ego: [ego.x, ego.z, ego.speed], person: [person.x, person.z, person.speed], paused: window.sim.paused };
  });
  assert.ok(initial.paused);
  await id("pursuitRunBtn").click();
  await wait(() => window.__hybrid.rows.some(row => row.camera) ||
    window.__hybrid.rows.length >= 480 || window.sim.world.pursuit?.phase !== "running", null, 23000);
  await page.screenshot({ path: join(output, `${name}.png`) });
  await wait(() => window.__hybrid.rows.length >= 480 || window.sim.world.pursuit?.phase !== "running", null, 23000);
  const { rows, incidents, evidence, rangeFrames, identity, personId, activeProfile } = await page.evaluate(() => {
    const { rows, incidents, evidence, rangeFrames, world, person } = window.__hybrid;
    return { rows, incidents, evidence, rangeFrames, personId: person.id, identity: world.pursuit.frozenDriver?.sha256,
      activeProfile: world.pursuit.gta.config.patrolChainYield ?? null };
  });
  assert.equal(activeProfile, patrolProfile);
  const byCamera = rows.filter(row => row.camera);
  for (const item of evidence) {
    const file = `${name}-frame-${item.frameId}.jpg`;
    await writeFile(join(output, file), Buffer.from(item.jpeg, "base64"));
    item.image = file;
    delete item.jpeg;
  }
  const matched = byCamera.find(row => row.camera.reason === "observed-person-crossing-conflict" &&
    row.requested?.throttle > 0 && row.brake === 1 &&
    row.shield === null && row.ego[2] < row.speedBefore - .07 && row.gap > 0 && !row.inLane &&
    evidence.some(item => item.sameFrame && item.streamId === row.camera.streamId && item.frameId === row.camera.frameId &&
      item.detections.some(detection => detection.label === "person")));
  const walkerContact = incidents.some(event => event.actorId === personId || event.first?.id === personId || event.second?.id === personId);
  const verdict = { name, kind, camera, initial, identity, activeProfile, ticks: rows.length, terminal: rows.at(-1)?.phase,
    clockAtStart: rows[0]?.tick - 1, matched,
    firstRangeVeto: rows.find(row => row.shield === "pedestrian")?.t ?? null,
    firstPhysicalEntry: rows.find(row => row.inLane)?.t ?? null, cameraTicks: byCamera.length,
    personClassifiedWhileRunning: rows.some(row => row.visual?.forecasts.some(([label]) => label === "person")),
    walkerContact, incidents, evidence, rangeFrames, rows };
  report.cases.push(verdict);
  console.log(JSON.stringify({ name, ticks: rows.length, cameraTicks: byCamera.length, causalTick: matched?.t,
    firstRangeVeto: verdict.firstRangeVeto, firstPhysicalEntry: verdict.firstPhysicalEntry, walkerContact,
    incidents: incidents.length, phases: [...new Set(rows.map(row => row.visual?.reason))] }));
  if (camera) {
    await id("driveSenseDetector").click();
    await wait(() => window.sim.cityPerception?.camera === "off");
  }
}

try {
  await drive({ name: "crossing-camera", kind: "crossing", camera: true });
  await drive({ name: "crossing-range", kind: "crossing", camera: false });
  const testLateral = process.env.PAKO_TEST_LATERAL_TRANSFER === "1";
  await drive({ name: "parallel-camera", kind: "parallel", camera: true, fixedStart: testLateral ? 81 : null });
  const [positive, range, parallel] = report.cases;
  if (testLateral) {
    await drive({ name: "parallel-lateral-preview", kind: "parallel", camera: true,
      patrolProfile: "indirect-pedestrian-yield-v2", fixedStart: 81 });
    const transfer = report.cases.at(-1);
    report.lateralTransfer = {
      matchedInitial: JSON.stringify(transfer.initial) === JSON.stringify(parallel.initial),
      matchedClock: transfer.clockAtStart === 81 && parallel.clockAtStart === 81,
      baselineWalkerContact: parallel.walkerContact, walkerContact: transfer.walkerContact,
      firstYield: transfer.rows.find(row => row.yieldingPatrols.length)?.t ?? null,
      patrolContacts: transfer.incidents.filter(event => event.fresh && event.type === "patrol_collision").length,
      completedTicks: transfer.ticks,
    };
  }
  report.pass = Boolean(positive.matched && positive.firstPhysicalEntry > positive.matched.t &&
    range.firstRangeVeto > positive.matched.t &&
    (positive.firstRangeVeto === null || positive.firstRangeVeto > positive.matched.t) &&
    !positive.walkerContact && positive.rows.some(row => row.patrols > 0) &&
    range.cameraTicks === 0 && parallel.cameraTicks === 0 && parallel.personClassifiedWhileRunning &&
    JSON.stringify(positive.initial) === JSON.stringify(range.initial) &&
    report.cases.every(item => item.identity === checkpointSha256 && (item.ticks === 480 || item.terminal !== "running")) &&
    report.cases.every(item => item.rangeFrames.length >= 3 &&
      item.rangeFrames.every(({ displayed, tick, physicsScan }) => Number.isSafeInteger(displayed) &&
        displayed <= physicsScan && tick - displayed <= 5)) &&
    report.errors.length === 0);
  assert.ok(report.pass, "The headed traces do not establish a causal real-camera brake before the independent range guard");
} finally {
  await writeFile(join(output, "chase-hybrid.json"), JSON.stringify(report, null, 2) + "\n");
  await browser.close();
}
