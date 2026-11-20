import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const { PROVE_IT_OUTPUT_DIR: output, THREEJS_URL: base } = process.env;
const browser = await chromium.launch({ headless: false, args: ["--force-device-scale-factor=1"] });
const page = await browser.newPage({ viewport: { width: 1365, height: 900 }, deviceScaleFactor: 1 });
page.setDefaultTimeout(18_000);
const report = { errors: [] };
page.on("pageerror", error => report.errors.push(error.message));
page.on("console", event => { if (event.type() === "error") report.errors.push(event.text()); });
page.on("response", response => { if (response.status() >= 400) report.errors.push(response.url()); });
const id = value => page.locator(`#${value}`);
const wait = (fn, arg) => page.waitForFunction(fn, arg);
const shot = name => page.screenshot({ path: join(output, `${name}.png`) });
const ready = () => wait(() => window.sim?.view.actorDiagnostics().ready);

async function openPanel() {
  if (!await id("pursuitPanel").isVisible()) await id("streetPursuitBtn").click();
  await id("pursuitRunBtn").waitFor({ state: "visible" });
  if (await id("pursuitStyle").isVisible()) await id("pursuitStyle").selectOption("hunt");
}

async function startCity(training = false) {
  await openPanel();
  if (training) await id("pursuitLearn").check();
  else await id("pursuitLearn").uncheck();
  await id("pursuitRunBtn").click();
  await wait(() => window.sim.world.pursuit?.phase === "running");
}

async function prepareCity(pose, extra = {}) {
  await page.evaluate(({ pose, extra }) => {
    const sim = window.sim;
    sim.pause(true);
    sim.reset({ seed: "cairo-42", speedLimit: 48, traffic: 0, pedestrians: 0, ...extra });
    const car = sim.world.player;
    Object.assign(car, pose, { previous: { ...pose } });
    const audit = sim.audit();
    if (audit.length) throw new Error(`Not a legal City starting pose: ${audit.join(", ")}`);
  }, { pose, extra });
  await ready();
}

async function measure() {
  await page.evaluate(() => {
    const { world } = window.sim, step = world.step;
    const start = { ...world.player }, originals = [...world.actors];
    const trace = window.__huntTrace = {
      start: { x: start.x, z: start.z, heading: start.heading }, rows: [], backedM: 0,
      forwardM: 0, turnRad: 0, maxSectors: 0, roads: [], reassignments: 0, sameCity: true,
    };
    window.__huntWorld = world;
    const roads = new Set();
    world.step = function () {
      const { x, z } = this.player, tick = this.tick;
      step.call(this);
      const p = this.pursuit, a = this.player;
      if (!p || tick === this.tick || trace.rows.length >= 400) return;
      const moved = Math.hypot(a.x - x, a.z - z);
      if (a.speed < -.05) trace.backedM += moved;
      if (trace.backedM >= 1.5 && a.speed > .05) trace.forwardM += moved;
      trace.turnRad = Math.max(trace.turnRad,
        Math.abs(Math.atan2(Math.sin(a.heading - start.heading), Math.cos(a.heading - start.heading))));
      trace.reassignments = p.metrics.patrolReassignments ?? 0;
      const angles = new Set();
      for (const unit of p.patrols) {
        const road = unit.pursuitDrive.approach?.roadId;
        if (road && unit.distance >= 2) roads.add(road);
        const dx = unit.x - a.x, dz = unit.z - a.z;
        if (unit.distance >= 2 && Math.hypot(dx, dz) <= 22)
          angles.add(Math.round(Math.atan2(dx, dz) / (Math.PI / 2)) & 3);
      }
      trace.maxSectors = Math.max(trace.maxSectors, angles.size);
      if (this.tick % 6 === 0 || p.wantedLevel !== trace.rows.at(-1)?.stars || p.phase !== trace.rows.at(-1)?.phase) {
        trace.roads = [...roads];
        trace.rows.push({ tick: this.tick, x: a.x, z: a.z, speed: a.speed, heading: a.heading,
          phase: p.phase, stars: p.wantedLevel, stage: p.response.stage, seen: p.response.unitsInContact,
          sides: angles.size, source: p.decision?.source, action: p.decision?.name });
      }
      trace.sameCity &&= originals.every(actor => this.actors.includes(actor));
    };
  });
}

