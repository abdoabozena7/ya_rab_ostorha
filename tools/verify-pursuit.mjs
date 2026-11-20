import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const output = process.env.PROVE_IT_OUTPUT_DIR;
const base = process.env.THREEJS_URL;
assert.ok(output && base, "Run through verify_pursuit.py");
const browser = await chromium.launch({ headless: false, args: ["--force-device-scale-factor=1"] });
const page = await browser.newPage({ viewport: { width: 1365, height: 900 }, deviceScaleFactor: 1 });
page.setDefaultTimeout(18_000);
const errors = new Set(), report = { passed: false, scope: "legacy arena fixture" };
page.on("pageerror", error => errors.add(error.stack ?? error.message));
page.on("console", message => { if (message.type() === "error") errors.add(message.text()); });
page.on("requestfailed", request => errors.add(`${request.failure()?.errorText}: ${request.url()}`));
page.on("response", response => { if (response.status() >= 400) errors.add(`${response.status()}: ${response.url()}`); });
const shot = (name) => page.screenshot({ path: join(output, name) });
const digest = value => createHash("sha256").update(value).digest("hex");
const waitForNextDraws = () => page.evaluate(() => new Promise(resolve =>
  requestAnimationFrame(() => requestAnimationFrame(resolve))));
try {
  await page.goto(base);
  await page.waitForFunction(() => window.sim?.vehicleRig);
  await page.evaluate(() => { window.__priorPursuitCity = window.sim.world; });
  await page.evaluate(() => window.sim.activate("pursuit"));
  await page.waitForFunction(() => window.sim.world.environment === "pursuit");
  await page.waitForFunction(() => window.sim.view.status.loaded >= window.sim.world.actors.length);
  await shot("pursuit-ready.png");
  assert.equal(await page.locator("#pursuitPanel").count(), 1);
  assert.equal(await page.locator("#pursuitPanel").isVisible(), true);
  await page.locator("#pursuitRunBtn").click();
  await page.waitForFunction(() => window.sim.world.tick >= 12);
  report.responsiveness = await page.evaluate(() => new Promise(resolve => {
    const read = () => {
      const { world } = window.sim;
      return { t: performance.now(), tick: world.tick, phase: world.pursuit.phase,
        distanceM: world.metrics.distance, ...window.sim.renderDiagnostics() };
    };
    const first = read();
    const sample = () => {
      const last = read();
      if (last.t - first.t < 3_000 && last.phase === "running") return requestAnimationFrame(sample);
      const wallS = (last.t - first.t) / 1000;
      resolve({ first, last, wallS, renderedFps: (last.renderedFrames - first.renderedFrames) / wallS,
        simulatedSecondsPerWallSecond: (last.tick - first.tick) / 60 / wallS });
    };
    requestAnimationFrame(sample);
  }));
  assert.equal(report.responsiveness.first.phase, "running");
  assert.equal(report.responsiveness.last.phase, "running");
  assert.ok(report.responsiveness.renderedFps >= 20, "Active pursuit must render at least 20 fps");
  assert.ok(report.responsiveness.simulatedSecondsPerWallSecond >= .8,
    "Rendered activity must advance the actual game clock");
  await page.waitForFunction(() => window.sim.world.tick >= 180);
  await shot("pursuit-running.png");
  report.run = await page.evaluate(() => {
    const world = window.sim.world;
    return { tick: world.tick, phase: world.pursuit.phase, distance: world.metrics.distance,
      source: world.pursuit.decision?.source, roles: world.actors.filter(a => a.pursuitRole === "police")
        .map(a => ({ id: a.id, tactic: a.policeTactic, distance: a.distance })),
      level: world.pursuit.level, audit: world.audit(),
      modelLoaded: Boolean(world.pursuit.policy), renderedFrames: window.sim.renderDiagnostics().renderedFrames };
  });
  assert.ok(report.run.distance > 1, JSON.stringify(report.run));
  assert.ok(report.run.modelLoaded, "The browser must consume the generated local checkpoint");
  assert.ok(report.run.roles.some(actor => actor.distance > 1));
  assert.deepEqual(report.run.audit, []);
  assert.notEqual(await page.locator("#pursuitAction").textContent(), "");
  assert.match(await page.locator("#cameraDecision").textContent(), /^Virtual ranging:/);
  report.streets = await page.evaluate(() => {
    const { world, view } = window.sim;
    return Object.fromEntries(["building", "wall", "parked-vehicle"].map(kind => [kind,
      world.statics.filter(actor => actor.kind === kind && view.scene.getObjectByName(actor.id)).length]));
  });
  assert.ok(Object.values(report.streets).every(count => count > 0),
    "Physical buildings, walls and parked cars must also be present in the rendered scene");
  const manualAt = await page.evaluate(() => window.sim.world.tick);
  await page.keyboard.down("Space");
  try {
    await page.waitForFunction(tick => window.sim.world.mode === "manual" &&
      window.sim.world.tick > tick && window.sim.world.pursuit.action?.brake === 1, manualAt);
    report.manual = await page.evaluate(() => ({
      tick: window.sim.world.tick, mode: window.sim.world.mode, action: window.sim.world.pursuit.action,
    }));
  } finally { await page.keyboard.up("Space"); }
  await page.keyboard.press("i");
  await page.waitForFunction(() => window.sim.world.mode === "auto" && Boolean(window.sim.world.pursuit.decision));
  await page.locator("#pauseBtn").click();
  const pausedTick = await page.evaluate(() => window.sim.world.tick);
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => window.sim.world.tick), pausedTick);
  assert.equal(await page.locator("#pursuitPhase").textContent(), "Paused");

  const expected = await page.evaluate(() => JSON.stringify(window.sim.snapshot()));
  await page.locator("#settingsBtn").click();
  const exported = page.waitForEvent("download");
  await page.locator("#replayBtn").click();
  const replay = await exported;
  const replayFile = join(output, "public-pursuit-replay.json");
  await replay.saveAs(replayFile);
  await page.locator("#replayFile").setInputFiles(replayFile);
  await page.waitForFunction(() => document.querySelector("#replayProgress")?.textContent ===
    "Replay restored from recorded commands.");
  const restored = await page.evaluate(() => JSON.stringify(window.sim.snapshot()));
  report.replay = { tick: pausedTick, expected: digest(expected), restored: digest(restored) };
  assert.equal(report.replay.restored, report.replay.expected);
  await page.locator("#closeSettings").click();

  await page.setViewportSize({ width: 900, height: 650 });
  await waitForNextDraws();
  await shot("pursuit-compact.png");
  const bounds = await page.locator("#pursuitRestartBtn").boundingBox();
  assert.ok(bounds && bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= 900 &&
    bounds.y + bounds.height <= 650, "Restart remains reachable in the compact layout");
  const panel = await page.locator("#pursuitPanel").boundingBox();
  const minimap = await page.locator("#minimap").boundingBox();
  assert.ok(panel && minimap && panel.y + panel.height <= minimap.y, "Compact HUD must not cover the minimap");
  await page.locator("#pursuitRestartBtn").click();
  await page.waitForFunction(() => window.sim.world.tick === 0 && window.sim.world.pursuit.phase === "ready");
  await page.locator("#pursuitLevel").selectOption("4");
  await page.waitForFunction(() => window.sim.world.pursuit.level === 4);
  report.higherLevelPolice = await page.evaluate(() => window.sim.world.actors.filter(a => a.pursuitRole === "police").length);
  assert.ok(report.higherLevelPolice > report.run.roles.length);
  await page.locator("#pursuitRunBtn").click();
  await page.waitForFunction(() => ["escaped", "captured", "crashed", "timeout"].includes(window.sim.world.pursuit.phase),
    null, { timeout: 63_000 });
  const finished = await page.evaluate(() => window.sim.world.pursuit.phase);
  const finishLabel = finished === "timeout" ? "time expired" : finished;
  const labelStart = performance.now();
  await page.waitForFunction(label => document.querySelector("#pursuitPhase")?.textContent?.toLowerCase() === label,
    finishLabel, { timeout: 500 });
  report.terminalFeedbackWaitMs = performance.now() - labelStart;
  report.terminal = await page.evaluate(() => {
    const { world } = window.sim;
    return { phase: world.pursuit.phase, tick: world.tick, metrics: world.pursuit.metrics,
      visible: document.querySelector("#pursuitPhase")?.textContent, audit: world.audit() };
  });
  assert.equal(report.terminal.visible.toLowerCase(), finishLabel);
  assert.deepEqual(report.terminal.audit, []);
  await shot("pursuit-terminal.png");
  await page.locator("#labBtn").click();
  report.savedCity = await page.evaluate(() => window.sim.world === window.__priorPursuitCity);
  assert.equal(report.savedCity, true);
  await shot("pursuit-return-city.png");
  assert.deepEqual([...errors], []);
  report.passed = true;
} catch (error) {
  report.failure = error.stack;
  await shot("pursuit-failed.png");
  throw error;
} finally {
  report.errors = [...errors];
  await writeFile(join(output, "pursuit-public.json"), JSON.stringify(report, null, 2));
  await browser.close();
}
