import assert from "node:assert/strict";
import { clickCityTool } from "./city-tool-button.mjs";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const { PROVE_IT_OUTPUT_DIR: output, THREEJS_URL: base } = process.env;
assert.ok(output && base, "Run this check through verify_unified_city.py");
const browser = await chromium.launch({ headless: false, args: ["--force-device-scale-factor=1"] });
const page = await browser.newPage({ viewport: { width: 1365, height: 900 }, deviceScaleFactor: 1 });
page.setDefaultTimeout(18_000);
const errors = new Set(), report = { passed: false };
page.on("pageerror", error => errors.add(error.stack ?? error.message));
page.on("console", message => { if (message.type() === "error") errors.add(message.text()); });
page.on("response", response => { if (response.status() >= 400) errors.add(`${response.status()}: ${response.url()}`); });
const shot = name => page.screenshot({ path: join(output, name) });
const hash = value => createHash("sha256").update(value).digest("hex");
const wait = (fn, value, timeout = 18_000) => page.waitForFunction(fn, value, { timeout });
const clockMeasure = () => page.evaluate(() => new Promise(resolve => {
  const sample = () => ({ wall: performance.now(), tick: window.sim.world.tick,
    frames: window.sim.renderDiagnostics().renderedFrames, distance: window.sim.world.metrics.distance });
  const first = sample();
  const measure = () => {
    const last = sample(), seconds = (last.wall - first.wall) / 1000;
    if (seconds < 3) return requestAnimationFrame(measure);
    resolve({ seconds, fps: (last.frames - first.frames) / seconds, ticksPerSecond: (last.tick - first.tick) / seconds,
      distanceM: last.distance - first.distance });
  };
  requestAnimationFrame(measure);
}));