const trail = () => page.evaluate(() => ({
  ...window.__huntTrace, sameCity: Boolean(window.__huntTrace.sameCity) && window.sim.world === window.__huntWorld,
  audit: window.sim.audit(),
}));

async function labCrossings() {
  await id("labBtn").click();
  await id("streetPursuitBtn").click();
  await ready();
  await id("packCase").selectOption("pack-crossing");
  await id("pursuitRunBtn").click();
  await wait(() => {
    const { metrics: m } = window.sim.world.pursuit;
    return m.firstClearTick > m.firstYieldTick && m.distanceM > 10;
  });
  const safe = await page.evaluate(() => window.sim.world.pursuit.metrics);
  assert.equal(safe.pedestrianCollisions, 0);
  assert.equal(safe.penalty, 0);
  await shot("01-lab-yield-and-resume");

  if (await id("pursuitRestartBtn").isVisible()) await id("pursuitRestartBtn").click();
  await id("packCase").selectOption("pack-person-impact");
  await id("pursuitLearn").check();
  await id("pursuitRunBtn").click();
  await wait(() => {
    const p = window.sim.world.pursuit;
    return p.metrics.terminalCause === "pedestrian-impact" && window.sim.world.tick - p.metrics.impact.tick >= 30;
  });
  const impact = await page.evaluate(() => {
    const { world, view } = window.sim, { metrics, learner } = world.pursuit;
    const body = view.roots.get(metrics.impact.actorId)?.root.userData.pedestrianImpactPose;
    return { closingMps: metrics.impact.closingSpeedMps, cost: metrics.pedestrianCost,
      reward: learner.snapshot().lastReward, tilt: body?.tiltRad };
  });
  assert.ok(impact.cost > 240 && impact.cost === -impact.reward && impact.tilt >= .65);
  await shot("02-lab-real-contact");
  await id("labBtn").click();
  await ready();
  return { safe, impact };
}

async function starterAndSave() {
  await measure();
  await startCity();
  await wait(() => window.sim.world.pursuit.learner.snapshot().changedDecisions > 0 &&
    window.sim.world.pursuit.metrics.distanceM >= 5);
  const initial = await page.evaluate(() => ({
    checkpoint: window.sim.world.pursuit.learner.checkpoint(), driver: window.sim.world.pursuit.driver,
  }));
  assert.equal(initial.driver, "starter");
  assert.equal(initial.checkpoint.updates, 0);
  assert.ok(Object.values(initial.checkpoint.q).some(row => row.some(value => value !== 0)));
  assert.ok((await trail()).sameCity);
  await wait(() => document.getElementById("pursuitLearning").textContent.includes("Starter policy"));
  await shot("09-city-starter");
  await id("pursuitRestartBtn").click();
  await prepareCity({ x: -254, z: -109.3, heading: Math.PI / 2, speed: 0 }, { traffic: 36, pedestrians: 80 });
  await startCity(true);
  await wait(() => window.sim.world.pursuit.learner.snapshot().updates >= 6);
  await id("pursuitRestartBtn").click();
  await wait(() => window.sim.world.pursuit.phase === "stopped");
  const trained = await page.evaluate(() => window.sim.world.pursuit.learner.checkpoint());
  assert.ok(trained.updates >= 6 && JSON.stringify(trained.q) !== JSON.stringify(initial.checkpoint.q));
  await page.reload();
  await ready();
  await startCity();
  const resumed = await page.evaluate(() => ({
    checkpoint: window.sim.world.pursuit.learner.checkpoint(), driver: window.sim.world.pursuit.driver,
  }));
  assert.equal(resumed.driver, "local-policy");
  assert.deepEqual(resumed.checkpoint, trained);
  await id("pursuitRestartBtn").click();
  return { initialUpdates: initial.checkpoint.updates, trainedUpdates: trained.updates, restored: true };
}

