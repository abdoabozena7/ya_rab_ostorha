import assert from "node:assert/strict";
import { clickCityTool } from "./city-tool-button.mjs";
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { passesCityDensity } from "./city-density-metrics.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const { PROVE_IT_OUTPUT_DIR: output, THREEJS_URL: base } = process.env;
assert.ok(output && base, "Run this check through verify_city_density.py");
const baseline = process.env.CITY_DENSITY_BASELINE === "1";
assert.ok(!baseline || !process.env.PROVE_IT_RUN_ID, "The sealed check cannot run in baseline mode");
const browser = await chromium.launch({ headless: false, args: ["--force-device-scale-factor=1"] });
const page = await browser.newPage({ viewport: { width: 1365, height: 900 }, deviceScaleFactor: 1 });
page.setDefaultTimeout(25_000);
const errors = [], report = { passed: false, baseline };
page.on("pageerror", error => errors.push(error.message));
page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
page.on("response", response => { if (response.status() >= 400) errors.push(`${response.status()}: ${response.url()}`); });
const shot = name => page.screenshot({ path: join(output, name) });
const measure = seconds => page.evaluate(seconds => new Promise(resolve => {
  const { world, view } = window.sim;
  const intervals = [], steps = [], sync = [], prepare = [];
  const time = (object, key, samples) => {
    const own = Object.hasOwn(object, key), old = object[key];
    object[key] = function (...args) {
      const start = performance.now();
      try { return old.apply(this, args); }
      finally { samples.push(performance.now() - start); }
    };
    return () => { if (own) object[key] = old; else delete object[key]; };
  };
  const restore = [time(world, "step", steps), time(view, "sync", sync), time(view, "prepareFrame", prepare)];
  const first = { now: performance.now(), tick: world.tick, distance: world.metrics.distance,
    rendered: window.sim.renderDiagnostics().renderedFrames,
    crowdDistance: world.actors.reduce((total, actor) => total + actor.distance, 0) - world.player.distance };
  let previous = first.now, fastest = 0;
  const snapshot = () => ({
    frames: window.sim.renderDiagnostics().renderedFrames,
    tick: world.tick, distance: world.metrics.distance, phase: world.pursuit?.phase ?? null,
    population: world.actors.filter(a => a.type === "pedestrian").length,
    crowdDistance: world.actors.reduce((total, actor) => total + actor.distance, 0) - world.player.distance,
  });
  const summarize = (samples) => {
    const sorted = samples.slice().sort((a, b) => a - b);
    const p = frac => sorted[Math.min(sorted.length - 1, Math.ceil(frac * sorted.length) - 1)] ?? null;
    return { count: sorted.length, p50: p(.5), p95: p(.95), p99: p(.99), max: sorted.at(-1),
      over100: sorted.filter(ms => ms >= 100).length };
  };
  function sample() {
    const now = performance.now();
    intervals.push(now - previous);
    previous = now;
    fastest = Math.max(fastest, Math.abs(world.player.speed));
    if (now - first.now < seconds * 1000) return requestAnimationFrame(sample);
    restore.forEach(cleanup => cleanup());
    const ending = snapshot(), wallS = (now - first.now) / 1000, render = window.sim.renderDiagnostics();
    resolve({ wallS, first, ending, actualM: ending.distance - first.distance, peakMps: fastest,
      movedTrafficM: ending.crowdDistance - first.crowdDistance,
      fps: (ending.frames - first.rendered) / wallS, ticksPerSecond: (ending.tick - first.tick) / wallS,
      frameMs: summarize(intervals), stepMs: summarize(steps), syncMs: summarize(sync),
      prepareMs: summarize(prepare), render });
  }
  requestAnimationFrame(sample);
}), seconds);
try {
  await page.goto(base);
  await page.waitForFunction(() => window.sim?.vehicleRig);
  const cdp = await browser.newBrowserCDPSession();
  report.gpu = await page.evaluate(() => {
    const canvas = document.querySelector("canvas.scene");
    const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    return { vendor: ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : null,
      device: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null,
      viewport: [innerWidth, innerHeight], dpr: devicePixelRatio };
  });
  const { gpu } = await cdp.send("SystemInfo.getInfo");
  report.gpu.browserHardware = gpu.featureStatus?.webgl;
  await cdp.detach();
  const version = await page.evaluate(() => window.sim.world.config.cityVersion);
  const capacity = version === 4 ? { traffic: 96, pedestrians: 144 }
    : version === 3 ? { traffic: 96, pedestrians: 120 } : { traffic: 72, pedestrians: 96 };
  await clickCityTool(page, "settingsBtn");
  if (await page.locator("#cityDriver").isVisible())
    await page.locator("#cityDriver").selectOption("sensors-only");
  await page.locator('[name="speedLimit"]').fill("50");
  await page.locator('[name="difficulty"]').fill("5");
  await page.locator('[name="scenarioInterval"]').fill("2");
  await page.evaluate(() => {
    const button = document.querySelector("#stressBtn");
    button.addEventListener("click", () => {
      const start = performance.now();
      requestAnimationFrame(() => { window.__densityReadyMs = performance.now() - start; });
    }, { once: true, capture: true });
  });
  await page.locator("#stressBtn").click({ timeout: 45_000 });
  await page.waitForFunction(({ traffic, pedestrians }) => window.sim.world.capacity.traffic === traffic &&
    window.sim.world.capacity.pedestrians === pedestrians && Number.isFinite(window.__densityReadyMs), capacity);
  report.configuration = await page.evaluate(() => ({ ...window.sim.world.config,
    capacity: window.sim.world.capacity, resetMs: window.__densityReadyMs }));
  assert.equal(report.configuration.speedLimit, 50);
  assert.equal(report.configuration.chaos, 1);
  assert.equal(report.configuration.scenarioInterval, 2);
  assert.equal(report.configuration.difficulty, 5);
  await page.locator("#closeSettings").click();
  await page.locator("#phoneToggleBtn").click();
  await page.locator("#phonePlaces").getByRole("button", { name: "الفرن البلدي", exact: true }).click();
  await page.locator("#phoneToggleBtn").click();
  await page.waitForFunction(() => window.sim.world.mode === "auto" &&
    window.sim.world.metrics.distance > 8, null, { timeout: 42_000 });
  report.driving = await measure(8);
  await shot("dense-avenue.png");
  report.live = await page.evaluate(() => ({
    audit: window.sim.world.audit(), encounters: window.sim.world.cityEncounters?.events ?? [],
    scenery: window.sim.view.egyptStreets.diagnostics,
  }));
  await clickCityTool(page, "streetPursuitBtn");
  await page.locator("#pursuitStyle").selectOption("hunt");
  await page.locator("#pursuitLevel").selectOption("4");
  await page.locator("#pursuitRunBtn").click();
  await page.waitForFunction(() => window.sim.world.pursuit?.phase === "running");
  report.pursuit = await measure(5);
  report.pursuitAudit = await page.evaluate(() => window.sim.world.audit());
  await shot("dense-pursuit.png");
  assert.deepEqual(errors, []);
  assert.deepEqual(report.live.audit, []);
  assert.deepEqual(report.pursuitAudit, []);
  assert.deepEqual(report.gpu.viewport, [1365, 900]);
  assert.equal(report.gpu.dpr, 1);
  report.checks = { normal: passesCityDensity(report.driving, capacity.pedestrians),
    pursuit: passesCityDensity(report.pursuit, capacity.pedestrians) && report.pursuit.movedTrafficM > 25,
    actualSpeed: report.driving.peakMps >= 8,
    encounters: report.live.encounters.some(event => event.phase === "applied"),
    streamed: Number.isFinite(report.live.scenery.residentCells) &&
      report.live.scenery.residentCells < report.live.scenery.totalCells };
  report.passed = Object.values(report.checks).every(Boolean);
  if (!baseline) assert.equal(report.passed, true, JSON.stringify(report.checks));
} catch (error) {
  report.failure = error.stack;
  await shot("dense-failure.png");
  throw error;
} finally {
  report.errors = errors;
  await writeFile(join(output, "city-density.json"), JSON.stringify(report, null, 2));
  await browser.close();
}
