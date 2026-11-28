import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || "playwright");
const output = process.env.PROVE_IT_OUTPUT_DIR;
assert.ok(output, "Set PROVE_IT_OUTPUT_DIR for the browser evidence.");
const base = process.env.THREEJS_URL || "http://127.0.0.1:8000";
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 700 }, deviceScaleFactor: 0.75 });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(base);
  await page.waitForFunction(() => window.sim?.defaultChaseReady, null, { timeout: 90_000 });
  await page.evaluate(() => {
    const sim = window.sim;
    sim.pause(true);
    const scene = sim.view.scene;
    const before = scene.onBeforeRender;
    window.forecastProbe = { visiblePasses: 0, visibleMeshes: 0 };
    scene.onBeforeRender = function (...args) {
      before.apply(this, args);
      if (!scene.getObjectByName("pedestrian-forecast")?.visible) return;
      window.forecastProbe.visiblePasses++;
      window.forecastProbe.visibleMeshes = sim.forecastDiagnostics().visibleMeshes;
    };
  });
  const sample = () => page.evaluate(() => ({
    ...window.forecastProbe, panelHidden: document.querySelector("#driveSense").hidden,
  }));
  const reset = () => page.evaluate(() => {
    window.forecastProbe.visiblePasses = window.forecastProbe.visibleMeshes = 0;
  });
  const advance = () => page.evaluate(() => {
    window.sim.pause(true);
    window.sim.step(24);
  });
  const frames = () => page.evaluate(() =>
    new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const expectOverlay = () => page.waitForFunction(() => window.forecastProbe.visibleMeshes > 0, null,
    { timeout: 10_000 });

  await page.locator("#pakoBtn").click();
  await page.locator("#pakoDriverManual").click();
  await page.locator("#pursuitRunBtn").click();
  await page.locator("#spawnCrowdAheadBtn").click();
  await advance();
  assert.equal(await page.evaluate(() => window.sim.nitroStatus().lastCrowdSpawn?.spawned), 20);
  await expectOverlay();
  const chase = await sample();
  assert.equal(chase.panelHidden, true, "Chase must not auto-open Car's view");
  await page.screenshot({ path: join(output, "chase-forecasts.png"), scale: "css" });

  await page.locator("#stopChaseBtn").click();
  await advance();
  await reset();
  await frames();
  const city = await sample();
  assert.equal(city.visiblePasses, 0, "ordinary City driving remains opt-in");

  await page.locator("#driveSenseBtn").click();
  await advance();
  await expectOverlay();
  const optIn = await sample();
  assert.equal(optIn.panelHidden, false);
  assert.deepEqual(errors, []);
  await writeFile(join(output, "forecast-result.json"), JSON.stringify({ chase, city, optIn, errors }, null, 2));
} finally {
  await browser.close();
}