async function recovery() {
  await prepareCity({ x: -239, z: -116.2, heading: Math.PI, speed: 0 });
  await measure();
  await startCity();
  await wait(() => window.__huntTrace.backedM >= 1.5 && window.sim.world.player.speed < -.05);
  await shot("04-city-reverse-out");
  await wait(() => window.__huntTrace.forwardM >= 2 && window.__huntTrace.turnRad >= Math.PI / 6);
  const result = await trail();
  assert.ok(result.rows.some(row => row.source === "escape-search" && row.speed < -.5));
  assert.deepEqual(result.audit, []);
  await shot("05-city-clear-turn");
  return result;
}

async function patrolRouting() {
  await prepareCity({ x: -180.5, z: -114.5, heading: Math.PI, speed: 0 });
  await measure();
  await startCity();
  await wait(() => {
    const t = window.__huntTrace, p = window.sim.world.pursuit;
    return (t.reassignments > 0 && t.roads.length >= 2 && t.maxSectors >= 3) || p.phase !== "running";
  });
  const result = await trail();
  assert.ok(result.reassignments > 0 && result.roads.length >= 2 && result.maxSectors >= 3,
    JSON.stringify({ reassignments: result.reassignments, roads: result.roads, maxSectors: result.maxSectors }));
  assert.deepEqual(result.audit, []);
  await shot("06-city-directed-patrol-routes");
  return result;
}

async function cooldown() {
  await prepareCity({ x: -211, z: -109.3, heading: Math.PI / 2, speed: 13.33 });
  await measure();
  await openPanel();
  await id("pursuitRunBtn").evaluate(button => {
    // Controlled patrol layout, set once; the actual game advances every subsequent tick.
    button.click();
    const sim = window.sim, w = sim.world;
    sim.pause(true);
    const p = w.pursuit, patrol = [...p.patrols][0];
    for (const other of p.patrols) if (other !== patrol) {
      p.patrols.delete(other);
      w.actors.splice(w.actors.indexOf(other), 1);
    }
    Object.assign(patrol, { x: -268, z: -109.3, heading: Math.PI / 2, speed: 0, path: [], cursor: 0 });
    Object.assign(patrol.pursuitDrive, { nextPlan: 0, openingUntil: 0, launchUntil: 0 });
    if (sim.audit().length) throw new Error("Overlapping search fixture");
  });
  assert.equal(await page.evaluate(() => window.sim.world.mode), "auto");
  await page.evaluate(() => window.sim.pause(false));
  await wait(() => window.sim.world.pursuit.wantedLevel === 2);
  await wait(() => document.getElementById("pursuitWanted").getAttribute("aria-label") === "Wanted level 2 of 5");
  await shot("07-city-wanted-decreasing");
  await wait(() => window.sim.world.pursuit.phase === "escaped");
  const events = await page.evaluate(() => window.sim.world.pursuit.events.map(event => event.kind));
  const result = await trail(), starChanges = result.rows.filter((row, i, rows) => i === 0 || row.stars !== rows[i - 1].stars);
  assert.deepEqual(starChanges.map(row => row.stars), [3, 2, 1, 0]);
  assert.deepEqual(starChanges.slice(1).map(row => row.seen), [0, 0, 0]);
  assert.ok(events.includes("contact-lost") && !events.includes("reinforcement") && result.sameCity);
  assert.deepEqual(result.audit, []);
  await wait(() => document.getElementById("pursuitPhase").textContent === "Escaped");
  await shot("08-city-escaped");
  return { ...result, finalStars: starChanges.at(-1).stars, starChanges, events };
}

try {
  await page.goto(base);
  await ready();
  report.lab = await labCrossings();
  report.recovery = await recovery();
  report.patrol = await patrolRouting();
  report.cooldown = await cooldown();
  await prepareCity({ x: -254, z: -109.3, heading: Math.PI / 2, speed: 0 }, { traffic: 36, pedestrians: 80 });
  report.starter = await starterAndSave();
  assert.deepEqual(report.errors, []);
} catch (error) {
  report.failure = error.stack;
  await shot("failure");
  throw error;
} finally {
  await writeFile(join(output, "hunt-report.json"), JSON.stringify(report, null, 2));
  await browser.close();
}