try {
  await page.goto(base);
  await wait(() => window.sim?.view.actorDiagnostics().ready);
  await page.evaluate(() => {
    const sim = window.sim;
    window.__unifiedRun = { city: sim.world, scene: sim.view.scene, player: sim.world.player,
      ordinary: [...sim.world.actors], pursuitStartTick: null };
  });
  report.ready = await page.evaluate(() => {
    const { world, view } = window.sim;
    const movingModels = view.actorDiagnostics().trafficModels;
    return { environment: world.environment, version: world.config.cityVersion, capacity: world.capacity,
      architecture: view.egyptStreets.diagnostics.siteIds.length, trafficModels: [...new Set(movingModels)],
      goal: world.district.showcaseRoutes[0].goal.name };
  });
  assert.equal(report.ready.environment, "metro");
  assert.deepEqual(report.ready.capacity, report.ready.version === 4 ? { traffic: 36, pedestrians: 80 }
    : report.ready.version === 3 ? { traffic: 36, pedestrians: 48 } : { traffic: 28, pedestrians: 32 });
  assert.ok(report.ready.architecture >= 16 && report.ready.trafficModels.length >= 5);
  await clickCityTool(page, "settingsBtn");
  assert.equal(await page.locator("#environmentSelect").count(), 0);
  assert.equal(await page.locator("#policyPanel").isVisible(), false);
  if (await page.locator("#cityDriver").isVisible())
    await page.locator("#cityDriver").selectOption("sensors-only");
  await page.locator("#closeSettings").click();
  await shot("city-avenue.png");

  await page.locator("#phoneToggleBtn").click();
  await page.locator("#phonePlaces").getByRole("button", { name: report.ready.goal, exact: true }).click();
  report.tripStartTick = await page.evaluate(() =>
    window.sim.world.events.findLast(event => event.command.type === "destination")?.tick);
  await wait(() => window.sim.world.metrics.distance >= 8 && window.sim.world.mode === "auto");
  report.avenueTiming = await clockMeasure();
  assert.ok(report.avenueTiming.fps >= 25 && report.avenueTiming.ticksPerSecond >= 45 &&
    report.avenueTiming.distanceM > 3, JSON.stringify(report.avenueTiming));
  await page.locator("#phoneToggleBtn").click();

  // The authored west-alley route is fixed-step tested separately. The live
  // planner may take another neighborhood lane when traffic blocks that route.
  const neighborhood = await wait(() => {
    const { world } = window.sim, p = world.player;
    const road = world.drivingRoads.find(r => {
      if (r.zone !== "neighborhood" || r.width > 6.4 || r.supportApron || r.parkingBay) return false;
      const vertical = r.axis === "z";
      const [along, cross] = vertical ? [p.z, p.x] : [p.x, p.z];
      const alignment = Math.abs(vertical ? Math.cos(p.heading) : Math.sin(p.heading));
      const halfAcross = Math.sqrt(1 - alignment * alignment) * p.length / 2 + alignment * p.width / 2;
      return alignment >= .95 && along > r.min + 4 && along < r.max - 4 &&
        Math.abs(cross - r.fixed) + halfAcross + .12 < r.width / 2;
    });
    if (!road || p.speed < 1) return false;
    return { roadId: road.id, width: road.width, limitMps: road.speedLimitMps,
      x: p.x, z: p.z, speed: p.speed, distanceM: world.metrics.distance };
  }, null, 165_000);
  report.neighborhood = await neighborhood.jsonValue();
  await neighborhood.dispose();
  assert.ok(report.neighborhood.speed <= report.neighborhood.limitMps + 0.1);
  await shot("city-neighborhood.png");
  await wait(() => window.sim.world.metrics.completedTrips === 1, null, 100_000);
  report.journey = await page.evaluate(() => ({ tick: window.sim.world.tick,
    distanceM: window.sim.world.metrics.distance, audit: window.sim.world.audit() }));
  assert.ok(report.journey.distanceM >= 140);
  assert.deepEqual(report.journey.audit, []);
  await shot("city-arrived.png");

  await clickCityTool(page, "streetPursuitBtn");
  await page.locator("#pursuitLevel").selectOption("2");
  await page.locator("#pursuitRunBtn").click();
  await wait(() => window.sim.world.pursuit?.phase === "running");
  await wait(() => window.sim.world.actors.some(actor => actor.pursuitRole === "police" && actor.distance > 2));
  report.pursuit = await page.evaluate(() => {
    const { world, view } = window.sim, before = window.__unifiedRun;
    return { phase: world.pursuit.phase, tick: world.tick,
      sameWorld: world === before.city, sameScene: view.scene === before.scene,
      samePlayer: world.player === before.player, originals: before.ordinary.every(actor => world.actors.includes(actor)),
      police: world.actors.filter(actor => actor.pursuitRole === "police").map(actor => ({ id: actor.id, distance: actor.distance })),
      action: world.pursuit.decision?.name, audit: world.audit() };
  });
  assert.ok(report.pursuit.sameWorld && report.pursuit.sameScene && report.pursuit.samePlayer && report.pursuit.originals);
  assert.ok(report.pursuit.police.length > 1 && report.pursuit.action);
  assert.deepEqual(report.pursuit.audit, []);
  await shot("city-pursuit.png");
  await page.setViewportSize({ width: 900, height: 650 });
  await wait(() => window.sim.renderDiagnostics().width === 900);
  const panel = await page.locator("#pursuitPanel").boundingBox(), map = await page.locator("#minimap").boundingBox();
  assert.ok(panel && map && panel.y + panel.height <= map.y, "Street HUD does not cover the compact map");
  await shot("city-pursuit-compact.png");
  if (await page.locator("#pursuitRestartBtn").isEnabled()) await page.locator("#pursuitRestartBtn").click();
  await wait(() => window.sim.world.pursuit?.phase !== "running" &&
    window.sim.world.actors.every(actor => actor.pursuitRole !== "police"));
  const after = await page.evaluate(() => window.sim.world.tick);
  await wait(tick => window.sim.world.tick > tick + 12, after);
  report.afterPursuit = await page.evaluate(() => {
    const { world, view } = window.sim, before = window.__unifiedRun;
    return { tick: world.tick, phase: world.pursuit.phase,
      sameCity: world === before.city && before.scene === view.scene &&
        before.ordinary.every(actor => world.actors.includes(actor)) };
  });
  assert.ok(report.afterPursuit.sameCity);
  await clickCityTool(page, "streetPursuitBtn");

  await page.locator("#pauseBtn").click();
  assert.equal(await page.locator("#pauseBtn").textContent(), "Resume");
  const beforeReplay = await page.evaluate(() => JSON.stringify(window.sim.snapshot()));
  await clickCityTool(page, "settingsBtn");
  const download = page.waitForEvent("download");
  await page.locator("#replayBtn").click();
  const replayFile = join(output, "public-city-replay.json");
  await (await download).saveAs(replayFile);
  await page.locator("#replayFile").setInputFiles(replayFile);
  await wait(() => document.querySelector("#replayProgress")?.textContent ===
    "Replay restored from recorded commands.", null, 45_000);
  const afterReplay = await page.evaluate(() => JSON.stringify(window.sim.snapshot()));
  report.replay = { before: hash(beforeReplay), after: hash(afterReplay) };
  assert.equal(report.replay.before, report.replay.after);
  await page.locator("#closeSettings").click();

  await page.evaluate(() => {
    window.__postReplayCity = window.sim.world;
    window.__postReplayView = window.sim.view;
  });
  await clickCityTool(page, "labBtn");
  await wait(() => window.sim.world.environment === "lab");
  await clickCityTool(page, "settingsBtn");
  assert.equal(await page.locator("#policyPanel").isVisible(), true);
  assert.equal(await page.locator("#trainPolicyBtn").isVisible(), true);
  await page.locator("#closeSettings").click();
  await clickCityTool(page, "labBtn");
  report.labRoundTrip = await page.evaluate(() => window.sim.world === window.__postReplayCity &&
    window.sim.view === window.__postReplayView);
  assert.ok(report.labRoundTrip);

  await clickCityTool(page, "peopleToggleBtn");
  await page.locator("#peopleMotionMode").selectOption("stop");
  await wait(() => window.sim.world.actors.find(actor => actor.id === window.sim.people.selectedId)?.motionMode === "stop");
  await page.locator("#peopleMotionMode").selectOption("ambient");
  await page.locator("#peopleCloseBtn").click();
  report.peopleControls = true;

  await clickCityTool(page, "cameraScreenToggleBtn");
  await wait(() => Boolean(document.querySelector("#cameraRawCanvas")?.dataset.frameId));
  report.camera = { rawFrame: await page.locator("#cameraRawCanvas").getAttribute("data-frame-id"),
    observedAnalysis: false };
  if (process.env.METRO_VERIFY_CAMERA === "1") {
    await page.locator("#pauseBtn").click();
    await page.locator("#cameraPerceptionStartBtn").click();
    await wait(() => {
      const { world, vision } = window.sim;
      const raw = document.querySelector("#cameraRawCanvas");
      const analysis = document.querySelector("#cameraAnalysisCanvas");
      return world.visualMode === "vision-first" && vision.status.status === "ready" &&
        world.visualState?.available && analysis?.dataset.frameId &&
        raw?.dataset.frameId === analysis.dataset.frameId && raw?.dataset.streamId === analysis.dataset.streamId;
    }, null, 30_000);
    report.camera.observedAnalysis = true;
    await shot("city-camera.png");
    await page.locator("#cameraPerceptionStopBtn").click();
    await wait(() => window.sim.world.visualMode === "sensors-only");
  }
  await page.locator("#cameraScreenCloseBtn").click();
  assert.deepEqual([...errors], []);
  report.passed = true;
} catch (error) {
  report.failure = error.stack;
  report.finalPose = await page.evaluate(() => {
    const world = window.sim?.world;
    if (!world) return null;
    const { x, z, speed, reason, blockedBy, wait } = world.player;
    return { tick: world.tick, distanceM: world.metrics.distance, x, z, speed, reason, blockedBy, wait };
  });
  await shot("city-failure.png");
  throw error;
} finally {
  report.errors = [...errors];
  await writeFile(join(output, "unified-browser.json"), JSON.stringify(report, null, 2));
  await browser.close();
}
